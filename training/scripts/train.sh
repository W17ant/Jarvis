#!/usr/bin/env bash
# train.sh - End-to-end LoRA fine-tune of qwen2.5:7b for Jarvis tool routing.
#
# Runs on Apple Silicon via MLX. Outputs a fused model directory at
# training/output/qwen2.5-7b-jarvis/ that mlx-lm.server can serve directly,
# plus a LoRA-only adapter at training/output/adapters/ for incremental
# re-training.
#
# Usage:
#   ./train.sh                       # uses tool-routing-seed.jsonl
#   ./train.sh path/to/other.jsonl   # bring your own dataset
#
# First-run setup costs (one-time):
#   - venv creation + pip install mlx-lm: ~30s, ~500MB
#   - base model download (Qwen2.5-7B-Instruct-4bit): ~4.5GB, 2-5 min
# Training itself takes 10-20 min on M1 Max for 1000 iters.

set -euo pipefail

# Resolve repo paths regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRAINING_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$TRAINING_DIR/data"
OUTPUT_DIR="$TRAINING_DIR/output"
VENV_DIR="$TRAINING_DIR/.venv"

DATASET="${1:-$DATA_DIR/tool-routing-seed.jsonl}"
BASE_MODEL="${BASE_MODEL:-mlx-community/Qwen2.5-7B-Instruct-4bit}"
ITERS="${ITERS:-1000}"
LORA_LAYERS="${LORA_LAYERS:-16}"
BATCH_SIZE="${BATCH_SIZE:-1}"

# -------------------------------- preflight --------------------------------

if [[ ! -f "$DATASET" ]]; then
  echo "✗ dataset not found: $DATASET" >&2
  exit 1
fi
DATASET_LINES=$(wc -l <"$DATASET" | tr -d ' ')
if (( DATASET_LINES < 20 )); then
  echo "⚠ dataset has only $DATASET_LINES lines — LoRA needs 200+ to generalise."
  echo "  Run scripts/expand_dataset.py to mine failures from your bridge log,"
  echo "  hand-label them, append to the seed file, then re-run training."
  echo
  read -r -p "Train anyway? [y/N] " yn
  [[ "$yn" =~ ^[Yy] ]] || exit 0
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "✗ MLX requires Apple Silicon (arm64). Detected: $(uname -m)" >&2
  exit 1
fi

# -------------------------------- venv setup --------------------------------

if [[ ! -d "$VENV_DIR" ]]; then
  echo "→ creating venv at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

if ! python3 -c "import mlx_lm" 2>/dev/null; then
  echo "→ installing mlx-lm (one-time, ~500MB)"
  pip install --quiet --upgrade pip
  pip install --quiet mlx-lm
fi

# -------------------------------- split dataset --------------------------------

MLX_DATA="$OUTPUT_DIR/mlx-data"
mkdir -p "$MLX_DATA"

python3 - "$DATASET" "$MLX_DATA" <<'PY'
import json, random, sys
src, out_dir = sys.argv[1], sys.argv[2]
random.seed(42)
rows = [json.loads(l) for l in open(src) if l.strip()]
random.shuffle(rows)
n = len(rows)
# 80/10/10 split. With tiny datasets the valid/test splits are small;
# that's fine — they're sanity checks, not statistical estimates.
n_train = max(1, int(n * 0.8))
n_valid = max(1, int(n * 0.1))
splits = {
    "train": rows[:n_train],
    "valid": rows[n_train:n_train + n_valid],
    "test":  rows[n_train + n_valid:] or rows[-1:],  # never empty
}
for k, v in splits.items():
    with open(f"{out_dir}/{k}.jsonl", "w") as f:
        for r in v:
            f.write(json.dumps(r) + "\n")
print(f"  train={len(splits['train'])} valid={len(splits['valid'])} test={len(splits['test'])}")
PY

# -------------------------------- train --------------------------------

ADAPTERS_DIR="$OUTPUT_DIR/adapters/qwen2.5-7b-jarvis"
mkdir -p "$ADAPTERS_DIR"

echo "→ training LoRA: model=$BASE_MODEL iters=$ITERS layers=$LORA_LAYERS"
python3 -m mlx_lm.lora \
  --model "$BASE_MODEL" \
  --train \
  --data "$MLX_DATA" \
  --iters "$ITERS" \
  --batch-size "$BATCH_SIZE" \
  --num-layers "$LORA_LAYERS" \
  --adapter-path "$ADAPTERS_DIR"

# -------------------------------- fuse --------------------------------
# Fuses the LoRA adapter back into the base weights so mlx-lm.server can
# load a single self-contained model rather than base+adapter at runtime.
# Costs disk (~4.5GB) but eliminates a class of "adapter not loading"
# bugs and simplifies the serving story.

FUSED_DIR="$OUTPUT_DIR/qwen2.5-7b-jarvis"
echo "→ fusing adapter into base model → $FUSED_DIR"
python3 -m mlx_lm.fuse \
  --model "$BASE_MODEL" \
  --adapter-path "$ADAPTERS_DIR" \
  --save-path "$FUSED_DIR"

echo
echo "✓ done"
echo "  adapter only:  $ADAPTERS_DIR"
echo "  fused model:   $FUSED_DIR"
echo
echo "Next: ./scripts/serve.sh"
