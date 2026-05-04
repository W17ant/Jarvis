/** autocull.mjs - Caption-similarity-based shoot-folder auto-cull.
 *
 *  Why: an FOM shoot day produces 200-500 stills, often with 4-8 near-duplicates
 *  per setup (bracketed exposures, slight composition variants). Manually culling
 *  to keepers takes 30-60 minutes. This tool:
 *    1. Ensures every still in the folder has a Vision-cached caption + embedding
 *    2. Groups near-duplicates by cosine similarity above the threshold (default 0.92)
 *    3. For each group, keeps the lexicographically-first file and flags the rest
 *       as "skip" via shotflag.mjs — operator can manually un-skip the wrong picks
 *    4. Returns a summary the LLM reads aloud
 *
 *  Sharpness-based "best of group" picking is a future enhancement (would require
 *  laplacian variance via ImageMagick); v1 keeps it predictable + fast. Operator
 *  can reverse a wrong pick easily — every flag is in the SQLite undo stack so
 *  "scratch that" rewinds the most recent. Bulk undo for an entire cull batch
 *  isn't yet supported (P3 polish later). */

import Database from "better-sqlite3";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as Vision from "./vision.mjs";
import * as Shotflag from "./shotflag.mjs";
import * as Paths from "./paths.mjs";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
/* SHOOTS_DIR resolved at call sites via Paths.getShootsDir(). */

/* Side-channel SQLite handle to read the frame_captions table written by vision.mjs.
 * Same DB file (memory.db) so all caching is consistent. */
const db = new Database(path.join(PROJECT_DIR, "data", "memory.db"));
db.pragma("journal_mode = WAL");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff"]);

function bufferToVector(buf) {
  if (!buf) return null;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

async function resolveFolder(folder) {
  const shootsDir = Paths.getShootsDir();
  if (folder) {
    const abs = path.isAbsolute(folder) ? folder : path.join(shootsDir, folder);
    if (existsSync(abs) && Paths.isWithinAllowedRoots(abs)) return abs;
  }
  if (!existsSync(shootsDir)) return null;
  const ents = await readdir(shootsDir, { withFileTypes: true });
  const dirs = ents.filter(e => e.isDirectory()).map(e => path.join(shootsDir, e.name));
  if (!dirs.length) return null;
  const stats = await Promise.all(dirs.map(async d => ({ d, mt: (await stat(d)).mtimeMs })));
  stats.sort((a, b) => b.mt - a.mt);
  return stats[0].d;
}

/**
 * Run the cull.
 * @param {object} args
 * @param {string} [args.folder]      Shoot folder (defaults to most recent)
 * @param {number} [args.threshold=0.92]  Cosine similarity threshold for "duplicate"
 * @param {number} [args.sampleCount=120] How many files to caption (caps cost on huge folders)
 * @param {boolean} [args.dryRun]     Report without flagging
 */
export async function autoCull(args = {}) {
  const folderAbs = await resolveFolder(args.folder);
  if (!folderAbs) return { ok: false, error: "no shoot folder found" };
  const folderName = path.basename(folderAbs);
  const threshold = Math.max(0.7, Math.min(0.99, Number(args.threshold) || 0.92));
  const sampleCount = Math.max(20, Math.min(500, Number(args.sampleCount) || 120));
  const dryRun = !!args.dryRun;

  /* Ensure captions cached. captionShootFolder samples evenly + writes embeddings. */
  await Vision.captionShootFolder({ folder: folderName, sampleCount });

  /* Pull all captions for this folder. */
  const rows = db.prepare("SELECT path, caption, embedding FROM frame_captions WHERE shoot_folder = ?").all(folderName);
  const enriched = rows.map(r => ({
    file: path.basename(r.path),
    caption: r.caption,
    vec: bufferToVector(r.embedding),
  })).filter(r => r.vec);

  if (enriched.length < 2) {
    return { ok: false, error: `only ${enriched.length} captioned file(s) in ${folderName} — increase sampleCount or wait for captioning to complete` };
  }

  /* Greedy union-find: walk the list, group items above the similarity threshold. */
  const groups = [];
  const assigned = new Set();
  for (let i = 0; i < enriched.length; i++) {
    if (assigned.has(i)) continue;
    const group = [i];
    assigned.add(i);
    for (let j = i + 1; j < enriched.length; j++) {
      if (assigned.has(j)) continue;
      const sim = cosine(enriched[i].vec, enriched[j].vec);
      if (sim >= threshold) {
        group.push(j);
        assigned.add(j);
      }
    }
    if (group.length >= 2) groups.push(group);
  }

  /* For each group, keep the lexicographically-first file (predictable + reversible)
   * and skip-flag the rest. Operator can re-flag manually if a different keeper is wanted. */
  let culled = 0;
  const cullDetails = [];
  for (const idxs of groups) {
    const filenames = idxs.map(i => enriched[i].file).sort();
    const keeper = filenames[0];
    const losers = filenames.slice(1);
    cullDetails.push({ keeper, culled: losers });
    if (!dryRun) {
      for (const f of losers) {
        const r = await Shotflag.flagShot({ folder: folderName, file: f, status: "skip", note: "auto-cull duplicate" });
        if (r.ok) culled++;
      }
    } else {
      culled += losers.length;
    }
  }

  return {
    ok: true,
    folder: folderName,
    captioned: enriched.length,
    groupsFound: groups.length,
    culled,
    keepers: groups.length,
    threshold,
    dryRun,
    sampleDetail: cullDetails.slice(0, 5),
    summary: dryRun
      ? `Dry run on ${folderName} — ${groups.length} duplicate groups detected, ${culled} files would be skip-flagged.`
      : `Culled ${folderName}: ${culled} files flagged skip across ${groups.length} duplicate groups (kept ${groups.length} keepers).`,
  };
}
