/** reports.mjs - Auto-collected client reports.
 *
 *  Tool: generate_shoot_report({ folder, client?, location?, weather?, crew?, notes? })
 *    Auto-pulls from the shoot folder so the operator doesn't dictate stats by voice:
 *      - file counts (images / videos)
 *      - total payload (GB)
 *      - shoot time-window (earliest → latest EXIF DateTimeOriginal, falls back to mtime)
 *      - estimated edit time (heuristic: files × per-deliverable factor)
 *      - hero shot picks via vision.findFrame
 *    Then calls the existing PDF template "shoot-report" with the collected data.
 *
 *  Voice flow: "draft a shoot report for the press car" → 30-60s later a finished PDF opens.
 */

import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createPdf } from "./pdf.mjs";
import * as Vision from "./vision.mjs";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

/* SHOOTS_DIR resolved at call sites via Paths.getShootsDir(). */

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff", ".dng", ".arw", ".cr2", ".cr3", ".nef", ".raf"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".braw", ".r3d"]);

/* Why: editing-time heuristic derived from FOM's typical workflow:
 *   - per stills hero pick + light grade ≈ 4 minutes
 *   - per video clip cut + grade ≈ 10 minutes
 *   - plus a fixed teaser-build budget if any video is present
 * These are operator-tunable via env vars when a client wants different defaults. */
const MIN_PER_IMAGE = Number(process.env.EDIT_MIN_PER_IMAGE || 4);
const MIN_PER_VIDEO = Number(process.env.EDIT_MIN_PER_VIDEO || 10);
const MIN_TEASER_BUDGET = Number(process.env.EDIT_MIN_TEASER || 90);

/** Resolve a user-supplied folder name to an absolute path under shoots/. */
function resolveShoot(folder) {
  if (!folder) return null;
  const abs = path.isAbsolute(folder) ? folder : path.join(Paths.getShootsDir(), folder);
  return existsSync(abs) ? abs : null;
}

/** Subject hint extracted from a folder name like "2026-05-01-press-car" → "the press car". */
function subjectFromFolder(name) {
  const cleaned = (name || "")
    .replace(/^\d{4}-\d{2}-\d{2}[-_]/, "")
    .replace(/^\d{8}[-_]/, "")
    .replace(/[-_]/g, " ")
    .trim();
  return cleaned ? cleaned.replace(/\b\w/g, c => c.toUpperCase()) : null;
}

/** Date extracted from a folder name's leading ISO prefix, fallback to today. */
function dateFromFolder(name) {
  const m = (name || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date().toLocaleDateString("en-GB");
  return new Date(`${m[1]}-${m[2]}-${m[3]}`).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" });
}

/* Why: exiftool gives us authoritative DateTimeOriginal across stills + clips and is
 * already in the shell allowlist. Falls back gracefully if the binary isn't present. */
async function exifTimeRange(folder, files) {
  const sample = files.slice(0, 200);  // cap so a 5000-file shoot doesn't time out
  const fullPaths = sample.map(f => path.join(folder, f));
  let earliest = null, latest = null;
  try {
    const { stdout } = await execFileP("exiftool",
      ["-s3", "-DateTimeOriginal", "-CreateDate", "-FileModifyDate", ...fullPaths],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    /* Output is one line per requested tag per file in order. We just want the first
     * parseable date per file — exiftool emits in sequence. */
    for (const line of stdout.split("\n")) {
      const t = parseExifDate(line);
      if (!t) continue;
      if (!earliest || t < earliest) earliest = t;
      if (!latest || t > latest) latest = t;
    }
  } catch {
    /* Fallback: use file mtimes — less accurate (camera ingest may have a single mtime
     * for the whole batch) but better than nothing. */
    for (const p of fullPaths) {
      try {
        const st = await stat(p);
        const t = st.mtime;
        if (!earliest || t < earliest) earliest = t;
        if (!latest || t > latest) latest = t;
      } catch {}
    }
  }
  if (!earliest || !latest) return null;
  const durationMs = latest - earliest;
  return { earliest, latest, durationMs, hours: +(durationMs / 3_600_000).toFixed(1) };
}

function parseExifDate(line) {
  const trimmed = (line || "").trim();
  if (!trimmed) return null;
  /* exiftool default format: "2026:05:01 14:30:21" — convert colons in the date part to dashes
   * so JS Date parses it. Also handles ISO-ish lines from FileModifyDate. */
  const m = trimmed.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}`);
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

/** Estimate edit time in minutes — returned both as raw + human string. */
function estimateEditMinutes({ images, videos }) {
  const stills = images * MIN_PER_IMAGE;
  const clips = videos * MIN_PER_VIDEO;
  const teaser = videos > 0 ? MIN_TEASER_BUDGET : 0;
  const total = stills + clips + teaser;
  return {
    minutes: total,
    breakdown: { stillsMin: stills, clipsMin: clips, teaserMin: teaser },
    human: humanMinutes(total),
  };
}

function humanMinutes(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} min`;
}

function bytesToReadable(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Auto-generate a shoot report PDF. Operator can override any auto-collected field
 * by passing it in args (e.g. they know the weather better than we can guess).
 *
 * @param {object} args
 * @param {string} args.folder    Shoot folder name or absolute path.
 * @param {string} [args.client]  Defaults to auto-pulled from folder name.
 * @param {string} [args.subject] Defaults to auto-pulled from folder name.
 * @param {string} [args.location]
 * @param {string} [args.weather]
 * @param {string} [args.crew]
 * @param {string} [args.notes]   Extra context, appended to summary.
 * @param {number} [args.heroCount=4]  How many hero shots to feature.
 * @returns {Promise<object>}     { ok, pdfUrl, stats, captions, ... }
 */
export async function generateShootReport(args) {
  const folder = args && args.folder;
  if (!folder) return { ok: false, error: "folder required" };
  const abs = resolveShoot(folder);
  if (!abs) return { ok: false, error: `shoot folder not found: ${folder} (looked under shoots/)` };

  const folderName = path.basename(abs);
  const subject = args.subject || subjectFromFolder(folderName) || folderName;
  const date = dateFromFolder(folderName);

  /* ---------- file inventory ---------- */
  const all = await readdir(abs).catch(() => []);
  const images = all.filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  const videos = all.filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()));
  let totalBytes = 0;
  for (const f of [...images, ...videos]) {
    try { totalBytes += (await stat(path.join(abs, f))).size; } catch {}
  }

  /* ---------- shoot duration ---------- */
  const time = await exifTimeRange(abs, [...images, ...videos]);

  /* ---------- edit-time estimate ---------- */
  const edit = estimateEditMinutes({ images: images.length, videos: videos.length });

  /* ---------- hero picks ---------- */
  /* Make sure the folder has captions cached — find_frame relies on them. */
  await Vision.captionShootFolder({ folder: folderName, sampleCount: 12 }).catch(() => {});
  const heroQuery = "strongest hero shot — clean composition, dramatic angle, dynamic light, dominant subject";
  const heroResult = await Vision.findFrame({
    query: heroQuery,
    folder: folderName,
    limit: args.heroCount || 4,
  });
  const heroes = (heroResult.ok ? heroResult.results : []).map(r => ({
    file: path.basename(r.path),
    caption: r.caption,
  }));

  /* ---------- assemble PDF data ---------- */
  const summaryLines = [
    `Captured ${images.length} stills and ${videos.length} clips totalling ${bytesToReadable(totalBytes)}.`,
    time ? `Working window approximately ${time.hours}h (${time.earliest.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} – ${time.latest.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}).` : null,
    `Estimated edit time: ${edit.human} (${edit.minutes} min total — ${edit.breakdown.stillsMin} stills + ${edit.breakdown.clipsMin} clips${edit.breakdown.teaserMin ? ` + ${edit.breakdown.teaserMin} teaser` : ""}).`,
  ].filter(Boolean).join(" ");

  const fullSummary = args.notes ? `${summaryLines}\n\n${args.notes}` : summaryLines;

  const data = {
    title: `${subject} — Shoot Report`,
    client: args.client || subject.split(" ")[0] || "Client",
    subject,
    date,
    location: args.location || "—",
    weather: args.weather || "—",
    crew: args.crew || "—",
    fileCount: `${images.length + videos.length} (${images.length} stills, ${videos.length} clips)`,
    summary: fullSummary,
    highlights: heroes.length
      ? heroes.map(h => `${h.file}: ${h.caption}`)
      : null,
    nextSteps: videos.length
      ? `Recommend cutting a ${edit.breakdown.teaserMin / 60 < 1 ? edit.breakdown.teaserMin + " min" : (edit.breakdown.teaserMin / 60).toFixed(1) + "h"} teaser using the auto-picked hero clips. Run video_edit_from_shoot to start.`
      : null,
  };

  const pdf = await createPdf({ template: "shoot-report", data });

  return {
    ok: true,
    pdf,                         // { url, path, size, template }
    stats: {
      images: images.length,
      videos: videos.length,
      totalBytes,
      totalSize: bytesToReadable(totalBytes),
      durationHours: time?.hours || null,
      estimatedEditMin: edit.minutes,
      estimatedEditHuman: edit.human,
    },
    heroes,
  };
}
