/**
 * Extension implementation of the PLATFORM shim.
 *
 * sidepanel.js is shared verbatim with the mobile page at /m — the extension
 * loads it from disk (MV3 forbids remote code) and the server serves the same
 * file over http. Everything that differs between the two hosts lives here.
 */
/* No default: the popup is where the server address is set. An empty url
   makes the panel say so instead of dialling nowhere. */
async function serverUrl() {
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: "" });
  return serverUrl || "";
}

globalThis.PLATFORM = {
  name: "extension",

  /* The background worker holds the /ext URL; the session lives at /ws. */
  async wsUrl() {
    return (await serverUrl()).replace(/\/ext\/?$/, "/ws");
  },

  async httpBase() {
    return (await serverUrl()).replace(/^ws/, "http").replace(/\/ext\/?$/, "");
  },

  /* Which browser this panel sits in, so a conversation's browser tools act
     here and not in another browser that also has the extension open. */
  async instanceId() {
    const { instanceId } = await chrome.storage.local.get("instanceId");
    return instanceId ?? null;
  },

  openUrl(url) { chrome.tabs.create({ url }); },

  /* The chat this window's panel is on, keyed by window id: two windows keep
     two chats. Session storage — window ids do not outlive the browser. */
  async recallChat() {
    const w = await chrome.windows.getCurrent();
    const got = await chrome.storage.session.get(`chat:${w.id}`);
    return got[`chat:${w.id}`] ?? null;
  },
  async rememberChat(id) {
    const w = await chrome.windows.getCurrent();
    await chrome.storage.session.set({ [`chat:${w.id}`]: id });
  },

  tabLabel(on) { return on ? "tab" : "tab off"; },
  tabTitle: "Attach the active tab to each prompt",

  /* A right-click menu item stashes a prompt for the panel to claim once. */
  async takePendingPrompt() {
    try {
      const { pendingPrompt } = await chrome.storage.session.get("pendingPrompt");
      if (!pendingPrompt) return null;
      await chrome.storage.session.remove("pendingPrompt");
      return pendingPrompt;
    } catch { return null; }
  },

  /* A single-column host: the shared client swaps transcript for files itself.
     The desktop supplies a function here to put files in its right pane. */
  showFiles: null,
  onPendingPrompt(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "session" && changes.pendingPrompt?.newValue) cb();
    });
    cb();   // claim anything already waiting when the panel opens
  },
};
