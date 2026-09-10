import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type Prompt = {
  id: string;
  title: string;
  text: string;
  /** Hostnames this applies to. Empty means it applies everywhere. */
  domains: string[];
  createdAt: number;
  updatedAt: number;
};

/**
 * Does `host` fall under `pattern`?
 *
 * A pattern always covers its own subdomains: "github.com" matches
 * gist.github.com, because writing a prompt for a site and then not seeing it
 * on that site's subdomain is a papercut nobody wants. A leading "*." is
 * accepted and means the same thing, since people write it out of habit.
 *
 * Suffix matching is done on labels, not characters — "evilgithub.com" must
 * not match "github.com".
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  if (!h || !p) return false;
  return h === p || h.endsWith("." + p);
}

/** The URL's hostname, or "" if it is not a URL we can reason about. */
export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try { return new URL(url).hostname; } catch { return ""; }
}

/**
 * Applicable prompts, most specific first: ones naming this host before
 * generic ones, so a site-specific prompt is never buried under general ones.
 */
export function applicable(all: Prompt[], host: string): Prompt[] {
  const scored = all.map((p) => {
    const generic = p.domains.length === 0;
    const hit = !generic && host && p.domains.some((d) => hostMatches(host, d));
    return { p, rank: hit ? 0 : generic ? 1 : 2 };
  });
  return scored
    .filter((s) => s.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.p.title.localeCompare(b.p.title))
    .map((s) => s.p);
}

/** Fills {url}, {title}, {host} and {selection} from the active tab. */
export function fill(text: string, tab: { url?: string; title?: string; selection?: string }): string {
  return text
    .replace(/\{url\}/g, tab.url ?? "")
    .replace(/\{title\}/g, tab.title ?? "")
    .replace(/\{host\}/g, hostOf(tab.url))
    .replace(/\{selection\}/g, tab.selection ?? "");
}

const SEED: Omit<Prompt, "id" | "createdAt" | "updatedAt">[] = [
  { title: "Summarise this page", domains: [],
    text: "Read {url} and summarise it in three sentences. Say what it is for and who it is aimed at." },
  { title: "What changed here?", domains: [],
    text: "Read {url}, then check this repo for anything related and tell me whether the page and the code disagree." },
  { title: "Explain the selection", domains: [],
    text: "About this from {title}:\n\n\"\"\"\n{selection}\n\"\"\"\n\nExplain it plainly in three sentences." },
  { title: "Review the diff", domains: [],
    text: "Run `git diff` in my working directory and review it for bugs. Be specific; skip style opinions." },
  { title: "Fix what just failed", domains: [],
    text: "Read my terminal, find what failed, and fix it. Show me the diff before applying." },
];

export class PromptStore {
  #path: string;
  #items: Prompt[] = [];

  constructor(path: string) {
    this.#path = path;
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.#path)) {
      // First run: a few examples beat an empty list nobody knows how to fill.
      const now = Date.now();
      this.#items = SEED.map((s) => ({ ...s, id: randomUUID(), createdAt: now, updatedAt: now }));
      this.#save();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.#path, "utf8"));
      this.#items = Array.isArray(parsed) ? parsed.filter((p) => p?.id && p?.title) : [];
    } catch {
      this.#items = [];
    }
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeFileSync(`${this.#path}.tmp`, JSON.stringify(this.#items, null, 2));
      renameSync(`${this.#path}.tmp`, this.#path);
    } catch { /* a lost prompt is not worth crashing over */ }
  }

  all(): Prompt[] { return [...this.#items]; }

  for(host: string): Prompt[] { return applicable(this.#items, host); }

  upsert(input: { id?: string; title: string; text: string; domains?: string[] }): Prompt {
    const title = input.title.trim();
    const text = input.text.trim();
    if (!title || !text) throw new Error("a prompt needs a title and a body");
    const domains = (input.domains ?? [])
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean);

    const now = Date.now();
    const existing = input.id ? this.#items.find((p) => p.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, { title, text, domains, updatedAt: now });
      this.#save();
      return existing;
    }
    const created: Prompt = { id: randomUUID(), title, text, domains, createdAt: now, updatedAt: now };
    this.#items.push(created);
    this.#save();
    return created;
  }

  remove(id: string): boolean {
    const before = this.#items.length;
    this.#items = this.#items.filter((p) => p.id !== id);
    if (this.#items.length === before) return false;
    this.#save();
    return true;
  }
}
