import { randomUUID } from "node:crypto";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { Session, type ClientEvent } from "./session.js";
import { Store, titleFrom, type ChatRecord, type ChatSummary } from "./store.js";

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

  /**
   * Permission mode is app-level, not per-chat: you set it once and it holds
   * across new chats and chat switches. It starts at "default" on every boot,
   * so a process manager restarting the server can never re-arm "Never ask" —
   * that was the only case the old per-chat downgrade was actually guarding.
   */
  #mode: PermissionMode = "default";

  constructor(workspace: string, dir: string) {
    this.#workspace = workspace;
    this.#store = new Store(dir);
  }

  get session() { return this.#session; }
  get activeId() { return this.#rec.id; }

  list(): ChatSummary[] { return this.#store.list(); }

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
             sdkSessionId: null, events: [], granted: [], mode: "default" };
  }

  #record = (e: ClientEvent): void => {
    // "ready" and "commands" are state, not history — keep only the newest.
    if (e.kind === "status") { this.#emitAll(e); return; }   // live-only, never persisted
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

  recordUser(text: string, context?: string): void {
    this.#record({ kind: "user", text, context });
    if (this.#rec.title === "New chat") {
      this.#rec.title = titleFrom(this.#rec.events);
      this.#save();
      this.#emitAll({ kind: "chats", chats: this.list(), activeId: this.#rec.id });
    }
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
    this.#session = new Session(this.#workspace, this.#record);

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
