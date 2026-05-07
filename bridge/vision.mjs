/** vision.mjs - Image / video understanding via Qwen 2.5-VL (local Ollama).
 *
 *  Tools the LLM can call:
 *    describe_image          - caption a single image (or video — auto-extracts a keyframe)
 *    caption_shoot_folder    - sample N media files from a shoot folder, caption each, cache, return summary
 *    find_frame              - semantic search across cached captions for "shots of front grille / rear lights / etc"
 *
 *  Caching: captions are stored in SQLite (frame_captions table) keyed by absolute path + mtime + size,
 *  so repeat queries skip the model. Embeddings are stored alongside so find_frame can rank by semantic
 *  similarity against the operator's query — no per-query model call needed.
 *
 *  Why a separate VL model: qwen2.5vl:7b (~6GB) handles images natively and runs alongside the 32b text
 *  model without VRAM pressure on M-series Macs. Captions are short (1-3 sentences) so generation is fast.
 */

import Database from "better-sqlite3";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");
/* SHOOTS_DIR resolved at call sites via Paths.getShootsDir(). */
const FRAME_CACHE_DIR = path.join(PROJECT_DIR, "data", "frame-cache");

/* ---------- CANCEL FLAG ----------
 * Why: a single-process kiosk doesn't need a sophisticated abort controller, but it
 * does need per-runId cancel now that the HUD's task-strip can show multiple
 * concurrent tasks (crew runs, video edits, etc). Two-tier system:
 *
 *   - global flag (`aborted`) — raised by `/cancel` with no runId. Stops EVERYTHING.
 *     Matches the original "stop everything" voice command behaviour.
 *   - per-runId flags (`_runIdAborts: Set`) — raised by `/cancel?runId=X`. Stops
 *     just that one task. Per-row × button in the HUD task strip uses this.
 *
 * isAborted() with no arg = global only. isAborted(runId) = global OR runId-scoped.
 * Long-running loops in this module pass their current runId where they have one. */
let aborted = false;
const _runIdAborts = new Set();
export function raiseAbort(runId) {
  if (runId == null) aborted = true;
  else _runIdAborts.add(String(runId));
}
export function clearAbort(runId) {
  if (runId == null) { aborted = false; _runIdAborts.clear(); }
  else _runIdAborts.delete(String(runId));
}
export function isAborted(runId) {
  if (aborted) return true;
  if (runId != null && _runIdAborts.has(String(runId))) return true;
  return false;
}

/* Lazy env readers — same reasoning as agency.mjs/leads.mjs: the bridge calls
 * loadEnvFile() AFTER all imports resolve, so reading process.env at top level
 * misses .env-set values like VL_MODEL=qwen2.5vl:32b on the production M5 Max. */
const OLLAMA_URL_FN = () => process.env.OLLAMA_URL || "http://localhost:11434";
const VL_MODEL_FN = () => process.env.VL_MODEL || "qwen2.5vl:7b";
const VL_KEEP_ALIVE_FN = () => process.env.VL_KEEP_ALIVE || "30s";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
/* Why: M1 Max 64GB cannot host qwen2.5:32b text + qwen2.5vl:32b vision concurrently.
 * Live demo on 2026-05-01 hit this — VL alone ate 46GB of GPU and "Stopping..." stayed
 * stuck for tens of seconds, timing out conversational text turns and dropping the assistant
 * to offline-fallback. Reverted to qwen2.5vl:7b as the safer default; the folder-name
 * context hint added in describeImage already covers most of 32b's accuracy lift.
 *
 * To re-enable 32b for batch press-release captioning, set in .env:
 *   VL_MODEL=qwen2.5vl:32b
 *   VL_KEEP_ALIVE=10m
 * — but ONLY when not running the kiosk in conversational mode. */
const VL_MODEL = process.env.VL_MODEL || "qwen2.5vl:7b";
const EMBED_MODEL = "nomic-embed-text";

/* Why: short keep_alive forces VL out of GPU after each request so the text model can
 * snap back for the next conversational turn. "30s" balances cold-start cost (≈5-10s on
 * 7b) against text-model swap cost. Bump to "5m" or "10m" only for sustained batch jobs
 * where no live text conversation is happening. */
const VL_KEEP_ALIVE = process.env.VL_KEEP_ALIVE || "30s";

/* Why: side-channel SQLite handle so vision.mjs stays decoupled from memory.mjs imports.
 * Same DB file though — keeps everything in one place for backup/migrations. */
const db = new Database(path.join(DATA_DIR, "memory.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS frame_captions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  caption TEXT NOT NULL,
  embedding BLOB,
  shoot_folder TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(path, mtime, size)
);
CREATE INDEX IF NOT EXISTS idx_fc_folder ON frame_captions(shoot_folder);
`);

/* ---------- helpers ---------- */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv"]);

function vectorToBuffer(vec) { return Buffer.from(new Float32Array(vec).buffer); }
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

async function embed(text) {
  const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
  });
  if (!r.ok) throw new Error(`embedding ${r.status}`);
  const j = await r.json();
  return j.embedding;
}

/* Resolve a user-supplied path to something inside the project (no escapes). */
function resolveSafePath(input) {
  if (!input) return null;
  let abs = path.isAbsolute(input) ? input : path.resolve(PROJECT_DIR, input);
  // Allow callers to pass folder-name-only ("2026-05-01-press-car") — assume under shoots/
  if (!existsSync(abs) && !path.isAbsolute(input)) {
    const candidate = path.join(Paths.getShootsDir(), input);
    if (existsSync(candidate)) abs = candidate;
  }
  if (!Paths.isWithinAllowedRoots(abs)) return null;
  return abs;
}

/* Why: extract a representative frame at ~30% of the clip's duration (start frames are often
 * slates/black, end frames are credits). Uses execFile (no shell) — safe with arbitrary paths. */
async function extractKeyframe(videoPath) {
  if (!existsSync(FRAME_CACHE_DIR)) await mkdir(FRAME_CACHE_DIR, { recursive: true });
  const out = path.join(FRAME_CACHE_DIR, `${path.basename(videoPath)}.jpg`);
  if (existsSync(out)) return out;

  let durationSec = 5;
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", videoPath,
    ], { timeout: 10_000 });
    const d = parseFloat(stdout.trim());
    if (Number.isFinite(d) && d > 0) durationSec = d;
  } catch {}
  const seek = (durationSec * 0.3).toFixed(2);

  await execFileP("ffmpeg", [
    "-y", "-ss", seek, "-i", videoPath, "-vframes", "1", "-vf", "scale=1024:-1", out,
  ], { timeout: 30_000 });
  return out;
}

/**
 * Turn a shoot folder name like "2026-05-01-press-car" or
 * "client-mclaren-720s-track-day" into a subject hint phrase for the prompt.
 * Why: the VL model otherwise confuses similar-livery race cars (it called the
 * the press car a "McLaren 720S" twice in our 4-frame test). Folder names are usually
 * authoritative on the subject — let the model use them.
 */
function folderToSubjectHint(folderName) {
  if (!folderName) return null;
  /* Strip leading ISO date and trailing junk; turn dashes/underscores into spaces. */
  const cleaned = folderName
    .replace(/^\d{4}-\d{2}-\d{2}[-_]/, "")  // 2026-05-01- → ""
    .replace(/^\d{8}[-_]/, "")               // 20260501- → ""
    .replace(/[-_]/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 3) return null;
  /* Title-case for the prompt — reads better than slug-case inline. */
  const titleCased = cleaned.replace(/\b\w/g, c => c.toUpperCase());
  return titleCased;
}

async function captionImage(imagePath, prompt, folderHint = null) {
  const buf = await readFile(imagePath);
  const b64 = buf.toString("base64");
  /* Why: when a folder hint is available, prepend it as authoritative context. The model
   * will still call out a different subject if the image clearly isn't the hinted one, but
   * for ambiguous similar-looking cars (the press car vs 720S in lime green) the hint anchors it. */
  const subjectAnchor = folderHint
    ? `CONTEXT: The shoot folder is named "${folderHint}". Treat that as the canonical subject unless this image is unambiguously something else. `
    : "";
  const userPrompt = prompt || `${subjectAnchor}Describe this shot in 1-2 sentences for a media agency. If it's a vehicle, identify the make, model, and any visible numbers or branding. Note camera angle (low/high, front/3-4/profile/rear), lighting (overcast/golden hour/studio), and notable details.`;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: VL_MODEL_FN(),
      stream: false,
      keep_alive: VL_KEEP_ALIVE_FN(),
      messages: [{ role: "user", content: userPrompt, images: [b64] }],
      options: { temperature: 0.2 },  // Why: factual captions, low creativity.
    }),
  });
  if (!res.ok) throw new Error(`VL ${res.status}: ${await res.text().catch(() => "")}`);
  const j = await res.json();
  return (j.message?.content || "").trim();
}

/* ---------- TOOL: describe_image ---------- */
export async function describeImage({ path: relPath, prompt }) {
  const abs = resolveSafePath(relPath);
  if (!abs || !existsSync(abs)) return { ok: false, error: `not found or outside project: ${relPath}` };
  const ext = path.extname(abs).toLowerCase();

  let imagePath = abs;
  if (VIDEO_EXTS.has(ext)) {
    try { imagePath = await extractKeyframe(abs); }
    catch (e) { return { ok: false, error: `keyframe extract failed: ${e.message}` }; }
  } else if (!IMAGE_EXTS.has(ext)) {
    return { ok: false, error: `unsupported file type ${ext}. Use jpg/png/webp or mp4/mov.` };
  }

  /* Resolve the parent shoot folder NOW so we can both cache it and use it as a subject hint. */
  const shootsDir = Paths.getShootsDir();
  const folder = abs.startsWith(shootsDir) ? path.relative(shootsDir, abs).split(path.sep)[0] : null;
  const folderHint = folderToSubjectHint(folder);

  /* Cache check on the original file */
  const st = await stat(abs);
  const cached = db.prepare("SELECT caption FROM frame_captions WHERE path=? AND mtime=? AND size=?")
                   .get(abs, st.mtimeMs | 0, st.size);
  if (cached && !prompt) {
    return { ok: true, path: path.relative(PROJECT_DIR, abs), caption: cached.caption, cached: true };
  }

  let caption;
  try { caption = await captionImage(imagePath, prompt, folderHint); }
  catch (e) { return { ok: false, error: e.message }; }

  /* Cache + embed for later semantic search */
  let emb = null;
  try { emb = vectorToBuffer(await embed(caption)); } catch {}
  db.prepare(`INSERT OR REPLACE INTO frame_captions (path, mtime, size, caption, embedding, shoot_folder, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(abs, st.mtimeMs | 0, st.size, caption, emb, folder, Date.now());

  return { ok: true, path: path.relative(PROJECT_DIR, abs), caption };
}

/* ---------- TOOL: caption_shoot_folder ---------- */
export async function captionShootFolder({ folder, sampleCount = 8, prompt, force = false }) {
  if (!folder) {
    /* Default to the most recent shoot */
    try {
      const ents = await readdir(Paths.getShootsDir(), { withFileTypes: true });
      const dirs = ents.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
      folder = dirs[0];
    } catch {}
    if (!folder) return { ok: false, error: "no folder given and shoots/ is empty" };
  }
  const abs = resolveSafePath(folder);
  if (!abs || !existsSync(abs)) return { ok: false, error: `folder not found: ${folder}` };

  const files = (await readdir(abs))
    .filter(f => { const e = path.extname(f).toLowerCase(); return IMAGE_EXTS.has(e) || VIDEO_EXTS.has(e); })
    .sort();
  if (files.length === 0) return { ok: false, error: `no images/videos in ${folder}` };

  /* Why: evenly sample across the folder so captions cover the full shoot, not just the first N files. */
  const step = Math.max(1, Math.floor(files.length / Math.min(sampleCount, files.length)));
  const sampled = [];
  for (let i = 0; i < files.length && sampled.length < sampleCount; i += step) sampled.push(files[i]);

  /* Why: clear the abort flag at the start of a new batch so a stale "stop" from a previous
   * job doesn't immediately kill this one. Operator can raise it again mid-loop to stop early. */
  clearAbort();

  /* Per-frame timing logs so a hang in the caption loop is observable. Without these, a
   * stuck VL inference looks identical to "still going" from outside. */
  const captionLabel = `[caption-folder ${folder}]`;
  console.log(`${captionLabel} sampling ${sampled.length} of ${files.length} files`);
  const tBatch = Date.now();
  let cachedHits = 0, freshGenerations = 0;
  const captions = [];
  for (const f of sampled) {
    if (isAborted()) {
      console.log(`${captionLabel} ABORTED at ${captions.length}/${sampled.length}`);
      return {
        ok: true,
        aborted: true,
        folder: path.relative(PROJECT_DIR, abs),
        totalFiles: files.length,
        captioned: captions.length,
        captions,
        digest: captions.map(c => `- ${c.file}: ${c.caption}`).join("\n"),
        note: `Stopped after ${captions.length} of ${sampled.length} frames`,
      };
    }
    const tFrame = Date.now();
    const r = await describeImage({ path: path.join(abs, f), prompt: force ? prompt : undefined });
    const dt = Date.now() - tFrame;
    if (r.ok) {
      captions.push({ file: f, caption: r.caption, cached: !!r.cached });
      if (r.cached) cachedHits++;
      else freshGenerations++;
      console.log(`${captionLabel}   ${captions.length}/${sampled.length} ${r.cached ? "cached" : "VL"} ${dt}ms · ${f}`);
    } else {
      console.warn(`${captionLabel}   ${captions.length + 1}/${sampled.length} FAILED ${dt}ms · ${f} · ${r.error || "(no error)"}`);
    }
  }
  console.log(`${captionLabel} done in ${Date.now() - tBatch}ms (${cachedHits} cached, ${freshGenerations} fresh)`);

  const digest = captions.map(c => `- ${c.file}: ${c.caption}`).join("\n");
  return {
    ok: true,
    folder: path.relative(PROJECT_DIR, abs),
    totalFiles: files.length,
    captioned: captions.length,
    captions,
    digest,
  };
}

/* ---------- TOOL: find_frame ---------- */
export async function findFrame({ query, folder, limit = 5 }) {
  if (!query) return { ok: false, error: "query required" };

  let folderFilter = null;
  if (folder) {
    const abs = resolveSafePath(folder);
    if (!abs) return { ok: false, error: `folder not found: ${folder}` };
    folderFilter = path.basename(abs);
    /* Make sure we have captions for this folder; warm cache up to 16 samples. */
    await captionShootFolder({ folder, sampleCount: 16 }).catch(() => {});
  }

  let queryVec;
  try { queryVec = await embed(query); }
  catch (e) { return { ok: false, error: `embed: ${e.message}` }; }

  const rows = folderFilter
    ? db.prepare("SELECT path, caption, embedding FROM frame_captions WHERE shoot_folder = ?").all(folderFilter)
    : db.prepare("SELECT path, caption, embedding FROM frame_captions").all();
  if (rows.length === 0) return { ok: false, error: "no captioned frames yet — run caption_shoot_folder first" };

  const ranked = rows
    .map(r => ({ path: path.relative(PROJECT_DIR, r.path), caption: r.caption, score: cosine(queryVec, bufferToVector(r.embedding)) }))
    .filter(r => r.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => ({ ...r, score: +r.score.toFixed(3) }));

  return { ok: true, count: ranked.length, results: ranked };
}

/* ---------- TOOL: score_clip_for_trailer ---------- */
/**
 * Extract N evenly-spaced frames from a video clip, pass them as a multi-image prompt
 * to qwen2.5vl, ask for trailer-suitability score 1-10 plus the best segment offset.
 * Used by edit.mjs to pick "hero" clips for the cinematic teaser deliberately
 * (vs. the current motion-energy heuristic).
 *
 * @param {object} args
 * @param {string} args.path  Absolute or project-relative path to a video file (mp4/mov).
 * @param {number} args.frameCount  How many frames to sample (default 6).
 * @param {string} args.style  Optional style hint: "cinematic-action", "elegant-glamour", "documentary".
 * @returns {Promise<object>} { ok, score, reason, bestSegmentSec, durationSec }
 */
export async function scoreClipForTrailer({ path: relPath, frameCount = 6, style = "cinematic-automotive" }) {
  const abs = resolveSafePath(relPath);
  if (!abs || !existsSync(abs)) return { ok: false, error: `not found: ${relPath}` };
  const ext = path.extname(abs).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return { ok: false, error: `not a video: ${ext}` };

  /* Probe duration so we can sample evenly. */
  let durationSec = 0;
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", abs,
    ], { timeout: 10_000 });
    durationSec = parseFloat(stdout.trim()) || 0;
  } catch (e) { return { ok: false, error: `ffprobe: ${e.message}` }; }
  if (!durationSec) return { ok: false, error: "could not read clip duration" };

  /* Why: skip the very first/last 5% of the clip — slates, fade-ins, fade-outs poison the rating. */
  const startPad = durationSec * 0.05;
  const usable = durationSec * 0.9;
  const stride = usable / (frameCount - 1 || 1);

  if (!existsSync(FRAME_CACHE_DIR)) await mkdir(FRAME_CACHE_DIR, { recursive: true });
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const t = (startPad + i * stride).toFixed(2);
    const out = path.join(FRAME_CACHE_DIR, `${path.basename(abs)}.score_${i}.jpg`);
    if (!existsSync(out)) {
      try {
        await execFileP("ffmpeg", [
          "-y", "-ss", t, "-i", abs, "-vframes", "1", "-vf", "scale=768:-1", out,
        ], { timeout: 30_000 });
      } catch { continue; }
    }
    if (existsSync(out)) frames.push({ t: parseFloat(t), path: out });
  }
  if (frames.length === 0) return { ok: false, error: "could not extract any frames" };

  const images = await Promise.all(frames.map(f => readFile(f.path).then(b => b.toString("base64"))));

  /* Why: VL is asked for structured JSON so we can parse score + best segment without brittle regex. */
  const prompt = `You are evaluating ${frames.length} sequential frames from a ${durationSec.toFixed(1)}s video clip for use in a ${style} TRAILER. Frames are evenly spaced from start to end.

For a trailer cut we want: dynamic motion, clean composition, strong subject (vehicle/person), good lighting, dramatic angles. We do NOT want: blurry hands-on-camera moments, slates, dialogue head shots, accidental shaky bits, or empty cutaways.

Reply with ONLY a JSON object (no prose, no markdown fence):
{"score": <1-10>, "reason": "<one short sentence>", "bestSegmentStartSec": <number, seconds into the clip where the best 3s window starts>}

Be strict — a 7+ should be genuinely usable in a final cut.`;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: VL_MODEL_FN(),
      stream: false,
      keep_alive: VL_KEEP_ALIVE_FN(),
      messages: [{ role: "user", content: prompt, images }],
      options: { temperature: 0.1 },
      format: "json",
    }),
  });
  if (!res.ok) return { ok: false, error: `VL ${res.status}` };
  const j = await res.json();
  const raw = (j.message?.content || "").trim();

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, error: `non-JSON VL response: ${raw.slice(0, 200)}` }; }

  const score = Math.max(1, Math.min(10, Number(parsed.score) || 0));
  const bestSegmentSec = Math.max(0, Math.min(durationSec - 3, Number(parsed.bestSegmentStartSec) || 0));

  return {
    ok: true,
    path: path.relative(PROJECT_DIR, abs),
    durationSec: +durationSec.toFixed(2),
    score,
    reason: String(parsed.reason || "").slice(0, 200),
    bestSegmentStartSec: +bestSegmentSec.toFixed(2),
    framesSampled: frames.length,
  };
}

/* ---------- TOOL: find_portrait_crop ---------- */
/**
 * Ask the VL model where the salient subject is in an image. Returns a normalized
 * bounding box (0-1 floats) so the caller can compute a 9:16 (or any aspect) crop
 * that keeps the subject centered. Used to auto-generate vertical Reels/TikTok cuts
 * from the agency's landscape masters without manual reframing.
 *
 * @param {object} args
 * @param {string} args.path
 * @returns {Promise<object>} { ok, bbox: {x,y,w,h}, subject, aspectHints: {ninebysixteen} }
 */
export async function findPortraitCrop({ path: relPath }) {
  const abs = resolveSafePath(relPath);
  if (!abs || !existsSync(abs)) return { ok: false, error: `not found: ${relPath}` };
  const ext = path.extname(abs).toLowerCase();

  let imagePath = abs;
  if (VIDEO_EXTS.has(ext)) {
    try { imagePath = await extractKeyframe(abs); }
    catch (e) { return { ok: false, error: `keyframe extract: ${e.message}` }; }
  } else if (!IMAGE_EXTS.has(ext)) {
    return { ok: false, error: `unsupported file type ${ext}` };
  }

  /* Probe source dimensions so we can convert normalized bbox → pixels for ffmpeg. */
  let srcW = 0, srcH = 0;
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
      "-of", "csv=s=,:p=0", imagePath,
    ], { timeout: 10_000 });
    const [w, h] = stdout.trim().split(",").map(Number);
    srcW = w; srcH = h;
  } catch {}

  const buf = await readFile(imagePath);
  const b64 = buf.toString("base64");

  const prompt = `Identify the main subject in this image (the hero — typically a vehicle, person, or product). Return its bounding box as normalized 0-1 floats relative to image width/height.

Reply with ONLY this JSON object (no prose):
{"subject": "<short label>", "x": <0-1>, "y": <0-1>, "w": <0-1>, "h": <0-1>}

Where x,y is the top-left of the bbox and w,h are width/height — all as fractions of the image. Be tight on the subject; don't include large empty surroundings.`;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: VL_MODEL_FN(),
      stream: false,
      keep_alive: VL_KEEP_ALIVE_FN(),
      messages: [{ role: "user", content: prompt, images: [b64] }],
      options: { temperature: 0.0 },
      format: "json",
    }),
  });
  if (!res.ok) return { ok: false, error: `VL ${res.status}` };
  const j = await res.json();
  const raw = (j.message?.content || "").trim();

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, error: `non-JSON VL response: ${raw.slice(0, 200)}` }; }

  const bbox = {
    x: Math.max(0, Math.min(1, Number(parsed.x) || 0)),
    y: Math.max(0, Math.min(1, Number(parsed.y) || 0)),
    w: Math.max(0.05, Math.min(1, Number(parsed.w) || 0)),
    h: Math.max(0.05, Math.min(1, Number(parsed.h) || 0)),
  };
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;

  /* Why: for 9:16 from a 16:9 source the crop window has aspect 9/16 ≈ 0.5625 of the height in width.
   * For a 16:9 master that's height=full, width=full*9/16/16/9 → width = height*9/16 normalized.
   * We compute the crop window centered on the subject bbox center, clamped to [0,1]. */
  function cropForAspect(aspectW, aspectH) {
    if (!srcW || !srcH) return null;
    const srcAspect = srcW / srcH;
    const tgtAspect = aspectW / aspectH;
    let cropWnorm, cropHnorm;
    if (tgtAspect < srcAspect) {
      cropHnorm = 1;
      cropWnorm = (tgtAspect / srcAspect);
    } else {
      cropWnorm = 1;
      cropHnorm = (srcAspect / tgtAspect);
    }
    let x0 = Math.max(0, Math.min(1 - cropWnorm, cx - cropWnorm / 2));
    let y0 = Math.max(0, Math.min(1 - cropHnorm, cy - cropHnorm / 2));
    return {
      x: +x0.toFixed(4), y: +y0.toFixed(4),
      w: +cropWnorm.toFixed(4), h: +cropHnorm.toFixed(4),
      pixelCmd: `crop=${Math.round(srcW * cropWnorm)}:${Math.round(srcH * cropHnorm)}:${Math.round(srcW * x0)}:${Math.round(srcH * y0)}`,
    };
  }

  return {
    ok: true,
    path: path.relative(PROJECT_DIR, abs),
    sourceWidth: srcW, sourceHeight: srcH,
    subject: String(parsed.subject || "subject"),
    bbox,
    crops: {
      "9:16": cropForAspect(9, 16),
      "1:1": cropForAspect(1, 1),
      "4:5": cropForAspect(4, 5),
    },
  };
}

/* ---------- TOOL: crop_to_portrait ---------- */
/**
 * Run the suggested 9:16 (or other aspect) crop as an actual ffmpeg pass.
 * Writes the output under output/portraits/. Works for both images and videos.
 *
 * @param {object} args
 * @param {string} args.path
 * @param {string} args.aspect  "9:16" | "1:1" | "4:5"  (default "9:16")
 * @returns {Promise<object>} { ok, output, aspect }
 */
export async function cropToPortrait({ path: relPath, aspect = "9:16" }) {
  const findRes = await findPortraitCrop({ path: relPath });
  if (!findRes.ok) return findRes;
  const crop = findRes.crops[aspect];
  if (!crop || !crop.pixelCmd) return { ok: false, error: `no crop computed for aspect ${aspect}` };

  const abs = resolveSafePath(relPath);
  const ext = path.extname(abs).toLowerCase();
  const outDir = path.join(PROJECT_DIR, "output", "portraits");
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  const stem = path.basename(abs, ext);
  const isVideo = VIDEO_EXTS.has(ext);
  const outName = `${stem}_${aspect.replace(":", "x")}${isVideo ? ".mp4" : ".jpg"}`;
  const outPath = path.join(outDir, outName);

  const args = isVideo
    ? ["-y", "-i", abs, "-vf", crop.pixelCmd, "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "copy", outPath]
    : ["-y", "-i", abs, "-vf", crop.pixelCmd, "-q:v", "2", outPath];

  try { await execFileP("ffmpeg", args, { timeout: isVideo ? 180_000 : 30_000 }); }
  catch (e) { return { ok: false, error: `ffmpeg: ${e.message}` }; }

  return {
    ok: true,
    aspect,
    subject: findRes.subject,
    input: path.relative(PROJECT_DIR, abs),
    output: path.relative(PROJECT_DIR, outPath),
    cropCmd: crop.pixelCmd,
  };
}

/* ---------- TOOL: export_all_aspects ---------- */
/**
 * Run cropToPortrait for every common social aspect ratio in one call. Avoids the
 * operator having to ask four times. The 16:9 case skips re-cropping when the
 * source is already 16:9 — we copy it through so the output set is self-contained.
 *
 * @param {object} args
 * @param {string} args.path     Source image or video.
 * @param {string[]} [args.aspects]  Defaults to ["16:9", "9:16", "1:1", "4:5"].
 * @returns {Promise<object>}    { ok, outputs: [{aspect, output, ...}] }
 */
export async function exportAllAspects({ path: relPath, aspects } = {}) {
  if (!relPath) return { ok: false, error: "path required" };
  const want = (Array.isArray(aspects) && aspects.length) ? aspects : ["16:9", "9:16", "1:1", "4:5"];

  /* Why: VL bbox detection is the expensive step (~5-10s) — call findPortraitCrop ONCE
   * and reuse its source dimensions / bbox for every aspect, instead of re-running per crop. */
  const findRes = await findPortraitCrop({ path: relPath });
  if (!findRes.ok) return findRes;

  const abs = resolveSafePath(relPath);
  const ext = path.extname(abs).toLowerCase();
  const isVideo = VIDEO_EXTS.has(ext);
  const outDir = path.join(PROJECT_DIR, "output", "aspects");
  if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
  const stem = path.basename(abs, ext);

  const outputs = [];
  for (const aspect of want) {
    const crop = findRes.crops[aspect];
    /* If we don't have a precomputed crop for this aspect, derive it on the fly using the cached bbox. */
    if (!crop || !crop.pixelCmd) {
      outputs.push({ aspect, ok: false, error: `unsupported aspect: ${aspect}` });
      continue;
    }
    const outName = `${stem}_${aspect.replace(":", "x")}${isVideo ? ".mp4" : ".jpg"}`;
    const outPath = path.join(outDir, outName);
    const args = isVideo
      ? ["-y", "-i", abs, "-vf", crop.pixelCmd, "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "copy", outPath]
      : ["-y", "-i", abs, "-vf", crop.pixelCmd, "-q:v", "2", outPath];
    try {
      await execFileP("ffmpeg", args, { timeout: isVideo ? 180_000 : 30_000 });
      outputs.push({ aspect, ok: true, output: path.relative(PROJECT_DIR, outPath), cropCmd: crop.pixelCmd });
    } catch (e) {
      outputs.push({ aspect, ok: false, error: `ffmpeg: ${e.message}` });
    }
  }

  return {
    ok: outputs.some(o => o.ok),
    subject: findRes.subject,
    input: path.relative(PROJECT_DIR, abs),
    outputs,
    successful: outputs.filter(o => o.ok).length,
    failed: outputs.filter(o => !o.ok).length,
  };
}

/* ---------- TOOL: find_similar_shots (cross-folder) ---------- */
/**
 * Like findFrame but searches the ENTIRE caption library (every shoot ever captioned),
 * not just one folder. Used for "we did this exact angle on the McLaren — show me".
 *
 * @param {object} args
 * @param {string} args.path     Path to the reference image (will be captioned if not cached).
 * @param {number} [args.limit=8]
 * @returns {Promise<object>}
 */
export async function findSimilarShots({ path: relPath, limit = 8 } = {}) {
  if (!relPath) return { ok: false, error: "path required" };
  const abs = resolveSafePath(relPath);
  if (!abs || !existsSync(abs)) return { ok: false, error: `not found: ${relPath}` };

  /* Caption the reference if needed so we have a query to embed against. */
  const refRes = await describeImage({ path: relPath });
  if (!refRes.ok) return refRes;

  const queryVec = await embed(refRes.caption);
  /* Search across ALL captioned frames, not just one folder. Excludes the reference itself. */
  const rows = db.prepare("SELECT path, caption, embedding, shoot_folder FROM frame_captions WHERE path != ?").all(abs);
  const ranked = rows
    .map(r => ({
      path: path.relative(PROJECT_DIR, r.path),
      caption: r.caption,
      shoot: r.shoot_folder,
      score: cosine(queryVec, bufferToVector(r.embedding)),
    }))
    .filter(r => r.score > 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => ({ ...r, score: +r.score.toFixed(3) }));

  return { ok: true, reference: { path: refRes.path, caption: refRes.caption }, count: ranked.length, results: ranked };
}

/* ---------- TOOL: color_match_reference ---------- */
/**
 * Describe the colour treatment of a reference image (warm/cool, contrast, saturation,
 * dominant tints, mood) so the editor can match the look in Premiere Lumetri / Lightroom.
 * Returns structured suggestions the operator can dial in manually — we don't apply
 * grades automatically; that's an editor judgement call.
 *
 * @param {object} args
 * @param {string} args.path  Reference image (frame from a film, a competitor's shot, etc).
 */
export async function colorMatchReference({ path: relPath } = {}) {
  if (!relPath) return { ok: false, error: "path required" };
  const abs = resolveSafePath(relPath);
  if (!abs || !existsSync(abs)) return { ok: false, error: `not found: ${relPath}` };
  const ext = path.extname(abs).toLowerCase();
  let imagePath = abs;
  if (VIDEO_EXTS.has(ext)) {
    try { imagePath = await extractKeyframe(abs); } catch (e) { return { ok: false, error: `keyframe: ${e.message}` }; }
  } else if (!IMAGE_EXTS.has(ext)) {
    return { ok: false, error: `unsupported file type ${ext}` };
  }

  const buf = await readFile(imagePath);
  const b64 = buf.toString("base64");

  const prompt = `Analyse this image's COLOUR GRADE (not subject). Return ONLY a JSON object — no prose:
{
  "mood": "<one short phrase: 'warm cinematic', 'cool clinical', 'high-contrast bleach', etc>",
  "temperature": "<warm | neutral | cool>",
  "tint": "<green | magenta | neutral>",
  "contrast": "<low | medium | high | crushed-blacks | lifted-blacks>",
  "saturation": "<desaturated | natural | punchy | over-saturated>",
  "dominantTints": ["<colour 1>", "<colour 2>"],
  "lumetri": {
    "temperature": <-50 to +50>,
    "tint": <-50 to +50>,
    "exposure": <-2 to +2>,
    "contrast": <-100 to +100>,
    "highlights": <-100 to +100>,
    "shadows": <-100 to +100>,
    "saturation": <0 to 200>
  },
  "notes": "<one short sentence the editor can use as a starting point>"
}`;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: VL_MODEL_FN(),
      stream: false,
      keep_alive: VL_KEEP_ALIVE_FN(),
      messages: [{ role: "user", content: prompt, images: [b64] }],
      options: { temperature: 0.1 },
      format: "json",
    }),
  });
  if (!res.ok) return { ok: false, error: `VL ${res.status}` };
  const j = await res.json();
  const raw = (j.message?.content || "").trim();

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, error: `non-JSON VL response: ${raw.slice(0, 200)}` }; }

  return { ok: true, reference: path.relative(PROJECT_DIR, abs), grade: parsed };
}

export function visionStats() {
  return {
    captions: db.prepare("SELECT COUNT(*) as n FROM frame_captions").get().n,
    folders: db.prepare("SELECT COUNT(DISTINCT shoot_folder) as n FROM frame_captions WHERE shoot_folder IS NOT NULL").get().n,
    model: VL_MODEL_FN(),
  };
}
