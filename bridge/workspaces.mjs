/** workspaces.mjs - first-class operating contexts for the operator.
 *
 *  v0 of the Horizon-2 wedge: turn Jarvis from "voice assistant" into
 *  "workstation." A workspace is a bounded operating context - the operator
 *  is "in their consulting workspace" or "in their photo agency workspace"
 *  or "in their personal home workspace" - and switching changes:
 *
 *    1. The system prompt fragment the LLM sees ("You are operating in the
 *       Consulting workspace; surface contacts and projects from that scope
 *       first").
 *    2. The conversation summarisation scope (future).
 *    3. The default project / contact lookups (future).
 *    4. The skill pack injected into available tools (Horizon 2 v1).
 *
 *  v0 stops at (1) - system prompt only. The infrastructure for (2-4)
 *  lives here so we don't have to migrate the schema later.
 *
 *  Storage: SQLite via its own connection to data/memory.db. Better-sqlite3
 *  + WAL mode supports multiple connections to the same file safely. Keeps
 *  workspaces.mjs decoupled from memory.mjs's API surface.
 *
 *  Active workspace persistence: the bridge holds it in process memory; the
 *  HUD writes the selected slug to localStorage and re-asserts it via
 *  POST /workspaces/active on every boot. That way a bridge restart doesn't
 *  silently reset the operator's scope.
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(HERE, "..", "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "memory.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/* Schema. Slug is the primary key - operator-supplied stable identifier
 * the rest of the system uses; label is the human-friendly display string.
 * No foreign keys to other tables yet - workspaces are isolated in v0.
 *
 * Workspaces v1 added three optional columns:
 *   working_root        — absolute or relative path to override Paths.getWorkingDir
 *   tool_allowlist      — JSON array of tool names; restricts the LLM's catalog
 *                         to this subset when active. NULL = all tools available.
 *   creative_style_path — optional override path for the LLM's creative-style.md.
 *                         Falls back to global config/creative-style.md when null.
 *
 * The ALTER TABLE statements below are idempotent — they no-op when the column
 * already exists (better-sqlite3 throws "duplicate column"; we swallow that
 * specific error to keep boot clean on upgraded installs). */
db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT,
  handbook TEXT,
  created_at INTEGER NOT NULL,
  last_active INTEGER
);
`);
/* v1 column upgrades. Each ALTER is wrapped so a re-run on a v1 install
 * doesn't crash boot; only "duplicate column" errors are swallowed. */
function _addColumnIfMissing(name, decl) {
  try { db.exec(`ALTER TABLE workspaces ADD COLUMN ${name} ${decl}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
_addColumnIfMissing("working_root", "TEXT");
_addColumnIfMissing("tool_allowlist", "TEXT");          /* JSON-serialised array */
_addColumnIfMissing("creative_style_path", "TEXT");
_addColumnIfMissing("voice", "TEXT");                   /* Kokoro voice id, e.g. bm_daniel */
_addColumnIfMissing("accent_color", "TEXT");            /* hex color e.g. #ffb84a */
_addColumnIfMissing("agent_label", "TEXT");             /* persona name override, e.g. "Friday" */
/* Sprint 12: per-workspace wake phrase. Pinned windows (e.g. ?workspace=friday)
 * use this phrase for VAD wake-detection instead of the global brand wake.
 * Falls back to brand wake when null. Lets dual-window setups have Jarvis
 * respond to "hey jarvis" and Friday respond to "hey friday" simultaneously. */
_addColumnIfMissing("wake_phrase", "TEXT");

/* In-process active-workspace state. Re-asserted by the HUD on connect. */
let _activeSlug = null;

/* Slug regex - same shape we use for plugin slugs so the operator's mental
 * model is consistent. Lowercase, alphanumeric + hyphen, 2-41 chars. */
const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

/* Reserved slugs the operator shouldn't be able to use because they have
 * special meaning in URLs or prompts. */
const RESERVED = new Set(["new", "delete", "list", "active", "default"]);

/** Create a workspace. Returns the row on success, throws on bad input
 *  or duplicate slug. Validates the raw operator input against SLUG_RE
 *  BEFORE any normalisation so mixed-case / wrong-character mistakes
 *  surface as errors instead of being silently coerced.
 *
 *  v1 fields are optional — workingRoot, toolAllowlist (array), creativeStylePath. */
export function create({
  slug, label,
  description = null, handbook = null,
  workingRoot = null, toolAllowlist = null, creativeStylePath = null, voice = null,
  accentColor = null, agentLabel = null, wakePhrase = null,
}) {
  const raw = String(slug || "").trim();
  const l = String(label || "").trim();
  if (!SLUG_RE.test(raw)) throw new Error(`workspace slug "${slug}" must match ${SLUG_RE} - lowercase, alphanumeric + hyphen, 2-41 chars`);
  const s = raw.toLowerCase();   /* normalise post-validation; no-op when raw is already lower-case */
  if (RESERVED.has(s)) throw new Error(`workspace slug "${s}" is reserved - pick a different name`);
  if (!l) throw new Error("workspace label is required (human-friendly display name)");

  const existing = db.prepare("SELECT slug FROM workspaces WHERE slug = ?").get(s);
  if (existing) throw new Error(`workspace "${s}" already exists`);

  const allowlistJson = Array.isArray(toolAllowlist) && toolAllowlist.length
    ? JSON.stringify(toolAllowlist.map((t) => String(t).trim()).filter(Boolean))
    : null;

  /* Validate accent_color if provided — only accept #rrggbb hex so a
   * malformed value can't break CSS variable injection downstream. */
  let validAccent = null;
  if (accentColor) {
    const hex = String(accentColor).trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(hex)) validAccent = hex;
    else throw new Error(`accentColor "${accentColor}" must be #rrggbb hex`);
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO workspaces (slug, label, description, handbook, working_root, tool_allowlist, creative_style_path, voice, accent_color, agent_label, wake_phrase, created_at, last_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    s, l, description || null, handbook || null,
    workingRoot || null, allowlistJson, creativeStylePath || null, voice || null,
    validAccent, agentLabel || null,
    wakePhrase ? String(wakePhrase).trim().toLowerCase() : null,
    now,
  );
  return get(s);
}

/** Internal — turn a SQLite row into the public shape. Parses tool_allowlist
 *  from JSON; returns null when not set (= all tools). */
function _hydrate(row) {
  if (!row) return null;
  let allowlist = null;
  if (row.tool_allowlist) {
    try { allowlist = JSON.parse(row.tool_allowlist); }
    catch { allowlist = null; }
  }
  return {
    slug: row.slug,
    label: row.label,
    description: row.description,
    handbook: row.handbook,
    workingRoot: row.working_root || null,
    toolAllowlist: Array.isArray(allowlist) ? allowlist : null,
    creativeStylePath: row.creative_style_path || null,
    voice: row.voice || null,
    accentColor: row.accent_color || null,
    agentLabel: row.agent_label || null,
    /* Sprint 12: per-workspace wake phrase. null → fall back to global brand wake. */
    wakePhrase: row.wake_phrase || null,
    created_at: row.created_at,
    last_active: row.last_active,
  };
}

/** Read a workspace by slug. Returns null if not found. */
export function get(slug) {
  const s = String(slug || "").trim().toLowerCase();
  if (!s) return null;
  const row = db.prepare("SELECT * FROM workspaces WHERE slug = ?").get(s);
  return _hydrate(row);
}

/** Enumerate all workspaces, last-active first. */
export function list() {
  const rows = db.prepare(`
    SELECT * FROM workspaces
    ORDER BY last_active DESC NULLS LAST, created_at DESC
  `).all();
  return rows.map(_hydrate);
}

/** Update an existing workspace. Only the fields passed in `patch` change. */
export function update(slug, patch = {}) {
  const w = get(slug);
  if (!w) throw new Error(`workspace "${slug}" not found`);
  const allowlistJson = patch.toolAllowlist !== undefined
    ? (Array.isArray(patch.toolAllowlist) && patch.toolAllowlist.length
        ? JSON.stringify(patch.toolAllowlist.map((t) => String(t).trim()).filter(Boolean))
        : null)
    : (w.toolAllowlist ? JSON.stringify(w.toolAllowlist) : null);
  /* Validate accent_color in patch path same as create. */
  let nextAccent = w.accentColor;
  if (patch.accentColor !== undefined) {
    if (!patch.accentColor) nextAccent = null;
    else {
      const hex = String(patch.accentColor).trim().toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`accentColor "${patch.accentColor}" must be #rrggbb hex`);
      nextAccent = hex;
    }
  }
  const next = {
    label: patch.label != null ? String(patch.label).trim() : w.label,
    description: patch.description !== undefined ? (patch.description ? String(patch.description) : null) : w.description,
    handbook: patch.handbook !== undefined ? (patch.handbook ? String(patch.handbook) : null) : w.handbook,
    working_root: patch.workingRoot !== undefined ? (patch.workingRoot || null) : w.workingRoot,
    tool_allowlist: allowlistJson,
    creative_style_path: patch.creativeStylePath !== undefined ? (patch.creativeStylePath || null) : w.creativeStylePath,
    voice: patch.voice !== undefined ? (patch.voice || null) : w.voice,
    accent_color: nextAccent,
    agent_label: patch.agentLabel !== undefined ? (patch.agentLabel || null) : w.agentLabel,
    /* Sprint 12 — wake phrase update path. Lowercase + trim so the matcher
     * downstream stays simple. Empty string → null (fall back to brand wake). */
    wake_phrase: patch.wakePhrase !== undefined
      ? (patch.wakePhrase ? String(patch.wakePhrase).trim().toLowerCase() : null)
      : w.wakePhrase,
  };
  db.prepare(`
    UPDATE workspaces
    SET label = ?, description = ?, handbook = ?,
        working_root = ?, tool_allowlist = ?, creative_style_path = ?, voice = ?,
        accent_color = ?, agent_label = ?, wake_phrase = ?
    WHERE slug = ?
  `).run(
    next.label, next.description, next.handbook,
    next.working_root, next.tool_allowlist, next.creative_style_path, next.voice,
    next.accent_color, next.agent_label, next.wake_phrase,
    w.slug,
  );
  return get(slug);
}

/** Delete a workspace. If it was active, clear active. */
export function remove(slug) {
  const s = String(slug || "").trim().toLowerCase();
  const w = get(s);
  if (!w) return false;
  db.prepare("DELETE FROM workspaces WHERE slug = ?").run(s);
  if (_activeSlug === s) _activeSlug = null;
  return true;
}

/** Active-workspace getter. Returns null if no workspace is active OR if
 *  the active slug points at a deleted workspace. */
export function getActive() {
  if (!_activeSlug) return null;
  const w = get(_activeSlug);
  if (!w) { _activeSlug = null; return null; }
  return w;
}

/** Set the active workspace. Pass null to clear. */
export function setActive(slug) {
  if (slug == null || slug === "") {
    _activeSlug = null;
    return null;
  }
  const w = get(slug);
  if (!w) throw new Error(`workspace "${slug}" not found`);
  _activeSlug = w.slug;
  db.prepare("UPDATE workspaces SET last_active = ? WHERE slug = ?").run(Date.now(), w.slug);
  return get(w.slug);
}

/** Per-workspace insights snapshot. Aggregates row counts across the
 *  scoped tables (turns, summaries, contacts, projects, facts, documents)
 *  + the most-used tool names from the audit log. Used by the HUD's
 *  workspace switcher to render an at-a-glance "what's in here" panel
 *  per workspace.
 *
 *  Returns { slug, label, counts: {...}, topTools: [{name, count}], lastActive }.
 *  Cheap — every count is a single COUNT(*) WHERE workspace_id = ?.
 *  Top tools is a single GROUP BY but caps at 5 to keep the response tiny. */
export function insights(slug) {
  const w = get(slug);
  if (!w) return null;
  const turns = db.prepare("SELECT COUNT(*) as n FROM conversation_turns WHERE workspace_id = ?").get(slug)?.n || 0;
  const summaries = db.prepare("SELECT COUNT(*) as n FROM conversation_summaries WHERE workspace_id = ?").get(slug)?.n || 0;
  const contacts = db.prepare("SELECT COUNT(*) as n FROM contacts WHERE workspace_id = ?").get(slug)?.n || 0;
  const projects = db.prepare("SELECT COUNT(*) as n FROM projects WHERE workspace_id = ?").get(slug)?.n || 0;
  const facts = db.prepare("SELECT COUNT(*) as n FROM facts WHERE workspace_id = ?").get(slug)?.n || 0;
  const documents = db.prepare("SELECT COUNT(*) as n FROM documents WHERE workspace_id = ?").get(slug)?.n || 0;
  /* Last 7d turns specifically — gives the operator a "is this workspace
   * active or stale" signal alongside the all-time count. */
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const turns7d = db.prepare("SELECT COUNT(*) as n FROM conversation_turns WHERE workspace_id = ? AND ts >= ?").get(slug, sevenDaysAgo)?.n || 0;
  return {
    slug: w.slug,
    label: w.label,
    isActive: getActive()?.slug === w.slug,
    lastActive: w.last_active,
    counts: { turns, turns7d, summaries, contacts, projects, facts, documents },
  };
}

/** First-run seeding. If the workspaces table is empty (fresh install,
 *  never used by this operator), create a "personal" default + activate
 *  it so the operator has a starting point in the HUD chip + voice flow.
 *  No-op when even one workspace exists, so an operator who deletes the
 *  default doesn't get it re-created on the next boot. */
export function seedDefaultIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) as n FROM workspaces").get();
  if ((count?.n || 0) > 0) return null;
  const seeded = create({
    slug: "personal",
    label: "Personal",
    description: "Default workspace - your unscoped baseline. Create more for specific projects, clients, or roles.",
    handbook: null,
  });
  /* Sprint 12 — also seed a "Friday" sister workspace so fresh installs get
   * the dual-persona experience out of the box. Comms-focused, amber accent,
   * Isabella voice, "hey friday" wake. The operator can delete or rename via
   * the workspace switcher modal if they only want one persona. */
  try {
    create({
      slug: "friday",
      label: "Friday",
      description: "Communications & client-facing persona. Inbox, calendar, drafts, PR.",
      handbook: null,   /* operator can paste config/handbooks/friday.md content via the editor */
      voice: "bf_isabella",
      accentColor: "#ffb84a",
      agentLabel: "Friday",
      wakePhrase: "hey friday",
    });
  } catch (e) {
    /* Don't block boot if Friday seed fails — Personal is enough to start. */
    console.warn(`[workspaces] Friday seed failed (non-fatal): ${e.message}`);
  }
  setActive("personal");
  return seeded;
}

/** System prompt fragment to inject when there's an active workspace.
 *  Returns empty string when no workspace is active.
 *
 *  Workspaces v4: accepts an optional slug to override the module-level
 *  active for per-call dispatch (multi-window kiosks). When omitted,
 *  reads the global active. */
export function systemPromptHint(slugOverride = null) {
  const w = slugOverride ? get(slugOverride) : getActive();
  if (!w) return "";
  const lines = [
    `You are operating inside the "${w.label}" workspace.`,
  ];
  if (w.description) lines.push(`Workspace description: ${w.description}`);
  if (w.handbook) {
    lines.push("");
    lines.push("Workspace handbook (operator's scope-specific rules - follow these strictly):");
    lines.push(w.handbook);
  }
  return lines.join("\n");
}
