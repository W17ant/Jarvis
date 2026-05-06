/** eod-digest.mjs - End-of-day activity digest.
 *
 *  One module that pulls every operator-relevant signal from the day and
 *  composes a single readable summary: calendar events attended, purchases
 *  made, browser sessions run, conversation count, LLM spend, files dropped
 *  into the inbox, and any video edits / PDFs / brand-packs rendered.
 *
 *  Two surfaces:
 *    - request_eod_digest tool: LLM dispatches it when the operator says
 *      "what did I do today" / "summarise my day". Returns a structured
 *      JSON the model can speak from.
 *    - Optional 18:00 cron via the existing notifications scheduler so the
 *      operator gets a digest pushed even without asking.
 *
 *  No cloud cost — every number comes from local SQLite, JSONL files, or
 *  in-memory broadcast counts. Vision-LLM is only used if the operator
 *  explicitly asks for an English narrative wrap (a separate
 *  "summarise the digest" step the LLM can chain).
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Memory from "./memory.mjs";
import * as UsageLog from "./usage-log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");

/** Read all rows from a JSONL file in [sinceTs, now]. Tolerant of missing
 *  files / parse errors — returns [] rather than throwing. */
async function readJsonlSince(filePath, sinceTs) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .filter((e) => typeof e.ts === "number" && e.ts >= sinceTs);
  } catch {
    return [];
  }
}

/** Pull purchase journal entries since the cutoff. Settled and rejected. */
async function purchasesSince(sinceTs) {
  const rows = await readJsonlSince(path.join(PROJECT_DIR, "data", "purchase-log.jsonl"), sinceTs);
  return {
    total: rows.length,
    settled: rows.filter((r) => r.status === "settled"),
    rejected: rows.filter((r) => r.status === "rejected" || r.status === "blocked"),
  };
}

/** Conversation turns since the cutoff — pulled directly from the persistence
 *  table so we can break down user vs assistant counts and which tools fired. */
function conversationsSince(sinceTs) {
  const turns = Memory.recentTurns({ limit: 500 }).filter((t) => t.ts >= sinceTs);
  const userTurns = turns.filter((t) => t.role === "user");
  const assistantTurns = turns.filter((t) => t.role === "assistant");
  /* Tool fan-out — a single Counter of which tools fired most across the day. */
  const toolCounts = {};
  for (const t of assistantTurns) {
    for (const name of t.tools || []) toolCounts[name] = (toolCounts[name] || 0) + 1;
  }
  const topTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));
  return {
    userTurns: userTurns.length,
    assistantTurns: assistantTurns.length,
    sessions: new Set(turns.map((t) => t.sessionId)).size,
    topTools,
    sampleQueries: userTurns.slice(0, 5).map((t) => t.content).reverse(),
  };
}

/** Inbox drop log — files dropped into ./inbox/ during the day. The watcher
 *  doesn't currently log JSONL but it does broadcast events; for the digest
 *  we just count files that exist in the dir AND were modified today. Cheap
 *  approximation that's accurate enough for a daily summary. */
async function inboxFilesToday(sinceTs) {
  const inboxDir = path.join(PROJECT_DIR, "inbox");
  try {
    const ents = await fsp.readdir(inboxDir, { withFileTypes: true });
    const stats = await Promise.all(
      ents.filter((e) => e.isFile()).map(async (e) => {
        try {
          const st = await fsp.stat(path.join(inboxDir, e.name));
          return { name: e.name, mtimeMs: st.mtimeMs };
        } catch { return null; }
      })
    );
    return stats
      .filter((s) => s && s.mtimeMs >= sinceTs)
      .map((s) => s.name);
  } catch {
    return [];
  }
}

/** Output renders: each shoot folder writes into output/<subfolder>/. We
 *  count files modified today across the buckets the operator cares about
 *  (videos, brand-packs, PDFs, watermarked assets). Used as a "you shipped
 *  X teasers + Y PDFs today" line in the digest. */
async function rendersToday(sinceTs) {
  const buckets = ["youtube/shorts", "instagram/reels", "tiktok", "brand-packs", "pdf", "watermarked"];
  const out = {};
  for (const b of buckets) {
    const dir = path.join(PROJECT_DIR, "output", b);
    try {
      const ents = await fsp.readdir(dir, { withFileTypes: true });
      const stats = await Promise.all(
        ents.filter((e) => e.isFile()).map(async (e) => {
          try { return (await fsp.stat(path.join(dir, e.name))).mtimeMs >= sinceTs; }
          catch { return false; }
        })
      );
      const count = stats.filter(Boolean).length;
      if (count) out[b] = count;
    } catch { /* dir doesn't exist yet — operator hasn't used that bucket */ }
  }
  return out;
}

/**
 * Build a structured digest covering [sinceTs, now]. Default = midnight today.
 *
 * @param {object} [opts]
 * @param {number} [opts.sinceTs]  Cutoff timestamp ms. Default = midnight today.
 */
export async function buildDigest({ sinceTs } = {}) {
  const ts = Date.now();
  const since = Number(sinceTs) || (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();

  /* All four data pulls run in parallel — small queries, no I/O bottleneck. */
  const [purchases, conversations, inboxFiles, renders, usage] = await Promise.all([
    purchasesSince(since),
    Promise.resolve(conversationsSince(since)),
    inboxFilesToday(since),
    rendersToday(since),
    UsageLog.getUsageSummary({ recentLimit: 1 }),
  ]);

  return {
    ok: true,
    generatedAt: new Date(ts).toISOString(),
    coversFromIso: new Date(since).toISOString(),
    headlines: {
      conversations: conversations.assistantTurns,
      sessions: conversations.sessions,
      purchases: purchases.settled.length,
      purchasesRejected: purchases.rejected.length,
      filesDropped: inboxFiles.length,
      rendersByBucket: renders,
      llmCallsToday: usage.today.calls,
      llmCostUSDToday: usage.today.costUSD,
    },
    conversations,
    purchases: {
      settled: purchases.settled.map((p) => ({
        merchant: p.merchantLabel || p.merchant,
        item: p.item,
        amountGbp: p.amountGbp,
        category: p.category,
        simulated: !!p.simulated,
      })),
      rejected: purchases.rejected.map((p) => ({
        merchant: p.merchant,
        item: p.item,
        reason: p.reason,
      })),
    },
    inboxFiles,
    renders,
    usage: {
      todayCalls: usage.today.calls,
      todayCostUSD: usage.today.costUSD,
      byModel: usage.today.byModel,
    },
  };
}

/**
 * Compose a plain-text digest the LLM can read aloud verbatim. Skips empty
 * sections so a quiet day produces a short summary rather than a lot of
 * "0 of nothing" noise.
 */
export function digestToText(d) {
  const lines = [];
  const h = d.headlines || {};
  const dateLabel = new Date(d.generatedAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  lines.push(`Daily digest for ${dateLabel}.`);

  if (h.conversations) {
    lines.push(`${h.conversations} replies across ${h.sessions} session${h.sessions === 1 ? "" : "s"}.`);
  } else {
    lines.push(`No conversations yet today.`);
  }

  /* Purchases — settled and rejected. Only mention rejection counts when
   * there were any; nobody wants "0 rejected" in a quiet summary. */
  if (h.purchases) {
    const total = d.purchases.settled.reduce((s, p) => s + (Number(p.amountGbp) || 0), 0);
    const sim = d.purchases.settled.filter((p) => p.simulated).length;
    lines.push(`${h.purchases} purchase${h.purchases === 1 ? "" : "s"} totalling £${total.toFixed(2)}${sim ? ` (${sim} in simulator mode)` : ""}.`);
  }
  if (h.purchasesRejected) {
    lines.push(`${h.purchasesRejected} purchase attempt${h.purchasesRejected === 1 ? "" : "s"} blocked by the rails.`);
  }

  /* Renders — concrete operator output: "shipped 3 YouTube shorts and 2 PDFs". */
  const renderBuckets = Object.entries(d.renders || {});
  if (renderBuckets.length) {
    const parts = renderBuckets.map(([b, n]) => `${n} ${b.replace(/\//g, " ")}`);
    lines.push(`Rendered: ${parts.join(", ")}.`);
  }

  if (h.filesDropped) {
    lines.push(`${h.filesDropped} file${h.filesDropped === 1 ? "" : "s"} dropped into the inbox.`);
  }

  /* Top tools fired — gives a sense of what the day was about. Cap at 3
   * for the spoken version; the JSON has the full top-10. */
  if (d.conversations?.topTools?.length) {
    const top = d.conversations.topTools.slice(0, 3).map((t) => `${t.name} (${t.count}×)`).join(", ");
    lines.push(`Most-used tools: ${top}.`);
  }

  /* LLM cost — only mention if non-zero. Local-only days stay quiet. */
  if (h.llmCostUSDToday > 0) {
    lines.push(`LLM spend today: $${h.llmCostUSDToday.toFixed(4)} estimated across ${h.llmCallsToday} calls.`);
  }

  return lines.join("\n");
}
