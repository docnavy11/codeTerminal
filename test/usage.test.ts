import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLog } from "../src/usage.js";

let dir: string;
before(async () => { dir = await mkdtemp(join(tmpdir(), "ct-usage-")); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

describe("UsageLog", () => {
  test("counts clicks and ranks the most-used first", () => {
    const u = new UsageLog(join(dir, "a.json"));
    for (let i = 0; i < 5; i++) u.record("chats");
    u.record("theme");
    for (let i = 0; i < 3; i++) u.record("reset");
    assert.deepEqual(Object.keys(u.counts()), ["chats", "reset", "theme"]);
    assert.equal(u.counts().chats, 5);
  });

  // Control ids arrive over the wire from a page; they are not to be trusted
  // just because we wrote the page that sends them.
  test("refuses a control id that is not one of ours", () => {
    const u = new UsageLog(join(dir, "b.json"));
    for (const bad of ["../../etc/passwd", "a b", "", "x".repeat(40), "__proto__", "1abc"]) {
      assert.equal(u.record(bad), false, `accepted ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(u.counts(), {});
  });

  test("survives a restart", async () => {
    const p = join(dir, "c.json");
    const u = new UsageLog(p);
    u.record("mode"); u.record("mode"); u.record("more");
    u.save();
    const back = JSON.parse(await readFile(p, "utf8"));
    assert.deepEqual(back, { mode: 2, more: 1 });
    assert.deepEqual(new UsageLog(p).counts(), { mode: 2, more: 1 });
  });

  test("a corrupt or absent file is not fatal", async () => {
    assert.doesNotThrow(() => new UsageLog(join(dir, "missing.json")));
    const p = join(dir, "bad.json");
    await (await import("node:fs/promises")).writeFile(p, "{not json");
    assert.deepEqual(new UsageLog(p).counts(), {});
  });

  test("drops junk keys already on disk", async () => {
    const p = join(dir, "d.json");
    await (await import("node:fs/promises")).writeFile(p,
      JSON.stringify({ chats: 3, "../evil": 9, ok: "not a number" }));
    assert.deepEqual(new UsageLog(p).counts(), { chats: 3 });
  });
});

describe("UsageLog key cap", () => {
  test("stops accepting new keys past MAX_KEYS but keeps counting known ones", () => {
    const u = new UsageLog(join(dir, "cap.json"));
    for (let i = 0; i < UsageLog.MAX_KEYS; i++) assert.equal(u.record(`k${i}`), true);
    assert.equal(u.record("one-too-many"), false, "a fresh key past the cap is refused");
    assert.equal(u.record("k0"), true, "an existing key still counts");
    assert.equal(Object.keys(u.counts()).length, UsageLog.MAX_KEYS);
  });
});
