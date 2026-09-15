# code terminal

A web UI, a Chrome side panel and a mobile page over one live Claude Code
session. You type, the agent works in a workspace on your machine, and every
action that could change something stops for your approval. Beside it: a real
terminal, a file browser, saved prompts, and page watches that report back
when a tab changes. It uses your Claude Code login — no API key, no credits.

| desktop `/` | side panel | mobile `/m` |
|---|---|---|
| ![desktop](docs/desktop.png) | ![side panel](docs/panel.png) | ![mobile](docs/mobile.png) |

> **Read this before you expose it.** The terminal pane is a real shell as
> your user, with no approval gate, and the agent can drive your logged-in
> browser. It is built to be reachable only from where you already are — a
> tailnet, a VPN, or localhost — and it refuses to bind `0.0.0.0` on purpose.
> There is no password login, by design. `CODETERM_SHELL=0` removes the shell
> if you want everything else without it. See [SECURITY.md](SECURITY.md).

## Quick start

You need **Node ≥ 22** and a **Claude Code login** — the agent runs on the
OAuth credentials in `~/.claude`, so run `claude` once on this machine and
log in (`npm i -g @anthropic-ai/claude-code` if you do not have the CLI).

    git clone https://github.com/docnavy11/codeTerminal.git && cd codeTerminal
    npm install
    npm start

Open **http://127.0.0.1:8123/**. That is localhost mode: reachable from this
machine only, nothing else to configure. The first chat explains the pieces,
and **http://127.0.0.1:8123/setup.html** checks each step live — login,
tool servers (every in-process MCP server the last session start reported,
red if one failed to connect), network mode, extension, phone, service,
paths — and tells you what to do next, including the exact address to
paste into the extension.

- **Phone or another device:** bind a tailnet or VPN address instead — see
  [Authentication](docs/running.md#authentication). There is deliberately no way to bind
  `0.0.0.0`: the shell pane is a real shell.
- **Browser control** (read and drive your tabs, page watches): load
  `extension/` at `chrome://extensions` → Developer mode → *Load unpacked*,
  click its icon, enter your server as `ws://127.0.0.1:8123/ext`, press Enter.
  The side panel opens from the same icon. Reload the extension after pulling.
- **Mobile page:** `http://<host>:8123/m` — add it to the home screen.
- **As a service** (Linux, systemd): `sudo deploy/install.sh` — see
  [Running as a service](docs/running.md#running-as-a-service).

Configuration is one `.env` (copy `.env.example`; every line is optional, and
every line is explained there). Where the chats, prompts and the rest are kept,
and how to move an installation, is
[Config, state, and moving an installation](docs/running.md#config-state-and-moving-an-installation).

### Platforms

Developed and run on Linux (Ubuntu, x64) — that is where everything below
was measured. macOS in localhost mode should work (`node-pty` ships
prebuilds; nothing here is Linux-only except the systemd unit and the
`tailscale` CLI, which localhost mode never calls) but **has not been
tested**. Windows is not supported: the shell pane spawns `bash -l`.


## Where to read what

Start with the quick start above. After that, by what you are trying to do:

| If you want to… | Read |
|---|---|
| **Try it on this machine** | the quick start above, then [Using it](docs/using.md) |
| **Reach it from a phone or another device** | [Running it for real → Authentication](docs/running.md#authentication) |
| **Run it as a service, move it, back it up** | [Running it for real](docs/running.md) |
| **Know what every button and card does** | [Using it](docs/using.md) |
| **Let the agent read and drive your browser** | [The browser](docs/browser-tools.md) |
| **Have it work while your laptop is off** | [Working while you are away](docs/automation.md) |
| **Understand or change the code** | [Working on the code](docs/development.md), then [ARCHITECTURE.md](ARCHITECTURE.md) |
| **Judge whether it is safe to expose** | [SECURITY.md](SECURITY.md), then [SECURITY-AUDIT.md](SECURITY-AUDIT.md) |

Two review documents sit beside those: [SECURITY-AUDIT.md](SECURITY-AUDIT.md)
and [PROD-READINESS.md](PROD-READINESS.md), each finding recorded with how it
was measured. [BROWSER-IMPROVEMENTS.md](BROWSER-IMPROVEMENTS.md) and
[TUI-GAPS.md](TUI-GAPS.md) are the feature lists and their status. The design
notes under `docs/` say why a feature is shaped the way it is.

## How it works, in one paragraph

One server process holds one live Claude Code session per chat, through the
Agent SDK, and speaks a single WebSocket protocol to whichever client is
attached — the web page, the Chrome side panel or the phone page, which are
[the same client file](docs/development.md#how-it-works) with a shim for the
three hosts. Every tool the agent wants to run that could change something
comes back to you as a card and blocks the turn until you answer. The agent's
extra reach — your browser tabs, your terminal pane's output, page watches,
prepared prompts, files it prepares for you — is a set of in-process MCP
servers, so there is no second process to run or keep alive.

Everything below this line in the other documents is design notes: what each
part does and, more importantly, why it is built that way, including what went
wrong the first time.
