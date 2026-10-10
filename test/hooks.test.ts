import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startTestServer, type TestServer } from "./fakes/server.js";
import { fakeClaude, haveTools } from "./fakes/tmux.js";

/**
 * The terminal side of the board: deploy/hooks/todo-context.sh (a
 * UserPromptSubmit hook that appends the queue and the owner's answers) and
 * todo-status.sh (a status-line fragment). Plain bash over curl and jq,
 * run here against a real test server; until now only run by hand.
 */
const tools = haveTools("bash", "curl", "jq");
const tmux = haveTools("tmux");
const CONTEXT = join(import.meta.dirname, "..", "deploy", "hooks", "todo-context.sh");
const STOP = join(import.meta.dirname, "..", "deploy", "hooks", "todo-stop.sh");
const STATUS = join(import.meta.dirname, "..", "deploy", "hooks", "todo-status.sh");

let s: TestServer, ws: string;
const sessions: ReturnType<typeof fakeClaude>[] = [];
before(async () => { if (!tools) return; s = await startTestServer(); ws = join(s.root, "ws"); });
after(async () => { for (const f of sessions) f.stop(); if (s) await s.stop(); });

/** Async on purpose: the test server lives in this process, and a synchronous spawn would freeze it while the script's curl waits for it. */
const run = (script: string, stdin: string, env: Record<string, string> = {}, args: string[] = []) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const c = spawn("bash", [script, ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", CODETERM_URL: s?.base ?? "http://127.0.0.1:1", ...env } });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => c.kill("SIGKILL"), 15_000);
    c.on("close", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
    c.stdin.end(stdin);
  });
const hook = (env: Record<string, string> = {}) => run(CONTEXT, JSON.stringify({ cwd: ws }), env);
const add = async (text: string, extra: Record<string, unknown> = {}) => (await s.post("/todos", { dir: ws, text, ...extra })).body as { id: string };
const patch = (id: string, body: unknown) => s.json(`/todos/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("todo-context.sh", { skip: !tools }, () => {
  test("nothing to say: prints nothing, exits 0", async () => {
    const r = await hook();
    assert.equal(r.status, 0); assert.equal(r.stdout, "");
  });

  test("an unreachable server never blocks a prompt: nothing, exit 0, quickly", async () => {
    const t0 = Date.now();
    const r = await run(CONTEXT, JSON.stringify({ cwd: ws }), { CODETERM_URL: "http://127.0.0.1:1" });
    assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.ok(Date.now() - t0 < 5000);
  });

  test("no cwd in the hook's JSON: nothing", async () => {
    const r = await run(CONTEXT, "{}"); assert.equal(r.status, 0); assert.equal(r.stdout, "");
  });

  test("queued and held items come out as a project-queue block with 8-char ids and how to claim", async () => {
    const a = await add("Write the release notes"), b = await add("Fix the footer on mobile");
    await patch(b.id, { root: ws, action: "claim", by: "tmux:other" });
    const r = await hook();
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^<project-queue note="The owner's todo list for ws, from the codeTerminal board\./);
    assert.match(r.stdout, new RegExp(`- \\[${a.id.slice(0, 8)}\\] queued: Write the release notes`));
    assert.match(r.stdout, new RegExp(`- \\[${b.id.slice(0, 8)}\\] claimed \\(tmux:other\\): Fix the footer on mobile`));
    assert.match(r.stdout, /claim_todo \(project: \\"[^"]*ws\\"/);
    assert.match(r.stdout.trimEnd(), /<\/project-queue>$/);
  });

  test("the owner's answers to THIS session's questions come first; another session's do not appear", { skip: !tmux }, async () => {
    const mine = fakeClaude("idle", ws), other = fakeClaude("idle", ws); sessions.push(mine, other);
    await new Promise((r) => setTimeout(r, 300));
    const q1 = await add("Reuse the dev token?", { for: "owner", addedBy: `tmux:${mine.name}` });
    const q2 = await add("Which colour for the badge?", { for: "owner", addedBy: `tmux:${other.name}` });
    await patch(q1.id, { root: ws, action: "answer", result: "no, make a new bot" });
    await patch(q2.id, { root: ws, action: "answer", result: "green" });
    const r = await hook({ TMUX_PANE: mine.pane() });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^<owner-answers note="The owner answered what you asked on the board\. Act on these; do not ask again\.">\n- Q: Reuse the dev token\?\n  A: no, make a new bot\n<\/owner-answers>\n/);
    assert.doesNotMatch(r.stdout, /Which colour for the badge|green/);
    assert.match(r.stdout, /<project-queue/, "the queue follows the answers");
  });

  test("outside tmux there is no session to address: the queue only", async () => {
    const r = await hook({ TMUX_PANE: "" });
    assert.doesNotMatch(r.stdout, /owner-answers/); assert.match(r.stdout, /<project-queue/);
  });
});

describe("todo-status.sh", { skip: !tools }, () => {
  test("counts what is queued, held and for the owner; nothing when the list is empty or the server is down", async () => {
    // State left by the tests above: at least two queued plus one held. Add an owner question for the third count.
    await add("Is the staging data fine to wipe?", { for: "owner", addedBy: "tmux:x" });
    const r = await run(STATUS, "", {}, [ws]);
    assert.equal(r.status, 0);
    assert.match(r.stdout.trim(), /^todo \d+ queued · 1 held · 1 for you$/);
    const fromJson = await run(STATUS, JSON.stringify({ cwd: ws }));
    assert.equal(fromJson.stdout.trim(), r.stdout.trim(), "reads the cwd from the status line's JSON too");
    const down = await run(STATUS, "", { CODETERM_URL: "http://127.0.0.1:1" }, [ws]);
    assert.equal(down.status, 0); assert.equal(down.stdout, "");
    const empty = await run(STATUS, "", {}, [join(s.root, "projects", "p2")]);
    assert.equal(empty.status, 0); assert.equal(empty.stdout.trim(), "");
  });
});

describe("todo-stop.sh", { skip: !tools || !tmux }, () => {
  const stop = (env: Record<string, string>, input: Record<string, unknown> = {}) => run(STOP, JSON.stringify({ cwd: ws, ...input }), env);

  test("a session that holds an item is sent back once: done, release or ask, with the id; a session holding nothing is let go", async () => {
    const f = fakeClaude("idle", ws); sessions.push(f);
    await new Promise((r) => setTimeout(r, 300));
    const none = await stop({ TMUX_PANE: f.pane() });
    assert.equal(none.status, 0); assert.equal(none.stdout, "", "nothing held: no block");
    const it = await add("Port the settings page"); await patch(it.id, { root: ws, action: "claim", by: `tmux:${f.name}` });
    const r = await stop({ TMUX_PANE: f.pane() });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, new RegExp(`- \\[${it.id.slice(0, 8)}\\] Port the settings page`));
    assert.match(out.reason, /done_todo/); assert.match(out.reason, /release_todo/); assert.match(out.reason, /add_todo with for=owner/);
    // Someone else's item does not trap this session.
    const other = fakeClaude("idle", ws); sessions.push(other); await new Promise((r) => setTimeout(r, 300));
    assert.equal((await stop({ TMUX_PANE: other.pane() })).stdout, "");
  });

  test("never a loop, never a trap: stop_hook_active, outside tmux, an unreachable server all let the stop through", async () => {
    const f = fakeClaude("idle", ws); sessions.push(f); await new Promise((r) => setTimeout(r, 300));
    const it = await add("Held again"); await patch(it.id, { root: ws, action: "claim", by: `tmux:${f.name}` });
    assert.equal((await stop({ TMUX_PANE: f.pane() }, { stop_hook_active: true })).stdout, "", "it already blocked once this turn");
    assert.equal((await stop({ TMUX_PANE: "" })).stdout, "", "outside tmux");
    assert.equal((await stop({ TMUX_PANE: f.pane(), CODETERM_URL: "http://127.0.0.1:1" })).stdout, "", "server down");
    assert.equal((await run(STOP, "{}", { TMUX_PANE: f.pane() })).stdout, "", "no cwd");
  });
});
