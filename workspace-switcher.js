/** workspace-switcher.js - HUD chip + modal for switching operating contexts.
 *
 *  Wires:
 *    - The pill chip in the calendar strip (#workspaceChip) showing active
 *      workspace label (or "(no workspace)")
 *    - The modal (#workspaceModal) listing all workspaces with switch +
 *      create + delete + clear-active actions
 *    - Cmd+W global shortcut (matches the operator's mental model -
 *      ⌘+W = workspaces, paralleling Cmd+L = layout, Cmd+K = palette)
 *    - Live-update on workspace.switched / workspace.created / workspace.deleted
 *      WS events so the chip + list stay in sync across multiple HUDs
 *    - localStorage persistence of the active slug so a bridge restart
 *      doesn't silently reset the operator's chosen scope
 *
 *  The chip + modal stay outside the Settings panel because workspace
 *  switching is a primary verb, not a knob you set once and forget. The
 *  Stark-vibe instinct: a thing you do every few minutes belongs at the
 *  top of the HUD, not buried in a config dialog.
 */

import * as Bridge from "./bridge-client.js";
import * as Storage from "./storage.js";
import * as Voice from "./voice.js";

const ACTIVE_SLUG_KEY = "activeWorkspaceSlug";
const BRIDGE_BASE = "http://localhost:8766";

let _chipEl = null;
let _chipLabelEl = null;
let _modalEl = null;
let _listEl = null;

/** Render the chip's label + active-state class. */
function _paintChip(activeWorkspace) {
  if (!_chipLabelEl || !_chipEl) return;
  if (activeWorkspace) {
    _chipLabelEl.textContent = activeWorkspace.label || activeWorkspace.slug;
    _chipEl.classList.add("workspace-chip--active");
    _chipEl.title = `${activeWorkspace.label} - click to switch`;
  } else {
    _chipLabelEl.textContent = "(no workspace)";
    _chipEl.classList.remove("workspace-chip--active");
    _chipEl.title = "Switch workspace (Cmd+W)";
  }
  /* Workspaces v3: push the workspace's voice override into voice.js so
   * the next TTS chunk synthesises with the workspace's persona. Null /
   * unset = clear the override (back to localStorage Settings preference). */
  Voice.setWorkspaceVoice?.(activeWorkspace?.voice || null);
  /* Sprint 10: refresh the orb's accent uniform if it's mounted, so a
   * workspace switch repaints the orb in the new persona's colour. The
   * SVG centerpiece picks up --accent automatically via CSS variables. */
  if (typeof window !== "undefined" && window.__hud?.refreshOrbAccent) {
    /* Defer one frame so the CSS variable has applied first. */
    requestAnimationFrame(() => window.__hud.refreshOrbAccent());
  }
  /* Workspaces v4: apply persona styling (accent_color + agent_label) to
   * the HUD chrome. The accent_color drives --accent so every cyan
   * descendant follows. agent_label overrides the wordmark text — Friday
   * vs Jarvis vs whatever persona this window is pinned to. Skipped on
   * the default window (no workspace pin) so we don't tinge the global
   * cyan with whatever workspace happens to be active. */
  _applyPersonaStyling(activeWorkspace);
}

/** Apply persona accent + label to the document. Only runs when this
 *  window is workspace-pinned (window.__pinnedWorkspace set by the
 *  inline script in index.html) — otherwise the default brand stays
 *  intact regardless of which workspace is "active" globally. The
 *  default window represents the operator's home base; pinned windows
 *  represent specific personas. */
function _applyPersonaStyling(w) {
  /* Sprint 12 (revised) — single-window kiosk model. Persona swap fires on
   * EVERY workspace change, not just pinned windows. Switching to Friday
   * paints amber chrome + faceted reactor + COMMS-01 anchor + amber wake
   * label. Switching back to Personal/Jarvis restores cyan defaults. The
   * pinned-window concept is retired; ?workspace=<slug> URL still works
   * but is now equivalent to setting the active workspace at boot. */
  const root = document.documentElement;
  /* Sprint 12: tag <body> with the persona slug so CSS can swap which
   * centerpiece SVG renders (Jarvis cyan reactor vs Friday faceted crystal).
   * Cleared when no workspace pinned. Done here BEFORE the colour overrides
   * so the centerpiece swap and the accent-colour swap land in the same
   * frame — no flicker between cyan-Jarvis and amber-Jarvis. */
  if (w?.slug) {
    document.body.dataset.persona = w.slug.toLowerCase();
  } else {
    delete document.body.dataset.persona;
  }
  if (w?.accentColor && /^#[0-9a-f]{6}$/i.test(w.accentColor)) {
    root.style.setProperty("--accent", w.accentColor);
    /* Derive deep / glow / tint from the accent so the rest of the
     * palette stays in sync. Same shading function the brand bootstrap
     * uses for per-profile accent overrides (see index.html top). */
    const r = parseInt(w.accentColor.slice(1, 3), 16);
    const g = parseInt(w.accentColor.slice(3, 5), 16);
    const b = parseInt(w.accentColor.slice(5, 7), 16);
    const shade = (amt) => {
      const adj = (c) => Math.max(0, Math.min(255, Math.round(c + (amt < 0 ? c * amt : (255 - c) * amt))));
      const toHex = (c) => c.toString(16).padStart(2, "0").toUpperCase();
      return "#" + toHex(adj(r)) + toHex(adj(g)) + toHex(adj(b));
    };
    root.style.setProperty("--accent-deep", shade(-0.45));
    root.style.setProperty("--accent-glow", `rgba(${r},${g},${b},0.55)`);
    root.style.setProperty("--accent-tint", `rgba(${r},${g},${b},0.06)`);
  }
  if (w?.agentLabel) {
    /* Override the wordmark spans + transcript --agent-label CSS var.
     * The brand bootstrap in index.html populates these on first paint;
     * we re-apply per workspace switch so a mid-session swap reflects
     * immediately. */
    const upper = w.agentLabel.toUpperCase();
    document.documentElement.style.setProperty("--agent-label", `"${upper}"`);
    for (const el of document.querySelectorAll("[data-brand-agent], [data-brand-agency-primary]")) {
      el.textContent = w.agentLabel;
    }
    document.title = `${w.agentLabel} // HUD`;
  }
}

/** Fetch + render the workspaces list inside the modal. */
async function _renderList(highlightSlug = null) {
  if (!_listEl) return;
  _listEl.replaceChildren();
  let data;
  try {
    const r = await fetch(`${BRIDGE_BASE}/workspaces`, { cache: "no-store" });
    data = await r.json();
  } catch (e) {
    const li = document.createElement("li");
    li.className = "ws-modal__row ws-modal__row--err";
    li.textContent = `Bridge offline: ${e.message}`;
    _listEl.appendChild(li);
    return;
  }
  const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : [];
  const activeSlug = highlightSlug || data?.activeSlug || null;
  if (!workspaces.length) {
    const li = document.createElement("li");
    li.className = "ws-modal__row ws-modal__row--empty";
    li.textContent = "No workspaces yet. Click +NEW WORKSPACE or say \"hey jarvis, create a workspace\".";
    _listEl.appendChild(li);
    return;
  }
  for (const w of workspaces) {
    const li = document.createElement("li");
    li.className = "ws-modal__row" + (w.slug === activeSlug ? " ws-modal__row--active" : "");
    li.dataset.slug = w.slug;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "ws-modal__row-main";
    main.addEventListener("click", () => _switchTo(w.slug));

    const lbl = document.createElement("span");
    lbl.className = "ws-modal__row-label";
    lbl.textContent = w.label;
    main.appendChild(lbl);

    if (w.description) {
      const desc = document.createElement("span");
      desc.className = "ws-modal__row-desc";
      desc.textContent = w.description;
      main.appendChild(desc);
    }

    /* Indicator chips for v1 fields - tells the operator which workspaces
     * have a working_root / tool_allowlist / handbook configured at a
     * glance without opening each one. */
    const meta = document.createElement("span");
    meta.className = "ws-modal__row-meta";
    if (w.workingRoot) meta.appendChild(_metaChip("ROOT"));
    if (Array.isArray(w.toolAllowlist) && w.toolAllowlist.length) meta.appendChild(_metaChip(`TOOLS·${w.toolAllowlist.length}`));
    if (w.handbook) meta.appendChild(_metaChip("HANDBOOK"));
    if (w.creativeStylePath) meta.appendChild(_metaChip("STYLE"));
    if (w.voice) meta.appendChild(_metaChip(`VOICE·${w.voice.replace(/^[bm]+_/, "").toUpperCase()}`));
    /* Persona chip — dotted with the workspace's accent_color so the
     * operator sees the colour-coding at a glance even before they pin
     * a window to it. Falls back to a plain LABEL chip when only an
     * agent_label is set without a custom colour. */
    if (w.accentColor || w.agentLabel) {
      const personaText = w.agentLabel ? `AS·${w.agentLabel.toUpperCase()}` : `THEME·${w.accentColor?.toUpperCase() || ""}`;
      const chip = _metaChip(personaText);
      if (w.accentColor) chip.style.borderColor = w.accentColor;
      if (w.accentColor) chip.style.color = w.accentColor;
      meta.appendChild(chip);
    }
    if (meta.children.length) main.appendChild(meta);

    li.appendChild(main);

    /* Edit handbook button - opens the inline editor for workspace-scoped
     * LLM prompt rules. Voice path (`update_workspace_handbook`) covers the
     * same surface; the button is for operators who want to type instead. */
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "ws-modal__row-edit";
    edit.setAttribute("aria-label", `Edit handbook for ${w.label}`);
    edit.title = `Edit ${w.label}'s handbook`;
    edit.textContent = "✎";
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      _openHandbookEditor(w);
    });
    li.appendChild(edit);

    /* Insights expander - click ⓘ to fetch per-workspace stats inline.
     * Stays under the row so the modal layout doesn't jump. */
    const info = document.createElement("button");
    info.type = "button";
    info.className = "ws-modal__row-info";
    info.setAttribute("aria-label", `Show insights for ${w.label}`);
    info.title = `Show what's in ${w.label}`;
    info.textContent = "ⓘ";
    info.addEventListener("click", (e) => {
      e.stopPropagation();
      _toggleInsights(li, w.slug);
    });
    li.appendChild(info);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "ws-modal__row-delete";
    del.setAttribute("aria-label", `Delete workspace ${w.label}`);
    del.title = `Delete ${w.label}`;
    del.textContent = "×";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!window.confirm(`Permanently delete workspace "${w.label}"? Handbook + scope rules will be lost.`)) return;
      _deleteSlug(w.slug);
    });
    li.appendChild(del);

    _listEl.appendChild(li);
  }
}

/** Open the handbook editor modal pre-populated with the workspace's
 *  current handbook text. Save persists via PATCH /workspaces/<slug>;
 *  the bridge broadcasts workspace.updated which the listener below
 *  re-renders the switcher list with. */
let _editingSlug = null;
function _openHandbookEditor(w) {
  const modal = document.getElementById("workspaceHandbookModal");
  const slugEl = document.getElementById("workspaceHandbookSlug");
  const textEl = document.getElementById("workspaceHandbookText");
  const statusEl = document.getElementById("workspaceHandbookStatus");
  if (!modal || !textEl) return;
  _editingSlug = w.slug;
  if (slugEl) slugEl.textContent = w.label;
  textEl.value = w.handbook || "";
  if (statusEl) statusEl.textContent = "";
  _renderHandbookPreview();
  modal.hidden = false;
  textEl.focus();
}

/** Tiny "good enough" markdown renderer. Avoids pulling marked / markdown-it
 *  (50KB+) for the handbook subset we care about: headings, bullets, bold,
 *  italic, inline code, paragraphs. Pure DOM construction — never touches
 *  innerHTML on operator-supplied prose. */
function _md2html(src) {
  const lines = String(src || "").split("\n");
  const frag = document.createDocumentFragment();
  let inList = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      inList = null;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      inList = null;
      const tag = `h${Math.min(6, h[1].length)}`;
      const el = document.createElement(tag);
      el.textContent = h[2];
      frag.appendChild(el);
      continue;
    }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList || inList.tagName !== "UL") {
        inList = document.createElement("ul");
        frag.appendChild(inList);
      }
      const item = document.createElement("li");
      _applyInlineFormatting(item, li[1]);
      inList.appendChild(item);
      continue;
    }
    inList = null;
    const p = document.createElement("p");
    _applyInlineFormatting(p, line);
    frag.appendChild(p);
  }
  return frag;
}

function _applyInlineFormatting(target, text) {
  let remaining = text;
  while (remaining) {
    const m = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/.exec(remaining);
    if (!m) {
      target.appendChild(document.createTextNode(remaining));
      break;
    }
    if (m.index > 0) target.appendChild(document.createTextNode(remaining.slice(0, m.index)));
    if (m[2]) {
      const b = document.createElement("strong");
      b.textContent = m[2];
      target.appendChild(b);
    } else if (m[3]) {
      const i = document.createElement("em");
      i.textContent = m[3];
      target.appendChild(i);
    } else if (m[4]) {
      const c = document.createElement("code");
      c.textContent = m[4];
      target.appendChild(c);
    }
    remaining = remaining.slice(m.index + m[0].length);
  }
}

function _renderHandbookPreview() {
  const textEl = document.getElementById("workspaceHandbookText");
  const previewEl = document.getElementById("workspaceHandbookPreview");
  if (!textEl || !previewEl) return;
  previewEl.replaceChildren(_md2html(textEl.value));
}

const HANDBOOK_SNIPPETS = {
  priorities: `## Priorities

- Client emails outrank everything else.
- Calendar items in the next hour beat anything else.
- Anything mentioning "deadline", "audit", or "compliance" gets surfaced first.
- Newsletters and marketing — bottom of the stack.
`,
  vocabulary: `## Vocabulary

- "Matter" not "case" (legal context)
- "Appointment" not "session" (clinical context)
- Use the client's exact brand spelling
`,
  tone: `## Tone

- Confident, knowledgeable, slightly understated.
- British English: "colour", "centre", "organise".
- Active voice by default.
- Vary sentence length — short, then a longer one, then short.
`,
  avoid: `## Words to avoid

- "Game-changer", "next-level", "deep dive"
- "Synergy", "leverage", "circle back"
- Exclamation marks in deliverable copy
- Hyperbolic adjectives without earning them
`,
  examples: `## Reply examples

\`\`\`
Hi Sam,

Thanks for the detail. The constraint that matters here is the launch
date — we can fit either A or B inside it, but not both.

Speak soon,
\`\`\`
`,
};

function _insertSnippet(key) {
  const snippet = HANDBOOK_SNIPPETS[key];
  if (!snippet) return;
  const textEl = document.getElementById("workspaceHandbookText");
  if (!textEl) return;
  const sep = textEl.value && !textEl.value.endsWith("\n\n") ? "\n\n" : "";
  const start = textEl.selectionStart || textEl.value.length;
  const end = textEl.selectionEnd || textEl.value.length;
  textEl.value = textEl.value.slice(0, start) + sep + snippet + textEl.value.slice(end);
  textEl.focus();
  const newCursor = start + sep.length + snippet.length;
  textEl.setSelectionRange(newCursor, newCursor);
  _renderHandbookPreview();
}

function _closeHandbookEditor() {
  const modal = document.getElementById("workspaceHandbookModal");
  if (modal) modal.hidden = true;
  _editingSlug = null;
}

async function _saveHandbook() {
  const slug = _editingSlug;
  if (!slug) return;
  const textEl = document.getElementById("workspaceHandbookText");
  const statusEl = document.getElementById("workspaceHandbookStatus");
  const saveBtn = document.getElementById("workspaceHandbookSave");
  if (!textEl) return;
  const handbook = textEl.value;
  if (statusEl) statusEl.textContent = "saving…";
  if (saveBtn) saveBtn.disabled = true;
  try {
    const r = await fetch(`${BRIDGE_BASE}/workspaces/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handbook }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "save failed");
    if (statusEl) statusEl.textContent = "✓ saved · takes effect on next LLM call";
    /* Brief success feedback then close. */
    setTimeout(() => { _closeHandbookEditor(); _renderList(); }, 700);
  } catch (e) {
    if (statusEl) statusEl.textContent = `✗ ${e.message}`;
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/** Toggle the insights panel for a row. Lazy-fetches /workspaces/<slug>/insights
 *  on first expand, caches the rendered DOM on the row element so re-clicks
 *  just toggle visibility without re-fetching. */
async function _toggleInsights(rowEl, slug) {
  let panel = rowEl.querySelector(".ws-modal__insights");
  if (panel) {
    panel.remove();
    return;
  }
  panel = document.createElement("div");
  panel.className = "ws-modal__insights";
  panel.textContent = "loading…";
  rowEl.appendChild(panel);
  try {
    const r = await fetch(`${BRIDGE_BASE}/workspaces/${encodeURIComponent(slug)}/insights`, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "fetch failed");
    panel.replaceChildren();
    const c = j.counts || {};
    const stats = [
      ["TURNS", `${c.turns || 0} (${c.turns7d || 0} last 7d)`],
      ["DOCS", c.documents || 0],
      ["FACTS", c.facts || 0],
      ["CONTACTS", c.contacts || 0],
      ["PROJECTS", c.projects || 0],
      ["SUMMARIES", c.summaries || 0],
    ];
    for (const [label, value] of stats) {
      const cell = document.createElement("span");
      cell.className = "ws-modal__insights-cell";
      const k = document.createElement("span");
      k.className = "ws-modal__insights-key";
      k.textContent = label;
      const v = document.createElement("span");
      v.className = "ws-modal__insights-val";
      v.textContent = String(value);
      cell.append(k, v);
      panel.appendChild(cell);
    }
    if (j.lastActive) {
      const stamp = document.createElement("span");
      stamp.className = "ws-modal__insights-stamp";
      stamp.textContent = `last active ${new Date(j.lastActive).toLocaleString()}`;
      panel.appendChild(stamp);
    }
  } catch (e) {
    panel.textContent = `couldn't load insights: ${e.message}`;
  }
}

function _metaChip(text) {
  const c = document.createElement("span");
  c.className = "ws-modal__meta-chip";
  c.textContent = text;
  return c;
}

/** POST /workspaces/active to switch. The bridge applies the workspace's
 *  working-root + creative-style overrides; we update the chip + modal +
 *  persist the slug to localStorage. */
async function _switchTo(slug) {
  try {
    const r = await fetch(`${BRIDGE_BASE}/workspaces/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "switch failed");
    Storage.set(ACTIVE_SLUG_KEY, slug || "");
    _paintChip(j.workspace);
    _renderList(slug);
    _hideModal();
  } catch (e) {
    console.warn("[workspace-switcher] switch failed:", e.message);
  }
}

/** Voice flow handles delete with confirmation; this is the click-to-delete
 *  path. We POST through the tool dispatch endpoint? No - that needs WS +
 *  LLM. Instead, the bridge has no direct DELETE /workspaces/<slug> endpoint,
 *  so we'd need to add one. For v1 simplicity, the operator deletes via voice
 *  ("delete the consulting workspace") which goes through the confirmation
 *  gate. The × button here is a future hook; for now it just informs them. */
async function _deleteSlug(slug) {
  console.warn(`[workspace-switcher] delete via voice: "hey jarvis, delete the workspace ${slug}"`);
  /* Reload the list so the click visibly does nothing (UX hint that the
   * mechanism is voice-first). v2 will add DELETE /workspaces/:slug. */
  alert(`To delete the "${slug}" workspace, say: "hey jarvis, delete the workspace ${slug}". The voice path enforces a confirmation gate so a misclick can't lose your handbook.`);
  _renderList();
}

/** Inline-prompt-based create. v0 uses window.prompt for slug + label so
 *  we don't need a multi-step modal. v1 will replace with a proper inline
 *  form once the operator-feedback loop tells us which fields they actually
 *  want surfaced at create time. */
async function _createInline() {
  const slug = window.prompt("Workspace slug (lowercase, hyphens, e.g. 'consulting')");
  if (!slug) return;
  const label = window.prompt("Display label (e.g. 'Consulting practice')", slug);
  if (!label) return;
  /* No direct POST /workspaces endpoint in v1 - operators create via the
   * tool dispatch (voice) so the confirmation gate runs. The HUD-side
   * button mirrors the voice flow by sending an llm.ask through Bridge. */
  try {
    await Bridge.ask({
      type: "llm.askStream",
      payload: { query: `create workspace slug ${slug} label ${label}` },
    });
    /* Allow a moment for the workspace.created broadcast to land before
     * re-rendering. */
    setTimeout(() => _renderList(), 600);
  } catch (e) {
    console.warn("[workspace-switcher] create failed:", e.message);
  }
}

function _showModal() {
  if (!_modalEl) return;
  _modalEl.hidden = false;
  _renderList();
  /* Focus the active row (or the create button if none active) so keyboard
   * navigation lands somewhere useful. */
  const active = _listEl?.querySelector(".ws-modal__row--active .ws-modal__row-main");
  (active || document.getElementById("workspaceCreateBtn"))?.focus();
}
function _hideModal() {
  if (_modalEl) _modalEl.hidden = true;
}

/** Fetch active workspace + paint chip on boot. Re-asserts the operator's
 *  cached choice via POST /workspaces/active so a bridge restart doesn't
 *  silently lose the scope. */
async function _bootstrap() {
  let active = null;
  try {
    const r = await fetch(`${BRIDGE_BASE}/workspaces`, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      const workspaces = j.workspaces || [];
      /* Sprint 12: pinned windows must paint with the PINNED workspace's
       * data, not the bridge's global active. Otherwise the persona swap
       * (body[data-persona], accent colour, agent label, faceted-crystal
       * centerpiece) reflects whichever scope the operator's main window
       * happens to be on — which defeats the whole point of the pin.
       * Pinned windows do NOT POST /workspaces/active either; that would
       * yank the global state away from the operator's main window. */
      if (window.__pinnedWorkspace) {
        active = workspaces.find((w) => w.slug === window.__pinnedWorkspace) || null;
      } else {
        const cachedSlug = Storage.get(ACTIVE_SLUG_KEY, "");
        const wantSlug = j.activeSlug || cachedSlug || null;
        if (wantSlug && wantSlug !== j.activeSlug) {
          /* Re-assert the cached slug after a bridge restart. */
          try {
            const rr = await fetch(`${BRIDGE_BASE}/workspaces/active`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ slug: wantSlug }),
            });
            const jj = await rr.json();
            if (jj.ok) active = jj.workspace;
          } catch {}
        } else if (j.activeSlug) {
          active = workspaces.find((w) => w.slug === j.activeSlug) || null;
        }
      }
    }
  } catch { /* bridge offline; chip stays as "(no workspace)" */ }
  _paintChip(active);
}

export function init() {
  _chipEl = document.getElementById("workspaceChip");
  _chipLabelEl = document.getElementById("workspaceChipLabel");
  _modalEl = document.getElementById("workspaceModal");
  _listEl = document.getElementById("workspaceList");
  if (!_chipEl || !_modalEl) return;

  _chipEl.addEventListener("click", _showModal);
  document.getElementById("workspaceModalClose")?.addEventListener("click", _hideModal);
  document.getElementById("workspaceCreateBtn")?.addEventListener("click", _createInline);
  document.getElementById("workspaceClearBtn")?.addEventListener("click", () => _switchTo(null));

  /* Esc closes the modal - consistent with settings + history drawer. */
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _modalEl && !_modalEl.hidden) {
      e.preventDefault();
      _hideModal();
    }
    /* Cmd/Ctrl + W toggles the modal. macOS uses Cmd+W to close a window;
     * we override at the kiosk level (preventDefault) because the kiosk is
     * single-window and the operator never wants to close it accidentally. */
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
      e.preventDefault();
      if (_modalEl.hidden) _showModal(); else _hideModal();
    }
  });

  /* Click outside the panel = close. Common modal hygiene. */
  _modalEl.addEventListener("click", (e) => {
    if (e.target === _modalEl) _hideModal();
  });

  /* Live-updates from the bridge. Any of these can fire from a different
   * HUD window or from a voice command, so we re-render in all cases.
   *
   * Sprint 12 fix: pinned windows must IGNORE workspace.switched broadcasts.
   * The whole point of `?workspace=friday` is that this window represents the
   * Friday persona regardless of what the operator's main window does. Without
   * this guard, switching workspaces in the Personal tab repaints the Friday
   * tab too — both windows converge on whatever was last clicked. We still
   * refresh the modal list (so the operator sees the global active state if
   * they happen to open the switcher in the pinned window). */
  Bridge.on("workspace.switched", (m) => {
    /* Single-window model: every workspace switch repaints chrome + chip +
     * persona styling. No pin guard — the kiosk is one window deep, and
     * switching from Jarvis to Friday should swap the entire visual +
     * voice persona in the same window. */
    _paintChip(m.data || null);
    if (m.data?.slug) Storage.set(ACTIVE_SLUG_KEY, m.data.slug);
    else Storage.set(ACTIVE_SLUG_KEY, "");
    if (_modalEl && !_modalEl.hidden) _renderList(m.data?.slug);
  });
  Bridge.on("workspace.created", () => { if (_modalEl && !_modalEl.hidden) _renderList(); });
  Bridge.on("workspace.deleted", () => { if (_modalEl && !_modalEl.hidden) _renderList(); });
  /* Workspace.updated covers handbook edits, voice changes, accent_color
   * tweaks etc. Re-render the list so meta chips reflect new state. */
  Bridge.on("workspace.updated", () => { if (_modalEl && !_modalEl.hidden) _renderList(); });

  /* Handbook editor wiring. Save = PATCH; cancel/close = revert; Esc closes. */
  document.getElementById("workspaceHandbookSave")?.addEventListener("click", _saveHandbook);
  document.getElementById("workspaceHandbookCancel")?.addEventListener("click", _closeHandbookEditor);
  document.getElementById("workspaceHandbookClose")?.addEventListener("click", _closeHandbookEditor);
  /* Live preview re-renders on every keystroke. Cheap (text < 6KB usually
   * + the renderer is straightforward DOM construction), so no debounce. */
  document.getElementById("workspaceHandbookText")?.addEventListener("input", _renderHandbookPreview);
  /* Snippet dropdown — insert a starter block at the cursor. Resets to the
   * placeholder option after insertion so the operator can pick it again. */
  const snippetEl = document.getElementById("workspaceHandbookSnippet");
  snippetEl?.addEventListener("change", (e) => {
    const key = e.target.value;
    if (key) {
      _insertSnippet(key);
      e.target.value = "";
    }
  });
  document.addEventListener("keydown", (e) => {
    const open = document.getElementById("workspaceHandbookModal");
    if (e.key === "Escape" && open && !open.hidden) {
      e.preventDefault();
      _closeHandbookEditor();
    }
  });

  _bootstrap();
}
