/** shotflag.mjs - Voice-driven shot quality flags for the editor.
 *
 *  On a shoot, the operator wants to flag a frame mid-shoot ("flag this one as
 *  hero", "skip the last three", "remember to reshoot rear three-quarter") so the
 *  editor finds them later without sifting the whole take. We persist flags in
 *  SQLite alongside the shoot folder so they survive sessions and travel with the
 *  project.
 *
 *  Tools the LLM can call:
 *    flag_shot         - tag a specific file (or "the last shot") with keep / maybe / skip / reshoot + note
 *    list_shot_flags   - read flags for a shoot folder, optionally filtered by status
 *    clear_shot_flag   - remove a single flag (mistakes happen)
 *
 *  Status vocabulary (kept tight on purpose so search is reliable):
 *    "hero"    – top of the pile, must end up in the cut/contact sheet
 *    "keep"    – good, worth grading
 *    "maybe"   – review later, on the bubble
 *    "skip"    – do not edit
 *    "reshoot" – on-set note for the photographer / second unit
 */

import Database from "better-sqlite3";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as Paths from "./paths.mjs";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");
/* SHOOTS_DIR resolved at call sites via Paths.getShootsDir(). */

/* Why: shares memory.db so backup/restore covers flags, captions, contacts in one snapshot. */
const db = new Database(path.join(DATA_DIR, "memory.db"));
db.pragma("journal_mode = WAL");

/* Why: schema split across multiple prepare().run() calls instead of a single multi-statement
 * exec() — keeps each DDL atomic and readable, matches the prepared-statement style used
 * throughout the rest of this module. */
const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS shot_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shoot_folder TEXT NOT NULL,
    file_name TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(shoot_folder, file_name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shotflag_folder ON shot_flags(shoot_folder)`,
  `CREATE INDEX IF NOT EXISTS idx_shotflag_status ON shot_flags(status)`,
];
for (const stmt of SCHEMA_STMTS) db.prepare(stmt).run();

const VALID_STATUS = new Set(["hero", "keep", "maybe", "skip", "reshoot"]);
const MEDIA_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff", ".dng", ".arw", ".cr2", ".cr3", ".nef", ".raf", ".mp4", ".mov", ".m4v"]);

/** Resolve a shoot-folder argument to an absolute path under shoots/. Falls back to most recent.
 *  Why: absolute paths are accepted only when they resolve INSIDE PROJECT_DIR — prevents an
 *  errant "flag this in /etc" call from doing anything. Bare names are joined under shoots/. */
async function resolveFolder(folder) {
  const shootsDir = Paths.getShootsDir();
  if (folder) {
    let abs = path.isAbsolute(folder) ? folder : path.join(shootsDir, folder);
    abs = path.resolve(abs);
    if (Paths.isWithinAllowedRoots(abs) && existsSync(abs)) return abs;
  }
  if (!existsSync(shootsDir)) return null;
  const ents = await readdir(shootsDir, { withFileTypes: true });
  const dirs = ents.filter(e => e.isDirectory()).map(e => path.join(shootsDir, e.name));
  if (!dirs.length) return null;
  const stats = await Promise.all(dirs.map(async d => ({ d, mt: (await stat(d)).mtimeMs })));
  stats.sort((a, b) => b.mt - a.mt);
  return stats[0].d;
}

/** Find the most recent media file in a shoot folder by mtime — for "flag the last shot". */
async function findLastShot(folderAbs) {
  const ents = await readdir(folderAbs).catch(() => []);
  const media = ents.filter(f => MEDIA_EXTS.has(path.extname(f).toLowerCase()));
  if (!media.length) return null;
  const stats = await Promise.all(media.map(async f => ({ f, mt: (await stat(path.join(folderAbs, f))).mtimeMs })));
  stats.sort((a, b) => b.mt - a.mt);
  return stats[0].f;
}

/**
 * Flag a single shot. file omitted → flags the most recently modified media file in the
 * folder (so "flag this one" / "flag the last shot" works without dictating filenames).
 * Upserts on (folder, file): re-flagging overwrites status + note.
 *
 * @param {{folder?:string, file?:string, status:string, note?:string}} args
 */
export async function flagShot({ folder, file, status, note = null } = {}) {
  if (!status || !VALID_STATUS.has(status)) {
    return { ok: false, error: `status must be one of: ${[...VALID_STATUS].join(", ")}` };
  }
  const abs = await resolveFolder(folder);
  if (!abs) return { ok: false, error: "no shoot folder found" };
  const folderName = path.basename(abs);

  let fileName = file;
  if (!fileName) {
    fileName = await findLastShot(abs);
    if (!fileName) return { ok: false, error: `no media found in ${folderName}` };
  } else if (!existsSync(path.join(abs, fileName))) {
    /* Reject if the file isn't on disk — a flag for a missing file is almost always
     * a mishear. The bare-basename case (e.g. "DSC0193.jpg") works because we joined
     * it onto the resolved folder above. */
    return { ok: false, error: `${fileName} not found in ${folderName}` };
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO shot_flags (shoot_folder, file_name, status, note, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shoot_folder, file_name) DO UPDATE SET status=excluded.status, note=excluded.note, created_at=excluded.created_at
  `).run(folderName, fileName, status, note, now);

  return { ok: true, folder: folderName, file: fileName, status, note };
}

/** List flags for a folder. status filter is optional. */
export function listShotFlags({ folder = null, status = null } = {}) {
  let rows;
  if (folder && status) {
    rows = db.prepare("SELECT file_name, status, note, created_at FROM shot_flags WHERE shoot_folder=? AND status=? ORDER BY created_at DESC").all(folder, status);
  } else if (folder) {
    rows = db.prepare("SELECT file_name, status, note, created_at FROM shot_flags WHERE shoot_folder=? ORDER BY created_at DESC").all(folder);
  } else if (status) {
    rows = db.prepare("SELECT shoot_folder, file_name, status, note, created_at FROM shot_flags WHERE status=? ORDER BY created_at DESC").all(status);
  } else {
    rows = db.prepare("SELECT shoot_folder, file_name, status, note, created_at FROM shot_flags ORDER BY created_at DESC LIMIT 100").all();
  }
  return { ok: true, count: rows.length, flags: rows };
}

/** Clear a single flag. Used when the operator re-flags or dictates a correction. */
export function clearShotFlag({ folder, file } = {}) {
  if (!folder || !file) return { ok: false, error: "folder and file required" };
  const r = db.prepare("DELETE FROM shot_flags WHERE shoot_folder=? AND file_name=?").run(folder, file);
  return { ok: true, removed: r.changes };
}

/** Lookup flags for a list of files (used by hero-contact-sheet to honour "hero" picks).
 *  Why: SQLite's bound-parameter limit is 32k; chunk to 500-file slices so a "tag the
 *  whole archive" call can't blow up. Real shoots are ≤2k files, so usually one query. */
export function getFlagsByFile(folder, files) {
  if (!folder || !files?.length) return new Map();
  const stmt = (n) => db.prepare(`SELECT file_name, status, note FROM shot_flags WHERE shoot_folder=? AND file_name IN (${"?,".repeat(n).slice(0, -1)})`);
  const out = new Map();
  const CHUNK = 500;
  for (let i = 0; i < files.length; i += CHUNK) {
    const slice = files.slice(i, i + CHUNK);
    for (const r of stmt(slice.length).all(folder, ...slice)) {
      out.set(r.file_name, { status: r.status, note: r.note });
    }
  }
  return out;
}
