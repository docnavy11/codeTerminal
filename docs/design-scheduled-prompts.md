# Scheduled prompts — design

Status: design, 2026-09-13. Nothing built yet.

## What it is, in one sentence

A prepared prompt runs by itself at a time you set, in a chat of its own,
in the browser you chose, and leaves you the result the way a colleague
would: a note that it ran, what it found, and any file it made.

## The person's view

**Setting one up.** On the manage page, a new tab **Schedules**. "New
schedule" asks for four things, in this order, each with a sensible default:

1. **What** — pick a prepared prompt ("Search for jobs"), or type a prompt
   here. The prompt is stored with the schedule, so editing the prepared
   prompt later does not silently change a schedule (a "use latest" toggle
   for those who want that).
2. **When** — "every day at 08:00", "weekdays at 07:30", "every Monday",
   "every 6 hours", or a cron line for the unusual. Shown back in words
   with the next three run times, in your time zone (the server's TZ is
   UTC; the schedule shows and stores your zone).
3. **Where** — the project (working directory) and which browser: **server
   browser** (the default, because your laptop may be off) or "whichever is
   connected". Mode and model as in a chat; the default mode is *Build,
   auto-accept edits*, because nobody is there to answer a card.
4. **Then** — what to do when it finishes: notify (extension notification
   and a line on the manage page, always), and optionally **offer a file**
   the prompt wrote (the file card in the transcript), which the run finds
   by the same rule as the chat's `files.offer`.

A schedule can also be started **now** ("Run now"), which is how you check
it does what you meant before trusting it to 08:00.

**While it runs.** Each run is an ordinary chat named after the schedule
and the date ("Search for jobs · 2026-09-14 08:00"), so you can open it,
watch it, stop it, or take it over by typing. It lives in the chat list
under the schedule's project. The status bar shows "scheduled run" instead
of "working" so you know why a chat is busy at 08:00.

**When it needs you.** A scheduled run gets no person to answer cards, so:

- The site gate: the run uses the standing allow list only. A site not on
  the list is a refusal, not a card, and the run records "needed: allow
  jobsite.example (act)" so you can add it and run again.
- Confirm-before-submit cards, eval cards, questions from Claude: a run
  waits at most a set time (default 2 minutes), then answers *deny* /
  *stop* and continues or ends. Every such event is in the run's report
  as "asked, nobody there".
- Runaway limits (tool calls, screenshots, budget) apply as in any chat,
  with a per-schedule budget you set ("at most $1 per run"); past it the
  run stops and says so.

**Afterwards.** The **Schedules** tab lists each schedule with its last
run: when, how long, cost, outcome (done / stopped / needed you / failed),
the first line of the reply, and any offered file, with links to the chat
and the file. A notification "Search for jobs finished — 12 new listings ·
$0.31" (the first sentence of the reply) reaches the extension the way
"Claude finished" does today, and the phone page shows the same line in a
banner until dismissed. A run that fails to even start (no browser, server
browser stopped, budget exhausted for the day) is a red line in the same
list, not silence.

**Keeping it tidy.** Runs are chats, so the chat list would fill with them:
the schedule keeps the last N runs (default 10) and deletes older run chats
itself, unless a run is pinned. A schedule can be paused and resumed. The
manage page shows the next scheduled time for each, and "3 schedules · next
08:00 Search for jobs" on the setup page.

## What it deliberately does not do

- Chain schedules or pass results between them. A prompt that needs the
  previous run's output reads the file it left in the project.
- Run the same schedule twice at once: a run that is still going when the
  next time comes is skipped, recorded as "skipped: previous run still
  running".
- Catch up on missed runs after a server restart: a missed time is logged
  as missed, not run late, so a server that was down for a day does not
  wake up and run everything at once. ("Run now" is there for that.)
- Retry a failed run on its own.

## Decisions to make before building

1. **The file.** Schedules are a small list; `schedules.json` beside
   `prompts.json`, edited only through the manage page and the API.
2. **Time zone.** Stored per schedule ("Europe/Brussels"), displayed in it,
   computed with the platform's `Intl` support — no new dependency for cron
   parsing beyond the five-field form; the words ("weekdays at 07:30") are
   sugar over that.
3. **Who runs it.** The server process, on a one-minute tick, while it is
   up. Not systemd timers: the run needs the live Manager, the bridge and
   the server browser, which are all in-process.
4. **Nobody there.** The 2-minute wait-then-deny default is the one rule
   that could surprise; it is shown on the schedule form, and the report
   names every card it answered.
5. **Notifications** stay where they are (the extension, the phone banner).
   Email/Telegram are a separate feature.

## How it maps onto what exists (for the build, not the user)

| need | exists | to add |
|---|---|---|
| a chat with project, mode, model, browser | `Manager.create`, `setProject`, `setMode`, `setModel`, `useBrowser` | a `createRun()` that does all four without a client attached |
| send a prompt and know when the turn ends | `LiveChat.prompt`, `turn_end` with cost | await the end, capture the reply's first line and the offered files |
| approvals with nobody there | the session's pending map | a per-chat "unattended" flag: gate → refuse instead of card; other cards → deny after the wait |
| notify | extension `notify()` on `turn_end`, watch events | a `schedule_done` event with the summary line; phone banner |
| the standing allow list | `browser-allow.json` | nothing |
| runaway limits, budget | env caps, `maxBudgetUsd` | per-schedule budget passed into the session |
| storage | `prompts.json` pattern (`PromptStore`) | `schedules.json`, `ScheduleStore` |
| the tick | the chat sweeper's interval in `server.ts` | a `Scheduler` with `next()` from a five-field cron + IANA zone |

Estimated size: a day for the scheduler, store, API and the manage tab;
half a day for the unattended-approval behaviour and its tests; the phone
banner and the setup-page line are small.
