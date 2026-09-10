import { readdir, stat, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { resolve, join, dirname, relative, basename, sep } from "node:path";
import { createReadStream } from "node:fs";

export type Entry = {
  name: string;
  kind: "dir" | "file" | "other";
  size: number;
  mtime: number;
};

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

/** Best-effort text sniff: NUL byte in the first 8k means treat it as binary. */
export async function readTextPreview(abs: string, maxBytes: number) {
  const buf = await readFile(abs);
  const head = buf.subarray(0, Math.min(8192, buf.length));
  if (head.includes(0)) return null;
  const slice = buf.subarray(0, maxBytes);
  return {
    text: slice.toString("utf8"),
    truncated: buf.length > maxBytes,
    bytes: buf.length,
  };
}
