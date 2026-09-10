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
writeFileSync(join(ROOT, "files", "hello.txt"), "hello from the fixture\n");
writeFileSync(join(ROOT, "files", "note.txt"), "note\n");
writeFileSync(join(ROOT, "files", "blob.txt"), "x".repeat(300_000));

const inited = new WeakSet<FakeQuery>();
const sdk = fakeSdk({ onUser: (m, q) => {
  if (!inited.has(q)) { inited.add(q); q.init(`fake-${Date.now()}`); }
  const content = String(m.message.content);
  const said = content.split("\n").filter(Boolean).at(-1) ?? "";
  if (content.includes("approve-me")) {
    q.ask("Bash", { command: "rm -rf build" }).promise.then((r) => { q.text(`decision: ${r.behavior}`); q.result(); });
    return;
  }
  if (content.includes("ask-me")) {
    q.ask("AskUserQuestion", { questions: [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] })
      .promise.then((r) => { q.text(`answer: ${JSON.stringify((r as { updatedInput?: { answers?: unknown } }).updatedInput?.answers ?? null)}`); q.result(); });
    return;
  }
  const reply = `You said: ${said}`;
  const words = reply.split(" ");
  let i = 0;
  const tick = () => {
    if (i < words.length) { q.delta((i ? " " : "") + words[i++]); setTimeout(tick, 30); }
    else { q.text(reply); q.result({ total_cost_usd: 0.001 }); }
  };
  tick();
} });

const running = await boot({
  host: "127.0.0.1", port: PORT, workspace: join(ROOT, "ws"), chatsDir: join(ROOT, "chats"),
  filesRoot: join(ROOT, "files"), projectsRoot: join(ROOT, "projects"),
  promptsPath: join(ROOT, "prompts.json"), usagePath: join(ROOT, "usage.json"),
  maxUpload: 1024 * 1024, maxZip: 4 * 1024 * 1024, extraOrigins: [], forceLocal: true, denyExtra: [], home: join(ROOT, "home"),
  spawnQuery: sdk.spawnQuery, titler: async () => null,
  // stdout carries only READY; everything else goes to stderr (the harness's log file)
  log: (l) => console.error(l), warn: (l) => console.error(l),
});
console.log(`READY ${running.port}`);
process.on("SIGTERM", () => { void running.shutdown("SIGTERM"); setTimeout(() => process.exit(0), 300); });
