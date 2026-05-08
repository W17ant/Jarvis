/** brand.mjs - White-label brand loader.
 *  Reads config/brand.json on bridge startup; HUD + voice loop fetch the canonical
 *  brand from /brand so wake phrase, agent name, colours, and logo are swappable
 *  per-install without touching code.
 *
 *  How to apply:
 *    - server.mjs imports loadBrand() and exposes a /brand HTTP endpoint
 *    - index.html bootstraps with /brand and injects CSS variables before render
 *    - voice.js fetches /brand once, uses brand.agent.wakePhrase + mishears
 *    - System prompt for the LLM substitutes ${brand.agent.name} for "Jarvis"
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BRAND_PATH = path.join(PROJECT_DIR, "config", "brand.json");

/* Why: hard-coded fallback so a missing/corrupt brand.json doesn't crash the bridge. */
const FALLBACK = {
  agent: {
    name: "Jarvis",
    wakePhrase: "hey jarvis",
    wakeMishears: ["hey jarvis", "jarvis"],
    voice: "bm_daniel",
  },
  agency: {
    name: "Jarvis AI",
    tagline: "",
    domain: "",
    /* Per-platform social handles. Replaces the legacy single `social` string —
     * loadBrand() migrates the old field into socials.instagram on read so
     * existing installs don't break. Empty strings = "not configured" and the
     * primary-handle picker (used by watermarks + boilerplate) falls through. */
    socials: { facebook: "", instagram: "", x: "", tiktok: "" },
    /* Kept for backwards compat in any tooling that read the old key directly.
     * loadBrand() will keep this in sync with socials.instagram. */
    social: "",
  },
  colors: {
    primary: "#00d4ff", primaryDeep: "#0077a8",
    primaryGlow: "rgba(0,212,255,0.55)", primaryTint: "rgba(0,212,255,0.06)",
    ink0: "#000", ink1: "#0a0a0a", ink2: "#141414",
    text: "#f4f4f4", textDim: "rgba(244,244,244,0.55)",
  },
  fonts: { display: "Oswald", body: "Rubik", mono: "JetBrains Mono" },
  logo: { wordmarkPng: null, wordmarkSvg: null, iconPng: null, iconSvg: null },
};

let cached = null;

/**
 * Load the brand config from disk. Cached after first read for the process lifetime.
 * @returns {object} merged brand object (file values override fallbacks key-by-key)
 */
export function loadBrand() {
  if (cached) return cached;
  if (!existsSync(BRAND_PATH)) {
    console.warn("[brand] config/brand.json not found — using Jarvis fallback. Run ./tools/setup-wizard.mjs to white-label.");
    cached = FALLBACK;
    return cached;
  }
  try {
    const raw = JSON.parse(readFileSync(BRAND_PATH, "utf8"));
    cached = {
      agent:   { ...FALLBACK.agent,   ...(raw.agent || {}) },
      agency:  { ...FALLBACK.agency,  ...(raw.agency || {}) },
      colors:  { ...FALLBACK.colors,  ...(raw.colors || {}) },
      fonts:   { ...FALLBACK.fonts,   ...(raw.fonts || {}) },
      logo:    { ...FALLBACK.logo,    ...(raw.logo || {}) },
    };
    /* Migrate legacy `agency.social` (single handle string) → `agency.socials.instagram`.
     * Done on read so old brand.json files keep working without a manual edit. The
     * single-string field is most often an Instagram handle in practice (matches what
     * the Jarvis example shipped with). Settings panel saves the new shape going
     * forward; the legacy field is kept in lock-step for any third-party reader. */
    cached.agency.socials = { ...FALLBACK.agency.socials, ...(raw.agency?.socials || {}) };
    if (!raw.agency?.socials && raw.agency?.social && !cached.agency.socials.instagram) {
      cached.agency.socials.instagram = String(raw.agency.social).trim();
    }
    cached.agency.social = cached.agency.socials.instagram || raw.agency?.social || "";
    /* Why: if the operator sets a custom name but doesn't touch wakePhrase, derive it. */
    if (!raw.agent?.wakePhrase && raw.agent?.name) {
      cached.agent.wakePhrase = `hey ${raw.agent.name.toLowerCase()}`;
    }
    /* And expand mishears with sensible variants if the operator only provided the name. */
    if (!raw.agent?.wakeMishears && raw.agent?.name) {
      cached.agent.wakeMishears = expandMishears(raw.agent.name);
    }
    return cached;
  } catch (e) {
    console.warn(`[brand] could not parse ${BRAND_PATH}: ${e.message} — using fallback`);
    cached = FALLBACK;
    return cached;
  }
}

/**
 * Generate plausible Whisper mishear variants for a given agent name.
 * Used as a default when the operator provides only the name.
 */
export function expandMishears(name) {
  const n = name.toLowerCase().trim();
  const stripped = n.replace(/[^a-z0-9 ]/g, "");
  const compact = stripped.replace(/\s+/g, "");
  const out = new Set([
    `hey ${n}`, `hey ${stripped}`, `hey ${compact}`,
    `hi ${n}`, `hi ${stripped}`,
    `hey, ${n}`, `hey, ${stripped}`,
    n, stripped, compact,
    `${n}s`, `${compact}s`,
  ]);
  return [...out];
}

/** Force a re-read on next loadBrand() — used after the wizard writes a new config. */
export function invalidateBrandCache() { cached = null; }

/**
 * Persist a brand patch to config/brand.json. The patch is shallow-merged
 * over the current brand so the settings panel can submit just the agent +
 * agency fields it touched without round-tripping logo/colors/fonts that
 * other surfaces own. Returns the merged brand. Throws on filesystem errors.
 *
 * @param {object} patch - partial brand object: { agent?, agency?, colors?, fonts?, logo? }
 * @returns {object} the new merged brand
 */
export function saveBrand(patch) {
  if (!patch || typeof patch !== "object") throw new Error("brand patch must be an object");
  const current = loadBrand();
  const merged = {
    agent:   { ...current.agent,   ...(patch.agent || {}) },
    agency:  { ...current.agency,  ...(patch.agency || {}) },
    colors:  { ...current.colors,  ...(patch.colors || {}) },
    fonts:   { ...current.fonts,   ...(patch.fonts || {}) },
    logo:    { ...current.logo,    ...(patch.logo || {}) },
  };
  if (patch.agency?.socials) {
    merged.agency.socials = { ...current.agency.socials, ...patch.agency.socials };
  }
  /* Auto-derive wake phrase + mishears from agent name when the operator
   * didn't supply them — keeps the settings panel from clobbering recognition
   * if they only changed the name. */
  if (patch.agent?.name && !patch.agent?.wakePhrase) {
    merged.agent.wakePhrase = `hey ${String(patch.agent.name).toLowerCase()}`;
  }
  if (patch.agent?.name && !patch.agent?.wakeMishears) {
    merged.agent.wakeMishears = expandMishears(patch.agent.name);
  }
  /* Strip empty-string mishears that would create a noop wake-variant entry. */
  if (Array.isArray(merged.agent.wakeMishears)) {
    merged.agent.wakeMishears = merged.agent.wakeMishears
      .map((s) => String(s || "").trim())
      .filter(Boolean);
  }
  /* Comment is preserved if it exists, just refreshed to note the last edit. */
  const out = { _comment: "Edited via the settings panel — see tools/setup-wizard.mjs to reset.", ...merged };
  mkdirSync(path.dirname(BRAND_PATH), { recursive: true });
  writeFileSync(BRAND_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  invalidateBrandCache();
  return loadBrand();
}

/**
 * Pick the agency's primary social handle for places that need a single string
 * (watermark credit lines, agency boilerplate). Priority order: Instagram → X →
 * TikTok → Facebook — Instagram first because that's where automotive content
 * agencies most commonly point credit. Returns "" if nothing is configured.
 *
 * @param {object} agency - the brand.agency object
 * @returns {string} the first non-empty handle, or ""
 */
export function primarySocialHandle(agency) {
  const s = agency?.socials || {};
  return s.instagram || s.x || s.tiktok || s.facebook || agency?.social || "";
}
