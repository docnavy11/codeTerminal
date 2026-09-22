import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramListener } from "../src/telegram-listener.js";
import { Notifier } from "../src/notify.js";
import type { Manager, LiveChat } from "../src/conversation.js";

/**
 * TelegramListener against a fake Telegram (fetch) and a fake Manager (just
 * enough of LiveChat — session/.prompt/.rename/.setUnattended/.attach — to
 * exercise routing and the standing chat's wiring) — the real Manager and a
 * real SDK subprocess are exactly what this file does not need to prove
 * which chat a reply lands in, and what it does there.
 */
type Resolved = "answered" | "unclear" | "none";
type Row = { title: string; resolve?: Resolved; promptErr?: string; prompts: string[]; attachCalls: number; asked?: (kind: string, detail: string) => void; emit?: (e: { kind: string; text?: string }) => void; cwd?: string; mode?: string; busy?: boolean; interrupted?: number };

function fakeConvo(seed: Record<string, { resolve?: Resolved; promptErr?: string }> = {}) {
  const rows = new Map<string, Row>();
  const objs = new Map<string, LiveChat>();
  const resolvedLog: string[] = [];
  let nextId = 0;
  for (const [id, cfg] of Object.entries(seed)) rows.set(id, { title: id, ...cfg, prompts: [] as string[], attachCalls: 0 });

  const objFor = (id: string): LiveChat => {
    if (objs.has(id)) return objs.get(id)!;
    const obj = {
      get id() { return id; },
      get title() { return rows.get(id)!.title; },
      get record() { return { title: rows.get(id)!.title }; },
      get unattended() { return rows.get(id)!.asked !== undefined; },
      get mode() { return rows.get(id)!.mode ?? "default"; },
      rename(t: string) { rows.get(id)!.title = t; return true; },
      async setCwd(abs: string) { rows.get(id)!.cwd = abs; },
      async setMode(m: string) { rows.get(id)!.mode = m; },
      get busy() { return rows.get(id)!.busy ?? false; },
      session: {
        interrupt: async () => { rows.get(id)!.interrupted = (rows.get(id)!.interrupted ?? 0) + 1; },
        resolveOldestPending: (text: string) => {
          const row = rows.get(id)!;
          const r: Resolved = row.resolve ?? "none";
          if (r === "answered") resolvedLog.push(`${id}:${text}`);
          return r;
        },
      },
      async prompt(text: string) {
        const row = rows.get(id)!;
        if (row.promptErr) throw new Error(row.promptErr);
        row.prompts.push(text);
      },
      setUnattended(cfg: { onEvent: (kind: string, detail: string) => void } | null) { rows.get(id)!.asked = cfg?.onEvent; },
      attach(fn: (e: { kind: string; text?: string }) => void) { rows.get(id)!.attachCalls++; rows.get(id)!.emit = fn; },
      detach(fn: (e: { kind: string; text?: string }) => void) { if (rows.get(id)!.emit === fn) rows.get(id)!.emit = undefined; },
    } as unknown as LiveChat;
    objs.set(id, obj);
    return obj;
  };

  const convo = {
    get(id: string) { return rows.has(id) ? objFor(id) : null; },
    list() { return [...rows.entries()].map(([id, r]) => ({ id, title: r.title })); },
    create() { const id = `new-${nextId++}`; rows.set(id, { title: "New chat", prompts: [], attachCalls: 0 }); return objFor(id); },
  } as unknown as Manager;

  return { convo, rows, resolvedLog, prompts: (id: string) => rows.get(id)?.prompts ?? [] };
}

/** One update batch, served once, then empty forever (idles the poll loop quietly). */
function fakeTelegramFetch(updates: unknown[]) {
  const sent: { chat_id: string; text: string }[] = [];
  let servedUpdates = false;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("/getUpdates")) {
      const body = servedUpdates ? { ok: true, result: [] } : { ok: true, result: updates };
      servedUpdates = true;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (s.includes("/sendMessage")) {
      sent.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + sent.length } }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, sent };
}

const NOW_S = Math.floor(Date.now() / 1000);
const settle = () => new Promise((r) => setTimeout(r, 30));
const msg = (text: string, extra: Partial<{ reply_to_message: { message_id: number } }> = {}) =>
  ({ update_id: 1, message: { message_id: 10, date: NOW_S + 5, text, chat: { id: "9" }, ...extra } });

function build(updates: unknown[], seed: Record<string, { resolve?: Resolved; promptErr?: string }> = {}, contextDir = mkdtempSync(join(tmpdir(), "ct-tg-"))) {
  const { convo, rows, resolvedLog, prompts } = fakeConvo(seed);
  const { fetchFn, sent } = fakeTelegramFetch(updates);
  const notifier = new Notifier({ telegram: { token: "T", chatId: "9" }, fetch: fetchFn });
  const l = new TelegramListener({ convo, notifier, token: "T", chatId: "9", publicBase: "http://x", apiBase: "http://127.0.0.1:8123", contextDir, fetch: fetchFn });
  return { l, rows, resolvedLog, prompts, sent, contextDir };
}

describe("TelegramListener", () => {
  test("a message from someone else's chat id is dropped", async () => {
    const { l, rows, resolvedLog, sent } = build([{ update_id: 1, message: { message_id: 1, date: NOW_S + 5, text: "hi", chat: { id: "666" } } }]);
    l.start(); await settle(); await l.stop();
    assert.equal(rows.size, 0, "no standing chat, no anything — the message was never read");
    assert.deepEqual(resolvedLog, []); assert.deepEqual(sent, []);
  });

  test("a reply to a tracked notification resolves that exact chat's pending card", async () => {
    const { l, resolvedLog, prompts, sent } = build([{ ...msg("yes", { reply_to_message: { message_id: 555 } }) }], { "chat-a": { resolve: "answered" }, "chat-b": { resolve: "answered" } });
    l.noteSent(555, "chat-a");
    l.noteSent(556, "chat-b");   // a second tracked message — proves binding is by message id, not "most recent"
    l.start(); await settle(); await l.stop();
    assert.deepEqual(resolvedLog, ["chat-a:yes"]);
    assert.deepEqual(prompts("chat-a"), [], "resolved, not sent as a fresh prompt");
    assert.equal(sent[0].text, "✓ done.");
  });

  test("a plain message with no reply falls back to the last chat mentioned, over the standing chat, silently", async () => {
    const { l, prompts, sent } = build([msg("check the site again")], { "chat-a": {}, "chat-b": {} });
    l.noteSent(1, "chat-a"); l.noteSent(2, "chat-b");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(prompts("chat-b"), ["check the site again"], "chat-b was noteSent last");
    assert.deepEqual(sent, [], "no ack — a stale 'sent' message would outlive the run it describes");
  });

  test("nothing tracked: the standing 'Telegram' chat is created and used", async () => {
    const { l, rows, prompts, sent } = build([msg("hello there")]);
    l.start(); await settle(); await l.stop();
    const [id] = [...rows.keys()];
    assert.equal(rows.get(id)!.title, "Telegram");
    assert.deepEqual(prompts(id), ["hello there"]);
    assert.equal(sent.length, 0, "the standing chat's own turn-end push is the reply, not an extra ack");
  });

  test("the standing chat's cwd gets a CLAUDE.md pointing at this server's own API, on start — before any message", async () => {
    const contextDir = mkdtempSync(join(tmpdir(), "ct-tg-"));
    const { l, rows } = build([msg("what can you see?")], {}, contextDir);
    l.start();
    // Written synchronously inside start(), so this is already true before any message is handled.
    const md = readFileSync(join(contextDir, "CLAUDE.md"), "utf8");
    assert.match(md, /http:\/\/127\.0\.0\.1:8123\/schedules/);
    assert.match(md, /http:\/\/127\.0\.0\.1:8123\/chats/);
    await settle(); await l.stop();
    const [, row] = [...rows.entries()][0];
    assert.equal(row.cwd, contextDir, "the standing chat's own cwd is set to it, so it's read every turn");
    assert.equal(row.mode, "auto", "Ask before changes with nobody watching a browser tab is a dead end — same default schedule.ts itself uses");
    rmSync(contextDir, { recursive: true, force: true });
  });

  test("a standing chat made before this mode default shipped is corrected on next use, not left stuck on Ask", async () => {
    const { l, rows } = build([msg("still there?")]);
    // Seed a pre-existing "Telegram" chat the way an older install's would
    // look: found by title, never touched by setMode.
    rows.set("old-telegram-chat", { title: "Telegram", mode: "default", prompts: [], attachCalls: 0 });
    l.start(); await settle(); await l.stop();
    const row = rows.get("old-telegram-chat")!;
    assert.equal(row.mode, "auto", "fixed in place — no new chat was created, no migration needed");
    assert.deepEqual(row.prompts, ["still there?"]);
    assert.equal(rows.size, 1, "reused the existing chat, not a second one");
  });

  test("the standing chat is reused by title, and only wired (setUnattended/attach) once across messages", async () => {
    const { l, rows } = build([msg("first"), { ...msg("second"), update_id: 2 }]);
    l.start(); await settle(); await l.stop();
    assert.equal(rows.size, 1, "one chat, not one per message");
    const [row] = rows.values();
    assert.equal(row.prompts.length, 2);
    assert.equal(row.attachCalls, 1, "wiring is per live instance, not per message");
  });

  test("the standing chat's own card asks notify Telegram and bind the reply back to it", async () => {
    const { l, rows, sent } = build([msg("do the risky thing")]);
    l.start(); await settle();
    const [, row] = [...rows.entries()][0];
    row.asked!("asked", "Bash: risky command?");
    await settle(); await l.stop();
    // MarkdownV2-escaped by Notifier (see test/notify.test.ts) — match past that, not the raw text.
    const ask = sent.find((s) => s.text.includes("waiting for you") && s.text.includes("risky command"));
    assert.ok(ask, "the card was announced");
    assert.match(ask!.text, /Reply here to answer/);
    assert.match(ask!.text, /chat\\=new\\-0/, "links back into the standing chat");
  });

  test("the standing chat's own turn end pushes the reply back, and a further reply binds to it", async () => {
    const { l, rows, sent } = build([msg("what's the weather")]);
    l.start(); await settle();
    const [, row] = [...rows.entries()][0];
    row.emit!({ kind: "user" });
    row.emit!({ kind: "text", text: "Sunny, 22°C." });
    row.emit!({ kind: "turn_end" });
    await settle(); await l.stop();
    const reply = sent.find((s) => s.text.includes("Sunny"));
    assert.ok(reply, "the turn's own reply text was pushed back");
    assert.match(reply!.text, /chat\\=new\\-0/);
  });

  test("an unclear reply to a plain permission card is left open, not guessed on, and not routed to the standing chat", async () => {
    const { l, resolvedLog, prompts, sent } = build([msg("hmm not sure")], { "chat-a": { resolve: "unclear" } });
    l.noteSent(1, "chat-a");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(resolvedLog, [], "nothing was actually resolved");
    assert.deepEqual(prompts("chat-a"), [], "and it was not sent on as a fresh prompt either");
    assert.match(sent[0].text, /yes, always, or no/);
  });

  test("a chat that no longer exists falls back to the standing chat instead of erroring", async () => {
    const { l, rows, prompts } = build([msg("still there?")]);
    l.noteSent(1, "gone-chat");
    l.start(); await settle(); await l.stop();
    assert.equal(rows.size, 1, "gone-chat was never created here; only the standing chat exists");
    assert.ok(!rows.has("gone-chat"));
    const [id] = [...rows.keys()];
    assert.deepEqual(prompts(id), ["still there?"]);
  });

  test("updates already queued before start (a restart backlog) are drained, never acted on", async () => {
    const { l, rows, resolvedLog, sent } = build([{ update_id: 1, message: { message_id: 10, date: NOW_S - 3600, text: "yes", chat: { id: "9" } } }], { "chat-a": { resolve: "answered" } });
    l.noteSent(1, "chat-a");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(resolvedLog, [], "an hour-old update from before this process started is never acted on");
    assert.equal(rows.size, 1, "chat-a only — the standing chat was never created either");
    assert.equal(sent.length, 1, "one notice that the backlog was dropped, not one per message");
    assert.match(sent[0].text, /restarted/);
  });

  test("a busy targeted chat's prompt error comes back as a reply instead of being swallowed", async () => {
    const { l, prompts, sent } = build([msg("also check X")], { "chat-a": { promptErr: "Still working — press Stop first." } });
    l.noteSent(1, "chat-a");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(prompts("chat-a"), []);
    assert.equal(sent[0].text, "Still working — press Stop first.");
  });

  test("a late 'yes' to a card that already closed is not sent on as a prompt", async () => {
    // The card was auto-denied when its wait ran out; forwarded, "yes" read as
    // permission for the action that had just been refused.
    const { l, prompts, sent } = build([{ ...msg("yes", { reply_to_message: { message_id: 555 } }) }], { "chat-a": { resolve: "none" } });
    l.noteSent(555, "chat-a");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(prompts("chat-a"), []);
    assert.match(sent[0].text, /already closed/);
  });

  test("a prompt into an unwatched chat is watched for that one turn: cards notify, the reply comes back, then it is let go", async () => {
    const { l, rows, prompts, sent } = build([{ ...msg("check again", { reply_to_message: { message_id: 555 } }) }], { "chat-a": { resolve: "none" } });
    l.noteSent(555, "chat-a");
    l.start(); await settle();
    assert.deepEqual(prompts("chat-a"), ["check again"]);
    assert.ok(rows.get("chat-a")!.asked, "unattended for the turn: a card would notify and time out");
    rows.get("chat-a")!.asked!("asked", "Bash: ls");
    rows.get("chat-a")!.emit!({ kind: "text", text: "all good" });
    rows.get("chat-a")!.emit!({ kind: "turn_end" });
    await settle(); await l.stop();
    assert.ok(sent.some((m) => m.text.includes("Bash: ls")), JSON.stringify(sent));
    assert.ok(sent.some((m) => m.text.includes("all good")), JSON.stringify(sent));
    assert.equal(rows.get("chat-a")!.asked, undefined, "attended again after the turn");
    assert.equal(rows.get("chat-a")!.emit, undefined, "watcher detached");
  });

  test("with CODETERM_TELEGRAM_USERS set, only those senders drive it — in a group, not every member", async () => {
    const { fetchFn, sent } = fakeTelegramFetch([
      { update_id: 1, message: { message_id: 1, date: NOW_S + 5, text: "rm it all", chat: { id: "9" }, from: { id: 666 } } },
      { update_id: 2, message: { message_id: 2, date: NOW_S + 5, text: "hello", chat: { id: "9" }, from: { id: 42 } } },
    ]);
    const { convo, rows } = fakeConvo();
    const warns: string[] = [];
    const l = new TelegramListener({ convo, notifier: new Notifier({ telegram: { token: "T", chatId: "9" }, fetch: fetchFn }), token: "T", chatId: "9", publicBase: "http://x", apiBase: "http://a", contextDir: mkdtempSync(join(tmpdir(), "ct-tg-")), allowedUsers: ["42"], fetch: fetchFn, warn: (w) => warns.push(w) });
    l.start(); await settle(); await l.stop();
    const standing = [...rows.values()].find((r) => r.title === "Telegram");
    assert.deepEqual(standing?.prompts, ["hello"]);
    assert.equal(warns.filter((w) => w.includes("ignoring")).length, 1);
    assert.deepEqual(sent, []);
  });

  test("/stop interrupts the chat it is aimed at; nothing to stop says so", async () => {
    const { l, rows, sent } = build([{ ...msg("/stop", { reply_to_message: { message_id: 555 } }) }], { "chat-a": {} });
    rows.get("chat-a")!.busy = true;
    l.noteSent(555, "chat-a");
    l.start(); await settle(); await l.stop();
    assert.equal(rows.get("chat-a")!.interrupted, 1);
    assert.match(sent[0].text, /stopped/);
    assert.deepEqual(rows.get("chat-a")!.prompts, [], "not sent on as a prompt");
  });

  test("noteSent caps how many sent-message ids it tracks, never throws", () => {
    const { convo } = fakeConvo();
    const notifier = new Notifier({});
    const l = new TelegramListener({ convo, notifier, token: "T", chatId: "9", publicBase: "http://x", fetch: (async () => new Response("{}")) as typeof fetch });
    for (let i = 0; i < 250; i++) l.noteSent(i, `chat-${i}`);
    assert.doesNotThrow(() => l.noteSent(9999, "chat-x"));
  });
});
