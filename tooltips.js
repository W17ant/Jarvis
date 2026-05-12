// @ts-check
/** tooltips.js — HUD-styled hover tooltips.
 *
 *  Why a custom layer instead of the native browser tooltip:
 *    - Native tooltips have a 500-1000ms appear delay, no styling control,
 *      and break the HUD's terminal-cyan aesthetic.
 *    - This module renders a single shared tooltip element, positioned
 *      relative to the hovered target, with monospace + cyan border to match
 *      everything else.
 *
 *  Source of truth on text:
 *    - data-tip="..."  is read first
 *    - title="..."     is read as fallback (so existing UI gets a free upgrade
 *                      without retagging) — and we strip the live `title` so
 *                      the browser doesn't ALSO show its own tooltip on top.
 *
 *  Behaviour:
 *    - 250ms appear delay so accidental hovers don't flash
 *    - Hides immediately on mouseleave / blur / scroll / window blur
 *    - Re-positions on every show so dynamic-layout HUDs (collapsing
 *      panels, drawer opens) don't end up with stale anchor coordinates.
 *    - Auto-disabled for touch devices (no hover semantics).
 *
 *  Setup: voice.js (or the HUD bootstrap) imports + calls init() once.
 *  Mark elements with `data-tip="…"` (or just rely on `title="…"`) and the
 *  module discovers them via event delegation — no per-element wiring. */

const APPEAR_DELAY_MS = 250;
const SAFE_MARGIN_PX = 8;

let _host = null;        // the shared tooltip DOM node
let _showTimer = 0;
let _currentTarget = null;
let _initialised = false;

/** Public entry. Idempotent. */
export function init() {
  if (_initialised) return;
  _initialised = true;

  /* Skip on touch-only devices — hover doesn't make sense, and forcing a
   * tooltip on first-tap blocks the actual click. */
  if (window.matchMedia?.("(hover: none)")?.matches) return;

  _host = document.createElement("div");
  _host.className = "hud-tip";
  _host.setAttribute("role", "tooltip");
  _host.hidden = true;
  document.body.appendChild(_host);

  /* Event delegation — one listener at the root, fires for any descendant
   * with data-tip / title. Avoids per-element wiring and works for
   * dynamically-added elements (modals, refs picker, etc) without any
   * extra book-keeping. */
  document.addEventListener("mouseover", _onOver, true);
  document.addEventListener("mouseout",  _onOut,  true);
  document.addEventListener("focusin",   _onFocusIn);
  document.addEventListener("focusout",  _onFocusOut);
  /* Hide on any state change that might invalidate the tooltip's position. */
  window.addEventListener("scroll",  hide, true);
  window.addEventListener("resize",  hide);
  window.addEventListener("blur",    hide);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
}

/** Find the nearest ancestor with a tip (data-tip or title). Returns the
 *  element + the resolved tip text, or null. */
function _resolveTipped(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (!(el instanceof Element)) continue;
    const tip = el.getAttribute("data-tip");
    if (tip) return { el, text: tip };
    const title = el.getAttribute("title");
    if (title) {
      /* Move to data-tip so the native tooltip stops showing — preserves
       * accessibility (data-tip is read by SR via aria-describedby below)
       * while killing the duplicate native bubble. Done lazily to avoid
       * scanning the whole DOM at boot. */
      el.setAttribute("data-tip", title);
      el.removeAttribute("title");
      return { el, text: title };
    }
  }
  return null;
}

function _onOver(ev) {
  const found = _resolveTipped(ev.target);
  if (!found) return;
  if (found.el === _currentTarget) return;
  _currentTarget = found.el;
  if (_showTimer) clearTimeout(_showTimer);
  _showTimer = setTimeout(() => _showFor(found.el, found.text), APPEAR_DELAY_MS);
}

function _onOut(ev) {
  /* Only hide when leaving the currently-tipped element entirely. */
  if (!_currentTarget) return;
  if (_currentTarget.contains(ev.relatedTarget)) return;
  _currentTarget = null;
  if (_showTimer) { clearTimeout(_showTimer); _showTimer = 0; }
  hide();
}

function _onFocusIn(ev) {
  /* Keyboard navigation parity: focus shows the tip without delay so users
   * tabbing through buttons get the same affordance as mouse hover. */
  const found = _resolveTipped(ev.target);
  if (!found) return;
  _currentTarget = found.el;
  _showFor(found.el, found.text);
}

function _onFocusOut() {
  _currentTarget = null;
  hide();
}

function _showFor(el, text) {
  if (!_host || !el || !text) return;
  _host.textContent = text;
  _host.hidden = false;
  /* Position: prefer below the target if there's room, else above. Clamp
   * to the viewport so a tooltip on the last visible button doesn't get
   * clipped by the right edge. */
  const r = el.getBoundingClientRect();
  /* Render once at 0,0 so we can read the tip's natural size, then
   * reposition. Cheaper than measuring before append and avoids reflow
   * thrash on first paint. */
  _host.style.left = "0px";
  _host.style.top  = "0px";
  const tipRect = _host.getBoundingClientRect();

  const spaceBelow = window.innerHeight - r.bottom;
  const placeAbove = spaceBelow < tipRect.height + SAFE_MARGIN_PX;
  let top = placeAbove ? r.top - tipRect.height - SAFE_MARGIN_PX : r.bottom + SAFE_MARGIN_PX;
  let left = r.left + (r.width / 2) - (tipRect.width / 2);
  /* Horizontal clamp — keep at least SAFE_MARGIN_PX from the viewport edge. */
  left = Math.max(SAFE_MARGIN_PX, Math.min(left, window.innerWidth - tipRect.width - SAFE_MARGIN_PX));
  /* Vertical clamp — same idea, mostly defensive. */
  top  = Math.max(SAFE_MARGIN_PX, Math.min(top,  window.innerHeight - tipRect.height - SAFE_MARGIN_PX));
  _host.style.left = `${Math.round(left)}px`;
  _host.style.top  = `${Math.round(top)}px`;
  _host.dataset.placement = placeAbove ? "above" : "below";

  /* Accessibility: link the tipped element to the tooltip so screen
   * readers announce the description on focus. */
  if (!_host.id) _host.id = "hud-tip-host";
  el.setAttribute("aria-describedby", _host.id);
}

function hide() {
  if (!_host) return;
  _host.hidden = true;
  if (_currentTarget) {
    try { _currentTarget.removeAttribute("aria-describedby"); } catch {}
  }
}
