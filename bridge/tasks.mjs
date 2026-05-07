// @ts-check
/** tasks.mjs - Long-running task lifecycle + broadcast helpers.
 *
 *  Why: pre-existing bridge events (video.edit.complete, yt.thumbnail.progress, etc)
 *  are tool-specific and shaped inconsistently. The HUD task strip needs a uniform
 *  surface that any tool can drive. This module emits a standardised lifecycle
 *  alongside the legacy events:
 *    task.start    { runId, kind, label, etaSec?, ts }
 *    task.progress { runId, kind, percent?, label?, etaSec?, ts }
 *    task.complete { runId, kind, label?, ts, durationMs }
 *    task.error    { runId, kind, error, ts, durationMs }
 *
 *  Lock-in: runId is the universal correlation key. Every later feature
 *  (notifications, audit log, undo, project filter) hangs off it. Generate one
 *  via newRunId() at task start and thread it through every broadcast for that
 *  task's lifetime.
 *
 *  Lock-in: all bridge broadcasts SHOULD eventually conform to
 *    { type, runId?, ts, data? }
 *  but legacy events keep their existing shape — HUD code reads both. New broadcast
 *  sites should use this module's helpers. */

import { randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SNAPSHOT_PATH = path.join(PROJECT_DIR, "data", "tasks-active.json");

/* In-memory task registry. Mirror to disk so a bridge restart can recover —
 * orphaned entries get a synthetic task.error broadcast so the HUD's task strip
 * doesn't show a forever-running render after a daemon restart. */
const tasks = new Map();

function persistSnapshot() {
  try {
    /* Why: sync writes intentionally — this fires on every lifecycle event,
     * so async writes would race themselves. The snapshot is small (≤8 entries),
     * write is cheap. mkdir-on-demand for fresh installs. */
    const dir = path.dirname(SNAPSHOT_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ ts: Date.now(), tasks: [...tasks.values()] }, null, 2);
    writeFileSync(SNAPSHOT_PATH, payload);
  } catch (e) {
    /* Snapshot failure is non-fatal — the in-memory state still works. */
    console.warn(`[tasks] snapshot failed: ${e.message}`);
  }
}

let _broadcaster = null;
/** Wire the broadcaster from server.mjs once at startup. Avoids circular import. */
export function setBroadcaster(fn) { _broadcaster = fn; }

function emit(type, data) {
  /* Standard envelope: type + ts + data. Consumers can ignore fields they don't
   * understand without breaking. */
  const payload = { type, ts: Date.now(), data };
  if (_broadcaster) _broadcaster(payload);
}

/** Generate a short, sortable runId. UUID is overkill for HUD display; first segment is fine. */
export function newRunId(prefix = "t") {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

/**
 * Begin a task. Returns the runId so the caller can use it on progress/complete/error.
 * @param {object} opts
 * @param {string} opts.kind     Tool category — "video.edit" | "yt.thumbnail" | "pdf" | "watermark" | "outreach" | etc.
 * @param {string} opts.label    Short human-readable label for the strip (e.g. "the press car teaser · 30s · 9:16").
 * @param {number} [opts.etaSec] Optional ETA in seconds for progress display.
 * @param {string} [opts.runId]  Optional pre-generated runId (re-use across modules that already have one).
 * @param {string[]} [opts.stages] Stage manifest — short names in pipeline
 *   order. When provided, the HUD renders horizontal pills in the task
 *   strip and lights up each one as progressTask emits matching `stage`
 *   strings. Without a manifest, the HUD falls back to a single sub-line.
 *   Stage matching is case-insensitive substring — emitted "encoding
 *   segments + overlays" matches manifest entry "encoding".
 */
/** @param {{ kind: string, label?: string, etaSec?: number, runId?: string, stages?: string[] }} opts */
export function startTask({ kind, label, etaSec, runId, stages } = /** @type {any} */ ({})) {
  if (!kind) throw new Error("startTask: kind required");
  const id = runId || newRunId(kind.replace(/[^a-z0-9]/gi, "_").slice(0, 8));
  const t = { runId: id, kind, label: label || kind, etaSec, startedAt: Date.now() };
  if (Array.isArray(stages) && stages.length) t.stages = stages.map(String);
  tasks.set(id, t);
  persistSnapshot();
  emit("task.start", { ...t });
  return id;
}

/** Update a task's progress. Pass null/undefined for fields you don't have.
 *  `stage` is a short human-readable lane label ("encoding", "compositing", etc)
 *  rendered as a sub-line under the task label in the HUD's task strip. */
/** @param {string} runId
 *  @param {{ percent?: number, label?: string, etaSec?: number, stage?: string }} [update]
 */
export function progressTask(runId, { percent, label, etaSec, stage } = {}) {
  const t = tasks.get(runId);
  if (!t) return false;
  if (label != null) t.label = label;
  if (etaSec != null) t.etaSec = etaSec;
  if (percent != null) t.percent = Math.max(0, Math.min(100, percent));
  if (stage != null) t.stage = String(stage);
  emit("task.progress", { runId, kind: t.kind, label: t.label, percent: t.percent, etaSec: t.etaSec, stage: t.stage });
  return true;
}

/** Mark a task complete. Cleans up the registry entry — followers see the final event then nothing. */
export function completeTask(runId, extras = {}) {
  const t = tasks.get(runId);
  if (!t) return false;
  const durationMs = Date.now() - t.startedAt;
  emit("task.complete", { runId, kind: t.kind, label: t.label, durationMs, ...extras });
  tasks.delete(runId);
  persistSnapshot();
  return true;
}

/** Mark a task failed. Same cleanup as complete. */
export function errorTask(runId, error, extras = {}) {
  const t = tasks.get(runId);
  if (!t) return false;
  const durationMs = Date.now() - t.startedAt;
  emit("task.error", { runId, kind: t.kind, label: t.label, error: String(error?.message || error), durationMs, ...extras });
  tasks.delete(runId);
  persistSnapshot();
  return true;
}

/* Deferred replay queue. recoverInterrupted runs at module init, well before any
 * HUD client has had a chance to reconnect over WebSocket. Broadcasting at that
 * moment goes into the void — clients miss the event and see "task that was
 * running just disappeared" with no explanation. We queue the orphan events here
 * and replay them as soon as the first client connects (server.mjs drains via
 * drainPendingReplay). The audit log records them eagerly so even a HUD that
 * never reconnects has a permanent record. */
const pendingReplay = [];

/**
 * Recover from a previous bridge run. Reads the snapshot and broadcasts a
 * synthetic task.error for every entry that was running at the time of the
 * shutdown. Call this AFTER setBroadcaster so the broadcaster is wired.
 *
 * Why broadcast errors not completes: from the operator's perspective the work
 * really IS lost — the ffmpeg child either died with the bridge or kept running
 * but the bridge can't reconcile its output. Saying "this one failed" is
 * truthful; we'd be lying to claim success.
 *
 * Optional `recordToAudit` callback: if supplied, called once per orphan so the
 * audit log preserves the interruption permanently. Wired by server.mjs to
 * Audit.record so the orphan history outlives the next bridge restart too.
 */
export function recoverInterrupted(recordToAudit) {
  if (!existsSync(SNAPSHOT_PATH)) return 0;
  let snapshot;
  try { snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")); }
  catch { return 0; }
  const orphans = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  if (!orphans.length) {
    try { unlinkSync(SNAPSHOT_PATH); } catch {}
    return 0;
  }
  for (const t of orphans) {
    const errPayload = {
      runId: t.runId,
      kind: t.kind,
      label: t.label,
      error: "interrupted by bridge restart",
      durationMs: Date.now() - (t.startedAt || Date.now()),
    };
    /* Emit immediately — picked up by any client already connected (rare at boot)
     * and by anything that hooks broadcastToClients directly (e.g. notifications.mjs
     * if it's wiring up before HUD connects). */
    emit("task.error", errPayload);
    /* Queue for replay to the first HUD that connects after recovery. */
    pendingReplay.push({ type: "task.error", runId: t.runId, ts: Date.now(), data: errPayload });
    /* Permanent audit entry so the orphan is never lost even without a connected HUD. */
    if (typeof recordToAudit === "function") {
      try { recordToAudit({ tool: t.kind || "unknown", args: { label: t.label, runId: t.runId }, error: "interrupted by bridge restart", runId: t.runId, durationMs: errPayload.durationMs }); }
      catch (e) { console.warn(`[tasks] audit record on recovery failed: ${e.message}`); }
    }
  }
  try { unlinkSync(SNAPSHOT_PATH); } catch {}
  console.log(`[tasks] recovered ${orphans.length} interrupted task${orphans.length === 1 ? "" : "s"} after restart`);
  return orphans.length;
}

/** Drain the pending-replay queue. server.mjs calls this when a fresh WebSocket
 *  connection comes in so the recovered events reach the HUD. Returns the events
 *  drained — server.mjs can re-broadcast them on the freshly-opened socket. */
export function drainPendingReplay() {
  const out = pendingReplay.slice();
  pendingReplay.length = 0;
  return out;
}

/** Snapshot of currently-running tasks. Useful for the HUD's late-join replay
 *  (so a HUD that connects mid-render still sees the task strip populated). */
export function listActive() {
  return [...tasks.values()];
}
