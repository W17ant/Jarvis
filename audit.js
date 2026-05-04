/** audit.js - Audit log viewer (read-only).
 *
 *  Why: the bridge writes data/audit/YYYY-MM.jsonl on every tool dispatch. This
 *  module reads it via /audit, renders a paginated list with operator + tool
 *  filters. No rerun-from-here in v1 — pure observation surface for "who ran
 *  what when". Future undo (P2.3) will add an action column.
 *
 *  Open from the settings modal. Esc closes. Refresh button re-fetches.
 *  Filters refresh inline. */

let overlayEl = null;
let listEl = null;
let summaryEl = null;
let operatorSelect = null;
let toolSelect = null;
let refreshBtn = null;
let closeBtn = null;
let isOpen = false;

const PAGE_LIMIT = 200;

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDuration(ms) {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Build a single-row entry. */
function buildRow(entry) {
  const row = document.createElement("div");
  row.className = `audit-row${entry.error ? " audit-row--error" : ""}`;

  const head = document.createElement("div");
  head.className = "audit-row__head";

  const time = document.createElement("span");
  time.className = "audit-row__time";
  time.textContent = fmtTime(entry.ts);

  const op = document.createElement("span");
  op.className = "audit-row__operator";
  op.textContent = entry.operator || "—";

  const tool = document.createElement("span");
  tool.className = "audit-row__tool";
  tool.textContent = entry.tool;

  const dur = document.createElement("span");
  dur.className = "audit-row__duration";
  dur.textContent = fmtDuration(entry.durationMs);

  head.append(time, op, tool, dur);
  row.appendChild(head);

  /* Args summary — a compact preview of what the tool was called with. */
  if (entry.args && Object.keys(entry.args).length > 0) {
    const args = document.createElement("div");
    args.className = "audit-row__args";
    args.textContent = JSON.stringify(entry.args).slice(0, 240);
    row.appendChild(args);
  }

  if (entry.error) {
    const err = document.createElement("div");
    err.className = "audit-row__error";
    err.textContent = `error: ${entry.error}`;
    row.appendChild(err);
  }

  return row;
}

async function load() {
  if (!listEl) return;
  listEl.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "audit-overlay__empty";
  empty.textContent = "Loading…";
  listEl.appendChild(empty);

  const params = new URLSearchParams();
  if (operatorSelect.value) params.set("operator", operatorSelect.value);
  if (toolSelect.value) params.set("tool", toolSelect.value);
  params.set("limit", String(PAGE_LIMIT));

  let data;
  try {
    const r = await fetch(`http://localhost:8766/audit?${params}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    data = await r.json();
  } catch (e) {
    listEl.replaceChildren();
    const err = document.createElement("div");
    err.className = "audit-overlay__empty";
    err.textContent = `Couldn't reach the bridge — ${e.message}`;
    listEl.appendChild(err);
    return;
  }

  /* Summary (top-right of header) — total events, distinct operators + tools. */
  const s = data.summary || {};
  summaryEl.textContent = s.total
    ? `${s.total} events · ${s.operators?.length || 0} operators · ${s.tools?.length || 0} tools`
    : "no audit history yet";

  /* Refresh filter dropdowns from the summary so they only contain values that
   * actually appear in the log. Preserve current selection if still valid. */
  populateFilter(operatorSelect, s.operators || []);
  populateFilter(toolSelect, s.tools || []);

  /* Render entries — newest first (server already sorted). */
  listEl.replaceChildren();
  const entries = data.entries || [];
  if (entries.length === 0) {
    const e = document.createElement("div");
    e.className = "audit-overlay__empty";
    e.textContent = "No matching entries.";
    listEl.appendChild(e);
    return;
  }
  for (const entry of entries) listEl.appendChild(buildRow(entry));
}

function populateFilter(select, options) {
  const current = select.value;
  /* Keep the leading "all" option (children[0]), clear the rest. */
  while (select.children.length > 1) select.removeChild(select.children[1]);
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    select.appendChild(o);
  }
  /* Restore selection if it still exists. */
  if (options.includes(current)) select.value = current;
}

export function open() {
  if (!overlayEl) return;
  isOpen = true;
  overlayEl.hidden = false;
  load();
}

export function close() {
  if (!overlayEl) return;
  isOpen = false;
  overlayEl.hidden = true;
}

/** Wire DOM. Bound by index.html bootstrap. */
export function init() {
  overlayEl = document.getElementById("auditOverlay");
  listEl = document.getElementById("auditList");
  summaryEl = document.getElementById("auditSummary");
  operatorSelect = document.getElementById("auditFilterOperator");
  toolSelect = document.getElementById("auditFilterTool");
  refreshBtn = document.getElementById("auditRefresh");
  closeBtn = document.getElementById("auditClose");
  if (!overlayEl) return;

  refreshBtn?.addEventListener("click", load);
  closeBtn?.addEventListener("click", close);
  operatorSelect?.addEventListener("change", load);
  toolSelect?.addEventListener("change", load);

  /* Click outside the panel dismisses. */
  overlayEl.addEventListener("click", (e) => { if (e.target === overlayEl) close(); });

  /* Esc closes. */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) close();
  });

  /* Settings modal's "VIEW AUDIT LOG" button opens us. */
  const fromSettings = document.getElementById("settingsAuditBtn");
  fromSettings?.addEventListener("click", open);
}
