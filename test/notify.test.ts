import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Notifier, escapeMd, notifyConfigFromEnv } from "../src/notify.js";

const fakeFetch = (log: { url: string; init: RequestInit }[], status = 200) => (async (url: string | URL | Request, init?: RequestInit) => { log.push({ url: String(url), init: init ?? {} }); return new Response(status === 200 ? "ok" : "nope", { status }); }) as typeof fetch;

describe("notifier", () => {
  test("telegram: bot URL, chat id, MarkdownV2 with the title bold and everything escaped", async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const n = new Notifier({ telegram: { token: "T", chatId: "42" }, fetch: fakeFetch(log) });
    assert.deepEqual(n.targets, ["telegram"]);
    const r = await n.send({ title: "Jobs — done · $1.55", message: "12 new (3 worth a look).", url: "http://x/?chat=abc" });
    assert.deepEqual(r, { sent: ["telegram"], failed: [] });
    assert.equal(log[0].url, "https://api.telegram.org/botT/sendMessage");
    const body = JSON.parse(String(log[0].init.body)); assert.equal(body.chat_id, "42"); assert.equal(body.parse_mode, "MarkdownV2");
    assert.equal(body.text, "*Jobs — done · $1\\.55*\n12 new \\(3 worth a look\\)\\.\nhttp://x/?chat\\=abc");
  });
  test("telegram: a real API response's message_id comes back for the two-way listener to bind a reply to", async () => {
    const fakeSendMessage = (async (url: string | URL | Request) => {
      if (String(url).includes("sendMessage")) return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    const n = new Notifier({ telegram: { token: "T", chatId: "9" }, fetch: fakeSendMessage });
    const r = await n.send({ title: "t", message: "m" });
    assert.deepEqual(r, { sent: ["telegram"], failed: [], telegramMessageId: 42 });
  });
  test("webhook json and ntfy shapes; a token becomes a bearer header", async () => {
    const log: { url: string; init: RequestInit }[] = [];
    const j = new Notifier({ webhook: { url: "https://ha.local/api/webhook/abc", format: "json", token: "s3" }, fetch: fakeFetch(log) });
    await j.send({ title: "T", message: "M", tags: ["x"] });
    const h = log[0].init.headers as Record<string, string>; assert.equal(h.authorization, "Bearer s3"); assert.equal(h["content-type"], "application/json");
    const body = JSON.parse(String(log[0].init.body)); assert.equal(body.title, "T"); assert.equal(body.message, "M"); assert.deepEqual(body.tags, ["x"]); assert.equal(body.url, null); assert.ok(body.at);
    const nt = new Notifier({ webhook: { url: "https://ntfy.sh/topic", format: "ntfy" }, fetch: fakeFetch(log) });
    assert.deepEqual(nt.targets, ["ntfy"]);
    await nt.send({ title: "Jobs — done", message: "12 new", url: "http://x/", tags: ["white_check_mark"] });
    const h2 = log[1].init.headers as Record<string, string>; assert.equal(h2.title, "Jobs ? done"); assert.equal(h2.tags, "white_check_mark"); assert.equal(h2.click, "http://x/"); assert.equal(String(log[1].init.body), "12 new");
  });
  test("a failing target is reported, not thrown; both targets go out together; no targets is a no-op", async () => {
    const log: { url: string; init: RequestInit }[] = []; const warned: string[] = [];
    const n = new Notifier({ telegram: { token: "T", chatId: "1" }, webhook: { url: "https://w/", format: "json" }, fetch: fakeFetch(log, 500), warn: (l) => warned.push(l) });
    const r = await n.send({ title: "t", message: "m" });
    assert.deepEqual(r.sent, []); assert.equal(r.failed.length, 2); assert.match(r.failed[0].error, /HTTP 500/); assert.equal(warned.length, 2);
    const none = new Notifier({ fetch: fakeFetch(log) });
    assert.deepEqual(none.targets, []); assert.deepEqual(await none.send({ title: "t", message: "m" }), { sent: [], failed: [] }); assert.equal(log.length, 2, "nothing was fetched");
  });
  test("config from the environment: pairs required for telegram; ntfy detected from the URL", () => {
    assert.deepEqual(notifyConfigFromEnv({}), {});
    assert.deepEqual(notifyConfigFromEnv({ CODETERM_TELEGRAM_TOKEN: "T" }), {}, "a token without a chat id is nothing");
    assert.deepEqual(notifyConfigFromEnv({ CODETERM_TELEGRAM_TOKEN: "T", CODETERM_TELEGRAM_CHAT: "9" }), { telegram: { token: "T", chatId: "9" } });
    assert.deepEqual(notifyConfigFromEnv({ CODETERM_NOTIFY_WEBHOOK: "https://ntfy.sh/abc" }), { webhook: { url: "https://ntfy.sh/abc", format: "ntfy" } });
    assert.deepEqual(notifyConfigFromEnv({ CODETERM_NOTIFY_WEBHOOK: "https://ha/hook", CODETERM_NOTIFY_WEBHOOK_TOKEN: "k" }), { webhook: { url: "https://ha/hook", format: "json", token: "k" } });
    assert.equal(escapeMd("a.b(c)-d!"), "a\\.b\\(c\\)\\-d\\!");
  });
});
