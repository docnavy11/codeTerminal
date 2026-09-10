# code terminal

A web UI over a live Claude Code session. The browser sends prompts, the agent
works in a confined workspace, and every action that could change something
stops for your approval.

Runs on this box (`ubuntu-16gb-nbg1-1-dev-server`) against the Claude Code
OAuth credentials in `~/.claude` — **no `ANTHROPIC_API_KEY`, no API credits.**

## Run

    cp .env.example .env
    npm install
    npm start

Open `http://devserver.tailnet-1234.ts.net:8123/` from any device on the tailnet.
No token, no login.

The server refuses to bind `0.0.0.0` — this box has a public IP
(46.224.183.233) and `/pty` is an ungated shell.

## Authentication

There is no shared secret. Each WebSocket upgrade must pass two independent
checks (`denyReason` in `src/server.ts`):

1. **`Origin`** must be one this server serves itself. WebSockets have no
   same-origin policy, so without this any page you visited could open `/pty`
   and get a shell. Requests with no `Origin` at all (curl, scripts) are
   allowed — a browser always sends one, so absence can't be the attack.
2. **`tailscale whois`** on the peer address must return your own tailnet
   user id. Anything off-tailnet returns `peer not found` and is refused.

Loopback is exempt: a process on this box already has a shell.

Browsing via a `/etc/hosts` alias? Add it to `CODETERM_ORIGINS` or the Origin
check will reject you.

Verified:

    good Origin (magicdns / alias / none)  → CONNECTED
    Origin https://evil.example            → 403 on both sockets
    whois 8.8.8.8                          → null (off-tailnet refused)
    whois MacBook                          → you@example.com, owner match

## How it works

    browser ─┬─ /ws  ──> session.ts ──Agent SDK──> claude session  (gated)
             └─ /pty ──> shell.ts   ──node-pty───> bash -l         (NOT gated)

Two WebSocket endpoints, one shared token, one shared workspace.

`src/session.ts` holds one SDK session per WebSocket. The prompt is an open
`AsyncIterable` (`src/pushable.ts`), which keeps a single session alive across
turns rather than re-resuming per message — so `interrupt()` and the approval
gate both work.

## The shell pane

`/pty` is a real PTY (`node-pty` + xterm.js): colors, vim, htop, tab-completion,
resize. It starts in the workspace as a login shell, so nvm/PATH are correct.

**It has no approval gate.** The gate constrains Claude; it was never meant to
constrain you. But it means the token buys a shell as `dev` on this box, which
is why the server refuses to bind a public interface. `CODETERM_TOKEN` is
stripped from the shell's environment so a stray `env` doesn't disclose it.

xterm is served from `node_modules` under `/vendor/*` rather than a CDN, so the
UI works with no outbound network. The same goes for `marked` + `DOMPurify`,
which render Claude's replies as markdown: model output is untrusted (the page
holds an open shell socket), so it is sanitized before it touches the DOM and
links open in a new tab with no referrer.

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

## Chrome extension

`extension/` is an unpacked MV3 extension that lets the agent read and drive
your real, logged-in browser. Load it via `chrome://extensions` -> Developer
mode -> **Load unpacked** -> pick the `extension/` folder. Its popup shows the
connection state, the server URL, and an on/off toggle.

It dials out to `/ext`. The nine tools reach the agent as an in-process MCP
server (`createSdkMcpServer`), so there is no separate process:

    list_tabs  read_page  snapshot  navigate  click
    fill       press      eval      screenshot

**They are ungated by explicit choice.** Every one is in `allowedTools`, so
none stops to ask - including `eval`, which runs arbitrary JavaScript in
whatever tab you are logged into. Each call is still written to the
transcript. To gate them instead, delete `BROWSER_TOOLS` from the
`allowedTools` line in `src/session.ts` and they fall through to `canUseTool`
like `Bash` does.

Worth understanding before leaving it on: the agent reads untrusted web pages
*and* holds your logged-in sessions *and* can act, with no confirmation step.
A page can contain text addressed to the agent rather than to you. The
extension's toggle is the off switch.

MV3 note: service workers are evicted after ~30s idle, but since Chrome 116
WebSocket traffic resets that timer - hence the 20s ping in `background.js`,
plus a `chrome.alarms` backstop to reconnect if the worker was asleep when the
socket died.

Auth: the extension's `Origin` is `chrome-extension://<id>`, which can never be
a website, so the Origin check does not apply to `/ext`; the `tailscale whois`
check still does. Pin one extension with `CODETERM_EXT_ORIGIN`.

Verified against a real Chrome with the extension loaded: `list_tabs` returned
the live tab id, `read_page` its real text, `snapshot` its one link,
`navigate` moved the tab, and `eval` both read `location.href` and mutated the
live DOM.

## Chats

Conversations are kept as one JSON file each under `chats/`, listed newest
first in the **Chats** picker. The title is the first thing you said. **New
chat** starts a fresh one and keeps the current one; the ✕ deletes.

Only the active chat has a running SDK session — each is a `claude` process,
so keeping every past chat warm would be expensive. Opening an old one resumes
it by its `sdkSessionId`, which rebuilds the model's context from the
transcript on disk. Verified: two chats, switch away, switch back, and the
model still recalled a word from the first one.

Replay is bracketed by `cleared` … `replayed` so a client can tell history
from live events.

## Questions from Claude

`AskUserQuestion` is a built-in tool: Claude uses it to ask *you* something.
It is not a permission prompt, and rendering it as one leaves the question
unanswerable — the turn just parks.

The answer travels back through the permission callback. `AskUserQuestionInput`
carries an `answers` field ("User answers collected by the permission
component"), keyed by the exact question text, so the host returns
`{behavior: "allow", updatedInput: {...input, answers}}`.

The UI renders a distinct blue card: a header chip, the question, one button
per option with its description (and preview, when the option has one), an
automatic **Other** field for a free-text answer, and multi-select where the
question asks for it. The status bar reads `waiting for you — a question`.

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

**Permission mode is app-level, not per-chat.** Set it once and it holds
across new chats and chat switches; the mode is re-stated to every attached
tab on each activation, so the dropdown can never show a mode the session is
not actually in.

It resets to `default` on every server boot, so a process manager restarting
the server cannot re-arm "Never ask". That is the only case worth guarding —
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

## Slash commands

The input box supports `/` commands with autocomplete (arrows, Tab, Esc).
The list comes from `Query.supportedCommands()`, refreshed on the SDK's
`commands_changed` push.

Timing gotcha: with a streaming-input prompt, `system/init` does not arrive
until the *first* turn — but the menu needs the list before you type. So
`supportedCommands()` is called as soon as the query object exists, not from
the init handler.

Not all of them: the CLI advertises `terminal_slash_commands` (here `doctor`,
`color`, `reload-plugins`) whose UX needs a real terminal, and the SDK docs
say remote UIs should hide those. Names starting with `__` are internal and
hidden too. 79 of 82 remain.

## settingSources

`settingSources: ["user", "project"]` loads your `~/.claude` and project
config, which is what makes your own skills available as commands. Measured:

    settingSources: []                  52 commands, 18 skills
    settingSources: ["user","project"]  82 commands, 47 skills

It does **not** weaken the approval gate. An earlier version of this file
claimed `defaultMode: "auto"` in `~/.claude/settings.json` would shadow
`canUseTool`; that was wrong. Measured both ways, with a mutating command:

    settingSources: []                  GATE_CALLED=true  file_created=false
    settingSources: ["user","project"]  GATE_CALLED=true  file_created=false

The explicit `permissionMode` option wins over the settings file's
`defaultMode`. Set `CODETERM_ISOLATED=1` to opt out of loading your config.

## Billing

Draws on your Claude subscription, not API credits. Per Anthropic's support
article, Agent SDK / `claude -p` / third-party-app usage "still draw from your
subscription's usage limits" — a planned move to a separate credit pool was
announced and then paused.

`total_cost_usd` in the UI is a client-side list-price estimate. Anthropic's
docs state it is not billing-relevant for subscribers. Treat it as a relative
throttle signal.

Do not use `--bare` anywhere: it never reads OAuth credentials and fails with
`Not logged in`.
