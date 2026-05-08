#!/usr/bin/env bash
# uninstall-wizard.sh - Interactive uninstaller for Jarvis HUD on macOS.
#
# Walks through every artifact the install / runtime drops outside the project tree
# and prompts before deleting each one. Defaults are conservative: items that hold
# user data or are shared with other apps default to NO; items that are clearly
# project-only default to YES.
#
# Usage:
#   ./tools/uninstall-wizard.sh                  # interactive
#   ./tools/uninstall-wizard.sh --yes            # auto-yes for everything except shared/user-data
#   ./tools/uninstall-wizard.sh --purge          # auto-yes including user data and ollama itself (DESTRUCTIVE)
#   ./tools/uninstall-wizard.sh --dry-run        # show what would happen, change nothing
#
# What it can remove (in roughly the order it asks):
#   1. LaunchAgent  (~/Library/LaunchAgents/com.jarvis.hud.plist) — auto-start on login
#   2. Running processes (bridge / kokoro / whisper / static / kiosk Chrome window)
#   3. Tailscale serve config (if the kiosk was published to a tailnet)
#   4. Project-local artifacts (.venv, node_modules, output/, data/frame-cache, weather-cache)
#   5. Ollama models pulled by install.sh (qwen2.5:32b, qwen2.5vl:7b, nomic-embed-text)
#      — these live in ~/.ollama (a hidden folder), the main reason this wizard exists
#   6. ~/.ollama itself (the entire model store, ≥20GB)
#   7. Ollama brew package — only if the operator confirms; might be used by other apps
#   8. data/ user data — memory.db has contacts/projects/facts; gated behind explicit confirm
#   9. The project source tree itself — final, atomic, optional

set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.jarvis.hud"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
OLLAMA_HOME="$HOME/.ollama"

# ------------- arg parsing -------------
MODE="interactive"
for arg in "$@"; do
  case "$arg" in
    --yes)     MODE="yes" ;;
    --purge)   MODE="purge" ;;
    --dry-run) MODE="dry-run" ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *)
      echo "unknown flag: $arg (use --help)" >&2
      exit 1
      ;;
  esac
done

# ------------- pretty helpers -------------
C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'

step() { printf "\n${C_BOLD}${C_CYAN}▶ %s${C_RESET}\n" "$*"; }
ok()   { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "  ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
info() { printf "  ${C_DIM}·${C_RESET} %s\n" "$*"; }
err()  { printf "  ${C_RED}✗${C_RESET} %s\n" "$*"; }

# Confirm. Args: prompt, default ('y' or 'n'), category ('safe'|'shared'|'destructive').
# Behaviour by mode:
#   interactive — always asks
#   yes         — auto-y for safe + shared, auto-n for destructive
#   purge       — auto-y everywhere
#   dry-run     — auto-n everywhere, just prints what *would* run
confirm() {
  local prompt="$1" default="$2" category="${3:-safe}"
  case "$MODE" in
    purge)
      echo "y"; return ;;
    yes)
      if [[ "$category" == "destructive" ]]; then echo "n"; else echo "y"; fi
      return ;;
    dry-run)
      echo "n"; return ;;
  esac
  local hint="[Y/n]"; [[ "$default" == "n" ]] && hint="[y/N]"
  read -r -p "  $prompt $hint " ans
  ans="$(echo "${ans:-$default}" | tr '[:upper:]' '[:lower:]')"
  if [[ "$ans" == "y" || "$ans" == "yes" ]]; then echo "y"; else echo "n"; fi
}

# Run-or-pretend: prints command in dry-run, executes otherwise.
# Why: takes args as an array so we never eval — hostile $HOME or unusual paths
# can't cause command substitution. Use ` || true ` in callers if you want
# to ignore exit codes.
run() {
  if [[ "$MODE" == "dry-run" ]]; then
    info "would run: $*"
  else
    "$@"
  fi
}

human_size() {
  # arg: path. Outputs human-readable size or "(missing)".
  if [[ -e "$1" ]]; then du -sh "$1" 2>/dev/null | awk '{print $1}'; else echo "(missing)"; fi
}

# ------------- intro banner -------------
if [[ -f "$HERE/assets/fom-ascii.txt" ]] && [[ "$(tput cols 2>/dev/null || echo 80)" -ge 145 ]]; then
  printf '\033[31m'; cat "$HERE/assets/fom-ascii.txt"; printf '\033[0m\n'
fi

cat <<EOF
${C_BOLD}Jarvis HUD — Uninstall Wizard${C_RESET}
${C_DIM}Project root:${C_RESET} $HERE
${C_DIM}Mode:${C_RESET} $MODE

This wizard reverses what install.sh and tools/install-daemon.sh did. It will ask
before each destructive step — answer "n" (or just press Enter when N is the default)
to skip that step. ${C_BOLD}data/memory.db${C_RESET} (your contacts / projects / notes) and
the ${C_BOLD}~/.ollama${C_RESET} model store are gated behind explicit confirmations.

EOF
[[ "$MODE" == "dry-run" ]] && warn "DRY RUN — no files will be modified"

# ------------- 1. LaunchAgent -------------
step "1. LaunchAgent (auto-start on login)"
if [[ -f "$PLIST_TARGET" ]] || launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1; then
  if [[ "$(confirm "Stop and remove the launchd agent?" "y" safe)" == "y" ]]; then
    run launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
    if [[ -f "$PLIST_TARGET" ]]; then
      run rm "$PLIST_TARGET" && ok "removed $PLIST_TARGET"
    else
      ok "no plist file present (already removed)"
    fi
  else
    info "skipped"
  fi
else
  ok "no launchd agent installed"
fi

# ------------- 2. Running processes -------------
step "2. Running services"
RUNNING=()
for pat in "node bridge/server.mjs" "kokoro_server.py" "whisper_server.py" "python3 -m http.server 8765" "python3 -m http.server 8766" "Google Chrome.*--app=http://localhost:8765"; do
  if pgrep -f "$pat" >/dev/null 2>&1; then RUNNING+=("$pat"); fi
done
if [[ ${#RUNNING[@]} -eq 0 ]]; then
  ok "no running services found"
else
  warn "running: ${RUNNING[*]}"
  if [[ "$(confirm "Kill these processes now?" "y" safe)" == "y" ]]; then
    for pat in "${RUNNING[@]}"; do
      run pkill -f "$pat" 2>/dev/null || true
    done
    ok "services stopped"
  else
    info "left running"
  fi
fi

# ------------- 3. Tailscale serve (kiosk publish) -------------
step "3. Tailscale serve config"
if command -v tailscale >/dev/null 2>&1 && tailscale serve status 2>/dev/null | grep -qi "8765"; then
  warn "tailscale is publishing the HUD on this tailnet"
  if [[ "$(confirm "Stop tailscale serve for the HUD?" "y" safe)" == "y" ]]; then
    run tailscale serve --https=443 off 2>/dev/null || true
    run tailscale serve reset 2>/dev/null || true
    ok "tailscale serve cleared"
  else
    info "skipped"
  fi
else
  ok "tailscale not publishing the HUD"
fi

# ------------- 4. Project-local artifacts -------------
step "4. Project artifacts"
PROJECT_ITEMS=(
  ".venv:Python virtualenv (Kokoro/Whisper deps):safe"
  "node_modules:NPM dependencies:safe"
  "output:Rendered videos and PDFs:safe"
  "data/frame-cache:Vision-extracted keyframes:safe"
  "data/weather-cache:Open-Meteo response cache:safe"
  "data/trackday:Track-day metadata sidecars:safe"
  "shoots:Source shoot folders ${C_RED}(your client footage!)${C_RESET}:destructive"
)
for entry in "${PROJECT_ITEMS[@]}"; do
  IFS=':' read -r relPath desc category <<< "$entry"
  full="$HERE/$relPath"
  if [[ ! -e "$full" ]]; then info "$relPath — not present, skipping"; continue; fi
  size="$(human_size "$full")"
  default="y"; [[ "$category" == "destructive" ]] && default="n"
  if [[ "$(confirm "Remove $relPath ($desc, $size)?" "$default" "$category")" == "y" ]]; then
    run rm -rf "$full" && ok "removed $relPath"
  else
    info "kept $relPath"
  fi
done

# ------------- 5. Ollama models pulled by Jarvis -------------
# This is the headline reason for the wizard — qwen lives in a hidden folder under
# the user's home directory (~/.ollama), so a "rm -rf ./project" doesn't reclaim
# the ~20GB that install.sh pulled.
step "5. Ollama models (in hidden ~/.ollama folder)"
if command -v ollama >/dev/null 2>&1 && curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  /bin/cat <<EOF
  ${C_DIM}Models pulled by install.sh:${C_RESET}
    - qwen2.5:32b          (~19 GB — text reasoning + tool calling)
    - qwen2.5vl:7b         (~6  GB — vision: image / frame captions)
    - nomic-embed-text     (~274 MB — embeddings for semantic memory)

EOF
  for model in "qwen2.5:32b" "qwen2.5vl:7b" "qwen2.5vl:32b" "nomic-embed-text" "qwen2.5:14b"; do
    if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
      if [[ "$(confirm "Remove ollama model $model?" "y" shared)" == "y" ]]; then
        run ollama rm "$model" >/dev/null 2>&1 && ok "removed $model"
      else
        info "kept $model"
      fi
    fi
  done
else
  warn "ollama not running or not installed — skipping per-model removal"
  warn "if you want to free its disk space, see step 6 (~/.ollama directory)"
fi

# ------------- 6. ~/.ollama directory (everything ollama stores) -------------
step "6. ~/.ollama directory (full model store)"
if [[ -d "$OLLAMA_HOME" ]]; then
  size="$(human_size "$OLLAMA_HOME")"
  warn "$OLLAMA_HOME is $size — includes models AND any other ollama state"
  warn "Removing this is destructive: any other tool using ollama will lose its models too."
  if [[ "$(confirm "Delete the entire ~/.ollama directory?" "n" destructive)" == "y" ]]; then
    run rm -rf "$OLLAMA_HOME" && ok "removed $OLLAMA_HOME"
  else
    info "kept $OLLAMA_HOME (recover space later with: rm -rf $OLLAMA_HOME)"
  fi
else
  ok "no ~/.ollama directory"
fi

# ------------- 7. Ollama itself (brew package + service) -------------
step "7. Ollama service + binary"
if command -v ollama >/dev/null 2>&1; then
  if [[ "$(confirm "Stop and uninstall ollama (brew uninstall)?" "n" destructive)" == "y" ]]; then
    run brew services stop ollama 2>/dev/null || true
    run pkill -x ollama 2>/dev/null || true
    if command -v brew >/dev/null 2>&1; then
      run brew uninstall ollama 2>/dev/null || true
      ok "uninstalled ollama"
    else
      warn "brew not found — manually uninstall ollama if needed"
    fi
  else
    info "left ollama installed"
  fi
else
  ok "ollama not installed"
fi

# ------------- 8. data/ — memory.db with USER DATA -------------
step "8. User data (data/memory.db: contacts, projects, conversation history)"
if [[ -f "$HERE/data/memory.db" ]]; then
  size="$(human_size "$HERE/data")"
  warn "data/ contains contacts, projects, facts, conversation summaries (sqlite, $size)."
  warn "This is operator-built knowledge — gone is gone. Consider data/backups/ first."
  if [[ "$(confirm "Delete data/ entirely?" "n" destructive)" == "y" ]]; then
    run rm -rf "$HERE/data" && ok "removed data/"
  else
    info "kept data/ — back up data/memory.db before reinstalling if you want a clean slate"
  fi
elif [[ -d "$HERE/data" ]]; then
  # Why: surface that data/ exists but with no memory.db, so the operator doesn't
  # wonder whether the user-data step ran. Common after step 4 wiped caches.
  ok "no data/memory.db present (data/ remains for caches only)"
else
  ok "no data/ directory present"
fi

# ------------- 9. Auxiliary brew packages (rarely wanted) -------------
step "9. Brew packages (ffmpeg, imagemagick, node, python@3.12)"
info "These are commonly used by other apps; default is to leave them installed."
info "Skip this step entirely unless you set up the M5 Max purely for Jarvis."
if [[ "$(confirm "Even consider removing these shared brew packages?" "n" destructive)" == "y" ]]; then
  for pkg in ffmpeg imagemagick node python@3.12; do
    if brew list "$pkg" >/dev/null 2>&1; then
      if [[ "$(confirm "Uninstall brew $pkg?" "n" destructive)" == "y" ]]; then
        run brew uninstall "$pkg" 2>/dev/null || true
        ok "uninstalled $pkg"
      fi
    fi
  done
else
  info "kept all brew packages"
fi

# ------------- 10. Project tree itself -------------
step "10. Project source tree"
info "If you've removed everything above, the project tree itself is just code + config."
if [[ "$(confirm "Delete $HERE entirely?" "n" destructive)" == "y" ]]; then
  PARENT="$(dirname "$HERE")"
  if [[ "$MODE" == "dry-run" ]]; then
    info "would run: rm -rf '$HERE'"
  else
    # Why: cd OUT of the directory before deleting it — bash's CWD is now in a stale inode.
    cd "$PARENT"
    rm -rf "$HERE" && ok "removed $HERE"
  fi
else
  info "kept project tree at $HERE"
fi

# ------------- summary -------------
echo
step "Uninstall complete"
case "$MODE" in
  dry-run)
    info "DRY RUN — nothing changed. Re-run without --dry-run to actually uninstall."
    ;;
  purge)
    ok "Full purge complete. Project artifacts, models, and ollama removed."
    ;;
  *)
    ok "Uninstall finished. Items kept will need manual removal if you change your mind."
    ;;
esac

if [[ -f "$HERE/data/memory.db" ]] || [[ -d "$HERE/.venv" ]] || [[ -d "$HERE/node_modules" ]]; then
  echo
  warn "Some artifacts were intentionally kept. Re-run with --purge to wipe everything."
fi

echo
if [[ -f "$HERE/assets/aoneill-ascii.txt" ]] && [[ "$(tput cols 2>/dev/null || echo 80)" -ge 60 ]]; then
  printf '\033[31m'
  cat "$HERE/assets/aoneill-ascii.txt"
  printf '\033[0m'
  printf "  ${C_DIM}aoneill.co.uk · antony@aoneill.co.uk${C_RESET}\n\n"
fi
