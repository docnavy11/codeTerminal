import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type PermissionUpdate, type PermissionMode, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { Pushable, deferred } from "./pushable.js";
import { browserTools, terminalTools, watchTools, promptTools } from "./tools.js";
import { composePrompt } from "./prompt.js";
import { summariseResult } from "./results.js";
import { previewDiff } from "./diff.js";
import type { BrowserBridge } from "./browser.js";
import type { Shell } from "./shell.js";
import type { WatchRegistry } from "./watches.js";
import type { PromptStore } from "./prompts.js";
import { randomUUID } from "node:crypto";

import type { ClientEvent, StatusState, AskQuestion } from "./protocol.js";
export type { ClientEvent, StatusState, AskQuestion };

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
 * Runaway protection. None of these are measured optima; they are ceilings a
 * legitimate turn should not reach, chosen so that a spiral (56 tool calls
 * and 20 screenshots in one turn, 2026-09-11) is stopped and reported rather
 * than left to run. All overridable in .env.
 */
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** Tool calls in one turn before the session is interrupted. */
export const MAX_TOOL_CALLS = num(process.env.CODETERM_MAX_TOOL_CALLS, 100);
/** Screenshots in one turn before the tool refuses and asks the model to report. */
export const MAX_SCREENSHOTS = num(process.env.CODETERM_MAX_SCREENSHOTS, 15);
/** Cost ceiling for one session (the SDK's maxBudgetUsd); unset = none. */
export const MAX_BUDGET_USD = process.env.CODETERM_MAX_BUDGET_USD ? num(process.env.CODETERM_MAX_BUDGET_USD, 0) || undefined : undefined;

/** Thinking text kept with a chat; the median block with text is ~250 chars (measured), so this is generous. */
export const THINKING_CAP = 4096;

/** Per-turn counters the browser tools consult. */
export type TurnBudget = { screenshots: number; maxScreenshots: number };

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
  /** Which browser this conversation's browser tools should act in. */
  prefer: () => string | undefined;
  /** The SDK entry point. Tests inject a scripted one; production leaves it unset. */
  spawnQuery?: typeof query;
  /** Names a chat from its first message. Also an SDK call, also injectable. */
  titler?: (firstUser: string) => Promise<string | null>;
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

  async start(resumeId?: string, granted: PermissionUpdate[] = [], mode: PermissionMode = "default"): Promise<void> {
    const d = this.#deps;
    this.#granted = granted;
    // The mode has to be in place BEFORE query() reads it below. The old path
    // spawned the session, then fire-and-forget called setMode() — but the
    // query did not exist yet, so setPermissionMode() was a no-op and the SDK
    // launched in "default" regardless of what the chat was saved as. Set it
    // here, clamping a bypass the deployment has not enabled back to default so
    // the launch can never be more permissive than the runtime guard allows.
    this.#mode = mode === "bypassPermissions" && !ALLOW_BYPASS ? "default" : mode;
    this.#query = (d.spawnQuery ?? query)({
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
          ...(d.bridge ? { browser: browserTools(d.bridge, d.prefer, () => this.#budget) } : {}),
          // The chat id is this session's own, so a watch is always attributed
          // to the conversation that set it.
          ...(d.bridge && d.watches ? { watch: watchTools(d.bridge, d.watches, () => d.chatId, d.prefer) } : {}),
          ...(d.prompts ? { prompts: promptTools(d.prompts) } : {}),
        },
        permissionMode: this.#mode,
        allowDangerouslySkipPermissions: ALLOW_BYPASS,
        ...(MAX_BUDGET_USD ? { maxBudgetUsd: MAX_BUDGET_USD } : {}),
        canUseTool: this.#canUseTool,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    });

    // system/init does not arrive until the first prompt, but the menu needs
    // the list before the user types — so ask straight away.
    void this.#publishCommands();

    let cause = "";
    try {
      for await (const msg of this.#query) this.#handle(msg);
    } catch (err) {
      cause = err instanceof Error ? err.message : String(err);
    }
    // The iterable ending is the only signal that the subprocess is gone. It
    // used to be ignored: #busy stayed wherever it was and the next send()
    // pushed into an input nobody read, so the prompt vanished silently.
    this.#dead = true;
    this.#busy = false;
    this.#input.end();          // nothing reads it any more; a later send() is dropped, not queued
    this.#activeTools.clear();
    this.#compacting = false;
    for (const [id, p] of this.#pending) {
      this.#emit({ kind: "approval_closed", id, decision: "gone" });
      p.resolve({ behavior: "deny", message: "Session ended." });
    }
    this.#pending.clear();
    if (!this.#closed) {
      this.#emit({ kind: "error", message: `Claude session ended${cause ? ` (${cause})` : ""} — it restarts on your next message.` });
      this.#pushStatus();
    }
  }

  #dead = false;
  #closed = false;
  /** True once the SDK stream has ended, for whatever reason. send() would be lost. */
  get dead() { return this.#dead; }

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

    // For an Edit/Write the card shows the change itself. The file read is
    // async; the card waits for it (bounded), and is not shown at all if the
    // SDK withdrew the request meanwhile.
    const emitCard = (diff: Awaited<ReturnType<typeof previewDiff>>) => {
      if (!this.#pending.has(id)) return;
      this.#emit({ kind: "approval", id, tool, input, canAlways: sugg.length > 0, ...(diff ? { diff } : {}) });
      this.#pushStatus();
    };
    if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
      void Promise.race([
        previewDiff(tool, input, this.#workspace).catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 1500)),
      ]).then(emitCard);
    } else emitCard(null);
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
  send(text: string, context?: string, images: { media_type: string; data: string }[] = []): void {
    this.#busy = true;
    this.#thinkingTokens = 0;
    this.#turnToolCalls = 0; this.#budget.screenshots = 0; this.#turnStopped = false;
    this.#pushStatus();
    const prompt = composePrompt(text || (images.length ? "(see the attached image)" : ""), context);
    // Images go first, as the API recommends; the words follow.
    const content = images.length
      ? [...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.media_type as "image/png", data: i.data } })), { type: "text" as const, text: prompt }]
      : prompt;
    this.#input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
  }

  async interrupt(): Promise<void> { await this.#query?.interrupt(); }

  /** Real shutdown — not called merely because a browser tab went away. */
  close(): void {
    this.#closed = true;
    // Ending the input does not stop a turn already running; without this a
    // deleted chat kept spending tokens until the model finished on its own.
    if (this.#busy) void this.#query?.interrupt().catch(() => {});
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
        } else if (msg.subtype === "api_retry") {
          // Without this an API outage looked like "thinking" with nothing behind it.
          const r = msg as unknown as { attempt: number; max_retries: number; retry_delay_ms: number; error_status: number | null };
          this.#emit({ kind: "local", text: `API retry ${r.attempt} of ${r.max_retries} in ${Math.round(r.retry_delay_ms / 1000)}s${r.error_status ? ` (HTTP ${r.error_status})` : ""}` });
        } else if (msg.subtype === "model_refusal_no_fallback" || msg.subtype === "model_refusal_fallback") {
          const r = msg as unknown as { content?: string; api_refusal_explanation?: string | null; original_model?: string };
          this.#emit({ kind: "error", message: `The model refused this request${r.api_refusal_explanation ? `: ${r.api_refusal_explanation}` : ""}${r.content ? ` — ${r.content}` : ""}` });
        } else if (msg.subtype === "permission_denied") {
          const r = msg as unknown as { tool_name: string };
          this.#emit({ kind: "local", text: `${r.tool_name} was denied by policy (settings), not by you` });
        } else if (msg.subtype === "notification") {
          const r = msg as unknown as { text: string; priority: "low" | "medium" | "high" | "immediate" };
          if (r.priority !== "low") this.#emit({ kind: "local", text: r.text });
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
          // Thinking arrives complete here (and as thinking_delta while it
          // streams). Most blocks are empty — the API omits the text and
          // sends only token counts — so only a block with words is shown.
          else if (block.type === "thinking" && typeof (block as { thinking?: string }).thinking === "string" && (block as { thinking: string }).thinking.trim()) {
            this.#emit({ kind: "thinking", text: (block as { thinking: string }).thinking.slice(0, THINKING_CAP) });
          }
          else if (block.type === "tool_use") {
            this.#activeTools.set(block.id, block.name);
            this.#emit({ kind: "tool", id: block.id, name: block.name, input: block.input });
            // The circuit breaker: a turn that keeps calling tools is stopped
            // and told so, instead of running until the model gives up.
            if (++this.#turnToolCalls > MAX_TOOL_CALLS && !this.#turnStopped) {
              this.#turnStopped = true;
              this.#emit({ kind: "error", message: `Stopped: ${MAX_TOOL_CALLS} tool calls in one turn (CODETERM_MAX_TOOL_CALLS). Send a narrower request, or raise the limit.` });
              void this.#query?.interrupt().catch(() => {});
            }
          }
        }
        this.#pushStatus();
        return;

      // tool_result blocks tell us a tool finished.
      case "user": {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          // The structured output rides beside the block (SDK: tool_use_result;
          // the CLI's own transcripts spell it toolUseResult).
          const m = msg as unknown as { tool_use_result?: unknown; toolUseResult?: unknown; parent_tool_use_id?: string | null };
          const structured = m.tool_use_result ?? m.toolUseResult;
          for (const b of content) {
            if (b.type !== "tool_result") continue;
            const name = this.#activeTools.get(b.tool_use_id) ?? "tool";
            this.#activeTools.delete(b.tool_use_id);
            const r = summariseResult(name, b as { tool_use_id: string; content?: unknown; is_error?: boolean }, structured);
            this.#emit({ kind: "tool_result", id: b.tool_use_id, name, ...r, parent: m.parent_tool_use_id ?? null });
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
        const ev = msg.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
          this.#emit({ kind: "delta", text: ev.delta.text });
        } else if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
          this.#emit({ kind: "thinking_delta", text: ev.delta.thinking });
        }
        return;
      }

      case "result": {
        this.#busy = false;
        this.#activeTools.clear();
        this.#compacting = false;
        // total_cost_usd is the RUNNING TOTAL for this query() — "read the latest
        // result rather than summing". The client sums per-turn costs, so hand
        // it the difference; summing the totals showed $17.9 for a $4.53 chat.
        const total = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : null;
        const turnCost = total === null ? null : Math.max(0, total - this.#costTotal);
        if (total !== null) this.#costTotal = total;
        this.#emit({
          kind: "turn_end",
          costUsd: turnCost,
          sessionCostUsd: total,
          stopped: stoppedReason(msg as unknown as ResultLike),
          context: contextOf(msg as unknown as ResultLike),
          isError: msg.is_error === true,
          denials: msg.permission_denials?.length ?? 0,
        });
        this.#pushStatus();
        return;
      }
    }
  }
  /** The SDK's running total at the last result, so a turn's cost is the difference. */
  #costTotal = 0;
  #turnToolCalls = 0;
  #turnStopped = false;
  #budget: TurnBudget = { screenshots: 0, maxScreenshots: MAX_SCREENSHOTS };
}

type ResultLike = {
  subtype?: string; errors?: string[]; num_turns?: number;
  usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, { contextWindow?: number }>;
};

/** Why a turn ended early, in words — or null for a normal end. */
export function stoppedReason(r: ResultLike): string | null {
  switch (r.subtype) {
    case undefined: case "success": return null;
    case "error_max_turns": return `reached the turn limit${r.num_turns ? ` (${r.num_turns} turns)` : ""}`;
    case "error_max_budget_usd": return `reached the cost ceiling${MAX_BUDGET_USD ? ` ($${MAX_BUDGET_USD})` : ""}`;
    case "error_max_structured_output_retries": return "could not produce the requested output format";
    case "error_during_execution": return r.errors?.length ? r.errors.join("; ") : "an error during execution";
    default: return r.errors?.length ? r.errors.join("; ") : r.subtype;
  }
}

/**
 * What the next request re-sends (the SDK: last response's input + cache read
 * + cache creation + output) against the largest context window in play.
 */
export function contextOf(r: ResultLike): { tokens: number; window: number } | null {
  const u = r.usage; if (!u) return null;
  const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
  const window = Math.max(0, ...Object.values(r.modelUsage ?? {}).map((m) => m.contextWindow ?? 0));
  return window > 0 ? { tokens, window } : null;
}
