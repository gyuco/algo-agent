#!/bin/zsh
# Installs (or reinstalls) the backend as a login agent, so it comes back after
# a reboot or a crash. Run as the user who owns the machine, not with sudo.
set -euo pipefail

ROOT="${0:A:h:h}"
LABEL="com.giuseppeconcas.algo-agent"
PLIST="$ROOT/scripts/$LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/Logs/algo-agent" "$HOME/Library/LaunchAgents"

if [ ! -f "$ROOT/backend/dist/main.js" ]; then
  echo "backend/dist/main.js missing: run scripts/build-prod.sh first" >&2
  exit 1
fi

# bootout fails harmlessly when the agent isn't loaded yet.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$PLIST" "$TARGET"
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed $LABEL"
echo "  status: launchctl print gui/$(id -u)/$LABEL | head -20"
echo "  logs:   tail -f $HOME/Library/Logs/algo-agent/backend.log"
echo "  stop:   launchctl bootout gui/$(id -u)/$LABEL"
