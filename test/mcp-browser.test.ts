import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./fakes/server.js";

/**
 * /mcp/browser end to end: a real MCP client (standing in for Claude Code in
 * tmux), a fake extension answering browser commands, and a side panel socket
 * that sees — and answers — the cards the site gate puts up.
 */
let s: TestServer;
let client: Client;
let ext: Awaited<ReturnType<TestServer["socket"]>>;
let tabUrl = "https://allowed.example/page";
before(async () => {
  s = await startTestServer();
  ext = await s.socket("/ext", { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" });
  ext.send({ type: "hello", instance: "browser-M" });
  ext.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as { id?: string; action?: string; type?: string };
    if (m.type === "ping") { ext.send({ type: "pong" }); return; }
    if (!m.id) return;
    const result = m.action === "tab_url" ? { tabId: 7, url: tabUrl, title: "T" }
      : m.action === "read_page" ? { text: "the page text, long enough to count", chars: 36 }
      : m.action === "list_tabs" ? [{ id: 7, title: "T", url: tabUrl }]
      : {};
    ext.send({ id: m.id, ok: true, result });
  });
  client = new Client({ name: "tmux", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp/browser`)));
});
after(async () => { await client.close(); ext.ws.close(); await s.stop(); });

type ToolText = { content: { type: string; text: string }[]; isError?: boolean };
const standing = async () => ((await s.json("/browser-allow")).body as { hosts: { host: string; level: string }[] }).hosts;
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolText;

describe("/mcp/browser", () => {
  test("lists the browser tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ["list_tabs", "read_page", "click", "navigate", "screenshot"]) assert.ok(names.includes(n), n);
  });

  test("an allowed site is read without a card", async () => {
    tabUrl = "https://allowed.example/page";
    const r = await call("read_page", {});
    assert.ok(!r.isError, r.content[0]?.text);
    assert.match(r.content[0]!.text, /the page text/);
  });

  test("a new site puts a card in the side panel; allow lets the call through, and the next one skips the card", async () => {
    tabUrl = "https://new.example/x";
    const panel = await s.socket("/ws");
    const pending = call("read_page", {});
    const card = await panel.wait((m) => m.kind === "approval" && (m.input as { host?: string }).host === "new.example");
    assert.equal((card.input as { origin?: string }).origin, "terminal");
    // a panel that connects while the card is up is sent it too
    const late = await s.socket("/ws");
    await late.wait((m) => m.kind === "approval" && m.id === card.id);
    panel.send({ type: "decision", id: card.id, decision: "allow" });
    const r = await pending;
    assert.ok(!r.isError, r.content[0]?.text);
    await late.wait((m) => m.kind === "approval_closed" && m.id === card.id);
    const again = await call("read_page", {});
    assert.ok(!again.isError);
    assert.equal(panel.kind("approval").filter((m) => (m.input as { host?: string }).host === "new.example").length, 1);
    assert.ok(!(await standing()).some((h) => h.host === "new.example"), "allow is not always");
    panel.ws.close(); late.ws.close();
  });

  test("deny refuses the call", async () => {
    tabUrl = "https://denied.example/x";
    const panel = await s.socket("/ws");
    const pending = call("read_page", {});
    const card = await panel.wait((m) => m.kind === "approval" && (m.input as { host?: string }).host === "denied.example");
    panel.send({ type: "decision", id: card.id, decision: "deny" });
    const r = await pending;
    assert.ok(r.isError);
    assert.match(r.content[0]!.text, /did not allow/);
    panel.ws.close();
  });

  test("always adds the site to the standing list", async () => {
    tabUrl = "https://kept.example/x";
    const panel = await s.socket("/ws");
    const pending = call("click", { selector: "button" });
    const card = await panel.wait((m) => m.kind === "approval" && (m.input as { host?: string }).host === "kept.example");
    assert.equal((card.input as { level?: string }).level, "act");
    panel.send({ type: "decision", id: card.id, decision: "always" });
    assert.ok(!(await pending).isError);
    assert.ok((await standing()).some((h) => h.host === "kept.example" && h.level === "act"));
    panel.ws.close();
  });
});
