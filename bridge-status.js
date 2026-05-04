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
   * useful if they want to demo the kiosk first with the fallback Flat-Out brand
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
  let snapshot = null;
  try {
    const r = await fetch(HEALTH_URL, { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (r.ok) snapshot = await r.json();
  } catch { /* down */ }

  if (!snapshot?.ok) {
    showDown();
    setTimeout(tick, POLL_DOWN_MS);
    return;
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

export function init() {
  /* Start the first probe immediately. If the bridge is up at boot we'll never
   * show the overlay; if it isn't, the operator sees the WAITING state within
   * 2.5 seconds (the fetch timeout). */
  tick();
}
