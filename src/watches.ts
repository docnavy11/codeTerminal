import { randomUUID } from "node:crypto";

export type WatchCondition =
  | { kind: "contains"; value: string }
  | { kind: "missing"; value: string }
  | { kind: "selector"; value: string }
  | { kind: "changes"; value?: string };

export type Watch = {
  id: string;
  chatId: string;
  description: string;
  url: string;
  tabId: number | null;
  condition: WatchCondition;
  createdAt: number;
  expiresAt: number;
  firedAt?: number;
  detail?: string;
};

const DEFAULT_MINUTES = 60;
const MAX_MINUTES = 24 * 60;
const MAX_ACTIVE = 20;

/**
 * Watches live only in memory, on purpose. A watch is a live observer on a
 * live browser tab; persisting one across a restart would resurrect something
 * whose tab is long gone. They are cheap to re-create and confusing to
 * resurrect.
 */
export class WatchRegistry {
  #watches = new Map<string, Watch>();

  add(w: Omit<Watch, "id" | "createdAt" | "expiresAt"> & { minutes?: number }): Watch {
    const active = this.active();
    if (active.length >= MAX_ACTIVE) {
      throw new Error(`Too many active watches (${MAX_ACTIVE}). Stop one first.`);
    }
    const minutes = Math.min(MAX_MINUTES, Math.max(1, w.minutes ?? DEFAULT_MINUTES));
    const now = Date.now();
    const watch: Watch = {
      id: randomUUID(),
      chatId: w.chatId,
      description: w.description,
      url: w.url,
      tabId: w.tabId,
      condition: w.condition,
      createdAt: now,
      expiresAt: now + minutes * 60_000,
    };
    this.#watches.set(watch.id, watch);
    return watch;
  }

  get(id: string): Watch | undefined { return this.#watches.get(id); }
  remove(id: string): boolean { return this.#watches.delete(id); }
  all(): Watch[] { return [...this.#watches.values()]; }

  /** Not yet fired and not yet expired. */
  active(now = Date.now()): Watch[] {
    return this.all().filter((w) => !w.firedAt && w.expiresAt > now);
  }

  /** Marks a watch fired. Returns null if it was already fired or unknown. */
  fire(id: string, detail: string, now = Date.now()): Watch | null {
    const w = this.#watches.get(id);
    if (!w || w.firedAt) return null;
    w.firedAt = now;
    w.detail = detail;
    return w;
  }

  /** Drops expired and long-fired entries so the list stays readable. */
  sweep(now = Date.now()): Watch[] {
    const dropped: Watch[] = [];
    for (const w of this.all()) {
      const expired = !w.firedAt && w.expiresAt <= now;
      const stale = w.firedAt !== undefined && now - w.firedAt > 10 * 60_000;
      if (expired || stale) {
        this.#watches.delete(w.id);
        dropped.push(w);
      }
    }
    return dropped;
  }

  /** Everything a chat owns — used when a chat is deleted. */
  removeForChat(chatId: string): number {
    let n = 0;
    for (const w of this.all()) if (w.chatId === chatId) { this.#watches.delete(w.id); n++; }
    return n;
  }

  /** One line per watch, for the agent to read back. */
  describe(w: Watch): string {
    const cond =
      w.condition.kind === "contains" ? `text "${w.condition.value}" appears`
      : w.condition.kind === "missing" ? `text "${w.condition.value}" disappears`
      : w.condition.kind === "selector" ? `element "${w.condition.value}" appears`
      : w.condition.value ? `"${w.condition.value}" changes`
      : "the page changes";
    const state = w.firedAt ? "fired" : w.expiresAt <= Date.now() ? "expired" : "watching";
    return `${w.id.slice(0, 8)} [${state}] ${w.description} — until ${cond} on ${w.url}`;
  }
}
