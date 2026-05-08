/** tts-pipeline.js - Speak path: synthesise / stream / barge-in.
 *
 *  Three entry points:
 *    speak(text)                — one-shot; full-clip Kokoro synth → playback
 *    speakStream(query, history) — streaming LLM → sentence-level Kokoro
 *                                 queue, deferred filler, barge-in monitor
 *    cancelCurrentSpeech()       — abort the current stream / silence TTS
 *
 *  Why a module: voice.js was the only owner of speakingAnalyser /
 *  speakingBuffer / barge-in monitor / currentSpeechSession state. Pulling
 *  them out leaves voice.js free to focus on transport (mic stream,
 *  passive cycle, conversation routing). The dependency surface is large
 *  but well-bounded — all UI side-effects + the wf state object come in
 *  via setHandlers() so the dep graph stays one-way (voice.js imports
 *  this; this never imports voice.js).
 *
 *  Internal state owned here:
 *    currentSpeechSession  — handle on the in-flight stream so barge-in
 *                            and explicit cancel can find it
 *    bargeInTimer          — setInterval id for the mic-watch loop
 *    bargeInVoiceStart     — millisecond stamp of when sustained voice
 *                            crossed the threshold
 *
 *  Deps it can't compute itself (all from voice.js via setHandlers):
 *    setState, replyEl, transcript    — UI side-effects
 *    wf                                — shared waveform state (audio
 *                                       context, analyser slots, mode flag)
 *    isEngaged()                       — boolean: passive || listening,
 *                                       so barge-in only fires when the
 *                                       kiosk is actually engaged
 *    currentRms()                      — RMS reader from the mic analyser
 *    getKokoroVoice()                  — operator's preferred TTS voice
 *    bridgeOn(type, fn) / bridgeAsk(p) — WebSocket subscriptions + send
 *    getSessionId()                    — current conversation session
 *    getRecDestination()               — demo-recording mix destination
 *                                       (lookup; null when no demo active)
 *    tapTtsToRec(analyser)             — pipes Kokoro audio into the demo
 *                                       mix so client demos capture it
 */

import * as TTS from "./tts.js";

let _setState = () => {};
let _replyEl = null;
let _transcript = null;
let _wf = { mode: "idle" };
let _isEngaged = () => false;
let _currentRms = () => 0;
let _getKokoroVoice = () => "bm_daniel";
let _bridgeOn = () => () => {};
let _bridgeAsk = async () => {};
let _getSessionId = () => null;
let _getRecDestination = () => null;
let _tapTtsToRec = () => {};

/** One-shot wiring from voice.js. Idempotent. */
export function setHandlers({
  setState,
  replyEl,
  transcript,
  wf,
  isEngaged,
  currentRms,
  getKokoroVoice,
  bridgeOn,
  bridgeAsk,
  getSessionId,
  getRecDestination,
  tapTtsToRec,
} = {}) {
  if (typeof setState === "function") _setState = setState;
  if (replyEl) _replyEl = replyEl;
  if (transcript) _transcript = transcript;
  if (wf) _wf = wf;
  if (typeof isEngaged === "function") _isEngaged = isEngaged;
  if (typeof currentRms === "function") _currentRms = currentRms;
  if (typeof getKokoroVoice === "function") _getKokoroVoice = getKokoroVoice;
  if (typeof bridgeOn === "function") _bridgeOn = bridgeOn;
  if (typeof bridgeAsk === "function") _bridgeAsk = bridgeAsk;
  if (typeof getSessionId === "function") _getSessionId = getSessionId;
  if (typeof getRecDestination === "function") _getRecDestination = getRecDestination;
  if (typeof tapTtsToRec === "function") _tapTtsToRec = tapTtsToRec;
}

/** Speak using local Kokoro TTS (free, Apache 2.0). Falls back to system
 *  speechSynthesis if unreachable. Plays Kokoro WAVs via Web Audio so we
 *  can tap the buffer into the existing speaking analyser for the
 *  real-time waveform. */
export async function speak(text) {
  _setState("speaking");
  const spoken = TTS.sanitiseForTTS(text);

  /* First try Kokoro — local, free, brand-trained voice. */
  try {
    const wav = await TTS.synthesise(spoken, _getKokoroVoice());
    await playWavWithAnalyser(wav);
    _setState("idle");
    setTimeout(() => { if (_transcript) _transcript.hidden = true; }, 1800);
    return;
  } catch (e) {
    console.warn("[Jarvis] Kokoro unreachable, falling back to system TTS:", e.message);
  }

  /* Fallback path — Web Speech API. Lower fidelity but keeps the voice
   * loop alive if the Python TTS service is down. */
  await TTS.fallbackSystemTTS(spoken);
  _setState("idle");
  setTimeout(() => { if (_transcript) _transcript.hidden = true; }, 1800);
}

/* Module-level handle on the in-flight speech session. Lets barge-in code
 * abort cleanly without traversing closures — call cancelCurrentSpeech()
 * from anywhere. */
let currentSpeechSession = null;

export function cancelCurrentSpeech() {
  if (!currentSpeechSession) return;
  currentSpeechSession.cancelled = true;
  /* An unfired filler timer would otherwise enqueue a phantom sentence
   * AFTER barge-in / cancel — operator interrupts with "stop" and then
   * hears "Let me check…" 200ms later. Defensive: also harmless if filler
   * already fired. */
  if (currentSpeechSession.cancelPendingFiller) currentSpeechSession.cancelPendingFiller();
  TTS.cancelTTS();
  /* Resolve the in-flight finished promise so the caller's await
   * speakStream() unblocks and the state transition to idle happens
   * immediately. */
  if (currentSpeechSession.resolveEarly) currentSpeechSession.resolveEarly(currentSpeechSession.accumulated);
}

/** Streaming variant of speak. Driven by bridge events: askLLM → llm.sentence
 *  fires per-sentence, we enqueue each into Kokoro's TTS queue so synth
 *  starts as soon as the first sentence is ready. Returns the final
 *  assembled text once both the LLM and TTS queue have drained. */
export async function speakStream(query, history) {
  /* Stack turns: if a previous speakStream is still in flight, this call
   * waits for it before starting. Means a second query while the first is
   * still speaking queues naturally — no overlap. */
  const turn = await TTS.acquireTurn();

  _setState("speaking");
  /* Wire the streaming TTS queue's analyser into the waveform's
   * "speaking-real" path so the bottom strip pulses with the real audio
   * amplitude — same UX as the legacy playWavWithAnalyser approach. */
  const { analyser, buffer } = TTS.getSpeakingAnalyser();
  _wf.speakingAnalyser = analyser;
  _wf.speakingBuffer = buffer;
  _wf.mode = "speaking-real";
  /* If demo recording is active, route Kokoro audio into the demo mix so
   * client demos capture both sides of the conversation. */
  const _recDest = _getRecDestination();
  if (_recDest) { try { TTS.setRecordingDestination(_recDest); } catch {} }

  /* Filler phrase — randomised acknowledgement that buys time while the
   * LLM thinks. Deferred 600ms; cancelled the moment the LLM emits its
   * first sentence (so fast queries skip filler entirely). Slow queries
   * (diary / shoot / vision tasks) still hear filler. */
  const filler = TTS.pickFiller({ long: TTS.looksSlow(query) });
  const FILLER_DELAY_MS = 600;
  let fillerTimer = setTimeout(() => {
    TTS.enqueueSentence(filler, _getKokoroVoice());
  }, FILLER_DELAY_MS);
  const cancelPendingFiller = () => {
    if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
  };

  const session = { runId: null, cancelled: false, accumulated: "", resolveEarly: null, cancelPendingFiller };
  currentSpeechSession = session;

  /* Start the barge-in monitor — fires cancelCurrentSpeech() if the
   * operator's voice crosses BARGE_IN_RMS for more than
   * BARGE_IN_DURATION_MS while audio is playing. */
  startBargeInMonitor();

  /* Subscribe to streaming events. Track the runId from streamStart so a
   * stale stream's late sentences (after barge-in) don't bleed into the
   * next utterance. */
  const finished = new Promise((resolve, reject) => {
    session.resolveEarly = resolve;

    const unsubStart = _bridgeOn("llm.streamStart", (msg) => {
      if (msg.runId && !session.runId) session.runId = msg.runId;
    });
    const unsubSentence = _bridgeOn("llm.sentence", (msg) => {
      if (session.cancelled) return;
      if (session.runId && msg.runId !== session.runId) return;
      const sentence = msg.data?.text || msg.text;
      if (!sentence) return;
      /* Real reply beat the filler fuse — kill the pending filler. */
      cancelPendingFiller();
      TTS.enqueueSentence(sentence, _getKokoroVoice());
      /* Stream into the on-screen transcript so the operator sees + hears
       * in lockstep. */
      if (_replyEl) {
        const cur = _replyEl.textContent === "…" ? "" : _replyEl.textContent;
        _replyEl.textContent = cur ? `${cur} ${sentence}` : sentence;
      }
      session.accumulated = (session.accumulated ? session.accumulated + " " : "") + sentence;
    });
    const unsubDone = _bridgeOn("llm.streamDone", (msg) => {
      if (session.runId && msg.runId !== session.runId) return;
      if (session.cancelled) return;
      const finalText = msg.data?.text || msg.text || session.accumulated;
      session.accumulated = finalText;
      /* Resolve once the TTS queue actually finishes playing, not when the
       * LLM finishes generating — otherwise we transition out of "speaking"
       * while audio is still rolling. */
      if (TTS.isSpeaking()) {
        TTS.onIdle(() => resolve(finalText));
      } else {
        resolve(finalText);
      }
    });
    const unsubError = _bridgeOn("llm.streamError", (msg) => {
      if (session.runId && msg.runId !== session.runId) return;
      reject(new Error(msg.data?.error || msg.error || "stream error"));
    });

    session.unsubs = [unsubStart, unsubSentence, unsubDone, unsubError];
  });

  try {
    /* Fire the streaming request. The reply payload arrives via the
     * bridge's id-correlated reply, but we don't need to await it — events
     * drive everything. */
    _bridgeAsk({ type: "llm.askStream", payload: { query, history, sessionId: _getSessionId() } }).catch((e) => {
      console.warn("[Jarvis] askStream failed:", e.message);
      if (session.resolveEarly) session.resolveEarly(session.accumulated || "");
    });
    const text = await finished;
    _setState("idle");
    setTimeout(() => { if (_transcript) _transcript.hidden = true; }, 1800);
    return text;
  } finally {
    stopBargeInMonitor();
    if (session.unsubs) for (const u of session.unsubs) { try { u(); } catch {} }
    if (currentSpeechSession === session) currentSpeechSession = null;
    if (!TTS.isSpeaking()) {
      _wf.speakingAnalyser = null;
      _wf.speakingBuffer = null;
    }
    /* Release the turn so the next queued speakStream() can start. Always
     * runs, even on error / cancellation, so a failed turn doesn't
     * deadlock the queue. */
    turn.release();
  }
}

/* ---------- BARGE-IN ----------
 * Why: a 5-sentence reply that the operator already understood after the
 * first sentence shouldn't keep playing. While speaking, sample the mic
 * at 50ms intervals; if RMS exceeds an aggressive threshold for ~250ms
 * continuously (real speech, not just one loud spike) cancel TTS so the
 * operator can re-engage immediately. The speaker-bleed problem (no echo
 * cancellation on the kiosk) is mitigated by the threshold sitting well
 * above the typical Daniel-through-speakers RMS — only an actual nearby
 * voice crosses it sustainably. */
const BARGE_IN_RMS = 0.18;
const BARGE_IN_DURATION_MS = 250;
const BARGE_IN_TICK_MS = 50;

let bargeInTimer = null;
let bargeInVoiceStart = 0;

function startBargeInMonitor() {
  if (bargeInTimer) return;
  bargeInVoiceStart = 0;
  bargeInTimer = setInterval(() => {
    /* Only active while real audio is playing. Idle and synthetic-speaking
     * modes don't need barge-in. */
    if (_wf.mode !== "speaking-real") {
      stopBargeInMonitor();
      return;
    }
    if (!_wf.analyser || !_wf.buffer) return;     /* mic analyser not yet open */
    if (!_isEngaged()) return;                     /* operator hasn't engaged the kiosk */
    const rms = _currentRms();
    if (rms > BARGE_IN_RMS) {
      if (!bargeInVoiceStart) bargeInVoiceStart = Date.now();
      else if (Date.now() - bargeInVoiceStart >= BARGE_IN_DURATION_MS) {
        console.log(`[barge-in] sustained mic activity (rms=${rms.toFixed(3)}) — cancelling speech`);
        cancelCurrentSpeech();
        stopBargeInMonitor();
      }
    } else {
      bargeInVoiceStart = 0;
    }
  }, BARGE_IN_TICK_MS);
}

function stopBargeInMonitor() {
  if (bargeInTimer) clearInterval(bargeInTimer);
  bargeInTimer = null;
  bargeInVoiceStart = 0;
}

/** Decode a WAV ArrayBuffer, route it through the waveform analyser, and
 *  play to speakers. Resolves when playback ends so the caller can flip
 *  state. */
async function playWavWithAnalyser(wavBuffer) {
  if (!_wf.audioCtx) _wf.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_wf.audioCtx.state === "suspended") await _wf.audioCtx.resume();

  const audioBuffer = await _wf.audioCtx.decodeAudioData(wavBuffer.slice(0));
  const source = _wf.audioCtx.createBufferSource();
  source.buffer = audioBuffer;

  /* Dedicated speaking analyser so the listening one (mic) keeps its config. */
  const analyser = _wf.audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const speakBuf = new Uint8Array(analyser.fftSize);

  source.connect(analyser);
  analyser.connect(_wf.audioCtx.destination);
  /* Tap into the demo-recording mix if it's been set up. */
  _tapTtsToRec(analyser);

  /* Swap waveform mode to read from this analyser instead of synthetic. */
  _wf.speakingAnalyser = analyser;
  _wf.speakingBuffer = speakBuf;
  _wf.mode = "speaking-real";

  return new Promise((resolve) => {
    source.onended = () => {
      _wf.speakingAnalyser = null;
      _wf.speakingBuffer = null;
      resolve();
    };
    source.start(0);
  });
}
