import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath, toRel, list, saveUpload, saveUploadStream, readTextPreview, collectForZip, setDeniedPaths, partialUtf8Tail } from "../src/files.js";
import { Readable } from "node:stream";

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

  // The preview reads at most `maxBytes`, never the whole file — a 400 MB log
  // used to pull 400 MB into RSS before returning a 256 KB slice. Proven here
  // by the shape: text is exactly the cap while `bytes` reports the full size,
  // which is only possible if it read the cap and stat'd the rest.
  test("reads only up to the cap, not the whole file", async () => {
    await writeFile(join(root, "huge.txt"), "y".repeat(1_000_000));
    const p = await safePath(root, "huge.txt");
    const r = await readTextPreview(p, 4096);
    assert.equal(r?.text.length, 4096, "returned exactly the cap");
    assert.equal(r?.bytes, 1_000_000, "reported the full size");
    assert.equal(r?.truncated, true);
  });
});

test("toRel is empty at the root and relative below it", async () => {
  assert.equal(toRel(root, root), "");
  assert.equal(toRel(root, join(root, "sub", "ok.txt")), "sub/ok.txt");
});

test("a root reached through a symlink still lists and resolves relative to itself", async () => {
  // The paths list() hands back went through realpath; toRel did not, so they
  // came out as "../../real/sub" and were refused when sent back.
  const link = join(root, "..", `link-${Date.now()}`);
  await symlink(root, link);
  try {
    const l = await list(link, "sub");
    assert.equal(l.path, "sub");
    assert.ok(await safePath(link, l.path));
  } finally { await rm(link, { force: true }); }
});

// M3: the file browser opens on the home directory, which holds the Claude
// credentials and SSH keys. safePath blocks a denylist of subtrees even though
// they sit inside the root — a browser download of ~/.claude/.credentials.json
// hands over the account.
describe("denied paths (credentials, keys)", () => {
  before(async () => {
    await mkdir(join(root, "secretdir"), { recursive: true });
    await writeFile(join(root, "secretdir", "token"), "SENSITIVE");
    await writeFile(join(root, "loose.key"), "SENSITIVE");
    await setDeniedPaths([join(root, "secretdir"), join(root, "loose.key")]);
  });
  after(async () => { await setDeniedPaths([]); });   // don't leak into other tests

  test("refuses a denied directory and everything under it", async () => {
    await assert.rejects(() => safePath(root, "secretdir"), /blocked/);
    await assert.rejects(() => safePath(root, "secretdir/token"), /blocked/);
  });

  test("refuses a denied file", async () => {
    await assert.rejects(() => safePath(root, "loose.key"), /blocked/);
  });

  test("a symlink into a denied subtree is refused too", async () => {
    await symlink(join(root, "secretdir", "token"), join(root, "sneaky"));
    await assert.rejects(() => safePath(root, "sneaky"), /blocked/);
  });

  test("does not block a sibling whose name merely starts the same", async () => {
    // "secretdir2" must not be caught by a naive prefix match on "secretdir".
    await mkdir(join(root, "secretdir2"), { recursive: true });
    await writeFile(join(root, "secretdir2", "ok.txt"), "fine");
    assert.ok((await safePath(root, "secretdir2/ok.txt")).endsWith("secretdir2/ok.txt"));
  });

  test("leaves everything else readable", async () => {
    assert.ok((await safePath(root, "a.txt")).endsWith("a.txt"));
  });

  test(".env files are blocked by name anywhere; templates are not", async () => {
    await mkdir(join(root, "app"), { recursive: true });
    for (const n of [".env", ".env.local", ".env.production", ".env.example", ".envrc"]) await writeFile(join(root, "app", n), "X=1");
    for (const n of [".env", ".env.local", ".env.production"]) await assert.rejects(() => safePath(root, `app/${n}`), /blocked/, n);
    for (const n of [".env.example", ".envrc"]) assert.ok(await safePath(root, `app/${n}`), n);
    const { entries } = await collectForZip(root, "", ["app"], 1e9);
    assert.deepEqual(entries.map((e) => e.name).sort(), ["app/.env.example", "app/.envrc"]);
  });

  test("zipping a folder leaves out what the denylist covers inside it", async () => {
    // Only the ticked names went through safePath: ticking a project zipped its .env.
    await mkdir(join(root, "proj", "nested"), { recursive: true });
    await writeFile(join(root, "proj", ".env"), "TOKEN=SENSITIVE");
    await writeFile(join(root, "proj", "nested", "creds.json"), "SENSITIVE");
    await writeFile(join(root, "proj", "readme.md"), "fine");
    await setDeniedPaths([join(root, "secretdir"), join(root, "loose.key"), join(root, "proj", ".env"), join(root, "proj", "nested")]);
    const { entries } = await collectForZip(root, "", ["proj"], 1e9);
    assert.deepEqual(entries.map((e) => e.name), ["proj/readme.md"]);
  });
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

describe("saveUploadStream (streamed upload)", () => {

  test("writes the body to the target and basenames the client name", async () => {
    const r = await saveUploadStream(root, "sub", "../../evil/up.txt", Readable.from([Buffer.from("hello"), Buffer.from(" world")]), 1e6);
    assert.equal(r.path, "sub/up.txt");
    assert.equal(await readFile(join(root, "sub", "up.txt"), "utf8"), "hello world");
  });

  test("refuses an oversize body mid-stream and leaves no partial file", async () => {
    await assert.rejects(
      () => saveUploadStream(root, "sub", "big.bin", Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1000),
      /exceeds/);
    const left = (await readdir(join(root, "sub"))).filter((n) => n.includes("big.bin"));
    assert.deepEqual(left, [], `partial/temp files left behind: ${left}`);
  });

  // The whole point: express.raw() held up to MAX_UPLOAD in memory. Stream
  // 120 MB through and the process must not grow by anything like that.
  test("does not buffer the upload in memory", async () => {
    const MB = 1048576;
    const chunk = Buffer.alloc(MB, 7);
    async function* gen() { for (let i = 0; i < 120; i++) yield chunk; }
    (globalThis as { gc?: () => void }).gc?.();
    const before = process.memoryUsage().rss;
    const r = await saveUploadStream(root, "", "stream.bin", Readable.from(gen()), 200 * MB);
    const grew = (process.memoryUsage().rss - before) / MB;
    assert.equal(r.size, 120 * MB);
    assert.ok(grew < 40, `RSS grew ${grew.toFixed(0)} MB for a 120 MB upload — it is buffering`);
    await rm(join(root, "stream.bin"), { force: true });
  });
});

describe("preview does not split a multibyte character", () => {
  test("partialUtf8Tail", () => {
    const e = new TextEncoder();
    assert.equal(partialUtf8Tail(e.encode("abc")), 0);
    assert.equal(partialUtf8Tail(e.encode("aé")), 0);                 // complete 2-byte
    assert.equal(partialUtf8Tail(e.encode("aé").subarray(0, 2)), 1);  // lead byte only
    assert.equal(partialUtf8Tail(e.encode("a€").subarray(0, 3)), 2);  // 2 of 3 bytes
    assert.equal(partialUtf8Tail(e.encode("😀").subarray(0, 3)), 3);  // 3 of 4 bytes
    assert.equal(partialUtf8Tail(new Uint8Array(0)), 0);
  });
  test("a truncated preview ends on a whole character", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const d = await mkdtemp(join(tmpdir(), "ct-utf8-"));
    const p = join(d, "u.txt");
    await writeFile(p, "ab€€€");            // 2 + 3*3 = 11 bytes
    const r = await readTextPreview(p, 4);  // cuts inside the first €
    assert.equal(r?.text, "ab");
    assert.equal(r?.truncated, true);
    assert.ok(!r?.text.includes("\uFFFD"));
    await rm(d, { recursive: true, force: true });
  });
});

describe("list marks a symlink that escapes the root", () => {
  test("an escaping link is 'other', an internal one keeps its kind", async () => {
    const { mkdtemp, writeFile, symlink, rm, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = await mkdtemp(join(tmpdir(), "ct-ln-"));
    const root = join(base, "root"); await mkdir(root);
    await writeFile(join(base, "secret.txt"), "outside");
    await writeFile(join(root, "in.txt"), "inside");
    await symlink(join(base, "secret.txt"), join(root, "escape"));
    await symlink(join(root, "in.txt"), join(root, "alias"));
    const { entries } = await list(root);
    const kind = (n: string) => entries.find((e) => e.name === n)?.kind;
    assert.equal(kind("escape"), "other");
    assert.equal(kind("alias"), "file");
    assert.equal(kind("in.txt"), "file");
    await rm(base, { recursive: true, force: true });
  });
});

describe("makeDirectory", () => {
  test("creates inside the root; refuses escapes, existing names, bad names and missing parents", async () => {
    const { mkdtemp, mkdir, writeFile, rm, stat } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { makeDirectory, setDeniedPaths } = await import("../src/files.js");
    const base = await mkdtemp(join(tmpdir(), "ct-mkdir-"));
    const root = join(base, "root"); await mkdir(join(root, "keep"), { recursive: true });
    await writeFile(join(root, "file.txt"), "x");
    await setDeniedPaths([join(root, "keep")]);
    try {
      assert.deepEqual(await makeDirectory(root, "", "new one"), { path: "new one" });
      assert.ok((await stat(join(root, "new one"))).isDirectory());
      assert.deepEqual(await makeDirectory(root, "new one", "  nested  "), { path: "new one/nested" });
      assert.deepEqual(await makeDirectory(root, "", "../../escaped"), { path: "escaped" }, "basename'd like an upload");
      await assert.rejects(makeDirectory(root, "..", "x"), /outside/);
      await assert.rejects(makeDirectory(root, "keep", "x"), /blocked/);
      await assert.rejects(makeDirectory(root, "", "file.txt"), /already exists/);
      await assert.rejects(makeDirectory(root, "", "new one"), /already exists/);
      await assert.rejects(makeDirectory(root, "", ""), /bad folder name/);
      await assert.rejects(makeDirectory(root, "", "."), /bad folder name/);
      await assert.rejects(makeDirectory(root, "", "   "), /bad folder name/);
      await assert.rejects(makeDirectory(root, "nowhere", "x"), /does not resolve|does not exist/);
    } finally { await setDeniedPaths([]); await rm(base, { recursive: true, force: true }); }
  });
});

describe("suggest (@file completion)", () => {
  test("walks the directory once, skips build dirs and the denylist, ranks basename prefix > substring > subsequence", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { suggest, clearSuggestCache, setDeniedPaths } = await import("../src/files.js");
    const root = await mkdtemp(join(tmpdir(), "ct-suggest-"));
    for (const d of ["src/lib", "node_modules/x", ".git", "secret"]) await mkdir(join(root, d), { recursive: true });
    for (const f of ["src/index.ts", "src/lib/loader.ts", "src/lib/preloader.ts", "node_modules/x/loader.js", ".git/config", "secret/key", "README.md", "load.txt"]) await writeFile(join(root, f), "");
    await setDeniedPaths([join(root, "secret")]);
    try {
      clearSuggestCache();
      const paths = (await suggest(root, "", "load")).map((e) => e.path);
      assert.deepEqual(paths.slice(0, 3), ["load.txt", "src/lib/loader.ts", "src/lib/preloader.ts"], paths);
      assert.ok(!paths.some((p) => p.includes("node_modules") || p.startsWith(".git") || p.startsWith("secret")), paths);
      assert.deepEqual((await suggest(root, "src", "")).map((e) => e.path + (e.dir ? "/" : "")).sort(), ["index.ts", "lib/", "lib/loader.ts", "lib/preloader.ts"]);
      assert.deepEqual((await suggest(root, "", "sll")).map((e) => e.path), ["src/lib/loader.ts", "src/lib/preloader.ts"], "subsequence");
      assert.equal((await suggest(root, "", "zzz")).length, 0);
      assert.equal((await suggest(root, "", "", 2)).length, 2, "limit");
      await writeFile(join(root, "loadnew.ts"), "");
      assert.ok(!(await suggest(root, "", "loadnew")).length, "cached for a few seconds");
      clearSuggestCache();
      assert.equal((await suggest(root, "", "loadnew")).length, 1);
      await assert.rejects(suggest(root, "..", "x"), /outside/);
      await assert.rejects(suggest(root, "secret", "k"), /blocked/);
    } finally { await setDeniedPaths([]); await rm(root, { recursive: true, force: true }); }
  });
});
