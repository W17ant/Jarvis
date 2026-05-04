#!/usr/bin/env node
/** generate-uninstall-narration.mjs — narrate the uninstall companion clip. */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SCENES = [
  { id: 'u_title',  text: "Need to uninstall? Just as simple." },
  { id: 'u_wizard', text: "Run the uninstall wizard from the project root. It walks through every artifact the install dropped — the launch agent, running services, Ollama models, project files. Conservative defaults protect anything that might be shared with other apps." },
  { id: 'u_done',   text: "When it's done, your Mac is exactly as you found it. Three commands to install. One to remove." },
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

/* WAV header parser — copied from the install narration script. We only care
 * about the data-chunk size and sample rate so we can convert to frames. */
function wavSeconds(buf) {
  let offset = 12;
  let sampleRate = 0, channels = 0, bps = 0, dataSize = 0;
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

await writeFile(path.join(OUT_DIR, "uninstall-manifest.json"), JSON.stringify(manifest, null, 2));
const total = manifest.reduce((a, b) => a + b.frames, 0);
console.log(`\n✓ ${manifest.length}/${SCENES.length} scenes · runtime ${(total / 30).toFixed(1)}s`);
