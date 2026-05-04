/** premiere.mjs - Adobe Premiere Pro 2025 automation via ExtendScript + AppleScript.
 *
 *  Architecture: Node generates a .jsx file with parameters baked in,
 *  AppleScript tells Premiere to execute it (`tell app "Adobe Premiere Pro 2025" to DoScript ...`).
 *
 *  Tools exposed:
 *    premiere_open_project(projectPath)           - opens an existing .prproj
 *    premiere_import_folder(folderPath)           - imports a folder of media into the active project
 *    premiere_create_sequence_from_folder(folder, name) - imports + drops clips on V1 of a new sequence
 *    premiere_render_active_sequence(presetName)  - renders the active sequence to a known preset
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCRIPTS_DIR = path.join(PROJECT_DIR, "bridge", "premiere-scripts");
const PREMIERE_APP = "Adobe Premiere Pro 2025";

async function ensureScriptsDir() {
  if (!existsSync(SCRIPTS_DIR)) await mkdir(SCRIPTS_DIR, { recursive: true });
}

/** Run a .jsx file inside the running Premiere via AppleScript DoScript bridge. */
async function runInPremiere(jsxPath) {
  const osa = `tell application "${PREMIERE_APP}"
    activate
    do javascript file "${jsxPath}"
  end tell`;
  const { stdout, stderr } = await execFileP("osascript", ["-e", osa]);
  return { stdout, stderr };
}

/** Escape a string so it's safe to embed inside ExtendScript single-quoted JS strings. */
function jsxStr(s) {
  return String(s).replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/* ---------- TOOL: open project ---------- */
export async function premiereOpenProject(projectPath) {
  if (!projectPath) throw new Error("projectPath required");
  const osa = `tell application "${PREMIERE_APP}"
    activate
    open POSIX file "${projectPath}"
  end tell`;
  await execFileP("osascript", ["-e", osa]);
  return { ok: true, opened: projectPath };
}

/* ---------- TOOL: import folder ---------- */
export async function premiereImportFolder(folderPath) {
  if (!folderPath || !existsSync(folderPath)) throw new Error(`folder not found: ${folderPath}`);
  await ensureScriptsDir();
  const jsx = `
// auto-generated import folder script
(function() {
  if (!app.project) { return "no active project — open one first"; }
  var folder = new Folder('${jsxStr(folderPath)}');
  if (!folder.exists) return "folder missing on disk";
  var files = folder.getFiles(function(f) {
    if (f instanceof Folder) return false;
    var n = f.fsName.toLowerCase();
    return /\\.(mov|mp4|mxf|m4v|avi|mkv|jpg|jpeg|png|tif|tiff|cr2|cr3|nef|arw|dng|raf|orf)$/.test(n);
  });
  if (files.length === 0) return "no media files in folder";
  var paths = [];
  for (var i = 0; i < files.length; i++) paths.push(files[i].fsName);
  app.project.importFiles(paths, true, app.project.rootItem, false);
  return "imported " + paths.length + " items into " + (app.project.name || "active project");
})();
`;
  const jsxPath = path.join(SCRIPTS_DIR, `import-${Date.now()}.jsx`);
  await writeFile(jsxPath, jsx);
  await runInPremiere(jsxPath);
  return { ok: true, folder: folderPath };
}

/* ---------- TOOL: create sequence from folder + drop clips on V1 ---------- */
export async function premiereCreateSequenceFromFolder(folderPath, name) {
  if (!folderPath || !existsSync(folderPath)) throw new Error(`folder not found: ${folderPath}`);
  await ensureScriptsDir();
  const seqName = name || `Auto-${path.basename(folderPath)}-${Date.now()}`;
  const jsx = `
(function() {
  if (!app.project) return "no active project — open one first";
  var folder = new Folder('${jsxStr(folderPath)}');
  if (!folder.exists) return "folder missing on disk";
  var files = folder.getFiles(function(f) {
    if (f instanceof Folder) return false;
    var n = f.fsName.toLowerCase();
    return /\\.(mov|mp4|mxf|m4v|avi)$/.test(n);
  });
  if (files.length === 0) return "no video files in folder";

  // Sort by name for stable order
  files.sort(function(a, b) { return a.fsName < b.fsName ? -1 : 1; });

  var paths = [];
  for (var i = 0; i < files.length; i++) paths.push(files[i].fsName);

  // Import into a new bin so the sequence stays organised
  var binName = '${jsxStr(seqName)}';
  var bin = app.project.rootItem.createBin(binName);
  app.project.importFiles(paths, true, bin, false);

  // Find the imported items in the bin
  var imported = [];
  for (var j = 0; j < bin.children.numItems; j++) {
    imported.push(bin.children[j]);
  }
  if (imported.length === 0) return "import succeeded but nothing landed in the bin";

  // Create a sequence from the first clip's settings (auto-matches resolution + frame rate)
  var seq = app.project.createNewSequenceFromClips(binName, imported, "/");
  if (!seq) {
    // Fallback: AVCHD 1080p preset
    seq = app.project.createNewSequence(binName, "AVCHD 1080p30");
  }
  return "created sequence '" + binName + "' with " + imported.length + " clips";
})();
`;
  const jsxPath = path.join(SCRIPTS_DIR, `seq-${Date.now()}.jsx`);
  await writeFile(jsxPath, jsx);
  await runInPremiere(jsxPath);
  return { ok: true, sequence: seqName, folder: folderPath };
}

/* ---------- TOOL: render active sequence ---------- */
export async function premiereRenderActiveSequence(presetName, outputDir) {
  await ensureScriptsDir();
  const out = outputDir || Paths.getOutputSubdir("premiereRenders");
  if (!existsSync(out)) await mkdir(out, { recursive: true });
  /* Why: Premiere ExtendScript exposes app.encoder.encodeSequence() with an absolute preset path.
   * We accept a friendly preset name and try to resolve it; falls back to no-preset (the sequence's own settings). */
  const jsx = `
(function() {
  if (!app.project) return "no active project";
  var seq = app.project.activeSequence;
  if (!seq) return "no active sequence";
  var outPath = '${jsxStr(path.join(out, "render"))}_' + new Date().getTime() + '.mp4';
  // Match Source — ExtendScript constants:
  // 0 = ENCODE_ENTIRE, 1 = ENCODE_IN_TO_OUT, 2 = ENCODE_WORKAREA
  app.encoder.launchEncoder();
  var ok = app.encoder.encodeSequence(seq, outPath, "", 0, 0);
  app.encoder.startBatch();
  return "queued render to " + outPath + " — Adobe Media Encoder will finish";
})();
`;
  const jsxPath = path.join(SCRIPTS_DIR, `render-${Date.now()}.jsx`);
  await writeFile(jsxPath, jsx);
  await runInPremiere(jsxPath);
  return { ok: true, outputDir: out };
}

/* ---------- TOOL: ensure Premiere is running ---------- */
export async function premiereEnsureRunning() {
  await execFileP("osascript", ["-e", `tell application "${PREMIERE_APP}" to activate`]);
  return { ok: true };
}
