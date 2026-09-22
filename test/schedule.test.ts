import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWhen, describe as words, nextRun, ScheduleStore, Scheduler, type Schedule, type Run, type RunResult } from "../src/schedule.js";

const BX = "Europe/Brussels";
const iso = (d: Date | null) => d?.toISOString().slice(0, 16) ?? null;

describe("when: words to cron and back", () => {
  test("the phrases the form suggests", () => {
    assert.deepEqual(parseWhen("every day at 08:00"), { cron: "0 8 * * *", words: "every day at 08:00" });
    assert.equal(parseWhen("daily at 7").cron, "0 7 * * *");
    assert.deepEqual(parseWhen("weekdays at 07:30"), { cron: "30 7 * * 1-5", words: "weekdays at 07:30" });
    assert.equal(parseWhen("every monday at 9").cron, "0 9 * * 1"); assert.equal(words("0 9 * * 1"), "every Monday at 09:00");
    assert.deepEqual(parseWhen("every 6 hours"), { cron: "0 */6 * * *", words: "every 6 hours" });
    assert.deepEqual(parseWhen("every 30 minutes"), { cron: "*/30 * * * *", words: "every 30 minutes" });
    assert.equal(parseWhen("hourly").cron, "0 * * * *");
    assert.equal(parseWhen("weekends at 10").cron, "0 10 * * 0,6"); assert.equal(words("0 10 * * 0,6"), "weekends at 10:00");
    assert.equal(parseWhen("monthly on the 1st at 06:00").cron, "0 6 1 * *"); assert.equal(words("0 6 1 * *"), "monthly on the 1 at 06:00");
    assert.equal(parseWhen("at 5 pm").cron, "0 17 * * *");
  });
  test("a cron line passes through; garbage is refused with the suggestions", () => {
    assert.equal(parseWhen("15 6 * * 1-5").cron, "15 6 * * 1-5");
    assert.throws(() => parseWhen("whenever"), /try "every day at 08:00"/);
    assert.throws(() => parseWhen("every day at 25:00"), /not a valid time/);
    assert.throws(() => parseWhen("61 * * * *"), /outside 0-59/);
    assert.throws(() => parseWhen("every 0 hours"), /between 1 and 23/);
  });
});

describe("nextRun in a time zone", () => {
  test("daily at 08:00 Brussels, across the DST switch", () => {
    // 2026-03-29 02:00 CET → 03:00 CEST. 08:00 local is 07:00Z before, 06:00Z after.
    assert.equal(iso(nextRun("0 8 * * *", BX, new Date("2026-03-28T07:30:00Z"))), "2026-03-29T06:00");
    assert.equal(iso(nextRun("0 8 * * *", BX, new Date("2026-03-27T07:30:00Z"))), "2026-03-28T07:00");
    // autumn: 2026-10-25 03:00 CEST → 02:00 CET
    assert.equal(iso(nextRun("0 8 * * *", BX, new Date("2026-10-24T06:30:00Z"))), "2026-10-25T07:00");
  });
  test("weekdays, a weekday name, every N hours, the exact minute is excluded", () => {
    assert.equal(iso(nextRun("30 7 * * 1-5", BX, new Date("2026-09-11T04:00:00Z"))), "2026-09-11T05:30");   // Friday 06:00 CEST → 07:30 CEST = 05:30Z
    assert.equal(iso(nextRun("30 7 * * 1-5", BX, new Date("2026-09-11T06:00:00Z"))), "2026-09-14T05:30");   // Friday 08:00 CEST, past it → Monday
    assert.equal(iso(nextRun("0 9 * * 1", "UTC", new Date("2026-09-13T12:00:00Z"))), "2026-09-14T09:00");
    assert.equal(iso(nextRun("0 */6 * * *", "UTC", new Date("2026-09-13T12:00:00Z"))), "2026-09-13T18:00");
    assert.equal(iso(nextRun("0 12 * * *", "UTC", new Date("2026-09-13T12:00:00Z"))), "2026-09-14T12:00", "after == the time itself: the next day");
    assert.equal(iso(nextRun("0 6 1 * *", "UTC", new Date("2026-09-13T12:00:00Z"))), "2026-10-01T06:00");
    assert.throws(() => nextRun("0 8 * * *", "Mars/Olympus", new Date()), /unknown time zone/);
  });
});

describe("the store", () => {
  test("add validates and fills defaults; update keeps runs and resets nextAt when the time changes; roundtrips through disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-sched-"));
    try {
      const path = join(dir, "schedules.json");
      const st = new ScheduleStore(path);
      const s = st.add({ title: "Jobs", prompt: "search", when: { text: "every day at 08:00", tz: BX }, project: "jobsearch" });
      assert.equal(s.when.cron, "0 8 * * *"); assert.equal(s.browser, "server"); assert.equal(s.mode, "auto"); assert.equal(s.waitMs, 600_000, "long enough to notice a notification and answer from a phone"); assert.equal(s.keepRuns, 10); assert.equal(s.paused, false);
      assert.throws(() => st.add({ title: "", prompt: "x", when: { text: "daily", tz: "UTC" } }), /needs a title/);
      assert.throws(() => st.add({ title: "x", prompt: "x", when: { text: "daily", tz: "Nowhere/Here" } }), /unknown time zone/);
      assert.throws(() => st.add({ title: "x", prompt: "x", when: { text: "daily", tz: "UTC" }, budgetUsd: 5000 }), /budget: between/);
      st.patch(s.id, (x) => { x.nextAt = 123; x.runs.push({ id: "r", chatId: null, startedAt: 1, endedAt: 2, outcome: "done", costUsd: 0.1, summary: "ok", files: [], needed: [], cards: [], trigger: "now" }); });
      const u = st.update(s.id, { title: "Jobs (daily)" })!;
      assert.equal(u.title, "Jobs (daily)"); assert.equal(u.nextAt, 123, "nextAt kept when the time did not change"); assert.equal(u.runs.length, 1);
      const u2 = st.update(s.id, { when: { text: "weekdays at 7", tz: BX } })!;
      assert.equal(u2.when.cron, "0 7 * * 1-5"); assert.equal(u2.nextAt, null, "a new time means a new next run");
      assert.deepEqual(new ScheduleStore(path).get(s.id)?.when, u2.when);
      assert.equal(st.remove(s.id), true); assert.equal(st.remove(s.id), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("the scheduler", () => {
  const world = async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-schedr-"));
    const store = new ScheduleStore(join(dir, "s.json"));
    let now = Date.parse("2026-09-13T07:59:30Z");
    const runs: { title: string; trigger: string }[] = []; let block: (() => void) | null = null;
    const runner = async (s: Schedule, r: Run): Promise<RunResult> => {
      runs.push({ title: s.title, trigger: r.trigger });
      if (block) await new Promise<void>((res) => { block = res; });
      return { chatId: "c1", endedAt: now, outcome: "done", costUsd: 0.2, summary: "12 new listings", files: ["out/jobs.md"], needed: [], cards: [] };
    };
    const done: string[] = [];
    const sch = new Scheduler({ store, runner, now: () => now });
    sch.onDone = (s, r) => done.push(`${s.title}:${r.outcome}`);
    return { dir, store, sch, runs, done, set: (t: string) => { now = Date.parse(t); }, hold: () => { block = () => {}; }, release: () => { const b = block; block = null; b?.(); } };
  };
  test("runs when due, once, then plans the next; a paused schedule never runs; run now runs at once", async () => {
    const w = await world();
    try {
      const s = w.store.add({ title: "Jobs", prompt: "p", when: { text: "every day at 08:00", tz: "UTC" } });
      w.sch.start(1e9); w.sch.stop();
      assert.equal(w.store.get(s.id)!.nextAt, Date.parse("2026-09-13T08:00:00Z"));
      await w.sch.tick(); assert.equal(w.runs.length, 0, "not yet");
      w.set("2026-09-13T08:00:10Z"); await w.sch.tick(); await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(w.runs, [{ title: "Jobs", trigger: "schedule" }]);
      assert.equal(w.store.get(s.id)!.nextAt, Date.parse("2026-09-14T08:00:00Z"), "planned for tomorrow");
      await w.sch.tick(); assert.equal(w.runs.length, 1, "not twice in the same minute");
      assert.deepEqual(w.done, ["Jobs:done"]);
      const rec = w.store.get(s.id)!.runs[0]; assert.equal(rec.outcome, "done"); assert.equal(rec.summary, "12 new listings"); assert.deepEqual(rec.files, ["out/jobs.md"]); assert.equal(rec.costUsd, 0.2);
      w.store.update(s.id, { paused: true }); w.sch.replan(s.id);
      assert.equal(w.store.get(s.id)!.nextAt, null);
      w.set("2026-09-14T08:00:10Z"); await w.sch.tick(); assert.equal(w.runs.length, 1, "paused: nothing");
      w.sch.runNow(s.id); await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(w.runs.at(-1), { title: "Jobs", trigger: "now" });
    } finally { await rm(w.dir, { recursive: true, force: true }); }
  });
  test("a run still going when the next time comes is skipped and recorded; a missed time at start is recorded, not run", async () => {
    const w = await world();
    try {
      const s = w.store.add({ title: "Slow", prompt: "p", when: { text: "every 30 minutes", tz: "UTC" } });
      w.sch.start(1e9); w.sch.stop();
      w.hold();
      w.set("2026-09-13T08:00:05Z"); await w.sch.tick(); await new Promise((r) => setTimeout(r, 5));
      assert.equal(w.runs.length, 1);
      w.set("2026-09-13T08:30:05Z"); await w.sch.tick();
      assert.equal(w.runs.length, 1, "not started again");
      assert.equal(w.store.get(s.id)!.runs[0].outcome, "skipped"); assert.match(w.store.get(s.id)!.runs[0].summary, /still running/);
      assert.throws(() => w.sch.runNow(s.id), /running right now/);
      w.release(); await new Promise((r) => setTimeout(r, 10));
      assert.equal(w.store.get(s.id)!.runs[1].outcome, "done");
      // a fresh scheduler (a restart) long after the planned time: missed, and planned again from now
      w.store.patch(s.id, (x) => { x.nextAt = Date.parse("2026-09-13T09:00:00Z"); });
      w.set("2026-09-13T11:00:00Z");
      const sch2 = new Scheduler({ store: w.store, runner: async () => { throw new Error("must not run"); }, now: () => Date.parse("2026-09-13T11:00:00Z") });
      sch2.start(1e9); sch2.stop();
      const st = w.store.get(s.id)!;
      assert.equal(st.runs[0].outcome, "missed"); assert.equal(st.nextAt, Date.parse("2026-09-13T11:30:00Z"));
    } finally { await rm(w.dir, { recursive: true, force: true }); }
  });
  test("a runner that throws makes a failed run with the message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-schedf-"));
    try {
      const store = new ScheduleStore(join(dir, "s.json"));
      const s = store.add({ title: "Bad", prompt: "p", when: { text: "daily", tz: "UTC" } });
      const sch = new Scheduler({ store, runner: async () => { throw new Error("no browser"); } });
      const done = new Promise<Run>((r) => { sch.onDone = (_s, run) => r(run); });
      sch.runNow(s.id);
      const run = await done;
      assert.equal(run.outcome, "failed"); assert.equal(run.summary, "failed: no browser");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("DST: nextRun steps local calendar days, and each edge is handled once", () => {
  test("fall back (2026-10-25, 02:00-03:00 happens twice in Brussels): a fixed-time job runs once, at the first 02:30", () => {
    assert.equal(iso(nextRun("30 2 * * *", BX, new Date("2026-10-24T23:00:00Z"))), "2026-10-25T00:30", "02:30 CEST");
    // planned again from just after that run: not 01:30Z (02:30 CET, the second copy), but tomorrow
    assert.equal(iso(nextRun("30 2 * * *", BX, new Date("2026-10-25T00:30:05Z"))), "2026-10-26T01:30");
  });
  test("fall back: a job on every hour runs in both copies of the repeated hour", () => {
    const seen: string[] = []; let t = new Date("2026-10-24T23:50:00Z");
    for (let i = 0; i < 5; i++) { t = nextRun("*/30 * * * *", BX, t)!; seen.push(iso(t)!); }
    assert.deepEqual(seen, ["2026-10-25T00:00", "2026-10-25T00:30", "2026-10-25T01:00", "2026-10-25T01:30", "2026-10-25T02:00"]);
  });
  test("spring forward (2026-03-29, 02:00-03:00 does not exist in Brussels): a 02:30 job runs at 03:00, once", () => {
    assert.equal(iso(nextRun("30 2 * * *", BX, new Date("2026-03-28T23:00:00Z"))), "2026-03-29T01:00", "03:00 CEST, when the clock lands");
    assert.equal(iso(nextRun("30 2 * * *", BX, new Date("2026-03-29T01:00:05Z"))), "2026-03-30T00:30", "then 02:30 CEST the next day");
    assert.equal(iso(nextRun("30 2 * * *", BX, new Date("2026-03-27T12:00:00Z"))), "2026-03-28T01:30", "the day before is untouched");
  });
  test("spring forward: a job on every hour has no runs in the missing hour, and no pile-up at 03:00", () => {
    const seen: string[] = []; let t = new Date("2026-03-28T23:50:00Z");
    for (let i = 0; i < 4; i++) { t = nextRun("*/30 * * * *", BX, t)!; seen.push(iso(t)!); }
    assert.deepEqual(seen, ["2026-03-29T00:00", "2026-03-29T00:30", "2026-03-29T01:00", "2026-03-29T01:30"]);
  });
  test("a weekday after a 23-hour day is not skipped by a week", () => {
    // Saturday 2026-03-28 → Monday 00:30 CEST 2026-03-30 (= 22:30Z Sunday), not April 6
    assert.equal(iso(nextRun("30 0 * * 1", BX, new Date("2026-03-28T12:00:00Z"))), "2026-03-29T22:30");
    // New York springs forward on 2026-03-08: Monday the 9th, 00:30 EDT, not the 16th
    assert.equal(iso(nextRun("30 0 * * 1", "America/New_York", new Date("2026-03-07T12:00:00Z"))), "2026-03-09T04:30");
    // and after a 25-hour day
    assert.equal(iso(nextRun("30 0 * * 1", BX, new Date("2026-10-24T12:00:00Z"))), "2026-10-25T23:30");
  });
});

describe("every N: only even intervals", () => {
  test("an N that does not divide the day or the hour is refused with the reason", () => {
    assert.throws(() => parseWhen("every 7 hours"), /every 7 hours does not divide the day evenly .* use 1, 2, 3, 4, 6, 8, 12/);
    assert.throws(() => parseWhen("every 45 minutes"), /every 45 minutes does not divide the hour evenly .* 15, 20, 30/);
    assert.equal(parseWhen("every 8 hours").cron, "0 */8 * * *");
    assert.equal(parseWhen("every 15 minutes").cron, "*/15 * * * *");
  });
  test("a cron line with an uneven step is described as the cron line, not as an interval", () => {
    assert.equal(words("0 */7 * * *"), "cron 0 */7 * * *");
    assert.equal(words("*/45 * * * *"), "cron */45 * * * *");
    assert.equal(words("0 */6 * * *"), "every 6 hours");
  });
});

describe("the store keeps a file it cannot read", () => {
  test("a broken schedules.json is moved aside and reported, not overwritten by the next save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-schedc-"));
    try {
      const path = join(dir, "schedules.json");
      const broken = '[{"id":"a","title":"Jobs",},]';   // a trailing comma from a hand-edit
      await writeFile(path, broken);
      const warned: string[] = [];
      const st = new ScheduleStore(path, { warn: (l) => warned.push(l) });
      assert.deepEqual(st.list(), []);
      assert.equal(warned.length, 1); assert.match(warned[0], /could not be read .* moved aside to .*schedules\.json\.corrupt-/);
      const aside = (await readdir(dir)).filter((f) => f.startsWith("schedules.json.corrupt-"));
      assert.equal(aside.length, 1, "moved aside");
      assert.equal(await readFile(join(dir, aside[0]), "utf8"), broken, "byte for byte");
      st.add({ title: "New", prompt: "p", when: { text: "daily", tz: "UTC" } });
      assert.equal(await readFile(join(dir, aside[0]), "utf8"), broken, "the next save did not touch it");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
