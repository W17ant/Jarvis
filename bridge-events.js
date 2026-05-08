/** bridge-events.js - Bridge WebSocket event handlers.
 *
 *  Tenth voice.js extraction. Pulls out the typed-event handlers that
 *  came in via Bridge.on() — task lifecycle, video.edit completion +
 *  errors, PDF / thumbnail modal pops, inbox-drop prompts. Leaves
 *  handleEnterSleep in voice.js because it directly drives listening /
 *  passive / TTS state that voice.js owns.
 *
 *  Why a module: the handlers were the last big cluster in voice.js
 *  that didn't belong there architecturally — they're pure
 *  event-routing shims that call into Modal / TtsPipeline / Tasks.
 *  Voice.js's residual scope is now wake/listening/conversation loop
 *  orchestration, which is what it should be.
 *
 *  Public surface:
 *    setHandlers({ speak, queueModal, setPendingInboxFile, modal }) — wire deps
 *    handleTaskEvent(msg)             — task.* lifecycle → speedo + task strip
 *    handleVideoEditComplete(msg)     — pop video modal, speak ready
 *    handleVideoEditError(msg)        — speak failure
 *    handlePdfComplete(msg)           — pop PDF modal
 *    handleThumbnailComplete(msg)     — pop thumbnail modal
 *    handleInboxDropped(msg)          — speak prompt, stash pending file
 *
 *  Notes:
 *    - The legacy yt.thumbnail.progress handler was deleted in this
 *      extraction. Lane-grouped progress viz on the task strip
 *      replaced its function (writing a "Composing thumbnail…" line
 *      into a debug panel that hasn't existed for weeks).
 *    - window.__tasks / window.__speedo are HUD-wide globals (not
 *      voice.js owned) so we read them directly rather than via deps.
 */

let _speak = async () => {};
let _queueModal = () => {};
let _setPendingInboxFile = () => {};
let _modal = null;

/** One-shot wiring from voice.js. Idempotent. */
export function setHandlers({ speak, queueModal, setPendingInboxFile, modal } = {}) {
  if (typeof speak === "function") _speak = speak;
  if (typeof queueModal === "function") _queueModal = queueModal;
  if (typeof setPendingInboxFile === "function") _setPendingInboxFile = setPendingInboxFile;
  if (modal) _modal = modal;
}

/* task.* — drives the bottom-strip progress UI + speedo mood. The task
 * strip's own handler lives at window.__tasks (set in tasks.js's boot
 * path); we just forward the event and translate to speedo mood. */
export function handleTaskEvent(m) {
  window.__tasks?.handleEvent(m);
  const sp = window.__speedo;
  if (!sp || !m.data?.runId) return;
  if (m.type === "task.start") {
    /* Voice always wins over background tasks — only swap to task mood
     * if no conversational state is currently active. */
    const speedoEl = document.getElementById("speedo");
    const inVoice = speedoEl?.classList.contains("is-listening")
                 || speedoEl?.classList.contains("is-thinking")
                 || speedoEl?.classList.contains("is-speaking");
    if (!inVoice) sp.setMood("task");
  } else if (m.type === "task.progress") {
    if (m.data.percent != null) sp.setProgress(m.data.percent / 100);
  } else if (m.type === "task.complete") {
    sp.flash("redline");
    sp.setProgress(0);
    sp.setMood("idle");
  } else if (m.type === "task.error") {
    sp.flash("amber");
    sp.setProgress(0);
    sp.setMood("idle");
  }
}

export function handleVideoEditComplete(m) {
  if (!m.data?.finalUrl) return;
  const url = `http://localhost:8766${m.data.finalUrl}`;
  console.log(`[Jarvis] video edit complete: ${m.data.subject} (${m.data.durationSec}s build)`);
  _queueModal(() => _modal?.showVideo(url, { subject: m.data.subject, runId: m.data.runId }),
              `Your ${m.data.subject || "shoot"} teaser is ready.`);
}

export function handleVideoEditError(m) {
  /* Legacy events used { error } at the top level; the audit standardised
   * on { data: { error } }. Read both for compatibility while older code
   * paths exist. */
  const err = m.data?.error || m.error || "(no detail)";
  console.warn("[Jarvis] video edit failed:", err);
  _speak("The edit pipeline ran into a problem. Check the bridge logs.");
}

export function handlePdfComplete(m) {
  if (!m.data?.url) return;
  const url = `http://localhost:8766${m.data.url}`;
  console.log(`[Jarvis] pdf ready: ${m.data.template} (${m.data.sizeKB}KB)`);
  _queueModal(() => _modal?.showPdf(url, { template: m.data.template, title: m.data.title }), null);
}

export function handleThumbnailComplete(m) {
  if (!m.data?.url) return;
  /* Pop the rendered thumbnail in the same modal pattern as PDFs/videos
   * so the client demo looks coherent. Generation is fast enough we
   * don't need a progress spinner — by the time Daniel finishes saying
   * "thumbnail ready" the image is up. */
  const url = `http://localhost:8766${m.data.url}`;
  console.log(`[Jarvis] thumbnail ready: ${m.data.headline} (${m.data.sizeKB}KB)`);
  _queueModal(() => _modal?.showThumbnail(url, { headline: m.data.headline, subhead: m.data.subhead }), null);
}

export function handleInboxDropped(m) {
  if (!m.data?.path) return;
  /* Drop-and-ask UX. The bridge watches inbox/ and broadcasts when a new
   * file lands. Speak a short prompt offering the relevant action —
   * operator can ignore (no answer = no action) or say yes to trigger
   * the appropriate tool. */
  console.log(`[Jarvis] inbox: ${m.data.name} (${m.data.kind}, ${m.data.sizeKB}KB)`);
  const verb = m.data.kind === "image" ? "describe it"
             : m.data.kind === "video" ? "score it for the trailer"
             : m.data.kind === "pdf"   ? "summarise it"
             : "have a look";
  const prompt = `I see ${m.data.name} in the inbox. Want me to ${verb}?`;
  _setPendingInboxFile({ path: m.data.path, kind: m.data.kind, name: m.data.name });
  _queueModal(() => {}, prompt);
}
