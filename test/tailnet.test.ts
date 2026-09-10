import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { whois, clearWhoisCache, WHOIS_TTL_MS } from "../src/tailnet.js";

// whois spawns `tailscale`. Memoised per IP so a burst of guarded requests is
// not a burst of subprocesses. Counted, not timed: the lookup is injectable.
describe("whois memo", () => {
  before(() => clearWhoisCache());
  const counting = () => { let n = 0; const fn = async () => { n++; return null; }; return { fn, get n() { return n; } }; };

  test("a repeat lookup inside the TTL does not spawn again", async () => {
    const ip = "198.51.100.7";
    const c = counting();
    const a = await whois(ip, 1, 1000, c.fn);
    const b = await whois(ip, 1, 1000 + WHOIS_TTL_MS - 1, c.fn);
    assert.equal(a, b);
    assert.equal(c.n, 1, "second call must be a memo hit");
  });

  test("the memo expires after the TTL", async () => {
    clearWhoisCache();
    const ip = "198.51.100.8";
    const c = counting();
    await whois(ip, 1, 5000, c.fn);
    await whois(ip, 1, 5000 + WHOIS_TTL_MS + 1, c.fn);
    assert.equal(c.n, 2, "must look up again after the TTL");
  });

  test("the real lookup is what runs when nothing is injected", async () => {
    clearWhoisCache();
    // documentation range: never on a tailnet, so this exercises the spawn path and its null answer
    assert.equal(await whois("198.51.100.9", 1, 9000), null);
  });
});

import { isLoopback, isLoopbackHost } from "../src/tailnet.js";

describe("loopback detection (localhost mode gate)", () => {
  test("isLoopback covers the whole 127/8 block and ::1", () => {
    for (const ip of ["127.0.0.1", "127.0.0.5", "127.1.2.3", "::1"]) assert.ok(isLoopback(ip), ip);
    for (const ip of ["100.64.0.1", "10.0.0.1", "192.168.1.5", "8.8.8.8", "", "::2"]) assert.ok(!isLoopback(ip), ip);
  });

  test("isLoopbackHost recognises the loopback bind targets", () => {
    for (const h of ["localhost", "127.0.0.1", "127.0.0.5", "::1"]) assert.ok(isLoopbackHost(h), h);
    // A network bind is not loopback — localhost mode must refuse to start there.
    for (const h of ["0.0.0.0", "100.64.0.1", "devserver.tailnet-1234.ts.net", "::"]) assert.ok(!isLoopbackHost(h), h);
  });
});

describe("whois memo bound", () => {
  test("never holds more than WHOIS_CACHE_MAX entries", async () => {
    const { whois, clearWhoisCache, whoisCacheSize, WHOIS_CACHE_MAX } = await import("../src/tailnet.js");
    clearWhoisCache();
    const stub = async () => null;   // negative answers are cached too
    for (let i = 0; i < WHOIS_CACHE_MAX * 3; i++) await whois(`10.9.${i >> 8}.${i & 255}`, 1, 1_000_000 + i, stub);
    assert.ok(whoisCacheSize() <= WHOIS_CACHE_MAX, `cache holds ${whoisCacheSize()}`);
    // A fresh entry survives the sweep; the oldest ones are what went.
    assert.equal(await whois("10.9.5.255", 1, 1_000_000 + WHOIS_CACHE_MAX * 3, async () => { throw new Error("should be memoised"); }), null);
    clearWhoisCache();
  });
});
