#!/usr/bin/env bash
# Everything that makes this installation yours, in one tarball: the .env, the
# chats, the prompts, the schedules, the usage log, the allowed sites and the
# workspace. Restore it into a fresh clone with deploy/restore.sh.
#
#   deploy/backup.sh                       → code-terminal-backup-<stamp>.tar.gz here
#   deploy/backup.sh /tmp/mine.tar.gz      → there
#   deploy/backup.sh --with-profile ...    → include the server browser's Chromium
#                                            profile (its logins; hundreds of MB)
#
# Not included, by design: node_modules (npm install), the source (git clone),
# your Claude Code login in ~/.claude (that is the machine's, not this app's),
# and the server browser profile unless you ask for it.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

WITH_PROFILE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --with-profile) WITH_PROFILE=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done
OUT="${ARGS[0]:-$REPO/code-terminal-backup-$(date +%Y%m%d-%H%M%S).tar.gz}"

# Ask the server where its state actually is: CODETERM_STATE or the individual
# variables may point anywhere, and guessing would back up the wrong files.
PATHS_JSON="$(node --import tsx -e '
  import { statePaths, loadEnvFile } from "./src/config.js";
  loadEnvFile(process.cwd());
  console.log(JSON.stringify(statePaths(process.cwd())));
' 2>/dev/null)" || { echo "cannot resolve the state paths (is npm install done?)" >&2; exit 1; }

mapfile -t ITEMS < <(node -e '
  const p = JSON.parse(process.argv[1]);
  const keep = ["chats", "workspace", "prompts", "schedules", "usage", "browserAllow"];
  for (const k of keep) console.log(p[k]);
' "$PATHS_JSON")
[ "$WITH_PROFILE" = 1 ] && ITEMS+=("$(node -e 'console.log(JSON.parse(process.argv[1]).serverBrowserProfile)' "$PATHS_JSON")")
[ -f "$REPO/.env" ] && ITEMS+=("$REPO/.env")

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/code-terminal"
MANIFEST="$STAGE/code-terminal/MANIFEST.txt"
{
  echo "code terminal backup"
  echo "from   $(hostname):$REPO"
  echo "date   $(date -Is)"
  echo "commit $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo
  echo "contents (restored to the same names in the target install):"
} > "$MANIFEST"

for src in "${ITEMS[@]}"; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  # the browser profile keeps its two-level name so restore puts it back right
  case "$src" in *server-browser/profile) name="server-browser-profile" ;; esac
  cp -a "$src" "$STAGE/code-terminal/$name"
  printf '  %-22s %s\n' "$name" "$(du -sh "$src" | cut -f1)" >> "$MANIFEST"
done

tar -czf "$OUT" -C "$STAGE" code-terminal
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
sed -n '6,99p' "$MANIFEST"
