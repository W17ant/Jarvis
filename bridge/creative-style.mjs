/** creative-style.mjs — operator-authored creative style guide loader.
 *
 *  Reads config/creative-style.md if it exists and exposes its content for
 *  injection into the LLM system prompt. The file is the operator's
 *  equivalent of CLAUDE.md — they describe their editorial voice, visual
 *  preferences, edit pacing, brand vocabulary, and house rules so every
 *  generated draft (email, caption, press release, video brief) inherits
 *  the agency's signature.
 *
 *  Why a markdown file (not JSON):
 *    - Operators write prose, not nested keys
 *    - The model reads markdown natively and respects section headings
 *    - Easy to copy/paste from existing brand bibles
 *
 *  Cached for process lifetime; invalidate after the operator edits the file
 *  via the /style endpoint or saves through the settings panel.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STYLE_PATH = path.join(PROJECT_DIR, "config", "creative-style.md");

/* Hard upper bound. A creative-style file 16k+ chars is a sign the operator
 * has dumped a whole brand bible — fine, but we trim what we send to the model
 * to keep the per-turn token budget predictable. ~6000 chars ≈ ~1500 tokens. */
const MAX_PROMPT_CHARS = 6000;

let cached = null;
let cachedMtime = 0;

/**
 * Load the creative-style markdown. Returns the raw text or "" if absent.
 * @returns {string}
 */
export function loadCreativeStyle() {
  if (!existsSync(STYLE_PATH)) {
    cached = "";
    cachedMtime = 0;
    return "";
  }
  /* Why mtime check: operator may edit creative-style.md mid-session and we
   * want their changes to take effect on the next askLLM call without forcing
   * a bridge restart. Cheaper than re-reading the file every turn. */
  const mtime = statSync(STYLE_PATH).mtimeMs;
  if (cached !== null && mtime === cachedMtime) return cached;
  try {
    let raw = readFileSync(STYLE_PATH, "utf8").trim();
    if (raw.length > MAX_PROMPT_CHARS) {
      raw = raw.slice(0, MAX_PROMPT_CHARS) + "\n\n[...truncated — file exceeds 6000 char prompt budget; trim or split]";
    }
    cached = raw;
    cachedMtime = mtime;
    return cached;
  } catch (e) {
    console.warn(`[creative-style] could not read ${STYLE_PATH}: ${e.message}`);
    return "";
  }
}

/**
 * Format the loaded style for inclusion in the system prompt. Returns a
 * pre-pended block with a clear header so the model recognises it as
 * agency-defined creative direction, or "" if no style file exists.
 *
 * The header phrasing ("CREATIVE STYLE GUIDE — agency house rules") is
 * deliberate: it tells the model the rules outrank the model's defaults
 * for tone/voice, but does NOT outrank the spoken-output / safety rules
 * that follow in the main system prompt.
 *
 * @returns {string}
 */
export function creativeStylePromptBlock() {
  const text = loadCreativeStyle();
  if (!text) return "";
  return `\n\nCREATIVE STYLE GUIDE — agency house rules. Apply these to every email draft, caption, press release, video brief, or other generated content. They override your default tone/voice but never override the spoken-output rules or confirmation contracts below.\n\n${text}\n\n---\n\n`;
}

/** Reset the cache — used after the operator saves an edit. */
export function invalidateCreativeStyleCache() {
  cached = null;
  cachedMtime = 0;
}

/** Path to the active style file (for /style endpoint + diagnose bundle). */
export function creativeStylePath() {
  return STYLE_PATH;
}
