# Working on the code

How the pieces fit, how it is tested, and the traps this UI has already fallen
into.

Part of [code terminal](../README.md).

## Contents

- [How it works](#how-it-works)
- [Tests](#tests)
- [The manage and setup pages](#the-manage-and-setup-pages)
- [Four CSS traps in this UI](#four-css-traps-in-this-ui)
- [Screenshots](#screenshots)

## How it works

    browser ─┬─ /ws  ──> session.ts ──Agent SDK──> claude session  (gated)
             └─ /pty ──> shell.ts   ──node-pty───> bash -l         (NOT gated)
                                                    or tmux new-session -A -s <name>

Two WebSocket endpoints, one shared workspace, no shared secret — access is
by network position (Origin + tailscale whois), not a token.

`src/session.ts` holds one SDK session per WebSocket. The prompt is an open
`AsyncIterable` (`src/pushable.ts`), which keeps a single session alive across
turns rather than re-resuming per message — so `interrupt()` and the approval
gate both work.

## Tests

    npm test             # 546 unit tests, node:test via tsx, no browser, no network
    npm run check        # typecheck + the above — what CI gates on
    npm run test:browser # the real client in Chromium against a fixture server (59)
    npm run test:chromium# the server browser, driving a real Chromium (6)
    npm run test:e2e     # boots a real server and session; needs credentials
    npm run test:real    # the actual SDK; costs about $0.30 a run, opt-in

`npm run hooks` points git at `.githooks`, whose `pre-push` runs the same
things before a push leaves the machine — typecheck and unit always, the
browser suites when what they cover has changed — and refuses when one fails
(`--no-verify` overrides). It was added after a commit with a syntax error in
it reached CI.

A browser failure there is rerun once, alone. On a busy box a Chromium page
can stop answering for longer than a click's 30 s — three pages in three
workers at once, 2026-09-22, in a run that took 158 s instead of ~35 — and
that is not a regression. What passes alone lets the push through, named, with
the load and memory pressure at the time; what fails again refuses it. Not
reproduced on demand: 13 runs, idle and with 12 CPU hogs, all passed.

The fixture server a browser test starts exits when the test run does, even a
run that was killed: it watches a stdin pipe the run holds and never writes
to. Before that, an idle one outlived its killed parent; nine were found
running, 9–12 days old.

Which suite a test belongs in is decided by what it needs to launch. Anything
that starts a browser is out of `npm test`: the server-browser suite lived
there until 2026-09-15 and failed twice on GitHub's runner, where the image's
Chrome is not the browser it is written against — it now runs in the browser
job with `CODETERM_CHROMIUM` pointed at Playwright's.

Measured line coverage of
`src/` is 97.7% (`npm run coverage`); every module is above 85%, and the
ones that matter most — auth, files, protocol, store, session, conversation,
attach, browser bridge, tools — are at 98–100%.

The suite is built around three fakes in `test/fakes/`, because the code
under test talks to a `claude` subprocess, a Chrome extension and a tailnet,
none of which a test may touch:

- **`sdk.ts` — a scripted SDK.** `Session` takes the SDK's `query()` through
  `deps.spawnQuery`; the fake records every prompt the session sends, lets a
  test emit any SDK message, end the stream cleanly, or make it throw, and
  exposes `canUseTool` so the approval gate is driven from both sides. Title
  generation (also an SDK call) is injected the same way.
- **`ws.ts` — a socket as the server sees it**, with `frame()` for inbound
  messages and the parsed outbound ones collected.
- **`server.ts` — the whole server in-process** on a free port with temp
  dirs and the fake SDK, so routes and upgrades are exercised over real HTTP
  and real WebSockets without tailscale or credentials. `server.ts` exports
  `boot(config)` for exactly this; the process entry point is a few lines
  under it.

What the tests cover, and deliberately the failure paths as much as the
happy ones: the session's event machine, approvals allowed/always/denied/
aborted/answered/decided-twice, `bypassPermissions` refused, the SDK stream
ending, throwing, and being closed by us; the prompt busy window, dead-session
respawn (with the resume id flushed first — a bug the test found), `/clear`
vs an unasked-for reset, the 3000-event cap, save failures reported once per
outage, pool eviction rules, empty-chat reuse; every WebSocket message kind
including malformed, unknown and ill-typed frames and the bad ids that used
to crash the process; the shell cap; every HTTP route with its 400/403/404s
(traversal, the denylist, over-limit uploads leaving nothing behind, zip
over the cap, cross-site refusal and the deny-log burst cap); the bridge's
hello/replace/timeout/late-reply/disconnect paths; the MCP tools with a fake
extension; graceful shutdown flushing a debounced save and closing sockets
with 1001.

`npm run test:real` runs the same features against the **real** SDK and
your Claude Code login — model list and switch, checkpoint rewind restoring
a file byte-for-byte, a real plan card and the mode switch, an image, a
subagent with its task events, and what the CLI does with `@path`. Opt-in
(`CODETERM_REAL=1`), one scratch session, cost-capped; measured at 7 turns
and $0.30. This is the regression test for the fake in `test/fakes/sdk.ts`:
run it after upgrading the SDK or the CLI.

`npm run test:browser` (Playwright, Python) drives the real client against
a fixture server whose scripted SDK answers prompts, asks for approvals and
asks questions: reconnect without duplicating the transcript, the pty pane
coming back, a prompt typed while offline being queued and sent, streaming
at one render per frame, approval and question cards round-tripping, new
chat and switching back, per-chat mode surviving a reload, downloads with no
blob in page memory, garbage events not breaking the client, and the mobile
page fitting the viewport. Nine of the tests load the real extension into
Chromium (dialogs, eval, tabs, forms, upload, console/network, submit probe,
trusted input, first-run connect) and one drives the server browser.

It runs on four pytest-xdist workers, each with its own fixture server and
browser, in about 27 s (serial: about 100 s; `npm run test:browser:serial`).
Two things make the parallel run reliable, both added after it failed twice in
three runs on tests that passed alone: the ten Chromium-launching tests share
one `xdist_group`, so `--dist loadgroup` keeps them on a single worker instead
of starting four browsers at once; and every wait uses the `SHORT`/`LONG`
constants from `conftest.py` (15 s and 30 s, `CT_TIMEOUT_SCALE` to stretch
them) rather than the 5 s that was losing races to contention rather than to
bugs. Measured after: four consecutive green runs.

Needs `pytest-xdist`: `python3 -m pip install --user pytest-xdist` (add
`--break-system-packages` on a PEP 668 system).

Plus `stripAnsi`, since what the agent reads from the shell pane is raw pty
output and the prompt emits an OSC title before every command; the auth
policy with injected tailscale calls, CIDR parsing, the protocol union (and
a coverage check that the JavaScript client handles every kind), the
heartbeat on fake timers, the whois memo with an injected lookup, upload
streaming (RSS measured), and the nav/mobile layouts.

Two reviews live next to the code and record what was found, what was fixed,
and how each fix was verified: `SECURITY-AUDIT.md` (the trust boundary) and
`PROD-READINESS.md` (memory, performance, edge cases — every item closed).

`test/e2e.test.ts` boots a real server on a free port and drives a real
session, guarding the prompt pipeline — where the slash-command regression
lived, and which the unit tests cannot see. It is opt-in (`CODETERM_E2E=1`)
because it needs working Claude Code credentials; `/context` is a local
command so it costs no inference, and the run takes about ten seconds.

It connects a **fake extension** to `/ext` that answers `active_tab`. Without
one, `activeTab()` returns null, no context is ever attached, and the
slash-command assertion would pass even with the bug reintroduced — so the
first test asserts the fixture is really supplying context before the second
relies on it.

The suite was checked by breaking the code on purpose. Reverting `safePath` to
the string-only version it shipped with first fails exactly the four symlink
cases; removing the `basename` call fails exactly the two upload cases. Reverting
`wantsContext` to `return true` — the slash-command regression — fails six
unit cases plus the end-to-end one. A test that cannot fail is not protecting
anything.

## The manage and setup pages

They are the terminal's own surface, not a second look: `public/pages.css`
carries the same tokens, the same control sizes and the same pill tabs as
`extension/panel.css`, and both pages link it instead of each carrying a
copy of the chrome (they had drifted — one had cards and pills the other
never got). The token block is duplicated rather than imported, because the
extension loads its CSS from disk and cannot fetch a server file; change
one and change the other.

What the restyle was for, beyond matching: a **sticky masthead** with the
page name and the tabs, so navigation survives a long list; a **count on
each tab**, so the bar reports what is behind it; **one dim caption** per
section in the same place, replacing the paragraph some sections had and
others did not; **quiet row actions** that light up on hover, because four
equal buttons shouted over the title they belonged to; and **one filled
button per page** — the thing that page is for.

On **setup**, the eleven checks are grouped by the question they answer
(*does it run · who can reach it · what it may do · working on its own ·
this machine*), a green check has no surface of its own so the amber and
red ones carry the eye, and the banner names the failing check rather than
saying only that something is wrong. On **schedules**, the form asks four
labelled groups instead of twelve fields in one grid, and earlier runs are
a table rather than a bulleted list. On a phone a list row is two lines —
what it is, then what you can do with it — because wrapping them into one
squeezed every title to "Screen…".

## Four CSS traps in this UI

All cost real debugging time; if the transcript ever looks wrong, check these
first.

**`white-space: pre-wrap` must not reach rendered markdown.** `.msg` sets it so
plain text keeps its line breaks, but `.msg.md` holds real HTML from `marked`,
where every newline *between* block tags would render as a visible blank line.
Measured before the fix: a `<ul>` with `margin-bottom: 6px` followed by a `<p>`
with `margin-top: 0` produced a 23px gap. `.msg.md { white-space: normal }`
fixes it; `pre` inside re-enables `pre`.

**A scrolling flex child needs `min-height: 0`.** Without it `#log` cannot
shrink below its content, overflows the column, and pushes the status bar and
input over the transcript. `.pane` in the web UI already had it; the side panel
did not.

**`overflow: hidden` on a container clips its own dropdowns.** The side panel
header sets it so buttons cannot spill at 400px — which silently clipped the
chat picker to the header's height. It opened, populated, and could not be
seen. Popovers live outside the clipped container and are positioned from its
measured height. `#status` and `footer` do not set overflow, which is why the
prompts popup and slash menu were unaffected.

**The `hidden` attribute loses to any explicit `display`.** The UA rule is
`[hidden] { display: none }` at the weakest possible specificity, so
`#log { display: flex }` silently beats it and `el.hidden = true` does
nothing — the chat log stayed visible underneath the file browser. Both files
now declare `[hidden] { display: none !important }`.

Tool lines are `text-overflow: ellipsis` on one line: a long tool argument
(`ToolSearch {"query":"select:mcp__browser__…"}`) is one unbreakable string
that otherwise forces the whole transcript to scroll sideways.

## Screenshots

`screenshot` writes a PNG per call and returns the path, because a HiDPI
capture is ~600k characters of base64 and useless inline. Nothing pruned them,
so a long-running service accumulated them forever.

`pruneScreenshots` runs at boot and after each capture: files older than six
hours go, and beyond forty files the oldest go.

The rule that matters is the recency floor — nothing under five minutes old is
ever deleted. The whole point of a screenshot is that the agent `Read`s the
path a moment later, so letting a count limit delete a fresh one would break
the feature it is tidying up after. There is a test for exactly that, and
removing the floor fails it.

It never throws. Cleaning up must not be able to fail a capture.
