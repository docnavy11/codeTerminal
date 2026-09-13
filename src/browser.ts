import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { SERVER_BROWSER_ID } from "./server-browser.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

type Conn = {
  /** Stable per browser profile, sent by the extension on connect. */
  instance: string;
  ws: WebSocket;
  pending: Map<string, Pending>;
  connectedAt: number;
};

/**
 * Connections to browser extensions, one per browser profile.
 *
 * This used to hold a single socket, so with two browsers open they fought
 * over it and whichever won received every session's browser commands — a
 * session in one browser would read tabs in the other. Now each browser keeps
 * its own connection and a caller says which one it means.
 */
export class BrowserBridge {
  #conns = new Map<string, Conn>();
  #onLog: (line: string) => void;
  #timeoutMs: number;
  #onEvent: (msg: { type: string; [k: string]: unknown }, instance: string) => void = () => {};

  constructor(onLog: (line: string) => void, timeoutMs = 30_000) {
    this.#onLog = onLog;
    this.#timeoutMs = timeoutMs;
  }

  onEvent(f: (msg: { type: string; [k: string]: unknown }, instance: string) => void): void {
    this.#onEvent = f;
  }

  get connected(): boolean { return this.#conns.size > 0; }
  get instances(): string[] { return [...this.#conns.keys()]; }
  /** Called whenever a browser connects, identifies itself, or drops. */
  onChange: () => void = () => {};

  /** The browser to use when a caller has no preference: the newest connected
      person's browser; the server browser only when it is the only one, so a
      chat never lands in it by accident. */
  #newest(): Conn | null {
    let best: Conn | null = null;
    for (const c of this.#conns.values()) {
      if (c.instance.startsWith("pending:")) continue;
      if (c.instance === SERVER_BROWSER_ID && best && best.instance !== SERVER_BROWSER_ID) continue;
      if (!best || best.instance === SERVER_BROWSER_ID || c.connectedAt > best.connectedAt) best = c;
    }
    return best;
  }

  #pick(prefer?: string): Conn | null {
    if (prefer) {
      const exact = this.#conns.get(prefer);
      if (exact) return exact;
      // The preferred browser has gone. Falling back silently would act in
      // someone else's browser, so refuse and let the caller say so.
      return null;
    }
    return this.#newest();
  }

  attach(ws: WebSocket): void {
    // The instance arrives in a hello frame; until then the connection is
    // parked under a placeholder so a command cannot pick it by accident.
    let instance = `pending:${randomUUID()}`;
    const conn: Conn = { instance, ws, pending: new Map(), connectedAt: Date.now() };
    this.#conns.set(instance, conn);

    ws.on("message", (raw) => {
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; type?: string; [k: string]: unknown };
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "pong") return;

      if (msg.type === "hello" && typeof msg.instance === "string") {
        this.#conns.delete(instance);
        // A reload of the same browser replaces its own connection, but never
        // another browser's.
        this.#conns.get(msg.instance)?.ws.close(4001, "replaced by a newer connection from the same browser");
        instance = msg.instance;
        conn.instance = instance;
        conn.connectedAt = Date.now();
        this.#conns.set(instance, conn);
        this.#onLog(`extension connected (${instance.slice(0, 8)}) — ${this.#conns.size} browser(s)`);
        this.onChange();
        return;
      }

      if (!msg.id && typeof msg.type === "string") { this.#onEvent(msg as { type: string }, instance); return; }
      if (!msg.id) return;

      const p = conn.pending.get(msg.id);
      if (!p) return;                       // late reply after a timeout
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "extension reported an unknown error"));
    });

    const drop = () => {
      if (this.#conns.get(conn.instance) !== conn) return;   // already replaced
      this.#conns.delete(conn.instance);
      this.#onLog(`extension disconnected (${conn.instance.slice(0, 8)}) — ${this.#conns.size} left`);
      this.onChange();
      for (const [, p] of conn.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("the extension disconnected mid-command"));
      }
      conn.pending.clear();
    };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  /** Send one command to a specific browser, or the newest if none is named. */
  send(action: string, params: Record<string, unknown>, prefer?: string): Promise<unknown> {
    const conn = this.#pick(prefer);
    if (!conn) {
      return Promise.reject(new Error(
        prefer
          ? "The browser this conversation belongs to is not connected. Open it, or use the chat in that browser."
          : "No Chrome extension is connected. Load the extension and check its toggle is on.",
      ));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`browser.${action} timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ id, action, params }));
    });
  }

  /**
   * What the user is looking at, for ambient context on a prompt. Never throws
   * and never blocks a turn: no extension, a restricted page or a slow reply
   * all just mean "no context this time".
   */
  async activeTab(prefer?: string, timeoutMs = 2500): Promise<{ title?: string; url?: string; selection?: string } | null> {
    if (!this.#pick(prefer)) return null;
    try {
      const race = await Promise.race([
        this.send("active_tab", {}, prefer),
        new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), timeoutMs)),
      ]);
      return race as { title?: string; url?: string; selection?: string };
    } catch {
      return null;
    }
  }
}
