import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Identity = { userId: number; loginName: string; nodeName: string };

/** Who owns this tailnet address, according to the local tailscaled. */
export async function whois(ip: string, port: number): Promise<Identity | null> {
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

export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1";
}
