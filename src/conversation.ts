import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Session, type ClientEvent, type SessionDeps, OUR_SERVERS } from "./session.js";
import { Store, titleFrom, type ChatRecord, type ChatSummary } from "./store.js";
import { generateTitle } from "./titles.js";
import { ChatSearch } from "./search.js";
import { listProjects, resolveProject, orderByRecency, GENERAL_ID, type Project } from "./projects.js";

const MAX_EVENTS = 3000;

/** The CLI's words when a resume id names a conversation it does not have. */
const GONE = /No conversation found with session ID/;

/**
 * Events that describe the session process rather than the conversation: the
 * record keeps only the latest of each, a /clear keeps them, and a chat holding
 * nothing else has never been used.
 */
const SESSION_KINDS = new Set<ClientEvent["kind"]>(["ready", "commands", "models"]);

/**
 * Date.now(), but never the same value twice in this process. "Newest chat"
 * is the highest updatedAt; two chats stamped in the same millisecond (two
 * clients, a run starting as someone clicks New) tied, and the tie went to
 * whichever the store happened to list first — the older one.
 */
let lastStamp = 0;
export function stamp(): number { lastStamp = Math.max(Date.now(), lastStamp + 1); return lastStamp; }

/**
 * How many conversations may hold a live `claude` process at once. Each is a
 * real subprocess, so this is a memory and CPU ceiling, not a stylistic one.
 */
const MAX_LIVE = 4;

/**
 * One conversation: its record, its session, and the clients watching it.
 *
 * Everything here used to live on a single-instance Manager, which is why two
 * browsers saw the same chat — there was only ever one. Now each conversation
 * owns its own, and a client attaches to whichever it wants.
 */
export class LiveChat {
  #rec: ChatRecord;
  #store: Store;
  #session: Session;
  #workspace: string;
  #live = new Set<(e: ClientEvent) => void>();
  #saveTimer: NodeJS.Timeout | null = null;
  #titling = false;
  /** Set only when the user actually sends /clear. */
  #clearRequested = false;
  /**
   * Set by close(). A closed chat never writes its record again: closing the
   * session emits approval_closed for open cards (and a busy turn's result can
   * land later still), and each used to schedule a save — reproduced: a deleted
   * chat was written back into chats/ 400 ms after Store.remove archived it.
   */
  #closed = false;
  #onChange: () => void;

  #onReady: (e: Extract<ClientEvent, { kind: "ready" }>) => void;
  #onModels: (e: Extract<ClientEvent, { kind: "models" }>) => void;
  constructor(rec: ChatRecord, store: Store, workspace: string,
              deps: Omit<SessionDeps, "chatId">, mode: PermissionMode, onChange: () => void,
              onReady: (e: Extract<ClientEvent, { kind: "ready" }>) => void = () => {},
              onModels: (e: Extract<ClientEvent, { kind: "models" }>) => void = () => {}) {
    this.#onReady = onReady;
    this.#onModels = onModels;
    this.#rec = rec;
    this.#store = store;
    this.#workspace = workspace;
    this.#onChange = onChange;
    this.#session = this.#spawn(deps, mode);
  }

  #deps!: Omit<SessionDeps, "chatId">;
  #mode: PermissionMode = "default";

  #spawn(deps: Omit<SessionDeps, "chatId">, mode: PermissionMode): Session {
    this.#deps = deps;
    this.#mode = mode;
    const s = new Session(this.#rec.cwd ?? this.#workspace, this.#record,
      { ...deps, chatId: this.#rec.id, prefer: () => this.#extInstance, ...(this.#budgetUsd !== undefined ? { maxBudgetUsd: this.#budgetUsd } : {}) });
    if (this.#unattended) s.setUnattended(this.#unattended);
    this.#inFlight = null;
    this.#resumeGone = false;
    // Pass the mode into start() so the SDK launches with it. Setting it after
    // start (the old `void s.setMode(mode)`) raced the query into existence and
    // left the session running in "default".
    s.start(this.#rec.sdkSessionId ?? undefined, this.#rec.granted, mode, this.#rec.model)
      .catch((err) => this.#record({ kind: "error", message: String(err) }))
      // start() settles when the stream ends; only this chat's current session matters.
      .then(() => { if (s === this.#session && !this.#closed && this.#resumeGone) this.#startOver(); })
      // Nothing here may become an unhandled rejection: that ends the server.
      .catch((err) => this.#record({ kind: "error", message: String(err) }));
    return s;
  }

  /**
   * What was sent to a session that has not said `ready` yet, so it can be sent
   * again if that session turns out to have nothing to resume. The images are
   * kept in full here (the record keeps thumbnails) and dropped at `ready`.
   */
  #inFlight: { text: string; context?: string; images: { media_type: string; data: string }[]; uuid: string } | null = null;
  /** The CLI said the conversation it was asked to resume does not exist. */
  #resumeGone = false;

  #send(text: string, context?: string, images: { media_type: string; data: string }[] = []): string {
    const uuid = this.#session.send(text, context, images);
    if (this.#inFlight === null) this.#inFlight = { text, context, images, uuid };
    return uuid;
  }

  /**
   * The SDK session this chat saved no longer exists on the CLI's side. The
   * CLI answers the first prompt with an error result and exits, and every
   * rebuild resumed the same id again — reproduced with the fake SDK: four
   * prompts, four sessions all resuming the gone id, every prompt dropped. Start a fresh conversation instead, say so,
   * and send the prompt that hit the failure again rather than losing it.
   */
  #startOver(): void {
    const lost = this.#rec.sdkSessionId;
    const retry = this.#inFlight;
    this.#rec.sdkSessionId = null;
    this.#record({ kind: "local", text: `The saved Claude session${lost ? ` (${lost})` : ""} no longer exists, so Claude does not remember this conversation. Started a new session${retry ? " and sent your last message again" : ""}.` });
    this.#restart();
    if (!retry) return;
    const uuid = this.#send(retry.text, retry.context, retry.images);
    // Rewind names the user message by the uuid the CLI saw; that is the new one now.
    const ev = this.#rec.events.find((e) => e.kind === "user" && e.uuid === retry.uuid) as { uuid?: string } | undefined;
    if (ev) ev.uuid = uuid;
  }

  get id(): string { return this.#rec.id; }
  get record(): ChatRecord { return this.#rec; }
  get session(): Session { return this.#session; }
  get clients(): number { return this.#live.size; }
  /** Busy from the moment a prompt is accepted, not from when the SDK sees it. */
  get busy(): boolean { return this.#sending || this.#session.busy; }
  #sending = false;
  get lastTouched(): number { return this.#rec.updatedAt ?? 0; }
  get cwd(): string { return this.#rec.cwd ?? this.#workspace; }
  get mode(): PermissionMode { return this.#session.mode; }

  /**
   * The browser this conversation's tools act in — set by whichever client
   * attached from an extension. Without it, a chat in one browser would drive
   * tabs in another.
   */
  #extInstance: string | undefined;
  get extInstance(): string | undefined { return this.#extInstance; }
  /** undefined: the caller has no say (keep the pin); "": auto, unpin; else pin that browser. */
  useBrowser(instance: string | undefined): void {
    // "" used to be ignored like undefined, so picking "auto" in the panel
    // never unpinned the chat: the panel said auto while the tools kept
    // acting in (or refusing for want of) the browser pinned before.
    if (instance !== undefined) this.#extInstance = instance || undefined;
  }

  /** A scheduled run: nobody answers cards. Survives the session rebuilds a project/mode change causes. */
  #unattended: Parameters<Session["setUnattended"]>[0] = null;
  #budgetUsd: number | undefined;
  setUnattended(cfg: Parameters<Session["setUnattended"]>[0], budgetUsd?: number): void {
    this.#unattended = cfg; this.#budgetUsd = budgetUsd;
    this.#session.setUnattended(cfg);
    if (budgetUsd !== undefined && !this.#session.busy) this.#restart();
  }
  get unattended(): boolean { return this.#unattended !== null; }

  project(projects: Project[]): Project { return resolveProject(projects, this.#rec.project); }

  /* ---------------- events ---------------- */

  #record = (e: ClientEvent): void => {
    if (this.#closed) { this.#emitAll(e); return; }
    // Live-only: status and deltas are the same words the completed events
    // carry, so persisting them would duplicate every reply.
    if (e.kind === "rewind") this.#lastRewind = { uuid: e.uuid, ok: e.canRewind, files: e.files.length };
    if (e.kind === "status" || e.kind === "delta" || e.kind === "thinking_delta" || e.kind === "task_progress" || e.kind === "rewind") { this.#emitAll(e); return; }

    if (e.kind === "conversation_reset") {
      // The SDK emits this for /clear AND for fresh-session flows, and the
      // event cannot tell them apart. Honouring it unconditionally wiped a
      // transcript on every restart. Only a /clear the user sent may clear.
      if (!this.#clearRequested) {
        this.#rec.sdkSessionId = e.newId;
        this.#save();
        return;
      }
      this.#clearRequested = false;
      const snap = this.#snapshot("before-clear");
      // The session's ready/commands/models describe the process, not the
      // conversation, and do not arrive again after a clear: dropping them
      // left a reloaded chat with no slash-command menu. The note is saved,
      // not only shown, so a reloaded chat still says where its past went.
      const note: ClientEvent = { kind: "local", text: snap
        ? `Context cleared — the earlier conversation is saved in ${snap}`
        : "Context cleared — the earlier conversation could not be snapshotted." };
      this.#rec.events = [...this.#rec.events.filter((x) => SESSION_KINDS.has(x.kind)), note];
      this.#rec.title = "New chat";
      this.#rec.titleProvisional = false;
      this.#rec.sdkSessionId = e.newId;
      this.#save();
      this.#emitAll({ kind: "cleared" });
      this.#emitAll(note);
      this.#onChange();
      return;
    }

    if (e.kind === "ready") { this.#onReady(e); this.#inFlight = null; }
    if (e.kind === "models") this.#onModels(e);
    // Measured against CLI 2.1.280 with a made-up resume id: an error result
    // "No conversation found with session ID: <id>", then the stream throws
    // with the same words. Either one is enough.
    if ((e.kind === "turn_end" && GONE.test(e.stopped ?? "")) || (e.kind === "error" && GONE.test(e.message))) this.#resumeGone = true;
    if (SESSION_KINDS.has(e.kind)) {
      this.#rec.events = this.#rec.events.filter((x) => x.kind !== e.kind);
    }
    // A /clear turn that ends without a reset must not leave the flag armed:
    // the next unrequested reset — a fresh-session flow — would then wipe the
    // chat. Measured once on CLI 2.1.280: a real /clear emits its reset
    // before the turn's result, so this does not cancel a /clear that worked.
    if (e.kind === "turn_end") this.#clearRequested = false;
    this.#rec.events.push(e);
    if (this.#rec.events.length > MAX_EVENTS) {
      this.#rec.events.splice(0, this.#rec.events.length - MAX_EVENTS);
    }
    this.#emitAll(e);
    this.#scheduleSave();
  };

  #emitAll(e: ClientEvent): void { for (const emit of this.#live) emit(e); }

  /** Announce something to this chat's clients without persisting it. */
  announce(e: ClientEvent): void { this.#emitAll(e); }

  attach(emit: (e: ClientEvent) => void, replay = true): void {
    this.#live.add(emit);
    if (replay) for (const e of this.#rec.events) emit(e);
    emit({ kind: "replayed" });
    emit({ kind: "cwd", path: this.cwd });
    emit(this.#session.status());
  }

  detach(emit: (e: ClientEvent) => void): void { this.#live.delete(emit); }

  /* ---------------- input ---------------- */

  /**
   * Accept a prompt. The context (active tab) may take up to a few seconds to
   * arrive; the chat counts as busy for that whole time, so a second prompt in
   * the gap is refused rather than queued behind the first. A session whose
   * stream has ended is rebuilt first, resuming the same conversation.
   */
  async prompt(text: string, context: () => Promise<string | undefined>, images: { media_type: string; data: string; thumb: string }[] = []): Promise<void> {
    if (this.busy) throw new Error("Still working — press Stop first.");
    this.#sending = true;
    try {
      const ctx = await context();
      if (this.#session.dead) this.#restart();
      // The record keeps thumbnails only; the full images are for the model.
      const uuid = this.#send(text, ctx, images);
      this.recordUser(text, ctx, images.map((i) => ({ media_type: i.media_type, thumb: i.thumb })), uuid);
    } finally {
      this.#sending = false;
    }
  }

  recordUser(text: string, context?: string, images?: { media_type: string; thumb: string }[], uuid?: string): void {
    // Exactly /clear: \b also matched /clear-cache and any command named like it.
    if (/^\s*\/clear\s*$/.test(text)) this.#clearRequested = true;
    this.#record({ kind: "user", text, context, ...(images?.length ? { images } : {}), ...(uuid ? { uuid } : {}) });
    if (this.#rec.title === "New chat") {
      this.#rec.title = titleFrom(this.#rec.events);
      this.#rec.titleProvisional = true;
      this.#save();
      this.#onChange();
    }
    // Retried on later turns while still provisional: the titler can fail
    // (offline, rate-limited) and used to get exactly one attempt.
    if (this.#rec.titleProvisional) void this.#maybeTitle();
  }

  rename(title: string): boolean {
    if (!applyTitle(this.#rec, title)) return false;
    this.#save();
    this.#onChange();
    return true;
  }

  /** Called once, right after create(), by the schedule runner — never by a
      person renaming or moving a chat. Marks it as that schedule's, for the
      manage page's manual/scheduled split; nothing else reads it. */
  markScheduled(scheduleId: string): void {
    this.#rec.scheduleId = scheduleId;
    this.#save();
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.#session.setMode(mode);
    this.#mode = this.#session.mode;
  }

  get model(): string | null { return this.#rec.model ?? null; }
  /** Per chat and remembered: a resumed chat comes back on the model it was on. */
  async setModel(model: string): Promise<void> {
    await this.#session.setModel(model || undefined);
    if ((this.#session.model ?? undefined) !== this.#rec.model) {
      if (this.#session.model) this.#rec.model = this.#session.model; else delete this.#rec.model;
      this.#save();
    }
  }

  /** Point this chat at a directory. cwd is a launch option, so the session is rebuilt. */
  async setCwd(abs: string): Promise<void> {
    if (this.#session.busy) throw new Error("Finish or stop the current turn first.");
    if (abs === this.cwd) return;
    this.#rec.cwd = abs;
    this.#save();
    this.#restart();
    this.#record({ kind: "local", text: `Working directory is now ${abs}` });
  }

  async setProject(target: Project): Promise<void> {
    if (this.#session.busy) throw new Error("Finish or stop the current turn first.");
    this.#rec.project = target.general ? undefined : target.id;
    this.#rec.cwd = target.path;
    this.#save();
    this.#restart();
    this.#record({ kind: "local", text: `Project: ${target.name} — working in ${target.path}` });
    this.#emitAll({ kind: "project", id: target.id, name: target.name });
  }

  /** Rebuild the session in place, resuming the same conversation. */
  #restart(): void {
    // Flush first: the resume id arrives with `ready` and is saved on a
    // debounce, so a rebuild inside that window would otherwise start a
    // brand-new conversation instead of resuming this one.
    this.#save();
    this.#session.close();
    this.#session = this.#spawn(this.#deps, this.#mode);
    this.#emitAll({ kind: "cwd", path: this.cwd });
  }

  watchFired(description: string, detail: string, prompt: string): "woken" | "noted" {
    this.#emitAll({ kind: "watch", description, detail });
    this.#record({ kind: "local", text: `Watch fired — ${description}: ${detail}` });
    if (this.busy) return "noted";
    if (this.#session.dead) this.#restart();
    // The detail is page-derived; sending it as context puts it inside the
    // nonce-delimited untrusted block rather than inline in the instruction.
    this.#send(prompt, `watch report: ${detail}`);
    return "woken";
  }

  /** Rewind files to before a user message; a real rewind leaves a note in the transcript. */
  async rewind(uuid: string, dryRun: boolean): Promise<void> {
    if (this.busy) throw new Error("Finish or stop the current turn first.");
    if (this.#session.dead) throw new Error("The session has ended; send a message first, then rewind.");
    const target = this.#rec.events.find((e) => e.kind === "user" && (e as { uuid?: string }).uuid === uuid) as { text: string } | undefined;
    if (!target) throw new Error("That message is not in this chat.");
    await this.#session.rewindFiles(uuid, dryRun);
    // Measured against the real CLI: the dry run lists the files, the real
    // rewind answers canRewind with an empty list — so the note counts from
    // the preview that preceded it.
    if (dryRun && this.#lastRewind?.uuid === uuid) this.#previewed.set(uuid, this.#lastRewind.files);
    if (!dryRun && this.#lastRewind?.uuid === uuid && this.#lastRewind.ok) {
      const n = this.#lastRewind.files || this.#previewed.get(uuid) || 0;
      this.#record({ kind: "local", text: `Rewound ${n ? `${n} file${n === 1 ? "" : "s"}` : "files"} to before “${target.text.split("\n")[0].slice(0, 60)}”` });
    }
  }
  #lastRewind: { uuid: string; ok: boolean; files: number } | null = null;
  #previewed = new Map<string, number>();

  /** Make this the most recently used chat, so a fresh attach lands on it. */
  touch(): void {
    this.#save();          // stamps updatedAt = now
    this.#onChange();
  }

  close(): void {
    if (this.#saveTimer) { clearTimeout(this.#saveTimer); this.#saveTimer = null; }
    // A flush, not an update: stamping it made a chat pushed out of the pool
    // (or closed at shutdown) the "newest", so the page opened it instead of
    // the chat just made.
    this.#save(false);
    // Closed before the session is: its close emits into #record, and nothing
    // it says from here on may reach the disk (see #closed).
    this.#closed = true;
    this.#session.close();
  }

  /* ---------------- titling ---------------- */

  async #maybeTitle(): Promise<void> {
    if (!this.#rec.titleProvisional || this.#titling) return;
    const firstUser = this.#rec.events.find((e) => e.kind === "user") as { text: string } | undefined;
    if (!firstUser) return;

    this.#titling = true;
    let title: string | null = null;
    try { title = await (this.#deps.titler ?? generateTitle)(firstUser.text); } finally { this.#titling = false; }

    if (!title) {
      // Give up after a few turns rather than paying for a call on every one.
      if (this.#rec.events.filter((e) => e.kind === "user").length >= 3) {
        this.#rec.titleProvisional = false;
      }
      return;
    }
    this.#rec.title = title;
    this.#rec.titleProvisional = false;
    this.#save();
    this.#onChange();
  }

  /* ---------------- persistence ---------------- */

  /** The snapshot's path, or null when it could not be written. */
  #snapshot(why: string): string | null {
    try {
      const dir = join(dirname(this.#store.dir), "chats-snapshots");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${this.#rec.id}-${why}-${Date.now()}.json`);
      writeFileSync(path, JSON.stringify(this.#rec));
      return path;
    } catch { return null; /* a missing snapshot must not block the operation */ }
  }

  #scheduleSave(): void {
    if (this.#saveTimer || this.#closed) return;
    this.#saveTimer = setTimeout(() => { this.#saveTimer = null; this.#save(); }, 400);
  }

  #saveFailed = false;
  #save(touch = true): void {
    // Also reached from async paths (the titler, a rename) that can finish
    // after the chat was deleted; one write then would resurrect the file.
    if (this.#closed) return;
    this.#rec.sdkSessionId = this.#session?.sdkSessionId ?? this.#rec.sdkSessionId;
    this.#rec.granted = this.#session?.granted ?? this.#rec.granted;
    this.#rec.mode = this.#session?.mode ?? this.#rec.mode;
    if (touch) this.#rec.updatedAt = stamp();
    const ok = this.#store.write(this.#rec);
    // Say so once per outage — a full disk used to lose the transcript silently.
    if (!ok && !this.#saveFailed) {
      this.#emitAll({ kind: "error", message: "Could not save this chat to disk — recent messages will be lost on restart. Check free space." });
    }
    this.#saveFailed = !ok;
  }
}

/**
 * The pool. Holds up to MAX_LIVE conversations with running sessions, and the
 * store behind all of them. Clients pick which chat they are looking at, so two
 * browsers can hold two different conversations at once.
 */
export class Manager {
  #store: Store;
  #workspace: string;
  #projectsRoot: string;
  #deps: Omit<SessionDeps, "chatId">;
  #chats = new Map<string, LiveChat>();

  /** Told when any chat's title, project or list-visible state changes. */
  onListChanged?: () => void;
  /** True once any session has reported `ready` this run — the login works. */
  readySeen = false;
  /** From the most recent session start: each in-process MCP server and its status; null before any. */
  mcpServers: { name: string; status: string }[] | null = null;
  /**
   * The CLI's model list from the most recent session start. It is the same
   * for every chat, but it used to reach a client only as an event in the
   * chat's own history, so a chat whose history no longer held one (trimmed,
   * or never started this run) offered nothing but "default".
   */
  models: Extract<ClientEvent, { kind: "models" }> | null = null;
  onChatRemoved?: (id: string) => void;

  constructor(workspace: string, dir: string, projectsRoot: string,
              deps: Omit<SessionDeps, "chatId">) {
    this.#workspace = workspace;
    this.#store = new Store(dir);
    this.#projectsRoot = projectsRoot;
    this.#deps = deps;
  }

  list(): ChatSummary[] { return this.#store.list(); }

  #search: ChatSearch | null = null;
  /** Full-text search across chats; live chats are searched from memory. */
  search(query: string): ReturnType<ChatSearch["search"]> {
    this.#search ??= new ChatSearch(this.#store);
    return this.#search.search(query, { live: (id) => this.#chats.get(id)?.record });
  }
  read(id: string): ChatRecord | null {
    return this.#chats.get(id)?.record ?? this.#read(id);
  }

  /** The store throws on an id that is not a uuid; off the wire that is "no such chat". */
  #read(id: string): ChatRecord | null {
    try { return this.#store.read(id); } catch { return null; }
  }

  // listProjects is a sync readdir + one stat per entry (79 here), and it ran
  // on every attach and every /chats. A short memo keeps it off the hot path;
  // a new directory shows up within the TTL.
  #projectsMemo: { at: number; list: Project[] } | null = null;
  static readonly PROJECTS_TTL_MS = 5_000;

  projects(): Project[] {
    const now = Date.now();
    if (!this.#projectsMemo || now - this.#projectsMemo.at > Manager.PROJECTS_TTL_MS) {
      this.#projectsMemo = { at: now, list: listProjects(this.#projectsRoot, this.#workspace) };
    }
    const usage = new Map<string, { lastUsed: number; chats: number }>();
    for (const c of this.#store.list()) {
      const id = c.project ?? GENERAL_ID;
      const prev = usage.get(id);
      usage.set(id, {
        lastUsed: Math.max(prev?.lastUsed ?? 0, c.updatedAt ?? 0),
        chats: (prev?.chats ?? 0) + 1,
      });
    }
    return orderByRecency(this.#projectsMemo.list, usage);
  }

  /** The chat a client with no preference should land on. */
  newestId(): string | null { return this.#store.list()[0]?.id ?? null; }

  /** Live chats, so a watch can find the conversation that set it. */
  live(id: string): LiveChat | undefined { return this.#chats.get(id); }

  /** Bring a chat into the pool, evicting an idle one if it is full. */
  get(id: string): LiveChat | null {
    const existing = this.#chats.get(id);
    if (existing) return existing;
    const rec = this.#read(id);
    if (!rec) return null;
    return this.#admit(rec);
  }

  /**
   * Edit a chat's record without waking it. get() admits the chat into the
   * pool, and admitting spawns the SDK session — measured: a rename from the
   * manage page started a Claude subprocess per row. A live chat is edited in
   * place; anything else is edited on disk.
   */
  rename(id: string, title: string): boolean {
    const live = this.#chats.get(id);
    if (live) return live.rename(title);
    const rec = this.#read(id);
    if (!rec || !applyTitle(rec, title)) return false;
    this.#store.write(rec);
    this.onListChanged?.();
    return true;
  }

  /** Make a chat the most recently used one (a fresh attach lands on it). */
  touch(id: string): boolean {
    const live = this.#chats.get(id);
    if (live) { live.touch(); return true; }
    const rec = this.#read(id);
    if (!rec) return false;
    rec.updatedAt = stamp();
    this.#store.write(rec);
    this.onListChanged?.();
    return true;
  }

  /** Point a chat at a project. Live: the session restarts there; on disk: it launches there next time. */
  async setProject(id: string, target: Project): Promise<boolean> {
    const live = this.#chats.get(id);
    if (live) { await live.setProject(target); return true; }
    const rec = this.#read(id);
    if (!rec) return false;
    rec.project = target.general ? undefined : target.id;
    rec.cwd = target.path;
    rec.updatedAt = stamp();
    this.#store.write(rec);
    this.onListChanged?.();
    return true;
  }

  create(from?: LiveChat): LiveChat {
    const now = stamp();
    // "New" while already on an unused chat is the same chat.
    if (from && from.record.events.every((e) => e.kind !== "user")) return from;
    // Every "new" click wrote a "New chat" record before a word was said
    // (measured: one 0-turn file per attach to an empty store), and the
    // abandoned ones piled up in the picker. Reuse one instead of minting
    // another, so there is at most one empty chat on disk at a time.
    //
    // "0 turns, titled New chat" is not the same as unused: a /clear leaves
    // exactly that, and so does a watch that fired into a cleared chat. Both
    // were taken — their events deleted with no snapshot, the old scheduleId
    // kept. The summary cannot tell, so the record is read to check — one
    // candidate at a time, stopping at the first that is really unused.
    let spareRec: ChatRecord | null = null;
    for (const c of this.#store.list()) {
      if (c.turns !== 0 || c.title !== "New chat" || c.scheduleId || this.#chats.has(c.id)) continue;
      const r = this.#read(c.id);
      if (r && unused(r)) { spareRec = r; break; }
    }
    if (spareRec) {
      // Built afresh, only the id carried over: spreading the old record kept
      // whatever else it had (a scheduleId, a stale titleProvisional).
      const rec: ChatRecord = {
        id: spareRec.id, title: "New chat", createdAt: now, updatedAt: now,
        sdkSessionId: null, cwd: from?.record.cwd ?? null, project: from?.record.project,
        ...(from?.record.model ? { model: from.record.model } : {}),
        events: [], granted: [], mode: "default",
      };
      this.#store.write(rec);
      const chat = this.#admit(rec, from?.mode ?? "default");
      this.onListChanged?.();
      return chat;
    }
    // A new chat inherits where you were working and how gated you were, which
    // is almost always what you want when you start one mid-task.
    const rec: ChatRecord = {
      id: randomUUID(), title: "New chat", createdAt: now, updatedAt: now,
      sdkSessionId: null, cwd: from?.record.cwd ?? null, project: from?.record.project,
      ...(from?.record.model ? { model: from.record.model } : {}),
      events: [], granted: [], mode: "default",
    };
    this.#store.write(rec);
    const chat = this.#admit(rec, from?.mode ?? "default");
    this.onListChanged?.();
    return chat;
  }

  /**
   * Mode is per chat. A chat admitted from disk always starts in "default" —
   * that is what keeps the promise that a restart never leaves "Never ask"
   * armed. A chat created from another one inherits that one's mode.
   */
  #admit(rec: ChatRecord, mode: PermissionMode = "default"): LiveChat {
    this.#evictIfFull();
    const chat = new LiveChat(rec, this.#store, this.#workspace, this.#deps, mode,
      () => this.onListChanged?.(), (ready) => { this.readySeen = true; this.mcpServers = ready.servers?.filter((s) => OUR_SERVERS.has(s.name)) ?? null; },
      (models) => { this.models = models; });
    this.#chats.set(rec.id, chat);
    return chat;
  }

  /**
   * Evict the least recently touched chat that nobody is watching. A chat with
   * clients attached is never evicted, however old — someone is looking at it.
   */
  #evictIfFull(): void {
    while (this.#chats.size >= MAX_LIVE) {
      const idle = [...this.#chats.values()]
        .filter((c) => c.clients === 0 && !c.busy)
        .sort((a, b) => a.lastTouched - b.lastTouched)[0];
      if (!idle) return;   // everything is in use; go over the cap rather than cut someone off
      idle.close();
      this.#chats.delete(idle.id);
    }
  }

  /** Drop a chat entirely. */
  remove(id: string): void {
    const live = this.#chats.get(id);
    if (live) { live.close(); this.#chats.delete(id); }
    try { this.#store.remove(id); } catch { return; }   // not a uuid: nothing to remove
    this.#search?.forget(id);
    this.onChatRemoved?.(id);
    this.onListChanged?.();
  }

  /** Close everything cleanly: every live chat is saved, then its session ended. */
  shutdown(): void {
    for (const c of this.#chats.values()) c.close();
    this.#chats.clear();
  }
}

/** Never used: nothing in it but what a session says about itself, and no schedule owns it. */
function unused(rec: ChatRecord): boolean {
  return !rec.scheduleId && rec.events.every((e) => SESSION_KINDS.has(e.kind));
}

/** Title rule shared by live and on-disk renames. */
function applyTitle(rec: ChatRecord, title: string): boolean {
  const t = title.trim().slice(0, 64);
  if (!t) return false;
  rec.title = t;
  rec.titleProvisional = false;
  return true;
}
