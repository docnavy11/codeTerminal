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
    const d = el("div"); const c = el("code", "", v); d.append(c); if (copy) d.append(copyButton(v)); root.append(d);
  }
}

async function load() {
  let s;
  try {
    const r = await fetch("/setup");
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    s = await r.json();
  } catch (e) { $("err").textContent = String(e.message ?? e); $("err").hidden = false; return; }

  const sum = $("summary");
  sum.className = "summary " + (s.ready ? "ok" : "bad");
  sum.textContent = s.ready
    ? `Ready — code terminal ${s.version}, ${s.mode} mode, ${s.chats} chat${s.chats === 1 ? "" : "s"}.`
    : "Something needs fixing before this works — see the red item.";

  const order = ["node", "login", "tools", "network", "extension", "schedules", "notifications", "mobile", "service", "paths", "permissions"];
  const box = $("checks"); box.replaceChildren();
  for (const k of order) {
    const c = s.checks[k]; if (!c) continue;
    const row = el("div", `check ${c.level}`);
    row.append(el("span", "dot"));
    const body = el("div"); body.append(el("div", "t", c.text));
    if (c.hint) body.append(el("div", "h", c.hint));
    if (k === "extension" && !s.extension.connected.length) {
      const d = el("div", "h"); d.append("Address for the extension: "); d.append(el("code", "", s.urls.extension[0])); d.append(copyButton(s.urls.extension[0])); body.append(d);
    }
    row.append(body); box.append(row);
  }

  $("u-ui").textContent = s.urls.ui; $("u-m").textContent = s.urls.mobile;
  kv($("kv"), [
    ["terminal", s.urls.ui, true],
    ["phone", s.urls.mobile, true],
    ["manage", s.urls.manage, false],
    ...s.urls.extension.map((u, i) => [i ? "" : "extension", u, true]),
    ["accepted origins", s.origins.join("  "), false],
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
