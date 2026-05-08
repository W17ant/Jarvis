#!/usr/bin/env bash
# install-daemon.sh - Register Jarvis HUD as a launchd LaunchAgent.
# After this runs, the kiosk's services start at every login + survive crashes.
#
# Usage:
#   ./tools/install-daemon.sh                # install + load now
#   ./tools/install-daemon.sh --no-start     # install but don't start until next login
#
# What this DOES:
#   - Substitutes {{PROJECT_DIR}} into the plist template
#   - Copies it to ~/Library/LaunchAgents/com.jarvis.hud.plist
#   - launchctl bootstrap-loads the agent
#
# What this does NOT do:
#   - Open the kiosk Chrome window automatically. To auto-open the HUD on login, see
#     tools/install-kiosk-login-item.sh (separate; runs after services come up).

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$HERE/tools/launchd/com.jarvis.hud.plist.template"
TARGET="$HOME/Library/LaunchAgents/com.jarvis.hud.plist"
LABEL="com.jarvis.hud"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "✗ template missing: $TEMPLATE" >&2
  exit 1
fi
if [[ ! -x "$HERE/tools/daemon.sh" ]]; then
  chmod +x "$HERE/tools/daemon.sh"
fi

mkdir -p "$HOME/Library/LaunchAgents"

# Why: sed-substitute the project dir. No other variables today, but use a delimiter that
# can't appear in a path (|) so absolute paths with slashes don't break the substitution.
sed "s|{{PROJECT_DIR}}|$HERE|g" "$TEMPLATE" > "$TARGET"
echo "✓ wrote $TARGET"

# bootout if already loaded so re-runs are clean
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true

if [[ "${1:-}" != "--no-start" ]]; then
  launchctl bootstrap "gui/$UID" "$TARGET"
  echo "✓ loaded $LABEL — services start now and on every login"
  echo ""
  echo "Tail logs:"
  echo "  tail -f /tmp/jarvis-daemon.log /tmp/jarvis-{static,bridge,kokoro,whisper}.log"
  echo ""
  echo "Disable temporarily:  launchctl bootout gui/$UID/$LABEL"
  echo "Re-enable:            launchctl bootstrap gui/$UID $TARGET"
  echo "Permanent uninstall:  ./tools/uninstall-daemon.sh"
else
  echo "✓ installed but not started (--no-start) — will start on next login"
fi
