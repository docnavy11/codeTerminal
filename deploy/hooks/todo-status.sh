#!/bin/bash
# Status-line fragment for Claude Code sessions in a terminal: how much is on
# the project's board. Prints e.g. "todo 3 queued · 1 held · 1 for you", or
# nothing when the list is empty or the board is unreachable. Call it from
# your statusline command with the hook JSON on stdin (it reads the cwd), or
# with a directory as the first argument.
set -u
BASE="${CODETERM_URL:-http://100.121.192.61:8123}"
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0
if [ $# -ge 1 ]; then cwd="$1"; else cwd=$(jq -r '.cwd // .workspace.current_dir // empty' 2>/dev/null); fi
[ -n "$cwd" ] || exit 0
json=$(curl -sS --max-time 1 -G "$BASE/todos" --data-urlencode "dir=$cwd" 2>/dev/null) || exit 0
printf '%s' "$json" | jq -r '
  (.items // []) as $i
  | [ ([$i[] | select(.for=="claude" and .status=="queued")] | length | if . > 0 then "\(.) queued" else empty end),
      ([$i[] | select(.for=="claude" and .status=="claimed")] | length | if . > 0 then "\(.) held" else empty end),
      ([$i[] | select(.for=="owner")] | length | if . > 0 then "\(.) for you" else empty end) ]
  | if length > 0 then "todo " + join(" · ") else empty end' 2>/dev/null
exit 0
