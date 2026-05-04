/** watermark.mjs - Batch watermark application across stills + clips.
 *
 *  Tool: batch_watermark({ folder, watermark?, opacity?, position?, scale?, recursive?, dryRun? })
 *
 *  Drives ImageMagick (`magick`) for stills and ffmpeg for video, both in the shell allowlist.
 *  Defaults to the FOM wordmark asset, bottom-right at 60% opacity, scaled to 12% of frame width.
 *  Outputs land under output/watermarked/<runId>/ alongside a manifest JSON the operator can
 *  diff later. Sources are never overwritten.
 *
 *  Why a separate module instead of run_shell: the per-asset command differs by extension and
 *  by frame size. Keeping the dispatch logic here means voice flow ("watermark today's deliverables,
 *  bottom-right at 50%") works in one tool call rather than orchestrating run_shell per file.
 */

import { readdir, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ASSETS_DIR = path.join(PROJECT_DIR, "assets");
/* OUTPUT_DIR / SHOOTS_DIR resolved via Paths.* — operator-configurable. */

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v"]);
const DEFAULT_WATERMARK = path.join(ASSETS_DIR, "fom-wordmark.png");

/* Why: ImageMagick gravity values map cleanly to the position vocabulary the operator uses.
 * "centre" intentionally British-spelled — it's a UK agency. */
const POSITION_MAP = {
  "bottom-right":  { gravity: "SouthEast", ffOverlayX: "main_w-overlay_w-margin", ffOverlayY: "main_h-overlay_h-margin" },
  "bottom-left":   { gravity: "SouthWest", ffOverlayX: "margin",                  ffOverlayY: "main_h-overlay_h-margin" },
  "top-right":     { gravity: "NorthEast", ffOverlayX: "main_w-overlay_w-margin", ffOverlayY: "margin" },
  "top-left":      { gravity: "NorthWest", ffOverlayX: "margin",                  ffOverlayY: "margin" },
  "center":        { gravity: "Center",    ffOverlayX: "(main_w-overlay_w)/2",    ffOverlayY: "(main_h-overlay_h)/2" },
  "centre":        { gravity: "Center",    ffOverlayX: "(main_w-overlay_w)/2",    ffOverlayY: "(main_h-overlay_h)/2" },
};

/** Resolve a source folder for batch watermarking. Honours absolute paths ONLY if they
 *  resolve inside PROJECT_DIR — otherwise the call is rejected. Bare names try shoots/
 *  first then the project root (so 'output/foo' and '2026-05-01-press-car' both work). */
async function resolveSource(folder) {
  if (!folder) return null;
  const candidates = path.isAbsolute(folder)
    ? [folder]
    : [path.join(Paths.getShootsDir(), folder), path.join(Paths.getOutputDir(), folder), path.join(PROJECT_DIR, folder)];
  for (const c of candidates) {
    const abs = path.resolve(c);
    if (Paths.isWithinAllowedRoots(abs) && existsSync(abs)) return abs;
  }
  return null;
}

/** Resolve watermark argument — accept absolute path, relative to project, or "fom" alias. */
function resolveWatermark(arg) {
  if (!arg || arg === "fom" || arg === "default") return DEFAULT_WATERMARK;
  const candidates = [
    path.isAbsolute(arg) ? arg : path.join(PROJECT_DIR, arg),
    path.join(ASSETS_DIR, arg),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Walk a directory recursively or shallowly, returning relative paths of media files. */
async function collectMedia(rootAbs, recursive = false) {
  const out = [];
  async function walk(dir, relPrefix = "") {
    const ents = await readdir(dir, { withFileTypes: true });
    for (const ent of ents) {
      if (ent.name.startsWith(".")) continue;
      const rel = path.join(relPrefix, ent.name);
      if (ent.isDirectory()) {
        if (recursive) await walk(path.join(dir, ent.name), rel);
        continue;
      }
      const ext = path.extname(ent.name).toLowerCase();
      if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) out.push(rel);
    }
  }
  await walk(rootAbs);
  return out.sort();
}

/**
 * Apply a watermark to a single still using ImageMagick. Returns { ok, output? , error? }.
 * Approach: pre-scale the watermark to a width matching `scale` × source width, set its
 * alpha channel to `opacity`, then composite at the requested gravity with a fixed margin.
 */
async function watermarkImage({ src, dest, watermark, opacity, scale, position, marginPx }) {
  const pos = POSITION_MAP[position] || POSITION_MAP["bottom-right"];
  /* Why: ImageMagick "magick" CLI (v7) — composite with -compose Over, -define
   * "compose:args=..." would force fixed offsets but gravity+geometry lets the
   * source orient itself. We pass margin via geometry so corners get padding. */
  const args = [
    src,
    "(", watermark,
        "-resize", `${Math.round(scale * 10000) / 100}%x`,
        "-alpha", "set",
        "-channel", "A", "-evaluate", "Multiply", String(opacity), "+channel",
    ")",
    "-gravity", pos.gravity,
    "-geometry", `+${marginPx}+${marginPx}`,
    "-compose", "Over", "-composite",
    dest,
  ];
  try {
    /* maxBuffer matched to ffmpeg path below — verbose ImageMagick warnings can
     * exceed 4MB on bulk jobs and would truncate to a less helpful error. */
    await execFileP("magick", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, output: dest };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString().slice(0, 300) || e.message };
  }
}

/**
 * Apply a watermark to a single clip using ffmpeg. Encodes with libx264 at CRF 18,
 * preserves audio with -c:a copy. Position is computed in pixels via overlay filter.
 */
async function watermarkVideo({ src, dest, watermark, opacity, scale, position, marginPx }) {
  const pos = POSITION_MAP[position] || POSITION_MAP["bottom-right"];
  /* Why: scale watermark to scale × main width, apply alpha via colorchannelmixer,
   * then overlay at the gravity-derived coordinates. The :enable='between(t,0,...)' clause
   * isn't used — we want it visible the entire duration. */
  const overlayX = pos.ffOverlayX.replace(/margin/g, String(marginPx));
  const overlayY = pos.ffOverlayY.replace(/margin/g, String(marginPx));
  const filter = [
    `[1:v]scale=iw*${scale}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm]`,
    `[0:v][wm]overlay=${overlayX}:${overlayY}:format=auto[v]`,
  ].join(";");

  const args = [
    "-y",
    "-i", src,
    "-i", watermark,
    "-filter_complex", filter,
    "-map", "[v]",
    "-map", "0:a?",
    "-c:v", "libx264", "-crf", "18", "-preset", "fast",
    "-c:a", "copy",
    "-movflags", "+faststart",
    dest,
  ];
  try {
    await execFileP("ffmpeg", args, { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, output: dest };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString().slice(-400) || e.message };
  }
}

/**
 * Main entry. Folder is mandatory (we don't ever silently watermark a default folder).
 * Returns processed file count + per-file results so the LLM can summarise outcomes.
 */
export async function batchWatermark(args = {}) {
  const folderAbs = await resolveSource(args.folder);
  if (!folderAbs) return { ok: false, error: "folder required (relative to shoots/, output/, or absolute)" };

  const watermarkPath = resolveWatermark(args.watermark);
  if (!watermarkPath) return { ok: false, error: `watermark not found: ${args.watermark}` };

  /* Defaults match FOM's house style (delivery cuts get a subtle bottom-right wordmark). */
  const opacity = clamp01(args.opacity ?? 0.6);
  const scale = clamp(args.scale ?? 0.12, 0.02, 0.5);
  const position = (args.position || "bottom-right").toLowerCase();
  const marginPx = Math.max(0, Math.round(Number(args.marginPx ?? 28)));
  const recursive = !!args.recursive;
  const dryRun = !!args.dryRun;

  if (!POSITION_MAP[position]) {
    return { ok: false, error: `position must be one of: ${Object.keys(POSITION_MAP).join(", ")}` };
  }

  const files = await collectMedia(folderAbs, recursive);
  if (!files.length) return { ok: false, error: `no images or videos in ${folderAbs}` };

  const runId = `wm_${path.basename(folderAbs)}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const runDir = path.join(Paths.getOutputSubdir("watermarked"), runId);
  if (!dryRun && !existsSync(runDir)) await mkdir(runDir, { recursive: true });

  const results = [];
  let imageOk = 0, imageFail = 0, videoOk = 0, videoFail = 0;

  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    const src = path.join(folderAbs, rel);
    const dest = path.join(runDir, rel.replace(/[\\/]/g, "_"));
    if (dryRun) {
      results.push({ file: rel, dryRun: true });
      continue;
    }
    if (IMAGE_EXTS.has(ext)) {
      const r = await watermarkImage({ src, dest, watermark: watermarkPath, opacity, scale, position, marginPx });
      if (r.ok) imageOk++; else imageFail++;
      results.push({ file: rel, kind: "image", ok: r.ok, output: r.ok ? path.relative(PROJECT_DIR, r.output) : null, error: r.error });
    } else if (VIDEO_EXTS.has(ext)) {
      const destMp4 = dest.replace(/\.(mov|m4v)$/i, ".mp4");
      const r = await watermarkVideo({ src, dest: destMp4, watermark: watermarkPath, opacity, scale, position, marginPx });
      if (r.ok) videoOk++; else videoFail++;
      results.push({ file: rel, kind: "video", ok: r.ok, output: r.ok ? path.relative(PROJECT_DIR, r.output) : null, error: r.error });
    }
  }

  /* Why: persist a manifest so a later "redo with higher opacity" can reuse the same
   * file list without re-scanning the source. Also useful for client provenance audits. */
  if (!dryRun) {
    await writeFile(path.join(runDir, "manifest.json"), JSON.stringify({
      runId, source: folderAbs, watermark: path.relative(PROJECT_DIR, watermarkPath),
      opacity, scale, position, marginPx, recursive,
      counts: { imageOk, imageFail, videoOk, videoFail }, results,
    }, null, 2));
  }

  return {
    ok: true,
    runId,
    runDir: dryRun ? null : path.relative(PROJECT_DIR, runDir),
    folder: path.relative(PROJECT_DIR, folderAbs),
    counts: { total: files.length, imageOk, imageFail, videoOk, videoFail },
    summary: dryRun
      ? `Dry run — would watermark ${files.length} files (${results.length})`
      : `Watermarked ${imageOk + videoOk} of ${files.length} files (${imageFail + videoFail} failures). Output → ${path.relative(PROJECT_DIR, runDir)}`,
    results: results.slice(0, 20),  // truncate for voice readout
  };
}

function clamp(n, lo, hi) { n = Number(n); if (Number.isNaN(n)) return lo; return Math.max(lo, Math.min(hi, n)); }
function clamp01(n) { return clamp(n, 0, 1); }
