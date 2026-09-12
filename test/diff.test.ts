import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewDiff, lineDiff, DIFF_MAX_LINES } from "../src/diff.js";

let cwd: string;
before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ct-diff-"));
  await writeFile(join(cwd, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  await writeFile(join(cwd, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n") + "\n");
});
after(async () => { await rm(cwd, { recursive: true, force: true }); });

const render = (lines: { t: string; s: string }[]) => lines.map((l) => l.t + l.s).join("|");

describe("previewDiff", () => {
  test("Edit: the change in place with three lines of context, a relative path, counts", async () => {
    const d = (await previewDiff("Edit", { file_path: join(cwd, "a.txt"), old_string: "five", new_string: "FIVE\nfive and a half" }, cwd))!;
    assert.equal(d.kind, "edit"); assert.equal(d.path, "a.txt"); assert.equal(d.adds, 2); assert.equal(d.dels, 1); assert.equal(d.truncated, false);
    assert.equal(render(d.lines), "@line 2| two| three| four|-five|+FIVE|+five and a half| six| seven| eight");
  });
  test("Edit: replace_all, MultiEdit, old_string missing, file missing, unreadable", async () => {
    await writeFile(join(cwd, "r.txt"), "x\ny\nx\n");
    assert.equal((await previewDiff("Edit", { file_path: "r.txt", old_string: "x", new_string: "z", replace_all: true }, cwd))!.dels, 2);
    assert.equal((await previewDiff("Edit", { file_path: "r.txt", old_string: "x", new_string: "z" }, cwd))!.dels, 1);
    const me = (await previewDiff("MultiEdit", { file_path: "r.txt", edits: [{ old_string: "x", new_string: "1" }, { old_string: "y", new_string: "2" }] }, cwd))!;
    assert.equal(me.adds, 2); assert.equal(me.dels, 2);
    assert.match((await previewDiff("Edit", { file_path: "r.txt", old_string: "nope", new_string: "z" }, cwd))!.note!, /not found/);
    assert.match((await previewDiff("Edit", { file_path: "missing.txt", old_string: "a", new_string: "b" }, cwd))!.note!, /does not exist/);
    const unreadable = await previewDiff("Edit", { file_path: "a.txt", old_string: "a", new_string: "b" }, cwd, (async () => { throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" }); }) as never);
    assert.match(unreadable!.note!, /could not read/);
  });
  test("Write: new file, rewrite, identical, and a whole-file rewrite too large to diff", async () => {
    const c = (await previewDiff("Write", { file_path: "new.txt", content: "a\nb\n" }, cwd))!;
    assert.equal(c.kind, "create"); assert.equal(render(c.lines), "+a|+b"); assert.equal(c.adds, 2);
    const w = (await previewDiff("Write", { file_path: "a.txt", content: "one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\n" }, cwd))!;
    assert.equal(w.kind, "write"); assert.equal(render(w.lines), "@line 1| one| two|-three|+THREE| four| five| six");
    assert.match((await previewDiff("Write", { file_path: "a.txt", content: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n" }, cwd))!.note!, /identical/);
    const big = (await previewDiff("Write", { file_path: "big.txt", content: "x\n" }, cwd))!;
    assert.equal(big.truncated, true); assert.match(big.note!, /3000 → 1 lines/);
  });
  test("Edit in a big file diffs only the window around the change", async () => {
    const d = (await previewDiff("Edit", { file_path: "big.txt", old_string: "line 1500", new_string: "LINE 1500" }, cwd))!;
    assert.equal(d.adds, 1); assert.equal(d.dels, 1); assert.ok(d.lines.length < 12);
    assert.equal(d.lines[0].s, "line 1498", "numbered from the real position");
  });
  test("other tools and inputs without a path: null; a path outside cwd stays absolute", async () => {
    assert.equal(await previewDiff("Bash", { command: "ls" }, cwd), null);
    assert.equal(await previewDiff("Edit", { old_string: "a" }, cwd), null);
    assert.equal((await previewDiff("Edit", { file_path: "/etc/hostname", old_string: "zz", new_string: "" }, cwd))!.path, "/etc/hostname");
  });
  test("a very long diff is cut at DIFF_MAX_LINES with the flag set", async () => {
    const d = (await previewDiff("Write", { file_path: "long.txt", content: Array.from({ length: 900 }, (_, i) => `l${i}`).join("\n") }, cwd))!;
    assert.equal(d.truncated, true); assert.equal(d.lines.length, DIFF_MAX_LINES); assert.equal(d.adds, 900);
  });
});

describe("lineDiff", () => {
  test("hunks are separated and numbered; unchanged files give nothing", () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`); const b = [...a]; b[2] = "X"; b[25] = "Y";
    const out = lineDiff(a, b);
    assert.deepEqual(out.filter((l) => l.t === "@").map((l) => l.s), ["line 1", "line 23"]);
    assert.equal(out.filter((l) => l.t === " ").length, 6 + 6 - 1, "3 lines of context each side, clipped at the file start");
    assert.deepEqual(lineDiff(a, a), []);
    assert.deepEqual(lineDiff([], ["a"]), [{ t: "@", s: "line 1" }, { t: "+", s: "a" }]);
  });
});
