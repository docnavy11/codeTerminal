import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseIp, parseCidr, ipInCidr, ipInAny, isPrivateCidr, parseTrustedCidrs, isUnspecified } from "../src/cidr.js";

describe("parseIp", () => {
  test("IPv4", () => {
    assert.equal(parseIp("0.0.0.0")!.n, 0n);
    assert.equal(parseIp("255.255.255.255")!.n, 0xffffffffn);
    assert.equal(parseIp("10.0.0.1")!.n, (10n << 24n) | 1n);
    assert.equal(parseIp("192.168.1.1")!.v, 4);
  });
  test("rejects malformed IPv4", () => {
    for (const bad of ["256.0.0.1", "1.2.3", "1.2.3.4.5", "1.2.3.x", "01.2.3.4444", "", " ", "1..2.3"]) {
      assert.equal(parseIp(bad), null, bad);
    }
  });
  test("IPv6 including :: and mapped v4", () => {
    assert.equal(parseIp("::1")!.n, 1n);
    assert.equal(parseIp("::")!.n, 0n);
    assert.equal(parseIp("fd00::1")!.v, 6);
    assert.equal(parseIp("2001:db8::1")!.n, parseIp("2001:0db8:0000:0000:0000:0000:0000:0001")!.n);
    // v4-mapped
    assert.equal(parseIp("::ffff:10.0.0.1")!.n, 0xffff0a000001n);
    assert.equal(parseIp("fe80::1")!.v, 6);
  });
  test("rejects malformed IPv6", () => {
    for (const bad of ["::1::2", "12345::", "gg::1", "1:2:3:4:5:6:7:8:9", ":::", "1:2:3:4:5:6:7"]) {
      assert.equal(parseIp(bad), null, bad);
    }
  });
});

describe("parseCidr + ipInCidr", () => {
  test("matches inside, misses outside", () => {
    const c = parseCidr("10.0.0.0/24")!;
    assert.ok(ipInCidr(parseIp("10.0.0.1")!, c));
    assert.ok(ipInCidr(parseIp("10.0.0.255")!, c));
    assert.ok(!ipInCidr(parseIp("10.0.1.0")!, c), "next /24 is outside");
    assert.ok(!ipInCidr(parseIp("10.1.0.1")!, c));
  });
  test("a bare address is a host route", () => {
    const c = parseCidr("192.168.1.5")!;
    assert.equal(c.bits, 32);
    assert.ok(ipInCidr(parseIp("192.168.1.5")!, c));
    assert.ok(!ipInCidr(parseIp("192.168.1.6")!, c));
  });
  test("families do not cross", () => {
    assert.ok(!ipInCidr(parseIp("::ffff:10.0.0.1")!, parseCidr("10.0.0.0/8")!), "v6-mapped is not v4");
  });
  test("normalises a non-aligned base", () => {
    assert.equal(parseCidr("10.5.7.9/8")!.base, parseIp("10.0.0.0")!.n);
  });
  test("rejects bad masks", () => {
    for (const bad of ["10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/x", "10.0.0.0/8/8", "fd00::/129"]) {
      assert.equal(parseCidr(bad), null, bad);
    }
  });
});

describe("isPrivateCidr — the guard against trusting a public range", () => {
  test("accepts private ranges", () => {
    for (const ok of ["10.0.0.0/8", "10.0.0.0/24", "172.16.0.0/12", "192.168.1.0/24",
                      "100.64.0.0/10", "fd00::/8", "fdab:cd::/64", "fe80::/10"]) {
      assert.ok(isPrivateCidr(parseCidr(ok)!), ok);
    }
  });
  test("rejects public or too-wide ranges", () => {
    for (const bad of ["0.0.0.0/0", "8.8.8.0/24", "1.2.3.4/32", "172.32.0.0/12",
                      "192.169.0.0/16", "100.128.0.0/10", "2001:db8::/32", "::/0", "9.0.0.0/8"]) {
      assert.ok(!isPrivateCidr(parseCidr(bad)!), bad);
    }
  });
  test("a range that straddles private and public is rejected", () => {
    // 172.16/12 is private but 172.0.0.0/8 spans public space too.
    assert.ok(!isPrivateCidr(parseCidr("172.0.0.0/8")!));
  });
});

describe("parseTrustedCidrs — boot-time enforcement", () => {
  test("parses a good list", () => {
    const cs = parseTrustedCidrs("10.0.0.0/24, fd00::/8");
    assert.equal(cs.length, 2);
    assert.ok(ipInAny("10.0.0.9", cs));
    assert.ok(ipInAny("fd00::5", cs));
    assert.ok(!ipInAny("10.0.1.9", cs));
  });
  test("empty / undefined is an empty list, not an error", () => {
    assert.deepEqual(parseTrustedCidrs(""), []);
    assert.deepEqual(parseTrustedCidrs(undefined), []);
  });
  test("THROWS on a public range — the footgun that would open the shell", () => {
    assert.throws(() => parseTrustedCidrs("0.0.0.0/0"), /not a private range/);
    assert.throws(() => parseTrustedCidrs("10.0.0.0/8, 8.8.8.8/32"), /not a private range/);
  });
  test("throws on malformed input", () => {
    assert.throws(() => parseTrustedCidrs("garbage"), /not a valid CIDR/);
  });
});

describe("isUnspecified", () => {
  test("every spelling of 'all interfaces', and nothing else", () => {
    for (const a of ["0.0.0.0", "::", "::0", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0"]) assert.equal(isUnspecified(a), true, a);
    for (const a of ["127.0.0.1", "100.64.0.1", "::1", "fd7a:115c:a1e0::1", "not-an-ip", ""]) assert.equal(isUnspecified(a), false, a);
  });
});
