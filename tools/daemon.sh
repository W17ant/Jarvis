#!/usr/bin/env bash
# daemon.sh - Long-running supervisor for Jarvis HUD services.
# Started by launchd (com.jarvis.hud) so it must stay in the foreground —
# launch.sh detaches services and exits, which would make launchd respawn-loop.
#
# Why a separate script: launchd KeepAlive watches THIS process. We start the four
# services in the background, capture their PIDs, then `wait -n` for any to die,
# kill the others, and exit. launchd then restarts everything via the throttle.

set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

LOG_DIR=/tmp
PIDS=()

cleanup() {
  echo "[daemon] shutdown signal — killing children: ${PIDS[*]:-(none)}"
  for pid in "${PIDS[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  exit 0
}
trap cleanup INT TERM

start_svc() {
  local name="$1"; shift
  echo "[daemon] start $name: $*"
  ( "$@" >>"${LOG_DIR}/jarvis-${name}.log" 2>&1 ) &
  PIDS+=("$!")
}

# 1. static HUD server
start_svc static  python3 -m http.server 8765

# 2. Node bridge (memory, vision, frameio, MCP, premiere, etc)
start_svc bridge  node bridge/server.mjs

# 3. Kokoro TTS (Daniel + other British voices)
if [[ -x "$HERE/.venv/bin/python" ]]; then
  start_svc kokoro   "$HERE/.venv/bin/python" bridge/kokoro_server.py
  start_svc whisper  "$HERE/.venv/bin/python" bridge/whisper_server.py
else
  echo "[daemon] WARN: $HERE/.venv missing — kokoro + whisper disabled. Run ./install.sh."
fi

echo "[daemon] all services launched, pids=${PIDS[*]}"

# Why: wait -n returns when ANY child dies. We then kill the rest so launchd respawns
# everything together (clean state) instead of leaving a stale subset running.
wait -n "${PIDS[@]}"
RC=$?
echo "[daemon] a child exited (rc=$RC) — tearing down siblings so launchd respawns the group"
cleanup
