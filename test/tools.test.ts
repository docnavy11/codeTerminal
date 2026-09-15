import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { terminalTools, watchTools, promptTools, browserTools, fileTools, downloadName } from "../src/tools.js";
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
async function callRaw(srv: Srv, name: string, args: Record<string, unknown> = {}): Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[] }> {
  const reg = (srv.instance as unknown as { _registeredTools: Record<string, { callback?: Function; handler?: Function }> })._registeredTools;
  const t = reg[name];
  assert.ok(t, `tool ${name} registered (have: ${Object.keys(reg)})`);
  return await (t.callback ?? t.handler)!(args, {}) as never;
}
async function call(srv: Srv, name: string, args: Record<string, unknown> = {}): Promise<string> {
  return (await callRaw(srv, name, args)).content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
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

describe("files.offer", () => {
  test("announces a file under the root with its size; refuses outside, missing, and directories", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const root = await mkdtemp(join(tmpdir(), "ct-offer-")); await mkdir(join(root, "ws", "out"), { recursive: true });
    await writeFile(join(root, "ws", "out", "report.csv"), "a,b\n1,2\n");
    const events: unknown[] = [];
    const srv = fileTools(root, join(root, "ws"), (e) => events.push(e));
    try {
      assert.match(await call(srv, "offer", { path: "out/report.csv", note: "the export" }), /Offered report\.csv \(8 bytes\)/);
      assert.deepEqual(events, [{ kind: "file", path: "ws/out/report.csv", name: "report.csv", bytes: 8, note: "the export" }]);
      await call(srv, "offer", { path: join(root, "ws", "out", "report.csv") });
      assert.equal((events[1] as { path: string }).path, "ws/out/report.csv", "absolute paths work too");
      await assert.rejects(call(srv, "offer", { path: "/etc/hostname" }), /outside/);
      await assert.rejects(call(srv, "offer", { path: "out/nope.csv" }), /not a file/);
      await assert.rejects(call(srv, "offer", { path: "out" }), /not a file/);
      assert.equal(events.length, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
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
    const asks: { host: string; action: string; detail?: string; level?: string }[] = [];
    let answer: "allow" | "deny" = "allow";
    const allowed = new Map<string, "read" | "act">([["ok.example", "act"]]);
    const covers = (g: string | undefined, n: string) => g === "act" || (g === "read" && n === "read");
    const policy = { allowed: (h: string, level: "read" | "act") => covers(allowed.get(h), level), evalAllowed: () => false,
      ask: async (host: string, action: string, detail: string | undefined, level: "read" | "act") => { asks.push({ host, action, detail, level }); if (answer === "allow") allowed.set(host, level); return answer; } };
    const { bridge } = bridged({
      tab_url: (p) => ({ tabId: p.tabId ?? 1, url: p.tabId === 2 ? "https://secret.example/acct" : p.tabId === 3 ? "chrome://newtab" : "https://ok.example/page" }),
      read_page: () => ({ text: "page" }), navigate: (p) => ({ tabId: 1, url: p.url }),
      list_tabs: () => [{ id: 1, title: "OK", url: "https://ok.example/", active: true }, { id: 2, title: "Bank", url: "https://secret.example/acct" }, { id: 3, title: "New Tab", url: "chrome://newtab" }],
    });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    assert.match(await call(srv, "read_page", { tabId: 1 }), /page/); assert.equal(asks.length, 0, "an allowed site does not ask");
    assert.match(await call(srv, "read_page", { tabId: 2 }), /page/); assert.deepEqual(asks, [{ host: "secret.example", action: "read_page", detail: undefined, level: "read" }]);
    assert.match(await call(srv, "read_page", { tabId: 2 }), /page/); assert.equal(asks.length, 1, "granted: not asked twice");
    // read was granted; acting asks again, at level act
    await bridged_click(srv); assert.deepEqual(asks.at(-1), { host: "secret.example", action: "click", detail: undefined, level: "act" });
    allowed.delete("secret.example"); answer = "deny";
    await assert.rejects(call(srv, "read_page", { tabId: 2 }), /secret\.example: the user did not allow it/);
    const tabs = JSON.parse(await call(srv, "list_tabs")) as { id: number; url?: string; host?: string; allowed?: boolean }[];
    assert.equal(tabs[0].url, "https://ok.example/");
    assert.deepEqual(tabs[1], { id: 2, host: "secret.example", allowed: false }); assert.ok(!("url" in tabs[1]) && !("title" in tabs[1]), "no url or title for a site not allowed");
    assert.equal(tabs[2].allowed, false, "a chrome:// tab is not readable either");
    answer = "allow";
    await call(srv, "navigate", { url: "https://third.example/x" });
    assert.deepEqual(asks.at(-1), { host: "third.example", action: "navigate", detail: "https://third.example/x", level: "act" });
    await assert.rejects(call(srv, "read_page", { tabId: 3 }), /no readable URL/);
    async function bridged_click(s: typeof srv) { try { await call(s, "click", { tabId: 2, selector: "a" }); } catch { /* the fake ext has no click handler; the ask is what matters */ } }
  });

  test("a blocked tab fails every call at once with the dialog's message; handle_dialog goes through, is act-level, and forwards accept/text", async () => {
    const asks: string[] = []; const seen: Record<string, unknown>[] = [];
    let dialog: { type: string; message: string } | undefined = { type: "confirm", message: "Delete everything?" };
    const policy = { allowed: (_h: string, level: string) => level === "read", evalAllowed: () => false, ask: async (_h: string, action: string, _d: string | undefined, level: string) => { asks.push(action + ":" + level); return "allow" as const; } };
    const { bridge } = bridged({
      tab_url: () => ({ tabId: 1, url: "https://shop.example/cart", title: "Cart", ...(dialog ? { dialog } : {}) }),
      read_page: () => ({ text: "page" }), click: () => ({ clicked: "button" }),
      handle_dialog: (p) => { seen.push(p); dialog = undefined; return { tabId: 1, type: "confirm", message: "Delete everything?", handled: true }; },
    });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    await assert.rejects(call(srv, "read_page", { tabId: 1 }), /blocked by a JavaScript confirm dialog: "Delete everything\?"/);
    await assert.rejects(call(srv, "click", { tabId: 1, selector: "a" }), /blocked by a JavaScript confirm/);
    assert.deepEqual(asks, [], "a blocked tab is refused before the site gate asks anything");
    const r = JSON.parse(await call(srv, "handle_dialog", { tabId: 1, accept: false }));
    assert.equal(r.handled, true); assert.deepEqual(seen[0], { tabId: 1, accept: false });
    assert.deepEqual(asks, ["handle_dialog:act"]);
    assert.deepEqual(r.at, { host: "shop.example", title: "Cart" }, "stamped like any other call, without the dialog");
    assert.match(await call(srv, "read_page", { tabId: 1 }), /page/, "unblocked");
    await call(srv, "handle_dialog", { accept: true, text: "Alex" });
    assert.deepEqual(seen[1], { accept: true, text: "Alex" });
  });

  test("results are stamped with where they happened; navigate with its destination; no tab_url is not an error", async () => {
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://bank.example/pay", title: "Transfer — My Bank" }), click: () => ({ ok: true }), navigate: (p) => ({ tabId: 1, url: p.url }), list_tabs: () => [] });
    const srv = browserTools(bridge, () => undefined);
    const clicked = JSON.parse(await call(srv, "click", { tabId: 1, selector: "a" }));
    assert.deepEqual(clicked.at, { host: "bank.example", title: "Transfer — My Bank" });
    const nav = JSON.parse(await call(srv, "navigate", { url: "https://other.example/x" }));
    assert.deepEqual(nav.at, { host: "other.example" });
    const { bridge: old } = bridged({ click: () => ({ ok: true }) });
    assert.deepEqual(JSON.parse(await call(browserTools(old, () => undefined), "click", { selector: "a" })), { ok: true }, "older extension: no stamp, still works");
  });

  test("find and scroll are read-level and forward their arguments", async () => {
    const asks: string[] = []; const seen: Record<string, unknown>[] = [];
    const policy = { allowed: (_h: string, level: string) => level === "read", evalAllowed: () => false, ask: async (_h: string, action: string, _d: string | undefined, level: string) => { asks.push(action + ":" + level); return "allow" as const; } };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://ok.example/" }), find: (p) => { seen.push(p); return { count: 1, matches: [{ ref: "f1", text: "hit" }] }; }, scroll: (p) => { seen.push(p); return { percent: 50, atTop: false, atBottom: false }; } });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    assert.match(await call(srv, "find", { text: "hit", limit: 3 }), /"ref": "f1"/);
    assert.match(await call(srv, "scroll", { ref: "f1" }), /"percent": 50/);
    assert.deepEqual(asks, [], "read-allowed: neither asks");
    assert.deepEqual(seen[0], { text: "hit", limit: 3 }); assert.deepEqual(seen[1], { ref: "f1" });
  });

  test("type is act-level and forwards text and target; press forwards modifier specs", async () => {
    const asks: string[] = []; const seen: [string, Record<string, unknown>][] = [];
    const policy = { allowed: () => false, evalAllowed: () => false, ask: async (_h: string, action: string, _d: string | undefined, level: string) => { asks.push(action + ":" + level); return "allow" as const; } };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://tv.example/chart", title: "Chart" }), type: (p) => { seen.push(["type", p]); return { typed: 9, trusted: true, tag: "div" }; }, press: (p) => { seen.push(["press", p]); return { pressed: p.key, trusted: true }; }, submit_probe: () => ({ submit: false }) });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    const r = JSON.parse(await call(srv, "type", { tabId: 1, selector: ".monaco", text: "plot(x)\n" }));
    assert.deepEqual(asks, ["type:act"]); assert.deepEqual(seen[0], ["type", { tabId: 1, selector: ".monaco", text: "plot(x)\n" }]); assert.equal(r.trusted, true);
    await call(srv, "press", { tabId: 1, key: "Ctrl+A" }); assert.deepEqual(seen[1], ["press", { tabId: 1, key: "Ctrl+A" }]);
  });

  test("confirm before submit: a submitting click/Enter is put in front of the user; stop fails the tool without clicking; non-submits and other keys never ask", async () => {
    const asked: Record<string, unknown>[] = []; const clicks: number[] = []; const probes: Record<string, unknown>[] = [];
    let answer = true;
    let probe: Record<string, unknown> = { submit: true, via: "click", form: { action: "https://shop.example/checkout", method: "post", button: "Place order", fields: [{ name: "name", value: "Alex" }, { name: "card", value: "•••" }], filled: 2 } };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://shop.example/cart", title: "Cart" }), submit_probe: (p) => { probes.push(p); return probe; }, click: () => { clicks.push(1); return { clicked: "button" }; }, press: (p) => ({ pressed: p.key }) });
    const srv = browserTools(bridge, () => undefined, undefined, undefined, undefined, undefined, async (d) => { asked.push(d); return answer; });
    assert.match(await call(srv, "click", { tabId: 1, selector: "#order" }), /clicked/);
    assert.deepEqual(asked[0], { host: "shop.example", via: "click", action: "https://shop.example/checkout", method: "post", button: "Place order", fields: [{ name: "name", value: "Alex" }, { name: "card", value: "•••" }], filled: 2 });
    assert.deepEqual(probes[0], { tabId: 1, selector: "#order" });
    answer = false;
    await assert.rejects(call(srv, "click", { tabId: 1, selector: "#order" }), /the user stopped the submit to shop\.example \(POST https:\/\/shop\.example\/checkout\)/);
    assert.equal(clicks.length, 1, "a stopped submit is not clicked");
    probe = { submit: false };
    assert.match(await call(srv, "click", { tabId: 1, selector: "a.more" }), /clicked/); assert.equal(asked.length, 2);
    probe = { submit: true, via: "enter", form: { action: "https://shop.example/search", method: "post", fields: [{ name: "q", value: "x" }], filled: 1 } };
    answer = true;
    await call(srv, "press", { tabId: 1, key: "Enter" }); assert.equal(asked.length, 3); assert.equal(asked[2].via, "enter"); assert.deepEqual(probes.at(-1), { tabId: 1, key: "Enter" });
    // no confirm callback (CODETERM_CONFIRM_SUBMIT=0): no probe at all
    const off = browserTools(bridge, () => undefined);
    const before = probes.length; await call(off, "click", { tabId: 1, selector: "#order" }); assert.equal(probes.length, before);
    // an older extension without submit_probe: the click still goes through
    const { bridge: old } = bridged({ tab_url: () => ({ tabId: 1, url: "https://a.example/" }), click: () => ({ clicked: "button" }) });
    assert.match(await call(browserTools(old, () => undefined, undefined, undefined, undefined, undefined, async () => false), "click", { selector: "#x" }), /clicked/);
  });

  test("console_read and network_read are read-level, forward their filters, and may run in a batch", async () => {
    const asks: string[] = []; const seen: [string, Record<string, unknown>][] = [];
    const policy = { allowed: () => false, evalAllowed: () => false, ask: async (_h: string, action: string, _d: string | undefined, level: string) => { asks.push(action + ":" + level); return "allow" as const; } };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "http://localhost:3000/app", title: "App" }),
      console_read: (p) => { seen.push(["console_read", p]); return { total: 1, shown: 1, counts: { error: 1 }, entries: [{ level: "error", text: "boom" }] }; },
      network_read: (p) => { seen.push(["network_read", p]); return { total: 2, shown: 1, failed: 1, entries: [{ url: "http://localhost:3000/api", status: 500, method: "GET", ok: false }] }; } });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    const c = JSON.parse(await call(srv, "console_read", { tabId: 1, level: "error", limit: 20 }));
    const n = JSON.parse(await call(srv, "network_read", { tabId: 1, failed: true, filter: "/api" }));
    assert.deepEqual(asks, ["console_read:read", "network_read:read"]);
    assert.deepEqual(seen[0], ["console_read", { tabId: 1, level: "error", limit: 20 }]); assert.deepEqual(seen[1], ["network_read", { tabId: 1, failed: true, filter: "/api" }]);
    assert.equal(c.entries[0].text, "boom"); assert.equal(n.failed, 1); assert.deepEqual(c.at, { host: "localhost", title: "App" });
    const b = JSON.parse(await call(srv, "browser_batch", { tabId: 1, steps: [{ tool: "console_read", args: { level: "error" } }, { tool: "network_read", args: { failed: true } }] }));
    assert.equal(b.steps, 2); assert.equal(b.failed, 0); assert.equal(asks.length, 3);
  });

  test("upload: reads the file under the files root, ships name/mime/base64 to the extension, is act-level; outside the root, too big, or without a target it refuses", async () => {
    const { mkdtemp, writeFile: wf, mkdir: md } = await import("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "ct-up-")); await md(join(root, "downloads"));
    await wf(join(root, "downloads", "inv.pdf"), Buffer.from("%PDF-1.4 fake"));
    await wf(join(root, "big.bin"), Buffer.alloc(10 * 1024 * 1024 + 1));
    const asks: string[] = []; const seen: Record<string, unknown>[] = [];
    const policy = { allowed: () => false, evalAllowed: () => false, ask: async (_h: string, action: string, _d: string | undefined, level: string) => { asks.push(action + ":" + level); return "allow" as const; } };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://portal.example/claims", title: "Claims" }), upload: (p) => { seen.push(p); return { uploaded: p.name, bytes: 13, files: [p.name], multiple: false }; } });
    const srv = browserTools(bridge, () => undefined, undefined, policy, undefined, root);
    const r = JSON.parse(await call(srv, "upload", { tabId: 1, ref: "f3", path: "downloads/inv.pdf" }));
    assert.deepEqual(asks, ["upload:act"]);
    assert.equal(seen[0].name, "inv.pdf"); assert.equal(seen[0].mime, "application/pdf"); assert.equal(seen[0].data, Buffer.from("%PDF-1.4 fake").toString("base64")); assert.equal(seen[0].ref, "f3");
    assert.equal(r.uploaded, "inv.pdf"); assert.equal(r.path, "downloads/inv.pdf"); assert.deepEqual(r.at, { host: "portal.example", title: "Claims" });
    await assert.rejects(call(srv, "upload", { tabId: 1, ref: "f3", path: "../../etc/passwd" }), /outside|escape|not allowed|root/i);
    await assert.rejects(call(srv, "upload", { tabId: 1, ref: "f3", path: "big.bin" }), /at most 10 MB/);
    await assert.rejects(call(srv, "upload", { tabId: 1, path: "downloads/inv.pdf" }), /needs a ref or a selector/);
    await assert.rejects(call(srv, "upload", { tabId: 1, ref: "f3", path: "downloads/nope.pdf" }), /ENOENT|no such/i);
    assert.equal(seen.length, 1, "none of the refusals reached the extension");
    const noRoot = browserTools(bridge, () => undefined);
    await assert.rejects(call(noRoot, "upload", { ref: "f3", path: "x" }), /not available here/);
  });

  test("browser_batch: read-only steps in order with one read-level gate; a failure is recorded and the rest run; act tools are refused up front", async () => {
    const asks: string[] = []; const calls: string[] = [];
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 5, 0, 0, 0, 7]), Buffer.alloc(9)]);
    const policy = { allowed: () => false, evalAllowed: () => false, ask: async (_h: string, action: string, _d: string | undefined, level: string) => { asks.push(action + ":" + level); return "allow" as const; } };
    const { bridge } = bridged({
      tab_url: () => ({ tabId: 1, url: "https://docs.example/long", title: "Long doc" }),
      find: (p) => { calls.push("find"); if (p.text === "missing") throw new Error("nothing matches"); return { count: 1, matches: [{ ref: "r1", text: "hit" }] }; },
      scroll: () => { calls.push("scroll"); return { percent: 100, atBottom: true }; },
      read_page: () => { calls.push("read_page"); return { text: "the end" }; },
      screenshot: () => { calls.push("screenshot"); return { tabId: 1, url: "u", dataUrl: "data:image/png;base64," + png.toString("base64") }; },
      click: () => { calls.push("click"); return {}; },
    });
    const budget = { screenshots: 0, maxScreenshots: 5 };
    const srv = browserTools(bridge, () => undefined, () => budget, policy);
    const r = await callRaw(srv, "browser_batch", { tabId: 1, steps: [{ tool: "find", args: { text: "hit" } }, { tool: "find", args: { text: "missing" } }, { tool: "scroll", args: { to: "bottom" } }, { tool: "read_page", args: { mode: "text" } }, { tool: "screenshot" }] });
    assert.deepEqual(asks, ["browser_batch:read"], "one ask, read level, for the whole batch");
    assert.deepEqual(calls, ["find", "find", "scroll", "read_page", "screenshot"], "every step ran, in order, past the failure");
    const j = JSON.parse(r.content[0].text!) as { steps: number; failed: number; results: Record<string, unknown>[]; at: unknown };
    assert.equal(j.steps, 5); assert.equal(j.failed, 1);
    assert.equal(j.results[1].ok, false); assert.match(String(j.results[1].error), /nothing matches/);
    assert.deepEqual((j.results[2] as { result: unknown }).result, { percent: 100, atBottom: true });
    assert.equal((j.results[4] as { result: { image: number } }).result.image, 1, "the screenshot step points at image 1");
    assert.equal(r.content[1].type, "image"); assert.equal(r.content[1].mimeType, "image/png");
    assert.equal(budget.screenshots, 1, "counts against the turn's screenshot budget");
    assert.deepEqual(j.at, { host: "docs.example", title: "Long doc" });
    await unlink(((j.results[4] as { result: { path: string } }).result.path));
    // stopOnError
    const s2 = JSON.parse(await call(srv, "browser_batch", { tabId: 1, stopOnError: true, steps: [{ tool: "find", args: { text: "missing" } }, { tool: "scroll" }, { tool: "scroll" }] })) as { steps: number; results: { skipped?: number }[] };
    assert.equal(s2.results[0].skipped, undefined); assert.equal(s2.results[1].skipped, 2);
    assert.equal(calls.filter((c) => c === "scroll").length, 1, "nothing after the failure ran");
    // act tools refused before anything runs
    const before = calls.length;
    await assert.rejects(callRaw(srv, "browser_batch", { tabId: 1, steps: [{ tool: "scroll" }, { tool: "click", args: { selector: "a" } }] }), /"click" is not a read-only step/);
    assert.equal(calls.length, before, "refused up front: not even the scroll ran");
    await assert.rejects(callRaw(srv, "browser_batch", { tabId: 1, steps: [] }), /at least one step/);
    await assert.rejects(callRaw(srv, "browser_batch", { tabId: 1, steps: Array.from({ length: 21 }, () => ({ tool: "scroll" })) }), /at most 20/);
  });

  test("fill_form is one act-level call that forwards every field", async () => {
    const asks: string[] = []; const seen: Record<string, unknown>[] = [];
    const policy = { allowed: () => false, evalAllowed: () => false, ask: async (_h: string, action: string, _d: string | undefined, level: string) => { asks.push(action + ":" + level); return "allow" as const; } };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://shop.example/checkout", title: "Checkout" }), fill_form: (p) => { seen.push(p); return { tabId: 1, filled: 2, total: 3, results: [{ field: "f1", ok: true, length: 4 }, { field: "f2", ok: true, set: "Belgium" }, { field: "f9", ok: false, error: "element not found" }] }; } });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    const r = JSON.parse(await call(srv, "fill_form", { tabId: 1, fields: [{ ref: "f1", value: "Alex" }, { ref: "f2", value: "Belgium" }, { selector: "#gift", value: true }] }));
    assert.deepEqual(asks, ["fill_form:act"], "one ask for the whole form");
    assert.deepEqual(seen[0], { tabId: 1, fields: [{ ref: "f1", value: "Alex" }, { ref: "f2", value: "Belgium" }, { selector: "#gift", value: true }] });
    assert.equal(r.filled, 2); assert.equal(r.results[2].error, "element not found");
    await assert.rejects(call(srv, "fill_form", { tabId: 1, fields: [] }), /at least one field/, "an empty form is refused");
  });

  test("tab management: open is gated on the destination, close/back/reload are act-level on the tab, focus is read-level", async () => {
    const asks: string[] = []; const seen: [string, Record<string, unknown>][] = [];
    const policy = { allowed: (h: string, level: string) => h === "ok.example" && level === "read", evalAllowed: () => false, ask: async (host: string, action: string, _d: string | undefined, level: string) => { asks.push(`${action}:${host}:${level}`); return "allow" as const; } };
    const rec = (name: string) => (p: Record<string, unknown>) => { seen.push([name, p]); return { tabId: 7, url: "https://ok.example/after", title: "After", closed: true, focused: true }; };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 7, url: "https://ok.example/page", title: "Page" }), open_tab: rec("open_tab"), close_tab: rec("close_tab"), focus_tab: rec("focus_tab"), back: rec("back"), forward: rec("forward"), reload: rec("reload") });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    const opened = JSON.parse(await call(srv, "open_tab", { url: "https://new.example/x", active: false }));
    assert.deepEqual(asks, ["open_tab:new.example:act"]); assert.deepEqual(seen[0], ["open_tab", { url: "https://new.example/x", active: false }]);
    assert.deepEqual(opened.at, { host: "new.example" });
    await call(srv, "focus_tab", { tabId: 7 }); assert.equal(asks.length, 1, "focus on a read-allowed site does not ask");
    await call(srv, "back", { tabId: 7 }); await call(srv, "forward", { tabId: 7 }); await call(srv, "reload", { tabId: 7, hard: true }); await call(srv, "close_tab", { tabId: 7 });
    assert.deepEqual(asks.slice(1), ["back:ok.example:act", "forward:ok.example:act", "reload:ok.example:act", "close_tab:ok.example:act"]);
    assert.deepEqual(seen.map(([n]) => n), ["open_tab", "focus_tab", "back", "forward", "reload", "close_tab"]);
    assert.deepEqual(seen[4][1], { tabId: 7, hard: true });
  });

  test("wait_for needs a condition, forwards the rest, and is read-level", async () => {
    const seen: Record<string, unknown>[] = [];
    const policy = { allowed: (_h: string, level: string) => level === "read", evalAllowed: () => false, ask: async () => "deny" as const };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://ok.example/" }), wait_for: (p) => { seen.push(p); return { ok: true, elapsedMs: 1200, text: "ready" }; } });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    await assert.rejects(call(srv, "wait_for", { tabId: 1 }), /at least one condition/);
    assert.match(await call(srv, "wait_for", { text: ["ready", "done"], timeoutMs: 5000 }), /"ok": true/);
    assert.deepEqual(seen[0], { text: ["ready", "done"], timeoutMs: 5000 });
    assert.match(await call(srv, "wait_for", { url: "**/dash*" }), /"ok": true/);
  });

  test("eval asks every call on an allowed site until granted for the chat; without a policy nothing asks", async () => {
    const asks: string[] = [];
    const evalOk = new Set<string>();
    const policy = { allowed: () => true, evalAllowed: (h: string) => evalOk.has(h), ask: async (host: string, action: string, _d: string | undefined, level: string) => { asks.push(action + ":" + level); return "allow" as const; } };
    const { bridge } = bridged({ tab_url: () => ({ tabId: 1, url: "https://ok.example/" }), eval: (p) => ({ value: `ran ${p.code}` }) });
    const srv = browserTools(bridge, () => undefined, undefined, policy);
    await call(srv, "eval", { code: "1" }); await call(srv, "eval", { code: "2" });
    assert.deepEqual(asks, ["eval:act", "eval:act"], "per call");
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

  test("screenshot: the image comes back inline (jpeg or png) with its meta, and the file is kept", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 5, 0, 0, 0, 7]), Buffer.alloc(9)]);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0]);
    let mode = "jpeg";
    const { bridge } = bridged({ screenshot: () => mode === "jpeg"
      ? { tabId: 4, url: "https://x", dataUrl: "data:image/jpeg;base64," + jpg.toString("base64"), width: 1568, height: 882 }
      : { tabId: 4, url: "https://x", dataUrl: "data:image/png;base64," + png.toString("base64") } });
    const srv = browserTools(bridge, () => undefined);
    const r = await callRaw(srv, "screenshot", { tabId: 4 });
    assert.equal(r.content[0].type, "image"); assert.equal(r.content[0].mimeType, "image/jpeg"); assert.equal(r.content[0].data, jpg.toString("base64"));
    const meta = JSON.parse(r.content[1].text!) as { path: string; width: number; height: number; bytes: number };
    assert.ok(meta.path.endsWith(".jpg")); assert.equal(meta.width, 1568); assert.equal(meta.height, 882); assert.equal(meta.bytes, jpg.length);
    assert.equal((await stat(meta.path)).mode & 0o777, 0o600); await unlink(meta.path);
    mode = "png";
    const r2 = await callRaw(srv, "screenshot", { tabId: 4 });
    assert.equal(r2.content[0].mimeType, "image/png");
    const meta2 = JSON.parse(r2.content[1].text!) as { path: string; width: number }; assert.ok(meta2.path.endsWith(".png")); assert.equal(meta2.width, 5); await unlink(meta2.path);
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

/* The tests above call handlers straight from the registry, which never
   runs the zod → JSON-schema conversion the SDK does when a session lists the
   server's tools. One unconvertible schema (a z.record, 2026-09-13) made
   listTools fail for the whole browser server, and every session lost every
   browser tool with nothing in the logs. This lists them the way a session
   does, for each in-process server. */
describe("MCP servers list their tools through a real client", () => {
  test("browser, files, terminal, watch and prompts servers all list; every tool has an object schema", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { fileTools, terminalTools, watchTools, promptTools } = await import("../src/tools.js");
    const { bridge } = bridged({});
    const servers: Record<string, unknown> = {
      browser: browserTools(bridge, () => undefined, () => ({ screenshots: 0, maxScreenshots: 5 }), undefined, () => root, root),
      files: fileTools(root, root, () => {}),
      terminal: terminalTools(() => null),
    };
    try { servers.watch = watchTools(bridge, { list: () => [] } as never, () => "c", () => undefined); } catch { /* signature drift: skip */ }
    try { servers.prompts = promptTools({ list: async () => [] } as never); } catch { /* skip */ }
    for (const [name, srv] of Object.entries(servers)) {
      const inst = (srv as { instance: { connect: (t: unknown) => Promise<void> } }).instance;
      const [a, b] = InMemoryTransport.createLinkedPair(); await inst.connect(a);
      const client = new Client({ name: "probe", version: "0" }); await client.connect(b);
      const { tools } = await client.listTools();
      assert.ok(tools.length > 0, `${name}: lists at least one tool`);
      for (const t of tools) assert.equal((t.inputSchema as { type?: string }).type, "object", `${name}.${t.name} has an object schema`);
      await client.close();
    }
    const browser = (servers.browser as { instance: { _registeredTools: Record<string, unknown> } }).instance._registeredTools;
    assert.ok(Object.keys(browser).includes("browser_batch") && Object.keys(browser).includes("upload"));
  });
});
