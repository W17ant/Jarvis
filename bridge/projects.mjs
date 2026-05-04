/** projects.mjs - Active project tracking + shoot-folder enumeration.
 *
 *  Why: at scale, the operator's mental model is "I'm working on the press car
 *  campaign". Without a project context, every voice command has to re-spell
 *  the subject. Setting an active project means find_frame, generate_shoot_report,
 *  hero_contact_sheet, and any other shoot-folder-default tool implicitly scopes
 *  to it.
 *
 *  v1 minimum:
 *    - listProjects()       — enumerate shoots/ directories with mtime + counts
 *    - getActive()          — read the in-memory active project id
 *    - setActive(id|null)   — set/clear; null = no scope
 *    - systemPromptHint()   — string fragment for askLLM to prepend
 *
 *  Active project is bridge-process state (single-operator kiosk). Persistence
 *  comes from the HUD posting on boot — survives bridge restart that way. */

import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as Paths from "./paths.mjs";

/* SHOOTS_DIR resolved at call sites via Paths.getShootsDir(). */

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".tiff", ".dng", ".arw", ".cr2", ".cr3", ".nef", ".raf"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".avi", ".mkv", ".braw", ".r3d"]);

let activeProjectId = null;     /* shoot folder name; null = no active scope */

/** Pretty-print a folder name like "2026-05-01-press-car" → "the press car". */
export function prettyName(folder) {
  if (!folder) return "(none)";
  const stripped = folder.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]/g, " ").trim();
  return stripped ? stripped.replace(/\b\w/g, c => c.toUpperCase()) : folder;
}

/**
 * List shoot folders under shoots/, with mtime + image/video counts. Newest first.
 * Used by the HUD's project picker. Returns max 20 most-recent.
 */
export async function listProjects() {
  const shootsDir = Paths.getShootsDir();
  if (!existsSync(shootsDir)) return [];
  const ents = await readdir(shootsDir, { withFileTypes: true });
  const dirs = ents.filter(e => e.isDirectory()).map(e => e.name);
  if (!dirs.length) return [];

  const out = [];
  for (const name of dirs) {
    const full = path.join(shootsDir, name);
    let st;
    try { st = await stat(full); } catch { continue; }
    /* Per-folder file enumeration — counts only, no recursion. Cheap enough for
     * a kiosk-scale shoots/ dir (≤ a few hundred folders). */
    let images = 0, videos = 0;
    try {
      for (const f of await readdir(full)) {
        const ext = path.extname(f).toLowerCase();
        if (IMAGE_EXTS.has(ext)) images++;
        else if (VIDEO_EXTS.has(ext)) videos++;
      }
    } catch { /* unreadable subfolder — skip counts */ }

    out.push({
      id: name,                       /* the folder basename — stable across boots */
      label: prettyName(name),
      mtimeMs: st.mtimeMs,
      images,
      videos,
    });
  }
  /* Newest first; cap to 20 so the picker doesn't scroll forever. */
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 20);
}

/** Read the currently-active project (or null). */
export function getActive() { return activeProjectId; }

/** Set the active project. id null/empty clears. */
export function setActive(id) {
  if (!id) { activeProjectId = null; return null; }
  activeProjectId = String(id);
  return activeProjectId;
}

/**
 * Returns a one-line system-prompt fragment for the LLM, e.g.
 *   "ACTIVE PROJECT: 2026-05-01-press-car (the press car)."
 * Empty string when no project is active. askLLM concatenates this into the
 * system prompt so tool calls inherit the scope without explicit mentions. */
export function systemPromptHint() {
  if (!activeProjectId) return "";
  return `\n\nACTIVE PROJECT: ${activeProjectId} (${prettyName(activeProjectId)}). When the operator's request implies a shoot folder, default to this project unless they explicitly name a different one.`;
}
