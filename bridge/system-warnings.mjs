/** system-warnings.mjs — central registry for bridge-detected misconfigurations
 *  that the operator should see as a HUD toast.
 *
 *  Why a registry instead of inline broadcasts: each warning has a stable
 *  `code` so the HUD can dedupe (don't fire ten 401 toasts for ten retries),
 *  and the operator can clear / re-trigger by code. Without this, the bridge
 *  silently logged misconfigurations (`macmon binary not found`,
 *  `ANTHROPIC_API_KEY 401`) to /tmp/jarvis-bridge.log where nobody saw them.
 *
 *  Lifecycle:
 *    register({code, title, body, action})  → first time, broadcasts.
 *                                              Subsequent calls with same code
 *                                              are no-ops.
 *    clear(code)                             → removes from registry, broadcasts
 *                                              `system.warning.cleared`.
 *    list()                                  → all active warnings (used by
 *                                              /health/warnings endpoint + HUD
 *                                              snapshot on initial connect).
 *
 *  Broadcaster injection mirrors the pattern used by tasks.mjs and crew.mjs —
 *  server.mjs wires it via setBroadcaster() during boot. Keeps this module
 *  decoupled from the WS plumbing and lets it stay testable.
 */

const _active = new Map();      // code → entry
let _broadcaster = null;        // wired by server.mjs

/** Wire the WebSocket broadcaster. Called once at boot. */
export function setBroadcaster(fn) { _broadcaster = fn; }

/** Register a new warning. No-op if the code is already active so the
 *  operator doesn't get spammed for repeated detections of the same issue.
 *  @param {{code: string, title: string, body?: string, action?: {label: string, href?: string}}} entry
 */
export function register(entry) {
  if (!entry?.code) return;
  if (_active.has(entry.code)) return;     // already fired — dedupe
  const stamped = { ...entry, ts: Date.now() };
  _active.set(entry.code, stamped);
  _broadcaster?.({ type: "system.warning", data: stamped });
}

/** Clear an active warning. Useful when the underlying issue resolves
 *  (operator added a key, macmon got installed, etc.). */
export function clear(code) {
  if (!_active.has(code)) return;
  _active.delete(code);
  _broadcaster?.({ type: "system.warning.cleared", data: { code } });
}

/** All currently-active warnings. Returned to the HUD on connect so
 *  reconnecting clients see the warnings they missed while disconnected. */
export function list() {
  return [..._active.values()];
}
