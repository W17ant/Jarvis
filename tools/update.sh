#!/usr/bin/env bash
# update.sh - Pull latest code + dependencies and restart services.
# Run on the client machine after the agency wants new features / fixes.
#
# Usage:
#   ./tools/update.sh           # full update
#   ./tools/update.sh --check   # show what would change without doing it
#
# Behaviour:
#   1. Backup memory.db (precaution before any code change)
#   2. Stash any local edits the operator might have made
#   3. git pull
#   4. npm install (no-op if package-lock unchanged)
#   5. pip install -r requirements (no-op if reqs unchanged) — only if .venv exists
#   6. ollama pull (any models referenced in package.json "models" field, if present)
#   7. Restart launchd LaunchAgent (or warn if not installed)
#
# Idempotent — safe to re-run.

set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }

# Why: print the FOM ASCII banner if the terminal is wide enough — same brand carry-through as the kiosk.
if [[ -f assets/fom-ascii.txt ]] && [[ "$(tput cols 2>/dev/null || echo 80)" -ge 145 ]]; then
  printf '\033[31m'  # FOM red
  cat assets/fom-ascii.txt
  printf '\033[0m\n'
fi

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# ─── 1. Backup memory.db ───────────────────────────────────────────────────────
step "Backing up memory.db"
if [[ -f data/memory.db ]]; then
  STAMP="$(date +%Y-%m-%d-%H%M%S)"
  mkdir -p data/backups
  cp -p data/memory.db "data/backups/memory-pre-update-${STAMP}.db"
  ok "saved data/backups/memory-pre-update-${STAMP}.db"
else
  warn "no data/memory.db yet — first run? skipping backup."
fi

# ─── 2. Stash local edits ──────────────────────────────────────────────────────
step "Local changes"
if ! git diff --quiet || ! git diff --cached --quiet; then
  if [[ $CHECK_ONLY -eq 1 ]]; then
    warn "local edits detected — would be stashed in a real run"
    git status --short | head -20
  else
    git stash push -u -m "auto-stash by tools/update.sh $(date -u +%FT%TZ)"
    ok "stashed — recover with: git stash list && git stash pop"
  fi
else
  ok "working tree clean"
fi

# ─── 3. Git pull ───────────────────────────────────────────────────────────────
step "git pull"
BEFORE=$(git rev-parse HEAD)
if [[ $CHECK_ONLY -eq 1 ]]; then
  git fetch --quiet
  AFTER=$(git rev-parse @{u} 2>/dev/null || echo "$BEFORE")
  if [[ "$BEFORE" == "$AFTER" ]]; then
    ok "already up to date"
  else
    warn "$(git log --oneline ${BEFORE}..${AFTER} | wc -l | tr -d ' ') commits available"
    git log --oneline "${BEFORE}..${AFTER}" | head -10
  fi
else
  git pull --ff-only
  AFTER=$(git rev-parse HEAD)
  if [[ "$BEFORE" == "$AFTER" ]]; then ok "already up to date"
  else ok "moved ${BEFORE:0:7} → ${AFTER:0:7}"; fi
fi

# ─── 4. npm install ────────────────────────────────────────────────────────────
step "npm install"
if [[ $CHECK_ONLY -eq 0 ]]; then
  npm install --silent
  ok "node deps in sync"
  # Why: native bindings (better-sqlite3) are pinned to a specific Node ABI.
  # If Homebrew has upgraded `node` between installs (or we just pulled a
  # commit that bumped a dependency), the binding can fall out of sync and
  # crash the bridge with NODE_MODULE_VERSION X / Y. Rebuild defensively —
  # idempotent + cheap when nothing has changed.
  npm rebuild better-sqlite3 --silent && ok "native bindings rebuilt"
else
  ok "skipped (--check)"
fi

# ─── 5. pip install ────────────────────────────────────────────────────────────
step "Python deps (.venv)"
if [[ -x .venv/bin/pip ]]; then
  if [[ $CHECK_ONLY -eq 0 ]]; then
    .venv/bin/pip install --quiet --upgrade pip
    .venv/bin/pip install --quiet kokoro-onnx onnxruntime soundfile numpy faster-whisper ctranslate2
    ok "python deps in sync"
  else
    ok "would refresh .venv"
  fi
else
  warn "no .venv — run ./install.sh first"
fi

# ─── 6. Ollama models ──────────────────────────────────────────────────────────
# Why: read declared models from package.json's "models" array (if any). Lets new
# code that depends on a fresh model self-describe its requirements without us
# having to remember to re-pull manually.
step "Ollama models"
if command -v ollama >/dev/null 2>&1; then
  MODELS=$(node -e "try { const p = require('./package.json'); console.log((p.models||[]).join('\n')); } catch {}" 2>/dev/null)
  if [[ -z "$MODELS" ]]; then
    ok "no 'models' array declared in package.json — skipping"
  else
    while IFS= read -r m; do
      [[ -z "$m" ]] && continue
      if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$m"; then
        ok "$m already pulled"
      elif [[ $CHECK_ONLY -eq 1 ]]; then
        warn "would pull $m"
      else
        ollama pull "$m"
        ok "pulled $m"
      fi
    done <<< "$MODELS"
  fi
else
  warn "ollama not installed — run ./install.sh"
fi

# ─── 7. Restart services ───────────────────────────────────────────────────────
step "Restart"
if [[ $CHECK_ONLY -eq 1 ]]; then
  ok "(skipped — would restart launchd agent or kill+respawn services)"
elif [[ -f "$HOME/Library/LaunchAgents/com.flatoutmedia.hud.plist" ]]; then
  launchctl bootout "gui/$UID/com.flatoutmedia.hud" 2>/dev/null || true
  launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/com.flatoutmedia.hud.plist"
  ok "launchd agent reloaded — services restarting"
else
  warn "launchd agent not installed (./tools/install-daemon.sh) — restart manually:"
  warn "    pkill -f 'node bridge/server.mjs' && ./launch.sh"
fi

cat <<EOF

  ┌──────────────────────────────────────────┐
  │  Update complete.                        │
  │  Tail logs:                              │
  │     tail -f /tmp/flat-out-bridge.log     │
  └──────────────────────────────────────────┘

EOF
