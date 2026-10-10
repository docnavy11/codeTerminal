#!/bin/bash
# Stop hook for Claude Code sessions in tmux: a session that ends its turn
# while it still holds a board item is sent back once to close it, release it,
# or say why — so a claim does not sit in "In progress" after the work is
# over (docs/design-todos.md §19).
#
# Register in ~/.claude/settings.json under hooks.Stop. Reads the hook's JSON
# on stdin; prints {"decision":"block","reason":…} when it holds something.
# Lets the stop through when stop_hook_active is set (it already blocked once
# this turn: never a loop), outside tmux, with nothing held, and whenever the
# server cannot be reached. A board that is down must never trap a session.
set -u
BASE="${CODETERM_URL:-http://100.121.192.61:8123}"
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0
input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ] && exit 0
cwd=$(printf '%s' "$input" | jq -r '.cwd // .workspace.current_dir // empty' 2>/dev/null)
[ -n "$cwd" ] || exit 0
[ -n "${TMUX_PANE:-}" ] || exit 0
name=$(tmux display -p -t "$TMUX_PANE" '#S' 2>/dev/null) || exit 0
[ -n "$name" ] || exit 0
me="tmux:$name"
json=$(curl -sS --max-time 2 -G "$BASE/todos" --data-urlencode "dir=$cwd" 2>/dev/null) || exit 0
root=$(printf '%s' "$json" | jq -r '.root // empty' 2>/dev/null)
held=$(printf '%s' "$json" | jq -r --arg me "$me" '.items // [] | map(select(.status == "claimed" and .claimedBy == $me)) | .[] | "- [\(.id[0:8])] \(.text)"' 2>/dev/null)
[ -n "$held" ] || exit 0
reason="You still hold these board items:
$held
Before you stop: if the work is finished, call the codeterminal MCP tool done_todo (project: \"$root\", id: the 8 characters in brackets) with a one-line result. If you cannot finish it, call release_todo. If it needs a decision only the owner can take, call add_todo with for=owner and say so. If the item is still in progress and you are only pausing, say that in one line."
jq -n --arg reason "$reason" '{decision: "block", reason: $reason}'
exit 0
