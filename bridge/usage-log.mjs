/** usage-log.mjs - Append-only LLM usage / cost ledger.
 *
 *  Every chat call lands one row here: timestamp, provider, model, token
 *  counts in/out, an estimated USD cost based on a baked-in price table,
 *  elapsed ms, and a source tag (which code path made the call). The
 *  Agent Console reads from /usage and shows today's spend so the operator
 *  has live visibility into what their Anthropic / OpenAI key is costing —
 *  no end-of-month billing surprises.
 *
 *  Pricing is a snapshot (May 2026 list prices) and may drift; flag a
 *  badge in /usage so the operator knows it's an estimate, not authoritative.
 *  Local Ollama is logged at $0 since it's compute-only.
 *
 *  File rotation: ~10MB cap. When the active log crosses the threshold we
 *  rename it to data/usage-log-<date>.jsonl.archive and start a fresh one.
 *  All-time totals stay queryable by walking the archives if anyone asks.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const LOG_PATH = path.join(PROJECT_DIR, "data", "usage-log.jsonl");
const ROTATE_BYTES = 10 * 1024 * 1024;

/** Per-1M-token cost in USD. May 2026 list prices. Local providers = $0.
 *  Update when providers move (they do — usually downward). The Agent
 *  Console badges this as an estimate so the operator never assumes
 *  these numbers are billing-authoritative. */
const PRICE_TABLE = {
  /* Anthropic Sonnet 4.6 / Opus 4.7 — list prices May 2026. */
  "anthropic": {
    "claude-sonnet-4-6":     { input: 3.00, output: 15.00 },
    "claude-opus-4-7":       { input: 15.00, output: 75.00 },
    "claude-haiku-4-5":      { input: 0.80, output: 4.00 },
    "_default":              { input: 3.00, output: 15.00 },
  },
  /* OpenAI GPT-4o family. */
  "openai": {
    "gpt-4o":                { input: 2.50, output: 10.00 },
    "gpt-4o-mini":           { input: 0.15, output: 0.60 },
    "_default":              { input: 2.50, output: 10.00 },
  },
  /* Local Ollama — no per-token cost. Tracked for parity so the dashboard
   * shows token volume regardless of provider. */
  "ollama": {
    "_default":              { input: 0, output: 0 },
  },
};

/** Estimate USD cost for a single call. Returns 0 for unknown providers
 *  rather than NaN so totals never go funky. */
function estimateCostUSD(provider, model, tokensIn, tokensOut) {
  const table = PRICE_TABLE[String(provider || "").toLowerCase()];
  if (!table) return 0;
  const row = table[String(model || "").toLowerCase()] || table._default;
  if (!row) return 0;
  const inCost  = (Number(tokensIn) || 0) / 1_000_000 * row.input;
  const outCost = (Number(tokensOut) || 0) / 1_000_000 * row.output;
  return Number((inCost + outCost).toFixed(6));
}

/** Append one usage record. Tolerant of partial / weird inputs — anything
 *  missing becomes null/0 in the output rather than failing. Never throws;
 *  a logging hiccup must not break the chat path. */
export async function recordUsage({
  provider,
  model,
  tokensIn = 0,
  tokensOut = 0,
  cachedIn = 0,         // Anthropic: cache_read_input_tokens (re-used cached prefix)
  cachedWritten = 0,    // Anthropic: cache_creation_input_tokens (first-time prefix store)
  elapsedMs = 0,
  source = "unknown",
  error = null,
} = {}) {
  const ts = Date.now();
  const costUSD = estimateCostUSD(provider, model, tokensIn, tokensOut);
  const entry = {
    ts,
    iso: new Date(ts).toISOString(),
    provider: String(provider || "unknown"),
    model: String(model || "unknown"),
    tokensIn: Number(tokensIn) || 0,
    tokensOut: Number(tokensOut) || 0,
    /* cachedIn > 0 means Anthropic prompt-cache hit on this request.
     * Operator can spot it in the audit log to confirm caching is working. */
    cachedIn: Number(cachedIn) || 0,
    cachedWritten: Number(cachedWritten) || 0,
    costUSD,
    elapsedMs: Number(elapsedMs) || 0,
    source: String(source || "unknown"),
    error: error ? String(error).slice(0, 200) : null,
  };
  try {
    await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
    /* Rotate if oversized. Best-effort — failure rotates next time. */
    try {
      const stat = await fsp.stat(LOG_PATH);
      if (stat.size > ROTATE_BYTES) {
        const stamp = new Date().toISOString().slice(0, 10);
        await fsp.rename(LOG_PATH, `${LOG_PATH}-${stamp}.archive`).catch(() => {});
      }
    } catch { /* file doesn't exist yet */ }
    await fsp.appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    console.warn(`[usage-log] append failed: ${e.message}`);
  }
  return entry;
}

/** Read all entries from the active log. Archived files aren't included —
 *  the Agent Console only ever shows recent activity (today / this week). */
async function loadRecent() {
  try {
    const raw = await fsp.readFile(LOG_PATH, "utf8");
    return raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Aggregate stats for the Agent Console: today's totals, last-N rows,
 *  per-provider breakdown. Cheap because the active log caps at 10MB. */
export async function getUsageSummary({ recentLimit = 30 } = {}) {
  const entries = await loadRecent();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const today = entries.filter((e) => e.ts >= dayAgo);
  const week = entries.filter((e) => e.ts >= weekAgo);
  /* Per-provider rollup. We use entries[]; the same calc runs in microseconds
   * for tens of thousands of rows. */
  const rollup = (rows) => {
    const out = {};
    for (const e of rows) {
      const key = `${e.provider}:${e.model}`;
      if (!out[key]) out[key] = { provider: e.provider, model: e.model, calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 };
      out[key].calls += 1;
      out[key].tokensIn += e.tokensIn || 0;
      out[key].tokensOut += e.tokensOut || 0;
      out[key].costUSD += e.costUSD || 0;
    }
    return Object.values(out).sort((a, b) => b.costUSD - a.costUSD || b.calls - a.calls);
  };
  return {
    pricingNote: "Costs are estimates from a baked-in May 2026 price table; consult your provider's billing dashboard for the authoritative figure.",
    today: {
      calls: today.length,
      tokensIn: today.reduce((s, e) => s + (e.tokensIn || 0), 0),
      tokensOut: today.reduce((s, e) => s + (e.tokensOut || 0), 0),
      costUSD: Number(today.reduce((s, e) => s + (e.costUSD || 0), 0).toFixed(4)),
      byModel: rollup(today),
    },
    week: {
      calls: week.length,
      tokensIn: week.reduce((s, e) => s + (e.tokensIn || 0), 0),
      tokensOut: week.reduce((s, e) => s + (e.tokensOut || 0), 0),
      costUSD: Number(week.reduce((s, e) => s + (e.costUSD || 0), 0).toFixed(4)),
      byModel: rollup(week),
    },
    recent: entries.slice(-Math.max(1, Math.min(200, recentLimit))).reverse(),
  };
}
