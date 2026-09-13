import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { terminalTools, watchTools, promptTools, browserTools, downloadName } from "../src/tools.js";
import { BrowserBridge } from "../src/browser.js";
import { WatchRegistry } from "../src/watches.js";
import { PromptStore } from "../src/prompts.js";
import { Shell } from "../src/shell.js";
import { FakeWs } from "./fakes/ws.js";
import { makePdf } from "./pdf.test.js";

/**
 * The MCP tools the model calls, invoked directly through the MCP server's
 * registry, with a fake extension answering the bridge.
 */
type Srv = ReturnType<typeof terminalTools>;
async function call(srv: Srv, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const reg = (srv.instance as unknown as { _registeredTools: Record<string, { callback?: Function; handler?: Function }> })._registeredTools;
  const t = reg[name];
  assert.ok(t, `tool ${name} registered (have: ${Object.keys(reg)})`);
  const r = await (t.callback ?? t.handler)!(args, {});
  return (r as { content: { text: string }[] }).content.map((c) => c.text).join("\n");
}

/** A fake extension: answers every bridge command from a table. */
class Ext extends FakeWs {
  constructor(public answers: Record<string, (p: Record<string, unknown>) => unknown>) { super(); }
  override send(data: string | Buffer): void {
    super.send(data);
    const m = JSON.parse(String(data)) as { id?: string; action?: string; params: Record<string, unknown> };
    if (!m.id || !m.action) return;
    setImmediate(() => {
      const fn = this.answers[m.action!];
      try {
        if (!fn) throw new Error(`no handler for ${m.action}`);
        this.frame({ id: m.id, ok: true, result: fn(m.params) });
      } catch (e) { this.frame({ id: m.id, ok: false, error: (e as Error).message }); }
    });
  }
}
function bridged(answers: Ext["answers"], instance = "browser-A") {
  const bridge = new BrowserBridge(() => {}, 300);
  const ext = new Ext(answers);
  bridge.attach(ext as unknown as WebSocket);
  ext.frame({ type: "hello", instance });
  return { bridge, ext };
}

let root: string;
before(async () => { root = await mkdtemp(join(tmpdir(), "ct-tools-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

describe("terminal.read", () => {
  test("no pane, an empty pane, then the tail of what the user's shell printed", async () => {
    let shell: Shell | null = null;
    const srv = terminalTools(() => shell);
    assert.match(await call(srv, "read"), /No shell pane is open/);
    shell = new Shell(() => {}, () => {});
    assert.match(await call(srv, "read"), /printed nothing yet/);
    shell.start(root, 80, 24);
    const t0 = Date.now();
    while (!shell.hasOutput && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
    shell.write("echo TOOLMARK\n");
    await new Promise((r) => setTimeout(r, 800));
    const out = await call(srv, "read", { lines: 5 });
    assert.match(out, /Last \d+ lines of the user's terminal/);
    assert.ok(out.includes("TOOLMARK"));
    assert.ok(!out.includes("\x1b["), "escape codes stripped");
    shell.kill();
  });
});

describe("watch tools", () => {
  test("page: registers, starts in the browser, reports the url; a value is required except for 'changes'", async () => {
    const { bridge, ext } = bridged({ watch_start: (p) => ({ url: "https://ci.example/run/1", title: "CI", tabId: 7, watchId: p.watchId }) });
    const reg = new WatchRegistry();
    const srv = watchTools(bridge, reg, () => "chat-1", () => "browser-A");
    assert.match(await call(srv, "page", { description: "d", until: "contains" }), /needs a value/);
    const out = await call(srv, "page", { description: "the build", until: "contains", value: "passed", minutes: 5 });
    assert.match(out, /Watching/);
    assert.equal(reg.all().length, 1);
    assert.equal(reg.all()[0].url, "https://ci.example/run/1");
    assert.equal(reg.all()[0].chatId, "chat-1");
    const started = ext.sent.find((m) => (m as { action?: string }).action === "watch_start") as { params: Record<string, unknown> };
    assert.deepEqual(started.params.condition, { kind: "contains", value: "passed" });
    assert.match(await call(srv, "list"), /the build/);
  });

  test("page: when the browser refuses, the watch is not left registered", async () => {
    const { bridge } = bridged({ watch_start: () => { throw new Error("no active tab"); } });
    const reg = new WatchRegistry();
    const srv = watchTools(bridge, reg, () => "chat-1", () => undefined);
    await assert.rejects(call(srv, "page", { description: "d", until: "changes" }), /no active tab/);
    assert.equal(reg.all().length, 0);
  });

  test("page: no extension at all is a clear error", async () => {
    const bridge = new BrowserBridge(() => {}, 100);
    const srv = watchTools(bridge, new WatchRegistry(), () => "c", () => undefined);
    await assert.rejects(call(srv, "page", { description: "d", until: "changes" }), /No Chrome extension is connected/);
  });

  test("stop: by full id or prefix; unknown id; the browser is told and its failure is ignored", async () => {
    const { bridge, ext } = bridged({ watch_start: () => ({}), watch_stop: () => { throw new Error("gone"); } });
    const reg = new WatchRegistry();
    const srv = watchTools(bridge, reg, () => "c", () => undefined);
    await call(srv, "page", { description: "one", until: "changes" });
    const id = reg.all()[0].id;
    assert.match(await call(srv, "stop", { id: "nope" }), /No watch matching/);
    assert.match(await call(srv, "stop", { id: id.slice(0, 8) }), /Stopped/);
    assert.equal(reg.all().length, 0);
    assert.ok(ext.sent.some((m) => (m as { action?: string }).action === "watch_stop"));
    assert.match(await call(srv, "list"), /No watches set/);
  });
});

describe("prompt tools", () => {
  test("list / save / update / delete, with prefix ids and host filtering", async () => {
    const store = new PromptStore(join(root, "prompts.json"));
    const srv = promptTools(store);
    const before = store.all().length;
    assert.match(await call(srv, "save", { title: "Zqx unique", text: "Summarise {url}", domains: ["docs.example"] }), /Saved\./);
    assert.equal(store.all().length, before + 1);
    const p = store.all().find((x) => x.title === "Zqx unique")!;
    assert.match(await call(srv, "list", { host: "docs.example" }), /Zqx unique/);
    assert.ok(!(await call(srv, "list", { host: "other.example" })).includes("Zqx unique"));
    await call(srv, "save", { id: p.id, title: "Zqx two", text: "t" });
    assert.equal(store.all().find((x) => x.id === p.id)!.title, "Zqx two");
    assert.equal(store.all().length, before + 1, "updated, not duplicated");
    await assert.rejects(call(srv, "save", { title: "", text: "x" }), /needs a title/);
    assert.match(await call(srv, "delete", { id: "zzzz" }), /No prompt matching/);
    assert.match(await call(srv, "delete", { id: p.id.slice(0, 8) }), /Deleted "Zqx two"/);
    assert.equal(store.all().length, before);
  });
});

describe("browser tools", () => {
  test("forward to the preferred browser and return its result as text", async () => {
    const seen: Record<string, unknown>[] = [];
    const { bridge } = bridged({
      list_tabs: () => [{ id: 1, title: "T" }],
      read_page: (p) => { seen.push(p); return { text: "page text" }; },
      fill: (p) => { seen.push(p); return { ok: true }; },
    });
    const srv = browserTools(bridge, () => "browser-A");
    assert.match(await call(srv, "list_tabs"), /"title": "T"/);
    assert.match(await call(srv, "read_page", { tabId: 3, maxChars: 10 }), /page text/);
    assert.deepEqual(seen[0], { tabId: 3, maxChars: 10 });
    await call(srv, "fill", { selector: "#q", value: "x" });
    assert.deepEqual(seen[1], { selector: "#q", value: "x" });
  });

  test("screenshot: refuses past the per-turn budget and asks the model to report", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 5, 0, 0, 0, 7]), Buffer.alloc(9)]);
    let shots = 0;
    const { bridge } = bridged({ screenshot: () => { shots++; return { tabId: 1, url: "u", dataUrl: "data:image/png;base64," + png.toString("base64") }; } });
    const budget = { screenshots: 0, maxScreenshots: 2 };
    const srv = browserTools(bridge, () => undefined, () => budget);
    const a = JSON.parse(await call(srv, "screenshot", {})) as { path: string }; await unlink(a.path);
    const b = JSON.parse(await call(srv, "screenshot", {})) as { path: string }; await unlink(b.path);
    const refused = await call(srv, "screenshot", {});
    assert.match(refused, /budget for this turn \(2\) is used up/);
    assert.equal(shots, 2, "the browser was not asked for the third");
    budget.screenshots = 0;                                   // a new turn
    const c = JSON.parse(await call(srv, "screenshot", {})) as { path: string }; await unlink(c.path);
    assert.equal(shots, 3);
  });

  test("site policy: allowed sites pass, others ask; deny refuses; list_tabs hides what is not allowed; navigate checks the destination", async () => {
    const asks: { host: string; action: string; detail?: string }[] = [];
    let answer: "allow" | "deny" = "allow";
    const allowed = new Set(["ok.example"]);
    const policy = { allowed: (h: string) => allowed.has(h), evalAllowed: () => false, ask: async (host: string, action: string, detail?: string) => { asks.push({ host, action, detail }); if (answer === "allow") allowed.add(host); return answer; } };
    const { bridge } = bridged({
      tab_url: (p) => ({ tabId: p.tabId ?? 1, url: p.tabId === 2 ? "https://secret.example/acct" : p.tabId === 3 ? "chrome://newtab" : "https://ok.example/page" }),
      read_page: () => ({ text: "page" }), navigate: (p) => ({ tabId: 1, url: p.url }),
      list_tabs: () => [{ id: 1, title: "OK", url: "https://ok.example/", active: true }, { id: 2, title: "Bank", url: "https://secret.example/acct" }, { id: 3, title: "New Tab", url: "chrome://newtab" }],
    });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    assert.match(await call(srv, "read_page", { tabId: 1 }), /page/); assert.equal(asks.length, 0, "an allowed site does not ask");
    assert.match(await call(srv, "read_page", { tabId: 2 }), /page/); assert.deepEqual(asks, [{ host: "secret.example", action: "read_page", detail: undefined }]);
    assert.match(await call(srv, "read_page", { tabId: 2 }), /page/); assert.equal(asks.length, 1, "granted: not asked twice");
    allowed.delete("secret.example"); answer = "deny";
    await assert.rejects(call(srv, "read_page", { tabId: 2 }), /secret\.example: the user did not allow it/);
    const tabs = JSON.parse(await call(srv, "list_tabs")) as { id: number; url?: string; host?: string; allowed?: boolean }[];
    assert.equal(tabs[0].url, "https://ok.example/");
    assert.deepEqual(tabs[1], { id: 2, host: "secret.example", allowed: false }); assert.ok(!("url" in tabs[1]) && !("title" in tabs[1]), "no url or title for a site not allowed");
    assert.equal(tabs[2].allowed, false, "a chrome:// tab is not readable either");
    answer = "allow";
    await call(srv, "navigate", { url: "https://third.example/x" });
    assert.deepEqual(asks.at(-1), { host: "third.example", action: "navigate", detail: "https://third.example/x" });
    await assert.rejects(call(srv, "read_page", { tabId: 3 }), /no readable URL/);
  });

  test("eval asks every call on an allowed site until granted for the chat; without a policy nothing asks", async () => {
    const asks: string[] = [];
    const evalOk = new Set<string>();
    const policy = { allowed: () => true, evalAllowed: (h: string) => evalOk.has(h), ask: async (host: string, action: string) => { asks.push(action); return "allow" as const; } };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://ok.example/" }), eval: (p) => ({ value: `ran ${p.code}` }) });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    await call(srv, "eval", { code: "1" }); await call(srv, "eval", { code: "2" });
    assert.deepEqual(asks, ["eval", "eval"], "per call");
    evalOk.add("ok.example");
    await call(srv, "eval", { code: "3" }); assert.equal(asks.length, 2, "granted for this host");
    const { bridge: b2 } = bridged({ eval: (p) => ({ value: p.code }) });
    assert.match(await call(browserTools(b2, () => undefined), "eval", { code: "x" }), /x/, "no policy: no tab_url call, no ask");
  });

  test("read_page on a PDF tab: the viewer refuses, the bytes are fetched, the text comes back", async () => {
    const pdf = makePdf([["Invoice 0039", "Amount 12,50"]]);
    const calls: string[] = [];
    const { bridge } = bridged({
      tab_url: () => ({ tabId: 5, url: "https://files.example/inv/0039.pdf" }),
      read_page: () => { calls.push("read_page"); throw new Error("Cannot access contents of the page"); },
      fetch_bytes: () => { calls.push("fetch_bytes"); return { tabId: 5, title: "0039.pdf", url: "https://files.example/inv/0039.pdf", contentType: "application/pdf", bytes: pdf.length, data: pdf.toString("base64") }; },
    });
    const srv = browserTools(bridge, () => undefined);
    const out = JSON.parse(await call(srv, "read_page", { tabId: 5 })) as { kind: string; pages: number; text: string; title: string };
    assert.equal(out.kind, "pdf"); assert.equal(out.pages, 1); assert.match(out.text, /Invoice 0039\nAmount 12,50/); assert.equal(out.title, "0039.pdf");
    assert.deepEqual(calls, ["fetch_bytes"], "a .pdf URL skips the viewer and goes straight to the bytes");
  });

  test("read_page on an empty, unnamed page tries the bytes; a non-PDF answer falls back to what the page gave", async () => {
    const { bridge } = bridged({
      tab_url: () => ({ tabId: 6, url: "https://app.example/doc/77" }),
      read_page: () => ({ tabId: 6, title: "Doc", url: "https://app.example/doc/77", text: "", chars: 0 }),
      fetch_bytes: () => ({ tabId: 6, url: "https://app.example/doc/77", contentType: "text/html", bytes: 6, data: Buffer.from("<html>").toString("base64") }),
    });
    const out = JSON.parse(await call(browserTools(bridge, () => undefined), "read_page", { tabId: 6 })) as { chars: number; kind?: string };
    assert.equal(out.chars, 0); assert.equal(out.kind, undefined);
    const { bridge: b2 } = bridged({
      tab_url: () => ({ tabId: 7, url: "https://app.example/doc/78" }),
      read_page: () => { throw new Error("Cannot access contents of the page"); },
      fetch_bytes: () => { throw new Error("fetch failed: HTTP 403"); },
    });
    await assert.rejects(call(browserTools(b2, () => undefined), "read_page", { tabId: 7 }), /Cannot access contents/);
  });

  test("download: the tab's bytes land in <cwd>/downloads with a safe name, never overwriting; a URL can be given", async () => {
    const { mkdtemp, readFile, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const cwd = await mkdtemp(join(tmpdir(), "ct-dl-"));
    const pdf = makePdf([["Invoice 0039"]]);
    const { bridge } = bridged({
      tab_url: () => ({ tabId: 5, url: "https://files.example/inv/0039.pdf?dl=1" }),
      fetch_bytes: (p) => p.url
        ? { url: String(p.url), contentType: "text/csv", disposition: 'attachment; filename="export.csv"', bytes: 5, data: Buffer.from("a,b\n1,2").toString("base64") }
        : { tabId: 5, url: "https://files.example/inv/0039.pdf?dl=1", contentType: "application/pdf", bytes: pdf.length, data: pdf.toString("base64") },
    });
    const srv = browserTools(bridge, () => undefined, undefined, undefined, () => cwd);
    try {
      const a = JSON.parse(await call(srv, "download", { tabId: 5 })) as { path: string; name: string; bytes: number };
      assert.equal(a.name, "0039.pdf"); assert.equal(a.path, join(cwd, "downloads", "0039.pdf")); assert.equal(a.bytes, pdf.length);
      assert.ok((await readFile(a.path)).equals(pdf));
      const b = JSON.parse(await call(srv, "download", { tabId: 5 })) as { name: string };
      assert.equal(b.name, "0039-2.pdf", "a repeat never overwrites");
      const c = JSON.parse(await call(srv, "download", { url: "https://app.example/export?id=9" })) as { name: string };
      assert.equal(c.name, "export.csv", "the server's suggested name wins over a nameless URL");
      const d = JSON.parse(await call(srv, "download", { tabId: 5, name: "../../evil.pdf" })) as { name: string };
      assert.equal(d.name, "evil.pdf", "basename'd");
      assert.deepEqual((await readdir(join(cwd, "downloads"))).sort(), ["0039-2.pdf", "0039.pdf", "evil.pdf", "export.csv"]);
      await assert.rejects(call(browserTools(bridge, () => undefined), "download", { tabId: 5 }), /not available/);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  test("downloadName", () => {
    assert.equal(downloadName(undefined, "https://x/a/b/report.PDF", "", "application/pdf"), "report.PDF");
    assert.equal(downloadName(undefined, "https://x/dl?id=1", "", "application/pdf"), "dl.pdf");
    assert.equal(downloadName(undefined, "https://x/", "", "image/png"), "download.png");
    assert.equal(downloadName(undefined, "https://x/f", "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", ""), "r%C3%A9sum%C3%A9.pdf");
    assert.equal(downloadName("my file<1>.txt", "https://x/", "", ""), "my file_1_.txt");
    assert.equal(downloadName(undefined, "https://x/a%20b.csv", "", "text/csv"), "a b.csv");
  });

  test("a preferred browser that is gone fails rather than acting elsewhere", async () => {
    const { bridge } = bridged({ list_tabs: () => [] }, "browser-B");
    const srv = browserTools(bridge, () => "browser-A");
    await assert.rejects(call(srv, "list_tabs"), /not connected/);
  });

  test("screenshot: writes a private PNG and returns its size; a non-PNG answer is refused", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 5, 0, 0, 0, 7]), Buffer.alloc(9)]);
    let dataUrl = "data:image/png;base64," + png.toString("base64");
    const { bridge } = bridged({ screenshot: () => ({ tabId: 4, url: "https://x", dataUrl }) });
    const srv = browserTools(bridge, () => undefined);
    const out = JSON.parse(await call(srv, "screenshot", { tabId: 4 })) as { path: string; bytes: number; width: number; height: number };
    assert.equal(out.width, 5); assert.equal(out.height, 7); assert.equal(out.bytes, png.length);
    const st = await stat(out.path);
    assert.equal(st.mode & 0o777, 0o600);
    await unlink(out.path);
    dataUrl = "data:text/html;base64,PGI+";
    await assert.rejects(call(srv, "screenshot", {}), /not a png/);
  });
});
