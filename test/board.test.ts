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

/* ---------------- the second round, over HTTP ---------------- */
import { readFile as readF, stat as statF } from "node:fs/promises";

const wsOf = () => join(s.root, "ws");
const listItems = async (dir = wsOf()) => (await s.json(`/todos?dir=${encodeURIComponent(dir)}&all=1`)).body!.items as { id: string; text: string; status: string; for: string; result?: string; claimedBy?: string; addedBy: string; notes?: string; images?: string[]; blockedBy?: string[] }[];
const byText = async (t: string) => (await listItems()).find((i) => i.text === t);
async function newChat() {
  const c = await s.socket("/ws");
  const first = String((await c.wait((m) => m.kind === "chats")).activeId);
  c.send({ type: "new" });
  const chatId = String((await c.wait((m) => m.kind === "chats" && m.activeId !== first)).activeId);
  return { c, chatId };
}
const received = (re: RegExp) => s.sdk.queries.find((q) => q.received.some((m) => re.test(JSON.stringify(m.message.content))));
const waitUntil = async (pred: () => boolean | Promise<boolean>, what: string, ms = 5000) => { const t0 = Date.now(); while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); } };

describe("notes, attachments, blockers, history", () => {
  test("an attached image is kept in the workspace; non-images are refused", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const r = await s.req("/todos/attach", { method: "POST", headers: { "content-type": "image/png" }, body: png });
    assert.equal(r.status, 200);
    const { path, bytes } = (await r.json()) as { path: string; bytes: number };
    assert.equal(bytes, png.length); assert.match(path, /\.todo-attachments\/task-\d+-[0-9a-f]{6}\.png$/);
    assert.deepEqual(await readF(path), png); assert.equal((await statF(path)).mode & 0o777, 0o600);
    assert.equal((await s.req("/todos/attach", { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" })).status, 400);
    assert.equal((await s.req("/todos/attach", { method: "POST", headers: { "content-type": "image/png" }, body: Buffer.alloc(0) })).status, 400);
  });

  test("a blocked item is refused by send and claim (409/400), and goes through once its blocker is done", async () => {
    const { c, chatId } = await newChat();
    const root = wsOf();
    const a = (await s.post("/todos", { dir: root, text: "blocker A" })).body as { id: string };
    const b = (await s.post("/todos", { dir: root, text: "blocked B", blockedBy: [a.id], notes: "line one\nline two" })).body as { id: string };
    const refused = await s.post(`/todos/${b.id}/send`, { root, chatId });
    assert.equal(refused.status, 409); assert.match(String(refused.body!.error), /blocked: waiting on "blocker A"/);
    assert.equal((await byText("blocked B"))!.status, "queued");
    const board = (await s.json("/board")).body!.projects as { root: string; queue: { text: string; waitingOn?: { text: string }[] }[] }[];
    assert.deepEqual(board.find((p) => p.root === root)!.queue.find((i) => i.text === "blocked B")!.waitingOn!.map((w) => w.text), ["blocker A"]);
    assert.equal((await patch(a.id, { root, action: "done", result: "ok" })).status, 200);
    // The chat is idle: B now goes, with its notes in the brief.
    const sent = await s.post(`/todos/${b.id}/send`, { root, chatId });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    await waitUntil(() => !!received(/blocked B — notes: line one line two/), "the brief with the notes");
    c.ws.close();
  });

  test("annotate sets notes, images and blockers over PATCH; the brief carries the images; refuses a cycle", async () => {
    const { c, chatId } = await newChat();
    const root = wsOf();
    const x = (await s.post("/todos", { dir: root, text: "task X" })).body as { id: string };
    const y = (await s.post("/todos", { dir: root, text: "task Y" })).body as { id: string };
    const ann = await patch(x.id, { root, action: "annotate", notes: "use the tokens", images: ["/w/.todo-attachments/shot.png"], blockedBy: [y.id] });
    assert.equal(ann.status, 200); assert.equal(ann.body!.notes, "use the tokens"); assert.deepEqual(ann.body!.blockedBy, [y.id]);
    assert.equal((await patch(y.id, { root, action: "annotate", blockedBy: [x.id] })).status, 400, "a cycle is refused");
    await patch(x.id, { root, action: "annotate", blockedBy: [] });
    assert.equal((await s.post(`/todos/${x.id}/send`, { root, chatId })).status, 200);
    await waitUntil(() => !!received(/task X — notes: use the tokens — images \(Read them\): \/w\/\.todo-attachments\/shot\.png/), "notes and image path in the brief");
    c.ws.close();
  });

  test("history searches finished work, reopen puts one back, and both survive a pruned archive", async () => {
    const root = wsOf();
    const h = (await s.post("/todos", { dir: root, text: "history probe task" })).body as { id: string };
    await patch(h.id, { root, action: "done", result: "unique-result-phrase" });
    const hit = (await s.json(`/todos/history?dir=${encodeURIComponent(root)}&q=UNIQUE-RESULT`)).body!.items as { id: string }[];
    assert.deepEqual(hit.map((i) => i.id), [h.id]);
    assert.deepEqual(((await s.json(`/todos/history?dir=${encodeURIComponent(root)}&q=zzzz-no-match`)).body!.items as unknown[]), []);
    const re = await patch(h.id, { root, action: "reopen" });
    assert.equal(re.status, 200); assert.equal(re.body!.status, "queued"); assert.equal(re.body!.result, undefined);
    assert.equal((await patch(h.id, { root, action: "reopen" })).status, 400, "not finished any more");
  });
});

describe("the keeper and held items, misreports, pause", () => {
  test("a held item is closed when the session reports the whole task done, with its result; a question is asked even while holding", async () => {
    const { c, chatId } = await newChat(); const root = wsOf();
    const it = (await s.post("/todos", { dir: root, text: "held and finished task" })).body as { id: string };
    assert.equal((await s.post(`/todos/${it.id}/send`, { root, chatId })).status, 200);
    await waitUntil(() => !!received(/held and finished task/), "the brief");
    const q = received(/held and finished task/)!;
    q.text("Fixed it. All three suites are green."); q.result();
    await waitUntil(async () => (await byText("held and finished task"))?.status === "done", "the keeper to close the held item");
    const done = (await byText("held and finished task"))!;
    assert.equal(done.result, "Fixed it"); assert.equal(done.claimedBy, `chat:${chatId}`);
    // A second item, held; the session asks the owner something instead of finishing.
    const it2 = (await s.post("/todos", { dir: root, text: "held and asking task" })).body as { id: string };
    assert.equal((await s.post(`/todos/${it2.id}/send`, { root, chatId })).status, 200);
    await waitUntil(() => !!received(/held and asking task/), "the second brief");
    const q2 = received(/held and asking task/)!;
    q2.text("Which colour should the badge be?"); q2.result();
    await waitUntil(async () => (await listItems()).some((i) => i.for === "owner" && i.text === "Which colour should the badge be?" && i.addedBy === `chat:${chatId}`), "the question for the owner");
    assert.equal((await byText("held and asking task"))!.status, "claimed", "asking does not close the item it holds");
    c.ws.close();
  });

  test("a card the keeper recorded can be reported: not a task (removed, never recorded again) or wrong title (renamed); either saves the thread", async () => {
    const { c, chatId } = await newChat(); const root = wsOf();
    c.send({ type: "prompt", text: "tell me a joke about ports" });
    await waitUntil(() => !!received(/joke about ports/), "the prompt");
    const q = received(/joke about ports/)!; q.text("Done. Why did the port stay open? It had nothing to close."); q.result();
    await waitUntil(async () => (await byText("tell me a joke about ports")) !== undefined, "the keeper's record");
    const rec = (await byText("tell me a joke about ports"))!;
    assert.equal(rec.status, "done");
    assert.equal((await s.post("/board/misread", { root, id: rec.id, wanted: "title" })).status, 400, "a title is needed");
    const owner = (await s.post("/todos", { dir: root, text: "my own task" })).body as { id: string };
    await patch(owner.id, { root, action: "done", result: "x" });
    assert.equal((await s.post("/board/misread", { root, id: owner.id, wanted: "not_done" })).status, 400, "only the keeper's cards");
    assert.equal((await s.post("/board/misread", { root, id: "nope", wanted: "not_done" })).status, 400);
    const r = await s.post("/board/misread", { root, id: rec.id, wanted: "not_done" });
    assert.equal(r.status, 200);
    assert.equal(await byText("tell me a joke about ports"), undefined, "removed");
    await s.json("/board"); await s.json("/board");
    assert.equal(await byText("tell me a joke about ports"), undefined, "and not recorded again");
    const lines = (await readF(join(wsOf(), "keeper-misreads.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert.equal(last.key, `chat:${chatId}`); assert.equal(last.said.title, "tell me a joke about ports"); assert.deepEqual(last.wanted, { status: "working" });
    assert.match(last.tail, /joke about ports/);
    // Wrong title: a second card, renamed.
    c.send({ type: "prompt", text: "rename the staging bucket please" });
    await waitUntil(() => !!received(/rename the staging bucket/), "the second prompt");
    const q2 = received(/rename the staging bucket/)!; q2.text("Done. Renamed it to staging-eu."); q2.result();
    await waitUntil(async () => (await byText("rename the staging bucket please")) !== undefined, "the second record");
    const rec2 = (await byText("rename the staging bucket please"))!;
    assert.equal((await s.post("/board/misread", { root, id: rec2.id, wanted: "title", title: "Rename the staging bucket" })).status, 200);
    assert.equal((await listItems()).find((i) => i.id === rec2.id)!.text, "Rename the staging bucket");
    assert.deepEqual((await readF(join(wsOf(), "keeper-misreads.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).at(-1).wanted, { status: "done", title: "Rename the staging bucket" });
    c.ws.close();
  });

  test("pause stops new reads (cached cards stay), the counter counts reads, and the board says both", async () => {
    const { c } = await newChat();
    const k0 = (await s.json("/board")).body!.keeper as { paused: boolean; calls: number; date: string };
    assert.equal(k0.paused, false); assert.match(k0.date, /^\d{4}-\d\d-\d\d$/);
    assert.equal((await s.post("/board/keeper", { paused: true })).body!.paused, true);
    const calls = (await s.json("/board/keeper")).body!.calls as number;
    c.send({ type: "prompt", text: "a prompt while the keeper is paused" });
    await waitUntil(() => !!received(/while the keeper is paused/), "the prompt");
    const q = received(/while the keeper is paused/)!; q.text("Working on it."); q.result();
    await new Promise((r) => setTimeout(r, 300)); await s.json("/board");
    assert.equal((await s.json("/board/keeper")).body!.calls, calls, "no read while paused");
    assert.equal(((await s.json("/board")).body!.keeper as { paused: boolean }).paused, true);
    assert.equal((await s.post("/board/keeper", { paused: false })).body!.paused, false);
    c.send({ type: "prompt", text: "a prompt after the keeper resumed" });
    await waitUntil(() => !!received(/after the keeper resumed/), "the second prompt");
    const q2 = received(/after the keeper resumed/)!; q2.text("Working on that."); q2.result();
    await waitUntil(async () => ((await s.json("/board/keeper")).body!.calls as number) > calls, "a read after resuming");
    c.ws.close();
  });
});

describe("auto-dispatch and orphaned claims", () => {
  let a: TestServer;
  before(async () => { a = await startTestServer({ cfg: { shell: false, keeperMs: 60 } }); });
  after(async () => { await a.stop(); });
  const aItems = async () => (await a.json(`/todos?dir=${encodeURIComponent(join(a.root, "ws"))}&all=1`)).body!.items as { id: string; text: string; status: string; claimedBy?: string }[];
  const aReceived = (re: RegExp) => a.sdk.queries.find((q) => q.received.some((m) => re.test(JSON.stringify(m.message.content))));

  test("off by default; on, an idle session takes the next ready item, one at a time, never a blocked one", async () => {
    const root = join(a.root, "ws");
    const c = await a.socket("/ws"); await c.wait((m) => m.kind === "chats");
    const first = (await a.post("/todos", { dir: root, text: "auto first" })).body as { id: string };
    await a.post("/todos", { dir: root, text: "auto second", blockedBy: [first.id] });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await aItems()).find((i) => i.text === "auto first")!.status, "queued", "nothing moves unless the project opted in");
    assert.equal((await a.post("/board/auto", { root, on: true })).body!.on, true);
    assert.equal(((await a.json("/board")).body!.projects as { root: string; auto: boolean }[]).find((p) => p.root === root)!.auto, true);
    await waitUntil(async () => (await aItems()).find((i) => i.text === "auto first")!.status === "claimed", "auto-dispatch");
    assert.match((await aItems()).find((i) => i.text === "auto first")!.claimedBy!, /^chat:/);
    await waitUntil(() => !!aReceived(/auto first/), "the brief to reach the session");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await aItems()).find((i) => i.text === "auto second")!.status, "queued", "blocked, and the session is busy: not dispatched");
    c.ws.close();
  });

  test("a tmux claim is not released when tmux cannot be listed; a deleted chat releases what it held", async () => {
    const root = join(a.root, "ws");
    const g = (await a.post("/todos", { dir: root, text: "held by a ghost" })).body as { id: string };
    await a.json(`/todos/${g.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ root, action: "claim", by: "tmux:ghost" }) });
    const c = await a.socket("/ws"); const first = String((await c.wait((m) => m.kind === "chats")).activeId);
    c.send({ type: "new" }); const chatId = String((await c.wait((m) => m.kind === "chats" && m.activeId !== first)).activeId);
    const h = (await a.post("/todos", { dir: root, text: "held by a chat" })).body as { id: string };
    await a.json(`/todos/${h.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ root, action: "claim", by: `chat:${chatId}` }) });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await aItems()).find((i) => i.text === "held by a ghost")!.status, "claimed", "shell off: tmux is not listable, so 'gone' means nothing");
    assert.equal((await aItems()).find((i) => i.text === "held by a chat")!.status, "claimed", "a live chat's claim stays");
    c.ws.close();
    assert.equal((await a.json(`/chats/${chatId}`, { method: "DELETE" })).status, 200);
    await waitUntil(async () => (await aItems()).find((i) => i.text === "held by a chat")!.status === "queued", "the deleted chat's claim to be released");
  });
});

describe("links on done cards", () => {
  test("a commit the result names becomes a link (to the remote when there is one); a hash git does not know is not; a live chat that did it is linked", async () => {
    const { execFileSync } = await import("node:child_process");
    const { writeFile: wf } = await import("node:fs/promises");
    const repo = join(s.root, "projects", "p1");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", repo, ...a], { encoding: "utf8" }).trim();
    g("init", "-q"); await wf(join(repo, "f.txt"), "x"); g("add", "."); g("commit", "-q", "-m", "first");
    g("remote", "add", "origin", "git@github.com:acme/widgets.git");
    const hash = g("rev-parse", "--short=9", "HEAD"), full = g("rev-parse", "HEAD");
    const { chatId, c } = await newChat();
    const real = (await s.post("/todos", { project: "p1", text: "ship the widget" })).body as { id: string };
    await s.json(`/todos/${real.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: repo, action: "done", result: `committed as ${hash} on main`, by: `chat:${chatId}` }) });
    const fake = (await s.post("/todos", { project: "p1", text: "mention a made-up hash" })).body as { id: string };
    await s.json(`/todos/${fake.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: repo, action: "done", result: "fixed in deadbeef1 maybe", by: "owner" }) });
    const p = ((await s.json("/board")).body!.projects as { root: string; queue: { id: string; links?: { chatId?: string; commit?: { hash: string; url?: string } } }[] }[]).find((x) => x.root === repo)!;
    const l = p.queue.find((i) => i.id === real.id)!.links!;
    assert.equal(l.chatId, chatId); assert.deepEqual(l.commit, { hash, url: `https://github.com/acme/widgets/commit/${full}` });
    assert.equal(p.queue.find((i) => i.id === fake.id)!.links, undefined, "an unknown hash is not a link");
    c.ws.close();
  });
});
