import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager, type LiveChat } from "../src/conversation.js";
import { Store } from "../src/store.js";
import type { ClientEvent, SessionDeps } from "../src/session.js";
import { fakeSdk, settle } from "./fakes/sdk.js";

/**
 * LiveChat and Manager against the fake SDK: what a prompt does, what the
 * record keeps, when a session is rebuilt, and how the pool evicts.
 */
let root: string;
let n = 0;
before(async () => { root = await mkdtemp(join(tmpdir(), "ct-conv-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

function fresh(opts: { titler?: SessionDeps["titler"]; onUser?: Parameters<typeof fakeSdk>[0]["onUser"] } = {}) {
  const sdk = fakeSdk({ onUser: opts.onUser });
  const dir = join(root, `chats-${++n}`);
  const listChanges: number[] = [];
  const mgr = new Manager(join(root, "ws"), dir, join(root, "projects"), {
    bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined,
    spawnQuery: sdk.spawnQuery, titler: opts.titler ?? (async () => null),
  });
  mgr.onListChanged = () => listChanges.push(Date.now());
  const client = () => { const events: ClientEvent[] = []; const emit = (e: ClientEvent) => events.push(e); return { events, emit, kinds: () => events.map((e) => e.kind), last: (k: string) => events.filter((e) => e.kind === k).at(-1) as Record<string, unknown> | undefined }; };
  return { sdk, mgr, dir, listChanges, client };
}

describe("LiveChat: spawning and mode", () => {
  test("create() spawns one session; the mode comes from the creating chat", async () => {
    const { sdk, mgr } = fresh();
    const a = mgr.create();
    assert.equal(sdk.queries.length, 1);
    assert.equal(sdk.last.options.permissionMode, "default");
    await a.setMode("acceptEdits");
    a.recordUser("something");           // an unused chat would be handed back as-is
    const b = mgr.create(a);
    assert.equal(sdk.queries.length, 2);
    assert.equal(sdk.last.options.permissionMode, "acceptEdits");
    assert.equal(b.mode, "acceptEdits");
    assert.equal(b.record.cwd, a.record.cwd);
  });

  test("a chat admitted from disk starts in default whatever its record says", async () => {
    const { sdk, mgr, dir } = fresh();
    new Store(dir).write({ id: "aaaaaaaa-0000-0000-0000-000000000001", title: "Old", createdAt: 1, updatedAt: 1, sdkSessionId: "sid-old", cwd: null, events: [{ kind: "user", text: "x" } as never], granted: [{ type: "addRules" } as never], mode: "acceptEdits" });
    const c = mgr.get("aaaaaaaa-0000-0000-0000-000000000001")!;
    assert.equal(c.mode, "default");
    assert.equal(sdk.last.options.permissionMode, "default");
    assert.equal(sdk.last.options.resume, "sid-old", "resumes the SDK conversation");
    assert.equal(mgr.get("aaaaaaaa-0000-0000-0000-000000000001"), c, "admitted once");
    assert.equal(sdk.queries.length, 1);
  });

  test("get() on an unknown or malformed id is null and spawns nothing", () => {
    const { sdk, mgr } = fresh();
    assert.equal(mgr.get("aaaaaaaa-0000-0000-0000-000000000009"), null);
    assert.equal(mgr.get("../../etc/passwd"), null);
    assert.equal(sdk.queries.length, 0);
  });
});

describe("LiveChat.attach", () => {
  test("replays the transcript, then replayed/cwd/status; no replay when asked", async () => {
    const { mgr, client } = fresh();
    const c = mgr.create();
    c.recordUser("first");
    const a = client(); c.attach(a.emit, true);
    assert.deepEqual(a.kinds().slice(0, 1), ["user"]);
    assert.deepEqual(a.kinds().slice(-3), ["replayed", "cwd", "status"]);
    const b = client(); c.attach(b.emit, false);
    assert.deepEqual(b.kinds(), ["replayed", "cwd", "status"]);
    assert.equal(c.clients, 2);
    c.detach(a.emit);
    assert.equal(c.clients, 1);
  });

  test("two clients on one chat both hear live events; a detached one hears nothing", async () => {
    const { sdk, mgr, client } = fresh();
    const c = mgr.create();
    const a = client(), b = client();
    c.attach(a.emit); c.attach(b.emit);
    c.detach(a.emit);
    sdk.last.text("hello"); await settle();
    assert.equal(b.last("text")?.text, "hello");
    assert.equal(a.last("text"), undefined);
  });
});

describe("LiveChat.prompt", () => {
  test("is busy for the whole context lookup, so a second prompt in that window is refused", async () => {
    const { sdk, mgr } = fresh();
    const c = mgr.create();
    let release!: (v: string | undefined) => void;
    const p1 = c.prompt("one", () => new Promise((r) => { release = r; }));
    assert.equal(c.busy, true, "busy before the SDK has seen anything");
    await assert.rejects(c.prompt("two", async () => undefined), /Still working/);
    release("active tab: T — https://t.example");
    await p1; await settle();
    assert.equal(sdk.last.received.length, 1);
    assert.match(sdk.last.received[0].message.content as string, /https:\/\/t\.example/);
    assert.equal(c.busy, true, "now the session itself is busy");
    assert.equal(c.record.events.filter((e) => e.kind === "user").length, 1);
  });

  test("a failing context lookup rejects and leaves the chat idle", async () => {
    const { sdk, mgr } = fresh();
    const c = mgr.create();
    await assert.rejects(c.prompt("x", async () => { throw new Error("bridge down"); }), /bridge down/);
    assert.equal(c.busy, false);
    assert.equal(sdk.last.received.length, 0);
    assert.equal(c.record.events.some((e) => e.kind === "user"), false, "nothing recorded");
  });

  test("respawns a dead session, resuming the same conversation", async () => {
    const { sdk, mgr, client } = fresh();
    const c = mgr.create();
    const a = client(); c.attach(a.emit);
    sdk.last.init("sid-1"); await settle();
    sdk.last.end(); await settle();
    assert.equal(c.session.dead, true);
    assert.equal(sdk.queries.length, 1);
    await c.prompt("again", async () => undefined); await settle();
    assert.equal(sdk.queries.length, 2, "a new session was spawned");
    assert.equal(sdk.last.options.resume, "sid-1");
    assert.equal(sdk.last.received.length, 1);
    assert.equal(a.last("cwd")?.path, c.cwd, "clients are told the session was rebuilt");
  });

  test("the first message titles the chat provisionally, then the titler names it", async () => {
    let release!: (t: string) => void;
    const { mgr, listChanges } = fresh({ titler: (t) => new Promise((r) => { release = (x) => r(`${x} ${t.split(" ")[0]}`); }) });
    const c = mgr.create();
    const before = listChanges.length;
    await c.prompt("kubernetes is failing", async () => undefined);
    assert.equal(c.record.title, "kubernetes is failing");
    assert.equal(c.record.titleProvisional, true);
    release("About");
    await settle(10);
    assert.equal(c.record.title, "About kubernetes");
    assert.equal(c.record.titleProvisional, false);
    assert.ok(listChanges.length >= before + 2, "the list was told twice");
  });

  test("a titler that keeps failing is retried each turn, then gives up after three", async () => {
    let calls = 0;
    const { mgr } = fresh({ titler: async () => { calls++; return null; } });
    const c = mgr.create();
    c.recordUser("a"); await settle(5);
    assert.equal(c.record.titleProvisional, true, "still hoping");
    c.recordUser("b"); await settle(5);
    assert.equal(c.record.titleProvisional, true);
    c.recordUser("c"); await settle(5);
    assert.equal(c.record.title, "a");
    assert.equal(c.record.titleProvisional, false, "gave up");
    assert.equal(calls, 3);
    c.recordUser("d"); await settle(5);
    assert.equal(calls, 3, "no more attempts");
  });
});

describe("LiveChat: the record", () => {
  test("ready and commands are kept once, other events accumulate, capped at 3000", async () => {
    const { sdk, mgr } = fresh();
    const c = mgr.create();
    sdk.last.init("s1"); sdk.last.init("s2");
    sdk.last.emit({ type: "system", subtype: "commands_changed", commands: [] });
    sdk.last.emit({ type: "system", subtype: "commands_changed", commands: [] });
    await settle();
    assert.equal(c.record.events.filter((e) => e.kind === "ready").length, 1);
    assert.equal(c.record.events.filter((e) => e.kind === "commands").length, 1);
    for (let i = 0; i < 3010; i++) sdk.last.text(`t${i}`);
    await settle(20);
    const ev = c.record.events;
    assert.equal(ev.length, 3000);
    assert.equal((ev.at(-1) as { text: string }).text, "t3009", "the newest survive");
    assert.equal(ev.filter((e) => e.kind === "ready").length, 0, "the oldest went, ready among them");
  });

  test("tool results are persisted and replayed with their calls", async () => {
    const { sdk, mgr, client } = fresh();
    const c = mgr.create();
    sdk.last.toolUse("t1", "Bash", { command: "ls" }); sdk.last.toolResult("t1", "x", { structured: { stdout: "x" } });
    await settle();
    assert.deepEqual(c.record.events.filter((e) => e.kind === "tool" || e.kind === "tool_result").map((e) => e.kind), ["tool", "tool_result"]);
    const a = client(); c.attach(a.emit, true);
    assert.equal((a.last("tool_result") as { summary: string }).summary, "x");
  });

  test("status, delta and thinking_delta are live-only; the finished thinking block is kept", async () => {
    const { sdk, mgr, client } = fresh();
    const c = mgr.create();
    const a = client(); c.attach(a.emit);
    sdk.last.delta("x"); sdk.last.emit({ type: "system", subtype: "status", status: "compacting" });
    sdk.last.thinkingDelta("hm"); sdk.last.thinking("hmm, done");
    await settle();
    assert.ok(a.kinds().includes("delta")); assert.ok(a.kinds().includes("status")); assert.ok(a.kinds().includes("thinking_delta"));
    assert.ok(!c.record.events.some((e) => e.kind === "delta" || e.kind === "status" || e.kind === "thinking_delta"));
    assert.ok(c.record.events.some((e) => e.kind === "thinking"));
  });

  test("/clear: the reset that follows empties the transcript, snapshots it first", async () => {
    const { sdk, mgr, client, dir } = fresh();
    const c = mgr.create();
    const a = client(); c.attach(a.emit);
    c.recordUser("keep me"); c.rename("Named");
    c.recordUser("/clear");
    sdk.last.emit({ type: "conversation_reset", new_conversation_id: "sid-new" });
    await settle();
    assert.equal(c.record.events.length, 0);
    assert.equal(c.record.title, "New chat");
    assert.equal(c.record.sdkSessionId, "sid-new");
    assert.ok(a.kinds().includes("cleared"));
    assert.match((a.last("local") as { text: string }).text, /cleared/i);
    const snaps = await readdir(join(root, "chats-snapshots")).catch(() => [] as string[]);
    assert.ok(snaps.some((f) => f.startsWith(c.id) && f.includes("before-clear")), "snapshot written");
    const snap = JSON.parse(await readFile(join(root, "chats-snapshots", snaps.find((f) => f.startsWith(c.id))!), "utf8"));
    assert.ok(snap.events.some((e: { text?: string }) => e.text === "keep me"));
    void dir;
  });

  test("a reset the user did not ask for keeps the transcript and only updates the SDK id", async () => {
    const { sdk, mgr, client } = fresh();
    const c = mgr.create();
    const a = client(); c.attach(a.emit);
    c.recordUser("keep me");
    sdk.last.emit({ type: "conversation_reset", new_conversation_id: "sid-resumed" });
    await settle();
    assert.equal(c.record.events.filter((e) => e.kind === "user").length, 1);
    assert.equal(c.record.sdkSessionId, "sid-resumed");
    assert.ok(!a.kinds().includes("cleared"));
  });

  test("rename trims, caps at 64, refuses blank", () => {
    const { mgr } = fresh();
    const c = mgr.create();
    assert.equal(c.rename("   "), false);
    assert.equal(c.rename("  " + "x".repeat(80)), true);
    assert.equal(c.record.title.length, 64);
    assert.equal(c.record.titleProvisional, false);
  });

  test("a failed save is reported to clients once per outage", async () => {
    const { mgr, client, dir } = fresh();
    const c = mgr.create();
    const a = client(); c.attach(a.emit);
    const errs = () => a.events.filter((e) => e.kind === "error").length;
    const quiet = console.error; console.error = () => {};
    try {
      await chmod(dir, 0o500);
      c.rename("one"); c.rename("two");
      assert.equal(errs(), 1, "one report for two failures");
      await chmod(dir, 0o700);
      c.rename("three");
      assert.equal(errs(), 1);
      await chmod(dir, 0o500);
      c.rename("four");
      assert.equal(errs(), 2, "a new outage is reported again");
    } finally { await chmod(dir, 0o700); console.error = quiet; }
  });
});

describe("LiveChat: cwd, project, watches", () => {
  test("setCwd rebuilds the session in place; same path is a no-op; busy refuses", async () => {
    const { sdk, mgr, client } = fresh();
    const c = mgr.create();
    const a = client(); c.attach(a.emit);
    await c.setCwd(c.cwd);
    assert.equal(sdk.queries.length, 1);
    await c.setCwd(root);
    assert.equal(sdk.queries.length, 2);
    assert.equal(sdk.last.options.cwd, root);
    assert.equal(a.last("cwd")?.path, root);
    assert.match((a.last("local") as { text: string }).text, /Working directory is now/);
    await settle();
    assert.equal(sdk.queries[0].ended, true, "the old session was closed");
    c.session.send("busy now");
    await assert.rejects(c.setCwd("/tmp"), /Finish or stop/);
  });

  test("setProject re-points cwd and restarts; the project event goes to clients", async () => {
    const { sdk, mgr, client } = fresh();
    const c = mgr.create();
    const a = client(); c.attach(a.emit);
    await c.setProject({ id: "p1", name: "P1", path: root });
    assert.equal(c.record.project, "p1"); assert.equal(c.record.cwd, root);
    assert.equal(sdk.queries.length, 2);
    assert.deepEqual(a.last("project"), { kind: "project", id: "p1", name: "P1" });
    await c.setProject({ id: "general", name: "General", path: "/tmp", general: true });
    assert.equal(c.record.project, undefined);
  });

  test("watchFired: noted while busy, woken when idle, respawned when dead", async () => {
    const { sdk, mgr, client } = fresh();
    const c = mgr.create();
    const a = client(); c.attach(a.emit);
    c.session.send("working"); await settle();
    assert.equal(c.watchFired("build", "it passed", "report it"), "noted");
    assert.equal(sdk.last.received.length, 1);
    assert.deepEqual(a.last("watch"), { kind: "watch", description: "build", detail: "it passed" });
    assert.match((c.record.events.at(-1) as { text: string }).text, /Watch fired — build/);
    sdk.last.result(); await settle();
    assert.equal(c.watchFired("build", "again", "report it"), "woken"); await settle();
    assert.equal(sdk.last.received.length, 2);
    assert.match(sdk.last.received[1].message.content as string, /watch report: again/);
    sdk.last.end(); await settle();
    assert.equal(c.watchFired("build", "third", "report it"), "woken");
    assert.equal(sdk.queries.length, 2, "respawned");
  });
});

describe("Manager: the pool", () => {
  test("evicts the least recently touched idle chat at the cap; busy or watched chats survive; over cap when all are in use", async () => {
    const { sdk, mgr, client } = fresh();
    const chats: LiveChat[] = [];
    for (let i = 0; i < 4; i++) { chats.push(mgr.create()); await new Promise((r) => setTimeout(r, 2)); }
    assert.equal(sdk.queries.length, 4);
    // chats[0] is oldest and idle → evicted by the fifth
    const fifth = mgr.create();
    assert.equal(mgr.live(chats[0].id), undefined);
    assert.equal(mgr.live(fifth.id), fifth);
    await settle();
    assert.equal(sdk.queries[0].ended, true, "its session was closed");
    // chats[1] busy, chats[2] watched: both survive, chats[3] goes
    chats[1].session.send("busy");
    const w = client(); chats[2].attach(w.emit);
    const sixth = mgr.create();
    assert.ok(mgr.live(chats[1].id)); assert.ok(mgr.live(chats[2].id)); assert.ok(mgr.live(sixth.id));
    assert.equal(mgr.live(chats[3].id), undefined);
    // everything in use → over the cap rather than cut someone off
    for (const c of [fifth, sixth]) c.session.send("busy");
    const seventh = mgr.create();
    assert.ok(mgr.live(seventh.id));
    assert.ok(mgr.live(chats[1].id) && mgr.live(chats[2].id) && mgr.live(fifth.id) && mgr.live(sixth.id));
  });

  test("remove(): closes the live session, archives the record, tells the listeners", async () => {
    const { sdk, mgr, dir, listChanges } = fresh();
    const removed: string[] = []; mgr.onChatRemoved = (id) => removed.push(id);
    const c = mgr.create();
    const before = listChanges.length;
    mgr.remove(c.id); await settle();
    assert.equal(mgr.live(c.id), undefined);
    assert.equal(sdk.last.ended, true);
    assert.deepEqual(removed, [c.id]);
    assert.equal(listChanges.length, before + 1);
    assert.equal(mgr.read(c.id), null);
    const archived = await readdir(`${dir}-archive`);
    assert.ok(archived.some((f) => f.startsWith(c.id) && f.includes("deleted")));
    mgr.remove("not-a-uuid");   // no throw
    mgr.remove(c.id);           // already gone: no throw
  });

  test("read() prefers the live record; list() is newest first; newestId follows touch", async () => {
    const { mgr } = fresh();
    const a = mgr.create(); await new Promise((r) => setTimeout(r, 2));
    const b = mgr.create();
    assert.equal(mgr.newestId(), b.id);
    a.touch();
    assert.equal(mgr.newestId(), a.id);
    a.recordUser("live only");
    assert.ok(mgr.read(a.id)!.events.some((e) => e.kind === "user"), "unsaved (debounced) events are visible through read()");
    assert.deepEqual(mgr.list().map((c) => c.id), [a.id, b.id]);
  });

  test("shutdown() flushes and closes every session", async () => {
    const { sdk, mgr, dir } = fresh();
    const a = mgr.create(); const b = mgr.create();
    a.recordUser("unsaved");
    mgr.shutdown(); await settle();
    assert.ok(sdk.queries.every((q) => q.ended));
    assert.equal(mgr.live(a.id), undefined); assert.equal(mgr.live(b.id), undefined);
    const rec = JSON.parse(await readFile(join(dir, `${a.id}.json`), "utf8"));
    assert.ok(rec.events.some((e: { kind: string }) => e.kind === "user"), "the debounced save was flushed");
  });

  test("create(): reuses a cold empty chat; 'new' on an unused chat is that chat", async () => {
    const { sdk, mgr } = fresh();
    const a = mgr.create();
    assert.equal(mgr.create(a), a, "nothing said yet: same chat");
    assert.equal(sdk.queries.length, 1);
    mgr.shutdown();                       // a is now cold and empty on disk
    const b = mgr.create();
    assert.equal(b.id, a.id, "the spare was reused");
    assert.equal(sdk.queries.length, 2);
    assert.equal(sdk.last.options.resume, undefined, "reused as a fresh conversation");
  });

  test("projects() is memoised for a few seconds", () => {
    const { mgr } = fresh();
    const p1 = mgr.projects(); const p2 = mgr.projects();
    assert.ok(p1.length >= 1 && p1[0].general);
    assert.deepEqual(p1.map((p) => p.id), p2.map((p) => p.id));
  });
});
