import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startTestServer, type TestServer } from "./fakes/server.js";
import { TodoStore } from "../src/todos.js";
import { todoTools } from "../src/tools.js";

/**
 * The two ways a session reaches the board's list as tools: the in-process
 * `todos` server a codeTerminal chat gets (src/tools.ts) and the `/mcp`
 * endpoint a terminal or laptop session uses (src/mcp.ts). Both driven
 * through a real MCP client, so the schemas and the error paths are the ones
 * a model meets.
 */
type Result = { isError?: boolean; content: { type: string; text: string }[] };
const textOf = (r: Result) => r.content.map((c) => c.text).join("\n");

describe("the in-process todos tools (a chat's own)", () => {
  let dir: string, store: TodoStore, client: Client;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "ct-tt-")); await mkdir(join(dir, "p"));
    store = new TodoStore();
    const server = todoTools(store, () => join(dir, "p"), "chat:abc").instance;
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  after(async () => { await client.close(); await rm(dir, { recursive: true, force: true }); });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;

  test("the tool set is what the chat's allowed list names", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["add", "ask", "claim", "done", "list", "release"]);
  });

  test("add with notes and a blocker; claim refuses the blocked one; done, release and ask; list shows who holds what", async () => {
    const a = textOf(await call("add", { text: "design the schema", notes: "two tables" }));
    const aId = /^(\w{8})\s/m.exec(a.split("\n")[1])![1];
    const b = textOf(await call("add", { text: "write the migration", after: [aId] }));
    const bId = /^(\w{8})\s/m.exec(b.split("\n")[1])![1];
    const blocked = await call("claim", { id: bId });
    assert.equal(blocked.isError, true); assert.match(textOf(blocked), /blocked: waiting on "design the schema"/);
    assert.match(textOf(await call("claim", { id: aId })), /Claimed\.[\s\S]*claimed \(chat:abc\)/);
    assert.match(textOf(await call("list")), new RegExp(`${aId}\\s+claimed \\(chat:abc\\)\\s+design the schema`));
    assert.match(textOf(await call("release", { id: aId })), /Released\.[\s\S]*queued/);
    await call("claim", { id: aId });
    assert.match(textOf(await call("done", { id: aId, result: "schema agreed" })), /Done\.[\s\S]*schema agreed/);
    assert.match(textOf(await call("claim", { id: bId })), /Claimed\./, "unblocked now");
    const ask = textOf(await call("ask", { text: "Which database?" }));
    assert.match(ask, /Filed for the owner\.[\s\S]*for the owner: Which database\?/);
    assert.equal(store.read(join(dir, "p")).find((i) => i.text === "Which database?")!.addedBy, "chat:abc");
    assert.equal((await call("done", { id: "nonexistent", result: "x" })).isError, true);
    assert.equal((await call("release", { id: bId })).isError ?? false, false);
    assert.equal((await call("release", { id: bId })).isError, true, "no longer held");
  });
});

describe("the /mcp endpoint's todo tools (a terminal or laptop session's)", () => {
  let s: TestServer, ws: string;
  before(async () => { s = await startTestServer(); ws = join(s.root, "ws"); });
  after(async () => { await s.stop(); });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const raw = await r.text();
    const json = raw.startsWith("{") ? raw : raw.split("\n").find((l) => l.startsWith("data: "))!.slice(6);
    return (JSON.parse(json) as { result: Result }).result;
  };

  test("list, add (for the owner, with notes and a blocker), claim, release, done, drop", async () => {
    const a = JSON.parse(textOf(await rpc("add_todo", { project: ws, text: "laptop task", notes: "from the laptop", by: "laptop" })));
    assert.equal(a.addedBy, "laptop"); assert.equal(a.notes, "from the laptop"); assert.equal(a.for, "claude");
    const b = JSON.parse(textOf(await rpc("add_todo", { project: ws, text: "after the laptop task", after: [a.id.slice(0, 8)] })));
    assert.deepEqual(b.blockedBy, [a.id]);
    const blocked = await rpc("claim_todo", { project: ws, id: b.id, by: "tmux:x" });
    assert.equal(blocked.isError, true); assert.match(textOf(blocked), /blocked/);
    assert.equal(JSON.parse(textOf(await rpc("claim_todo", { project: ws, id: a.id.slice(0, 8), by: "tmux:x" }))).claimedBy, "tmux:x");
    assert.equal(JSON.parse(textOf(await rpc("release_todo", { project: ws, id: a.id }))).status, "queued");
    await rpc("claim_todo", { project: ws, id: a.id, by: "tmux:x" });
    assert.equal(JSON.parse(textOf(await rpc("done_todo", { project: ws, id: a.id, result: "shipped", by: "tmux:x" }))).result, "shipped");
    const listed = JSON.parse(textOf(await rpc("list_todos", { project: ws })));
    assert.ok(listed.items.some((i: { id: string }) => i.id === b.id) && !listed.items.some((i: { id: string }) => i.id === a.id), "open items only by default");
    assert.ok(JSON.parse(textOf(await rpc("list_todos", { project: ws, all: true }))).items.some((i: { id: string }) => i.id === a.id));
    const q = JSON.parse(textOf(await rpc("add_todo", { project: ws, text: "a question", for: "owner", by: "tmux:x" })));
    assert.equal(q.for, "owner");
    assert.equal(JSON.parse(textOf(await rpc("drop_todo", { project: ws, id: b.id }))).status, "dropped");
  });

  test("errors come back as tool errors: unknown project, a directory outside the roots, an unknown id", async () => {
    assert.match(textOf(await rpc("list_todos", { project: "no-such-project" })), /no project no-such-project/);
    assert.match(textOf(await rpc("add_todo", { project: "/etc", text: "x" })), /outside the projects root/);
    const r = await rpc("done_todo", { project: ws, id: "00000000-0000", result: "x" });
    assert.equal(r.isError, true); assert.match(textOf(r), /no todo/);
  });
});
