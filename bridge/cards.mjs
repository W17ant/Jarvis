/** cards.mjs - Pre-funded virtual debit card vault (macOS Keychain).
 *
 *  Why Keychain: card PAN + CVV must never be in this repo, never be in any
 *  config file, never be in process env, never be in a log. macOS Keychain is
 *  exactly the right place — encrypted at rest, gated by the operator's login
 *  password, and accessible from a single CLI (`security find-generic-password`)
 *  without an SDK dependency. The bridge never persists card data anywhere.
 *
 *  Storage shape:
 *    service:    jarvis-jarvis-card
 *    account:    <alias>     (e.g. "default" or "tesco-only")
 *    password:   JSON.stringify({ pan, expMonth, expYear, cvv, name, billing })
 *
 *  Card values only leave Keychain at the moment of checkout (Patch D's
 *  Playwright form-fill). They're never logged — only the last 4 digits of the
 *  PAN appear in journal entries. The full card never traverses the wider HUD
 *  WebSocket either; checkout happens entirely inside the bridge process.
 *
 *  Setup is interactive — see tools/register-card.sh. The bridge does NOT
 *  expose any HTTP endpoint for adding cards; an injection cannot install a
 *  rogue card via /purchases/* because there's no write surface.
 */

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(_execFile);

const KEYCHAIN_SERVICE = "jarvis-jarvis-card";

/** Look up a card alias from Keychain. Returns null if not found, throws on
 *  any other Keychain error (locked keychain, permission denied) so the caller
 *  can fail loud — silently falling back would risk a rogue write somewhere. */
export async function getCard(alias = "default") {
  const account = sanitiseAlias(alias);
  try {
    const { stdout } = await execFile("/usr/bin/security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", account,
      "-w",
    ]);
    const raw = stdout.trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateCardShape(parsed);
  } catch (e) {
    /* security exits 44 when the item is not found — that's a "no card", not
     * a real error. Anything else (keychain locked, permission denied) is
     * surfaced unchanged so the operator gets a useful message. */
    if (/security:.*could not be found/i.test(String(e.stderr || e.message))) return null;
    if (e.code === 44) return null;
    throw new Error(`Keychain read failed for "${account}": ${e.message}`);
  }
}

/** Last 4 digits + masked label for the journal. Never log the full PAN. */
export function maskCard(card) {
  if (!card?.pan) return null;
  const last4 = String(card.pan).replace(/\D/g, "").slice(-4);
  return { last4, label: `•••• ${last4}` };
}

/** Pre-flight: is the vault populated AND does Keychain unlock cleanly?
 *  Used by the bridge at startup to log a clear status line, and by the
 *  live-charge gate in purchases.mjs to reject if cards aren't ready. */
export async function isVaultReady(alias = "default") {
  try {
    const card = await getCard(alias);
    return { ready: !!card, alias, ...(card ? { last4: maskCard(card).last4 } : {}) };
  } catch (e) {
    return { ready: false, alias, error: e.message };
  }
}

/** Strict alias validator — only [a-z0-9_-]+, max 32 chars. Stops a malicious
 *  alias from breaking out of the security CLI argv (defense in depth — execFile
 *  doesn't shell, but bias toward safer inputs anyway). */
function sanitiseAlias(alias) {
  const s = String(alias || "default").trim();
  if (!/^[a-z0-9_-]{1,32}$/i.test(s)) {
    throw new Error(`Invalid card alias "${s}". Use [a-z0-9_-], max 32 chars.`);
  }
  return s;
}

/** Reject cards missing required fields. The vault tolerates extra fields
 *  (e.g. issuer, notes) but the four below are mandatory. expMonth/expYear are
 *  numeric so the form-fill code can format them per-merchant (some need MM/YY,
 *  others MM/YYYY). */
function validateCardShape(c) {
  if (!c || typeof c !== "object") throw new Error("Card payload is not an object");
  const required = ["pan", "expMonth", "expYear", "cvv"];
  for (const k of required) if (!c[k]) throw new Error(`Card missing required field: ${k}`);
  const pan = String(c.pan).replace(/\D/g, "");
  if (pan.length < 13 || pan.length > 19) throw new Error(`PAN must be 13-19 digits (got ${pan.length})`);
  const m = Number(c.expMonth);
  const y = Number(c.expYear);
  if (!Number.isInteger(m) || m < 1 || m > 12) throw new Error("expMonth must be 1-12");
  if (!Number.isInteger(y) || y < 2000 || y > 2099) throw new Error("expYear must be a 4-digit year");
  return { ...c, pan };
}
