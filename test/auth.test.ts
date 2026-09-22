import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createAuth, AuthRefused, type PeerRequest } from "../src/auth.js";

// The policy was only ever verified against scratch servers. Now it takes a
// plain request shape and injectable tailscale calls, so every branch is a
// unit test.
const SELF = { userId: 42, dnsName: "box.tail.ts.net" };
const req = (o: Partial<PeerRequest["headers"]> & { ip?: string }): PeerRequest =>
  ({ headers: { origin: o.origin, "sec-fetch-site": o["sec-fetch-site"] }, socket: { remoteAddress: o.ip ?? "127.0.0.1", remotePort: 1 } });

const tailnet = (whois = async (ip: string) => ip === "100.1.1.1" ? { userId: 42, loginName: "me", nodeName: "n" }
                                            : ip === "100.2.2.2" ? { userId: 7, loginName: "other", nodeName: "n" } : null) =>
  createAuth({ host: "100.0.0.1", port: 8123, extraOrigins: [], forceLocal: false, trustedCidrSpec: undefined,
               deps: { self: async () => SELF, whois } });

describe("boot-time mode selection", () => {
  test("tailnet identity -> tailnet mode", async () => { assert.equal((await tailnet()).mode, "tailnet"); });
  test("no identity + loopback bind -> localhost mode", async () => {
    const a = await createAuth({ host: "127.0.0.1", port: 1, extraOrigins: [], forceLocal: false, trustedCidrSpec: undefined, deps: { self: async () => null } });
    assert.equal(a.mode, "localhost");
  });
  test("forceLocal ignores a present identity", async () => {
    const a = await createAuth({ host: "127.0.0.1", port: 1, extraOrigins: [], forceLocal: true, trustedCidrSpec: undefined, deps: { self: async () => { throw new Error("must not be called"); } } });
    assert.equal(a.mode, "localhost");
  });
  test("no identity + network bind + no CIDRs -> REFUSES", async () => {
    await assert.rejects(() => createAuth({ host: "10.0.0.5", port: 1, extraOrigins: [], forceLocal: false, trustedCidrSpec: undefined, deps: { self: async () => null } }), AuthRefused);
  });
  test("no identity + network bind + trusted CIDR -> cidr mode", async () => {
    const a = await createAuth({ host: "10.0.0.5", port: 1, extraOrigins: [], forceLocal: false, trustedCidrSpec: "10.0.0.0/24", deps: { self: async () => null } });
    assert.equal(a.mode, "cidr");
  });
  test("a public trusted CIDR -> REFUSES with the cidr message", async () => {
    await assert.rejects(() => createAuth({ host: "127.0.0.1", port: 1, extraOrigins: [], forceLocal: true, trustedCidrSpec: "0.0.0.0/0" }), /not a private range/);
  });
});

describe("denyReason", () => {
  test("loopback always passes, whatever else", async () => {
    const a = await tailnet(async () => { throw new Error("whois must not run for loopback"); });
    assert.equal(await a.denyReason(req({ ip: "127.0.0.1" })), null);
    assert.equal(await a.denyReason(req({ ip: "::1", origin: "http://100.0.0.1:8123" })), null);
  });
  test("cross-site is refused before anything else", async () => {
    const a = await tailnet();
    assert.match((await a.denyReason(req({ "sec-fetch-site": "cross-site" })))!, /cross-site/);
  });
  test("an unlisted Origin is refused; a listed one passes", async () => {
    const a = await tailnet();
    assert.match((await a.denyReason(req({ ip: "100.1.1.1", origin: "http://evil.example" })))!, /origin/);
    assert.equal(await a.denyReason(req({ ip: "100.1.1.1", origin: "http://box.tail.ts.net:8123" })), null);
    assert.equal(await a.denyReason(req({ ip: "100.1.1.1", origin: "http://box:8123" })), null, "short dns label");
  });
  test("tailnet: owner passes, another user is refused, off-tailnet is refused", async () => {
    const a = await tailnet();
    assert.equal(await a.denyReason(req({ ip: "100.1.1.1" })), null);
    assert.match((await a.denyReason(req({ ip: "100.2.2.2" })))!, /not the owner/);
    assert.match((await a.denyReason(req({ ip: "8.8.8.8" })))!, /not on this tailnet/);
  });
  test("extension origin skips the Origin allowlist but not identity", async () => {
    const a = await tailnet();
    assert.equal(await a.denyReason(req({ ip: "100.1.1.1", origin: "chrome-extension://abc" })), null);
    assert.match((await a.denyReason(req({ ip: "8.8.8.8", origin: "chrome-extension://abc" })))!, /not on this tailnet/);
  });
  test("a pinned extension id refuses others", async () => {
    const a = await createAuth({ host: "100.0.0.1", port: 8123, extraOrigins: [], forceLocal: false, trustedCidrSpec: undefined, extOrigin: "chrome-extension://good", deps: { self: async () => SELF } });
    assert.match((await a.denyReason(req({ ip: "127.0.0.1", origin: "chrome-extension://bad" })))!, /not the pinned one/);
    assert.equal(await a.denyReason(req({ ip: "127.0.0.1", origin: "chrome-extension://good" })), null);
  });
  test("localhost mode refuses any non-loopback peer", async () => {
    const a = await createAuth({ host: "127.0.0.1", port: 1, extraOrigins: [], forceLocal: true, trustedCidrSpec: undefined });
    assert.match((await a.denyReason(req({ ip: "10.0.0.9" })))!, /localhost-only/);
  });
  test("cidr mode admits an in-range peer and refuses one outside", async () => {
    const a = await createAuth({ host: "10.0.0.5", port: 1, extraOrigins: [], forceLocal: false, trustedCidrSpec: "10.0.0.0/24", deps: { self: async () => null } });
    assert.equal(await a.denyReason(req({ ip: "10.0.0.77" })), null);
    assert.match((await a.denyReason(req({ ip: "10.0.1.77" })))!, /localhost-only/);
  });
  test("v4-mapped loopback is loopback", async () => {
    const a = await tailnet();
    assert.equal(await a.denyReason(req({ ip: "::ffff:127.0.0.1" })), null);
  });
});

describe("CODETERM_ORIGINS behind a reverse proxy", () => {
  test("a listed name is accepted on the default ports too, and a full origin as given", async () => {
    const a = await createAuth({ host: "127.0.0.1", port: 8123, extraOrigins: ["claude.example.com", "https://other.example:8443"], forceLocal: false, trustedCidrSpec: undefined, deps: { self: async () => null } });
    for (const o of ["https://claude.example.com", "http://claude.example.com", "https://claude.example.com:8123", "https://other.example:8443"]) {
      assert.equal(await a.denyReason(req({ ip: "127.0.0.1", origin: o })), null, o);
    }
    assert.match((await a.denyReason(req({ ip: "127.0.0.1", origin: "https://claude.example.com.evil.example" })))!, /origin/);
    assert.match((await a.denyReason(req({ ip: "127.0.0.1", origin: "https://other.example" })))!, /origin/, "a full origin keeps its port");
  });
});
