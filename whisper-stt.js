/** whisper-stt.js - Speech-to-text orchestration.
 *
 *  Pulled out of voice.js. Owns:
 *    - the cumulative audio chunks captured during recording
 *    - the speculative mid-utterance partial transcribe (Tier-2 latency win)
 *    - transcribeAndHandle: the full path from "stop recording" to either
 *      using the partial fast-path or running a final transcribe, then
 *      handing off to handleHeard.
 *
 *  Why a module: this logic is tangled with voice.js's MediaRecorder
 *  closure but doesn't actually share state with the rest of voice.js's
 *  loop — it just needs callbacks for the UI side-effects (setState,
 *  replyEl.textContent, speak, handleHeard, dbgSet) and the AudioContext
 *  for the local peak-amplitude diagnostic. Deps come in via
 *  setHandlers() so the dependency graph stays one-way (voice.js imports
 *  this; this never imports voice.js).
 *
 *  Public surface:
 *    setHandlers({ setState, replyEl, transcript, speak, handleHeard,
 *                  dbgSet, getAudioCtx })   — wire callbacks once at boot
 *    pushChunk(blob)                         — append a MediaRecorder chunk;
 *                                              fires the speculative partial
 *                                              when chunkCount === 6
 *    chunkCount()                            — for debug/UI
 *    resetForNewTurn()                       — call at start of recording
 *    transcribeAndHandle()                   — call when MediaRecorder.onstop
 *
 *  The 6-chunk threshold matches MediaRecorder's 250ms timeslice (250 × 6
 *  = 1500ms of audio) — a sweet spot where there's enough audio for
 *  Whisper to produce meaningful text but the operator's typical short
 *  query has ≤1s of speech still to come.
 */

const WHISPER_URL = "http://localhost:8768/transcribe";

/* ---- Recording chunks ---- */
let _audioChunks = [];
let _totalBytes = 0;

/* ---- Speculative-partial state ---- */
let _inflightPartial = null;          // Promise<string>
let _latestPartialText = "";
let _partialFiredAtChunkCount = 0;

/* ---- UI / orchestration callbacks (injected) ---- */
let _setState = () => {};
let _replyEl = null;
let _transcript = null;
let _speak = () => {};
let _handleHeard = () => {};
let _dbgSet = () => {};
let _getAudioCtx = () => null;

/** One-shot wiring from voice.js. Pass the cross-module deps. Idempotent. */
export function setHandlers({
  setState,
  replyEl,
  transcript,
  speak,
  handleHeard,
  dbgSet,
  getAudioCtx,
} = {}) {
  if (typeof setState === "function") _setState = setState;
  if (replyEl) _replyEl = replyEl;
  if (transcript) _transcript = transcript;
  if (typeof speak === "function") _speak = speak;
  if (typeof handleHeard === "function") _handleHeard = handleHeard;
  if (typeof dbgSet === "function") _dbgSet = dbgSet;
  if (typeof getAudioCtx === "function") _getAudioCtx = getAudioCtx;
}

/** Reset module state at the start of a new recording. Without this, last
 *  turn's stale partial text could leak into this turn's transcribe path. */
export function resetForNewTurn() {
  _audioChunks = [];
  _totalBytes = 0;
  _inflightPartial = null;
  _latestPartialText = "";
  _partialFiredAtChunkCount = 0;
}

export function chunkCount() { return _audioChunks.length; }

/** Append a MediaRecorder chunk. On the 6th chunk (~1.5s of recorded
 *  audio), fires a speculative whisper transcribe in parallel — runs
 *  while the operator keeps speaking; if silence-detect arrives soon
 *  after AND the partial captured most of the utterance, transcribeAndHandle
 *  uses the partial directly and skips the final transcribe (~450ms saved). */
export function pushChunk(chunk) {
  if (!chunk || chunk.size === 0) return;
  _audioChunks.push(chunk);
  _totalBytes += chunk.size;
  _dbgSet("chunks", `${_audioChunks.length} (${(_totalBytes / 1024).toFixed(1)} KB)`);

  if (_audioChunks.length === 6 && !_inflightPartial) {
    _partialFiredAtChunkCount = _audioChunks.length;
    const speculativeBlob = new Blob([..._audioChunks], { type: chunk.type || "audio/webm" });
    const t0 = Date.now();
    _inflightPartial = fetch(WHISPER_URL, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: speculativeBlob,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        _latestPartialText = (j?.text || "").trim();
        console.log(`[Flat-Out] partial transcribe (${Date.now() - t0}ms): "${_latestPartialText}"`);
        return _latestPartialText;
      })
      .catch((e) => { console.warn("[Flat-Out] partial transcribe failed:", e.message); return ""; });
  }
}

/** POST the captured audio to local Whisper, run handleHeard if transcribed.
 *  Honours the speculative-partial fast path described above. */
export async function transcribeAndHandle() {
  if (_audioChunks.length === 0) {
    _dbgSet("upload", "0 bytes — no chunks");
    _setState("idle");
    return;
  }
  /* Capture chunk count BEFORE clearing — used by the partial-trust heuristic. */
  const finalChunkCount = _audioChunks.length;
  const blob = new Blob(_audioChunks, { type: _audioChunks[0].type || "audio/webm" });
  _audioChunks = [];
  _totalBytes = 0;
  _dbgSet("upload", `${(blob.size / 1024).toFixed(1)} KB ${blob.type}`);

  /* Local peak-amplitude diagnostic — proves whether the captured audio is silent. */
  try {
    const ab = await blob.arrayBuffer();
    const ctx = _getAudioCtx();
    if (ctx) {
      const decoded = await ctx.decodeAudioData(ab.slice(0));
      const ch = decoded.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < ch.length; i += 64) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
      _dbgSet("peak", `${peak.toFixed(4)} (${decoded.duration.toFixed(2)}s)`);
    }
  } catch (e) {
    _dbgSet("peak", `decode err: ${e.message}`);
  }

  _setState("thinking");
  if (_replyEl) _replyEl.textContent = "Transcribing…";
  if (_transcript) _transcript.hidden = false;

  /* Speculative-partial fast path — if a mid-utterance partial fired AND
   * silence-detect arrived within ~1s of it (≤4 more 250ms chunks), the
   * partial captured ~all of the utterance. Use it; skip final transcribe. */
  const partialPromise = _inflightPartial;
  const firedAt = _partialFiredAtChunkCount;
  const PARTIAL_TAIL_TOLERANCE = 4;       // ≤4 chunks ≈ ≤1s after partial fired
  const PARTIAL_MIN_TEXT_LEN = 4;         // below this, treat partial as unreliable
  let heard = "";
  if (partialPromise && firedAt > 0 && (finalChunkCount - firedAt) <= PARTIAL_TAIL_TOLERANCE) {
    const partialText = await partialPromise;
    if (partialText && partialText.length >= PARTIAL_MIN_TEXT_LEN) {
      heard = partialText;
      console.log(`[Flat-Out] using speculative partial — skipped final transcribe (chunk delta: ${finalChunkCount - firedAt})`);
      _dbgSet("whisper", `"${heard}" (partial)`);
    }
  }

  /* Reset speculative state regardless of path taken. */
  _inflightPartial = null;
  _latestPartialText = "";
  _partialFiredAtChunkCount = 0;

  if (!heard) {
    try {
      const res = await fetch(WHISPER_URL, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: blob,
      });
      if (!res.ok) throw new Error(`whisper ${res.status}`);
      const { text } = await res.json();
      heard = (text || "").trim();
      console.log("[Flat-Out] whisper:", heard);
      _dbgSet("whisper", heard ? `"${heard}"` : "(empty)");
    } catch (e) {
      console.warn("[Flat-Out] transcribe failed:", e.message);
      _dbgSet("error", `whisper: ${e.message}`);
      _setState("idle");
      if (_replyEl) _replyEl.textContent = "Whisper isn't reachable. Check the bridge logs.";
      _speak("Whisper isn't reachable.");
      return;
    }
  }

  if (!heard) {
    _setState("idle");
    if (_replyEl) _replyEl.textContent = "I didn't catch that.";
    _speak("I didn't catch that.");
    return;
  }
  _handleHeard(heard, true);
}
