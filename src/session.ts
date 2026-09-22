import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type PermissionUpdate, type PermissionMode, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { Pushable, deferred } from "./pushable.js";
import { browserTools, terminalTools, watchTools, promptTools, fileTools, type SubmitDetail } from "./tools.js";
import { composePrompt } from "./prompt.js";
import { summariseResult } from "./results.js";
import { previewDiff } from "./diff.js";
import { levelCovers, type BrowserAllowlist, type Level } from "./browser-allow.js";
import type { BrowserPolicy } from "./tools.js";
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
/** The in-process MCP servers this process registers; the tool-server check alarms only about these. */
export const OUR_SERVERS = new Set(["terminal", "browser", "watch", "prompts", "files"]);

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
  /** False when the server runs without a shell pane: the terminal tool is not registered at all. */
  shell?: boolean;
  /** Named sessions for the terminal tool, when the machine has tmux. */
  tmux?: Parameters<typeof terminalTools>[1];
  watches: WatchRegistry | null;
  prompts: PromptStore | null;
  /** Which browser this conversation's browser tools should act in. */
  prefer: () => string | undefined;
  /** Sites the browser tools may use without asking; "Always" on the card adds to it. Absent = allow everything (tests). */
  browserAllow?: BrowserAllowlist | null;
  /** Confirm-before-submit cards (default on; CODETERM_CONFIRM_SUBMIT=0 turns them off). */
  confirmSubmit?: boolean;
  /** Server log line for things a person should see in the journal. */
  warn?: (line: string) => void;
  /** Cost ceiling for this session, overriding CODETERM_MAX_BUDGET_USD (scheduled runs). */
  maxBudgetUsd?: number;
  /** The browsable root; files under it can be offered as downloads. */
  filesRoot?: string;
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
  "click", "fill", "press", "eval", "screenshot", "download", "find", "scroll", "wait_for", "handle_dialog",
  "open_tab", "close_tab", "focus_tab", "back", "forward", "reload", "fill_form", "browser_batch", "upload", "console_read", "network_read", "type",
].map((n) => `mcp__browser__${n}`);

// Reading the user's own terminal is inert, so it never needs a prompt.
const TERMINAL_TOOLS = ["mcp__terminal__read"];
const WATCH_TOOLS = ["mcp__watch__page", "mcp__watch__list", "mcp__watch__stop"];
// Reading the library is inert. Saving and deleting are not auto-approved:
// a saved prompt is something the user clicks and runs later.
const PROMPT_TOOLS = ["mcp__prompts__list"];
// Offering a file only announces it; the file was already written through the gate.
const FILE_TOOLS = ["mcp__files__offer"];

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
  /** Set for a browser-site ask: which host, action and level; "always" adds the host to the standing list at that level. */
  browser?: { host: string; action: string; level: Level };
  submit?: SubmitDetail;
  /** Set for AskUserQuestion, whose answer rides back in updatedInput. */
  question?: { input: Record<string, unknown>; questions: AskQuestion[] };
};

/**
 * What to call a pending card in a notification or status line. The tool
 * name alone ("Bash") told a scheduled run's Telegram or webhook target
 * nothing to decide on; this adds the one field a person would actually
 * look for, the same fields manage.js's own summarise() reads off a
 * finished tool call's input, capped so one long command does not swallow
 * the rest of the message.
 */
function describeCard(tool: string, input: unknown): string {
  const i = input as Record<string, unknown> | null | undefined;
  const detail = i && typeof i.command === "string" ? i.command
    : i && typeof i.file_path === "string" ? i.file_path : "";
  if (!detail) return tool;
  return `${tool}: ${detail.length > 120 ? `${detail.slice(0, 119)}…` : detail}`;
}

/** "Opus 5.5 with 1M context · Best for…" → "Opus 5.5 with 1M context"; the CLI's own default says so. */
export function modelLabel(m: { value: string; displayName?: string; description?: string }): string {
  const lead = m.description?.split(" · ")[0]?.trim();
  if (m.value === "default") return lead ? `default (${lead})` : "default";
  return lead || m.displayName || m.value;
}

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

  #model: string | null = null;
  get model() { return this.#model; }

  async start(resumeId?: string, granted: PermissionUpdate[] = [], mode: PermissionMode = "default", model?: string): Promise<void> {
    this.#model = model ?? null;
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
        allowedTools: [...READ_ONLY, ...BROWSER_TOOLS, ...(d.shell === false ? [] : TERMINAL_TOOLS), ...WATCH_TOOLS, ...PROMPT_TOOLS, ...FILE_TOOLS],
        mcpServers: {
          ...(d.shell === false ? {} : { terminal: terminalTools(this.#deps.getShell, d.tmux) }),
          ...(d.bridge ? { browser: browserTools(d.bridge, d.prefer, () => this.#budget, d.browserAllow === undefined ? undefined : this.#browserPolicy, () => this.#workspace, d.filesRoot,
            d.confirmSubmit === false ? undefined : (detail) => this.#askSubmit(detail)) } : {}),
          // The chat id is this session's own, so a watch is always attributed
          // to the conversation that set it.
          ...(d.bridge && d.watches ? { watch: watchTools(d.bridge, d.watches, () => d.chatId, d.prefer) } : {}),
          ...(d.prompts ? { prompts: promptTools(d.prompts) } : {}),
          ...(d.filesRoot ? { files: fileTools(d.filesRoot, this.#workspace, (e) => this.#emit(e)) } : {}),
        },
        permissionMode: this.#mode,
        ...(model ? { model } : {}),
        // Snapshots files before edits, so a user message is a point to
        // rewind the working tree to (rewindFiles below).
        enableFileCheckpointing: true,
        allowDangerouslySkipPermissions: ALLOW_BYPASS,
        ...((d.maxBudgetUsd ?? MAX_BUDGET_USD) ? { maxBudgetUsd: d.maxBudgetUsd ?? MAX_BUDGET_USD } : {}),
        canUseTool: this.#canUseTool,
        ...(resumeId ? { resume: resumeId } : {}),
      },
    });

    // system/init does not arrive until the first prompt, but the menu needs
    // the list before the user types — so ask straight away.
    void this.#publishCommands();
    void this.#publishModels();

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

  /* ---- browser sites: a card per new site per chat, eval per call ---- */
  #hostGrants = new Map<string, Level>();   // allowed for this chat (this live session), by level
  #evalGrants = new Set<string>();           // eval allowed on this host for this chat
  #browserPolicy: BrowserPolicy = {
    allowed: (host, level) => { const g = this.#hostGrants.get(host); return (g !== undefined && levelCovers(g, level)) || (this.#deps.browserAllow?.has(host, level) ?? false); },
    evalAllowed: (host) => this.#evalGrants.has(host),
    ask: (host, action, detail, level) => this.#askBrowser(host, action, detail, level),
  };
  /* Unattended: a scheduled run with nobody in front of it. Every card is
     shown as usual and answered "no" after the wait — including the site
     gate, which used to refuse on the spot. Refusing was right while the only
     way to answer was to be sitting at the page; now the run says "asked" the
     moment a card goes up, a notification carries a link to that chat, and
     the card is there waiting when you open it. The wait is the whole budget
     for noticing, unlocking a phone and tapping allow, so it is minutes, not
     seconds. */
  #unattended: { waitMs: number; onEvent: (kind: "needed" | "card" | "asked", detail: string) => void } | null = null;
  setUnattended(cfg: { waitMs: number; onEvent: (kind: "needed" | "card" | "asked", detail: string) => void } | null): void { this.#unattended = cfg; }
  get unattended(): boolean { return this.#unattended !== null; }
  /** Announce the card, then answer it "no" if nobody does within the wait. */
  #autoDeny(id: string, what: string, kind: "card" | "needed" = "card"): void {
    const u = this.#unattended; if (!u) return;
    u.onEvent("asked", what);
    const t = setTimeout(() => {
      if (!this.#pending.has(id)) return;
      u.onEvent(kind, what);
      this.decide(id, "deny");
    }, u.waitMs);
    t.unref?.();
  }

  /** A form is about to be submitted with filled fields: show it, wait for the answer. */
  #askSubmit(detail: SubmitDetail): Promise<boolean> {
    const id = randomUUID();
    const { promise, resolve } = deferred<PermissionResult>();
    this.#pending.set(id, { resolve, tool: "submit", suggestions: [], submit: detail });
    this.#emit({ kind: "approval", id, tool: "submit", input: detail, canAlways: false });
    this.#pushStatus();
    this.#autoDeny(id, `submit to ${detail.host}`);
    return promise.then((r) => r.behavior === "allow");
  }

  #askBrowser(host: string, action: string, detail: string | undefined, level: Level): Promise<"allow" | "deny"> {
    const id = randomUUID();
    const { promise, resolve } = deferred<PermissionResult>();
    this.#pending.set(id, { resolve, tool: "browser", suggestions: [], browser: { host, action, level } });
    this.#emit({ kind: "approval", id, tool: "browser", input: { host, action, level, ...(detail ? { detail } : {}) }, canAlways: true });
    this.#pushStatus();
    if (this.#unattended) {
      this.#emit({ kind: "local", text: `Unattended run: ${host} is not on the allowed sites list (${level} needed). Open this chat to allow it; it is refused if nobody does.` });
      this.#autoDeny(id, `${host} (${level}${action === "eval" ? ", eval" : ""})`, "needed");
    }
    return promise.then((r) => r.behavior);
  }

  /** The approval gate. The SDK awaits this, so the turn genuinely blocks here. */
  #canUseTool = (
    tool: string,
    input: Record<string, unknown>,
    { signal, suggestions }: { signal: AbortSignal; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> => {
    // A site ask arriving this way (the fixture's shape of the site gate)
    // follows the same unattended rule: a card, and "no" once the wait is up.
    if (this.#unattended && tool === "browser") {
      const host = String(input.host ?? "?"), level = String(input.level ?? "act");
      const bid = randomUUID();
      const { promise: bp, resolve: br } = deferred<PermissionResult>();
      this.#pending.set(bid, { resolve: br, tool: "browser", suggestions: [], browser: { host, action: "read", level: level as Level } });
      this.#emit({ kind: "approval", id: bid, tool: "browser", input, canAlways: true });
      this.#emit({ kind: "local", text: `Unattended run: ${host} is not on the allowed sites list (${level} needed). Open this chat to allow it; it is refused if nobody does.` });
      this.#pushStatus();
      this.#autoDeny(bid, `${host} (${level})`, "needed");
      return bp;
    }
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
      this.#autoDeny(id, "a question");
      return promise;
    }

    // For an Edit/Write the card shows the change itself. The file read is
    // async; the card waits for it (bounded), and is not shown at all if the
    // SDK withdrew the request meanwhile.
    const emitCard = (diff: Awaited<ReturnType<typeof previewDiff>>) => {
      if (!this.#pending.has(id)) return;
      this.#emit({ kind: "approval", id, tool, input, canAlways: sugg.length > 0, ...(diff ? { diff } : {}) });
      this.#autoDeny(id, describeCard(tool, input));
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

  /**
   * allow | always | deny. "always" also stops this tool asking again. `mode`
   * rides with an allow on ExitPlanMode: the plan is approved *and* the
   * session moves from planning to building in that mode — sent to the CLI as
   * a setMode permission update and applied to the session directly.
   */
  decide(id: string, decision: "allow" | "always" | "deny", mode?: PermissionMode): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);

    if (p.submit) {
      p.resolve(decision === "deny" ? { behavior: "deny", message: "stopped" } : { behavior: "allow" });
      this.#emit({ kind: "approval_closed", id, decision });
      this.#pushStatus();
      return true;
    }
    if (p.browser) {
      // allow: this chat. always: this site from now on (eval: this host, this chat — never standing).
      const { host, action, level } = p.browser;
      if (decision !== "deny") {
        // eval's per-call card on an already act-allowed site grants only eval; otherwise the level
        if (action === "eval" && this.#browserPolicy.allowed(host, "act")) { if (decision === "always") this.#evalGrants.add(host); }
        else {
          const cur = this.#hostGrants.get(host);
          if (!cur || !levelCovers(cur, level)) this.#hostGrants.set(host, level);
          if (decision === "always") this.#deps.browserAllow?.add(host, level);
          if (action === "eval" && decision === "always") this.#evalGrants.add(host);
        }
        p.resolve({ behavior: "allow" });
      } else p.resolve({ behavior: "deny", message: "declined" });
      this.#emit({ kind: "approval_closed", id, decision });
      this.#pushStatus();
      return true;
    }

    const modeUpdate: PermissionUpdate[] = mode && decision !== "deny" ? [{ type: "setMode", mode, destination: "session" }] : [];
    if (decision === "deny") {
      p.resolve({ behavior: "deny", message: p.tool === "ExitPlanMode"
        ? "The user wants the plan revised. Ask what should change, then present the plan again."
        : `The user denied ${p.tool}. Do not retry it; ask what to do instead.` });
    } else if (decision === "always") {
      this.#granted.push(...p.suggestions);
      p.resolve({ behavior: "allow", updatedPermissions: [...p.suggestions, ...modeUpdate] });
    } else {
      p.resolve({ behavior: "allow", ...(modeUpdate.length ? { updatedPermissions: modeUpdate } : {}) });
    }
    if (modeUpdate.length && mode) void this.setMode(mode);
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

  /**
   * Resolve the oldest pending card with plain text — for a channel that
   * only ever carries free text and no specific card id (a Telegram reply).
   * The same "first" `status()`'s own detail line already picks when there
   * is more than one. An AskUserQuestion accepts any text as its answer (its
   * first question only — this is one reply, not a form); an ordinary
   * permission card only understands yes/always/no and leaves anything else
   * open rather than guess on it.
   */
  resolveOldestPending(text: string): "answered" | "unclear" | "none" {
    const first = [...this.#pending][0];
    if (!first) return "none";
    const [id, p] = first;
    if (p.question) {
      this.answer(id, { [p.question.questions[0]?.question ?? ""]: text });
      return "answered";
    }
    const t = text.trim().toLowerCase();
    if (/^(y|yes|allow|ok|okay|approve)$/.test(t)) { this.decide(id, "allow"); return "answered"; }
    if (/^(a|always)$/.test(t)) { this.decide(id, "always"); return "answered"; }
    if (/^(n|no|deny|refuse|stop)$/.test(t)) { this.decide(id, "deny"); return "answered"; }
    return "unclear";
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
  send(text: string, context?: string, images: { media_type: string; data: string }[] = []): string {
    const uuid = randomUUID();   // the id the CLI keeps for this message; rewinds name it
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
      uuid,
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    return uuid;
  }

  /**
   * Restore the files the agent changed since the user message `uuid` (the
   * CLI keeps checkpoints per message). A dry run reports what would change.
   */
  async rewindFiles(uuid: string, dryRun: boolean): Promise<void> {
    try {
      const r = await this.#query?.rewindFiles(uuid, { dryRun });
      this.#emit({ kind: "rewind", uuid, dryRun, canRewind: r?.canRewind ?? false, ...(r?.error ? { error: r.error } : {}),
        files: r?.filesChanged ?? [], insertions: r?.insertions ?? 0, deletions: r?.deletions ?? 0 });
    } catch (err) {
      this.#emit({ kind: "rewind", uuid, dryRun, canRewind: false, error: err instanceof Error ? err.message : String(err), files: [], insertions: 0, deletions: 0 });
    }
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
  #browserUsed = false;
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

  /**
   * The models the CLI offers, for the picker; an older CLI simply has none.
   * displayName carries no version ("Opus"), and what an alias resolves to
   * changes with the bundled CLI, so the label is the description's lead
   * ("Opus 5.5 with 1M context") when there is one.
   */
  async #publishModels(): Promise<void> {
    try {
      const all = await this.#query?.supportedModels();
      if (all) this.#emit({ kind: "models", models: all.map((m) => ({ value: m.value, label: modelLabel(m) })) });
    } catch { /* no picker, no harm */ }
  }

  /** Switch model mid-session; "" or undefined means the CLI's default. Reports failure and keeps the old one. */
  async setModel(model: string | undefined): Promise<void> {
    const next = model || null;
    try {
      await this.#query?.setModel(next ?? undefined);
      this.#model = next;
      this.#emit({ kind: "model", model: next });
    } catch (err) {
      this.#emit({ kind: "error", message: `Could not switch model: ${err instanceof Error ? err.message : String(err)}` });
      this.#emit({ kind: "model", model: this.#model });
    }
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
          // Every in-process MCP server must come up "connected"; one that
          // failed (a tool schema the CLI cannot convert, 2026-09-13) silently
          // takes all its tools away from every session. Say so, loudly.
          const servers = (msg as { mcp_servers?: { name: string; status: string }[] }).mcp_servers ?? [];
          // Only the servers this process registered are ours to alarm about; a
          // connector from the user's own Claude config that "needs-auth" (the
          // Google Drive one, measured) is theirs, and is left to them.
          const failed = servers.filter((s) => s.status !== "connected" && OUR_SERVERS.has(s.name));
          this.#emit({ kind: "ready", sessionId: msg.session_id, model: msg.model, workspace: this.#workspace, canBypass: ALLOW_BYPASS, servers });
          if (failed.length) {
            const what = failed.map((s) => `${s.name} (${s.status})`).join(", ");
            this.#deps.warn?.(`[session] MCP server${failed.length > 1 ? "s" : ""} not connected: ${what} — its tools are missing from this session`);
            this.#emit({ kind: "local", text: `⚠ Tool server${failed.length > 1 ? "s" : ""} not connected: ${what}. Those tools are missing from this session — check the server log (and /setup).` });
          }
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
        } else if (msg.subtype === "task_started") {
          const r = msg as unknown as { task_id: string; tool_use_id?: string; description: string };
          this.#emit({ kind: "task", id: r.task_id, toolUseId: r.tool_use_id ?? null, description: r.description, state: "running" });
        } else if (msg.subtype === "task_progress") {
          const r = msg as unknown as { task_id: string; tool_use_id?: string; usage: { tool_uses: number; duration_ms: number }; last_tool_name?: string };
          this.#emit({ kind: "task_progress", id: r.task_id, toolUseId: r.tool_use_id ?? null, toolUses: r.usage?.tool_uses ?? 0, durationMs: r.usage?.duration_ms ?? 0, ...(r.last_tool_name ? { lastTool: r.last_tool_name } : {}) });
        } else if (msg.subtype === "task_notification") {
          const r = msg as unknown as { task_id: string; tool_use_id?: string; status: "completed" | "failed" | "stopped"; summary: string; usage?: { tool_uses: number; duration_ms: number } };
          this.#emit({ kind: "task", id: r.task_id, toolUseId: r.tool_use_id ?? null, description: "", state: r.status, summary: r.summary.slice(0, 4096),
            ...(r.usage ? { toolUses: r.usage.tool_uses, durationMs: r.usage.duration_ms } : {}) });
        }
        return;

      // Heartbeats while a tool runs; also how we learn a tool actually started.
      case "tool_progress":
        this.#activeTools.set(msg.tool_use_id, msg.tool_name);
        this.#pushStatus();
        return;

      case "assistant": {
        // A subagent's own words and tool calls arrive on the same stream,
        // marked with the Agent call they belong to; the client nests them.
        const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) this.#emit({ kind: "text", text: block.text, ...(parent ? { parent } : {}) });
          // Thinking arrives complete here (and as thinking_delta while it
          // streams). Most blocks are empty — the API omits the text and
          // sends only token counts — so only a block with words is shown.
          else if (block.type === "thinking" && typeof (block as { thinking?: string }).thinking === "string" && (block as { thinking: string }).thinking.trim()) {
            this.#emit({ kind: "thinking", text: (block as { thinking: string }).thinking.slice(0, THINKING_CAP) });
          }
          else if (block.type === "tool_use") {
            this.#activeTools.set(block.id, block.name);
            if (block.name.startsWith("mcp__browser__")) this.#browserUsed = true;
            this.#emit({ kind: "tool", id: block.id, name: block.name, input: block.input, ...(parent ? { parent } : {}) });
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
      }

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
            // The CLI switches itself into plan mode when EnterPlanMode runs
            // (its result says "Entered plan mode"); mirror that so the mode
            // menu shows the truth. Leaving plan mode goes through decide().
            if (name === "EnterPlanMode" && r.ok && this.#mode !== "plan") { this.#mode = "plan"; this.#emit({ kind: "mode", mode: "plan" }); }
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
        // The extension attaches Chrome's debugger to a tab the agent acts in
        // (to be able to answer its dialogs); the turn is over, let it go.
        if (this.#browserUsed) { this.#browserUsed = false; this.#deps.bridge?.send("release", {}, this.#deps.prefer()).catch(() => {}); }
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
