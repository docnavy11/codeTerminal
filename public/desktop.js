/**
 * Desktop-only additions over the two shared scripts: the split, the
 * collapsing right pane, and which of terminal | sessions | files it shows.
 *
 * The transcript, chats, files, prompts and settings are sidepanel.js; the
 * terminal and the tmux chooser are term.js. Both are the same files the
 * Chrome side panel runs, served here as /m/app.js and /m/term.js.
 */
const termEl = document.getElementById("term"), filesEl = document.getElementById("files");
const sessionsEl = document.getElementById("sessions");
const note = document.getElementById("rightnote");
const refreshBtn = document.getElementById("rrefresh");
const railLabel = document.getElementById("rlabel");   // names the view the collapsed rail stands in for
let filesRoot = "";

// Called by the shared client's chat|files tabs; the transcript stays put.
PLATFORM.showFiles = (on) => PLATFORM.showView(on ? "files" : "shell");
/* Three views in one pane: the terminal (a throwaway shell, or a tmux session
   you attached to), the session chooser, and the file browser. */
let rightView = "shell";
/* The note belongs to this pane, not to term.js: only this host knows its
   files view puts a root path there. term.js asks for a repaint when the
   session moves underneath it. */
const repaintNote = () => { note.textContent = rightView === "files" ? filesRoot : TERMPANE.noteFor(rightView); };
PLATFORM.showView = (view) => {
  rightView = view;
  termEl.hidden = view !== "shell"; filesEl.hidden = view !== "files"; sessionsEl.hidden = view !== "sessions";
  repaintNote();
  TERMPANE.showView(view);
  if (railLabel) railLabel.textContent = view === "files" ? "files" : view === "sessions" ? "sessions" : "terminal";
  // ↻ redraws the terminal, so it is only offered while the terminal is up.
  if (refreshBtn) refreshBtn.hidden = view !== "shell";
};
fetch("/files/info").then((r) => r.json()).then((i) => { filesRoot = i.root ?? ""; }).catch(() => {});

/* ---------------- draggable divider, and collapsing either pane ----------------
   The terminal is not always what you want beside the conversation — reading a
   long reply on a laptop, it is half the screen doing nothing — and neither is
   the conversation, when you are working in the terminal and only want to see
   that Claude is still running. Either side collapses to a 26px rail naming
   what it stands in for, so getting it back is one click and you can still see
   which of the terminal's three views you left open.

   The pane is narrowed, never removed: xterm loses its scrollback when its
   element is detached, the session behind it keeps running either way, and the
   transcript comes back scrolled where you left it. */
const grip = document.getElementById("grip"), split = document.getElementById("split");
const left = document.getElementById("left"), right = document.getElementById("right");
const COLLAPSED = "ct.rightCollapsed", LEFT_COLLAPSED = "ct.leftCollapsed";
const SIDES = {
  right: { cls: "collapsed",  key: COLLAPSED,      btn: "rhide" },
  left:  { cls: "lcollapsed", key: LEFT_COLLAPSED, btn: "lhide" },
};
/* The divider writes inline flex on both panes. Collapsing has to put those
   aside and give them back, or an expanded pane returns to the width the drag
   left it at — which, after dragging the terminal wide, is the whole window.
   One stash for both sides: only one pane is ever collapsed at a time. */
let dragged = null;
function collapsePane(side, on, remember = true) {
  const me = SIDES[side], other = SIDES[side === "left" ? "right" : "left"];
  // Collapsing both would leave a window of two rails and nothing to read, so
  // the other side opens first — which is also what hands back the stashed
  // widths, before this one takes them aside again.
  if (on && split.classList.contains(other.cls)) collapsePane(side === "left" ? "right" : "left", false, remember);
  if (on && !dragged) { dragged = { left: left.style.flex, right: right.style.flex }; left.style.flex = ""; right.style.flex = ""; }
  split.classList.toggle(me.cls, on);
  document.getElementById(me.btn)?.setAttribute("aria-expanded", String(!on));
  if (!on && dragged) { left.style.flex = dragged.left; right.style.flex = dragged.right; dragged = null; }
  if (remember) { try { localStorage.setItem(me.key, on ? "1" : "0"); } catch { /* private window */ } }
  // Either move changes the terminal's width — collapsing the left widens it —
  // and a zero-size pane is refused inside sendResize() anyway.
  TERMPANE.sendResize();
}
const collapseRight = (on, remember = true) => collapsePane("right", on, remember);
const collapseLeft = (on, remember = true) => collapsePane("left", on, remember);
refreshBtn.onclick = () => { if (split.classList.contains("collapsed")) collapseRight(false); TERMPANE.refresh(); };
document.getElementById("rhide").onclick = () => collapseRight(true);
document.getElementById("rshow").onclick = () => collapseRight(false);
document.getElementById("lhide").onclick = () => collapseLeft(true);
document.getElementById("lshow").onclick = () => collapseLeft(false);
// The usual second way, and it stays the right pane's: the divider is beside
// the terminal, and a double-click there has meant "put that away" all along.
grip.addEventListener("dblclick", () => collapseRight(!split.classList.contains("collapsed")));
/* Restore at most one: a hand-edited localStorage with both set would
   otherwise paint two rails and no pane. Right wins, being the older key. */
/* A link that names a chat — the manage page's "open in the terminal", and the
   notification a scheduled run sends when it needs an answer — is a request to
   look at that conversation. Restoring a collapsed transcript over the top of
   it lands you on a 26px rail with the thing you came for hidden behind it,
   which is worst for the notification: its whole job is to put a card in front
   of you. So a named chat wins over the remembered state, this once. The
   preference is left alone; the next plain visit still comes back collapsed.

   The flag is read in index.html, before any script that could clear it:
   recallChat() strips the query string the moment it claims the chat, and it
   does that before this file is parsed. */
const askedForChat = globalThis.ASKED_FOR_CHAT === true;
try {
  if (localStorage.getItem(COLLAPSED) === "1") collapseRight(true, false);
  else if (!askedForChat && localStorage.getItem(LEFT_COLLAPSED) === "1") collapseLeft(true, false);
} catch { /* private window */ }
grip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const pct = Math.min(85, Math.max(15, ((ev.clientX - split.getBoundingClientRect().left) / split.clientWidth) * 100));
    left.style.flex = `0 0 ${pct}%`; right.style.flex = "1 1 auto";
  };
  const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); TERMPANE.sendResize(); };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
});

TERMPANE.init({
  note, repaintNote,
  selectShell: () => document.querySelector('.pane-hd .tab[data-view="shell"]')?.click(),
  onConfig: ({ shell, sessions }) => {
    // No tmux on the server, no sessions tab: the chooser would have nothing to
    // choose and every button would 404.
    if (sessions) document.querySelector('.pane-hd .tab[data-view="sessions"]').hidden = false;
    if (shell) return;
    document.querySelector('.pane-hd .tab[data-view="shell"]')?.remove();
    document.querySelector('.pane-hd .tab[data-view="sessions"]')?.remove();
    refreshBtn?.remove();            // nothing to redraw without a terminal
    PLATFORM.showFiles(true);
    document.querySelector('.tabs .tab[data-view="files"]')?.classList.add("on");
    termEl.remove();
  },
});
