import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WatchRegistry, type Watch } from "../src/watches.js";

let reg: WatchRegistry;
const base = { chatId: "chat-1", description: "the build finishes", url: "https://ci.example/1",
               tabId: 7, condition: { kind: "contains", value: "Passed" } as const };

beforeEach(() => { reg = new WatchRegistry(); });

describe("WatchRegistry", () => {
  test("a new watch is active", () => {
    const w = reg.add(base);
    assert.equal(reg.active().length, 1);
    assert.equal(reg.get(w.id)?.description, "the build finishes");
  });

  test("firing marks it and returns the watch", () => {
    const w = reg.add(base);
    const fired = reg.fire(w.id, "Passed appeared");
    assert.equal(fired?.id, w.id);
    assert.equal(reg.get(w.id)?.detail, "Passed appeared");
    assert.equal(reg.active().length, 0, "a fired watch is no longer active");
  });

  test("a watch fires only once", () => {
    // The extension can report twice if a poll overlaps a reconnect; the
    // second must not wake the conversation again.
    const w = reg.add(base);
    assert.ok(reg.fire(w.id, "first"));
    assert.equal(reg.fire(w.id, "second"), null);
    assert.equal(reg.get(w.id)?.detail, "first");
  });

  test("firing an unknown id is null, not a throw", () => {
    assert.equal(reg.fire("nope", "x"), null);
  });

  test("expiry takes it out of active without firing", () => {
    const w = reg.add({ ...base, minutes: 1 });
    const later = Date.now() + 2 * 60_000;
    assert.equal(reg.active(later).length, 0);
    assert.equal(reg.get(w.id)?.firedAt, undefined);
  });

  test("minutes are clamped to something sane", () => {
    const tiny = reg.add({ ...base, minutes: 0 });
    const huge = reg.add({ ...base, minutes: 99_999 });
    assert.ok(tiny.expiresAt - tiny.createdAt >= 60_000);
    assert.ok(huge.expiresAt - huge.createdAt <= 24 * 60 * 60_000);
  });

  test("refuses to accumulate unbounded watches", () => {
    for (let i = 0; i < 20; i++) reg.add(base);
    assert.throws(() => reg.add(base), /Too many active watches/);
  });

  test("a fired watch frees a slot", () => {
    const first = reg.add(base);
    for (let i = 0; i < 19; i++) reg.add(base);
    reg.fire(first.id, "done");
    assert.doesNotThrow(() => reg.add(base));
  });

  test("sweep drops expired and long-fired, keeps recent", () => {
    const expired = reg.add({ ...base, minutes: 1 });
    const justFired = reg.add(base);
    const watching = reg.add(base);
    const now = Date.now() + 2 * 60_000;
    reg.fire(justFired.id, "x", now);
    const dropped = reg.sweep(now).map((w) => w.id);
    assert.ok(dropped.includes(expired.id), "expired should go");
    assert.ok(!dropped.includes(justFired.id), "a watch that just fired stays briefly");
    assert.ok(!dropped.includes(watching.id), "an active watch stays");
  });

  test("deleting a chat takes its watches with it", () => {
    reg.add(base);
    reg.add({ ...base, chatId: "chat-2" });
    assert.equal(reg.removeForChat("chat-1"), 1);
    assert.deepEqual(reg.all().map((w) => w.chatId), ["chat-2"]);
  });

  test("describe reads as a line a person can act on", () => {
    const w = reg.add(base);
    const line = reg.describe(w);
    assert.match(line, /\[watching\]/);
    assert.match(line, /the build finishes/);
    assert.match(line, /"Passed" appears/);
    reg.fire(w.id, "x");
    assert.match(reg.describe(reg.get(w.id) as Watch), /\[fired\]/);
  });
});
