/* Isolated-world half of the dialog hook: carries the page's events to the
   worker. Sent before the native dialog blocks the page, so the worker knows
   what is open even while the tab cannot run scripts. */
const relay = (kind) => (e) => { try { chrome.runtime.sendMessage({ kind, ...(e.detail ?? {}) }); } catch { /* worker gone */ } };
document.addEventListener("ct-dialog", relay("dialog"));
document.addEventListener("ct-dialog-closed", relay("dialog-closed"));
