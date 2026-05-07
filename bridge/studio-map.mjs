/** studio-map.mjs - Cached structured digest of "what's in this kiosk right now".
 *
 *  Inspired by Aider's repo-map pattern: pre-compute a token-budgeted
 *  summary of operator state once, cache it, and let any LLM call drop
 *  it into context for instant grounding without re-querying memory /
 *  filesystem / databases on every turn.
 *
 *  What goes in:
 *    - Active project (top of mind for the operator)
 *    - Recent shoots (last 5 folders by mtime — what they're cutting)
 *    - Active media days (next 3 in the next 60 days)
 *    - Project list (active client work)
 *    - Top contacts (most recently added/referenced)
 *    - Operator name + agency name
 *    - Today's calendar count + last conversation timestamp
 *
 *  What stays out:
 *    - Anything secret (no API keys, no card details)
 *    - Anything that requires async I/O > a few ms (we don't want a slow
 *      cache rebuild blocking a chat turn)
 *    - The full memory contents — that's what `recall` is for; the studio
 *      map is a quick orient, not a search.
 *
 *  Cache TTL is 60 seconds. Operator-driven events (inbox drop, project
 *  switch, new media day) can call invalidate() to force a rebuild on next
 *  read. Token budget is enforced by truncating list lengths — we don't
 *  use a tokeniser; rough char-to-token approximation (1 token ≈ 4 chars)
 *  is good enough for "keep the prompt under 2KB".
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Memory from "./memory.mjs";
import * as MediaDays from "./media-days.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");

const CACHE_TTL_MS = 60_000;
let _cache = null;        // { digest, ts }

export function invalidate() { _cache = null; }

/** Read top-level shoots folder entries — directories only, sorted newest. */
async function listRecentShoots(limit = 5) {
  const shootsDir = path.join(PROJECT_DIR, "shoots");
  try {
    const ents = await fsp.readdir(shootsDir, { withFileTypes: true });
    const dirs = ents.filter((e) => e.isDirectory()).map((e) => e.name);
    /* Stat each for mtime; tolerate failures (returns 0). Cheap on small
     * shoot counts; if shoots/ ever gets thousands of entries, swap to a
     * cheaper "first N alphabetical" heuristic. */
    const withTimes = await Promise.all(dirs.map(async (name) => {
      try { return { name, ts: (await fsp.stat(path.join(shootsDir, name))).mtimeMs }; }
      catch { return { name, ts: 0 }; }
    }));
    withTimes.sort((a, b) => b.ts - a.ts);
    return withTimes.slice(0, limit).map((e) => e.name);
  } catch { return []; }
}

/** Format an ISO timestamp as a relative-friendly "2h ago" / "3d ago". */
function fmtRelative(ts) {
  if (!ts) return "(never)";
  const diff = Date.now() - Number(ts);
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`;
  return `${Math.round(diff / 86400_000)}d ago`;
}

/** Build the full digest fresh. Internal — callers use buildStudioMap()
 *  which honours the cache. */
async function buildFresh() {
  const t0 = Date.now();
  const projectsResult = Memory.listProjects();
  const projects = (projectsResult?.projects || []).slice(0, 6);
  const shoots = await listRecentShoots(5);
  const mediaDays = MediaDays.listMediaDays({ daysAhead: 60 }).slice(0, 3);
  /* Last conversation timestamp — from the persistence layer, not the
   * in-memory ring. */
  const recentTurns = Memory.recentTurns({ limit: 1 });
  const lastTurnAt = recentTurns[0]?.ts || null;

  const lines = [];
  if (projects.length) {
    lines.push(`Active projects:`);
    for (const p of projects) {
      const meta = [p.client, p.status].filter(Boolean).join(" · ");
      lines.push(`  • ${p.name}${meta ? ` (${meta})` : ""}`);
    }
  }
  if (shoots.length) {
    lines.push(`Recent shoot folders: ${shoots.join(", ")}`);
  }
  if (mediaDays.length) {
    lines.push(`Upcoming media days:`);
    for (const m of mediaDays) {
      const detail = [m.manufacturer, m.vehicle, m.location, m.date].filter(Boolean).join(" · ");
      lines.push(`  • ${detail}`);
    }
  }
  if (lastTurnAt) {
    lines.push(`Last conversation: ${fmtRelative(lastTurnAt)}`);
  }

  const digest = lines.length ? lines.join("\n") : "(quiet kiosk — no projects, shoots, or media days on file)";
  return {
    digest,
    builtAt: Date.now(),
    elapsedMs: Date.now() - t0,
    sourceCounts: {
      projects: projects.length,
      shoots: shoots.length,
      mediaDays: mediaDays.length,
    },
  };
}

/**
 * Public entry. Returns the cached digest if it's fresh; otherwise rebuilds.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]  Skip cache, always rebuild.
 */
export async function buildStudioMap({ force = false } = {}) {
  if (!force && _cache && (Date.now() - _cache.ts) < CACHE_TTL_MS) {
    return { ..._cache.digest, fromCache: true };
  }
  const fresh = await buildFresh();
  _cache = { digest: fresh, ts: Date.now() };
  return { ...fresh, fromCache: false };
}
