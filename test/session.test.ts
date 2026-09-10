import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Session, type ClientEvent, type SessionDeps } from "../src/session.js";
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
    const { promise } = m.q.ask("Write");
    m.s.decide(m.last("approval")!.id, "deny");
    const r = await promise as { behavior: string; message: string };
    assert.equal(r.behavior, "deny"); assert.match(r.message, /denied Write/);
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
    m.q.ask("Bash"); m.q.ask("Write");
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

  test("answer() on a plain approval, or an unknown id, is refused", () => {
    m.q.ask("Bash");
    assert.equal(m.s.answer(m.last("approval")!.id, { x: "y" }), false);
    assert.equal(m.s.answer("nope", {}), false);
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
