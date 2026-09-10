import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Session, type ClientEvent, type SessionDeps } from "./session.js";
import { Store, titleFrom, type ChatRecord, type ChatSummary } from "./store.js";
import { generateTitle } from "./titles.js";
import { listProjects, resolveProject, orderByRecency, GENERAL_ID, type Project } from "./projects.js";

const MAX_EVENTS = 3000;

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
  #onChange: () => void;

  constructor(rec: ChatRecord, store: Store, workspace: string,
              deps: Omit<SessionDeps, "chatId">, mode: PermissionMode, onChange: () => void) {
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
      { ...deps, chatId: this.#rec.id, prefer: () => this.#extInstance });
    if (mode !== "default") void s.setMode(mode);
    s.start(this.#rec.sdkSessionId ?? undefined, this.#rec.granted)
      .catch((err) => this.#record({ kind: "error", message: String(err) }));
    return s;
  }

  get id(): string { return this.#rec.id; }
  get record(): ChatRecord { return this.#rec; }
  get session(): Session { return this.#session; }
  get clients(): number { return this.#live.size; }
  get busy(): boolean { return this.#session.busy; }
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
  useBrowser(instance: string | undefined): void {
    if (instance) this.#extInstance = instance;
  }

  project(projects: Project[]): Project { return resolveProject(projects, this.#rec.project); }

  /* ---------------- events ---------------- */

  #record = (e: ClientEvent): void => {
    // Live-only: status and deltas are the same words the completed events
    // carry, so persisting them would duplicate every reply.
    if (e.kind === "status" || e.kind === "delta") { this.#emitAll(e); return; }

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
      this.#snapshot("before-clear");
      this.#rec.events = [];
      this.#rec.title = "New chat";
      this.#rec.titleProvisional = false;
      this.#rec.sdkSessionId = e.newId;
      this.#save();
      this.#emitAll({ kind: "cleared" });
      this.#emitAll({ kind: "local", text: "Context cleared." });
      this.#onChange();
      return;
    }

    if (e.kind === "ready" || e.kind === "commands") {
      this.#rec.events = this.#rec.events.filter((x) => x.kind !== e.kind);
    }
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

  recordUser(text: string, context?: string): void {
    if (/^\s*\/clear\b/.test(text)) this.#clearRequested = true;
    this.#record({ kind: "user", text, context });
    if (this.#rec.title === "New chat") {
      this.#rec.title = titleFrom(this.#rec.events);
      this.#rec.titleProvisional = true;
      this.#save();
      this.#onChange();
      void this.#maybeTitle();
    }
  }

  rename(title: string): boolean {
    const t = title.trim().slice(0, 64);
    if (!t) return false;
    this.#rec.title = t;
    this.#rec.titleProvisional = false;
    this.#save();
    this.#onChange();
    return true;
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.#session.setMode(mode);
    this.#mode = this.#session.mode;
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
    this.#session.close();
    this.#session = this.#spawn(this.#deps, this.#mode);
    this.#emitAll({ kind: "cwd", path: this.cwd });
  }

  watchFired(description: string, detail: string, prompt: string): "woken" | "noted" {
    this.#emitAll({ kind: "watch", description, detail });
    this.#record({ kind: "local", text: `Watch fired — ${description}: ${detail}` });
    if (this.#session.busy) return "noted";
    this.#session.send(prompt);
    return "woken";
  }

  close(): void {
    this.#save();
    this.#session.close();
  }

  /* ---------------- titling ---------------- */

  async #maybeTitle(): Promise<void> {
    if (!this.#rec.titleProvisional || this.#titling) return;
    const firstUser = this.#rec.events.find((e) => e.kind === "user") as { text: string } | undefined;
    if (!firstUser) return;

    this.#titling = true;
    let title: string | null = null;
    try { title = await generateTitle(firstUser.text); } finally { this.#titling = false; }

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

  #snapshot(why: string): void {
    try {
      const dir = join(dirname(this.#store.dir), "chats-snapshots");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${this.#rec.id}-${why}-${Date.now()}.json`), JSON.stringify(this.#rec));
    } catch { /* a missing snapshot must not block the operation */ }
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => { this.#saveTimer = null; this.#save(); }, 400);
  }

  #save(): void {
    this.#rec.sdkSessionId = this.#session?.sdkSessionId ?? this.#rec.sdkSessionId;
    this.#rec.granted = this.#session?.granted ?? this.#rec.granted;
    this.#rec.mode = this.#session?.mode ?? this.#rec.mode;
    this.#rec.updatedAt = Date.now();
    this.#store.write(this.#rec);
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
  #mode: PermissionMode = "default";

  /** Told when any chat's title, project or list-visible state changes. */
  onListChanged?: () => void;
  onChatRemoved?: (id: string) => void;

  constructor(workspace: string, dir: string, projectsRoot: string,
              deps: Omit<SessionDeps, "chatId">) {
    this.#workspace = workspace;
    this.#store = new Store(dir);
    this.#projectsRoot = projectsRoot;
    this.#deps = deps;
  }

  get mode(): PermissionMode { return this.#mode; }

  list(): ChatSummary[] { return this.#store.list(); }
  read(id: string): ChatRecord | null {
    return this.#chats.get(id)?.record ?? this.#store.read(id);
  }

  projects(): Project[] {
    const usage = new Map<string, { lastUsed: number; chats: number }>();
    for (const c of this.#store.list()) {
      const id = c.project ?? GENERAL_ID;
      const prev = usage.get(id);
      usage.set(id, {
        lastUsed: Math.max(prev?.lastUsed ?? 0, c.updatedAt ?? 0),
        chats: (prev?.chats ?? 0) + 1,
      });
    }
    return orderByRecency(listProjects(this.#projectsRoot, this.#workspace), usage);
  }

  /** The chat a client with no preference should land on. */
  newestId(): string | null { return this.#store.list()[0]?.id ?? null; }

  /** Live chats, so a watch can find the conversation that set it. */
  live(id: string): LiveChat | undefined { return this.#chats.get(id); }

  /** Bring a chat into the pool, evicting an idle one if it is full. */
  get(id: string): LiveChat | null {
    const existing = this.#chats.get(id);
    if (existing) return existing;
    const rec = this.#store.read(id);
    if (!rec) return null;
    return this.#admit(rec);
  }

  create(from?: LiveChat): LiveChat {
    const now = Date.now();
    // A new chat inherits where you were working, which is almost always what
    // you want when you start one mid-task.
    const rec: ChatRecord = {
      id: randomUUID(), title: "New chat", createdAt: now, updatedAt: now,
      sdkSessionId: null, cwd: from?.record.cwd ?? null, project: from?.record.project,
      events: [], granted: [], mode: "default",
    };
    this.#store.write(rec);
    const chat = this.#admit(rec);
    this.onListChanged?.();
    return chat;
  }

  #admit(rec: ChatRecord): LiveChat {
    this.#evictIfFull();
    const chat = new LiveChat(rec, this.#store, this.#workspace, this.#deps, this.#mode,
      () => this.onListChanged?.());
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
    this.#store.remove(id);
    this.onChatRemoved?.(id);
    this.onListChanged?.();
  }

  /** Mode is app-level: set once, applies to every conversation. */
  async setMode(mode: PermissionMode): Promise<void> {
    this.#mode = mode;
    await Promise.all([...this.#chats.values()].map((c) => c.setMode(mode).catch(() => {})));
    this.#mode = [...this.#chats.values()][0]?.mode ?? mode;
  }

  /** Close everything cleanly. */
  shutdown(): void { for (const c of this.#chats.values()) c.close(); }
}
