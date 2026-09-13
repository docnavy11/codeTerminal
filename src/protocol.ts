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
  /** servers: the in-process MCP servers and what the CLI made of them ("connected" is the only good status). */
  | { kind: "ready"; sessionId: string; model: string; workspace: string; canBypass: boolean; servers?: { name: string; status: string }[] }
  /** images: what the user attached — thumbnails only, for the transcript; the full images went to the model. */
  /** uuid: the id the SDK knows this message by — the rewind target for the files changed after it. */
  | { kind: "user"; text: string; context?: string; images?: { media_type: string; thumb: string }[]; uuid?: string }
  /** Answer to a rewind request (live-only): a dry run previews, a real one restores. */
  | { kind: "rewind"; uuid: string; dryRun: boolean; canRewind: boolean; error?: string; files: string[]; insertions: number; deletions: number }
  /** parent: set when a subagent (the Agent tool) said/did it — rendered nested under that call. */
  | { kind: "text"; text: string; parent?: string | null }
  | { kind: "tool"; id: string; name: string; input: unknown; parent?: string | null }
  /** A subagent's life: started / completed / failed / stopped (persisted) … */
  | { kind: "task"; id: string; toolUseId: string | null; description: string; state: "running" | "completed" | "failed" | "stopped";
      toolUses?: number; durationMs?: number; summary?: string }
  /** … and its heartbeat while running (live-only). */
  | { kind: "task_progress"; id: string; toolUseId: string | null; toolUses: number; durationMs: number; lastTool?: string }
  /** What a tool returned: one line for the row, the body behind it (capped). Joined to "tool" by id. */
  | { kind: "tool_result"; id: string; name: string; ok: boolean; summary: string; text: string; bytes: number; truncated: boolean;
      interrupted?: boolean; parent?: string | null; where?: string }
  /** diff: what an Edit/Write would do, computed before you decide; absent for other tools or when the file could not be read. */
  | { kind: "approval"; id: string; tool: string; input: unknown; canAlways: boolean;
      diff?: { path: string; kind: "edit" | "write" | "create"; lines: { t: " " | "+" | "-" | "@"; s: string }[]; adds: number; dels: number; truncated: boolean; note?: string } | null }
  | { kind: "approval_closed"; id: string; decision: "allow" | "always" | "deny" | "gone" }
  | { kind: "mode"; mode: PermissionMode }
  /** The models this CLI offers, for the picker; and the one this chat now uses (null = the CLI's default). */
  | { kind: "models"; models: { value: string; label: string }[] }
  /** Connected browsers (extension instances); server: the headless one on this machine. mine: this client's own, if it is an extension. */
  | { kind: "browsers"; list: { id: string; server: boolean }[] }
  | { kind: "model"; model: string | null }
  | { kind: "commands"; commands: SlashCommand[] }
  | { kind: "local"; text: string }
  /** A file the agent prepared for you: path relative to the files root, so the client can offer a download. */
  | { kind: "file"; path: string; name: string; bytes: number; note?: string }
  | { kind: "chats"; chats: unknown[]; activeId: string }
  | { kind: "cleared" }
  | { kind: "cwd"; path: string }
  | { kind: "project"; id: string; name: string }
  | { kind: "watch"; description: string; detail: string }
  | { kind: "conversation_reset"; newId: string }
  | { kind: "delta"; text: string }
  /** Thinking text as it streams (live-only) and the finished block (persisted, capped). Most blocks carry no text — see README. */
  | { kind: "thinking_delta"; text: string }
  | { kind: "thinking"; text: string }
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

export type PromptImage = { media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string; thumb: string };
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGES = 4;
/** Base64 length cap per image (~3.75 MB of pixels); the client downscales well below this. */
export const MAX_IMAGE_B64 = 5 * 1024 * 1024;
const MAX_THUMB_B64 = 64 * 1024;

/** [] when absent; false when present but malformed — the whole prompt is refused then, not silently stripped. */
function parseImages(v: unknown): PromptImage[] | false {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_IMAGES) return false;
  const out: PromptImage[] = [];
  for (const i of v) {
    if (!i || typeof i !== "object") return false;
    const { media_type, data, thumb } = i as Record<string, unknown>;
    if (typeof media_type !== "string" || !IMAGE_TYPES.has(media_type)) return false;
    if (typeof data !== "string" || !data.length || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(data)) return false;
    if (typeof thumb !== "string" || thumb.length > MAX_THUMB_B64 || (thumb.length && !/^[A-Za-z0-9+/=]+$/.test(thumb))) return false;
    out.push({ media_type: media_type as PromptImage["media_type"], data, thumb });
  }
  return out;
}

/** Every `kind` a client can receive, for the coverage test. */
export const CLIENT_EVENT_KINDS = [
  "ready", "user", "text", "tool", "tool_result", "approval", "approval_closed", "mode", "commands",
  "local", "file", "chats", "cleared", "cwd", "project", "watch", "conversation_reset", "delta", "thinking_delta", "thinking", "task", "task_progress", "models", "model", "rewind", "browsers",
  "replayed", "status", "question", "turn_end", "error", "ping",
] as const satisfies readonly ClientEvent["kind"][];

/** The permission modes a client may ask for. Validated on the way in. */
export const PERMISSION_MODES = [
  "default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions",
] as const satisfies readonly PermissionMode[];

/** Client → server on /ws. */
export type AgentMessage =
  /** images: base64 data (full size, sent to the model) and a small base64 thumb (kept with the chat). */
  | { type: "prompt"; text: string; withTab?: boolean; images?: PromptImage[] }
  /** instance "" = no preference (the server picks: the newest person's browser). */
  | { type: "browser"; instance: string }
  | { type: "answer"; id: string; answers: Record<string, string> }
  /** mode: with an allow on ExitPlanMode, the mode to build in (default = ask, acceptEdits = auto-accept edits). */
  | { type: "decision"; id: string; decision: "allow" | "always" | "deny"; mode?: PermissionMode }
  | { type: "cwd"; path: string }
  | { type: "project"; id: string }
  | { type: "mode"; mode: PermissionMode }
  /** Switch this chat's model; "" means back to the CLI's default. */
  | { type: "model"; model: string }
  /** Restore tracked files to their state before the user message `uuid`; dryRun previews. */
  | { type: "rewind"; uuid: string; dryRun: boolean }
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
  "prompt", "browser", "answer", "decision", "cwd", "project", "mode", "model", "rewind",
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
      const images = parseImages(m.images);
      if (images === false) return null;
      if ((text === null || !text.trim()) && !images.length) return null;
      return { type: "prompt", text: text ?? "", ...(typeof m.withTab === "boolean" ? { withTab: m.withTab } : {}), ...(images.length ? { images } : {}) };
    }
    case "browser": { const instance = str("instance"); return { type: "browser", instance: instance ?? "" }; }
    case "answer": {
      const id = str("id");
      if (!id || !m.answers || typeof m.answers !== "object") return null;
      return { type: "answer", id, answers: m.answers as Record<string, string> };
    }
    case "decision": {
      const id = str("id"); const d = m.decision;
      if (!id || (d !== "allow" && d !== "always" && d !== "deny")) return null;
      if (m.mode !== undefined && !(PERMISSION_MODES as readonly unknown[]).includes(m.mode)) return null;
      return { type: "decision", id, decision: d, ...(m.mode !== undefined ? { mode: m.mode as PermissionMode } : {}) };
    }
    case "cwd": { const path = str("path"); return path !== null ? { type: "cwd", path } : null; }
    case "project": { const id = str("id"); return id ? { type: "project", id } : null; }
    case "mode": {
      const mode = m.mode;
      return (PERMISSION_MODES as readonly unknown[]).includes(mode) ? { type: "mode", mode: mode as PermissionMode } : null;
    }
    case "model": {
      const model = str("model");
      return model !== null && /^[A-Za-z0-9._:-]{0,64}$/.test(model) ? { type: "model", model } : null;
    }
    case "rewind": {
      const uuid = str("uuid");
      return uuid !== null && /^[0-9a-f-]{36}$/i.test(uuid) ? { type: "rewind", uuid, dryRun: m.dryRun === true } : null;
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
