import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath, toRel, list, saveUpload, readTextPreview, collectForZip } from "../src/files.js";

/**
 * safePath is the only thing standing between a path from the browser and the
 * filesystem. These cases exist because two of them have already been wrong:
 * symlink containment (allowed until realpath was added) and upload filenames.
 */
let root: string;
let outside: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "ct-files-test-"));
  outside = await mkdtemp(join(tmpdir(), "ct-outside-"));
  await writeFile(join(outside, "secret.txt"), "must not be reachable");

  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "ok.txt"), "fine");
  await writeFile(join(root, "a.txt"), "a");
  await mkdir(join(root, "zdir"), { recursive: true });
  await symlink(outside, join(root, "escape-dir"));
  await symlink(join(outside, "secret.txt"), join(root, "escape-file"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("safePath: paths that must be allowed", () => {
  for (const [input, why] of [
    ["", "the root itself"],
    [".", "explicit dot"],
    ["sub", "a subdirectory"],
    ["sub/ok.txt", "a file"],
    ["sub/./../sub/ok.txt", "noisy but legal"],
    ["newfile.txt", "does not exist yet — an upload target"],
    ["sub/deep/new.txt", "nested and does not exist"],
  ] as const) {
    test(`${JSON.stringify(input)} — ${why}`, async () => {
      const p = await safePath(root, input);
      assert.ok(p === root || p.startsWith(root + "/"), `${p} escaped ${root}`);
    });
  }
});

describe("safePath: paths that must be refused", () => {
  for (const [input, why] of [
    ["..", "parent directory"],
    ["../..", "grandparent"],
    ["sub/../..", "traversal back out through a subdirectory"],
    ["/etc/passwd", "an absolute path elsewhere"],
    ["escape-dir", "a symlink pointing outside the root"],
    ["escape-dir/secret.txt", "a file reached through that symlink"],
    ["escape-file", "a symlinked file outside the root"],
  ] as const) {
    test(`${JSON.stringify(input)} — ${why}`, async () => {
      await assert.rejects(() => safePath(root, input), /outside the browsable root|does not resolve/);
    });
  }
});

test("safePath resolves symlinks rather than trusting the string", async () => {
  // path.resolve alone would accept this: it only collapses "..".
  await assert.rejects(() => safePath(root, "escape-dir/secret.txt"));
  const leaked = await readFile(join(outside, "secret.txt"), "utf8");
  assert.equal(leaked, "must not be reachable", "fixture sanity");
});

describe("uploads", () => {
  test("a filename cannot climb out of the directory", async () => {
    const r = await saveUpload(root, "sub", "../../../../tmp/escaped.txt", Buffer.from("x"));
    assert.equal(r.path, "sub/escaped.txt", "basename must strip the path");
  });

  test("an absolute filename is reduced to its basename", async () => {
    const r = await saveUpload(root, "", "/etc/passwd", Buffer.from("x"));
    assert.equal(r.path, "passwd");
  });

  for (const bad of ["", ".", ".."]) {
    test(`refuses the filename ${JSON.stringify(bad)}`, async () => {
      await assert.rejects(() => saveUpload(root, "", bad, Buffer.from("x")), /bad filename/);
    });
  }

  test("writes into a directory that does not exist yet", async () => {
    const r = await saveUpload(root, "fresh/nested", "f.txt", Buffer.from("hello"));
    assert.equal(r.path, "fresh/nested/f.txt");
    assert.equal(r.size, 5);
  });
});

describe("list", () => {
  test("directories sort before files", async () => {
    const d = await list(root, "");
    const kinds = d.entries.map((e) => e.kind);
    assert.deepEqual(kinds, [...kinds].sort((a, b) => (a === "dir" ? -1 : b === "dir" ? 1 : 0)));
  });

  test("reports a parent for a subdirectory and none for the root", async () => {
    assert.equal((await list(root, "")).parent, null);
    assert.equal((await list(root, "sub")).parent, "");
  });

  test("refuses to list outside the root", async () => {
    await assert.rejects(() => list(root, ".."));
  });

  test("a broken symlink does not abort the listing", async () => {
    await symlink(join(outside, "gone"), join(root, "dangling"));
    const d = await list(root, "");
    assert.ok(d.entries.some((e) => e.name === "dangling"));
  });
});

describe("text preview", () => {
  test("returns text for a text file", async () => {
    const p = await safePath(root, "a.txt");
    assert.equal((await readTextPreview(p, 1024))?.text, "a");
  });

  test("returns null for binary, so callers offer a download", async () => {
    await writeFile(join(root, "bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const p = await safePath(root, "bin");
    assert.equal(await readTextPreview(p, 1024), null);
  });

  test("flags truncation rather than silently cutting", async () => {
    await writeFile(join(root, "big.txt"), "x".repeat(5000));
    const p = await safePath(root, "big.txt");
    const r = await readTextPreview(p, 100);
    assert.equal(r?.truncated, true);
    assert.equal(r?.bytes, 5000);
  });
});

test("toRel is empty at the root and relative below it", async () => {
  assert.equal(toRel(root, root), "");
  assert.equal(toRel(root, join(root, "sub", "ok.txt")), "sub/ok.txt");
});

describe("collectForZip", () => {
  test("collects the named files", async () => {
    const { entries } = await collectForZip(root, "", ["a.txt"], 1e9);
    assert.deepEqual(entries.map((e) => e.name), ["a.txt"]);
  });

  test("walks a directory rather than skipping it", async () => {
    // Ticking a folder means "and everything in it".
    const { entries } = await collectForZip(root, "", ["sub"], 1e9);
    assert.ok(entries.some((e) => e.name === "sub/ok.txt"), JSON.stringify(entries));
  });

  test("a crafted name is basenamed rather than followed", async () => {
    // "../../etc/passwd" must become "passwd" inside the root. An earlier test
    // put a file of that name there, so this resolves to the fixture — never
    // to /etc/passwd. Asserting the resolved path is the point; asserting a
    // rejection would pass for the wrong reason on a machine without it.
    const { entries } = await collectForZip(root, "", ["../../etc/passwd"], 1e9);
    assert.deepEqual(entries.map((e) => e.name), ["passwd"]);
    assert.ok(entries[0].abs.startsWith(root + "/"), entries[0].abs);
    assert.ok(!entries[0].abs.startsWith("/etc/"), "must not reach the real /etc");
  });

  test("a name that does not exist is refused", async () => {
    await assert.rejects(() => collectForZip(root, "", ["nope-not-here.txt"], 1e9));
  });

  test("a symlink pointing outside the root is refused", async () => {
    await assert.rejects(() => collectForZip(root, "", ["escape-file"], 1e9));
  });

  // The real hole: selecting a symlink directly is caught by safePath, but a
  // symlink *inside* a ticked directory was walked with stat() (which follows
  // it), pulling whatever it pointed at into the zip. A folder holding a link
  // to /etc leaked /etc. The walk must not follow links discovered mid-walk.
  test("a symlink nested inside a selected directory is not followed", async () => {
    await mkdir(join(root, "bundle"), { recursive: true });
    await writeFile(join(root, "bundle", "real.txt"), "legit");
    await symlink(outside, join(root, "bundle", "nested-escape"));
    await symlink(join(outside, "secret.txt"), join(root, "bundle", "nested-escape-file"));

    const { entries } = await collectForZip(root, "", ["bundle"], 1e9);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("bundle/real.txt"), `real file kept: ${JSON.stringify(names)}`);
    // Nothing whose real target lives outside the root.
    for (const e of entries) {
      const real = await realpath(e.abs);
      assert.ok(real.startsWith(root + "/"), `leaked via symlink: ${e.name} -> ${real}`);
    }
    assert.ok(!names.some((n) => n.includes("secret")), "the outside secret must not appear");
  });

  test("a symlink loop inside a selected directory does not hang", async () => {
    await mkdir(join(root, "loopdir"), { recursive: true });
    await writeFile(join(root, "loopdir", "x.txt"), "x");
    await symlink(join(root, "loopdir"), join(root, "loopdir", "self"));  // points at itself
    const { entries } = await collectForZip(root, "", ["loopdir"], 1e9);
    assert.deepEqual(entries.map((e) => e.name), ["loopdir/x.txt"]);
  });

  test("refuses a selection over the size limit", async () => {
    await assert.rejects(() => collectForZip(root, "", ["big.txt"], 10), /too large/);
  });

  test("skips . and .. without throwing", async () => {
    const { entries } = await collectForZip(root, "", [".", "..", "a.txt"], 1e9);
    assert.deepEqual(entries.map((e) => e.name), ["a.txt"]);
  });

  test("reports the total size", async () => {
    const { bytes } = await collectForZip(root, "", ["a.txt"], 1e9);
    assert.equal(bytes, 1);
  });
});
