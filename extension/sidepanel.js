/**
 * The Claude session, in Chrome's side panel.
 *
 * Speaks the same /ws protocol as the web UI, so it is just another attached
 * client: the server broadcasts to every one of them. Open the web UI and the
 * side panel together and they stay in lockstep on the same conversation.
 *
 * No terminal here — a side panel is too narrow for one, and the shell lives
 * in the web UI.
 */

const $ = (id) => document.getElementById(id);
const log = $("log"), box = $("box"), dot = $("dot"), meta = $("meta");
const stop = $("stop"), modeSel = $("mode"), modelSel = $("model"), browserSel = $("browser");
/* Which browser this chat's tools act in. "auto" is the server's pick (the
   newest person's browser, never the server browser unless it is alone);
   the extension names its own; the server browser is the headless one on
   the machine. Hidden until there is a choice to make. */
let myBrowser = null, chosenBrowser = "";
function paintBrowsers(list) {
  if (!browserSel) return;
  const cur = chosenBrowser;
  browserSel.replaceChildren(new Option("auto", ""));
  for (const b of list) browserSel.append(new Option(b.server ? "server browser" : b.id === myBrowser ? "this browser" : `browser ${b.id.slice(0, 6)}`, b.id));
  if (cur && !list.some((b) => b.id === cur)) { chosenBrowser = ""; }
  browserSel.value = chosenBrowser;
  const show = list.length > 1 || (list.length === 1 && list[0].id !== myBrowser);
  browserSel.hidden = !show; const l = $("browserlbl"); if (l) l.hidden = !show;
}
if (browserSel) browserSel.onchange = () => { chosenBrowser = browserSel.value; ws?.send(JSON.stringify({ type: "browser", instance: chosenBrowser })); };
const statusEl = $("status"), statusText = $("statustext"), statusTime = $("statustime");

let cwdShown = "";
let streaming = null, streamRaw = "";
let ws = null, busy = false, lastText = null, lastRaw = "", cost = 0;
let statusSince = 0, statusTick = null, statusState = "idle";
let retry = null;

function el(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (curIndex >= 0) d.dataset.i = String(curIndex);
  if (text !== undefined) d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}
const setBusy = (v) => { busy = v; stop.disabled = !v; };
const renderMd = (t, raw) => { t.innerHTML = DOMPurify.sanitize(marked.parse(raw), { USE_PROFILES: { html: true } }); };

// Deltas arrive faster than frames. Rendering on every one re-parsed the whole
// accumulated reply per token — measured 3.2s of main-thread time for a 24KB
// reply. One render per frame is all the eye can use; the final "text" event
// renders the complete reply regardless.
/* Thinking: a dim, collapsed block above the reply showing the model's own
   progress note — "I've narrowed it to 20 candidates; now verifying each".
   The first line is always visible; click for the rest. It streams while it
   arrives. Measured on real transcripts: only ~1 block in 20 carries text
   (the API omits the rest and sends token counts), so the block appears when
   there is something to read and the counter in the status bar covers the
   rest. Plain text, never markdown: it is not addressed to you. */
let thinking = null, thinkRaw = "", thinkFrame = 0;
function thinkBlock() {
  const d = el("think");
  const head = document.createElement("div"); head.className = "th";
  const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▸";
  const lbl = document.createElement("span"); lbl.className = "lbl"; lbl.textContent = "thinking";
  const first = document.createElement("span"); first.className = "first";
  head.append(chev, lbl, first);
  const body = document.createElement("pre"); body.className = "tt";
  d.append(head, body);
  d.onclick = () => d.classList.toggle("open");
  return d;
}
function renderThink() {
  if (!thinking) return;
  const firstLine = (thinkRaw.split("\n").find((l) => l.trim()) ?? "").trim();
  thinking.querySelector(".first").textContent = firstLine;
  thinking.querySelector(".tt").textContent = thinkRaw;
  log.scrollTop = log.scrollHeight;
}
function scheduleThinkRender() {
  if (thinkFrame) return;
  thinkFrame = requestAnimationFrame(() => { thinkFrame = 0; renderThink(); });
}

let streamFrame = 0;
function scheduleStreamRender() {
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    if (!streaming) return;
    renderMd(streaming, streamRaw);
    log.scrollTop = log.scrollHeight;
  });
}

/* Everything platform-specific lives behind PLATFORM, defined by whichever
   host page loaded this file: the extension panel (chrome.* APIs) or the
   mobile page (plain URLs, since it is served by the server itself). The logic
   below is identical in both, which is why it is one file rather than two. */
/* Each window (extension) or tab (web) reattaches to the chat it was on, so a
   second window does not land on — and then act on — the first window's chat. */
async function agentUrl() {
  const url = await PLATFORM.wsUrl();
  if (!url) return url;
  const want = await PLATFORM.recallChat?.().catch(() => null);
  return want ? `${url}?chat=${encodeURIComponent(want)}` : url;
}

/* Liveness. The server beats every 30s; a socket that has been silent for
   longer than STALE_MS is dead even if the browser still calls it open — after
   a network drop the browser never learns, and this panel used to sit
   "connected" with nothing behind it until a reload. */
const STALE_MS = 75_000;
let lastSeen = 0;
function checkLiveness(now = Date.now()) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !lastSeen || now - lastSeen < STALE_MS) return false;
  const dead = ws; ws = null;
  dead.onclose = null; dead.onmessage = null;
  try { dead.close(); } catch { /* half-open: close may never complete; we have already moved on */ }
  dot.classList.remove("on"); meta.textContent = "reconnecting…"; setBusy(false);
  connect();
  return true;
}
setInterval(() => checkLiveness(), 15_000);

async function connect() {
  clearTimeout(retry);
  const url = await agentUrl();
  if (!url) {
    // The extension with no server set: say so once, and look again in a bit.
    meta.textContent = "no server configured";
    if (!log.querySelector(".welcome")) {
      const w = el("local welcome", "Set the server address first: right-click the extension icon → Options (or click it), enter ws://your-host:8123/ext and press Enter.");
      w.dataset.unconfigured = "1";
    }
    retry = setTimeout(connect, 3000);
    return;
  }
  log.querySelector(".welcome[data-unconfigured]")?.remove();
  ws = new WebSocket(url);

  ws.onopen = async () => {
    lastSeen = Date.now();
    dot.classList.add("on");
    meta.textContent = "";
    // The server replays the whole transcript on every attach. Without this
    // reset a reconnect (restart, sleep, wifi blip) appended the replay to what
    // was already on screen — measured: the transcript doubled each time.
    log.replaceChildren(); cost = 0; lastText = null; lastRaw = ""; streaming = null; streamRaw = ""; lastContext = null; paintContext();
    startReplay(); toolRows.clear(); tasks.clear(); todoBox = null; turnTools = 0; turnShots = 0;
    // Tell the server which browser this panel is in, so this conversation's
    // browser tools act here and not in another browser that is also open.
    try {
      const instanceId = await PLATFORM.instanceId();
      myBrowser = instanceId || null;
      if (chosenBrowser) ws.send(JSON.stringify({ type: "browser", instance: chosenBrowser }));
      else if (instanceId) { chosenBrowser = instanceId; ws.send(JSON.stringify({ type: "browser", instance: instanceId })); }
    } catch { /* no instance: the server falls back to the newest browser */ }
    flushQueued();
  };
  ws.onclose = () => {
    dot.classList.remove("on");
    meta.textContent = "reconnecting…";
    setBusy(false);
    retry = setTimeout(connect, 3000);           // the server may just be restarting
  };
  ws.onmessage = ({ data }) => {
    lastSeen = Date.now();
    let m; try { m = JSON.parse(data); } catch { return; }   // a bad frame is not worth a broken handler
    handle(m);
  };
}

/* Every replayed event is numbered as the server sends it, which is its index
   in the chat record — the same index search results point at. `el()` stamps
   the number on whatever the event renders, so a hit can be scrolled to. */
let replaying = false, eventIndex = 0, curIndex = -1, pendingJump = null;
function startReplay() { replaying = true; eventIndex = 0; curIndex = -1; }

function handle(m) {
  if (replaying) { curIndex = eventIndex++; if (m.kind === "replayed") replaying = false; }
  else curIndex = -1;
  switch (m.kind) {
    case "ping":     break;                              // liveness only; lastSeen was stamped above
    case "commands": COMMANDS = m.commands ?? []; break;
    case "chats":
      CHATS = m.chats ?? []; ACTIVE = m.activeId;
      if (ACTIVE) PLATFORM.rememberChat?.(ACTIVE)?.catch?.(() => {});
      if (clist.classList.contains("open")) renderChatList();
      break;
    case "cwd":
      cwdShown = m.path;
      meta.textContent = cwdShown.split("/").pop() || cwdShown;
      meta.title = cwdShown;
      break;
    case "project":
      // The panel has room for one word; the project name beats a cwd basename.
      if (m.name && m.name !== "General") { meta.textContent = m.name; meta.title = `Project: ${m.name} — ${cwdShown}`; }
      break;
    case "ready":
      if (!cwdShown) meta.textContent = String(m.model || "").replace(/\[1m\]$/, "");
      modeSel.querySelector('option[value="bypassPermissions"]').disabled = !m.canBypass;
      break;
    case "browsers": paintBrowsers(m.list ?? []); break;
    case "models": {
      // the CLI's list; keep "default" first and whatever is selected selected
      const cur = modelSel.value;
      modelSel.replaceChildren(new Option("default", ""));
      for (const mo of m.models ?? []) modelSel.append(new Option(mo.label, mo.value));
      if (cur && !modelSel.querySelector(`option[value="${CSS.escape(cur)}"]`)) modelSel.append(new Option(cur, cur));
      modelSel.value = cur;
      break;
    }
    case "model":
      if (m.model && !modelSel.querySelector(`option[value="${CSS.escape(m.model)}"]`)) modelSel.append(new Option(m.model, m.model));
      modelSel.value = m.model ?? "";
      break;
    case "cleared":  log.replaceChildren(); cost = 0; lastText = null; streaming = null; lastContext = null; paintContext(); startReplay(); toolRows.clear(); tasks.clear(); todoBox = null; turnTools = 0; turnShots = 0; break;
    case "replayed":
      lastText = null;
      if (!log.querySelector(".msg")) welcome();
      if (pendingJump) { jumpTo(pendingJump.i); pendingJump = null; }
      break;
    case "user": {
      log.querySelector(".welcome")?.remove();
      turnTools = 0; turnShots = 0;
      const u = el("msg user", m.text);
      if (m.uuid) {
        // Files the agent changed after this message can be put back to how
        // they were here — the CLI keeps a checkpoint per message.
        u.dataset.uuid = m.uuid;
        const rw = document.createElement("button"); rw.className = "rw"; rw.title = "Rewind files to before this message"; rw.textContent = "⟲";
        rw.onclick = (e) => { e.stopPropagation(); if (!busy) ws?.send(JSON.stringify({ type: "rewind", uuid: m.uuid, dryRun: true })); };
        u.append(rw);
      }
      if (m.images?.length) {
        const strip = document.createElement("div"); strip.className = "imgs";
        for (const im of m.images) { const img = document.createElement("img"); img.src = `data:${im.media_type};base64,${im.thumb}`; img.alt = "attached image"; strip.append(img); }
        u.append(strip);
      }
      if (m.context) { const c = el("ctx", "⌁ " + m.context.split("\n")[0]); c.title = m.context; }
      lastText = null;
      break;
    }
    case "local":    el("local", m.text); lastText = null; break;
    case "watch":    el("local", `⌁ watch fired — ${m.description}: ${m.detail}`); lastText = null; break;
    case "file":     fileCard(m); lastText = null; break;
    case "delta":
      if (!streaming) { streaming = el("msg md"); streamRaw = ""; }
      streamRaw += m.text;
      scheduleStreamRender();
      break;
    case "thinking_delta":
      if (!thinking) { thinking = thinkBlock(); thinkRaw = ""; }
      thinkRaw += m.text;
      scheduleThinkRender();
      break;
    case "thinking":
      // the finished block replaces whatever streamed (or stands alone on replay)
      if (!thinking) thinking = thinkBlock();
      thinkRaw = m.text; renderThink(); thinking = null; thinkRaw = "";
      break;
    case "text":
      if (m.parent) { subText(m); break; }
      if (streaming) { lastText = streaming; lastRaw = m.text; streaming = null; streamRaw = ""; }
      else if (lastText) lastRaw += "\n" + m.text;
      else { lastText = el("msg md"); lastRaw = m.text; }
      renderMd(lastText, lastRaw);
      log.scrollTop = log.scrollHeight;
      break;
    case "tool": {
      if (m.name === "AskUserQuestion") { lastText = null; break; }
      if (m.name === "TodoWrite") { todoList(m); turnTools++; lastText = null; break; }
      toolRow(m.id, m.name, m.input, m.parent);
      turnTools++; if (m.name === "mcp__browser__screenshot") turnShots++;
      lastText = null;
      break;
    }
    case "tool_result": toolResult(m); break;
    case "task": taskEvent(m); break;
    case "rewind": rewindCard(m); break;
    case "task_progress": taskProgress(m); break;
    case "approval":        renderApproval(m); break;
    case "question":        renderQuestion(m); break;
    case "approval_closed": {
      const c = log.querySelector(`[data-approval="${m.id}"]`);
      if (c) {
        c.classList.add("done");
        c.querySelectorAll("button,input").forEach((b) => (b.disabled = true));
        const label = { allow: "Approved", always: "Always allowed", deny: "Denied", gone: "Expired" }[m.decision] ?? "Closed";
        const h = c.querySelector("h4"); if (h) h.textContent = `${label} ${c.dataset.tool}`;
      }
      break;
    }
    case "mode":
      modeSel.value = m.mode;
      modeSel.classList.toggle("hot", m.mode === "bypassPermissions");
      modeSel.classList.toggle("warm", m.mode === "auto" || m.mode === "acceptEdits");
      break;
    case "status":   applyStatus(m); break;
    case "turn_end":
      // New records carry a per-turn cost (plus the session's running total);
      // records from before that carried the running total in costUsd, which
      // must not be summed — the last one is the figure.
      if (typeof m.costUsd === "number") cost = "sessionCostUsd" in m ? cost + m.costUsd : Math.max(cost, m.costUsd);
      if (m.context) { lastContext = m.context; paintContext(); }
      {
        const line = el("end", `${m.stopped ? `stopped: ${m.stopped}` : "done"}${m.denials ? ` · ${m.denials} denied` : ""} · $${cost.toFixed(4)} est.`);
        if (m.stopped) line.classList.add("stopped");
      }
      lastText = null; streaming = null; streamRaw = ""; thinking = null; thinkRaw = "";
      flushQueued();
      break;
    case "error":    el("msg err", m.message); break;
  }
}

/* A fresh chat used to be a blank pane. One dismissable card, never persisted,
   says what the pieces are; it goes away with the first message. */
function welcome() {
  if (log.querySelector(".welcome")) return;
  const w = el("local welcome");
  const lines = [
    "Ask anything below. Enter sends, Shift+Enter is a newline, / lists commands.",
    "Anything that changes files or runs commands stops for your approval — the mode menu (▾) sets how often you are asked.",
    PLATFORM.name === "extension"
      ? "\"tab\" attaches the page you are looking at as context; the extension's toggle is the off switch for browser control."
      : PLATFORM.name === "desktop"
        ? "The shell pane on the right is a real terminal with no approval gate; \"files\" browses, uploads and downloads."
        : "\"files\" browses, uploads and downloads. Add this page to your home screen to keep it.",
  ];
  for (const t of lines) { const p = document.createElement("p"); p.textContent = t; w.append(p); }
  const x = document.createElement("button"); x.textContent = "got it"; x.className = "dismiss";
  x.onclick = () => w.remove();
  const s = document.createElement("button"); s.textContent = "setup & status"; s.className = "dismiss";
  s.onclick = async () => PLATFORM.openUrl((await base()) + "/setup.html");
  w.append(x, document.createTextNode(" "), s);
}

/* ---------------- files the agent prepared ----------------
   A card with a download button — the agent calls files.offer when the
   result of the work is a file. Write rows and browser downloads get a small
   ⬇ too, when the file sits under the browsable root. */
function fileCard(m) {
  const card = el("filecard");
  const ic = document.createElement("span"); ic.className = "fi"; ic.textContent = "📎";
  const body = document.createElement("div"); body.className = "fb";
  const name = document.createElement("div"); name.className = "fn"; name.textContent = m.name;
  const meta = document.createElement("div"); meta.className = "fm"; meta.textContent = `${fmtSize(m.bytes)}${m.note ? ` · ${m.note}` : ""} · ${m.path}`;
  body.append(name, meta);
  const row = document.createElement("div"); row.className = "row";
  const dl = document.createElement("button"); dl.className = "allow"; dl.textContent = "Download";
  dl.onclick = (e) => { e.stopPropagation(); download(m.path, m.name); };
  const show = document.createElement("button"); show.textContent = "Show in files";
  show.onclick = (e) => { e.stopPropagation(); showInFiles(m.path); };
  row.append(dl, show);
  if (viewableInTab(m.name)) { const op = document.createElement("button"); op.textContent = "Open in tab"; op.onclick = (e) => { e.stopPropagation(); openInTab(m.path); }; row.append(op); }
  body.append(row);
  card.append(ic, body);
}
/* A viewer in a new tab. Markdown, CSV/TSV and JSON open in our own viewer
   page (rendered markdown, a grid, pretty JSON, with a Raw toggle); PDF, images,
   media and other text go to the browser's own viewer for the type, served
   inline with a sandboxing CSP. HTML and SVG come back as plain text, never as
   a page. */
const viewableInTab = (name) => /\.(pdf|png|jpe?g|gif|webp|bmp|txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|svg|js|ts|py|sh|toml|ini|mp4|webm|mp3|wav)$/i.test(name);
const ownViewer = (name) => /\.(md|markdown|csv|tsv|json)$/i.test(name);
async function openInTab(relPath) {
  const url = (await base()) + (ownViewer(relPath)
    ? `/view.html?path=${encodeURIComponent(relPath)}`
    : `/files/read?path=${encodeURIComponent(relPath)}&inline=1`);
  if (PLATFORM.name === "extension") PLATFORM.openUrl(url); else window.open(url, "_blank", "noopener");
}
function showInFiles(relPath) {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  document.querySelector('.tabs .tab[data-view="files"]')?.click();
  browse(dir);
}
/** A ⬇ chip on a tool row, for a file under the browsable root. `abs` may be absolute or already relative. */
async function fileChip(row, abs) {
  const rel = await cwdRelOf(abs);
  if (rel === null) return;
  const chip = document.createElement("button"); chip.className = "dlchip"; chip.textContent = "⬇"; chip.title = `Download ${rel}`;
  chip.onclick = (e) => { e.stopPropagation(); download(rel, rel.split("/").pop()); };
  row.querySelector(".tl")?.append(" ", chip);
}
async function cwdRelOf(p) {
  if (filesRootAbs === null) { try { filesRootAbs = (await fjson("/files/info")).root ?? ""; } catch { filesRootAbs = ""; } }
  if (!p || !filesRootAbs) return null;
  if (!p.startsWith("/")) return p;                       // already relative to the root
  if (p === filesRootAbs) return "";
  return p.startsWith(filesRootAbs + "/") ? p.slice(filesRootAbs.length + 1) : null;
}

/* ---------------- tool rows ----------------
   A call is one row: "→ name  what-it-was-asked" and, at the end of the line,
   what it returned — a number, a size, the first line of output — so the
   collapsed transcript already tells the story. Click to open the body.
   Errors open themselves. "…" means the result has not arrived. */
const toolRows = new Map();          // tool_use_id -> row
let turnTools = 0, turnShots = 0;    // this turn's roll-up, shown in the status bar

/* Where a row goes: the log, or — for a subagent's activity — the group
   under the Agent call it belongs to. Groups are collapsed with a count. */
function place(cls, parent) {
  const d = document.createElement("div"); d.className = cls;
  if (curIndex >= 0) d.dataset.i = String(curIndex);
  const g = parent ? subGroup(parent) : null;
  (g ?? log).append(d);
  if (g) g.parentElement.querySelector(".gh .n").textContent = `${g.children.length} step${g.children.length === 1 ? "" : "s"}`;
  else log.scrollTop = log.scrollHeight;
  return d;
}
function subGroup(parent) {
  const row = toolRows.get(parent);
  if (!row) return null;
  let g = row.querySelector(":scope > .grp > .gb");
  if (g) return g;
  const grp = document.createElement("div"); grp.className = "grp";
  const gh = document.createElement("div"); gh.className = "gh";
  const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▸";
  const n = document.createElement("span"); n.className = "n"; n.textContent = "0 steps";
  gh.append(chev, n);
  gh.onclick = (e) => { e.stopPropagation(); grp.classList.toggle("open"); };
  g = document.createElement("div"); g.className = "gb";
  grp.append(gh, g); row.append(grp);
  return g;
}
function subText(m) {
  const d = place("msg md sub", m.parent);
  renderMd(d, m.text);
}

/* ---------------- subagents ----------------
   An Agent call gets a task line under its row: "⧉ running · 3 tool uses ·
   42s · Grep" while it works, then "completed · <first line of its report>"
   (or failed / stopped). Its own steps are the collapsed group above. */
const tasks = new Map();   // task_id -> line element
function taskLine(m) {
  let line = tasks.get(m.id);
  if (line) return line;
  line = document.createElement("div"); line.className = "task";
  const st = document.createElement("span"); st.className = "ts";
  const tx = document.createElement("span"); tx.className = "tx";
  line.append("↳ agent · ", st, " ", tx);
  const row = m.toolUseId ? toolRows.get(m.toolUseId) : null;
  if (row) row.append(line); else { if (curIndex >= 0) line.dataset.i = String(curIndex); log.append(line); }
  tasks.set(m.id, line);
  return line;
}
function taskEvent(m) {
  const line = taskLine(m);
  const st = line.querySelector(".ts"), tx = line.querySelector(".tx");
  line.className = "task " + m.state;
  if (m.state === "running") { st.textContent = "running"; tx.textContent = m.description; return; }
  const stats = [m.toolUses ? `${m.toolUses} tool uses` : null, m.durationMs ? `${Math.round(m.durationMs / 1000)}s` : null].filter(Boolean).join(" · ");
  st.textContent = m.state + (stats ? ` · ${stats}` : "");
  tx.textContent = (m.summary ?? "").split("\n").find((l) => l.trim()) ?? "";
  if (m.summary && m.summary.includes("\n")) {
    const body = document.createElement("pre"); body.className = "tsum"; body.textContent = m.summary;
    line.append(body); line.onclick = (e) => { e.stopPropagation(); line.classList.toggle("open"); }; line.classList.add("has");
  }
}
function taskProgress(m) {
  const line = tasks.get(m.id); if (!line || !line.classList.contains("running")) return;
  line.querySelector(".ts").textContent = `running · ${m.toolUses} tool uses · ${Math.round(m.durationMs / 1000)}s${m.lastTool ? ` · ${m.lastTool}` : ""}`;
}

/* ---------------- rewind ----------------
   ⟲ on a user message asks for a dry run; the answer is a card under that
   message — what would be restored, or why it cannot be — with Restore /
   Cancel. Restore sends the real rewind; its answer closes the card and
   the server leaves a note in the transcript. */
function rewindCard(m) {
  const u = log.querySelector(`.msg.user[data-uuid="${CSS.escape(m.uuid)}"]`);
  if (!u) return;
  u.querySelector(":scope > .rwcard")?.remove();
  if (!m.dryRun) { if (!m.canRewind) { const n = document.createElement("div"); n.className = "rwcard err"; n.textContent = `Could not rewind: ${m.error ?? "unknown error"}`; u.append(n); } return; }
  const card = document.createElement("div"); card.className = "rwcard" + (m.canRewind ? "" : " err");
  if (!m.canRewind) { card.textContent = `Cannot rewind here: ${m.error ?? "no checkpoint for this message"}`; u.append(card); return; }
  const what = document.createElement("div"); what.className = "what";
  // paths come back absolute; show them relative to the chat's directory.
  const rel = (p) => (cwdShown && p.startsWith(cwdShown + "/")) ? p.slice(cwdShown.length + 1) : p;
  what.textContent = m.files.length
    ? `Restore ${m.files.length} file${m.files.length === 1 ? "" : "s"} to how they were before this message (+${m.insertions} −${m.deletions} lines): ${m.files.map(rel).join(", ")}`
    : "Nothing has changed since this message.";
  card.append(what);
  const row = document.createElement("div"); row.className = "row";
  if (m.files.length) {
    const ok = document.createElement("button"); ok.className = "allow"; ok.textContent = "Restore";
    ok.onclick = (e) => { e.stopPropagation(); ws?.send(JSON.stringify({ type: "rewind", uuid: m.uuid, dryRun: false })); card.querySelectorAll("button").forEach((b) => (b.disabled = true)); };
    row.append(ok);
  }
  const no = document.createElement("button"); no.textContent = m.files.length ? "Cancel" : "OK";
  no.onclick = (e) => { e.stopPropagation(); card.remove(); };
  row.append(no); card.append(row); u.append(card);
  card.onclick = (e) => e.stopPropagation();
}

/* ---------------- the todo list ----------------
   TodoWrite carries the whole list each time (per Claude Code's tool shape:
   todos[{content, status, activeForm}] — not seen on this box, so the render
   is defensive). One checklist per chat, updated in place; the row it sits
   in says "2/5 done". */
let todoBox = null;
function todoList(m) {
  const items = Array.isArray(m.input?.todos) ? m.input.todos : [];
  if (!todoBox || !todoBox.isConnected) { todoBox = el("todos"); }
  todoBox.replaceChildren();
  const done = items.filter((t) => t?.status === "completed").length;
  const h = document.createElement("div"); h.className = "th";
  h.textContent = `tasks · ${done}/${items.length} done`;
  todoBox.append(h);
  for (const t of items) {
    const li = document.createElement("div"); li.className = "ti " + (t?.status ?? "pending");
    const mark = t?.status === "completed" ? "✓" : t?.status === "in_progress" ? "▸" : "○";
    li.textContent = `${mark} ${t?.status === "in_progress" && t?.activeForm ? t.activeForm : (t?.content ?? "")}`;
    todoBox.append(li);
  }
  log.append(todoBox);   // the latest list sits at the bottom, where the eye is
  log.scrollTop = log.scrollHeight;
}

function toolRow(id, name, input, parent) {
  const d = place("tool", parent);
  const line = document.createElement("div"); line.className = "tl";
  const b = document.createElement("b"); b.textContent = name;
  line.append("→ ", b, " ", summarize(input));
  const res = document.createElement("span"); res.className = "tr pending"; res.textContent = "…";
  const chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▸";
  d.append(line, res, chev);
  d.onclick = () => { if (d.dataset.body) d.classList.toggle("open"); };
  if (id) toolRows.set(id, d);
  if ((name === "Write" || name === "Edit" || name === "MultiEdit") && typeof input?.file_path === "string") void fileChip(d, input.file_path);
  return d;
}

function toolResult(m) {
  if (m.name === "TodoWrite") return;                                     // the list itself is the result
  let d = toolRows.get(m.id);
  if (!d) { d = toolRow(null, m.name, {}, m.parent); d.classList.add("orphan"); }   // its call is gone (truncated, or a mid-turn attach)
  const res = d.querySelector(".tr");
  res.textContent = m.summary; res.className = "tr " + (m.ok ? "ok" : "err");
  // Browser tools say where they acted: "→ click  bank.example · Transfer"
  if (m.where && !d.querySelector(".where")) { const w = document.createElement("span"); w.className = "where"; w.textContent = m.where; w.title = m.where; d.querySelector(".tl").append(" ", w); }
  if (m.name === "mcp__browser__download" && m.ok) { try { const j = JSON.parse(m.text); if (typeof j.path === "string") void fileChip(d, j.path); } catch { /* not json */ } }
  res.title = m.bytes ? `${m.bytes.toLocaleString()} bytes${m.truncated ? ", truncated" : ""}` : "";
  const body = m.text || (m.ok ? "" : m.summary);
  if (body) {
    d.dataset.body = "1";
    const box = document.createElement("div"); box.className = "tb";
    const pre = document.createElement("pre"); pre.textContent = body + (m.truncated ? `\n…truncated (${(m.bytes / 1024).toFixed(0)} KB in full)` : "");
    const copy = document.createElement("button"); copy.className = "copy"; copy.textContent = "copy";
    copy.onclick = (e) => { e.stopPropagation(); navigator.clipboard?.writeText(body).then(() => { copy.textContent = "copied"; setTimeout(() => (copy.textContent = "copy"), 1200); }); };
    box.append(copy, pre); d.append(box);
    box.onclick = (e) => e.stopPropagation();
  } else {
    d.querySelector(".chev").textContent = "";
  }
  if (!m.ok) d.classList.add("open");
}

function summarize(input) {
  if (!input || typeof input !== "object") return "";
  for (const k of ["command", "file_path", "description", "pattern", "path", "url", "query"]) {
    if (typeof input[k] === "string" && input[k]) return input[k];
  }
  return JSON.stringify(input).slice(0, 100);
}

/* Context meter: what the next request re-sends against the model's window,
   from the last turn's usage. Amber at 70%, red at 90% — the moment to /clear
   or let compaction happen, which nothing used to tell you. */
let lastContext = null;
function paintContext() {
  let c = document.getElementById("ctx");
  if (!c) { c = document.createElement("span"); c.id = "ctx"; c.className = "ctx"; statusText.after(c); }
  if (!lastContext || !lastContext.window) { c.textContent = ""; c.className = "ctx"; return; }
  const pct = Math.min(999, Math.round(lastContext.tokens / lastContext.window * 100));
  c.textContent = `ctx ${pct}%`;
  c.title = `${lastContext.tokens.toLocaleString()} of ${lastContext.window.toLocaleString()} tokens will be re-sent on the next request`;
  c.className = "ctx" + (pct >= 90 ? " bad" : pct >= 70 ? " warn" : "");
}

/* "· 12 tools · 4 screenshots" — the counts that make a spiral visible at a glance. */
function rollup() {
  if (!turnTools) return "";
  return ` · ${turnTools} tool${turnTools === 1 ? "" : "s"}${turnShots ? ` · ${turnShots} screenshot${turnShots === 1 ? "" : "s"}` : ""}`;
}

function applyStatus(m) {
  if (m.state !== statusState || m.detail !== (statusEl.dataset.detail ?? "")) statusSince = Date.now();
  statusState = m.state;
  statusEl.dataset.detail = m.detail ?? "";

  statusEl.classList.toggle("busy",  ["thinking", "tool", "compacting"].includes(m.state));
  statusEl.classList.toggle("await", m.state === "awaiting");
  statusText.textContent = {
    idle:       "ready",
    thinking:   `thinking${m.tokens > 0 ? ` · ${m.tokens >= 1000 ? (m.tokens / 1000).toFixed(1) + "k" : m.tokens}` : ""}${rollup()}`,
    tool:       `running ${m.detail}${rollup()}`,
    compacting: "compacting",
    awaiting:   `waiting for you — ${m.detail === "ExitPlanMode" ? "the plan" : m.detail === "browser" ? "a site" : m.detail === "submit" ? "a form submit" : m.detail}`,
  }[m.state] ?? m.state;

  setBusy(m.state !== "idle");
  stop.disabled = m.state === "idle";
  box.placeholder = m.state === "idle" ? "Ask Claude…"
    : m.state === "awaiting" ? "Answer above, or Stop" : "working — Stop to interrupt";

  clearInterval(statusTick); statusTick = null; statusTime.textContent = "";
  if (m.state !== "idle") {
    const tick = () => {
      const s = Math.floor((Date.now() - statusSince) / 1000);
      statusTime.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
    };
    tick(); statusTick = setInterval(tick, 1000);
  }
}

/* Plan mode. In "plan" the agent only reads; when it has a plan it asks to
   leave planning through ExitPlanMode, and the plan itself is the thing to
   approve. So that card is the plan, rendered, with the three answers the
   TUI offers: build it (asking before changes), build it auto-accepting
   edits, or keep planning — the last sends the model back for a revision. */
function renderPlan(m) {
  const card = el("card plan");
  card.dataset.approval = m.id; card.dataset.tool = m.tool;
  const h = document.createElement("h4"); h.textContent = "Plan — approve to start building?";
  const body = document.createElement("div"); body.className = "planbody md";
  renderMd(body, typeof m.input?.plan === "string" ? m.input.plan : "(no plan text)");
  const row = document.createElement("div"); row.className = "row";
  const choices = [
    ["Build it", "allow", "allow", "default"],
    ["Build, auto-accept edits", "allow", "allow", "acceptEdits"],
    ["Keep planning", "deny", "deny", null],
  ];
  for (const [label, decision, cls, mode] of choices) {
    const b = document.createElement("button");
    b.textContent = label; b.className = cls; b.dataset.decision = decision; if (mode) b.dataset.mode = mode;
    b.onclick = () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "decision", id: m.id, decision, ...(mode ? { mode } : {}) }));
      card.querySelectorAll("button").forEach((x) => (x.disabled = true));
    };
    row.append(b);
  }
  card.append(h, body, row);
  log.scrollTop = log.scrollHeight;
}

/* A browser-site card: the agent wants to use a site this chat has not been
   allowed on. "Allow" is this chat; "Always" puts the site on the standing
   list. eval asks per call: "Allow once" / "Allow on this site (this chat)". */
function renderApproval(m) {
  if (m.tool === "ExitPlanMode") return renderPlan(m);
  if (m.tool === "submit") return renderSubmit(m);
  const site = m.tool === "browser";
  const card = el("card" + (site ? " site" : ""));
  card.dataset.approval = m.id; card.dataset.tool = m.tool;
  const h = document.createElement("h4");
  h.textContent = site
    ? (m.input?.action === "eval" ? `Run JavaScript on ${m.input.host}?`
      : m.input?.level === "act" ? `Let Claude act on ${m.input?.host || "this site"}?`
      : `Let Claude read ${m.input?.host || "this site"}?`)
    : `Approve ${m.tool}?`;
  const pre = m.diff ? renderDiff(m.diff) : document.createElement("pre");
  if (!m.diff) pre.textContent = site
    ? (m.input?.action === "eval" ? String(m.input.detail ?? "")
      : `${m.input?.action}${m.input?.detail ? ` → ${m.input.detail}` : ""} — ${m.input?.level === "act" ? "clicks, types or navigates in your logged-in browser (reading is included)" : "reads the page in your logged-in browser; acting on it will ask again"}`)
    : typeof m.input?.command === "string" ? m.input.command : JSON.stringify(m.input, null, 2);
  const row = document.createElement("div");
  row.className = "row";
  const choices = site
    ? (m.input?.action === "eval"
      ? [["Allow once", "allow", "allow"], ["Allow on this site (this chat)", "always", "allow"], ["Deny", "deny", "deny"]]
      : [["Allow (this chat)", "allow", "allow"], ["Always (this site)", "always", "allow"], ["Deny", "deny", "deny"]])
    : [["Approve", "allow", "allow"], ["Deny", "deny", "deny"]];
  if (!site && m.canAlways) choices.splice(1, 0, ["Always", "always", "allow"]);
  for (const [label, decision, cls] of choices) {
    const b = document.createElement("button");
    b.textContent = label; b.className = cls;
    // "Always" carries the .allow class too, so styling keys off the decision.
    b.dataset.decision = decision;
    b.onclick = () => {
      if (ws?.readyState !== WebSocket.OPEN) return;   // reconnecting: the server will re-ask
      ws.send(JSON.stringify({ type: "decision", id: m.id, decision }));
      card.querySelectorAll("button").forEach((x) => (x.disabled = true));
    };
    row.append(b);
  }
  card.append(h, pre, row);
  log.scrollTop = log.scrollHeight;
}

/* Confirm before submit: a click or Enter is about to send a form with
   filled fields. Where it goes, which button, what is in it — then Submit
   or Stop. No "always": every submit is worth a look. */
function renderSubmit(m) {
  const d = m.input || {};
  const card = el("card submit");
  card.dataset.approval = m.id; card.dataset.tool = "submit";
  const h = document.createElement("h4");
  h.textContent = `Submit this form on ${d.host || "this site"}?`;
  const pre = document.createElement("pre");
  let path = d.action || "";
  try { const u = new URL(d.action); path = u.pathname + u.search; } catch { /* keep */ }
  const lines = [`${String(d.method || "get").toUpperCase()} ${path}${d.button ? ` · button "${d.button}"` : ""}${d.via === "enter" ? " · via Enter" : ""}`];
  for (const f of d.fields || []) lines.push(`${f.name}: ${f.value}`);
  if (!(d.fields || []).length) lines.push("(no fields filled)");
  pre.textContent = lines.join("\n");
  const row = document.createElement("div"); row.className = "row";
  for (const [label, decision, cls] of [["Submit", "allow", "allow"], ["Stop", "deny", "deny"]]) {
    const b = document.createElement("button"); b.textContent = label; b.className = cls; b.dataset.decision = decision;
    b.onclick = () => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "decision", id: m.id, decision }));
      card.querySelectorAll("button").forEach((x) => (x.disabled = true));
    };
    row.append(b);
  }
  card.append(h, pre, row);
  log.scrollTop = log.scrollHeight;
}

/* The change an Edit/Write would make, as a diff: path and +/− counts on
   top, then the lines — context dim, removed red, added green, with a "line
   N" marker at each hunk. A note replaces the lines when there is no diff to
   show (file missing, old_string not found, too large). */
function renderDiff(d) {
  const box = document.createElement("div"); box.className = "diff";
  const head = document.createElement("div"); head.className = "dh";
  const p = document.createElement("span"); p.className = "dp"; p.textContent = d.path;
  const k = document.createElement("span"); k.className = "dk";
  k.textContent = d.kind === "create" ? "new file" : d.kind === "write" ? "rewrite" : "edit";
  const c = document.createElement("span"); c.className = "dc";
  c.append(Object.assign(document.createElement("span"), { className: "add", textContent: `+${d.adds}` }), " ",
           Object.assign(document.createElement("span"), { className: "del", textContent: `−${d.dels}` }));
  head.append(p, k, c); box.append(head);
  if (d.note) { const n = document.createElement("div"); n.className = "dn"; n.textContent = d.note; box.append(n); }
  if (d.lines.length) {
    const pre = document.createElement("pre"); pre.className = "dl";
    for (const l of d.lines) {
      const row = document.createElement("span"); row.className = "l " + ({ "+": "add", "-": "del", "@": "hunk" }[l.t] ?? "ctx");
      row.textContent = (l.t === "@" ? "… " : l.t + " ") + l.s + "\n";
      pre.append(row);
    }
    if (d.truncated) pre.append(Object.assign(document.createElement("span"), { className: "l hunk", textContent: "… diff truncated\n" }));
    box.append(pre);
  }
  return box;
}

function renderQuestion(m) {
  const card = el("q");
  card.dataset.approval = m.id; card.dataset.tool = "question";
  const picked = new Map();

  for (const q of m.questions) {
    picked.set(q.question, new Set());
    const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = q.header || "question";
    const title = document.createElement("p"); title.className = "qt"; title.textContent = q.question;
    card.append(chip, title);

    for (const o of [...q.options, { label: "Other", description: "Type your own", other: true }]) {
      const b = document.createElement("button");
      b.className = "opt"; b.type = "button";
      b.append(document.createTextNode(o.label));
      if (o.description) {
        const d = document.createElement("span"); d.className = "d"; d.textContent = o.description; b.append(d);
      }
      let other = null;
      b.onclick = () => {
        const set = picked.get(q.question);
        if (!q.multiSelect) {
          set.clear();
          card.querySelectorAll(".opt").forEach((x) => x.classList.remove("sel"));
        }
        b.classList.toggle("sel");
        if (b.classList.contains("sel")) {
          if (o.other) {
            if (!other) {
              other = document.createElement("input");
              other.className = "other"; other.placeholder = "your answer…";
              other.oninput = () => { set.clear(); if (other.value.trim()) set.add(other.value.trim()); };
              b.after(other);
            }
            other.focus();
          } else set.add(o.label);
        } else {
          set.delete(o.label);
          if (other) { other.remove(); other = null; }
        }
      };
      card.append(b);
    }
  }

  const send = document.createElement("button");
  send.textContent = "Answer"; send.className = "allow"; send.style.marginTop = "6px";
  send.onclick = () => {
    const answers = {};
    for (const [q, set] of picked) if (set.size) answers[q] = [...set].join(", ");
    if (!Object.keys(answers).length) return;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "answer", id: m.id, answers }));
    card.querySelectorAll("button,input").forEach((x) => (x.disabled = true));
    card.classList.add("done");
  };
  card.append(send);
  log.scrollTop = log.scrollHeight;
}

let COMMANDS = [];
const menu = $("menu");
let matches = [], sel = 0;

/** Only while the whole box is a single "/word" — not mid-sentence. */
function currentQuery() {
  const v = box.value;
  if (!v.startsWith("/") || /\s/.test(v)) return null;
  return v.slice(1).toLowerCase();
}

/* @file: the "@fragment" the caret is in, anywhere in the text. */
function atQuery() {
  const before = box.value.slice(0, box.selectionStart ?? box.value.length);
  const m = before.match(/(?:^|\s)@([^\s@]*)$/);
  return m ? { frag: m[1], start: before.length - m[1].length - 1 } : null;
}

/* The chat's cwd relative to the files root, for /files/suggest. Both are
   absolute on the server; the root arrives with /files/info. */
let filesRootAbs = null;
async function cwdRel() {
  if (filesRootAbs === null) { try { filesRootAbs = (await fjson("/files/info")).root ?? ""; } catch { filesRootAbs = ""; } }
  if (!cwdShown || !filesRootAbs) return null;
  if (cwdShown === filesRootAbs) return "";
  if (cwdShown.startsWith(filesRootAbs + "/")) return cwdShown.slice(filesRootAbs.length + 1);
  return null;   // outside the browsable root: nothing to offer
}

let atTimer = null, atSeq = 0;
function refreshAtMenu(at) {
  clearTimeout(atTimer);
  atTimer = setTimeout(async () => {
    const seq = ++atSeq;
    const rel = await cwdRel();
    if (rel === null) { matches = []; menu.classList.remove("open"); return; }
    let files = [];
    try { files = (await fjson(`/files/suggest?path=${encodeURIComponent(rel)}&q=${encodeURIComponent(at.frag)}`)).files; } catch { return; }
    if (seq !== atSeq || !atQuery()) return;
    matches = files.map((f) => ({ name: f.path + (f.dir ? "/" : ""), description: f.dir ? "directory" : "", file: true, start: at.start }));
    paintMenu("@");
  }, 120);
}

function paintMenu(prefix) {
  if (!matches.length) { menu.classList.remove("open"); return; }
  sel = Math.min(sel, matches.length - 1);
  menu.replaceChildren(...matches.map((c, i) => {
    const d = document.createElement("div");
    d.className = "item" + (i === sel ? " sel" : "");
    const n = document.createElement("span"); n.className = "n"; n.textContent = prefix + c.name;
    d.appendChild(n);
    if (c.argumentHint) {
      const h = document.createElement("span"); h.className = "h"; h.textContent = c.argumentHint; d.appendChild(h);
    }
    const de = document.createElement("span"); de.className = "d"; de.textContent = c.description || "";
    d.appendChild(de);
    d.onmousedown = (e) => { e.preventDefault(); pick(i); };
    return d;
  }));
  menu.classList.add("open");
  menu.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}

function refreshMenu() {
  const at = atQuery();
  if (at) { refreshAtMenu(at); return; }
  const q = currentQuery();
  if (q === null) { menu.classList.remove("open"); matches = []; return; }
  matches = COMMANDS.filter(c =>
    c.name.toLowerCase().startsWith(q) ||
    (c.aliases ?? []).some(a => a.toLowerCase().startsWith(q))).slice(0, 60);
  paintMenu("/");
}

function pick(i) {
  const c = matches[i];
  if (!c) return;
  if (c.file) {
    // replace the "@fragment" under the caret with "@path" (a directory keeps the menu open to go deeper)
    const caret = box.selectionStart ?? box.value.length;
    const tail = c.name.endsWith("/") ? "" : " ";
    box.value = box.value.slice(0, c.start) + "@" + c.name + tail + box.value.slice(caret);
    const pos = c.start + 1 + c.name.length + tail.length;
    box.setSelectionRange(pos, pos);
    menu.classList.remove("open"); matches = [];
    box.focus();
    if (!tail) refreshMenu();
    return;
  }
  box.value = "/" + c.name + (c.argumentHint ? " " : "");
  menu.classList.remove("open");
  matches = [];
  box.focus();
  if (!c.argumentHint) sendBox();
}

/* ---------------- images in the prompt ----------------
   Paste (Ctrl/Cmd+V), drop onto the composer or the transcript, or the 📎
   button. Each image is downscaled here — to the API's recommended 1568px
   on the long side, as JPEG unless it has transparency — and a 160px
   thumbnail is made for the transcript, so the chat file never holds the
   full picture. Up to MAX_ATTACH per prompt; the strip above the box shows
   what is attached, ✕ removes one. */
const MAX_ATTACH = 4, LONG_SIDE = 1568, THUMB = 160;
let attachments = [];          // [{ media_type, data, thumb }]
const strip = document.createElement("div"); strip.id = "attach-strip"; strip.hidden = true;
box.parentElement.insertBefore(strip, box);

function paintAttachments() {
  strip.replaceChildren();
  strip.hidden = attachments.length === 0;
  attachments.forEach((a, i) => {
    const w = document.createElement("span"); w.className = "att";
    const img = document.createElement("img"); img.src = `data:${a.media_type};base64,${a.thumb}`; img.alt = "";
    const x = document.createElement("button"); x.className = "x"; x.textContent = "✕"; x.title = "Remove";
    x.onclick = () => { attachments.splice(i, 1); paintAttachments(); };
    w.append(img, x); strip.append(w);
  });
}

async function addImages(files) {
  for (const f of files) {
    if (!f || !/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) continue;
    if (attachments.length >= MAX_ATTACH) { meta.textContent = `at most ${MAX_ATTACH} images`; break; }
    try { attachments.push(await encodeImage(f)); } catch (e) { meta.textContent = `image skipped: ${e.message}`; }
  }
  paintAttachments();
}

async function encodeImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, LONG_SIDE / Math.max(bmp.width, bmp.height));
  const keepPng = file.type === "image/png" || file.type === "image/gif" || file.type === "image/webp";
  const full = draw(bmp, Math.round(bmp.width * scale), Math.round(bmp.height * scale), keepPng ? "image/png" : "image/jpeg", 0.85);
  const ts = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
  const thumb = draw(bmp, Math.max(1, Math.round(bmp.width * ts)), Math.max(1, Math.round(bmp.height * ts)), "image/jpeg", 0.7);
  bmp.close?.();
  // a PNG that came out huge is better as JPEG (a photo pasted as PNG)
  const final = full.data.length > 2_500_000 && keepPng ? draw(await createImageBitmap(file), Math.round(bmp.width * scale), Math.round(bmp.height * scale), "image/jpeg", 0.85) : full;
  return { media_type: final.type, data: final.data, thumb: thumb.data };
}
function draw(bmp, w, h, type, q) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d").drawImage(bmp, 0, 0, w, h);
  const url = c.toDataURL(type, q);
  return { type: url.slice(5, url.indexOf(";")), data: url.slice(url.indexOf(",") + 1) };
}

box.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault(); addImages(files);
});
for (const target of [box, log]) {
  target.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types ?? [])].includes("Files")) { e.preventDefault(); target.classList.add("drop"); } });
  target.addEventListener("dragleave", () => target.classList.remove("drop"));
  target.addEventListener("drop", (e) => {
    target.classList.remove("drop");
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    e.preventDefault(); addImages(files);
  });
}
const attachBtn = $("attach"), attachPick = $("attachpick");
if (attachBtn && attachPick) {
  attachBtn.onclick = () => attachPick.click();
  attachPick.onchange = () => { addImages([...attachPick.files]); attachPick.value = ""; };
}

function sendBox() {
  const text = box.value.trim();
  if ((!text && !attachments.length) || busy) return;
  // While the socket is down the prompt is queued and goes out on reconnect.
  // It used to be dropped silently — the box kept the text, nothing happened.
  submit(text, attachments);
  attachments = []; paintAttachments();
  box.value = ""; box.style.height = "auto";
  menu.classList.remove("open"); matches = [];
  lastText = null;
}

box.addEventListener("keydown", (e) => {
  if (menu.classList.contains("open") && matches.length) {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % matches.length; refreshMenu(); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); sel = (sel - 1 + matches.length) % matches.length; refreshMenu(); return; }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); pick(sel); return; }
    if (e.key === "Escape")    { menu.classList.remove("open"); matches = []; return; }
  }
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  sendBox();
});

box.addEventListener("input", () => {
  box.style.height = "auto";
  box.style.height = Math.min(box.scrollHeight, 130) + "px";
  sel = 0;
  refreshMenu();
});
box.addEventListener("blur", () => setTimeout(() => menu.classList.remove("open"), 120));

stop.onclick = () => ws?.send(JSON.stringify({ type: "interrupt" }));
$("newchat").onclick = () => ws?.send(JSON.stringify({ type: "new" }));
// A 400px column is the wrong place to curate; open the manage page in a tab.
$("manage").onclick = async () => PLATFORM.openUrl((await base()) + "/manage.html");
$("setup").onclick = async () => PLATFORM.openUrl((await base()) + "/setup.html");
// The panel has no terminal and no split view; the full UI does.
$("openui").onclick = async () => PLATFORM.openUrl((await base()) + "/");
modeSel.onchange = () => ws?.send(JSON.stringify({ type: "mode", mode: modeSel.value }));
modelSel.onchange = () => ws?.send(JSON.stringify({ type: "model", model: modelSel.value }));

/* ---- appearance, remembered per browser --------------------------------- */
const MIN_FS = 9, MAX_FS = 20;
const clampFs = (n) => Math.min(MAX_FS, Math.max(MIN_FS, n));
let fontSize = clampFs(parseFloat(localStorage.getItem("ct.fs")) || 12);
let theme = localStorage.getItem("ct.theme") || "auto";

function applyFontSize() {
  document.documentElement.style.fontSize = fontSize + "px";
  localStorage.setItem("ct.fs", String(fontSize));
}
function applyTheme() {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("ct.theme", theme);
  $("theme").textContent = theme;
}
$("fsup").onclick   = () => { fontSize = clampFs(fontSize + 1); applyFontSize(); };
/* Settings menu. Theme, text size, the full UI and manage are all set-once
   controls; they used to spend permanent bar space, two of them as an
   unlabelled arrow and cog. One click to reach, real words when you get there. */
/* Which bar controls actually get used — see the note in public/index.html.
   Local only: it posts to your own server, nowhere else. */
document.querySelector("header").addEventListener("click", async (e) => {
  const el = e.target.closest("[id]");
  if (!el || el.id === "moremenu") return;
  try {
    await fetch((await base()) + "/usage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ control: el.id }),
    });
  } catch { /* counting must never break the panel */ }
}, true);   // Capture: #chats, #more and the menu all stopPropagation(), so a
           // listener on the bubble phase would never see the clicks it counts.

const moreBtn = $("more"), moreMenu = $("moremenu");
function closeMore() { moreMenu.hidden = true; moreBtn.setAttribute("aria-expanded", "false"); }
moreBtn.onclick = (e) => {
  e.stopPropagation();
  const open = moreMenu.hidden;
  moreMenu.hidden = !open;
  moreBtn.setAttribute("aria-expanded", String(open));
};
// A menu item that navigates should close; a toggle inside it should not.
moreMenu.onclick = (e) => { if (e.target.closest(".mitem")) closeMore(); else e.stopPropagation(); };
document.addEventListener("click", closeMore);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMore(); });

$("fsdown").onclick = () => { fontSize = clampFs(fontSize - 1); applyFontSize(); };
$("theme").onclick  = () => { theme = { auto: "light", light: "dark", dark: "auto" }[theme]; applyTheme(); };

let withTab = localStorage.getItem("ct.tab") !== "0";
function paintTab() {
  // On a phone there is no local tab: the server resolves the active tab from
  // whichever browser has the extension connected, so the label says whose.
  $("tabctx").textContent = PLATFORM.tabLabel(withTab);
  $("tabctx").title = PLATFORM.tabTitle;
  $("tabctx").classList.toggle("off", !withTab);
  localStorage.setItem("ct.tab", withTab ? "1" : "0");
}
$("tabctx").onclick = () => { withTab = !withTab; paintTab(); };

/* ---------------- switching conversation ---------------- */
const clist = $("clist");
let CHATS = [], ACTIVE = null, chatFilter = "";

const ago = (ms) => {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

function renderChatList() {
  // Positioned from the header's real height rather than a guess, since the
  // header wraps differently at different widths and font sizes.
  clist.style.top = `${document.querySelector("header").getBoundingClientRect().bottom + 4}px`;
  clist.replaceChildren();
  const find = document.createElement("div");
  find.className = "cfind";
  const q = Object.assign(document.createElement("input"),
    { placeholder: "Filter conversations…", value: chatFilter });
  q.oninput = () => { chatFilter = q.value; renderChatList(); q.focus(); };
  find.append(q);
  clist.append(find);

  const shown = CHATS.filter((c) => !chatFilter ||
    c.title.toLowerCase().includes(chatFilter.toLowerCase()));
  if (!shown.length && chatFilter.trim().length < 2) {
    clist.append(Object.assign(document.createElement("div"),
      { className: "empty", textContent: "Nothing matches." }));
  }
  if (chatFilter.trim().length >= 2) scheduleSearch(chatFilter);

  for (const c of shown) {
    const row = document.createElement("div");
    row.className = "c" + (c.id === ACTIVE ? " on" : "");
    const t = document.createElement("span");
    t.className = "ct"; t.textContent = c.title; t.title = c.title;
    const w = document.createElement("span");
    w.className = "cw"; w.textContent = `${c.turns}· ${ago(c.updatedAt)}`;
    row.append(t, w);

    for (const [label, fn] of [
      ["✎", () => {
        const nt = prompt("Rename this conversation", c.title);
        if (nt?.trim()) ws?.send(JSON.stringify({ type: "rename", id: c.id, title: nt.trim() }));
      }],
      ["✕", () => {
        if (confirm(`Delete "${c.title}"?`)) ws?.send(JSON.stringify({ type: "delete", id: c.id }));
      }],
    ]) {
      const b = document.createElement("span");
      b.className = "ca"; b.textContent = label;
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      row.append(b);
    }

    // Switches this panel only — another browser keeps whatever it is on.
    row.onclick = () => {
      closeChats();
      if (c.id !== ACTIVE) ws?.send(JSON.stringify({ type: "open", id: c.id }));
    };
    clist.append(row);
  }
  clist.classList.add("open");
}

/* Full-text search of every transcript, under the title matches. Debounced;
   a hit opens the chat and scrolls to the matching message. */
let searchTimer = null, searchSeq = 0;
function scheduleSearch(q) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    let hits = [];
    try { hits = (await fjson(`/chats/search?q=${encodeURIComponent(q)}`)).hits; } catch { return; }
    if (seq !== searchSeq || chatFilter !== q || !clist.classList.contains("open")) return;   // stale
    clist.querySelector(".csearch")?.remove();
    const box = document.createElement("div"); box.className = "csearch";
    const withText = hits.filter((h) => h.matches.length);
    const head = document.createElement("div"); head.className = "cshead";
    head.textContent = withText.length ? `in transcripts — ${withText.length} chat${withText.length === 1 ? "" : "s"}` : "nothing in transcripts";
    box.append(head);
    for (const h of withText) {
      for (const mt of h.matches) {
        const row = document.createElement("div"); row.className = "c hit";
        const t = document.createElement("span"); t.className = "ct"; t.textContent = h.title; t.title = h.title;
        const s = document.createElement("span"); s.className = "cs"; s.textContent = mt.snippet;
        row.append(t, s);
        row.onclick = () => {
          closeChats();
          pendingJump = { id: h.id, i: mt.i };
          if (h.id === ACTIVE) { jumpTo(mt.i); pendingJump = null; }
          else ws?.send(JSON.stringify({ type: "open", id: h.id }));
        };
        box.append(row);
      }
    }
    clist.append(box);
  }, 250);
}
function jumpTo(i) {
  const t = log.querySelector(`[data-i="${i}"]`);
  if (!t) return;
  t.scrollIntoView({ block: "center" });
  t.classList.add("flash");
  setTimeout(() => t.classList.remove("flash"), 2500);
}

/* Export the current chat as Markdown. Same-origin pages stream it as a
   download; the extension fetches it into a blob like any other file. */
async function exportChat() {
  if (!ACTIVE) return;
  const url = (await base()) + `/chats/${ACTIVE}/export.md`;
  if (sameOrigin()) { const a = document.createElement("a"); a.href = url; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); return; }
  const r = await fetch(url);
  if (!r.ok) return;
  const name = (r.headers.get("content-disposition") ?? "").match(/filename="([^"]+)"/)?.[1] ?? "chat.md";
  saveBlob(await r.blob(), name);
}
$("export").onclick = exportChat;

const closeChats = () => { clist.classList.remove("open"); chatFilter = ""; clearTimeout(searchTimer); };

$("chatsbtn").onclick = (e) => {
  e.stopPropagation();
  if (clist.classList.contains("open")) { closeChats(); return; }
  renderChatList();
};
document.addEventListener("click", (e) => { if (!clist.contains(e.target)) closeChats(); });

/* ---------------- files ----------------
   Same HTTP endpoints as the web UI. The panel talks to them over http://,
   derived from the same server URL the socket uses. */
const flist = $("flist"), fview = $("fview"), fpath = $("fpath"), fpick = $("fpick");
let cwdPath = "", parentPath = null, filesLoaded = false, httpBase = "";

const fmtSize = (n) =>
  n < 1024 ? `${n} B`
  : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB`
  : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB`
  : `${(n / 1024 ** 3).toFixed(2)} GB`;

const fmtWhen = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  return Date.now() - ms < 86400000 ? d.toTimeString().slice(0, 5) : d.toISOString().slice(0, 10);
};

async function base() {
  if (httpBase) return httpBase;
  httpBase = await PLATFORM.httpBase();
  return httpBase;
}

async function fjson(path, opts) {
  const r = await fetch((await base()) + path, opts);
  const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

async function browse(path = "") {
  fview.hidden = true; flist.hidden = false;
  if (path !== cwdPath) selected.clear();
  renderSelection();
  try {
    const d = await fjson(`/files/list?path=${encodeURIComponent(path)}`);
    cwdPath = d.path; parentPath = d.parent;
    const shown = "/" + (d.path || "");
    fpath.textContent = shown.length > 40 ? "…/" + shown.slice(-38) : shown;
    fpath.title = shown;
    flist.replaceChildren(...d.entries.map(rowFor));
    if (!d.entries.length) flist.append(Object.assign(document.createElement("div"), { className: "row", textContent: "(empty)" }));
  } catch (e) {
    flist.replaceChildren(Object.assign(document.createElement("div"), { className: "row", textContent: String(e.message) }));
  }
}

const selected = new Set();
const fsel = $("fsel");

function renderSelection() {
  fsel.hidden = selected.size === 0;
  if (!selected.size) return;
  fsel.replaceChildren();
  fsel.append(Object.assign(document.createElement("span"),
    { className: "n", textContent: `${selected.size} selected` }));
  const zip = document.createElement("button");
  zip.textContent = "zip"; zip.title = "Download the selection as a zip";
  zip.onclick = () => downloadZip([...selected]);
  const clr = document.createElement("button");
  clr.className = "clear"; clr.textContent = "clear";
  clr.onclick = () => { selected.clear(); browse(cwdPath); };
  fsel.append(zip, clr);
}

/* Downloads. The desktop and mobile pages are served by the server itself, so
   the browser can stream a file straight to disk from a plain link or form —
   nothing passes through page memory. The extension panel is a different
   origin, where a link would open the file instead of saving it, so only
   there is the response fetched into a blob first (which holds the whole file
   in the panel's memory until it is saved). */
const sameOrigin = () => PLATFORM.name !== "extension";
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
/** POST into a hidden iframe: the attachment response becomes a download, the page stays put. */
function formDownload(action, fields) {
  let frame = document.getElementById("dlframe");
  if (!frame) { frame = document.createElement("iframe"); frame.id = "dlframe"; frame.hidden = true; document.body.append(frame); }
  const form = document.createElement("form");
  form.method = "post"; form.action = action; form.target = "dlframe";
  for (const [k, vs] of Object.entries(fields)) for (const v of [].concat(vs)) {
    const i = document.createElement("input"); i.type = "hidden"; i.name = k; i.value = v; form.append(i);
  }
  document.body.append(form); form.submit(); form.remove();
}

/* Errors in the files pane show in the pane, at the top of the listing, and
   clear on the next browse — not in an alert() (which a side panel cannot
   show) and not nowhere. */
function fnote(text) {
  let n = $("flist").querySelector(".ferr");
  if (!n) { n = document.createElement("div"); n.className = "ferr"; $("flist").prepend(n); }
  n.textContent = text;
}

async function downloadZip(names) {
  const url = (await base()) + "/files/zip";
  const body = JSON.stringify({ path: cwdPath, names });
  if (sameOrigin()) {
    // The download itself goes through a hidden iframe, where an error is
    // invisible — so ask the server whether the selection is zippable first.
    try { await fjson("/files/zip?check=1", { method: "POST", headers: { "Content-Type": "application/json" }, body }); }
    catch (e) { fnote(`zip: ${e.message}`); return; }
    formDownload(url, { path: cwdPath, names });
    return;
  }
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  if (!r.ok) { fnote(`zip: ${(await r.json().catch(() => ({}))).error ?? `failed (${r.status})`}`); return; }
  saveBlob(await r.blob(), (names.length === 1 ? names[0].replace(/\W+/g, "-") : "selection") + ".zip");
}

function rowFor(e) {
  const row = document.createElement("div");
  row.className = "row" + (e.kind === "dir" ? " dir" : "");
  const full = cwdPath ? `${cwdPath}/${e.name}` : e.name;

  const ck = document.createElement("input");
  ck.type = "checkbox"; ck.className = "ck"; ck.checked = selected.has(e.name);
  ck.onclick = (ev) => {
    ev.stopPropagation();
    if (ck.checked) selected.add(e.name); else selected.delete(e.name);
    row.classList.toggle("sel", ck.checked);
    renderSelection();
  };
  row.append(ck);
  const n = document.createElement("span");
  n.className = "n"; n.textContent = e.kind === "dir" ? e.name + "/" : e.name;
  const sz = document.createElement("span");
  sz.className = "s"; sz.textContent = e.kind === "dir" ? "" : `${fmtSize(e.size)} ${fmtWhen(e.mtime)}`;
  row.append(n, sz);
  if (e.kind === "file") {
    const dl = document.createElement("span");
    dl.className = "dl"; dl.textContent = "↓"; dl.title = "Download";
    dl.onclick = (ev) => { ev.stopPropagation(); download(full, e.name); };
    row.append(dl);
  }
  row.onclick = () => (e.kind === "dir" ? browse(full) : view(full, e));
  return row;
}

async function download(path, name) {
  const url = (await base()) + `/files/read?path=${encodeURIComponent(path)}`;
  if (sameOrigin()) {
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    return;
  }
  const r = await fetch(url);
  if (!r.ok) return;
  saveBlob(await r.blob(), name);
}

async function view(path, entry) {
  flist.hidden = true; fview.hidden = false;
  fview.replaceChildren();
  const hd = document.createElement("div");
  hd.className = "hd";
  const back = document.createElement("button");
  back.textContent = "← back"; back.onclick = () => browse(cwdPath);
  const dl = document.createElement("button");
  dl.textContent = "Download"; dl.onclick = () => download(path, entry.name);
  const op = document.createElement("button"); op.textContent = "Open in tab"; op.hidden = !viewableInTab(entry.name); op.onclick = () => openInTab(path);
  hd.append(back, dl, op, Object.assign(document.createElement("span"),
    { textContent: `${entry.name} · ${fmtSize(entry.size)}` }));
  fview.append(hd);

  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(entry.name)) {
    const r = await fetch((await base()) + `/files/read?path=${encodeURIComponent(path)}`);
    const img = document.createElement("img");
    img.src = URL.createObjectURL(await r.blob());
    fview.append(img);
    return;
  }
  try {
    const d = await fjson(`/files/read?path=${encodeURIComponent(path)}&preview=1`);
    fview.append(Object.assign(document.createElement("pre"), {
      textContent: d.kind === "text" ? d.text + (d.truncated ? "\n…[truncated]" : "")
                                     : `Binary file, ${fmtSize(d.bytes)}. Use Download.`,
    }));
  } catch (e) {
    fview.append(Object.assign(document.createElement("pre"), { textContent: String(e.message) }));
  }
}

async function upload(fileList) {
  const failed = [];
  for (const f of fileList) {
    try {
      await fjson(`/files/upload?path=${encodeURIComponent(cwdPath)}&name=${encodeURIComponent(f.name)}`,
        { method: "POST", body: f, headers: { "Content-Type": "application/octet-stream" } });
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  await browse(cwdPath);
  if (failed.length) fnote(`upload failed — ${failed.join("; ")}`);
}

$("fup").onclick = () => browse(parentPath ?? "");
$("frefresh").onclick = () => browse(cwdPath);
$("fcwd").onclick = () => ws?.send(JSON.stringify({ type: "cwd", path: cwdPath }));
$("fupload").onclick = () => fpick.click();

/* New folder: an inline row at the top of the listing rather than a prompt()
   dialog, which a side panel cannot show. Enter creates, Escape cancels. */
$("fmkdir").onclick = () => {
  const flist = $("flist");
  if (flist.querySelector(".row.newdir")) { flist.querySelector(".row.newdir input").focus(); return; }
  const row = document.createElement("div"); row.className = "row newdir";
  const input = document.createElement("input");
  input.placeholder = "folder name"; input.className = "n"; input.spellcheck = false;
  row.append(input); flist.prepend(row); input.focus();
  input.onkeydown = async (e) => {
    if (e.key === "Escape") { row.remove(); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    input.disabled = true;
    try {
      const made = await fjson("/files/mkdir", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: cwdPath, name }),
      });
      await browse(made.path);
    } catch (err) {
      input.disabled = false; input.select();
      input.setCustomValidity(err.message); input.reportValidity();
    }
  };
  input.onblur = () => { if (!input.value.trim() && !input.disabled) row.remove(); };
};
fpick.onchange = () => { if (fpick.files.length) upload([...fpick.files]); fpick.value = ""; };
for (const ev of ["dragenter", "dragover"]) flist.addEventListener(ev, (e) => { e.preventDefault(); flist.classList.add("drop"); });
for (const ev of ["dragleave", "drop"]) flist.addEventListener(ev, (e) => { e.preventDefault(); flist.classList.remove("drop"); });
flist.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) upload([...e.dataTransfer.files]); });

/* chat | files */
document.querySelectorAll(".tabs .tab").forEach((tab) => {
  tab.onclick = async () => {
    const wantFiles = tab.dataset.view === "files";
    document.querySelectorAll(".tabs .tab").forEach((t) => t.classList.toggle("on", t === tab));
    // A single-column host swaps the transcript for the file browser. A host
    // with room for both (the desktop's right pane) supplies showFiles and
    // decides for itself what the toggle reveals.
    if (PLATFORM.showFiles) PLATFORM.showFiles(wantFiles);
    else {
      log.hidden = wantFiles;
      document.querySelector("footer").hidden = wantFiles;
      $("files").hidden = !wantFiles;
    }
    if (wantFiles && !filesLoaded) {
      filesLoaded = true;
      try {
        const info = await fjson("/files/info");
        await browse(info.start ?? "");
      } catch (e) {
        flist.replaceChildren(Object.assign(document.createElement("div"),
          { className: "row", textContent: `Cannot open files: ${e.message}` }));
      }
    }
  };
});

/* ---------------- prepared prompts ---------------- */
const plist = $("plist");
let promptData = null, editing = null;

async function loadPrompts() {
  promptData = await fjson("/prompts");
}

function renderPrompts() {
  plist.replaceChildren();
  if (!promptData) return;

  const scope = document.createElement("div");
  scope.className = "scope";
  scope.append(document.createTextNode(promptData.host ? `for ${promptData.host}` : "generic only"));
  const add = document.createElement("button");
  add.textContent = "+ new";
  add.onclick = (e) => { e.stopPropagation(); editing = { title: "", text: "", domains: [] }; renderPrompts(); };
  scope.append(add);
  plist.append(scope);

  if (!editing) {
    if (!promptData.prompts.length) {
      plist.append(Object.assign(document.createElement("div"),
        { className: "empty", textContent: "None apply here. Use + new." }));
    }
    for (const p of promptData.prompts) {
      const row = document.createElement("div");
      row.className = "p";
      const t = document.createElement("span");
      t.className = "t2"; t.textContent = p.title; t.title = p.filled;
      row.append(t);
      if (p.domains.length) {
        const tag = document.createElement("span");
        tag.className = "tag"; tag.textContent = p.domains[0];
        row.append(tag);
      }
      for (const [label, fn] of [
        ["✎", () => { editing = { ...p }; renderPrompts(); }],
        ["✕", async () => {
          if (!confirm(`Delete "${p.title}"?`)) return;
          await fetch((await base()) + `/prompts/${p.id}`, { method: "DELETE" });
          await loadPrompts(); renderPrompts();
        }],
      ]) {
        const b = document.createElement("span");
        b.className = "act"; b.textContent = label;
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        row.append(b);
      }
      row.onclick = () => { closePrompts(); box.value = p.filled; sendBox(); };
      plist.append(row);
    }
  } else {
    const wrap = document.createElement("div");
    wrap.className = "edit";
    const title = Object.assign(document.createElement("input"), { placeholder: "Title", value: editing.title ?? "" });
    const doms = Object.assign(document.createElement("input"),
      { placeholder: "Domains — blank = everywhere", value: (editing.domains ?? []).join(" ") });
    const text = Object.assign(document.createElement("textarea"),
      { placeholder: "Prompt. {url} {title} {host} {selection}", value: editing.text ?? "" });
    const row = document.createElement("div");
    row.style.display = "flex"; row.style.gap = "4px";
    const save = Object.assign(document.createElement("button"), { textContent: "Save", className: "allow" });
    save.onclick = async () => {
      const body = { id: editing.id, title: title.value, text: text.value,
                     domains: doms.value.split(/[\s,]+/).filter(Boolean) };
      const r = await fetch((await base()) + "/prompts", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { alert("could not save"); return; }
      editing = null; await loadPrompts(); renderPrompts();
    };
    const cancel = Object.assign(document.createElement("button"), { textContent: "Cancel" });
    cancel.onclick = () => { editing = null; renderPrompts(); };
    row.append(save, cancel);
    wrap.append(title, doms, text, row);
    plist.append(wrap);
  }
  plist.classList.add("open");
}

const closePrompts = () => { plist.classList.remove("open"); editing = null; };

$("promptsbtn").onclick = async (e) => {
  e.stopPropagation();
  if (plist.classList.contains("open")) { closePrompts(); return; }
  plist.replaceChildren(Object.assign(document.createElement("div"),
    { className: "empty", textContent: "loading…" }));
  plist.classList.add("open");
  try { await loadPrompts(); renderPrompts(); }
  catch (err) {
    plist.replaceChildren(Object.assign(document.createElement("div"),
      { className: "empty", textContent: `Could not load: ${err.message}` }));
  }
};
document.addEventListener("click", (e) => { if (!plist.contains(e.target)) closePrompts(); });

/* ---------------- prompts handed over by the context menu ---------------- */

/** Queue until the socket is up, so a cold panel or a reconnect does not drop the prompt. */
const queued = [];
function submit(text, images = []) {
  if (!text && !images.length) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "prompt", text, withTab, ...(images.length ? { images } : {}) }));
    lastText = null;
  } else {
    queued.push({ text, images });
    meta.textContent = `reconnecting… (${queued.length} queued)`;
  }
}
function flushQueued() {
  // One at a time: the server refuses a prompt while the previous one runs,
  // so the rest wait for the next flush rather than being bounced.
  if (queued.length) { const q = queued.shift(); submit(q.text, q.images); }
}

async function takePending() {
  const pendingPrompt = await PLATFORM.takePendingPrompt();
  if (!pendingPrompt) return;
  // Ignore something stale from a previous session.
  if (Date.now() - (pendingPrompt.at ?? 0) < 60_000) submit(pendingPrompt.text);
}

// Fires when the panel is already open and you right-click again. The mobile
// page has no context menu, so its implementation never calls back.
PLATFORM.onPendingPrompt(takePending);

applyFontSize();
applyTheme();
paintTab();
connect();
takePending();
