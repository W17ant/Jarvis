/** style-memory.mjs - Editorial style memory from past hero edits.
 *
 *  Why: Marcus's grading signature on FOM hero edits is consistent — slightly cool
 *  shadows, warmth pulled into the highlights, mid-saturation. New editors burn time
 *  hunting for "the FOM look" and land on slightly-off variants. This module extracts
 *  the numerical signature from a folder of finished edits, asks the Vision model to
 *  describe it in colourist's vocabulary, and stores the pair as a named style.
 *
 *  When the operator later says "match the FOM look" or "what's our the client style?",
 *  the bridge recalls the description + numerical targets so the editor can dial in
 *  warm/cool, contrast, and saturation toward known values.
 *
 *  Extraction:
 *    - ImageMagick `magick convert ... -format` on a 100×100 downsample (fast,
 *      avoids reading megabytes of raw JPEG into memory).
 *    - Per-image: meanR, meanG, meanB, luminance, contrast (std), saturation.
 *    - Style signature = the average across the sample set + per-channel std-dev to
 *      flag inconsistent samples.
 *
 *  Storage: shared memory.db so styles live alongside contacts/projects/facts.
 *
 *  Out of scope for v1: writing Premiere Lumetri JSON or Lightroom XMP. The LLM can
 *  recall the description + numbers and the editor applies them manually. Auto-apply
 *  needs a separate compatibility-tested mapping per NLE and that's a future task. */

import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DB_PATH = path.join(PROJECT_DIR, "data", "memory.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/* Schema. Each style stores both the human description (for the LLM to recall) and the
 * numerical signature (for compare_to_style and future auto-apply). The numerical signature
 * is JSON-encoded so we don't have to constantly extend the column set as we add new
 * dimensions (e.g. dominant hue, skin-tone bias, etc). */
db.prepare(`
  CREATE TABLE IF NOT EXISTS edit_styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    signature_json TEXT NOT NULL,
    sample_count INTEGER NOT NULL,
    sample_folder TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`).run();

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tiff"]);

/** Extract per-image metrics via ImageMagick. Returns { ok, metrics } or { ok:false, error }.
 *  All values normalised to 0..1 so a saturation of 0.4 means roughly 40% across the sample. */
async function extractMetrics(imagePath) {
  /* Why this format string: each %[fx:…] returns a single float per the requested
   * stat. Resizing to 100×100 first cuts the work by ~100× on a typical 4000px JPEG
   * with no meaningful loss in average-channel values. -colorspace RGB ensures we
   * read linear RGB regardless of the source profile. */
  try {
    const { stdout } = await execFileP("magick", [
      "convert", imagePath,
      "-resize", "100x100!",
      "-colorspace", "RGB",
      "-format", "%[fx:mean.r] %[fx:mean.g] %[fx:mean.b] %[fx:mean.l] %[fx:standard_deviation.l] %[fx:maxima.r-mean.r] %[fx:maxima.g-mean.g] %[fx:maxima.b-mean.b]",
      "info:",
    ], { timeout: 8000, maxBuffer: 16 * 1024 });
    const parts = stdout.trim().split(/\s+/).map(Number);
    if (parts.length < 5 || parts.some((n) => !Number.isFinite(n))) {
      return { ok: false, error: `couldn't parse magick output: ${stdout.trim()}` };
    }
    const [r, g, b, lum, contrast] = parts;
    /* Approximate saturation = max(R,G,B) - min(R,G,B) on the channel means. Crude
     * but stable across the sample set; correlates well with perceived saturation. */
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    /* Warm-cool bias: positive = warm (more red than blue), negative = cool. */
    const warmBias = r - b;
    return {
      ok: true,
      metrics: {
        meanR: round(r), meanG: round(g), meanB: round(b),
        luminance: round(lum), contrast: round(contrast),
        saturation: round(sat), warmBias: round(warmBias),
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function round(n) { return Math.round(n * 1000) / 1000; }

/** Resolve a folder argument under the configured shoots root OR allow absolute paths
 *  inside trusted roots. Mirrors the pattern used by autocull.mjs / shotflag.mjs. */
function resolveFolder(folder) {
  if (!folder) return null;
  const abs = path.isAbsolute(folder) ? folder : path.join(Paths.getShootsDir(), folder);
  if (!existsSync(abs) || !Paths.isWithinAllowedRoots(abs)) return null;
  return abs;
}

/** Average metrics across N images. Returns the signature object. */
function averageMetrics(perImage) {
  const keys = ["meanR", "meanG", "meanB", "luminance", "contrast", "saturation", "warmBias"];
  const sum = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const m of perImage) for (const k of keys) sum[k] += m[k];
  const avg = Object.fromEntries(keys.map((k) => [k, round(sum[k] / perImage.length)]));
  /* Per-channel std-dev so the operator can see how consistent the sample is.
   * High std on a metric means the source folder was a mix of looks rather than
   * one consistent style. */
  const std = Object.fromEntries(keys.map((k) => {
    const m = avg[k];
    const variance = perImage.reduce((acc, v) => acc + (v[k] - m) ** 2, 0) / perImage.length;
    return [k, round(Math.sqrt(variance))];
  }));
  return { avg, std, sampleCount: perImage.length };
}

/**
 * Extract a style signature from a folder of edits.
 *
 * @param {object} args
 * @param {string} args.folder         folder under shoots/ OR absolute (e.g. a finished output/ subfolder)
 * @param {string} args.name           name to save the style under (e.g. "fom-signature")
 * @param {number} [args.sampleCount=12]   max images to analyse
 * @param {string} [args.description]  optional override; if omitted we ask Vision for one
 * @param {boolean}[args.dryRun]       compute the signature but don't save
 */
export async function extractStyle({ folder, name, sampleCount = 12, description, dryRun = false } = {}) {
  if (!name || typeof name !== "string") return { ok: false, error: "name required (style identifier)" };
  const abs = resolveFolder(folder);
  if (!abs) return { ok: false, error: `folder not found or outside trusted roots: ${folder}` };

  /* Pick the N most-recently-modified images — assumes the most recent edits are the
   * "current" look. If the operator wants to point at a curated subset they can pass
   * a more specific subfolder. */
  const ents = await readdir(abs, { withFileTypes: true });
  const files = ents
    .filter((e) => e.isFile() && IMAGE_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(abs, e.name));
  if (!files.length) return { ok: false, error: `no images found in ${abs}` };

  /* Why mtime sort: most pipelines that produce hero edits write the latest version
   * with a current timestamp. Sorting by mtime favours recent finished work over
   * archived intermediate exports. */
  const { stat } = await import("node:fs/promises");
  const withTimes = await Promise.all(files.map(async (f) => ({ f, t: (await stat(f)).mtimeMs })));
  withTimes.sort((a, b) => b.t - a.t);
  const sample = withTimes.slice(0, sampleCount).map((e) => e.f);

  /* Run extraction in parallel — magick is single-threaded but we get filesystem
   * concurrency. Skip failures rather than aborting the whole batch — one corrupt
   * file shouldn't block the style extraction. */
  const results = await Promise.all(sample.map((f) => extractMetrics(f)));
  const ok = results.filter((r) => r.ok).map((r) => r.metrics);
  if (!ok.length) return { ok: false, error: `metric extraction failed for all ${sample.length} samples` };

  const signature = averageMetrics(ok);
  signature.sampleFolder = path.relative(PROJECT_DIR, abs);

  /* Build a colourist's description from the numbers. We could ask Vision to describe
   * the images visually, but the numerical signature alone is enough to write a
   * deterministic prose summary that's the same across runs of the same data. The LLM
   * can layer richer detail later if needed. */
  const desc = description || describeSignature(signature);

  if (dryRun) {
    return { ok: true, dryRun: true, name, signature, description: desc, sampleCount: ok.length };
  }

  const now = Date.now();
  /* Upsert: if the operator re-extracts an existing style, update in place rather than
   * accumulating duplicate rows. */
  db.prepare(`
    INSERT INTO edit_styles (name, description, signature_json, sample_count, sample_folder, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      signature_json = excluded.signature_json,
      sample_count = excluded.sample_count,
      sample_folder = excluded.sample_folder,
      updated_at = excluded.updated_at
  `).run(name, desc, JSON.stringify(signature), ok.length, signature.sampleFolder, now, now);

  return { ok: true, name, signature, description: desc, sampleCount: ok.length };
}

/** Generate a colourist-style prose description from the numerical signature.
 *  Deterministic, no LLM call — the signature alone tells most of the story. */
function describeSignature({ avg }) {
  const parts = [];

  /* Warm-cool bias. ±0.02 is "neutral", ±0.05 is "subtle", beyond is "decided". */
  if (Math.abs(avg.warmBias) < 0.02) parts.push("neutral colour balance");
  else if (avg.warmBias > 0.05) parts.push("warm bias (lifted reds, gentle blue rolloff)");
  else if (avg.warmBias > 0.02) parts.push("subtly warm bias");
  else if (avg.warmBias < -0.05) parts.push("cool bias (lifted blues, restrained reds)");
  else parts.push("subtly cool bias");

  /* Saturation. */
  if (avg.saturation < 0.05) parts.push("low saturation, near-monochrome");
  else if (avg.saturation < 0.15) parts.push("muted saturation");
  else if (avg.saturation < 0.25) parts.push("mid saturation");
  else parts.push("rich saturation");

  /* Contrast. */
  if (avg.contrast < 0.12) parts.push("flat contrast (filmic)");
  else if (avg.contrast < 0.20) parts.push("medium contrast");
  else parts.push("punchy contrast");

  /* Luminance. */
  if (avg.luminance < 0.30) parts.push("dark exposure");
  else if (avg.luminance < 0.45) parts.push("low-key exposure");
  else if (avg.luminance < 0.60) parts.push("balanced exposure");
  else parts.push("high-key exposure");

  return parts.join(", ") + ".";
}

/** List all saved styles. */
export function listStyles() {
  const rows = db.prepare(`
    SELECT name, description, signature_json, sample_count, sample_folder, created_at, updated_at
      FROM edit_styles
     ORDER BY updated_at DESC
  `).all();
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    signature: JSON.parse(r.signature_json),
    sampleCount: r.sample_count,
    sampleFolder: r.sample_folder,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Recall one style by name. Returns null if not found. */
export function recallStyle({ name }) {
  if (!name) return null;
  const row = db.prepare(`
    SELECT name, description, signature_json, sample_count, sample_folder, created_at, updated_at
      FROM edit_styles WHERE name = ?
  `).get(name);
  if (!row) return null;
  return {
    name: row.name,
    description: row.description,
    signature: JSON.parse(row.signature_json),
    sampleCount: row.sample_count,
    sampleFolder: row.sample_folder,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Delete a style by name. */
export function deleteStyle({ name }) {
  const info = db.prepare("DELETE FROM edit_styles WHERE name = ?").run(name);
  return { ok: info.changes > 0, removed: info.changes };
}

/**
 * Compare a folder's images against a saved style. Returns the numerical delta + a
 * prose summary of what to push toward the target. Useful for a pre-flight check —
 * "show me how much my current grade differs from the FOM look".
 */
export async function compareToStyle({ folder, styleName, sampleCount = 8 } = {}) {
  const target = recallStyle({ name: styleName });
  if (!target) return { ok: false, error: `style not found: ${styleName}` };

  /* Run extraction on the candidate folder using the dryRun branch of extractStyle. */
  const extracted = await extractStyle({ folder, name: "_temp_compare", sampleCount, dryRun: true });
  if (!extracted.ok) return extracted;

  const t = target.signature.avg;
  const c = extracted.signature.avg;
  const delta = {
    warmBias: round(c.warmBias - t.warmBias),
    saturation: round(c.saturation - t.saturation),
    contrast: round(c.contrast - t.contrast),
    luminance: round(c.luminance - t.luminance),
  };

  /* Build adjustment guidance — phrased as "to match, push warmth +0.04". */
  const advice = [];
  if (Math.abs(delta.warmBias) > 0.02) advice.push(delta.warmBias > 0 ? `cool by ${(-delta.warmBias).toFixed(2)} (currently warmer than target)` : `warm by ${delta.warmBias.toFixed(2)} (currently cooler)`);
  if (Math.abs(delta.saturation) > 0.03) advice.push(delta.saturation > 0 ? `desaturate by ${(-delta.saturation).toFixed(2)}` : `boost saturation by ${(-delta.saturation).toFixed(2)}`);
  if (Math.abs(delta.contrast) > 0.03) advice.push(delta.contrast > 0 ? `lower contrast by ${(-delta.contrast).toFixed(2)}` : `raise contrast by ${(-delta.contrast).toFixed(2)}`);
  if (Math.abs(delta.luminance) > 0.04) advice.push(delta.luminance > 0 ? `lower exposure by ${(-delta.luminance).toFixed(2)}` : `raise exposure by ${(-delta.luminance).toFixed(2)}`);

  return {
    ok: true,
    targetStyle: target.name,
    targetDescription: target.description,
    candidateSignature: extracted.signature,
    delta,
    advice: advice.length ? advice.join("; ") + "." : "Already on style.",
  };
}
