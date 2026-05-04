#!/usr/bin/env bash
# launch.sh - One-command Flat-Out HUD startup.
# Starts: static server (8765), Node bridge (8766), Kokoro TTS server (8767),
# then opens Chrome with no browser chrome.
#
# Usage:
#   ./launch.sh           # windowed app mode (no chrome, draggable)
#   ./launch.sh kiosk     # true fullscreen (Cmd+Q to exit)
#   ./launch.sh restart   # kill all services + restart them (does not reopen Chrome)
#   ./launch.sh stop      # kill all services, leave Chrome open
#   ./launch.sh reset     # wipes profile + grants fresh, prompts mic/camera again

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
URL="http://localhost:8765/"

# ── Service control ────────────────────────────────────────────
# Restart / stop run BEFORE start_if_free so they take effect cleanly. Each
# service binds a fixed port; we kill by command-string match because the bridge
# launches as a child of bash via start_if_free and pkill on PID isn't reliable.
stop_services() {
  pkill -TERM -f "node bridge/server.mjs"     2>/dev/null || true
  pkill -TERM -f "bridge/kokoro_server.py"    2>/dev/null || true
  pkill -TERM -f "bridge/whisper_server.py"   2>/dev/null || true
  pkill -TERM -f "python3 -m http.server 8765" 2>/dev/null || true
  sleep 1
  echo "[Flat-Out] services stopped"
}

SKIP_CHROME=0     # set by restart so we don't open another Chrome window
case "${1:-}" in
  stop)
    stop_services
    exit 0
    ;;
  restart)
    echo "[Flat-Out] restarting services..."
    stop_services
    SKIP_CHROME=1   # the operator usually has the HUD already open in Chrome
    set -- "app"
    ;;
esac

start_if_free() {
  local port="$1"; local name="$2"; shift 2
  if lsof -i ":${port}" >/dev/null 2>&1; then
    echo "[Flat-Out] ${name} already running on :${port}"
  else
    "$@" >/tmp/flat-out-${name}.log 2>&1 &
    echo "[Flat-Out] ${name} started on :${port} (pid=$!)"
  fi
}

# 1. static file server for the HUD
start_if_free 8765 "static"  bash -c "cd '$HERE' && python3 -m http.server 8765"

# 2. Node bridge (system stats, Ollama proxy, weather, video.edit pipeline)
start_if_free 8766 "bridge"  bash -c "cd '$HERE' && node bridge/server.mjs"

# 3. Kokoro TTS server (free local voice — bf_emma British female)
# 4. Whisper STT server (faster-whisper, local, replaces Chrome cloud SpeechRecognition)
if [[ -x "$HERE/.venv/bin/python" ]]; then
  start_if_free 8767 "kokoro"   bash -c "cd '$HERE' && '$HERE/.venv/bin/python' bridge/kokoro_server.py"
  start_if_free 8768 "whisper"  bash -c "cd '$HERE' && '$HERE/.venv/bin/python' bridge/whisper_server.py"
else
  echo "[Flat-Out] no .venv found — Kokoro & Whisper disabled. Run: python3 -m venv .venv && .venv/bin/pip install kokoro-onnx onnxruntime soundfile numpy faster-whisper"
fi

# Give services a moment to bind
sleep 2

if [[ "$SKIP_CHROME" == "1" ]]; then
  echo "[Flat-Out] services restarted — Chrome window not re-opened. Refresh the HUD with Cmd+R."
  exit 0
fi

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at $CHROME — open $URL manually."
  exit 1
fi

# Why: --kiosk has no chrome UI to prompt for mic permission. Auto-accept on localhost.
MIC_FLAGS="--auto-accept-camera-and-microphone-capture --enable-features=AutoplayIgnoreWebAudio"

MODE="${1:-app}"
# Why: use the main Chrome profile so mic permission + saved iPhone mic + localStorage carry over.
# A dedicated --user-data-dir was creating a fresh profile each time and losing the device choice.
case "$MODE" in
  kiosk) "$CHROME" --kiosk "$URL" $MIC_FLAGS >/dev/null 2>&1 & ;;
  app|*) "$CHROME" --app="$URL" --window-size=1600,1000 $MIC_FLAGS >/dev/null 2>&1 & ;;
esac

echo "[Flat-Out] launched in ${MODE} mode → $URL"
echo ""
echo "Tail logs:"
echo "  tail -f /tmp/flat-out-static.log /tmp/flat-out-bridge.log /tmp/flat-out-kokoro.log"
