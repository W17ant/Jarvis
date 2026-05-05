#!/usr/bin/env bash
# diagnose.sh — one-command diagnostic bundle for Flat-Out Jarvis.
#
# Why: when something breaks, the operator shouldn't need to know which logs
# matter or how to attach them. This script bundles every relevant log into a
# single tarball on the Desktop and (on macOS) pre-fills an email to Antony
# with the bundle attached and a sensible subject line.
#
# Usage:
#   ./tools/diagnose.sh                # bundle + open email draft
#   ./tools/diagnose.sh --no-email     # just bundle, don't open Mail
#   ./tools/diagnose.sh --tail         # also dump last 200 lines to stdout

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$HOME/Desktop/flat-out-diag-${STAMP}.tgz"

# Collect every /tmp/flat-out-*.log we can find. Skip files that don't exist
# (kokoro/whisper logs are absent on installs without the Python venv).
LOGS=()
for f in /tmp/flat-out-bridge.log \
         /tmp/flat-out-kokoro.log \
         /tmp/flat-out-whisper.log \
         /tmp/flat-out-static.log \
         /tmp/flat-out-rebuild.log \
         /tmp/flat-out-bridge-test.log; do
  [[ -f "$f" ]] && LOGS+=("$f")
done

# Snapshot of system state — version drift, brand config, healthz response.
META_DIR="$(mktemp -d)"
{
  echo "=== Flat-Out diagnostic snapshot ==="
  echo "Generated: $(date)"
  echo "Hostname:  $(hostname)"
  echo "Mac:       $(sw_vers -productName 2>/dev/null) $(sw_vers -productVersion 2>/dev/null)"
  echo "Chip:      $(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  echo "RAM (GB):  $(( $(sysctl -n hw.memsize 2>/dev/null) / 1073741824 ))"
  echo "Node:      $(node --version 2>/dev/null || echo MISSING)"
  echo "npm:       $(npm --version 2>/dev/null || echo MISSING)"
  echo "Ollama:    $(ollama --version 2>/dev/null || echo MISSING)"
  echo ""
  echo "=== /healthz ==="
  curl -s -m 3 http://localhost:8766/healthz 2>&1 || echo "(bridge unreachable)"
  echo ""
  echo "=== Listening ports ==="
  # Why -sTCP:LISTEN: lsof -ti :PORT returns ANY socket on that port — including
  # CLOSE_WAIT / ESTABLISHED entries from clients (e.g. Chrome's HUD WebSocket
  # connecting to :8766). The unfiltered output made it look like "two bridges
  # running" when really one is the bridge and the other is the connected HUD.
  # Only the LISTEN process is the actual server we care about.
  for p in 8765 8766 8767 8768 11434; do
    pid=$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null | head -1 || true)
    echo "  :$p → ${pid:-(free)}"
  done
} > "$META_DIR/snapshot.txt"

# Brand config (no secrets — .env stays out of the tarball).
[[ -f "$HERE/config/brand.json" ]] && cp "$HERE/config/brand.json" "$META_DIR/brand.json"

tar -czf "$OUT" -C "$META_DIR" . ${LOGS[@]+"${LOGS[@]}"} 2>/dev/null
rm -rf "$META_DIR"

echo ""
echo "  ✓ Bundled $(printf "%d" ${#LOGS[@]}) log file(s) + system snapshot"
echo "  → $OUT"
echo ""

if [[ "${1:-}" == "--tail" ]]; then
  echo "  Last 200 lines of bridge log:"
  echo "  ─────────────────────────────"
  tail -200 /tmp/flat-out-bridge.log 2>/dev/null | sed 's/^/    /'
  exit 0
fi

if [[ "${1:-}" == "--no-email" ]]; then
  exit 0
fi

# Open Mail.app with a pre-filled draft + the bundle attached. AppleScript is
# the only reliable way to attach a file to a new compose window programmatically.
if command -v osascript >/dev/null 2>&1; then
  osascript <<APPLESCRIPT 2>/dev/null || true
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"Flat-Out Jarvis bug report — ${STAMP}", content:"
What I was trying to do:


What went wrong:


(Diagnostic bundle attached. Includes /tmp/flat-out-*.log, system snapshot, brand.json. No secrets — .env is excluded.)
"}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:"Antony@aoneill.co.uk"}
    tell content to make new attachment with properties {file name:POSIX file "$OUT"} at after the last paragraph
    set visible to true
  end tell
  activate
end tell
APPLESCRIPT
  echo "  ✓ Mail draft opened — fill in what happened and hit Send"
fi
