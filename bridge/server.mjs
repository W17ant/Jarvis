/** server.mjs - Jarvis HUD bridge.
 *  Single Node process that the HUD frontend talks to over websocket.
 *  Provides: real system stats, Ollama LLM proxy, weather, calendar/mail
 *  bridges, video edit pipeline, vision, brand-pack export, agency tools.
 *
 *  Run: node bridge/server.mjs    (from project root) */

import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import { buildProductionTeaser, TEASER_STAGES } from "./edit.mjs";
import { createPdf, listTemplates as listPdfTemplates } from "./pdf.mjs";
import { getUpcomingEvents, addCalendarEvent, invalidate as invalidateCalendar } from "./calendar.mjs";
import { getMailSummary, draftEmail } from "./mail.mjs";
import { runShell, writeFileSandboxed, shellAllowlist } from "./shell.mjs";
import * as Memory from "./memory.mjs";
import * as Vision from "./vision.mjs";
import * as MacControl from "./mac-control.mjs";
import * as Agency from "./agency.mjs";
import * as Youtube from "./youtube.mjs";
import * as Fal from "./fal.mjs";
import * as Influencers from "./influencers.mjs";
import * as VideoDownload from "./video-download.mjs";
import { loadBrand, invalidateBrandCache, saveBrand } from "./brand.mjs";
import { creativeStylePromptBlock, loadCreativeStyle, invalidateCreativeStyleCache, creativeStylePath, setOverridePath as setCreativeStyleOverride } from "./creative-style.mjs";
import * as Tasks from "./tasks.mjs";
import * as News from "./news.mjs";
import * as InfluencerPipeline from "./influencer-pipeline.mjs";
import * as Prewarm from "./prewarm.mjs";
import * as Audit from "./audit.mjs";
import * as Usage from "./usage.mjs";
import * as ModelRouter from "./model-router.mjs";
import { warmUpAll } from "./warmup.mjs";
import * as Notify from "./notifications.mjs";
import * as Undo from "./undo.mjs";
import * as Projects from "./projects.mjs";
import * as Paths from "./paths.mjs";
import { handleMcpRpc } from "./mcp.mjs";
import * as CachePrune from "./cache-prune.mjs";
import * as Window from "./window.mjs";
import * as DreamCycle from "./dream-cycle.mjs";
import * as DailyDigest from "./daily-digest.mjs";
import { exportBrandPack } from "./brandpack.mjs";
import * as Purchases from "./purchases.mjs";
import * as Browse from "./browse.mjs";
import * as LlmProviders from "./llm/providers.mjs";
import * as Personal from "./personal.mjs";
import * as Transcribe from "./transcribe.mjs";
import * as UsageLog from "./usage-log.mjs";
import * as EodDigest from "./eod-digest.mjs";
import * as FastPath from "./fast-path.mjs";
import * as FastPathCandidates from "./fast-path-candidates.mjs";
import * as Crew from "./crew.mjs";
import * as CrewHelpers from "./crew-helpers.mjs";
import * as IMessageListener from "./imessage-listener.mjs";
import * as Knowledge from "./knowledge.mjs";
import * as CodeAgent from "./code-agent.mjs";
import * as Office from "./office.mjs";
import * as ToolRouter from "./tool-router.mjs";
import * as Macmon from "./macmon.mjs";
import * as PluginLoader from "./plugin-loader.mjs";
import * as PluginGenerator from "./plugin-generator.mjs";
import * as Workspaces from "./workspaces.mjs";
import * as WorkspaceExport from "./workspace-export.mjs";
import * as Inbox from "./inbox.mjs";
import { withWorkspace, getCallWorkspace } from "./call-context.mjs";
import * as Sessions from "./sessions.mjs";
import * as SystemWarnings from "./system-warnings.mjs";
import * as CrashReporter from "./crash-reporter.mjs";

const execp = promisify(exec);

/* ---------- ENV ---------- */
const FOM_ENV_PATH = "/Users/Antony/Desktop/AI-Custom-Cards/.env.local";
function loadEnvFile(path) {
  try {
    const txt = readFileSync(path, "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  } catch (e) { console.warn(`[bridge] could not read ${path}: ${e.message}`); }
}
loadEnvFile(FOM_ENV_PATH);
/* Why: project-root .env (written by tools/setup-wizard.mjs) holds local overrides like
 * OLLAMA_MODEL, VL_MODEL, VL_KEEP_ALIVE, ANTHROPIC_API_KEY, OPENAI_API_KEY, plus any
 * operator-added custom keys via the settings panel. Loaded AFTER the shared key file
 * so a per-install .env wins over a shared file when both define the same var. */
const PROJECT_ENV_PATH = new URL("../.env", import.meta.url).pathname;
loadEnvFile(PROJECT_ENV_PATH);

/* Project root path — declared early so the boot summary block below can use
 * it without hitting the temporal-dead-zone. The same value is also re-derived
 * later in the file (one of those is now redundant; both expressions resolve
 * to the same path). */
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/* Voice-pipeline performance buffer (T1 sprint instrumentation). Rolling
 * window of the last 50 cycles' span summaries; reset on bridge restart.
 * GET /health/timings exposes p50/p95 per stage for the HUD debug panel. */
const _perfBuffer = [];

/* Sprint 12 — 1-second cache for /healthz so dual-tab boot bursts don't
 * double-fanout to Ollama/Kokoro/Whisper. Shape: { ts: ms, body: string }.
 * Cap freshness at 1s — operators can't perceive that lag, but two tabs
 * polling near-simultaneously share one probe round. */
let _healthzCache = null;

/* Sprint 12 — same pattern for /diary, but with a 12s TTL because /diary
 * legitimately takes 8-20s (AppleScript fanout to Calendar + Mail). The HAR
 * file from a 2-tab Chrome session showed /diary requests piling up in
 * Chrome's 6-slot per-origin pool, blocking /healthz polls behind them. With
 * a server-side cache + a single in-flight gate, two tabs share ONE
 * AppleScript run instead of doubling it. _diaryInFlight holds the Promise
 * for the active fanout so concurrent callers await the same resolution. */
let _diaryCache = null;
let _diaryInFlight = null;

/* Sprint 12 follow-up — same shape for /inbox and /comms which were
 * showing 120-second SLOW logs (AppleScript Mail/Calendar/Reminders
 * occasionally hangs on permission prompts or background-sync). Without
 * caps, those connections poison Chrome's 6-slot per-origin pool for
 * minutes, manifesting as the BR icon flashing even on a single tab.
 *
 * Cap shape: 8s hard timeout on the fanout, 60s cache TTL on the body.
 * If a fanout exceeds 8s, we fall back to the previous cached body
 * (stale-while-revalidate style); empty result if no prior cache. */
let _inboxCache = null, _inboxInFlight = null;
let _commsCache = null, _commsInFlight = null;
const SLOW_TIMEOUT_MS = 8000;

/** Parse "#RRGGBB" → { r, g, b }. Trusts caller-side regex validation. */
function hexToRgb(hex) {
  const h = hex.replace(/^#/, "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Shade a hex by `amt` (negative = darker, positive = lighter). Used to derive
 *  primaryDeep from a user-picked primary so the HUD's CSS gradient/border family
 *  scales coherently with the chosen accent. */
function shadeHex(hex, amt) {
  const { r, g, b } = hexToRgb(hex);
  const adjust = (c) => Math.max(0, Math.min(255, Math.round(c + (amt < 0 ? c * amt : (255 - c) * amt))));
  const toHex = (c) => c.toString(16).padStart(2, "0").toUpperCase();
  return "#" + toHex(adjust(r)) + toHex(adjust(g)) + toHex(adjust(b));
}

/** Update a single KEY=value in the project-root .env, preserving every other line.
 *  Used by /settings POST so model changes survive a bridge restart. */
async function persistEnvVar(key, value) {
  const fs = await import("node:fs/promises");
  let txt = "";
  try { txt = await fs.readFile(PROJECT_ENV_PATH, "utf8"); } catch {}
  const lines = txt.split("\n");
  let found = false;
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] === key) { found = true; return `${key}=${value}`; }
    return line;
  });
  if (!found) {
    /* Strip a trailing blank line so the appended entry doesn't double-space. */
    while (out.length && out[out.length - 1] === "") out.pop();
    out.push(`${key}=${value}`);
  }
  await fs.writeFile(PROJECT_ENV_PATH, out.join("\n") + "\n");
}

/* ---------- CONFIG ---------- */
let CONFIG = {
  operator: { city: "Leicester", country: "UK", latitude: 52.6369, longitude: -1.1398, timezone: "Europe/London" },
  agency: { name: "Jarvis AI", tagline: "your voice-first AI assistant", social: "", redHex: "#00d4ff" },
};
try {
  const raw = readFileSync(new URL("../config.json", import.meta.url), "utf8");
  CONFIG = { ...CONFIG, ...JSON.parse(raw) };
} catch (e) { console.warn(`[bridge] config.json not loaded (${e.message}); using defaults`); }

/** Auto-detect operator location via IP. Tries multiple free providers in order — first success wins.
 *  Skipped entirely if config.json sets lockLocation: true (fixed-kiosk install). */
const GEO_PROVIDERS = [
  {
    name: "ipwho.is",
    url: "https://ipwho.is/",
    pick: (j) => j.success && j.latitude && j.longitude && {
      city: j.city, country: j.country, latitude: j.latitude, longitude: j.longitude, timezone: j.timezone?.id,
    },
  },
  {
    name: "ipinfo.io",
    url: "https://ipinfo.io/json",
    pick: (j) => j.loc && {
      city: j.city, country: j.country, latitude: parseFloat(j.loc.split(",")[0]), longitude: parseFloat(j.loc.split(",")[1]), timezone: j.timezone,
    },
  },
  {
    name: "ipapi.co",
    url: "https://ipapi.co/json/",
    pick: (j) => j.latitude && j.longitude && j.city && {
      city: j.city, country: j.country_name || j.country, latitude: parseFloat(j.latitude), longitude: parseFloat(j.longitude), timezone: j.timezone,
    },
  },
];

async function autoDetectLocation({ force = false } = {}) {
  if (CONFIG.lockLocation && !force) {
    console.log(`[bridge] location locked by config: ${CONFIG.operator.city}`);
    return;
  }
  /* Remember the country we were in before this detect so we can flag a
   * travel event when it changes. First-ever detection (no prior country)
   * never raises a travel warning — that would just be "kiosk booted". */
  const priorCountry = CONFIG.operator.country || null;
  const priorCity = CONFIG.operator.city || null;
  for (const p of GEO_PROVIDERS) {
    try {
      const r = await fetch(p.url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) { console.warn(`[bridge] geo ${p.name}: status ${r.status}`); continue; }
      const j = await r.json();
      const picked = p.pick(j);
      if (!picked) { console.warn(`[bridge] geo ${p.name}: no usable fields`); continue; }
      CONFIG.operator = {
        ...CONFIG.operator,
        city: picked.city || CONFIG.operator.city,
        country: picked.country || CONFIG.operator.country,
        latitude: picked.latitude,
        longitude: picked.longitude,
        timezone: picked.timezone || CONFIG.operator.timezone,
      };
      console.log(`[bridge] auto-located via ${p.name}: ${CONFIG.operator.city}, ${CONFIG.operator.country} (${CONFIG.operator.latitude}, ${CONFIG.operator.longitude})  tz=${CONFIG.operator.timezone}`);
      /* Travel-companion alert: country flipped between detections. Suppressed
       * on first-ever boot (no prior country). Dedupe by destination so two
       * /redetect hits in a row don't re-toast. Clears on next country change. */
      const newCountry = CONFIG.operator.country;
      if (priorCountry && newCountry && priorCountry !== newCountry) {
        for (const w of SystemWarnings.list()) {
          if (w.code?.startsWith("travel.")) SystemWarnings.clear(w.code);
        }
        SystemWarnings.register({
          code: `travel.${newCountry}`,
          title: `Travel detected: ${priorCountry} → ${newCountry}`,
          body: `Was in ${priorCity || priorCountry}, now in ${CONFIG.operator.city}, ${newCountry}. Weather, timezone (${CONFIG.operator.timezone}), and clock have switched to local. Voice context (morning brief, smart inbox) will use the new location until you switch back. To pin to your home location open settings and toggle Lock Location.`,
          action: { label: "Open settings", href: "#settings" },
        });
        console.log(`[bridge] travel detected: ${priorCountry} -> ${newCountry}`);
      }
      return;
    } catch (e) {
      console.warn(`[bridge] geo ${p.name}: ${e.message}`);
    }
  }
  console.warn(`[bridge] all geo providers failed; using config default: ${CONFIG.operator.city}`);
}
// Run on startup; /config endpoint awaits this promise so the HUD setup modal sees the detected location.
const locationDetected = autoDetectLocation();

/* ---------- HARDWARE DETECT ---------- */
/** Probe the Mac for chip + memory, map to a performance tier so the HUD can throttle visuals
 *  and the LLM/Whisper layers can pick model sizes that fit. */
async function detectHardware() {
  try {
    const { stdout } = await execp("system_profiler SPHardwareDataType");
    const chip = (stdout.match(/Chip:\s+(.+)/) || stdout.match(/Processor Name:\s+(.+)/) || [, "Unknown"])[1].trim();
    const memory = (stdout.match(/Memory:\s+(\d+)\s+GB/) || [, "16"])[1];
    const memGB = parseInt(memory, 10);
    /* Tier rules — based on chip GPU power, not just RAM (RAM ≠ GPU compute):
     *   lite:     M1/M2 base, or anything <16GB
     *   standard: M1 Pro, M2 Pro, M3 base, M4 base, 16-24GB
     *   pro:      M1 Max, M2 Max, M3 Pro, M4 Pro, M5 Pro, 32-48GB
     *   max:      M3 Max, M4 Max, M5 Max, M-series Ultra
     */
    let tier = "standard";
    if (/M[345]\s+Max/i.test(chip) || /Ultra/i.test(chip)) tier = "max";
    else if (/Max/i.test(chip) || /M[345]\s+Pro/i.test(chip) || memGB >= 32) tier = "pro";
    else if (/Pro/i.test(chip) || memGB >= 16) tier = "standard";
    else tier = "lite";
    CONFIG.hardware = { chip, memoryGB: memGB, tier };
    console.log(`[bridge] hardware: ${chip}, ${memGB}GB → tier=${tier}`);
  } catch (e) {
    console.warn(`[bridge] hardware probe failed: ${e.message}`);
    CONFIG.hardware = { chip: "unknown", memoryGB: 16, tier: "standard" };
  }
}
const hardwareDetected = detectHardware();

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
/* Why: 32b text + 32b VL together exceed even M1/M2/M3 Max 64GB GPU headroom (verified
 * 2026-05-01 — VL alone consumed 46GB and stalled "Stopping..." for 30+s while text
 * couldn't load, dropping the assistant to offline-fallback mid-demo). Code default is
 * the **middle tier** (qwen2.5:14b text + qwen2.5vl:7b vision) — comfortable on any
 * 64GB Mac. For production M5 Max 96GB+, set in .env:
 *   OLLAMA_MODEL=qwen2.5:32b
 *   VL_MODEL=qwen2.5vl:32b
 *   VL_KEEP_ALIVE=10m
 * to get press-release-grade quality without GPU thrash. */
/* Why: model is mutable at runtime so the HUD's settings modal can switch from 14b to 32b
 * without restarting the bridge. Read via getModel(); write via setModel(). The .env file
 * is updated alongside so the choice survives a restart. */
let _activeModel = process.env.OLLAMA_MODEL || "qwen2.5:14b";
function getModel() { return _activeModel; }
function setModel(name) { _activeModel = name; process.env.OLLAMA_MODEL = name; }
/* Wire the live getter into the model router so a runtime model swap (settings
 * modal → save) is picked up on the next dispatch without a bridge restart. */
ModelRouter.setMainModelGetter(getModel);
const PORT = Number(process.env.PORT || 8766);

console.log(`[bridge] Ollama: ${OLLAMA_URL} (${getModel()})`);

/* Boot summary — single block that prints the operator-relevant config so a
 * non-developer reading /tmp/jarvis-bridge.log can see at a glance what's
 * configured and what's missing. Avoids forcing them to grep across 20 lines
 * for the bits that matter. Keys are reported as set/missing only, never the
 * value, matching the no-secrets-in-logs rule from SECURITY.md. */
const _bootKey = (name) => process.env[name] ? "set" : "(not set — feature disabled)";
console.log("[bridge] ── boot summary ──");
console.log(`[bridge]   Project root : ${PROJECT_ROOT}`);
console.log(`[bridge]   Text model   : ${getModel()}`);
console.log(`[bridge]   Vision model : ${process.env.VL_MODEL || "(unset)"}`);
/* Optional API key surfaces — kept in boot summary so operators can spot
 * mis-configured creds. FRAMEIO/SERPAPI/HUNTER tools were removed in the
 * white-label rebrand; the env-var hints stay so a fork can reintroduce
 * them without rewiring the boot diagnostics. */
console.log(`[bridge]   ANTHROPIC    : ${_bootKey("ANTHROPIC_API_KEY")}`);
console.log(`[bridge]   OPENAI       : ${_bootKey("OPENAI_API_KEY")}`);
console.log("[bridge] ──────────────────");

/* ---------- SYSTEM STATS ----------
 * Why: browsers are sandboxed from real CPU/RAM/net. We poll the OS here and push to clients. */
/* Returns { overall, perCore: [...] }. perCore is per-CPU utilisation 0..100.
 * The reactor HUD draws an individual rim arc for each core. */
async function getCpuPercent() {
  const a = os.cpus();
  await new Promise(r => setTimeout(r, 250));
  const b = os.cpus();
  const perCore = [];
  let totalIdle = 0, totalTotal = 0;
  for (let i = 0; i < a.length; i++) {
    const tA = Object.values(a[i].times).reduce((s, n) => s + n, 0);
    const tB = Object.values(b[i].times).reduce((s, n) => s + n, 0);
    const idleDelta = b[i].times.idle - a[i].times.idle;
    const totalDelta = tB - tA;
    totalIdle += idleDelta;
    totalTotal += totalDelta;
    const corePct = totalDelta > 0
      ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
      : 0;
    perCore.push(+corePct.toFixed(1));
  }
  const overall = Math.max(0, Math.min(100, (1 - totalIdle / totalTotal) * 100));
  return { overall, perCore };
}

async function getMemoryStats() {
  // Why: macOS reports unified memory unusually — vm_stat gives the truest picture
  try {
    const { stdout } = await execp("vm_stat");
    const lines = stdout.split("\n");
    const pageSize = 16384;  // M-series page size
    const get = (name) => {
      const m = lines.find(l => l.startsWith(name));
      if (!m) return 0;
      return parseInt(m.split(":")[1].trim().replace(".", ""), 10) || 0;
    };
    const free = get("Pages free") * pageSize;
    const active = get("Pages active") * pageSize;
    const inactive = get("Pages inactive") * pageSize;
    const wired = get("Pages wired down") * pageSize;
    const compressed = get("Pages occupied by compressor") * pageSize;
    const total = os.totalmem();
    const used = active + wired + compressed;
    return { totalGB: total / 1e9, usedGB: used / 1e9, freeGB: free / 1e9 };
  } catch {
    const total = os.totalmem();
    const free = os.freemem();
    return { totalGB: total / 1e9, usedGB: (total - free) / 1e9, freeGB: free / 1e9 };
  }
}

/**
 * GPU usage + memory + thermal pressure on Apple Silicon.
 * Why: HUD now shows GPU as a top-tier metric next to CPU/RAM. M-series exposes
 * "Device Utilization %" via IOAccelerator in ioreg (no sudo needed) — the same
 * field Activity Monitor reads. Thermal pressure comes from pmset -g therm and is
 * surfaced as a level string ("nominal" / "moderate" / "heavy") since no °C is
 * available without an extra dep. Returns nulls on non-Apple Silicon / parse failure.
 */
async function getGpuStats() {
  try {
    /* -l = full tree, -w 0 = unwrapped lines so utilisation field stays on one line. */
    const { stdout } = await execp("ioreg -l -w 0 -r -c IOAccelerator");
    const utilM = stdout.match(/"Device Utilization %"\s*=\s*(\d+)/);
    const allocM = stdout.match(/"Alloc system memory"\s*=\s*(\d+)/);
    const inUseM = stdout.match(/"In use system memory"\s*=\s*(\d+)/);
    const usagePct = utilM ? parseInt(utilM[1], 10) : null;
    const allocBytes = allocM ? parseInt(allocM[1], 10) : 0;
    const inUseBytes = inUseM ? parseInt(inUseM[1], 10) : 0;

    /* Thermal — no °C without OSX-CPU-Temp/iStats; surface the OS's own pressure level instead. */
    let thermal = "nominal";
    try {
      const { stdout: tStdout } = await execp("pmset -g therm");
      if (/Heavy/i.test(tStdout)) thermal = "heavy";
      else if (/Moderate/i.test(tStdout)) thermal = "moderate";
      else if (/Light/i.test(tStdout)) thermal = "light";
    } catch {}

    return {
      usagePct,
      allocGB: +(allocBytes / 1e9).toFixed(1),
      inUseGB: +(inUseBytes / 1e9).toFixed(1),
      thermal,
    };
  } catch {
    return { usagePct: null, allocGB: null, inUseGB: null, thermal: "unknown" };
  }
}

/* CPU temp probe — opportunistic. Apple Silicon doesn't expose °C without
 * sudo or third-party deps; we try `osx-cpu-temp` (brew) first, fall back to
 * pmset thermal level, return null when neither works. The HUD's temp gauge
 * gracefully shows a thermal-level chip when °C is null. */
let _hasOsxCpuTemp = null;
async function getCpuTemp() {
  if (_hasOsxCpuTemp === false) return null;
  try {
    if (_hasOsxCpuTemp === null) {
      try { await execp("which osx-cpu-temp"); _hasOsxCpuTemp = true; }
      catch { _hasOsxCpuTemp = false; return null; }
    }
    const { stdout } = await execp("osx-cpu-temp -f");
    const m = stdout.match(/([\d.]+)\s*°?C/);
    return m ? parseFloat(m[1]) : null;
  } catch { return null; }
}

async function getNetStats() {
  try {
    const { stdout } = await execp("netstat -ibn | grep -e '^en0' | head -1");
    const cols = stdout.trim().split(/\s+/);
    if (cols.length < 10) return { rxBytes: 0, txBytes: 0 };
    return { rxBytes: Number(cols[6]) || 0, txBytes: Number(cols[9]) || 0 };
  } catch { return { rxBytes: 0, txBytes: 0 }; }
}

async function getDiskStats() {
  try {
    const { stdout } = await execp("df -k / | tail -1");
    const cols = stdout.trim().split(/\s+/);
    const totalKB = Number(cols[1]) || 0;
    const usedKB = Number(cols[2]) || 0;
    return { totalTB: totalKB / 1e9, usedTB: usedKB / 1e9 };
  } catch { return { totalTB: 0, usedTB: 0 }; }
}

/* ---------- WEB SEARCH (DuckDuckGo HTML, no API key) ---------- */
async function webSearch(query, max = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`ddg ${res.status}`);
  const html = await res.text();
  const results = [];
  const reItem = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = reItem.exec(html)) && results.length < max) {
    const link = decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [, m[1]])[1]);
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    const snippet = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (title && link) results.push({ title, url: link, snippet });
  }
  return results;
}

/* ---------- OLLAMA LLM PROXY ---------- */

/** Map WMO weather code → short human label. */
function wmoLabel(code) {
  if (code === 0) return "clear";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "showers";
  if (code <= 99) return "thunderstorms";
  return "unknown";
}

/** Detect what real-world data the query needs and fetch it ahead of the LLM call.
 *  Why: a local LLM has no internet access — it must be handed fresh facts as context, or it will fabricate. */
async function gatherContext(query) {
  const ctx = [];
  const q = query.toLowerCase();
  const now = new Date();

  if (/\b(time|hour|clock|when is it|right now|currently)\b/.test(q)) {
    ctx.push(`Current local time: ${now.toLocaleTimeString("en-GB", { timeZone: CONFIG.operator.timezone, hour12: false })} (24-hour, ${CONFIG.operator.timezone}).`);
  }

  if (/\b(date|day|today|tomorrow|this week|month|year)\b/.test(q)) {
    ctx.push(`Today is ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`);
  }

  if (/\b(weather|temp|temperature|rain|sun|sunny|cloud|cloudy|forecast|hot|cold|wind|fog)\b/.test(q)) {
    /* Why: previously we auto-injected the operator's HOME forecast for any weather
     * mention, so "weather in Alicante" got UK data parroted back. Now we only inject
     * home-forecast context when the query has NO location preposition AND NO future
     * horizon beyond ~5 days. For everything else (named place, "next week"+), stay
     * silent so the LLM is forced to call get_weather with the right args. */
    const namesPlace   = /\b(?:in|at|for|around)\s+[a-zA-Z][a-zA-Z\s'-]{2,}/.test(q);
    const longHorizon  = /\b(next week|next month|in (?:[7-9]|1[0-4]) days|fortnight)\b/.test(q);
    if (!namesPlace && !longHorizon) {
      try {
        const w = await getWeather();
        if (w && w.now) {
          ctx.push(`Current ${CONFIG.operator.city} weather: ${w.now.temp}°C, ${wmoLabel(w.now.code)}.`);
          if (Array.isArray(w.forecast)) {
            const days = w.forecast.slice(0, 5).map(d => `${d.date}: ${d.lo}–${d.hi}°C ${wmoLabel(d.code)}`);
            ctx.push(`Forecast next 5 days: ${days.join("; ")}.`);
          }
        }
      } catch {}
    }
  }

  if (/\b(cpu|ram|memory|disk|storage|performance|usage|load|space)\b/.test(q)) {
    try {
      const [cpu, mem, disk] = await Promise.all([getCpuPercent(), getMemoryStats(), getDiskStats()]);
      ctx.push(`System: CPU ${cpu.overall.toFixed(0)}%, RAM ${mem.usedGB.toFixed(1)}/${mem.totalGB.toFixed(0)} GB used, disk ${disk.usedTB.toFixed(2)}/${disk.totalTB.toFixed(2)} TB used.`);
    } catch {}
  }

  return ctx.join("\n");
}

/* ---------- TOOL DEFINITIONS (Qwen 2.5 supports OpenAI-style tool calling) ---------- */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the live web for current information. Use when the user asks about news, recent reviews, prices, releases, or anything time-sensitive. Returns top 5 results with URL + snippet — synthesise an answer from them.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      /* Why call this out so explicitly: previously the weather phrase was auto-injected
       * with the operator's home lat/lon regardless of the spoken location, so "weather
       * in Alicante" returned UK forecasts. Force the LLM to use this tool whenever a
       * place is named or the horizon is beyond ~5 days. */
      description: "Look up current conditions and the daily forecast (up to 14 days) for ANY named location worldwide. Free Open-Meteo, no key. Use this whenever the operator names a place ('weather in Alicante', 'is it going to rain in Tokyo Friday') OR asks beyond a 5-day horizon. Omit `location` to get the operator's home town. Returns { now: {temp, code}, forecast: [{date, hi, lo, code}], location: {name, country} }.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "Place name to geocode (e.g. 'Alicante', 'Tokyo'). Omit for operator's home." },
          days: { type: "integer", description: "Forecast days to return (1-14). Default 7." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_pdf",
      description: `Generate a branded Jarvis AI PDF document. Available templates: ${listPdfTemplates().join(", ")}.\n\nFor 'quote': data = { client, project, lineItems: [{description, amount}], shootDates, validUntil, notes, vatRate }.\nFor 'brief': data = { client, subject, dates, location, deliverables, crew, objectives, shotList: [...], notes }.\nFor 'shoot-report': data = { client, subject, date, location, weather, crew, fileCount, summary, highlights: [...], issues, nextSteps }.\nFor 'press-release': data = { headline, subhead, dateline, lead, body, quote, quoteAttribution, boilerplate, contact, releaseDate }.`,
      parameters: {
        type: "object",
        properties: {
          template: { type: "string", enum: listPdfTemplates() },
          data: { type: "object", description: "Template-specific data; see tool description for schema" },
        },
        required: ["template", "data"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_upcoming_events",
      description: "List the operator's upcoming Calendar events. Returns title, start, location, calendar name.",
      parameters: { type: "object", properties: { days: { type: "number", default: 7 }, calendarName: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "add_calendar_event",
      description: "Create a new event in the operator's macOS Calendar (which syncs back to Google if connected). Always confirm details before calling. Times should be ISO 8601 strings.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          start: { type: "string", description: "ISO 8601 start datetime e.g. 2026-05-04T14:00:00" },
          end: { type: "string", description: "ISO 8601 end (optional — defaults to +1h)" },
          location: { type: "string" },
          notes: { type: "string" },
          calendarName: { type: "string" },
        },
        required: ["title", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mail_summary",
      description: "Summarise the operator's Apple Mail inbox. Returns from / subject / date for recent unread (or all) messages.",
      parameters: { type: "object", properties: { unreadOnly: { type: "boolean", default: true }, max: { type: "number", default: 10 } } },
    },
  },
  {
    type: "function",
    function: {
      name: "draft_email",
      description: "Open a new outgoing email in Apple Mail with the to/subject/body pre-filled. NEVER auto-sends — always opens for the operator's approval. Use when they say 'draft an email to X about Y'.",
      parameters: {
        type: "object",
        properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" } },
        required: ["to", "subject"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_contact",
      description: "Save a contact to persistent memory. Use whenever the operator introduces a new person ('add Sarah Mitchell, sarah at example dot press, press liaison'). Upserts on name. The contact then becomes available in future sessions — get_contact / draft_email can find them by name alone.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          company: { type: "string" },
          role: { type: "string" },
          notes: { type: "string", description: "Free-form notes — preferences, past projects, anything you want to recall later" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_contact",
      description: "Look up a stored contact by name (or email). Falls back to fuzzy + semantic match if no exact name. Use BEFORE calling draft_email when the operator says a name like 'send Ben an email' — get the email address from memory rather than asking.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, email: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_contacts",
      description: "List stored contacts, optionally filtered by company.",
      parameters: { type: "object", properties: { company: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Store a free-form fact in persistent memory for future recall ('the manufacturer always wants vertical cuts first', 'Ben prefers email over Slack'). Use when the operator says 'remember that...' or you observe a stable preference / pattern.",
      parameters: {
        type: "object",
        properties: { content: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall",
      description: "Semantic search across all stored memory: facts, contacts, projects, past conversation summaries. Use when the operator asks about something from a previous session ('what did we agree with the client', 'what was the brief for the press car').",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number", default: 5 } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_project",
      description: "Save a project to persistent memory: name, client, status, notes. Use when starting work for a new client / shoot.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, client: { type: "string" }, status: { type: "string" }, notes: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_projects",
      description: "List stored projects, optionally filtered by client.",
      parameters: { type: "object", properties: { client: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "save_conversation",
      description: "Persist a short summary of the current conversation so future sessions can recall it via the recall tool. Call this when the operator says 'that's all' or wraps up — capture the gist (2-3 sentences) and key topics.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "2-3 sentences summarising what was discussed/done" },
          topics: { type: "array", items: { type: "string" }, description: "Short tag list e.g. ['the manufacturer', 'the press car teaser', 'Ben Collins']" },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "describe_image",
      description: "Caption a single image or video keyframe using the local Qwen 2.5-VL vision model. Use when the operator asks 'what's in this shot', 'what is shoots/2026-05-01-press-car/IMG_001.jpg of', or wants a press-release-style description of a frame. Accepts jpg/png/webp/heic OR mp4/mov (auto-extracts a keyframe at 30% of duration). Returns a 1-2 sentence caption identifying make/model/angle/lighting where applicable. Caches results so repeat calls are free.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to project root, OR absolute path inside the project. Folder-name-only also works (resolves under shoots/)." },
          prompt: { type: "string", description: "Optional custom caption prompt. Default produces a media-agency-friendly description." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_youtube_promo",
      description: "Generate BOTH the YouTube thumbnail AND a 30-second YouTube short for a shoot in ONE tool call. STRONGLY PREFERRED when the operator asks for a thumbnail and a short together (e.g. 'a thumbnail and a short for the press car shoot, V10 beast, the car that broke me'). The thumbnail returns fast (~10s, pops in HUD modal); the short renders in the background (~2-3 min, auto-plays when ready). The thumbnail auto-derives make/model + headline specs (BHP / top speed / 0-60 / drivetrain) from the folder + the model's training knowledge, so the operator doesn't need to dictate them.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder name OR a subject phrase like 'press car' or 'track day'. Defaults to most-recent shoot." },
          subject: { type: "string", description: "Alternative to folder — used for matching when folder isn't an exact directory name." },
          headline: { type: "string", description: "Big yellow headline, ALL CAPS punchy. e.g. 'V10 BEAST'." },
          subhead: { type: "string", description: "Red strap line. e.g. 'The Car That Broke Me'." },
          make: { type: "string", description: "Override auto-detected make (rarely needed)." },
          model: { type: "string", description: "Override auto-detected model (rarely needed)." },
          stats: { type: "object", description: "Override auto-derived stats. Keys: BHP, 'Top Speed', Engine, Drive, '0-60'. Values are short strings." },
          music: { type: "string", description: "Music mood for the short ('epic'/'driving'/'cinematic'), 'auto', or 'none'." },
        },
        required: ["headline"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_youtube_thumbnail",
      description: "Generate a YouTube video thumbnail (1280x720) for a shoot. Picks the strongest hero shot AND an engine bay close-up via vision (the engine inlay is an established client requirement — old thumbnails missed this). Layout: full-bleed hero with vignette, big yellow Anton-style headline rotated -2°, red subhead box, engine inlay bottom-right with red border, optional spec strip across bottom showing things like 'V10 · 5.0L · 510 BHP · 0-60 IN 3.2s'. Use when operator says 'make a thumbnail', 'YouTube thumb for [subject]', 'design a thumb with [headline] and [subhead]', or as part of 'a thumb and short for the [subject] shoot'.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder name. Defaults to most recent shoot if omitted or 'latest'." },
          headline: { type: "string", description: "Big yellow text. Short, ALL CAPS punchy. e.g. 'V10 BEAST', '25 YEARS LATER'." },
          subhead: { type: "string", description: "Red strap line below the headline. e.g. 'The Car That Broke Me'." },
          specs: { type: "array", items: { type: "string" }, description: "Bottom spec strip entries — e.g. ['V10', '5.0L', '510 BHP', '0-60 in 3.2s', 'AWD']." },
        },
        required: ["headline"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_youtube_short",
      description: "Render a 30-second 16:9 YouTube short from a shoot folder using the cinematic teaser pipeline (flash cuts, speed ramps, beat-synced music, single-word stacked tail card). Combines headline + subhead into the closing kicker card. Use when operator says 'make a YouTube short', 'cut a short for [subject] with [headline]', or 'a thumb and a short for the [subject] shoot'. Returns immediately with status:'started' — render takes 2-3 min and auto-plays in HUD when ready (same as the production teaser).",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder name. Defaults to most recent." },
          subject: { type: "string", description: "Optional subject name override (default: derived from folder)." },
          headline: { type: "string", description: "Primary kicker phrase, e.g. 'V10 BEAST'." },
          subhead: { type: "string", description: "Secondary kicker phrase, e.g. 'The Car That Broke Me'." },
          music: { type: "string", description: "Music mood ('epic', 'driving', 'cinematic'), 'auto', or 'none'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_social_captions",
      description: "Write Instagram + LinkedIn + TikTok caption variants for a subject in each platform's native voice. Use when the operator says 'write captions for the press car teaser', 'draft socials for today's the manufacturer shoot', etc. Returns a JSON object with one caption per requested platform.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "What the post is about (e.g. 'the latest hero shoot at Goodwood')." },
          angle: { type: "string", description: "Optional editorial angle: 'hero shot', 'behind the scenes', 'client launch'." },
          platforms: { type: "array", items: { type: "string" }, description: "Subset of 'instagram', 'linkedin', 'tiktok'. Default all three." },
          cta: { type: "string", description: "Optional call to action." },
        },
        required: ["subject"],
      },
    },
  },
  /* ─── Sprint 13 — voice-driven teaser-ad pipeline ───
   * make_teaser_storyboard → generate_teaser_image → animate_teaser_image
   * The LLM is expected to walk through these in conversation order:
   * storyboard first (no API cost), then propose the image (gated), then
   * propose the video (gated). Operator can refine the prompt at any step.  */
  {
    type: "function",
    function: {
      name: "make_teaser_storyboard",
      description: "Step 1 of the teaser-ad pipeline. Generates a short social-media advert script with an `influencer` persona, broken into time-coded beats (visual + voiceover + on-screen text). Also produces a single `heroPrompt` describing the most striking still frame to render via generate_teaser_image. Use when the operator says 'make me an advert for X with influencer Y, Z seconds long', 'draft a teaser for ___', 'storyboard a TikTok ad'. NO external API cost — purely LLM. Always speak the script aloud to the operator BEFORE proposing image generation.",
      parameters: {
        type: "object",
        properties: {
          product: { type: "string", description: "What's being advertised — product, app, brand, event, etc. e.g. 'Nike Air Max 95' or 'Jarvis AI assistant'." },
          influencer: { type: "string", description: "Persona/character driving the ad. Free-text — 'a 22-year-old streetwear creator', 'a posh British satirical narrator', 'an athletic morning-runner type'. The script's tone, dialogue, and visual style match this persona." },
          duration_s: { type: "integer", description: "Target ad duration in seconds. Default 15 — matches TikTok's most-used short-form length and the 15s cap of most image-to-video models. Use 5 or 10 for very short hooks; only go above 15 if the operator explicitly asked for a longer cut. ALWAYS take the duration from the operator's exact words ('5 second teaser' → 5, 'fifteen-second clip' → 15) — do NOT pick a default mid-range like 30 unless they said so." },
          platform: { type: "string", enum: ["tiktok", "instagram_reels", "youtube_shorts", "linkedin", "facebook_ads"], description: "Where the ad will run. Default tiktok. Affects aspect (9:16 vs 16:9) and tone (TikTok = looser hooks, LinkedIn = polished)." },
          tone: { type: "string", description: "Optional override — 'cheeky', 'aspirational', 'irreverent', 'cinematic'. Default lets the influencer persona drive it." },
        },
        required: ["product", "influencer", "duration_s"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_teaser_image",
      description: "Step 2 of the teaser-ad pipeline. Generates the hero still image for an advert via fal.ai's nano-banana-pro family (Google Gemini 3 Pro Image, 1K resolution). Use AFTER make_teaser_storyboard has produced a heroPrompt and the operator says 'yes generate the image'. Costs ~$0.04 per image — REQUIRES CONFIRMATION. Saves to output/teasers/<run_id>/hero.png and opens it in Preview.\n\nIF the operator named a locked influencer ('using Marcus', 'with Lena'), pass their slug as `influencer` — the bridge resolves their canonical face and conditions the generation on it (via nano-banana-pro/edit) so the SAME PERSON appears across every piece of content from that channel. Without `influencer`, the model interprets the persona description in the prompt freely (different face each call).",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed scene description for the hero frame. Should describe subject, setting, lighting, style. Pulled from make_teaser_storyboard's heroPrompt unless the operator wants a refinement. When `influencer` is set, you can refer to them by name in the prompt — the model has the face reference, you provide the scene." },
          aspect: { type: "string", enum: ["9:16", "16:9", "1:1", "4:5"], description: "Aspect ratio. Match the platform — 9:16 for TikTok/Reels/Shorts, 16:9 for YouTube ads, 1:1 for Instagram feed, 4:5 for LinkedIn. Default 9:16." },
          style: { type: "string", description: "Optional style modifier — 'editorial photography', 'cinematic still', 'street photography', 'commercial product render'. Appended to the prompt." },
          influencer: { type: "string", description: "Optional locked influencer slug (lowercase first name, e.g. 'marcus', 'lena'). When set, the bridge looks up output/influencers/<slug>/canonical.png and uses it as the character reference so the hero shot features THAT specific face. Required for 'make me an ad with [name]' / 'use [name] in this' style requests so the resulting content is on-brand for that channel." },
          run_id: { type: "string", description: "Optional: pass the previous run_id to keep this image in the same teaser folder. Omit to start a fresh run." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "animate_teaser_image",
      description: "Step 3 of the teaser-ad pipeline. Animates a generated hero image into a 5-15 second video via fal.ai's Alibaba happy-horse image-to-video (720p). Use AFTER generate_teaser_image when the operator says 'now make the video', 'animate it', or similar. Costs ~$0.14 per second of video — REQUIRES CONFIRMATION. Saves to output/teasers/<run_id>/clip.mp4 and opens it in QuickTime. HARD CAP: 15 seconds — never propose longer; the model rejects above that.",
      parameters: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "The run_id returned by generate_teaser_image. Locates the hero.png to animate." },
          motion_prompt: { type: "string", description: "Cinematic motion description for the clip. Happy-horse follows specific physical direction much better than vibe — so be CONCRETE and DRAMATIC. Always include at least two of: a camera move (slow push-in, orbital pan, dolly out, whip pan, dutch tilt), a subject motion (hair toss, head turn to camera, confident step forward, slow blink, smile breaking), a lighting/atmosphere beat (lens flare flicker, palm-tree shadows shifting, golden-hour rim-light catching hair, ocean breeze in hair, slow-motion fabric ripple), and a product accent if there's a hero product (lingering close-up on the trainer, soft spotlight on the logo). Keep it under ~80 words, present-tense, specific. AVOID vague words like 'cinematic vibe' or 'aesthetic mood' — those produce mush. Example for a Nike marketing clip: 'Slow camera push-in as she tosses her hair and turns to meet the lens with a confident smile. Golden-hour light catches her face, lens flare flickers across the frame. Camera tilts down to a close-up on the white Nike Air Max as she takes a half-step forward, swoosh in sharp focus.'" },
          duration_s: { type: "integer", description: "Clip length in seconds. Range 5-15 (HARD CAP at 15 — model rejects longer). Default 5. Take the value from the operator's exact words; do not pick a mid-range default like 10 unless they said so." },
        },
        required: ["run_id", "motion_prompt"],
      },
    },
  },
  /* ─── AI INFLUENCER PIPELINE ───
   * Persistent fake characters that anchor a social-content channel. Once
   * locked, an influencer's canonical face is reused across hero shots,
   * animations and video recreations — so the same person appears in every
   * post on the channel. Three tools cover the lifecycle:
   *   create_influencer → lock_influencer → recreate_video_with_influencer
   * The storyboard / image / animate teaser tools above can ALSO reference
   * a locked influencer by passing their slug as the `influencer` field. */
  {
    type: "function",
    function: {
      name: "create_influencer",
      description: "Generate 2-3 reference portrait stills for a new AI-influencer character via fal.ai's nano-banana-2 (~$0.08 per image, max 4 per call). Use when the operator wants to create a fake persona for a social channel — TikTok, IG, etc. Gather the persona conversationally first; you need at least a name + persona/vibe + look (gender/age/ethnicity included if relevant). Costs ~$0.16-$0.32 per call (2-4 images) — REQUIRES CONFIRMATION. Saves to output/influencers/<slug>/refs/. After this fires, the operator picks a reference and you call lock_influencer to set their canonical face.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Operator-given first name (\"Marcus\", \"Lena\"). Becomes the folder slug. Voice-friendly so the operator can later say 'using Marcus' to recall the character." },
          persona: { type: "string", description: "Free-text persona summary covering vibe, archetype, content niche. Example: 'mid-20s British skater, into streetwear and specialty coffee, dry sense of humour'." },
          look: { type: "string", description: "Free-text physical description. Example: 'dark hair short on sides, scruffy beard, hoodie always, around 5'10, mid-tone skin'." },
          aesthetic: { type: "string", description: "Visual style hint. Example: 'candid phone photography', 'cinematic editorial', 'polished commercial', 'film grain 35mm'. Default lets nano-banana-2 choose." },
          platform: { type: "string", enum: ["tiktok", "instagram", "youtube", "x", "facebook"], description: "Primary platform — biases aspect-ratio defaults for downstream content. Default tiktok." },
          count: { type: "integer", description: "How many reference variations to generate (1-4). Default 3 — gives the operator real choice without burning budget." },
        },
        required: ["name", "persona", "look"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lock_influencer",
      description: "Lock the operator-chosen reference as the influencer's canonical face. NO API cost — this is a local file copy + persona-record stamp. Call AFTER create_influencer when the operator says 'use the second one' / 'lock the first / 'go with reference 3' (or via the HUD picker modal). After lock, the slug is reusable across all teaser-pipeline tools.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Influencer slug (returned by create_influencer)." },
          ref_idx: { type: "integer", description: "1-based index of the reference to lock (1 = ref-1.png, 2 = ref-2.png, …)." },
        },
        required: ["slug", "ref_idx"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recreate_video_with_influencer",
      description: "Drive a locked influencer's face with the motion of a reference video via fal.ai's Kling Motion Control v3 Pro. Use when operator says 'recreate this TikTok using Marcus', 'do that dance with Lena', 'put Marcus in this video'. Costs ~$0.168 per second of output (5s ≈ $0.84) — REQUIRES CONFIRMATION. If no source_url or source_local_path is supplied, the bridge opens a HUD modal asking the operator to paste a URL or drop a local file, then completes the call — DO NOT loop or re-call; one call is enough.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Locked influencer slug whose canonical face will replace the person in the source video." },
          source_url: { type: "string", description: "Optional source video URL (TikTok / IG Reels / YT Shorts / X). yt-dlp downloads it locally before driving the model. Omit BOTH source_url and source_local_path to trigger the HUD URL-modal — the bridge then waits up to 5 minutes for the operator to provide a source." },
          source_local_path: { type: "string", description: "Optional absolute path to a local mp4. Used when the operator drag-drops a file or yt-dlp can't reach the URL. If both this and source_url are set, source_local_path wins." },
          prompt: { type: "string", description: "Optional motion / action description (Kling uses it as a hint). Example: 'A man dancing'. Default empty." },
          character_orientation: { type: "string", enum: ["image", "video"], description: "Optional. 'video' (DEFAULT — use for body-motion / dance recreations, max 30s output) or 'image' (use when the source video is a camera-move around a static character, max 10s output). Operator usually doesn't need to think about this; default 'video' fits the TikTok-recreation use case." },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_influencer_wizard",
      description:
        "Open the influencer creation wizard side panel. Use when the operator says 'create me an influencer', 'make a new influencer', 'spin up an influencer', or 'build me a TikTok face'. The panel asks for sex / vibe / content type / optional reference URL, then runs the create → lock → hero → video → caption pipeline. After the wizard appears the operator drives it via clicks or by continuing to speak — do not ask follow-up questions, the panel handles that.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_influencer_pipeline",
      description:
        "Internal: kick off the influencer pipeline run with explicit answers. The HUD wizard's GO button calls this directly via POST /api/influencer/pipeline/start; the LLM rarely calls it directly. If the LLM is asked to fire it, ensure all four answers (sex, vibe, content_type, optional source_url) are present from the conversation.",
      parameters: {
        type: "object",
        properties: {
          sex:          { type: "string", enum: ["male", "female", "other"] },
          vibe:         { type: "string", description: "One of: cinematic, candid, polished, editorial — or a free-text vibe phrase." },
          content_type: { type: "string", enum: ["brand-product", "faceless", "dances"] },
          source_url:   { type: "string", description: "Optional TikTok / Instagram / YouTube URL to drive motion-control replication." },
        },
        required: ["sex", "vibe", "content_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_asset_panel",
      description:
        "Open the asset panel — shows the most recently generated image or video with actions (regenerate, animate, copy, save, open). Use when the operator says 'show me the latest image', 'pull up the image', 'show that image again', 'show the last video'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "show_weather_panel",
      description:
        "Open the weather panel with current conditions + 5-day forecast for the operator's home location. Use when the operator says 'show me the weather' or 'weather panel'. For 'what's the weather' (no panel-intent verb) the existing get_weather tool is sufficient.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "triage_failed_tool",
      description: "DIAGNOSTIC tool — call when another tool returned ok:false with a confusing schema/format error (NOT for safety rejects; for those just rephrase + retry). Pass the failing tool's name, the args you sent, and the error string. The bridge looks up that tool's schema and runs an LLM that suggests corrected args. Returns { suggestion: { fixed_args, reasoning } }. Then YOU re-call the original tool with the suggested args + confirmed:true. Don't loop more than twice. NO direct API cost — runs entirely on the local model.",
      parameters: {
        type: "object",
        properties: {
          tool_name: { type: "string", description: "Name of the tool that failed (the one whose args need fixing)." },
          args: { type: "object", description: "The exact arguments you passed to that tool when it errored." },
          error: { type: "string", description: "The error message returned by the tool (the value of the result's .error field)." },
        },
        required: ["tool_name", "args", "error"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_brand_tone",
      description: "Critique a draft caption / press line against a manufacturer's brand tone of voice (the manufacturer, McLaren, Ferrari, etc). Pulls stored tone notes from memory then web-searches if memory is thin. Returns verdict + issues + a rewrite. Use when operator asks 'is this on-brand for X', 'check my the manufacturer caption', 'how should McLaren say this'.",
      parameters: {
        type: "object",
        properties: {
          manufacturer: { type: "string" },
          draft: { type: "string", description: "The caption / sentence to review." },
        },
        required: ["manufacturer", "draft"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hashtag_research",
      description: "Suggest a ranked hashtag set per platform for a topic. Mixes high/mid/niche volume tags. Use when operator says 'give me hashtags for the press car post', 'what should I tag this with on TikTok'.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Subject to research tags for." },
          platform: { type: "string", description: "Optional — restrict to one of 'instagram', 'tiktok', 'linkedin'. Omit for all three." },
          count: { type: "number", description: "Tags per platform (default 12)." },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "vehicle_spec_lookup",
      description: "Look up a specific vehicle spec (torque, 0-60, kerb weight, top speed, BHP, etc) with a web citation. Use mid-press-release when operator needs a number quickly: 'what's the press car's torque', 'how much does a 720S weigh'. Returns the figure + a one-line context + the source URL.",
      parameters: {
        type: "object",
        properties: {
          make: { type: "string" },
          model: { type: "string" },
          spec: { type: "string", description: "Free-form question, e.g. 'torque', '0-60 mph', 'kerb weight'. Default 'key specs'." },
        },
        required: ["make", "model"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_internal",
      description: "Answer 'how do we usually do X' questions for the team — pulls past conversation summaries, stored facts, and project notes for grounded answers. Use when a junior asks 'how do we grade a shoot', 'what's our usual rate for a track day', 'who should I CC on the client deliveries'.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "team_standup",
      description: "Summarise the last 24 hours of agency activity: teasers rendered, PDFs generated, recent conversation topics. Use when operator says 'give me the standup', 'what was done yesterday', 'morning summary'.",
      parameters: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Lookback window in hours. Default 24." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_all_aspects",
      description: "Crop a master image or video to ALL common social aspect ratios (16:9, 9:16, 1:1, 4:5) in one call, with the subject auto-centered. Outputs to output/aspects/. Use when operator says 'export every aspect for socials', 'make all the variants', 'one-shot crop everything'.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          aspects: { type: "array", items: { type: "string" }, description: "Optional subset, e.g. ['9:16', '1:1']. Default all four." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Run an ad-hoc shell command in the project directory. Use ONLY when no curated tool fits the request — e.g. 'convert all .mov in this folder to mp4', 'rename these RAWs', 'count how many 4K clips are in the shoot'. The command runs sandboxed: limited to a binary allowlist (ffmpeg, ffprobe, magick, sips, exiftool, find, awk, sed, grep, python3, node, osascript, curl, jq, etc), with dangerous patterns blocked (no sudo, rm -rf, eval, dd, mkfs). Output is captured + returned. Compose carefully — always include a short 'justification' string explaining what the command does.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run." },
          justification: { type: "string", description: "Short human-readable note ('convert MOV→MP4', 'count files', etc) — appears in logs." },
          cwd: { type: "string", description: "Optional working directory relative to project root (e.g. 'shoots/2026-05-01-press-car')." },
        },
        required: ["command", "justification"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a small ad-hoc script or output file. Restricted to tools/adhoc/ or output/ subdirectories. Useful for composing a bash/python script in one step then running it with run_shell.",
      parameters: {
        type: "object",
        properties: {
          relPath: { type: "string", description: "Relative path under tools/adhoc/ or output/ (e.g. 'tools/adhoc/batch-convert.sh')." },
          content: { type: "string", description: "File contents." },
        },
        required: ["relPath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_capabilities",
      description: "Returns the runtime constraints + options the operator's machine actually supports right now: hardware tier, available shoot folders, voice options, PDF templates, Lightroom presets, location, etc. Call this whenever the operator asks what you can do, or before a complex tool call where you need to know what's available.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "brand_pack_export",
      description: "Build a delivery brand-pack from a hero shot — generates 16:9 / 9:16 / 1:1 / 4:5 crops with subject auto-centred, both clean AND watermarked variants, plus a credit.txt for the email and a zip for the client. Use when the operator says 'build a brand pack of the press car hero', 'export deliverables for IMG_001', 'pack this up for the client'. Output goes to output/brand-packs/<basename>_<ts>/.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Hero image path — absolute, project-relative, or shoots/<folder>/<file.jpg>." },
          includeWatermarked: { type: "boolean", description: "Generate watermarked variants alongside clean ones (default true)." },
          zip: { type: "boolean", description: "Zip the output folder for handoff (default true)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dream_cycle",
      description: "Compact memory.db: merge near-duplicate contacts (Levenshtein ≤ 2) and archive conversation summaries older than 90 days. Runs automatically nightly at 03:30; this tool exposes a manual on-demand trigger when the operator says 'tidy up the memory', 'merge duplicates', 'compact memory', or after a known dirty import.",
      parameters: {
        type: "object",
        properties: {
          archiveDays: { type: "number", description: "Conversation summaries older than this are deleted (default 90)." },
          dryRun: { type: "boolean", description: "Report what would change without writing — useful for spot-checking before committing." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_active_window",
      description: "Inspect the operator's foreground macOS application via the Accessibility API — returns the app name, window title, and the top-level visible UI elements (buttons, panels, lists). Use when the operator asks 'what's open?', 'what app am I in?', 'what's on screen right now?', 'what's the active sequence in Premiere?', or any question that depends on knowing the foreground state. Cheaper + more accurate than vision-based screen analysis. Requires macOS Accessibility permission granted to the kiosk app once.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_last",
      description: "Reverse the most recent undoable action. Use when the operator says 'undo', 'scratch that', 'never mind that', 'reverse that', or similar. Limited to genuinely-reversible operations: flag_shot (restores prior flag or clears it), expire_usage_rights (restores prior expiry), add_usage_rights (deletes the row), add_contact / add_project (deletes the row). Doesn't reverse renders, sent emails, or file writes — speak that limitation if asked to undo something outside the supported set.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "send_imessage",
      description: "Send an iMessage / SMS via the macOS Messages app. Recipient can be a phone number, email, or contact name (resolves to first match in Contacts). Use for: 'text Adam I'm running late', 'message mum I'll call her tonight'. ALWAYS goes through the confirmation gate — operator must say 'yes' before send.",
      parameters: {
        type: "object",
        properties: {
          to:   { type: "string", description: "Phone number, email, or contact name. e.g. '+447700900123', 'adam@example.com', 'Adam Walker'." },
          body: { type: "string", description: "Message text. Keep concise — long SMS get split." },
        },
        required: ["to", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_reminder",
      description: "Add an item to Apple Reminders. Use for: 'remind me to call mum at 6', 'remember to buy milk', 'add cleaning the studio to my list'. The bridge parses the due date — pass natural language like 'tomorrow at 18:00' or an ISO string.",
      parameters: {
        type: "object",
        properties: {
          title:    { type: "string", description: "What the operator wants to remember." },
          due:      { type: "string", description: "Optional due date — ISO timestamp or natural language. Omit for an undated reminder." },
          notes:    { type: "string", description: "Optional notes attached to the reminder." },
          listName: { type: "string", description: "Optional Reminders list name. Omit for the default list." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_timer",
      description: "Start an in-HUD kitchen timer. Use for cooking, breaks, or any 'remind me in N minutes' that is shorter than ~12 hours. For longer waits, use add_reminder. The HUD shows a countdown badge and Kokoro speaks the label when it fires.",
      parameters: {
        type: "object",
        properties: {
          minutes: { type: "number", description: "Duration in minutes. Max 720 (12 hours)." },
          label:   { type: "string", description: "Optional name announced when the timer fires. Default 'N minute timer'." },
        },
        required: ["minutes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_timers",
      description: "List currently-active timers. Use when operator asks 'what timers do I have' or 'how long left on the chicken'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_timer",
      description: "Cancel an active timer by id. Use only after list_timers — operator usually identifies a timer by its label, not id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The timer id from list_timers." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "play_music",
      description: "Play music via Apple Music (default) or Spotify. Pass a search query — artist, song, mood, or playlist name. Empty query just resumes whatever is loaded. Use for: 'play some driving music', 'put on Daft Punk', 'play that podcast I was listening to'.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search. Empty/omitted = resume." },
          app:   { type: "string", enum: ["music", "spotify"], description: "music (Apple Music) or spotify. Default music." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_article",
      description: "Fetch a web article and return cleaned text the LLM can summarise. Use for: 'summarise this Verge piece', 'read me the BBC headline at <url>', 'what does this article say'. Returns title + text (capped ~12k chars). Pure HTTP fetch — no Playwright, no API cost.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "Fully-qualified https:// URL." } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "Take a macOS screenshot via screencapture. region='screen' (default, full primary display), 'window' (operator clicks a window), 'selection' (operator drags a region). Saves to data/screenshots/. Returns the filesystem path so the LLM (or the operator) can refer to it. Use for: 'screenshot the current Premiere session', 'capture this region for the brief'.",
      parameters: {
        type: "object",
        properties: { region: { type: "string", enum: ["screen", "window", "selection"], description: "Capture mode. Default 'screen'." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_focus",
      description: "Toggle a macOS Focus mode (Do Not Disturb, Work, Personal, etc) by invoking a pre-existing Shortcut named exactly 'Focus On <mode>'. The operator builds the Shortcut once in Shortcuts.app. Use for: 'turn on Do Not Disturb', 'switch to Work focus until 6pm'.",
      parameters: {
        type: "object",
        properties: {
          mode:  { type: "string", description: "Focus mode name — must match the Shortcut name. e.g. 'Do Not Disturb', 'Work', 'Personal'." },
          until: { type: "string", description: "Optional duration / time hint passed to the Shortcut. Free text." },
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_password",
      description: "Read a credential from 1Password via the `op` CLI. Returns the field value (typically the password) so the operator can use it. ALWAYS goes through the confirmation gate — operator must say 'yes' before the credential leaves 1Password. Requires `op` installed and the operator signed in (`eval $(op signin)`).",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "1Password item name. Must match exactly." },
          field: { type: "string", description: "Field to read. Default 'password'. Common: 'password', 'username', 'totp'." },
        },
        required: ["label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compose_note",
      description: "Create a note in Apple Notes (default), Bear, or Obsidian. Use for: 'note this idea down', 'jot that in my brief notes', 'save this to Bear'. Title becomes the note's headline; body is freeform. No confirmation required — notes are private and easy to delete.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title / headline." },
          body:  { type: "string", description: "Note body — freeform markdown or plain text." },
          app:   { type: "string", enum: ["notes", "bear", "obsidian"], description: "Target app. Default 'notes' (Apple Notes)." },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pause_music",
      description: "Pause Apple Music or Spotify playback.",
      parameters: {
        type: "object",
        properties: { app: { type: "string", enum: ["music", "spotify"] } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "enter_sleep_mode",
      description:
        "Put Jarvis to sleep — stops the mic, dims the HUD, and waits for the operator to tap the speedometer or say the wake word to come back. Use when the operator says 'shut down', 'go to sleep', 'stop listening', 'that's enough', 'goodnight', 'turn off'. NOT for ending a single response — only for full standby.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description:
        "Open a URL in the operator's default browser via macOS `open`. Use for 'pull up a map of X', 'open the BBC News homepage', 'show me Tesco's milk page'. This is the FAST tool — picks the right URL and hands off to Chrome. No API cost, no vision loop, no waiting. Prefer this over request_browse whenever the operator just wants to SEE a page (they can read it themselves). Only use request_browse when the goal needs the LLM to extract a specific fact from a page or perform a multi-step interaction. For maps: build a https://www.google.com/maps/search/<query> URL with the location URL-encoded. For shops: go straight to the product or category page if you know it.",
      parameters: {
        type: "object",
        properties: {
          url:    { type: "string", description: "Fully-qualified URL starting with https://. Refused otherwise." },
          reason: { type: "string", description: "One-sentence reason for the operator's audit log. e.g. 'Operator asked for a map of Manchester'." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_news_panel",
      description:
        "Open the news panel: live Sky News YouTube on the left, merged top UK headlines (Sky/BBC/Guardian) and Hacker News top tech stories on the right. Use when the operator asks for 'the news', 'headlines', 'top stories', 'what's happening', 'catch me up', or 'what's the news'. The panel uses cached data so it appears instantly. After opening, briefly speak the top headline so the operator hears it as the panel mounts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "hide_news_panel",
      description:
        "Close the news panel and stop the live Sky News stream. Use when the operator says 'close the news', 'hide the news', 'turn that off' while the news panel is showing, or naturally moves on to another topic.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "request_browse",
      description:
        "Drive a real Chromium browser to accomplish a web-based goal. The bridge runs a vision-driven inner loop using Claude or GPT to click around, read pages, and report back. Use for: 'find me the cheapest X', 'check if Y is in stock', 'summarise this article at <url>', 'fill in this form for me'. NEVER use for purchases (use request_purchase) or for sensitive sites (banks, broker accounts, gov.uk login). Returns a final answer the LLM can speak to the operator. Costs API tokens — keep maxSteps modest (default 12).",
      parameters: {
        type: "object",
        properties: {
          goal:       { type: "string", description: "Plain-English goal — be specific. e.g. 'Find the price of a 2L semi-skimmed milk on tesco.com'" },
          startUrl:   { type: "string", description: "Optional starting URL. If omitted, the model picks. Most useful when the operator says 'go to X and...'" },
          maxSteps:   { type: "number", description: "Hard cap on steps in the inner loop. Default 12, max 30. Higher = more accurate but more API spend." },
        },
        required: ["goal"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_products",
      description: "Search a merchant for products WITHOUT buying — uses request_browse internally to compare options. Use BEFORE request_purchase when the operator hasn't picked a specific item yet. Returns a shortlist with prices the operator can choose from. Example: 'find me a 50mm prime under £400 on WEX' → returns 3-5 candidates. Ask the operator which one to buy.",
      parameters: {
        type: "object",
        properties: {
          merchant: { type: "string", description: "Merchant domain or label from the allowlist (e.g. 'wexphotovideo.com', 'mpb.com', 'amazon.co.uk')." },
          query:    { type: "string", description: "Product description in natural language." },
          maxPriceGbp: { type: "number", description: "Optional upper bound for filtering results." },
        },
        required: ["merchant", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_flights",
      description: "Search Skyscanner for flights — read-only. Use for: 'find me a return to Madrid next weekend', 'cheapest flight to JFK in March'. Returns top results the operator can review. Does NOT book — booking requires going to the airline directly via open_url after the operator picks one.",
      parameters: {
        type: "object",
        properties: {
          from:      { type: "string", description: "Origin — IATA code or city. e.g. 'MAN', 'Manchester'." },
          to:        { type: "string", description: "Destination — IATA code or city. e.g. 'BCN', 'Barcelona'." },
          depart:    { type: "string", description: "Departure date (YYYY-MM-DD or natural language like 'next Friday')." },
          returnDate:{ type: "string", description: "Optional return date for a round trip." },
          adults:    { type: "number", description: "Number of adults. Default 1." },
        },
        required: ["from", "to", "depart"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_active_jobs",
      description: "Cancel any in-flight long-running operation (active browse_web loop, caption_shoot_folder batch). Use when the operator says 'stop', 'cancel', 'abort', or hits Esc. Idempotent — calling when nothing is running is harmless.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_pptx",
      description: "Build a PowerPoint deck with the agency's brand styling. Use for: client pitch decks, shoot recap presentations, project updates. Slide types: cover (auto-generated as slide 1), section (divider), content (title + body or bullets), image (full-bleed photo), two-column (split text). Output lands in output/pptx/.",
      parameters: {
        type: "object",
        properties: {
          title:    { type: "string", description: "Deck title — also the cover slide headline." },
          subtitle: { type: "string", description: "Optional cover subtitle (e.g. client name, project tag)." },
          slides:   { type: "array", description: "Ordered list of slides. Each: { type, title?, body?, bullets?, left?, right?, imagePath? }",
            items: { type: "object", properties: {
              type:      { type: "string", enum: ["cover", "section", "content", "image", "two-column"] },
              title:     { type: "string" },
              subtitle:  { type: "string" },
              body:      { type: "string" },
              bullets:   { type: "array", items: { type: "string" } },
              left:      { type: "string" },
              right:     { type: "string" },
              imagePath: { type: "string", description: "Absolute or project-relative path to a JPG/PNG. The file must exist when this tool runs." },
            } } },
        },
        required: ["title", "slides"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_docx",
      description: "Generate a Word document with the agency's brand styling. Use for: shoot briefs, client reports, scripts, meeting summaries. Each section becomes an H1 + body paragraphs. Title appears as a centred heading at the top, agency footer line at the bottom. Output lands in output/docx/.",
      parameters: {
        type: "object",
        properties: {
          title:    { type: "string" },
          subtitle: { type: "string" },
          sections: { type: "array", description: "Ordered list of sections.",
            items: { type: "object", properties: {
              heading:    { type: "string" },
              paragraphs: { type: "array", items: { type: "string" } },
              body:       { type: "string", description: "Alternative to paragraphs[] when there's just one block." },
            } } },
        },
        required: ["title", "sections"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_xlsx",
      description: "Generate an Excel workbook with brand-styled headers. Use for: shoot logs, contact lists, project trackers, schedules. Each sheet gets a frozen header row (brand-coloured fill) plus banded body rows for readability. Rows can be arrays of values in header order OR objects keyed by header. Output lands in output/xlsx/.",
      parameters: {
        type: "object",
        properties: {
          title:  { type: "string" },
          sheets: { type: "array",
            items: { type: "object", properties: {
              name:    { type: "string", description: "Sheet tab name (max 31 chars, no /\\?*[]: chars)." },
              headers: { type: "array", items: { type: "string" } },
              rows:    { type: "array", description: "Array of arrays OR array of objects keyed by header." },
            } } },
        },
        required: ["title", "sheets"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_agent_run",
      description: "Run LLM-authored async JavaScript in a sandboxed worker. Use when no pre-built tool combination expresses the workflow you need — e.g. 'for each shoot folder modified today, generate a contact sheet then watermark the cheapest result'. Inside the sandbox: `await tools.<name>(args)` calls any allowedTools. Standard JS builtins (Math, JSON, Date, Promise, Array, etc) plus console.log are available. NO fs, network, process, or require — those are reachable only via tools the operator explicitly allowed. ALWAYS confirmation-gated: the operator hears a one-line summary and says 'yes' before any code runs. Returns the script's return value plus captured stdout/stderr.",
      parameters: {
        type: "object",
        properties: {
          code:         { type: "string", description: "JS source. Treated as the body of an async IIFE — `return value` to provide a result, `await` works at top level." },
          allowedTools: { type: "array", items: { type: "string" }, description: "Whitelist of tool names the script may call. Required — explicitly enumerate what the script needs. Empty array = no tools." },
          timeoutMs:    { type: "number", description: "Hard timeout (worker.terminate). Default 30000, cap 120000." },
          purpose:      { type: "string", description: "One-sentence description of what this script does. Goes in the audit log; helps the operator understand what they're approving." },
        },
        required: ["code", "allowedTools", "purpose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_workspace",
      description: "Create a new operating-context workspace. A workspace is a bounded scope the operator works inside (e.g. 'consulting', 'photo-agency', 'personal'). When active: (1) the LLM sees a system-prompt fragment with the workspace's description + handbook, (2) tool calls resolve working-dir paths to this workspace's working_root, (3) only tools in the toolAllowlist are exposed to the LLM (NULL = all tools), (4) the workspace's creative-style.md (if any) overrides the global one. Use when the operator says 'create a workspace called …', 'set up a new workspace for …', 'I want a separate context for …'.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Stable identifier — lowercase, alphanumeric + hyphen, 2-41 chars (e.g. 'consulting', 'photo-agency')." },
          label: { type: "string", description: "Human-readable display name (e.g. 'Consulting practice', 'Photo agency')." },
          description: { type: "string", description: "OPTIONAL one-line description of what this workspace is for." },
          handbook: { type: "string", description: "OPTIONAL multi-line workspace handbook — operator's scope-specific rules / vocabulary / preferences. Injected into the LLM system prompt verbatim when this workspace is active." },
          workingRoot: { type: "string", description: "OPTIONAL absolute path to the working directory for this workspace. When set, tools that resolve working-dir paths use this root instead of the global default. Useful for scoping a workspace to a specific project folder." },
          toolAllowlist: { type: "array", items: { type: "string" }, description: "OPTIONAL list of tool names to allow in this workspace. When set, the LLM only sees these tools (built-in + plugin) — narrows the catalog from 60+ to a workspace-relevant subset. Omit or pass null to allow all tools." },
          creativeStylePath: { type: "string", description: "OPTIONAL path to a creative-style.md file specific to this workspace. Overrides the global config/creative-style.md when active. Relative paths resolve under the project root or workspace working_root." },
          voice: { type: "string", description: "OPTIONAL Kokoro voice id for this workspace's TTS. e.g. 'bm_daniel' (formal British male — default for consulting), 'bf_emma' (warmer British female — for personal). When active, the workspace's voice overrides the global Settings → Voice preference. List available voices with `list_voices`." },
          accentColor: { type: "string", description: "OPTIONAL #rrggbb hex colour for the workspace persona. When this workspace is pinned to a window (via ?workspace=slug URL param), the HUD's --accent + derived deep/glow/tint variables follow this colour. Lets the operator distinguish personas at a glance — cyan Jarvis vs amber Friday." },
          agentLabel: { type: "string", description: "OPTIONAL persona name shown in the wordmark when this workspace is pinned to a window. e.g. 'Friday', 'Aria'. Defaults to the global brand agent name when unset." },
        },
        required: ["slug", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "switch_workspace",
      description: "Set or clear the active workspace. The system prompt fragment for the active workspace is injected into every LLM call going forward. Pass slug=null (or omit) to clear the active workspace and operate without scope.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Workspace slug to activate. Omit or pass null to clear active workspace." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_workspaces",
      description: "List all workspaces, last-used first. Surfaces slug, label, description, and which one is currently active. Use when the operator says 'what workspaces do I have', 'show my workspaces', 'which one am I in'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "act_on_inbox_item",
      description: "Operate on an inbox item the operator just heard about in a smart_inbox_briefing. Resolves an ordinal (1-based: 'the first one', 'second', 'third') against the cached aggregate, then routes to the appropriate downstream action: reply (drafts an email pre-populated with the sender + subject), open (opens Mail/Calendar/Reminders to that item), snooze (Reminders only — pushes due date forward), accept/decline (Calendar only — RSVP to the event), complete (Reminders — ticks it off). Use when the operator says 'reply to the first one', 'open the second', 'snooze that', 'accept the next meeting', 'tick off the third reminder'.",
      parameters: {
        type: "object",
        properties: {
          ordinal: { type: "number", description: "1-based index into the most-recent briefing's item list. 1 = first item the operator heard." },
          action: { type: "string", enum: ["reply", "open", "snooze", "accept", "decline", "complete"], description: "What to do. 'reply' drafts an email response (mail items only). 'open' surfaces the item in its native app. 'snooze' pushes a reminder's due date by 1 day. 'accept'/'decline' RSVP a calendar event. 'complete' ticks off a reminder." },
          replyBody: { type: "string", description: "OPTIONAL. For action='reply', the operator's draft text. If omitted, the email is created empty for the operator to type into Mail.app." },
          snoozeMinutes: { type: "number", description: "OPTIONAL. For action='snooze', minutes to push the due date forward. Default 60." },
        },
        required: ["ordinal", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "List open (uncompleted) reminders from Reminders.app — every list by default, or one specific list. Returns title + due date + notes + list name. Used by the Smart Inbox aggregator and by direct voice queries like 'what reminders do I have', 'show my to-dos', 'what's pending'.",
      parameters: {
        type: "object",
        properties: {
          listName: { type: "string", description: "OPTIONAL list name to scope to (e.g. 'Work', 'Shopping'). Omit for all lists." },
          includeCompleted: { type: "boolean", description: "OPTIONAL. Default false. Set true to include reminders the operator has already ticked off." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "smart_inbox_briefing",
      description: "The 'what's important right now' answer. Aggregates unread mail + today's calendar + (later) reminders, then ranks by what matters per the active workspace's handbook + standard urgency heuristics (imminent events, sender-known emails, deadline-tight reminders). Returns a structured briefing: top 3-5 priorities, each with a one-line rationale + a suggested next action. Use when the operator says 'what's important', 'what should I do first', 'brief me', 'what's on my plate', 'what's the day looking like'.",
      parameters: {
        type: "object",
        properties: {
          topN: { type: "number", description: "OPTIONAL. Default 3. Number of priorities to surface in the briefing. Cap 8 — beyond that, the operator is reading a list, not a briefing." },
          force: { type: "boolean", description: "OPTIONAL. Default false. Skip the 60s aggregation cache and re-fetch every source. Use when the operator says 'fresh briefing' or just acted on an email/event." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_app",
      description: "Activate a macOS application by name. Launches it if not running, brings it to the front if it is. Use when the operator says 'open Photoshop', 'launch Safari', 'switch to Mail', 'bring up Final Cut'. Accepts the menu-bar name ('Photoshop') or full bundle name ('Adobe Photoshop 2024'). Returns ok:false with a clear message if the app is not installed.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Application name as it appears in the menu bar or Applications folder." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_system_volume",
      description: "Set macOS output volume to a 0-100 level. 0 mutes, 100 is max. Use when the operator says 'volume 30', 'turn it down', 'turn it up', 'mute', 'turn the sound off', 'set volume to half'. Interpret relative phrases ('down a bit') by reading the current level via osascript first if you need to — otherwise pick a reasonable absolute (e.g. 'down a bit' ≈ 20-30, 'up a lot' ≈ 80).",
      parameters: {
        type: "object",
        properties: {
          level: { type: "number", description: "0-100. Clamped to range. 0 mutes." },
        },
        required: ["level"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lock_screen",
      description: "Lock the Mac — display sleeps immediately, password required on wake. Use when the operator says 'lock my screen', 'lock the Mac', 'I'm stepping away', 'lock it'. Different from sleep_display (would put just the display to sleep without security): this is the security-conscious 'I'm leaving the desk' verb.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Type a string into whatever app is currently focused. Use when the operator says 'type my email', 'paste the address', 'fill in <text>', or wants to dictate text into a form/search bar without touching the keyboard. REQUIRES Accessibility permission. Operator must confirm before this runs — typing into the wrong field (especially a password) is irreversible.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type. Capped at 4000 characters. Newlines are typed as Return keystrokes." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "morning_brief",
      description: "Proactive 'good morning, here's your day' briefing. Aggregates weather + today's calendar + smart-inbox priorities + top news headlines into a single 60-90 second flowing narrative — not a list. Use when the operator says 'good morning', 'brief me on today', 'morning brief', 'give me the rundown', 'what's the day looking like in full'. For 'what's important right now' use smart_inbox_briefing instead — that returns a ranked list, this returns a spoken-paragraph narrative covering weather + day shape + headlines.",
      parameters: {
        type: "object",
        properties: {
          force: { type: "boolean", description: "OPTIONAL. Default false. Skip cached weather/inbox/news and refetch every source. Use when the operator says 'fresh morning brief' or it's been hours since the last." },
          newsCount: { type: "number", description: "OPTIONAL. Default 3. Number of news headlines to mention. Cap 5 — beyond that the brief stops being a brief." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "workspace_insights",
      description: "Summarise what's in a workspace: turn count (all-time + last 7 days), conversation summaries, contacts, projects, facts, indexed documents. Use when the operator says 'how active is the consulting workspace', 'what's in this workspace', 'show me workspace stats'. Defaults to the active workspace.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "OPTIONAL workspace slug. Omit to inspect the currently-active workspace." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_workspace_knowledge",
      description: "Re-scan the active workspace's working directory and ingest every supported document (.md, .txt, .pdf, .docx, .html, .rtf) into its scoped knowledge base. Idempotent — files that haven't changed since the last scan (matched by sha256 hash) are skipped without re-embedding. Use when the operator says 'refresh my workspace knowledge', 'index this folder', 'ingest the new files'. Auto-runs in the background on workspace switch when the workspace has working_root set, so the operator usually doesn't need to call this directly.",
      parameters: {
        type: "object",
        properties: {
          force: { type: "boolean", description: "OPTIONAL. Default false. Set true to force re-embed every file even if its hash hasn't changed (rare — useful after switching embedding model)." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "export_workspace",
      description: "Bundle a workspace (manifest + handbook + creative-style + facts/contacts/projects/summaries scoped to it) into a portable .jarvis-workspace.tgz on the operator's Desktop. Default EXCLUDES raw conversation_turns (the most personal data); pass includeTurns:true to bundle them too. Use when the operator says 'export the consulting workspace', 'back up my workspace', 'I want to move this to a different Mac'.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Slug of the workspace to export." },
          includeTurns: { type: "boolean", description: "OPTIONAL. Default false. Set true to include the raw conversation transcript in the bundle. Summaries are always included; turns are opt-in for privacy." },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "import_workspace",
      description: "Restore a workspace from a .jarvis-workspace.tgz bundle. The bundle's manifest provides the slug + label + handbook + creative-style + scoped data. Refuses to clobber an existing workspace of the same slug unless overwrite:true. Operator confirmation required (writes to memory.db).",
      parameters: {
        type: "object",
        properties: {
          bundlePath: { type: "string", description: "Absolute path to the .jarvis-workspace.tgz file." },
          overwrite: { type: "boolean", description: "OPTIONAL. Default false. Set true to replace an existing workspace of the same slug." },
          includeTurns: { type: "boolean", description: "OPTIONAL. Default true. When the bundle contains conversation turns, restore them. Set false to import metadata + summaries only." },
        },
        required: ["bundlePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_workspace",
      description: "Permanently remove a workspace. The workspace's handbook is deleted. If the deleted workspace was active, active is cleared. Operator confirmation required.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Slug of the workspace to delete." },
        },
        required: ["slug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "build_plugin",
      description: "Scaffold a new Jarvis plugin from a voice command. Creates bridge/plugins/<name>/{manifest.json, handler.mjs} and triggers the hot-reload watcher so the new tool is callable in the same session — no restart. Use when the operator says something like 'build me a plugin that…', 'make a tool to…', 'I want jarvis to be able to…'. Two modes: STUB (default) writes a working placeholder handler the operator fills in by hand; CODE-AGENT (set `behaviour` arg) writes a manifest and seeds a handler, then the LLM should call `code_agent_run` with the agent prompt returned in the result to fill in real logic. Operator confirmation required (writes to filesystem).",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Plugin slug — lowercase letters, digits, hyphens. 2-41 chars. e.g. \"hackernews\", \"weather-pro\", \"slack-relay\". This becomes the directory name under bridge/plugins/.",
          },
          description: {
            type: "string",
            description: "One-line description of what the plugin does. Operator-facing — surfaced in the tool catalogue and the COMMANDS panel.",
          },
          toolName: {
            type: "string",
            description: "Snake_case identifier for the voice-callable tool the plugin registers. e.g. \"fetch_top_hn\". 2-61 chars. Becomes the function name the LLM dispatches.",
          },
          voiceIntent: {
            type: "string",
            description: "Short phrase the operator says to invoke the tool — e.g. \"top hacker news\", \"latest crypto prices\". Goes in the manifest's tool description so the tool router and selector can match voice → tool.",
          },
          behaviour: {
            type: "string",
            description: "OPTIONAL. If provided, switches to code-agent mode: a longer description of what the handler should DO. e.g. \"fetch https://hacker-news.firebaseio.com/v0/topstories.json, get top 10, fetch each story's title + url, return as a list\". The LLM should follow up with code_agent_run using the agent prompt this tool returns.",
          },
          force: {
            type: "boolean",
            description: "OPTIONAL. Default false. Set true to overwrite an existing plugin with the same slug. Operator must explicitly grant this in the voice command (e.g. \"replace the existing one\").",
          },
        },
        required: ["name", "description", "toolName", "voiceIntent"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "Search the operator's curated knowledge base — brand briefs, client onboarding docs, past press releases, anything they dropped into docs/knowledge/. Hybrid retrieval: vector cosine similarity + BM25 keyword fusion via Reciprocal Rank Fusion. Returns top-K chunks with source citations (rel path, title, format) so replies can quote the source. Use whenever the operator asks something that might be in their docs — 'what did the client brief say about deliverables', 'what's the brand voice on hashtags', 'how did we phrase the Bentley press release'.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language query. The operator's exact words usually work — the embedder handles paraphrasing." },
          topK:  { type: "number", description: "How many chunks to return. Default 8, max 20." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ingest_knowledge",
      description: "Re-scan the docs/knowledge/ folder and ingest any new or changed files. Normally automatic via the file watcher, but call this when the operator explicitly says 'reindex my docs' or after dropping a batch in. Returns counts: ingested, skipped (unchanged), failed, removed.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_products",
      description:
        "Compare a product across multiple online retailers IN PARALLEL. Builds a multi-agent crew under the hood — one research agent per merchant runs simultaneously via request_browse, then a synthesis agent merges findings into a comparison table. Use for: 'compare 50mm primes across WEX, MPB and Park Cameras', 'find me the best deal on a vacuum across Currys and AO and John Lewis'. Requires a cloud vision provider (anthropic / openai) because each research agent uses request_browse. ~3x faster than sequentially asking the LLM to research each merchant.",
      parameters: {
        type: "object",
        properties: {
          item:        { type: "string", description: "Plain-English product description, e.g. '50mm f1.4 prime' or 'compact dishwasher under 50dB'." },
          merchants:   { type: "array", items: { type: "string" }, description: "2-4 merchant domains or labels from the allowlist. e.g. ['wexphotovideo.com', 'mpb.com', 'parkcameras.com']." },
          maxPriceGbp: { type: "number", description: "Optional upper bound for candidate filtering." },
        },
        required: ["item", "merchants"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_eod_digest",
      description: "Generate the operator's end-of-day activity digest — replies count, purchases made (settled + blocked), renders shipped, files dropped into the inbox, top tools used, LLM spend. Use when operator says 'what did I do today', 'summarise my day', 'daily wrap'. Returns a structured JSON plus a plain-text version the LLM can read aloud verbatim.",
      parameters: {
        type: "object",
        properties: {
          sinceTs: { type: "number", description: "Optional cutoff timestamp ms. Default = midnight today." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transcribe_video",
      description: "Transcribe a video file end-to-end. Strips audio with ffmpeg → local Whisper for timestamped speech segments → samples N keyframes → vision LLM captions each one. Returns timestamped speech + frame captions + a single interleaved narrative. Use for: 'transcribe yesterday's interview', 'what's said in the press-launch clip', 'summarise this raw rushes file'. Slower than text tools (30-90s for a 5-minute clip) so use sparingly.",
      parameters: {
        type: "object",
        properties: {
          path:          { type: "string", description: "Filesystem path — absolute or relative to project root. Must be a video file (mp4/mov/m4v/mkv/avi/webm)." },
          includeVisual: { type: "boolean", description: "Sample frames + caption them via the vision LLM. Default true. Set false for audio-only transcription (faster, no API cost)." },
          sampleFrames:  { type: "number", description: "How many keyframes to caption when includeVisual is true. Default 8, max 20. More frames = more API spend." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_purchase",
      description:
        "Request a small online purchase on behalf of the operator using the pre-funded virtual debit card. Hard limits enforced by the bridge: per-transaction cap, daily/weekly budget, merchant allowlist. Currently runs in SIMULATOR MODE — no real money moves until the operator flips data/spending-limits.json.simulatorMode to false. Use ONLY when the operator explicitly asks to buy something (e.g. 'order me a pint of milk from Tesco', 'get an Uber Eats curry'). Never auto-trigger a purchase from passive context. The merchant must be in the allowlist; if it isn't, do not retry — instead tell the operator and ask if they want to add it.",
      parameters: {
        type: "object",
        properties: {
          merchant:       { type: "string", description: "Merchant domain or label (e.g. 'amazon.co.uk', 'Argos', 'https://www.tesco.com/...'). Must match data/merchant-allowlist.json." },
          item:           { type: "string", description: "What the operator asked for, in plain English. e.g. 'Two pints of semi-skimmed milk'." },
          maxPriceGbp:    { type: "number", description: "Upper bound the operator authorised in £. Do not invent prices — ask if unstated. Bridge rejects values over the per-transaction cap." },
          justification:  { type: "string", description: "One sentence on why this purchase is being made. Stored in the audit journal so the operator can review later." },
        },
        required: ["merchant", "item", "maxPriceGbp", "justification"],
      },
    },
  },
];

/** Workspace v1: apply a workspace's overrides (working dir, creative style).
 *  Called from both the switch_workspace tool case AND the POST /workspaces/active
 *  HTTP endpoint, so the side-effect logic stays in one place.
 *
 *  Side effects:
 *    1. Paths.setWorkspaceOverride — getWorkingDir() returns the workspace's
 *       working_root for the rest of the turn (or until next switch).
 *    2. setCreativeStyleOverride — creative-style.md loaded for prompt
 *       injection becomes the workspace's file (resolved against working_root
 *       if relative).
 *
 *  Pass null/undefined to clear overrides. */
function applyWorkspaceOverrides(w) {
  Paths.setWorkspaceOverride(w?.workingRoot || null);
  /* Creative-style override path can be absolute or relative. If relative,
   * resolve under the workspace's working_root first; if no working_root,
   * resolve under PROJECT_ROOT. Empty / missing → clear override (back to
   * config/creative-style.md global default). */
  if (w?.creativeStylePath) {
    const raw = String(w.creativeStylePath).trim();
    let abs;
    if (path.isAbsolute(raw)) {
      abs = raw;
    } else if (w.workingRoot) {
      abs = path.resolve(w.workingRoot, raw);
    } else {
      abs = path.resolve(PROJECT_ROOT, raw);
    }
    setCreativeStyleOverride(abs);
  } else {
    setCreativeStyleOverride(null);
  }
  /* Workspaces v3: auto-ingest the workspace's working directory in the
   * background. Idempotent — Knowledge.ingestAll skips files whose sha256
   * hasn't changed since the last scan, so re-running on every switch is
   * cheap once warm. The Memory.upsertDocument call inside ingestFile
   * stamps with the active workspace via the slug provider wired in
   * Sprint 5, so documents land in the workspace's scoped knowledge base.
   *
   * Skipped when no workspace is active OR no working_root is set
   * (default "personal" workspace has none — operator opts in by setting
   * one). The .catch() swallows scan failures so a missing dir / permission
   * issue doesn't crash the switch path. */
  if (w?.workingRoot) {
    /* Fire-and-forget — the switch returns immediately; the scan
     * progresses in the background and broadcasts events. */
    Knowledge.ingestAll(w.workingRoot)
      .then((r) => {
        if (r?.ok && (r.ingested || r.removed)) {
          broadcastToClients({
            type: "knowledge.workspace.scanned",
            data: { slug: w.slug, ingested: r.ingested, skipped: r.skipped, failed: r.failed, removed: r.removed },
          });
        }
      })
      .catch((e) => console.warn(`[workspaces] auto-ingest of "${w.slug}" failed: ${e.message}`));
  }
}

/** Workspace v1: return the TOOLS array filtered by the active workspace's
 *  toolAllowlist. When no workspace is active, or the active workspace has
 *  no allowlist set, returns the full TOOLS array unchanged. The filter
 *  applies to BUILT-IN tools (TOOLS array) only — plugin tools are added
 *  by PluginLoader.init AFTER this declaration; we filter both via the
 *  same name-set check at call time.
 *
 *  Why a function (not a cached value): the allowlist can change mid-session
 *  when the operator switches workspaces, and TOOLS itself can change when
 *  a plugin hot-reloads. Recomputing per LLM call is cheap (small array
 *  filter, ~200ns) and keeps every askLLM call in lockstep with the current
 *  scope.
 *
 *  Always-allowed: the workspace-management tools themselves. An allowlist
 *  that hides switch_workspace would trap the operator inside a workspace
 *  with no escape, which is awful UX. */
const _ALWAYS_AVAILABLE_TOOLS = new Set([
  "create_workspace", "switch_workspace", "list_workspaces", "delete_workspace",
]);
function getEffectiveTools() {
  const w = Workspaces.getActive();
  if (!w?.toolAllowlist) return TOOLS;
  const allowed = new Set(w.toolAllowlist);
  return TOOLS.filter((t) => {
    const name = t?.function?.name;
    if (!name) return false;
    return allowed.has(name) || _ALWAYS_AVAILABLE_TOOLS.has(name);
  });
}

/* ---------- ASYNC VIDEO RUN STATE ---------- */
let currentVideoRun = null;
/**
 * Broadcast a typed event envelope to every connected HUD client.
 *
 * Envelope contract: { type, runId?, ts, data?, error? }
 *  - ts is auto-stamped if the caller didn't provide one
 *  - runId is included when the event correlates with a task lifecycle
 *  - error is a top-level string for failures (some legacy events still use this)
 *  - data is the typed payload
 */
function broadcastToClients(payload) {
  const stamped = { ts: Date.now(), ...payload };
  const data = JSON.stringify(stamped);
  for (const c of clients) { if (c.readyState === 1) c.send(data); }
}
/* Wire the broadcaster into the task lifecycle module so its emissions land on every client. */
Tasks.setBroadcaster(broadcastToClients);
/* Wire the system-warnings registry — bridge-detected misconfigurations
 * (macmon missing, LLM key invalid, etc.) emit `system.warning` events the
 * HUD turns into toasts so they don't get buried in /tmp/jarvis-bridge.log. */
SystemWarnings.setBroadcaster(broadcastToClients);
/* Wire the crash reporter — installs process-level uncaughtException +
 * unhandledRejection hooks. The bridge's package.json version is the
 * canonical version string. Without this, an unhandled error would
 * silently kill the bridge with the operator never knowing. */
import { readFileSync as _crashReaderfs } from "node:fs";
let _bridgePkgVersion = "?";
try { _bridgePkgVersion = JSON.parse(_crashReaderfs(new URL("../package.json", import.meta.url), "utf8")).version || "?"; } catch {}
CrashReporter.init({ version: _bridgePkgVersion, broadcaster: broadcastToClients });
/* Background news cache — populate on boot, refresh every 60 min. Failures
 * here must NOT block startup; the news.mjs module logs warnings internally. */
try { News.start(); } catch (e) { console.warn(`[server] News.start failed: ${e.message}`); }
/* Pre-warm the inbox / weather / calendar caches so the first "brief me" /
 * "what's the weather" / "what's on today" answer is instant. Each fetcher
 * forces a fresh refresh inside the owning module's cache; tool handlers
 * keep using the normal call path and just happen to hit a warm entry. */
try {
  Prewarm.start({
    warmInbox:    () => Inbox.aggregate({ days: 1, mailMax: 15, force: true }),
    warmWeather:  () => getWeather(CONFIG.operator.latitude, CONFIG.operator.longitude, 6, { force: true }),
    warmCalendar: () => getUpcomingEvents({ days: 1, force: true }),
  });
} catch (e) { console.warn(`[server] Prewarm.start failed: ${e.message}`); }
/* Wire the personal-assistant timer broadcaster — fires timer.set/timer.fire/timer.cancel
 * events the HUD listens for to render the countdown badge + speak the label on fire. */
Personal.setBroadcaster(broadcastToClients);
/* Wire the crew orchestrator — emits crew.started / crew.agent.* / crew.complete
 * events the HUD will surface as parallel lanes once that UI ships. Plus the
 * tool-dispatch hook so crew agents can actually call request_browse / web_search
 * / etc on top of the chat() call (without it, agents are chat-only). */
Crew.setBroadcaster(broadcastToClients);
Crew.setToolDispatch({ tools: TOOLS, executeTool });
/* Code agent — escape hatch for novel workflow composition. Wire the
 * executeTool ref so user-authored JS in the worker can call tools.* and
 * have those calls round-trip back here for dispatch. */
CodeAgent.setToolExecutor(executeTool);
CodeAgent.setBroadcaster(broadcastToClients);

/* Knowledge base — boot-time ingest of docs/knowledge/ + folder watcher.
 * Initial scan picks up any files dropped while the bridge was offline;
 * the watcher fires on subsequent changes (debounced 500ms per path so
 * editor-staged saves don't cause repeat re-ingests). */
Knowledge.setBroadcaster(broadcastToClients);
Knowledge.ingestAll().then((r) => {
  if (r.ok) console.log(`[knowledge] initial scan: ${r.ingested} ingested, ${r.skipped} unchanged, ${r.failed} failed, ${r.removed || 0} removed (root: ${Knowledge.knowledgeRoot()})`);
  else console.warn(`[knowledge] initial scan failed: ${r.error}`);
}).catch((e) => console.warn(`[knowledge] initial scan threw: ${e.message}`));
Knowledge.startWatcher();
/* Plugin loader is initialised lower in the module — after NEEDS_CONFIRMATION
 * + executeTool are declared (TDZ would fire here). See PluginLoader.init()
 * call further down. */

/* Inbound iMessage listener — disabled by default (operator opts in via
 * data/imessage-config.json). When enabled and an allowlisted sender
 * sends a message starting with the trigger phrase, we strip the trigger
 * and forward the rest through askLLMStream — same loop as voice — and
 * reply via the existing send_imessage tool path. The reply skips the
 * usual confirmation gate since the operator initiated by texting in
 * (their explicit consent IS the inbound message itself). */
IMessageListener.start(async ({ from, body, raw }) => {
  console.log(`[imessage] inbound from ${from}: "${body.slice(0, 80)}"`);
  /* Plan-broadcast so the HUD shows the inbound + impending reply. */
  broadcastToClients({
    type: "imessage.inbound",
    data: { from, body: body.slice(0, 200), receivedAt: Date.now() },
  });
  let reply = "";
  try {
    /* sessionId tags imessage turns separately so the H drawer can show
     * "this thread" filtered to just iMessage exchanges. */
    reply = await askLLMStream({
      query: body,
      history: [],
      sessionId: `imessage:${from}`,
      onSentence: () => {}, /* no streaming TTS — text-only reply */
    });
  } catch (e) {
    reply = `Sorry — bridge error: ${e.message}`;
  }
  if (!reply || !reply.trim()) reply = "Acknowledged.";
  /* Send the reply via the same tool the LLM uses. Pass confirmed:true
   * to bypass the voice confirmation gate — the operator's text IS the
   * confirmation, asking again over text would be infinite-loop bait. */
  try {
    await Personal.sendIMessage({ to: from, body: reply.slice(0, 1500), confirmed: true });
    broadcastToClients({
      type: "imessage.replied",
      data: { to: from, body: reply.slice(0, 200) },
    });
  } catch (e) {
    console.warn(`[imessage] reply send failed: ${e.message}`);
  }
});
/* Wire the notifications scheduler. Each emitter calls back into broadcastToClients
 * via this hook. Tier 1-4+6 from the operator's pick list — calendar reminders,
 * press-radar pings, mail digest, frame.io activity, bridge health. */
Notify.setBroadcaster(broadcastToClients);
Notify.startCalendarReminders({
  /* Reuse getUpcomingEvents directly so the reminder scheduler shares the same
   * Calendar.app launch + AppleScript path as the diary widget. days=2 covers
   * "today + tomorrow morning" reminders without bloating the scan. */
  getEvents: async () => {
    try { const r = await getUpcomingEvents({ days: 2 }); return r.events || []; }
    catch (e) { console.warn(`[notify] reminder fetch failed: ${e.message}`); return []; }
  },
});
/* Bridge-health observer — every 60s probe Ollama/Kokoro/Whisper and feed the
 * snapshot to Notify so an unexpected service drop fires an "alert" toast.
 * Quiet on boot (recordHealthSnapshot only emits on edges, not initial state). */
setInterval(async () => {
  try {
    const [oll, kok, whi] = await Promise.allSettled([
      fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) }),
      fetch("http://localhost:8767/health", { signal: AbortSignal.timeout(2000) }),
      fetch("http://localhost:8768/health", { signal: AbortSignal.timeout(2000) }),
    ]);
    Notify.recordHealthSnapshot({
      services: {
        ollama:  oll.status === "fulfilled" && oll.value.ok,
        kokoro:  kok.status === "fulfilled" && kok.value.ok,
        whisper: whi.status === "fulfilled" && whi.value.ok,
      },
    });
  } catch { /* best-effort; next tick retries */ }
}, 60_000);
/* Recover interrupted-by-restart tasks: emits task.error for any in-flight task
 * that was running when the previous bridge process exited. The HUD task strip
 * picks these up and clears, the operator sees a clear "this got cancelled" toast.
 * Also records each orphan to the audit log so the history outlives a HUD that
 * wasn't connected at recovery time. drainPendingReplay() runs on first WS connect
 * (see ws.on('connection') handler) to replay the events to a freshly-opened HUD. */
Tasks.recoverInterrupted((entry) => Audit.record(entry));

/* ---------- CONFIRMATION GATE ----------
 * Why: Qwen sometimes fires destructive tools without spoken confirmation despite the
 * system-prompt asking for it. This gate makes confirmation MANDATORY at the bridge
 * level for tools that produce client-visible side effects. The contract:
 *   1st call:  args.confirmed !== true → bridge returns { requires_confirmation: "<human-readable summary>" }
 *              Qwen MUST speak the summary and wait for "yes"/"go ahead"/"proceed" from operator.
 *   2nd call:  args.confirmed: true → tool actually runs.
 *
 * Auto-replay safety net: Qwen 2.5 7b is unreliable at re-emitting the second
 * tool_call with confirmed:true — it tends to narrate "generating the hero image…"
 * without actually firing. So when the gate trips, the bridge stashes the call
 * in _pendingConfirmation; on the next user turn, if the transcript matches an
 * affirmative phrase ("yes", "go ahead", "do it", …), the bridge fires the
 * gated tool itself with confirmed:true before involving the LLM. The LLM's
 * own re-call path still works if Qwen DOES get it right — the slot is
 * single-use and clears after the tool runs.
 *
 * The summary is built per-tool so the operator hears the consequential details
 * ("send email TO ben@... ABOUT the press car v3 — proceed?") not a generic prompt. */

/* Single-user kiosk → single in-flight pending confirmation. 90s window:
 * generous enough to let the operator hear the "Shall I proceed?" prompt,
 * think, and reply, but short enough that an unrelated "yes" thirty minutes
 * later won't accidentally fire a $0.30 video gen. */
let _pendingConfirmation = null;
const _PENDING_CONFIRMATION_TTL_MS = 90_000;

function _setPendingConfirmation(name, args) {
  _pendingConfirmation = { name, args, expiresAt: Date.now() + _PENDING_CONFIRMATION_TTL_MS };
  console.log(`[bridge] pending confirmation set: ${name}`);
  /* Why: HUD pauses the conversation idle timer while a confirmation is
   * pending — operator is mid-task by definition and shouldn't get dropped
   * back to wake-word listening if they take a moment to respond. */
  try { broadcastToClients({ type: "task.confirmation_pending", data: { tool: name, expiresAt: _pendingConfirmation.expiresAt } }); } catch {}
}

function _clearPendingConfirmation() {
  if (!_pendingConfirmation) return;
  const tool = _pendingConfirmation.name;
  _pendingConfirmation = null;
  try { broadcastToClients({ type: "task.confirmation_resolved", data: { tool } }); } catch {}
}

/* Why: matched against a single-utterance reply, so we anchor with ^ to
 * avoid catching "yes I want a coffee" as confirmation. Trailing punctuation
 * stripped before the test. Phrases mirror the wake-parsing isAffirmative
 * regex but tightened — only short standalone affirmations qualify here. */
const _AFFIRMATIVE_RE = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|go on|proceed|do it|hit it|fire away|fire it up|confirmed?|let'?s do it|let'?s go|please do)\.?\s*$/i;

function _consumePendingConfirmation(query) {
  if (!_pendingConfirmation) return null;
  if (Date.now() > _pendingConfirmation.expiresAt) {
    _clearPendingConfirmation();
    return null;
  }
  const t = String(query || "").trim().replace(/[.,!?]+$/, "");
  if (!_AFFIRMATIVE_RE.test(t)) return null;
  const c = { name: _pendingConfirmation.name, args: _pendingConfirmation.args };
  _clearPendingConfirmation();
  return { name: c.name, args: { ...c.args, confirmed: true } };
}
const NEEDS_CONFIRMATION = {
  /* Sprint 13 — fal.ai teaser pipeline costs real money per call. Both image
   * gen (~$0.04) and video gen (~$0.30) gate so the operator has to OK the
   * spend before bytes leave for fal. The storyboard step is LLM-only and
   * NOT gated — operator can iterate on the script freely without cost. */
  /* Sprint 13 — these summaries are spoken aloud by Kokoro, so we keep
   * them operator-friendly: the prompt + aspect + clip length, no model
   * names (fal / nano-banana / happy-horse), no dollar amounts. The
   * cost-tracking happens in the bridge log instead. */
  generate_teaser_image: (a) => `Generate the hero image with this prompt: "${(a?.prompt || "").slice(0, 120)}${(a?.prompt || "").length > 120 ? "…" : ""}", at ${a?.aspect || "9:16"} aspect. Shall I proceed?`,
  animate_teaser_image: (a) => `Animate the hero image into a ${a?.duration_s || 5}-second clip with this motion: "${(a?.motion_prompt || "").slice(0, 120)}${(a?.motion_prompt || "").length > 120 ? "…" : ""}". Shall I proceed?`,
  /* Influencer pipeline. create_influencer fires N image gens (~$0.08 each)
   * so we say "three reference portraits" not "an image". Recreation uses
   * Kling Motion Control at ~$0.168/s — operator hears the duration so the
   * spend implication is implicit (5s ≈ £0.65 at current rates). */
  create_influencer: (a) => {
    const count = Math.max(1, Math.min(4, Number(a?.count) || 3));
    return `Generate ${count} reference portrait${count === 1 ? "" : "s"} for ${a?.name || "(no name)"} — ${(a?.persona || "").slice(0, 80)}${(a?.persona || "").length > 80 ? "…" : ""}. Shall I proceed?`;
  },
  recreate_video_with_influencer: (a) => {
    const src = a?.source_url || a?.source_local_path;
    const where = src ? `from ${a?.source_url ? "the linked video" : "the local clip"}` : "(awaiting source from the modal)";
    return `Recreate ${where} starring ${a?.slug || "(no influencer)"}. Shall I proceed?`;
  },
  /* type_text uses System Events keystroke to type into the focused app —
   * destructive if the wrong field is focused (password, search bar that
   * triggers on each keystroke, etc.). Gate it. Preview the first 80
   * chars so the operator hears what would land. */
  type_text: (a) => `Type into the focused app: "${(a?.text || "").slice(0, 80)}${(a?.text || "").length > 80 ? "…" : ""}". Confirm?`,
  draft_email: (a) => `Draft email to ${a.to || "(no recipient)"} with subject "${a.subject || "(no subject)"}". Send it?`,
  add_calendar_event: (a) => `Add calendar event "${a.title || "(no title)"}" on ${a.startDate || a.date || "(no date)"}. Confirm?`,
  run_shell: (a) => `Run shell command: ${(a.command || "").slice(0, 120)}${a.command?.length > 120 ? "…" : ""}. Confirm?`,
  write_file: (a) => `Write to ${a.relPath || "(no path)"} (${(a.content || "").length} bytes). Confirm?`,
  /* Purchases use a synchronous tier check via Purchases.tierForAmount. The auto
   * tier (≤£5 by default) returns null → no voice gate, just journal + go. The
   * voice tier (≤£25 default) returns a summary the LLM must speak verbatim before
   * the operator says "yes"/"go ahead" and we re-enter with confirmed:true. The
   * typed tier is rejected inside requestPurchase() until Patch B ships the HUD
   * modal — better to refuse a £30+ charge than approve it on a voice "yes". */
  request_purchase: (a) => {
    const amount = Number(a?.maxPriceGbp);
    const tier = Purchases.tierForAmount(amount);
    if (tier === "auto") return null;
    const amt = Number.isFinite(amount) ? `£${amount.toFixed(2)}` : "(no price)";
    return `Buy ${a?.item || "(no item)"} from ${a?.merchant || "(no merchant)"} for up to ${amt}. Confirm the purchase?`;
  },
  /* iMessages always go through confirmation — they're sent in your name and
   * can't be unsent. Phone numbers and contact names are spoken back so the
   * operator catches a misheard "Adam" → "Allan" before it leaves the box. */
  send_imessage: (a) => `Send iMessage to ${a?.to || "(no recipient)"}: "${(a?.body || "").slice(0, 100)}"${(a?.body || "").length > 100 ? "…" : ""}. Send?`,
  /* Password lookups should never happen silently — the operator might not
   * remember asking, or someone else in the room could pick up the response.
   * Force a verbal confirm so the credential leaves 1Password only on
   * explicit human go-ahead. */
  lookup_password: (a) => `Look up "${a?.label || "(no label)"}" in 1Password (field: ${a?.field || "password"}). Read the value out?`,
  /* Code execution is the highest-trust thing the LLM can request. Even
   * with the allowedTools allowlist + worker isolation, running arbitrary
   * LLM-authored JS shouldn't happen silently — the operator hears the
   * purpose + tool subset + a code preview before approving. */
  code_agent_run: (a) => {
    const purpose = String(a?.purpose || "(no purpose given)").slice(0, 140);
    const tools = Array.isArray(a?.allowedTools) ? a.allowedTools.slice(0, 6).join(", ") : "(none)";
    const lines = String(a?.code || "").split("\n").length;
    return `Run a code-agent script — purpose: "${purpose}". Allowed tools: ${tools}. ${lines} lines. Confirm before execution?`;
  },
  /* Workspace deletion is destructive — drops the workspace row + its handbook
   * permanently. Operator hears the slug + label before approving. Voice
   * accident protection: a misheard slug is announced verbatim so the
   * operator can catch a wrong one. */
  delete_workspace: (a) => {
    const slug = String(a?.slug || "(no slug)").slice(0, 60);
    return `Permanently delete workspace "${slug}" (handbook + scope rules will be lost). Confirm?`;
  },
  /* Import OVERWRITES on opt-in only; the gate spells out whether the
   * destination workspace exists and what's about to happen. */
  import_workspace: (a) => {
    const file = String(a?.bundlePath || "(no path)").split("/").pop().slice(0, 60);
    const overwrite = a?.overwrite ? " (will overwrite an existing workspace of the same slug)" : "";
    return `Import workspace bundle "${file}"${overwrite}. Proceed?`;
  },
  /* Plugin generation writes to the filesystem — bridge/plugins/<slug>/{manifest.json,
   * handler.mjs}. The plugin-loader's fs.watch then hot-loads the new directory,
   * registering a new voice-callable tool. The operator hears the slug + tool name +
   * voice intent BEFORE any files are written so they can catch a misheard slug
   * before it lands. force=true gets called out so an accidental clobber requires
   * a separate explicit "yes". */
  build_plugin: (a) => {
    const slug = String(a?.name || "(unnamed)").slice(0, 60);
    const tool = String(a?.toolName || "(unnamed)").slice(0, 60);
    const intent = String(a?.voiceIntent || "(no intent)").slice(0, 80);
    const mode = a?.behaviour ? "code-agent will fill the handler" : "stub handler — you fill it in";
    const overwrite = a?.force ? " · OVERWRITES the existing plugin of the same name" : "";
    return `Build plugin "${slug}" with tool ${tool} for "${intent}" — ${mode}${overwrite}. Proceed?`;
  },
};

/** Wrapped tool dispatch — logs every call (success + error) to the audit log
 *  before returning. The wrapper sits OUTSIDE the confirmation gate intentionally:
 *  unconfirmed gate-trip events DO get logged (they're valid dispatches that
 *  legitimately need a confirm round-trip), but the result we record is the
 *  requires_confirmation envelope, not the eventual real result.
 *
 *  Why: a single dispatch site keeps the audit hook airtight — every code path
 *  that adds a new tool case automatically gets logged with no extra wiring. */
/* Tools whose execution is slow or has external side effects worth previewing.
 * The transparent-plan-stage broadcast fires for these BEFORE _executeToolInner
 * runs, so the HUD can show "ABOUT TO: cut a 30s teaser of …" — operator hits Esc
 * if the LLM misheard. Read-only / cheap tools (list_*, get_*, recall, web_search)
 * are excluded so the panel doesn't spam during chatty turns. */
const PLAN_PROPOSED_TOOLS = new Set([
  "generate_youtube_short", "generate_youtube_thumbnail",
  "generate_youtube_promo", "run_shell",
  "draft_email", "add_calendar_event", "create_pdf",
  /* Purchases: always plan-broadcast — operator must see what the LLM intends to
   * buy with a real card BEFORE the dispatcher fires, even if the amount sits
   * inside the auto tier. */
  "request_purchase",
  /* Browse: plan-broadcast so operator sees the goal before a 30-step API spend
   * kicks off. Doubles as transparency — they know the bot's about to drive
   * a browser around. */
  "request_browse",
  /* Transcribe: 30-90s job. Plan-stage so operator sees what's happening. */
  "transcribe_video",
  "compare_products",
  /* Code agent: highest-trust action available — operator wants to see
   * the purpose + line count + tool subset before they say yes. */
  "code_agent_run",
  /* Office docs — non-trivial action with a saved file output. Plan
   * surfaces the title + slide/section/sheet count so the operator
   * knows what's about to land in output/. */
  "generate_pptx", "generate_docx", "generate_xlsx",
  /* Personal-assistant tools that touch the operator's wider digital life —
   * iMessage and music are visible to other people / out of the HUD. Plan-stage
   * the intent so the operator can interrupt before send/play. */
  "send_imessage", "play_music",
]);

/** Build a one-line operator-facing summary of the tool call. Used in the plan-proposed
 *  broadcast and in the audit overlay. Falls back to the raw arg JSON for tools we
 *  haven't authored a custom summariser for. */
function summariseToolCall(name, args) {
  const a = args || {};
  switch (name) {
    case "generate_youtube_short": return `Render a 9:16 YouTube short for ${a.subject || "the latest shoot"}`;
    case "generate_youtube_thumbnail": return `Generate a YouTube thumbnail for ${a.subject || "the latest shoot"}`;
    case "generate_youtube_promo": return `Build a YouTube promo (thumbnail + short) for ${a.subject || "the latest shoot"}`;
    case "run_shell": return `Run shell: ${(a.command || "").slice(0, 60)}${(a.command || "").length > 60 ? "…" : ""}`;
    case "draft_email": return `Draft email to ${a.to || "(recipient)"} — ${(a.subject || "").slice(0, 50)}`;
    case "add_calendar_event": return `Add calendar event "${(a.title || "").slice(0, 40)}" on ${a.start || "(date)"}`;
    case "create_pdf": return `Generate ${a.template || "(template)"} PDF`;
    case "request_purchase": {
      const amt = Number.isFinite(Number(a.maxPriceGbp)) ? `£${Number(a.maxPriceGbp).toFixed(2)}` : "(no price)";
      return `Buy ${a.item || "(item)"} from ${a.merchant || "(merchant)"} for up to ${amt}`;
    }
    case "search_products":
      return `Compare on ${a.merchant || "(?)"}: ${(a.query || "").slice(0, 50)}`;
    case "find_flights":
      return `Find flights ${a.from || "?"} → ${a.to || "?"} on ${a.depart || "?"}${a.returnDate ? ` returning ${a.returnDate}` : ""}`;
    case "transcribe_video":
      return `Transcribe video: ${(a.path || "(?)").slice(0, 60)}${a.includeVisual === false ? " (audio only)" : ""}`;
    case "request_eod_digest":
      return `End-of-day digest`;
    case "compare_products": {
      const merchants = Array.isArray(a.merchants) ? a.merchants : [];
      return `Compare "${(a.item || "?").slice(0, 40)}" across ${merchants.length} merchants in parallel`;
    }
    case "code_agent_run": {
      const lines = String(a.code || "").split("\n").length;
      return `Run code-agent: ${(a.purpose || "(no purpose)").slice(0, 50)} · ${lines} lines`;
    }
    case "build_plugin":
      return `Scaffold plugin "${(a.name || "?").slice(0, 30)}" → tool ${(a.toolName || "?").slice(0, 40)}${a.behaviour ? " (agent-filled)" : " (stub)"}`;
    case "generate_pptx":
      return `Build PPTX deck "${(a.title || "?").slice(0, 50)}" — ${Array.isArray(a.slides) ? a.slides.length : 0} slides`;
    case "generate_docx":
      return `Build DOCX "${(a.title || "?").slice(0, 50)}" — ${Array.isArray(a.sections) ? a.sections.length : 0} sections`;
    case "generate_xlsx":
      return `Build XLSX "${(a.title || "?").slice(0, 50)}" — ${Array.isArray(a.sheets) ? a.sheets.length : 0} sheets`;
    case "request_browse":
      return `Drive browser to: ${(a.goal || "(no goal)").slice(0, 80)}`;
    case "open_url":
      return `Open ${(a.url || "(no url)").replace(/^https?:\/\//, "").slice(0, 60)} in browser`;
    case "send_imessage":
      return `iMessage ${a.to || "(?)"} — "${(a.body || "").slice(0, 50)}${(a.body || "").length > 50 ? "…" : ""}"`;
    case "add_reminder":
      return `Add reminder "${(a.title || "").slice(0, 50)}"${a.due ? ` for ${a.due}` : ""}`;
    case "set_timer":
      return `${a.minutes || "?"} min timer${a.label ? ` — ${String(a.label).slice(0, 40)}` : ""}`;
    case "play_music":
      return `Play music: ${(a.query || "(resume)").slice(0, 50)}${a.app === "spotify" ? " · Spotify" : ""}`;
    case "read_article":
      return `Read article: ${String(a.url || "").replace(/^https?:\/\//, "").slice(0, 60)}`;
    case "take_screenshot":
      return `Screenshot (${a.region || "screen"})`;
    case "set_focus":
      return `Focus mode: ${a.mode || "(?)"}${a.until ? ` until ${a.until}` : ""}`;
    case "lookup_password":
      return `1Password: ${a.label || "(?)"} → ${a.field || "password"}`;
    case "compose_note":
      return `Note "${(a.title || "").slice(0, 50)}" → ${a.app || "Apple Notes"}`;
    default: return `${name}(${JSON.stringify(a).slice(0, 80)})`;
  }
}

/** Build a short spoken summary of upcoming calendar events. Used by the
 *  fast-path so the operator hears "3 events today, next is X at Y" instead
 *  of an LLM paraphrase. `days=1` (today) gets a tighter phrasing than the
 *  multi-day case. */
function buildEventsSpokenSummary(events, days) {
  const list = Array.isArray(events) ? events : [];
  const horizon = (days ?? 1) <= 1 ? "today" : `in the next ${days} days`;
  if (list.length === 0) return `Nothing on the calendar ${horizon}.`;
  const next = list[0];
  const time = next?.start
    ? new Date(next.start).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit" })
    : null;
  const where = time ? `at ${time}` : "coming up";
  return list.length === 1
    ? `One event ${horizon}: ${next.title || "(no title)"} ${where}.`
    : `${list.length} events ${horizon}. Next: ${next.title || "(no title)"} ${where}.`;
}

/** Scan output/teasers/ for the most-recent run directory. Returns
 *  `{ run_id, kind, path, prompt, mtime }` for the panel, or null if nothing
 *  has been generated yet. The kind is determined by which file is newer:
 *  clip.mp4 (video) wins over hero.png (image) within the same run dir. */
async function _findLatestTeaserRun() {
  try {
    const path2 = await import("node:path");
    const fsp = await import("node:fs/promises");
    const teasersDir = path2.join(PROJECT_ROOT, "output", "teasers");
    const entries = await fsp.readdir(teasersDir, { withFileTypes: true }).catch(() => []);
    let best = null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path2.join(teasersDir, e.name);
      const hero = path2.join(dir, "hero.png");
      const clip = path2.join(dir, "clip.mp4");
      const [hs, cs] = await Promise.all([
        fsp.stat(hero).catch(() => null),
        fsp.stat(clip).catch(() => null),
      ]);
      const pick = (cs && (!hs || cs.mtimeMs > hs.mtimeMs)) ? { path: clip, kind: "video", mtime: cs.mtimeMs } : (hs ? { path: hero, kind: "image", mtime: hs.mtimeMs } : null);
      if (!pick) continue;
      if (!best || pick.mtime > best.mtime) best = { run_id: e.name, ...pick };
    }
    return best;
  } catch (e) {
    console.warn(`[asset-panel] _findLatestTeaserRun: ${e.message}`);
    return null;
  }
}

/** Recent teaser runs (last N) for the asset-panel history strip. Returns
 *  an array sorted newest-first; each entry has the same shape as
 *  _findLatestTeaserRun's return value, plus an optional `prompt` read from
 *  meta.json when present. */
async function _listTeaserRuns(limit = 3) {
  try {
    const path2 = await import("node:path");
    const fsp = await import("node:fs/promises");
    const teasersDir = path2.join(PROJECT_ROOT, "output", "teasers");
    const entries = await fsp.readdir(teasersDir, { withFileTypes: true }).catch(() => []);
    const rows = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path2.join(teasersDir, e.name);
      const hero = path2.join(dir, "hero.png");
      const clip = path2.join(dir, "clip.mp4");
      const meta = path2.join(dir, "meta.json");
      const [hs, cs, ms] = await Promise.all([
        fsp.stat(hero).catch(() => null),
        fsp.stat(clip).catch(() => null),
        fsp.readFile(meta, "utf8").catch(() => null),
      ]);
      const pick = (cs && (!hs || cs.mtimeMs > hs.mtimeMs)) ? { path: clip, kind: "video", mtime: cs.mtimeMs } : (hs ? { path: hero, kind: "image", mtime: hs.mtimeMs } : null);
      if (!pick) continue;
      let prompt = "";
      try { prompt = JSON.parse(ms || "{}")?.prompt || ""; } catch {}
      rows.push({ run_id: e.name, ...pick, prompt });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    return rows.slice(0, limit);
  } catch (e) {
    return [];
  }
}

/** Tracks currently-running influencer pipeline runs by runId so the POST
 *  endpoint can return immediately and the orchestrator continues in the
 *  background. The map is intentionally never cleaned up — runs are tiny
 *  ({ runId, startedAt }) and the process restarts daily anyway. */
const _influencerRuns = new Map();

/** Build a 1–2 sentence summary the LLM can speak while the news panel mounts.
 *  Picks the freshest top-story headline and, if there's also fresh HN content,
 *  appends a one-clause tech tease. Falls back to a generic line on a cold,
 *  empty cache (boot before any successful fetch). */
function buildNewsSpokenSummary(cache) {
  if (!cache) return "Opening the news panel now.";
  const top = cache.topStories?.[0];
  const hn  = cache.hn?.[0];
  if (!top && !hn) return "Opening the news panel now — feeds are still loading.";
  const parts = [];
  if (top) parts.push(`Top story: ${top.title}.`);
  if (hn)  parts.push(`In tech: ${hn.title}.`);
  return parts.join(" ");
}

async function executeTool(name, args) {
  const startedAt = Date.now();
  let result, error;
  /* Plan-stage broadcast: surface the impending tool call to the HUD so the operator
   * sees what's about to happen and can hit Esc / say "stop" if the LLM misheard.
   * Skips tools NOT in PLAN_PROPOSED_TOOLS so chatty turns (recall + get_contact +
   * list_projects) don't spam the panel. Audit-only side channel — never blocks. */
  if (PLAN_PROPOSED_TOOLS.has(name)) {
    try {
      broadcastToClients({
        type: "tool.proposed",
        data: {
          tool: name,
          summary: summariseToolCall(name, args),
          destructive: !!NEEDS_CONFIRMATION[name],
        },
      });
    } catch {}
  }
  try {
    result = await _executeToolInner(name, args);
    return result;
  } catch (e) {
    error = String(e?.message || e);
    throw e;
  } finally {
    /* Fire-and-forget audit write — never block tool return on disk i/o. */
    Audit.record({
      tool: name,
      args,
      result,
      error,
      runId: result?.runId,
      durationMs: Date.now() - startedAt,
    }).catch(() => {});
  }
}

async function _executeToolInner(name, args) {
  /* Confirmation gate — fires BEFORE the switch so it covers every destructive tool. */
  const summarize = NEEDS_CONFIRMATION[name];
  if (summarize && !args?.confirmed) {
    /* Why: a summarizer can return null to opt out per-call (e.g. add_usage_rights
     * only gates when exclusive: true). Falsy summary → no gate, run as normal. */
    const summary = summarize(args || {});
    if (summary) {
      /* Stash for auto-replay so a single "yes" from the operator fires the
       * tool even if Qwen forgets to re-emit the call with confirmed:true. */
      _setPendingConfirmation(name, args || {});
      return {
        ok: false,
        requires_confirmation: summary,
        hint: "Read the requires_confirmation message aloud verbatim, then wait for 'yes'/'go ahead'/'proceed'. Only after operator confirms, call this tool again with the SAME arguments plus confirmed: true.",
      };
    }
  }
  /* If the LLM correctly re-called with confirmed:true, the pending slot for
   * that tool is now stale — clear it so a stray "yes" later doesn't refire. */
  if (args?.confirmed && _pendingConfirmation?.name === name) _clearPendingConfirmation();
  switch (name) {
    case "web_search": {
      const results = await webSearch(String(args.query || "").trim(), 5);
      return { results };
    }
    case "get_weather": {
      const loc = String(args.location || "").trim();
      const days = Number(args.days) || 7;
      let w, place;
      if (!loc) {
        w = await getWeather(undefined, undefined, days);
        place = { name: CONFIG.operator.city, country: CONFIG.operator.country };
      } else {
        const geo = await geocodeLocation(loc);
        if (!geo) return { ok: false, error: `Couldn't find a place called "${loc}". Try a more specific name (e.g. 'Alicante, Spain').` };
        w = await getWeather(geo.lat, geo.lon, days);
        place = { name: geo.name, country: geo.country, lat: geo.lat, lon: geo.lon, timezone: geo.timezone };
      }
      /* Spoken summary used by the fast-path so the operator hears the current
       * temperature + condition instead of the LLM paraphrasing the raw object. */
      const summary = w?.now
        ? `It's ${w.now.temp} degrees and ${wmoLabel(w.now.code)} in ${place.name}.`
        : (w?.error ? `Weather lookup failed: ${w.error}` : `Weather data unavailable.`);
      return { ...w, location: place, summary };
    }
    case "send_imessage":  return await Personal.sendIMessage(args);
    case "add_reminder":   return await Personal.addReminder(args);
    case "set_timer":      return Personal.setTimer(args);
    case "list_timers":    return { ok: true, timers: Personal.listTimers() };
    case "cancel_timer":   return Personal.cancelTimer(args);
    case "play_music":     return await Personal.playMusic(args);
    case "pause_music":    return await Personal.pauseMusic(args);
    case "read_article":   return await Personal.readArticle(args);
    case "take_screenshot": {
      const r = await Personal.takeScreenshot(args);
      if (r?.ok) {
        r.summary = "Screenshot captured.";
        /* Broadcast so the screenshot side panel can pop with the captured
         * image. Falls back gracefully if no panel is listening. */
        broadcastToClients({ type: "screenshot.taken", data: { path: r.path, region: args?.region || "screen", takenAt: Date.now() } });
      }
      return r;
    }
    case "set_focus":      return await Personal.setFocus(args);
    case "lookup_password":return await Personal.lookupPassword(args);
    case "compose_note":   return await Personal.composeNote(args);
    case "show_news_panel": {
      const cached = News.getCached();
      const summary = buildNewsSpokenSummary(cached);
      broadcastToClients({ type: "news.show", data: cached });
      return { ok: true, summary };
    }
    case "hide_news_panel": {
      broadcastToClients({ type: "news.hide" });
      return { ok: true };
    }
    case "enter_sleep_mode": {
      /* Broadcast a sleep cue. The HUD listens, mutes the mic via stopListening(),
       * dims the speedometer, and waits for an explicit wake action (click or
       * wake-word). The bridge stays running so the HUD can come back instantly. */
      broadcastToClients({ type: "state.sleep" });
      return { ok: true, note: "Sleep cue sent. HUD will mute mic and dim. Tell the operator goodnight." };
    }
    case "open_url": {
      /* Hard-validate the URL — must be http(s), no file:// or javascript:.
       * macOS `open` would happily run any URL handler, including ones that
       * launch random applications, so we reject anything unusual. */
      const raw = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(raw)) {
        return { ok: false, error: "url must start with http:// or https://" };
      }
      let parsed;
      try { parsed = new URL(raw); } catch { return { ok: false, error: "Could not parse URL" }; }
      try {
        await execp(`open ${JSON.stringify(parsed.toString())}`);
        return { ok: true, opened: parsed.toString(), reason: args.reason || null };
      } catch (e) {
        return { ok: false, error: `open failed: ${e.message}` };
      }
    }
    case "search_products": {
      /* Wraps request_browse with a structured goal so the operator sees
       * candidates without a purchase ever firing. We compose a narrow
       * goal string the vision LLM can follow. */
      const visionProvider = LlmProviders.pickProvider("vision");
      if (visionProvider === "ollama") {
        return { ok: false, error: "search_products needs a vision-capable cloud provider (Anthropic or OpenAI). Configure in the Agent Console (Shift+Cmd+J)." };
      }
      const cap = Number.isFinite(Number(args.maxPriceGbp)) ? ` under £${Number(args.maxPriceGbp).toFixed(2)}` : "";
      const goal = `On ${args.merchant}, find 3-5 candidate products matching: "${args.query}"${cap}. Report each candidate with its price, model name, and key spec. Do NOT add anything to a basket. Output only the shortlist as a markdown list.`;
      return await Browse.requestBrowse({ goal, maxSteps: 14 });
    }
    case "find_flights": {
      const visionProvider = LlmProviders.pickProvider("vision");
      if (visionProvider === "ollama") {
        return { ok: false, error: "find_flights needs a vision-capable cloud provider. Configure in the Agent Console (Shift+Cmd+J)." };
      }
      const goal = `Open Skyscanner. Search flights from ${args.from} to ${args.to}, departing ${args.depart}${args.returnDate ? `, returning ${args.returnDate}` : ", one-way"}, ${args.adults || 1} adult(s). Read the top 3-5 results — for each, report: airline, total price (£), departure time, duration, stops. Do NOT click through to booking; the operator will do that themselves.`;
      const startUrl = "https://www.skyscanner.net/";
      return await Browse.requestBrowse({ goal, startUrl, maxSteps: 18 });
    }
    case "transcribe_video":   return await Transcribe.transcribeVideo(args);
    case "request_eod_digest": {
      const digest = await EodDigest.buildDigest(args || {});
      digest.spoken = EodDigest.digestToText(digest);
      return digest;
    }
    case "compare_products": return await CrewHelpers.compareProducts(args || {});
    case "search_knowledge": return await Memory.searchKnowledge(args || {});
    case "ingest_knowledge": return await Knowledge.ingestAll();
    case "code_agent_run":   return await CodeAgent.runCode(args || {});
    case "create_workspace": {
      try {
        const w = Workspaces.create(args || {});
        broadcastToClients({ type: "workspace.created", data: w });
        return { ok: true, workspace: w, hint: `Workspace "${w.label}" created. Say "switch to ${w.slug}" to activate it.` };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    case "switch_workspace": {
      try {
        const w = Workspaces.setActive(args?.slug ?? null);
        applyWorkspaceOverrides(w);
        broadcastToClients({ type: "workspace.switched", data: w });
        return { ok: true, workspace: w, hint: w ? `Now operating inside the "${w.label}" workspace.` : "Workspace cleared - operating without scope." };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    }
    case "list_workspaces": {
      const workspaces = Workspaces.list();
      const active = Workspaces.getActive();
      return { ok: true, workspaces, activeSlug: active?.slug || null };
    }
    case "delete_workspace": {
      const slug = String(args?.slug || "");
      const removed = Workspaces.remove(slug);
      if (!removed) return { ok: false, error: `workspace "${slug}" not found` };
      broadcastToClients({ type: "workspace.deleted", data: { slug } });
      return { ok: true, slug };
    }
    case "list_reminders":   return await Personal.listReminders(args || {});
    case "act_on_inbox_item": {
      /* Resolve the ordinal against the most recent briefing's cached
       * aggregate. If the cache has expired or the operator never ran a
       * briefing in this session, we ask them to run one first — better
       * than silently picking from a stale list. */
      const item = Inbox.getItemByOrdinal(args?.ordinal);
      if (!item) {
        return { ok: false, error: `Couldn't find item ${args?.ordinal} — say "brief me" first to refresh the inbox.` };
      }
      const action = String(args?.action || "").toLowerCase();
      try {
        switch (action) {
          case "open": {
            /* Each kind opens its native app. We use the URL handler
             * that openUrl already understands so we don't have to
             * touch AppleScript per kind. Apple Mail's `message:` URL
             * scheme + Calendar's `ical://` work natively. */
            if (item.kind === "email" && item.raw?.id) {
              await execp(`open "message://%3c${encodeURIComponent(item.raw.id)}%3e"`);
              return { ok: true, opened: "Mail.app", item: item.what };
            }
            if (item.kind === "event") {
              /* Calendar.app doesn't have a stable per-event URL scheme,
               * so we fall back to opening Calendar focused on the day. */
              await execp(`open -a "Calendar"`);
              return { ok: true, opened: "Calendar.app", item: item.what };
            }
            if (item.kind === "reminder") {
              await execp(`open -a "Reminders"`);
              return { ok: true, opened: "Reminders.app", item: item.what };
            }
            return { ok: false, error: `Don't know how to open a "${item.kind}" item.` };
          }
          case "reply": {
            if (item.kind !== "email") {
              return { ok: false, error: `Reply only works for email items (this is a ${item.kind}).` };
            }
            const to = item.raw?.from || item.who;
            const subject = item.raw?.subject || item.what;
            const body = String(args?.replyBody || "").trim();
            return await draftEmail({
              to,
              subject: subject.toLowerCase().startsWith("re:") ? subject : `Re: ${subject}`,
              body,
              confirmed: true,   /* operator already said "reply to the first one" */
            });
          }
          case "snooze": {
            if (item.kind !== "reminder") {
              return { ok: false, error: `Snooze only works for reminder items.` };
            }
            const minutes = Math.max(1, Math.min(60 * 24 * 30, Number(args?.snoozeMinutes) || 60));
            const newDue = new Date(Date.now() + minutes * 60_000).toISOString();
            const r = await Personal.updateReminder({
              title: item.what,
              due: newDue,
              listName: item.raw?.listName || null,
            });
            if (!r.ok) return r;
            return { ok: true, snoozed: item.what, newDue, list: r.list };
          }
          case "accept":
          case "decline": {
            if (item.kind !== "event") {
              return { ok: false, error: `${action} only works for calendar events.` };
            }
            return { ok: false, error: `Calendar RSVP needs an Events.app updater — wired in next patch. For now, open "${item.what}" in Calendar.app and RSVP there.` };
          }
          case "complete": {
            if (item.kind !== "reminder") {
              return { ok: false, error: `Complete only works for reminders.` };
            }
            const r = await Personal.completeReminder({
              title: item.what,
              listName: item.raw?.listName || null,
            });
            if (!r.ok) return r;
            return { ok: true, completed: item.what, list: r.list };
          }
          default:
            return { ok: false, error: `Unknown action "${action}".` };
        }
      } finally {
        /* Any successful action invalidates the cache so the next
         * briefing reflects the new state. */
        Inbox.invalidate();
      }
    }
    case "smart_inbox_briefing": {
      /* Pull the latest aggregate, then ask the LLM to triage per the
       * active workspace's handbook. The handbook fragment is the primary
       * priority signal — operator's prose ("client emails outrank
       * internal newsletters", "calendar items in the next hour are
       * sacred") gets injected verbatim into the rank prompt. */
      const topN = Math.max(1, Math.min(8, Number(args?.topN) || 3));
      const force = !!args?.force;
      const inbox = await Inbox.aggregate({ days: 1, mailMax: 15, force });
      if (!inbox.items.length) {
        return { ok: true, briefing: "Nothing in the inbox right now — clean plate.", items: [], topN };
      }
      /* Compose a compact ranking prompt. Items are pre-sorted by the
       * default heuristic (imminent events first); the LLM re-ranks
       * against the workspace handbook + makes the rationale explicit. */
      const w = Workspaces.getActive();
      const handbookFragment = w?.handbook ? `\n\nWorkspace priority directives (operator's scope-specific rules — apply strictly when ranking):\n${w.handbook}\n` : "";
      const itemList = inbox.items.slice(0, 25).map((it, i) => {
        const minutes = it.urgency_hints?.minutesAway != null
          ? ` (${it.urgency_hints.minutesAway > 0 ? "in " : ""}${Math.abs(it.urgency_hints.minutesAway)} min${it.urgency_hints.minutesAway < 0 ? " ago" : ""})`
          : "";
        return `${i + 1}. [${it.kind}] ${it.who}: ${it.what}${minutes}${it.preview ? ` — ${it.preview.slice(0, 80)}` : ""}`;
      }).join("\n");
      const rankPrompt = `You are a triage assistant. The operator wants a briefing of what to handle first.

Inbox items (${inbox.items.length} total, calendar + mail aggregated):
${itemList}
${handbookFragment}
Pick the top ${topN} priorities. For each, output exactly one line in this format:
<rank>. <one-line summary>  —  <why this matters now, max 18 words>

After the list, output a one-sentence overall take describing the shape of the day (e.g. tone like "tight calendar morning — clear the most time-pressured item first" — but reflect the actual items above, not this example phrasing) on its own line.

Output ONLY the ranked list + the one-sentence take. No headers, no bullet markers other than the ranks, no prose preamble.`;
      let briefing;
      try {
        briefing = await askLLM(rankPrompt, [], { sessionId: null, workspace: w?.slug || null });
      } catch (e) {
        return { ok: false, error: `LLM ranking failed: ${e.message}`, items: inbox.items.slice(0, topN) };
      }
      return {
        ok: true,
        briefing,
        items: inbox.items.slice(0, topN),
        sources: inbox.sources,
        generatedAt: inbox.generatedAt,
        fromCache: inbox.fromCache,
      };
    }
    case "open_app":          return await MacControl.openApp(args?.name);
    case "set_system_volume": return await MacControl.setVolume(args?.level);
    case "lock_screen":       return await MacControl.lockScreen();
    case "type_text":         return await MacControl.typeText(args?.text);
    case "morning_brief": {
      /* Stitch four prewarmed sources into a flowing narrative the LLM can speak.
       * Each fetch is independent so we run them in parallel; a failure on one
       * source degrades gracefully (e.g. weather down -> brief still mentions
       * calendar + inbox + news, just no weather line). */
      const force = !!args?.force;
      const newsCount = Math.max(1, Math.min(5, Number(args?.newsCount) || 3));
      const w = Workspaces.getActive();
      const [weather, inbox, newsCache] = await Promise.all([
        getWeather(undefined, undefined, 1, { force }).catch(() => null),
        Inbox.aggregate({ days: 1, mailMax: 15, force }).catch(() => ({ items: [] })),
        Promise.resolve(News.getCached()),
      ]);
      /* Weather line: short and direct, lets the LLM pick whether to mention
       * forecast or just current. WMO label keeps phrasing natural. */
      const weatherLine = weather?.now
        ? `${weather.now.temp} degrees and ${wmoLabel(weather.now.code)} in ${CONFIG.operator.city}` +
          (weather.forecast?.[0] ? `, today's high ${weather.forecast[0].hi}` : "")
        : "weather unavailable";
      /* Calendar today: filter inbox items to just calendar entries with a
       * minutes-away hint. Keeps the brief grounded in concrete events. */
      const calendarToday = (inbox.items || [])
        .filter((it) => it.kind === "calendar")
        .slice(0, 5)
        .map((it) => {
          const m = it.urgency_hints?.minutesAway;
          const when = m == null ? "" : m < 60 && m > 0 ? `in ${m} min` : m < 0 ? `${Math.abs(m)} min ago` : `${Math.round(m / 60)}h away`;
          return `- ${it.who || it.what}${when ? ` (${when})` : ""}`;
        }).join("\n") || "(nothing scheduled)";
      /* Inbox priorities: top 3 non-calendar items. The smart_inbox_briefing
       * tool does its own LLM ranking; here we skip that step and just hand
       * the LLM the raw signals so the narrative composes cleanly. */
      const inboxLines = (inbox.items || [])
        .filter((it) => it.kind !== "calendar")
        .slice(0, 3)
        .map((it) => `- ${it.who}: ${it.what}${it.preview ? ` — ${it.preview.slice(0, 60)}` : ""}`)
        .join("\n") || "(inbox is clear)";
      /* News: pick top N headlines, prefer mainstream feeds (sky/bbc/guardian)
       * over HN so the brief stays general-audience. Strip source tags from
       * the LLM input — the narrative voice shouldn't sound like a feed reader. */
      const headlines = (newsCache?.topStories || [])
        .slice(0, newsCount)
        .map((h) => `- ${h.title}`)
        .join("\n") || "(news cache empty)";
      const handbookFragment = w?.handbook
        ? `\nWorkspace context (operator's prose — set the tone accordingly):\n${w.handbook}\n`
        : "";
      const now = new Date();
      const greeting = now.getHours() < 12 ? "Morning" : now.getHours() < 17 ? "Afternoon" : "Evening";
      const prompt = `You are composing a spoken morning brief for the operator. Output 60-90 seconds of natural narrative speech — no headers, no bullet points, no markdown, no list-of-lists.

Lead with: "${greeting}, sir." Then weave together the four data sources below into a single flowing paragraph. Mention weather first (one sentence), then the shape of the day from the calendar (one to two sentences), then any inbox priorities worth flagging (one to two sentences), then top news headlines as a brief mention (one sentence summarising the day's themes — do not list every headline). End with a single transition line like "anything else you want to dig into first?" or similar.

Tone: warm but efficient. Like a trusted aide handing over the day, not a robot reading data. ${handbookFragment}

WEATHER:
${weatherLine}

CALENDAR TODAY:
${calendarToday}

INBOX PRIORITIES:
${inboxLines}

TOP HEADLINES:
${headlines}

Output ONLY the narrative paragraph. No preface, no sign-off beyond the transition question.`;
      let narrative;
      try {
        narrative = await askLLM(prompt, [], { sessionId: null, workspace: w?.slug || null });
      } catch (e) {
        return { ok: false, error: `LLM compose failed: ${e.message}` };
      }
      return {
        ok: true,
        narrative,
        sources: {
          weather: !!weather?.now,
          calendarEvents: calendarToday !== "(nothing scheduled)",
          inboxItems: inboxLines !== "(inbox is clear)",
          headlines: headlines !== "(news cache empty)",
        },
        generatedAt: new Date().toISOString(),
      };
    }
    case "workspace_insights": {
      const slug = args?.slug || Workspaces.getActive()?.slug;
      if (!slug) return { ok: false, error: "no active workspace and no slug provided" };
      const insights = Workspaces.insights(slug);
      if (!insights) return { ok: false, error: `workspace "${slug}" not found` };
      return { ok: true, ...insights };
    }
    case "refresh_workspace_knowledge": {
      const w = Workspaces.getActive();
      if (!w) return { ok: false, error: "no active workspace — switch to one first" };
      if (!w.workingRoot) return { ok: false, error: `workspace "${w.slug}" has no working_root set` };
      try {
        broadcastToClients({ type: "knowledge.workspace.scanning", data: { slug: w.slug, root: w.workingRoot } });
        const result = await Knowledge.ingestAll(w.workingRoot);
        broadcastToClients({ type: "knowledge.workspace.scanned", data: { slug: w.slug, ...result } });
        return { ok: true, workspace: w.slug, ...result };
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }
    case "export_workspace": {
      try {
        const result = await WorkspaceExport.exportWorkspace({
          slug: args?.slug,
          includeTurns: !!args?.includeTurns,
        });
        broadcastToClients({ type: "workspace.exported", data: { slug: args?.slug, path: result.path, sizeBytes: result.sizeBytes } });
        return result;
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }
    case "import_workspace": {
      try {
        const result = await WorkspaceExport.importWorkspace({
          bundlePath: args?.bundlePath,
          overwrite: !!args?.overwrite,
          includeTurns: args?.includeTurns !== false,
        });
        broadcastToClients({ type: "workspace.imported", data: result });
        return result;
      } catch (e) { return { ok: false, error: String(e.message || e) }; }
    }
    case "build_plugin": {
      /* Plugin generator — scaffolds bridge/plugins/<slug>/{manifest.json,
       * handler.mjs} from voice-supplied spec. The plugin-loader's fs.watch
       * picks up the new directory within ~500ms and hot-loads the tool;
       * by the time this case returns, the operator can call the new tool
       * on the next turn.
       *
       * Two modes are baked into PluginGenerator.buildPlugin:
       *   - stub: writes a placeholder handler the operator fills in by hand.
       *   - agent-seeded: writes a placeholder, returns a code-agent prompt
       *     the LLM should pass to code_agent_run on its next call to fill
       *     in real handler logic.
       *
       * We don't auto-chain to code_agent_run here because that would
       * bypass the second confirmation gate. The LLM gets the agent prompt
       * back in the response and can decide to make the follow-up call. */
      const spec = {
        name: args?.name,
        description: args?.description,
        toolName: args?.toolName,
        voiceIntent: args?.voiceIntent,
        behaviour: args?.behaviour || null,
        force: !!args?.force,
      };
      const result = await PluginGenerator.buildPlugin(spec);
      if (!result.ok) return result;
      /* Surface the agent prompt so the LLM can use it as the `code` arg
       * for code_agent_run when behaviour was provided. We don't put the
       * full prompt in the spoken summary — only the hint for the operator
       * — but the LLM sees it via the tool reply. */
      if (result.needsAgentFill) {
        result.agentPrompt = PluginGenerator.buildAgentPrompt(spec);
        result.followupHint = "Now call code_agent_run with code=<the agentPrompt> and allowedTools=[\"write_file\"], purpose=\"fill in the handler for plugin " + spec.name + "\".";
      }
      /* Push a WS event so the HUD can show a "new plugin loaded" toast
       * once the watcher actually loads it. The watcher itself broadcasts
       * plugins.reloaded — we add a separate built event tagged for the
       * generator path so UIs can distinguish "scaffolded" from "edited
       * by operator + reloaded". */
      broadcastToClients({ type: "plugin.built", data: { slug: result.slug, toolName: result.toolName, mode: result.mode } });
      return result;
    }
    case "generate_pptx": {
      const r = await Office.generatePptx(args || {});
      if (r.ok) broadcastToClients({ type: "office.complete", data: { kind: "pptx", title: args.title, path: r.path, sizeKB: r.sizeKB, slides: r.slideCount } });
      return r;
    }
    case "generate_docx": {
      const r = await Office.generateDocx(args || {});
      if (r.ok) broadcastToClients({ type: "office.complete", data: { kind: "docx", title: args.title, path: r.path, sizeKB: r.sizeKB, sections: r.sectionCount } });
      return r;
    }
    case "generate_xlsx": {
      const r = await Office.generateXlsx(args || {});
      if (r.ok) broadcastToClients({ type: "office.complete", data: { kind: "xlsx", title: args.title, path: r.path, sizeKB: r.sizeKB, sheets: r.sheetCount } });
      return r;
    }
    case "cancel_active_jobs": {
      Vision.raiseAbort();
      Browse.raiseAbort();
      return { ok: true, note: "Cancellation raised on Vision + Browse modules. Active loops will bail at the next safe checkpoint." };
    }
    case "request_browse": {
      /* Sanity-check: refuse if no vision-capable provider has an API key —
       * driving a browser from text only would burn tokens for poor results. */
      const visionProvider = LlmProviders.pickProvider("vision");
      if (visionProvider === "ollama") {
        return {
          ok: false,
          error: "request_browse needs a vision-capable cloud provider. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env and choose LLM_PROVIDER_VISION accordingly.",
        };
      }
      const r = await Browse.requestBrowse({
        goal: args.goal,
        startUrl: args.startUrl,
        maxSteps: args.maxSteps,
      });
      broadcastToClients({
        type: "browse.complete",
        data: {
          ok: !!r.ok,
          sessionId: r.sessionId || null,
          stepCount: r.stepCount ?? r.trace?.length ?? 0,
          goal: args.goal,
          finalAnswer: r.finalAnswer ?? null,
          error: r.error ?? null,
        },
      });
      return r;
    }
    case "request_purchase": {
      const r = await Purchases.requestPurchase({
        merchant: args.merchant,
        item: args.item,
        maxPriceGbp: args.maxPriceGbp,
        justification: args.justification,
        confirmed: !!args.confirmed,
      });
      /* Typed-tier branch: bridge parked the request, broadcast a modal cue so
       * the HUD pops the typed-confirm dialog. The LLM's response (returned
       * below) instructs it to verbally cue the operator AND stop talking — the
       * modal will settle the transaction without another LLM round-trip. */
      if (r?.code === "needs_typed_confirm" && r.pendingId) {
        broadcastToClients({
          type: "purchase.typed_confirm.required",
          data: {
            pendingId: r.pendingId,
            merchant: r.merchant,
            item: r.item,
            amountGbp: r.amountGbp,
          },
        });
      }
      /* HUD audit broadcast — fires for both settled and rejected calls so the
       * operator sees an immediate badge "Jarvis just tried to spend £X at Y".
       * Settled simulator calls show as "simulated" so a glance distinguishes
       * intent from real spend. */
      broadcastToClients({
        type: "purchase.recorded",
        data: {
          ok: !!r.ok,
          simulated: r.simulated ?? null,
          merchant: r.merchant ?? args.merchant ?? null,
          item: args.item ?? null,
          chargedGbp: r.chargedGbp ?? Number(args.maxPriceGbp) ?? null,
          tier: r.tier ?? null,
          code: r.code ?? null,
        },
      });
      return r;
    }
    case "create_pdf": {
      const result = await createPdf({ template: args.template, data: args.data });
      // Broadcast so HUD pops the PDF window (mirrors the video.edit.complete pattern)
      broadcastToClients({
        type: "pdf.complete",
        data: {
          url: result.url,
          template: result.template,
          title: (args.data && (args.data.title || args.data.headline)) || result.template,
          sizeKB: Math.round(result.size / 1024),
        },
      });
      return result;
    }
    case "get_upcoming_events": {
      const r = await getUpcomingEvents({ days: args.days, calendarName: args.calendarName });
      /* Spoken summary used by the fast-path. Builds "3 events today, next is X at Y"
       * from the event list so the operator gets the headline before the panel update. */
      if (r?.ok) r.summary = buildEventsSpokenSummary(r.events, args.days);
      return r;
    }
    case "add_calendar_event": {
      /* Broadcast a diary.refresh hint so the HUD's TODAY widget picks up the new event
       * immediately rather than waiting for the next poll tick. The HUD may briefly show
       * the previous state until the post-broadcast pollDiary fetch completes (~250ms),
       * which is still much better than waiting up to a minute. */
      const r = await addCalendarEvent(args);
      if (r?.ok) {
        invalidateCalendar(); /* event added — bust the upcoming-events cache so the next read is fresh */
        broadcastToClients({ type: "diary.refresh" });
      }
      return r;
    }
    case "get_mail_summary":                   return await getMailSummary({ unreadOnly: args.unreadOnly, max: args.max });
    case "draft_email":                        return await draftEmail(args);
    case "run_shell":                          return await runShell(args || {});
    case "write_file":                         return await writeFileSandboxed(args || {});
    case "add_contact":                        return await Memory.addContact(args || {});
    case "get_contact":                        return await Memory.getContact(args || {});
    case "list_contacts":                      return Memory.listContacts(args || {});
    case "remember":                           return await Memory.remember(args || {});
    case "recall":                             return await Memory.recall(args || {});
    case "add_project":                        return await Memory.addProject(args || {});
    case "list_projects":                      return Memory.listProjects(args || {});
    case "save_conversation":                  return await Memory.saveConversation(args || {});
    case "describe_image":                     return await Vision.describeImage(args || {});
    case "export_all_aspects":                 return await Vision.exportAllAspects(args || {});
    case "generate_social_captions":           return await Agency.generateSocialCaptions(args || {});
    /* Sprint 13 — teaser-ad pipeline. Three sequential tools: storyboard
     * (LLM-only, no API), then image gen (gated, fal nano-banana/pro), then
     * video gen (gated, fal Hailuo). Defined inline below the imports + helpers. */
    case "make_teaser_storyboard":             return await makeTeaserStoryboard(args || {});
    case "generate_teaser_image":              return await generateTeaserImage(args || {});
    case "animate_teaser_image": {
      const r = await animateTeaserImage(args || {});
      /* Broadcast so the asset panel can pop with the new clip. The handler
       * already returns clip_path / run_id; we just relay them. */
      if (r?.ok) {
        broadcastToClients({
          type: "teaser.video_ready",
          data: {
            run_id: r.run_id || args?.run_id || null,
            clipPath: r.clip_path || r.clipPath || null,
            motion_prompt: args?.motion_prompt || null,
            duration_s: args?.duration_s || null,
            elapsed_ms: r.elapsed_ms || null,
          },
        });
      }
      return r;
    }
    /* Influencer pipeline — see Influencers module + recreateVideoWithInfluencer
     * helper below. create + recreate are gated (NEEDS_CONFIRMATION); lock is
     * a local file copy with no spend so it runs immediately. */
    case "create_influencer":                  return await createInfluencerTool(args || {});
    case "lock_influencer":                    return await lockInfluencerTool(args || {});
    case "recreate_video_with_influencer":     return await recreateVideoWithInfluencer(args || {});
    case "show_asset_panel": {
      /* Find the most recent teaser run on disk and broadcast its path so the
       * panel can render. Falls back to an empty payload if no runs exist. */
      const latest = await _findLatestTeaserRun();
      broadcastToClients({ type: "asset.panel.show", data: latest || {} });
      return { ok: true, summary: latest ? `Opening the asset panel.` : `No image generated yet.` };
    }
    case "show_weather_panel": {
      const w = await getWeather();
      const data = { ...w, location: { name: CONFIG.operator.city, country: CONFIG.operator.country } };
      broadcastToClients({ type: "weather.show", data });
      return { ok: true, summary: w?.now ? `It's ${w.now.temp} degrees and ${wmoLabel(w.now.code)} in ${CONFIG.operator.city}.` : "Weather unavailable." };
    }
    case "show_influencer_wizard": {
      broadcastToClients({ type: "influencer.wizard.show" });
      return { ok: true, summary: "Opening the influencer wizard. Tell me what kind." };
    }
    case "start_influencer_pipeline": {
      const answers = {
        sex: args.sex,
        vibe: args.vibe,
        contentType: args.content_type,
        sourceUrl: args.source_url || null,
      };
      /* Build the deps map from existing bridge handlers. Each fetcher returns
       * the same shape its corresponding tool case returns. */
      const deps = {
        createInfluencer:           (a) => createInfluencerTool(a),
        lockInfluencer:             (a) => lockInfluencerTool(a),
        generateTeaserImage:        (a) => generateTeaserImage(a),
        animateTeaserImage:         (a) => executeTool("animate_teaser_image", a),
        recreateVideoWithInfluencer:(a) => recreateVideoWithInfluencer(a),
        generateSocialCaptions:     (a) => Agency.generateSocialCaptions(a),
      };
      /* Fire-and-forget: return runId now, broadcast updates as they happen. */
      const runPromise = InfluencerPipeline.runPipeline(answers, deps, broadcastToClients);
      runPromise.then((r) => {
        broadcastToClients({ type: "influencer.pipeline.complete", data: r });
        _influencerRuns.delete(r.runId);
      }).catch((e) => {
        console.warn(`[influencer-pipeline] crashed: ${e.message}`);
      });
      const tempId = `inf_pending_${Date.now()}`;
      _influencerRuns.set(tempId, { startedAt: Date.now() });
      return { ok: true, pending_run_id: tempId };
    }
    case "triage_failed_tool":                 return await triageFailedTool(args || {});
    case "check_brand_tone":                   return await Agency.checkBrandTone(args || {});
    case "hashtag_research":                   return await Agency.hashtagResearch(args || {});
    case "vehicle_spec_lookup":                return await Agency.vehicleSpecLookup(args || {});
    case "ask_internal":                       return await Agency.askInternal(args || {});
    case "team_standup":                       return await Agency.teamStandup(args || {});
    case "generate_youtube_thumbnail": {
      /* Why: thumbnail generation is fast (~5-10s) but picking the engine shot needs VL.
       * Broadcast stage events so the screen-recorded demo shows progress ticking.
       * Now also drives the Tasks lifecycle with a stage manifest so the HUD's
       * task strip shows lane-grouped pipeline pills, same UX as the teaser. */
      const thumbSubject = args?.subject || args?.folder || "thumbnail";
      const thumbRunId = Tasks.startTask({
        kind: "yt.thumbnail",
        label: `Thumbnail · ${thumbSubject}${args?.headline ? ` · "${args.headline}"` : ""}`,
        etaSec: 20,
        stages: Youtube.YT_THUMBNAIL_STAGES,
      });
      /* Wrapped broadcast: keeps the legacy yt.thumbnail.progress event
       * firing (handleThumbnailProgress in voice.js still listens) AND
       * routes the same stage name through Tasks.progressTask so the
       * lane viz updates. Loose substring matching in tasks.js maps
       * 'captioning-folder' → 'reading shoot' etc. */
      const broadcast = (stage, info = {}) => {
        broadcastToClients({ type: "yt.thumbnail.progress", stage, ...info });
        Tasks.progressTask(thumbRunId, { stage });
      };
      try {
        const r = await Youtube.generateYoutubeThumbnail(args || {}, broadcast);
        if (r.ok) {
          Tasks.completeTask(thumbRunId);
          broadcastToClients({
            type: "yt.thumbnail.complete",
            data: { url: r.url, headline: r.headline, subhead: r.subhead, sizeKB: r.sizeKB },
          });
        } else {
          Tasks.errorTask(thumbRunId, r.error || "thumbnail build failed");
        }
        return r;
      } catch (e) {
        Tasks.errorTask(thumbRunId, e);
        throw e;
      }
    }
    case "generate_youtube_short": {
      /* Reuses the existing teaser pipeline — emits video.edit.progress events that the
       * HUD already knows how to render, so no new frontend wiring needed for screen demos. */
      if (currentVideoRun && !currentVideoRun.done) {
        return { ok: false, status: "busy", note: "Another video edit is already running." };
      }
      const ytSubject = args?.subject || args?.folder || "latest shoot";
      const runId = Tasks.startTask({
        kind: "yt.short",
        label: `YouTube Short · ${ytSubject}${args?.headline ? ` · "${args.headline}"` : ""}`,
        etaSec: 150,
      });
      currentVideoRun = { startedAt: Date.now(), done: false, subject: args?.subject || args?.folder, runId };
      Youtube.generateYoutubeShort(args || {}).then((result) => {
        currentVideoRun.done = true;
        if (result?.ok) {
          Tasks.completeTask(runId, { finalUrl: result.finalUrl });
          broadcastToClients({
            type: "video.edit.complete",
            data: { runId: result.runId, subject: result.subject, durationSec: result.durationSec, finalUrl: result.finalUrl },
          });
        } else {
          Tasks.errorTask(runId, result?.error || "short build failed");
          broadcastToClients({ type: "video.edit.error", runId, data: { error: result?.error || "short build failed" } });
        }
      }).catch((err) => {
        currentVideoRun.done = true;
        Tasks.errorTask(runId, err);
        broadcastToClients({ type: "video.edit.error", runId: currentVideoRun?.runId, data: { error: String(err.message || err) } });
      });
      return { ok: true, status: "started", runId, note: "Short rendering — auto-plays when ready (2-3 min)." };
    }
    case "generate_youtube_promo": {
      /* Combined thumbnail + short — preferred when the operator asks for "a thumbnail
       * and a short" in one breath, which the 14b model wasn't reliably chaining as
       * two separate tool calls. */
      if (currentVideoRun && !currentVideoRun.done) {
        return { ok: false, status: "busy", note: "Another video edit is already running." };
      }
      const promoSubject = args?.subject || args?.folder || "latest shoot";
      /* Promo = thumbnail (4 stages) + short (5 stages from TEASER_STAGES).
       * Concatenate manifests so the lane viz shows the whole 9-stage
       * pipeline. Active stage advances through both halves naturally as
       * each broadcast fires. */
      const promoRunId = Tasks.startTask({
        kind: "yt.promo",
        label: `YT Promo · ${promoSubject}${args?.headline ? ` · "${args.headline}"` : ""}`,
        etaSec: 180,
        stages: [...Youtube.YT_THUMBNAIL_STAGES, ...TEASER_STAGES],
      });
      const broadcast = (stage, info = {}) => {
        broadcastToClients({ type: "yt.thumbnail.progress", stage, ...info });
        Tasks.progressTask(promoRunId, { stage });
      };
      currentVideoRun = { startedAt: Date.now(), done: false, subject: args?.subject || args?.folder, runId: promoRunId };
      const r = await Youtube.generateYoutubePromo(args || {}, broadcast);
      if (r.ok && r.thumbnail?.url) {
        broadcastToClients({
          type: "yt.thumbnail.complete",
          data: { url: r.thumbnail.url, headline: r.thumbnail.headline, subhead: r.thumbnail.subhead, sizeKB: 0 },
        });
      }
      /* Background poll for the short — when its final.mp4 lands, broadcast the same
       * video.edit.complete event the existing teaser flow uses. */
      const pollShort = setInterval(async () => {
        try {
          const fs = await import("node:fs/promises");
          const outRoot = Paths.getOutputDir();
          const dirs = (await fs.readdir(outRoot, { withFileTypes: true }))
            .filter(d => d.isDirectory() && d.name.startsWith("prod_"))
            .map(d => d.name).sort().reverse();
          for (const d of dirs.slice(0, 2)) {
            const final = path.join(outRoot, d, "final.mp4");
            try {
              const st = await fs.stat(final);
              if (st.mtimeMs > currentVideoRun.startedAt) {
                clearInterval(pollShort);
                currentVideoRun.done = true;
                Tasks.completeTask(promoRunId, { finalUrl: `/output/${d}/final.mp4` });
                broadcastToClients({
                  type: "video.edit.complete",
                  data: { runId: d, subject: args?.subject || "(latest)", durationSec: 30, finalUrl: `/output/${d}/final.mp4` },
                });
                break;
              }
            } catch {}
          }
        } catch {}
      }, 5000);
      /* Safety: stop polling after 6 minutes regardless. */
      setTimeout(() => {
        clearInterval(pollShort);
        if (!currentVideoRun?.done) {
          currentVideoRun.done = true;
          Tasks.errorTask(promoRunId, "render timed out after 6 minutes");
        }
      }, 360_000);
      return { ...r, runId: promoRunId };
    }
    case "get_capabilities": {
      // Enumerate runtime state the LLM might need before making decisions
      const fs = await import("node:fs/promises");
      let shootFolders = [];
      try {
        const ents = await fs.readdir(Paths.getShootsDir(), { withFileTypes: true });
        shootFolders = ents.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
      } catch {}
      const musicMod = await import("./music.mjs");
      const tracks = await musicMod.listTracks();
      /* Categorised tool summary — five buckets per the white-label sprint
       * plan. Read from config/actions.meta.json so non-developers can tune
       * categories without touching code. The summary is a short, human-
       * readable list per category that the LLM can read aloud when the
       * operator asks "what can you do?" — matches the help modal layout. */
      let categorySummary = null;
      try {
        const metaPath = new URL("../config/actions.meta.json", import.meta.url);
        const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
        const cats = meta._categories || {};
        const grouped = {};
        for (const t of TOOLS) {
          const fn = t.function || {};
          const m = meta[fn.name] || {};
          const cat = m.category || "system";
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push(m.label || fn.name);
        }
        categorySummary = Object.entries(grouped).map(([cat, items]) => ({
          key: cat,
          label: cats[cat]?.label || cat,
          blurb: cats[cat]?.blurb || "",
          count: items.length,
          items,
        }));
      } catch {}
      return {
        ok: true,
        hardware: CONFIG.hardware,
        operator: { city: CONFIG.operator.city, country: CONFIG.operator.country, timezone: CONFIG.operator.timezone },
        agency: CONFIG.agency,
        shootFolders,
        pdfTemplates: listPdfTemplates(),
        voices: ["bm_daniel", "bm_george", "bm_lewis", "bm_fable", "bf_emma", "bf_alice", "bf_isabella", "bf_lily"],
        videoEffects: ["normal", "speed-up", "slow-mo", "punch-zoom", "flash-in", "freeze-hit"],
        musicTracks: tracks,
        musicMoods: ["epic", "driving", "cinematic", "action", "chase"],
        shellAllowlist: shellAllowlist(),
        shellNote: "When no curated tool fits, you can call run_shell to compose ad-hoc commands using the allowlisted binaries. Sandboxed to project dir, dangerous patterns blocked.",
        memory: Memory.memoryStats(),
        memoryNote: "Persistent memory across sessions. Use get_contact before draft_email, recall for past discussions, remember for stable preferences, save_conversation at session end.",
        vision: Vision.visionStats(),
        visionNote: "Local Qwen 2.5-VL can caption images and video keyframes. Use describe_image for single files.",
        categories: categorySummary,
        categoriesNote: "When the operator asks 'what can you do?', read the category labels and counts (e.g. 'I have 11 communication tools, 15 productivity tools…') rather than listing every tool name. Drill into one category if they ask for more detail.",
      };
    }
    case "undo_last": {
      /* Reverse the most recent undoable action. Stack is small (8 entries) and
       * lives in-process; on bridge restart the stack is empty. */
      return await Undo.pop();
    }
    case "read_active_window":                 return await Window.readActiveWindow();
    case "dream_cycle":                        return await DreamCycle.runCycle(args || {});
    case "brand_pack_export":                  return await exportBrandPack(args || {});
    default:
      /* Plugin fall-through. If the tool was registered by a plugin via
       * bridge/plugins/<name>/, route the call to its handler. The plugin
       * has already passed the confirmation gate + audit-log wrapper above. */
      if (PluginLoader.ownsTool(name)) {
        return await PluginLoader.dispatch(name, args || {});
      }
      return { error: `unknown tool: ${name}` };
  }
}

/* Plugin runtime — wired here, AFTER TOOLS / NEEDS_CONFIRMATION / executeTool
 * are all in scope. Init registers refs to the host arrays the loader will
 * mutate; loadAll scans bridge/plugins/ at boot; startWatcher hot-reloads
 * on file change. Order matters: plugins must register their tools BEFORE
 * the tool-router builds its embedding index, so plugin tools participate
 * in the top-K relevance filter just like built-in ones. */
PluginLoader.init({
  tools: TOOLS,
  confirmations: NEEDS_CONFIRMATION,
  ctx: {
    log: (...args) => console.log("[plugin]", ...args),
    broadcastToClients,
    memory: Memory,
    executeTool: (name, args) => executeTool(name, args),
  },
  broadcaster: broadcastToClients,
});
PluginLoader.loadAll().then(() => PluginLoader.startWatcher())
  .catch((e) => console.warn(`[plugin] init failed: ${e.message}`));

/* ─────────────────────────── AGENT LOOP CONFIG ───────────────────────────
 * Two lanes for the LLM tool-call loop:
 *   STANDARD — 3 hops, voice-friendly latency for chat-y queries.
 *   AGENT    — 12 hops + per-tool retry budget + inter-hop status narration.
 *              Used for multi-step builds (influencer creation → image gen →
 *              animation; ad pipelines; recreation flows). Slower but lets
 *              Qwen actually plan-and-iterate the way a human assistant would
 *              instead of giving up after one failure.
 *
 * Lane is picked at hop 0 from the query content, then upgraded if the LLM
 * calls a known multi-step tool (so a chat-y query that surprisingly leads
 * to a teaser pipeline still gets the agent budget).
 */
const HOP_CAP_STANDARD = 3;
const HOP_CAP_AGENT = 12;
/* Tools that imply multi-step / "you'll need follow-up calls" work. Hitting
 * any of these flips the loop into agent lane for the rest of the turn. */
const AGENTIC_TOOL_NAMES = new Set([
  "make_teaser_storyboard",
  "generate_teaser_image",
  "animate_teaser_image",
  "create_influencer",
  "lock_influencer",
  "recreate_video_with_influencer",
  "triage_failed_tool",
  "request_browse",
  "transcribe_video",
  "video.edit",
  "build_brand_pack",
]);
/* Per-tool call budget within a single agent task. Stops a confused model
 * from burning 12 hops calling generate_teaser_image six times after every
 * fal error. After 2 calls, the bridge returns a guard error that tells the
 * LLM to either change tool or hand off to the operator. */
const TOOL_CALL_BUDGET_PER_TASK = 2;

/** Decide if a query is multi-step / agentic. Loose heuristics — we'd rather
 *  give a chat-y query the agent budget by accident (slightly slower) than
 *  cap a real build at 3 hops. */
function _isAgenticQuery(query) {
  const q = String(query || "").toLowerCase();
  if (q.length > 140) return true;
  /* Verb + content noun = build request. Catches "create me an influencer",
   * "make a teaser ad", "recreate this tiktok", "build a brand pack",
   * "animate the hero", "generate references". */
  if (/\b(create|make|build|design|compose|generate|recreate|animate|render|produce)\b[\s\S]{0,80}\b(influencer|teaser|advert|ad|video|image|character|recreation|reference|hero|clip|brand pack|motion)\b/.test(q)) return true;
  /* Chained-step indicators. */
  if (/\b(then|next|after that|first|finally|step \d)\b[\s\S]{0,80}\b(then|next|after|finally|step \d)\b/.test(q)) return true;
  return false;
}

/** Pick the hop cap for a query. Upgradable mid-loop if an agentic tool fires. */
function _pickHopCap(query) {
  return _isAgenticQuery(query) ? HOP_CAP_AGENT : HOP_CAP_STANDARD;
}

async function askLLM(query, history = [], { sessionId = null, workspace = null } = {}) {
  /* Workspaces v4: when the caller (a specific HUD window) passes a
   * workspace slug, run the entire call inside withWorkspace() so every
   * provider that consults getCallWorkspace() — Memory, Audit,
   * creative-style — sees the calling window's scope, not the global
   * active. Outside withWorkspace(), the global active still wins. */
  if (workspace) return withWorkspace(workspace, () => _askLLMInner(query, history, { sessionId, workspace }));
  return _askLLMInner(query, history, { sessionId, workspace });
}
async function _askLLMInner(query, history = [], { sessionId = null, workspace = null } = {}) {
  const _askT0 = Date.now();
  /* Auto-confirm fast path — if there's a pending gated tool waiting on the
   * operator's "yes" and the current utterance is a bare affirmative, fire
   * the tool with confirmed:true and return a short narration. Runs before
   * fast-path so a bare "yes" doesn't hit the canned "Right." handler. */
  const autoConfirm = _consumePendingConfirmation(query);
  if (autoConfirm) {
    if (sessionId) { try { Memory.appendTurn({ sessionId, role: "user", content: query }); } catch {} }
    console.log(`[bridge] auto-confirm '${autoConfirm.name}' on operator yes`);
    let result;
    try { result = await executeTool(autoConfirm.name, autoConfirm.args); }
    catch (e) { result = { ok: false, error: String(e.message || e) }; }
    /* Narration: short spoken acknowledgement. Tools that produce side-effects
     * (image opens in Preview, video opens in QuickTime) are self-evident, so
     * keep this line tight — the operator will see/hear the result directly. */
    const reply = result?.ok === false
      ? `Couldn't complete that — ${result?.error?.slice(0, 100) || "unknown error"}.`
      : "Done, sir.";
    if (sessionId) {
      try { Memory.appendTurn({ sessionId, role: "assistant", content: reply, tools: [autoConfirm.name] }); } catch {}
    }
    return reply;
  }
  /* Fast-path: pattern-match common queries (time / timer / sleep / open
   * map / greetings) and bypass Ollama entirely. ~500ms total round-trip
   * vs ~2s through the LLM. The handler may also return a tool to dispatch
   * (set_timer for "set a 5 minute timer", enter_sleep_mode for "shut down")
   * which we run after broadcasting the spoken reply. */
  const fp = await FastPath.tryFastPath(query);
  if (fp) {
    if (sessionId) { try { Memory.appendTurn({ sessionId, role: "user", content: query }); } catch {} }
    /* Tool dispatch + reply resolution. If `reply` is a function, we await
     * the tool, pass its result to the function, and use the returned string
     * as the spoken reply. This lets handlers say "<temp> degrees, partly
     * cloudy" using fresh data from the tool itself instead of hard-coding. */
    let toolResult = null;
    if (fp.toolCall) {
      try { toolResult = await executeTool(fp.toolCall.name, fp.toolCall.args || {}); }
      catch (e) { console.warn(`[fast-path] tool ${fp.toolCall.name} failed: ${e.message}`); }
    }
    const reply = typeof fp.reply === "function"
      ? (() => { try { return fp.reply(toolResult); } catch { return "Done."; } })()
      : (fp.reply || toolResult?.summary || "Done.");
    if (sessionId) {
      try { Memory.appendTurn({ sessionId, role: "assistant", content: reply, tools: fp.toolCall ? [fp.toolCall.name] : [] }); }
      catch {}
    }
    console.log(`[fast-path] "${query.slice(0, 40)}" → bypassed LLM (${fp.toolCall?.name || "no tool"})`);
    FastPathCandidates.record({ query, elapsedMs: Date.now() - _askT0, source: "askLLM", hit: true }).catch(() => {});
    return reply;
  }

  const brand = loadBrand();
  const agencyName = brand.agency.name || CONFIG.agency.name;
  const agentName = brand.agent.name || "Jarvis";
  const tagline = brand.agency.tagline ? ` — ${brand.agency.tagline}.` : ".";
  /* Why: active-project context becomes part of the system prompt so tool calls
   * default to the operator's current scope without re-asking. Empty string when
   * no project is set — costs nothing in tokens. */
  const projectHint = Projects.systemPromptHint();
  /* Workspace v0 — operator's mental scope. When active, the workspace's
   * handbook (if any) lands in the system prompt so the LLM follows the
   * operator's scope-specific rules. Empty string when no workspace is
   * active — same prefix-cache-friendly contract as projectHint. */
  /* Per-call workspace scope (multi-window) wins over module-level active. */
  const workspaceHint = Workspaces.systemPromptHint(getCallWorkspace());
  /* Why: keep dynamic-per-turn data OUT of the system prompt. The local time
   * (HH:MM) used to live here and re-tokenised the entire prefix every minute,
   * killing Ollama's prefix cache. Date strings (today/tomorrow) stay in
   * SYSTEM since they only change once per day; the cache invalidates at
   * midnight which is fine. The local time now goes into the user message's
   * [Context] block (per-turn anyway), which is appended AFTER the cached
   * prefix and only re-tokenises the user-line tail.
   *
   * Date strings still belong in SYSTEM rather than per-turn context because
   * date-relative queries ("anything in my diary today/tomorrow") need a
   * stable anchor for filter logic, and the daily reload is cheap. */
  const _now = new Date();
  const _todayStr = _now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const _tomorrow = new Date(_now.getTime() + 86_400_000);
  const _tomorrowStr = _tomorrow.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const SYSTEM = `You are ${agentName}, a voice assistant built for ${agencyName}${tagline} The operator is currently in ${CONFIG.operator.city}, ${CONFIG.operator.country}. Today is ${_todayStr}. Tomorrow is ${_tomorrowStr}. Be concise, conversational, and natural. Two sentences max unless asked for detail. Use British English. Address the operator as "sir" sparingly (occasional, not every reply).${projectHint}${workspaceHint ? "\n\n" + workspaceHint : ""}${creativeStylePromptBlock()}

SPOKEN OUTPUT RULES (CRITICAL):
  Your reply is read aloud by a TTS voice. Output ONLY plain spoken prose:
  - NO markdown: never **bold**, *italic*, _underline_, \`code\`, or backtick fences.
  - NO bullet points, numbered lists, or section headings.
  - NO special separators like ·, —, –, |, /, or em-dashes — use words ("and", "or", "then") or commas.
  - NO emoji, no markdown links — say "the link" or describe what it is.
  - When listing items, use natural language: "I can help with three things — first… second… and third…".
  - Numbers and units in spoken form when helpful: "zero to sixty in three seconds", "five hundred horsepower", "sixteen by nine".

YOU HAVE TOOLS — call them whenever appropriate, don't just describe what you would do.

CHARACTER & CONTENT WORK — you have tools for ad scripts, image gen,
animation, AI-influencer creation, and video recreation. Use them like a
colleague would: gather what you need conversationally, call the tool when
you have enough, hand off when the operator changes direction. The tool
schemas describe what each one needs; you decide HOW to get there. No
fixed question scripts, no rigid step sequences — be helpful, sound human.

IMPORTANT — channel-character continuity: when the operator names a locked
influencer in an ad / teaser request ("make me an ad with Marcus", "use
Lena in this", "build a teaser for the channel"), pass that slug as the
'influencer' argument to generate_teaser_image. The bridge then conditions
the hero shot on that influencer's locked face — same person across every
post on the channel. Without the slug, the model produces a NEW different
face each call, defeating the whole point of having a locked character.
Resolve the operator's spoken name to the slug (lowercase first name).

A few things ARE non-negotiable:

  1. IDENTITY — the operator's words are the source of truth for any
     persona. Match their stated gender, age, ethnicity, vibe, or named
     real person EXACTLY. Don't substitute a default, don't echo a
     prompt example as the persona, don't guess gender from a name alone.
     If a demographic isn't given and you need it for the tool, ask
     plainly. The examples below show the SHAPE of a persona line, not
     its content — mix it up so the operator hears you listening.
       e.g. "30-year-old British female fitness creator"
       e.g. "Korean-American skater, mid-20s, dry-humour"
       e.g. "non-binary editorial photographer, 40s"
       e.g. "Emma Chamberlain, candid handheld"

  2. COST GATES — image / video tools cost real money on fal.ai. They
     return { requires_confirmation: "..." } on the first call; speak that
     line aloud, wait for the operator, then re-call with confirmed:true.
     The bridge also auto-fires on a bare "yes" inside 90s so you don't
     have to be perfect — but emit the second call when you can.

  3. MODEL CAPS — animate_teaser_image hard-caps at 15s, generate_teaser_image
     defaults to 9:16 for short-form. Take duration / aspect from the
     operator's exact words ("5 second" = 5, not 30). Don't propose
     beyond a tool's stated range.

  4. OPERATOR LANGUAGE — when speaking aloud, NEVER name infrastructure:
     no "fal.ai", "nano-banana", "happy-horse", "Hailuo", "Kling".
     Say "writing the script", "generating references", "locking the face",
     "animating the clip", "recreating the video". No per-second pricing.

  5. ERROR RECOVERY — when a content/image/video tool returns ok:false:
     - If the error mentions "safety", "did not generate the expected output",
       "unsafe content", or "trademark/IP/celebrity" — the input named a
       brand or celebrity the model can't render. Rephrase the prompt
       avoiding those proper nouns (use silhouette/style/colour descriptors
       instead) and re-call the SAME tool ONCE more with confirmed:true.
       Don't ask the operator first; this is a routine recovery.
     - If the error is a schema problem (missing field, wrong enum, bad
       format), call triage_failed_tool with { tool_name, args, error }
       to get a suggested fix, then retry with the fixed args + confirmed:true.
     - After ONE retry: if it still fails, tell the operator plainly what
       went wrong and ask how to proceed. Never loop more than twice.

  6. NARRATE WHILE WORKING — for LONG-RUNNING tools only (image gen,
     animation, recreation, video edit, anything that takes >10 seconds).
     ONLY when you are emitting a tool_call AND the tool is long-running:
     also include ONE short status line in your reply content describing
     what is currently happening, derived from the tool you're about to call.
     RULES:
       - DO NOT include this status on turns where you have NO tool_call.
       - DO NOT add a status to fast tools (recall, get_contact, weather,
         web_search, lookups, anything <2 seconds).
       - DO NOT echo example phrasings verbatim — make the status natural
         to the specific tool + args you're calling, in your own words.
       - Under 12 words, conversational, no model names, no filler like
         "now also" or "let me just".
     If unsure whether to narrate, DON'T — silence is fine for fast tools
     and final replies. Narration is purely for filling the dead air
     between tool start and tool finish on slow operations.

Beyond that, trust your judgement. Have the conversation that gets you
to a good output for the operator, change direction when they do, and
don't insist on a fixed sequence.

SCOPE — DO NOT REFUSE GENERAL TASKS:
  The agency framing above tells you WHO you serve, NOT what tasks you can do.
  Adam's job is automotive PR + content, but his daily work involves: scouting
  locations, looking up routes, checking weather, browsing kit suppliers,
  reading news, finding contacts, drafting messages, managing his calendar,
  controlling Mac apps, taking screenshots, looking things up online — all of
  it. NEVER say "I'm only here for automotive Jarvis tasks" or refuse a
  reasonable internet / personal-assistant task. If the operator asks for a
  map, route, weather, web lookup, or anything that needs the internet, USE
  THE TOOL (open_url, request_browse, web_search, get_weather, etc) — don't
  decline. The brand identity is the voice, not the limit.

CONFIRMATION CONTRACT (CRITICAL — client-visible writes):
  Some tools (draft_email, add_calendar_event, run_shell, write_file) REQUIRE explicit
  operator confirmation. When you call them WITHOUT confirmed: true, the bridge returns:
      { requires_confirmation: "<readable summary>", hint: "..." }
  When this happens you MUST:
    1. Speak the summary verbatim to the operator (one short sentence).
    2. WAIT for the operator to say "yes" / "go ahead" / "proceed" / similar.
    3. ONLY THEN call the SAME tool again with the SAME arguments PLUS confirmed: true.
  Never invent operator approval. If the operator says "no" or starts a different request,
  abandon the destructive tool entirely. Do not loop back to it.

PERSISTENT MEMORY: contacts, projects, free-form facts, and past conversation summaries are stored across sessions. Use them aggressively:
  - When the operator names a person ("send Ben an email"), call get_contact FIRST to find their email + context. Don't ask for an email if memory has it.
  - When the operator says "remember that...", "always X", "going forward Y" → call remember.
  - When introducing a new person → call add_contact with the parsed fields.
  - When the operator references a past project / decision → call recall to surface stored memory before answering.
  - At the end of a session (when the operator dismisses) → call save_conversation with a 2-3 sentence summary + topic tags so the next session can recall it.

VISION: you can SEE images and video keyframes via the local Qwen 2.5-VL model.
  - "What's in this image" → describe_image.
  - Captions are cached so calling these repeatedly is cheap. Vision and text models share GPU on this Mac, so don't fire batch caption jobs while the operator is mid-conversation.

When the operator asks for something that doesn't have a curated tool (e.g. "rename these files", "convert these clips to vertical", "count files matching X"), reach for run_shell. Compose ONE shell command that does the job — using ffmpeg / find / awk / sips / magick / python3 / etc. Include a short 'justification' string. The command is sandboxed: allowlist of safe binaries, no sudo / rm -rf / eval. The stdout/stderr come back so you can self-correct if it fails.

• web_search: for current/news/recent info beyond your training cutoff
• create_pdf: generate branded PDFs (quote / brief / press-release)
• get_upcoming_events / add_calendar_event: read or create macOS Calendar events (synced to Google)
• get_mail_summary / draft_email: read inbox, draft outgoing mail (NEVER auto-sends — always opens for approval)

For tools that change state (calendar, draft): briefly confirm details before calling, especially times and recipients. After successful tool calls, report what you did in one short sentence — don't read raw JSON.

When given [Context], use those facts verbatim. If asked to do something you don't have a tool for, say so plainly.`;

  const ctx = await gatherContext(query);
  /* Inject local time per-turn so SYSTEM stays stable for prefix caching. */
  const _timeStr = _now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const ctxWithTime = `Local time: ${_timeStr}.${ctx ? "\n" + ctx : ""}`;
  const userContent = `[Context — use these real facts:\n${ctxWithTime}\n]\n\n${query}`;

  const messages = [
    { role: "system", content: SYSTEM },
    ...history,
    { role: "user", content: userContent },
  ];

  /* Per-turn persistence — the operator's raw query goes in immediately so
   * even a crashed reply leaves a record. The assistant turn is written
   * after the reply resolves, with the list of tools that fired. sessionId
   * is supplied by the HUD; we tolerate its absence by skipping persistence
   * (e.g. for MCP / smoke-test entry points that don't carry one). */
  const toolsThisQuery = [];
  if (sessionId) {
    try { Memory.appendTurn({ sessionId, role: "user", content: query }); }
    catch (e) { console.warn(`[bridge] turn persist (user) failed: ${e.message}`); }
  }

  /* Embedding-based tool filter — at 97 tools the full catalogue is too much
   * context for the 14b selector. Pick the top-K most-similar by nomic-embed
   * cosine + always-on core. Resolved once per query, reused across hops so
   * the second hop's filtered set matches the first. */
  const filtered = await ToolRouter.pickRelevant(query, getEffectiveTools(), { topK: 20 });
  if (!filtered.fallback) {
    console.log(`[tool-router] ${query.slice(0, 40).replace(/\n/g, " ")} → ${filtered.picked.length}/${TOOLS.length} tools (${filtered.elapsedMs}ms)`);
  }
  /* Pre-resolve the cascade-router model so the broadcast carries it
   * alongside the tool filter result. The actual chat call below repeats
   * this lookup for hop 0 — cheap (no I/O, just regex/length checks). */
  const modelForFirstHop = ModelRouter.pick(query);
  /* Broadcast for the Agent Console's live debug pane. Trims the score table
   * to the picked tools only — no point sending 97 numbers when 18 of them
   * are what actually went to the model. */
  broadcastToClients({
    type: "tool.picked",
    data: {
      query: query.slice(0, 120),
      picked: filtered.picked,
      scores: filtered.scores,
      elapsedMs: filtered.elapsedMs,
      fallback: filtered.fallback || null,
      total: TOOLS.length,
      stream: false,
      modelUsed: modelForFirstHop,
    },
  });
  const toolsForLLM = filtered.tools;

  /* Tool-calling loop — model may emit tool_calls, we run them, append
   * results, ask again. Cap depends on lane: standard (3) for chat-y
   * queries, agent (12) for multi-step builds. Agent lane is picked from
   * query content at hop 0, but we ALSO upgrade if the model calls an
   * agentic tool partway through. Per-tool budget stops a confused model
   * from looping on the same failing call. */
  let hopCap = _pickHopCap(query);
  const toolCallCounts = {};
  for (let hop = 0; hop < hopCap; hop++) {
    /* First hop: route by query content — short / chat-y queries hit the fast model
     * on capable hardware. Subsequent hops always use main (tool-call accuracy
     * matters more than latency once a tool is already chosen). On lower-tier
     * hardware OLLAMA_FAST_MODEL is unset so both branches return main. */
    const modelForHop = hop === 0 ? ModelRouter.pick(query) : ModelRouter.pickForToolHop();
    const hopT0 = Date.now();
    /* Serialise behind the global ollama semaphore — same one crew agents
     * + browse + transcribe share. Stops a concurrent voice turn + crew
     * agent from racing on the GPU. */
    const res = await LlmProviders.withOllamaSlot(() => fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      /* keep_alive: capable hardware (ultra / m5-max) gets long values via the
       * wizard's OLLAMA_KEEP_ALIVE setting so the model doesn't unload between
       * turns. Lower-tier installs stick to "30s" so the model can free memory
       * for other work. */
      body: JSON.stringify({ model: modelForHop, messages, stream: false, tools: toolsForLLM, keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30s" }),
    }));
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = await res.json();
    /* Per-hop usage row — Ollama returns token counts in the response. */
    UsageLog.recordUsage({
      provider: "ollama",
      model: modelForHop,
      tokensIn: data.prompt_eval_count || 0,
      tokensOut: data.eval_count || 0,
      elapsedMs: Date.now() - hopT0,
      source: `askLLM.hop${hop}`,
    }).catch(() => {});
    const msg = data.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (calls.length === 0) {
      const finalReply = (msg.content || "").trim();
      if (sessionId && finalReply) {
        try { Memory.appendTurn({ sessionId, role: "assistant", content: finalReply, tools: toolsThisQuery }); }
        catch (e) { console.warn(`[bridge] turn persist (assistant) failed: ${e.message}`); }
      }
      /* Record fall-through with total elapsed — this is the data point
       * that turns into "queries you should fast-path next" later. */
      FastPathCandidates.record({ query, elapsedMs: Date.now() - _askT0, source: "askLLM", hit: false }).catch(() => {});
      return finalReply;
    }

    // Append the assistant's tool-call message + execute each tool, append their results
    messages.push(msg);
    for (const c of calls) {
      const fname = c.function?.name;
      let args = c.function?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      /* Upgrade to agent lane the first time we see an agentic tool fired. */
      if (AGENTIC_TOOL_NAMES.has(fname) && hopCap < HOP_CAP_AGENT) {
        hopCap = HOP_CAP_AGENT;
        console.log(`[bridge] agent lane engaged via ${fname} — hopCap raised to ${hopCap}`);
      }
      /* Per-tool budget. After N calls of the same tool in one task, stop
       * accepting it — return a guard error so the LLM picks a different
       * approach or hands off to the operator. */
      toolCallCounts[fname] = (toolCallCounts[fname] || 0) + 1;
      let result;
      if (toolCallCounts[fname] > TOOL_CALL_BUDGET_PER_TASK) {
        console.log(`[bridge] tool budget exceeded for ${fname} (${toolCallCounts[fname]} calls) — returning guard error`);
        result = { ok: false, error: `Tool '${fname}' has been called ${toolCallCounts[fname]} times in this task — that's too many retries on the same call. Either pick a different tool, change the args meaningfully, or tell the operator what's blocking and stop.` };
      } else {
        console.log(`[bridge] tool call: ${fname}(${JSON.stringify(args).slice(0, 120)})`);
        toolsThisQuery.push(fname);
        try { result = await executeTool(fname, args || {}); }
        catch (e) { result = { error: String(e.message || e) }; }
      }
      messages.push({
        role: "tool",
        content: JSON.stringify(result).slice(0, 8000),
        tool_name: fname,
      });
    }
  }
  /* Hop loop hit max without a clean answer — still log as fall-through
   * so dashboards see the slow path. */
  FastPathCandidates.record({ query, elapsedMs: Date.now() - _askT0, source: "askLLM", hit: false }).catch(() => {});
  return "I tried a few approaches but couldn't pull a clean result together — could you tell me a bit more about what you're after?";
}

/**
 * Streaming variant of askLLM.
 *
 *  Why: Kokoro waits for the full Qwen reply before speaking, which feels sluggish on
 *  longer answers. With NDJSON streaming from Ollama we can split the model's output
 *  into sentences as they arrive and pipe each one to TTS while the next is still
 *  being generated. Cuts perceived latency in half on multi-sentence replies.
 *
 *  Tool-calling stays correct: each hop streams its own content; if the terminal
 *  message carries tool_calls we execute them, append results, and loop. The tool
 *  loop matches askLLM() — only the inner fetch gains stream:true plus an NDJSON parser.
 *
 *  @param {object}   args
 *  @param {string}   args.query              the operator's utterance
 *  @param {array}    [args.history=[]]       prior turns for context
 *  @param {(s: string) => void} args.onSentence  fires once per completed sentence
 *  @returns {Promise<string>} the fully-assembled reply (caller can also persist this
 *  to history without missing anything that was streamed).
 */
async function askLLMStream({ query, history = [], onSentence, sessionId = null, workspace = null }) {
  if (workspace) {
    return withWorkspace(workspace, () =>
      _askLLMStreamInner({ query, history, onSentence, sessionId, workspace }));
  }
  return _askLLMStreamInner({ query, history, onSentence, sessionId, workspace });
}
async function _askLLMStreamInner({ query, history = [], onSentence, sessionId = null, workspace = null }) {
  const _askStreamT0 = Date.now();
  /* Auto-confirm fast path — same as askLLM. Runs before fast-path so a
   * bare "yes" can fire the pending gated tool instead of hitting the
   * canned "Right." reply. See _executeToolInner for the gate write. */
  const autoConfirm = _consumePendingConfirmation(query);
  if (autoConfirm) {
    if (sessionId) { try { Memory.appendTurn({ sessionId, role: "user", content: query }); } catch {} }
    console.log(`[bridge stream] auto-confirm '${autoConfirm.name}' on operator yes`);
    let result;
    try { result = await executeTool(autoConfirm.name, autoConfirm.args); }
    catch (e) { result = { ok: false, error: String(e.message || e) }; }
    const reply = result?.ok === false
      ? `Couldn't complete that — ${result?.error?.slice(0, 100) || "unknown error"}.`
      : "Done, sir.";
    try { onSentence?.(reply); } catch {}
    if (sessionId) {
      try { Memory.appendTurn({ sessionId, role: "assistant", content: reply, tools: [autoConfirm.name] }); } catch {}
    }
    return reply;
  }
  /* Fast-path: pattern-match common queries and emit a synthetic single-
   * sentence stream. Same shape as a real LLM stream from the HUD's
   * point of view — onSentence fires once with the canned reply, the
   * function returns the same string. End-to-end latency for these
   * queries: STT + Kokoro only, ~500ms total vs ~2s through the LLM. */
  const fp = await FastPath.tryFastPath(query);
  if (fp) {
    if (sessionId) { try { Memory.appendTurn({ sessionId, role: "user", content: query }); } catch {} }
    let toolResult = null;
    if (fp.toolCall) {
      try { toolResult = await executeTool(fp.toolCall.name, fp.toolCall.args || {}); }
      catch (e) { console.warn(`[fast-path stream] tool ${fp.toolCall.name} failed: ${e.message}`); }
    }
    const reply = typeof fp.reply === "function"
      ? (() => { try { return fp.reply(toolResult); } catch { return "Done."; } })()
      : (fp.reply || toolResult?.summary || "Done.");
    try { onSentence?.(reply); } catch {}
    if (sessionId) {
      try { Memory.appendTurn({ sessionId, role: "assistant", content: reply, tools: fp.toolCall ? [fp.toolCall.name] : [] }); }
      catch {}
    }
    console.log(`[fast-path stream] "${query.slice(0, 40)}" → bypassed LLM (${fp.toolCall?.name || "no tool"})`);
    FastPathCandidates.record({ query, elapsedMs: Date.now() - _askStreamT0, source: "askLLMStream", hit: true }).catch(() => {});
    return reply;
  }

  /* Why log: when the kiosk goes silent mid-turn, the bridge log was empty —
   * no entry for the inbound query, no entry for hop boundaries. Every later
   * "is it stuck?" debug starts blind. One concise line per hop + the first
   * sentence emitted gives us a timeline without spamming the log. */
  const t0 = Date.now();
  console.log(`[stream] ask: "${query.slice(0, 80)}${query.length > 80 ? '…' : ''}"`);
  const brand = loadBrand();
  const agencyName = brand.agency.name || CONFIG.agency.name;
  const agentName = brand.agent.name || "Jarvis";
  const tagline = brand.agency.tagline ? ` — ${brand.agency.tagline}.` : ".";
  const projectHint = Projects.systemPromptHint();
  /* Per-call workspace scope (multi-window) wins over module-level active. */
  const workspaceHint = Workspaces.systemPromptHint(getCallWorkspace());
  /* SYSTEM is shared with askLLM — keep duplicated here so both paths stay in sync.
   * Local time MUST be in the user message, not SYSTEM, or the prefix cache
   * invalidates every minute. See askLLM for the matching comment. */
  const _now = new Date();
  const _todayStr = _now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const _tomorrow = new Date(_now.getTime() + 86_400_000);
  const _tomorrowStr = _tomorrow.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const SYSTEM = `You are ${agentName}, a voice assistant built for ${agencyName}${tagline} The operator is currently in ${CONFIG.operator.city}, ${CONFIG.operator.country}. Today is ${_todayStr}. Tomorrow is ${_tomorrowStr}. Be concise, conversational, and natural. Two sentences max unless asked for detail. Use British English. Address the operator as "sir" sparingly (occasional, not every reply).${projectHint}${workspaceHint ? "\n\n" + workspaceHint : ""}

Output plain spoken prose only — no markdown, no bullet points, no emoji, no special separators. Numbers and units in spoken form when helpful.

YOU HAVE TOOLS — call them whenever appropriate. When given [Context], use those facts verbatim.

CHARACTER & CONTENT WORK — you have tools for ad scripts, image gen,
animation, AI-influencer creation, and video recreation. Use them like a
colleague would: gather what you need conversationally, call the tool when
you have enough. The schemas describe what each tool needs. No fixed
question scripts. Non-negotiables:
  - IDENTITY: match the operator's stated gender, age, ethnicity, vibe,
    or named real person EXACTLY. Don't substitute defaults, don't echo
    examples as the persona, don't guess gender from a name. Ask if a
    detail you need is missing.
  - COST GATES: image / video tools return requires_confirmation on the
    first call — speak it, wait, re-call with confirmed:true. Bridge auto-
    fires on a bare "yes" within 90s as a safety net.
  - MODEL CAPS: animate_teaser_image hard-caps at 15s. Take duration
    and aspect from the operator's exact words, not a default.
  - OPERATOR LANGUAGE: aloud, never name infrastructure ("fal.ai",
    "nano-banana", "happy-horse", "Hailuo", "Kling"). Say "writing the
    script", "generating references", "locking the face", "animating",
    "recreating".
  - ERROR RECOVERY: if a tool returns ok:false with a safety/content
    rejection, rephrase to drop trademarks/celebrity names and retry
    ONCE with confirmed:true. For schema/format errors, call
    triage_failed_tool with { tool_name, args, error } first, then
    retry with the suggested fix. Never loop more than twice.
  - NARRATE WHILE WORKING: ONLY when calling a LONG-RUNNING tool
    (image gen, animation, recreation, video edit — anything >10s).
    Include ONE short status line in your reply content describing what
    is happening, in your own words, specific to the tool + args.
    DO NOT narrate when there is no tool_call this turn. DO NOT narrate
    on fast tools (lookups, web_search, recall). DO NOT echo phrasings
    verbatim — write fresh status each time. Under 12 words, no filler.
For recreation specifically: "recreate this video using <name>" → call
recreate_video_with_influencer with just { slug }; the bridge opens the
URL/file modal automatically, don't ask for the URL yourself.
For ads / teasers featuring a locked influencer: pass their slug as the
'influencer' arg to generate_teaser_image so the hero shot uses their
locked face — without it you get a generic face, not the channel's character.

SCOPE — DO NOT REFUSE GENERAL TASKS:
  The agency framing above tells you WHO you serve, NOT what tasks you can do.
  Adam's daily work involves scouting locations, looking up routes, checking
  weather, browsing kit suppliers, reading news, finding contacts, drafting
  messages, managing his calendar, controlling Mac apps, looking things up
  online — all of it. NEVER say "I'm only here for automotive Jarvis tasks"
  or refuse a reasonable internet / personal-assistant task. If the operator
  asks for a map, route, weather, web lookup, or anything that needs the
  internet, USE THE TOOL (open_url, request_browse, web_search, etc) — don't
  decline. The brand identity is the voice, not the limit.`;

  const ctx = await gatherContext(query);
  /* Inject local time per-turn so the system prompt stays stable. */
  const _timeStr = _now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const ctxWithTime = `Local time: ${_timeStr}.${ctx ? "\n" + ctx : ""}`;
  const userContent = `[Context — use these real facts:\n${ctxWithTime}\n]\n\n${query}`;
  const messages = [
    { role: "system", content: SYSTEM },
    ...history,
    { role: "user", content: userContent },
  ];

  /* Per-turn persistence (streaming path). User turn gets logged immediately
   * so a stream that fails partway still leaves a record. Assistant turn is
   * written below once the stream finishes (or after the last hop completes,
   * with the full accumulated text). */
  const toolsThisQuery = [];
  if (sessionId) {
    try { Memory.appendTurn({ sessionId, role: "user", content: query }); }
    catch (e) { console.warn(`[bridge] turn persist (user, stream) failed: ${e.message}`); }
  }

  /* Sentence boundary state — accumulates streamed tokens, flushes on terminal
   * punctuation. The FIRST emit uses a looser rule than subsequent ones:
   * waits for a comma or colon after >=12 chars (catches conversational
   * openers like "Yes, sir," or "On it,") so audio starts as fast as
   * possible. Subsequent sentences use the standard ".!?" + 8-char rule
   * so synthesised speech stays well-paced.
   *
   * Why two rules: the first audio chunk is the perceived response time;
   * the rest are pacing. Loosening just the first cuts ~150-300ms off the
   * wake-to-first-audio span on conversational replies without affecting
   * cadence on longer answers. */
  const MIN_LEN = 8;
  const FIRST_EARLY_MIN = 12;
  const sb = { text: "", emitted: "", firstEmitted: false };
  function pushToken(token) {
    if (!token) return;
    sb.text += token;
    sb.emitted += token;
    /* First-chunk fast path: emit on a comma or colon if the buffer has
     * enough natural language to produce a non-clipped audio chunk. Only
     * fires once per stream. */
    if (!sb.firstEmitted && sb.text.length >= FIRST_EARLY_MIN) {
      const m = sb.text.match(/[,;:](\s|$)/);
      if (m) {
        const end = m.index + 1;
        const sentence = sb.text.slice(0, end).trim();
        sb.text = sb.text.slice(end).replace(/^\s+/, "");
        if (sentence.length >= FIRST_EARLY_MIN) {
          sb.firstEmitted = true;
          try { onSentence(sentence); } catch (e) { console.warn(`[stream] onSentence threw: ${e.message}`); }
        } else {
          /* Restore — too short to be worth the early emit. */
          sb.text = sentence + " " + sb.text;
        }
      }
    }
    while (true) {
      const m = sb.text.match(/[.!?](\s|$)/);
      if (!m) break;
      const end = m.index + 1;
      const sentence = sb.text.slice(0, end).trim();
      sb.text = sb.text.slice(end).replace(/^\s+/, "");
      if (sentence.length >= MIN_LEN) {
        sb.firstEmitted = true;
        try { onSentence(sentence); } catch (e) { console.warn(`[stream] onSentence threw: ${e.message}`); }
      } else {
        /* Too short — merge back so we don't emit a tiny TTS clip. Prepend with a space
         * so the next sentence's punctuation still detects properly. */
        sb.text = sentence + " " + sb.text;
        break;
      }
    }
  }
  function flushFinal() {
    const tail = sb.text.trim();
    if (tail.length) { try { onSentence(tail); } catch {} }
    sb.text = "";
  }

  /* Embedding-based tool filter — same as askLLM(). Resolved once before the
   * hop loop so all hops share the same filtered set; otherwise the model
   * could pick tool A on hop 1 then find it absent on hop 2. */
  const filtered = await ToolRouter.pickRelevant(query, getEffectiveTools(), { topK: 20 });
  if (!filtered.fallback) {
    console.log(`[tool-router] (stream) → ${filtered.picked.length}/${TOOLS.length} tools (${filtered.elapsedMs}ms)`);
  }
  const modelForFirstHopStream = ModelRouter.pick(query);
  broadcastToClients({
    type: "tool.picked",
    data: {
      query: query.slice(0, 120),
      picked: filtered.picked,
      scores: filtered.scores,
      elapsedMs: filtered.elapsedMs,
      fallback: filtered.fallback || null,
      total: TOOLS.length,
      stream: true,
      modelUsed: modelForFirstHopStream,
    },
  });
  const toolsForLLM = filtered.tools;

  /* Hop loop — standard lane (3 hops) for chat-y queries, agent lane (12)
   * for multi-step builds. Lane is picked from query content at hop 0 and
   * upgraded if any agentic tool fires partway through. Each hop streams;
   * tool_calls in the terminal frame trigger an extra hop with the tool
   * results appended to messages. Model routing matches the non-streaming
   * path: first hop picks via query content, subsequent hops always use
   * main (tool-call accuracy beats latency once tools are involved). */
  let hopCap = _pickHopCap(query);
  const toolCallCounts = {};
  let firstSentenceLogged = false;
  for (let hop = 0; hop < hopCap; hop++) {
    const modelForHop = hop === 0 ? ModelRouter.pick(query) : ModelRouter.pickForToolHop();
    const hopT0 = Date.now();
    console.log(`[stream] hop ${hop} → ${modelForHop}`);
    /* Streaming holds the ollama slot until the body is fully consumed —
     * fetch() returns at headers but the GPU is still generating until
     * the terminal frame. We acquire explicitly here and release at the
     * bottom of the hop in a finally block so any error path also frees
     * the slot. */
    const slotRelease = await LlmProviders.acquireOllamaSlot();
    let res;
    try { res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelForHop, messages, stream: true, tools: toolsForLLM, keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30s" }),
    }); }
    catch (e) { slotRelease(); throw e; }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn(`[stream] hop ${hop} ollama ${res.status}: ${txt.slice(0, 200)}`);
      throw new Error(`Ollama ${res.status}: ${txt}`);
    }

    /* NDJSON parsing — Ollama emits one JSON object per line. We accumulate partial
     * lines across read() chunks because TCP doesn't guarantee a full event per chunk. */
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalMsg = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        const content = evt.message?.content;
        if (content) {
          pushToken(content);
          if (!firstSentenceLogged && content.match(/[.!?]/)) {
            firstSentenceLogged = true;
            console.log(`[stream] first sentence at ${Date.now() - t0}ms`);
          }
        }
        /* Capture tool_calls eagerly. Why: Ollama's streaming protocol for
         * qwen2.5 emits tool_calls in a NON-DONE frame, then the done:true
         * frame's message is empty (role + content only, no tool_calls).
         * Reading finalMsg only on done would silently drop every tool
         * call — exact bug Adam hit on "open amazon for AA batteries"
         * etc, where the model emitted open_url calls that never reached
         * dispatch. Capture eagerly + don't overwrite with the empty
         * done frame. */
        if (Array.isArray(evt.message?.tool_calls) && evt.message.tool_calls.length) {
          finalMsg = evt.message;
        }
        if (evt.done) {
          /* Only fall through to the done-frame message if no earlier
           * frame carried tool_calls. Preserves the captured tool_calls. */
          if (!finalMsg) finalMsg = evt.message || finalMsg;
          /* Ollama emits prompt_eval_count + eval_count on the terminal
           * (done) frame. Log the hop's usage here, mirroring the askLLM
           * non-streaming path so /usage covers both. */
          UsageLog.recordUsage({
            provider: "ollama",
            model: modelForHop,
            tokensIn: evt.prompt_eval_count || 0,
            tokensOut: evt.eval_count || 0,
            elapsedMs: Date.now() - hopT0,
            source: `askLLMStream.hop${hop}`,
          }).catch(() => {});
        }
      }
    }
    /* Body fully consumed — GPU is free for the next caller. Release the
     * ollama semaphore now even though we're about to dispatch tools (which
     * doesn't touch ollama). */
    slotRelease();

    const calls = Array.isArray(finalMsg?.tool_calls) ? finalMsg.tool_calls : [];
    console.log(`[stream] hop ${hop} done in ${Date.now() - hopT0}ms, ${calls.length} tool calls, content len=${sb.emitted.length}`);
    if (calls.length === 0) {
      flushFinal();
      console.log(`[stream] complete in ${Date.now() - t0}ms (${sb.emitted.length} chars total)`);
      const finalReply = sb.emitted.trim();
      if (sessionId && finalReply) {
        try { Memory.appendTurn({ sessionId, role: "assistant", content: finalReply, tools: toolsThisQuery }); }
        catch (e) { console.warn(`[bridge] turn persist (assistant, stream) failed: ${e.message}`); }
      }
      FastPathCandidates.record({ query, elapsedMs: Date.now() - _askStreamT0, source: "askLLMStream", hit: false }).catch(() => {});
      return finalReply;
    }

    /* Tool-calling hop: append the assistant message + each tool's result, then loop.
     * We DON'T flush between hops — sometimes the model emits a one-line "Looking that
     * up..." in this hop's content, which we want spoken before the tool result drives
     * the next hop. That's the agent-mode "narration" hook: inter-hop content like
     * "Generating the references now…" / "Uploading the source video…" streams to
     * Kokoro as it arrives, so the operator hears progress while tools are running. */
    messages.push(finalMsg);
    for (const c of calls) {
      const fname = c.function?.name;
      let args = c.function?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      /* Upgrade to agent lane if a multi-step tool fires. */
      if (AGENTIC_TOOL_NAMES.has(fname) && hopCap < HOP_CAP_AGENT) {
        hopCap = HOP_CAP_AGENT;
        console.log(`[stream] agent lane engaged via ${fname} — hopCap raised to ${hopCap}`);
      }
      /* Per-tool budget — return a guard error after N calls of the same tool
       * so a confused model doesn't burn the whole agent budget on one
       * failing call. The error message tells the LLM what to do next. */
      toolCallCounts[fname] = (toolCallCounts[fname] || 0) + 1;
      let result;
      if (toolCallCounts[fname] > TOOL_CALL_BUDGET_PER_TASK) {
        console.log(`[stream] tool budget exceeded for ${fname} (${toolCallCounts[fname]} calls)`);
        result = { ok: false, error: `Tool '${fname}' has been called ${toolCallCounts[fname]} times in this task — that's too many retries on the same call. Either pick a different tool, change the args meaningfully, or tell the operator what's blocking and stop.` };
      } else {
        console.log(`[bridge] tool call (stream): ${fname}(${JSON.stringify(args).slice(0, 120)})`);
        toolsThisQuery.push(fname);
        try { result = await executeTool(fname, args || {}); }
        catch (e) { result = { error: String(e.message || e) }; }
      }
      messages.push({
        role: "tool",
        content: JSON.stringify(result).slice(0, 8000),
        tool_name: fname,
      });
    }
    /* Reset between hops since the next hop's stream will fill sb.text from the start. */
    sb.text = "";
  }

  flushFinal();
  const finalReply = sb.emitted.trim();
  if (sessionId && finalReply) {
    try { Memory.appendTurn({ sessionId, role: "assistant", content: finalReply, tools: toolsThisQuery }); }
    catch (e) { console.warn(`[bridge] turn persist (assistant, stream end) failed: ${e.message}`); }
  }
  FastPathCandidates.record({ query, elapsedMs: Date.now() - _askStreamT0, source: "askLLMStream", hit: false }).catch(() => {});
  return finalReply || "I tried a few searches but couldn't pull a clean answer together — try asking more specifically.";
}

/* ---------- WEATHER (Open-Meteo, no API key needed) ---------- */

/** Geocode a free-text place name → {name, country, lat, lon, timezone} or null. */
async function geocodeLocation(name) {
  try {
    const r = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`,
      { signal: AbortSignal.timeout(4000) },
    );
    const j = await r.json();
    const hit = (j.results || [])[0];
    if (!hit) return null;
    return {
      name: hit.name,
      country: hit.country || hit.country_code || "",
      lat: hit.latitude,
      lon: hit.longitude,
      timezone: hit.timezone || "auto",
    };
  } catch { return null; }
}

/**
 * Fetch current conditions + daily forecast.
 * Why timezone=auto: Open-Meteo's daily aggregates are bucketed by the LOCATION's local
 * timezone. Hard-coding Europe/London (the old behaviour) returned UK-day buckets for
 * Alicante etc., which is meaningless. `auto` lets the API pick the right tz from lat/lon.
 * @param {number} [lat]
 * @param {number} [lon]
 * @param {number} [days] — forecast horizon, clamped 1..14 (Open-Meteo's free-tier ceiling).
 */
/* Weather cache. Open-Meteo is fast (~150-400ms) but we still cache by
 * (lat,lon,days) for 10 minutes — weather doesn't meaningfully change
 * faster than that, and the prewarm module keeps the operator's home
 * key warm so the first call after boot is also instant. */
const _weatherCache = new Map(); /* key → { stamp, value } */
const WEATHER_TTL_MS = 10 * 60 * 1000;

async function getWeather(lat = CONFIG.operator.latitude, lon = CONFIG.operator.longitude, days = 6, { force = false } = {}) {
  const d = Math.max(1, Math.min(14, Math.floor(Number(days) || 6)));
  const key = `${lat}|${lon}|${d}`;
  if (!force) {
    const hit = _weatherCache.get(key);
    if (hit && (Date.now() - hit.stamp) < WEATHER_TTL_MS && !hit.value.error) {
      return hit.value;
    }
  }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,wind_speed_10m_max&timezone=auto&forecast_days=${d}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    /* Skip index 0 (today) — `now` already covers today, forecast is forward-looking. */
    const value = {
      now: { temp: Math.round(data.current.temperature_2m), code: data.current.weather_code },
      forecast: data.daily.time.slice(1).map((dt, i) => ({
        date: dt,
        hi: Math.round(data.daily.temperature_2m_max[i + 1]),
        lo: Math.round(data.daily.temperature_2m_min[i + 1]),
        code: data.daily.weather_code[i + 1],
        rain_mm: data.daily.precipitation_sum?.[i + 1] ?? null,
        wind_kph: data.daily.wind_speed_10m_max?.[i + 1] ?? null,
      })),
    };
    _weatherCache.set(key, { stamp: Date.now(), value });
    return value;
  } catch (e) {
    return { error: e.message };
  }
}

/* ---------- TEASER PIPELINE (Sprint 13, fal.ai-backed) ---------- *
 *
 *  Three tools that compose into a voice-driven advert pipeline:
 *
 *    1. make_teaser_storyboard — LLM-only. Produces a 30s social-ad script
 *       broken into 5s beats + a single hero-image prompt. Free.
 *    2. generate_teaser_image — fal-ai/nano-banana/pro. Generates the hero
 *       still from the prompt. Confirmation-gated (~$0.04).
 *    3. animate_teaser_image — fal-ai/minimax/hailuo-02/standard. Animates
 *       the still into a 5-10s clip. Confirmation-gated (~$0.30).
 *
 *  Output structure: output/teasers/<run_id>/{storyboard.md, hero.png, clip.mp4, meta.json}
 *  run_id format: ISO timestamp with colons and dots replaced — sortable by date. */

import { execFile as _execFile } from "node:child_process";

/** Tiny wrapper around Ollama /api/chat for the storyboard step.
 *  Forces JSON output mode so the structured shape is parseable. */
async function _teaserLLM({ system, user, temperature = 0.5 }) {
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: getModel(),
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      options: { temperature },
      format: "json",
      keep_alive: "5m",
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`teaser LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.message?.content || "";
}

/** Triage a failing tool call — read the failing tool's schema, ask the
 *  local LLM what to change, return suggested args. Distinct from the
 *  safety-rephrase path (which targets a single text prompt field): this
 *  handles arbitrary schema / format / enum errors across any tool by
 *  reading the tool's parameter list. ~1-2s on local Ollama, $0 fal cost.
 *
 *  Why a tool rather than implicit retry: making this an explicit tool the
 *  LLM can choose to call keeps the agency in Qwen's hands. It can decide
 *  to triage AND retry, OR ask the operator first if the cost of being
 *  wrong is high (e.g. it'd burn fal money on a bad guess). */
async function triageFailedTool({ tool_name, args, error }) {
  if (!tool_name) return { ok: false, error: "tool_name is required" };
  if (!error) return { ok: false, error: "error is required (the message from the failing call)" };
  const tool = (TOOLS || []).find((t) => t?.function?.name === tool_name);
  if (!tool) return { ok: false, error: `unknown tool '${tool_name}'` };

  /* Build a focused prompt: tool schema + the bad call + the error. Ask for
   * a structured JSON response so the LLM's suggestion is directly usable. */
  const schema = JSON.stringify(tool.function, null, 2);
  const sys = "You are a tool-call repair assistant. Given a failing tool call (its schema, the args that were sent, and the error message), suggest CORRECTED ARGS that should make the call succeed. Output JSON ONLY with this shape:\n" +
    "{ \"fixed_args\": { ...args... }, \"reasoning\": \"<one short sentence on what was wrong and how the fix addresses it>\", \"confidence\": \"high\"|\"medium\"|\"low\" }\n" +
    "Rules:\n" +
    "- Preserve every arg the LLM intentionally passed unless the error proves it's wrong.\n" +
    "- For missing-required-field errors, add the field with a sensible default from the schema's description.\n" +
    "- For wrong-enum-value errors, pick the closest matching enum value.\n" +
    "- For format errors, fix the format (string→number, etc) keeping the operator's intent.\n" +
    "- If the error suggests the underlying request will not work no matter what (auth failure, model unavailable, network), set confidence:'low' and reasoning to explain — do NOT invent arg fixes that won't help.\n" +
    "- Do NOT add `confirmed: true` to fixed_args; the caller adds that on retry.";
  const userMsg = `TOOL SCHEMA:\n${schema}\n\nORIGINAL ARGS:\n${JSON.stringify(args || {}, null, 2)}\n\nERROR:\n${String(error).slice(0, 600)}\n\nReturn the JSON repair object.`;

  let raw;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: getModel(),
        stream: false,
        messages: [{ role: "system", content: sys }, { role: "user", content: userMsg }],
        options: { temperature: 0.2 },
        format: "json",
        keep_alive: "5m",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`triage LLM ${r.status}`);
    const j = await r.json();
    raw = j.message?.content || "";
  } catch (e) {
    return { ok: false, error: `triage LLM call failed: ${e.message}` };
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, error: `triage LLM returned non-JSON: ${e.message}`, raw: raw.slice(0, 300) }; }

  if (!parsed?.fixed_args || typeof parsed.fixed_args !== "object") {
    return { ok: false, error: "triage suggestion missing fixed_args object", raw: JSON.stringify(parsed).slice(0, 300) };
  }
  return {
    ok: true,
    suggestion: {
      fixed_args: parsed.fixed_args,
      reasoning: String(parsed.reasoning || "").slice(0, 300),
      confidence: parsed.confidence === "high" ? "high" : parsed.confidence === "low" ? "low" : "medium",
    },
    next_step: "If confidence is 'high' or 'medium', re-call the original tool with these fixed_args plus confirmed:true. If 'low', tell the operator what's wrong and ask how to proceed — don't loop blindly.",
  };
}

/** Rephrase an image-gen prompt to drop trademarks / celebrity names that
 *  tripped fal's safety filter, preserving the visual intent. Used as the
 *  rephrase callback for Fal.runImageWithSafetyRetry. ~1-2s on local Ollama,
 *  ~zero direct cost. Plain text out (not JSON) so we don't need format:json. */
async function _rephrasePromptForSafety(prompt) {
  const system = "You are a prompt-safety editor. The image-generation model just rejected a prompt because it contains specific trademarks, celebrity names, copyrighted characters, or brand IP that the safety filter blocks. Rewrite the prompt to express the SAME visual intent through silhouette / style / colour / archetype descriptors instead of brand or proper-noun names. Keep ALL non-IP details verbatim (gender, age, ethnicity, pose, lighting, location, aesthetic). Examples of allowed swaps: 'Mickey Mouse' → 'classic vintage anthropomorphic cartoon mouse mascot with large round black ears and a round white face'; 'Nike Air Jordan 1' → 'high-top basketball sneakers in a red, black and white colourway'; 'Chicago Bulls #23 jersey' → 'red sleeveless basketball jersey with the bold white number 23'. Return ONLY the rewritten prompt as plain text — no preamble, no quotes, no code fences.";
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: getModel(),
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      options: { temperature: 0.3 },
      keep_alive: "5m",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`safety-rephrase LLM ${r.status}`);
  const j = await r.json();
  return (j.message?.content || "").trim();
}

/** Build a fresh run_id (URL-safe, sortable, also valid as a filename). */
function _newRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Resolve the per-run output directory; create on demand. */
async function _teaserDir(runId) {
  const fsp = await import("node:fs/promises");
  const path2 = await import("node:path");
  const dir = path2.join(Paths.getOutputDir(), "teasers", runId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Validate aspect_ratio string against nano-banana-pro's accepted set.
 *  Confirmed against production usage in AI-Custom-Cards (the operator's other
 *  product that uses this model in production). nano-banana-pro takes a literal
 *  aspect_ratio string ("9:16", "1:1") rather than the named enum that some
 *  fal models use (portrait_16_9, square_hd, etc). */
function _aspectRatio(aspect) {
  const valid = new Set(["9:16", "16:9", "1:1", "4:5", "3:4", "21:9"]);
  return valid.has(aspect) ? aspect : "9:16";
}

/** Open a file in macOS's default viewer. Uses execFile (no shell) so the
 *  path argument can't trigger shell-injection even with special chars. */
function _openLocal(p) {
  try { _execFile("open", [p], () => {}); } catch {}
}

/** Step 1 — storyboard. LLM-only, no fal call. */
async function makeTeaserStoryboard({ product, influencer, duration_s = 15, platform = "tiktok", tone = "" }) {
  if (!product) return { ok: false, error: "product is required" };
  if (!influencer) return { ok: false, error: "influencer is required" };
  /* Why: previous code floored to 15s (3 beats × 5s) which silently turned
   * a "make me a 5-second teaser" request into a 15s storyboard. Now we
   * scale the beat structure to fit the asked duration: ≤5s = 1 beat,
   * ≤10s = 2 beats, otherwise ~5s per beat with a 3-beat minimum so longer
   * ads still get proper structure. Cap kept at 120s to stop runaway prompts. */
  /* Default 15s if upstream didn't pass anything (TikTok's default short-form
   * length and the cap most image-to-video models honour). Cap at 120s so a
   * misheard "two minutes" doesn't burn an entire LLM context on a 240s
   * storyboard. Floor at 3s — anything shorter isn't a coherent ad beat. */
  const dur = Math.max(3, Math.min(120, Number(duration_s) || 15));
  let beatCount, beatLen;
  if (dur <= 5) { beatCount = 1; beatLen = dur; }
  else if (dur <= 10) { beatCount = 2; beatLen = Math.ceil(dur / 2); }
  else { beatCount = Math.max(3, Math.round(dur / 5)); beatLen = Math.round(dur / beatCount); }
  /* Pre-render the example time codes so the LLM sees concrete boundaries
   * matching beatLen (otherwise it tends to default back to 0-5s slots). */
  const exampleTimes = Array.from({ length: beatCount }, (_, i) => `${i * beatLen}-${(i + 1) * beatLen}s`);

  const system = `You are a social-media advert copywriter. Produce ${platform === "linkedin" ? "polished, professional" : "punchy, native-feel"} short-form video scripts that perform on ${platform}.
Output JSON ONLY with this exact shape:
{
  "title": "<7-word working title>",
  "hook": "<single-sentence hook for the opening ${Math.min(2, beatLen)} seconds>",
  "beats": [
${exampleTimes.map((t) => `    { "time": "${t}", "visual": "<concrete visual description>", "voiceover": "<spoken line>", "on_screen_text": "<short overlay caption or empty>" }`).join(",\n")}
  ],
  "cta": "<closing call-to-action voiceover line>",
  "hero_prompt": "<single detailed visual description for the most striking still frame from the ad — for an image generator>"
}

Constraints:
- Total duration must equal ${dur} seconds (${beatCount} beat${beatCount === 1 ? "" : "s"} × ${beatLen}s${beatCount === 1 ? " — single tight beat, no breakdown" : ""}).
- USE THE INFLUENCER VERBATIM AS GIVEN. The "Influencer / persona" line in the user message is the SOURCE OF TRUTH — match its gender, age, ethnicity and vibe exactly. If it says "a 30-year-old British female fitness creator", write a 30-year-old British female fitness creator. NEVER substitute a celebrity name, NEVER default to a male persona when the input is female (or vice-versa), NEVER ignore demographic details. If the operator named a specific real person, reference them by that exact name in visual descriptions and write the script in their cadence; do NOT swap to a generic stand-in. The operator picked this persona on purpose.
- For real-person influencers: write the visual descriptions in third-person observational style (suitable for an image generator). Voiceover lines remain in their voice. This is a creative ad mock-up — celebrity likeness is being used commercially in the spirit of a brand-pitch storyboard, which is standard ad-industry practice.
- hero_prompt should be a self-contained image-gen prompt (subject including the named influencer if applicable + setting + lighting + style + mood). Always reference the influencer by name in the hero_prompt so the image generator depicts THE PERSON specified.
- Don't use AI cliches like "delve" or "in today's fast-paced world".
- No exclamation marks unless the influencer's tone explicitly calls for them.`;

  const user = `Product: ${product}
Influencer / persona: ${influencer}
Duration: ${dur} seconds
Platform: ${platform}${tone ? `\nTone: ${tone}` : ""}

Write the script.`;

  const raw = await _teaserLLM({ system, user });
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    return { ok: false, error: `LLM returned non-JSON: ${e.message}`, raw: raw.slice(0, 400) };
  }

  /* Persist the storyboard so subsequent steps + the operator can reference. */
  const runId = _newRunId();
  const dir = await _teaserDir(runId);
  const fsp = await import("node:fs/promises");
  const path2 = await import("node:path");
  const md = [
    `# Teaser storyboard — ${parsed.title || "(untitled)"}`,
    ``,
    `**Run:** \`${runId}\`  •  **Product:** ${product}  •  **Duration:** ${dur}s  •  **Platform:** ${platform}`,
    `**Influencer:** ${influencer}${tone ? `  •  **Tone:** ${tone}` : ""}`,
    ``,
    `## Hook`,
    parsed.hook || "(no hook)",
    ``,
    `## Beats`,
    ...((parsed.beats || []).flatMap((b, i) => [
      `### Beat ${i + 1} — ${b.time || "?"}`,
      `- **Visual:** ${b.visual || "(none)"}`,
      `- **VO:** ${b.voiceover || "(none)"}`,
      `- **On-screen:** ${b.on_screen_text || "(none)"}`,
      ``,
    ])),
    `## CTA`,
    parsed.cta || "(no CTA)",
    ``,
    `## Hero image prompt`,
    parsed.hero_prompt || "(no hero prompt)",
    ``,
  ].join("\n");
  await fsp.writeFile(path2.join(dir, "storyboard.md"), md);
  await fsp.writeFile(path2.join(dir, "meta.json"), JSON.stringify({
    run_id: runId, product, influencer, duration_s: dur, platform, tone,
    storyboard: parsed,
  }, null, 2));

  const spoken = [
    parsed.hook,
    ...(parsed.beats || []).map((b) => b.voiceover).filter(Boolean),
    parsed.cta,
  ].filter(Boolean).join(" ");

  return {
    ok: true,
    run_id: runId,
    title: parsed.title,
    duration_s: dur,
    platform,
    spoken,
    storyboard: parsed,
    hero_prompt: parsed.hero_prompt,
    folder: dir,
    next_step: "Ask the operator if they want to generate the hero image. If yes, call generate_teaser_image with the hero_prompt and run_id from this response.",
  };
}

/** Step 2 — image gen via fal.ai nano-banana/pro. Confirmation-gated.
 *  When `influencer` is set, switches to nano-banana-pro/edit and uses
 *  the locked influencer's canonical.png as a character reference so the
 *  hero shot features that specific face — same person across every piece
 *  of content from that channel. Without `influencer`, falls back to
 *  text-only nano-banana-pro (different face each call). */
async function generateTeaserImage({ prompt, aspect = "9:16", style = "", influencer = null, run_id = null, confirmed = false }) {
  if (!Fal.isConfigured()) return { ok: false, error: "FAL_KEY not configured. Add FAL_KEY=<key> to .env and restart the bridge." };
  if (!prompt) return { ok: false, error: "prompt is required" };

  const finalPrompt = style ? `${prompt}. ${style}` : prompt;
  const runId = run_id || _newRunId();
  const dir = await _teaserDir(runId);
  const path2 = await import("node:path");

  /* Resolve influencer slug → canonical.png URL. If the slug exists but
   * isn't locked yet (no canonical), fail with an instructive error so
   * the operator knows to lock first. If it doesn't exist at all, also
   * fail rather than silently fall back to text-only — operator named
   * a specific person and getting "generic Marcus" instead of "your Marcus"
   * is exactly the bug this whole feature exists to fix. */
  let characterUrl = null;
  let influencerName = null;
  if (influencer) {
    const inf = await Influencers.get(influencer);
    if (!inf) return { ok: false, error: `No influencer found at slug '${influencer}'. Create one with create_influencer first.`, run_id: runId };
    if (!inf.canonical) return { ok: false, error: `Influencer '${influencer}' has not been locked yet — call lock_influencer with a ref_idx first so the canonical face is set.`, run_id: runId };
    influencerName = inf.persona?.name || inf.slug;
    try {
      characterUrl = await Fal.upload(inf.canonical, { contentType: "image/png" });
    } catch (e) {
      return { ok: false, error: `fal-storage upload of canonical face failed: ${e.message}`, run_id: runId };
    }
  }

  const t0 = Date.now();
  let result;
  let retried = false;
  let originalPrompt = null;
  let saferPrompt = null;
  try {
    /* Two endpoints depending on whether we're conditioning on a face:
     *   - influencer set → fal-ai/nano-banana-pro/edit (image_urls + prompt)
     *     Same Google Gemini 3 Pro Image backbone, supports character +
     *     scene composition by passing the canonical face as a reference.
     *   - influencer not set → fal-ai/nano-banana-pro (text-only)
     *
     * Both wrapped with runImageWithSafetyRetry so an IP/celebrity safety
     * reject triggers an automatic prompt rewrite + one retry. */
    const baseInput = {
      prompt: finalPrompt,
      aspect_ratio: _aspectRatio(aspect),
      num_images: 1,
      resolution: "1K",
      safety_tolerance: "6",
    };
    const modelId = characterUrl ? "fal-ai/nano-banana-pro/edit" : "fal-ai/nano-banana-pro";
    const input = characterUrl
      ? { ...baseInput, image_urls: [characterUrl] }
      : { ...baseInput, enable_websearch: true };
    const wrapped = await Fal.runImageWithSafetyRetry(modelId, input, { timeoutMs: 90_000, rephrase: _rephrasePromptForSafety });
    result = wrapped.result;
    retried = wrapped.retried;
    originalPrompt = wrapped.originalPrompt || null;
    saferPrompt = wrapped.saferPrompt || null;
  } catch (e) {
    const which = characterUrl ? "nano-banana-pro/edit" : "nano-banana-pro";
    return { ok: false, error: `fal ${which} failed: ${e.message}`, run_id: runId };
  }
  const elapsed = Date.now() - t0;

  /* fal returns { images: [{ url, content_type, ... }], ... }; some models
   * use `image` (singular) — handle both. */
  const imgUrl = result?.images?.[0]?.url || result?.image?.url || null;
  if (!imgUrl) {
    return { ok: false, error: "fal returned no image URL", raw: JSON.stringify(result).slice(0, 400), run_id: runId };
  }

  const imgPath = path2.join(dir, "hero.png");
  await Fal.download(imgUrl, imgPath);

  broadcastToClients({
    type: "teaser.image_ready",
    data: { run_id: runId, imagePath: imgPath, prompt: finalPrompt, aspect, elapsed_ms: elapsed, influencer: influencer || null },
  });
  _openLocal(imgPath);

  /* Compose the next-step hint conditional on what just happened — covers
   * the safety-rephrase + influencer-conditioned cases without spamming
   * boilerplate when neither applies. */
  let nextStep;
  if (retried) {
    nextStep = "Image generated with an auto-rephrased prompt (the original tripped the safety filter on a brand or celebrity name). Tell the operator briefly that you adjusted the wording, then ask if they want to animate or regenerate.";
  } else if (influencerName) {
    nextStep = `Image generated using ${influencerName}'s locked face — that's their canonical character now in the scene. Ask the operator if they want to animate this clip or regenerate with a different prompt.`;
  } else {
    nextStep = "Ask the operator if they want to animate this image into a video, or if they'd like to regenerate with a refined prompt.";
  }

  return {
    ok: true,
    run_id: runId,
    imagePath: imgPath,
    prompt: retried ? saferPrompt : finalPrompt,
    aspect,
    influencer: influencer || null,
    influencer_name: influencerName,
    elapsed_ms: elapsed,
    fal_request_id: result?.request_id || null,
    safety_rephrase: retried ? { original: originalPrompt, used: saferPrompt } : null,
    next_step: nextStep,
  };
}

/** Step 3 — image-to-video via fal.ai Hailuo. Confirmation-gated. */
async function animateTeaserImage({ run_id, motion_prompt, duration_s = 5, confirmed = false }) {
  if (!Fal.isConfigured()) return { ok: false, error: "FAL_KEY not configured. Add FAL_KEY=<key> to .env and restart the bridge." };
  if (!run_id) return { ok: false, error: "run_id is required (returned by generate_teaser_image)" };
  if (!motion_prompt) return { ok: false, error: "motion_prompt is required (e.g. 'camera pushes in slowly')" };

  const path2 = await import("node:path");
  const dir = path2.join(Paths.getOutputDir(), "teasers", run_id);
  const imgPath = path2.join(dir, "hero.png");
  const fsp = await import("node:fs/promises");
  let imgBytes;
  try { imgBytes = await fsp.readFile(imgPath); }
  catch { return { ok: false, error: `hero.png not found in ${dir}. Generate the image first via generate_teaser_image.` }; }

  /* Send image as base64 data URI — happy-horse accepts that as image_url
   * and we skip the fal-storage upload round-trip. ~1.4MB image → ~1.9MB
   * request body, well under any sensible request cap. */
  const dataUri = `data:image/png;base64,${imgBytes.toString("base64")}`;
  /* happy-horse duration: hard cap 15 seconds (operator-confirmed), floor
   * 5 seconds. Default 5 because the teaser flow is "show me a snippet"
   * not "render the whole ad" — operator has to explicitly ask for longer. */
  const dur = Math.max(5, Math.min(15, Math.round(duration_s)));

  const t0 = Date.now();
  let result;
  try {
    /* Model: https://fal.ai/models/alibaba/happy-horse/image-to-video
     * Input shape verified against the operator's AI-Custom-Cards
     * test-video-models.ts production code:
     *   - duration is numeric (NOT "5s" string)
     *   - resolution defaults to 1080p ($0.28/s) — pin to 720p ($0.14/s)
     *     for parity with the Card Genie production cost model unless the
     *     operator explicitly wants 1080p. */
    const job = await Fal.submit("alibaba/happy-horse/image-to-video", {
      prompt: motion_prompt,
      image_url: dataUri,
      duration: dur,
      resolution: "720p",
    });
    /* Poll every 3s, max 60 attempts (3 minutes). Hailuo standard typically
     * finishes within 60-90s; the headroom catches occasional queue spikes. */
    result = await job.poll(3000, 60);
  } catch (e) {
    return { ok: false, error: `fal Hailuo failed: ${e.message}`, run_id };
  }
  const elapsed = Date.now() - t0;

  const vidUrl = result?.video?.url || result?.videos?.[0]?.url || null;
  if (!vidUrl) {
    return { ok: false, error: "fal returned no video URL", raw: JSON.stringify(result).slice(0, 400), run_id };
  }

  const vidPath = path2.join(dir, "clip.mp4");
  await Fal.download(vidUrl, vidPath);

  broadcastToClients({
    type: "teaser.video_ready",
    data: { run_id, videoPath: vidPath, motion_prompt, duration_s: dur, elapsed_ms: elapsed },
  });
  _openLocal(vidPath);

  return {
    ok: true,
    run_id,
    videoPath: vidPath,
    motion_prompt,
    duration_s: dur,
    elapsed_ms: elapsed,
    fal_request_id: result?.request_id || null,
    next_step: "Video saved + opened in Preview/QuickTime. The full teaser is in " + dir,
  };
}

/* ─────────────────────────── INFLUENCER PIPELINE ───────────────────────────
 *
 *  create_influencer  →  lock_influencer  →  recreate_video_with_influencer
 *
 *  These wrap the Influencers module + VideoDownload + a Kling Motion Control
 *  fal call, plus a HUD-modal coordination protocol for the recreation flow's
 *  source-video step (URL paste OR local file drop). The modal handshake uses
 *  WebSocket events on top of the existing broadcastToClients channel, with
 *  a pending-request map keyed by an opaque request_id so the operator can
 *  cancel a stuck modal without leaking promises.
 */

/** Tool wrapper around Influencers.create — adds the broadcast that pops the
 *  HUD picker modal and the local-Preview opens so the operator can pick a
 *  reference via either path (per the build decision). */
async function createInfluencerTool(args) {
  /* Pass the safety-rephrase callback so an IP/brand-name reject triggers
   * an auto-rewrite + retry instead of failing the influencer-create flow. */
  const result = await Influencers.create({ ...(args || {}), rephrase: _rephrasePromptForSafety });
  if (!result?.ok) return result;

  /* Open every reference in macOS Preview so the operator can click-through
   * the photos with arrow keys. The HUD modal also gets a copy via the
   * broadcast below — both surfaces stay in sync because they both read
   * the same files on disk. */
  for (const ref of result.refs || []) _openLocal(ref.path);

  /* HUD picker modal payload. file:// URIs let the modal render the PNGs
   * via standard <img src> without a static-file route. */
  broadcastToClients({
    type: "influencer.refs_ready",
    data: {
      slug: result.slug,
      name: result.persona?.name || result.slug,
      refs: (result.refs || []).map((r) => ({ idx: r.idx, path: r.path, fileUri: `file://${r.path}` })),
    },
  });

  return {
    ok: true,
    slug: result.slug,
    refs: (result.refs || []).map((r) => ({ idx: r.idx, path: r.path })),
    next_step: result.next_step,
    spoken: `${result.refs?.length || 0} references ready for ${result.persona?.name || result.slug}. Which one shall I lock — one, two${(result.refs?.length || 0) >= 3 ? ", or three" : ""}?`,
  };
}

/** Tool wrapper around Influencers.lock — fires a broadcast so the HUD can
 *  dismiss the picker modal and update any "active influencer" pill. */
async function lockInfluencerTool(args) {
  const result = await Influencers.lock(args || {});
  if (!result?.ok) return result;
  broadcastToClients({
    type: "influencer.locked",
    data: {
      slug: result.slug,
      canonical: result.canonical,
      canonicalFileUri: `file://${result.canonical}`,
      name: result.persona?.name || result.slug,
    },
  });
  return {
    ok: true,
    slug: result.slug,
    canonical: result.canonical,
    next_step: `Locked. ${result.persona?.name || result.slug} is ready to use — say 'recreate this <platform> video using ${result.persona?.name || result.slug}' to drive their face with a reference clip.`,
  };
}

/* ---------- HUD modal coordination for source-video paste/drop ---------- *
 * recreate_video_with_influencer can be called without a source. When it is,
 * the bridge opens a HUD modal asking the operator for a URL or local file,
 * then waits up to 5 minutes for them to respond. The operator's response
 * arrives as a WS message ({ type: "influencer.source_provided", data: {…} })
 * which resolves a pending Promise stored here. */
const _pendingSourceRequests = new Map(); /* request_id → { resolve, reject, timer } */
const SOURCE_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

/** Open the HUD modal and wait for the operator to provide a video source.
 *  Resolves with { source_url? , source_local_path? } or rejects on timeout
 *  / explicit cancel. */
function _requestSourceFromHud({ slug, influencerName }) {
  return new Promise((resolve, reject) => {
    const requestId = `srcreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      _pendingSourceRequests.delete(requestId);
      broadcastToClients({ type: "influencer.source_request_cancelled", data: { request_id: requestId, reason: "timeout" } });
      reject(new Error(`Operator did not provide a source video within ${SOURCE_REQUEST_TIMEOUT_MS / 60000} minutes.`));
    }, SOURCE_REQUEST_TIMEOUT_MS);
    _pendingSourceRequests.set(requestId, { resolve, reject, timer });
    broadcastToClients({
      type: "influencer.source_requested",
      data: { request_id: requestId, slug, influencerName, timeoutMs: SOURCE_REQUEST_TIMEOUT_MS },
    });
  });
}

/** Called by the WebSocket handler when the HUD posts back the source.
 *  Public so it can be reached from the WS message dispatcher. */
export function resolvePendingSourceRequest({ request_id, source_url, source_local_path, cancelled }) {
  const pending = _pendingSourceRequests.get(request_id);
  if (!pending) return false;
  _pendingSourceRequests.delete(request_id);
  clearTimeout(pending.timer);
  if (cancelled) {
    pending.reject(new Error("Operator cancelled the source request."));
    return true;
  }
  pending.resolve({ source_url: source_url || null, source_local_path: source_local_path || null });
  return true;
}

/** Generate a unique recreation run id (mirrors _newRunId for teasers). */
function _newRecreationId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Step 3 of the influencer pipeline — drives the canonical face with a
 *  reference video via fal.ai's Kling Motion Control v3 Pro. Confirmation-
 *  gated. Handles the no-source case by opening the HUD modal and waiting
 *  for the operator to paste a URL or drop a local file. */
async function recreateVideoWithInfluencer({ slug, source_url = null, source_local_path = null, prompt = "", character_orientation = "video", confirmed = false }) {
  if (!Fal.isConfigured()) return { ok: false, error: "FAL_KEY not configured. Add FAL_KEY=<key> to .env and restart the bridge." };
  if (!slug) return { ok: false, error: "slug is required (the locked influencer to use)" };

  const inf = await Influencers.get(slug);
  if (!inf) return { ok: false, error: `No influencer found for slug '${slug}'. Create one with create_influencer first.` };
  if (!inf.canonical) return { ok: false, error: `Influencer '${slug}' has not been locked yet. Call lock_influencer with a ref_idx to set their canonical face.` };

  /* If the operator didn't provide a source, ask the HUD for one. We do
   * this AFTER the confirmation gate (which the framework already handled
   * before reaching us when confirmed:true) but BEFORE the fal call so we
   * never spend money on an incomplete request. */
  if (!source_url && !source_local_path) {
    try {
      const provided = await _requestSourceFromHud({ slug: inf.slug, influencerName: inf.persona?.name || inf.slug });
      source_url = provided.source_url;
      source_local_path = provided.source_local_path;
    } catch (e) {
      return { ok: false, error: e.message, slug };
    }
    if (!source_url && !source_local_path) {
      return { ok: false, error: "No source video provided.", slug };
    }
  }

  const runId = _newRecreationId();
  const path2 = await import("node:path");
  const fsp = await import("node:fs/promises");
  const dir = path2.join(Paths.getOutputDir(), "recreations", runId);
  await fsp.mkdir(dir, { recursive: true });

  /* Resolve the source: if a URL, download via yt-dlp; otherwise copy the
   * local path into the run dir so the run is self-contained. */
  let sourcePath;
  if (source_local_path) {
    sourcePath = path2.join(dir, "source.mp4");
    try { await fsp.copyFile(source_local_path, sourcePath); }
    catch (e) { return { ok: false, error: `Could not read local source: ${e.message}`, slug, run_id: runId }; }
  } else {
    if (!VideoDownload.looksDownloadable(source_url)) {
      return { ok: false, error: `'${source_url}' doesn't look like a downloadable video URL.`, slug, run_id: runId };
    }
    sourcePath = path2.join(dir, "source.mp4");
    try { await VideoDownload.download(source_url, sourcePath); }
    catch (e) { return { ok: false, error: e.message, slug, run_id: runId }; }
  }

  /* Upload character image + source video to fal-storage so Kling can fetch
   * them via hosted URLs. Earlier iterations passed data URIs for both —
   * worked for the image (small) but Kling Motion Control returned 422 on
   * the video data URI in practice (despite being documented as accepted).
   * Hosted URLs are the reliable path. Fal.upload handles initiate + PUT. */
  let charUrl, srcUrl;
  try {
    [charUrl, srcUrl] = await Promise.all([
      Fal.upload(inf.canonical, { contentType: "image/png" }),
      Fal.upload(sourcePath,    { contentType: "video/mp4" }),
    ]);
  } catch (e) {
    return { ok: false, error: `fal-storage upload failed: ${e.message}`, slug, run_id: runId };
  }

  const srcStat = await fsp.stat(sourcePath);
  broadcastToClients({
    type: "influencer.recreation_started",
    data: { run_id: runId, slug: inf.slug, sourcePath, sourceBytes: srcStat.size },
  });

  const t0 = Date.now();
  let result;
  try {
    /* Model: https://fal.ai/models/fal-ai/kling-video/v3/pro/motion-control
     * Required inputs: image_url, video_url, character_orientation.
     *   character_orientation: "image" (max 10s, follows image; camera-move use case)
     *                       OR "video" (max 30s, follows video; body-motion / dance use case)
     * Default to "video" because the operator's primary use case is recreating
     * TikTok dance / motion clips with the influencer's face — body-motion driven,
     * which the docs explicitly recommend "video" for. Operators who want a
     * camera-move replication can override via args. Optional: prompt. */
    const job = await Fal.submit("fal-ai/kling-video/v3/pro/motion-control", {
      image_url: charUrl,
      video_url: srcUrl,
      character_orientation: character_orientation === "image" ? "image" : "video",
      prompt: prompt || "",
    });
    /* Kling typically completes in 60-180s for short clips. 5s poll, 80
     * attempts = 6m40s ceiling — generous to cover queue spikes without
     * wedging the bridge thread on a stuck job. */
    result = await job.poll(5000, 80);
  } catch (e) {
    return { ok: false, error: `Kling Motion Control failed: ${e.message}`, slug, run_id: runId };
  }
  const elapsed = Date.now() - t0;

  const outUrl = result?.video?.url || result?.videos?.[0]?.url || null;
  if (!outUrl) {
    return { ok: false, error: "Kling returned no video URL", raw: JSON.stringify(result).slice(0, 400), slug, run_id: runId };
  }
  const outPath = path2.join(dir, "output.mp4");
  await Fal.download(outUrl, outPath);

  /* Persist a meta record so the operator can find the run later via the
   * HUD's recreations list (and so we have a paper trail of which source
   * + which influencer produced which output). */
  await fsp.writeFile(path2.join(dir, "meta.json"), JSON.stringify({
    run_id: runId,
    slug: inf.slug,
    influencer_name: inf.persona?.name || inf.slug,
    source_url: source_url || null,
    source_local_path: source_local_path || null,
    prompt,
    elapsed_ms: elapsed,
    fal_request_id: result?.request_id || null,
    created_at: new Date().toISOString(),
  }, null, 2));

  broadcastToClients({
    type: "influencer.recreation_ready",
    data: { run_id: runId, slug: inf.slug, outputPath: outPath, elapsed_ms: elapsed },
  });
  _openLocal(outPath);

  return {
    ok: true,
    slug: inf.slug,
    run_id: runId,
    outputPath: outPath,
    elapsed_ms: elapsed,
    fal_request_id: result?.request_id || null,
    next_step: `Recreation done — ${path2.basename(outPath)} is open in QuickTime. Saved to ${dir}.`,
  };
}

/* ---------- WEBSOCKET SERVER ---------- */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

/* PROJECT_ROOT is declared near the top of this file now (boot summary needs it).
 * Re-imports from the same module are idempotent, so no second declaration here. */

const httpServer = createServer(async (req, res) => {
  /* Sprint 12 — access log. Every request emits one line at end-of-response
   * with: method, URL, status, response time, remote port (differentiates
   * per-tab connections), and a CACHE tag for /diary + /healthz so we can
   * see hit/miss/coalesce at a glance. Filter via:
   *   tail -f /tmp/jarvis-bridge.log | grep "\[http\]"
   * Skipped: noisy /perf POSTs and /log relay (HUD's own debug channel).
   *
   * The remote port is the strongest "which tab" signal we have without
   * cookies — Chrome opens distinct TCP connections per tab for HTTP/1.1
   * requests, so two tabs polling the same endpoint show different ports. */
  const _httpStart = Date.now();
  const _remotePort = req.socket?.remotePort || 0;
  const _origUrl = req.url || "";
  const _logIfNoisy = !["/perf", "/log"].some((p) => _origUrl.startsWith(p));
  res.on("finish", () => {
    if (!_logIfNoisy) return;
    const dur = Date.now() - _httpStart;
    /* Highlight slow requests (>500ms) so they pop visually when scanning. */
    const tag = dur > 1000 ? "SLOW " : dur > 500 ? "warn " : "     ";
    console.log(`[http] ${tag}${req.method} ${_origUrl.padEnd(40)} ${res.statusCode} ${dur}ms  port=${_remotePort}`);
  });

  // CORS for everything — HUD on :8765 talks to bridge on :8766
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Preflight: respond immediately with 204 so browsers proceed with the real request
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Browser-side debug logging — voice.js POSTs JSON, we print to bridge log
  if (req.url === "/log" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        console.log(`[hud] ${j.tag || "log"}: ${j.msg || ""} ${JSON.stringify(j.data || {})}`);
      } catch { console.log(`[hud] raw: ${body}`); }
      res.writeHead(204); res.end();
    });
    return;
  }

  /* Voice-pipeline performance marks — voice.js posts a summary after each
   * cycle. Bridge keeps a rolling 50-entry buffer so /health/timings can
   * compute median + p95 per stage AND persists each row to a per-day
   * session log under data/audit/sessions/ for /health/sessions
   * aggregation + the diagnostic ZIP exporter. */
  if (req.url === "/perf" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        _perfBuffer.push(j);
        if (_perfBuffer.length > 50) _perfBuffer.shift();
        /* Persist a sanitised row to the daily session log. Best-effort —
         * filesystem errors are swallowed so a write failure can't take
         * down the voice loop. Privacy: ONLY the spans + truncated heard
         * text are persisted, never tool args / LLM replies / sensitive
         * info. The diagnostic exporter is the only path that ever sends
         * these rows off-device. */
        Sessions.recordTurn({
          ts: j.ts,
          heard: j.heard,
          voiceToWhisperMs: j.spans?.voice_to_whisper,
          whisperInferenceMs: j.spans?.whisper_inference,
          voiceToAudioMs: j.spans?.voice_to_audio,
        });
      } catch {}
      res.writeHead(204); res.end();
    });
    return;
  }
  /* GET /health/sessions — last 7 days of per-day session aggregates.
   * Used by the settings panel debug view + diagnostic snapshot. */
  if (req.url?.startsWith("/health/sessions") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days")) || 7));
    const summary = await Sessions.getDailySummary({ days });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, days, summary }));
    return;
  }
  /* POST /tool-dispatch — fire a tool by name without going through the LLM.
   * Used by HUD click handlers (inbox row click → act_on_inbox_item open)
   * where the operator's intent is already explicit and an LLM round-trip
   * would just add latency. Allowlisted to NON-DESTRUCTIVE tools so a
   * stray POST can't draft an email or place a purchase without the voice
   * confirmation gate. */
  if (req.url === "/tool-dispatch" && req.method === "POST") {
    const SAFE_TOOLS = new Set(["act_on_inbox_item", "smart_inbox_briefing", "list_reminders", "workspace_insights"]);
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const name = String(parsed.name || "");
      if (!SAFE_TOOLS.has(name)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `tool "${name}" not in HUD-click allowlist` }));
        return;
      }
      const result = await executeTool(name, parsed.args || {});
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  /* GET /inbox — Smart Inbox aggregate for the HUD panel. Returns the
   * normalised item list + source counts. The HUD polls every ~5min;
   * the briefing tool fires its own (cached) aggregate when the
   * operator asks for triage. */
  if (req.url?.startsWith("/inbox") && req.method === "GET") {
    /* Sprint 12 — hard timeout + cache + in-flight dedup. Inbox aggregator
     * fans out to Mail/Calendar/Reminders via AppleScript; one of those
     * occasionally hangs for 120s when macOS Mail is mid-sync or a privacy
     * prompt is pending. That used to park a connection slot for the whole
     * 120s, cascading into other endpoints. Now: 8s hard timeout, fall back
     * to stale cache body on timeout, 60s TTL on success cache. */
    const url = new URL(req.url, "http://localhost");
    const force = url.searchParams.get("force") === "1";
    const NOW = Date.now();
    if (!force && _inboxCache && (NOW - _inboxCache.ts) < 60_000) {
      console.log(`[cache] inbox HIT (age=${NOW - _inboxCache.ts}ms)`);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(_inboxCache.body);
      return;
    }
    if (!_inboxInFlight) {
      console.log(`[cache] inbox MISS — starting Inbox.aggregate (8s cap)`);
      const _t = Date.now();
      _inboxInFlight = Promise.race([
        Inbox.aggregate({ days: 1, mailMax: 15, force }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("inbox timeout 8s")), SLOW_TIMEOUT_MS)),
      ]).finally(() => {
        console.log(`[cache] inbox fanout finished in ${Date.now() - _t}ms`);
        _inboxInFlight = null;
      });
    } else {
      console.log(`[cache] inbox COALESCE — joining in-flight`);
    }
    try {
      const result = await _inboxInFlight;
      const body = JSON.stringify({ ok: true, ...result });
      _inboxCache = { ts: Date.now(), body };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    } catch (e) {
      /* Timeout or aggregate threw — serve stale cache if any, else empty. */
      if (_inboxCache) {
        console.warn(`[cache] inbox FAIL (${e.message}) — serving stale cache`);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(_inboxCache.body);
      } else {
        console.warn(`[cache] inbox FAIL (${e.message}) — no cache, returning empty`);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: String(e.message), items: [], counts: {} }));
      }
    }
    return;
  }
  /* GET /workspaces/<slug>/insights — per-workspace stats for the switcher
   * modal's expand-row affordance. Cheap (six COUNT queries on indexed
   * workspace_id columns). */
  {
    const m = req.url?.match(/^\/workspaces\/([a-z][a-z0-9-]{1,40})\/insights$/);
    if (m && req.method === "GET") {
      const insights = Workspaces.insights(m[1]);
      if (!insights) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `workspace "${m[1]}" not found` }));
      } else {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, ...insights }));
      }
      return;
    }
  }
  /* PATCH /workspaces/<slug> — update workspace fields in place (handbook,
   * description, voice, etc). Used by the in-HUD handbook editor + future
   * settings flows that don't go through the voice layer. Body is the
   * subset of editable fields; the bridge merges with the existing row. */
  {
    const m = req.url?.match(/^\/workspaces\/([a-z][a-z0-9-]{1,40})$/);
    if (m && req.method === "PATCH") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const patch = JSON.parse(body || "{}");
        const updated = Workspaces.update(m[1], patch);
        broadcastToClients({ type: "workspace.updated", data: updated });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, workspace: updated }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
      return;
    }
  }
  /* GET /workspaces — list all workspaces + active slug. Used by the HUD's
   * workspace switcher in Settings. */
  if (req.url === "/workspaces" && req.method === "GET") {
    const workspaces = Workspaces.list();
    const active = Workspaces.getActive();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, workspaces, activeSlug: active?.slug || null }));
    return;
  }
  /* POST /workspaces/active — set or clear the active workspace.
   * Body: { slug: string | null }. Re-asserted by the HUD on every connect
   * so a bridge restart preserves the operator's chosen scope. */
  /* GET /api/asset-panel/history — last 3 teaser runs for the history strip.
   * Lightweight: just disk metadata + the prompt from meta.json. */
  if (req.url === "/api/asset-panel/history" && req.method === "GET") {
    const rows = await _listTeaserRuns(3);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, items: rows }));
    return;
  }
  /* POST /api/asset-panel/open — open a generated asset in the OS default app
   * (Preview / QuickTime). Validates that the path is inside output/. */
  if (req.url === "/api/asset-panel/open" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const p = String(parsed.path || "");
      if (!p.includes("/output/")) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "path must be under output/" })); return; }
      await execp(`open ${JSON.stringify(p)}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  /* POST /api/asset-panel/copy-to-clipboard — uses pbcopy via osascript for
   * image files. Videos can't be put on the macOS clipboard so we return
   * an error for those. */
  if (req.url === "/api/asset-panel/copy-to-clipboard" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const p = String(parsed.path || "");
      if (!p.includes("/output/")) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "path must be under output/" })); return; }
      const ext = p.split(".").pop()?.toLowerCase();
      if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
        /* AppleScript: load file as a picture and put on the clipboard. PNG/JPEG only. */
        const script = `set the clipboard to (read (POSIX file ${JSON.stringify(p)}) as ${ext === "png" ? "«class PNGf»" : "JPEG picture"})`;
        await execp(`osascript -e ${JSON.stringify(script)}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: `clipboard copy not supported for .${ext}` }));
      }
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  /* POST /api/asset-panel/animate — fires animate_teaser_image on the supplied
   * run_id. Returns immediately; the panel updates when the resulting
   * teaser.video_ready broadcast arrives. */
  if (req.url === "/api/asset-panel/animate" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      if (!parsed.run_id) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "run_id required" })); return; }
      /* Fire-and-forget: don't await — let the broadcast handle the UI update. */
      animateTeaserImage({ run_id: parsed.run_id, motion_prompt: parsed.motion_prompt || "cinematic motion, confident on-camera energy", duration_s: 5, confirmed: true })
        .then((r) => { if (r?.ok) broadcastToClients({ type: "teaser.video_ready", data: { run_id: r.run_id, clipPath: r.clip_path } }); })
        .catch((e) => console.warn(`[asset-panel] animate failed: ${e.message}`));
      res.writeHead(200); res.end(JSON.stringify({ ok: true, accepted: true }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  /* POST /api/asset-panel/regenerate — re-fire generate_teaser_image with an
   * edited prompt, reusing the same run_id (overwrites hero.png in place). */
  if (req.url === "/api/asset-panel/regenerate" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      if (!parsed.prompt) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "prompt required" })); return; }
      generateTeaserImage({ prompt: parsed.prompt, aspect: parsed.aspect || "9:16", influencer: parsed.influencer || null, run_id: parsed.run_id || null, confirmed: true })
        .catch((e) => console.warn(`[asset-panel] regenerate failed: ${e.message}`));
      res.writeHead(200); res.end(JSON.stringify({ ok: true, accepted: true }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  /* POST /api/weather-panel/refresh — force a weather refresh and rebroadcast. */
  if (req.url === "/api/weather-panel/refresh" && req.method === "POST") {
    try {
      const w = await getWeather(undefined, undefined, 6, { force: true });
      const data = { ...w, location: { name: CONFIG.operator.city, country: CONFIG.operator.country } };
      broadcastToClients({ type: "weather.update", data });
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  /* POST /api/screenshot-panel/open — open in Preview.app. */
  if (req.url === "/api/screenshot-panel/open" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const p = String(parsed.path || "");
      if (!p) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "path required" })); return; }
      await execp(`open ${JSON.stringify(p)}`);
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  /* POST /api/screenshot-panel/copy-to-clipboard — same AppleScript image-clip
   * trick as the asset panel. PNG only (screenshots are PNG). */
  if (req.url === "/api/screenshot-panel/copy-to-clipboard" && req.method === "POST") {
    let body = ""; for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const p = String(parsed.path || "");
      if (!p) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "path required" })); return; }
      const script = `set the clipboard to (read (POSIX file ${JSON.stringify(p)}) as «class PNGf»)`;
      await execp(`osascript -e ${JSON.stringify(script)}`);
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }
  /* POST /api/influencer/pipeline/start — wizard's GO button calls this.
   * Returns immediately with the synthetic runId; the orchestrator runs in
   * the background and emits influencer.pipeline.update events via WS. */
  if (req.url === "/api/influencer/pipeline/start" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body || "{}"); }
    catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "invalid JSON body" })); return; }
    const r = await executeTool("start_influencer_pipeline", {
      sex: parsed.sex,
      vibe: parsed.vibe,
      content_type: parsed.contentType,
      source_url: parsed.sourceUrl || undefined,
    });
    res.writeHead(r?.ok ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(r));
    return;
  }
  /* POST /api/news/refresh — manual refresh of the news cache, triggered by the
   * panel's refresh button. Re-fetches all four sources and re-broadcasts the
   * cache so the panel updates without reloading the YouTube iframe. */
  if (req.url === "/api/news/refresh" && req.method === "POST") {
    try {
      const next = await News.refresh();
      broadcastToClients({ type: "news.update", data: next });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  /* POST /api/visual/analyse — HUD drag-and-drop endpoint.
   *
   * Body: raw image/video bytes. Filename in ?name=<encoded> query param.
   *
   * Drag-and-drop is intent enough — we skip the existing inbox-watcher
   * "want me to look at it?" verbal confirmation and run describe_image
   * immediately. Folder-watch path in inbox/ stays for Finder-based drops
   * where the operator may not be looking at the HUD.
   *
   * Files land in data/visual-drops/<date>/ rather than inbox/ so the
   * watcher does not double-fire. resolveSafePath in Vision.describeImage
   * accepts paths under PROJECT_DIR; data/ is inside that. */
  if (req.url.startsWith("/api/visual/analyse") && req.method === "POST") {
    try {
      const url = new URL(req.url, "http://localhost");
      const rawName = url.searchParams.get("name") || "drop.bin";
      /* Sanitise: strip directory traversal, keep alnum + dot + dash + underscore. */
      const safeName = rawName.replace(/[^\w.\- ]/g, "_").slice(0, 100);
      const fsp = await import("node:fs/promises");
      const today = new Date().toISOString().slice(0, 10);
      /* Saved under output/ rather than data/ so the bridge's existing
       * /output/* static handler can serve the thumbnail back to the HUD
       * without a new file-serving endpoint. */
      const dropDir = path.resolve(PROJECT_ROOT, "output", "visual-drops", today);
      await fsp.mkdir(dropDir, { recursive: true });
      const ts = Date.now();
      const dest = path.join(dropDir, `${ts}-${safeName}`);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await fsp.writeFile(dest, Buffer.concat(chunks));
      /* Relative path inside PROJECT_DIR — what Vision.describeImage expects. */
      const relPath = path.relative(PROJECT_ROOT, dest);
      const result = await Vision.describeImage({ path: relPath });
      /* Broadcast so any future visual-result panel can subscribe rather than
       * the HUD having to round-trip the response. */
      broadcastToClients({ type: "visual.analysed", data: { path: relPath, ...result } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  if (req.url === "/workspaces/active" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const w = Workspaces.setActive(parsed.slug ?? null);
      applyWorkspaceOverrides(w);
      broadcastToClients({ type: "workspace.switched", data: w });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, workspace: w }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  /* GET /health/crashes — recent unhandled-exception rows captured by
   * crash-reporter.mjs. Sanitised at write time (api keys, $HOME paths,
   * sk-style tokens redacted). Used by the Settings → Diagnostics panel
   * + the diagnostic ZIP exporter. */
  if (req.url?.startsWith("/health/crashes") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get("days")) || 7));
    const rows = CrashReporter.recent({ days });
    const summary = CrashReporter.summary({ days });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, days, summary, rows: rows.slice(0, 20) }));
    return;
  }
  /* GET /health/warnings — current bridge-detected misconfigurations.
   * Used by the HUD on initial page load (in case it was already up before
   * the WS connected) and by the diagnostic exporter. */
  if (req.url === "/health/warnings" && req.method === "GET") {
    const warnings = SystemWarnings.list();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, warnings }));
    return;
  }
  /* POST /diagnostics/export — runs tools/diagnose.sh --no-email and
   * returns the path to the generated tarball. Operator-initiated only;
   * the bundle drops on the Desktop and is NEVER auto-emailed. */
  if (req.url === "/diagnostics/export" && req.method === "POST") {
    try {
      const scriptPath = path.join(PROJECT_ROOT, "tools", "diagnose.sh");
      const { stdout, stderr } = await execp(`"${scriptPath}" --no-email`, { maxBuffer: 4 * 1024 * 1024 });
      /* The script's "→ /Users/.../jarvis-diag-<stamp>.tgz" line is the
       * artifact path; pull it out of stdout for the response. */
      const m = String(stdout).match(/→\s*(\S+\.tgz)/);
      const outPath = m ? m[1] : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: outPath, stdout: String(stdout).slice(-2000), stderr: String(stderr).slice(-1000) }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  if (req.url === "/health/plugins" && req.method === "GET") {
    /* Read-only registry view — name + version + tools + required env per
     * plugin. Used by settings / docs / debug surfaces. */
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, plugins: PluginLoader.status() }));
    return;
  }
  /* GET /weather — same payload as the WebSocket weather request, but
   * over HTTP so the boot greeting / settings panel / docs can fetch
   * synchronously without a WS dance. Returns { now, forecast, label }
   * where label is the human-readable WMO code translation. */
  if (req.url === "/weather" && req.method === "GET") {
    const w = await getWeather();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: !w.error,
      ...w,
      label: w.now ? wmoLabel(w.now.code) : null,
    }));
    return;
  }
  if (req.url === "/health/timings" && req.method === "GET") {
    /* Compute p50 + p95 per span from the rolling buffer. Skip null spans. */
    const summarise = (key) => {
      const vals = _perfBuffer.map(p => p.spans?.[key]).filter((v) => typeof v === "number" && v >= 0).sort((a, b) => a - b);
      if (!vals.length) return null;
      const pct = (q) => vals[Math.min(vals.length - 1, Math.floor(vals.length * q))];
      return { p50: pct(0.5), p95: pct(0.95), n: vals.length };
    };
    const KEYS = [
      "voice_to_recend","voice_to_whisper","whisper_roundtrip","whisper_inference","voice_to_audio",
      /* Sprint 11 — finer-grained spans that isolate each pipeline stage.
       * recend_to_audio is the headline "feels-real-time" metric. */
      "recend_to_audio","recend_to_whisper","whisper_to_llm","llm_thinking","tts_synth",
    ];
    const out = {};
    for (const k of KEYS) out[k] = summarise(k);
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, samples: _perfBuffer.length, spans: out, recent: _perfBuffer.slice(-10) }));
    return;
  }

  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      model: getModel(),
      toolCount: TOOLS.length,
      toolRouter: ToolRouter.indexStatus(),
    }));
    return;
  }

  /* GET /code-agent/audit — recent code_agent_run rows. Read-only; the
   * Agent Console renders these as a "what scripts has Jarvis run for me"
   * panel. Honours ?limit=N (default 20, max 200). */
  if (req.url?.startsWith("/code-agent/audit") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 20));
    const runs = await CodeAgent.recentRuns({ limit });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, runs }));
    return;
  }

  /* GET /knowledge/status — counts + last ingest time + listed documents.
   * Used by the Agent Console section to render the indexed-documents
   * pane. */
  if (req.url?.startsWith("/knowledge/status") && req.method === "GET") {
    /* Field names: stats.documents is the COUNT, the array of doc rows
     * goes under .docs to avoid the collision. */
    const stats = Memory.knowledgeStats();
    const docs = Memory.listDocuments({ limit: 100 });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      documentCount: stats.documents,
      chunks: stats.chunks,
      embedded: stats.embedded,
      lastIngestAt: stats.lastIngestAt,
      root: Knowledge.knowledgeRoot(),
      docs,
    }));
    return;
  }

  /* GET /imessage/status — diagnostic for the inbound iMessage poller.
   * Surfaces whether the listener is running, whether the operator has
   * opted in via data/imessage-config.json, the allowlist size, and
   * whether chat.db is readable (Full Disk Access proxy). */
  if (req.url === "/imessage/status" && req.method === "GET") {
    const status = await IMessageListener.status();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...status }));
    return;
  }

  /* POST /imessage/config — persist new listener config from the settings
   * modal. Body: { enabled, allowedSenders[], trigger, pollIntervalMs }.
   * Saved to data/imessage-config.json which the poll loop re-reads each
   * tick — change takes effect within one poll interval, no restart. */
  if (req.url === "/imessage/config" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      let parsed;
      try { parsed = JSON.parse(body); }
      catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `bad json: ${e.message}` }));
        return;
      }
      try {
        const saved = await IMessageListener.saveConfig(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, config: saved }));
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  /* GET /crew/concurrency — provider in-flight + queue snapshot. Useful
   * for debugging "why is this crew taking forever" when ollama agents
   * are queueing serially behind a single GPU slot. */
  if (req.url === "/crew/concurrency" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...Crew.concurrencyStatus() }));
    return;
  }

  /* GET /usage — today/week token + cost rollups, plus recent calls.
   * Read-only; the Agent Console renders the today bucket as a budget
   * dial and the recent list as a paged scroll. */
  if (req.url?.startsWith("/usage") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const limit = Number(url.searchParams.get("limit")) || 30;
    const summary = await UsageLog.getUsageSummary({ recentLimit: limit });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...summary }));
    return;
  }

  /* GET /fast-path-candidates — aggregated patterns the operator asked
   * that fell through to the LLM. Used to triage which queries to migrate
   * to fast-path next. Optional query params:
   *    since     ISO date — only entries after this
   *    minCount  minimum occurrences for a pattern to surface (default 2)
   *    limit     max patterns returned (default 25) */
  if (req.url?.startsWith("/fast-path-candidates") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const since = url.searchParams.get("since") || null;
    const minCount = Number(url.searchParams.get("minCount")) || 2;
    const limit = Number(url.searchParams.get("limit")) || 25;
    const summary = await FastPathCandidates.summarise({ since, minCount, limit });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...summary }));
    return;
  }

  /* GET /history — paginated conversation turns. Query params:
   *    limit       max rows (default 50, hard cap 500)
   *    beforeTs    paginate older than this ms timestamp
   *    sessionId   filter to one HUD session
   * GET /history/sessions — distinct sessions in last N days with turn counts
   * Used by the HUD's history drawer for "what did I ask yesterday" lookups. */
  if (req.url?.startsWith("/history") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/history/sessions") {
      const days = Number(url.searchParams.get("days")) || 14;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, sessions: Memory.listSessions({ days }) }));
      return;
    }
    if (url.pathname === "/history") {
      /* Workspaces v2: history drawer is workspace-scoped by default. The HUD
       * passes ?allWorkspaces=1 when the operator clicks the "show all" toggle.
       * Active workspace returned alongside so the HUD's filter chip knows
       * what to label. */
      const allWorkspaces = url.searchParams.get("allWorkspaces") === "1";
      const turns = Memory.recentTurns({
        limit: Number(url.searchParams.get("limit")) || 50,
        beforeTs: url.searchParams.get("beforeTs") ? Number(url.searchParams.get("beforeTs")) : null,
        sessionId: url.searchParams.get("sessionId") || null,
        allWorkspaces,
      });
      const active = Workspaces.getActive();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        turns,
        scope: {
          activeWorkspace: active ? { slug: active.slug, label: active.label } : null,
          showingAll: allWorkspaces,
        },
      }));
      return;
    }
  }

  /* GET /actions — machine-readable manifest of every tool the LLM exposes,
   * plus its operational metadata (confirmation-gated? plan-broadcast? always-on
   * in the router?). The HUD's future command palette + help cheat-sheet read
   * this; doc generation reads this; the audit-log filter UI reads this.
   *
   * Computed on-demand from in-memory TOOLS so adding a tool in code is the
   * only place you ever need to declare it — the manifest stays fresh without
   * a build step. */
  if (req.url === "/actions" && req.method === "GET") {
    const alwaysOnSet = new Set(ToolRouter.indexStatus().alwaysOn);
    /* Pull operator-tunable metadata (category, label, voice phrasings) from
     * config/actions.meta.json. Re-read on each request so updates land
     * without a bridge restart. The file is small (~100 entries × small
     * objects) so the read is sub-millisecond. */
    let meta = {};
    try {
      const fsAsync = await import("node:fs/promises");
      const metaPath = new URL("../config/actions.meta.json", import.meta.url);
      meta = JSON.parse(await fsAsync.readFile(metaPath, "utf8"));
    } catch { /* meta is optional — bare manifest if missing/malformed */ }
    const manifest = TOOLS.map((t) => {
      const fn = t.function || t;
      const m = (meta && meta[fn.name]) || {};
      return {
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters?.properties || {},
        required: fn.parameters?.required || [],
        category: m.category || null,
        label: m.label || null,
        phrasings: Array.isArray(m.phrasings) ? m.phrasings : [],
        destructive: typeof NEEDS_CONFIRMATION[fn.name] === "function",
        flags: {
          alwaysOn: alwaysOnSet.has(fn.name),
          planProposed: PLAN_PROPOSED_TOOLS.has(fn.name),
          requiresConfirmation: typeof NEEDS_CONFIRMATION[fn.name] === "function",
        },
        /* Hint of how the bridge would summarise a call — useful for the
         * palette to show "what does this do?" with actual operator phrasing.
         * Some summarisers branch on args; calling with empty args gives a
         * generic shape that's still readable. */
        sampleSummary: (() => {
          try { return summariseToolCall(fn.name, {}); } catch { return null; }
        })(),
      };
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      total: manifest.length,
      generatedAt: new Date().toISOString(),
      categories: meta._categories || null,
      actions: manifest,
    }));
    return;
  }

  if (req.url?.startsWith("/audit") && req.method === "GET") {
    /* Query the JSONL audit log. URL format:
     *   /audit?operator=marcus&tool=draft_email&fromTs=...&toTs=...&limit=200
     *   /audit?workspace=consulting     — explicit slug override
     *   /audit?allWorkspaces=1           — bypass active-workspace filter
     * All filters optional. Returns newest-first within the limit. */
    try {
      const url = new URL(req.url, "http://localhost");
      const filter = {
        operator: url.searchParams.get("operator") || undefined,
        tool: url.searchParams.get("tool") || undefined,
        fromTs: url.searchParams.get("fromTs") ? Number(url.searchParams.get("fromTs")) : undefined,
        toTs: url.searchParams.get("toTs") ? Number(url.searchParams.get("toTs")) : undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 200,
        workspace: url.searchParams.get("workspace") || undefined,
        allWorkspaces: url.searchParams.get("allWorkspaces") === "1",
      };
      const [entries, summary] = await Promise.all([Audit.query(filter), Audit.summary()]);
      const active = Workspaces.getActive();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        entries,
        summary,
        scope: {
          activeWorkspace: active ? { slug: active.slug, label: active.label } : null,
          showingAll: filter.allWorkspaces,
          explicitWorkspace: filter.workspace || null,
        },
      }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  /* GET /usage — aggregate audit log into a usage snapshot. URL format:
   *   /usage?windowHours=24
   * The HUD's USAGE section reads this to show queries today, top tools, error
   * rate, average duration, fal call count. Pure read-only — no side effects. */
  if (req.url?.startsWith("/usage") && req.method === "GET") {
    try {
      const url = new URL(req.url, "http://localhost");
      const windowHours = Number(url.searchParams.get("windowHours")) || 24;
      const snapshot = await Usage.getUsage({ windowHours });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, ...snapshot }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.url === "/projects" && req.method === "GET") {
    /* Enumerate shoot folders for the HUD's project picker. */
    try {
      const items = await Projects.listProjects();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, active: Projects.getActive(), items }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.url === "/project/active" && req.method === "POST") {
    /* HUD POSTs { id } to set the active project (or { id: null } to clear).
     * Subsequent LLM asks include the project context in the system prompt. */
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        const id = j.id || null;
        Projects.setActive(id);
        console.log(`[bridge] active project: ${id || "(cleared)"}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, active: Projects.getActive() }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (req.url === "/operator" && req.method === "POST") {
    /* HUD posts the active profile id whenever it changes (and once on boot).
     * Bridge attributes subsequent audit entries to this operator. */
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        Audit.setOperator(j.id || "default");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, operator: Audit.getOperator() }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  /* (Duplicate /actions handler removed — the upstream handler at line ~2900
   * now reads actions.meta.json and merges category/label/phrasings/destructive
   * directly. This second copy was dead code from earlier scaffolding.) */

  if (req.url === "/healthz" && req.method === "GET") {
    /* Why: aggregated health for the HUD's status bar. Probes Ollama (text + vision
     * are the same daemon) + Kokoro (TTS) + Whisper (STT) in parallel. Each gets a
     * tight timeout so a single hung daemon doesn't tank the whole readout. The
     * bridge itself is implicitly "up" if this endpoint responds.
     *
     * Sprint 12 cache: with multiple HUD tabs (Jarvis + Friday) the boot burst
     * was firing 2× concurrent probe fanouts to all three services. A 1s TTL
     * on the response means a flurry of polls within 1 second shares a single
     * probe round. Cuts the dual-tab boot load roughly in half without
     * affecting freshness — operators can't perceive 1-second-stale health. */
    const NOW = Date.now();
    if (_healthzCache && (NOW - _healthzCache.ts) < 1000) {
      console.log(`[cache] healthz HIT (age=${NOW - _healthzCache.ts}ms)`);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(_healthzCache.body);
      return;
    }
    console.log(`[cache] healthz MISS — running probe fanout`);
    const probe = async (url, ms = 1500) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
        return r.ok;
      } catch { return false; }
    };
    /* Why: probe whisper for its full payload (not just .ok) so we can surface
     * which backend is live — MLX (Apple GPU, ~6× faster) vs faster-whisper
     * (CPU int8 fallback). The HUD shows this in the Agent Console health
     * row so the operator can tell at a glance whether they're on the fast
     * path. Falls back to a plain boolean if the probe fails. */
    const probeWhisper = async (ms = 1500) => {
      try {
        const r = await fetch("http://localhost:8768/health", { signal: AbortSignal.timeout(ms) });
        if (!r.ok) return { ok: false, backend: null, model: null };
        const j = await r.json();
        return { ok: true, backend: j.backend || null, model: j.model || null };
      } catch { return { ok: false, backend: null, model: null }; }
    };
    const [ollama, kokoro, whi] = await Promise.all([
      probe(`${OLLAMA_URL}/api/tags`),
      probe("http://localhost:8767/health"),
      probeWhisper(),
    ]);
    const whisper = whi.ok;
    const whisperBackend = whi.backend;
    const whisperModel = whi.model;
    /* setupRequired: true when config/brand.json is missing — signals to the HUD
     * that this is a fresh install and the operator should run setup-wizard.mjs.
     * The bridge still serves a FALLBACK brand so the HUD doesn't crash; this
     * flag just lets us show a friendly "first run? run the setup wizard"
     * overlay instead of leaving them with default Jarvis branding. */
    let setupRequired = false;
    try {
      const fs = await import("node:fs");
      const brandPath = new URL("../config/brand.json", import.meta.url).pathname;
      setupRequired = !fs.existsSync(brandPath);
    } catch { /* assume not required if we can't probe */ }

    const body = JSON.stringify({
      ok: true,
      ts: Date.now(),
      services: { bridge: true, ollama, kokoro, whisper },
      whisperBackend,   // "mlx" | "faster-whisper" | null
      whisperModel,     // e.g. "large-v3-turbo"
      setupRequired,
    });
    /* Memoize the serialised body so the next caller within 1s gets a copy
     * without re-running the probe fanout. Cache covers ts staleness up to
     * 1s — that's a tradeoff we accept for halving boot-burst load. */
    _healthzCache = { ts: Date.now(), body };
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  if (req.url === "/brand" && req.method === "GET") {
    /* Brand config drives wake phrase, agency name, colours, logos. Frontend bootstraps
     * with this before rendering so a single deploy can serve any client. */
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(loadBrand()));
    return;
  }
  /* POST /brand — settings-panel writer. Accepts a partial patch (agent /
   * agency / colors / fonts / logo) and shallow-merges over the current
   * brand. Persists to config/brand.json + invalidates cache + broadcasts
   * "brand.updated" so HUD live-reloads. Body shape:
   *   { agent: { name?, wakePhrase?, wakeMishears?, voice? },
   *     agency: { name?, tagline?, socials? }, colors?, fonts?, logo? } */
  if (req.url === "/brand" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const patch = JSON.parse(body || "{}");
      if (patch.agent?.wakeMishears && typeof patch.agent.wakeMishears === "string") {
        patch.agent.wakeMishears = patch.agent.wakeMishears
          .split(",").map((s) => s.trim()).filter(Boolean);
      }
      const merged = saveBrand(patch);
      broadcastToClients({ type: "brand.updated", data: merged });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, brand: merged }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  if (req.url === "/style" && req.method === "GET") {
    /* The operator's creative-style.md ("template for success") — editorial voice,
     * visual preferences, edit pacing, brand vocabulary. Returned as raw markdown
     * so the settings panel can drop it into a textarea for editing. Empty body
     * when the file doesn't exist yet (treated as "not yet customised"). */
    const text = loadCreativeStyle();
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      exists: text.length > 0,
      path: creativeStylePath(),
      content: text,
      examplePath: creativeStylePath().replace(/\.md$/, ".example.md"),
    }));
    return;
  }
  if (req.url === "/style" && req.method === "POST") {
    /* Operator saved an edit through the settings panel. We write the raw markdown
     * to disk + invalidate the cache so the next askLLM picks it up. Bounded length
     * to prevent a runaway paste from blowing every prompt budget. */
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const content = String(parsed.content || "").slice(0, 32_000); // hard ceiling
      const fs = await import("node:fs/promises");
      const cfgDir = new URL("../config/", import.meta.url);
      await fs.mkdir(cfgDir, { recursive: true });
      await fs.writeFile(new URL("../config/creative-style.md", import.meta.url), content, "utf8");
      invalidateCreativeStyleCache();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, bytes: content.length }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }
  /* GET /api-keys — surfaces which third-party API keys are currently set,
   * so the settings panel can render their inputs with masked previews
   * ("set · sk-abcd…") rather than empty boxes that suggest "not configured".
   * NEVER returns the actual key value — only a presence flag + last-4 chars
   * of the value when present, for visual identification only. */
  if (req.url === "/api-keys" && req.method === "GET") {
    const mask = (v) => v ? `…${String(v).slice(-4)}` : null;
    /* Scan .env for user-managed keys. Anything starting with letters and
     * containing _KEY/_TOKEN/_SECRET/_API/_TOKEN_ID/etc is treated as a
     * settings-panel-editable secret. The legacy hard-coded names below stay
     * for back-compat but are now also surfaced through the generic list. */
    const SECRET_PATTERN = /^[A-Z][A-Z0-9_]*(_KEY|_TOKEN|_SECRET|_API|_PASSWORD|_PWD|_TOKEN_ID)$/;
    const RESERVED = new Set([
      "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
      "OLLAMA_MODEL", "VL_MODEL", "VL_KEEP_ALIVE",
      "LLM_PROVIDER_DEFAULT", "LLM_PROVIDER_VISION", "LLM_PROVIDER_HIGHSTAKES",
    ]);
    const generic = [];
    for (const [name, value] of Object.entries(process.env)) {
      if (RESERVED.has(name)) continue;
      if (!SECRET_PATTERN.test(name)) continue;
      generic.push({ name, set: !!value, hint: mask(value) });
    }
    generic.sort((a, b) => a.name.localeCompare(b.name));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      keys: {
        anthropic: { set: !!process.env.ANTHROPIC_API_KEY, hint: mask(process.env.ANTHROPIC_API_KEY) },
        openai:    { set: !!process.env.OPENAI_API_KEY,    hint: mask(process.env.OPENAI_API_KEY) },
      },
      generic,
      routing: {
        default:    process.env.LLM_PROVIDER_DEFAULT    || "ollama",
        vision:     process.env.LLM_PROVIDER_VISION     || "ollama",
        highstakes: process.env.LLM_PROVIDER_HIGHSTAKES || "ollama",
      },
    }));
    return;
  }

  /* POST /api-keys — write the named first-class keys (anthropic / openai)
   * plus any operator-defined custom NAME=VALUE entries to .env, and update
   * process.env so values go live without a bridge restart.
   *
   * Body shape: { anthropic?: string, openai?: string,
   *               defaultProvider?, visionProvider?, highstakesProvider?,
   *               custom?: [{name, value}] }
   *   - empty string  → clear the key (write empty value, kill from env)
   *   - missing field → don't touch
   *   - non-empty     → set it
   *
   * The MAP is restricted to anthropic + openai because those are the only
   * built-in cloud providers the LLM router consults directly. Anything
   * else (legacy FRAMEIO_TOKEN / SERPAPI_KEY / HUNTER_API_KEY from the FOM
   * fork, or new bridges added later) goes through the generic `custom`
   * array so the surface stays narrow and the legacy keys can still be set
   * by operators who genuinely want them. */
  if (req.url === "/api-keys" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const MAP = {
        anthropic: "ANTHROPIC_API_KEY",
        openai:    "OPENAI_API_KEY",
      };
      /* LLM provider routing knobs are written under their own keys. The
       * accepted values are an allowlist (anthropic|openai|ollama) so a stray
       * POST can't set the default to something garbage that the dispatcher
       * would silently fall back from anyway. */
      const ROUTING_MAP = {
        defaultProvider:    "LLM_PROVIDER_DEFAULT",
        visionProvider:     "LLM_PROVIDER_VISION",
        highstakesProvider: "LLM_PROVIDER_HIGHSTAKES",
      };
      const ROUTING_VALUES = new Set(["anthropic", "openai", "ollama"]);
      for (const [shortKey, envKey] of Object.entries(ROUTING_MAP)) {
        if (!Object.prototype.hasOwnProperty.call(parsed, shortKey)) continue;
        const v = String(parsed[shortKey] || "").toLowerCase();
        if (!ROUTING_VALUES.has(v)) continue;
        await persistEnvVar(envKey, v);
        process.env[envKey] = v;
      }
      const updated = {};
      for (const [shortKey, envKey] of Object.entries(MAP)) {
        if (!Object.prototype.hasOwnProperty.call(parsed, shortKey)) continue;
        const v = String(parsed[shortKey] ?? "").trim().slice(0, 256);
        await persistEnvVar(envKey, v);
        if (v) process.env[envKey] = v; else delete process.env[envKey];
        updated[shortKey] = v ? "set" : "cleared";
      }
      /* Generic NAME=VALUE keys: any operator-defined env var, validated
       * against an env-name regex so a stray POST can't write garbage to
       * .env. Names are uppercase, alphanumeric + underscore, must start
       * with a letter. Values bounded to 1024 chars. */
      if (Array.isArray(parsed.custom)) {
        const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
        for (const entry of parsed.custom) {
          const name = String(entry?.name || "").trim().toUpperCase();
          if (!NAME_RE.test(name)) continue;
          const v = String(entry?.value ?? "").slice(0, 1024);
          await persistEnvVar(name, v);
          if (v) process.env[name] = v; else delete process.env[name];
          updated[name] = v ? "set" : "cleared";
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, updated }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  /* Tailscale status — read-only endpoint surfaced in the settings panel.
   * Tailscale doesn't use a password — auth is browser-based SSO via the
   * operator's identity provider (Google/GitHub/Apple/etc). The kiosk's job is
   * to (a) tell the operator whether tailscale is installed + authenticated,
   * (b) surface the device's tailnet IP + MagicDNS name so they can reach
   * the HUD from a phone, (c) offer a launch button that pops Terminal with
   * tools/install-tailscale.sh. The bridge intentionally does NOT run
   * `sudo tailscale up` itself — that needs an interactive TTY for the
   * sudo password and the browser SSO redirect.
   *
   * Three states:
   *   - missing     : binary not on PATH
   *   - logged-out  : binary installed but `tailscale status` returns NeedsLogin
   *   - connected   : authenticated with tailnet IP + (optionally) MagicDNS */
  if (req.url === "/tailscale/status" && req.method === "GET") {
    const out = {
      ok: true,
      installed: false,
      authenticated: false,
      ip: null,
      hostname: null,
      magicDnsName: null,
      tailnet: null,
      serveActive: false,
      serveUrl: null,
      error: null,
    };
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      try {
        await run("tailscale", ["version"], { timeout: 1500 });
        out.installed = true;
      } catch {
        out.installed = false;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      /* `tailscale status --json` is the canonical machine-readable status. The
       * top-level "Self" object holds this device's identity; "BackendState"
       * is "Running" when authenticated, "NeedsLogin" before sign-in. */
      const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 3000 });
      const j = JSON.parse(stdout);
      if (j.BackendState === "Running" && j.Self) {
        out.authenticated = true;
        out.hostname = j.Self.HostName || null;
        out.magicDnsName = (j.Self.DNSName || "").replace(/\.$/, "") || null;
        out.ip = (j.Self.TailscaleIPs || [])[0] || null;
        out.tailnet = j.MagicDNSSuffix || null;
      }
      /* Serve / Funnel status — separate command. Failures are non-fatal: the
       * HUD will just show "remote access not enabled" if this throws. */
      try {
        const { stdout: ss } = await run("tailscale", ["serve", "status", "--json"], { timeout: 2000 });
        const sj = JSON.parse(ss || "{}");
        const tcp = sj.TCP || {};
        if (Object.keys(tcp).length > 0 && out.magicDnsName) {
          out.serveActive = true;
          out.serveUrl = `https://${out.magicDnsName}`;
        }
      } catch { /* serve status command may not exist on older versions — ignore */ }
    } catch (e) {
      out.error = String(e.message || e);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
    return;
  }

  /* POST /tailscale/launch-installer — opens Terminal.app focused on a
   * pre-built wrapper at tools/open-tailscale-setup.command. Using a
   * `.command` file means macOS treats it as "double-click to open in
   * Terminal" with no shell-escaping risk. The bridge can't drive sudo +
   * browser SSO itself, so this hand-off is the cleanest path. */
  if (req.url === "/tailscale/launch-installer" && req.method === "POST") {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const wrapper = path.join(PROJECT_ROOT, "tools", "open-tailscale-setup.command");
      /* `open -a Terminal <file>` is the canonical macOS way to launch a
       * script in a new Terminal window. No shell interpolation needed —
       * the path is passed as a single argv to execFile. */
      await run("open", ["-a", "Terminal", wrapper], { timeout: 5000 });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  if (req.url === "/launcher" && req.method === "GET") {
    /* Why: HUD's quick-launch panel reads its entries from config/launcher.json so
     * white-label installs and operator preferences can swap them without touching
     * code. Returns a sane default if the file is missing or malformed. */
    const FALLBACK = { items: [
      { label: "MAIL",         app: "mail" },
      { label: "PREMIERE PRO", app: "premiere" },
      { label: "SHOOTS",       app: "shoots" },
      { label: "FRAME.IO",     app: "frameio" },
    ]};
    try {
      const fs = await import("node:fs/promises");
      const cfgPath = new URL("../config/launcher.json", import.meta.url);
      const raw = await fs.readFile(cfgPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.items)) throw new Error("launcher.json missing items[]");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, items: parsed.items }));
    } catch (e) {
      console.warn(`[bridge] /launcher fallback (${e.message})`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, items: FALLBACK.items, fallback: true }));
    }
    return;
  }
  if (req.url === "/launch" && req.method === "POST") {
    /* Why: HUD's Launch panel needs to actually open programs. Each entry maps a stable
     * key to a macOS app name we hand to `open -a`. Hard-coded allowlist keeps the surface
     * tight — arbitrary app names from the frontend would be a bad idea. */
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
    /* Each entry: either { app: "Name" } → open -a, OR { folder: "rel/path" } → open path in Finder,
     * OR { url: "https://..." } → open url in default browser. */
    const APPS = {
      "mail":        { app: "Mail" },
      "messages":    { app: "Messages" },
      "calendar":    { app: "Calendar" },
      "music":       { app: "Music" },
      "notes":       { app: "Notes" },
      "reminders":   { app: "Reminders" },
      "chrome":      { app: "Google Chrome" },
      "safari":      { app: "Safari" },
      "terminal":    { app: "Terminal" },
      "photos":      { app: "Photos" },
      "slack":       { app: "Slack" },
      "output":      { folder: "output" },               // generated artefacts
    };
    const entry = APPS[String(payload.app || "").toLowerCase()];
    if (!entry) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `unknown app: ${payload.app}` }));
      return;
    }
    try {
      if (entry.app) {
        await execp(`open -a ${JSON.stringify(entry.app)}`);
      } else if (entry.folder) {
        /* Resolve to an absolute project-relative path before handing to `open`. Folder
         * launches don't use -a so macOS picks the default handler (Finder for dirs). */
        const abs = path.resolve(PROJECT_ROOT, entry.folder);
        await execp(`open ${JSON.stringify(abs)}`);
      } else if (entry.url) {
        await execp(`open ${JSON.stringify(entry.url)}`);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, opened: entry.app || entry.folder || entry.url }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message) }));
    }
    return;
  }
  if (req.url === "/diary" && req.method === "GET") {
    /* Today-only calendar feed for the HUD's clock panel split. Wraps getUpcomingEvents
     * with days=1, then filters to events whose start time is today (calendar.mjs may
     * return tomorrow morning items inside a 24h window). Each item is shaped to the
     * minimum the HUD needs: time string + title + isImminent (within 30 min).
     *
     * Sprint 12 — server-side cache + in-flight dedup. The HAR from a 2-tab
     * Chrome session showed /diary taking 8-20s (AppleScript fanout) and
     * piling up in Chrome's 6-slot per-origin connection pool, blocking
     * faster requests like /healthz. 12s TTL means the 15s poll interval
     * gets a cache hit roughly 80% of the time; in-flight Promise dedup
     * means concurrent callers (2 tabs polling within ms of each other)
     * share one AppleScript run rather than doubling it. */
    const NOW = Date.now();
    /* TTL = 18s so consecutive polls (HUD interval = 15s) stay inside the
     * cache window. Was 12s — every poll missed the cache and paid 4-5s. */
    if (_diaryCache && (NOW - _diaryCache.ts) < 18_000) {
      console.log(`[cache] diary HIT (age=${NOW - _diaryCache.ts}ms)`);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(_diaryCache.body);
      return;
    }
    /* Coalesce concurrent fanouts. If a fetch is already running, await its
     * result instead of starting a second AppleScript pull. */
    const buildBody = async () => {
      try {
        const evRes = await getUpcomingEvents({ days: 1 });
        const todayStr = new Date().toLocaleDateString("en-GB");
        const now = Date.now();
        const events = (evRes?.events || [])
          .filter(e => {
            if (!e.start) return false;
            const d = new Date(e.start);
            return !isNaN(d) && d.toLocaleDateString("en-GB") === todayStr;
          })
          .slice(0, 8)
          .map(e => {
            const d = new Date(e.start);
            const isImminent = d.getTime() - now < 30 * 60 * 1000 && d.getTime() > now;
            return {
              time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
              title: e.title || "(untitled)",
              location: e.location || null,
              isImminent,
              isPast: d.getTime() < now,
            };
          });
        return JSON.stringify({ ok: true, count: events.length, events, ts: Date.now() });
      } catch (e) {
        return JSON.stringify({ ok: false, error: String(e.message), events: [] });
      }
    };
    if (!_diaryInFlight) {
      console.log(`[cache] diary MISS — starting AppleScript fanout`);
      const _fanoutStart = Date.now();
      _diaryInFlight = buildBody().finally(() => {
        console.log(`[cache] diary fanout completed in ${Date.now() - _fanoutStart}ms`);
        _diaryInFlight = null;
      });
    } else {
      console.log(`[cache] diary COALESCE — joining in-flight fanout`);
    }
    const body = await _diaryInFlight;
    /* Only cache successful responses so transient AppleScript failures
     * don't pin a bad result for 12s. */
    try {
      const parsed = JSON.parse(body);
      if (parsed.ok) _diaryCache = { ts: Date.now(), body };
    } catch {}
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
    return;
  }
  if (req.url === "/comms" && req.method === "GET") {
    /* Sprint 12 — same hard-timeout + cache pattern as /diary and /inbox.
     * Bridge log was showing 120-second SLOW lines because getMailSummary
     * (AppleScript Mail) hung mid-sync. With a 6-slot Chrome pool, three
     * 120s connections poison everything. 60s cache + 8s timeout + serve
     * stale-on-timeout. */
    const NOW_C = Date.now();
    if (_commsCache && (NOW_C - _commsCache.ts) < 60_000) {
      console.log(`[cache] comms HIT (age=${NOW_C - _commsCache.ts}ms)`);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(_commsCache.body);
      return;
    }

    const _buildCommsBody = async () => {
    const fs = await import("node:fs");
    const out = [];

    /* --- inbox status (Mail unread count, also wrapped in 5s sub-timeout
     * so a hung Mail doesn't sink the whole comms response) --- */
    try {
      const summ = await Promise.race([
        getMailSummary({ unreadOnly: true, max: 5 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("mail-summary 5s")), 5000)),
      ]);
      out.push(summ?.ok && summ.count > 0
        ? { k: `${summ.count} unread`, v: "editorial inbox" }
        : { k: "0 unread", v: "inbox clear" });
    } catch { out.push({ k: "mail", v: "offline" }); }

    /* --- shoot folders (most-recent first, all of them) --- */
    /* Why: was only listing the latest. Operator wants every shoot accessible from the HUD;
     * clicking opens the folder in Finder via /launch with a folder param. */
    try {
      const shoots = fs.readdirSync(Paths.getShootsDir(), { withFileTypes: true })
        .filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
      for (const name of shoots) {
        const subj = name.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        const date = (name.match(/^\d{4}-(\d{2})-(\d{2})/) || []).slice(1).join("/") || "—";
        out.push({ k: `shoot ${date}`, v: subj || name, url: `/output/../shoots/${encodeURIComponent(name)}`, kind: "folder", folderRel: `shoots/${name}` });
      }
    } catch {}

    /* --- generated outputs — thumbnails, teasers, PDFs (most-recent first, max 12) --- */
    /* Why: the operator generated these; they should be a click away from the HUD without
     * having to dig into Finder. We name each one cleanly: "Thumb · the track-day car", "Teaser ·
     * the hero", "Quote · the SUV". */
    function prettyFromShootStem(stem) {
      return stem.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")
        .replace(/_\d{4}-\d{2}-\d{2}T[\d-]+$/, "")
        .replace(/[-_]/g, " ")
        .trim()
        .replace(/\b\w/g, c => c.toUpperCase()) || stem;
    }
    const recents = [];
    function pushRecents(dir, kind, kLabel, hrefPrefix) {
      try {
        /* dir comes in as "output/<sub>" — re-root under the configurable output dir.
         * URL prefix stays "/output/<sub>" because the static route now resolves that
         * same path under Paths.getOutputDir(). */
        const subPath = dir.startsWith("output/") ? dir.slice("output/".length) : dir;
        const baseDir = dir.startsWith("output/") ? path.join(Paths.getOutputDir(), subPath) : path.join(PROJECT_ROOT, dir);
        for (const f of fs.readdirSync(baseDir)) {
          if (f.startsWith(".")) continue;
          const full = path.join(baseDir, f);
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          if (!st.isFile()) continue;
          recents.push({
            k: kLabel, v: prettyFromShootStem(f.replace(/\.[^.]+$/, "")),
            url: `${hrefPrefix}/${encodeURIComponent(f)}`, kind,
            mtimeMs: st.mtimeMs,
          });
        }
      } catch {}
    }
    /* Recents come from the canonical sub-folder taxonomy (Paths.OUTPUT_SUBDIRS).
     * youtube/thumbnails is the new home; legacy "output/thumbnails" stays scanned so
     * pre-migration installs still surface their files. */
    pushRecents("output/youtube/thumbnails", "thumb", "thumb",    "/output/youtube/thumbnails");
    pushRecents("output/youtube/shorts",     "video", "yt-short", "/output/youtube/shorts");
    pushRecents("output/instagram/reels",    "video", "ig-reel",  "/output/instagram/reels");
    pushRecents("output/tiktok",             "video", "tiktok",   "/output/tiktok");
    pushRecents("output/thumbnails",         "thumb", "thumb",    "/output/thumbnails"); // legacy
    pushRecents("output/pdf",                "pdf",   "pdf",      "/output/pdf");
    pushRecents("output/portraits",          "image", "portrait", "/output/portraits");
    pushRecents("output/aspects",            "video", "aspect",   "/output/aspects");
    /* Teasers/Shorts live in output/prod_<stem>/final.mp4 — collect those with a friendly subject name. */
    try {
      const outRoot = Paths.getOutputDir();
      for (const dir of fs.readdirSync(outRoot)) {
        if (!dir.startsWith("prod_")) continue;
        const finalMp4 = path.join(outRoot, dir, "final.mp4");
        let st;
        try { st = fs.statSync(finalMp4); } catch { continue; }
        recents.push({
          k: "teaser", v: prettyFromShootStem(dir.replace(/^prod_/, "")),
          url: `/output/${encodeURIComponent(dir)}/final.mp4`, kind: "video",
          mtimeMs: st.mtimeMs,
        });
      }
    } catch {}
    recents.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const r of recents.slice(0, 12)) {
      const { mtimeMs, ...item } = r;
      out.push(item);
    }
      return JSON.stringify({ ok: true, comms: out, ts: Date.now() });
    };  /* end _buildCommsBody */

    if (!_commsInFlight) {
      console.log(`[cache] comms MISS — building (8s cap)`);
      const _t = Date.now();
      _commsInFlight = Promise.race([
        _buildCommsBody(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("comms timeout 8s")), SLOW_TIMEOUT_MS)),
      ]).finally(() => {
        console.log(`[cache] comms build finished in ${Date.now() - _t}ms`);
        _commsInFlight = null;
      });
    } else {
      console.log(`[cache] comms COALESCE — joining in-flight`);
    }
    try {
      const body = await _commsInFlight;
      _commsCache = { ts: Date.now(), body };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
    } catch (e) {
      if (_commsCache) {
        console.warn(`[cache] comms FAIL (${e.message}) — serving stale`);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(_commsCache.body);
      } else {
        console.warn(`[cache] comms FAIL (${e.message}) — empty fallback`);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: String(e.message), comms: [] }));
      }
    }
    return;
  }
  if (req.url.startsWith("/cancel") && req.method === "POST") {
    /* Two cancel modes:
     *   POST /cancel              — global, stops everything (voice "stop",
     *                               STOP pill, Esc keyboard shortcut)
     *   POST /cancel?runId=<id>   — per-task, stops just that runId. Used by
     *                               the per-row × button in the HUD task strip.
     *
     * Each module's isAborted(runId) checks both the global flag AND its
     * per-runId set, so global cancel still wins over per-runId. */
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const runId = url.searchParams.get("runId");
    Vision.raiseAbort(runId);
    Browse.raiseAbort(runId);
    Crew.raiseAbort(runId);
    res.writeHead(200, { "content-type": "application/json" });
    if (runId) {
      res.end(JSON.stringify({ ok: true, runId, note: `Cancellation requested for runId=${runId}. Active loop will stop at next safe checkpoint.` }));
    } else {
      res.end(JSON.stringify({ ok: true, note: "Cancellation requested. Active caption batch / browse loop / crew run will stop at next safe checkpoint." }));
    }
    return;
  }
  if (req.url === "/brand" && req.method === "POST") {
    /* Setup wizard pings this after writing config/brand.json so we re-read from disk
     * without needing a bridge restart. POST body is ignored — the wizard already wrote the file. */
    invalidateBrandCache();
    Paths.invalidatePathsCache();
    const fresh = loadBrand();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, agent: fresh.agent.name }));
    return;
  }
  if (req.url === "/config") {
    // Wait for IP autodetect + hardware probe (cap at 6s) so the setup modal sees full data
    await Promise.race([Promise.all([locationDetected, hardwareDetected]), new Promise(r => setTimeout(r, 6000))]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CONFIG));
    return;
  }
  if (req.url === "/config/redetect") {
    /* Force the IP lookup regardless of CONFIG.lockLocation. The whole point of
     * the operator pressing "Re-detect Location" is to override a stale lock —
     * respecting it here was a real bug Adam hit. We also clear lockLocation
     * and persist so the new detection survives the next reboot; if the
     * operator wants to lock again they can save manually in the setup modal. */
    await autoDetectLocation({ force: true });
    CONFIG.lockLocation = false;
    try {
      const fs = await import("node:fs/promises");
      const cfgPath = new URL("../config.json", import.meta.url);
      await fs.writeFile(cfgPath, JSON.stringify(CONFIG, null, 2));
    } catch (e) {
      console.warn(`[bridge] could not persist redetect to config.json: ${e.message}`);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(CONFIG));
    return;
  }
  if (req.url === "/config/override" && req.method === "POST") {
    /* User-entered overrides from the setup modal. Persisted to config.json so they survive restarts.
     * IP auto-detect is skipped on next boot because lockLocation is set true. */
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      try {
        const j = JSON.parse(body);
        if (j.city) CONFIG.operator.city = String(j.city);
        if (j.country) CONFIG.operator.country = String(j.country);
        if (typeof j.latitude === "number") CONFIG.operator.latitude = j.latitude;
        if (typeof j.longitude === "number") CONFIG.operator.longitude = j.longitude;
        if (j.timezone) CONFIG.operator.timezone = String(j.timezone);
        if (j.agency) CONFIG.agency.name = String(j.agency);
        CONFIG.lockLocation = true;     // prevent IP autodetect from clobbering on next boot
        // Persist to config.json
        const fs = await import("node:fs/promises");
        const cfgPath = new URL("../config.json", import.meta.url);
        await fs.writeFile(cfgPath, JSON.stringify(CONFIG, null, 2));
        console.log(`[bridge] config override saved: ${CONFIG.operator.city}, ${CONFIG.operator.country}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(CONFIG));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /* POST /purchases/confirm — HUD posts here when operator types the amount
   * in the typed-confirm modal. Body: { pendingId: string, enteredAmountGbp: number,
   * action?: "confirm"|"cancel" }. Cancel just drops the pending entry; confirm
   * runs Purchases.confirmTyped which re-enters requestPurchase with confirmed:true.
   * Always broadcasts a purchase.recorded event mirroring the dispatch path so
   * the HUD shows the same badge regardless of how settlement happened. */
  if (req.url === "/purchases/confirm" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body || "{}"); } catch { payload = {}; }
    const pendingId = String(payload.pendingId || "");
    const action = String(payload.action || "confirm").toLowerCase();
    if (!pendingId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "pendingId required" }));
      return;
    }
    if (action === "cancel") {
      const dropped = Purchases.cancelPending(pendingId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cancelled: dropped }));
      return;
    }
    const r = await Purchases.confirmTyped(pendingId, payload.enteredAmountGbp);
    broadcastToClients({
      type: "purchase.recorded",
      data: {
        ok: !!r.ok,
        simulated: r.simulated ?? null,
        merchant: r.merchant ?? null,
        item: r.item ?? null,
        chargedGbp: r.chargedGbp ?? null,
        tier: r.tier ?? "typed",
        code: r.code ?? null,
      },
    });
    res.writeHead(r.ok ? 200 : 400, { "content-type": "application/json" });
    res.end(JSON.stringify(r));
    return;
  }

  /* GET /llm/providers — diagnostic list of configured LLM providers + which
   * workload each is wired for. No keys returned — only "available: true/false"
   * so an injection that reads this endpoint can't exfiltrate credentials. */
  if (req.url === "/llm/providers" && req.method === "GET") {
    const list = LlmProviders.listProviders();
    const routing = {
      default:    LlmProviders.pickProvider("default"),
      vision:     LlmProviders.pickProvider("vision"),
      highstakes: LlmProviders.pickProvider("highstakes"),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, providers: list, routing }));
    return;
  }

  /* GET /purchases/audit — read-only journal + caps + allowlist for the HUD's
   * audit overlay. No write surface — limits/allowlist edits go through the
   * filesystem on purpose so an injection can't loosen the rails at runtime. */
  if (req.url.startsWith("/purchases/audit") && req.method === "GET") {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const [limits, allowlist, journal] = await Promise.all([
      Purchases.getLimits(),
      Purchases.getAllowlist(),
      Purchases.getRecentJournal(limit),
    ]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, limits, allowlist, journal }));
    return;
  }

  /* GET /settings — what the HUD's settings modal needs to render itself.
   * Returns the active voice + model, the catalog of voices Kokoro has loaded,
   * and the list of Ollama models actually pulled on this machine (with size +
   * parameter-count hints so the operator knows what 32b will cost RAM-wise). */
  if (req.url === "/settings" && req.method === "GET") {
    const brand = loadBrand();
    let voices = [], voiceDefault = brand.agent?.voice || "bm_daniel";
    try {
      const r = await fetch("http://localhost:8767/health", { signal: AbortSignal.timeout(2000) });
      if (r.ok) { const j = await r.json(); voices = j.voices || []; voiceDefault = j.default || voiceDefault; }
    } catch {}
    let models = [];
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const j = await r.json();
        /* Why: the kiosk's text path uses qwen2.5:* models — surface only those + nomic-embed
         * (informational only) so the operator can't accidentally switch text generation to a
         * vision-only model and get garbage tool calls. */
        models = (j.models || [])
          .filter(m => /^qwen2\.5:\d+b/i.test(m.name))
          .map(m => ({ name: m.name, sizeBytes: m.size || 0, parameters: m.details?.parameter_size || null }))
          .sort((a, b) => a.sizeBytes - b.sizeBytes);
      }
    } catch {}
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      voice: { current: brand.agent?.voice || voiceDefault, default: voiceDefault, available: voices },
      model: { current: getModel(), available: models },
      paths: Paths.getPaths(),
    }));
    return;
  }

  /* POST /paths — set the operator's shoots + output root folders. Validates that each
   * path can be created before writing brand.json; rejects with a clear error otherwise.
   * Body: { shoots?: string, output?: string }. Empty / missing fields are ignored. */
  if (req.url === "/paths" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      try {
        const j = JSON.parse(body || "{}");
        const result = await Paths.setPaths({ shoots: j.shoots, output: j.output });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  /* ────────── LIVE SHOOT MODE ──────────
   * Why: photographers walking the studio with a phone need a thin companion view that
   * lets them flag heroes, caption the last frame, and send the editor at the kiosk a
   * note — all hands-free except the push-to-talk mic. live.html is the page; these
   * endpoints handle the audio upload + the quick-flag actions. Events broadcast back
   * over WebSocket so the kiosk's task strip + the phone's feed stay in lockstep. */

  if (req.url === "/live" && req.method === "GET") {
    const filePath = path.join(PROJECT_ROOT, "live.html");
    try {
      const s = await stat(filePath);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": s.size });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404); res.end();
    }
    return;
  }
  if (req.url === "/live.js" && req.method === "GET") {
    const filePath = path.join(PROJECT_ROOT, "live.js");
    try {
      const s = await stat(filePath);
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": s.size });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404); res.end();
    }
    return;
  }


  /* POST /mcp — Model Context Protocol JSON-RPC endpoint. Lets external MCP hosts
   * (Claude Desktop, Claude Code, Cursor, Continue) discover + invoke every bridge
   * tool through the standard protocol. Single-shot request/response — we don't yet
   * push server-initiated notifications so SSE isn't required. mcp.mjs handles all the
   * protocol details; we just feed it the tool registry + executor. */
  if (req.url === "/mcp" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); }
      catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }
      const result = await handleMcpRpc(payload, { tools: TOOLS, executeTool });
      if (result === null) {
        /* JSON-RPC notification — no body. 204 keeps the connection clean. */
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  /* GET /mcp — quick liveness probe + capability summary so MCP host setup wizards
   * can verify the endpoint exists without firing a JSON-RPC initialize call. */
  if (req.url === "/mcp" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      protocol: "mcp",
      transport: "http-jsonrpc",
      endpoint: "POST /mcp",
      tools: TOOLS.length,
    }));
    return;
  }

  /* GET /paths — read current configured roots + sub-folder taxonomy. Used by the
   * settings modal to populate the Folders section without round-tripping /settings. */
  if (req.url === "/paths" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, ...Paths.getPaths() }));
    return;
  }

  /* POST /settings — accept { voice?, model?, color?, location? }, persist + apply live.
   *   - voice: stored in config/brand.json + invalidate cache
   *   - model: stored in .env (survives restart) + setModel() to apply immediately
   *   - color: 6-digit hex written to brand.json colors.primary; HUD reads via /brand
   *   - location: { city, latitude?, longitude?, timezone? } persisted to config.json
   *     (lockLocation auto-set to true so IP autodetect doesn't clobber operator's choice)
   * Each field is optional; callers can update one at a time. */
  if (req.url === "/settings" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      try {
        const j = JSON.parse(body || "{}");
        const fs = await import("node:fs/promises");
        const updated = { voice: null, model: null };

        if (j.voice && typeof j.voice === "string") {
          /* Why: brand.json is the canonical store; merge in-place so we don't clobber
           * fields we don't own (colors, fonts, logo). */
          const brandPath = new URL("../config/brand.json", import.meta.url);
          let raw = {};
          try { raw = JSON.parse(await fs.readFile(brandPath, "utf8")); } catch {}
          raw.agent = { ...(raw.agent || {}), voice: j.voice };
          await fs.writeFile(brandPath, JSON.stringify(raw, null, 2));
          invalidateBrandCache();
          updated.voice = j.voice;
        }

        if (j.model && typeof j.model === "string") {
          /* Strict allowlist: only qwen2.5:* models that are actually pulled. Stops the LLM
           * from being switched to something the bridge can't speak to. */
          if (!/^qwen2\.5:\d+b$/i.test(j.model)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `model name must match qwen2.5:Xb pattern` }));
            return;
          }
          /* Verify the model is installed before switching to it. */
          try {
            const tags = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
            const tj = await tags.json();
            const hit = (tj.models || []).find(m => m.name === j.model);
            if (!hit) {
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ ok: false, error: `model ${j.model} is not pulled — run: ollama pull ${j.model}` }));
              return;
            }
          } catch (e) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `ollama not reachable: ${e.message}` }));
            return;
          }
          setModel(j.model);
          /* Update .env so the next boot uses the new model. */
          await persistEnvVar("OLLAMA_MODEL", j.model).catch((e) => console.warn(`[settings] env persist failed: ${e.message}`));
          updated.model = j.model;
        }

        if (j.color && typeof j.color === "string") {
          /* Why: validate strict 6-digit hex so a typo like "#fff" or "red" can't
           * land in brand.json and break colour-derived CSS variables. */
          if (!/^#[0-9a-f]{6}$/i.test(j.color)) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `color must be a 6-digit hex like #00d4ff` }));
            return;
          }
          const brandPath = new URL("../config/brand.json", import.meta.url);
          let raw = {};
          try { raw = JSON.parse(await fs.readFile(brandPath, "utf8")); } catch {}
          /* Derive the supporting colour variants the HUD's CSS needs (deep, glow, tint).
           * Same scheme as brand.mjs FALLBACK so the white-label install stays cohesive. */
          const hex = j.color.toUpperCase();
          const rgb = hexToRgb(hex);
          raw.colors = {
            ...(raw.colors || {}),
            primary: hex,
            primaryDeep: shadeHex(hex, -0.45),
            primaryGlow: `rgba(${rgb.r},${rgb.g},${rgb.b},0.55)`,
            primaryTint: `rgba(${rgb.r},${rgb.g},${rgb.b},0.06)`,
          };
          await fs.writeFile(brandPath, JSON.stringify(raw, null, 2));
          invalidateBrandCache();
          updated.color = hex;
        }

        if (j.socials && typeof j.socials === "object") {
          /* Per-platform social handles. Only the four we currently surface in the
           * settings panel are accepted — third-party additions land via direct
           * brand.json edits, not the API. Each value is trimmed + capped at 64
           * chars to keep watermark renders predictable. The legacy single
           * `social` string is kept in lock-step with Instagram so any tooling
           * that hasn't migrated still gets a sensible value.
           *
           * Operators commonly paste full URLs (https://www.facebook.com/foo) —
           * we normalize each input down to just the handle/slug so the watermark
           * + boilerplate code can render "@foo" or "foo" without parsing URLs
           * itself. Per-platform rules:
           *   - facebook  → bare slug (no @, no fb.com prefix)
           *   - instagram → @handle
           *   - x         → @handle (also accepts twitter.com)
           *   - tiktok    → @handle */
          const stripUrl = (raw) => {
            return String(raw)
              .trim()
              .replace(/^https?:\/\//i, "")
              .replace(/^www\./i, "")
              .replace(/\/$/, "")             // trailing slash
              .split("?")[0]                  // drop query string
              .split("#")[0];                 // drop fragment
          };
          const normalize = (platform, raw) => {
            if (!raw) return "";
            let v = stripUrl(raw);
            /* Strip the platform's own domain prefix(es). Twitter accepted as
             * an X synonym; m.facebook.com / web.facebook.com etc. covered by
             * the leading-www strip above. */
            const domains = {
              facebook:  ["facebook.com/", "fb.com/", "fb.me/"],
              instagram: ["instagram.com/", "instagr.am/"],
              x:         ["x.com/", "twitter.com/"],
              tiktok:    ["tiktok.com/", "vm.tiktok.com/"],
            };
            for (const dom of (domains[platform] || [])) {
              if (v.toLowerCase().startsWith(dom)) v = v.slice(dom.length);
            }
            /* Drop any "/posts" or "/photos/..." sub-path — keep just the
             * first path segment (the handle). */
            v = v.split("/")[0];
            /* @-prefix policy:
             *   facebook = bare slug (no @)
             *   ig/x/tt  = always @handle */
            v = v.replace(/^@+/, "");
            if (platform !== "facebook" && v) v = "@" + v;
            return v.slice(0, 64);
          };
          const ALLOWED = ["facebook", "instagram", "x", "tiktok"];
          const cleaned = {};
          for (const k of ALLOWED) {
            if (typeof j.socials[k] === "string") cleaned[k] = normalize(k, j.socials[k]);
          }
          const brandPath = new URL("../config/brand.json", import.meta.url);
          let raw = {};
          try { raw = JSON.parse(await fs.readFile(brandPath, "utf8")); } catch {}
          raw.agency = {
            ...(raw.agency || {}),
            socials: { ...(raw.agency?.socials || {}), ...cleaned },
          };
          if (cleaned.instagram !== undefined) raw.agency.social = cleaned.instagram;
          await fs.writeFile(brandPath, JSON.stringify(raw, null, 2));
          invalidateBrandCache();
          updated.socials = cleaned;
        }

        if (j.location && typeof j.location === "object") {
          /* Reuses the existing /config/override behaviour: writes through to config.json,
           * sets lockLocation:true so IP autodetect on next boot won't overwrite. */
          const loc = j.location;
          if (loc.city) CONFIG.operator.city = String(loc.city);
          if (loc.country) CONFIG.operator.country = String(loc.country);
          if (typeof loc.latitude === "number") CONFIG.operator.latitude = loc.latitude;
          if (typeof loc.longitude === "number") CONFIG.operator.longitude = loc.longitude;
          if (loc.timezone) CONFIG.operator.timezone = String(loc.timezone);
          CONFIG.lockLocation = true;
          const cfgPath = new URL("../config.json", import.meta.url);
          await fs.writeFile(cfgPath, JSON.stringify(CONFIG, null, 2));
          updated.location = { city: CONFIG.operator.city, country: CONFIG.operator.country };
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, updated }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Serve generated videos and source plates. /output/<...> resolves under the
  // configurable output root (Paths.getOutputDir()), /shoots/<...> under the configurable
  // shoots root, and /assets/ stays pinned to the repo. Rewriting the URL prefix lets the
  // operator move their data to a NAS without changing any URL the HUD generates.
  if (req.url?.startsWith("/output/") || req.url?.startsWith("/shoots/") || req.url?.startsWith("/assets/")) {
    const safe = req.url.split("?")[0].replace(/\.\./g, "");
    let filePath;
    if (safe.startsWith("/output/")) {
      filePath = path.join(Paths.getOutputDir(), safe.slice("/output/".length));
    } else if (safe.startsWith("/shoots/")) {
      filePath = path.join(Paths.getShootsDir(), safe.slice("/shoots/".length));
    } else {
      filePath = path.join(PROJECT_ROOT, safe);
    }
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mime = ext === ".mp4" ? "video/mp4" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".png" ? "image/png" : "application/octet-stream";
        res.writeHead(200, { "content-type": mime, "content-length": s.size });
        createReadStream(filePath).pipe(res);
        return;
      }
    } catch { /* fall through to 404 */ }
  }

  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer });

const clients = new Set();
wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[bridge] client connected (${clients.size})`);
  ws.on("close", () => { clients.delete(ws); console.log(`[bridge] client disconnected (${clients.size})`); });

  /* Replay any tasks-recovered-at-boot events to this fresh HUD so the operator
   * sees what got interrupted by the last restart. The queue is drained on first
   * connect — second + later HUDs in the same bridge session don't replay (they
   * picked up live broadcasts since their connection started). */
  const replay = Tasks.drainPendingReplay();
  if (replay.length) {
    for (const evt of replay) { try { ws.send(JSON.stringify(evt)); } catch {} }
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { id, type, payload } = msg;
    const reply = (data) => ws.send(JSON.stringify({ id, type: `${type}.reply`, data }));
    const fail = (err) => ws.send(JSON.stringify({ id, type: `${type}.error`, error: String(err.message || err) }));

    try {
      switch (type) {
        case "llm.ask":     reply(await askLLM(payload.query, payload.history || [], { sessionId: payload?.sessionId, workspace: payload?.workspace || null })); break;

        /* Streaming variant — emits llm.sentence events as the model generates, then
         * resolves the request promise with the full text. The caller can either await
         * the reply (legacy path, gets the same string) OR subscribe to llm.sentence
         * for sentence-by-sentence TTS. RunId correlates events to a single utterance
         * so a stale stream's sentences don't bleed into a new one.
         *
         * sessionId (passed from the HUD's localStorage) groups turns from the same
         * HUD load so the history drawer can show "this session" vs older sessions. */
        case "llm.askStream": {
          const runId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const send = (subType, data) => ws.send(JSON.stringify({ type: subType, runId, ts: Date.now(), data }));
          send("llm.streamStart", { runId, query: payload.query });
          try {
            const text = await askLLMStream({
              query: payload.query,
              history: payload.history || [],
              sessionId: payload?.sessionId,
              /* Workspaces v4: HUD windows pinned to a specific workspace
               * forward that slug here so the LLM call dispatches in their
               * scope. Default windows omit the field; the bridge falls back
               * to the global active. */
              workspace: payload?.workspace || null,
              onSentence: (s) => send("llm.sentence", { runId, text: s }),
            });
            send("llm.streamDone", { runId, text });
            reply({ runId, text });
          } catch (e) {
            send("llm.streamError", { runId, error: String(e.message || e) });
            fail(e);
          }
          break;
        }
        case "weather": {
          /* Why: attach the operator's configured location so the HUD widget
           * can render "city, country" alongside the temperature. Without
           * this the widget falls back to its hardcoded default. Mirrors
           * the location-augment done for the show_weather_panel tool. */
          const w = await getWeather(payload?.lat, payload?.lon);
          reply({
            ...w,
            location: { name: CONFIG.operator.city, country: CONFIG.operator.country },
          });
          break;
        }
        /* HUD posts the source video the operator pasted/dropped for an
         * in-flight recreate_video_with_influencer call. The bridge
         * resolves the matching pending Promise so the tool execution
         * resumes. cancelled:true means the operator dismissed the modal. */
        case "influencer.source_provided": {
          const ok = resolvePendingSourceRequest({
            request_id: payload?.request_id,
            source_url: payload?.source_url,
            source_local_path: payload?.source_local_path,
            cancelled: !!payload?.cancelled,
          });
          reply({ ok });
          break;
        }
        /* HUD requests a list of locked influencers so the modal can
         * suggest names for autocomplete (e.g. on the recreation modal). */
        case "influencer.list":     reply(await Influencers.list()); break;
        case "video.edit": {
          // Production mode: cut existing footage from a shoot folder, no Fal cost.
          const send = (stage, info = {}) => ws.send(JSON.stringify({ id, type: "video.edit.progress", stage, ...info }));
          send("scanning");
          (async () => {
            try {
              const result = await buildProductionTeaser({
                shootFolder: payload?.shootFolder,
                subject: payload?.subject,
              });
              send("done", { runId: result.runId, durationSec: result.durationSec, finalUrl: `/output/${result.runId}/final.mp4` });
              reply({ ok: true, ...result, finalUrl: `/output/${result.runId}/final.mp4` });
            } catch (e) { fail(e); }
          })();
          break;
        }
        case "extract.subject": {
          // Quick LLM call to extract the video subject from a heard query
          const sys = "Extract the visual subject of a video request. Output JSON only: {\"subject\": \"...\"}.";
          const u = `Query: "${payload.query}". The subject is the THING the user wants the video to show — a vehicle, object, person, scene, etc. Keep it concise (2-6 words). If unclear, return {"subject": "Audi RS6"}.`;
          const r = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: getModel(), messages: [{ role: "system", content: sys }, { role: "user", content: u }], stream: false, format: "json" }),
          });
          const data = await r.json();
          let subject = "Audi RS6 Avant Performance in Nardo Grey";
          try { subject = JSON.parse(data.message.content).subject || subject; } catch {}
          reply({ subject });
          break;
        }
        default: fail(new Error(`unknown type: ${type}`));
      }
    } catch (e) { fail(e); }
  });
});

/* ---------- BROADCAST LIVE STATS ---------- */
let prevNet = null;
async function broadcastStats() {
  const [cpu, mem, gpu, net, disk, cpuTempC] = await Promise.all([getCpuPercent(), getMemoryStats(), getGpuStats(), getNetStats(), getDiskStats(), getCpuTemp()]);
  let netRate = { downKBs: 0, upKBs: 0 };
  if (prevNet) {
    const dt = (Date.now() - prevNet.t) / 1000;
    netRate.downKBs = Math.max(0, (net.rxBytes - prevNet.rx) / 1024 / dt);
    netRate.upKBs = Math.max(0, (net.txBytes - prevNet.tx) / 1024 / dt);
  }
  prevNet = { t: Date.now(), rx: net.rxBytes, tx: net.txBytes };

  /* loadAvg = OS-reported 1-min load average. Surfaced for the LOAD readout
   * alongside the CPU/GPU/RAM percentages so the operator can spot scheduler
   * pressure that a raw CPU% number doesn't capture. */
  const loadAvg = (os.loadavg && os.loadavg()[0]) ?? null;
  /* Apple Silicon temps + power via macmon (sudoless SMC reader). When
   * macmon isn't on the host these come back null and the HUD shows "—°".
   * macmon's reading takes precedence over the legacy osx-cpu-temp probe
   * because that one returns 0.0°C on M-series. */
  const mac = Macmon.getLatest();
  const stats = {
    cpu, mem, gpu, net: netRate, disk, loadAvg,
    cpuTempC: mac?.cpuTempC ?? cpuTempC,
    gpuTempC: mac?.gpuTempC ?? null,
    cpuPowerW: mac?.cpuPowerW ?? null,
    gpuPowerW: mac?.gpuPowerW ?? null,
    anePowerW: mac?.anePowerW ?? null,
    sysPowerW: mac?.sysPowerW ?? null,
  };
  /* Route through broadcastToClients so the stats envelope picks up the same
   * ts auto-stamp every other broadcast does — single envelope shape for all. */
  broadcastToClients({ type: "stats", data: stats });
}
setInterval(broadcastStats, 1500);
/* Spawn macmon (sudoless Apple Silicon temp + power monitor) so the HUD
 * gets real CPU/GPU °C and per-domain wattage. Graceful no-op if the binary
 * isn't installed — bridge keeps working with temps=null but the HUD shows
 * a one-time toast pointing the operator at `brew install macmon`. */
const _macmonOk = Macmon.start();
if (!_macmonOk) {
  SystemWarnings.register({
    code: "macmon-missing",
    title: "Apple Silicon temps unavailable",
    body: "Install macmon to see real CPU/GPU temperatures: brew install vladkens/tap/macmon",
    action: { label: "DOCS", href: "https://github.com/vladkens/macmon" },
  });
}

/* Workspaces v1: seed a default "personal" workspace on a fresh install
 * so the HUD chip has something to show. No-op when one already exists.
 * The seeded workspace becomes the active scope; the operator can rename
 * it, delete it, or create more via voice / the chip modal. */
const _seededWorkspace = Workspaces.seedDefaultIfEmpty();
if (_seededWorkspace) {
  applyWorkspaceOverrides(_seededWorkspace);
  console.log(`[workspaces] seeded default "${_seededWorkspace.slug}" workspace`);
}

/* Smart Inbox aggregator — wire the source-specific tool functions in so
 * inbox.mjs can pull mail / calendar / reminders without re-implementing
 * the AppleScript bridges or owning a circular import. */
Inbox.setSources({
  getMailSummary: (a) => getMailSummary(a || {}),
  getUpcomingEvents: (a) => getUpcomingEvents(a || {}),
  listReminders: (a) => Personal.listReminders(a || {}),
});

/* Workspaces v2 / v4: wire the active-workspace provider into Memory.
 * v4 adds per-call workspace scope (multi-window): when an LLM call is
 * pinned to a specific window's workspace, getCallWorkspace() returns
 * that slug and overrides the module-level active. Outside any call,
 * the module-level active wins (e.g. background memory writes from the
 * code agent or scheduled jobs). */
const _resolveWorkspace = () => getCallWorkspace() || Workspaces.getActive()?.slug || null;
Memory.setActiveWorkspaceProvider(_resolveWorkspace);
/* Workspaces v3 / v4: same provider for the audit log + creative-style.
 * NULL workspace on legacy rows leaks into every scope so pre-upgrade
 * history isn't trapped. */
Audit.setActiveWorkspaceProvider(_resolveWorkspace);

/* Why: schedule cache pruning so frame-cache + weather-cache + trackday sidecars
 * don't grow unbounded over a months-long kiosk uptime. Initial sweep at +5s so
 * boot isn't blocked; recurring every 6h. Runs in parallel with httpServer. */
CachePrune.scheduleHourly();
/* Memory hygiene at 03:30 daily — merge near-duplicate contacts + archive old
 * conversation summaries. Manual override available via the dream_cycle tool. */
DreamCycle.schedule();
/* EOD digest at 18:00 daily — surfaces the day's renders / PDFs / conversations
 * as a notification. Operator can ask for it on-demand via team_standup. */
DailyDigest.setBroadcaster(broadcastToClients);
DailyDigest.schedule();

httpServer.listen(PORT, () => {
  /* Brand banner — print once on startup if the terminal is wide enough to render
   * the FOM logo cleanly. Daemon-launched bridges write this to /tmp/jarvis-bridge.log
   * so it lands in the diagnostic trail too. */
  try {
    const cols = process.stdout.columns || 80;
    const banner = readFileSync(new URL("../assets/brand-ascii.txt", import.meta.url), "utf8");
    if (cols >= 145) console.log(`\x1b[31m${banner}\x1b[0m`);
  } catch {}
  console.log(`[bridge] listening on ws://localhost:${PORT}  (health: http://localhost:${PORT}/health)`);
  /* Why: snapshot the memory DB once per boot. Idempotent — skips if today's backup
   * already exists, prunes anything older than 30 days. Cheap (small DB) and protects
   * against the worst-case scenario: corrupt write losing client contacts. */
  Memory.backupMemoryDb();
  startInboxWatcher();

  /* Pre-warm Ollama / Kokoro / VL so the first operator query doesn't pay the 2-3s
   * cold-start tax. Fire-and-forget — failures log but don't block. SkipVL on lite
   * tier (16GB Mac) so we don't steal RAM the operator needs for other apps. The
   * tier is inferred from the configured text model size — anything above 14b
   * indicates the operator opted into the bigger-RAM flow. */
  const isLiteTier = /^(qwen2\.5:7b|qwen2\.5:3b)/i.test(getModel());
  warmUpAll({
    ollamaUrl: OLLAMA_URL,
    textModel: getModel(),
    vlModel: process.env.VL_MODEL || "qwen2.5vl:7b",
    textKeepAlive: process.env.OLLAMA_KEEP_ALIVE || "30s",
    vlKeepAlive: process.env.VL_KEEP_ALIVE || "30s",
    skipVL: isLiteTier,
  }).catch(() => { /* warmUpAll already logs internally */ });

  /* Sprint 12 — pre-warm the /diary AppleScript cache at boot. The HAR from
   * a 2-tab Chrome session showed every other bridge fetch queueing behind a
   * cold /diary call (5s AppleScript fanout) because Chrome's HTTP/1.1 pool
   * caps at 6 per origin. Firing one /diary fetch here means by the time the
   * HUD boots its diary cache is hot — every poll thereafter is a 1ms hit. */
  setTimeout(async () => {
    try {
      const t0 = Date.now();
      await fetch(`http://localhost:${PORT}/diary`).then((r) => r.json()).catch(() => null);
      console.log(`[warmup] /diary cache primed in ${Date.now() - t0}ms`);
    } catch { /* best-effort; if it fails the first HUD poll just pays the cost */ }
  }, 500);

  /* Build the embedding-based tool index. Fire-and-forget — pickRelevant()
   * falls back to the full TOOLS array until this resolves, so no chat call
   * is blocked. Subsequent boots load from data/tool-index.json instantly.
   *
   * Tiny delay so the plugin loader finishes first → plugin-registered tools
   * appear in the embedding index alongside built-ins. The loader takes
   * ~100ms in practice; 250ms is generous and still imperceptible. */
  setTimeout(() => {
    ToolRouter.buildIndex(TOOLS).catch((e) => console.warn(`[tool-router] index build failed: ${e.message} — chat will use full TOOLS catalogue`));
  }, 250);

  /* Pre-warm the fast model too if hardware tier opted into routing. Most weight
   * is on the main model so this second warm is cheap (small model, small RAM). */
  if (ModelRouter.isFastEnabled()) {
    fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: ModelRouter.config().fast,
        prompt: "1",
        stream: false,
        options: { num_predict: 1 },
        keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30s",
      }),
      signal: AbortSignal.timeout(60_000),
    }).then(() => console.log(`[warmup] fast model "${ModelRouter.config().fast}" ready`))
      .catch((e) => console.warn(`[warmup] fast model warmup failed: ${e.message}`));
  }
});

/* ---------- INBOX WATCHER ----------
 * Why: gives the operator a "drop and ask" UX — drop a PDF brief, image, or clip into
 * inbox/ and the assistant proactively offers to look at it. Faster than naming paths by voice.
 *
 * Events broadcast to all WS clients:
 *   { type: "inbox.dropped", data: { path, name, kind, sizeKB } }
 *
 * voice.js (HUD) listens, queues a spoken prompt while the assistant is idle, and on operator
 * confirmation routes the file by kind: image → describe_image, video → score_clip_for_trailer,
 * pdf → operator-prompted summary, audio → (future) transcribe.
 *
 * Recently-seen paths are deduped on a 5s window — fs.watch fires multiple events per file
 * write on macOS (rename + change), so without the dedupe we'd announce the same file twice. */
const INBOX_DIR = path.resolve(PROJECT_ROOT, "inbox");
const INBOX_DEDUP_MS = 5000;
const inboxRecent = new Map();  // path → timestamp

function inboxKindFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "heic", "tiff"].includes(ext)) return "image";
  if (["mp4", "mov", "m4v", "avi", "mkv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (["mp3", "wav", "m4a", "aac", "flac"].includes(ext)) return "audio";
  return "other";
}

async function startInboxWatcher() {
  const fs = await import("node:fs");
  const fsp = await import("node:fs/promises");
  try { await fsp.mkdir(INBOX_DIR, { recursive: true }); } catch {}
  console.log(`[inbox] watching ${INBOX_DIR}`);
  /* Why: fs.watch on macOS uses FSEvents — fires for any change in the dir (creation,
   * rename, attribute change). We filter to "rename" events and confirm the file actually
   * exists, otherwise a delete fires the same event. */
  fs.watch(INBOX_DIR, async (event, filename) => {
    if (!filename || filename.startsWith(".")) return;  // ignore hidden / .DS_Store
    const full = path.join(INBOX_DIR, filename);
    /* Dedupe — fs.watch on macOS often fires twice for a single write. */
    const now = Date.now();
    if (inboxRecent.has(full) && now - inboxRecent.get(full) < INBOX_DEDUP_MS) return;
    inboxRecent.set(full, now);
    /* Stale entries cleanup so the map doesn't grow unboundedly */
    for (const [k, t] of inboxRecent) if (now - t > 60_000) inboxRecent.delete(k);

    let st;
    try { st = await fsp.stat(full); }
    catch { return; }  // file gone (delete or move) — ignore
    if (!st.isFile() || st.size === 0) return;
    const kind = inboxKindFor(filename);
    console.log(`[inbox] dropped: ${filename} (${kind}, ${Math.round(st.size / 1024)}KB)`);
    broadcastToClients({
      type: "inbox.dropped",
      data: {
        path: path.relative(PROJECT_ROOT, full),
        name: filename,
        kind,
        sizeKB: Math.round(st.size / 1024),
      },
    });
  });
}

