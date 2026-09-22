import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneScreenshots } from "../src/screenshots.js";

const HOUR = 3600_000;
let dir: string;
const dirs: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ct-shots-test-"));
  dirs.push(dir);
});
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

/** A png whose mtime is `ageMs` in the past. */
async function shot(name: string, ageMs: number) {
  const p = join(dir, name);
  await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const when = new Date(Date.now() - ageMs);
  await utimes(p, when, when);
  return p;
}
const names = async () => (await readdir(dir)).sort();

describe("pruneScreenshots", () => {
  test("removes files past the age limit", async () => {
    await shot("old.png", 8 * HOUR);
    await shot("recent.png", 1 * HOUR);
    await pruneScreenshots(dir);
    assert.deepEqual(await names(), ["recent.png"]);
  });

  test("never deletes a fresh file, even over the count limit", async () => {
    // The agent Reads the path moments after the screenshot is written, so a
    // count limit must not be allowed to delete it out from under that.
    for (let i = 0; i < 10; i++) await shot(`fresh${i}.png`, 1000);
    const removed = await pruneScreenshots(dir, { maxFiles: 2 });
    assert.equal(removed, 0);
    assert.equal((await names()).length, 10);
  });

  test("keeps the newest N when over the count limit", async () => {
    // Ages ascending, so a.png is newest.
    for (const [i, n] of ["a", "b", "c", "d", "e"].entries()) {
      await shot(`${n}.png`, 10 * 60_000 + i * 60_000);
    }
    await pruneScreenshots(dir, { maxFiles: 2 });
    assert.deepEqual(await names(), ["a.png", "b.png"]);
  });

  test("sweeps the jpeg screenshots too, by default", async () => {
    // Screenshots are written as tab-<id>-<ms>.jpg now; a png-only default
    // left every one of them behind.
    await shot("tab-1-1.jpg", 8 * HOUR);
    await shot("old.jpeg", 8 * HOUR);
    await shot("tab-1-2.jpg", 1 * HOUR);
    assert.equal(await pruneScreenshots(dir), 2);
    assert.deepEqual(await names(), ["tab-1-2.jpg"]);
  });

  test("leaves non-image files alone", async () => {
    await shot("old.png", 8 * HOUR);
    const other = join(dir, "notes.txt");
    await writeFile(other, "keep me");
    const when = new Date(Date.now() - 8 * HOUR);
    await utimes(other, when, when);
    await pruneScreenshots(dir);
    assert.deepEqual(await names(), ["notes.txt"]);
  });

  test("returns 0 and does not throw when the directory is missing", async () => {
    assert.equal(await pruneScreenshots(join(dir, "nope")), 0);
  });

  test("returns 0 on an empty directory", async () => {
    await mkdir(join(dir, "empty"), { recursive: true });
    assert.equal(await pruneScreenshots(join(dir, "empty")), 0);
  });

  test("reports how many it removed", async () => {
    await shot("a.png", 8 * HOUR);
    await shot("b.png", 9 * HOUR);
    await shot("c.png", 1 * HOUR);
    assert.equal(await pruneScreenshots(dir), 2);
  });
});
