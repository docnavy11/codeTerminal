import { spawn, type IPty } from "node-pty";
import { existsSync } from "node:fs";

/**
 * One PTY per WebSocket. This is a real shell with no approval gate — the gate
 * in session.ts constrains Claude, not you. Anyone holding the token gets this,
 * which is why server.ts refuses to bind a public interface.
 */
export class Shell {
  #pty: IPty | null = null;
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

    this.#pty.onData(this.#onData);
    this.#pty.onExit(({ exitCode }) => {
      this.#pty = null;
      this.#onExit(exitCode);
    });
  }

  write(data: string): void {
    this.#pty?.write(data);
  }

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

/** The server's own secret must not leak into the interactive shell. */
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
