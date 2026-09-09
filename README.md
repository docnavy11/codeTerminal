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

## settingSources

`settingSources: []` is load-bearing. Omit it and the SDK loads
`~/.claude/settings.json` — whose `defaultMode: "auto"` would hand approval
decisions to the classifier instead of you, and which pulls in CLAUDE.md,
skills and plugins (~11k tokens per turn).

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
