/**
 * Desktop-only additions over the shared client (sidepanel.js): the xterm
 * pane on /pty and the draggable split. Everything else on this page — the
 * transcript, chats, files, prompts, settings — is the same code the Chrome
 * side panel and the mobile page run.
 */
const html = document.documentElement;
const cssVar = (n) => getComputedStyle(html).getPropertyValue(n).trim();

/* ---------------- terminal ---------------- */
const term = new Terminal({
  cursorBlink: true, scrollback: 5000, fontFamily: cssVar("--mono"),
  fontSize: Math.max(8, Math.round(parseFloat(getComputedStyle(html).fontSize) - 1)),
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.open(document.getElementById("term"));

function applyTermTheme() {
  term.options.theme = {
    background: cssVar("--code"), foreground: cssVar("--fg"), cursor: cssVar("--accent"),
    selectionBackground: cssVar("--sel"),
    black: cssVar("--line"), red: cssVar("--bad"), green: cssVar("--ok"), yellow: cssVar("--warn"),
    blue: cssVar("--accent"), magenta: "#bb9af7", cyan: "#7dcfe0", white: cssVar("--fg"),
  };
}
applyTermTheme();

let ptyWs, ptyRetry, ptyWasDown = false, ptySeen = 0;
/* A server started with CODETERM_SHELL=0 has no /pty route. Without asking
   first the page would dial it and retry every 3 s forever, so the pane is
   removed and the right side is the file browser alone. */
let shellOn = true;
const PTY_STALE_MS = 75_000;
/* The server beats every 30s on this socket too; silence past that is a dead
   connection the browser has not noticed. Drop it and dial again. */
function checkPtyLiveness(now = Date.now()) {
  if (!shellOn) return false;
  if (!ptyWs || ptyWs.readyState !== WebSocket.OPEN || !ptySeen || now - ptySeen < PTY_STALE_MS) return false;
  const dead = ptyWs; ptyWs = null; dead.onclose = null; dead.onmessage = null;
  try { dead.close(); } catch { /* half-open */ }
  ptyWasDown = true;
  term.write("\r\n\x1b[90m[connection lost — reconnecting…]\x1b[0m\r\n");
  connectShell();
  return true;
}
setInterval(() => checkPtyLiveness(), 15_000);
/* Which tmux session the terminal is attached to, or null for the throwaway
   shell. Reattaching after a drop must land on the same one, so it is held
   here rather than in the socket. */
let attachedTo = (() => { try { return sessionStorage.getItem("ct.session") || null; } catch { return null; } })();
const rememberSession = (n) => { try { n ? sessionStorage.setItem("ct.session", n) : sessionStorage.removeItem("ct.session"); } catch { /* private window */ } };
/* The attached session's current directory, for the header. Not remembered
   with the name: a session can `cd` while you are away, so it is read back
   from tmux rather than restored from a stale copy. */
let attachedPath = "";
async function connectShell() {
  clearTimeout(ptyRetry);
  const url = (await PLATFORM.wsUrl()).replace(/\/ws$/, "/pty");
  ptyWs = new WebSocket(url);
  ptyWs.binaryType = "arraybuffer";
  ptyWs.onopen = () => {
    ptySeen = Date.now();
    if (ptyWasDown) {
      ptyWasDown = false;
      term.write(attachedTo
        ? `\r\n\x1b[90m[reattached — ${attachedTo}]\x1b[0m\r\n`
        : "\r\n\x1b[90m[reconnected — new shell]\x1b[0m\r\n");
    }
    ptyWs.send(JSON.stringify({ type: "start", cols: term.cols, rows: term.rows, ...(attachedTo ? { session: attachedTo } : {}) }));
  };
  ptyWs.onmessage = (ev) => {
    ptySeen = Date.now();
    if (ev.data instanceof ArrayBuffer) { term.write(new Uint8Array(ev.data)); return; }
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === "exit") term.write(`\r\n\x1b[90m[shell exited (${m.code})]\x1b[0m\r\n`);
  };
  // The server closes the socket when the shell exits, and drops it on a
  // restart. Either way come back and start a fresh shell, the way the agent
  // socket does — this pane used to stay dead until the page was reloaded.
  ptyWs.onclose = () => {
    if (!ptyWasDown) term.write("\r\n\x1b[90m[disconnected — reconnecting…]\x1b[0m\r\n");
    ptyWasDown = true;
    ptyRetry = setTimeout(connectShell, 3000);
  };
}
term.onData((d) => { if (ptyWs?.readyState === WebSocket.OPEN) ptyWs.send(JSON.stringify({ type: "input", data: d })); });

const sendResize = () => {
  fit.fit();
  if (ptyWs?.readyState === WebSocket.OPEN) ptyWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
};
new ResizeObserver(sendResize).observe(document.getElementById("term"));
addEventListener("resize", sendResize);

// The shared client owns theme and text size: it writes data-theme and the root
// font-size onto <html>. Follow those rather than duplicating the controls.
new MutationObserver(() => {
  applyTermTheme();
  term.options.fontSize = Math.max(8, Math.round(parseFloat(getComputedStyle(html).fontSize) - 1));
  sendResize();
}).observe(html, { attributes: true, attributeFilter: ["data-theme", "style"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTermTheme);

/* ---------------- right pane: shell | files ---------------- */
const termEl = document.getElementById("term"), filesEl = document.getElementById("files");

const note = document.getElementById("rightnote");
let filesRoot = "";
// Called by the shared client's chat|files tabs; the transcript stays put.
const sessionsEl = document.getElementById("sessions");
PLATFORM.showFiles = (on) => PLATFORM.showView(on ? "files" : "shell");
/* Three views in one pane: the terminal (a throwaway shell, or a tmux session
   you attached to), the session chooser, and the file browser. */
PLATFORM.showView = (view) => {
  termEl.hidden = view !== "shell"; filesEl.hidden = view !== "files"; sessionsEl.hidden = view !== "sessions";
  note.textContent = view === "files" ? filesRoot
    : view === "sessions" ? "tmux sessions on this machine"
    : attachedTo ? sessionNote() : "no approval gate";
  // tmux knows where the session is now; the copy in hand may be old.
  if (view === "shell" && attachedTo) refreshAttachedPath();
  if (view === "sessions") loadSessions();
  if (view === "shell") sendResize();
};
fetch("/files/info").then((r) => r.json()).then((i) => { filesRoot = i.root ?? ""; }).catch(() => {});

/* ---------------- sessions: the tmux chooser ----------------
   These are the machine's sessions, not this app's. Anything tty (or you, in
   a real terminal) started is here too, with its working directory — one set
   of sessions, several front doors. Attaching points this pane's terminal at
   one; the session keeps running when you leave. */
/* "session: build · ~/projects/x". The directory is the pane's, so it is what
   the session is actually working on, not where it was started. */
const sessionNote = () => `session: ${attachedTo}` + (attachedPath ? ` · ${shortPath(attachedPath)}` : "");
/* Read the attached session's directory back from tmux and repaint the header
   if it moved. Quiet on failure: the header keeps the name, which is the part
   that matters. */
async function refreshAttachedPath() {
  const want = attachedTo;
  try {
    const found = (await sapi("/sessions")).sessions.find((s) => s.name === want);
    if (!found || attachedTo !== want) return;
    if (found.path === attachedPath) return;
    attachedPath = found.path;
    if (!termEl.hidden) note.textContent = sessionNote();
  } catch { /* the header keeps the name */ }
}
const slist = document.getElementById("slist"), snote = document.getElementById("snote"), snew = document.getElementById("snew");
let homeDir = "";
/* `~/projects/x`, and the middle dropped when it is long. The first attempt
   used direction:rtl to ellipsise the left, which moved the leading slash to
   the end: "home/dev/projects/x/". */
const shortPath = (p) => {
  let t = homeDir && p.startsWith(homeDir) ? "~" + p.slice(homeDir.length) : p;
  if (t.length > 46) { const parts = t.split("/"); t = parts.length > 3 ? `${parts[0]}/${parts[1]}/…/${parts[parts.length - 1]}` : "…" + t.slice(-44); }
  return t;
};
/* Not `ago`: desktop.js and the shared client are two plain scripts in one
   global scope, and sidepanel.js already has one — the page died on
   "Identifier 'ago' has already been declared" until this was renamed. */
const shortAgo = (ms) => {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const sfail = (msg) => { snote.textContent = msg; snote.className = "bad"; };
async function sapi(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}
function attach(name, path) {
  attachedTo = name; rememberSession(name); attachedPath = path ?? "";
  try { ptyWs?.close(); } catch { /* already gone */ }
  ptyWs = null;
  term.reset();
  connectShell();
  document.querySelector('.pane-hd .tab[data-view="shell"]')?.click();
}
function detach() {
  if (!attachedTo) return;
  attachedTo = null; rememberSession(null); attachedPath = "";
  try { ptyWs?.close(); } catch { /* already gone */ }
  ptyWs = null;
  term.reset();
  connectShell();
  PLATFORM.showView("shell");
}
function renderSessions(sessions) {
  slist.replaceChildren();
  snote.className = "";
  snote.textContent = `${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
  if (!sessions.length) {
    const e = document.createElement("div"); e.className = "empty";
    e.textContent = "No tmux sessions. Create one above; it keeps running when you close this tab.";
    slist.append(e); return;
  }
  for (const s of sessions) {
    const row = document.createElement("div");
    if (s.name === attachedTo) attachedPath = s.path;          // the list is a free, fresh reading
    row.className = "s" + (s.name === attachedTo ? " live" : "");
    row.title = `${s.name} · ${s.windows} window${s.windows === 1 ? "" : "s"} · created ${new Date(s.createdAt).toLocaleString()}`;
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = s.name;
    const cmd = document.createElement("span"); cmd.className = "cmd"; cmd.textContent = s.command;
    const pth = document.createElement("span"); pth.className = "pth"; pth.textContent = shortPath(s.path); pth.title = s.path;
    const when = document.createElement("span"); when.className = "when";
    when.textContent = (s.attached ? "● " : "") + shortAgo(s.activityAt);
    row.append(nm, cmd, pth, when);

    const ren = document.createElement("button"); ren.textContent = "rename";
    ren.onclick = async (e) => {
      e.stopPropagation();
      const to = prompt(`Rename "${s.name}" to`, s.name);
      if (!to || to === s.name) return;
      try {
        const body = await sapi(`/sessions/${encodeURIComponent(s.name)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: to }) });
        /* Before rendering, or the renamed row draws as not-attached — and
           `rememberSession` too, or a reload reattaches to a name that is gone
           and quietly opens a plain shell instead. The tmux client itself
           survives a rename, so the pane keeps running untouched. */
        if (attachedTo === s.name) { attachedTo = to; rememberSession(to); }   // renaming does not move the pane, so attachedPath stands
        renderSessions(body.sessions);
      } catch (err) { sfail(err.message); }
    };
    const kill = document.createElement("button"); kill.textContent = "kill";
    kill.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Kill "${s.name}"? Whatever is running in it stops.`)) return;
      try {
        renderSessions((await sapi(`/sessions/${encodeURIComponent(s.name)}`, { method: "DELETE" })).sessions);
        if (attachedTo === s.name) detach();
      } catch (err) { sfail(err.message); }
    };
    row.append(ren, kill);
    row.onclick = () => attach(s.name, s.path);
    slist.append(row);
  }
}
async function loadSessions() {
  try { renderSessions((await sapi("/sessions")).sessions); }
  catch (e) { slist.replaceChildren(); sfail(e.message); }
}
document.getElementById("srefresh").onclick = loadSessions;
document.getElementById("screate").onclick = async () => {
  const name = snew.value.trim();
  if (!name) { snew.focus(); return; }
  try {
    renderSessions((await sapi("/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })).sessions);
    snew.value = "";
    attach(name);
  } catch (e) { sfail(e.message); }
};
snew.onkeydown = (e) => { if (e.key === "Enter") document.getElementById("screate").click(); };
// A click on the note while attached is the way back to a plain shell.
note.onclick = () => { if (attachedTo) detach(); };
note.title = "click to leave the session and go back to a plain shell";

/* ---------------- draggable divider ---------------- */
const grip = document.getElementById("grip"), split = document.getElementById("split");
const left = document.getElementById("left"), right = document.getElementById("right");
grip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const pct = Math.min(85, Math.max(15, ((ev.clientX - split.getBoundingClientRect().left) / split.clientWidth) * 100));
    left.style.flex = `0 0 ${pct}%`; right.style.flex = "1 1 auto";
  };
  const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); sendResize(); };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
});

/* Ask what this server has before dialling: with CODETERM_SHELL=0 there is no
   /pty route, and the retry loop would knock on a 404 every three seconds. */
fetch("/config").then((r) => r.json()).then((c) => {
  shellOn = c.shell !== false;
  // No tmux on the server, no sessions tab: the chooser would have nothing to
  // choose and every button would 404.
  homeDir = c.home ?? "";
  if (shellOn && c.sessions) document.querySelector('.pane-hd .tab[data-view="sessions"]').hidden = false;
  // A reload comes back to the session this tab was on, not a fresh shell.
  if (!c.sessions) { attachedTo = null; rememberSession(null); }
  if (attachedTo) { note.textContent = sessionNote(); refreshAttachedPath(); }
  if (shellOn) { connectShell(); return; }
  document.querySelector('.pane-hd .tab[data-view="shell"]')?.remove();
  document.querySelector('.pane-hd .tab[data-view="sessions"]')?.remove();
  PLATFORM.showFiles(true);
  document.querySelector('.tabs .tab[data-view="files"]')?.classList.add("on");
  termEl.remove();
}).catch(() => connectShell());
sendResize();
