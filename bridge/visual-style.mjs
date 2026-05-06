/** visual-style.mjs - LLM-vision-driven style guide ingestion.
 *
 *  The existing style-memory.mjs computes ImageMagick *numerical* metrics
 *  (brightness / contrast / saturation curves). That's deterministic and great
 *  for grading match, but it doesn't capture *what* the operator's style
 *  actually looks like in plain English ("warm tungsten with crushed shadows,
 *  high-contrast portraiture, shallow depth of field, anamorphic-style
 *  framing"). This module fills that gap.
 *
 *  Inputs the operator can point us at:
 *    - A folder of stills (current style-memory accepts this — we add prose)
 *    - A folder mixed with video files (we ffmpeg-sample 4 keyframes per video)
 *    - A list of explicit file paths (uploaded reference set)
 *
 *  Vision model: tries the configured 'vision' provider via llm/providers.mjs
 *  first (Anthropic / OpenAI), falling back to local qwen2.5vl:7b. Cloud
 *  models give richer descriptions; the local fallback works without API keys.
 *
 *  Output: stored in style-memory's edit_styles table under .visual_description
 *  (a new column), so the existing recall_style / list_styles tools surface
 *  the prose alongside the numerical signature.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { chat, pickProvider } from "./llm/providers.mjs";
import { extractStyle as extractNumeric } from "./style-memory.mjs";

const execFile = promisify(_execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const FRAMES_DIR = path.resolve(PROJECT_DIR, "data", "style-frames");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]);

/** Extract N keyframes from a video to PNG files. Uses ffmpeg's `select` filter
 *  pegged to the I-frames so we get visually distinct moments rather than
 *  near-duplicates. Returns the list of frame paths. */
async function extractVideoFrames(videoPath, framesPerVideo = 4) {
  await fsp.mkdir(FRAMES_DIR, { recursive: true });
  const stem = path.basename(videoPath).replace(/\.[^.]+$/, "");
  const outPattern = path.join(FRAMES_DIR, `${stem}-${Date.now()}-%02d.png`);
  /* select=eq(pict_type,I) keeps only I-frames; thumbnail filter then picks
   * the N most representative ones from those keyframes. -frames:v caps
   * the output count. -vsync vfr is required when filtering temporally. */
  const args = [
    "-loglevel", "error",
    "-i", videoPath,
    "-vf", `select='eq(pict_type,I)',thumbnail=${framesPerVideo}`,
    "-frames:v", String(framesPerVideo),
    "-vsync", "vfr",
    outPattern,
  ];
  try {
    await execFile("ffmpeg", args, { timeout: 60_000 });
  } catch (e) {
    /* If thumbnail filter fails (shorter video), fall back to a uniform sample. */
    const args2 = [
      "-loglevel", "error",
      "-i", videoPath,
      "-vf", `fps=1/4`,
      "-frames:v", String(framesPerVideo),
      outPattern,
    ];
    try { await execFile("ffmpeg", args2, { timeout: 60_000 }); }
    catch { return []; }
  }
  const dir = await fsp.readdir(FRAMES_DIR);
  const matched = dir.filter((f) => f.startsWith(stem) && f.endsWith(".png")).map((f) => path.join(FRAMES_DIR, f));
  return matched;
}

/** Resolve a target into a list of image paths. Handles:
 *   - Single file: image → [path], video → frames
 *   - Folder: walks one level deep, expanding videos to frames
 *   - Array of paths: any of the above per-element */
async function gatherImages(target, framesPerVideo = 4) {
  const targets = Array.isArray(target) ? target : [target];
  const out = [];
  for (const t of targets) {
    let stat;
    try { stat = await fsp.stat(t); } catch { continue; }
    if (stat.isFile()) {
      const ext = path.extname(t).toLowerCase();
      if (IMAGE_EXTS.has(ext)) out.push(t);
      else if (VIDEO_EXTS.has(ext)) {
        const frames = await extractVideoFrames(t, framesPerVideo);
        out.push(...frames);
      }
    } else if (stat.isDirectory()) {
      const ents = await fsp.readdir(t, { withFileTypes: true });
      for (const e of ents) {
        if (!e.isFile()) continue;
        const p = path.join(t, e.name);
        const ext = path.extname(e.name).toLowerCase();
        if (IMAGE_EXTS.has(ext)) out.push(p);
        else if (VIDEO_EXTS.has(ext)) {
          const frames = await extractVideoFrames(p, framesPerVideo);
          out.push(...frames);
        }
      }
    }
  }
  return out;
}

const STYLE_DESCRIPTION_PROMPT = `You are a senior colourist and DP analysing a creator's signature visual style. From the reference frames provided, identify the consistent stylistic decisions across them. Be specific and structured — generic phrases like "cinematic" or "moody" are useless to a future system that needs to apply this style.

Output exactly this JSON shape (no commentary, no markdown fences):
{
  "summary": "2-3 sentences describing the overall look",
  "palette": "dominant colours, warmth/coolness bias, accent hues",
  "lighting": "key:fill ratio, hard vs soft, time-of-day bias, source quality",
  "contrast": "shadow depth, highlight handling, midtone curve",
  "framing": "subject placement, lens length implications, depth-of-field tendency",
  "grading": "specific colour-correction notes — e.g. 'crushed blacks with teal lift', 'warm magenta highlights'",
  "mood": "emotional register — direct, no flowery adjectives",
  "consistency": "what's CONSISTENT across all frames vs varies — only flag the consistent decisions"
}`;

/**
 * Learn a visual style from a folder, file, or list of paths. Combines the
 * existing numerical-metric extraction with a vision-LLM prose description.
 *
 * @param {object} args
 * @param {string|string[]} args.target  Folder, file, or list of paths
 * @param {string}          args.name    Name to save under
 * @param {number} [args.sampleCount=12] Cap on frames sent to the vision model
 * @param {number} [args.framesPerVideo=4] Frames extracted per video file
 * @param {string} [args.provider]       Override the configured vision provider
 */
export async function learnVisualStyle({ target, name, sampleCount = 12, framesPerVideo = 4, provider } = {}) {
  if (!name) return { ok: false, error: "name required (style identifier — e.g. 'fom-signature')" };
  if (!target) return { ok: false, error: "target required (folder, file, or list of paths)" };

  const images = await gatherImages(target, framesPerVideo);
  if (!images.length) return { ok: false, error: "No images or videos found at the target." };
  /* Cap to keep the LLM context bounded — vision tokens add up fast. The most
   * recently modified files win (matches style-memory's mtime sort logic). */
  const withTimes = await Promise.all(images.map(async (f) => ({ f, t: (await fsp.stat(f)).mtimeMs.catch?.(() => 0) ?? 0 })));
  withTimes.sort((a, b) => b.t - a.t);
  const sample = withTimes.slice(0, sampleCount).map((e) => e.f);

  /* Encode each frame as base64 for the vision call. Images larger than ~2MB
   * are downscaled in-memory via canvas — but Node has no canvas; we trust
   * the operator's source isn't 4K each. If it becomes a problem, add an
   * ImageMagick resize step here. */
  const parts = [{ type: "text", text: `Reference set: ${sample.length} frames.` }];
  for (const img of sample) {
    const bytes = await fsp.readFile(img);
    const ext = path.extname(img).slice(1).toLowerCase();
    const mediaType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    parts.push({ type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } });
  }

  /* Call the vision provider. Request fewer tokens than usual — the JSON is
   * compact. If no cloud vision provider is configured, fall through to the
   * local Ollama qwen2.5vl path; the chat() function picks via workload. */
  const visionProvider = provider || pickProvider("vision");
  let descJson;
  try {
    const r = await chat({
      provider: visionProvider,
      workload: "vision",
      messages: [
        { role: "system", content: STYLE_DESCRIPTION_PROMPT },
        { role: "user", content: parts },
      ],
      maxTokens: 700,
    });
    /* Parse — same tolerant approach as browse.mjs (the LLM might wrap in fences). */
    const txt = String(r.text || "").trim();
    try { descJson = JSON.parse(txt); }
    catch {
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { try { descJson = JSON.parse(m[0]); } catch {} }
    }
    if (!descJson) descJson = { summary: txt.slice(0, 600), parseError: true };
  } catch (e) {
    return { ok: false, error: `Vision call failed (${visionProvider}): ${e.message}` };
  }

  /* Layer the prose description on top of the existing numerical signature.
   * style-memory.mjs's extractStyle handles a folder; for arbitrary file lists
   * we skip the numerical pass (it's folder-only by design). The prose alone
   * is still useful — the numerical layer can be added later with a curated
   * folder if the operator wants. */
  let numericalResult = null;
  if (typeof target === "string") {
    try { numericalResult = await extractNumeric({ folder: target, name, sampleCount, dryRun: true }); }
    catch (e) { numericalResult = { ok: false, error: e.message }; }
  }

  /* Persist via the style-memory DB layer. We reuse extractStyle's writer by
   * passing the description through — it accepts an override description. */
  if (typeof target === "string") {
    try {
      const written = await extractNumeric({
        folder: target,
        name,
        sampleCount,
        description: JSON.stringify(descJson),
      });
      return {
        ok: true,
        name,
        framesAnalysed: sample.length,
        provider: visionProvider,
        visualDescription: descJson,
        numericalSignature: written.signature || null,
        savedTo: "data/memory.db (edit_styles table)",
      };
    } catch (e) {
      /* If the DB write fails, still return the description so the operator
       * can copy/save it manually. */
      return {
        ok: true,
        name,
        framesAnalysed: sample.length,
        provider: visionProvider,
        visualDescription: descJson,
        savedTo: null,
        warning: `Could not persist to style memory: ${e.message}`,
      };
    }
  }

  /* Multi-path / array target — return the description without persisting since
   * extractStyle is folder-bound. Operator can copy/save it as needed. */
  return {
    ok: true,
    name,
    framesAnalysed: sample.length,
    provider: visionProvider,
    visualDescription: descJson,
    savedTo: null,
    note: "Multi-path target: prose description returned but not persisted (style-memory expects a folder). Pass a folder to also store the numerical signature.",
  };
}
