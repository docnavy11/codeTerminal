/**
 * Notifications that reach a phone: a scheduled run finished, or (later)
 * Claude needs you while you are away. Two targets, both optional, both
 * from .env: a Telegram bot, and a webhook (plain JSON, or ntfy's shape —
 * which also covers a Home Assistant webhook automation). Nothing here
 * throws into the caller: a target that fails is logged and skipped.
 */
export type Notice = { title: string; message: string; url?: string; tags?: string[] };

export type NotifyConfig = {
  telegram?: { token: string; chatId: string };
  webhook?: { url: string; format: "json" | "ntfy"; token?: string };
  fetch?: typeof fetch;
  warn?: (l: string) => void;
  log?: (l: string) => void;
};

export class Notifier {
  #c: NotifyConfig;
  #fetch: typeof fetch;
  #warn: (l: string) => void;
  #log: (l: string) => void;
  constructor(c: NotifyConfig = {}) { this.#c = c; this.#fetch = c.fetch ?? fetch; this.#warn = c.warn ?? (() => {}); this.#log = c.log ?? (() => {}); }

  get targets(): string[] { return [...(this.#c.telegram ? ["telegram"] : []), ...(this.#c.webhook ? [this.#c.webhook.format === "ntfy" ? "ntfy" : "webhook"] : [])]; }

  /** Send to every target; resolves with what was delivered and what failed. Never rejects. */
  async send(n: Notice): Promise<{ sent: string[]; failed: { target: string; error: string }[] }> {
    const sent: string[] = []; const failed: { target: string; error: string }[] = [];
    const jobs: Promise<void>[] = [];
    if (this.#c.telegram) jobs.push(this.#telegram(n).then(() => { sent.push("telegram"); }, (e) => { failed.push({ target: "telegram", error: String(e?.message ?? e) }); }));
    if (this.#c.webhook) jobs.push(this.#webhook(n).then(() => { sent.push(this.#c.webhook!.format === "ntfy" ? "ntfy" : "webhook"); }, (e) => { failed.push({ target: "webhook", error: String(e?.message ?? e) }); }));
    await Promise.all(jobs);
    for (const f of failed) this.#warn(`[notify] ${f.target}: ${f.error}`);
    if (sent.length) this.#log(`[notify] ${n.title} → ${sent.join(", ")}`);
    return { sent, failed };
  }

  async #telegram(n: Notice): Promise<void> {
    const { token, chatId } = this.#c.telegram!;
    const text = `*${escapeMd(n.title)}*\n${escapeMd(n.message)}${n.url ? `\n${escapeMd(n.url)}` : ""}`.slice(0, 4000);
    const r = await withTimeout(this.#fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
    }));
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  }

  async #webhook(n: Notice): Promise<void> {
    const { url, format, token } = this.#c.webhook!;
    const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
    let body: string;
    if (format === "ntfy") {
      headers["content-type"] = "text/plain; charset=utf-8"; headers.title = n.title.replace(/[^\x20-\x7e]/g, "?");
      if (n.tags?.length) headers.tags = n.tags.join(","); if (n.url) headers.click = n.url;
      body = n.message;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify({ title: n.title, message: n.message, url: n.url ?? null, tags: n.tags ?? [], at: new Date().toISOString() });
    }
    const r = await withTimeout(this.#fetch(url, { method: "POST", headers, body }));
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  }
}

/** Telegram's MarkdownV2 wants every one of these escaped. */
export function escapeMd(s: string): string { return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`); }

function withTimeout<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });
}

/** Targets from the environment; none set = a Notifier with no targets (send is a no-op). */
export function notifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Pick<NotifyConfig, "telegram" | "webhook"> {
  const c: Pick<NotifyConfig, "telegram" | "webhook"> = {};
  if (env.CODETERM_TELEGRAM_TOKEN && env.CODETERM_TELEGRAM_CHAT) c.telegram = { token: env.CODETERM_TELEGRAM_TOKEN, chatId: env.CODETERM_TELEGRAM_CHAT };
  if (env.CODETERM_NOTIFY_WEBHOOK) c.webhook = { url: env.CODETERM_NOTIFY_WEBHOOK, format: env.CODETERM_NOTIFY_WEBHOOK_FORMAT === "ntfy" || /ntfy\.sh\//.test(env.CODETERM_NOTIFY_WEBHOOK) ? "ntfy" : "json", ...(env.CODETERM_NOTIFY_WEBHOOK_TOKEN ? { token: env.CODETERM_NOTIFY_WEBHOOK_TOKEN } : {}) };
  return c;
}
