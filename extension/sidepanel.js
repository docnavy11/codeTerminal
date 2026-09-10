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
const DEFAULT_EXT_URL = "ws://devserver.tailnet-1234.ts.net:8123/ext";

const $ = (id) => document.getElementById(id);
const log = $("log"), box = $("box"), dot = $("dot"), meta = $("meta");
const stop = $("stop"), modeSel = $("mode");
const statusEl = $("status"), statusText = $("statustext"), statusTime = $("statustime");

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

/* The background worker holds the /ext URL; the session lives at /ws. */
async function agentUrl() {
  const { serverUrl } = await chrome.storage.local.get({ serverUrl: DEFAULT_EXT_URL });
  return (serverUrl || DEFAULT_EXT_URL).replace(/\/ext\/?$/, "/ws");
}

async function connect() {
  clearTimeout(retry);
  const url = await agentUrl();
  ws = new WebSocket(url);

  ws.onopen = () => { dot.classList.add("on"); meta.textContent = ""; };
  ws.onclose = () => {
    dot.classList.remove("on");
    meta.textContent = "reconnecting…";
    setBusy(false);
    retry = setTimeout(connect, 3000);           // the server may just be restarting
  };
  ws.onmessage = ({ data }) => handle(JSON.parse(data));
}

function handle(m) {
  switch (m.kind) {
    case "ready":
      meta.textContent = String(m.model || "").replace(/\[1m\]$/, "");
      modeSel.querySelector('option[value="bypassPermissions"]').disabled = !m.canBypass;
      break;
    case "cleared":  log.replaceChildren(); cost = 0; lastText = null; break;
    case "replayed": lastText = null; break;
    case "user": {
      el("msg user", m.text);
      if (m.context) { const c = el("ctx", "⌁ " + m.context.split("\n")[0]); c.title = m.context; }
      lastText = null;
      break;
    }
    case "local":    el("local", m.text); lastText = null; break;
    case "text":
      if (lastText) lastRaw += "\n" + m.text; else { lastText = el("msg md"); lastRaw = m.text; }
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
      lastText = null;
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
  const choices = [["Approve", "allow", "allow"], ["Deny", "deny", "deny"]];
  if (m.canAlways) choices.splice(1, 0, ["Always", "always", "allow"]);
  for (const [label, decision, cls] of choices) {
    const b = document.createElement("button");
    b.textContent = label; b.className = cls;
    b.onclick = () => {
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
    ws.send(JSON.stringify({ type: "answer", id: m.id, answers }));
    card.querySelectorAll("button,input").forEach((x) => (x.disabled = true));
    card.classList.add("done");
  };
  card.append(send);
  log.scrollTop = log.scrollHeight;
}

box.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;
  e.preventDefault();
  const text = box.value.trim();
  if (!text || busy || ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "prompt", text, withTab }));
  box.value = ""; box.style.height = "auto"; lastText = null;
});
box.addEventListener("input", () => {
  box.style.height = "auto";
  box.style.height = Math.min(box.scrollHeight, 130) + "px";
});

stop.onclick = () => ws?.send(JSON.stringify({ type: "interrupt" }));
$("newchat").onclick = () => ws?.send(JSON.stringify({ type: "new" }));
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
$("fsdown").onclick = () => { fontSize = clampFs(fontSize - 1); applyFontSize(); };
$("theme").onclick  = () => { theme = { auto: "light", light: "dark", dark: "auto" }[theme]; applyTheme(); };

let withTab = localStorage.getItem("ct.tab") !== "0";
function paintTab() {
  $("tabctx").textContent = withTab ? "tab" : "tab off";
  $("tabctx").classList.toggle("off", !withTab);
  localStorage.setItem("ct.tab", withTab ? "1" : "0");
}
$("tabctx").onclick = () => { withTab = !withTab; paintTab(); };

applyFontSize();
applyTheme();
paintTab();
connect();
