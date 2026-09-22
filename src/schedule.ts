/**
 * Scheduled prompts: a prepared prompt runs by itself at a time you set, in
 * a chat of its own, in the browser you chose, and leaves you the result.
 * Design: docs/design-scheduled-prompts.md.
 *
 * This file is the clockwork — when (five-field cron with words on top, in
 * an IANA time zone), the store (schedules.json), and the ticking Scheduler
 * that decides what is due and asks an injected runner to run it. How a run
 * happens (a chat, a prompt, a browser) is schedule-run.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { quarantine } from "./store.js";

export type When = { text: string; cron: string; tz: string };

export type RunOutcome = "done" | "stopped" | "needed-you" | "failed" | "missed" | "skipped" | "running";

export type Run = {
  id: string;
  chatId: string | null;
  startedAt: number;
  endedAt: number | null;
  outcome: RunOutcome;
  costUsd: number | null;
  /** The reply's first line, or what went wrong. */
  summary: string;
  /** Files the run offered (relative to the files root). */
  files: string[];
  /** Sites it needed and did not have, cards it answered for you. */
  needed: string[];
  cards: string[];
  trigger: "schedule" | "now";
};

export type Schedule = {
  id: string;
  title: string;
  /** The prompt as stored with the schedule; promptId + useLatest re-read the prepared prompt at run time. */
  prompt: string;
  promptId?: string;
  useLatest?: boolean;
  when: When;
  project: string;
  browser: "server" | "auto";
  mode: "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan";
  model?: string;
  budgetUsd?: number;
  /** How long an unattended card waits for a person before it is answered "no" (ms). */
  waitMs: number;
  /** How long a run may take before it is stopped (ms). */
  maxMs: number;
  keepRuns: number;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
  nextAt: number | null;
  runs: Run[];
};

export type ScheduleInput = Partial<Omit<Schedule, "id" | "createdAt" | "updatedAt" | "nextAt" | "runs" | "when">> & { title: string; prompt: string; when: { text: string; tz: string } };

/* ---------------- when: words → cron, cron → next time ---------------- */

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const EVEN_HOURS = [1, 2, 3, 4, 6, 8, 12];
const EVEN_MINUTES = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30];
const DOW_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "every day at 08:00", "weekdays at 07:30", "every monday at 9", "every 6 hours", "every 30 minutes", or a five-field cron line. */
export function parseWhen(text: string): { cron: string; words: string } {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) throw new Error("when: say something like \"every day at 08:00\", \"weekdays at 07:30\", \"every monday at 9\", \"every 6 hours\", or a cron line");
  const time = (s: string | undefined): { h: number; m: number } => {
    const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec((s ?? "").trim());
    if (!m) throw new Error(`when: cannot read the time "${s}" — use HH:MM (24h)`);
    let h = Number(m[1]); const mm = Number(m[2] ?? 0);
    if (m[3] === "pm" && h < 12) h += 12; if (m[3] === "am" && h === 12) h = 0;
    if (h > 23 || mm > 59) throw new Error(`when: "${s}" is not a valid time`);
    return { h, m: mm };
  };
  let m: RegExpExecArray | null;
  if ((m = /^(?:every ?day|daily)(?: at (.+))?$/.exec(t))) { const { h, m: mm } = time(m[1] ?? "8:00"); return { cron: `${mm} ${h} * * *`, words: describe(`${mm} ${h} * * *`) }; }
  if ((m = /^(?:every )?weekdays?(?: at (.+))?$/.exec(t))) { const { h, m: mm } = time(m[1] ?? "8:00"); return { cron: `${mm} ${h} * * 1-5`, words: describe(`${mm} ${h} * * 1-5`) }; }
  if ((m = /^(?:every )?weekends?(?: at (.+))?$/.exec(t))) { const { h, m: mm } = time(m[1] ?? "9:00"); return { cron: `${mm} ${h} * * 0,6`, words: describe(`${mm} ${h} * * 0,6`) }; }
  if ((m = /^every ([a-z]+)(?: at (.+))?$/.exec(t)) && DOW[m[1]] !== undefined) { const { h, m: mm } = time(m[2] ?? "8:00"); return { cron: `${mm} ${h} * * ${DOW[m[1]]}`, words: describe(`${mm} ${h} * * ${DOW[m[1]]}`) }; }
  // "every N" is a cron step, and a cron step restarts at every midnight (or
  // every full hour): "every 7 hours" would be 00, 07, 14, 21 and then 00
  // again, a 3-hour gap, not an interval. Only an N that divides the day (or
  // the hour) is an even interval, so only that N is accepted; anything else
  // is refused with the reason rather than quietly run on an uneven rhythm.
  if ((m = /^every (\d+) hours?$/.exec(t))) { const n = Number(m[1]); if (n < 1 || n > 23) throw new Error("when: every N hours, N between 1 and 23"); if (24 % n) throw new Error(`when: every ${n} hours does not divide the day evenly (the count restarts at midnight) — use ${EVEN_HOURS.join(", ")}, or a cron line with the exact hours`); return { cron: `0 */${n} * * *`, words: describe(`0 */${n} * * *`) }; }
  if ((m = /^(?:every )?hour(?:ly)?$/.exec(t))) return { cron: "0 * * * *", words: describe("0 * * * *") };
  if ((m = /^every (\d+) min(?:ute)?s?$/.exec(t))) { const n = Number(m[1]); if (n < 1 || n > 59) throw new Error("when: every N minutes, N between 1 and 59"); if (60 % n) throw new Error(`when: every ${n} minutes does not divide the hour evenly (the count restarts every hour) — use ${EVEN_MINUTES.join(", ")}, or a cron line with the exact minutes`); return { cron: `*/${n} * * * *`, words: describe(`*/${n} * * * *`) }; }
  if ((m = /^(?:monthly|every month)(?: on (?:the )?(\d{1,2})(?:st|nd|rd|th)?)?(?: at (.+))?$/.exec(t))) { const d = Number(m[1] ?? 1); const { h, m: mm } = time(m[2] ?? "8:00"); return { cron: `${mm} ${h} ${d} * *`, words: describe(`${mm} ${h} ${d} * *`) }; }
  if ((m = /^at (.+)$/.exec(t))) { const { h, m: mm } = time(m[1]); return { cron: `${mm} ${h} * * *`, words: describe(`${mm} ${h} * * *`) }; }
  const fields = t.split(" ");
  if (fields.length === 5) { parseCron(t); return { cron: t, words: describe(t) }; }
  throw new Error(`when: cannot read "${text}" — try "every day at 08:00", "weekdays at 07:30", "every monday at 9", "every 6 hours", or a cron line (m h dom mon dow)`);
}

type CronField = Set<number>;
type Cron = { min: CronField; hour: CronField; dom: CronField; mon: CronField; dow: CronField; anyDom: boolean; anyDow: boolean };

function field(spec: string, lo: number, hi: number, names?: Record<string, number>): { set: CronField; any: boolean } {
  const set = new Set<number>(); let any = false;
  for (const part of spec.split(",")) {
    const m = /^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron: cannot read "${part}"`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`cron: bad step in "${part}"`);
    let a: number, b: number;
    if (m[1] === "*") { a = lo; b = hi; if (step === 1) any = true; }
    else {
      const [x, y] = m[1].split("-");
      const num = (s: string) => { const v = names?.[s] ?? Number(s); if (!Number.isInteger(v)) throw new Error(`cron: "${s}" is not a number`); return v; };
      a = num(x); b = y === undefined ? a : num(y);
      if (lo === 0 && hi === 6) { if (a === 7) a = 0; if (b === 7) b = 0; }   // dow 7 = Sunday
      if (a < lo || b > hi || a > b) throw new Error(`cron: "${part}" is outside ${lo}-${hi}`);
    }
    for (let v = a; v <= b; v += step) set.add(v);
  }
  return { set, any };
}

export function parseCron(line: string): Cron {
  const f = line.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("cron: five fields — minute hour day-of-month month day-of-week");
  const min = field(f[0], 0, 59), hour = field(f[1], 0, 23), dom = field(f[2], 1, 31), mon = field(f[3], 1, 12), dow = field(f[4], 0, 6, DOW);
  return { min: min.set, hour: hour.set, dom: dom.set, mon: mon.set, dow: dow.set, anyDom: dom.any, anyDow: dow.any };
}

/** The cron line in words, for the schedule list. */
export function describe(cron: string): string {
  const c = parseCron(cron);
  const f = cron.trim().split(/\s+/);
  const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const times = c.min.size === 1 && c.hour.size === 1 ? hhmm([...c.hour][0], [...c.min][0]) : null;
  const days = c.anyDow ? "every day" : eq(c.dow, [1, 2, 3, 4, 5]) ? "weekdays" : eq(c.dow, [0, 6]) ? "weekends" : "every " + [...c.dow].sort().map((d) => DOW_NAME[d]).join(", ");
  if (times && c.anyDom && c.mon.size === 12) return `${days} at ${times}`;
  if (times && !c.anyDom && c.mon.size === 12 && c.dom.size === 1) return `monthly on the ${[...c.dom][0]} at ${times}`;
  // Only a step that divides the hour or the day is an interval; a cron line
  // like `0 */7 * * *` is shown as the cron line it is, not as "every 7 hours".
  if (/^\*\/\d+$/.test(f[0]) && c.hour.size === 24 && c.anyDom && c.anyDow && c.mon.size === 12 && 60 % Number(f[0].slice(2)) === 0) return `every ${f[0].slice(2)} minutes`;
  if (f[0] === "0" && /^\*\/\d+$/.test(f[1]) && c.anyDom && c.anyDow && c.mon.size === 12 && 24 % Number(f[1].slice(2)) === 0) return `every ${f[1].slice(2)} hours`;
  if (f[0] === "0" && c.hour.size === 24) return "every hour";
  return `cron ${cron.trim()}`;
}
const eq = (s: Set<number>, arr: number[]) => s.size === arr.length && arr.every((v) => s.has(v));

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** The wall clock in `tz` at instant `t`, as if that wall time were UTC (ms). */
function wallAt(t: number, tz: string): number {
  let f = fmtCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); fmtCache.set(tz, f); }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
}
/** How far `tz` is ahead of UTC at instant `t` (ms). */
const offsetAt = (t: number, tz: string) => wallAt(Math.floor(t / 60_000) * 60_000, tz) - Math.floor(t / 60_000) * 60_000;

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * The first instant after `after` that matches the cron line in `tz`; null if none within ~400 days.
 *
 * It walks local calendar days and turns each matching wall time into an
 * instant, rather than stepping a UTC clock by fixed 24 hours — measured
 * before this: a fixed step landed at 01:00 after a 23-hour day and skipped
 * a Monday 00:30 run by a week. The two DST edges follow Vixie cron:
 *   - spring forward (02:30 does not exist): a job at a fixed hour runs at the
 *     first valid minute after the gap (03:00), once; a job on every hour
 *     (`*` in the hour field) simply has no runs in the missing hour.
 *   - fall back (02:30 happens twice): a job at a fixed hour runs once, at
 *     the first 02:30; a job on every hour runs in both copies of the hour,
 *     so "every 30 minutes" keeps its real-time rhythm.
 */
export function nextRun(cron: string, tz: string, after: Date): Date | null {
  const c = parseCron(cron);
  if (!validTimeZone(tz)) throw new Error(`unknown time zone "${tz}"`);
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const from = Math.floor(after.getTime() / MIN) * MIN + MIN;   // the exact minute of `after` is excluded
  const everyHour = c.hour.size === 24;
  const hours = [...c.hour].sort((x, y) => x - y), mins = [...c.min].sort((x, y) => x - y);
  const fromOffset = offsetAt(from, tz);
  const start = wallAt(from, tz);
  let day = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), new Date(start).getUTCDate()) - DAY;
  for (let i = 0; i < 402; i++, day += DAY) {
    const d = new Date(day);
    const mon = d.getUTCMonth() + 1, dom = d.getUTCDate(), dow = d.getUTCDay();
    const dayOk = c.mon.has(mon) && (c.anyDom && c.anyDow ? true : c.anyDom ? c.dow.has(dow) : c.anyDow ? c.dom.has(dom) : (c.dom.has(dom) || c.dow.has(dow)));
    if (!dayOk) continue;
    // The zone's offset before and after this local day: they differ on the
    // one day a year the clocks change (no zone changes twice in two days).
    const before = offsetAt(day - 15 * HOUR, tz), afterDay = offsetAt(day + 37 * HOUR, tz);
    let best: number | null = null;
    walls: for (const h of hours) for (const m of mins) {
      const wall = day + h * HOUR + m * MIN;
      if (wall - fromOffset + 3 * HOUR < from) continue;   // far before `from`, whatever the offset does today
      let hits: number[];
      if (before === afterDay) hits = [wall - before];
      else hits = [...new Set([wall - before, wall - afterDay])].filter((t) => wallAt(t, tz) === wall).sort((x, y) => x - y);
      if (hits.length === 0) {
        // In the spring-forward gap: a fixed-hour job runs when the clock lands.
        if (everyHour) continue;
        let lo = wall - afterDay, hi = wall - before;           // offset is `before` at lo, `afterDay` at hi
        while (hi - lo > MIN) { const mid = lo + Math.floor((hi - lo) / 2 / MIN) * MIN; if (offsetAt(mid, tz) === before) lo = mid; else hi = mid; }
        hits = [hi];
      } else if (hits.length > 1 && !everyHour) hits = [hits[0]];   // fall back: a fixed-hour job runs once
      for (const t of hits) if (t >= from && (best === null || t < best)) best = t;
      if (best !== null && hits[0] > best) break walls;   // later wall times only land later
    }
    if (best !== null) return new Date(best);
    if (day - from > 400 * DAY) break;
  }
  return null;
}

/* ---------------- the store ---------------- */

export class ScheduleStore {
  #path: string;
  #items: Schedule[] = [];
  #warn: (l: string) => void;
  constructor(path: string, o: { warn?: (l: string) => void } = {}) { this.#path = path; this.#warn = o.warn ?? ((l) => console.warn(l)); this.#load(); }
  #load(): void {
    if (!existsSync(this.#path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#path, "utf8"));
      if (!Array.isArray(raw)) throw new Error("not a list of schedules");
      this.#items = raw;
    } catch (e) {
      /* Starting empty and letting the next save rewrite the file wiped every
         schedule over one stray comma (reproduced: a trailing comma). The
         file is moved aside instead, so a hand-edit can be repaired and put
         back, and it is said loudly — an empty list with no word is how this
         would otherwise be discovered. */
      this.#warn(`[schedule] ${this.#path} could not be read (${e instanceof Error ? e.message : e}); ${quarantine(this.#path, this.#warn)} — starting with no schedules`);
    }
  }
  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#items, null, 2));
    renameSync(tmp, this.#path);
  }
  list(): Schedule[] { return this.#items.map((s) => ({ ...s, runs: [...s.runs] })); }
  get(id: string): Schedule | null { const s = this.#items.find((x) => x.id === id); return s ? { ...s, runs: [...s.runs] } : null; }
  add(input: ScheduleInput): Schedule {
    const s = this.#validate(input, { id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), nextAt: null, runs: [] });
    this.#items.push(s); this.#save(); return { ...s };
  }
  update(id: string, input: Partial<ScheduleInput> & { paused?: boolean }): Schedule | null {
    const i = this.#items.findIndex((x) => x.id === id); if (i < 0) return null;
    const cur = this.#items[i];
    const merged = this.#validate({ ...cur, ...input, when: input.when ? { text: input.when.text, tz: input.when.tz } : cur.when }, { id: cur.id, createdAt: cur.createdAt, updatedAt: Date.now(), nextAt: cur.nextAt, runs: cur.runs });
    if (input.when) merged.nextAt = null;   // recomputed by the scheduler
    this.#items[i] = merged; this.#save(); return { ...merged };
  }
  remove(id: string): boolean { const n = this.#items.length; this.#items = this.#items.filter((x) => x.id !== id); if (this.#items.length === n) return false; this.#save(); return true; }
  /** Internal updates from the scheduler: nextAt and runs. Applied in memory first, so a failed write (thrown) still leaves the change in effect until the next save. */
  patch(id: string, f: (s: Schedule) => void): void { const s = this.#items.find((x) => x.id === id); if (!s) return; f(s); this.#save(); }
  #validate(input: ScheduleInput, fixed: Pick<Schedule, "id" | "createdAt" | "updatedAt" | "nextAt" | "runs">): Schedule {
    const title = String(input.title ?? "").trim(); if (!title) throw new Error("a schedule needs a title");
    const prompt = String(input.prompt ?? "").trim(); if (!prompt) throw new Error("a schedule needs a prompt");
    const tz = String(input.when?.tz ?? "UTC"); if (!validTimeZone(tz)) throw new Error(`unknown time zone "${tz}"`);
    const { cron } = parseWhen(String(input.when?.text ?? ""));
    const mode = input.mode ?? "auto";
    if (!["default", "acceptEdits", "auto", "bypassPermissions", "plan"].includes(mode)) throw new Error(`unknown mode "${mode}"`);
    const num = (v: unknown, d: number, lo: number, hi: number, what: string) => { if (v === undefined || v === null || v === "") return d; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what}: between ${lo} and ${hi}`); return n; };
    return {
      ...fixed, title, prompt, promptId: input.promptId || undefined, useLatest: !!input.useLatest,
      when: { text: String(input.when!.text).trim(), cron, tz },
      project: String(input.project ?? "general"), browser: input.browser === "auto" ? "auto" : "server", mode,
      model: input.model?.trim() || undefined,
      budgetUsd: input.budgetUsd === undefined || input.budgetUsd === null ? undefined : num(input.budgetUsd, 0, 0.01, 1000, "budget"),
      /* The wait is how long a card stands before it is answered "no" for you.
         Two minutes was right when the only way to answer was to be at the
         page; now a notification links into the chat, so it has to cover
         noticing a phone and unlocking it. Ten. */
      waitMs: num(input.waitMs, 600_000, 1000, 3_600_000, "wait"), maxMs: num(input.maxMs, 30 * 60_000, 10_000, 6 * 3_600_000, "max run time"),
      keepRuns: num(input.keepRuns, 10, 1, 100, "runs to keep"), paused: !!input.paused,
    };
  }
}

/* ---------------- the scheduler ---------------- */

export type RunResult = Omit<Run, "id" | "startedAt" | "trigger">;
export type Runner = (s: Schedule, run: Run) => Promise<RunResult>;

export class Scheduler {
  #store: ScheduleStore;
  #runner: Runner;
  #now: () => number;
  #timer: NodeJS.Timeout | null = null;
  #running = new Map<string, Run>();
  #log: (l: string) => void;
  #warn: (l: string) => void;
  /** After a run: for notifications and the manage page. */
  onDone: (s: Schedule, run: Run) => void = () => {};
  constructor(o: { store: ScheduleStore; runner: Runner; now?: () => number; log?: (l: string) => void; warn?: (l: string) => void }) {
    this.#store = o.store; this.#runner = o.runner; this.#now = o.now ?? (() => Date.now());
    this.#log = o.log ?? (() => {}); this.#warn = o.warn ?? (() => {});
  }

  /** Compute what is due; a schedule whose time passed while the server was down is recorded as missed, not run. */
  start(tickMs = 30_000): void {
    const now = this.#now();
    for (const s of this.#store.list()) {
      if (s.nextAt !== null && s.nextAt < now - 60_000 && !s.paused) {
        this.#store.patch(s.id, (x) => { x.runs.unshift({ id: randomUUID(), chatId: null, startedAt: s.nextAt!, endedAt: s.nextAt, outcome: "missed", costUsd: null, summary: "missed: the server was not running at that time", files: [], needed: [], cards: [], trigger: "schedule" }); x.runs.length = Math.min(x.runs.length, 50); });
        this.#log(`[schedule] ${s.title}: missed ${new Date(s.nextAt).toISOString()}`);
      }
      this.#plan(s.id, now);
    }
    this.#timer = setInterval(() => void this.tick(), tickMs);
    this.#timer.unref();
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  /** Recompute nextAt from the cron and zone. */
  #plan(id: string, from: number): void {
    const s = this.#store.get(id); if (!s) return;
    let next: number | null = null;
    try { next = s.paused ? null : nextRun(s.when.cron, s.when.tz, new Date(from))?.getTime() ?? null; } catch (e) { this.#warn(`[schedule] ${s.title}: ${e instanceof Error ? e.message : e}`); }
    this.#store.patch(id, (x) => { x.nextAt = next; });
  }
  replan(id: string): void { this.#plan(id, this.#now()); }

  async tick(): Promise<void> {
    const now = this.#now();
    for (const s of this.#store.list()) {
      if (s.paused || s.nextAt === null || s.nextAt > now) continue;
      if (this.#running.has(s.id)) {
        this.#store.patch(s.id, (x) => { x.runs.unshift({ id: randomUUID(), chatId: null, startedAt: now, endedAt: now, outcome: "skipped", costUsd: null, summary: "skipped: the previous run is still running", files: [], needed: [], cards: [], trigger: "schedule" }); });
        this.#plan(s.id, now);
        continue;
      }
      this.#plan(s.id, now);
      void this.#run(s.id, "schedule");
    }
  }

  runNow(id: string): Run {
    const s = this.#store.get(id); if (!s) throw new Error("no such schedule");
    if (this.#running.has(id)) throw new Error("this schedule is running right now");
    return this.#run(id, "now");
  }
  isRunning(id: string): boolean { return this.#running.has(id); }

  #run(id: string, trigger: "schedule" | "now"): Run {
    const s = this.#store.get(id)!;
    const run: Run = { id: randomUUID(), chatId: null, startedAt: this.#now(), endedAt: null, outcome: "running", costUsd: null, summary: "", files: [], needed: [], cards: [], trigger };
    this.#running.set(id, run);
    this.#store.patch(id, (x) => { x.runs.unshift(run); x.runs.length = Math.min(x.runs.length, 50); });
    this.#log(`[schedule] ${s.title}: run started (${trigger})`);
    void (async () => {
      let result: RunResult;
      try { result = await this.#runner(s, run); }
      catch (e) { result = { chatId: run.chatId, endedAt: this.#now(), outcome: "failed", costUsd: null, summary: `failed: ${e instanceof Error ? e.message : String(e)}`, files: [], needed: [], cards: [] }; }
      const finished: Run = { ...run, ...result, endedAt: result.endedAt ?? this.#now() };
      this.#running.delete(id);
      this.#store.patch(id, (x) => { const i = x.runs.findIndex((r) => r.id === run.id); if (i >= 0) x.runs[i] = finished; else x.runs.unshift(finished); });
      this.#log(`[schedule] ${s.title}: ${finished.outcome}${finished.costUsd != null ? ` · $${finished.costUsd.toFixed(2)}` : ""} — ${finished.summary.slice(0, 120)}`);
      const latest = this.#store.get(id);
      if (latest) this.onDone(latest, finished);
    })();
    return run;
  }
}
