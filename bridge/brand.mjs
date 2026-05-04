/** brand.mjs - White-label brand loader.
 *  Reads config/brand.json on bridge startup; HUD + voice loop fetch the canonical
 *  brand from /brand so wake phrase, agent name, colours, and logo are swappable
 *  per-install without touching code.
 *
 *  How to apply:
 *    - server.mjs imports loadBrand() and exposes a /brand HTTP endpoint
 *    - index.html bootstraps with /brand and injects CSS variables before render
 *    - voice.js fetches /brand once, uses brand.agent.wakePhrase + mishears
 *    - System prompt for the LLM substitutes ${brand.agent.name} for "Flat-Out"
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BRAND_PATH = path.join(PROJECT_DIR, "config", "brand.json");

/* Why: hard-coded fallback so a missing/corrupt brand.json doesn't crash the bridge. */
const FALLBACK = {
  agent: {
    name: "Flat-Out",
    wakePhrase: "hey flat-out",
    wakeMishears: ["hey flat-out", "flat-out"],
    voice: "bm_daniel",
  },
  agency: { name: "Flat-Out Media", tagline: "", social: "", domain: "" },
  colors: {
    primary: "#E10600", primaryDeep: "#8F0003",
    primaryGlow: "rgba(225,6,0,0.55)", primaryTint: "rgba(225,6,0,0.06)",
    ink0: "#000", ink1: "#0a0a0a", ink2: "#141414",
    text: "#f4f4f4", textDim: "rgba(244,244,244,0.55)",
  },
  fonts: { display: "Oswald", body: "Rubik", mono: "JetBrains Mono" },
  logo: { wordmarkPng: "assets/fom-wordmark.png", wordmarkSvg: null, iconPng: null, iconSvg: null },
};

let cached = null;

/**
 * Load the brand config from disk. Cached after first read for the process lifetime.
 * @returns {object} merged brand object (file values override fallbacks key-by-key)
 */
export function loadBrand() {
  if (cached) return cached;
  if (!existsSync(BRAND_PATH)) {
    console.warn("[brand] config/brand.json not found — using Flat-Out fallback. Run ./tools/setup-wizard.mjs to white-label.");
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
