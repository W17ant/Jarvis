/** transcribe.mjs - Video → text + visual description orchestrator.
 *
 *  Three composable pieces, each already in the Jarvis stack:
 *    - ffmpeg (Homebrew dep) extracts audio to 16kHz mono WAV
 *    - Whisper server (:8768) transcribes with per-segment timestamps
 *    - Vision LLM via llm/providers.mjs captions sampled keyframes
 *
 *  Output is a single structured object the LLM can speak summaries from
 *  OR the operator can save as a sidecar JSON next to the source video.
 *
 *  Why orchestrate locally rather than send the whole video to a cloud
 *  vision model: Gemini natively ingests video but it's a paid API and the
 *  full clip leaves the box. Local Whisper + frame-sampled vision keeps
 *  the same shape (timestamped speech + scene descriptions) at zero cloud
 *  cost when LLM_PROVIDER_VISION is ollama. Operator can flip to Anthropic
 *  for richer captions; the structure doesn't change.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import { chat, pickProvider } from "./llm/providers.mjs";

const execFile = promisify(_execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const WORK_DIR = path.resolve(PROJECT_DIR, "data", "transcribe-work");
const WHISPER_URL = process.env.WHISPER_URL || "http://localhost:8768";

const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"]);

/** Resolve a path relative to PROJECT_DIR if relative, otherwise treat as
 *  absolute. Then verify it exists + has a video extension. Returns the
 *  resolved absolute path or null on rejection. */
async function resolveVideoPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(PROJECT_DIR, raw);
  try { await fsp.access(abs); } catch { return null; }
  const ext = path.extname(abs).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return null;
  return abs;
}

/** Extract audio to a 16kHz mono WAV — Whisper's preferred input format.
 *  ffmpeg's `-ar 16000 -ac 1 -c:a pcm_s16le` matches what the mic loop sends
 *  so we exercise the same Whisper code path. */
async function extractAudio(videoPath) {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const out = path.join(WORK_DIR, `audio-${Date.now()}.wav`);
  await execFile("ffmpeg", [
    "-loglevel", "error",
    "-i", videoPath,
    "-vn",                      // strip video
    "-ar", "16000", "-ac", "1", // 16k mono
    "-c:a", "pcm_s16le",        // 16-bit PCM
    "-y", out,
  ], { timeout: 5 * 60_000 });
  return out;
}

/** Sample N keyframes evenly across the video. Uses the thumbnail filter
 *  for visual diversity; falls back to fps-based sampling if the keyframe
 *  pass returns nothing (very short clips). Returns absolute paths. */
async function sampleFrames(videoPath, count = 8) {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const stem = `frames-${Date.now()}`;
  const outPattern = path.join(WORK_DIR, `${stem}-%02d.png`);
  try {
    await execFile("ffmpeg", [
      "-loglevel", "error",
      "-i", videoPath,
      "-vf", `select='eq(pict_type,I)',thumbnail=${count}`,
      "-frames:v", String(count),
      "-vsync", "vfr",
      "-y", outPattern,
    ], { timeout: 90_000 });
  } catch {
    /* Fallback: uniform fps. Total duration / count gives the interval. */
    await execFile("ffmpeg", [
      "-loglevel", "error",
      "-i", videoPath,
      "-vf", `fps=1/3`,
      "-frames:v", String(count),
      "-y", outPattern,
    ], { timeout: 90_000 }).catch(() => {});
  }
  const dir = await fsp.readdir(WORK_DIR);
  return dir.filter((f) => f.startsWith(stem) && f.endsWith(".png"))
            .map((f) => path.join(WORK_DIR, f))
            .sort();
}

/** Caption a single frame via the configured vision provider. Compact prompt
 *  to keep token costs low — we want one short paragraph per frame, not an
 *  essay. The frame is sent base64 inside a content array; Anthropic and
 *  OpenAI both accept this shape via the providers adapter. */
async function captionFrame(framePath) {
  const bytes = await fsp.readFile(framePath);
  const ext = path.extname(framePath).slice(1).toLowerCase();
  const mediaType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  const r = await chat({
    workload: "vision",
    messages: [
      { role: "system", content: "You describe a single video keyframe in 1-2 sentences for a transcript log. Note: subjects in frame, action implied, setting, lighting/time-of-day. No flowery language." },
      { role: "user", content: [
        { type: "text", text: "Describe this frame:" },
        { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } },
      ]},
    ],
    maxTokens: 180,
  });
  return (r.text || "").trim();
}

/** Read audio bytes + POST to Whisper with ?segments=1 so we get timestamps. */
async function whisperSegments(audioPath) {
  const data = await fsp.readFile(audioPath);
  const r = await fetch(`${WHISPER_URL}/transcribe?segments=1`, {
    method: "POST",
    headers: { "content-type": "audio/wav", "content-length": String(data.length) },
    body: data,
  });
  if (!r.ok) throw new Error(`Whisper returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

/**
 * Transcribe a video file end-to-end. Returns timestamped speech segments
 * + (optional) frame-by-frame visual descriptions, plus a single combined
 * narrative the LLM can read aloud.
 *
 * @param {object} args
 * @param {string} args.path             Filesystem path (absolute or PROJECT_DIR-relative)
 * @param {boolean}[args.includeVisual=true]  Sample frames + caption them
 * @param {number} [args.sampleFrames=8]      Frames to caption when includeVisual
 * @param {boolean}[args.cleanup=true]   Delete the temp WAV + frame PNGs after
 */
export async function transcribeVideo({ path: input, includeVisual = true, sampleFrames: frameCount = 8, cleanup = true } = {}) {
  const t0 = Date.now();
  const videoPath = await resolveVideoPath(input);
  if (!videoPath) return { ok: false, error: `Could not resolve "${input}" — must be an existing video file (mp4/mov/m4v/mkv/avi/webm).` };

  const tempPaths = [];
  try {
    /* Step 1: audio → Whisper. ffmpeg + Whisper run sequentially because
     * Whisper holds a lock; parallelising buys nothing on a single-stream
     * model and risks burning RAM on long videos. */
    let audioPath;
    try { audioPath = await extractAudio(videoPath); }
    catch (e) { return { ok: false, error: `ffmpeg audio extract failed: ${e.message}. Is ffmpeg installed?` }; }
    tempPaths.push(audioPath);

    let speech;
    try { speech = await whisperSegments(audioPath); }
    catch (e) { return { ok: false, error: `Whisper transcription failed: ${e.message}. Is the Whisper server running on ${WHISPER_URL}?` }; }

    /* Step 2: frame sampling + visual captions. Skipped if includeVisual=false
     * OR if no vision provider has a key set (would silently fall back to
     * Ollama qwen2.5vl:7b, which works but produces less-detailed captions
     * than Claude). We still let it run on Ollama if that's all there is. */
    let frames = [];
    if (includeVisual) {
      try {
        const framePaths = await sampleFrames(videoPath, Math.max(1, Math.min(20, frameCount)));
        tempPaths.push(...framePaths);
        if (framePaths.length) {
          /* Caption frames concurrently — vision calls are I/O-bound on the
           * remote/local LLM. 4-way fan-out balances throughput and rate-limit
           * risk on cloud providers. */
          const concurrency = 4;
          const queue = framePaths.map((p, i) => ({ p, i }));
          const results = new Array(framePaths.length);
          async function worker() {
            while (queue.length) {
              const { p, i } = queue.shift();
              try { results[i] = { index: i, path: p, caption: await captionFrame(p) }; }
              catch (e) { results[i] = { index: i, path: p, caption: null, error: e.message }; }
            }
          }
          await Promise.all(Array.from({ length: concurrency }, worker));
          frames = results;
        }
      } catch (e) {
        /* Frame failure is non-fatal — return the speech transcript with a
         * note so the caller knows visual is missing rather than absent
         * because the video has no scenes worth describing. */
        frames = [];
        speech.frameError = e.message;
      }
    }

    /* Step 3: build a combined narrative — interleaves speech segments and
     * frame captions on a shared timeline. The vision provider (if any) can
     * then summarise this if the LLM asks for "what happened in the video". */
    const duration = Number(speech.duration) || 0;
    const narrative = buildNarrative(speech.segments || [], frames, duration);

    return {
      ok: true,
      videoPath,
      durationSec: duration,
      provider: pickProvider("vision"),
      speech: {
        text: speech.text,
        segments: speech.segments || [],
      },
      frames: frames.map((f) => ({
        index: f.index,
        approxTimeSec: duration && frames.length > 1 ? Math.round((f.index / (frames.length - 1)) * duration * 10) / 10 : 0,
        caption: f.caption,
        error: f.error || null,
      })),
      narrative,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    if (cleanup) {
      for (const p of tempPaths) {
        try { await fsp.unlink(p); } catch {}
      }
    }
  }
}

/** Build a single-string interleaved narrative — alternates speech and visual
 *  beats in timestamp order. Useful for a quick scan or as input to a
 *  summarisation LLM call. Format:
 *    [00:00] (visual) Bentley Bentayga from low-angle, golden-hour, shallow DOF.
 *    [00:02] (speech) Welcome to the press launch...
 */
function buildNarrative(segments, frames, duration) {
  const events = [];
  for (const s of segments) {
    events.push({ t: Number(s.start) || 0, kind: "speech", text: s.text });
  }
  /* Frames don't carry timestamps from ffmpeg's thumbnail filter — we
   * approximate by spacing them evenly across the duration. Fine for the
   * narrative; if precise timestamps matter, switch the frame extractor to
   * use `select='gte(scene\\,0.4)'` and parse out the keyframe times. */
  const frameStep = frames.length > 1 ? duration / (frames.length - 1) : 0;
  frames.forEach((f, i) => {
    if (!f.caption) return;
    events.push({ t: i * frameStep, kind: "visual", text: f.caption });
  });
  events.sort((a, b) => a.t - b.t);
  return events.map((e) => {
    const m = Math.floor(e.t / 60);
    const s = Math.floor(e.t % 60);
    const stamp = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `[${stamp}] (${e.kind}) ${e.text}`;
  }).join("\n");
}
