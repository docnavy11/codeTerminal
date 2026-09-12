# What the Claude Code TUI has that this UI does not

Ranked by how often it would matter in a day's use. Status: ☐ open, ◐ designed, ☑ done.

| # | gap | today | status |
|---|-----|-------|--------|
| 1 | **Tool results.** The TUI shows what each tool returned (Bash output, the file read, grep hits). | Every tool row ends with what it returned; click to open the body; errors open themselves; the status bar counts the turn's tools. | ☑ [docs/design-tool-results.md](docs/design-tool-results.md) |
| 2 | **Diffs for Edit/Write**, shown before approval. | The card shows the change in place: path, `+a −b`, context, removed and added lines; notes when the file is missing or `old_string` is not found. | ☑ |
| 3 | **Thinking text**, streamed. | A collapsed "thinking" block with the first line visible, streaming as it arrives, kept with the chat. Measured: only ~1 block in 20 carries text (the API omits the rest and sends token counts), so the counter stays and the block appears when there is something to read. | ☑ |
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
