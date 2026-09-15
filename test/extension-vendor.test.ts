import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MV3 forbids remote code, so the extension carries its own copy of every
 * library the page loads from /vendor. Copies drift silently — the panel would
 * keep running an xterm from two upgrades ago and nothing would say so — which
 * is what this checks. `npm run sync:vendor` refreshes them.
 */
const ROOT = join(import.meta.dirname, "..");
const COPIES: Record<string, string> = {
  "xterm.js": "node_modules/@xterm/xterm/lib/xterm.js",
  "xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
  "addon-fit.js": "node_modules/@xterm/addon-fit/lib/addon-fit.js",
  "addon-web-links.js": "node_modules/@xterm/addon-web-links/lib/addon-web-links.js",
  "marked.umd.js": "node_modules/marked/lib/marked.umd.js",
  "purify.min.js": "node_modules/dompurify/dist/purify.min.js",
};

describe("the extension's vendored libraries", () => {
  for (const [name, from] of Object.entries(COPIES)) {
    test(`${name} is the installed one`, () => {
      const mine = readFileSync(join(ROOT, "extension/vendor", name), "utf8");
      const theirs = readFileSync(join(ROOT, from), "utf8");
      assert.equal(mine, theirs, `extension/vendor/${name} differs from ${from} — run npm run sync:vendor`);
    });
  }
});
