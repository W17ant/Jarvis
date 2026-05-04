/** usage.js - Usage telemetry overlay (queries today, tool breakdown, errors, fal spend).
 *
 *  Why: operators want a quick "what's the kiosk been up to today?" read without
 *  digging through the audit log entry-by-entry. Surfaces:
 *    - Total dispatches in the window
 *    - Error count + rate
 *    - Top tools (by volume) with avg duration
 *    - Operator breakdown
 *    - Fal.ai call count (multiply by your per-call rate for spend)
 *
 *  Opens from settings footer's "VIEW USAGE" button. Read-only, fetched on open. */

const BRIDGE = "http://localhost:8766";
let overlayEl = null;
let isOpen = false;

/** Lazy-create the overlay shell. Built via DOM methods (no innerHTML) so audit-log
 *  entries that contain user data can't inject markup. */
function ensureOverlay() {
  if (overlayEl) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "usage-overlay";
  overlayEl.hidden = true;
  overlayEl.setAttribute("role", "dialog");
  overlayEl.setAttribute("aria-modal", "true");
  overlayEl.setAttribute("aria-label", "Usage telemetry");
  document.body.appendChild(overlayEl);
  /* Click outside the panel closes — same affordance as the audit overlay. */
  overlayEl.addEventListener("click", (e) => {
    if (e.target === overlayEl) close();
  });
  return overlayEl;
}

/** Format milliseconds as a compact "1.2s" / "847ms" string. */
function fmtMs(ms) {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format a Date → HH:MM. Used for activity-span display. */
function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Render the overlay contents from a snapshot. */
function render(snapshot) {
  const el = ensureOverlay();
  while (el.firstChild) el.removeChild(el.firstChild);

  const panel = document.createElement("div");
  panel.className = "usage-overlay__panel";
  el.appendChild(panel);

  /* Head bar: title + close. */
  const head = document.createElement("div");
  head.className = "usage-overlay__head";
  const title = document.createElement("div");
  title.className = "usage-overlay__title";
  title.textContent = `USAGE · LAST ${snapshot.windowHours || 24}H`;
  const close = document.createElement("button");
  close.className = "usage-overlay__close";
  close.setAttribute("aria-label", "Close usage panel");
  close.textContent = "×";
  close.addEventListener("click", () => closeOverlay());
  head.append(title, close);
  panel.appendChild(head);

  /* Headline metrics — five tiles in a row. */
  const tiles = document.createElement("div");
  tiles.className = "usage-overlay__tiles";
  const tileSpec = [
    { label: "Dispatches", value: snapshot.total ?? 0 },
    { label: "Errors", value: snapshot.errors ?? 0, accent: snapshot.errors > 0 ? "warn" : null },
    { label: "Error rate", value: `${snapshot.errorRate ?? 0}%`, accent: snapshot.errorRate > 5 ? "warn" : null },
    { label: "Avg dur", value: fmtMs(snapshot.avgDurationMs) },
    { label: "Fal calls", value: snapshot.falCalls ?? 0, accent: snapshot.falCalls > 0 ? "spend" : null },
  ];
  for (const t of tileSpec) {
    const tile = document.createElement("div");
    tile.className = "usage-overlay__tile" + (t.accent ? ` is-${t.accent}` : "");
    const v = document.createElement("div");
    v.className = "usage-overlay__tile-value";
    v.textContent = t.value;
    const k = document.createElement("div");
    k.className = "usage-overlay__tile-label";
    k.textContent = t.label;
    tile.append(v, k);
    tiles.appendChild(tile);
  }
  panel.appendChild(tiles);

  /* Activity span sub-line. */
  if (snapshot.firstActivityTs) {
    const span = document.createElement("div");
    span.className = "usage-overlay__span";
    span.textContent = `Activity: ${fmtTime(snapshot.firstActivityTs)} → ${fmtTime(snapshot.lastActivityTs)}`;
    panel.appendChild(span);
  }

  /* Tool breakdown table. */
  const toolHead = document.createElement("div");
  toolHead.className = "usage-overlay__section-head";
  toolHead.textContent = "TOP TOOLS";
  panel.appendChild(toolHead);

  if (!snapshot.tools?.length) {
    const empty = document.createElement("div");
    empty.className = "usage-overlay__empty";
    empty.textContent = "No tool dispatches in this window.";
    panel.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "usage-overlay__tool-list";
    for (const t of snapshot.tools) {
      const row = document.createElement("li");
      row.className = "usage-overlay__tool-row";

      const name = document.createElement("span");
      name.className = "usage-overlay__tool-name";
      name.textContent = t.name;

      const tags = document.createElement("span");
      tags.className = "usage-overlay__tool-tags";
      if (t.isFal) {
        const tag = document.createElement("span");
        tag.className = "usage-overlay__tag usage-overlay__tag--fal";
        tag.textContent = "FAL";
        tags.appendChild(tag);
      }
      if (t.errors > 0) {
        const tag = document.createElement("span");
        tag.className = "usage-overlay__tag usage-overlay__tag--err";
        tag.textContent = `${t.errors} ERR`;
        tags.appendChild(tag);
      }

      const count = document.createElement("span");
      count.className = "usage-overlay__tool-count";
      count.textContent = `${t.count}×`;

      const dur = document.createElement("span");
      dur.className = "usage-overlay__tool-dur";
      dur.textContent = fmtMs(t.avgMs);

      row.append(name, tags, count, dur);
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  /* Operator breakdown — only show if more than one operator has hit the kiosk. */
  if (snapshot.operators?.length > 1) {
    const opHead = document.createElement("div");
    opHead.className = "usage-overlay__section-head";
    opHead.textContent = "BY OPERATOR";
    panel.appendChild(opHead);

    const opList = document.createElement("ul");
    opList.className = "usage-overlay__tool-list";
    for (const o of snapshot.operators) {
      const row = document.createElement("li");
      row.className = "usage-overlay__tool-row";
      const name = document.createElement("span");
      name.className = "usage-overlay__tool-name";
      name.textContent = o.name;
      const count = document.createElement("span");
      count.className = "usage-overlay__tool-count";
      count.textContent = `${o.count}×`;
      const errs = document.createElement("span");
      errs.className = "usage-overlay__tool-dur";
      errs.textContent = o.errors > 0 ? `${o.errors} err` : "—";
      row.append(name, count, errs);
      opList.appendChild(row);
    }
    panel.appendChild(opList);
  }

  /* Fal.ai cost note — direct billing link belongs in operator hands. */
  if (snapshot.falCalls > 0) {
    const note = document.createElement("div");
    note.className = "usage-overlay__note";
    note.textContent = `${snapshot.falCalls} fal.ai call${snapshot.falCalls === 1 ? "" : "s"} this window. Check fal.ai/dashboard for billed usage.`;
    panel.appendChild(note);
  }
}

async function open() {
  if (isOpen) return;
  ensureOverlay();
  overlayEl.hidden = false;
  isOpen = true;
  /* Loading state. */
  while (overlayEl.firstChild) overlayEl.removeChild(overlayEl.firstChild);
  const loading = document.createElement("div");
  loading.className = "usage-overlay__loading";
  loading.textContent = "Loading usage…";
  overlayEl.appendChild(loading);

  try {
    const r = await fetch(`${BRIDGE}/usage?windowHours=24`, { cache: "no-store" });
    if (!r.ok) throw new Error(`bridge ${r.status}`);
    const snapshot = await r.json();
    if (!snapshot.ok) throw new Error(snapshot.error || "bridge returned not-ok");
    render(snapshot);
  } catch (e) {
    while (overlayEl.firstChild) overlayEl.removeChild(overlayEl.firstChild);
    const err = document.createElement("div");
    err.className = "usage-overlay__loading";
    err.textContent = `Failed to load usage: ${e.message}`;
    overlayEl.appendChild(err);
  }
}

function closeOverlay() {
  if (!isOpen) return;
  if (overlayEl) overlayEl.hidden = true;
  isOpen = false;
}
const close = closeOverlay;          // local alias for the click-outside handler

/** Wire DOM + Esc handler. Settings footer's "VIEW USAGE" button opens this. */
export function init() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closeOverlay();
  });
  document.getElementById("settingsUsageBtn")?.addEventListener("click", open);
}
