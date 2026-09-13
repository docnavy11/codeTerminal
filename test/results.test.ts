import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { whereOf, summariseResult, RESULT_TEXT_CAP } from "../src/results.js";

/** One line per tool, from the design's table — and the edge cases listed there. */
const r = (name: string, content: unknown, structured?: unknown, is_error = false) =>
  summariseResult(name, { tool_use_id: "t", content, is_error }, structured);

describe("summariseResult", () => {
  test("Bash: first stdout line, no output, interrupted, error", () => {
    assert.equal(r("Bash", "3\n", { stdout: "3\n", stderr: "" }).summary, "3");
    assert.equal(r("Bash", "", { stdout: "", stderr: "" }).summary, "(no output)");
    assert.equal(r("Bash", "", { stdout: "", noOutputExpected: true }).summary, "(no output expected)");
    assert.equal(r("Bash", "", { stdout: "", interrupted: true }).summary, "interrupted");
    assert.equal(r("Bash", "", { stdout: "", interrupted: true }).interrupted, true);
    const e = r("Bash", "grep: x: No such file or directory\nExit code 2", { stdout: "", stderr: "grep: x: No such file" }, true);
    assert.equal(e.ok, false); assert.equal(e.summary, "✗ grep: x: No such file or directory");
    assert.equal(r("Bash", "\x1b[31mred\x1b[0m line\n", { stdout: "\x1b[31mred\x1b[0m line\n" }).summary, "red line", "ANSI stripped");
    assert.equal(r("Bash", "\x1b[31mred\x1b[0m\n").text, "red\n", "body stripped too");
  });

  test("Read: lines, partial reads, images", () => {
    assert.equal(r("Read", "a\nb\nc", { type: "text", file: { numLines: 3, totalLines: 3 } }).summary, "3 lines");
    assert.equal(r("Read", "a\nb", { type: "text", file: { numLines: 120, totalLines: 900, startLine: 1 } }).summary, "120 lines (of 900)");
    assert.equal(r("Read", [{ type: "image", source: {} }], { type: "image" }).summary, "image");
    assert.equal(r("Read", "a\nb\nc\nd").summary, "4 lines", "no structured output: count the text");
  });

  test("Write and Edit", () => {
    assert.equal(r("Write", "ok", { type: "create", filePath: "/x/y/z.ts", content: "a\nb\nc\n" }).summary, "wrote z.ts · 3 lines");
    assert.equal(r("Edit", "ok", { type: "update", filePath: "/x/y/z.ts", structuredPatch: [{ lines: ["-old", "+new", "+more", " same"] }] }).summary, "edited z.ts · +2 −1");
    assert.equal(r("Edit", "ok", {}).summary, "edited file");
  });

  test("Grep and Glob", () => {
    assert.equal(r("Grep", "No matches found").summary, "no matches");
    assert.equal(r("Grep", "").summary, "no matches");
    assert.equal(r("Grep", "Found 8 files\na\nb").summary, "Found 8 files");
    assert.equal(r("Grep", "a.ts:1:x\nb.ts:2:y\n").summary, "2 lines");
    assert.equal(r("Glob", "/a\n/b\n/c").summary, "3 files");
    assert.equal(r("Glob", "No files found").summary, "no files");
  });

  test("browser and terminal tools read their own JSON", () => {
    assert.equal(r("mcp__browser__read_page", JSON.stringify({ title: "Invoices · upbudget", url: "u", text: "x".repeat(4100) })).summary, "Invoices · upbudget · 4,100 chars");
    assert.equal(r("mcp__browser__read_page", JSON.stringify({ title: "0039.pdf", kind: "pdf", pages: 3, text: "x".repeat(900) })).summary, "0039.pdf · PDF · 3 pages · 900 chars");
    assert.equal(r("mcp__browser__read_page", JSON.stringify({ title: "Docs", mode: "markdown", text: "x".repeat(300) })).summary, "Docs · markdown · 300 chars");
    assert.equal(r("mcp__browser__read_page", JSON.stringify({ title: "Docs", mode: "links", count: 12 })).summary, "Docs · 12 links");
    assert.equal(r("mcp__browser__read_page", JSON.stringify({ title: "Docs", mode: "tables", count: 1 })).summary, "Docs · 1 table");
    assert.equal(r("mcp__browser__read_page", JSON.stringify({ title: "Docs", mode: "forms", count: 2, forms: [{ fields: [1, 2] }, { fields: [3] }] })).summary, "Docs · 2 forms · 3 fields");
    assert.equal(r("mcp__browser__screenshot", JSON.stringify({ path: "/p.png", width: 1280, height: 720, bytes: 1_300_000 })).summary, "image · 1280×720 · 1.2 MB");
    assert.equal(r("mcp__browser__list_tabs", JSON.stringify([{ id: 1 }, { id: 2 }])).summary, "2 tabs");
    assert.equal(r("mcp__browser__find", JSON.stringify({ count: 3, matches: [{ text: "…the invoice 0039 is…" }] })).summary, "3 matches · …the invoice 0039 is…");
    assert.equal(r("mcp__browser__find", JSON.stringify({ count: 1, matches: [{ name: "Pay now" }] })).summary, "1 match · Pay now");
    assert.equal(r("mcp__browser__find", JSON.stringify({ count: 0, matches: [], error: "give text, regex, or role/name" })).summary, "give text, regex, or role/name");
    assert.equal(r("mcp__browser__scroll", JSON.stringify({ percent: 42, atTop: false, atBottom: false })).summary, "42%");
    assert.equal(r("mcp__browser__wait_for", JSON.stringify({ ok: true, elapsedMs: 1234, text: "Welcome back" })).summary, 'ready after 1.2s · "Welcome back"');
    assert.equal(r("mcp__browser__wait_for", JSON.stringify({ ok: false, timeout: true, elapsedMs: 10000 })).summary, "✗ timed out after 10.0s");
    assert.equal(r("mcp__browser__scroll", JSON.stringify({ percent: 100, atTop: false, atBottom: true })).summary, "bottom");
    assert.equal(r("mcp__browser__download", JSON.stringify({ path: "/w/downloads/a.pdf", name: "a.pdf", bytes: 1_300_000 })).summary, "saved a.pdf · 1.2 MB");
    assert.equal(r("mcp__browser__snapshot", JSON.stringify({ elements: [1, 2, 3] })).summary, "3 elements");
    assert.equal(r("mcp__browser__eval", "null").summary, "null");
    assert.equal(r("mcp__terminal__read", "Last 200 lines of the user's terminal:\n\n$ ls").summary, "200 lines");
    assert.equal(r("mcp__browser__read_page", "not json at all").summary, "not json at all", "falls back to the first line");
  });

  test("TodoWrite and Agent", () => {
    assert.equal(r("TodoWrite", "Todos have been modified successfully.").summary, "list updated");
    assert.equal(r("Agent", "Async agent launched successfully. (internal…)").summary, "running in the background");
    assert.equal(r("Agent", "Three links found.\nmore").summary, "Three links found.");
  });

  test("unknown tools, empties, long lines, the cap", () => {
    assert.equal(r("WebFetch", "Title: X\nbody").summary, "Title: X");
    assert.equal(r("Whatever", "   \n\n").summary, "(empty)");
    assert.equal(r("Whatever", [{ type: "image" }]).summary, "image");
    const long = r("Whatever", "y".repeat(500));
    assert.equal(long.summary.length, 120); assert.ok(long.summary.endsWith("…"));
    const big = r("Bash", "z".repeat(RESULT_TEXT_CAP + 10), { stdout: "z" });
    assert.equal(big.truncated, true); assert.equal(big.text.length, RESULT_TEXT_CAP); assert.equal(big.bytes, RESULT_TEXT_CAP + 10);
    assert.equal(r("Bash", "short", { stdout: "short" }).truncated, false);
    assert.equal(r("Whatever", undefined).summary, "(empty)");
    assert.equal(r("Whatever", 42).summary, "(empty)");
  });

  test("an error wins over everything else and keeps its first line", () => {
    const e = r("Read", "File does not exist.\nmore", { type: "text", file: { numLines: 0 } }, true);
    assert.equal(e.summary, "✗ File does not exist."); assert.equal(e.ok, false);
    assert.equal(r("Bash", "", undefined, true).summary, "✗ failed");
  });
});

describe("whereOf", () => {
  test("host · title from the at stamp, browser tools only", () => {
    assert.equal(whereOf("mcp__browser__click", JSON.stringify({ ok: true, at: { host: "bank.example", title: "Transfer" } })), "bank.example · Transfer");
    assert.equal(whereOf("mcp__browser__scroll", JSON.stringify({ percent: 3, at: { host: "x.example" } })), "x.example");
    assert.equal(whereOf("mcp__browser__click", JSON.stringify({ ok: true })), undefined);
    assert.equal(whereOf("Bash", JSON.stringify({ at: { host: "x" } })), undefined);
    assert.equal(whereOf("mcp__browser__read_page", "not json"), undefined);
    const r = summariseResult("mcp__browser__click", { tool_use_id: "t", content: JSON.stringify({ ok: true, at: { host: "bank.example", title: "T".repeat(80) } }) }, undefined);
    assert.equal(r.where, "bank.example · " + "T".repeat(49) + "…");
  });
});

describe("handle_dialog summary", () => {
  test("answered with the message, or the reason it could not", () => {
    const sum = (o: unknown) => summariseResult("mcp__browser__handle_dialog", { tool_use_id: "t", content: JSON.stringify(o) }, undefined).summary;
    assert.equal(sum({ handled: true, type: "confirm", message: "Delete everything?" }), 'answered confirm "Delete everything?"');
    assert.equal(sum({ handled: false, reason: "no dialog is open" }), "✗ no dialog is open");
  });
});

describe("tab management summaries", () => {
  test("open/close/focus/back say what happened", () => {
    const sum = (n: string, o: unknown) => summariseResult(`mcp__browser__${n}`, { tool_use_id: "t", content: JSON.stringify(o) }, undefined).summary;
    assert.equal(sum("open_tab", { tabId: 12, url: "https://a.example/x" }), "opened tab 12 · https://a.example/x");
    assert.equal(sum("close_tab", { closed: true, title: "Old" }), "closed · Old");
    assert.equal(sum("focus_tab", { focused: true, title: "Front" }), "focused · Front");
    assert.equal(sum("back", { url: "https://a.example/" }), "https://a.example/");
    assert.equal(sum("reload", { url: "https://a.example/", loading: true }), "loading https://a.example/");
  });
});
