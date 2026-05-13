#!/usr/bin/env bash
# serve.sh - Start mlx-lm.server with the fused Jarvis-tuned model.
#
# Exposes an OpenAI-compatible /v1/chat/completions endpoint on port 8081.
# The Jarvis bridge already supports OpenAI-compatible providers via the
# OPENAI_API_BASE env var (see bridge/llm/providers.mjs), so wiring up
# Jarvis to use the tuned model is:
#
#   export OPENAI_API_BASE=http://localhost:8081/v1/chat/completions
#   export OPENAI_API_KEY=mlx-local                # any non-empty string
#   export LLM_PROVIDER_DEFAULT=openai
#   ./launch.sh restart
#
# Why port 8081 (not 8080, MLX's default): Jarvis already uses 8765-8768
# for static/bridge/kokoro/whisper. 8080 is the conventional "I have a
# random local service" port and conflicts more often than 8081. Easy
# to override via PORT env var.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINING_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$TRAINING_DIR/.venv"
FUSED_DIR="${MODEL_PATH:-$TRAINING_DIR/output/qwen2.5-7b-jarvis}"
PORT="${PORT:-8081}"

if [[ ! -d "$FUSED_DIR" ]]; then
  echo "✗ fused model not found at $FUSED_DIR" >&2
  echo "  Run ./train.sh first." >&2
  exit 1
fi

if [[ ! -d "$VENV_DIR" ]]; then
  echo "✗ venv not found — run ./train.sh first to set it up." >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

# Check if mlx_lm.server is importable. The mlx-lm package ships the server
# as a submodule but some older versions didn't — fail loud if it's missing
# so the operator knows to `pip install -U mlx-lm` rather than wonder why
# the port is dead.
if ! python3 -c "import mlx_lm.server" 2>/dev/null; then
  echo "✗ mlx_lm.server not available — try: pip install -U mlx-lm" >&2
  exit 1
fi

echo "→ serving $FUSED_DIR on http://localhost:$PORT"
echo "  (Ctrl-C to stop)"
echo
echo "  Wire Jarvis to use this server:"
echo "    export OPENAI_API_BASE=http://localhost:$PORT/v1/chat/completions"
echo "    export OPENAI_API_KEY=mlx-local"
echo "    export LLM_PROVIDER_DEFAULT=openai"
echo "    ./launch.sh restart"
echo

exec python3 -m mlx_lm.server --model "$FUSED_DIR" --port "$PORT" --host 127.0.0.1
