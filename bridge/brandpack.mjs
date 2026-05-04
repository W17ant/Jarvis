/** brandpack.mjs - One-shot deliverable export for a hero shot.
 *
 *  Why: post-shoot delivery for FOM consistently produces the same package —
 *  one hero in 4 aspect ratios (16:9 / 9:16 / 1:1 / 4:5), watermarked AND clean
 *  variants, plus a brand-credit text file. Composing this manually takes ~8
 *  minutes of click-export-watermark-zip-rename per hero. This tool composes
 *  it from one voice command.
 *
 *  Pipeline:
 *    1. Resolve source path (under shoots/ or absolute inside project)
 *    2. Crop to 4 aspect ratios via Vision.exportAllAspects (existing primitive)
 *    3. Apply FOM watermark to a parallel copy via ImageMagick
 *    4. Drop a credit.txt with brand boilerplate
 *    5. Zip the whole folder for handoff
 *
 *  Output: output/brand-packs/<basename>_<ts>/  +  the .zip beside it. */

import { mkdir, copyFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as Vision from "./vision.mjs";
import { loadBrand } from "./brand.mjs";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ASSETS_DIR = path.join(PROJECT_DIR, "assets");
/* OUTPUT_DIR / SHOOTS_DIR resolved at call sites via Paths.* — operator-configurable. */

const DEFAULT_WATERMARK = path.join(ASSETS_DIR, "fom-wordmark.png");
const ASPECTS = ["16:9", "9:16", "1:1", "4:5"];

/** Resolve a source path inside the project tree. Refuses paths that escape. */
function resolveSourcePath(input) {
  if (!input) return null;
  let abs = path.isAbsolute(input) ? input : path.resolve(PROJECT_DIR, input);
  if (!existsSync(abs)) {
    /* Try shoots/<name> as a convenience. */
    const candidate = path.join(Paths.getShootsDir(), input);
    if (existsSync(candidate)) abs = candidate;
  }
  if (!Paths.isWithinAllowedRoots(abs)) return null;
  return existsSync(abs) ? abs : null;
}

/** Apply a watermark to a single image. Mirrors the watermarkImage helper in
 *  watermark.mjs but operates on a single file, since brand-pack composes a
 *  fixed set of cropped variants rather than a folder sweep. */
async function watermarkOne(src, dest, { opacity = 0.6, scale = 0.12, marginPx = 28, watermarkPath }) {
  const args = [
    src,
    "(", watermarkPath,
        "-resize", `${Math.round(scale * 10000) / 100}%x`,
        "-alpha", "set",
        "-channel", "A", "-evaluate", "Multiply", String(opacity), "+channel",
    ")",
    "-gravity", "SouthEast",
    "-geometry", `+${marginPx}+${marginPx}`,
    "-compose", "Over", "-composite",
    dest,
  ];
  await execFileP("magick", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
}

/** Compose a credit.txt body from the brand config. White-label friendly. */
function creditBody(srcBasename) {
  const brand = loadBrand();
  const agency = brand?.agency || {};
  const name = agency.name || "Flat-Out Media";
  const tagline = agency.tagline || "";
  const handle = agency.social || "";
  const date = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
  return [
    `Image: ${srcBasename}`,
    `Date packaged: ${date}`,
    "",
    `Photograph © ${name}.${tagline ? " " + tagline + "." : ""}`,
    handle ? `Credit: ${handle}` : "",
    "",
    "Aspect ratios included: 16:9, 9:16, 1:1, 4:5 — clean + watermarked variants.",
    "Watermarked copies are for social/web use; clean copies for editorial / press.",
  ].filter(Boolean).join("\n");
}

/**
 * Export a brand pack for a single hero image.
 *
 * @param {object} args
 * @param {string} args.path        Path to the hero image (absolute inside project, or shoots/<name>/<file.jpg>).
 * @param {boolean} [args.includeWatermarked=true]  Render the watermarked variants too.
 * @param {boolean} [args.zip=true]                 Zip the output folder.
 * @returns {Promise<object>}
 */
export async function exportBrandPack(args = {}) {
  const src = resolveSourcePath(args.path);
  if (!src) return { ok: false, error: "source image not found inside the project" };
  const includeWm = args.includeWatermarked !== false;
  const doZip = args.zip !== false;

  const baseName = path.basename(src, path.extname(src)).replace(/[^a-z0-9._-]/gi, "_");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const brandPacksRoot = Paths.getOutputSubdir("brandPacks");
  const packDir = path.join(brandPacksRoot, `${baseName}_${ts}`);
  const cleanDir = path.join(packDir, "aspects");
  const wmDir = path.join(packDir, "watermarked");

  await mkdir(packDir, { recursive: true });
  await mkdir(cleanDir, { recursive: true });
  if (includeWm) await mkdir(wmDir, { recursive: true });

  /* Step 1: copy source into the pack root for delivery. */
  const sourceCopy = path.join(packDir, `source${path.extname(src)}`);
  await copyFile(src, sourceCopy);

  /* Step 2: cropped aspect variants via Vision.exportAllAspects.
   * The vision tool writes to output/aspects/ — we then move them into our pack dir
   * so the operator gets a single self-contained folder. */
  const aspectsResult = await Vision.exportAllAspects({ path: src, aspects: ASPECTS });
  if (!aspectsResult.ok) {
    return { ok: false, error: `aspect export failed: ${aspectsResult.error}` };
  }

  /* exportAllAspects returns { outputs: [{aspect, ok, output, cropCmd}] } — copy each
   * successful crop into our pack. The `output` field is project-relative.
   *
   * Why: when the source already matches an aspect (e.g. a 16:9 DSLR JPEG), the
   * Vision crop step skips that aspect. We still want a deliverable for it, so
   * fall back to copying the source as the clean variant. */
  const variants = [];
  const handledAspects = new Set();
  for (const out of (aspectsResult.outputs || [])) {
    if (!out.ok || !out.output) continue;
    const aspectLabel = out.aspect.replace(":", "x");
    const dest = path.join(cleanDir, `${aspectLabel}${path.extname(out.output)}`);
    const absSrc = path.isAbsolute(out.output) ? out.output : path.join(PROJECT_DIR, out.output);
    if (existsSync(absSrc)) {
      await copyFile(absSrc, dest);
      variants.push({ aspect: out.aspect, clean: dest });
      handledAspects.add(out.aspect);
    }
  }
  /* Fill any aspect the Vision step skipped — copy source straight in. */
  for (const aspect of ASPECTS) {
    if (handledAspects.has(aspect)) continue;
    const aspectLabel = aspect.replace(":", "x");
    const dest = path.join(cleanDir, `${aspectLabel}${path.extname(src)}`);
    await copyFile(src, dest);
    variants.push({ aspect, clean: dest, fallback: true });
  }

  /* Step 3: watermarked copies of each cropped variant. */
  if (includeWm) {
    for (const v of variants) {
      const wmDest = path.join(wmDir, path.basename(v.clean));
      try {
        await watermarkOne(v.clean, wmDest, { watermarkPath: DEFAULT_WATERMARK });
        v.watermarked = wmDest;
      } catch (e) {
        v.watermarkError = String(e.message || e);
      }
    }
  }

  /* Step 4: credit text for the operator to slip into the delivery email. */
  await writeFile(path.join(packDir, "credit.txt"), creditBody(path.basename(src)));

  /* Step 5: zip for handoff. macOS ships zip — no allowlist needed (we exec
   * directly, not through the LLM-facing run_shell). Fall back to no-zip if
   * the binary is missing for some reason. */
  let zipPath = null;
  if (doZip) {
    zipPath = `${packDir}.zip`;
    try {
      /* -j drops the leading directory chain; we want the full structure preserved
       * so the operator opens the zip and sees source/ aspects/ watermarked/ credit.txt. */
      await execFileP("zip", ["-r", "-q", zipPath, path.basename(packDir)], {
        cwd: brandPacksRoot,
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (e) {
      zipPath = null;
      console.warn(`[brandpack] zip failed: ${e.message}`);
    }
  }

  return {
    ok: true,
    packDir: path.relative(PROJECT_DIR, packDir),
    zip: zipPath ? path.relative(PROJECT_DIR, zipPath) : null,
    variants: variants.map(v => ({
      aspect: v.aspect,
      clean: path.relative(PROJECT_DIR, v.clean),
      watermarked: v.watermarked ? path.relative(PROJECT_DIR, v.watermarked) : null,
    })),
    summary: `Brand pack ready: ${variants.length} aspect ratios${includeWm ? " (clean + watermarked)" : ""}${zipPath ? ", zipped" : ""}.`,
  };
}
