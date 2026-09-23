# Security

## What this program is

code terminal gives a browser UI to a Claude Code session running on your
machine, under your login. Three things in it are dangerous by design, and no
configuration makes them safe to expose:

- **`/pty` is a real shell**, as your user, with no approval gate. Anyone who
  reaches it has your account. `CODETERM_SHELL=0` removes it entirely — no
  route, no pane, and no terminal tool for the agent.
- **The agent can read and drive your logged-in browser** through the
  extension, and can act on sites you have allowed.
- **The file browser and the agent's tools reach your home directory** by
  default (`CODETERM_FILES_ROOT` narrows it; the shell does not care).

It is therefore built to be reachable **only from where you already are**: a
tailnet, a VPN, or localhost. There is deliberately no way to bind `0.0.0.0`,
and no password login — the server admits you by network position and identity
(`tailscale whois`), never by a shared secret. Putting it behind a public port
with a password is not supported and is not a configuration we will help make
work. Behind an authenticating reverse proxy on a private network is fine.

**`CODETERM_TELEGRAM_CONTROL=1` is the one deliberate exception to "never by
a shared secret."** It lets a reply in the configured Telegram chat answer a
pending card, send a new prompt, or talk to the standing "Telegram" chat it
creates on first use — i.e. whoever controls that chat can now drive the
agent, with whatever mode and shell access the target chat's session
already has, from outside the tailnet/identity model entirely. The standing
chat itself runs in **Auto** (the CLI's own judgement of what is safe to
run without asking — the same default a new schedule gets; plain "Ask" left
it stuck on every ordinary command with nobody watching a browser tab to
approve one), so something the CLI judges safe can run before you ever see
a card; anything it is not sure about still raises one, answerable the same
way. A reply that lands in some other chat by falling back to what was last
mentioned inherits whatever mode *that* chat is already in, which may be
more permissive still. Its "secret" is the bot token plus your phone's own
access to that Telegram chat; treat a leaked token or a lost, unlocked
phone accordingly. Off by default, and a separate opt-in from the plain
Telegram notify pair, which only ever sends, never reads.

## The gates that do exist

They constrain *Claude*, not an intruder:

- Every tool that changes something stops for approval, unless you switch the
  mode off.
- Browser sites are allowed per host at two levels (read, act); `eval` asks on
  every call; a form submit with filled fields shows what it would send.
- Per-turn caps on tool calls, screenshots and cost.
- `/mcp` lets another agent prompt and read chats, but never answer their
  cards: what a prompt from there leads to stops for you like any other.
  Its skill tools are the exception, by choice: they write the skills every
  chat loads, with no card (archived on update and removal, never deleted).

See [Running it for real → Authentication](docs/running.md#authentication) and
[The browser](docs/browser-tools.md) for the full model, and
[SECURITY-AUDIT.md](SECURITY-AUDIT.md) for the findings from the audits, each
with how it was measured.

## Reporting a vulnerability

Open a GitHub security advisory on this repository ("Report a vulnerability"
under Security), or a normal issue if it is not sensitive. There is no bounty
and no SLA; this is one person's project. Please say what you did, what
happened, and what you expected — a reproduction beats a scanner report.

## Scope

In scope: anything that lets a request from outside the trusted network reach
the agent, the shell, the files or the browser bridge; anything that lets a
*page the agent visits* reach the server (prompt injection with real effects,
XSS in the transcript); anything that writes outside the configured roots.

Out of scope: the shell being a shell, the agent doing what you approved,
`CODETERM_BROWSER_GATE=0` or "Never ask" mode removing the gates you removed,
and anything that requires already being on the trusted network with your
identity.
