/** lightroom-catalog.mjs - Read-only access to a Lightroom Classic catalogue.
 *
 *  `.lrcat` files are SQLite databases. Reading them while Lightroom is
 *  closed is safe; we open in readonly mode so even mid-edit scenarios
 *  don't risk corruption. Lightroom's own SDK only supports Lua plugins
 *  running inside the app — for our voice-kiosk use case ("find five-star
 *  Bentley shots from May", "what did I shoot last Tuesday") direct SQLite
 *  is the cleanest path.
 *
 *  Catalogue path discovery order:
 *    1. Operator-set: process.env.LIGHTROOM_CATALOG (most explicit)
 *    2. Standard install: ~/Pictures/Lightroom/<Catalog>.lrcat
 *    3. Recent-catalog list: Adobe persists this in
 *       ~/Library/Application Support/Adobe/Lightroom/Preferences/
 *       Lightroom Catalog Recent.txt (best-effort parse)
 *
 *  Schema notes (LrC 12+, stable across releases):
 *    Adobe_images        — id_local, captureTime, rating, pick (-1/0/1),
 *                          colorLabels, fileFormat, baseName, extension
 *    AgLibraryFile       — id_local, idx_filename, folder, baseName
 *    AgLibraryFolder     — id_local, rootFolder, pathFromRoot
 *    AgLibraryRootFolder — id_local, absolutePath, name
 *    AgLibraryKeyword    — id_local, name (lc_name lowercase variant)
 *    AgLibraryKeywordImage — image (FK), tag (FK)
 *
 *  Reconstruction of file path:
 *    rootFolder.absolutePath + folder.pathFromRoot + file.idx_filename
 *
 *  Separate from bridge/lightroom.mjs (XMP-sidecar preset writer) — both
 *  modules touch Lightroom data but at completely different layers.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let _cachedPath = null;

/** Locate the operator's Lightroom catalogue. Returns absolute path or
 *  null if nothing found. Cached on first hit (invalidate by clearing
 *  the module — there's no public reset because catalogues don't move). */
export function findCatalogPath() {
  if (_cachedPath && fs.existsSync(_cachedPath)) return _cachedPath;
  const env = process.env.LIGHTROOM_CATALOG;
  if (env && fs.existsSync(env)) { _cachedPath = env; return env; }
  const home = os.homedir();
  const stdDir = path.join(home, "Pictures", "Lightroom");
  if (fs.existsSync(stdDir)) {
    const candidates = fs.readdirSync(stdDir).filter((f) => f.endsWith(".lrcat"));
    if (candidates.length === 1) {
      _cachedPath = path.join(stdDir, candidates[0]);
      return _cachedPath;
    }
    if (candidates.length > 1) {
      /* Multiple catalogues — pick most-recently modified. Adam likely
       * works in only one but multi-cat shops exist. */
      const ranked = candidates
        .map((f) => ({ f, m: fs.statSync(path.join(stdDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      _cachedPath = path.join(stdDir, ranked[0].f);
      return _cachedPath;
    }
  }
  /* Adobe persists the recent-catalog list in this prefs file. Best-effort
   * parse — if it's missing/malformed we just return null. */
  const prefs = path.join(home, "Library", "Application Support", "Adobe", "Lightroom", "Preferences", "Lightroom Catalog Recent.txt");
  try {
    if (fs.existsSync(prefs)) {
      const txt = fs.readFileSync(prefs, "utf8");
      const m = txt.match(/([^\r\n"]+\.lrcat)/);
      if (m && fs.existsSync(m[1])) { _cachedPath = m[1]; return m[1]; }
    }
  } catch {}
  return null;
}

function openRead(catPath) {
  /* readonly + fileMustExist: throws if missing instead of creating a fresh
   * empty database. Even with Lightroom open, readonly is safe — SQLite's
   * file-locking guarantees consistent reads. */
  return new Database(catPath, { readonly: true, fileMustExist: true });
}

/** Find photos in the catalogue matching filter criteria.
 *
 *  @param {object} args
 *  @param {number} [args.rating]    Minimum star rating (0-5). Returns >= this.
 *  @param {number} [args.pick]      Pick flag — 1=picked, -1=rejected, 0=neutral.
 *  @param {string} [args.after]     ISO date string. Capture time >= this.
 *  @param {string} [args.before]    ISO date string. Capture time <= this.
 *  @param {string} [args.keyword]   Substring match on a keyword (case-insensitive).
 *  @param {string} [args.format]    File format filter ("RAW", "JPEG", etc).
 *  @param {number} [args.limit]     Max rows (default 50, cap 500).
 *  @returns {{ ok, count, photos: Array, catalog }}
 */
export async function findLrPhoto(args = {}) {
  const cat = findCatalogPath();
  if (!cat) {
    return {
      ok: false,
      error: "no Lightroom catalogue found. Set LIGHTROOM_CATALOG=<path>.lrcat in .env, or place your catalogue at ~/Pictures/Lightroom/.",
    };
  }
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 500);
  const minRating = args.rating != null ? Math.max(0, Math.min(5, parseInt(args.rating, 10))) : null;

  let db;
  try { db = openRead(cat); }
  catch (e) { return { ok: false, error: `failed to open catalogue: ${e.message}`, catalog: cat }; }

  try {
    /* Build the WHERE clause incrementally so unused filters drop out.
     * Keyword join is added only when needed — catalogues can have
     * millions of photo-keyword links. */
    const clauses = [];
    const params = [];

    if (minRating != null) { clauses.push("img.rating >= ?"); params.push(minRating); }
    if (args.pick != null) { clauses.push("img.pick = ?");    params.push(parseInt(args.pick, 10)); }
    if (args.after)        { clauses.push("img.captureTime >= ?"); params.push(String(args.after)); }
    if (args.before)       { clauses.push("img.captureTime <= ?"); params.push(String(args.before)); }
    if (args.format)       { clauses.push("img.fileFormat = ?"); params.push(String(args.format).toUpperCase()); }

    let keywordJoin = "";
    if (args.keyword) {
      keywordJoin = `
        INNER JOIN AgLibraryKeywordImage ki ON ki.image = img.id_local
        INNER JOIN AgLibraryKeyword      kw ON kw.id_local = ki.tag
      `;
      clauses.push("LOWER(kw.name) LIKE ?");
      params.push(`%${String(args.keyword).toLowerCase()}%`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `
      SELECT
        img.id_local       AS imageId,
        img.captureTime    AS captureTime,
        img.rating         AS rating,
        img.pick           AS pick,
        img.fileFormat     AS fileFormat,
        f.idx_filename     AS filename,
        folder.pathFromRoot AS folderPath,
        root.absolutePath  AS rootPath
      FROM Adobe_images img
      INNER JOIN AgLibraryFile       f      ON f.id_local      = img.rootFile
      INNER JOIN AgLibraryFolder     folder ON folder.id_local = f.folder
      INNER JOIN AgLibraryRootFolder root   ON root.id_local   = folder.rootFolder
      ${keywordJoin}
      ${where}
      ORDER BY img.captureTime DESC
      LIMIT ?
    `;
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    const photos = rows.map((r) => ({
      path: path.join(r.rootPath || "", r.folderPath || "", r.filename || ""),
      captureTime: r.captureTime,
      rating: r.rating,
      pick: r.pick,
      fileFormat: r.fileFormat,
    }));
    return {
      ok: true,
      count: photos.length,
      photos,
      catalog: path.basename(cat),
      catalogPath: cat,
    };
  } catch (e) {
    return { ok: false, error: `query failed: ${e.message}`, catalog: cat };
  } finally {
    try { db.close(); } catch {}
  }
}

/** Quick diagnostic — does the catalogue exist + is it readable? */
export async function lightroomCatalogStatus() {
  const cat = findCatalogPath();
  if (!cat) return { ok: false, found: false, hint: "set LIGHTROOM_CATALOG in .env, or use the standard ~/Pictures/Lightroom/ location" };
  try {
    const db = openRead(cat);
    const stats = db.prepare("SELECT COUNT(*) AS n FROM Adobe_images").get();
    db.close();
    return {
      ok: true,
      found: true,
      catalog: path.basename(cat),
      catalogPath: cat,
      photoCount: stats.n,
    };
  } catch (e) {
    return { ok: false, found: true, catalog: cat, error: e.message };
  }
}
