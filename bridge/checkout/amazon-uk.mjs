/** checkout/amazon-uk.mjs - Amazon UK checkout adapter (skeleton).
 *
 *  Why Amazon: largest UK catalogue, the operator already has a logged-in
 *  account with saved address + saved card. With persistent cookies via
 *  bridge/checkout.mjs's getBrowser(), one manual login carries forward.
 *
 *  Status: SKELETON. Amazon has heavier bot detection than Argos — captchas,
 *  device fingerprinting, "select a checkout option" interstitials. Real
 *  selectors below need verification on a fresh session.
 *
 *  Recommended setup (one-off):
 *    1. Open the bridge's persistent profile manually:
 *         npx playwright codegen --browser=chromium \
 *           --user-data-dir=/tmp/flat-out-jarvis-checkout-profile \
 *           https://www.amazon.co.uk/
 *    2. Sign in. Complete one purchase manually so the session is "trusted".
 *    3. Verify selectors below match your DOM and uncomment the live click.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBrowser } from "../checkout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(HERE, "..", "..", "data", "receipts");

export const domain = "amazon.co.uk";
export const label = "Amazon UK";

export async function placeOrder({ item, maxPriceGbp, card, justification }) {
  if (!item) return { ok: false, error: "item is required" };
  if (!Number.isFinite(maxPriceGbp) || maxPriceGbp <= 0) return { ok: false, error: "maxPriceGbp must be positive" };
  if (!card?.pan) return { ok: false, error: "card vault returned incomplete details" };

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    /* Step 1: search.
     * Amazon's /s URL is the stable search endpoint. We use field-keywords so
     * URL parameters don't get re-parsed differently between marketplaces. */
    const q = encodeURIComponent(item.slice(0, 100));
    await page.goto(`https://www.amazon.co.uk/s?k=${q}`, { waitUntil: "domcontentloaded", timeout: 30_000 });

    /* Step 2: pick the cheapest result under cap that's also Prime/sold-by-Amazon.
     * Amazon returns sponsored slots first; we want non-sponsored, fulfilled-by-amazon
     * results. The selector below combines those filters. Real selectors
     * change frequently — verify on a fresh page before going live. */
    const cards = await page.locator('[data-component-type="s-search-result"]:not([data-sponsored="true"])').all();
    let chosen = null;
    for (const c of cards.slice(0, 12)) {
      const priceTxt = (await c.locator('.a-price .a-offscreen').first().innerText().catch(() => "")) || "";
      const m = priceTxt.match(/£\s*([\d,]+\.[\d]{2})/);
      const price = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
      if (Number.isFinite(price) && price <= maxPriceGbp) {
        chosen = { c, price };
        break;
      }
    }
    if (!chosen) return { ok: false, error: `No products at or under £${maxPriceGbp.toFixed(2)} in Amazon search for "${item}".` };

    /* Step 3: open the product page + add to basket. */
    await chosen.c.click();
    await page.waitForLoadState("domcontentloaded");
    await page.locator('#add-to-cart-button').click({ timeout: 10_000 });
    await page.waitForSelector('#nav-cart-count', { timeout: 10_000 });

    /* Step 4: go to basket + verify total. */
    await page.goto("https://www.amazon.co.uk/gp/cart/view.html", { waitUntil: "domcontentloaded" });
    const subtotalTxt = (await page.locator('#sc-subtotal-amount-buybox .a-size-medium').innerText().catch(() => "")) || "";
    const subMatch = subtotalTxt.match(/£\s*([\d,]+\.[\d]{2})/);
    const subtotal = subMatch ? parseFloat(subMatch[1].replace(/,/g, "")) : NaN;
    if (!Number.isFinite(subtotal)) return { ok: false, error: "Could not parse Amazon basket subtotal — refusing." };
    if (subtotal > maxPriceGbp) return { ok: false, error: `Amazon subtotal £${subtotal.toFixed(2)} exceeds authorised £${maxPriceGbp.toFixed(2)}.` };

    /* Step 5: STUBBED — checkout flow needs live verification.
     * Amazon's checkout has multiple interstitials (delivery option, payment
     * choice, "place your order"). Each adds friction selectors that need
     * recording on a real session. We screenshot the basket and stop here.
     * Wire the rest only after manual verification. */
    const stub = path.join(RECEIPTS_DIR, `amazon-stub-${Date.now()}.png`);
    await page.screenshot({ path: stub, fullPage: true }).catch(() => {});
    return {
      ok: false,
      error: `Amazon adapter checkout-step stubbed. Basket verified at £${subtotal.toFixed(2)}. Wire form-fill in bridge/checkout/amazon-uk.mjs after one-off codegen verification. Stub screenshot: ${stub}`,
    };
  } catch (e) {
    return { ok: false, error: `Amazon adapter crashed: ${e.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}
