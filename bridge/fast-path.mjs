// @ts-check
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
  /* ---------- Time + date ----------
   *  Apostrophe optional (Whisper drops it on fast speech: "whats the time").
   *  Tolerates a few common trailing fillers (right now / now / currently /
   *  please) before the end-of-string anchor — Adam often says "what time
   *  is it right now" which used to fall through. Trailing fillers list is
   *  whitelisted on purpose: anything else ("what time is it tomorrow")
   *  reaches the LLM where context-aware reasoning belongs. */
  {
    test: /^(?:(?:what(?:'s|s| is)?\s+(?:the\s+)?(?:current\s+)?time(?:\s+is\s+it)?)|(?:tell\s+me\s+(?:the\s+)?time)|(?:the\s+time))(?:\s+(?:right\s+now|now|currently|please))?\.?\??$/i,
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
   *  Three accepted shapes:
   *    "set a 20 minute timer for the chicken"   — NUMBER then UNIT (original)
   *    "set timer for 10 minutes"                — TIMER then NUMBER
   *    "set a timer for 5 minutes for the rice"  — TIMER + NUMBER + label
   *  Dispatches set_timer directly. Seconds are rounded up to whole minutes
   *  since set_timer's smallest meaningful unit is 1 minute and the LLM
   *  never differentiates. */
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
  /* "set [a] timer for N units [for label]" — second timer shape with the
   * "timer" word BEFORE the number. Same dispatch contract as above. */
  {
    test: /^set\s+(?:a\s+|an\s+)?timer\s+(?:for\s+)?(\d+)\s*-?\s*(minute|min|hour|hr|second|sec)s?(?:\s+(?:for|on|to)\s+(.+?))?\.?$/i,
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
   *  short and abrupt — perfect to mishear. Pattern-match locks them in.
   *  Apostrophe optional in "that's" (Whisper drops it on fast speech).
   *  Adds "sleep mode" + "go quiet" + "shush" alternates Adam's been using. */
  {
    test: /^(?:shut\s*down|go\s*to\s*sleep|sleep\s*(?:now|mode)|go\s*quiet|shush|stop\s*listening|that(?:'s|s|\s+is)\s+(?:all|enough)|goodnight|good\s*night)\.?$/i,
    handle: () => ({
      match: true,
      reply: "Night.",
      toolCall: { name: "enter_sleep_mode", args: {} },
    }),
  },

  /* ---------- "What can you do?" — capability tour ----------
   *  Adam (and visitors / clients) keep asking this in the kiosk's first
   *  five minutes. Currently it goes through the LLM, which paraphrases
   *  inconsistently and sometimes drifts into the refusal-shaped phrasing
   *  we hit earlier ("I'm only here for automotive Jarvis tasks"). A
   *  canned, friendly tour that points at the cheat-sheet hotkey for the
   *  full list is faster (~500ms) and on-brand.
   *
   *  Match the bare meta-question only — "what can you do for the
   *  Bentley shoot" needs the LLM. We require the question to BE the
   *  whole utterance (or end with the meta-shape) so contextual variants
   *  fall through. */
  {
    test: /^(?:(?:so\s+)?what\s+can\s+you\s+(?:do|help\s+with)|what\s+(?:do|are)\s+(?:you|your)\s+(?:able\s+to\s+do|capabilities|skills)|what\s+tools\s+(?:do\s+you\s+have|are\s+available)|what\s+are\s+you\s+(?:capable\s+of|good\s+at)|tell\s+me\s+what\s+you\s+can\s+do|show\s+me\s+(?:what\s+you\s+can\s+do|your\s+(?:tools|capabilities|skills))|list\s+your\s+(?:tools|capabilities|skills))[?.!]*$/i,
    handle: () => ({
      match: true,
      reply: "Quite a lot, sir. I help with shoot work — culling, captioning, editing, and rendering. Plus calendar, mail, contacts, web research, and a hundred other tools across Mac apps. Press command and question-mark for the full cheat sheet, or just ask me to do the thing.",
    }),
  },

  /* ---------- Open URL — Google Maps -----------
   *  Accepts a wide variety of operator phrasings + tolerates trailing
   *  context ("to scout a shoot", "for tomorrow's location"). The original
   *  regex only matched start-of-string "open|pull up|show me" — Adam
   *  hit a refusal loop saying "bring up a map of X to scout a shoot"
   *  because "bring" wasn't covered AND the trailing clause broke the
   *  end-anchor. Liberalised: any of the common verbs anywhere in the
   *  string, captures the place phrase up to a natural-language stopword
   *  ("to", "for", "so", "and", "please", trailing punctuation, EOS).
   *
   *  Examples that now match:
   *    "bring up a map of Goodwood"
   *    "pull a map of Silverstone for tomorrow's shoot"
   *    "show me a map of Manchester to scout locations"
   *    "find a map of the Goodwood paddock please"
   *    "map of the Bentley factory" */
  {
    test: /\b(?:(?:open|pull|show|bring|find|get|give)(?:\s+me)?(?:\s+up)?\s+(?:a\s+|the\s+)?)?map\s+(?:of\s+|for\s+)?(.+?)(?:\s+(?:to|for|so|and|please|because)\b|[?.!,;]|$)/i,
    handle: (q, m) => {
      const place = m[1].trim().replace(/[?.!,;:]+$/, "");
      /* Guard against false positives:
       *   - pronouns/prepositions captured by the loose regex ("map me to X")
       *   - too-short places (under 3 chars) — likely junk
       *   - phrases that start with "studio …" / "with …" / "and …"
       *     suggesting we matched mid-sentence noise rather than a real
       *     place phrase. Falls through to LLM, which can decide. */
      const lower = place.toLowerCase();
      if (place.length < 3) return { match: false };
      if (/^(?:me|you|us|him|her|them|it|that|this)\b/.test(lower)) return { match: false };
      if (/^(?:studio|with|and|or|but)\b/.test(lower)) return { match: false };
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
