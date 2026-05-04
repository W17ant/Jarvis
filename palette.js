/** palette.js - Command palette (Cmd+K).
 *
 *  Why: voice fails in noisy production rooms. The wake word is the palette in
 *  normal use, but a typed escape hatch is enterprise-table-stakes for any voice-first
 *  product. Palette opens a fuzzy-search overlay over the bridge's action manifest;
 *  Enter dispatches the typed query through the same pipeline voice does
 *  (window.__runQuery → handleHeard → llm.ask). Suggestions teach the operator what
 *  phrasings work — they double as voice-vocabulary documentation.
 *
 *  Hotkey: Cmd+K (mac) / Ctrl+K (win/linux). Esc closes. Arrow keys navigate
 *  suggestions, Enter on a suggestion fills the input with its first phrasing.
 *  Enter on the input itself fires the current query through the LLM.
 *
 *  Manifest: fetched once from /actions at boot, refreshed on open in case the
 *  bridge added tools at runtime. Cached in-memory between opens. */

let actions = [];          /* { name, label, description, category, phrasings[], destructive, parameters } */
let lastFetched = 0;

let overlayEl = null;
let inputEl = null;
let listEl = null;
let activeIdx = -1;

const FETCH_TTL_MS = 60_000;   /* re-fetch manifest at most once a minute */

/** Lazy-fetch the manifest. Cached for FETCH_TTL_MS so the palette opens instantly. */
async function ensureActions() {
  if (actions.length && (Date.now() - lastFetched) < FETCH_TTL_MS) return;
  try {
    const r = await fetch("http://localhost:8766/actions", { cache: "no-store" });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j.actions)) {
      actions = j.actions;
      lastFetched = Date.now();
    }
  } catch (e) {
    console.warn("[palette] manifest fetch failed:", e.message);
  }
}

/** Score how well an action matches a query.
 *  Higher = better match. 0 = excluded. Looks across name + label + description + phrasings.
 *  Pure substring match for v1; can swap to fuse.js / fzf later if precision becomes an issue. */
function scoreAction(action, q) {
  if (!q) return 1;   /* no query → all actions tied at 1 */
  const ql = q.toLowerCase();
  let score = 0;
  if (action.name?.toLowerCase().includes(ql)) score += 10;
  if (action.label?.toLowerCase().includes(ql)) score += 8;
  if (action.category?.toLowerCase().includes(ql)) score += 4;
  if (action.description?.toLowerCase().includes(ql)) score += 2;
  if (Array.isArray(action.phrasings)) {
    for (const p of action.phrasings) {
      if (p.toLowerCase().includes(ql)) score += 6;
    }
  }
  return score;
}

function rank(query) {
  const scored = actions
    .map(a => ({ action: a, score: scoreAction(a, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

function buildSuggestion(action, idx) {
  const row = document.createElement("div");
  row.className = "palette__row";
  row.dataset.idx = String(idx);
  row.dataset.name = action.name;
  if (idx === activeIdx) row.classList.add("is-active");

  const head = document.createElement("div");
  head.className = "palette__row-head";
  if (action.category) {
    const cat = document.createElement("span");
    cat.className = "palette__row-cat";
    cat.textContent = action.category.toUpperCase();
    head.appendChild(cat);
  }
  const label = document.createElement("span");
  label.className = "palette__row-label";
  label.textContent = action.label || action.name;
  head.appendChild(label);
  if (action.destructive) {
    const flag = document.createElement("span");
    flag.className = "palette__row-flag";
    flag.textContent = "CONFIRM";
    flag.title = "Tool requires explicit confirmation before firing";
    head.appendChild(flag);
  }
  row.appendChild(head);

  const desc = document.createElement("div");
  desc.className = "palette__row-desc";
  /* Show the first phrasing if present (more useful for voice training), otherwise
   * the description's first sentence. */
  const first = (action.phrasings || [])[0];
  desc.textContent = first ? `"${first}…"` : (action.description || "").split(".")[0];
  row.appendChild(desc);

  row.addEventListener("mousedown", (e) => {
    /* mousedown not click — input blur fires before click and tears down the overlay. */
    e.preventDefault();
    pickAction(idx);
  });

  return row;
}

function render() {
  if (!listEl) return;
  while (listEl.firstChild) listEl.removeChild(listEl.firstChild);

  const q = inputEl.value.trim();
  const ranked = rank(q);

  if (!ranked.length) {
    const empty = document.createElement("div");
    empty.className = "palette__empty";
    empty.textContent = q
      ? `No tool matches "${q}". Press Enter to send as a free-form query.`
      : "Type to search the toolset, or just describe what you want.";
    listEl.appendChild(empty);
    activeIdx = -1;
    return;
  }
  ranked.forEach((r, i) => listEl.appendChild(buildSuggestion(r.action, i)));
  if (activeIdx >= ranked.length || activeIdx < 0) activeIdx = 0;
  /* Highlight the active row. */
  listEl.querySelectorAll(".palette__row").forEach((row, i) => {
    row.classList.toggle("is-active", i === activeIdx);
  });
}

/** Selecting a suggestion fills the input with its first phrasing (or label). The
 *  operator can edit before pressing Enter. */
function pickAction(idx) {
  const ranked = rank(inputEl.value.trim());
  const action = ranked[idx]?.action;
  if (!action) return;
  const first = (action.phrasings || [])[0];
  inputEl.value = first ? first : (action.label || action.name);
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  render();
}

/** Fire the current query through the same pipeline voice uses. */
function fire() {
  const q = inputEl.value.trim();
  if (!q) return;
  closePalette();
  if (typeof window.__runQuery !== "function") {
    console.warn("[palette] window.__runQuery missing — voice.js boot didn't complete?");
    return;
  }
  window.__runQuery(q);
}

function openPalette() {
  if (!overlayEl) return;
  overlayEl.hidden = false;
  inputEl.value = "";
  activeIdx = -1;
  /* Refresh manifest in the background — render with cached set immediately. */
  ensureActions().then(render);
  render();
  /* Defer focus until after the overlay reflows so the cursor lands. */
  requestAnimationFrame(() => inputEl.focus());
}

function closePalette() {
  if (!overlayEl) return;
  overlayEl.hidden = true;
  inputEl.value = "";
}

/** Wire keyboard + DOM. Bound by index.html's bootstrap. */
export function init() {
  overlayEl = document.getElementById("paletteOverlay");
  inputEl = document.getElementById("paletteInput");
  listEl = document.getElementById("paletteList");
  if (!overlayEl || !inputEl || !listEl) return;

  /* Cmd+K / Ctrl+K opens. */
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key !== "k" && e.key !== "K") return;
    e.preventDefault();
    if (overlayEl.hidden) openPalette();
    else closePalette();
  });

  inputEl.addEventListener("input", () => { activeIdx = 0; render(); });
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, listEl.children.length - 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      render();
    } else if (e.key === "Tab") {
      e.preventDefault();
      pickAction(activeIdx);
    } else if (e.key === "Enter") {
      e.preventDefault();
      fire();
    }
  });

  /* Click outside the panel dismisses. The overlay swallows the click on the
   * backdrop — the panel itself stops propagation. */
  overlayEl.addEventListener("click", (e) => { if (e.target === overlayEl) closePalette(); });

  /* Pre-warm the manifest so the first open doesn't have to wait. */
  ensureActions();
}

/** Open programmatically — useful for help-onboarding to land users in the palette. */
export function open() { openPalette(); }
