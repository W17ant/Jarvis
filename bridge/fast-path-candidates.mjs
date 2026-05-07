// @ts-check
/** fast-path-candidates.mjs - Log queries that fell through to the LLM.
 *
 *  Self-improving infrastructure. Every askLLM / askLLMStream invocation
 *  starts with FastPath.tryFastPath(query); when that returns null, we
 *  pay ~1.5-2s through the LLM rather than ~500ms through fast-path.
 *  After Adam uses the kiosk for a week, the question "which queries
 *  should I migrate to fast-path next?" goes from gut-feel to data:
 *
 *    bridge logs every fall-through with query text + elapsed-ms +
 *    timestamp → /fast-path-candidates aggregates duplicates →
 *    Agent Console surfaces a 'frequent + slow' list.
 *
 *  Public surface:
 *    record({ query, elapsedMs, source, hit })  — log one query
 *    summarise()                                 — aggregated top patterns
 *
 *  We store JSONL on disk (data/fast-path-candidates.jsonl) so the data
 *  survives bridge restarts. Each line is ~100 bytes; even at 1k queries/
 *  day Adam'd accumulate ~36MB/year — fine.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const PROJECT_ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const LOG_PATH = path.join(PROJECT_ROOT, "data", "fast-path-candidates.jsonl");

/* In-memory tail of recent entries — surfaced to /fast-path-candidates so
 * the Agent Console doesn't have to read the whole file. Bounded so
 * memory stays flat through long uptimes. */
const RECENT = [];
const RECENT_MAX = 500;

/** Append one query record. Caller passes:
 *    query     — the operator's text
 *    elapsedMs — total handler time (LLM + tools, not just TTFT)
 *    source    — "askLLM" | "askLLMStream"
 *    hit       — boolean, true when fast-path claimed it (kept for
 *                ratio analysis)
 *
 *  Async + best-effort: errors are swallowed so a logging hiccup never
 *  breaks the chat path. */
/** @param {{ query: string, elapsedMs?: number, source?: string, hit?: boolean }} entry */
export async function record({ query, elapsedMs = 0, source = "unknown", hit = false }) {
  if (!query) return;
  const entry = {
    ts: Date.now(),
    iso: new Date().toISOString(),
    query: String(query).slice(0, 400),
    elapsedMs: Number(elapsedMs) || 0,
    source: String(source),
    hit: Boolean(hit),
  };
  RECENT.push(entry);
  while (RECENT.length > RECENT_MAX) RECENT.shift();
  try {
    await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fsp.appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    /* Disk-full, permission-denied, etc — never fatal. The in-memory tail
     * still works for the dashboard view. */
    console.warn(`[fast-path-candidates] append failed: ${e.message}`);
  }
}

/** Read the last N lines of the JSONL log (default 1000). Returns parsed
 *  entries, oldest-first. Best-effort — malformed lines are skipped. */
async function readRecent(n = 1000) {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const txt = await fsp.readFile(LOG_PATH, "utf8");
    const lines = txt.trim().split("\n").slice(-n);
    const out = [];
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch { return []; }
}

/** Aggregate fall-through queries by pattern. Returns a ranked list of
 *  candidates worth migrating to fast-path:
 *
 *    [{ pattern, count, avgElapsedMs, totalSavedMs (estimated),
 *       examples: [...3 representative queries] }]
 *
 *  Pattern bucketing uses a normalised version of the query — lowercase,
 *  numbers replaced with `<n>`, names/places with `<x>` — so "set a 5
 *  minute timer" and "set a 10 minute timer" share a bucket. The
 *  normalisation isn't perfect (no NLP), but it's good enough to spot
 *  high-frequency shapes the operator types repeatedly.
 *
 *  totalSavedMs is the optimistic projection of "if this pattern were
 *  fast-pathed, total wall-clock saved" — count × max(0, avg - 500ms),
 *  since fast-path adds ~500ms STT+TTS but no LLM hop.
 */
export async function summarise({ since = null, minCount = 2, limit = 25 } = {}) {
  const entries = await readRecent(5000);
  const sinceMs = since ? new Date(since).getTime() : 0;
  const fellThrough = entries.filter((e) => !e.hit && (!sinceMs || e.ts >= sinceMs));

  /* Bucket by normalised pattern. Aggregate count + cumulative ms. */
  const buckets = new Map();
  for (const e of fellThrough) {
    const pattern = normalisePattern(e.query);
    let b = buckets.get(pattern);
    if (!b) {
      b = { pattern, count: 0, totalMs: 0, examples: new Set(), latestTs: 0 };
      buckets.set(pattern, b);
    }
    b.count += 1;
    b.totalMs += e.elapsedMs;
    if (b.examples.size < 3) b.examples.add(e.query);
    if (e.ts > b.latestTs) b.latestTs = e.ts;
  }

  const ranked = [...buckets.values()]
    .filter((b) => b.count >= minCount)
    .map((b) => {
      const avg = Math.round(b.totalMs / b.count);
      /* fast-path saves the LLM time minus the TTS we still pay; rough
       * estimate uses 500ms as the fast-path floor cost. */
      const totalSavedMs = b.count * Math.max(0, avg - 500);
      return {
        pattern: b.pattern,
        count: b.count,
        avgElapsedMs: avg,
        totalSavedMs,
        examples: [...b.examples],
        latestTs: b.latestTs,
      };
    })
    .sort((a, b) => b.totalSavedMs - a.totalSavedMs)
    .slice(0, limit);

  /* Headline numbers for the dashboard banner. */
  const totalQueries = entries.length;
  const totalFellThrough = fellThrough.length;
  const hitRate = totalQueries > 0
    ? ((totalQueries - totalFellThrough) / totalQueries)
    : 0;

  return {
    totalQueries,
    totalFellThrough,
    fastPathHitRate: hitRate,
    candidates: ranked,
  };
}

/** Normalise a query into a pattern bucket. Heuristic — strip variability
 *  that the operator doesn't think about so similar shapes share a bucket.
 *  Doesn't try to be a parser; "set timer for <n> minutes" and "set timer
 *  for <n> hours" share a bucket which is fine for triage purposes. */
function normalisePattern(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    /* Numbers → <n>. Catches both digits and common spelled-out small ints. */
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g, "<n>")
    /* Common date / time fragments → tokens. */
    .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g, "<day>")
    .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/g, "<month>")
    /* Trailing punctuation / extra whitespace. */
    .replace(/[?.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
