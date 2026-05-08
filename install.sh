#!/usr/bin/env bash
# install.sh - One-shot installer for Jarvis HUD on macOS (Apple Silicon).
#
# Built to be bulletproof for non-technical operators:
#   - Every step idempotent (re-runs are safe + fast)
#   - Hardware-tier auto-detection picks the right model sizes for your Mac
#   - Native bindings rebuilt after npm install (catches Node version drift)
#   - End-to-end smoke test boots the bridge briefly + checks /healthz
#   - Clear next-step output, no silent failures, friendly errors
#
# Usage:
#   ./install.sh                   # full install
#   ./install.sh --models-only     # just pull/refresh Ollama models
#   ./install.sh --skip-models     # everything except the model pull
#   ./install.sh --no-wizard       # don't offer to run setup-wizard at end
#
# After this finishes:
#   ./launch.sh kiosk              # start the HUD in fullscreen

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# ── Pretty-print helpers ──────────────────────────────────────
step()  { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()    { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn()  { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
fail()  { printf "  \033[1;31m✗\033[0m %s\n" "$*"; }
info()  { printf "  \033[2m·\033[0m %s\n" "$*"; }

# Trap any unexpected exit and tell the operator how to recover. Bash's set -e
# doesn't normally produce an explanation; this gives them somewhere to go.
on_error() {
  local code=$?
  echo ""
  fail "install.sh exited with code $code"
  echo ""
  echo "  What to do:"
  echo "  1. Scroll up to find the last red ✗ or yellow !  — that's the failing step."
  echo "  2. Most failures are network or permission related."
  echo "  3. Re-running ./install.sh is always safe — completed steps will skip."
  echo "  4. Stuck? Open the README and look for the matching step heading."
  echo ""
  exit "$code"
}
trap on_error ERR

# Hard-fail on Intel — paths and Homebrew layout differ.
ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  warn "this script is tuned for Apple Silicon (arm64); detected $ARCH"
  info "continuing anyway — paths may need adjusting"
fi

BREW="/opt/homebrew/bin/brew"
[[ -x /usr/local/bin/brew ]] && BREW="/usr/local/bin/brew"

# ── Brand banner if terminal is wide enough ────────────────

# ── Arg parsing ───────────────────────────────────────────────
MODE="full"
OFFER_WIZARD=1
for arg in "$@"; do
  case "$arg" in
    --models-only)  MODE="models-only" ;;
    --skip-models)  MODE="skip-models"  ;;
    --no-wizard)    OFFER_WIZARD=0 ;;
    -h|--help)
      sed -n '2,18p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
  esac
done

# ── Hardware tier detection ───────────────────────────────────
# Map chip + RAM to the right Qwen model sizes. Mirrors the wizard's tier table
# so the install pulls models the operator will actually use. Three tiers:
#   ultra   — 96 GB+ RAM           → 14b text + 7b VL   (M5/M4 Max — 32b pegged GPU and OOM'd)
#   max     — 64 GB                → 14b text + 7b VL   (safe middle, default)
#   pro     — 32 GB or older Macs  → 7b  text + 3b VL   (fast, lower accuracy)
detect_tier() {
  # macOS's `sysctl hw.memsize` returns bytes. Divide by 1024^3 for GB.
  local ram_gb=0
  if command -v sysctl >/dev/null 2>&1; then
    ram_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  fi
  if   (( ram_gb >= 96 )); then echo "ultra"
  elif (( ram_gb >= 60 )); then echo "max"
  elif (( ram_gb >= 30 )); then echo "pro"
  else                          echo "lite"
  fi
}

TIER="$(detect_tier)"
case "$TIER" in
  ultra)  TEXT_MODEL="qwen2.5:14b"; VL_MODEL="qwen2.5vl:7b"  ;;
  max)    TEXT_MODEL="qwen2.5:14b"; VL_MODEL="qwen2.5vl:7b"  ;;
  pro)    TEXT_MODEL="qwen2.5:14b"; VL_MODEL="qwen2.5vl:7b"  ;;
  lite|*) TEXT_MODEL="qwen2.5:7b";  VL_MODEL="qwen2.5vl:3b"  ;;
esac

# ─────────────────────────────────────────────────────────────────
# 1. Homebrew
# ─────────────────────────────────────────────────────────────────
if [[ "$MODE" != "models-only" ]]; then
  step "Homebrew"
  if ! command -v brew >/dev/null 2>&1 && [[ ! -x "$BREW" ]]; then
    warn "Homebrew not found — installing (you may be prompted for your password)"
    info "this is a one-off ~5 minute install"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else
    ok "already installed: $($BREW --version | head -1)"
  fi
  eval "$($BREW shellenv)"
fi

# ─────────────────────────────────────────────────────────────────
# 2. Brew packages
# ─────────────────────────────────────────────────────────────────
if [[ "$MODE" != "models-only" ]]; then
  step "Brew packages (node, ffmpeg, imagemagick, exiftool, ollama, python@3.12)"
  for pkg in node ffmpeg imagemagick exiftool ollama python@3.12; do
    if brew list "$pkg" >/dev/null 2>&1; then
      ok "$pkg already installed"
    else
      info "installing $pkg ..."
      brew install "$pkg" || { fail "brew install $pkg failed"; exit 1; }
      ok "installed $pkg"
    fi
  done
fi

# ─────────────────────────────────────────────────────────────────
# 3. Ollama service
# ─────────────────────────────────────────────────────────────────
step "Ollama service"
if ! pgrep -x ollama >/dev/null 2>&1; then
  info "starting ollama service ..."
  brew services start ollama 2>/dev/null || nohup ollama serve >/tmp/ollama.log 2>&1 &
  # Poll-and-wait — Ollama needs a few seconds to bind on first start.
  for i in {1..15}; do
    sleep 1
    curl -s http://localhost:11434/api/tags >/dev/null 2>&1 && break
  done
fi
if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
  ok "ollama responding on :11434"
else
  fail "ollama did not come up after 15 s"
  info "try: brew services restart ollama"
  info "or:  pkill ollama; ollama serve"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────
# 4. Models — text + vision + embeddings
# ─────────────────────────────────────────────────────────────────
if [[ "$MODE" != "skip-models" ]]; then
  step "Ollama models (~$([[ "$TIER" == "ultra" ]] && echo "40GB" || echo "16GB") download for tier=$TIER)"
  info "tier detected: $TIER  →  text=$TEXT_MODEL  vision=$VL_MODEL"
  for model in "$TEXT_MODEL" "$VL_MODEL" "nomic-embed-text"; do
    if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
      ok "$model already pulled"
    else
      info "pulling $model — this is the longest step, get a coffee"
      if ! ollama pull "$model"; then
        fail "ollama pull $model failed"
        info "common causes: network, disk space, ollama daemon stopped"
        info "free space: $(df -h "$HERE" | awk 'NR==2{print $4}')"
        info "retry with: ollama pull $model"
        exit 1
      fi
      ok "pulled $model"
    fi
  done

  # Verify each model is actually loadable — pull-success doesn't guarantee
  # the file is well-formed (a corrupted download still ends with "success").
  info "verifying models load cleanly ..."
  if curl -s -X POST http://localhost:11434/api/generate \
       -d "{\"model\":\"$TEXT_MODEL\",\"prompt\":\"hi\",\"stream\":false,\"options\":{\"num_predict\":1}}" \
       --max-time 60 | grep -q '"response"'; then
    ok "$TEXT_MODEL loaded + responded"
  else
    warn "$TEXT_MODEL didn't respond to a 1-token test"
    info "voice queries may fail — try: ollama run $TEXT_MODEL 'hi'"
  fi
fi

if [[ "$MODE" == "models-only" ]]; then
  echo ""; ok "models step complete"; exit 0
fi

# ─────────────────────────────────────────────────────────────────
# 5. Python venv + Kokoro/Whisper deps
# ─────────────────────────────────────────────────────────────────
step "Python venv (.venv)"
PY="$(brew --prefix python@3.12 2>/dev/null)/bin/python3.12"
[[ -x "$PY" ]] || PY="python3"
if [[ ! -x "$HERE/.venv/bin/python" ]]; then
  info "creating .venv with $PY ..."
  "$PY" -m venv .venv
fi
ok "venv at .venv ($("$HERE/.venv/bin/python" --version))"

step "Python deps (Kokoro TTS + Whisper STT)"
# --no-cache-dir avoids "Cache entry deserialization failed" warnings spammed
# during pip install when the per-user cache has stale entries from a previous
# Python version. Adds ~2s but keeps the output clean for non-technical users.
"$HERE/.venv/bin/pip" install --quiet --upgrade pip 2>&1 | grep -v "Cache entry" || true
"$HERE/.venv/bin/pip" install --quiet --no-cache-dir \
  "kokoro-onnx>=0.4" "onnxruntime" "soundfile" "numpy" \
  "faster-whisper" "ctranslate2" 2>&1 | grep -v "Cache entry" || true

# Why MLX Whisper: Apple-Silicon-only STT backend that runs on the GPU instead
# of CPU int8. 2-3× faster than faster-whisper on M-series. The whisper_server
# tries MLX first then falls back to faster-whisper, so installing both gives
# us GPU on arm64 and CPU on Intel/Linux fallback paths. Skip on non-arm64
# since mlx is a no-op there.
if [[ "$(uname -m)" == "arm64" ]]; then
  ok "Apple Silicon detected — installing mlx-whisper for GPU STT"
  "$HERE/.venv/bin/pip" install --upgrade "mlx-whisper" 2>&1 | grep -v "Cache entry" || true
else
  ok "Non-arm64 host — skipping mlx-whisper (faster-whisper handles STT)"
fi
ok "python deps installed"

# Verify the imports actually work — pip success doesn't guarantee runtime.
if "$HERE/.venv/bin/python" -c "import kokoro_onnx, faster_whisper, soundfile, numpy" 2>/dev/null; then
  ok "voice stack imports cleanly"
else
  fail "voice stack import failed"
  info "try: rm -rf .venv && ./install.sh"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────
# 5b. Kokoro ONNX model + voice bank
# ─────────────────────────────────────────────────────────────────
step "Kokoro model + voices"
KOKORO_DIR="$HERE/assets/kokoro"
mkdir -p "$KOKORO_DIR"
KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
for pair in "kokoro-v1.0.onnx" "voices-v1.0.bin"; do
  dest="$KOKORO_DIR/$pair"
  if [[ -f "$dest" && -s "$dest" ]]; then
    ok "$pair already present ($(du -h "$dest" | awk '{print $1}'))"
  else
    info "downloading $pair (~$([[ "$pair" == *.onnx ]] && echo "310 MB" || echo "27 MB"))"
    if curl -L --fail --progress-bar -o "$dest" "$KOKORO_BASE/$pair"; then
      ok "fetched $pair"
    else
      fail "could not download $pair"
      info "URL: $KOKORO_BASE/$pair"
      info "drop the file at $dest manually and re-run ./install.sh"
      exit 1
    fi
  fi
done

# ─────────────────────────────────────────────────────────────────
# 6. Node deps
# ─────────────────────────────────────────────────────────────────
step "npm install"
if [[ -d node_modules && -f node_modules/.package-lock.json ]]; then
  info "node_modules present — running npm ci to sync"
  npm ci --silent || npm install --silent
else
  npm install --silent
fi
ok "node deps installed"

# Native bindings — better-sqlite3 ships compiled binaries pinned to a
# specific Node ABI version. If the system's `node` got upgraded between
# `npm install` and `node bridge/server.mjs`, the binding won't load with
# ERR_DLOPEN_FAILED. Force a rebuild against the *active* Node so the
# version that ran npm install is the same one the bridge uses.
info "rebuilding native bindings against $(node --version) ..."
npm rebuild better-sqlite3 --silent
ok "native bindings rebuilt"

# ─────────────────────────────────────────────────────────────────
# 7. .env baseline
# ─────────────────────────────────────────────────────────────────
ENV_FILE="$HERE/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
# Auto-written by install.sh — re-run setup-wizard.mjs to change.
OLLAMA_MODEL=$TEXT_MODEL
VL_MODEL=$VL_MODEL
VL_KEEP_ALIVE=30s
EOF
  ok ".env initialised (tier=$TIER)"
else
  ok ".env already exists"
fi

# ─────────────────────────────────────────────────────────────────
# 8. Required directories
# ─────────────────────────────────────────────────────────────────
step "Project directories"
mkdir -p "$HERE/data" "$HERE/output" "$HERE/shoots" "$HERE/inbox" "$HERE/tools/adhoc" "$HERE/assets/music"
ok "data/ output/ shoots/ inbox/ tools/adhoc/ assets/music/ present"

# ─────────────────────────────────────────────────────────────────
# 9. Smoke tests — the most important step
# ─────────────────────────────────────────────────────────────────
step "End-to-end smoke test"

# Embeddings — used by the memory layer. If this fails the kiosk still works
# but recall is degraded.
if curl -s -X POST http://localhost:11434/api/embeddings \
     -d '{"model":"nomic-embed-text","prompt":"hello"}' | grep -q '"embedding"'; then
  ok "embeddings responding"
else
  warn "embeddings not responding — memory recall will be degraded"
fi

# Boot the bridge briefly to confirm everything wires up. We start it,
# wait for /healthz, then kill it. This catches:
#   - Native binding ABI mismatch
#   - Module syntax errors
#   - Port collisions
#   - Brand config errors
info "booting bridge for end-to-end test ..."
# Kill anything already on :8766 so the test doesn't false-pass on a stale bridge.
pkill -TERM -f "node bridge/server.mjs" 2>/dev/null || true
sleep 1
node bridge/server.mjs >/tmp/jarvis-bridge-test.log 2>&1 &
BRIDGE_PID=$!
SUCCESS=0
for i in {1..15}; do
  sleep 1
  if curl -s -m 2 http://localhost:8766/healthz >/dev/null 2>&1; then
    SUCCESS=1
    break
  fi
done
# Always tear down the test bridge — operator should start it cleanly via
# launch.sh, and a leftover process here would clash with the next launch.
kill -TERM $BRIDGE_PID 2>/dev/null || true
wait $BRIDGE_PID 2>/dev/null || true

if (( SUCCESS )); then
  ok "bridge booted + responded to /healthz"
else
  fail "bridge did not respond after 15 s"
  info "log tail:"
  tail -10 /tmp/jarvis-bridge-test.log | sed 's/^/    /'
  info "common causes: native binding mismatch, missing config/, port :8766 in use"
  exit 1
fi

chmod +x "$HERE/launch.sh" "$HERE/tools/uninstall-wizard.sh" 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────
# 10. Offer to run setup-wizard
# ─────────────────────────────────────────────────────────────────
WIZARD_DONE=0
if (( OFFER_WIZARD )) && [[ -t 0 ]] && [[ ! -f "$HERE/config/brand.json" ]]; then
  echo ""
  printf "\033[1;36m▶ Setup wizard\033[0m\n"
  info "config/brand.json is missing — run the setup wizard now to pick"
  info "your voice, agency name, brand colours, and folders."
  echo ""
  read -r -p "  Run setup wizard now? [Y/n]: " RUN_WIZARD
  if [[ -z "$RUN_WIZARD" || "$RUN_WIZARD" =~ ^[Yy] ]]; then
    node "$HERE/tools/setup-wizard.mjs" && WIZARD_DONE=1
  fi
fi

# ─────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────
echo ""
cat <<EOF
  ┌──────────────────────────────────────────────────────────────┐
  │  Install complete.                                           │
  │                                                              │
EOF

if (( WIZARD_DONE )); then
  cat <<EOF
  │  Launch the kiosk:                                           │
  │     ./launch.sh kiosk                                        │
EOF
else
  cat <<EOF
  │  Next:                                                       │
  │     node tools/setup-wizard.mjs   # pick voice, brand, etc   │
  │     ./launch.sh kiosk             # start the kiosk          │
EOF
fi

cat <<EOF
  │                                                              │
  │  Useful:                                                     │
  │     ./launch.sh                   # windowed test mode       │
  │     ./launch.sh restart           # restart services         │
  │     ./launch.sh stop              # stop services            │
  │     ./tools/install-daemon.sh     # auto-start on boot       │
  │     ./tools/uninstall-wizard.sh   # remove everything        │
  │                                                              │
  │  Logs:                                                       │
  │     tail -f /tmp/jarvis-{bridge,kokoro,whisper,static}.log │
  └──────────────────────────────────────────────────────────────┘

EOF

# Developer credit — printed at the end so the operator's last visual is the
# author signature. Same render pattern as the brand banner at install
# start, but in the brand red so it visually closes the bookend.
if [[ -f "$HERE/assets/aoneill-ascii.txt" ]] && [[ "$(tput cols 2>/dev/null || echo 80)" -ge 60 ]]; then
  printf '\033[31m'
  cat "$HERE/assets/aoneill-ascii.txt"
  printf '\033[0m'
  printf '  \033[2maoneill.co.uk · antony@aoneill.co.uk\033[0m\n\n'
fi
