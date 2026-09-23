# Running it for real

Installing it as a service, who is allowed to reach it, where the config and the
state live, and how to move an installation to another machine.

Part of [code terminal](../README.md).

## Contents

- [Running as a service](#running-as-a-service)
- [Managing the service](#managing-the-service)
- [Authentication](#authentication)
- [Config, state, and moving an installation](#config-state-and-moving-an-installation)
- [Using it from other agents (MCP)](#using-it-from-other-agents-mcp)
- [Limits](#limits)
- [Billing](#billing)
- [settingSources](#settingsources)

## Running as a service

    sudo deploy/install.sh

Renders `deploy/code-terminal.service` for the user running it (`__USER__`,
`__HOME__`, `__REPO__` are filled from `sudo`'s caller and the checkout),
installs it as a system unit and enables it, so it comes back after a
reboot. Then:

    journalctl -u code-terminal -f
    sudo systemctl restart code-terminal

A system unit rather than a `systemctl --user` one, so it starts at boot with
no need for `loginctl enable-linger`.

Three things the unit has to get right:

- **`HOME` is set explicitly.** The Agent SDK reads the Claude Code OAuth credentials
  from `~/.claude`, and `settingSources` loads your config from there. Without
  it the service starts and every turn fails to authenticate.
- **No shell, so node comes from `nvm-exec`.** systemd runs no shell, so nvm is
  never set up. `ExecStart` runs `~/.nvm/nvm-exec node tsx/dist/cli.mjs` with
  `NODE_VERSION=default`, so the service follows your `nvm alias default`
  instead of naming one exact version that the next `nvm install` would
  orphan. Without nvm, point `ExecStart` at any node ≥ 22 (`engines` in
  package.json). The PTY still gets a working `PATH` because it spawns `bash -l`,
  which sources `~/.profile` → `~/.bashrc` → nvm; verified `node -v` inside the
  shell pane under the service's environment.
- **The bind is retried, not assumed.** At boot the server can start before
  tailscaled has assigned `100.64.0.1`, and binding a missing address fails
  with `EADDRNOTAVAIL`. `listenWithRetry` backs off up to 30s instead of dying,
  which also covers tailscale restarting or the address changing.

The unit is deliberately not sandboxed: the agent runs Bash and edits files by
design, and `/pty` is a real shell, so `ProtectSystem` and friends would break
the product rather than secure it.

Permission mode is per conversation, and a chat loaded from disk always starts
in `default`, so a restart can never leave "Never ask" armed.

## Managing the service

`deploy/sudoers-code-terminal` removes the password prompt for
restart/start/stop of this one unit, for the user the service runs as:

    sudo deploy/install.sh --sudoers

It grants no new ability to a user who already has sudo. What it removes is
the *password*, which matters because the agent's `/pty` shell runs as that
user with no password to offer, so a NOPASSWD rule is the only sudo
reachable from inside the product.

No escalation: the unit runs as that user and its file is root-owned, so a
restart starts the user's own code as the user.

A restart is clean. systemd stops the unit with SIGTERM, and the server
handles it: every live chat's pending save is flushed (transcript writes are
debounced 400 ms, usage counts 1 s — both used to be lost on every restart),
sessions are closed, sockets get a 1001 so clients reconnect rather than
guess, and the process exits within 1.5 s. `[SIGTERM] shutting down` in the
journal is the line to look for.

`status` is deliberately absent. It needs no privilege, and under `sudo` it
spawns a pager as root — and a pager runs shell commands (`!sh`), so including
it would hand out a root shell. Same reasoning keeps `journalctl` out; both
already work unprivileged.

## Authentication

There is no shared secret. On a tailnet, each WebSocket upgrade must pass these
independent checks (`denyReason` in `src/server.ts`); on a laptop it runs in
[localhost mode](#localhost-mode) instead:

1. **`Origin`** must be one this server serves itself. WebSockets have no
   same-origin policy, so without this any page you visited could open `/pty`
   and get a shell. Requests with no `Origin` at all (curl, scripts) are
   allowed — a browser always sends one, so absence can't be the attack.
2. **`tailscale whois`** on the peer address must return your own tailnet
   user id. Anything off-tailnet returns `peer not found` and is refused.

A third guard backs up the first: a request whose **`Sec-Fetch-Site`** is
`cross-site` is refused outright. That closes the one gap the `Origin` check
leaves — a simple cross-site request (`<img>`, a `<form>` GET) carries no
`Origin`, but the browser sets `Sec-Fetch-Site` and page JavaScript cannot
forge it. Same-origin requests and non-browser clients (which omit it) pass.

Loopback is exempt: a process on this box already has a shell.

Browsing via a `/etc/hosts` alias? Add it to `CODETERM_ORIGINS` or the Origin
check will reject you.

Verified:

    good Origin (magicdns / alias / none)  → CONNECTED
    Origin https://evil.example            → 403 on both sockets
    Sec-Fetch-Site: cross-site             → 403 (CSRF-shape refused)
    whois 8.8.8.8                          → null (off-tailnet refused)
    whois MacBook                          → you@example.com, owner match

### Localhost mode

To run it on your own laptop instead of a tailnet box, bind loopback:

    CODETERM_HOST=127.0.0.1 npm start

With a loopback bind and no tailnet identity, the server enters **localhost
mode**: it serves this machine only, and needs no tailscale — a laptop with
nothing installed just works. `CODETERM_LOCALHOST=1` forces it even where
tailscale is present (a purely local run on a tailnet-joined laptop).

The one safety rule: localhost mode must be loopback-bound. A network-reachable
bind with no tailnet identity would be an ungated shell with no authentication,
so that combination refuses to start. Loopback peers are always allowed (a
process on this box already has a shell); cross-site requests are still refused.

    localhost mode + 127.0.0.1        → serves this machine, no tailscale
    localhost mode + a network bind   → refuses to start
    tailnet identity present          → tailnet mode, unchanged

Note this changes *which filesystem the agent works on* — your laptop's files,
not the VPS's. Point the Chrome extension at `ws://localhost:8123/ext` in its
popup, and it drives the browser on the same machine as before.

### Without tailscale, on a VPS

The whole network boundary is `tailscale whois`. If you do not run tailscale,
there are three shapes, in order of how well they hold up:

**1. SSH tunnel — recommended.** Run in localhost mode on the VPS
(`CODETERM_HOST=127.0.0.1`) and forward the port from your laptop:

    ssh -L 8123:localhost:8123 your-vps

Open `http://localhost:8123`. The connection reaches the server as loopback
(sshd connects to `127.0.0.1:8123` on the VPS side), so it passes the loopback
exemption; `localhost` is already an allowed Origin. **SSH is the
authentication** — a stronger boundary than any token, and you already have it.
No code, nothing to install.

**2. A reverse proxy or tunnel with its own auth.** Caddy, nginx, oauth2-proxy,
`cloudflared`, Tailscale Funnel — anything on the same box that connects to the
server over loopback inherits the exemption (verified: a loopback proxy is
accepted, and a spoofed `X-Forwarded-For` is ignored). The proxy's auth — basic
auth, OAuth2, Cloudflare Access, mTLS — becomes the boundary. Add the public
hostname so the Origin check accepts it:

    CODETERM_ORIGINS=claude.yourdomain.com

> **The sharp edge.** The server trusts loopback unconditionally and reads no
> forwarded headers, so the proxy's auth is the *only* thing between the
> internet and a root-equivalent ungated shell. A proxy with no auth, or one
> with an SSRF that reaches `localhost:8123`, is full remote code execution.
> Only do this if the proxy auth is solid and nothing else on the box can hit
> that port.

**3. WireGuard (or another VPN).** Bind the tunnel interface's IP and trust the
tunnel subnet with `CODETERM_TRUSTED_CIDRS`; peers inside it are treated like
loopback and never touch tailscale:

    CODETERM_HOST=10.44.0.1
    CODETERM_TRUSTED_CIDRS=10.44.0.0/24,fd00::/8

Binding the tunnel IP (not `0.0.0.0`, which is refused) is what keeps the port
off the public interface; the CIDR list then says which tunnel peers to admit.
Every entry must be a private range — a public one, or `0.0.0.0/0`, **refuses to
start** rather than opening the shell to a typo. Browse to the bound IP, or add
your chosen name to `CODETERM_ORIGINS`.

Verified on isolated servers: a network bind with no tailscale and a trusted
CIDR boots and admits a peer from inside the range without ever spawning
`tailscale`; the same bind with no CIDR refuses; `0.0.0.0/0` and a public
address mixed into the list both refuse at boot.

**Not supported: a public port with a shared password.** The original token
was removed on purpose — a secret in a URL guarding an ungated shell leaks
through logs, referrers and history. Access here is by network position.

    localhost mode + ssh -L               → SSH is the auth (recommended)
    same-box proxy/tunnel with auth       → the proxy is the auth (mind the edge)
    tunnel IP + CODETERM_TRUSTED_CIDRS    → the VPN is the auth
    public port + password                → not offered

## Config, state, and moving an installation

**Settings** are one file: `.env` at the repo root, every key documented in
[.env.example](../.env.example). The systemd unit reads it through
`EnvironmentFile=`, and since 2026-09-15 the server reads it itself as well —
before that, `npm start` from a shell ignored `.env` entirely, so every
setting the docs told you to put there applied only under the service. A real
environment variable still wins over the file.

**State** is what the server writes: `chats/`, `workspace/`, `prompts.json`,
`schedules.json`, `usage.json`, `browser-allow.json`, and the server
browser's Chromium profile under `server-browser/profile/` (hundreds of MB,
and it holds real logins). By default all of it sits beside the source, which
is why "copy my installation" used to mean knowing which six files and two
directories among the source were yours. **`CODETERM_STATE=/var/lib/code-terminal`
keeps all of it in one directory instead**; each item still has its own
variable (`CODETERM_CHATS`, `CODETERM_PROMPTS`, …) which wins over it. Setting
it moves nothing: a file that already exists at the repo root keeps being
used until you move it deliberately, so an existing install cannot be
stranded by the setting. The setup page lists every one of these paths under
**Config and state**.

**Moving it** is two commands:

    deploy/backup.sh                     # → code-terminal-backup-<stamp>.tar.gz
    deploy/backup.sh --with-profile      # …including the browser profile's logins

    git clone <this repo> /srv/ct && cd /srv/ct && npm install
    deploy/restore.sh ~/code-terminal-backup-*.tar.gz /srv/ct

The backup asks the server where its state actually is rather than guessing,
so it follows `CODETERM_STATE` and the individual variables. Restore refuses
to overwrite an existing `chats/` without `--force`, and stops the service
only when it is restoring into the installation that service runs from.

Not in the backup, by design: `node_modules` (`npm install`), the source
(`git clone`), and your Claude Code login in `~/.claude` — that belongs to
the machine, not to this app, so a new machine needs `claude` run once and
logged in. After restoring, check `CODETERM_HOST` in `.env`: it names the old
machine's address.

## Using it from other agents (MCP)

The server is also an MCP server, at `/mcp` (Streamable HTTP), so Claude Code
on a laptop, Claude Desktop or any MCP client on the tailnet can work with the
chats here:

    claude mcp add --transport http codeterminal http://<host>:8123/mcp

| Tool | What it does |
|---|---|
| `list_chats` | the conversations, newest first |
| `read_chat` | a chat's recent history, and whether it is busy or waiting for you |
| `send_prompt` | prompt a chat (or a new one, optionally in a project, optionally a saved prompt) and, by default, wait for the reply |
| `notify` | send you a Telegram / webhook notification, titled "via MCP · …"; at most 10 per 10 minutes (only when a target is configured) |
| `stop_chat` | interrupt the turn a chat is running |
| `list_schedules` | the scheduled prompts |
| `list_terminals`, `read_terminal` | the tmux sessions and their recent output (only with the shell on) |
| `search_chats` | full-text search across every conversation |
| `export_chat` | a whole conversation as Markdown, as the app exports it |
| `list_projects`, `list_prompts`, `list_watches` | the projects, the saved prompts, the page watches |
| `spend` | cost per chat and in total — per chat only: turns carry no timestamps |
| `list_files`, `read_file` | the file browser's root, with its denylist (keys, credentials, `.env`) |
| `health` | version, auth mode, browsers connected, whether a session has come up |
| `list_skills`, `read_skill` | the Claude Code skills in `~/.claude/skills` (or a project's `.claude/skills`) |
| `install_skill`, `remove_skill` | install or update a skill (SKILL.md plus files), or remove one; see below |

Of the rest, only `install_skill` and `remove_skill` write.

The skill tools have **no approval gate**, by the owner's choice (one user,
tailnet only). That is a real grant: a skill is instructions every new chat
loads — the Auto-mode Telegram chat and scheduled runs included — so whatever
can call `/mcp` can change what all of them do from then on. Nothing is
deleted: an update moves the old version to `skills-archive/` beside the
skills directory first, and a removal is the same move, so either is undone
with one `mv`. New chats pick a change up; a chat already running keeps what
it started with.

It sits behind the same check as every other route — the tailnet owner,
loopback, or a trusted CIDR; never a page on another origin — so an MCP
client needs no token, and nobody else gets in.

What it cannot do, on purpose: answer an approval card. The caller is itself
an agent; if it could approve the Bash its own prompt led to, the gate would
be a formality. A turn that stops on a card comes back as `waiting`, with the
chat's link, and the card waits for you in the browser. The browser tools are
not offered either — their site gate asks in a chat, and there is none on the
caller's side to ask in.

The gate is the chat's own, so its mode decides: a chat set to *Never ask*
has no cards, and a prompt sent to it runs whatever it leads to. Chats
`send_prompt` creates start in the default, *Ask before changes*.

## Limits

Three ceilings, all in `.env`, all chosen as "a legitimate turn should never
get here" rather than measured: **`CODETERM_MAX_TOOL_CALLS`** (100) interrupts
a turn that keeps calling tools and says so in the transcript;
**`CODETERM_MAX_SCREENSHOTS`** (15) makes the screenshot tool refuse past that
many in one turn and tell the model to report what it has; **`CODETERM_MAX_BUDGET_USD`**
(unset) is the SDK's own cost ceiling for a session. The turn that motivated
them made 56 tool calls and 20 screenshots without a word of output.

When a turn ends early — turn limit, cost ceiling, an execution error, a
model refusal — the end line says **why**, in red, instead of `done`. API
retries during an outage are shown as they happen (`API retry 2 of 10 in
4s (HTTP 529)`); they used to look like thinking.

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
