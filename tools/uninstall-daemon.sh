#!/usr/bin/env bash
# uninstall-daemon.sh - Remove the Flat-Out HUD launchd LaunchAgent.
#
# Usage:
#   ./tools/uninstall-daemon.sh

set -euo pipefail
LABEL="com.flatoutmedia.hud"
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"

# bootout if loaded — don't fail if it isn't
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

if [[ -f "$TARGET" ]]; then
  rm "$TARGET"
  echo "✓ removed $TARGET"
else
  echo "✓ no plist installed (was already uninstalled)"
fi

# Kill any leftover services from the current session
pkill -f "node bridge/server.mjs" 2>/dev/null || true
pkill -f "kokoro_server.py" 2>/dev/null || true
pkill -f "whisper_server.py" 2>/dev/null || true
pkill -f "python3 -m http.server 8765" 2>/dev/null || true

echo "✓ services stopped"
echo ""
echo "The daemon is fully removed. To re-install: ./tools/install-daemon.sh"
