import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAllowlist, hostOfUrl, hostMatches, normaliseHost } from "../src/browser-allow.js";

describe("browser allowlist", () => {
  test("hosts from urls, matching with wildcards, normalising input", () => {
    assert.equal(hostOfUrl("https://Mail.Example.com:8443/x?y"), "mail.example.com");
    assert.equal(hostOfUrl("chrome://extensions"), "extensions");
    assert.equal(hostOfUrl("not a url"), ""); assert.equal(hostOfUrl(undefined), "");
    assert.equal(hostMatches("a.example.com", "*.example.com"), true);
    assert.equal(hostMatches("example.com", "*.example.com"), false, "the wildcard needs a subdomain");
    assert.equal(hostMatches("example.com", "example.com"), true);
    assert.equal(hostMatches("evilexample.com", "*.example.com"), false);
    assert.equal(hostMatches("", "example.com"), false);
    assert.equal(normaliseHost(" https://Docs.Example.com/path "), "docs.example.com");
    assert.equal(normaliseHost("*.example.com"), "*.example.com");
    assert.equal(normaliseHost("example.com:8123"), "example.com");
    assert.equal(normaliseHost("bad host"), null); assert.equal(normaliseHost(""), null); assert.equal(normaliseHost("x."), null);
  });

  test("persists, seeds, adds, removes, survives a corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-allow-")); const p = join(dir, "allow.json");
    try {
      const a = new BrowserAllowlist(p, ["Seed.example", "junk host"]);
      assert.deepEqual(a.all(), ["seed.example"]);
      assert.equal(a.add("https://New.example/x"), true); assert.equal(a.add("new.example"), false, "already there");
      assert.equal(a.add("nope nope"), false);
      assert.equal(a.has("new.example"), true); assert.equal(a.has("other.example"), false);
      assert.deepEqual(JSON.parse(await readFile(p, "utf8")), ["new.example", "seed.example"]);
      const b = new BrowserAllowlist(p);
      assert.deepEqual(b.all(), ["new.example", "seed.example"], "reloaded from disk");
      assert.equal(b.remove("seed.example"), true); assert.equal(b.remove("seed.example"), false);
      assert.deepEqual(new BrowserAllowlist(p).all(), ["new.example"]);
      const { writeFile } = await import("node:fs/promises"); await writeFile(p, "{not json");
      assert.deepEqual(new BrowserAllowlist(p, ["x.example"]).all(), ["x.example"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
