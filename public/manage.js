/**
 * The curation surface. The popovers in the main UI are for grabbing a prompt
 * mid-flow; this is for the jobs that need room — renaming, bulk tidying, and
 * writing a prompt body longer than one line.
 */
const $ = (id) => document.getElementById(id);
const errBox = $("err");

const show = (msg) => { errBox.textContent = msg; errBox.hidden = !msg; };

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
  const q = Object.assign(el("input"), { type: "search", placeholder: "Search titles…", value: chatState.q });
  q.oninput = () => { chatState.q = q.value; renderChats(); q.focus(); };
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
  host.append(bar);

  if (!shown.length) { host.append(el("div", "empty", "Nothing matches.")); return; }

  for (const c of shown) {
    const row = el("div", "row" + (c.id === chatState.active ? " active" : ""));
    const main = el("div", "main");
    main.append(el("div", "title", c.title));
    main.append(el("div", "meta",
      `${c.turns} turn${c.turns === 1 ? "" : "s"} · ${ago(c.updatedAt)}${c.cwd ? ` · ${c.cwd}` : ""}`));
    row.append(main);
    row.append(el("span", "tag", c.project ?? "general"));

    const rename = el("button", "", "rename");
    rename.onclick = async () => {
      const t = prompt("Rename this chat", c.title);
      if (!t?.trim()) return;
      try { await api(`/chats/${c.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: t.trim() }) }); show(""); await loadChats(); }
      catch (e) { show(e.message); }
    };

    // Moving a chat rebuilds its session, so the server only allows it on the
    // chat that is currently open. Say so rather than failing cryptically.
    const move = el("select");
    move.append(new Option(c.id === chatState.active ? "move to…" : "move (open it first)", ""));
    if (c.id === chatState.active) for (const p of chatState.projects) move.append(new Option(p.name, p.id));
    move.disabled = c.id !== chatState.active;
    move.onchange = async () => {
      if (!move.value) return;
      try { await api(`/chats/${c.id}`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: move.value }) }); show(""); await loadChats(); }
      catch (e) { show(e.message); move.value = ""; }
    };

    const del = el("button", "danger", "delete");
    del.onclick = async () => {
      if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;
      try { await api(`/chats/${c.id}`, { method: "DELETE" }); show(""); await loadChats(); }
      catch (e) { show(e.message); }
    };

    row.append(rename, move, del);
    host.append(row);
  }
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
  const add = el("button", "", "+ new prompt");
  add.onclick = () => { promptState.editing = { title: "", text: "", domains: [] }; renderPrompts(); };
  bar.append(add, el("span", "count", `${promptState.all.length} saved`));
  host.append(bar);

  if (promptState.editing) host.append(promptEditor());

  for (const p of promptState.all) {
    const row = el("div", "row");
    const main = el("div", "main");
    main.append(el("div", "title", p.title));
    main.append(el("div", "meta", p.text.replace(/\s+/g, " ").slice(0, 120)));
    row.append(main);
    row.append(el("span", "tag", p.domains.length ? p.domains.join(" ") : "everywhere"));

    const edit = el("button", "", "edit");
    edit.onclick = () => { promptState.editing = { ...p }; renderPrompts(); window.scrollTo(0, 0); };
    const del = el("button", "danger", "delete");
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
  const save = el("button", "", e.id ? "Save changes" : "Create");
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
  const [{ projects, active }, { chats }] = await Promise.all([api("/projects"), api("/chats")]);
  const host = $("projects");
  host.replaceChildren();

  const counts = new Map();
  for (const c of chats) {
    const k = c.project ?? "general";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

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
      row.append(el("span", "tag", `${counts.get(p.id) ?? 0} chats`));
      const see = el("button", "", "see chats");
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

/* ---------------- tabs ---------------- */
const loaders = { chats: loadChats, prompts: loadPrompts, projects: loadProjects };

function tab(name) {
  for (const b of document.querySelectorAll("nav button")) b.classList.toggle("on", b.dataset.tab === name);
  for (const id of ["chats", "prompts", "projects"]) $(id).hidden = id !== name;
  show("");
  loaders[name]().catch((e) => show(e.message));
}
for (const b of document.querySelectorAll("nav button")) b.onclick = () => tab(b.dataset.tab);

tab("chats");
