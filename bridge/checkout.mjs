/** checkout.mjs - Merchant adapter dispatcher for live purchases.
 *
 *  Each adapter implements one merchant's checkout flow with Playwright. The
 *  dispatcher's only job is to map a merchant domain to the adapter, list
 *  the adapters that exist, and provide a shared Playwright browser instance
 *  so we don't pay launch latency on every call.
 *
 *  Adapter contract (every adapter must export this shape):
 *    domain: string                — e.g. "argos.co.uk"
 *    label:  string                — human-readable, e.g. "Argos"
 *    placeOrder({ item, maxPriceGbp, card, justification }) → Promise<{
 *      ok: boolean,
 *      chargedGbp?: number,        — final amount actually charged
 *      merchantOrderId?: string,   — merchant's order ref for the journal
 *      receiptUrl?: string,        — URL or filesystem path to a saved receipt
 *      error?: string,             — when ok is false
 *    }>
 *
 *  Adding a new merchant: drop a file in bridge/checkout/<merchant>.mjs that
 *  exports an object matching the contract, then register it in ADAPTERS below.
 *  No further wiring needed — purchases.mjs picks it up automatically.
 *
 *  All adapters share these guarantees:
 *    - Headed browser (visible) by default — operator can watch the bot work
 *    - Cap check: refuse to click "Place Order" if final basket > maxPriceGbp
 *    - Screenshot of confirmation page saved to data/receipts/<orderId>.png
 *    - Card details fetched via cards.mjs at form-fill time, never logged
 */

import * as Argos from "./checkout/argos.mjs";

const ADAPTERS = [
  Argos,
];

/** Find an adapter for a registrable domain. Suffix-match so subdomains
 *  resolve to the same adapter (smile.amazon.co.uk → amazon.co.uk). */
export function findAdapter(domain) {
  const d = String(domain || "").toLowerCase();
  if (!d) return null;
  for (const a of ADAPTERS) {
    const ad = String(a.domain || "").toLowerCase();
    if (!ad) continue;
    if (d === ad || d.endsWith(`.${ad}`)) return a;
  }
  return null;
}

/** Diagnostic helper for the audit endpoint — what merchants the bridge can
 *  actually purchase from in live mode right now. */
export function listAdapters() {
  return ADAPTERS.map((a) => ({ domain: a.domain, label: a.label }));
}

/* ------------------------------------------------------------------------- *
 * Shared Playwright lifecycle
 *
 * Adapters import getBrowser() rather than launching their own — keeps a single
 * Chromium process across many checkouts. The browser is launched lazily on
 * first use (so simulator-mode installs never start it) and cleaned up when the
 * bridge exits via process.once("exit").
 * ------------------------------------------------------------------------- */

let _browserPromise = null;

/** Lazy Playwright import — keeps simulator-mode boot fast. Throws a clear
 *  error if playwright-core isn't installed (which would happen on a stripped
 *  install without the optional dep). */
async function loadPlaywright() {
  try {
    return await import("playwright-core");
  } catch (e) {
    throw new Error("playwright-core is not installed. Run: npm install playwright-core");
  }
}

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE_DIR = "/tmp/flat-out-jarvis-checkout-profile";

/** Lazy-launch a headed Chromium pointed at the operator's installed Chrome
 *  binary, with a dedicated profile dir so we don't fight with the operator's
 *  daily Chrome session. Returns the same browserContext on subsequent calls.
 *
 *  Why a persistent context: cookies + localStorage survive across runs, so
 *  Argos remembers the operator (no re-auth between purchases) and CSRF
 *  tokens minted on the first page load are reused on later ones. */
export async function getBrowser() {
  if (_browserPromise) return _browserPromise;
  _browserPromise = (async () => {
    const pw = await loadPlaywright();
    const ctx = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: CHROME_PATH,
      viewport: { width: 1280, height: 900 },
      /* No --start-maximized; we want a small window the operator can park
       * on a second display while Jarvis works. */
      args: ["--no-default-browser-check", "--no-first-run"],
    });
    process.once("exit", () => ctx.close().catch(() => {}));
    return ctx;
  })();
  return _browserPromise;
}
