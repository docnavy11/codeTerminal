# Using it

The chat itself: what the buttons do, what the cards mean, and every feature you
reach from the transcript.

Part of [code terminal](../README.md).

## Contents

- [Chats](#chats)
- [Several conversations at once](#several-conversations-at-once)
- [Per-chat working directory](#per-chat-working-directory)
- [Projects and the manage page](#projects-and-the-manage-page)
- [/clear and the transcript](#clear-and-the-transcript)
- [Prepared prompts](#prepared-prompts)
- [Slash commands](#slash-commands)
- [Questions from Claude](#questions-from-claude)
- [Permission modes](#permission-modes)
- [The approval gate](#the-approval-gate)
- [The change, before you approve it](#the-change-before-you-approve-it)
- [What each tool returned](#what-each-tool-returned)
- [Plan mode](#plan-mode)
- [Subagents and the task list](#subagents-and-the-task-list)
- [Rewind](#rewind)
- [Model](#model)
- [@file](#file)
- [Images in the prompt](#images-in-the-prompt)
- [Thinking](#thinking)
- [Streaming replies](#streaming-replies)
- [Files the agent prepares for you](#files-the-agent-prepares-for-you)
- [File browser](#file-browser)
- [Knowing what it is doing](#knowing-what-it-is-doing)
- [Type size and theme](#type-size-and-theme)
- [Chrome side panel](#chrome-side-panel)
- [The shell pane](#the-shell-pane)
- [Sessions](#sessions)
- [Right-click and notifications](#right-click-and-notifications)

## Chats

Conversations are kept as one JSON file each under `chats/`, listed newest
first in the **Chats** picker. The title is the first thing you said. **New
chat** starts a fresh one and keeps the current one; the ✕ deletes.

Only live chats (the pool of four, above) have a running SDK session — each
is a `claude` process, so keeping every past chat warm would be expensive.
Opening an old one resumes it by its `sdkSessionId`, which rebuilds the
model's context from the transcript on disk. Verified: two chats, switch away,
switch back, and the model still recalled a word from the first one.

Renaming, re-projecting or "open in the terminal" on a chat that is not live
edits its record on disk without waking it. Going through the pool for that
spawned a subprocess per rename — measured — and evicted an idle chat to make
room.

**Search** in the picker (and on the manage page) matches titles first, then
every transcript: what you said, what it replied, notes — with a snippet, and
a click opens the chat scrolled to that message. Substring, case-insensitive,
indexed per chat on first use and re-read only when the chat changes.

**Export this chat as Markdown** (⋯ menu, and on the manage page) downloads
the transcript — your messages, the replies, one line per tool call, the
turn costs — as `<title>.md` (`GET /chats/:id/export.md`).

**New chat** reuses an abandoned empty one rather than minting another: every
click used to write a "New chat" record before a word was said, and the
empties piled up in the picker. Clicking it while already on an unused chat
stays there.

Replay is bracketed by `cleared` … `replayed` so a client can tell history
from live events.

## Several conversations at once

Each attached client picks its own chat. Two browsers, or a browser and the
side panel, can hold two different conversations running simultaneously —
before this there was a single active chat and every screen showed it, so
switching in one switched everywhere.

Switch conversation from the **chats** button — in the side panel header, in
the web UI header, or from the manage page's *open in the terminal*. It
switches that window only; another browser keeps whatever it was on. Each
window remembers its chat: opening the side panel again, or reloading the web
page, reattaches to the chat that window was on rather than the newest one —
so a second window never lands on, and then redirects, the first window's
conversation. A brand-new window starts on the newest chat. The list filters,
since the point of keeping conversations is finding them again.

Sharing still works: point two clients at the same chat and they both see it
live — the same words streaming into both, either one able to type. A chat
holds a set of clients, not one. So the choice is yours per window: same
conversation on two screens, or two conversations side by side.

`LiveChat` owns one conversation: its record, its session, and the clients
watching it. `Manager` is a pool of up to four, since each is a real `claude`
subprocess. When the pool is full the least recently touched **idle** chat is
evicted; a chat with a client attached is never evicted, however old, because
someone is looking at it. If everything is in use the pool goes over its cap
rather than cutting someone off.

`session.ts` no longer has module globals. A session is given its own
`chatId`, bridge, shell source, watch registry and prompt store — a global
"current chat" would have attributed every session's watches to whichever was
last.

Permission mode is per chat (see *Permission modes*). A chat admitted from
disk starts in `default`; one created from another inherits its creator's
mode.

A session whose `claude` subprocess dies is not left looking alive. The stream
ending is the only signal, and it used to be ignored — the next prompt went
into an input nobody read. Now the session marks itself dead, reports it once,
and the next prompt (or a firing watch) respawns it, resuming the same
conversation. Verified by killing the child mid-life: the next prompt was
answered.

A prompt counts as busy from the moment it is accepted, including the up to
2.5 s spent fetching the active tab, so a second prompt in that window is
refused rather than queued behind the first.

Browser tools follow the browser you are working in. Each extension generates
a stable instance id per profile (`chrome.runtime.id` is not enough — the same
unpacked extension shares it across profiles) and sends it on connect; the side
panel sends the same id when it attaches, and a conversation binds to it **at
send time**, not at attach time. Two clients can start on the same chat, so
binding on attach let the second capture it.

If that browser has closed, a browser tool **fails and says so** rather than
falling back to another open browser — acting in the wrong browser silently is
worse than not acting.

## Per-chat working directory

Each chat remembers the directory it works in, so one can be pointed at a repo
while another stays in the workspace. Navigate to a directory in the **files**
tab and press **use here**.

The SDK takes `cwd` only at launch, so changing it rebuilds the session and
resumes it by `sdkSessionId` — the conversation survives, the directory
changes under it. Refused while a turn is running.

The path goes through the same `safePath` containment as the file browser, so
it must be a real directory inside `CODETERM_FILES_ROOT`. A new chat inherits
where you are working, which is almost always what you want when you start one
mid-task, and a shell pane opened afterwards starts there too.

The directory is announced on attach, on chat switch and on change, rather
than waiting for the next turn's `system/init` — otherwise the header shows
the previous directory until you happen to send a message.

Verified: two chats given different directories each kept their own across
switching away and back; outside-root and not-a-directory are both refused;
a shell opened after the switch reported the new path from `pwd`.

## Projects and the manage page

A **project is a subdirectory of `CODETERM_PROJECTS_ROOT`** (default
`~/projects`) — discovered, never
created. Make a directory and it appears; there is nothing to register. Plus
one overarching **General** project for chats that are not about a directory,
which is most of them.

A chat belongs to exactly one project, and the project's directory becomes its
working directory, so "which project" and "where does it work" cannot drift
apart. A new chat inherits the project you were in. An unknown project id
falls back to General rather than erroring.

`/manage.html` is the curation surface: **Chats** (search, rename, move,
delete), **Prompts** (a real editor, not a 300px popover), **Projects**
(filter, chat counts, jump to a project's chats). The popovers in the main UI
stay for in-flow use; this is for the jobs that need room. There are 79
projects here, so both lists filter.

Moving a chat rebuilds its session, so the server only allows it on the chat
that is currently open — the manage page says so in the control rather than
letting it fail.

## /clear and the transcript

`/clear` drops the model's context. The transcript is our own event buffer, so
without handling it the UI would keep showing a history the model can no
longer remember — worse than showing nothing, because it reads as if it is
still there.

The SDK says so directly: `conversation_reset` is *"emitted by /clear,
plan-mode exit, and fresh-session flows. The surface should mount a fresh
transcript under new_conversation_id and reset any cached session title."*

So on that event the chat's events are emptied, the title reset, and
`sdkSessionId` repointed at the new conversation, then every attached client
is told to clear. Same chat, fresh context, both sides in step.

## Prepared prompts

A **prompts** button in the status bar of both surfaces opens a list of saved
prompts. Click one to run it. `+ new`, and the ✎ / ✕ on each row, manage them.

Prompts are either generic or scoped to domains. Which apply is decided from
the **active browser tab**, resolved server-side through the bridge — so the
plain web UI, which has no idea what your browser is showing, gets the same
domain-scoped list as the side panel. Site-specific prompts sort above generic
ones so they are never buried.

A domain covers its own subdomains: `github.com` matches `gist.github.com`.
Matching is on label boundaries, so `evilgithub.com` does not match
`github.com` — there is a test for exactly that.

`{url}`, `{title}`, `{host}` and `{selection}` are filled from the active tab
before the prompt is sent, so "Explain the selection" works without you
retyping anything.

Stored in `prompts.json`, seeded on first run with five examples, because an
empty list teaches nobody what it is for.

Claude can curate the library too: `mcp__prompts__list`, `save` and `delete`.
"Save that as a prompt for github.com" works.

Reading is auto-approved; **saving and deleting are not**. A saved prompt is
something you click and run later, and untrusted page content already reaches
this model — a page that talked the agent into saving one would be planting
something for you to fire yourself. So a write stops at the approval card,
showing the title and body before it lands.

## Slash commands

Both surfaces support `/` commands with autocomplete (arrows, Tab, Esc).
The list comes from `Query.supportedCommands()`, refreshed on the SDK's
`commands_changed` push.

Timing gotcha: with a streaming-input prompt, `system/init` does not arrive
until the *first* turn — but the menu needs the list before you type. So
`supportedCommands()` is called as soon as the query object exists, not from
the init handler.

A slash command never gets ambient tab context attached. The CLI only expands
a command that is the first thing in the message, and the context block would
sit in front of it — which is exactly how they silently stopped working once
tab context shipped.

Not all of them: the CLI advertises `terminal_slash_commands` (here `doctor`,
`color`, `reload-plugins`) whose UX needs a real terminal, and the SDK docs
say remote UIs should hide those. Names starting with `__` are internal and
hidden too. 79 of 82 remain.

## Questions from Claude

`AskUserQuestion` is a built-in tool: Claude uses it to ask *you* something.
It is not a permission prompt, and rendering it as one leaves the question
unanswerable — the turn just parks.

The answer travels back through the permission callback. `AskUserQuestionInput`
carries an `answers` field ("User answers collected by the permission
component"), keyed by the exact question text, so the host returns
`{behavior: "allow", updatedInput: {...input, answers}}`.

The UI renders a distinct blue card: a header chip, the question, one button
per option with its description (and preview, when the option has one), and
an automatic **Other** field for a free-text answer. The status bar reads
`waiting for you — a question`.

**One card can hold several questions, and a question can take several
answers.** Both were invisible, and worse than invisible: deselecting
searched the whole *card* for options, so answering the second question
visibly cleared the answer to the first, and the card looked as if it took
one answer in total (reported 2026-09-15). Each question now owns its
options; the question line says **choose one** or **choose any that apply**;
the marker is a circle for one and a box for any, so the shape says what the
click will do; typing in **Other** no longer wipes the other picks of a
multi-select question; and **Answer** stays disabled, counting "1 of 2
answered", until every question has one — it used to submit what it had and
drop the rest. Multi-select answers go back comma-separated, which is what
the SDK documents. Measured in `test_question_card_multi_select`.

## Permission modes

The header dropdown maps to the SDK's `setPermissionMode`:

| Mode | Behaviour |
|---|---|
| Ask before changes | `default` — the gate below |
| Auto-accept edits | `acceptEdits` — writes go through, Bash still asks |
| Classifier decides | `auto` — a model classifier approves/denies most calls |
| Plan only | `plan` — no tool execution at all |
| Never ask | `bypassPermissions` — nothing is checked |

`bypassPermissions` is refused by the SDK unless the session was launched with
`allowDangerouslySkipPermissions`, so it is gated behind `CODETERM_ALLOW_BYPASS=1`.
When unset, the option is disabled in the UI rather than failing on selection.

Enabling the capability does not weaken `default`. Measured, flag on, mode
left at default:

    gate_fired=true  file_created=false

**Permission mode is per chat.** A chat created from another inherits its
creator's mode; one admitted from disk starts in `default`. The mode is
re-stated to every attached client on each switch, so the dropdown can never
show a mode the session is not actually in. It used to be app-global, which
meant flipping the mode in one window flipped it under a session running in
another.

Because a chat admitted from disk always starts in `default`, a server
restart cannot re-arm "Never ask". That is the only case worth guarding —
an earlier version also downgraded on chat switch, silently, which just meant
the UI claimed "Never ask" while the session went on prompting.

Measured, so the mode means what it says:

    default              canUseTool fires for mcp__..._list_labels  -> card
    bypassPermissions    canUseTool does not fire                   -> no card

For "stop asking me about *this*", prefer the per-tool `Always allow` button
on an approval card — it uses the SDK's own `updatedPermissions` suggestions
and persists, without disarming everything else.

## The approval gate

`canUseTool` is awaited by the SDK, so a turn genuinely blocks until you click.

Auto-approved (cannot modify anything, cannot reach the network):
`Read`, `Glob`, `Grep`, `NotebookRead`, `TodoWrite`.

Everything else — `Write`, `Edit`, `Bash`, `WebFetch`, `WebSearch` — prompts.

**One thing to know:** Claude Code auto-approves a built-in *read-only command
set* inside `Bash` before `canUseTool` is consulted. `cat`, `echo`, `ls` and
similar run without prompting. Mutating commands (`touch`, `rm`, `mv`, …) hit
the gate. Verified:

    echo / cat  → gate NOT called (read-only set)
    touch       → gate called, denied, file never created
    Write       → gate called, denied, file never created

If you need *every* Bash call to prompt, a `PreToolUse` hook is the only surface
that sees them all.

## The change, before you approve it

An Edit or Write approval card shows the diff, not the tool's JSON: the
path, `+a −b`, three lines of context, removed lines red, added lines
green, a `line N` marker per hunk. It is computed on the server from the
current file and the proposed change (`src/diff.ts`) *before* you decide —
so "old_string not found — the edit would fail", "the file does not exist"
and "rewrites the whole file (3000 → 1 lines)" are things you read on the
card, not discover afterwards. Reading the file is bounded to 1.5 s; if it
cannot be read the card falls back to the raw input. A request the SDK
withdraws while the file is being read never shows a card.

## What each tool returned

Every tool call is one row — `→ Bash  grep -c purchase "$f"` — and the row
ends with what came back: `3`, `120 lines (of 900)`, `edited x.ts · +4 −1`,
`Invoices · 4,100 chars`, `image · 1280×720`, `null`. The line is chosen
per tool (`src/results.ts`) so the collapsed transcript already answers
"and?". Click a row to open the output as the agent saw it, in a box that
scrolls after ~12 lines, with a copy button; **errors open themselves**, in
red. `…` means the result has not arrived yet. While a turn runs the status
bar counts it — `thinking · 31 tools · 12 screenshots` — which is how a
spiral becomes visible in two seconds.

The result rides on the SDK's user message (`tool_result` block plus the
per-tool structured `tool_use_result`); 8 KB of each is kept with the chat,
the rest is summarised as `…truncated (N KB in full)`. Measured on this
box's transcripts: median result 254 chars, max 42 KB, 1.6 % errors.

## Plan mode

Pick **Plan** in the mode menu (or the agent enters it itself) and it only
reads. When it has a plan it asks to leave planning, and *that* card is the
plan — rendered, scrollable — with the three answers the TUI offers:
**Build it** (back to asking before changes), **Build, auto-accept edits**,
or **Keep planning**, which sends the model back for a revision ("ask what
should change, then present the plan again"). Approving carries the chosen
mode to the CLI as a `setMode` permission update and switches the session,
so the mode menu follows. The plan is kept with the chat and exported under
`## Plan`. Measured against the real CLI: the card arrived with a real
plan, approving with auto-accept switched the mode; the agent then ended
its turn without acting — say "go" if you want it to start at once.

## Subagents and the task list

When the agent delegates to a subagent (the `Agent` tool), the call gets a
task line beneath it — `↳ agent · running · 3 tool uses · 42s · Grep` while it
works, then `completed · 3 tool uses · 4s · <first line of its report>`
(or failed / stopped), the full report a click away. The subagent's own
tool calls and words are nested under that row, collapsed with a count
(`4 steps ▸`), so a delegated search does not flood the transcript with
someone else's grep. Start and end are kept with the chat; the heartbeat in
between is live-only. Measured basis: 187 of this box's transcripts contain
`Agent` calls; the `task_started / task_progress / task_notification`
messages are what the SDK sends for them.

`TodoWrite` renders as one checklist per chat — `tasks · 2/3 done`, ✓ / ▸ /
○ per item, the in-progress item in its active wording — updated in place
each time the agent revises it, sitting at the bottom where the eye is.
(Not observed on this box; rendered per Claude Code's documented shape and
defensively.)

## Rewind

Hover one of your messages and press **⟲** to put the files back to how
they were before it. First a preview — `Restore 2 files to how they were
before this message (−3 +10 lines): src/a.ts, src/b.ts` — then **Restore**,
and a note in the transcript says what happened. The CLI keeps a checkpoint
per user message (`enableFileCheckpointing`); every message we send carries
a uuid so the CLI can name it, and `rewindFiles` does the work, refusing
symlinks and paths that moved. Files only: the SDK offers no conversation
rewind, so the transcript stays as it is — say what you want done
differently in your next message. Verified against the real CLI: an
agent-made edit was previewed (`1 file, −1 line`) and restored
byte-for-byte; the real rewind's answer lists no files, so the note counts
from the preview.

## Model

A **model** menu sits beside the mode menu, filled from the CLI's own list
(`supportedModels`), with *default* meaning whatever the CLI would use. It
is per chat and remembered: a chat opened next week comes back on the
model it was on, and a new chat inherits the model of the one you started
it from, like the working directory and the permission mode. Switching
mid-conversation uses the SDK's `setModel`; if the CLI refuses, the menu
snaps back and the transcript says why. The header shows the model the
session actually reported at start. Measured: this CLI lists `default`,
`opus[1m]`, `claude-fable-5-1[1m]`, `sonnet`, `haiku` (aliases, not ids);
choosing `sonnet` made the next session report `claude-sonnet-5`.

## @file

Type `@` and a name anywhere in the composer and a menu lists matching
paths under the chat's working directory — name prefix first, then
substring, then subsequence (`@sll` finds `src/lib/loader.ts`); `.git`,
`node_modules` and the like are skipped and the denylist holds. Enter or
Tab inserts `@path`; a directory keeps the menu open to go deeper. The
directory is walked once and cached for ten seconds, so typing does not
re-walk a project per keystroke. `x@example.com` is not a mention. The
SDK has a `file_suggestions` control request but no public method for it,
so this is `GET /files/suggest`. Measured: in SDK mode the CLI does **not**
expand `@path` into the file's content the way the TUI does — the model
sees the path and reads it with its Read tool (one extra, cheap call).

## Images in the prompt

Paste a screenshot (Ctrl/Cmd+V), drop an image on the composer or the
transcript, or use the paperclip — up to four per message. The browser
downscales each to the API's recommended 1568 px long side (PNG stays PNG,
photos become JPEG) and makes a 160 px thumbnail; the full image goes to
the model as an image block ahead of your words, the thumbnail is what the
chat keeps and shows under your message. A message can be an image alone.
The server refuses a prompt whose images are malformed rather than
stripping them; accepted types are PNG, JPEG, GIF and WebP.

## Thinking

When the model's thinking carries text, it shows as a dim, collapsed block
above the reply — the first line visible (`thinking · I've narrowed it to
two candidates.`), the rest a click away — streaming as it arrives and kept
with the chat. Measured on this box's transcripts (817 thinking blocks in
one TUI session, 208 across the SDK-run chats): only ~4 % carry any text,
typically a 200–400-character progress note; the API omits the rest and
sends token counts, which is what `thinking · 251` in the status bar shows.
So the block is there when there is something to read, and absent — not
empty — when there is not. Plain text, never rendered as markdown: it is
not addressed to you.

## Streaming replies

`includePartialMessages: true` makes the SDK emit `stream_event` frames, and
the text deltas inside them are forwarded as `delta` events. Without it an
assistant message only arrives **complete**, so a long turn showed nothing at
all until the model finished its first block — the status bar ticking while
the pane stayed empty.

Deltas are live-only and never persisted. The completed `text` event carries
the same words and is the copy that goes in the transcript, so persisting both
would duplicate every reply. When it arrives it replaces the streamed bubble
rather than appending, which also means a dropped delta cannot leave the reply
subtly wrong.

Measured on a six-sentence answer: 138 deltas, first at 4.1s, and the streamed
text matched the final copy exactly.

Rendering is once per animation frame, not once per delta. Each delta used to
re-parse the whole accumulated markdown — O(n²) in reply length; a 24 KB reply
(700 deltas) cost 6.1 s of main-thread time, and long replies visibly janked.
Throttled to a frame it is 1 ms, and the final `text` event renders the
complete reply regardless.

On reconnect the client resets its transcript before the server's replay
arrives; it used to append the replay to what was already on screen, so every
restart, sleep or wifi blip doubled the transcript. A prompt typed while the
socket is down is queued and sent on reconnect (the status shows how many),
where it used to be dropped silently.

## Files the agent prepares for you

When the result of the work is a file — an export, a report, a converted
document — the agent offers it (`files.offer`, auto-approved: it only
announces a file already written through the gate) and the transcript
shows a card: name, size, its note, **Download**, **Show in files** and,
for a type the browser can display, **Open in tab**. Markdown, CSV/TSV and
JSON open in the app's own viewer page (`/view.html`): rendered markdown
with lined tables, a row-numbered grid, pretty-printed JSON, each with a
**Raw** toggle and a Download button. Tables there sort by clicking a header
(numbers as numbers, including `1.234,56`; a third click restores file
order), resize by dragging a header's right edge, and a filter box hides
rows with no matching cell. PDF goes to Chrome's PDF viewer,
images and media to the browser's own, other text and code as plain text.
The file pane's viewer has the same button. Inline responses carry a sandboxing CSP, and
HTML and SVG are served as plain text on purpose: a file the agent wrote
or downloaded never runs as a page on this origin.
Only files under the browsable root can be offered, because that is what
the file routes serve. `Write`/`Edit` rows and browser downloads also get a
small ⬇ when the file sits under the root. Offers are kept with the chat
and exported as `📎 name (bytes) — note`.

## File browser

A **files** tab in both surfaces: beside the shell in the web UI, and beside
**chat** in the side panel. Browse, view, download, upload (button or
drag-and-drop), create a folder. Text files preview inline, images render, binaries offer a
download.

Root is `CODETERM_FILES_ROOT`, default your home directory; it opens in the workspace.
Scoping it tighter than the shell would be theatre — `/pty` is already a full
shell as this user — but the root is enforced properly all the same.

`GET /files/info | /files/list | /files/read`, `POST /files/upload | /files/zip
| /files/mkdir`, all behind the same Origin + `tailscale whois` guard as the
WebSockets. **New folder** is an inline row in the listing (a side panel
cannot show a `prompt()` dialog): Enter creates, Escape cancels, and the
name goes through the same `basename` + `safePath` + denylist path as an
upload; an existing name is refused, not reused. Static
assets stay open, since they are inert without a session.

Tick the checkboxes to select several, then **Download as zip**. Ticking a
directory takes everything under it. The zip is built with `yazl` and streamed
straight to the response — nothing is written to disk, since the whole point is
handing over a large selection. Capped by `CODETERM_MAX_ZIP` (500MB default).

The selection clears when you navigate, because carrying it across directories
would zip things you can no longer see.

Downloads stream to disk on the pages the server serves itself (`/`, `/m`):
a plain `<a download>` for a file, and for a zip a form POST into a hidden
same-origin iframe (the route accepts urlencoded as well as JSON for this).
Nothing passes through page memory — a 500 MB zip used to be 500 MB in the
tab. The extension panel is a different origin, where a link would open the
file instead of saving it, so only there is the response fetched into a blob
first. One trade-off: on the pages, a zip error (too large, nothing selected)
lands in the hidden iframe and is not shown.

A text preview is cut at its byte cap without splitting a multibyte
character, and a symlink that points outside the root is listed as `other`
rather than as a file that then refuses to open.

**`safePath` resolves symlinks.** `path.resolve` collapses `..` but does not
follow links, so a symlink inside the root pointing at `/etc` would pass a
string-only check — it did, until this was fixed. It now `realpath`s the
deepest existing component and tests containment on that, which still permits
naming a file that does not exist yet, as an upload must. Upload filenames go
through `basename`, so a name like `../../../../tmp/x` lands as `x` in the
current directory.

Verified: `..`, absolute paths, symlinks out and symlinked files are all
refused; new and nested-new paths are allowed; a PNG round-trips
byte-identical; a cross-origin request gets 403.

## Knowing what it is doing

A status bar sits directly above the input. The state is derived on the server
from whichever of these is true, in this order, so it cannot drift:

| State | Shown as |
|---|---|
| an approval card is open | `waiting for you — Bash` (amber, pulsing) + *jump to it* |
| SDK is compacting | `compacting the conversation` |
| a tool is executing | `running Bash` |
| a turn is live, no tool | `thinking · 1.2k tokens` |
| nothing running | `ready` |

Token counts come from the SDK's `thinking_tokens` frames, tool state from
`tool_progress` plus the `tool_use`/`tool_result` pair. The elapsed timer runs
client-side from when the message arrived, so a clock skew between machines
cannot produce a negative age.

**"Waiting for you" is deliberately distinct from "busy".** Those are the two
states that used to be indistinguishable, and only one of them is your turn to
act.

Every attached tab gets every event — the manager broadcasts to a set of
clients, so opening a second tab does not starve the first.

Status is never persisted. It is recomputed and pushed on attach, so a tab
reloaded mid-turn shows the true state instead of `ready`. Verified: with an
approval open, dropping the socket and reconnecting reports `awaiting (Bash)`
on the fresh connection.

While a turn is live — including while an approval is open — the input is
blocked, because the server rejects a second prompt then. Stop stays available
throughout, so you can abandon a turn instead of answering its card.

## Type size and theme

The header has a theme button cycling **auto → light → dark**, and `A−`/`A+`
for type size (9–20px). Both are remembered per browser in `localStorage`, and
both exist in the side panel too.

Every font size is a `rem` off `html { font-size }`, so one number scales the
whole UI. The terminal is a canvas and cannot read CSS, so `applyFontSize` and
`applyTermTheme` hand it the values explicitly and refit the pty.

`auto` follows `prefers-color-scheme`. The palettes are defined three times on
purpose: dark on `:root`, light under the media query guarded by
`:not([data-theme="dark"])`, and light again on `[data-theme="light"]` — so an
explicit choice beats the OS in both directions.

Adding a colour? Put it in the palette. Two hardcoded ones (`.md code`, the
terminal background) turned into black-on-black the first time light mode ran.

## Chrome side panel

The extension also ships the Claude session as a Chrome **side panel** — click
the toolbar icon. It is the same `/ws` protocol as the web UI, so it is just
another attached client: open both and they stay on the same conversation,
live. It carries messages, approvals, questions, the mode selector and the
status bar, but no terminal — a side panel is too narrow for one, and the
shell stays in the web UI.

`marked` and `DOMPurify` are bundled under `extension/vendor/` so the panel
needs nothing from the network but the WebSocket.

Because the panel runs on a `chrome-extension://` origin, the Origin check
accepts that scheme on `/ws` as well as `/ext` — a `chrome-extension://` URL
can never be a web page, so the cross-site concern does not apply. `whois`
still does.

Settings (server URL, on/off) moved to the options page: right-click the
toolbar icon and choose Options, since the icon now opens the panel.

Note: an unpacked extension gets a fresh id each time Chrome loads it from a
new profile, so `CODETERM_EXT_ORIGIN` pinning needs the id from
`chrome://extensions`.

## The shell pane

Either pane can be put away. The **›** in the right header collapses the
terminal to a narrow rail, and double-clicking the divider does the same; the
rail names the view it is standing in for, so you can see whether you left the
terminal, the sessions or the files open, and one click brings it back. The
**‹** in the left header does the mirror image for the conversation, for when
you are working in the terminal and only want to see that Claude is still
there. The choice is remembered per browser, under a key each.

Only one at a time: collapsing one side opens the other, because two rails and
nothing to read is not a state worth being able to reach — and a stored pair
saying both are away restores the right one only.

The **↻** beside it redraws the terminal, for when the pane's picture has
drifted from what is really on the other end — a resize that landed while it
was hidden or collapsed, a font change, a half-drawn full-screen program. It
refits the geometry and repaints xterm from its own buffer; attached to a tmux
session it also redials, because a reattaching client is what makes tmux paint
the whole screen again. The session is untouched by that. A plain shell is
deliberately *not* redialled — that socket is the shell, and dialling again
would throw away what is running in it — so there the button is a local
repaint and a resize. It is only offered while the terminal tab is up.

Redialling now takes the old socket's handlers with it. It used to leave them:
`close()` fires its event after the replacement is already open, and the stale
`onclose` scheduled another reconnect — two clients on one tmux session, which
tmux sizes to the smaller of the two. That was a way to *get* a skewed pane
from the button meant to fix one.

The pane is narrowed, never removed. xterm loses its scrollback when its
element is detached, the file list would have to be fetched again, and the
transcript comes back scrolled where you left it. The one thing that had to
change for it is the resize: fitting a terminal against a zero-width pane asks
the pty for a nonsense geometry, so the fit is skipped while the pane has no
size and runs again when it reopens.


`CODETERM_SHELL=0` leaves it out altogether: the `/pty` upgrade answers 404,
the desktop page asks `/config` before dialling (otherwise its retry loop
would knock every three seconds) and shows the file browser alone, the agent
is not given the `terminal.read` tool at all, and the setup page says so. Its
own `Bash` tool is untouched — that one goes through the approval gate. Worth
setting when the server is reachable by anyone but you, and in CI.


`/pty` is a real PTY (`node-pty` + xterm.js): colors, vim, htop, tab-completion,
resize. It starts in the workspace as a login shell, so nvm/PATH are correct.

**It has no approval gate.** The gate constrains Claude; it was never meant to
constrain you. But it means reaching this box's port buys a shell as `dev`,
which is why the server refuses to bind a public interface and leans on the
tailnet for its boundary.

The pane reconnects. If the server restarts or the shell exits, the socket
retries every 3 s and starts a fresh shell — the pane used to stay dead until
the page was reloaded. At most `MAX_SHELLS` (8) shells are open at once; a
page opening sockets in a loop gets close code 1013, not a fork bomb.

**Copy out of it.** A selection goes to the clipboard the moment you let go
of the mouse; Ctrl+Shift+C, Cmd+C or Ctrl+Insert copies it again. In a tmux
session with `mouse on`, a plain drag is tmux's own selection: tmux copies it
and hands it to the pane as OSC 52, and the pane puts it on the clipboard —
this also works from tmux's copy mode, for text long scrolled out of view. To
select with the browser instead, past tmux, hold Shift while dragging (Option
on a Mac). OSC 52 is honoured only within two seconds of a click or key in the
pane, since any program can print it, and a request to *read* the clipboard is
never answered.

**Paste an image into it.** The CLI running in the pane — Claude Code, say —
reads files, not clipboards, so a pasted screenshot would otherwise be nothing
at all: xterm only looks at the text flavour of a paste, and an image carries
none. So the pane catches the paste itself, POSTs the bytes to `/paste/image`,
and types the path it gets back into the pty, followed by a space and no
Enter — the path joins whatever you were typing and you decide when the prompt
goes. PNG, JPEG, GIF and WebP, up to 12 MB.

The bytes land in `/tmp/code-terminal-pasted`, dir `0700` and files `0600`,
beside the screenshot spool and swept by the same pruner (six hours, 40 files,
and never anything written in the last five minutes — the CLI is about to read
it). A paste can be a screenshot of a logged-in page, which is why it is not
left world-readable in the shared `/tmp`. Text paste is untouched.

xterm is served from `node_modules` under `/vendor/*` rather than a CDN, so the
UI works with no outbound network. The same goes for `marked` + `DOMPurify`,
which render Claude's replies as markdown: model output is untrusted (the page
holds an open shell socket), so it is sanitized before it touches the DOM and
links open in a new tab with no referrer.

## Sessions

The Chrome side panel has the same two tabs beside **chat** and **files**, so
a shell and the chooser are there as well; the panel is one column, so they are
views its tabs swap in rather than a second pane. The terminal is about forty
columns wide there — fine for a build, a git command or watching a session, not
for vim. Both hosts run the same file, `extension/term.js`, which the server
also serves to the web UI as `/m/term.js`; the phone page does not load it, so
`/m` keeps chat and files alone.

The right pane of the web UI has three tabs: **terminal**, **sessions**, **files**. The
sessions tab lists the tmux sessions on this machine, with the directory the
current pane is in, what it is running, how long since it printed something,
and whether anybody is attached. Click one and the terminal tab attaches to
it, and the terminal header then reads `session: <name> · <directory>` — the
directory is read back from tmux each time you return to the terminal, so it
follows the session when it `cd`s rather than showing where you attached; **+ new** makes one in the current chat's directory; a session can be
renamed or killed from the row. Renaming happens in an inline field and
killing takes two clicks (**kill**, then **sure?**) rather than a browser
dialog, because an MV3 side panel is not a place to rely on `prompt()` and
`confirm()`.

These are the machine's sessions, not the server's. The other project on this
box (tty) makes `wt_<uuid>` sessions on the same tmux socket and they show up
here unchanged — one set of sessions, two front doors. Nothing is namespaced,
on purpose.

The plain shell tab is still a plain shell. Making every shell a tmux session
would have bought persistence for the surface that needs it least and put
tmux's prefix key in the way of a pane you open, type in and close. You go to
the sessions tab *because* you want something to outlive the tab: a dev
server, a long build, a `claude` run you want back after a reload. The
attachment is remembered in `sessionStorage`, so a reload — or a server
restart — comes back to the same session, and a Chrome window that attached
to one does not drag the others with it.

The agent can look in. `terminal.read` takes `sessions: true` to list them and
`session: "<name>"` to read one, which works when nothing is attached at all —
that is how to ask what a background build is printing without stealing the
pane. It reads; it does not type.

`GET /sessions`, `POST /sessions`, `PUT /sessions/:name`, `DELETE
/sessions/:name`, behind the same guard as everything else. The tab is absent
when tmux is not installed and when `CODETERM_SHELL=0` — attaching to a
session is opening a shell, so it obeys the same switch.

## Right-click and notifications

**Right-click → Ask Claude** on a selection, a page or a link. The side panel
opens with the prompt already sent. `chrome.sidePanel.open()` needs a user
gesture, so it happens inside the `contextMenus.onClicked` handler; the prompt
itself is handed over through `chrome.storage.session`, which works whether
the panel is cold or already open (a `storage.onChanged` listener catches the
second case). The panel claims it once and ignores anything older than a
minute.

**Notifications** when Claude needs you (an approval or a question is waiting)
and when a turn longer than 20s finishes. Short turns are ones you watched
happen, so they stay quiet.

These live in the service worker, not the panel — the panel's socket dies when
you close it, which is exactly when a notification is worth having. It holds a
second, read-only connection: `/ws?observe=1` skips the transcript replay, so
attaching costs 2 events instead of 14.
