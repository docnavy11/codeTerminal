/**
 * What the side panel adds around term.js — the extension's counterpart to
 * public/desktop.js. The panel has no room for two columns, so the terminal
 * and the session chooser are views the tabs swap in, the way the file
 * browser already is.
 *
 * Loaded after sidepanel.js, which reads PLATFORM.showView when a tab is
 * clicked. Until this file installs one the panel has its two-view behaviour,
 * which is still what the mobile page gets: /m loads sidepanel.js but not
 * term.js, so a phone keeps chat and files alone.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const VIEWS = ["chat", "shell", "sessions", "files"];
  const note = $("pnote");
  let view = "chat";

  const repaintNote = () => {
    // Only the shell view has anything to say here: which session it is in,
    // and where that session is.
    note.hidden = view !== "shell";
    if (view === "shell") note.textContent = TERMPANE.noteFor("shell");
  };

  PLATFORM.showView = (v) => {
    view = VIEWS.includes(v) ? v : "chat";
    const chat = view === "chat";
    $("log").hidden = !chat;
    document.querySelector("footer").hidden = !chat;
    $("files").hidden = view !== "files";
    $("term").hidden = view !== "shell";
    $("sessions").hidden = view !== "sessions";
    repaintNote();
    TERMPANE.showView(view);
  };
  /* sidepanel.js calls showFiles on hosts that only have the two views. This
     one has four, so it routes through the same switch. */
  PLATFORM.showFiles = (on) => PLATFORM.showView(on ? "files" : "chat");

  note.onclick = () => TERMPANE.detach();

  TERMPANE.init({
    repaintNote,
    selectShell: () => document.querySelector('.tabs .tab[data-view="shell"]')?.click(),
    onConfig: ({ shell, sessions }) => {
      // Tabs for what this server actually has. A server with CODETERM_SHELL=0
      // has no /pty route at all, and without tmux the chooser would 404 on
      // every button.
      const tab = (v) => document.querySelector(`.tabs .tab[data-view="${v}"]`);
      if (shell) tab("shell").hidden = false;
      if (sessions) tab("sessions").hidden = false;
    },
  });
})();
