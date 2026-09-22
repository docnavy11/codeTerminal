import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile, utimes, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { savePastedImage, pasteExtension, MAX_PASTE_BYTES } from "../src/pasted.js";
import { pruneScreenshots } from "../src/screenshots.js";

let dir: string;
const dirs: string[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ct-paste-test-")); dirs.push(dir); });
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("savePastedImage", () => {
  test("writes the bytes and hands back the path", async () => {
    const { path, bytes } = await savePastedImage(png, "image/png", dir);
    assert.equal(bytes, png.length);
    assert.equal(dirname(path), dir);
    assert.deepEqual(await readFile(path), png);
  });

  test("the file is private — a paste can be a screenshot of a logged-in page", async () => {
    const { path } = await savePastedImage(png, "image/png", dir);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  });

  test("the extension follows the media type, parameters and all", async () => {
    const { path } = await savePastedImage(png, "image/jpeg; charset=binary", dir);
    assert.ok(path.endsWith(".jpg"), path);
    assert.equal(pasteExtension("IMAGE/WEBP"), "webp");
    assert.equal(pasteExtension("application/pdf"), null);
  });

  test("two pastes in the same millisecond do not collide", async () => {
    const now = 1_700_000_000_000;
    const a = await savePastedImage(png, "image/png", dir, now);
    const b = await savePastedImage(png, "image/png", dir, now);
    assert.notEqual(a.path, b.path);
  });

  test("refuses what it cannot take", async () => {
    await assert.rejects(savePastedImage(png, "application/pdf", dir), /not an image/);
    await assert.rejects(savePastedImage(Buffer.alloc(0), "image/png", dir), /empty/);
    await assert.rejects(savePastedImage(Buffer.alloc(MAX_PASTE_BYTES + 1), "image/png", dir), /limit/);
  });
});

describe("pruneScreenshots extensions", () => {
  test("sweeps the paste spool's other image types, and nothing else", async () => {
    for (const n of ["old.png", "old.jpg", "old.webp", "notes.txt"]) {
      const p = join(dir, n);
      await writeFile(p, png);
      const when = new Date(Date.now() - 8 * 3600_000);
      await utimes(p, when, when);
    }
    await pruneScreenshots(dir, { extensions: [".png", ".jpg", ".gif", ".webp"] });
    assert.deepEqual(await readdir(dir), ["notes.txt"]);
  });
});
