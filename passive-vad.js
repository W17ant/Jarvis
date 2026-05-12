// @ts-check
/** passive-vad.js - VAD primitives for the passive wake-word loop.
 *
 *  Pure-math layer: read the mic analyser, maintain a rolling ambient
 *  noise estimate, and provide adaptive start/sustain thresholds for the
 *  voice-start / voice-end detectors. Doesn't own the recording or the
 *  passive cycle itself — voice.js's cyclePassive drives those because
 *  they touch handleHeard, askLLM, and conversation history (too entangled
 *  to extract cleanly without a much bigger refactor).
 *
 *  The split:
 *    voice.js                   passive-vad.js (this module)
 *    -----------                ---------------------------
 *    cyclePassive               currentRms
 *    startPassive / stopPassive pushAmbient / getAmbient
 *    transcribe + wake-check    vadThresholds
 *    handleHeard plumbing       waitForVoiceStart / waitForVoiceEnd
 *
 *  Why a module: the VAD math is the only piece of the passive loop that
 *  has no DOM / UI / history coupling. Pulling it out:
 *    - lets the thresholds be tuned in isolation (Adam can edit one file)
 *    - makes them testable (vitest can drive synthetic RMS samples)
 *    - keeps the controller (cyclePassive) focused on orchestration
 *
 *  Deps via setHandlers (only what's strictly needed for the math):
 *    getAnalyserBuf — () => ({ analyser, buffer }) | null
 *                     voice.js owns wf.analyser + wf.buffer; we read them
 *                     by reference each tick (the slots can be nulled by
 *                     devicechange / sleep recovery).
 *    isPassive      — () => boolean — caller's passive flag, used to bail
 *                     out of long waits when stopPassive() is called.
 *    isSpeaking     — () => boolean — caller's wf.mode === speaking-real
 *                     guard, so we don't record Daniel's own voice through
 *                     the speakers (no echo cancellation on the kiosk).
 */

/* ---- Constants (single source of truth for VAD tuning) ---- */
export const VAD_SILENCE_MS    = 800;    // sustained silence ends the utterance (was 1100 — operators speak in decisive bursts and 1100 felt sluggish)
export const VAD_MAX_REC_MS    = 15000;
export const VAD_TICK_MS       = 60;
export const VAD_FLOOR_MIN     = 0.005;  // hard minimums so a perfectly silent room doesn't trigger on micro-noise
export const VAD_START_MIN     = 0.014;
export const VAD_SUSTAIN_MIN   = 0.009;
export const VAD_START_RATIO   = 2.8;    // start threshold = max(MIN, ambient × this)
export const VAD_SUSTAIN_RATIO = 1.8;
export const VAD_AMBIENT_WIN   = 60;     // ~60 × VAD_TICK_MS = 3.6s rolling window
export const VAD_SHORT_VOICE_MS  = 1500; // boundary between "wake word alone" vs "wake + question"
export const VAD_SHORT_SILENCE_MS = 450; // snappy trigger when voice was short (was 600)

/* ---- Injected handlers ---- */
let _getAnalyserBuf = () => null;
let _isPassive = () => false;
let _isSpeaking = () => false;

/** @param {object} [deps]
 *  @param {() => ({ analyser: AnalyserNode, buffer: Uint8Array } | null)} [deps.getAnalyserBuf]
 *  @param {() => boolean} [deps.isPassive]
 *  @param {() => boolean} [deps.isSpeaking]
 */
export function setHandlers({ getAnalyserBuf, isPassive, isSpeaking } = {}) {
  if (typeof getAnalyserBuf === "function") _getAnalyserBuf = getAnalyserBuf;
  if (typeof isPassive === "function") _isPassive = isPassive;
  if (typeof isSpeaking === "function") _isSpeaking = isSpeaking;
}

/* ---- Rolling ambient noise estimator ---- */
const ambientWindow = [];

export function pushAmbient(rms) {
  ambientWindow.push(rms);
  if (ambientWindow.length > VAD_AMBIENT_WIN) ambientWindow.shift();
}

/** 60th-percentile of the rolling window — robust to brief voice spikes
 *  that might have leaked into the ambient samples. */
export function getAmbient() {
  if (ambientWindow.length < 10) return VAD_FLOOR_MIN;
  const sorted = [...ambientWindow].sort((a, b) => a - b);
  return Math.max(VAD_FLOOR_MIN, sorted[Math.floor(sorted.length * 0.6)]);
}

/** Adaptive start + sustain thresholds derived from the rolling ambient.
 *  Called every VAD tick — micro-cheap (sort of 60 floats). */
export function vadThresholds() {
  const a = getAmbient();
  return {
    start:   Math.max(VAD_START_MIN,   a * VAD_START_RATIO),
    sustain: Math.max(VAD_SUSTAIN_MIN, a * VAD_SUSTAIN_RATIO),
    ambient: a,
  };
}

/** Read live RMS from the mic analyser. Returns 0..1. Robust to the
 *  analyser being null (devicechange / sleep) — returns 0 in that case
 *  so callers see "ambient silence" rather than crashing. */
export function currentRms() {
  const ab = _getAnalyserBuf();
  if (!ab || !ab.analyser || !ab.buffer) return 0;
  ab.analyser.getByteTimeDomainData(ab.buffer);
  let sumSq = 0;
  for (let i = 0; i < ab.buffer.length; i++) {
    const v = (ab.buffer[i] - 128) / 128;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / ab.buffer.length);
}

/** Wait until RMS rises above the adaptive start threshold. While
 *  waiting, every sample feeds the rolling ambient estimate (since by
 *  definition no voice is present yet).
 *
 *  Why the speaking-guard: the kiosk has no echo cancellation, so when
 *  Daniel's voice plays back through speakers the mic picks it up and
 *  VAD treats it as a fresh utterance. That led to spurious passive
 *  recordings that competed for the AudioContext mid-speech, which the
 *  operator perceived as Daniel's replies "cutting off". We just hold
 *  here until the speaking flag clears, then resume normal listening. */
export function waitForVoiceStart() {
  return new Promise((resolve) => {
    const tick = () => {
      if (!_isPassive()) return resolve(false);
      /* Hold while Daniel is speaking — don't record his own voice. */
      if (_isSpeaking()) {
        setTimeout(tick, 200);
        return;
      }
      const rms = currentRms();
      const { start } = vadThresholds();
      if (rms > start) return resolve(true);
      pushAmbient(rms);   // nothing-but-ambient samples train the noise floor
      setTimeout(tick, VAD_TICK_MS);
    };
    tick();
  });
}

/** Wait until silence ends the utterance, with adaptive threshold:
 *    - Short utterances (< 1.5s of voice): assume bare wake word, trigger
 *      after 600ms silence (snappy ack)
 *    - Longer queries: require full 1100ms (tolerates natural mid-sentence
 *      pauses) */
export function waitForVoiceEnd() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let lastVoiceAt = Date.now();
    let voiceMs = 0;
    const tick = () => {
      if (!_isPassive()) return resolve("aborted");
      const elapsed = Date.now() - startedAt;
      if (elapsed > VAD_MAX_REC_MS) return resolve("max");
      const rms = currentRms();
      const { sustain } = vadThresholds();
      if (rms > sustain) {
        lastVoiceAt = Date.now();
        voiceMs += VAD_TICK_MS;
      }
      const silenceThreshold = voiceMs < VAD_SHORT_VOICE_MS ? VAD_SHORT_SILENCE_MS : VAD_SILENCE_MS;
      if (Date.now() - lastVoiceAt > silenceThreshold) {
        return resolve(voiceMs < VAD_SHORT_VOICE_MS ? "short-silence" : "silence");
      }
      setTimeout(tick, VAD_TICK_MS);
    };
    tick();
  });
}
