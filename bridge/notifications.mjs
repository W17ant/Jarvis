/** notifications.mjs - Central scheduler for the operator-facing notification stream.
 *
 *  Why centralised: the kiosk has five sources that should reach the operator as
 *  toasts/drawer entries — calendar reminders, press-radar hits, mail digests,
 *  Frame.io activity, bridge health. Each was a candidate for its own scheduler,
 *  which would scatter "should this fire now?" logic across the codebase. This
 *  module owns timing + dedup + the emit contract; each emitter just calls the
 *  right helper.
 *
 *  Wire format: every notification fires through the existing broadcastToClients
 *  pubsub as `{ type: "notify.<kind>", data: { kind, severity, title, body, ... } }`.
 *  The HUD's notifications.js subscribes to "notify.*" and routes by kind.
 *
 *  Severity vocabulary (drives toast colour + bell-count weight):
 *    info  — most events; default
 *    success — confirms a desired state (mail clean, all services healthy)
 *    warn  — needs attention, not urgent (5-min calendar reminder, 3-min ETA)
 *    alert — urgent + actionable (T-2-min reminder, bridge service down)
 *
 *  Dedup: each emitter passes a `dedupKey` so a notification only fires once
 *  per relevant window (an event at 14:30 should only emit ONE T-15 reminder,
 *  not one every minute the polling loop catches it inside the window).
 */

/* Broadcaster wired in by server.mjs at boot via setBroadcaster(). Avoids a circular
 * import (server.mjs imports this module; we'd be importing it back). Same pattern
 * as tasks.mjs uses. */
let _broadcaster = null;
export function setBroadcaster(fn) { _broadcaster = fn; }
function broadcastToClients(payload) {
  if (typeof _broadcaster === "function") _broadcaster(payload);
}

/* In-memory dedup. Maps dedupKey → ts. Trimmed on each emit; entries older than
 * 24h are dropped. Survives a bridge restart cleanly because deduped events are
 * mostly time-windowed (calendar T-15, today's mail digest) — re-firing after a
 * restart is acceptable. */
const sentDedup = new Map();
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

function alreadySent(dedupKey) {
  if (!dedupKey) return false;
  const ts = sentDedup.get(dedupKey);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_WINDOW_MS) {
    sentDedup.delete(dedupKey);
    return false;
  }
  return true;
}

function markSent(dedupKey) {
  if (!dedupKey) return;
  sentDedup.set(dedupKey, Date.now());
  /* Trim old entries opportunistically — cheap because the map only grows by ~50
   * entries/day max in practice. */
  if (sentDedup.size > 200) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [k, t] of sentDedup) if (t < cutoff) sentDedup.delete(k);
  }
}

/**
 * Emit a notification.
 *
 * @param {object} args
 * @param {string} args.kind        e.g. "calendar.reminder", "press.radar", "mail.digest"
 * @param {string} args.title       short headline (≤60 chars; renders bold)
 * @param {string} [args.body]       1-2 sentence detail (≤200 chars)
 * @param {string} [args.severity=info]  info | success | warn | alert
 * @param {string} [args.dedupKey]  prevents duplicate within DEDUP_WINDOW_MS
 * @param {object} [args.action]    { label, href? } — optional CTA shown on the toast
 */
export function emit({ kind, title, body, severity = "info", dedupKey, action }) {
  if (!kind || !title) return false;
  if (alreadySent(dedupKey)) return false;
  markSent(dedupKey);
  broadcastToClients({
    type: `notify.${kind}`,
    data: { kind, title, body: body || null, severity, action: action || null },
  });
  return true;
}

/* ─────────────────────────────────────────────
 * 1. CALENDAR REMINDERS — T-15 + T-5 + T-now
 * ────────────────────────────────────────────
 *  Polls a getEvents() callback every minute. For each event whose start time
 *  is within (now+1min, now+15min), fires reminders at the relevant boundaries.
 *  Dedupe key = event identity + boundary, so a 14:30 event emits ONE T-15
 *  reminder at ~14:15, ONE T-5 at ~14:25, even though the poll runs 5+ times
 *  inside each window.
 */
export function startCalendarReminders({ getEvents }) {
  const POLL_MS = 60_000;
  async function tick() {
    let events = [];
    try { events = await getEvents(); } catch (e) { console.warn(`[notify] calendar fetch failed: ${e.message}`); return; }
    const now = Date.now();
    for (const ev of events) {
      if (!ev?.start) continue;
      const eventTs = new Date(ev.start).getTime();
      if (!Number.isFinite(eventTs)) continue;
      const minsToEvent = Math.round((eventTs - now) / 60_000);
      const eventKey = ev.id || `${ev.title}@${ev.start}`;

      /* T-15: fire when event is 13-17 minutes away (poll catches 5-window). */
      if (minsToEvent >= 13 && minsToEvent <= 17) {
        emit({
          kind: "calendar.reminder",
          severity: "warn",
          title: `In 15 min · ${ev.title || "(no title)"}`,
          body: ev.location ? `${formatTime(eventTs)} · ${ev.location}` : formatTime(eventTs),
          dedupKey: `cal-15-${eventKey}`,
        });
      }
      /* T-5: fire when 3-7 min away. */
      if (minsToEvent >= 3 && minsToEvent <= 7) {
        emit({
          kind: "calendar.reminder",
          severity: "alert",
          title: `In 5 min · ${ev.title || "(no title)"}`,
          body: ev.location ? `${formatTime(eventTs)} · ${ev.location}` : formatTime(eventTs),
          dedupKey: `cal-5-${eventKey}`,
        });
      }
    }
  }
  /* First tick after 5s so the bridge has settled. Then every minute. */
  setTimeout(tick, 5_000);
  setInterval(tick, POLL_MS);
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/* ─────────────────────────────────────────────
 * 2. PRESS-RADAR PINGS
 * ────────────────────────────────────────────
 *  Called from press-radar.mjs when the daily sweep finds new hits the operator
 *  hasn't seen. Each hit is emitted individually so the operator can act on a
 *  specific manufacturer.
 */
export function emitPressRadarHit({ manufacturer, headline, source, url }) {
  emit({
    kind: "press.radar",
    severity: "info",
    title: `Press · ${manufacturer}`,
    body: `${source ? source.toUpperCase() + " — " : ""}${headline}`,
    action: url ? { label: "OPEN", href: url } : null,
    /* dedup on the URL so the daily sweep doesn't re-emit the same hit if it
     * appears in two outlets the same day. */
    dedupKey: `press-${url || manufacturer + headline}`,
  });
}

/* ─────────────────────────────────────────────
 * 3. MAIL DIGEST — twice daily, 09:00 + 14:00
 * ────────────────────────────────────────────
 *  Calls a getMailSummary() callback at the configured hours. If the result has
 *  unread items, emits a single roll-up notification with the count by sender
 *  domain. No emission when the inbox is clean — silence when there's nothing.
 */
export function startMailDigest({ getMailSummary, hours = [9, 14] }) {
  const FIVE_MIN = 5 * 60_000;
  async function maybeFire() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    if (!hours.includes(h)) return;
    /* Fire only in the first 5 minutes of the hour to avoid spamming if the
     * minute tick lands inside the window multiple times. */
    if (m >= 5) return;
    const dedup = `mail-${now.toISOString().slice(0, 10)}-${h}`;
    if (alreadySent(dedup)) return;
    let summary;
    try { summary = await getMailSummary(); } catch (e) { console.warn(`[notify] mail fetch failed: ${e.message}`); return; }
    if (!summary?.unread || summary.unread === 0) {
      markSent(dedup);
      return;
    }
    const top = (summary.bySender || []).slice(0, 3).map((s) => `${s.count} from ${s.sender}`).join(", ");
    emit({
      kind: "mail.digest",
      severity: summary.unread > 10 ? "warn" : "info",
      title: `${summary.unread} unread`,
      body: top || "Multiple senders",
      dedupKey: dedup,
    });
  }
  /* Check every minute — cheap, dedup makes overflow harmless. */
  setTimeout(maybeFire, 5_000);
  setInterval(maybeFire, 60_000);
}

/* ─────────────────────────────────────────────
 * 4. FRAME.IO ACTIVITY — comments + status changes
 * ────────────────────────────────────────────
 *  Polls a getFrameioActivity() callback every 5 minutes. Frame.io has webhooks
 *  but they need a public endpoint; polling is simpler for the kiosk model
 *  where the bridge isn't internet-reachable. Each new comment / status change
 *  fires a notification with action=OPEN linking to the Frame.io URL.
 */
export function startFrameioActivity({ getActivity }) {
  const POLL_MS = 5 * 60_000;
  async function tick() {
    let activity;
    try { activity = await getActivity(); } catch (e) { console.warn(`[notify] frameio fetch failed: ${e.message}`); return; }
    if (!Array.isArray(activity?.events)) return;
    for (const evt of activity.events) {
      const dedup = `fio-${evt.id || evt.fileId + evt.ts}`;
      if (alreadySent(dedup)) continue;
      emit({
        kind: "frameio.activity",
        severity: evt.severity || "info",
        title: evt.title || "Frame.io update",
        body: evt.body || null,
        action: evt.url ? { label: "OPEN", href: evt.url } : null,
        dedupKey: dedup,
      });
    }
  }
  setTimeout(tick, 30_000);
  setInterval(tick, POLL_MS);
}

/* ─────────────────────────────────────────────
 * 5. BRIDGE HEALTH — service up/down deltas
 * ────────────────────────────────────────────
 *  Polls /healthz state internally and emits when a service flips. Quiet on
 *  boot; only edges trigger notifications. The data already exists in server.mjs's
 *  healthz handler; we just observe deltas.
 */
const lastHealth = { ollama: null, kokoro: null, whisper: null };
export function recordHealthSnapshot(snapshot) {
  const services = snapshot?.services || {};
  for (const [svc, up] of Object.entries(services)) {
    if (svc === "bridge") continue;
    const prev = lastHealth[svc];
    if (prev !== null && prev !== up) {
      /* Edge: state flipped. */
      const dedup = `health-${svc}-${up ? "up" : "down"}-${Math.floor(Date.now() / 60_000)}`;
      emit({
        kind: "bridge.health",
        severity: up ? "success" : "alert",
        title: up ? `${svc} restored` : `${svc} unreachable`,
        body: up ? `${svc} is back online.` : `${svc} stopped responding. Voice / vision features may be degraded until it's restarted.`,
        dedupKey: dedup,
      });
    }
    lastHealth[svc] = up;
  }
}
