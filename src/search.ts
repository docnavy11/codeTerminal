import type { Store, ChatRecord } from "./store.js";

/**
 * Full-text search over every chat. The picker used to filter titles only —
 * with 3000-event transcripts, what you are looking for is in the text.
 *
 * Plain case-insensitive substring over the events that carry words (what you
 * said, what it replied, notes), one text index per chat rebuilt only when
 * the chat's updatedAt changes. Personal scale: dozens of chats, not
 * thousands; measured on the live dir before shipping (see the test).
 */
export type SearchHit = {
  id: string; title: string; updatedAt: number;
  /** Where in `events` each match sits, so a client can jump to it. */
  matches: { i: number; kind: "user" | "text" | "local"; snippet: string }[];
  titleMatch: boolean;
};

type Indexed = { updatedAt: number; texts: { i: number; kind: "user" | "text" | "local"; text: string }[] };

export class ChatSearch {
  #store: Store;
  #index = new Map<string, Indexed>();
  constructor(store: Store) { this.#store = store; }

  #texts(id: string, updatedAt: number): Indexed["texts"] {
    const hit = this.#index.get(id);
    if (hit && hit.updatedAt === updatedAt) return hit.texts;
    const rec = this.#store.read(id);
    const texts: Indexed["texts"] = [];
    rec?.events.forEach((e, i) => {
      if (e.kind === "user" || e.kind === "text" || e.kind === "local") texts.push({ i, kind: e.kind, text: e.text });
    });
    this.#index.set(id, { updatedAt, texts });
    return texts;
  }

  /** Drop a chat from the index (deleted). Unknown ids are fine. */
  forget(id: string): void { this.#index.delete(id); }

  search(query: string, opts: { maxChats?: number; perChat?: number; live?: (id: string) => ChatRecord | undefined } = {}): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const maxChats = opts.maxChats ?? 30, perChat = opts.perChat ?? 5;
    const hits: SearchHit[] = [];
    for (const c of this.#store.list()) {
      // A live chat may have unsaved (debounced) events; read those, not the file.
      const live = opts.live?.(c.id);
      const texts = live
        ? live.events.flatMap((e, i) => (e.kind === "user" || e.kind === "text" || e.kind === "local") ? [{ i, kind: e.kind, text: e.text }] : [])
        : this.#texts(c.id, c.updatedAt);
      const matches: SearchHit["matches"] = [];
      for (const t of texts) {
        const at = t.text.toLowerCase().indexOf(q);
        if (at < 0) continue;
        matches.push({ i: t.i, kind: t.kind, snippet: snippet(t.text, at, q.length) });
        if (matches.length >= perChat) break;
      }
      const titleMatch = c.title.toLowerCase().includes(q);
      if (matches.length || titleMatch) hits.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, matches, titleMatch });
      if (hits.length >= maxChats) break;
    }
    return hits;
  }
}

/** ~60 chars either side of the match, whitespace collapsed, ellipses where cut. */
export function snippet(text: string, at: number, len: number, around = 60): string {
  const start = Math.max(0, at - around), end = Math.min(text.length, at + len + around);
  const body = text.slice(start, end).replace(/\s+/g, " ");
  return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
}
