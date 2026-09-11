# Tool results: seeing what the agent found, not just what it did

Gap #1 in [TUI-GAPS.md](../TUI-GAPS.md). This is the feature as the person
using it experiences it. The engineering notes are in the appendix.

## Who this is for, and when

You have asked for something that takes the agent a while — check these
invoices, find why the build fails, read this page and compare it with the
repo. The agent runs tools: it reads files, runs commands, looks at your
browser. Today the pane shows you a list of verbs — `→ Bash`, `→ Read`,
`→ screenshot` — and never a noun. You cannot tell whether the grep found
anything, whether the page loaded, whether the twentieth screenshot looked
any different from the first. You wait for the final answer and take it on
trust, or you interrupt because it looks stuck.

The feature: **every tool line answers "and?" in the same line**, and can
open to show the whole thing.

## What you see

### While a turn is running

```
  Check these invoices against the Odoo bills tab.

  I'll start by listing the open tabs.

  → list_tabs                                   6 tabs
  → read_page  Invoices · upbudget              Invoices · 4 100 chars
  → screenshot tab 837210570                    image · 1 280×720
  → Read       tab-837210570-…png               image · 1.2 MB
  → eval       document.querySelectorAll…       42 rows
  → Bash       grep -c purchase "$f"            3
  → Bash       grep -i 'openrouter' "$f"        …
                                                        thinking · 7 tools · 2 screenshots
```

Each line ends with a **result badge**: a number, a size, a title, the
first line of output — whatever answers the question that tool was asked.
The last line ends with `…`: that one is still running. The status bar
counts the turn as it goes, so "seven tools, two screenshots" is a fact,
not a feeling.

### When something goes wrong

```
  → Bash       grep -i 'openrouter' "$f"        ✗ exit 2 · No such file or directory
      grep: /home/dev/.claude/projects/x.txt: No such file or directory
```

An error is the one result that opens itself. Red badge, the failure's
first line on the row, the full message under it. You do not have to hunt
for it in a list of forty grey lines — and you can see it *before* the
agent's next sentence explains it away.

### When you want the whole thing

Click a row (or its ▸) and it opens:

```
  → Bash       git log --oneline -5             ▾ 5 lines
      e823942 Transcript: tool rows were crushed to 0px once the log overflowed
      362f949 Setup & status page
      2e8ef62 First contact: quickstart README with screenshots
      1d564e4 File browser: New folder
      17adc3d Drop the "//csp" pseudo-comment from the manifest
```

The body is the output as the agent saw it, in a box that scrolls on its
own after ~12 lines so a 900-line file does not push the conversation off
the screen. Click again to close. A **copy** button sits in the box's
corner — the grep hit, the path, the stack trace go to your clipboard
without selecting text in a scrolling box.

### When you come back to an old chat

The results are part of the transcript. Open a chat from last week and the
rows carry the same badges and open the same way. Chats recorded before
this shipped show what they always showed.

### The spiral, seen

The turn that motivated this — twenty screenshots, twenty reads, six evals,
no text — would have looked like this:

```
  → screenshot tab 837210571                    image · 1 280×720
  → Read       tab-837210571-…png               image · 1.2 MB
  → screenshot tab 837210572                    image · 1 280×720
  → Read       tab-837210572-…png               image · 1.2 MB
  → eval       window.__inv                     null
  → screenshot tab 837210572                    image · 1 280×720
  → Read       tab-837210572-…png               image · 1.2 MB
  → eval       window.__inv                     null
                                                        thinking · 31 tools · 12 screenshots
```

`null`, `null`, `null` and *12 screenshots* in the status bar is a story
you can read in two seconds: it is polling a page that never fills. Press
Stop, tell it the page needs a login. Without the badges the same eight
lines were indistinguishable from progress.

## What each tool's badge says

Written so that the collapsed transcript already tells the story:

| the agent… | the badge |
|---|---|
| ran a command | the first line of output — `3`, `ok`, `v22.22.1`; `(no output)`; on failure `✗ exit N · first line of the error` |
| read a file | `120 lines` (`of 900` when partial); `image · 1.2 MB` for a picture |
| wrote or edited a file | `wrote src/x.ts · 40 lines` / `edited src/x.ts · +4 −1` |
| searched | `8 matches in 3 files` / `12 files` / `no matches` |
| read a web page | the page title and how much text it got |
| looked at your browser | `6 tabs` / `42 elements` / `image · 1 280×720` / the eval's value |
| read your terminal | `200 lines` |
| was refused by you | `denied` — the approval card already said why |
| was stopped | `interrupted` |

## What it deliberately does not do

- **No pictures inline.** A screenshot or an image file shows as `image ·
  size`. Inline thumbnails in a 400 px panel would dominate the transcript;
  the agent's words about what it saw are the point.
- **No syntax colouring, no diff view.** Output is plain monospace. Diffs
  for edits are their own feature (gap #2) because they belong on the
  approval card, *before* the change, not after it.
- **No auto-expanding of successful results**, however short. A turn with
  forty tools stays forty lines tall; you open what you care about. (Open
  decision — see below.)

## On the phone and in the side panel

Same rows. At 400 px wide the command keeps to one line with an ellipsis
and the badge wraps beneath it rather than being cut off; opening a row
uses the whole width. Tapping the row opens it — the ▸ is a hint, not a
target.

## Decisions to make

1. **Short successes: closed or open?** Closed keeps the transcript
   scannable; open (≤ 3 lines) means a `git status` shows its three lines
   without a tap. Proposed: closed, with a per-chat "expand all" in the ⋯
   menu for the times you are debugging *with* the agent.
2. **How much to keep.** Each result is stored with the chat, capped at a
   few pages of text; beyond the cap the box says `…truncated, N KB` and
   the agent still had the whole thing. Cap to be set after measuring how
   it affects opening old chats.

---

## Appendix: engineering notes

## What the SDK gives us (measured)

Every result arrives on a `user` message whose `content` holds a
`tool_result` block: `{ type: "tool_result", tool_use_id, content: string |
[{type:"text",text}|{type:"image",…}], is_error?: boolean }`. The same
message carries **`tool_use_result`** (SDK field; the CLI's own transcript
files spell it `toolUseResult`) — the tool's structured output, per tool:

| tool | structured output (keys seen) |
|---|---|
| Bash | `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected` |
| Read | `type: "text"`, `file: { filePath, content, numLines, startLine, totalLines }` — or `type: "image"` |
| Write / Edit | `type: "create"` \| `"update"`, `filePath`, `content`, `structuredPatch`, `originalFile` |
| Grep / Glob / MCP tools | free-form; the text block is the source of truth |

Sizes from this session's own transcript (`~/.claude/projects/…/*.jsonl`,
1 215 results): median **254 chars**, max **41 845**; 20 of 1 215 were errors
(median 455 chars). So: almost everything fits on a few lines, a few things
are enormous, and errors are rare but the most important to see.

`session.ts` already handles this message (`case "user"`) — it only uses the
block to clear the tool from the status. The data is there; we drop it.

## Design

### Protocol: one new event

```ts
{ kind: "tool_result";
  id: string;                 // tool_use_id — joins to the "tool" event
  name: string;               // tool name, so a result can render alone if its call was truncated away
  ok: boolean;                // !is_error
  summary: string;            // one line, per-tool (below), ≤ 120 chars
  text: string;               // the body shown when expanded; capped (see Storage)
  bytes: number;              // size before capping
  truncated: boolean;
  interrupted?: boolean;      // Bash
  parent?: string | null }    // parent_tool_use_id: a subagent's result, rendered nested/tagged
```

Added to `ClientEvent` in `protocol.ts` (and to `AGENT_MESSAGE_TYPES` /
the client coverage test). `session.ts` builds it from the block plus
`tool_use_result` when present, in the same `case "user"` that clears the
status. It is **persisted** like `tool` (goes through `#record`), so a
replayed chat shows results; chats recorded before this ship simply have
none and render as today.

### Summary per tool (the collapsed line)

The point of the summary is that the collapsed transcript already tells the
story. Derived from `tool_use_result` where it exists, else from the text:

| tool | summary |
|---|---|
| Bash | first non-empty stdout line, else `(no output)`; `exit ≠ 0` and stderr's first line when `is_error`; `interrupted` when so |
| Read | `path · 120 lines (of 900)` — text; `image · path` — image |
| Write | `wrote path · N lines` |
| Edit | `edited path · +a −b` from `structuredPatch` (the diff itself is gap #2) |
| Grep | `N matches in M files` when the text is the standard listing, else first line |
| Glob | `N files` |
| WebFetch / WebSearch | first line |
| mcp__browser__* | `read_page` → `title · N chars`; `screenshot` → `tab N · WxH` (the tool's own JSON); `snapshot` → `N elements`; others → first line |
| mcp__terminal__read | `N lines` |
| anything else | first line of the text, or `(empty)` |
| error (any tool) | first line of the error text, prefixed `✗` |

### Rendering

The tool line becomes a row with the result attached:

```
→ Bash  grep -c purchase "$f"                       ✓ 3            ▸
→ Read  /tmp/…/tab-837210570.png                     image · 1.2 MB ▸
→ Bash  f=/home/dev/…; grep -i 'openrouter' …        ✗ exit 1 · grep: no such file ▾
   ┌──────────────────────────────────────────────────┐
   │ grep: /home/dev/.claude/projects/x.txt: No such │
   │ file or directory                                │
   └──────────────────────────────────────────────────┘
```

- **Collapsed by default**; the summary sits at the end of the line in the
  same dim colour, errors in `--bad`. The chevron (or clicking the row)
  expands a `<pre>` of the body: monospace, `max-height: 240px` with its
  own scroll, `white-space: pre-wrap`, same box style as the approval
  card's `pre` (already themed).
- **Errors auto-expand.** Rare (1.6 %) and the thing you most need to read.
- **Pending state.** Until the result arrives the row shows `…` where the
  summary goes — it doubles as "this tool is still running", which the
  status bar says only in aggregate.
- The result is attached to its call by `id`. If the call's line is gone
  (older than `MAX_EVENTS`, or a replay that starts mid-turn) the result
  renders on its own line using `name`.
- Subagent results (`parent` set) get a `↳` prefix and one level of indent;
  no tree.
- Mobile and side panel: same markup; at 400 px the summary wraps under the
  command rather than being ellipsised away (the command keeps `nowrap` +
  ellipsis, the summary does not).
- **Turn roll-up in the status bar** while busy: `thinking · 12 tools · 4
  screenshots` — the counts the user needed on 2026-09-11 to see a spiral.
  Cheap (the client counts `tool` events since the last `user`), so it is
  part of this change.

Not in scope: rendering images inline (a Read of a PNG shows `image · path`;
inline thumbnails need the file served, and screenshots live outside the
files root), syntax highlighting, diffs (gap #2).

### Storage and size

- `text` is capped at **8 KB** per event when recorded (`truncated: true`,
  `bytes` keeps the real size). With `MAX_EVENTS = 3000` the worst case
  adds 24 MB to a chat file; realistic (median 254 chars) is a few hundred
  KB. The store's `#summaryOf` still reads whole files at boot — 3000
  events × 8 KB × many chats would slow the boot scan; measure after
  building, and lower the cap to 4 KB if the scan exceeds ~200 ms for the
  live chats dir.
- Live-only vs persisted: persisted. Replay without results would make the
  history a different document from what the user watched.
- Wire: median event ~300 bytes; the 32 MB `maxPayload` is irrelevant.

### Edge cases to handle explicitly

1. Result with no matching `tool` event (truncation, `observe` clients
   attaching mid-turn) → standalone row using `name`.
2. Two results for one id (should not happen; SDK retries) → replace.
3. `content` as an array with image blocks (Read of an image, screenshot
   tools) → `image` summary, body says `(image, N bytes)`.
4. Empty content, `noOutputExpected` → `(no output)`, not an error.
5. `interrupted: true` → `interrupted` in the summary, `warn` colour.
6. Denied tools (`toolDenialKind` on the message / our own deny) → `denied`
   summary, no body — the approval card already showed why.
7. Huge single-line output (minified JSON, base64) → capped and the body
   gets `word-break: break-all` so it cannot widen the pane.
8. ANSI in Bash stdout → strip with the existing `stripAnsi`.
9. `tool_use_result` absent (older CLI, MCP tools) → text-only path; the
   summary rules fall back to "first line".
10. Streaming: results never stream; nothing changes in the per-frame
    render path.

### Tests (written before the code)

- `session.test.ts`: each row of the summary table from fixture messages
  (Bash ok/error/interrupted/empty, Read text/image, Edit with a patch,
  Grep listing, an MCP screenshot JSON, unknown tool); the cap and
  `truncated`; a result for an unknown id still emits; `parent` carried.
- `conversation.test.ts`: `tool_result` is persisted and replayed;
  `MAX_EVENTS` counts it.
- `protocol.test.ts`: the new kind is in the union and the client handles it.
- browser suite: a scripted turn with three tools — collapsed summaries
  present, error auto-expanded, click expands/collapses, the roll-up count
  in the status bar, a replay after reload shows the same rows, the
  standalone-result case.

### Estimate

~120 lines in `session.ts` (summaries + event), ~20 in `protocol.ts`, ~90
in `sidepanel.js`, ~25 of CSS, ~200 of tests. One commit.

### Open decisions

- Collapsed by default for everything but errors (proposed), or expanded
  for small results (≤ 3 lines)? Expanded-when-small reads better for Bash;
  it also makes a 56-call turn 56 boxes tall.
- 8 KB cap (proposed) vs 4 KB. Decide after measuring the boot scan.
