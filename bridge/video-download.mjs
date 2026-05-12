/** video-download.mjs — yt-dlp wrapper for the influencer-recreation flow.
 *
 *  Why a thin wrapper rather than calling yt-dlp inline: the recreation
 *  pipeline downloads source clips from TikTok / IG Reels / YT Shorts / X
 *  and we want a single place to handle errors (geo-blocks, login walls,
 *  deleted clips), enforce a sane timeout, and pin the output filename so
 *  Kling Motion Control receives a known path. Keeping it isolated also
 *  means future fallbacks (cobalt.tools, gallery-dl) plug in here without
 *  touching server.mjs.
 *
 *  yt-dlp ships from Homebrew on the operator's kiosk (`brew install yt-dlp`),
 *  resolved at module load via _resolveYtDlp() so we fail loudly with a
 *  clear hint if it's missing instead of an opaque ENOENT mid-flow.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

const execFileP = promisify(execFile);

/* Hard cap on download wallclock. Most TikTok clips download in <5s on
 * a normal connection; bumping to 60s tolerates a slow link without
 * letting a stuck process hold the bridge thread indefinitely. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

let _ytDlpPath = null;

/** Locate yt-dlp on PATH (or common Homebrew locations). Cached. */
async function _resolveYtDlp() {
  if (_ytDlpPath) return _ytDlpPath;
  const candidates = ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp", "yt-dlp"];
  for (const c of candidates) {
    try {
      await execFileP(c, ["--version"], { timeout: 5_000 });
      _ytDlpPath = c;
      return c;
    } catch { /* try next */ }
  }
  throw new Error(
    "yt-dlp not found on PATH. Install via Homebrew (`brew install yt-dlp`) " +
    "or download from https://github.com/yt-dlp/yt-dlp/releases."
  );
}

/**
 * Download a video URL to a local mp4. Resolves with the dest path on
 * success, throws with an operator-friendly message on failure.
 *
 * @param {string} url       Source URL (TikTok, IG, YT, X, …)
 * @param {string} destPath  Absolute local path to write the mp4 to.
 *                           Parent dir is created if missing. Existing
 *                           file at this path is overwritten by yt-dlp.
 * @returns {Promise<{ path: string, sizeBytes: number, elapsedMs: number, format: string }>}
 */
export async function download(url, destPath) {
  if (!url || typeof url !== "string") throw new Error("url is required");
  if (!destPath) throw new Error("destPath is required");
  const yt = await _resolveYtDlp();
  await mkdir(dirname(destPath), { recursive: true });

  const t0 = Date.now();
  /* Why these flags:
   *   -o <path>          — exact output path (no template interpolation surprises)
   *   --no-playlist      — defensive: a TikTok/IG link can sometimes resolve to a
   *                        creator's full feed; clamp to the single video
   *   --merge-output-format mp4 — combine separate video + audio streams into mp4
   *                        so Kling and QuickTime both accept it without re-mux
   *   --no-warnings      — keep stderr clean for our error parsing
   *   --quiet            — same; we don't need progress lines */
  try {
    const { stdout } = await execFileP(yt, [
      "-o", destPath,
      "--no-playlist",
      "--merge-output-format", "mp4",
      "--no-warnings",
      "--quiet",
      "--print", "after_move:%(format_id)s",
      url,
    ], { timeout: DOWNLOAD_TIMEOUT_MS });
    const format = (stdout || "").trim() || "unknown";
    const s = await stat(destPath);
    return {
      path: destPath,
      sizeBytes: s.size,
      elapsedMs: Date.now() - t0,
      format,
    };
  } catch (e) {
    /* Map common yt-dlp failure modes into operator-readable messages.
     * The full stderr is sometimes hundreds of lines; trim to the most
     * recent error line which is almost always the actionable one. */
    const stderr = String(e?.stderr || e?.message || "").trim();
    const lastErr = stderr.split("\n").reverse().find((l) => /error|unavailable|private|geo|login/i.test(l)) || stderr;
    if (/private|login required|sign in/i.test(lastErr)) {
      throw new Error(`Source video requires a login (private or auth-walled): ${lastErr.slice(0, 200)}`);
    }
    if (/geo|country|region/i.test(lastErr)) {
      throw new Error(`Source video is geo-blocked from this region: ${lastErr.slice(0, 200)}`);
    }
    if (/unavailable|deleted|not found|404/i.test(lastErr)) {
      throw new Error(`Source video has been removed or is unavailable: ${lastErr.slice(0, 200)}`);
    }
    if (/timeout|timed out/i.test(lastErr) || e?.killed) {
      throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s — slow connection or stalled stream.`);
    }
    throw new Error(`yt-dlp failed: ${lastErr.slice(0, 300)}`);
  }
}

/** True if the URL string looks like something yt-dlp can plausibly handle.
 *  Used as a cheap pre-flight before firing the subprocess. Liberal on
 *  purpose — the real validation is yt-dlp's own. */
export function looksDownloadable(url) {
  if (!url || typeof url !== "string") return false;
  return /^https?:\/\/[^\s]+/i.test(url.trim());
}
