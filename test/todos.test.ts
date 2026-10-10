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

/* ---------------- the second round: blockers, notes, reopen, release, archive, stale, settings ---------------- */
import { blockersOf, STALE_IDLE_MS, ARCHIVE_FILE } from "../src/todos.js";
import { BoardSettings } from "../src/board-settings.js";
import { Insights } from "../src/insight.js";

describe("blocked-by", () => {
  test("a blocked item cannot be claimed until its blocker is done or dropped; cycles and self-waits are refused", async () => {
    const s = await scratch();
    try {
      const st = new TodoStore(); const root = join(s.projects, "repo");
      const a = st.add(root, { text: "design the schema" });
      const b = st.add(root, { text: "write the migration", blockedBy: [a.id, "no-such-id"] });
      assert.deepEqual(st.read(root).find((i) => i.id === b.id)!.blockedBy, [a.id], "an unknown blocker is ignored");
      assert.throws(() => st.claim(root, b.id, "chat:x"), /blocked: waiting on "design the schema"/);
      assert.throws(() => st.annotate(root, a.id, { blockedBy: [a.id] }), /cannot wait on itself/);
      assert.throws(() => st.annotate(root, a.id, { blockedBy: [b.id] }), /wait on each other/);
      st.claim(root, a.id, "chat:y"); st.done(root, a.id, "schema agreed");
      assert.equal(st.claim(root, b.id, "chat:x").status, "claimed", "unblocked once the blocker is done");
      // A dropped blocker unblocks too; removing one clears the reference.
      const c = st.add(root, { text: "ship it" }), d = st.add(root, { text: "announce", blockedBy: [c.id] });
      st.drop(root, c.id); assert.equal(blockersOf(st.read(root), st.read(root).find((i) => i.id === d.id)!).length, 0);
      const e = st.add(root, { text: "e" }), f = st.add(root, { text: "f", blockedBy: [e.id] });
      st.remove(root, e.id); assert.equal(st.read(root).find((i) => i.id === f.id)!.blockedBy, undefined);
    } finally { await s.done(); }
  });
});

describe("notes, images, reopen, release by holder", () => {
  test("annotate sets and clears notes and images; reopen puts a finished item back; releaseBy frees everything a holder had", async () => {
    const s = await scratch();
    try {
      const st = new TodoStore(); const root = join(s.projects, "repo");
      const a = st.add(root, { text: "restyle the header", notes: "  keep the logo  ", images: ["/tmp/a.png"] });
      assert.equal(a.notes, "keep the logo"); assert.deepEqual(a.images, ["/tmp/a.png"]);
      const b = st.annotate(root, a.id, { notes: "", images: ["/tmp/b.png", "/tmp/c.png"] });
      assert.equal(b.notes, undefined); assert.deepEqual(b.images, ["/tmp/b.png", "/tmp/c.png"]);
      st.claim(root, a.id, "tmux:s1"); const two = st.add(root, { text: "second" }); st.claim(root, two.id, "tmux:s1"); const other = st.add(root, { text: "other" }); st.claim(root, other.id, "tmux:s2");
      assert.equal(st.releaseBy(root, "tmux:s1").length, 2);
      assert.deepEqual(st.read(root).map((i) => `${i.text}:${i.status}`), ["restyle the header:queued", "second:queued", "other:claimed"]);
      st.done(root, a.id, "restyled");
      const re = st.reopen(root, a.id);
      assert.equal(re.status, "queued"); assert.equal(re.result, undefined); assert.equal(re.claimedBy, undefined);
      assert.throws(() => st.reopen(root, a.id), /not finished/);
    } finally { await s.done(); }
  });
});

describe("the archive and the history", () => {
  test("pruned items are archived, not lost; history searches the file and the archive, newest first", async () => {
    const s = await scratch();
    try {
      let now = 1_000_000; const st = new TodoStore({ now: () => now }); const root = join(s.projects, "repo");
      const old = st.add(root, { text: "fix the footer" }); st.claim(root, old.id, "chat:a"); st.done(root, old.id, "sticky below 700px");
      now += PRUNE_AFTER_MS + 10_000;
      const fresh = st.add(root, { text: "dark theme" }); st.claim(root, fresh.id, "chat:b"); st.done(root, fresh.id, "tokens and a toggle");
      assert.ok(!st.read(root).some((i) => i.id === old.id), "pruned from the live file");
      assert.ok(existsSync(join(root, ARCHIVE_FILE)));
      assert.deepEqual(st.history(root).map((i) => i.text), ["dark theme", "fix the footer"]);
      assert.deepEqual(st.history(root, "FOOTER").map((i) => i.text), ["fix the footer"]);
      assert.deepEqual(st.history(root, "sticky").map((i) => i.id), [old.id], "the result is searched too");
      assert.deepEqual(st.history(root, "nothing like this"), []);
    } finally { await s.done(); }
  });
});

describe("the board marks stale claims and what a blocked item waits on", () => {
  test("gone holder, idle holder past the limit, active holder; waitingOn names the blocker", async () => {
    const s = await scratch();
    try {
      const now = 50_000_000; const st = new TodoStore({ now: () => now }); const repo = join(s.projects, "repo");
      const a = st.add(repo, { text: "held by a ghost" }), b = st.add(repo, { text: "held by an idle one" }), c = st.add(repo, { text: "held by a busy one" });
      st.claim(repo, a.id, "tmux:ghost"); st.claim(repo, b.id, "chat:idle1"); st.claim(repo, c.id, "chat:busy1");
      const w = st.add(repo, { text: "waits", blockedBy: [a.id] });
      const board = buildBoard({ now, projectsRoot: s.projects, projects: [{ id: "repo", name: "repo", path: repo }], tmux: [], todos: st,
        chats: [{ id: "idle1", title: "idle", cwd: repo, project: "repo", busy: false, waiting: false, lastTouched: now - STALE_IDLE_MS - 1, steps: null },
                { id: "busy1", title: "busy", cwd: repo, project: "repo", busy: true, waiting: false, lastTouched: now - STALE_IDLE_MS - 1, steps: null }] });
      const q = board.projects[0].queue; const by = (id: string) => q.find((i) => i.id === id)!;
      assert.equal(by(a.id).stale, "gone"); assert.equal(by(b.id).stale, "idle"); assert.equal(by(c.id).stale, undefined);
      assert.deepEqual(by(w.id).waitingOn, [{ id: a.id, text: "held by a ghost" }]);
    } finally { await s.done(); }
  });
});

describe("queueBlock with notes, images and blockers", () => {
  test("notes and images follow the item; a blocked item is listed apart and not offered", () => {
    const it = (id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem => ({ id, text, for: "claude", status: "queued", addedAt: 1, addedBy: "owner", ...extra });
    const items = [it("aaaaaaaa-1", "restyle header", { notes: "keep the logo\nand the nav", images: ["/w/.todo-attachments/x.png"] }),
                   it("bbbbbbbb-1", "ship it", { blockedBy: ["aaaaaaaa-1"] })];
    const block = queueBlock(items, "me", 5)!;
    assert.match(block, /Queued for this project[^\n]*\n- \[aaaaaaaa\] restyle header\n  notes: keep the logo and the nav\n  images \(Read them\): \/w\/\.todo-attachments\/x\.png/);
    assert.match(block, /Waiting on other items[^\n]*\n- \[bbbbbbbb\] ship it — after: \[aaaaaaaa\]/);
    assert.doesNotMatch(block.split("Waiting on")[0], /ship it/);
  });
});

describe("BoardSettings and the keeper's pause and counter", () => {
  test("settings persist; suppression is per session and title", async () => {
    const s = await scratch();
    try {
      const f = join(s.root, ".board.json");
      const a = new BoardSettings(f); a.setPaused(true); a.setAuto("/p/x", true); a.suppress("chat:1", "Not a task");
      const b = new BoardSettings(f);
      assert.equal(b.keeperPaused, true); assert.equal(b.auto("/p/x"), true); assert.equal(b.auto("/p/y"), false);
      assert.equal(b.isSuppressed("chat:1", "Not a task"), true); assert.equal(b.isSuppressed("chat:2", "Not a task"), false);
      b.setAuto("/p/x", false); assert.equal(new BoardSettings(f).auto("/p/x"), false);
      await writeFile(f, "{ torn"); assert.equal(new BoardSettings(f).keeperPaused, false, "a bad file is the defaults");
    } finally { await s.done(); }
  });

  test("paused: no new model call, the cached value still shows; calls are counted per day and survive a restart; tail and peek", async () => {
    const s = await scratch();
    try {
      let now = Date.parse("2026-10-10T10:00:00Z"); let calls = 0;
      const f = join(s.root, "ins.json");
      const ins = new Insights(async (t) => { calls++; return { summary: `s${calls}`, title: "t", status: "working" }; }, () => now, f);
      ins.get("k", "first text"); await new Promise((r) => setImmediate(r));
      assert.equal(ins.peek("k")?.summary, "s1"); assert.equal(ins.tail("k"), "first text");
      assert.deepEqual(ins.stats(), { date: "2026-10-10", calls: 1 });
      ins.paused = true; now += 200_000;
      assert.equal(ins.get("k", "changed text", true)?.summary, "s1", "paused: the old value, no call"); assert.equal(calls, 1);
      ins.paused = false;
      ins.get("k", "changed text", true); await new Promise((r) => setImmediate(r)); assert.equal(calls, 2);
      assert.equal(ins.stats().calls, 2);
      now += 24 * 3600_000; assert.deepEqual(ins.stats(), { date: "2026-10-11", calls: 0 }, "a new day starts at zero");
      await new Promise((r) => setTimeout(r, 650));
      const again = new Insights(async () => null, () => Date.parse("2026-10-10T12:00:00Z"), f);
      assert.equal(again.stats().calls, 2, "the count is persisted");
    } finally { await s.done(); }
  });
});
