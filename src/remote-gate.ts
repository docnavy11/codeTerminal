import { randomUUID } from "node:crypto";
import type { ClientEvent } from "./protocol.js";
import type { BrowserPolicy, SubmitDetail } from "./tools.js";
import { levelCovers, type BrowserAllowlist, type Level } from "./browser-allow.js";

/**
 * The site gate for browser tools used from outside a chat: a Claude Code
 * session in tmux, over /mcp/browser. A chat asks in its own transcript;
 * here there is no transcript, so a card goes to every connected side panel
 * at once, above whatever chat is open, and the call waits on it.
 *
 * "Allow" lasts until codeTerminal restarts and covers every terminal session
 * (the MCP endpoint is stateless and cannot tell them apart); "Always" adds
 * the site to the standing list, as in a chat. Nobody answering within the
 * wait is a "no".
 */
export const REMOTE_WAIT_MS = 5 * 60_000;

type Card = { event: Extract<ClientEvent, { kind: "approval" }>; resolve: (d: "allow" | "always" | "deny") => void; timer: NodeJS.Timeout };

export class RemoteGate {
  #cards = new Map<string, Card>();
  #grants = new Map<string, Level>();
  #evalGrants = new Set<string>();
  #allow: BrowserAllowlist | null;
  #send: (e: ClientEvent) => void;
  #waitMs: number;
  /** Called when a card goes up, with a line saying what it asks. */
  onAsk: (what: string) => void = () => {};

  constructor(allow: BrowserAllowlist | null, send: (e: ClientEvent) => void, waitMs = REMOTE_WAIT_MS) {
    this.#allow = allow; this.#send = send; this.#waitMs = waitMs;
  }

  /** The cards still open, for a client that connects while one is up. */
  pending(): ClientEvent[] { return [...this.#cards.values()].map((c) => c.event); }
  has(id: string): boolean { return this.#cards.has(id); }

  decide(id: string, decision: "allow" | "always" | "deny"): void {
    const c = this.#cards.get(id);
    if (!c) return;
    this.#cards.delete(id);
    clearTimeout(c.timer);
    this.#send({ kind: "approval_closed", id, decision });
    c.resolve(decision);
  }

  #ask(tool: string, input: Record<string, unknown>, canAlways: boolean, what: string): Promise<"allow" | "always" | "deny"> {
    const id = randomUUID();
    const event = { kind: "approval" as const, id, tool, input: { ...input, origin: "terminal" }, canAlways };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.#cards.delete(id)) return;
        this.#send({ kind: "approval_closed", id, decision: "gone" });
        resolve("deny");
      }, this.#waitMs);
      timer.unref?.();
      this.#cards.set(id, { event, resolve, timer });
      this.#send(event);
      this.onAsk(what);
    });
  }

  /** Without a standing list the gate is off, as it is for chats. */
  policy(): BrowserPolicy | undefined {
    const allow = this.#allow;
    if (!allow) return undefined;
    return {
      allowed: (host, level) => { const g = this.#grants.get(host); return (g !== undefined && levelCovers(g, level)) || allow.has(host, level); },
      evalAllowed: (host) => this.#evalGrants.has(host),
      ask: async (host, action, detail, level) => {
        const d = await this.#ask("browser", { host, action, level, ...(detail ? { detail } : {}) }, true, `${action} on ${host} (${level})`);
        if (d === "deny") return "deny";
        // eval: "Allow once" is this call; "on this site" is eval + act on the
        // host until restart — never the standing list, as in a chat.
        const grant = (l: Level) => { const g = this.#grants.get(host); if (!g || !levelCovers(g, l)) this.#grants.set(host, l); };
        if (action === "eval") { if (d === "always") { this.#evalGrants.add(host); grant("act"); } return "allow"; }
        if (d === "always") allow.add(host, level);
        else grant(level);
        return "allow";
      },
    };
  }

  confirmSubmit = async (detail: SubmitDetail): Promise<boolean> =>
    (await this.#ask("submit", detail as unknown as Record<string, unknown>, false, `submit to ${detail.host}`)) !== "deny";
}
