#!/usr/bin/env bash
# Installs code-terminal as a system service. Run with sudo.
set -euo pipefail

UNIT=code-terminal.service
SRC="$(cd "$(dirname "$0")" && pwd)/$UNIT"

[ "$(id -u)" -eq 0 ] || { echo "run me with sudo: sudo $0"; exit 1; }

# Fail early rather than after install, with a message that says what to fix.
NODE=$(grep -oP '(?<=ExecStart=)\S+' "$SRC")
[ -x "$NODE" ] || { echo "node not found at $NODE — update ExecStart in $UNIT"; exit 1; }
[ -f /home/dev/projects/codeTerminal/.env ] || { echo "missing .env — cp .env.example .env"; exit 1; }

install -m 0644 "$SRC" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable --now "$UNIT"

sleep 2
systemctl --no-pager --lines=15 status "$UNIT" || true
echo
echo "logs:    journalctl -u $UNIT -f"
echo "restart: sudo systemctl restart $UNIT"
