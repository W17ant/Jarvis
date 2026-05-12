/** influencers.mjs — AI influencer character store.
 *
 *  An "influencer" is a persistent fake person used as the recurring face
 *  in a social-content channel (TikTok, IG, etc). They live on disk in
 *      output/influencers/<slug>/
 *          persona.json     — { name, slug, persona, look, aesthetic,
 *                               platform, created_at, locked_at? }
 *          refs/             — 2–4 reference stills from nano-banana-2,
 *                               named ref-1.png … ref-N.png
 *          canonical.png     — copy of the operator-picked reference,
 *                               used as the character image input for
 *                               nano-banana-pro hero shots and Kling
 *                               Motion Control recreations
 *
 *  Lifecycle:
 *      create()  → folder + persona.json + refs/ (gen via nano-banana-2)
 *      lock()    → operator picks ref index → copies to canonical.png
 *      get()     → reads persona.json + canonical path for downstream tools
 *      list()    → enumerates known influencers (used for voice lookup)
 *
 *  Why a separate module: influencer state is the *root* of the social-
 *  content pipeline; storyboards, hero shots, animations and recreations
 *  all reference it by slug. Keeping the file layout + lookup in one file
 *  means the rest of the pipeline can `import { get } from "./influencers.mjs"`
 *  without anyone having to learn the on-disk shape.
 */

import { mkdir, writeFile, readFile, copyFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as Fal from "./fal.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(__dirname);
const INFLUENCERS_DIR = join(PROJECT_ROOT, "output", "influencers");

/** Convert a human name ("Marcus", "Lena Page") to a folder-safe slug
 *  ("marcus", "lena-page"). Lowercase, hyphens, alnum only. */
export function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "unnamed";
}

/** Resolve to output/influencers/<slug>/. Creates the directory if missing. */
async function _influencerDir(slug) {
  const dir = join(INFLUENCERS_DIR, slug);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, "refs"), { recursive: true });
  return dir;
}

/** True if an influencer with this slug already has a persona.json on disk. */
export async function exists(slug) {
  return existsSync(join(INFLUENCERS_DIR, slug, "persona.json"));
}

/**
 * Generate a new influencer: persona record + N reference stills via
 * fal-ai/nano-banana-2. Does NOT lock a canonical face — the operator
 * picks via lock() once they've seen the refs.
 *
 * @param {object} args
 * @param {string} args.name        Operator-given name; becomes folder slug
 * @param {string} args.persona     Free-text persona ("mid-20s British skater,
 *                                  scruffy, into streetwear and coffee")
 * @param {string} args.look        Free-text physical description
 *                                  ("dark hair, beard, hoodie always, 5'10")
 * @param {string} [args.aesthetic] Visual style hint ("candid phone photography",
 *                                  "cinematic editorial", "polished commercial")
 * @param {string} [args.platform]  "tiktok" | "instagram" | "youtube" | etc —
 *                                  used to bias aspect ratio defaults
 * @param {number} [args.count]     1-4 references. Default 3.
 * @param {boolean} [args.overwrite] Overwrite an existing influencer of the
 *                                   same slug. Default false (fails loudly).
 * @returns {Promise<object>} { ok, slug, dir, persona, refs:[{ idx, path }] }
 */
export async function create({ name, persona, look, aesthetic = "", platform = "tiktok", count = 3, overwrite = false, rephrase = null }) {
  if (!Fal.isConfigured()) return { ok: false, error: "FAL_KEY not configured. Add FAL_KEY=<key> to .env and restart the bridge." };
  if (!name) return { ok: false, error: "name is required" };
  if (!persona) return { ok: false, error: "persona is required" };
  if (!look) return { ok: false, error: "look is required" };

  const slug = slugify(name);
  if (await exists(slug) && !overwrite) {
    return { ok: false, error: `An influencer named '${slug}' already exists. Pass overwrite:true to replace, or pick a different name.` };
  }
  const dir = await _influencerDir(slug);

  /* Aspect ratio default: TikTok / Reels / Shorts → 9:16, IG feed → 1:1,
   * YouTube long-form → 16:9. We generate refs in 1:1 because we want
   * face-forward portraits regardless of where the final content lands —
   * downstream tools (nano-banana-pro hero shots, Kling Motion Control)
   * accept the canonical.png and re-frame as needed. */
  const refsAspect = "1:1";
  const refsCount = Math.max(1, Math.min(4, Number(count) || 3));

  /* Why this prompt structure: nano-banana-2 follows positive descriptors
   * very literally. We lead with "portrait reference" so it understands the
   * intent (a face we'll re-use), then layer persona / look / aesthetic in
   * priority order. Trailing "consistent face across frames" nudges it
   * toward producing variations of one person when num_images>1, rather
   * than 3 different people who happen to match the prompt. */
  const refPrompt = [
    `Portrait reference photograph of ${name}.`,
    persona,
    `Look: ${look}.`,
    aesthetic ? `Aesthetic: ${aesthetic}.` : "",
    `Single subject, face clearly visible, neutral expression, evenly lit.`,
    `Consistent identity across frames — same person, same facial structure.`,
    `Photorealistic, high quality, no text, no watermark, no logos.`,
  ].filter(Boolean).join(" ");

  let result;
  let retried = false;
  let saferPrompt = null;
  try {
    /* nano-banana-2 ships per the model docs (https://fal.ai/models/fal-ai/nano-banana-2):
     *   prompt (req), aspect_ratio (enum), resolution (1K default), num_images (1-4)
     * Wrapped with the safety-retry helper so an IP/brand reject (the operator
     * spec'd "Mickey Mouse + Air Jordans + Bulls jersey" the first time around)
     * triggers an auto-rephrase + one retry instead of failing. */
    const wrapped = await Fal.runImageWithSafetyRetry("fal-ai/nano-banana-2", {
      prompt: refPrompt,
      aspect_ratio: refsAspect,
      num_images: refsCount,
      resolution: "1K",
    }, { timeoutMs: 90_000, rephrase: typeof rephrase === "function" ? rephrase : undefined });
    result = wrapped.result;
    retried = wrapped.retried;
    saferPrompt = wrapped.saferPrompt || null;
  } catch (e) {
    return { ok: false, error: `nano-banana-2 failed: ${e.message}`, slug };
  }

  const images = Array.isArray(result?.images) ? result.images : [];
  if (!images.length) {
    return { ok: false, error: "fal returned no images", slug, raw: JSON.stringify(result).slice(0, 400) };
  }

  /* Download every returned URL to refs/ref-1.png … ref-N.png. fal URLs are
   * signed and expire ~1h, so we always materialise the bytes locally. */
  const refs = [];
  for (let i = 0; i < images.length; i++) {
    const url = images[i]?.url;
    if (!url) continue;
    const path = join(dir, "refs", `ref-${i + 1}.png`);
    await Fal.download(url, path);
    refs.push({ idx: i + 1, path });
  }

  const personaRecord = {
    name,
    slug,
    persona,
    look,
    aesthetic,
    platform,
    created_at: new Date().toISOString(),
    refs_aspect: refsAspect,
    refs_count: refs.length,
    fal_request_id: result?.request_id || null,
    /* If the safety filter rejected the original and we auto-rephrased, save
     * the rephrased prompt that actually produced these refs so subsequent
     * tools can reuse the wording without re-tripping the filter. */
    safety_rephrased: retried,
    final_prompt_used: retried ? saferPrompt : refPrompt,
    /* canonical.png + locked_at populate via lock() once the operator picks. */
  };
  await writeFile(join(dir, "persona.json"), JSON.stringify(personaRecord, null, 2));

  return {
    ok: true,
    slug,
    dir,
    persona: personaRecord,
    refs,
    next_step: `Show the operator the references in output/influencers/${slug}/refs/ and ask which one to lock as the canonical face. Then call lock_influencer with slug='${slug}' and ref_idx=<1..${refs.length}>.`,
  };
}

/**
 * Lock an influencer's canonical face: copies refs/ref-<idx>.png to
 * canonical.png and stamps locked_at on persona.json. After this point
 * downstream tools can resolve the influencer by slug.
 */
export async function lock({ slug, ref_idx }) {
  if (!slug) return { ok: false, error: "slug is required" };
  const idx = Number(ref_idx);
  if (!Number.isInteger(idx) || idx < 1) return { ok: false, error: "ref_idx must be a positive integer (1-based)" };
  const dir = join(INFLUENCERS_DIR, slug);
  if (!existsSync(join(dir, "persona.json"))) {
    return { ok: false, error: `No influencer at slug '${slug}'. Create one first.` };
  }
  const refPath = join(dir, "refs", `ref-${idx}.png`);
  if (!existsSync(refPath)) {
    return { ok: false, error: `Reference ref-${idx}.png not found for '${slug}'.` };
  }
  const canonical = join(dir, "canonical.png");
  await copyFile(refPath, canonical);

  const personaRaw = await readFile(join(dir, "persona.json"), "utf8");
  const persona = JSON.parse(personaRaw);
  persona.locked_at = new Date().toISOString();
  persona.canonical_ref_idx = idx;
  await writeFile(join(dir, "persona.json"), JSON.stringify(persona, null, 2));

  return { ok: true, slug, canonical, persona };
}

/** Read an influencer's persona + canonical path. Returns null if not found
 *  or not yet locked (downstream tools should fail loudly when canonical is
 *  missing, since you can't drive Kling Motion Control without it). */
export async function get(slug) {
  const s = slugify(slug);
  const dir = join(INFLUENCERS_DIR, s);
  const personaPath = join(dir, "persona.json");
  if (!existsSync(personaPath)) return null;
  const persona = JSON.parse(await readFile(personaPath, "utf8"));
  const canonical = join(dir, "canonical.png");
  return {
    slug: s,
    dir,
    persona,
    canonical: existsSync(canonical) ? canonical : null,
    locked: !!persona.locked_at,
  };
}

/** Enumerate all known influencers (sorted by created_at desc). Used by the
 *  voice loop to resolve "using Marcus" → slug, and by the HUD modal that
 *  lists available characters. */
export async function list() {
  if (!existsSync(INFLUENCERS_DIR)) return [];
  const entries = await readdir(INFLUENCERS_DIR, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const personaPath = join(INFLUENCERS_DIR, ent.name, "persona.json");
    if (!existsSync(personaPath)) continue;
    try {
      const persona = JSON.parse(await readFile(personaPath, "utf8"));
      out.push({
        slug: persona.slug || ent.name,
        name: persona.name || ent.name,
        platform: persona.platform || "",
        locked: !!persona.locked_at,
        created_at: persona.created_at || null,
      });
    } catch { /* skip corrupt entries */ }
  }
  out.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return out;
}

/** Match a free-text "name" reference (from voice transcription) against
 *  known influencer slugs. Used when the operator says "using Marcus" and
 *  we need the canonical.png path. Case-insensitive, accepts either name
 *  or slug, returns the persona record or null. */
export async function findByName(query) {
  if (!query) return null;
  const all = await list();
  const q = String(query).trim().toLowerCase();
  /* Exact slug match wins; falls back to first-name match (e.g. "marcus"
   * matching slug "marcus" or name "Marcus Lane"). Avoids fuzzy matching
   * on purpose — we'd rather return null and let the operator clarify
   * than pick the wrong influencer for a $0.84 Kling call. */
  return all.find((i) => i.slug === q) ||
         all.find((i) => String(i.name).toLowerCase() === q) ||
         all.find((i) => String(i.name).toLowerCase().split(/\s+/)[0] === q) ||
         null;
}
