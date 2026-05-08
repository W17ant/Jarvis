/** mic-test.js - Mic device probing + raw-PCM diagnostic.
 *
 *  Two operator-facing utilities pulled out of voice.js:
 *
 *    autoPickMic()  — iterate every audioinput, sample 600ms of raw PCM
 *                     from each, pick the highest-peak device above noise
 *                     floor, and persist that deviceId. Bypasses Chrome's
 *                     reluctance to expose device labels by working
 *                     directly on deviceIds.
 *
 *    runMicTest()   — capture 3s of raw PCM from the currently-preferred
 *                     mic, surface peak/RMS in the debug panel. Proves
 *                     whether macOS is delivering audio at all, separate
 *                     from any encoder issues higher up the chain.
 *
 *  Both write status into voice.js's debug panel via the injected dbgSet
 *  setter, so the debug overlay stays the single source of truth for
 *  device diagnostics.
 *
 *  Deps (injected via init): dbgSet, getPreferredDeviceId,
 *  setPreferredDevice, refreshDevicePicker, wf. The wf state object is
 *  shared with voice.js so we can clear its cached micStream/analyser
 *  after auto-pick — the next wfStartListening then re-acquires with
 *  the freshly-chosen device.
 */

let _dbgSet = () => {};
let _getPreferredDeviceId = () => "";
let _setPreferredDevice = () => {};
let _refreshDevicePicker = async () => {};
let _wf = null;

/** One-shot wiring from voice.js. Pass the four cross-module deps + the
 *  shared wf state. Idempotent — safe to call again on profile switch. */
export function init({
  dbgSet,
  getPreferredDeviceId,
  setPreferredDevice,
  refreshDevicePicker,
  wf,
} = {}) {
  if (typeof dbgSet === "function") _dbgSet = dbgSet;
  if (typeof getPreferredDeviceId === "function") _getPreferredDeviceId = getPreferredDeviceId;
  if (typeof setPreferredDevice === "function") _setPreferredDevice = setPreferredDevice;
  if (typeof refreshDevicePicker === "function") _refreshDevicePicker = refreshDevicePicker;
  if (wf) _wf = wf;
}

/** Iterate every audioinput device, sample 600ms of raw PCM from each, pick the one with the
 *  highest peak above noise floor. Saves that deviceId to localStorage. Bypasses Chrome's
 *  reluctance to expose device labels — works directly on deviceIds. */
/** @param {HTMLButtonElement | null} [buttonEl] Optional button to drive
 *  status text / disabled state. Falls back to the legacy `dbgAutoPickBtn`
 *  for the first-run setup-modal call site. Settings-modal passes its own. */
export async function autoPickMic(buttonEl) {
  const btn = buttonEl || document.getElementById("dbgAutoPickBtn");
  /* Allow headless invocation — useful for fast-path / programmatic calls
   * where there's no UI to drive. Old early-return on missing-btn would
   * silently no-op, which masked Adam's "auto-pick does nothing"
   * observation when the debug panel got removed. */
  const setBtnText = (txt) => { if (btn) btn.textContent = txt; };
  const setBtnDisabled = (d) => { if (btn) btn.disabled = d; };
  setBtnDisabled(true); setBtnText("TESTING DEVICES…");
  _dbgSet("error", "—");

  // Make sure we have permission first so enumerateDevices returns ALL devices
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); } catch {}
  await new Promise(r => setTimeout(r, 200));
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter(d => d.kind === "audioinput");

  if (inputs.length === 0) {
    _dbgSet("error", "no audio inputs found");
    setBtnDisabled(false); setBtnText("AUTO-PICK WORKING MIC");
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
    setBtnText(`TESTING ${i + 1}/${inputs.length}…`);
    _dbgSet("device", `probing: ${label}`);

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
  console.log("[Jarvis] mic auto-pick results:", results.map(r => `${r.label}: peak=${r.peak.toFixed(4)}`));

  if (winner && winner.peak > 0.001) {
    _setPreferredDevice(winner.device.deviceId, winner.label);
    if (_wf?.micStream) _wf.micStream.getTracks().forEach(t => t.stop());
    if (_wf) { _wf.micStream = null; _wf.analyser = null; }
    _dbgSet("device", `${winner.label} (auto-picked, peak=${winner.peak.toFixed(3)})`);
    _dbgSet("error", "✓ working mic chosen — tap wake to use it");
    await _refreshDevicePicker();
  } else {
    const summary = results.map(r => `${r.label}: ${r.peak.toFixed(3)}`).join(" / ");
    _dbgSet("error", `all silent: ${summary}`);
  }

  setBtnDisabled(false); setBtnText("AUTO-PICK WORKING MIC");
}

/** Standalone mic test — bypasses MediaRecorder. Captures 3s of raw PCM, reports peak/RMS.
 *  This proves whether macOS is delivering audio at ALL, separate from any encoder issues. */
export async function runMicTest() {
  const btn = document.getElementById("dbgTestBtn");
  if (!btn) return;
  btn.disabled = true; btn.textContent = "TESTING…";
  _dbgSet("error", "—");

  let stream;
  try {
    const id = _getPreferredDeviceId();
    const constraints = id
      ? { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  } catch (e) {
    _dbgSet("error", `getUserMedia: ${e.name} ${e.message}`);
    btn.disabled = false; btn.textContent = "TEST MIC (3s)";
    return;
  }

  const ctx = _wf?.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
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
  _dbgSet("device", track.label || "?");
  _dbgSet("track", `${track.readyState}/${track.muted ? "muted" : "live"}/${track.enabled ? "on" : "off"}`);

  await new Promise(r => setTimeout(r, 3000));

  src.disconnect(); sp.disconnect();
  stream.getTracks().forEach(t => t.stop());

  const rms = n ? Math.sqrt(sumSq / n) : 0;
  _dbgSet("peak", `peak=${peak.toFixed(4)} rms=${rms.toFixed(4)} samples=${n}`);
  if (peak < 0.0005) {
    _dbgSet("error", "MIC SILENT — macOS not delivering audio");
  } else if (peak < 0.01) {
    _dbgSet("error", "very quiet — check input gain in System Settings → Sound → Input");
  } else {
    _dbgSet("error", "mic audio reaching browser ✓");
  }
  btn.disabled = false; btn.textContent = "TEST MIC (3s)";
}
