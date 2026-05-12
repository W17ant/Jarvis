/** latency-overlay.js — debug chip showing the voice pipeline's last-turn timings.
 *
 *  Toggle: append `?debug=latency` to the HUD URL OR set
 *          localStorage["debug.latency"] = "1" in DevTools.
 *
 *  Polls the bridge's /health/timings endpoint every 800ms and renders the
 *  most recent sample's per-stage breakdown plus the headline metric (the
 *  perceptual lag from speech-end → first audio). Built for Sprint 11's
 *  latency pass — also doubles as great b-roll for the demo video, which is
 *  why the chip is large enough to read on a screencap and colour-coded so
 *  "<800ms" is visually obvious.
 *
 *  Self-mounts on import. Safe to leave imported in production builds —
 *  noop unless the flag is set.
 */

const POLL_MS = 800;
const BRIDGE = "http://localhost:8766";

/** Whether the overlay should be visible at all. */
function _enabled() {
  try {
    if (new URLSearchParams(location.search).get("debug") === "latency") return true;
    if (localStorage.getItem("debug.latency") === "1") return true;
  } catch {}
  return false;
}

/** Colour the headline metric so the demo screencap reads at a glance. */
function _colour(totalMs) {
  if (totalMs == null) return "#7a8b9e";
  if (totalMs < 800)  return "#3aff9c";
  if (totalMs < 1200) return "#ffb84a";
  return "#ff5e6c";
}

/** Build a stage row using textContent only — no innerHTML touching dynamic data. */
function _appendRow(grid, label, ms, accent) {
  const lbl = document.createElement("span");
  lbl.className = "latov__lbl";
  lbl.textContent = label;
  const val = document.createElement("span");
  val.className = "latov__val";
  val.textContent = ms == null ? "—" : `${ms}ms`;
  if (accent) val.style.color = accent;
  grid.appendChild(lbl);
  grid.appendChild(val);
}

function _mount() {
  if (document.getElementById("latov")) return;
  const el = document.createElement("aside");
  el.id = "latov";
  el.setAttribute("aria-label", "Voice pipeline latency overlay");

  /* Build skeleton with createElement — all static strings, no template
   * literals carrying dynamic data anywhere near innerHTML. */
  const head = document.createElement("div");
  head.className = "latov__head";
  const headLbl = document.createElement("span");
  headLbl.textContent = "VOICE LATENCY";
  const closeBtn = document.createElement("button");
  closeBtn.className = "latov__close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Hide overlay");
  closeBtn.textContent = "×";
  head.append(headLbl, closeBtn);

  const total = document.createElement("div");
  total.className = "latov__total";
  const totalLbl = document.createElement("span");
  totalLbl.textContent = "SPEECH → AUDIO";
  const totalNum = document.createElement("strong");
  totalNum.id = "latovTotal";
  totalNum.textContent = "—";
  total.append(totalLbl, totalNum);

  const grid = document.createElement("div");
  grid.className = "latov__grid";
  grid.id = "latovGrid";

  const heard = document.createElement("div");
  heard.className = "latov__heard";
  heard.id = "latovHeard";
  heard.textContent = "(waiting for first turn…)";

  el.append(head, total, grid, heard);

  /* Inline styles so the chip works without a styles.css edit. */
  const style = document.createElement("style");
  style.textContent = `
    #latov{position:fixed;top:64px;right:16px;z-index:9000;width:280px;
      background:rgba(6,12,22,0.92);backdrop-filter:blur(8px);
      border:1px solid rgba(0,212,255,0.35);border-radius:6px;padding:12px 14px;
      font-family:'JetBrains Mono',ui-monospace,monospace;color:#e8f4ff;
      box-shadow:0 0 28px rgba(0,212,255,0.20);user-select:none;}
    #latov .latov__head{display:flex;justify-content:space-between;align-items:center;
      font-size:11px;letter-spacing:3px;color:#00d4ff;margin-bottom:8px;}
    #latov .latov__close{all:unset;cursor:pointer;color:#7a8b9e;font-size:18px;line-height:1;
      padding:0 4px;}
    #latov .latov__close:hover{color:#e8f4ff;}
    #latov .latov__total{display:flex;justify-content:space-between;align-items:baseline;
      font-size:12px;letter-spacing:2px;color:#7a8b9e;margin-bottom:10px;
      padding-bottom:10px;border-bottom:1px solid rgba(0,212,255,0.15);}
    #latov .latov__total strong{font-size:24px;font-weight:600;letter-spacing:1px;
      font-variant-numeric:tabular-nums;}
    #latov .latov__grid{display:grid;grid-template-columns:1fr auto;gap:4px 12px;
      font-size:12px;line-height:1.4;}
    #latov .latov__lbl{color:#7a8b9e;letter-spacing:1.5px;}
    #latov .latov__val{font-variant-numeric:tabular-nums;text-align:right;}
    #latov .latov__heard{margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,212,255,0.10);
      font-size:11px;color:#7a8b9e;font-style:italic;line-height:1.3;
      max-height:32px;overflow:hidden;text-overflow:ellipsis;}
  `;
  document.head.appendChild(style);
  document.body.appendChild(el);

  closeBtn.addEventListener("click", () => {
    el.remove();
    try { localStorage.setItem("debug.latency", "0"); } catch {}
  });
}

async function _tick() {
  let j;
  try {
    const res = await fetch(`${BRIDGE}/health/timings`, { cache: "no-store" });
    j = await res.json();
  } catch { return; }
  if (!j.ok || !Array.isArray(j.recent) || !j.recent.length) return;
  const last = j.recent[j.recent.length - 1];
  const s = last.spans || {};
  /* Headline: speech-end → first audio. Falls back to wake → audio if the
   * recend mark didn't fire (legacy cycles), or to wake → whisper if there's
   * still no audio yet (first cycle of a session). */
  const headline = s.recend_to_audio ?? s.voice_to_audio ?? s.voice_to_whisper;
  const totalEl = document.getElementById("latovTotal");
  const grid = document.getElementById("latovGrid");
  const heardEl = document.getElementById("latovHeard");
  if (totalEl) {
    totalEl.textContent = headline == null ? "—" : `${headline}ms`;
    totalEl.style.color = _colour(headline);
  }
  if (grid) {
    /* Wipe + rebuild rows. ChildNodes are plain spans created via
     * createElement so this can't smuggle markup. */
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    _appendRow(grid, "WHISPER",     s.recend_to_whisper);
    _appendRow(grid, "LLM",         s.llm_thinking);
    _appendRow(grid, "TTS",         s.tts_synth);
    _appendRow(grid, "USER SPOKE",  s.voice_to_recend, "#7a8b9e");
  }
  /* textContent assignment — never innerHTML, so even if `heard` somehow
   * contained markup it would render as literal text. */
  if (heardEl) heardEl.textContent = last.heard ? `"${last.heard}"` : "(no transcript)";
}

function _start() {
  if (!_enabled()) return;
  const init = () => { _mount(); _tick(); setInterval(_tick, POLL_MS); };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
}

_start();
