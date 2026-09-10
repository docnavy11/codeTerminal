import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Pushable, deferred } from "../src/pushable.js";

describe("Pushable", () => {
  test("delivers queued values in order, then waits, then ends", async () => {
    const p = new Pushable<number>();
    p.push(1); p.push(2);
    const it = p[Symbol.asyncIterator]();
    assert.deepEqual(await it.next(), { value: 1, done: false });
    assert.deepEqual(await it.next(), { value: 2, done: false });
    const pending = it.next();
    p.push(3);
    assert.deepEqual(await pending, { value: 3, done: false });
    const atEnd = it.next();
    p.end();
    assert.equal((await atEnd).done, true);
  });

  test("push after end is dropped; end twice is harmless; queued values still drain after end", async () => {
    const p = new Pushable<string>();
    p.push("a"); p.end(); p.end(); p.push("b");
    const got: string[] = [];
    for await (const v of p) got.push(v);
    assert.deepEqual(got, ["a"]);
  });

  test("a consumer waiting when end() is called finishes cleanly", async () => {
    const p = new Pushable<string>();
    const done = (async () => { const got: string[] = []; for await (const v of p) got.push(v); return got; })();
    await new Promise((r) => setImmediate(r));
    p.end();
    assert.deepEqual(await done, []);
  });
});

describe("deferred", () => {
  test("resolves from outside", async () => {
    const d = deferred<number>();
    setImmediate(() => d.resolve(7));
    assert.equal(await d.promise, 7);
  });
});
