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

/** Ensure the socket is connecting or connected. Idempotent. */
export function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { ws = new WebSocket(URL); } catch { return; }
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", () => { ws = null; });
  ws.addEventListener("error", () => { /* close handler retries on next ask */ });
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
