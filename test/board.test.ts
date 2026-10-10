import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./fakes/server.js";
import { waitFor } from "./fakes/sdk.js";

/** The board and the todo routes, over HTTP, with a fake SDK behind the chats. */
let s: TestServer;
before(async () => {
  // shell off: with it on, the board would list this machine's real tmux sessions.
  s = await startTestServer({ cfg: { shell: false } });
  await mkdir(join(s.root, "projects", "p1", "sub"), { recursive: true });
  await mkdir(join(s.root, "projects", "p2", ".git"), { recursive: true });
});
after(async () => { await s.stop(); });

const patch = (id: string, body: unknown) => s.json(`/todos/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("todos over HTTP", () => {
  test("an empty board; add by project id, by name, by directory; the file lands at the project root", async () => {
    const b0 = await s.json("/board");
    assert.equal(b0.status, 200);
    assert.deepEqual(b0.body!.projects, []); assert.deepEqual(b0.body!.forYou, []);
    assert.deepEqual((b0.body!.allProjects as { id: string }[]).map((p) => p.id), ["p1", "p2"]);

    const a = await s.post("/todos", { project: "p1", text: "first thing" });
    assert.equal(a.status, 200); assert.equal(a.body!.status, "queued"); assert.equal(a.body!.for, "claude"); assert.equal(a.body!.addedBy, "owner");
    const b = await s.post("/todos", { dir: join(s.root, "projects", "p1", "sub"), text: "second, from a subdirectory", addedBy: "tmux:wt_1" });
    assert.equal(b.status, 200);
    assert.ok(existsSync(join(s.root, "projects", "p1", "todo.json")), "one file at the project root, not in the subdirectory");
    assert.ok(!existsSync(join(s.root, "projects", "p1", "sub", "todo.json")));
    const q = await s.post("/todos", { project: "P1", text: "which token for prod?", for: "owner", addedBy: "chat:nope" });
    assert.equal(q.status, 200); assert.equal(q.body!.for, "owner");

    const list = await s.json(`/todos?dir=${encodeURIComponent(join(s.root, "projects", "p1", "sub"))}`);
    assert.equal(list.status, 200);
    assert.equal(list.body!.root, join(s.root, "projects", "p1"));
    assert.deepEqual((list.body!.items as { text: string }[]).map((i) => i.text), ["which token for prod?", "first thing", "second, from a subdirectory"]);

    const board = await s.json("/board");
    const p1 = (board.body!.projects as { id: string; name: string; sessions: unknown[]; queue: { text: string }[]; counts: unknown }[]).find((p) => p.id === "p1")!;
    assert.ok(p1, "a project with a queue is on the board without any session");
    assert.deepEqual(p1.queue.map((i) => i.text), ["first thing", "second, from a subdirectory"]);
    assert.deepEqual(p1.counts, { queued: 2, claimed: 0, forYou: 1 });
    assert.equal((board.body!.forYou as { text: string; project: string }[])[0].text, "which token for prod?");
    assert.equal((board.body!.forYou as { project: string }[])[0].project, "p1");
  });

  test("refuses what it should: no text, unknown project, a directory outside the roots, an unknown action", async () => {
    assert.equal((await s.post("/todos", { project: "p1", text: "   " })).status, 400);
    assert.match(String((await s.post("/todos", { project: "nope", text: "x" })).body!.error), /no project nope/);
    assert.match(String((await s.post("/todos", { dir: "/etc", text: "x" })).body!.error), /outside the projects root/);
    assert.equal((await s.post("/todos", { text: "x" })).status, 400);
    const items = (await s.json("/todos?project=p1")).body!.items as { id: string }[];
    assert.match(String((await patch(items[0].id, { root: join(s.root, "projects", "p1"), action: "explode" })).body!.error), /action:/);
  });

  test("claim, release, done, drop, answer, reorder", async () => {
    const root = join(s.root, "projects", "p1");
    const items = (await s.json("/todos?project=p1")).body!.items as { id: string; text: string; for: string }[];
    const first = items.find((i) => i.text === "first thing")!, second = items.find((i) => i.text.startsWith("second"))!, q = items.find((i) => i.for === "owner")!;

    const c = await patch(first.id, { root, action: "claim", by: "tmux:wt_1" });
    assert.equal(c.status, 200); assert.equal(c.body!.status, "claimed"); assert.equal(c.body!.claimedBy, "tmux:wt_1");
    assert.match(String((await patch(first.id, { root, action: "claim", by: "laptop" })).body!.error), /already claimed by tmux:wt_1/);
    assert.equal((await patch(first.id, { root, action: "release" })).body!.status, "queued");
    const d = await patch(first.id, { root, action: "done", result: "shipped" });
    assert.equal(d.body!.status, "done"); assert.equal(d.body!.result, "shipped");
    assert.equal((await patch(second.id, { root, action: "edit", text: "second, reworded" })).body!.text, "second, reworded");
    // The owner answers; the asking chat is not live, so it is recorded for the chat's next turn.
    const ans = await patch(q.id, { root, action: "answer", result: "reuse the dev one" });
    assert.equal(ans.status, 200); assert.equal(ans.body!.status, "done"); assert.equal(ans.body!.result, "reuse the dev one"); assert.equal(ans.body!.replied, false);
    assert.equal((await s.json("/board")).body!.forYou && ((await s.json("/board")).body!.forYou as unknown[]).length, 0);

    const x = await s.post("/todos", { project: "p1", text: "third" });
    const re = await s.post("/todos/reorder", { root, ids: [x.body!.id, second.id] });
    assert.equal(re.status, 200);
    const open = ((await s.json("/todos?project=p1")).body!.items as { text: string }[]).map((i) => i.text);
    assert.deepEqual(open, ["third", "second, reworded"]);
    assert.equal((await patch(x.body!.id, { root, action: "drop" })).body!.status, "dropped");
    const onDisk = JSON.parse(await readFile(join(root, "todo.json"), "utf8"));
    assert.equal(onDisk.items.length, 4);
  });
});

describe("the board and a live chat", () => {
  test("a live chat shows idle; send next claims the item for it and prompts it with the item; the queue block rides along", async () => {
    const c = await s.socket("/ws");
    const chats = await c.wait((m) => m.kind === "chats");
    const chatId = String(chats.activeId);
    // The chat works in the workspace, which is outside the projects root: its own directory is the root.
    const ws = join(s.root, "ws");
    await s.post("/todos", { dir: ws, text: "wire the board" });
    await s.post("/todos", { dir: ws, text: "then the phone" });

    const b1 = await s.json("/board");
    const card = (b1.body!.projects as { root: string; sessions: { kind: string; id?: string; state: string; title?: string }[]; queue: { id: string; text: string }[] }[]).find((p) => p.root === ws)!;
    assert.ok(card, "the chat's project is on the board");
    assert.deepEqual(card.sessions.map((r) => `${r.kind}:${r.state}`), ["chat:idle"]);
    assert.equal(card.sessions[0].id, chatId);

    const next = card.queue[0];
    const sent = await s.post(`/todos/${next.id}/send`, { root: ws, chatId });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal((sent.body!.item as { status: string; claimedBy: string }).status, "claimed");
    assert.equal((sent.body!.item as { claimedBy: string }).claimedBy, `chat:${chatId}`);

    // The fake SDK got the prompt: the item itself, and the owner-authored queue block with what the chat holds and what is still queued.
    await waitFor(() => (s.sdk.last?.received.length ?? 0) > 0, "the prompt to reach the SDK");
    const content = s.sdk.last.received[0].message.content;
    const textOf = typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((b) => b.text ?? "").join("\n");
    assert.match(textOf, /From the project board, item [0-9a-f]{8}: wire the board/);
    assert.match(textOf, /<project-queue note=/);
    assert.match(textOf, /You hold:\n- \[[0-9a-f]{8}\] wire the board/);
    assert.match(textOf, /Queued for this project[^\n]*\n- \[[0-9a-f]{8}\] then the phone/);
    // The transcript shows the prompt as a user message, so the person sees what was sent.
    const user = await c.wait((m) => m.kind === "user" && /wire the board/.test(String(m.text)));
    assert.ok(user);

    // The chat is busy now: a second send is refused and the item stays queued.
    const again = await s.post(`/todos/${card.queue[1].id}/send`, { root: ws, chatId });
    assert.equal(again.status, 409);
    const after = (await s.json(`/todos?dir=${encodeURIComponent(ws)}`)).body!.items as { text: string; status: string }[];
    assert.deepEqual(after.map((i) => `${i.text}:${i.status}`), ["wire the board:claimed", "then the phone:queued"]);
    const b2 = await s.json("/board");
    const card2 = (b2.body!.projects as { root: string; sessions: { state: string; summary?: string | null; lastText?: string }[] }[]).find((p) => p.root === ws)!;
    assert.equal(card2.sessions[0].state, "busy");
    // The thread summary: null on the first poll (computed in the background), the injected assessor's line after.
    await new Promise((r) => setImmediate(r));
    const b3 = await s.json("/board");
    const card3 = (b3.body!.projects as { root: string; sessions: { summary?: string | null; task?: { title: string; status: string } }[] }[]).find((p) => p.root === ws)!;
    assert.match(String(card3.sessions[0].summary), /^about: user: From the project board/);
    assert.equal(card3.sessions[0].task?.status, "working");
    c.ws.close();
  });

  test("send next to a tmux session: 404 when there is none (the shell is off here); nothing is claimed", async () => {
    const ws = join(s.root, "ws");
    const items = (await s.json(`/todos?dir=${encodeURIComponent(ws)}`)).body!.items as { id: string; status: string }[];
    const queued = items.find((i) => i.status === "queued")!;
    const r = await s.post(`/todos/${queued.id}/send`, { root: ws, tmux: "wt_nope" });
    assert.equal(r.status, 404);
    const after = (await s.json(`/todos?dir=${encodeURIComponent(ws)}`)).body!.items as { id: string; status: string }[];
    assert.equal(after.find((i) => i.id === queued.id)!.status, "queued");
  });

  test("the keeper: a turn the model reads as finished lands in done, titled; a pause between turns does not; a board item's turn does not", async () => {
    const c = await s.socket("/ws");
    const first = String((await c.wait((m) => m.kind === "chats")).activeId);
    c.send({ type: "new" });
    await c.wait((m) => m.kind === "chats" && m.activeId !== first);
    c.send({ type: "prompt", text: "please fix the flaky upgrade test in server.test.ts" });
    await waitFor(() => s.sdk.last?.received.some((m) => /flaky upgrade/.test(JSON.stringify(m.message.content))) ?? false, "the prompt");
    // First reply: a progress report, not a finish. The keeper reads "working": nothing lands in done.
    s.sdk.last.text("Looking at the test now; the port is picked before the server listens.");
    s.sdk.last.result();
    await c.wait((m) => m.kind === "turn_end");
    await new Promise((r) => setTimeout(r, 30));
    const ws = join(s.root, "ws");
    let items = (await s.json(`/todos?dir=${encodeURIComponent(ws)}&all=1`)).body!.items as { text: string; status: string; result?: string; addedBy: string }[];
    assert.ok(!items.some((i) => i.text.startsWith("please fix the flaky")), "a pause between turns is not a finished task");
    // Second turn finishes it: done, titled by the model's read, with its result.
    c.send({ type: "prompt", text: "go ahead and fix it" });
    await waitFor(() => s.sdk.last?.received.some((m) => /go ahead/.test(JSON.stringify(m.message.content))) ?? false, "the second prompt");
    s.sdk.last.text("Fixed by waiting for listen. All green.");
    s.sdk.last.result();
    await c.wait((m) => m.kind === "turn_end" && JSON.stringify(m).length > 0);
    await new Promise((r) => setTimeout(r, 30));
    items = (await s.json(`/todos?dir=${encodeURIComponent(ws)}&all=1`)).body!.items as { text: string; status: string; result?: string; addedBy: string }[];
    const rec = items.find((i) => i.text === "go ahead and fix it");
    assert.ok(rec, "the finished task was recorded");
    assert.equal(rec!.status, "done"); assert.equal(rec!.result, "Fixed by waiting for listen"); assert.match(rec!.addedBy, /^chat:/);
    // Polled again, the same finished thread is not recorded twice.
    await s.json("/board"); await s.json("/board");
    items = (await s.json(`/todos?dir=${encodeURIComponent(ws)}&all=1`)).body!.items as { text: string }[];
    assert.equal(items.filter((i) => i.text === "go ahead and fix it").length, 1);
    // The board-item turn from the earlier test is held by its chat: it is not recorded a second time.
    assert.equal(items.filter((i) => /wire the board/.test(i.text)).length, 1);
    // A reply that asks the owner something becomes a question on the board.
    c.send({ type: "prompt", text: "set up the prod bot too" });
    await waitFor(() => s.sdk.last?.received.some((m) => /prod bot/.test(JSON.stringify(m.message.content))) ?? false, "the third prompt");
    s.sdk.last.text("Reuse the dev token or create a second bot?"); s.sdk.last.result();
    await c.wait((m) => m.kind === "turn_end" && JSON.stringify(m).length > 1);
    await new Promise((r) => setTimeout(r, 30));
    items = (await s.json(`/todos?dir=${encodeURIComponent(ws)}&all=1`)).body!.items as { text: string; for: string; status: string }[];
    const ask = items.find((i) => i.for === "owner" && i.text === "Reuse the dev token or create a second bot?");
    assert.ok(ask, "the question is on the board for the owner"); assert.equal(ask!.status, "queued");
    // The model rephrases on the next read: still one open question for this session.
    c.send({ type: "prompt", text: "hmm, what do you think?" });
    await waitFor(() => s.sdk.last?.received.some((m) => /what do you think/.test(JSON.stringify(m.message.content))) ?? false, "the fourth prompt");
    s.sdk.last.text("Shall I reuse the dev token, or create a second bot for prod?"); s.sdk.last.result();
    await c.wait((m) => m.kind === "turn_end" && JSON.stringify(m).length > 2);
    await new Promise((r) => setTimeout(r, 30));
    items = (await s.json(`/todos?dir=${encodeURIComponent(ws)}&all=1`)).body!.items as { text: string; for: string; status: string; addedBy: string }[];
    assert.equal(items.filter((i) => i.for === "owner" && i.status === "queued" && i.addedBy === ask!.addedBy).length, 1, "one open question per session");
    c.ws.close();
  });

  test("a chat stopped on an approval card is waiting on the board with the card, and /board/decide answers it", async () => {
    const c = await s.socket("/ws");
    const first = String((await c.wait((m) => m.kind === "chats")).activeId);
    c.send({ type: "new" });
    const chatId = String((await c.wait((m) => m.kind === "chats" && m.activeId !== first)).activeId);
    c.send({ type: "prompt", text: "run the tests please, all of them" });
    await waitFor(() => s.sdk.last?.received.some((m) => /run the tests/.test(JSON.stringify(m.message.content))) ?? false, "the prompt");
    const { promise } = s.sdk.last.ask("Bash", { command: "npm test" });
    await c.wait((m) => m.kind === "approval");
    const b1 = await s.json("/board");
    const me = (b1.body!.projects as { sessions: { id?: string; state: string; pending?: { id: string; kind: string; summary: string }[] }[] }[]).flatMap((p) => p.sessions).find((r) => r.id === chatId)!;
    assert.equal(me.state, "waiting");
    assert.equal(me.pending!.length, 1); assert.equal(me.pending![0].kind, "approval"); assert.equal(me.pending![0].summary, "Bash: npm test");
    assert.equal((await s.post("/board/decide", { chatId, id: me.pending![0].id, decision: "maybe" })).status, 400);
    const ok = await s.post("/board/decide", { chatId, id: me.pending![0].id, decision: "allow" });
    assert.equal(ok.status, 200);
    assert.equal((await promise).behavior, "allow");
    assert.equal((await s.post("/board/decide", { chatId, id: me.pending![0].id, decision: "allow" })).status, 409, "answered once");
    assert.equal((await s.post("/board/decide", { chatId: "nope", id: "x", decision: "allow" })).status, 404);
    c.ws.close();
  });

  test("an answer reaches a live idle chat as a prompt; a busy chat reads it later", async () => {
    const c = await s.socket("/ws");
    const first = String((await c.wait((m) => m.kind === "chats")).activeId);
    c.send({ type: "new" });
    const chatId = String((await c.wait((m) => m.kind === "chats" && m.activeId !== first)).activeId);
    const ws = join(s.root, "ws");
    // The chat asked (as todos.ask would): an owner item signed by it.
    const q = await s.post("/todos", { dir: ws, text: "Which port should the dev server use?", for: "owner", addedBy: `chat:${chatId}` });
    assert.equal(q.status, 200);
    const r = await patch(q.body!.id as string, { root: ws, action: "answer", result: "8124, the old one is taken" });
    assert.equal(r.status, 200); assert.equal(r.body!.replied, true, "the chat was idle: prompted now");
    await waitFor(() => s.sdk.last?.received.some((m) => /8124, the old one is taken/.test(JSON.stringify(m.message.content))) ?? false, "the answer to reach the SDK");
    const sent = JSON.stringify(s.sdk.last.received.find((m) => /8124/.test(JSON.stringify(m.message.content)))!.message.content);
    assert.match(sent, /The owner answered your question “Which port should the dev server use\?”: 8124/);
    // While it is busy with that, a second answer is saved for its next turn (replied false), and the prompt block will carry it.
    const q2 = await s.post("/todos", { dir: ws, text: "And the host?", for: "owner", addedBy: `chat:${chatId}` });
    const r2 = await patch(q2.body!.id as string, { root: ws, action: "answer", result: "the tailnet address" });
    assert.equal(r2.body!.replied, false);
    const feed = (await s.json(`/todos?dir=${encodeURIComponent(ws)}`)).body!;
    assert.ok((feed.answered as { text: string; result: string }[]).some((i) => i.text === "And the host?" && i.result === "the tailnet address"), "the hook's feed carries the answer");
    c.ws.close();
  });

  test("a chat's TodoWrite steps show on its row", async () => {
    const c = await s.socket("/ws");
    const first = String((await c.wait((m) => m.kind === "chats")).activeId);
    c.send({ type: "new" });
    // wait() finds the first matching frame; the one after "new" names a different chat.
    const chats = await c.wait((m) => m.kind === "chats" && m.activeId !== first);
    const chatId = String(chats.activeId);
    c.send({ type: "prompt", text: "plan it" });
    await waitFor(() => s.sdk.last?.received.some((m) => /plan it/.test(JSON.stringify(m.message.content))) ?? false, "the prompt");
    s.sdk.last.emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "read the code", status: "completed", activeForm: "Reading" }, { content: "write the board", status: "in_progress", activeForm: "Writing" }] } }] }, parent_tool_use_id: null, session_id: "sdk-session-1" });
    await c.wait((m) => m.kind === "tool" && m.name === "TodoWrite");
    const b = await s.json("/board");
    const rows = (b.body!.projects as { sessions: { id?: string; steps?: { content: string; status: string }[] }[] }[]).flatMap((p) => p.sessions);
    const me = rows.find((r) => r.id === chatId)!;
    assert.deepEqual(me.steps, [{ content: "read the code", status: "completed" }, { content: "write the board", status: "in_progress" }]);
    c.ws.close();
  });
});
