/**
 * Dials the code-terminal server and executes whatever it asks.
 *
 * MV3 service workers are evicted after ~30s idle. Since Chrome 116, WebSocket
 * traffic resets that timer, so a ping every 20s is what keeps this alive.
 */
// No default server: it is yours to set in the popup (ws://host:8123/ext).
const DEFAULT_URL = "";

// Clicking the toolbar icon opens the Claude side panel. Settings moved to the
// options page (right-click the icon -> Options), since the icon is taken.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/* ---------------- right-click → ask Claude ---------------- */

const MENU = {
  selection: "ct-ask-selection",
  page: "ct-ask-page",
  link: "ct-ask-link",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.selection, title: 'Ask Claude about "%s"', contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU.page, title: "Ask Claude about this page", contexts: ["page"] });
    chrome.contextMenus.create({ id: MENU.link, title: "Ask Claude about this link", contexts: ["link"] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const prompt =
    info.menuItemId === MENU.selection
      ? `About this selection from ${tab?.url ?? "the current page"}:\n\n"""\n${(info.selectionText ?? "").slice(0, 4000)}\n"""\n\nWhat should I know about it?`
      : info.menuItemId === MENU.link
        ? `What is at this link: ${info.linkUrl}? Read it if useful.`
        : `Tell me about the page I am on. Read it if useful.`;

  // The panel may not be running yet, so hand off through storage and let it
  // pick the prompt up on load; a panel that IS open sees the storage change.
  await chrome.storage.session.set({ pendingPrompt: { text: prompt, at: Date.now() } });

  // Must happen in the click handler: opening a side panel needs a gesture.
  try {
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
    else if (tab?.id != null) await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    console.warn("could not open side panel:", e?.message ?? e);
  }
});
const PING_MS = 20_000;
// The server beats every 30s (and answers our pings). Silence longer than this
// means the socket is half-open — the browser still calls it open, but after
// a network drop nothing will ever arrive on it. Measured: 1h42m on a dead
// socket until the extension was reloaded by hand.
const STALE_MS = 75_000;
let wsSeen = 0, obsSeen = 0;
const RECONNECT_MS = 3_000;
// Another browser's extension took the bridge. Retry rarely, so the two do not
// kick each other in a loop; whichever the user actually uses will win when the
// other's browser closes.
const DISPLACED_MS = 60_000;

let ws = null;
let pingTimer = null;
let enabled = true;
let serverUrl = DEFAULT_URL;

/**
 * A stable id for this browser profile, so the server can tell two browsers
 * apart and send a conversation's browser commands to the right one. Generated
 * once and kept: chrome.runtime.id is not enough, since the same unpacked
 * extension in two profiles shares it.
 */
let instanceId = null;
async function getInstanceId() {
  if (instanceId) return instanceId;
  const s = await chrome.storage.local.get("instanceId");
  instanceId = s.instanceId ?? crypto.randomUUID();
  if (!s.instanceId) await chrome.storage.local.set({ instanceId });
  return instanceId;
}

chrome.storage.local.get({ enabled: true, serverUrl: DEFAULT_URL }).then((s) => {
  enabled = s.enabled;
  serverUrl = s.serverUrl || DEFAULT_URL;
  if (enabled) { connect(); observeAgent(); }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.serverUrl) serverUrl = changes.serverUrl.newValue || DEFAULT_URL;
  if (changes.enabled) {
    enabled = changes.enabled.newValue;
    if (enabled) { connect(); observeAgent(); }
    else {
      ws?.close(1000, "disabled"); ws = null;
      obs?.close(1000, "disabled"); obs = null; clearTimeout(obsTimer);
      setBadge(false);
    }
  } else if (changes.serverUrl && enabled) {
    // A live socket is closed and its onclose reconnects to the new address.
    // With no socket yet (the address was just set for the first time) there
    // is nothing to close, so connect directly.
    if (ws && ws.readyState <= 1) { ws.close(1000, "server changed"); obs?.close(1000, "server changed"); }
    else { connect(); observeAgent(); }
  }
});

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "on" : "" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#7dcfa0" : "#f07178" });
}

function connect() {
  if (!enabled || (ws && ws.readyState <= 1)) return;
  if (!serverUrl) { setBadge(false); chrome.action.setBadgeText({ text: "set" }); return; }   // not configured yet
  try { ws = new WebSocket(serverUrl); } catch { return retry(); }

  ws.onopen = async () => {
    wsSeen = Date.now();
    setBadge(true);
    // Identify this browser before anything else, so no command can be routed
    // here while the server still has us under a placeholder.
    ws.send(JSON.stringify({ type: "hello", instance: await getInstanceId() }));
    clearInterval(pingTimer);
    // Traffic on the socket is what keeps this service worker from eviction.
    pingTimer = setInterval(() => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
    }, PING_MS);
  };

  ws.onmessage = async (ev) => {
    wsSeen = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    if (msg.type === "pong") return;
    if (!msg.id) return;
    try {
      const result = await handle(msg.action, msg.params ?? {});
      reply({ id: msg.id, ok: true, result });
    } catch (e) {
      reply({ id: msg.id, ok: false, error: String(e?.message ?? e) });
    }
  };

  ws.onclose = (ev) => {
    setBadge(false);
    clearInterval(pingTimer);
    ws = null;
    retry(ev?.code === 4001 ? DISPLACED_MS : RECONNECT_MS);
  };
  ws.onerror = () => { try { ws?.close(); } catch {} };
}

function reply(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }
function retry(delay = RECONNECT_MS) { if (enabled) setTimeout(connect, delay); }

/** Drop a socket that has gone silent and dial again. Returns true if it did. */
function dropIfStale(now = Date.now()) {
  let dropped = false;
  if (ws && ws.readyState <= 1 && wsSeen && now - wsSeen > STALE_MS) {
    const dead = ws; ws = null; dead.onclose = null; dead.onmessage = null;
    try { dead.close(); } catch {}
    clearInterval(pingTimer); setBadge(false); dropped = true;
  }
  if (obs && obs.readyState <= 1 && obsSeen && now - obsSeen > STALE_MS) {
    const dead = obs; obs = null; dead.onclose = null; dead.onmessage = null;
    try { dead.close(); } catch {}
    dropped = true;
  }
  if (dropped && enabled) { connect(); observeAgent(); }
  return dropped;
}
setInterval(() => dropIfStale(), 15_000);

// A backstop in case the socket dies while the worker is asleep — the alarm
// survives eviction, the interval above does not.
chrome.alarms?.create("reconnect", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(() => {
  if (!enabled) return;
  dropIfStale();
  if (!ws) connect();
  if (!obs) observeAgent();
});

/* ---------------- notifications ---------------- */

/**
 * A second, read-only connection to the agent socket. The side panel already
 * has one, but it dies when the panel closes — which is exactly when a
 * notification is worth having. ?observe=1 skips the transcript replay.
 */
let obs = null, obsTimer = null, turnStartedAt = 0, lastState = "idle";
const LONG_TURN_MS = 20_000;

function observeAgent() {
  if (!enabled || !serverUrl || (obs && obs.readyState <= 1)) return;
  const url = serverUrl.replace(/\/ext\/?$/, "/ws") + "?observe=1";
  try { obs = new WebSocket(url); } catch { return; }
  obs.onopen = () => { obsSeen = Date.now(); };

  obs.onmessage = (ev) => {
    obsSeen = Date.now();
    let m; try { m = JSON.parse(ev.data); } catch { return; }

    if (m.kind === "status") {
      // "waiting for you" is the one that must not go unnoticed.
      if (m.state === "awaiting" && lastState !== "awaiting") {
        notify("Claude needs you", m.detail === "a question" ? "A question is waiting" : `Approve ${m.detail}?`);
      }
      if (lastState === "idle" && m.state !== "idle") turnStartedAt = Date.now();
      lastState = m.state;
    }

    // A watch firing is the whole reason notifications exist: by definition
    // you are not looking at the panel when it happens.
    if (m.kind === "watch") {
      notify("Watch fired", `${m.description} — ${m.detail}`.slice(0, 180));
    }

    if (m.kind === "turn_end") {
      const took = Date.now() - turnStartedAt;
      // Short turns are ones you watched happen; don't nag about those.
      if (turnStartedAt && took > LONG_TURN_MS) {
        notify("Claude finished", `Took ${Math.round(took / 1000)}s${m.denials ? ` · ${m.denials} denied` : ""}`);
      }
      turnStartedAt = 0;
    }
  };
  obs.onclose = () => { obs = null; if (enabled) obsTimer = setTimeout(observeAgent, 5000); };
  obs.onerror = () => { try { obs?.close(); } catch {} };
}

function notify(title, message) {
  chrome.notifications.create("", {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title,
    message,
    priority: 1,
  });
}

// Clicking a notification should take you to the conversation.
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch { /* needs a gesture in some contexts; nothing to do */ }
});

/* ---------------- page watches ---------------- */

/**
 * Polled from here rather than by injecting a MutationObserver into the page.
 * An injected observer dies on every navigation — which is usually the very
 * moment the thing being watched for happens. Polling from the worker survives
 * navigation, SPA rerenders and the page replacing its own DOM.
 *
 * The /ext socket pings every 20s, which is what keeps this worker alive to do it.
 */
const watches = new Map();          // id -> {tabId, condition, baseline}
const POLL_MS = 6000;
let pollTimer = null;

// Chrome evicts this worker whenever it likes; an in-memory map was gone with
// it while the server still listed the watch, which then never fired. Mirror
// the map into session storage (cleared when the browser closes, which is
// also when the tabs go) and rebuild it every time the worker starts.
function persistWatches() {
  chrome.storage.session.set({ watches: [...watches] }).catch(() => {});
}
async function restoreWatches() {
  try {
    const s = await chrome.storage.session.get("watches");
    for (const [id, w] of s.watches ?? []) if (!watches.has(id)) watches.set(id, w);
  } catch { /* nothing stored yet */ }
  ensurePolling();
}

function ensurePolling() {
  if (pollTimer || watches.size === 0) return;
  pollTimer = setInterval(pollWatches, POLL_MS);
}
function stopPollingIfIdle() {
  if (watches.size === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** Runs in the page. Returns what the condition needs to decide. */
function probe(condition) {
  const text = document.body?.innerText ?? "";
  return {
    url: location.href,
    title: document.title,
    hasSelector: condition.kind === "selector" ? !!document.querySelector(condition.value) : null,
    contains: (condition.kind === "contains" || condition.kind === "missing")
      ? text.includes(condition.value) : null,
    // For "changes", compare the watched region rather than the whole page,
    // since a clock or a counter would otherwise fire instantly.
    snapshot: condition.kind === "changes"
      ? (condition.value ? (document.querySelector(condition.value)?.innerText ?? "") : text).trim().slice(0, 20000)
      : null,
  };
}

async function pollWatches() {
  for (const [id, w] of [...watches]) {
    let r;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: w.tabId }, func: probe, args: [w.condition], world: "MAIN",
      });
      r = res?.result;
    } catch (e) {
      // Tab closed, or navigated somewhere we cannot script. Report and stop.
      watches.delete(id); persistWatches();
      report(id, `stopped: the tab is no longer reachable (${String(e?.message ?? e).slice(0, 80)})`);
      continue;
    }
    if (!r) continue;

    let fired = null;
    if (w.condition.kind === "contains" && r.contains) fired = `"${w.condition.value}" appeared`;
    else if (w.condition.kind === "missing" && r.contains === false) fired = `"${w.condition.value}" is gone`;
    else if (w.condition.kind === "selector" && r.hasSelector) fired = `element "${w.condition.value}" appeared`;
    else if (w.condition.kind === "changes") {
      if (w.baseline === undefined) { w.baseline = r.snapshot; persistWatches(); }   // first poll sets the baseline
      else if (r.snapshot !== w.baseline) fired = "the watched content changed";
    }

    if (fired) {
      watches.delete(id); persistWatches();
      report(id, `${fired} on ${r.title || r.url} (${r.url})`);
    }
  }
  stopPollingIfIdle();
}

function report(id, detail) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "watch_fired", watchId: id, detail }));
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("no active tab");
  return t;
}
async function resolveTab(tabId) {
  return typeof tabId === "number" ? await chrome.tabs.get(tabId) : await activeTab();
}

/** Downscale a data URL to `maxSide` and re-encode as JPEG; returns the original if anything is unavailable. */
async function shrinkImage(dataUrl, maxSide, quality) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return { dataUrl: `data:image/jpeg;base64,${btoa(bin)}`, width: w, height: h };
  } catch {
    return { dataUrl, width: undefined, height: undefined };
  }
}

/* Open JavaScript dialogs, by tab: the content-script hook reports one the
   moment it opens (before the page blocks) and again when it closes. While
   one is open nothing else in that tab can run, so tab commands give up
   after DIALOG_GRACE_MS and say what is blocking them. */
const dialogs = new Map();
const DIALOG_GRACE_MS = 8000;
chrome.runtime.onMessage.addListener((m, sender) => {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number" || !m || typeof m !== "object") return;
  if (m.kind === "dialog") dialogs.set(tabId, { type: m.type, message: String(m.message ?? "").slice(0, 2000), defaultValue: m.defaultValue, frameId: sender.frameId, at: Date.now() });
  else if (m.kind === "dialog-closed") dialogs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => dialogs.delete(tabId));
const dialogError = (tabId) => {
  const d = dialogs.get(tabId);
  return d
    ? new Error(`the tab is blocked by a JavaScript ${d.type} dialog: "${d.message.slice(0, 200)}". Use handle_dialog to accept or dismiss it before anything else in this tab.`)
    : new Error("the tab is not responding (a JavaScript dialog may be open; handle_dialog can answer it, or the user can look at the tab)");
};
const withGrace = (tabId, promise) => new Promise((resolve, reject) => {
  const done = (f, v) => { clearTimeout(t); clearInterval(poll); f(v); };
  const t = setTimeout(() => done(reject, dialogError(tabId)), DIALOG_GRACE_MS);
  // the hook reports a dialog the instant it opens: no need to wait out the grace
  const poll = setInterval(() => { if (dialogs.has(tabId)) done(reject, dialogError(tabId)); }, 100);
  promise.then((v) => done(resolve, v), (e) => done(reject, e));
});
/* Answering a dialog needs the debugger protocol, and Chrome only lets a
   session answer a dialog it saw open (measured: a session attached after the
   dialog opened gets "No dialog is showing"). So the worker attaches to a tab
   before the agent's first act-level call in it — click, fill, press, eval,
   navigate — and stays attached until the server says the turn is over
   (`release`). Chrome shows its "is debugging this browser" bar meanwhile.
   Read-level calls never attach; a dialog the page raises on its own is still
   detected by the hook, just not answerable — the user clicks it. */
const debugged = new Set();
const declined = new Set();   // tabs where the user clicked Cancel on Chrome's bar: stay off until release
async function ensureDebugger(tabId) {
  if (debugged.has(tabId)) return true;
  if (declined.has(tabId)) return false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    debugged.add(tabId);
    return true;
  } catch { return false; }   // DevTools or another extension has it: fall back to the hook
}
async function releaseDebugger(tabId) {
  if (typeof tabId === "number") declined.delete(tabId); else declined.clear();
  const ids = typeof tabId === "number" ? [tabId] : [...debugged];
  for (const id of ids) { debugged.delete(id); try { await chrome.debugger.detach({ tabId: id }); } catch { /* gone */ } }
  return { released: ids.length };
}
chrome.debugger.onDetach.addListener((src, reason) => {
  if (typeof src.tabId !== "number") return;
  debugged.delete(src.tabId);
  // The person clicked Cancel on the bar: do not re-attach behind their back
  // for the rest of this turn (untested: headless has no bar to click).
  if (reason === "canceled_by_user") declined.add(src.tabId);
});
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (typeof src.tabId !== "number") return;
  if (method === "Page.javascriptDialogOpening") {
    dialogs.set(src.tabId, { type: params.type, message: String(params.message ?? "").slice(0, 2000), defaultValue: params.defaultPrompt, at: Date.now(), answerable: true });
  } else if (method === "Page.javascriptDialogClosed") dialogs.delete(src.tabId);
});
async function handleDialog(tabId, accept, text) {
  if (!debugged.has(tabId)) return { handled: false, reason: "this dialog opened before the worker was attached to the tab (a read-only call, or the page raised it itself); it cannot be answered from here — ask the user to click it, or reload the tab" };
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: !!accept, ...(typeof text === "string" ? { promptText: text } : {}) });
    return { handled: true };
  } catch (e) {
    if (/no dialog/i.test(String(e?.message ?? e))) return { handled: false, reason: "no dialog is open" };
    throw e;
  }
}
/* Trusted input through the debugger session. Synthetic KeyboardEvents are
   untrusted: editors like Monaco/CodeMirror and many React inputs ignore
   them (measured on TradingView's Pine editor: nothing typed). CDP's
   Input.insertText and Input.dispatchKeyEvent produce real, trusted events. */
const KEYS = {
  Enter: [13, "Enter", "\r"], NumpadEnter: [13, "NumpadEnter", "\r"], Tab: [9, "Tab"], Escape: [27, "Escape"], Backspace: [8, "Backspace"], Delete: [46, "Delete"],
  ArrowLeft: [37, "ArrowLeft"], ArrowUp: [38, "ArrowUp"], ArrowRight: [39, "ArrowRight"], ArrowDown: [40, "ArrowDown"],
  Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"], Insert: [45, "Insert"],
  " ": [32, "Space", " "], Space: [32, "Space", " "],
  F1: [112, "F1"], F2: [113, "F2"], F3: [114, "F3"], F4: [115, "F4"], F5: [116, "F5"], F6: [117, "F6"], F7: [118, "F7"], F8: [119, "F8"], F9: [120, "F9"], F10: [121, "F10"], F11: [122, "F11"], F12: [123, "F12"],
};
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
/** "Ctrl+Shift+Enter" → { key, mods }; a single character is itself. */
function parseKey(spec) {
  const parts = String(spec).split("+");
  const key = parts.length > 1 && parts[parts.length - 1] === "" ? "+" : parts.pop();   // "Ctrl++"
  let mods = 0;
  for (const m of parts) { const bit = MODS[m.toLowerCase()]; if (bit === undefined) throw new Error(`unknown modifier "${m}" in "${spec}"`); mods |= bit; }
  return { key, mods };
}
async function cdpKey(tabId, spec) {
  const { key, mods } = parseKey(spec);
  const known = KEYS[key];
  const single = !known && key.length === 1;
  if (!known && !single) throw new Error(`unknown key "${key}" — use a character, Enter, Tab, Escape, Backspace, Delete, Arrow*, Home, End, PageUp/Down, F1–F12, with Ctrl/Alt/Shift/Meta+`);
  const code = known ? known[1] : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : "";
  const vk = known ? known[0] : key.toUpperCase().charCodeAt(0);
  const text = known ? known[2] : (mods & ~8) ? undefined : key;   // Ctrl/Alt/Meta combos carry no text
  // "Ctrl+A" means the a key with Ctrl (key "a"); with Shift the key reports upper-case
  const keyName = known ? key : /^[a-z]$/i.test(key) ? ((mods & 8) ? key.toUpperCase() : key.toLowerCase()) : key;
  const base = { key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
  await chrome.debugger.sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/** Inject page-read.js (idempotent), with the dialog guard and grace. */
async function inject(tabId) {
  if (dialogs.has(tabId)) throw dialogError(tabId);
  await withGrace(tabId, chrome.scripting.executeScript({ target: { tabId }, files: ["page-read.js"], world: "MAIN" }));
}

/** Run a function in the page and return its value. */
async function run(tabId, fn, args = []) {
  if (dialogs.has(tabId)) throw dialogError(tabId);
  const [res] = await withGrace(tabId, chrome.scripting.executeScript({ target: { tabId }, func: fn, args, world: "MAIN" }));
  if (!res) throw new Error("script did not run (restricted page?)");
  // A throw inside the page comes back as result null, nothing else
  // (measured on Chromium 145, MAIN and isolated world alike). So page
  // functions return { __err } instead of throwing, and it is rethrown here.
  if (res.result && typeof res.result === "object" && "__err" in res.result) throw new Error(res.result.__err);
  return res.result;
}

globalThis.ctHandle = (action, p) => handle(action, p ?? {});   // test harness entry
async function handle(action, p) {
  switch (action) {
    // Ambient context for a prompt: what the user is actually looking at.
    // Deliberately small — title, url, and any selected text.
    case "active_tab": {
      const t = await activeTab();
      let selection = "";
      try {
        selection = await run(t.id, () => (window.getSelection?.().toString() ?? "").trim().slice(0, 2000));
      } catch {
        // Restricted page (chrome://, the web store): title and url still work.
      }
      return { id: t.id, title: t.title, url: t.url, selection };
    }

    case "watch_start": {
      const t = await resolveTab(p.tabId);
      watches.set(p.watchId, { tabId: t.id, condition: p.condition, baseline: undefined });
      persistWatches();
      ensurePolling();
      // Prime the baseline immediately so "changes" measures from now, not
      // from six seconds from now.
      if (p.condition.kind === "changes") await pollWatches();
      return { watchId: p.watchId, tabId: t.id, url: t.url, title: t.title };
    }

    case "watch_stop": {
      const had = watches.delete(p.watchId);
      persistWatches();
      stopPollingIfIdle();
      return { stopped: had };
    }

    case "watch_list":
      return { ids: [...watches.keys()] };

    // Which site a call is about, before it happens — the server's site gate asks this first.
    case "tab_url": {
      const t = await resolveTab(p.tabId);
      const d = dialogs.get(t.id);
      return { tabId: t.id, url: t.url, title: t.title, ...(d ? { dialog: { type: d.type, message: d.message } } : {}) };
    }

    // What dialog is open in a tab, if any — known from the hook, no scripting needed.
    case "dialog_state": {
      const t = await resolveTab(p.tabId);
      const d = dialogs.get(t.id);
      return { tabId: t.id, open: !!d, ...(d ? { type: d.type, message: d.message, defaultValue: d.defaultValue, openForMs: Date.now() - d.at } : {}) };
    }

    // Accept (OK) or dismiss (Cancel) it; text answers a prompt.
    case "handle_dialog": {
      const t = await resolveTab(p.tabId);
      const d = dialogs.get(t.id);
      if (!d) return { tabId: t.id, handled: false, reason: "no dialog is open" };
      const r = await handleDialog(t.id, p.accept, p.text);
      if (r.handled) dialogs.delete(t.id);
      return { tabId: t.id, type: d.type, message: d.message, ...r };
    }

    // The turn is over: let go of every tab the worker was attached to.
    case "release": return await releaseDebugger(p.tabId);

    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId,
        ...(dialogs.has(t.id) ? { dialog: { type: dialogs.get(t.id).type, message: dialogs.get(t.id).message } } : {}) }));
    }

    // The bytes behind a tab (or a URL), fetched with the profile's cookies —
    // how the server reads a PDF the viewer will not let a script into.
    case "fetch_bytes": {
      const t = p.url ? null : await resolveTab(p.tabId);
      const url = p.url ?? t?.url;
      if (!url || !/^https?:/.test(url)) throw new Error("not a fetchable URL");
      const max = p.maxBytes ?? 20 * 1024 * 1024;
      const r = await fetch(url, { credentials: "include", redirect: "follow" });
      if (!r.ok) throw new Error(`fetch failed: HTTP ${r.status}`);
      const len = Number(r.headers.get("content-length") ?? 0);
      if (len > max) throw new Error(`too large: ${len} bytes (limit ${max})`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > max) throw new Error(`too large: ${buf.length} bytes (limit ${max})`);
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { tabId: t?.id, title: t?.title, url: r.url || url, contentType: r.headers.get("content-type") ?? "", disposition: r.headers.get("content-disposition") ?? "", bytes: buf.length, data: btoa(bin) };
    }

    case "read_page": {
      const t = await resolveTab(p.tabId);
      const max = p.maxChars ?? 20000;
      const mode = ["text", "markdown", "links", "tables", "forms"].includes(p.mode) ? p.mode : "text";
      // page-read.js defines ctReadPage in the page; inject once per call (idempotent), then ask it.
      await inject(t.id);
      const body = await run(t.id, (m, mx) => globalThis.ctReadPage(m, mx), [mode, max]);
      return { tabId: t.id, title: t.title, url: t.url, ...body };
    }

    // Poll the page until every given condition holds (text = any of), or time out.
    // Polled from here, not inside the page, so a reload mid-wait does not kill it.
    case "wait_for": {
      const t0 = Date.now();
      const timeout = Math.min(Math.max(p.timeoutMs ?? 10000, 100), 60000);
      const glob = p.url ? new RegExp("^" + String(p.url).split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$") : null;
      let last = null, prevResources = -1, idleSince = 0;
      while (true) {
        const t = await resolveTab(p.tabId);
        let probe = null;
        try {
          await inject(t.id);
          probe = await run(t.id, (o) => globalThis.ctWaitProbe(o), [{ text: p.text, gone: p.gone, selector: p.selector, load: p.load }]);
        } catch { probe = null; }   // mid-navigation: the page is not scriptable for a moment
        last = { url: t.url, readyState: probe?.readyState ?? "unavailable" };
        const checks = [];
        if (p.text) checks.push(!!probe?.text);
        if (p.gone) checks.push(!!probe?.gone);
        if (p.selector) checks.push(!!probe?.selector);
        if (p.load) checks.push(!!probe?.load);
        if (glob) checks.push(glob.test(t.url || ""));
        if (p.networkIdle) {
          const n = probe?.resources ?? -1;
          if (probe && n === prevResources && probe.readyState === "complete") { idleSince = idleSince || Date.now(); } else idleSince = 0;
          prevResources = n;
          checks.push(idleSince > 0 && Date.now() - idleSince >= 500);
        }
        if (checks.length && checks.every(Boolean)) {
          return { ok: true, elapsedMs: Date.now() - t0, tabId: t.id, url: t.url, ...(probe?.text ? { text: probe.text } : {}) };
        }
        if (Date.now() - t0 >= timeout) return { ok: false, timeout: true, elapsedMs: Date.now() - t0, tabId: t.id, last };
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    case "find": {
      const t = await resolveTab(p.tabId);
      await inject(t.id);
      const r = await run(t.id, (o) => globalThis.ctFind(o), [{ text: p.text, regex: p.regex, role: p.role, name: p.name, limit: p.limit }]);
      return { tabId: t.id, url: t.url, ...r };
    }

    case "scroll": {
      const t = await resolveTab(p.tabId);
      await inject(t.id);
      const r = await run(t.id, (o) => globalThis.ctScroll(o), [{ ref: p.ref, selector: p.selector, direction: p.direction, pages: p.pages, to: p.to }]);
      if (r?.error) throw new Error(r.error);
      await new Promise((res) => setTimeout(res, 150));   // let lazy content paint before the next call
      return { tabId: t.id, ...r };
    }

    case "snapshot": {
      const t = await resolveTab(p.tabId);
      return { tabId: t.id, url: t.url, elements: await run(t.id, () => {
        const out = [];
        const sel = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[onclick],[contenteditable="true"]';
        document.querySelectorAll(sel).forEach((el, i) => {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;                       // skip hidden
          if (getComputedStyle(el).visibility === "hidden") return;
          const ref = "e" + (i + 1);
          el.setAttribute("data-ct-ref", ref);
          out.push({
            ref,
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute("type") || undefined,
            text: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 80),
            href: el.getAttribute("href") || undefined,
          });
        });
        return out.slice(0, 300);
      })};
    }

    // What the page logged / requested, from the console hook's buffers.
    // Read-only; `clear` empties the buffer after reading. Resources that are
    // not fetch/XHR (images, scripts, stylesheets) come from resource timing:
    // URL, type and duration, but no status — the browser does not expose it.
    case "console_read": {
      const t = await resolveTab(p.tabId);
      const r = await run(t.id, (level, since, limit, clear) => {
        const ct = globalThis.__ct;
        if (!ct) return { __err: "no console buffer in this page (loaded before the extension was installed, or a page scripts cannot run in) — reload the tab and try again" };
        const want = level === "error" ? ["error"] : level === "warn" ? ["error", "warn"] : null;
        let all = ct.console.filter((e) => (!want || want.includes(e.level)) && (!since || e.t >= since));
        const total = all.length;
        all = all.slice(-limit);
        const counts = { error: 0, warn: 0, log: 0, info: 0 };
        for (const e of ct.console) counts[e.level] = (counts[e.level] ?? 0) + 1;
        if (clear) { ct.console.length = 0; ct.dropped.console = 0; }
        return { total, shown: all.length, counts, dropped: ct.dropped.console, entries: all };
      }, [p.level ?? "all", p.since ?? 0, Math.min(Math.max(p.limit ?? 100, 1), 500), !!p.clear]);
      return { tabId: t.id, url: t.url, ...r };
    }
    case "network_read": {
      const t = await resolveTab(p.tabId);
      const r = await run(t.id, (filter, failed, includeResources, limit, clear) => {
        const ct = globalThis.__ct;
        if (!ct) return { __err: "no network buffer in this page (loaded before the extension was installed, or a page scripts cannot run in) — reload the tab and try again" };
        let all = [...ct.net];
        if (includeResources) {
          for (const e of performance.getEntriesByType("resource")) {
            if (e.initiatorType === "fetch" || e.initiatorType === "xmlhttprequest") continue;
            all.push({ t: Math.round(performance.timeOrigin + e.startTime), type: e.initiatorType || "resource", method: "GET", url: e.name.slice(0, 500), status: null, ok: null, ms: Math.round(e.duration), bytes: e.transferSize || undefined });
          }
          all.sort((a, b) => a.t - b.t);
        }
        const f = filter ? String(filter).toLowerCase() : "";
        if (f) all = all.filter((e) => e.url.toLowerCase().includes(f));
        if (failed) all = all.filter((e) => e.ok === false);
        const total = all.length;
        const failedCount = all.filter((e) => e.ok === false).length;
        all = all.slice(-limit);
        if (clear) { ct.net.length = 0; ct.dropped.net = 0; performance.clearResourceTimings(); }
        return { total, shown: all.length, failed: failedCount, dropped: ct.dropped.net, entries: all };
      }, [p.filter ?? "", !!p.failed, p.resources !== false, Math.min(Math.max(p.limit ?? 100, 1), 500), !!p.clear]);
      return { tabId: t.id, url: t.url, ...r };
    }

    // Tab management: open, close, focus, back, forward, reload.
    case "open_tab": {
      const t = await chrome.tabs.create({ url: p.url, active: p.active !== false });
      return { tabId: t.id, url: p.url, windowId: t.windowId };
    }
    case "close_tab": {
      const t = await resolveTab(p.tabId);
      await releaseDebugger(t.id); dialogs.delete(t.id);
      await chrome.tabs.remove(t.id);
      return { tabId: t.id, closed: true, title: t.title, url: t.url };
    }
    case "focus_tab": {
      const t = await resolveTab(p.tabId);
      await chrome.tabs.update(t.id, { active: true });
      try { await chrome.windows.update(t.windowId, { focused: true }); } catch { /* no window focus in some hosts */ }
      return { tabId: t.id, focused: true, title: t.title, url: t.url };
    }
    case "back": case "forward": case "reload": {
      let t = await resolveTab(p.tabId);
      // A navigation still in flight (a background tab loads slowly) would make
      // "back" step over the page just asked for; let it commit first.
      for (let i = 0; i < 30 && t.status !== "complete"; i++) { await new Promise((r) => setTimeout(r, 100)); t = await chrome.tabs.get(t.id); }
      const attached = await ensureDebugger(t.id);
      if (action === "reload") await chrome.tabs.reload(t.id, { bypassCache: !!p.hard });
      else {
        // Not chrome.tabs.goBack: measured landing two entries back (about:blank
        // from [blank, one, two]). The page's own history.back() and the
        // debugger's navigateToHistoryEntry both land on the previous entry.
        const delta = action === "back" ? -1 : 1;
        if (attached) {
          const h = await chrome.debugger.sendCommand({ tabId: t.id }, "Page.getNavigationHistory");
          const e = h.entries[h.currentIndex + delta];
          if (!e) throw new Error(`nothing to go ${action} to`);
          await chrome.debugger.sendCommand({ tabId: t.id }, "Page.navigateToHistoryEntry", { entryId: e.id });
        } else await run(t.id, (d) => history.go(d), [delta]);
      }
      // the new URL is known once the navigation has committed; give it a moment
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const now = await chrome.tabs.get(t.id);
        if (now.status === "complete" && (action === "reload" || now.url !== t.url)) return { tabId: t.id, url: now.url, title: now.title };
      }
      const now = await chrome.tabs.get(t.id);
      return { tabId: t.id, url: now.url, title: now.title, ...(now.status !== "complete" ? { loading: true } : {}) };
    }

    case "navigate": {
      if (p.newTab) { const t = await chrome.tabs.create({ url: p.url }); return { tabId: t.id, url: p.url }; }
      const t = await resolveTab(p.tabId);
      await ensureDebugger(t.id);
      await chrome.tabs.update(t.id, { url: p.url });
      return { tabId: t.id, url: p.url };
    }

    case "click": {
      const t = await resolveTab(p.tabId);
      await ensureDebugger(t.id);
      return await run(t.id, (ref, selector) => {
        const el = ref ? document.querySelector(`[data-ct-ref="${ref}"]`) : document.querySelector(selector);
        if (!el) return { __err: "element not found: " + (ref || selector) };
        el.scrollIntoView({ block: "center" });
        el.click();
        return { clicked: el.tagName.toLowerCase(), text: (el.innerText || "").trim().slice(0, 60) };
      }, [p.ref ?? null, p.selector ?? null]);
    }

    case "fill": {
      const t = await resolveTab(p.tabId);
      await ensureDebugger(t.id);
      await inject(t.id);
      const r = await run(t.id, (f) => globalThis.ctSetField(f), [{ ref: p.ref ?? null, selector: p.selector ?? null, value: p.value }]);
      if (!r.ok) throw new Error(`${r.error}: ${r.field}${r.options ? ` (options: ${r.options.join(", ")})` : ""}`);
      return { filled: r.field, ...(r.length != null ? { length: r.length } : {}), ...(r.set != null ? { set: r.set } : {}) };
    }

    // Put a file into an <input type=file>: the bytes come from the server
    // (the browser may be on another machine, so no local path), become a
    // File in the page, and go in through a DataTransfer — the one way a
    // script may set input.files. change/input fire like a picker would.
    case "upload": {
      const t = await resolveTab(p.tabId);
      await ensureDebugger(t.id);
      return await run(t.id, (ref, selector, name, mime, b64, append) => {
        const el = ref ? document.querySelector(`[data-ct-ref="${ref}"]`) : document.querySelector(selector);
        if (!el) return { __err: "element not found: " + (ref || selector) };
        if (!(el instanceof HTMLInputElement) || el.type !== "file") return { __err: `not a file input: ${el.tagName.toLowerCase()}${el.type ? `[type=${el.type}]` : ""}` };
        const bin = atob(b64); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], name, { type: mime });
        const dt = new DataTransfer();
        if (append && el.multiple) for (const f of el.files) dt.items.add(f);
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { uploaded: name, bytes: bytes.length, files: [...el.files].map((f) => f.name), multiple: el.multiple, accept: el.accept || undefined };
      }, [p.ref ?? null, p.selector ?? null, p.name, p.mime, p.data, !!p.append]);
    }

    // Several fields in one call; misses are reported, not fatal.
    case "fill_form": {
      const t = await resolveTab(p.tabId);
      await ensureDebugger(t.id);
      await inject(t.id);
      const fields = Array.isArray(p.fields) ? p.fields.slice(0, 100) : [];
      const results = await run(t.id, (fs) => fs.map((f) => globalThis.ctSetField(f)), [fields.map((f) => ({ ref: f.ref ?? null, selector: f.selector ?? null, value: f.value }))]);
      const filled = results.filter((r) => r.ok).length;
      return { tabId: t.id, filled, total: results.length, results };
    }

    case "press": {
      const t = await resolveTab(p.tabId);
      if (dialogs.has(t.id)) throw dialogError(t.id);
      const attached = await ensureDebugger(t.id);
      if (attached && !p.synthetic) {
        // Real key: the browser does what it always does with it — implicit
        // form submission on Enter, focus moves on Tab, editors type.
        const on = await run(t.id, () => (document.activeElement || document.body).tagName.toLowerCase());
        await cdpKey(t.id, p.key);
        return { pressed: p.key, on, trusted: true };
      }
      return await run(t.id, (key) => {
        const el = document.activeElement || document.body;
        let prevented = false;
        for (const type of ["keydown", "keypress", "keyup"]) {
          if (!el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))) prevented = true;
        }
        // A synthetic Enter has no default action (measured: no submit), so
        // do what the real key would: implicit submission of the form the
        // focused text field belongs to, unless the page cancelled the key.
        let submitted = false;
        if (/^(Enter|NumpadEnter)$/.test(key) && !prevented && el.form && el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|file|image)$/i.test(el.type)) {
          const btn = el.form.querySelector('button[type=submit],input[type=submit],input[type=image],button:not([type])');
          const texts = [...el.form.querySelectorAll("input")].filter((i) => !/^(checkbox|radio|button|submit|reset|file|image|hidden|range|color)$/i.test(i.type));
          if (btn || texts.length === 1) { try { btn ? el.form.requestSubmit(btn) : el.form.requestSubmit(); submitted = true; } catch { /* invalid form: the browser shows its message */ } }
        }
        return { pressed: key, on: el.tagName.toLowerCase(), ...(submitted ? { submitted: true } : {}) };
      }, [p.key]);
    }

    // Type text into the focused element (or the given one) as real
    // keystrokes: Input.insertText through the debugger — Monaco, CodeMirror,
    // contenteditables and framework inputs all accept it. Falls back to
    // execCommand("insertText") when the debugger cannot attach.
    case "type": {
      const t = await resolveTab(p.tabId);
      if (dialogs.has(t.id)) throw dialogError(t.id);
      const attached = await ensureDebugger(t.id);
      if (p.ref || p.selector) {
        const r = await run(t.id, (ref, selector) => {
          const el = ref ? document.querySelector(`[data-ct-ref="${ref}"]`) : document.querySelector(selector);
          if (!el) return { __err: "element not found: " + (ref || selector) };
          el.focus(); if (typeof el.select === "function" && el.matches("input,textarea") && false) el.select();
          return { tag: el.tagName.toLowerCase() };
        }, [p.ref ?? null, p.selector ?? null]);
        if (r?.__err) throw new Error(r.__err);
      }
      const text = String(p.text ?? "");
      if (attached && !p.synthetic) {
        // insertText handles newlines as line breaks in editors; in a plain
        // input a "\n" is what Enter would do, so send those as keys.
        const parts = text.split("\n");
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) await chrome.debugger.sendCommand({ tabId: t.id }, "Input.insertText", { text: parts[i] });
          if (i < parts.length - 1) await cdpKey(t.id, "Enter");
        }
        const on = await run(t.id, () => { const el = document.activeElement; return { tag: el?.tagName.toLowerCase(), value: (el?.value ?? el?.innerText ?? "").slice(-200) }; });
        return { typed: text.length, trusted: true, ...on };
      }
      const r = await run(t.id, (s) => {
        const el = document.activeElement;
        if (!el || el === document.body) return { __err: "nothing is focused — give a ref or selector" };
        const ok = document.execCommand("insertText", false, s);
        if (!ok) { const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(proto, "value")?.set; if (!set) return { __err: "cannot type here without the debugger (another debugger is attached?)" }; set.call(el, (el.value ?? "") + s); el.dispatchEvent(new Event("input", { bubbles: true })); }
        return { tag: el.tagName.toLowerCase(), value: (el.value ?? el.innerText ?? "").slice(-200) };
      }, [text]);
      return { typed: text.length, trusted: false, ...r };
    }

    // Would a click / Enter submit a form, and what — for the confirm card.
    case "submit_probe": {
      const t = await resolveTab(p.tabId);
      await inject(t.id);
      return await run(t.id, (o) => globalThis.ctSubmitProbe(o), [{ ref: p.ref ?? null, selector: p.selector ?? null, key: p.key ?? null }]);
    }

    case "eval": {
      const t = await resolveTab(p.tabId);
      if (dialogs.has(t.id)) throw dialogError(t.id);
      const attached = await ensureDebugger(t.id);
      if (attached && !p.synthetic) {
        // Runtime.evaluate is not subject to the page's CSP (executeScript's
        // eval is: a script-src without unsafe-eval throws EvalError — measured
        // on TradingView), supports top-level await (replMode), and reports
        // exceptions as such.
        const cdp = (m, params) => chrome.debugger.sendCommand({ tabId: t.id }, m, params);
        const thrown = (d) => { const ex = d.exception; return new Error(ex?.description?.split("\n")[0] ?? d.text ?? "evaluation failed"); };
        const cap = new Promise((_, rej) => setTimeout(() => rej(new Error("promise still pending after 30s")), 30000));
        // replMode allows top-level await (measured: a rejected promise as the
        // last value then comes back as the promise itself, so await it here).
        const evaluate = (expression, replMode) => Promise.race([cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: false, replMode, userGesture: true, allowUnsafeEvalBlockedByCSP: true }), cap]);
        let r = await evaluate(p.code, /\bawait\b/.test(p.code));
        // "const x = await f(); return x" — the older convention: run it as an async body
        if (r.exceptionDetails && /Illegal return statement/.test(r.exceptionDetails.exception?.description ?? "")) r = await evaluate(`(async () => {\n${p.code}\n})()`, false);
        if (r.exceptionDetails) throw thrown(r.exceptionDetails);
        let v = r.result;
        if (v.subtype === "promise" && v.objectId) {
          r = await Promise.race([cdp("Runtime.awaitPromise", { promiseObjectId: v.objectId, returnByValue: true }), cap]);
          if (r.exceptionDetails) throw thrown(r.exceptionDetails);
          v = r.result;
        } else if (v.objectId) {
          r = await cdp("Runtime.callFunctionOn", { objectId: v.objectId, functionDeclaration: "function () { return this; }", returnByValue: true });
          if (r.exceptionDetails) throw thrown(r.exceptionDetails);
          v = r.result;
        }
        return { tabId: t.id, result: v.type === "undefined" ? null : v.value !== undefined ? v.value : (v.unserializableValue ?? v.description ?? null) };
      }
      // A promise is awaited (executeScript resolves a returned promise), with
      // a cap so a promise that never settles does not hang the call. Code
      // with a top-level `await` is not a valid eval expression; it is rerun
      // as an async function body, so it must `return` its value.
      // An error thrown in the page comes back as a value: executeScript
      // reports a throwing function as result undefined (measured), which used
      // to read as "null" instead of the error.
      const v = await run(t.id, async (code, capMs) => {
        try {
          let r;
          try { r = eval(code); }
          catch (e) {
            if (!(e instanceof SyntaxError) || !/await/.test(code)) throw e;
            r = new (Object.getPrototypeOf(async function () {}).constructor)(code)();
          }
          if (r && typeof r.then === "function") {
            r = await Promise.race([r, new Promise((_, rej) => setTimeout(() => rej(new Error(`promise still pending after ${capMs / 1000}s`)), capMs))]);
          }
          try { return { value: JSON.parse(JSON.stringify(r ?? null)) }; } catch { return { value: String(r) }; }
        } catch (e) { return { error: String(e?.message ?? e) }; }
      }, [p.code, 30000]);
      if (v && typeof v === "object" && "error" in v) throw new Error(v.error);
      return { tabId: t.id, result: v?.value ?? null };
    }

    case "screenshot": {
      const t = await resolveTab(p.tabId);
      const activate = p.activate !== false;

      // captureVisibleTab captures whatever is VISIBLE in the window - it has no
      // way to target a background tab. Capturing blind would hand back an image
      // of an unrelated tab (someone's mail, their bank) labelled as the one that
      // was asked for, so make the tab visible first or refuse outright.
      let prior = null;
      if (!t.active) {
        if (!activate) {
          throw new Error(
            `tab ${t.id} is not the visible tab in window ${t.windowId}; ` +
            `captureVisibleTab can only capture the visible tab. ` +
            `Omit activate (or pass activate:true) to focus it for the capture.`
          );
        }
        [prior] = await chrome.tabs.query({ active: true, windowId: t.windowId });
        await chrome.tabs.update(t.id, { active: true });
        await new Promise((r) => setTimeout(r, p.settleMs ?? 250)); // let it paint
      }

      try {
        const raw = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
        // Belt and braces: prove what we captured is what was asked for.
        const [visible] = await chrome.tabs.query({ active: true, windowId: t.windowId });
        if (visible?.id !== t.id) {
          throw new Error(`captured tab ${visible?.id} but tab ${t.id} was requested`);
        }
        // The capture is at device pixels (a HiDPI screen gives ~4 MB of PNG).
        // The model sees it inline now, so size it for the model: at most
        // 1568px on the long side (the API's recommended maximum), as JPEG.
        const shrunk = await shrinkImage(raw, p.maxSide ?? 1568, 0.85);
        return { tabId: t.id, url: t.url, dataUrl: shrunk.dataUrl, width: shrunk.width, height: shrunk.height };
      } finally {
        if (prior && prior.id !== t.id) {
          try { await chrome.tabs.update(prior.id, { active: true }); } catch {}
        }
      }
    }

    default:
      throw new Error("unknown action: " + action);
  }
}

restoreWatches();
