import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAllowlist, hostOfUrl, hostMatches, normaliseHost } from "../src/browser-allow.js";

describe("browser allowlist", () => {
  test("hosts from urls, matching with wildcards, normalising input", () => {
    assert.equal(hostOfUrl("https://Mail.Example.com:8443/x?y"), "mail.example.com");
    assert.equal(hostOfUrl("chrome://extensions"), "", "not a web page"); assert.equal(hostOfUrl("file:///etc/hosts"), ""); assert.equal(hostOfUrl("about:blank"), "");
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

  test("persists with levels, seeds (bare host = act), adds/raises, sets, removes, migrates an old file, survives a corrupt one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ct-allow-")); const p = join(dir, "allow.json");
    const { writeFile } = await import("node:fs/promises");
    try {
      const a = new BrowserAllowlist(p, ["Seed.example", "ro.example:read", "junk host"]);
      assert.deepEqual(a.all(), [{ host: "ro.example", level: "read" }, { host: "seed.example", level: "act" }]);
      assert.equal(a.has("seed.example", "act"), true); assert.equal(a.has("ro.example", "read"), true); assert.equal(a.has("ro.example", "act"), false, "read does not cover act");
      assert.equal(a.has("seed.example"), true, "act covers a read need");
      assert.equal(a.add("https://New.example/x", "read"), true); assert.equal(a.add("new.example", "read"), false, "already there at that level");
      assert.equal(a.add("new.example", "act"), true, "raised"); assert.equal(a.add("new.example", "read"), false, "add never lowers");
      assert.equal(a.set("new.example", "read"), true); assert.equal(a.level("new.example"), "read");
      assert.equal(a.add("nope nope"), false); assert.equal(a.level("other.example"), null);
      assert.deepEqual(JSON.parse(await readFile(p, "utf8")), [{ host: "new.example", level: "read" }, { host: "ro.example", level: "read" }, { host: "seed.example", level: "act" }]);
      const b = new BrowserAllowlist(p);
      assert.deepEqual(b.all().map((e) => e.host), ["new.example", "ro.example", "seed.example"], "reloaded from disk");
      assert.equal(b.remove("seed.example"), true); assert.equal(b.remove("seed.example"), false);
      await writeFile(p, JSON.stringify(["legacy.example"]));
      assert.deepEqual(new BrowserAllowlist(p).all(), [{ host: "legacy.example", level: "act" }], "an old host-list file means act");
      await writeFile(p, "{not json");
      assert.deepEqual(new BrowserAllowlist(p, ["x.example"]).all(), [{ host: "x.example", level: "act" }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
