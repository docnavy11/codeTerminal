import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "node:net";
import { startTestServer, freePort, type TestServer } from "./fakes/server.js";
import { boot, DENY_LOG_BURST } from "../src/server.js";
import { AuthRefused } from "../src/auth.js";
import { settle } from "./fakes/sdk.js";

/** The HTTP and upgrade surface, booted in-process with a fake SDK. */
let s: TestServer;
before(async () => { s = await startTestServer(); });
after(async () => { await s.stop(); });

describe("headers and static", () => {
  test("every response carries the CSP, nosniff and same-origin referrer", async () => {
    for (const p of ["/", "/m/app.js", "/chats", "/nope"]) {
      const r = await s.req(p);
      // express's 404 page carries its own, stricter CSP (default-src 'none'); ours is on everything else
      if (p !== "/nope") assert.match(r.headers.get("content-security-policy") ?? "", /connect-src 'self'/, p);
      else assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/, p);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", p);
      assert.equal(r.headers.get("referrer-policy"), "same-origin", p);
    }
  });
  test("/m redirects to the mobile page; /m/app.js is the panel script itself", async () => {
    const r = await s.req("/m", { redirect: "manual" });
    assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/m.html");
    const js = await (await s.req("/m/app.js")).text();
    assert.ok(js.includes("PLATFORM"));
    assert.equal(js, await readFile("extension/sidepanel.js", "utf8"));
  });
  test("static pages stay open cross-site; API routes do not", async () => {
    const xs = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    assert.equal((await s.req("/", { headers: xs })).status, 200);
    assert.equal((await s.req("/chats", { headers: xs })).status, 403);
    assert.equal((await s.req("/files/list", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await s.req("/chats", { headers: { origin: s.origin } })).status, 200);
    assert.equal((await s.req("/chats")).status, 200, "loopback with no Origin (curl) is fine in localhost mode");
  });
  test("refusals are logged at most DENY_LOG_BURST times a minute", async () => {
    const before = s.warns.filter((w) => w.startsWith("[deny]")).length;
    for (let i = 0; i < DENY_LOG_BURST + 15; i++) await s.req("/chats", { headers: { "sec-fetch-site": "cross-site" } });
    const lines = s.warns.filter((w) => w.startsWith("[deny]")).length - before;
    assert.ok(lines <= DENY_LOG_BURST, `${lines} lines`);
  });
});

describe("/chats", () => {
  test("list, read, 404s for unknown and malformed ids", async () => {
    const c = s.running.convo.create(); c.recordUser("hi there");
    const list = await s.json("/chats");
    assert.equal(list.status, 200);
    assert.ok((list.body!.chats as { id: string }[]).some((x) => x.id === c.id));
    assert.ok((list.body!.projects as { id: string }[]).some((x) => x.id === "p1"));
    assert.equal((await s.json(`/chats/${c.id}`)).body!.title, "hi there");
    assert.equal((await s.json("/chats/aaaaaaaa-0000-0000-0000-00000000dead")).status, 404);
    assert.equal((await s.json("/chats/..%2F..%2Fetc")).status, 404);
  });
  test("rename / project / open edit a cold record without spawning; bad input is 400", async () => {
    const c = s.running.convo.create(); c.recordUser("cold soon"); const id = c.id;
    s.running.convo.shutdown(); await settle();
    const spawned = s.sdk.queries.length;
    assert.equal((await s.post(`/chats/${id}`, { title: "Renamed" })).status, 200);
    assert.equal((await s.post(`/chats/${id}`, { project: "p2" })).status, 200);
    assert.equal((await s.post(`/chats/${id}`, { open: true })).status, 200);
    assert.equal(s.sdk.queries.length, spawned, "no subprocess for a record edit");
    const rec = JSON.parse(await readFile(join(s.root, "chats", `${id}.json`), "utf8"));
    assert.equal(rec.title, "Renamed"); assert.equal(rec.project, "p2"); assert.equal(rec.cwd, join(s.root, "projects", "p2"));
    assert.equal(s.running.convo.newestId(), id);
    assert.equal((await s.post(`/chats/${id}`, { title: "   " })).status, 400);
    assert.equal((await s.post("/chats/aaaaaaaa-0000-0000-0000-00000000dead", { title: "x" })).status, 400);
    assert.equal((await s.post(`/chats/${id}`, { project: "nope" })).status, 200, "an unknown project falls back to General");
    const r = await s.req(`/chats/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    assert.equal(r.status, 400);
  });
  test("delete archives; deleting twice or a bad id is not an error", async () => {
    const c = s.running.convo.create(); c.recordUser("bye");
    assert.equal((await s.json(`/chats/${c.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await s.json(`/chats/${c.id}`)).status, 404);
    assert.ok((await readdir(join(s.root, "chats-archive"))).some((f) => f.startsWith(c.id)));
    assert.equal((await s.json(`/chats/${c.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await s.json("/chats/zzz", { method: "DELETE" })).status, 200);
  });
});

describe("/setup", () => {
  test("reports the running configuration and is guarded", async () => {
    const r = await s.json("/setup");
    assert.equal(r.status, 200);
    assert.equal(r.body!.mode, "localhost"); assert.equal(r.body!.port, s.port);
    assert.equal((r.body!.urls as { ui: string }).ui, `http://127.0.0.1:${s.port}/`);
    assert.deepEqual((r.body!.urls as { extension: string[] }).extension, [`ws://127.0.0.1:${s.port}/ext`]);
    const checks = r.body!.checks as Record<string, { level: string }>;
    assert.equal(checks.network.level, "ok"); assert.equal(checks.service.level, "warn");
    assert.equal((r.body!.login as { path: string }).path, join(s.root, "home", ".claude", ".credentials.json"));
    assert.equal(checks.login.level, "bad", "the test home has no login");
    assert.equal(r.body!.ready, false);
    assert.equal((await s.req("/setup", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await s.req("/setup.html")).status, 200);
  });
  test("extension and readiness flip the checks live", async () => {
    const ext = await s.socket("/ext", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
    ext.send({ type: "hello", instance: "browser-S" }); await settle(4);
    const c = s.running.convo.create(); s.sdk.last.init("sid-setup"); await settle(4);
    const r = await s.json("/setup");
    const checks = r.body!.checks as Record<string, { level: string; text: string }>;
    assert.equal(checks.extension.level, "ok");
    assert.ok((r.body!.extension as { connected: string[] }).connected.includes("browser-S"));
    assert.equal((r.body!.login as { readySeen: boolean }).readySeen, true);
    ext.ws.close(); await ext.closed; s.running.convo.remove(c.id);
  });
});

describe("/chats/search and export", () => {
  test("search finds text across chats; short queries are 400; export is a Markdown attachment", async () => {
    const c = s.running.convo.create(); c.recordUser("where is the kraken hiding?");
    const r = await s.json("/chats/search?q=KRAKEN");
    assert.equal(r.status, 200);
    const hits = r.body!.hits as { id: string; matches: { kind: string; i: number }[] }[];
    assert.ok(hits.some((h) => h.id === c.id && h.matches[0].kind === "user"), "a live, unsaved message is found");
    assert.equal((await s.json("/chats/search?q=k")).status, 400);
    assert.equal((await s.json("/chats/search")).status, 400);
    const e = await s.req(`/chats/${c.id}/export.md`);
    assert.equal(e.status, 200);
    assert.match(e.headers.get("content-type") ?? "", /text\/markdown/);
    assert.match(e.headers.get("content-disposition") ?? "", /attachment; filename="where-is-the-kraken-hiding\.md"/);
    const md = await e.text();
    assert.ok(md.startsWith("# where is the kraken hiding?\n"));
    assert.ok(md.includes("**You**\n\nwhere is the kraken hiding?"));
    assert.equal((await s.req("/chats/aaaaaaaa-0000-0000-0000-00000000dead/export.md")).status, 404);
    assert.equal((await s.req("/chats/search", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  });
});

describe("/browser-allow", () => {
  test("lists the seed, adds and removes, refuses junk; the setup page counts it", async () => {
    assert.deepEqual((await s.json("/browser-allow")).body, { gated: true, hosts: [{ host: "allowed.example", level: "act" }] });
    assert.equal((await s.post("/browser-allow", { host: "https://Docs.Example.com/x", level: "read" })).body!.added, true);
    assert.equal((await s.post("/browser-allow", { host: "bad host" })).status, 400);
    assert.equal((await s.post("/browser-allow", { host: "docs.example.com", level: "root" })).status, 400);
    assert.deepEqual((await s.json("/browser-allow")).body!.hosts, [{ host: "allowed.example", level: "act" }, { host: "docs.example.com", level: "read" }]);
    assert.equal((await s.post("/browser-allow", { host: "docs.example.com", level: "act" })).body!.added, true, "raised");
    assert.equal((await s.post("/browser-allow", { host: "docs.example.com", level: "read" })).body!.added, true, "lowered via set");
    assert.deepEqual(((await s.json("/browser-allow")).body!.hosts as { level: string }[])[1].level, "read");
    assert.equal((await s.json("/browser-allow/docs.example.com", { method: "DELETE" })).body!.removed, true);
    assert.equal((await s.json("/browser-allow/docs.example.com", { method: "DELETE" })).body!.removed, false);
    assert.match(((await s.json("/setup")).body!.checks as Record<string, { text: string }>).browser.text, /1 site allowed without asking/);
    assert.equal((await s.req("/browser-allow", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  });
});

describe("/usage and /prompts", () => {
  test("usage records valid control names only", async () => {
    assert.equal((await s.post("/usage", { control: "newchat" })).body!.ok, true);
    assert.equal((await s.post("/usage", { control: "<script>" })).body!.ok, false);
    assert.equal((await s.post("/usage", {})).body!.ok, false);
    assert.equal(((await s.json("/usage")).body!.counts as Record<string, number>).newchat, 1);
    const big = await s.req("/usage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ control: "x".repeat(2000) }) });
    assert.equal(big.status, 413, "1kb body limit");
  });
  test("prompts: create, list (no extension → no host), update, delete, validation", async () => {
    const seeded = ((await s.json("/prompts")).body!.all as unknown[]).length;   // the store ships defaults
    const made = await s.post("/prompts", { title: "Sum", text: "Summarise {url}", domains: ["https://Example.com/x"] });
    assert.equal(made.status, 200); assert.deepEqual(made.body!.domains, ["example.com"]);
    const list = await s.json("/prompts");
    assert.equal(list.body!.host, ""); assert.equal((list.body!.all as unknown[]).length, seeded + 1);
    assert.ok(!(list.body!.prompts as { id: string }[]).some((p) => p.id === made.body!.id), "a domain-scoped prompt does not apply to no page");
    const upd = await s.post("/prompts", { id: made.body!.id, title: "Sum2", text: "t", domains: [] });
    assert.equal(upd.body!.id, made.body!.id); assert.equal(upd.body!.title, "Sum2");
    assert.equal((await s.post("/prompts", { title: "", text: "x" })).status, 400);
    assert.equal((await s.json(`/prompts/${made.body!.id}`, { method: "DELETE" })).body!.removed, true);
    assert.equal((await s.json(`/prompts/${made.body!.id}`, { method: "DELETE" })).body!.removed, false);
  });
});

describe("/files", () => {
  test("info, list, and the refusals: traversal, denied subtree, missing", async () => {
    const info = await s.json("/files/info");
    assert.equal(info.body!.root, join(s.root, "files")); assert.equal(info.body!.maxUpload, 64 * 1024);
    const list = await s.json("/files/list");
    assert.ok((list.body!.entries as { name: string }[]).some((e) => e.name === "hello.txt"));
    assert.equal((await s.json("/files/list?path=..")).status, 400);
    assert.equal((await s.json("/files/list?path=secret")).status, 400, "the denylist covers listing");
    assert.equal((await s.json("/files/list?path=nope")).status, 400);
    assert.equal((await s.json("/files/list?path=hello.txt")).status, 400, "not a directory");
  });
  test("suggest: matches under a directory; refusals for escapes and the denylist", async () => {
    const r = await s.json("/files/suggest?path=&q=nest");
    assert.equal(r.status, 200); assert.deepEqual(r.body!.files, [{ path: "sub/nested.txt", dir: false }]);
    assert.equal((await s.json("/files/suggest?path=..&q=x")).status, 400);
    assert.equal((await s.json("/files/suggest?path=secret&q=k")).status, 400);
    assert.ok(!((await s.json("/files/suggest?path=&q=key")).body!.files as { path: string }[]).some((f) => f.path.startsWith("secret")), "denied subtree not walked");
  });

  test("read: preview, binary, download headers, and the refusals", async () => {
    const t = await s.json("/files/read?path=hello.txt&preview=1");
    assert.equal(t.body!.kind, "text"); assert.equal(t.body!.text, "hello world\n"); assert.equal(t.body!.truncated, false);
    const b = await s.json("/files/read?path=bin.dat&preview=1");
    assert.equal(b.body!.kind, "binary"); assert.equal(b.body!.bytes, 6);
    const d = await s.req("/files/read?path=sub/nested.txt");
    assert.equal(d.status, 200);
    assert.match(d.headers.get("content-disposition") ?? "", /attachment; filename="nested\.txt"/);
    assert.equal(d.headers.get("content-length"), "6");
    assert.equal(await d.text(), "nested");
    for (const p of ["../etc/passwd", "secret/key", "missing.txt", "sub", ""]) {
      assert.equal((await s.req(`/files/read?path=${encodeURIComponent(p)}`)).status, 400, p);
    }
  });
  test("zip: json and urlencoded, single name, and the refusals", async () => {
    const z = await s.req("/files/zip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "", names: ["hello.txt", "sub"] }) });
    assert.equal(z.status, 200); assert.equal(z.headers.get("content-type"), "application/zip");
    assert.match(z.headers.get("content-disposition") ?? "", /selection\.zip/);
    const buf = Buffer.from(await z.arrayBuffer());
    assert.equal(buf.subarray(0, 2).toString(), "PK");
    assert.ok(buf.includes("hello.txt") && buf.includes("sub/nested.txt"), "both entries, the directory recursed");
    const f = await s.req("/files/zip", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "path=&names=hello.txt" });
    assert.equal(f.status, 200); assert.match(f.headers.get("content-disposition") ?? "", /hello-txt\.zip/);
    assert.equal(Buffer.from(await f.arrayBuffer()).subarray(0, 2).toString(), "PK");
    assert.equal((await s.post("/files/zip", { path: "", names: [] })).status, 400);
    assert.equal((await s.post("/files/zip", { path: "", names: ["nope.txt"] })).status, 400);
    assert.equal((await s.post("/files/zip", { path: "..", names: ["passwd"] })).status, 400);
    assert.equal((await s.post("/files/zip", { path: "", names: ["secret"] })).status, 400, "denied subtree");
    assert.equal((await s.post("/files/zip", { path: "", names: 42 })).status, 400);
  });
  test("zip ?check=1 answers without streaming, with the same refusals", async () => {
    const ok = await s.post("/files/zip?check=1", { path: "", names: ["hello.txt", "sub"] });
    assert.equal(ok.status, 200); assert.equal(ok.body!.ok, true); assert.equal(ok.body!.files, 2);
    assert.equal(ok.headers.get("content-type")?.includes("json"), true);
    assert.equal((await s.post("/files/zip?check=1", { path: "", names: ["nope"] })).status, 400);
    assert.equal((await s.post("/files/zip?check=1", { path: "", names: ["secret"] })).status, 400);
  });
  test("zip refuses a selection over the cap before streaming", async () => {
    const big = Buffer.alloc(200 * 1024, 1);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(s.root, "files", "big.bin"), big);
    const r = await s.post("/files/zip", { path: "", names: ["big.bin"] });
    assert.equal(r.status, 400); assert.match(String(r.body!.error), /too large/);
  });
  test("mkdir: creates, then refuses duplicates, escapes, the denylist and a missing name", async () => {
    const ok = await s.post("/files/mkdir", { path: "sub", name: "made" });
    assert.equal(ok.status, 200); assert.equal(ok.body!.path, "sub/made");
    assert.ok((await stat(join(s.root, "files", "sub", "made"))).isDirectory());
    assert.equal((await s.post("/files/mkdir", { path: "sub", name: "made" })).status, 400);
    assert.equal((await s.post("/files/mkdir", { path: "..", name: "x" })).status, 400);
    assert.equal((await s.post("/files/mkdir", { path: "secret", name: "x" })).status, 400);
    assert.equal((await s.post("/files/mkdir", { path: "" })).status, 400);
    assert.equal((await s.post("/files/mkdir", { path: "", name: 7 })).status, 400);
    assert.equal((await s.req("/files/mkdir", { method: "POST", headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" }, body: "{}" })).status, 403);
  });
  test("upload: streamed, 0600, basename'd; missing name and over-limit are 400 with nothing left behind", async () => {
    const ok = await s.req("/files/upload?path=sub&name=../../escape.txt", { method: "POST", body: "payload", headers: { "content-type": "application/octet-stream" } });
    assert.equal(ok.status, 200);
    const st = await stat(join(s.root, "files", "sub", "escape.txt"));
    assert.equal(st.mode & 0o777, 0o600); assert.equal(st.size, 7);
    assert.equal((await s.req("/files/upload", { method: "POST", body: "x" })).status, 400);
    const over = await s.req("/files/upload?name=over.bin", { method: "POST", body: Buffer.alloc(70 * 1024), headers: { "content-type": "application/octet-stream" } });
    assert.equal(over.status, 400);
    const left = await readdir(join(s.root, "files"));
    assert.ok(!left.some((f) => f.startsWith("over.bin")), `no partial file: ${left}`);
    assert.equal((await s.req("/files/upload?path=secret&name=x", { method: "POST", body: "x" })).status, 400, "denied subtree");
  });
});

describe("upgrades", () => {
  const rawUpgrade = (path: string, headers: string[]) => new Promise<string>((res) => {
    const c = connect(s.port, "127.0.0.1", () => {
      c.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${headers.map((h) => h + "\r\n").join("")}\r\n`);
    });
    let out = ""; c.on("data", (d) => { out += d.toString(); }); c.on("close", () => res(out)); c.on("error", () => res(out));
    setTimeout(() => c.destroy(), 500);
  });
  test("an unknown route is 404, a cross-site upgrade is 403", async () => {
    assert.match(await rawUpgrade("/nope", []), /^HTTP\/1\.1 404/);
    assert.match(await rawUpgrade("/ws", ["Origin: https://evil.example"]), /^HTTP\/1\.1 403/);
    assert.match(await rawUpgrade("/pty", ["Sec-Fetch-Site: cross-site"]), /^HTTP\/1\.1 403/);
  });
  test("/ws attaches to a chat and carries a prompt to the SDK", async () => {
    const c = await s.socket("/ws");
    const chats = await c.wait((m) => m.kind === "chats");
    assert.ok(chats.activeId);
    await c.wait((m) => m.kind === "mode");
    c.send({ type: "prompt", text: "over the wire", withTab: false });
    await settle(8);
    assert.match(s.sdk.last.received.at(-1)!.message.content as string, /over the wire/);
    c.ws.close(); await c.closed;
  });
  test("/pty starts a shell and streams its output as binary frames", async () => {
    const c = await s.socket("/pty");
    c.send({ type: "start", cols: 80, rows: 24 });
    const t0 = Date.now();
    while (c.raw.length === 0 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
    assert.ok(c.raw.length > 0, "a prompt arrived");
    c.ws.close(); await c.closed;
  });
  test("/ext: hello registers the browser; a watch_fired event wakes the chat that set it", async () => {
    const chat = s.running.convo.create();
    const w = s.running.watches.add({ chatId: chat.id, description: "the build", url: "", tabId: null, condition: { kind: "contains", value: "done" } });
    const ext = await s.socket("/ext", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
    ext.send({ type: "hello", instance: "browser-T" });
    await settle(4);
    assert.ok(s.running.bridge.instances.includes("browser-T"));
    ext.send({ type: "watch_fired", watchId: w.id, detail: "it says done" });
    await settle(8);
    assert.match(s.sdk.last.received.at(-1)!.message.content as string, /watch report: it says done/);
    assert.ok(s.logs.some((l) => l.includes("[watch] fired")));
    ext.send({ type: "watch_fired", watchId: "unknown", detail: "x" });   // ignored
    ext.ws.close(); await ext.closed;
  });
  test("/prompts resolves the host through a connected extension", async () => {
    const ext = await s.socket("/ext", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
    ext.send({ type: "hello", instance: "browser-P" });
    ext.ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id && m.action === "active_tab") ext.send({ id: m.id, ok: true, result: { title: "Docs", url: "https://docs.example/a", selection: "sel" } }); });
    await settle(4);
    await s.post("/prompts", { title: "Doc prompt", text: "Read {url} ({title})", domains: ["docs.example"] });
    const r = await s.json("/prompts");
    assert.equal(r.body!.host, "docs.example"); assert.equal(r.body!.hasSelection, true);
    const p = (r.body!.prompts as { filled: string }[])[0];
    assert.equal(p.filled, "Read https://docs.example/a (Docs)");
    ext.ws.close(); await ext.closed;
  });
});

describe("heartbeat beats", () => {
  test("/ws gets {kind:'ping'} and /ext gets {type:'ping'} on the heartbeat schedule", async () => {
    const t = await startTestServer({ cfg: { heartbeatMs: 60 } });
    try {
      const c = await t.socket("/ws");
      await c.wait((m) => m.kind === "ping", 3000);
      const ext = await t.socket("/ext", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
      await ext.wait((m) => m.type === "ping", 3000);
      c.ws.close(); ext.ws.close(); await c.closed; await ext.closed;
    } finally { await t.stop(); }
  });
});

describe("shutdown", () => {
  test("flushes pending saves, closes sockets with 1001, stops listening", async () => {
    const t = await startTestServer();
    const c = await t.socket("/ws");
    await c.wait((m) => m.kind === "chats");
    const chat = t.running.convo.live(t.running.convo.newestId()!)!;
    chat.recordUser("unsaved at shutdown");
    await t.running.shutdown("test");
    assert.equal(await c.closed, 1001);
    const rec = JSON.parse(await readFile(join(t.root, "chats", `${chat.id}.json`), "utf8"));
    assert.ok(rec.events.some((e: { text?: string }) => e.text === "unsaved at shutdown"));
    await assert.rejects(fetch(t.base + "/chats"));
    assert.ok(t.sdk.queries.every((q) => q.ended));
    await t.running.shutdown("again");    // idempotent
    await t.stop();
  });
});

// Last: boot() sets the module-global denylist in files.ts, so a second boot
// (even one that is refused) would replace the running server's list.
describe("boot refusals", () => {
  test("all interfaces", async () => {
    await assert.rejects(boot({ host: "0.0.0.0", port: 1, workspace: "/tmp", chatsDir: "/tmp/x", filesRoot: "/tmp", projectsRoot: "/tmp", promptsPath: "/tmp/p.json", usagePath: "/tmp/u.json", maxUpload: 1, maxZip: 1, extraOrigins: [], forceLocal: true, denyExtra: [], home: "/tmp" }), AuthRefused);
  });
  test("a network bind with no authenticator", async () => {
    await assert.rejects(boot({ host: "10.9.9.9", port: await freePort(), workspace: join(s.root, "ws"), chatsDir: join(s.root, "c2"), filesRoot: s.root, projectsRoot: s.root, promptsPath: join(s.root, "p2.json"), usagePath: join(s.root, "u2.json"), maxUpload: 1, maxZip: 1, extraOrigins: [], forceLocal: false, denyExtra: [], home: s.root, authDeps: { self: async () => null }, log: () => {}, warn: () => {} }), AuthRefused);
  });
});

