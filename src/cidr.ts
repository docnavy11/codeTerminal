/**
 * CIDR matching for the trusted-peer allowlist (CODETERM_TRUSTED_CIDRS).
 *
 * This is a security boundary: a peer whose address matches a trusted CIDR is
 * treated like loopback — fully authenticated, straight to an ungated shell.
 * So the parser is strict (reject anything it does not fully understand) and
 * every trusted range must sit inside private address space; a public CIDR is
 * refused at load, because trusting one is an open shell.
 *
 * No dependency: addresses are compared as BigInts. IPv4 and IPv6 (including
 * `::` compression and v4-mapped `::ffff:a.b.c.d`) are both handled.
 */
export type Cidr = { v: 4 | 6; base: bigint; bits: number };

const WIDTH = { 4: 32, 6: 128 } as const;

/** Parse an address to its numeric value and family, or null if malformed. */
export function parseIp(raw: string): { v: 4 | 6; n: bigint } | null {
  const ip = raw.trim();
  if (ip === "") return null;

  if (!ip.includes(":")) {
    const p = ip.split(".");
    if (p.length !== 4) return null;
    let n = 0n;
    for (const part of p) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const b = Number(part);
      if (b > 255) return null;
      n = (n << 8n) | BigInt(b);
    }
    return { v: 4, n };
  }

  // IPv6. A v4-mapped tail (::ffff:a.b.c.d) is rewritten to two hex groups so
  // the rest of the parse is pure IPv6.
  let head = ip;
  const lastColon = ip.lastIndexOf(":");
  const maybeV4 = ip.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = parseIp(maybeV4);
    if (!v4 || v4.v !== 4) return null;
    const hi = (v4.n >> 16n) & 0xffffn;
    const lo = v4.n & 0xffffn;
    head = ip.slice(0, lastColon + 1) + hi.toString(16) + ":" + lo.toString(16);
  }

  const halves = head.split("::");
  if (halves.length > 2) return null;          // more than one "::" is illegal

  const parseGroups = (str: string): bigint[] | null => {
    if (str === "") return [];
    const out: bigint[] = [];
    for (const g of str.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(BigInt(parseInt(g, 16)));
    }
    return out;
  };

  const left = parseGroups(halves[0]);
  const right = halves.length === 2 ? parseGroups(halves[1]) : null;
  if (left === null) return null;
  if (halves.length === 2 && right === null) return null;

  let groups: bigint[];
  if (halves.length === 2) {
    const fill = 8 - left.length - right!.length;
    if (fill < 1) return null;                 // "::" must stand for >=1 zero group
    groups = [...left, ...Array(fill).fill(0n), ...right!];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;

  let n = 0n;
  for (const g of groups) n = (n << 16n) | g;
  return { v: 6, n };
}

/** Parse "10.0.0.0/24" (bare address means a /32 or /128). */
/**
 * True for the address that means "every interface": 0.0.0.0 and ::, in any
 * spelling a resolver or parser accepts (::0, 0:0:0:0:0:0:0:0, ::ffff:0.0.0.0).
 */
export function isUnspecified(raw: string): boolean {
  const ip = parseIp(raw);
  if (!ip) return false;
  return ip.n === 0n || (ip.v === 6 && ip.n === 0xffff00000000n);
}

export function parseCidr(raw: string): Cidr | null {
  const [addr, bitsRaw, ...rest] = raw.trim().split("/");
  if (rest.length) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = WIDTH[ip.v];
  const bits = bitsRaw === undefined ? max : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  if (bitsRaw !== undefined && !/^\d{1,3}$/.test(bitsRaw)) return null;
  return { v: ip.v, base: maskOf(ip.n, bits, ip.v), bits };
}

function maskOf(n: bigint, bits: number, v: 4 | 6): bigint {
  const width = BigInt(WIDTH[v]);
  const host = width - BigInt(bits);
  return host === 0n ? n : (n >> host) << host;
}

/** Is `ip` inside `cidr`? Families must match. */
export function ipInCidr(ip: { v: 4 | 6; n: bigint }, cidr: Cidr): boolean {
  return ip.v === cidr.v && maskOf(ip.n, cidr.bits, cidr.v) === cidr.base;
}

export function ipInAny(raw: string, cidrs: Cidr[]): boolean {
  if (!cidrs.length) return false;
  const ip = parseIp(raw);
  if (!ip) return false;
  return cidrs.some((c) => ipInCidr(ip, c));
}

// Private / non-routable ranges. A trusted CIDR must sit entirely inside one of
// these — trusting a publicly routable range is an open shell.
const PRIVATE = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "100.64.0.0/10",        // CGNAT (also tailscale's range)
  "169.254.0.0/16",       // v4 link-local
  "127.0.0.0/8",          // loopback (pointless to trust, but not public)
  "fc00::/7",             // v6 unique-local (WireGuard's usual choice)
  "fe80::/10",            // v6 link-local
  "::1/128",
].map((c) => parseCidr(c)!);

function lastAddr(c: Cidr): bigint {
  const host = BigInt(WIDTH[c.v]) - BigInt(c.bits);
  return c.base + (host === 0n ? 0n : (1n << host) - 1n);
}

/** True only if every address in `c` falls inside one private super-range. */
export function isPrivateCidr(c: Cidr): boolean {
  const first = c.base, last = lastAddr(c);
  return PRIVATE.some((p) => p.v === c.v && p.base <= first && lastAddr(p) >= last);
}

/**
 * Parse the CODETERM_TRUSTED_CIDRS list. Throws on a malformed or public entry
 * so a misconfiguration fails the boot loudly rather than opening the shell.
 */
export function parseTrustedCidrs(spec: string | undefined): Cidr[] {
  const parts = (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const out: Cidr[] = [];
  for (const part of parts) {
    const c = parseCidr(part);
    if (!c) throw new Error(`CODETERM_TRUSTED_CIDRS: "${part}" is not a valid CIDR`);
    if (!isPrivateCidr(c)) {
      throw new Error(`CODETERM_TRUSTED_CIDRS: "${part}" is not a private range — refusing to trust a routable network`);
    }
    out.push(c);
  }
  return out;
}
