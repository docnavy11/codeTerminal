/**
 * Scores the board keeper's Haiku read against the labelled tails in
 * keeper.cases.ts. Makes real model calls (cases × runs), so it is not part
 * of `npm test`:
 *
 *   npm run eval:keeper                 # 2 runs per case
 *   npm run eval:keeper -- --runs 5
 *   npm run eval:keeper -- --min 0.85   # exit 1 below this share of passing runs
 *
 * A run passes when the status is one the case accepts, the title matches
 * titleLike and avoids titleNot, a done carries a result, and a needs_you
 * carries a question. Rerun it whenever the prompt in src/insight.ts changes.
 */
import { assessWithHaiku, type Assessment } from "../../src/insight.js";
import { CASES, type Case } from "./keeper.cases.js";

const arg = (name: string, d: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg("runs", "2")), MIN = Number(arg("min", "0"));

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
for (const c of CASES) {
  const results = await Promise.all(Array.from({ length: RUNS }, () => assessWithHaiku(c.tail)));
  const marks = results.map((a) => judge(c, a));
  const ok = marks.filter((m) => !m.length).length;
  pass += ok; total += RUNS;
  rows.push(`${ok === RUNS ? "PASS" : ok === 0 ? "FAIL" : "FLAKY"} ${ok}/${RUNS}  ${c.name}`);
  results.forEach((a, i) => { if (marks[i].length) rows.push(`        run ${i + 1}: ${marks[i].join("; ")}  [${a ? `${a.status} | ${a.title}` : "null"}]`); });
}
console.log(rows.join("\n"));
const score = pass / total;
console.log(`\n${pass}/${total} runs passed (${(score * 100).toFixed(0)}%), ${CASES.length} cases × ${RUNS} runs, model ${process.env.CT_MODEL ?? "claude-haiku-5-5"}`);
if (score < MIN) { console.error(`below --min ${MIN}`); process.exit(1); }
