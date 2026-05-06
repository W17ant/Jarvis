/** hud.js - Flat-Out HUD: drives clock, calendar, speedo decorations, gauges, telemetry waveform.
 *  All values here are demo-realistic mocks. Phase 2 wires real data from jarvis backend. */

import * as Storage from "./storage.js";

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

  $("dayNumber").textContent = String(now.getDate()).padStart(2, "0");
  $("monthName").textContent = now.toLocaleDateString("en-GB", { month: "long" }).toUpperCase();
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

function buildTicks() {
  const g = document.getElementById("speedoTicks");
  if (!g) return;
  const { cx, cy, r, startAngle, endAngle, majorEvery, redZoneFrom, max } = SPEEDO_CFG;
  const sweep = endAngle - startAngle;
  for (let i = 0; i <= max; i++) {
    const t = i / max;
    const a = deg2rad(startAngle + sweep * t);
    const isMajor = i % majorEvery === 0;
    const isRed = i >= redZoneFrom;
    const tickLen = isMajor ? 18 : 8;
    const x1 = cx + Math.cos(a) * r;
    const y1 = cy + Math.sin(a) * r;
    const x2 = cx + Math.cos(a) * (r - tickLen);
    const y2 = cy + Math.sin(a) * (r - tickLen);
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    let cls = "speedo__tick";
    if (isMajor) cls += " speedo__tick--major";
    if (isRed) cls += " speedo__tick--red";
    line.setAttribute("class", cls);
    line.setAttribute("stroke-width", isMajor ? 2.5 : 1.2);
    g.appendChild(line);
  }
}

function buildNumerals() {
  const g = document.getElementById("speedoNumerals");
  if (!g) return;
  const { cx, cy, r, startAngle, endAngle, majorEvery, redZoneFrom, max } = SPEEDO_CFG;
  const sweep = endAngle - startAngle;
  const nr = r - 38;
  for (let i = 0; i <= max; i += majorEvery) {
    const t = i / max;
    const a = deg2rad(startAngle + sweep * t);
    const x = cx + Math.cos(a) * nr;
    const y = cy + Math.sin(a) * nr + 4;
    const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
    txt.setAttribute("x", x); txt.setAttribute("y", y);
    txt.setAttribute("text-anchor", "middle");
    txt.setAttribute("class", i >= redZoneFrom ? "speedo__numeral speedo__numeral--red" : "speedo__numeral");
    txt.textContent = String(i);
    g.appendChild(txt);
  }
}

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
 * Falls back to mocked data if bridge isn't running so the demo still looks alive. */
const BRIDGE_URL = "ws://localhost:8766";
let bridgeWS = null;
let lastStatsTs = 0;

/** Sets a half-arc gauge by id from a 0..100 percentage. Reused for CPU / GPU / RAM. */
function setArcGauge(id, pct) {
  const fill = document.getElementById(id);
  if (!fill) return;
  const p = Math.max(0, Math.min(100, pct || 0));
  fill.style.strokeDashoffset = CPU_ARC_LEN * (1 - p / 100);
}

function applyLiveStats(s) {
  lastStatsTs = Date.now();
  setCpuGauge(s.cpu);

  /* GPU panel — usage % drives the arc; thermal pressure drives the small sub-label colour. */
  if (s.gpu) {
    const pct = s.gpu.usagePct;
    setArcGauge("gpuArc", pct);
    if ($("gpuValue")) $("gpuValue").textContent = pct == null ? "— %" : `${pct} %`;
    const therm = $("gpuTherm");
    if (therm) {
      therm.textContent = (s.gpu.thermal || "—").toUpperCase();
      therm.classList.remove("is-light", "is-moderate", "is-heavy");
      if (s.gpu.thermal === "light")    therm.classList.add("is-light");
      if (s.gpu.thermal === "moderate") therm.classList.add("is-moderate");
      if (s.gpu.thermal === "heavy")    therm.classList.add("is-heavy");
    }
    if ($("gpuMemValue") && s.gpu.allocGB != null) {
      $("gpuMemValue").textContent = `${s.gpu.allocGB} GB`;
    }
  }

  if (s.mem) {
    const ramPct = (s.mem.usedGB / Math.max(1, s.mem.totalGB)) * 100;
    setArcGauge("ramArc", ramPct);
    /* Why: the round dial only has room for ~4 chars at 14px. Show used GB rounded
     * (the arc fill already encodes the percentage visually) — "57G" beats "56.9 / 69 GB"
     * for at-a-glance readability in the small pod. */
    $("ramValue").textContent = `${Math.round(s.mem.usedGB)}G`;
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

function connectBridge() {
  try {
    bridgeWS = new WebSocket(BRIDGE_URL);
  } catch (e) { return; }

  bridgeWS.addEventListener("open", () => {
    console.log("[Flat-Out HUD] bridge connected");
    bridgeWS.send(JSON.stringify({ id: "weather-init", type: "weather", payload: {} }));
  });

  bridgeWS.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "stats") applyLiveStats(m.data);
    if (m.type === "weather.reply") applyWeather(m.data);
    /* Patch B: typed-confirm modal for £25-30 purchases. The LLM can't authorise
     * these — the operator must type the exact amount. We mount the modal on
     * first event so the DOM cost is zero until a typed-tier purchase happens. */
    if (m.type === "purchase.typed_confirm.required") openPurchaseTypedConfirm(m.data);
    if (m.type === "purchase.recorded") flashPurchaseAuditBadge(m.data);
  });

  bridgeWS.addEventListener("close", () => {
    console.warn("[Flat-Out HUD] bridge disconnected, retrying in 3s");
    setTimeout(connectBridge, 3000);
  });

  bridgeWS.addEventListener("error", () => { /* close handler will retry */ });
}

/** Fallback: if bridge hasn't sent stats in the last 4s, drift the gauge so HUD doesn't freeze. */
function startStatsFallback() {
  let cpu = 28;
  setInterval(() => {
    if (Date.now() - lastStatsTs < 4000) return;
    cpu += (Math.random() - 0.5) * 6;
    cpu = Math.max(8, Math.min(82, cpu));
    setCpuGauge(cpu);
  }, 1500);
}

/** Apply real weather from bridge. WMO weather codes drive both the short label
 *  AND the matching Bybas weather icon. Forecast rows now carry a per-day icon. */
function applyWeather(w) {
  if (!w || w.error) return;
  const day = isDaytimeNow();
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
        console.warn(`[Flat-Out] weather icon failed: ${iconName}.svg — falling back to cloudy.svg`);
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
    console.log("[Flat-Out HUD] camera mode 'off' — skipping getUserMedia");
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
    console.warn("[Flat-Out HUD] camera unavailable:", e.message);
    cam.style.display = "none";
    return;
  }
  // Lite tier: skip MediaPipe entirely (CSS rotation animation handles the reticle)
  if (tier.faceFps === 0) {
    console.log("[Flat-Out HUD] face tracking disabled by tier");
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
    console.log("[Flat-Out HUD] face detector ready");
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
    console.warn("[Flat-Out HUD] face detector unavailable, using CSS reticle:", e.message);
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
    console.warn("[Flat-Out HUD] launcher fetch failed, using fallback:", e.message);
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
      console.log(`[Flat-Out HUD] launch request: ${app}`);
      try {
        const r = await fetch("http://localhost:8766/launch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ app }),
        });
        const j = await r.json();
        if (!j.ok) console.warn("[Flat-Out HUD] launch failed:", j.error);
      } catch (e) { console.warn("[Flat-Out HUD] launch fetch failed:", e.message); }
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
  try {
    const r = await fetch("http://localhost:8766/healthz", { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    services = j.services || {};
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
 * { type: "diary.refresh" } so the HUD updates immediately. We hook into the same
 * websocket the live-stats use rather than opening a second connection. */
function bindDiaryRefreshHook() {
  if (!bridgeWS) { setTimeout(bindDiaryRefreshHook, 500); return; }
  bridgeWS.addEventListener("message", (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (m && m.type === "diary.refresh") pollDiary();
    } catch {}
  });
}

/* ---------- FULLSCREEN: press F to toggle, double-click speedo also toggles ----------
 * Why: requestFullscreen must come from a user gesture, so we hook keypress + dblclick. */
function wireFullscreen() {
  const toggle = async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (e) { console.warn("[Flat-Out HUD] fullscreen blocked:", e.message); }
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") toggle();
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
    #purchaseConfirmModal .pcm-frame { background: #0b0b0b; border: 2px solid var(--brand-primary, #ff3b3b); padding: 32px 36px; min-width: 460px; max-width: 600px; box-shadow: 0 0 60px rgba(255,59,59,0.35); }
    #purchaseConfirmModal h2 { color: var(--brand-primary, #ff3b3b); margin: 0 0 16px; font-size: 14px; letter-spacing: 0.16em; text-transform: uppercase; }
    #purchaseConfirmModal .pcm-row { color: #eaeaea; margin: 6px 0; font-size: 13px; }
    #purchaseConfirmModal .pcm-row strong { color: #fff; font-weight: 600; }
    #purchaseConfirmModal .pcm-amount { font-size: 28px; color: var(--brand-primary, #ff3b3b); margin: 18px 0 6px; letter-spacing: 0.04em; }
    #purchaseConfirmModal .pcm-hint { color: #888; font-size: 11px; margin-bottom: 12px; }
    #purchaseConfirmModal input { background: #000; color: #fff; border: 1px solid #333; padding: 10px 12px; width: 100%; font-family: inherit; font-size: 18px; box-sizing: border-box; }
    #purchaseConfirmModal input:focus { outline: none; border-color: var(--brand-primary, #ff3b3b); }
    #purchaseConfirmModal .pcm-error { color: var(--brand-primary, #ff3b3b); font-size: 12px; min-height: 16px; margin: 8px 0; }
    #purchaseConfirmModal .pcm-buttons { display: flex; gap: 12px; margin-top: 16px; }
    #purchaseConfirmModal button { flex: 1; padding: 12px; background: #181818; color: #fff; border: 1px solid #333; cursor: pointer; font-family: inherit; font-size: 12px; letter-spacing: 0.12em; text-transform: uppercase; }
    #purchaseConfirmModal button.primary { background: var(--brand-primary, #ff3b3b); color: #000; border-color: var(--brand-primary, #ff3b3b); font-weight: 700; }
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

/** Brief audit badge — appears in the corner for ~5s every time a purchase
 *  request was settled or rejected. Lets the operator catch the LLM trying
 *  things in the background without staring at a log. */
function flashPurchaseAuditBadge(data) {
  let host = document.getElementById("purchaseAuditBadge");
  if (!host) {
    host = document.createElement("div");
    host.id = "purchaseAuditBadge";
    host.style.cssText = "position:fixed;right:18px;bottom:18px;background:#0a0a0a;border:1px solid var(--brand-primary,#ff3b3b);color:#eaeaea;padding:10px 14px;font-family:var(--mono,monospace);font-size:11px;letter-spacing:0.08em;z-index:9999;max-width:340px;box-shadow:0 0 24px rgba(255,59,59,0.25);transition:opacity 250ms;";
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
    #agentModal .am-frame { background: #0b0b0b; border: 2px solid var(--brand-primary, #ff3b3b); padding: 28px 32px; width: 720px; max-width: 92vw; max-height: 86vh; overflow-y: auto; box-shadow: 0 0 60px rgba(255,59,59,0.3); }
    #agentModal h2 { color: var(--brand-primary, #ff3b3b); margin: 0 0 4px; font-size: 14px; letter-spacing: 0.18em; text-transform: uppercase; }
    #agentModal .am-sub { color: #888; font-size: 11px; margin-bottom: 24px; }
    #agentModal h3 { color: #fff; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; margin: 22px 0 10px; padding-top: 14px; border-top: 1px solid #1f1f1f; }
    #agentModal h3:first-of-type { padding-top: 0; border-top: none; margin-top: 0; }
    #agentModal label { display: block; color: #ccc; font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 4px; }
    #agentModal input, #agentModal select { background: #000; color: #fff; border: 1px solid #2a2a2a; padding: 8px 10px; width: 100%; font-family: inherit; font-size: 12px; box-sizing: border-box; margin-bottom: 10px; }
    #agentModal input:focus, #agentModal select:focus { outline: none; border-color: var(--brand-primary, #ff3b3b); }
    #agentModal .am-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    #agentModal .am-row.two { grid-template-columns: 1fr 1fr; }
    #agentModal .am-status { font-size: 10px; color: #777; margin: 0 0 8px; min-height: 14px; }
    #agentModal .am-status.ok { color: #00ff88; }
    #agentModal .am-status.err { color: var(--brand-primary, #ff3b3b); }
    #agentModal .am-buttons { display: flex; gap: 12px; justify-content: flex-end; margin-top: 18px; }
    #agentModal button { padding: 10px 20px; background: #181818; color: #fff; border: 1px solid #333; cursor: pointer; font-family: inherit; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; }
    #agentModal button.primary { background: var(--brand-primary, #ff3b3b); color: #000; border-color: var(--brand-primary, #ff3b3b); font-weight: 700; }
    #agentModal button:hover { filter: brightness(1.18); }
    #agentModal .am-journal { max-height: 240px; overflow-y: auto; background: #050505; border: 1px solid #1c1c1c; padding: 10px 12px; }
    #agentModal .am-journal-row { color: #ccc; font-size: 11px; padding: 4px 0; border-bottom: 1px dashed #1a1a1a; display: grid; grid-template-columns: 56px 70px 1fr 70px; gap: 8px; align-items: baseline; }
    #agentModal .am-journal-row:last-child { border-bottom: none; }
    #agentModal .am-journal-row .verb { font-weight: 700; letter-spacing: 0.08em; }
    #agentModal .am-journal-row .verb.ok { color: #00ff88; }
    #agentModal .am-journal-row .verb.sim { color: #ffaa00; }
    #agentModal .am-journal-row .verb.bad { color: var(--brand-primary, #ff3b3b); }
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

  /* Section 3: purchase audit */
  frame.appendChild(el("h3", { text: "Purchase audit log" }));
  const journalHost = el("div", { className: "am-journal" });
  const summaryEl = el("div", { className: "am-summary", text: "Loading…" });
  frame.appendChild(journalHost);
  frame.appendChild(summaryEl);

  root.appendChild(frame);
  root._refs = { keyAnthropic, keyOpenai, routeDefault, routeVision, routeHighstakes, status, cancelBtn, saveBtn, journalHost, summaryEl };
  document.body.appendChild(root);
  _agentModalEl = root;

  cancelBtn.addEventListener("click", () => { root.hidden = true; });
  root.addEventListener("click", (e) => { if (e.target === root) root.hidden = true; });
  saveBtn.addEventListener("click", () => saveAgentModal(root));

  return root;
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
  const { keyAnthropic, keyOpenai, routeDefault, routeVision, routeHighstakes, status, journalHost, summaryEl } = root._refs;
  status.textContent = ""; status.className = "am-status";
  keyAnthropic.value = ""; keyOpenai.value = "";
  root.hidden = false;
  /* Fetch current state in parallel — keys + audit. Bridge offline → leave
   * placeholders + an empty journal with a clear hint. */
  try {
    const [keysRes, auditRes] = await Promise.all([
      fetch("http://localhost:8766/api-keys", { cache: "no-store" }),
      fetch("http://localhost:8766/purchases/audit?limit=50", { cache: "no-store" }),
    ]);
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

/* ---------- BOOT ---------- */
function boot() {
  buildTicks();
  buildNumerals();
  renderCalendar();
  renderWeather();             // initial mocked forecast — replaced when bridge weather arrives
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
  startCommsPoll();            // dynamic COMMS panel (mail / frame.io / leads / latest shoot)
  startHealthPoll();           // service-health pips top-right of calendar strip
  startDiaryPoll();             // dynamic DIARY widget (today's calendar in the clock panel)
  bindDiaryRefreshHook();       // instant refresh when bridge writes via add_calendar_event
}

document.addEventListener("DOMContentLoaded", boot);
