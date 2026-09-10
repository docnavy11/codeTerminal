import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CLIENT_EVENT_KINDS, AGENT_MESSAGE_TYPES, parseAgentMessage } from "../src/protocol.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** `kind` literals declared in the ClientEvent union, straight from the source. */
function unionKinds(): string[] {
  const src = read("src/protocol.ts");
  const body = src.slice(src.indexOf("export type ClientEvent ="), src.indexOf("export const CLIENT_EVENT_KINDS"));
  return [...body.matchAll(/\{ kind: "([a-z_]+)"/g)].map((m) => m[1]);
}

describe("protocol: one source of truth", () => {
  test("CLIENT_EVENT_KINDS lists exactly the union's kinds", () => {
    assert.deepEqual([...CLIENT_EVENT_KINDS].sort(), unionKinds().sort());
  });

  test("the server's inbound switch matches AGENT_MESSAGE_TYPES", () => {
    const src = read("src/protocol.ts");
    const body = src.slice(src.indexOf("export function parseAgentMessage"));
    const cases = [...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(cases)].sort(), [...AGENT_MESSAGE_TYPES].sort());
  });
});

// The clients are plain JS and cannot import the union. This is the check that
// would have caught the AskUserQuestion crash statically: a kind the server
// emits that a client does not handle. Server-internal kinds are exempt.
const SERVER_INTERNAL = new Set(["conversation_reset"]);   // absorbed by LiveChat, re-emitted as "cleared"

describe("protocol: one client implements it, every host loads that one", () => {
  test("sidepanel.js handles every emitted kind", () => {
    const js = read("extension/sidepanel.js");
    const missing = CLIENT_EVENT_KINDS.filter((k) => !SERVER_INTERNAL.has(k) &&
      !new RegExp(`(case\\s*"${k}"|kind\\s*===?\\s*"${k}")`).test(js));
    assert.deepEqual(missing, [], `sidepanel.js has no handler for: ${missing.join(", ")}`);
  });

  // The desktop used to carry its own 970-line copy of the protocol; 19 of 20
  // kinds were implemented twice and had already drifted. It is a host now.
  for (const [label, file] of [["desktop", "public/index.html"], ["mobile", "public/m.html"]] as const) {
    test(`${label} loads the shared client and implements nothing itself`, () => {
      const html = read(file);
      assert.match(html, /<script src="\/m\/app\.js">/, `${file} must load sidepanel.js`);
      const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
      const handlers = CLIENT_EVENT_KINDS.filter((k) => new RegExp(`case\\s*"${k}"`).test(inline));
      assert.deepEqual(handlers, [], `${file} reimplements protocol handlers inline: ${handlers.join(", ")}`);
    });
  }
});

describe("parseAgentMessage: inbound validation", () => {
  test("accepts well-formed messages", () => {
    assert.deepEqual(parseAgentMessage({ type: "prompt", text: "hi" }), { type: "prompt", text: "hi" });
    assert.deepEqual(parseAgentMessage({ type: "decision", id: "x", decision: "deny" }), { type: "decision", id: "x", decision: "deny" });
    assert.deepEqual(parseAgentMessage({ type: "mode", mode: "plan" }), { type: "mode", mode: "plan" });
    assert.deepEqual(parseAgentMessage({ type: "interrupt" }), { type: "interrupt" });
  });
  test("rejects the shapes the old ad-hoc code let through", () => {
    for (const bad of [
      null, "prompt", { type: "prompt" }, { type: "prompt", text: "   " },
      { type: "decision", id: "x", decision: "maybe" },
      { type: "mode", mode: "godmode" },
      { type: "rename", id: "x" },              // no title
      { type: "nope" }, { type: "answer", id: "x", answers: "str" },
    ]) assert.equal(parseAgentMessage(bad), null, JSON.stringify(bad));
  });
  test("drops unknown fields rather than passing them through", () => {
    const m = parseAgentMessage({ type: "open", id: "abc", extra: "x" });
    assert.deepEqual(m, { type: "open", id: "abc" });
  });
});
