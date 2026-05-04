/** usage.mjs - Cost / usage telemetry derived from the audit log.
 *
 *  Why: operators (and IT signing off the install) want a quick read on what the
 *  kiosk has been doing — how many queries, which tools dominate, how much wall-time
 *  per render, error rate. The audit log already records every tool dispatch with
 *  duration + result; this module aggregates a single day's worth into a compact
 *  payload the HUD's USAGE section consumes.
 *
 *  Pure read-only — no scheduled writes. Computed on demand when the operator opens
 *  the panel. The audit log is small (JSONL, append-only) so a full-day scan is sub-
 *  100ms even on a busy kiosk.
 *
 *  Out of scope for v1: per-call fal.ai pricing. The fal API doesn't return cost on
 *  the request, and pre-pricing every model would drift as fal updates rates. We
 *  surface the COUNT of fal-using calls so the operator can multiply by their known
 *  per-call rate; full integration with fal's billing endpoint is a future task. */

import * as Audit from "./audit.mjs";

/* The set of tools that hit fal.ai. Bumping new ones into this set lets the call
 * counter pick them up automatically without changing the consumer. */
const FAL_TOOLS = new Set(["fal_image_to_video", "fal_image_gen"]);

/* Tools that are pure-local and "free" — listing them here lets the UI separate
 * "free local work" from "potentially-billed external work". */
const LOCAL_TOOLS_PREFIX = ["caption_", "describe_", "find_", "list_", "get_", "remember", "recall", "add_"];

/**
 * Build the daily usage snapshot.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowHours=24]   how far back to aggregate
 * @returns {Promise<object>}              shape documented in the comments below
 */
export async function getUsage({ windowHours = 24 } = {}) {
  const fromTs = Date.now() - windowHours * 3_600_000;
  /* limit:2000 = enough headroom for a busy day (typical kiosks see 100-300 dispatches).
   * If we ever need more we'll page; the audit module already supports it. */
  const rows = await Audit.query({ fromTs, limit: 2000 });

  /* Aggregate. Keep it loop-once for performance — even with thousands of rows this
   * is microseconds of work. */
  const byTool = new Map();        // tool → { count, errors, totalMs, avgMs, lastTs }
  const byOperator = new Map();
  let total = 0, errors = 0, falCalls = 0, totalDurationMs = 0;
  let firstTs = Infinity, lastTs = 0;

  for (const row of rows) {
    total++;
    if (row.error) errors++;
    if (FAL_TOOLS.has(row.tool)) falCalls++;
    if (row.durationMs) totalDurationMs += row.durationMs;
    if (row.ts < firstTs) firstTs = row.ts;
    if (row.ts > lastTs) lastTs = row.ts;

    const t = byTool.get(row.tool) || { count: 0, errors: 0, totalMs: 0, lastTs: 0 };
    t.count++;
    if (row.error) t.errors++;
    if (row.durationMs) t.totalMs += row.durationMs;
    if (row.ts > t.lastTs) t.lastTs = row.ts;
    byTool.set(row.tool, t);

    const op = row.operator || "default";
    const o = byOperator.get(op) || { count: 0, errors: 0 };
    o.count++;
    if (row.error) o.errors++;
    byOperator.set(op, o);
  }

  /* Tool breakdown — top 10 by count, with avgMs and error rate. */
  const tools = [...byTool.entries()]
    .map(([name, m]) => ({
      name,
      count: m.count,
      errors: m.errors,
      avgMs: m.count > 0 ? Math.round(m.totalMs / m.count) : 0,
      lastTs: m.lastTs,
      isFal: FAL_TOOLS.has(name),
      isLocal: LOCAL_TOOLS_PREFIX.some((p) => name.startsWith(p)),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const operators = [...byOperator.entries()]
    .map(([name, m]) => ({ name, count: m.count, errors: m.errors }))
    .sort((a, b) => b.count - a.count);

  return {
    windowHours,
    fromTs,
    toTs: Date.now(),
    /* Headline numbers for the panel's top row. */
    total,
    errors,
    errorRate: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,  // pct, 1 dp
    falCalls,
    /* Average wall time per dispatch — useful "is the kiosk responsive?" metric. */
    avgDurationMs: total > 0 ? Math.round(totalDurationMs / total) : 0,
    /* Activity span — first/last timestamps in the window so the UI can show the
     * actual span ("activity from 09:14 to 18:47" reads better than "in the last 24h"). */
    firstActivityTs: firstTs === Infinity ? null : firstTs,
    lastActivityTs: lastTs || null,
    tools,
    operators,
  };
}
