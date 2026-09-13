# Browser interaction: improvements

What the agent can do in your browser today, and what it should be able to.
Ranked by what this box's own transcripts show it struggling with (187 chats
use the browser tools; the 56-call spiral of 2026-09-11 is the reference
failure) and by what the per-site gate (2026-09-12) makes awkward.

Status: ☐ open, ◐ designed, ☑ done.

## Today

Nine tools through the extension — `list_tabs`, `read_page`, `snapshot`,
`navigate`, `click`, `fill`, `press`, `eval`, `screenshot` — plus page
watches, the active tab as prompt context, a per-turn screenshot budget,
and a per-site gate (allow for this chat / always / deny; `eval` asks per
call). Screenshots go to disk and come back as a path the model then reads.

## Reading

| # | improvement | why | status |
|---|---|---|---|
| 1 | **PDFs.** `read_page` on a PDF tab returns the text: the extension fetches the tab's bytes, the server extracts text (`pdfjs-dist`, pure JS). | Chrome's PDF viewer is not scriptable, so `read_page` returns nothing and the agent falls back to screenshot→Read per page — that *was* the spiral (20 screenshots, 19 reads). The invoice job is the most common browser task here. | ☑ |
| 2 | **Screenshots inline.** Return the PNG as an image content block instead of a path. | Halves the calls in any visual task (no `Read` round trip) and makes the screenshot budget a real cap on cost. | ☐ |
| 3 | **Structured reads.** `read_page` with `mode: text \| links \| tables \| forms` — rows, fields with current values, `[text → url]`. | Far fewer tokens than 20 000 chars of `innerText`; and a table no longer needs `eval`, which now asks every time. | ☐ |
| 4 | **`find` and `scroll`.** Search the page for text → matches with the enclosing element's ref and position; scroll to a ref or by pages. | "Is X on this page?" is a full `read_page` today; long pages are read blind. | ☐ |

## Acting

| # | improvement | why | status |
|---|---|---|---|
| 5 | **`wait_for`** — selector, text, or network-idle, with a timeout. | The agent guesses with `eval(document.readyState)` loops; six of the spiral's evals were exactly this. | ☐ |
| 6 | **Tab management** — `open_tab`, `close_tab`, `focus_tab`, `back`, `reload`. | `navigate {newTab}` is the only tab operation; the agent cannot tidy up after itself or return to where it was. | ☐ |
| 7 | **`download`** — save a link or the current document into the files root via `chrome.downloads` (or the `fetch_bytes` path #1 already has). | "Get me all the invoices as PDFs" should end in the file browser, not in screenshots. Observed 2026-09-13: asked about a PDF tab, the agent's own plan B for an auth-walled file was `eval(fetch(location.href))` + base64 + write to disk + `Read` — one gated eval per page-set. A `download` tool is that path without the gymnastics, and it gives the model the rendered pages (layout) that the text layer loses. | ☐ |

## Safety and legibility

| # | improvement | why | status |
|---|---|---|---|
| 8 | **Read vs act on the site card.** Two levels — *read* (`read_page`, `snapshot`, `screenshot`, `find`) and *act* (`click`, `fill`, `press`, `navigate`, `eval`) — the card asks for the level the call needs. | A site is allowed wholesale today: "let it read my bank" also means "let it click Transfer". Small change on top of the gate. | ☐ |
| 9 | **Tool rows say where.** The tab's URL is already fetched before every call; show it on the row (`→ click  bank.example · Transfer`). | Makes the transcript auditable at a glance; costs nothing. | ☐ |
| 10 | **Confirm before submit.** A card when `press Enter` or a click lands on a submit control in a form with filled fields. | Prevents the expensive mistake. Heuristic (what counts as submit), hence last. | ☐ |

## From the research

| # | improvement | why | status |
|---|---|---|---|
| 11 | **`fill_form`** — several fields in one call. | One approval, one round trip for data entry; Playwright MCP and DevTools MCP both have it. | ☐ |
| 12 | **`handle_dialog`** — detect a blocking `alert`/`confirm`/`prompt`, surface it, accept or dismiss. | A JavaScript dialog blocks every other command; Claude Code's docs list it as the top "browser not responding" cause. We hang the same way. | ☐ |
| 13 | **`browser_batch`** — a list of read-only actions as one tool call. | Directly cuts the round-trip count in a spiral; read-only, so no extra gating. | ☐ |
| 14 | **Console and network readers** (read-only). | The "test my local web app" workflow Claude Code's docs lead with. | ☐ |
| 15 | **File upload** from the files root into an `<input type=file>`. | Data entry that ends in an attachment; cap at 10 MB like Claude Code. | ☐ |

## Reuse

What other projects do for each of these, and what to borrow, is in
[docs/browser-research.md](docs/browser-research.md) — including the
first-party option (Claude Code's own Chrome integration, usable only when
the server and the browser share a machine) and five ideas the research
added: `fill_form`, `handle_dialog`, `browser_batch`, console/network
readers, file upload.

## Suggested order

1, 2, 8, 9 first — the observed pain plus the safety gap; then 3 and 5;
then 4, 6, 7, 10. Item 1 is the only one that needs a new dependency.

## Measured basis

- 187 of this box's transcripts contain browser-tool calls.
- The 2026-09-11 turn: 56 tool calls — 20 `screenshot`, 19 `Read`, 6 `eval`,
  6 `Bash`, 2 `read_page` — with one sentence of output; the task was
  reading PDF tabs and comparing them with an invoices page.
- Tool-result sizes across 1 215 results: median 254 chars, max 42 KB —
  `read_page` at 20 000 chars is the outlier that structured reads address.
