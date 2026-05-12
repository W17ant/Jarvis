// @ts-check
import * as News from "./news.mjs";

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

  /* ---------- News panel ----------
   *  Local qwen2.5:7b reliably narrates "opening the news panel" without
   *  emitting the actual tool call, so the panel never mounts. Pattern-match
   *  the common news triggers and fire show_news_panel directly. The reply
   *  text speaks the top headline from the prewarmed cache so the operator
   *  hears it as the panel slides in — same UX as the LLM path. */
  {
    test: /^(?:show\s+me\s+the\s+news|open\s+the\s+news(?:\s+panel)?|the\s+news\s+please|what(?:'s|s| is)?\s+the\s+news|what(?:'s|s| is)?\s+(?:happening|going\s+on)(?:\s+in\s+the\s+world)?|top\s+(?:stories|headlines)|headlines|catch\s+me\s+up(?:\s+on\s+the\s+news)?|news\s+panel)\.?\??$/i,
    handle: () => {
      const cached = News.getCached?.();
      return {
        match: true,
        reply: buildNewsReply(cached),
        toolCall: { name: "show_news_panel", args: {} },
      };
    },
  },
  {
    test: /^(?:close|hide|dismiss|turn\s+off)\s+the\s+news(?:\s+panel)?\.?$/i,
    handle: () => ({ match: true, reply: "Closing the news.", toolCall: { name: "hide_news_panel", args: {} } }),
  },

  /* ---------- Asset panel (latest image / video) ----------
   *  Voice triggers for re-opening the most-recent generated asset. The
   *  panel ALSO opens automatically on teaser.image_ready / teaser.video_ready
   *  broadcasts (see asset-panel.js) — this fast-path is for the operator
   *  asking to see it again after closing. */
  {
    test: /^(?:show\s+(?:me\s+)?(?:the\s+)?(?:latest|last)\s+(?:image|video|asset|clip|hero)|pull\s*up\s+(?:the\s+)?(?:image|video|asset|clip|hero)|asset\s+panel)\.?$/i,
    handle: () => ({
      match: true,
      reply: "Opening the asset panel.",
      toolCall: { name: "show_asset_panel", args: {} },
    }),
  },

  /* ---------- Weather panel ----------
   *  "Show me the weather" intent gets the panel (visual + actionable); the
   *  text-only "what's the weather" still hits get_weather above (just speaks
   *  the temp). The "show me X" generic fallback at the bottom of the file
   *  would otherwise open Google search — this handler runs FIRST and wins. */
  {
    test: /^(?:show\s+(?:me\s+)?(?:the\s+)?(?:weather|forecast)(?:\s+(?:panel|today|outside))?|weather\s+panel|forecast\s+panel|open\s+(?:the\s+)?(?:weather|forecast))\.?$/i,
    handle: () => ({
      match: true,
      reply: "Opening the weather panel.",
      toolCall: { name: "show_weather_panel", args: {} },
    }),
  },

  /* ---------- Influencer wizard ----------
   *  Permissive triggers — operator's framing varies a lot for this command.
   *  Bypass the local LLM (which often narrates "let me create an influencer"
   *  without firing the tool) and open the wizard directly. */
  {
    test: /^(?:create|make|build|spin\s*up|generate)\s+(?:me\s+)?(?:an?\s+)?(?:new\s+)?influencer\.?$/i,
    handle: () => ({
      match: true,
      reply: "Opening the influencer wizard. Tell me what kind.",
      toolCall: { name: "show_influencer_wizard", args: {} },
    }),
  },

  /* ---------- Weather (no location) ----------
   *  Permissive set — operator phrases this many ways. ANY query that names a
   *  place ("weather in Alicante") falls through so the LLM picks up the
   *  location via the get_weather tool with proper args. Pure home-forecast
   *  queries are fast-path-eligible and use the 10-min weather cache.
   *  Reply is a function so we can speak the actual temperature returned by
   *  the get_weather tool call. */
  {
    /* Trailing modifier list is generous — "like today", "right now",
     * "outside today" etc. all chain naturally onto weather questions. The
     * regex matches one OR two of: like / today / now / right now / outside /
     * out, separated by spaces, in any order. */
    test: /^(?:what(?:'s|s| is)?\s+(?:the\s+)?(?:weather|forecast|temperature)(?:\s+(?:like|today|now|right\s+now|outside|out)){0,3}|how(?:'s|s| is)\s+(?:the\s+)?(?:weather|temperature)(?:\s+(?:like|today|now|right\s+now|outside|out)){0,3}|weather\s+(?:like|today|now|right\s+now|outside)?|forecast|is\s+it\s+(?:raining|sunny|hot|cold|warm)(?:\s+(?:out|outside|today|right\s+now))?|temperature\s+(?:outside|out|today|now)?)\.?\??$/i,
    handle: () => ({
      match: true,
      reply: (r) => r?.summary || "Couldn't fetch the weather.",
      toolCall: { name: "get_weather", args: {} },
    }),
  },

  /* ---------- Today's calendar ----------
   *  Today / "what's next" / "do I have anything on" — uses the calendar cache.
   *  Multi-day requests ("what's on this week") fall through to the LLM so it
   *  picks a sensible `days` argument. */
  {
    test: /^(?:what(?:'s|s| is)?\s+(?:on|happening|coming\s+up|next|in\s+the\s+diary)(?:\s+(?:today|now))?|my\s+(?:schedule|day|calendar)(?:\s+today)?|do\s+i\s+have\s+(?:anything|any\s+(?:meetings?|events?))(?:\s+(?:on|today|scheduled))?|what(?:'s|s| is)?\s+(?:the\s+)?(?:day|today)\s+looking\s+like|next\s+(?:meeting|event|appointment)|whens?\s+my\s+next\s+(?:meeting|event|appointment))\.?\??$/i,
    handle: () => ({
      match: true,
      reply: (r) => r?.summary || "Couldn't read the calendar.",
      toolCall: { name: "get_upcoming_events", args: { days: 1 } },
    }),
  },

  /* ---------- Brief me / inbox triage ----------
   *  Bypasses smart_inbox_briefing (which itself runs an LLM ranking pass).
   *  The fast-path reads the prewarmed Inbox.aggregate cache, surfaces counts
   *  + the most imminent item, and skips the LLM. Operator gets a 1-second
   *  answer rather than a 3-4s LLM-ranked briefing. The full LLM briefing is
   *  still reachable via slower phrasings ("give me a deep briefing"). */
  {
    test: /^(?:brief\s+me(?:\s+please)?|give\s+me\s+(?:a\s+)?(?:quick\s+|short\s+)?(?:briefing|update|rundown)|what(?:'s|s| is)?\s+(?:important|on\s+my\s+plate|the\s+plan|the\s+priority)|what\s+should\s+i\s+do(?:\s+first)?|whats?\s+pressing|my\s+(?:priorities|inbox)|inbox\s+(?:summary|please|briefing)?)\.?\??$/i,
    handle: async () => {
      const Inbox = await import("./inbox.mjs");
      let summary;
      try {
        const agg = await Inbox.aggregate({ days: 1, mailMax: 15 });
        summary = buildInboxReply(agg);
      } catch (e) {
        summary = "Couldn't read the inbox.";
      }
      return { match: true, reply: summary };
    },
  },

  /* ---------- Screenshot ----------
   *  Action-only — no spoken reply needed beyond confirmation. */
  {
    test: /^(?:take\s+a?\s*screenshot|screenshot|capture\s+(?:the\s+)?screen|grab\s+a?\s*screenshot)\.?$/i,
    handle: () => ({
      match: true,
      reply: (r) => r?.summary || "Screenshot taken.",
      toolCall: { name: "take_screenshot", args: {} },
    }),
  },

  /* ---------- Open well-known sites ----------
   *  Local qwen2.5:7b narrates "Opening the BBC News homepage" without ever
   *  firing open_url — same hallucination pattern we hit on news / brief.
   *  Whitelist common site names the operator says by name so the URL
   *  resolves locally and we fire open_url with a real URL. Anything not in
   *  the whitelist returns match:false and falls through to the LLM (which
   *  can still get it right for less-common sites with explicit URLs). */
  {
    test: /^(?:open|pull\s*up|bring\s*up|go\s*to)\s+(?:the\s+)?([a-z][a-z'.&\s-]{1,40}?)(?:\s+(?:homepage|website|site|page))?\.?$/i,
    handle: (_clean, match) => {
      const raw = (match?.[1] || "").trim().toLowerCase().replace(/\s+/g, " ");
      /* The regex's optional `(?:the\s+)?` prefix consumes "the" before the
       * captured name. So "open the times" leaves us with raw="times" — but
       * the whitelist key is "the times". Try both forms before giving up. */
      const url = OPEN_URL_WHITELIST[raw] || OPEN_URL_WHITELIST[`the ${raw}`];
      if (!url) return { match: false }; /* unknown site name — fall through to LLM */
      const matchedKey = OPEN_URL_WHITELIST[raw] ? raw : `the ${raw}`;
      const friendly = matchedKey.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
      return {
        match: true,
        reply: `Opening ${friendly}.`,
        toolCall: { name: "open_url", args: { url, reason: `Fast-path: ${friendly}`, confirmed: true } },
      };
    },
  },

  /* ---------- "Show me X" fallback ----------
   *  Runs LAST. Earlier specific handlers (news panel, brief, weather,
   *  calendar, screenshot, influencer wizard, open-site) catch their cases
   *  first. Anything else under "show me X" falls back to a Google search
   *  for X — Google widgetises weather / stocks / places / definitions /
   *  conversions so the operator gets a relevant visual answer without us
   *  building a panel for every topic. A small special-case branch routes
   *  "show me a map of X" / "directions to X" to Google Maps. */
  {
    test: /^show\s+me\s+(.+?)\.?\??$/i,
    handle: (_clean, match) => {
      const query = (match?.[1] || "").trim();
      if (!query) return { match: false };
      const lower = query.toLowerCase();
      let url, friendly;
      const mapMatch = lower.match(/^(?:a\s+map\s+of\s+|directions\s+to\s+)(.+)$/);
      if (mapMatch) {
        url = `https://www.google.com/maps/search/${encodeURIComponent(mapMatch[1])}`;
        friendly = `a map of ${mapMatch[1]}`;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        friendly = query;
      }
      return {
        match: true,
        reply: `Pulling up ${friendly}.`,
        toolCall: { name: "open_url", args: { url, reason: `show me: ${query}`, confirmed: true } },
      };
    },
  },
];

/** Name → URL map for the open-site fast-path. Lowercase keys, normalised
 *  whitespace. Add entries as the operator finds new common destinations.
 *  Aliases for the same site share the URL (e.g. both "bbc" and "bbc news"
 *  resolve to news.bbc.co.uk). */
const OPEN_URL_WHITELIST = {
  /* UK news */
  "bbc":              "https://www.bbc.co.uk/news",
  "bbc news":         "https://www.bbc.co.uk/news",
  "sky news":         "https://news.sky.com",
  "the guardian":     "https://www.theguardian.com/uk",
  "guardian":         "https://www.theguardian.com/uk",
  "the times":        "https://www.thetimes.co.uk",
  "the telegraph":    "https://www.telegraph.co.uk",
  /* Tech news */
  "hacker news":      "https://news.ycombinator.com",
  "hn":               "https://news.ycombinator.com",
  "the verge":        "https://www.theverge.com",
  "techcrunch":       "https://techcrunch.com",
  "ars technica":     "https://arstechnica.com",
  /* General search / mail */
  "google":           "https://www.google.com",
  "gmail":            "https://mail.google.com",
  "google maps":      "https://www.google.com/maps",
  "maps":             "https://www.google.com/maps",
  "google drive":     "https://drive.google.com",
  "calendar":         "https://calendar.google.com",
  "google calendar":  "https://calendar.google.com",
  /* Social */
  "youtube":          "https://www.youtube.com",
  "tiktok":           "https://www.tiktok.com",
  "instagram":        "https://www.instagram.com",
  "twitter":          "https://x.com",
  "x":                "https://x.com",
  "linkedin":         "https://www.linkedin.com",
  "reddit":           "https://www.reddit.com",
  /* Dev */
  "github":           "https://github.com",
  "stack overflow":   "https://stackoverflow.com",
  "chatgpt":          "https://chatgpt.com",
  "claude":           "https://claude.ai",
};

/** Compose a quick inbox spoken summary from the cached aggregate. Mirrors
 *  the LLM-ranked briefing in spirit but without the 2-4s LLM round-trip:
 *  counts + the single most imminent item, picked by Inbox.aggregate's
 *  default sort (events first, then by `when` ascending). */
function buildInboxReply(agg) {
  if (!agg) return "Inbox empty.";
  const counts = agg.sources || { mail: 0, events: 0, reminders: 0 };
  const items  = Array.isArray(agg.items) ? agg.items : [];
  if (items.length === 0) return "Clean plate — nothing in the inbox.";
  const parts = [];
  if (counts.events)    parts.push(`${counts.events} event${counts.events !== 1 ? "s" : ""}`);
  if (counts.mail)      parts.push(`${counts.mail} unread email${counts.mail !== 1 ? "s" : ""}`);
  if (counts.reminders) parts.push(`${counts.reminders} reminder${counts.reminders !== 1 ? "s" : ""}`);
  const top = items[0];
  /* Lead with counts, then the most-imminent headline so the operator
   * decides whether to dig deeper. */
  const head = parts.length ? parts.join(", ") : "items pending";
  const next = top ? ` Top: ${top.who} — ${top.what}.` : "";
  return `${head}.${next}`;
}

/** Compose the spoken summary using the prewarmed cache. Mirrors
 *  buildNewsSpokenSummary in server.mjs — the LLM path and the fast-path
 *  should sound the same to the operator. */
function buildNewsReply(cache) {
  if (!cache) return "Opening the news now.";
  const top = cache.topStories?.[0];
  const hn  = cache.hn?.[0];
  if (!top && !hn) return "Opening the news — feeds are still loading.";
  const parts = [];
  if (top) parts.push(`Top story: ${top.title}.`);
  if (hn)  parts.push(`In tech: ${hn.title}.`);
  return parts.join(" ");
}

/**
 * Match a query against the fast-path handlers. Returns null when no
 * handler claims it (caller falls through to the LLM); otherwise
 * { reply, toolCall? }.
 *
 * @param {string} query  the operator's transcribed utterance
 */
export async function tryFastPath(query) {
  const q = String(query || "").trim();
  if (!q) return null;
  /* Defensive normalisation. WakeParse strips "hey jarvis" but commonly
   * leaves residual punctuation ("hey jarvis, brief me" → ", brief me"),
   * which would defeat ^…$ regex anchors. Strip:
   *   - leading punctuation/whitespace
   *   - leading filler tokens (uh, um, er, hey) and any commas after them
   *   - then trim again
   * Order matters: punctuation first so "uh" inside "um, uh" gets handled. */
  const clean = q
    .replace(/^[\s,.;:!?-]+/, "")
    .replace(/^(?:uh|um|er|hey)[\s,]+/i, "")
    .replace(/^[\s,.;:!?-]+/, "")
    .trim();
  for (const h of HANDLERS) {
    const m = clean.match(h.test);
    if (m) {
      try {
        const result = await h.handle(clean, m);
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
