/** tts.js - Kokoro TTS client + text sanitiser + system-TTS fallback.
 *
 *  Why: voice.js bundled HTTP, sanitiser regex, audio decoding, system-TTS fallback,
 *  AND state orchestration into one ~100-line speak() function. This module owns the
 *  pure synthesis path (text in → audio out / utterance scheduled). voice.js keeps
 *  the orchestration — setState, the speaking analyser tap, transcript visibility —
 *  because those touch HUD-wide state the TTS layer shouldn't reach into.
 *
 *  Exports:
 *    sanitiseForTTS(text)      - clean markdown/symbols so the voice doesn't read them aloud
 *    synthesise(text, voice)   - POST /tts → ArrayBuffer of WAV bytes
 *    fallbackSystemTTS(...)    - Web Speech API with British-voice preference */

const KOKORO_URL = "http://localhost:8767/tts";

/**
 * Clean a string for TTS so Daniel doesn't read "**bold**" as "asterisk asterisk".
 * Strips markdown syntax + transforms common automotive shorthand to spoken form.
 * The on-screen transcript can still show markdown — this only affects audio.
 */
export function sanitiseForTTS(text) {
  if (!text) return "";
  let s = String(text);

  /* Why: strip markdown emphasis (**, __, *, _, ~~) without nuking words inside them.
   * Each rule preserves the inner content and drops only the markers. */
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/__([^_]+)__/g, "$1");
  s = s.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "$1");
  s = s.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1");
  s = s.replace(/~~([^~]+)~~/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");

  /* Inline code-block fences and bullet markers — drop entirely. */
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/^[\s>]*[-*+]\s+/gm, "");
  s = s.replace(/^\s*#{1,6}\s+/gm, "");

  /* Markdown links [text](url) — keep just the text. */
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  /* Bare URLs — say "link" instead of spelling out characters. */
  s = s.replace(/https?:\/\/\S+/g, "link");

  /* Common spoken-friendly substitutions for symbols + ratio/range patterns. */
  s = s.replace(/0-60\s*mph/gi, "zero to sixty miles per hour");
  s = s.replace(/0-60/g, "zero to sixty");
  s = s.replace(/(\d+):(\d+)(?!\d)/g, (m, a, b) => {
    /* 16:9 → "sixteen by nine"; 14:30 looks like a time so leave numeric.
     * Require BOTH parts to be 2 digits for time interpretation — otherwise
     * "16:9" gets misclassified as a time and passes through unread. */
    if (Number(a) <= 23 && Number(b) <= 59 && a.length === 2 && b.length === 2) return m;
    return `${a} by ${b}`;
  });
  s = s.replace(/—|–/g, ", ");        // em + en dash → comma pause
  s = s.replace(/·|•/g, ", ");        // middle dot, bullet → comma pause
  s = s.replace(/\s\/\s/g, " or ");   // " / " separators → "or"
  s = s.replace(/&/g, " and ");
  s = s.replace(/%/g, " percent");
  s = s.replace(/[#@]/g, "");
  s = s.replace(/[<>{}|^~`]/g, "");   // assorted programming punctuation

  /* Why: strip emoji + decorative symbols that the TTS would either skip or read by
   * code-point name. Modern Unicode property escape \p{Extended_Pictographic} covers
   * every emoji range cleanly. The previous hand-rolled character class included a
   * mis-encoded range "0-ᾟ" that silently wiped ASCII letters and digits — caught
   * during the tts.js extraction. */
  s = s.replace(/\p{Extended_Pictographic}/gu, "");

  /* Compact whitespace. */
  s = s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, ". ").replace(/\.{2,}/g, ".").trim();

  return s;
}

/**
 * Synthesise speech via Kokoro. Returns the WAV bytes; caller decodes and plays.
 *
 * @param {string} text     Already-sanitised text (call sanitiseForTTS first).
 * @param {string} voice    Voice id (e.g. "bm_daniel"). See settings modal for the catalog.
 * @returns {Promise<ArrayBuffer>}
 * @throws on network failure or non-2xx response — caller should catch and trigger fallback.
 */
export async function synthesise(text, voice) {
  const res = await fetch(KOKORO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw new Error(`kokoro ${res.status}`);
  return res.arrayBuffer();
}

/* ---------- FILLER PHRASES ----------
 *  Why: there's a 1-2s gap between the operator finishing their query and the
 *  first streamed sentence arriving (LLM thinking time + first-token latency).
 *  Without filler, the kiosk feels dead during that beat — operators end up
 *  asking again. A short randomised acknowledgement spoken IMMEDIATELY puts
 *  audio in the operator's ear within ~200ms, so the kiosk feels responsive
 *  even when the model is still composing. The filler enters the same TTS
 *  queue as the streamed sentences, so the streamed reply naturally plays
 *  AFTER the filler finishes — no overlap, no interruption logic needed.  */
/* Two pools: short fillers for snappy queries, long fillers when the LLM is
 * likely to take its time (tool calls, vision passes, anything that hits
 * AppleScript). The caller picks the pool via pickFiller(longHint). Keeping
 * each filler under ~12 words so it doesn't run past the LLM's first sentence. */
const FILLERS_SHORT = [
  "On it, sir.",
  "Right away.",
  "Working on it.",
  "One moment.",
  "Coming up.",
  "Just a sec.",
];

const FILLERS_LONG = [
  "Let me check that for you, sir, just a moment.",
  "Right, give me a few seconds to dig that out.",
  "Looking into that for you now, sir, won't be a moment.",
  "On it — pulling that together for you now.",
  "One second, sir, let me have a proper look.",
  "Working on it, sir — just a moment to gather everything.",
  "Right you are, let me see what we've got.",
  "Hold tight, I'll have something for you in a moment.",
];

/** Pick a random filler. Excludes the most-recent one so back-to-back queries
 *  don't repeat — small touch but meaningfully reduces the "canned" feel.
 *
 *  @param {object} [opts]
 *  @param {boolean} [opts.long]  prefer the longer pool — useful when the query
 *                                contains keywords that imply a slow tool hop
 *                                (calendar / mail / diary / shoot / render). */
let lastFiller = "";
export function pickFiller({ long = false } = {}) {
  const pool = long ? FILLERS_LONG : FILLERS_SHORT;
  let pick;
  do { pick = pool[Math.floor(Math.random() * pool.length)]; }
  while (pool.length > 1 && pick === lastFiller);
  lastFiller = pick;
  return pick;
}

/** Heuristic: do we expect this query to take more than ~2s of bridge work?
 *  Long queries trigger the longer filler pool so the operator hears something
 *  substantive while the LLM + tool calls run, instead of a 1-second filler
 *  followed by 5 seconds of silence. */
const SLOW_TRIGGERS = /\b(diary|calendar|mail|email|inbox|frame.?io|render|teaser|edit|brand pack|shoot|caption|press|media day|preset|lightroom|premiere)\b/i;
export function looksSlow(query) {
  return SLOW_TRIGGERS.test(String(query || ""));
}

/* ---------- TURN STACKING ----------
 *  Promise chain that serialises voice turns. A new speakStream() call awaits
 *  this before starting, then replaces it with its own finished-promise so the
 *  NEXT call waits on it. Result: if the operator fires a second query while
 *  the first is still speaking, the second query's TTS queues behind the first
 *  rather than speaking over it. The chain auto-resets when idle (resolved
 *  promises let new callers fall through immediately).  */
let turnChain = Promise.resolve();

/** Acquire the next turn. Returns { release } — caller MUST call release() when
 *  its turn is fully complete (TTS drained, state transitioned to idle).
 *  If multiple speakStreams race, they queue in arrival order. */
export async function acquireTurn() {
  const previous = turnChain;
  let releaseFn;
  const myTurn = new Promise((resolve) => { releaseFn = resolve; });
  turnChain = myTurn;
  await previous;
  return { release: () => releaseFn() };
}

/* ---------- SENTENCE QUEUE (streaming TTS) ----------
 * Why: when the LLM streams its reply, we want each completed sentence to start
 * playing as soon as it's ready — without waiting for the whole reply to finish.
 * The queue serialises Kokoro requests + audio playback so sentence N+1 starts
 * exactly when sentence N's audio ends. cancelTTS() drops everything immediately
 * (used for barge-in).
 *
 * The queue owns its own AudioContext and an analyser that callers can tap for
 * the speaking-state waveform — same as the legacy playWavWithAnalyser path. */
const queue = {
  audioCtx: null,         /* shared AudioContext across queued sentences */
  analyser: null,         /* destination analyser (caller can read for waveform) */
  buf: null,              /* pre-allocated byte buffer for analyser reads */
  current: null,          /* in-flight AudioBufferSourceNode, null when idle */
  pending: [],            /* { text, voice } items not yet synthesised */
  synthesising: false,    /* true while a fetch /tts is in flight */
  generation: 0,          /* incremented by cancelTTS() to invalidate in-flight work */
  onIdleHandlers: [],     /* fired when both pending list and current source drain */
  recDestination: null,   /* optional MediaStreamAudioDestinationNode for demo recording */
};

/** Get (lazy-init) the queue's AudioContext + analyser. Called whenever the first
 *  sentence enters an empty queue. The analyser is exposed so voice.js can pipe it
 *  into its waveform draw loop without allocating a separate node. */
function ensureAudioPath() {
  if (!queue.audioCtx) {
    queue.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (queue.audioCtx.state === "suspended") queue.audioCtx.resume().catch(() => {});
  if (!queue.analyser) {
    queue.analyser = queue.audioCtx.createAnalyser();
    queue.analyser.fftSize = 1024;
    queue.buf = new Uint8Array(queue.analyser.fftSize);
    queue.analyser.connect(queue.audioCtx.destination);
  }
  return queue;
}

/** Tap the queue's analyser for the speaking waveform. Returns the same buffer
 *  reference every call — the analyser writes into it on every getByteTimeDomainData(). */
export function getSpeakingAnalyser() {
  ensureAudioPath();
  return { analyser: queue.analyser, buffer: queue.buf };
}

/** Wire a MediaStreamAudioDestinationNode for demo-mode recording. The queue will
 *  also pipe sentence playback into this destination so the recorder captures TTS. */
export function setRecordingDestination(node) { queue.recDestination = node || null; }

/** Internal: drain the queue. Pulls the next pending item, fetches its WAV from
 *  Kokoro, decodes, plays through the analyser, and recurses on `onended`. */
async function drain() {
  if (queue.synthesising) return;
  if (queue.current) return;             /* still playing previous sentence */
  if (queue.pending.length === 0) {
    fireIdle();
    return;
  }
  const gen = queue.generation;
  const next = queue.pending.shift();
  queue.synthesising = true;
  let wav;
  try {
    wav = await synthesise(next.text, next.voice);
  } catch (e) {
    queue.synthesising = false;
    /* Kokoro failed for this sentence — skip and try the next. The first failure
     * is logged so a misconfigured TTS endpoint surfaces in the console. */
    console.warn(`[tts] sentence synth failed: ${e.message}`);
    if (gen === queue.generation) drain();
    return;
  }
  queue.synthesising = false;
  if (gen !== queue.generation) return;  /* cancelled while WAV was downloading */

  ensureAudioPath();
  let audioBuffer;
  try { audioBuffer = await queue.audioCtx.decodeAudioData(wav.slice(0)); }
  catch (e) {
    console.warn(`[tts] decodeAudioData failed: ${e.message}`);
    if (gen === queue.generation) drain();
    return;
  }
  if (gen !== queue.generation) return;

  const source = queue.audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(queue.analyser);
  if (queue.recDestination) { try { queue.analyser.connect(queue.recDestination); } catch {} }
  queue.current = source;
  source.onended = () => {
    queue.current = null;
    if (gen !== queue.generation) return;
    drain();
  };
  try { source.start(0); } catch { queue.current = null; drain(); }
}

function fireIdle() {
  const handlers = queue.onIdleHandlers.slice();
  queue.onIdleHandlers.length = 0;
  for (const h of handlers) { try { h(); } catch {} }
}

/** Add a sentence to the playback queue. Returns immediately. Sentences are
 *  spoken in the order they arrive. `text` should already be sanitised by the
 *  caller (or pass raw and let the queue sanitise — we sanitise here defensively). */
export function enqueueSentence(text, voice) {
  if (!text || !text.trim()) return;
  const cleaned = sanitiseForTTS(text);
  if (!cleaned) return;
  queue.pending.push({ text: cleaned, voice });
  drain();
}

/** Cancel any in-flight + queued speech. Used for barge-in. Increments the
 *  generation counter so any awaited synth/decode that resolves later sees a
 *  stale gen and bails. The current AudioBufferSourceNode is stopped immediately. */
export function cancelTTS() {
  queue.generation++;
  queue.pending.length = 0;
  if (queue.current) {
    try { queue.current.stop(0); } catch {}
    queue.current = null;
  }
}

/** True if the queue has audio playing or sentences pending. */
export function isSpeaking() {
  return !!queue.current || queue.pending.length > 0 || queue.synthesising;
}

/** Subscribe to the queue draining (idle event). Handler fires once the next
 *  time the queue empties — useful for "set state back to idle when done speaking". */
export function onIdle(handler) {
  queue.onIdleHandlers.push(handler);
}

/**
 * Schedule a system-TTS utterance (Web Speech API) with British-voice preference.
 * Used when Kokoro is unreachable. Resolves when speech ends.
 *
 * @param {string} text         Already-sanitised text.
 * @param {{rate?: number, pitch?: number}} [opts]
 * @returns {Promise<void>}     Resolves on `onend` or immediately if API unavailable.
 */
export function fallbackSystemTTS(text, { rate = 1.02, pitch = 1.0 } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    /* Prefer a British male/female voice that's actually shipped on the OS. The
     * Daniel/Serena/Kate names are common macOS install picks; fall back to any
     * en-GB then en. */
    const pref = voices.find(v => /en-GB/i.test(v.lang) && /Daniel|Oliver|Serena|Kate/i.test(v.name))
              || voices.find(v => /en-GB/i.test(v.lang))
              || voices.find(v => /en/i.test(v.lang));
    if (pref) u.voice = pref;
    u.rate = rate;
    u.pitch = pitch;
    u.onend = () => resolve();
    speechSynthesis.speak(u);
  });
}
