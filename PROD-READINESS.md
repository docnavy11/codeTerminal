# Production-readiness review

A file-by-file pass over the current tree — server, clients, extension,
deploy — for anything that would bite in production: memory, performance,
security, correctness, edge cases. Every finding marked **proven** was
reproduced on an isolated scratch server or measured in a real browser;
**code-read** means the defect is visible in the source and the failure path is
stated, but it was not executed (usually because doing so costs a real model
turn). Severity is for a single-user deployment; "oss" notes where sharing
raises it.

The earlier security audit (SECURITY-AUDIT.md) is fully closed and its fixes
were re-verified live during this pass. This review is about what is *left*.

---

## Fix before calling it production — **all five fixed** (see "Fixed" below)

### 1. The transcript duplicates on every reconnect — **proven**
`extension/sidepanel.js` (`connect()` / `handle()`). On reconnect the server
replays the whole transcript; the client appends it to a log it never cleared.
Measured with a seeded chat: 2 user turns / 1 turn-end before a server restart,
**4 / 2 after** — the transcript doubled. Every restart, every laptop sleep,
every wifi blip. The heartbeat added this session makes reconnects *more*
frequent, so this now matters more than before.
Fix: clear `#log` and reset `cost`/`lastText`/`streaming` in `ws.onopen`
before the replay arrives (or have the server send `cleared` on attach).

### 2. Renaming a chat spawns a Claude subprocess — **proven**
`src/attach.ts` `rename` / `src/server.ts` `POST /chats/:id`. Both call
`convo.get(id)`, which *admits* the chat into the live pool to reach `rename()`
— and admitting spawns the SDK session (two processes). Measured from a cold
pool: server children 0 → 1 on a rename. A batch rename on the manage page is a
subprocess per row, each evicting an idle live chat to make room.
Fix: a `Manager.rename()` / `setProjectRecord()` that edits the on-disk record
when the chat is not live; only a live chat needs its `LiveChat`.

### 3. No graceful shutdown — **proven absent**
`src/server.ts` has no SIGTERM/SIGINT handler and `Manager.shutdown()` is never
called. `systemctl restart` therefore loses up to 400 ms of transcript (the save
debounce) and 1 s of usage counts, and SDK children die by cgroup SIGKILL
rather than a clean `close()`.
Fix: on SIGTERM, flush every `LiveChat` save, `close()` sessions, then exit.

### 4. A dead SDK session looks alive — **code-read**
`src/session.ts:159-163`. The session's whole life is `for await (msg of
query)`. If the subprocess *throws*, the client gets an error. If the iterable
simply *ends* — subprocess exit, OOM-kill, SDK closing the stream — nothing is
emitted, `#busy` is left wherever it was, and the next `send()` pushes into a
`Pushable` nobody reads: the prompt is swallowed and the chat sits there
looking idle. Not executed (it needs two real turns to prove); the clean-end
path is provably silent from the source.
Fix: after the loop, mark the session dead, emit an error, and have
`LiveChat` respawn on the next `send()`.

### 5. Two prompts in quick succession both go through — **code-read**
`src/attach.ts:73-85` + `src/session.ts:252`. `busy` is set inside
`session.send()`, which runs *after* `await bridge.activeTab()` — up to
2.5 s. A second `prompt` arriving inside that window passes the `chat.busy`
check and both messages reach the SDK back-to-back.
Fix: a synchronous `pending` flag set before the await.

---

## Medium — all fixed (see "Fixed" below)

### 6. Streaming re-renders the whole reply on every token — **proven**
`sidepanel.js` `delta` handler re-parses the entire accumulated markdown per
delta. Measured: a 24 KB reply (700 deltas) costs **3.2 s of main-thread
time**, the last delta 13.6 ms versus 7.6 ms to parse once. It is O(n²) in
reply length; long replies visibly jank.
Fix: throttle to one render per animation frame / 50 ms.

### 7. The desktop terminal never reconnects — **proven**
`public/desktop.js` has no retry path (the agent socket has one). After a
server restart the chat comes back; the terminal shows "[disconnected]" until
the page is reloaded.

### 8. The composer silently drops input while reconnecting — **code-read**
`sidepanel.js:313`. `sendBox()` returns with no feedback when the socket is
not open. `submit()` (the context-menu path) queues instead; `sendBox` should
do the same, or say so.

### 9. Extension page-watches vanish on worker eviction — **code-read**
`extension/background.js:225`. Watches live in a `Map` inside the MV3 service
worker. When Chrome evicts the worker, the map is gone; the server's registry
still lists the watch, which never fires until it expires.
Fix: mirror to `chrome.storage.session` and rehydrate on start.

### 10. Every "New chat" persists an empty record — **proven**
`src/conversation.ts` `create()` writes the record before any message exists.
Measured: a fresh store + one attach = one 0-event "New chat" file. Abandoned
empties accumulate and appear in the picker.
Fix: persist on the first user event, or garbage-collect zero-event records.

### 11. The systemd unit hardcodes an nvm path
`deploy/code-terminal.service` names `/home/dev/.nvm/versions/node/v22.22.1/`
twice; `package.json` declares no `engines`. An `nvm install` breaks the
service at the next restart.
Fix: a stable symlink (or system node) and an `engines` field.

### 12. Persistence failure is silent
`src/store.ts:97` swallows every write error. A full disk loses transcripts
with nothing in the journal. Log it.

### 13. The whois memo never evicts — **code-read**
`src/tailnet.ts`. One entry per distinct source IP, negative results included,
never removed. Bounded by tailnet exposure today; a slow leak behind a proxy
or in CIDR mode. Sweep expired entries on insert, or cap the map.

### 14. Downloads are buffered in browser memory
`sidepanel.js:557, 597`. `fetch → blob → objectURL`: a 500 MB zip is 500 MB in
the tab. Same-origin hosts (desktop, mobile) can stream through `<a download
href>`; only the extension needs the blob path.

---

## Low

- **Response streams are not tied to client abort** (`server.ts:325, 352`):
  `.pipe(res)` leaves the file/zip stream reading after the client goes away.
  Use `pipeline`.
- **`ws.onmessage` parses unguarded** (`sidepanel.js:62`): a malformed frame
  throws inside the handler.
- **`ws.send` without `?.`** in `renderApproval`/`renderQuestion`
  (`sidepanel.js:197, 257`): TypeError if clicked before the first connection.
- **`projects()` does sync `readdir`+`stat`** of the projects root on every
  attach and every `/chats` (79 directories here) — sync FS on a hot path.
- **`close()` does not `interrupt()`**: deleting a busy chat lets the SDK
  finish the turn first (wasted tokens).
- **Timing-based tests** (heartbeat at 20 ms, whois memo `>2 ms`, upload
  `RSS < 40 MB`) are flaky risks under CI load.
- **Deny logging is unbounded**: one `console.warn` per refused request.
- **`readTextPreview`** can split a multibyte UTF-8 character at the cap.
- **`list()`** shows an escaping symlink as a normal file (opening it is
  blocked by `safePath`; cosmetic).
- **`MAX_LIVE = 4`** is really eight processes; there is no cap on `/pty`
  shells per client.
- **`.env` is 0644** (no secrets in it today).

---

## Fixed in this pass

| # | Fix | Verified by |
|---|-----|-------------|
| 1 | `ws.onopen` resets the log and reply state before the replay | Playwright on a scratch server: 3 user turns / 10 nodes before, **3 / 10** after two server restarts (was 2→4) |
| 2 | `Manager.rename / touch / setProject` edit the record on disk when the chat is cold; the HTTP route and the ws `rename` use them | Scratch server: children 0 → **0** after a rename, title changed on disk; `test/manager.test.ts` asserts `live(id)` stays undefined |
| 3 | SIGTERM/SIGINT → `convo.shutdown()` (flushes every pending save), `usage.save()`, ws close 1001, exit | Scratch server: SIGTERM sent immediately after a `turn_end`; the file on disk had the final `text` and both `turn_end`s; ws closed with 1001; process exited |
| 4 | Session marks itself dead when the SDK stream ends, resolves pending approvals, emits one error; `LiveChat.prompt()` / `watchFired()` respawn a dead session (resuming the same conversation) | Scratch server: `SIGKILL` of the SDK child → status `idle`, one error event; the next prompt was answered (`PONG`) by a respawned session |
| 5 | `LiveChat.prompt()` holds a synchronous `#sending` flag across the tab lookup; `busy` covers it | Scratch server: two prompts sent back-to-back — the second got "Still working — press Stop first.", the transcript has one user event for the pair |
| + | **Found while fixing 2:** a ws `rename`/`open`/`delete` with a non-uuid id threw inside the message handler — an uncaught exception that **killed the server** (proven: `alive: "dead"` before, `200` after). The dispatch is now wrapped and the Manager treats a bad id as "no such chat". | Scratch server, before/after |

| 6 | Streaming renders once per animation frame (`scheduleStreamRender`); the final `text` event still renders the full reply | 700 deltas / 23.8 KB through the real `handle()` on a scratch server: **6092 ms → 1 ms** of synchronous main-thread time; the frame after shows the full text rendered |
| 7 | `desktop.js` pty socket retries every 3 s and starts a fresh shell; "[disconnected — reconnecting…]" once per outage, "[reconnected — new shell]" on return | Scratch server killed and restarted under an open desktop page: `ptyWs.readyState` back to 1, prompt redrawn |
| 8 | `sendBox()` queues through `submit()` while the socket is down (box clears, status shows "reconnecting… (n queued)"); the queue drains one prompt per connect / turn end | Prompt typed while the server was down: box emptied, status "reconnecting… (1 queued)", after restart the user turn appeared and was answered ("OK") |

| 9 | Extension watches are mirrored to `chrome.storage.session` on every change and restored when the worker starts | Extension loaded in Chromium: worker boots with no console errors, `storage.session` readable. **The eviction → restore round trip itself is not measured** (the worker's module scope is not reachable from outside); `persistWatches()` is called at all six mutation sites |
| 10 | `Manager.create()` reuses an abandoned 0-turn "New chat" from disk, and "new" while on an unused chat returns that chat | Scratch server with one cold empty record: two "new" clicks → files on disk 2 → **2**, active chat is the reused one |
| 11 | Unit runs `nvm-exec node` with `NODE_VERSION=default`; `engines: node >= 22` in package.json | `nvm-exec` under the unit's exact environment (`env -i` + the unit's PATH) resolved `v22.22.1`. **Not yet installed** — `/etc/systemd/system` needs a password; the sudoers rule only covers restart/start/stop |
| 12 | `Store.write()` returns false and logs `[store] write failed`; `LiveChat` tells its clients once per outage | `test/store.test.ts`: read-only directory → `false`, one log line, `true` again after chmod. The client-facing message is code-read |
| 13 | whois memo capped at `WHOIS_CACHE_MAX = 512` (expired swept first, then oldest) | `test/tailnet.test.ts`: 1536 distinct IPs with a stub lookup → size ≤ 512, freshest still memoised |
| 14 | Desktop/mobile download via a plain link (file) or a form POST into a hidden same-origin iframe (zip); only the extension buffers a blob. `frame-src 'none'` → `'self'`; the zip route also accepts urlencoded | Playwright on the desktop page: 405 KB file and a 2-file zip saved with the right names, **0 blob: URLs**, no page-side fetch. Trade-off: a zip error (too large, nothing selected) lands in the hidden iframe and is not shown |

Not measured: the *clean-end* branch of 4 (stream ends without throwing). The probe exercised the throwing branch (`terminated by signal SIGKILL`); the post-loop code runs on both.

---

## Re-verified as solid during this pass

Auth policy (all three modes, extension origin, cross-site refusal, pinned
extension), CSP on every served page and in the manifest, path containment and
the credential denylist, symlink-safe zip walking, capped preview reads,
streamed uploads, per-chat permission mode, server heartbeat, the whois memo,
protocol validation, and the one-client/three-hosts client structure.

---

## Suggested order

1–5 first; they are the ones a user meets in the first day (1 on the first
reconnect, 2 on the first rename, 3 on the first restart). 6–8 are the
next-most-visible. 9–14 before sharing. The Low list is hygiene.
