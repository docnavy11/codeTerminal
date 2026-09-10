import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SHOT_DIR = join(tmpdir(), "code-terminal-screenshots");

/** Anything newer than this is never touched — the agent may be about to Read it. */
const KEEP_RECENT_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_FILES = 40;

export type PruneOptions = {
  keepRecentMs?: number;
  maxAgeMs?: number;
  maxFiles?: number;
  now?: number;
};

/**
 * Screenshots are a byproduct: written once, read once, then dead weight — and
 * a long-running service accumulates them forever.
 *
 * The one rule that matters is the recency floor. A screenshot's whole purpose
 * is that the agent Reads the path a moment later, so deleting a fresh file to
 * satisfy a count limit would break the feature it is tidying up after.
 *
 * Never throws: tidying up must not be able to fail a screenshot.
 */
export async function pruneScreenshots(dir = SHOT_DIR, opts: PruneOptions = {}): Promise<number> {
  const keepRecentMs = opts.keepRecentMs ?? KEEP_RECENT_MS;
  const maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
  const maxFiles = opts.maxFiles ?? MAX_FILES;
  const now = opts.now ?? Date.now();

  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".png"));
  } catch {
    return 0; // no directory yet
  }

  const files: { path: string; mtime: number }[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      files.push({ path, mtime: (await stat(path)).mtimeMs });
    } catch {
      // vanished between readdir and stat; nothing to do
    }
  }
  files.sort((a, b) => b.mtime - a.mtime); // newest first

  let removed = 0;
  for (const [i, f] of files.entries()) {
    const age = now - f.mtime;
    if (age < keepRecentMs) continue;
    if (age <= maxAgeMs && i < maxFiles) continue;
    try {
      await unlink(f.path);
      removed++;
    } catch {
      // already gone, or not ours to delete
    }
  }
  return removed;
}
