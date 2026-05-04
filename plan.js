/** plan.js - Transparent plan stage overlay.
 *
 *  Why: when the LLM mishears the operator and calls the wrong tool, the kiosk has
 *  historically discovered this only AFTER the 90s render finished. With a tiny panel
 *  that slides in for ~1.5s every time a slow / external-side-effect tool is about to
 *  fire, the operator sees "ABOUT TO: cut a the press car teaser" and hits Esc / says "stop"
 *  if it's wrong — long before the render starts.
 *
 *  Bridge side: server.mjs broadcasts `tool.proposed` for tools in PLAN_PROPOSED_TOOLS
 *  before each call. This module subscribes, shows the panel, dismisses on a timer.
 *  Esc within the panel's lifetime triggers /cancel on the bridge.
 *
 *  Out of scope: actual interruption WITHIN tool execution. Once a tool starts, it
 *  runs to completion — /cancel sets a flag that long-running loops poll. */

import * as Bridge from "./bridge-client.js";

const PLAN_PANEL_LIFETIME_MS = 1800;  // long enough to read the summary, short enough to feel non-intrusive
let panelEl = null;
let dismissTimer = null;
let activePlan = null;

/** Lazy-create the panel DOM. Single instance — re-render on each plan event. */
function ensurePanel() {
  if (panelEl) return panelEl;
  panelEl = document.createElement("div");
  panelEl.className = "plan-panel";
  panelEl.setAttribute("aria-live", "polite");
  panelEl.hidden = true;
  document.body.appendChild(panelEl);
  return panelEl;
}

/** Render + show the panel. Auto-dismisses after PLAN_PANEL_LIFETIME_MS unless a new
 *  plan event arrives (in which case we cancel the timer + replace the contents). */
function show(plan) {
  const el = ensurePanel();
  /* Build via DOM rather than innerHTML to avoid any chance of injection from a
   * tool name / args summary the bridge built. The summary is operator-facing only. */
  while (el.firstChild) el.removeChild(el.firstChild);

  const label = document.createElement("div");
  label.className = "plan-panel__label";
  label.textContent = plan.destructive ? "ABOUT TO (CONFIRM REQUIRED)" : "ABOUT TO";
  el.appendChild(label);

  const summary = document.createElement("div");
  summary.className = "plan-panel__summary";
  summary.textContent = plan.summary || plan.tool;
  el.appendChild(summary);

  const hint = document.createElement("div");
  hint.className = "plan-panel__hint";
  hint.textContent = "Esc to stop";
  el.appendChild(hint);

  el.hidden = false;
  el.classList.remove("is-leaving");
  el.classList.add("is-entering");
  /* Force a reflow so the entrance animation re-triggers when the same plan type
   * fires twice in a row. */
  void el.offsetWidth;
  el.classList.remove("is-entering");

  activePlan = plan;
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(dismiss, PLAN_PANEL_LIFETIME_MS);
}

function dismiss() {
  if (!panelEl || panelEl.hidden) return;
  panelEl.classList.add("is-leaving");
  /* Match the CSS exit transition duration. Keep the element in the DOM during the
   * fade so the user sees it animate out, then hide. */
  setTimeout(() => { if (panelEl) panelEl.hidden = true; }, 240);
  activePlan = null;
  dismissTimer = null;
}

async function cancelActive() {
  if (!activePlan) return;
  /* Hit the bridge's existing /cancel endpoint. Long-running tools poll the abort flag
   * between iterations and bail cleanly; quick tools may already have completed and
   * the cancel is a no-op. Either way the panel goes away. */
  dismiss();
  try {
    await fetch("http://localhost:8766/cancel", { method: "POST" });
  } catch (e) {
    console.warn("[plan] /cancel failed:", e.message);
  }
}

/** Wire bridge subscription + Esc handler. Call once at boot. */
export function init() {
  Bridge.on("tool.proposed", (msg) => {
    const data = msg.data || {};
    if (!data.tool) return;
    show(data);
  });

  document.addEventListener("keydown", (e) => {
    /* Only react while the panel is up — avoids stealing Esc from settings modals etc. */
    if (e.key === "Escape" && activePlan) {
      e.preventDefault();
      cancelActive();
    }
  });
}
