#!/usr/bin/env bash
# Installs code-terminal as a system service for the user who runs this (via
# sudo), from the checkout this script lives in. Run with sudo:
#
#   sudo deploy/install.sh              # unit only
#   sudo deploy/install.sh --sudoers    # also let that user restart it without a password
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run me with sudo: sudo $0"; exit 1; }
USER_NAME="${SUDO_USER:-}"
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || { echo "run via sudo from the user account that should own the service"; exit 1; }
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNIT=code-terminal.service

# Fail early with a message that says what to fix.
[ -x "$HOME_DIR/.nvm/nvm-exec" ] || { echo "$HOME_DIR/.nvm/nvm-exec not found — install nvm for $USER_NAME, or edit ExecStart in deploy/$UNIT to an absolute node >= 22"; exit 1; }
[ -f "$REPO/.env" ] || { echo "missing $REPO/.env — cp .env.example .env"; exit 1; }
[ -d "$REPO/node_modules" ] || { echo "missing node_modules — run npm install as $USER_NAME first"; exit 1; }

render() { sed -e "s#__USER__#$USER_NAME#g" -e "s#__HOME__#$HOME_DIR#g" -e "s#__REPO__#$REPO#g" "$1"; }

render "$REPO/deploy/$UNIT" > "/etc/systemd/system/$UNIT"
chmod 0644 "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable --now "$UNIT"

if [ "${1:-}" = "--sudoers" ]; then
  render "$REPO/deploy/sudoers-code-terminal" > /etc/sudoers.d/code-terminal.tmp
  visudo -cf /etc/sudoers.d/code-terminal.tmp >/dev/null
  install -m 0440 -o root -g root /etc/sudoers.d/code-terminal.tmp /etc/sudoers.d/code-terminal
  rm -f /etc/sudoers.d/code-terminal.tmp
  echo "sudoers: $USER_NAME may restart/start/stop $UNIT without a password"
fi

sleep 2
systemctl --no-pager --lines=15 status "$UNIT" || true
echo
echo "logs:    journalctl -u $UNIT -f"
echo "restart: sudo systemctl restart $UNIT"
