import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

/**
 * Which sites the agent may read and drive without asking. Everything else
 * asks once per chat (the approval card names the site and the action), and
 * "Always" lands here. Hostnames, exact or `*.suffix`; case-insensitive.
 * Empty by default: the extension's <all_urls> is the capability, this is
 * the policy.
 */
export function hostOfUrl(url: string | undefined | null): string {
  if (!url) return "";
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
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

export class BrowserAllowlist {
  #path: string;
  #hosts = new Set<string>();
  constructor(path: string, seed: string[] = []) {
    this.#path = path;
    try {
      if (existsSync(path)) for (const h of JSON.parse(readFileSync(path, "utf8")) as string[]) { const n = normaliseHost(String(h)); if (n) this.#hosts.add(n); }
    } catch { /* a corrupt file means an empty list, not a crash */ }
    for (const h of seed) { const n = normaliseHost(h); if (n) this.#hosts.add(n); }
  }
  has(host: string): boolean { return [...this.#hosts].some((p) => hostMatches(host, p)); }
  all(): string[] { return [...this.#hosts].sort(); }
  add(host: string): boolean { const n = normaliseHost(host); if (!n || this.#hosts.has(n)) return false; this.#hosts.add(n); this.#save(); return true; }
  remove(host: string): boolean { const n = normaliseHost(host); if (!n || !this.#hosts.delete(n)) return false; this.#save(); return true; }
  #save(): void {
    try { writeFileSync(`${this.#path}.tmp`, JSON.stringify(this.all(), null, 2)); renameSync(`${this.#path}.tmp`, this.#path); }
    catch (e) { console.error(`[browser-allow] could not save ${this.#path}: ${e instanceof Error ? e.message : String(e)}`); }
  }
}
