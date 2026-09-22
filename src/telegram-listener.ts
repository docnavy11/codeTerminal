/**
 * Two-way Telegram: a reply answers whichever card is open in the chat a
 * notification was about, or prompts it if nothing is open. With nothing to
 * bind to — the first message, or one that has drifted past what was last
 * mentioned — it lands in one standing chat, "Telegram", created on first
 * use and reused after: a conversation with the agent that lives entirely
 * on the phone, no browser required. That chat runs permanently unattended
 * (see conversation.ts/session.ts) — a card it raises is announced and
 * answerable the same way a scheduled run's is — and its own turns are
 * pushed back here when they end, so it is a real two-way chat, not a
 * one-shot command line.
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
 * reply falls back to whichever chat was last mentioned, and only then to
 * the standing chat. Updates already queued on Telegram's side when this
 * starts are drained, so they stop piling up, but never acted on — a reply
 * to a card from before a restart has nothing left to resolve, and the card
 * it meant is long since denied.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Manager, LiveChat } from "./conversation.js";
import type { Notifier } from "./notify.js";

export type TelegramListenerDeps = {
  convo: Manager;
  notifier: Notifier;
  token: string;
  chatId: string;
  /** The standing chat's own notifications link back into it, same as a schedule's do. */
  publicBase: string;
  /** Loopback address this server answers its own API on — always trusted
      regardless of network mode (see auth.ts), so the standing chat's own
      curl calls need no token. */
  apiBase: string;
  /** cwd for the standing chat: nothing but a CLAUDE.md (written on first
      use) telling it how to look up this server's own schedules/chats/
      prompts. A person's actual project directories are never touched. */
  contextDir: string;
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
/** Found by title, not a stored id: self-healing if the chat is ever deleted
    (the next message just makes a new one), at the cost of a name collision
    being a real, if unlikely, way to hijack it — same trust boundary as
    everything else here, which already trusts this one Telegram chat. */
const TELEGRAM_CHAT_TITLE = "Telegram";
/** Mirrors schedule.ts's own default (600_000 = 10 minutes) — this chat is
    unattended the same way a scheduled run is, so it gets the same wait. */
const TELEGRAM_WAIT_MS = 600_000;

/** Claude Code reads CLAUDE.md from a chat's cwd on every turn, unprompted —
    this is the whole mechanism, no custom tool needed. Loopback needs no
    token (see auth.ts's isLoopback rule), so a plain curl is enough; the
    approval gate still covers the one POST here exactly as it would if a
    person typed the same curl themselves. */
const CONTEXT_MD = (apiBase: string) => `# The standing Telegram chat

This is the chat a phone text lands in when nothing more specific was meant
— an ordinary conversation, with one thing worth knowing: this server's own
state is one curl away, on loopback, no auth needed.

- \`curl -s ${apiBase}/schedules\` — scheduled prompts (title, when, project,
  last run), plus the saved prompts and projects they can use
- \`curl -s ${apiBase}/chats\` — every conversation on this server
- \`curl -s ${apiBase}/prompts\` — saved prompts
- \`curl -s ${apiBase}/projects\` — configured projects

Pipe through \`python3 -m json.tool\` for readability. If asked to run a
schedule now rather than wait for its own time, that is
\`curl -X POST ${apiBase}/schedules/<id>/run\` — the ordinary approval gate
covers it exactly as it would a person typing the same curl.
`;

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
  /** Which live LiveChat *instances* already have the standing chat's wiring
      (setUnattended + a turn-end watcher) attached. A WeakSet, not a Set of
      ids: the pool evicts and re-admits a chat as a fresh object, and the
      fresh one needs rewiring — an id-keyed set would wrongly skip it. */
  #wired = new WeakSet<LiveChat>();

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

  start(): void {
    if (this.#loop) return;
    this.#writeContext();
    this.#loop = this.#run();
  }

  /** The standing chat's whole self-awareness: a CLAUDE.md, read automatically
      on every turn, telling it how to look up this server's own state. Written
      once at start, not per-chat — cheap, static content, and a restart on
      updated code should refresh it rather than leave an old copy in place. */
  #writeContext(): void {
    try {
      mkdirSync(this.#d.contextDir, { recursive: true });
      writeFileSync(join(this.#d.contextDir, "CLAUDE.md"), CONTEXT_MD(this.#d.apiBase), "utf8");
    } catch (e) {
      this.#warn(`[telegram] could not write the standing chat's context: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
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
    const targetId = (m.reply_to_message && this.#sentTo.get(m.reply_to_message.message_id)) || this.#lastChatId;
    const targeted = targetId ? this.#d.convo.get(targetId) : null;
    const chat = targeted ?? await this.#standingChat();

    const resolved = chat.session.resolveOldestPending(text);
    if (resolved === "answered") { this.#log(`[telegram] resolved a pending card in ${chat.id}`); await this.#reply("✓ done."); return; }
    if (resolved === "unclear") { await this.#reply("Reply yes, always, or no to answer that one."); return; }
    try {
      await chat.prompt(text, async () => undefined);
      this.#log(`[telegram] new prompt in ${chat.id}`);
      // No ack here on purpose: the standing chat's own wiring pushes the
      // real reply back when the turn ends, which is the confirmation. A
      // chat reached by falling back to what was last mentioned has no such
      // hook — a scheduled run's own end notifies separately — but a silent
      // phone is still better than a message that goes stale (the prompt
      // sent, then nothing, forever "check the app" for a reply that came
      // and went minutes ago).
    } catch (e) { await this.#reply(e instanceof Error ? e.message : String(e)); }
  }

  /** Find-or-create the one standing "Telegram" chat, and make sure this
      particular live instance of it is wired — idempotent per instance, so
      calling it on every message is the whole mechanism, not just the setup. */
  async #standingChat(): Promise<LiveChat> {
    const existing = this.#d.convo.list().find((c) => c.title === TELEGRAM_CHAT_TITLE);
    const chat = (existing && this.#d.convo.get(existing.id)) || await this.#createStandingChat();
    // Self-healing, not just set-at-creation: a chat made before this mode
    // default shipped, or one a person switched back to Ask from the app,
    // is corrected the next time Telegram actually uses it — no migration
    // script, no manual fix, and mode is a persisted field (unlike the
    // live-only wiring below), so this only ever runs once per real change.
    // "Ask before changes" with no browser tab to click Allow on is a dead
    // end — every ordinary command becomes a card, exactly what happened
    // the first time this shipped (measured: a job-search schedule's own
    // diagnosis over Telegram stalled on repeated plain "Bash" approvals).
    // Auto — the same default schedule.ts itself gives a new schedule —
    // lets the CLI's own judgement clear routine work; anything it is not
    // sure about still raises a card, announced and answerable as always.
    if (chat.mode !== "auto") await chat.setMode("auto");
    if (!this.#wired.has(chat)) { this.#wired.add(chat); this.#wireStandingChat(chat); }
    return chat;
  }

  async #createStandingChat(): Promise<LiveChat> {
    const chat = this.#d.convo.create();
    chat.rename(TELEGRAM_CHAT_TITLE);
    // A fresh session, never busy, so setCwd cannot hit its "finish the
    // current turn first" guard — safe to await unconditionally here.
    await chat.setCwd(this.#d.contextDir);
    return chat;
  }

  /** Permanently unattended, the same way a scheduled run's chat is while it
      runs — except this chat never stops being unattended, because nothing
      else is ever watching it live. A card it raises is announced and
      answerable exactly like a scheduled run's; its ordinary replies are
      pushed back on every turn end, which is the "and it responds" this
      whole standing chat exists for. */
  #wireStandingChat(chat: LiveChat): void {
    const url = `${this.#d.publicBase}/?chat=${encodeURIComponent(chat.id)}`;
    chat.setUnattended({
      waitMs: TELEGRAM_WAIT_MS,
      onEvent: (kind, detail) => {
        if (kind !== "asked") return;
        void this.#d.notifier.send({ title: "Telegram — waiting for you", message: `${detail}\n\nReply here to answer.`, url })
          .then((r) => this.noteSent(r.telegramMessageId, chat.id));
      },
    });
    let lastText = "";
    chat.attach((e) => {
      if (e.kind === "user") lastText = "";
      else if (e.kind === "text") lastText = e.text;
      else if (e.kind === "turn_end") {
        void this.#d.notifier.send({ title: "Telegram", message: lastText || "(no reply)", url })
          .then((r) => this.noteSent(r.telegramMessageId, chat.id));
      }
    }, false);
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
