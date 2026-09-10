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
const stop = $("stop"), modeSel = $("mode");
const statusEl = $("status"), statusText = $("statustext"), statusTime = $("statustime");

let cwdShown = "";
let streaming = null, streamRaw = "";
let ws = null, busy = false, lastText = null, lastRaw = "", cost = 0;
let statusSince = 0, statusTick = null, statusState = "idle";
let retry = null;

function el(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
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
async function agentUrl() { return PLATFORM.wsUrl(); }

async function connect() {
  clearTimeout(retry);
  const url = await agentUrl();
  ws = new WebSocket(url);

  ws.onopen = async () => {
    dot.classList.add("on");
    meta.textContent = "";
    // The server replays the whole transcript on every attach. Without this
    // reset a reconnect (restart, sleep, wifi blip) appended the replay to what
    // was already on screen — measured: the transcript doubled each time.
    log.replaceChildren(); cost = 0; lastText = null; lastRaw = ""; streaming = null; streamRaw = "";
    // Tell the server which browser this panel is in, so this conversation's
    // browser tools act here and not in another browser that is also open.
    try {
      const instanceId = await PLATFORM.instanceId();
      if (instanceId) ws.send(JSON.stringify({ type: "browser", instance: instanceId }));
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
    let m; try { m = JSON.parse(data); } catch { return; }   // a bad frame is not worth a broken handler
    handle(m);
  };
}

function handle(m) {
  switch (m.kind) {
    case "commands": COMMANDS = m.commands ?? []; break;
    case "chats":
      CHATS = m.chats ?? []; ACTIVE = m.activeId;
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
    case "cleared":  log.replaceChildren(); cost = 0; lastText = null; streaming = null; break;
    case "replayed": lastText = null; break;
    case "user": {
      el("msg user", m.text);
      if (m.context) { const c = el("ctx", "⌁ " + m.context.split("\n")[0]); c.title = m.context; }
      lastText = null;
      break;
    }
    case "local":    el("local", m.text); lastText = null; break;
    case "watch":    el("local", `⌁ watch fired — ${m.description}: ${m.detail}`); lastText = null; break;
    case "delta":
      if (!streaming) { streaming = el("msg md"); streamRaw = ""; }
      streamRaw += m.text;
      scheduleStreamRender();
      break;
    case "text":
      if (streaming) { lastText = streaming; lastRaw = m.text; streaming = null; streamRaw = ""; }
      else if (lastText) lastRaw += "\n" + m.text;
      else { lastText = el("msg md"); lastRaw = m.text; }
      renderMd(lastText, lastRaw);
      log.scrollTop = log.scrollHeight;
      break;
    case "tool": {
      if (m.name === "AskUserQuestion") { lastText = null; break; }
      const d = el("tool");
      d.innerHTML = "→ <b></b> ";
      d.querySelector("b").textContent = m.name;
      d.append(summarize(m.input));
      lastText = null;
      break;
    }
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
      if (typeof m.costUsd === "number") cost += m.costUsd;
      el("end", `done${m.denials ? ` · ${m.denials} denied` : ""} · $${cost.toFixed(4)} est.`);
      lastText = null; streaming = null; streamRaw = "";
      flushQueued();
      break;
    case "error":    el("msg err", m.message); break;
  }
}

function summarize(input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  return JSON.stringify(input).slice(0, 100);
}

function applyStatus(m) {
  if (m.state !== statusState || m.detail !== (statusEl.dataset.detail ?? "")) statusSince = Date.now();
  statusState = m.state;
  statusEl.dataset.detail = m.detail ?? "";

  statusEl.classList.toggle("busy",  ["thinking", "tool", "compacting"].includes(m.state));
  statusEl.classList.toggle("await", m.state === "awaiting");
  statusText.textContent = {
    idle:       "ready",
    thinking:   m.tokens > 0 ? `thinking · ${m.tokens >= 1000 ? (m.tokens / 1000).toFixed(1) + "k" : m.tokens}` : "thinking",
    tool:       `running ${m.detail}`,
    compacting: "compacting",
    awaiting:   `waiting for you — ${m.detail}`,
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

function renderApproval(m) {
  const card = el("card");
  card.dataset.approval = m.id; card.dataset.tool = m.tool;
  const h = document.createElement("h4"); h.textContent = `Approve ${m.tool}?`;
  const pre = document.createElement("pre");
  pre.textContent = typeof m.input?.command === "string" ? m.input.command : JSON.stringify(m.input, null, 2);
  const row = document.createElement("div");
  row.className = "row";
  const choices = [["Approve", "allow", "allow"], ["Deny", "deny", "deny"]];
  if (m.canAlways) choices.splice(1, 0, ["Always", "always", "allow"]);
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

function refreshMenu() {
  const q = currentQuery();
  if (q === null) { menu.classList.remove("open"); matches = []; return; }
  matches = COMMANDS.filter(c =>
    c.name.toLowerCase().startsWith(q) ||
    (c.aliases ?? []).some(a => a.toLowerCase().startsWith(q))).slice(0, 60);
  if (!matches.length) { menu.classList.remove("open"); return; }
  sel = Math.min(sel, matches.length - 1);
  menu.replaceChildren(...matches.map((c, i) => {
    const d = document.createElement("div");
    d.className = "item" + (i === sel ? " sel" : "");
    const n = document.createElement("span"); n.className = "n"; n.textContent = "/" + c.name;
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

function pick(i) {
  const c = matches[i];
  if (!c) return;
  box.value = "/" + c.name + (c.argumentHint ? " " : "");
  menu.classList.remove("open");
  matches = [];
  box.focus();
  if (!c.argumentHint) sendBox();
}

function sendBox() {
  const text = box.value.trim();
  if (!text || busy) return;
  // While the socket is down the prompt is queued and goes out on reconnect.
  // It used to be dropped silently — the box kept the text, nothing happened.
  submit(text);
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
// The panel has no terminal and no split view; the full UI does.
$("openui").onclick = async () => PLATFORM.openUrl((await base()) + "/");
modeSel.onchange = () => ws?.send(JSON.stringify({ type: "mode", mode: modeSel.value }));

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
  if (!shown.length) {
    clist.append(Object.assign(document.createElement("div"),
      { className: "empty", textContent: "Nothing matches." }));
  }

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

const closeChats = () => { clist.classList.remove("open"); chatFilter = ""; };

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

async function downloadZip(names) {
  const url = (await base()) + "/files/zip";
  if (sameOrigin()) { formDownload(url, { path: cwdPath, names }); return; }
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: cwdPath, names }),
  });
  if (!r.ok) { alert((await r.json().catch(() => ({}))).error ?? `zip failed (${r.status})`); return; }
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
  hd.append(back, dl, Object.assign(document.createElement("span"),
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
  for (const f of fileList) {
    try {
      await fjson(`/files/upload?path=${encodeURIComponent(cwdPath)}&name=${encodeURIComponent(f.name)}`,
        { method: "POST", body: f, headers: { "Content-Type": "application/octet-stream" } });
    } catch (e) { alert(`Upload of ${f.name} failed: ${e.message}`); }
  }
  browse(cwdPath);
}

$("fup").onclick = () => browse(parentPath ?? "");
$("frefresh").onclick = () => browse(cwdPath);
$("fcwd").onclick = () => ws?.send(JSON.stringify({ type: "cwd", path: cwdPath }));
$("fupload").onclick = () => fpick.click();
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
function submit(text) {
  if (!text) return;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "prompt", text, withTab }));
    lastText = null;
  } else {
    queued.push(text);
    meta.textContent = `reconnecting… (${queued.length} queued)`;
  }
}
function flushQueued() {
  // One at a time: the server refuses a prompt while the previous one runs,
  // so the rest wait for the next flush rather than being bounced.
  if (queued.length) submit(queued.shift());
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
