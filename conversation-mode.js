// @ts-check
/** conversation-mode.js - Multi-turn dialogue state.
 *
 *  After the first wake, the operator stays in "conversation mode" — every
 *  utterance is treated as a query, no wake word needed. Exits on a
 *  dismissal phrase ("that's all", "stop listening", etc — detected by
 *  WakeParse.isDismissal) OR after 60s of silence (auto-timeout).
 *
 *  Why a module: voice.js's handleHeard / cyclePassive paths poll
 *  isActive() to decide whether to skip the wake-word check. Splitting
 *  the state owner out keeps voice.js focused on transport + STT.
 *
 *  Public surface:
 *    setHandlers({ wakeBtnLabel, speak, clearHistory }) — wire deps
 *    isActive()           — boolean: are we currently in conversation mode?
 *    enter()              — operator just woke up; flip into conv mode
 *    exit()               — explicit dismissal; reset history + UI
 *    resetIdleTimer()     — call after each successful turn so the 60s
 *                           auto-exit clock restarts
 *    acknowledgeBareWake() — picks a random ack phrase, speaks it, enters
 *                            conversation mode (operator said wake-word
 *                            with no follow-up query)
 */

/** @type {(text: string) => void} */
let _wakeBtnLabel = () => {};
/** @type {(text: string) => Promise<void>} */
let _speak = async () => {};
/** @type {() => void} */
let _clearHistory = () => {};

let conversationMode = false;
/* setTimeout return type — number in browsers, NodeJS.Timeout in node.
 * This module runs in the HUD (browser), so use ReturnType for portability. */
/** @type {ReturnType<typeof setTimeout> | 0} */
let conversationTimeoutId = 0;
/* Why bumped from 60s → 5 min: the previous 60s was scoped per-utterance,
 * which dropped conversation mode any time the operator paused to think
 * (or to listen to a long Jarvis reply) for more than a minute. The
 * operator's mental model is "stay in conversation until I dismiss you" —
 * 5 minutes is long enough to span any natural pause + a multi-sentence
 * reply, short enough that walking away from the kiosk still resets to
 * wake-word listening on its own. resetIdleTimer() is also now called
 * after every TTS reply (see voice.js) and on every gate-set in the
 * bridge, so the timer stays fresh through multi-step tool flows. */
const CONVERSATION_IDLE_MS = 300000;
/* When a confirmation gate is open ("Shall I proceed?"), the operator is
 * mid-task by definition — the idle timer must not fire. We track the
 * lock here and resetIdleTimer() short-circuits to a no-op while held. */
let _taskLockActive = false;
const ACK_PHRASES = ["Yes, sir.", "Sir.", "Go ahead.", "I'm here, sir.", "Listening, sir."];

const LABEL_CONVERSATION = "CONVERSATION — TAP TO STOP";
const LABEL_WAKE_LISTENING = "WAKE LISTENING — TAP TO STOP";

/** One-shot wiring from voice.js. Idempotent.
 *  @param {object} [deps]
 *  @param {(text: string) => void} [deps.wakeBtnLabel]
 *  @param {(text: string) => Promise<void>} [deps.speak]
 *  @param {() => void} [deps.clearHistory]
 */
export function setHandlers({ wakeBtnLabel, speak, clearHistory } = {}) {
  if (typeof wakeBtnLabel === "function") _wakeBtnLabel = wakeBtnLabel;
  if (typeof speak === "function") _speak = speak;
  if (typeof clearHistory === "function") _clearHistory = clearHistory;
}

export function isActive() { return conversationMode; }

export function enter() {
  conversationMode = true;
  _wakeBtnLabel(LABEL_CONVERSATION);
  resetIdleTimer();
}

export function exit() {
  conversationMode = false;
  if (conversationTimeoutId) { clearTimeout(conversationTimeoutId); conversationTimeoutId = 0; }
  _wakeBtnLabel(LABEL_WAKE_LISTENING);
  /* Fresh slate for the next conversation — important because the LLM's
   * history-window includes recent turns, and we don't want next session's
   * model to see "remember we were talking about the Bentley shoot". */
  _clearHistory();
}

export function resetIdleTimer() {
  if (conversationTimeoutId) clearTimeout(conversationTimeoutId);
  /* If a task is mid-flight (confirmation gate open, tool in progress),
   * defer the timer entirely. acquireTaskLock/releaseTaskLock manage this. */
  if (_taskLockActive) { conversationTimeoutId = 0; return; }
  conversationTimeoutId = setTimeout(() => {
    if (conversationMode) {
      conversationMode = false;
      _wakeBtnLabel(LABEL_WAKE_LISTENING);
      _clearHistory();
      console.log("[Jarvis] conversation timed out — back to wake-word listening");
    }
  }, CONVERSATION_IDLE_MS);
}

/** Take a task lock — pauses the idle timer until release. Use when a
 *  multi-step flow is awaiting operator input (confirmation, multi-turn
 *  tool sequence) so a long pause doesn't drop conversation mode. */
export function acquireTaskLock() {
  _taskLockActive = true;
  if (conversationTimeoutId) { clearTimeout(conversationTimeoutId); conversationTimeoutId = 0; }
}

/** Release the task lock and restart the idle clock from now. */
export function releaseTaskLock() {
  _taskLockActive = false;
  if (conversationMode) resetIdleTimer();
}

/** Operator said the wake word with no follow-up ("Hey Jarvis." then
 *  silence). Speak a random acknowledgement and enter conversation mode
 *  so they can ask the actual question on the next utterance. */
export async function acknowledgeBareWake() {
  const phrase = ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)];
  enter();
  await _speak(phrase);
  resetIdleTimer();
}
