import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type PermissionUpdate, type PermissionMode, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { Pushable, deferred } from "./pushable.js";
import { browserTools, terminalTools, watchTools, promptTools } from "./tools.js";
import { composePrompt } from "./prompt.js";
import type { BrowserBridge } from "./browser.js";
import type { Shell } from "./shell.js";
import type { WatchRegistry } from "./watches.js";
import type { PromptStore } from "./prompts.js";
import { randomUUID } from "node:crypto";

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

/** What the browser receives. One flat, discriminated shape. */
export type ClientEvent =
  | { kind: "ready"; sessionId: string; model: string; workspace: string; canBypass: boolean }
  | { kind: "user"; text: string; context?: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "approval"; id: string; tool: string; input: unknown; canAlways: boolean }
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
  | { kind: "turn_end"; costUsd: number | null; isError: boolean; denials: number }
  | { kind: "error"; message: string };

/**
 * Auto-approved without a prompt. Local reads only — nothing here can modify
 * the workspace or reach the network. WebFetch/WebSearch are deliberately NOT
 * listed: they exfiltrate, so they go through the gate like Bash and Write.
 */
const READ_ONLY = ["Read", "Glob", "Grep", "NotebookRead", "TodoWrite"];

/**
 * 'bypassPermissions' is refused at runtime unless the session was launched
 * with allowDangerouslySkipPermissions. Off by default: it lets the agent run
 * Bash and edit files with nobody watching.
 */
export const ALLOW_BYPASS = process.env.CODETERM_ALLOW_BYPASS === "1";

/**
 * What a session needs from the rest of the server.
 *
 * Passed in rather than read from module globals: with several sessions live
 * at once, a global "current chat" would attribute every session's watches to
 * whichever chat happened to be last. Each session carries its own id.
 */
export type SessionDeps = {
  chatId: string;
  bridge: BrowserBridge | null;
  /** Resolved lazily: the shell pane comes and goes as tabs open and close. */
  getShell: () => Shell | null;
  watches: WatchRegistry | null;
  prompts: PromptStore | null;
};

/**
 * Browser tools are auto-approved by explicit choice: full control, ungated.
 * They still appear in the transcript, so every action is visible after the
 * fact even though nothing stops to ask.
 */
const BROWSER_TOOLS = [
  "list_tabs", "read_page", "snapshot", "navigate",
  "click", "fill", "press", "eval", "screenshot",
].map((n) => `mcp__browser__${n}`);

// Reading the user's own terminal is inert, so it never needs a prompt.
const TERMINAL_TOOLS = ["mcp__terminal__read"];
const WATCH_TOOLS = ["mcp__watch__page", "mcp__watch__list", "mcp__watch__stop"];
// Reading the library is inert. Saving and deleting are not auto-approved:
// a saved prompt is something the user clicks and runs later.
const PROMPT_TOOLS = ["mcp__prompts__list"];

/** Set CODETERM_ISOLATED=1 to run without your personal skills and CLAUDE.md. */
const SETTING_SOURCES: ("user" | "project" | "local")[] =
  process.env.CODETERM_ISOLATED ? [] : ["user", "project"];

/**
 * Commands whose UX is bound to a real terminal. The CLI advertises these in
 * `terminal_slash_commands`; the SDK docs say remote UIs should hide them.
 * We also drop the ones that would fight our own UI.
 */
const HIDE_EXTRA = new Set([
  // advertised by this CLI in terminal_slash_commands
  "doctor", "color", "reload-plugins",
  // would fight this UI, or need a real terminal
  "exit", "quit", "login", "logout", "statusline", "vim", "terminal-setup",
]);

type Pending = {
  resolve: (r: PermissionResult) => void;
  tool: string;
  suggestions: PermissionUpdate[];
  /** Set for AskUserQuestion, whose answer rides back in updatedInput. */
  question?: { input: Record<string, unknown>; questions: AskQuestion[] };
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

  #deps: SessionDeps;

  constructor(workspace: string, emit: (e: ClientEvent) => void, deps: SessionDeps) {
    this.#workspace = workspace;
    this.#emit = emit;
    this.#deps = deps;
  }

  get busy() { return this.#busy; }
  get mode() { return this.#mode; }
  get granted() { return this.#granted; }

  /** Swap the sink when a browser attaches or detaches. */
  setEmit(emit: (e: ClientEvent) => void): void { this.#emit = emit; }

  async start(resumeId?: string, granted: PermissionUpdate[] = []): Promise<void> {
    const d = this.#deps;
    this.#granted = granted;
    this.#query = query({
      prompt: this.#input,
      options: {
        cwd: this.#workspace,
        additionalDirectories: [],
        // Loads your ~/.claude and project config: custom slash commands,
        // skills, CLAUDE.md. Measured: this is the difference between 52 and
        // 82 available commands. It does NOT weaken canUseTool — the explicit
        // permissionMode below wins over settings' defaultMode.
        settingSources: SETTING_SOURCES,
        // Without this an assistant message only arrives complete, so a long
        // turn shows nothing at all until the model finishes its first block.
        includePartialMessages: true,
        allowedTools: [...READ_ONLY, ...BROWSER_TOOLS, ...TERMINAL_TOOLS, ...WATCH_TOOLS, ...PROMPT_TOOLS],
        mcpServers: {
          terminal: terminalTools(this.#deps.getShell),
          ...(d.bridge ? { browser: browserTools(d.bridge) } : {}),
          // The chat id is this session's own, so a watch is always attributed
          // to the conversation that set it.
          ...(d.bridge && d.watches ? { watch: watchTools(d.bridge, d.watches, () => d.chatId) } : {}),
          ...(d.prompts ? { prompts: promptTools(d.prompts) } : {}),
        },
        permissionMode: this.#mode,
        allowDangerouslySkipPermissions: ALLOW_BYPASS,
        canUseTool: this.#canUseTool,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    });

    // system/init does not arrive until the first prompt, but the menu needs
    // the list before the user types — so ask straight away.
    void this.#publishCommands();

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
      this.#pushStatus();
      resolve({ behavior: "deny", message: "Interrupted before you answered." });
    }, { once: true });

    // AskUserQuestion is not a permission prompt — it is Claude asking you
    // something. The answer travels back as updatedInput.answers.
    if (tool === "AskUserQuestion") {
      const questions = (input.questions as AskQuestion[] | undefined) ?? [];
      this.#pending.set(id, { resolve, tool, suggestions: sugg, question: { input, questions } });
      this.#emit({ kind: "question", id, questions });
      this.#pushStatus();
      return promise;
    }

    this.#emit({ kind: "approval", id, tool, input, canAlways: sugg.length > 0 });
    this.#pushStatus();
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
    this.#pushStatus();
    return true;
  }

  /** Answer an AskUserQuestion. `answers` is keyed by the question text. */
  answer(id: string, answers: Record<string, string>): boolean {
    const p = this.#pending.get(id);
    if (!p?.question) return false;
    this.#pending.delete(id);
    p.resolve({ behavior: "allow", updatedInput: { ...p.question.input, answers } });
    this.#emit({ kind: "approval_closed", id, decision: "allow" });
    this.#pushStatus();
    return true;
  }

  async setMode(mode: PermissionMode): Promise<void> {
    if (mode === "bypassPermissions" && !ALLOW_BYPASS) {
      this.#emit({ kind: "error", message: "\"Never ask\" is disabled. Set CODETERM_ALLOW_BYPASS=1 in .env and restart to enable it." });
      this.#emit({ kind: "mode", mode: this.#mode });   // snap the UI back
      return;
    }
    const previous = this.#mode;
    try {
      await this.#query?.setPermissionMode(mode);
      this.#mode = mode;
      this.#emit({ kind: "mode", mode });
    } catch (err) {
      this.#emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      this.#emit({ kind: "mode", mode: previous });
    }
  }

  /**
   * `context` is ambient browser state, prepended in a tagged block so the
   * model can tell it from what the user actually typed. It is page-derived,
   * therefore untrusted — hence the explicit note rather than a bare paste.
   */
  send(text: string, context?: string): void {
    this.#busy = true;
    this.#thinkingTokens = 0;
    this.#pushStatus();
    this.#input.push({
      type: "user",
      message: { role: "user", content: composePrompt(text, context) },
      parent_tool_use_id: null,
    });
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

  #hidden = new Set<string>(HIDE_EXTRA);
  #activeTools = new Map<string, string>();   // tool_use_id -> tool name
  #compacting = false;
  #thinkingTokens = 0;
  #lastStatus = "";

  /** The single source of truth for "is it busy, or is it waiting on me?" */
  status(): { kind: "status"; state: StatusState; detail: string; tokens: number } {
    let state: StatusState = "idle";
    let detail = "";

    if (this.#pending.size > 0) {
      state = "awaiting";
      const [first] = [...this.#pending.values()];
      detail = this.#pending.size > 1
        ? `${this.#pending.size} things`
        : first.question ? "a question" : first.tool;
    } else if (this.#compacting) {
      state = "compacting";
    } else if (this.#activeTools.size > 0) {
      state = "tool";
      const names = [...new Set(this.#activeTools.values())];
      detail = names.length > 1 ? `${names.length} tools` : names[0];
    } else if (this.#busy) {
      state = "thinking";
    }
    return { kind: "status", state, detail, tokens: this.#thinkingTokens };
  }

  #pushStatus(): void {
    const s = this.status();
    const key = `${s.state}|${s.detail}|${Math.round(s.tokens / 200)}`;  // throttle token churn
    if (key === this.#lastStatus) return;
    this.#lastStatus = key;
    this.#emit(s);
  }

  /** Rich command list (name, description, argument hint) for the UI menu. */
  async #publishCommands(): Promise<void> {
    try {
      const all = await this.#query?.supportedCommands();
      if (all) this.#emit({ kind: "commands", commands: this.#visible(all) });
    } catch { /* older CLI without supportedCommands */ }
  }

  #visible(cmds: SlashCommand[]): SlashCommand[] {
    return cmds
      .filter((c) => !this.#hidden.has(c.name) && !c.name.startsWith("__"))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  #handle(msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          this.sdkSessionId = msg.session_id;
          for (const c of (msg as { terminal_slash_commands?: string[] }).terminal_slash_commands ?? []) {
            this.#hidden.add(c);
          }
          this.#emit({ kind: "ready", sessionId: msg.session_id, model: msg.model, workspace: this.#workspace, canBypass: ALLOW_BYPASS });
          void this.#publishCommands();
        } else if (msg.subtype === "commands_changed") {
          // The SDK says to REPLACE the cached list, not merge.
          this.#emit({ kind: "commands", commands: this.#visible(msg.commands) });
        } else if (msg.subtype === "local_command_output") {
          this.#emit({ kind: "local", text: msg.content });
        } else if (msg.subtype === "status") {
          this.#compacting = msg.status === "compacting";
          this.#pushStatus();
        } else if (msg.subtype === "thinking_tokens") {
          this.#thinkingTokens = msg.estimated_tokens;
          this.#pushStatus();
        }
        return;

      // Heartbeats while a tool runs; also how we learn a tool actually started.
      case "tool_progress":
        this.#activeTools.set(msg.tool_use_id, msg.tool_name);
        this.#pushStatus();
        return;

      case "assistant":
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) this.#emit({ kind: "text", text: block.text });
          else if (block.type === "tool_use") {
            this.#activeTools.set(block.id, block.name);
            this.#emit({ kind: "tool", id: block.id, name: block.name, input: block.input });
          }
        }
        this.#pushStatus();
        return;

      // tool_result blocks tell us a tool finished.
      case "user": {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === "tool_result") this.#activeTools.delete(b.tool_use_id);
          }
          this.#pushStatus();
        }
        return;
      }

      // /clear, plan-mode exit and fresh-session flows. The SDK has dropped
      // its context; the transcript on our side has to go with it or the user
      // sees a full history the model can no longer remember.
      case "conversation_reset":
        this.sdkSessionId = msg.new_conversation_id;
        this.#emit({ kind: "conversation_reset", newId: msg.new_conversation_id });
        return;

      // Live text as it is generated. Kept separate from the "text" event,
      // which arrives complete and is the copy that gets persisted.
      case "stream_event": {
        const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.#emit({ kind: "delta", text: ev.delta.text });
        }
        return;
      }

      case "result":
        this.#busy = false;
        this.#activeTools.clear();
        this.#compacting = false;
        this.#emit({
          kind: "turn_end",
          costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null,
          isError: msg.is_error === true,
          denials: msg.permission_denials?.length ?? 0,
        });
        this.#pushStatus();
        return;
    }
  }
}
