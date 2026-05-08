// @ts-check
/** wake-parsing.js - Wake-word detection + utterance classification.
 *
 *  Pulled out of the voice.js monolith. All-pure logic — no DOM, no
 *  WebSocket, no audio. Gets brand state (wake variants + agent name)
 *  via setBrand() at load time; the parser functions read that state
 *  rather than re-deriving from scratch on every call.
 *
 *  Public surface:
 *    setBrand({ agentName, wakeVariants })   — call once after brand load
 *    containsWake(text)                       — does the heard text contain the wake phrase?
 *    extractQuery(text)                       — strip wake + filler from heard text
 *    quickExtractSubject(query)               — regex pull for "of/from the X" phrasings
 *    isAffirmative(text)                      — yes / yep / sure / etc
 *    isDismissal(text)                        — that's all / goodbye / stop listening
 *
 *  Why a setter rather than per-call params: every call site in voice.js
 *  passes the same module-global state (WAKE_VARIANTS / AGENT_NAME).
 *  Threading them through every call would add visual noise without
 *  benefit. The setBrand() pattern matches the rest of the codebase
 *  (Crew.setToolDispatch, IMessageListener.start, etc).
 */

let _wakeVariants = ["jarvis", "hey jarvis", "jervis", "jarviz"];
let _agentName = "Jarvis";

/** Update brand state. Called once after loadBrandIntoVoice() reads
 *  config/brand.json. Subsequent calls update in place — useful when
 *  the operator switches profiles mid-session.
 *
 *  @param {object} [opts]
 *  @param {string} [opts.agentName]
 *  @param {string[]} [opts.wakeVariants]
 */
export function setBrand({ agentName, wakeVariants } = {}) {
  if (typeof agentName === "string") _agentName = agentName;
  if (Array.isArray(wakeVariants) && wakeVariants.length) {
    _wakeVariants = wakeVariants.map((s) => String(s).toLowerCase());
  }
}

/** Diagnostic — surfaces what brand state is loaded. Used by tests + the
 *  Agent Console's wake-word debug pane. */
export function brandState() {
  return { agentName: _agentName, wakeVariants: _wakeVariants.slice() };
}

/* Why: fuzzy patterns tuned for common Whisper mishearings of "Jarvis".
 * Only used when the active brand IS Jarvis — for other agent names
 * the brand.wakeMishears list is the authoritative match set. Adding new
 * fuzzy regexes per client is a setup-wizard step, not something we
 * infer here. */
const JARVIS_FUZZY_PATTERNS = [
  /\b(hey|ay|hi|yo|ok)[,!.\s]+(jarvis|jervis|jarviz|jarves|jervice|charlie\s*us)\b/i,
  /\bjar[\s-]*vis\b/i,
  /\bjarvis\b/i,
  /\bjervis\b/i,
];

/** Strip wake word + leading filler from heard text → real query. */
export function extractQuery(text) {
  let q = String(text || "").toLowerCase();
  for (const v of _wakeVariants) q = q.replaceAll(v, " ");
  q = q.replace(/\s+/g, " ").trim();
  /* Why the trailing alternation: when input is "hey jarvis" alone, after
   * stripping the wake variant we have just "hey" — no whitespace tail. The
   * original regex required \s+ after, so "hey" survived as a dangling
   * pseudo-query. Now matches \s+ OR end-of-string so bare wake phrases
   * extract to "" cleanly. */
  q = q.replace(/^(hey|hi|ok|please|can you|could you|would you)(\s+|$)/i, "");
  return q;
}

/** Does the heard text contain the wake phrase? Two passes: exact
 *  variant match + (Jarvis only) fuzzy regex match for Whisper
 *  mishearings. Returns boolean. */
export function containsWake(text) {
  const t = String(text || "").toLowerCase();
  if (_wakeVariants.some((v) => t.includes(v))) return true;
  if (_agentName.toLowerCase() === "jarvis") {
    return JARVIS_FUZZY_PATTERNS.some((re) => re.test(t));
  }
  return false;
}

/** Quick regex pull for "of/from the X" phrasings before falling back
 *  to the LLM for subject extraction. Returns the subject string or null. */
export function quickExtractSubject(query) {
  const patterns = [
    /(?:of|from|for)\s+(?:yesterday'?s?|the|a|an)\s+(.+?)\s+(?:shoot|film|footage|reel)/i,
    /(?:of|from|for|featuring)\s+(?:the|a|an)?\s*(.+?)\s+(?:for|on)\s+(?:instagram|insta|social|stories|reels|youtube|tiktok)/i,
    /(?:of|from|for|featuring)\s+(?:the|a|an)?\s*(.+?)$/i,
  ];
  for (const re of patterns) {
    const m = String(query || "").match(re);
    if (m && m[1]) {
      const subject = m[1].trim().replace(/[?!.,;:]+$/, "");
      if (subject.length >= 3 && subject.length <= 80) return subject;
    }
  }
  return null;
}

/** Affirmative reply ("yes", "yeah", "go ahead", "sure", etc) — used by
 *  inbox follow-up + voice-confirmation gates. Pure: no brand state. */
export function isAffirmative(text) {
  const t = String(text || "").toLowerCase().trim();
  return /^(yes|yeah|yep|sure|go ahead|please|do it|ok(ay)?|sounds good|let's see|let me see|have a look|look)/.test(t);
}

/* Dismissal phrases — operator wants out of conversation mode. */
const DISMISS_PATTERNS = [
  /\b(ok|okay|alright)?\s*[,.]?\s*(that(?:'s|s|\s+is)?|thats|thanks)\s+(is\s+)?all\b/i,
  /\b(that(?:'s|s)?|thats)\s+(it|enough|fine)\b/i,
  /\b(thanks?|thank you|cheers)[,.\s]*(that(?:'s|s)?|thats)?\s*(all|enough|it|fine)\b/i,
  /\bno more questions\b/i,
  /\bgoodbye\b/i,
  /\bbye\s*(jarvis)?\b/i,
  /\b(stop|quit|exit)\s+listening\b/i,
];

export function isDismissal(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return DISMISS_PATTERNS.some((re) => re.test(t));
}
