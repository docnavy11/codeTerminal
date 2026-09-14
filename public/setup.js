const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

function copyButton(text) {
  const b = el("button", "copy", "copy");
  b.onclick = async () => { try { await navigator.clipboard.writeText(text); b.textContent = "copied"; setTimeout(() => (b.textContent = "copy"), 1200); } catch { b.textContent = "select it"; } };
  return b;
}

function kv(root, rows) {
  root.replaceChildren();
  for (const [k, v, copy] of rows) {
    root.append(el("div", "k", k));
    const d = el("div");
    // A list of addresses is a list, not one long line of them.
    if (Array.isArray(v)) { d.className = "chips"; for (const one of v) d.append(el("code", "", one)); }
    else { d.append(el("code", "", v)); if (copy) d.append(copyButton(v)); }
    root.append(d);
  }
}

/* The checks in the order they matter, grouped by the question they answer.
   Eleven cards in one column was a list nobody read to the end; four short
   groups can be scanned for the one that is red. */
const GROUPS = [
  ["Does it run", ["node", "login", "tools"]],
  ["Who can reach it", ["network", "extension", "mobile"]],
  ["What it may do", ["permissions", "browser"]],
  ["Working on its own", ["schedules", "notifications"]],
  ["This machine", ["service", "paths"]],
];

async function load() {
  let s;
  try {
    const r = await fetch("/setup");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    s = await r.json();
  } catch (e) {
    $("err").textContent = String(e.message ?? e); $("err").hidden = false;
    $("dot").classList.add("off");
    return;
  }
  $("err").hidden = true; $("dot").classList.remove("off");

  /* The banner answers "can I use this", then the facts. When it cannot, the
     failing check's own words go here, so the fix is readable without
     hunting for the red card. */
  const bad = Object.values(s.checks).filter((c) => c.level === "bad");
  const warn = Object.values(s.checks).filter((c) => c.level === "warn");
  const sum = $("summary");
  sum.className = "summary " + (s.ready ? "ok" : "bad");
  sum.replaceChildren(
    el("span", "state", s.ready ? "Ready" : "Something needs fixing"),
    el("span", "facts", s.ready
      ? `code terminal ${s.version} · ${s.mode} mode · ${s.chats} chat${s.chats === 1 ? "" : "s"}${warn.length ? ` · ${warn.length} thing${warn.length === 1 ? "" : "s"} worth knowing below` : ""}`
      : bad.map((c) => c.text).join(" · ")));

  const box = $("checks"); box.replaceChildren();
  const seen = new Set();
  for (const [label, keys] of GROUPS) {
    const have = keys.filter((k) => s.checks[k]);
    if (!have.length) continue;
    const g = el("div", "group");
    g.append(el("div", "glabel", label));
    const list = el("div", "checks");
    for (const k of have) {
      seen.add(k);
      const c = s.checks[k];
      const row = el("div", `check ${c.level}`);
      row.append(el("span", "dot"));
      const body = el("div");
      body.append(el("div", "t", c.text));
      if (c.hint) body.append(el("div", "h", c.hint));
      if (k === "extension" && !s.extension.connected.length) {
        const d = el("div", "h"); d.append("Address for the extension: ");
        d.append(el("code", "", s.urls.extension[0])); d.append(copyButton(s.urls.extension[0]));
        body.append(d);
      }
      row.append(body); list.append(row);
    }
    g.append(list); box.append(g);
  }
  // A check the server grows that this page has not been taught about still shows.
  const rest = Object.keys(s.checks).filter((k) => !seen.has(k));
  if (rest.length) {
    const g = el("div", "group"); g.append(el("div", "glabel", "Other"));
    const list = el("div", "checks");
    for (const k of rest) {
      const c = s.checks[k];
      const row = el("div", `check ${c.level}`); row.append(el("span", "dot"));
      const body = el("div"); body.append(el("div", "t", c.text));
      if (c.hint) body.append(el("div", "h", c.hint));
      row.append(body); list.append(row);
    }
    g.append(list); box.append(g);
  }

  $("u-ui").textContent = s.urls.ui; $("u-m").textContent = s.urls.mobile;
  kv($("kv"), [
    ["terminal", s.urls.ui, true],
    ["phone", s.urls.mobile, true],
    ["manage", s.urls.manage, false],
    ...s.urls.extension.map((u, i) => [i ? "" : "extension", u, true]),
    ["accepted origins", s.origins, false],
    ["extension pin", s.extension.pinned ?? "any extension id (CODETERM_EXT_ORIGIN pins one)", false],
  ]);
  kv($("paths"), [
    ["workspace", `${s.paths.workspace.path}${s.paths.workspace.exists ? "" : "  (missing)"}`, false],
    ["files root", `${s.paths.filesRoot.path}${s.paths.filesRoot.exists ? "" : "  (missing)"}`, false],
    ["projects", `${s.paths.projectsRoot.path}${s.paths.projectsRoot.exists ? "" : "  (missing)"}`, false],
    ["login file", `${s.login.path}${s.login.credentials ? "" : "  (missing)"}`, false],
  ]);
}
load();
setInterval(load, 5000);
