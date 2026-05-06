/** server.mjs - Flat-Out HUD bridge.
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
import { buildProductionTeaser } from "./edit.mjs";
import * as Premiere from "./premiere.mjs";
import { createPdf, listTemplates as listPdfTemplates } from "./pdf.mjs";
import { getUpcomingEvents, addCalendarEvent } from "./calendar.mjs";
import { getMailSummary, draftEmail } from "./mail.mjs";
import { applyLightroomPreset, listLightroomPresets } from "./lightroom.mjs";
import { runShell, writeFileSandboxed, shellAllowlist } from "./shell.mjs";
import * as Memory from "./memory.mjs";
import * as Vision from "./vision.mjs";
import * as FrameIO from "./frameio.mjs";
import { generateShootReport } from "./reports.mjs";
import * as Agency from "./agency.mjs";
import * as Leads from "./leads.mjs";
import * as Youtube from "./youtube.mjs";
import { loadBrand, invalidateBrandCache } from "./brand.mjs";
import { creativeStylePromptBlock, loadCreativeStyle, invalidateCreativeStyleCache, creativeStylePath } from "./creative-style.mjs";
import * as Shotflag from "./shotflag.mjs";
import { buildHeroContactSheet } from "./contactsheet.mjs";
import { batchWatermark } from "./watermark.mjs";
import * as Rights from "./rights.mjs";
import { trackdayTag } from "./trackday.mjs";
import * as Tasks from "./tasks.mjs";
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
import * as PressRadar from "./press-radar.mjs";
import * as MediaDays from "./media-days.mjs";
import * as StyleMemory from "./style-memory.mjs";
import { autoCull } from "./autocull.mjs";
import { exportBrandPack } from "./brandpack.mjs";
import * as Purchases from "./purchases.mjs";
import * as Browse from "./browse.mjs";
import * as LlmProviders from "./llm/providers.mjs";
import * as Personal from "./personal.mjs";
import * as VisualStyle from "./visual-style.mjs";
import * as Transcribe from "./transcribe.mjs";
import * as ToolRouter from "./tool-router.mjs";

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
 * OLLAMA_MODEL, VL_MODEL, VL_KEEP_ALIVE, FRAMEIO_TOKEN. Loaded AFTER the FOM_ENV_PATH so
 * a per-install .env wins over a shared key file when both define the same var. */
const PROJECT_ENV_PATH = new URL("../.env", import.meta.url).pathname;
loadEnvFile(PROJECT_ENV_PATH);

/* Project root path — declared early so the boot summary block below can use
 * it without hitting the temporal-dead-zone. The same value is also re-derived
 * later in the file (one of those is now redundant; both expressions resolve
 * to the same path). */
const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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
  agency: { name: "Flat-Out Media", tagline: "we live and breathe automotive", social: "@flatoutmediauk", redHex: "#E10600" },
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
 * 64GB Mac. For FOM's production M5 Max 96GB+, set in .env:
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
 * non-developer reading /tmp/flat-out-bridge.log can see at a glance what's
 * configured and what's missing. Avoids forcing them to grep across 20 lines
 * for the bits that matter. Keys are reported as set/missing only, never the
 * value, matching the no-secrets-in-logs rule from SECURITY.md. */
const _bootKey = (name) => process.env[name] ? "set" : "(not set — feature disabled)";
console.log("[bridge] ── boot summary ──");
console.log(`[bridge]   Project root : ${PROJECT_ROOT}`);
console.log(`[bridge]   Text model   : ${getModel()}`);
console.log(`[bridge]   Vision model : ${process.env.VL_MODEL || "(unset)"}`);
console.log(`[bridge]   FRAMEIO      : ${_bootKey("FRAMEIO_TOKEN")}`);
console.log(`[bridge]   SERPAPI      : ${_bootKey("SERPAPI_KEY")}`);
console.log(`[bridge]   HUNTER       : ${_bootKey("HUNTER_API_KEY")}`);
console.log("[bridge] ──────────────────");

/* ---------- SYSTEM STATS ----------
 * Why: browsers are sandboxed from real CPU/RAM/net. We poll the OS here and push to clients. */
async function getCpuPercent() {
  // sample twice ~250ms apart, compute delta
  const a = os.cpus();
  await new Promise(r => setTimeout(r, 250));
  const b = os.cpus();
  let totalIdle = 0, totalTotal = 0;
  for (let i = 0; i < a.length; i++) {
    const tA = Object.values(a[i].times).reduce((s, n) => s + n, 0);
    const tB = Object.values(b[i].times).reduce((s, n) => s + n, 0);
    const idleDelta = b[i].times.idle - a[i].times.idle;
    const totalDelta = tB - tA;
    totalIdle += idleDelta;
    totalTotal += totalDelta;
  }
  return Math.max(0, Math.min(100, (1 - totalIdle / totalTotal) * 100));
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

  if (/\b(cpu|ram|memory|disk|storage|performance|usage|load|space)\b/.test(q)) {
    try {
      const [cpu, mem, disk] = await Promise.all([getCpuPercent(), getMemoryStats(), getDiskStats()]);
      ctx.push(`System: CPU ${cpu.toFixed(0)}%, RAM ${mem.usedGB.toFixed(1)}/${mem.totalGB.toFixed(0)} GB used, disk ${disk.usedTB.toFixed(2)}/${disk.totalTB.toFixed(2)} TB used.`);
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
      name: "premiere_open_project",
      description: "Open an existing Adobe Premiere Pro project (.prproj) on the operator's Mac.",
      parameters: { type: "object", properties: { projectPath: { type: "string" } }, required: ["projectPath"] },
    },
  },
  {
    type: "function",
    function: {
      name: "premiere_import_folder",
      description: "Import every video / photo file in a folder into the active Premiere Pro project. Use when the operator asks to bring footage from a shoot folder into the current project.",
      parameters: { type: "object", properties: { folderPath: { type: "string" } }, required: ["folderPath"] },
    },
  },
  {
    type: "function",
    function: {
      name: "premiere_create_sequence_from_folder",
      description: "Imports a folder of video clips into a new bin in Premiere AND creates a new sequence with those clips on the timeline. Use for 'build a rough cut from yesterday's shoot' type requests.",
      parameters: { type: "object", properties: { folderPath: { type: "string" }, name: { type: "string" } }, required: ["folderPath"] },
    },
  },
  {
    type: "function",
    function: {
      name: "premiere_render_active_sequence",
      description: "Queue the active Premiere sequence for render in Adobe Media Encoder. Use when operator says 'render this' or 'export the sequence'.",
      parameters: { type: "object", properties: { presetName: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "create_pdf",
      description: `Generate a branded Flat-Out Media PDF document. Available templates: ${listPdfTemplates().join(", ")}.\n\nFor 'quote': data = { client, project, lineItems: [{description, amount}], shootDates, validUntil, notes, vatRate }.\nFor 'brief': data = { client, subject, dates, location, deliverables, crew, objectives, shotList: [...], notes }.\nFor 'shoot-report': data = { client, subject, date, location, weather, crew, fileCount, summary, highlights: [...], issues, nextSteps }.\nFor 'press-release': data = { headline, subhead, dateline, lead, body, quote, quoteAttribution, boilerplate, contact, releaseDate }.`,
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
      name: "apply_lightroom_preset",
      description: "Apply a Lightroom develop preset to every RAW image in a folder by writing XMP sidecars. Doesn't need Lightroom open. Use when the operator says 'apply our standard preset to today's RAWs' etc.",
      parameters: {
        type: "object",
        properties: { folder: { type: "string" }, preset: { type: "string" } },
        required: ["folder", "preset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_lightroom_presets",
      description: "List available Lightroom presets the operator can apply.",
      parameters: { type: "object", properties: {} },
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
      name: "caption_shoot_folder",
      description: "Sample N media files from a shoot folder, caption each, return the digest. Use when the operator asks 'what's in the latest shoot', 'summarise the shoot', or 'what did we capture'. Defaults to most-recent folder if name omitted. Captions are cached so re-runs are instant.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder (e.g. '2026-05-01-press-car'). Optional — defaults to most recent." },
          sampleCount: { type: "number", description: "How many files to caption (default 8). Captions are evenly distributed across the folder." },
          prompt: { type: "string", description: "Optional custom caption angle, e.g. 'focus on lighting and angle for a director's-cut review'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_frame",
      description: "Semantic search across cached frame captions: 'find shots of the front grille', 'where do we have wheel close-ups', 'low-angle hero shot of the press car'. Returns ranked file paths. If a folder hasn't been captioned yet, this auto-warms the cache (16 samples) before searching.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language description of the shot you want to find." },
          folder: { type: "string", description: "Restrict search to one shoot folder (e.g. '2026-05-01-press-car'). Optional — searches all captioned frames if omitted." },
          limit: { type: "number", description: "Max results (default 5)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "score_clip_for_trailer",
      description: "Rate a video clip's suitability for a cinematic trailer (1-10) by sampling 6 frames and asking the VL model to judge motion, composition, lighting, subject clarity. Returns the score, a one-line reason, and the start time of the best 3-second segment within the clip. Use to deliberately pick hero clips for the teaser pipeline rather than relying on motion-energy heuristics alone.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the video clip (mp4/mov)." },
          frameCount: { type: "number", description: "Frames to sample (default 6). Higher = more accurate but slower." },
          style: { type: "string", description: "Style hint, e.g. 'cinematic-automotive', 'elegant-glamour', 'documentary'. Influences how the model rates frames." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_portrait_crop",
      description: "Identify the salient subject's bounding box in an image (or video keyframe), then compute centered crop windows for 9:16 / 1:1 / 4:5 aspects. Returns ready-to-use ffmpeg crop=W:H:X:Y commands. Use when the operator says 'reframe this for stories', 'make a vertical version', or 'where should I crop for Instagram'.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the image or video." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "crop_to_portrait",
      description: "Actually run the 9:16 (or 1:1, 4:5) crop and write the output to output/portraits/. Wraps find_portrait_crop + ffmpeg in one call. Use when the operator says 'export a vertical cut', 'crop this for Reels', etc.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to source image or video." },
          aspect: { type: "string", description: "Target aspect: '9:16' (default), '1:1', or '4:5'." },
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
      description: "Generate a YouTube video thumbnail (1280x720) for a shoot. Picks the strongest hero shot AND an engine bay close-up via vision (the engine inlay is the FOM client requirement — old thumbnails missed this). Layout: full-bleed hero with vignette, big yellow Anton-style headline rotated -2°, red subhead box, engine inlay bottom-right with red border, optional spec strip across bottom showing things like 'V10 · 5.0L · 510 BHP · 0-60 IN 3.2s'. Use when operator says 'make a thumbnail', 'YouTube thumb for [subject]', 'design a thumb with [headline] and [subhead]', or as part of 'a thumb and short for the [subject] shoot'.",
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
      name: "describe_shoot_with_specs",
      description: "Comprehensive briefing on a shoot — combines visual summary (what was photographed) with the vehicle's headline specs (engine size, BHP, drivetrain, 0-60, top speed) pulled from web search. Use when operator says 'tell me about the latest shoot', 'what's in today's shoot and what's the car', 'brief me on the recent shoot'. Defaults to most recent shoot folder if none specified.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder name. Defaults to latest." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_outreach_pack",
      description: "Generate the monthly cold-outreach lead pack: SerpAPI surfaces recent automotive press / launches / hiring, Hunter.io enriches with named contacts at those companies, Qwen drafts a personalised opener for each. Outputs a branded PDF the operator works through. Use when operator says 'build this month's outreach', 'find me leads', 'who should I email this month'. Requires SERPAPI_KEY + HUNTER_API_KEY in .env (setup-wizard prompts for both).",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "YYYY-MM tag for dedupe + naming. Default current month." },
          focus: { type: "string", description: "Optional override — e.g. 'McLaren' to focus the pack on one manufacturer rather than the full config list." },
          limit: { type: "number", description: "Max leads in the pack (default 20, max 50)." },
          dryRun: { type: "boolean", description: "Skip Hunter + Qwen, return discovered domains only — useful for previewing query reach without burning Hunter credits." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_outreach_leads",
      description: "List previously discovered outreach leads. Use to review last month's pack ('who didn't I get back to from October?') or surface uncontacted leads ('show me the leads I haven't actioned yet').",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "Optional YYYY-MM filter." },
          contacted: { type: "boolean", description: "true = only contacted, false = only uncontacted, omit = all." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_lead_contacted",
      description: "Mark a lead as contacted (used after the operator sends the cold email so future packs know to follow up rather than re-cold them). Voice: 'mark Ben at the client as contacted'.",
      parameters: {
        type: "object",
        properties: {
          email: { type: "string" },
        },
        required: ["email"],
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
      name: "generate_shoot_report",
      description: "Auto-generate a branded shoot report PDF from a shoot folder. AUTO-PULLS: image/video file counts, total payload size, shoot time-window from EXIF DateTimeOriginal, estimated edit time, and 4 hero shot picks via vision. Operator only needs to provide the folder name (or omit for the latest shoot) plus any context they want to add (location, weather, crew, notes). Use whenever the operator says 'draft a shoot report', 'wrap-up doc for the [subject] shoot', 'client report for today's session'. PDF opens in HUD modal automatically.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder name (e.g. '2026-05-01-press-car'). Omit to use most recent." },
          client: { type: "string", description: "Client name. Optional — defaults to inferred from folder." },
          subject: { type: "string", description: "Shoot subject. Optional — defaults to inferred from folder." },
          location: { type: "string" },
          weather: { type: "string" },
          crew: { type: "string", description: "Comma-separated names." },
          notes: { type: "string", description: "Free-form context to append to the auto-generated summary." },
          heroCount: { type: "number", description: "How many hero shots to feature (default 4)." },
        },
        required: ["folder"],
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
      name: "find_similar_shots",
      description: "Find similar shots ACROSS ALL captioned shoot folders, not just one. Use when operator references a past shot: 'we did this exact angle on the 720S — show me', 'find shots that look like this'. Captions the reference if needed, then semantic-searches every frame ever captioned.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the reference image." },
          limit: { type: "number", description: "Max matches (default 8)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "color_match_reference",
      description: "Analyse the colour grade of a reference image (warm/cool, contrast, saturation, dominant tints) and suggest Lumetri starting values the editor can dial in. Use when operator says 'match this look', 'what grade is this', 'how do I get this feel in Premiere'. Returns structured grade params, not an applied LUT.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Reference image or video keyframe path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "frameio_list_pending_review",
      description: "List Frame.io files that are currently in review status across the operator's account. Use when the operator asks 'what's pending review', 'what needs my approval on Frame.io', 'anything in the review queue'. Optionally narrow to a specific project name.",
      parameters: {
        type: "object",
        properties: {
          projectName: { type: "string", description: "Optional — restrict to a Frame.io project whose name contains this substring (case-insensitive)." },
          limit: { type: "number", description: "Max files to return (default 25)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "frameio_get_comments",
      description: "Read the review comments on a Frame.io file. Returns timecoded feedback. Use after frameio_list_pending_review or frameio_search_files surfaces a file ID, e.g. 'read me the comments on the press car v3'.",
      parameters: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "Frame.io file ID (UUID)." },
          limit: { type: "number" },
        },
        required: ["fileId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "frameio_add_comment",
      description: "Drop a comment on a Frame.io file, optionally pinned to a timecode. Use when the operator says 'leave a comment saying X' or 'reply with on it'. ALWAYS confirm the file and text with the operator before calling.",
      parameters: {
        type: "object",
        properties: {
          fileId: { type: "string", description: "Frame.io file ID." },
          text: { type: "string", description: "Comment text. British English unless instructed otherwise." },
          timecodeSec: { type: "number", description: "Optional — seconds into the clip to pin the comment to (e.g. 23 for 0:23)." },
        },
        required: ["fileId", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "frameio_set_status",
      description: "Change a Frame.io file's review status: in_progress, needs_review, approved, or rejected. Use when the operator says 'approve the manufacturer v3' or 'mark the press car teaser as needing more work'. Confirm BEFORE calling — status changes are visible to clients.",
      parameters: {
        type: "object",
        properties: {
          fileId: { type: "string" },
          status: { type: "string", enum: ["in_progress", "needs_review", "approved", "rejected"] },
        },
        required: ["fileId", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "frameio_search_files",
      description: "Search Frame.io files by name across the operator's account. Use when the operator references a clip by name ('the press car v3', 'the last shoot') and you need its file ID for get_comments / add_comment / set_status.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search across file names." },
          limit: { type: "number", description: "Max results (default 10)." },
        },
        required: ["query"],
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
      name: "flag_shot",
      description: "Flag a shot during/after a shoot so the editor finds it later. Use when the operator says 'flag this one as hero', 'mark the last shot as keep', 'skip the next three', 'remind me to reshoot the rear three-quarter'. Status MUST be one of: hero, keep, maybe, skip, reshoot. file omitted = flags the most recently modified file in the folder (so 'flag this one' / 'flag the last shot' works without dictating filenames).",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder name. Defaults to most recent." },
          file: { type: "string", description: "File name (basename, e.g. 'DSC0193.jpg'). Omit to flag the most recent media file." },
          status: { type: "string", enum: ["hero", "keep", "maybe", "skip", "reshoot"] },
          note: { type: "string", description: "Optional voice note ('rear 3/4 angle is soft', 'reshoot in afternoon light')." },
        },
        required: ["status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_shot_flags",
      description: "Read shot flags for a folder, optionally filtered by status. Use when the operator says 'show me what's flagged on the press car shoot', 'what did I mark for reshoot', 'list the heroes from yesterday'.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder name. Omit to list across all shoots." },
          status: { type: "string", enum: ["hero", "keep", "maybe", "skip", "reshoot"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clear_shot_flag",
      description: "Remove a single shot flag (operator made a mistake or the asset moved). Confirms before removal — no destructive surprise.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string" },
          file: { type: "string" },
        },
        required: ["folder", "file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hero_contact_sheet",
      description: "Generate a branded PDF contact sheet of the strongest 6-12 hero stills from a shoot folder. Auto-prioritises any shots flagged 'hero' via flag_shot, then tops up via Vision.find_frame using a hero-shot query. Use when the operator says 'give me a contact sheet of the heroes', 'pick eight hero shots for the client', 'lay out the best stills'. PDF auto-opens in HUD modal when ready.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder. Defaults to most recent." },
          count: { type: "number", description: "How many shots on the sheet (clamped 6-12, default 8)." },
          query: { type: "string", description: "Override the selection query — e.g. 'low-angle hero shots only', 'engine bay close-ups'." },
          client: { type: "string", description: "Optional client label printed on the document." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "batch_watermark",
      description: "Apply the FOM watermark to every still and clip in a folder. Outputs to output/watermarked/<runId>/. Defaults: bottom-right, 60% opacity, watermark scaled to 12% of frame width. Use when the operator says 'watermark the deliverables', 'brand all of today's shots', 'apply the wordmark to the gallery'. Source files are never modified.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Folder relative to shoots/ or output/, or absolute path." },
          watermark: { type: "string", description: "'fom' (default — wordmark), or path to a custom PNG." },
          opacity: { type: "number", description: "0.0-1.0 (default 0.6)." },
          scale: { type: "number", description: "Watermark width as fraction of frame width (default 0.12 = 12%)." },
          position: { type: "string", description: "bottom-right (default), bottom-left, top-right, top-left, centre." },
          marginPx: { type: "number", description: "Margin from corner in pixels (default 28)." },
          recursive: { type: "boolean", description: "Walk subfolders (default false)." },
          dryRun: { type: "boolean", description: "Plan without writing — useful for previewing scope." },
        },
        required: ["folder"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_release_from_bullets",
      description: "Take 4-5 dictated bullet points (or a free-form list) and produce a finished branded press release PDF. Use when the operator says 'draft a press release: the press car to Goodwood, July 18, AMR Pro showcase, sub-3s 0-60, client previews'. The model expands bullets into headline, subhead, dateline, lead, body (3-4 paragraphs), one quote where implied, and the FOM boilerplate. Opens for review — never sent.",
      parameters: {
        type: "object",
        properties: {
          bullets: { type: "array", items: { type: "string" }, description: "Operator's dictated bullets — at least two." },
          client: { type: "string", description: "Client / manufacturer (helps voice + boilerplate)." },
          subject: { type: "string", description: "Vehicle or event subject." },
          contact: { type: "string", description: "Press contact line. Defaults to FOM press address." },
          releaseDate: { type: "string", description: "ISO date (defaults to today)." },
          city: { type: "string", description: "Dateline city. Defaults to Leicester, UK." },
        },
        required: ["bullets"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_usage_rights",
      description: "Record a usage clearance for an asset: which client cleared what uses, until when, exclusive or not. Use when the operator says 'log that the client cleared IMG_001.jpg for web and social until end of June', 'record that McLaren bought exclusive on the orange shots'. Upserts on (asset, client) — re-recording supersedes the previous grant.",
      parameters: {
        type: "object",
        properties: {
          assetPath: { type: "string", description: "Asset path (e.g. 'shoots/2026-05-01-press-car/IMG_001.jpg')." },
          client: { type: "string" },
          uses: { type: "array", items: { type: "string", enum: ["web", "social", "print", "broadcast", "internal", "pitch", "exclusive", "all"] } },
          clearedBy: { type: "string", description: "Who at the client signed off." },
          clearedOn: { type: "string", description: "ISO date — defaults to today." },
          expiresOn: { type: "string", description: "ISO date — omit for perpetual." },
          exclusive: { type: "boolean", description: "True = no other client can be granted use." },
          notes: { type: "string" },
        },
        required: ["assetPath", "client", "uses"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_usage_rights",
      description: "Answer 'can client X use asset A for use Y?'. Returns one of: ok / ok-expiring / blocked / expired / unknown plus a reason safe to read aloud. Use when the operator asks 'can we put the press car front-three-quarter in McLaren's pitch deck?', 'is the wheel close-up cleared for print?', 'has anyone bought exclusive on the orange shots?'.",
      parameters: {
        type: "object",
        properties: {
          assetPath: { type: "string" },
          client: { type: "string" },
          use: { type: "string", enum: ["web", "social", "print", "broadcast", "internal", "pitch", "exclusive", "all"] },
        },
        required: ["assetPath", "client"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_usage_rights",
      description: "Audit usage rights — by client, by asset substring, or upcoming expiries. Use when the operator says 'what does the client have rights to', 'which clearances expire next month', 'show me all exclusives'.",
      parameters: {
        type: "object",
        properties: {
          client: { type: "string" },
          assetLike: { type: "string", description: "Substring filter on asset path." },
          expiringDays: { type: "number", description: "If set, only show grants expiring within this many days." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expire_usage_rights",
      description: "Manually revoke a client's clearance on an asset (campaign cancelled, scope reduced, exclusivity surrendered). Confirmation gate fires before this runs because it overwrites a documented grant. Voice flow: 'revoke the client's rights on the orange the press car shots'.",
      parameters: {
        type: "object",
        properties: {
          assetPath: { type: "string" },
          client: { type: "string" },
        },
        required: ["assetPath", "client"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trackday_tag",
      description: "Auto-tag a track-day or motorsport shoot folder with conditions metadata: time-of-day window, golden-hour status (morning/evening/non-golden), session slot (early-morning/morning/midday/afternoon/evening/dusk), and per-file weather (temp, precipitation, wind) pulled from Open-Meteo's free archive API using EXIF GPS. Writes a sidecar trackday-tags.json into the shoot folder so the editor can grep through later. Use when the operator says 'tag the track-day metadata', 'when did the rain start at Goodwood', 'tag conditions for the Bedford shoot'.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder. Defaults to most recent." },
          location: { type: "string", description: "Optional location override if EXIF GPS is missing (e.g. 'Goodwood', 'Bedford Autodrome')." },
          sampleCount: { type: "number", description: "How many files to tag (default 80, clamped 20-200). Evenly distributed across the folder." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_cycle_radar",
      description: "Sweep automotive press for recent launches / embargoed news from FOM's tracked manufacturers (the manufacturer, McLaren, Bentley, etc) at the major outlets (Top Gear, Autocar, Carwow, Motor1, Evo). Use when the operator says 'what's in the press cycle?', 'any pitch opportunities?', 'what's the client been doing this week?'. Optional manufacturer arg to focus on one. Runs automatically at 09:00 daily — manual invocation is for on-demand check-ins.",
      parameters: {
        type: "object",
        properties: {
          manufacturer: { type: "string", description: "Restrict to one manufacturer (overrides the configured list)." },
          dryRun: { type: "boolean", description: "Don't persist to data/press-signals.jsonl, just return findings." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_media_day",
      description: "Add a manufacturer media day, press day, track day, launch event, or embargo to the calendar. Use when the operator says 'add a media day for the manufacturer on June 15 at Goodwood' or when an email mentions an upcoming press event you should track. The date can be ISO ('2026-06-15') or freeform ('June 15', '15/6/26') — bare day-month inputs resolve to the next future occurrence.",
      parameters: {
        type: "object",
        properties: {
          manufacturer: { type: "string", description: "Brand name, e.g. 'the manufacturer'." },
          vehicle:      { type: "string", description: "Specific car / model if known, e.g. 'the new model S'." },
          date:         { type: "string", description: "ISO yyyy-mm-dd OR freeform like 'June 15'." },
          location:     { type: "string", description: "Venue, e.g. 'Goodwood', 'Silverstone'." },
          kind:         { type: "string", description: "press-day | track-day | launch | embargo | other (default press-day)." },
          notes:        { type: "string", description: "Free-form notes — invitee list, embargo time, dress code, etc." },
          sourceUrl:    { type: "string", description: "Press email URL or invite if available." },
        },
        required: ["manufacturer", "date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_media_days",
      description: "List upcoming manufacturer media days / press events. Defaults to the next 60 days. Use when the operator asks 'what's coming up at Goodwood?', 'any the client events this month?', 'what's on the press calendar?'. Filter by manufacturer to scope to one brand.",
      parameters: {
        type: "object",
        properties: {
          manufacturer: { type: "string", description: "Case-insensitive substring match — 'aston' matches 'Aston Martin' (matches by substring against the manufacturer name field)." },
          daysAhead:    { type: "number", description: "Upper bound on the date filter, default 60. Use 0 for all future events." },
          includesPast: { type: "boolean", description: "Include events whose date has already passed." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extract_style",
      description: "Analyse a folder of finished hero edits and save the grading signature as a named style. Use when the operator says 'capture the FOM look from these recent edits' or 'save this folder as our cinematic style'. Runs ImageMagick across up to 12 most-recent images, extracts colour balance / saturation / contrast / luminance, generates a colourist's prose description, and stores it in memory under the given name. Idempotent — re-running with the same name updates the existing style.",
      parameters: {
        type: "object",
        properties: {
          folder:      { type: "string", description: "Folder to analyse — under shoots/ OR an output/ subfolder of finished edits." },
          name:        { type: "string", description: "Style identifier, e.g. 'fom-signature' or 'cinematic-warm'." },
          sampleCount: { type: "number", description: "Max images to analyse (default 12)." },
          description: { type: "string", description: "Optional override description; otherwise generated from the numerical signature." },
          dryRun:      { type: "boolean", description: "Compute but don't save — use for previewing." },
        },
        required: ["folder", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_styles",
      description: "List all saved editorial styles with their descriptions + signatures. Use when the operator asks 'what styles do we have', 'list our looks'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_style",
      description: "Recall one named editorial style — returns the description + numerical signature so the editor can match it. Use when the operator says 'what's our FOM look', 'remind me of the cinematic-warm style', 'what does the signature grade look like'.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Style identifier, e.g. 'fom-signature'." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_to_style",
      description: "Compare a folder's current grade against a saved style. Returns delta values + adjustment advice (e.g. 'cool by 0.03; raise contrast by 0.04'). Use when the operator says 'how does this Bentley footage compare to the FOM look', 'is this on style', 'what would I need to push to match cinematic-warm'.",
      parameters: {
        type: "object",
        properties: {
          folder:      { type: "string", description: "Folder of candidate images to compare." },
          styleName:   { type: "string", description: "Saved style to compare against." },
          sampleCount: { type: "number", description: "Max images to sample (default 8)." },
        },
        required: ["folder", "styleName"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_style",
      description: "Delete a saved editorial style by name. Confirm before calling — this is irreversible.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Style identifier to remove." } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_media_day",
      description: "Remove a media-day entry from the calendar by id (returned from list_media_days). Use when the operator says 'cancel the new model press day' — first call list_media_days to find the id, then call this with confirmation.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "The id field returned by list_media_days." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pre_shoot_checklist",
      description: "Generate a kit checklist for an upcoming shoot. Pulls live weather forecast for the location + date, and asks the model to tailor kit decisions to vehicle type, indoor/outdoor, crew count, and duration. Use when the operator says 'kit check for tomorrow's Bentley shoot at Goodwood', 'what should we pack for Friday's track day', 'pre-shoot list for the McLaren launch'. Returns structured cameras / lenses / lighting / audio / comms / power / weatherProtection sections. Operator can call create_pdf with template:'brief' to print it if needed.",
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "Shoot name or subject (e.g. 'the hero at Goodwood')." },
          vehicleType: { type: "string", description: "e.g. 'sportscar', 'SUV', 'classic', 'open-wheeler'." },
          location: { type: "string", description: "Place name for weather lookup (e.g. 'Goodwood', 'Bedford Autodrome')." },
          indoor: { type: "boolean", description: "true = studio/indoor, false = outdoor, omit for mixed." },
          crewCount: { type: "number", description: "Number of crew on day. Drives comms + power needs." },
          durationHours: { type: "number", description: "Shoot length in hours. Drives battery + media counts." },
          weatherDate: { type: "string", description: "ISO date for forecast (default tomorrow)." },
        },
      },
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
      name: "auto_cull",
      description: "Automatically cull near-duplicate stills from a shoot folder. Captions every still via Vision, groups by caption-embedding cosine similarity above the threshold (default 0.92), then keeps the alphabetically-first file in each duplicate group and flags the rest as 'skip'. Saves 30-60 minutes of manual culling per shoot. Voice flow: 'cull today's shoot', 'auto-cull the press car folder'. Use dryRun:true to preview before committing.",
      parameters: {
        type: "object",
        properties: {
          folder: { type: "string", description: "Shoot folder name. Defaults to most recent." },
          threshold: { type: "number", description: "Cosine similarity threshold for 'duplicate' (0.7-0.99, default 0.92). Higher = stricter dedup." },
          sampleCount: { type: "number", description: "How many files to caption (default 120, max 500)." },
          dryRun: { type: "boolean", description: "Report what would be culled without flagging — preview pass." },
        },
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
      name: "video_edit_from_shoot",
      description: "Cut a Top Gear / Gran Turismo style 30-second teaser from a shoot folder under shoots/. Scans the latest folder by default OR a specific subject if named. Returns immediately with 'started' status — render takes 2-3 minutes and result plays automatically in the HUD. Use whenever the operator says 'edit a teaser', 'cut a reel', 'build a video', etc. Accepts customText for a closing title card AND music for a backing track that beat-syncs the cuts.",
      parameters: {
        type: "object",
        properties: {
          subject: { type: "string", description: "Optional subject name (e.g. 'the press car'). If omitted, uses the most recent shoot folder." },
          customText: { type: "string", description: "Optional closing title card text — appears near the end of the teaser. Keep short (1-5 words ideally), will be uppercased automatically and stacked one-word-per-line." },
          music: { type: "string", description: "Optional backing track. Use a mood ('epic', 'driving', 'cinematic', 'action') and the system picks a matching track from the library; OR pass 'none' to skip music entirely (source video audio only). When music is on, all cuts beat-sync to the track's BPM." },
        },
      },
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
      name: "learn_visual_style",
      description: "Analyse a folder, file, or list of reference frames/videos to capture the operator's visual style. Combines numerical metrics (brightness/contrast/saturation curves via ImageMagick) with a vision-LLM prose description (palette, lighting, framing, grading). Use for: 'learn my style from these reference shoots', 'capture the FOM look from output/heroes/'. For videos, ffmpeg samples 4 keyframes per file. Stored alongside the existing style memory so 'apply my style' tools can recall it later.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Folder path (preferred — ships numerical + prose), or single file path. For multiple unrelated files, call once per file." },
          name:   { type: "string", description: "Style identifier — e.g. 'fom-signature', 'editorial-warm'. Existing styles with the same name are overwritten." },
          sampleCount:    { type: "number", description: "Max frames sent to the vision model. Default 12." },
          framesPerVideo: { type: "number", description: "Keyframes extracted per video file. Default 4." },
        },
        required: ["target", "name"],
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
/* Wire the personal-assistant timer broadcaster — fires timer.set/timer.fire/timer.cancel
 * events the HUD listens for to render the countdown badge + speak the label on fire. */
Personal.setBroadcaster(broadcastToClients);
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
 * The summary is built per-tool so the operator hears the consequential details
 * ("send email TO ben@... ABOUT the press car v3 — proceed?") not a generic prompt. */
const NEEDS_CONFIRMATION = {
  draft_email: (a) => `Draft email to ${a.to || "(no recipient)"} with subject "${a.subject || "(no subject)"}". Send it?`,
  add_calendar_event: (a) => `Add calendar event "${a.title || "(no title)"}" on ${a.startDate || a.date || "(no date)"}. Confirm?`,
  frameio_add_comment: (a) => `Post comment on Frame.io file ${a.fileId?.slice(0, 8) || "(no id)"}: "${(a.text || "").slice(0, 80)}"${a.timecodeSec ? ` at ${a.timecodeSec}s` : ""}. Send to client?`,
  frameio_set_status: (a) => `Change Frame.io file ${a.fileId?.slice(0, 8) || "(no id)"} status to "${a.status}". Notifies the client. Confirm?`,
  video_edit_from_shoot: (a) => `Render a teaser from ${a.subject ? `"${a.subject}"` : "the latest shoot"}${a.customText ? ` with closing card "${a.customText}"` : ""}. Takes 2-3 minutes. Start?`,
  apply_lightroom_preset: (a) => `Apply Lightroom preset "${a.preset || "(none)"}" to ${a.folder || "(folder)"}. Writes XMP sidecars. Confirm?`,
  premiere_render_active_sequence: (a) => `Render the active Premiere sequence with preset "${a.presetName || "default"}". Confirm?`,
  crop_to_portrait: (a) => `Crop ${a.path || "(file)"} to ${a.aspect || "9:16"} and write to output/portraits/. Confirm?`,
  run_shell: (a) => `Run shell command: ${(a.command || "").slice(0, 120)}${a.command?.length > 120 ? "…" : ""}. Confirm?`,
  write_file: (a) => `Write to ${a.relPath || "(no path)"} (${(a.content || "").length} bytes). Confirm?`,
  batch_watermark: (a) => `Watermark every still and clip in ${a.folder || "(folder)"} (${a.position || "bottom-right"} at ${Math.round((a.opacity ?? 0.6) * 100)}%). Output to output/watermarked/. Confirm?`,
  expire_usage_rights: (a) => `Revoke ${a.client || "(client)"}'s rights on ${a.assetPath || "(asset)"}. Confirm?`,
  /* Why: only gate exclusivity grants — they bind the agency long-term and block all
   * other clients from the asset. Routine non-exclusive grants would be too noisy. */
  add_usage_rights: (a) => a?.exclusive
    ? `Record EXCLUSIVE rights for ${a.client || "(client)"} on ${a.assetPath || "(asset)"} — no other client can be granted use. Confirm?`
    : null,
  delete_media_day: (a) => `Remove media-day entry #${a.id || "(no id)"} from the calendar. Confirm?`,
  delete_style: (a) => `Delete editorial style "${a.name || "(no name)"}". This is irreversible. Confirm?`,
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
  "video_edit_from_shoot", "generate_youtube_short", "generate_youtube_thumbnail",
  "generate_youtube_promo", "build_brand_pack", "batch_watermark",
  "build_contact_sheet", "caption_shoot_folder", "run_shell",
  "premiere_render_active_sequence", "premiere_create_sequence_from_folder",
  "premiere_import_folder", "apply_lightroom_preset", "crop_to_portrait",
  "draft_email", "add_calendar_event", "create_pdf",
  "frameio_add_comment", "frameio_set_status",
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
    case "video_edit_from_shoot": return `Cut a teaser from ${a.subject ? `the ${a.subject} shoot` : "the latest shoot"}`;
    case "generate_youtube_short": return `Render a 9:16 YouTube short for ${a.subject || "the latest shoot"}`;
    case "generate_youtube_thumbnail": return `Generate a YouTube thumbnail for ${a.subject || "the latest shoot"}`;
    case "generate_youtube_promo": return `Build a YouTube promo (thumbnail + short) for ${a.subject || "the latest shoot"}`;
    case "build_brand_pack": return `Build a brand pack for ${a.path || "(asset)"}`;
    case "batch_watermark": return `Watermark every file in ${a.folder || "(folder)"}`;
    case "build_contact_sheet": return `Build a contact sheet for ${a.folder || "the latest shoot"}`;
    case "caption_shoot_folder": return `Caption ${a.sampleCount || 8} frames from ${a.folder || "the latest shoot"}`;
    case "run_shell": return `Run shell: ${(a.command || "").slice(0, 60)}${(a.command || "").length > 60 ? "…" : ""}`;
    case "premiere_render_active_sequence": return `Render the active Premiere sequence`;
    case "draft_email": return `Draft email to ${a.to || "(recipient)"} — ${(a.subject || "").slice(0, 50)}`;
    case "add_calendar_event": return `Add calendar event "${(a.title || "").slice(0, 40)}" on ${a.start || "(date)"}`;
    case "create_pdf": return `Generate ${a.template || "(template)"} PDF`;
    case "frameio_add_comment": return `Comment on Frame.io clip — "${(a.text || "").slice(0, 50)}"`;
    case "frameio_set_status": return `Set Frame.io status to ${a.status || "(status)"}`;
    case "apply_lightroom_preset": return `Apply preset ${a.preset || "(preset)"} to ${a.folder || "(folder)"}`;
    case "crop_to_portrait": return `Crop ${a.path || "(file)"} to ${a.aspect || "9:16"}`;
    case "request_purchase": {
      const amt = Number.isFinite(Number(a.maxPriceGbp)) ? `£${Number(a.maxPriceGbp).toFixed(2)}` : "(no price)";
      return `Buy ${a.item || "(item)"} from ${a.merchant || "(merchant)"} for up to ${amt}`;
    }
    case "search_products":
      return `Compare on ${a.merchant || "(?)"}: ${(a.query || "").slice(0, 50)}`;
    case "find_flights":
      return `Find flights ${a.from || "?"} → ${a.to || "?"} on ${a.depart || "?"}${a.returnDate ? ` returning ${a.returnDate}` : ""}`;
    case "learn_visual_style":
      return `Learn style "${a.name || "?"}" from ${typeof a.target === "string" ? a.target.slice(0, 50) : "(reference set)"}`;
    case "transcribe_video":
      return `Transcribe video: ${(a.path || "(?)").slice(0, 60)}${a.includeVisual === false ? " (audio only)" : ""}`;
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
      return {
        ok: false,
        requires_confirmation: summary,
        hint: "Read the requires_confirmation message aloud verbatim, then wait for 'yes'/'go ahead'/'proceed'. Only after operator confirms, call this tool again with the SAME arguments plus confirmed: true.",
      };
    }
  }
  switch (name) {
    case "web_search": {
      const results = await webSearch(String(args.query || "").trim(), 5);
      return { results };
    }
    case "send_imessage":  return await Personal.sendIMessage(args);
    case "add_reminder":   return await Personal.addReminder(args);
    case "set_timer":      return Personal.setTimer(args);
    case "list_timers":    return { ok: true, timers: Personal.listTimers() };
    case "cancel_timer":   return Personal.cancelTimer(args);
    case "play_music":     return await Personal.playMusic(args);
    case "pause_music":    return await Personal.pauseMusic(args);
    case "read_article":   return await Personal.readArticle(args);
    case "take_screenshot":return await Personal.takeScreenshot(args);
    case "set_focus":      return await Personal.setFocus(args);
    case "lookup_password":return await Personal.lookupPassword(args);
    case "compose_note":   return await Personal.composeNote(args);
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
    case "learn_visual_style": return await VisualStyle.learnVisualStyle(args);
    case "transcribe_video":   return await Transcribe.transcribeVideo(args);
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
    case "premiere_open_project":              return await Premiere.premiereOpenProject(args.projectPath);
    case "premiere_import_folder":             return await Premiere.premiereImportFolder(args.folderPath);
    case "premiere_create_sequence_from_folder": return await Premiere.premiereCreateSequenceFromFolder(args.folderPath, args.name);
    case "premiere_render_active_sequence":    return await Premiere.premiereRenderActiveSequence(args.presetName);
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
    case "get_upcoming_events":                return await getUpcomingEvents({ days: args.days, calendarName: args.calendarName });
    case "add_calendar_event": {
      /* Broadcast a diary.refresh hint so the HUD's TODAY widget picks up the new event
       * immediately rather than waiting for the next poll tick. The HUD may briefly show
       * the previous state until the post-broadcast pollDiary fetch completes (~250ms),
       * which is still much better than waiting up to a minute. */
      const r = await addCalendarEvent(args);
      if (r?.ok) broadcastToClients({ type: "diary.refresh" });
      return r;
    }
    case "get_mail_summary":                   return await getMailSummary({ unreadOnly: args.unreadOnly, max: args.max });
    case "draft_email":                        return await draftEmail(args);
    case "apply_lightroom_preset":             return await applyLightroomPreset(args);
    case "list_lightroom_presets":             return await listLightroomPresets();
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
    case "caption_shoot_folder":               return await Vision.captionShootFolder(args || {});
    case "find_frame":                         return await Vision.findFrame(args || {});
    case "score_clip_for_trailer":             return await Vision.scoreClipForTrailer(args || {});
    case "find_portrait_crop":                 return await Vision.findPortraitCrop(args || {});
    case "crop_to_portrait":                   return await Vision.cropToPortrait(args || {});
    case "export_all_aspects":                 return await Vision.exportAllAspects(args || {});
    case "find_similar_shots":                 return await Vision.findSimilarShots(args || {});
    case "color_match_reference":              return await Vision.colorMatchReference(args || {});
    case "frameio_list_pending_review":        return await FrameIO.listPendingReview(args || {});
    case "frameio_get_comments":               return await FrameIO.getComments(args || {});
    case "frameio_add_comment":                return await FrameIO.addComment(args || {});
    case "frameio_set_status":                 return await FrameIO.setAssetStatus(args || {});
    case "frameio_search_files":               return await FrameIO.searchFiles(args || {});
    case "generate_social_captions":           return await Agency.generateSocialCaptions(args || {});
    case "check_brand_tone":                   return await Agency.checkBrandTone(args || {});
    case "hashtag_research":                   return await Agency.hashtagResearch(args || {});
    case "vehicle_spec_lookup":                return await Agency.vehicleSpecLookup(args || {});
    case "ask_internal":                       return await Agency.askInternal(args || {});
    case "team_standup":                       return await Agency.teamStandup(args || {});
    case "generate_outreach_pack": {
      /* Why: outreach packs are slow (multi-API + multi-LLM personalisation), so the tool
       * runs synchronously rather than async-broadcasting like the teaser pipeline. The
       * trade-off is voice latency — Qwen will say "working on it" and the operator waits
       * 1-3 minutes. PDF still pops a HUD modal via pdf.complete event for consistency. */
      const r = await Leads.generateOutreachPack(args || {});
      if (r.ok && r.pdf) {
        broadcastToClients({
          type: "pdf.complete",
          data: {
            url: r.pdf.url,
            template: "outreach-pack",
            title: `Outreach Pack — ${r.month}`,
            sizeKB: Math.round(r.pdf.size / 1024),
          },
        });
      }
      return r;
    }
    case "list_outreach_leads":                return { ok: true, leads: Leads.listLeads(args || {}) };
    case "mark_lead_contacted":                return Leads.markLeadContacted(args || {});
    case "generate_youtube_thumbnail": {
      /* Why: thumbnail generation is fast (~5-10s) but picking the engine shot needs VL.
       * Broadcast stage events so the screen-recorded demo shows progress ticking. */
      const broadcast = (stage, info = {}) => broadcastToClients({ type: "yt.thumbnail.progress", stage, ...info });
      const r = await Youtube.generateYoutubeThumbnail(args || {}, broadcast);
      if (r.ok) {
        broadcastToClients({
          type: "yt.thumbnail.complete",
          data: { url: r.url, headline: r.headline, subhead: r.subhead, sizeKB: r.sizeKB },
        });
      }
      return r;
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
    case "describe_shoot_with_specs":          return await Agency.describeShootWithSpecs(args || {});
    case "generate_youtube_promo": {
      /* Combined thumbnail + short — preferred when the operator asks for "a thumbnail
       * and a short" in one breath, which the 14b model wasn't reliably chaining as
       * two separate tool calls. */
      const broadcast = (stage, info = {}) => broadcastToClients({ type: "yt.thumbnail.progress", stage, ...info });
      if (currentVideoRun && !currentVideoRun.done) {
        return { ok: false, status: "busy", note: "Another video edit is already running." };
      }
      const promoSubject = args?.subject || args?.folder || "latest shoot";
      const promoRunId = Tasks.startTask({
        kind: "yt.promo",
        label: `YT Promo · ${promoSubject}${args?.headline ? ` · "${args.headline}"` : ""}`,
        etaSec: 180,
      });
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
    case "generate_shoot_report": {
      /* Why: generate_shoot_report builds a PDF and broadcasts a pdf.complete event so
       * the HUD pops the modal — same pattern as create_pdf. The tool returns a summary
       * for Qwen to read aloud (file counts, edit-time estimate, hero count). */
      const reportRunId = Tasks.startTask({
        kind: "shoot.report",
        label: `Shoot report · ${args.subject || args.folder || "latest"}`,
        etaSec: 60,
      });
      try {
        const r = await generateShootReport(args || {});
        if (r.ok && r.pdf) {
          Tasks.completeTask(reportRunId, { pdfUrl: r.pdf.url });
          broadcastToClients({
            type: "pdf.complete",
            runId: reportRunId,
            data: {
              url: r.pdf.url,
              template: "shoot-report",
              title: `${args.subject || args.folder} — Shoot Report`,
              sizeKB: Math.round(r.pdf.size / 1024),
            },
          });
        } else {
          Tasks.errorTask(reportRunId, r?.error || "report generation failed");
        }
        return r;
      } catch (err) {
        Tasks.errorTask(reportRunId, err);
        throw err;
      }
    }
    case "get_capabilities": {
      // Enumerate runtime state the LLM might need before making decisions
      const fs = await import("node:fs/promises");
      let shootFolders = [];
      try {
        const ents = await fs.readdir(Paths.getShootsDir(), { withFileTypes: true });
        shootFolders = ents.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
      } catch {}
      const lp = await listLightroomPresets();
      const musicMod = await import("./music.mjs");
      const tracks = await musicMod.listTracks();
      return {
        ok: true,
        hardware: CONFIG.hardware,
        operator: { city: CONFIG.operator.city, country: CONFIG.operator.country, timezone: CONFIG.operator.timezone },
        agency: CONFIG.agency,
        shootFolders,
        lightroomPresets: lp.presets || [],
        pdfTemplates: listPdfTemplates(),
        voices: ["bm_daniel", "bm_george", "bm_lewis", "bm_fable", "bf_emma", "bf_alice", "bf_isabella", "bf_lily"],
        videoEffects: ["normal", "speed-up", "slow-mo", "punch-zoom", "flash-in", "freeze-hit"],
        musicTracks: tracks,
        musicMoods: ["epic", "driving", "cinematic", "action", "chase"],
        videoNote: "Teaser pipeline already includes flash cuts, speed ramps, punch zooms, FOM intro+outro, panel cards, single-word stacked tail card. Music auto-picks from available library and beat-syncs cuts to the track BPM. customText for closing card; pass music='none' to skip backing track.",
        shellAllowlist: shellAllowlist(),
        shellNote: "When no curated tool fits, you can call run_shell to compose ad-hoc commands using the allowlisted binaries. Sandboxed to project dir, dangerous patterns blocked.",
        memory: Memory.memoryStats(),
        memoryNote: "Persistent memory across sessions. Use get_contact before draft_email, recall for past discussions, remember for stable preferences, save_conversation at session end.",
        vision: Vision.visionStats(),
        visionNote: "Local Qwen 2.5-VL can caption images and video keyframes. Use describe_image for single files, caption_shoot_folder for batches, find_frame for semantic shot search.",
        frameio: FrameIO.frameioStatus(),
        frameioNote: "Frame.io review-by-voice. Set FRAMEIO_TOKEN in .env (developer token from https://developer.frame.io/app). When configured, frameio_* tools list pending reviews, read/post comments, set approval status.",
      };
    }
    case "flag_shot": {
      const r = await Shotflag.flagShot(args || {});
      if (r.ok) {
        /* Why: most-likely mishear is "skip this" / "keep this" / "hero this" — a
         * single inverse (clear the flag) covers the common case. Restoring a
         * prior status is a future enhancement; v1 just removes the flag. */
        Undo.push({
          description: `Clear ${r.status} flag on ${r.file} in ${r.folder}`,
          run: async () => Shotflag.clearShotFlag({ folder: r.folder, file: r.file }),
        });
      }
      return r;
    }
    case "list_shot_flags":                    return Shotflag.listShotFlags(args || {});
    case "clear_shot_flag":                    return Shotflag.clearShotFlag(args || {});
    case "hero_contact_sheet": {
      /* Why: hero contact sheet builds a PDF — broadcast pdf.complete so the HUD pops it
       * the same way create_pdf and generate_shoot_report do. */
      const r = await buildHeroContactSheet(args || {});
      if (r.ok && r.pdf) {
        broadcastToClients({
          type: "pdf.complete",
          data: {
            url: r.pdf.url,
            template: "contact-sheet",
            title: `${r.subject || r.folder} — Contact Sheet`,
            sizeKB: Math.round(r.pdf.size / 1024),
          },
        });
      }
      return r;
    }
    case "batch_watermark":                    return await batchWatermark(args || {});
    case "press_release_from_bullets": {
      const r = await Agency.pressReleaseFromBullets(args || {});
      if (r.ok && r.pdf) {
        broadcastToClients({
          type: "pdf.complete",
          data: {
            url: r.pdf.url,
            template: "press-release",
            title: r.headline || "Press Release",
            sizeKB: Math.round(r.pdf.size / 1024),
          },
        });
      }
      return r;
    }
    case "add_usage_rights":                   return Rights.addUsageRights(args || {});
    case "check_usage_rights":                 return Rights.checkUsageRights(args || {});
    case "list_usage_rights":                  return Rights.listUsageRights(args || {});
    case "expire_usage_rights":                return Rights.expireUsageRights(args || {});
    case "trackday_tag":                       return await trackdayTag(args || {});
    case "undo_last": {
      /* Reverse the most recent undoable action. Stack is small (8 entries) and
       * lives in-process; on bridge restart the stack is empty. */
      return await Undo.pop();
    }
    case "read_active_window":                 return await Window.readActiveWindow();
    case "dream_cycle":                        return await DreamCycle.runCycle(args || {});
    case "auto_cull":                          return await autoCull(args || {});
    case "brand_pack_export":                  return await exportBrandPack(args || {});
    case "pre_shoot_checklist":                return await Agency.preShootChecklist(args || {});
    case "press_cycle_radar":                  return await PressRadar.runRadar(args || {});
    case "add_media_day":                      return MediaDays.addMediaDay(args || {});
    case "list_media_days":                    return { events: MediaDays.listMediaDays(args || {}) };
    case "delete_media_day":                   return MediaDays.deleteMediaDay(args || {});
    case "extract_style":                      return await StyleMemory.extractStyle(args || {});
    case "list_styles":                        return { styles: StyleMemory.listStyles() };
    case "recall_style":                       return StyleMemory.recallStyle(args || {}) || { ok: false, error: `style not found: ${args?.name}` };
    case "delete_style":                       return StyleMemory.deleteStyle(args || {});
    case "compare_to_style":                   return await StyleMemory.compareToStyle(args || {});
    case "video_edit_from_shoot": {
      if (currentVideoRun && !currentVideoRun.done) {
        return { ok: false, status: "busy", note: "Another video edit is already running." };
      }
      const subject = args && args.subject ? String(args.subject) : null;
      const customText = args && args.customText ? String(args.customText) : null;
      const music = args && args.music !== undefined ? args.music : "auto";
      /* Why: task lifecycle gives the HUD's task strip a stable runId for the whole
       * render. Existing video.edit.complete event still fires too — modal-pop logic
       * keeps working unchanged. ETA at 150s is a working average from production runs. */
      const runId = Tasks.startTask({
        kind: "video.edit",
        label: `Teaser · ${subject || "latest shoot"}${customText ? ` · "${customText}"` : ""}`,
        etaSec: 150,
      });
      currentVideoRun = { startedAt: Date.now(), done: false, subject, runId };
      /* onStage callback pumps lane-grouped progress into the task strip — the
       * operator sees the pipeline move through scanning → planning → encoding → final. */
      const onStage = (stageName, percent) => Tasks.progressTask(runId, { stage: stageName, percent });
      buildProductionTeaser({ subject, customText, music, onStage }).then((result) => {
        currentVideoRun.done = true;
        Tasks.completeTask(runId, { finalUrl: `/output/${result.runId}/final.mp4` });
        broadcastToClients({
          type: "video.edit.complete",
          data: {
            runId: result.runId,
            subject: result.subject,
            durationSec: result.durationSec,
            finalUrl: `/output/${result.runId}/final.mp4`,
          },
        });
      }).catch((err) => {
        currentVideoRun.done = true;
        Tasks.errorTask(runId, err);
        broadcastToClients({ type: "video.edit.error", runId: currentVideoRun?.runId, data: { error: String(err.message || err) } });
      });
      return { ok: true, status: "started", runId, subject: subject || "(latest shoot folder)", note: "Render takes 2-3 minutes. Will play automatically when ready." };
    }
    default: return { error: `unknown tool: ${name}` };
  }
}

async function askLLM(query, history = [], { sessionId = null } = {}) {
  const brand = loadBrand();
  const agencyName = brand.agency.name || CONFIG.agency.name;
  const agentName = brand.agent.name || "Flat-Out";
  const tagline = brand.agency.tagline ? ` — ${brand.agency.tagline}.` : ".";
  /* Why: active-project context becomes part of the system prompt so tool calls
   * default to the operator's current scope without re-asking. Empty string when
   * no project is set — costs nothing in tokens. */
  const projectHint = Projects.systemPromptHint();
  /* Build "today" + "tomorrow" context strings. Why: without these the model has
   * no anchor for date-relative queries like "anything in my diary today/tomorrow"
   * — it returns 7 days of events from get_upcoming_events but can't filter to the
   * right day, often answers "no events today" even when there's one in the data. */
  const _now = new Date();
  const _todayStr = _now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const _tomorrow = new Date(_now.getTime() + 86_400_000);
  const _tomorrowStr = _tomorrow.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const SYSTEM = `You are ${agentName}, a voice assistant built for ${agencyName}${tagline} The operator is currently in ${CONFIG.operator.city}, ${CONFIG.operator.country}. Today is ${_todayStr}. Tomorrow is ${_tomorrowStr}. The local time is ${_now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Be concise, conversational, and natural. Two sentences max unless asked for detail. Use British English. Address the operator as "sir" sparingly (occasional, not every reply).${projectHint}${creativeStylePromptBlock()}

SPOKEN OUTPUT RULES (CRITICAL):
  Your reply is read aloud by a TTS voice. Output ONLY plain spoken prose:
  - NO markdown: never **bold**, *italic*, _underline_, \`code\`, or backtick fences.
  - NO bullet points, numbered lists, or section headings.
  - NO special separators like ·, —, –, |, /, or em-dashes — use words ("and", "or", "then") or commas.
  - NO emoji, no markdown links — say "the link" or describe what it is.
  - When listing items, use natural language: "I can help with three things — first… second… and third…".
  - Numbers and units in spoken form when helpful: "zero to sixty in three seconds", "five hundred horsepower", "sixteen by nine".

YOU HAVE TOOLS — call them whenever appropriate, don't just describe what you would do.

CONFIRMATION CONTRACT (CRITICAL — client-visible writes):
  Some tools (draft_email, add_calendar_event, frameio_add_comment, frameio_set_status,
  video_edit_from_shoot, apply_lightroom_preset, premiere_render_active_sequence,
  crop_to_portrait, run_shell, write_file) REQUIRE explicit operator confirmation.
  When you call them WITHOUT confirmed: true, the bridge returns:
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
  - When introducing a new person ("add Sarah Mitchell, sarah at example dot press, press liaison") → call add_contact with the parsed fields.
  - When the operator references a past project / decision ("what did we agree on the press car", "same setup as the last shoot") → call recall to surface stored memory before answering.
  - At the end of a session (when the operator dismisses) → call save_conversation with a 2-3 sentence summary + topic tags so the next session can recall it.

YOUTUBE & SHOOT BRIEFINGS:
  - "Tell me about the most recent shoot" / "what's in the latest shoot and what's the car" → describe_shoot_with_specs (combines visual digest with vehicle specs).
  - "Make a thumbnail / YouTube thumb for the [subject] shoot with [headline]" → generate_youtube_thumbnail (1280x720, engine inlay, spec strip).
  - "Cut a 30-second short for the [subject] shoot, [headline], [subhead]" → generate_youtube_short (16:9, cinematic cuts, headline+subhead as closing kicker).
  - When the operator asks for BOTH a thumb AND a short in one breath ("a thumb and a short for the press car shoot, V10 beast, the car that broke me") → call generate_youtube_promo (single tool that does both). Pass folder OR subject as the operator named it ("ascari"). Pull headline + subhead from the phrasing — short punchy phrase becomes headline (e.g. "V10 BEAST"), more descriptive line becomes subhead (e.g. "The Car That Broke Me"). DO NOT pass make/model/stats — the tool auto-derives them. After it returns, tell the operator the thumbnail is ready in the HUD and the short is rendering.

VISION: you can SEE images and video keyframes via the local Qwen 2.5-VL model.
  - "What's in shoots/X/IMG_01.jpg" → describe_image.
  - "Summarise the latest shoot" / "what did we capture today" → caption_shoot_folder (defaults to most recent folder).
  - "Find the front-grille shots" / "where's the low-angle hero" → find_frame.
  - "Is this clip any good for the teaser?" / "score these clips" → score_clip_for_trailer.
  - "Where should I crop this for Reels?" / "make a vertical" → find_portrait_crop (analysis only) or crop_to_portrait (actually exports the file).
  - Captions are cached so calling these repeatedly is cheap. Vision and text models share GPU on this Mac, so don't fire batch caption jobs while the operator is mid-conversation.

FRAME.IO REVIEW WORKFLOW: review/comment on client-facing cuts via voice.
  - "What's pending review on Frame.io" / "anything need my approval" → frameio_list_pending_review.
  - "Read me the comments on the press car v3" → frameio_search_files (resolve name → fileId) THEN frameio_get_comments.
  - "Reply saying 'on it' at 0:23" → frameio_add_comment with timecodeSec=23. ALWAYS read back the comment text to the operator and confirm before sending — comments are client-visible.
  - "Approve the press car teaser" / "mark v3 as needing more work" → frameio_set_status. Confirm BEFORE calling — status changes notify the client.
  - If FRAMEIO_TOKEN isn't set, the tools return that as an error — tell the operator they need to set up Frame.io before this works.



When the operator asks for something that doesn't have a curated tool (e.g. "rename these files", "convert these clips to vertical", "count files matching X"), reach for run_shell. Compose ONE shell command that does the job — using ffmpeg / find / awk / sips / magick / python3 / etc. Include a short 'justification' string. The command is sandboxed: allowlist of safe binaries, no sudo / rm -rf / eval. The stdout/stderr come back so you can self-correct if it fails.

Don't pre-emptively run_shell when a curated tool exists (use video_edit_from_shoot for teasers, create_pdf for documents, etc). But for the long tail of one-off requests, run_shell is your friend.


• web_search: for current/news/recent info beyond your training cutoff
• premiere_open_project / premiere_import_folder / premiere_create_sequence_from_folder / premiere_render_active_sequence: drive Adobe Premiere Pro 2025 directly
• create_pdf: generate branded Flat-Out PDFs (quote / brief / shoot-report / press-release)
• get_upcoming_events / add_calendar_event: read or create macOS Calendar events (synced to Google)
• get_mail_summary / draft_email: read inbox, draft outgoing mail (NEVER auto-sends — always opens for approval)
• apply_lightroom_preset / list_lightroom_presets: write XMP sidecars to RAW images so Lightroom shows them with the preset already applied

For tools that change state (calendar, draft, render, apply preset): briefly confirm details before calling, especially times and recipients. After successful tool calls, report what you did in one short sentence — don't read raw JSON.

For create_pdf specifically: NEVER call the tool until you have the key fields. Ask SHORT one-question-at-a-time follow-ups to gather them. Examples:
  • Quote: client name → project description → line items (description + amount, one at a time) → shoot dates → any extra notes. Once you have at least 1 line item with an amount, you can build the PDF.
  • Brief: subject → date(s) → location → deliverables → crew → objectives.
  • Shoot-report: subject → date → location → weather → file count → highlights.
  • Press-release: headline → subhead → lead paragraph → body (1-2 paragraphs) → quote + attribution.
Keep questions tight ("What's the client's name?" not "Could you please tell me what the client's name is?"). When the operator gives you "everything you need" or says "that's enough info", build the PDF with what you have. After build, the PDF opens automatically in a window — just say "Quote drafted" or similar.

IMPORTANT: when video_edit_from_shoot returns ok:true and status:"started", the render is now running asynchronously and WILL succeed. Reply with a confident "On it. The [subject] teaser is rendering — it'll play here when it's ready." Never say "I couldn't find" or "I'm not sure" after a status:"started" response — the tool already accepted the request.

When given [Context], use those facts verbatim. If asked to do something you don't have a tool for, say so plainly.`;

  const ctx = await gatherContext(query);
  const userContent = ctx ? `[Context — use these real facts:\n${ctx}\n]\n\n${query}` : query;

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
  const filtered = await ToolRouter.pickRelevant(query, TOOLS, { topK: 20 });
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

  /* Why: tool-calling loop — model may emit tool_calls, we run them, append results, ask again.
   * Cap at 3 round trips to prevent infinite loops on a confused tool-happy model. */
  for (let hop = 0; hop < 3; hop++) {
    /* First hop: route by query content — short / chat-y queries hit the fast model
     * on capable hardware. Subsequent hops always use main (tool-call accuracy
     * matters more than latency once a tool is already chosen). On lower-tier
     * hardware OLLAMA_FAST_MODEL is unset so both branches return main. */
    const modelForHop = hop === 0 ? ModelRouter.pick(query) : ModelRouter.pickForToolHop();
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      /* keep_alive: capable hardware (ultra / m5-max) gets long values via the
       * wizard's OLLAMA_KEEP_ALIVE setting so the model doesn't unload between
       * turns. Lower-tier installs stick to "30s" so the model can free memory
       * for other work. */
      body: JSON.stringify({ model: modelForHop, messages, stream: false, tools: toolsForLLM, keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30s" }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const msg = data.message || {};
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

    if (calls.length === 0) {
      const finalReply = (msg.content || "").trim();
      if (sessionId && finalReply) {
        try { Memory.appendTurn({ sessionId, role: "assistant", content: finalReply, tools: toolsThisQuery }); }
        catch (e) { console.warn(`[bridge] turn persist (assistant) failed: ${e.message}`); }
      }
      return finalReply;
    }

    // Append the assistant's tool-call message + execute each tool, append their results
    messages.push(msg);
    for (const c of calls) {
      const fname = c.function?.name;
      let args = c.function?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      console.log(`[bridge] tool call: ${fname}(${JSON.stringify(args).slice(0, 120)})`);
      toolsThisQuery.push(fname);
      let result;
      try { result = await executeTool(fname, args || {}); }
      catch (e) { result = { error: String(e.message || e) }; }
      messages.push({
        role: "tool",
        content: JSON.stringify(result).slice(0, 8000),
        tool_name: fname,
      });
    }
  }
  return "I tried a few searches but couldn't pull a clean answer together — try asking more specifically.";
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
async function askLLMStream({ query, history = [], onSentence, sessionId = null }) {
  /* Why log: when the kiosk goes silent mid-turn, the bridge log was empty —
   * no entry for the inbound query, no entry for hop boundaries. Every later
   * "is it stuck?" debug starts blind. One concise line per hop + the first
   * sentence emitted gives us a timeline without spamming the log. */
  const t0 = Date.now();
  console.log(`[stream] ask: "${query.slice(0, 80)}${query.length > 80 ? '…' : ''}"`);
  const brand = loadBrand();
  const agencyName = brand.agency.name || CONFIG.agency.name;
  const agentName = brand.agent.name || "Flat-Out";
  const tagline = brand.agency.tagline ? ` — ${brand.agency.tagline}.` : ".";
  const projectHint = Projects.systemPromptHint();
  /* SYSTEM is shared with askLLM — keep duplicated here so both paths stay in sync.
   * If they ever diverge, refactor to a shared buildSystemPrompt() helper. */
  /* Build "today" + "tomorrow" context strings. Why: without these the model has
   * no anchor for date-relative queries like "anything in my diary today/tomorrow"
   * — it returns 7 days of events from get_upcoming_events but can't filter to the
   * right day, often answers "no events today" even when there's one in the data. */
  const _now = new Date();
  const _todayStr = _now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const _tomorrow = new Date(_now.getTime() + 86_400_000);
  const _tomorrowStr = _tomorrow.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const SYSTEM = `You are ${agentName}, a voice assistant built for ${agencyName}${tagline} The operator is currently in ${CONFIG.operator.city}, ${CONFIG.operator.country}. Today is ${_todayStr}. Tomorrow is ${_tomorrowStr}. The local time is ${_now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}. Be concise, conversational, and natural. Two sentences max unless asked for detail. Use British English. Address the operator as "sir" sparingly (occasional, not every reply).${projectHint}

Output plain spoken prose only — no markdown, no bullet points, no emoji, no special separators. Numbers and units in spoken form when helpful.

YOU HAVE TOOLS — call them whenever appropriate. When given [Context], use those facts verbatim.`;

  const ctx = await gatherContext(query);
  const userContent = ctx ? `[Context — use these real facts:\n${ctx}\n]\n\n${query}` : query;
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

  /* Sentence boundary state — accumulates streamed tokens, flushes on terminal punctuation.
   * Boundary regex keeps it simple: ".", "?", or "!" followed by whitespace or end-of-string.
   * Sentences shorter than MIN_LEN merge into the next so "Yes." doesn't synth a 200ms clip. */
  const MIN_LEN = 8;
  const sb = { text: "", emitted: "" };
  function pushToken(token) {
    if (!token) return;
    sb.text += token;
    sb.emitted += token;
    while (true) {
      const m = sb.text.match(/[.!?](\s|$)/);
      if (!m) break;
      const end = m.index + 1;
      const sentence = sb.text.slice(0, end).trim();
      sb.text = sb.text.slice(end).replace(/^\s+/, "");
      if (sentence.length >= MIN_LEN) {
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
  const filtered = await ToolRouter.pickRelevant(query, TOOLS, { topK: 20 });
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

  /* Up to 3 hops, same cap as askLLM(). Each hop streams; tool_calls in the terminal
   * frame trigger an extra hop with the tool results appended to messages. Model
   * routing matches the non-streaming path: first hop picks via query content,
   * subsequent hops always use main. */
  let firstSentenceLogged = false;
  for (let hop = 0; hop < 3; hop++) {
    const modelForHop = hop === 0 ? ModelRouter.pick(query) : ModelRouter.pickForToolHop();
    const hopT0 = Date.now();
    console.log(`[stream] hop ${hop} → ${modelForHop}`);
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelForHop, messages, stream: true, tools: toolsForLLM, keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30s" }),
    });
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
        if (evt.done) finalMsg = evt.message || finalMsg;
      }
    }

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
      return finalReply;
    }

    /* Tool-calling hop: append the assistant message + each tool's result, then loop.
     * We DON'T flush between hops — sometimes the model emits a one-line "Looking that
     * up..." in this hop's content, which we want spoken before the tool result drives
     * the next hop. The flushFinal() at the very end picks up any tail. */
    messages.push(finalMsg);
    for (const c of calls) {
      const fname = c.function?.name;
      let args = c.function?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      console.log(`[bridge] tool call (stream): ${fname}(${JSON.stringify(args).slice(0, 120)})`);
      toolsThisQuery.push(fname);
      let result;
      try { result = await executeTool(fname, args || {}); }
      catch (e) { result = { error: String(e.message || e) }; }
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
  return finalReply || "I tried a few searches but couldn't pull a clean answer together — try asking more specifically.";
}

/* ---------- WEATHER (Open-Meteo, no API key needed) ---------- */
async function getWeather(lat = CONFIG.operator.latitude, lon = CONFIG.operator.longitude) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Europe/London&forecast_days=6`;
    const res = await fetch(url);
    const data = await res.json();
    return {
      now: { temp: Math.round(data.current.temperature_2m), code: data.current.weather_code },
      forecast: data.daily.time.slice(1).map((d, i) => ({
        date: d,
        hi: Math.round(data.daily.temperature_2m_max[i + 1]),
        lo: Math.round(data.daily.temperature_2m_min[i + 1]),
        code: data.daily.weather_code[i + 1],
      })),
    };
  } catch (e) {
    return { error: e.message };
  }
}

/* ---------- WEBSOCKET SERVER ---------- */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

/* PROJECT_ROOT is declared near the top of this file now (boot summary needs it).
 * Re-imports from the same module are idempotent, so no second declaration here. */

const httpServer = createServer(async (req, res) => {
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
      const turns = Memory.recentTurns({
        limit: Number(url.searchParams.get("limit")) || 50,
        beforeTs: url.searchParams.get("beforeTs") ? Number(url.searchParams.get("beforeTs")) : null,
        sessionId: url.searchParams.get("sessionId") || null,
      });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, turns }));
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
    const manifest = TOOLS.map((t) => {
      const fn = t.function || t;
      return {
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters?.properties || {},
        required: fn.parameters?.required || [],
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
      actions: manifest,
    }));
    return;
  }

  if (req.url?.startsWith("/audit") && req.method === "GET") {
    /* Query the JSONL audit log. URL format:
     *   /audit?operator=marcus&tool=draft_email&fromTs=...&toTs=...&limit=200
     * All filters optional. Returns newest-first within the limit. */
    try {
      const url = new URL(req.url, "http://localhost");
      const filter = {
        operator: url.searchParams.get("operator") || undefined,
        tool: url.searchParams.get("tool") || undefined,
        fromTs: url.searchParams.get("fromTs") ? Number(url.searchParams.get("fromTs")) : undefined,
        toTs: url.searchParams.get("toTs") ? Number(url.searchParams.get("toTs")) : undefined,
        limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 200,
      };
      const [entries, summary] = await Promise.all([Audit.query(filter), Audit.summary()]);
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, entries, summary }));
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

  if (req.url === "/actions" && req.method === "GET") {
    /* Action manifest — single source of truth for the HUD's command palette,
     * help cheat-sheet, and audit-log filter UI. Joins each tool's LLM-facing
     * definition with the destructive-flag derived from NEEDS_CONFIRMATION so
     * downstream consumers don't have to re-derive it.
     *
     * Optional metadata (label / category / phrasings) is loaded from
     * config/actions.meta.json if present — that file gets filled in as the
     * palette + help features come online; today the manifest just carries the
     * bridge's tool definitions. */
    let meta = {};
    try {
      const fs = await import("node:fs/promises");
      const metaPath = new URL("../config/actions.meta.json", import.meta.url);
      meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    } catch { /* meta file optional */ }

    const actions = TOOLS.map(t => {
      const fn = t.function || {};
      const m = meta[fn.name] || {};
      return {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
        destructive: NEEDS_CONFIRMATION[fn.name] != null,
        label: m.label || null,
        category: m.category || null,
        phrasings: Array.isArray(m.phrasings) ? m.phrasings : [],
      };
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, count: actions.length, actions }));
    return;
  }

  if (req.url === "/healthz" && req.method === "GET") {
    /* Why: aggregated health for the HUD's status bar. Probes Ollama (text + vision
     * are the same daemon) + Kokoro (TTS) + Whisper (STT) in parallel. Each gets a
     * tight timeout so a single hung daemon doesn't tank the whole readout. The
     * bridge itself is implicitly "up" if this endpoint responds. */
    const probe = async (url, ms = 1500) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
        return r.ok;
      } catch { return false; }
    };
    const [ollama, kokoro, whisper] = await Promise.all([
      probe(`${OLLAMA_URL}/api/tags`),
      probe("http://localhost:8767/health"),
      probe("http://localhost:8768/health"),
    ]);
    /* setupRequired: true when config/brand.json is missing — signals to the HUD
     * that this is a fresh install and the operator should run setup-wizard.mjs.
     * The bridge still serves a FALLBACK brand so the HUD doesn't crash; this
     * flag just lets us show a friendly "first run? run the setup wizard"
     * overlay instead of leaving them with default Flat-Out branding. */
    let setupRequired = false;
    try {
      const fs = await import("node:fs");
      const brandPath = new URL("../config/brand.json", import.meta.url).pathname;
      setupRequired = !fs.existsSync(brandPath);
    } catch { /* assume not required if we can't probe */ }

    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      services: { bridge: true, ollama, kokoro, whisper },
      setupRequired,
    }));
    return;
  }
  if (req.url === "/brand" && req.method === "GET") {
    /* Brand config drives wake phrase, agency name, colours, logos. Frontend bootstraps
     * with this before rendering so a single deploy can serve any client. */
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(loadBrand()));
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
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      keys: {
        frameio:   { set: !!process.env.FRAMEIO_TOKEN,     hint: mask(process.env.FRAMEIO_TOKEN) },
        serpapi:   { set: !!process.env.SERPAPI_KEY,       hint: mask(process.env.SERPAPI_KEY) },
        hunter:    { set: !!process.env.HUNTER_API_KEY,    hint: mask(process.env.HUNTER_API_KEY) },
        anthropic: { set: !!process.env.ANTHROPIC_API_KEY, hint: mask(process.env.ANTHROPIC_API_KEY) },
        openai:    { set: !!process.env.OPENAI_API_KEY,    hint: mask(process.env.OPENAI_API_KEY) },
      },
      routing: {
        default:    process.env.LLM_PROVIDER_DEFAULT    || "ollama",
        vision:     process.env.LLM_PROVIDER_VISION     || "ollama",
        highstakes: process.env.LLM_PROVIDER_HIGHSTAKES || "ollama",
      },
    }));
    return;
  }

  /* POST /api-keys — write FRAMEIO_TOKEN / SERPAPI_KEY / HUNTER_API_KEY to .env
   * and update process.env so the value is live without a bridge restart.
   * Body shape: { frameio?: string, serpapi?: string, hunter?: string }
   *   - empty string  → clear the key (write empty value, kill from env)
   *   - missing field → don't touch
   *   - non-empty     → set it
   * Allowlist of three keys keeps this from being a generic env-write API. */
  if (req.url === "/api-keys" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body || "{}");
      const MAP = {
        frameio:   "FRAMEIO_TOKEN",
        serpapi:   "SERPAPI_KEY",
        hunter:    "HUNTER_API_KEY",
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
      "capture-one": { app: "Capture One" },
      "adobe":       { app: "Adobe Creative Cloud" },
      "premiere":    { app: "Adobe Premiere Pro 2025" },
      "lightroom":   { app: "Adobe Lightroom Classic" },
      "photoshop":   { app: "Adobe Photoshop 2025" },
      "music":       { app: "Music" },
      "calendar":    { app: "Calendar" },
      "messages":    { app: "Messages" },
      "slack":       { app: "Slack" },
      "output":      { folder: "output" },               // rendered teasers / PDFs / thumbnails
      "shoots":      { folder: "shoots" },               // raw shoot folders
      "frameio":     { url: "https://app.frame.io" },    // Frame.io web app
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
     * minimum the HUD needs: time string + title + isImminent (within 30 min). */
    try {
      const evRes = await getUpcomingEvents({ days: 1 });
      const todayStr = new Date().toLocaleDateString("en-GB");
      const now = Date.now();
      /* Why field rename: getUpcomingEvents() returns events with `start`, not
       * `startDate`. The previous code filtered against the wrong key, which meant
       * every event was dropped and the diary always showed empty. Caught after
       * the operator reported "stuck on checking calendar…" — the loading state
       * never advanced because pollDiary's failure branch left the placeholder. */
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
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, count: events.length, events, ts: Date.now() }));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(e.message), events: [] }));
    }
    return;
  }
  if (req.url === "/comms" && req.method === "GET") {
    /* Dynamic comms feed for the bottom-left panel. Mixes operational status (unread mail,
     * pending reviews, leads) with browseable content (every shoot folder + every recent
     * generated output). Each item can carry a `url` so the HUD wires it as clickable.
     *
     * Shape:
     *   { k: "left-side label", v: "right-side detail", url?: "/path/in/output/", kind?: "thumb|video|pdf|folder" }
     * The HUD renders k // v on its own line, click opens url via /launch (folders) or
     * window.open (files served by the bridge's /output static handler). */
    const fs = await import("node:fs");
    const out = [];

    /* --- inbox status --- */
    try {
      const summ = await getMailSummary({ unreadOnly: true, max: 5 });
      out.push(summ?.ok && summ.count > 0
        ? { k: `${summ.count} unread`, v: "editorial inbox" }
        : { k: "0 unread", v: "inbox clear" });
    } catch { out.push({ k: "mail", v: "offline" }); }

    /* --- pending Frame.io reviews --- */
    if (process.env.FRAMEIO_TOKEN) {
      try {
        const r = await FrameIO.listPendingReview({ limit: 50 });
        if (r?.ok && r.count > 0) out.push({ k: `${r.count} pending`, v: "frame.io review" });
      } catch {}
    }

    /* --- uncontacted leads --- */
    try {
      const uncontacted = Leads.listLeads({ contacted: false }).length;
      if (uncontacted > 0) out.push({ k: `${uncontacted} leads`, v: "uncontacted" });
    } catch {}

    /* --- upcoming media days within 60 days, top 3 --- */
    try {
      const events = MediaDays.listMediaDays({ daysAhead: 60 }).slice(0, 3);
      for (const e of events) {
        const when = new Date(e.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
        const label = `${e.manufacturer.split(/\s+/)[0]}${e.vehicle ? " " + e.vehicle : ""}`;
        out.push({ k: `${e.kind} ${when}`, v: `${label}${e.location ? " · " + e.location : ""}`, kind: "event" });
      }
    } catch {}

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

    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, comms: out, ts: Date.now() }));
    return;
  }
  if (req.url === "/cancel" && req.method === "POST") {
    /* Operator said "stop" / "cancel" mid-task. Long-running tools (currently
     * caption_shoot_folder) check Vision.isAborted() between iterations and bail
     * cleanly with partial results. The teaser pipeline is more complex and not
     * yet abort-aware — document that to the operator instead of pretending. */
    Vision.raiseAbort();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, note: "Cancellation requested. Active caption batch will stop at next frame." }));
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

  /* POST /live/transcribe — phone uploads a raw audio blob (webm/opus or mp4 from
   * iOS Safari) with the mime type in Content-Type. Bridge forwards to the local
   * Whisper service (port 8768), parses the response, and routes the transcript:
   *   - If it matches a flag intent ("hero", "reshoot", "skip" + variants), fire
   *     flag_shot on the most recent file in the active shoot folder.
   *   - Otherwise broadcast as a live.note event so the kiosk's HUD shows it. */
  if (req.url?.startsWith("/live/transcribe") && req.method === "POST") {
    const url = new URL(req.url, "http://localhost");
    const project = url.searchParams.get("project") || null;
    const contentType = req.headers["content-type"] || "audio/webm";
    /* Buffer the blob in memory — typical push-to-talk recordings are 1-30s, so under
     * a few MB. We don't expect long-form recordings here. */
    const chunks = [];
    let total = 0;
    const MAX_BYTES = 25 * 1024 * 1024;  // 25 MB cap
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BYTES) {
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (total > MAX_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "audio too large (>25MB)" }));
        return;
      }
      const buf = Buffer.concat(chunks);
      let text = "";
      try {
        /* Whisper service expects a multipart upload with field name "audio". We build
         * that here so the phone client can stay simple (raw blob upload). */
        const boundary = `----flat-out-${Date.now().toString(36)}`;
        const ext = /webm/i.test(contentType) ? "webm" : /mp4/i.test(contentType) ? "mp4" : "wav";
        const head = Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="audio"; filename="live.${ext}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
          "utf8"
        );
        const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
        const body = Buffer.concat([head, buf, tail]);
        const wr = await fetch("http://localhost:8768/transcribe", {
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          body,
        });
        if (!wr.ok) throw new Error(`whisper ${wr.status}`);
        const wj = await wr.json();
        text = (wj.text || wj.transcript || "").trim();
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `transcribe failed: ${e.message}` }));
        return;
      }

      /* Flag-intent detection. Keep it loose so "make this a hero", "this one's a hero",
       * "flag hero" all match. Status names match shotflag.mjs's VALID_STATUS set. */
      const lower = text.toLowerCase();
      let action = null;
      const flagMap = [
        { pat: /\b(hero|the hero|a hero)\b/, status: "hero" },
        { pat: /\b(reshoot|re-shoot|do it again|shoot again)\b/, status: "reshoot" },
        { pat: /\b(skip|delete|bin|trash|throw out)\b/, status: "skip" },
        { pat: /\b(maybe|not sure|unclear)\b/, status: "maybe" },
        { pat: /\b(keep|good|nice one)\b/, status: "keep" },
      ];
      for (const m of flagMap) {
        if (m.pat.test(lower)) {
          try {
            const result = await Shotflag.flagShot({ folder: project, status: m.status, note: text });
            action = { kind: "flag", status: m.status, file: result.file, summary: `${m.status.toUpperCase()} → ${result.file || "(latest)"}` };
            broadcastToClients({ type: "live.flag", data: { status: m.status, file: result.file, text, project } });
          } catch (e) {
            action = { kind: "flag", error: e.message };
          }
          break;
        }
      }
      if (!action) {
        /* No flag intent — broadcast as a transcript note so the kiosk surfaces it. */
        broadcastToClients({ type: "live.note", data: { text, project } });
      }
      broadcastToClients({ type: "live.caption", data: { text, project } });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, text, action }));
    });
    return;
  }

  /* POST /live/flag — quick-action chip (HERO / KEEP / MAYBE / RESHOOT). Same effect
   * as a voice-routed flag but skips the STT round-trip — useful when ambient noise
   * makes Whisper unreliable. */
  if (req.url === "/live/flag" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      try {
        const j = JSON.parse(body || "{}");
        const status = String(j.status || "").toLowerCase();
        if (!["hero", "keep", "maybe", "skip", "reshoot"].includes(status)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "status must be hero/keep/maybe/skip/reshoot" }));
          return;
        }
        const result = await Shotflag.flagShot({ folder: j.folder || null, status });
        broadcastToClients({ type: "live.flag", data: { status, file: result.file, project: j.folder || null } });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
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
            res.end(JSON.stringify({ ok: false, error: `color must be a 6-digit hex like #E10600` }));
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
        case "llm.ask":     reply(await askLLM(payload.query, payload.history || [], { sessionId: payload?.sessionId })); break;

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
        case "weather":     reply(await getWeather(payload?.lat, payload?.lon)); break;
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
  const [cpu, mem, gpu, net, disk] = await Promise.all([getCpuPercent(), getMemoryStats(), getGpuStats(), getNetStats(), getDiskStats()]);
  let netRate = { downKBs: 0, upKBs: 0 };
  if (prevNet) {
    const dt = (Date.now() - prevNet.t) / 1000;
    netRate.downKBs = Math.max(0, (net.rxBytes - prevNet.rx) / 1024 / dt);
    netRate.upKBs = Math.max(0, (net.txBytes - prevNet.tx) / 1024 / dt);
  }
  prevNet = { t: Date.now(), rx: net.rxBytes, tx: net.txBytes };

  const stats = { cpu, mem, gpu, net: netRate, disk };
  /* Route through broadcastToClients so the stats envelope picks up the same
   * ts auto-stamp every other broadcast does — single envelope shape for all. */
  broadcastToClients({ type: "stats", data: stats });
}
setInterval(broadcastStats, 1500);

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
/* Press-cycle radar at 09:00 daily — sweeps automotive press for FOM's tracked
 * manufacturers, persists hits to data/press-signals.jsonl. */
PressRadar.schedule();

httpServer.listen(PORT, () => {
  /* Brand banner — print once on startup if the terminal is wide enough to render
   * the FOM logo cleanly. Daemon-launched bridges write this to /tmp/flat-out-bridge.log
   * so it lands in the diagnostic trail too. */
  try {
    const cols = process.stdout.columns || 80;
    const banner = readFileSync(new URL("../assets/fom-ascii.txt", import.meta.url), "utf8");
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

  /* Build the embedding-based tool index. Fire-and-forget — pickRelevant()
   * falls back to the full TOOLS array until this resolves, so no chat call
   * is blocked. Subsequent boots load from data/tool-index.json instantly. */
  ToolRouter.buildIndex(TOOLS).catch((e) => console.warn(`[tool-router] index build failed: ${e.message} — chat will use full TOOLS catalogue`));

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

