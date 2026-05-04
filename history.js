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

function renderDrawer() {
  if (!drawerEl) return;
  while (drawerEl.firstChild) drawerEl.removeChild(drawerEl.firstChild);

  const head = document.createElement("div");
  head.className = "history-drawer__head";
  const title = document.createElement("div");
  title.className = "history-drawer__title";
  title.textContent = "CONVERSATION";
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
  renderDrawer();
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

  /* H key toggles drawer. Skipped when typing in inputs / textareas / selects. */
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "h" || e.key === "H") {
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
