#!/usr/bin/env node
/** generate-tiktok-narration.mjs — punchy one-liners for the vertical social cut. */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SCENES = [
  { id: 't_hook',   text: "Your studio just got an AI." },
  { id: 't_voice',  text: "Wake it. Hey Flat-Out, cut a 30-second teaser." },
  { id: 't_vision', text: "It sees every shot. Captions every angle." },
  { id: 't_edit',   text: "Voice in. Cinematic edit out. Three minutes." },
  { id: 't_brand',  text: "One command. Every aspect. Zipped for the client." },
  { id: 't_memory', text: "Remembers your contacts, your projects, your look." },
  { id: 't_live',   text: "On set? Phone as mic. Flag the hero from the lens." },
  { id: 't_cta',    text: "Flat-Out. Built for automotive." },
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

await writeFile(path.join(OUT_DIR, "tiktok-manifest.json"), JSON.stringify(manifest, null, 2));
const total = manifest.reduce((a, b) => a + b.frames, 0);
console.log(`\n✓ ${manifest.length}/${SCENES.length} scenes · runtime ${(total / 30).toFixed(1)}s`);
