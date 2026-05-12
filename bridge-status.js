/** bridge-status.js — first-run + bridge-down overlays.
 *
 *  Two states the operator might land in that need clear guidance:
 *    1. Bridge isn't running — they opened the HUD before launch.sh finished, or
 *       the bridge crashed. Default behaviour is a dead-looking kiosk with no
 *       feedback. We show a clear "WAITING FOR BRIDGE" overlay instead.
 *    2. First run — config/brand.json doesn't exist, meaning setup-wizard.mjs
 *       hasn't been run. The HUD still loads (with FALLBACK brand config) but
 *       the operator hasn't picked their voice / agency / hardware tier yet.
 *       Surface the wizard command up front.
 *
 *  Polling cadence: 2s while down, 30s while up (cheap heartbeat just in case
 *  the bridge dies later in the session).
 */

const HEALTH_URL = "http://localhost:8766/healthz";
const POLL_DOWN_MS = 2_000;
const POLL_UP_MS = 30_000;
/* Why bump from 2500 → 5000ms (Sprint 12): with two HUD tabs (Jarvis + Friday)
 * booting simultaneously the bridge does 2× probe-fanouts to Ollama/Kokoro/
 * Whisper, and the burst occasionally pushes /healthz response time over the
 * old 2.5s timeout. Server-side caching (1s TTL on the /healthz handler)
 * caps the actual fanout, but keeping the client tolerance generous avoids
 * the splash flickering during any future slow-startup edge case. */
const HEALTH_TIMEOUT_MS = 5_000;

let overlayEl = null;
let lastState = null;       // null | "down" | "setup" | "up"

function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "bridge-status";
  overlayEl.hidden = true;
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function showDown() {
  if (lastState === "down") return;
  lastState = "down";
  const el = ensureOverlay();
  el.className = "bridge-status bridge-status--down";
  el.hidden = false;
  /* Use textContent + DOM construction (no innerHTML) so the message can't be
   * polluted by anything we ever read from the bridge. */
  while (el.firstChild) el.removeChild(el.firstChild);
  const card = document.createElement("div");
  card.className = "bridge-status__card";

  const label = document.createElement("div");
  label.className = "bridge-status__label";
  label.textContent = "WAITING FOR BRIDGE";
  card.appendChild(label);

  const title = document.createElement("div");
  title.className = "bridge-status__title";
  title.textContent = "The bridge service isn't responding.";
  card.appendChild(title);

  const body = document.createElement("p");
  body.className = "bridge-status__body";
  body.textContent = "If this is your first run, the bridge starts via:";
  card.appendChild(body);

  const code = document.createElement("div");
  code.className = "bridge-status__code";
  code.textContent = "$ ./launch.sh kiosk";
  card.appendChild(code);

  const hint = document.createElement("p");
  hint.className = "bridge-status__hint";
  hint.textContent = "If launch.sh has already run, the bridge may have crashed. Check the terminal it was started in, or re-run launch.sh.";
  card.appendChild(hint);

  const dots = document.createElement("div");
  dots.className = "bridge-status__dots";
  dots.textContent = "● ● ●";    /* CSS animates the opacity of each */
  card.appendChild(dots);

  el.appendChild(card);
}

function showSetupRequired() {
  if (lastState === "setup") return;
  lastState = "setup";
  const el = ensureOverlay();
  el.className = "bridge-status bridge-status--setup";
  el.hidden = false;
  while (el.firstChild) el.removeChild(el.firstChild);

  const card = document.createElement("div");
  card.className = "bridge-status__card";

  const label = document.createElement("div");
  label.className = "bridge-status__label";
  label.textContent = "FIRST RUN — SETUP NEEDED";
  card.appendChild(label);

  const title = document.createElement("div");
  title.className = "bridge-status__title";
  title.textContent = "Welcome. Run the setup wizard to pick your voice, agency, hardware tier, and folders.";
  card.appendChild(title);

  const body = document.createElement("p");
  body.className = "bridge-status__body";
  body.textContent = "In Terminal, from the project folder:";
  card.appendChild(body);

  const code = document.createElement("div");
  code.className = "bridge-status__code";
  code.textContent = "$ node tools/setup-wizard.mjs";
  card.appendChild(code);

  const hint = document.createElement("p");
  hint.className = "bridge-status__hint";
  hint.textContent = "Press Enter on each prompt to accept the suggested default. Takes about a minute. The HUD will pick up the new config automatically — no restart needed.";
  card.appendChild(hint);

  const dismiss = document.createElement("button");
  dismiss.className = "bridge-status__dismiss";
  dismiss.type = "button";
  dismiss.textContent = "DISMISS · KEEP USING DEFAULTS";
  /* "Dismiss" lets the operator close the overlay without running the wizard —
   * useful if they want to demo the kiosk first with the fallback Jarvis brand
   * before committing to their own. The flag is per-session (sessionStorage) so
   * it re-prompts on the next browser launch. */
  dismiss.addEventListener("click", () => {
    sessionStorage.setItem("bridge-status:setup-dismissed", "1");
    hideOverlay();
  });
  card.appendChild(dismiss);

  el.appendChild(card);
}

function hideOverlay() {
  lastState = "up";
  if (overlayEl) overlayEl.hidden = true;
}

async function tick() {
  /* If the WS is currently up, the bridge is by definition reachable.
   * Skip the redundant /healthz poll entirely — saves us from racing against
   * Chrome's localhost network serialisation during dual-tab boots. */
  if (_pollPaused || _wsConnected) return;
  /* Sprint 12 diagnostics — track every poll so we can see whether the
   * "WAITING FOR BRIDGE" overlay is firing because the fetch genuinely fails
   * vs a transient timeout vs no setupRequired flag. Tag with [bridge-status]
   * so it's distinguishable from the WS lifecycle logs. */
  const _t0 = Date.now();
  let snapshot = null;
  let err = null;
  try {
    const r = await fetch(HEALTH_URL, { cache: "no-store", signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    if (r.ok) snapshot = await r.json();
    else err = `http ${r.status}`;
  } catch (e) { err = e.name === "TimeoutError" ? `timeout ${HEALTH_TIMEOUT_MS}ms` : (e.message || "fetch failed"); }

  const dur = Date.now() - _t0;
  if (!snapshot?.ok) {
    console.warn(`[bridge-status] tick FAIL after ${dur}ms · err=${err || "snapshot.ok=false"} → showing splash`);
    showDown();
    setTimeout(tick, POLL_DOWN_MS);
    return;
  }
  if (lastState !== "up") {
    console.log(`[bridge-status] tick OK after ${dur}ms · setup=${!!snapshot.setupRequired} → hiding splash`);
  }

  /* Bridge up. Setup required? Only show that once per session unless dismissed. */
  if (snapshot.setupRequired && sessionStorage.getItem("bridge-status:setup-dismissed") !== "1") {
    showSetupRequired();
  } else {
    hideOverlay();
  }
  /* Slow poll while everything's healthy. */
  setTimeout(tick, POLL_UP_MS);
}

/* Sprint 12 — track whether the WS is connected. When the bridge-client opens
 * its WebSocket, we have authoritative liveness signal; the periodic /healthz
 * poll becomes redundant AND was the source of false-positive splash flickers
 * during the dual-tab boot burst (Chrome's localhost networking serialises the
 * parallel WS upgrades, pushing /healthz fetch over its 5s timeout even when
 * the bridge is curl-fast). With WS state as truth: splash only on WS down. */
let _wsConnected = false;
let _pollPaused = false;

/** Hook into the bridge-client's online/offline events. Called from init().
 *  Late binding — bridge-client may not be imported yet when this module
 *  loads, so we lazy-resolve. */
async function _hookWsEvents() {
  try {
    const Bridge = await import("./bridge-client.js");
    Bridge.on("bridge.online", () => {
      _wsConnected = true;
      _pollPaused = true;
      hideOverlay();
      console.log("[bridge-status] WS online — pausing /healthz poll");
    });
    Bridge.on("bridge.offline", () => {
      _wsConnected = false;
      if (_pollPaused) {
        _pollPaused = false;
        console.log("[bridge-status] WS offline — resuming /healthz poll");
        tick();
      }
    });
  } catch (e) {
    console.warn(`[bridge-status] couldn't hook WS events: ${e.message} — falling back to poll-only`);
  }
}

export function init() {
  _hookWsEvents();
  /* Sprint 12 — defer the first /healthz probe by 3 seconds. WS connects in
   * <500ms in single-tab mode, ~300ms each in dual-tab mode. By the time the
   * 3s timer fires, _wsConnected will be true and tick() bails before
   * fetching anything. This eliminates the boot-time splash flicker that
   * was firing on dual-tab opens because the parallel WS upgrades on Chrome's
   * localhost stack were pushing the /healthz fetch over even a 5s timeout.
   *
   * If WS DOESN'T come online in 3s (genuinely no bridge running), tick()
   * runs and the splash shows — same UX as before for the actually-broken
   * case. */
  setTimeout(() => { if (!_wsConnected) tick(); }, 3000);
}
