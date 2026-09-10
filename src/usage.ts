import { readFileSync, writeFileSync, renameSync } from "node:fs";

/**
 * Counts which navigation controls actually get clicked.
 *
 * The bar was first ordered from priors about what matters. The only usage
 * evidence available was indirect — stored permission modes and how many
 * prompts carried tab context — and it was drawn from 26 chat records that
 * were mostly test traffic. That is too weak to rank controls by. This makes
 * the next revision measurable instead of argued.
 *
 * Local only: counts live in a file on this box and are never sent anywhere.
 */
export class UsageLog {
  #path: string;
  #counts = new Map<string, number>();
  #timer: NodeJS.Timeout | null = null;

  /** Control ids are ours, but these arrive over the wire — never trust one. */
  static readonly VALID = /^[a-z][a-z0-9_-]{0,31}$/i;

  constructor(path: string) {
    this.#path = path;
    try {
      const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
      for (const [k, v] of Object.entries(d)) {
        if (UsageLog.VALID.test(k) && Number.isFinite(v)) this.#counts.set(k, v);
      }
    } catch { /* no history yet */ }
  }

  record(control: string): boolean {
    if (!UsageLog.VALID.test(control)) return false;
    this.#counts.set(control, (this.#counts.get(control) ?? 0) + 1);
    this.#scheduleSave();
    return true;
  }

  /** Most-used first, which is the order the question is always asked in. */
  counts(): Record<string, number> {
    return Object.fromEntries([...this.#counts].sort((a, b) => b[1] - a[1]));
  }

  /** Clicks arrive in bursts; one write per second is plenty. */
  #scheduleSave(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => { this.#timer = null; this.save(); }, 1000);
    this.#timer.unref?.();
  }

  save(): void {
    try {
      writeFileSync(`${this.#path}.tmp`, JSON.stringify(this.counts(), null, 2));
      renameSync(`${this.#path}.tmp`, this.#path);
    } catch { /* a lost count is not worth crashing over */ }
  }
}
