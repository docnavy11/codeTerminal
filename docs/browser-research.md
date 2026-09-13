# Browser interaction: what exists elsewhere, and what to reuse

Research for [BROWSER-IMPROVEMENTS.md](../BROWSER-IMPROVEMENTS.md), 2026-09-13.
Everything below is from the projects' own pages (links at the end);
nothing here was run. Where a claim is an inference it says so.

## The landscape

| project | drives Chrome how | user's logged-in profile? | licence | what stands out |
|---|---|---|---|---|
| **Claude in Chrome + Claude Code** (`claude --chrome`) | official extension ↔ CLI over a native-messaging host (+ `bridge.claudeusercontent.com`) | yes | proprietary | first-party; the read/act split; site permissions; "checks in before consequential actions" |
| **Playwright MCP** (Microsoft) | Playwright; can attach to an existing Chrome via its "Playwright Extension" | via extension | Apache-2.0 | the most complete tool vocabulary (30+); aria snapshots with refs; `find`, `wait_for`, `tabs`, `fill_form`, dialogs, network, console, PDF |
| **Chrome DevTools MCP** (Google) | Puppeteer/CDP on a debugging port | not easily | Apache-2.0 | `take_snapshot` with uids; `wait_for` text list; `navigate_page` back/forward/reload; `handle_dialog`; no scroll, download or find |
| **agent-browser** (Vercel) | its own CDP daemon (Rust); `--auto-connect` to a Chrome started with `--remote-debugging-port` | yes, that way | Apache-2.0 | `snapshot -i` refs `@e1`; `find role button --name`; `wait --text/--url/--load/--fn`; `tab` mgmt with stable ids; downloads; `pdf`; dialogs |
| **OpenChrome** | CDP, its own Chrome instance | no | MIT | "compact page serialization for lower-token agent loops"; `read_page` modes |
| **BrowserMCP** | MCP server + extension, adapted from Playwright MCP | yes | Apache-2.0 | the closest to our architecture — but cannot be built outside its monorepo |

Ours: an extension over a WebSocket to a server that may be on another
machine, driving the user's real profile. That last part is what the
CDP-based tools cannot do without a debugging port, and what the native-
messaging ones cannot do across machines — it is the reason our extension
exists and the reason none of these is a drop-in replacement.

## The first-party option

Claude Code has its own Chrome integration: the same `claude` binary we run
through the SDK gains an MCP server (`claude-in-chrome`) with `read_page`,
`get_page_text`, `find`, screenshot (`save_to_disk`), console and network
readers, clicks, typing, navigation, tab and window management, file upload,
GIF recording and `browser_batch` (several read-only actions in one call).
Site permissions live in the extension; plan mode runs read-only calls
without a prompt and asks for state-changing ones; it "checks in before
consequential actions like submitting forms or making purchases" and has
hard bans (no card/SSN fields, no CAPTCHA bypass). It needs `/login`
credentials — which we have.

The catch for us: the extension talks to the CLI through a **native
messaging host on the same machine**. On the VPS topology (server here,
browser on the laptop) that cannot work. In **localhost mode** it might: an
SDK session on a laptop with the official extension installed could get
these tools for free. Whether the SDK exposes the `--chrome` switch, and
what it does to context size ("increases context usage since browser tools
are always loaded"), is **not measured** — worth one experiment before
building more of our own.

## What to reuse, item by item

| improvement | reuse |
|---|---|
| 1 PDFs | `pdfjs-dist/legacy/build/pdf.mjs` runs in Node 22 with no canvas: `getDocument({ data })`, walk pages, `page.getTextContent()` (items with `str`), `standardFontDataUrl` from the package. `unpdf` wraps the same. Extension side: `fetch(tab.url)` carries the profile's cookies under `<all_urls>` — inference, not measured; `blob:`/`file:` PDFs will not be reachable that way. |
| 2 screenshots inline | nothing to borrow; an image content block in the MCP result. |
| 3 structured reads | **Defuddle** needs a real DOM — we have one, in the content script — and is the current answer to Readability's neglect; Readability + Turndown is the classic pipeline; `readdown` folds extraction, markdown and a token estimate into one call. OpenChrome's "compact serialization" is the same idea. Tables/forms/links as data: own code (small). |
| 4 find / scroll | Playwright's `browser_find` (text/regex over the snapshot); agent-browser's `find role button --name "Submit"` (ARIA role + name). No project ships a scroll tool except agent-browser; ours is `scrollIntoView` on a ref, or by pages. |
| 5 wait_for | Chrome DevTools MCP: an array of texts, resolves when any appears; agent-browser: `--text`, `--url` glob, `--load`, `--fn` expression. Take the union, with a timeout. |
| 6 tabs | DevTools MCP's `list_pages / new_page / select_page / close_page` and `navigate_page {url \| back \| forward \| reload}`; agent-browser's stable tab ids. |
| 7 download | agent-browser's `--download-path`; ours is `chrome.downloads.download` into the files root. |
| 8 read vs act | Claude in Chrome's exact split: read-only = `read_page`, `get_page_text`, `find`, console/network readers, screenshot; state-changing = clicks, typing, navigation, tab/window management, recording. A read-only call with a state-changing flag (`save_to_disk`, `clear`) counts as acting. Adopt as is. |
| 10 confirm before submit | Claude in Chrome: "checks in before consequential actions like submitting forms or making purchases", plus hard bans (card/SSN fields, CAPTCHAs, facial images). The bans are cheap to copy; the check-in needs the same heuristic we sketched. |

## Ideas the research adds

- **`fill_form`** — several fields in one call (Playwright MCP, DevTools MCP). One approval, one round trip, for the invoice-style data entry that is the common task here.
- **`handle_dialog`** — a JavaScript `alert`/`confirm` blocks every other command; today the agent just hangs (Claude Code's docs list this as their top "browser not responding" cause). Detect and surface it.
- **`browser_batch`** — a list of read-only actions executed as one tool call. Directly attacks the round-trip count in a spiral.
- **console and network readers** — the debugging use case (test a local web app) that Claude Code's docs lead with; cheap in an extension (`chrome.debugger` or a content-script hook), and read-only.
- **file upload** — attach a file from the files root to an `<input type=file>` (Claude Code caps it at 10 MB).
- **Session recording as GIF** — skip; screenshots and the transcript cover it.

## Sources

- [Use Claude Code with Chrome](https://code.claude.com/docs/en/chrome) · [Claude in Chrome permissions guide](https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide)
- [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) · [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) ([tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md))
- [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) · [shaun0927/openchrome](https://github.com/shaun0927/openchrome) · [BrowserMCP/mcp](https://github.com/BrowserMCP/mcp)
- PDF.js in Node: [Nutrient: server-side text extraction with PDF.js](https://www.nutrient.io/blog/pdfjs-server-side-text-extraction/) · [unpdf](https://unjs.io/packages/unpdf/) · [Liran Tal: PDF.js in Node.js](https://lirantal.com/blog/how-to-read-and-parse-pdfs-pdfjs-create-pdfs-pdf-lib-nodejs)
- Page → markdown: [Defuddle (Show HN)](https://news.ycombinator.com/item?id=44067409) · [zcag/readdown](https://github.com/zcag/readdown) · [Mozilla Readability MCP](https://glama.ai/mcp/servers/jdcx8fmajm)
- Comparisons: [The Great Browser MCP Showdown](https://www.vibebrowser.app/blog/mcp-browser-automation-comparison) · [Browser Automation for AI Agents: MCP, Playwright, and Beyond](https://codeshrew.github.io/ai-lab-notes/posts/2026-02-08_browser-automation-ai-agents-mcp-playwright/)
