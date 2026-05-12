/** bridge-client.js - Single WebSocket client + pubsub for the Jarvis bridge.
 *
 *  Why: voice.js owned the WebSocket plus all event-routing branching for every async
 *  bridge event. As event types proliferated (task.*, video.edit.*, yt.thumbnail.*,
 *  pdf.complete, inbox.dropped, diary.refresh) the message handler became a 100-line
 *  branching block that couldn't be tested or reused. This module owns the socket and
 *  exposes:
 *    - ask({type, payload})  request/reply with id correlation, returns Promise<data>
 *    - on(prefix, handler)   pubsub subscription with `*` wildcard suffix
 *    - connect()             ensure socket open (idempotent)
 *
 *  The bridge's response envelope is { id?, type, data?, error? } for replies and
 *  { type, ts?, data, runId? } for broadcasts. Tool replies use type ending in
 *  ".reply"; everything else fans out to subscribers. */

const URL = "ws://localhost:8766";

/* Single shared socket. Reconnects on demand — every ask() / connect() call
 * checks readyState and reopens if closed. */
let ws = null;

/* Outstanding requests waiting for an id-matched reply. */
const pending = new Map();

/* Subscribers keyed by event-type prefix. Use `*` suffix as wildcard:
 *   on("task.*", h)        → matches task.start / task.progress / task.complete / task.error
 *   on("video.edit.complete", h) → exact match
 *   on("*", h)             → all events (debug). */
const subscribers = [];

function matches(type, prefix) {
  if (!type) return false;
  if (prefix === "*") return true;
  if (prefix.endsWith(".*")) return type === prefix.slice(0, -2) || type.startsWith(prefix.slice(0, -1));
  if (prefix.endsWith("*")) return type.startsWith(prefix.slice(0, -1));
  return type === prefix;
}

function dispatch(msg) {
  for (const sub of subscribers.slice()) {
    if (matches(msg.type, sub.prefix)) {
      try { sub.handler(msg); } catch (e) { console.warn(`[bridge-client] subscriber for ${sub.prefix} threw:`, e); }
    }
  }
}

function onMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }

  /* Reply correlation — tool calls match an id; type ends in ".reply" on success
   * or carries an `error` field on failure. Other ids are noise (shouldn't happen). */
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.type && m.type.endsWith(".reply")) resolve(m.data);
    else reject(new Error(m.error || "bridge error"));
    return;
  }

  /* Broadcast — fan out to subscribers. */
  dispatch(m);
}

/* Synthetic connection-state events. Why: subscribers (toast layer, agent
 * console, debug panel) need "is the bridge alive?" without polling
 * isConnected() on a timer. We fire `bridge.online` on first successful
 * open and `bridge.offline` after the WS has been closed for >2s — the
 * grace period suppresses toasts for quick reconnects (laptop wake,
 * `./launch.sh restart`) which finish before anyone notices. */
let _wasOnline = false;
let _offlineTimer = null;
function _emitOnline() {
  if (_offlineTimer) { clearTimeout(_offlineTimer); _offlineTimer = null; }
  /* Successful reconnect — reset the backoff so the next disconnect doesn't
   * inherit a stale long delay. */
  _retryDelayMs = INITIAL_RETRY_MS;
  if (_wasOnline) return;
  _wasOnline = true;
  dispatch({ type: "bridge.online", ts: Date.now(), data: {} });
}
function _scheduleOffline() {
  if (_offlineTimer) return;
  _offlineTimer = setTimeout(() => {
    _offlineTimer = null;
    if (!_wasOnline) return;
    _wasOnline = false;
    dispatch({ type: "bridge.offline", ts: Date.now(), data: {} });
  }, 2000);
}

/* Auto-reconnect with exponential backoff. Why: previously bridge-client.js
 * relied on the next ask() call to re-open after a close, so subscribers
 * (notifications, palette, audit drawer) went silent after a `./launch.sh
 * restart` until something happened to trigger an ask. Now connect() schedules
 * its own retry, capped at 30s, with the delay resetting to 1s on each
 * successful open. The HUD's own WS in hud.js has the same pattern. */
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
let _retryDelayMs = INITIAL_RETRY_MS;
let _retryTimer = null;
function _scheduleReconnect() {
  if (_retryTimer) return;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    /* Double the delay for next failure; cap at MAX_RETRY_MS. _emitOnline
     * resets it on a successful open. */
    _retryDelayMs = Math.min(_retryDelayMs * 2, MAX_RETRY_MS);
    connect();
  }, _retryDelayMs);
}

/** Ensure the socket is connecting or connected. Idempotent. */
export function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  /* Diagnostic instrumentation — Sprint 12 churn investigation. The bridge
   * keeps appearing to "drop offline" with the WAITING splash even though
   * server-side health is green. Logging every WS lifecycle event with
   * timing + close code/reason will tell us whether the close is browser-
   * initiated, bridge-initiated, network, or our own code calling close(). */
  const _t0 = Date.now();
  console.log(`[bridge-client] connect() opening WS to ${URL}`);
  try { ws = new WebSocket(URL); } catch (e) {
    console.warn(`[bridge-client] WebSocket constructor threw: ${e.message}`);
    _scheduleOffline(); _scheduleReconnect(); return;
  }
  ws.addEventListener("open", () => {
    console.log(`[bridge-client] WS open after ${Date.now() - _t0}ms`);
    _emitOnline();
  });
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", (ev) => {
    /* CloseEvent fields: code (1000=normal, 1001=going-away, 1006=abnormal,
     * 1011=server error), reason (string), wasClean (bool). 1006 = no close
     * frame received → typically a network/transport issue. */
    console.warn(`[bridge-client] WS closed after ${Date.now() - _t0}ms · code=${ev.code} reason="${ev.reason || ""}" clean=${ev.wasClean}`);
    ws = null; _scheduleOffline(); _scheduleReconnect();
  });
  ws.addEventListener("error", (ev) => {
    console.warn(`[bridge-client] WS error · readyState=${ws?.readyState ?? "?"}`);
  });
}

/**
 * Subscribe to a bridge event type. Returns an unsubscribe function.
 *
 * @param {string} prefix   Exact type ("pdf.complete") or wildcard ("task.*", "*").
 * @param {(msg) => void} handler  Called with the full envelope { type, ts?, data, ... }.
 * @returns {() => void} call to unsubscribe.
 */
export function on(prefix, handler) {
  const entry = { prefix, handler };
  subscribers.push(entry);
  return () => {
    const i = subscribers.indexOf(entry);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

/**
 * Send a request to the bridge and resolve with the reply payload.
 *
 * @param {{type: string, payload?: any}} req
 * @param {number} [timeoutMs=120000]  Reject the Promise if no reply lands in time.
 * @returns {Promise<any>} the data field from the bridge's reply.
 */
export function ask({ type, payload }, timeoutMs = 120_000) {
  connect();
  return new Promise((resolve, reject) => {
    if (!ws) return reject(new Error("bridge unavailable"));
    const id = `q-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    pending.set(id, { resolve, reject });
    const send = () => {
      try { ws.send(JSON.stringify({ id, type, payload })); }
      catch (e) { pending.delete(id); reject(e); }
    };
    if (ws.readyState === 1) send();
    else ws.addEventListener("open", send, { once: true });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("bridge timeout"));
      }
    }, timeoutMs);
  });
}

/** True if the socket is currently OPEN (readyState 1). Useful for offline UX. */
export function isConnected() {
  return ws != null && ws.readyState === 1;
}

/** For testing / introspection. Don't rely on this from product code. */
export function _stats() {
  return { pending: pending.size, subscribers: subscribers.length, readyState: ws?.readyState ?? -1 };
}
