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

- Every card — a site not on the allow list, confirm-before-submit, eval, a
  question from Claude — goes up as usual and is answered "no" after the
  wait (default 10 minutes); the row says which ones, and the run's outcome
  is **needed you**. The site gate used to refuse on the spot rather than
  ask. That was right while the only way to answer was to be sitting at the
  page; now the card is announced the moment it goes up and the run is still
  blocked on it when you arrive.
- **The notification is the way in.** A card in an unattended run sends one
  straight away — what is being asked, and a link to that chat. Opening it
  puts the confirmation box in front of you, because a client attaching
  while a card is open is sent that card (measured in `test/attach.test.ts`).
  Answer it and the run carries on. Ignore it and the wait runs out, which
  is why the wait is minutes rather than seconds.
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

**Two-way Telegram.** With `CODETERM_TELEGRAM_CONTROL=1` set alongside the
Telegram pair above, a reply is read back, not just sent to. Reply to a
"waiting for you" notification with yes / always / no to answer that card
(any text answers an `AskUserQuestion`), or reply to a "done" notification
with anything else to send it as a fresh prompt in that same chat. A message
that does not reply to anything falls back to whichever chat was last
mentioned, and — with nothing to fall back to either, which is the ordinary
case: the first message, or one that has drifted past the last thing
mentioned — lands in one standing chat named **Telegram**, created the
first time it is needed and reused after. That chat is a real conversation:
it runs permanently unattended (a card it raises is announced and
answerable exactly like a scheduled run's), and its own replies are pushed
back to Telegram when each turn ends, so it is a phone-only chat with the
agent, not a one-shot command line. Its cwd is a small dedicated directory
holding only a `CLAUDE.md` — read automatically on every turn — that tells
it how to look up this server's own state over loopback: `GET /schedules`
(scheduled prompts, saved prompts, projects), `/chats`, `/prompts`,
`/projects`, and that `POST /schedules/<id>/run` runs one now, through the
ordinary approval gate. Ask it "what's scheduled?" and it can actually
answer, without you needing to open the app. It also shows up in the manage
page's chat list like any other, in case you want to read it or reply from
there
instead.

Long-polling (`getUpdates`), never a webhook — Telegram's servers reaching
in would be the one inbound exposure everything else here is built to
avoid — and only messages from `CODETERM_TELEGRAM_CHAT` are ever read.

Off by default, on top of the notify pair, because it is a bigger step than
being told about a run: anyone who can message that chat can now drive the
agent, with whatever mode and shell access that chat's session already has
— and the standing chat runs in **Auto**, the same default schedule.ts
itself uses for a new schedule, not "Ask before changes": with nobody
watching a browser tab to click Allow on, Ask turns every ordinary command
into a card (measured — a job-search schedule's own diagnosis over Telegram
stalled on repeated plain "Bash" approvals before this). Auto still raises
a card, announced and answerable the same way, for anything the CLI's own
judgement is not sure about. A pending card it cannot parse (a permission
gate, unclear text) is left open rather than guessed on. A prompt sent to some *other* chat by falling back to what was last
mentioned has no completion notification of its own — only a scheduled
run's own end, or the standing chat's own wiring, does that — so check the
app for that one's reply. See `src/telegram-listener.ts` for what a restart
does with Telegram's own backlog (drained, never acted on) and for how the
standing chat is found (by title, so deleting it just makes a new one next
message).

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
