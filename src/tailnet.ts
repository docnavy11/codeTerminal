import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Identity = { userId: number; loginName: string; nodeName: string };

/**
 * Who owns this tailnet address, according to the local tailscaled.
 *
 * Memoised per IP for a few seconds. Every guarded request and every socket
 * upgrade spawns `tailscale whois` (~26 ms measured); the file browser fires
 * dozens per second while listing, and there is no rate limit, so a burst of
 * requests was a burst of subprocesses. A peer's identity does not change
 * inside the window; a revoked node is a tailnet-level event well outside it.
 */
export const WHOIS_TTL_MS = 15_000;
const cache = new Map<string, { at: number; who: Identity | null }>();

export async function whois(ip: string, port: number, now = Date.now()): Promise<Identity | null> {
  const hit = cache.get(ip);
  if (hit && now - hit.at < WHOIS_TTL_MS) return hit.who;
  const who = await whoisUncached(ip, port);
  cache.set(ip, { at: now, who });
  return who;
}

/** Test hook: drop the memo. */
export function clearWhoisCache(): void { cache.clear(); }

async function whoisUncached(ip: string, port: number): Promise<Identity | null> {
  const addr = ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`;
  try {
    const { stdout } = await run("tailscale", ["whois", "--json", addr], { timeout: 4000 });
    const d = JSON.parse(stdout) as {
      Node?: { Name?: string; User?: number };
      UserProfile?: { ID?: number; LoginName?: string };
    };
    const userId = d.UserProfile?.ID ?? d.Node?.User;
    if (typeof userId !== "number") return null;
    return {
      userId,
      loginName: d.UserProfile?.LoginName ?? "(unknown)",
      nodeName: (d.Node?.Name ?? "(unknown)").replace(/\.$/, ""),
    };
  } catch {
    // "peer not found" (non-tailnet source), tailscaled down, or CLI missing.
    return null;
  }
}

/** This node's own tailnet identity — the account allowed to connect. */
export async function self(): Promise<{ userId: number; dnsName: string } | null> {
  try {
    const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 4000 });
    const d = JSON.parse(stdout) as { Self?: { UserID?: number; DNSName?: string } };
    if (typeof d.Self?.UserID !== "number") return null;
    return { userId: d.Self.UserID, dnsName: (d.Self.DNSName ?? "").replace(/\.$/, "") };
  } catch {
    return null;
  }
}

/** Node hands us "::ffff:1.2.3.4" for v4 over a v6 socket; normalise it. */
export function normaliseIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/** A peer address on this machine — the whole 127/8 block, plus IPv6 ::1. */
export function isLoopback(ip: string): boolean {
  return ip === "::1" || /^127\./.test(ip);
}

/** A bind HOST that serves only this machine — used to decide localhost mode. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}
