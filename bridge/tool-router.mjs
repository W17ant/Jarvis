/** tool-router.mjs - Embedding-based tool catalogue filter.
 *
 *  At 97 tools the full TOOLS array is too much context for qwen2.5:14b's
 *  tool-selector to navigate accurately — wrong-tool dispatches climb sharply
 *  past ~30 tools. We pre-filter per query using nomic-embed-text cosine
 *  similarity: each tool gets an embedding of "name + description" at boot,
 *  and at query time we embed the operator's utterance, score against the
 *  catalogue, and pass only the top-K + an always-on core to the LLM.
 *
 *  Index lifecycle:
 *    - Boot: hash(TOOLS_JSON). If data/tool-index.json's hash matches,
 *      reuse it. Otherwise embed every tool (8-way concurrent, ~3s on a
 *      warm Ollama). Persist to disk so subsequent boots are instant.
 *    - Runtime: pickRelevant(query) — embed once, score the cached vectors,
 *      return the top-K names + always-on set. Operator's most recent message
 *      is the embedding source; we don't blend the whole conversation
 *      (would dilute the signal for routing-style queries).
 *
 *  Always-on core: tools that should be reachable from any context, not just
 *  ones whose description happens to embed near the query. `recall` is the
 *  obvious case — "what did I tell you about Ben yesterday" doesn't need to
 *  semantically match a tool description; it needs `recall` to ALWAYS exist.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const INDEX_PATH = path.join(PROJECT_DIR, "data", "tool-index.json");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

/** Tools that bypass the similarity filter and are always passed to the LLM.
 *  Picked because they're either:
 *   - Universal context primitives (recall, web_search, runtime_constraints)
 *   - Operator-control tools that must work from any state (enter_sleep_mode)
 *   - Tools the LLM commonly chains AFTER another tool's result (save_fact) */
const ALWAYS_ON = new Set([
  "recall",
  "recent_conversations",
  "web_search",
  "runtime_constraints",
  "open_url",
  "enter_sleep_mode",
  "list_projects",
  "save_fact",
  "save_conversation",
  "list_shoots",
  "show_news_panel",
  "hide_news_panel",
  "show_influencer_wizard",
  "start_influencer_pipeline",
  "show_asset_panel",
  "show_weather_panel",
]);

/* In-memory cached index. Built once at boot, queried thereafter. */
/** @type {{ hash: string, vectors: Record<string, number[]> } | null} */
let _index = null;

/** Hash the full TOOLS array so we can detect when a code change altered the
 *  catalogue and the cached vectors are now stale. We hash name + description
 *  + parameter shape — same fields we embed — so cosmetic changes elsewhere
 *  in server.mjs don't bust the cache. */
function hashTools(tools) {
  const canonical = tools.map((t) => {
    const fn = t.function || t;
    return { name: fn.name, description: fn.description, parameters: fn.parameters };
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Build the embedding string for one tool. We include: tool name, full
 *  description, and the parameter NAMES (not the schema — that's noise).
 *  Names matter because operators often ask in tool-language ("draft an
 *  email to ben") and the verb maps to the tool name semantically. */
function toolEmbeddingText(tool) {
  const fn = tool.function || tool;
  const paramNames = fn.parameters?.properties ? Object.keys(fn.parameters.properties).join(", ") : "";
  return `${fn.name}: ${fn.description || ""} (params: ${paramNames})`;
}

/** Tiny LRU for recent query embeddings — saves a ~150-400ms Ollama roundtrip
 *  whenever the operator repeats themselves (common during testing / demos /
 *  conversation-mode follow-ups). Keyed by exact normalised string; cap small
 *  because most queries are unique. Sprint 11 perf pass. */
const _QUERY_EMBED_CACHE_MAX = 64;
const _queryEmbedCache = new Map();
function _cacheGet(key) {
  if (!_queryEmbedCache.has(key)) return null;
  /* Refresh recency by re-inserting */
  const v = _queryEmbedCache.get(key);
  _queryEmbedCache.delete(key);
  _queryEmbedCache.set(key, v);
  return v;
}
function _cacheSet(key, value) {
  _queryEmbedCache.set(key, value);
  if (_queryEmbedCache.size > _QUERY_EMBED_CACHE_MAX) {
    const oldest = _queryEmbedCache.keys().next().value;
    _queryEmbedCache.delete(oldest);
  }
}

/** Embed a string via Ollama's nomic-embed-text endpoint. Returns a 768-dim
 *  Float32-equivalent number array. Throws on transport / model failure.
 *  Cached by normalised query to skip the roundtrip on repeats. */
async function embed(text) {
  const key = String(text || "").trim().toLowerCase();
  const cached = _cacheGet(key);
  if (cached) return cached;
  const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  if (!r.ok) throw new Error(`nomic-embed-text returned ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.embedding)) throw new Error("embedding response missing 'embedding' array");
  _cacheSet(key, j.embedding);
  return j.embedding;
}

/** Cosine similarity. Identical to memory.mjs's local impl, kept here so
 *  that module stays untouched. */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/** Embed all tools concurrently with a small fan-out so we don't hammer
 *  Ollama. 8-way is the sweet spot on a Mac — the model is single-instance
 *  but concurrent requests just queue server-side without much overhead. */
async function embedAll(tools, concurrency = 8) {
  const out = {};
  const queue = [...tools];
  async function worker() {
    while (queue.length) {
      const tool = queue.shift();
      const fn = tool.function || tool;
      try {
        const vec = await embed(toolEmbeddingText(tool));
        out[fn.name] = vec;
      } catch (e) {
        console.warn(`[tool-router] failed to embed ${fn.name}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

/**
 * Build (or load from cache) the tool index. Call once at bridge boot —
 * fire-and-forget; the first few queries before this resolves get the full
 * tool catalogue (fallback path in pickRelevant), which is correct, just
 * not yet optimised.
 *
 * @param {Array} tools  the TOOLS array from server.mjs
 */
export async function buildIndex(tools) {
  const want = hashTools(tools);
  /* Try the disk cache first. */
  try {
    const raw = await fsp.readFile(INDEX_PATH, "utf8");
    const cached = JSON.parse(raw);
    if (cached.hash === want && cached.vectors) {
      _index = cached;
      console.log(`[tool-router] index loaded from cache (${Object.keys(cached.vectors).length} tools)`);
      return;
    }
    console.log(`[tool-router] cache stale — TOOLS changed, rebuilding`);
  } catch {
    /* No cache / corrupt — fall through to fresh build. */
  }

  const t0 = Date.now();
  const vectors = await embedAll(tools);
  _index = { hash: want, vectors };
  console.log(`[tool-router] embedded ${Object.keys(vectors).length}/${tools.length} tools in ${Date.now() - t0}ms`);
  /* Persist for next boot. Best-effort; if it fails we keep the in-memory
   * copy so this run is still optimised. */
  try {
    await fsp.mkdir(path.dirname(INDEX_PATH), { recursive: true });
    await fsp.writeFile(INDEX_PATH, JSON.stringify(_index));
  } catch (e) {
    console.warn(`[tool-router] could not persist index: ${e.message}`);
  }
}

/**
 * Pick the K most-relevant tools for a query, plus the always-on core.
 * If the index isn't ready yet (boot still embedding), returns the full
 * tools array so the bridge degrades gracefully — slower but correct.
 *
 * @param {string} query   The operator's most recent utterance
 * @param {Array}  tools   The full TOOLS array (so we can return the same shape)
 * @param {object} [opts]
 * @param {number} [opts.topK=20]   How many semantically-similar tools to include
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ tools: Array, picked: string[], scores: object, elapsedMs: number }>}
 */
export async function pickRelevant(query, tools, { topK = 20, signal } = {}) {
  const t0 = Date.now();
  /* Index not ready → degrade to full catalogue. The LLM stays correct,
   * just pays the context tax. */
  if (!_index || !_index.vectors) {
    return { tools, picked: tools.map((t) => (t.function || t).name), scores: {}, elapsedMs: 0, fallback: "no_index" };
  }
  const q = String(query || "").trim();
  if (!q) {
    /* Empty query → just hand back the always-on set. Defensive — shouldn't
     * happen in practice, but better than embedding an empty string. */
    const filtered = tools.filter((t) => ALWAYS_ON.has((t.function || t).name));
    return { tools: filtered, picked: filtered.map((t) => (t.function || t).name), scores: {}, elapsedMs: Date.now() - t0, fallback: "empty_query" };
  }

  let qVec;
  try {
    qVec = await embed(q.slice(0, 1500));  // trim long queries to keep embed cheap
    if (signal?.aborted) throw new Error("aborted");
  } catch (e) {
    /* Embedding failed (Ollama down, etc) → fall back to full catalogue.
     * Don't break the chat path because the optimisation layer hiccupped. */
    console.warn(`[tool-router] query embed failed: ${e.message} — passing full TOOLS`);
    return { tools, picked: tools.map((t) => (t.function || t).name), scores: {}, elapsedMs: Date.now() - t0, fallback: "embed_failed" };
  }

  /* Score every tool. We could short-circuit on always-on tools but the
   * cosine math is so cheap (97 × 768 dot products) it's not worth the
   * extra branching. */
  const scored = [];
  for (const tool of tools) {
    const name = (tool.function || tool).name;
    const vec = _index.vectors[name];
    if (!vec) {
      /* Tool added since the last index build — include it so it's never
       * silently invisible. Will get a real embedding on the next rebuild. */
      scored.push({ tool, name, score: 1, source: "uncached" });
      continue;
    }
    scored.push({ tool, name, score: cosine(qVec, vec), source: "indexed" });
  }
  scored.sort((a, b) => b.score - a.score);

  /* Build the result: always-on first, then top-K by score, deduplicated. */
  const picked = new Set();
  const result = [];
  const scores = {};
  for (const tool of tools) {
    const name = (tool.function || tool).name;
    if (ALWAYS_ON.has(name)) { picked.add(name); result.push(tool); }
  }
  for (const s of scored) {
    if (picked.has(s.name)) { scores[s.name] = s.score; continue; }
    if (result.length >= ALWAYS_ON.size + topK) break;
    picked.add(s.name);
    result.push(s.tool);
    scores[s.name] = s.score;
  }
  /* Annotate always-on with their actual scores for telemetry, even though
   * they're included regardless. */
  for (const s of scored) {
    if (ALWAYS_ON.has(s.name)) scores[s.name] = s.score;
  }

  return { tools: result, picked: Array.from(picked), scores, elapsedMs: Date.now() - t0 };
}

/** Return diagnostic state — used by /health and the Agent Console. */
export function indexStatus() {
  return {
    ready: !!_index?.vectors,
    toolCount: _index?.vectors ? Object.keys(_index.vectors).length : 0,
    hash: _index?.hash?.slice(0, 12) || null,
    alwaysOn: Array.from(ALWAYS_ON),
  };
}
