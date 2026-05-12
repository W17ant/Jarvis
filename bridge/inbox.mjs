/** inbox.mjs - unified inbox aggregator across mail / calendar / reminders.
 *
 *  Why: an operator's "what should I look at right now" is split across
 *  four disconnected surfaces - Mail unread, today's calendar, Reminders
 *  due, plus whatever the LLM has been recently surfaced. None of them
 *  on their own answers the question "what's important today." The
 *  Smart Inbox aggregates them into one normalised list the LLM can
 *  rank against the active workspace's handbook.
 *
 *  Source surfaces (all already wired in the bridge):
 *    - Mail (AppleScript)        - via getMailSummary()
 *    - Calendar (Apple Calendar) - via getUpcomingEvents()
 *    - Reminders                 - reserved for v1 (Personal.listReminders
 *                                  doesn't exist yet)
 *
 *  Cache: 60s TTL on the aggregated result. The HUD inbox panel polls
 *  every 5min, the briefing tool fires on demand; both share results.
 *
 *  Normalisation: every source maps to:
 *    {
 *      kind: "email" | "event" | "reminder",
 *      source: <source-specific id>,
 *      when: epoch-ms (event start, email date, reminder due, ...),
 *      who: short string (sender, organiser, owner),
 *      what: subject / title (truncated to ~120 chars),
 *      preview: 1-line preview text (optional),
 *      urgency_hints: { ... },     // sender-known? deadline-tight? client?
 *      raw: <original source row>  // kept for tools that need the full payload
 *    }
 */

const CACHE_TTL_MS = 60_000;
let _cache = null;
let _cacheStamp = 0;
/* Single-flight dedup. Multiple callers (HUD /inbox poll, prewarm timer,
 * smart_inbox_briefing tool) can ask for an aggregate at the same time;
 * without this they each spawn their own Mail/Calendar/Reminders fanout
 * and contend for the slow AppleScript runtimes (Mail.app in particular
 * serializes some internal locks, pushing concurrent calls past the 8s
 * HTTP timeout). With dedup, the first caller does the work and everyone
 * else joins the same promise. */
let _inFlight = null;

/* Handlers injected from server.mjs at boot — keeps this module decoupled
 * from the giant tool dispatch surface. We accept three optional functions:
 *   getMailSummary({ unreadOnly, max }) → { ok, messages: [...] }
 *   getUpcomingEvents({ days })         → { ok, events: [...] }
 *   listReminders({ listName })         → { ok, reminders: [...] } | null
 * Any handler can be null - the aggregator just skips that source. */
let _getMailSummary = null;
let _getUpcomingEvents = null;
let _listReminders = null;

export function setSources({ getMailSummary, getUpcomingEvents, listReminders } = {}) {
  if (typeof getMailSummary === "function") _getMailSummary = getMailSummary;
  if (typeof getUpcomingEvents === "function") _getUpcomingEvents = getUpcomingEvents;
  if (typeof listReminders === "function") _listReminders = listReminders;
}

/** Drop every wired source handler. Used by tests so a previous test's
 *  mocks don't leak into the next test through the module cache. */
export function clearSources() {
  _getMailSummary = null;
  _getUpcomingEvents = null;
  _listReminders = null;
  _cache = null;
  _cacheStamp = 0;
}

/** Map a Mail message into the normalised shape. */
function _normaliseEmail(m) {
  return {
    kind: "email",
    source: m.id || m.messageId || `mail:${m.from}-${m.subject?.slice(0, 20)}`,
    when: m.dateMs || (m.date ? new Date(m.date).getTime() : Date.now()),
    who: m.from || "(unknown sender)",
    what: String(m.subject || "(no subject)").slice(0, 120),
    preview: m.preview ? String(m.preview).slice(0, 200) : null,
    urgency_hints: {
      unread: !!m.unread,
      hasAttachment: !!m.hasAttachment,
      replied: !!m.replied,
    },
    raw: m,
  };
}

/** Map a Calendar event into the normalised shape. */
function _normaliseEvent(e) {
  const startMs = e.startMs || (e.start ? new Date(e.start).getTime() : Date.now());
  const now = Date.now();
  const minutesAway = Math.round((startMs - now) / 60000);
  return {
    kind: "event",
    source: e.id || `event:${startMs}-${e.title?.slice(0, 20)}`,
    when: startMs,
    who: e.organiser || e.calendarName || "(no organiser)",
    what: String(e.title || "(no title)").slice(0, 120),
    preview: e.location ? `at ${e.location}` : null,
    urgency_hints: {
      minutesAway,
      isImminent: minutesAway >= 0 && minutesAway <= 60,
      isAllDay: !!e.allDay,
      hasLocation: !!e.location,
    },
    raw: e,
  };
}

/** Aggregate every source into a single normalised + sorted list.
 *  Sort order: imminent events first (next 60min), then anything else by
 *  `when` ascending. Caller-side rankers (the LLM via the briefing tool,
 *  the HUD panel) get a sensible default before any handbook-driven
 *  re-ranking happens.
 *
 *  @param {{ days?: number, mailMax?: number, force?: boolean }} opts
 *  @returns {Promise<{ items: array, sources: { mail, events, reminders }, generatedAt: number, fromCache: boolean }>}
 */
export async function aggregate({ days = 1, mailMax = 15, force = false } = {}) {
  /* Cache hit when a recent aggregate is fresher than the TTL. force:true
   * (used by the briefing tool when the operator says "give me a fresh
   * briefing") bypasses. */
  if (!force && _cache && (Date.now() - _cacheStamp) < CACHE_TTL_MS) {
    return { ..._cache, fromCache: true };
  }
  /* If a fanout is already running, join it instead of starting a second one.
   * Even force:true callers join — running two fanouts in parallel against
   * Mail.app makes both slower, never faster. */
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      return await _doAggregate({ days, mailMax });
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

async function _doAggregate({ days, mailMax }) {
  /* Run the source pulls in parallel — none depends on the others. Each
   * is wrapped so a single source failure doesn't blow up the whole
   * aggregate. */
  const sourceCounts = { mail: 0, events: 0, reminders: 0 };
  const mailP = _getMailSummary ? _getMailSummary({ unreadOnly: true, max: mailMax }).catch(() => null) : Promise.resolve(null);
  const eventsP = _getUpcomingEvents ? _getUpcomingEvents({ days }).catch(() => null) : Promise.resolve(null);
  const remindersP = _listReminders ? _listReminders({}).catch(() => null) : Promise.resolve(null);
  const [mail, events, reminders] = await Promise.all([mailP, eventsP, remindersP]);

  const items = [];
  if (mail?.ok && Array.isArray(mail.messages)) {
    sourceCounts.mail = mail.messages.length;
    for (const m of mail.messages) items.push(_normaliseEmail(m));
  }
  if (events?.ok && Array.isArray(events.events)) {
    sourceCounts.events = events.events.length;
    for (const e of events.events) items.push(_normaliseEvent(e));
  }
  if (reminders?.ok && Array.isArray(reminders.reminders)) {
    sourceCounts.reminders = reminders.reminders.length;
    /* Reminder normalisation lives here so adding the source later
     * doesn't require touching the loop above. */
    for (const r of reminders.reminders) {
      const dueMs = r.dueMs || (r.due ? new Date(r.due).getTime() : null);
      items.push({
        kind: "reminder",
        source: r.id || `reminder:${r.title?.slice(0, 20)}`,
        when: dueMs || Date.now(),
        who: r.listName || "Reminders",
        what: String(r.title || "(no title)").slice(0, 120),
        preview: r.notes ? String(r.notes).slice(0, 200) : null,
        urgency_hints: {
          minutesUntilDue: dueMs ? Math.round((dueMs - Date.now()) / 60000) : null,
          completed: !!r.completed,
          hasDueDate: !!dueMs,
        },
        raw: r,
      });
    }
  }

  /* Default sort: imminent events first, then everything by when ascending.
   * The briefing tool's LLM may re-rank; the HUD panel uses this order
   * directly. */
  items.sort((a, b) => {
    const aImminent = a.kind === "event" && a.urgency_hints?.isImminent ? 1 : 0;
    const bImminent = b.kind === "event" && b.urgency_hints?.isImminent ? 1 : 0;
    if (aImminent !== bImminent) return bImminent - aImminent;
    return (a.when || 0) - (b.when || 0);
  });

  const result = {
    items,
    sources: sourceCounts,
    generatedAt: Date.now(),
    fromCache: false,
  };
  _cache = result;
  _cacheStamp = Date.now();
  return result;
}

/** Force-clear the cache. Used after operator actions that change the
 *  underlying state (drafted email, completed reminder, accepted event). */
export function invalidate() {
  _cache = null;
  _cacheStamp = 0;
}

/* Voice action ordinal resolution.
 *
 * After a smart_inbox_briefing fires, the operator can say "reply to the
 * first one" / "snooze the second" / "open the third one". The bridge
 * resolves "first/second/third/1/2/3" to the cached aggregate's item
 * list (1-based). Word-form ordinals are mapped at the tool dispatch
 * layer before they reach this resolver. */
export function getItemByOrdinal(ordinal) {
  const n = Math.max(1, Math.min(50, Number(ordinal) || 0));
  if (!n || !_cache?.items?.length) return null;
  return _cache.items[n - 1] || null;
}
