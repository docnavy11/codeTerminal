import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoStore, projectRootOf, prune, tmuxState, buildBoard, queueBlock, PROBABLY_IDLE_MS, PRUNE_AFTER_MS, KEEP_FINISHED, type TodoItem } from "../src/todos.js";

async function scratch(): Promise<{ root: string; projects: string; done: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ct-todos-"));
  const projects = join(root, "projects");
  for (const d of ["repo/.git", "repo/sub/deeper", "plain/sub", "nested/inner/.git", "nested/inner/x"]) await mkdir(join(projects, d), { recursive: true });
  return { root, projects, done: () => rm(root, { recursive: true, force: true }) };
}

describe("projectRootOf", () => {
  test("the nearest git root, bounded by the projects root", async () => {
    const s = await scratch();
    try {
      assert.equal(projectRootOf(join(s.projects, "repo/sub/deeper"), s.projects), join(s.projects, "repo"));
      assert.equal(projectRootOf(join(s.projects, "repo"), s.projects), join(s.projects, "repo"));
      // A nested repo inside a project directory is its own root: the journal collector looks one level down too.
      assert.equal(projectRootOf(join(s.projects, "nested/inner/x"), s.projects), join(s.projects, "nested/inner"));
      // No repo: the first level under the projects root.
      assert.equal(projectRootOf(join(s.projects, "plain/sub"), s.projects), join(s.projects, "plain"));
      // Outside the projects root, no repo: the cwd itself. Never the projects root or above.
      assert.equal(projectRootOf(s.root, s.projects), s.root);
      assert.equal(projectRootOf(s.projects, s.projects), s.projects);
    } finally { await s.done(); }
  });
});

describe("TodoStore", () => {
  test("add, claim once, done, drop, release, edit — written atomically to todo.json", async () => {
    const s = await scratch();
    try {
      let now = 1_000_000;
      const st = new TodoStore({ now: () => now });
      const root = join(s.projects, "repo");
      const changes: string[] = [];
      st.onChange = (r, i, what) => changes.push(`${what}:${i.text}`);
      assert.equal(st.has(root), false);
      const a = st.add(root, { text: "  write tests  " });
      assert.equal(a.text, "write tests"); assert.equal(a.for, "claude"); assert.equal(a.status, "queued"); assert.equal(a.addedBy, "owner");
      assert.equal(st.has(root), true);
      assert.ok(!existsSync(join(root, "todo.json.tmp")), "the tmp file is renamed away");
      const b = st.add(root, { text: "board view", addedBy: "chat:abc" });
      const q = st.add(root, { text: "which token for prod?", for: "owner", addedBy: "chat:abc" });
      // Owner items sit on top; work for the sessions queues at the end.
      assert.deepEqual(st.read(root).map((i) => i.text), ["which token for prod?", "write tests", "board view"]);

      now += 1000;
      const c = st.claim(root, a.id, "chat:abc");
      assert.equal(c.status, "claimed"); assert.equal(c.claimedBy, "chat:abc"); assert.equal(c.claimedAt, now);
      assert.throws(() => st.claim(root, a.id, "chat:xyz"), /already claimed by chat:abc/);
      assert.throws(() => st.claim(root, q.id, "chat:abc"), /for the owner/);
      // A short id prefix works, as the tools print them.
      const d = st.done(root, a.id.slice(0, 8), "42 tests, all green");
      assert.equal(d.status, "done"); assert.equal(d.result, "42 tests, all green"); assert.equal(d.doneAt, now);
      assert.throws(() => st.done(root, a.id), /already done/);
      // The owner answers a question: done with the answer as result.
      assert.equal(st.done(root, q.id, "reuse the dev one").result, "reuse the dev one");
      // Release a claim back to the queue.
      st.claim(root, b.id, "chat:xyz");
      const rel = st.release(root, b.id);
      assert.equal(rel.status, "queued"); assert.equal(rel.claimedBy, undefined);
      assert.throws(() => st.release(root, b.id), /not claimed/);
      assert.equal(st.edit(root, b.id, "board view, phone first").text, "board view, phone first");
      assert.equal(st.drop(root, b.id).status, "dropped");
      assert.throws(() => st.add(root, { text: "   " }), /needs text/);
      assert.throws(() => st.done(root, "nope-nope", "x"), /no todo/);
      assert.throws(() => st.add(join(s.projects, "missing"), { text: "x" }), /not a directory/);

      const onDisk = JSON.parse(await readFile(join(root, "todo.json"), "utf8"));
      assert.equal(onDisk.items.length, 3);
      assert.deepEqual(changes.slice(0, 3), ["added:write tests", "added:board view", "added:which token for prod?"]);
      assert.ok(changes.includes("changed:board view, phone first"));
    } finally { await s.done(); }
  });

  test("re-reads before writing: an edit from outside is kept, not clobbered", async () => {
    const s = await scratch();
    try {
      const st = new TodoStore();
      const root = join(s.projects, "repo");
      const a = st.add(root, { text: "one" });
      // Someone (a checkout, say) replaces the file underneath.
      const outside: TodoItem = { id: "11111111-aaaa-bbbb-cccc-000000000000", text: "from outside", for: "claude", status: "queued", addedAt: 5, addedBy: "owner" };
      await writeFile(join(root, "todo.json"), JSON.stringify({ items: [outside, a] }));
      st.add(root, { text: "two" });
      assert.deepEqual(st.read(root).map((i) => i.text), ["from outside", "one", "two"]);
    } finally { await s.done(); }
  });

  test("a file that does not parse is moved aside and treated as empty", async () => {
    const s = await scratch();
    try {
      const warns: string[] = [];
      const st = new TodoStore({ warn: (l) => warns.push(l) });
      const root = join(s.projects, "repo");
      await writeFile(join(root, "todo.json"), "{ not json");
      assert.deepEqual(st.read(root), []);
      assert.match(warns[0], /does not parse/);
      assert.ok(!existsSync(join(root, "todo.json")), "quarantined");
    } finally { await s.done(); }
  });

  test("reorder moves the open claude items; owner and finished items keep their places", async () => {
    const s = await scratch();
    try {
      const st = new TodoStore();
      const root = join(s.projects, "repo");
      const a = st.add(root, { text: "a" }), b = st.add(root, { text: "b" }), c = st.add(root, { text: "c" });
      st.add(root, { text: "q?", for: "owner" });
      const out = st.reorder(root, [c.id, a.id, b.id]);
      assert.deepEqual(out.map((i) => i.text), ["q?", "c", "a", "b"]);
      assert.deepEqual(st.read(root).map((i) => i.text), ["q?", "c", "a", "b"]);
    } finally { await s.done(); }
  });
});

describe("record", () => {
  test("finished work lands straight in done, signed by the session; owner asks are listed per project", async () => {
    const s = await scratch();
    try {
      const now = 7_000_000;
      const st = new TodoStore({ now: () => now });
      const repo = join(s.projects, "repo");
      const r = st.record(repo, { text: "fix the flaky upgrade test", result: "it was a race on the port", by: "chat:c9" });
      assert.equal(r.status, "done"); assert.equal(r.claimedBy, "chat:c9"); assert.equal(r.addedBy, "chat:c9"); assert.equal(r.doneAt, now);
      st.add(repo, { text: "which token?", for: "owner", addedBy: "chat:c9" });
      const board = buildBoard({ now, projectsRoot: s.projects, projects: [{ id: "repo", name: "repo", path: repo }], chats: [], tmux: [], todos: st });
      assert.equal(board.projects.length, 1);
      assert.deepEqual(board.projects[0].asks.map((i) => i.text), ["which token?"]);
      assert.deepEqual(board.projects[0].queue.map((i) => `${i.text}:${i.status}`), ["fix the flaky upgrade test:done"]);
    } finally { await s.done(); }
  });
});

describe("prune", () => {
  const mk = (n: number, status: TodoItem["status"], doneAt: number): TodoItem => ({ id: `id${n}`, text: `t${n}`, for: "claude", status, addedAt: 0, addedBy: "owner", doneAt });
  test("finished items leave after two weeks; open ones never", () => {
    const now = PRUNE_AFTER_MS * 2;
    const items = [mk(1, "done", now - PRUNE_AFTER_MS - 1), mk(2, "dropped", now - 1000), mk(3, "queued", 0), mk(4, "claimed", 0)];
    assert.deepEqual(prune(items, now).map((i) => i.id), ["id2", "id3", "id4"]);
  });
  test("past KEEP_FINISHED the oldest finished go first", () => {
    const items = Array.from({ length: KEEP_FINISHED + 5 }, (_, k) => mk(k, "done", 1000 + k));
    const kept = prune(items, 10_000);
    assert.equal(kept.length, KEEP_FINISHED);
    assert.equal(kept[0].id, "id5", "the five oldest are gone");
  });
});

describe("tmuxState", () => {
  test("claude with recent output works; quiet claude is probably idle; anything else has no claude", () => {
    const now = 1_000_000;
    assert.equal(tmuxState({ command: "claude", activityAt: now - 5000 }, now), "working");
    assert.equal(tmuxState({ command: "claude", activityAt: now - PROBABLY_IDLE_MS - 1 }, now), "probably idle");
    assert.equal(tmuxState({ command: "bash", activityAt: now }, now), "no claude");
    assert.equal(tmuxState({ command: "node", activityAt: now }, now), "no claude");
  });
});

describe("buildBoard", () => {
  test("groups sessions and queues by project root; only projects with something going on; idle first", async () => {
    const s = await scratch();
    try {
      const now = 10_000_000;
      const st = new TodoStore({ now: () => now });
      const repo = join(s.projects, "repo"), plain = join(s.projects, "plain"), nested = join(s.projects, "nested");
      const q1 = st.add(repo, { text: "first" });
      st.add(repo, { text: "second" });
      st.claim(repo, q1.id, "chat:c1");
      st.add(repo, { text: "which token?", for: "owner", addedBy: "chat:c1" });
      st.add(nested, { text: "old and done" }); st.done(nested, st.read(nested)[0].id, "ok");
      const board = buildBoard({
        now, projectsRoot: s.projects,
        projects: [{ id: "general", name: "General", path: s.root, general: true }, { id: "repo", name: "repo", path: repo }, { id: "plain", name: "plain", path: plain }, { id: "nested", name: "nested", path: nested }],
        chats: [
          { id: "c1", title: "busy one", cwd: join(repo, "sub"), project: "repo", busy: true, waiting: false, lastTouched: now - 120_000, steps: [{ content: "wire it", status: "in_progress" }] },
          { id: "c2", title: "idle one", cwd: repo, project: "repo", busy: false, waiting: false, lastTouched: now - 840_000, steps: null },
          { id: "c3", title: "waiting", cwd: join(plain, "sub"), project: "plain", busy: true, waiting: true, lastTouched: now, steps: null },
          // No project: a General chat, even though its cwd is the repo (every General chat sits in the server's default directory).
          { id: "c4", title: "pension question", cwd: repo, project: null, busy: false, waiting: false, lastTouched: now, steps: null },
        ],
        tmux: [
          { name: "wt_1", path: repo, command: "claude", activityAt: now - 2 * PROBABLY_IDLE_MS, attached: 1 },
          { name: "wt_2", path: "", command: "claude", activityAt: now, attached: 0 },
        ],
        todos: st,
      });
      assert.deepEqual(board.projects.map((p) => p.name), ["General", "repo", "plain"], "nested has only a finished item, and no session; the General chat has a card of its own");
      assert.deepEqual(board.projects[0].sessions.map((r) => (r.kind === "chat" ? r.id : "")), ["c4"]);
      assert.equal(board.projects[0].root, s.root);
      const repoCard = board.projects.find((p) => p.id === "repo")!;
      assert.equal(repoCard.id, "repo");
      assert.deepEqual(repoCard.sessions.map((r) => (r.kind === "chat" ? `${r.id}:${r.state}` : `${r.name}:${r.state}`)), ["c2:idle", "wt_1:probably idle", "c1:busy"]);
      assert.deepEqual((repoCard.sessions[2] as { steps: unknown }).steps, [{ content: "wire it", status: "in_progress" }]);
      assert.deepEqual(repoCard.queue.map((i) => `${i.text}:${i.status}`), ["second:queued", "first:claimed"]);
      assert.deepEqual(repoCard.counts, { queued: 1, claimed: 1, forYou: 1 });
      assert.equal(board.forYou.length, 1);
      assert.equal(board.forYou[0].project, "repo"); assert.equal(board.forYou[0].text, "which token?");
      const plainCard = board.projects.find((p) => p.id === "plain")!;
      assert.equal(plainCard.sessions.length, 1); assert.equal((plainCard.sessions[0] as { state: string }).state, "waiting");
      assert.deepEqual(plainCard.queue, []);
    } finally { await s.done(); }
  });
});

describe("queueBlock", () => {
  test("nothing to say costs nothing; otherwise what you hold, what is queued, what was answered", () => {
    const now = 5_000_000;
    const items: TodoItem[] = [
      { id: "aaaaaaaa-1", text: "held", for: "claude", status: "claimed", claimedBy: "chat:me", addedAt: 1, addedBy: "owner" },
      { id: "bbbbbbbb-1", text: "next up", for: "claude", status: "queued", addedAt: 2, addedBy: "owner" },
      { id: "cccccccc-1", text: "theirs", for: "claude", status: "claimed", claimedBy: "chat:other", addedAt: 3, addedBy: "owner" },
      { id: "dddddddd-1", text: "token?", for: "owner", status: "done", result: "reuse dev", doneAt: now - 1000, addedAt: 4, addedBy: "chat:me" },
      { id: "eeeeeeee-1", text: "old q", for: "owner", status: "done", result: "x", doneAt: now - 2 * 24 * 3600_000, addedAt: 5, addedBy: "chat:me" },
      { id: "ffffffff-1", text: "not mine", for: "owner", status: "done", result: "y", doneAt: now, addedAt: 6, addedBy: "chat:other" },
    ];
    assert.equal(queueBlock([], "me", now), null);
    assert.equal(queueBlock([items[2]], "me", now), null, "another chat's claim is not this chat's business");
    const block = queueBlock(items, "me", now)!;
    assert.match(block, /You hold:\n- \[aaaaaaaa\] held/);
    assert.match(block, /Queued for this project[^\n]*\n- \[bbbbbbbb\] next up/);
    assert.match(block, /Q: token\?\n  A: reuse dev/);
    assert.doesNotMatch(block, /old q|not mine|theirs/);
  });
});
