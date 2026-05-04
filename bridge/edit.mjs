/** edit.mjs - Production edit pipeline for Flat-Out HUD.
 *
 *  This is the *real* mode for FOM: scan a shoot folder for videos + images they actually
 *  filmed, plan a cut-down + image insert sequence, render with CapCut-style text overlays
 *  using ffmpeg + drawtext + the FOM intro card. Zero Fal cost, all local.
 *
 *  Voice: "Flat-Out, edit a 30 second teaser from yesterday's Audi RS6 shoot"
 */

import { readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { buildIntroCard, buildOutroCard } from "./video.mjs";
import { pickTrack, beatPattern, listTracks } from "./music.mjs";
import * as Paths from "./paths.mjs";

const execp = promisify(exec);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ASSET_DIR = path.join(PROJECT_DIR, "assets");
/* Shoots/output roots are operator-configurable; resolve at each call site via Paths.* so
 * a path change at runtime (settings → folders) takes effect without a bridge restart. */
const FONT_PATH = path.join(ASSET_DIR, "fonts", "Oswald.ttf");

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"]);

/** Recursively walk a folder and bucket contents into videos vs images with metadata. */
export async function scanShoot(folder) {
  const videos = [];
  const images = [];

  async function walk(dir) {
    const ents = await readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      const ext = path.extname(e.name).toLowerCase();
      if (VIDEO_EXTS.has(ext)) {
        try {
          const { stdout } = await execp(`ffprobe -v error -show_entries format=duration:stream=width,height -of json "${full}"`);
          const j = JSON.parse(stdout);
          const dur = parseFloat(j.format?.duration || "0");
          const v = j.streams?.find(s => s.width);
          videos.push({ path: full, name: e.name, duration: dur, width: v?.width || 0, height: v?.height || 0 });
        } catch { /* skip unreadable */ }
      } else if (IMAGE_EXTS.has(ext)) {
        const s = await stat(full).catch(() => null);
        if (s) images.push({ path: full, name: e.name, size: s.size });
      }
    }
  }
  await walk(folder);
  // sort for stable output
  videos.sort((a, b) => a.name.localeCompare(b.name));
  images.sort((a, b) => a.name.localeCompare(b.name));
  return { folder, videos, images };
}

/** Plan a 30-second edit: pick varied cuts from each video + intersperse a few image cards.
 *  Deterministic so the same folder produces the same edit (for repeat demos / CI). */
/* Why: aspect is a {w,h} object so callers can pick 9:16 (1080x1920 — Reels/TikTok),
 * 16:9 (1920x1080 — YouTube), 1:1 (1080x1080 — Instagram square), or anything else without
 * hand-editing every crop in the renderer. Existing teaser callers default to vertical
 * because that's what the production pipeline was built for. */
export function planEdit({ videos, images }, subject = "Audi RS6", targetSec = 30, customText = null, musicTrack = null, aspect = { w: 1080, h: 1920 }) {
  if (videos.length === 0 && images.length === 0) throw new Error("shoot folder has no usable assets");

  /* Why: Top Gear-ish pacing — open with longer holds, accelerate, end with a hero hold.
   * Mix in image cards every ~5-7s for "BTS still" beats. */
  const segments = [];

  // Pacing pattern (sums to ~30s after scaling)
  /* When a music track is provided, use beat-aligned segment durations so every cut lands on the pulse.
   * Otherwise fall back to the artistic Top Gear / Gran Turismo pattern. */
  let lengths;
  if (musicTrack && musicTrack.bpm) {
    lengths = beatPattern(musicTrack.bpm, targetSec);
  } else {
    const cutLengths = [
      1.0, 0.8,            // open
      0.6, 0.5, 0.4, 0.5,  // building
      0.35, 0.3, 0.35,     // rapid
      0.5, 0.6, 0.5,       // breath
      0.4, 0.35, 0.45,     // build again
      0.6, 0.7, 0.5,       // mid
      0.4, 0.35, 0.4, 0.45,
      0.8, 1.0,             // wind down
      1.4,                  // hero
    ];
    const sum = cutLengths.reduce((a, b) => a + b, 0);
    const scale = targetSec / sum;
    lengths = cutLengths.map(l => +(l * scale).toFixed(3));
  }

  /* Pick which source per segment. Three modes:
   *   1) videos+images: mostly video cuts, image inserts every ~5
   *   2) videos only:  pure video cuts cycling through clips
   *   3) images only:  every cut is a Ken Burns pan, varying direction + zoom for visual interest */
  let videoIdx = 0;
  let imageIdx = 0;
  let lastSource = null;
  const imagesOnly = videos.length === 0 && images.length > 0;

  /* Why: 4 deterministic motion variants — alternating gives directional variety without randomness. */
  const PAN_VARIANTS = [
    { dx: -1, dy:  1, zoom: 0 },   // pan up-right + slight zoom-in
    { dx:  1, dy:  1, zoom: 1 },   // pan up-left + zoom-in
    { dx:  0, dy:  1, zoom: 0 },   // pan up (subtle)
    { dx: -1, dy: -1, zoom: 1 },   // pan down-right + zoom-in
  ];

  /* CapCut-tier effect palette per segment. Weighted random — most cuts are clean (so the rare effects pop),
   * with sparkle from speed ramps + punch zooms + flash cuts. Deterministic per-run via seeded index. */
  const EFFECTS_PALETTE = [
    "normal", "normal", "normal", "normal", "normal", "normal", "normal",  // 7/14 plain cuts
    "punch-zoom",                                                            // 1/14
    "speed-up", "speed-up",                                                  // 2/14 (1.4x)
    "slow-mo",                                                               // 1/14 (0.6x)
    "flash-in", "flash-in",                                                  // 2/14 (~2-frame white flash before)
    "freeze-hit",                                                            // 1/14 (brief 100ms freeze at start)
  ];
  // Force key spots: hero-zoom on a specific cut, slow-mo on the final hero hold
  const FORCED_EFFECTS = { 4: "punch-zoom", 9: "flash-in", 13: "speed-up", 24: "slow-mo" };

  lengths.forEach((dur, i) => {
    // Pick effect: forced first, else weighted-random by index for repeatability
    const effect = FORCED_EFFECTS[i] || EFFECTS_PALETTE[(i * 7 + 3) % EFFECTS_PALETTE.length];

    if (imagesOnly) {
      const img = images[imageIdx % images.length]; imageIdx++;
      const motion = PAN_VARIANTS[i % PAN_VARIANTS.length];
      segments.push({ kind: "image", path: img.path, name: img.name, dur, motion, effect });
      lastSource = "img:" + img.name;
      return;
    }

    const useImage = images.length > 0 && (i === 4 || i === 11 || i === 18);
    if (useImage) {
      const img = images[imageIdx % images.length]; imageIdx++;
      const motion = PAN_VARIANTS[i % PAN_VARIANTS.length];
      segments.push({ kind: "image", path: img.path, name: img.name, dur, motion, effect });
      lastSource = "img:" + img.name;
    } else if (videos.length > 0) {
      let v = videos[videoIdx % videos.length];
      if (lastSource === "vid:" + v.name && videos.length > 1) {
        videoIdx++;
        v = videos[videoIdx % videos.length];
      }
      videoIdx++;
      const safeStart = Math.max(0, v.duration - dur - 0.05);
      const phase = (i * 0.31) % 1;
      const start = +(phase * safeStart).toFixed(3);
      segments.push({ kind: "video", path: v.path, name: v.name, start, dur, effect });
      lastSource = "vid:" + v.name;
    }
  });

  /* CapCut-style text reveals. Single uppercase phrases with brand-red bursts.
   * Times sync to clip change boundaries so they feel "punched in". */
  const cumulative = [0];
  for (const s of segments) cumulative.push(cumulative[cumulative.length - 1] + s.dur);

  const SUBJECT_UPPER = subject.toUpperCase();
  const tokens = SUBJECT_UPPER.split(/\s+/).filter(Boolean);

  /* Why: cues are derived from the actual subject + the FOM brand wordmark only.
   * Earlier we hardcoded "MANCHESTER" / "DAWN" from the AI image prompt, which is wrong
   * once we move to real footage shot anywhere. Subject tokens give a clean editorial set. */
  const textCues = [];
  const beat = (segIdx) => cumulative[Math.min(segIdx, cumulative.length - 1)];

  /* First-half hero slides — one subject token per slide, alternating between text-on-video
   * and full-screen panel cards for max visual punch. Always one word per slide so nothing wraps. */
  const HERO_VARIANTS = ["hero-1", "panel-red", "hero-3"];   // word 1: anchored white left, word 2: red panel flash, word 3: anchored white right
  const slotStarts = [2, 5, 8];
  const slotEnds   = [4, 7, 10];
  const heroTokens = tokens.slice(0, 3);
  heroTokens.forEach((tok, i) => {
    textCues.push({ start: beat(slotStarts[i]), end: beat(slotEnds[i]), text: tok, style: HERO_VARIANTS[i] });
  });

  /* Mid-section: FLAT / OUT / MEDIA stacked. Pulled earlier when customText is present so we have room. */
  const stackEndIdx = customText ? 17 : 19;
  textCues.push({ start: beat(15), end: beat(stackEndIdx), text: "FLAT",  style: "stack-1" });
  textCues.push({ start: beat(15), end: beat(stackEndIdx), text: "OUT",   style: "stack-2" });
  textCues.push({ start: beat(15), end: beat(stackEndIdx), text: "MEDIA", style: "stack-3" });

  /* Optional tail card — split into single words, stacked vertically, never overflow.
   * "FULL VIDEO COMING SOON" → 4 stacked cues, each one word, sized to fit 9:16 frame. */
  if (customText) {
    const words = String(customText).toUpperCase().trim().split(/\s+/).filter(Boolean).slice(0, 4);
    const tailStart = beat(stackEndIdx + 1);
    const tailEnd = beat(segments.length - 2);
    words.forEach((word, i) => {
      textCues.push({
        start: tailStart, end: tailEnd, text: word,
        style: `tail-${i + 1}of${words.length}`,
      });
    });
  }

  // Closing handle anchored bottom-left
  textCues.push({ start: beat(segments.length - 2), end: cumulative[segments.length] - 0.05, text: "@FLATOUTMEDIAUK", style: "handle" });

  return { segments, textCues, totalSec: cumulative[segments.length], subject, aspect };
}

/* ---------- IMAGE → MP4 (Ken Burns pan + zoom + silent matching audio track) ----------
 * Why: image segments need a silent audio stream so concat with video segments (which carry real
 * audio) doesn't fail on stream-count mismatch. AAC 48kHz stereo matches what we re-encode video to. */
async function imageToMp4(imgPath, durSec, outPath, motion = { dx: 0, dy: 1, zoom: 0 }, aspect = { w: 1080, h: 1920 }) {
  /* Why: Ken Burns needs the source-scaled canvas to be larger than the crop window so
   * pan + zoom have headroom. We oversize by 2.5× (no zoom) or 2.78× (with zoom) which
   * is the same headroom the original 1080x1920 settings used. */
  const W = aspect.w, H = aspect.h;
  const SCALE_W = Math.round(W * (motion.zoom ? 2.5 : 2.22));
  const SCALE_H = Math.round(H * (motion.zoom ? 2.5 : 2.22));
  const PAN = Math.round(Math.min(W, H) * 0.063);   // ~120px on 1080-side
  const xExpr = `(iw-${W})/2 + ${motion.dx * PAN}*(t/${durSec.toFixed(3)})`;
  const yExpr = `(ih-${H})/2 + ${motion.dy * PAN}*(t/${durSec.toFixed(3)})`;
  const cmd = [
    "ffmpeg", "-y",
    "-framerate", "30", "-loop", "1", "-t", String(durSec),
    "-i", `"${imgPath}"`,
    "-f", "lavfi", "-t", String(durSec),
    "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
    "-vf",
    `"scale=${SCALE_W}:${SCALE_H}:force_original_aspect_ratio=increase,crop=${W}:${H}:'${xExpr}':'${yExpr}',setsar=1,format=yuv420p"`,
    "-t", String(durSec),
    "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    `"${outPath}"`,
  ].join(" ");
  await execp(cmd);
  return outPath;
}

/* ---------- TEXT OVERLAY VIA IMAGEMAGICK + ffmpeg overlay ----------
 * Why: homebrew ffmpeg ships without freetype/libass — drawtext and subtitles filters are absent.
 * ImageMagick *is* installed; we render each text cue as a transparent PNG and use ffmpeg's
 * core `overlay` filter (always available) with `enable=between(t,...)`. Fade in/out via
 * `colorchannelmixer=aa=` time expression. End result is identical to drawtext quality-wise. */

/* Why: Anton-Regular is the editorial/poster heavy condensed font (Top Gear / car-mag titling).
 * Drop shadow with blur gives genuine depth; stroke at thin weights produced hollow letters.
 * xAlign + yPct deliberately VARY per cue so titles don't feel pasted dead-centre. */
const ANTON = path.join(ASSET_DIR, "fonts", "Anton-Regular.ttf");
const OSWALD_BOLD = path.join(ASSET_DIR, "fonts", "Oswald-Bold.ttf");

/* Each style can be either:
 *   - text-on-transparent (default): rendered as a transparent PNG, overlays the video
 *   - panel: panelBg fills 1080×1920 — covers the video entirely with a solid background card
 * Style variants give CapCut-tier punch (white-flash card, red panel, black-with-red-stroke etc). */
const TEXT_STYLES = {
  /* Text-on-video styles (transparent) — 3 anchored hero positions */
  "hero-1":           { size: 340, fill: "white",   font: ANTON,       xAlign: "left",   xPct: 0.06, yPct: 0.66 },
  "hero-2":           { size: 340, fill: "#E10600", font: ANTON,       xAlign: "center", xPct: 0.50, yPct: 0.30 },
  "hero-3":           { size: 340, fill: "white",   font: ANTON,       xAlign: "right",  xPct: 0.94, yPct: 0.50 },

  /* Bold variants */
  "hero-stroke":      { size: 340, fill: "#0A0A0A", stroke: "#E10600", strokeW: 12, font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.55 },
  "hero-hollow":      { size: 340, fill: "transparent", stroke: "white", strokeW: 8, font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.55 },

  /* Panel cards — replace the video for a moment with a solid coloured background */
  "panel-red":        { size: 280, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.50, panelBg: "#E10600", fullScreen: true },
  "panel-white":      { size: 280, fill: "#0A0A0A",  font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.50, panelBg: "#FFFFFF", fullScreen: true },
  "panel-black":      { size: 280, fill: "#E10600",  font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.50, panelBg: "#000000", fullScreen: true },

  /* 3-line stacked wordmark — FLAT / OUT / MEDIA */
  "stack-1":          { size: 320, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.30 },
  "stack-2":          { size: 320, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.50 },
  "stack-3":          { size: 320, fill: "#E10600",  font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.70 },

  /* Vertically-stacked single-word slots for customText — 1, 2, 3, or 4 words */
  "tail-1of1":        { size: 280, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.50 },
  "tail-1of2":        { size: 240, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.40 },
  "tail-2of2":        { size: 240, fill: "#E10600",  font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.60 },
  "tail-1of3":        { size: 200, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.32 },
  "tail-2of3":        { size: 200, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.50 },
  "tail-3of3":        { size: 200, fill: "#E10600",  font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.68 },
  "tail-1of4":        { size: 170, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.28 },
  "tail-2of4":        { size: 170, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.43 },
  "tail-3of4":        { size: 170, fill: "white",    font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.58 },
  "tail-4of4":        { size: 170, fill: "#E10600",  font: ANTON, xAlign: "center", xPct: 0.50, yPct: 0.73 },

  handle:             { size: 100, fill: "#E10600",  font: OSWALD_BOLD, xAlign: "left", xPct: 0.06, yPct: 0.88 },
};

/** Render a single text cue as a PNG. Three modes:
 *   1. Full-screen panel (panelBg set): solid 1080×1920 colour background with text on top
 *   2. Stroke variant (stroke set): hollow / outlined letters
 *   3. Default: text on transparent + drop shadow */
async function renderTextPng(text, style, outPath, aspect = { w: 1080, h: 1920 }) {
  const st = TEXT_STYLES[style] || TEXT_STYLES["hero-1"];
  const safeText = text.replaceAll("'", "\\'");
  const { w: W, h: H } = aspect;

  let cmd;
  if (st.fullScreen && st.panelBg) {
    cmd = [
      "magick",
      "-size", `${W}x${H}`,
      "-background", `'${st.panelBg}'`,
      "-fill", `'${st.fill}'`,
      "-font", `"${st.font}"`,
      "-pointsize", String(st.size),
      "-gravity", "center",
      `caption:'${safeText}'`,
      `"${outPath}"`,
    ].join(" ");
  } else if (st.stroke) {
    cmd = [
      "magick",
      "-background", "none",
      "-font", `"${st.font}"`,
      "-pointsize", String(st.size),
      "-fill", st.fill === "transparent" ? "none" : `'${st.fill}'`,
      "-stroke", `'${st.stroke}'`,
      "-strokewidth", String(st.strokeW || 8),
      `label:'${safeText}'`,
      "-bordercolor", "none", "-border", "30",
      `"${outPath}"`,
    ].join(" ");
  } else {
    cmd = [
      "magick",
      "-background", "none",
      "-font", `"${st.font}"`,
      "-pointsize", String(st.size),
      "-fill", `'${st.fill}'`,
      `label:'${safeText}'`,
      "\\(", "+clone", "-background", "black", "-shadow", "100x18+0+10", "\\)",
      "+swap", "-background", "none", "-layers", "merge", "+repage",
      "-bordercolor", "none", "-border", "30",
      `"${outPath}"`,
    ].join(" ");
  }
  await execp(cmd);
  return { png: outPath, xAlign: st.xAlign, xPct: st.xPct, yPct: st.yPct, style, fullScreen: !!st.fullScreen };
}

/** Build the ffmpeg filter graph that overlays N pre-rendered PNGs over a base video.
 *  Each PNG is fed as `-loop 1 -t TOTAL_DURATION` so its local timeline matches global 1:1.
 *  Animation is "PowerPoint Morph": fade in/out + slide the y position 80px upward across the cue
 *  (text rises into place as it appears, continues rising as it fades out). x stays anchored
 *  (left/center/right of frame) per the cue's xAlign/xPct so the layout doesn't feel pasted dead-centre. */
function buildOverlayChain(textCues, pngs) {
  const FADE = 0.25;     // fade-in / fade-out duration
  const SLIDE = 80;      // pixels of vertical travel — enough for "morph" feel without being distracting

  const filters = [];
  let last = "[0:v]";

  textCues.forEach((cue, i) => {
    const inputIdx = i + 1;
    const t0 = cue.start;
    const t1 = cue.end;
    const fadeOutStart = Math.max(0, t1 - FADE);

    /* Alpha animation via fade filter against the PNG's own stream timeline (which we aligned to global). */
    filters.push(`[${inputIdx}:v]format=rgba,fade=in:st=${t0.toFixed(3)}:d=${FADE}:alpha=1,fade=out:st=${fadeOutStart.toFixed(3)}:d=${FADE}:alpha=1[txt${i}]`);

    /* x position: anchored to a percentage of frame width based on xAlign:
     *   left   → x = W * xPct           (text starts at xPct from left edge)
     *   center → x = (W-w)/2            (centred)
     *   right  → x = W * xPct - w       (text right-edge at xPct from left)        */
    const { xAlign, xPct, yPct } = pngs[i];
    let xExpr;
    if (xAlign === "right")       xExpr = `(W*${xPct})-w`;
    else if (xAlign === "center") xExpr = `(W-w)/2`;
    else                           xExpr = `W*${xPct}`;

    /* y morph: the final resting Y, plus an offset that goes from +SLIDE during fade-in,
     * through 0 during hold, to -SLIDE during fade-out. Result: rises into place, then continues rising. */
    const finalY = `(H*${yPct})-h/2`;
    const yExpr =
      `if(lt(t,${(t0 + FADE).toFixed(3)}),` +
        `(${finalY})+${SLIDE}*(1-(t-${t0.toFixed(3)})/${FADE}),` +
        `if(lt(t,${(t1 - FADE).toFixed(3)}),` +
          `(${finalY}),` +
          `(${finalY})-${SLIDE}*(t-${(t1 - FADE).toFixed(3)})/${FADE}` +
        `)` +
      `)`;

    const out = i === textCues.length - 1 ? "[outv]" : `[v${i}]`;
    filters.push(`${last}[txt${i}]overlay=x='${xExpr}':y='${yExpr}':format=auto${out}`);
    last = `[v${i}]`;
  });
  return filters.join(";");
}

/* ---------- RENDER ---------- */

/** Render the planned edit. Approach: convert every segment to a normalised target-aspect
 *  30fps mp4 in a temp dir, then concat them via the demuxer (fast, no re-encode), then burn
 *  drawtext over the whole thing in a final pass. Aspect is read from plan.aspect (set by
 *  planEdit) so the same renderer handles 9:16, 16:9, or anything else uniformly. */
export async function renderEdit(plan, runDir, musicTrack = null) {
  if (!existsSync(runDir)) await mkdir(runDir, { recursive: true });
  const segDir = path.join(runDir, "segs");
  if (!existsSync(segDir)) await mkdir(segDir, { recursive: true });

  /* Aspect from plan, defaulting to vertical for back-compat with older plans that
   * didn't carry the field. Width × Height in pixels. */
  const A = plan.aspect || { w: 1080, h: 1920 };
  const W = A.w, H = A.h;
  console.log(`[edit] target aspect ${W}x${H}`);

  // Step 1: build per-segment mp4s
  console.log(`[edit] rendering ${plan.segments.length} segments…`);
  const segPaths = [];
  for (let i = 0; i < plan.segments.length; i++) {
    const s = plan.segments[i];
    const out = path.join(segDir, `${String(i).padStart(3, "0")}.mp4`);
    if (s.kind === "image") {
      await imageToMp4(s.path, s.dur, out, s.motion, A);
    } else {
      /* Probe to know whether source has audio. If yes, preserve it. If no, attach silent track. */
      let hasAudio = false;
      try {
        const { stdout } = await execp(`ffprobe -v error -select_streams a:0 -show_entries stream=index -of default=noprint_wrappers=1:nokey=1 "${s.path}"`);
        hasAudio = stdout.trim().length > 0;
      } catch { hasAudio = false; }

      /* CapCut-tier per-segment effects:
       *   speed-up:    1.4× speed (compresses 1s of source → 0.71s)
       *   slow-mo:     0.6× speed (stretches dramatically)
       *   punch-zoom:  scales 1.0 → 1.12 over the segment (subtle aggressive push-in)
       *   freeze-hit:  freezes the first 100ms before motion resumes (impactful entry)
       *   normal:      no extra processing
       * We adjust source duration when timing-mode effects are used so the OUTPUT segment is still s.dur long. */
      const eff = s.effect || "normal";
      let sourceDur = s.dur;
      let speedFactor = 1.0;
      let videoFilter = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30`;

      if (eff === "speed-up") {
        speedFactor = 1.4;
        sourceDur = (s.dur * speedFactor).toFixed(3);   // grab more source so output stays s.dur after speedup
        videoFilter += `,setpts=${(1 / speedFactor).toFixed(4)}*PTS`;
      } else if (eff === "slow-mo") {
        speedFactor = 0.6;
        sourceDur = (s.dur * speedFactor).toFixed(3);
        videoFilter += `,setpts=${(1 / speedFactor).toFixed(4)}*PTS`;
      } else if (eff === "punch-zoom") {
        // Scale eval frame-by-frame: starts 1.0, ends 1.12 — feels like a slow shove
        videoFilter += `,scale=eval=frame:w='${W}*(1+0.12*(t/${s.dur.toFixed(3)}))':h='${H}*(1+0.12*(t/${s.dur.toFixed(3)}))',crop=${W}:${H}`;
      } else if (eff === "freeze-hit") {
        // Hold first frame for 100ms, then resume normal speed — punchy "stop-start" feel
        videoFilter += `,tpad=start_duration=0.1:start_mode=clone`;
        sourceDur = (s.dur - 0.1).toFixed(3);
      }

      const audioFilter = (eff === "speed-up" || eff === "slow-mo")
        ? `[1:a]atempo=${Math.min(2, Math.max(0.5, speedFactor)).toFixed(3)}[a]`
        : `[1:a]anull[a]`;

      const baseArgs = ["ffmpeg", "-y", "-ss", String(s.start), "-t", String(sourceDur), "-i", `"${s.path}"`];
      const audioInputArgs = hasAudio
        ? []
        : ["-f", "lavfi", "-t", String(sourceDur), "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`];
      // When source has audio, tap [0:a]; else use the lavfi silence
      const audioStream = hasAudio ? "[0:a]" : "[1:a]";
      const audioFilterFinal = audioFilter.replace("[1:a]", audioStream);

      const cmd = [
        ...baseArgs, ...audioInputArgs,
        "-filter_complex",
        `"[0:v]${videoFilter}[v];${audioFilterFinal}"`,
        "-map", `"[v]"`, "-map", `"[a]"`,
        "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
        "-t", String(s.dur),    // hard-cap output to the planned segment duration
        `"${out}"`,
      ].join(" ");
      await execp(cmd);

      // For "flash-in" effect: prepend a 2-frame white flash to the segment
      if (eff === "flash-in") {
        const flashed = path.join(segDir, `${String(i).padStart(3, "0")}-fl.mp4`);
        const flashCmd = [
          "ffmpeg", "-y",
          "-f", "lavfi", "-t", "0.07", "-i", `color=c=white:s=${W}x${H}:r=30`,
          "-f", "lavfi", "-t", "0.07", "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
          "-i", `"${out}"`,
          "-filter_complex",
          `"[0:v]format=yuv420p,setsar=1,fps=30[fv];[fv][1:a][2:v][2:a]concat=n=2:v=1:a=1[v][a]"`,
          "-map", `"[v]"`, "-map", `"[a]"`,
          "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
          `"${flashed}"`,
        ].join(" ");
        await execp(flashCmd);
        // Replace the original with the flashed version
        await execp(`mv "${flashed}" "${out}"`);
      }
    }
    segPaths.push(out);
  }

  // Step 2: bookend with FOM intro AND outro cards, normalised to match segment streams.
  const introPath = path.join(ASSET_DIR, "intro-3s.mp4");
  const outroPath = path.join(ASSET_DIR, "outro-2s.mp4");

  async function normaliseCard(srcPath, durSec, outName) {
    const norm = path.join(segDir, outName);
    const cmd = [
      "ffmpeg", "-y", "-i", `"${srcPath}"`,
      "-f", "lavfi", "-t", String(durSec), "-i", `anullsrc=channel_layout=stereo:sample_rate=48000`,
      "-filter_complex", `"[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30[v]"`,
      "-map", `"[v]"`, "-map", "1:a",
      "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-shortest",
      `"${norm}"`,
    ].join(" ");
    await execp(cmd);
    return norm;
  }

  if (existsSync(introPath)) {
    const introNorm = await normaliseCard(introPath, 3, "_intro.mp4");
    segPaths.unshift(introNorm);
  }
  if (existsSync(outroPath)) {
    const outroNorm = await normaliseCard(outroPath, 2, "_outro.mp4");
    segPaths.push(outroNorm);
  }

  // Step 3: concat via demuxer
  const listFile = path.join(segDir, "list.txt");
  await execp(`bash -c 'printf "%s\\n" ${segPaths.map(p => `"file '"'"'${p}'"'"'"`).join(" ")} > "${listFile}"'`);
  const concatPath = path.join(runDir, "_concat.mp4");
  await execp(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${concatPath}"`);

  // Step 4: render each text cue as a transparent PNG (ImageMagick + Oswald), then composite
  // via ffmpeg's overlay filter. Shift cue times to account for the 3s intro.
  const introOffset = existsSync(introPath) ? 3.0 : 0.0;
  const shiftedCues = plan.textCues
    .filter(c => c.text && c.end > c.start + 0.3)
    .map(c => ({ ...c, start: c.start + introOffset, end: c.end + introOffset }));

  const pngsDir = path.join(runDir, "txt");
  if (!existsSync(pngsDir)) await mkdir(pngsDir, { recursive: true });
  console.log(`[edit] rendering ${shiftedCues.length} text PNGs via ImageMagick…`);
  const pngs = await Promise.all(shiftedCues.map(async (cue, i) => {
    const png = path.join(pngsDir, `cue-${String(i).padStart(2, "0")}.png`);
    return await renderTextPng(cue.text, cue.style, png, A);
  }));

  const finalPath = path.join(runDir, "final.mp4");
  if (shiftedCues.length === 0) {
    /* No text cues — just copy the concatted base which already has audio */
    await execp(`ffmpeg -y -i "${concatPath}" -c copy "${finalPath}"`);
  } else {
    /* Probe the concatenated base so each PNG input matches its duration exactly.
     * Why: with PNG -t = base duration, fade times can use global timestamps directly. */
    const { stdout } = await execp(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${concatPath}"`);
    const baseDur = parseFloat(stdout.trim()) || 33.6;
    const pngDur = (baseDur + 0.1).toFixed(3);
    const pngInputArgs = pngs.flatMap((p) => ["-loop", "1", "-t", pngDur, "-i", `"${p.png}"`]);
    const inputArgs = ["-i", `"${concatPath}"`, ...pngInputArgs];
    const filter = buildOverlayChain(shiftedCues, pngs);
    const cmd = [
      "ffmpeg", "-y", ...inputArgs,
      "-filter_complex", `"${filter}"`,
      "-map", `"[outv]"`, "-map", "0:a",
      "-t", baseDur.toFixed(3),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-r", "30", "-movflags", "+faststart",
      `"${finalPath}"`,
    ].join(" ");
    await execp(cmd, { maxBuffer: 200 * 1024 * 1024 });
  }

  /* Music mix step — if a track was selected, mix it in at -14dB under the source video audio.
   * Source audio (engine notes / ambient) stays primary; music sits underneath as a bed. */
  if (musicTrack && musicTrack.path && existsSync(musicTrack.path)) {
    const mixed = path.join(runDir, "_mixed.mp4");
    const musicGain = 0.18;   // ~ -15dB under source
    /* Why: amix=duration=first locks output length to the source video. apad on music ensures
     * it doesn't run out early if the track is shorter than the video. afade out on music last 1s. */
    const cmd = [
      "ffmpeg", "-y",
      "-i", `"${finalPath}"`,
      "-i", `"${musicTrack.path}"`,
      "-filter_complex",
      `"[1:a]aloop=loop=-1:size=2e9,volume=${musicGain},afade=t=out:st=33:d=2[bgm];` +
      `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]"`,
      "-map", "0:v", "-map", `"[a]"`,
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-shortest",
      `"${mixed}"`,
    ].join(" ");
    await execp(cmd, { maxBuffer: 200 * 1024 * 1024 });
    // Replace finalPath with the mixed version
    await execp(`mv "${mixed}" "${finalPath}"`);
  }

  const sz = (await stat(finalPath)).size;
  console.log(`[edit] rendered → ${finalPath} (${(sz / 1e6).toFixed(1)} MB)`);
  return finalPath;
}

/* ---------- TOP LEVEL ---------- */

/** Discover the most recent shoot folder under the configurable shoots root. */
export async function pickLatestShootFolder() {
  const shootsDir = Paths.getShootsDir();
  if (!existsSync(shootsDir)) return null;
  const ents = await readdir(shootsDir, { withFileTypes: true });
  const dirs = ents.filter(e => e.isDirectory()).map(e => path.join(shootsDir, e.name));
  if (dirs.length === 0) return null;
  const stats = await Promise.all(dirs.map(async d => ({ d, mt: (await stat(d)).mtimeMs })));
  stats.sort((a, b) => b.mt - a.mt);
  return stats[0].d;
}

/** Find a shoot folder whose name contains any of the subject's tokens. Falls back to latest. */
export async function findShootFolderForSubject(subject) {
  if (!subject) return await pickLatestShootFolder();
  const shootsDir = Paths.getShootsDir();
  if (!existsSync(shootsDir)) return null;
  const ents = await readdir(shootsDir, { withFileTypes: true });
  const dirs = ents.filter(e => e.isDirectory());
  if (dirs.length === 0) return null;

  const tokens = subject.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  // Score each folder by how many subject tokens appear in its name
  const scored = dirs.map(d => {
    const name = d.name.toLowerCase();
    const score = tokens.reduce((s, tok) => s + (name.includes(tok) ? 1 : 0), 0);
    return { d, score, name };
  });
  // Best match: highest score (must be > 0 to be considered a real match)
  scored.sort((a, b) => b.score - a.score);
  if (scored[0].score > 0) return path.join(shootsDir, scored[0].d.name);

  // No match — use latest as graceful fallback
  return await pickLatestShootFolder();
}

/** Build a teaser from real footage. Subject from folder name if not given.
 *  customText → closing tail-card. music → 'epic'/'driving'/'cinematic'/'action' OR a track filename. */
export async function buildProductionTeaser({ shootFolder, subject, customText, music, aspect = { w: 1080, h: 1920 }, onStage } = {}) {
  /* onStage(stageName, percent?) — optional callback so the bridge can pump
   * lane-grouped progress events into the task strip. Each major step calls it
   * so the operator sees "scanning → planning → encoding → finalising" land. */
  const stage = (name, percent) => { if (typeof onStage === "function") onStage(name, percent); };

  if (!shootFolder) {
    shootFolder = subject ? await findShootFolderForSubject(subject) : await pickLatestShootFolder();
  }
  if (!shootFolder) throw new Error("no shoot folder found under ./shoots/ — drop one in or pass a path");

  /* Pick a music track. Default to "auto" which uses the first available track of any mood.
   * If music === false / "none", skip music entirely (source video audio drives). */
  let musicTrack = null;
  if (music !== false && music !== "none") {
    musicTrack = await pickTrack(typeof music === "string" ? music : null);
  }

  // Default subject: derive from folder name (e.g. "2026-04-30-audi-rs6" → "Audi RS6")
  if (!subject) {
    const base = path.basename(shootFolder);
    const cleaned = base.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]/g, " ").trim();
    subject = cleaned ? cleaned.replace(/\b\w/g, c => c.toUpperCase()) : "Subject";
  }

  const tStart = Date.now();
  const runId = `prod_${path.basename(shootFolder)}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const runDir = path.join(Paths.getOutputDir(), runId);

  console.log(`[edit] === PRODUCTION RUN  shoot="${shootFolder}"  subject="${subject}" ===`);
  stage("scanning shoot folder", 5);
  const scan = await scanShoot(shootFolder);
  console.log(`[edit] scan: ${scan.videos.length} videos, ${scan.images.length} images`);
  if (scan.videos.length === 0 && scan.images.length === 0) {
    throw new Error(`no usable assets found under ${shootFolder}`);
  }

  stage("planning cuts + beat-sync", 20);
  const plan = planEdit(scan, subject, 30, customText, musicTrack, aspect);
  if (musicTrack) console.log(`[edit] using music: ${musicTrack.file} (${musicTrack.bpm} BPM, ${musicTrack.mood})`);
  console.log(`[edit] plan: ${plan.segments.length} cuts, ${plan.textCues.length} text overlays, total ${plan.totalSec.toFixed(1)}s`);

  // Ensure the FOM intro AND outro cards are built (cached after first run)
  stage("preparing intro + outro cards", 30);
  await buildIntroCard();
  await buildOutroCard();

  stage("encoding segments + overlays", 50);
  const finalPath = await renderEdit(plan, runDir, musicTrack);
  stage("finalising", 95);
  const totalSec = ((Date.now() - tStart) / 1000).toFixed(0);
  console.log(`[edit] === DONE in ${totalSec}s → ${finalPath} ===`);
  return { runId, subject, shootFolder, scan, plan, finalPath, durationSec: totalSec };
}
