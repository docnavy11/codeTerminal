import { mkdir, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneScreenshots } from "./screenshots.js";

/**
 * Images pasted into the terminal pane. The CLI running in there reads files,
 * not clipboards, so a pasted picture has to become a path on this machine
 * first — that path is then typed into the pty, and the CLI reads it.
 *
 * Same shape as the screenshot spool next door: a private dir in /tmp (a paste
 * can be a screenshot of a logged-in page), files 0600, pruned on the way in so
 * a long-running server does not collect them forever.
 */
export const PASTE_DIR = join(tmpdir(), "code-terminal-pasted");

/** Well past a screenshot, well short of a video someone dragged in by mistake. */
export const MAX_PASTE_BYTES = 12 * 1024 * 1024;

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

export const PASTE_TYPES = Object.keys(EXT);

/** The extension for a media type we accept, or null when we do not accept it. */
export function pasteExtension(mime: string): string | null {
  return EXT[mime.split(";")[0].trim().toLowerCase()] ?? null;
}

/**
 * Spool one pasted image and hand back its path. Throws on a type we do not
 * take or a body past the ceiling — the caller turns that into a 400.
 */
export async function savePastedImage(buf: Buffer, mime: string, dir = PASTE_DIR, now = Date.now()): Promise<{ path: string; bytes: number }> {
  const ext = pasteExtension(mime);
  if (!ext) throw new Error(`${mime} is not an image this takes (${PASTE_TYPES.join(", ")})`);
  if (!buf.length) throw new Error("empty image");
  if (buf.length > MAX_PASTE_BYTES) throw new Error(`image is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${MAX_PASTE_BYTES / 1048576} MB`);

  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  // Last paste's leftovers, never this one's — the CLI is about to read it.
  void pruneScreenshots(dir, { extensions: [".png", ".jpg", ".gif", ".webp"] });

  const path = join(dir, `pasted-${now}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  await writeFile(path, buf, { mode: 0o600 });
  return { path, bytes: buf.length };
}
