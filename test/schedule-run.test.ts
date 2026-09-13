import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, type TestServer } from "./fakes/server.js";
import { settle, type FakeQuery } from "./fakes/sdk.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/* The whole thing through the server: a schedule created over the API,
   "run now", a chat that runs the prompt with the scripted SDK, and the
   run's row: outcome, cost, the first line of the reply, the offered file,
   what it needed. Plus the unattended rules: no site card, cards answered
   "no" after the wait. */
let s: TestServer;
const said = (m: SDKUserMessage) => String(typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content));
before(async () => {
  s = await startTestServer({
    cfg: { scheduleTickMs: 1e9 },
    sdk: { onUser: (m, q: FakeQuery) => {
      const text = said(m);
      if (/find jobs/.test(text)) {
        q.text("# Jobs today\n\n12 new listings, 3 worth a look.");
        q.result({ total_cost_usd: 0.31, num_turns: 3 });
      } else if (/ask me something/.test(text)) {
        // a question nobody is there to answer: the run must not hang
        q.ask("AskUserQuestion", { questions: [{ question: "Which city?", header: "City", options: [{ label: "Ghent", description: "" }], multiSelect: false }] }).promise
          .then((r) => { q.text(`answered: ${r.behavior}`); q.result({ total_cost_usd: 0.05 }); });
      } else if (/bank/.test(text)) {
        // the site gate with nobody there: refused, recorded
        q.ask("browser", { host: "bank.example", action: "read_page", level: "read" }).promise
          .then((r) => { q.text(`site: ${r.behavior}`); q.result({ total_cost_usd: 0.02 }); });
      } else { q.text(`You said: ${text.slice(0, 40)}`); q.result({ total_cost_usd: 0.01 }); }
    } },
  });
});
after(async () => { await s.stop(); });

const waitRun = async (id: string, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await s.json("/schedules");
    const sc = (r.body!.schedules as { id: string; runs: { outcome: string }[]; running: boolean }[]).find((x) => x.id === id)!;
    if (sc.runs[0] && sc.runs[0].outcome !== "running" && !sc.running) return sc;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the run did not finish");
};

describe("scheduled prompts through the server", () => {
  test("create, preview, run now: a named chat runs the prompt; the row has outcome, cost, summary; the chat list has the run", async () => {
    const pv = await s.json(`/schedules/preview?when=${encodeURIComponent("weekdays at 07:30")}&tz=Europe/Brussels`);
    assert.equal(pv.status, 200); assert.equal(pv.body!.cron, "30 7 * * 1-5"); assert.equal((pv.body!.next as string[]).length, 3);
    assert.equal((await s.json(`/schedules/preview?when=nonsense&tz=UTC`)).status, 400);
    const c = await s.post("/schedules", { title: "Jobs", prompt: "find jobs please", when: { text: "every day at 08:00", tz: "Europe/Brussels" }, project: "general", browser: "auto", mode: "acceptEdits" });
    assert.equal(c.status, 200); const id = c.body!.id as string; assert.equal(c.body!.words, "every day at 08:00"); assert.ok(c.body!.nextAt, "planned");
    assert.equal((await s.post("/schedules", { title: "x", prompt: "y", when: { text: "never ever", tz: "UTC" } })).status, 400);
    const ws = await s.socket("/ws"); await ws.wait((m) => m.kind === "replayed");
    const r = await s.post(`/schedules/${id}/run`, {}); assert.equal(r.status, 202);
    const sc = await waitRun(id);
    const run = sc.runs[0] as unknown as { outcome: string; costUsd: number; summary: string; chatId: string; trigger: string; needed: string[]; cards: string[] };
    assert.equal(run.outcome, "done"); assert.equal(run.costUsd, 0.31); assert.equal(run.summary, "Jobs today"); assert.equal(run.trigger, "now"); assert.deepEqual(run.needed, []); assert.deepEqual(run.cards, []);
    const chats = (await s.json("/chats")).body!.chats as { id: string; title: string }[];
    const chat = chats.find((x) => x.id === run.chatId)!;
    assert.match(chat.title, /^Jobs · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const done = await ws.wait((m) => m.kind === "schedule_done", 3000);
    assert.equal(done.title, "Jobs"); assert.equal(done.outcome, "done"); assert.equal(done.chatId, run.chatId); assert.equal(done.summary, "Jobs today");
    assert.match(String((await s.json("/setup")).body!.checks && ((await s.json("/setup")).body!.checks as Record<string, { text: string }>).schedules.text), /1 scheduled prompt — next at/);
    ws.ws.close();
  });

  test("unattended: a question is answered no after the wait; a new site is refused without a card; the run says needed-you", async () => {
    const q = await s.post("/schedules", { title: "Asker", prompt: "ask me something", when: { text: "daily", tz: "UTC" }, browser: "auto", waitMs: 1000 });
    const ws = await s.socket("/ws"); await ws.wait((m) => m.kind === "replayed");
    await s.post(`/schedules/${q.body!.id}/run`, {});
    const a = await waitRun(q.body!.id as string);
    const ar = a.runs[0] as unknown as { outcome: string; summary: string; cards: string[] };
    assert.equal(ar.outcome, "needed-you"); assert.deepEqual(ar.cards, ["a question"]); assert.equal(ar.summary, "answered: deny");
    const b = await s.post("/schedules", { title: "Banker", prompt: "read my bank", when: { text: "daily", tz: "UTC" }, browser: "auto", waitMs: 1000 });
    await s.post(`/schedules/${b.body!.id}/run`, {});
    const bs = await waitRun(b.body!.id as string);
    const br = bs.runs[0] as unknown as { outcome: string; summary: string; needed: string[] };
    assert.equal(br.outcome, "needed-you"); assert.deepEqual(br.needed, ["bank.example (read)"]); assert.equal(br.summary, "site: deny");
    assert.ok(!ws.got.some((m) => m.kind === "approval" && (m.input as { host?: string })?.host === "bank.example"), "no site card was shown to anyone");
    ws.ws.close();
  });

  test("a server-browser schedule fails cleanly when the server browser is not running; pause and delete", async () => {
    const c = await s.post("/schedules", { title: "Srv", prompt: "find jobs please", when: { text: "daily", tz: "UTC" }, browser: "server" });
    await s.post(`/schedules/${c.body!.id}/run`, {});
    const sc = await waitRun(c.body!.id as string);
    assert.equal(sc.runs[0].outcome, "failed"); assert.match((sc.runs[0] as unknown as { summary: string }).summary, /server browser is not running/);
    const p = await s.json(`/schedules/${c.body!.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused: true }) });
    assert.equal(p.body!.paused, true); assert.equal(p.body!.nextAt, null);
    assert.equal((await s.json(`/schedules/${c.body!.id}`, { method: "DELETE" })).body!.ok, true);
    assert.ok(!((await s.json("/schedules")).body!.schedules as { id: string }[]).some((x) => x.id === c.body!.id));
  });

  test("old run chats are pruned past keepRuns, a renamed one is kept", async () => {
    const c = await s.post("/schedules", { title: "Tidy", prompt: "hello", when: { text: "daily", tz: "UTC" }, browser: "auto", keepRuns: 2 });
    const id = c.body!.id as string;
    const chatIds: string[] = [];
    for (let i = 0; i < 4; i++) { await s.post(`/schedules/${id}/run`, {}); const sc = await waitRun(id); chatIds.push((sc.runs[0] as unknown as { chatId: string }).chatId); if (i === 0) s.running.convo.rename(chatIds[0], "keep me"); await settle(4); }
    const titles = ((await s.json("/chats")).body!.chats as { id: string; title: string }[]);
    assert.ok(titles.some((x) => x.id === chatIds[0]), "the renamed first run stays");
    assert.ok(!titles.some((x) => x.id === chatIds[1]), "the second run (beyond keepRuns, not renamed) is gone");
    assert.ok(titles.some((x) => x.id === chatIds[2]) && titles.some((x) => x.id === chatIds[3]), "the last two stay");
  });
});
