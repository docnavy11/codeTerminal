/**
 * Scores the board keeper's Haiku read against the labelled tails in
 * keeper.cases.ts. Makes real model calls (cases × runs), so it is not part
 * of `npm test`:
 *
 *   npm run eval:keeper                 # 2 runs per case
 *   npm run eval:keeper -- --runs 5
 *   npm run eval:keeper -- --min 0.85   # exit 1 below this share of passing runs
 *   npm run eval:keeper -- --reported   # also score the cards you flagged on the board
 *                                       # (workspace/keeper-misreads.jsonl, or --reported <path>)
 *
 * A run passes when the status is one the case accepts, the title matches
 * titleLike and avoids titleNot, a done carries a result, and a needs_you
 * carries a question. Rerun it whenever the prompt in src/insight.ts changes.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assessWithHaiku, type Assessment } from "../../src/insight.js";
import { CASES, type Case } from "./keeper.cases.js";

/**
 * The owner's corrections from the board ("not a task", "wrong title"), each saved with the thread
 * the keeper read, as new cases: a "not a task" must no longer read as done; a wrong title must
 * not come back as the title it got and must keep the words of the title the owner chose.
 */
function reportedCases(path: string): Case[] {
  if (!existsSync(path)) { console.error(`no reported misreads at ${path}`); return []; }
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line, n) => {
    try {
      const m = JSON.parse(line) as { at: number; key: string; tail: string; said: { title: string }; wanted: { status: Case["status"][number]; title?: string } };
      if (!m.tail) return [];
      const words = (m.wanted.title ?? "").split(/\s+/).filter((w) => w.length > 3).slice(0, 3);
      return [{ name: `reported ${n + 1}: ${m.key} "${m.said.title.slice(0, 40)}"`, tail: m.tail,
        status: m.wanted.status === "working" ? ["working", "idle", "needs_you"] : [m.wanted.status],
        ...(m.wanted.title ? { titleNot: new RegExp(`^${esc(m.said.title)}$`, "i"), ...(words.length ? { titleLike: new RegExp(words.map((w) => `(?=.*${esc(w)})`).join(""), "i") } : {}) } : {}) } satisfies Case];
    } catch { return []; }
  });
}

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg("runs", "2")), MIN = Number(arg("min", "0"));
const reportedAt = process.argv.includes("--reported") ? (process.argv[process.argv.indexOf("--reported") + 1]?.startsWith("--") || process.argv[process.argv.indexOf("--reported") + 1] === undefined ? join(import.meta.dirname, "..", "..", "workspace", "keeper-misreads.jsonl") : process.argv[process.argv.indexOf("--reported") + 1]) : null;
const ALL: Case[] = [...CASES, ...(reportedAt ? reportedCases(reportedAt) : [])];

function judge(c: Case, a: Assessment | null): string[] {
  if (!a) return ["no usable answer"];
  const why: string[] = [];
  if (!c.status.includes(a.status)) why.push(`status ${a.status}, wanted ${c.status.join("|")}`);
  if (c.titleLike && !c.titleLike.test(a.title)) why.push(`title "${a.title}" does not read as the task`);
  if (c.titleNot && c.titleNot.test(a.title)) why.push(`title "${a.title}" is a step`);
  if (a.status === "done" && !a.result) why.push("done without a result");
  if (a.status === "needs_you" && !a.question) why.push("needs_you without a question");
  return why;
}

let pass = 0, total = 0;
const rows: string[] = [];
for (const c of ALL) {
  const results = await Promise.all(Array.from({ length: RUNS }, () => assessWithHaiku(c.tail)));
  const marks = results.map((a) => judge(c, a));
  const ok = marks.filter((m) => !m.length).length;
  pass += ok; total += RUNS;
  rows.push(`${ok === RUNS ? "PASS" : ok === 0 ? "FAIL" : "FLAKY"} ${ok}/${RUNS}  ${c.name}`);
  results.forEach((a, i) => { if (marks[i].length) rows.push(`        run ${i + 1}: ${marks[i].join("; ")}  [${a ? `${a.status} | ${a.title}` : "null"}]`); });
}
console.log(rows.join("\n"));
const score = pass / total;
console.log(`\n${pass}/${total} runs passed (${(score * 100).toFixed(0)}%), ${ALL.length} cases × ${RUNS} runs, model ${process.env.CT_MODEL ?? "claude-haiku-5-5"}`);
if (score < MIN) { console.error(`below --min ${MIN}`); process.exit(1); }
