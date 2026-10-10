/**
 * The board: one kanban across every project — Queue, In progress, Needs
 * you — with In progress holding every session as a container: its task as
 * a card while it is busy, an empty drop slot while it is idle. Under it, a
 * second board, Done, with one column per session. A strip of sessions
 * above both is the filter: click any number of sessions, click project
 * tags on cards, or "tmux only". Design: docs/design-todos.md.
 *
 * Polled, not pushed: GET /board every few seconds while the page is visible,
 * and again right after anything you do. With window.BOARD_SNAPSHOT set (the
 * design mockup) it renders that once and every action is a toast.
 */
const $ = (id) => document.getElementById(id);
const boardEl = $("board"), msgEl = $("msg"), atEl = $("at");
const POLL_MS = 4000;
const DONE_PER_SESSION = 6;
const SNAPSHOT = typeof window !== "undefined" ? window.BOARD_SNAPSHOT : undefined;
let timer = null, lastJson = "", busyEditing = false, boardNow = Date.now();

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const show = (m) => { msgEl.textContent = m || ""; if (m) setTimeout(() => { if (msgEl.textContent === m) msgEl.textContent = ""; }, 6000); };
const toast = (m) => { const t = $("toast"); t.textContent = m; t.classList.add("on"); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("on"), 2200); };

async function api(path, init = {}) {
  if (SNAPSHOT) { toast("Mockup: nothing is sent"); throw new Error("mockup"); }
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body;
}
const act = (id, root, action, extra = {}) => api(`/todos/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ root, action, ...extra }) });
const after = (p) => p.then(() => refresh(true), (e) => { if (e.message !== "mockup") show(e.message); });

/* ---- theme ---- */
let paramTheme = new URLSearchParams(location.search).get("theme") || "";
const getTheme = () => { try { return localStorage.getItem("ct.theme") || "auto"; } catch { return "auto"; } };
function applyTheme() {
  let t = paramTheme; paramTheme = "";
  if (!t) t = getTheme();
  if (t === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  $("themebtn").textContent = `theme: ${t}`;
}
applyTheme();
window.addEventListener("storage", (e) => { if (e.key === "ct.theme") applyTheme(); });
$("themebtn").onclick = () => { const t = getTheme(); const next = t === "auto" ? "dark" : t === "dark" ? "light" : "auto"; try { localStorage.setItem("ct.theme", next); } catch {} applyTheme(); };

/* ---- helpers ---- */
function ago(ms, now) {
  const d = Math.max(0, now - ms);
  if (d < 60_000) return "now";
  if (d < 3600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)}h`;
  if (d < 2 * 86400_000) return "yesterday";
  return `${Math.round(d / 86400_000)}d`;
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const openChat = (id) => { if (SNAPSHOT) return; top.location.href = `/?chat=${encodeURIComponent(id)}`; };
const keyOf = (s) => (s.kind === "chat" ? `chat:${s.id}` : `tmux:${s.name}`);
const nameOf = (s) => (s.kind === "chat" ? s.title : s.name);
function hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const tagColor = (name) => `hsl(${hue(name)} var(--tag-s) var(--tag-l))`;
let sessionsByKey = new Map();
function who(by) {
  if (!by) return "someone";
  if (by === "owner") return "you";
  const s = sessionsByKey.get(by); if (s) return nameOf(s);
  return by.replace(/^(chat|tmux):/, "");
}
const stateClass = (s) => (s.state === "working" ? "working" : s.state === "busy" ? "busy" : s.state === "waiting" ? "waiting" : s.state === "idle" ? "idle" : "dim");
const canTake = (s) => s.state === "idle";
const isBusy = (s) => s.state === "busy" || s.state === "working" || s.state === "waiting";

/* ---- the filter: any number of sessions and projects, and "tmux only" ---- */
const FILTER_KEY = "ct.board.filter";
let sel = { sessions: new Set(), projects: new Set(), tmuxOnly: false };
try { const f = JSON.parse(localStorage.getItem(FILTER_KEY) || "null"); if (f) sel = { sessions: new Set(f.sessions || []), projects: new Set(f.projects || []), tmuxOnly: !!f.tmuxOnly }; } catch {}
function saveFilter() { try { localStorage.setItem(FILTER_KEY, JSON.stringify({ sessions: [...sel.sessions], projects: [...sel.projects], tmuxOnly: sel.tmuxOnly })); } catch {} refresh(true); }
const toggleIn = (set, v) => { if (set.has(v)) set.delete(v); else set.add(v); saveFilter(); };
const filtering = () => sel.sessions.size > 0 || sel.projects.size > 0 || sel.tmuxOnly;
/** A session passes when nothing is selected, or it (or its project) is selected; tmux-only drops every chat. */
function sessionShown(s, p) {
  if (sel.tmuxOnly && s.kind !== "tmux") return false;
  if (!sel.sessions.size && !sel.projects.size) return true;
  return sel.sessions.has(keyOf(s)) || sel.projects.has(p.name);
}
/**
 * A card without a session of its own (a queued item, a question) passes on
 * its project, on the session that signed it, or because a session that is
 * shown works in its project — a task you add for a project whose tmux
 * session is on the board must not vanish behind "tmux only" (it did).
 */
let shownProjects = new Set();
function cardShown(p, by) {
  if (!filtering()) return true;
  if (sel.projects.has(p.name)) return true;
  if (by && sel.sessions.has(by)) return true;
  return shownProjects.has(p.name);
}

/* ---- pieces of a card ---- */
function tag(project) { const t = el("button", `tag${sel.projects.has(project.name) ? " on" : ""}`); t.title = sel.projects.has(project.name) ? `Stop filtering on ${project.name}` : `Add ${project.name} to the filter`; const i = el("i"); i.style.background = tagColor(project.name); t.append(i, el("span", "", project.name)); t.onclick = () => toggleIn(sel.projects, project.name); return t; }
function whoChip(s, by) {
  const w = el("span", `who ${s ? stateClass(s) : "dim"}`);
  w.append(el("span", "dot"), el("span", "", s ? nameOf(s) : who(by)));
  if (s && s.kind === "tmux") w.append(el("span", "note", "tmux"));
  return w;
}

/* ---- cards ---- */
let dragging = null;
function queueCard(i, project, now) {
  const c = el("div", "card q"); c.draggable = true; c.dataset.id = i.id;
  const top = el("div", "top"); top.append(tag(project));
  const acts = el("div", "acts");
  const d = el("button", "ghost", "✓"); d.title = "Mark done without a session"; d.onclick = () => after(act(i.id, project.root, "done", { result: "" }));
  const x = el("button", "ghost", "✕"); x.title = "Drop"; x.onclick = () => after(act(i.id, project.root, "drop"));
  acts.append(d, x); top.append(acts); c.append(top);
  const t = el("div", "text", i.text); t.title = "Double-click to edit"; t.ondblclick = () => edit(t, i, project); c.append(t);
  const foot = el("div", "foot");
  if (i.addedBy && i.addedBy !== "owner") foot.append(el("span", "", `from ${who(i.addedBy)}`));
  foot.append(el("span", "age mono", ago(i.addedAt, now)));
  c.append(foot);
  c.addEventListener("dragstart", (e) => { dragging = { item: i, root: project.root, project }; c.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; document.querySelectorAll(".slot").forEach((sl) => sl.classList.toggle("droppable", sl._root === project.root)); });
  c.addEventListener("dragend", () => { c.classList.remove("dragging"); dragging = null; document.querySelectorAll(".over, .dragover, .droppable").forEach((x) => x.classList.remove("over", "dragover", "droppable")); });
  c.addEventListener("dragover", (e) => { if (!dragging || dragging.root !== project.root || dragging.item.id === i.id) return; e.preventDefault(); e.stopPropagation(); c.classList.add("dragover"); });
  c.addEventListener("dragleave", () => c.classList.remove("dragover"));
  c.addEventListener("drop", async (e) => {
    if (!dragging || dragging.root !== project.root) return; e.preventDefault(); e.stopPropagation(); c.classList.remove("dragover");
    const ids = project.queue.filter((x) => x.status === "queued").map((x) => x.id);
    const from = ids.indexOf(dragging.item.id), to = ids.indexOf(i.id); if (from < 0 || to < 0) return;
    ids.splice(from, 1); ids.splice(to, 0, dragging.item.id);
    const claimed = project.queue.filter((x) => x.status === "claimed").map((x) => x.id);
    try { await api("/todos/reorder", { method: "POST", body: JSON.stringify({ root: project.root, ids: [...ids, ...claimed] }) }); } catch (err) { if (err.message !== "mockup") show(err.message); }
    dragging = null; refresh(true);
  });
  return c;
}
function edit(t, i, project) {
  busyEditing = true;
  const input = el("input"); input.value = i.text; t.replaceWith(input); input.focus(); input.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return; finished = true; busyEditing = false;
    if (save && input.value.trim() && input.value.trim() !== i.text) { try { await act(i.id, project.root, "edit", { text: input.value.trim() }); } catch (e) { if (e.message !== "mockup") show(e.message); } }
    refresh(true);
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}
async function assign(s, project, item, btn) {
  if (btn) btn.disabled = true;
  const target = s.kind === "chat" ? { chatId: s.id } : { tmux: s.name };
  try {
    await api(`/todos/${encodeURIComponent(item.id)}/send`, { method: "POST", body: JSON.stringify({ root: project.root, ...target }) });
    toast(`${s.kind === "tmux" ? "Typed into" : "Sent to"} ${nameOf(s)}`); refresh(true);
  } catch (e) { if (e.message !== "mockup") show(e.message); if (btn) btn.disabled = false; }
}
/** The session's task right now: a held board item, or the keeper's title for work typed directly. */
function taskCard(s, project, now, held) {
  const c = el("div", `card ${held ? "held" : "adhoc"}${s.state === "waiting" ? " needs" : ""}`);
  const top = el("div", "top"); top.append(tag(project));
  if (held) {
    const acts = el("div", "acts");
    const d = el("button", "ghost", "✓"); d.title = "Mark done"; d.onclick = () => after(act(held.id, project.root, "done", { result: "" }));
    const r = el("button", "ghost", "↩"); r.title = "Release back to the queue"; r.onclick = () => after(act(held.id, project.root, "release"));
    acts.append(d, r); top.append(acts);
  }
  c.append(top);
  const title = held ? held.text : ((s.task && s.task.title) || s.summary || s.lastPrompt || s.lastText || "Working…");
  const t = el("div", "text", title); if (!held && s.lastPrompt) t.title = `Asked: ${s.lastPrompt}`; c.append(t);
  if (s.summary && s.summary !== title) c.append(el("div", "result", s.summary));
  const foot = el("div", "foot");
  if (s.kind === "tmux" && s.activity) foot.append(el("span", "act mono", s.activity));
  else if (s.kind === "chat" && s.steps && s.steps.length) { const done = s.steps.filter((x) => x.status === "completed").length; foot.append(el("span", "act", `${done}/${s.steps.length} steps`)); }
  foot.append(el("span", "note", held ? `board · ${held.id.slice(0, 8)}` : "not on the board"));
  foot.append(el("span", "age mono", ago(held ? held.claimedAt : s.since, now)));
  c.append(foot);
  return c;
}
function askCard(i, project, now) {
  const c = el("div", "card needs");
  const top = el("div", "top"); top.append(tag(project));
  // Who is asking, first: two sessions can work on one project, and the answer goes to one of them.
  const asker = whoChip(sessionsByKey.get(i.addedBy), i.addedBy); asker.classList.add("asker"); top.append(asker);
  const acts = el("div", "acts");
  const d = el("button", "ghost", "✓"); d.title = "Close without an answer"; d.onclick = () => after(act(i.id, project.root, "done", { result: "" }));
  const x = el("button", "ghost", "✕"); x.title = "Drop"; x.onclick = () => after(act(i.id, project.root, "drop"));
  acts.append(d, x); top.append(acts); c.append(top);
  c.append(el("div", "text", i.text));
  const ans = el("div", "answer");
  const input = el("input"); input.placeholder = "Answer…"; input.spellcheck = false;
  input.onfocus = () => { busyEditing = true; }; input.onblur = () => { busyEditing = false; };
  const row = el("div", "row"); const reply = el("button", "primary", "Reply");
  const send = async () => {
    const a = input.value.trim(); if (!a) { show("Type an answer first"); return; }
    reply.disabled = true;
    try { const r = await act(i.id, project.root, "answer", { result: a }); toast(r.replied ? `Answer sent to ${who(i.addedBy)}` : "Answer saved; the session reads it on its next turn"); refresh(true); }
    catch (e) { if (e.message !== "mockup") show(e.message); reply.disabled = false; }
  };
  reply.onclick = send; input.onkeydown = (e) => { if (e.key === "Enter") send(); };
  row.append(reply); ans.append(input, row); c.append(ans);
  const foot = el("div", "foot"); foot.append(el("span", "note", "asked on the board")); foot.append(el("span", "age mono", ago(i.addedAt, now))); c.append(foot);
  return c;
}
/** A chat stopped on a card: the card itself, with Allow / Deny here (a question still opens the chat). */
function waitingCard(s, project, now) {
  const c = el("div", "card needs");
  const top = el("div", "top"); top.append(tag(project)); const w = whoChip(s); w.classList.add("asker"); top.append(w); c.append(top);
  const cards = s.kind === "chat" ? (s.pending || []) : [];
  if (!cards.length) {
    const t = el("div", "text");
    if (s.kind === "chat") { t.append("Waiting for you. "); const a = el("a", "", "Open the chat"); a.href = `/?chat=${encodeURIComponent(s.id)}`; a.onclick = (e) => { e.preventDefault(); openChat(s.id); }; t.append(a); }
    else t.textContent = "Waiting for you. Answer in the terminal.";
    c.append(t);
  }
  for (const card of cards) {
    c.append(el("div", "text", card.summary));
    const row = el("div", "choose");
    if (card.kind === "question") { const a = el("a", "", "Open the chat to answer"); a.href = `/?chat=${encodeURIComponent(s.id)}`; a.onclick = (e) => { e.preventDefault(); openChat(s.id); }; row.append(a); }
    else {
      const decide = (decision) => async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try { await api("/board/decide", { method: "POST", body: JSON.stringify({ chatId: s.id, id: card.id, decision }) }); toast(decision === "deny" ? "Denied" : "Allowed"); refresh(true); }
        catch (e) { if (e.message !== "mockup") show(e.message); btn.disabled = false; }
      };
      const allow = el("button", "primary", card.kind === "submit" ? "Submit" : "Allow"); allow.onclick = decide("allow");
      const deny = el("button", "", card.kind === "submit" ? "Stop" : "Deny"); deny.onclick = decide("deny");
      row.append(allow, deny);
      const open = el("a", "", "open the chat"); open.href = `/?chat=${encodeURIComponent(s.id)}`; open.onclick = (e) => { e.preventDefault(); openChat(s.id); }; row.append(open);
    }
    c.append(row);
  }
  const foot = el("div", "foot"); foot.append(el("span", "note", "stopped on a card")); foot.append(el("span", "age mono", ago(s.since, now))); c.append(foot);
  return c;
}
function doneCard(i, project) {
  const c = el("div", `card done ${i.status}`);
  const top = el("div", "top"); top.append(tag(project)); c.append(top);
  c.append(el("div", "text", i.text));
  if (i.result) c.append(el("div", "result", i.result));
  const foot = el("div", "foot"); foot.append(el("span", "", i.status === "dropped" ? "✕ dropped" : "✓ done")); foot.append(el("span", "age mono", clock(i.doneAt))); c.append(foot);
  return c;
}

/* ---- the sessions strip: a pill per session, click to add it to the filter ---- */
function pill(s, p) {
  const b = el("button", `pill ${stateClass(s)}${sel.sessions.has(keyOf(s)) ? " selected" : ""}`);
  b.append(el("span", "dot"), el("span", "name", nameOf(s)));
  const sub = [p.name]; if (s.kind === "tmux") sub.push("tmux"); if (s.state === "waiting") sub.push("waiting for you"); else if (!["idle", "busy", "working"].includes(s.state)) sub.push(s.state); sub.push(ago(s.since, boardNow));
  b.append(el("span", "sub", sub.join(" · ")));
  b.title = `${s.summary ? s.summary + "\n\n" : ""}Click: ${sel.sessions.has(keyOf(s)) ? "remove from" : "add to"} the filter${s.kind === "chat" ? " · double-click: open the chat" : ""}`;
  b.onclick = () => toggleIn(sel.sessions, keyOf(s));
  if (s.kind === "chat") b.ondblclick = () => openChat(s.id);
  return b;
}

/* ---- In progress: every session as a container, its card inside or an empty slot ---- */
function sessionBox(s, p, now) {
  const box = el("div", `sbox ${stateClass(s)}`);
  const h = el("div", "sboxhd");
  h.append(el("span", "dot"));
  if (s.kind === "chat") { const a = el("a", "name", nameOf(s)); a.href = `/?chat=${encodeURIComponent(s.id)}`; a.title = "Open the chat"; a.onclick = (e) => { e.preventDefault(); openChat(s.id); }; h.append(a); }
  else { h.append(el("span", "name", nameOf(s)), el("span", "kind", "tmux")); }
  const meta = [p.name]; if (s.model) meta.push(s.model); meta.push(ago(s.since, now));
  h.append(el("span", "meta", meta.join(" · ")));
  box.append(h);
  const held = p.queue.filter((i) => i.status === "claimed" && i.claimedBy === keyOf(s));
  if (held.length) for (const i of held) box.append(taskCard(s, p, now, i));
  else if (isBusy(s)) box.append(taskCard(s, p, now, null));
  else {
    const slot = el("div", "slot"); slot._root = p.root;
    const next = p.queue.find((i) => i.status === "queued");
    if (canTake(s)) {
      slot.append(el("span", "", next ? "Idle. Drop a task here, or" : "Idle. Nothing queued for this project."));
      if (next) { const b = el("button", "primary", "Assign next ▶"); b.title = next.text; b.onclick = () => assign(s, p, next, b); slot.append(b); }
      slot.addEventListener("dragover", (e) => { if (!dragging || dragging.root !== p.root) return; e.preventDefault(); slot.classList.add("over"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("over"));
      slot.addEventListener("drop", (e) => { if (!dragging || dragging.root !== p.root) return; e.preventDefault(); slot.classList.remove("over"); assign(s, p, dragging.item); });
    } else slot.append(el("span", "", s.state === "probably idle" ? "Pane not readable; probably at its prompt." : "No Claude in this pane."));
    box.append(slot);
  }
  return box;
}

function column(cls, title, n) {
  const col = el("div", `col ${cls}`);
  const hd = el("div", "hd"); hd.append(el("span", "", title), el("span", "n mono", String(n))); col.append(hd);
  return col;
}

/* ---- render ---- */
function render(b) {
  boardNow = b.at;
  sessionsByKey = new Map();
  for (const p of b.projects) for (const s of p.sessions) sessionsByKey.set(keyOf(s), s);

  // The strip: every session (filter or not), busy first; the selected ones marked.
  const rank = (s) => (s.state === "waiting" ? 0 : isBusy(s) ? 1 : s.state === "idle" ? 2 : 3);
  const all = b.projects.flatMap((p) => p.sessions.map((s) => ({ s, p }))).sort((x, y) => rank(x.s) - rank(y.s) || y.s.since - x.s.since);
  const strip = document.createDocumentFragment();
  strip.append(el("span", "lbl", all.length ? "Sessions" : "No live session"));
  for (const { s, p } of all) strip.append(pill(s, p));
  const tmuxBtn = el("button", `pill toggle${sel.tmuxOnly ? " selected" : ""}`); tmuxBtn.append(el("span", "name", "tmux only")); tmuxBtn.title = "Show only tmux sessions"; tmuxBtn.onclick = () => { sel.tmuxOnly = !sel.tmuxOnly; saveFilter(); };
  strip.append(tmuxBtn);
  if (filtering()) { const clear = el("button", "pill toggle"); clear.append(el("span", "name", "✕ clear filter")); clear.onclick = () => { sel = { sessions: new Set(), projects: new Set(), tmuxOnly: false }; saveFilter(); }; strip.append(clear); }
  $("sessions").replaceChildren(strip);

  const shown = all.filter(({ s, p }) => sessionShown(s, p));
  shownProjects = new Set(shown.map(({ p }) => p.name));
  let hiddenQueued = 0;
  const queued = [], asks = [], waiting = [], doneBy = new Map(), doneLoose = [];
  for (const p of b.projects) {
    for (const i of p.queue) {
      if (i.status === "queued") { if (cardShown(p, i.addedBy)) queued.push([i, p]); else hiddenQueued++; }
      else if (i.status === "done" || i.status === "dropped") {
        const s = i.claimedBy ? sessionsByKey.get(i.claimedBy) : undefined;
        if (s) { if (!sessionShown(s, p)) continue; if (!doneBy.has(i.claimedBy)) doneBy.set(i.claimedBy, []); doneBy.get(i.claimedBy).push([i, p]); }
        else if (cardShown(p, i.claimedBy)) doneLoose.push([i, p]);
      }
    }
    for (const i of p.asks) if (cardShown(p, i.addedBy)) asks.push([i, p]);
    for (const s of p.sessions) if (s.state === "waiting" && sessionShown(s, p)) waiting.push([s, p]);
  }
  const byTime = (x, y) => (y[0].doneAt ?? 0) - (x[0].doneAt ?? 0);
  for (const list of doneBy.values()) list.sort(byTime);
  doneLoose.sort(byTime);

  const c1 = column("queue", "Queue", queued.length);
  if (!queued.length) c1.append(el("div", "empty", hiddenQueued ? "" : "Nothing queued. Add a task above."));
  for (const [i, p] of queued) c1.append(queueCard(i, p, b.at));
  if (hiddenQueued) { const h = el("div", "empty"); h.append(`${hiddenQueued} queued task${hiddenQueued === 1 ? "" : "s"} hidden by the filter · `); const x = el("a", "", "clear"); x.href = "#"; x.onclick = (e) => { e.preventDefault(); sel = { sessions: new Set(), projects: new Set(), tmuxOnly: false }; saveFilter(); }; h.append(x); c1.append(h); }

  const c2 = column("progress", "In progress", shown.filter(({ s }) => isBusy(s)).length);
  if (!shown.length) c2.append(el("div", "empty", filtering() ? "No session matches the filter." : "No live session. Open a chat in a project, or a tmux session in its directory."));
  for (const { s, p } of shown) c2.append(sessionBox(s, p, b.at));

  const c3 = column("needs", "Needs you", asks.length + waiting.length);
  if (!asks.length && !waiting.length) c3.append(el("div", "empty", "Nothing waiting on you."));
  for (const [s, p] of waiting) c3.append(waitingCard(s, p, b.at));
  for (const [i, p] of asks) c3.append(askCard(i, p, b.at));

  const top = el("div", "cols"); top.append(c1, c2, c3);

  // The second board: Done, one column per session (plus one for items finished without a session).
  const doneBoard = el("div", "doneboard");
  const total = [...doneBy.values()].reduce((a, l) => a + l.length, 0) + doneLoose.length;
  const dh = el("div", "lanehd"); dh.append(el("span", "", "Done"), el("span", "n mono", String(total))); doneBoard.append(dh);
  const dcols = el("div", "dcols");
  const n = shown.length + (doneLoose.length ? 1 : 0);
  dcols.style.gridTemplateColumns = `repeat(${Math.max(n, 1)}, minmax(220px, 1fr))`;
  if (!n) dcols.append(el("div", "empty", "Nothing finished yet."));
  for (const { s, p } of shown) {
    const col = el("div", "col dcol");
    const hd = el("div", "hd sess"); hd.append(el("span", `dot ${stateClass(s)}`), el("span", "name", nameOf(s)), el("span", "n mono", String((doneBy.get(keyOf(s)) || []).length))); hd.title = p.name; col.append(hd);
    const items = doneBy.get(keyOf(s)) || [];
    if (!items.length) col.append(el("div", "empty", "—"));
    for (const [i, pp] of items.slice(0, DONE_PER_SESSION)) col.append(doneCard(i, pp));
    if (items.length > DONE_PER_SESSION) col.append(el("div", "more", `and ${items.length - DONE_PER_SESSION} more`));
    dcols.append(col);
  }
  if (doneLoose.length) {
    const col = el("div", "col dcol"); const hd = el("div", "hd sess"); hd.append(el("span", "dot dim"), el("span", "name", "without a session"), el("span", "n mono", String(doneLoose.length))); col.append(hd);
    for (const [i, p] of doneLoose.slice(0, DONE_PER_SESSION)) col.append(doneCard(i, p));
    dcols.append(col);
  }
  const scroller = el("div", "scroller"); scroller.append(dcols); doneBoard.append(scroller);

  boardEl.replaceChildren(top, doneBoard);
  atEl.textContent = `as of ${clock(b.at)}`;
  const need = asks.length + waiting.length;
  $("needs").textContent = need ? `${need} need${need === 1 ? "s" : ""} you` : "";
  $("chips").replaceChildren();

  const selp = $("gproject"); const cur = selp.value;
  const onBoard = b.projects.filter((p) => p.id).map((p) => p.id);
  const list = [...(b.allProjects || [])].sort((x, y) => (onBoard.indexOf(y.id) >= 0) - (onBoard.indexOf(x.id) >= 0));
  const first = el("option", "", "project…"); first.value = "";
  selp.replaceChildren(first, ...list.map((p) => { const o = el("option", "", p.name); o.value = p.id; return o; }));
  if (cur && list.some((p) => p.id === cur)) selp.value = cur;
}

/* ---- poll ---- */
async function refresh(force = false) {
  if (SNAPSHOT) { if (force || !lastJson) { lastJson = "snapshot"; render(SNAPSHOT); } return; }
  if (busyEditing && !force) return;
  try {
    const b = await api("/board");
    const j = JSON.stringify(b);
    if (force || j !== lastJson) { lastJson = j; render(b); }
    else atEl.textContent = `as of ${clock(b.at)}`;
  } catch (e) { show(`board: ${e.message}`); }
}
function schedule() { clearTimeout(timer); if (document.hidden || SNAPSHOT) return; timer = setTimeout(async () => { await refresh(); schedule(); }, POLL_MS); }
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); schedule(); });

$("gadd").onclick = async () => {
  const t = $("gtext").value.trim(), project = $("gproject").value;
  if (!t) return; if (!project) { show("Pick a project first"); $("gproject").focus(); return; }
  try { await api("/todos", { method: "POST", body: JSON.stringify({ project, text: t }) }); $("gtext").value = ""; toast("Added"); refresh(true); } catch (e) { if (e.message !== "mockup") show(e.message); }
};
$("gtext").onkeydown = (e) => { if (e.key === "Enter") $("gadd").click(); };
$("gtext").onfocus = () => { busyEditing = true; }; $("gtext").onblur = () => { busyEditing = false; };

refresh(true).then(schedule);
