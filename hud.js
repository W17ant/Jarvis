/** hud.js - Jarvis HUD: drives clock, calendar, speedo decorations, gauges, telemetry waveform.
 *  All values here are demo-realistic mocks. Phase 2 wires real data from jarvis backend. */

import * as Storage from "./storage.js";
import * as Tour from "./onboarding-tour.js";
import * as Voice from "./voice.js";
import * as WorkspaceSwitcher from "./workspace-switcher.js";
import * as Inbox from "./inbox.js";
import * as Orb from "./orb.js";
/* Sprint 12 — share bridge-client's WS instead of opening hud.js's own.
 * Two WSes per tab × N tabs was overwhelming Chrome's localhost networking
 * stack, causing the cycling-disconnects bug. One WS per tab now. */
import * as Bridge from "./bridge-client.js";

const $ = (id) => document.getElementById(id);

/* ---------- CLOCK + DATE ---------- */
function tickClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  $("clock").textContent = `${hh}:${mm}`;
  $("clockSec").textContent = `:${ss}`;

  const fmt = now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  $("clockDate").textContent = fmt.toUpperCase();

  /* dayNumber + monthName were the panel--month ring readouts. That panel
   * was retired in the white-label cleanup, so the elements may be null —
   * guard each write so tickClock() doesn't throw and break the rest of
   * boot (the throw was killing connectBridge, leaving the HUD with no
   * live data). */
  const dayEl = $("dayNumber");
  if (dayEl) dayEl.textContent = String(now.getDate()).padStart(2, "0");
  const monthEl = $("monthName");
  if (monthEl) monthEl.textContent = now.toLocaleDateString("en-GB", { month: "long" }).toUpperCase();
}

/* ---------- CALENDAR STRIP ---------- */
function renderCalendar() {
  const now = new Date();
  const today = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const host = $("calendarDays");
  host.replaceChildren();
  for (let d = 1; d <= daysInMonth; d++) {
    const el = document.createElement("span");
    el.textContent = String(d).padStart(2, "0");
    if (d === today) el.classList.add("is-today");
    host.appendChild(el);
  }
}

/* ---------- SPEEDO TICKS + NUMERALS ----------
 * Why: render programmatically so we can swap dial range / red-zone with one constant. */
const SPEEDO_CFG = {
  cx: 300, cy: 300, r: 250,
  startAngle: -210,
  endAngle: 30,
  majorEvery: 20,
  redZoneFrom: 160,
  max: 200,
};

function deg2rad(d) { return (d * Math.PI) / 180; }

/* (buildTicks + buildNumerals removed — they generated 0-200 RPM scale + red
 * zone for the FOM speedometer. White-label reactor has no scale or numerals.
 * SPEEDO_CFG kept for backwards-compat readers but is no longer referenced. */

/** Move the needle to a 0..max value, mapped onto the speedo arc.
 *  Why: just rotate(angle) — the CSS transform-origin handles the pivot at (300,300) via view-box. */
export function setNeedle(value) {
  const { startAngle, endAngle, max } = SPEEDO_CFG;
  const v = Math.max(0, Math.min(max, value));
  const angle = startAngle + (endAngle - startAngle) * (v / max) + 90;
  const needle = document.getElementById("needle");
  if (needle) needle.setAttribute("transform", `rotate(${angle.toFixed(2)})`);
}
window.setNeedle = setNeedle;

/* ---------- GAUGES ----------
 * Why: the system pods are full circles with r=42 → circumference 2π·42 ≈ 264.
 * The same setArcGauge fn drives all three pods (CPU/GPU/RAM) — one source of truth. */
const CPU_ARC_LEN = 264;
function setCpuGauge(pct) {
  const fill = document.getElementById("cpuArc");
  if (!fill) return;
  fill.style.strokeDashoffset = CPU_ARC_LEN * (1 - pct / 100);
  $("cpuValue").textContent = `${Math.round(pct)} %`;
}

const MONTH_RING_LEN = 578;
function setMonthRing() {
  const now = new Date();
  const day = now.getDate();
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const fill = document.querySelector(".ring__fill--month");
  if (!fill) return;
  fill.style.strokeDashoffset = MONTH_RING_LEN * (1 - day / dim);
}

/* Waveform is now driven by voice.js (state-aware: real mic data when listening,
 * synthesised pulse when speaking, soft drift when idle). hud.js leaves the canvas alone. */
function startWaveform() { /* no-op */ }

/* ─────────────────────────────────────────────────────────────────────────
 * Centerpiece picker — Sprint 10
 *
 * The kiosk has two centerpiece options:
 *   "reactor" (default) — the existing SVG instrument cluster (rim chips,
 *                          per-core arcs, voice waveform centerpiece, scan
 *                          line). Lives inside .speedo.
 *   "orb"               — Three.js audio-reactive particle sphere. Mounts
 *                          a canvas inside .speedo on top of the SVG, with
 *                          the SVG dimmed via CSS so the orb reads cleanly.
 *
 * Operator picks via Settings → Centerpiece. Hot-swap on change without
 * reload — initCenterpiece() reads Storage and wires the chosen module. */
let _orbHandle = null;
async function initCenterpiece() {
  const choice = Storage.get("centerpiece", "reactor");
  document.body.dataset.centerpiece = choice;
  if (choice === "orb") {
    const speedoEl = document.getElementById("speedo");
    if (!speedoEl) return;
    /* Mount orb inside the speedo container so it occupies the same
     * grid cell. CSS in body[data-centerpiece="orb"] dims the SVG. */
    try {
      _orbHandle = await Orb.init(speedoEl, { analyser: window.__speedo?.analyser || null });
      /* If the voice analyser isn't bound yet (it's lazy-acquired on first
       * mic prompt), poll until it is and pass it to the orb. */
      const wait = setInterval(() => {
        const a = window.__speedo?.analyser;
        if (a && _orbHandle) {
          _orbHandle.setAnalyser(a);
          clearInterval(wait);
        }
      }, 500);
      /* Stop polling after 30s — operator hasn't engaged voice. Orb stays
       * in pure-breathing mode until they do; analyser binds on next try. */
      setTimeout(() => clearInterval(wait), 30000);
    } catch (e) {
      console.warn("[hud] orb init failed:", e.message, "— falling back to reactor");
      document.body.dataset.centerpiece = "reactor";
    }
  }
}

/** Public hook for settings — operator picks a new centerpiece, we
 *  destroy the old + mount the new without reloading. */
export async function setCenterpiece(choice) {
  const next = choice === "orb" ? "orb" : "reactor";
  Storage.set("centerpiece", next);
  if (_orbHandle) {
    _orbHandle.destroy();
    _orbHandle = null;
  }
  document.body.dataset.centerpiece = next;
  if (next === "orb") {
    const speedoEl = document.getElementById("speedo");
    if (speedoEl) {
      _orbHandle = await Orb.init(speedoEl, { analyser: window.__speedo?.analyser || null });
    }
  }
}

/** Push the current voice state through to the orb (idle/listening/
 *  thinking/speaking). voice.js's setState callback wires this — same
 *  hook the SVG state chip uses, just forwarded. */
export function setOrbState(state) {
  if (_orbHandle) _orbHandle.setState(state);
}

/** Refresh the orb's accent colour after a workspace switch. Called
 *  from workspace-switcher.js's _paintChip when the persona changes. */
export function refreshOrbAccent() {
  if (_orbHandle) Orb.refreshAccent();
}

/* Cross-module access without circular imports — voice.js + workspace-
 * switcher.js call setOrbState / refreshOrbAccent through this surface
 * so they don't have to import hud.js (which imports them). */
if (typeof window !== "undefined") {
  window.__hud = {
    setCenterpiece,
    setOrbState,
    refreshOrbAccent,
  };
}

/* ---------- WEATHER (mocked) ---------- */
function renderWeather() {
  const dayShort = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const todayIdx = new Date().getDay();
  const data = [
    { day: "TOMORROW", hi: 16, lo: 9 },
    { day: dayShort[(todayIdx + 2) % 7], hi: 17, lo: 10 },
    { day: dayShort[(todayIdx + 3) % 7], hi: 19, lo: 11 },
    { day: dayShort[(todayIdx + 4) % 7], hi: 18, lo: 12 },
    { day: dayShort[(todayIdx + 5) % 7], hi: 15, lo: 8 },
  ];
  const host = $("weatherForecast");
  host.replaceChildren();
  for (const d of data) {
    const li = document.createElement("li");
    const a = document.createElement("span"); a.className = "day"; a.textContent = d.day;
    const b = document.createElement("span"); b.className = "hi";  b.textContent = `${d.hi}°`;
    const c = document.createElement("span"); c.className = "lo";  c.textContent = `${d.lo}°`;
    li.append(a, b, c);
    host.appendChild(li);
  }
}

/* ---------- IDLE NEEDLE BREATHING ---------- */
function startIdleNeedle() {
  let t = 0;
  setInterval(() => {
    t += 0.03;
    const v = 30 + Math.sin(t) * 12 + Math.sin(t * 2.7) * 4;
    setNeedle(v);
  }, 180);
}

/* ---------- LIVE STATS via bridge websocket ----------
 * Why: browsers can't read CPU/RAM/net directly. Bridge polls the OS and pushes here.
 * Falls back to mocked data if bridge isn't running so the demo still looks alive.
 * Sprint 12: no longer opens its own WS — subscribes to bridge-client.js's
 * shared pubsub. BRIDGE_URL constant retired; bridgeWS variable retired. */
let lastStatsTs = 0;

/** Sets a half-arc gauge by id from a 0..100 percentage. Reused for CPU / GPU / RAM. */
function setArcGauge(id, pct) {
  const fill = document.getElementById(id);
  if (!fill) return;
  const p = Math.max(0, Math.min(100, pct || 0));
  fill.style.strokeDashoffset = CPU_ARC_LEN * (1 - p / 100);
}

/* ----- Sparkline buffers + renderer (telemetry sci-fi look) -----
 * 60-sample rolling buffer at 1.5s cadence = 90s of history per metric.
 * Per-canvas state is cached on the element so we don't re-getContext or
 * re-read CSS variables on every tick. Stroke colour comes from the live
 * --accent CSS variable so per-profile palette overrides flow through. */
const SPARK_BUFLEN = 60;
const _sparkBuffers = { cpu: [], gpu: [], ram: [] };

/** Read --accent from :root and parse to {r,g,b} for canvas rgba() use.
 *  Cached for 1s so we don't read computedStyle on every paint. */
let _accentRgbCache = null;
let _accentRgbCacheAt = 0;
function _accentRgb() {
  const now = Date.now();
  if (_accentRgbCache && now - _accentRgbCacheAt < 1000) return _accentRgbCache;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#00d4ff";
  const m = raw.match(/^#?([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    _accentRgbCache = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  } else {
    _accentRgbCache = { r: 0, g: 212, b: 255 };
  }
  _accentRgbCacheAt = now;
  return _accentRgbCache;
}

/** Initialise a sparkline canvas: cache ctx, scale for device pixel ratio,
 *  store CSS pixel dimensions on the element. Idempotent — safe to re-call. */
function _initSparkCanvas(canvas) {
  if (canvas._jrInited) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  canvas._jrCtx = ctx;
  canvas._jrCssW = cssW;
  canvas._jrCssH = cssH;
  canvas._jrInited = true;
}

function _pushSpark(metric, value) {
  if (value == null || Number.isNaN(value)) return;
  const buf = _sparkBuffers[metric];
  buf.push(Math.max(0, Math.min(100, value)));
  if (buf.length > SPARK_BUFLEN) buf.shift();
}

function _drawSpark(metric) {
  const canvas = document.querySelector(`canvas[data-metric="${metric}"]`);
  if (!canvas) return;
  const buf = _sparkBuffers[metric];
  if (!buf.length) return;
  _initSparkCanvas(canvas);
  const ctx = canvas._jrCtx;
  const w = canvas._jrCssW, h = canvas._jrCssH;
  ctx.clearRect(0, 0, w, h);

  const pad = 2;
  const innerH = h - pad * 2;
  const stepX = w / Math.max(1, SPARK_BUFLEN - 1);
  const startX = (SPARK_BUFLEN - buf.length) * stepX;
  const { r, g, b } = _accentRgb();

  ctx.beginPath();
  for (let i = 0; i < buf.length; i++) {
    const x = startX + i * stepX;
    const y = pad + (1 - buf[i] / 100) * innerH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.5)`;
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.lineTo(startX + (buf.length - 1) * stepX, h - pad);
  ctx.lineTo(startX, h - pad);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.35)`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.02)`);
  ctx.fillStyle = grad;
  ctx.fill();
}

/** Drive the paired-dial telemetry layout: CPU °C, GPU °C, VRAM in-use,
 *  NET ↓, NET ↑. CPU/GPU temps come from macmon (sudoless Apple Silicon
 *  SMC reader). When macmon isn't installed both fall back to "—°".
 *  Temp dials scaled 30→100°C as the "heat budget" range. NET dials
 *  scaled 0..10 MB/s as the visible-fill range. */
function _updateThermalUI(stats) {
  const { gpu, loadAvg, cpuTempC, gpuTempC, net } = stats;

  /* CPU °C dial */
  const cpuTempVal = document.getElementById("cpuTempVal");
  if (cpuTempC != null && cpuTempC > 0) {
    if (cpuTempVal) cpuTempVal.textContent = `${Math.round(cpuTempC)}°`;
    setArcGauge("cpuTempArc", Math.max(0, Math.min(100, ((cpuTempC - 30) / 70) * 100)));
  } else {
    if (cpuTempVal) cpuTempVal.textContent = "—°";
    setArcGauge("cpuTempArc", 0);
  }

  /* GPU °C dial — same scale. */
  const gpuTempVal = document.getElementById("gpuTempVal");
  if (gpuTempC != null && gpuTempC > 0) {
    if (gpuTempVal) gpuTempVal.textContent = `${Math.round(gpuTempC)}°`;
    setArcGauge("gpuTempArc", Math.max(0, Math.min(100, ((gpuTempC - 30) / 70) * 100)));
  } else {
    if (gpuTempVal) gpuTempVal.textContent = "—°";
    setArcGauge("gpuTempArc", 0);
  }

  /* VRAM dial — in-use against allocated. */
  const vramVal = document.getElementById("vramVal");
  if (gpu?.inUseGB != null) {
    if (vramVal) vramVal.textContent = `${gpu.inUseGB}G`;
    const allocGB = Math.max(0.1, gpu.allocGB || gpu.inUseGB || 1);
    setArcGauge("vramArc", Math.min(100, (gpu.inUseGB / allocGB) * 100));
  } else if (vramVal) {
    vramVal.textContent = "—";
  }

  /* NET ↓ / NET ↑ dials — 0..10 MB/s = 0..100% fill. Readout shows live
   * KB/s (or MB/s when ≥1024) so the operator sees actual numbers. */
  const fmtRate = (kbs) => kbs >= 1024 ? `${(kbs / 1024).toFixed(1)}M` : `${Math.round(kbs)}K`;
  const netDnVal = document.getElementById("netDnVal");
  const netUpVal = document.getElementById("netUpVal");
  const dn = net?.downKBs ?? 0, up = net?.upKBs ?? 0;
  if (netDnVal) netDnVal.textContent = fmtRate(dn);
  if (netUpVal) netUpVal.textContent = fmtRate(up);
  /* 10 MB/s = 10240 KB/s = 100%. Log-ish feel via Math.min(100, kbs/102.4). */
  setArcGauge("netDnArc", Math.min(100, dn / 102.4));
  setArcGauge("netUpArc", Math.min(100, up / 102.4));

  /* Stat row footer — text-only LOAD + DSK readouts (no dial). */
  if (loadAvg != null) {
    const loadEl = document.getElementById("loadVal");
    if (loadEl) loadEl.textContent = loadAvg.toFixed(2);
  }
}

/* CPU shape switched from a Number to { overall, perCore } so the reactor
 * can draw one rim arc per physical core. Old call sites that did
 * `s.cpu.toFixed()` continue to work via this normaliser. */
function _cpuOverall(cpu) {
  if (cpu == null) return 0;
  return typeof cpu === "number" ? cpu : (cpu.overall ?? 0);
}
function _cpuPerCore(cpu) {
  return cpu && typeof cpu === "object" && Array.isArray(cpu.perCore) ? cpu.perCore : [];
}

/* ─── Per-core reactor rim arcs ───
 *  N cores → N short arcs evenly distributed around a ring at r=292. Each
 *  arc spans (360/N − 4)° of the perimeter; its stroke-dasharray is set to
 *  the visible portion = full × (corePct/100) so the arc fills proportionally
 *  to that core's utilisation. P-cores are coloured cyan; E-cores (the last
 *  two on Apple Silicon, which have lower clock + smaller cache) get a
 *  contrasting tint so the operator can read load profile at a glance.
 *
 *  The arc paths themselves are SVG <path> elements with two segments —
 *  a faint full-arc track behind, and the bright fill on top. Built once
 *  on first call (we don't know core count until a stats payload lands),
 *  then updated in place. */
const RIM_R = 292;
const RIM_CY = 300;
let _coreArcsBuilt = false;
function _coreArcGeometry(i, n) {
  /* Each core gets a slice of (360/n)°. Leave 4° gap between slices. */
  const sliceDeg = 360 / n;
  const gapDeg = Math.min(4, sliceDeg * 0.18);
  const startDeg = (i * sliceDeg) - 90 + gapDeg / 2;
  const endDeg   = startDeg + sliceDeg - gapDeg;
  const toXY = (deg) => {
    const r = (deg * Math.PI) / 180;
    return [RIM_CY + RIM_R * Math.cos(r), RIM_CY + RIM_R * Math.sin(r)];
  };
  const [x0, y0] = toXY(startDeg);
  const [x1, y1] = toXY(endDeg);
  /* Each slice is < 180° so large-arc-flag = 0. sweep-flag = 1 for clockwise. */
  return { d: `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${RIM_R} ${RIM_R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`, sliceDeg };
}
/* ─── Instrument-cluster scaffolding ───
 *  One-shot builders for static SVG geometry that's the same regardless of
 *  data: calibration ticks (40 marks every 9°), voice waveform spokes
 *  (64 radial lines from centre). Both built once on first stats payload —
 *  per-tick code only mutates lengths/dasharrays. */

let _icScaffoldBuilt = false;
function _buildICScaffold() {
  if (_icScaffoldBuilt) return;

  /* Calibration ticks — 40 short hairlines around the outer rim at r=288→295. */
  const ticks = document.getElementById("icCalTicks");
  if (ticks) {
    for (let i = 0; i < 40; i++) {
      const deg = i * 9 - 90;
      const r1 = 288, r2 = 295;
      const rad = (deg * Math.PI) / 180;
      const x1 = 300 + r1 * Math.cos(rad);
      const y1 = 300 + r1 * Math.sin(rad);
      const x2 = 300 + r2 * Math.cos(rad);
      const y2 = 300 + r2 * Math.sin(rad);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1.toFixed(2));
      line.setAttribute("y1", y1.toFixed(2));
      line.setAttribute("x2", x2.toFixed(2));
      line.setAttribute("y2", y2.toFixed(2));
      ticks.appendChild(line);
    }
  }

  /* Voice waveform — 64 radial spokes from centre. Each spoke's length is
   * driven per-tick from mic RMS / TTS amplitude (or a soft sine on idle). */
  const wave = document.getElementById("icVoiceWave");
  if (wave) {
    for (let i = 0; i < 64; i++) {
      const deg = (i * 360) / 64 - 90;
      const rad = (deg * Math.PI) / 180;
      const innerR = 70;   // outside the bright pin
      const outerR = 100;  // baseline outer (gets longer when amplitude is high)
      const x1 = 300 + innerR * Math.cos(rad);
      const y1 = 300 + innerR * Math.sin(rad);
      const x2 = 300 + outerR * Math.cos(rad);
      const y2 = 300 + outerR * Math.sin(rad);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1.toFixed(2));
      line.setAttribute("y1", y1.toFixed(2));
      line.dataset.angle = String(deg);
      line.dataset.cosA = Math.cos(rad).toFixed(4);
      line.dataset.sinA = Math.sin(rad).toFixed(4);
      line.setAttribute("x2", x2.toFixed(2));
      line.setAttribute("y2", y2.toFixed(2));
      wave.appendChild(line);
    }
  }
  _icScaffoldBuilt = true;
}

/* Per-tick voice waveform update. Drives spoke lengths from a 0..1 amplitude
 * signal. On idle, produce a soft drift via Math.sin so the wave never looks
 * dead. Window.__speedo (existing helper) exposes mic RMS via setMicLevel. */
function _updateVoiceWave(amp) {
  const wave = document.getElementById("icVoiceWave");
  if (!wave) return;
  const lines = wave.children;
  const t = Date.now() / 240;
  const baseR = 70;
  const peakR = 165;  // max outer reach when amp = 1
  for (let i = 0; i < lines.length; i++) {
    /* Per-spoke phase offset so the wave doesn't pulse uniformly. */
    const wobble = 0.4 + 0.6 * Math.abs(Math.sin(t + i * 0.31));
    const len = baseR + (peakR - baseR) * amp * wobble;
    const cosA = parseFloat(lines[i].dataset.cosA);
    const sinA = parseFloat(lines[i].dataset.sinA);
    lines[i].setAttribute("x2", (300 + len * cosA).toFixed(2));
    lines[i].setAttribute("y2", (300 + len * sinA).toFixed(2));
  }
}

/* Continuous voice-wave RAF loop. Reads amplitude from the speedo controller
 * (which already integrates mic RMS) plus a baseline drift on idle. Throttled
 * to ~30fps because at 60fps with 64 line elements the M-series GPU was
 * pegging at ~45% just for centerpiece animation — visually 30fps is
 * indistinguishable for this pulse rate but halves GPU cost. */
let _voiceWaveRaf = 0;
let _voiceWaveLastT = 0;
const VOICE_WAVE_FRAME_MS = 33;  // ~30fps target
function _startVoiceWave() {
  cancelAnimationFrame(_voiceWaveRaf);
  const tick = (now) => {
    if (now - _voiceWaveLastT >= VOICE_WAVE_FRAME_MS) {
      _voiceWaveLastT = now;
      let amp = 0.1 + 0.05 * Math.sin(now / 800);
      const speedo = window.__speedo;
      if (speedo && typeof speedo.getLevel === "function") {
        const level = speedo.getLevel();
        if (level > amp) amp = level;
      }
      _updateVoiceWave(amp);
    }
    _voiceWaveRaf = requestAnimationFrame(tick);
  };
  _voiceWaveRaf = requestAnimationFrame(tick);
}
/* Pause the voice-wave loop when the tab is hidden — Chrome already throttles
 * RAF on hidden tabs but explicit cancel ensures GPU goes idle on the kiosk. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancelAnimationFrame(_voiceWaveRaf);
  else _startVoiceWave();
});

/* Rim chip update — accepts a metric key + value + threshold. When value
 * crosses threshold, the chip snaps to is-hot (no fade — operational alarm
 * vocabulary). */
function _updateRimChip(id, value, hotAt) {
  const v = document.getElementById(id);
  if (!v) return;
  v.textContent = value;
  const chip = v.closest(".ic-chip");
  if (chip && typeof hotAt === "number") {
    const numeric = parseFloat(String(value).replace(/[^\d.-]/g, ""));
    chip.classList.toggle("is-hot", !Number.isNaN(numeric) && numeric >= hotAt);
  }
}

function _renderCoreArcs(perCore) {
  if (!perCore.length) return;
  const host = document.getElementById("rxCoreArcs");
  if (!host) return;
  const n = perCore.length;
  /* Apple Silicon has P-cores first, E-cores last. Heuristic: M1/M2/M3
   * Pro/Max have 2 E-cores, base M1 has 4. Mark the last 2-4 as E-cores
   * via a class so styling can differentiate. */
  const eCoreCount = n >= 8 ? 2 : (n >= 6 ? 2 : 4);
  if (!_coreArcsBuilt || host.children.length !== n * 2) {
    host.replaceChildren();
    for (let i = 0; i < n; i++) {
      const isE = i >= n - eCoreCount;
      const { d } = _coreArcGeometry(i, n);
      const track = document.createElementNS("http://www.w3.org/2000/svg", "path");
      track.setAttribute("d", d);
      track.setAttribute("class", `rx-core-arc rx-core-arc--track ${isE ? "is-ecore" : "is-pcore"}`);
      const fill = document.createElementNS("http://www.w3.org/2000/svg", "path");
      fill.setAttribute("d", d);
      fill.setAttribute("class", `rx-core-arc rx-core-arc--fill ${isE ? "is-ecore" : "is-pcore"}`);
      fill.dataset.coreIndex = String(i);
      /* Why: getTotalLength forces a sync layout. Compute once at build,
       * stash on the element, then per-tick paths only do attribute writes. */
      fill._jrLen = fill.getTotalLength();
      host.appendChild(track);
      host.appendChild(fill);
    }
    _coreArcsBuilt = true;
  }
  /* Per-tick: write-only. No layout reads. */
  const fills = host.querySelectorAll(".rx-core-arc--fill");
  fills.forEach((el, i) => {
    const pct = Math.max(0, Math.min(100, perCore[i] || 0));
    const len = el._jrLen;
    const visible = (len * pct) / 100;
    el.style.strokeDasharray = `${visible} ${len}`;
  });
}

function applyLiveStats(s) {
  lastStatsTs = Date.now();
  /* Build instrument-cluster scaffolding on first stats payload. */
  _buildICScaffold();
  const cpuOverall = _cpuOverall(s.cpu);
  setCpuGauge(cpuOverall);

  /* Per-core arcs around the reactor rim — drawn once on first sample
   * (so we know how many cores), then updated in place each tick. */
  _renderCoreArcs(_cpuPerCore(s.cpu));

  /* Rim chips — CPU% on NW, GPU% on NE, NET on SW. AUDIO updates from voice state. */
  _updateRimChip("icChipCore", `${Math.round(cpuOverall)}%`, 80);
  if (s.gpu && s.gpu.usagePct != null) {
    _updateRimChip("icChipSys", `${s.gpu.usagePct}%`, 80);
  }
  if (s.net) {
    const down = s.net.downKBs || 0;
    const label = down >= 1024 ? `${(down / 1024).toFixed(1)} MB/s` : `${down.toFixed(1)} KB/s`;
    _updateRimChip("icChipNet", label);
  }

  /* Push & redraw sparklines — one canvas per metric. */
  _pushSpark("cpu", cpuOverall);
  _drawSpark("cpu");
  const cpuSparkV = document.getElementById("cpuSparkV");
  if (cpuSparkV) cpuSparkV.textContent = `${Math.round(cpuOverall)}%`;

  /* GPU panel — usage % drives the arc + sparkline; thermal pressure drives the chip. */
  if (s.gpu) {
    const pct = s.gpu.usagePct;
    setArcGauge("gpuArc", pct);
    if ($("gpuValue")) $("gpuValue").textContent = pct == null ? "—%" : `${pct}%`;
    if (pct != null) {
      _pushSpark("gpu", pct);
      _drawSpark("gpu");
      const v = document.getElementById("gpuSparkV");
      if (v) v.textContent = `${pct}%`;
    }
    if ($("gpuMemValue") && s.gpu.allocGB != null) {
      $("gpuMemValue").textContent = `${s.gpu.allocGB} GB`;
    }
  }
  /* Paired-dial row: CPU °C, GPU °C, VRAM, NET ↓, NET ↑. Stat row uses
   * loadAvg + disk for text-only readouts. */
  _updateThermalUI({
    gpu: s.gpu,
    loadAvg: s.loadAvg ?? (cpuOverall / 25),
    cpuTempC: s.cpuTempC,
    gpuTempC: s.gpuTempC,
    net: s.net,
  });

  if (s.mem) {
    const ramPct = (s.mem.usedGB / Math.max(1, s.mem.totalGB)) * 100;
    setArcGauge("ramArc", ramPct);
    _pushSpark("ram", ramPct);
    _drawSpark("ram");
    const ramSparkV = document.getElementById("ramSparkV");
    if (ramSparkV) ramSparkV.textContent = `${Math.round(ramPct)}%`;
    /* Why: the round dial only has room for ~4 chars at 14px. Show used GB rounded
     * (the arc fill already encodes the percentage visually) — "57G" beats "56.9 / 69 GB"
     * for at-a-glance readability in the small pod. */
    $("ramValue").textContent = `${Math.round(ramPct)}%`;
  }
  if (s.net) {
    const down = s.net.downKBs;
    const up = s.net.upKBs;
    $("downValue") && ($("downValue").textContent = down >= 1024 ? `${(down / 1024).toFixed(1)} MB/s` : `${down.toFixed(1)} KB/s`);
    $("upValue")   && ($("upValue").textContent   = up   >= 1024 ? `${(up   / 1024).toFixed(1)} MB/s` : `${Math.round(up)} KB/s`);
    if ($("netValue") && $("downValue")) $("netValue").textContent = $("downValue").textContent;
  }
  if (s.disk && s.disk.totalTB && $("dskValue")) {
    $("dskValue").textContent = `${s.disk.usedTB.toFixed(2)} / ${s.disk.totalTB.toFixed(2)} TB`;
  }
  if ($("latValue")) $("latValue").textContent = "—";  // not measured by bridge yet
}

/* Sprint 12 — connectBridge() previously opened hud.js's OWN WebSocket
 * (separate from bridge-client.js's WS). Two WSes per tab × N tabs was
 * overwhelming Chrome's localhost networking stack, manifesting as
 * connect/disconnect cycling visible in /tmp/jarvis-bridge.log.
 *
 * Now: subscribe to bridge-client's pubsub for the same event types we
 * used to handle directly. One WS per tab, same behaviour. The function
 * keeps its old name + signature so the boot sequence (which calls
 * connectBridge() once) still works without touching the call site. */
function connectBridge() {
  /* Ensure the shared WS is connecting — bridge-client.connect() is idempotent. */
  Bridge.connect();

  /* Fire the initial weather fetch once the WS is online. Why bridge.online
   * not on import: the page may have loaded before the WS finished its
   * upgrade, in which case Bridge.ask would queue indefinitely. Listening
   * for online means we send weather-init exactly once per connection. */
  let weatherInitSent = false;
  Bridge.on("bridge.online", () => {
    if (weatherInitSent) return;
    weatherInitSent = true;
    initWeather().catch((err) => console.warn(`[Jarvis HUD] weather-init failed: ${err.message}`));
  });
  /* If the WS drops, allow the next reconnect to fire weather-init again. */
  Bridge.on("bridge.offline", () => { weatherInitSent = false; });

  /* Live stats stream. Bridge.on's wildcard "*" would also work, but
   * subscribing per-type is clearer and bridge-client filters efficiently. */
  Bridge.on("stats", (m) => applyLiveStats(m.data));

  /* Brand changed — soft reload so CSS vars + wordmarks re-bootstrap. */
  Bridge.on("brand.updated", (m) => {
    console.log("[Jarvis HUD] brand updated — reloading to apply", { payload: m.data, ts: m.ts });
    console.trace("[Jarvis HUD] reload-trace");
    setTimeout(() => window.location.reload(), 250);
  });

  /* Server can also push weather updates spontaneously (e.g. on settings
   * change to operator location). Apply unconditionally. */
  Bridge.on("weather.reply", (m) => applyWeather(m.data));

  /* Typed-confirm modal for £25-30 purchases — mount on first event so DOM
   * cost is zero until a typed-tier purchase happens. */
  Bridge.on("purchase.typed_confirm.required", (m) => openPurchaseTypedConfirm(m.data));
  Bridge.on("purchase.recorded", (m) => flashPurchaseAuditBadge(m.data));

  /* Tool-router transparency ring buffer for the Agent Console. */
  Bridge.on("tool.picked", (m) => rememberToolPick(m.data));

  /* Crew orchestrator lane events. */
  Bridge.on("crew.started",        (m) => crewLanesOnStart(m.data));
  Bridge.on("crew.agent.started",  (m) => crewLanesOnAgentStart(m.data));
  Bridge.on("crew.agent.tool",     (m) => crewLanesOnAgentTool(m.data));
  Bridge.on("crew.agent.complete", (m) => crewLanesOnAgentComplete(m.data));
  Bridge.on("crew.agent.failed",   (m) => crewLanesOnAgentFailed(m.data));
  Bridge.on("crew.complete",       (m) => crewLanesOnComplete(m.data));

  console.log("[HUD-WS] subscribed via bridge-client pubsub (single shared WS)");
}

/** Fallback gauge drift: only runs when the bridge has gone quiet so we
 *  don't burn 40 wake-ups/minute when bridge stats are arriving fine.
 *
 *  Why a self-rescheduling timeout instead of setInterval: when the bridge
 *  is alive (lastStatsTs fresh), we sleep on a 4s heartbeat — just enough
 *  to notice if stats stop. When stats stall, we drop to the 1.5s drift
 *  cadence so the gauge keeps moving and the HUD doesn't look frozen.
 *  This pattern was flagged by the code-review audit: the original
 *  setInterval ran every 1.5s forever even with a healthy bridge. */
let _statsFallbackTimer = null;
function startStatsFallback() {
  let cpu = 28;
  const tick = () => {
    const stale = Date.now() - lastStatsTs >= 4000;
    if (stale) {
      cpu += (Math.random() - 0.5) * 6;
      cpu = Math.max(8, Math.min(82, cpu));
      setCpuGauge(cpu);
      _statsFallbackTimer = setTimeout(tick, 1500);
    } else {
      /* Bridge alive — light heartbeat, no drift work. */
      _statsFallbackTimer = setTimeout(tick, 4000);
    }
  };
  tick();
}

/** Refresh the bridge's IP-based location, then fetch weather for it.
 *
 *  Why IP geo, not browser geolocation: browser geo via navigator.geolocation
 *  uses Apple's BSSID-lookup service on Macs without GPS. The BSSID database
 *  is stale when the user travels (their home router's MAC is registered to
 *  their home city, so the laptop reports "home" even on a hotel Wi-Fi 1000km
 *  away). IP geo correctly reflects the network the machine is currently on
 *  (modulo VPNs, which are a deliberate user choice). For a travel-aware
 *  weather widget IP wins; the previous browser-geo path produced the wrong
 *  city for the operator on holiday with a poisoned BSSID cache.
 *
 *  /config/redetect runs autoDetectLocation(force:true), updates CONFIG.operator,
 *  and persists to config.json. After this returns, a plain weather fetch
 *  picks up the fresh coords + name. */
async function initWeather() {
  try {
    await fetch("http://localhost:8766/config/redetect", { method: "POST" });
  } catch { /* bridge unreachable — fall through to whatever CONFIG.operator already has */ }
  const data = await Bridge.ask({ type: "weather", payload: {} }, 5000);
  applyWeather(data);
}

/** Apply real weather from bridge. WMO weather codes drive both the short label
 *  AND the matching Bybas weather icon. Forecast rows now carry a per-day icon. */
function applyWeather(w) {
  if (!w || w.error) return;
  const day = isDaytimeNow();
  /* Why: the HUD widget ships with a hardcoded "MANCHESTER, UK" default in
   * index.html. Replace it the moment we have a real bridge response so the
   * label reflects the actual configured operator location (which is also
   * what drove the weather fetch). */
  if (w.location) {
    const locEl = $("weatherLoc");
    if (locEl) {
      const { name, country } = w.location;
      locEl.textContent = name ? (country ? `${name}, ${country}` : name) : "";
    }
  }
  if (w.now) {
    $("weatherTemp").textContent = `${w.now.temp}°`;
    $("weatherCond").textContent = wmoCondition(w.now.code);
    const iconEl = $("weatherIcon");
    if (iconEl) {
      const iconName = wmoIcon(w.now.code, day);
      const path = `assets/weather-icons/${iconName}.svg`;
      /* Re-bind the error handler every time we swap src — Adam reported the
       * today icon rendering as an empty box. The onerror in HTML only fires
       * once per element by default; resetting onerror=null inside the handler
       * means the fallback also has its own retry. We log the failed name so
       * any future wmoIcon mapping that points at a missing file is obvious
       * in the console rather than silently broken. */
      iconEl.onerror = () => {
        console.warn(`[Jarvis] weather icon failed: ${iconName}.svg — falling back to cloudy.svg`);
        iconEl.onerror = null;
        iconEl.src = "assets/weather-icons/cloudy.svg";
      };
      iconEl.src = path;
    }
  }
  if (w.forecast) {
    const host = $("weatherForecast");
    host.replaceChildren();
    const dayShort = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    for (let i = 0; i < Math.min(5, w.forecast.length); i++) {
      const f = w.forecast[i];
      const d = new Date(f.date);
      const li = document.createElement("li");
      /* Why: forecasts are full days — always pick the day variant of partly-cloudy/clear. */
      const icon = document.createElement("img");
      icon.className = "icon";
      icon.alt = ""; icon.setAttribute("aria-hidden", "true");
      icon.src = `assets/weather-icons/${wmoIcon(f.code ?? 1, true)}.svg`;
      const a = document.createElement("span"); a.className = "day"; a.textContent = i === 0 ? "TOMORROW" : dayShort[d.getDay()];
      const b = document.createElement("span"); b.className = "hi";  b.textContent = `${f.hi}°`;
      const c = document.createElement("span"); c.className = "lo";  c.textContent = `${f.lo}°`;
      li.append(icon, a, b, c);
      host.appendChild(li);
    }
  }
}

/** Map WMO weather code → short HUD label. */
function wmoCondition(code) {
  if (code === 0) return "CLEAR";
  if (code <= 3) return "PARTLY CLOUDED";
  if (code <= 48) return "FOG";
  if (code <= 67) return "RAIN";
  if (code <= 77) return "SNOW";
  if (code <= 82) return "SHOWERS";
  if (code <= 99) return "THUNDER";
  return "—";
}

/* Why: WMO numeric code → Bybas weather-icons filename. Day/night variants picked
 * via a sun-position estimate from the bridge's lat/lon, falling back to local time.
 * Bybas ships precise mappings for these conditions; we keep a short table. */
function wmoIcon(code, isDay = true) {
  const day = isDay ? "day" : "night";
  if (code === 0) return `clear-${day}`;
  if (code <= 2) return `partly-cloudy-${day}`;     // 1-2 = mainly clear / partly cloudy
  if (code === 3) return "overcast";
  if (code <= 48) return "fog";
  if (code <= 57) return "drizzle";
  if (code <= 65) return "rain";
  if (code <= 67) return "sleet";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain";                    // showers
  if (code <= 86) return "snow";                    // snow showers
  if (code >= 95) return "thunderstorms";
  return `partly-cloudy-${day}`;
}

/* Crude is-day check: 06:00–20:00 local. The bridge could pass real sunrise/sunset
 * later; this is good enough for icon variant selection. */
function isDaytimeNow() {
  const h = new Date().getHours();
  return h >= 6 && h < 20;
}

/* ---------- WEBCAM INLAY + FACE TRACKING ----------
 * Camera in the top-right with red tint, scan-lines, corner brackets.
 * The targeting reticle follows the user's face via MediaPipe Face Detector (CDN, ~5MB).
 * If MediaPipe fails to load, falls back to a slow orbital animation (existing CSS). */
/* Why: exposed on window so voice.js's settings modal can re-init the camera when
 * the operator switches modes from "off" to a visible state mid-session. */
window.wireCamera = wireCamera;
async function wireCamera() {
  const v = document.getElementById("camVideo");
  const cam = document.getElementById("cam");
  const reticle = document.querySelector(".cam__targeting");
  if (!v || !cam) return;
  /* Why: camera-on-demand. If the operator's mode is "off" (default), don't initialise
   * getUserMedia at all — saves the camera light from coming on, addresses privacy.
   * Modes "on-listen" and "always" both require the stream to exist before reveal,
   * so we initialise here for both. */
  /* Why: read camera mode through the namespaced Storage helper rather than a
   * hardcoded localStorage key — single source of truth for the prefix scheme,
   * and profile switching in P2.1 just works without touching hud.js. */
  const mode = Storage.get("cameraMode", "off");
  if (mode === "off") {
    console.log("[Jarvis HUD] camera mode 'off' — skipping getUserMedia");
    return;
  }
  // Webcam resolution scales with performance tier (lite saves a lot of GPU on copies)
  const tier = (typeof window.getTierPreset === "function") ? window.getTierPreset() : { camRes: 480, faceFps: 12 };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: tier.camRes }, height: { ideal: tier.camRes }, facingMode: "user" },
      audio: false,
    });
    v.srcObject = stream;
  } catch (e) {
    console.warn("[Jarvis HUD] camera unavailable:", e.message);
    cam.style.display = "none";
    return;
  }
  // Lite tier: skip MediaPipe entirely (CSS rotation animation handles the reticle)
  if (tier.faceFps === 0) {
    console.log("[Jarvis HUD] face tracking disabled by tier");
    return;
  }

  // Wait for video to actually have dimensions before we start detection
  await new Promise((r) => v.readyState >= 2 ? r() : v.addEventListener("loadeddata", r, { once: true }));

  /* Why: load MediaPipe Tasks Vision dynamically from CDN to avoid bundling ~5MB of WASM upfront.
   * If anything fails (offline, network blocked, model load error), we silently keep the CSS animation. */
  try {
    const { FaceDetector, FilesetResolver } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/vision_bundle.mjs");
    const fileset = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm");
    const detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.5,
    });
    console.log("[Jarvis HUD] face detector ready");
    if (reticle) {
      // Take over the reticle: kill the CSS rotation, drive position from face bbox
      reticle.style.animation = "none";
      reticle.style.transition = "transform 0.18s ease-out";
    }

    // Smoothing — face bboxes jitter, this gives the reticle a heavy, sci-fi tracking feel
    let smoothX = 0.5, smoothY = 0.5, smoothSize = 1;

    /* Why: throttle face detection to the tier's faceFps. Faces don't move fast — even 8fps with smoothing
     * looks fluid. This was the biggest GPU drain on the M1 Max test machine. */
    const FACE_FPS = tier.faceFps;
    let lastDetectAt = 0;
    const tick = (ts) => {
      if (v.readyState >= 2 && v.videoWidth > 0 && ts - lastDetectAt > 1000 / FACE_FPS) {
        lastDetectAt = ts;
        try {
          const result = detector.detectForVideo(v, ts);
          if (result && result.detections && result.detections.length > 0) {
            const box = result.detections[0].boundingBox;
            const cx = (box.originX + box.width / 2) / v.videoWidth;
            const cy = (box.originY + box.height / 2) / v.videoHeight;
            const sz = Math.max(box.width / v.videoWidth, box.height / v.videoHeight);
            smoothX = smoothX * 0.7 + cx * 0.3;
            smoothY = smoothY * 0.7 + cy * 0.3;
            smoothSize = smoothSize * 0.85 + (0.5 + sz * 1.4) * 0.15;
            const camRect = cam.getBoundingClientRect();
            const x = (1 - smoothX) * camRect.width;
            const y = smoothY * camRect.height;
            if (reticle) {
              reticle.style.left = "0";
              reticle.style.top = "0";
              reticle.style.transform = `translate(${x - 30}px, ${y - 30}px) scale(${smoothSize.toFixed(2)})`;
            }
          }
        } catch (e) { /* swallow per-frame errors */ }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (e) {
    console.warn("[Jarvis HUD] face detector unavailable, using CSS reticle:", e.message);
  }
}

/* ---------- LAUNCHER ----------
 *  Pulls entries from /launcher (bridge → config/launcher.json) at boot. Falls back
 *  to a minimal hardcoded set if the bridge is unreachable so the kiosk doesn't end
 *  up with an empty panel during cold-boot. */
async function wireLauncher() {
  const list = document.getElementById("launchList");
  if (!list) return;

  let items = [];
  try {
    const r = await fetch("http://localhost:8766/launcher", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.items)) items = j.items;
    }
  } catch (e) {
    console.warn("[Jarvis HUD] launcher fetch failed, using fallback:", e.message);
  }
  /* Bare-minimum fallback so the panel renders even with no bridge. */
  if (!items.length) {
    items = [
      { label: "MAIL",         app: "mail" },
      { label: "PREMIERE PRO", app: "premiere" },
      { label: "SHOOTS",       app: "shoots" },
    ];
  }

  while (list.firstChild) list.removeChild(list.firstChild);
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item.label || item.app || "—";
    li.dataset.app = item.app || "";
    li.style.cursor = "pointer";
    li.addEventListener("click", async () => {
      const app = li.dataset.app;
      if (!app) return;
      console.log(`[Jarvis HUD] launch request: ${app}`);
      try {
        const r = await fetch("http://localhost:8766/launch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ app }),
        });
        const j = await r.json();
        if (!j.ok) console.warn("[Jarvis HUD] launch failed:", j.error);
      } catch (e) { console.warn("[Jarvis HUD] launch fetch failed:", e.message); }
    });
    list.appendChild(li);
  }
}

/* ---------- COMMS PANEL DYNAMIC POLL ----------
 * Why: the panel was stale hardcoded copy. Now polls /comms every 30s for live counts:
 * unread mail, pending Frame.io reviews, uncontacted leads, latest shoot. Renders into
 * the existing #commsList <ul>. Falls back to last-known on transient bridge hiccup. */
async function pollComms() {
  try {
    const r = await fetch("http://localhost:8766/comms", { cache: "no-store" });
    if (!r.ok) return;
    const { comms } = await r.json();
    const list = $("commsList");
    if (!list || !Array.isArray(comms)) return;
    list.replaceChildren();
    if (comms.length === 0) {
      const li = document.createElement("li");
      li.textContent = "all clear";
      list.appendChild(li);
      return;
    }
    for (const item of comms) {
      const li = document.createElement("li");
      li.textContent = `${item.k} // ${item.v}`;
      /* Why: items with a url become clickable to open the underlying file/folder.
       * Folders go through the bridge's /launch endpoint (uses Finder via `open`),
       * files served from /output land in a new Chrome window so the operator can
       * preview without leaving the kiosk view too disruptively. */
      if (item.url) {
        li.classList.add("comms__clickable");
        li.dataset.kind = item.kind || "";
        li.addEventListener("click", () => {
          if (item.kind === "folder" && item.folderRel) {
            fetch("http://localhost:8766/launch", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ app: item.folderRel.startsWith("shoots/") ? "shoots" : "output" }),
            }).catch(() => {});
            return;
          }
          window.open(`http://localhost:8766${item.url}`, "_blank");
        });
      }
      list.appendChild(li);
    }
  } catch {
    /* Silent — bridge may be restarting; next tick will retry. */
  }
}
function startCommsPoll() { pollComms(); setInterval(pollComms, 30_000); }

/* ---------- SERVICE HEALTH POLL ----------
 *  Pings /healthz every 15s and lights the four pips. If the bridge itself is
 *  unreachable, marks the bridge pip as down and dims the others — no point
 *  announcing TTS as up when we can't even talk to the bridge to find out. */
async function pollHealth() {
  const bar = document.getElementById("healthBar");
  if (!bar) return;
  const pips = bar.querySelectorAll(".health__pip");
  /* Reset any prior state cleanly. */
  pips.forEach(p => { p.classList.remove("is-up", "is-down", "is-unknown"); });

  let services;
  let whisperBackend = null;
  let whisperModel = null;
  try {
    const r = await fetch("http://localhost:8766/healthz", { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    services = j.services || {};
    whisperBackend = j.whisperBackend || null;
    whisperModel = j.whisperModel || null;
  } catch {
    /* Bridge itself is down. Mark bridge red, the rest unknown. */
    services = { bridge: false, ollama: undefined, kokoro: undefined, whisper: undefined };
  }
  pips.forEach(pip => {
    const svc = pip.dataset.svc;
    const v = services[svc];
    if (v === true) pip.classList.add("is-up");
    else if (v === false) pip.classList.add("is-down");
    else pip.classList.add("is-unknown");
    /* Why: surface the active STT backend in the pip tooltip so operator can
     * tell at a glance whether they're on MLX (Apple GPU, ~6× faster) or the
     * faster-whisper CPU fallback. Other pips keep their static title. */
    if (svc === "whisper" && whisperBackend) {
      const label = whisperBackend === "mlx" ? "MLX (Apple GPU)" : "faster-whisper (CPU int8)";
      pip.title = `Whisper STT · ${label}${whisperModel ? ` · ${whisperModel}` : ""}`;
    }
  });
}
function startHealthPoll() { pollHealth(); setInterval(pollHealth, 15_000); }

/* ---------- DIARY (today's calendar) ----------
 * Why: clock panel was split in two — bottom half shows today's events from the macOS
 * Calendar via the bridge's /diary endpoint. Imminent items (<30 min) get a glow accent;
 * past items are dimmed so the operator's eye lands on what's next. Polls every 60s. */
async function pollDiary() {
  const list = $("diaryList");
  const counter = $("diaryCount");
  if (!list) return;
  /* Always replace the placeholder — even on errors. The previous "silent return"
   * pattern left "checking calendar…" up forever when the bridge was unreachable
   * or AppleScript permissions were denied. */
  const renderEmpty = (msg) => {
    list.replaceChildren();
    const li = document.createElement("li");
    li.className = "diary__empty";
    li.textContent = msg;
    list.appendChild(li);
  };

  /* Why 20s timeout: first-run pollDiary on a fresh bridge can be slow because
   * ensureCalendarRunning launches Calendar.app (up to 5s) and the AppleScript query
   * itself takes 1-3s. 8s wasn't enough on the first call → operator saw "calendar
   * timeout" flash before the second (successful) poll painted real events. */
  try {
    const r = await fetch("http://localhost:8766/diary", { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!r.ok) {
      renderEmpty(`bridge error ${r.status}`);
      if (counter) counter.textContent = "—";
      return;
    }
    const { ok, events, count, error } = await r.json();
    if (!ok) {
      /* Common failure: macOS Calendar permission not granted to the bridge. Surface
       * the error inline so the operator knows to grant access in System Settings →
       * Privacy & Security → Automation rather than thinking it's still loading. */
      /* Why 160 chars: the diary panel is ~280px wide × ~28px tall in CSS; the
       * humanised error from calendar.mjs caps at 200, fits comfortably within
       * the panel after the "calendar:" prefix without overflowing visually. */
      renderEmpty(error ? `calendar: ${String(error).slice(0, 160)}` : "calendar unavailable");
      if (counter) counter.textContent = "—";
      return;
    }
    /* Reset the consecutive-fail counter on every successful response so the
     * next genuine outage starts fresh and doesn't immediately render an error. */
    pollDiary._consecFails = 0;
    if (counter) counter.textContent = `${count || 0} EVENT${(count || 0) === 1 ? "" : "S"}`;
    if (!events || events.length === 0) {
      renderEmpty("nothing today");
      return;
    }
    list.replaceChildren();
    for (const ev of events) {
      const li = document.createElement("li");
      if (ev.isImminent) li.classList.add("is-imminent");
      if (ev.isPast)     li.classList.add("is-past");
      const t = document.createElement("span"); t.className = "diary__time"; t.textContent = ev.time;
      const tl = document.createElement("span"); tl.className = "diary__title-line"; tl.textContent = ev.title;
      li.append(t, tl);
      list.appendChild(li);
    }
  } catch (e) {
    /* Don't flash an error on the first failure — keep the prior content (placeholder
     * "checking calendar…" or stale events from a prior tick) visible. Only show the
     * error after 2 consecutive failures so a slow first poll while Calendar.app warms
     * up doesn't blink "timeout" before the next tick succeeds. */
    pollDiary._consecFails = (pollDiary._consecFails || 0) + 1;
    if (pollDiary._consecFails < 2) return;
    /* Network / timeout — bridge is down or the AppleScript is hanging. Show the state. */
    const msg = e.name === "TimeoutError" ? "calendar timeout — Calendar.app unresponsive?" : "bridge offline";
    renderEmpty(msg);
    if (counter) counter.textContent = "—";
  }
}
/* Poll cadence: 15 s catches manual macOS Calendar additions promptly without
 * hammering the AppleScript bridge. Voice-add via add_calendar_event also fires
 * a diary.refresh WS event for instant feedback (see bindDiaryRefreshHook). */
function startDiaryPoll() { pollDiary(); setInterval(pollDiary, 15_000); }

/* Why: when the bridge writes a new event via the LLM tool path, it broadcasts
 * { type: "diary.refresh" } so the HUD updates immediately.
 * Sprint 12 — was hooking into bridgeWS directly; now subscribes via the
 * shared bridge-client pubsub. No more own-WS to bind to. */
function bindDiaryRefreshHook() {
  Bridge.on("diary.refresh", () => pollDiary());
}

/* ---------- FULLSCREEN: Cmd/Ctrl+F to toggle, double-click speedo also toggles ----------
 * Why: requestFullscreen must come from a user gesture, so we hook keypress + dblclick.
 * Why Cmd/Ctrl+F (not bare F): the text-input modal lets the operator type to Jarvis
 * mid-session — a bare F shortcut ate the letter every time they tried to type a word
 * starting with f. Modifier-gated keeps the shortcut available without blocking typing. */
function wireFullscreen() {
  const toggle = async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (e) { console.warn("[Jarvis HUD] fullscreen blocked:", e.message); }
  };
  document.addEventListener("keydown", (e) => {
    /* Cmd+F on macOS, Ctrl+F elsewhere. Shift/Alt allowed (some keyboards
     * fire e.shiftKey on Cmd+F by accident). preventDefault stops the
     * browser's find-in-page from also opening. */
    if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      toggle();
    }
  });
  document.getElementById("speedo")?.addEventListener("dblclick", toggle);
}

/* ---------- TYPED-CONFIRM PURCHASE MODAL (Patch B) ----------
 * Pops when the bridge broadcasts purchase.typed_confirm.required for a
 * typed-tier (£25-30) purchase. Operator must type the EXACT pence amount —
 * a voice "yes" is too easy to fake or accidentally trigger. Modal is built
 * on demand (no DOM until needed) and torn down on close. */

let _purchaseModalEl = null;

/** One-liner DOM helper: create an element, set className/text, append children. */
function el(tag, opts = {}, ...children) {
  const e = document.createElement(tag);
  if (opts.className) e.className = opts.className;
  if (opts.id) e.id = opts.id;
  if (opts.text != null) e.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
  for (const c of children) if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}

/** Build the modal once and reuse it across calls. Built via DOM methods so no
 *  innerHTML usage — every attribute and string is set explicitly. */
function ensurePurchaseModal() {
  if (_purchaseModalEl) return _purchaseModalEl;
  const root = el("div", { id: "purchaseConfirmModal" });
  root.hidden = true;
  /* All styles are static — no interpolation, safe to inline as a single style block. */
  const style = document.createElement("style");
  style.textContent = `
    #purchaseConfirmModal { position: fixed; inset: 0; background: rgba(0,0,0,0.78); z-index: 10000; display: flex; align-items: center; justify-content: center; font-family: var(--mono, "JetBrains Mono", monospace); }
    #purchaseConfirmModal .pcm-frame { background: #0b0b0b; border: 2px solid var(--accent); padding: 32px 36px; min-width: 460px; max-width: 600px; box-shadow: 0 0 60px rgba(0,212,255,0.35); }
    #purchaseConfirmModal h2 { color: var(--accent); margin: 0 0 16px; font-size: 14px; letter-spacing: 0.16em; text-transform: uppercase; }
    #purchaseConfirmModal .pcm-row { color: #eaeaea; margin: 6px 0; font-size: 13px; }
    #purchaseConfirmModal .pcm-row strong { color: #fff; font-weight: 600; }
    #purchaseConfirmModal .pcm-amount { font-size: 28px; color: var(--accent); margin: 18px 0 6px; letter-spacing: 0.04em; }
    #purchaseConfirmModal .pcm-hint { color: #888; font-size: 11px; margin-bottom: 12px; }
    #purchaseConfirmModal input { background: #000; color: #fff; border: 1px solid #333; padding: 10px 12px; width: 100%; font-family: inherit; font-size: 18px; box-sizing: border-box; }
    #purchaseConfirmModal input:focus { outline: none; border-color: var(--accent); }
    #purchaseConfirmModal .pcm-error { color: var(--accent); font-size: 12px; min-height: 16px; margin: 8px 0; }
    #purchaseConfirmModal .pcm-buttons { display: flex; gap: 12px; margin-top: 16px; }
    #purchaseConfirmModal button { flex: 1; padding: 12px; background: #181818; color: #fff; border: 1px solid #333; cursor: pointer; font-family: inherit; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; }
    #purchaseConfirmModal button.primary { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 700; }
    #purchaseConfirmModal button:hover { filter: brightness(1.15); }
    #purchaseConfirmModal button:disabled { opacity: 0.4; cursor: not-allowed; }
  `;
  root.appendChild(style);

  const merchantStrong = el("strong", { className: "pcm-merchant", text: "—" });
  const itemRow = el("div", { className: "pcm-row pcm-item", text: "—" });
  const amtSpan = el("span", { className: "pcm-amt-display", text: "—" });
  const input = el("input", { attrs: { type: "text", inputmode: "decimal", placeholder: "0.00", autocomplete: "off" } });
  const errorEl = el("div", { className: "pcm-error" });
  const cancelBtn = el("button", { className: "cancel", text: "Cancel" });
  const authBtn = el("button", { className: "primary", text: "Authorise" });
  authBtn.disabled = true;

  const frame = el("div", { className: "pcm-frame" },
    el("h2", { text: "Authorise purchase" }),
    el("div", { className: "pcm-row" }, merchantStrong),
    itemRow,
    el("div", { className: "pcm-amount" }, document.createTextNode("£"), amtSpan),
    el("div", { className: "pcm-hint", text: "Type the EXACT amount above to authorise. Voice cannot approve this tier." }),
    input,
    errorEl,
    el("div", { className: "pcm-buttons" }, cancelBtn, authBtn),
  );
  root.appendChild(frame);
  /* Stash refs on the root so the open handler can find them without re-querying. */
  root._refs = { merchantStrong, itemRow, amtSpan, input, errorEl, cancelBtn, authBtn };
  document.body.appendChild(root);
  _purchaseModalEl = root;
  return root;
}

/** Show the modal for the given typed-confirm payload from the bridge. */
function openPurchaseTypedConfirm({ pendingId, merchant, item, amountGbp }) {
  const root = ensurePurchaseModal();
  const { merchantStrong, itemRow, amtSpan, input, errorEl, cancelBtn, authBtn } = root._refs;

  merchantStrong.textContent = merchant || "(unknown merchant)";
  itemRow.textContent = item || "(no item description)";
  const expectedNum = Number(amountGbp);
  amtSpan.textContent = Number.isFinite(expectedNum) ? expectedNum.toFixed(2) : "—";
  input.value = "";
  errorEl.textContent = "";
  authBtn.disabled = true;
  root.hidden = false;
  setTimeout(() => input.focus(), 50);

  const onInput = () => {
    const v = parseFloat(input.value);
    authBtn.disabled = !(Number.isFinite(v) && Number.isFinite(expectedNum) && Math.abs(v - expectedNum) <= 0.01);
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !authBtn.disabled) confirm();
    if (e.key === "Escape") cancel();
  };
  const cleanup = () => {
    input.removeEventListener("input", onInput);
    input.removeEventListener("keydown", onKey);
    cancelBtn.removeEventListener("click", cancel);
    authBtn.removeEventListener("click", confirm);
    root.hidden = true;
  };
  const cancel = async () => {
    try {
      await fetch("http://localhost:8766/purchases/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pendingId, action: "cancel" }),
      });
    } catch {}
    cleanup();
  };
  const confirm = async () => {
    authBtn.disabled = true;
    errorEl.textContent = "Submitting…";
    try {
      const r = await fetch("http://localhost:8766/purchases/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pendingId, action: "confirm", enteredAmountGbp: parseFloat(input.value) }),
      });
      const j = await r.json().catch(() => ({}));
      if (j.ok) {
        errorEl.textContent = "";
        cleanup();
      } else {
        errorEl.textContent = j.error || "Confirmation failed";
        authBtn.disabled = false;
        input.select();
      }
    } catch (e) {
      errorEl.textContent = `Network error: ${e.message}`;
      authBtn.disabled = false;
    }
  };
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKey);
  cancelBtn.addEventListener("click", cancel);
  authBtn.addEventListener("click", confirm);
}

/** Refresh the Agent Console's purchase audit list if the modal is currently
 *  open. Called whenever a purchase.recorded event fires so the journal
 *  appears live; otherwise the operator would have to close + reopen to see
 *  what just happened. Best-effort — bridge offline silently leaves the
 *  existing list. */
async function refreshAgentModalPurchaseAudit() {
  if (!_agentModalEl || _agentModalEl.hidden) return;
  const refs = _agentModalEl._refs;
  if (!refs?.journalHost || !refs?.summaryEl) return;
  try {
    const r = await fetch("http://localhost:8766/purchases/audit?limit=50", { cache: "no-store" });
    if (!r.ok) return;
    const a = await r.json();
    renderPurchaseJournal(refs.journalHost, refs.summaryEl, a.journal || [], a.limits);
  } catch { /* bridge offline — keep stale list rather than blanking it */ }
}

/** Brief audit badge — appears in the corner for ~5s every time a purchase
 *  request was settled or rejected. Lets the operator catch the LLM trying
 *  things in the background without staring at a log. Also kicks the Agent
 *  Console refresh so an open modal stays live. */
function flashPurchaseAuditBadge(data) {
  let host = document.getElementById("purchaseAuditBadge");
  if (!host) {
    host = document.createElement("div");
    host.id = "purchaseAuditBadge";
    host.style.cssText = "position:fixed;right:18px;bottom:18px;background:#0a0a0a;border:1px solid var(--accent);color:#eaeaea;padding:10px 14px;font-family:var(--mono,monospace);font-size:11px;letter-spacing:0.08em;z-index:9999;max-width:340px;box-shadow:0 0 24px rgba(0,212,255,0.25);transition:opacity 250ms;";
    document.body.appendChild(host);
  }
  const verb = data.ok ? (data.simulated ? "SIM" : "PAID") : "BLOCKED";
  const amt = data.chargedGbp != null ? ` £${Number(data.chargedGbp).toFixed(2)}` : "";
  const detail = data.code ? ` — ${data.code}` : "";
  host.textContent = `${verb}${amt} · ${data.merchant || "?"} · ${(data.item || "").slice(0, 40)}${detail}`;
  host.style.opacity = "1";
  clearTimeout(host._fadeTimer);
  host._fadeTimer = setTimeout(() => { host.style.opacity = "0"; }, 5000);
}

/* ---------- AGENT MODAL (Shift+Cmd+J) ----------
 * Compact control panel for the new agent capabilities — LLM provider keys,
 * workload routing, and a scrollable purchase audit log. Opens via keyboard
 * shortcut so Adam can pull it up from anywhere; built lazily on first open
 * so the cost is zero for operators who never use it.
 *
 * Why a separate modal rather than another tab in the existing settingsModal:
 * the settings modal is dense already and these are operator-trust controls
 * (API keys, money). Keeping them physically separate makes accidental
 * misclicks harder. */

let _agentModalEl = null;

function ensureAgentModal() {
  if (_agentModalEl) return _agentModalEl;
  const root = el("div", { id: "agentModal" });
  root.hidden = true;
  const style = document.createElement("style");
  style.textContent = `
    #agentModal { position: fixed; inset: 0; background: rgba(0,0,0,0.78); z-index: 10000; display: flex; align-items: center; justify-content: center; font-family: var(--mono, "JetBrains Mono", monospace); }
    #agentModal .am-frame { background: #0b0b0b; border: 2px solid var(--accent); padding: 28px 32px; width: 720px; max-width: 92vw; max-height: 86vh; overflow-y: auto; box-shadow: 0 0 60px rgba(0,212,255,0.3); }
    #agentModal h2 { color: var(--accent); margin: 0 0 4px; font-size: 14px; letter-spacing: 0.18em; text-transform: uppercase; }
    #agentModal .am-sub { color: #888; font-size: 11px; margin-bottom: 24px; }
    #agentModal h3 { color: #fff; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; margin: 22px 0 10px; padding-top: 14px; border-top: 1px solid #1f1f1f; }
    #agentModal h3:first-of-type { padding-top: 0; border-top: none; margin-top: 0; }
    #agentModal label { display: block; color: #ccc; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 4px; }
    #agentModal input, #agentModal select { background: #000; color: #fff; border: 1px solid #2a2a2a; padding: 8px 10px; width: 100%; font-family: inherit; font-size: 12px; box-sizing: border-box; margin-bottom: 10px; }
    #agentModal input:focus, #agentModal select:focus { outline: none; border-color: var(--accent); }
    #agentModal .am-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    #agentModal .am-row.two { grid-template-columns: 1fr 1fr; }
    #agentModal .am-status { font-size: 10px; color: #777; margin: 0 0 8px; min-height: 14px; }
    #agentModal .am-status.ok { color: #00ff88; }
    #agentModal .am-status.err { color: var(--accent); }
    #agentModal .am-buttons { display: flex; gap: 12px; justify-content: flex-end; margin-top: 18px; }
    #agentModal button { padding: 10px 20px; background: #181818; color: #fff; border: 1px solid #333; cursor: pointer; font-family: inherit; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; }
    #agentModal button.primary { background: var(--accent); color: #000; border-color: var(--accent); font-weight: 700; }
    #agentModal button:hover { filter: brightness(1.18); }
    #agentModal .am-journal { max-height: 240px; overflow-y: auto; background: #050505; border: 1px solid #1c1c1c; padding: 10px 12px; }
    #agentModal .am-journal-row { color: #ccc; font-size: 11px; padding: 4px 0; border-bottom: 1px dashed #1a1a1a; display: grid; grid-template-columns: 56px 70px 1fr 130px; gap: 8px; align-items: baseline; }
    #agentModal .am-journal-row:last-child { border-bottom: none; }
    #agentModal .am-journal-row .verb { font-weight: 700; letter-spacing: 0.08em; }
    #agentModal .am-journal-row .verb.ok { color: #00ff88; }
    #agentModal .am-journal-row .verb.sim { color: #ffaa00; }
    #agentModal .am-journal-row .verb.bad { color: var(--accent); }
    #agentModal .am-journal-row .amt { color: #888; text-align: right; font-variant-numeric: tabular-nums; }
    #agentModal .am-journal-empty { color: #555; font-size: 11px; text-align: center; padding: 20px; }
    #agentModal .am-summary { color: #999; font-size: 10px; margin-top: 8px; letter-spacing: 0.05em; }
  `;
  root.appendChild(style);

  const frame = el("div", { className: "am-frame" });
  frame.appendChild(el("h2", { text: "Agent Console" }));
  frame.appendChild(el("div", { className: "am-sub", text: "LLM providers, workload routing, and purchase audit. Shift+Cmd+J to toggle." }));

  /* Section 1: LLM API keys */
  frame.appendChild(el("h3", { text: "LLM provider keys" }));
  const keyAnthropic = el("input", { attrs: { type: "password", placeholder: "sk-ant-…", autocomplete: "off" } });
  const keyOpenai    = el("input", { attrs: { type: "password", placeholder: "sk-…", autocomplete: "off" } });
  const apRow = el("div", { className: "am-row two" });
  apRow.appendChild((() => { const w = document.createElement("div"); w.appendChild(el("label", { text: "Anthropic API key" })); w.appendChild(keyAnthropic); return w; })());
  apRow.appendChild((() => { const w = document.createElement("div"); w.appendChild(el("label", { text: "OpenAI API key" })); w.appendChild(keyOpenai); return w; })());
  frame.appendChild(apRow);

  /* Section 2: workload routing */
  frame.appendChild(el("h3", { text: "Workload routing" }));
  const mkSelect = (defaultVal) => {
    const s = document.createElement("select");
    for (const v of ["ollama", "anthropic", "openai"]) {
      const o = document.createElement("option"); o.value = v; o.textContent = v;
      s.appendChild(o);
    }
    s.value = defaultVal;
    return s;
  };
  const routeDefault    = mkSelect("ollama");
  const routeVision     = mkSelect("anthropic");
  const routeHighstakes = mkSelect("anthropic");
  const rRow = el("div", { className: "am-row" });
  rRow.appendChild((() => { const w = document.createElement("div"); w.appendChild(el("label", { text: "Default chat" })); w.appendChild(routeDefault); return w; })());
  rRow.appendChild((() => { const w = document.createElement("div"); w.appendChild(el("label", { text: "Vision (browser/image)" })); w.appendChild(routeVision); return w; })());
  rRow.appendChild((() => { const w = document.createElement("div"); w.appendChild(el("label", { text: "High-stakes" })); w.appendChild(routeHighstakes); return w; })());
  frame.appendChild(rRow);
  const routingHint = el("div", { className: "am-status", text: "request_browse needs vision = anthropic or openai (vision-capable)." });
  frame.appendChild(routingHint);

  const status = el("div", { className: "am-status" });
  const cancelBtn = el("button", { className: "cancel", text: "Close" });
  const saveBtn = el("button", { className: "primary", text: "Save" });
  const buttons = el("div", { className: "am-buttons" }, status, cancelBtn, saveBtn);
  frame.appendChild(buttons);

  /* Section 3: tool router live picks */
  frame.appendChild(el("h3", { text: "Tool router — live picks" }));
  const routerStatusEl = el("div", { className: "am-summary", text: "Loading index status…" });
  frame.appendChild(routerStatusEl);
  const picksHost = el("div", { className: "am-journal" });
  frame.appendChild(picksHost);

  /* Section 4: token usage + cost */
  frame.appendChild(el("h3", { text: "LLM usage — today / week" }));
  const usageHeadlineEl = el("div", { className: "am-summary", text: "Loading…" });
  frame.appendChild(usageHeadlineEl);
  const usageRollupHost = el("div", { className: "am-journal" });
  frame.appendChild(usageRollupHost);
  const usageNoteEl = el("div", { className: "am-summary", text: "" });
  usageNoteEl.style.fontSize = "9px";
  usageNoteEl.style.fontStyle = "italic";
  frame.appendChild(usageNoteEl);

  /* Section 5: knowledge base */
  frame.appendChild(el("h3", { text: "Knowledge base" }));
  const knowledgeHeadlineEl = el("div", { className: "am-summary", text: "Loading…" });
  frame.appendChild(knowledgeHeadlineEl);
  const knowledgeListHost = el("div", { className: "am-journal" });
  frame.appendChild(knowledgeListHost);

  /* Section 6: iMessage activity */
  frame.appendChild(el("h3", { text: "iMessage adapter" }));
  const imessageStatusEl = el("div", { className: "am-summary", text: "Loading…" });
  frame.appendChild(imessageStatusEl);

  /* Section 7: purchase audit */
  frame.appendChild(el("h3", { text: "Purchase audit log" }));
  const journalHost = el("div", { className: "am-journal" });
  const summaryEl = el("div", { className: "am-summary", text: "Loading…" });
  frame.appendChild(journalHost);
  frame.appendChild(summaryEl);

  root.appendChild(frame);
  root._refs = { keyAnthropic, keyOpenai, routeDefault, routeVision, routeHighstakes, status, cancelBtn, saveBtn, journalHost, summaryEl, routerStatusEl, picksHost, usageHeadlineEl, usageRollupHost, usageNoteEl, knowledgeHeadlineEl, knowledgeListHost, imessageStatusEl };
  document.body.appendChild(root);
  _agentModalEl = root;

  cancelBtn.addEventListener("click", () => { root.hidden = true; });
  root.addEventListener("click", (e) => { if (e.target === root) root.hidden = true; });
  saveBtn.addEventListener("click", () => saveAgentModal(root));

  return root;
}

/* Ring buffer of recent tool-picks. Capped at 12 entries — enough to spot a
 * pattern, small enough not to grow unbounded. Live-renders into the Agent
 * Console if it's open; otherwise the modal pulls the buffer on next open. */
const _toolPicksRing = [];
const TOOL_PICKS_MAX = 12;

function rememberToolPick(data) {
  _toolPicksRing.unshift({ ts: Date.now(), ...data });
  if (_toolPicksRing.length > TOOL_PICKS_MAX) _toolPicksRing.length = TOOL_PICKS_MAX;
  /* Live re-render if the modal is open. */
  if (_agentModalEl && !_agentModalEl.hidden) {
    renderToolPicks(_agentModalEl._refs.picksHost);
  }
}

function renderToolPicks(host) {
  if (!host) return;
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!_toolPicksRing.length) {
    host.appendChild(el("div", { className: "am-journal-empty", text: "No queries yet — say something to Jarvis." }));
    return;
  }
  for (const pick of _toolPicksRing) {
    const row = el("div", { className: "am-journal-row" });
    const ts = new Date(pick.ts);
    const tsLabel = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
    row.appendChild(el("span", { text: tsLabel }));
    /* Stream tag — visual cue distinguishing streaming chat from the
     * non-streaming tool-dispatch path. Streaming dominates the voice loop
     * so this is the common case. */
    const verb = el("span", { className: "verb" });
    if (pick.fallback) { verb.textContent = "FULL"; verb.classList.add("bad"); }
    else if (pick.stream) { verb.textContent = "STRM"; verb.classList.add("ok"); }
    else { verb.textContent = "ASK";  verb.classList.add("sim"); }
    row.appendChild(verb);
    /* Detail: trimmed query + the ratio of picked tools. The model name
     * goes in the right column so cascade-router behaviour is visible at
     * a glance — the operator sees 3b for chat queries vs 14b for drafts. */
    const ratio = `${pick.picked?.length ?? 0}/${pick.total ?? 0}`;
    const detail = el("span", { text: `"${(pick.query || "").slice(0, 40)}" → ${ratio} tools` });
    detail.title = (pick.picked || []).slice(0, 30).join(", ");
    row.appendChild(detail);
    /* Compact model badge: drop the "qwen2.5:" prefix so "qwen2.5:3b" → "3b". */
    const modelShort = (pick.modelUsed || "").replace(/^qwen2\.5:/, "").replace(/^claude-/, "").slice(0, 14);
    const ms = el("span", { className: "amt", text: `${modelShort || "?"} · ${pick.elapsedMs ?? "?"}ms` });
    row.appendChild(ms);
    host.appendChild(row);
  }
}

/** Render the LLM usage rollup — today's total cost up top, per-model breakdown
 *  beneath, plus the pricing-estimate note at the bottom. Local Ollama always
 *  shows $0 cost so the spotlight is on cloud spend. */
function renderUsageSection(headlineEl, rollupHost, noteEl, payload) {
  const today = payload?.today || { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, byModel: [] };
  const week = payload?.week || { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 };
  const fmtUSD = (n) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
  const fmtTokens = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  headlineEl.textContent = `Today: ${today.calls} calls · ${fmtTokens(today.tokensIn + today.tokensOut)} tokens · ${fmtUSD(today.costUSD)} estimated · ${week.calls} calls / ${fmtUSD(week.costUSD)} this week`;
  while (rollupHost.firstChild) rollupHost.removeChild(rollupHost.firstChild);
  const rows = today.byModel || [];
  if (!rows.length) {
    rollupHost.appendChild(el("div", { className: "am-journal-empty", text: "No LLM activity today yet." }));
  } else {
    for (const r of rows) {
      const row = el("div", { className: "am-journal-row" });
      /* Provider badge: ollama=green, anthropic=red, openai=amber. */
      const verb = el("span", { className: "verb" });
      verb.textContent = r.provider.slice(0, 4).toUpperCase();
      if (r.provider === "ollama") verb.classList.add("ok");
      else if (r.provider === "anthropic") verb.classList.add("bad");
      else verb.classList.add("sim");
      row.appendChild(el("span", { text: `${r.calls}×` }));
      row.appendChild(verb);
      row.appendChild(el("span", { text: `${r.model.replace(/^qwen2\.5:/, "").replace(/^claude-/, "")} · ${fmtTokens(r.tokensIn + r.tokensOut)} tok` }));
      row.appendChild(el("span", { className: "amt", text: r.costUSD > 0 ? fmtUSD(r.costUSD) : "—" }));
      rollupHost.appendChild(row);
    }
  }
  noteEl.textContent = payload?.pricingNote || "";
}

/** Render the knowledge-base section: doc count + chunk count + last
 *  ingest, plus a top-N list of recent docs with their format chip.
 *  The endpoint splits the count under `documentCount` and the array
 *  under `docs` so the field names don't collide. */
function renderKnowledgeSection(headlineEl, listHost, payload) {
  if (!payload || !payload.ok) {
    headlineEl.textContent = "Bridge offline.";
    return;
  }
  const docCount = payload.documentCount || 0;
  const chunks = payload.chunks || 0;
  const embedded = payload.embedded || 0;
  const last = payload.lastIngestAt;
  const lastLabel = last ? new Date(last).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "(never)";
  headlineEl.textContent = `${docCount} documents · ${chunks} chunks · ${embedded} embedded · last: ${lastLabel}`;
  while (listHost.firstChild) listHost.removeChild(listHost.firstChild);
  const items = Array.isArray(payload.docs) ? payload.docs : [];
  if (!items.length) {
    listHost.appendChild(el("div", { className: "am-journal-empty", text: "Drop files into docs/knowledge/ to start indexing." }));
    return;
  }
  for (const doc of items.slice(0, 8)) {
    const row = el("div", { className: "am-journal-row" });
    const ts = new Date(doc.ingested_at);
    const tsLabel = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`;
    row.appendChild(el("span", { text: tsLabel }));
    const fmt = el("span", { className: "verb ok", text: (doc.format || "?").toUpperCase() });
    row.appendChild(fmt);
    row.appendChild(el("span", { text: `${doc.title || doc.rel_path} (${doc.chunk_count || 0} chunks)` }));
    row.appendChild(el("span", { className: "amt", text: `${Math.round((doc.bytes || 0) / 1024)}KB` }));
    listHost.appendChild(row);
  }
}

/** Render the iMessage adapter status — enabled flag, allowlist size,
 *  trigger phrase, chat.db reachability (Full Disk Access proxy). */
function renderImessageSection(statusEl, payload) {
  if (!payload || !payload.ok) {
    statusEl.textContent = "Bridge offline.";
    return;
  }
  if (!payload.running) {
    statusEl.textContent = "Listener not running.";
    return;
  }
  if (!payload.enabled) {
    statusEl.textContent = `Disabled — edit data/imessage-config.json to enable. Trigger: "${payload.trigger}". Sender allowlist: ${payload.allowedSenderCount}.`;
    return;
  }
  const dbStatus = payload.chatDbReachable ? "chat.db reachable" : "chat.db UNREACHABLE — grant Full Disk Access in System Settings";
  statusEl.textContent = `Enabled · ${payload.allowedSenderCount} allowed sender(s) · trigger "${payload.trigger}" · poll every ${payload.pollIntervalMs}ms · ${dbStatus}`;
}

/** Render the journal rows. Pulls from /purchases/audit. Renders newest first. */
function renderPurchaseJournal(host, summaryEl, journal, limits) {
  while (host.firstChild) host.removeChild(host.firstChild);
  if (!journal?.length) {
    host.appendChild(el("div", { className: "am-journal-empty", text: "No purchase activity yet." }));
  } else {
    let totalSettled = 0;
    let countSettled = 0;
    for (const e of journal) {
      const row = el("div", { className: "am-journal-row" });
      const ts = new Date(e.iso || e.ts);
      const tsLabel = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`;
      row.appendChild(el("span", { text: tsLabel }));
      const verb = el("span", { className: "verb" });
      if (e.status === "settled" && e.simulated) { verb.textContent = "SIM"; verb.classList.add("sim"); }
      else if (e.status === "settled") { verb.textContent = "PAID"; verb.classList.add("ok"); totalSettled += Number(e.amountGbp) || 0; countSettled++; }
      else if (e.status === "rejected" || e.status === "blocked") { verb.textContent = "BLOCK"; verb.classList.add("bad"); }
      else if (e.status === "pending_typed") { verb.textContent = "WAIT"; verb.classList.add("sim"); }
      else { verb.textContent = (e.status || "?").slice(0, 5).toUpperCase(); }
      row.appendChild(verb);
      const detail = el("span", { text: `${(e.merchantLabel || e.merchant || "?").slice(0, 30)} · ${(e.item || "").slice(0, 32)}${e.reason && e.reason !== "ok" ? ` (${e.reason})` : ""}` });
      row.appendChild(detail);
      const amt = e.amountGbp != null ? `£${Number(e.amountGbp).toFixed(2)}` : "—";
      row.appendChild(el("span", { className: "amt", text: amt }));
      host.appendChild(row);
    }
    const dailyCap = limits?.dailyCapGbp ?? 50;
    const weeklyCap = limits?.weeklyCapGbp ?? 150;
    summaryEl.textContent = `${countSettled} settled · £${totalSettled.toFixed(2)} total in journal · daily cap £${dailyCap} · weekly cap £${weeklyCap}`;
  }
}

async function openAgentModal() {
  const root = ensureAgentModal();
  const { keyAnthropic, keyOpenai, routeDefault, routeVision, routeHighstakes, status, journalHost, summaryEl, routerStatusEl, picksHost, usageHeadlineEl, usageRollupHost, usageNoteEl, knowledgeHeadlineEl, knowledgeListHost, imessageStatusEl } = root._refs;
  status.textContent = ""; status.className = "am-status";
  keyAnthropic.value = ""; keyOpenai.value = "";
  root.hidden = false;
  /* Render the in-memory ring buffer immediately so the panel isn't blank
   * while the network fetches resolve. */
  renderToolPicks(picksHost);
  /* Fetch current state in parallel — keys, audit, health, usage,
   * knowledge, iMessage. Bridge offline → leave placeholders. */
  try {
    const [keysRes, auditRes, healthRes, usageRes, knowledgeRes, imessageRes] = await Promise.all([
      fetch("http://localhost:8766/api-keys", { cache: "no-store" }),
      fetch("http://localhost:8766/purchases/audit?limit=50", { cache: "no-store" }),
      fetch("http://localhost:8766/health", { cache: "no-store" }),
      fetch("http://localhost:8766/usage?limit=30", { cache: "no-store" }),
      fetch("http://localhost:8766/knowledge/status", { cache: "no-store" }),
      fetch("http://localhost:8766/imessage/status", { cache: "no-store" }),
    ]);
    if (usageRes.ok) {
      const u = await usageRes.json();
      renderUsageSection(usageHeadlineEl, usageRollupHost, usageNoteEl, u);
    }
    if (knowledgeRes.ok) {
      const k = await knowledgeRes.json();
      renderKnowledgeSection(knowledgeHeadlineEl, knowledgeListHost, k);
    }
    if (imessageRes.ok) {
      const im = await imessageRes.json();
      renderImessageSection(imessageStatusEl, im);
    }
    if (healthRes.ok) {
      const h = await healthRes.json();
      const tr = h.toolRouter || {};
      if (tr.ready) {
        routerStatusEl.textContent = `Index ready · ${tr.toolCount} tools indexed · always-on: ${tr.alwaysOn?.length || 0} · hash ${tr.hash || "?"}`;
      } else {
        routerStatusEl.textContent = `Index not ready — chat is using the full ${h.toolCount || "?"}-tool catalogue (slower, less accurate).`;
      }
    } else {
      routerStatusEl.textContent = "Could not fetch index status.";
    }
    if (keysRes.ok) {
      const j = await keysRes.json();
      keyAnthropic.placeholder = j.keys?.anthropic?.set ? `(set ${j.keys.anthropic.hint || ""}) — type to change` : "sk-ant-…";
      keyOpenai.placeholder    = j.keys?.openai?.set    ? `(set ${j.keys.openai.hint    || ""}) — type to change` : "sk-…";
      if (j.routing) {
        if (j.routing.default)    routeDefault.value    = j.routing.default;
        if (j.routing.vision)     routeVision.value     = j.routing.vision;
        if (j.routing.highstakes) routeHighstakes.value = j.routing.highstakes;
      }
    }
    if (auditRes.ok) {
      const a = await auditRes.json();
      renderPurchaseJournal(journalHost, summaryEl, a.journal || [], a.limits);
    }
  } catch (e) {
    status.textContent = `Bridge offline — ${e.message}`;
    status.className = "am-status err";
  }
}

async function saveAgentModal(root) {
  const { keyAnthropic, keyOpenai, routeDefault, routeVision, routeHighstakes, status, saveBtn } = root._refs;
  saveBtn.disabled = true;
  status.textContent = "Saving…"; status.className = "am-status";
  const payload = {
    defaultProvider: routeDefault.value,
    visionProvider: routeVision.value,
    highstakesProvider: routeHighstakes.value,
  };
  /* Empty key fields = don't change. Only POST the keys the operator filled in. */
  if (keyAnthropic.value.trim()) payload.anthropic = keyAnthropic.value.trim();
  if (keyOpenai.value.trim())    payload.openai    = keyOpenai.value.trim();
  try {
    const r = await fetch("http://localhost:8766/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (j.ok) {
      status.textContent = "Saved";
      status.className = "am-status ok";
      keyAnthropic.value = "";
      keyOpenai.value = "";
      setTimeout(() => { root.hidden = true; status.textContent = ""; }, 800);
    } else {
      status.textContent = j.error || "Save failed";
      status.className = "am-status err";
    }
  } catch (e) {
    status.textContent = `Network error: ${e.message}`;
    status.className = "am-status err";
  } finally {
    saveBtn.disabled = false;
  }
}

/* Keyboard shortcut: Shift+Cmd+J (Cmd on macOS, Ctrl elsewhere). */
document.addEventListener("keydown", (e) => {
  if (e.shiftKey && (e.metaKey || e.ctrlKey) && (e.key === "J" || e.key === "j")) {
    e.preventDefault();
    if (_agentModalEl && !_agentModalEl.hidden) {
      _agentModalEl.hidden = true;
    } else {
      openAgentModal();
    }
  }
});

/* ---------- LATENCY DEBUG PANEL (Shift+Cmd+P) ----------
 *  T1 sprint instrumentation. Polls /health/timings every 2s while open
 *  and renders p50/p95 per pipeline stage so the operator can see where
 *  the voice loop is spending time. Hidden by default; toggled by
 *  Shift+Cmd+P. All values rendered via textContent — never innerHTML. */
let _perfPanelEl = null;
let _perfPanelPoll = null;
let _perfPanelGrid = null;
let _perfPanelMeta = null;

function _buildPerfPanel() {
  const root = document.createElement("div");
  root.id = "perfDebugPanel";
  root.style.cssText = `position: fixed; top: 60px; right: 20px; z-index: 9999;
    background: rgba(2, 6, 12, 0.95); border: 1px solid var(--accent);
    padding: 14px 18px; min-width: 320px;
    font-family: var(--font-mono, monospace); font-size: 11px;
    color: var(--text); box-shadow: 0 0 24px rgba(0,212,255,0.3);
    clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);`;

  const title = document.createElement("div");
  title.textContent = "// VOICE PIPELINE p50/p95";
  title.style.cssText = "font-family:var(--font-display);letter-spacing:0.22em;color:var(--accent);font-size:10px;margin-bottom:8px;";
  root.appendChild(title);

  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:4px 12px;";
  root.appendChild(grid);

  const meta = document.createElement("div");
  meta.style.cssText = "opacity:0.5;font-size:9px;margin-top:8px;";
  meta.textContent = "Shift+Cmd+P to close";
  root.appendChild(meta);

  document.body.appendChild(root);
  _perfPanelEl = root;
  _perfPanelGrid = grid;
  _perfPanelMeta = meta;
}

function _spanRow(label, span, highlight) {
  const k = document.createElement("div");
  k.textContent = label;
  if (highlight) { k.style.color = "var(--accent)"; k.style.fontWeight = "600"; }
  const v = document.createElement("div");
  if (highlight) { v.style.color = "var(--accent)"; v.style.fontWeight = "600"; }
  if (span == null) {
    v.textContent = "—";
  } else {
    const p50 = document.createElement("span");
    p50.style.color = "var(--accent)";
    p50.textContent = String(span.p50);
    const sep = document.createTextNode("/" + span.p95 + "ms ");
    const n = document.createElement("span");
    n.style.opacity = "0.5";
    n.textContent = "n=" + span.n;
    v.appendChild(p50);
    v.appendChild(sep);
    v.appendChild(n);
  }
  return [k, v];
}

function openPerfPanel() {
  if (!_perfPanelEl) _buildPerfPanel();
  _perfPanelEl.hidden = false;
  refreshPerfPanel();
  _perfPanelPoll = setInterval(refreshPerfPanel, 2000);
}
function closePerfPanel() {
  if (_perfPanelEl) _perfPanelEl.hidden = true;
  if (_perfPanelPoll) { clearInterval(_perfPanelPoll); _perfPanelPoll = null; }
}
async function refreshPerfPanel() {
  if (!_perfPanelEl || !_perfPanelGrid) return;
  try {
    const r = await fetch("http://localhost:8766/health/timings", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    _perfPanelGrid.replaceChildren();
    const rows = [
      ["voice → rec end",     j.spans.voice_to_recend,    false],
      ["voice → whisper",     j.spans.voice_to_whisper,   false],
      ["whisper r/t",         j.spans.whisper_roundtrip,  false],
      ["whisper inference",   j.spans.whisper_inference,  false],
      ["voice → audio",       j.spans.voice_to_audio,     true ],
    ];
    for (const [label, span, hl] of rows) {
      const [k, v] = _spanRow(label, span, hl);
      _perfPanelGrid.appendChild(k);
      _perfPanelGrid.appendChild(v);
    }
    if (_perfPanelMeta) _perfPanelMeta.textContent = `samples: ${j.samples} · Shift+Cmd+P to close`;
  } catch {}
}
document.addEventListener("keydown", (e) => {
  if (e.shiftKey && (e.metaKey || e.ctrlKey) && (e.key === "P" || e.key === "p")) {
    e.preventDefault();
    if (_perfPanelEl && !_perfPanelEl.hidden) closePerfPanel();
    else openPerfPanel();
  }
});

/* ---------- DEMO / CLEAN MODE (Shift+Cmd+D) ----------
 *  Shift+Cmd+D toggles `body.is-demo`. CSS rules in styles.css hide the
 *  numeric readouts, REC indicator, history drawer, notification timestamps
 *  and conversation timestamps — leaving a cinematic surface for client
 *  visits. A tiny DEMO badge top-right is added so the operator can see
 *  at a glance what mode they're in (demo mode is otherwise quiet about
 *  itself by design). The shortcut is symmetric — same combo exits.
 *
 *  Why Shift+Cmd+D: plain Cmd+D is bookmark in Chrome. Shift+Cmd+D matches
 *  the Shift+Cmd+J pattern of the Agent Console for muscle-memory consistency. */

let _demoBadgeEl = null;

function ensureDemoBadge() {
  if (_demoBadgeEl) return _demoBadgeEl;
  const badge = document.createElement("div");
  badge.id = "demoBadge";
  badge.textContent = "DEMO";
  badge.style.cssText = "position:fixed;top:12px;right:12px;z-index:10000;font-family:var(--mono,monospace);font-size:9px;letter-spacing:0.24em;color:#888;border:1px solid #333;padding:3px 8px;background:rgba(0,0,0,0.6);pointer-events:none;display:none;";
  document.body.appendChild(badge);
  _demoBadgeEl = badge;
  return badge;
}

function toggleDemoMode() {
  const badge = ensureDemoBadge();
  const wasDemo = document.body.classList.toggle("is-demo");
  badge.style.display = wasDemo ? "block" : "none";
  /* Persist across HUD reloads so a kiosk left in demo mode for a session
   * doesn't reset on Cmd+R. localStorage is per-origin so each install is
   * independent. */
  try { localStorage.setItem("jarvis.demoMode", wasDemo ? "1" : "0"); } catch {}
  console.log(`[Jarvis] demo mode ${wasDemo ? "ON" : "OFF"}`);
}

/* Restore on reload. */
try {
  if (localStorage.getItem("jarvis.demoMode") === "1") {
    /* Defer to after DOMContentLoaded so the badge can be appended cleanly. */
    document.addEventListener("DOMContentLoaded", () => {
      document.body.classList.add("is-demo");
      const b = ensureDemoBadge();
      b.style.display = "block";
    });
  }
} catch {}

document.addEventListener("keydown", (e) => {
  if (e.shiftKey && (e.metaKey || e.ctrlKey) && (e.key === "D" || e.key === "d")) {
    e.preventDefault();
    toggleDemoMode();
  }
});

/* ---------- ACCESSIBILITY TOGGLES ----------
 *  Three independent body classes, each toggled by a keyboard chord:
 *    Shift+Cmd+M → reduced-motion (kills transitions/animations)
 *    Shift+Cmd+C → high-contrast (white text, red panel borders)
 *    Shift+Cmd+T → bigger-text (15% bump on root font size)
 *  Each persists via localStorage so a colleague's preference survives
 *  Cmd+R. Tiny corner badge stack appears when any are on so the operator
 *  sees their state without opening settings. */

const A11Y_TOGGLES = [
  { key: "M", cls: "is-reduced-motion", label: "REDUCED MOTION", storage: "jarvis.reducedMotion" },
  { key: "C", cls: "is-high-contrast",  label: "HIGH CONTRAST",  storage: "jarvis.highContrast" },
  { key: "T", cls: "is-bigger-text",    label: "BIGGER TEXT",    storage: "jarvis.biggerText" },
];

let _a11yBadgeHost = null;
function ensureA11yBadgeHost() {
  if (_a11yBadgeHost) return _a11yBadgeHost;
  const host = document.createElement("div");
  host.id = "a11yBadges";
  host.style.cssText = "position:fixed;top:42px;right:12px;z-index:9999;display:flex;flex-direction:column;gap:4px;align-items:flex-end;font-family:var(--mono,monospace);font-size:9px;letter-spacing:0.18em;color:#888;pointer-events:none;";
  document.body.appendChild(host);
  _a11yBadgeHost = host;
  return host;
}

function refreshA11yBadges() {
  const host = ensureA11yBadgeHost();
  while (host.firstChild) host.removeChild(host.firstChild);
  for (const t of A11Y_TOGGLES) {
    if (document.body.classList.contains(t.cls)) {
      const b = el("div", { text: t.label });
      b.style.cssText = "border:1px solid #333;padding:2px 7px;background:rgba(0,0,0,0.55);";
      host.appendChild(b);
    }
  }
}

function toggleA11y(toggle) {
  const on = document.body.classList.toggle(toggle.cls);
  try { localStorage.setItem(toggle.storage, on ? "1" : "0"); } catch {}
  refreshA11yBadges();
  console.log(`[Jarvis] ${toggle.label} ${on ? "ON" : "OFF"}`);
}

/* Restore saved state on boot. */
try {
  for (const t of A11Y_TOGGLES) {
    if (localStorage.getItem(t.storage) === "1") {
      document.addEventListener("DOMContentLoaded", () => {
        document.body.classList.add(t.cls);
        refreshA11yBadges();
      });
    }
  }
} catch {}

document.addEventListener("keydown", (e) => {
  if (!(e.shiftKey && (e.metaKey || e.ctrlKey))) return;
  /* Match exact (case-insensitive). Ignore the chord if a modifier we don't
   * care about is held — prevents a stray Alt+Shift+Cmd+M binding from
   * firing two toggles. */
  const k = e.key.toUpperCase();
  for (const t of A11Y_TOGGLES) {
    if (k === t.key) {
      e.preventDefault();
      toggleA11y(t);
      return;
    }
  }
});

/* ---------- HELP / CHEAT SHEET (?) ----------
 *  Plain "?" key opens a searchable overlay listing every tool the LLM can
 *  invoke. Pulls from /actions (the manifest endpoint shipped this round)
 *  so it's always in sync with what's actually wired — no stale doc files.
 *  Operator types to filter by name/description; Esc closes; ? toggles.
 *
 *  Why "?" without a modifier: this matches the convention from GitHub,
 *  Slack, Linear and friends — it's the universal "help" shortcut and
 *  costs nothing to bind. We guard against text-input focus so it doesn't
 *  fire while the operator's typing in the typed-confirm modal or settings.
 */

let _helpModalEl = null;
let _helpManifest = null;

function ensureHelpModal() {
  if (_helpModalEl) return _helpModalEl;
  const root = el("div", { id: "helpModal" });
  root.hidden = true;
  const style = document.createElement("style");
  style.textContent = `
    /* CRITICAL: [hidden] must override the explicit display:flex below.
     * Without !important the user-agent [hidden]{display:none} rule loses
     * to the more-specific #helpModal selector and the modal stays visible
     * even when root.hidden=true. This was a "modal won't close" bug. */
    #helpModal[hidden] { display: none !important; }
    #helpModal { position: fixed; inset: 0; background: rgba(0,0,0,0.78); z-index: 10001; display: flex; align-items: center; justify-content: center; font-family: var(--mono, "JetBrains Mono", monospace); }
    #helpModal .hm-frame { background: #0b0b0b; border: 2px solid var(--accent); padding: 24px 28px; width: 760px; max-width: 92vw; max-height: 86vh; display: flex; flex-direction: column; box-shadow: 0 0 60px rgba(0,212,255,0.3); position: relative; }
    #helpModal .hm-close { position: absolute; top: 8px; right: 12px; background: transparent; border: 0; color: #888; font-size: 22px; line-height: 1; cursor: pointer; padding: 4px 8px; }
    #helpModal .hm-close:hover { color: var(--accent); }
    #helpModal h2 { color: var(--accent); margin: 0 0 4px; font-size: 14px; letter-spacing: 0.18em; text-transform: uppercase; }
    #helpModal .hm-sub { color: #888; font-size: 11px; margin-bottom: 14px; }
    #helpModal input.hm-search { background: #000; color: #fff; border: 1px solid #2a2a2a; padding: 10px 12px; width: 100%; font-family: inherit; font-size: 14px; box-sizing: border-box; margin-bottom: 14px; }
    #helpModal input.hm-search:focus { outline: none; border-color: var(--accent); }
    #helpModal .hm-list { overflow-y: auto; flex: 1; min-height: 200px; }
    #helpModal .hm-row { color: #ddd; font-size: 12px; padding: 8px 0; border-bottom: 1px dashed #1a1a1a; display: grid; grid-template-columns: 220px 1fr 80px; gap: 12px; align-items: baseline; }
    #helpModal .hm-row:last-child { border-bottom: none; }
    #helpModal .hm-name { color: var(--accent); font-weight: 600; letter-spacing: 0.04em; }
    #helpModal .hm-desc { color: #aaa; line-height: 1.4; }
    #helpModal .hm-flags { color: #555; font-size: 9px; letter-spacing: 0.12em; text-align: right; text-transform: uppercase; }
    #helpModal .hm-flag-confirm { color: #ffaa00; }
    #helpModal .hm-flag-always { color: #00ff88; }
    #helpModal .hm-empty { color: #555; padding: 24px; text-align: center; }
    #helpModal .hm-footer { color: #666; font-size: 10px; margin-top: 12px; letter-spacing: 0.05em; }
  `;
  root.appendChild(style);
  const frame = el("div", { className: "hm-frame" });
  /* Explicit close button — backstop for when keyboard handlers misbehave
   * or focus is somewhere odd. Always works. */
  const closeBtn = el("button", { className: "hm-close", attrs: { type: "button", "aria-label": "Close" }, text: "×" });
  closeBtn.addEventListener("click", () => { root.hidden = true; });
  frame.appendChild(closeBtn);
  frame.appendChild(el("h2", { text: "Voice command cheat sheet" }));
  const sub = el("div", { className: "hm-sub", text: "Loading…" });
  frame.appendChild(sub);
  const search = el("input", { className: "hm-search", attrs: { type: "text", placeholder: "Filter — try 'send', 'remind', 'photo'…", autocomplete: "off" } });
  frame.appendChild(search);
  const list = el("div", { className: "hm-list" });
  frame.appendChild(list);
  frame.appendChild(el("div", { className: "hm-footer", text: "Esc or ? to close · CONFIRM = voice 'yes' required · ALWAYS = always available to the model regardless of query" }));
  root.appendChild(frame);
  root._refs = { search, list, sub };
  document.body.appendChild(root);
  _helpModalEl = root;
  search.addEventListener("input", () => renderHelpList(root, search.value));
  search.addEventListener("keydown", (e) => { if (e.key === "Escape") root.hidden = true; });
  root.addEventListener("click", (e) => { if (e.target === root) root.hidden = true; });
  return root;
}

/* Category display order — matches the actions.meta.json _categories block.
 * Anything uncategorised falls into "other" rendered last. */
const HELP_CATEGORY_ORDER = ["communication", "productivity", "creative", "system", "memory"];
const HELP_CATEGORY_LABELS = {
  communication: "Communication",
  productivity:  "Productivity",
  creative:      "Creative",
  system:        "System",
  memory:        "Memory",
  plugin:        "Plugins",
  other:         "Other",
};

function renderHelpList(root, filter = "") {
  const { list, sub } = root._refs;
  if (!_helpManifest) {
    sub.textContent = "Loading manifest…";
    return;
  }
  const q = filter.trim().toLowerCase();
  const matches = _helpManifest.filter((a) => {
    if (!q) return true;
    if (a.name.toLowerCase().includes(q)) return true;
    if ((a.description || "").toLowerCase().includes(q)) return true;
    if ((a.label || "").toLowerCase().includes(q)) return true;
    if (Array.isArray(a.phrasings) && a.phrasings.some(p => p.toLowerCase().includes(q))) return true;
    return false;
  });
  while (list.firstChild) list.removeChild(list.firstChild);
  sub.textContent = `${matches.length} of ${_helpManifest.length} commands`;
  if (!matches.length) {
    list.appendChild(el("div", { className: "hm-empty", text: `No matches for "${filter}".` }));
    return;
  }

  /* Group matches by category. Tools without a category land in "other". */
  const grouped = {};
  for (const a of matches) {
    const cat = a.category || "other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(a);
  }
  const orderedKeys = [...HELP_CATEGORY_ORDER, "plugin", "other"].filter(k => grouped[k]?.length);

  for (const catKey of orderedKeys) {
    const items = grouped[catKey];
    /* Category header — collapses naturally when filtering. */
    const header = el("div", { className: "hm-cat" });
    header.appendChild(el("span", { className: "hm-cat__label", text: HELP_CATEGORY_LABELS[catKey] || catKey }));
    header.appendChild(el("span", { className: "hm-cat__count", text: `${items.length}` }));
    list.appendChild(header);

    for (const a of items) {
      const row = el("div", { className: "hm-row" });
      /* Prefer the human label when present; fall back to the raw tool name. */
      const displayName = a.label || a.name;
      const nameCell = el("div", { className: "hm-name" });
      nameCell.appendChild(el("span", { className: "hm-name__label", text: displayName }));
      if (a.label && a.label !== a.name) {
        nameCell.appendChild(el("span", { className: "hm-name__id", text: a.name }));
      }
      row.appendChild(nameCell);
      /* Description + first phrasing as a try-it example. */
      const descCell = el("div", { className: "hm-desc" });
      descCell.appendChild(el("div", { className: "hm-desc__text", text: (a.description || "").slice(0, 160) }));
      if (Array.isArray(a.phrasings) && a.phrasings.length) {
        descCell.appendChild(el("div", { className: "hm-desc__example", text: `"${a.phrasings[0]}…"` }));
      }
      row.appendChild(descCell);
      /* Flag column: CONFIRM (destructive) / ALWAYS (always-on). */
      const flagBits = [];
      if (a.destructive || a.flags?.requiresConfirmation) flagBits.push({ text: "confirm", cls: "hm-flag-confirm" });
      if (a.flags?.alwaysOn) flagBits.push({ text: "always", cls: "hm-flag-always" });
      const flagsCell = el("div", { className: "hm-flags" });
      flagBits.forEach((b, i) => {
        if (i) flagsCell.appendChild(document.createTextNode(" · "));
        flagsCell.appendChild(el("span", { className: b.cls, text: b.text }));
      });
      row.appendChild(flagsCell);
      list.appendChild(row);
    }
  }
}

async function openHelpModal() {
  const root = ensureHelpModal();
  root.hidden = false;
  setTimeout(() => root._refs.search.focus(), 50);
  /* Lazy-load + cache. The manifest is small (~30KB at 97 tools); fetching
   * once per session is fine. Reload after a bridge restart by closing &
   * reopening the modal — we could be cleverer with a stale check but this
   * works and is dead simple. */
  if (!_helpManifest) {
    try {
      const r = await fetch("http://localhost:8766/actions", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        _helpManifest = (j.actions || []).slice().sort((a, b) => a.name.localeCompare(b.name));
      } else {
        root._refs.sub.textContent = `Failed to load — bridge returned ${r.status}.`;
        return;
      }
    } catch (e) {
      root._refs.sub.textContent = `Bridge offline — ${e.message}`;
      return;
    }
  }
  renderHelpList(root, "");
}

document.addEventListener("keydown", (e) => {
  /* Don't fire while typing in any input/textarea — would make filling the
   * typed-confirm modal or settings forms infuriating. Match Slack/Linear
   * behaviour: ? in chat means literal "?", ? in body means open help. */
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (_helpModalEl && !_helpModalEl.hidden) {
      _helpModalEl.hidden = true;
    } else {
      openHelpModal();
    }
  }
  if (e.key === "Escape" && _helpModalEl && !_helpModalEl.hidden) {
    _helpModalEl.hidden = true;
  }
});

/* Permanent ? button next to SETTINGS. Click toggles the same help modal
 * as the ? key. Wired here (not in settings-modal.js) because the modal
 * lives in hud.js. */
const _helpBtn = document.getElementById("helpBtn");
if (_helpBtn) {
  _helpBtn.addEventListener("click", () => {
    if (_helpModalEl && !_helpModalEl.hidden) _helpModalEl.hidden = true;
    else openHelpModal();
  });
}

/* ---------- CREW LANES ----------
 *  Live visualisation of in-flight multi-agent crews. Mounts a panel
 *  bottom-right when a crew starts; shows one lane per agent with
 *  status (queued / running / done / failed), provider badge, current
 *  task description, tool-call chips firing in real time, and elapsed
 *  ms once the agent finishes. Whole panel auto-hides ~6s after the
 *  crew completes so the kiosk doesn't fill with stale UI.
 *
 *  Why bottom-right rather than centre: the kiosk's main visual is the
 *  speedometer; crews are operational telemetry that should live at
 *  the periphery. The operator can read it while still tracking voice
 *  state on the speedo.
 *
 *  Multiple crews running concurrently each get their own panel
 *  stacked vertically — keyed by crewId so events from one don't
 *  bleed into another. */

const _crewPanels = new Map();   // crewId → { root, agents: Map<agentId, laneEl> }

function ensureCrewLanesContainer() {
  let host = document.getElementById("crewLanesContainer");
  if (host) return host;
  host = document.createElement("div");
  host.id = "crewLanesContainer";
  host.style.cssText = "position:fixed;right:18px;bottom:60px;z-index:9988;display:flex;flex-direction:column;gap:10px;align-items:flex-end;font-family:var(--mono,monospace);pointer-events:none;";
  document.body.appendChild(host);
  /* Shared style block — added once. Subsequent panels reuse it. */
  if (!document.getElementById("crewLanesStyles")) {
    const s = document.createElement("style");
    s.id = "crewLanesStyles";
    s.textContent = `
      .crew-panel { background: rgba(11,11,11,0.94); border: 1px solid var(--accent); padding: 10px 14px 12px; min-width: 340px; max-width: 420px; pointer-events: auto; box-shadow: 0 0 24px rgba(0, 212, 255, 0.22); animation: crewPanelIn 220ms ease forwards; }
      @keyframes crewPanelIn { from { transform: translateX(40px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      .crew-panel.is-fading { opacity: 0; transition: opacity 600ms ease; }
      .crew-panel-head { color: var(--accent); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: baseline; }
      .crew-panel-mode { color: #888; font-size: 9px; letter-spacing: 0.12em; }
      .crew-lane { padding: 6px 0; border-top: 1px dashed #1a1a1a; }
      .crew-lane:first-of-type { border-top: none; padding-top: 4px; }
      .crew-lane-row { display: flex; gap: 8px; align-items: baseline; margin-bottom: 3px; }
      .crew-lane-status { font-size: 9px; letter-spacing: 0.12em; padding: 1px 5px; border: 1px solid #333; color: #888; min-width: 56px; text-align: center; }
      .crew-lane-status.is-running { border-color: #ffaa00; color: #ffaa00; animation: crewPulse 1.6s infinite; }
      .crew-lane-status.is-done { border-color: #00ff88; color: #00ff88; }
      .crew-lane-status.is-failed { border-color: var(--accent); color: var(--accent); }
      @keyframes crewPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
      .crew-lane-role { color: #fff; font-size: 11px; flex: 1; }
      .crew-lane-provider { color: #555; font-size: 9px; letter-spacing: 0.1em; }
      .crew-lane-meta { color: #666; font-size: 9px; line-height: 1.4; }
      .crew-lane-tools { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
      .crew-lane-tool-chip { background: rgba(255,170,0,0.12); color: #ffaa00; border: 1px solid rgba(255,170,0,0.3); font-size: 8px; padding: 0 4px; letter-spacing: 0.06em; }
      .crew-panel-foot { color: #555; font-size: 9px; letter-spacing: 0.06em; margin-top: 8px; padding-top: 6px; border-top: 1px solid #1a1a1a; display: flex; justify-content: space-between; }
      .crew-panel-cancel { color: #888; cursor: pointer; text-decoration: underline; }
      .crew-panel-cancel:hover { color: var(--accent); }
    `;
    document.head.appendChild(s);
  }
  return host;
}

function crewLanesOnStart(data) {
  const host = ensureCrewLanesContainer();
  const crewId = data.crewId;
  const root = document.createElement("div");
  root.className = "crew-panel";
  root.dataset.crewId = crewId;
  /* Header — crew id (last 6 of hash) + mode + maxParallel hint. */
  const head = document.createElement("div");
  head.className = "crew-panel-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = `CREW ${crewId.slice(-6)}`;
  head.appendChild(headLabel);
  const modeSpan = document.createElement("span");
  modeSpan.className = "crew-panel-mode";
  modeSpan.textContent = `${data.mode}${data.mode === "parallel" ? ` · ${data.maxParallel}-wide` : ""}`;
  head.appendChild(modeSpan);
  root.appendChild(head);
  /* Lanes — one per agent. Pre-render all in queued state so the
   * operator sees the planned shape of the crew immediately. */
  const lanes = new Map();
  for (const a of data.agents || []) {
    const lane = renderLane(a, "queued");
    lanes.set(a.id, lane);
    root.appendChild(lane);
  }
  /* Footer — cancel link + cost placeholder. */
  const foot = document.createElement("div");
  foot.className = "crew-panel-foot";
  const costSpan = document.createElement("span");
  costSpan.textContent = "—";
  foot.appendChild(costSpan);
  const cancel = document.createElement("a");
  cancel.className = "crew-panel-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    fetch("http://localhost:8766/cancel", { method: "POST" }).catch(() => {});
    cancel.textContent = "Cancelling…";
  });
  foot.appendChild(cancel);
  root.appendChild(foot);
  host.appendChild(root);
  _crewPanels.set(crewId, { root, lanes, costSpan, startedAt: Date.now() });
}

function renderLane(agent, status) {
  const lane = document.createElement("div");
  lane.className = "crew-lane";
  lane.dataset.agentId = agent.id;
  const row = document.createElement("div");
  row.className = "crew-lane-row";
  const statusEl = document.createElement("span");
  statusEl.className = `crew-lane-status is-${status}`;
  statusEl.textContent = status.toUpperCase();
  row.appendChild(statusEl);
  const role = document.createElement("span");
  role.className = "crew-lane-role";
  role.textContent = agent.role;
  row.appendChild(role);
  const provider = document.createElement("span");
  provider.className = "crew-lane-provider";
  provider.textContent = (agent.provider || "?").toUpperCase();
  row.appendChild(provider);
  lane.appendChild(row);
  const meta = document.createElement("div");
  meta.className = "crew-lane-meta";
  meta.textContent = "Queued…";
  lane.appendChild(meta);
  const tools = document.createElement("div");
  tools.className = "crew-lane-tools";
  lane.appendChild(tools);
  lane._refs = { statusEl, meta, tools };
  return lane;
}

function setLaneStatus(lane, status, metaText) {
  if (!lane?._refs) return;
  const { statusEl, meta } = lane._refs;
  statusEl.className = `crew-lane-status is-${status}`;
  statusEl.textContent = status.toUpperCase();
  if (metaText != null) meta.textContent = metaText;
}

function crewLanesOnAgentStart(data) {
  const panel = _crewPanels.get(data.crewId);
  if (!panel) return;
  const lane = panel.lanes.get(data.agentId);
  setLaneStatus(lane, "running", data.description || "Working…");
  lane._startedAt = Date.now();
}

function crewLanesOnAgentTool(data) {
  const panel = _crewPanels.get(data.crewId);
  if (!panel) return;
  const lane = panel.lanes.get(data.agentId);
  if (!lane) return;
  const chip = document.createElement("span");
  chip.className = "crew-lane-tool-chip";
  chip.textContent = data.tool;
  lane._refs.tools.appendChild(chip);
}

function crewLanesOnAgentComplete(data) {
  const panel = _crewPanels.get(data.crewId);
  if (!panel) return;
  const lane = panel.lanes.get(data.agentId);
  if (!lane) return;
  const cost = data.costUSD > 0 ? ` · $${data.costUSD.toFixed(4)}` : "";
  setLaneStatus(lane, "done", `${data.elapsedMs}ms${cost} · ${(data.output || "").slice(0, 80)}`);
}

function crewLanesOnAgentFailed(data) {
  const panel = _crewPanels.get(data.crewId);
  if (!panel) return;
  const lane = panel.lanes.get(data.agentId);
  setLaneStatus(lane, "failed", data.error?.slice(0, 120) || "failed");
}

function crewLanesOnComplete(data) {
  const panel = _crewPanels.get(data.crewId);
  if (!panel) return;
  /* Finalise footer — total cost + total elapsed. Then auto-fade after 6s
   * so the kiosk doesn't accumulate stale crew panels. Cancel link becomes
   * a "dismiss" link in case the operator wants to clear it sooner. */
  const cost = data.totalCostUSD > 0 ? `$${data.totalCostUSD.toFixed(4)}` : "free";
  panel.costSpan.textContent = `${data.successCount}/${data.taskCount} ok · ${data.totalElapsedMs}ms · ${cost}`;
  setTimeout(() => {
    panel.root.classList.add("is-fading");
    setTimeout(() => {
      panel.root.remove();
      _crewPanels.delete(data.crewId);
    }, 700);
  }, 6000);
}

/* ---------- COMMAND PALETTE (Cmd+K) ----------
 *  Spotlight-style palette over the HUD. Two modes:
 *    1. Free-text — operator types a sentence ("text Adam I'm running late"),
 *       Enter routes it through the same llm.askStream path as voice.
 *       Gets the operator parity with voice without a separate dispatch
 *       surface — same tool router, same NEEDS_CONFIRMATION gates, same
 *       persistence to conversation_turns.
 *    2. Tool browse — type "/" to switch. Filters the live /actions
 *       manifest by name/description. Selection prepopulates the input
 *       with a hint so the operator knows what to type next ("/text adam"
 *       → "text Adam ").
 *
 *  Why a palette on top of voice: noisy production studios kill mic
 *  recognition. A keyboard fallback that uses the same backend keeps the
 *  whole tool surface usable without rebuilding it. Cmd+K matches Linear,
 *  GitHub, Slack — universal palette shortcut.
 *
 *  Persistence: last 20 queries cached in localStorage so operators don't
 *  retype "draft an email to ben at..." every time. Up arrow walks history. */

let _paletteEl = null;
let _paletteHistory = [];

function loadPaletteHistory() {
  try { _paletteHistory = JSON.parse(localStorage.getItem("jarvis.paletteHistory") || "[]"); }
  catch { _paletteHistory = []; }
}
function savePaletteHistory() {
  try { localStorage.setItem("jarvis.paletteHistory", JSON.stringify(_paletteHistory.slice(0, 20))); } catch {}
}

function ensurePalette() {
  if (_paletteEl) return _paletteEl;
  loadPaletteHistory();
  const root = el("div", { id: "commandPalette" });
  root.hidden = true;
  const style = document.createElement("style");
  style.textContent = `
    #commandPalette { position: fixed; inset: 0; background: rgba(0,0,0,0.78); z-index: 10002; display: flex; align-items: flex-start; justify-content: center; padding-top: 18vh; font-family: var(--mono, "JetBrains Mono", monospace); }
    #commandPalette .cp-frame { background: #0b0b0b; border: 2px solid var(--accent); width: 720px; max-width: 92vw; max-height: 70vh; display: flex; flex-direction: column; box-shadow: 0 0 60px rgba(0,212,255,0.35); }
    #commandPalette .cp-prompt { padding: 14px 18px; border-bottom: 1px solid #1c1c1c; }
    #commandPalette input.cp-input { background: #000; color: #fff; border: 1px solid #2a2a2a; padding: 12px 14px; width: 100%; font-family: inherit; font-size: 16px; box-sizing: border-box; }
    #commandPalette input.cp-input:focus { outline: none; border-color: var(--accent); }
    #commandPalette .cp-mode { color: #888; font-size: 10px; letter-spacing: 0.16em; margin-top: 6px; text-transform: uppercase; }
    #commandPalette .cp-mode strong { color: var(--accent); }
    #commandPalette .cp-list { flex: 1; overflow-y: auto; padding: 6px 0; }
    #commandPalette .cp-item { padding: 8px 18px; cursor: pointer; display: grid; grid-template-columns: 200px 1fr; gap: 14px; align-items: baseline; color: #ddd; font-size: 12px; border-left: 2px solid transparent; }
    #commandPalette .cp-item:hover, #commandPalette .cp-item.is-active { background: rgba(0,212,255,0.08); border-left-color: var(--accent); }
    #commandPalette .cp-name { color: var(--accent); font-weight: 600; letter-spacing: 0.04em; }
    #commandPalette .cp-desc { color: #888; line-height: 1.4; }
    #commandPalette .cp-empty { color: #555; padding: 30px; text-align: center; font-size: 11px; }
    #commandPalette .cp-foot { color: #555; font-size: 9px; padding: 8px 18px; border-top: 1px solid #1c1c1c; letter-spacing: 0.1em; text-transform: uppercase; }
  `;
  root.appendChild(style);
  const frame = el("div", { className: "cp-frame" });
  const promptHost = el("div", { className: "cp-prompt" });
  const input = el("input", { className: "cp-input", attrs: { type: "text", placeholder: "Type a command — try 'text Adam I'm late' or '/' to browse tools", autocomplete: "off", spellcheck: "false" } });
  const modeEl = el("div", { className: "cp-mode" });
  modeEl.appendChild(document.createTextNode("Mode: "));
  const modeStrong = el("strong", { text: "FREE TEXT" });
  modeEl.appendChild(modeStrong);
  modeEl.appendChild(document.createTextNode(" · Enter to send · ↑/↓ history · / for tools · Esc to close"));
  promptHost.appendChild(input);
  promptHost.appendChild(modeEl);
  frame.appendChild(promptHost);
  const list = el("div", { className: "cp-list" });
  frame.appendChild(list);
  frame.appendChild(el("div", { className: "cp-foot", text: "Free-text routes through the voice loop. Tool browse types the name into the prompt." }));
  root.appendChild(frame);

  let activeIdx = 0;
  let mode = "free";        // "free" | "tools"
  let lastFiltered = [];    // what's currently rendered in tools mode
  let historyIdx = -1;

  function setMode(next) {
    mode = next;
    modeStrong.textContent = next === "tools" ? "TOOL BROWSE" : "FREE TEXT";
    while (list.firstChild) list.removeChild(list.firstChild);
    if (next === "tools") drawTools(input.value.replace(/^\//, ""));
  }

  function drawTools(filter) {
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!_helpManifest) {
      list.appendChild(el("div", { className: "cp-empty", text: "Loading tool catalogue…" }));
      return;
    }
    const q = (filter || "").trim().toLowerCase();
    const matched = _helpManifest.filter((a) => {
      if (!q) return true;
      return a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q);
    }).slice(0, 60);
    lastFiltered = matched;
    activeIdx = 0;
    if (!matched.length) {
      list.appendChild(el("div", { className: "cp-empty", text: `No tools matching "${q}".` }));
      return;
    }
    matched.forEach((a, i) => {
      const item = el("div", { className: "cp-item" + (i === 0 ? " is-active" : "") });
      item.appendChild(el("div", { className: "cp-name", text: a.name }));
      item.appendChild(el("div", { className: "cp-desc", text: (a.description || "").slice(0, 140) }));
      item.addEventListener("mousedown", (e) => { e.preventDefault(); selectTool(a); });
      list.appendChild(item);
    });
  }

  function selectTool(action) {
    /* When the operator picks a tool from browse mode, drop the leading "/"
     * and prefix the tool name as a verb the LLM will recognise. The
     * operator can append params naturally ("send_imessage to Adam Hello"). */
    const verb = action.name.replace(/^request_/, "").replace(/_/g, " ");
    input.value = `${verb} `;
    setMode("free");
    input.focus();
  }

  async function dispatchFreeText(text) {
    if (!text.trim()) return;
    /* Stash in history. Most-recent first; cap at 20. */
    _paletteHistory = [text, ..._paletteHistory.filter((q) => q !== text)].slice(0, 20);
    savePaletteHistory();
    historyIdx = -1;
    /* Close the palette before dispatch — the response shows up in the
     * normal transcript bubble + speedo states, not in the palette. */
    root.hidden = true;
    /* Use the same WebSocket path voice uses. The handleHeard() in voice.js
     * is the entry point; but it expects to be called from the wake/passive
     * loop. Instead we go straight to bridge-client's askStream — same
     * subscription pattern, no wake-word detection needed. */
    if (window.__paletteDispatch) {
      window.__paletteDispatch(text);
    } else {
      console.warn("[Jarvis] palette dispatch hook not wired");
    }
  }

  input.addEventListener("input", () => {
    if (input.value.startsWith("/")) {
      if (mode !== "tools") setMode("tools");
      else drawTools(input.value.replace(/^\//, ""));
    } else if (mode !== "free") {
      setMode("free");
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { root.hidden = true; return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (mode === "tools" && lastFiltered.length) {
        selectTool(lastFiltered[activeIdx]);
      } else {
        dispatchFreeText(input.value);
      }
      return;
    }
    if (mode === "tools") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, lastFiltered.length - 1);
        Array.from(list.children).forEach((c, i) => c.classList.toggle("is-active", i === activeIdx));
        list.children[activeIdx]?.scrollIntoView({ block: "nearest" });
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        Array.from(list.children).forEach((c, i) => c.classList.toggle("is-active", i === activeIdx));
        list.children[activeIdx]?.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    /* Free-text mode — up/down walks history. */
    if (e.key === "ArrowUp" && _paletteHistory.length) {
      e.preventDefault();
      historyIdx = Math.min(historyIdx + 1, _paletteHistory.length - 1);
      input.value = _paletteHistory[historyIdx] || "";
      input.setSelectionRange(input.value.length, input.value.length);
    }
    if (e.key === "ArrowDown" && historyIdx >= 0) {
      e.preventDefault();
      historyIdx -= 1;
      input.value = historyIdx >= 0 ? _paletteHistory[historyIdx] : "";
    }
  });

  root.addEventListener("click", (e) => { if (e.target === root) root.hidden = true; });
  document.body.appendChild(root);
  _paletteEl = root;
  root._refs = { input, modeStrong, list, setMode, drawTools };
  return root;
}

async function openPalette() {
  const root = ensurePalette();
  /* Pre-load tool manifest if we don't already have it from the help modal. */
  if (!_helpManifest) {
    try {
      const r = await fetch("http://localhost:8766/actions", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        _helpManifest = (j.actions || []).slice().sort((a, b) => a.name.localeCompare(b.name));
      }
    } catch {}
  }
  root._refs.input.value = "";
  root._refs.setMode("free");
  root.hidden = false;
  setTimeout(() => root._refs.input.focus(), 50);
}

/* ---------- PROFILE LOCK-SCREEN ----------
 *  When more than one profile exists in the registry AND the last operator
 *  activity is older than the lock threshold (default 30 min), show a
 *  full-screen profile picker on boot. This is the multi-operator scenario
 *  — agency kiosk shared by lead photographer / editor / MD, each with
 *  their own voice / colour / brand / audit identity. Single-profile
 *  installs never see this.
 *
 *  Why a lock-screen rather than a settings dropdown: the active profile
 *  drives the Storage namespace prefix, the brand colour, the identity in
 *  the audit log. Picking it should be the FIRST action of a session, not
 *  buried in a settings modal. The picker can be skipped by setting
 *  `jarvis.skipLockScreen = "1"` for a single-operator install.
 *
 *  Picker logic:
 *  - More than one profile registered (otherwise no point asking)
 *  - Last activity timestamp > 30 min ago (otherwise it's a quick reload —
 *    operator is already working, don't disrupt)
 *  - Skip if `jarvis.skipLockScreen` is set */

const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

async function maybeShowProfileLockScreen() {
  /* Read profiles + last-activity directly from localStorage to avoid an
   * import cycle with the ESM profiles.js module — boot order matters. */
  let profiles = [];
  try {
    const raw = localStorage.getItem("jarvis.profiles");
    profiles = raw ? JSON.parse(raw) : [];
  } catch {}
  if (!Array.isArray(profiles) || profiles.length < 2) return;
  if (localStorage.getItem("jarvis.skipLockScreen") === "1") return;
  const lastActivity = Number(localStorage.getItem("jarvis.lastActivity") || 0);
  if (lastActivity && (Date.now() - lastActivity) < LOCK_TIMEOUT_MS) return;
  /* Show the picker. Returns a promise that resolves when the operator picks
   * (or skips with the bypass shortcut). */
  await renderLockScreen(profiles);
}

function renderLockScreen(profiles) {
  return new Promise((resolve) => {
    const activeId = localStorage.getItem("jarvis.activeProfile") || "default";
    const root = el("div", { id: "lockScreen" });
    const style = document.createElement("style");
    style.textContent = `
      #lockScreen { position: fixed; inset: 0; background: #000; z-index: 11000; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: var(--mono, "JetBrains Mono", monospace); }
      #lockScreen h1 { color: var(--accent); margin: 0 0 6px; font-size: 22px; letter-spacing: 0.32em; text-transform: uppercase; }
      #lockScreen .ls-sub { color: #888; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; margin-bottom: 38px; }
      #lockScreen .ls-grid { display: flex; gap: 20px; flex-wrap: wrap; justify-content: center; max-width: 1080px; }
      #lockScreen .ls-card { background: #0b0b0b; border: 2px solid #1c1c1c; padding: 28px 32px; min-width: 220px; cursor: pointer; transition: transform 120ms ease, border-color 120ms ease; text-align: center; }
      #lockScreen .ls-card:hover, #lockScreen .ls-card.is-active { border-color: var(--accent); transform: translateY(-3px); box-shadow: 0 12px 40px rgba(0,212,255,0.35); }
      #lockScreen .ls-card .ls-name { color: #fff; font-size: 18px; letter-spacing: 0.1em; margin-bottom: 6px; }
      #lockScreen .ls-card .ls-id { color: #555; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; }
      #lockScreen .ls-card .ls-active-tag { color: var(--accent); font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; margin-top: 12px; }
      #lockScreen .ls-foot { color: #555; font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; margin-top: 38px; }
      #lockScreen .ls-foot a { color: #888; text-decoration: none; cursor: pointer; }
      #lockScreen .ls-foot a:hover { color: var(--accent); }
    `;
    root.appendChild(style);
    root.appendChild(el("h1", { text: "Who's at the wheel?" }));
    root.appendChild(el("div", { className: "ls-sub", text: "Pick your operator profile to begin the session" }));
    const grid = el("div", { className: "ls-grid" });
    for (const p of profiles) {
      const card = el("div", { className: "ls-card" });
      if (p.id === activeId) card.classList.add("is-active");
      card.appendChild(el("div", { className: "ls-name", text: p.name || p.id }));
      card.appendChild(el("div", { className: "ls-id", text: p.id }));
      if (p.id === activeId) card.appendChild(el("div", { className: "ls-active-tag", text: "Last session" }));
      card.addEventListener("click", () => choose(p.id));
      grid.appendChild(card);
    }
    root.appendChild(grid);
    /* Bypass link — useful for single-operator scenarios where the registry
     * happens to have stale entries. Sets the skip flag so it doesn't ask
     * again until the operator clears localStorage. */
    const foot = el("div", { className: "ls-foot" });
    const bypass = el("a", { text: "Skip this screen for next time" });
    bypass.addEventListener("click", () => {
      try { localStorage.setItem("jarvis.skipLockScreen", "1"); } catch {}
      cleanup();
      resolve();
    });
    foot.appendChild(bypass);
    root.appendChild(foot);
    document.body.appendChild(root);

    function cleanup() { root.remove(); }
    function choose(id) {
      try { localStorage.setItem("jarvis.activeProfile", id); } catch {}
      try { localStorage.setItem("jarvis.lastActivity", String(Date.now())); } catch {}
      /* Reload — Storage namespacing changes mean the safest path is a full
       * page reload rather than trying to re-init every module that already
       * read from localStorage. */
      cleanup();
      window.location.reload();
    }

    /* Keyboard support: ↓ / ↑ navigate, Enter selects. Default focus on
     * the active profile if any, otherwise the first card. */
    let idx = Math.max(0, profiles.findIndex((p) => p.id === activeId));
    const cards = grid.querySelectorAll(".ls-card");
    cards[idx]?.classList.add("is-active");
    function refocus() { cards.forEach((c, i) => c.classList.toggle("is-active", i === idx)); }
    document.addEventListener("keydown", function lockKey(e) {
      if (root.parentElement !== document.body) {
        document.removeEventListener("keydown", lockKey);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); idx = (idx + 1) % cards.length; refocus(); }
      if (e.key === "ArrowLeft"  || e.key === "ArrowUp"  ) { e.preventDefault(); idx = (idx - 1 + cards.length) % cards.length; refocus(); }
      if (e.key === "Enter") { e.preventDefault(); choose(profiles[idx].id); }
    });
  });
}

/* Track activity on any keypress / click so the lock-screen knows when to
 * stay quiet on a quick reload vs pop on a fresh session. */
function bumpActivity() {
  try { localStorage.setItem("jarvis.lastActivity", String(Date.now())); } catch {}
}
document.addEventListener("keydown", bumpActivity, { capture: true, passive: true });
document.addEventListener("click", bumpActivity, { capture: true, passive: true });

/* Cmd+K (Ctrl+K elsewhere) toggles the palette. */
document.addEventListener("keydown", (e) => {
  const tag = (e.target?.tagName || "").toLowerCase();
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
    /* Allow opening from inside an input — the palette IS an input, no point
     * making the operator click out first. */
    e.preventDefault();
    if (_paletteEl && !_paletteEl.hidden) {
      _paletteEl.hidden = true;
    } else {
      openPalette();
    }
  }
});

/* ---------- HISTORY DRAWER (H) ----------
 *  Slide-out from the right edge listing every conversation turn the bridge
 *  has persisted (conversation_turns table — populated by askLLM and
 *  askLLMStream). Each row: timestamp, role badge (HEARD / JARVIS), the
 *  content, plus chips for any tools that fired during that turn.
 *
 *  Why a drawer not a modal: history is something the operator skims while
 *  Jarvis stays operational behind it. Modals stop the world; the drawer
 *  lets the speedometer keep ticking and the wake mic stay live.
 *
 *  H key opens / closes (operator-input guarded same as ?). Escape closes. */

let _historyDrawerEl = null;
let _historyTurnsCache = null;

function ensureHistoryDrawer() {
  if (_historyDrawerEl) return _historyDrawerEl;
  const root = el("aside", { id: "historyDrawer" });
  root.hidden = true;
  const style = document.createElement("style");
  style.textContent = `
    #historyDrawer { position: fixed; top: 0; right: 0; bottom: 0; width: 480px; max-width: 95vw; background: #050505; border-left: 2px solid var(--accent); z-index: 9998; display: flex; flex-direction: column; font-family: var(--mono, "JetBrains Mono", monospace); transform: translateX(0); transition: transform 220ms ease; box-shadow: -10px 0 40px rgba(0,0,0,0.6); }
    #historyDrawer[hidden] { display: flex; transform: translateX(110%); pointer-events: none; }
    #historyDrawer .hd-head { padding: 18px 22px 10px; border-bottom: 1px solid #1c1c1c; }
    #historyDrawer h2 { color: var(--accent); margin: 0 0 4px; font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; }
    #historyDrawer .hd-sub { color: #888; font-size: 10px; margin-bottom: 12px; }
    #historyDrawer input.hd-search { background: #000; color: #fff; border: 1px solid #2a2a2a; padding: 8px 10px; width: 100%; font-family: inherit; font-size: 12px; box-sizing: border-box; }
    #historyDrawer input.hd-search:focus { outline: none; border-color: var(--accent); }
    #historyDrawer .hd-list { flex: 1; overflow-y: auto; padding: 8px 18px 18px; }
    #historyDrawer .hd-turn { padding: 10px 0; border-bottom: 1px dashed #1a1a1a; }
    #historyDrawer .hd-turn:last-child { border-bottom: none; }
    #historyDrawer .hd-meta { display: flex; gap: 8px; align-items: baseline; font-size: 9px; letter-spacing: 0.1em; color: #555; margin-bottom: 4px; text-transform: uppercase; }
    #historyDrawer .hd-role { color: var(--accent); font-weight: 700; }
    #historyDrawer .hd-role.user { color: #ccc; }
    #historyDrawer .hd-content { color: #ddd; font-size: 12px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
    #historyDrawer .hd-tools { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
    #historyDrawer .hd-tool-chip { background: rgba(0,212,255,0.12); color: var(--accent); border: 1px solid rgba(0,212,255,0.3); font-size: 9px; padding: 1px 6px; letter-spacing: 0.08em; }
    #historyDrawer .hd-empty { color: #555; padding: 32px 0; text-align: center; font-size: 11px; }
    #historyDrawer .hd-footer { color: #555; font-size: 9px; padding: 8px 22px; border-top: 1px solid #1c1c1c; letter-spacing: 0.08em; text-transform: uppercase; }
  `;
  root.appendChild(style);

  const head = el("div", { className: "hd-head" });
  head.appendChild(el("h2", { text: "Conversation history" }));
  const sub = el("div", { className: "hd-sub", text: "Recent turns from this and previous sessions." });
  head.appendChild(sub);
  const search = el("input", { className: "hd-search", attrs: { type: "text", placeholder: "Filter — try a name, project, tool…", autocomplete: "off" } });
  head.appendChild(search);
  root.appendChild(head);
  const list = el("div", { className: "hd-list" });
  root.appendChild(list);
  root.appendChild(el("div", { className: "hd-footer", text: "H or Esc to close · turns saved across reloads" }));

  document.body.appendChild(root);
  _historyDrawerEl = root;
  root._refs = { search, list, sub };
  search.addEventListener("input", () => renderHistoryList(root, search.value));
  search.addEventListener("keydown", (e) => { if (e.key === "Escape") root.hidden = true; });
  return root;
}

function renderHistoryList(root, filter = "") {
  const { list, sub } = root._refs;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!_historyTurnsCache) {
    list.appendChild(el("div", { className: "hd-empty", text: "Loading…" }));
    return;
  }
  const q = filter.trim().toLowerCase();
  const matches = _historyTurnsCache.filter((t) => {
    if (!q) return true;
    if ((t.content || "").toLowerCase().includes(q)) return true;
    if ((t.tools || []).some((tool) => tool.toLowerCase().includes(q))) return true;
    return false;
  });
  sub.textContent = `${matches.length} of ${_historyTurnsCache.length} turns${q ? ` matching "${q}"` : ""}`;
  if (!matches.length) {
    list.appendChild(el("div", { className: "hd-empty", text: q ? `No turns matching "${filter}".` : "No conversation history yet — say something to Jarvis." }));
    return;
  }
  /* Render newest first (the bridge already sorts that way). */
  const currentSession = (() => { try { return localStorage.getItem("jarvis.sessionId"); } catch { return null; } })();
  for (const t of matches) {
    const row = el("div", { className: "hd-turn" });
    const meta = el("div", { className: "hd-meta" });
    const ts = new Date(t.ts);
    const mark = ts.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const date = ts.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const roleLabel = t.role === "assistant" ? "JARVIS" : "HEARD";
    const roleSpan = el("span", { className: `hd-role ${t.role === "user" ? "user" : ""}`, text: roleLabel });
    meta.appendChild(roleSpan);
    meta.appendChild(el("span", { text: `${date} ${mark}` }));
    if (t.sessionId === currentSession) meta.appendChild(el("span", { text: "this session" }));
    row.appendChild(meta);
    row.appendChild(el("div", { className: "hd-content", text: t.content }));
    if (t.tools && t.tools.length) {
      const chips = el("div", { className: "hd-tools" });
      for (const tool of t.tools) chips.appendChild(el("span", { className: "hd-tool-chip", text: tool }));
      row.appendChild(chips);
    }
    list.appendChild(row);
  }
}

async function openHistoryDrawer() {
  const root = ensureHistoryDrawer();
  root.hidden = false;
  setTimeout(() => root._refs.search.focus(), 60);
  /* Always re-fetch on open — turns accumulate while the drawer was closed.
   * 200 turns is plenty for a typical week of use; cheap to grab fresh. */
  try {
    const r = await fetch("http://localhost:8766/history?limit=200", { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      _historyTurnsCache = j.turns || [];
    } else {
      _historyTurnsCache = [];
    }
  } catch { _historyTurnsCache = []; }
  renderHistoryList(root, root._refs.search.value || "");
}

document.addEventListener("keydown", (e) => {
  /* Cmd/Ctrl+H toggles the history drawer. Modifier-gated per the unified
   * shortcut policy so bare H never gets eaten when typing in the text
   * input modal. preventDefault stops macOS hide-app from also firing. */
  if ((e.metaKey || e.ctrlKey) && (e.key === "h" || e.key === "H")) {
    e.preventDefault();
    if (_historyDrawerEl && !_historyDrawerEl.hidden) {
      _historyDrawerEl.hidden = true;
    } else {
      openHistoryDrawer();
    }
  }
  if (e.key === "Escape" && _historyDrawerEl && !_historyDrawerEl.hidden) {
    _historyDrawerEl.hidden = true;
  }
});

/* ---------- FIRST-RUN ONBOARDING TIPS ----------
 *  Tiny cheat panel pinned to the bottom-left for ~60 seconds the FIRST
 *  time a profile loads the HUD. Lists 6-8 voice commands worth trying
 *  so the operator (or a visiting team member) discovers what's possible
 *  without reading docs. Dismissed by:
 *    - Auto-fade after 60s
 *    - Click anywhere on the panel
 *    - Esc
 *    - Detection of any wake-word activity (operator's gone past
 *      "discovery" mode — the panel becomes noise)
 *
 *  Persists a per-profile flag in localStorage so it never re-appears for
 *  the same operator. Each profile gets its own onboarding (a new operator
 *  on a shared kiosk gets the panel even if Adam's seen it before).
 *
 *  Why pinned bottom-left rather than a centred modal: discovery should
 *  whisper, not interrupt. Operator can ignore it and use the kiosk
 *  normally; the panel hangs around in the corner as a reference. */

const ONBOARDING_TIPS = [
  { say: '"Hey Jarvis, what\'s in the diary today?"',  why: "Today's calendar — get_upcoming_events" },
  { say: '"Open Google Maps for Manchester."',           why: "Fast URL launcher — open_url" },
  { say: '"Text Adam I\'ll be ten minutes late."',       why: "iMessage with confirmation gate" },
  { say: '"Set a 25-minute timer for the chicken."',     why: "In-HUD countdown + chime" },
  { say: '"Find me a 50mm prime under £400 on WEX."',    why: "Vision-driven product browse" },
  { say: '"Summarise my day."',                          why: "End-of-day activity digest" },
  { say: '"Shut down."',                                  why: "Mutes mic + dims HUD" },
];

const ONBOARDING_KEY_PREFIX = "jarvis.onboardingSeen.";

function shouldShowOnboarding() {
  try {
    const profileId = localStorage.getItem("jarvis.activeProfile") || "default";
    return localStorage.getItem(ONBOARDING_KEY_PREFIX + profileId) !== "1";
  } catch { return false; }
}

function markOnboardingSeen() {
  try {
    const profileId = localStorage.getItem("jarvis.activeProfile") || "default";
    localStorage.setItem(ONBOARDING_KEY_PREFIX + profileId, "1");
  } catch {}
}

function maybeShowOnboarding() {
  if (!shouldShowOnboarding()) return;
  /* Defer to next tick so the rest of boot has finished mounting — we don't
   * want the panel painting before the HUD's actual chrome. */
  setTimeout(renderOnboarding, 800);
}

function renderOnboarding() {
  const root = document.createElement("div");
  root.id = "onboardingTips";
  const style = document.createElement("style");
  style.textContent = `
    #onboardingTips { position: fixed; bottom: 18px; left: 18px; z-index: 9990; background: rgba(11, 11, 11, 0.92); border: 1px solid var(--accent); padding: 14px 18px 12px; max-width: 360px; font-family: var(--mono, "JetBrains Mono", monospace); cursor: pointer; box-shadow: 0 0 30px rgba(0, 212, 255, 0.22); animation: onboardingSlide 320ms ease forwards; }
    #onboardingTips.is-fading { opacity: 0; transition: opacity 600ms ease; }
    @keyframes onboardingSlide { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    #onboardingTips h4 { color: var(--accent); margin: 0 0 4px; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; }
    #onboardingTips .obt-sub { color: #888; font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 10px; }
    #onboardingTips .obt-row { padding: 4px 0; border-bottom: 1px dashed #1a1a1a; }
    #onboardingTips .obt-row:last-child { border-bottom: none; }
    #onboardingTips .obt-say { color: #eee; font-size: 11px; line-height: 1.4; }
    #onboardingTips .obt-why { color: #555; font-size: 9px; letter-spacing: 0.06em; }
    #onboardingTips .obt-foot { color: #555; font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase; margin-top: 10px; padding-top: 8px; border-top: 1px solid #1a1a1a; }
  `;
  root.appendChild(style);
  const h = document.createElement("h4"); h.textContent = "Try saying"; root.appendChild(h);
  const sub = document.createElement("div"); sub.className = "obt-sub"; sub.textContent = "First-run cheat sheet · click to dismiss"; root.appendChild(sub);
  for (const tip of ONBOARDING_TIPS) {
    const row = document.createElement("div"); row.className = "obt-row";
    const say = document.createElement("div"); say.className = "obt-say"; say.textContent = tip.say; row.appendChild(say);
    const why = document.createElement("div"); why.className = "obt-why"; why.textContent = tip.why; row.appendChild(why);
    root.appendChild(row);
  }
  const foot = document.createElement("div"); foot.className = "obt-foot"; foot.textContent = "Press ? anytime for the full command catalogue."; root.appendChild(foot);
  document.body.appendChild(root);

  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    markOnboardingSeen();
    root.classList.add("is-fading");
    setTimeout(() => root.remove(), 700);
    document.removeEventListener("keydown", onKey, true);
  }
  function onKey(e) {
    if (e.key === "Escape") dismiss();
  }
  root.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKey, true);
  /* Auto-fade after 60s. Operator who hasn't engaged by then has either
   * already moved on or doesn't need the prompt. */
  setTimeout(dismiss, 60_000);
}

/* ---------- BOOT ---------- */
async function boot() {
  /* Multi-operator profile lock-screen — only renders if the registry has
   * more than one profile AND the kiosk's been idle longer than the lock
   * timeout. Returns immediately on single-profile installs. Awaited so a
   * profile switch (which reloads the page) doesn't race with the rest of
   * boot. */
  await maybeShowProfileLockScreen();
  /* First-run onboarding tips — per-profile. Quiet pinned panel; never shown
   * twice for the same operator. */
  maybeShowOnboarding();
  /* 90-second guided tour — only fires after the setup wizard has been
   * completed AND the operator has never seen the tour. Wires into
   * voice.js's onQueryHandled bus so step matching reacts to actual
   * spoken queries. Lazy subscription — Tour.init receives a function
   * that returns the subscriber, so the tour module doesn't import
   * voice.js itself (avoids a module cycle). */
  Tour.init({ getQuerySubscriber: () => Voice.onQueryHandled });
  /* Workspace switcher — must init AFTER bridge-client is connected since
   * it pulls /workspaces on bootstrap. The Bridge.connect() call earlier in
   * boot guarantees the WS is connecting; the chip's bootstrap fetch is
   * over plain HTTP so it doesn't actually wait on the WS. */
  WorkspaceSwitcher.init();
  /* Smart Inbox panel — polls /inbox every 5min for the workspace-aware
   * "what should I look at" surface. Voice command "brief me" still
   * fires the briefing tool independently; the panel is the visual
   * always-on reminder that operators can spot at a glance. */
  Inbox.init();

  /* Centerpiece picker. Default = "reactor" (existing SVG instrument
   * cluster). Operators who pick "orb" via Settings → Centerpiece get
   * the Three.js audio-reactive particle sphere instead. The orb mounts
   * INSIDE the .speedo container so it inherits the layout slot the
   * SVG previously owned; the SVG fades to transparent when the orb is
   * active so the centerpiece swap is visually clean.
   *
   * The orb dynamically imports Three.js from CDN, so operators on the
   * reactor preset never pay the network round-trip. */
  initCenterpiece();
  /* Slight delay so the tour mounts after the setup modal has fully
   * dismissed (if the operator just finished setup). */
  setTimeout(() => { Tour.maybeStart(); }, 600);
  /* buildTicks/buildNumerals belonged to the rev-gauge centerpiece — the
   * white-label rebuild dropped the 0–200 RPM scale + needle for a clean
   * arc reactor, so neither generator runs. */
  // buildTicks();
  // buildNumerals();
  renderCalendar();
  /* Why: don't paint a mocked forecast at boot. The mock built 3-child <li>
   * rows (day/hi/lo) but applyWeather builds 4-child rows (icon/day/hi/lo)
   * so the CSS grid (22px 1fr auto auto) squashes "TOMORROW" into the 22px
   * icon column on first paint, visually colliding with the high temp.
   * Leave the forecast empty — applyWeather populates it sub-second once
   * the bridge weather reply lands. */
  setMonthRing();
  tickClock();
  setInterval(tickClock, 1000);
  startStatsFallback();
  startWaveform();
  startIdleNeedle();
  wireLauncher();
  wireFullscreen();
  wireCamera();
  connectBridge();             // live stats + weather + LLM proxy
  _buildICScaffold();          // Instrument-cluster geometry — eagerly built so the
                                // calibration ticks + voice waveform are visible
                                // before the first /stats payload arrives.
  _startVoiceWave();           // 60fps voice-waveform RAF loop (idle drift + mic RMS)
  startCommsPoll();            // dynamic COMMS panel (mail / frame.io / leads / latest shoot)
  startHealthPoll();           // service-health pips top-right of calendar strip
  startDiaryPoll();             // dynamic DIARY widget (today's calendar in the clock panel)
  bindDiaryRefreshHook();       // instant refresh when bridge writes via add_calendar_event
}

document.addEventListener("DOMContentLoaded", boot);
