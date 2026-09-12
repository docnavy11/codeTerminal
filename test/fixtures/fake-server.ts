/**
 * A real server with a scripted SDK, for the browser tests. Boots on $PORT
 * with its state under $ROOT, prints READY, and answers prompts itself:
 *   "approve-me"  → asks permission for a Bash command, replies with the decision
 *   "ask-me"      → asks a question, replies with the answer
 *   anything else → streams "You said: …" as deltas, then the text, then a result
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boot } from "../../src/server.js";
import { fakeSdk, type FakeQuery } from "../fakes/sdk.js";

const ROOT = process.env.ROOT!; const PORT = Number(process.env.PORT);
for (const d of ["ws", "chats", "files", "projects/p1", "home"]) mkdirSync(join(ROOT, d), { recursive: true });
for (const d of ["ws", "files"]) {
  writeFileSync(join(ROOT, d, "hello.txt"), "hello from the fixture\n");
  writeFileSync(join(ROOT, d, "note.txt"), "note\n");
  writeFileSync(join(ROOT, d, "blob.txt"), "x".repeat(300_000));
  writeFileSync(join(ROOT, d, "huge.bin"), Buffer.alloc(5 * 1024 * 1024));
}
writeFileSync(join(ROOT, "ws", "notes.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n");
mkdirSync(join(ROOT, "ws", "src", "lib"), { recursive: true }); mkdirSync(join(ROOT, "ws", "node_modules", "x"), { recursive: true });
writeFileSync(join(ROOT, "ws", "src", "index.ts"), ""); writeFileSync(join(ROOT, "ws", "src", "lib", "loader.ts"), ""); writeFileSync(join(ROOT, "ws", "node_modules", "x", "index.js"), "");

const inited = new WeakSet<FakeQuery>();
const turns = new WeakMap<FakeQuery, { n: number }>();
const turnsOf = (q: FakeQuery) => { let t = turns.get(q); if (!t) { t = { n: 0 }; turns.set(q, t); } return t; };
// Each turn re-sends a little more; 40k per turn against a 200k window → 20%, 40%, …
const usageFor = (q: FakeQuery) => ({ usage: { input_tokens: 100, cache_read_input_tokens: 40_000 * turnsOf(q).n - 100, output_tokens: 0 }, modelUsage: { "fake-model": { contextWindow: 200_000 } } });
const sdk = fakeSdk({ setup: (q) => { q.models = [{ value: "claude-opus-5", displayName: "Opus 5" }, { value: "claude-sonnet-5", displayName: "Sonnet 5" }]; }, onUser: (m, q) => {
  if (!inited.has(q)) { inited.add(q); q.init(`fake-${Date.now()}`); }
  const raw = m.message.content;
  const images = Array.isArray(raw) ? raw.filter((b) => (b as { type: string }).type === "image").length : 0;
  const content = Array.isArray(raw) ? raw.map((b) => (b as { type: string; text?: string }).text ?? "").join("\n") : String(raw);
  const said = content.split("\n").filter(Boolean).at(-1) ?? "";
  if (content.includes("approve-me")) {
    q.ask("Bash", { command: "rm -rf build" }).promise.then((r) => { q.text(`decision: ${r.behavior}`); q.result(); });
    return;
  }
  if (content.includes("stop-me")) {
    q.text("Working…"); q.result({ subtype: "error_max_turns", is_error: true, num_turns: 40, total_cost_usd: 0.001 * ++turnsOf(q).n, ...usageFor(q) });
    return;
  }
  if (content.includes("tools-me")) {
    // three tool calls with results, one of them failing, then a reply
    q.text("Let me look.");
    q.toolUse("t1", "Bash", { command: "git status --short" });
    q.toolResult("t1", " M src/a.ts\n?? notes.txt\n", { structured: { stdout: " M src/a.ts\n?? notes.txt\n", stderr: "", interrupted: false } });
    q.toolUse("t2", "Read", { file_path: "/repo/src/a.ts" });
    q.toolResult("t2", "line1\nline2\nline3", { structured: { type: "text", file: { filePath: "/repo/src/a.ts", numLines: 3, totalLines: 3 } } });
    q.toolUse("t3", "Bash", { command: "grep -c purchase missing.txt" });
    q.toolResult("t3", "grep: missing.txt: No such file or directory\nExit code 2", { is_error: true, structured: { stdout: "", stderr: "grep: missing.txt: No such file or directory", interrupted: false } });
    q.text("Two files changed; the grep target is missing."); q.result({ total_cost_usd: 0.001 * ++turnsOf(q).n, ...usageFor(q) });
    return;
  }
  if (content.includes("edit-me")) {
    q.ask("Edit", { file_path: join(ROOT, "ws", "notes.txt"), old_string: "two", new_string: "TWO\nand a half" }).promise.then((r) => { q.text(`decision: ${r.behavior}`); q.result(); });
    return;
  }
  if (content.includes("think-me")) {
    const note = "I've narrowed it to two candidates.\nNow verifying each against the repo.";
    let k = 0; const step = () => {
      if (k < note.length) { q.thinkingDelta(note.slice(k, k + 12)); k += 12; setTimeout(step, 20); }
      else { q.thinking(note); q.text("Verified: it is the second one."); q.result({ total_cost_usd: 0.001 * ++turnsOf(q).n, ...usageFor(q) }); }
    };
    step(); return;
  }
  if (content.includes("plan-me")) {
    q.ask("ExitPlanMode", { plan: "# Rename the widget\n\n## Steps\n1. Rename `Widget` to `Gadget` in `src/w.ts`\n2. Update the three call sites\n3. Run the tests", planFilePath: "/tmp/plan.md" })
      .promise.then((r) => { q.text(`decision: ${r.behavior}${(r as { updatedPermissions?: { mode?: string }[] }).updatedPermissions?.[0]?.mode ? ` · mode ${(r as { updatedPermissions: { mode: string }[] }).updatedPermissions[0].mode}` : ""}`); q.result(); });
    return;
  }
  if (content.includes("agent-me")) {
    q.text("Delegating the search.");
    q.toolUse("a1", "Agent", { description: "Collect invoice links", subagent_type: "general-purpose", prompt: "find them" });
    q.emit({ type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "a1", description: "Collect invoice links" });
    let n = 0; const step = () => {
      n++;
      q.toolUse(`s${n}`, "Grep", { pattern: "invoice" }, "a1"); q.toolResult(`s${n}`, `hit ${n}`, { parent: "a1" });
      q.emit({ type: "system", subtype: "task_progress", task_id: "task-1", tool_use_id: "a1", description: "Collect invoice links", usage: { total_tokens: 1000 * n, tool_uses: n, duration_ms: 1400 * n }, last_tool_name: "Grep" });
      if (n < 3) { setTimeout(step, 60); return; }
      q.subText("Found three links.", "a1");
      q.emit({ type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "a1", status: "completed", output_file: "/tmp/x", summary: "Three invoice links found.\n- a\n- b\n- c", usage: { total_tokens: 3000, tool_uses: 3, duration_ms: 4200 } });
      q.toolResult("a1", "Three invoice links found.");
      q.text("The subagent found three links."); q.result({ total_cost_usd: 0.001 * ++turnsOf(q).n, ...usageFor(q) });
    };
    setTimeout(step, 60); return;
  }
  if (content.includes("todo-me")) {
    q.toolUse("td1", "TodoWrite", { todos: [{ content: "Read the config", status: "completed", activeForm: "Reading the config" }, { content: "Patch the loader", status: "in_progress", activeForm: "Patching the loader" }, { content: "Run tests", status: "pending", activeForm: "Running tests" }] });
    q.toolResult("td1", "Todos have been modified successfully.");
    setTimeout(() => {
      q.toolUse("td2", "TodoWrite", { todos: [{ content: "Read the config", status: "completed", activeForm: "Reading the config" }, { content: "Patch the loader", status: "completed", activeForm: "Patching the loader" }, { content: "Run tests", status: "in_progress", activeForm: "Running tests" }] });
      q.toolResult("td2", "Todos have been modified successfully.");
      q.text("Two of three done."); q.result({ total_cost_usd: 0.001 * ++turnsOf(q).n, ...usageFor(q) });
    }, 150);
    return;
  }
  if (content.includes("ask-me")) {
    q.ask("AskUserQuestion", { questions: [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] })
      .promise.then((r) => { q.text(`answer: ${JSON.stringify((r as { updatedInput?: { answers?: unknown } }).updatedInput?.answers ?? null)}`); q.result(); });
    return;
  }
  const reply = `You said: ${said}${images ? ` (+${images} image${images === 1 ? "" : "s"})` : ""}`;
  const words = reply.split(" ");
  let i = 0;
  const tick = () => {
    if (i < words.length) { q.delta((i ? " " : "") + words[i++]); setTimeout(tick, 30); }
    else { q.text(reply); q.result({ total_cost_usd: 0.001 * ++turnsOf(q).n, ...usageFor(q) }); }   // a running total, like the SDK
  };
  tick();
} });

const running = await boot({
  host: "127.0.0.1", port: PORT, workspace: join(ROOT, "ws"), chatsDir: join(ROOT, "chats"),
  filesRoot: ROOT, projectsRoot: join(ROOT, "projects"),
  promptsPath: join(ROOT, "prompts.json"), usagePath: join(ROOT, "usage.json"),
  maxUpload: 1024 * 1024, maxZip: 4 * 1024 * 1024, extraOrigins: [], forceLocal: true, denyExtra: [], home: join(ROOT, "home"),
  spawnQuery: sdk.spawnQuery, titler: async () => null,
  // stdout carries only READY; everything else goes to stderr (the harness's log file)
  log: (l) => console.error(l), warn: (l) => console.error(l),
});
console.log(`READY ${running.port}`);
process.on("SIGTERM", () => { void running.shutdown("SIGTERM"); setTimeout(() => process.exit(0), 300); });
