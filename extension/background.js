/**
 * Dials the code-terminal server and executes whatever it asks.
 *
 * MV3 service workers are evicted after ~30s idle. Since Chrome 116, WebSocket
 * traffic resets that timer, so a ping every 20s is what keeps this alive.
 */
const DEFAULT_URL = "ws://devserver.tailnet-1234.ts.net:8123/ext";

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
const RECONNECT_MS = 3_000;
// Another browser's extension took the bridge. Retry rarely, so the two do not
// kick each other in a loop; whichever the user actually uses will win when the
// other's browser closes.
const DISPLACED_MS = 60_000;

let ws = null;
let pingTimer = null;
let enabled = true;
let serverUrl = DEFAULT_URL;

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
    ws?.close(1000, "server changed");
  }
});

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? "on" : "" });
  chrome.action.setBadgeBackgroundColor({ color: on ? "#7dcfa0" : "#f07178" });
}

function connect() {
  if (!enabled || (ws && ws.readyState <= 1)) return;
  try { ws = new WebSocket(serverUrl); } catch { return retry(); }

  ws.onopen = () => {
    setBadge(true);
    clearInterval(pingTimer);
    // Traffic on the socket is what keeps this service worker from eviction.
    pingTimer = setInterval(() => {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "ping" }));
    }, PING_MS);
  };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
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
// A backstop in case the socket dies while the worker is asleep.
chrome.alarms?.create("reconnect", { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener(() => {
  if (!enabled) return;
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
  if (!enabled || (obs && obs.readyState <= 1)) return;
  const url = (serverUrl || DEFAULT_URL).replace(/\/ext\/?$/, "/ws") + "?observe=1";
  try { obs = new WebSocket(url); } catch { return; }

  obs.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }

    if (m.kind === "status") {
      // "waiting for you" is the one that must not go unnoticed.
      if (m.state === "awaiting" && lastState !== "awaiting") {
        notify("Claude needs you", m.detail === "a question" ? "A question is waiting" : `Approve ${m.detail}?`);
      }
      if (lastState === "idle" && m.state !== "idle") turnStartedAt = Date.now();
      lastState = m.state;
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

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) throw new Error("no active tab");
  return t;
}
async function resolveTab(tabId) {
  return typeof tabId === "number" ? await chrome.tabs.get(tabId) : await activeTab();
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

    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId }));
    }

    case "read_page": {
      const t = await resolveTab(p.tabId);
      const max = p.maxChars ?? 20000;
      const body = await run(t.id, (m) => {
        const txt = document.body?.innerText ?? "";
        return { text: txt.length > m ? txt.slice(0, m) + "\n…[truncated]" : txt, chars: txt.length };
      }, [max]);
      return { tabId: t.id, title: t.title, url: t.url, ...body };
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
        const dataUrl = await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
        // Belt and braces: prove what we captured is what was asked for.
        const [visible] = await chrome.tabs.query({ active: true, windowId: t.windowId });
        if (visible?.id !== t.id) {
          throw new Error(`captured tab ${visible?.id} but tab ${t.id} was requested`);
        }
        return { tabId: t.id, url: t.url, dataUrl };
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
