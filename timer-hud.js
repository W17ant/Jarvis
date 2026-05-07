// @ts-check
/** timer-hud.js - Live timer badges in the top-left corner.
 *
 *  The bridge fires three timer-related events that this module listens to:
 *    timer.set    — operator started a kitchen timer; show a countdown badge
 *    timer.cancel — operator stopped a timer before it fired
 *    timer.fire   — countdown reached 0; flash red, beep, speak the label
 *
 *  Each active timer gets its own badge. Badges sit in a vertically-stacked
 *  host element pinned to the top-left of the HUD. They self-tick at 2 Hz
 *  off setInterval — cheap enough that we don't need to share a render
 *  pump with the waveform.
 *
 *  This is leaf code: no dependency on voice.js state. The TTS fetch goes
 *  direct to the local Kokoro endpoint and reads the voice preference
 *  straight from localStorage, matching what the speak() path does in
 *  voice.js. Means timer-hud can be wired into any HUD that has Bridge.on
 *  + a body to attach to.
 *
 *  Public surface:
 *    register(Bridge) — call once after the bridge client is wired. Subscribes
 *                       to all three timer events and sets up the host on demand.
 */

/* Map<timerId, { badge: HTMLElement, interval: number }> — keeps the active
 * countdown intervals alive so timer.cancel + timer.fire can clear them. */
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
    /* @ts-ignore — webkitAudioContext fallback for older Safari */
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
      /* @ts-ignore — webkitAudioContext fallback for older Safari */
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buf = await ctx.decodeAudioData(wav);
      const src = ctx.createBufferSource(); src.buffer = buf;
      src.connect(ctx.destination); src.start(0);
    }
  } catch (e) {
    console.warn("[Flat-Out] timer TTS failed:", e.message);
  }
}

/** Subscribe to all three timer events on the bridge. Idempotent — safe to
 *  call once at HUD boot. */
export function register(Bridge) {
  Bridge.on("timer.set",    handleTimerSet);
  Bridge.on("timer.fire",   handleTimerFire);
  Bridge.on("timer.cancel", handleTimerCancel);
}
