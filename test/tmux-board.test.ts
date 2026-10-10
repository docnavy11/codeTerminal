import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./fakes/server.js";
import { fakeClaude, haveTools, until } from "./fakes/tmux.js";
import { sendLine } from "../src/tmux.js";
import { readPane } from "../src/insight.js";

/**
 * The board's reach into real tmux sessions: handing an item to an idle one,
 * refusing a working one, typing an owner's answer into the session that
 * asked. A real tmux server and a stand-in pane (fixtures/fake-claude-pane.sh);
 * until now these paths had been checked once by hand.
 */
const tmux = haveTools("tmux");
let s: TestServer;
let ws: string;
const sessions: ReturnType<typeof fakeClaude>[] = [];
const make = (mode: "idle" | "working" | "shell") => { const f = fakeClaude(mode, ws); sessions.push(f); return f; };
const patch = (id: string, body: unknown) => s.json(`/todos/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const add = async (text: string, extra: Record<string, unknown> = {}) => (await s.post("/todos", { dir: ws, text, ...extra })).body as { id: string };
const items = async () => (await s.json(`/todos?dir=${encodeURIComponent(ws)}&all=1`)).body!.items as { id: string; text: string; status: string; claimedBy?: string; addedBy: string }[];

before(async () => { if (!tmux) return; s = await startTestServer(); ws = join(s.root, "ws"); });
after(async () => { for (const f of sessions) f.stop(); if (s) await s.stop(); });

describe("the stand-in pane reads the way the real one does", { skip: !tmux }, () => {
  test("idle, working and no-Claude panes", async () => {
    const idle = make("idle"), working = make("working"), shell = make("shell");
    const { capture } = await import("../src/tmux.js");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(readPane(await capture(idle.name, 80)).state, "idle");
    const w = readPane(await capture(working.name, 80));
    assert.equal(w.state, "working"); assert.match(w.activity!, /Frosting… 12s/);
    assert.equal(readPane(await capture(shell.name, 80)).state, "unknown");
  });
});

describe("send next to a tmux session", { skip: !tmux }, () => {
  test("an idle session is claimed and typed into: the item, how to close it, on one line", async () => {
    const f = make("idle"); await new Promise((r) => setTimeout(r, 400));
    const it = await add("Add a dark theme to the settings page");
    const r = await s.post(`/todos/${it.id}/send`, { root: ws, tmux: f.name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((r.body!.item as { claimedBy: string }).claimedBy, `tmux:${f.name}`);
    await until(() => f.typed().includes("done_todo"), "the line to reach the pane");
    const lines = f.typed().trim().split("\n");
    assert.equal(lines.length, 1, "one line, one Enter");
    assert.match(lines[0], new RegExp(`^From the project board, item ${it.id.slice(0, 8)}: Add a dark theme to the settings page`));
    assert.match(lines[0], new RegExp(`claimed as tmux:${f.name}`));
    assert.equal((await items()).find((i) => i.id === it.id)!.status, "claimed");
  });

  test("a working session is refused, nothing is typed, the item stays queued", async () => {
    const f = make("working"); await new Promise((r) => setTimeout(r, 400));
    const it = await add("Refactor the router");
    const r = await s.post(`/todos/${it.id}/send`, { root: ws, tmux: f.name });
    assert.equal(r.status, 409); assert.match(String(r.body!.error), /working/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f.typed(), "");
    assert.equal((await items()).find((i) => i.id === it.id)!.status, "queued");
  });

  test("a pane with no Claude in it is refused too", async () => {
    const f = make("shell"); await new Promise((r) => setTimeout(r, 400));
    const it = await add("Anything");
    const r = await s.post(`/todos/${it.id}/send`, { root: ws, tmux: f.name });
    assert.equal(r.status, 409); assert.match(String(r.body!.error), /not at a Claude prompt/);
    assert.equal((await items()).find((i) => i.id === it.id)!.status, "queued");
    assert.equal(f.typed(), "");
  });

  test("a session that does not exist: 404, nothing claimed", async () => {
    const it = await add("Ghost task");
    assert.equal((await s.post(`/todos/${it.id}/send`, { root: ws, tmux: "ct-test-nope" })).status, 404);
    assert.equal((await items()).find((i) => i.id === it.id)!.status, "queued");
  });
});

describe("the owner's answer reaches the tmux session that asked", { skip: !tmux }, () => {
  test("at its prompt: typed in now, with the question it answers", async () => {
    const f = make("idle"); await new Promise((r) => setTimeout(r, 400));
    const q = await add("Reuse the dev token or create a second bot?", { for: "owner", addedBy: `tmux:${f.name}` });
    const r = await patch(q.id, { root: ws, action: "answer", result: "create a second bot" });
    assert.equal(r.status, 200); assert.equal(r.body!.replied, true);
    await until(() => f.typed().includes("create a second bot"), "the answer to reach the pane");
    assert.match(f.typed().trim(), /^The owner answered your question “Reuse the dev token or create a second bot\?”: create a second bot$/);
  });

  test("while it is working: nothing is typed, the answer waits in the hook's feed", async () => {
    const f = make("working"); await new Promise((r) => setTimeout(r, 400));
    const q = await add("Which port?", { for: "owner", addedBy: `tmux:${f.name}` });
    const r = await patch(q.id, { root: ws, action: "answer", result: "8124" });
    assert.equal(r.body!.replied, false);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f.typed(), "");
    const feed = (await s.json(`/todos?dir=${encodeURIComponent(ws)}`)).body!.answered as { text: string; result: string; addedBy: string }[];
    assert.ok(feed.some((i) => i.text === "Which port?" && i.result === "8124" && i.addedBy === `tmux:${f.name}`));
  });
});

describe("sendLine", { skip: !tmux }, () => {
  test("collapses newlines and runs of spaces: a newline in the input box would send what came before it", async () => {
    const f = make("idle"); await new Promise((r) => setTimeout(r, 400));
    await sendLine(f.name, "first line\n\n   second   line\r\nthird “quoted” — dash");
    await until(() => f.typed().includes("third"), "the line");
    assert.equal(f.typed(), "first line second line third “quoted” — dash\n");
    await assert.rejects(() => sendLine(f.name, " \n "), /nothing to send/);
    await assert.rejects(() => sendLine("bad name; rm", "x"), /no such session/);
  });
});

describe("orphaned claims with a real tmux", { skip: !tmux }, () => {
  test("a claim held by a tmux session that is gone goes back to the queue; one held by a live session stays", async () => {
    const t = await startTestServer({ cfg: { keeperMs: 60 } });
    const live = fakeClaude("idle", join(t.root, "ws")); sessions.push(live);
    try {
      const root = join(t.root, "ws");
      const claim = async (text: string, by: string) => {
        const it = (await t.post("/todos", { dir: root, text })).body as { id: string };
        await t.json(`/todos/${it.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ root, action: "claim", by }) });
        return it.id;
      };
      await new Promise((r) => setTimeout(r, 400));
      const gone = await claim("held by an exited session", "tmux:ct-test-exited"), kept = await claim("held by a live session", `tmux:${live.name}`);
      const status = async (id: string) => ((await t.json(`/todos?dir=${encodeURIComponent(root)}&all=1`)).body!.items as { id: string; status: string }[]).find((i) => i.id === id)!.status;
      await until(() => false, "never", 1).catch(() => {});
      const t0 = Date.now(); while (Date.now() - t0 < 5000 && (await status(gone)) !== "queued") await new Promise((r) => setTimeout(r, 40));
      assert.equal(await status(gone), "queued", "released: its session is gone");
      assert.equal(await status(kept), "claimed", "its session is alive: kept");
    } finally { await t.stop(); }
  });
});
