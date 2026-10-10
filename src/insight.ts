/**
 * What a session is doing, for the board (docs/design-todos.md).
 *
 * Two sources. The pane of a tmux session running Claude Code says exactly
 * whether it is working or waiting: a spinner line with a timer above the
 * input box while a turn runs, a "done" line or nothing when it is at its
 * prompt. Measured on three live panes on 2026-10-09 — see test/insight.test.ts
 * for the captures. That replaces the "probably idle" guess from output age
 * whenever a pane can be read.
 *
 * And a one-line summary of what a thread is about, from a cheap model
 * (Haiku), cached per session and recomputed only when the transcript has
 * changed and at most every MIN_REFRESH_MS, so an open board costs a few
 * cents an hour rather than a call per poll.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";

export type PaneState = "working" | "idle" | "unknown";

export type PaneInsight = {
  state: PaneState;
  /** The spinner line while working ("Frosting… 10m 58s · ↓ 7.6k tokens"), or the done line. */
  activity?: string;
  /** The assistant's last words above the input box, capped. */
  lastText?: string;
  /** The last prompt the person (or the board) typed, as the CLI echoes it: "❯ …". What a working session is on. */
  lastPrompt?: string;
  /** From the CLI's status line: "Fable 5.1", "Opus 5.5". */
  model?: string;
  ctxPct?: number;
  /** The transcript lines above the input box, for a summary. */
  transcript: string;
};

const SEPARATOR = /^\s*─{10,}\s*$/;
/** "✽ Frosting… (10m 58s · ↓ 7.6k tokens)" — a glyph, words, an ellipsis, a parenthesised timer. */
const SPINNER = /^\s*[✽✻✢✳✶✦·*●]\s+(\S.*?…)\s*\(([^)]*)\)/;
/** "✻ Baked for 7s · done 3:13 PM · 1 shell still running" */
const DONE = /^\s*[✽✻✢✳✶✦·*]\s+.*\b(done|Baked for|Worked for|Cooked for)\b/i;
const STATUS = /\|\s*([A-Z][A-Za-z]+(?:\s+\d+(?:\.\d+)?)?)\s*\|\s*(\d+)% ctx/;
/** "● Bash(cd …)", "● Read 1 file", "● Calling codeterminal…", "● Searched for …": a tool call, not words to the person. */
const TOOL_LINE = /^●\s+(?:[A-Z][A-Za-z]+\(|Read \d|Calling |Searched |Listed |Found |Wrote |Updated |Running |Fetched |Spawned |Ran )/;
/** Lines the CLI adds around results, never part of a sentence. */
const CHROME = /ctrl\+o to expand|ctrl\+b|esc to interrupt|to run in background|^\s*⎿/;

/** Read a captured tmux pane (capture-pane -p) of a Claude Code session. */
export function readPane(text: string): PaneInsight {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const seps = lines.map((l, i) => (SEPARATOR.test(l) ? i : -1)).filter((i) => i >= 0);
  // The input box is the last pair of separators; above it is the transcript, below it the status lines.
  const boxTop = seps.length >= 2 ? seps[seps.length - 2] : -1;
  const above = (boxTop >= 0 ? lines.slice(0, boxTop) : lines).filter((l) => l.trim());
  const below = boxTop >= 0 ? lines.slice(seps[seps.length - 1] + 1) : [];

  let state: PaneState = boxTop >= 0 ? "idle" : "unknown";
  let activity: string | undefined;
  for (let i = above.length - 1; i >= Math.max(0, above.length - 6); i--) {
    const m = SPINNER.exec(above[i]);
    if (m) { state = "working"; activity = `${m[1]} ${m[2]}`.replace(/\s+/g, " ").trim(); break; }
    if (DONE.test(above[i])) { state = "idle"; activity = above[i].replace(/^\s*[✽✻✢✳✶✦·*]\s+/, "").trim(); break; }
  }
  if (state !== "working" && above.some((l) => /esc to interrupt/i.test(l))) state = "working";

  // The last assistant *words*: the last ● line that is prose, not a tool call
  // ("● Bash(cd … )", "● Read 1 file", "● Calling codeterminal…"), with its
  // wrapped continuation up to the next piece of chrome.
  let lastText: string | undefined;
  for (let i = above.length - 1; i >= 0; i--) {
    if (/^●\s/.test(above[i]) && !TOOL_LINE.test(above[i])) {
      const parts = [above[i].replace(/^●\s+/, "")];
      for (let j = i + 1; j < above.length && /^\s{2,}\S/.test(above[j]) && !SPINNER.test(above[j]) && !CHROME.test(above[j]); j++) parts.push(above[j].trim());
      lastText = parts.join(" ").replace(/\s+/g, " ").slice(0, 300);
      break;
    }
  }
  // The last prompt echo: a ❯ line with words, plus its wrapped continuation.
  let lastPrompt: string | undefined;
  for (let i = above.length - 1; i >= 0; i--) {
    const m = /^❯\s+(\S.*)$/.exec(above[i]);
    if (m && !/^Try "/.test(m[1])) {
      const parts = [m[1]];
      for (let j = i + 1; j < above.length && /^\s{2,}\S/.test(above[j]) && !/^\s*[●✽✻✢✳✶✦⎿]/.test(above[j]) && !CHROME.test(above[j]); j++) parts.push(above[j].trim());
      lastPrompt = parts.join(" ").replace(/\s+/g, " ").slice(0, 300);
      break;
    }
  }
  let model: string | undefined, ctxPct: number | undefined;
  for (const l of below) { const m = STATUS.exec(l); if (m) { model = m[1]; ctxPct = Number(m[2]); break; } }

  // Strip the CLI's chrome from the transcript handed to the summariser.
  const transcript = above.filter((l) => !SPINNER.test(l) && !/ctrl\+b|esc to interrupt|to run in background/i.test(l)).slice(-60).join("\n");
  return { state, ...(activity ? { activity } : {}), ...(lastText ? { lastText } : {}), ...(lastPrompt ? { lastPrompt } : {}), ...(model ? { model } : {}), ...(ctxPct !== undefined ? { ctxPct } : {}), transcript };
}

/** The assistant's last words in a chat's record, for the row — immediate, no model call. */
export function lastAssistantText(events: { kind: string; text?: string }[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "user") return undefined;   // nothing said yet this turn
    if (e.kind === "text" && e.text?.trim()) return plain(e.text);
  }
  return undefined;
}

/** The person's last message in a chat's record: what a busy chat is on. */
export function lastUserText(events: { kind: string; text?: string }[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === "user" && e.text?.trim()) return e.text.replace(/\s+/g, " ").trim().slice(0, 300);
  }
  return undefined;
}

/** Markdown read as one line: no tables, no emphasis marks, no headings, no code fences. */
export function plain(md: string): string {
  return md.replace(/```[\s\S]*?```/g, " ").replace(/^\s*\|?[-:| ]+\|?\s*$/gm, " ").replace(/\|/g, " ")
    .replace(/^\s*[#>]+\s*/gm, "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/* ---------------- the board keeper: Haiku reads each thread ---------------- */

export const MIN_REFRESH_MS = 90_000;
export const SUMMARY_MODEL = "claude-haiku-5-5";
const INPUT_CAP = 6000;

/**
 * What a cheap model makes of a thread's tail. `summary` is the line on the
 * session pill; `title` names the task as a card; `status` says where that
 * task is — working, done (the last message reports it finished), needs_you
 * (it is asking the owner something or waiting on a decision), idle (small
 * talk, nothing in flight). The server turns done into a done item and
 * needs_you into a question on the board (docs/design-todos.md §15).
 */
export type Assessment = {
  summary: string;
  title: string;
  status: "working" | "done" | "needs_you" | "idle";
  result?: string;
  question?: string;
};
export type Assessor = (text: string) => Promise<Assessment | null>;

type Entry = { hash: string; at: number; value: Assessment | null; pending: boolean };

/**
 * Assessments by key ("chat:<id>", "tmux:<name>"). `get` answers from the
 * cache at once and refreshes in the background when the text changed and
 * the last refresh is old enough (or `force` says now — a turn just ended);
 * the next poll sees the new value. Persisted, so a restart does not blank
 * every card and re-ask the model for all of them.
 */
export class Insights {
  #cache = new Map<string, Entry>();
  #assess: Assessor;
  #now: () => number;
  #path: string | null;
  #saveTimer: NodeJS.Timeout | null = null;
  /** Told when a fresh assessment lands, so the keeper can act on it without waiting for a poll. */
  onFresh?: (key: string, a: Assessment) => void;
  constructor(assess: Assessor = assessWithHaiku, now: () => number = Date.now, path: string | null = null) {
    this.#assess = assess; this.#now = now; this.#path = path;
    if (path && existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, { hash: string; at: number; value?: Assessment | null; summary?: string | null }>;
        for (const [k, v] of Object.entries(raw)) if (v && typeof v.hash === "string") {
          // Older files held a summary line alone; it is still worth showing until the next refresh.
          const value = v.value ?? (v.summary ? { summary: v.summary, title: "", status: "working" as const } : null);
          this.#cache.set(k, { hash: v.hash, at: Number(v.at) || 0, value, pending: false });
        }
      } catch { /* a bad cache is just an empty one */ }
    }
  }

  #save(): void {
    if (!this.#path || this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      try {
        const out: Record<string, { hash: string; at: number; value: Assessment | null }> = {};
        for (const [k, e] of this.#cache) out[k] = { hash: e.hash, at: e.at, value: e.value };
        writeFileSync(`${this.#path}.tmp`, JSON.stringify(out));
        renameSync(`${this.#path}.tmp`, this.#path!);
      } catch { /* losing a cache is not worth a log line per poll */ }
    }, 500);
    this.#saveTimer.unref?.();
  }

  get(key: string, text: string, force = false): Assessment | null {
    const t = text.trim();
    if (!t) return this.#cache.get(key)?.value ?? null;
    const hash = createHash("sha1").update(t.slice(-INPUT_CAP)).digest("hex");
    const e = this.#cache.get(key);
    const now = this.#now();
    if (e && (e.hash === hash || e.pending || (!force && now - e.at < MIN_REFRESH_MS))) return e.value;
    const next: Entry = { hash, at: now, value: e?.value ?? null, pending: true };
    this.#cache.set(key, next);
    void this.#assess(t.slice(-INPUT_CAP)).then((a) => { if (a) { next.value = a; this.onFresh?.(key, a); } }, () => {}).finally(() => { next.pending = false; next.at = this.#now(); this.#save(); });
    return next.value;
  }

  /** Forget sessions that are gone, so the map does not grow with every chat ever opened. */
  keep(keys: Iterable<string>): void {
    const live = new Set(keys);
    let dropped = false;
    for (const k of this.#cache.keys()) if (!live.has(k)) { this.#cache.delete(k); dropped = true; }
    if (dropped) this.#save();
  }
}

/** Haiku, no tools, no settings: one read of a transcript tail, answered as JSON. */
export async function assessWithHaiku(text: string): Promise<Assessment | null> {
  const prompt =
    `Below is the tail of a coding-assistant conversation (a person and an assistant working in a project). Read it and answer with one JSON object and nothing else:\n` +
    `{"summary": one sentence of at most 25 words on what the thread is working on and its topics, present tense;\n` +
    ` "title": the task as the person would name it, at most 8 words, imperative or noun phrase, no trailing period. The task is the feature, bug, question or outcome the person wants — never the step being taken for it: committing, pushing, testing, restarting, rendering, writing docs are steps inside a task, not tasks. Keep the title the same across steps of one task;\n` +
    ` "status": "working" if the assistant is mid-task (a step done but the task not), "done" only if its last message reports the whole task finished or the question answered, "needs_you" if the assistant is asking the person a question or waiting for their decision, "idle" if there is no task in flight (greetings, small talk, an empty start);\n` +
    ` "result": only when done, at most 20 words on the outcome;\n` +
    ` "question": only when needs_you, the question for the person in one sentence}\n\n${text}`;
  try {
    let out = "";
    for await (const m of query({ prompt, options: { model: SUMMARY_MODEL, settingSources: [], allowedTools: [], permissionPrompts: "none", maxTurns: 1 } })) {
      if (m.type === "assistant") for (const b of m.message.content) if (b.type === "text") out += b.text;
    }
    return parseAssessment(out);
  } catch { return null; }
}

/** The model's JSON, with the fences and chatter it sometimes adds stripped; null when it is not usable. */
export function parseAssessment(raw: string): Assessment | null {
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const str = (k: string, cap: number) => (typeof o[k] === "string" ? (o[k] as string).replace(/\s+/g, " ").trim().slice(0, cap) : "");
    const status = ["working", "done", "needs_you", "idle"].includes(String(o.status)) ? (o.status as Assessment["status"]) : "working";
    const summary = str("summary", 240), title = str("title", 120).replace(/[.。]+$/, "");
    if (!summary && !title) return null;
    return { summary: summary || title, title: title || summary.slice(0, 80), status,
      ...(status === "done" && str("result", 200) ? { result: str("result", 200) } : {}),
      ...(status === "needs_you" && str("question", 500) ? { question: str("question", 500) } : {}) };
  } catch { return null; }
}
