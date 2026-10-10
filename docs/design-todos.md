# Project todos and the board — design

Status: built 2026-10-09 (docs/using.md, "The board"); this is the design it
was built from, with the two deviations noted under "Decisions taken" (6 and
8). Discussion that led here: a mod was considered and rejected (mods
misrender in the tmux terminal emulation that half the sessions run in), as
was a pane per project (too many panes).

## What it is, in one sentence

Each project keeps a short queue of things to do, in both directions — items
you leave for the sessions, and questions or todos a session leaves for you;
the server is its only writer; one board shows every project that has
anything going on — its sessions, whether each is busy or idle, and what is
waiting on whom — so an idle session next to a non-empty queue, or a question
nobody has answered, is the thing you notice.

## The person's view

**The board.** A fourth view in the desktop's right pane, next to shell,
sessions and files, and a page of its own on the phone. At the top, across
all projects, **For you**: every open question or todo a session has left
for you, newest first, each with the project, who asked, and a one-line
answer box. Below it, only projects with something going on appear: a live
chat, a tmux session, or a queued item. Ordered the way the project picker
orders them, most recently used first. Each project is a card with two
columns.

*Sessions*, on the left, one row each:

- A codeTerminal chat: its title, and one of `busy · 2m`, `waiting for you`
  (an approval card is open), or `idle · 14m`. Under it, folded, the chat's
  last TodoWrite list — the model's own step list, which the transcript
  already renders — so you see what it is on without opening it.
- A tmux session: its name and path, and `working`, `probably idle`, or
  `no claude` — inferred from which command the pane runs and how long ago
  it last produced output. The word *probably* is deliberate: the board
  never says more than it knows.

*Queue*, on the right: queued items in order, then claimed ones with who
holds them, then the last few done ones greyed. An input at the top adds an
item in one line. Each item can be dragged to reorder, edited, dropped.

**The actionable cell.** An idle session in a project with a queue gets a
highlight and a **send next** button. For a chat, the server submits the
top item as a prompt and marks it claimed by that chat. For a tmux session
the same button types the item into the pane; that is a second step (see
"Decisions").

**Items for you.** A session that hits a decision it should not take alone,
or notices work that is yours (a DNS record, a payment, a password), files
an item *for the owner* instead of stalling or guessing: `todo_ask` from a
chat, `add_todo` with `for: "owner"` from the MCP endpoint. It shows under
**For you** and, when a notifier is configured, as one Telegram or webhook
line, rate-limited like the existing `notify` tool. You answer in the box;
the answer is stored on the item and marked done. If the asking chat is
still live, **reply** sends the answer into it as a prompt; otherwise the
chat gets it as context on its next turn, in the same block as the queue.
The journal's `who: owner | claude` is the same idea at the level of
conclusions; this is the same idea at the level of tasks.

**Adding from anywhere.** The board's input; a `/todos` route the phone and
scripts can post to; an `add_todo` tool on the `/mcp` endpoint, so a Claude
Code session on the laptop or in tmux can park something for later.

**Sessions see the queue.** Every chat's prompt carries the project's
queued items as owner-authored context, labelled as the project queue, so
"take the next one" needs no copy-paste. The chat has two in-process tools,
`todo_claim` and `todo_done`, and finishes an item with a one-line result.
Terminal sessions get the same two things without a mod: a
`UserPromptSubmit` hook script that fetches `/todos?dir=<cwd>` and appends
the queued items, and a status-line script that prints the counts
(`todo 3 queued · 1 claimed`). Both are plain text, so they render anywhere.
They claim and finish through the MCP tools, self-labelled `tmux:<name>`.

**Stale claims.** The server knows whether a claiming chat is still live. A
claim held by a chat that was evicted or has been idle for a while shows as
stale, with a **release** button; nothing is released by itself.

**Keeping it tidy.** Done and dropped items older than a set age (default
14 days) are pruned on write. A project with no sessions and an empty
queue leaves the board.

## What it deliberately does not do

- Pick up work by itself. Nothing dispatches an item without a press. Two
  sessions editing one working tree already clobbered each other once
  (2026-09-15); an unattended third party is not the fix. If "send next"
  turns out to be too slow a habit, auto-dispatch can reuse what
  scheduled runs already do (`schedule-run.ts`: fresh chat, mode, budget,
  time cap, unattended cards). That is a later decision, taken on
  evidence.
- Copy done items into `journal.json`. A done todo is a task; a journal
  entry is a conclusion. The model, or the person, decides when one
  deserves the other.
- Let more than one process write the file. Terminal sessions read it and
  call the server; if the server is down they can read but not claim.
- Track what a tmux session is actually doing. It has no TodoWrite stream;
  the board shows its idle guess and nothing more.
- Carry priorities, tags, due dates. Order in the list is the priority.
- Answer an owner question by itself after a timeout, as scheduled runs do
  with cards. An item for you waits until you answer or drop it.

## Decisions taken

1. **Where it lives.** In codeTerminal, not a mod. Mods draw panes and
   bands inside Claude Code's own interface, which misrenders in the tmux
   emulation the desktop's terminal pane shows; codeTerminal chats would
   not see a mod's pane at all. The terminal side gets two scripts instead.
2. **The file.** `todo.json` at the project's git root, falling back to the
   project directory from `projects.ts` when the cwd is not in a repo.
   **Gitignored**, not committed: it churns with every claim, and the
   server on this box is the writer, so a committed copy would be a diff
   in a shared tree on every press. (The journal is committed because it
   is a record; this is a queue.) Written atomically, re-read before every
   write because a checkout can change it underneath.
3. **One writer.** The server, as `Store` is for `chats/`. A claim is a
   compare-and-set on the item's status inside that single writer, so it
   cannot be taken twice.
4. **Idle, two ways.** Chats: exact, from `LiveChat.busy` and the open-card
   count. tmux: read from the pane (`src/insight.ts`). Measured on three
   live panes on 2026-10-09: while a turn runs the CLI shows a spinner line
   with a timer above its input box (`✽ Frosting… (10m 58s · ↓ 7.6k
   tokens)`); when it is waiting it shows a done line (`✻ Baked for 7s ·
   done 3:13 PM`) or nothing. That is exact enough to say `working` and
   `idle`. The output-age guess (60 s of silence with `claude` running)
   remains only as the fallback when a pane cannot be read, and keeps the
   word "probably". The first build shipped with the guess alone; the owner
   asked for more insight the same day.
9. **One line per thread, from Haiku.** The board says what each session is
   about: `claude-haiku-5-5` reads the transcript's tail (a chat's last
   twelve entries; a pane's last sixty lines without the CLI's chrome) and
   answers in one sentence. Cached per session, recomputed only when the
   text changed and at most every 90 s, computed in the background so the
   poll never waits on a model; the first poll shows the assistant's last
   words instead. Asked for by the owner ("I want more insight in the
   threads"); the queue was redrawn as three columns at the same time.
10. **Sessions are the lanes.** The three-column board lasted an afternoon:
    the owner found it unintuitive, because "in progress" is not a place,
    it is a session. The page now reads left to right per project — queue,
    sessions, done — and each session lane carries its own in-progress slot:
    the board item it holds, or a summary of the task it was given directly
    (the Haiku line, with the prompt under it). Assigning is a drop onto an
    idle lane or *Assign next*. Mockup reviewed first as an artifact
    (claude.ai/artifact/6UPXEupyBfZPcYS4V1gYP2), then built into
    `public/board.html` + `board.js` on the same day.
11. **Done is the record, not only the queue's tail.** Work a session was
    given directly finishes too: at a chat's turn end, and when a tmux pane
    goes from working to idle (a 10 s tick, so it does not depend on the
    board being open), the prompt is recorded as a done item with the
    reply's first words as result, signed by the session. Not recorded:
    slash commands, prompts under 12 characters, and turns spent on a held
    board item. Owner's ask, same day ("when a task is done it should come
    in done").
12. **Needs you is a column**: the owner's open questions from `todos.ask`,
    plus sessions stopped on a card. The masthead keeps the count. Owner's
    ask, same day.
13. **One kanban, not a board per project.** The lanes lasted an hour: the
    owner rejected them outright ("I don't like it at all"; asked, named
    the per-project blocks and the look). Asked to choose between one
    classic kanban, swimlanes per session and a flat list, the owner chose
    the kanban. Now: four columns across all projects — Queue, In
    progress, Needs you, Done — a card per task with a colored project tag
    and the session as a name with a state dot, and one strip of sessions
    above the columns that doubles as the drop target for assigning
    (dropping on In progress asks which idle session when a project has
    several). Calmer look: cards on inset columns, sentence-case headers,
    no uppercase chips. Mockup and live page are built from the same files:
    the mockup is `board.html`'s styles and `board.js` with a snapshot
    inlined as `window.BOARD_SNAPSHOT`, so the two cannot drift.
14. **Borrowed from the field** (owner asked for a look at tools that do
    this, 2026-10-09). Kanban Code (langwatch) runs Backlog · In Progress ·
    Waiting · In Review · Done, moves cards from activity signals, and gives
    each card its tmux terminal and a Resume. Anthropic's Agent View (Claude
    Code 2.1.139, May 2026) is a list of sessions with "needs your input",
    the last response and the last interaction, answered inline so the
    session resumes. claude-code-kanban keeps one color per agent, filters
    by owner and project, opens a detail panel on click. Vibe Kanban (now
    community-maintained) adds a Review column and lets agents drive the
    board over MCP, which this one already does. Conductor isolates each
    task in a worktree with its own diff and checks. Taken: inline Allow /
    Deny on the Needs-you card (`/board/decide`, `Session.pendingCards`),
    and filtering by project tag or session pill. Not taken, for now: a
    Review column and worktree-per-task — codeTerminal's sessions share one
    working tree by design (see the 2026-09-15 clobbering note), and review
    happens in the chat's own diff cards.
5. **send next to tmux**: built the same day as the second step. `tmux
   send-keys -l <one line>` then `send-keys Enter`, measured on a throwaway
   session on 2026-10-09: the line lands as one prompt and the reply came in
   two seconds. Only when the pane reads `idle` (decision 4); the text is
   collapsed to one line because a newline in the input box sends what came
   before it. The claim is made as `tmux:<name>` before typing and released
   if typing fails.
6. **The board is polled**, not pushed — a deviation from the first draft,
   which had a `board` event. The page (`public/board.html`) is one page for
   one person: it asks `GET /board` every four seconds while visible and
   right after anything you do. A poll keeps the phone and the framed
   desktop tab on the same code with no socket of their own, and it needs
   no new kind in the wire protocol. A pushed badge can come later if the
   four seconds ever show.
7. **Two directions, one file.** An item has `for: "claude" | "owner"`.
   Items for the owner are the "For you" section; they are never claimed by
   a session and never sent with *send next*. An answered question is a
   done item whose `result` is the answer.
8. **Gitignored globally**, not per project: `todo.json` is in the server's
   global git excludes (`~/.config/git/ignore`), so no project needs a line
   in its own `.gitignore`. The file name is specific enough that nothing
   else on this box is called that; if one day something is, the entry
   narrows.

15. **The keeper: Haiku reads the thread, the server moves the cards.** The
    heuristic recorder (decision 11: a chat's turn end, a tmux pane going
    quiet) recorded a *pause* as a finished task and took the result from
    the previous reply — the owner caught it within the hour ("you are
    working on the latest question and it is already in the done column").
    The owner's proposal: a cheap subagent reads the latest update and
    updates the board. Built as a Haiku 5.5 call (not an Agent SDK subagent:
    no tools, one shot, same cache and cost shape as the summaries) that
    returns JSON — summary, task title, status working | done | needs_you |
    idle, result, question. The server (`src/server.ts`, keeper) turns
    status into moves: done → a done item titled by the model with its
    result; needs_you → a question for the owner on the board; deduplicated
    by title per session; nothing for a session that holds a board item. A
    turn end forces a fresh read; a 10 s tick covers tmux sessions and
    anything that lands between polls. Measured so far only with the test
    double; the model's accuracy on real threads is unmeasured.

16. **A column per session, done underneath.** Owner's ask after the
    kanban: "in progress should show all sessions with a card if busy and
    empty if not; I should be able to hide sessions; below, a second lane
    with the done's, each session one column." So the middle of the board
    is a grid: row 1 session headers, row 2 the in-progress cell (task card
    or drop slot), row 3 a Done label, row 4 that session's done items.
    Queue and Needs you stay as the left and right columns. Hidden sessions
    are per browser (`localStorage`), shown again from a masthead chip.
    Items finished without a session get a trailing column. The sessions
    strip and the session filter went away: the columns are the sessions.

17. **Back to the kanban, with sessions as containers.** Decision 16 was
    not what the owner meant ("I wanted the previous, but in progress
    needed all the sessions as container; below, a second kanban board
    'done' with each session a column; the filter before: keep, but allow
    me to select multiple and only show the tmux"). So: the three-column
    board (Queue · In progress · Needs you) with every session as a box
    inside In progress — its task card when busy, a drop slot when idle —
    and a separate Done board under it, one column per session. The strip
    is the filter: pills and project tags toggle into a set, plus a
    "tmux only" switch; remembered per device. Hiding (16) went away: the
    filter does that job.

18. **Tests for what was only checked by hand** (owner asked, 2026-10-10,
    after the reply-to-tmux bug and the hidden-task bug each reached them
    first). Real-tmux tests with a stand-in pane, the hook scripts run for
    real, the board page in Chromium, and an environment preload so the
    suite means the same thing from any shell; see docs/development.md.
    Each was shown to fail when the thing it guards is broken (the answer
    path, the filter). The keeper's accuracy is measured by `npm run
    eval:keeper`: 21 labelled tails, 3 runs each, 63/63 with the current
    prompt on 2026-10-10. The harness was checked against the prompt from
    before the step fix: it scored 61/63 and failed the case where only
    "commit / push / merge" is visible (titled "Merge board reply fix into
    main"), so it can tell the two apart. Limits: the labels and the tails
    are the author's, mostly synthetic, one model, one day; the score says
    the clear cases work, not how often a real thread is misread.

19. **Eight additions, 2026-10-10** (owner chose them from a list of ten; the
    side-panel view and the idle-with-queue phone alert were left out).
    *Orphaned claims*: a Stop hook for tmux sessions; the keeper closes an item
    a chat holds when it reads the whole task as done; tmux exit and chat
    deletion release; stale marks (idle 15 min) and a visible box for claims
    whose holder is gone, which the first version of the page did not have.
    *Keeper corrections*: not-a-task and wrong-title save the thread for
    `eval:keeper --reported`. *Cost*: pause and a call counter; persisted.
    *Richer tasks*: notes, images (kept in the workspace), served back for
    thumbnails. *Done links*: chat and commit. *History*: pruning archives to
    `todo-archive.jsonl`; search reads it. *Blocked-by*: ids on the item,
    refused cycles, enforced on claim, assign and dispatch (a dropped
    blocker unblocks; removing one clears the reference). *Auto-dispatch*:
    per project, off by default, with the guards in docs/using.md.
    Known limits: auto-dispatch cannot see a half-typed line in a tmux
    session; "idle" for stale is time since the session last moved, not proof
    the work is abandoned; commit detection is a hash regex confirmed with
    `git rev-parse`, so a result that names a hash from another repo is not
    linked; the keeper closing a held item is a model judgement (↩ undoes
    it); opening a card's details panel pauses the page's polling until it
    is closed.

## Item shape

```json
{
  "items": [
    { "id": "…", "text": "…",
      "for": "claude | owner",
      "status": "queued | claimed | done | dropped",
      "addedAt": 0, "addedBy": "owner | chat:<id> | tmux:<name> | mcp",
      "claimedBy": "chat:<id> | tmux:<name>", "claimedAt": 0,
      "doneAt": 0, "result": "one line" }
  ]
}
```

## How it maps onto what exists (for the build, not the user)

| need | exists | to add |
|---|---|---|
| which project a cwd belongs to | `projects.ts` `listProjects`, `resolveProject` | git root of a cwd, with the project dir as fallback |
| the file, atomically | `store.ts` tmp + `renameSync`, `quarantine` for a file that does not parse | `src/todos.ts`: a leaf with `read`, `add`, `claim`, `done`, `drop`, `reorder`, `release`, prune |
| chat busy / waiting / idle | `LiveChat.busy`, `lastTouched`, the session's pending cards | a `boardOf(manager, tmux)` that assembles rows per project |
| a chat's own step list | the `TodoWrite` tool_use events already in the record | the last one, per live chat, kept on `LiveChat` |
| tmux rows | `tmux.ts` `FORMAT` has `pane_current_command`, `session_activity` | the idle inference, one function, unit-tested |
| push to clients | `ClientEvent` union in `protocol.ts`, `test/protocol.test.ts` enforcing the client handles every kind | a `board` event; a `board` handler in `sidepanel.js` |
| the view | desktop right pane tabs (`data-view`) in `desktop.js`; phone page `m.html` | a fourth tab and a `board.js` shared the way `term.js` is |
| send next to a chat | `LiveChat.prompt`, "Still working" guard | a server message `todo_send` that prompts and claims in one step |
| queue in the chat's prompt | `composePrompt` in `prompt.ts` (untrusted block) | an owner-authored block, not nonce-wrapped: it is the person's list, not a page's |
| in-session tools | `tools.ts` MCP servers as closures over server state | a `todos` server with `claim`, `done`, `list`, `ask` (an item for the owner) |
| tools for other agents | `mcp.ts` `registerTool` | `list_todos`, `add_todo` (with `for`), `claim_todo`, `done_todo`, `drop_todo` |
| telling you a session needs you | the notifier behind `mcp.ts` `notify`, `NOTIFY_MAX` per window | one line per new owner item, same limiter |
| the answer reaching the chat | `LiveChat.prompt`; the queue block in the prompt | **reply** = prompt the asking chat if live; else the answered item rides along in the next turn's block |
| the terminal side | `~/.claude/settings.json` has a `statusLine` | `deploy/hooks/todo-context.sh` (UserPromptSubmit), `deploy/hooks/todo-status.sh`; documented in `docs/using.md` |
| HTTP | the `guard` every route sits behind | `GET/POST /todos`, `PATCH /todos/:id` |

Estimated size: half a day for `todos.ts` with tests and the board
assembly; a day for the view on desktop and phone; half a day for the
tools, hooks and docs. tmux send-keys is separate.
