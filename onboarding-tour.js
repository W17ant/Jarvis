/** onboarding-tour.js — 90-second guided first-run walkthrough.
 *
 *  Shown ONCE per profile after the setup wizard finishes. Walks the
 *  operator through three actual voice commands so they feel the loop:
 *    Step 1: "hey jarvis what time is it" — confirms wake + STT + TTS work
 *    Step 2: "hey jarvis open mail" — confirms tool dispatch works
 *    Step 3: "hey jarvis remember I prefer concise responses" — confirms
 *            memory persistence + that they can teach the assistant
 *
 *  Step matching listens to voice.js's onQueryHandled events and advances
 *  on substring matches against the operator's actual transcript — so
 *  natural phrasing variations ("what's the time", "show me my email")
 *  all qualify.
 *
 *  Storage:
 *    jarvis.<profile>.guidedTourSeen = "1"  (sticky — never tour again)
 *    jarvis.<profile>.guidedTourStep = "0"|"1"|"2"|"3"|"4"  (in-flight)
 *
 *  Dismissal paths:
 *    1. Operator completes step 4 → tour fades, sets seen=1
 *    2. Operator clicks "Skip tour" → fades, sets seen=1
 *    3. Operator presses Esc → fades, sets seen=1
 *    4. 90s timer expires → fades with toast, sets seen=1
 *
 *  Public API:
 *    init({ getQuerySubscriber }) — wire up the voice-event subscription
 *    maybeStart() — show the tour iff not yet seen + setup is done
 */

import * as Storage from "./storage.js";

const STEPS = [
  {
    id: 1,
    instruction: "Say \"Hey Jarvis, what time is it?\"",
    why: "Confirms the wake word, microphone, and voice reply all work.",
    match: (q) => /\b(time|clock|hour|what time)\b/i.test(q),
  },
  {
    id: 2,
    instruction: "Say \"Hey Jarvis, open mail.\"",
    why: "Confirms tool dispatch — Jarvis can drive your Mac, not just chat.",
    match: (q) => /\b(open|launch|show)\b.*\b(mail|email|inbox)\b/i.test(q),
  },
  {
    id: 3,
    instruction: "Say \"Hey Jarvis, remember that I prefer concise responses.\"",
    why: "Persistent memory — Jarvis recalls preferences across sessions.",
    match: (q) => /\b(remember|note|save)\b/i.test(q),
  },
];

const TOUR_TIMEOUT_MS = 90_000;
const TOUR_KEY_SEEN = "guidedTourSeen";
const TOUR_KEY_STEP = "guidedTourStep";

let _root = null;
let _stepEl = null;
let _instructionEl = null;
let _whyEl = null;
let _checkmarkEls = [];
let _statusEl = null;
let _unsub = null;
let _timeoutId = null;
let _currentStep = 0;
let _escHandler = null;

/** True if the operator has finished initial setup AND has not yet seen the tour. */
function _shouldShow() {
  if (Storage.get(TOUR_KEY_SEEN) === "1") return false;
  if (Storage.get("setupDone") !== "true") return false;
  return true;
}

/** Build the tour DOM once, attach to body. Called lazily on first start. */
function _build() {
  _root = document.createElement("div");
  _root.className = "tour-overlay";
  _root.id = "guidedTour";
  /* Inline styles for the backdrop only — the card chrome lives in styles.css
   * so it inherits the cyan palette + chamfered vocabulary cleanly. */
  _root.style.cssText = `
    position: fixed; inset: 0; z-index: 9998;
    background: rgba(2, 6, 12, 0.65);
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(2px);
  `;

  const card = document.createElement("div");
  card.className = "tour-card";
  _root.appendChild(card);

  const header = document.createElement("div");
  header.className = "tour-card__header";
  const title = document.createElement("div");
  title.className = "tour-card__title";
  title.textContent = "// FIRST RUN — 90 SECONDS";
  header.appendChild(title);
  const stepLabel = document.createElement("div");
  stepLabel.className = "tour-card__step";
  _stepEl = stepLabel;
  header.appendChild(stepLabel);
  card.appendChild(header);

  /* Step progress chips — one filled circle per step. */
  const progress = document.createElement("div");
  progress.className = "tour-card__progress";
  for (let i = 0; i < STEPS.length; i++) {
    const dot = document.createElement("div");
    dot.className = "tour-card__dot";
    progress.appendChild(dot);
    _checkmarkEls.push(dot);
  }
  card.appendChild(progress);

  const instruction = document.createElement("div");
  instruction.className = "tour-card__instruction";
  _instructionEl = instruction;
  card.appendChild(instruction);

  const why = document.createElement("div");
  why.className = "tour-card__why";
  _whyEl = why;
  card.appendChild(why);

  const status = document.createElement("div");
  status.className = "tour-card__status";
  _statusEl = status;
  card.appendChild(status);

  const footer = document.createElement("div");
  footer.className = "tour-card__footer";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "tour-card__skip";
  skip.textContent = "Skip tour";
  skip.addEventListener("click", () => _finish("skipped"));
  footer.appendChild(skip);
  const escHint = document.createElement("span");
  escHint.className = "tour-card__esc-hint";
  escHint.textContent = "Esc to skip";
  footer.appendChild(escHint);
  card.appendChild(footer);

  document.body.appendChild(_root);
}

function _renderStep() {
  if (_currentStep >= STEPS.length) return;
  const step = STEPS[_currentStep];
  _stepEl.textContent = `${step.id} / ${STEPS.length}`;
  _instructionEl.textContent = step.instruction;
  _whyEl.textContent = step.why;
  _statusEl.textContent = "Listening for your voice…";
  _statusEl.classList.remove("is-success");
  /* Update progress chips. */
  for (let i = 0; i < _checkmarkEls.length; i++) {
    _checkmarkEls[i].classList.remove("is-active", "is-done");
    if (i < _currentStep) _checkmarkEls[i].classList.add("is-done");
    if (i === _currentStep) _checkmarkEls[i].classList.add("is-active");
  }
}

function _renderComplete() {
  _stepEl.textContent = `${STEPS.length} / ${STEPS.length}`;
  _instructionEl.textContent = "You're set up.";
  _whyEl.textContent = "Press ? anytime to see the full command catalogue. Tap settings to customise the voice, palette, or wake phrase.";
  _statusEl.textContent = "✓ Tour complete";
  _statusEl.classList.add("is-success");
  for (const el of _checkmarkEls) {
    el.classList.remove("is-active");
    el.classList.add("is-done");
  }
}

/** Subscriber for voice.js's query-handled bus. Advances the step if the
 *  operator's transcript matches the current step's regex. */
function _onQueryHandled(payload) {
  if (_currentStep >= STEPS.length || !_root || _root.hidden) return;
  const step = STEPS[_currentStep];
  const text = String(payload?.heard || "").toLowerCase();
  if (!step.match(text)) return;
  /* Show success briefly, then advance. */
  _statusEl.textContent = "✓ Got it.";
  _statusEl.classList.add("is-success");
  _checkmarkEls[_currentStep]?.classList.add("is-done");
  setTimeout(() => {
    _currentStep += 1;
    Storage.set(TOUR_KEY_STEP, String(_currentStep));
    if (_currentStep >= STEPS.length) {
      _renderComplete();
      setTimeout(() => _finish("completed"), 2200);
    } else {
      _renderStep();
    }
  }, 900);
}

/** End the tour, persist the seen flag, unsubscribe, fade out. */
function _finish(reason) {
  if (!_root) return;
  Storage.set(TOUR_KEY_SEEN, "1");
  if (_unsub) { _unsub(); _unsub = null; }
  if (_timeoutId) { clearTimeout(_timeoutId); _timeoutId = null; }
  if (_escHandler) { document.removeEventListener("keydown", _escHandler); _escHandler = null; }
  _root.style.transition = "opacity 320ms";
  _root.style.opacity = "0";
  setTimeout(() => {
    if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
    _root = null;
  }, 360);
  console.log(`[tour] finished (${reason})`);
}

/** Resume from a partial step if the operator reloaded mid-tour. */
function _resumeStep() {
  const saved = parseInt(Storage.get(TOUR_KEY_STEP, "0"), 10);
  return Number.isInteger(saved) && saved >= 0 && saved <= STEPS.length ? saved : 0;
}

/** Wire the voice subscription and Esc handler. Called at start. */
function _wireSubscriptions(getQuerySubscriber) {
  const subscribe = typeof getQuerySubscriber === "function" ? getQuerySubscriber() : null;
  if (typeof subscribe === "function") {
    _unsub = subscribe(_onQueryHandled);
  }
  _escHandler = (e) => {
    if (e.key === "Escape" && _root && !_root.hidden) {
      e.preventDefault();
      _finish("esc");
    }
  };
  document.addEventListener("keydown", _escHandler);
  _timeoutId = setTimeout(() => _finish("timeout"), TOUR_TIMEOUT_MS);
}

/** Public init — wires up the voice subscriber lazily so tour module
 *  doesn't import voice.js (avoid module cycles). hud.js calls init()
 *  passing a function that returns voice.js's onQueryHandled. */
let _getQuerySubscriber = null;
export function init({ getQuerySubscriber }) {
  _getQuerySubscriber = getQuerySubscriber;
}

/** Show the tour if it hasn't been seen yet. Safe to call multiple times. */
export function maybeStart() {
  if (!_shouldShow()) return false;
  if (_root) return false;  /* already open */
  _build();
  _currentStep = _resumeStep();
  if (_currentStep >= STEPS.length) {
    /* Saved progress says complete — just mark seen and don't show. */
    Storage.set(TOUR_KEY_SEEN, "1");
    return false;
  }
  _renderStep();
  _wireSubscriptions(_getQuerySubscriber);
  console.log(`[tour] started at step ${_currentStep + 1}/${STEPS.length}`);
  return true;
}

/** Force-start regardless of seen flag — useful for "replay tour" in settings
 *  later. Doesn't reset seen. */
export function forceStart() {
  if (_root) return false;
  Storage.set(TOUR_KEY_STEP, "0");
  _build();
  _currentStep = 0;
  _renderStep();
  _wireSubscriptions(_getQuerySubscriber);
  return true;
}
