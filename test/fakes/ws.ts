import { EventEmitter } from "node:events";

/**
 * A ws socket as the server sees it: `on("message"|"close"|"error")`, `send`,
 * `readyState`, `close`. Frames a test injects arrive through `frame()`; what
 * the server sends is parsed into `sent`.
 */
export class FakeWs extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  sent: unknown[] = [];
  raw: (string | Buffer)[] = [];
  closeCode: number | null = null;
  closeReason = "";
  pings = 0;
  terminated = false;

  send(data: string | Buffer): void {
    this.raw.push(data);
    if (typeof data === "string") { try { this.sent.push(JSON.parse(data)); } catch { this.sent.push(data); } }
  }
  ping(): void { this.pings++; }
  terminate(): void { this.terminated = true; this.close(1006, "terminated"); }
  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3; this.closeCode = code; this.closeReason = reason;
    this.emit("close", code, Buffer.from(reason));
  }

  /** An inbound frame from the client. */
  frame(msg: unknown): void { this.emit("message", Buffer.from(typeof msg === "string" ? msg : JSON.stringify(msg)), false); }
  binary(data: Buffer): void { this.emit("message", data, true); }

  /** Everything sent of one kind. */
  kind<T = Record<string, unknown>>(kind: string): T[] {
    return this.sent.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null && (m as Record<string, unknown>).kind === kind) as T[];
  }
  last<T = Record<string, unknown>>(kind: string): T | undefined { const a = this.kind<T>(kind); return a[a.length - 1]; }
  clear(): void { this.sent = []; this.raw = []; }
}
