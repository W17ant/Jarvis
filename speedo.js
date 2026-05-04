/** speedo.js - Speedometer expressiveness controller.
 *
 *  The rev counter IS the assistant's face. This module owns the needle as the
 *  single writer, runs a per-frame loop, and exposes a mood-based API that drives
 *  the needle's emotional state moment-to-moment. The bridge already broadcasts
 *  every event we need (task.* lifecycle, conversational state); this controller
 *  translates them into needle behaviour.
 *
 *  Moods (in priority order — higher wins until exit):
 *    flick     - one-shot 200ms acknowledgement (wake word). Pops then settles.
 *    redline   - one-shot 600ms celebratory rev to 200, snap-back. Tool completion.
 *    amber     - one-shot 1500ms drop to 0 + amber blade tint. Errors / service down.
 *    speaking  - 60 + ttsLevel × 80, smoothed. Driven by voice.js TTS analyser.
 *    listening - 30 + micLevel × 30, micro-jitter. Driven by voice.js mic RMS.
 *    thinking  - climb 30 → 90 → 160 over assumed LLM latency. Holds at redline edge.
 *    task      - climbs proportional to task progress %. Background work indicator.
 *    idle      - slow sine 5–15. The "breathing" baseline.
 *
 *  Voice.js calls setMood() at state transitions and feeds setMicLevel / setTtsLevel
 *  while in those moods. flash() is for the one-shot moods (flick/redline/amber)
 *  which auto-revert to the previous baseline when their duration expires. */

import { setNeedle } from "./hud.js";

const NEEDLE_MAX = 200;

const state = {
  /* Current rendered needle value, smoothed via spring each frame. */
  current: 8,
  /* Currently-active baseline mood (idle / listening / thinking / speaking / task). */
  baseline: "idle",
  /* Optional one-shot mood override (flick / redline / amber). Null when no flash active. */
  flash: null,
  /* When the active flash should expire (Date.now() ms). */
  flashUntil: 0,
  /* Driver inputs — fed in by voice.js / task events. */
  micLevel: 0,      // 0..1 — voice listening mic RMS
  ttsLevel: 0,      // 0..1 — TTS speaking analyser amplitude
  progress: 0,      // 0..1 — current task progress
  /* Flags + accumulators for compound moods. */
  thinkingStartedAt: 0,
  /* Cached blade element for amber tint. */
  blade: null,
};

function blade() {
  if (!state.blade) state.blade = document.querySelector(".speedo__needle-blade");
  return state.blade;
}

/** Compute the target needle value for the current mood. Pure function — no I/O. */
function computeTarget(now) {
  /* One-shot flash takes priority while active. */
  if (state.flash && now < state.flashUntil) {
    const elapsed = now - (state.flashUntil - flashDuration[state.flash]);
    const t = elapsed / flashDuration[state.flash];   // 0..1 progress through the flash
    switch (state.flash) {
      case "flick":   return easeOutBack(t) * 40 + (1 - easeOutBack(t)) * state.current;
      case "redline":
        /* Quick climb to 200, hold, snap back. Two-phase: 0..0.5 climb, 0.5..1 fall. */
        return t < 0.5
          ? lerp(state.current, NEEDLE_MAX, easeOutCubic(t * 2))
          : lerp(NEEDLE_MAX, 60, easeInCubic((t - 0.5) * 2));
      case "amber":
        /* Drop fast then hold at 0. Blade tint is applied via class — see flash(). */
        return t < 0.3 ? lerp(state.current, 0, easeInCubic(t / 0.3)) : 0;
    }
  }

  /* Baseline mood targets. */
  switch (state.baseline) {
    case "listening":
      /* 30 mph base + up to 30 mph from mic level. Mic level dominates so the
       * needle visibly tracks speech intensity. */
      return 30 + state.micLevel * 30;
    case "thinking": {
      /* Climbs from current → 90 over 4s, then drifts toward 160 holding at the
       * red-zone edge until the mood changes. Suspense without ever pegging. */
      const elapsed = (now - state.thinkingStartedAt) / 1000;
      if (elapsed < 4) return lerp(30, 90, elapsed / 4);
      return lerp(90, 160, Math.min(1, (elapsed - 4) / 6));
    }
    case "speaking":
      /* TTS amplitude drives a 60–140 range — mid-band so it reads as an
       * articulate voice, not a yell. */
      return 60 + state.ttsLevel * 80;
    case "task":
      /* Linear with progress. 30 mph at start → 100 mph at 100%. Restful pacing
       * so the operator's eye doesn't snap to it during long renders. */
      return 30 + state.progress * 70;
    case "idle":
    default: {
      /* Slow sine — same "breathing" feel as the original CSS animation, but
       * driven by the same controller so it composes with everything else. */
      const phase = (now / 6000) * Math.PI * 2;       // 6s period
      return 10 + Math.sin(phase) * 5;                // 5–15 mph
    }
  }
}

/* ---------- Easings ---------- */
function lerp(a, b, t) { return a + (b - a) * t; }
function easeOutCubic(t) { const u = 1 - t; return 1 - u * u * u; }
function easeInCubic(t)  { return t * t * t; }
function easeOutBack(t)  { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); }

const flashDuration = { flick: 200, redline: 600, amber: 1500 };

/* ---------- Per-frame loop ---------- */
let rafHandle = null;
function tick() {
  const now = performance.now();
  const target = computeTarget(now);
  /* Spring: rise faster than fall so action feels responsive but settles softly.
   * Coefficients tuned to feel like a real tachometer, not a video-game gauge. */
  const k = target > state.current ? 0.22 : 0.10;
  state.current = state.current + (target - state.current) * k;
  setNeedle(state.current);

  /* Auto-clear expired flash so baseline takes back over. */
  if (state.flash && now >= state.flashUntil) {
    if (state.flash === "amber") blade()?.classList.remove("is-amber");
    state.flash = null;
  }

  rafHandle = requestAnimationFrame(tick);
}

/** Public API surface — kept tiny on purpose. */
export function setMood(mood) {
  if (!["idle", "listening", "thinking", "speaking", "task"].includes(mood)) return;
  if (mood === state.baseline) return;
  state.baseline = mood;
  if (mood === "thinking") state.thinkingStartedAt = performance.now();
}

export function setMicLevel(v) { state.micLevel = clamp01(v); }
export function setTtsLevel(v) { state.ttsLevel = clamp01(v); }
export function setProgress(v) { state.progress = clamp01(v); }

/** One-shot mood — auto-reverts after `flashDuration[name]` ms. */
export function flash(name) {
  if (!flashDuration[name]) return;
  state.flash = name;
  state.flashUntil = performance.now() + flashDuration[name];
  if (name === "amber") blade()?.classList.add("is-amber");
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Boot — start the per-frame loop. Called by the bootstrap import. Idempotent. */
export function start() {
  if (rafHandle != null) return;
  rafHandle = requestAnimationFrame(tick);
}

/** Cancel for hot-reload / tests. */
export function stop() {
  if (rafHandle != null) cancelAnimationFrame(rafHandle);
  rafHandle = null;
}
