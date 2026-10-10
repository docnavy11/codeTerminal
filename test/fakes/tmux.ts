import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

/** Is a real tmux (and the tools the hooks use) on this machine? Tests that need one skip when not. */
export function haveTools(...bins: string[]): boolean {
  try { for (const b of bins) execFileSync("which", [b], { stdio: "ignore" }); return true; } catch { return false; }
}

const SCRIPT = join(import.meta.dirname, "..", "fixtures", "fake-claude-pane.sh");

/**
 * A real tmux session whose pane is the fake Claude (fixtures/fake-claude-pane.sh).
 * Named uniquely, on the machine's tmux server like any other session; always
 * killed by `stop()`. `typed()` is what was typed into it so far.
 */
export function fakeClaude(mode: "idle" | "working" | "shell", cwd = tmpdir()) {
  const name = `ct-test-${process.pid}-${randomUUID().slice(0, 6)}`;
  const log = join(tmpdir(), `${name}.log`);
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-x", "160", "-y", "40", "-c", cwd, `bash ${SCRIPT} ${log} ${mode}`], { stdio: "ignore" });
  return {
    name, log,
    /** The pane id (%n) — what $TMUX_PANE is inside it. */
    pane: () => execFileSync("tmux", ["list-panes", "-t", `=${name}`, "-F", "#{pane_id}"], { encoding: "utf8" }).split("\n")[0],
    typed: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    stop: () => { try { execFileSync("tmux", ["kill-session", "-t", `=${name}`], { stdio: "ignore" }); } catch { /* already gone */ } },
  };
}

/** Poll until `pred` holds, up to `ms`. */
export async function until(pred: () => boolean, what: string, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 40)); }
}
