/**
 * Where the configuration and the state live, and how a `.env` file gets into
 * the process.
 *
 * Two things were surprising enough to be worth fixing here:
 *
 * 1. Only systemd read `.env` (`EnvironmentFile=` in the unit), so `npm start`
 *    from a shell ignored every setting the README tells you to put there.
 *    `loadEnvFile()` reads it in-process; a real environment variable always
 *    wins, so the unit's behaviour is unchanged.
 *
 * 2. The state — chats, prompts, schedules, usage, the allowed sites, the
 *    server browser's profile — was written next to the source, at the repo
 *    root, so "copy my installation" meant knowing which six files and two
 *    directories among the source were yours. `CODETERM_STATE` names one
 *    directory for all of it. The default stays the repo root, and a file that
 *    already exists there is still used even when a state directory is set, so
 *    setting it never strands an existing install.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Parse a KEY=value file: `export` prefixes, quotes, `#` comments, blank lines. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    // A quoted value may carry a comment after its closing quote:
    // HOST="100.64.0.1"  # tailnet ip. Kept whole, the quotes became part of the value.
    const q = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(v);
    if (q) {
      v = q[2];
    } else {
      const hash = v.indexOf(" #");                 // a trailing comment, not a value containing '#'
      if (hash >= 0) v = v.slice(0, hash).trim();
    }
    out[m[1]] = v;
  }
  return out;
}

/** Load `<dir>/.env` into `env`, never overwriting what is already set. Returns the keys it added. */
export function loadEnvFile(dir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const path = join(dir, ".env");
  if (!existsSync(path)) return [];
  let parsed: Record<string, string>;
  try { parsed = parseEnvFile(readFileSync(path, "utf8")); } catch { return []; }
  const added: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] !== undefined) continue;             // the environment (systemd, the shell) wins
    env[k] = v; added.push(k);
  }
  return added;
}

/** One state file or directory: its env override, its name inside the state directory. */
type Slot = { env: string; name: string };

export const STATE_SLOTS = {
  chats: { env: "CODETERM_CHATS", name: "chats" },
  workspace: { env: "CODETERM_WORKSPACE", name: "workspace" },
  prompts: { env: "CODETERM_PROMPTS", name: "prompts.json" },
  schedules: { env: "CODETERM_SCHEDULES", name: "schedules.json" },
  usage: { env: "CODETERM_USAGE", name: "usage.json" },
  browserAllow: { env: "CODETERM_BROWSER_ALLOW_FILE", name: "browser-allow.json" },
  /** The standing Telegram chat's cwd — just a CLAUDE.md telling it how to
      query this server's own state (schedules, chats, prompts) over loopback. */
  telegramContext: { env: "CODETERM_TELEGRAM_CONTEXT", name: "telegram-context" },
  serverBrowserProfile: { env: "CODETERM_SERVER_BROWSER_PROFILE", name: join("server-browser", "profile") },
} satisfies Record<string, Slot>;

export type StateName = keyof typeof STATE_SLOTS;

/**
 * Resolve one state path: the slot's own variable, else the state directory,
 * else the repo root. When a state directory is set but the repo root already
 * holds that file — an install that predates the setting — the existing one
 * wins, so nothing is stranded until it is moved deliberately.
 */
export function statePath(name: StateName, root: string, env: NodeJS.ProcessEnv = process.env): string {
  const slot = STATE_SLOTS[name];
  const own = env[slot.env];
  if (own) return own;
  const dir = env.CODETERM_STATE;
  if (!dir) return join(root, slot.name);
  const legacy = join(root, slot.name);
  if (existsSync(legacy) && !existsSync(join(dir, slot.name))) return legacy;
  return join(dir, slot.name);
}

/** Every state path at once, for the setup page and the backup script. */
export function statePaths(root: string, env: NodeJS.ProcessEnv = process.env): Record<StateName, string> {
  const out = {} as Record<StateName, string>;
  for (const k of Object.keys(STATE_SLOTS) as StateName[]) out[k] = statePath(k, root, env);
  return out;
}
