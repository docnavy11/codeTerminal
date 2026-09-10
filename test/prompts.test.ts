import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hostMatches, hostOf, applicable, fill, type Prompt } from "../src/prompts.js";

const P = (title: string, domains: string[]): Prompt => ({
  id: title, title, text: "x", domains, createdAt: 0, updatedAt: 0,
});

describe("hostMatches", () => {
  for (const [host, pattern] of [
    ["github.com", "github.com"],
    ["gist.github.com", "github.com"],       // a pattern covers its subdomains
    ["a.b.github.com", "github.com"],
    ["gist.github.com", "*.github.com"],     // people write the star out of habit
    ["GitHub.com", "github.com"],            // case
    ["github.com.", "github.com"],           // trailing dot
  ] as const) {
    test(`${host} matches ${pattern}`, () => assert.equal(hostMatches(host, pattern), true));
  }

  for (const [host, pattern, why] of [
    ["evilgithub.com", "github.com", "suffix must be on a label boundary"],
    ["github.com.evil.net", "github.com", "not a subdomain"],
    ["example.com", "github.com", "unrelated"],
    ["", "github.com", "empty host"],
    ["github.com", "", "empty pattern"],
  ] as const) {
    test(`${host || "(empty)"} does NOT match ${pattern || "(empty)"} — ${why}`, () =>
      assert.equal(hostMatches(host, pattern), false));
  }
});

describe("hostOf", () => {
  test("extracts a hostname", () => assert.equal(hostOf("https://gist.github.com/a/b?c=1"), "gist.github.com"));
  test("empty for rubbish", () => assert.equal(hostOf("not a url"), ""));
  test("empty for undefined", () => assert.equal(hostOf(undefined), ""));
  test("handles a port", () => assert.equal(hostOf("http://100.64.0.1:8123/x"), "100.64.0.1"));
});

describe("applicable", () => {
  const all = [P("zed generic", []), P("apple generic", []), P("site one", ["github.com"]), P("other site", ["example.com"])];

  test("site prompts come before generic ones", () => {
    const got = applicable(all, "gist.github.com").map((p) => p.title);
    assert.equal(got[0], "site one", "the domain-specific one must lead");
    assert.deepEqual(got.slice(1), ["apple generic", "zed generic"]);
  });

  test("prompts for other sites are excluded", () => {
    assert.ok(!applicable(all, "github.com").some((p) => p.title === "other site"));
  });

  test("with no host, only generic ones apply", () => {
    assert.deepEqual(applicable(all, "").map((p) => p.title), ["apple generic", "zed generic"]);
  });

  test("generic prompts are sorted by title, not insertion order", () => {
    assert.deepEqual(applicable([P("b", []), P("a", [])], "").map((p) => p.title), ["a", "b"]);
  });
});

describe("fill", () => {
  const tab = { url: "https://x.dev/p", title: "A Page", selection: "some text" };
  test("substitutes every placeholder", () => {
    assert.equal(fill("{title} at {url} on {host}: {selection}", tab),
      "A Page at https://x.dev/p on x.dev: some text");
  });
  test("repeated placeholders all get filled", () => {
    assert.equal(fill("{host} {host}", tab), "x.dev x.dev");
  });
  test("missing values become empty, not the literal token", () => {
    assert.equal(fill("[{selection}]", { url: "https://x.dev/" }), "[]");
  });
  test("text without placeholders is untouched", () => {
    assert.equal(fill("plain", tab), "plain");
  });
});
