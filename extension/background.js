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

/** Run a function in the page and return its value. */
async function run(tabId, fn, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args, world: "MAIN" });
  if (!res) throw new Error("script did not run (restricted page?)");
  return res.result;
}

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
      return { tabId: t.id, url: t.url, title: t.title };
    }

    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
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
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["page-read.js"], world: "MAIN" });
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
          await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["page-read.js"], world: "MAIN" });
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
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["page-read.js"], world: "MAIN" });
      const r = await run(t.id, (o) => globalThis.ctFind(o), [{ text: p.text, regex: p.regex, role: p.role, name: p.name, limit: p.limit }]);
      return { tabId: t.id, url: t.url, ...r };
    }

    case "scroll": {
      const t = await resolveTab(p.tabId);
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["page-read.js"], world: "MAIN" });
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

    case "navigate": {
      if (p.newTab) { const t = await chrome.tabs.create({ url: p.url }); return { tabId: t.id, url: p.url }; }
      const t = await resolveTab(p.tabId);
      await chrome.tabs.update(t.id, { url: p.url });
      return { tabId: t.id, url: p.url };
    }

    case "click": {
      const t = await resolveTab(p.tabId);
      return await run(t.id, (ref, selector) => {
        const el = ref ? document.querySelector(`[data-ct-ref="${ref}"]`) : document.querySelector(selector);
        if (!el) throw new Error("element not found: " + (ref || selector));
        el.scrollIntoView({ block: "center" });
        el.click();
        return { clicked: el.tagName.toLowerCase(), text: (el.innerText || "").trim().slice(0, 60) };
      }, [p.ref ?? null, p.selector ?? null]);
    }

    case "fill": {
      const t = await resolveTab(p.tabId);
      return await run(t.id, (ref, selector, value) => {
        const el = ref ? document.querySelector(`[data-ct-ref="${ref}"]`) : document.querySelector(selector);
        if (!el) throw new Error("element not found: " + (ref || selector));
        el.focus();
        if (el.isContentEditable) el.textContent = value;
        else {
          // React and friends listen on the native setter, not on .value.
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { filled: ref || selector, length: value.length };
      }, [p.ref ?? null, p.selector ?? null, p.value]);
    }

    case "press": {
      const t = await resolveTab(p.tabId);
      return await run(t.id, (key) => {
        const el = document.activeElement || document.body;
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
        }
        return { pressed: key, on: el.tagName.toLowerCase() };
      }, [p.key]);
    }

    case "eval": {
      const t = await resolveTab(p.tabId);
      const v = await run(t.id, (code) => {
        const r = eval(code);
        try { return JSON.parse(JSON.stringify(r ?? null)); } catch { return String(r); }
      }, [p.code]);
      return { tabId: t.id, result: v };
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
