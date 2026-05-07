/** fast-path.mjs - Skip-the-LLM handler for instant-answer queries.
 *
 *  The voice loop floor on local hardware is roughly:
 *    Whisper STT (~300ms) + LLM first-token (~500-2000ms) + Kokoro
 *    first-chunk (~300ms). The middle component dominates — a 14b model
 *    even on M5 Max takes ~1-2s before it starts emitting tokens.
 *
 *  For routing-shape queries the LLM is overkill. "What's the time"
 *  doesn't need 14 billion parameters. We pattern-match first, dispatch
 *  the answer or tool directly, and only fall through to the LLM when
 *  no fast-path handler claims the query. Result: ~500ms end-to-end on
 *  the most-common operator commands (no LLM cost, no tool router cost,
 *  no context-gathering cost).
 *
 *  Each handler returns either:
 *    { match: false }                  — pattern didn't fit, fall through
 *    { match: true, reply: "..." }     — speak this reply, no tool dispatch
 *    { match: true, reply: "...",
 *      toolCall: { name, args } }      — speak reply + dispatch tool
 *
 *  Order matters — first match wins. Specific patterns before general ones.
 */

const HANDLERS = [
  /* ---------- Time + date ---------- */
  {
    test: /^(?:(?:what(?:'s| is)?\s+(?:the\s+)?(?:current\s+)?time(?:\s+is\s+it)?)|(?:tell\s+me\s+(?:the\s+)?time)|(?:the\s+time))\.?\??$/i,
    handle: () => {
      const now = new Date();
      const hh = now.getHours();
      const mm = String(now.getMinutes()).padStart(2, "0");
      const period = hh >= 12 ? "PM" : "AM";
      const display = `${hh % 12 || 12}:${mm} ${period}`;
      return { match: true, reply: `It's ${display}.` };
    },
  },
  {
    test: /^(?:what(?:'s| is)|tell me)\s*(?:the\s*)?(?:today(?:'s)?|current)?\s*date\??$/i,
    handle: () => {
      const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      return { match: true, reply: `Today is ${today}.` };
    },
  },
  {
    test: /^what\s*day\s*(?:is\s*it|of\s*the\s*week)?\??$/i,
    handle: () => {
      const day = new Date().toLocaleDateString("en-GB", { weekday: "long" });
      return { match: true, reply: `It's ${day}.` };
    },
  },

  /* ---------- Timer (set / cancel) ----------
   *  Pattern catches "set a 20 minute timer for the chicken" — number,
   *  unit, optional "for <label>". Dispatches set_timer directly.
   *  Seconds are rounded up to whole minutes since set_timer's smallest
   *  meaningful unit is 1 minute and the LLM never differentiates. */
  {
    test: /^set\s+(?:a\s+|an\s+)?(\d+)\s*-?\s*(minute|min|hour|hr|second|sec)s?\s*(?:timer)?(?:\s+(?:for|on|to)\s+(.+?))?\.?$/i,
    handle: (q, m) => {
      const n = parseInt(m[1], 10);
      const unit = m[2].toLowerCase();
      let minutes = n;
      if (unit.startsWith("hour") || unit.startsWith("hr")) minutes = n * 60;
      else if (unit.startsWith("sec")) minutes = Math.max(1, Math.ceil(n / 60));
      const label = (m[3] || `${n} ${unit} timer`).trim();
      return {
        match: true,
        reply: `${minutes} minute timer set${m[3] ? ` for ${m[3]}` : ""}.`,
        toolCall: { name: "set_timer", args: { minutes, label } },
      };
    },
  },

  /* ---------- Sleep / shutdown ----------
   *  These have to bypass the LLM because the operator's tone is usually
   *  short and abrupt — perfect to mishear. Pattern-match locks them in. */
  {
    test: /^(?:shut\s*down|go\s*to\s*sleep|sleep\s*now|stop\s*listening|that(?:'s|\s+is)\s+(?:all|enough)|goodnight|good\s*night)\.?$/i,
    handle: () => ({
      match: true,
      reply: "Night.",
      toolCall: { name: "enter_sleep_mode", args: {} },
    }),
  },

  /* ---------- Open URL — Google Maps + simple "open X" -----------
   *  We handle two shapes:
   *    "(open|pull up) (a |the )?map of <place>"  → google maps URL
   *    "open <site>"                                → open the matching site
   *  Anything else falls through to the LLM (which has open_url available). */
  {
    test: /^(?:open|pull\s*up|show\s*(?:me)?)\s*(?:a\s+|the\s+)?map(?:\s+of)?\s+(.+?)\.?$/i,
    handle: (q, m) => {
      const place = m[1].trim();
      const url = `https://www.google.com/maps/search/${encodeURIComponent(place)}`;
      return {
        match: true,
        reply: `Pulling up a map of ${place}.`,
        toolCall: { name: "open_url", args: { url, reason: `Operator asked for a map of ${place}` } },
      };
    },
  },

  /* ---------- Greetings + acknowledgements ----------
   *  Bare greetings or single-word acknowledgements have no information
   *  content; the LLM would generate a bland reply. We just respond
   *  warmly and stop. */
  {
    test: /^(?:hello|hi|hey|good\s*morning|good\s*afternoon|good\s*evening|morning|evening)\.?$/i,
    handle: () => {
      const hour = new Date().getHours();
      const tod = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
      return { match: true, reply: `Good ${tod}, sir. What's first?` };
    },
  },
  {
    test: /^(?:thanks|thank\s*you|cheers|nice\s+one|good\s+(?:job|stuff))\.?$/i,
    handle: () => ({ match: true, reply: "Anytime." }),
  },

  /* ---------- Yes / no flow (for follow-ups) — kept lightweight ----------
   *  When the operator's reply is just "yes" or "no", the LLM rarely adds
   *  value beyond what context already determines. The voice loop handles
   *  most yes/no via the existing isAffirmative / inboxFollowUp paths;
   *  if a bare "yes" reaches us here without context, treat it as a no-op
   *  ack rather than a 2-second LLM dead-end. */
  {
    test: /^(?:yes|yeah|yep|yup|ok|okay|sure|alright|right(?:\s+then)?|fine)\.?$/i,
    handle: () => ({ match: true, reply: "Right." }),
  },
  {
    test: /^(?:no|nope|nah|never\s*mind|forget\s*it)\.?$/i,
    handle: () => ({ match: true, reply: "Understood." }),
  },
];

/**
 * Match a query against the fast-path handlers. Returns null when no
 * handler claims it (caller falls through to the LLM); otherwise
 * { reply, toolCall? }.
 *
 * @param {string} query  the operator's transcribed utterance
 */
export function tryFastPath(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  /* Strip a trailing period the LLM punctuator added — patterns use \.?$
   * but be defensive about leading filler too ("um, what's the time"). */
  const clean = q.replace(/^(?:uh|um|er|hey)[\s,]+/i, "").trim();
  for (const h of HANDLERS) {
    const m = clean.match(h.test);
    if (m) {
      try {
        const result = h.handle(clean, m);
        if (result?.match) return result;
      } catch (e) {
        console.warn(`[fast-path] handler crashed on "${clean}": ${e.message}`);
      }
    }
  }
  return null;
}

/** Diagnostic — useful for /health to surface how many handlers are active. */
export function listHandlers() {
  return HANDLERS.map((h) => ({ pattern: h.test.source, flags: h.test.flags }));
}
