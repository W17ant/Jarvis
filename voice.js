/** voice.js - Flat-Out voice loop.
 *  Web Speech API for mic + Kokoro TTS for output, Qwen 2.5 brain via the local bridge.
 *  Wake phrase + branding are loaded at runtime from /brand so the same codebase can be
 *  re-skinned without code changes — primary install is Flat-Out Media. */

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

/* Profile-namespaced Storage helper now lives in ./storage.js (imported above).
 * Same API: Storage.get / Storage.set / Storage.remove with bare logical names. */

/* Why: defaults match the Flat-Out canonical install but get overridden by /brand response.
 * Kept mutable (let) so brand fetch on init can swap them in before the recognizer starts. */
let WAKE_PHRASE = "hey flat-out";
let WAKE_VARIANTS = [
  "hey flat-out", "hey flat out", "hey flatout", "hey flatouts",
  "hi flat-out", "hi flat out", "hi flatout",
  "hey, flat-out", "hey, flat out",
  "flat-out", "flat out", "flatout", "flatouts",
];
let AGENT_NAME = "Flat-Out";

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
    /* Push brand state into the wake-parsing module so containsWake /
     * extractQuery use the right variants + agent name. */
    WakeParse.setBrand({ agentName: AGENT_NAME, wakeVariants: WAKE_VARIANTS });
    console.log(`[voice] brand loaded: agent="${AGENT_NAME}" wake="${WAKE_PHRASE}" variants=${WAKE_VARIANTS.length}`);
  } catch (e) {
    console.warn("[voice] /brand fetch failed, using Flat-Out defaults:", e.message);
  }
}
/* Fire-and-forget — boot path doesn't await, but variants are mutated before the first wake check. */
loadBrandIntoVoice();

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
    ctx.strokeStyle = "#E10600";
    ctx.shadowColor = "rgba(225,6,0,0.7)";
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
  } else if (wf.mode === "speaking") {
    /* Synthetic fallback for non-Kokoro TTS paths. */
    wf.speakingAmp = wf.speakingAmp * 0.85 + Math.random() * 0.15;
    const amp = 0.4 + wf.speakingAmp * 0.6;
    wf.phase += 0.35;
    const mid = h / 2;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = "#E10600";
    ctx.shadowColor = "rgba(225,6,0,0.6)";
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
    wf.phase += 0.6;
    const mid = h / 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(225,6,0,0.45)";
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
    /* Refresh the device picker label so the dropdown reflects the new
     * default input — useful even if no stream is currently cached. */
    refreshDevicePicker().catch(() => {});
    if (wf.micStream) {
      console.log("[Flat-Out] devicechange — dropping cached mic stream");
      try { wf.micStream.getTracks().forEach((t) => t.stop()); } catch {}
      wf.micStream = null;
      /* Analyser was wired to the OLD stream's MediaStreamSource — must
       * also be cleared so wfStartListening rebuilds it against the new
       * stream. Otherwise the analyser keeps pulling from a silent source
       * and the waveform would render flat after a device swap. */
      wf.analyser = null;
      wf.buffer = null;
      dbgSet("device", "(reacquiring on next wake)");
    }
    /* If passive listening was running, restart it on the new mic. The
     * passive loop reads wf.micStream lazily, so we just need to re-trigger
     * it. Without this, the operator stays in passive mode but the mic is
     * the now-stale (null) stream and wake words go unheard. */
    if (passive) {
      console.log("[Flat-Out] devicechange — restarting passive on new mic");
      stopPassive();
      /* Tiny delay so the OS has time to publish the new default input
       * before we call enumerateDevices/getUserMedia. */
      setTimeout(() => { startPassive().catch(() => {}); }, 250);
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
    console.warn("[Flat-Out] mic init failed:", e.message);
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

/** Set HUD state — drives speedo glow, readout text, and waveform mode. */
function setState(state) {
  speedo.classList.remove("is-listening", "is-thinking", "is-speaking");
  switch (state) {
    case "listening": speedo.classList.add("is-listening"); stateText.textContent = "LISTENING"; wfStartListening(); break;
    case "thinking":  speedo.classList.add("is-thinking");  stateText.textContent = "PROCESSING"; wfSetIdle(); break;
    case "speaking":  speedo.classList.add("is-speaking");  stateText.textContent = "SPEAKING";  wfSetSpeaking(); break;
    default:          stateText.textContent = "STANDBY";    wfSetIdle(); break;
  }
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

/* task.* — drives the bottom-strip progress UI + speedo mood. */
function handleTaskEvent(m) {
  window.__tasks?.handleEvent(m);
  const sp = window.__speedo;
  if (!sp || !m.data?.runId) return;
  if (m.type === "task.start") {
    /* Voice always wins over background tasks — only swap to task mood if no
     * conversational state is currently active. */
    const speedoEl = document.getElementById("speedo");
    const inVoice = speedoEl?.classList.contains("is-listening")
                 || speedoEl?.classList.contains("is-thinking")
                 || speedoEl?.classList.contains("is-speaking");
    if (!inVoice) sp.setMood("task");
  } else if (m.type === "task.progress") {
    if (m.data.percent != null) sp.setProgress(m.data.percent / 100);
  } else if (m.type === "task.complete") {
    sp.flash("redline");
    sp.setProgress(0);
    sp.setMood("idle");
  } else if (m.type === "task.error") {
    sp.flash("amber");
    sp.setProgress(0);
    sp.setMood("idle");
  }
}

function handleVideoEditComplete(m) {
  if (!m.data?.finalUrl) return;
  const url = `http://localhost:8766${m.data.finalUrl}`;
  console.log(`[Flat-Out] video edit complete: ${m.data.subject} (${m.data.durationSec}s build)`);
  queueModal(() => Modal.showVideo(url, { subject: m.data.subject, runId: m.data.runId }),
             `Your ${m.data.subject || "shoot"} teaser is ready.`);
}

function handleVideoEditError(m) {
  /* Why: legacy events used { error } at the top level; the audit standardised on
   * { data: { error } }. Read both for compatibility while older code paths exist. */
  const err = m.data?.error || m.error || "(no detail)";
  console.warn("[Flat-Out] video edit failed:", err);
  speak("The edit pipeline ran into a problem. Check the bridge logs.");
}

function handlePdfComplete(m) {
  if (!m.data?.url) return;
  const url = `http://localhost:8766${m.data.url}`;
  console.log(`[Flat-Out] pdf ready: ${m.data.template} (${m.data.sizeKB}KB)`);
  queueModal(() => Modal.showPdf(url, { template: m.data.template, title: m.data.title }), null);
}

function handleThumbnailComplete(m) {
  if (!m.data?.url) return;
  /* Why: pop the rendered thumbnail in the same modal pattern as PDFs/videos so the
   * client demo looks coherent. Generation is fast enough we don't need a progress
   * spinner — by the time Daniel finishes saying "thumbnail ready" the image is up. */
  const url = `http://localhost:8766${m.data.url}`;
  console.log(`[Flat-Out] thumbnail ready: ${m.data.headline} (${m.data.sizeKB}KB)`);
  queueModal(() => Modal.showThumbnail(url, { headline: m.data.headline, subhead: m.data.subhead }), null);
}

function handleThumbnailProgress(m) {
  /* Surface stage transitions as a brief on-state sub-label so screen recordings show progress.
   * Stages: starting → captioning-folder → picking-hero → picking-engine → rendering → done */
  const stages = {
    "starting": "Starting thumbnail…",
    "captioning-folder": "Reading the shoot…",
    "picking-hero": "Picking hero shot…",
    "picking-engine": "Finding the engine shot…",
    "rendering": "Composing thumbnail…",
    "done": "Thumbnail ready.",
  };
  const label = stages[m.stage];
  if (label) dbgSet("thumbnail", label);
}

function handleInboxDropped(m) {
  if (!m.data?.path) return;
  /* Why: drop-and-ask UX. The bridge watches inbox/ and broadcasts when a new file
   * lands. Speak a short prompt offering the relevant action — operator can ignore
   * (no answer = no action) or say yes to trigger the appropriate tool. */
  console.log(`[Flat-Out] inbox: ${m.data.name} (${m.data.kind}, ${m.data.sizeKB}KB)`);
  const verb = m.data.kind === "image" ? "describe it"
             : m.data.kind === "video" ? "score it for the trailer"
             : m.data.kind === "pdf"   ? "summarise it"
             : "have a look";
  const prompt = `I see ${m.data.name} in the inbox. Want me to ${verb}?`;
  pendingInboxFile = { path: m.data.path, kind: m.data.kind, name: m.data.name };
  queueModal(() => {}, prompt);
}

/** Connect + register all bridge event subscribers. Called once at boot. */
function wireBridgeEvents() {
  Bridge.connect();
  Bridge.on("task.*",                 handleTaskEvent);
  Bridge.on("video.edit.complete",    handleVideoEditComplete);
  Bridge.on("video.edit.error",       handleVideoEditError);
  Bridge.on("pdf.complete",           handlePdfComplete);
  Bridge.on("yt.thumbnail.complete",  handleThumbnailComplete);
  Bridge.on("yt.thumbnail.progress",  handleThumbnailProgress);
  Bridge.on("inbox.dropped",          handleInboxDropped);
  Bridge.on("state.sleep",            handleEnterSleep);
  TimerHud.register(Bridge);
}

/** Bridge dispatched the enter_sleep_mode tool — mute the mic, dim the HUD,
 *  and stop any in-flight TTS. The operator wakes Jarvis again by clicking
 *  the speedometer (which calls wfStartListening) or saying the wake word. */
function handleEnterSleep() {
  try { stopListening(); } catch (e) { console.warn("[Flat-Out] stopListening failed:", e.message); }
  try { fetch("http://localhost:8766/cancel", { method: "POST" }); } catch {}
  const speedo = document.getElementById("speedo");
  if (speedo) {
    speedo.classList.remove("is-listening");
    speedo.classList.add("is-asleep");
  }
  const stateText = document.getElementById("stateText");
  if (stateText) stateText.textContent = "ASLEEP";
  console.log("[Flat-Out] entered sleep — mic muted, awaiting wake");
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
    let id = localStorage.getItem("flatout.sessionId");
    if (!id) {
      id = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem("flatout.sessionId", id);
    }
    return id;
  } catch { return null; }
}

/* Why: 60s timeout used to be enough but composite tools like describe_shoot_with_specs
 * legitimately need ~30-90s when they chain caption+search+synthesis. Bumped to 120s as a
 * backstop; the bridge still logs per-stage timings so genuine hangs are spottable. */
function askLLM(query, timeoutMs = 120000) {
  return Bridge.ask({
    type: "llm.ask",
    payload: { query, history: conversationHistory.slice(), sessionId: getSessionId() },
  }, timeoutMs);
}

/** Last-resort message if bridge is down. */
function offlineFallback() {
  return "I'm running offline at the moment — the local model bridge isn't reachable. Check the bridge logs and try again.";
}

/** Voice id resolver — single source of truth for which Kokoro voice to use. */
function getKokoroVoice() { return Storage.get("voice", "bm_daniel"); }

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
    console.log("[Flat-Out] cancel request sent:", reason);
    speak("Stopping.");
  } catch (e) {
    console.warn("[Flat-Out] cancel failed:", e.message);
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
  console.log("[Flat-Out] ESC pressed but nothing in flight — ignoring.");
}, true);

/* ---------- SLEEP / WAKE RESILIENCE ----------
 * Why: a kiosk Mac sleeps overnight. When the display wakes, the audio graph the page
 * built earlier is often suspended (AudioContext goes to "suspended"), the mic stream
 * may be revoked by the OS, and passive wake-word listening silently dies. The operator
 * walks up, says "Hey Flat-Out", and nothing happens.
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
  console.log("[Flat-Out] page visible — checking audio graph");
  try {
    if (wf.audioCtx && wf.audioCtx.state === "suspended") {
      await wf.audioCtx.resume();
      console.log("[Flat-Out] AudioContext resumed");
    }
    /* Why: getAudioTracks()[0].readyState === 'ended' means the OS revoked the stream
     * during sleep. Re-acquire by null-ing the cached stream so wfStartListening fetches
     * a fresh one on next call. */
    if (wf.micStream) {
      const track = wf.micStream.getAudioTracks()[0];
      if (!track || track.readyState === "ended") {
        try { wf.micStream.getTracks().forEach(t => t.stop()); } catch {}
        wf.micStream = null;
        console.log("[Flat-Out] mic stream stale after sleep — will re-acquire");
      }
    }
    if (wasPassiveBeforeSleep && !passive) {
      console.log("[Flat-Out] restoring passive listening after sleep");
      await startPassive();
    }
  } catch (e) {
    console.warn("[Flat-Out] post-wake recovery failed:", e.message);
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
        console.warn("[Flat-Out] inbox stream failed, falling back:", e.message);
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
    console.warn("[Flat-Out] stream failed, falling back to non-streaming:", e.message);
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
const VAD_SILENCE_MS   = 1100;    // sustained silence ends the utterance
const VAD_MAX_REC_MS   = 15000;
const VAD_TICK_MS      = 60;
const VAD_FLOOR_MIN    = 0.005;   // hard minimums so a perfectly silent room doesn't trigger on micro-noise
const VAD_START_MIN    = 0.014;
const VAD_SUSTAIN_MIN  = 0.009;
const VAD_START_RATIO  = 2.8;     // start threshold = max(MIN, ambient × this)
const VAD_SUSTAIN_RATIO = 1.8;
const VAD_AMBIENT_WIN  = 60;      // ~60 × VAD_TICK_MS = 3.6s rolling window

/** Rolling ambient noise estimator. We push every sample taken during "not recording" periods. */
const ambientWindow = [];
function pushAmbient(rms) {
  ambientWindow.push(rms);
  if (ambientWindow.length > VAD_AMBIENT_WIN) ambientWindow.shift();
}
function getAmbient() {
  if (ambientWindow.length < 10) return VAD_FLOOR_MIN;
  // Why: 60th percentile is robust to brief voice spikes that haven't been filtered out
  const sorted = [...ambientWindow].sort((a, b) => a - b);
  return Math.max(VAD_FLOOR_MIN, sorted[Math.floor(sorted.length * 0.6)]);
}
function vadThresholds() {
  const a = getAmbient();
  return {
    start:   Math.max(VAD_START_MIN,   a * VAD_START_RATIO),
    sustain: Math.max(VAD_SUSTAIN_MIN, a * VAD_SUSTAIN_RATIO),
    ambient: a,
  };
}

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
  dbgSet("whisper", "(waiting for 'hey flat-out'…)");
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
  wakeBtn.querySelector(".wake__inner").textContent = "TAP / SAY \"HEY FLAT-OUT\"";
}

/** Read live RMS from the wf analyser. Returns 0..1. */
function currentRms() {
  if (!wf.analyser || !wf.buffer) return 0;
  wf.analyser.getByteTimeDomainData(wf.buffer);
  let sumSq = 0;
  for (let i = 0; i < wf.buffer.length; i++) {
    const v = (wf.buffer[i] - 128) / 128;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / wf.buffer.length);
}

/** Wait until RMS rises above the adaptive start threshold. While waiting, every sample feeds
 *  the rolling ambient estimate (since by definition no voice is present yet).
 *
 *  Why the speaking-guard: the kiosk has no echo cancellation, so when Daniel's voice plays
 *  back through speakers the mic picks it up and VAD treats it as a fresh utterance. That
 *  led to spurious passive recordings that competed for the AudioContext mid-speech, which
 *  the operator perceived as Daniel's replies "cutting off". We just hold here until the
 *  speaking flag clears, then resume normal listening. */
function waitForVoiceStart() {
  return new Promise((resolve) => {
    const tick = () => {
      if (!passive) return resolve(false);
      /* Hold while Daniel is speaking — don't record his own voice. */
      if (wf.mode === "speaking" || wf.mode === "speaking-real") {
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
 *  - Short utterances (< 1.5s of voice): assume bare wake word, trigger after 600ms silence (snappy ack)
 *  - Longer queries: require full 1100ms (tolerates natural mid-sentence pauses) */
const VAD_SHORT_VOICE_MS  = 1500;   // boundary between "wake word alone" vs "wake + question"
const VAD_SHORT_SILENCE_MS = 600;   // snappy trigger when voice was short

function waitForVoiceEnd() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let lastVoiceAt = Date.now();
    let voiceMs = 0;
    const tick = () => {
      if (!passive) return resolve("aborted");
      const elapsed = Date.now() - startedAt;
      if (elapsed > VAD_MAX_REC_MS) return resolve("max");
      const rms = currentRms();
      const { sustain } = vadThresholds();
      if (rms > sustain) {
        lastVoiceAt = Date.now();
        voiceMs += VAD_TICK_MS;
      }
      // Short voice → snappy silence trigger; longer voice → patient silence trigger
      const silenceThreshold = voiceMs < VAD_SHORT_VOICE_MS ? VAD_SHORT_SILENCE_MS : VAD_SILENCE_MS;
      if (Date.now() - lastVoiceAt > silenceThreshold) return resolve(voiceMs < VAD_SHORT_VOICE_MS ? "short-silence" : "silence");
      setTimeout(tick, VAD_TICK_MS);
    };
    tick();
  });
}

/** Stream-driven cycle: wait for voice → record full utterance → transcribe → check wake. */
async function cyclePassive() {
  if (!passive || !wf.micStream) return;
  const stream = wf.micStream;
  dbgSet("whisper", "(waiting for voice…)");

  // Step 1: wait until the user starts speaking
  const started = await waitForVoiceStart();
  if (!started) return;

  // Step 2: record until VAD says they finished
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
  passiveRecorder = rec;
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  rec.start(250);
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

  if (!passive) return;
  if (chunks.length === 0) { cyclePassive(); return; }

  // Step 3: transcribe the full utterance
  const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
  fetch("http://localhost:8766/log", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "vad", msg: `voice end (${reason}) ${(blob.size / 1024).toFixed(1)}KB` }),
  }).catch(() => {});

  let heard = "";
  try {
    const res = await fetch(WHISPER_URL, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: blob,
    });
    if (res.ok) {
      const j = await res.json();
      heard = (j.text || "").trim();
    }
  } catch (e) { console.warn("[Flat-Out] passive whisper failed:", e.message); }

  // Forward every transcript to bridge log
  fetch("http://localhost:8766/log", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag: "passive", msg: heard, data: { wake: WakeParse.containsWake(heard) } }),
  }).catch(() => {});
  dbgSet("whisper", heard ? `"${heard}"` : "(empty)");

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
    console.warn("[Flat-Out] no mic stream — wfStartListening failed");
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
  wakeBtn.querySelector(".wake__inner").textContent = "TAP / SAY \"HEY FLAT-OUT\"";
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
        console.log("[Flat-Out] auto-stop on silence");
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
  });
  SetupModal.init({ autoPickMic: MicTest.autoPickMic, getPreferredDeviceId, setPreferredDevice, wf });
  SetupModal.maybeShowSetup();        // first-run setup modal (no-op after first completion)

  // R toggles demo recording (no modifiers — Cmd/Ctrl-R reloads, leave that alone)
  document.addEventListener("keydown", (e) => {
    if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const onInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
      if (!onInput) { e.preventDefault(); DemoRecorder.toggleDemoRecording(); }
    }
  });

  /* Tap wake → toggle PASSIVE wake-word listening.
   * In passive mode, we constantly transcribe rolling 3s chunks (skipping silence)
   * and watch for "hey flat-out" in the result. User can say the whole query in one breath. */
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
