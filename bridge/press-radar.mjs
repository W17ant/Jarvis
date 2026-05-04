/** press-radar.mjs - Daily automotive press-cycle scanner.
 *
 *  Why: an agency wins by being first to call. When the client announces a the press car
 *  successor or McLaren teases a new hypercar, FOM should know within hours,
 *  not days. This module does a periodic sweep of the manufacturers FOM tracks,
 *  pulls press signals from major outlets, persists to JSONL for the COMMS
 *  panel + voice queries.
 *
 *  Default tracked manufacturers + outlets are conservative — operator-tunable
 *  via config/press-radar.json (auto-created with sensible defaults).
 *
 *  Storage: data/press-signals.jsonl, append-only newest-last. */

import { writeFile, readFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SIGNALS_PATH = path.join(PROJECT_DIR, "data", "press-signals.jsonl");
const CONFIG_PATH = path.join(PROJECT_DIR, "config", "press-radar.json");

const DEFAULT_CONFIG = {
  manufacturers: ["the manufacturer", "McLaren", "Bentley", "Lotus", "Bugatti", "Pagani", "Ferrari", "Lamborghini"],
  outlets: ["topgear.com", "autocar.co.uk", "carwow.co.uk", "motor1.com", "evo.co.uk"],
  /* How many tracked manufacturers to query per sweep — keep tight to avoid
   * hammering search endpoints + spending Qwen budget. */
  maxPerSweep: 3,
};

async function loadConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    /* Auto-create on first run so operators have something to edit. */
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
      await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    } catch { /* missing config dir / non-writable — keep defaults */ }
    return DEFAULT_CONFIG;
  }
}

/** DuckDuckGo HTML scraper — same shape as agency.mjs's internal helper. */
async function webSearch(query, max = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const r = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 AppleWebKit/605.1.15", "accept": "text/html" },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    /* Iterate via matchAll which is cleaner than the iterator-with-mutation pattern. */
    for (const m of html.matchAll(re)) {
      const link = decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [, m[1]])[1]);
      const title = m[2].replace(/<[^>]+>/g, "").trim();
      const snippet = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (title && link) out.push({ title, url: link, snippet });
      if (out.length >= max) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Run one radar sweep. Searches each tracked manufacturer (subset per maxPerSweep),
 * collects recent press hits, persists to JSONL, returns the new signals.
 */
export async function runRadar(args = {}) {
  const config = await loadConfig();
  const targets = args.manufacturer
    ? [args.manufacturer]
    : config.manufacturers.slice(0, config.maxPerSweep);

  const newSignals = [];
  for (const m of targets) {
    /* Site-restricted query targeting any of the configured outlets. DuckDuckGo
     * supports site: queries via OR. */
    const siteFilter = config.outlets.map(o => `site:${o}`).join(" OR ");
    const query = `"${m}" (${siteFilter}) news 2026`;
    const hits = await webSearch(query, 5);
    for (const h of hits) {
      newSignals.push({
        ts: Date.now(),
        manufacturer: m,
        title: h.title,
        url: h.url,
        snippet: h.snippet?.slice(0, 280),
      });
    }
  }

  if (!args.dryRun && newSignals.length) {
    if (!existsSync(path.dirname(SIGNALS_PATH))) await mkdir(path.dirname(SIGNALS_PATH), { recursive: true });
    /* Append each as JSONL — easier to tail + grep + share than one big JSON. */
    const lines = newSignals.map(s => JSON.stringify(s)).join("\n") + "\n";
    await appendFile(SIGNALS_PATH, lines);
  }

  return {
    ok: true,
    sweptManufacturers: targets,
    signalsFound: newSignals.length,
    signals: newSignals.slice(0, 10),
    summary: newSignals.length
      ? `Press radar swept ${targets.length} manufacturer${targets.length === 1 ? "" : "s"}, found ${newSignals.length} recent stories. Top: ${newSignals[0]?.title?.slice(0, 100)}.`
      : `Press radar swept ${targets.length} manufacturer${targets.length === 1 ? "" : "s"} — no recent press to surface today.`,
  };
}

/** Read the most-recent N signals for the COMMS poller to surface. */
export async function recentSignals(limit = 10) {
  if (!existsSync(SIGNALS_PATH)) return [];
  try {
    const raw = await readFile(SIGNALS_PATH, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Schedule daily sweep at 09:00 (start of UK working day). */
export function schedule() {
  const next = () => {
    const now = new Date();
    const target = new Date();
    target.setHours(9, 0, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
  };
  const arm = () => {
    setTimeout(async () => {
      try {
        const r = await runRadar();
        if (r.signalsFound) console.log(`[press-radar] ${r.summary}`);
      } catch (e) {
        console.warn(`[press-radar] sweep failed: ${e.message}`);
      }
      arm();
    }, next());
  };
  arm();
}
