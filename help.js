/** help.js - Periodic command-discovery nudges.
 *
 *  Why: a kiosk runs for months. New staff drop in and don't know what to say;
 *  even the lead operator forgets which voice tools exist. Rather than a giant
 *  onboarding overlay (intrusive every reboot), this module shows a small
 *  floating tip card after a long idle window — "try saying: 'cut a teaser
 *  from the latest shoot'" — auto-fading after 12s.
 *
 *  Tips are pulled from the action manifest's phrasings field (filled in by
 *  config/actions.meta.json). Items without phrasings aren't surfaced because
 *  raw tool names like "video_edit_from_shoot" aren't useful coaching.
 *
 *  Idle detection: any voice state transition or palette open resets the timer.
 *  Nudge interval: 8 minutes of true idle. Hidden in demo mode (body.is-demo). */

const NUDGE_INTERVAL_MS = 8 * 60 * 1000;
const NUDGE_AUTO_FADE_MS = 12_000;
const STARTER_DELAY_MS = 60_000;        /* first nudge 60s after page load if idle */

let lastActivityTs = Date.now();
let nudgeTimer = null;
let cardEl = null;
let actions = [];

/** Pull manifest at boot. Falls back to a small static set if /actions is unreachable. */
async function loadActions() {
  try {
    const r = await fetch("http://localhost:8766/actions", { cache: "no-store" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    actions = (j.actions || []).filter(a => Array.isArray(a.phrasings) && a.phrasings.length);
  } catch {
    /* Fallback set lets help still work if the bridge is offline at boot. */
    actions = [
      { label: "Cut a teaser", phrasings: ["cut a teaser from the latest shoot"] },
      { label: "Find a shot", phrasings: ["find shots of the front grille"] },
      { label: "Shoot report", phrasings: ["draft a shoot report"] },
    ];
  }
}

function pickRandomAction() {
  if (!actions.length) return null;
  return actions[Math.floor(Math.random() * actions.length)];
}

/** Mark activity — resets the idle timer. Called by voice state changes + palette open. */
export function noteActivity() {
  lastActivityTs = Date.now();
}

function showNudge() {
  /* Skip if demo mode is active (client visit shouldn't see operator hints). */
  if (document.body.classList.contains("is-demo")) return;
  /* Skip if a real conversation is in flight — the speedo's not idle. */
  const speedo = document.getElementById("speedo");
  if (speedo?.classList.contains("is-listening") ||
      speedo?.classList.contains("is-thinking") ||
      speedo?.classList.contains("is-speaking")) return;

  const action = pickRandomAction();
  if (!action) return;

  cardEl = cardEl || document.getElementById("helpCard");
  if (!cardEl) return;
  while (cardEl.firstChild) cardEl.removeChild(cardEl.firstChild);

  const lead = document.createElement("span");
  lead.className = "help-card__lead";
  lead.textContent = "TRY SAYING";

  const phrase = document.createElement("span");
  phrase.className = "help-card__phrase";
  phrase.textContent = `"${action.phrasings[0]}"`;

  const dismiss = document.createElement("button");
  dismiss.className = "help-card__dismiss";
  dismiss.setAttribute("aria-label", "Dismiss tip");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => hideNudge());

  cardEl.append(lead, phrase, dismiss);
  cardEl.hidden = false;
  cardEl.classList.add("is-shown");

  /* Auto-fade after the configured timeout. */
  setTimeout(() => hideNudge(), NUDGE_AUTO_FADE_MS);
}

function hideNudge() {
  if (!cardEl) return;
  cardEl.classList.remove("is-shown");
  /* Allow the fade transition to play before fully hiding. */
  setTimeout(() => { if (cardEl) cardEl.hidden = true; }, 300);
}

function checkIdle() {
  const idleMs = Date.now() - lastActivityTs;
  if (idleMs >= NUDGE_INTERVAL_MS) {
    showNudge();
    /* Reset the clock — nudge counts as activity for cadence purposes so we don't
     * spam the operator with back-to-back tips after a long quiet period. */
    lastActivityTs = Date.now();
  }
}

/** Wire periodic checks + manifest fetch. */
export function init() {
  cardEl = document.getElementById("helpCard");
  if (!cardEl) return;
  loadActions();
  /* Slight initial delay so the first nudge doesn't ambush boot. After that we
   * check every 60s — the actual nudge fires only when the idle window has elapsed. */
  setTimeout(() => {
    /* If the kiosk genuinely sat idle from boot for 60s, show the starter nudge
     * once so newcomers see something. Subsequent nudges follow the 8-min rule. */
    if (Date.now() - lastActivityTs >= STARTER_DELAY_MS) showNudge();
    nudgeTimer = setInterval(checkIdle, 60_000);
  }, STARTER_DELAY_MS);
}

/** Test harness — fire a nudge from the dev console. */
export function _devShow() {
  noteActivity(); /* reset so we don't double-fire from the timer */
  showNudge();
}
window._helpShow = _devShow;
