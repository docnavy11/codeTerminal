import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manager } from "../src/conversation.js";
import { Store, type ChatRecord } from "../src/store.js";
import { pruneRuns } from "../src/schedule-run.js";
import type { Schedule, Run } from "../src/schedule.js";
import { fakeSdk, settle, waitFor } from "./fakes/sdk.js";

/* Old run chats are pruned from the record on disk. Reading them through
   get() admitted each one into the pool — a Claude session per old run, and
   an idle chat of someone's evicted to make room — and a run chat a person
   had open or was mid-turn in was deleted under them. */
let root: string;
let n = 0;
const managers: Manager[] = [];
before(async () => { root = await mkdtemp(join(tmpdir(), "ct-prune-")); });
after(async () => {
  for (const m of managers) { try { m.shutdown(); } catch { /* already closed */ } }
  await new Promise((r) => setTimeout(r, 50));   // chats save on a debounce
  await rm(root, { recursive: true, force: true });
});

function world() {
  const sdk = fakeSdk();
  const dir = join(root, `chats-${++n}`);
  mkdirSync(dir, { recursive: true });
  const convo = new Manager(join(root, "ws"), dir, join(root, "projects"),
    { bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery, titler: async () => null });
  managers.push(convo);
  return { sdk, convo, store: new Store(dir) };
}
const run = (chatId: string): Run => ({ id: `r-${chatId}`, chatId, startedAt: 1, endedAt: 2, outcome: "done", costUsd: null, summary: "", files: [], needed: [], cards: [], trigger: "schedule" });
const schedule = (keepRuns: number, chatIds: string[]): Schedule => ({
  id: "s1", title: "Jobs", prompt: "p", when: { text: "daily", cron: "0 8 * * *", tz: "UTC" }, project: "general", browser: "auto", mode: "auto",
  waitMs: 1000, maxMs: 60_000, keepRuns, paused: false, createdAt: 1, updatedAt: 1, nextAt: null, runs: chatIds.map(run),
});

describe("pruneRuns", () => {
  test("cold run chats are read from disk, not admitted: no session is started, a renamed one is kept", () => {
    const w = world();
    const ids = [1, 2, 3, 4].map((i) => `bbbbbbbb-0000-0000-0000-00000000000${i}`);
    ids.forEach((id, i) => {
      const rec: ChatRecord = { id, title: i === 2 ? "Keep this one" : `Jobs · 2026-09-1${i} 08:00`, createdAt: i, updatedAt: i, sdkSessionId: null, cwd: null, events: [], granted: [], mode: "default", scheduleId: "s1" };
      w.store.write(rec);
    });
    const removed = pruneRuns({ convo: w.convo }, schedule(1, ids));
    assert.deepEqual(removed, [ids[1], ids[3]], "beyond keepRuns, and not renamed");
    assert.equal(w.sdk.queries.length, 0, "no Claude session was started to read a title");
    for (const id of ids) assert.equal(w.convo.live(id), undefined, "nothing was admitted into the pool");
    assert.deepEqual(ids.map((id) => !!w.convo.read(id)), [true, false, true, false], "on disk: the newest and the renamed one");
  });

  test("a run chat someone has open, or is mid-turn in, is left alone; an idle live one goes", async () => {
    const w = world();
    const open = w.convo.create(); open.rename("Jobs · 2026-09-10 08:00");
    open.attach(() => {}, false);
    const turning = w.convo.create(); turning.rename("Jobs · 2026-09-11 08:00");
    void turning.prompt("still going", async () => undefined).catch(() => {});
    await waitFor(() => turning.busy, "the turn to start");
    await settle();
    const idle = w.convo.create(); idle.rename("Jobs · 2026-09-12 08:00");
    const removed = pruneRuns({ convo: w.convo }, schedule(0, [open.id, turning.id, idle.id]));
    assert.deepEqual(removed, [idle.id]);
    assert.ok(w.convo.read(open.id), "the chat someone is looking at is still there");
    assert.ok(w.convo.read(turning.id), "the chat mid-turn is still there");
  });
});
