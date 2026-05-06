/** purchases.mjs - Agentic purchase tool with hard rails.
 *
 *  The LLM never sees the virtual card. It calls request_purchase({ merchant, item,
 *  maxPriceGbp, justification }) and the bridge enforces — in this order —
 *  per-transaction cap, merchant allowlist, daily/weekly budget, then journals
 *  the attempt. In simulator mode (the default) no real charge happens — we
 *  return a simulated transaction id and write to data/purchase-log.jsonl so the
 *  operator can audit the LLM's intent before any real money is risked.
 *
 *  Defense in depth — even with a pre-funded virtual card capping the bank-side
 *  exposure, we cap again locally. A prompt-injection that says "buy a £4,000
 *  watch" hits the £30 per-transaction cap before it gets anywhere near the card.
 *
 *  All numbers come from data/spending-limits.json. The allowlist comes from
 *  data/merchant-allowlist.json. Both are read on every call (cheap; ~1ms) so
 *  edits take effect without restarting the bridge — useful when the operator
 *  wants to add a merchant mid-session.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Cards from "./cards.mjs";
import * as Checkout from "./checkout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const LIMITS_PATH = path.join(DATA_DIR, "spending-limits.json");
const ALLOWLIST_PATH = path.join(DATA_DIR, "merchant-allowlist.json");
const JOURNAL_PATH = path.join(DATA_DIR, "purchase-log.jsonl");

/** Conservative defaults — used if the JSON files are missing or malformed.
 *  Numbers are deliberately small so a fresh install can never overspend.
 *  This shape mirrors data/spending-limits.json — categories + globalCaps +
 *  tiers — so a missing file behaves identically to one that loads cleanly. */
const DEFAULT_LIMITS = {
  currency: "GBP",
  categories: {
    default: { perTransactionMaxGbp: 30, dailyCapGbp: 50, weeklyCapGbp: 150, monthlyCapGbp: 400 },
  },
  globalCaps: { dailyCapGbp: 100, weeklyCapGbp: 300, monthlyCapGbp: 800 },
  tiers: { autoMaxGbp: 5, voiceMaxGbp: 25 },
  simulatorMode: true,
};

/** Load + sanitise spending limits. Falls back to DEFAULT_LIMITS on any I/O or
 *  parse error so a corrupted file can't bypass the caps. Shape: categories
 *  hash + globalCaps + tiers + simulatorMode flag. */
async function loadLimits() {
  try {
    const raw = await fsp.readFile(LIMITS_PATH, "utf8");
    const j = JSON.parse(raw);
    /* Sanitise each category — clamp into safe ranges so a typo in the JSON
     * (e.g. £1500000 daily cap) can't widen the rails accidentally. */
    const sanCategory = (c) => ({
      perTransactionMaxGbp: clampNumber(c?.perTransactionMaxGbp, 0, 5000, 75),
      dailyCapGbp:          clampNumber(c?.dailyCapGbp,          0, 10000, 100),
      weeklyCapGbp:         clampNumber(c?.weeklyCapGbp,         0, 30000, 300),
      monthlyCapGbp:        clampNumber(c?.monthlyCapGbp,        0, 100000, 800),
    });
    const cats = {};
    for (const [name, cfg] of Object.entries(j.categories || {})) {
      if (name.startsWith("_")) continue; // skip _comment fields
      cats[name] = sanCategory(cfg);
    }
    if (!cats.default) cats.default = sanCategory(DEFAULT_LIMITS.categories.default);
    return {
      currency: j.currency || "GBP",
      categories: cats,
      globalCaps: {
        dailyCapGbp:   clampNumber(j?.globalCaps?.dailyCapGbp,   0, 50000, DEFAULT_LIMITS.globalCaps.dailyCapGbp),
        weeklyCapGbp:  clampNumber(j?.globalCaps?.weeklyCapGbp,  0, 200000, DEFAULT_LIMITS.globalCaps.weeklyCapGbp),
        monthlyCapGbp: clampNumber(j?.globalCaps?.monthlyCapGbp, 0, 500000, DEFAULT_LIMITS.globalCaps.monthlyCapGbp),
      },
      tiers: {
        autoMaxGbp:  clampNumber(j?.tiers?.autoMaxGbp,  0, 500,  DEFAULT_LIMITS.tiers.autoMaxGbp),
        voiceMaxGbp: clampNumber(j?.tiers?.voiceMaxGbp, 0, 2500, DEFAULT_LIMITS.tiers.voiceMaxGbp),
      },
      simulatorMode: j.simulatorMode !== false, // default true — only false if explicitly so
    };
  } catch {
    return DEFAULT_LIMITS;
  }
}

/** Pick the spending caps for a merchant's category. Falls back to "default"
 *  if the category is unknown — that's the catch-all so a new merchant
 *  added without a category still gets reasonable rails. */
function categoryCaps(limits, categoryName) {
  const name = String(categoryName || "default");
  return limits.categories[name] || limits.categories.default;
}

/** Load merchant allowlist. Returns [] on error so an absent file blocks ALL
 *  purchases — fail closed, not open. */
async function loadAllowlist() {
  try {
    const raw = await fsp.readFile(ALLOWLIST_PATH, "utf8");
    const j = JSON.parse(raw);
    return Array.isArray(j.merchants) ? j.merchants : [];
  } catch {
    return [];
  }
}

/** Clamp `n` into [min, max], or fall back to `dflt` if not a finite number. */
function clampNumber(n, min, max, dflt) {
  const x = Number(n);
  if (!Number.isFinite(x)) return dflt;
  return Math.max(min, Math.min(max, x));
}

/** Reduce any merchant string the LLM hands us to its registrable domain so
 *  https://www.amazon.co.uk/dp/B00XYZ matches the "amazon.co.uk" allowlist entry.
 *  Strips scheme/path/query/fragment and any leading "www." */
function normaliseMerchant(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  let host = s;
  try { host = new URL(s.startsWith("http") ? s : `https://${s}`).hostname; } catch {}
  return host.replace(/^www\./, "");
}

/** Match a normalised host against the allowlist. We match by *suffix* so a
 *  subdomain (smile.amazon.co.uk) still resolves to amazon.co.uk. */
function findAllowedMerchant(host, allowlist) {
  if (!host) return null;
  for (const m of allowlist) {
    const d = String(m.domain || "").toLowerCase();
    if (!d) continue;
    if (host === d || host.endsWith(`.${d}`)) return m;
  }
  return null;
}

/** Decide which confirmation tier this amount triggers. Lower bounds inclusive,
 *  upper exclusive — so an amount that lands exactly on autoMaxGbp is auto, but
 *  one penny over goes to voice. */
export function tierForAmount(amountGbp, limits) {
  const a = Number(amountGbp);
  if (!Number.isFinite(a) || a <= 0) return "voice";
  if (a <= (limits?.tiers?.autoMaxGbp ?? DEFAULT_LIMITS.tiers.autoMaxGbp)) return "auto";
  if (a <= (limits?.tiers?.voiceMaxGbp ?? DEFAULT_LIMITS.tiers.voiceMaxGbp)) return "voice";
  return "typed";
}

/** Read every settled purchase from the journal. Settled = ok:true purchases —
 *  rejected attempts and pending confirmations don't count toward budgets.
 *  Streaming line-by-line would be marginally cheaper but the journal is small. */
async function loadJournal() {
  try {
    const raw = await fsp.readFile(JOURNAL_PATH, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Sum settled charges in [sinceTs, now]. Optional filter narrows to a subset
 *  (e.g. only the same category). Returns 0 if no entries match. */
function sumSpendSince(journal, sinceTs, filterFn) {
  let total = 0;
  for (const e of journal) {
    if (!e?.settled) continue;
    if (typeof e.ts !== "number" || e.ts < sinceTs) continue;
    if (filterFn && !filterFn(e)) continue;
    const a = Number(e.amountGbp);
    if (Number.isFinite(a)) total += a;
  }
  return total;
}

/** Append one journal entry. Atomic-ish — single write, single flush. JSONL so
 *  it's grep-friendly and append-only. Never throws — journalling failures
 *  must not block a transaction decision. */
async function appendJournal(entry) {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.appendFile(JOURNAL_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    console.warn(`[purchases] journal append failed: ${e.message}`);
  }
}

/** Main entry: the LLM's request_purchase tool routes here.
 *
 *  Order of checks matters — cheapest first, so a malformed call is rejected
 *  without touching the disk. Allowlist before budget so the operator gets
 *  a more actionable error ("merchant not allowed" beats "you've spent £X").
 *
 *  Returns one of three envelope shapes:
 *  - { ok: false, code, error, ... }                  — rejected, LLM should not retry
 *  - { ok: false, requires_confirmation, ... }        — voice gate trip; LLM speaks summary
 *  - { ok: true, simulated|live, transactionId, ... } — purchase recorded
 */
export async function requestPurchase({
  merchant,
  item,
  maxPriceGbp,
  justification,
  confirmed = false,
} = {}) {
  const ts = Date.now();
  const limits = await loadLimits();
  const allowlist = await loadAllowlist();

  /* 1. Field validation. */
  const cleanItem = String(item || "").trim();
  const cleanJustification = String(justification || "").trim();
  const amount = Number(maxPriceGbp);
  if (!cleanItem || !Number.isFinite(amount) || amount <= 0) {
    const entry = baseEntry(ts, merchant, cleanItem, amount, "rejected", "missing_fields");
    await appendJournal(entry);
    return { ok: false, code: "missing_fields", error: "Need item (string) and maxPriceGbp (positive number). Re-ask the operator with both." };
  }

  /* 2. Merchant allowlist + category resolution. We pull category FIRST so
   *    the per-transaction cap check below uses the right ceiling — a £1500
   *    camera lens at WEX is fine, the same amount at Tesco is not. */
  const host = normaliseMerchant(merchant);
  let matched = findAllowedMerchant(host, allowlist);
  if (!matched && merchant) {
    const lbl = String(merchant).trim().toLowerCase();
    matched = allowlist.find((m) => (m.label || "").toLowerCase() === lbl);
  }
  if (!matched) {
    const entry = baseEntry(ts, merchant, cleanItem, amount, "rejected", "merchant_not_allowed");
    await appendJournal(entry);
    return {
      ok: false,
      code: "merchant_not_allowed",
      error: `Merchant "${merchant}" is not on the allowlist. Tell the operator and ask if they want to add it to data/merchant-allowlist.json.`,
      allowed: allowlist.map((m) => `${m.label || m.domain} (${m.category || "default"})`),
    };
  }
  const caps = categoryCaps(limits, matched.category);

  /* 3. Per-transaction cap — bound by category. */
  if (amount > caps.perTransactionMaxGbp) {
    const entry = baseEntry(ts, merchant, cleanItem, amount, "rejected", "over_per_tx_cap");
    await appendJournal({ ...entry, category: matched.category || "default" });
    return {
      ok: false,
      code: "over_per_tx_cap",
      error: `£${amount.toFixed(2)} exceeds the ${matched.category || "default"} per-transaction cap (£${caps.perTransactionMaxGbp.toFixed(2)}). Pick something cheaper or ask the operator to bump the cap in data/spending-limits.json.`,
    };
  }

  /* 4. Budget windows. Two layers: per-category rolling totals AND a global
   *    cap that sums every category. Either one tripping rejects the spend. */
  const journal = await loadJournal();
  const dayAgo = ts - 24 * 60 * 60 * 1000;
  const weekAgo = ts - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = ts - 30 * 24 * 60 * 60 * 1000;
  const cat = matched.category || "default";
  const sumCategory = (sinceTs) => sumSpendSince(journal, sinceTs, (e) => (e.category || "default") === cat);
  const spentDayCat   = sumCategory(dayAgo);
  const spentWeekCat  = sumCategory(weekAgo);
  const spentMonthCat = sumCategory(monthAgo);
  const spentDayAll   = sumSpendSince(journal, dayAgo);
  const spentWeekAll  = sumSpendSince(journal, weekAgo);
  const spentMonthAll = sumSpendSince(journal, monthAgo);

  /* Category caps. */
  if (spentDayCat + amount > caps.dailyCapGbp) {
    return rejectOverCap(ts, merchant, cleanItem, amount, cat, "over_daily_cat_cap",
      `Would push today's ${cat} spend to £${(spentDayCat + amount).toFixed(2)} (cap £${caps.dailyCapGbp.toFixed(2)}, already £${spentDayCat.toFixed(2)}).`);
  }
  if (spentWeekCat + amount > caps.weeklyCapGbp) {
    return rejectOverCap(ts, merchant, cleanItem, amount, cat, "over_weekly_cat_cap",
      `Would push this week's ${cat} spend to £${(spentWeekCat + amount).toFixed(2)} (cap £${caps.weeklyCapGbp.toFixed(2)}, already £${spentWeekCat.toFixed(2)}).`);
  }
  if (spentMonthCat + amount > caps.monthlyCapGbp) {
    return rejectOverCap(ts, merchant, cleanItem, amount, cat, "over_monthly_cat_cap",
      `Would push this month's ${cat} spend to £${(spentMonthCat + amount).toFixed(2)} (cap £${caps.monthlyCapGbp.toFixed(2)}, already £${spentMonthCat.toFixed(2)}).`);
  }
  /* Global caps — final safety net. */
  if (spentDayAll + amount > limits.globalCaps.dailyCapGbp) {
    return rejectOverCap(ts, merchant, cleanItem, amount, cat, "over_daily_global_cap",
      `Would push today's TOTAL spend (across all categories) to £${(spentDayAll + amount).toFixed(2)} (global cap £${limits.globalCaps.dailyCapGbp.toFixed(2)}).`);
  }
  if (spentWeekAll + amount > limits.globalCaps.weeklyCapGbp) {
    return rejectOverCap(ts, merchant, cleanItem, amount, cat, "over_weekly_global_cap",
      `Would push this week's TOTAL spend to £${(spentWeekAll + amount).toFixed(2)} (global cap £${limits.globalCaps.weeklyCapGbp.toFixed(2)}).`);
  }
  if (spentMonthAll + amount > limits.globalCaps.monthlyCapGbp) {
    return rejectOverCap(ts, merchant, cleanItem, amount, cat, "over_monthly_global_cap",
      `Would push this month's TOTAL spend to £${(spentMonthAll + amount).toFixed(2)} (global cap £${limits.globalCaps.monthlyCapGbp.toFixed(2)}).`);
  }
  /* Helpers below define the journal envelopes that the success branch needs. */
  const spentToday = spentDayAll;
  const spentThisWeek = spentWeekAll;

  /* 5. Confirmation tier. The 'auto' tier passes through to step 6; 'voice'
   *    triggers the existing NEEDS_CONFIRMATION gate in server.mjs (which
   *    intercepts before this function runs). 'typed' parks the request in
   *    the pending store and returns a pendingId — the HUD listens for the
   *    purchase.typed_confirm.required broadcast, pops a modal, and settles
   *    via POST /purchases/confirm once the operator types the EXACT amount. */
  const tier = tierForAmount(amount, limits);
  if (tier === "typed" && !confirmed) {
    const pendingId = stashPendingTyped({ merchant, item: cleanItem, maxPriceGbp: amount, justification: cleanJustification });
    const entry = baseEntry(ts, merchant, cleanItem, amount, "pending_typed", "awaiting_typed_confirm");
    await appendJournal({ ...entry, pendingId });
    return {
      ok: false,
      code: "needs_typed_confirm",
      pendingId,
      amountGbp: amount,
      merchant: matched.label || matched.domain,
      item: cleanItem,
      error: `£${amount.toFixed(2)} requires typed confirmation in the HUD. Tell the operator: "I need you to type £${amount.toFixed(2)} in the HUD to authorise this purchase." Then stop and wait — the HUD modal will handle settlement.`,
    };
  }

  /* 6. Settle. Two paths:
   *      - simulatorMode (default): journal intent only, no money moves
   *      - live mode: hard preconditions (Keychain card vault populated, merchant
   *        has a checkout adapter) then hand off to Checkout.placeOrder. The
   *        live path returns the same envelope shape so the HUD doesn't care.
   *      Defense in depth: even if simulatorMode is somehow flipped off by a
   *      malicious file edit, the vault-and-adapter checks below still gate it. */
  const transactionId = `sim_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const txCommon = {
    ...baseEntry(ts, merchant, cleanItem, amount, "settled", "ok"),
    settled: true,
    transactionId,
    merchantLabel: matched.label || matched.domain,
    merchantDomain: matched.domain,
    category: matched.category || "default",
    justification: cleanJustification.slice(0, 240),
    tier,
    spentTodayGbp: Number((spentToday + amount).toFixed(2)),
    spentThisWeekGbp: Number((spentThisWeek + amount).toFixed(2)),
  };

  if (!limits.simulatorMode) {
    /* Live charge path — Patch C+D combined gate. Refuse cleanly if either the
     * card vault or the merchant adapter is missing; we'd rather have the LLM
     * relay an actionable error than silently fall back to simulator. */
    const vault = await Cards.isVaultReady("default").catch((e) => ({ ready: false, error: e.message }));
    if (!vault.ready) {
      const entry = baseEntry(ts, merchant, cleanItem, amount, "rejected", "vault_not_ready");
      await appendJournal({ ...entry, vaultError: vault.error || null });
      return {
        ok: false,
        code: "vault_not_ready",
        error: `Live mode is on but the card vault is not populated. Tell the operator to run tools/register-card.sh${vault.error ? ` (Keychain error: ${vault.error})` : ""}.`,
      };
    }
    const adapter = Checkout.findAdapter(matched.domain);
    if (!adapter) {
      const entry = baseEntry(ts, merchant, cleanItem, amount, "rejected", "no_checkout_adapter");
      await appendJournal(entry);
      return {
        ok: false,
        code: "no_checkout_adapter",
        error: `Live mode is on but no checkout adapter exists for ${matched.domain}. Tell the operator to add a bridge/checkout/<merchant>.mjs adapter or buy elsewhere.`,
        adaptersAvailable: Checkout.listAdapters(),
      };
    }
    /* Pre-charge journal: write "attempting" BEFORE the adapter runs so a
     * crash mid-charge still leaves a footprint. The adapter result then
     * supersedes this entry via a status update on success/failure. */
    await appendJournal({ ...txCommon, status: "attempting", settled: false, simulated: false });
    let chargeResult;
    try {
      const card = await Cards.getCard("default");
      chargeResult = await adapter.placeOrder({
        item: cleanItem,
        maxPriceGbp: amount,
        card,
        justification: cleanJustification,
      });
    } catch (e) {
      chargeResult = { ok: false, error: String(e.message || e) };
    }
    if (!chargeResult?.ok) {
      const entry = baseEntry(ts, merchant, cleanItem, amount, "rejected", "adapter_error");
      await appendJournal({ ...entry, simulated: false, adapterError: chargeResult?.error || "unknown" });
      return {
        ok: false,
        code: "adapter_error",
        error: `Checkout adapter for ${matched.domain} failed: ${chargeResult?.error || "unknown"}. Tell the operator — they may need to complete the purchase manually.`,
      };
    }
    const cardMask = Cards.maskCard(await Cards.getCard("default")) || {};
    await appendJournal({
      ...txCommon,
      simulated: false,
      transactionId: chargeResult.merchantOrderId || transactionId,
      cardLast4: cardMask.last4 || null,
      receiptUrl: chargeResult.receiptUrl || null,
      finalChargedGbp: chargeResult.chargedGbp ?? amount,
    });
    return {
      ok: true,
      simulated: false,
      transactionId: chargeResult.merchantOrderId || transactionId,
      merchant: matched.label || matched.domain,
      item: cleanItem,
      chargedGbp: chargeResult.chargedGbp ?? amount,
      tier,
      spentTodayGbp: txCommon.spentTodayGbp,
      spentThisWeekGbp: txCommon.spentThisWeekGbp,
      cardLast4: cardMask.last4 || null,
      receiptUrl: chargeResult.receiptUrl || null,
      note: "Live transaction completed. Receipt journalled.",
    };
  }

  /* Simulator path — default. Journal the intent and tell the LLM no real
   * money moved so it can phrase its reply accordingly. */
  await appendJournal({ ...txCommon, simulated: true });
  return {
    ok: true,
    simulated: true,
    transactionId,
    merchant: matched.label || matched.domain,
    item: cleanItem,
    chargedGbp: amount,
    tier,
    spentTodayGbp: txCommon.spentTodayGbp,
    spentThisWeekGbp: txCommon.spentThisWeekGbp,
    note: "SIMULATOR MODE — no real charge. Tell the operator a transaction was journalled and ask them to verify it on the audit log before flipping simulatorMode off.",
  };
}

/** Common shape for every journal entry — keeps the file scannable with
 *  `jq` / grep regardless of which branch wrote it. */
function baseEntry(ts, merchant, item, amount, status, reason) {
  return {
    ts,
    iso: new Date(ts).toISOString(),
    merchant: String(merchant || "").slice(0, 120),
    item: String(item || "").slice(0, 240),
    amountGbp: Number.isFinite(Number(amount)) ? Number(amount) : null,
    status,
    reason,
    settled: false,
    simulated: null,
  };
}

/** Helper for the over-cap rejection paths — DRY for the eight similar branches
 *  in requestPurchase. Journals the rejection with category metadata so the
 *  audit panel can group spend by category later. */
async function rejectOverCap(ts, merchant, item, amount, category, code, message) {
  const entry = baseEntry(ts, merchant, item, amount, "rejected", code);
  await appendJournal({ ...entry, category });
  return { ok: false, code, error: `${message} Tell the operator.` };
}

/** Public read-only helpers used by the HUD's audit panel + by NEEDS_CONFIRMATION. */
export async function getLimits() { return loadLimits(); }
export async function getAllowlist() { return loadAllowlist(); }
export async function getRecentJournal(limit = 50) {
  const j = await loadJournal();
  return j.slice(-Math.max(1, Math.min(500, limit))).reverse();
}

/* ------------------------------------------------------------------------- *
 * Pending typed-confirm store (Patch B)
 *
 * Typed-tier purchases (default £25-30) cannot be authorised by a voice "yes"
 * alone — too easy for a prompt-injection or background TV chatter to fake
 * consent. We park the request here, broadcast a HUD modal, and only settle
 * once the operator types the EXACT amount in the modal and POSTs to
 * /purchases/confirm/<pendingId>.
 *
 * Pending entries auto-expire after 5 minutes so a forgotten modal doesn't
 * leave the request hanging forever. The expiry sweep runs lazily on every
 * read — no timer needed. ------------------------------------------------- */

const PENDING_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string, { ts: number, payload: object, attempts: number }>} */
const _pending = new Map();

/** Issue a one-time pendingId. Random + URL-safe; collision is irrelevant
 *  given the 5-minute window + tiny request volume. */
function makePendingId() {
  return `tc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Drop expired entries. Called at the head of every public method that
 *  reads or writes the pending map — keeps the data fresh without a timer. */
function sweepPending() {
  const now = Date.now();
  for (const [id, entry] of _pending.entries()) {
    if (now - entry.ts > PENDING_TTL_MS) _pending.delete(id);
  }
}

/** Park a typed-tier request. Returns the pendingId the HUD modal will
 *  POST back with. Does NOT journal or settle — that happens in confirmTyped()
 *  once the operator's typed amount matches. */
export function stashPendingTyped(payload) {
  sweepPending();
  const pendingId = makePendingId();
  _pending.set(pendingId, { ts: Date.now(), payload: { ...payload }, attempts: 0 });
  return pendingId;
}

/** Confirm a typed-tier purchase. The operator's typed amount must match the
 *  LLM-supplied maxPriceGbp to within 1p — anything else is treated as a
 *  refusal so a stray keystroke doesn't authorise the wrong amount.
 *
 *  Returns the same envelope shape as requestPurchase() — { ok, ... } — so the
 *  HTTP handler can pass it straight through to the HUD. */
export async function confirmTyped(pendingId, enteredAmountGbp) {
  sweepPending();
  const entry = _pending.get(pendingId);
  if (!entry) {
    return { ok: false, code: "pending_not_found", error: "Pending purchase expired or never existed. Ask the LLM to call request_purchase again." };
  }
  entry.attempts += 1;
  /* Why: 3 attempts max. After that we drop the pending entry — bias toward
   * making the operator restart the whole flow if they keep typing the wrong
   * amount, since that's a strong signal of a phishing-style attempt where
   * someone's trying to slip a different amount past the cap. */
  if (entry.attempts > 3) {
    _pending.delete(pendingId);
    return { ok: false, code: "too_many_attempts", error: "Typed-confirm failed three times. Pending purchase dropped — restart the request." };
  }
  const expected = Number(entry.payload?.maxPriceGbp);
  const entered = Number(enteredAmountGbp);
  if (!Number.isFinite(expected) || !Number.isFinite(entered) || Math.abs(expected - entered) > 0.01) {
    return { ok: false, code: "amount_mismatch", error: `Typed amount (£${Number.isFinite(entered) ? entered.toFixed(2) : enteredAmountGbp}) does not match the requested £${expected.toFixed(2)}. Try again.` };
  }
  /* Match — drop from pending and settle by re-entering requestPurchase() with
   * confirmed:true. This funnels typed-tier through the same allowlist + cap
   * + journal logic as every other path; no second code path to keep in sync. */
  _pending.delete(pendingId);
  return await requestPurchase({ ...entry.payload, confirmed: true });
}

/** Cancel a parked typed-tier request. HUD calls this when the operator
 *  hits the modal's cancel button. */
export function cancelPending(pendingId) {
  sweepPending();
  return _pending.delete(pendingId);
}
