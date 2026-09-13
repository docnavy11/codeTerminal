# The browser: Chrome extension and tools

Moved out of the README on 2026-09-13; the README keeps a summary and points
here. Everything below is the design and the measured behaviour of the
extension and of each browser tool, in the order the pieces were built.
The tracking list with status per improvement is
[../BROWSER-IMPROVEMENTS.md](../BROWSER-IMPROVEMENTS.md); the survey of
other tools that shaped it is [browser-research.md](browser-research.md).

The manifest's `content_security_policy.extension_pages` is the panel's
counterpart of the server's CSP: it renders model replies, shaped by
untrusted page content, in a logged-in context. `img-src`/`media-src` are
locked to the extension's own origin plus `data:`/`blob:` so an injected
off-origin pixel cannot exfiltrate what the model saw; `script-src 'self'`
means injected markup cannot run code (DOMPurify already strips it); and
`connect-src` stays broad because the server address is user-configured —
that opens no exfil path, since only script could use it. (This used to be
a `"//csp"` note inside the manifest; Chrome flags unknown keys, so it lives
here.)


`extension/` is an unpacked MV3 extension that lets the agent read and drive
your real, logged-in browser. Load it via `chrome://extensions` -> Developer
mode -> **Load unpacked** -> pick the `extension/` folder. Its popup shows the
connection state, the server URL, and an on/off toggle.

It dials out to `/ext`. The tools reach the agent as an in-process MCP
server (`createSdkMcpServer`), so there is no separate process. Twenty-six
of them today:

    reading   list_tabs  read_page  snapshot  find  scroll  wait_for
              screenshot  download  console_read  network_read  browser_batch
    acting    navigate  click  fill  fill_form  type  press  eval  upload
              handle_dialog  open_tab  close_tab  focus_tab  back  forward  reload

**PDF tabs are readable.** Chrome's PDF viewer lets no script in, so
`read_page` on a PDF used to come back empty and the agent fell back to a
screenshot per page — twenty of them in the 2026-09-11 turn. Now a tab
named `.pdf`, or one the viewer refuses, has its bytes fetched by the
extension with your profile's cookies and the text extracted on the server
with pdf.js (pure JS, no canvas), page by page, capped at 20 000 characters
by default. The result says `PDF · 3 pages`. Measured on 2026-09-13
against a real 11-page PDF tab: `read_page` returned `kind: "pdf", pages:
11` and a table's values matched the file read from disk. Text layer only
— merged cells and superscript placement are lost, and an image-only scan
has no text to extract (screenshots still cover that).

**Structured reads.** `read_page` takes a `mode`: `text` (as before),
`markdown` (the main content — `<main>`/`<article>`, else the body — as
compact markdown: headings, paragraphs, lists, links, code, pipe tables;
navigation, headers, footers, asides and hidden elements dropped), `links`
(`[{text, href}]`, deduped, absolute), `tables` (`[{caption, headers,
rows}]`), `forms` (each form's action, method, submit control and fields
with a ref `fill`/`click` accept, label, current value, options, checked;
passwords come back as `•••`, hidden and submit inputs are not fields).
Everything is capped. A table no longer needs `eval` — which asks every
time — and markdown of an article is a fraction of its `innerText`. The
serializer is one dependency-free file (`extension/page-read.js`) run
inside the page, tested against a fixture page in the browser suite.

**`find` and `scroll`.** `find` looks for text or a regex in the visible
text, or for an element by role and accessible name (`role: button, name:
"Pay"`), and returns each match with a ref that `click`, `fill` and
`scroll` accept, its text in context, and whether it is in view — "is X on
this page?" no longer costs a full `read_page`. `scroll` goes to a ref or
selector, by pages up or down, or to the top or bottom, and reports where
the viewport ended up (`42%`, `bottom`) so a long page can be read in
passes. Both are read-level for the site gate. Tested against a fixture
page in the browser suite.

**`wait_for`.** Wait until text appears (any of a list), text is gone, a
selector matches a visible element, the URL matches a glob
(`**/dashboard*`), the document has loaded, or the network has been quiet
for half a second — all given conditions together, 10 s by default, 60 s
at most, and a timeout says so instead of hanging. Polled from the
extension's worker rather than inside the page, so a reload mid-wait does
not kill it. Read-level. This replaces the `eval(document.readyState)`
loops that made up six of the spiral's calls.

**Typing that editors accept.** `type {text, ref | selector}` sends real
keystrokes through the browser's debugger session (`Input.insertText`), and
`press` sends real key events (`Input.dispatchKeyEvent`, with `Ctrl+A`,
`Shift+Enter` and the like) — trusted input, which is what Monaco,
CodeMirror, TradingView's Pine editor and many framework inputs require:
synthetic events are `isTrusted: false` and they ignore them (measured on
TradingView: `fill` and synthetic `press` typed nothing). `fill` stays the
tool for plain inputs and selects; `type` appends at the caret, so
`Ctrl+A` first to replace. **`eval` runs through the debugger too**
(`Runtime.evaluate`), which a page CSP without `unsafe-eval` cannot block —
measured on a fixture page with that CSP: the injected-script path fails,
the debugger path returns the value; top-level `await` works, the last
expression is the result, exceptions and rejections come back as errors.
Both need the debugger session the extension attaches for act-level calls;
with DevTools already attached to that tab they fall back to the synthetic
paths and say so (`trusted: false`). Measured in real Chromium
(`test_extension_trusted_input_and_csp_eval`).

**Confirm before submit.** A `click` on a form's submit control, or
`press Enter` in a form's text field, first asks the page what it would
send: the form's action and method, the button, and the visible fields
with their values (passwords masked). If there is something in it — any
filled field, or a POST — a red card shows exactly that and waits:
**Submit** or **Stop**. No "always"; every submit is worth a look. A GET
form with nothing filled (a search box) gets no card. Stopped, the tool
fails with a message telling the agent not to retry. Independent of the
site gate, on by default, `CODETERM_CONFIRM_SUBMIT=0` turns it off. What
counts as "would submit" is a heuristic (a real submit control, or implicit
submission on Enter); a page that submits from its own click handler on a
plain button is not caught. Along the way `press Enter` gained a default
action: a synthetic key event never submitted anything (measured), so Enter
in a form's text field now submits the form the way the real key does,
unless the page cancelled the keydown. Measured in real Chromium
(`test_extension_probes_submits`).

**`console_read` and `network_read`.** For testing a web app: after an
action, read what the page logged (console.log/warn/error, uncaught errors
with file:line, unhandled rejections; `level: "error"` for just the
errors) and what it requested (fetch and XHR with method, URL, status and
duration; images/scripts/css with URL, type, duration and size but no
status, which the browser does not expose to a page; `failed: true` for
status 0 or 4xx/5xx). Both come from a small page-world hook installed at
document start — no debugger, no bar — that observes `console.*`, `fetch`
and `XMLHttpRequest` without changing what they do; buffers hold the last
500 entries and reset on navigation. A page loaded before the extension
was installed has no buffer and the tool says so. Read-level, usable in a
`browser_batch`. Measured in real Chromium (`test_extension_reads_console_and_network`).

**`upload`.** Put a file from the files root into an `<input type=file>`:
`upload {ref | selector, path: "downloads/invoice.pdf"}`. The bytes travel
from the server to the extension (the browser may be on another machine,
so no local path is used), become a `File` in the page and go in through a
`DataTransfer`, the one way a script may set `input.files`; the page's
change handler runs as if you had picked it. Act-level, 10 MB at most,
only files under the files root, never submits; `append` keeps files
already chosen on a `multiple` input. The result lists what the input now
holds and its `accept` rule, so a wrong type shows up before the submit.
Measured in real Chromium (`test_extension_uploads_files`).

**`browser_batch`.** A list of read-only steps on one tab in one call:
`steps: [{tool: "find", args: {text: "Invoice"}}, {tool: "scroll", args:
{to: "bottom"}}, {tool: "read_page", args: {mode: "tables"}}, {tool:
"screenshot"}]` — up to 20 of `list_tabs`, `read_page`, `snapshot`, `find`,
`scroll`, `wait_for`, `screenshot`. One site check at read level, one
approval, one round trip, one row (`4 steps · 1 failed · find → scroll✗ →
read_page → screenshot`). Steps run in order; a failure is recorded and the
rest still run (`stopOnError` to stop). Screenshots come back as images
after the text, numbered in step order, and count against the per-turn
screenshot budget like single shots. Nothing that acts on the page can be
in a batch, by construction: the tool refuses the list before running any
of it.

**`fill_form`.** Several fields in one call: `fields: [{ref | selector,
value}, …]` with refs from `read_page {mode: "forms"}` — one approval, one
round trip, one row (`filled 8 fields`). Each field is set the way `fill`
sets one, and `fill` itself now understands more than text: selects take an
option by text or value, checkboxes take true/false, radios a value or
label, contenteditables text; React-style listeners fire because the value
goes through the native setter. A field that is not found, or a select
with no matching option (the options are listed back), is reported in the
result while the rest are still filled. Neither tool submits — pressing
Enter or clicking the button stays a separate, visible step. Measured in
real Chromium (`test_extension_fills_forms`).

**Tabs.** `open_tab` (returns the new tab's id), `close_tab`, `focus_tab`
(bring it to the front, so you see what the agent is looking at), `back`,
`forward` and `reload` (`hard` bypasses the cache). Open is gated on the
destination like `navigate`; close, back, forward and reload are act-level
on the tab's site; focus is read-level. Back/forward/reload wait for the
navigation to commit and return the URL landed on. Measured in real
Chromium (`test_extension_manages_tabs`).

**`eval` awaits.** A returned promise is awaited (30 s cap), so
`fetch('/api').then(r => r.json())` or an async IIFE returns its value; code
with a top-level `await` runs as an async function body and must `return`.
An error thrown in the page comes back as the tool's error (measured: it
used to read as `null`). Before this, async work had to be parked on
`window.__x` and read back with a second call. Measured in real Chromium
(`test_extension_eval_awaits_promises`).

**Dialogs.** A page's `alert`, `confirm` or `prompt` used to hang every
browser call until someone clicked it. Now the extension notices the moment
one opens: the next call fails at once with *the tab is blocked by a
JavaScript confirm dialog: "Delete everything?"*, `list_tabs` flags the tab,
and **`handle_dialog`** answers it — accept (OK), dismiss (Cancel), text for
a prompt. Answering goes through Chrome's debugger API, which only lets a
session answer a dialog it saw open, so the extension attaches to a tab
before the agent's first click/fill/press/eval/navigate in it and lets go
when the turn ends; Chrome shows its "*code terminal bridge* is debugging
this browser" bar meanwhile. A dialog the page raises on its own, outside
such a turn, is detected but not answerable — the tool says so and the
agent asks you to click it. Measured end to end in real Chromium in the
browser suite (`test_extension_detects_and_answers_dialogs`).

**Screenshots come back inline.** The screenshot tool returns the image
itself as part of its result, so the model looks at it directly — no
`Read` of a path afterwards, which halves the calls in any visual task and
makes the per-turn screenshot budget a real cap on cost. The extension
sizes it for the model first: at most 1568 px on the long side (the API's
recommended maximum), JPEG — a HiDPI capture used to be ~4 MB of PNG. The
file is still written (0600, pruned by age) so the transcript row has a
path and `Read` still works. Whether the in-process MCP passes image
blocks through to the model is **not measured** yet — one real screenshot
turn will tell.

**`download`.** "Save this as a file": the tab's bytes (or a URL's), fetched
with your profile's cookies, land in the chat's working directory under
`downloads/` — named from the URL, the server's suggestion or the agent's
choice, basename'd, never overwriting (`0039-2.pdf`), 0600, 20 MB cap. The
agent then reads the file like any other, which for a PDF means the
rendered pages, not just the text layer. It goes through the site card
like any read.

**Gated per site, at two levels.** The first time a chat *reads* a site
(`read_page`, `snapshot`, `screenshot`, `download`) a card asks *Let Claude
read bank.example?*; the first time it *acts* there (`click`, `fill`,
`press`, `navigate`, `eval`) a second card asks *Let Claude act on
bank.example?* — "let it read my bank" is not "let it click Transfer". Each
card offers **Allow (this chat)**, **Always (this site)** or **Deny**, and
an act answer covers reading. "Always" puts the host on the standing list at that level
(`browser-allow.json`, edited on the manage page's *Browser sites* tab,
where a site can be switched between read-only and read + act; seed it
with `CODETERM_BROWSER_ALLOW=github.com,*.atlassian.net:read` — a bare
host means act, as before the levels existed); "Allow" lasts for
that chat's live session. `list_tabs` shows a not-yet-allowed tab as its
host only, no title or URL. **`eval` asks every call** even on an allowed
site — arbitrary JavaScript in a logged-in tab deserves a look at the code
— with "Allow on this site (this chat)" to stop asking for that host until
the chat ends. Once allowed, the tools do not stop again, and each call is
still written to the transcript — with where it landed: every browser tool
row ends in `@ host · page title` (the tab's URL is looked up before each
call anyway; `navigate` shows its destination), so a transcript can be
audited at a glance, and the export carries the same. The result the model
sees carries it too, as a small `at` field. `CODETERM_BROWSER_GATE=0` turns the gate
off (the old behaviour: any site, no questions); the setup page says which
you are running.

Worth understanding before leaving it on: the agent reads untrusted web pages
*and* holds your logged-in sessions *and* can act, with no confirmation step.
A page can contain text addressed to the agent rather than to you. The
extension's toggle is the off switch.

**Blast radius.** The manifest still requests `<all_urls>` — that is the
*capability*; the site gate above is the *policy*. A prompt-injected page
can steer the agent toward your other tabs, but reading or acting on a site
this chat has not been allowed on produces a card in front of you, not an
action; `list_tabs` does not even reveal those tabs' titles. What remains:
a site you have allowed is open to the agent for the rest of that chat.

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
