/** proactive.mjs — opt-out shoulder-tap layer for inbound events.
 *
 *  Today's kiosk is strictly reactive: the assistant only speaks when
 *  the operator wakes it. Proactive flips that for high-signal events
 *  the operator would want flagged without asking — new email, urgent
 *  reminders firing, sustained system warnings.
 *
 *  This module is the delta detector. It is fed each inbox aggregate
 *  by prewarm's warmInbox wrapper, compares the result against the
 *  set of items it has already seen, and broadcasts WS events for
 *  the new ones. Suppression / speech / rate-limiting happens on the
 *  HUD side (voice.js) — bridge only owns "this is new since I last
 *  looked", not "should we speak right now".
 *
 *  First-poll behaviour: populate the seen-set without announcing.
 *  Otherwise every unread email in the inbox would announce at boot,
 *  which is the precise UX disaster the "needs a learning layer" note
 *  in the ultra-think was about. Baseline = silence.
 *
 *  Per-poll cap: a flood of 20 new emails after a multi-hour gap
 *  should not trigger 20 sequential announcements. Cap at N per
 *  poll; the operator can say "brief me" to triage the rest at their
 *  pace.
 *
 *  Per-source debounce: even within the cap, we never announce the
 *  same email more than once. The source ID is the canonical dedup
 *  key — Mail's messageId is stable across polls.
 */

const MAX_ANNOUNCEMENTS_PER_POLL = 3;
const MAX_SEEN_SET_SIZE = 2000;

let _enabled = true;
let _seenEmailIds = new Set();
let _firstPollDone = false;

/** Toggle the proactive layer. Default on; flip via CONFIG.proactiveEmail
 *  or a future settings UI. When off, deltas are still tracked (so flipping
 *  back on does not re-announce the backlog) but no events fire. */
export function setEnabled(on) {
  _enabled = !!on;
}

/** Reset the seen-set. Used on operator action (read all / mark all read)
 *  if we want to re-announce the next poll. Not currently called but
 *  exposed for the future settings surface. */
export function resetSeen() {
  _seenEmailIds = new Set();
  _firstPollDone = false;
}

/** Trim the seen-set if it grows past the cap — protects against unbounded
 *  memory growth in a long-running kiosk. LRU-ish: just clear and let the
 *  next poll re-populate (cheap, and old IDs are unlikely to re-appear). */
function _maybeTrim() {
  if (_seenEmailIds.size > MAX_SEEN_SET_SIZE) {
    _seenEmailIds = new Set();
  }
}

/** Feed an inbox aggregate; broadcast inbox.new_email for emails not seen
 *  in any previous aggregate. broadcastFn is injected so this module
 *  stays decoupled from the WS plumbing.
 *
 *  @param {object} aggregate  — result of Inbox.aggregate()
 *  @param {(msg: object) => void} broadcastFn  — broadcastToClients
 */
export function checkForNewEmails(aggregate, broadcastFn) {
  if (!aggregate?.items) return;
  /* Always update the seen-set, even on first poll or when disabled —
   * otherwise re-enabling would re-announce the whole inbox backlog. */
  const emails = aggregate.items.filter((it) => it.kind === "email");
  const newOnes = [];
  for (const e of emails) {
    const id = e.source;
    if (!id) continue;
    if (!_seenEmailIds.has(id)) {
      _seenEmailIds.add(id);
      newOnes.push(e);
    }
  }
  _maybeTrim();

  /* Baseline pass: never announce on first call. */
  if (!_firstPollDone) {
    _firstPollDone = true;
    return;
  }
  if (!_enabled || newOnes.length === 0) return;

  /* Sort newest-first so if the cap kicks in we surface the freshest
   * items rather than whatever order the aggregator returned. */
  newOnes.sort((a, b) => (b.when || 0) - (a.when || 0));
  const toAnnounce = newOnes.slice(0, MAX_ANNOUNCEMENTS_PER_POLL);
  const overflow = Math.max(0, newOnes.length - MAX_ANNOUNCEMENTS_PER_POLL);

  /* Single broadcast carrying all new items lets the HUD decide whether
   * to speak each one separately or compose a single "you have N new
   * emails" line. Bridge does not impose the speech pattern. */
  if (typeof broadcastFn === "function") {
    broadcastFn({
      type: "inbox.new_email",
      data: {
        items: toAnnounce.map((e) => ({
          source: e.source,
          who: e.who,
          what: e.what,
          preview: e.preview,
          when: e.when,
        })),
        totalNew: newOnes.length,
        overflow,
      },
    });
  }
}
