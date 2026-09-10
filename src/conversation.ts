import { randomUUID } from "node:crypto";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Session, type ClientEvent } from "./session.js";
import { Store, titleFrom, type ChatRecord, type ChatSummary } from "./store.js";
import { generateTitle } from "./titles.js";
import { listProjects, resolveProject, GENERAL_ID, type Project } from "./projects.js";

const MAX_EVENTS = 3000;

/**
 * Holds the one live Session and swaps it when you open another chat. Only the
 * active chat has a running SDK session — each one is a claude process, so
 * keeping every past chat warm would be expensive. Opening an old chat resumes
 * it by its sdkSessionId, which rebuilds the model's context from the
 * transcript on disk.
 */
export class Manager {
  #store: Store;
  #workspace: string;
  #session!: Session;
  #rec!: ChatRecord;
  /** Every attached browser. A Set, not one slot: a second tab must not
   *  silently starve the first of events. */
  #live = new Set<(e: ClientEvent) => void>();
  #saveTimer: NodeJS.Timeout | null = null;
  #titling = false;

  /**
   * Permission mode is app-level, not per-chat: you set it once and it holds
   * across new chats and chat switches. It starts at "default" on every boot,
   * so a process manager restarting the server can never re-arm "Never ask" —
   * that was the only case the old per-chat downgrade was actually guarding.
   */
  #mode: PermissionMode = "default";

  #projectsRoot: string;

  constructor(workspace: string, dir: string, projectsRoot: string) {
    this.#workspace = workspace;
    this.#store = new Store(dir);
    this.#projectsRoot = projectsRoot;
  }

  /** Discovered fresh each time: a new checkout should just appear. */
  projects(): Project[] { return listProjects(this.#projectsRoot, this.#workspace); }

  get project(): Project { return resolveProject(this.projects(), this.#rec?.project); }

  /**
   * Move this chat to a project. The project's directory becomes the working
   * directory, so "which project" and "where does it work" cannot drift apart.
   */
  async setProject(id: string): Promise<void> {
    if (this.#session.busy) throw new Error("Finish or stop the current turn first.");
    const target = resolveProject(this.projects(), id);
    if (target.id === this.project.id) return;
    this.#rec.project = target.general ? undefined : target.id;
    this.#rec.cwd = target.path;
    this.#save();
    await this.#activate(this.#rec);
    this.#record({ kind: "local", text: `Project: ${target.name} — working in ${target.path}` });
  }

  get session() { return this.#session; }
  get activeId() { return this.#rec.id; }
  /** Where the active chat works — the shell pane opens here too. */
  get cwd() { return this.#rec?.cwd ?? this.#workspace; }

  /**
   * Point this chat at a different directory. The SDK takes cwd only at
   * launch, so the session is rebuilt and resumed by its sdkSessionId — the
   * conversation survives, the working directory changes under it.
   */
  async setCwd(abs: string): Promise<void> {
    if (this.#session.busy) throw new Error("Finish or stop the current turn first.");
    if (abs === this.cwd) return;
    this.#rec.cwd = abs;
    this.#save();
    await this.#activate(this.#rec);
    this.#record({ kind: "local", text: `Working directory is now ${abs}` });
  }

  list(): ChatSummary[] { return this.#store.list(); }

  /** Set by the server so watches belonging to a deleted chat go with it. */
  onChatRemoved?: (id: string) => void;

  /** Change the mode for the whole app, not just this chat. */
  async setMode(mode: PermissionMode): Promise<void> {
    await this.#session.setMode(mode);
    // Adopt only what the session actually accepted (bypass can be refused).
    this.#mode = this.#session.mode;
  }

  async boot(): Promise<void> {
    const newest = this.#store.list()[0];
    const prior = newest ? this.#store.read(newest.id) : null;
    await this.#activate(prior ?? this.#blank());
  }

  #blank(): ChatRecord {
    const now = Date.now();
    return { id: randomUUID(), title: "New chat", createdAt: now, updatedAt: now,
             // A new chat inherits where you are working, which is nearly
             // always what you want when you start one mid-task.
             sdkSessionId: null, cwd: this.#rec?.cwd ?? null, project: this.#rec?.project,
             events: [], granted: [], mode: "default" };
  }

  #record = (e: ClientEvent): void => {
    // "ready" and "commands" are state, not history — keep only the newest.
    // Live-only: deltas are the same text the completed "text" event carries,
    // so persisting both would duplicate every reply in the transcript.
    if (e.kind === "status" || e.kind === "delta") { this.#emitAll(e); return; }

    // The model's context is gone, so the transcript must go with it —
    // otherwise the user reads a history the model cannot remember, which is
    // worse than showing nothing.
    if (e.kind === "conversation_reset") {
      this.#rec.events = [];
      this.#rec.title = "New chat";
      this.#rec.sdkSessionId = e.newId;
      this.#save();
      this.#emitAll({ kind: "cleared" });
      this.#emitAll({ kind: "local", text: "Context cleared." });
      this.#emitAll({ kind: "chats", chats: this.list(), activeId: this.#rec.id });
      this.#emitAll(this.#session.status());
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

  #emitAll(e: ClientEvent): void {
    for (const emit of this.#live) emit(e);
  }

  /**
   * A page watch fired. Only nudges the model when the owning chat is the one
   * running — waking a background chat would silently start a turn in a
   * conversation the user is not looking at.
   */
  watchFired(chatId: string, description: string, detail: string, prompt: string): "woken" | "noted" {
    // Announce to every attached client regardless of which chat owns it —
    // the point of a watch is that you are not looking at this window.
    this.#emitAll({ kind: "watch", description, detail });
    if (chatId !== this.#rec.id) return "noted";
    this.#record({ kind: "local", text: `Watch fired — ${description}: ${detail}` });
    if (this.#session.busy) return "noted";   // do not interrupt a turn in flight
    this.#session.send(prompt);
    return "woken";
  }

  recordUser(text: string, context?: string): void {
    this.#record({ kind: "user", text, context });
    // Provisional: the opening line is rarely what a conversation turns out to
    // be about. Replaced by a real title once there is a reply to name it from.
    if (this.#rec.title === "New chat") {
      this.#rec.title = titleFrom(this.#rec.events);
      this.#rec.titleProvisional = true;
      this.#save();
      this.#emitAll({ kind: "chats", chats: this.list(), activeId: this.#rec.id });
      // Name it from the question straight away — no reply needed, so a turn
      // parked on an approval still ends up with a real title.
      void this.#maybeTitle();
    }
  }

  /** Rename by hand. Sticks — auto-titling never overwrites it. */
  rename(id: string, title: string): boolean {
    const t = title.trim().slice(0, 64);
    if (!t) return false;
    if (id === this.#rec.id) {
      this.#rec.title = t;
      this.#rec.titleProvisional = false;
      this.#save();
    } else {
      const rec = this.#store.read(id);
      if (!rec) return false;
      rec.title = t;
      rec.titleProvisional = false;
      this.#store.write(rec);
    }
    this.#emitAll({ kind: "chats", chats: this.list(), activeId: this.#rec.id });
    return true;
  }

  /**
   * After the first exchange, name the chat properly. One Haiku call, once per
   * chat, and never over a title the user set themselves.
   */
  async #maybeTitle(): Promise<void> {
    if (!this.#rec.titleProvisional) return;
    const events = this.#rec.events;
    const firstUser = events.find((e) => e.kind === "user") as { text: string } | undefined;
    if (!firstUser) return;

    // An in-flight guard rather than clearing the flag: clearing it first meant
    // a failed naming call left the chat stuck with its opening line forever.
    if (this.#titling) return;
    this.#titling = true;
    const id = this.#rec.id;
    let title: string | null = null;
    try {
      title = await generateTitle(firstUser.text);
    } finally {
      this.#titling = false;
    }
    // Give up after a few turns rather than paying for a naming call on every
    // turn of a chat that will not name.
    if (!title) {
      if (events.filter((e) => e.kind === "user").length >= 3) this.#rec.titleProvisional = false;
      return;
    }

    // The user may have switched chats while that call was in flight.
    if (this.#rec.id === id) {
      this.#rec.title = title;
      this.#rec.titleProvisional = false;
      this.#save();
    } else {
      const rec = this.#store.read(id);
      if (rec && rec.titleProvisional !== false) { rec.title = title; rec.titleProvisional = false; this.#store.write(rec); }
    }
    this.#emitAll({ kind: "chats", chats: this.list(), activeId: this.#rec.id });
  }

  /**
   * `replay: false` is for observers that only want live events — the
   * extension's service worker watching for something worth a notification.
   * Replaying the whole transcript at it would be pure waste.
   */
  attach(emit: (e: ClientEvent) => void, replay = true): void {
    this.#live.add(emit);
    if (replay) {
      for (const e of this.#rec.events) emit(e);
      emit({ kind: "chats", chats: this.list(), activeId: this.#rec.id });
    }
    emit({ kind: "replayed" });
    emit({ kind: "cwd", path: this.cwd });
    emit(this.#session.status());   // so a reload mid-turn knows it is busy
  }

  detach(emit: (e: ClientEvent) => void): void { this.#live.delete(emit); }

  /** Start a fresh chat, keeping the current one on disk. */
  async create(): Promise<void> {
    this.#save();
    await this.#activate(this.#blank());
  }

  async open(id: string): Promise<void> {
    if (id === this.#rec.id) return;
    const rec = this.#store.read(id);
    if (!rec) return;
    this.#save();
    await this.#activate(rec);
  }

  async remove(id: string): Promise<void> {
    this.#store.remove(id);
    this.onChatRemoved?.(id);
    if (id === this.#rec.id) {
      const next = this.#store.list()[0];
      await this.#activate((next && this.#store.read(next.id)) || this.#blank());
    } else {
      this.#emitAll({ kind: "chats", chats: this.list(), activeId: this.#rec.id });
    }
  }

  async #activate(rec: ChatRecord): Promise<void> {
    this.#session?.close();
    this.#rec = rec;
    this.#session = new Session(rec.cwd ?? this.#workspace, this.#record);

    if (this.#mode !== "default") void this.#session.setMode(this.#mode);

    this.#session
      .start(rec.sdkSessionId ?? undefined, rec.granted)
      .catch((err) => this.#record({ kind: "error", message: String(err) }));

    // Save first, so the chat we just activated appears in its own list.
    this.#save();
    this.#emitAll({ kind: "cleared" });
    for (const e of rec.events) this.#emitAll(e);
    this.#emitAll({ kind: "replayed" });
    this.#emitAll({ kind: "chats", chats: this.list(), activeId: rec.id });
    // Always state the mode. Letting the UI keep a stale value is how you end
    // up believing "Never ask" is on while the session is asking.
    this.#emitAll({ kind: "mode", mode: this.#mode });
    // system/init only arrives with the next turn, so the header would show a
    // stale directory until then. Say it now.
    this.#emitAll({ kind: "cwd", path: this.cwd });
    this.#emitAll({ kind: "project", id: this.project.id, name: this.project.name });
    this.#emitAll(this.#session.status());
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => { this.#saveTimer = null; this.#save(); }, 400);
  }

  #save(): void {
    if (!this.#rec) return;
    this.#rec.sdkSessionId = this.#session.sdkSessionId;
    this.#rec.granted = this.#session.granted;
    this.#rec.mode = this.#session.mode;
    this.#rec.updatedAt = Date.now();
    this.#store.write(this.#rec);
  }
}
