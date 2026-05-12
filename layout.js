/** layout.js - Editable widget layout for the side columns.
 *
 *  Why: each operator has a different mental priority. Marcus wants comms front-and-
 *  centre, Daniel wants weather + clock prominent, the visiting client wants nothing
 *  but the speedo. iPad-style edit-and-rearrange lets each operator (per profile)
 *  size and position the side widgets without the engineering team having to ship a
 *  new build per role.
 *
 *  Design constraints:
 *    - Centre column (speedo) is FIXED — it's the brand identity, never reflowable.
 *    - Bottom telemetry strip is FIXED — full-width audio waveform sits there.
 *    - Top calendar / clock strip is FIXED — system clock anchors at top-right.
 *    - The two side strips (column 1 left + column 5 right) hold the editable widgets,
 *      each spanning rows 2-4 (3 cells per side, 6 cells total).
 *
 *  Each widget gets `data-widget-id="..."` in HTML. layout.js reads a per-profile
 *  layout from localStorage (`jarvis.<profile>.layout`) and applies it via inline
 *  grid-row + grid-column overrides. Sizes:
 *    - "small"  = 1 cell  (1 row tall)
 *    - "medium" = 2 cells (2 rows tall)
 *    - "large"  = 3 cells (full column)
 *
 *  Edit mode (Cmd+L): adds .is-edit-layout to body. Each widget shows a drag handle
 *  + size cycler. HTML5 drag-and-drop swaps positions within its column. Esc / Cmd+L
 *  again exits and persists. Default layout matches the as-built positions so
 *  operators with no preferences stored see no change.
 *
 *  Persistence: per profile via Storage module. The format is small + forgiving —
 *  unknown widget IDs are ignored, missing widgets fall back to defaults. */

import * as Storage from "./storage.js";

const STORAGE_KEY = "layout";

/* The fixed side-column slots. Each side has 3 cells (rows 2-4). The default layout
 * mirrors the original hardcoded grid placement so the kiosk looks identical until
 * the operator opts in to a custom arrangement. */
const SIDES = ["left", "right"];
const ROWS_PER_SIDE = 3;          // rows 2..4 in the parent grid

const DEFAULT_LAYOUT = {
  left: [
    /* CORE TELEMETRY claims the full left rail (rows 2-4) — the month
     * panel was retired in the white-label rebuild because the date was
     * already visible in the calendar strip + clock panel. */
    { id: "system", size: "large" },
  ],
  right: [
    /* Sprint 8: inbox replaces launch in the default layout. The launch
     * dock's items are equivalent to "open <app>" voice commands; the
     * inbox panel is the new "what's important right now" surface that
     * operators value daily. Existing operators with persisted layouts
     * keep what they had — this only affects fresh installs. To restore
     * launch, Cmd+L → drag it back from the widget tray. */
    { id: "clock",   size: "small" },
    { id: "weather", size: "small" },
    { id: "inbox",   size: "small" },
  ],
};

const SIZE_TO_ROWS = { small: 1, medium: 2, large: 3 };
const SIZE_CYCLE = ["small", "medium", "large"];

/* Side → grid column. Defined here so the apply step doesn't have to peek at CSS. */
const SIDE_TO_COL = { left: "1", right: "5" };

let editing = false;

/** Read the persisted layout. Returns the default if nothing's stored or the JSON
 *  parses badly. The shape is tolerant — widgets missing from storage fall back to
 *  their default position so adding a new widget in HTML doesn't require migration.
 *  Why the "month" purge: the panel--month widget was retired in the white-label
 *  rebuild but stale localStorage from prior runs still references it; if any
 *  side carries it we discard the saved layout and reapply the new default so
 *  CORE TELEMETRY can claim its full rail height. */
function readLayout() {
  const raw = Storage.get(STORAGE_KEY);
  if (!raw) return cloneDefault();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.left || !parsed?.right) return cloneDefault();
    const hasRetired = (slots) => Array.isArray(slots) && slots.some((s) => s?.id === "month" || s?.id === "comms");
    if (hasRetired(parsed.left) || hasRetired(parsed.right)) {
      Storage.remove(STORAGE_KEY);
      return cloneDefault();
    }
    return parsed;
  } catch {
    return cloneDefault();
  }
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
}

function persistLayout(layout) {
  Storage.set(STORAGE_KEY, JSON.stringify(layout));
}

/** Walk a side's slot list and compute each widget's grid-row range. The grid's
 *  first content row is row 2 (row 1 is the calendar strip), so add 2 to each
 *  cumulative offset. Widgets that overflow the 3-row budget are truncated to
 *  whatever space remains — predictable degradation. */
function computeRowRanges(slots) {
  let cursor = 2;          // grid-row starts at 2 (after the top calendar strip)
  const out = [];
  for (const slot of slots) {
    const rows = SIZE_TO_ROWS[slot.size] || 1;
    /* Clamp so we don't overflow row 4 (the last content row before telemetry strip). */
    const remaining = (2 + ROWS_PER_SIDE) - cursor;
    if (remaining <= 0) { out.push(null); continue; }
    const span = Math.min(rows, remaining);
    out.push({ start: cursor, span });
    cursor += span;
  }
  return out;
}

/** Apply a layout to the DOM. Sets grid-column + grid-row inline on each panel.
 *  Widgets present in the DOM but missing from the layout get hidden — the operator
 *  may have removed them via edit mode in the future. */
function applyLayout(layout) {
  /* Track all data-widget-id panels so we can hide any that aren't placed. */
  const allPanels = [...document.querySelectorAll("[data-widget-id]")];
  const placed = new Set();

  for (const side of SIDES) {
    const slots = layout[side] || [];
    const rowRanges = computeRowRanges(slots);
    const col = SIDE_TO_COL[side];
    slots.forEach((slot, i) => {
      const panel = document.querySelector(`[data-widget-id="${slot.id}"]`);
      if (!panel) return;
      placed.add(slot.id);
      const range = rowRanges[i];
      if (!range) {
        /* No room — hide rather than overlap. */
        panel.style.display = "none";
        return;
      }
      panel.style.display = "";
      panel.style.gridColumn = col;
      panel.style.gridRow = `${range.start} / span ${range.span}`;
      panel.dataset.widgetSize = slot.size;
      panel.dataset.widgetSide = side;
    });
  }

  /* Hide any widget the layout doesn't reference — keeps the canvas clean if the
   * operator has explicitly excluded one. */
  for (const p of allPanels) {
    if (!placed.has(p.dataset.widgetId)) p.style.display = "none";
  }
}

/* ---------- EDIT MODE ---------- */

/** Enter edit mode: add chrome class, show resize cyclers + drag handles on every
 *  data-widget-id panel. */
function enterEdit() {
  if (editing) return;
  editing = true;
  document.body.classList.add("is-edit-layout");
  for (const panel of document.querySelectorAll("[data-widget-id]")) {
    decoratePanel(panel);
  }
  showHint();
}

/** Exit edit mode: persist the current layout (already mutated by drag/resize
 *  handlers), strip chrome class + remove decorations. */
function exitEdit() {
  if (!editing) return;
  editing = false;
  document.body.classList.remove("is-edit-layout");
  for (const panel of document.querySelectorAll("[data-widget-id]")) {
    undecoratePanel(panel);
  }
  hideHint();
}

function decoratePanel(panel) {
  /* Drag handle + size cycler — both injected as the first children so they overlay
   * the existing widget content. CSS positions them in the corners. */
  if (panel.querySelector(".widget-edit__handle")) return;
  panel.draggable = true;

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "widget-edit__handle";
  handle.setAttribute("aria-label", "Drag to swap");
  handle.textContent = "⋮⋮";
  panel.appendChild(handle);

  const cycler = document.createElement("button");
  cycler.type = "button";
  cycler.className = "widget-edit__cycler";
  cycler.setAttribute("aria-label", "Cycle size");
  cycler.textContent = sizeLabel(panel.dataset.widgetSize || "small");
  cycler.addEventListener("click", (e) => {
    e.stopPropagation();
    cyclePanelSize(panel, cycler);
  });
  panel.appendChild(cycler);

  /* HTML5 drag/drop on the panel itself — pointerdown on the handle is enough to
   * trigger drag because draggable=true is set on the parent. */
  panel.addEventListener("dragstart", onDragStart);
  panel.addEventListener("dragover",  onDragOver);
  panel.addEventListener("drop",      onDrop);
  panel.addEventListener("dragend",   onDragEnd);
}

function undecoratePanel(panel) {
  panel.draggable = false;
  panel.querySelector(".widget-edit__handle")?.remove();
  panel.querySelector(".widget-edit__cycler")?.remove();
  panel.removeEventListener("dragstart", onDragStart);
  panel.removeEventListener("dragover",  onDragOver);
  panel.removeEventListener("drop",      onDrop);
  panel.removeEventListener("dragend",   onDragEnd);
  panel.classList.remove("is-drag-source", "is-drag-target");
}

function sizeLabel(size) {
  return { small: "1×1", medium: "1×2", large: "1×3" }[size] || "1×1";
}

function cyclePanelSize(panel, cyclerBtn) {
  const layout = readLayout();
  const id = panel.dataset.widgetId;
  const side = panel.dataset.widgetSide;
  if (!side) return;
  const slot = (layout[side] || []).find((s) => s.id === id);
  if (!slot) return;
  const idx = SIZE_CYCLE.indexOf(slot.size);
  slot.size = SIZE_CYCLE[(idx + 1) % SIZE_CYCLE.length];
  applyLayout(layout);
  persistLayout(layout);
  cyclerBtn.textContent = sizeLabel(slot.size);
  /* Re-decorate so the existing handle/cycler buttons pick up the new layout cells.
   * Cheaper than a full re-decorate to leave the cycler's text up-to-date. */
}

/* ---------- DRAG / DROP ---------- */

let dragSourceId = null;

function onDragStart(e) {
  const panel = e.currentTarget;
  dragSourceId = panel.dataset.widgetId;
  panel.classList.add("is-drag-source");
  /* Required for Firefox to actually fire drag events. */
  e.dataTransfer.setData("text/plain", dragSourceId);
  e.dataTransfer.effectAllowed = "move";
}

function onDragOver(e) {
  if (!dragSourceId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  e.currentTarget.classList.add("is-drag-target");
}

function onDrop(e) {
  e.preventDefault();
  const targetPanel = e.currentTarget;
  const targetId = targetPanel.dataset.widgetId;
  targetPanel.classList.remove("is-drag-target");
  if (!dragSourceId || dragSourceId === targetId) return;

  /* Swap the slots in the layout. Cross-side swaps are allowed — the right widget
   * moves to the left column and vice versa. Sizes are preserved on each widget. */
  const layout = readLayout();
  const a = locate(layout, dragSourceId);
  const b = locate(layout, targetId);
  if (!a || !b) return;

  const tmp = layout[a.side][a.idx];
  layout[a.side][a.idx] = layout[b.side][b.idx];
  layout[b.side][b.idx] = tmp;

  applyLayout(layout);
  persistLayout(layout);
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("is-drag-source");
  document.querySelectorAll(".is-drag-target").forEach((el) => el.classList.remove("is-drag-target"));
  dragSourceId = null;
}

function locate(layout, id) {
  for (const side of SIDES) {
    const idx = (layout[side] || []).findIndex((s) => s.id === id);
    if (idx >= 0) return { side, idx };
  }
  return null;
}

/* ---------- HINT BANNER ---------- */

let hintEl = null;
function showHint() {
  if (hintEl) return;
  hintEl = document.createElement("div");
  hintEl.className = "widget-edit__hint";
  hintEl.textContent = "EDITING LAYOUT — drag widgets to swap, click size to cycle, Esc to exit.";
  document.body.appendChild(hintEl);
}
function hideHint() {
  if (!hintEl) return;
  hintEl.remove();
  hintEl = null;
}

/* ---------- INIT ---------- */

/** Wire keybinds + apply persisted layout. Called once at boot. */
export function init() {
  applyLayout(readLayout());

  /* Re-apply layout on viewport resize. Why: inline grid-row writes from the
   * last apply persist on the panels, so if a future media query changes the
   * grid template (e.g. a narrow-display fallback), the stale inline values
   * would leak across breakpoints. Re-asserting from the saved layout is
   * idempotent and means any future breakpoint-aware sizing has a hook.
   * Debounced to 150ms so we don't thrash during drag-resize on macOS. */
  let _resizeTimer = null;
  window.addEventListener("resize", () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
      _resizeTimer = null;
      applyLayout(readLayout());
    }, 150);
  });

  document.addEventListener("keydown", (e) => {
    /* Cmd/Ctrl + L toggles edit mode. The L is for Layout — we don't conflict with
     * Cmd+K (palette) / Cmd+D (demo) / Cmd+H (history). */
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      if (editing) exitEdit(); else enterEdit();
    } else if (e.key === "Escape" && editing) {
      e.preventDefault();
      exitEdit();
    }
  });

  /* Discoverability: settings modal exposes EDIT LAYOUT + RESET LAYOUT buttons.
   * Wire them here so layout.js owns the entire UX. Edit closes the settings modal
   * first so the operator can actually see + drag the widgets. */
  document.getElementById("settingsEditLayoutBtn")?.addEventListener("click", () => {
    document.getElementById("settingsModal")?.setAttribute("hidden", "");
    enterEdit();
  });
  document.getElementById("settingsResetLayoutBtn")?.addEventListener("click", () => {
    if (confirm("Reset widget layout to defaults? Your size + position changes will be lost.")) {
      reset();
    }
  });
}

/** Public API: reset to default. Used by a "RESET LAYOUT" link in settings. */
export function reset() {
  persistLayout(cloneDefault());
  applyLayout(cloneDefault());
}

/** Public API: enter edit mode programmatically (used by settings "EDIT LAYOUT" button). */
export function edit() { enterEdit(); }
