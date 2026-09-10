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

let ptyWs, ptyRetry, ptyWasDown = false;
async function connectShell() {
  clearTimeout(ptyRetry);
  const url = (await PLATFORM.wsUrl()).replace(/\/ws$/, "/pty");
  ptyWs = new WebSocket(url);
  ptyWs.binaryType = "arraybuffer";
  ptyWs.onopen = () => {
    if (ptyWasDown) { ptyWasDown = false; term.write("\r\n\x1b[90m[reconnected — new shell]\x1b[0m\r\n"); }
    ptyWs.send(JSON.stringify({ type: "start", cols: term.cols, rows: term.rows }));
  };
  ptyWs.onmessage = (ev) => {
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
PLATFORM.showFiles = (on) => {
  termEl.hidden = on; filesEl.hidden = !on;
  note.textContent = on ? filesRoot : "no approval gate";
  if (!on) sendResize();
};
fetch("/files/info").then((r) => r.json()).then((i) => { filesRoot = i.root ?? ""; }).catch(() => {});

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

connectShell();
sendResize();
