import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSetup, type SetupInput } from "../src/setup.js";

/** The setup report: each check's three states, and the addresses it hands out. */
function input(over: Partial<SetupInput> = {}): SetupInput {
  return {
    version: "0.1.0", node: "v22.22.1", host: "127.0.0.1", port: 8123,
    auth: { mode: "localhost", self: null, allowedOrigins: new Set(["http://127.0.0.1:8123", "http://localhost:8123"]), trustedCidrs: [] },
    extensionInstances: [], readySeen: false, chats: 0, home: "/h",
    workspace: "/h/ws", filesRoot: "/h", projectsRoot: "/h/projects", bypassAllowed: false, systemd: false,
    fs: { exists: (p) => p === "/h/.claude/.credentials.json", isDir: () => true },
    ...over,
  };
}

describe("buildSetup", () => {
  test("a working laptop: ready, with the warnings that are only advice", () => {
    const s = buildSetup(input({ readySeen: true }));
    assert.equal(s.ready, true);
    assert.equal(s.checks.login.level, "ok");
    assert.equal(s.checks.extension.level, "warn");
    assert.match(s.checks.extension.hint!, /ws:\/\/127\.0\.0\.1:8123\/ext/);
    assert.match(s.checks.extension.hint!, /on this machine/);
    assert.equal(s.checks.mobile.level, "warn");
    assert.equal(s.checks.service.level, "warn");
    assert.deepEqual(s.urls.extension, ["ws://127.0.0.1:8123/ext"]);
  });

  test("no login is the one thing that makes it not ready", () => {
    const s = buildSetup(input({ fs: { exists: () => false, isDir: () => true } }));
    assert.equal(s.ready, false);
    assert.equal(s.checks.login.level, "bad");
    assert.match(s.checks.login.hint!, /run `claude`/);
    assert.equal(s.login.credentials, false);
    assert.equal(s.login.path, "/h/.claude/.credentials.json");
  });

  test("login present but no session yet is a warning with the next step", () => {
    const s = buildSetup(input());
    assert.equal(s.checks.login.level, "warn");
    assert.match(s.checks.login.hint!, /Send any message/);
  });

  test("old node is refused", () => {
    const s = buildSetup(input({ node: "v20.1.0" }));
    assert.equal(s.checks.node.level, "bad"); assert.equal(s.ready, false);
  });

  test("tailnet mode: phone url from the dns name, extension addresses from every accepted origin", () => {
    const s = buildSetup(input({
      host: "100.1.2.3", readySeen: true, systemd: true, extensionInstances: ["b1", "b2"],
      auth: { mode: "tailnet", self: { dnsName: "box.tail.ts.net", userId: "u" } as never,
        allowedOrigins: new Set(["http://100.1.2.3:8123", "https://100.1.2.3:8123", "http://box.tail.ts.net:8123", "http://localhost:8123"]), trustedCidrs: [] },
    }));
    assert.equal(s.checks.network.level, "ok"); assert.match(s.checks.network.text, /tailnet mode — box\.tail\.ts\.net/);
    assert.equal(s.checks.mobile.level, "ok"); assert.match(s.checks.mobile.text, /http:\/\/box\.tail\.ts\.net:8123\/m/);
    assert.equal(s.checks.extension.level, "ok"); assert.match(s.checks.extension.text, /2 browsers/);
    assert.equal(s.checks.service.level, "ok");
    assert.deepEqual(s.urls.extension, ["ws://100.1.2.3:8123/ext", "ws://box.tail.ts.net:8123/ext"], "no https, no localhost, no duplicates");
  });

  test("cidr mode names the trusted ranges", () => {
    const s = buildSetup(input({ host: "10.4.0.1", auth: { mode: "cidr", self: null, allowedOrigins: new Set(["http://10.4.0.1:8123"]), trustedCidrs: [{} as never, {} as never] } }));
    assert.match(s.checks.network.text, /VPN mode — 10\.4\.0\.1:8123, trusting 2 private range/);
  });

  test("a missing directory and an enabled bypass are flagged", () => {
    const s = buildSetup(input({ bypassAllowed: true, fs: { exists: () => true, isDir: (p) => p !== "/h/projects" } }));
    assert.equal(s.checks.paths.level, "warn"); assert.equal(s.checks.paths.ok, false);
    assert.equal(s.paths.projectsRoot.exists, false); assert.equal(s.paths.workspace.exists, true);
    assert.equal(s.checks.permissions.level, "warn"); assert.match(s.checks.permissions.text, /Never ask/);
    assert.equal(s.ready, false);
  });
});
