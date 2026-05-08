#!/usr/bin/env bash
# install-tailscale.sh - One-shot Tailscale setup for remote access to the kiosk.
#
# Why: gives the operator a way to reach the HUD + bridge from their phone or any
# device on the same Tailscale account, without exposing anything to the public
# internet. Tailscale Serve adds HTTPS inside the tailnet so iOS Safari can grant
# mic access for voice control on mobile.
#
# Usage:
#   ./tools/install-tailscale.sh                # interactive — prompts for HTTPS opt-in
#   ./tools/install-tailscale.sh --no-serve     # join tailnet only; skip the HTTPS Serve step
#   ./tools/install-tailscale.sh --uninstall    # logout + brew uninstall

set -uo pipefail

step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "  \033[1;33m!\033[0m %s\n" "$*"; }
die()  { printf "  \033[1;31m✗\033[0m %s\n" "$*"; exit 1; }

case "${1:-}" in
  --uninstall)
    step "Uninstalling Tailscale"
    sudo tailscale logout 2>/dev/null || true
    brew uninstall tailscale 2>/dev/null || true
    ok "removed"
    exit 0
    ;;
esac

# 1. Brew + Tailscale binary
step "Tailscale binary"
if ! command -v brew >/dev/null 2>&1; then
  die "Homebrew not installed. Run ./install.sh first to bootstrap the machine."
fi
if ! command -v tailscale >/dev/null 2>&1; then
  warn "tailscale not installed — installing via brew"
  brew install tailscale
else
  ok "tailscale already installed: $(tailscale version | head -1)"
fi

# 2. Bring up the tailnet membership
# Why: tailscale up triggers an OAuth-style auth flow in the browser. We just kick it
# off — the user authenticates with their Tailscale-linked identity (Google/GitHub/Apple/etc).
step "Joining the tailnet"
if tailscale status 2>/dev/null | head -1 | grep -q "^100\."; then
  ok "already authenticated as $(tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | cut -d'"' -f4)"
else
  warn "you'll be prompted to sign in via the browser. Use the SAME account on every device that needs to reach the kiosk."
  sudo tailscale up --accept-routes
fi

TS_IP=$(tailscale ip -4 2>/dev/null | head -1)
TS_NAME=$(tailscale status --json 2>/dev/null | grep -m1 '"DNSName"' | cut -d'"' -f4 | sed 's/\.$//')
ok "Tailscale IP:   $TS_IP"
ok "MagicDNS name:  ${TS_NAME:-(not configured — enable MagicDNS in the Tailscale admin console)}"

# 3. Tailscale Serve — gives in-tailnet HTTPS for the static HUD on :8765
# Why: iOS Safari refuses getUserMedia (mic access) over plain http. With Serve, the
# operator's phone reaches https://${TS_NAME}/ and voice control works as if on the kiosk.
SERVE=1
if [[ "${1:-}" == "--no-serve" ]]; then SERVE=0; fi

if [[ $SERVE -eq 1 ]]; then
  step "Tailscale Serve (HTTPS inside the tailnet)"
  warn "About to expose http://localhost:8765 (the HUD) at https://${TS_NAME:-<your-tailnet>}"
  warn "This is in-tailnet ONLY — no public internet exposure. Reachable only from devices signed into your Tailscale account."
  read -p "  Enable HTTPS Serve? [Y/n] " ans
  if [[ "${ans:-Y}" =~ ^[Yy]$ ]] || [[ -z "${ans:-}" ]]; then
    sudo tailscale serve reset 2>/dev/null || true
    sudo tailscale serve --bg --https=443 http://localhost:8765
    ok "HUD now reachable at https://${TS_NAME}"
    ok "(Mobile voice control: open that URL in iOS Safari, allow mic.)"
  else
    warn "skipped — re-run later with: sudo tailscale serve --bg --https=443 http://localhost:8765"
  fi
fi

# 4. Important: bridge:8766 stays tailnet-internal. NEVER funnel it to the public
# internet — the bridge exposes run_shell and write_file tools.
cat <<EOF

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Remote access ready.                                                    │
  │                                                                          │
  │  From your iPhone (after installing Tailscale + signing in):             │
  │     https://${TS_NAME:-<your-tailnet>}                                              │
  │                                                                          │
  │  SECURITY:                                                               │
  │   • Tailscale Serve is tailnet-only — not public internet                │
  │   • Do NOT run \`tailscale funnel\` on the bridge port (8766) — that         │
  │     exposes run_shell + write_file to the public internet                │
  │   • Funnel for :8765 (HUD) is fine if you want to share with clients     │
  │                                                                          │
  │  Status:    tailscale status                                             │
  │  Stop:      sudo tailscale serve reset                                   │
  │  Logout:    ./tools/install-tailscale.sh --uninstall                     │
  └──────────────────────────────────────────────────────────────────────────┘

EOF
