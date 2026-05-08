/** video.mjs — ffmpeg-based intro/outro card builders + subject slug helper.
 *
 *  What used to live here: a fal.ai-driven montage demo (image gen + image-to-
 *  video). That pipeline has been removed — the kiosk is now fully local for
 *  inference. All that's kept is the brand-card rendering, which is pure
 *  ffmpeg over local PNG assets and is consumed by bridge/edit.mjs at the
 *  start + end of every teaser render.
 *
 *  Exported helpers:
 *    subjectSlug(subject)    — filesystem-safe slug for shoot folders
 *    buildIntroCard()        — 3s vertical brand intro mp4 (cached)
 *    buildOutroCard()        — 2s vertical brand outro mp4 (cached)
 *    stitchFinal()           — kept for reference (slow-cut concatenation)
 *    stitchFinalFastCut()    — kept for reference (paced fast-cut concatenation)
 */

import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as Paths from "./paths.mjs";

const execp = promisify(exec);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ASSET_DIR = path.join(PROJECT_DIR, "assets");
const SHOOT_DIR = path.join(ASSET_DIR, "demo-shoot");

/** Filesystem-safe slug for a subject so cache directories don't break on punctuation/spaces. */
export function subjectSlug(subject) {
  return (subject || "subject")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "subject";
}

async function ensureDirs() {
  if (!existsSync(SHOOT_DIR)) await mkdir(SHOOT_DIR, { recursive: true });
  /* Output dir auto-created by Paths.getOutputDir(); no need to mkdir here. */
  Paths.getOutputDir();
}

/** Build a 2-second brand outro card from the wordmark + dial overlay. Cached. */
export async function buildOutroCard({ force = false } = {}) {
  await ensureDirs();
  const outroPath = path.join(ASSET_DIR, "outro-2s.mp4");
  if (existsSync(outroPath) && !force) return outroPath;

  const wordmark = path.join(ASSET_DIR, "brand-wordmark.png");
  const dial = path.join(ASSET_DIR, "brand-dial.png");
  // Why: white-label distribution ships without bundled brand artwork.
  // If the operator hasn't dropped in their own assets, skip the card build
  // and let the consumer (edit.mjs) handle a null return — better than
  // erroring on every video-tool invocation. Operators provide their own
  // brand-wordmark.png / brand-dial.png to re-enable.
  if (!existsSync(wordmark) || !existsSync(dial)) {
    console.warn("[video] brand artwork missing — skipping intro/outro card build");
    return null;
  }

  const cmd = [
    "ffmpeg", "-y",
    "-f", "lavfi", "-t", "2", "-i", "color=c=black:s=1080x1920:r=30",
    "-loop", "1", "-t", "2", "-i", `"${wordmark}"`,
    "-loop", "1", "-t", "2", "-i", `"${dial}"`,
    "-f", "lavfi", "-t", "2", "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
    "-filter_complex",
    `"[1:v]scale=720:-1[wm];` +
    `[2:v]scale=420:-1,format=rgba,colorchannelmixer=aa=0.30[bd];` +
    `[0:v][bd]overlay=(W-w)/2:(H-h)/2-150:shortest=1[bg];` +
    `[bg][wm]overlay=(W-w)/2:(H-h)/2+50:shortest=1,` +
    `drawbox=x=0:y=h*0.78:w=iw:h=80:color=black@0.0:t=fill,` +
    `format=yuv420p[outv]"`,
    "-map", `"[outv]"`, "-map", "3:a",
    "-t", "2", "-r", "30",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    `"${outroPath}"`,
  ].join(" ");
  await execp(cmd);
  console.log(`[video] built outro card at ${outroPath}`);
  return outroPath;
}

/** Build a 3-second brand intro mp4 from the wordmark logo over black. Cached after first build.
 *  Returns null if brand artwork (assets/brand-wordmark.png + assets/brand-dial.png) is absent. */
export async function buildIntroCard({ force = false } = {}) {
  await ensureDirs();
  const introPath = path.join(ASSET_DIR, "intro-3s.mp4");
  if (existsSync(introPath) && !force) return introPath;

  const wordmark = path.join(ASSET_DIR, "brand-wordmark.png");
  const dial = path.join(ASSET_DIR, "brand-dial.png");
  // Why: white-label distribution ships without bundled brand artwork.
  // If the operator hasn't dropped in their own assets, skip the card build
  // and let the consumer (edit.mjs) handle a null return — better than
  // erroring on every video-tool invocation. Operators provide their own
  // brand-wordmark.png / brand-dial.png to re-enable.
  if (!existsSync(wordmark) || !existsSync(dial)) {
    console.warn("[video] brand artwork missing — skipping intro/outro card build");
    return null;
  }

  /* Intro is silent — but we still attach an AAC silent track so concat downstream sees
   * matching stream layout against video segments that carry source audio. */
  const cmd = [
    "ffmpeg", "-y",
    "-f", "lavfi", "-t", "3", "-i", "color=c=black:s=1080x1920:r=30",
    "-loop", "1", "-t", "3", "-i", `"${wordmark}"`,
    "-loop", "1", "-t", "3", "-i", `"${dial}"`,
    "-f", "lavfi", "-t", "3", "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
    "-filter_complex",
    `"[1:v]scale=900:-1[wm];` +
    `[2:v]scale=520:-1,format=rgba,colorchannelmixer=aa=0.30[bd];` +
    `[0:v][bd]overlay=(W-w)/2:(H-h)/2-80:shortest=1[bg];` +
    `[bg][wm]overlay=(W-w)/2:(H-h)/2+220:shortest=1,format=yuv420p[outv]"`,
    "-map", `"[outv]"`, "-map", "3:a",
    "-t", "3", "-r", "30",
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    `"${introPath}"`,
  ].join(" ");

  await execp(cmd);
  console.log(`[video] built intro card at ${introPath}`);
  return introPath;
}
