/**
 * Appearance for the two full-page surfaces (manage.html, setup.html) and for
 * manage.html framed as the desktop's "manage" tab.
 *
 * The terminal (extension/sidepanel.js, "appearance, remembered per browser")
 * owns theme and text size and writes them to localStorage on this same
 * origin. These pages never had that logic of their own — pages.css matched
 * the terminal's *tokens*, but a manual theme override or an A+/A- text size
 * only ever reached whichever page set it. Reading the same two keys here is
 * what makes a full-page visit, or the embedded tab, agree with the terminal
 * around it rather than falling back to the OS theme and a fixed 13px root.
 *
 * The clamp mirrors sidepanel.js's MIN_FS/MAX_FS; a value outside it here
 * would mean the two files have drifted and one needs to change to match.
 *
 * `storage` fires in a document when a *different* same-origin context
 * changes localStorage — never the one that made the change. The terminal
 * itself has no listener; it is always the writer. This page (or an already-
 * loaded embedded frame) is always a reader, so it listens and repaints
 * rather than waiting to be reloaded.
 */
(() => {
  const MIN_FS = 9, MAX_FS = 20;
  const apply = () => {
    const fs = Math.min(MAX_FS, Math.max(MIN_FS, parseFloat(localStorage.getItem("ct.fs")) || 12));
    document.documentElement.style.fontSize = fs + "px";
    const theme = localStorage.getItem("ct.theme") || "auto";
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  };
  apply();
  addEventListener("storage", (e) => { if (!e.key || e.key === "ct.fs" || e.key === "ct.theme") apply(); });
})();
