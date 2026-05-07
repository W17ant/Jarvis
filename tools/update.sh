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

# Source Homebrew's shellenv so brew-installed tools (node/npm/ollama/ffmpeg)
# are reliably on PATH. When this script runs from a non-login shell or via
# launchd/cron, the operator's interactive .zshrc isn't sourced, so a default
# /usr/bin:/bin PATH is all we get — and brew tools live in /opt/homebrew/bin.
# Without this, the script wrongly reports "npm: command not found" and
# "ollama not installed" on machines where everything actually IS installed.
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

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
    # Apple Silicon gets mlx-whisper for GPU STT (~2-3× faster than faster-whisper).
    # Non-arm64 sticks to faster-whisper above. uname -m gates match install.sh.
    if [[ "$(uname -m)" == "arm64" ]]; then
      .venv/bin/pip install --quiet --upgrade mlx-whisper || warn "mlx-whisper install failed — STT will fall back to faster-whisper"
    fi
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

# ─── 6.5 Ollama daemon restart ─────────────────────────────────────────────────
# Why: NUM_PARALLEL=1, FLASH_ATTENTION=1, KV_CACHE_TYPE=q8_0, KEEP_ALIVE=24h
# only take effect when Ollama itself restarts — the already-running daemon
# inherited the OLD environment. Without this step, Adam's M5 Max keeps
# crashing at 100% GPU because NUM_PARALLEL=4 is still in effect.
#
# We set launchctl vars HERE (idempotent — duplicated from launch.sh) before
# touching Ollama. The order is: writeenv → quit Ollama → relaunch → bridge.
# If we relied on launch.sh's setenv (step 7), Ollama would relaunch with
# stale env and miss the whole point.
step "Ollama daemon restart (pickup new env vars)"
if command -v launchctl >/dev/null 2>&1 && [[ $CHECK_ONLY -eq 0 ]]; then
  launchctl setenv OLLAMA_NUM_PARALLEL 1            >/dev/null 2>&1 || true
  launchctl setenv OLLAMA_FLASH_ATTENTION 1         >/dev/null 2>&1 || true
  launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0        >/dev/null 2>&1 || true
  launchctl setenv OLLAMA_KEEP_ALIVE 24h            >/dev/null 2>&1 || true
  launchctl setenv OLLAMA_MAX_LOADED_MODELS 2       >/dev/null 2>&1 || true
  ok "launchctl env vars set"
fi
if [[ -d "/Applications/Ollama.app" ]]; then
  if [[ $CHECK_ONLY -eq 1 ]]; then
    ok "would quit + relaunch Ollama.app"
  else
    if pgrep -fq "Ollama Helper\|Ollama\.app/Contents/MacOS/Ollama"; then
      osascript -e 'tell application "Ollama" to quit' 2>/dev/null || true
      # Wait for the daemon to actually exit before relaunching — otherwise the
      # new instance crashes on a still-bound :11434 and the operator sees a
      # silently dead Ollama.
      for i in {1..10}; do
        sleep 0.5
        pgrep -fq "Ollama Helper\|Ollama\.app/Contents/MacOS/Ollama" || break
      done
      ok "Ollama quit"
    else
      ok "Ollama wasn't running — fresh launch"
    fi
    open -a Ollama
    # Wait for :11434 to come back so the next step (services restart) doesn't
    # race against an empty Ollama state.
    for i in {1..20}; do
      sleep 0.5
      curl -fsS -m 1 http://localhost:11434/api/tags >/dev/null 2>&1 && break
    done
    if curl -fsS -m 1 http://localhost:11434/api/tags >/dev/null 2>&1; then
      ok "Ollama relaunched and listening on :11434"
    else
      warn "Ollama relaunch timed out — services may still report ollama-offline. Try: open -a Ollama"
    fi
  fi
elif command -v ollama >/dev/null 2>&1; then
  # CLI-only install (rare). Adam likely doesn't have this, but cover it cleanly.
  warn "Ollama CLI detected but no Ollama.app — restart your daemon manually:"
  warn "    pkill -f 'ollama serve' && ollama serve &"
else
  warn "Ollama not installed — install with: brew install ollama"
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
  # No launchd agent — call ./launch.sh restart directly. That kills every
  # bound port (covers stale-but-unresponsive bridges) and starts everything
  # fresh, with the binding-rebuild self-heal already wired in. Cleaner than
  # punting "pkill ... && ./launch.sh" to the operator and less error-prone.
  if [[ -x "$HERE/launch.sh" ]]; then
    "$HERE/launch.sh" restart
    ok "services restarted via ./launch.sh restart"
    ok "refresh the kiosk in Chrome with ⌘ Cmd + R"
  else
    warn "launchd agent not installed and ./launch.sh missing — restart manually:"
    warn "    cd $HERE && ./launch.sh restart"
  fi
fi

# ─── 8. Post-update operator instructions ─────────────────────────────────────
# What the operator needs to do AFTER the script finishes. Organised by
# urgency: action items (must-do), discoveries (new features they should try),
# safety nets (where to find logs, how to roll back). Coloured headings so the
# important parts catch the eye in a busy terminal.
RED=$'\033[1;31m'; CYN=$'\033[1;36m'; GRN=$'\033[1;32m'; DIM=$'\033[2m'; NC=$'\033[0m'

cat <<EOF

${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}
${RED}                       UPDATE COMPLETE${NC}
${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}

${CYN}1. Refresh the HUD${NC}
   Click the Flat-Out browser window and press ${GRN}Cmd+R${NC}.
   Picks up new HUD code, the launcher menu changes, and the new
   weather-icon fallback. Without this the HUD still runs the old JS.

${CYN}2. macOS will ask for permissions the first time you use the new tools${NC}
   On first use, macOS prompts you to allow Jarvis to control:
     - Messages (for "text Adam I'm running late")
     - Reminders (for "remind me to call mum at 6")
     - Music / Spotify (for "play some driving music")
     - Contacts (for resolving names → numbers in iMessage)
   Approve in: ${GRN}System Settings → Privacy & Security → Automation${NC}.
   This is a one-time approval per app. Until you approve, those voice
   commands will fail with "automation not permitted".

${CYN}3. Try the new voice commands${NC}
   Wake Jarvis with your hot phrase, then say any of these:
     "shut down" / "go to sleep"        — mutes mic, dims HUD
     "open Google Maps for Manchester"  — pops the URL in your browser
     "text Adam I'm running 10 late"    — iMessage with confirmation gate
     "remind me to call mum at 6pm"     — Apple Reminders
     "set a 20 minute timer for chicken"— in-HUD countdown + chime
     "play some driving music"          — Apple Music search + play

${CYN}4. New keyboard shortcut: ${GRN}Shift+Cmd+J${NC}
   Opens the Agent Console — a compact panel with:
     - Anthropic / OpenAI API key entry (optional, for Claude/GPT integration)
     - LLM workload routing (default chat / vision / high-stakes)
     - Live purchase audit log (any shopping the agent has tried)
   Same shortcut closes it.

${CYN}5. Tail logs if something looks off${NC}
   ${GRN}tail -f /tmp/flat-out-bridge.log${NC}        Bridge — main chat path
   ${GRN}tail -f /tmp/flat-out-kokoro.log${NC}        TTS server
   ${GRN}tail -f /tmp/flat-out-static.log${NC}        Static HUD server

${CYN}6. Roll back if you need to${NC}
   git stash list                       List anything the updater stashed
   git stash pop                        Restore your local edits
   git reset --hard HEAD~1              Bail out of this update entirely

${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}

EOF
