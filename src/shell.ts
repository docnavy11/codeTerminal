import { spawn, type IPty } from "node-pty";
import { existsSync } from "node:fs";

/**
 * One PTY per WebSocket. This is a real shell with no approval gate — the gate
 * in session.ts constrains Claude, not you. Anyone who reaches the port gets
 * this, which is why server.ts refuses to bind a public interface and gates
 * access on the tailnet (Origin + whois), not a secret.
 */
/** Roughly a few hundred lines of output; enough to hold a failed build. */
const SCROLLBACK_BYTES = 64 * 1024;

/**
 * Terminal output is a stream of escape sequences: colours, cursor moves, the
 * title-setting OSC the prompt emits every command. None of that is useful to
 * a model reading a build failure, so strip it.
 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")   // OSC (window title)
    .replace(/\x1b[@-Z\\-_]/g, "")                          // single-char escapes
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")               // CSI (colour, cursor)
    .replace(/\r(?!\n)/g, "\n")                             // bare CR from progress output
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

export class Shell {
  #pty: IPty | null = null;
  /** Raw tail of what the terminal printed, so the agent can be shown it. */
  #scrollback = "";
  #onData: (chunk: string) => void;
  #onExit: (code: number) => void;

  constructor(onData: (chunk: string) => void, onExit: (code: number) => void) {
    this.#onData = onData;
    this.#onExit = onExit;
  }

  start(cwd: string, cols: number, rows: number): void {
    if (this.#pty) return;

    // Login shell so ~/.profile and nvm land on PATH — otherwise `node` is missing.
    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/bash";

    this.#pty = spawn(shell, ["-l"], {
      name: "xterm-256color",
      cwd,
      cols: clamp(cols, 20, 500),
      rows: clamp(rows, 5, 200),
      env: shellEnv(),
    });

    this.#pty.onData((chunk) => {
      this.#scrollback += chunk;
      if (this.#scrollback.length > SCROLLBACK_BYTES) {
        this.#scrollback = this.#scrollback.slice(-SCROLLBACK_BYTES);
      }
      this.#onData(chunk);
    });
    this.#pty.onExit(({ exitCode }) => {
      this.#pty = null;
      this.#onExit(exitCode);
    });
  }

  write(data: string): void {
    this.#pty?.write(data);
  }

  /** The last `lines` lines the terminal printed, escape codes removed. */
  recent(lines = 200): { lines: number; text: string } {
    const all = stripAnsi(this.#scrollback).split("\n");
    // Trailing blank lines are just the prompt sitting there.
    while (all.length && all[all.length - 1].trim() === "") all.pop();
    const tail = all.slice(-Math.max(1, Math.min(2000, lines)));
    return { lines: tail.length, text: tail.join("\n") };
  }

  get hasOutput(): boolean { return this.#scrollback.length > 0; }

  resize(cols: number, rows: number): void {
    if (!this.#pty) return;
    try {
      this.#pty.resize(clamp(cols, 20, 500), clamp(rows, 5, 200));
    } catch {
      // The pty can exit between the client's resize and this call.
    }
  }

  kill(): void {
    if (!this.#pty) return;
    const p = this.#pty;
    this.#pty = null;
    try { p.kill(); } catch { /* already gone */ }
  }
}

/**
 * The shell inherits the server's environment. There is no auth token any more
 * (access is by network position), but strip a legacy CODETERM_TOKEN if one is
 * still set, so it can never surface in a stray `env`.
 */
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CODETERM_TOKEN" || v === undefined) continue;
    env[k] = v;
  }
  env.TERM = "xterm-256color";
  return env;
}

function clamp(n: unknown, lo: number, hi: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : lo;
  return Math.min(hi, Math.max(lo, v));
}
