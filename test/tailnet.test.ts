import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { whois, clearWhoisCache, WHOIS_TTL_MS } from "../src/tailnet.js";

// whois spawns `tailscale`. Memoised per IP so a burst of guarded requests is
// not a burst of subprocesses. Proven by timing: a spawn is tens of ms, a memo
// hit is microseconds — a 10x margin is robust on any box.
describe("whois memo", () => {
  before(() => clearWhoisCache());

  test("a repeat lookup inside the TTL does not spawn again", async () => {
    const ip = "198.51.100.7";   // documentation range: never on a tailnet
    const t0 = performance.now(); const a = await whois(ip, 1, 1000); const first = performance.now() - t0;
    const t1 = performance.now(); const b = await whois(ip, 1, 1000 + WHOIS_TTL_MS - 1); const second = performance.now() - t1;
    assert.equal(a, b);
    assert.ok(first > 2, `first call should have spawned (took ${first.toFixed(2)}ms)`);
    assert.ok(second < first / 10, `memo hit took ${second.toFixed(3)}ms vs spawn ${first.toFixed(1)}ms`);
  });

  test("the memo expires after the TTL", async () => {
    clearWhoisCache();
    const ip = "198.51.100.8";
    await whois(ip, 1, 5000);
    const t = performance.now(); await whois(ip, 1, 5000 + WHOIS_TTL_MS + 1); const again = performance.now() - t;
    assert.ok(again > 2, `should have re-spawned after TTL (took ${again.toFixed(2)}ms)`);
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
