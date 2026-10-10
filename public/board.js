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

/* ---- attachments: an image pasted or picked is uploaded and kept; a task carries its paths ---- */
async function uploadImage(file) {
  if (SNAPSHOT) { toast("Mockup: nothing is sent"); throw new Error("mockup"); }
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error("only png, jpeg, gif or webp images");
  const r = await fetch("/todos/attach", { method: "POST", headers: { "content-type": file.type }, body: file });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
  return body.path;
}
const imagesIn = (e) => [...(e.clipboardData?.files || e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
function thumbs(paths, onRemove) {
  const row = el("div", "thumbs");
  for (const p of paths || []) {
    const t = el("span", "thumb"); const a = el("a"); a.href = `/todos/attachment?path=${encodeURIComponent(p)}`; a.target = "_blank"; a.title = p.split("/").pop();
    const img = el("img"); img.src = a.href; img.alt = ""; img.loading = "lazy"; a.append(img); t.append(a);
    if (onRemove) { const x = el("button", "ghost", "✕"); x.title = "Remove this image"; x.onclick = () => onRemove(p); t.append(x); }
    row.append(t);
  }
  return row;
}
/** The details panel of a queued card: notes, images, and what it waits for. Open panels survive a poll. */
const openPanels = new Set();
function detailsPanel(i, project) {
  const panel = el("div", "panel");
  const notes = el("textarea"); notes.rows = 4; notes.value = i.notes || ""; notes.placeholder = "Notes for whoever takes this: context, links, what done looks like…"; notes.spellcheck = false;
  let images = [...(i.images || [])];
  const imgBox = el("div"); const drawImgs = () => { imgBox.replaceChildren(thumbs(images, (p) => { images = images.filter((x) => x !== p); drawImgs(); })); }; drawImgs();
  const addImage = async (files) => { for (const f of files) { try { images.push(await uploadImage(f)); drawImgs(); } catch (e) { if (e.message !== "mockup") show(e.message); } } };
  notes.addEventListener("paste", (e) => { const f = imagesIn(e); if (f.length) { e.preventDefault(); addImage(f); } });
  const pick = el("input"); pick.type = "file"; pick.accept = "image/png,image/jpeg,image/gif,image/webp"; pick.multiple = true; pick.hidden = true; pick.onchange = () => { addImage([...pick.files]); pick.value = ""; };
  const attach = el("button", "", "Attach image"); attach.onclick = () => pick.click();
  const others = project.queue.filter((x) => x.id !== i.id && (x.status === "queued" || x.status === "claimed"));
  const waits = el("div", "waits"); const picked = new Set(i.blockedBy || []);
  if (others.length) {
    waits.append(el("div", "lbl", "Waits for"));
    for (const o of others) { const lab = el("label"); const cb = el("input"); cb.type = "checkbox"; cb.checked = picked.has(o.id); cb.onchange = () => { if (cb.checked) picked.add(o.id); else picked.delete(o.id); }; lab.append(cb, el("span", "", o.text)); waits.append(lab); }
  }
  const row = el("div", "row"); const save = el("button", "primary", "Save"), cancel = el("button", "", "Close");
  const close = () => { openPanels.delete(i.id); busyEditing = openPanels.size > 0; refresh(true); };
  save.onclick = async () => { try { await act(i.id, project.root, "annotate", { notes: notes.value, images, blockedBy: [...picked] }); toast("Saved"); close(); } catch (e) { if (e.message !== "mockup") show(e.message); } };
  cancel.onclick = close;
  row.append(save, cancel, attach, pick);
  panel.append(notes, imgBox, waits, row);
  return panel;
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
  if (i.waitingOn && i.waitingOn.length) { c.classList.add("blocked"); c.append(el("div", "waiting", `⏸ waits for “${i.waitingOn[0].text.slice(0, 60)}”${i.waitingOn.length > 1 ? ` +${i.waitingOn.length - 1}` : ""}`)); }
  if (i.notes) c.append(el("div", "notes", i.notes));
  if (i.images && i.images.length) c.append(thumbs(i.images));
  const foot = el("div", "foot");
  if (i.addedBy && i.addedBy !== "owner") foot.append(el("span", "", `from ${who(i.addedBy)}`));
  const more = el("button", "ghost", openPanels.has(i.id) ? "▾ details" : "▸ details"); more.title = "Notes, images and what this waits for";
  more.onclick = () => { if (openPanels.has(i.id)) openPanels.delete(i.id); else openPanels.add(i.id); busyEditing = openPanels.size > 0; refresh(true); };
  foot.append(more, el("span", "age mono", ago(i.addedAt, now)));
  c.append(foot);
  if (openPanels.has(i.id)) c.append(detailsPanel(i, project));
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
  if (held && held.stale) {
    const w = el("div", "stale", held.stale === "gone" ? "⚠ its session is not running" : "⚠ its session has been idle a while");
    const rel = el("button", "", "Release"); rel.title = "Put it back in the queue"; rel.onclick = () => after(act(held.id, project.root, "release")); w.append(rel); c.append(w);
  }
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
/** A claim whose holder is not on the board (exited, deleted, or hidden by the filter's rules): it still has to be seen and releasable. */
function orphanCard(i, project, now) {
  const c = el("div", "card held orphan");
  const top = el("div", "top"); top.append(tag(project));
  const acts = el("div", "acts");
  const d = el("button", "ghost", "✓"); d.title = "Mark done"; d.onclick = () => after(act(i.id, project.root, "done", { result: "" }));
  const r = el("button", "ghost", "↩"); r.title = "Release back to the queue"; r.onclick = () => after(act(i.id, project.root, "release"));
  acts.append(d, r); top.append(acts); c.append(top);
  c.append(el("div", "text", i.text));
  const w = el("div", "stale", "⚠ its session is not running"); const rel = el("button", "", "Release"); rel.onclick = () => after(act(i.id, project.root, "release")); w.append(rel); c.append(w);
  const foot = el("div", "foot"); foot.append(el("span", "note", `held by ${who(i.claimedBy)}`)); foot.append(el("span", "age mono", ago(i.claimedAt, now))); c.append(foot);
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
  const top = el("div", "top"); top.append(tag(project));
  const acts = el("div", "acts");
  const re = el("button", "ghost", "↩"); re.title = "Back to the queue"; re.onclick = () => after(act(i.id, project.root, "reopen")); acts.append(re);
  // A card the keeper recorded (a session signed it as both adder and doer) can be reported when it is wrong.
  const byKeeper = i.status === "done" && i.addedBy && i.addedBy === i.claimedBy && /^(chat|tmux):/.test(i.addedBy);
  if (byKeeper) {
    const no = el("button", "ghost", "not a task"); no.title = "The keeper was wrong: this was not a task. It is removed, not recorded again, and the thread is saved for the keeper's evaluation.";
    no.onclick = () => after(api("/board/misread", { method: "POST", body: JSON.stringify({ root: project.root, id: i.id, wanted: "not_done" }) }).then(() => toast("Removed; thanks, saved for the evaluation")));
    const ti = el("button", "ghost", "wrong title"); ti.title = "Rename it; the thread is saved for the keeper's evaluation.";
    ti.onclick = () => { busyEditing = true; const t = c.querySelector(".text"); const input = el("input"); input.value = i.text; t.replaceWith(input); input.focus(); input.select();
      let done = false; const fin = async (save) => { if (done) return; done = true; busyEditing = false; const v = input.value.trim();
        if (save && v && v !== i.text) { try { await api("/board/misread", { method: "POST", body: JSON.stringify({ root: project.root, id: i.id, wanted: "title", title: v }) }); toast("Renamed; saved for the evaluation"); } catch (e) { if (e.message !== "mockup") show(e.message); } }
        refresh(true); };
      input.onkeydown = (e) => { if (e.key === "Enter") fin(true); if (e.key === "Escape") fin(false); }; input.onblur = () => fin(true); };
    acts.append(no, ti);
  }
  top.append(acts); c.append(top);
  c.append(el("div", "text", i.text));
  if (i.result) c.append(el("div", "result", i.result));
  if (i.links) {
    const l = el("div", "links2");
    if (i.links.chatId) { const a = el("a", "", "open chat"); a.href = `/?chat=${encodeURIComponent(i.links.chatId)}`; a.onclick = (e) => { e.preventDefault(); openChat(i.links.chatId); }; l.append(a); }
    if (i.links.commit) { if (i.links.commit.url) { const a = el("a", "mono", i.links.commit.hash); a.href = i.links.commit.url; a.target = "_blank"; a.rel = "noopener"; a.title = "Open the commit"; l.append(a); } else l.append(el("span", "mono", i.links.commit.hash)); }
    c.append(l);
  }
  const foot = el("div", "foot"); foot.append(el("span", "", i.status === "dropped" ? "✕ dropped" : "✓ done")); foot.append(el("span", "age mono", clock(i.doneAt))); c.append(foot);
  return c;
}

/* ---- history: finished work beyond what the columns show, including what pruning archived ---- */
let lastProjects = [];
function toggleHistory() {
  const box = $("history");
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false; box.replaceChildren();
  const bar = el("div", "histbar");
  const projSel = el("select"); for (const p of lastProjects) { const o = el("option", "", p.name); o.value = p.root; projSel.append(o); }
  const q = el("input"); q.placeholder = "Search finished work: a word from the task or its result…"; q.spellcheck = false;
  const close = el("button", "ghost", "✕"); close.onclick = () => { box.hidden = true; };
  bar.append(projSel, q, close);
  const list = el("div", "histlist");
  const run = async () => {
    if (!projSel.value) { list.replaceChildren(el("div", "empty", "No project to search.")); return; }
    try {
      const r = await api(`/todos/history?dir=${encodeURIComponent(projSel.value)}&q=${encodeURIComponent(q.value)}`);
      list.replaceChildren(...(r.items.length ? r.items.map((i) => {
        const row = el("div", "hrow"); row.append(el("span", "when mono", new Date(i.doneAt || i.addedAt).toLocaleDateString([], { month: "short", day: "numeric" })));
        const b = el("div"); b.append(el("div", "", i.text)); if (i.result) b.append(el("div", "sub", i.result)); row.append(b);
        const re = el("button", "ghost", "↩"); re.title = "Back to the queue"; re.onclick = () => after(act(i.id, projSel.value, "reopen")); row.append(re); return row;
      }) : [el("div", "empty", q.value ? "Nothing matches." : "Nothing finished here yet.")]));
    } catch (e) { if (e.message !== "mockup") list.replaceChildren(el("div", "empty", e.message)); }
  };
  let t; q.oninput = () => { clearTimeout(t); t = setTimeout(run, 200); }; projSel.onchange = run;
  box.append(bar, list); run(); q.focus();
}
$("histbtn").onclick = toggleHistory;

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
  // The project leads: it says what the session is for. The session's own name (todo, 2e) is the second line of the label.
  const proj = el("button", `proj${sel.projects.has(p.name) ? " on" : ""}`); proj.title = `Show only ${p.name}`; const sw = el("i"); sw.style.background = tagColor(p.name); proj.append(sw, el("span", "", p.name)); proj.onclick = () => toggleIn(sel.projects, p.name); h.append(proj);
  if (s.kind === "chat") { const a = el("a", "name", nameOf(s)); a.href = `/?chat=${encodeURIComponent(s.id)}`; a.title = "Open the chat"; a.onclick = (e) => { e.preventDefault(); openChat(s.id); }; h.append(a); }
  else { h.append(el("span", "name", nameOf(s)), el("span", "kind", "tmux")); }
  const meta = []; if (s.model) meta.push(s.model); meta.push(ago(s.since, now));
  h.append(el("span", "meta", meta.join(" · ")));
  box.append(h);
  const held = p.queue.filter((i) => i.status === "claimed" && i.claimedBy === keyOf(s));
  if (held.length) for (const i of held) box.append(taskCard(s, p, now, i));
  else if (isBusy(s)) box.append(taskCard(s, p, now, null));
  else {
    const slot = el("div", "slot"); slot._root = p.root;
    const next = p.queue.find((i) => i.status === "queued" && !(i.waitingOn && i.waitingOn.length));
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

  // The strip and the boxes in a fixed order — project, then session name — so a box never
  // jumps when its session goes busy or idle (they used to sort by state and age).
  const byName = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });
  const all = b.projects.flatMap((p) => p.sessions.map((s) => ({ s, p }))).sort((x, y) => byName(x.p.name, y.p.name) || byName(nameOf(x.s), nameOf(y.s)));
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
  const autos = b.projects.filter((p) => p.sessions.length);
  if (autos.length) {
    const ar = el("div", "autorow"); ar.append(el("span", "lbl", "Auto-dispatch"));
    for (const p of autos) {
      const on = !!p.auto; const bt = el("button", `autochip${on ? " on" : ""}`, `${on ? "●" : "○"} ${p.name}`);
      bt.title = on ? `On: an idle session in ${p.name} takes the next ready task by itself, but only while nothing there is busy. Click to turn off.` : `Off. Turn on to let an idle session in ${p.name} take the next ready task by itself (only while nothing there is busy).`;
      bt.onclick = () => after(api("/board/auto", { method: "POST", body: JSON.stringify({ root: p.root, on: !on }) }));
      ar.append(bt);
    }
    c1.append(ar);
  }
  if (hiddenQueued) { const h = el("div", "empty"); h.append(`${hiddenQueued} queued task${hiddenQueued === 1 ? "" : "s"} hidden by the filter · `); const x = el("a", "", "clear"); x.href = "#"; x.onclick = (e) => { e.preventDefault(); sel = { sessions: new Set(), projects: new Set(), tmuxOnly: false }; saveFilter(); }; h.append(x); c1.append(h); }

  const c2 = column("progress", "In progress", shown.filter(({ s }) => isBusy(s)).length);
  if (!shown.length) c2.append(el("div", "empty", filtering() ? "No session matches the filter." : "No live session. Open a chat in a project, or a tmux session in its directory."));
  for (const { s, p } of shown) c2.append(sessionBox(s, p, b.at));
  // Claims whose holder is not a live session: kept visible, with a release.
  const orphans = [];
  for (const p of b.projects) for (const i of p.queue) if (i.status === "claimed" && !(i.claimedBy && sessionsByKey.has(i.claimedBy)) && cardShown(p, i.claimedBy)) orphans.push([i, p]);
  if (orphans.length) {
    const ob = el("div", "obox"); const oh = el("div", "sboxhd"); oh.append(el("span", "name", "Held by a session that is not running")); ob.append(oh);
    for (const [i, p] of orphans) ob.append(orphanCard(i, p, b.at));
    c2.append(ob);
  }

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
    const hd = el("div", "hd sess"); const pj = el("span", "proj"); const sw = el("i"); sw.style.background = tagColor(p.name); pj.append(sw, el("span", "", p.name));
    hd.append(el("span", `dot ${stateClass(s)}`), pj, el("span", "name", nameOf(s)), el("span", "n mono", String((doneBy.get(keyOf(s)) || []).length))); col.append(hd);
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
  lastProjects = b.projects.map((p) => ({ name: p.name, root: p.root }));
  atEl.textContent = `as of ${clock(b.at)}`;
  const kp = $("keeper"); kp.replaceChildren();
  if (b.keeper) {
    const k = b.keeper; kp.append(el("span", "", `keeper · ${k.calls} read${k.calls === 1 ? "" : "s"} today${k.paused ? " · paused" : ""}`));
    const bt = el("button", "ghost", k.paused ? "resume" : "pause"); bt.title = k.paused ? "Let the keeper read threads again" : "Stop the keeper's model reads (they draw on the subscription); cards already made stay";
    bt.onclick = () => after(api("/board/keeper", { method: "POST", body: JSON.stringify({ paused: !k.paused }) })); kp.append(bt);
  }
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

let pendingImages = [];
const drawPending = () => { $("gimgs").replaceChildren(pendingImages.length ? thumbs(pendingImages, (p) => { pendingImages = pendingImages.filter((x) => x !== p); drawPending(); }) : ""); };
$("gtext").addEventListener("paste", async (e) => {
  const f = imagesIn(e); if (!f.length) return; e.preventDefault();
  for (const file of f) { try { pendingImages.push(await uploadImage(file)); drawPending(); } catch (err) { if (err.message !== "mockup") show(err.message); } }
});
$("gadd").onclick = async () => {
  const t = $("gtext").value.trim(), project = $("gproject").value;
  if (!t) return; if (!project) { show("Pick a project first"); $("gproject").focus(); return; }
  try { await api("/todos", { method: "POST", body: JSON.stringify({ project, text: t, ...(pendingImages.length ? { images: pendingImages } : {}) }) }); $("gtext").value = ""; pendingImages = []; drawPending(); toast("Added"); refresh(true); } catch (e) { if (e.message !== "mockup") show(e.message); }
};
$("gtext").onkeydown = (e) => { if (e.key === "Enter") $("gadd").click(); };
$("gtext").onfocus = () => { busyEditing = true; }; $("gtext").onblur = () => { busyEditing = false; };

refresh(true).then(schedule);
