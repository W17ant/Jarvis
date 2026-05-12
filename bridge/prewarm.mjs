/** bridge/prewarm.mjs — Background cache warmer.
 *
 *  When the operator asks a "basic question" — what's the weather, what's
 *  in my inbox, what's on today — the underlying fetch can take anywhere
 *  from a few hundred ms (open-meteo) to multiple seconds (Calendar.app via
 *  AppleScript on cold boot). The first call of each session paid that cost.
 *
 *  This module sits beside `bridge/news.mjs` and applies the same pattern:
 *  call the owning module's data fetcher on a schedule with `force: true`,
 *  so each module's own in-memory cache is always fresh before the operator
 *  ever asks. Tool handlers don't change — they read their module's cache
 *  via the normal call path and just happen to hit a warm entry.
 *
 *  Cadences (chosen per source):
 *    - inbox      45s   (Inbox.aggregate cache TTL is 60s; refresh under TTL)
 *    - weather    9min  (weather.cache TTL is 10min)
 *    - calendar   4min  (Calendar.getUpcomingEvents cache TTL is 5min)
 *
 *  All cadences sit ~10% under their cache TTL so the cache never expires
 *  between refreshes. Failures are logged but not surfaced — the next refresh
 *  will retry and the underlying tool handler still works (slow path).
 */

let _timers = [];

/** Start the warmers. Each fetcher is injected so this module has no direct
 *  imports from server-internal helpers — keeps the dependency graph clean
 *  and makes the module testable.
 *
 *  @param {object} deps
 *  @param {() => Promise<any>} deps.warmInbox     — fetcher that primes inbox cache
 *  @param {() => Promise<any>} deps.warmWeather   — fetcher that primes weather cache
 *  @param {() => Promise<any>} deps.warmCalendar  — fetcher that primes calendar cache
 */
export function start({ warmInbox, warmWeather, warmCalendar } = {}) {
  stop();
  const schedule = [
    /* [label, fn, intervalMs]. Initial fetch fires immediately; interval thereafter. */
    ["inbox",    warmInbox,    45 * 1000],
    ["weather",  warmWeather,  9 * 60 * 1000],
    ["calendar", warmCalendar, 4 * 60 * 1000],
  ];
  for (const [label, fn, intervalMs] of schedule) {
    if (typeof fn !== "function") continue;
    /* Initial warm — fire-and-forget; do not block boot on any of these. */
    Promise.resolve()
      .then(fn)
      .catch((e) => console.warn(`[prewarm] ${label} initial: ${e.message}`));
    const t = setInterval(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => console.warn(`[prewarm] ${label} refresh: ${e.message}`));
    }, intervalMs);
    /* Don't keep the event loop alive just for warmers. */
    if (typeof t.unref === "function") t.unref();
    _timers.push(t);
  }
}

/** Stop all warmers. Used by tests and graceful shutdown. */
export function stop() {
  for (const t of _timers) clearInterval(t);
  _timers = [];
}
