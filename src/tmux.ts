/**
 * The sessions tab: tmux sessions on this machine, listed, attached, renamed,
 * killed.
 *
 * Why this exists next to the plain shell rather than replacing it. The shell
 * pane is a throwaway — open it, type, close it, gone — and making every
 * shell a tmux session would have bought persistence for the surface that
 * needs it least, at the price of tmux's resize rules and its prefix key in
 * everybody's way. Persistence you ask for is a different thing: you go to the
 * sessions tab *because* you want something to outlive the tab.
 *
 * These are the machine's sessions, not ours. tty (the other project on this
 * box) creates `wt_<uuid>` sessions on the same socket, and they show up here
 * with their working directories — one set of sessions, two front doors.
 * Nothing here is namespaced, on purpose.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type TmuxSession = {
  name: string;
  /** Where the current pane is, which is the only human label some of these have. */
  path: string;
  windows: number;
  /** Clients attached right now, across every front door. */
  attached: number;
  /** ms since the epoch. */
  createdAt: number;
  activityAt: number;
  /** The command in the current pane: "node", "bash", "vim". */
  command: string;
};

/** Fields in the order the format string asks for them. */
const FORMAT = ["#{session_name}", "#{pane_current_path}", "#{session_windows}", "#{session_attached}",
                "#{session_created}", "#{session_activity}", "#{pane_current_command}"].join("\t");

/** tmux is optional: the tab is hidden when it is not installed. */
export async function tmuxAvailable(): Promise<boolean> {
  try { await run("tmux", ["-V"], { timeout: 3000 }); return true; } catch { return false; }
}

export async function listSessions(): Promise<TmuxSession[]> {
  let out: string;
  try { ({ stdout: out } = await run("tmux", ["list-sessions", "-F", FORMAT], { timeout: 5000 })); }
  catch (e) {
    // "no server running on ..." is the ordinary empty case, not a failure.
    if (/no server running|no sessions/i.test(String((e as { stderr?: string }).stderr ?? e))) return [];
    throw e;
  }
  return out.split("\n").filter(Boolean).map((line) => {
    const [name, path, windows, attached, created, activity, command] = line.split("\t");
    return {
      name, path: path ?? "", windows: Number(windows) || 1, attached: Number(attached) || 0,
      createdAt: Number(created) * 1000 || 0, activityAt: Number(activity) * 1000 || 0, command: command ?? "",
    };
  }).sort((a, b) => b.activityAt - a.activityAt);
}

/** tmux takes a session name on the command line; keep it to what cannot be misread as an option or a target. */
export function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

export async function createSession(name: string, cwd: string): Promise<void> {
  if (!validName(name)) throw new Error("a session name is letters, digits, dot, dash or underscore (1–64)");
  // Detached: the client attaches over its own socket a moment later.
  await run("tmux", ["new-session", "-d", "-s", name, "-c", cwd], { timeout: 5000 });
}

export async function renameSession(from: string, to: string): Promise<void> {
  if (!validName(from) || !validName(to)) throw new Error("a session name is letters, digits, dot, dash or underscore (1–64)");
  await run("tmux", ["rename-session", "-t", from, to], { timeout: 5000 });
}

export async function killSession(name: string): Promise<void> {
  if (!validName(name)) throw new Error("no such session");
  await run("tmux", ["kill-session", "-t", name], { timeout: 5000 });
}

export async function hasSession(name: string): Promise<boolean> {
  if (!validName(name)) return false;
  try { await run("tmux", ["has-session", "-t", `=${name}`], { timeout: 3000 }); return true; } catch { return false; }
}

/**
 * What a session is printing, for the agent — and unlike the live pane, this
 * works when nobody is attached at all, which is the point of asking a
 * background session what it is doing.
 */
export async function capture(name: string, lines = 200): Promise<string> {
  if (!validName(name)) throw new Error("no such session");
  const n = Math.max(1, Math.min(2000, lines));
  // `=name:` and not `=name`: for a *pane* target tmux wants the session
  // followed by a colon, and the leading = keeps "dev" from matching
  // "dev-server" (measured: `-t =name` answers "can't find pane").
  const { stdout } = await run("tmux", ["capture-pane", "-p", "-t", `=${name}:`, "-S", `-${n}`], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const all = stdout.split("\n");
  while (all.length && all[all.length - 1].trim() === "") all.pop();
  return all.join("\n");
}
