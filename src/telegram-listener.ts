/**
 * Two-way Telegram: a reply answers whichever card is open in the chat a
 * notification was about, or starts a new prompt there if nothing is open.
 *
 * Long-polling (`getUpdates`), on purpose, not a webhook: this server refuses
 * to bind 0.0.0.0 (see auth.ts), and a webhook needs Telegram's servers to
 * reach *in*. Polling stays outbound-only — the same posture as everything
 * else here, just for reading instead of only sending. Only messages from
 * the configured chat id are ever acted on; anyone else's DM to the bot is
 * dropped, silently beyond one warning.
 *
 * A reply is bound to a chat precisely when it replies (Telegram's own
 * swipe-to-reply) to a message this box sent about that chat — tracked here,
 * live-only and capped, the same "cheap to lose, wrong to resurrect" rule
 * watches.ts uses for its own live-only state. A plain message with no
 * reply falls back to whichever chat was last mentioned. Updates already
 * queued on Telegram's side when this starts are drained, so they stop
 * piling up, but never acted on — a reply to a card from before a restart
 * has nothing left to resolve, and the card it meant is long since denied.
 */
import type { Manager } from "./conversation.js";

export type TelegramListenerDeps = {
  convo: Manager;
  token: string;
  chatId: string;
  fetch?: typeof fetch;
  log?: (l: string) => void;
  warn?: (l: string) => void;
};

type TgMessage = {
  message_id: number;
  date: number;
  text?: string;
  chat: { id: number | string };
  reply_to_message?: { message_id: number };
};
type TgUpdate = { update_id: number; message?: TgMessage };

/** Sent-message-id → chat-id tracking, same live-only cap shape as WatchRegistry's MAX_ACTIVE. */
const MAX_TRACKED = 200;
const POLL_TIMEOUT_S = 50;

export class TelegramListener {
  #d: TelegramListenerDeps;
  #fetch: typeof fetch;
  #log: (l: string) => void;
  #warn: (l: string) => void;
  #stopped = false;
  #offset: number | undefined;
  #sentTo = new Map<number, string>();
  #lastChatId: string | undefined;
  #startedAt: number;
  #loop: Promise<void> | null = null;

  constructor(d: TelegramListenerDeps) {
    this.#d = d;
    this.#fetch = d.fetch ?? fetch;
    this.#log = d.log ?? (() => {});
    this.#warn = d.warn ?? (() => {});
    this.#startedAt = Date.now() / 1000;
  }

  /** Called after every notify.send() that named a chat, so a reply — bound
      precisely, or, failing that, a plain message — has somewhere to land. */
  noteSent(telegramMessageId: number | undefined, chatId: string): void {
    this.#lastChatId = chatId;
    if (telegramMessageId === undefined) return;
    this.#sentTo.set(telegramMessageId, chatId);
    if (this.#sentTo.size > MAX_TRACKED) {
      const oldest = this.#sentTo.keys().next().value;
      if (oldest !== undefined) this.#sentTo.delete(oldest);
    }
  }

  start(): void { if (!this.#loop) this.#loop = this.#run(); }
  async stop(): Promise<void> { this.#stopped = true; await this.#loop; }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      let updates: TgUpdate[];
      try {
        const params = new URLSearchParams({ timeout: String(POLL_TIMEOUT_S) });
        if (this.#offset !== undefined) params.set("offset", String(this.#offset));
        const controller = new AbortController();
        const abort = setTimeout(() => controller.abort(), (POLL_TIMEOUT_S + 10) * 1000);
        let r: Response;
        try {
          r = await this.#fetch(`https://api.telegram.org/bot${this.#d.token}/getUpdates?${params}`, { signal: controller.signal });
        } finally { clearTimeout(abort); }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = await r.json() as { ok: boolean; result?: TgUpdate[] };
        updates = body.result ?? [];
      } catch (e) {
        if (this.#stopped) return;
        this.#warn(`[telegram] getUpdates: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(5000);
        continue;
      }
      for (const u of updates) {
        this.#offset = u.update_id + 1;
        const m = u.message;
        if (!m?.text || String(m.chat.id) !== String(this.#d.chatId)) continue;
        if (m.date < this.#startedAt) continue;   // draining a pre-restart backlog, not acting on it
        await this.#handle(m).catch((e) => this.#warn(`[telegram] ${e instanceof Error ? e.message : String(e)}`));
      }
      // getUpdates normally only returns once its own 50s block finds
      // something. An empty result arriving faster than that — a mocked
      // backend, or Telegram returning early — would otherwise spin this
      // loop as fast as promises resolve.
      if (!updates.length && !this.#stopped) await sleep(50);
    }
  }

  async #handle(m: TgMessage): Promise<void> {
    const text = m.text!;
    const chatId = (m.reply_to_message && this.#sentTo.get(m.reply_to_message.message_id)) || this.#lastChatId;
    if (!chatId) { await this.#reply("Nothing to reply to yet — a schedule needs to notify you about a chat first."); return; }
    const chat = this.#d.convo.get(chatId);
    if (!chat) { await this.#reply("That chat is gone."); return; }
    const resolved = chat.session.resolveOldestPending(text);
    if (resolved === "answered") { this.#log(`[telegram] resolved a pending card in ${chatId}`); await this.#reply("✓ done."); return; }
    if (resolved === "unclear") { await this.#reply("Reply yes, always, or no to answer that one."); return; }
    try {
      await chat.prompt(text, async () => undefined);
      this.#log(`[telegram] new prompt in ${chatId}`);
      // Only a scheduled run's own end notifies on its own (schedule-run.ts);
      // a prompt sent this way has no such hook, so say so rather than leave
      // you assuming a silent phone means nothing happened yet.
      await this.#reply("Sent — this chat only notifies you at the end if it's a scheduled run. Open the app to see the reply.");
    } catch (e) { await this.#reply(e instanceof Error ? e.message : String(e)); }
  }

  async #reply(text: string): Promise<void> {
    try {
      await this.#fetch(`https://api.telegram.org/bot${this.#d.token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: this.#d.chatId, text }),
      });
    } catch { /* best effort — a failed courtesy reply is not worth surfacing */ }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
