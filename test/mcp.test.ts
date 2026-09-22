import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startTestServer, type TestServer } from "./fakes/server.js";
import { waitFor } from "./fakes/sdk.js";

/**
 * /mcp end to end: a real MCP client over HTTP against the in-process server
 * with the fake SDK standing in for Claude.
 */
let s: TestServer;
let client: Client;
before(async () => {
  s = await startTestServer();
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`)));
});
after(async () => { await client.close(); await s.stop(); });

type ToolText = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args }) as ToolText;
  const t = r.content[0]?.text ?? "";
  let body: Record<string, unknown> | unknown[] | string = t;
  try { body = JSON.parse(t); } catch { /* plain text */ }
  return { body, isError: r.isError === true, raw: t };
};

describe("/mcp", () => {
  test("lists the tools, and never one that answers a card", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const n of ["list_chats", "read_chat", "send_prompt", "stop_chat", "list_schedules"]) assert.ok(names.includes(n), n);
    assert.ok(!names.some((n) => /approve|answer|decide|allow/.test(n)), names.join(","));
  });

  test("send_prompt to a new chat waits for the reply; read_chat and list_chats see it", async () => {
    const before = s.sdk.queries.length;
    const pending = call("send_prompt", { text: "what is 2+2?" });
    await waitFor(() => s.sdk.queries.length > before && s.sdk.last.received.length > 0);
    s.sdk.last.text("4");
    s.sdk.last.result();
    const r = await pending;
    const body = r.body as { chatId: string; status: string; reply: string; link: string };
    assert.equal(body.status, "done"); assert.equal(body.reply, "4");
    assert.match(body.link, /\?chat=/);
    const read = (await call("read_chat", { chatId: body.chatId })).body as { entries: string[]; status?: string };
    assert.deepEqual(read.entries.slice(-2), ["user: what is 2+2?", "assistant: 4"]);
    const list = (await call("list_chats")).body as { id: string }[];
    assert.ok(list.some((c) => c.id === body.chatId));
  });

  test("a turn that stops on a card comes back as waiting, and the card stays for a person", async () => {
    const before = s.sdk.queries.length;
    const pending = call("send_prompt", { text: "clean up" });
    await waitFor(() => s.sdk.queries.length > before && s.sdk.last.received.length > 0);
    const q = s.sdk.last;
    const gate = q.ask("Bash", { command: "rm -rf build" });
    const body = (await pending).body as { status: string; waitingFor: string; chatId: string };
    assert.equal(body.status, "waiting"); assert.equal(body.waitingFor, "approval: Bash");
    const read = (await call("read_chat", { chatId: body.chatId })).body as { status?: string };
    assert.match(read.status ?? "", /waiting for a person/);
    // stop_chat interrupts the turn; the card is still the person's to answer or drop
    assert.equal(((await call("stop_chat", { chatId: body.chatId })).body as { status: string }).status, "stopped");
    assert.equal(q.interrupts, 1);
    gate.abort(); await gate.promise.catch(() => {});
  });

  test("wait:false returns at once; a busy chat is refused; unknown ids are errors", async () => {
    const before = s.sdk.queries.length;
    const r = (await call("send_prompt", { text: "long job", wait: false })).body as { status: string; chatId: string };
    assert.equal(r.status, "sent");
    await waitFor(() => s.sdk.queries.length > before && s.sdk.last.received.length > 0);
    const busy = await call("send_prompt", { text: "again", chatId: r.chatId });
    assert.equal(busy.isError, true); assert.match(busy.raw, /busy/);
    s.sdk.last.result();
    assert.equal((await call("read_chat", { chatId: "aaaaaaaa-0000-0000-0000-00000000dead" })).isError, true);
    assert.equal((await call("send_prompt", { text: "x", chatId: "../../etc" })).isError, true);
  });

  test("the timeout returns what has come so far and leaves the turn running", async () => {
    const before = s.sdk.queries.length;
    const pending = call("send_prompt", { text: "slow", timeoutSec: 1 });
    await waitFor(() => s.sdk.queries.length > before && s.sdk.last.received.length > 0);
    s.sdk.last.text("working on it");
    const body = (await pending).body as { status: string; reply: string };
    assert.equal(body.status, "timeout"); assert.equal(body.reply, "working on it");
    s.sdk.last.result();
  });

  test("behind the same guard as every route: a cross-site page cannot reach it", async () => {
    const r = await s.req("/mcp", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(r.status, 403);
  });
});
