/** rights.mjs - Per-asset usage rights ledger.
 *
 *  Why: agencies routinely lose track of who cleared what for which use ("can we use that
 *  the press car tracking shot in the McLaren pitch deck?"). A miss costs goodwill or money. We
 *  keep a small SQLite table mapping (asset_path → client → uses → expiry → notes) so any
 *  voice question gets a definitive answer instead of an "I think so".
 *
 *  Tools the LLM can call:
 *    add_usage_rights      - record a new permission for an asset (or a whole folder via wildcard)
 *    check_usage_rights    - "can I use IMG_001.jpg for an Instagram post?" → ok / blocked / expiring soon
 *    list_usage_rights     - audit by client / by asset / by use type
 *    expire_usage_rights   - manual revoke (e.g. campaign window closed early)
 *
 *  Use vocabulary kept to a tight set so LLM lookups stay deterministic:
 *    "web", "social", "print", "broadcast", "internal", "pitch", "exclusive", "all"
 */

import Database from "better-sqlite3";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");

/* Why: shares memory.db so daily backup snapshot covers rights data alongside contacts/projects. */
const db = new Database(path.join(DATA_DIR, "memory.db"));
db.pragma("journal_mode = WAL");

const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS usage_rights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_path TEXT NOT NULL,
    client TEXT NOT NULL,
    uses TEXT NOT NULL,
    cleared_by TEXT,
    cleared_on INTEGER,
    expires_on INTEGER,
    exclusive INTEGER DEFAULT 0,
    notes TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(asset_path, client)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rights_asset ON usage_rights(asset_path)`,
  `CREATE INDEX IF NOT EXISTS idx_rights_client ON usage_rights(client)`,
];
for (const stmt of SCHEMA_STMTS) db.prepare(stmt).run();

const VALID_USES = new Set(["web", "social", "print", "broadcast", "internal", "pitch", "exclusive", "all"]);

/** Normalise an asset path: accept an absolute path OR a 'folder/file.jpg' shorthand. */
function normaliseAsset(p) {
  if (!p) return null;
  /* Strip any project-root prefix so the same asset can be referenced from absolute or relative paths. */
  const rel = path.isAbsolute(p) ? path.relative(PROJECT_DIR, p) : p;
  return rel.replace(/^\/+/, "");
}

function toEpochMs(d) {
  if (!d) return null;
  if (typeof d === "number") return d;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

function fromEpoch(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 10) : null;
}

/* Why: the uses column is a JSON-encoded array. A schema migration or external
 * write that leaves it malformed shouldn't 500 the whole rights query — degrade
 * to an empty list and let the caller treat it as "no rights recorded". */
function safeUses(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Validate + normalise the use list (string or array → lowercase array, all valid). */
function normaliseUses(uses) {
  let arr;
  if (Array.isArray(uses)) arr = uses;
  else if (typeof uses === "string") arr = uses.split(/[\s,;]+/);
  else return null;
  arr = arr.map(u => String(u || "").trim().toLowerCase()).filter(Boolean);
  for (const u of arr) if (!VALID_USES.has(u)) return null;
  return [...new Set(arr)];
}

/**
 * Record a clearance. Upserts on (asset_path, client) so a follow-up agreement
 * supersedes the previous one (e.g. originally "web" then later expanded to "all").
 *
 * @param {object} args
 * @param {string} args.assetPath  Either absolute path inside the project or 'folder/file.jpg'.
 * @param {string} args.client     Client name (e.g. "the manufacturer").
 * @param {string|string[]} args.uses  One or more of the VALID_USES set.
 * @param {string} [args.clearedBy]   Who at the client signed off.
 * @param {string} [args.clearedOn]   ISO date string (defaults to today).
 * @param {string} [args.expiresOn]   ISO date string — null/undefined = perpetual.
 * @param {boolean} [args.exclusive=false]  True = no other client can be granted use.
 * @param {string} [args.notes]
 */
export function addUsageRights(args = {}) {
  const assetPath = normaliseAsset(args.assetPath);
  if (!assetPath) return { ok: false, error: "assetPath required" };
  if (!args.client) return { ok: false, error: "client required" };
  const uses = normaliseUses(args.uses);
  if (!uses) return { ok: false, error: `uses must be one or more of: ${[...VALID_USES].join(", ")}` };

  /* Why: exclusivity check — if a different client has been granted exclusive on this
   * asset, refuse to add another grant. Operator must explicitly revoke first. */
  const exclusiveBlocker = db.prepare("SELECT client FROM usage_rights WHERE asset_path=? AND exclusive=1 AND client != ?").get(assetPath, args.client);
  if (exclusiveBlocker && !args.overrideExclusive) {
    return {
      ok: false,
      blocked: true,
      reason: `${assetPath} is exclusively cleared to ${exclusiveBlocker.client}. Pass overrideExclusive: true to record anyway (this typically requires renegotiation).`,
    };
  }

  const now = Date.now();
  const clearedOn = toEpochMs(args.clearedOn) || now;
  const expiresOn = toEpochMs(args.expiresOn);

  db.prepare(`
    INSERT INTO usage_rights (asset_path, client, uses, cleared_by, cleared_on, expires_on, exclusive, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asset_path, client) DO UPDATE SET
      uses = excluded.uses,
      cleared_by = COALESCE(excluded.cleared_by, cleared_by),
      cleared_on = excluded.cleared_on,
      expires_on = excluded.expires_on,
      exclusive = excluded.exclusive,
      notes = COALESCE(excluded.notes, notes)
  `).run(
    assetPath, args.client, JSON.stringify(uses),
    args.clearedBy || null, clearedOn, expiresOn,
    args.exclusive ? 1 : 0, args.notes || null, now,
  );

  return {
    ok: true,
    asset: assetPath,
    client: args.client,
    uses,
    expires: fromEpoch(expiresOn),
    exclusive: !!args.exclusive,
    summary: `Recorded ${uses.join(", ")} rights for ${args.client} on ${assetPath}${expiresOn ? ` until ${fromEpoch(expiresOn)}` : " (perpetual)"}.`,
  };
}

/**
 * Answer "can client X use asset A for use Y?" — covers expiry + exclusivity.
 * Returns a verdict with reason that's safe to read aloud.
 */
export function checkUsageRights({ assetPath, client, use } = {}) {
  const asset = normaliseAsset(assetPath);
  if (!asset) return { ok: false, error: "assetPath required" };
  if (!client) return { ok: false, error: "client required" };
  const wanted = use ? String(use).trim().toLowerCase() : null;
  if (wanted && !VALID_USES.has(wanted)) {
    return { ok: false, error: `use must be one of: ${[...VALID_USES].join(", ")}` };
  }

  const row = db.prepare("SELECT * FROM usage_rights WHERE asset_path=? AND client=?").get(asset, client);
  if (!row) {
    /* Check if anyone else has exclusive — that'd block the use even without our own grant. */
    const otherExclusive = db.prepare("SELECT client FROM usage_rights WHERE asset_path=? AND exclusive=1").get(asset);
    if (otherExclusive) {
      return { ok: true, verdict: "blocked", reason: `Asset is exclusively cleared to ${otherExclusive.client} — ${client} has no rights.` };
    }
    return { ok: true, verdict: "unknown", reason: `No clearance on file for ${client} on ${asset}. Treat as not cleared until confirmed.` };
  }

  const uses = safeUses(row.uses);
  const now = Date.now();
  const expired = row.expires_on && row.expires_on < now;
  if (expired) {
    return { ok: true, verdict: "expired", reason: `${client}'s rights expired on ${fromEpoch(row.expires_on)}.`, uses };
  }

  const expiresSoon = row.expires_on && (row.expires_on - now) < 30 * 24 * 60 * 60 * 1000;
  if (wanted && !uses.includes(wanted) && !uses.includes("all")) {
    return { ok: true, verdict: "blocked", reason: `${client} cleared for ${uses.join(", ")} but not ${wanted}.`, uses };
  }
  return {
    ok: true,
    verdict: expiresSoon ? "ok-expiring" : "ok",
    reason: expiresSoon
      ? `Cleared (${uses.join(", ")}) but expires soon — ${fromEpoch(row.expires_on)}.`
      : `Cleared for ${uses.join(", ")}${row.expires_on ? ` until ${fromEpoch(row.expires_on)}` : " (perpetual)"}.`,
    uses,
    exclusive: !!row.exclusive,
    expires: fromEpoch(row.expires_on),
    clearedBy: row.cleared_by,
  };
}

/**
 * List rights, filterable by client / asset substring. Used for audits and
 * expiry-window reports. Always returns the rows in a JSON-friendly shape with
 * uses as an array (not the stored JSON string).
 */
export function listUsageRights({ client = null, assetLike = null, expiringDays = null } = {}) {
  const where = [];
  const params = [];
  if (client) { where.push("client = ?"); params.push(client); }
  if (assetLike) { where.push("asset_path LIKE ?"); params.push(`%${assetLike}%`); }
  if (Number.isFinite(expiringDays)) {
    const cutoff = Date.now() + expiringDays * 24 * 60 * 60 * 1000;
    where.push("expires_on IS NOT NULL AND expires_on < ?");
    params.push(cutoff);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM usage_rights ${whereClause} ORDER BY created_at DESC LIMIT 500`).all(...params);
  return {
    ok: true,
    count: rows.length,
    rows: rows.map(r => ({
      asset: r.asset_path,
      client: r.client,
      uses: safeUses(r.uses),
      clearedBy: r.cleared_by,
      clearedOn: fromEpoch(r.cleared_on),
      expiresOn: fromEpoch(r.expires_on),
      exclusive: !!r.exclusive,
      notes: r.notes,
    })),
  };
}

/** Manually revoke a clearance (campaign cancelled, scope reduced, etc). */
export function expireUsageRights({ assetPath, client } = {}) {
  const asset = normaliseAsset(assetPath);
  if (!asset || !client) return { ok: false, error: "assetPath and client required" };
  const r = db.prepare("UPDATE usage_rights SET expires_on=? WHERE asset_path=? AND client=?").run(Date.now(), asset, client);
  return { ok: true, updated: r.changes };
}
