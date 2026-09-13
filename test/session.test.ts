import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Session, MAX_TOOL_CALLS, stoppedReason, contextOf, type ClientEvent, type SessionDeps } from "../src/session.js";
import { fakeSdk, settle, type FakeQuery } from "./fakes/sdk.js";

/**
 * The session against a scripted SDK: every event it emits, the approval
 * gate in both directions, the status machine, and the three ways the SDK
 * stream can stop — clean end, throw, and our own close().
 */
function make(mode: Parameters<Session["start"]>[2] = "default", resume?: string) {
  const sdk = fakeSdk();
  const events: ClientEvent[] = [];
  const deps: SessionDeps = { chatId: "chat-1", bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery };
  const s = new Session("/tmp/ws", (e) => events.push(e), deps);
  const done = s.start(resume, [], mode);
  const q = sdk.last;
  const kinds = () => events.map((e) => e.kind);
  const last = <K extends ClientEvent["kind"]>(k: K) => events.filter((e) => e.kind === k).at(-1) as Extract<ClientEvent, { kind: K }> | undefined;
  const statuses = () => events.filter((e): e is Extract<ClientEvent, { kind: "status" }> => e.kind === "status").map((e) => e.state + (e.detail ? ":" + e.detail : ""));
  return { s, q, events, done, kinds, last, statuses, sdk };
}

describe("Session.start", () => {
  test("hands the SDK the mode, the gate, the resume id and the workspace", async () => {
    const { q } = make("acceptEdits", "resume-123");
    assert.equal(q.options.permissionMode, "acceptEdits");
    assert.equal(q.options.resume, "resume-123");
    assert.equal(q.options.cwd, "/tmp/ws");
    assert.equal(typeof q.options.canUseTool, "function");
    assert.ok((q.options.allowedTools ?? []).includes("Read"));
    assert.ok(!(q.options.allowedTools ?? []).includes("WebFetch"), "WebFetch must go through the gate");
    assert.equal(q.options.allowDangerouslySkipPermissions, false);
  });

  test("clamps bypassPermissions to default when the deployment has not enabled it", async () => {
    const { q, s } = make("bypassPermissions");
    assert.equal(q.options.permissionMode, "default");
    assert.equal(s.mode, "default");
  });

  test("publishes the command list at once, hidden and internal ones removed, sorted", async () => {
    // commands are read the moment query() returns, so they are configured inside the fake's constructor
    const sdk = fakeSdk({ setup: (q) => { q.commands = [
      { name: "review", description: "", argumentHint: "" }, { name: "doctor", description: "", argumentHint: "" },
      { name: "__internal", description: "", argumentHint: "" }, { name: "clear", description: "", argumentHint: "" },
    ] as never; } });
    const events: ClientEvent[] = [];
    const s = new Session("/w", (e) => events.push(e), { chatId: "c", bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery });
    const p = s.start();
    await settle();
    const c = events.find((e) => e.kind === "commands") as Extract<ClientEvent, { kind: "commands" }>;
    assert.deepEqual(c.commands.map((x) => x.name), ["clear", "review"]);
    sdk.last.end(); await p;
  });

  test("an SDK without supportedCommands is not an error", async () => {
    const sdk = fakeSdk({ setup: (q) => { q.commandsError = new Error("unsupported"); } });
    const events: ClientEvent[] = [];
    const s = new Session("/w", (e) => events.push(e), { chatId: "c", bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery });
    const p = s.start();
    await settle();
    assert.ok(!events.some((e) => e.kind === "commands"));
    assert.ok(!events.some((e) => e.kind === "error"));
    sdk.last.end(); await p;
  });
});

describe("Session events", () => {
  let m: ReturnType<typeof make>;
  beforeEach(() => { m = make(); });

  test("init → ready, and the CLI's terminal-only commands are hidden from later lists", async () => {
    m.q.init("sid-9", { terminal_slash_commands: ["review"] });
    await settle();
    const r = m.last("ready")!;
    assert.equal(r.sessionId, "sid-9"); assert.equal(r.model, "fake-model"); assert.equal(r.workspace, "/tmp/ws"); assert.equal(r.canBypass, false);
    assert.equal(m.s.sdkSessionId, "sid-9");
    m.q.emit({ type: "system", subtype: "commands_changed", commands: [{ name: "review" }, { name: "x" }] });
    await settle();
    assert.deepEqual(m.last("commands")!.commands.map((c) => c.name), ["x"]);
  });

  test("a turn: send → thinking, delta, tool → tool status, tool_result, text, result → idle", async () => {
    m.s.send("hi");
    assert.equal(m.s.busy, true);
    assert.equal(m.statuses().at(-1), "thinking");
    m.q.delta("Hel"); m.q.delta("lo");
    m.q.toolUse("t1", "Bash", { command: "ls" });
    await settle();
    assert.deepEqual(m.kinds().filter((k) => k === "delta"), ["delta", "delta"]);
    const t = m.last("tool")!; assert.equal(t.name, "Bash"); assert.deepEqual(t.input, { command: "ls" });
    assert.equal(m.statuses().at(-1), "tool:Bash");
    m.q.toolUse("t2", "Read"); await settle();
    assert.equal(m.statuses().at(-1), "tool:2 tools");
    m.q.toolResult("t1"); m.q.toolResult("t2"); await settle();
    assert.equal(m.statuses().at(-1), "thinking");
    m.q.text("Hello"); m.q.result({ total_cost_usd: 0.5, permission_denials: [{}] }); await settle();
    assert.equal(m.last("text")!.text, "Hello");
    const end = m.last("turn_end")!; assert.equal(end.costUsd, 0.5); assert.equal(end.denials, 1); assert.equal(end.isError, false);
    assert.equal(m.s.busy, false);
    assert.equal(m.statuses().at(-1), "idle");
  });

  test("the SDK's running total becomes a per-turn cost, and the total rides along", async () => {
    m.q.result({ total_cost_usd: 1.0 }); m.q.result({ total_cost_usd: 1.5 }); m.q.result({ total_cost_usd: 1.5 }); await settle();
    const ends = m.events.filter((e): e is Extract<ClientEvent, { kind: "turn_end" }> => e.kind === "turn_end");
    assert.deepEqual(ends.map((e) => e.costUsd), [1.0, 0.5, 0]);
    assert.deepEqual(ends.map((e) => e.sessionCostUsd), [1.0, 1.5, 1.5]);
  });

  test("tool results carry the tool's name, a summary, the body and the subagent parent; orphans still emit", async () => {
    m.q.toolUse("t1", "Bash", { command: "ls" });
    m.q.toolResult("t1", "a.ts\nb.ts\n", { structured: { stdout: "a.ts\nb.ts\n", stderr: "" } });
    m.q.toolResult("never-called", "late", { is_error: true, parent: "agent-7" });
    await settle();
    const rs = m.events.filter((e): e is Extract<ClientEvent, { kind: "tool_result" }> => e.kind === "tool_result");
    assert.equal(rs.length, 2);
    assert.equal(rs[0].name, "Bash"); assert.equal(rs[0].summary, "a.ts"); assert.equal(rs[0].text, "a.ts\nb.ts\n"); assert.equal(rs[0].ok, true); assert.equal(rs[0].parent, null);
    assert.equal(rs[1].name, "tool"); assert.equal(rs[1].ok, false); assert.equal(rs[1].parent, "agent-7");
    assert.equal(m.statuses().at(-1), "idle", "the finished tool left the status");
  });

  test("thinking: deltas stream, the finished block is emitted capped, empty and redacted blocks are not", async () => {
    m.q.thinkingDelta("I'll che"); m.q.thinkingDelta("ck the repo.");
    m.q.thinking("I'll check the repo.");
    m.q.emit({ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "s" }] } });
    m.q.emit({ type: "assistant", message: { content: [{ type: "redacted_thinking", data: "opaque" }] } });
    m.q.thinking("y".repeat(5000));
    await settle();
    const deltas = m.events.filter((e): e is Extract<ClientEvent, { kind: "thinking_delta" }> => e.kind === "thinking_delta").map((e) => e.text);
    assert.deepEqual(deltas, ["I'll che", "ck the repo."]);
    const blocks = m.events.filter((e): e is Extract<ClientEvent, { kind: "thinking" }> => e.kind === "thinking");
    assert.equal(blocks.length, 2); assert.equal(blocks[0].text, "I'll check the repo."); assert.equal(blocks[1].text.length, 4096);
    assert.ok(!m.events.some((e) => e.kind === "error"));
  });

  test("subagents: task events from the three system messages, and their steps carry the parent", async () => {
    m.q.toolUse("a1", "Agent", { description: "dig", subagent_type: "general-purpose", prompt: "p" });
    m.q.emit({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "a1", description: "dig" });
    m.q.toolUse("s1", "Grep", { pattern: "x" }, "a1"); m.q.toolResult("s1", "hit", { parent: "a1" }); m.q.subText("found it", "a1");
    m.q.emit({ type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: "a1", description: "dig", usage: { total_tokens: 5, tool_uses: 1, duration_ms: 900 }, last_tool_name: "Grep" });
    m.q.emit({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "a1", status: "completed", output_file: "/o", summary: "done\nmore", usage: { total_tokens: 9, tool_uses: 2, duration_ms: 1900 } });
    await settle();
    const tasks = m.events.filter((e): e is Extract<ClientEvent, { kind: "task" }> => e.kind === "task");
    assert.deepEqual(tasks.map((t) => [t.state, t.toolUseId]), [["running", "a1"], ["completed", "a1"]]);
    assert.equal(tasks[1].summary, "done\nmore"); assert.equal(tasks[1].toolUses, 2);
    const prog = m.last("task_progress")!; assert.equal(prog.toolUses, 1); assert.equal(prog.lastTool, "Grep");
    const step = m.events.find((e) => e.kind === "tool" && (e as { name: string }).name === "Grep") as { parent?: string };
    assert.equal(step.parent, "a1");
    assert.equal((m.events.find((e) => e.kind === "text" && (e as { text: string }).text === "found it") as { parent?: string }).parent, "a1");
    assert.equal((m.last("tool_result") as { parent?: string }).parent, "a1");
    const main = m.events.find((e) => e.kind === "tool" && (e as { name: string }).name === "Agent") as { parent?: string };
    assert.equal(main.parent, undefined, "the main thread's own calls carry no parent");
  });

  test("a result without a cost reports null, an error result says so", async () => {
    m.q.result({ total_cost_usd: undefined, is_error: true }); await settle();
    const end = m.last("turn_end")!; assert.equal(end.costUsd, null); assert.equal(end.isError, true); assert.equal(end.denials, 0);
  });

  test("the prompt the SDK receives carries the context in a nonce-delimited untrusted block", async () => {
    m.s.send("summarise", "active tab: Evil — https://evil.example");
    await settle();
    const c = m.q.received[0].message.content as string;
    assert.match(c, /<untrusted-page-data-[a-z0-9]+/);
    assert.ok(c.includes("https://evil.example"));
    assert.ok(c.indexOf("summarise") > c.indexOf("</untrusted-page-data"), "the instruction follows the untrusted block");
  });

  test("status is not re-sent when nothing changed", async () => {
    m.q.emit({ type: "system", subtype: "status", status: "compacting" });
    m.q.emit({ type: "system", subtype: "status", status: "compacting" });
    await settle();
    assert.equal(m.statuses().filter((s) => s === "compacting").length, 1);
    m.q.emit({ type: "system", subtype: "status", status: "idle" }); await settle();
    assert.equal(m.statuses().at(-1), "idle");
  });

  test("thinking tokens ride on the status, coarsely", async () => {
    m.q.emit({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 });
    m.q.emit({ type: "system", subtype: "thinking_tokens", estimated_tokens: 90 });   // same 200-bucket: no new event
    m.q.emit({ type: "system", subtype: "thinking_tokens", estimated_tokens: 900 });
    await settle();
    const tokens = m.events.filter((e): e is Extract<ClientEvent, { kind: "status" }> => e.kind === "status").map((e) => e.tokens);
    assert.deepEqual(tokens, [50, 900]);
  });

  test("local command output and conversation_reset are forwarded", async () => {
    m.q.emit({ type: "system", subtype: "local_command_output", content: "ctx: 12k" });
    m.q.emit({ type: "conversation_reset", new_conversation_id: "sid-2" });
    await settle();
    assert.equal(m.last("local")!.text, "ctx: 12k");
    assert.equal(m.last("conversation_reset")!.newId, "sid-2");
    assert.equal(m.s.sdkSessionId, "sid-2");
  });

  test("an unknown SDK message type is ignored", async () => {
    m.q.emit({ type: "something_new", payload: 1 }); await settle();
    assert.ok(!m.events.some((e) => e.kind === "error"));
  });
});

describe("why a turn stopped, and what it costs in context", () => {
  test("stoppedReason: every result subtype gets words; success gets null", () => {
    assert.equal(stoppedReason({ subtype: "success" }), null);
    assert.equal(stoppedReason({}), null);
    assert.match(stoppedReason({ subtype: "error_max_turns", num_turns: 40 })!, /turn limit \(40 turns\)/);
    assert.match(stoppedReason({ subtype: "error_max_budget_usd" })!, /cost ceiling/);
    assert.match(stoppedReason({ subtype: "error_during_execution", errors: ["boom", "bang"] })!, /boom; bang/);
    assert.match(stoppedReason({ subtype: "error_during_execution" })!, /error during execution/);
    assert.match(stoppedReason({ subtype: "error_max_structured_output_retries" })!, /output format/);
    assert.equal(stoppedReason({ subtype: "error_new_kind" }), "error_new_kind");
  });

  test("contextOf: usage against the largest window; null without either", () => {
    assert.deepEqual(contextOf({ usage: { input_tokens: 10, cache_read_input_tokens: 90000, cache_creation_input_tokens: 5000, output_tokens: 900 },
      modelUsage: { "claude-haiku-4-5": { contextWindow: 200000 }, "claude-x": { contextWindow: 1000000 } } }), { tokens: 95910, window: 1000000 });
    assert.equal(contextOf({ usage: { input_tokens: 1 } }), null);
    assert.equal(contextOf({}), null);
  });

  test("a turn_end carries the stop reason and the context", async () => {
    const m = make();
    m.q.result({ subtype: "error_max_turns", is_error: true, num_turns: 3, usage: { input_tokens: 5, cache_read_input_tokens: 995, output_tokens: 100 }, modelUsage: { m: { contextWindow: 10000 } } });
    await settle();
    const e = m.last("turn_end")!;
    assert.match(e.stopped!, /turn limit/); assert.deepEqual(e.context, { tokens: 1100, window: 10000 }); assert.equal(e.isError, true);
    m.q.result(); await settle();
    assert.equal(m.last("turn_end")!.stopped, null);
  });

  test("API retries, refusals, policy denials and notifications are shown, low-priority notices are not", async () => {
    const m = make();
    m.q.emit({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529 });
    m.q.emit({ type: "system", subtype: "model_refusal_no_fallback", content: "I can't help with that", api_refusal_explanation: "policy" });
    m.q.emit({ type: "system", subtype: "permission_denied", tool_name: "WebFetch", tool_use_id: "t" });
    m.q.emit({ type: "system", subtype: "notification", key: "k", text: "Context is getting long", priority: "high" });
    m.q.emit({ type: "system", subtype: "notification", key: "k2", text: "trivia", priority: "low" });
    await settle();
    const locals = m.events.filter((e): e is Extract<ClientEvent, { kind: "local" }> => e.kind === "local").map((e) => e.text);
    assert.deepEqual(locals, ["API retry 2 of 10 in 4s (HTTP 529)", "WebFetch was denied by policy (settings), not by you", "Context is getting long"]);
    assert.match(m.last("error")!.message, /refused this request: policy — I can't help with that/);
  });

  test("a turn that keeps calling tools is interrupted once and told so", async () => {
    const m = make();
    m.s.send("go");
    for (let i = 0; i < MAX_TOOL_CALLS + 5; i++) m.q.toolUse(`t${i}`, "Read");
    await settle(4);
    assert.equal(m.q.interrupts, 1);
    const errs = m.events.filter((e) => e.kind === "error") as { message: string }[];
    assert.equal(errs.length, 1); assert.match(errs[0].message, /tool calls in one turn/);
    m.q.result(); await settle();
    m.s.send("again");
    for (let i = 0; i < 3; i++) m.q.toolUse(`u${i}`, "Read");
    await settle(4);
    assert.equal(m.q.interrupts, 1, "the counter resets per turn");
  });
});

describe("the approval gate", () => {
  let m: ReturnType<typeof make>;
  beforeEach(() => { m = make(); });

  test("allow", async () => {
    const { promise } = m.q.ask("Bash", { command: "rm -rf x" }, [{ type: "addRules" } as never]);
    const a = m.last("approval")!;
    assert.equal(a.tool, "Bash"); assert.deepEqual(a.input, { command: "rm -rf x" }); assert.equal(a.canAlways, true);
    assert.equal(m.statuses().at(-1), "awaiting:Bash");
    assert.equal(m.s.decide(a.id, "allow"), true);
    assert.deepEqual(await promise, { behavior: "allow" });
    assert.equal(m.last("approval_closed")!.decision, "allow");
    assert.equal(m.statuses().at(-1), "idle");
  });

  test("always: the suggestions are granted and remembered for resume", async () => {
    const sugg = [{ type: "addRules", rules: [{ toolName: "Bash" }] }] as never[];
    const { promise } = m.q.ask("Bash", {}, sugg);
    m.s.decide(m.last("approval")!.id, "always");
    const r = await promise as { behavior: string; updatedPermissions?: unknown };
    assert.equal(r.behavior, "allow"); assert.deepEqual(r.updatedPermissions, sugg);
    assert.deepEqual(m.s.granted, sugg);
  });

  test("deny tells the model not to retry", async () => {
    const { promise } = m.q.ask("WebFetch");   // not Edit/Write: those cards wait for the file read
    m.s.decide(m.last("approval")!.id, "deny");
    const r = await promise as { behavior: string; message: string };
    assert.equal(r.behavior, "deny"); assert.match(r.message, /denied WebFetch/);
  });

  test("no 'always' when the SDK offered no suggestions", () => {
    m.q.ask("Bash");
    assert.equal(m.last("approval")!.canAlways, false);
  });

  test("a decision for an unknown id, or a second decision, is refused", () => {
    m.q.ask("Bash");
    const id = m.last("approval")!.id;
    assert.equal(m.s.decide("nope", "allow"), false);
    assert.equal(m.s.decide(id, "allow"), true);
    assert.equal(m.s.decide(id, "allow"), false);
  });

  test("the SDK aborting the ask closes the card as 'gone' and denies", async () => {
    const { promise, abort } = m.q.ask("Bash");
    abort();
    const r = await promise as { behavior: string; message: string };
    assert.equal(r.behavior, "deny"); assert.match(r.message, /Interrupted/);
    assert.equal(m.last("approval_closed")!.decision, "gone");
    assert.equal(m.statuses().at(-1), "idle");
    assert.equal(m.s.decide(m.last("approval")!.id, "allow"), false, "nothing left to decide");
  });

  test("an abort after the user already decided changes nothing", async () => {
    const { promise, abort } = m.q.ask("Bash");
    m.s.decide(m.last("approval")!.id, "allow");
    abort();
    assert.deepEqual(await promise, { behavior: "allow" });
    assert.equal(m.kinds().filter((k) => k === "approval_closed").length, 1);
  });

  test("several pending: the status counts them", () => {
    m.q.ask("Bash"); m.q.ask("WebFetch");
    assert.equal(m.statuses().at(-1), "awaiting:2 things");
  });

  test("AskUserQuestion is a question, answered by question text", async () => {
    const questions = [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "" }] }];
    const { promise } = m.q.ask("AskUserQuestion", { questions });
    const qev = m.last("question")!;
    assert.deepEqual(qev.questions, questions);
    assert.equal(m.statuses().at(-1), "awaiting:a question");
    assert.ok(!m.events.some((e) => e.kind === "approval"), "a question is not an approval card");
    assert.equal(m.s.answer(qev.id, { "Which?": "A" }), true);
    const r = await promise as { behavior: string; updatedInput: { answers: unknown; questions: unknown } };
    assert.equal(r.behavior, "allow"); assert.deepEqual(r.updatedInput.answers, { "Which?": "A" }); assert.deepEqual(r.updatedInput.questions, questions);
    assert.equal(m.last("approval_closed")!.decision, "allow");
  });

  test("an Edit approval carries the diff; a withdrawn request never shows a card", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "ct-sess-diff-")); await writeFile(join(dir, "f.txt"), "a\nb\nc\n");
    const sdk = fakeSdk(); const events: ClientEvent[] = [];
    const s = new Session(dir, (e) => events.push(e), { chatId: "c", bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery });
    const done = s.start();
    const { promise } = sdk.last.ask("Edit", { file_path: join(dir, "f.txt"), old_string: "b", new_string: "B" });
    await new Promise((r) => setTimeout(r, 50));
    const card = events.find((e) => e.kind === "approval") as Extract<ClientEvent, { kind: "approval" }>;
    assert.ok(card, "the card arrives once the file was read");
    assert.equal(card.diff!.path, "f.txt"); assert.equal(card.diff!.adds, 1); assert.equal(card.diff!.dels, 1);
    s.decide(card.id, "allow"); await promise;
    // withdrawn before the read finished: no card
    const w = sdk.last.ask("Write", { file_path: join(dir, "g.txt"), content: "x" }); w.abort();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(events.filter((e) => e.kind === "approval").length, 1);
    s.close(); await done;
  });

  test("approving a plan with a mode: setMode update to the CLI, the session switches, the model is told a denial means 'revise'", async () => {
    const { promise } = m.q.ask("ExitPlanMode", { plan: "# do things" });
    const card = m.last("approval")!;
    assert.equal(m.s.decide(card.id, "allow", "acceptEdits"), true);
    const r = await promise as { behavior: string; updatedPermissions?: { type: string; mode?: string; destination?: string }[] };
    assert.deepEqual(r.updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
    await settle();
    assert.equal(m.s.mode, "acceptEdits"); assert.deepEqual(m.q.modes, ["acceptEdits"]); assert.equal(m.last("mode")!.mode, "acceptEdits");
    const { promise: p2 } = m.q.ask("ExitPlanMode", { plan: "# v2" });
    m.s.decide(m.last("approval")!.id, "deny");
    assert.match(((await p2) as { message: string }).message, /revised/);
    const { promise: p3 } = m.q.ask("Bash", { command: "ls" });
    m.s.decide(m.last("approval")!.id, "allow", "default");   // a mode on an ordinary tool is passed along too, harmlessly
    assert.deepEqual(((await p3) as { updatedPermissions: unknown[] }).updatedPermissions, [{ type: "setMode", mode: "default", destination: "session" }]);
  });

  test("EnterPlanMode's result switches the mode shown to plan", async () => {
    m.q.toolUse("e1", "EnterPlanMode", {}); m.q.toolResult("e1", "Entered plan mode. You should now focus on exploring…"); await settle();
    assert.equal(m.s.mode, "plan"); assert.equal(m.last("mode")!.mode, "plan");
    m.q.toolUse("e2", "EnterPlanMode", {}); m.q.toolResult("e2", "already", { is_error: true }); await settle();
    assert.equal(m.events.filter((e) => e.kind === "mode").length, 1, "a failed enter changes nothing");
  });

  test("answer() on a plain approval, or an unknown id, is refused", () => {
    m.q.ask("Bash");
    assert.equal(m.s.answer(m.last("approval")!.id, { x: "y" }), false);
    assert.equal(m.s.answer("nope", {}), false);
  });
});

describe("Session rewind", () => {
  test("every sent message carries a uuid the CLI can rewind to; checkpointing is on; dry run, real, and failure", async () => {
    const m = make();
    assert.equal(m.q.options.enableFileCheckpointing, true);
    const uuid = m.s.send("change things"); await settle();
    assert.match(uuid, /^[0-9a-f-]{36}$/); assert.equal((m.q.received[0] as { uuid?: string }).uuid, uuid);
    m.q.rewindResult = { canRewind: true, filesChanged: ["a.ts"], insertions: 2, deletions: 5 };
    await m.s.rewindFiles(uuid, true);
    let r = m.last("rewind")!; assert.deepEqual([r.dryRun, r.canRewind, r.files, r.insertions, r.deletions], [true, true, ["a.ts"], 2, 5]);
    await m.s.rewindFiles(uuid, false);
    r = m.last("rewind")!; assert.equal(r.dryRun, false); assert.deepEqual(m.q.rewinds, [{ uuid, dryRun: true }, { uuid, dryRun: false }]);
    m.q.rewindResult = { canRewind: false, error: "no checkpoint" };
    await m.s.rewindFiles(uuid, true);
    r = m.last("rewind")!; assert.equal(r.canRewind, false); assert.equal(r.error, "no checkpoint"); assert.deepEqual(r.files, []);
    m.q.rewindError = new Error("cli too old");
    await m.s.rewindFiles(uuid, true);
    assert.equal(m.last("rewind")!.error, "cli too old");
  });
});

describe("browser site gate through the session", () => {
  test("a new site puts a card in front of the user; allow is this chat, always is the standing list; deny fails the tool", async () => {
    const { mkdtemp } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
    const { BrowserAllowlist } = await import("../src/browser-allow.js");
    const { BrowserBridge } = await import("../src/browser.js");
    const { FakeWs } = await import("./fakes/ws.js");
    const allow = new BrowserAllowlist(join(await mkdtemp(join(tmpdir(), "ct-gate-")), "allow.json"));
    // a fake extension answering the bridge
    const bridge = new BrowserBridge(() => {}, 500);
    const ext = new FakeWs();
    const origSend = ext.send.bind(ext);
    ext.send = (data: string | Buffer) => { origSend(data); const msg = JSON.parse(String(data)); if (!msg.id) return; setImmediate(() => ext.frame({ id: msg.id, ok: true, result: msg.action === "tab_url" ? { tabId: 1, url: "https://bank.example/acct" } : { text: "balance is 1,250.00 EUR today", chars: 29 } })); };
    bridge.attach(ext as never); ext.frame({ type: "hello", instance: "b" });
    const sdk = fakeSdk(); const events: ClientEvent[] = [];
    const s = new Session("/w", (e) => events.push(e), { chatId: "c", bridge, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery, browserAllow: allow });
    const done = s.start();
    type Reg = Record<string, { callback?: Function; handler?: Function }>;
    const callTool = (reg: Reg, name: string, args: Record<string, unknown>) => (reg[name].callback ?? reg[name].handler)!(args, {}) as Promise<{ content: { text: string }[] }>;
    const tools = (sdk.last.options.mcpServers as Record<string, { instance: { _registeredTools: Reg } }>).browser.instance._registeredTools;
    const read = () => callTool(tools, "read_page", { tabId: 1 });
    // 1. asks
    let p = read(); await settle(6);
    let card = events.filter((e) => e.kind === "approval").at(-1) as Extract<ClientEvent, { kind: "approval" }>;
    assert.equal(card.tool, "browser"); assert.deepEqual(card.input, { host: "bank.example", action: "read_page" }); assert.equal(card.canAlways, true);
    assert.equal(s.status().detail, "browser");
    s.decide(card.id, "deny");
    await assert.rejects(p, /bank\.example: the user did not allow it/);
    // 2. allow for this chat: no card the second time, nothing on the standing list
    p = read(); await settle(6);
    card = events.filter((e) => e.kind === "approval").at(-1) as typeof card; s.decide(card.id, "allow");
    assert.match((await p).content[0].text, /balance/);
    assert.match((await read()).content[0].text, /balance/); assert.equal(events.filter((e) => e.kind === "approval").length, 2);
    assert.deepEqual(allow.all(), []);
    // 3. always: standing list
    const s2 = new Session("/w", (e) => events.push(e), { chatId: "c2", bridge, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery, browserAllow: allow });
    const done2 = s2.start();
    const tools2 = (sdk.last.options.mcpServers as Record<string, { instance: { _registeredTools: Reg } }>).browser.instance._registeredTools;
    p = callTool(tools2, "read_page", { tabId: 1 }); await settle(6);
    card = events.filter((e) => e.kind === "approval").at(-1) as typeof card; s2.decide(card.id, "always");
    await p; assert.deepEqual(allow.all(), ["bank.example"]);
    // 4. eval on an allowed site still asks; "always" grants eval for this chat only
    p = callTool(tools2, "eval", { tabId: 1, code: "document.title" }); await settle(6);
    card = events.filter((e) => e.kind === "approval").at(-1) as typeof card;
    assert.deepEqual(card.input, { host: "bank.example", action: "eval", detail: "document.title" });
    s2.decide(card.id, "always"); await p;
    await callTool(tools2, "eval", { tabId: 1, code: "1+1" }); assert.equal(events.filter((e) => e.kind === "approval").length, 4, "no further eval card this chat");
    assert.deepEqual(allow.all(), ["bank.example"], "eval never lands on the standing list");
    s.close(); s2.close(); await done; await done2;
  });
});

describe("Session.setModel", () => {
  test("the CLI's models are published at start; a switch is applied, announced and remembered; failure keeps the old one", async () => {
    const sdk = fakeSdk({ setup: (q) => { q.models = [{ value: "claude-opus-5", displayName: "Opus 5" }]; } });
    const events: ClientEvent[] = [];
    const s = new Session("/w", (e) => events.push(e), { chatId: "c", bridge: null, getShell: () => null, watches: null, prompts: null, prefer: () => undefined, spawnQuery: sdk.spawnQuery });
    const done = s.start(undefined, [], "default", "claude-sonnet-5");
    assert.equal(sdk.last.options.model, "claude-sonnet-5", "the launch option carries the chat's model");
    await settle();
    assert.deepEqual((events.find((e) => e.kind === "models") as { models: unknown }).models, [{ value: "claude-opus-5", label: "Opus 5" }]);
    await s.setModel("claude-opus-5");
    assert.deepEqual(sdk.last.modelCalls, ["claude-opus-5"]); assert.equal(s.model, "claude-opus-5");
    assert.equal((events.filter((e) => e.kind === "model").at(-1) as { model: string }).model, "claude-opus-5");
    await s.setModel("");
    assert.deepEqual(sdk.last.modelCalls, ["claude-opus-5", undefined]); assert.equal(s.model, null);
    sdk.last.setModelError = new Error("unknown model");
    await s.setModel("claude-nope");
    assert.match((events.filter((e) => e.kind === "error").at(-1) as { message: string }).message, /Could not switch model: unknown model/);
    assert.equal((events.filter((e) => e.kind === "model").at(-1) as { model: string | null }).model, null, "snapped back");
    s.close(); await done;
  });
});

describe("Session.setMode", () => {
  test("a mode the SDK accepts is applied and announced", async () => {
    const m = make();
    await m.s.setMode("acceptEdits");
    assert.deepEqual(m.q.modes, ["acceptEdits"]);
    assert.equal(m.s.mode, "acceptEdits");
    assert.equal(m.last("mode")!.mode, "acceptEdits");
  });

  test("bypassPermissions is refused when not enabled: error, mode snapped back, SDK untouched", async () => {
    const m = make();
    await m.s.setMode("bypassPermissions");
    assert.deepEqual(m.q.modes, []);
    assert.match(m.last("error")!.message, /Never ask/);
    assert.equal(m.last("mode")!.mode, "default");
    assert.equal(m.s.mode, "default");
  });

  test("an SDK that rejects the change: error, previous mode re-announced", async () => {
    const m = make();
    await m.s.setMode("acceptEdits");
    m.q.setModeError = new Error("cli too old");
    await m.s.setMode("plan");
    assert.equal(m.last("error")!.message, "cli too old");
    assert.equal(m.last("mode")!.mode, "acceptEdits");
    assert.equal(m.s.mode, "acceptEdits");
  });
});

describe("when the SDK stream stops", () => {
  test("a clean end marks the session dead, frees busy, denies pending, reports once", async () => {
    const m = make();
    m.s.send("go");
    const { promise } = m.q.ask("Bash");
    m.q.end();
    await m.done;
    assert.equal(m.s.dead, true);
    assert.equal(m.s.busy, false);
    const r = await promise as { behavior: string; message: string };
    assert.equal(r.behavior, "deny"); assert.equal(r.message, "Session ended.");
    assert.equal(m.last("approval_closed")!.decision, "gone");
    const errs = m.events.filter((e) => e.kind === "error");
    assert.equal(errs.length, 1);
    assert.match((errs[0] as { message: string }).message, /restarts on your next message/);
    assert.equal(m.statuses().at(-1), "idle");
  });

  test("a throw carries the cause and also marks dead", async () => {
    const m = make();
    m.q.fail(new Error("terminated by signal SIGKILL"));
    await m.done;
    assert.equal(m.s.dead, true);
    const errs = m.events.filter((e) => e.kind === "error") as { message: string }[];
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /SIGKILL/);
    assert.match(errs[0].message, /restarts/);
  });

  test("a send() after death is not delivered anywhere (the caller must respawn)", async () => {
    const m = make();
    m.q.end(); await m.done;
    m.s.send("lost?");
    await settle();
    assert.equal(m.q.received.length, 0);
    assert.equal(m.s.dead, true);
  });

  test("close(): no error is reported, pending is denied, a running turn is interrupted", async () => {
    const m = make();
    m.s.send("long task");
    const { promise } = m.q.ask("Bash");
    m.s.close();
    await m.done;
    const r = await promise as { behavior: string; message: string };
    assert.equal(r.message, "Session closed.");
    assert.equal(m.q.interrupts, 1);
    assert.ok(!m.events.some((e) => e.kind === "error"), "our own close is not an unexpected end");
    assert.equal(m.s.dead, true);
  });

  test("close() on an idle session does not interrupt", async () => {
    const m = make();
    m.s.close(); await m.done;
    assert.equal(m.q.interrupts, 0);
  });

  test("close() twice is harmless", async () => {
    const m = make();
    m.s.close(); m.s.close(); await m.done;
    assert.equal(m.s.dead, true);
  });
});
