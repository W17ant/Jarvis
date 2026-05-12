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
  const agentEl = document.getElementById("setupAgent");
  const wakeEl = document.getElementById("setupWake");
  const accentChipsEl = document.getElementById("setupAccentChips");
  const accentHexEl = document.getElementById("setupAccentHex");

  cityEl.value = op.city || "";
  if (op.latitude && op.longitude) {
    coordsEl.textContent = `lat ${op.latitude.toFixed(4)}, lon ${op.longitude.toFixed(4)} • ${op.timezone || "Europe/London"}`;
  }
  voiceEl.value = loadSavedVoice();

  /* Pre-fill brand identity from the live /brand response so the operator
   * sees their current state (or the embedded Jarvis defaults on first run)
   * rather than empty fields. /brand always returns a complete object —
   * brand.mjs falls back to defaults if config/brand.json doesn't exist. */
  let liveBrand = null;
  try {
    const r = await fetch("http://localhost:8766/brand");
    if (r.ok) liveBrand = await r.json();
  } catch {}
  agentEl.value = liveBrand?.agent?.name || "Jarvis";
  agencyEl.value = liveBrand?.agency?.name || getSavedAgency();
  wakeEl.value = liveBrand?.agent?.wakePhrase || `hey ${(liveBrand?.agent?.name || "Jarvis").toLowerCase()}`;
  /* Auto-derive wake phrase as the operator types the agent name — but only
   * if they haven't manually customised the wake field. The "manually
   * customised" signal: wake doesn't equal "hey {previous-agent}". */
  agentEl.addEventListener("input", () => {
    const expectedWake = `hey ${(agentEl.value || "").toLowerCase().trim()}`;
    const currentlyDerived = wakeEl.value === `hey ${(liveBrand?.agent?.name || "jarvis").toLowerCase()}`;
    if (currentlyDerived || !wakeEl.value) wakeEl.value = expectedWake;
  });

  /* Accent chips — clicking one fills the hex field + paints the live
   * --accent CSS variable so the operator sees the colour change in real
   * time. The hex field is the source of truth on submit. */
  const initialAccent = liveBrand?.colors?.primary || "#00d4ff";
  accentHexEl.value = initialAccent;
  const paintAccent = (hex) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
    document.documentElement.style.setProperty("--accent", hex);
    /* Mark the matching chip as selected for visual feedback. */
    for (const chip of accentChipsEl.querySelectorAll(".setup__accent-chip")) {
      chip.classList.toggle("is-selected", chip.dataset.accent?.toLowerCase() === hex.toLowerCase());
    }
  };
  accentChipsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".setup__accent-chip");
    if (!chip) return;
    accentHexEl.value = chip.dataset.accent;
    paintAccent(chip.dataset.accent);
  });
  accentHexEl.addEventListener("input", () => paintAccent(accentHexEl.value.trim()));
  paintAccent(initialAccent);

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

    /* Brand identity — POST to /brand which writes config/brand.json,
     * invalidates the bridge cache, and broadcasts brand.updated so the
     * HUD live-reloads. We send a partial patch (only the fields the
     * setup modal owns) — bridge.saveBrand merges shallowly so existing
     * logo / mishears / fonts stay untouched. */
    const agentName = (agentEl.value || "Jarvis").trim();
    const agencyName = (agencyEl.value || "Jarvis AI").trim();
    const wakePhrase = (wakeEl.value || `hey ${agentName.toLowerCase()}`).trim().toLowerCase();
    const accentHex = (accentHexEl.value || "").trim();
    /* Validate hex before persisting — a malformed value would let the
     * default cyan stick rather than fail noisily. */
    const validHex = /^#[0-9a-fA-F]{6}$/.test(accentHex) ? accentHex : null;
    const brandPatch = {
      agent: { name: agentName, wakePhrase },
      agency: { name: agencyName },
    };
    if (validHex) {
      /* Derive deep / glow / tint from the primary so the operator only
       * picks one colour, not four. The same shading function the kiosk
       * uses for per-profile accent overrides — keep them in sync. */
      const r2 = parseInt(validHex.slice(1, 3), 16);
      const g2 = parseInt(validHex.slice(3, 5), 16);
      const b2 = parseInt(validHex.slice(5, 7), 16);
      const shade = (amt) => {
        const adj = (c) => Math.max(0, Math.min(255, Math.round(c + (amt < 0 ? c * amt : (255 - c) * amt))));
        const toHex = (c) => c.toString(16).padStart(2, "0").toUpperCase();
        return "#" + toHex(adj(r2)) + toHex(adj(g2)) + toHex(adj(b2));
      };
      brandPatch.colors = {
        primary: validHex.toUpperCase(),
        primaryDeep: shade(-0.45),
        primaryGlow: `rgba(${r2},${g2},${b2},0.55)`,
        primaryTint: `rgba(${r2},${g2},${b2},0.06)`,
      };
    }
    try {
      await fetch("http://localhost:8766/brand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(brandPatch),
      });
    } catch (e) { console.warn("[Jarvis] brand save failed:", e.message); }

    /* Location override — bridges geocodes via Open-Meteo if the operator
     * typed a different city. Separate POST from /brand because location
     * lives in config.json, not config/brand.json. */
    const enteredCity = (cityEl.value || "").trim();
    const detectedCity = (op.city || "").trim();
    if (enteredCity && enteredCity.toLowerCase() !== detectedCity.toLowerCase()) {
      try {
        const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(enteredCity)}&count=1&language=en`);
        const j = await g.json();
        const r = j.results && j.results[0];
        await fetch("http://localhost:8766/config/override", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            city: enteredCity,
            country: r?.country || op.country,
            latitude: r?.latitude ?? op.latitude,
            longitude: r?.longitude ?? op.longitude,
            timezone: r?.timezone || op.timezone,
            agency: agencyName,
          }),
        });
      } catch (e) { console.warn("[Jarvis] location override failed:", e.message); }
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
