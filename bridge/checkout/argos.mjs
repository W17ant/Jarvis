/** checkout/argos.mjs - Argos UK checkout adapter (skeleton).
 *
 *  Why Argos for the first adapter:
 *    - Guest checkout (no login persistence to debug on the first build)
 *    - UK retailer (matches the user's GB virtual card billing)
 *    - Predictable URL structure: argos.co.uk/product/<id> → "Add to bag"
 *    - Wide product catalogue so it's a useful first capability
 *    - Click & Collect available at most stores — no delivery address fragility
 *
 *  Status: SKELETON. The selectors below are illustrative — real Argos
 *  selectors change frequently and need verification. Treat the first live
 *  run as a test with a £5 item before trusting larger amounts. The cap
 *  check at line "if (basketTotal > maxPriceGbp)" is the last safety net —
 *  it MUST always be active.
 *
 *  How to develop a new adapter:
 *    1. Open Argos in the persistent profile (use bridge/checkout.mjs's
 *       getBrowser()) and complete one purchase manually so cookies/login
 *       persist.
 *    2. Use Playwright codegen to record selectors:
 *         npx playwright codegen --browser=chromium https://www.argos.co.uk
 *    3. Plug those selectors into the placeOrder() flow below.
 *    4. Test with simulator-mode first (purchases.mjs returns simulated:true)
 *       so the click sequence executes without real money risk — comment out
 *       the final "Place Order" click while developing.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBrowser } from "../checkout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(HERE, "..", "..", "data", "receipts");

export const domain = "argos.co.uk";
export const label = "Argos";

/**
 * Place an order at Argos. Returns the standard adapter envelope (see
 * checkout.mjs for the contract).
 *
 * @param {object} args
 * @param {string} args.item             — natural-language description from the LLM
 * @param {number} args.maxPriceGbp      — bridge-enforced upper bound; we re-check at basket
 * @param {object} args.card             — card details from cards.mjs (PAN, CVV, expiry, billing)
 * @param {string} args.justification    — for the journal/screenshot only
 */
export async function placeOrder({ item, maxPriceGbp, card, justification }) {
  if (!item) return { ok: false, error: "item is required" };
  if (!Number.isFinite(maxPriceGbp) || maxPriceGbp <= 0) return { ok: false, error: "maxPriceGbp must be positive" };
  if (!card?.pan || !card?.cvv) return { ok: false, error: "card vault returned incomplete details" };

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    /* Step 1: search.
     * The LLM hands us a free-form item description. Argos's search URL is
     * stable: /search/<query>. We use the search page rather than typing into
     * the search box so we don't fight autocomplete suggestions. */
    const searchQuery = encodeURIComponent(item.slice(0, 80));
    await page.goto(`https://www.argos.co.uk/search/${searchQuery}`, { waitUntil: "domcontentloaded", timeout: 30_000 });

    /* Step 2: pick the first product card under the price cap.
     * Argos shows price as e.g. "£14.99". We scan the first ~10 results and
     * click the cheapest one whose price is ≤ maxPriceGbp. If nothing fits,
     * we abort cleanly — better than buying something the operator didn't
     * intend. The selector below is the documented one as of the last manual
     * test; verify before first live run. */
    const products = await page.locator('[data-test="component-product-card"]').all();
    let chosen = null;
    for (const p of products.slice(0, 10)) {
      const priceText = (await p.locator('[data-test="component-product-card-price"]').first().innerText().catch(() => "")) || "";
      const priceMatch = priceText.match(/£\s*([\d.]+)/);
      const price = priceMatch ? parseFloat(priceMatch[1]) : NaN;
      if (Number.isFinite(price) && price <= maxPriceGbp) { chosen = { p, price }; break; }
    }
    if (!chosen) {
      return { ok: false, error: `No products at or under £${maxPriceGbp.toFixed(2)} in Argos search for "${item}".` };
    }

    /* Step 3: open the product, add to bag.
     * Argos's "Add to trolley" button has a stable test id. We wait on the
     * basket counter incrementing as the success signal — clicking the button
     * alone isn't enough because it can fail silently if the item is OOS. */
    await chosen.p.click();
    await page.waitForLoadState("domcontentloaded");
    await page.locator('[data-test="add-to-trolley-button"]').click({ timeout: 10_000 });
    await page.waitForSelector('[data-test="basket-count"]:not(:empty)', { timeout: 10_000 });

    /* Step 4: go to basket + verify total.
     * This is the critical safety check — even though we picked a product
     * under the cap, delivery + service fees can push the total over. If the
     * final basket total exceeds maxPriceGbp we abort BEFORE going to checkout. */
    await page.goto("https://www.argos.co.uk/basket", { waitUntil: "domcontentloaded" });
    const basketText = (await page.locator('[data-test="basket-total"]').innerText().catch(() => "")) || "";
    const basketMatch = basketText.match(/£\s*([\d.]+)/);
    const basketTotal = basketMatch ? parseFloat(basketMatch[1]) : NaN;
    if (!Number.isFinite(basketTotal)) {
      return { ok: false, error: "Could not parse Argos basket total — refusing to proceed without a verified amount." };
    }
    if (basketTotal > maxPriceGbp) {
      return { ok: false, error: `Argos basket total £${basketTotal.toFixed(2)} exceeds authorised £${maxPriceGbp.toFixed(2)} (delivery/fees pushed it over). Refusing.` };
    }

    /* Step 5: checkout form-fill + place order.
     * INTENTIONALLY STUBBED — wiring this up is the operator's call once
     * they've verified Steps 1-4 work. Filling card details into the live
     * checkout page is the highest-risk operation in the entire codebase
     * and shouldn't ship without manual verification of every selector.
     *
     * When you do wire it up, the structure is:
     *   - click "Continue to checkout"
     *   - select Click & Collect or delivery
     *   - fill card.pan into the PAN field, expiry, cvv
     *   - fill billing address from card.billing
     *   - click "Place order"
     *   - wait for order-confirmation page
     *   - extract order ref via page.locator('[data-test="order-reference"]').innerText()
     *   - screenshot via page.screenshot({ path: receiptPath })
     *
     * For now we screenshot the basket page as proof of intent and return
     * a "stub" envelope. The bridge will surface this as adapter_error and
     * journal it — the operator sees exactly what didn't happen. */
    const stubReceipt = path.join(RECEIPTS_DIR, `argos-stub-${Date.now()}.png`);
    await page.screenshot({ path: stubReceipt, fullPage: true }).catch(() => {});
    return {
      ok: false,
      error: "Argos adapter checkout-step is stubbed. Verified product + basket up to £" + basketTotal.toFixed(2) + ". Wire up the form-fill section in bridge/checkout/argos.mjs to enable live charges. Stub screenshot: " + stubReceipt,
    };
  } catch (e) {
    return { ok: false, error: `Argos adapter crashed: ${e.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}
