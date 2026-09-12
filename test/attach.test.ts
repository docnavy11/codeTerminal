import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { Manager } from "../src/conversation.js";
import { BrowserBridge } from "../src/browser.js";
import { attachAgent, attachShell, MAX_SHELLS, type AttachContext } from "../src/attach.js";
import { fakeSdk, settle, waitFor } from "./fakes/sdk.js";
import { FakeWs } from "./fakes/ws.js";

/**
 * The per-connection loops with a fake socket and the fake SDK: every inbound
 * message kind, the ones that must be ignored, and the ones that used to
 * crash the process.
 */
let root: string;
let n = 0;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-attach-"));
  await mkdir(join(root, "files", "sub"), { recursive: true });
  await mkdir(join(root, "ws"), { recursive: true });
  await writeFile(join(root, "files", "f.txt"), "x");
});
after(async () => { await rm(root, { recursive: true, force: true }); });

function world() {
  const sdk = fakeSdk();
  const convo = new Manager(join(root, "ws"), join(root, `chats-${++n}`), join(root, "projects"),
    { bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery, titler: async () => null });
  const bridge = new BrowserBridge(() => {}, 200);
  const ctx: AttachContext = { convo, bridge, filesRoot: join(root, "files"), workspace: join(root, "ws"), clients: new Set(), state: { lastChat: null, activeShell: null } };
  convo.onListChanged = () => { for (const f of ctx.clients) f(); };
  const agent = (replay = true) => { const ws = new FakeWs(); attachAgent(ws as unknown as WebSocket, ctx, replay); return ws; };
  return { sdk, convo, ctx, agent };
}

describe("attachAgent: connecting", () => {
  test("lands on the newest chat (creating one if none), announces list, mode and project", () => {
    const w = world();
    const ws = w.agent();
    assert.equal(w.sdk.queries.length, 1);
    assert.deepEqual(ws.kind("replayed").length, 1);
    const chats = ws.last("chats")!;
    assert.equal((chats.chats as unknown[]).length, 1);
    assert.equal(chats.activeId, w.convo.newestId());
    assert.equal(ws.last("mode")!.mode, "default");
    assert.equal(ws.last("project")!.id, "general");
    assert.equal(w.ctx.state.lastChat?.id, chats.activeId);
    assert.equal(w.ctx.clients.size, 1);
  });

  test("observe mode skips the replay", () => {
    const w = world();
    const c = w.convo.create(); c.recordUser("earlier");
    const ws = w.agent(false);
    assert.equal(ws.kind("user").length, 0);
    assert.equal(ws.kind("replayed").length, 1);
  });

  test("closing the socket detaches: no further events, list refresher removed", async () => {
    const w = world();
    const ws = w.agent();
    ws.close();
    assert.equal(w.ctx.clients.size, 0);
    ws.clear();
    w.sdk.last.text("after"); await settle();
    assert.equal(ws.sent.length, 0);
  });
});

describe("attachAgent: prompts", () => {
  test("a prompt reaches the session; withTab:false attaches no context", async () => {
    const w = world();
    const ws = w.agent();
    ws.frame({ type: "prompt", text: "hello", withTab: false });
    await settle(6);
    assert.equal(w.sdk.last.received.length, 1);
    assert.ok(!(w.sdk.last.received[0].message.content as string).includes("untrusted-page-data"));
  });

  test("a prompt with images: the model gets the image, the record keeps only the thumbnail", async () => {
    const w = world();
    const ws = w.agent();
    ws.frame({ type: "prompt", text: "look", withTab: false, images: [{ media_type: "image/png", data: "QUJD", thumb: "dGh1bWI=" }] });
    await settle(6);
    const sent = w.sdk.last.received[0].message.content as { type: string; source?: { data: string } }[];
    assert.equal(sent[0].type, "image"); assert.equal(sent[0].source!.data, "QUJD");
    const rec = w.ctx.state.lastChat!.record.events.find((e) => e.kind === "user") as { images?: { thumb: string; media_type: string }[] };
    assert.deepEqual(rec.images, [{ media_type: "image/png", thumb: "dGh1bWI=" }]);
    assert.ok(!JSON.stringify(rec).includes("QUJD"), "the full image is not in the record");
    const shown = ws.last("user") as { images?: unknown[] };
    assert.equal(shown.images!.length, 1, "clients get the thumbnail");
  });

  test("a prompt with tab context but no extension: no context, no error, still sent", async () => {
    const w = world();
    const ws = w.agent();
    ws.frame({ type: "prompt", text: "what is this page" });
    await settle(6);
    assert.equal(w.sdk.last.received.length, 1);
    assert.equal(ws.kind("error").length, 0);
  });

  test("a prompt while busy is refused with an error", async () => {
    const w = world();
    const ws = w.agent();
    ws.frame({ type: "prompt", text: "one", withTab: false });
    ws.frame({ type: "prompt", text: "two", withTab: false });
    await settle(6);
    assert.equal(w.sdk.last.received.length, 1);
    assert.match(ws.last("error")!.message as string, /Still working/);
  });

  test("malformed, unknown and ill-typed frames are ignored", async () => {
    const w = world();
    const ws = w.agent();
    await settle(4);                 // let the session's startup (commands) land first
    ws.clear();
    ws.frame("{not json");
    ws.frame({ type: "explode" });
    ws.frame({ type: "prompt", text: 42 });
    ws.frame({ type: "prompt" });
    ws.frame({ type: "mode", mode: "root" });
    ws.frame([1, 2, 3]);
    ws.frame(null);
    await settle(4);
    assert.equal(w.sdk.last.received.length, 0);
    assert.equal(ws.sent.length, 0);
    assert.equal(ws.readyState, 1);
  });

  test("the browser binding is applied at send time", async () => {
    const w = world();
    const ws = w.agent();
    const chat = w.ctx.state.lastChat!;
    ws.frame({ type: "browser", instance: "browser-A" });
    assert.equal(chat.extInstance, "browser-A");
    ws.frame({ type: "prompt", text: "x", withTab: false });
    await settle(4);
    assert.equal(chat.extInstance, "browser-A");
  });

  test("decision and answer are routed to the session", async () => {
    const w = world();
    const ws = w.agent();
    const { promise } = w.sdk.last.ask("Bash", { command: "ls" });
    const card = ws.last("approval")!;
    ws.frame({ type: "decision", id: card.id, decision: "deny" });
    assert.equal(((await promise) as { behavior: string }).behavior, "deny");
    const q = w.sdk.last.ask("AskUserQuestion", { questions: [{ question: "Q?", header: "h", multiSelect: false, options: [] }] });
    ws.frame({ type: "answer", id: ws.last("question")!.id, answers: { "Q?": "yes" } });
    assert.equal(((await q.promise) as { behavior: string }).behavior, "allow");
    ws.frame({ type: "decision", id: "nope", decision: "allow" });   // unknown id: ignored
    assert.equal(ws.kind("error").length, 0);
  });

  test("interrupt asks the SDK to stop", async () => {
    const w = world();
    const ws = w.agent();
    ws.frame({ type: "interrupt" }); await settle();
    assert.equal(w.sdk.last.interrupts, 1);
  });
});

describe("attachAgent: switching chats", () => {
  test("new: cleared, then the new chat's (empty) replay and list; new again on an unused chat stays", async () => {
    const w = world();
    const ws = w.agent();
    const first = ws.last("chats")!.activeId;
    w.ctx.state.lastChat!.recordUser("said something");
    ws.clear();
    ws.frame({ type: "new" });
    const order = ws.sent.map((m) => (m as { kind: string }).kind);
    assert.ok(order.indexOf("cleared") >= 0 && order.indexOf("cleared") < order.indexOf("replayed"), `cleared precedes the replay: ${order}`);
    assert.ok(order.lastIndexOf("chats") > order.indexOf("replayed"), "the list follows");
    const second = ws.last("chats")!.activeId;
    assert.notEqual(second, first);
    assert.equal(w.sdk.queries.length, 2);
    ws.frame({ type: "new" });
    assert.equal(ws.last("chats")!.activeId, second, "still on the unused chat");
    assert.equal(w.sdk.queries.length, 2);
  });

  test("open: switches this client only, replays that transcript; same id is a no-op", async () => {
    const w = world();
    const a = w.agent();
    const other = w.convo.create(); other.recordUser("in other");
    const b = w.agent();                 // lands on `other` (newest)
    a.clear(); b.clear();
    a.frame({ type: "open", id: other.id });
    assert.equal(a.last("chats")!.activeId, other.id);
    assert.equal(a.kind("user").length, 1);
    assert.equal(b.sent.length, 0, "the other client was not touched");
    a.clear();
    a.frame({ type: "open", id: other.id });
    assert.equal(a.sent.length, 0);
    a.frame({ type: "open", id: "aaaaaaaa-0000-0000-0000-00000000dead" });
    assert.equal(a.sent.length, 0, "unknown chat: nothing happens");
  });

  test("rename refreshes every client's list; a bad id does not kill the connection", () => {
    const w = world();
    const a = w.agent(); const b = w.agent();
    const id = a.last("chats")!.activeId as string;
    a.clear(); b.clear();
    a.frame({ type: "rename", id, title: "Renamed" });
    assert.ok((a.last("chats")!.chats as { title: string }[]).some((c) => c.title === "Renamed"));
    assert.ok((b.last("chats")!.chats as { title: string }[]).some((c) => c.title === "Renamed"));
    a.frame({ type: "rename", id: "../../etc/passwd", title: "x" });
    a.frame({ type: "open", id: "zzz" });
    a.frame({ type: "delete", id: "../x" });
    assert.equal(a.readyState, 1);
    assert.equal(a.kind("error").length, 0);
  });

  test("delete current: moves to the newest remaining, or creates one", async () => {
    const w = world();
    const ws = w.agent();
    const first = ws.last("chats")!.activeId as string;
    w.ctx.state.lastChat!.recordUser("x");
    ws.frame({ type: "new" });
    const second = ws.last("chats")!.activeId as string;
    ws.clear();
    ws.frame({ type: "delete", id: second });
    assert.equal(ws.last("chats")!.activeId, first, "back on the older chat");
    assert.ok(ws.kind("cleared").length >= 1);
    ws.frame({ type: "delete", id: first });
    const third = ws.last("chats")!.activeId as string;
    assert.notEqual(third, first); assert.notEqual(third, second);
    assert.equal(w.convo.list().length, 1);
  });

  test("delete other: only the list changes", () => {
    const w = world();
    const ws = w.agent();
    const mine = ws.last("chats")!.activeId;
    const other = w.convo.create(); other.recordUser("y");
    ws.clear();
    ws.frame({ type: "delete", id: other.id });
    assert.equal(ws.last("chats")!.activeId, mine);
    assert.equal(ws.kind("cleared").length, 0);
  });
});

describe("attachAgent: mode, cwd, project", () => {
  test("mode is per chat: the other client on another chat is untouched", async () => {
    const w = world();
    const a = w.agent();
    a.frame({ type: "mode", mode: "acceptEdits" }); await settle();
    assert.equal(a.last("mode")!.mode, "acceptEdits");
    assert.equal(w.ctx.state.lastChat!.mode, "acceptEdits");
    a.frame({ type: "mode", mode: "bypassPermissions" }); await settle();
    assert.match(a.last("error")!.message as string, /Never ask/);
    assert.equal(a.last("mode")!.mode, "acceptEdits");
  });

  test("cwd: outside the root, not a directory, and a good one", async () => {
    const w = world();
    const ws = w.agent();
    ws.frame({ type: "cwd", path: "../../etc" });
    await waitFor(() => ws.kind("error").length === 1, "outside error");
    assert.match(ws.last("error")!.message as string, /outside/);
    ws.frame({ type: "cwd", path: "f.txt" });
    await waitFor(() => ws.kind("error").length === 2, "not-a-directory error");
    assert.match(ws.last("error")!.message as string, /not a directory/);
    ws.frame({ type: "cwd", path: "sub" });
    await waitFor(() => ws.last("cwd")?.path === join(root, "files", "sub"), "cwd event");
    assert.equal(w.sdk.queries.length, 2, "the session was rebuilt in the new cwd");
    assert.equal(w.sdk.last.options.cwd, join(root, "files", "sub"));
  });

  test("project: an unknown id falls back to General; busy refuses", async () => {
    const w = world();
    const ws = w.agent();
    ws.frame({ type: "project", id: "does-not-exist" }); await settle(4);
    assert.equal(ws.last("project")!.id, "general");
    ws.frame({ type: "prompt", text: "busy", withTab: false }); await settle(4);
    ws.frame({ type: "project", id: "general" }); await settle(4);
    assert.match(ws.last("error")!.message as string, /Finish or stop/);
  });
});

describe("attachShell", () => {
  const shell = (ctx: AttachContext) => { const ws = new FakeWs(); attachShell(ws as unknown as WebSocket, ctx); return ws; };

  test("refuses the ninth shell with 1013 and accepts again after one closes", () => {
    const w = world();
    const open = Array.from({ length: MAX_SHELLS }, () => shell(w.ctx));
    assert.ok(open.every((s) => s.readyState === 1));
    const ninth = shell(w.ctx);
    assert.equal(ninth.closeCode, 1013);
    assert.match((ninth.sent[0] as { reason: string }).reason, /too many shells/);
    open[0].close();
    const again = shell(w.ctx);
    assert.equal(again.readyState, 1);
    for (const s of [...open, again]) s.close();
  });

  test("the newest pane is the active shell; closing it clears, closing an older one does not", () => {
    const w = world();
    const a = shell(w.ctx); const first = w.ctx.state.activeShell;
    const b = shell(w.ctx); const second = w.ctx.state.activeShell;
    assert.notEqual(first, second);
    a.close();
    assert.equal(w.ctx.state.activeShell, second, "an older pane closing does not steal the slot");
    b.close();
    assert.equal(w.ctx.state.activeShell, null);
  });

  test("input and resize before start, and malformed frames, are harmless", () => {
    const w = world();
    const s = shell(w.ctx);
    s.frame({ type: "input", data: "ls\n" });
    s.frame({ type: "resize", cols: 10, rows: 2 });
    s.frame("nope");
    s.frame({ type: "input", data: 7 });
    assert.equal(s.readyState, 1);
    s.close();
  });

  test("start spawns a real shell that echoes input and reports exit", async () => {
    const w = world();
    const s = shell(w.ctx);
    s.frame({ type: "start", cols: 80, rows: 24 });
    const out = () => s.raw.filter((x): x is Buffer => Buffer.isBuffer(x)).map((b) => b.toString()).join("");
    await waitFor(() => out().length > 0, "a prompt", 8000);
    s.frame({ type: "input", data: "echo MARK$((1+1))\n" });
    await waitFor(() => out().includes("MARK2"), "the echo", 8000);
    assert.ok(w.ctx.state.activeShell?.hasOutput);
    s.frame({ type: "input", data: "exit 3\n" });
    await waitFor(() => s.sent.some((m) => (m as { type?: string }).type === "exit"), "exit", 8000);
    const exit = s.sent.find((m) => (m as { type?: string }).type === "exit") as { code: number } | undefined;
    assert.equal(exit?.code, 3);
    assert.equal(s.readyState, 3, "the socket is closed with the shell");
    assert.equal(w.ctx.state.activeShell, null);
  });
});
