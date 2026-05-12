/** history.js - Persistent conversation history surface.
 *
 *  Why: voice.js owns a 20-turn conversationHistory array that's fed to the LLM
 *  on each turn for context. Once a turn ends the operator can't review what
 *  Daniel said unless they remember. This module:
 *    - Persists the last 100 turns to localStorage so they survive a refresh
 *    - Renders a left-edge drawer with timestamped entries (newest at the bottom)
 *    - Opens via the H key (matching R for demo recording, F for fullscreen)
 *    - Hides in demo mode (driven by body.is-demo class — P1.3 territory)
 *
 *  Voice.js calls History.add(role, content) on every pushHistory + History.clear()
 *  on every clearHistory. The drawer reads from the same store. */

import * as Storage from "./storage.js";

const STORAGE_KEY = "conversation.history";
const MAX_TURNS = 100;

let entries = [];     /* { role: 'user'|'assistant', content, ts } */
let drawerOpen = false;
let drawerEl = null;

/** Load on module init. Survives refresh. */
function load() {
  const raw = Storage.get(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) entries = parsed.slice(-MAX_TURNS);
  } catch { /* corrupt JSON — start fresh */ }
}
load();

/** Persist with a tiny debounce so the storage hit is one per burst. */
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    Storage.set(STORAGE_KEY, JSON.stringify(entries));
  }, 200);
}

/**
 * Append a new turn. Voice.js calls this from pushHistory.
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {{tools?: string[]}} [meta]   Optional tool names that fired during this turn.
 */
export function add(role, content, meta = {}) {
  entries.push({
    role,
    content: String(content || ""),
    ts: Date.now(),
    tools: Array.isArray(meta.tools) ? meta.tools : undefined,
  });
  if (entries.length > MAX_TURNS) entries = entries.slice(-MAX_TURNS);
  scheduleSave();
  if (drawerOpen) renderDrawer();
}

/** Clear everything — voice.js calls this on session end / "that's all". */
export function clear() {
  entries = [];
  scheduleSave();
  if (drawerOpen) renderDrawer();
}

/** Read-only snapshot for the LLM context window. Voice.js's askLLM uses this
 *  instead of its own conversationHistory array — single source of truth. */
export function snapshot() { return entries.slice(); }

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function buildEntry(turn) {
  const row = document.createElement("div");
  row.className = `history-entry history-entry--${turn.role}`;

  const head = document.createElement("div");
  head.className = "history-entry__head";
  const role = document.createElement("span");
  role.className = "history-entry__role";
  role.textContent = turn.role === "user" ? "OPERATOR" : "ASSISTANT";
  const time = document.createElement("span");
  time.className = "history-entry__time";
  time.textContent = fmtTime(turn.ts);
  head.append(role, time);

  const body = document.createElement("div");
  body.className = "history-entry__body";
  body.textContent = turn.content;

  row.append(head, body);

  if (turn.tools?.length) {
    const tools = document.createElement("div");
    tools.className = "history-entry__tools";
    tools.textContent = `tools: ${turn.tools.join(", ")}`;
    row.appendChild(tools);
  }

  return row;
}

/* Workspaces v2: surface the active workspace label in the drawer header so
 * the operator knows which scope's conversation they're viewing. The bridge
 * /health/workspaces endpoint is the source of truth; we cache the label for
 * the duration of a render. Empty/no-workspace = no chip. */
let _activeWorkspaceLabel = null;
async function _refreshActiveWorkspaceLabel() {
  try {
    const r = await fetch("http://localhost:8766/workspaces", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    if (j.activeSlug) {
      const w = (j.workspaces || []).find((x) => x.slug === j.activeSlug);
      _activeWorkspaceLabel = w?.label || j.activeSlug;
    } else {
      _activeWorkspaceLabel = null;
    }
  } catch { /* bridge offline; chip stays as-is */ }
}

function renderDrawer() {
  if (!drawerEl) return;
  while (drawerEl.firstChild) drawerEl.removeChild(drawerEl.firstChild);

  const head = document.createElement("div");
  head.className = "history-drawer__head";
  const title = document.createElement("div");
  title.className = "history-drawer__title";
  title.textContent = "CONVERSATION";
  /* Workspace scope chip — quietly tells the operator what scope they're
   * looking at. Click is a no-op for now (drawer only shows current session
   * regardless); the chip is informational. v2 will fetch past-session turns
   * scoped to the active workspace and the chip becomes a toggle. */
  if (_activeWorkspaceLabel) {
    const wsChip = document.createElement("span");
    wsChip.className = "history-drawer__ws-chip";
    wsChip.title = `Conversation history is scoped to the ${_activeWorkspaceLabel} workspace.`;
    wsChip.textContent = `· ${_activeWorkspaceLabel.toUpperCase()}`;
    title.appendChild(wsChip);
  }
  const meta = document.createElement("div");
  meta.className = "history-drawer__meta";
  meta.textContent = entries.length === 0 ? "no turns yet" : `${entries.length} turn${entries.length === 1 ? "" : "s"}`;
  const clearBtn = document.createElement("button");
  clearBtn.className = "history-drawer__clear";
  clearBtn.textContent = "CLEAR";
  clearBtn.addEventListener("click", () => clear());
  head.append(title, meta, clearBtn);
  drawerEl.appendChild(head);

  const list = document.createElement("div");
  list.className = "history-drawer__list";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-drawer__empty";
    empty.textContent = "Conversation history will appear here.";
    list.appendChild(empty);
  } else {
    /* Why: oldest at top, newest at bottom — matches a chat log; auto-scroll
     * to the most-recent on render so the operator sees it without scrolling. */
    for (const e of entries) list.appendChild(buildEntry(e));
  }
  drawerEl.appendChild(list);

  /* Auto-scroll to latest after layout. */
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function openDrawer() {
  drawerEl = drawerEl || document.getElementById("historyDrawer");
  if (!drawerEl) return;
  drawerOpen = true;
  drawerEl.hidden = false;
  /* Refresh the workspace label asynchronously; the first render uses the
   * cached value (or no chip on cold start), then the post-fetch render
   * fills it in. ~80ms so the chip appears almost immediately. */
  renderDrawer();
  _refreshActiveWorkspaceLabel().then(() => { if (drawerOpen) renderDrawer(); });
}

function closeDrawer() {
  if (!drawerEl) return;
  drawerOpen = false;
  drawerEl.hidden = true;
}

function toggleDrawer() { drawerOpen ? closeDrawer() : openDrawer(); }

/** Wire DOM + hotkey at boot. */
export function init() {
  drawerEl = document.getElementById("historyDrawer");
  if (!drawerEl) return;

  /* Cmd/Ctrl+H toggles drawer (preventDefault stops macOS hide-app
   * shortcut). Esc closes it. Modifier-gated per the unified policy so
   * bare H never gets eaten when typing. */
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      toggleDrawer();
    } else if (e.key === "Escape" && drawerOpen) {
      closeDrawer();
    }
  });

  /* Click-outside-the-panel dismisses (drawer covers the whole left edge so the
   * "outside" zone is the rest of the viewport). */
  drawerEl.addEventListener("click", (e) => {
    if (e.target === drawerEl) closeDrawer();
  });
}
