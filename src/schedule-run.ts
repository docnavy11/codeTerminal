/**
 * How a scheduled prompt runs: an ordinary chat, created for the run and
 * named after it, set to the schedule's project, mode, model and browser,
 * marked unattended (cards get no person), given the prompt, and watched
 * until the turn ends. The result is what the run's row on the manage page
 * shows: outcome, cost, the reply's first line, files offered, sites it
 * needed, cards it answered for you.
 */
import type { Manager, LiveChat } from "./conversation.js";
import type { ClientEvent } from "./protocol.js";
import type { PromptStore } from "./prompts.js";
import { resolveProject } from "./projects.js";
import { SERVER_BROWSER_ID } from "./server-browser.js";
import type { Schedule, Run, RunResult, Runner } from "./schedule.js";

export type RunDeps = {
  convo: Manager;
  prompts: PromptStore | null;
  /** The server browser is up and its extension connected? A "server" schedule needs it. */
  serverBrowserReady: () => boolean;
  now?: () => number;
};

const firstLine = (t: string) => (t.split("\n").map((l) => l.trim()).find((l) => l && !/^#+\s*$/.test(l)) ?? "").replace(/^#+\s*/, "").slice(0, 200);

export function makeRunner(d: RunDeps): Runner {
  const now = d.now ?? (() => Date.now());
  return async (s: Schedule, run: Run): Promise<RunResult> => {
    const needed: string[] = []; const cards: string[] = []; const files: string[] = [];
    // The prompt: stored with the schedule, or the prepared prompt as it is now.
    let text = s.prompt;
    if (s.useLatest && s.promptId && d.prompts) {
      const p = d.prompts.all().find((x) => x.id === s.promptId);
      if (p) text = p.text;
    }
    if (s.browser === "server" && !d.serverBrowserReady()) {
      return { chatId: null, endedAt: now(), outcome: "failed", costUsd: null, summary: "failed: the server browser is not running (start it on the manage page, or set the schedule's browser to auto)", files, needed, cards };
    }
    const chat: LiveChat = d.convo.create();
    const stamp = new Date(now()).toLocaleString("sv-SE", { timeZone: s.when.tz }).slice(0, 16).replace("T", " ");
    chat.rename(`${s.title} · ${stamp}`);
    run.chatId = chat.id;
    try {
      await d.convo.setProject(chat.id, resolveProject(d.convo.projects(), s.project));
      if (s.mode !== chat.mode) await chat.setMode(s.mode);
      if (s.model && s.model !== chat.model) await chat.setModel(s.model);
      chat.useBrowser(s.browser === "server" ? SERVER_BROWSER_ID : undefined);
      chat.setUnattended({ waitMs: s.waitMs, onEvent: (kind, detail) => (kind === "needed" ? needed : cards).push(detail) }, s.budgetUsd);

      let lastText = ""; let ended: Extract<ClientEvent, { kind: "turn_end" }> | null = null;
      let resolveEnd: () => void = () => {};
      const endP = new Promise<void>((r) => { resolveEnd = r; });
      const watch = (e: ClientEvent) => {
        if (e.kind === "text") lastText = e.text;
        else if (e.kind === "file") files.push(e.path);
        else if (e.kind === "turn_end") { ended = e; resolveEnd(); }
      };
      chat.attach(watch, false);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; chat.session.interrupt().catch(() => {}); }, s.maxMs);
      let giveUp: NodeJS.Timeout | undefined;
      try {
        await chat.prompt(text, async () => undefined);
        // the interrupt should end the turn; if even that fails, give up 30 s later
        await Promise.race([endP, new Promise<void>((r) => { giveUp = setTimeout(r, s.maxMs + 30_000); })]);
      } finally { clearTimeout(timer); clearTimeout(giveUp); chat.detach(watch); chat.setUnattended(null); }
      const e = ended as Extract<ClientEvent, { kind: "turn_end" }> | null;
      const summary = firstLine(lastText) || (e?.stopped ? `stopped: ${e.stopped}` : timedOut ? "stopped: the run took longer than allowed" : e?.isError ? "the turn ended with an error" : "(no reply)");
      const outcome: RunResult["outcome"] = !e ? "failed" : timedOut ? "stopped" : e.stopped ? "stopped" : needed.length || cards.length ? "needed-you" : e.isError ? "failed" : "done";
      return { chatId: chat.id, endedAt: now(), outcome, costUsd: e?.costUsd ?? null, summary: timedOut && !lastText ? "stopped: the run took longer than allowed" : summary, files, needed, cards };
    } catch (err) {
      return { chatId: chat.id, endedAt: now(), outcome: "failed", costUsd: null, summary: `failed: ${err instanceof Error ? err.message : String(err)}`, files, needed, cards };
    }
  };
}

/** Delete this schedule's run chats beyond keepRuns (newest kept), unless a chat has been renamed by a person. */
export function pruneRuns(d: { convo: Manager }, s: Schedule): string[] {
  const removed: string[] = [];
  const finished = s.runs.filter((r) => r.chatId && r.outcome !== "running");
  for (const r of finished.slice(s.keepRuns)) {
    const chat = d.convo.get(r.chatId!);
    const title = chat?.record.title ?? d.convo.list().find((c) => c.id === r.chatId)?.title;
    if (title === undefined) continue;                              // already gone
    if (!title.startsWith(`${s.title} · `)) continue;               // renamed: someone kept it on purpose
    d.convo.remove(r.chatId!); removed.push(r.chatId!);
  }
  return removed;
}
