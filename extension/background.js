"use strict";

/*
 * miss-me
 *
 * A locked window doesn't keep tabs that appear on their own, such as links
 * clicked in other apps. Those are moved to the most recently focused
 * unlocked window, and the locked window keeps showing the tab it had.
 *
 * Tabs you open from inside the locked window stay where they are: links
 * opened from a page in it (they have an opener), new tab pages (Ctrl+T),
 * and anything pinned.
 *
 * The lock is stored per window with the sessions API, so it is restored
 * along with the window after a browser restart.
 */

const LOCK_KEY = "locked";

const ICONS = {
  locked: "icons/on.svg",
  unlocked: "icons/off.svg",
};

const TITLES = {
  locked: "Stop dodging new tabs in this window",
  unlocked: "Dodge new tabs in this window (links from other apps open elsewhere)",
};

// Tabs opened on these pages were opened on purpose from inside the window.
const NEW_TAB_URLS = new Set(["about:newtab", "about:home", "about:privatebrowsing"]);

// For a short while after a window appears (including at startup), session
// restore may still be adding its tabs. Leave those alone.
const SETTLE_MS = 5000;

const HISTORY_LIMIT = 20;

const startedAt = Date.now();

// windowId -> when the window was created (windows that existed at startup
// have no entry and use startedAt).
const windowCreatedAt = new Map();

// Window IDs, most recently focused first.
let focusOrder = [];

// windowId -> recently active tab IDs, most recent first.
const activeHistory = new Map();

// Tabs that are still being handled by onCreated.
const inFlight = new Set();

async function isLocked(windowId) {
  try {
    return (await browser.sessions.getWindowValue(windowId, LOCK_KEY)) === true;
  } catch {
    return false; // The window is gone.
  }
}

async function setLocked(windowId, locked) {
  if (locked) {
    await browser.sessions.setWindowValue(windowId, LOCK_KEY, true);
  } else {
    await browser.sessions.removeWindowValue(windowId, LOCK_KEY);
  }
  showState(windowId, locked);
}

function showState(windowId, locked) {
  const state = locked ? "locked" : "unlocked";
  const ignoreClosed = () => {};
  browser.browserAction.setIcon({ windowId, path: ICONS[state] }).catch(ignoreClosed);
  browser.browserAction.setTitle({ windowId, title: TITLES[state] }).catch(ignoreClosed);
}

async function refresh(windowId) {
  showState(windowId, await isLocked(windowId));
}

function isSettling(windowId) {
  const createdAt = windowCreatedAt.get(windowId) ?? startedAt;
  return Date.now() - createdAt < SETTLE_MS;
}

function isDeliberate(tab) {
  return tab.openerTabId !== undefined || tab.pinned || NEW_TAB_URLS.has(tab.url);
}

// The unlocked window a tab should go to, or undefined if there is none.
async function pickTarget(tab) {
  const windows = await browser.windows.getAll({ windowTypes: ["normal"] });
  const sameKind = windows.filter((w) => w.id !== tab.windowId && w.incognito === tab.incognito);
  const lockStates = await Promise.all(sameKind.map((w) => isLocked(w.id)));
  const candidates = sameKind.filter((_, i) => !lockStates[i]).map((w) => w.id);
  return focusOrder.find((id) => candidates.includes(id)) ?? candidates[0];
}

// Switch a window back to the tab it showed most recently, skipping tabs
// that are about to be moved out of it.
async function restoreActive(windowId) {
  const tabs = await browser.tabs.query({ windowId });
  const present = new Set(tabs.map((t) => t.id));
  const history = activeHistory.get(windowId) ?? [];
  const previous = history.find((id) => present.has(id) && !inFlight.has(id));
  if (previous !== undefined) {
    await browser.tabs.update(previous, { active: true });
  }
}

async function evict(tab) {
  // Switch back first, so the window doesn't briefly show some other tab
  // once the new one is gone.
  await restoreActive(tab.windowId);

  const target = await pickTarget(tab);
  if (target === undefined) {
    await browser.windows.create({ tabId: tab.id });
    return;
  }
  await browser.tabs.move(tab.id, { windowId: target, index: -1 });
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(target, { focused: true });
}

browser.browserAction.onClicked.addListener(async (tab) => {
  await setLocked(tab.windowId, !(await isLocked(tab.windowId)));
});

browser.tabs.onCreated.addListener(async (tab) => {
  inFlight.add(tab.id);
  try {
    if (isDeliberate(tab) || isSettling(tab.windowId) || !(await isLocked(tab.windowId))) {
      return;
    }
    await evict(tab);
  } catch (err) {
    console.error("miss-me: couldn't move tab out of locked window", err);
  } finally {
    inFlight.delete(tab.id);
  }
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const history = (activeHistory.get(windowId) ?? []).filter((id) => id !== tabId);
  history.unshift(tabId);
  activeHistory.set(windowId, history.slice(0, HISTORY_LIMIT));
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) {
    return;
  }
  focusOrder = [windowId, ...focusOrder.filter((id) => id !== windowId)];
  // Session restore may set the lock after the window was created, so the
  // icon is re-synced whenever a window is focused.
  refresh(windowId);
});

browser.windows.onCreated.addListener((win) => {
  windowCreatedAt.set(win.id, Date.now());
  refresh(win.id);
});

browser.windows.onRemoved.addListener((windowId) => {
  windowCreatedAt.delete(windowId);
  activeHistory.delete(windowId);
  focusOrder = focusOrder.filter((id) => id !== windowId);
});

async function init() {
  const windows = await browser.windows.getAll({ populate: true });
  for (const win of windows) {
    const active = win.tabs.find((t) => t.active);
    if (active && !activeHistory.has(win.id)) {
      activeHistory.set(win.id, [active.id]);
    }
    if (!focusOrder.includes(win.id)) {
      if (win.focused) {
        focusOrder.unshift(win.id);
      } else {
        focusOrder.push(win.id);
      }
    }
    refresh(win.id);
  }
}

init();
