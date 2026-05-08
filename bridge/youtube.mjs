/** youtube.mjs - YouTube thumbnail generator + 30-second Short generator.
 *
 *  Tools:
 *    generate_youtube_thumbnail({ folder, headline, subhead?, specs? })
 *      - Picks hero shot + engine shot via VL (find_frame queries)
 *      - Composes 1280x720 thumbnail via puppeteer (HTML+CSS)
 *      - Big yellow headline (Impact/Anton), red subhead, spec strip showing engine/BHP/0-60
 *      - Engine inlay in bottom-right so the client SEES what's under the bonnet
 *
 *    generate_youtube_short({ folder, headline, subhead?, music? })
 *      - 30-second 9:16 vertical (1080x1920) cut from the shoot stills
 *      - Fast cuts (Ken Burns + flash transitions), text-card kickers at start/middle/end
 *      - Reuses the music + cinematic edit primitives from edit.mjs
 *
 *  Progress events broadcast for the HUD ("yt.thumbnail.progress" / "yt.short.progress")
 *  so the operator can screen-record stages ticking during a client demo.
 */

import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import puppeteer from "puppeteer-core";
import * as Vision from "./vision.mjs";
import { buildProductionTeaser, findShootFolderForSubject } from "./edit.mjs";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
/* Shoots/output roots resolved at call sites via Paths.* — operator-configurable. */
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ACCENT_CYAN = "#00d4ff";
const FOM_YELLOW = "#F8E71C";

/** Resolve a folder name (or "latest") to absolute path under shoots/.
 *  Now subject-aware: if `folder` looks like a subject phrase ("the press car", "the hero",
 *  "the press car"), token-match against folder names to find the closest match. Fixes the
 *  bug where two same-day folders (`2026-05-01-track-day` and `2026-05-01-press-car`)
 *  caused alphabetical sort to pick the wrong one when the operator asked for "the press car". */
async function resolveShoot(folder) {
  const shootsDir = Paths.getShootsDir();
  if (!folder || folder === "latest") {
    /* Sort by mtime (newest first), not alpha — same-day folders that came in later win.
     * Falls back to alpha-reverse if mtime stat fails. */
    const dirs = readdirSync(shootsDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    if (dirs.length === 0) return null;
    try {
      const fs = await import("node:fs/promises");
      const withTimes = await Promise.all(dirs.map(async (n) => {
        try { const s = await fs.stat(path.join(shootsDir, n)); return { n, t: s.mtimeMs }; }
        catch { return { n, t: 0 }; }
      }));
      withTimes.sort((a, b) => b.t - a.t);
      return path.join(shootsDir, withTimes[0].n);
    } catch {
      dirs.sort().reverse();
      return path.join(shootsDir, dirs[0]);
    }
  }
  /* Already a real folder under shoots/? Use it directly. */
  const direct = path.isAbsolute(folder) ? folder : path.join(shootsDir, folder);
  if (existsSync(direct)) return direct;
  /* Otherwise treat the input as a subject phrase and token-match against folder names. */
  return await findShootFolderForSubject(folder);
}

/** Read an image into a base64 data URL for embedding in HTML. */
async function dataUrl(p) {
  const buf = await readFile(p);
  const ext = path.extname(p).toLowerCase().replace(".", "") || "jpg";
  return `data:image/${ext === "jpg" ? "jpeg" : ext};base64,${buf.toString("base64")}`;
}

/* ───────── SUBJECT + STATS DERIVATION ─────────
 * Why: thumbnail looks generic without specs. We let Qwen 14b answer "what is the X
 * (make, model, BHP, top speed, 0-60, drivetrain)?" using its training knowledge.
 * One JSON-locked LLM call, ~1-3s on the warm 14b. Operator overrides win. */
const TWO_WORD_MAKES = ["aston martin", "land rover", "rolls-royce", "rolls royce", "alfa romeo"];

function parseMakeModelFromFolder(folderName) {
  const cleaned = (folderName || "")
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")
    .replace(/[-_]/g, " ").trim()
    .replace(/\b\w/g, c => c.toUpperCase());
  if (!cleaned) return { make: folderName || "Vehicle", model: "" };
  const lc = cleaned.toLowerCase();
  const matchedTwo = TWO_WORD_MAKES.find(m => lc.startsWith(m));
  if (matchedTwo) {
    return { make: cleaned.slice(0, matchedTwo.length), model: cleaned.slice(matchedTwo.length).trim() };
  }
  const parts = cleaned.split(/\s+/);
  return { make: parts[0] || cleaned, model: parts.slice(1).join(" ") };
}

async function deriveSubjectAndStats({ folderName, overrideMake, overrideModel, overrideStats }) {
  const guess = parseMakeModelFromFolder(folderName);
  const make = overrideMake || guess.make;
  const model = overrideModel || guess.model;

  /* If operator supplied stats, skip the LLM call. */
  if (overrideStats && Object.keys(overrideStats).length > 0) {
    return { make, model, stats: overrideStats };
  }

  /* Single Qwen call to populate the Top Trumps fields. JSON-locked so we don't
   * have to scrape free-form text. Returns null for anything Qwen isn't confident
   * about — better to omit a stat than fabricate one. */
  const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";
  const TEXT  = process.env.OLLAMA_MODEL || "qwen2.5:14b";
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: TEXT,
        stream: false,
        keep_alive: "5m",
        format: "json",
        options: { temperature: 0.1 },
        messages: [
          { role: "system", content: "You return automotive headline specs as JSON. Use what you already know about the car. If you're not confident about a value, return null for it — never fabricate. Be concise: just the figure with its unit." },
          { role: "user", content: `Vehicle: ${make} ${model}\n\nReply with this JSON shape exactly:\n{ "power": "<e.g. '510 BHP' or null>", "topSpeed": "<e.g. '198 mph' or null>", "engine": "<e.g. '5.0L V10' or null>", "drivetrain": "<e.g. 'AWD' or 'RWD' or null>", "zeroToSixty": "<e.g. '3.2s' or null>" }` },
        ],
      }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    const j = await r.json();
    const raw = (j.message?.content || "").trim();
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    /* Massage to the labels the thumbnail card expects (BHP / TOP SPEED / 0-60 / DRIVE). */
    const out = {};
    if (parsed.power)        out["BHP"]       = String(parsed.power).replace(/\s*BHP\s*/i, "").trim() + (/[a-z]/i.test(String(parsed.power)) ? "" : " BHP");
    if (parsed.topSpeed)     out["Top Speed"] = String(parsed.topSpeed);
    if (parsed.engine)       out["Engine"]    = String(parsed.engine);
    if (parsed.drivetrain)   out["Drive"]     = String(parsed.drivetrain);
    if (parsed.zeroToSixty)  out["0-60"]      = String(parsed.zeroToSixty);
    /* Cap at 4 stats (Top Trumps grid is 2x2). Prefer BHP / Top Speed / 0-60 / Drive. */
    const priority = ["BHP", "Top Speed", "0-60", "Drive", "Engine"];
    const picked = {};
    for (const k of priority) { if (out[k] && Object.keys(picked).length < 4) picked[k] = out[k]; }
    return { make, model, stats: picked };
  } catch (e) {
    console.warn(`[yt-thumb] stats lookup failed: ${e.message}`);
    return { make, model, stats: {} };
  }
}

/* ───────── THUMBNAIL TEMPLATE ─────────
 * Why: client feedback — legacy thumbnails (yellow text + car) don't show the engine
 * or any specs. New layout puts the hero car as full-bleed background, the engine bay as a
 * bottom-right inset (red bordered), big yellow Impact headline + red subhead on the left,
 * and a bottom spec strip with engine/BHP/0-60. */
function thumbnailHtml({ heroData, engineData, headline, subhead, stats, make, model, agencyMark }) {
  /* Why: Top Trumps card lives in the bottom-right above the engine inlay (or alone if
   * no engine shot found). 4 stats laid out on a 2x2 grid with big numbers + small labels.
   * Operator can pass any subset; missing stats just don't render so the layout stays clean. */
  const statEntries = Object.entries(stats || {})
    .filter(([_, v]) => v && String(v).trim())
    .slice(0, 4);
  const statHtml = statEntries.map(([label, value]) => `
    <div class="stat">
      <div class="stat__value">${escapeHtml(String(value))}</div>
      <div class="stat__label">${escapeHtml(label.toUpperCase())}</div>
    </div>
  `).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8" />
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@500;700&display=swap" rel="stylesheet" />
<style>
  @page { size: 1280px 720px; margin: 0; }
  html, body { margin: 0; padding: 0; width: 1280px; height: 720px; background: #000; overflow: hidden; }
  .frame { position: relative; width: 1280px; height: 720px; }
  .hero { position: absolute; inset: 0; background-image: url('${heroData}'); background-size: cover; background-position: center; filter: contrast(1.05) saturate(1.1); }
  .hero::after { content:""; position:absolute; inset:0; background: linear-gradient(90deg, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 45%, rgba(0,0,0,0) 65%), linear-gradient(0deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 50%); }

  .text { position: absolute; left: 56px; top: 56px; right: 480px; z-index: 2; max-width: 720px; }
  /* Make/model line above the big yellow headline — small, red-bordered, all caps. */
  .makemodel {
    display: inline-block;
    font-family: "Oswald", sans-serif;
    font-weight: 700;
    font-size: 24px;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    padding: 4px 10px;
    border-left: 4px solid ${ACCENT_CYAN};
    background: rgba(0, 0, 0, 0.45);
    margin-bottom: 12px;
  }
  .headline {
    font-family: "Anton", "Impact", "Oswald", sans-serif;
    font-weight: 400;
    font-size: 138px;
    line-height: 0.86;
    color: ${FOM_YELLOW};
    text-transform: uppercase;
    letter-spacing: -0.01em;
    text-shadow: 6px 6px 0 #000, -6px -6px 0 #000, 6px -6px 0 #000, -6px 6px 0 #000, 0 0 20px rgba(248, 231, 28, 0.45);
    transform: rotate(-2deg);
    transform-origin: left top;
  }
  .subhead {
    font-family: "Oswald", sans-serif;
    font-weight: 700;
    font-size: 42px;
    color: #fff;
    background: ${ACCENT_CYAN};
    text-transform: uppercase;
    letter-spacing: 0.02em;
    margin-top: 26px;
    padding: 6px 14px;
    display: inline-block;
    box-shadow: 4px 4px 0 #000;
  }

  /* Engine inlay — top-right corner, smaller now to leave room for the stats card. */
  .engine { position: absolute; right: 36px; top: 36px; width: 320px; height: 200px;
    background-image: url('${engineData}'); background-size: cover; background-position: center;
    border: 5px solid ${ACCENT_CYAN};
    box-shadow: 0 0 0 3px #000, 8px 8px 0 #000;
    z-index: 3;
  }
  .engine__label { position: absolute; top: -22px; left: 0; background: ${ACCENT_CYAN}; color: #fff; font-family: "Oswald", sans-serif; font-weight: 700; font-size: 15px; padding: 3px 10px; letter-spacing: 0.18em; text-transform: uppercase; }

  /* Top Trumps stats card — bottom-right. 2x2 grid of big number + small label cells.
   * Reads instantly: BHP / TOP SPEED / 0-60 / DRIVE all visible at thumbnail-grid size. */
  .stats { position: absolute; right: 36px; bottom: 36px; width: 380px;
    background: rgba(0, 0, 0, 0.82);
    border: 3px solid ${ACCENT_CYAN};
    box-shadow: 6px 6px 0 #000;
    padding: 14px 16px 16px;
    z-index: 4;
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px;
  }
  .stats__head {
    grid-column: 1 / -1;
    font-family: "Oswald", sans-serif; font-weight: 700; font-size: 14px;
    color: ${ACCENT_CYAN}; letter-spacing: 0.32em; text-transform: uppercase;
    border-bottom: 2px solid ${ACCENT_CYAN}; padding-bottom: 6px; margin-bottom: 4px;
  }
  .stat { display: flex; flex-direction: column; }
  .stat__value {
    font-family: "Anton", "Oswald", sans-serif;
    font-weight: 400;
    font-size: 36px;
    color: #fff;
    line-height: 1;
    letter-spacing: -0.02em;
  }
  .stat__label {
    font-family: "Oswald", sans-serif;
    font-weight: 600;
    font-size: 11px;
    color: ${ACCENT_CYAN};
    letter-spacing: 0.22em;
    margin-top: 2px;
    text-transform: uppercase;
  }

  .agency { position: absolute; left: 36px; bottom: 36px; z-index: 4;
    font-family: "Anton", "Oswald", sans-serif;
    font-weight: 400;
    font-size: 30px;
    color: #fff;
    letter-spacing: 0.06em;
    text-shadow: 2px 2px 0 #000;
  }
  .agency em { font-style: normal; color: ${ACCENT_CYAN}; font-family: "Oswald", sans-serif; font-weight: 700; font-size: 16px; letter-spacing: 0.45em; display: block; margin-top: -2px; }
</style></head>
<body>
  <div class="frame">
    <div class="hero"></div>
    <div class="text">
      ${(make || model) ? `<div class="makemodel">${escapeHtml(`${make || ""}${model ? " " + model : ""}`)}</div>` : ""}
      <div class="headline">${escapeHtml(headline || "")}</div>
      ${subhead ? `<div class="subhead">${escapeHtml(subhead)}</div>` : ""}
    </div>
    ${engineData ? `<div class="engine"><div class="engine__label">UNDER THE SKIN</div></div>` : ""}
    <div class="agency">${escapeHtml(agencyMark || "JARVIS")}<em>MEDIA</em></div>
    ${statEntries.length ? `<div class="stats"><div class="stats__head">SPEC SHEET</div>${statHtml}</div>` : ""}
  </div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/**
 * Pick the strongest hero shot + an engine bay shot from a shoot folder.
 * Uses the existing semantic search over cached frame captions; falls back to
 * any image in the folder if find_frame returns nothing (e.g. captions not yet cached).
 */
/** Stage manifest for the YouTube thumbnail pipeline. Used by the HUD's
 *  task strip lane viz. Names chosen to substring-match the broadcast
 *  emissions in pickThumbnailShots + generateYoutubeThumbnail so
 *  tasks.js's loose matcher lights up the right pill:
 *
 *    broadcast emits         →   manifest entry
 *    "captioning-folder"     →   "captioning"
 *    "picking-hero"          →   "hero"
 *    "picking-engine"        →   "engine"
 *    "rendering"             →   "rendering"
 *
 *  The 'starting' / 'done' broadcasts are not manifest entries —
 *  task.start + task.complete already cover those transitions. */
export const YT_THUMBNAIL_STAGES = [
  "captioning",
  "hero",
  "engine",
  "rendering",
];

async function pickThumbnailShots(folderAbs, broadcast) {
  const folderName = path.basename(folderAbs);

  /* Warm captions if cold — single sample run keeps it fast for live demos */
  broadcast?.("captioning-folder");
  await Vision.captionShootFolder({ folder: folderName, sampleCount: 12 }).catch(() => {});

  broadcast?.("picking-hero");
  const heroQuery = "hero shot of the car, clean composition, low angle dramatic, full vehicle visible";
  const heroRes = await Vision.findFrame({ query: heroQuery, folder: folderName, limit: 3 }).catch(() => ({ results: [] }));
  let heroPath = heroRes?.results?.[0]?.path
    ? path.join(PROJECT_DIR, heroRes.results[0].path)
    : firstImage(folderAbs);

  broadcast?.("picking-engine");
  const engineQuery = "engine bay close up, mechanical detail, exhaust manifold, cylinder head, internals visible";
  const engineRes = await Vision.findFrame({ query: engineQuery, folder: folderName, limit: 3 }).catch(() => ({ results: [] }));
  /* Take the top match only if it's clearly engine-relevant (score > 0.5), otherwise leave engine inlay empty */
  const engineHit = engineRes?.results?.find(r => r.score > 0.5 && r.path !== heroRes?.results?.[0]?.path);
  const enginePath = engineHit ? path.join(PROJECT_DIR, engineHit.path) : null;

  return { heroPath, enginePath };
}

function firstImage(folderAbs) {
  const exts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
  for (const f of readdirSync(folderAbs).sort()) {
    if (exts.has(path.extname(f).toLowerCase())) return path.join(folderAbs, f);
  }
  return null;
}

/**
 * Generate the YouTube thumbnail.
 *
 * @param {object} args
 * @param {string} args.folder       Shoot folder (or "latest").
 * @param {string} args.headline     Big yellow text e.g. "V10 BEAST".
 * @param {string} [args.subhead]    Red strap line e.g. "The Car That Broke Me".
 * @param {string[]} [args.specs]    Spec strip — e.g. ["V10", "5.0L", "510 BHP", "0-60 in 3.2s"].
 * @param {string} [args.agencyMark] Defaults "JARVIS".
 * @param {function} [broadcast]     Stage notifier — wired to HUD so the screen-recorded
 *                                   demo shows progress: 'captioning-folder' →
 *                                   'picking-hero' → 'picking-engine' → 'rendering' → 'done'.
 */
export async function generateYoutubeThumbnail(args = {}, broadcast = () => {}) {
  /* Subject-aware folder resolution: prefer args.subject, fall back to args.folder, else latest.
   * "ascari" maps to 2026-05-01-track-day even when an the client folder is alphabetically first. */
  const folderHint = args.folder || args.subject || "latest";
  const folderAbs = await resolveShoot(folderHint);
  if (!folderAbs) return { ok: false, error: `shoot folder not found for "${folderHint}"` };
  if (!args.headline) return { ok: false, error: "headline required (e.g. 'V10 BEAST')" };
  console.log(`[yt-thumb] folder resolved: ${path.basename(folderAbs)}`);

  /* Auto-derive make/model + Top Trumps stats from the folder name + Qwen training knowledge.
   * Operator can override with explicit args.make / args.model / args.stats — but a single
   * voice command like "make a thumbnail for the press car shoot, V10 beast, the car that broke me"
   * gets a fully-populated thumbnail with no extra prompting. */
  const { make, model, stats: derivedStats } = await deriveSubjectAndStats({
    folderName: path.basename(folderAbs),
    overrideMake: args.make,
    overrideModel: args.model,
    overrideStats: args.stats,
  });
  console.log(`[yt-thumb] subject: ${make} ${model || ""}  stats keys: ${Object.keys(derivedStats || {}).join(",") || "(none)"}`);

  broadcast("starting");
  const { heroPath, enginePath } = await pickThumbnailShots(folderAbs, broadcast);
  if (!heroPath) return { ok: false, error: "no usable hero image in shoot folder" };

  broadcast("rendering");
  const heroData = await dataUrl(heroPath);
  const engineData = enginePath ? await dataUrl(enginePath) : null;

  const html = thumbnailHtml({
    heroData, engineData, make, model, stats: derivedStats,
    headline: args.headline,
    subhead: args.subhead || "",
    agencyMark: args.agencyMark || "JARVIS",
  });

  /* Land YouTube thumbnails under the canonical youtube/thumbnails subfolder so the
   * operator's output dir self-organises by deliverable platform. */
  const dir = Paths.getOutputSubdir("youtubeThumbnails");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const stem = path.basename(folderAbs);
  const outPath = path.join(dir, `${stem}_${ts}.png`);

  /* Why: 2× scale-factor renders sharp text at the 1280x720 native viewport — any retina
   * client preview will appreciate the extra detail. Output is then downscaled in-pipeline. */
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
    /* Why: was 'networkidle0' which hung 30s on Google Fonts in headless Chrome. The CSS
     * already lists "Impact" / "Arial Narrow" / "sans-serif" fallbacks, so we proceed once
     * the DOM is parsed and give Anton/Oswald a generous 2.5s to land — whichever wins,
     * the thumbnail renders. Bumped page-default navigation timeout for the same reason. */
    page.setDefaultTimeout(90_000);
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise(r => setTimeout(r, 2500));  // give web fonts a moment, then snap
    await page.screenshot({ path: outPath, type: "png", omitBackground: false });
  } finally { await browser.close(); }

  const stat = statSync(outPath);
  broadcast("done", { url: `/output/thumbnails/${path.basename(outPath)}` });

  return {
    ok: true,
    url: `/output/thumbnails/${path.basename(outPath)}`,
    path: outPath,
    sizeKB: Math.round(stat.size / 1024),
    heroFile: path.basename(heroPath),
    engineFile: enginePath ? path.basename(enginePath) : null,
    headline: args.headline,
    subhead: args.subhead,
    specs: args.specs,
  };
}

/**
 * Generate a 30-second 16:9 YouTube Short. Wraps the cinematic teaser pipeline (edit.mjs)
 * so the operator gets the same flash cuts / speed ramps / beat-synced music, but with the
 * operator-supplied headline and subhead used as text-overlay cues.
 */
export async function generateYoutubeShort(args = {}) {
  const folderHint = args.folder || args.subject || "latest";
  const folderAbs = await resolveShoot(folderHint);
  if (!folderAbs) return { ok: false, error: `shoot folder not found for "${folderHint}"` };

  /* Build the closing-card text from headline + subhead. Existing planEdit uppercases
   * and stacks one word per line, so " · " separator gives a clean two-line kicker. */
  const closingText = [args.headline, args.subhead].filter(Boolean).join(" · ") || "JARVIS";

  const subject = args.subject || (() => {
    const cleaned = path.basename(folderAbs).replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]/g, " ").trim();
    return cleaned ? cleaned.replace(/\b\w/g, c => c.toUpperCase()) : "Subject";
  })();

  /* Why: YouTube long-form / shelf videos are 16:9 — the default teaser pipeline is 9:16
   * because it was built for Reels/TikTok. Pass aspect so the renderer crops + scales
   * everything to 1920x1080 instead. Operator can override via args.aspect for a 1:1
   * Instagram-square cut without code changes. */
  const aspect = args.aspect || { w: 1920, h: 1080 };
  const result = await buildProductionTeaser({
    shootFolder: folderAbs,
    subject,
    customText: closingText,
    music: args.music || "auto",
    aspect,
  });

  return {
    ok: true,
    runId: result.runId,
    subject: result.subject,
    durationSec: result.durationSec,
    finalUrl: `/output/${result.runId}/final.mp4`,
    headline: args.headline,
    subhead: args.subhead,
  };
}

/* ───────── COMBINED: thumbnail + 30s short in one call ─────────
 * Why: voice flow "make a thumbnail and a short for the press car shoot, V10 beast, the car
 * that broke me" frequently failed with 14b only calling the first tool. Single combined
 * tool means Qwen only has to plan ONE tool call to deliver both deliverables. */
export async function generateYoutubePromo(args = {}, broadcastFn = () => {}) {
  /* Step 1: thumbnail (fast — pops in HUD modal in seconds) */
  const thumb = await generateYoutubeThumbnail(args, broadcastFn).catch(e => ({ ok: false, error: e?.message }));

  /* Step 2: short (background render, video.edit.complete event when ready). Don't await
   * fully — kick it off so Qwen can return promptly and tell the operator both are in flight. */
  generateYoutubeShort(args).catch(e => console.warn(`[yt-promo] short failed: ${e?.message}`));

  return {
    ok: !!thumb.ok,
    thumbnail: thumb.ok ? { url: thumb.url, headline: thumb.headline, subhead: thumb.subhead } : { error: thumb.error },
    short: { status: "started", note: "Render takes 2-3 min — auto-plays in HUD when ready." },
  };
}
