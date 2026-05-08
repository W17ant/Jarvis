/** demo-recorder.js - Screen + audio capture for client demos.
 *
 *  Press R (no modifiers) to toggle. Captures screen video via
 *  getDisplayMedia + the existing mic stream + Kokoro TTS audio (tapped
 *  from Web Audio rather than via macOS system-audio capture, which is
 *  fiddly across versions). Combines into a single WebM file that
 *  downloads on stop.
 *
 *  Why a module: the recording-destination MediaStreamDestination is
 *  shared with TTS playback — speak() / speakStream() route the Kokoro
 *  analyser into recDestination so demos capture both sides of the
 *  conversation. Owns the lifecycle so voice.js doesn't have to.
 *
 *  Public surface:
 *    setHandlers({ getAudioCtx, getMicStream, ensureMicStream }) — wire deps
 *    ensureRecAudioMix()  — get/create the shared MediaStreamDestination
 *    tapTtsToRec(analyser) — TTS pipeline calls this when speak() starts
 *    toggleDemoRecording() — R-key handler
 *    stopDemo()            — exposed for visibilitychange / device-change
 *                            cleanup paths
 *
 *  Deps it can't compute itself:
 *    getAudioCtx()       — voice.js owns wf.audioCtx (lazy, mic-acquire
 *                          time)
 *    getMicStream()      — voice.js owns wf.micStream
 *    ensureMicStream()   — call into voice.js's wfStartListening to
 *                          guarantee a mic before recording starts
 */

let _getAudioCtx = () => null;
let _getMicStream = () => null;
let _ensureMicStream = async () => {};

let demoRec = null;
let demoStreams = [];
let demoTimerId = 0;
let demoStartTs = 0;
/* Module-scoped destination so the same mix is reused across speak() calls
 * AND TTS streams. Lazily built on first ensureRecAudioMix() / tap call. */
let recDestination = null;

/** One-shot wiring from voice.js. Idempotent. */
export function setHandlers({ getAudioCtx, getMicStream, ensureMicStream } = {}) {
  if (typeof getAudioCtx === "function") _getAudioCtx = getAudioCtx;
  if (typeof getMicStream === "function") _getMicStream = getMicStream;
  if (typeof ensureMicStream === "function") _ensureMicStream = ensureMicStream;
}

/** Get a destination that mixes mic + Kokoro output. Lazily create on first use.
 *  Returns null only if there's no audio context yet (caller should handle). */
export function ensureRecAudioMix() {
  if (recDestination) return recDestination;
  const ctx = _getAudioCtx();
  if (!ctx) return null;
  recDestination = ctx.createMediaStreamDestination();
  const mic = _getMicStream();
  if (mic) {
    try { ctx.createMediaStreamSource(mic).connect(recDestination); } catch (_) {}
  }
  return recDestination;
}

/** Tap the Kokoro speaking-analyser into the recording mix. Called by the TTS
 *  pipeline when speak() starts so demos capture both sides of the call. */
export function tapTtsToRec(analyser) {
  if (!recDestination) return;
  try { analyser.connect(recDestination); } catch (_) {}
}

/** Compatibility helper for callers that previously read recDestination
 *  directly (TTS pipeline, mic-source connect). Returns the live destination
 *  or null when not yet built. */
export function getRecDestination() {
  return recDestination;
}

export async function toggleDemoRecording() {
  if (demoRec) { stopDemo(); return; }
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,   // mix audio ourselves for reliability
    });
  } catch (e) {
    console.warn("[Jarvis] screen capture cancelled:", e.message);
    return;
  }

  await _ensureMicStream();
  ensureRecAudioMix();
  /* Re-route the existing mic source into the destination — covers the case
   * where ensureRecAudioMix ran BEFORE the mic was ready (rare but possible
   * on cold boot if TTS spoke before the operator engaged the mic). */
  const ctx = _getAudioCtx();
  const mic = _getMicStream();
  if (ctx && mic && recDestination) {
    try { ctx.createMediaStreamSource(mic).connect(recDestination); } catch (_) {}
  }

  if (!recDestination) {
    console.warn("[Jarvis] demo: no audio context — recording video only");
  }
  const audioTracks = recDestination ? recDestination.stream.getAudioTracks() : [];
  const combined = new MediaStream([
    display.getVideoTracks()[0],
    ...audioTracks,
  ]);

  demoStreams = [display];
  const chunks = [];
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm";
  demoRec = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 });
  demoRec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  demoRec.onstop = () => {
    const blob = new Blob(chunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jarvis-demo-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.webm`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    console.log(`[Jarvis] demo saved (${(blob.size / 1e6).toFixed(1)} MB)`);
  };
  /* If the operator stops sharing via the browser bar, we stop the recording
   * too — otherwise demoRec keeps running on a dead video track. */
  display.getVideoTracks()[0].addEventListener("ended", stopDemo);
  demoRec.start(1000);
  demoStartTs = Date.now();
  showRecIndicator(true);
}

export function stopDemo() {
  if (!demoRec) return;
  try { demoRec.stop(); } catch (_) {}
  demoStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  demoRec = null;
  demoStreams = [];
  showRecIndicator(false);
}

export function isRecording() {
  return demoRec != null;
}

function showRecIndicator(on) {
  const ind = document.getElementById("recIndicator");
  if (!ind) return;
  ind.hidden = !on;
  if (on) {
    if (demoTimerId) clearInterval(demoTimerId);
    demoTimerId = setInterval(() => {
      const s = Math.floor((Date.now() - demoStartTs) / 1000);
      const mm = Math.floor(s / 60);
      const ss = s % 60;
      const el = document.getElementById("recTime");
      if (el) el.textContent = `${mm}:${ss.toString().padStart(2, "0")}`;
    }, 500);
  } else if (demoTimerId) {
    clearInterval(demoTimerId);
    demoTimerId = 0;
  }
}
