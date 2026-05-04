/** contactsheet.mjs - Hero-frame contact sheet generator.
 *
 *  Picks the strongest 6-12 stills from a shoot folder and lays them out as a branded
 *  PDF the operator can hand to a client (or pin to the editor's wall). Selection logic
 *  prioritises "hero"-flagged shots from shotflag.mjs, then fills remaining slots from
 *  Vision.findFrame ranked by composition / drama.
 *
 *  Tool: hero_contact_sheet({ folder?, count?, query? })
 *
 *  Pipeline:
 *    1. Resolve folder (defaults to most recent under shoots/).
 *    2. Pull all "hero" flags for this folder — those are mandatory inclusions.
 *    3. Top up to `count` via Vision.findFrame using a hero-shot query.
 *    4. Generate small JPEG thumbnails via sips (already in shell allowlist) so the
 *       embedded PDF stays small. Files larger than 800px lose drastically when shrunk.
 *    5. Embed each thumbnail as a base64 data URI in the contact-sheet PDF template.
 */

import { readdir, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { createPdf } from "./pdf.mjs";
import * as Vision from "./vision.mjs";
import * as Shotflag from "./shotflag.mjs";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
/* SHOOTS_DIR resolved at call sites via Paths.getShootsDir(). */

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff"]);
const THUMB_PIX = 600;  // long-edge px; balances density vs PDF weight

/* Subject extracted from the folder slug for the document header. */
function subjectFromFolder(name) {
  const cleaned = (name || "")
    .replace(/^\d{4}-\d{2}-\d{2}[-_]/, "")
    .replace(/[-_]/g, " ")
    .trim();
  return cleaned ? cleaned.replace(/\b\w/g, c => c.toUpperCase()) : null;
}

/** Resolve folder arg → absolute path, defaulting to most recent shoot.
 *  Why: absolute paths only honoured if they land inside PROJECT_DIR — otherwise null
 *  and we fall through to the most-recent-shoot default. Stops a misheard voice command
 *  from pointing the contact-sheet generator at, e.g., /Users/Antony/Documents. */
async function resolveFolder(folder) {
  const shootsDir = Paths.getShootsDir();
  if (folder) {
    let abs = path.isAbsolute(folder) ? folder : path.join(shootsDir, folder);
    abs = path.resolve(abs);
    if (Paths.isWithinAllowedRoots(abs) && existsSync(abs)) return abs;
  }
  if (!existsSync(shootsDir)) return null;
  const ents = await readdir(shootsDir, { withFileTypes: true });
  const dirs = ents.filter(e => e.isDirectory()).map(e => path.join(shootsDir, e.name));
  if (!dirs.length) return null;
  const stats = await Promise.all(dirs.map(async d => ({ d, mt: (await stat(d)).mtimeMs })));
  stats.sort((a, b) => b.mt - a.mt);
  return stats[0].d;
}

/** Generate a small JPEG thumbnail via sips, return base64 data URI.
 *  Caller supplies a tmpDir (one per buildHeroContactSheet run) so a crash
 *  mid-run can rm -rf the whole dir in a finally and never leaks. */
async function makeThumbDataUri(srcAbs, tmpDir, index) {
  /* Why: index disambiguates same-millisecond sips calls under chunked parallelism. */
  const safeBase = path.basename(srcAbs).replace(/[^a-z0-9._-]/gi, "_");
  const dest = path.join(tmpDir, `${index}-${safeBase}.jpg`);

  /* sips ships with macOS, supports HEIC + RAW out of the box, no extra deps.
   * -Z is "max long-edge in px" (preserves aspect). -s format jpeg standardises output. */
  try {
    await execFileP("sips", ["-Z", String(THUMB_PIX), "-s", "format", "jpeg", srcAbs, "--out", dest], {
      timeout: 30_000,
    });
  } catch (e) {
    return null;
  }

  try {
    const buf = await readFile(dest);
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Build a hero-frame contact sheet PDF.
 *
 * @param {object} args
 * @param {string} [args.folder]   Shoot folder name. Defaults to most recent.
 * @param {number} [args.count=8]  How many shots on the sheet (clamped 6–12).
 * @param {string} [args.query]    Override the selection query for find_frame.
 * @param {string} [args.client]   Optional client label for the document.
 */
export async function buildHeroContactSheet(args = {}) {
  const abs = await resolveFolder(args.folder);
  if (!abs) return { ok: false, error: "no shoot folder found" };
  const folderName = path.basename(abs);
  const subject = args.subject || subjectFromFolder(folderName) || folderName;

  /* Clamp count: design is built for 6 / 8 / 12; allow only that range. */
  const targetCount = Math.max(6, Math.min(12, Number(args.count) || 8));

  /* ---------- 1. Mandatory: hero-flagged shots ---------- */
  const allFiles = (await readdir(abs)).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
  const flagMap = Shotflag.getFlagsByFile(folderName, allFiles);
  const heroFlagged = [...flagMap.entries()]
    .filter(([, v]) => v.status === "hero")
    .map(([file, v]) => ({ file, source: "flagged", caption: v.note || null }));

  /* ---------- 2. Top up via Vision.findFrame ---------- */
  const picks = [...heroFlagged];
  const want = targetCount - picks.length;
  if (want > 0) {
    /* Why: warm captions if the folder hasn't been processed yet — find_frame relies on cached embeddings. */
    await Vision.captionShootFolder({ folder: folderName, sampleCount: Math.max(16, targetCount * 2) }).catch(() => {});
    const heroQuery = args.query
      || "strongest hero shot — clean composition, dramatic angle, dynamic light, dominant subject, magazine cover quality";
    const found = await Vision.findFrame({ query: heroQuery, folder: folderName, limit: want * 3 });
    const ranked = (found.ok ? found.results : []) || [];
    for (const r of ranked) {
      if (picks.length >= targetCount) break;
      const file = path.basename(r.path);
      if (picks.some(p => p.file === file)) continue;  // dedupe
      const flag = flagMap.get(file);
      if (flag && flag.status === "skip") continue;     // honour skip flags
      picks.push({ file, source: "vision", caption: r.caption });
    }
  }

  if (!picks.length) return { ok: false, error: "no candidate shots — folder may be empty or all-flagged-skip" };

  /* ---------- 3. Build thumbnails (parallel, but capped) ----------
   * Why: per-run subdir under os.tmpdir() so a process crash mid-run never leaks
   * thumbs into the project tree. The finally{} below rm -rf's the whole dir
   * regardless of success/failure. sips fork-bombs on a 12-shot batch in parallel;
   * chunk to 4 at a time. */
  const tmpDir = path.join(os.tmpdir(), `flatout-contactsheet-${Date.now()}-${process.pid}`);
  await mkdir(tmpDir, { recursive: true });
  const sheets = [];
  try {
    const CHUNK = 4;
    let idx = 0;
    for (let i = 0; i < picks.length; i += CHUNK) {
      const chunk = picks.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(async (p) => {
        const srcAbs = path.join(abs, p.file);
        const dataUri = await makeThumbDataUri(srcAbs, tmpDir, idx++);
        return dataUri ? { ...p, dataUri } : null;
      }));
      for (const r of results) if (r) sheets.push(r);
    }

    if (!sheets.length) return { ok: false, error: "could not generate any thumbnails (sips missing or all sources unreadable)" };

    /* ---------- 4. Render via pdf.mjs contact-sheet template ---------- */
    const pdf = await createPdf({
      template: "contact-sheet",
      data: {
        title: `${subject} — Hero Selects`,
        client: args.client || subject.split(" ")[0],
        subject,
        folder: folderName,
        sheets,  // [{ file, source, caption, dataUri }]
        summary: `${sheets.length} hero-grade frames picked from ${allFiles.length} stills${heroFlagged.length ? ` — ${heroFlagged.length} flagged "hero" by the operator` : ""}.`,
      },
    });

    return {
      ok: true,
      pdf,
      folder: folderName,
      subject,
      picks: sheets.map(s => ({ file: s.file, source: s.source, caption: s.caption })),
      summary: `Contact sheet ready — ${sheets.length} frames including ${heroFlagged.length} flagged heroes.`,
    };
  } finally {
    /* Always clean up the per-run thumb dir, even if PDF rendering threw. */
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
