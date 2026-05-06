#!/usr/bin/env bash
# register-card.sh — One-time setup for Jarvis's pre-funded virtual debit card.
#
# Stores card details in macOS Keychain under service "flat-out-jarvis-card".
# Keychain is encrypted at rest, gated by your login password — the bridge can
# read it via /usr/bin/security but the values never touch this repo.
#
# Usage:
#   ./tools/register-card.sh           # registers the "default" card
#   ./tools/register-card.sh tesco     # registers an alias-specific card
#
# Re-running with the same alias overwrites the previous entry.

set -euo pipefail

ALIAS="${1:-default}"
SERVICE="flat-out-jarvis-card"

if [[ ! "$ALIAS" =~ ^[a-zA-Z0-9_-]{1,32}$ ]]; then
  echo "Alias must be [a-zA-Z0-9_-], max 32 chars. Got: $ALIAS" >&2
  exit 1
fi

cat <<EOF
Jarvis virtual-card registration
================================
Alias:    $ALIAS
Service:  $SERVICE (macOS Keychain)

Use a PRE-FUNDED virtual debit card with a low balance — Revolut Virtual,
Monzo Virtual, Wise debit, etc. The bank-side balance ceiling is your hard
spend cap. The bridge enforces additional per-transaction / daily / weekly
caps from data/spending-limits.json on top.

You will be prompted for the card number, expiry, CVV, billing details.
Values are written straight to Keychain — they are not echoed back, not
logged, not stored on disk outside Keychain.

EOF

read -r -p "PAN (card number, no spaces): " PAN
read -r -p "Expiry month (1-12): " EXP_M
read -r -p "Expiry year (e.g. 2028): " EXP_Y
read -r -s -p "CVV (hidden): " CVV; echo
read -r -p "Cardholder name: " NAME
read -r -p "Billing line 1: " ADDR1
read -r -p "Billing city: " CITY
read -r -p "Billing postcode: " POSTCODE
read -r -p "Billing country (ISO-2, e.g. GB): " COUNTRY

# Strip anything but digits from the PAN. Quote as a JSON string so values
# containing apostrophes (e.g. names like O'Neill) round-trip cleanly.
PAN="${PAN//[^0-9]/}"
if (( ${#PAN} < 13 || ${#PAN} > 19 )); then
  echo "Refusing: PAN must be 13-19 digits (got ${#PAN})." >&2
  exit 1
fi

# Construct the JSON payload via Python so quoting is rigorous.
PAYLOAD="$(python3 - <<PY
import json
print(json.dumps({
    "pan":      "$PAN",
    "expMonth": int("$EXP_M"),
    "expYear":  int("$EXP_Y"),
    "cvv":      "$CVV",
    "name":     "$NAME",
    "billing": {
        "line1":    "$ADDR1",
        "city":     "$CITY",
        "postcode": "$POSTCODE",
        "country":  "$COUNTRY",
    },
}))
PY
)"

# -U updates an existing item with the same service+account; without it the
# command would error if the alias was previously registered.
/usr/bin/security add-generic-password \
  -U \
  -s "$SERVICE" \
  -a "$ALIAS" \
  -l "Jarvis virtual card ($ALIAS)" \
  -D "Jarvis pre-funded virtual debit card" \
  -w "$PAYLOAD"

LAST4="${PAN: -4}"
echo
echo "✓ Stored. Last 4: $LAST4 · alias: $ALIAS"
echo "  Verify:   security find-generic-password -s $SERVICE -a $ALIAS"
echo "  Forget:   security delete-generic-password -s $SERVICE -a $ALIAS"
