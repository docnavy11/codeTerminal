import { writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import type { PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { Session, type ClientEvent } from "./session.js";

const MAX_EVENTS = 3000;

type Persisted = {
  sdkSessionId: string | null;
  events: ClientEvent[];
  granted: PermissionUpdate[];
  mode: PermissionMode;
};

/**
 * Owns the Session and outlives any browser tab. Events are buffered so a
 * reload replays the whole conversation, and an approval that was open when
 * you reloaded is still open when you come back — the SDK is genuinely still
 * awaiting it.
 */
export class Conversation {
  #session: Session;
  #events: ClientEvent[] = [];
  #live: ((e: ClientEvent) => void) | null = null;
  #statePath: string;
  #workspace: string;
  #saveTimer: NodeJS.Timeout | null = null;

  constructor(workspace: string, statePath: string) {
    this.#workspace = workspace;
    this.#statePath = statePath;
    this.#session = new Session(workspace, this.#record);
  }

  get session() { return this.#session; }

  /** Buffer every event, and forward it if a browser is attached. */
  #record = (e: ClientEvent): void => {
    // "ready" fires again on resume; keep only the newest.
    if (e.kind === "ready") this.#events = this.#events.filter((x) => x.kind !== "ready");
    this.#events.push(e);
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS);
    this.#live?.(e);
    this.#scheduleSave();
  };

  /** Record a user's own message so it survives reload too. */
  recordUser(text: string): void {
    this.#record({ kind: "user", text });
  }

  async boot(): Promise<void> {
    const prior = this.#load();
    if (prior) {
      this.#events = prior.events;
      if (prior.mode !== "default") void this.#session.setMode(prior.mode);
    }
    // Resuming rebuilds the model's context from the transcript on disk.
    this.#session
      .start(prior?.sdkSessionId ?? undefined, prior?.granted ?? [])
      .catch((err) => this.#record({ kind: "error", message: String(err) }));
  }

  attach(emit: (e: ClientEvent) => void): void {
    this.#live = emit;
    for (const e of this.#events) emit(e); // replay
  }

  detach(): void { this.#live = null; }

  /** Throw the conversation away and start clean. */
  async reset(): Promise<void> {
    this.#session.close();
    this.#events = [];
    this.#session = new Session(this.#workspace, this.#record);
    this.#save();
    this.#session.start().catch((err) => this.#record({ kind: "error", message: String(err) }));
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => { this.#saveTimer = null; this.#save(); }, 400);
  }

  #save(): void {
    const data: Persisted = {
      sdkSessionId: this.#session.sdkSessionId,
      events: this.#events,
      granted: this.#session.granted,
      mode: this.#session.mode,
    };
    try {
      // Write-then-rename so a crash mid-write can't leave a truncated file.
      const tmp = `${this.#statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.#statePath);
    } catch { /* losing history is not worth crashing over */ }
  }

  #load(): Persisted | null {
    if (!existsSync(this.#statePath)) return null;
    try {
      const d = JSON.parse(readFileSync(this.#statePath, "utf8")) as Persisted;
      return Array.isArray(d.events) ? d : null;
    } catch {
      return null;
    }
  }
}
