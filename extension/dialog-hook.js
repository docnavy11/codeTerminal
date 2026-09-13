/* Runs in the page's own world before its scripts (manifest content_scripts,
   document_start). Wraps alert/confirm/prompt so that the moment one opens,
   an event says so — the native dialog then blocks the page as it always did,
   and the worker can report it and answer it (handle_dialog). Nothing else
   about the dialogs changes: same look, same blocking, same return values. */
(() => {
  if (globalThis.__ctDialogHooked) return;
  globalThis.__ctDialogHooked = true;
  const tell = (name, detail) => { try { document.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* detached document */ } };
  for (const type of ["alert", "confirm", "prompt"]) {
    const native = window[type];
    if (typeof native !== "function") continue;
    window[type] = function (message, defaultValue) {
      tell("ct-dialog", { type, message: String(message ?? ""), defaultValue: type === "prompt" ? String(defaultValue ?? "") : undefined });
      try { return native.call(window, message, defaultValue); }
      finally { tell("ct-dialog-closed", { type }); }
    };
  }
})();
