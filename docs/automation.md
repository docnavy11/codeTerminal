# Working while you are away

Prompts that run on a clock, watches that report a change, and how a result
reaches your phone.

Part of [code terminal](../README.md).

## Contents

- [Scheduled prompts](#scheduled-prompts)
- [Page watches](#page-watches)

## Scheduled prompts

A prepared prompt runs by itself at the times you set — "every day at
08:00", "weekdays at 07:30", "every monday at 9", "every 6 hours", or a
cron line — in a chat of its own, in the server browser unless you say
otherwise, and leaves you the result. Set it up on the manage page's
**Schedules** tab: what (a prepared prompt or typed text; the text is
stored with the schedule unless you tick "always use the prepared prompt's
current text"), when (in your time zone, the next three times previewed),
where (project, browser, mode, model), and the guard rails (budget per run,
how long to wait for a person, maximum run time, runs to keep). **Run now**
tries it before you trust it to 08:00.

**Each run is an ordinary chat**, named "Search for jobs · 2026-09-14
08:00", in the chat list under its project: open it, watch it, stop it,
type into it. The row on the Schedules tab shows the last run's outcome,
duration, cost, the reply's first line, files it offered, with links; older
runs below it. When a run ends, every open client gets a strip above the
transcript with the same line and an **open** button, and the extension
shows a notification.

**Nobody is there**, so the rules are fixed and shown on the form:

- The site gate uses the standing allow list only. A site not on it is a
  refusal, not a card; the row says "needed: jobsite.example (act)" so you
  can add it on the Browser sites tab and run again.
- Every other card — confirm-before-submit, eval, a question from Claude —
  is shown as usual (for anyone watching), and answered "no" after the wait
  (default 2 minutes); the row says which ones. Such a run's outcome is
  **needed you**.
- The per-run budget is the SDK's cost ceiling for that chat; the run stops
  past it. The maximum run time interrupts the turn.
- The default mode is **Auto** — the CLI's own judgement of what is safe,
  so shell commands run. Measured on the first real run (2026-09-13, "Search
  for jobs", $0.76): in *Build, auto-accept edits* the very first `ls` asked
  for approval, was answered "no" after two minutes, and the agent stopped
  with nothing done. Unattended, a mode that asks is a mode that fails.

**Reaching your phone.** In the browser, a run reports three ways (the
extension's notification, a strip in open chats, the Schedules tab); none
reaches a closed laptop. For that, `.env` takes a **Telegram** bot
(`CODETERM_TELEGRAM_TOKEN` + `CODETERM_TELEGRAM_CHAT`) and/or a **webhook**
(`CODETERM_NOTIFY_WEBHOOK`): an ntfy topic (the ntfy app subscribes;
detected from the URL or `CODETERM_NOTIFY_WEBHOOK_FORMAT=ntfy`) or any URL
taking JSON `{title, message, url, tags, at}` — a Home Assistant webhook
automation forwarding to the companion app, for instance. Each run sends
"Search for jobs — done · $1.55", the reply's first line, what it needed,
files, and a link to the run's chat. The setup page shows which targets are
set; the Schedules tab has **send test**. A target that fails is logged and
skipped, never blocks a run. Measured with a fake HTTP layer in
`test/notify.test.ts` (request shapes for Telegram, JSON and ntfy;
failures reported, not thrown); not measured against the real services —
"send test" is the measurement.

**It deliberately does not** run two copies at once (the second is recorded
as skipped), catch up on times missed while the server was down (recorded
as missed — "Run now" is there for that), retry, or chain schedules. Run
chats beyond "runs to keep" are deleted by the schedule itself, unless you
renamed one. The scheduler ticks every 30 s inside the server; the setup
page shows how many schedules exist and the next time. Storage is
`schedules.json` beside `prompts.json`. Design notes:
[design-scheduled-prompts.md](design-scheduled-prompts.md);
measured in `test/schedule.test.ts` (words, cron, next-run across the
Brussels DST switches, the store, the scheduler's due/skip/miss/pause
rules), `test/schedule-run.test.ts` (a run through the server with a
scripted SDK: naming, outcome, cost, summary, the unattended answers,
pruning) and the browser suite (the tab end to end).

## Page watches

The agent can watch a browser tab and report back later: "tell me when the
build passes". `mcp__watch__page` registers a watch and **returns
immediately** — the turn ends, the session goes idle, and you can keep using
it. `watch list` and `watch stop` manage them.

Four conditions: `contains` (text appears), `missing` (text disappears),
`selector` (element appears), `changes` (watched content differs from when the
watch started).

**Polled from the service worker, not by injecting a MutationObserver.** An
injected observer dies on navigation — which is usually the exact moment the
awaited thing happens. Polling with `chrome.scripting.executeScript` every 6s
survives navigation, SPA rerenders and a page replacing its own DOM. The
`/ext` ping is what keeps the worker alive to do it.

When one fires it notifies the desktop, because by definition you are not
looking at the panel. It also wakes the owning chat — but only if that chat is
the one currently running, since starting a turn in a background conversation
you are not watching is worse than leaving a note. If it is not active the
watch stays on the list for `watch list` to report.

On the server, watches live in memory only. A watch is a live observer on a
live tab; restoring one after a restart would resurrect something whose tab is
long gone. They expire (60 min default, 24h max), are capped at 20 active,
fire at most once, and are dropped with the chat that owns them.

In the extension they are mirrored to `chrome.storage.session` and restored
whenever the service worker starts. Chrome evicts that worker at will, and an
in-memory map went with it while the server still listed the watch — which
then never fired. Session storage clears when the browser closes, which is
also when the tabs go, so nothing outlives what it observes.
