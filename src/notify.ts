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

  /** Send to every target; resolves with what was delivered and what failed. Never rejects.
      telegramMessageId, when present, is the sent message's own id — the two-way listener
      (src/telegram-listener.ts) tracks it, so a reply to this exact message is bound back
      to whichever chat the caller passes as the notice's subject. */
  async send(n: Notice): Promise<{ sent: string[]; failed: { target: string; error: string }[]; telegramMessageId?: number }> {
    const sent: string[] = []; const failed: { target: string; error: string }[] = [];
    let telegramMessageId: number | undefined;
    const jobs: Promise<void>[] = [];
    if (this.#c.telegram) jobs.push(this.#telegram(n).then((id) => { sent.push("telegram"); telegramMessageId = id; }, (e) => { failed.push({ target: "telegram", error: String(e?.message ?? e) }); }));
    if (this.#c.webhook) jobs.push(this.#webhook(n).then(() => { sent.push(this.#c.webhook!.format === "ntfy" ? "ntfy" : "webhook"); }, (e) => { failed.push({ target: "webhook", error: String(e?.message ?? e) }); }));
    await Promise.all(jobs);
    for (const f of failed) this.#warn(`[notify] ${f.target}: ${f.error}`);
    if (sent.length) this.#log(`[notify] ${n.title} → ${sent.join(", ")}`);
    return { sent, failed, ...(telegramMessageId !== undefined ? { telegramMessageId } : {}) };
  }

  async #telegram(n: Notice): Promise<number | undefined> {
    const { token, chatId } = this.#c.telegram!;
    // In order: a long message arrives as parts that read top to bottom. The
    // id returned is the last part's, the one a reply naturally answers.
    let id: number | undefined;
    for (const text of telegramTexts(n)) {
      const r = await withTimeout(this.#fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "MarkdownV2", disable_web_page_preview: true }),
      }));
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      // Best effort: a reply not being bindable to this exact message is a smaller loss than
      // treating a malformed-but-200 response as a failed send.
      const body = await r.json().catch(() => null) as { result?: { message_id?: number } } | null;
      id = body?.result?.message_id ?? id;
    }
    return id;
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

/** Telegram refuses a message longer than this. */
const TELEGRAM_MAX = 4096;
/** Past this many parts the rest is cut: a notification, not a transcript. */
const TELEGRAM_MAX_PARTS = 5;

/**
 * A notice as MarkdownV2 messages, each within Telegram's limit. The text
 * used to be escaped and then cut to 4000, which could split a `\.` pair
 * (a lone trailing backslash: Telegram rejects the message) and always cut
 * the chat link off a long one. Now the raw text is cut and each piece
 * escaped, so every message is valid on its own, and every one carries the
 * title (numbered when there are several) and the link.
 */
export function telegramTexts(n: Notice): string[] {
  // Title and link are short in practice; bounded here so the body always has room.
  const title = Array.from(n.title).slice(0, 256).join("");
  const link = n.url && n.url.length <= 1024 ? `\n${escapeMd(n.url)}` : "";
  const head = (i: number, of: number) => `*${escapeMd(of > 1 ? `${title} (${i}/${of})` : title)}*\n`;
  const more = escapeMd("…");
  // Room for the longest header ("(5/5)"), the link and a cut marker.
  const room = TELEGRAM_MAX - head(TELEGRAM_MAX_PARTS, TELEGRAM_MAX_PARTS).length - link.length - more.length;
  const chars = Array.from(n.message);   // code points: never split a surrogate pair either
  const parts: string[] = [];
  let i = 0;
  while (i < chars.length && parts.length < TELEGRAM_MAX_PARTS) {
    let used = 0, j = i, lastBreak = -1;
    while (j < chars.length) {
      const w = escapeMd(chars[j]).length;
      if (used + w > room) break;
      used += w; j++;
      if (chars[j - 1] === "\n") lastBreak = j;
    }
    // Prefer to end a part at a line break, if one falls in its second half.
    if (j < chars.length && lastBreak > i + (j - i) / 2) j = lastBreak;
    parts.push(chars.slice(i, j).join(""));
    i = j;
  }
  const cut = i < chars.length;
  if (!parts.length) parts.push("");
  return parts.map((p, k) => head(k + 1, parts.length) + escapeMd(p) + (cut && k === parts.length - 1 ? more : "") + link);
}

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
