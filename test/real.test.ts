import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";
import { startTestServer, type TestServer } from "./fakes/server.js";

/**
 * The TUI-gap features against the REAL SDK and the Claude Code login on
 * this machine — the things the fake cannot vouch for: that the CLI lists
 * models and switches, keeps checkpoints and restores a file, sends a plan
 * card and takes the setMode update, reads an image, runs a subagent with
 * task_* messages, and what it does with "@path".
 *
 * Opt-in, costs real turns (measured 2026-09-12: 7 turns, $0.30):
 *   CODETERM_REAL=1 npm run test:real
 * Each turn is bounded; the whole suite has a cost ceiling via maxBudgetUsd.
 */
const RUN = process.env.CODETERM_REAL === "1";
const TURN_MS = 240_000;

let s: TestServer;
let ws: Awaited<ReturnType<TestServer["socket"]>>;
const turn = async (text: string, extra: Record<string, unknown> = {}) => {
  const from = ws.got.length;
  ws.send({ type: "prompt", text, withTab: false, ...extra });
  await ws.wait((m) => m.kind === "turn_end" && ws.got.indexOf(m) >= from, TURN_MS);
  const slice = ws.got.slice(from);
  return { slice, text: slice.filter((m) => m.kind === "text").map((m) => m.text).join("\n"), tools: slice.filter((m) => m.kind === "tool").map((m) => m.name as string) };
};
const setMode = async (mode: string) => { const from = ws.got.length; ws.send({ type: "mode", mode }); await ws.wait((m) => m.kind === "mode" && ws.got.indexOf(m) >= from, 10_000); };

before(async () => {
  if (!RUN) return;
  s = await startTestServer({ real: true, cfg: { maxUpload: 8 * 1024 * 1024 } });
  writeFileSync(join(s.root, "ws", "notes.txt"), "alpha line\nbeta line\n");
  ws = await s.socket("/ws");
  await ws.wait((m) => m.kind === "replayed");
});
after(async () => { if (RUN) { ws.ws.close(); await ws.closed; await s.stop(); } });

describe("real SDK", { skip: !RUN && "set CODETERM_REAL=1 (needs a Claude Code login; costs real turns)" }, () => {
  test("every in-process MCP server comes up connected (the 2026-09-13 outage would fail here)", async () => {
    // the first session start of this run: its ready event is already in the socket's log
    const ready = ws.got.find((m) => m.kind === "ready") as { servers?: { name: string; status: string }[] } | undefined
      ?? await ws.wait((m) => m.kind === "ready", TURN_MS) as { servers?: { name: string; status: string }[] };
    assert.ok(ready?.servers?.length, "the init carries mcp_servers");
    for (const sv of ready!.servers!) assert.equal(sv.status, "connected", `${sv.name}: ${sv.status}`);
    assert.ok(ready!.servers!.some((sv) => sv.name === "browser"), "the browser server is registered");
  });

  test("the CLI lists models and a switch takes effect on the next session start", async () => {
    const models = (await ws.wait((m) => m.kind === "models", 20_000)).models as { value: string }[];
    assert.ok(models.length >= 2, `models: ${JSON.stringify(models)}`);
    const pick = models.find((m) => /sonnet|haiku/i.test(m.value))?.value ?? models[1].value;
    const from = ws.got.length; ws.send({ type: "model", model: pick });
    const ans = await ws.wait((m) => (m.kind === "model" || m.kind === "error") && ws.got.indexOf(m) >= from, 20_000);
    assert.equal(ans.kind, "model"); assert.equal(ans.model, pick);
    await setMode("acceptEdits");
    const t = await turn("Reply with exactly the word OK and nothing else.");
    assert.match(t.text, /OK/);
    const ready = t.slice.find((m) => m.kind === "ready") as { model: string } | undefined;
    assert.ok(ready?.model, "ready carries the model"); assert.ok(!/default/.test(ready!.model));
  });

  test("checkpoints: an agent edit is previewed and restored byte-for-byte", async () => {
    const t = await turn("Use the Edit tool to append the line 'changed by agent' at the end of notes.txt in the current directory. Then reply with exactly: done");
    assert.ok(t.tools.includes("Edit"), `tools: ${t.tools}`);
    assert.ok(readFileSync(join(s.root, "ws", "notes.txt"), "utf8").includes("changed by agent"));
    const results = t.slice.filter((m) => m.kind === "tool_result").map((m) => `${m.name}: ${m.summary}`);
    assert.ok(results.some((r) => /^Edit: edited notes\.txt · \+1 −0/.test(r)), results.join(" | "));
    const uuid = (t.slice.find((m) => m.kind === "user") as { uuid?: string }).uuid!;
    assert.match(uuid, /^[0-9a-f-]{36}$/);
    let from = ws.got.length; ws.send({ type: "rewind", uuid, dryRun: true });
    const dry = await ws.wait((m) => m.kind === "rewind" && ws.got.indexOf(m) >= from, 30_000);
    assert.equal(dry.canRewind, true, dry.error as string); assert.ok((dry.files as string[]).some((f) => f.endsWith("notes.txt")));
    from = ws.got.length; ws.send({ type: "rewind", uuid, dryRun: false });
    const real = await ws.wait((m) => m.kind === "rewind" && ws.got.indexOf(m) >= from, 30_000);
    assert.equal(real.canRewind, true, real.error as string);
    assert.equal(readFileSync(join(s.root, "ws", "notes.txt"), "utf8"), "alpha line\nbeta line\n");
    const note = await ws.wait((m) => m.kind === "local" && /Rewound/.test(m.text as string) && ws.got.indexOf(m) >= from, 5_000);
    assert.match(note.text as string, /Rewound 1 file to before/);
  });

  test("plan mode: a real plan card, and approving with auto-accept switches the mode", async () => {
    await setMode("plan");
    const from = ws.got.length;
    ws.send({ type: "prompt", text: "Plan how to add a one-line README.md to this folder. Keep the plan to two bullet points. Then call ExitPlanMode.", withTab: false });
    const card = await ws.wait((m) => ((m.kind === "approval" && m.tool === "ExitPlanMode") || m.kind === "turn_end") && ws.got.indexOf(m) >= from, TURN_MS);
    assert.equal(card.kind, "approval", "the model must ask to leave plan mode");
    assert.ok(typeof (card.input as { plan?: string }).plan === "string" && (card.input as { plan: string }).plan.length > 20);
    const at = ws.got.length;
    ws.send({ type: "decision", id: card.id, decision: "allow", mode: "acceptEdits" });
    await ws.wait((m) => m.kind === "turn_end" && ws.got.indexOf(m) >= at, TURN_MS);
    assert.ok(ws.got.slice(at).some((m) => m.kind === "mode" && m.mode === "acceptEdits"), "mode followed the approval");
  });

  test("an image in the prompt is seen", async () => {
    await setMode("acceptEdits");
    const t = await turn("What colour is the attached image? Answer with one word.", { images: [{ media_type: "image/png", data: redPng(), thumb: redPng() }] });
    assert.match(t.text, /red/i);
    assert.equal(((t.slice.find((m) => m.kind === "user") as { images?: unknown[] }).images ?? []).length, 1, "thumbnail recorded");
  });

  test("a subagent: task events, its steps nested under the call", async () => {
    const t = await turn("Use the Agent tool (subagent_type general-purpose) to count the lines in notes.txt in the current directory and report the number. Do not count them yourself; delegate. Then reply with the number only.");
    assert.ok(t.tools.includes("Agent"), `tools: ${t.tools}`);
    const tasks = t.slice.filter((m) => m.kind === "task").map((m) => m.state);
    assert.deepEqual(tasks.slice(0, 1), ["running"]); assert.ok(tasks.includes("completed"), `tasks: ${tasks}`);
    assert.ok(t.slice.some((m) => (m.kind === "tool" || m.kind === "text") && m.parent), "the subagent's activity carries the parent");
    assert.match(t.text, /2/);
  });

  test("@path is not expanded by the CLI in SDK mode: the model reads the file itself", async () => {
    const t = await turn("@notes.txt — what is on its first line? Answer with that line only.");
    assert.match(t.text, /alpha line/);
    assert.ok(t.tools.includes("Read"), `expected a Read call, got: ${t.tools}`);
  });
});

function redPng(): string {
  const w = 32, h = 32, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30; } }
  const crc = (buf: Buffer) => { let c = ~0; for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
