import { readdir, stat, lstat, open, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join, dirname, relative, basename, sep } from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { rename, unlink } from "node:fs/promises";

export type Entry = {
  name: string;
  kind: "dir" | "file" | "other";
  size: number;
  mtime: number;
};

/**
 * Absolute directories the browser must never reach, even though they sit
 * inside the root. The default root is the home directory, which contains the
 * Claude OAuth credentials, SSH keys and cloud tokens — reading
 * `.claude/.credentials.json` through the file browser hands over the account.
 * Configured once at startup by the server; matched by realpath so a symlink
 * cannot sidestep it.
 */
let DENIED: string[] = [];

/** Set the blocked subtrees. Paths that do not resolve are dropped quietly. */
export async function setDeniedPaths(paths: string[]): Promise<void> {
  const out: string[] = [];
  for (const p of paths) {
    try { out.push(await realpath(resolve(p))); } catch { /* not present: nothing to hide */ }
  }
  DENIED = out;
}

function isDenied(finalPath: string): boolean {
  return DENIED.some((d) => finalPath === d || finalPath.startsWith(d + sep));
}

/**
 * Every path from the client goes through here.
 *
 * `path.resolve` collapses `..` but does NOT follow symlinks, so a symlink
 * inside the root pointing at /etc would pass a string-only check. We realpath
 * the deepest component that actually exists, then test containment on that —
 * which also lets an upload name a file that does not exist yet.
 */
export async function safePath(root: string, requested: string | undefined): Promise<string> {
  const rootReal = await realpath(resolve(root));
  const target = resolve(rootReal, requested && requested.length ? requested : ".");

  // Walk up until something exists, remembering the tail we peeled off.
  let probe = target;
  const tail: string[] = [];
  for (;;) {
    try {
      probe = await realpath(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) throw new Error("path does not resolve");
      tail.unshift(basename(probe));
      probe = parent;
    }
  }

  const finalPath = tail.length ? join(probe, ...tail) : probe;
  if (finalPath !== rootReal && !finalPath.startsWith(rootReal + sep)) {
    throw new Error("path is outside the browsable root");
  }
  // realpath has resolved any symlink, so a link pointing into ~/.ssh is caught
  // here just as a direct path would be.
  if (isDenied(finalPath)) throw new Error("that path is blocked (credentials or keys)");
  return finalPath;
}

/** Path shown to the client: relative to root, POSIX-ish, "" for the root. */
export function toRel(root: string, abs: string): string {
  const r = relative(resolve(root), abs);
  return r === "" ? "" : r.split(sep).join("/");
}

export async function list(root: string, requested?: string) {
  const abs = await safePath(root, requested);
  const st = await stat(abs);
  if (!st.isDirectory()) throw new Error("not a directory");

  const names = await readdir(abs);
  const entries: Entry[] = [];
  for (const name of names) {
    try {
      // lstat semantics via stat(): a broken symlink should not kill the listing.
      const s = await stat(join(abs, name));
      entries.push({
        name,
        kind: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other",
        size: s.size,
        mtime: s.mtimeMs,
      });
    } catch {
      entries.push({ name, kind: "other", size: 0, mtime: 0 });
    }
  }
  // Directories first, then case-insensitive by name.
  entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : a.kind === "dir" ? -1 : b.kind === "dir" ? 1 : 0,
  );

  const rel = toRel(root, abs);
  return {
    path: rel,
    parent: rel === "" ? null : toRel(root, dirname(abs)),
    entries,
  };
}

export async function statFile(root: string, requested: string) {
  const abs = await safePath(root, requested);
  const s = await stat(abs);
  if (!s.isFile()) throw new Error("not a file");
  return { abs, size: s.size, mtime: s.mtimeMs, name: basename(abs) };
}

export function streamFile(abs: string) {
  return createReadStream(abs);
}

/** Writes into `dir`, refusing anything that tries to escape it via the name. */
export async function saveUpload(root: string, dir: string | undefined, name: string, body: Buffer) {
  const clean = basename(name);          // strips any path the client sent
  if (!clean || clean === "." || clean === "..") throw new Error("bad filename");
  const dirAbs = await safePath(root, dir);
  const target = await safePath(root, join(toRel(root, dirAbs), clean));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
  const s = await stat(target);
  return { path: toRel(root, target), size: s.size };
}

/**
 * Streaming upload: bytes go straight to a .tmp beside the target and are
 * renamed into place at the end, so a 100 MB upload never sits in memory.
 * The limit is enforced while streaming; an oversize body is cut off and the
 * partial file removed.
 */
export async function saveUploadStream(
  root: string, dir: string | undefined, name: string, body: Readable, limitBytes: number,
) {
  const clean = basename(name);
  if (!clean || clean === "." || clean === "..") throw new Error("bad filename");
  const dirAbs = await safePath(root, dir);
  const target = await safePath(root, join(toRel(root, dirAbs), clean));
  await mkdir(dirname(target), { recursive: true });

  const tmp = `${target}.upload-${process.pid}-${Date.now()}.tmp`;
  let seen = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limitBytes) return cb(new Error(`upload exceeds ${limitBytes} bytes`));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, guard, createWriteStream(tmp, { mode: 0o600 }));
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  const s = await stat(target);
  return { path: toRel(root, target), size: s.size };
}

/**
 * Resolve a batch of names inside one directory for zipping.
 *
 * Every name goes through safePath, so a crafted entry cannot reach outside
 * the root, and directories are walked rather than silently skipped — a user
 * ticking a folder means "and everything in it".
 */
export async function collectForZip(
  root: string,
  dir: string | undefined,
  names: string[],
  limitBytes: number,
): Promise<{ entries: { abs: string; name: string }[]; bytes: number }> {
  const dirAbs = await safePath(root, dir);
  const entries: { abs: string; name: string }[] = [];
  let bytes = 0;

  const walk = async (abs: string, rel: string): Promise<void> => {
    // lstat, not stat: containment was checked on the *selected* name via
    // safePath, but a symlink discovered while walking a directory was never
    // re-checked — stat() follows it, so a link to /etc inside a ticked folder
    // pulled /etc into the zip. Skipping symlinks closes that, and also removes
    // the symlink-loop route into infinite recursion. Links are not followed in
    // a bulk zip; a user who wants a link's target selects the target.
    const st = await lstat(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      for (const child of await readdir(abs)) {
        await walk(join(abs, child), `${rel}/${child}`);
      }
      return;
    }
    if (!st.isFile()) return;                 // sockets, devices: skip quietly
    bytes += st.size;
    if (bytes > limitBytes) throw new Error("selection is too large to zip");
    entries.push({ abs, name: rel });
  };

  for (const raw of names) {
    const clean = basename(raw);
    if (!clean || clean === "." || clean === "..") continue;
    const abs = await safePath(root, join(toRel(root, dirAbs), clean));
    await walk(abs, clean);
  }
  return { entries, bytes };
}

/**
 * Best-effort text sniff: NUL byte in the first 8k means treat it as binary.
 *
 * Reads at most `maxBytes`, never the whole file. The previous version did
 * `readFile(abs)` first and sliced after — so previewing a 400 MB log pulled
 * 400 MB into RSS (measured) before returning a 256 KB slice, and a few at once
 * could OOM the process and take every live session down with it.
 */
export async function readTextPreview(abs: string, maxBytes: number) {
  const fh = await open(abs, "r");
  try {
    const size = (await fh.stat()).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    const data = buf.subarray(0, bytesRead);
    if (data.subarray(0, Math.min(8192, data.length)).includes(0)) return null;
    return {
      text: data.toString("utf8"),
      truncated: size > maxBytes,
      bytes: size,
    };
  } finally {
    await fh.close();
  }
}
