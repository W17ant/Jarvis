/** model-router.mjs - Hardware-tier-aware text-model picker.
 *
 *  Why: most operator commands are routing decisions ("flag hero", "what's coming
 *  up", "show me the latest shoot") that don't need a 32b model — the 14b/7b
 *  family already nails them and replies in half the time. Long-form writes
 *  (press release drafting, shoot reports, structured PDFs) genuinely benefit
 *  from the bigger model.
 *
 *  The router runs only when both a fast model AND a main model are configured —
 *  on lower-tier hardware the wizard leaves OLLAMA_FAST_MODEL unset so the router
 *  is a no-op + every query goes through the single configured model. This keeps
 *  the dual-model RAM cost off machines that can't spare it.
 *
 *  Decision heuristic (in order):
 *    1. Tool-calling hops use the main model (32b > 14b for tool selection accuracy).
 *    2. Queries containing keywords like "draft", "press release", "report",
 *       "write me", "compose" go to main (quality matters).
 *    3. Long queries (>= 200 chars) go to main (the operator typed something
 *       structured; cheap routing isn't enough).
 *    4. Everything else uses fast.
 *
 *  Read OLLAMA_FAST_MODEL env at module load. If unset → router returns the main
 *  model for every query (safe no-op).
 *
 *  Exports:
 *    pick(query)                - choose a model for this user-facing query
 *    pickForToolHop(messages)   - always returns main (tool-calling)
 *    isFastEnabled()            - whether the hardware tier opts into routing
 *    config()                   - { main, fast, fastEnabled } for diagnostics
 */

const FAST_MODEL = (process.env.OLLAMA_FAST_MODEL || "").trim();
const MAIN_MODEL_FALLBACK = (process.env.OLLAMA_MODEL || "qwen2.5:14b").trim();

/* Triggers that bias toward the main model regardless of length. The list is
 * intentionally small — false positives mean a fast routing query lands on the
 * slower model, which is annoying but not broken. False negatives mean a draft
 * lands on the fast model, which gives lower-quality output the operator will
 * notice. Bias toward false-positives. */
const QUALITY_TRIGGERS = [
  /\bdraft\s+(an?\s+)?(email|message|press release|reply|response)/i,
  /\b(press release|shoot report|brief|quote)\b/i,
  /\b(write me|compose|formulate|generate)\s+(an?\s+)?(article|story|report|paragraph)/i,
  /\bsummari[sz]e\s+(this|the)\b/i,    // summarisation benefits from larger context window
  /\bcaption\b.{0,40}\b(thoroughly|in detail|properly)\b/i,
];

/** Whether tier-aware routing is active. False on lower-tier hardware where the
 *  wizard didn't set OLLAMA_FAST_MODEL. */
export function isFastEnabled() {
  return FAST_MODEL.length > 0 && FAST_MODEL !== MAIN_MODEL_FALLBACK;
}

/** Read the live main model — defers to the caller's getModel() if supplied so
 *  runtime model swaps via the settings modal pick the new value up. */
let getMainModelFn = () => MAIN_MODEL_FALLBACK;
export function setMainModelGetter(fn) {
  if (typeof fn === "function") getMainModelFn = fn;
}

/**
 * Choose a model for a user-facing query.
 *
 * @param {string} query   the operator's utterance / typed input
 * @returns {string}       the model name to call /api/chat with
 */
export function pick(query) {
  const main = getMainModelFn();
  if (!isFastEnabled()) return main;
  const q = String(query || "").trim();

  /* Quality triggers bypass the fast model — let the bigger one write. */
  for (const re of QUALITY_TRIGGERS) {
    if (re.test(q)) return main;
  }

  /* Long queries imply the operator typed/spoke something structured. */
  if (q.length >= 200) return main;

  return FAST_MODEL;
}

/* ------------------------------------------------------------------------- *
 * Stage 3: classifier hop (optional)
 *
 * pick() handles the cheap regex + length heuristics. For everything that
 * lands in the "ambiguous" middle, pickAsync() can additionally ask the fast
 * model itself "would you handle this confidently, or do I need to escalate?"
 * — a one-token classification that takes ~150-300ms and dramatically lowers
 * false-fast (where the 3b model botches a query it shouldn't have tried).
 *
 * Caller chooses whether to pay the latency: synchronous tool dispatch hops
 * stay on pick(); the conversational chat loop can opt into pickAsync() for
 * accuracy. Failures fall back to pick() — the classifier is best-effort. */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

const CLASSIFIER_PROMPT = `You will receive a user message. Reply with EXACTLY one word: SIMPLE or COMPLEX.
- SIMPLE: trivia, time, weather, status, hello, simple commands, single-fact lookups.
- COMPLEX: multi-step reasoning, drafting, summarisation, judgement calls, comparisons, anything benefiting from a larger model.
No prose, no punctuation, no formatting. One word only.`;

/** Async variant of pick() — runs the classifier hop on queries that the
 *  cheap heuristics couldn't decisively route. Returns { model, escalated,
 *  classifier? } so the HUD can show a "switching to 14b" badge when needed.
 *
 *  @param {string} query
 *  @param {object} [opts]
 *  @param {AbortSignal} [opts.signal]
 *  @param {number} [opts.timeoutMs=600] — cap classifier latency; on timeout, fall through to heuristics */
export async function pickAsync(query, { signal, timeoutMs = 600 } = {}) {
  /* Cheap heuristics first — same logic as pick(). If they decide, skip
   * the classifier hop entirely. */
  const heuristic = pick(query);
  const main = getMainModelFn();
  if (!isFastEnabled() || heuristic === main) {
    return { model: heuristic, escalated: heuristic === main, classifier: null };
  }
  /* Heuristic says fast — sanity-check with the classifier. If it says
   * COMPLEX, escalate. If the call fails or times out, trust heuristic. */
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: FAST_MODEL,
        messages: [
          { role: "system", content: CLASSIFIER_PROMPT },
          { role: "user", content: String(query || "").slice(0, 400) },
        ],
        stream: false,
        options: { num_predict: 4, temperature: 0 },
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "24h",
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    const verdict = String(j.message?.content || "").trim().toUpperCase();
    if (verdict.startsWith("COMPLEX")) return { model: main, escalated: true, classifier: verdict };
    return { model: FAST_MODEL, escalated: false, classifier: verdict || "SIMPLE" };
  } catch (e) {
    /* Classifier failed — heuristic stands. Don't degrade UX over a probe. */
    return { model: heuristic, escalated: false, classifier: null, classifierError: e.message };
  }
}

/** Tool-calling hops always use main. The fast model is tuned for chat, not
 *  for tool-call accuracy on the 70+ Jarvis tools. Keeping tool dispatches on
 *  the main model trades a few hundred ms for far fewer wrong-tool calls. */
export function pickForToolHop() {
  return getMainModelFn();
}

/** Diagnostic snapshot — useful for /healthz / settings modal. */
export function config() {
  return {
    main: getMainModelFn(),
    fast: FAST_MODEL || null,
    fastEnabled: isFastEnabled(),
  };
}
