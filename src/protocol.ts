import type { PermissionMode, SlashCommand } from "@anthropic-ai/claude-agent-sdk";

/**
 * The wire protocol between the server and every client — desktop UI, Chrome
 * side panel, mobile page. One place, so the two directions cannot drift from
 * each other or from the handlers. The clients are plain JavaScript and cannot
 * import these types; test/protocol.test.ts holds them to this file instead.
 */

/**
 * What the agent is doing right now. Derived, not stored: whichever of these
 * is true takes precedence, so it cannot drift out of sync with reality.
 *   awaiting   an approval card is open — waiting on YOU, not on Claude
 *   tool       a tool is executing
 *   compacting the SDK is summarising the conversation
 *   thinking   a turn is running with no tool in flight
 *   idle       nothing running
 */
export type StatusState = "idle" | "thinking" | "tool" | "awaiting" | "compacting";

/** One question from the built-in AskUserQuestion tool. */
export type AskQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string; preview?: string }[];
};

/** Server → client. One flat, discriminated shape. */
export type ClientEvent =
  | { kind: "ready"; sessionId: string; model: string; workspace: string; canBypass: boolean }
  | { kind: "user"; text: string; context?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  /** What a tool returned: one line for the row, the body behind it (capped). Joined to "tool" by id. */
  | { kind: "tool_result"; id: string; name: string; ok: boolean; summary: string; text: string; bytes: number; truncated: boolean;
      interrupted?: boolean; parent?: string | null }
  /** diff: what an Edit/Write would do, computed before you decide; absent for other tools or when the file could not be read. */
  | { kind: "approval"; id: string; tool: string; input: unknown; canAlways: boolean;
      diff?: { path: string; kind: "edit" | "write" | "create"; lines: { t: " " | "+" | "-" | "@"; s: string }[]; adds: number; dels: number; truncated: boolean; note?: string } | null }
  | { kind: "approval_closed"; id: string; decision: "allow" | "always" | "deny" | "gone" }
  | { kind: "mode"; mode: PermissionMode }
  | { kind: "commands"; commands: SlashCommand[] }
  | { kind: "local"; text: string }
  | { kind: "chats"; chats: unknown[]; activeId: string }
  | { kind: "cleared" }
  | { kind: "cwd"; path: string }
  | { kind: "project"; id: string; name: string }
  | { kind: "watch"; description: string; detail: string }
  | { kind: "conversation_reset"; newId: string }
  | { kind: "delta"; text: string }
  | { kind: "replayed" }
  | { kind: "status"; state: StatusState; detail: string; tokens: number }
  | { kind: "question"; id: string; questions: AskQuestion[] }
  /**
   * costUsd is this turn's cost; sessionCostUsd the SDK's running total for the
   * live session (both estimates). stopped says why a turn ended early, in
   * words; context is what the next request re-sends against the model's window.
   */
  | { kind: "turn_end"; costUsd: number | null; sessionCostUsd?: number | null; isError: boolean; denials: number;
      stopped?: string | null; context?: { tokens: number; window: number } | null }
  | { kind: "error"; message: string }
  /** Liveness beat from the server's heartbeat; carries nothing. */
  | { kind: "ping" };

/** Every `kind` a client can receive, for the coverage test. */
export const CLIENT_EVENT_KINDS = [
  "ready", "user", "text", "tool", "tool_result", "approval", "approval_closed", "mode", "commands",
  "local", "chats", "cleared", "cwd", "project", "watch", "conversation_reset", "delta",
  "replayed", "status", "question", "turn_end", "error", "ping",
] as const satisfies readonly ClientEvent["kind"][];

/** The permission modes a client may ask for. Validated on the way in. */
export const PERMISSION_MODES = [
  "default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions",
] as const satisfies readonly PermissionMode[];

/** Client → server on /ws. */
export type AgentMessage =
  | { type: "prompt"; text: string; withTab?: boolean }
  | { type: "browser"; instance: string }
  | { type: "answer"; id: string; answers: Record<string, string> }
  | { type: "decision"; id: string; decision: "allow" | "always" | "deny" }
  | { type: "cwd"; path: string }
  | { type: "project"; id: string }
  | { type: "mode"; mode: PermissionMode }
  | { type: "interrupt" }
  | { type: "new" }
  | { type: "open"; id: string }
  | { type: "rename"; id: string; title: string }
  | { type: "delete"; id: string };

/** Client → server on /pty. Terminal bytes travel as binary frames, not JSON. */
export type ShellMessage =
  | { type: "start"; cols?: number; rows?: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols?: number; rows?: number };

export const AGENT_MESSAGE_TYPES = [
  "prompt", "browser", "answer", "decision", "cwd", "project", "mode",
  "interrupt", "new", "open", "rename", "delete",
] as const satisfies readonly AgentMessage["type"][];

/**
 * Narrow raw JSON off the wire to an AgentMessage, or null. The shape checks
 * here are the only validation an inbound message gets, so each case states
 * exactly the fields it relies on.
 */
export function parseAgentMessage(raw: unknown): AgentMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const str = (k: string) => typeof m[k] === "string" ? (m[k] as string) : null;
  switch (m.type) {
    case "prompt": {
      const text = str("text");
      if (text === null || !text.trim()) return null;
      return { type: "prompt", text, ...(typeof m.withTab === "boolean" ? { withTab: m.withTab } : {}) };
    }
    case "browser": { const instance = str("instance"); return instance ? { type: "browser", instance } : null; }
    case "answer": {
      const id = str("id");
      if (!id || !m.answers || typeof m.answers !== "object") return null;
      return { type: "answer", id, answers: m.answers as Record<string, string> };
    }
    case "decision": {
      const id = str("id"); const d = m.decision;
      if (!id || (d !== "allow" && d !== "always" && d !== "deny")) return null;
      return { type: "decision", id, decision: d };
    }
    case "cwd": { const path = str("path"); return path !== null ? { type: "cwd", path } : null; }
    case "project": { const id = str("id"); return id ? { type: "project", id } : null; }
    case "mode": {
      const mode = m.mode;
      return (PERMISSION_MODES as readonly unknown[]).includes(mode) ? { type: "mode", mode: mode as PermissionMode } : null;
    }
    case "interrupt": return { type: "interrupt" };
    case "new": return { type: "new" };
    case "open": { const id = str("id"); return id ? { type: "open", id } : null; }
    case "rename": {
      const id = str("id"), title = str("title");
      return id && title !== null ? { type: "rename", id, title } : null;
    }
    case "delete": { const id = str("id"); return id ? { type: "delete", id } : null; }
    default: return null;
  }
}
