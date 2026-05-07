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

let _wakeBtnLabel = () => {};   // (text) => void  — sets the wake button text
let _speak = async () => {};     // (text) => Promise<void>
let _clearHistory = () => {};

let conversationMode = false;
let conversationTimeoutId = 0;
const CONVERSATION_IDLE_MS = 60000;
const ACK_PHRASES = ["Yes, sir.", "Sir.", "Go ahead.", "I'm here, sir.", "Listening, sir."];

const LABEL_CONVERSATION = "CONVERSATION — TAP TO STOP";
const LABEL_WAKE_LISTENING = "WAKE LISTENING — TAP TO STOP";

/** One-shot wiring from voice.js. Idempotent. */
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
  conversationTimeoutId = setTimeout(() => {
    if (conversationMode) {
      conversationMode = false;
      _wakeBtnLabel(LABEL_WAKE_LISTENING);
      _clearHistory();
      console.log("[Flat-Out] conversation timed out — back to wake-word listening");
    }
  }, CONVERSATION_IDLE_MS);
}

/** Operator said the wake word with no follow-up ("Hey Flat-Out." then
 *  silence). Speak a random acknowledgement and enter conversation mode
 *  so they can ask the actual question on the next utterance. */
export async function acknowledgeBareWake() {
  const phrase = ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)];
  enter();
  await _speak(phrase);
  resetIdleTimer();
}
