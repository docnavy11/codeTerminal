# What the Claude Code TUI has that this UI does not

Ranked by how often it would matter in a day's use. Status: ☐ open, ◐ designed, ☑ done.

| # | gap | today | status |
|---|-----|-------|--------|
| 1 | **Tool results.** The TUI shows what each tool returned (Bash output, the file read, grep hits). | Every tool row ends with what it returned; click to open the body; errors open themselves; the status bar counts the turn's tools. | ☑ [docs/design-tool-results.md](docs/design-tool-results.md) |
| 2 | **Diffs for Edit/Write**, shown before approval. | The approval card prints the raw JSON input (`old_string`/`new_string`). | ☐ |
| 3 | **Thinking text**, streamed. | `thinking · 251` — a token count. The SDK's `thinking_delta` events are dropped. | ☐ |
| 4 | **Images in the prompt** (paste a screenshot). | Text only. The SDK accepts image blocks on the user message. | ☐ |
| 5 | **Plan mode presentation** — `ExitPlanMode` shows the plan and asks. | A generic approval card with JSON. | ☐ |
| 6 | **Todo list / subagent progress** as a live list. | Ordinary tool lines. | ☐ |
| 7 | `@file` completion, `!` bash prefix. | A real shell pane instead; no `@` completion. | ☐ |
| 8 | `/model` (the SDK has `setModel`), `/cost`. | Not exposed; `/context` works. | ☐ |
| 9 | `/rewind`, file-history checkpoints. | TUI-only. | ☐ |
| 10 | Esc-to-interrupt, `Ctrl+O` verbose, keyboard-driven everything. | Stop button, Enter. | ☐ |

Not gaps: the gate, permission modes, resume, `/clear`, slash commands, skills,
CLAUDE.md, streaming, cost estimate, compaction status — and, beyond the TUI,
concurrent chats, browser tools, page watches, a phone UI.
