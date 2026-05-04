/** notifications.js - Toast + drawer notification surface for terminal task states.
 *
 *  Why: queueModal pops one full-screen modal at a time and discards everything
 *  the moment the operator misses it. When a teaser, PDF, and email-draft all
 *  finish 30 seconds apart the operator sees three modals fighting for focus and
 *  loses the audit trail. This module is the timeline:
 *    - Toast slides in from the right when a task ends (auto-dismiss 5s success / 8s error)
 *    - Bell icon shows unread count and opens a drawer of recent notifications
 *    - Each entry carries the runId from the bridge event envelope, so future
 *      audit-log + project-rail features can correlate notifications to tasks
 *
 *  Self-subscribing — voice.js doesn't need to wire this. notifications.init()
 *  taps Bridge directly. The legacy queueModal remains for the cinematic modal
 *  pop (operator + clients want to SEE the result); notifications run alongside. */

import * as Bridge from "./bridge-client.js";

const MAX_HISTORY = 50;
const TOAST_AUTODISMISS_MS = { success: 5000, info: 5000, error: 8000 };

const state = {
  /* Newest first. id is monotonic; runId is the bridge correlation key when present. */
  items: [],
  unread: 0,
  drawerOpen: false,
  nextId: 1,
};

let bellEl = null;
let bellCountEl = null;
let toastHostEl = null;
let drawerEl = null;

/* Cache DOM lookups — repeated getElementById calls each render are wasteful. */
function refreshDom() {
  bellEl = bellEl || document.getElementById("notifBell");
  bellCountEl = bellCountEl || document.getElementById("notifBellCount");
  toastHostEl = toastHostEl || document.getElementById("notifToasts");
  drawerEl = drawerEl || document.getElementById("notifDrawer");
}

/** Friendly label for a task kind — same vocabulary the task strip uses. */
function kindLabel(kind) {
  const map = {
    "video.edit":   "RENDER",
    "yt.short":     "RENDER",
    "yt.promo":     "PROMO",
    "yt.thumbnail": "THUMB",
    "shoot.report": "REPORT",
    "watermark":    "WATERMARK",
    "outreach":     "OUTREACH",
    "pdf":          "PDF",
    "inbox":        "INBOX",
  };
  return map[kind] || (kind || "ALERT").toUpperCase().replace(/\./g, " ");
}

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

function updateBellCount() {
  if (!bellCountEl) return;
  if (state.unread > 0) {
    bellCountEl.textContent = state.unread > 99 ? "99+" : String(state.unread);
    bellEl.classList.add("is-unread");
  } else {
    bellCountEl.textContent = "";
    bellEl.classList.remove("is-unread");
  }
}

/** Build a single drawer row for an item — same shape used in toast (without dismiss). */
function buildItem(item, opts = {}) {
  const row = document.createElement("div");
  row.className = `notif notif--${item.kind}`;
  if (opts.toast) row.classList.add("notif--toast");

  const head = document.createElement("div");
  head.className = "notif__head";
  const badge = document.createElement("span");
  badge.className = "notif__kind";
  badge.textContent = kindLabel(item.taskKind || item.kind);
  const title = document.createElement("span");
  title.className = "notif__title";
  title.textContent = item.title;
  head.append(badge, title);

  const meta = document.createElement("span");
  meta.className = "notif__time";
  meta.textContent = timeAgo(item.ts);
  head.appendChild(meta);

  row.appendChild(head);

  if (item.body) {
    const body = document.createElement("div");
    body.className = "notif__body";
    body.textContent = item.body;
    row.appendChild(body);
  }

  if (item.action) {
    const actions = document.createElement("div");
    actions.className = "notif__actions";
    const btn = document.createElement(item.action.href ? "a" : "button");
    btn.className = "notif__action";
    btn.textContent = item.action.label;
    if (item.action.href) {
      btn.href = item.action.href;
      btn.target = "_blank";
    } else if (item.action.onClick) {
      btn.addEventListener("click", item.action.onClick);
    }
    actions.appendChild(btn);
    row.appendChild(actions);
  }

  /* Toast-only: an explicit dismiss × so the operator can banish a sticky one. */
  if (opts.toast) {
    const dismiss = document.createElement("button");
    dismiss.className = "notif__dismiss";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => row.remove());
    row.appendChild(dismiss);
  }
  return row;
}

function renderToast(item) {
  refreshDom();
  if (!toastHostEl) return;
  const row = buildItem(item, { toast: true });
  toastHostEl.appendChild(row);
  /* Auto-dismiss with hover-pause: while mouse is over, restart timer on leave. */
  let timer = null;
  const start = () => {
    timer = setTimeout(() => row.remove(), TOAST_AUTODISMISS_MS[item.kind] || 5000);
  };
  start();
  row.addEventListener("mouseenter", () => { clearTimeout(timer); });
  row.addEventListener("mouseleave", start);
}

function renderDrawer() {
  refreshDom();
  if (!drawerEl) return;
  while (drawerEl.firstChild) drawerEl.removeChild(drawerEl.firstChild);

  const head = document.createElement("div");
  head.className = "notif-drawer__head";
  const title = document.createElement("div");
  title.className = "notif-drawer__title";
  title.textContent = "NOTIFICATIONS";
  const actions = document.createElement("div");
  actions.className = "notif-drawer__actions";
  const clear = document.createElement("button");
  clear.className = "notif-drawer__clear";
  clear.textContent = "CLEAR";
  clear.addEventListener("click", () => clearAll());
  /* Explicit close button — discoverable for operators who don't reach for Esc or
   * the bell. Mirrors the X-style close on the settings + audit overlays. */
  const close = document.createElement("button");
  close.className = "notif-drawer__close";
  close.setAttribute("aria-label", "Close notifications");
  close.textContent = "×";
  close.addEventListener("click", () => closeDrawer());
  actions.append(clear, close);
  head.append(title, actions);
  drawerEl.appendChild(head);

  const list = document.createElement("div");
  list.className = "notif-drawer__list";
  if (state.items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "notif-drawer__empty";
    empty.textContent = "All clear.";
    list.appendChild(empty);
  } else {
    for (const item of state.items) list.appendChild(buildItem(item));
  }
  drawerEl.appendChild(list);
}

function openDrawer() {
  refreshDom();
  if (!drawerEl) return;
  state.drawerOpen = true;
  state.unread = 0;
  updateBellCount();
  drawerEl.hidden = false;
  /* Mark all read on open — operator opening the drawer is implicit acknowledgement. */
  for (const i of state.items) i.read = true;
  renderDrawer();
}

function closeDrawer() {
  if (!drawerEl) return;
  state.drawerOpen = false;
  drawerEl.hidden = true;
}

function clearAll() {
  state.items = [];
  state.unread = 0;
  updateBellCount();
  renderDrawer();
}

/**
 * Add a notification. Renders a toast immediately, prepends to history,
 * increments the bell unread count.
 *
 * @param {{kind: 'success'|'error'|'info', title: string, body?: string, runId?: string, taskKind?: string, action?: {label: string, href?: string, onClick?: () => void}}} item
 */
export function add(item) {
  const entry = {
    id: state.nextId++,
    kind: item.kind || "info",
    title: item.title || "(no title)",
    body: item.body || null,
    runId: item.runId,
    taskKind: item.taskKind,
    action: item.action,
    ts: Date.now(),
    read: state.drawerOpen,    /* if drawer is already open, treat as read */
  };
  state.items.unshift(entry);
  if (state.items.length > MAX_HISTORY) state.items.length = MAX_HISTORY;
  if (!entry.read) state.unread++;
  updateBellCount();
  renderToast(entry);
  if (state.drawerOpen) renderDrawer();
}

/** Wire DOM + bridge subscriptions. Called once at boot. */
export function init() {
  refreshDom();
  if (bellEl) {
    bellEl.addEventListener("click", () => {
      if (state.drawerOpen) closeDrawer();
      else openDrawer();
    });
  }
  /* Esc closes the drawer — consistent with settings modal. */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.drawerOpen) closeDrawer();
  });

  /* Subscribe to terminal task events. Voice.js's queueModal still pops the
   * cinematic result modal — we run alongside as the persistent log. */
  Bridge.on("task.complete", (m) => {
    const d = m.data || {};
    /* Skip benign / non-headline tasks if we ever add them — for now every
     * completion is worth a notification. */
    const action = d.finalUrl ? { label: "OPEN", href: `http://localhost:8766${d.finalUrl}` }
                : d.pdfUrl   ? { label: "OPEN", href: `http://localhost:8766${d.pdfUrl}` }
                : null;
    const durationLabel = d.durationMs ? ` · ${Math.round(d.durationMs / 1000)}s` : "";
    add({
      kind: "success",
      title: d.label || kindLabel(d.kind),
      body: `Completed${durationLabel}.`,
      runId: m.runId || d.runId,
      taskKind: d.kind,
      action,
    });
  });

  Bridge.on("task.error", (m) => {
    const d = m.data || {};
    add({
      kind: "error",
      title: d.label || kindLabel(d.kind),
      body: d.error || "Failed (no detail).",
      runId: m.runId || d.runId,
      taskKind: d.kind,
    });
  });

  Bridge.on("inbox.dropped", (m) => {
    const d = m.data || {};
    add({
      kind: "info",
      title: `Inbox · ${d.name}`,
      body: `${d.kind} · ${d.sizeKB ? d.sizeKB + "KB" : "size unknown"}`,
      taskKind: "inbox",
    });
  });

  /* Bridge-side notifications module fires `notify.<kind>` events. Map severity →
   * our kind vocabulary (info/success/error). The drawer + bell pick up automatically. */
  const SEVERITY_TO_KIND = { info: "info", success: "success", warn: "info", alert: "error" };
  Bridge.on("notify.*", (m) => {
    const d = m.data || {};
    if (!d.kind || !d.title) return;
    add({
      kind: SEVERITY_TO_KIND[d.severity] || "info",
      title: d.title,
      body: d.body,
      taskKind: d.kind,                      /* preserve specific kind for filtering / icons */
      action: d.action,
    });
  });
}

/** Test harness — fire a fake notification from the dev console for layout iteration. */
export function _devSimulate(kind = "success") {
  const samples = {
    success: { kind: "success", taskKind: "video.edit", title: "the press car teaser", body: "Completed · 142s.", action: { label: "OPEN", onClick: () => console.log("opened") } },
    error:   { kind: "error",   taskKind: "yt.thumbnail", title: "YouTube thumbnail", body: "Vision model returned no usable hero shot." },
    info:    { kind: "info",    taskKind: "inbox", title: "Inbox · DSC0173.jpg", body: "image · 4123KB" },
  };
  add(samples[kind] || samples.success);
}
window._notifSim = _devSimulate;
