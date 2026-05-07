/** crew-helpers.mjs - High-level wrappers around runCrew for common workflows.
 *
 *  The crew orchestrator (bridge/crew.mjs) is the general primitive; the
 *  14b model isn't great at composing a 4-agent parallel crew spec from
 *  scratch. Helpers in this module take simple flat args and build the
 *  crew spec under the hood, so the LLM can dispatch them with one tool
 *  call.
 *
 *  Two patterns repeat across these helpers:
 *  1. Validate cloud-provider availability if the helper relies on parallel
 *     mode. Return a clean error envelope on no-key rather than letting the
 *     orchestrator's own all-ollama refusal fire (the helper-level error
 *     is more actionable for the operator).
 *  2. Build the crew spec, run it, and post-process the results into a
 *     shape the LLM can speak from directly (single string answer rather
 *     than the raw per-agent output array).
 */

import { runCrew } from "./crew.mjs";
import { pickProvider } from "./llm/providers.mjs";

/**
 * Compare a product across multiple merchants in parallel.
 *
 * Builds a crew with N parallel research agents (one per merchant) +
 * 1 sequential synthesis agent that merges the findings into a comparison
 * shortlist. Each research agent has request_browse access; the synthesis
 * agent is chat-only and works from the upstream context.
 *
 * Falls back to sequential mode automatically when no cloud vision provider
 * is set (parallel browse with all-ollama agents is forbidden by the
 * orchestrator anyway). Surfaces a clear error if even sequential won't
 * work because request_browse needs cloud vision regardless of mode.
 *
 * @param {object} args
 * @param {string} args.item        Plain-English product description ("50mm f1.4 prime")
 * @param {string[]} args.merchants Domain or label strings, e.g. ["wexphotovideo.com", "mpb.com", "parkcameras.com"]
 * @param {number} [args.maxPriceGbp] Optional ceiling for filtering candidates
 */
export async function compareProducts({ item, merchants, maxPriceGbp } = {}) {
  if (!item || typeof item !== "string") {
    return { ok: false, error: "item is required (e.g. '50mm f1.4 prime')" };
  }
  if (!Array.isArray(merchants) || merchants.length < 2) {
    return { ok: false, error: "merchants must be an array of 2+ domain or label strings" };
  }
  /* request_browse needs a cloud vision provider regardless of crew mode.
   * Surface that early rather than failing per-agent inside the crew. */
  const visionProvider = pickProvider("vision");
  if (visionProvider === "ollama") {
    return {
      ok: false,
      error: "compare_products requires a cloud vision provider (anthropic / openai) because each research agent uses request_browse. Configure ANTHROPIC_API_KEY in the Agent Console (Shift+Cmd+J).",
    };
  }
  /* Cap the merchant count — wide parallel fan-out increases token cost and
   * hits API rate limits. 4 merchants is the sweet spot in practice. */
  const cap = 4;
  if (merchants.length > cap) merchants = merchants.slice(0, cap);

  /* Build research agents — one per merchant, all in parallel. Each gets
   * request_browse + a tight goal that asks for a structured shortlist. */
  const researchAgents = merchants.map((m, i) => ({
    id: `research_${i}`,
    role: `${m} researcher`,
    goal: `Search ${m} for the best matches for the operator's item and report a 3-5 candidate shortlist with prices`,
    provider: visionProvider,
    allowedTools: ["request_browse"],
    maxSteps: 3,
  }));
  /* Synthesis agent — chat-only, runs sequentially after all research
   * completes. Aggregates the upstream findings into a comparison table
   * the operator can read at a glance. */
  const synthAgent = {
    id: "synth",
    role: "comparison synthesiser",
    goal: "Read the per-merchant research findings and produce a single comparison table the operator can pick from",
    provider: visionProvider,
    maxSteps: 1,
  };

  const priceLine = Number.isFinite(Number(maxPriceGbp)) ? ` Cap candidates at £${Number(maxPriceGbp).toFixed(2)}.` : "";
  const researchTasks = merchants.map((m, i) => ({
    id: `research_${i}`,
    description: `Use request_browse to find 3-5 candidate "${item}" products on ${m}.${priceLine} For each candidate, report: model name, price, key spec, link. Output as a markdown list.`,
    agentId: `research_${i}`,
    expectedOutput: "Markdown shortlist of 3-5 candidates with model / price / spec / link",
  }));
  const synthTask = {
    id: "synth",
    description: `Compare the upstream research findings across ${merchants.join(", ")} for "${item}". Produce a single comparison table or ranked list. Highlight the cheapest option, the best-spec option, and any standout deals. Keep it under 300 words — the operator will read this aloud or scan it.`,
    agentId: "synth",
    dependsOn: researchTasks.map((t) => t.id),
    expectedOutput: "One compact comparison table or ranked list",
  };

  const crewResult = await runCrew({
    mode: "parallel",
    maxParallel: cap,
    agents: [...researchAgents, synthAgent],
    tasks: [...researchTasks, synthTask],
  });

  /* Surface the synthesiser's output as the headline answer; per-merchant
   * detail is preserved in `byMerchant` for the operator to drill into. */
  const synthResult = crewResult.results?.find((r) => r.taskId === "synth");
  const byMerchant = {};
  for (const r of crewResult.results || []) {
    if (r.taskId === "synth") continue;
    const idx = parseInt(r.taskId.replace("research_", ""), 10);
    const merchant = merchants[idx] || r.taskId;
    byMerchant[merchant] = { ok: r.ok, output: r.output, error: r.error, elapsedMs: r.elapsedMs, costUSD: r.costUSD };
  }

  return {
    ok: crewResult.ok,
    crewId: crewResult.crewId,
    item,
    merchants,
    headline: synthResult?.output || "(synthesis step failed)",
    byMerchant,
    totalElapsedMs: crewResult.totalElapsedMs,
    totalCostUSD: crewResult.totalCostUSD,
  };
}
