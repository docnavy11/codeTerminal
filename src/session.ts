import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type PermissionUpdate, type PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Pushable, deferred } from "./pushable.js";
import { randomUUID } from "node:crypto";

/** What the browser receives. One flat, discriminated shape. */
export type ClientEvent =
  | { kind: "ready"; sessionId: string; model: string; workspace: string }
  | { kind: "user"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "approval"; id: string; tool: string; input: unknown; canAlways: boolean }
  | { kind: "approval_closed"; id: string; decision: "allow" | "always" | "deny" | "gone" }
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "turn_end"; costUsd: number | null; isError: boolean; denials: number }
  | { kind: "error"; message: string };

/**
 * Auto-approved without a prompt. Local reads only — nothing here can modify
 * the workspace or reach the network. WebFetch/WebSearch are deliberately NOT
 * listed: they exfiltrate, so they go through the gate like Bash and Write.
 */
const READ_ONLY = ["Read", "Glob", "Grep", "NotebookRead", "TodoWrite"];

type Pending = {
  resolve: (r: PermissionResult) => void;
  tool: string;
  suggestions: PermissionUpdate[];
};

export class Session {
  #input = new Pushable<SDKUserMessage>();
  #query: Query | null = null;
  #pending = new Map<string, Pending>();
  #emit: (e: ClientEvent) => void;
  #workspace: string;
  #busy = false;
  #mode: PermissionMode = "default";

  /** Permission rules accumulated from "Always allow" clicks, replayed on resume. */
  #granted: PermissionUpdate[] = [];

  sdkSessionId: string | null = null;

  constructor(workspace: string, emit: (e: ClientEvent) => void) {
    this.#workspace = workspace;
    this.#emit = emit;
  }

  get busy() { return this.#busy; }
  get mode() { return this.#mode; }
  get granted() { return this.#granted; }

  /** Swap the sink when a browser attaches or detaches. */
  setEmit(emit: (e: ClientEvent) => void): void { this.#emit = emit; }

  async start(resumeId?: string, granted: PermissionUpdate[] = []): Promise<void> {
    this.#granted = granted;
    this.#query = query({
      prompt: this.#input,
      options: {
        cwd: this.#workspace,
        additionalDirectories: [],
        // Without this, ~/.claude/settings.json loads and its defaultMode:"auto"
        // hands approval to the classifier instead of the gate below.
        settingSources: [],
        allowedTools: READ_ONLY,
        permissionMode: this.#mode,
        canUseTool: this.#canUseTool,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    });

    try {
      for await (const msg of this.#query) this.#handle(msg);
    } catch (err) {
      this.#emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** The approval gate. The SDK awaits this, so the turn genuinely blocks here. */
  #canUseTool = (
    tool: string,
    input: Record<string, unknown>,
    { signal, suggestions }: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> => {
    const id = randomUUID();
    const { promise, resolve } = deferred<PermissionResult>();
    const sugg = suggestions ?? [];
    this.#pending.set(id, { resolve, tool, suggestions: sugg });

    signal.addEventListener("abort", () => {
      if (!this.#pending.delete(id)) return;
      this.#emit({ kind: "approval_closed", id, decision: "gone" });
      resolve({ behavior: "deny", message: "Interrupted before you answered." });
    }, { once: true });

    this.#emit({ kind: "approval", id, tool, input, canAlways: sugg.length > 0 });
    return promise;
  };

  /** allow | always | deny. "always" also stops this tool asking again. */
  decide(id: string, decision: "allow" | "always" | "deny"): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);

    if (decision === "deny") {
      p.resolve({ behavior: "deny", message: `The user denied ${p.tool}. Do not retry it; ask what to do instead.` });
    } else if (decision === "always") {
      this.#granted.push(...p.suggestions);
      p.resolve({ behavior: "allow", updatedPermissions: p.suggestions });
    } else {
      p.resolve({ behavior: "allow" });
    }
    this.#emit({ kind: "approval_closed", id, decision });
    return true;
  }

  async setMode(mode: PermissionMode): Promise<void> {
    this.#mode = mode;
    await this.#query?.setPermissionMode(mode);
    this.#emit({ kind: "mode", mode });
  }

  send(text: string): void {
    this.#busy = true;
    this.#input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> { await this.#query?.interrupt(); }

  /** Real shutdown — not called merely because a browser tab went away. */
  close(): void {
    for (const [id, p] of this.#pending) {
      this.#emit({ kind: "approval_closed", id, decision: "gone" });
      p.resolve({ behavior: "deny", message: "Session closed." });
    }
    this.#pending.clear();
    this.#input.end();
  }

  #handle(msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.sdkSessionId = msg.session_id;
          this.#emit({ kind: "ready", sessionId: msg.session_id, model: msg.model, workspace: this.#workspace });
        }
        return;

      case "assistant":
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) this.#emit({ kind: "text", text: block.text });
          else if (block.type === "tool_use") this.#emit({ kind: "tool", id: block.id, name: block.name, input: block.input });
        }
        return;

      case "result":
        this.#busy = false;
        this.#emit({
          kind: "turn_end",
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
          isError: msg.is_error === true,
          denials: msg.permission_denials?.length ?? 0,
        });
        return;
    }
  }
}
