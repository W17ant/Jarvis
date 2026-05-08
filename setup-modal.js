/** setup-modal.js - First-run setup modal + the "saved" preference accessors.
 *
 *  Shown on the very first kiosk launch (or after localStorage is cleared)
 *  to walk the operator through: location confirm, voice pick, mic pick,
 *  agency name, performance tier. Once dismissed, the SETUP_DONE_KEY flag
 *  prevents it from re-showing.
 *
 *  Also exports the per-profile preference getters that other modules use:
 *    loadSavedVoice / getSavedAgency / getSavedTier / getTierPreset.
 *  These read the SAME profile-namespaced Storage keys as the settings
 *  modal — kept here because they're the read-side mirror of what the
 *  setup modal writes.
 *
 *  Dependencies it can't compute itself:
 *    autoPickMic / getPreferredDeviceId / setPreferredDevice — voice.js
 *      owns the mic device-selection layer.
 *    wf — the waveform state object (mic stream, analyser). The mic-picker
 *      change handler clears wf.micStream so the next wfStartListening
 *      call re-acquires with the freshly-picked device.
 *
 *  Deps come in via init() so this module doesn't reach back into voice.js
 *  module-globals.
 */

import * as Storage from "./storage.js";

const SETUP_DONE_KEY = "setupDone";
const VOICE_KEY = "voice";
const AGENCY_KEY = "agency";
const TIER_KEY = "tier";

/** Performance tier presets — readonly, consumed by HUD throttles. */
const TIER_PRESETS = {
  lite:     { faceFps: 0,  waveFps: 30, animateArcs: false, dropShadows: false, camRes: 240 },
  standard: { faceFps: 8,  waveFps: 60, animateArcs: true,  dropShadows: false, camRes: 360 },
  pro:      { faceFps: 12, waveFps: 60, animateArcs: true,  dropShadows: true,  camRes: 480 },
  max:      { faceFps: 24, waveFps: 60, animateArcs: true,  dropShadows: true,  camRes: 720 },
};

let _autoPickMic = null;
let _getPreferredDeviceId = null;
let _setPreferredDevice = null;
let _wf = null;

/** One-shot wiring from voice.js. Pass the four cross-module dependencies
 *  this module needs. Idempotent — safe to call again on profile switch. */
export function init({ autoPickMic, getPreferredDeviceId, setPreferredDevice, wf } = {}) {
  if (typeof autoPickMic === "function") _autoPickMic = autoPickMic;
  if (typeof getPreferredDeviceId === "function") _getPreferredDeviceId = getPreferredDeviceId;
  if (typeof setPreferredDevice === "function") _setPreferredDevice = setPreferredDevice;
  if (wf) _wf = wf;
}

export function loadSavedVoice() { return Storage.get(VOICE_KEY, "bm_daniel"); }
export function getSavedAgency() { return Storage.get(AGENCY_KEY, "Jarvis AI"); }
export function getSavedTier()   { return Storage.get(TIER_KEY, "standard"); }
export function getTierPreset()  { return TIER_PRESETS[getSavedTier()] || TIER_PRESETS.standard; }

export async function maybeShowSetup() {
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

  document.getElementById("setupMicAuto").addEventListener("click", async () => {
    if (_autoPickMic) await _autoPickMic();
    await populateSetupMicPicker();
  });

  document.getElementById("setupSubmit").addEventListener("click", async () => {
    Storage.set(VOICE_KEY, voiceEl.value);
    Storage.set(AGENCY_KEY, agencyEl.value || "Jarvis AI");
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
          agency: agencyEl.value || "Jarvis AI",
        };
        await fetch("http://localhost:8766/config/override", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (e) { console.warn("[Jarvis] location override failed:", e.message); }
    } else if (agencyEl.value && agencyEl.value !== "Jarvis AI") {
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
  const saved = _getPreferredDeviceId ? _getPreferredDeviceId() : "";
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
      if (_setPreferredDevice) _setPreferredDevice(sel.value, label);
      /* Drop the cached mic stream so the next wfStartListening picks up the
       * freshly-selected device. The waveform module (in voice.js) re-acquires
       * on demand, so we don't need to actively re-open here. */
      if (_wf) {
        if (_wf.micStream) _wf.micStream.getTracks().forEach(t => t.stop());
        _wf.micStream = null;
        _wf.analyser = null;
      }
    });
  }
}
