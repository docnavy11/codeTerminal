import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { TelegramListener } from "../src/telegram-listener.js";
import type { Manager } from "../src/conversation.js";

/**
 * TelegramListener against a fake Telegram (fetch) and a fake Manager (just
 * enough of LiveChat.session/.prompt to exercise routing) — the real Manager
 * and a real SDK subprocess are exactly what this file does not need to
 * prove: which chat a reply lands in, and what it does there.
 */
type Resolved = "answered" | "unclear" | "none";
function fakeConvo(chats: Record<string, { resolve?: Resolved; promptErr?: string }>) {
  const resolvedLog: string[] = [];                                // "<chatId>:<text>", only on a real "answered"
  const prompts: { chatId: string; text: string }[] = [];
  const convo = {
    get(id: string) {
      const c = chats[id];
      if (!c) return null;
      return {
        session: {
          resolveOldestPending: (text: string) => {
            const r: Resolved = c.resolve ?? "none";
            if (r === "answered") resolvedLog.push(`${id}:${text}`);
            return r;
          },
        },
        async prompt(text: string) { if (c.promptErr) throw new Error(c.promptErr); prompts.push({ chatId: id, text }); },
      };
    },
  } as unknown as Manager;
  return { convo, prompts, resolvedLog };
}

/** One update batch, served once, then an empty result forever (so the poll loop idles quietly). */
function fakeTelegram(updates: unknown[]) {
  const sent: { chat_id: string; text: string }[] = [];
  let served = false;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const s = String(url);
    if (s.includes("/getUpdates")) {
      const body = served ? { ok: true, result: [] } : { ok: true, result: updates };
      served = true;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (s.includes("/sendMessage")) {
      sent.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, sent };
}

const NOW_S = Math.floor(Date.now() / 1000);
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("TelegramListener", () => {
  test("a message from someone else's chat id is dropped", async () => {
    const { convo, prompts, resolvedLog } = fakeConvo({});
    const { fetchFn, sent } = fakeTelegram([{ update_id: 1, message: { message_id: 1, date: NOW_S + 5, text: "hi", chat: { id: "666" } } }]);
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: fetchFn });
    l.start(); await settle(); await l.stop();
    assert.deepEqual(prompts, []); assert.deepEqual(resolvedLog, []); assert.deepEqual(sent, []);
  });

  test("a reply to a tracked notification resolves that exact chat's pending card", async () => {
    const { convo, prompts, resolvedLog } = fakeConvo({ "chat-a": { resolve: "answered" }, "chat-b": { resolve: "answered" } });
    const { fetchFn, sent } = fakeTelegram([
      { update_id: 1, message: { message_id: 10, date: NOW_S + 5, text: "yes", chat: { id: "9" }, reply_to_message: { message_id: 555 } } },
    ]);
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: fetchFn });
    l.noteSent(555, "chat-a");
    l.noteSent(556, "chat-b");   // a second tracked message — proves binding is by message id, not "most recent"
    l.start(); await settle(); await l.stop();
    assert.deepEqual(resolvedLog, ["chat-a:yes"]);
    assert.deepEqual(prompts, [], "resolved, not sent as a fresh prompt");
    assert.equal(sent[0].text, "✓ done.");
  });

  test("a plain message with no reply falls back to the last chat mentioned", async () => {
    const { convo, prompts } = fakeConvo({ "chat-a": {}, "chat-b": {} });   // "none" pending on both: falls through to prompt
    const { fetchFn, sent } = fakeTelegram([{ update_id: 1, message: { message_id: 10, date: NOW_S + 5, text: "check the site again", chat: { id: "9" } } }]);
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: fetchFn });
    l.noteSent(1, "chat-a"); l.noteSent(2, "chat-b");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(prompts, [{ chatId: "chat-b", text: "check the site again" }], "chat-b was noteSent last");
    assert.match(sent[0].text, /^Sent —/);
  });

  test("nothing ever mentioned: a courtesy reply, nothing sent to any chat", async () => {
    const { convo, prompts } = fakeConvo({});
    const { fetchFn, sent } = fakeTelegram([{ update_id: 1, message: { message_id: 10, date: NOW_S + 5, text: "hello?", chat: { id: "9" } } }]);
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: fetchFn });
    l.start(); await settle(); await l.stop();
    assert.deepEqual(prompts, []);
    assert.match(sent[0].text, /Nothing to reply to yet/);
  });

  test("an unclear reply to a plain permission card is left open, not guessed on", async () => {
    const { convo, prompts, resolvedLog } = fakeConvo({ "chat-a": { resolve: "unclear" } });
    const { fetchFn, sent } = fakeTelegram([{ update_id: 1, message: { message_id: 10, date: NOW_S + 5, text: "hmm not sure", chat: { id: "9" } } }]);
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: fetchFn });
    l.noteSent(1, "chat-a");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(resolvedLog, [], "nothing was actually resolved");
    assert.deepEqual(prompts, [], "and it was not sent on as a fresh prompt either");
    assert.match(sent[0].text, /yes, always, or no/);
  });

  test("a chat that no longer exists: told so, nothing thrown", async () => {
    const { convo, prompts } = fakeConvo({});
    const { fetchFn, sent } = fakeTelegram([{ update_id: 1, message: { message_id: 10, date: NOW_S + 5, text: "still there?", chat: { id: "9" } } }]);
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: fetchFn });
    l.noteSent(1, "gone-chat");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(prompts, []);
    assert.match(sent[0].text, /gone/);
  });

  test("updates already queued before start (a restart backlog) are drained, never acted on", async () => {
    const { convo, prompts, resolvedLog } = fakeConvo({ "chat-a": { resolve: "answered" } });
    const { fetchFn, sent } = fakeTelegram([{ update_id: 1, message: { message_id: 10, date: NOW_S - 3600, text: "yes", chat: { id: "9" } } }]);
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: fetchFn });
    l.noteSent(1, "chat-a");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(resolvedLog, [], "an hour-old update from before this process started is never acted on");
    assert.deepEqual(prompts, []);
    assert.deepEqual(sent, []);
  });

  test("a busy chat's prompt error comes back as a reply instead of being swallowed", async () => {
    const { convo, prompts } = fakeConvo({ "chat-a": { promptErr: "Still working — press Stop first." } });
    const { fetchFn, sent } = fakeTelegram([{ update_id: 1, message: { message_id: 10, date: NOW_S + 5, text: "also check X", chat: { id: "9" } } }]);
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: fetchFn });
    l.noteSent(1, "chat-a");
    l.start(); await settle(); await l.stop();
    assert.deepEqual(prompts, []);
    assert.equal(sent[0].text, "Still working — press Stop first.");
  });

  test("noteSent caps how many sent-message ids it tracks, never throws", () => {
    const { convo } = fakeConvo({});
    const l = new TelegramListener({ convo, token: "T", chatId: "9", fetch: (async () => new Response("{}")) as typeof fetch });
    for (let i = 0; i < 250; i++) l.noteSent(i, `chat-${i}`);
    assert.doesNotThrow(() => l.noteSent(9999, "chat-x"));
  });
});
