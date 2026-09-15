/**
 * The curation surface. The popovers in the main UI are for grabbing a prompt
 * mid-flow; this is for the jobs that need room — renaming, bulk tidying, and
 * writing a prompt body longer than one line.
 */
const $ = (id) => document.getElementById(id);
const errBox = $("err");

const show = (msg) => { errBox.textContent = msg; errBox.hidden = !msg; };

/* One dim sentence per section, in the same place every time, instead of the
   paragraph some sections had and others did not. A loader can replace it
   when the truth depends on the state (the site gate being off). */
const CAPTIONS = {
  chats: "Every conversation on this server: search them, rename them, move one to another project, or read one through without opening the terminal.",
  prompts: "Prompts you keep. They appear in the ⌘ menu in a chat, filtered by the site you are on. {url} {title} {host} {selection} are filled from the active tab.",
  projects: "A project is a directory under the projects root — discovered, not created. A chat points at one, and works there.",
  browser: "The sites the browser tools may use without asking, and at what level.",
  server: "A Chromium running on this machine, headless, with its own profile — so a chat can browse while your laptop is off. Log in through the live view once; the session stays in the profile.",
  schedules: "A prepared prompt that runs by itself at the times you set, in a chat of its own. Every run appears in the chat list, named after the schedule and the time.",
};
const setCaption = (text) => { $("caption").textContent = text; };
/* Counts on the tabs themselves, so the navigation reports what is behind it. */
const setCount = (tab, n) => { const el = $("n-" + tab); if (el) el.textContent = n == null ? "" : String(n); };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const ago = (ms) => {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

/* ---------------- chats ---------------- */
let chatState = { chats: [], projects: [], active: null, q: "", project: "" };

async function loadChats() {
  Object.assign(chatState, await api("/chats"));
  renderChats();
}

function renderChats() {
  const host = $("chats");
  host.replaceChildren();

  const bar = el("div", "bar");
  const q = Object.assign(el("input"), { type: "search", placeholder: "Search titles and transcripts…", value: chatState.q });
  q.oninput = () => { chatState.q = q.value; renderChats(); q.focus(); scheduleTranscriptSearch(); };
  const proj = el("select");
  proj.append(new Option("All projects", ""));
  for (const p of chatState.projects) proj.append(new Option(p.name, p.id));
  proj.value = chatState.project;
  proj.onchange = () => { chatState.project = proj.value; renderChats(); };
  bar.append(q, proj);

  const shown = chatState.chats.filter((c) => {
    const okQ = !chatState.q || c.title.toLowerCase().includes(chatState.q.toLowerCase());
    const okP = !chatState.project ||
      (chatState.project === "general" ? !c.project : c.project === chatState.project);
    return okQ && okP;
  });
  bar.append(el("span", "count", `${shown.length} of ${chatState.chats.length}`));
  setCount("chats", chatState.chats.length);
  setCount("projects", chatState.projects.length);
  host.append(bar);

  const found = el("div", "found"); found.id = "found"; host.append(found);
  if (!shown.length) { host.append(el("div", "empty", chatState.q.trim().length >= 2 ? "No titles match." : "Nothing matches.")); return; }

  for (const c of shown) {
    const row = el("div", "row" + (c.id === chatState.active ? " active" : ""));
    const main = el("div", "main");
    main.append(el("div", "title", c.title));
    main.append(el("div", "meta",
      `${c.turns} turn${c.turns === 1 ? "" : "s"} · ${ago(c.updatedAt)}${c.cwd ? ` · ${c.cwd}` : ""}`));
    row.append(main);
    row.append(el("span", "tag", c.project ?? "general"));

    const view = el("button", "quiet", "view");
    view.onclick = () => showChat(c.id);
    const rename = el("button", "quiet", "rename");
    rename.onclick = async () => {
      const t = prompt("Rename this chat", c.title);
      if (!t?.trim()) return;
      try { await api(`/chats/${c.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t.trim() }) }); show(""); await loadChats(); }
      catch (e) { show(e.message); }
    };

    /* Moving a chat rebuilds its session, so the server only allows it on the
       chat that is currently open. A disabled select saying so on every row
       was the widest thing in the list and useful on one row in twelve; the
       control now appears only where it works, and the others say why. */
    let move;
    if (c.id === chatState.active) {
      move = el("select");
      move.append(new Option("move to…", ""));
      for (const p of chatState.projects) move.append(new Option(p.name, p.id));
      move.onchange = async () => {
        if (!move.value) return;
        try { await api(`/chats/${c.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project: move.value }) }); show(""); await loadChats(); }
        catch (e) { show(e.message); move.value = ""; }
      };
    } else {
      move = el("button", "quiet", "move");
      move.onclick = () => show("Open that chat in the terminal first — moving it rebuilds its session, so the server only allows it on the open one.");
    }

    const del = el("button", "quiet danger", "delete");
    del.onclick = async () => {
      if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
      try { await api(`/chats/${c.id}`, { method: "DELETE" }); show(""); await loadChats(); }
      catch (e) { show(e.message); }
    };

    row.append(view, rename, move, del);
    main.style.cursor = "pointer";
    main.onclick = () => showChat(c.id);
    host.append(row);
  }
}

/* ---------------- one chat, read-only ---------------- */

const md = (raw) => DOMPurify.sanitize(marked.parse(raw ?? ""), { USE_PROFILES: { html: true } });

const summarise = (input) => {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command;
  if (typeof input.file_path === "string") return input.file_path;
  return JSON.stringify(input).slice(0, 100);
};

/* Transcript hits, under the title list, from /chats/search (debounced). */
let tsTimer = null;
function scheduleTranscriptSearch() {
  clearTimeout(tsTimer);
  const q = chatState.q.trim();
  if (q.length < 2) return;
  tsTimer = setTimeout(async () => {
    let hits;
    try { hits = (await api(`/chats/search?q=${encodeURIComponent(q)}`)).hits.filter((h) => h.matches.length); } catch { return; }
    const found = $("found"); if (!found || chatState.q.trim() !== q) return;
    found.replaceChildren();
    if (!hits.length) return;
    found.append(el("div", "hint", `in transcripts — ${hits.length} chat${hits.length === 1 ? "" : "s"}`));
    for (const h of hits) {
      const row = el("div", "row");
      const main = el("div", "main");
      main.append(el("div", "title", h.title));
      for (const m of h.matches) main.append(el("div", "meta", `${m.kind === "user" ? "you" : m.kind === "text" ? "claude" : "note"}: ${m.snippet}`));
      row.append(main);
      const view = el("button", "", "view"); view.onclick = () => showChat(h.id);
      row.append(view); found.append(row);
    }
  }, 250);
}

async function showChat(id) {
  const host = $("chats");
  host.replaceChildren();
  let rec;
  try { rec = await api(`/chats/${id}`); }
  catch (e) { show(e.message); return; }

  const wrap = el("div", "detail");
  const hd = el("div", "hd");
  const back = el("button", "", "← all chats");
  back.onclick = () => { renderChats(); };
  const open = el("button", "", "open in the terminal");
  open.onclick = async () => {
    try {
      await api(`/chats/${id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ open: true }) });
      // Naming the chat in the URL as well as marking it open: that is what
      // tells the page you came to read this one, so it does not restore a
      // collapsed transcript over the top of it.
      location.href = `/?chat=${encodeURIComponent(id)}`;
    } catch (e) { show(e.message); }
  };
  const exp = el("button", "", "export .md");
  exp.onclick = () => { const a = document.createElement("a"); a.href = `/chats/${id}/export.md`; a.download = ""; document.body.appendChild(a); a.click(); a.remove(); };
  hd.append(back, open, exp, el("span", "who",
    `${rec.events.filter((e) => e.kind === "user").length} turns · ${rec.project ?? "general"}${rec.cwd ? ` · ${rec.cwd}` : ""}`));
  wrap.append(hd, el("h2", "", rec.title));

  const t = el("div", "transcript");
  // Only the kinds that carry meaning when read back later. status and delta
  // are live-only and never persisted; ready/commands are session state.
  for (const e of rec.events) {
    if (e.kind === "user") {
      t.append(el("div", "u", e.text));
      if (e.context) t.append(el("div", "ctx", "⌁ " + e.context.split("\n")[0]));
    } else if (e.kind === "text") {
      const a = el("div", "a"); a.innerHTML = md(e.text); t.append(a);
    } else if (e.kind === "tool") {
      const d = el("div", "t");
      d.innerHTML = "→ <b></b> ";
      d.querySelector("b").textContent = e.name;
      d.append(summarise(e.input));
      t.append(d);
    } else if (e.kind === "local") {
      t.append(el("div", "l", e.text));
    } else if (e.kind === "turn_end") {
      t.append(el("div", "e", `done${e.denials ? ` · ${e.denials} denied` : ""}`));
    } else if (e.kind === "error") {
      t.append(el("div", "l", e.message));
    }
  }
  if (!t.children.length) t.append(el("div", "empty", "This chat has no messages."));
  wrap.append(t);
  host.append(wrap);
}

/* ---------------- prompts ---------------- */
let promptState = { all: [], editing: null };

async function loadPrompts() {
  const d = await api("/prompts");
  promptState.all = d.all;
  renderPrompts();
}

function renderPrompts() {
  const host = $("prompts");
  host.replaceChildren();

  const bar = el("div", "bar");
  const add = el("button", "primary", "New prompt");
  add.onclick = () => { promptState.editing = { title: "", text: "", domains: [] }; renderPrompts(); };
  bar.append(add, el("span", "count", `${promptState.all.length} saved`));
  setCount("prompts", promptState.all.length);
  host.append(bar);

  if (promptState.editing) host.append(promptEditor());

  for (const p of promptState.all) {
    const row = el("div", "row");
    const main = el("div", "main");
    main.append(el("div", "title", p.title));
    main.append(el("div", "meta", p.text.replace(/\s+/g, " ").slice(0, 120)));
    row.append(main);
    row.append(el("span", "tag", p.domains.length ? p.domains.join(" ") : "everywhere"));

    const edit = el("button", "quiet", "edit");
    edit.onclick = () => { promptState.editing = { ...p }; renderPrompts(); window.scrollTo(0, 0); };
    const del = el("button", "quiet danger", "delete");
    del.onclick = async () => {
      if (!confirm(`Delete "${p.title}"?`)) return;
      try { await api(`/prompts/${p.id}`, { method: "DELETE" }); show(""); await loadPrompts(); }
      catch (e) { show(e.message); }
    };
    row.append(edit, del);
    host.append(row);
  }
}

function promptEditor() {
  const e = promptState.editing;
  const box = el("div", "editor");
  const title = Object.assign(el("input"), { type: "text", value: e.title ?? "", placeholder: "Title" });
  const domains = Object.assign(el("input"),
    { type: "text", value: (e.domains ?? []).join(" "),
      placeholder: "github.com upbudget.be — blank means every page" });
  const text = Object.assign(el("textarea"), { value: e.text ?? "" });

  const actions = el("div", "actions");
  const save = el("button", "primary", e.id ? "Save changes" : "Create");
  save.onclick = async () => {
    try {
      await api("/prompts", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: e.id, title: title.value, text: text.value,
                               domains: domains.value.split(/[\s,]+/).filter(Boolean) }) });
      promptState.editing = null; show(""); await loadPrompts();
    } catch (err) { show(err.message); }
  };
  const cancel = el("button", "", "Cancel");
  cancel.onclick = () => { promptState.editing = null; renderPrompts(); };
  actions.append(save, cancel);

  box.append(el("label", "", "Title"), title,
             el("label", "", "Domains"), domains,
             el("label", "", "Prompt"), text,
             el("div", "hint", "{url} {title} {host} {selection} are filled from the active tab when it runs."),
             actions);
  return box;
}

/* ---------------- projects ---------------- */
async function loadProjects() {
  // The server already orders these by recency and attaches chat counts.
  const { projects, active } = await api("/projects");
  const host = $("projects");
  host.replaceChildren();

  const bar = el("div", "bar");
  const q = Object.assign(el("input"), { type: "search", placeholder: "Filter projects…" });
  bar.append(q, el("span", "count", `${projects.length} projects`));
  host.append(bar);

  const list = el("div");
  host.append(list);

  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    list.replaceChildren();
    // A project is a subdirectory of the projects root — discovered, not
    // created. There is nothing to add here; make a directory instead.
    const shown = projects.filter((p) => p.general || !needle || p.name.toLowerCase().includes(needle));
    for (const p of shown) {
      const row = el("div", "row" + (p.id === active ? " active" : ""));
      const main = el("div", "main");
      main.append(el("div", "title", p.name + (p.general ? "  (chats not tied to a directory)" : "")));
      main.append(el("div", "meta", p.path));
      row.append(main);
      row.append(el("span", "tag",
        p.chats ? `${p.chats} chat${p.chats === 1 ? "" : "s"} · ${ago(p.lastUsed)}` : "unused"));
      const see = el("button", "quiet", "see chats");
      see.onclick = () => {
        chatState.project = p.id; chatState.q = "";
        tab("chats"); renderChats();
      };
      row.append(see);
      list.append(row);
    }
    if (!shown.length) list.append(el("div", "empty", "No project matches."));
  };
  q.oninput = draw;
  draw();
}

/* ---------------- browser sites ----------------
   The standing list the browser tools may use without asking. "Always" on a
   site card adds here; this page adds and removes. */
async function loadBrowser() {
  const { gated, hosts } = await api("/browser-allow");
  const host = $("browser"); host.replaceChildren();
  setCaption(gated
    ? "The sites the browser tools may use without asking. Claude asks once per chat before reading a site that is not here, and again before acting on it (click, type, navigate); eval asks every time. “Always” on that card adds the site at that level. Patterns: example.com or *.example.com."
    : "The site gate is off (CODETERM_BROWSER_GATE=0): browser tools act on any site without asking.");
  setCount("browser", hosts.length);
  const bar = el("div", "bar");
  const input = Object.assign(el("input"), { placeholder: "example.com or *.example.com" });
  const lvl = el("select"); lvl.append(new Option("read", "read"), new Option("read + act", "act")); lvl.value = "read";
  const add = el("button", "primary", "Add");
  const setLevel = async (h, level) => { try { await api("/browser-allow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: h, level }) }); await loadBrowser(); } catch (e) { show(e.message); } };
  add.onclick = async () => { await setLevel(input.value, lvl.value); input.value = ""; };
  input.onkeydown = (e) => { if (e.key === "Enter") add.click(); };
  bar.append(input, lvl, add, el("span", "count", `${hosts.length} site${hosts.length === 1 ? "" : "s"}`));
  host.append(bar);
  if (!hosts.length) { host.append(el("div", "empty", "No sites yet — every site asks the first time a chat uses it.")); return; }
  for (const { host: h, level } of hosts) {
    const row = el("div", "row");
    const main = el("div", "main"); main.append(el("div", "title", h)); main.append(el("div", "meta", level === "act" ? "read + act — may click, type, navigate" : "read only — acting asks")); row.append(main);
    row.append(el("span", "tag", level === "act" ? "read + act" : "read"));
    const sw = el("button", "quiet", level === "act" ? "make read-only" : "allow acting");
    sw.onclick = () => setLevel(h, level === "act" ? "read" : "act");
    const rm = el("button", "quiet danger", "remove");
    rm.onclick = async () => { try { await api(`/browser-allow/${encodeURIComponent(h)}`, { method: "DELETE" }); await loadBrowser(); } catch (e) { show(e.message); } };
    row.append(sw, rm); host.append(row);
  }
}

/* ---------------- server browser ---------------- */
/* A headless Chromium on the server with its own profile: start it, look at
   it (the live view), stop it. Logins made in the live view persist in the
   profile; a chat picks it from the header's browser menu. */
async function loadServer() {
  const st = await api("/browser/server");
  const host = $("server"); host.replaceChildren();

  // Its state and the one button that changes it, on the first line.
  const state = el("div", "state");
  const pill = el("span", "pill " + (st.running ? "ok" : "warn"), st.running ? "running" : "stopped");
  state.append(pill);
  if (st.running) state.append(el("span", "hint", `pid ${st.pid} · ${st.viewers} viewer${st.viewers === 1 ? "" : "s"} · ${st.tabs?.length ?? 0} tab${st.tabs?.length === 1 ? "" : "s"}`));
  const btn = el("button", st.running ? "" : "primary", st.running ? "Stop" : "Start");
  btn.onclick = async () => { btn.disabled = true; try { await api(`/browser/server/${st.running ? "stop" : "start"}`, { method: "POST" }); } catch (e) { show(e.message); } await loadServer(); };
  state.append(btn);
  if (st.running) { const view = el("a", "btnlink", "Open live view ↗"); view.href = "/browser.html"; view.target = "_blank"; state.append(view); }
  host.append(state);

  const panel = el("div", "panel");
  const dl = el("dl", "kv");
  const kv = (k, v) => { dl.append(el("dt", "", k), el("dd", "", v)); };
  kv("Chromium", st.chromium ?? "none found — set CODETERM_CHROMIUM");
  kv("Profile", st.profileDir);
  if (st.extensionId) kv("Extension id inside", st.extensionId);
  if (st.lastError) kv("Last error", st.lastError);
  panel.append(dl); host.append(panel);

  if (st.running && st.tabs?.length) {
    const p2 = el("div", "panel");
    p2.append(el("h3", "", "Open tabs"));
    const ul = el("ul", "tabs-list");
    for (const t of st.tabs) ul.append(el("li", "", `${t.title || "(untitled)"} — ${t.url}`));
    p2.append(ul); host.append(p2);
  }
}

/* ---------------- schedules ---------------- */
/* A prepared prompt that runs by itself: what, when (in words), where
   (project, browser), and what happened last time. Design:
   docs/design-scheduled-prompts.md. */
const fmtWhen = (ms, tz) => { try { return new Date(ms).toLocaleString(undefined, { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return new Date(ms).toISOString(); } };
let schedData = null;
async function loadSchedules() {
  schedData = await api("/schedules");
  const host = $("schedules"); host.replaceChildren();
  setCount("schedules", schedData.schedules.length);

  const bar = el("div", "bar");
  const add = el("button", "primary", "New schedule"); add.onclick = () => schedForm(null);
  bar.append(add);
  // Where a result goes when nobody is looking at this page.
  const nt = await api("/notify");
  const nrow = el("span", "hint"); nrow.id = "notify-row";
  nrow.textContent = nt.targets.length
    ? `Results also go to: ${nt.targets.join(", ")}.`
    : "No phone notifications set — results show here, as a strip in open chats, and as an extension notification.";
  bar.append(nrow);
  if (nt.targets.length) {
    const t = el("button", "quiet", "send test");
    t.onclick = async () => { t.disabled = true; try { const r = await api("/notify/test", { method: "POST" }); t.textContent = r.failed.length ? `failed: ${r.failed.map((f) => f.target + " " + f.error).join("; ")}` : `sent to ${r.sent.join(", ")}`; } catch (e) { t.textContent = e.message; } };
    bar.append(t);
  }
  bar.append(el("span", "count", `${schedData.schedules.length} schedule${schedData.schedules.length === 1 ? "" : "s"}`));
  host.append(bar);
  const formHost = el("div"); formHost.id = "schedform"; host.append(formHost);
  if (!schedData.schedules.length) { host.append(el("div", "empty", "No schedules yet — “New schedule” runs one of your prompts on a clock.")); return; }
  for (const s of schedData.schedules) host.append(schedCard(s));
}
/* One schedule: what it is and when, then what happened last time. The
   earlier runs are a table, not a bulleted list — four facts a line that
   ought to line up. */
function schedCard(s) {
  const card = el("div", "sched" + (s.paused ? " paused" : ""));
  const top = el("div", "top");
  top.append(el("b", "", s.title));
  top.append(el("span", "when",
    `${s.words} · ${s.when.tz}${s.paused ? " · paused" : s.nextAt ? ` · next ${fmtWhen(s.nextAt, s.when.tz)}` : ""}`));
  top.append(el("span", "sp"));
  const tag = el("span", "tag", `${s.project} · ${s.browser === "server" ? "server browser" : "any browser"} · ${s.mode}`);
  top.append(tag);

  const run = el("button", "quiet", s.running ? "Running…" : "Run now"); run.disabled = !!s.running;
  run.onclick = async () => { run.disabled = true; try { await api(`/schedules/${s.id}/run`, { method: "POST" }); } catch (e) { show(e.message); } setTimeout(loadSchedules, 400); };
  const pause = el("button", "quiet", s.paused ? "Resume" : "Pause");
  pause.onclick = async () => { try { await api(`/schedules/${s.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: !s.paused }) }); } catch (e) { show(e.message); } loadSchedules(); };
  const ed = el("button", "quiet", "Edit"); ed.onclick = () => schedForm(s);
  const rm = el("button", "quiet danger", "Delete");
  rm.onclick = async () => { if (!confirm(`Delete the schedule "${s.title}"? Its run chats stay.`)) return; try { await api(`/schedules/${s.id}`, { method: "DELETE" }); } catch (e) { show(e.message); } loadSchedules(); };
  top.append(run, pause, ed, rm);
  card.append(top);

  const last = s.runs[0];
  if (!last) { card.append(el("div", "note", "Never run yet — “Run now” tries it before the clock does.")); return card; }

  const l = el("div", "last");
  l.append(el("span", `o ${last.outcome}`, last.outcome.replace("-", " ")));
  const txt = el("div", "txt");
  txt.append(el("span", "", last.summary || "(no reply)"));
  l.append(txt);
  const facts = el("span", "hint",
    `${fmtWhen(last.startedAt, s.when.tz)}${last.endedAt && last.outcome !== "running" ? ` · ${Math.round((last.endedAt - last.startedAt) / 1000)}s` : ""}${last.costUsd != null ? ` · $${last.costUsd.toFixed(2)}` : ""}`);
  l.append(facts);
  if (last.chatId) { const a = el("a", "", "open chat"); a.href = `/?chat=${encodeURIComponent(last.chatId)}`; l.append(a); }
  for (const f of last.files) { const a = el("a", "", f.split("/").pop()); a.href = `/files/read?path=${encodeURIComponent(f)}`; l.append(a); }
  card.append(l);

  if (last.needed.length) {
    const n = el("div", "note"); n.append(el("b", "", "needed: "), document.createTextNode(last.needed.join(", ") + " — add these on the Browser sites tab, then run again"));
    card.append(n);
  }
  if (last.cards.length) {
    const n = el("div", "note"); n.append(el("b", "", "answered “no” for you: "), document.createTextNode(last.cards.join(", ")));
    card.append(n);
  }

  if (s.runs.length > 1) {
    const t = el("table", "runs");
    for (const r of s.runs.slice(1, 8)) {
      const tr = el("tr");
      tr.append(el("td", "", fmtWhen(r.startedAt, s.when.tz)));
      tr.append(el("td", "", r.outcome.replace("-", " ")));
      tr.append(el("td", "c", r.costUsd != null ? `$${r.costUsd.toFixed(2)}` : ""));
      tr.append(el("td", "s", r.summary || ""));
      t.append(tr);
    }
    card.append(t);
  }
  return card;
}

/* The form asks four questions in four labelled groups — what, when, where,
   and the limits — because twelve fields in one grid is a form nobody reads.
   Field ids are stable (#sf-*): the browser suite drives this form. */
function schedForm(s) {
  const host = $("schedform"); host.replaceChildren();
  const f = el("form", "sched-form");
  const tz = s?.when.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const group = (name) => {
    const fs = el("fieldset"); fs.append(el("div", "glabel", name));
    const fields = el("div", "fields"); fs.append(fields); f.append(fs); return fields;
  };
  const row = (fs, label, node, full) => {
    const l = el("label", "", label);
    if (full) { l.className = "full"; node.classList.add("full"); }
    fs.append(l, node); return node;
  };

  const what = group("What it runs");
  const title = row(what, "Title", Object.assign(el("input"), { value: s?.title || "", placeholder: "Search for jobs", id: "sf-title" }));
  const pick = el("select"); pick.id = "sf-prompt";
  pick.append(new Option("— type the prompt below —", ""));
  for (const p of schedData.prompts) pick.append(new Option(p.title, p.id));
  pick.value = s?.promptId || ""; row(what, "Prepared prompt", pick);
  const text = row(what, "Prompt", Object.assign(el("textarea"), { value: s?.prompt || "", id: "sf-text", placeholder: "What to do, as you would type it in a chat" }), true);
  pick.onchange = async () => { if (!pick.value) return; const all = await api("/prompts"); const p = (all.all || []).find((x) => x.id === pick.value); if (p) { text.value = p.text; if (!title.value) title.value = p.title; } };
  const latest = el("label", "inline");
  const latestCb = Object.assign(el("input"), { type: "checkbox", checked: !!s?.useLatest, id: "sf-latest" });
  latest.append(latestCb, document.createTextNode("Always use the prepared prompt's current text"));
  what.append(latest);

  const whenG = group("When");
  const when = row(whenG, "Repeat", Object.assign(el("input"), { value: s?.when.text || "every day at 08:00", id: "sf-when", placeholder: "every day at 08:00 · weekdays at 07:30 · every monday at 9 · every 6 hours · 30 7 * * 1-5" }));
  const tzIn = row(whenG, "Time zone", Object.assign(el("input"), { value: tz, id: "sf-tz" }));
  const preview = el("div", "preview"); preview.id = "sf-preview"; whenG.append(preview);
  const showPreview = async () => {
    try { const r = await api(`/schedules/preview?when=${encodeURIComponent(when.value)}&tz=${encodeURIComponent(tzIn.value)}`);
      preview.className = "preview"; preview.textContent = `${r.words} — next: ${r.next.map((n) => fmtWhen(Date.parse(n), tzIn.value)).join(", ")}`; }
    catch (e) { preview.className = "preview bad"; preview.textContent = e.message; }
  };
  when.oninput = tzIn.oninput = () => { clearTimeout(f._t); f._t = setTimeout(showPreview, 300); }; showPreview();

  const where = group("Where it runs");
  const proj = el("select"); proj.id = "sf-project";
  for (const p of schedData.projects) proj.append(new Option(p.name, p.id));
  proj.value = s?.project || "general"; row(where, "Project", proj);
  const br = el("select"); br.id = "sf-browser";
  br.append(new Option("server browser (runs while your laptop is off)", "server"), new Option("whichever browser is connected", "auto"));
  br.value = s?.browser || "server"; row(where, "Browser", br);
  const mode = el("select"); mode.id = "sf-mode";
  for (const [v, l] of [["auto", "Auto — the CLI decides what is safe (shell commands run)"],
                        ["acceptEdits", "Build, auto-accept edits (shell asks — answered “no” unattended)"],
                        ["default", "Build (asks — answered “no” unattended)"],
                        ["bypassPermissions", "Never ask"], ["plan", "Plan"]]) mode.append(new Option(l, v));
  mode.value = s?.mode || "auto"; row(where, "Mode", mode);
  const model = row(where, "Model", Object.assign(el("input"), { value: s?.model || "", id: "sf-model", placeholder: "default" }));

  const limits = group("Limits");
  const trio = el("div", "trio"); limits.append(trio);
  const numField = (label, id, value, attrs) => {
    const wrap = el("div"); wrap.append(el("label", "", label));
    const inp = Object.assign(el("input"), { id, value, type: "number", ...attrs });
    wrap.append(inp); trio.append(wrap); return inp;
  };
  const budget = numField("Budget per run ($)", "sf-budget", s?.budgetUsd ?? "", { step: "0.1", min: "0.01", placeholder: "none" });
  const wait = numField("Wait for a person (min)", "sf-wait", String((s?.waitMs ?? 600000) / 60000), { min: "1", max: "60" });
  const maxm = numField("Max run time (min)", "sf-max", String((s?.maxMs ?? 1800000) / 60000), { min: "1", max: "360" });
  const keep = row(limits, "Run chats to keep", Object.assign(el("input"), { id: "sf-keep", value: String(s?.keepRuns ?? 10), type: "number", min: "1", max: "100" }));
  limits.append(el("div", "hint", "Nobody answers cards during a run: a site not on the allowed list is refused and recorded, and any other card is answered “no” after the wait."));

  const btns = el("div", "formrow");
  const save = el("button", "primary", s ? "Save" : "Create"); save.type = "submit";
  const cancel = el("button", "", "Cancel"); cancel.type = "button"; cancel.onclick = () => host.replaceChildren();
  btns.append(save, cancel); f.append(btns);

  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { title: title.value, prompt: text.value, promptId: pick.value || undefined, useLatest: latestCb.checked, when: { text: when.value, tz: tzIn.value }, project: proj.value, browser: br.value, mode: mode.value, model: model.value || undefined,
      budgetUsd: budget.value ? Number(budget.value) : undefined, waitMs: Number(wait.value) * 60000, maxMs: Number(maxm.value) * 60000, keepRuns: Number(keep.value) };
    try { await api(s ? `/schedules/${s.id}` : "/schedules", { method: s ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); host.replaceChildren(); loadSchedules(); }
    catch (err) { show(err.message); }
  };
  host.append(f); title.focus();
}


/* ---------------- tabs ---------------- */
const loaders = { chats: loadChats, prompts: loadPrompts, projects: loadProjects, browser: loadBrowser, server: loadServer, schedules: loadSchedules };

function tab(name) {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const id of ["chats", "prompts", "projects", "browser", "server", "schedules"]) $(id).hidden = id !== name;
  show("");
  setCaption(CAPTIONS[name] ?? "");
  loaders[name]()
    .then(() => $("dot").classList.remove("off"))
    .catch((e) => { show(e.message); $("dot").classList.add("off"); });
}
for (const b of document.querySelectorAll("nav button")) b.onclick = () => tab(b.dataset.tab);

tab("chats");
