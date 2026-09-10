import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Bridge to the Chrome extension. The extension dials in and holds one socket;
 * the agent's tools send commands over it and await a matching reply.
 *
 * Only one extension is connected at a time — a second connection replaces the
 * first, so reloading the extension doesn't leave a dead socket in place.
 */
export class BrowserBridge {
  #ws: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #onLog: (line: string) => void;
  #timeoutMs: number;
  /** Unsolicited frames from the extension — a watch firing, for instance. */
  #onEvent: (msg: { type: string; [k: string]: unknown }) => void = () => {};

  constructor(onLog: (line: string) => void, timeoutMs = 30_000) {
    this.#onLog = onLog;
    this.#timeoutMs = timeoutMs;
  }

  onEvent(f: (msg: { type: string; [k: string]: unknown }) => void): void { this.#onEvent = f; }

  get connected(): boolean { return this.#ws?.readyState === 1; }

  attach(ws: WebSocket): void {
    // 4001 tells the displaced extension it was replaced, so it backs off
    // instead of reconnecting in 3s and displacing this one straight back —
    // two browsers running the extension would otherwise thrash forever.
    this.#ws?.close(4001, "replaced by a newer extension connection");
    this.#ws = ws;
    this.#onLog("extension connected");

    ws.on("message", (raw) => {
      let msg: { id?: string; ok?: boolean; result?: unknown; error?: string; type?: string; [k: string]: unknown };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "pong") return;                 // keepalive
      // Not every frame answers a request: watches report on their own.
      if (!msg.id && typeof msg.type === "string") {
        this.#onEvent(msg as { type: string; [k: string]: unknown });
        return;
      }
      if (!msg.id) return;
      const p = this.#pending.get(msg.id);
      if (!p) return;                                   // late reply after timeout
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? "extension reported an unknown error"));
    });

    const drop = () => {
      if (this.#ws !== ws) return;                      // already replaced
      this.#ws = null;
      this.#onLog("extension disconnected");
      for (const [, p] of this.#pending) {
        clearTimeout(p.timer);
        p.reject(new Error("the extension disconnected mid-command"));
      }
      this.#pending.clear();
    };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  /**
   * What the user is looking at right now, for ambient context on a prompt.
   * Never throws and never blocks a turn for long: no extension, a restricted
   * page or a slow reply all just mean "no context this time".
   */
  async activeTab(timeoutMs = 2500): Promise<{ title?: string; url?: string; selection?: string } | null> {
    if (!this.connected) return null;
    try {
      const race = await Promise.race([
        this.send("active_tab", {}),
        new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), timeoutMs)),
      ]);
      return race as { title?: string; url?: string; selection?: string };
    } catch {
      return null;
    }
  }

  /** Send one command and await its reply. Rejects rather than hanging. */
  send(action: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) {
      return Promise.reject(new Error(
        "No Chrome extension is connected. Load the extension in Chrome and check its toggle is on.",
      ));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`browser.${action} timed out after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws!.send(JSON.stringify({ id, action, params }));
    });
  }
}
