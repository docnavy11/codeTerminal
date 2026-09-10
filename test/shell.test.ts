import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../src/shell.js";

/**
 * What the agent reads from the shell pane is raw pty output. If the escape
 * codes survive, a model reading a stack trace is reading mostly noise — the
 * prompt alone emits an OSC title sequence before every single command.
 */
describe("stripAnsi", () => {
  for (const [raw, want, why] of [
    ["\x1b[32mgreen\x1b[0m text", "green text", "SGR colour"],
    ["\x1b[1;31;40mbold red\x1b[0m", "bold red", "multi-parameter SGR"],
    ["\x1b]0;dev@box: ~/work\x07dev@box:~$ ls", "dev@box:~$ ls", "OSC window title, BEL-terminated"],
    ["\x1b]0;title\x1b\\after", "after", "OSC, ST-terminated"],
    ["\x1b[2K\x1b[1Gspinner", "spinner", "erase line and cursor column"],
    ["\x1b[?25lhidden\x1b[?25h", "hidden", "private-mode cursor toggle"],
    ["plain text", "plain text", "nothing to strip"],
    ["", "", "empty"],
  ] as const) {
    test(why, () => assert.equal(stripAnsi(raw), want));
  }

  test("a bare carriage return becomes a newline, not a lost line", () => {
    // Progress output overwrites itself with \r; keeping both sides is more
    // useful to a reader than showing only the last state.
    assert.equal(stripAnsi("10%\r50%\r100%"), "10%\n50%\n100%");
  });

  test("CRLF is left as a normal line ending", () => {
    assert.equal(stripAnsi("one\r\ntwo"), "one\r\ntwo");
  });

  test("real-world compile error survives intact", () => {
    const raw =
      "\x1b]0;dev@box: ~/p\x07\x1b[32m✓\x1b[0m built\r\n" +
      "\x1b[31merror\x1b[0m: \x1b[1msrc/a.ts(4,9)\x1b[0m: Type 'string' is not assignable to type 'number'.";
    const out = stripAnsi(raw);
    assert.ok(out.includes("src/a.ts(4,9)"));
    assert.ok(out.includes("Type 'string' is not assignable to type 'number'."));
    assert.ok(!out.includes("\x1b"), "no escape bytes should remain");
  });
});
