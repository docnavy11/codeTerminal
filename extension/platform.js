/**
 * Extension implementation of the PLATFORM shim.
 *
 * sidepanel.js is shared verbatim with the mobile page at /m — the extension
 * loads it from disk (MV3 forbids remote code) and the server serves the same
 * file over http. Everything that differs between the two hosts lives here.
 */
const DEFAULT_EXT_URL = "ws://devserver.tailnet-1234.ts.net:8123/ext";

async function serverUrl() {
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: DEFAULT_EXT_URL });
  return serverUrl || DEFAULT_EXT_URL;
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

  onPendingPrompt(cb) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "session" && changes.pendingPrompt?.newValue) cb();
    });
    cb();   // claim anything already waiting when the panel opens
  },
};
