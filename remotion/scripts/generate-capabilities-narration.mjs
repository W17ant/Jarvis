#!/usr/bin/env node
/** generate-capabilities-narration.mjs — narrate the deep-dive capabilities video.
 *
 *  10 scenes covering the full surface of what Flat-Out can do. Each scene's
 *  text is written for ear-friendly delivery: numbers spelled out, no markdown,
 *  brief and concrete. */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SCENES = [
  { id: 'c_title',  text: "Flat-Out can do a lot. Here's the tour." },
  { id: 'c_voice',  text: "Wake it with hey flat-out. Local Whisper transcribes, Qwen 2.5 thinks, Kokoro speaks. Sentence-level streaming gets the first reply in your ear in about a second. Saying stop cuts it off mid-sentence." },
  { id: 'c_vision', text: "Drop a shoot folder, ask what's in the latest shoot. Flat-Out captions every keyframe, identifies the make and model, calls out angle and lighting. Search by description — find the front-grille hero on the Vulcan." },
  { id: 'c_edit',   text: "Voice-driven cinematic edits. Cut a 30-second teaser of yesterday's Aston shoot, vertical, closing card V-twelve beast. Flat-Out scans, plans cuts, beat-syncs to a music track, applies your brand tail-card, and lands a finished MP4." },
  { id: 'c_brand',  text: "One command exports a full brand pack. Sixteen-by-nine, nine-by-sixteen, one-by-one, four-by-five. Watermarked and clean variants. Zipped, ready for the client." },
  { id: 'c_comms',  text: "Frame.io review and comment by voice — read me the comments on Vulcan v3, reply on it at twenty-three seconds. Mail and Calendar through AppleScript — summarise my unread, draft a reply to the press office, add Goodwood to the diary. Drafts open for approval, never auto-sent." },
  { id: 'c_nle',    text: "Drives Adobe Premiere Pro directly — import yesterday's shoot, build a rough cut sequence. Lightroom presets without opening Lightroom — apply the FOM Aston grade to the Vulcan folder, writing XMP sidecars in seconds." },
  { id: 'c_memory', text: "Persistent memory. Contacts, projects, facts, conversation summaries — all stored locally in SQLite. Never re-explain who Sarah at the press office is. Capture the FOM look from a folder of finished edits, then compare a new grade against the saved style. Cool by 0.04, raise contrast by 0.03." },
  { id: 'c_studio', text: "On location, the photographer's phone becomes a hands-free flag-and-caption mic. Tap hero mid-frame, say reshoot between shots — the editor at the desk sees the flags land in real time. Pre-shoot kit checklist pulls live weather. The media-day calendar tracks every press event." },
  { id: 'c_outro',  text: "Seventy-six tools, all exposed through the Model Context Protocol. Claude Desktop, Cursor, Continue — drive the same kiosk from anywhere. Flat-Out. Built for the agency that lives and breathes automotive." },
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

function wavSeconds(buf) {
  let offset = 12, sampleRate = 0, channels = 0, bps = 0, dataSize = 0;
  while (offset < buf.length - 8) {
    const id = buf.slice(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(offset + 10); sampleRate = buf.readUInt32LE(offset + 12); bps = buf.readUInt16LE(offset + 22); }
    else if (id === 'data') { dataSize = size; break; }
    offset += 8 + size + (size & 1);
  }
  return dataSize / (sampleRate * channels * (bps / 8));
}

if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

const manifest = [];
for (const scene of SCENES) {
  process.stdout.write(`▶ ${scene.id.padEnd(10)} `);
  const t0 = Date.now();
  try {
    const buf = await synthesise(scene.text);
    const dest = path.join(OUT_DIR, `${scene.id}.wav`);
    await writeFile(dest, buf);
    const seconds = wavSeconds(buf);
    const frames = Math.ceil(seconds * 30);
    manifest.push({ id: scene.id, text: scene.text, file: `audio/${scene.id}.wav`, seconds, frames });
    console.log(`  ${seconds.toFixed(2)}s · ${frames}f · ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }
}

await writeFile(path.join(OUT_DIR, "capabilities-manifest.json"), JSON.stringify(manifest, null, 2));
const total = manifest.reduce((a, b) => a + b.frames, 0);
console.log(`\n✓ ${manifest.length}/${SCENES.length} scenes · runtime ${(total / 30).toFixed(1)}s`);
