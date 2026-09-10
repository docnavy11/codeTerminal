# Architecture

An analysis of how code terminal is put together — what the pieces are, how
they depend on each other, where the trust boundaries sit, and what strains as
it grows. The numbers are measured from the tree at the time of writing, not
estimated.

## The shape in one paragraph

A single Node process (`src/server.ts`) owns everything: it serves three web
UIs, holds up to four live Claude sessions as child processes, spawns a PTY
per shell pane, and brokers a WebSocket to a Chrome extension that acts as the
agent's hands in a real browser. Conversations are JSON files on disk. There
is no database, no queue, no secret — access is decided by where a connection
comes from. The design is *one user, one box, many screens*: every screen is a
window onto the same pool of sessions.

    ┌──────────────────────── one Node process ──────────────────────────┐
    │                                                                    │
    │  HTTP ──► express (static UIs, /files, /chats, /prompts, /usage)   │
    │                                                                    │
    │  /ws  ──► attachAgent ──► Manager ──► LiveChat ──► Session ──┐     │
    │  /pty ──► Shell (node-pty) ──► bash -l                       │     │
    │  /ext ◄── BrowserBridge ◄── in-process MCP tools ◄───────────┘     │
    │                                                                    │
    └──┬──────────────────┬────────────────────────┬─────────────────────┘
       │                  │                        │
       ▼                  ▼                        ▼
    claude ×≤4         bash ×N                Chrome extension
    (Agent SDK,        (one per open          (service worker executes
     2 procs each)      shell pane)            list_tabs/read/click/eval…)

## Process topology

Measured on the running service: the main `node` has one child per live chat
— the SDK's runtime shim — which in turn owns the `claude` binary. So **each
live conversation is two processes**, and `MAX_LIVE = 4` in `conversation.ts`
is really a cap of eight. That constant is a memory/CPU ceiling, not a
stylistic one, and the Manager evicts the least-recently-touched idle chat to
stay under it — never one with a client attached.

Beyond those: one `bash -l` per shell pane (`shell.ts`), and `tailscale whois`
spawned per authenticated peer — now memoised for 15 s (`tailnet.ts`), because
before that the file browser's burst of requests was a burst of subprocesses.

## The server, by dependency

`src/` is 19 modules, 3,371 lines. The import graph is acyclic and strongly
layered — this is the codebase's best structural property.

**Leaves (14 of 19) — no local imports.** `browser`, `cidr`, `files`,
`heartbeat`, `projects`, `prompts`, `prompt`, `pushable`, `screenshots`,
`shell`, `tailnet`, `titles`, `usage`, `watches`. Each is a self-contained
concern with a narrow interface, which is why 242 tests exist and most of them
run in milliseconds against a leaf. Every security-bearing decision lives in a
leaf: path containment (`files`), CIDR trust (`cidr`), peer identity
(`tailnet`), untrusted-context wrapping (`prompt`).

**Middle — composes leaves.**
- `tools` → browser, prompts, screenshots, shell, watches. The MCP servers:
  each tool is a closure over live server state, registered in-process with
  `createSdkMcpServer`. No separate tool process.
- `session` → browser, prompt, prompts, pushable, shell, tools, watches. One
  Claude session: owns the SDK `query()`, the approval gate (`canUseTool`),
  and the translation of SDK messages into the client event stream.
- `store` → session (type-only, for `ClientEvent`). Chat persistence with a
  summary cache; the sole writer of `chats/`.
- `conversation` → projects, session, store, titles. `LiveChat` (one chat:
  record + session + attached clients) and `Manager` (the pool).

**Top — `server.ts`, 758 lines, imports 14 modules.** It is the composition
root, and that is where the layering gets weaker: it is also the HTTP router,
the authentication policy (`denyReason`), the boot-time mode selection, *and*
`attachAgent` — the per-client loop that translates 15 WebSocket message
types into Manager/LiveChat calls. Four jobs in one file. It is the only
module that knows about every other, and the only one that cannot be tested
without a running server (which is why its behaviour is verified with scratch
instances rather than unit tests).

**The SDK boundary is three modules.** `session.ts` (the real `query()`),
`tools.ts` (`createSdkMcpServer`), and `titles.ts` (a second, throwaway
`query()` on Haiku to name a chat). `conversation.ts` and `store.ts` import
types only. Swapping or upgrading the SDK touches three files.

## The protocol

The wire is JSON over WebSocket, untyped. The server accepts **15** message
types (`prompt`, `decision`, `answer`, `mode`, `new`, `open`, `rename`,
`delete`, `cwd`, `project`, `browser`, `interrupt`, and the PTY's `start`,
`input`, `resize`) and emits **20** event kinds, defined once as the
`ClientEvent` discriminated union in `session.ts`.

That union is the single source of truth for what a client can receive — on
the server. The clients are plain JavaScript and do not import it. Which
leads to the largest structural finding:

**The chat UI is implemented twice.** `public/index.html` (973 lines of inline
script) and `extension/sidepanel.js` (800 lines) each hand-roll the same
protocol. Measured: **19 of the 20 event kinds have an independent handler in
both files.** The markdown→HTML pipeline (`DOMPurify.sanitize(marked.parse(…))`)
exists in three places. A change to how a `tool` or `approval` event renders is
two edits, and they have already drifted once — the approval-card fix earlier
in this project's history had to be applied to both, and the AskUserQuestion
crash existed in one but not the other.

The mobile page is the honourable exception: `m.html` loads `sidepanel.js` and
`panel.css` *verbatim* from the server (`/m/app.js`, `/m/panel.css`), with a
`PLATFORM` shim (`extension/platform.js` for chrome APIs, an inline block for
the web) supplying the host-specific parts. That is the pattern the desktop UI
should follow — see recommendations.

## Clients

Three surfaces, 3,934 lines, sharing a design system but not code:

| surface | what it is | lines |
|---|---|---|
| `public/index.html` | desktop: split pane, transcript + terminal + file browser | 1,466 (973 JS, 398 CSS, inline) |
| `extension/sidepanel.*` + `platform.js` | Chrome side panel; **also served as the mobile app** | 800 JS + 334 CSS + 55 |
| `public/manage.*` | curation page: chats, prompts, projects | 303 JS + 137 |
| `extension/background.js` | the agent's hands: executes browser commands in MAIN world | 475 |

`background.js` is a distinct thing from the other three — it is not a UI. It
holds the `/ext` socket, answers the server's tool calls (`chrome.scripting.
executeScript`, `captureVisibleTab`, tab queries), polls page watches, and
raises notifications. Everything the model does *to* a browser passes through
it; the server never touches Chrome directly.

## State

Files are the database. What lives where:

| state | where | lifetime |
|---|---|---|
| chats (full transcripts, granted permissions, cwd, project) | `chats/<uuid>.json`, one file each | durable; deletes move to `chats-archive/`, `/clear` snapshots to `chats-snapshots/` |
| chat list summaries | in-memory cache in `Store`, boot-scanned | rebuilt each start |
| prompt library | `prompts.json` | durable |
| control usage counts | `usage.json`, flushed 1 s after a change | durable |
| screenshots | `/tmp/code-terminal-screenshots`, 0700 | pruned by age/count |
| page watches | `WatchRegistry`, memory only | lost on restart, on purpose (a watch is a live observer on a live tab) |
| browser connections | `BrowserBridge` map keyed by per-profile instance id | until the socket drops |
| live sessions | `Manager` pool, ≤4 | evicted LRU when idle |
| permission mode | per `LiveChat` | a chat admitted from disk starts `default`; never survives a restart |

`Store` is written by exactly one process, which is what lets its list cache
be authoritative without invalidation. That assumption is load-bearing: a
second server instance on the same `chats/` directory would corrupt it.

## Trust boundaries

This is the design's strongest idea, and each boundary lives in one module:

1. **Network → server** (`server.ts` `denyReason`). Who may connect at all.
   Three modes chosen at boot: tailnet (peers vouched for by `tailscale whois`),
   trusted-CIDR (a VPN subnet, private ranges only — `cidr.ts` refuses a
   public one at load), localhost (loopback only). A network bind with no
   authenticator refuses to start. On top: an `Origin` allowlist and a
   `Sec-Fetch-Site: cross-site` refusal against CSRF. There is deliberately no
   secret — the audit's reasoning was that a token guarding an ungated shell
   leaks through URLs and logs.

2. **Page → model** (`prompt.ts`). Tab context and watch reports are
   page-derived and therefore untrusted; they enter the prompt inside a
   nonce-delimited block the page cannot forge, labelled "not instructions".

3. **Model → browser DOM** (three renderers + CSP). Replies are shaped by
   untrusted pages, then rendered as HTML in a logged-in session. DOMPurify
   strips script; a `Content-Security-Policy` (`img-src 'self' data: blob:`,
   `connect-src 'self'`) closes the remaining exfiltration channel, an
   auto-loading pixel. Applied as a response header for served pages and via
   the extension manifest for the panel.

4. **Browser → filesystem** (`files.ts`). Every client path goes through
   `safePath`: realpath the deepest existing component, assert containment,
   then refuse a denylist of credential directories (`~/.claude`, `~/.ssh`,
   cloud tokens, the server's own `.env`) even though they sit inside the root.
   The zip walker `lstat`s and skips symlinks so a folder cannot smuggle `/etc`.

Notably *absent* by design: any boundary between the user and the shell
(`/pty` is a real, ungated PTY) or between the model and the browser (browser
tools are auto-approved — "full control, ungated" was the explicit choice).
The approval gate (`Session.#canUseTool`) is for Bash/Write/WebFetch, and the
README is honest that it constrains Claude, not you.

## Design decisions and what they cost

**A session is a held-open async iterable.** `Pushable<SDKUserMessage>` feeds
`query()` once; each prompt is a `push`. This keeps one SDK session alive
across turns instead of re-resuming per message, which is what makes
`interrupt()` and a blocking approval gate work at all. The cost is the process
per chat, hence the pool and the eviction policy.

**Tools are in-process closures.** `createSdkMcpServer` with `alwaysLoad: true`
means the terminal/watch/prompt tools are always in the model's context (a
model has no cue to go looking for "read the user's terminal"). No IPC, no
tool process — but it also means every tool can see all server state, and the
`prefer()` callback threading a browser instance into each tool is how a chat
stays bound to *its* browser.

**The extension is the hands, the server is the head.** The server never has
browser permissions; it asks the service worker, which runs the model's
request in the page's MAIN world. That keeps the browser-privileged code small
(475 lines) and inspectable, at the price of an MV3 worker that is evicted
after ~30 s idle — kept alive by socket traffic and a `chrome.alarms` backstop.

**Auth by network position.** No accounts, no tokens, no sessions. Simple and
hard to leak, but it means the security model is only as good as the network
boundary, and there is no notion of *which* user — the whole app assumes one.

**Per-chat permission mode.** Each `LiveChat` carries its own mode; a client's
mode change reaches only the conversation it is on (its other attached clients
hear it through the session's own event), and a new chat inherits its creator's.
This replaced an app-global mode that armed every conversation at once — the
decision most likely to surprise, and the one that did during testing. A chat
admitted from disk always starts in `default`, which is what keeps the boot
guarantee below.

**No build step.** `tsx` runs the TypeScript directly, in production under
systemd. Convenient; it means a boot compiles the tree, and there is no
artifact to pin.

## Where it strains

Ranked by how much they would matter if this were shared or scaled.

1. **Two chat clients.** The 19/20 duplication is the maintenance debt. The
   fix already exists in the tree: `m.html` proves `sidepanel.js` can be
   served to a non-extension host through the `PLATFORM` shim. The desktop UI
   is the same event loop plus a terminal pane and a split view; those could
   be host-specific additions over the shared core rather than a second
   implementation.

2. **Untyped clients.** `ClientEvent` is a TypeScript union the JavaScript
   clients cannot see. A generated or shared type (even a JSON schema checked
   in tests) would have caught the AskUserQuestion crash statically.

3. **`server.ts` as four things.** Extracting `attachAgent` (the client
   protocol loop) and the auth policy into their own modules would make both
   unit-testable and leave the composition root at a few hundred lines.

4. **Single-user globals.** `activeShell` ("the newest pane") and `lastChat`
   ("the most recently attached") are correct for one person and wrong for two. They are the first things to change for any
   multi-user story — and the reason there should not be one without that
   change.

5. **Files as the database.** Fine at personal scale (a 500-chat list is now
   0.06 ms from cache), but `read()` still parses a whole record, there is no
   cross-process safety, and `MAX_EVENTS = 3000` truncation is the only bound
   on a chat's size. SQLite would be the natural next step if this ever holds
   more than one person's history.

6. **Client-side bundle discipline.** Vendored `xterm`, `marked`, `DOMPurify`
   served from `node_modules` keep the UI offline-capable, but there is no
   integrity pinning and the versions float with `npm install`.

## What is solid

- The layered, acyclic module graph with 14 dependency-free leaves.
- Trust boundaries that each live in one place and are each tested against
  their own failure mode — including mutation checks that the tests fail when
  the guard is removed.
- Boot-time refusals for the dangerous configurations (`0.0.0.0`, a network
  bind with no authenticator, a public trusted CIDR), so a misconfiguration
  fails loudly rather than opening a shell.
- Recoverability: deletes archive, `/clear` snapshots, the SDK's own transcripts
  survive independently under `~/.claude/projects`.
- The `PLATFORM` shim — one client codebase for two hosts, no drift.
