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

/** Tool-calling hops always use main. The fast model is tuned for chat, not
 *  for tool-call accuracy on the 70+ Flat-Out tools. Keeping tool dispatches on
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
