/**
 * Project todos: a short queue per project, in both directions. Items the
 * owner leaves for the sessions working there, and questions or todos a
 * session leaves for the owner. Design: docs/design-todos.md.
 *
 * One file per project root, `todo.json`, and this process is its only
 * writer — the same rule Store keeps for chats/. Every write re-reads the
 * file first (a checkout can change it underneath) and lands atomically, so
 * a claim is a compare-and-set that cannot be taken twice. The file is for
 * this box: gitignored globally, never committed.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { quarantine } from "./store.js";

export const TODO_FILE = "todo.json";
export type TodoFor = "claude" | "owner";
export type TodoStatus = "queued" | "claimed" | "done" | "dropped";

export type TodoItem = {
  id: string;
  text: string;
  /** Who it is for: the sessions in this project, or the owner. */
  for: TodoFor;
  status: TodoStatus;
  addedAt: number;
  /** "owner", "chat:<id>", "tmux:<name>", or "mcp". */
  addedBy: string;
  claimedBy?: string;
  claimedAt?: number;
  doneAt?: number;
  /** One line: what was done, or the owner's answer. */
  result?: string;
  /** More than one line: context for whoever takes it. */
  notes?: string;
  /** Absolute paths of attached images (a session can Read them). */
  images?: string[];
  /** Ids of items that must be done (or dropped) first; a blocked item cannot be claimed or assigned. */
  blockedBy?: string[];
};

export const MAX_NOTES = 8000;
export const MAX_IMAGES = 6;
export const ARCHIVE_FILE = "todo-archive.jsonl";

/** The open items still standing in front of this one. */
export function blockersOf(items: TodoItem[], item: TodoItem): TodoItem[] {
  if (!item.blockedBy?.length) return [];
  return items.filter((i) => item.blockedBy!.includes(i.id) && i.status !== "done" && i.status !== "dropped");
}

export type TodoFile = { items: TodoItem[] };

/** Done and dropped items older than this leave the file on the next write. */
export const PRUNE_AFTER_MS = 14 * 24 * 60 * 60_000;
/** And at most this many finished items are kept, however recent. */
export const KEEP_FINISHED = 30;
export const MAX_TEXT = 2000;
export const MAX_RESULT = 500;

/**
 * The directory a cwd's todos belong to: the nearest enclosing git root, so
 * a chat working in a subdirectory shares the queue with the repo. Bounded
 * by the projects root — never above it — and when the cwd is in no repo,
 * the project directory (the first level under the projects root), or the
 * cwd itself outside the projects root altogether.
 */
export function projectRootOf(cwd: string, projectsRoot: string): string {
  const abs = resolve(cwd), root = resolve(projectsRoot);
  const inside = abs === root || abs.startsWith(root + sep);
  let dir = abs;
  while (true) {
    if (inside && dir === root) break;
    if (isGitRoot(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (inside && abs !== root) {
    const first = abs.slice(root.length + 1).split(sep)[0];
    return join(root, first);
  }
  return abs;
}

function isGitRoot(dir: string): boolean {
  try { return existsSync(join(dir, ".git")); } catch { return false; }
}

export type TodoStoreOpts = { warn?: (line: string) => void; now?: () => number };

export class TodoStore {
  #warn: (line: string) => void;
  #now: () => number;
  /** Told after every successful write, with the root that changed. */
  onChange?: (root: string, item: TodoItem, what: "added" | "changed") => void;

  constructor(opts: TodoStoreOpts = {}) {
    this.#warn = opts.warn ?? (() => {});
    this.#now = opts.now ?? Date.now;
  }

  path(root: string): string { return join(resolve(root), TODO_FILE); }

  /** The items as they are on disk, or none. A file that does not parse is moved aside, not fought with. */
  read(root: string): TodoItem[] {
    const p = this.path(root);
    if (!existsSync(p)) return [];
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<TodoFile>;
      return Array.isArray(raw.items) ? raw.items.filter(valid) : [];
    } catch (e) {
      this.#warn(`[todos] ${p} does not parse (${e instanceof Error ? e.message : String(e)}); ${quarantine(p, this.#warn)}`);
      return [];
    }
  }

  /** Has a todo file at all — a project with none is not on the board for its queue. */
  has(root: string): boolean { return existsSync(this.path(root)); }

  /** Open items: queued and claimed, in order. */
  open(root: string): TodoItem[] { return this.read(root).filter((i) => i.status === "queued" || i.status === "claimed"); }

  add(root: string, input: { text: string; for?: TodoFor; addedBy?: string; notes?: string; images?: string[]; blockedBy?: string[] }): TodoItem {
    const text = (input.text ?? "").trim().slice(0, MAX_TEXT);
    if (!text) throw new Error("a todo needs text");
    const notes = (input.notes ?? "").trim().slice(0, MAX_NOTES);
    const images = (input.images ?? []).filter((x) => typeof x === "string" && x).slice(0, MAX_IMAGES);
    const known = new Set(this.read(root).map((i) => i.id));
    const blockedBy = (input.blockedBy ?? []).filter((x) => known.has(x));
    const item: TodoItem = {
      id: randomUUID(), text, for: input.for === "owner" ? "owner" : "claude",
      status: "queued", addedAt: this.#now(), addedBy: (input.addedBy ?? "owner").slice(0, 80),
      ...(notes ? { notes } : {}), ...(images.length ? { images } : {}), ...(blockedBy.length ? { blockedBy } : {}),
    };
    this.#write(root, (items) => {
      // Owner items go to the top (newest first); work for the sessions queues at the end.
      return item.for === "owner" ? [item, ...items] : [...items, item];
    });
    this.onChange?.(root, item, "added");
    return item;
  }

  /** Notes, images and blockers on an item. A blocker must exist in this project, and not be the item itself or lead back to it. */
  annotate(root: string, id: string, patch: { notes?: string; images?: string[]; blockedBy?: string[] }): TodoItem {
    const items = this.read(root);
    const me = items.find((i) => i.id === id || (id.length >= 8 && i.id.startsWith(id)));
    if (!me) throw new Error(`no todo ${id} in ${basename(root)}`);
    let blockedBy: string[] | undefined;
    if (patch.blockedBy) {
      blockedBy = [...new Set(patch.blockedBy.map((b) => items.find((i) => i.id === b || (b.length >= 8 && i.id.startsWith(b)))?.id).filter((x): x is string => !!x))];
      if (blockedBy.includes(me.id)) throw new Error("an item cannot wait on itself");
      // No cycles: nothing may (through its own blockers) wait on this item.
      const seen = new Set<string>(); const stack = [...blockedBy];
      while (stack.length) { const k = stack.pop()!; if (k === me.id) throw new Error("that would make two items wait on each other"); if (seen.has(k)) continue; seen.add(k); stack.push(...(items.find((i) => i.id === k)?.blockedBy ?? [])); }
    }
    return this.#edit(root, me.id, (i) => {
      const next: TodoItem = { ...i };
      if (patch.notes !== undefined) { const n = patch.notes.trim().slice(0, MAX_NOTES); if (n) next.notes = n; else delete next.notes; }
      if (patch.images !== undefined) { const im = patch.images.filter((x) => typeof x === "string" && x).slice(0, MAX_IMAGES); if (im.length) next.images = im; else delete next.images; }
      if (blockedBy !== undefined) { if (blockedBy.length) next.blockedBy = blockedBy; else delete next.blockedBy; }
      return next;
    });
  }

  /** A finished item back in the queue: the keeper was wrong, or the work came undone. */
  reopen(root: string, id: string): TodoItem {
    return this.#edit(root, id, (i) => {
      if (i.status !== "done" && i.status !== "dropped") throw new Error(`that item is ${i.status}, not finished`);
      const { claimedBy: _b, claimedAt: _a, doneAt: _d, result: _r, ...rest } = i;
      return { ...rest, status: "queued" };
    });
  }

  /** Take a finished item out of the file for good (a record the keeper made that was not a task). */
  remove(root: string, id: string): TodoItem {
    let gone: TodoItem | null = null;
    this.#write(root, (items) => {
      const at = items.findIndex((i) => i.id === id || (id.length >= 8 && i.id.startsWith(id)));
      if (at < 0) throw new Error(`no todo ${id} in ${basename(root)}`);
      gone = items[at];
      return items.filter((_, k) => k !== at).map((i) => {
        if (!i.blockedBy?.includes(gone!.id)) return i;
        const left = i.blockedBy.filter((b) => b !== gone!.id);
        const { blockedBy: _x, ...rest } = i;
        return left.length ? { ...rest, blockedBy: left } : rest;
      });
    });
    this.onChange?.(root, gone!, "changed");
    return gone!;
  }

  /** Release everything `by` holds (its session is gone). Returns what went back to the queue. */
  releaseBy(root: string, by: string): TodoItem[] {
    const out: TodoItem[] = [];
    this.#write(root, (items) => items.map((i) => {
      if (i.status !== "claimed" || i.claimedBy !== by) return i;
      const { claimedBy: _b, claimedAt: _a, ...rest } = i; const back: TodoItem = { ...rest, status: "queued" }; out.push(back); return back;
    }));
    return out;
  }

  /** Finished work, newest first, from the file and the archive pruning appends to. */
  history(root: string, q = "", limit = 100): TodoItem[] {
    const dir = resolve(root);
    const archived: TodoItem[] = [];
    try {
      const f = join(dir, ARCHIVE_FILE);
      if (existsSync(f)) for (const line of readFileSync(f, "utf8").split("\n")) { if (!line.trim()) continue; try { const i = JSON.parse(line); if (valid(i)) archived.push(i); } catch { /* a torn line */ } }
    } catch { /* unreadable archive: current items only */ }
    const seen = new Set<string>();
    const all = [...this.read(dir).filter((i) => i.status === "done" || i.status === "dropped"), ...archived].filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
    const needle = q.trim().toLowerCase();
    return all.filter((i) => !needle || `${i.text} ${i.result ?? ""} ${i.notes ?? ""} ${i.claimedBy ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.doneAt ?? b.addedAt) - (a.doneAt ?? a.addedAt)).slice(0, limit);
  }

  /** Take an item for `by`. Only a queued item for claude can be claimed, and only once. */
  claim(root: string, id: string, by: string): TodoItem {
    return this.#edit(root, id, (i, all) => {
      const waiting = blockersOf(all, i);
      if (waiting.length) throw new Error(`blocked: waiting on "${waiting[0].text.slice(0, 60)}"${waiting.length > 1 ? ` and ${waiting.length - 1} more` : ""}`);
      if (i.for !== "claude") throw new Error("that item is for the owner; it cannot be claimed");
      if (i.status === "claimed") throw new Error(`already claimed by ${i.claimedBy ?? "someone"}`);
      if (i.status !== "queued") throw new Error(`that item is ${i.status}`);
      return { ...i, status: "claimed", claimedBy: by.slice(0, 80), claimedAt: this.#now() };
    });
  }

  /** Finish an item with a one-line result (for an owner item: the answer). Queued items may be finished directly. */
  done(root: string, id: string, result?: string, by?: string): TodoItem {
    return this.#edit(root, id, (i) => {
      if (i.status === "done" || i.status === "dropped") throw new Error(`that item is already ${i.status}`);
      const r = (result ?? "").trim().slice(0, MAX_RESULT);
      return { ...i, status: "done", doneAt: this.#now(), ...(r ? { result: r } : {}),
        ...(by && !i.claimedBy ? { claimedBy: by.slice(0, 80) } : {}) };
    });
  }

  /**
   * Work that was never queued but got done: a prompt a session finished.
   * Lands straight in done, signed by the session, so the done column is
   * the record of what happened here and not only of what was queued.
   */
  record(root: string, input: { text: string; result?: string; by: string }): TodoItem {
    const text = (input.text ?? "").trim().slice(0, MAX_TEXT);
    if (!text) throw new Error("a todo needs text");
    const now = this.#now();
    const r = (input.result ?? "").trim().slice(0, MAX_RESULT);
    const item: TodoItem = { id: randomUUID(), text, for: "claude", status: "done", addedAt: now, addedBy: input.by.slice(0, 80),
      claimedBy: input.by.slice(0, 80), claimedAt: now, doneAt: now, ...(r ? { result: r } : {}) };
    this.#write(root, (items) => [...items, item]);
    this.onChange?.(root, item, "added");
    return item;
  }

  drop(root: string, id: string): TodoItem {
    return this.#edit(root, id, (i) => {
      if (i.status === "done" || i.status === "dropped") throw new Error(`that item is already ${i.status}`);
      return { ...i, status: "dropped", doneAt: this.#now() };
    });
  }

  /** Put a claimed item back in the queue — a stale claim, or a change of mind. Never automatic. */
  release(root: string, id: string): TodoItem {
    return this.#edit(root, id, (i) => {
      if (i.status !== "claimed") throw new Error(`that item is ${i.status}, not claimed`);
      const { claimedBy: _b, claimedAt: _a, ...rest } = i;
      return { ...rest, status: "queued" };
    });
  }

  edit(root: string, id: string, text: string): TodoItem {
    const t = text.trim().slice(0, MAX_TEXT);
    if (!t) throw new Error("a todo needs text");
    return this.#edit(root, id, (i) => ({ ...i, text: t }));
  }

  /** Reorder the open items for claude; ids not named keep their relative order after the named ones. */
  reorder(root: string, ids: string[]): TodoItem[] {
    let out: TodoItem[] = [];
    this.#write(root, (items) => {
      const rank = new Map(ids.map((id, i) => [id, i]));
      const movable = (i: TodoItem) => i.for === "claude" && (i.status === "queued" || i.status === "claimed");
      const moved = items.filter(movable).sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
      let k = 0;
      out = items.map((i) => (movable(i) ? moved[k++] : i));
      return out;
    });
    return out;
  }

  #edit(root: string, id: string, fn: (i: TodoItem, all: TodoItem[]) => TodoItem): TodoItem {
    let changed: TodoItem | null = null;
    this.#write(root, (items) => {
      const at = items.findIndex((i) => i.id === id || (id.length >= 8 && i.id.startsWith(id)));
      if (at < 0) throw new Error(`no todo ${id} in ${basename(root)}`);
      changed = fn(items[at], items);
      return items.map((i, k) => (k === at ? changed! : i));
    });
    this.onChange?.(root, changed!, "changed");
    return changed!;
  }

  /** Re-read, transform, prune, write atomically. The read inside the write is the single-writer rule. */
  #write(root: string, fn: (items: TodoItem[]) => TodoItem[]): void {
    const dir = resolve(root);
    try { if (!statSync(dir).isDirectory()) throw new Error("not a directory"); }
    catch { throw new Error(`${dir} is not a directory`); }
    const p = this.path(dir);
    const before = fn(this.read(dir));
    const next = prune(before, this.#now());
    // What pruning drops is archived, not lost: the history search reads it back.
    const kept = new Set(next.map((i) => i.id));
    const dropped = before.filter((i) => !kept.has(i.id));
    if (dropped.length) {
      try { appendFileSync(join(dir, ARCHIVE_FILE), dropped.map((i) => JSON.stringify(i)).join("\n") + "\n"); }
      catch { /* an unwritable archive must not block the write */ }
    }
    writeFileSync(`${p}.tmp`, JSON.stringify({ items: next }, null, 2) + "\n");
    renameSync(`${p}.tmp`, p);
  }
}

function valid(i: unknown): i is TodoItem {
  const x = i as Partial<TodoItem> | null;
  return !!x && typeof x.id === "string" && typeof x.text === "string"
    && (x.for === "claude" || x.for === "owner")
    && (x.status === "queued" || x.status === "claimed" || x.status === "done" || x.status === "dropped");
}

/** Finished items leave after PRUNE_AFTER_MS, and past KEEP_FINISHED the oldest go first. */
export function prune(items: TodoItem[], now: number): TodoItem[] {
  const finished = items.filter((i) => (i.status === "done" || i.status === "dropped"));
  const stale = new Set(finished.filter((i) => now - (i.doneAt ?? i.addedAt) > PRUNE_AFTER_MS).map((i) => i.id));
  const recent = finished.filter((i) => !stale.has(i.id)).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
  for (const i of recent.slice(KEEP_FINISHED)) stale.add(i.id);
  return items.filter((i) => !stale.has(i.id));
}

/* ---------------- what a terminal session is doing ---------------- */

/** working/idle are read from the pane (insight.ts); "probably idle" is the output-age fallback when the pane could not be read. */
export type TmuxState = "working" | "idle" | "probably idle" | "no claude";

/**
 * Inferred, not known. A pane running `claude` that printed something in the
 * last PROBABLY_IDLE_MS is working; one that has been quiet longer is most
 * likely waiting at its prompt; anything else has no Claude in it. The
 * threshold is a guess until measured against real sessions (the design
 * says so), which is why the word "probably" is in the label.
 */
export const PROBABLY_IDLE_MS = 60_000;
export function tmuxState(s: { command: string; activityAt: number }, now: number): TmuxState {
  if (s.command !== "claude") return "no claude";
  return now - s.activityAt > PROBABLY_IDLE_MS ? "probably idle" : "working";
}

/* ---------------- the board ---------------- */

/** The chat's own TodoWrite list, as last sent: the model's steps. */
export type Steps = { content: string; status: string }[] | null;

export type SessionRow =
  | { kind: "chat"; id: string; title: string; state: "busy" | "waiting" | "idle"; since: number; steps: Steps;
      /** The assistant's last words, and a one-line summary of the thread (insight.ts), when known. */
      lastText?: string; lastPrompt?: string; summary?: string | null; model?: string | null;
      /** Open approval cards / questions, when the chat is waiting (session.ts pendingCards). */
      pending?: { id: string; kind: string; tool: string; summary: string }[];
      /** What the keeper made of the thread (insight.ts Assessment): the task's title and where it stands. */
      task?: { title: string; status: string; result?: string; question?: string } | null }
  | { kind: "tmux"; name: string; path: string; state: TmuxState; since: number; attached: number;
      activity?: string; lastText?: string; lastPrompt?: string; summary?: string | null; model?: string; ctxPct?: number;
      task?: { title: string; status: string; result?: string; question?: string } | null };

export type BoardProject = {
  id: string | null;
  name: string;
  root: string;
  sessions: SessionRow[];
  queue: (TodoItem & { waitingOn?: { id: string; text: string }[]; stale?: "gone" | "idle" })[];
  /** Open items for the owner in this project: the "needs you" column. */
  asks: TodoItem[];
  counts: { queued: number; claimed: number; forYou: number };
};

/** How long a held item's session may sit idle before the claim reads as stale. */
export const STALE_IDLE_MS = 15 * 60_000;

export type Board = {
  at: number;
  forYou: (TodoItem & { project: string; root: string })[];
  projects: BoardProject[];
};

export type BoardInput = {
  now: number;
  projectsRoot: string;
  /** Known projects, in the order the picker shows them (most recent first). */
  projects: { id: string; name: string; path: string; general?: boolean }[];
  /** project: the id the chat is set to; null/undefined = General, however its cwd happens to be set. */
  chats: { id: string; title: string; cwd: string; project?: string | null; busy: boolean; waiting: boolean; lastTouched: number; steps: Steps; lastText?: string; lastPrompt?: string; summary?: string | null; model?: string | null;
    pending?: { id: string; kind: string; tool: string; summary: string }[]; task?: { title: string; status: string; result?: string; question?: string } | null }[];
  tmux: { name: string; path: string; command: string; activityAt: number; attached: number;
    /** From the pane, when it could be read: exact state and what it says. */
    pane?: { state: "working" | "idle" | "unknown"; activity?: string; lastText?: string; lastPrompt?: string; model?: string; ctxPct?: number }; summary?: string | null;
    task?: { title: string; status: string; result?: string; question?: string } | null }[];
  todos: Pick<TodoStore, "read" | "has">;
};

/**
 * One board across projects. A project is on it when a session works there
 * or its queue has anything open; empty, idle projects are not. Sessions and
 * queue are both grouped by the project root a cwd resolves to.
 */
export function buildBoard(input: BoardInput): Board {
  const { now, projectsRoot } = input;
  const byRoot = new Map<string, BoardProject>();
  const project = (root: string): BoardProject => {
    let p = byRoot.get(root);
    if (p) return p;
    const known = input.projects.find((x) => resolve(x.path) === root && !x.general);
    p = { id: known?.id ?? null, name: known?.name ?? basename(root), root, sessions: [], queue: [], asks: [], counts: { queued: 0, claimed: 0, forYou: 0 } };
    byRoot.set(root, p);
    return p;
  };

  // A chat counts under the project it is set to. One with no project is a
  // General chat whatever its cwd says — every General chat sits in the
  // server's default directory, and grouping by that put a pension question
  // under codeTerminal (seen 2026-10-09). General chats get a card of their own.
  const general = input.projects.find((p) => p.general);
  for (const c of input.chats) {
    const known = c.project ? input.projects.find((p) => p.id === c.project && !p.general) : undefined;
    const root = known ? projectRootOf(known.path, projectsRoot) : general ? resolve(general.path) : projectRootOf(c.cwd, projectsRoot);
    if (!known && general && !byRoot.has(root)) byRoot.set(root, { id: general.id, name: general.name, root, sessions: [], queue: [], asks: [], counts: { queued: 0, claimed: 0, forYou: 0 } });
    project(root).sessions.push({ kind: "chat", id: c.id, title: c.title,
      state: c.waiting ? "waiting" : c.busy ? "busy" : "idle", since: c.lastTouched, steps: c.steps,
      ...(c.lastText ? { lastText: c.lastText } : {}), ...(c.lastPrompt ? { lastPrompt: c.lastPrompt } : {}), ...(c.summary !== undefined ? { summary: c.summary } : {}), ...(c.model !== undefined ? { model: c.model } : {}),
      ...(c.pending?.length ? { pending: c.pending } : {}), ...(c.task !== undefined ? { task: c.task } : {}) });
  }
  for (const s of input.tmux) {
    if (!s.path) continue;
    const root = projectRootOf(s.path, projectsRoot);
    const p = s.pane;
    const state: TmuxState = p && p.state !== "unknown" && s.command === "claude" ? p.state : tmuxState(s, now);
    project(root).sessions.push({ kind: "tmux", name: s.name, path: s.path, state, since: s.activityAt, attached: s.attached,
      ...(p?.activity ? { activity: p.activity } : {}), ...(p?.lastText ? { lastText: p.lastText } : {}), ...(p?.lastPrompt ? { lastPrompt: p.lastPrompt } : {}), ...(p?.model ? { model: p.model } : {}),
      ...(p?.ctxPct !== undefined ? { ctxPct: p.ctxPct } : {}), ...(s.summary !== undefined ? { summary: s.summary } : {}), ...(s.task !== undefined ? { task: s.task } : {}) });
  }
  // Every known project with a todo file, and every root a session brought in.
  const roots = new Set<string>([...byRoot.keys(), ...input.projects.map((p) => resolve(p.path))]);
  const forYou: Board["forYou"] = [];
  for (const root of roots) {
    if (!input.todos.has(root)) continue;
    const items = input.todos.read(root);
    const p = project(root);
    p.queue = items.filter((i) => i.for === "claude").map((i) => {
      if (i.status === "queued") { const w = blockersOf(items, i); return w.length ? { ...i, waitingOn: w.map((x) => ({ id: x.id, text: x.text })) } : i; }
      if (i.status === "claimed") {
        const holder = i.claimedBy ? [...byRoot.values()].flatMap((q) => q.sessions).find((s) => (s.kind === "chat" ? `chat:${s.id}` : `tmux:${s.name}`) === i.claimedBy) : undefined;
        const stale = !holder ? "gone" : holder.state === "idle" && now - holder.since > STALE_IDLE_MS ? "idle" : undefined;
        return stale ? { ...i, stale } : i;
      }
      return i;
    });
    for (const i of items) {
      if (i.for === "owner" && i.status !== "done" && i.status !== "dropped") { forYou.push({ ...i, project: p.name, root }); p.asks.push(i); }
    }
    p.asks.sort((a, b) => b.addedAt - a.addedAt);
    p.counts.queued = p.queue.filter((i) => i.status === "queued").length;
    p.counts.claimed = p.queue.filter((i) => i.status === "claimed").length;
    p.counts.forYou = items.filter((i) => i.for === "owner" && i.status !== "done" && i.status !== "dropped").length;
  }
  forYou.sort((a, b) => b.addedAt - a.addedAt);

  const order = new Map(input.projects.map((p, i) => [resolve(p.path), i]));
  const projects = [...byRoot.values()]
    .filter((p) => p.sessions.length || p.counts.queued || p.counts.claimed || p.counts.forYou)
    .sort((a, b) => (order.get(a.root) ?? 1e9) - (order.get(b.root) ?? 1e9));
  for (const p of projects) {
    p.sessions.sort((a, b) => rank(a) - rank(b) || b.since - a.since);
    // Queue: queued in order, then claimed, then the recent finished ones.
    const w = (i: TodoItem) => (i.status === "queued" ? 0 : i.status === "claimed" ? 1 : 2);
    p.queue = p.queue.map((i, k) => [i, k] as const).sort((a, b) => w(a[0]) - w(b[0]) || (w(a[0]) === 2 ? (b[0].doneAt ?? 0) - (a[0].doneAt ?? 0) : a[1] - b[1])).map(([i]) => i);
  }
  return { at: now, forYou, projects };
}

/** Idle chats first — they are the ones a queued item can go to — then the inferred-idle terminals, then waiting, then busy. */
function rank(s: SessionRow): number {
  if (s.kind === "chat") return s.state === "idle" ? 0 : s.state === "waiting" ? 2 : 3;
  return s.state === "idle" ? 0 : s.state === "probably idle" ? 1 : s.state === "working" ? 4 : 5;
}

/**
 * The queue as the chat's prompt carries it: the owner's list for this
 * project, what this chat holds, and answers to what this chat asked. Owner
 * -authored, so it rides outside the untrusted block; null when there is
 * nothing to say, so an empty queue costs no tokens.
 */
export function queueBlock(items: TodoItem[], chatId: string, now: number, max = 12): string | null {
  const me = `chat:${chatId}`;
  const ready = (i: TodoItem) => blockersOf(items, i).length === 0;
  const queued = items.filter((i) => i.for === "claude" && i.status === "queued" && ready(i)).slice(0, max);
  const blocked = items.filter((i) => i.for === "claude" && i.status === "queued" && !ready(i)).slice(0, 5);
  const mine = items.filter((i) => i.for === "claude" && i.status === "claimed" && i.claimedBy === me);
  const answered = items.filter((i) => i.for === "owner" && i.status === "done" && i.addedBy === me && i.result && now - (i.doneAt ?? 0) < 24 * 60 * 60_000);
  if (!queued.length && !mine.length && !answered.length && !blocked.length) return null;
  const short = (id: string) => id.slice(0, 8);
  const lines: string[] = [];
  const detail = (i: TodoItem) => [
    ...(i.notes ? [`  notes: ${i.notes.replace(/\s+/g, " ").slice(0, 400)}${i.notes.length > 400 ? "…" : ""}`] : []),
    ...(i.images?.length ? [`  images (Read them): ${i.images.join(", ")}`] : []),
  ];
  if (mine.length) { lines.push("You hold:"); for (const i of mine) lines.push(`- [${short(i.id)}] ${i.text}`, ...detail(i)); }
  if (queued.length) { lines.push("Queued for this project (take one with todos.claim when asked, or when you finish what you hold):"); for (const i of queued) lines.push(`- [${short(i.id)}] ${i.text}`, ...detail(i)); }
  if (blocked.length) { lines.push("Waiting on other items (not yours to take yet):"); for (const i of blocked) lines.push(`- [${short(i.id)}] ${i.text} — after: ${blockersOf(items, i).map((b) => `[${short(b.id)}]`).join(" ")}`); }
  if (answered.length) { lines.push("The owner answered what you asked:"); for (const i of answered) lines.push(`- Q: ${i.text}\n  A: ${i.result}`); }
  return lines.join("\n");
}
