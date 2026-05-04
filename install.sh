#!/usr/bin/env bash
# install.sh - One-shot installer for Flat-Out HUD on macOS (Apple Silicon).
# Covers a clean machine: Homebrew → Node → ffmpeg → Ollama → models → Python venv → npm deps.
# Idempotent: re-runs are safe — every step checks "already installed" before doing work.
#
# Usage:
#   ./install.sh                   # full install
#   ./install.sh --models-only     # just pull/refresh Ollama models
#   ./install.sh --skip-models     # everything except the 19GB model pull (handy on slow links)
#
# After this finishes:
#   ./launch.sh kiosk              # start the HUD in fullscreen
#   ./tools/install-daemon.sh      # register auto-start on boot

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# Why: the M5 Max ships with Apple Silicon — Homebrew on /opt/homebrew, not /usr/local.
# Hard-fail on Intel so the install doesn't silently put binaries in the wrong PATH.
ARCH="$(uname -m)"
if [[ "$ARCH" != "arm64" ]]; then
  echo "[install] WARNING: this script is tuned for Apple Silicon (arm64); detected $ARCH"
  echo "          Continuing anyway — paths may need adjusting."
fi

BREW="/opt/homebrew/bin/brew"
[[ -x /usr/local/bin/brew ]] && BREW="/usr/local/bin/brew"

step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }

# Why: ASCII brand banner — only render when terminal is wide enough to keep the logo shape intact.
if [[ -f assets/fom-ascii.txt ]] && [[ "$(tput cols 2>/dev/null || echo 80)" -ge 145 ]]; then
  printf '\033[31m'
  cat assets/fom-ascii.txt
  printf '\033[0m\n'
fi

MODE="${1:-full}"

# ─────────────────────────────────────────────────────────────────
# 1. Homebrew
# ─────────────────────────────────────────────────────────────────
if [[ "$MODE" != "--models-only" ]]; then
  step "Homebrew"
  if ! command -v brew >/dev/null 2>&1 && [[ ! -x "$BREW" ]]; then
    warn "Homebrew not found — installing (you may be prompted for your password)"
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  else
    ok "already installed: $($BREW --version | head -1)"
  fi
  eval "$($BREW shellenv)"
fi

# ─────────────────────────────────────────────────────────────────
# 2. brew packages: node, ffmpeg, ollama, python@3.12
# ─────────────────────────────────────────────────────────────────
if [[ "$MODE" != "--models-only" ]]; then
  step "Brew packages (node, ffmpeg, imagemagick, ollama, python@3.12)"
  for pkg in node ffmpeg imagemagick ollama python@3.12; do
    if brew list "$pkg" >/dev/null 2>&1; then
      ok "$pkg already installed"
    else
      warn "installing $pkg ..."
      brew install "$pkg"
    fi
  done
fi

# ─────────────────────────────────────────────────────────────────
# 3. Ollama service
# ─────────────────────────────────────────────────────────────────
step "Ollama service"
if ! pgrep -x ollama >/dev/null 2>&1; then
  warn "starting ollama service ..."
  brew services start ollama 2>/dev/null || nohup ollama serve >/tmp/ollama.log 2>&1 &
  sleep 3
fi
if curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
  ok "ollama responding on :11434"
else
  warn "ollama did not come up — try: brew services restart ollama"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────
# 4. Models (qwen2.5:32b ~19GB, nomic-embed-text ~274MB)
# ─────────────────────────────────────────────────────────────────
if [[ "$MODE" != "--skip-models" ]]; then
  step "Ollama models"
  for model in "qwen2.5:32b" "nomic-embed-text"; do
    if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
      ok "$model already pulled"
    else
      warn "pulling $model (this may take a while) ..."
      ollama pull "$model"
    fi
  done
fi

if [[ "$MODE" == "--models-only" ]]; then
  echo ""; ok "models step complete"; exit 0
fi

# ─────────────────────────────────────────────────────────────────
# 5. Python venv + Kokoro/Whisper deps
# ─────────────────────────────────────────────────────────────────
step "Python venv (.venv)"
PY="$(brew --prefix python@3.12 2>/dev/null)/bin/python3.12"
[[ -x "$PY" ]] || PY="python3"
if [[ ! -x "$HERE/.venv/bin/python" ]]; then
  warn "creating .venv with $PY ..."
  "$PY" -m venv .venv
fi
ok "venv at .venv ($("$HERE/.venv/bin/python" --version))"

step "Python deps (Kokoro TTS + faster-whisper STT)"
"$HERE/.venv/bin/pip" install --quiet --upgrade pip
"$HERE/.venv/bin/pip" install --quiet \
  "kokoro-onnx>=0.4" "onnxruntime" "soundfile" "numpy" \
  "faster-whisper" "ctranslate2"
ok "python deps installed"

# ─────────────────────────────────────────────────────────────────
# 5b. Kokoro ONNX model + voice bank
#
# Why fetched here, not committed: kokoro-v1.0.onnx is ~310 MB, exceeds
# GitHub's 100 MB single-file limit. Upstream releases at
# github.com/thewh1teagle/kokoro-onnx/releases — pin to v1.0 so a future
# upstream rev can't silently change voice characteristics.
# ─────────────────────────────────────────────────────────────────
step "Kokoro model + voices"
KOKORO_DIR="$HERE/assets/kokoro"
mkdir -p "$KOKORO_DIR"
KOKORO_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
# Two files. Skip download if already present.
for pair in "kokoro-v1.0.onnx" "voices-v1.0.bin"; do
  dest="$KOKORO_DIR/$pair"
  if [[ -f "$dest" && -s "$dest" ]]; then
    ok "$pair already present"
  else
    warn "downloading $pair (one-off, ~310 MB for the ONNX, ~27 MB for voices) ..."
    if curl -L --fail --progress-bar -o "$dest" "$KOKORO_BASE/$pair"; then
      ok "fetched $pair"
    else
      warn "could not download $pair from $KOKORO_BASE/$pair"
      warn "drop the file at $dest manually and re-run ./install.sh"
      exit 1
    fi
  fi
done

# ─────────────────────────────────────────────────────────────────
# 6. Node deps
# ─────────────────────────────────────────────────────────────────
step "npm install"
if [[ -d node_modules && -f node_modules/.package-lock.json ]]; then
  ok "node_modules present — running npm ci to sync"
  npm ci --silent || npm install --silent
else
  npm install --silent
fi
ok "node deps installed"

# ─────────────────────────────────────────────────────────────────
# 7. FAL key — required for image-to-video; optional for everything else
# ─────────────────────────────────────────────────────────────────
step "FAL.ai key (image-to-video)"
ENV_FILE="$HERE/.env"
if [[ -f "$ENV_FILE" ]] && grep -q "^FAL_KEY=" "$ENV_FILE"; then
  ok ".env already has FAL_KEY"
elif [[ -n "${FAL_KEY:-}" ]]; then
  echo "FAL_KEY=$FAL_KEY" > "$ENV_FILE"
  ok "wrote FAL_KEY from environment to .env"
else
  warn "no FAL_KEY found — image-to-video will be disabled."
  warn "to enable: echo 'FAL_KEY=fal-...' >> $ENV_FILE  (get one at https://fal.ai)"
fi

# ─────────────────────────────────────────────────────────────────
# 8. Required directories
# ─────────────────────────────────────────────────────────────────
step "Project directories"
mkdir -p "$HERE/data" "$HERE/output" "$HERE/shoots" "$HERE/tools/adhoc" "$HERE/assets/music"
ok "data/ output/ shoots/ tools/adhoc/ assets/music/ present"

# ─────────────────────────────────────────────────────────────────
# 9. Smoke tests
# ─────────────────────────────────────────────────────────────────
step "Smoke tests"

# Embeddings
if curl -s -X POST http://localhost:11434/api/embeddings \
   -d '{"model":"nomic-embed-text","prompt":"hello"}' | grep -q '"embedding"'; then
  ok "embeddings model responding"
else
  warn "embeddings model not responding — memory recall will be degraded"
fi

# Kokoro/Whisper voice deps importable
"$HERE/.venv/bin/python" -c "import kokoro_onnx, faster_whisper, soundfile, numpy" 2>/dev/null \
  && ok "voice stack imports cleanly" || warn "voice stack import failed — check .venv"

# Bridge starts
chmod +x "$HERE/launch.sh"

cat <<EOF

  ┌──────────────────────────────────────────────────────────────┐
  │  Install complete.                                           │
  │                                                              │
  │  Start everything (kiosk fullscreen):                        │
  │     ./launch.sh kiosk                                        │
  │                                                              │
  │  Start in windowed mode (better for first-run testing):      │
  │     ./launch.sh                                              │
  │                                                              │
  │  Register auto-start on boot:                                │
  │     ./tools/install-daemon.sh                                │
  │                                                              │
  │  Tail logs:                                                  │
  │     tail -f /tmp/flat-out-{bridge,kokoro,whisper,static}.log │
  └──────────────────────────────────────────────────────────────┘

EOF
