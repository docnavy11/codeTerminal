import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

/**
 * Which sites the agent may read and drive without asking. Everything else
 * asks once per chat (the approval card names the site and the action), and
 * "Always" lands here. Hostnames, exact or `*.suffix`; case-insensitive.
 * Empty by default: the extension's <all_urls> is the capability, this is
 * the policy.
 */
/** The site a URL belongs to; "" for anything that is not a web page (chrome://, about:, file:, …). */
export function hostOfUrl(url: string | undefined | null): string {
  if (!url) return "";
  try { const u = new URL(url); return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : ""; } catch { return ""; }
}

export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase(), p = pattern.toLowerCase();
  if (!h || !p) return false;
  if (p.startsWith("*.")) { const suf = p.slice(1); return h.endsWith(suf) && h.length > suf.length; }
  return h === p;
}

export function normaliseHost(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  return /^(\*\.)?[a-z0-9.-]+$/.test(s) && !s.endsWith(".") ? s : null;
}

/**
 * Two levels per site. `read` covers looking (read_page, snapshot,
 * screenshot, download); `act` covers changing (click, fill, press,
 * navigate, eval) and implies read. "Let it read my bank" is not "let it
 * click Transfer".
 */
export type Level = "read" | "act";
export const LEVELS: readonly Level[] = ["read", "act"];
export const levelCovers = (granted: Level, needed: Level): boolean => granted === "act" || needed === "read";

export type AllowEntry = { host: string; level: Level };

export class BrowserAllowlist {
  #path: string;
  #hosts = new Map<string, Level>();
  /** `seed` entries are "host" or "host:read"; a bare host is act (the pre-levels meaning). */
  constructor(path: string, seed: string[] = []) {
    this.#path = path;
    try {
      if (existsSync(path)) for (const e of JSON.parse(readFileSync(path, "utf8")) as (string | AllowEntry)[]) {
        // an older file was a list of hosts, each meaning "everything"
        const host = typeof e === "string" ? e : e?.host, level: Level = typeof e === "string" ? "act" : (e?.level === "read" ? "read" : "act");
        const n = normaliseHost(String(host ?? "")); if (n) this.#hosts.set(n, level);
      }
    } catch { /* a corrupt file means an empty list, not a crash */ }
    for (const sd of seed) {
      const m = /^(.*?)(?::(read|act))?$/.exec(sd.trim());
      const n = normaliseHost(m?.[1] ?? ""); if (n) this.#hosts.set(n, (m?.[2] as Level) ?? "act");
    }
  }
  /** Is `host` allowed at `level`? An `act` entry covers a `read` need. */
  has(host: string, level: Level = "read"): boolean {
    for (const [p, l] of this.#hosts) if (hostMatches(host, p) && levelCovers(l, level)) return true;
    return false;
  }
  level(host: string): Level | null {
    let best: Level | null = null;
    for (const [p, l] of this.#hosts) if (hostMatches(host, p)) { if (l === "act") return "act"; best = l; }
    return best;
  }
  all(): AllowEntry[] { return [...this.#hosts].map(([host, level]) => ({ host, level })).sort((a, b) => a.host.localeCompare(b.host)); }
  /** Add or raise; never lowers (use set for that). Returns whether anything changed. */
  add(host: string, level: Level = "act"): boolean {
    const n = normaliseHost(host); if (!n) return false;
    const cur = this.#hosts.get(n);
    if (cur && levelCovers(cur, level)) return false;
    this.#hosts.set(n, level); this.#save(); return true;
  }
  /** Set a level exactly (the manage page's toggle). */
  set(host: string, level: Level): boolean {
    const n = normaliseHost(host); if (!n || !this.#hosts.has(n) || this.#hosts.get(n) === level) return false;
    this.#hosts.set(n, level); this.#save(); return true;
  }
  remove(host: string): boolean { const n = normaliseHost(host); if (!n || !this.#hosts.delete(n)) return false; this.#save(); return true; }
  #save(): void {
    try { writeFileSync(`${this.#path}.tmp`, JSON.stringify(this.all(), null, 2)); renameSync(`${this.#path}.tmp`, this.#path); }
    catch (e) { console.error(`[browser-allow] could not save ${this.#path}: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
