/** visual-drop.js — HUD-wide drag-and-drop for image / video analysis.
 *
 *  Overlays the whole document when a file is dragged in from Finder / a
 *  browser / another app. On drop: uploads the file to /api/visual/analyse,
 *  the bridge saves under output/visual-drops/<date>/, runs describe_image
 *  (local Qwen 2.5-VL), and returns a 1-2 sentence caption.
 *
 *  Why not piggy-back the existing inbox/ folder-watch flow: that flow
 *  asks "want me to look at it?" verbally and waits for the next operator
 *  utterance. For HUD drag-drop the operator's intent is already obvious
 *  — they dragged the file onto the HUD. Skipping the verbal confirmation
 *  removes a turn of friction. The folder-watch path stays as the
 *  alternate flow for Finder-based drops where the operator may not be
 *  at the HUD.
 *
 *  Drag-depth counter: HTML5 dragenter/dragleave fire on every child
 *  element of the overlay target, so naive show-on-enter / hide-on-leave
 *  flickers. A depth counter incremented on enter and decremented on
 *  leave only hides when the counter hits zero (i.e. the cursor has
 *  left the document).
 */

import * as Bridge from "./bridge-client.js";

const BRIDGE_BASE = "http://localhost:8766";
const ACCEPTED_EXTS = new Set(["jpg", "jpeg", "png", "webp", "heic", "tiff", "mp4", "mov", "m4v", "avi", "mkv"]);

let _root = null;
let _msgEl = null;
let _dragDepth = 0;
let _busy = false;

export function init() {
  if (_root) return;
  buildOverlay();
  document.addEventListener("dragenter", onDragEnter, { capture: true });
  document.addEventListener("dragover",  onDragOver,  { capture: true });
  document.addEventListener("dragleave", onDragLeave, { capture: true });
  document.addEventListener("drop",      onDrop,      { capture: true });
}

function buildOverlay() {
  _root = document.createElement("div");
  _root.id = "visual-drop-overlay";
  _root.hidden = true;
  /* Build DOM with createElement so we never inject any user-controlled
   * text via innerHTML — mirrors the panel modules' XSS-by-construction
   * stance. */
  const inner = document.createElement("div");
  inner.className = "visual-drop-inner";
  const icon = document.createElement("div");
  icon.className = "visual-drop-icon";
  icon.textContent = "⤓";   // downward arrow to bar
  const title = document.createElement("div");
  title.className = "visual-drop-title";
  title.textContent = "DROP TO ANALYSE";
  const sub = document.createElement("div");
  sub.className = "visual-drop-sub";
  sub.textContent = "Image · Video";
  _msgEl = document.createElement("div");
  _msgEl.className = "visual-drop-msg";
  _msgEl.hidden = true;
  inner.append(icon, title, sub, _msgEl);
  _root.appendChild(inner);
  document.body.appendChild(_root);
}

/** Only react to drags that carry actual files — text-drags from inside
 *  the page (e.g. selecting a paragraph and dragging it) shouldn't trigger
 *  the overlay. dataTransfer.types contains "Files" when the OS is
 *  dragging real files in. */
function hasFiles(e) {
  return Array.from(e.dataTransfer?.types || []).includes("Files");
}

function onDragEnter(e) {
  if (_busy) return;
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth++;
  if (_root.hidden) _root.hidden = false;
}

function onDragOver(e) {
  if (!hasFiles(e)) return;
  /* preventDefault is REQUIRED on dragover for the drop event to fire at
   * all — without this, the OS rejects the drop and falls back to opening
   * the file in the browser. */
  e.preventDefault();
}

function onDragLeave(e) {
  if (!hasFiles(e)) return;
  _dragDepth = Math.max(0, _dragDepth - 1);
  if (_dragDepth === 0 && !_busy) hideOverlay();
}

async function onDrop(e) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  _dragDepth = 0;
  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) { hideOverlay(); return; }
  /* MVP: only first file. Multi-file analysis can land in a follow-up
   * iteration (chain captions, or describe a grid). */
  const file = files[0];
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!ACCEPTED_EXTS.has(ext)) {
    showMessage(`Unsupported file type .${ext}. Try jpg/png/mp4.`);
    setTimeout(() => hideOverlay(), 2500);
    return;
  }
  _busy = true;
  showMessage(`Analysing ${file.name}…`);
  try {
    const r = await fetch(
      `${BRIDGE_BASE}/api/visual/analyse?name=${encodeURIComponent(file.name)}`,
      {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream" },
        body: file,
      },
    );
    const j = await r.json();
    if (j?.ok) {
      showMessage(j.caption || "(no caption returned)");
    } else {
      showMessage(`Failed: ${j?.error || r.statusText}`);
    }
  } catch (err) {
    showMessage(`Upload error: ${err.message}`);
  } finally {
    _busy = false;
    /* Linger long enough to read the caption (rough estimate by length),
     * minimum 3s, capped at 12s. */
    const caption = _msgEl.textContent || "";
    const dwell = Math.max(3000, Math.min(12_000, caption.length * 60));
    setTimeout(() => hideOverlay(), dwell);
  }
}

function showMessage(text) {
  if (!_msgEl) return;
  _msgEl.textContent = String(text || "");
  _msgEl.hidden = false;
}

function hideOverlay() {
  if (!_root) return;
  _root.hidden = true;
  if (_msgEl) {
    _msgEl.hidden = true;
    _msgEl.textContent = "";
  }
}

/* Subscribe to visual.analysed broadcasts so a future result panel could
 * mount on the same channel. For now the broadcast is a no-op listener
 * (the result is also returned from the fetch above) — kept here for
 * forward compatibility. */
Bridge.on("visual.analysed", () => { /* future result-panel hook */ });
