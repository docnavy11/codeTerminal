import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type ChatRecord } from "../src/store.js";
import { toMarkdown, toolSummary, exportFilename } from "../src/export.js";
import { ChatSearch, snippet } from "../src/search.js";

const rec = (id: string, title: string, events: unknown[], updatedAt = 2): ChatRecord =>
  ({ id, title, createdAt: 1_700_000_000_000, updatedAt, sdkSessionId: null, cwd: "/w", project: "p1", events: events as never, granted: [], mode: "default" });

describe("toMarkdown", () => {
  test("renders the conversation, tool lines, notes, errors and per-turn cost; skips plumbing", () => {
    const md = toMarkdown(rec("a", "My chat", [
      { kind: "ready", sessionId: "s", model: "m", workspace: "/w", canBypass: false },
      { kind: "user", text: "hello\nthere", context: "active tab: T — https://t\nselected text:\nx" },
      { kind: "tool", id: "t1", name: "Bash", input: { command: "ls  -la" } },
      { kind: "tool", id: "t2", name: "Read", input: { file_path: "/x/y.ts" } },
      { kind: "tool", id: "t3", name: "mcp__browser__eval", input: { code: "a`b`" } },
      { kind: "tool_result", id: "t3", name: "mcp__browser__eval", ok: false, summary: "✗ ReferenceError", text: "ReferenceError: x", bytes: 17, truncated: false },
      { kind: "task", id: "tk", toolUseId: "t3", description: "dig", state: "running" },
      { kind: "task", id: "tk", toolUseId: "t3", description: "", state: "completed", toolUses: 4, summary: "All found.\ndetails" },
      { kind: "thinking", text: "first thought\nsecond thought" },
      { kind: "text", text: "Here **you** go." },
      { kind: "local", text: "Working directory is now /w" },
      { kind: "error", message: "boom" },
      { kind: "turn_end", costUsd: 0.5, sessionCostUsd: 0.5, isError: false, denials: 1 },
      { kind: "user", text: "again" },
      { kind: "turn_end", costUsd: 0.25, sessionCostUsd: 0.75, isError: true, denials: 0, stopped: "reached the turn limit" },
    ]), "Project One");
    assert.match(md, /^# My chat\n\n_2023-11-14 22:13 · Project One · \/w_\n/);
    assert.ok(md.includes("**You**\n\nhello\nthere\n\n> ⌁ active tab: T — https://t\n"));
    assert.ok(md.includes("- → `Bash` `ls -la`\n- → `Read` `/x/y.ts`\n- → `mcp__browser__eval` `{\"code\":\"a'b'\"}`\n  - ✗ ReferenceError\n  - ↳ agent completed · 4 tool uses — All found."));
    assert.ok(md.includes("> 💭 first thought\n> second thought\n\nHere **you** go."));
    assert.ok(md.includes("> Working directory is now /w"));
    assert.ok(md.includes("> ⚠ boom"));
    assert.ok(md.includes("_done · 1 denied · $0.5000 est._"));
    assert.ok(md.includes("_stopped: reached the turn limit · $0.7500 est._"));
    assert.ok(!md.includes("ready"), "session plumbing is not exported");
    assert.ok(!/\n{3,}/.test(md));
  });
  test("legacy running-total costs are not summed", () => {
    const md = toMarkdown(rec("a", "t", [{ kind: "turn_end", costUsd: 1.0, isError: false, denials: 0 }, { kind: "turn_end", costUsd: 1.5, isError: false, denials: 0 }]));
    assert.ok(md.includes("$1.5000 est."));
  });
  test("toolSummary and exportFilename", () => {
    assert.equal(toolSummary({ command: "x".repeat(200) }).length, 162);
    assert.equal(toolSummary(null), "");
    assert.equal(toolSummary({ pattern: "TODO", path: "/p" }), "`/p`");
    assert.equal(exportFilename(rec("a", "  Hello, World! — 2026/09  ", [])), "hello-world-2026-09.md");
    assert.equal(exportFilename(rec("a", "///", [])), "chat.md");
  });
});

describe("ChatSearch", () => {
  let root: string; let store: Store;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "ct-search-"));
    store = new Store(join(root, "chats"));
    store.write(rec("aaaaaaaa-0000-0000-0000-000000000001", "Deploy notes", [
      { kind: "user", text: "Why did the deploy fail last night?" },
      { kind: "text", text: "The container ran out of memory during the migration step." },
      { kind: "tool", id: "t", name: "Bash", input: { command: "grep MEMORY" } },
      { kind: "local", text: "Watch fired — memory alert" },
    ], 10));
    store.write(rec("aaaaaaaa-0000-0000-0000-000000000002", "Memory leak hunt", [{ kind: "user", text: "unrelated" }], 5));
    store.write(rec("aaaaaaaa-0000-0000-0000-000000000003", "Other", [{ kind: "text", text: "nothing here" }], 1));
  });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  test("matches text case-insensitively with event indices and snippets; tool inputs are not searched", () => {
    const s = new ChatSearch(store);
    const hits = s.search("MEMORY");
    assert.deepEqual(hits.map((h) => h.id.slice(-1)), ["1", "2"], "newest first, title-only match included");
    assert.deepEqual(hits[0].matches.map((m) => [m.i, m.kind]), [[1, "text"], [3, "local"]]);
    assert.match(hits[0].matches[0].snippet, /ran out of memory/);
    assert.equal(hits[0].titleMatch, false);
    assert.equal(hits[1].titleMatch, true); assert.equal(hits[1].matches.length, 0);
  });
  test("short queries and misses return nothing", () => {
    const s = new ChatSearch(store);
    assert.deepEqual(s.search("m"), []); assert.deepEqual(s.search("  "), []); assert.deepEqual(s.search("zebra"), []);
  });
  test("the index follows updatedAt; a live record is searched from memory", () => {
    const s = new ChatSearch(store);
    assert.equal(s.search("zebra").length, 0);
    store.write(rec("aaaaaaaa-0000-0000-0000-000000000003", "Other", [{ kind: "text", text: "a zebra" }], 11));
    assert.equal(s.search("zebra").length, 1, "re-read after the record changed");
    const live = rec("aaaaaaaa-0000-0000-0000-000000000003", "Other", [{ kind: "user", text: "giraffe unsaved" }], 11);
    assert.equal(s.search("giraffe", { live: (id) => id.endsWith("3") ? live : undefined }).length, 1);
    s.forget("aaaaaaaa-0000-0000-0000-000000000003");
    assert.equal(s.search("zebra").length, 1, "forget only drops the cache");
  });
  test("per-chat and total caps", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: "text", text: `needle ${i}` }));
    store.write(rec("aaaaaaaa-0000-0000-0000-000000000004", "Caps", many, 20));
    const s = new ChatSearch(store);
    assert.equal(s.search("needle")[0].matches.length, 5);
    assert.equal(s.search("needle", { perChat: 2 })[0].matches.length, 2);
    assert.equal(s.search("e", { maxChats: 1 }).length, 0, "still needs 2 chars");
    assert.equal(s.search("ee", { maxChats: 1 }).length <= 1, true);
  });
  test("snippet windows and ellipses", () => {
    const long = "x".repeat(100) + "needle" + "y".repeat(100);
    const sn = snippet(long, 100, 6);
    assert.ok(sn.startsWith("…") && sn.endsWith("…")); assert.equal(sn.length, 1 + 60 + 6 + 60 + 1);
    assert.equal(snippet("a needle b", 2, 6), "a needle b");
  });
});
