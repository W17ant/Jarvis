/** modal-queue.js - Windowed result modals (video / PDF / thumbnail).
 *
 *  Pure DOM constructors — given a URL + meta, build and inject the window. No
 *  state, no dependencies on voice.js internals. Voice.js's queueModal scheduler
 *  stays in voice.js because it inspects busy-state (passive listening, mic mode,
 *  TTS in flight) before popping a window — that orchestration shouldn't bleed
 *  into a presentation module.
 *
 *  Each window targets a stable element id (videoWindow / pdfWindow / thumbWindow)
 *  so successive renders replace the previous result rather than stacking modals.
 *
 *  Exports:
 *    showVideo(url, meta)       — autoplay + download + close, used for teaser results
 *    showPdf(url, meta)         — Chrome's native PDF iframe + download + open + close
 *    showThumbnail(url, meta)   — image preview, reuses pdf-window styling */

/** Replace all children of an element. Tiny helper used by every builder. */
function reset(el) { while (el.firstChild) el.removeChild(el.firstChild); }

/** Get-or-create a top-level window element with the given id + class. */
function getOrMakeWindow(id, className) {
  let win = document.getElementById(id);
  if (!win) {
    win = document.createElement("div");
    win.id = id;
    win.className = className;
    document.body.appendChild(win);
  }
  reset(win);
  return win;
}

/**
 * Open a windowed video player inside the kiosk (non-fullscreen — HUD stays visible behind).
 *
 * @param {string} url   Absolute or root-relative URL to the .mp4.
 * @param {{subject?: string, title?: string, runId?: string}} [meta]
 */
export function showVideo(url, meta = {}) {
  const win = getOrMakeWindow("videoWindow", "video-window");

  /* Header — title row + actions row. Subject/title sub kept distinct from the
   * primary "PLAYBACK" label so the cinematic feel reads consistently across
   * different render outputs. */
  const header = document.createElement("div");
  header.className = "video-window__header";

  const titleWrap = document.createElement("div");
  const title = document.createElement("span");
  title.className = "video-window__title";
  title.textContent = "PLAYBACK";
  const sub = document.createElement("span");
  sub.className = "video-window__title-sub";
  sub.textContent = meta.subject || meta.title || "teaser";
  titleWrap.append(title, sub);

  const actions = document.createElement("div");
  actions.className = "video-window__actions";
  const downloadBtn = document.createElement("a");
  downloadBtn.className = "video-window__btn";
  downloadBtn.textContent = "DOWNLOAD";
  downloadBtn.href = url;
  downloadBtn.download = (meta.subject || "jarvis-teaser") + ".mp4";
  const closeBtn = document.createElement("button");
  closeBtn.className = "video-window__btn";
  closeBtn.textContent = "CLOSE";
  closeBtn.addEventListener("click", () => win.remove());
  actions.append(downloadBtn, closeBtn);

  header.append(titleWrap, actions);

  /* Player itself — autoplay + native controls + playsInline so iOS Safari (used
   * during remote-control or mobile preview) doesn't fullscreen-takeover. */
  const v = document.createElement("video");
  v.src = url;
  v.autoplay = true;
  v.controls = true;
  v.playsInline = true;
  v.className = "video-window__player";

  win.append(header, v);
  return win;
}

/**
 * Pop a rendered YouTube thumbnail image. Reuses .pdf-window styling so the
 * client-facing demo reads as a single coherent UI rather than three different surfaces.
 */
export function showThumbnail(url, meta = {}) {
  const win = getOrMakeWindow("thumbWindow", "pdf-window");

  const header = document.createElement("div");
  header.className = "pdf-window__header";
  const titleWrap = document.createElement("div");
  const title = document.createElement("span");
  title.className = "pdf-window__title";
  title.textContent = "YOUTUBE THUMBNAIL";
  const sub = document.createElement("span");
  sub.className = "pdf-window__sub";
  sub.textContent = [meta.headline, meta.subhead].filter(Boolean).join(" — ").toUpperCase();
  titleWrap.append(title, document.createElement("br"), sub);
  const close = document.createElement("button");
  close.className = "pdf-window__close";
  close.textContent = "✕";
  close.onclick = () => win.remove();
  header.append(titleWrap, close);

  const img = document.createElement("img");
  img.src = url;
  /* Inline styles here because the thumbnail container has no dedicated rule —
   * full-bleed image, black backdrop matches the pdf-window aesthetic. */
  img.style.cssText = "display:block;width:100%;height:auto;background:#000";
  win.append(header, img);
  return win;
}

/** Open a generated PDF in a windowed modal (Chrome's built-in viewer via iframe). */
export function showPdf(url, meta = {}) {
  const win = getOrMakeWindow("pdfWindow", "pdf-window");

  const header = document.createElement("div");
  header.className = "pdf-window__header";
  const titleWrap = document.createElement("div");
  const title = document.createElement("span");
  title.className = "pdf-window__title";
  title.textContent = (meta.template || "DOCUMENT").toUpperCase();
  const sub = document.createElement("span");
  sub.className = "pdf-window__title-sub";
  sub.textContent = meta.title || "";
  titleWrap.append(title, sub);

  const actions = document.createElement("div");
  actions.className = "pdf-window__actions";
  const downloadBtn = document.createElement("a");
  downloadBtn.className = "pdf-window__btn";
  downloadBtn.textContent = "DOWNLOAD";
  downloadBtn.href = url;
  downloadBtn.download = (meta.template || "jarvis") + ".pdf";
  const openBtn = document.createElement("a");
  openBtn.className = "pdf-window__btn";
  openBtn.textContent = "OPEN";
  openBtn.href = url;
  openBtn.target = "_blank";
  const closeBtn = document.createElement("button");
  closeBtn.className = "pdf-window__btn";
  closeBtn.textContent = "CLOSE";
  closeBtn.addEventListener("click", () => win.remove());
  actions.append(downloadBtn, openBtn, closeBtn);

  header.append(titleWrap, actions);

  /* Chrome renders PDFs natively inside an <iframe> when the response has
   * Content-Type: application/pdf — no JS PDF library needed. */
  const frame = document.createElement("iframe");
  frame.src = url;
  frame.className = "pdf-window__frame";

  win.append(header, frame);
  return win;
}
