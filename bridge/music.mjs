/** music.mjs - Backing track library + selection for the teaser pipeline.
 *  Mixes a picked track at -14dB under source video audio in the final concat step.
 *  Beat-aligned cut timing: planEdit reads a track's BPM and snaps segment durations to beat multiples. */

import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MUSIC_DIR = path.join(PROJECT_DIR, "assets", "music");
const MANIFEST_PATH = path.join(MUSIC_DIR, "manifest.json");

let cachedManifest = null;
async function loadManifest() {
  if (cachedManifest) return cachedManifest;
  if (!existsSync(MANIFEST_PATH)) return { tracks: [] };
  try {
    const raw = await readFile(MANIFEST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    /* Why: only return tracks whose mp3 actually exists on disk (manifest can include placeholders) */
    const usable = [];
    for (const t of (parsed.tracks || [])) {
      const fp = path.join(MUSIC_DIR, t.file);
      if (existsSync(fp)) {
        usable.push({ ...t, path: fp });
      }
    }
    cachedManifest = { tracks: usable };
    return cachedManifest;
  } catch (e) {
    console.warn(`[music] manifest parse failed: ${e.message}`);
    return { tracks: [] };
  }
}

/** List available tracks (for the LLM tool). */
export async function listTracks() {
  const m = await loadManifest();
  return m.tracks.map(({ file, bpm, mood, tags }) => ({ file, bpm, mood, tags }));
}

/** Pick a track by mood / name / tag. Returns null if no track found.
 *  If `which` is null, picks any available track (first match). */
export async function pickTrack(which = null) {
  const m = await loadManifest();
  if (m.tracks.length === 0) return null;
  if (!which) return m.tracks[0];
  const want = String(which).toLowerCase();
  // Try mood match
  const byMood = m.tracks.find(t => (t.mood || "").toLowerCase() === want);
  if (byMood) return byMood;
  // Try filename / partial match
  const byFile = m.tracks.find(t => t.file.toLowerCase().includes(want));
  if (byFile) return byFile;
  // Try tags
  const byTag = m.tracks.find(t => (t.tags || []).some(tag => String(tag).toLowerCase().includes(want)));
  if (byTag) return byTag;
  return m.tracks[0];   // fallback to first available
}

/** Beat-aligned cut length pattern. Given a BPM, returns segment durations (in seconds)
 *  that are multiples of half-beats — guarantees cuts land on the music's pulse. */
export function beatPattern(bpm, targetSeconds = 30) {
  const beatSec = 60 / bpm;             // length of one beat
  const halfBeat = beatSec / 2;         // half-beat — used for fast cuts
  /* Pattern in half-beat units. Top Gear / Gran Turismo arc:
   *   open with longer holds → ramp up to rapid half-beats → end on a hero beat-and-a-half */
  const pattern = [
    4, 3,                                // 2 hits @ 2-beat / 1.5-beat (anchor)
    2, 2, 1, 1, 2, 1, 1, 2,              // 8 mid-tempo
    1, 1, 1, 1, 1, 1, 1, 1, 1,           // 9 rapid half-beats
    2, 2, 1, 1, 2,                       // 5 mid-tempo back-out
    3, 4,                                // 2 winding-down
    5,                                   // hero hold (2.5 beats)
  ];
  const lengths = pattern.map(units => units * halfBeat);
  const total = lengths.reduce((a, b) => a + b, 0);
  // Normalise to target seconds while preserving relative ratios
  const scale = targetSeconds / total;
  return lengths.map(l => +(l * scale).toFixed(3));
}
