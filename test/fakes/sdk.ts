import type { Query, SDKMessage, SDKUserMessage, PermissionResult, PermissionUpdate, PermissionMode, SlashCommand, Options } from "@anthropic-ai/claude-agent-sdk";
import { Pushable } from "../../src/pushable.js";

/**
 * A scripted stand-in for the SDK's query(). It records what the session
 * sends, lets a test emit any SDK message, end the stream cleanly, or make it
 * throw — the three ways a real subprocess can behave — and exposes the
 * canUseTool callback so the approval gate can be driven from a test.
 */
type Params = { prompt: AsyncIterable<SDKUserMessage>; options?: Options };

const FAIL = Symbol("fail");

export class FakeQuery {
  readonly options: Options;
  readonly received: SDKUserMessage[] = [];
  readonly modes: PermissionMode[] = [];
  interrupts = 0;
  closed = false;
  ended = false;
  commands: SlashCommand[] = [];
  /** Make setPermissionMode reject with this. */
  setModeError: Error | null = null;
  /** Make supportedCommands reject (older CLI). */
  commandsError: Error | null = null;
  /** Called for every user message the session pushes. */
  onUser: ((m: SDKUserMessage, q: FakeQuery) => void) | null = null;

  #out = new Pushable<SDKMessage | { [FAIL]: Error }>();

  constructor(params: Params, opts: FakeOpts = {}) {
    this.options = params.options ?? {};
    this.onUser = opts.onUser ?? null;
    opts.setup?.(this);
    void (async () => {
      for await (const m of params.prompt) {
        if (this.ended) break;                      // a dead subprocess reads nothing
        this.received.push(m); this.onUser?.(m, this);
      }
      // The real subprocess exits once its input closes; the stream ends with it.
      if (!this.ended) this.end();
    })();
  }

  /* ---- what the "subprocess" does ---- */
  emit(msg: Record<string, unknown>): void { this.#out.push(msg as unknown as SDKMessage); }
  /** The stream ends without an error — what an exiting subprocess looks like. */
  end(): void { this.ended = true; this.#out.end(); }
  /** The stream throws. */
  fail(err: Error): void { this.#out.push({ [FAIL]: err }); this.#out.end(); }

  init(sessionId = "sdk-session-1", extra: Record<string, unknown> = {}): void {
    this.emit({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model", ...extra });
  }
  delta(text: string): void {
    this.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  }
  text(text: string): void {
    this.emit({ type: "assistant", message: { content: [{ type: "text", text }] } });
  }
  toolUse(id: string, name: string, input: Record<string, unknown> = {}): void {
    this.emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  }
  toolResult(id: string, content: unknown = "", extra: { is_error?: boolean; structured?: unknown; parent?: string | null } = {}): void {
    this.emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(extra.is_error ? { is_error: true } : {}) }] },
      parent_tool_use_id: extra.parent ?? null, ...(extra.structured !== undefined ? { tool_use_result: extra.structured } : {}) });
  }
  result(extra: Record<string, unknown> = {}): void {
    this.emit({ type: "result", subtype: "success", total_cost_usd: 0.01, is_error: false, permission_denials: [], ...extra });
  }

  /** Drive the approval gate the way the SDK would. */
  ask(tool: string, input: Record<string, unknown> = {}, suggestions: PermissionUpdate[] = []) {
    const ac = new AbortController();
    const can = this.options.canUseTool;
    if (!can) throw new Error("no canUseTool on options");
    const promise: Promise<PermissionResult> = can(tool, input, { signal: ac.signal, suggestions });
    return { promise, abort: () => ac.abort() };
  }

  /* ---- Query surface the session calls ---- */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (this.setModeError) throw this.setModeError;
    this.modes.push(mode);
  }
  async interrupt(): Promise<undefined> { this.interrupts++; return undefined; }
  async supportedCommands(): Promise<SlashCommand[]> {
    if (this.commandsError) throw this.commandsError;
    return this.commands;
  }
  close(): void { this.closed = true; }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for await (const m of this.#out) {
      if (typeof m === "object" && m !== null && FAIL in m) throw (m as { [FAIL]: Error })[FAIL];
      yield m as SDKMessage;
    }
  }
}

export type FakeOpts = {
  /** Called for every user message the session pushes. */
  onUser?: (m: SDKUserMessage, q: FakeQuery) => void;
  /** Runs inside the constructor, before the session can call anything. */
  setup?: (q: FakeQuery) => void;
};

/** A spawnQuery for SessionDeps that keeps every query it created. */
export function fakeSdk(opts: FakeOpts = {}) {
  const queries: FakeQuery[] = [];
  const spawnQuery = ((params: Params) => {
    const q = new FakeQuery(params, opts);
    queries.push(q);
    return q as unknown as Query;
  }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk").query;
  return { spawnQuery, queries, get last() { return queries[queries.length - 1]; } };
}

/** Let promises and the fake's iterator advance. */
export const settle = (n = 3) => new Promise<void>((r) => { let i = 0; const step = () => (++i > n ? r() : setImmediate(step)); step(); });

/** Poll until a condition holds (real I/O in the path), or fail with a message. */
export async function waitFor(cond: () => boolean, what = "condition", ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
