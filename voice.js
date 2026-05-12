/** voice.js - Jarvis voice loop.
 *  Web Speech API for mic + Kokoro TTS for output, Qwen 2.5 brain via the local bridge.
 *  Wake phrase + branding are loaded at runtime from /brand so the same codebase can be
 *  re-skinned without code changes — white-label distribution is Jarvis. */

import * as Bridge from "./bridge-client.js";
import * as TTS from "./tts.js";
import * as Storage from "./storage.js";
import * as Modal from "./modal-queue.js";
import * as History from "./history.js";
import * as WakeParse from "./wake-parsing.js";
import * as SettingsModal from "./settings-modal.js";
import * as SetupModal from "./setup-modal.js";
import * as MicTest from "./mic-test.js";
import * as TimerHud from "./timer-hud.js";
import * as WhisperStt from "./whisper-stt.js";
import * as DemoRecorder from "./demo-recorder.js";
import * as Conversation from "./conversation-mode.js";
import * as TtsPipeline from "./tts-pipeline.js";
import * as PassiveVad from "./passive-vad.js";
import * as BridgeEvents from "./bridge-events.js";

/* Profile-namespaced Storage helper now lives in ./storage.js (imported above).
 * Same API: Storage.get / Storage.set / Storage.remove with bare logical names. */

/* Why: defaults match the Jarvis white-label install but get overridden by /brand response.
 * Kept mutable (let) so brand fetch on init can swap them in before the recognizer starts. */
let WAKE_PHRASE = "hey jarvis";
let WAKE_VARIANTS = [
  "hey jarvis", "hi jarvis", "hey, jarvis",
  "hey jervis", "hey jarviz", "hey jarves", "hey jervice",
  /* Whisper mishears observed in the wild — "hey" can render as "penny",
   * "they", "say", "way" etc. on fast speech or accented input. We list
   * them as full variants so containsWake matches and extractQuery strips
   * cleanly (otherwise the prefix word survives into the query and breaks
   * fast-path regexes). */
  "penny jarvis", "they jarvis", "say jarvis", "way jarvis", "any jarvis",
  "jarvis", "jervis", "jarviz", "jarves",
];
let AGENT_NAME = "Jarvis";

/* Why: pulled in from /brand at boot. Failures fall back to the defaults above so the
 * mic loop still works on a half-configured install. */
async function loadBrandIntoVoice() {
  try {
    const r = await fetch("http://localhost:8766/brand", { cache: "no-store" });
    if (!r.ok) return;
    const b = await r.json();
    if (b?.agent?.wakePhrase) WAKE_PHRASE = String(b.agent.wakePhrase).toLowerCase();
    if (Array.isArray(b?.agent?.wakeMishears) && b.agent.wakeMishears.length) {
      WAKE_VARIANTS = b.agent.wakeMishears.map(s => String(s).toLowerCase());
    }
    if (b?.agent?.name) AGENT_NAME = String(b.agent.name);
    /* Sprint 12: when this window is pinned to a workspace via ?workspace=<slug>,
     * fetch THAT workspace's metadata and override the wake phrase + agent name
     * if it has them set. Lets two HUD windows listen for different wake words
     * (Jarvis main → "hey jarvis", Friday tab → "hey friday") simultaneously. */
    const pinned = (typeof window !== "undefined" && window.__pinnedWorkspace) || null;
    if (pinned) {
      try {
        /* No GET /workspaces/<slug> endpoint exists — list and find. List is
         * cheap (handful of rows) and avoids a server-side change. */
        const wr = await fetch(`http://localhost:8766/workspaces`, { cache: "no-store" });
        if (wr.ok) {
          const wj = await wr.json();
          const w = (wj?.workspaces || []).find((x) => x.slug === pinned);
          if (w?.wakePhrase) {
            WAKE_PHRASE = String(w.wakePhrase).toLowerCase();
            /* Build mishears as exact phrase + name-only variant. The operator
             * can say either "hey friday" or just "friday" and we'll match.
             * Adding common phonetic mishears would help further but the
             * tap-to-talk button bypasses wake detection anyway. */
            const phraseLower = WAKE_PHRASE;
            const justName = phraseLower.replace(/^hey\s+/, "");
            WAKE_VARIANTS = [phraseLower, justName].filter(Boolean);
          }
          if (w?.agentLabel) AGENT_NAME = String(w.agentLabel);
        }
      } catch (e) {
        console.warn(`[voice] pinned-workspace wake override failed: ${e.message} — using brand default`);
      }
    }
    /* Push brand state into the wake-parsing module so containsWake /
     * extractQuery use the right variants + agent name. */
    WakeParse.setBrand({ agentName: AGENT_NAME, wakeVariants: WAKE_VARIANTS });
    console.log(`[voice] brand loaded: agent="${AGENT_NAME}" wake="${WAKE_PHRASE}" variants=${WAKE_VARIANTS.length}${pinned ? ` (pinned to "${pinned}")` : ""}`);
  } catch (e) {
    console.warn("[voice] /brand fetch failed, using Jarvis defaults:", e.message);
  }
}
/* Fire-and-forget — boot path doesn't await, but variants are mutated before the first wake check. */
loadBrandIntoVoice();

/* Sprint 12 — re-load wake phrase + agent name + greeting when the active
 * workspace changes. Subscribes to the bridge's workspace.switched event so
 * a switch from Jarvis → Friday in the workspace switcher modal also flips
 * what the kiosk listens for and how it announces itself. Updates the wake
 * button label too — was hard-coded "HEY JARVIS", now reflects current. */
Bridge.on("workspace.switched", (msg) => {
  const w = msg?.data || null;
  if (w?.wakePhrase) {
    WAKE_PHRASE = String(w.wakePhrase).toLowerCase();
    const justName = WAKE_PHRASE.replace(/^hey\s+/, "");
    WAKE_VARIANTS = [WAKE_PHRASE, justName].filter(Boolean);
  } else {
    /* Switched to a workspace with no custom wake phrase — fall back to
     * the brand default by re-running the brand load. */
    loadBrandIntoVoice();
    return;
  }
  if (w?.agentLabel) AGENT_NAME = String(w.agentLabel);
  WakeParse.setBrand({ agentName: AGENT_NAME, wakeVariants: WAKE_VARIANTS });
  /* Update the wake button label so the operator sees the right phrase to say. */
  const lbl = document.querySelector("#wakeBtn .wake__inner");
  if (lbl) lbl.textContent = `TAP / SAY "${WAKE_PHRASE.toUpperCase()}"`;
  console.log(`[voice] persona swap: agent="${AGENT_NAME}" wake="${WAKE_PHRASE}" via workspace.switched`);
});

/* Contextual boot greeting — Jarvis announces itself with a short
 * Stark-butler-style brief: time of day + weekday + ordinal date +
 * weather + system status + an open invitation. Skipped if the operator
 * sets "quietBoot" or if the tab refreshed within 60s of last boot
 * (so hot reloads don't re-greet). Best-effort — if the bridge is slow
 * or weather is unreachable, falls back to a simpler greeting line.
 *
 * Composed entirely on the frontend so we don't add an LLM round-trip
 * to first-paint. The text is fixed-phrase so TTS plays it instantly. */
/** "a", "a and b", "a, b, and c". Used for honest health greeting clauses. */
function _listNicely(items) {
  if (!items || !items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
function _capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function _ordinal(n) {
  const s = ["th","st","nd","rd"];
  const v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
function _timeOfDayGreeting(hour) {
  if (hour < 5) return "Good evening, sir";   /* late-night kiosk turn-on */
  if (hour < 12) return "Good morning, sir";
  if (hour < 18) return "Good afternoon, sir";
  return "Good evening, sir";
}
function _composeGreeting({ weather, health, agentName }) {
  const now = new Date();
  const tod = _timeOfDayGreeting(now.getHours());
  const dayName = now.toLocaleDateString("en-GB", { weekday: "long" });
  const dateOrd = _ordinal(now.getDate());
  const month = now.toLocaleDateString("en-GB", { month: "long" });
  const time = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;

  const weatherClause = (() => {
    if (!weather || weather.error || !weather.label) return null;
    const article = /^[aeiou]/i.test(weather.label) ? "an" : "a";
    const temp = weather.now?.temp != null ? `${weather.now.temp} degrees` : null;
    return temp
      ? `It's ${article} ${weather.label} ${dayName}, the ${dateOrd} of ${month}, currently ${temp} and ${time}`
      : `It's ${article} ${weather.label} ${dayName}, the ${dateOrd} of ${month}, currently ${time}`;
  })();

  const fallbackDateClause = `It's ${dayName}, the ${dateOrd} of ${month}, currently ${time}`;

  /* Sprint 12 — per-persona greeting. Friday's tone is warmer, less formal,
   * and leads with her specialty (comms/triage) rather than tool count. The
   * Stark-butler "sir" stays on Jarvis. Other personas fall back to Jarvis's
   * template since we haven't seeded their voice yet. */
  if (String(agentName).toLowerCase() === "friday") {
    const datelineFri = (weatherClause || fallbackDateClause).replace(/^It's/, "It's");
    /* Friday flavour of the same honesty rule — only promise the inbox if
     * Ollama is actually up. If something key is missing, drop the closing
     * triage offer and surface the gap in her tone. */
    const services = health?.services || {};
    if (services.ollama === false) {
      return `Evening, Antony. ${datelineFri}. The language model isn't responding yet — give it a moment.`;
    }
    if (services.kokoro === false || services.whisper === false) {
      const missing = [];
      if (services.kokoro === false) missing.push("voice");
      if (services.whisper === false) missing.push("transcription");
      return `Evening, Antony. ${datelineFri}. I can read the inbox, but ${_listNicely(missing)} ${missing.length > 1 ? "are" : "is"} still warming up.`;
    }
    return `Evening, Antony. ${datelineFri}. Inbox is in front of me — want to triage what matters?`;
  }

  /* Sprint 12 — honest service-state clause. Reads /healthz's services map
   * and only says "all systems online" when every service is actually up.
   * If something's down (e.g. Kokoro not started), names what's online and
   * what's still missing so the operator knows what to expect.
   *
   * Spoken aloud by Kokoro, so we keep the names lower-case and short. */
  const healthClause = (() => {
    if (!health) return "Bridge connected";
    const services = health.services || {};
    /* Map service keys → spoken names. The bridge is implicit (we couldn't
     * have got the response if it were down) so we only narrate the workers. */
    const names = { ollama: "the language model", kokoro: "speech", whisper: "transcription" };
    const up = [], down = [];
    for (const [key, label] of Object.entries(names)) {
      if (services[key]) up.push(label);
      else down.push(label);
    }
    /* All-up shorthand — preserves the tight Stark-butler line. */
    if (down.length === 0) return "All systems online";
    /* Partial-up case — name what's ready and what we're waiting on. */
    if (up.length === 0) {
      return `Bridge connected, but waiting for ${_listNicely(down)}`;
    }
    return `${_capitalize(_listNicely(up))} online, waiting for ${_listNicely(down)}`;
  })();
  return `${tod}. ${weatherClause || fallbackDateClause}. ${healthClause}. How may I assist you?`;
}

async function _maybeBootGreeting() {
  try {
    if (Storage.get("quietBoot") === "true") return;
    const lastBootKey = "lastBootGreetingTs";
    const lastBoot = parseInt(Storage.get(lastBootKey, "0"), 10);
    if (lastBoot && Date.now() - lastBoot < 60_000) return;
    /* Wait for Kokoro to be reachable so the greeting actually plays
     * rather than silently dropping when TTS is still warming. */
    let kokoroReady = false;
    for (let i = 0; i < 12; i++) {
      try {
        const r = await fetch("http://localhost:8767/health", { cache: "no-store" });
        if (r.ok) { kokoroReady = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!kokoroReady) return;
    Storage.set(lastBootKey, String(Date.now()));

    /* Pull weather + bridge health in parallel; both have short timeouts so
     * a hung endpoint never blocks the greeting more than 2s. */
    const fetchWithTimeout = (url, ms) => Promise.race([
      fetch(url, { cache: "no-store" }).then(r => r.ok ? r.json() : null).catch(() => null),
      new Promise((res) => setTimeout(() => res(null), ms)),
    ]);
    /* Sprint 12 fix — was hitting /health which only confirms the bridge is
     * up. /healthz also probes Ollama/Kokoro/Whisper and reports per-service
     * status, so the greeting can be honest about what's actually ready
     * instead of always saying "all systems online". */
    const [weather, health] = await Promise.all([
      fetchWithTimeout("http://localhost:8766/weather", 2000),
      fetchWithTimeout("http://localhost:8766/healthz", 1500),
    ]);

    const greeting = _composeGreeting({ weather, health, agentName: AGENT_NAME });
    console.log(`[voice] boot greeting: ${greeting}`);

    /* Drop the greeting into the chat thread as the first assistant
     * message — visible whenever the operator opens the text-input modal,
     * regardless of whether they heard the audio. Mute or unmute, the
     * thread becomes a persistent log starting with this greeting. */
    try { appendThreadMessage("assistant", greeting); } catch {}

    /* Skip the audio if the operator has muted TTS — they reloaded the
     * HUD with mute on, they don't want a "Good morning, sir" greeting
     * blaring out of speakers. Read directly from localStorage rather
     * than the _ttsMuted module var so this works whether or not the
     * let-declaration has been reached by module-init time. */
    try {
      if (localStorage.getItem("jarvis.tts.muted") === "1") return;
    } catch {}

    /* Speak directly via TTS module (not speakStream) — fixed phrase, no
     * LLM round-trip needed. */
    const wav = await TTS.synthesise(greeting, getKokoroVoice());
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch {}
    }
    const buf = await audioCtx.decodeAudioData(wav.slice(0));
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (e) {
    console.warn("[voice] boot greeting failed:", e.message);
  }
}
_maybeBootGreeting();

const speedo = document.getElementById("speedo");
const transcript = document.getElementById("transcript");
const heardEl = document.getElementById("transcriptHeard");
const replyEl = document.getElementById("transcriptReply");
const stateText = document.getElementById("stateText");
const wakeBtn = document.getElementById("wakeBtn");

/* ---------- WAVEFORM VISUALISATION ----------
 * mode: "idle" | "listening" | "speaking"
 *  - listening: real time-domain mic data via Web Audio AnalyserNode
 *  - speaking : synthetic amplitude pulse (system TTS doesn't expose audio samples to JS)
 *  - idle     : soft sine drift so the bottom strip never looks dead */
const wf = {
  canvas: document.getElementById("waveform"),
  ctx: null,
  mode: "idle",
  audioCtx: null,
  analyser: null,
  buffer: null,
  micStream: null,
  rafId: 0,
  speakingAmp: 0,
  phase: 0,
};

function wfInit() {
  if (!wf.canvas) return;
  wf.ctx = wf.canvas.getContext("2d");
  // Match canvas backing buffer to its CSS size for crisp lines on retina
  const dpr = window.devicePixelRatio || 1;
  const r = wf.canvas.getBoundingClientRect();
  wf.canvas.width = Math.round(r.width * dpr);
  wf.canvas.height = Math.round(r.height * dpr);
  wf.ctx.scale(dpr, dpr);
  cancelAnimationFrame(wf.rafId);
  wf.rafId = requestAnimationFrame(wfDraw);
}

function wfStop() { cancelAnimationFrame(wf.rafId); }

/** Draw the live mic time-domain waveform. Pulled out of wfDraw so we can call it
 *  from both the explicit "listening" mode AND any state with a live mic stream
 *  (passive wake-word listening, between turns, etc). When `dimmed` is true the
 *  trace is rendered at lower opacity to signal "mic is hot but not actively waiting
 *  for a query"; the conversational listening state stays bright. */
function drawMicWave(ctx, w, h, dimmed) {
  wf.analyser.getByteTimeDomainData(wf.buffer);
  const len = wf.buffer.length;
  const mid = h / 2;
  let sumSq = 0;
  ctx.lineWidth = dimmed ? 1.2 : 1.6;
  ctx.strokeStyle = dimmed ? "rgba(0, 255, 136, 0.45)" : "#00ff88";
  ctx.shadowColor = dimmed ? "rgba(0, 255, 136, 0.25)" : "rgba(0, 255, 136, 0.6)";
  ctx.shadowBlur = dimmed ? 3 : 6;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const i = Math.floor((x / w) * len);
    const v = (wf.buffer[i] - 128) / 128;
    sumSq += v * v;
    const y = mid + v * (mid - 4);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const rms = Math.sqrt(sumSq / w);
  if (dbg.meter) dbg.meter.style.width = Math.min(100, rms * 400).toFixed(0) + "%";
  if (dbg.rms) dbg.rms.textContent = rms.toFixed(4);

  /* Feed the mic intensity into the speedo controller. speedo.js owns the needle
   * (single writer) and applies its own spring/smoothing. We just normalise RMS
   * to a 0..1 level. Noise floor + sqrt curve keep quiet rooms quiet. */
  const NOISE_FLOOR = 0.01;
  const eff = Math.max(0, rms - NOISE_FLOOR);
  const level = Math.min(1, Math.sqrt(eff) * 4);   // 4× empirically maps to full 0..1
  if (window.__speedo) window.__speedo.setMicLevel(level);
  /* Sprint 12 — also publish to a CSS variable so the Friday faceted-crystal
   * reactor (CSS-driven, no JS layer) can scale facets/pupil with mic amplitude.
   * Same value Jarvis's speedo gets, just exposed via custom property so any
   * persona's centerpiece can react without bespoke JS wiring. */
  document.documentElement.style.setProperty("--audio-amp", level.toFixed(3));
}

function wfDraw() {
  const ctx = wf.ctx;
  if (!ctx) return;
  const r = wf.canvas.getBoundingClientRect();
  const w = r.width, h = r.height;
  ctx.clearRect(0, 0, w, h);

  /* Why: the waveform should react to mic input ANY TIME the mic stream is live —
   * passive wake-word listening, between detection cycles, after a reply while
   * passive stays on. Any state with a live analyser is promoted to the mic-draw
   * path (TTS playback still wins because it's the louder signal we want to show).
   * The dim variant signals "you're being heard" vs the bright "actively listening". */
  const ttsActive = wf.mode === "speaking-real" || wf.mode === "speaking";
  const micLive = wf.analyser && wf.micStream && wf.micStream.active && !ttsActive;

  if (wf.mode === "listening" && wf.analyser) {
    drawMicWave(ctx, w, h, /* dimmed */ false);
  } else if (micLive) {
    drawMicWave(ctx, w, h, /* dimmed */ true);
  } else if (wf.mode === "speaking-real" && wf.speakingAnalyser) {
    /* Real Kokoro audio: brand-red time-domain wave from the dedicated TTS analyser. */
    wf.speakingAnalyser.getByteTimeDomainData(wf.speakingBuffer);
    const len = wf.speakingBuffer.length;
    const mid = h / 2;
    let speakSum = 0;
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = "#00d4ff";
    ctx.shadowColor = "rgba(0, 212, 255,0.7)";
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const i = Math.floor((x / w) * len);
      const v = (wf.speakingBuffer[i] - 128) / 128;
      speakSum += v * v;
      const y = mid + v * (mid - 4);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    /* Feed TTS amplitude into the speedo controller for "speaking" mood modulation. */
    const sRms = Math.sqrt(speakSum / w);
    const ttsLevel = Math.min(1, sRms * 11);   // 11× empirically maps Kokoro RMS to 0..1
    if (window.__speedo) window.__speedo.setTtsLevel(ttsLevel);
    /* Sprint 12 — same CSS-var publish as drawMicWave so Friday's reactor
     * pulses with TTS playback as well as mic listening. */
    document.documentElement.style.setProperty("--audio-amp", ttsLevel.toFixed(3));
  } else if (wf.mode === "speaking") {
    /* Synthetic fallback for non-Kokoro TTS paths. */
    wf.speakingAmp = wf.speakingAmp * 0.85 + Math.random() * 0.15;
    const amp = 0.4 + wf.speakingAmp * 0.6;
    wf.phase += 0.35;
    const mid = h / 2;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "#00d4ff";
    ctx.shadowColor = "rgba(0, 212, 255,0.6)";
    ctx.shadowBlur = 6;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const t = (x + wf.phase) * 0.04;
      const y = mid + Math.sin(t) * (mid - 6) * amp * (0.6 + Math.sin(t * 2.7) * 0.3);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else {
    /* Idle: soft drift, dim brand-red */
    /* Sprint 12 — bleed --audio-amp toward 0 so Friday's reactor settles
     * back to the static animation when neither mic nor TTS is active.
     * Read current var, decay 25% per frame for a smooth fade rather than
     * a hard snap. */
    try {
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--audio-amp")) || 0;
      const next = cur * 0.75;
      document.documentElement.style.setProperty("--audio-amp", next < 0.005 ? "0" : next.toFixed(3));
    } catch {}
    wf.phase += 0.6;
    const mid = h / 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0, 212, 255,0.45)";
    ctx.shadowBlur = 0;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const t = (x + wf.phase) * 0.025;
      const y = mid + Math.sin(t) * 4 + Math.sin(t * 1.7) * 3;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const t = (x + wf.phase * 0.7) * 0.03;
      const y = mid + Math.cos(t * 1.2) * 4;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  wf.rafId = requestAnimationFrame(wfDraw);
}

/* ---------- DEBUG HOOKS ---------- */
const dbg = {
  device: document.getElementById("dbgDevice"),
  track:  document.getElementById("dbgTrack"),
  meter:  document.getElementById("dbgMeter"),
  rms:    document.getElementById("dbgRms"),
  peak:   document.getElementById("dbgPeak"),
  chunks: document.getElementById("dbgChunks"),
  upload: document.getElementById("dbgUpload"),
  whisper: document.getElementById("dbgWhisper"),
  error:  document.getElementById("dbgError"),
  picker: document.getElementById("dbgDevicePicker"),
};
function dbgSet(field, value) { if (dbg[field]) dbg[field].textContent = String(value); }

/* ---------- QUERY-HANDLED EVENT BUS ----------
 *  Lightweight pub/sub so peripheral modules (the first-run tour, future
 *  analytics, etc.) can react to "operator just finished a turn" without
 *  voice.js needing to know about them. Subscribers receive a payload:
 *    { heard, query, replied }
 *  where `heard` is the raw transcript, `query` is the wake-stripped
 *  utterance, and `replied` is true if the LLM produced a reply (false
 *  if dismissal / empty / inbox follow-up path). */
const _queryHandledSubs = [];
export function onQueryHandled(callback) {
  if (typeof callback !== "function") return () => {};
  _queryHandledSubs.push(callback);
  return () => {
    const i = _queryHandledSubs.indexOf(callback);
    if (i !== -1) _queryHandledSubs.splice(i, 1);
  };
}
function _emitQueryHandled(payload) {
  for (const cb of _queryHandledSubs) {
    try { cb(payload); } catch (e) { console.warn("[Jarvis] query-handled subscriber threw:", e.message); }
  }
}

/** Convert performance marks dropped during a voice cycle into named spans
 *  and POST the summary to the bridge for aggregation. Spans are keyed
 *  start→end mark name pairs; missing marks are silently skipped (a TTS
 *  fallback path may not produce v.audio-play, for example). The bridge
 *  serves the rolling buffer at GET /health/timings. */
function _reportPerfTimings(heard, whisperTranscribeMs) {
  if (typeof performance === "undefined" || !performance.getEntriesByName) return;
  const get = (name) => {
    const e = performance.getEntriesByName(name);
    return e.length ? e[e.length - 1].startTime : null;
  };
  const marks = {
    wakeStart:        get("v.wake-start"),
    recEnd:           get("v.rec-end"),
    whisperReq:       get("v.whisper-req"),
    whisperRes:       get("v.whisper-res"),
    llmFirstSentence: get("v.llm-first-sentence"),
    audioPlay:        get("v.audio-play"),
  };
  /* Compute spans where both endpoints exist. Negative spans indicate the
   * marks fired out of order (rare, but possible if TTS already started
   * speaking from a previous turn) — drop them. */
  const span = (a, b) => (marks[a] != null && marks[b] != null && marks[b] > marks[a])
    ? Math.round(marks[b] - marks[a]) : null;
  const payload = {
    ts: Date.now(),
    heard: heard.slice(0, 120),
    spans: {
      voice_to_recend:    span("wakeStart", "recEnd"),
      voice_to_whisper:   span("wakeStart", "whisperRes"),
      whisper_roundtrip:  span("whisperReq", "whisperRes"),
      whisper_inference:  whisperTranscribeMs,
      voice_to_audio:     span("wakeStart", "audioPlay"),
      /* Demo-relevant headline metrics: how long after the operator finishes
       * speaking before something audible starts. recend_to_audio is the
       * perceptual lag — the only number that matters for "feels real-time".
       * llm_thinking isolates the LLM stage; tts_synth isolates Kokoro. */
      recend_to_audio:    span("recEnd", "audioPlay"),
      recend_to_whisper:  span("recEnd", "whisperRes"),
      whisper_to_llm:     span("whisperRes", "llmFirstSentence"),
      llm_thinking:       span("whisperRes", "llmFirstSentence"),
      tts_synth:          span("llmFirstSentence", "audioPlay"),
    },
  };
  /* Clear marks so the next cycle starts clean. performance.clearMarks
   * with the prefix would be ideal but the spec only takes exact names. */
  ["v.wake-start","v.rec-end","v.whisper-req","v.whisper-res","v.llm-first-sentence","v.audio-play"].forEach(n => {
    try { performance.clearMarks(n); } catch {}
  });
  fetch("http://localhost:8766/perf", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => { /* perf is best-effort */ });
}

/* ---------- MIC DEVICE SELECTION ----------
 * Why: built-in mic on this machine is broken; user needs to pick a working input (iPhone Continuity etc).
 * Selection persists in localStorage so it's stable across sessions and reboots. */
/* Why: short logical names — translated to fully-namespaced keys via Storage. */
const PREFERRED_DEVICE_KEY = "preferredAudioDeviceId";
const PREFERRED_LABEL_KEY  = "preferredAudioDeviceLabel";

function getPreferredDeviceId() { return Storage.get(PREFERRED_DEVICE_KEY, ""); }
function setPreferredDevice(deviceId, label) {
  Storage.set(PREFERRED_DEVICE_KEY, deviceId || "");
  if (label) Storage.set(PREFERRED_LABEL_KEY, label);
}

/** Populate the debug-panel picker with all audioinput devices.
 *  Chrome only returns proper device labels AFTER a full grant — so this is also re-run
 *  every time wfStartListening succeeds, which guarantees labels by then. */
async function refreshDevicePicker() {
  if (!dbg.picker) return;
  // Try to grant permission so enumerateDevices returns real labels (no-op if already granted)
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    await new Promise(r => setTimeout(r, 200));   // Chrome needs a moment after grant
  } catch {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === "audioinput");
  const saved = getPreferredDeviceId();

  // Wire the change handler once
  if (!dbg.picker.dataset.wired) {
    dbg.picker.dataset.wired = "1";
    dbg.picker.addEventListener("change", () => {
      const id = dbg.picker.value;
      const label = dbg.picker.selectedOptions[0]?.textContent || "";
      setPreferredDevice(id, label);
      if (wf.micStream) wf.micStream.getTracks().forEach(t => t.stop());
      wf.micStream = null;
      wf.analyser = null;
      dbgSet("device", `${label} (saved — tap wake to reopen)`);
    });
  }

  // Rebuild options — only repopulate if labels actually came back, else keep prior options
  const haveLabels = inputs.some(d => d.label);
  if (haveLabels || dbg.picker.options.length <= 1) {
    dbg.picker.replaceChildren();
    for (const d of inputs) {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      const idTail = d.deviceId ? d.deviceId.slice(0, 6) : "default";
      opt.textContent = d.label || `(unlabeled mic ${idTail})`;
      if (d.deviceId === saved) opt.selected = true;
      dbg.picker.appendChild(opt);
    }
    // Auto-select first non-built-in if no save (built-in is dead on this machine)
    if (!saved && inputs.length > 0) {
      const nonBuiltIn = inputs.find(d => d.label && !/built-?in/i.test(d.label)) || inputs[0];
      if (nonBuiltIn) {
        dbg.picker.value = nonBuiltIn.deviceId;
        setPreferredDevice(nonBuiltIn.deviceId, nonBuiltIn.label);
      }
    }
  }
}

/** Build audio constraints honouring the user's saved device choice. */
function audioConstraints() {
  const id = getPreferredDeviceId();
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  return id ? { ...base, deviceId: { exact: id } } : base;
}

/* ---- Self-heal on device change ----
 * Why: macOS routes audio to whatever Input device is currently selected in
 * System Settings. If the operator switches input (Continuity Camera mic →
 * Mac mic, or vice-versa) AFTER the HUD has cached a MediaStream, voice.js
 * keeps using the old stream object — which is now silent at the OS level
 * because audio is routed elsewhere. Symptom: HUD shows it can hear you
 * (the analyser's still wired to the new source) but commands aren't
 * acted on (MediaRecorder still references the old, silent stream).
 *
 * Fix: navigator.mediaDevices fires `devicechange` on add/remove/switch.
 * We drop the cached stream + analyser so the next wfStartListening
 * acquires fresh from the now-current default input. Adam reported this
 * exact failure after switching off Continuity Camera in macOS settings. */
function wireDeviceChange() {
  if (!navigator.mediaDevices?.addEventListener) return;
  navigator.mediaDevices.addEventListener("devicechange", () => {
    /* Refresh the picker label so the dropdown reflects the new device
     * list — useful even if our currently-cached stream is fine. */
    refreshDevicePicker().catch(() => {});
    /* Only drop the cached stream if its tracks are ACTUALLY dead. The
     * devicechange event fires for many reasons that don't kill our
     * stream — Chrome firing it after labels become available post-
     * permission grant, Bluetooth devices going to sleep, USB devices
     * being added (without removing ours), getUserMedia itself
     * triggering a relabel cycle in some Chrome builds.
     *
     * Earlier draft of this handler dropped the stream unconditionally
     * — Adam reported settings-mic working but passive failing because
     * the passive cycle's own getUserMedia was triggering a relabel
     * devicechange that killed the stream it had just acquired. */
    const track = wf.micStream?.getAudioTracks?.()[0];
    if (track && track.readyState === "ended") {
      console.log("[Jarvis] devicechange — track ended, dropping stream");
      try { wf.micStream.getTracks().forEach((t) => t.stop()); } catch {}
      wf.micStream = null;
      /* Analyser was wired to the OLD stream's MediaStreamSource — must
       * also be cleared so wfStartListening rebuilds it against the new
       * stream. Otherwise the analyser keeps pulling from a silent
       * source and the waveform would render flat. */
      wf.analyser = null;
      wf.buffer = null;
      dbgSet("device", "(reacquiring on next wake)");
      /* Restart passive only when we genuinely had to drop the stream.
       * Otherwise leave the running cycle alone — it's still listening
       * to a healthy track. */
      if (passive) {
        console.log("[Jarvis] devicechange — restarting passive on new mic");
        stopPassive();
        setTimeout(() => { startPassive().catch(() => {}); }, 250);
      }
    }
  });
}

/** Hook a mic stream to the analyser. Call when listening starts. Also populates the debug panel. */
async function wfStartListening() {
  try {
    if (!wf.audioCtx) wf.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!wf.micStream) {
      wf.micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
    }
    if (!wf.analyser) {
      wf.analyser = wf.audioCtx.createAnalyser();
      wf.analyser.fftSize = 1024;
      wf.buffer = new Uint8Array(wf.analyser.fftSize);
      const src = wf.audioCtx.createMediaStreamSource(wf.micStream);
      src.connect(wf.analyser);
    }
    if (wf.audioCtx.state === "suspended") await wf.audioCtx.resume();
    wf.mode = "listening";

    // Populate debug panel with mic device info
    const track = wf.micStream.getAudioTracks()[0];
    if (track) {
      const settings = track.getSettings ? track.getSettings() : {};
      dbgSet("device", track.label || settings.deviceId || "?");
      dbgSet("track", `${track.readyState}/${track.muted ? "muted" : "live"}/${track.enabled ? "on" : "off"}`);
      dbgSet("error", "—");
    }
    // Now that we have a real grant, re-enumerate so the picker shows real labels
    refreshDevicePicker();
  } catch (e) {
    console.warn("[Jarvis] mic init failed:", e.message);
    dbgSet("error", `mic: ${e.name} ${e.message}`);
    dbgSet("device", "MIC DENIED");
    wf.mode = "idle";
  }
}
function wfSetSpeaking() { wf.speakingAmp = 0; wf.mode = "speaking"; }
function wfSetIdle()     { wf.mode = "idle"; }

/* Why: camera reveal mode is operator-configurable. "off" = camera never appears,
 * "on-listen" = fade in for any active conversational state, "always" = always
 * visible. Default "off" addresses the perpetual-camera-on privacy concern. */
function getCameraMode() { return Storage.get("cameraMode", "off"); }

/** Apply accessibility prefs (high-contrast + font-scale) to the body. Called at
 *  boot and on save. Body classes drive the CSS overrides. */
function applyAccessibilityPrefs() {
  const hc = Storage.get("highContrast", "false") === "true";
  const scale = Storage.get("fontScale", "m");
  document.body.classList.toggle("is-high-contrast", hc);
  document.body.classList.remove("font-scale-s", "font-scale-m", "font-scale-l", "font-scale-xl");
  document.body.classList.add(`font-scale-${["s","m","l","xl"].includes(scale) ? scale : "m"}`);
}
/* Apply on first script load — before the modal is even built — so the operator's
 * persisted choice takes effect without waiting for the modal to render. */
applyAccessibilityPrefs();

/** Reveal/hide the camera frame based on the current state and the operator's mode. */
function applyCameraVisibility(state) {
  const cam = document.getElementById("cam");
  if (!cam) return;
  const mode = getCameraMode();
  let revealed;
  if (mode === "always") revealed = true;
  else if (mode === "on-listen") revealed = state === "listening" || state === "thinking" || state === "speaking";
  else revealed = false;
  cam.classList.toggle("is-revealed", revealed);
}

/** Set HUD state — drives speedo glow, readout text, and waveform mode.
 *
 *  Sprint 10: also forwards to the Three.js orb when it's the active
 *  centerpiece. The orb has its own state-driven breathing/scale params;
 *  the SVG speedo's class-based animation is unaffected (operators on
 *  the reactor preset see the same behaviour they always have). */
function setState(state) {
  speedo.classList.remove("is-listening", "is-thinking", "is-speaking");
  switch (state) {
    case "listening": speedo.classList.add("is-listening"); stateText.textContent = "LISTENING"; wfStartListening(); break;
    case "thinking":  speedo.classList.add("is-thinking");  stateText.textContent = "PROCESSING"; wfSetIdle(); break;
    case "speaking":  speedo.classList.add("is-speaking");  stateText.textContent = "SPEAKING";  wfSetSpeaking(); break;
    default:          stateText.textContent = "STANDBY";    wfSetIdle(); break;
  }
  /* Forward state to the orb if it's mounted. The setOrbState hook in
   * hud.js no-ops when the SVG centerpiece is active, so this is safe
   * to call unconditionally. Imported lazily via the global to avoid
   * a circular import (voice.js → hud.js → voice.js). */
  if (window.__hud?.setOrbState) window.__hud.setOrbState(state);
  applyCameraVisibility(state);
  /* Speedo expressiveness: translate the conversational state into a needle mood.
   * Idle baseline is the "breathing" sine. Voice always wins over background tasks. */
  const sp = window.__speedo;
  if (sp) {
    const moodMap = { listening: "listening", thinking: "thinking", speaking: "speaking" };
    sp.setMood(moodMap[state] || "idle");
  }
  /* Reset the help-nudge idle timer — any state transition counts as activity. */
  window.__help?.noteActivity?.();
}

/* ---------- BRIDGE EVENT WIRING ----------
 * Why: WebSocket + reply correlation now live in bridge-client.js. Voice.js subscribes
 * to the typed events it cares about. Each handler stays here because they reference
 * voice.js-internal state (queueModal, speak, pendingInboxFile, dbgSet, conversationHistory).
 *
 * Subscriptions register at boot — see bottom of file. */

/* Bridge-event handlers (task.* / video.edit / pdf / thumbnail / inbox)
 * moved to ./bridge-events.js. handleEnterSleep stays here because it
 * directly drives listening / passive / TTS state that voice.js owns. */

/** Connect + register all bridge event subscribers. Called once at boot.
 *  Voice.js wires BridgeEvents handler deps (speak, queueModal, ...)
 *  in wireUI before any of these can fire. The yt.thumbnail.progress
 *  subscription was dropped this commit — its only side-effect was
 *  writing into a debug panel that doesn't exist any more, and the
 *  lane-grouped task-strip viz handles thumbnail stage updates now. */
function wireBridgeEvents() {
  Bridge.connect();
  Bridge.on("task.*",                 BridgeEvents.handleTaskEvent);
  /* Why: conversation mode's idle timer drops the operator back to wake-word
   * listening if no speech is heard for 5 minutes. While a confirmation gate
   * is open ("Shall I proceed?"), the operator is mid-task by definition —
   * lock the timer until the bridge reports the gate resolved. Without this,
   * a long Jarvis explanation + a beat of operator hesitation could time out
   * the conversation right when they're about to say "yes". */
  Bridge.on("task.confirmation_pending", () => Conversation.acquireTaskLock());
  Bridge.on("task.confirmation_resolved", () => Conversation.releaseTaskLock());
  Bridge.on("video.edit.complete",    BridgeEvents.handleVideoEditComplete);
  Bridge.on("video.edit.error",       BridgeEvents.handleVideoEditError);
  Bridge.on("pdf.complete",           BridgeEvents.handlePdfComplete);
  Bridge.on("yt.thumbnail.complete",  BridgeEvents.handleThumbnailComplete);
  Bridge.on("inbox.dropped",          BridgeEvents.handleInboxDropped);
  Bridge.on("state.sleep",            handleEnterSleep);
  TimerHud.register(Bridge);
}

/** Bridge dispatched the enter_sleep_mode tool — mute the mic, dim the HUD,
 *  and stop any in-flight TTS. The operator wakes Jarvis again by clicking
 *  the speedometer (which calls wfStartListening) or saying the wake word. */
function handleEnterSleep() {
  try { stopListening(); } catch (e) { console.warn("[Jarvis] stopListening failed:", e.message); }
  try { fetch("http://localhost:8766/cancel", { method: "POST" }); } catch {}
  const speedo = document.getElementById("speedo");
  if (speedo) {
    speedo.classList.remove("is-listening");
    speedo.classList.add("is-asleep");
  }
  const stateText = document.getElementById("stateText");
  if (stateText) stateText.textContent = "ASLEEP";
  console.log("[Jarvis] entered sleep — mic muted, awaiting wake");
}

/* ---------- CONVERSATION MEMORY ----------
 * Per-session history fed back to the LLM on each turn. Prevents repeated questions when scheduling
 * meetings, building up PDF data, or chaining tool calls. Cleared when the user dismisses ("that's all").
 *
 * Why: storage now lives in ./history.js — persistent across refresh, viewable in
 * the H-key drawer. Voice.js is just a passthrough — pushHistory pushes both
 * locally (for the LLM context which is bounded to 20 turns) and into history.js
 * (which keeps 100 for the operator-facing log). */
let conversationHistory = [];
const MAX_HISTORY_TURNS = 20;

/* TTS mute toggle — sticky across reloads via localStorage. When true,
 * speak() and speakStream() skip Kokoro / system-speech synthesis but the
 * LLM round-trip still runs so the reply text streams to _replyEl as usual.
 * Used in loud / quiet-courtesy environments alongside the text-input bar. */
let _ttsMuted = false;
try { _ttsMuted = localStorage.getItem("jarvis.tts.muted") === "1"; } catch {}

/** Wire the speaker icon left of the wake button. Click toggles, value
 *  persists to localStorage, aria-pressed drives the strikethrough CSS. */
function initTtsMuteToggle() {
  const btn = document.getElementById("ttsMuteBtn");
  if (!btn) return;
  const apply = () => {
    btn.setAttribute("aria-pressed", _ttsMuted ? "true" : "false");
    btn.setAttribute("aria-label", _ttsMuted ? "Unmute Jarvis voice replies" : "Mute Jarvis voice replies");
  };
  apply();
  btn.addEventListener("click", () => {
    _ttsMuted = !_ttsMuted;
    try { localStorage.setItem("jarvis.tts.muted", _ttsMuted ? "1" : "0"); } catch {}
    apply();
    /* If the operator hits mute mid-stream, kill the in-flight TTS so the
     * silence is immediate. The reply on screen continues unchanged. */
    if (_ttsMuted) try { TtsPipeline.cancelCurrentSpeech(); } catch {}
  });
  /* Keyboard shortcut Cmd/Ctrl+M — global mute toggle. All HUD shortcuts use
   * Cmd modifier so bare letters never get eaten when typing in the text
   * input modal. preventDefault stops the OS-level Cmd+M (minimize) on Mac. */
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "m" || e.key === "M")) {
      e.preventDefault();
      btn.click();
    }
  });
}

/** Wire the text input bar: toggle button + submit handler + Esc to close +
 *  T keyboard shortcut to open. Submitted text takes the same path as a
 *  voice query — pushHistory + speakStream(query, history) — so all the
 *  tools, confirmations, conversation-mode behaviour are identical. */
function initTextInputBar() {
  const toggle = document.getElementById("textInputToggle");
  const bar    = document.getElementById("textInputBar");
  const field  = document.getElementById("textInputField");
  const close  = document.getElementById("textInputClose");
  if (!toggle || !bar || !field) return;

  const open = () => {
    bar.hidden = false;
    /* Body class triggers the reactor shrink/lift (same choreography as
     * listening mode) so the bottom-centred panel doesn't cover the dial. */
    document.body.classList.add("is-typing");
    setTimeout(() => field.focus(), 30);
    /* Entering text input counts as engagement — keep conversation alive
     * while the operator is composing. Mirrors what voice does on heard. */
    if (Conversation.isActive()) Conversation.resetIdleTimer();
  };
  const dismiss = () => {
    bar.hidden = true;
    field.value = "";
    document.body.classList.remove("is-typing");
  };

  toggle.addEventListener("click", () => bar.hidden ? open() : dismiss());
  if (close) close.addEventListener("click", dismiss);

  field.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); dismiss(); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const query = field.value.trim();
      if (!query) return;
      field.value = "";
      submitTypedQuery(query);
    }
  });

  /* Cmd/Ctrl+T opens the text input modal. preventDefault stops the
   * browser's "new tab" shortcut from running alongside. */
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "t" || e.key === "T")) {
      e.preventDefault();
      open();
    }
  });
}

/** Submit a typed query — same downstream path as a heard utterance.
 *  Drops the user message into history, paints both sides of the chat
 *  thread in the text-input modal, fires speakStream (which streams to
 *  the reply area + plays TTS unless muted), echoes the reply back into
 *  conversation history. Conversation mode stays engaged on text just
 *  like it does on voice. */
async function submitTypedQuery(query) {
  pushHistory("user", query);
  if (!Conversation.isActive()) Conversation.enter();
  Conversation.resetIdleTimer();
  if (replyEl) replyEl.textContent = "…";

  /* Append the user message to the modal thread and create a pending
   * assistant bubble. Sentences stream into the pending bubble via the
   * jarvis.stream.sentence event dispatched by tts-pipeline. */
  appendThreadMessage("user", query);
  const pending = appendThreadMessage("assistant", "", { pending: true });

  /* Subscribe per-turn so a stale stream's late sentences (after barge-in
   * or new query) don't bleed into the bubble. Unsubscribe on done/error.
   * Filler event populates the bubble with a placeholder ("Let me check…")
   * while the LLM is thinking; the first real sentence REPLACES that
   * placeholder rather than appending so the bubble doesn't read like
   * "Let me check… The references are ready." */
  const onFiller = (ev) => {
    const text = ev.detail?.text;
    if (!text || !pending) return;
    if (pending.textContent) return; // already has real content, ignore
    pending.textContent = text;
    pending.dataset.filler = "true";
    scrollThreadToEnd();
  };
  const onSentence = (ev) => {
    const text = ev.detail?.text;
    if (!text || !pending) return;
    if (pending.dataset.filler === "true") {
      pending.textContent = text;
      delete pending.dataset.filler;
    } else {
      pending.textContent = pending.textContent ? `${pending.textContent} ${text}` : text;
    }
    scrollThreadToEnd();
  };
  const onDone = () => {
    if (pending) pending.removeAttribute("data-pending");
    cleanup();
  };
  const cleanup = () => {
    window.removeEventListener("jarvis.filler", onFiller);
    window.removeEventListener("jarvis.stream.sentence", onSentence);
    window.removeEventListener("jarvis.stream.done", onDone);
  };
  window.addEventListener("jarvis.filler", onFiller);
  window.addEventListener("jarvis.stream.sentence", onSentence);
  window.addEventListener("jarvis.stream.done", onDone);

  let reply = "";
  try {
    reply = await speakStream(query, conversationHistory.slice(0, -1));
    /* If no streaming sentences arrived (rare — fast-path canned reply,
     * error, etc), populate the bubble with the final text so the operator
     * still sees something. */
    if (pending && !pending.textContent && reply) pending.textContent = reply;
  } catch (e) {
    reply = `Sorry — ${e.message || e}`;
    if (replyEl) replyEl.textContent = reply;
    if (pending) pending.textContent = reply;
  } finally {
    if (pending) pending.removeAttribute("data-pending");
    cleanup();
    scrollThreadToEnd();
  }
  if (reply) pushHistory("assistant", reply);
}

/** Append a chat bubble to the text-input thread. Returns the bubble node
 *  so callers can stream content into it. data-role styles user vs assistant;
 *  data-pending=true adds the streaming-glow CSS that's removed on done. */
function appendThreadMessage(role, text, { pending = false } = {}) {
  const thread = document.getElementById("textInputThread");
  if (!thread) return null;
  thread.hidden = false;
  const node = document.createElement("div");
  node.className = "text-input-modal__msg";
  node.dataset.role = role;
  if (pending) node.dataset.pending = "true";
  node.textContent = text || "";
  thread.appendChild(node);
  scrollThreadToEnd();
  return node;
}

function scrollThreadToEnd() {
  const thread = document.getElementById("textInputThread");
  if (!thread) return;
  /* Defer one frame so newly-appended content is laid out before we measure
   * scrollHeight; otherwise the auto-scroll undershoots by one bubble. */
  requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; });
}

function pushHistory(role, content) {
  conversationHistory.push({ role, content });
  if (conversationHistory.length > MAX_HISTORY_TURNS * 2) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY_TURNS * 2);
  }
  History.add(role, content);
}
function clearHistory() {
  conversationHistory = [];
  History.clear();
}

/** Ask the bridge for an LLM reply. Includes conversationHistory so the model has context. */
/* Stable per-HUD-load session id. Persists in localStorage so survives Cmd+R
 * but resets if the browser profile is wiped. Used to group conversation_turns
 * rows in the bridge's persistence layer so the history drawer can offer a
 * "this session" filter. */
function getSessionId() {
  try {
    let id = localStorage.getItem("jarvis.sessionId");
    if (!id) {
      id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem("jarvis.sessionId", id);
    }
    return id;
  } catch { return null; }
}

/* Why: 60s timeout used to be enough but composite tools like describe_shoot_with_specs
 * legitimately need ~30-90s when they chain caption+search+synthesis. Bumped to 120s as a
 * backstop; the bridge still logs per-stage timings so genuine hangs are spottable. */
function askLLM(query, timeoutMs = 120000) {
  /* Workspaces v4: when this window is pinned to a workspace via the
   * ?workspace=<slug> URL param (set on window.__pinnedWorkspace by the
   * inline script in index.html), forward the slug so the bridge dispatches
   * the call in that workspace's scope — even if a different workspace is
   * the global active. Default windows (no pin) get the global active. */
  const pinned = (typeof window !== "undefined" && window.__pinnedWorkspace) || null;
  return Bridge.ask({
    type: "llm.ask",
    payload: {
      query,
      history: conversationHistory.slice(),
      sessionId: getSessionId(),
      workspace: pinned,
    },
  }, timeoutMs);
}

/** Last-resort message if bridge is down. */
function offlineFallback() {
  return "I'm running offline at the moment — the local model bridge isn't reachable. Check the bridge logs and try again.";
}

/** Documented Whisper-on-silence hallucinations. Whisper's training corpus
 *  includes YouTube auto-captions which use these placeholder phrases for
 *  silent / non-speech audio; the model emits them as fallbacks when given
 *  near-silent input. Lowercased + stripped of trailing punctuation before
 *  the comparison so "Music." and "MUSIC" both match. */
const _WHISPER_HALLUCINATIONS = new Set([
  "music",
  "music playing",
  "the music is playing",
  "[music]",
  "♪",
  "thanks for watching",
  "thank you",
  "thank you for watching",
  "thanks for watching!",
  "subscribe",
  "please subscribe",
  "see you next time",
  "see you in the next video",
  "i'm sorry",
  "good night",
  "go to sleep",
  "bye",
  "bye-bye",
  "goodbye",
  "you",
  "yeah",
  "okay",
  "ok",
  "hmm",
  "uh",
  "um",
  "applause",
  "[applause]",
  "laughter",
  "[laughter]",
  "silence",
  "[silence]",
  "indistinct",
  "indistinct chatter",
  "background noise",
  "mr. pewsey",
]);

/** True when the transcript looks like a Whisper hallucination given the
 *  audio blob's size. Conservative — only rejects clear hallucination
 *  patterns + tiny audio clips. See passive-transcript handler for the
 *  reasoning behind the thresholds. */
function _isWhisperHallucination(text, blobSizeKB) {
  const t = String(text || "").trim().toLowerCase().replace(/[.,!?…♪]+$/g, "").trim();
  if (!t) return true;
  /* Tiny clips with any transcript = hallucination. <8KB is ~1.5s of
   * 16kHz mono PCM audio. Real wake-word + short query is always longer. */
  if (blobSizeKB < 8) return true;
  /* Exact match against the documented hallucination set. */
  if (_WHISPER_HALLUCINATIONS.has(t)) return true;
  /* Single short word on a small clip — same shape as the hallucinations
   * but operator's vocabulary may include real one-word queries
   * ("weather", "calendar"). Threshold tightened to <12KB AND <6 chars
   * to keep "weather" (7 chars) safe. */
  if (blobSizeKB < 12 && !t.includes(" ") && t.length < 6) return true;
  return false;
}

/** Voice id resolver — single source of truth for which Kokoro voice to use.
 *
 *  Workspaces v3: an active workspace can declare its own voice (formal
 *  British male for consulting, warmer voice for personal, etc). The
 *  workspace switcher sets `_workspaceVoiceOverride` on workspace.switched
 *  events so per-turn lookups stay synchronous. Resolution priority:
 *    1. Active workspace's `voice` field
 *    2. Operator's localStorage preference (Settings → Voice)
 *    3. Default "bm_daniel" */
let _workspaceVoiceOverride = null;
function getKokoroVoice() {
  return _workspaceVoiceOverride || Storage.get("voice", "bm_daniel");
}
export function setWorkspaceVoice(voiceId) {
  _workspaceVoiceOverride = voiceId || null;
}

/* Local aliases for the TTS pipeline so existing call sites stay valid.
 * The TtsPipeline module owns speak/speakStream/cancelCurrentSpeech +
 * the barge-in monitor + currentSpeechSession state. Wired in wireUI()
 * via TtsPipeline.setHandlers(). */
const speak = (text) => TtsPipeline.speak(text);
const speakStream = (q, h) => TtsPipeline.speakStream(q, h);
const cancelCurrentSpeech = () => TtsPipeline.cancelCurrentSpeech();

/* Wake-word + utterance-classification helpers (extractQuery, containsWake,
 * quickExtractSubject, isAffirmative, isDismissal) live in ./wake-parsing.js
 * — see WakeParse.* call sites above. The setBrand() call inside
 * loadBrandIntoVoice() pushes WAKE_VARIANTS + AGENT_NAME into that module
 * so it has the right state when the parser functions run. */

/* Why: runVideoTeaser + runVideoEdit removed — both were intent-shortcut paths
 * superseded by LLM-driven tool calls (video_edit_from_shoot, generate_youtube_*).
 * The bridge no longer exposes "video.teaser" / "video.edit" request types; all
 * video work goes through llm.ask + tool dispatch, which fires task.* lifecycle
 * events that the task strip + speedo pick up automatically. */

/* ---------- DEFERRED MODAL QUEUE ----------
 * Don't pop video / PDF windows mid-sentence — wait until Daniel finishes speaking AND
 * the user isn't actively recording a question. */
let pendingModal = null;
function isAssistantBusy() {
  // wf.mode === "speaking" or "speaking-real" → Daniel is talking
  // listening / passive recording → user is talking
  return wf.mode === "speaking" || wf.mode === "speaking-real" ||
         (passiveRecorder && passiveRecorder.state === "recording");
}

/* ---------- INBOX DROP-AND-ASK ----------
 * Why: the bridge watches inbox/ and announces new files (see startInboxWatcher).
 * After the announcement Daniel asks "want me to look at it?". If the operator's NEXT
 * utterance is affirmative we route the file by kind into the matching tool. If it's
 * anything else (silence, "no", a different topic) we drop the pending state. */
let pendingInboxFile = null;

/** Build the LLM query for an inbox file. Routes by kind so Qwen calls the right tool. */
function inboxQueryFor(file) {
  switch (file.kind) {
    case "image":
      return `Describe the image at "${file.path}" using describe_image.`;
    case "video":
      return `Score the clip at "${file.path}" for trailer use with score_clip_for_trailer.`;
    case "pdf":
      return `The operator dropped a PDF at "${file.path}". Tell them PDF reading isn't wired yet — they should open it manually for now.`;
    default:
      return `The operator dropped a file at "${file.path}" of kind "${file.kind}". Acknowledge it and ask what they'd like done.`;
  }
}

/* ---------- CANCEL CONTROL ----------
 * Why: long-running tools (caption_shoot_folder, video_edit_from_shoot) can take 30s-3m.
 * The operator needs an out. Voice "stop" detection is a future enhancement; for now ESC
 * provides the affordance, but it has to be context-aware — pressing ESC when nothing is
 * happening shouldn't have Daniel say "Stopping" to thin air.
 *
 * Priority on ESC:
 *   1. Modal open (PDF / video / thumbnail) → close it, no speech.
 *   2. Active tool running (passive listening, recording, speaking, video edit in flight)
 *      → fire /cancel and speak a brief acknowledgement.
 *   3. Nothing happening → silent (just an info log, no speech, no fetch). */
async function cancelActiveTool(reason = "operator-cancel") {
  try {
    await fetch("http://localhost:8766/cancel", { method: "POST" });
    console.log("[Jarvis] cancel request sent:", reason);
    speak("Stopping.");
  } catch (e) {
    console.warn("[Jarvis] cancel failed:", e.message);
  }
}

function dismissTopModal() {
  for (const id of ["thumbWindow", "pdfWindow", "videoWindow"]) {
    const el = document.getElementById(id);
    if (el && el.isConnected) { el.remove(); return true; }
  }
  return false;
}

function isToolInFlight() {
  /* Active = currently doing something the operator might want to cancel. We treat
   * passive wake-listening as NOT cancellable (cancelling that should be done via the
   * wake button so the operator doesn't "lose" passive mode by reflex-pressing ESC). */
  if (wf.mode === "speaking" || wf.mode === "speaking-real") return true;
  if (passiveRecorder && passiveRecorder.state === "recording") return true;
  /* The bridge tracks long-running video edits via dbg "thumbnail" stage updates and the
   * existing video-edit progress events. If we recently saw a non-idle stateText, treat
   * it as in-flight. */
  if (stateText && /THINKING|RENDERING|PROCESSING/i.test(stateText.textContent || "")) return true;
  return false;
}

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  /* Step 1: close any open modal silently. Common case. */
  if (dismissTopModal()) { e.stopPropagation(); return; }
  /* Step 2: if something's actually running, cancel + speak. */
  if (isToolInFlight()) {
    cancelActiveTool("esc-key");
    e.stopPropagation();
    return;
  }
  /* Step 3: nothing to do — log only, don't speak. */
  console.log("[Jarvis] ESC pressed but nothing in flight — ignoring.");
}, true);

/* ---------- SLEEP / WAKE RESILIENCE ----------
 * Why: a kiosk Mac sleeps overnight. When the display wakes, the audio graph the page
 * built earlier is often suspended (AudioContext goes to "suspended"), the mic stream
 * may be revoked by the OS, and passive wake-word listening silently dies. The operator
 * walks up, says "Hey Jarvis", and nothing happens.
 *
 * On document.visibilityState transitioning back to "visible":
 *   1. Resume the audio context if suspended.
 *   2. Re-test the mic stream — if any track is "ended", drop it and re-acquire.
 *   3. If passive mode was on before sleep, restart it.
 */
let wasPassiveBeforeSleep = false;
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "hidden") {
    /* Track whether to auto-resume on wake. Don't pause anything actively — let the OS
     * handle it. We only need to know the pre-sleep intent. */
    wasPassiveBeforeSleep = passive;
    return;
  }
  if (document.visibilityState !== "visible") return;
  console.log("[Jarvis] page visible — checking audio graph");
  try {
    if (wf.audioCtx && wf.audioCtx.state === "suspended") {
      await wf.audioCtx.resume();
      console.log("[Jarvis] AudioContext resumed");
    }
    /* Why: getAudioTracks()[0].readyState === 'ended' means the OS revoked the stream
     * during sleep. Re-acquire by null-ing the cached stream so wfStartListening fetches
     * a fresh one on next call. */
    if (wf.micStream) {
      const track = wf.micStream.getAudioTracks()[0];
      if (!track || track.readyState === "ended") {
        try { wf.micStream.getTracks().forEach(t => t.stop()); } catch {}
        wf.micStream = null;
        console.log("[Jarvis] mic stream stale after sleep — will re-acquire");
      }
    }
    if (wasPassiveBeforeSleep && !passive) {
      console.log("[Jarvis] restoring passive listening after sleep");
      await startPassive();
    }
  } catch (e) {
    console.warn("[Jarvis] post-wake recovery failed:", e.message);
  }
});
function queueModal(showFn, announceText) {
  pendingModal = { showFn, announceText };
  drainModalQueue();
}
function drainModalQueue() {
  if (!pendingModal) return;
  if (isAssistantBusy()) {
    // try again shortly
    setTimeout(drainModalQueue, 400);
    return;
  }
  const { showFn, announceText } = pendingModal;
  pendingModal = null;
  if (announceText) speak(announceText);
  // Brief delay so the speak() onstart latches "speaking" first if it's about to play TTS,
  // otherwise the modal can pop simultaneously.
  setTimeout(() => { try { showFn(); } catch (e) { console.warn("modal show failed:", e); } }, announceText ? 800 : 0);
}

/* Result-window builders (showVideo / showPdf / showThumbnail) extracted to
 * ./modal-queue.js. Voice.js still owns queueModal() above because that scheduler
 * inspects voice/passive/TTS busy-state before popping a window — that logic
 * doesn't belong in a presentation module. Use Modal.showVideo / showPdf /
 * showThumbnail at the call sites. window.* aliases retained on Modal exports
 * elsewhere for the bridge's manual-trigger paths. */
window.showVideo = Modal.showVideo;
window.showThumbnail = Modal.showThumbnail;
window.showPdf = Modal.showPdf;

/** Show live + final transcript, ask real LLM via bridge, then speak. */
async function handleHeard(text, isFinal) {
  transcript.hidden = false;
  heardEl.textContent = text;
  if (!isFinal) return;

  /* Inbox follow-up: if we just announced a dropped file and the operator's reply is
   * affirmative, route the file into the matching tool. Anything non-affirmative drops
   * the pending state — the operator can still ask about the file by full path later. */
  if (pendingInboxFile) {
    const file = pendingInboxFile;
    pendingInboxFile = null;  // consume regardless of outcome
    if (WakeParse.isAffirmative(text)) {
      const inboxQuery = inboxQueryFor(file);
      setState("thinking");
      replyEl.textContent = "…";
      pushHistory("user", inboxQuery);
      let reply;
      try { reply = await speakStream(inboxQuery, conversationHistory.slice(0, -1)); }
      catch (e) {
        console.warn("[Jarvis] inbox stream failed, falling back:", e.message);
        try { reply = await askLLM(inboxQuery); } catch { reply = offlineFallback(); }
        replyEl.textContent = reply;
        await speak(reply);
      }
      pushHistory("assistant", reply);
      setState("idle");
      return;
    }
    /* Not affirmative — fall through to normal handling so "actually, draft an email…"
     * gets processed as a new query rather than getting stuck on the inbox prompt. */
  }

  const query = WakeParse.extractQuery(text);
  if (!query) {
    replyEl.textContent = "Yes?";
    speak("Yes?");
    return;
  }

  // No regex shortcuts — every command routes through the LLM which picks the right tool.
  setState("thinking");
  replyEl.textContent = "…";
  pushHistory("user", query);
  let reply;
  try {
    /* Streaming path: sentences play as they arrive — first audio in ~1s instead of
     * waiting for the full reply. Falls back to legacy askLLM + speak() on stream error
     * so a flaky bridge connection doesn't break the voice loop entirely. */
    reply = await speakStream(query, conversationHistory.slice(0, -1));
  } catch (e) {
    console.warn("[Jarvis] stream failed, falling back to non-streaming:", e.message);
    try { reply = await askLLM(query); }
    catch { reply = offlineFallback(); }
    replyEl.textContent = reply;
    speak(reply);
  }
  pushHistory("assistant", reply);
}

/* ---------- LOCAL WHISPER STT (replaces Chrome's cloud SpeechRecognition) ----------
 * Press-and-release model: tap wake button to start, MediaRecorder captures mic into a webm/opus blob,
 * tap again (or auto-stop on 1.2s silence) → WhisperStt.transcribeAndHandle() runs.
 * The chunks + speculative-partial state live in ./whisper-stt.js now.
 *
 * Why this URL still lives here even though whisper-stt.js owns its own copy:
 * the passive-mode cycle (cyclePassive) sends rolling 1-2s wake-detect clips
 * directly to /transcribe — it doesn't go through WhisperStt because passive
 * mode has its own VAD-based recording loop. Without this const passive's
 * fetch would throw ReferenceError, the silent catch would swallow it, and
 * every wake-detect attempt would see an empty transcript (which is exactly
 * the bug Adam hit after the whisper-stt extraction landed). */
const WHISPER_URL = "http://localhost:8768/transcribe";
let listening = false;
let mediaRecorder = null;
let silenceTimer = null;
let micStreamForRec = null;

/* ---------- PASSIVE WAKE-WORD MODE (adaptive voice-activity-detection) ----------
 * Adaptive: continually measures ambient noise level, sets START/SUSTAIN thresholds proportional to it.
 * Quiet room → low thresholds, noisy room → higher thresholds. End-of-speech detection works either way. */
let passive = false;
let passiveRecorder = null;

/* VAD primitives (currentRms, pushAmbient, vadThresholds, waitForVoiceStart,
 * waitForVoiceEnd) live in ./passive-vad.js. The cyclePassive controller
 * stays here because it touches handleHeard / askLLM / conversationHistory. */
const { currentRms, vadThresholds, waitForVoiceStart, waitForVoiceEnd } = PassiveVad;

async function startPassive() {
  if (passive) return;
  // Ensure mic + analyser open with the user's chosen device
  if (!wf.micStream) await wfStartListening();
  if (!wf.micStream) {
    dbgSet("error", "passive: no mic stream");
    return;
  }
  passive = true;
  setState("listening");
  wakeBtn.querySelector(".wake__inner").textContent = "WAKE LISTENING — TAP TO STOP";
  dbgSet("whisper", "(waiting for 'hey jarvis'…)");
  cyclePassive();
}

function stopPassive() {
  passive = false;
  /* Why: the old chunk-based passive used a passiveTimer for stop scheduling — VAD-based replacement
   * doesn't have a top-level timer, so just stopping the recorder is enough. */
  if (passiveRecorder && passiveRecorder.state !== "inactive") {
    try { passiveRecorder.stop(); } catch (_) {}
  }
  passiveRecorder = null;
  setState("idle");
  wakeBtn.querySelector(".wake__inner").textContent = "TAP / SAY \"HEY JARVIS\"";
}

/** Live-dictation hooks. While a voice utterance is being recorded, the
 *  whisper-stt module's streaming loop fires partial transcriptions every
 *  ~500ms; _dictationOnPartial writes that text into the typed-input
 *  textarea so the operator sees their speech transcribed in real time.
 *  _dictationOpenModal makes sure the modal is visible without grabbing
 *  focus from the listening UI. */
function _dictationOpenModal() {
  try {
    const bar   = document.getElementById("textInputBar");
    const field = document.getElementById("textInputField");
    if (!bar || !field) return;
    if (bar.hidden) {
      bar.hidden = false;
      document.body.classList.add("is-typing");
    }
    /* Clear leftover text from a previous turn, but only if no one's currently
     * typing (the operator may be mid-type when a wake fires in the background). */
    if (document.activeElement !== field) field.value = "";
  } catch {}
}

function _dictationOnPartial(text) {
  try {
    const field = document.getElementById("textInputField");
    /* Strip wake-word from the live preview so the operator doesn't see
     * "hey jarvis, …" in the textarea as they speak. */
    const stripped = WakeParse.containsWake(text) ? WakeParse.extractQuery(text) : text;
    if (field) field.value = stripped;
    /* Fan out to any other panel that subscribes to live STT partials
     * (the influencer wizard auto-fills chips from this stream). */
    window.dispatchEvent(new CustomEvent("jarvis.stt.partial", { detail: { text } }));
  } catch {}
}

/** Stream-driven cycle: wait for voice → record full utterance → transcribe → check wake.
 *
 *  Performance instrumentation: drops `performance.mark()` calls at every
 *  pipeline stage (T1 sprint work). Marks are zero-cost in browsers and let
 *  us measure wake→audio latency without intrusive console.log spam. The
 *  HUD reads `performance.getEntriesByType("measure")` after each cycle and
 *  POSTs to `/perf` so the bridge can aggregate p50/p95 across sessions. */
async function cyclePassive() {
  if (!passive || !wf.micStream) return;
  const stream = wf.micStream;
  dbgSet("whisper", "(waiting for voice…)");

  // Step 1: wait until the user starts speaking
  const started = await waitForVoiceStart();
  if (!started) return;
  /* Mark the moment voice is first detected — this is the beginning of
   * the perceived "wake" event from the operator's perspective. */
  try { performance.mark("v.wake-start"); } catch {}

  // Step 2: record until VAD says they finished
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
  passiveRecorder = rec;
  /* Live-dictation: push each MediaRecorder chunk into WhisperStt so its
   * streaming loop can transcribe the growing audio every ~500ms. The
   * partial listener writes the latest transcript into the typed-input
   * textarea so the operator sees their speech transcribed live. On
   * utterance end (VAD silence) we submit that text through the typed
   * path instead of waiting for a final whisper round-trip. */
  WhisperStt.resetForNewTurn();
  WhisperStt.setPartialListener(_dictationOnPartial);
  _dictationOpenModal();
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) {
      chunks.push(e.data);
      WhisperStt.pushChunk(e.data);
    }
  };
  rec.start(250);
  WhisperStt.startStreaming();
  dbgSet("whisper", "(recording…)");
  const t = vadThresholds();
  fetch("http://localhost:8766/log", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "vad", msg: `voice start  ambient=${t.ambient.toFixed(4)} start=${t.start.toFixed(4)} sustain=${t.sustain.toFixed(4)}` }),
  }).catch(() => {});

  const reason = await waitForVoiceEnd();
  if (rec.state !== "inactive") { try { rec.stop(); } catch (_) {} }
  // Wait for the final ondataavailable
  await new Promise((r) => { rec.onstop = r; });
  try { performance.mark("v.rec-end"); } catch {}
  /* Stop the streaming whisper loop; from this point we already have the
   * latest live transcript and don't need more partials. The listener is
   * detached so the next turn starts clean. */
  WhisperStt.stopStreaming();
  WhisperStt.setPartialListener(null);

  if (!passive) return;
  if (chunks.length === 0) { cyclePassive(); return; }

  // Step 3: transcribe the full utterance
  const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
  fetch("http://localhost:8766/log", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "vad", msg: `voice end (${reason}) ${(blob.size / 1024).toFixed(1)}KB` }),
  }).catch(() => {});

  let heard = "";
  let whisperTranscribeMs = null;
  /* Live-dictation fast path: if the streaming loop captured text, use it
   * and skip the final whisper round-trip (~300-450ms saved). The streaming
   * transcribes the same audio on a slight delay anyway, so the latest
   * partial usually matches the final transcript well enough for the
   * fast-path tools that don't need pinpoint phrasing. */
  const liveText = WhisperStt.getStreamLatest();
  if (liveText && liveText.length >= 3) {
    heard = liveText;
    try { performance.mark("v.whisper-req"); } catch {}
    try { performance.mark("v.whisper-res"); } catch {}
  } else {
    try {
      try { performance.mark("v.whisper-req"); } catch {}
      const res = await fetch(WHISPER_URL, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: blob,
      });
      try { performance.mark("v.whisper-res"); } catch {}
      if (res.ok) {
        const j = await res.json();
        heard = (j.text || "").trim();
        /* Whisper server reports its own internal time (T1.1c) so we can
         * separate network/serialisation cost from model inference cost. */
        if (typeof j.transcribe_ms === "number") whisperTranscribeMs = j.transcribe_ms;
      }
    } catch (e) { console.warn("[Jarvis] passive whisper failed:", e.message); }
  }

  // Forward every transcript to bridge log
  fetch("http://localhost:8766/log", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "passive", msg: heard, data: { wake: WakeParse.containsWake(heard) } }),
  }).catch(() => {});
  dbgSet("whisper", heard ? `"${heard}"` : "(empty)");

  /* Whisper hallucination filter. Whisper's training data includes a lot
   * of YouTube subtitle text — it falls back to phrases like "music",
   * "thanks for watching", "subscribe" when given near-silent input.
   * Without this filter, ambient room noise that sneaks past the VAD
   * gets transcribed as a coherent phrase, the bridge treats it as a
   * follow-up query, and Jarvis hallucinates a response (e.g. "playing
   * driving music" when the operator said nothing).
   *
   * Strategy:
   *   1. Reject any transcript on tiny audio blobs (<8KB ≈ 1-2s).
   *      Real wake words + queries are almost always >10KB.
   *   2. Reject known-hallucination phrase exact matches (lowercased,
   *      stripped of trailing punctuation).
   *   3. Reject single-word transcripts <6 chars on small blobs (<12KB).
   *      Catches "Music." / "You." / "Bye." style fallbacks.
   *
   * The filter is conservative — false negatives (real speech rejected)
   * matter more than false positives (hallucinations let through), so
   * the thresholds err toward letting real input through. The "Hey
   * Jarvis" wake clip is typically 12-20KB; a one-word query like
   * "weather" is typically 8-14KB. Real input on the boundary stays
   * because the wake-word detection downstream still fires correctly. */
  if (heard && _isWhisperHallucination(heard, blob.size / 1024)) {
    fetch("http://localhost:8766/log", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tag: "passive-reject", msg: `hallucination filter: "${heard}" (${(blob.size / 1024).toFixed(1)}KB)` }),
    }).catch(() => {});
    return;
  }

  if (heard) {
    // 1. In conversation mode, check for dismissal first — save conversation summary before exiting
    if (Conversation.isActive() && WakeParse.isDismissal(heard)) {
      // Ask LLM to save_conversation with a summary of what just happened, then exit.
      try {
        if (conversationHistory.length >= 2) {
          await askLLM("Wrap up: call save_conversation with a 2-sentence summary of what we just discussed and a topics array. Reply with 'saved'.");
        }
      } catch {}
      Conversation.exit();
      await speak("Right you are, sir. Standing by.");
      if (passive) cyclePassive();
      return;
    }

    // 2. Either we heard the wake word OR we're already in conversation — handle the query
    const wakeHeard = WakeParse.containsWake(heard);
    if (wakeHeard || Conversation.isActive()) {
      const query = wakeHeard ? WakeParse.extractQuery(heard) : heard;
      /* Speedo wake-flick: brief 0→40 mph pop on wake-word detection, before the
       * listening state engages. Same vibe as the camera's "lock on" — visible
       * acknowledgement that the kiosk caught the wake even before audio confirms. */
      if (wakeHeard) window.__speedo?.flash?.("flick");
      Conversation.resetIdleTimer();

      if (query.length >= 2) {
        // Wake + query (or in-conversation utterance): process it
        if (!Conversation.isActive()) Conversation.enter();
        passive = false;
        wakeBtn.querySelector(".wake__inner").textContent = "PROCESSING…";
        await handleHeard(heard, true);
        /* Summarise the perf marks dropped throughout the cycle into a
         * single span report and POST to the bridge. The bridge accumulates
         * a rolling buffer that the debug panel queries via /health/timings.
         * Wrapped in try/catch so a perf-API quirk never breaks the loop. */
        try { _reportPerfTimings(heard, whisperTranscribeMs); } catch {}
        /* Notify any query-handled subscribers (first-run tour, analytics
         * hooks). Fire-and-forget — subscriber errors are caught upstream. */
        _emitQueryHandled({ heard, query, replied: true });
        if (passive === false) {
          passive = true;
          setState("listening");
          if (Conversation.isActive()) wakeBtn.querySelector(".wake__inner").textContent = "CONVERSATION — TAP TO STOP";
        }
      } else if (wakeHeard) {
        // Bare wake word — snappy acknowledgement, enter conversation
        await Conversation.acknowledgeBareWake();
      }
    }
  }

  if (passive) cyclePassive();
}

async function startListening() {
  if (listening) return;
  /* Reuse the mic stream that wfStartListening already opened — avoids two getUserMedia prompts. */
  const stream = wf.micStream;
  if (!stream) {
    console.warn("[Jarvis] no mic stream — wfStartListening failed");
    wakeBtn.querySelector(".wake__inner").textContent = "MIC BLOCKED — CHECK PERMISSIONS";
    return;
  }

  /* Whisper-STT module owns the audio chunks + speculative-partial state.
   * This call clears last turn's leftovers (partial text, in-flight promise,
   * stale chunks) so a new recording starts from zero. */
  WhisperStt.resetForNewTurn();
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
  mediaRecorder.ondataavailable = (e) => WhisperStt.pushChunk(e.data);
  mediaRecorder.onstop = () => WhisperStt.transcribeAndHandle();

  mediaRecorder.start(250);
  listening = true;
  setState("listening");
  wakeBtn.querySelector(".wake__inner").textContent = "RECORDING — TAP TO STOP";
  dbgSet("chunks", "0");
  dbgSet("upload", "—");
  dbgSet("whisper", "—");
  dbgSet("peak", "(recording…)");

  startSilenceWatcher();
}

function stopListening() {
  if (!listening) return;
  listening = false;
  clearTimeout(silenceTimer);
  silenceTimer = null;
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (_) {}
  }
  /* Why: keep wf.micStream open so the listening waveform can keep rendering between turns.
   * The user releases by tapping; we don't tear down the device unless they truly stop. */
  wakeBtn.querySelector(".wake__inner").textContent = "TAP / SAY \"HEY JARVIS\"";
}

/** Lightweight silence-based auto-stop. Reads the existing wf.analyser buffer (which we attached
 *  in wfStartListening) and computes RMS. Once RMS stays below threshold for THRESHOLD_MS, stop. */
function startSilenceWatcher() {
  const SILENCE_RMS = 0.012;
  /* Why: was 1400ms — operators sat through a noticeable pause after every
   * utterance. With MLX Whisper at ~450ms hot, this silence-tail became the
   * largest fixed cost in the loop. 800ms keeps a small mid-sentence pause
   * tolerance (a quick breath / "and uh") while shaving 600ms off every turn.
   * The MIN_TALK_MS guard below still requires real speech before silence
   * detection arms, so a quick taps-the-wake-button-and-says-nothing can't
   * cause a 800ms phantom record. */
  const SILENCE_MS = 800;
  const MIN_TALK_MS = 600;        // require some voice activity first
  let lastVoiceAt = Date.now();
  let everSpoke = false;

  const tick = () => {
    if (!listening) return;
    if (wf.analyser && wf.buffer) {
      wf.analyser.getByteTimeDomainData(wf.buffer);
      let sumSq = 0;
      for (let i = 0; i < wf.buffer.length; i++) {
        const v = (wf.buffer[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / wf.buffer.length);
      if (rms > SILENCE_RMS) {
        lastVoiceAt = Date.now();
        if (!everSpoke && Date.now() - silenceWatcherStart > MIN_TALK_MS) everSpoke = true;
        if (rms > SILENCE_RMS * 2) everSpoke = true;
      }
      if (everSpoke && Date.now() - lastVoiceAt > SILENCE_MS) {
        console.log("[Jarvis] auto-stop on silence");
        stopListening();
        return;
      }
    }
    silenceTimer = setTimeout(tick, 100);
  };
  const silenceWatcherStart = Date.now();
  silenceTimer = setTimeout(tick, 200);
}


/* First-run setup modal + the saved-preference accessors moved to
 * ./setup-modal.js. window.getTierPreset is re-exposed below for HUD
 * code that reads the throttle preset off the global. */
window.getTierPreset = SetupModal.getTierPreset;



/* ---------- WIRE UP UI ---------- */
function wireUI() {
  // Apply the saved performance tier as a body class so CSS rules can adapt
  document.body.classList.add(`tier-${SetupModal.getSavedTier()}`);

  /* Connect to bridge + register all typed event subscribers. Idempotent —
   * Bridge.connect() reuses an existing socket if one is open. */
  wireBridgeEvents();

  /* Expose the heard-handler to the command palette (Cmd+K). The palette
   * dispatches free-text by calling this hook; reuses the entire voice
   * loop (askLLMStream → tool dispatch → TTS → conversation persistence)
   * so the keyboard path is identical to mic. */
  window.__paletteDispatch = (text) => {
    if (!text) return;
    /* Force conversation mode on so a single palette query gets the same
     * follow-up window the wake-word path gets. */
    Conversation.enter();
    handleHeard(text, true);
  };

  wfInit();   // start the state-aware waveform on boot
  refreshDevicePicker();   // populate the input dropdown + auto-select non-built-in
  wireDeviceChange();      // self-heal cached mic stream when macOS routes audio elsewhere
  /* Wire deps into the mic-test + setup-modal modules before maybeShowSetup
   * runs. Idempotent — re-init on profile switch picks up the new wf
   * instance if the operator switches mid-session. */
  MicTest.init({ dbgSet, getPreferredDeviceId, setPreferredDevice, refreshDevicePicker, wf });
  /* WhisperStt owns the audio chunks + speculative partial. It needs UI
   * callbacks for the "transcribing…" / error / fallback messaging plus
   * the AudioContext for the local peak-amplitude diagnostic. We pass a
   * getter for the AudioCtx since wf.audioCtx is created lazily on first
   * mic acquisition. */
  WhisperStt.setHandlers({
    setState,
    replyEl,
    transcript,
    speak,
    handleHeard,
    dbgSet,
    getAudioCtx: () => wf.audioCtx,
  });
  /* Demo recorder shares the AudioContext + mic with the voice loop.
   * ensureMicStream → wfStartListening so the recorder can guarantee a
   * mic before screen-capture starts. */
  DemoRecorder.setHandlers({
    getAudioCtx: () => wf.audioCtx,
    getMicStream: () => wf.micStream,
    ensureMicStream: () => wfStartListening(),
  });
  /* Conversation mode owns the multi-turn state but voice.js owns the wake
   * button DOM + speak() function + conversation history. Pass them in. */
  Conversation.setHandlers({
    wakeBtnLabel: (text) => {
      if (wakeBtn) wakeBtn.querySelector(".wake__inner").textContent = text;
    },
    speak,
    clearHistory,
  });
  /* TTS pipeline owns the speaking-analyser, barge-in monitor, and the
   * streaming-LLM-to-Kokoro plumbing. Wire all the cross-module deps:
   * UI side-effects (setState/replyEl/transcript), shared waveform state
   * (wf), engagement check (passive || listening drives barge-in), mic
   * RMS reader, voice picker, bridge transport, demo-recorder hooks. */
  /* Bridge-event handlers need speak() (TTS pipeline), queueModal (still
   * lives in voice.js), and a writer for the pendingInboxFile state
   * (voice.js owns it because handleHeard reads it during inbox follow-up). */
  BridgeEvents.setHandlers({
    speak,
    queueModal,
    setPendingInboxFile: (file) => { pendingInboxFile = file; },
    modal: Modal,
  });
  /* Passive-VAD math layer needs the analyser+buffer pair (which voice.js
   * owns via wf.analyser/wf.buffer — gettable each tick because the slots
   * can be nulled by devicechange / sleep) and two boolean state probes. */
  PassiveVad.setHandlers({
    getAnalyserBuf: () => (wf.analyser && wf.buffer ? { analyser: wf.analyser, buffer: wf.buffer } : null),
    isPassive: () => passive,
    isSpeaking: () => wf.mode === "speaking" || wf.mode === "speaking-real",
  });
  TtsPipeline.setHandlers({
    setState,
    replyEl,
    transcript,
    wf,
    isEngaged: () => passive || listening,
    currentRms,
    getKokoroVoice,
    bridgeOn: (type, fn) => Bridge.on(type, fn),
    bridgeAsk: (payload) => Bridge.ask(payload),
    getSessionId,
    getRecDestination: () => DemoRecorder.getRecDestination(),
    tapTtsToRec: (analyser) => DemoRecorder.tapTtsToRec(analyser),
    isTtsMuted: () => _ttsMuted,
  });
  /* Wire the mute button + text-input toggle + text-input bar. All three live
   * in the wake-row HTML and reuse the existing speakStream pipeline so voice
   * and text take the same path — only the entry point differs. */
  initTtsMuteToggle();
  initTextInputBar();
  SetupModal.init({ autoPickMic: MicTest.autoPickMic, getPreferredDeviceId, setPreferredDevice, wf });
  SetupModal.maybeShowSetup();        // first-run setup modal (no-op after first completion)

  // Cmd/Ctrl+Shift+R toggles demo recording — Shift gate avoids the bare
  // Cmd/Ctrl+R reload shortcut while still using a modifier-gated key per
  // the unified shortcut policy (no bare letters).
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      DemoRecorder.toggleDemoRecording();
    }
  });

  /* Tap wake → toggle PASSIVE wake-word listening.
   * In passive mode, we constantly transcribe rolling 3s chunks (skipping silence)
   * and watch for "hey jarvis" in the result. User can say the whole query in one breath. */
  wakeBtn.addEventListener("click", async () => {
    if (passive) {
      stopPassive();
    } else if (listening) {
      stopListening();
    } else {
      await wfStartListening();
      await startPassive();
    }
  });

  speechSynthesis.onvoiceschanged = () => { /* prime the voice list */ };

  // Wire the debug "TEST MIC" button
  const testBtn = document.getElementById("dbgTestBtn");
  if (testBtn) testBtn.addEventListener("click", MicTest.runMicTest);

  SettingsModal.wireSettingsModal({ applyAccessibilityPrefs, applyCameraVisibility });
}

/* ────────── Settings modal ──────────
 * Persists changes via /settings on the bridge (voice → brand.json, model → .env
 * + live setModel). Cog button opens the modal; operator picks voice/model and
 * previews voice before committing. */
/* Settings modal helpers + wireSettingsModal moved to ./settings-modal.js.
 * Wired in via SettingsModal.wireSettingsModal({ ... }) inside wireUI(). */


/* Expose a typed-query entry point for the command palette + future help cheatsheet.
 * Same pipeline as voice — runs the query through handleHeard(text, isFinal=true). */
window.__runQuery = (text) => handleHeard(String(text || "").trim(), true);

document.addEventListener("DOMContentLoaded", wireUI);
