/** settings-modal.js - The big settings modal (Cmd-, opens it).
 *
 *  Extracted from voice.js as part of the structural cleanup. Was a single
 *  928-LOC function nested inside voice.js, now a module with a clean
 *  init signature. The DOM helpers it uses (deriveColours, applyColoursLive,
 *  clearSelect, appendOption, appendPlaceholder, formatModelLabel) and its
 *  constants (SWATCH_COLOURS, VOICE_LABELS, VOICE_KEY) lived only in this
 *  block — they moved here too.
 *
 *  Public surface:
 *    wireSettingsModal({ applyAccessibilityPrefs, applyCameraVisibility })
 *      Wires every event listener on the settings modal exactly once.
 *      The two cross-cutting voice.js helpers come in via the deps object
 *      so this module doesn't reach back into voice.js's globals.
 *
 *  Why a deps object rather than direct imports of the voice.js helpers:
 *    voice.js orchestrates the whole loop and would import settings-modal.js
 *    too. Passing helpers in keeps the dependency graph one-way.
 *
 *  Why localStorage (Storage) is imported directly: the same module is used
 *  by every UI surface; circular-import worry doesn't apply to leaf utility
 *  modules.
 */

import * as Storage from "./storage.js";
import * as WakeParse from "./wake-parsing.js";

const VOICE_KEY = "voice";

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

/* The big one. Wires every event listener on the settings modal — voice
 * preview, swatch picker, location typeahead, profile switching, API key
 * masking, Tailscale status, creative-style markdown editor, folder
 * roots, project picker, accessibility prefs, the SAVE button. ~900 LOC
 * inherited from the voice.js monolith. */
export function wireSettingsModal({ applyAccessibilityPrefs, applyCameraVisibility } = {}) {
  const modal = document.getElementById("settingsModal");
  const btn = document.getElementById("settingsBtn");
  if (!modal || !btn) return;

  const voiceSel = document.getElementById("settingsVoice");
  const modelSel = document.getElementById("settingsModel");
  const previewBtn = document.getElementById("settingsVoicePreview");
  const wakeTestBtn = document.getElementById("settingsWakeTest");
  const wakeStatusEl = document.getElementById("settingsWakeStatus");
  /* iMessage listener config — read on modal open, persist on save. */
  const imessageEnabled = document.getElementById("settingsImessageEnabled");
  const imessageSenders = document.getElementById("settingsImessageSenders");
  const imessageTrigger = document.getElementById("settingsImessageTrigger");
  const imessagePoll = document.getElementById("settingsImessagePoll");
  const imessageStatusEl = document.getElementById("settingsImessageStatus");
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

    /* iMessage listener config — fetch current state and pre-populate.
     * Status pill shows running / disabled / FDA-required. */
    if (imessageEnabled) {
      try {
        const r = await fetch("http://localhost:8766/imessage/status");
        if (r.ok) {
          const j = await r.json();
          imessageEnabled.checked = !!j.enabled;
          imessageSenders.value = (j.allowedSenders || []).join(", ");
          imessageTrigger.value = j.trigger || "hey flat-out";
          imessagePoll.value = Math.round((j.pollIntervalMs || 5000) / 1000);
          if (imessageStatusEl) {
            imessageStatusEl.classList.remove("is-pass", "is-fail");
            if (!j.chatDbReachable) {
              imessageStatusEl.textContent = "needs Full Disk Access";
              imessageStatusEl.classList.add("is-fail");
            } else if (j.enabled && j.allowedSenderCount > 0) {
              imessageStatusEl.textContent = `running · ${j.allowedSenderCount} sender(s)`;
              imessageStatusEl.classList.add("is-pass");
            } else {
              imessageStatusEl.textContent = j.enabled ? "no allowed senders yet" : "disabled";
            }
          }
        }
      } catch (e) { console.warn("imessage status fetch failed:", e.message); }
    }

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
    if (a11yChanged) applyAccessibilityPrefs?.();

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
      applyCameraVisibility?.(currentState);
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

    /* iMessage listener config — POST whenever any field changed. The
     * server validates + writes to data/imessage-config.json; the running
     * poll loop re-reads on next tick (no restart needed). */
    let imessageChanged = false;
    let imessageError = null;
    if (imessageEnabled) {
      try {
        const senders = (imessageSenders.value || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const trigger = (imessageTrigger.value || "hey flat-out").trim();
        const pollSec = parseInt(imessagePoll.value, 10);
        const pollIntervalMs = Math.max(1000, Math.min(60_000, (pollSec || 5) * 1000));
        const r = await fetch("http://localhost:8766/imessage/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enabled: !!imessageEnabled.checked,
            allowedSenders: senders,
            trigger,
            pollIntervalMs,
          }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || `bridge ${r.status}`);
        imessageChanged = true;
      } catch (e) { imessageError = e.message; }
    }
    if (imessageError) {
      setStatus(`imessage: ${imessageError}`, "error");
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
      if (imessageChanged) parts.push("iMessage config updated");
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

  /* ---- Wake-word check ----
   * Records 3s from the operator's preferred mic, sends to Whisper, and
   * runs WakeParse.containsWake() against the transcript. Confirms Adam's
   * accent + mic combo reliably triggers the wake word before he hits a
   * "I keep saying Hey Flat-Out and nothing happens" rabbit hole.
   *
   * Doesn't go through the voice loop — direct getUserMedia → MediaRecorder
   * → POST /transcribe → WakeParse — so it works even when passive listening
   * isn't running. The status pill takes operator-readable verdicts only:
   * "Heard X clearly" / "Didn't catch the wake word — heard \"…\" instead". */
  async function runWakeTest() {
    if (!wakeTestBtn || !wakeStatusEl) return;
    wakeTestBtn.disabled = true;
    wakeTestBtn.textContent = "RECORDING (3s)…";
    wakeStatusEl.textContent = "speak now…";
    wakeStatusEl.classList.remove("is-pass", "is-fail");

    let stream;
    try {
      const id = Storage.get("preferredAudioDeviceId", "");
      const constraints = id
        ? { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    } catch (e) {
      wakeStatusEl.textContent = `mic error: ${e.name}`;
      wakeStatusEl.classList.add("is-fail");
      wakeTestBtn.disabled = false;
      wakeTestBtn.textContent = "TEST WAKE WORD (3s)";
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.start(250);
    await new Promise((r) => setTimeout(r, 3000));
    /* Stop + wait for final ondataavailable so we don't truncate the last chunk. */
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    stream.getTracks().forEach((t) => t.stop());

    if (chunks.length === 0) {
      wakeStatusEl.textContent = "no audio captured";
      wakeStatusEl.classList.add("is-fail");
      wakeTestBtn.disabled = false;
      wakeTestBtn.textContent = "TEST WAKE WORD (3s)";
      return;
    }

    wakeTestBtn.textContent = "TRANSCRIBING…";
    const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
    let heard = "";
    try {
      const r = await fetch("http://localhost:8768/transcribe", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: blob,
      });
      if (!r.ok) throw new Error(`whisper ${r.status}`);
      const j = await r.json();
      heard = (j.text || "").trim();
    } catch (e) {
      wakeStatusEl.textContent = `whisper error: ${e.message}`;
      wakeStatusEl.classList.add("is-fail");
      wakeTestBtn.disabled = false;
      wakeTestBtn.textContent = "TEST WAKE WORD (3s)";
      return;
    }

    if (!heard) {
      wakeStatusEl.textContent = "didn't hear anything — try again, louder";
      wakeStatusEl.classList.add("is-fail");
    } else if (WakeParse.containsWake(heard)) {
      wakeStatusEl.textContent = `✓ heard "${heard}"`;
      wakeStatusEl.classList.add("is-pass");
    } else {
      wakeStatusEl.textContent = `✗ no wake match — heard "${heard}"`;
      wakeStatusEl.classList.add("is-fail");
    }
    wakeTestBtn.disabled = false;
    wakeTestBtn.textContent = "TEST WAKE WORD (3s)";
  }

  btn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", () => closeModal());
  cancelBtn.addEventListener("click", () => closeModal());
  saveBtn.addEventListener("click", save);
  previewBtn.addEventListener("click", previewVoice);
  if (wakeTestBtn) wakeTestBtn.addEventListener("click", runWakeTest);
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

