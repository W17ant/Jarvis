/** audit.mjs - Append-only JSONL audit log of every tool dispatch.
 *
 *  Why: a media agency kiosk handling client-visible work needs a "who ran what
 *  when" trail. JSONL chosen over SQLite for: (a) git-able + grep-able plain text,
 *  (b) no schema migrations as we add fields, (c) trivial archival — a month's
 *  log is one file we can move to NAS and forget. Reverse to SQL is easy if we
 *  ever want it.
 *
 *  File layout: data/audit/YYYY-MM.jsonl. One JSON object per line:
 *    { ts, operator, tool, args, result?, error?, runId?, durationMs }
 *
 *  Operator: tracked separately in audit.setOperator(id) — HUD posts this on
 *  profile switch + boot. Defaults to "default" so legacy single-profile installs
 *  attribute correctly.
 *
 *  Privacy: args + result snippets are stored as-is. Sensitive tools (passwords,
 *  api keys) shouldn't reach this layer in the first place — the kiosk's tool
 *  schema doesn't accept them. Confirm before adding any tool that does. */

import { mkdir, appendFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const AUDIT_DIR = path.join(PROJECT_DIR, "data", "audit");

/* Per-process active operator. Updated via setOperator() which the HUD calls when
 * the active profile changes. Survives bridge process lifetime; on bridge restart
 * the HUD posts the current operator again on its next reconnect. */
let activeOperator = "default";

export function setOperator(id) { activeOperator = String(id || "default"); }
export function getOperator() { return activeOperator; }

/* Workspaces v3: active-workspace provider injected from server.mjs so every
 * record() stamps with the active workspace's slug. NULL = unscoped (legacy
 * rows + tool calls that fired before any workspace was active). The slug is
 * read lazily so a workspace switch mid-session takes effect on the next call. */
let _getActiveWorkspaceSlug = () => null;
export function setActiveWorkspaceProvider(fn) {
  if (typeof fn === "function") _getActiveWorkspaceSlug = fn;
}

/** Resolve the per-month log file path. */
function fileForToday() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return path.join(AUDIT_DIR, `${y}-${m}.jsonl`);
}

/** Truncate large arg/result objects so the audit log stays readable. The full
 *  payload often runs to multi-MB (vision results, long PDF data) — we don't need
 *  the whole thing for "who ran what when". */
const MAX_FIELD_BYTES = 4096;
function compact(obj) {
  if (obj == null) return null;
  try {
    const json = JSON.stringify(obj);
    if (json.length <= MAX_FIELD_BYTES) return obj;
    return { _truncated: true, sizeBytes: json.length, preview: json.slice(0, MAX_FIELD_BYTES) };
  } catch {
    return { _unserialisable: true };
  }
}

/**
 * Record a tool dispatch.
 *
 * @param {object} entry
 * @param {string} entry.tool       The tool name (e.g. "video_edit_from_shoot").
 * @param {object} entry.args       Args passed to the tool. Truncated if too large.
 * @param {*} [entry.result]        Tool's return value, truncated if large.
 * @param {string} [entry.error]    Error message if dispatch threw.
 * @param {string} [entry.runId]    Bridge runId if the dispatch correlates to a task.
 * @param {number} [entry.durationMs]  Wall-clock duration of the dispatch.
 */
export async function record(entry) {
  try {
    if (!existsSync(AUDIT_DIR)) await mkdir(AUDIT_DIR, { recursive: true });
    const row = {
      ts: Date.now(),
      operator: activeOperator,
      workspace: _getActiveWorkspaceSlug() || null,
      tool: entry.tool,
      args: compact(entry.args),
      result: entry.result !== undefined ? compact(entry.result) : undefined,
      error: entry.error,
      runId: entry.runId,
      durationMs: entry.durationMs,
    };
    await appendFile(fileForToday(), JSON.stringify(row) + "\n");
  } catch (e) {
    /* Audit failures are silent — better to lose a log entry than crash a tool dispatch.
     * Bridge logs the failure to console for visibility. */
    console.warn(`[audit] failed to record ${entry.tool}: ${e.message}`);
  }
}

/**
 * Query the log. Reads the relevant month files, filters in-memory.
 *
 * @param {object} [filter]
 * @param {string} [filter.operator]  Only entries from this operator.
 * @param {string} [filter.tool]      Only entries for this tool name.
 * @param {number} [filter.fromTs]    Inclusive epoch-ms lower bound.
 * @param {number} [filter.toTs]      Inclusive epoch-ms upper bound.
 * @param {string} [filter.workspace]  Only entries from this workspace slug.
 *                                    Pre-v3 rows have no workspace field; they
 *                                    surface in every workspace's filter so
 *                                    legacy audit data isn't trapped.
 * @param {boolean} [filter.allWorkspaces]  Bypass the workspace filter entirely.
 *                                    When false/unset and no `workspace` is
 *                                    supplied, defaults to the active scope.
 * @param {number} [filter.limit=200] Max entries returned (newest first).
 * @returns {Promise<Array<object>>}
 */
export async function query(filter = {}) {
  if (!existsSync(AUDIT_DIR)) return [];
  const files = (await readdir(AUDIT_DIR)).filter(f => f.endsWith(".jsonl")).sort().reverse();
  const limit = Math.max(1, Math.min(2000, Number(filter.limit) || 200));
  /* Resolve workspace filter: explicit `workspace` arg wins over the active
   * provider; allWorkspaces=true bypasses entirely. */
  const ws = filter.allWorkspaces ? null : (filter.workspace !== undefined ? filter.workspace : _getActiveWorkspaceSlug());
  const out = [];
  /* Read newest-month-first; stop once we have enough. */
  for (const f of files) {
    const txt = await readFile(path.join(AUDIT_DIR, f), "utf8").catch(() => "");
    const lines = txt.split("\n").filter(Boolean);
    /* Walk in reverse so we get newest-first within a month. */
    for (let i = lines.length - 1; i >= 0; i--) {
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      if (filter.operator && row.operator !== filter.operator) continue;
      if (filter.tool && row.tool !== filter.tool) continue;
      if (filter.fromTs && row.ts < filter.fromTs) continue;
      if (filter.toTs && row.ts > filter.toTs) continue;
      /* Workspace filter: NULL workspace on the row leaks into every scope
       * (legacy data isn't trapped); an explicit slug match is required when
       * filtering. */
      if (ws && row.workspace && row.workspace !== ws) continue;
      out.push(row);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Snapshot — total entries, distinct operators + tools, first/last ts. Useful for
 *  the HUD's audit-drawer header summary. */
export async function summary() {
  if (!existsSync(AUDIT_DIR)) return { total: 0, operators: [], tools: [] };
  const files = (await readdir(AUDIT_DIR)).filter(f => f.endsWith(".jsonl"));
  let total = 0, firstTs = null, lastTs = null;
  const operators = new Set(), tools = new Set();
  for (const f of files) {
    const txt = await readFile(path.join(AUDIT_DIR, f), "utf8").catch(() => "");
    for (const line of txt.split("\n")) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      total++;
      operators.add(row.operator);
      tools.add(row.tool);
      if (firstTs == null || row.ts < firstTs) firstTs = row.ts;
      if (lastTs == null || row.ts > lastTs) lastTs = row.ts;
    }
  }
  return { total, operators: [...operators].sort(), tools: [...tools].sort(), firstTs, lastTs };
}
