#!/usr/bin/env node
/** generate-narration.mjs — synthesise per-scene narration WAVs via Kokoro.
 *
 *  Why per-scene: Remotion's <Audio> component can stream a single long file with
 *  startFrom offsets, but per-scene WAVs let the composition's timing tweak without
 *  re-rendering the whole narration. Each scene also gets its own subtitle .srt
 *  block synced to its WAV — much easier than time-aligning a single 2.5-min track.
 *
 *  Calls Kokoro at localhost:8767 (the bridge proxies on the same port via /tts).
 *  Voice: bm_daniel — same as the kiosk's default. */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const SCENES = [
  { id: 'title',    text: "Flat-Out. The automotive AI kiosk built for your studio." },
  { id: 'hook',     text: "Imagine a kiosk that listens, sees, edits, and remembers — purpose-built for an automotive PR and content agency. Here's what Flat-Out can do, and how to install it on your M5 Max in under thirty minutes." },
  { id: 'voice',    text: "Say: hey Flat-Out, cut a thirty-second teaser of yesterday's Aston shoot. The kiosk picks up the wake phrase, transcribes locally, and starts rendering. Sentence-level streaming gets the first reply in your ear in about a second. Say stop and it'll cut you off mid-sentence." },
  { id: 'vision',   text: "Vision sees every shot. Caption the Vulcan folder, find the front-grille hero, score clips for the trailer cut. The local Qwen 2.5 vision model keeps your client work on your machine." },
  { id: 'edit',     text: "Voice-driven cinematic edits. Drop a shoot folder, ask for a teaser, and Flat-Out plans the cut points, applies your brand pack tail-card, beat-syncs to a music track, and lands a finished MP4 in your Downloads." },
  { id: 'brand',    text: "Hero shot ready? One command exports a full brand pack — sixteen-by-nine, nine-by-sixteen, one-by-one and four-by-five, watermarked and clean, zipped for the client. On location, the live shoot mode turns the photographer's phone into a hands-free flag-and-caption mic." },
  { id: 'memory',   text: "Persistent memory means you never re-explain who Sarah at the press office is, or what the FOM look means. Plus, Flat-Out exposes its tools through the Model Context Protocol, so Claude Desktop, Cursor and Continue can drive the same kiosk from anywhere." },
  { id: 'install',  text: "Installing takes a coffee. Open Terminal. Clone the repo. Run install dot sh — the script grabs Ollama, Whisper, Kokoro and Qwen for you. Run setup wizard — pick your hardware tier, your voice, and your shoots folder. Done. Run launch dot sh kiosk, and Flat-Out is live." },
  { id: 'outro',    text: "Flat-Out. Built for the agency that lives and breathes automotive. Ready when you are." },
];

const KOKORO_URL = "http://localhost:8767/tts";
const VOICE = "bm_daniel";
const OUT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "public", "audio");

async function synthesise(text) {
  const res = await fetch(KOKORO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice: VOICE }),
  });
  if (!res.ok) throw new Error(`kokoro ${res.status}: ${await res.text().catch(() => '')}`);
  return Buffer.from(await res.arrayBuffer());
}

/* WAV header parsing: read the 'data' chunk size + sample rate so we can compute
 * each scene's duration in frames. The composition reads a generated manifest
 * to know where to schedule each Audio component. */
function wavInfoFromBuffer(buf) {
  /* Standard PCM WAV layout: RIFF header (12 bytes), fmt chunk, then data chunk.
   * Sample rate at offset 24, channels at 22, bits-per-sample at 34, data size
   * at the 'data' subchunk's size field. We linear-scan to handle non-canonical
   * chunk ordering (some encoders put 'LIST' before 'data'). */
  let offset = 12;
  let sampleRate = 0, channels = 0, bitsPerSample = 0, dataSize = 0;
  while (offset < buf.length - 8) {
    const id = buf.slice(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size & 1);  /* chunks are 2-byte aligned */
  }
  if (!sampleRate || !channels || !bitsPerSample) {
    throw new Error("couldn't parse WAV header");
  }
  const bytesPerSample = bitsPerSample / 8;
  const seconds = dataSize / (sampleRate * channels * bytesPerSample);
  return { sampleRate, channels, bitsPerSample, seconds };
}

const manifest = [];
for (const scene of SCENES) {
  process.stdout.write(`▶ ${scene.id.padEnd(10)} `);
  const t0 = Date.now();
  try {
    const buf = await synthesise(scene.text);
    const dest = path.join(OUT_DIR, `${scene.id}.wav`);
    await writeFile(dest, buf);
    const info = wavInfoFromBuffer(buf);
    /* @30fps Remotion frame count = ceil(seconds * 30). Manifest records BOTH frame
     * count and seconds so the composition can do its own math if it wants. */
    const frames = Math.ceil(info.seconds * 30);
    manifest.push({ id: scene.id, text: scene.text, file: `audio/${scene.id}.wav`, seconds: info.seconds, frames });
    console.log(`  ${(info.seconds).toFixed(2)}s · ${frames}f · ${(buf.length / 1024).toFixed(0)}KB · ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
    manifest.push({ id: scene.id, text: scene.text, file: null, seconds: 0, frames: 0, error: e.message });
  }
}

await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
const totalFrames = manifest.reduce((a, b) => a + b.frames, 0);
console.log(`\n✓ wrote ${manifest.filter(m => m.file).length}/${SCENES.length} scenes`);
console.log(`  total runtime: ${(totalFrames / 30).toFixed(1)}s (${totalFrames} frames @ 30fps)`);
console.log(`  manifest: ${path.join(OUT_DIR, "manifest.json")}`);
