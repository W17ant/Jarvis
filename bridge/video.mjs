/** video.mjs - Orchestrator for the Flat-Out cinematic montage demo.
 *  Pipeline: source 4 Audi RS6 images (via flux-schnell) → 4 parallel happy-horse img2vid
 *  (2× 5s + 2× 10s) → ffmpeg concat with a 3s FOM intro → final 33s mp4.
 *
 *  Models:
 *   - alibaba/happy-horse/image-to-video — 720p img2vid, $0.14/s
 *   - fal-ai/flux/schnell — fast image gen for source plates
 */

import { fal } from "@fal-ai/client";
import { writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as Paths from "./paths.mjs";

const execp = promisify(exec);

/* Init Fal client lazily so a missing key doesn't crash the bridge boot. */
let falConfigured = false;
function ensureFal() {
  if (falConfigured) return;
  const key = process.env.FAL_KEY || process.env.FAL_API_KEY || process.env.FAL_AI_KEY;
  if (!key) throw new Error("FAL_KEY missing — check /Users/Antony/Desktop/AI-Custom-Cards/.env.local");
  fal.config({ credentials: key });
  falConfigured = true;
}

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ASSET_DIR = path.join(PROJECT_DIR, "assets");
const SHOOT_DIR = path.join(ASSET_DIR, "demo-shoot");
/* OUTPUT_DIR resolved at call sites via Paths.getOutputDir() so it tracks operator config. */

/* Why: short default keeps the slug short ("audi-rs6") so it matches the existing cache folder.
 * Prompts still build out a richer scene description on top of this. */
const DEFAULT_SUBJECT = "Audi RS6";

/** Filesystem-safe slug for a subject so cache directories don't break on punctuation/spaces. */
export function subjectSlug(subject) {
  return (subject || DEFAULT_SUBJECT)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "subject";
}

function subjectDir(subject) { return path.join(SHOOT_DIR, subjectSlug(subject)); }

async function ensureDirs(subject) {
  if (!existsSync(SHOOT_DIR)) await mkdir(SHOOT_DIR, { recursive: true });
  /* Output dir auto-created by Paths.getOutputDir(); no need to mkdir here. */
  Paths.getOutputDir();
  if (subject) {
    const d = subjectDir(subject);
    if (!existsSync(d)) await mkdir(d, { recursive: true });
  }
}

/** Download a URL to a local path. */
async function downloadTo(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${url}: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(dest, buf);
  return dest;
}

/* ---------- IMAGE SOURCING ---------- */

/** Default RS6 prompts kept as a fallback if LLM prompt-gen is unavailable. */
const DEFAULT_RS6_PROMPTS = [
  "Audi RS6 Avant Performance in Nardo Grey, front three-quarter low angle hero shot, misty Manchester rooftop carpark at dawn, cinematic, 50mm lens, shallow depth of field, automotive editorial photography, dramatic lighting, water on the ground, natural reflections, 35mm film, ultra detailed",
  "Audi RS6 Avant Performance in Nardo Grey, side profile shot at eye level, misty Manchester rooftop carpark at dawn, cinematic, 85mm lens, automotive editorial photography, low key lighting, water reflections, ultra detailed",
  "Audi RS6 Avant Performance in Nardo Grey, rear three-quarter close-up showing exhaust tips and quattro badge, misty Manchester rooftop carpark at dawn, cinematic, 50mm, shallow depth of field, dramatic side lighting, automotive editorial photography, ultra detailed",
  "Audi RS6 Avant Performance in Nardo Grey, detail shot of the front grille and matrix LED headlights, misty Manchester rooftop carpark at dawn, cinematic macro, 100mm lens, shallow depth of field, low key lighting, automotive editorial detail photography, ultra detailed",
];

/** Ask the local Qwen via the bridge to write 4 cohesive flux-schnell prompts for an arbitrary subject.
 *  Returns array of 4 prompt strings. Falls back to RS6 defaults on parse failure or LLM unreachable. */
async function buildSubjectPromptsViaLLM(subject) {
  const sys = `You write image-generation prompts for a UK automotive media agency's cinematic teaser videos. Output JSON only — no commentary, no markdown.`;
  const user = `Subject: "${subject}".

Write 4 prompts for fal-ai/flux/schnell that depict the same subject from 4 different angles, in the same cohesive setting and lighting, so the resulting images feel like one editorial photoshoot.

Constraints per prompt:
- Reference the subject explicitly (so all 4 images show the same thing)
- 4 different framings: 1) wide hero front 3/4, 2) side profile, 3) rear 3/4 detail, 4) close-up macro detail
- Same atmospheric setting (e.g. misty rooftop carpark at dawn, neon-lit garage, sun-drenched coastal road, etc. — pick what suits the subject)
- Cinematic photography keywords: 50mm/85mm lens, shallow depth of field, editorial, 35mm film, dramatic lighting, ultra detailed
- Each prompt 1-2 sentences

Return strictly JSON: {"prompts": ["...", "...", "...", "..."]}.`;

  try {
    const res = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || "qwen2.5:14b",
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        stream: false,
        format: "json",
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.message.content);
    if (!Array.isArray(parsed.prompts) || parsed.prompts.length !== 4) throw new Error("bad shape");
    return parsed.prompts.map(String);
  } catch (e) {
    console.warn(`[video] LLM prompt-gen failed (${e.message}), using template fallback`);
    return DEFAULT_RS6_PROMPTS.map(p => p.replaceAll("Audi RS6 Avant Performance in Nardo Grey", subject));
  }
}

/** Generate (or load from cache) 4 source images for the given subject.
 *  Cache: assets/demo-shoot/<slug>/img-1..4.jpg — survives across runs and requests. */
export async function generateSourceImages({ subject = DEFAULT_SUBJECT, force = false } = {}) {
  ensureFal();
  await ensureDirs(subject);

  const dir = subjectDir(subject);
  const existing = (await readdir(dir).catch(() => [])).filter(n => /^img-\d+\.(jpg|jpeg|png|webp)$/i.test(n));
  if (existing.length === 4 && !force) {
    console.log(`[video] cached plates for "${subject}" found — skipping flux-schnell`);
    return existing.sort().map(n => path.join(dir, n));
  }

  console.log(`[video] no cache for "${subject}" — asking LLM for 4 cohesive prompts…`);
  const prompts = await buildSubjectPromptsViaLLM(subject);

  console.log(`[video] generating 4 source images for "${subject}" with flux-schnell…`);
  const results = await Promise.all(prompts.map(async (prompt, i) => {
    const out = await fal.subscribe("fal-ai/flux/schnell", {
      input: { prompt, image_size: "landscape_16_9", num_inference_steps: 4, num_images: 1 },
    });
    const imgUrl = out.data?.images?.[0]?.url;
    if (!imgUrl) throw new Error(`flux returned no image for prompt ${i}`);
    const dest = path.join(dir, `img-${i + 1}.jpg`);
    await downloadTo(imgUrl, dest);
    console.log(`[video] saved ${dest}`);
    return dest;
  }));
  return results;
}

/* ---------- HAPPY-HORSE IMG2VID ---------- */

/** Build 4 motion prompts. Camera moves are subject-agnostic; mentioning the subject keeps happy-horse anchored. */
function buildMotionPrompts(subject) {
  return [
    `Slow cinematic dolly forward, camera pushing in toward the ${subject}, subtle handheld micro-movement, mist drifting across the frame, 35mm film grain, dawn light gradually intensifying, the subject stays centred and unchanged`,
    `Slow cinematic side-tracking shot, camera moving parallel to the ${subject}, smooth slider movement, dust particles catching the light, atmospheric haze, no zoom, subject stays centred`,
    `Slow cinematic orbit, camera arcing gently around the ${subject}, atmospheric mist, dawn light, subject stays centred and unchanged`,
    `Slow cinematic macro pull-back, very subtle camera movement on the ${subject}, droplets of water catching the light, atmospheric morning mist, the subject stays centred`,
  ];
}

const CLIP_PLAN = [
  { idx: 0, duration: 5,  motionIdx: 0 },
  { idx: 1, duration: 5,  motionIdx: 1 },
  { idx: 2, duration: 10, motionIdx: 2 },
  { idx: 3, duration: 10, motionIdx: 3 },
];

/** Upload a local image to Fal's storage so happy-horse can reference it by URL. */
async function uploadImage(localPath) {
  const data = await import("node:fs").then(m => m.promises.readFile(localPath));
  const file = new File([data], path.basename(localPath), { type: "image/jpeg" });
  return await fal.storage.upload(file);
}

/** Run all 4 happy-horse calls in parallel. Returns array of local mp4 paths. */
export async function generateClips(sourceImages, runId, subject = DEFAULT_SUBJECT) {
  ensureFal();
  const runDir = path.join(Paths.getOutputDir(), runId);
  if (!existsSync(runDir)) await mkdir(runDir, { recursive: true });

  console.log(`[video] uploading 4 source images to Fal storage…`);
  const uploads = await Promise.all(sourceImages.map(p => uploadImage(p)));

  const motionPrompts = buildMotionPrompts(subject);

  console.log(`[video] firing 4 parallel happy-horse calls (2×5s + 2×10s, 720p)…`);
  const tStart = Date.now();
  const clips = await Promise.all(CLIP_PLAN.map(async (plan, i) => {
    const prompt = motionPrompts[plan.motionIdx];
    const out = await fal.subscribe("alibaba/happy-horse/image-to-video", {
      input: {
        prompt,
        image_url: uploads[plan.idx],
        duration: plan.duration,
        resolution: "720p",
      },
      logs: false,
    });
    const videoUrl = out.data?.video?.url || out.data?.video_url;
    if (!videoUrl) throw new Error(`happy-horse returned no video for clip ${i}: ${JSON.stringify(out.data).slice(0, 200)}`);
    const dest = path.join(runDir, `clip-${i + 1}-${plan.duration}s.mp4`);
    await downloadTo(videoUrl, dest);
    console.log(`[video] [+${((Date.now() - tStart) / 1000).toFixed(0)}s] saved ${dest}`);
    return dest;
  }));
  return clips;
}

/* ---------- INTRO CARD + STITCH ---------- */

/** Build a 2-second FOM outro card — same logo, slightly different framing (smaller, with @flatoutmediauk).
 *  Mirrors buildIntroCard structure for consistency. */
export async function buildOutroCard({ force = false } = {}) {
  await ensureDirs();
  const outroPath = path.join(ASSET_DIR, "outro-2s.mp4");
  if (existsSync(outroPath) && !force) return outroPath;

  const wordmark = path.join(ASSET_DIR, "fom-wordmark.png");
  const dial = path.join(ASSET_DIR, "fom-dial.png");
  const handle = "@FLATOUTMEDIAUK";

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

/** Build a 3-second FOM intro mp4 from the wordmark logo over black. Cached after first build. */
export async function buildIntroCard({ force = false } = {}) {
  await ensureDirs();
  const introPath = path.join(ASSET_DIR, "intro-3s.mp4");
  if (existsSync(introPath) && !force) return introPath;

  const wordmark = path.join(ASSET_DIR, "fom-wordmark.png");
  const dial = path.join(ASSET_DIR, "fom-dial.png");

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

/** Concatenate intro + 4 clips into one 33s vertical mp4 (slow contemplative cuts). Kept for reference. */
export async function stitchFinal({ introPath, clipPaths, runId }) {
  const runDir = path.join(Paths.getOutputDir(), runId);
  const finalPath = path.join(runDir, "final.mp4");

  const inputs = [introPath, ...clipPaths];
  const inputArgs = inputs.map(p => ["-i", `"${p}"`]).flat();
  const filters = inputs.map((_, i) =>
    `[${i}:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[v${i}]`
  ).join(";");
  const concatList = inputs.map((_, i) => `[v${i}]`).join("");
  const filterComplex = `${filters};${concatList}concat=n=${inputs.length}:v=1:a=0[outv]`;

  const cmd = [
    "ffmpeg", "-y",
    ...inputArgs,
    "-filter_complex", `"${filterComplex}"`,
    "-map", `"[outv]"`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    `"${finalPath}"`,
  ].join(" ");

  await execp(cmd, { maxBuffer: 50 * 1024 * 1024 });
  const sz = (await stat(finalPath)).size;
  console.log(`[video] stitched (slow) → ${finalPath} (${(sz / 1e6).toFixed(1)} MB)`);
  return finalPath;
}

/** Build a Top Gear / Gran Turismo style fast-cut sequence from the 4 source clips.
 *  Picks ~28 segments of varied length (0.3–1.2s), rises in pacing through the middle,
 *  ends on a longer hero hold. Intro card stays on the front. Returns final mp4 path. */
export async function stitchFinalFastCut({ introPath, clipPaths, runId, targetSec = 30 }) {
  const runDir = path.join(Paths.getOutputDir(), runId);
  const finalPath = path.join(runDir, "final.mp4");

  // Probe each clip's duration so we can pick safe in-points
  const durations = await Promise.all(clipPaths.map(async (p) => {
    const { stdout } = await execp(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`);
    return Math.max(1, parseFloat(stdout.trim()) || 5);
  }));

  /* Why: cinematic teaser pacing — bookend with longer holds (read the shot), rapid through the middle (energy).
   * Pattern roughly mirrors a Top Gear / Gran Turismo cut sheet: medium→fast→fastest→long-hero. */
  const pattern = [
    1.0, 0.8,
    0.6, 0.5, 0.4, 0.5, 0.6, 0.4, 0.5,
    0.35, 0.35, 0.3, 0.35, 0.3, 0.35, 0.4, 0.3, 0.35,
    0.5, 0.6, 0.5, 0.45, 0.5,
    0.8, 1.0, 1.2,
    1.6, // hero hold
  ];
  const totalPattern = pattern.reduce((a, b) => a + b, 0);
  const scale = targetSec / totalPattern;
  const segDurs = pattern.map(p => +(p * scale).toFixed(3));

  /* Pick clip + in-point for each segment. Constraints: don't repeat the same clip back-to-back when possible,
   * cycle through all 4 clips so all hero angles get screen time, never run past the source clip's end. */
  let lastClip = -1;
  const segs = segDurs.map((dur, i) => {
    let clipIdx = (i + (Math.floor(i / 3) % 4)) % clipPaths.length;
    if (clipIdx === lastClip) clipIdx = (clipIdx + 1) % clipPaths.length;
    lastClip = clipIdx;
    const maxStart = Math.max(0, durations[clipIdx] - dur - 0.05);
    // Why: bias the in-point so we sample varied moments — early/mid/late beats across the source clip
    const phase = (i * 0.27) % 1;
    const start = +(phase * maxStart).toFixed(3);
    return { clipIdx, start, dur };
  });

  // Force the hero (last) seg to use the longest source clip from a varied in-point
  const heroClip = durations.indexOf(Math.max(...durations));
  segs[segs.length - 1] = { clipIdx: heroClip, start: 1.0, dur: segDurs[segs.length - 1] };

  console.log(`[video] fast-cut plan: ${segs.length} segments, sum=${segs.reduce((a, s) => a + s.dur, 0).toFixed(2)}s`);

  /* Build ffmpeg filter graph: trim each segment from its source, scale-crop to 1080×1920, concat in order.
   * Putting the FOM intro (input 0) at the front, source clips are inputs 1..4, segments index those by clipIdx+1. */
  const inputs = [introPath, ...clipPaths];
  const inputArgs = inputs.flatMap(p => ["-i", `"${p}"`]);

  const introFilter = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[intro]`;
  const segFilters = segs.map((s, i) => {
    const src = s.clipIdx + 1; // intro is input 0
    return `[${src}:v]trim=start=${s.start}:duration=${s.dur},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30[s${i}]`;
  });
  const concatLabels = ["[intro]", ...segs.map((_, i) => `[s${i}]`)].join("");
  const filterComplex = [introFilter, ...segFilters].join(";") + `;${concatLabels}concat=n=${segs.length + 1}:v=1:a=0[outv]`;

  const cmd = [
    "ffmpeg", "-y",
    ...inputArgs,
    "-filter_complex", `"${filterComplex}"`,
    "-map", `"[outv]"`,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-movflags", "+faststart",
    `"${finalPath}"`,
  ].join(" ");

  await execp(cmd, { maxBuffer: 200 * 1024 * 1024 });
  const sz = (await stat(finalPath)).size;
  console.log(`[video] stitched (fast-cut, ${segs.length} segments) → ${finalPath} (${(sz / 1e6).toFixed(1)} MB)`);
  return finalPath;
}

/* ---------- TOP-LEVEL ORCHESTRATION ---------- */

/** Full pipeline: ensure subject source images, run 4 parallel happy-horse, stitch with intro. Returns final mp4 path. */
export async function buildInstagramTeaser({ subject = DEFAULT_SUBJECT } = {}) {
  const slug = subjectSlug(subject);
  const runId = `${slug}_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  console.log(`[video] === RUN ${runId}  subject="${subject}" ===`);

  const tStart = Date.now();
  const [sourceImages, introPath] = await Promise.all([
    generateSourceImages({ subject }),
    buildIntroCard(),
  ]);

  const clipPaths = await generateClips(sourceImages, runId, subject);
  // Why: fast-cut pacing (Top Gear / Gran Turismo) feels far more "teaser" than 4 long takes.
  const finalPath = await stitchFinalFastCut({ introPath, clipPaths, runId });

  const totalSec = ((Date.now() - tStart) / 1000).toFixed(0);
  console.log(`[video] === DONE in ${totalSec}s → ${finalPath} ===`);
  return { runId, subject, finalPath, sourceImages, clipPaths, introPath, durationSec: totalSec };
}
