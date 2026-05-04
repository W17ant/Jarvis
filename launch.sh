#!/usr/bin/env bash
# launch.sh - One-command Flat-Out HUD startup.
# Starts: static server (8765), Node bridge (8766), Kokoro TTS server (8767),
# Whisper STT server (8768), then opens Chrome.
#
# Usage:
#   ./launch.sh              # windowed app mode (no chrome, draggable)
#   ./launch.sh kiosk        # true fullscreen (Cmd+Q to exit)
#   ./launch.sh restart      # kill all services + restart them (no Chrome reopen)
#   ./launch.sh stop         # kill all services, leave Chrome open
#   ./launch.sh kill         # alias of stop — kills every running instance
#   ./launch.sh reset        # wipe Chrome profile + restart from scratch

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
URL="http://localhost:8765/"

# ── Service control ────────────────────────────────────────────
# Kill by PORT, not by process name. lsof -ti :PORT returns every PID bound to
# that port — covers static (python3 http.server), bridge (node), kokoro/whisper
# (python from .venv) regardless of how they were spawned. More reliable than
# pkill -f against command-string patterns.
stop_services() {
  for port in 8765 8766 8767 8768; do
    pids=$(lsof -ti ":$port" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "[Flat-Out] killing :${port} (pid=${pids})"
      kill -TERM $pids 2>/dev/null || true
    fi
  done
  # Give them a beat to exit gracefully, then SIGKILL anything still bound.
  sleep 1
  for port in 8765 8766 8767 8768; do
    pids=$(lsof -ti ":$port" 2>/dev/null || true)
    [[ -n "$pids" ]] && kill -KILL $pids 2>/dev/null || true
  done
  echo "[Flat-Out] services stopped"
}

SKIP_CHROME=0     # set by restart so we don't open another Chrome window
case "${1:-}" in
  stop|kill)
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

# Self-heal native binding ABI mismatch.
# Why: better-sqlite3 ships compiled binaries pinned to a specific Node ABI.
# When Homebrew updates Node between `npm install` and now, the bridge crashes
# with `NODE_MODULE_VERSION X / Y` on first `require`. The end-user shouldn't
# need a developer to recover — we detect the error in the log and rebuild
# silently, then retry. Only triggers when the binding is actually broken.
heal_bridge_if_native_binding_mismatched() {
  # Wait briefly for the bridge to either bind :8766 or crash.
  for i in {1..6}; do
    sleep 1
    lsof -i ":8766" >/dev/null 2>&1 && return 0
  done
  if grep -q "NODE_MODULE_VERSION\|ERR_DLOPEN_FAILED\|better-sqlite3" /tmp/flat-out-bridge.log 2>/dev/null; then
    echo "[Flat-Out] native binding ABI mismatch detected — auto-rebuilding (one-time, ~30s) ..."
    (cd "$HERE" && npm rebuild better-sqlite3 --silent) >/tmp/flat-out-rebuild.log 2>&1
    if [[ $? -eq 0 ]]; then
      echo "[Flat-Out] rebuild ok — retrying bridge"
      bash -c "cd '$HERE' && node bridge/server.mjs" >/tmp/flat-out-bridge.log 2>&1 &
      echo "[Flat-Out] bridge retry pid=$!"
    else
      echo "[Flat-Out] rebuild failed — see /tmp/flat-out-rebuild.log"
    fi
  fi
}

# 1. static file server for the HUD
start_if_free 8765 "static"  bash -c "cd '$HERE' && python3 -m http.server 8765"

# 2. Node bridge (system stats, Ollama proxy, weather, video.edit pipeline)
start_if_free 8766 "bridge"  bash -c "cd '$HERE' && node bridge/server.mjs"
heal_bridge_if_native_binding_mismatched

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
