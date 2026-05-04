/** cache-prune.mjs - Bounded eviction for the on-disk caches.
 *
 *  Why: data/frame-cache/ accumulates extracted video keyframes (one .jpg per
 *  source clip × per cache hit). Over months a kiosk processes thousands of
 *  shoots; without eviction the cache will eventually fill the SSD. Same logic
 *  applies to data/weather-cache (smaller, but still unbounded).
 *
 *  Strategy:
 *    1. On bridge boot, run a sweep over each tracked cache dir.
 *    2. If total size exceeds the limit, evict OLDEST FILES (mtime) until under.
 *    3. Schedule the same sweep every 6 hours so long-running kiosks self-trim.
 *
 *  Why mtime not atime: atime is unreliable on macOS (relatime mount option) so
 *  we use mtime as a "last hit" approximation. Files written/touched within the
 *  cache get fresh mtime on rewrites; that's enough for LRU semantics. */

import { readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const TARGETS = [
  /* { dir, maxBytes, label } — tune limits per cache. Frame cache is the big one
   * because each shoot generates ≥4 keyframes per clip. */
  { dir: path.join(PROJECT_DIR, "data", "frame-cache"),     maxBytes: 5 * 1024 * 1024 * 1024, label: "frame-cache"   },
  { dir: path.join(PROJECT_DIR, "data", "weather-cache"),   maxBytes:     50 * 1024 * 1024,   label: "weather-cache" },
  { dir: path.join(PROJECT_DIR, "data", "trackday"),        maxBytes:    100 * 1024 * 1024,   label: "trackday"      },
];

/** Sweep a single dir. Returns { kept, removed, freedBytes }. */
async function sweep({ dir, maxBytes, label }) {
  if (!existsSync(dir)) return { label, kept: 0, removed: 0, freedBytes: 0 };
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return { label, kept: 0, removed: 0, freedBytes: 0 }; }

  /* Stat each file; ignore subdirs. */
  const files = [];
  let total = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    try {
      const st = await stat(full);
      files.push({ full, name: e.name, size: st.size, mtimeMs: st.mtimeMs });
      total += st.size;
    } catch { /* file disappeared between readdir and stat — skip */ }
  }

  if (total <= maxBytes) {
    return { label, kept: files.length, removed: 0, freedBytes: 0, totalBytes: total };
  }

  /* Sort oldest first; delete until under the cap. */
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let removed = 0, freed = 0;
  for (const f of files) {
    if (total - freed <= maxBytes) break;
    try { await unlink(f.full); freed += f.size; removed++; }
    catch { /* permission / race — skip */ }
  }
  return { label, kept: files.length - removed, removed, freedBytes: freed, totalBytes: total - freed };
}

/** Run all targets once. Logs a single line per target. */
export async function pruneOnce() {
  const results = await Promise.all(TARGETS.map(sweep));
  for (const r of results) {
    if (r.removed > 0) {
      console.log(`[cache-prune] ${r.label}: evicted ${r.removed} files, freed ${(r.freedBytes / 1024 / 1024).toFixed(1)}MB; ${(r.totalBytes / 1024 / 1024).toFixed(1)}MB / ${TARGETS.find(t => t.label === r.label).maxBytes / 1024 / 1024}MB now in use`);
    }
  }
  return results;
}

/** Schedule periodic pruning. Call once at bridge boot. */
export function scheduleHourly(intervalMs = 6 * 60 * 60 * 1000) {
  /* Initial sweep ~5s after boot so it doesn't block startup. */
  setTimeout(() => pruneOnce().catch(e => console.warn(`[cache-prune] sweep failed: ${e.message}`)), 5_000);
  setInterval(() => pruneOnce().catch(() => {}), intervalMs);
}
