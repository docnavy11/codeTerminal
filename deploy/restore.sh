#!/usr/bin/env bash
# Put a backup from deploy/backup.sh into this installation.
#
#   deploy/restore.sh mine.tar.gz              → into this clone
#   deploy/restore.sh mine.tar.gz /srv/ct      → into another clone
#
# Stops the service if it is running, refuses to overwrite an existing chats
# directory unless --force, and tells you what it put where.
set -euo pipefail
TAR="${1:?usage: restore.sh <backup.tar.gz> [target-dir] [--force]}"
shift
FORCE=0; TARGET=""
for a in "$@"; do case "$a" in --force) FORCE=1 ;; *) TARGET="$a" ;; esac; done
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${TARGET:-$REPO}"
TARGET="$(cd "$TARGET" && pwd)"
[ -d "$TARGET" ] || { echo "no such directory: $TARGET" >&2; exit 1; }
[ -f "$TARGET/package.json" ] || { echo "$TARGET does not look like a code terminal clone" >&2; exit 1; }

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$TAR" -C "$STAGE"
SRC="$STAGE/code-terminal"
[ -d "$SRC" ] || { echo "not a code terminal backup" >&2; exit 1; }
cat "$SRC/MANIFEST.txt" 2>/dev/null | head -5

if [ -d "$TARGET/chats" ] && [ "$FORCE" != 1 ]; then
  echo "refusing: $TARGET/chats already exists (pass --force to overwrite)" >&2; exit 1
fi
# Only the installation the service runs from is worth stopping; restoring
# into another directory must not take the running one down.
RESTART=0
if [ "$TARGET" = "$REPO" ] && systemctl is-active --quiet code-terminal 2>/dev/null; then
  echo "stopping the service"; sudo systemctl stop code-terminal; RESTART=1
fi

shopt -s dotglob        # or .env, the one file that is only ever a dotfile, is skipped
for f in "$SRC"/*; do
  name="$(basename "$f")"
  [ "$name" = "MANIFEST.txt" ] && continue
  case "$name" in
    server-browser-profile) dest="$TARGET/server-browser/profile"; mkdir -p "$TARGET/server-browser" ;;
    *) dest="$TARGET/$name" ;;
  esac
  rm -rf "$dest"
  cp -a "$f" "$dest"
  printf '  restored %-22s → %s\n' "$name" "$dest"
done

echo
echo "next: cd $TARGET && npm install, then npm start (or sudo deploy/install.sh for the service)."
echo "check the addresses in .env — CODETERM_HOST is this machine's, not the old one's."
[ "$RESTART" = 1 ] && { echo "restarting the service"; sudo systemctl start code-terminal; }
