# Design: tool results in the transcript

Gap #1 in [TUI-GAPS.md](../TUI-GAPS.md). Design only; nothing here is built.

## The problem

A tool call renders as one dim line — `→ Bash grep -c purchase "$f"` — and
what it returned renders as nothing. The user sees the agent *doing* things
and never what it *found*, so a turn is a list of verbs with no nouns. The
56-call turn on 2026-09-11 showed the failure mode: twenty screenshots,
twenty reads, six evals, and no way to tell from the pane whether any of
them produced anything.

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
