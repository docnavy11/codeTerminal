# What the Claude Code TUI has that this UI does not

Ranked by how often it would matter in a day's use. Status: ☐ open, ◐ designed, ☑ done.

| # | gap | today | status |
|---|-----|-------|--------|
| 1 | **Tool results.** The TUI shows what each tool returned (Bash output, the file read, grep hits). | Every tool row ends with what it returned; click to open the body; errors open themselves; the status bar counts the turn's tools. | ☑ [docs/design-tool-results.md](docs/design-tool-results.md) |
| 2 | **Diffs for Edit/Write**, shown before approval. | The card shows the change in place: path, `+a −b`, context, removed and added lines; notes when the file is missing or `old_string` is not found. | ☑ |
| 3 | **Thinking text**, streamed. | A collapsed "thinking" block with the first line visible, streaming as it arrives, kept with the chat. Measured: only ~1 block in 20 carries text (the API omits the rest and sends token counts), so the counter stays and the block appears when there is something to read. | ☑ |
| 4 | **Images in the prompt.** | Paste, drop or attach up to four; downscaled in the browser, sent as image blocks, thumbnails kept with the chat. | ☑ |
| 5 | **Plan-mode presentation** — `ExitPlanMode` shows the plan and asks. | The card is the rendered plan with three answers: build it (ask before changes), build auto-accepting edits, keep planning; approval switches the mode. `EnterPlanMode` is mirrored in the mode menu. | ☑ |
| 6 | **Todo list / subagent progress** as a live list. | Subagents: a task line under the Agent call — running · N tool uses · Ns · last tool, then completed/failed with the report — and their own steps nested and collapsed with a count. Todos: one checklist per chat, updated in place (`tasks · 2/3 done`). | ☑ |
| 7 | `@file` completion, `!` bash prefix. | `@` in the composer lists files under the chat's cwd (ranked: name prefix, substring, subsequence; build dirs and the denylist skipped); Enter inserts the path, a directory keeps the menu open to go deeper. A real shell pane stands in for `!`. | ☑ |
| 8 | `/model` (the SDK has `setModel`), `/cost`. | Not exposed; `/context` works. | ☐ |
| 9 | `/rewind`, file-history checkpoints. | TUI-only. | ☐ |
| 10 | Esc-to-interrupt, `Ctrl+O` verbose, keyboard-driven everything. | Stop button, Enter. | ☐ |

Not gaps: the gate, permission modes, resume, `/clear`, slash commands, skills,
CLAUDE.md, streaming, cost estimate, compaction status — and, beyond the TUI,
concurrent chats, browser tools, page watches, a phone UI.
