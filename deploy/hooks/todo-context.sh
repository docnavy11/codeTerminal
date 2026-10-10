#!/bin/bash
# UserPromptSubmit hook for Claude Code sessions in a terminal: appends the
# project's todo list from codeTerminal's board to the prompt as context, the
# same list a codeTerminal chat gets on every turn (docs/design-todos.md).
#
# Register in ~/.claude/settings.json under hooks.UserPromptSubmit. Reads the
# hook's JSON on stdin for the cwd; prints the context (or nothing) on stdout.
# Fails silent: a board that is down must never block a prompt.
#
# CODETERM_URL names the server; the default is this box's tailnet address.
set -u
BASE="${CODETERM_URL:-http://100.121.192.61:8123}"
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0
input=$(cat)
cwd=$(printf '%s' "$input" | jq -r '.cwd // .workspace.current_dir // empty' 2>/dev/null)
[ -n "$cwd" ] || exit 0
json=$(curl -sS --max-time 2 -G "$BASE/todos" --data-urlencode "dir=$cwd" 2>/dev/null) || exit 0
# Which tmux session this is, so answers addressed to it can be picked out.
me=""
if [ -n "${TMUX_PANE:-}" ]; then me="tmux:$(tmux display -p -t "$TMUX_PANE" '#S' 2>/dev/null)"; fi
root=$(printf '%s' "$json" | jq -r '.root')
# Answers the owner gave to this session's questions (last 24 h), first: they are the thing to act on.
if [ -n "$me" ]; then
  answers=$(printf '%s' "$json" | jq -r --arg me "$me" '.answered // [] | map(select(.addedBy == $me)) | .[] | "- Q: \(.text)\n  A: \(.result)"')
  if [ -n "$answers" ]; then
    echo "<owner-answers note=\"The owner answered what you asked on the board. Act on these; do not ask again.\">"
    printf '%s\n' "$answers"
    echo "</owner-answers>"
  fi
fi
printf '%s' "$json" | jq -e '.items | length > 0' >/dev/null 2>&1 || exit 0
echo "<project-queue note=\"The owner's todo list for $(basename "$root"), from the codeTerminal board. Context, not a request to start on them. Claim with the codeterminal MCP tool claim_todo (project: \\\"$root\\\", by: tmux:<session>) before working on one; done_todo when finished; add_todo with for=owner to ask the owner something.\">"
printf '%s' "$json" | jq -r '.items[] | "- [\(.id[0:8])] \(.status)\(if .claimedBy then " (" + .claimedBy + ")" else "" end)\(if .for == "owner" then " for the owner" else "" end): \(.text)"'
echo "</project-queue>"
exit 0
