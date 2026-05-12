/** inbox.js - Smart Inbox HUD panel.
 *
 *  Polls /inbox every 5min for the normalised item list. Renders the
 *  top N items inline with kind-specific icons + sender/event/title +
 *  time hint. The "↻ refresh" button fires a forced re-fetch. The
 *  hint copy steers the operator toward voice triage rather than
 *  click-everything UX — voice command "brief me" is the primary
 *  affordance, the panel is the visual reminder.
 *
 *  Doesn't drive layout — that's layout.js. Doesn't own the briefing
 *  tool — that's a bridge tool the LLM dispatches. This module is
 *  purely the visual surface.
 */

const BRIDGE_BASE = "http://localhost:8766";
const POLL_INTERVAL_MS = 5 * 60_000;
const MAX_RENDERED = 5;

let _listEl = null;
let _emptyEl = null;
let _hintEl = null;
let _pollTimer = null;

/** Format a unix-ms timestamp as a human-friendly relative time. */
function _fmtWhen(when) {
  if (!when) return "";
  const minutes = Math.round((when - Date.now()) / 60000);
  if (minutes >= 0 && minutes < 60) return `in ${minutes}m`;
  if (minutes < 0 && minutes > -60) return `${Math.abs(minutes)}m ago`;
  if (minutes >= 60 && minutes < 1440) return `in ${Math.round(minutes / 60)}h`;
  if (minutes < -60 && minutes > -1440) return `${Math.round(Math.abs(minutes) / 60)}h ago`;
  /* Fall back to the date stamp for far-out items. */
  const d = new Date(when);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Map kind to a single-character icon. Keeps the row tight on the small
 *  panel; the colour-coding comes from CSS. */
function _kindIcon(kind) {
  switch (kind) {
    case "email": return "✉";
    case "event": return "◷";
    case "reminder": return "✓";
    default: return "•";
  }
}

/** Build a clickable inbox row. Click → opens the underlying app at this
 *  item via the act_on_inbox_item bridge tool. We POST to /tool-dispatch
 *  rather than going through the LLM because there's no ambiguity — the
 *  operator clicked a specific row, no intent inference needed. */
function _renderItem(it, ordinal) {
  const li = document.createElement("li");
  li.className = `inbox__item inbox__item--${it.kind}`;
  if (it.urgency_hints?.isImminent) li.classList.add("inbox__item--imminent");
  if (it.urgency_hints?.unread) li.classList.add("inbox__item--unread");
  li.setAttribute("role", "button");
  li.setAttribute("tabindex", "0");
  li.setAttribute("aria-label", `Open ${it.kind}: ${it.what}`);
  li.title = `Click to open in ${it.kind === "email" ? "Mail" : it.kind === "event" ? "Calendar" : "Reminders"}.app`;

  const icon = document.createElement("span");
  icon.className = "inbox__icon";
  icon.textContent = _kindIcon(it.kind);
  li.appendChild(icon);

  const body = document.createElement("div");
  body.className = "inbox__body";
  const top = document.createElement("div");
  top.className = "inbox__top";
  const who = document.createElement("span");
  who.className = "inbox__who";
  who.textContent = String(it.who || "").slice(0, 28);
  const when = document.createElement("span");
  when.className = "inbox__when";
  when.textContent = _fmtWhen(it.when);
  top.append(who, when);
  body.appendChild(top);
  const what = document.createElement("div");
  what.className = "inbox__what";
  what.textContent = String(it.what || "");
  body.appendChild(what);
  li.appendChild(body);

  /* Click + keyboard activation. Same handler so screen readers + mouse
   * users get parity. */
  const onActivate = (e) => {
    e.preventDefault();
    _openItem(ordinal, it);
  };
  li.addEventListener("click", onActivate);
  li.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") onActivate(e);
  });

  return li;
}

/** Open an inbox item in its native app via act_on_inbox_item. We hit the
 *  bridge directly (POST /tool/act_on_inbox_item) — no LLM round-trip,
 *  the click is already unambiguous intent. */
async function _openItem(ordinal, it) {
  try {
    /* Best-effort: bridge has no /tool/<name> endpoint per Sprint 2 recon
     * — tools dispatch through WS. We send a synthetic LLM ask that names
     * the action verbatim; the LLM rendering is "operator clicked, opening
     * <whatever>" but the side effect is what matters. */
    const r = await fetch("http://localhost:8766/tool-dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "act_on_inbox_item", args: { ordinal, action: "open", confirmed: true } }),
    });
    if (!r.ok) {
      console.warn("[inbox] open failed:", await r.text());
    }
  } catch (e) {
    console.warn("[inbox] open dispatch failed:", e.message);
  }
}

async function _poll(force = false) {
  if (!_listEl) return;
  try {
    const url = `${BRIDGE_BASE}/inbox${force ? "?force=1" : ""}`;
    const r = await fetch(url, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "inbox fetch failed");
    const items = (j.items || []).slice(0, MAX_RENDERED);
    _listEl.replaceChildren();
    if (!items.length) {
      if (_emptyEl) _emptyEl.hidden = false;
      if (_hintEl) _hintEl.hidden = false;
      return;
    }
    items.forEach((it, idx) => _listEl.appendChild(_renderItem(it, idx + 1)));
    if (_emptyEl) _emptyEl.hidden = true;
    if (_hintEl) _hintEl.hidden = false;
  } catch {
    /* Bridge offline / unreachable — keep whatever was last rendered;
     * the operator's bridge-offline toast already tells them. */
  }
}

export function init() {
  _listEl = document.getElementById("inboxList");
  _emptyEl = document.getElementById("inboxEmpty");
  _hintEl = document.getElementById("inboxHint");
  if (!_listEl) return;

  document.getElementById("inboxRefreshBtn")?.addEventListener("click", () => _poll(true));

  /* First fetch immediately, then on interval. */
  _poll();
  _pollTimer = setInterval(() => _poll(), POLL_INTERVAL_MS);
}

export function refresh() { _poll(true); }
