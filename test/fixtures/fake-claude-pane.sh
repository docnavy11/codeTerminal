#!/usr/bin/env bash
# A stand-in for a Claude Code session in a tmux pane, for tests that type
# into one. Draws what the real CLI draws (measured from live panes on
# 2026-10-09): the transcript, a spinner line while working, the input box
# between two rules, the status line under it. Every line typed at it is
# appended to $1 (the log), so a test can see what arrived.
#   fake-claude-pane.sh <log> idle|working|shell
log="$1"; mode="${2:-idle}"
rule=$(printf '─%.0s' $(seq 1 100))
case "$mode" in
  idle)
    printf '● Waiting for your next instruction.\n\n✻ Baked for 3s · done 10:00 AM\n%s\n❯ \n%s\n  fake | Fable 5.1 | 5%% ctx\n' "$rule" "$rule" ;;
  working)
    printf '● Reading the code.\n\n✽ Frosting… (12s · ↓ 1.2k tokens)\n%s\n❯ \n%s\n  fake | Fable 5.1 | 5%% ctx\n' "$rule" "$rule" ;;
  shell)
    printf 'plain shell, no Claude here\n$ ' ;;
esac
while IFS= read -r line; do printf '%s\n' "$line" >> "$log"; done
