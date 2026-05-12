// @ts-check
/** influencer-modals.js — HUD modals for the AI-influencer pipeline.
 *
 *  Owns two dialogs:
 *
 *    #infRefsModal    Pops when the bridge fires `influencer.refs_ready`
 *                     (create_influencer just generated 2-4 portraits).
 *                     Shows the references in a grid; clicking one calls
 *                     lock_influencer via Bridge.ask("llm.ask", ...) so
 *                     the LLM hears the lock and can narrate it. Closes
 *                     on `influencer.locked` from the bridge.
 *
 *    #infSourceModal  Pops when recreate_video_with_influencer is called
 *                     without a source. Bridge fires
 *                     `influencer.source_requested` with a request_id;
 *                     this module shows the modal, lets the operator
 *                     paste a URL or drop a local mp4, then sends
 *                     "influencer.source_provided" back with the same
 *                     request_id. Bridge resolves the pending Promise
 *                     and the recreation continues.
 *
 *  Why a separate module: voice.js + hud.js are already large; the modal
 *  surface is self-contained and ships fine as its own file. Bridge events
 *  are subscribed via the existing bridge-client pubsub so the wiring is
 *  one-way — modal asks, bridge does, modal closes on success.
 */

import * as Bridge from "./bridge-client.js";

/** Remove all children from a node without using innerHTML. Used by the
 *  refs modal to clear the grid between opens. */
function clearChildren(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ─────────────── REFS PICKER ─────────────── */

const refsModal = /** @type {HTMLElement | null} */ (document.getElementById("infRefsModal"));
const refsName  = /** @type {HTMLElement | null} */ (document.getElementById("infRefsName"));
const refsGrid  = /** @type {HTMLElement | null} */ (document.getElementById("infRefsGrid"));
const refsClose = /** @type {HTMLButtonElement | null} */ (document.getElementById("infRefsClose"));

/** Currently displayed slug — needed by the click handler so it can call
 *  lock_influencer with the right slug. Cleared on close. */
let _activeSlug = "";

function openRefsModal({ slug, name, refs }) {
  if (!refsModal || !refsGrid || !refsName) return;
  _activeSlug = slug;
  refsName.textContent = name || slug;
  clearChildren(refsGrid);
  for (const r of refs || []) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "inf-modal__tile";
    tile.dataset.idx = String(r.idx);
    tile.setAttribute("aria-label", `Reference ${r.idx}`);
    /* Why fileUri not path: file:// is what the WebView understands as an
     * <img src> on local files. Bridge already builds the URI. */
    const img = document.createElement("img");
    img.src = r.fileUri;
    img.alt = `Reference ${r.idx}`;
    img.draggable = false;
    const idxBadge = document.createElement("span");
    idxBadge.className = "inf-modal__idx";
    idxBadge.textContent = String(r.idx);
    tile.appendChild(img);
    tile.appendChild(idxBadge);
    tile.addEventListener("click", () => onPickRef(r.idx));
    refsGrid.appendChild(tile);
  }
  refsModal.hidden = false;
}

function closeRefsModal() {
  if (!refsModal) return;
  refsModal.hidden = true;
  clearChildren(refsGrid);
  _activeSlug = "";
}

/** Lock the picked reference. We funnel through the LLM rather than calling
 *  the tool directly so Jarvis can narrate ("Locked. Marcus is ready.") and
 *  so any session/history bookkeeping the bridge does on llm.ask paths is
 *  preserved. */
async function onPickRef(idx) {
  if (!_activeSlug) return;
  const slug = _activeSlug;
  /* Optimistic close — the bridge will fire influencer.locked when the tool
   * completes, but waiting for that round-trip adds visible lag. If the
   * lock fails, we'll re-open via the error toast (TODO if needed). */
  closeRefsModal();
  try {
    await Bridge.ask({
      type: "llm.ask",
      payload: {
        query: `Lock reference ${idx} for ${slug}.`,
        history: [],
      },
    });
  } catch (e) { console.warn("[influencer-modals] lock failed:", e); }
}

if (refsClose) refsClose.addEventListener("click", closeRefsModal);
if (refsModal) refsModal.addEventListener("click", (ev) => {
  /* Clicking outside the panel closes the modal — standard escape behaviour. */
  if (ev.target === refsModal) closeRefsModal();
});

Bridge.on("influencer.refs_ready", (msg) => {
  const d = msg?.data || {};
  openRefsModal({ slug: d.slug, name: d.name, refs: d.refs || [] });
});
Bridge.on("influencer.locked", () => closeRefsModal());

/* ─────────────── SOURCE-VIDEO MODAL ─────────────── */

const srcModal   = /** @type {HTMLElement | null} */ (document.getElementById("infSourceModal"));
const srcName    = /** @type {HTMLElement | null} */ (document.getElementById("infSourceName"));
const srcUrl     = /** @type {HTMLInputElement | null} */ (document.getElementById("infSourceUrl"));
const srcDrop    = /** @type {HTMLElement | null} */ (document.getElementById("infSourceDrop"));
const srcStatus  = /** @type {HTMLElement | null} */ (document.getElementById("infSourceStatus"));
const srcConfirm = /** @type {HTMLButtonElement | null} */ (document.getElementById("infSourceConfirm"));
const srcCancel  = /** @type {HTMLButtonElement | null} */ (document.getElementById("infSourceCancel"));
const srcClose   = /** @type {HTMLButtonElement | null} */ (document.getElementById("infSourceClose"));

let _activeRequestId = "";
let _droppedLocalPath = "";

function openSourceModal({ request_id, slug, influencerName }) {
  if (!srcModal || !srcName || !srcUrl) return;
  _activeRequestId = request_id;
  _droppedLocalPath = "";
  srcName.textContent = influencerName || slug || "";
  srcUrl.value = "";
  if (srcStatus) srcStatus.textContent = "";
  srcModal.hidden = false;
  /* Tiny delay so the modal's mount animation doesn't fight the focus call. */
  setTimeout(() => srcUrl?.focus(), 50);
}

function closeSourceModal({ cancelled = false } = {}) {
  if (!srcModal) return;
  /* If we're closing without a successful submit, tell the bridge so it
   * can reject the pending Promise and the LLM hears "operator cancelled"
   * instead of timing out. */
  if (cancelled && _activeRequestId) {
    Bridge.ask({
      type: "influencer.source_provided",
      payload: { request_id: _activeRequestId, cancelled: true },
    }).catch(() => {});
  }
  srcModal.hidden = true;
  _activeRequestId = "";
  _droppedLocalPath = "";
}

function setSourceStatus(text, kind) {
  if (!srcStatus) return;
  srcStatus.textContent = text;
  srcStatus.dataset.kind = kind || "info";
}

async function onSourceConfirm() {
  if (!_activeRequestId) return;
  const url = (srcUrl?.value || "").trim();
  /* Local-file path wins if the operator dropped one — matches the bridge's
   * resolution order in recreateVideoWithInfluencer. */
  if (!_droppedLocalPath && !url) {
    setSourceStatus("Paste a URL or drop an mp4 first.", "error");
    return;
  }
  setSourceStatus("Sending…", "info");
  try {
    await Bridge.ask({
      type: "influencer.source_provided",
      payload: {
        request_id: _activeRequestId,
        source_url: _droppedLocalPath ? null : url,
        source_local_path: _droppedLocalPath || null,
      },
    });
    closeSourceModal();
  } catch (e) {
    setSourceStatus(`Bridge rejected: ${e?.message || e}`, "error");
  }
}

if (srcConfirm) srcConfirm.addEventListener("click", onSourceConfirm);
if (srcCancel)  srcCancel .addEventListener("click", () => closeSourceModal({ cancelled: true }));
if (srcClose)   srcClose  .addEventListener("click", () => closeSourceModal({ cancelled: true }));
if (srcModal)   srcModal  .addEventListener("click", (ev) => {
  if (ev.target === srcModal) closeSourceModal({ cancelled: true });
});

/* Enter key on the URL field acts as Confirm — operator usually paste-and-go. */
if (srcUrl) srcUrl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); onSourceConfirm(); }
  if (ev.key === "Escape") closeSourceModal({ cancelled: true });
});

/* Drop zone: accepts a single local mp4. We can't read the file's bytes (the
 * bridge uses fs to read the path directly), so we capture the path. Browsers
 * only expose a `path` property on dropped File objects in Electron / file://
 * contexts — Jarvis runs the HUD as file:// so this is the standard Mac
 * behaviour. Falls back to .name when a real path isn't reachable. */
if (srcDrop) {
  const onDragEnter = (ev) => { ev.preventDefault(); srcDrop.classList.add("is-drag"); };
  const onDragLeave = () => srcDrop.classList.remove("is-drag");
  srcDrop.addEventListener("dragenter", onDragEnter);
  srcDrop.addEventListener("dragover",  onDragEnter);
  srcDrop.addEventListener("dragleave", onDragLeave);
  srcDrop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    srcDrop.classList.remove("is-drag");
    const f = ev.dataTransfer?.files?.[0];
    if (!f) return setSourceStatus("No file detected.", "error");
    /* Electron exposes file.path; in plain browser file:// pages we get
     * an empty string and have to bail, since the bridge needs an
     * absolute path on disk. */
    // @ts-ignore — Electron-only field
    const path = f.path || "";
    if (!path) return setSourceStatus("Couldn't read local path. Save the file and paste its path, or use a URL.", "error");
    if (!/\.(mp4|mov|m4v|webm)$/i.test(path)) {
      return setSourceStatus(`File '${f.name}' isn't an mp4/mov. Try a different clip.`, "error");
    }
    _droppedLocalPath = path;
    if (srcUrl) srcUrl.value = "";
    setSourceStatus(`Loaded ${f.name} — click Recreate to send.`, "ok");
  });
}

Bridge.on("influencer.source_requested", (msg) => {
  const d = msg?.data || {};
  openSourceModal({ request_id: d.request_id, slug: d.slug, influencerName: d.influencerName });
});
Bridge.on("influencer.source_request_cancelled", () => closeSourceModal());
