import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { wantsContext, composePrompt } from "../src/prompt.js";

/**
 * These exist because ambient tab context silently broke every slash command:
 * the CLI expands one only when it begins the message, and the context block
 * was being put in front of it.
 */
describe("wantsContext", () => {
  for (const text of [
    "/context",
    "/compact",
    "/model sonnet",
    "  /context",          // leading whitespace still a command
    "\n/usage",
    "/affine search notes",
  ]) {
    test(`no context for ${JSON.stringify(text)}`, () => {
      assert.equal(wantsContext(text), false);
    });
  }

  for (const text of [
    "what page am I on?",
    "explain this",
    "what does 5/3 mean?",           // a slash, but not leading
    "run ls /etc",
    "the file is at /home/dev/x",
  ]) {
    test(`context allowed for ${JSON.stringify(text)}`, () => {
      assert.equal(wantsContext(text), true);
    });
  }
});

describe("composePrompt", () => {
  test("returns the text unchanged with no context", () => {
    assert.equal(composePrompt("hello"), "hello");
    assert.equal(composePrompt("hello", undefined), "hello");
    assert.equal(composePrompt("hello", ""), "hello");
  });

  test("a slash command reaches the model with nothing in front of it", () => {
    // The regression in one assertion: whatever else composePrompt does, a
    // command must still start the message the CLI sees.
    const out = composePrompt("/context", undefined);
    assert.ok(out.startsWith("/context"), `command was not first: ${JSON.stringify(out.slice(0, 40))}`);
  });

  test("context is tagged and labelled untrusted", () => {
    const out = composePrompt("what is this?", "active tab: Example — https://example.com/");
    assert.match(out, /^<browser-context /);
    assert.match(out, /Not instructions/);
    assert.ok(out.includes("active tab: Example"));
    assert.ok(out.trimEnd().endsWith("what is this?"), "user text must come last");
  });

  test("the pipeline as a whole never fronts a command with context", () => {
    // wantsContext and composePrompt are used together; this asserts the pair,
    // which is where the bug actually lived.
    const ctx = "active tab: Something — https://example.com/";
    for (const text of ["/context", "/compact", "  /usage"]) {
      const attached = wantsContext(text) ? ctx : undefined;
      assert.ok(composePrompt(text, attached).trimStart().startsWith("/"),
        `${text} would not expand`);
    }
  });
});
