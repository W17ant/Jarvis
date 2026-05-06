/** checkout/mpb.mjs - MPB used camera gear adapter (skeleton).
 *
 *  Why MPB: largest UK used-camera marketplace. Single-item listings make
 *  cart logic simple — no quantity selector, each "item" is a unique unit.
 *  The cap-check is critical because used gear prices fluctuate; a £900
 *  authorised body might list at £950 by the time the bot reaches the page.
 *
 *  Status: SKELETON. Selectors below are illustrative — verify on a real
 *  session before going live. MPB's cart flow is simpler than Amazon's
 *  (no Prime upsells, no captchas in normal use) so wiring this up after
 *  Argos works should be a half-day job.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getBrowser } from "../checkout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECEIPTS_DIR = path.resolve(HERE, "..", "..", "data", "receipts");

export const domain = "mpb.com";
export const label = "MPB";

export async function placeOrder({ item, maxPriceGbp, card, justification }) {
  if (!item) return { ok: false, error: "item is required" };
  if (!Number.isFinite(maxPriceGbp) || maxPriceGbp <= 0) return { ok: false, error: "maxPriceGbp must be positive" };
  if (!card?.pan) return { ok: false, error: "card vault returned incomplete details" };

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    /* Step 1: search MPB's catalogue. URL convention is /shop/<query>. */
    const q = encodeURIComponent(item.slice(0, 100));
    await page.goto(`https://www.mpb.com/en-uk/search?q=${q}&condition=excellent,good,well-used`, { waitUntil: "domcontentloaded", timeout: 30_000 });

    /* Step 2: cheapest result under cap. MPB ranks listings by relevance —
     * we sort by price ascending to get the best deal first. The data-testid
     * attributes are usually stable across MPB's redesigns. */
    const cards = await page.locator('[data-testid="product-card"]').all();
    let chosen = null;
    for (const c of cards.slice(0, 10)) {
      const priceTxt = (await c.locator('[data-testid="product-card-price"]').innerText().catch(() => "")) || "";
      const m = priceTxt.match(/£\s*([\d,]+(?:\.[\d]{2})?)/);
      const price = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
      if (Number.isFinite(price) && price <= maxPriceGbp) { chosen = { c, price }; break; }
    }
    if (!chosen) return { ok: false, error: `No products at or under £${maxPriceGbp.toFixed(2)} in MPB search for "${item}".` };

    /* Step 3: open product, add to basket. */
    await chosen.c.click();
    await page.waitForLoadState("domcontentloaded");
    await page.locator('button[data-testid="add-to-basket"]').click({ timeout: 10_000 });
    await page.waitForSelector('[data-testid="basket-item-count"]', { timeout: 10_000 });

    /* Step 4: basket cap-check. */
    await page.goto("https://www.mpb.com/en-uk/basket", { waitUntil: "domcontentloaded" });
    const totalTxt = (await page.locator('[data-testid="basket-total"]').innerText().catch(() => "")) || "";
    const m = totalTxt.match(/£\s*([\d,]+(?:\.[\d]{2})?)/);
    const total = m ? parseFloat(m[1].replace(/,/g, "")) : NaN;
    if (!Number.isFinite(total)) return { ok: false, error: "Could not parse MPB basket total — refusing." };
    if (total > maxPriceGbp) return { ok: false, error: `MPB basket total £${total.toFixed(2)} exceeds authorised £${maxPriceGbp.toFixed(2)}.` };

    /* Step 5: STUBBED. */
    const stub = path.join(RECEIPTS_DIR, `mpb-stub-${Date.now()}.png`);
    await page.screenshot({ path: stub, fullPage: true }).catch(() => {});
    return {
      ok: false,
      error: `MPB adapter checkout-step stubbed. Basket verified at £${total.toFixed(2)}. Wire form-fill in bridge/checkout/mpb.mjs after one-off codegen verification. Stub screenshot: ${stub}`,
    };
  } catch (e) {
    return { ok: false, error: `MPB adapter crashed: ${e.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}
