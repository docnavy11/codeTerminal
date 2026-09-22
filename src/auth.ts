import { whois as realWhois, self as realSelf, normaliseIp, isLoopback, isLoopbackHost } from "./tailnet.js";
import { parseTrustedCidrs, ipInAny, type Cidr } from "./cidr.js";

/**
 * Who may connect. Built once at boot from the bind address and environment;
 * `denyReason` is then consulted on every guarded HTTP request and every
 * WebSocket upgrade.
 *
 * Three modes, chosen here:
 *   tailnet    a tailnet identity was found; non-loopback peers are
 *              authenticated by `tailscale whois`. This is the VPS.
 *   cidr       no identity, but CODETERM_TRUSTED_CIDRS names private subnets
 *              whose peers are treated like loopback (a WireGuard tunnel).
 *   localhost  no identity, no CIDRs; loopback bind; serves this machine only.
 *
 * The rule that keeps the last two safe: a network-reachable bind with no
 * authenticator refuses to start — that would be an ungated shell with no
 * authentication. `createAuth` throws AuthRefused for it; the server prints
 * the message and exits.
 */
export type TailnetSelf = { userId: number; dnsName: string };

export type AuthConfig = {
  host: string;
  port: number;
  extraOrigins: string[];
  forceLocal: boolean;
  trustedCidrSpec: string | undefined;
  /** Pin one extension id; unset accepts any chrome-extension:// origin. */
  extOrigin?: string;
  /** Origins allowed besides the pinned one — the extension inside the server browser, once its id is known. */
  extraExtOrigins?: () => string[];
  /** Injection points for tests; default to the real tailscale calls. */
  deps?: { self?: () => Promise<TailnetSelf | null>; whois?: typeof realWhois };
};

/** The subset of an IncomingMessage the policy reads, so tests can pass a plain object. */
export type PeerRequest = {
  headers: { origin?: string | string[]; "sec-fetch-site"?: string | string[] };
  socket: { remoteAddress?: string; remotePort?: number };
};

export type Auth = {
  mode: "tailnet" | "cidr" | "localhost";
  self: TailnetSelf | null;
  trustedCidrs: Cidr[];
  allowedOrigins: Set<string>;
  denyReason(req: PeerRequest): Promise<string | null>;
  /** Lines for the startup banner. */
  banner(): string[];
};

export class AuthRefused extends Error {}

export async function createAuth(cfg: AuthConfig): Promise<Auth> {
  const selfFn = cfg.deps?.self ?? realSelf;
  const whois = cfg.deps?.whois ?? realWhois;

  const self = cfg.forceLocal ? null : await selfFn();

  // parseTrustedCidrs throws on a malformed or public range — surface that as
  // a refusal with its own message rather than a stack trace.
  let trustedCidrs: Cidr[];
  try { trustedCidrs = parseTrustedCidrs(cfg.trustedCidrSpec); }
  catch (e) { throw new AuthRefused(e instanceof Error ? e.message : String(e)); }

  if (!self && !isLoopbackHost(cfg.host) && trustedCidrs.length === 0) {
    throw new AuthRefused([
      cfg.forceLocal
        ? "CODETERM_LOCALHOST=1 serves this machine only, so it needs a loopback bind."
        : "No tailnet identity (`tailscale status --json` failed), and not bound to loopback.",
      "Refusing to start: that would be an ungated shell reachable with no authentication.",
      "Fixes: run tailscale · CODETERM_HOST=127.0.0.1 for localhost only ·",
      "       or CODETERM_TRUSTED_CIDRS=<your VPN subnet> and bind the tunnel interface.",
    ].join("\n"));
  }

  const mode: Auth["mode"] = self ? "tailnet" : trustedCidrs.length ? "cidr" : "localhost";

  // Origins a browser may legitimately be on. WebSockets have no same-origin
  // policy of their own, so without this any site you visit could open /pty.
  // localhost/127.0.0.1 are always present, which is what covers localhost mode.
  const allowedOrigins = new Set([
    ...[cfg.host, self?.dnsName, self?.dnsName?.split(".")[0], "localhost", "127.0.0.1", ...cfg.extraOrigins]
      .filter((h): h is string => typeof h === "string" && h !== "" && !h.includes("://"))
      .flatMap((h) => [`http://${h}:${cfg.port}`, `https://${h}:${cfg.port}`]),
    // Names you added yourself may sit behind a reverse proxy on 443/80, where
    // the browser's Origin carries no port at all; or be given as a full origin.
    ...cfg.extraOrigins.flatMap((h) => {
      if (h.includes("://")) { try { return [new URL(h).origin]; } catch { return []; } }
      return [`https://${h}`, `http://${h}`];
    }),
  ]);

  const first = (v: string | string[] | undefined) => Array.isArray(v) ? v[0] : v;

  /** Peer-identity half, shared by every route. */
  async function identityReason(req: PeerRequest): Promise<string | null> {
    const ip = normaliseIp(req.socket.remoteAddress ?? "");
    if (!ip) return "no peer address";
    if (isLoopback(ip)) return null;                    // same box — already has a shell
    if (ipInAny(ip, trustedCidrs)) return null;         // an explicitly trusted VPN subnet
    // Nothing left to authenticate a remote peer against.
    if (!self) return "localhost-only mode: only same-machine and trusted-CIDR connections are allowed";
    const who = await whois(ip, req.socket.remotePort ?? 0);
    if (!who) return `${ip} is not on this tailnet`;
    if (who.userId !== self.userId) return `${who.loginName} is not the owner`;
    return null;
  }

  async function denyReason(req: PeerRequest): Promise<string | null> {
    const origin = first(req.headers.origin);

    // A chrome-extension:// origin can never be a page on a website, so the
    // cross-site concern the Origin check exists for does not apply.
    if (typeof origin === "string" && origin.startsWith("chrome-extension://")) {
      if (cfg.extOrigin && origin !== cfg.extOrigin && !(cfg.extraExtOrigins?.() ?? []).includes(origin)) return `extension ${origin} is not the pinned one`;
      return identityReason(req);
    }
    // A simple cross-site request (<img>, form GET) carries no Origin, so the
    // check below never sees it — yet it issues from the authorised browser.
    // The browser sets Sec-Fetch-Site and page JS cannot forge it.
    if (first(req.headers["sec-fetch-site"]) === "cross-site") return "cross-site request";
    // Non-browser clients (curl) send no Origin; a browser always does.
    if (typeof origin === "string" && !allowedOrigins.has(origin)) return `origin ${origin}`;
    return identityReason(req);
  }

  function banner(): string[] {
    const out = [`identity       ${self ? `${self.dnsName} · tailnet user ${self.userId}` : "no tailnet identity"}`];
    out.push(`origins        ${[...allowedOrigins].join("  ")}`);
    if (mode === "localhost") out.push(`mode           localhost only — reachable from this machine, not the network`);
    if (mode === "cidr") out.push(`mode           trusted-CIDR only — no tailnet; peers authenticated by CODETERM_TRUSTED_CIDRS`);
    if (trustedCidrs.length) out.push(`trusted        ${cfg.trustedCidrSpec} (treated like loopback)`);
    return out;
  }

  return { mode, self, trustedCidrs, allowedOrigins, denyReason, banner };
}
