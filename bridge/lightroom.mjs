/** lightroom.mjs - Apply Lightroom develop presets to RAW files via XMP sidecar.
 *
 *  How: Lightroom presets are just XMP fragments describing develop settings (Exposure, Contrast,
 *  WhiteBalance, ToneCurve, etc). When Lightroom opens a RAW with a matching .xmp sidecar, it reads
 *  the develop settings from there. So if we drop the right XMP next to each RAW, the preset is
 *  effectively "applied" — works without Lightroom even running.
 *
 *  Tools:
 *    apply_lightroom_preset({ folder, preset })  - writes XMP sidecars for every RAW in folder
 *    list_lightroom_presets()                    - returns available preset names
 */

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PRESETS_DIR = path.join(PROJECT_DIR, "assets", "lightroom-presets");

const RAW_EXTS = new Set([
  ".cr2", ".cr3", ".nef", ".nrw", ".arw", ".srf", ".sr2", ".dng",
  ".raf", ".orf", ".rw2", ".rwl", ".pef", ".x3f", ".mrw", ".srw",
  ".jpg", ".jpeg", ".tif", ".tiff",   // also write XMP for processed files
]);

/** Discover available presets by scanning the presets directory for .xmp files. */
async function listPresetFiles() {
  if (!existsSync(PRESETS_DIR)) return [];
  const files = await readdir(PRESETS_DIR);
  return files.filter(f => f.toLowerCase().endsWith(".xmp"))
    .map(f => ({ name: path.parse(f).name, path: path.join(PRESETS_DIR, f) }));
}

export async function listLightroomPresets() {
  const presets = await listPresetFiles();
  return { ok: true, presets: presets.map(p => p.name) };
}

/** Apply a preset (named or path) to every RAW in the folder by writing XMP sidecars. */
export async function applyLightroomPreset({ folder, preset }) {
  if (!folder || !existsSync(folder)) throw new Error(`folder not found: ${folder}`);
  if (!preset) throw new Error("preset required");

  // Resolve the preset XMP source
  const presets = await listPresetFiles();
  let presetPath = null;
  if (existsSync(preset) && preset.toLowerCase().endsWith(".xmp")) {
    presetPath = preset;
  } else {
    const match = presets.find(p => p.name.toLowerCase() === preset.toLowerCase());
    if (!match) throw new Error(`preset not found: ${preset}. Available: ${presets.map(p => p.name).join(", ") || "(none — drop .xmp files into assets/lightroom-presets/)"}`);
    presetPath = match.path;
  }

  const presetXmp = await readFile(presetPath, "utf8");

  // Walk folder for RAW files
  const entries = await readdir(folder);
  const rawFiles = entries.filter(f => RAW_EXTS.has(path.extname(f).toLowerCase()));
  if (rawFiles.length === 0) {
    return { ok: true, applied: 0, message: "no RAW files in folder" };
  }

  /* Why: write a sidecar per RAW file. The XMP filename matches the RAW base name + ".xmp"
   * (e.g. IMG_1234.CR2 → IMG_1234.xmp). Lightroom will read this on import. */
  let applied = 0;
  const results = [];
  for (const f of rawFiles) {
    const base = path.parse(f).name;
    const xmpPath = path.join(folder, `${base}.xmp`);
    // Customise the XMP per file: Lightroom expects RawFileName + DocumentID etc.
    const customised = presetXmp.replace(/<crs:RawFileName>[^<]*<\/crs:RawFileName>/g, `<crs:RawFileName>${f}</crs:RawFileName>`);
    await writeFile(xmpPath, customised);
    applied++;
    results.push({ raw: f, xmp: path.basename(xmpPath) });
  }
  return { ok: true, applied, preset: path.parse(presetPath).name, folder, results: results.slice(0, 20) };
}
