/** voice.js - Flat-Out voice loop.
 *  Web Speech API for mic + Kokoro TTS for output, Qwen 2.5 brain via the local bridge.
 *  Wake phrase + branding are loaded at runtime from /brand so the same codebase can be
 *  re-skinned without code changes — primary install is Flat-Out Media. */

import * as Bridge from "./bridge-client.js";
import * as TTS from "./tts.js";
import * as Storage from "./storage.js";
import * as Modal from "./modal-queue.js";
import * as History from "./history.js";

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
  Bridge.on("timer.set",              handleTimerSet);
  Bridge.on("timer.fire",             handleTimerFire);
  Bridge.on("timer.cancel",           handleTimerCancel);
}

/* ---- Timer HUD integration ----
 * Each active timer gets a corner badge with a live countdown. On fire, the
 * badge flashes red, Kokoro speaks the label, and we play a short tone via
 * the existing Web Audio context. */

const _timerBadges = new Map();

function ensureTimerHost() {
  let host = document.getElementById("timerStack");
  if (host) return host;
  host = document.createElement("div");
  host.id = "timerStack";
  host.style.cssText = "position:fixed;left:18px;top:18px;display:flex;flex-direction:column;gap:8px;z-index:9999;font-family:var(--mono,monospace);font-size:11px;letter-spacing:0.1em;pointer-events:none;";
  document.body.appendChild(host);
  return host;
}

function fmtMinSec(ms) {
  if (ms <= 0) return "00:00";
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function handleTimerSet(msg) {
  const { id, label, fireAt } = msg.data || {};
  if (!id) return;
  const host = ensureTimerHost();
  const badge = document.createElement("div");
  badge.style.cssText = "background:#0a0a0a;border:1px solid var(--brand-primary,#ff3b3b);color:#eaeaea;padding:8px 12px;min-width:180px;box-shadow:0 0 16px rgba(255,59,59,0.18);";
  const labelEl = document.createElement("div");
  labelEl.style.cssText = "color:#888;font-size:10px;text-transform:uppercase;margin-bottom:4px;";
  labelEl.textContent = label || "TIMER";
  const countEl = document.createElement("div");
  countEl.style.cssText = "color:var(--brand-primary,#ff3b3b);font-size:20px;font-variant-numeric:tabular-nums;";
  badge.appendChild(labelEl);
  badge.appendChild(countEl);
  host.appendChild(badge);
  const tick = () => { countEl.textContent = fmtMinSec(fireAt - Date.now()); };
  tick();
  const interval = setInterval(tick, 500);
  _timerBadges.set(id, { badge, interval });
}

function handleTimerCancel(msg) {
  const id = msg.data?.id;
  if (!id) return;
  const entry = _timerBadges.get(id);
  if (!entry) return;
  clearInterval(entry.interval);
  entry.badge.remove();
  _timerBadges.delete(id);
}

async function handleTimerFire(msg) {
  const { id, label } = msg.data || {};
  /* Visual: keep the badge for ~6s in a fired state, then remove. */
  const entry = _timerBadges.get(id);
  if (entry) {
    clearInterval(entry.interval);
    entry.badge.style.background = "var(--brand-primary, #ff3b3b)";
    entry.badge.style.color = "#000";
    entry.badge.querySelector("div").textContent = "FIRED";
    entry.badge.lastChild.textContent = "00:00";
    setTimeout(() => { entry.badge.remove(); _timerBadges.delete(id); }, 6000);
  }
  /* Audible: short Web Audio beep + Kokoro speak the label. */
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = 880;
    gain.gain.value = 0.18;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {}
  try {
    const r = await fetch("http://localhost:8767/tts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `Timer up — ${label || "kitchen timer"}`, voice: localStorage.getItem("flatout.voice") || "bm_daniel" }),
    });
    if (r.ok) {
      const wav = await r.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(wav);
      const src = ctx.createBufferSource(); src.buffer = buf;
      src.connect(ctx.destination); src.start(0);
    }
  } catch (e) {
    console.warn("[Flat-Out] timer TTS failed:", e.message);
  }
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

/** Speak using local Kokoro TTS (free, Apache 2.0). Falls back to system speechSynthesis
 *  if unreachable. Plays Kokoro WAVs via Web Audio so we can tap the buffer into the
 *  existing speaking analyser for the real-time waveform. */
async function speak(text) {
  setState("speaking");
  const spoken = TTS.sanitiseForTTS(text);

  /* First try Kokoro — local, free, brand-trained voice. */
  try {
    const wav = await TTS.synthesise(spoken, getKokoroVoice());
    await playWavWithAnalyser(wav);
    setState("idle");
    setTimeout(() => { transcript.hidden = true; }, 1800);
    return;
  } catch (e) {
    console.warn("[Flat-Out] Kokoro unreachable, falling back to system TTS:", e.message);
  }

  /* Fallback path — Web Speech API. Lower fidelity but keeps the voice loop alive
   * if the Python TTS service is down. */
  await TTS.fallbackSystemTTS(spoken);
  setState("idle");
  setTimeout(() => { transcript.hidden = true; }, 1800);
}

/* ---------- STREAMING ASK + SPEAK ----------
 * Why: legacy path (askLLM + speak) blocks on full reply before any audio plays. With
 * sentence-level streaming we start synthesising as soon as the first sentence is ready,
 * so a 5-sentence reply starts speaking after ~1s instead of ~5s. The TTS module owns
 * the queue + cancellation; voice.js just feeds sentences in and wires the waveform.
 *
 * Returns the final assembled text (same as askLLM) so callers can persist to history. */

/* Module-level handle on the in-flight speech session. Lets barge-in code abort cleanly
 * without traversing closures — call cancelCurrentSpeech() from anywhere. */
let currentSpeechSession = null;

function cancelCurrentSpeech() {
  if (!currentSpeechSession) return;
  currentSpeechSession.cancelled = true;
  TTS.cancelTTS();
  /* Resolve the in-flight finished promise so the caller's await speakStream() unblocks
   * and the state transition to idle happens immediately. */
  if (currentSpeechSession.resolveEarly) currentSpeechSession.resolveEarly(currentSpeechSession.accumulated);
}

async function speakStream(query, history) {
  /* Stack turns: if a previous speakStream is still in flight, this call waits for
   * it before starting. Means a second query while the first is still speaking
   * queues naturally — no overlap. acquireTurn() returns a release() the caller
   * must call when fully done (TTS drained). */
  const turn = await TTS.acquireTurn();

  setState("speaking");
  /* Wire the streaming TTS queue's analyser into the waveform's "speaking-real" path
   * so the bottom strip pulses with the real audio amplitude — same UX as the legacy
   * playWavWithAnalyser approach. */
  const { analyser, buffer } = TTS.getSpeakingAnalyser();
  wf.speakingAnalyser = analyser;
  wf.speakingBuffer = buffer;
  wf.mode = "speaking-real";
  if (recDestination) { try { TTS.setRecordingDestination(recDestination); } catch {} }

  /* Filler phrase — speak a randomised acknowledgement immediately so audio reaches
   * the operator within ~200ms. The filler enters the same TTS queue as the streamed
   * sentences, so the LLM's actual reply naturally plays AFTER the filler finishes.
   *
   * Pick the longer filler pool when the query contains slow-tool keywords (diary,
   * shoot, render, etc) — gives the operator more substantial audio to listen to
   * while the LLM + AppleScript / vision / ffmpeg work runs. Short pool for
   * everyday chat where the reply will arrive in ~1s anyway. */
  const filler = TTS.pickFiller({ long: TTS.looksSlow(query) });
  TTS.enqueueSentence(filler, getKokoroVoice());

  const session = { runId: null, cancelled: false, accumulated: "", resolveEarly: null };
  currentSpeechSession = session;

  /* Start the barge-in monitor — fires cancelCurrentSpeech() if the operator's voice
   * crosses BARGE_IN_RMS for more than BARGE_IN_DURATION_MS while audio is playing. */
  startBargeInMonitor();

  /* Subscribe to streaming events. We track the runId from the streamStart frame so a
   * stale stream's late sentences (after barge-in) don't bleed into the next utterance. */
  const finished = new Promise((resolve, reject) => {
    session.resolveEarly = resolve;

    const unsubStart = Bridge.on("llm.streamStart", (msg) => {
      if (msg.runId && !session.runId) session.runId = msg.runId;
    });
    const unsubSentence = Bridge.on("llm.sentence", (msg) => {
      if (session.cancelled) return;
      if (session.runId && msg.runId !== session.runId) return;
      const sentence = msg.data?.text || msg.text;
      if (!sentence) return;
      TTS.enqueueSentence(sentence, getKokoroVoice());
      /* Stream the same text into the on-screen transcript so the operator sees + hears
       * in lockstep. Append rather than replace so the full reply scrolls in. */
      const cur = replyEl.textContent === "…" ? "" : replyEl.textContent;
      replyEl.textContent = cur ? `${cur} ${sentence}` : sentence;
      session.accumulated = (session.accumulated ? session.accumulated + " " : "") + sentence;
    });
    const unsubDone = Bridge.on("llm.streamDone", (msg) => {
      if (session.runId && msg.runId !== session.runId) return;
      if (session.cancelled) return;
      const finalText = msg.data?.text || msg.text || session.accumulated;
      session.accumulated = finalText;
      /* Resolve once the TTS queue actually finishes playing, not when the LLM finishes
       * generating — otherwise we transition out of "speaking" while audio is still rolling. */
      if (TTS.isSpeaking()) {
        TTS.onIdle(() => resolve(finalText));
      } else {
        resolve(finalText);
      }
    });
    const unsubError = Bridge.on("llm.streamError", (msg) => {
      if (session.runId && msg.runId !== session.runId) return;
      reject(new Error(msg.data?.error || msg.error || "stream error"));
    });

    /* Stash the unsubs on the session so the outer try/finally can tear them down. */
    session.unsubs = [unsubStart, unsubSentence, unsubDone, unsubError];
  });

  try {
    /* Fire the streaming request. The reply payload arrives via the bridge's id-correlated
     * reply, but we don't need to await it — events drive everything. */
    Bridge.ask({ type: "llm.askStream", payload: { query, history, sessionId: getSessionId() } }).catch((e) => {
      console.warn("[Flat-Out] askStream failed:", e.message);
      /* Resolve early with whatever we accumulated so the speak() pipeline closes cleanly. */
      if (session.resolveEarly) session.resolveEarly(session.accumulated || "");
    });
    const text = await finished;
    setState("idle");
    setTimeout(() => { transcript.hidden = true; }, 1800);
    return text;
  } finally {
    stopBargeInMonitor();
    if (session.unsubs) for (const u of session.unsubs) { try { u(); } catch {} }
    if (currentSpeechSession === session) currentSpeechSession = null;
    if (!TTS.isSpeaking()) {
      wf.speakingAnalyser = null;
      wf.speakingBuffer = null;
    }
    /* Release the turn so the next queued speakStream() can start. Always runs,
     * even on error / cancellation, so a failed turn doesn't deadlock the queue. */
    turn.release();
  }
}

/* ---------- BARGE-IN ----------
 * Why: a 5-sentence reply that the operator already understood after the first sentence
 * shouldn't keep playing. While speaking, sample the mic at 50ms intervals; if RMS
 * exceeds an aggressive threshold for ~250ms continuously (real speech, not just one
 * loud spike) cancel TTS so the operator can re-engage immediately. The speaker-bleed
 * problem (no echo cancellation on the kiosk) is mitigated by the threshold sitting
 * well above the typical Daniel-through-speakers RMS — only an actual nearby voice
 * crosses it sustainably. */
const BARGE_IN_RMS = 0.18;        // empirically: speaker-bleed peaks ~0.08, voice 0.2-0.5
const BARGE_IN_DURATION_MS = 250; // sustained for this long before we cancel
const BARGE_IN_TICK_MS = 50;

let bargeInTimer = null;
let bargeInVoiceStart = 0;
function startBargeInMonitor() {
  if (bargeInTimer) return;
  bargeInVoiceStart = 0;
  bargeInTimer = setInterval(() => {
    /* Only active while real audio is playing through the speaking analyser. Idle and
     * synthetic-speaking modes don't need barge-in (synthetic = system TTS fallback,
     * which is non-cancellable from JS anyway). */
    if (wf.mode !== "speaking-real") {
      stopBargeInMonitor();
      return;
    }
    if (!wf.analyser || !wf.buffer) return;          /* mic analyser not yet open */
    if (!passive && !listening) return;              /* operator hasn't engaged the kiosk */
    const rms = currentRms();
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

/** Decode a WAV ArrayBuffer, route it through the waveform analyser, and play to speakers.
 *  Resolves when playback ends so the caller can flip state. */
async function playWavWithAnalyser(wavBuffer) {
  if (!wf.audioCtx) wf.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (wf.audioCtx.state === "suspended") await wf.audioCtx.resume();

  const audioBuffer = await wf.audioCtx.decodeAudioData(wavBuffer.slice(0));
  const source = wf.audioCtx.createBufferSource();
  source.buffer = audioBuffer;

  // Create a dedicated speaking analyser so the listening one (mic) keeps its config.
  const analyser = wf.audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  const speakBuf = new Uint8Array(analyser.fftSize);

  source.connect(analyser);
  analyser.connect(wf.audioCtx.destination);
  // Tap into the demo-recording mix if it's been set up (recorder is active)
  if (recDestination) { try { analyser.connect(recDestination); } catch (_) {} }

  // Swap waveform mode to read from this analyser instead of synthetic
  wf.speakingAnalyser = analyser;
  wf.speakingBuffer = speakBuf;
  wf.mode = "speaking-real";

  return new Promise((resolve) => {
    source.onended = () => {
      wf.speakingAnalyser = null;
      wf.speakingBuffer = null;
      resolve();
    };
    source.start(0);
  });
}

/** Strip wake word + leading filler from heard text → real query. */
function extractQuery(text) {
  let q = text.toLowerCase();
  for (const v of WAKE_VARIANTS) q = q.replaceAll(v, " ");
  q = q.replace(/\s+/g, " ").trim();
  q = q.replace(/^(hey|hi|ok|please|can you|could you|would you)\s+/i, "");
  return q;
}

/* Why: legacy fuzzy patterns tuned for Whisper mishearings of "Flat-Out". Only used
 * when the active brand IS Flat-Out — for other agent names the brand.wakeMishears
 * list is the authoritative match set. Adding new fuzzy regexes per client is a
 * setup-wizard step, not something we infer here. */
const FLATOUT_FUZZY_PATTERNS = [
  /\b(hey|ay|hi|yo)[,!.\s]*(flat|flap|flag|flank)[\s-]*(out|ow|hour|owt|art|ott)\b/i,
  /\b(hey|ay|hi|yo)[,!.\s]+(flat|flap)\b/i,
  /\bflat[\s-]*out\b/i,
  /\bflat[\s-]*ow\b/i,
  /\bflatout\b/i,
];

function containsWake(text) {
  const t = (text || "").toLowerCase();
  if (WAKE_VARIANTS.some(v => t.includes(v))) return true;
  if (AGENT_NAME.toLowerCase() === "flat-out") {
    return FLATOUT_FUZZY_PATTERNS.some(re => re.test(t));
  }
  return false;
}

/* Why: video-edit intent is now a proper LLM tool (video_edit_from_shoot), no regex shortcut.
 * The LLM extracts subject + decides when to call it — same path as every other capability. */

/** Send a one-shot bridge request and resolve with the reply (used for subject extraction). */
function bridgeRequest(type, payload, timeoutMs = 15000) {
  return Bridge.ask({ type, payload }, timeoutMs);
}

/** Quick regex pull for "of/from the X" phrasings before falling back to the LLM. */
function quickExtractSubject(query) {
  const patterns = [
    /(?:of|from|for)\s+(?:yesterday'?s?|the|a|an)\s+(.+?)\s+(?:shoot|film|footage|reel)/i,
    /(?:of|from|for|featuring)\s+(?:the|a|an)?\s*(.+?)\s+(?:for|on)\s+(?:instagram|insta|social|stories|reels|youtube|tiktok)/i,
    /(?:of|from|for|featuring)\s+(?:the|a|an)?\s*(.+?)$/i,
  ];
  for (const re of patterns) {
    const m = query.match(re);
    if (m && m[1]) {
      const subject = m[1].trim().replace(/[?!.,;:]+$/, "");
      if (subject.length >= 3 && subject.length <= 80) return subject;
    }
  }
  return null;
}

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

function isAffirmative(text) {
  const t = (text || "").toLowerCase().trim();
  return /^(yes|yeah|yep|sure|go ahead|please|do it|ok(ay)?|sounds good|let's see|let me see|have a look|look)/.test(t);
}

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
    if (isAffirmative(text)) {
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

  const query = extractQuery(text);
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
 * tap again (or auto-stop on 1.2s silence) → blob POSTed to /transcribe → Whisper returns text → handleHeard.
 * Fully offline once the base.en model is cached. */
const WHISPER_URL = "http://localhost:8768/transcribe";
let listening = false;
let mediaRecorder = null;
let audioChunks = [];
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
    body: JSON.stringify({ tag: "passive", msg: heard, data: { wake: containsWake(heard) } }),
  }).catch(() => {});
  dbgSet("whisper", heard ? `"${heard}"` : "(empty)");

  if (heard) {
    // 1. In conversation mode, check for dismissal first — save conversation summary before exiting
    if (conversationMode && isDismissal(heard)) {
      // Ask LLM to save_conversation with a summary of what just happened, then exit.
      try {
        if (conversationHistory.length >= 2) {
          await askLLM("Wrap up: call save_conversation with a 2-sentence summary of what we just discussed and a topics array. Reply with 'saved'.");
        }
      } catch {}
      exitConversation();
      await speak("Right you are, sir. Standing by.");
      if (passive) cyclePassive();
      return;
    }

    // 2. Either we heard the wake word OR we're already in conversation — handle the query
    const wakeHeard = containsWake(heard);
    if (wakeHeard || conversationMode) {
      const query = wakeHeard ? extractQuery(heard) : heard;
      /* Speedo wake-flick: brief 0→40 mph pop on wake-word detection, before the
       * listening state engages. Same vibe as the camera's "lock on" — visible
       * acknowledgement that the kiosk caught the wake even before audio confirms. */
      if (wakeHeard) window.__speedo?.flash?.("flick");
      resetConversationTimeout();

      if (query.length >= 2) {
        // Wake + query (or in-conversation utterance): process it
        if (!conversationMode) enterConversation();
        passive = false;
        wakeBtn.querySelector(".wake__inner").textContent = "PROCESSING…";
        await handleHeard(heard, true);
        if (passive === false) {
          passive = true;
          setState("listening");
          if (conversationMode) wakeBtn.querySelector(".wake__inner").textContent = "CONVERSATION — TAP TO STOP";
        }
      } else if (wakeHeard) {
        // Bare wake word — snappy acknowledgement, enter conversation
        await acknowledgeBareWake();
      }
    }
  }

  if (passive) cyclePassive();
}

/* ---------- CONVERSATION MODE ----------
 * After the first wake, stay in conversation mode — every utterance is a query, no wake word needed.
 * Exit when user says "that's all" / "thanks that's all" / "stop listening" / similar.
 * Auto-exit after 60s of silence. */
let conversationMode = false;
let conversationTimeoutId = 0;
const CONVERSATION_IDLE_MS = 60000;
const ACK_PHRASES = ["Yes, sir.", "Sir.", "Go ahead.", "I'm here, sir.", "Listening, sir."];

const DISMISS_PATTERNS = [
  /\b(ok|okay|alright)?\s*[,.]?\s*(that(?:'s|s|\s+is)?|thats|thanks)\s+(is\s+)?all\b/i,
  /\b(that(?:'s|s)?|thats)\s+(it|enough|fine)\b/i,
  /\b(thanks?|thank you|cheers)[,.\s]*(that(?:'s|s)?|thats)?\s*(all|enough|it|fine)\b/i,
  /\bno more questions\b/i,
  /\bgoodbye\b/i,
  /\bbye\s*(flat[\s-]*out)?\b/i,
  /\b(stop|quit|exit)\s+listening\b/i,
];
function isDismissal(text) {
  const t = (text || "").trim();
  if (!t) return false;
  return DISMISS_PATTERNS.some((re) => re.test(t));
}

function enterConversation() {
  conversationMode = true;
  if (wakeBtn) wakeBtn.querySelector(".wake__inner").textContent = "CONVERSATION — TAP TO STOP";
  resetConversationTimeout();
}
function resetConversationTimeout() {
  if (conversationTimeoutId) clearTimeout(conversationTimeoutId);
  conversationTimeoutId = setTimeout(() => {
    if (conversationMode) {
      conversationMode = false;
      if (wakeBtn) wakeBtn.querySelector(".wake__inner").textContent = "WAKE LISTENING — TAP TO STOP";
      clearHistory();
      console.log("[Flat-Out] conversation timed out — back to wake-word listening");
    }
  }, CONVERSATION_IDLE_MS);
}
function exitConversation() {
  conversationMode = false;
  if (conversationTimeoutId) { clearTimeout(conversationTimeoutId); conversationTimeoutId = 0; }
  if (wakeBtn) wakeBtn.querySelector(".wake__inner").textContent = "WAKE LISTENING — TAP TO STOP";
  clearHistory();   // fresh slate for the next conversation
}

async function acknowledgeBareWake() {
  const phrase = ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)];
  enterConversation();
  await speak(phrase);
  resetConversationTimeout();
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

  audioChunks = [];
  let totalBytes = 0;
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  mediaRecorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      audioChunks.push(e.data);
      totalBytes += e.data.size;
      dbgSet("chunks", `${audioChunks.length} (${(totalBytes / 1024).toFixed(1)} KB)`);
    }
  };
  mediaRecorder.onstop = () => transcribeAndHandle();

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
  const SILENCE_MS = 1400;
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

/** POST the captured audio to local Whisper, run handleHeard if transcribed. */
async function transcribeAndHandle() {
  if (audioChunks.length === 0) {
    dbgSet("upload", "0 bytes — no chunks");
    setState("idle");
    return;
  }
  const blob = new Blob(audioChunks, { type: audioChunks[0].type || "audio/webm" });
  audioChunks = [];
  dbgSet("upload", `${(blob.size / 1024).toFixed(1)} KB ${blob.type}`);

  // Decode the blob locally and measure peak amplitude — proves whether the captured audio is silent
  try {
    const ab = await blob.arrayBuffer();
    if (wf.audioCtx) {
      const decoded = await wf.audioCtx.decodeAudioData(ab.slice(0));
      const ch = decoded.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < ch.length; i += 64) { const v = Math.abs(ch[i]); if (v > peak) peak = v; }
      dbgSet("peak", `${peak.toFixed(4)} (${decoded.duration.toFixed(2)}s)`);
    }
  } catch (e) { dbgSet("peak", `decode err: ${e.message}`); }

  setState("thinking");
  replyEl.textContent = "Transcribing…";
  transcript.hidden = false;

  try {
    const res = await fetch(WHISPER_URL, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: blob,
    });
    if (!res.ok) throw new Error(`whisper ${res.status}`);
    const { text } = await res.json();
    const heard = (text || "").trim();
    console.log("[Flat-Out] whisper:", heard);
    dbgSet("whisper", heard ? `"${heard}"` : "(empty)");
    if (!heard) {
      setState("idle");
      replyEl.textContent = "I didn't catch that.";
      speak("I didn't catch that.");
      return;
    }
    handleHeard(heard, true);
  } catch (e) {
    console.warn("[Flat-Out] transcribe failed:", e.message);
    dbgSet("error", `whisper: ${e.message}`);
    setState("idle");
    replyEl.textContent = "Whisper isn't reachable. Check the bridge logs.";
    speak("Whisper isn't reachable.");
  }
}

/** Iterate every audioinput device, sample 600ms of raw PCM from each, pick the one with the
 *  highest peak above noise floor. Saves that deviceId to localStorage. Bypasses Chrome's
 *  reluctance to expose device labels — works directly on deviceIds. */
async function autoPickMic() {
  const btn = document.getElementById("dbgAutoPickBtn");
  if (!btn) return;
  btn.disabled = true; btn.textContent = "TESTING DEVICES…";
  dbgSet("error", "—");

  // Make sure we have permission first so enumerateDevices returns ALL devices
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); } catch {}
  await new Promise(r => setTimeout(r, 200));
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter(d => d.kind === "audioinput");

  if (inputs.length === 0) {
    dbgSet("error", "no audio inputs found");
    btn.disabled = false; btn.textContent = "AUTO-PICK WORKING MIC";
    return;
  }

  /* Why: the silent built-in is what gets picked when constraint is loose, so we explicitly
   * test every distinct deviceId and rank by peak. We need a tiny bit of audio to ride —
   * user can speak / click / make any noise during the 0.6s × N total. */
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") await ctx.resume();
  const SAMPLE_MS = 600;
  const results = [];

  for (let i = 0; i < inputs.length; i++) {
    const d = inputs[i];
    const idTail = d.deviceId ? d.deviceId.slice(0, 8) : "default";
    const label = d.label || `(unlabeled ${idTail})`;
    btn.textContent = `TESTING ${i + 1}/${inputs.length}…`;
    dbgSet("device", `probing: ${label}`);

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: d.deviceId ? { exact: d.deviceId } : undefined,
                 echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      results.push({ device: d, peak: 0, rms: 0, error: e.name });
      continue;
    }
    const src = ctx.createMediaStreamSource(stream);
    const sp = ctx.createScriptProcessor(2048, 1, 1);
    let peak = 0, sumSq = 0, n = 0;
    sp.onaudioprocess = (e) => {
      const samples = e.inputBuffer.getChannelData(0);
      for (let j = 0; j < samples.length; j++) {
        const v = Math.abs(samples[j]);
        if (v > peak) peak = v;
        sumSq += samples[j] * samples[j];
        n++;
      }
    };
    src.connect(sp); sp.connect(ctx.destination);
    await new Promise(r => setTimeout(r, SAMPLE_MS));
    src.disconnect(); sp.disconnect();
    stream.getTracks().forEach(t => t.stop());
    const rms = n ? Math.sqrt(sumSq / n) : 0;
    results.push({ device: d, peak, rms, label });
  }
  ctx.close();

  // Pick highest-peak device above noise floor
  results.sort((a, b) => b.peak - a.peak);
  const winner = results[0];
  console.log("[Flat-Out] mic auto-pick results:", results.map(r => `${r.label}: peak=${r.peak.toFixed(4)}`));

  if (winner && winner.peak > 0.001) {
    setPreferredDevice(winner.device.deviceId, winner.label);
    if (wf.micStream) wf.micStream.getTracks().forEach(t => t.stop());
    wf.micStream = null; wf.analyser = null;
    dbgSet("device", `${winner.label} (auto-picked, peak=${winner.peak.toFixed(3)})`);
    dbgSet("error", "✓ working mic chosen — tap wake to use it");
    refreshDevicePicker();
  } else {
    const summary = results.map(r => `${r.label}: ${r.peak.toFixed(3)}`).join(" / ");
    dbgSet("error", `all silent: ${summary}`);
  }

  btn.disabled = false; btn.textContent = "AUTO-PICK WORKING MIC";
}

/** Standalone mic test — bypasses MediaRecorder. Captures 3s of raw PCM, reports peak/RMS.
 *  This proves whether macOS is delivering audio at ALL, separate from any encoder issues. */
async function runMicTest() {
  const btn = document.getElementById("dbgTestBtn");
  if (!btn) return;
  btn.disabled = true; btn.textContent = "TESTING…";
  dbgSet("error", "—");

  let stream;
  try {
    const id = getPreferredDeviceId();
    const constraints = id
      ? { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (e) {
    dbgSet("error", `getUserMedia: ${e.name} ${e.message}`);
    btn.disabled = false; btn.textContent = "TEST MIC (3s)";
    return;
  }

  const ctx = wf.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);

  /* Why: ScriptProcessor is deprecated but it's the simplest way to pull raw PCM samples in 3s.
   * AudioWorklet would be cleaner but adds boilerplate. */
  const sp = ctx.createScriptProcessor(2048, 1, 1);
  let peak = 0;
  let sumSq = 0;
  let n = 0;
  sp.onaudioprocess = (e) => {
    const samples = e.inputBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
      sumSq += samples[i] * samples[i];
      n++;
    }
  };
  src.connect(sp);
  sp.connect(ctx.destination);

  const track = stream.getAudioTracks()[0];
  dbgSet("device", track.label || "?");
  dbgSet("track", `${track.readyState}/${track.muted ? "muted" : "live"}/${track.enabled ? "on" : "off"}`);

  await new Promise(r => setTimeout(r, 3000));

  src.disconnect(); sp.disconnect();
  stream.getTracks().forEach(t => t.stop());

  const rms = n ? Math.sqrt(sumSq / n) : 0;
  dbgSet("peak", `peak=${peak.toFixed(4)} rms=${rms.toFixed(4)} samples=${n}`);
  if (peak < 0.0005) {
    dbgSet("error", "MIC SILENT — macOS not delivering audio");
  } else if (peak < 0.01) {
    dbgSet("error", "very quiet — check input gain in System Settings → Sound → Input");
  } else {
    dbgSet("error", "mic audio reaching browser ✓");
  }
  btn.disabled = false; btn.textContent = "TEST MIC (3s)";
}

/* ---------- FIRST-RUN SETUP MODAL ----------
 * Shown on the very first launch (or after localStorage is cleared).
 * Walks the operator through: location confirm, voice pick, mic pick, agency name. */
/* Why: short logical names — Storage namespaces them under the active profile. */
const SETUP_DONE_KEY = "setupDone";
const VOICE_KEY = "voice";
const AGENCY_KEY = "agency";
const TIER_KEY = "tier";

function loadSavedVoice() { return Storage.get(VOICE_KEY, "bm_daniel"); }
function getSavedAgency() { return Storage.get(AGENCY_KEY, "Flat-Out Media"); }
function getSavedTier()   { return Storage.get(TIER_KEY, "standard"); }

/** Performance tier presets — readonly, consumed by HUD throttles. */
const TIER_PRESETS = {
  lite:     { faceFps: 0,  waveFps: 30, animateArcs: false, dropShadows: false, camRes: 240 },
  standard: { faceFps: 8,  waveFps: 60, animateArcs: true,  dropShadows: false, camRes: 360 },
  pro:      { faceFps: 12, waveFps: 60, animateArcs: true,  dropShadows: true,  camRes: 480 },
  max:      { faceFps: 24, waveFps: 60, animateArcs: true,  dropShadows: true,  camRes: 720 },
};
function getTierPreset() { return TIER_PRESETS[getSavedTier()] || TIER_PRESETS.standard; }
window.getTierPreset = getTierPreset;

async function maybeShowSetup() {
  if (Storage.get(SETUP_DONE_KEY) === "true") return;
  const modal = document.getElementById("setupModal");
  if (!modal) return;
  modal.hidden = false;

  // Pull detected location from bridge
  let cfg = {};
  try {
    const r = await fetch("http://localhost:8766/config");
    cfg = await r.json();
  } catch {}
  const op = cfg.operator || {};

  const cityEl = document.getElementById("setupCity");
  const coordsEl = document.getElementById("setupCoords");
  const voiceEl = document.getElementById("setupVoice");
  const agencyEl = document.getElementById("setupAgency");

  cityEl.value = op.city || "";
  if (op.latitude && op.longitude) {
    coordsEl.textContent = `lat ${op.latitude.toFixed(4)}, lon ${op.longitude.toFixed(4)} • ${op.timezone || "Europe/London"}`;
  }
  voiceEl.value = loadSavedVoice();
  agencyEl.value = getSavedAgency();

  // Performance tier — pre-pick from detected hardware, show chip + RAM
  const tierEl = document.getElementById("setupTier");
  const hwInfoEl = document.getElementById("setupHwInfo");
  const detectedTier = cfg.hardware?.tier || "standard";
  tierEl.value = Storage.get(TIER_KEY) || detectedTier;
  if (cfg.hardware) {
    hwInfoEl.textContent = `Detected: ${cfg.hardware.chip}, ${cfg.hardware.memoryGB}GB → ${detectedTier}`;
  }

  // Populate mic picker (clones the debug-panel logic but for the modal)
  await populateSetupMicPicker();

  document.getElementById("setupRedetect").addEventListener("click", async () => {
    cityEl.value = "Detecting…";
    try {
      const r = await fetch("http://localhost:8766/config");
      const c = await r.json();
      cityEl.value = c.operator?.city || "";
      if (c.operator?.latitude) coordsEl.textContent = `lat ${c.operator.latitude.toFixed(4)}, lon ${c.operator.longitude.toFixed(4)}`;
    } catch { cityEl.value = ""; }
  });

  document.getElementById("setupVoiceTest").addEventListener("click", async () => {
    const v = voiceEl.value;
    try {
      const res = await fetch("http://localhost:8767/tts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `Voice check. ${v.startsWith("bm_") ? "Sir." : "Ready."}`, voice: v }),
      });
      if (!res.ok) return;
      const wav = await res.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(wav);
      const src = ctx.createBufferSource(); src.buffer = buf;
      src.connect(ctx.destination); src.start(0);
    } catch (e) { console.warn("voice test failed:", e); }
  });

  document.getElementById("setupMicAuto").addEventListener("click", async () => { await autoPickMic(); await populateSetupMicPicker(); });

  document.getElementById("setupSubmit").addEventListener("click", async () => {
    Storage.set(VOICE_KEY, voiceEl.value);
    Storage.set(AGENCY_KEY, agencyEl.value || "Flat-Out Media");
    Storage.set(TIER_KEY, tierEl.value);

    /* If the operator typed a city different from the detected one, geocode it via Open-Meteo
     * (free, no key) and POST as override. Bridge persists to config.json + locks against IP redetect. */
    const enteredCity = (cityEl.value || "").trim();
    const detectedCity = (op.city || "").trim();
    if (enteredCity && enteredCity.toLowerCase() !== detectedCity.toLowerCase()) {
      try {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(enteredCity)}&count=1&language=en`);
        const j = await g.json();
        const r = j.results && j.results[0];
        const payload = {
          city: enteredCity,
          country: r?.country || op.country,
          latitude: r?.latitude ?? op.latitude,
          longitude: r?.longitude ?? op.longitude,
          timezone: r?.timezone || op.timezone,
          agency: agencyEl.value || "Flat-Out Media",
        };
        await fetch("http://localhost:8766/config/override", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (e) { console.warn("[Flat-Out] location override failed:", e.message); }
    } else if (agencyEl.value && agencyEl.value !== "Flat-Out Media") {
      // Agency name change only
      await fetch("http://localhost:8766/config/override", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agency: agencyEl.value }),
      }).catch(() => {});
    }

    Storage.set(SETUP_DONE_KEY, "true");
    modal.hidden = true;
  });

  document.getElementById("setupSkip").addEventListener("click", () => {
    Storage.set(SETUP_DONE_KEY, "true");
    modal.hidden = true;
  });
}

async function populateSetupMicPicker() {
  const sel = document.getElementById("setupMic");
  if (!sel) return;
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); } catch {}
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === "audioinput");
  const saved = getPreferredDeviceId();
  sel.replaceChildren();
  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label || `(unlabeled mic)`;
    if (d.deviceId === saved) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!sel.dataset.wired) {
    sel.dataset.wired = "1";
    sel.addEventListener("change", () => {
      const label = sel.selectedOptions[0]?.textContent || "";
      setPreferredDevice(sel.value, label);
      if (wf.micStream) wf.micStream.getTracks().forEach(t => t.stop());
      wf.micStream = null; wf.analyser = null;
    });
  }
}

/* ---------- DEMO RECORDER ----------
 * Press R (no modifiers) to toggle. Captures screen video via getDisplayMedia + mic + Kokoro TTS audio,
 * combines into a single WebM, downloads on stop. Kokoro audio is tapped from the Web Audio context
 * (more reliable than macOS system-audio capture). */
let demoRec = null;
let demoStreams = [];
let demoTimerId = 0;
let demoStartTs = 0;
let recDestination = null;   // shared MediaStreamDestination for mic + TTS audio mix

/** Get a destination that mixes mic + Kokoro output. Lazily create on first use. */
function ensureRecAudioMix() {
  if (recDestination) return recDestination;
  if (!wf.audioCtx) wf.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  recDestination = wf.audioCtx.createMediaStreamDestination();
  // Mic stream → destination (if available). When wfStartListening creates a mic source, it gets routed too.
  if (wf.micStream) {
    try { wf.audioCtx.createMediaStreamSource(wf.micStream).connect(recDestination); } catch (_) {}
  }
  return recDestination;
}

/** Tap the Kokoro speaking-analyser into the recording mix (called when speak() starts). */
function tapTtsToRec(analyser) {
  if (!recDestination) return;
  try { analyser.connect(recDestination); } catch (_) {}
}

async function toggleDemoRecording() {
  if (demoRec) { stopDemo(); return; }
  let display;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false,   // we mix audio ourselves below for reliability
    });
  } catch (e) { console.warn("[Flat-Out] screen capture cancelled:", e.message); return; }

  // Make sure mic is open + analyser routed
  await wfStartListening();
  ensureRecAudioMix();
  // Re-route the existing mic source into the destination (in case it wasn't when ensureRecAudioMix ran)
  if (wf.micStream) {
    try { wf.audioCtx.createMediaStreamSource(wf.micStream).connect(recDestination); } catch (_) {}
  }

  // Combined: video from screen, audio from our mix destination
  const audioTracks = recDestination.stream.getAudioTracks();
  const combined = new MediaStream([
    display.getVideoTracks()[0],
    ...audioTracks,
  ]);

  demoStreams = [display];
  const chunks = [];
  // VP9+Opus is the most efficient WebM combo Chrome supports out of the box
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus" : "video/webm";
  demoRec = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 });
  demoRec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  demoRec.onstop = () => {
    const blob = new Blob(chunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flat-out-demo-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.webm`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    console.log(`[Flat-Out] demo saved (${(blob.size / 1e6).toFixed(1)} MB)`);
  };
  // If user stops sharing via the browser bar, we stop too
  display.getVideoTracks()[0].addEventListener("ended", stopDemo);
  demoRec.start(1000);
  demoStartTs = Date.now();
  showRecIndicator(true);
}

function stopDemo() {
  if (!demoRec) return;
  try { demoRec.stop(); } catch (_) {}
  demoStreams.forEach(s => s.getTracks().forEach(t => t.stop()));
  demoRec = null;
  demoStreams = [];
  showRecIndicator(false);
}

function showRecIndicator(on) {
  const ind = document.getElementById("recIndicator");
  if (!ind) return;
  ind.hidden = !on;
  if (on) {
    if (demoTimerId) clearInterval(demoTimerId);
    demoTimerId = setInterval(() => {
      const s = Math.floor((Date.now() - demoStartTs) / 1000);
      const mm = Math.floor(s / 60), ss = s % 60;
      const el = document.getElementById("recTime");
      if (el) el.textContent = `${mm}:${ss.toString().padStart(2, "0")}`;
    }, 500);
  } else if (demoTimerId) { clearInterval(demoTimerId); demoTimerId = 0; }
}

/* ---------- WIRE UP UI ---------- */
function wireUI() {
  // Apply the saved performance tier as a body class so CSS rules can adapt
  document.body.classList.add(`tier-${getSavedTier()}`);

  /* Connect to bridge + register all typed event subscribers. Idempotent —
   * Bridge.connect() reuses an existing socket if one is open. */
  wireBridgeEvents();

  wfInit();   // start the state-aware waveform on boot
  refreshDevicePicker();   // populate the input dropdown + auto-select non-built-in
  maybeShowSetup();        // first-run setup modal (no-op after first completion)

  // R toggles demo recording (no modifiers — Cmd/Ctrl-R reloads, leave that alone)
  document.addEventListener("keydown", (e) => {
    if ((e.key === "r" || e.key === "R") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const onInput = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
      if (!onInput) { e.preventDefault(); toggleDemoRecording(); }
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
  if (testBtn) testBtn.addEventListener("click", runMicTest);

  wireSettingsModal();
}

/* ────────── Settings modal ──────────
 * Persists changes via /settings on the bridge (voice → brand.json, model → .env
 * + live setModel). Cog button opens the modal; operator picks voice/model and
 * previews voice before committing. */
const VOICE_LABELS = {
  bm_daniel:    "Daniel — British male, Jarvis-tier",
  bm_george:    "George — British male, deeper",
  bm_lewis:     "Lewis — British male, warmer",
  bm_fable:     "Fable — British male, narrator",
  bf_emma:      "Emma — British female",
  bf_alice:     "Alice — British female, formal",
  bf_isabella:  "Isabella — British female, warm",
  bf_lily:      "Lily — British female, light",
};

function formatModelLabel(m) {
  const sizeGB = m.sizeBytes ? (m.sizeBytes / 1e9).toFixed(1) + " GB" : "?";
  const params = m.parameters || "?";
  return `${m.name}  ·  ${params}  ·  ${sizeGB}`;
}

/* Why: brand-aligned default swatches. Operator can paste any 6-digit hex into the
 * city input via dev console for custom — but these eight cover the realistic palette
 * for a media agency (FOM's red, plus a spread of editorial/automotive accents).
 * Order-tuned so the FOM red sits first as the default. */
const SWATCH_COLOURS = [
  { hex: "#E10600", name: "FOM Red" },
  { hex: "#FF6B00", name: "Track Orange" },
  { hex: "#FFB400", name: "Amber" },
  { hex: "#00D4AA", name: "Pit Green" },
  { hex: "#00B4FF", name: "Helmet Blue" },
  { hex: "#7B61FF", name: "Editorial Violet" },
  { hex: "#FF2E88", name: "Hot Pink" },
  { hex: "#F4F4F4", name: "Mono White" },
];

/** Compute primaryDeep / primaryGlow / primaryTint from a base hex — same scheme as
 *  the bridge's shadeHex() so live preview matches what gets persisted. Used to apply
 *  the colour change to the running HUD before save, so the operator sees the result. */
function deriveColours(hex) {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const shade = (amt) => {
    const adj = (c) => Math.max(0, Math.min(255, Math.round(c + (amt < 0 ? c * amt : (255 - c) * amt))));
    const toHex = (c) => c.toString(16).padStart(2, "0").toUpperCase();
    return "#" + toHex(adj(r)) + toHex(adj(g)) + toHex(adj(b));
  };
  return {
    primary: hex.toUpperCase(),
    primaryDeep: shade(-0.45),
    primaryGlow: `rgba(${r},${g},${b},0.55)`,
    primaryTint: `rgba(${r},${g},${b},0.06)`,
  };
}

function applyColoursLive(c) {
  const root = document.documentElement;
  root.style.setProperty("--fom-red", c.primary);
  root.style.setProperty("--fom-red-deep", c.primaryDeep);
  root.style.setProperty("--fom-red-glow", c.primaryGlow);
  root.style.setProperty("--fom-red-tint", c.primaryTint);
}

/** Replace every child of a select with a fresh option list, no innerHTML. */
function clearSelect(sel) {
  while (sel.firstChild) sel.removeChild(sel.firstChild);
}
function appendOption(parent, value, label) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = label;
  parent.appendChild(o);
}
function appendPlaceholder(sel, text) {
  clearSelect(sel);
  appendOption(sel, "", text);
}

function wireSettingsModal() {
  const modal = document.getElementById("settingsModal");
  const btn = document.getElementById("settingsBtn");
  if (!modal || !btn) return;

  const voiceSel = document.getElementById("settingsVoice");
  const modelSel = document.getElementById("settingsModel");
  const previewBtn = document.getElementById("settingsVoicePreview");
  const saveBtn = document.getElementById("settingsSave");
  const cancelBtn = document.getElementById("settingsCancel");
  const closeBtn = document.getElementById("settingsClose");
  const status = document.getElementById("settingsStatus");
  const swatchHost = document.getElementById("settingsSwatches");
  const accentResetBtn = document.getElementById("settingsAccentReset");
  const cityInput = document.getElementById("settingsCity");
  const coordsLabel = document.getElementById("settingsCoords");
  const locateBtn = document.getElementById("settingsLocate");
  const cameraSel = document.getElementById("settingsCameraMode");
  const suggestEl = document.getElementById("settingsSuggest");
  const profileSel = document.getElementById("settingsProfile");
  const profileNewBtn = document.getElementById("settingsProfileNew");
  const projectSel = document.getElementById("settingsProject");
  const highContrastChk = document.getElementById("settingsHighContrast");
  const fontScaleSel = document.getElementById("settingsFontScale");
  const shootsDirInput = document.getElementById("settingsShootsDir");
  const outputDirInput = document.getElementById("settingsOutputDir");
  const styleTextarea = document.getElementById("settingsCreativeStyle");
  const styleLoadTemplateBtn = document.getElementById("settingsStyleLoadTemplate");
  const styleStatus = document.getElementById("settingsStyleStatus");
  const socialInstagram = document.getElementById("settingsSocialInstagram");
  const socialFacebook = document.getElementById("settingsSocialFacebook");
  const socialX = document.getElementById("settingsSocialX");
  const socialTiktok = document.getElementById("settingsSocialTiktok");
  const tsStatusEl = document.getElementById("settingsTailscaleStatus");
  const tsSetupBtn = document.getElementById("settingsTailscaleSetupBtn");
  const tsAdminBtn = document.getElementById("settingsTailscaleAdminBtn");
  const tsRefreshBtn = document.getElementById("settingsTailscaleRefreshBtn");
  const keyFrameio = document.getElementById("settingsKeyFrameio");
  const keySerpapi = document.getElementById("settingsKeySerpapi");
  const keyHunter = document.getElementById("settingsKeyHunter");

  /* Stash the selected geocode hit so save can skip the second API call when the
   * operator picked an explicit suggestion. Cleared whenever the input mutates. */
  let pickedGeocode = null;
  let suggestActive = -1;
  let suggestDebounce = null;

  /* Stash the colours that were live when the modal opened, so CANCEL / Esc restore
   * the operator's previous state if they were just experimenting. */
  let originalColours = null;
  let pendingColour = null;
  let detectedLocation = null;

  function buildSwatches(activeHex) {
    while (swatchHost.firstChild) swatchHost.removeChild(swatchHost.firstChild);
    for (const sw of SWATCH_COLOURS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-modal__swatch";
      btn.title = sw.name;
      btn.style.background = sw.hex;
      btn.style.color = sw.hex;
      btn.dataset.hex = sw.hex;
      if (sw.hex.toUpperCase() === (activeHex || "").toUpperCase()) btn.classList.add("is-active");
      btn.addEventListener("click", () => {
        for (const s of swatchHost.querySelectorAll(".settings-modal__swatch")) s.classList.remove("is-active");
        btn.classList.add("is-active");
        const c = deriveColours(sw.hex);
        applyColoursLive(c);     // live preview before save
        pendingColour = sw.hex.toUpperCase();
      });
      swatchHost.appendChild(btn);
    }
  }

  function setStatus(msg, kind = "") {
    status.textContent = msg || "";
    status.className = "settings-modal__status" + (kind ? ` is-${kind}` : "");
  }

  /** Fetch /tailscale/status and rewrite the status block + buttons.
   *  Three render branches keyed off (installed, authenticated):
   *   - !installed     → "Not installed" + green setup button
   *   - logged-out     → "Installed but not signed in" + setup button
   *   - connected      → "kiosk-mac · 100.x.x.x" + admin button
   *  Network errors (bridge offline mid-session) render "status unavailable". */
  async function refreshTailscaleStatus() {
    if (!tsStatusEl) return;
    /* Reset visibility so a re-render doesn't show stale state from last open. */
    tsSetupBtn.hidden = true;
    tsAdminBtn.hidden = true;

    while (tsStatusEl.firstChild) tsStatusEl.removeChild(tsStatusEl.firstChild);

    const dot = document.createElement("span");
    dot.className = "settings-modal__tailscale-dot";
    const txt = document.createElement("div");
    txt.className = "settings-modal__tailscale-text";
    const label = document.createElement("span"); label.className = "label";
    const meta = document.createElement("span"); meta.className = "meta";
    txt.appendChild(label); txt.appendChild(meta);
    tsStatusEl.appendChild(dot); tsStatusEl.appendChild(txt);

    let snap;
    try {
      const r = await fetch("http://localhost:8766/tailscale/status", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      snap = await r.json();
    } catch {
      dot.classList.add("is-missing");
      label.textContent = "Status unavailable";
      meta.textContent = "Bridge offline — try ./launch.sh restart";
      return;
    }

    if (!snap.installed) {
      dot.classList.add("is-missing");
      label.textContent = "Tailscale not installed";
      meta.textContent = "Click below to install + authenticate (~2 min)";
      tsSetupBtn.hidden = false;
      tsSetupBtn.textContent = "↻ INSTALL TAILSCALE";
      return;
    }
    if (!snap.authenticated) {
      dot.classList.add("is-warning");
      label.textContent = "Installed — not signed in";
      meta.textContent = "Tailscale uses browser SSO — no password to remember";
      tsSetupBtn.hidden = false;
      tsSetupBtn.textContent = "↻ SIGN IN VIA TERMINAL";
      return;
    }
    /* Connected. Show device identity + reachable URL when serve is enabled. */
    dot.classList.add("is-connected");
    label.textContent = snap.hostname || "Connected";
    const bits = [];
    if (snap.ip) bits.push(snap.ip);
    if (snap.serveActive && snap.serveUrl) bits.push(`HUD: ${snap.serveUrl}`);
    else if (snap.magicDnsName) bits.push(`(serve disabled — re-run setup to enable HTTPS at ${snap.magicDnsName})`);
    meta.textContent = bits.join("  ·  ") || "authenticated";
    tsAdminBtn.hidden = false;
    tsSetupBtn.hidden = false;
    tsSetupBtn.textContent = "↻ RE-RUN SETUP";
  }

  /** Open + fetch state. Defensive against bridge-down: opens with placeholders.
   *  Captures the pre-open colour state so CANCEL / Esc restore it cleanly. */
  async function openModal() {
    modal.hidden = false;
    appendPlaceholder(voiceSel, "loading...");
    appendPlaceholder(modelSel, "loading...");
    setStatus("");
    pendingColour = null;
    /* Snapshot whatever colour the HUD is currently rendering so we can revert on cancel. */
    const cs = getComputedStyle(document.documentElement);
    originalColours = {
      primary: cs.getPropertyValue("--fom-red").trim() || "#E10600",
      primaryDeep: cs.getPropertyValue("--fom-red-deep").trim(),
      primaryGlow: cs.getPropertyValue("--fom-red-glow").trim(),
      primaryTint: cs.getPropertyValue("--fom-red-tint").trim(),
    };

    /* Fetch operator's current location so the city input pre-fills. */
    try {
      const cr = await fetch("http://localhost:8766/config");
      if (cr.ok) {
        const cj = await cr.json();
        const op = cj.operator || {};
        cityInput.value = op.city ? `${op.city}${op.country ? ", " + op.country : ""}` : "";
        if (op.latitude != null && op.longitude != null) {
          coordsLabel.textContent = `lat ${op.latitude.toFixed(4)}, lon ${op.longitude.toFixed(4)} · ${op.timezone || ""}`;
        }
        detectedLocation = { city: op.city, country: op.country, latitude: op.latitude, longitude: op.longitude, timezone: op.timezone };
      }
    } catch {}

    /* Camera mode is a local-only setting (privacy on the device). Read from Storage,
     * write back on save — no bridge round-trip needed. */
    cameraSel.value = Storage.get("cameraMode", "off");

    /* Accessibility prefs — read from Storage on each open in case they were
     * mutated externally (e.g. via dev console). */
    if (highContrastChk) highContrastChk.checked = Storage.get("highContrast", "false") === "true";
    if (fontScaleSel) fontScaleSel.value = Storage.get("fontScale", "m");

    /* Populate profile picker — list active profiles, mark the current one. */
    if (profileSel) {
      clearSelect(profileSel);
      const profiles = window.__profiles?.list?.() || [{ id: "default", name: "Default" }];
      const activeId = window.__profiles?.activeId?.() || "default";
      for (const p of profiles) appendOption(profileSel, p.id, p.name);
      profileSel.value = activeId;
    }

    /* External API keys — fetch presence info from /api-keys and render the
     * inputs as placeholders ("set · …abcd") when configured. The actual key
     * value is NEVER returned by the bridge — operator types a new value to
     * change it, leaves blank to keep the existing one. */
    if (keyFrameio) {
      try {
        const r = await fetch("http://localhost:8766/api-keys", { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          const apply = (input, info) => {
            input.value = "";
            if (info?.set) input.placeholder = `(set ${info.hint || ""}) — type to change`;
          };
          apply(keyFrameio, j.keys?.frameio);
          apply(keySerpapi, j.keys?.serpapi);
          apply(keyHunter, j.keys?.hunter);
        }
      } catch { /* bridge offline — leave default placeholders */ }
    }

    /* Tailscale status — fetch + render. Three states (missing / logged-out /
     * connected) drive the same markup; we just rewrite the label + meta line
     * and toggle which buttons are visible. Defensive: if /tailscale/status
     * returns 4xx/5xx we show "status unavailable" rather than spinning. */
    if (tsStatusEl) {
      await refreshTailscaleStatus();
    }

    /* Social handles — fetch from /brand and pre-fill the four platform inputs.
     * Empty = not configured. Saved back via /settings POST { socials: {…} }. */
    if (socialInstagram) {
      try {
        const r = await fetch("http://localhost:8766/brand", { cache: "no-store" });
        if (r.ok) {
          const b = await r.json();
          const s = b.agency?.socials || {};
          socialInstagram.value = s.instagram || b.agency?.social || "";
          socialFacebook.value = s.facebook || "";
          socialX.value = s.x || "";
          socialTiktok.value = s.tiktok || "";
        }
      } catch { /* bridge offline — leave blank */ }
    }

    /* Creative-style markdown — fetch the operator's CLAUDE.md equivalent.
     * Empty content means they haven't configured it yet; the placeholder in
     * the textarea hints they can click LOAD TEMPLATE to seed from the example. */
    if (styleTextarea) {
      styleTextarea.value = "";
      if (styleStatus) styleStatus.textContent = "";
      try {
        const r = await fetch("http://localhost:8766/style", { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          styleTextarea.value = j.content || "";
          if (styleStatus) styleStatus.textContent = j.exists ? "" : "not yet configured";
        }
      } catch { /* bridge offline — leave blank */ }
    }

    /* Folder roots — fetch from /paths and pre-fill the inputs. Empty = unconfigured
     * (using PROJECT_DIR/shoots and PROJECT_DIR/output defaults). When the operator
     * leaves them blank and saves, the bridge keeps the defaults. */
    if (shootsDirInput && outputDirInput) {
      shootsDirInput.value = "";
      outputDirInput.value = "";
      try {
        const r = await fetch("http://localhost:8766/paths", { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          /* Show the absolute path so the operator can see where their data actually is.
           * If they want to change it they can paste a new absolute or relative path. */
          if (j.shoots) shootsDirInput.value = j.shoots;
          if (j.output) outputDirInput.value = j.output;
        }
      } catch { /* bridge offline — leave blank */ }
    }

    /* Populate project picker from /projects. */
    if (projectSel) {
      clearSelect(projectSel);
      appendOption(projectSel, "", "(none) — let the LLM decide");
      try {
        const r = await fetch("http://localhost:8766/projects", { cache: "no-store" });
        if (r.ok) {
          const j = await r.json();
          for (const p of (j.items || [])) {
            const counts = `${p.images || 0}i · ${p.videos || 0}v`;
            appendOption(projectSel, p.id, `${p.label}  (${counts})`);
          }
          projectSel.value = j.active || "";
        }
      } catch { /* bridge offline; only "(none)" available */ }
    }

    try {
      const r = await fetch("http://localhost:8766/settings");
      if (!r.ok) throw new Error(`bridge ${r.status}`);
      const d = await r.json();
      buildSwatches(originalColours.primary);

      /* Voices: British (bf_/bm_) at top with friendly labels, then everything else. */
      const all = (d.voice.available || []).slice();
      const british = all.filter(v => v.startsWith("bf_") || v.startsWith("bm_")).sort();
      const others = all.filter(v => !(v.startsWith("bf_") || v.startsWith("bm_"))).sort();
      clearSelect(voiceSel);
      if (british.length) {
        const grp = document.createElement("optgroup");
        grp.label = "British (preferred)";
        voiceSel.appendChild(grp);
        for (const v of british) appendOption(grp, v, VOICE_LABELS[v] || v);
      }
      if (others.length) {
        const grp = document.createElement("optgroup");
        grp.label = "Other accents";
        voiceSel.appendChild(grp);
        for (const v of others) appendOption(grp, v, v);
      }
      voiceSel.value = d.voice.current || d.voice.default;

      /* Models: only qwen2.5:* installed — bridge already filters. */
      clearSelect(modelSel);
      if (!(d.model.available || []).length) {
        appendOption(modelSel, "", "no qwen2.5 models pulled — run: ollama pull qwen2.5:14b");
      } else {
        for (const m of d.model.available) appendOption(modelSel, m.name, formatModelLabel(m));
        modelSel.value = d.model.current;
      }
    } catch (e) {
      setStatus(`couldn't reach the bridge — ${e.message}`, "error");
    }
  }

  function closeModal({ revert = true } = {}) {
    /* Revert any unsaved colour preview so cancel / Esc don't leave the HUD repainted. */
    if (revert && pendingColour && originalColours) {
      applyColoursLive(originalColours);
    }
    pendingColour = null;
    modal.hidden = true;
    setStatus("");
  }

  /** Synthesise a short preview clip via Kokoro at the currently-selected voice. */
  async function previewVoice() {
    const v = voiceSel.value;
    if (!v) return;
    previewBtn.disabled = true;
    setStatus("synthesising...", "");
    try {
      const sample = v.startsWith("bm_")
        ? "Voice check, sir. Bridge is up and ready when you are."
        : v.startsWith("bf_")
        ? "Voice check. Ready to assist whenever you are."
        : "Voice check. Sample synthesis ready.";
      const res = await fetch("http://localhost:8767/tts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: sample, voice: v }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}`);
      const wav = await res.arrayBuffer();
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(wav);
      const src = ctx.createBufferSource(); src.buffer = buf;
      src.connect(ctx.destination); src.start(0);
      setStatus("");
    } catch (e) {
      setStatus(`preview failed — ${e.message}`, "error");
    } finally {
      previewBtn.disabled = false;
    }
  }

  /** Save voice + model + colour + location. Persists via bridge AND mirrors voice
   *  into localStorage so getKokoroVoice() reads the new value without a reload. */
  async function save() {
    saveBtn.disabled = true;
    setStatus("saving...", "");
    const payload = {};
    if (voiceSel.value) payload.voice = voiceSel.value;
    if (modelSel.value) payload.model = modelSel.value;
    /* Why: accent colour is now per-profile preference (stored in Storage) rather
     * than written to brand.json. Brand.json stays the agency-wide default; the
     * operator's personal choice layers on top via the bootstrap. */
    let colourChanged = false;
    if (pendingColour === "__reset__") {
      /* Reset sentinel — drop the per-profile override so the bootstrap falls back
       * to the agency-wide brand colour. */
      Storage.remove("accentColor");
      colourChanged = true;
    } else if (pendingColour) {
      Storage.set("accentColor", pendingColour);
      colourChanged = true;
    }

    /* Active project is browser-driven — POST directly + persist locally so the
     * next boot restores it. Empty value means "no scope" (clear at bridge). */
    let projectChanged = false;
    if (projectSel) {
      const newProject = projectSel.value || null;
      const prevProject = Storage.get("activeProject", "");
      if ((newProject || "") !== (prevProject || "")) {
        Storage.set("activeProject", newProject || "");
        try {
          await fetch("http://localhost:8766/project/active", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: newProject }),
          });
          projectChanged = true;
        } catch { /* bridge offline; the persisted Storage value will sync on next boot */ }
      }
    }

    /* Accessibility prefs — browser-local, applied immediately. */
    let a11yChanged = false;
    if (highContrastChk) {
      const newHC = highContrastChk.checked ? "true" : "false";
      if (newHC !== Storage.get("highContrast", "false")) {
        Storage.set("highContrast", newHC);
        a11yChanged = true;
      }
    }
    if (fontScaleSel && fontScaleSel.value) {
      const newScale = fontScaleSel.value;
      if (newScale !== Storage.get("fontScale", "m")) {
        Storage.set("fontScale", newScale);
        a11yChanged = true;
      }
    }
    if (a11yChanged) applyAccessibilityPrefs();

    /* Camera mode is browser-local; persist immediately, regardless of bridge call. */
    const newCamMode = cameraSel.value;
    const prevCamMode = Storage.get("cameraMode", "off");
    let cameraChanged = false;
    if (newCamMode && newCamMode !== prevCamMode) {
      Storage.set("cameraMode", newCamMode);
      cameraChanged = true;
      /* If turning the camera ON for the first time this session, kick wireCamera()
       * so the stream initialises before the next state change. */
      if (prevCamMode === "off" && newCamMode !== "off" && typeof window.wireCamera === "function") {
        window.wireCamera().catch(() => {});
      }
      /* Apply visibility immediately based on whatever state we're in. */
      const speedoEl = document.getElementById("speedo");
      const currentState = speedoEl?.classList.contains("is-listening") ? "listening"
                         : speedoEl?.classList.contains("is-thinking")  ? "thinking"
                         : speedoEl?.classList.contains("is-speaking")  ? "speaking"
                         : "idle";
      applyCameraVisibility(currentState);
    }

    /* External API keys — collect any non-empty inputs and POST to /api-keys.
     * Empty input = "leave existing value alone" (we never trash an existing
     * key by accident). The bridge writes to .env + updates process.env so
     * the change is live without restart. */
    let apiKeysChanged = false;
    if (keyFrameio) {
      const payload2 = {};
      if (keyFrameio.value.trim()) payload2.frameio = keyFrameio.value.trim();
      if (keySerpapi.value.trim()) payload2.serpapi = keySerpapi.value.trim();
      if (keyHunter.value.trim())  payload2.hunter  = keyHunter.value.trim();
      if (Object.keys(payload2).length) {
        try {
          const r = await fetch("http://localhost:8766/api-keys", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload2),
          });
          if (r.ok) {
            apiKeysChanged = true;
            /* Clear the inputs so the operator doesn't accidentally re-submit
             * on next save; the masked placeholder will refresh on next open. */
            [keyFrameio, keySerpapi, keyHunter].forEach(el => { el.value = ""; });
          }
        } catch { /* surfaced via the main save status */ }
      }
    }

    /* Social handles — diff against what /brand currently reports, only attach
     * to payload if any of the four changed. Sending the whole object is fine
     * (the bridge merges field-by-field) but skipping the round-trip on no-op
     * keeps the "no changes" status accurate. */
    if (socialInstagram) {
      try {
        const r = await fetch("http://localhost:8766/brand", { cache: "no-store" });
        if (r.ok) {
          const b = await r.json();
          const cur = b.agency?.socials || {};
          const newSocials = {
            instagram: (socialInstagram.value || "").trim(),
            facebook: (socialFacebook.value || "").trim(),
            x: (socialX.value || "").trim(),
            tiktok: (socialTiktok.value || "").trim(),
          };
          const dirty = ["instagram", "facebook", "x", "tiktok"].some(
            k => newSocials[k] !== ((cur[k] || (k === "instagram" ? b.agency?.social : "")) || "")
          );
          if (dirty) payload.socials = newSocials;
        } else {
          /* Bridge didn't return /brand — be safe and send anyway. */
          payload.socials = {
            instagram: (socialInstagram.value || "").trim(),
            facebook: (socialFacebook.value || "").trim(),
            x: (socialX.value || "").trim(),
            tiktok: (socialTiktok.value || "").trim(),
          };
        }
      } catch { /* bridge offline — skip; main save will catch it */ }
    }

    /* Folders — only POST if either input changed. Send paths separately because they
     * are validated (mkdir-tested) before brand.json is rewritten; combining with the
     * /settings POST would mean a folder typo blocks unrelated saves like voice change. */
    let foldersChanged = false;
    let foldersError = null;
    if (shootsDirInput && outputDirInput) {
      const newShoots = (shootsDirInput.value || "").trim();
      const newOutput = (outputDirInput.value || "").trim();
      const folderPayload = {};
      try {
        const cur = await fetch("http://localhost:8766/paths", { cache: "no-store" }).then(r => r.json()).catch(() => ({}));
        if (newShoots && newShoots !== cur.shoots) folderPayload.shoots = newShoots;
        if (newOutput && newOutput !== cur.output) folderPayload.output = newOutput;
      } catch { /* fall through with whatever the operator typed */ }
      if (Object.keys(folderPayload).length) {
        try {
          const r = await fetch("http://localhost:8766/paths", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(folderPayload),
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || `bridge ${r.status}`);
          foldersChanged = true;
        } catch (e) {
          foldersError = e.message;
        }
      }
    }

    if (foldersError) {
      setStatus(`folders: ${foldersError}`, "error");
      saveBtn.disabled = false;
      return;
    }

    /* Resolve location: only send if the operator actually edited the city field. */
    const enteredCity = (cityInput.value || "").trim();
    const previousCity = detectedLocation?.city ? `${detectedLocation.city}${detectedLocation.country ? ", " + detectedLocation.country : ""}` : "";
    if (pickedGeocode) {
      /* Operator picked an explicit suggestion — use its canonical lat/lon/timezone
       * directly. Skips the second geocode round-trip and avoids "Manchester" defaulting
       * to the wrong continent at save time. */
      payload.location = { ...pickedGeocode };
    } else if (enteredCity && enteredCity.toLowerCase() !== previousCity.toLowerCase()) {
      /* No suggestion picked — fall back to the silent on-save geocode. */
      try {
        const cityOnly = enteredCity.split(",")[0].trim();
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityOnly)}&count=1&language=en`);
        const gj = await g.json();
        const hit = (gj.results || [])[0];
        if (hit) {
          payload.location = {
            city: hit.name,
            country: hit.country,
            latitude: hit.latitude,
            longitude: hit.longitude,
            timezone: hit.timezone,
          };
        } else {
          /* Geocoder couldn't find it — pass the raw city + leave coords as-is so the
           * bridge keeps the previous lat/lon. Weather will be off until corrected. */
          payload.location = { city: cityOnly };
        }
      } catch {
        payload.location = { city: enteredCity };
      }
    }

    /* Save creative-style markdown via /style. Independent endpoint from
     * /settings — keeps a typo in the bridge's brand-write path from blocking
     * a style-only edit (and vice-versa). Done before /settings so a 4xx here
     * doesn't make the operator think their voice/model save failed. */
    let styleChanged = false;
    if (styleTextarea) {
      try {
        const sr = await fetch("http://localhost:8766/style", { cache: "no-store" });
        const sj = sr.ok ? await sr.json() : { content: "" };
        const newStyle = styleTextarea.value || "";
        if (newStyle !== (sj.content || "")) {
          const wr = await fetch("http://localhost:8766/style", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: newStyle }),
          });
          const wj = await wr.json();
          if (wr.ok && wj.ok) styleChanged = true;
          else if (styleStatus) {
            styleStatus.textContent = `save failed — ${wj.error || wr.status}`;
            styleStatus.className = "settings-modal__hint is-error";
          }
        }
      } catch (e) {
        if (styleStatus) {
          styleStatus.textContent = `save failed — ${e.message}`;
          styleStatus.className = "settings-modal__hint is-error";
        }
      }
    }

    try {
      const r = await fetch("http://localhost:8766/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || `bridge ${r.status}`);
      if (payload.voice) Storage.set(VOICE_KEY, payload.voice);
      const parts = [];
      if (d.updated.voice) parts.push(`voice → ${d.updated.voice}`);
      if (d.updated.model) parts.push(`model → ${d.updated.model}`);
      if (colourChanged) parts.push(`accent → ${pendingColour}`);
      if (d.updated.location) parts.push(`location → ${d.updated.location.city}`);
      if (cameraChanged) parts.push(`camera → ${newCamMode}`);
      if (projectChanged) parts.push(`project → ${projectSel.value || "(none)"}`);
      if (foldersChanged) parts.push("folders updated");
      if (styleChanged) parts.push("style guide updated");
      if (d.updated.socials) parts.push("socials updated");
      if (apiKeysChanged) parts.push("API keys updated");
      setStatus(parts.length ? `saved · ${parts.join(", ")}` : "no changes", "ok");
      /* Don't revert colour on close — operator just confirmed it. */
      pendingColour = null;
      setTimeout(() => closeModal({ revert: false }), 1100);
    } catch (e) {
      setStatus(`save failed — ${e.message}`, "error");
    } finally {
      saveBtn.disabled = false;
    }
  }

  /** Re-detect operator location via the bridge's /config/redetect endpoint. Updates
   *  the city input + coords readout in place — operator can still edit before save. */
  async function redetectLocation() {
    locateBtn.disabled = true;
    setStatus("re-detecting...", "");
    try {
      const r = await fetch("http://localhost:8766/config/redetect");
      if (!r.ok) throw new Error(`bridge ${r.status}`);
      const cj = await r.json();
      const op = cj.operator || {};
      cityInput.value = op.city ? `${op.city}${op.country ? ", " + op.country : ""}` : "";
      if (op.latitude != null && op.longitude != null) {
        coordsLabel.textContent = `lat ${op.latitude.toFixed(4)}, lon ${op.longitude.toFixed(4)} · ${op.timezone || ""}`;
      }
      detectedLocation = op;
      setStatus(`detected ${op.city}`, "ok");
    } catch (e) {
      setStatus(`detect failed — ${e.message}`, "error");
    } finally {
      locateBtn.disabled = false;
    }
  }

  /* ────────── Location typeahead ──────────
   * As the operator types, hit Open-Meteo's free /v1/search endpoint and render up
   * to 5 disambiguating suggestions. Picking a suggestion stashes the canonical
   * lat/lon/timezone so save() skips the second geocode round-trip. Keyboard arrows
   * + enter mirror the mouse-click flow. Empty / short queries hide the dropdown. */
  function hideSuggest() {
    suggestEl.hidden = true;
    while (suggestEl.firstChild) suggestEl.removeChild(suggestEl.firstChild);
    suggestActive = -1;
  }

  /** Highlight match characters inside a name. Pure cosmetic — Open-Meteo returns the
   *  best matches by name, region, country; bolding the typed substring helps the
   *  operator see WHY a result was returned (it might match on alt-name not display). */
  function highlightMatch(name, query) {
    const lc = name.toLowerCase();
    const q = query.toLowerCase().trim();
    if (!q) return name;
    const i = lc.indexOf(q);
    if (i < 0) return name;
    const before = name.slice(0, i);
    const hit = name.slice(i, i + q.length);
    const after = name.slice(i + q.length);
    const span = document.createElement("span");
    span.appendChild(document.createTextNode(before));
    const strong = document.createElement("strong");
    strong.textContent = hit;
    span.appendChild(strong);
    span.appendChild(document.createTextNode(after));
    return span;
  }

  function renderSuggestions(query, results) {
    while (suggestEl.firstChild) suggestEl.removeChild(suggestEl.firstChild);
    if (!results.length) {
      const empty = document.createElement("div");
      empty.className = "settings-modal__suggest-empty";
      empty.textContent = `No match for "${query}"`;
      suggestEl.appendChild(empty);
      suggestEl.hidden = false;
      return;
    }
    results.forEach((r, i) => {
      const row = document.createElement("div");
      row.className = "settings-modal__suggest-row";
      row.dataset.idx = String(i);

      const nameWrap = document.createElement("div");
      nameWrap.className = "settings-modal__suggest-name";
      const display = [r.name, r.admin1, r.country].filter(Boolean).join(", ");
      const high = highlightMatch(display, query);
      if (typeof high === "string") nameWrap.textContent = high;
      else nameWrap.appendChild(high);

      const region = document.createElement("div");
      region.className = "settings-modal__suggest-region";
      /* Why: show coords as the secondary cue — operator can sanity-check that
       * "Manchester" picked the right hemisphere before committing. */
      region.textContent = `${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}`;

      row.appendChild(nameWrap);
      row.appendChild(region);
      row.addEventListener("mousedown", (e) => {
        /* Why: mousedown not click — the input's blur event would fire first on a
         * click and tear down the dropdown before our handler gets called. */
        e.preventDefault();
        selectSuggestion(r);
      });
      suggestEl.appendChild(row);
    });
    suggestEl.hidden = false;
    suggestActive = -1;
  }

  function selectSuggestion(r) {
    pickedGeocode = {
      city: r.name,
      country: r.country,
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: r.timezone,
    };
    cityInput.value = `${r.name}${r.country ? ", " + r.country : ""}`;
    coordsLabel.textContent = `lat ${r.latitude.toFixed(4)}, lon ${r.longitude.toFixed(4)} · ${r.timezone || ""}`;
    hideSuggest();
  }

  /** Debounced input listener — fires geocode 250ms after typing stops. 250ms is
   *  the sweet spot per typeahead UX research: feels live, doesn't hammer the API. */
  cityInput.addEventListener("input", () => {
    /* Any keystroke invalidates a previously-picked suggestion — operator is editing. */
    pickedGeocode = null;
    const q = cityInput.value.trim();
    if (suggestDebounce) { clearTimeout(suggestDebounce); suggestDebounce = null; }
    if (q.length < 2) { hideSuggest(); return; }
    suggestDebounce = setTimeout(async () => {
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en`, { signal: AbortSignal.timeout(4000) });
        if (!r.ok) return;
        const j = await r.json();
        renderSuggestions(q, j.results || []);
      } catch { /* ignore — no suggestions is fine */ }
    }, 250);
  });

  cityInput.addEventListener("keydown", (e) => {
    if (suggestEl.hidden) return;
    const rows = [...suggestEl.querySelectorAll(".settings-modal__suggest-row")];
    if (!rows.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      suggestActive += e.key === "ArrowDown" ? 1 : -1;
      if (suggestActive < 0) suggestActive = rows.length - 1;
      if (suggestActive >= rows.length) suggestActive = 0;
      rows.forEach((r, i) => r.classList.toggle("is-active", i === suggestActive));
    } else if (e.key === "Enter") {
      if (suggestActive >= 0) {
        e.preventDefault();
        rows[suggestActive].dispatchEvent(new MouseEvent("mousedown"));
      }
    } else if (e.key === "Escape") {
      hideSuggest();
    }
  });

  cityInput.addEventListener("blur", () => {
    /* Slight delay so click handlers on rows fire before we tear down. */
    setTimeout(hideSuggest, 150);
  });

  btn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", () => closeModal());
  cancelBtn.addEventListener("click", () => closeModal());
  saveBtn.addEventListener("click", save);
  previewBtn.addEventListener("click", previewVoice);
  locateBtn.addEventListener("click", redetectLocation);

  /* API-key show/hide toggles. Each toggle button has data-target=<input id>;
   * we just flip the input's type between password and text. Single delegated
   * listener so adding more keys later doesn't need new wiring. */
  document.querySelectorAll(".settings-modal__key-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      target.type = target.type === "password" ? "text" : "password";
    });
  });

  /* Tailscale buttons — refresh re-fetches status, setup pops Terminal at
   * the install wrapper, admin opens the Tailscale admin console. */
  if (tsRefreshBtn) tsRefreshBtn.addEventListener("click", () => refreshTailscaleStatus());
  if (tsSetupBtn) {
    tsSetupBtn.addEventListener("click", async () => {
      tsSetupBtn.disabled = true;
      try {
        const r = await fetch("http://localhost:8766/tailscale/launch-installer", { method: "POST" });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
        /* Give Terminal a beat to come up + start the install, then re-poll
         * so the operator sees state change without manually clicking REFRESH. */
        setTimeout(() => refreshTailscaleStatus(), 4000);
      } catch (e) {
        alert(`Could not open Terminal: ${e.message}\n\nRun this in Terminal yourself:\n  cd ~/Desktop/Jarvis && ./tools/install-tailscale.sh`);
      } finally {
        tsSetupBtn.disabled = false;
      }
    });
  }
  if (tsAdminBtn) {
    /* admin.tailscale.com is the canonical machines view; safe to hard-code. */
    tsAdminBtn.addEventListener("click", () => {
      window.open("https://login.tailscale.com/admin/machines", "_blank", "noopener");
    });
  }

  /* Load template — fetches the example creative-style.md from the static
   * server so the operator can start from the Flat-Out baseline + tweak.
   * Confirms before clobbering existing edits. */
  if (styleLoadTemplateBtn && styleTextarea) {
    styleLoadTemplateBtn.addEventListener("click", async () => {
      if (styleTextarea.value.trim() && !confirm("Replace the current style with the example template? Your unsaved changes will be lost.")) {
        return;
      }
      styleLoadTemplateBtn.disabled = true;
      if (styleStatus) styleStatus.textContent = "loading template...";
      try {
        const r = await fetch("/config/creative-style.example.md", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        styleTextarea.value = text;
        if (styleStatus) {
          styleStatus.textContent = "template loaded — review then SAVE";
          styleStatus.className = "settings-modal__hint is-saved";
        }
      } catch (e) {
        if (styleStatus) {
          styleStatus.textContent = `failed — ${e.message}`;
          styleStatus.className = "settings-modal__hint is-error";
        }
      } finally {
        styleLoadTemplateBtn.disabled = false;
      }
    });
  }

  /* Accent reset — clears the per-profile override so the bootstrap falls back to the
   * brand-wide default from config/brand.json. Live-applies the brand colour so the
   * operator sees the result immediately. They still need to SAVE for it to persist
   * (mirrors the swatch picker pattern). */
  if (accentResetBtn) {
    accentResetBtn.addEventListener("click", async () => {
      try {
        const r = await fetch("http://localhost:8766/brand", { cache: "no-store" });
        if (!r.ok) throw new Error(`bridge ${r.status}`);
        const brand = await r.json();
        const brandPrimary = (brand?.colors?.primary || "#E10600").toUpperCase();
        const c = deriveColours(brandPrimary);
        applyColoursLive(c);
        /* Clear any pending swatch selection + null sentinel so save() removes the
         * override rather than re-saving the brand colour as a personal preference. */
        for (const s of swatchHost.querySelectorAll(".settings-modal__swatch")) s.classList.remove("is-active");
        pendingColour = "__reset__";
        setStatus(`accent reset → brand default ${brandPrimary}`, "ok");
      } catch (e) {
        setStatus(`reset failed — ${e.message}`, "error");
      }
    });
  }

  /* Profile switching — change of select fires the switch (which reloads). */
  if (profileSel) {
    profileSel.addEventListener("change", () => {
      const target = profileSel.value;
      const active = window.__profiles?.activeId?.();
      if (target && target !== active) {
        /* Confirm before reload — prevents accidental switches mid-conversation. */
        if (confirm(`Switch to profile "${target}"? The kiosk will reload.`)) {
          window.__profiles?.switchTo?.(target);
        } else {
          profileSel.value = active;
        }
      }
    });
  }
  if (profileNewBtn) {
    profileNewBtn.addEventListener("click", () => {
      const name = prompt("Profile name (e.g. 'Marcus', 'Editor', 'MD'):");
      if (!name) return;
      const created = window.__profiles?.create?.({ name });
      if (!created) {
        setStatus("profile already exists with that id", "error");
        return;
      }
      /* Auto-switch into the new profile so the operator can start configuring it. */
      if (confirm(`Created "${created.name}". Switch to it now?`)) {
        window.__profiles?.switchTo?.(created.id);
      } else {
        /* Keep the modal open + add the new option to the list. */
        appendOption(profileSel, created.id, created.name);
      }
    });
  }
  /* Click outside the panel to dismiss — modal background swallows the click. */
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  /* Esc closes — consistent with the rest of the kiosk. */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closeModal();
  });
}

/* Expose a typed-query entry point for the command palette + future help cheatsheet.
 * Same pipeline as voice — runs the query through handleHeard(text, isFinal=true). */
window.__runQuery = (text) => handleHeard(String(text || "").trim(), true);

document.addEventListener("DOMContentLoaded", wireUI);
