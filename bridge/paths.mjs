/** paths.mjs - Single source of truth for the operator-configurable shoots + output dirs.
 *
 *  Why: every bridge module used to compute `path.join(PROJECT_DIR, "shoots")` /
 *  `path.join(PROJECT_DIR, "output")` inline, which made the install hard-pinned to the
 *  repo directory. Operators on different machines want their shoots on a NAS or fast
 *  external SSD and their output on whatever drive is least full. This module reads
 *  those roots from `config/brand.json` `.paths` block (with PROJECT_DIR fallbacks) and
 *  exposes a stable resolver so call sites don't care where the data physically lives.
 *
 *  The output directory carries a fixed sub-folder taxonomy (OUTPUT_SUBDIRS below) so the
 *  operator's MAIN folder always organises into the same shape: youtube/{thumbnails,shorts},
 *  instagram/{reels,posts}, tiktok, brand-packs, pdf, watermarked, aspects, portraits,
 *  contactsheets, premiere-renders, videos. Modules call getOutputSubdir(key) to land in
 *  the right bucket without each caller re-coining the path.
 *
 *  Exports:
 *    getShootsDir()              - absolute path to current shoots root (auto-mkdir on first use)
 *    getOutputDir()              - absolute path to current output root (auto-mkdir on first use)
 *    getOutputSubdir(key)        - absolute path to a deliverable sub-folder, key from OUTPUT_SUBDIRS
 *    OUTPUT_SUBDIRS              - the canonical taxonomy (frozen object)
 *    getPaths()                  - { shoots, output, shootsConfigured, outputConfigured }
 *    setPaths({ shoots?, output? }) - validate, persist to brand.json, invalidate cache
 *    invalidatePathsCache()      - drop the in-memory cache (called by /brand reload)
 */

import path from "node:path";
import fs from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BRAND_PATH = path.join(PROJECT_DIR, "config", "brand.json");

/* The canonical deliverable taxonomy. Keys are the stable identifiers that bridge tools
 * use; values are the on-disk subfolder layout under getOutputDir(). Adding a new key here
 * is the *only* place to register a new deliverable type — every tool then gets the path
 * via getOutputSubdir(key). Keeping this list short and platform-grouped makes the
 * operator's output folder readable when they open it in Finder. */
export const OUTPUT_SUBDIRS = Object.freeze({
  youtubeThumbnails:  "youtube/thumbnails",     // 1280x720 promo cards
  youtubeShorts:      "youtube/shorts",          // 9:16 < 60s edits
  instagramReels:     "instagram/reels",         // 9:16 vertical edits
  instagramPosts:     "instagram/posts",         // 1:1 + 4:5 stills
  tiktok:             "tiktok",                  // 9:16 edits scoped for TikTok
  brandPacks:         "brand-packs",             // multi-aspect deliverable zips
  pdfs:               "pdf",                     // generated PDFs (quote/brief/release)
  watermarked:        "watermarked",             // batch-watermarked source files
  aspects:            "aspects",                 // multi-aspect crops of a hero shot
  portraits:          "portraits",               // 9:16 portrait crops
  contactsheets:      "contactsheets",           // contact-sheet PNGs
  premiereRenders:    "premiere-renders",        // Premiere render output
  videos:             "videos",                  // generic teaser/edit output
  thumbnails:         "thumbnails",              // legacy alias — kept for now
});

/* In-memory cache of the resolved roots. Invalidated when brand.json is rewritten via
 * /settings or setPaths(). Lazy: only loaded on first call so module import is cheap. */
let cache = null;

/** Read brand.json paths block. Returns the resolved roots; falls back to PROJECT_DIR
 *  defaults on any failure so a half-configured install still works. */
function loadCache() {
  if (cache) return cache;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(BRAND_PATH, "utf8")); } catch { /* missing/corrupt → defaults */ }
  const p = raw?.paths || {};
  /* If the configured value is relative, resolve under PROJECT_DIR; absolute paths pass
   * through. This lets the operator type "shoots" or "/Volumes/Workdrive/Shoots" and have
   * both behave correctly. */
  const resolveOrDefault = (val, defaultName) => {
    const v = (val || "").trim();
    if (!v) return path.join(PROJECT_DIR, defaultName);
    return path.isAbsolute(v) ? v : path.join(PROJECT_DIR, v);
  };
  cache = {
    shoots: resolveOrDefault(p.shoots, "shoots"),
    output: resolveOrDefault(p.output, "output"),
    shootsConfigured: !!p.shoots,
    outputConfigured: !!p.output,
  };
  return cache;
}

export function invalidatePathsCache() { cache = null; }

/** Auto-create the directory if it doesn't yet exist. mkdir recursive is idempotent. */
function ensureDirSync(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* permission etc — caller will see the next op fail */ }
  return p;
}

export function getShootsDir() { return ensureDirSync(loadCache().shoots); }
export function getOutputDir() { return ensureDirSync(loadCache().output); }

/** Resolve a deliverable sub-folder under the output root. Throws if `key` isn't in the
 *  canonical taxonomy — this is intentional, so a typo at a call site fails loudly
 *  instead of writing to a typoed dir. */
export function getOutputSubdir(key) {
  const sub = OUTPUT_SUBDIRS[key];
  if (!sub) throw new Error(`paths.getOutputSubdir: unknown key "${key}". Valid: ${Object.keys(OUTPUT_SUBDIRS).join(", ")}`);
  return ensureDirSync(path.join(getOutputDir(), sub));
}

/** True if `abs` resolves inside one of the trusted roots — PROJECT_DIR, the configured
 *  shoots root, or the configured output root. Modules use this as the path-traversal
 *  guard for absolute-path arguments: pre-folder-config they could just check
 *  startsWith(PROJECT_DIR), but with the operator-configurable roots a legitimate shoots
 *  path may live outside PROJECT_DIR (e.g. /Volumes/Workdrive/Shoots). */
export function isWithinAllowedRoots(abs) {
  if (!abs) return false;
  const c = loadCache();
  return abs.startsWith(PROJECT_DIR) || abs.startsWith(c.shoots) || abs.startsWith(c.output);
}

export function getPaths() {
  const c = loadCache();
  return {
    shoots: c.shoots,
    output: c.output,
    shootsConfigured: c.shootsConfigured,
    outputConfigured: c.outputConfigured,
    /* Echo the taxonomy back so settings UI can render the sub-folder list without
     * importing this module on the client. */
    outputSubdirs: { ...OUTPUT_SUBDIRS },
  };
}

/** Persist new paths to brand.json. Validates that each path exists OR can be created;
 *  if mkdir fails (permission denied, parent missing) the call rejects without writing. */
export async function setPaths({ shoots, output }) {
  const updates = {};
  if (typeof shoots === "string" && shoots.trim()) updates.shoots = shoots.trim();
  if (typeof output === "string" && output.trim()) updates.output = output.trim();
  if (Object.keys(updates).length === 0) return { ok: true, updated: {} };

  /* Pre-flight: try to create each requested directory. Surfaces "permission denied" /
   * "no such parent" before we modify brand.json — the operator gets a clear error
   * instead of a silent half-write. */
  for (const [key, val] of Object.entries(updates)) {
    const abs = path.isAbsolute(val) ? val : path.join(PROJECT_DIR, val);
    try { await mkdir(abs, { recursive: true }); }
    catch (e) { throw new Error(`cannot create ${key} path "${abs}": ${e.message}`); }
  }

  let raw = {};
  try { raw = JSON.parse(await readFile(BRAND_PATH, "utf8")); } catch {}
  raw.paths = { ...(raw.paths || {}), ...updates };
  await writeFile(BRAND_PATH, JSON.stringify(raw, null, 2));
  invalidatePathsCache();
  return { ok: true, updated: updates, resolved: getPaths() };
}
