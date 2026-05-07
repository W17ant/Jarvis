/** tasks.js - Task progress strip for in-flight bridge work.
 *
 *  Listens for bridge task lifecycle events (task.start / task.progress / task.complete /
 *  task.error) on the existing voiceWS connection. Maintains a Map<runId, Task> and
 *  renders one row per active task into #taskStrip. When the map empties, the strip
 *  hides so the bottom telemetry strip's waveform reads as the idle state.
 *
 *  This module is intentionally headless about the WebSocket — voice.js owns the socket
 *  and dispatches relevant messages here via Tasks.handleEvent(). Keeps both files
 *  testable in isolation and prevents two modules fighting over connection state. */

const tasks = new Map(); // runId → { runId, kind, label, percent?, etaSec?, startedAt, status }

let stripEl = null;
let waveformEl = null;

/** Get a stable reference to the strip + waveform on first call. */
function el() {
  if (!stripEl) stripEl = document.getElementById("taskStrip");
  if (!waveformEl) waveformEl = document.getElementById("waveform");
  return stripEl;
}

/** Format seconds remaining as a compact mm:ss string. */
function fmtEta(sec) {
  if (sec == null || !isFinite(sec) || sec < 0) return "";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Build the friendly label per kind so the LLM doesn't need to send display text. */
function kindBadge(kind) {
  const map = {
    "video.edit":   "RENDER",
    "yt.short":     "RENDER",
    "yt.promo":     "PROMO",
    "yt.thumbnail": "THUMB",
    "shoot.report": "REPORT",
    "watermark":    "WATERMARK",
    "outreach":     "OUTREACH",
    "pdf":          "PDF",
  };
  return map[kind] || kind.toUpperCase().replace(/\./g, " ");
}

/** Re-paint the strip from the current map. Hides when empty. */
function render() {
  const host = el();
  if (!host) return;
  if (tasks.size === 0) {
    host.hidden = true;
    while (host.firstChild) host.removeChild(host.firstChild);
    /* When idle, restore the waveform's full opacity so the strip looks "asleep". */
    if (waveformEl) waveformEl.classList.remove("waveform--dim");
    return;
  }
  host.hidden = false;
  if (waveformEl) waveformEl.classList.add("waveform--dim");
  while (host.firstChild) host.removeChild(host.firstChild);
  /* STOP-all button — visible whenever the strip is. POST /cancel hits every
   * abort-aware module (Vision / Browse / Crew). Per-task cancel isn't here
   * yet because /cancel is global on the bridge — wiring per-runId would need
   * each long-running module to track its own runId-keyed abort flag. */
  host.appendChild(buildStopButton());
  /* Newest task first — most operators care about the thing they just kicked off. */
  const ordered = [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
  for (const t of ordered) host.appendChild(buildRow(t));
}

/** Build the single "STOP ALL" pill that sits above the rows. */
function buildStopButton() {
  const li = document.createElement("li");
  li.className = "tasks__stop-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tasks__stop-btn";
  /* Why: Esc also cancels (handled in voice.js). Keeping the title brief so
   * operators across the room read just "STOP" — the keyboard shortcut hint
   * goes in the title attribute for hover-discoverability. */
  btn.textContent = `STOP · ${tasks.size}`;
  btn.title = `Stop ${tasks.size === 1 ? "the active task" : "all active tasks"} (Esc)`;
  btn.addEventListener("click", cancelAll);
  li.appendChild(btn);
  return li;
}

/** POST /cancel and optimistically tint every row "is-cancelling". The actual
 *  task.error events from the bridge clean rows up at the next safe checkpoint. */
async function cancelAll() {
  /* Visual feedback first — operator gets immediate confirmation the click
   * was registered, even before the network round-trip. */
  for (const t of tasks.values()) t.status = "cancelling";
  render();
  try {
    await fetch("http://localhost:8766/cancel", { method: "POST" });
  } catch (e) {
    console.warn("[tasks] /cancel failed:", e.message);
  }
}

/** POST /cancel?runId=<id> for a single task. Optimistically marks just that
 *  row "is-cancelling" — siblings keep running. */
async function cancelOne(runId) {
  const t = tasks.get(runId);
  if (t) { t.status = "cancelling"; render(); }
  try {
    await fetch(`http://localhost:8766/cancel?runId=${encodeURIComponent(runId)}`, { method: "POST" });
  } catch (e) {
    console.warn(`[tasks] /cancel?runId=${runId} failed:`, e.message);
  }
}

function buildRow(t) {
  const li = document.createElement("li");
  li.className = "tasks__row";
  li.dataset.runId = t.runId;
  if (t.status === "error") li.classList.add("is-error");
  if (t.status === "cancelling") li.classList.add("is-cancelling");
  if (t.stage) li.classList.add("tasks__row--with-stage");
  if (Array.isArray(t.stages) && t.stages.length) li.classList.add("tasks__row--with-lanes");

  const badge = document.createElement("span");
  badge.className = "tasks__kind";
  badge.textContent = kindBadge(t.kind);
  li.appendChild(badge);

  const labelWrap = document.createElement("span");
  labelWrap.className = "tasks__label-wrap";
  const label = document.createElement("span");
  label.className = "tasks__label";
  label.textContent = t.label || t.kind;
  labelWrap.appendChild(label);
  /* Two presentations of pipeline progress, in priority order:
   *
   * 1. Lane-grouped pipeline pills (preferred) — when task.start carried
   *    a `stages` manifest. Renders one pill per stage, lights up the
   *    matching one when task.progress emits `stage`. Operator (and
   *    clients during demos) see the whole pipeline + where it is.
   *    Substring match is case-insensitive and intentionally loose so
   *    the bridge can emit "encoding segments + overlays" against a
   *    manifest entry of "encoding".
   *
   * 2. Single stage sub-line (fallback) — when the bridge emits a
   *    stage but didn't declare a manifest. Same UX as before this
   *    feature shipped. */
  if (Array.isArray(t.stages) && t.stages.length) {
    const lanes = document.createElement("div");
    lanes.className = "tasks__lanes";
    const activeLower = (t.stage || "").toLowerCase();
    let activeIdx = -1;
    /* First pass — find the active stage so we can paint past stages
     * complete + future ones dim. */
    if (activeLower) {
      activeIdx = t.stages.findIndex((s) =>
        activeLower.includes(s.toLowerCase()) || s.toLowerCase().includes(activeLower)
      );
    }
    for (let i = 0; i < t.stages.length; i++) {
      const pill = document.createElement("span");
      pill.className = "tasks__lane";
      if (activeIdx >= 0 && i < activeIdx) pill.classList.add("is-done");
      else if (i === activeIdx) pill.classList.add("is-active");
      pill.textContent = t.stages[i];
      lanes.appendChild(pill);
    }
    labelWrap.appendChild(lanes);
  } else if (t.stage) {
    const stage = document.createElement("span");
    stage.className = "tasks__stage";
    stage.textContent = t.stage;
    labelWrap.appendChild(stage);
  }
  li.appendChild(labelWrap);

  const meta = document.createElement("span");
  meta.className = "tasks__meta";
  if (t.status === "error") {
    meta.textContent = "FAILED";
  } else if (t.status === "cancelling") {
    meta.textContent = "STOPPING";
  } else if (t.percent != null) {
    meta.textContent = `${Math.round(t.percent)}%`;
  } else {
    /* Compute remaining ETA from elapsed time so the readout counts down even
     * without progress events. Falls back to "—" if no etaSec was given. */
    const elapsedSec = (Date.now() - t.startedAt) / 1000;
    const remaining = t.etaSec != null ? Math.max(0, t.etaSec - elapsedSec) : null;
    meta.textContent = remaining != null ? fmtEta(remaining) : "RUNNING";
  }
  li.appendChild(meta);

  /* Per-row × button. Hidden during cancelling/error/complete (only fires
   * on running tasks). POSTs /cancel?runId=<id> so siblings keep running. */
  if (t.status === "running") {
    const xBtn = document.createElement("button");
    xBtn.type = "button";
    xBtn.className = "tasks__row-cancel";
    xBtn.textContent = "✕";
    xBtn.title = `Stop this task only (${t.runId.slice(0, 12)}…)`;
    xBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cancelOne(t.runId);
    });
    li.appendChild(xBtn);
  }

  /* Progress bar — width animated from percent. If no percent yet, show indeterminate
   * bar that pulses across (CSS-driven) so the operator knows it's not stuck. */
  const bar = document.createElement("div");
  bar.className = "tasks__bar";
  if (t.percent != null) {
    bar.classList.add("tasks__bar--determinate");
    const fill = document.createElement("div");
    fill.className = "tasks__bar-fill";
    fill.style.width = `${Math.max(2, Math.min(100, t.percent))}%`;
    bar.appendChild(fill);
  } else {
    bar.classList.add("tasks__bar--indeterminate");
  }
  li.appendChild(bar);

  return li;
}

/* Periodic re-render so the ETA counter ticks down without progress events. */
let tickHandle = null;
function ensureTicking() {
  if (tickHandle != null) return;
  tickHandle = setInterval(() => {
    if (tasks.size === 0) {
      clearInterval(tickHandle); tickHandle = null;
      return;
    }
    render();
  }, 1000);
}

/** Public: dispatch a single task.* event from voice.js's WS handler. */
export function handleEvent(msg) {
  if (!msg || !msg.type || !msg.data) return;
  const d = msg.data;
  if (!d.runId) return;
  switch (msg.type) {
    case "task.start": {
      tasks.set(d.runId, {
        runId: d.runId,
        kind: d.kind || "task",
        label: d.label || d.kind || "Working…",
        etaSec: d.etaSec,
        /* Stage manifest from the bridge — drives lane-grouped pipeline
         * pills in buildRow. Optional; tasks without a manifest fall back
         * to a single stage sub-line as before. */
        stages: Array.isArray(d.stages) ? d.stages.slice() : null,
        startedAt: msg.ts || Date.now(),
        status: "running",
      });
      render();
      ensureTicking();
      break;
    }
    case "task.progress": {
      const t = tasks.get(d.runId);
      if (!t) return;
      if (d.label != null) t.label = d.label;
      if (d.percent != null) t.percent = d.percent;
      if (d.etaSec != null) t.etaSec = d.etaSec;
      if (d.stage != null) t.stage = d.stage;
      render();
      break;
    }
    case "task.complete": {
      /* Why: leave the row visible briefly with a 100% bar so the operator can read
       * "done" before it disappears. 1.5s is the sweet spot per UX research. */
      const t = tasks.get(d.runId);
      if (!t) return;
      t.percent = 100;
      t.status = "complete";
      render();
      setTimeout(() => { tasks.delete(d.runId); render(); }, 1500);
      break;
    }
    case "task.error": {
      const t = tasks.get(d.runId);
      if (!t) return;
      t.status = "error";
      t.label = `${t.label} — ${d.error || "failed"}`.slice(0, 120);
      render();
      /* Errors linger longer (4s) so the operator catches them before the row vanishes. */
      setTimeout(() => { tasks.delete(d.runId); render(); }, 4000);
      break;
    }
  }
}

/** Test harness — drive a fake task lifecycle from the dev console for layout iteration. */
export function _devSimulate() {
  const runId = `dev_${Date.now()}`;
  /* Stage manifest matches bridge/edit.mjs's TEASER_STAGES so the dev
   * sim exercises the same lane-pill rendering path real renders use. */
  const stages = ["scanning", "planning", "intro + outro", "encoding", "finalising"];
  handleEvent({ type: "task.start", ts: Date.now(), data: { runId, kind: "video.edit", label: "the press car teaser · 30s · 9:16", etaSec: 12, stages } });
  let p = 0;
  const tick = setInterval(() => {
    p += 12;
    if (p >= 100) {
      clearInterval(tick);
      handleEvent({ type: "task.complete", ts: Date.now(), data: { runId } });
    } else {
      /* Walk through the stages in proportion to percent so the active
       * pill advances through the manifest as the bar fills. */
      const stageIdx = Math.min(stages.length - 1, Math.floor((p / 100) * stages.length));
      handleEvent({
        type: "task.progress",
        ts: Date.now(),
        data: { runId, percent: p, etaSec: 12 - (p / 100) * 12, stage: stages[stageIdx] },
      });
    }
  }, 1000);
}
window._taskSim = _devSimulate;  // dev-console handle
