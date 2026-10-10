import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readPane, Insights, MIN_REFRESH_MS, plain, lastAssistantText, parseAssessment, type Assessment } from "../src/insight.js";
const A = (summary: string, extra: Partial<Assessment> = {}): Assessment => ({ summary, title: summary, status: "working", ...extra });
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEP = "─".repeat(120);
/* Three panes captured live on 2026-10-09 (tmux capture-pane -p, last lines), lightly shortened. */
const WORKING = [
  "     (ctrl+b ctrl+b (twice) to run in background)",
  "✽ Frosting… (10m 58s · ↓ 7.6k tokens)",
  SEP, "❯ ", SEP,
  "  ⚠ journal: 📓 6 open here · 16 open across projects",
  "  bestekortingen (main +3) | Fable 5.1 | 89% ctx | 30% mem",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
].join("\n");
const IDLE_DONE = [
  "  Dat botst niet met mijn suggesties, want die zitten in andere bestanden.",
  "✻ Baked for 7s · done 3:13 PM · 1 shell still running",
  SEP, "❯ ", SEP,
  "  bestekortingen (main +3) | Opus 5.5 | 45% ctx | 31% mem                 ✔ Update installed · Restart to update",
  "  ⏵⏵ bypass permissions on · 1 shell · ⧉ index · ← for agents",
].join("\n");
const IDLE_PLAIN = [
  "● Both are queued and the drain picks them up within the half hour. The distribution brief ends with a four-week plan",
  "  production is live; the five data stories deploy to staging as soon as the Builder finishes, and I'll show you one of them rendered.",
  SEP, "❯ ", SEP,
  "  ⚠ journal: 📓 3 open here · 34 open across projects",
  "  selfAI (main +1) | Fable 5.1 | 42% ctx | 27% mem",
].join("\n");

describe("readPane", () => {
  test("a spinner with a timer above the box is working; its words are the activity", () => {
    const p = readPane(WORKING);
    assert.equal(p.state, "working");
    assert.equal(p.activity, "Frosting… 10m 58s · ↓ 7.6k tokens");
    assert.equal(p.model, "Fable 5.1"); assert.equal(p.ctxPct, 89);
    assert.doesNotMatch(p.transcript, /Frosting|ctrl\+b/, "chrome is stripped from the summariser's input");
  });
  test("a done line is idle, and says so", () => {
    const p = readPane(IDLE_DONE);
    assert.equal(p.state, "idle");
    assert.match(p.activity!, /Baked for 7s · done 3:13 PM/);
    assert.equal(p.model, "Opus 5.5"); assert.equal(p.ctxPct, 45);
  });
  test("a box with no spinner is idle; the last ● paragraph is the last text", () => {
    const p = readPane(IDLE_PLAIN);
    assert.equal(p.state, "idle");
    assert.match(p.lastText!, /^Both are queued and the drain picks them up .* one of them rendered\.$/);
    assert.equal(p.model, "Fable 5.1");
  });
  test("the last prompt echo is what the session is on; the CLI's placeholder is not a prompt", () => {
    const p = readPane(["❯ From the project board, item c0160bbe: Smoke test of send-next to tmux: reply with the single word", "  received, nothing else. — Do it.", "● Calling codeterminal… (ctrl+o to expand)", "✽ Caramelizing… (6s · ↓ 583 tokens)", SEP, "❯ ", SEP].join("\n"));
    assert.equal(p.state, "working");
    assert.equal(p.lastPrompt, "From the project board, item c0160bbe: Smoke test of send-next to tmux: reply with the single word received, nothing else. — Do it.");
    assert.equal(readPane(IDLE_PLAIN).lastPrompt, undefined);
    assert.equal(readPane(['❯ Try "edit <filepath> to..."', SEP, "❯ ", SEP].join("\n")).lastPrompt, undefined);
  });
  test("a tool call is not the assistant's last words; result chrome is not part of a prompt", () => {
    const p = readPane(["● Here is the plan: two steps, then deploy.", "❯ in dit geval toon truien in andere winkels", "  Read 1 file (ctrl+o to expand)", "● Bash(cd /x && make 2>&1 | tail -1)", "  ⎿ Running… (2m 44s · timeout 10m) (ctrl+b ctrl+b (twice) to run in background)", "✽ Transfiguring… (4m 40s · ↓ 5.4k tokens)", SEP, "❯ ", SEP].join("\n"));
    assert.equal(p.state, "working");
    assert.equal(p.lastText, "Here is the plan: two steps, then deploy.");
    assert.equal(p.lastPrompt, "in dit geval toon truien in andere winkels");
  });
  test("plain: markdown tables and emphasis read as one line", () => {
    assert.equal(plain("Solved — **Wend #104**\n\n| Length | Word |\n|---|---|\n| 3 | **DEN** |\n\nHow: I read the grid."), "Solved — Wend #104 Length Word 3 DEN How: I read the grid.");
    assert.equal(lastAssistantText([{ kind: "user", text: "q" }, { kind: "text", text: "`code` and *more*" }, { kind: "tool" }]), "code and more");
    assert.equal(lastAssistantText([{ kind: "text", text: "old" }, { kind: "user", text: "new question" }]), undefined);
  });
  test("no input box at all: unknown (a shell, vim, a pane that scrolled)", () => {
    assert.equal(readPane("$ ls\nfoo bar\n$ ").state, "unknown");
    assert.equal(readPane("").state, "unknown");
  });
});

describe("parseAssessment", () => {
  test("takes the model's JSON with or without fences; refuses junk; keeps result/question only with the matching status", () => {
    assert.deepEqual(parseAssessment('```json\n{"summary":"Fixing the flaky test.","title":"Fix the flaky upgrade test.","status":"done","result":"A port race; fixed.","question":"ignored"}\n```'),
      { summary: "Fixing the flaky test.", title: "Fix the flaky upgrade test", status: "done", result: "A port race; fixed." });
    assert.deepEqual(parseAssessment('{"summary":"Asking which token to use","title":"Pick the prod bot token","status":"needs_you","question":"Reuse the dev token or make a new bot?"}'),
      { summary: "Asking which token to use", title: "Pick the prod bot token", status: "needs_you", question: "Reuse the dev token or make a new bot?" });
    assert.equal(parseAssessment('{"summary":"x","status":"maybe"}')?.status, "working", "an unknown status reads as working");
    assert.equal(parseAssessment("Sure! Here is my read: nothing"), null);
    assert.equal(parseAssessment('{"status":"done"}'), null, "no words, no assessment");
  });
});

describe("Insights cache", () => {
  test("answers from the cache, refreshes in the background when the text changed and the last refresh is old", async () => {
    let now = 1_000_000; const calls: string[] = [];
    const fresh: string[] = [];
    const ins = new Insights(async (t) => { calls.push(t); return A(`summary of ${t.slice(0, 5)}`); }, () => now);
    ins.onFresh = (k, a) => fresh.push(`${k}=${a.summary}`);
    assert.equal(ins.get("chat:1", "hello world"), null, "first ask: nothing yet, a refresh starts");
    await new Promise((r) => setImmediate(r));
    assert.equal(ins.get("chat:1", "hello world")?.summary, "summary of hello");
    assert.deepEqual(fresh, ["chat:1=summary of hello"], "the keeper is told when a read lands");
    assert.equal(calls.length, 1);
    // Same text: no new call. Changed text but too soon: still the old line, no call.
    ins.get("chat:1", "hello world"); assert.equal(calls.length, 1);
    now += MIN_REFRESH_MS - 1;
    assert.equal(ins.get("chat:1", "something else")?.summary, "summary of hello"); assert.equal(calls.length, 1);
    // force: a turn just ended, read now even though the window is not over.
    assert.equal(ins.get("chat:1", "forced read", true)?.summary, "summary of hello");
    await new Promise((r) => setImmediate(r));
    assert.equal(ins.get("chat:1", "forced read")?.summary, "summary of force"); assert.equal(calls.length, 2);
    now += MIN_REFRESH_MS + 2;
    assert.equal(ins.get("chat:1", "something else")?.summary, "summary of force", "the old value until the new one lands");
    await new Promise((r) => setImmediate(r));
    assert.equal(ins.get("chat:1", "something else")?.summary, "summary of somet"); assert.equal(calls.length, 3);
    // Empty text keeps whatever was known; a failing assessor keeps the old value.
    assert.equal(ins.get("chat:1", "   ")?.summary, "summary of somet");
    const bad = new Insights(async () => { throw new Error("offline"); }, () => now);
    assert.equal(bad.get("x", "abc"), null);
    await new Promise((r) => setImmediate(r));
    assert.equal(bad.get("x", "abc"), null);
    ins.keep(["other"]);
    assert.equal(ins.get("chat:1", "   "), null, "forgotten");
  });
  test("persists to disk and comes back after a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-ins-"));
    try {
      const path = join(dir, "insights.json");
      let now = 5_000_000;
      const a = new Insights(async () => A("the line", { status: "done", result: "shipped" }), () => now, path);
      a.get("chat:9", "some transcript");
      await new Promise((r) => setTimeout(r, 650));   // the save debounce
      const b = new Insights(async () => A("a new line"), () => now, path);
      assert.deepEqual(b.get("chat:9", "some transcript"), { summary: "the line", title: "the line", status: "done", result: "shipped" }, "same text: the saved value, no call");
      now += MIN_REFRESH_MS + 1;
      assert.equal(b.get("chat:9", "changed")?.summary, "the line");
      await new Promise((r) => setImmediate(r));
      assert.equal(b.get("chat:9", "changed")?.summary, "a new line");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
