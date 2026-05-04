/** trackday.mjs - Track-day metadata auto-tag.
 *
 *  For motorsport / track-day shoots, the operator wants every clip and still tagged with
 *  conditions data the editor can search later: time-of-day window, golden-hour status,
 *  weather (temp / wind / precipitation), and a rough "session slot" so multi-stint days
 *  group sensibly ("morning sighting", "afternoon hot laps").
 *
 *  Tool: trackday_tag({ folder, location?, sessionLengthMin?, sampleCount? })
 *
 *  Strategy:
 *    1. Run exiftool over the folder pulling DateTimeOriginal + GPSLatitude/Longitude.
 *    2. If location is supplied (or coords are present), call Open-Meteo's archive API
 *       for the shoot day at hourly granularity. Cache the response per (date, lat, lon)
 *       so repeat calls don't re-fetch.
 *    3. For each file, compute: timeWindow (HH:MM start–end across the take), goldenHour
 *       (sunrise±90min / sunset±90min from Open-Meteo's daily payload), conditions snippet
 *       ("12°C, light rain, 8mph"), session slot (morning / midday / afternoon / dusk).
 *    4. Persist a sidecar `trackday-tags.json` in the shoot folder so the editor can
 *       grep through later (no DB write — keeps it portable with the asset).
 *
 *  Why a sidecar instead of SQLite: track-day folders are often archived to NAS or moved
 *  to client delivery; metadata that travels with the folder is more useful than metadata
 *  tied to the workstation's database.
 */

import { readdir, stat, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as Paths from "./paths.mjs";

const execFileP = promisify(execFile);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
/* SHOOTS_DIR resolved at call sites via Paths.getShootsDir(). */
const WEATHER_CACHE_DIR = path.join(PROJECT_DIR, "data", "weather-cache");
/* Why: sidecars used to land inside the source shoot folder. That risked leaking GPS /
 * timestamp metadata to clients when the folder was handed over unchanged — and cluttered
 * delivery directories with a JSON file that isn't part of the deliverable. Park them
 * under data/trackday/<folder>.json instead. The editor still gets to grep them; the
 * client folder stays clean. */
const TRACKDAY_DIR = path.join(PROJECT_DIR, "data", "trackday");

const MEDIA_EXTS = new Set([".jpg", ".jpeg", ".png", ".heic", ".tiff", ".dng", ".arw", ".cr2", ".cr3", ".nef", ".raf", ".mp4", ".mov", ".m4v"]);

/** Resolve folder arg → absolute path, default to most recent shoot.
 *  Why: absolute paths must resolve inside PROJECT_DIR — sidecar writes go into the
 *  resolved folder, so we cannot allow a path traversal here under any circumstances. */
async function resolveFolder(folder) {
  const shootsDir = Paths.getShootsDir();
  if (folder) {
    let abs = path.isAbsolute(folder) ? folder : path.join(shootsDir, folder);
    abs = path.resolve(abs);
    if (Paths.isWithinAllowedRoots(abs) && existsSync(abs)) return abs;
  }
  if (!existsSync(shootsDir)) return null;
  const ents = await readdir(shootsDir, { withFileTypes: true });
  const dirs = ents.filter(e => e.isDirectory()).map(e => path.join(shootsDir, e.name));
  if (!dirs.length) return null;
  const stats = await Promise.all(dirs.map(async d => ({ d, mt: (await stat(d)).mtimeMs })));
  stats.sort((a, b) => b.mt - a.mt);
  return stats[0].d;
}

/** Pull EXIF: DateTimeOriginal + GPS. Falls back to file mtime if camera didn't tag. */
async function readExifBatch(folderAbs, files) {
  const fullPaths = files.map(f => path.join(folderAbs, f));
  let lines = "";
  try {
    /* -j gives JSON output, -n forces numeric values (lat/lon as decimals not DMS strings). */
    const { stdout } = await execFileP("exiftool",
      ["-j", "-n", "-DateTimeOriginal", "-CreateDate", "-GPSLatitude", "-GPSLongitude", "-FileModifyDate", ...fullPaths],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
    lines = stdout;
  } catch {
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(lines); } catch { return null; }
  return parsed;
}

/** Parse exiftool's "2026:05:01 14:30:21" date format. Returns Date or null. */
function parseExifTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Open-Meteo Archive API — historical hourly data for a date + lat/lon. Cached on disk. */
async function fetchHistoricalWeather(date, lat, lon) {
  if (lat == null || lon == null) return null;
  const dateStr = date.toISOString().slice(0, 10);
  /* Why: 1dp ≈ 11km buckets at the equator, ~7km at UK latitudes — fine for weather
   * granularity (a single frontal system spans far more) and dedupes morning + afternoon
   * shoots at the same circuit to one cache entry. */
  const cacheKey = `${dateStr}_${lat.toFixed(1)}_${lon.toFixed(1)}.json`;
  const cachePath = path.join(WEATHER_CACHE_DIR, cacheKey);

  if (existsSync(cachePath)) {
    try { return JSON.parse(await readFile(cachePath, "utf8")); } catch {}
  }

  /* Why: Open-Meteo's archive endpoint is free, no key needed, supports historical
   * hourly data going back decades. Daily payload includes sunrise/sunset which we
   * use for the golden-hour calculation. */
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${dateStr}&end_date=${dateStr}&hourly=temperature_2m,precipitation,weather_code,wind_speed_10m&daily=sunrise,sunset&timezone=auto`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    /* Persist for future calls. Mkdir if missing. */
    try {
      const { mkdir: mk } = await import("node:fs/promises");
      await mk(WEATHER_CACHE_DIR, { recursive: true });
      await writeFile(cachePath, JSON.stringify(j));
    } catch {}
    return j;
  } catch {
    return null;
  }
}

const WEATHER_CODE_LABEL = {
  0: "clear", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow",
  80: "light showers", 81: "showers", 82: "heavy showers",
  95: "thunderstorm", 96: "thunderstorm w/ hail", 99: "severe thunderstorm",
};

function weatherCodeLabel(code) { return WEATHER_CODE_LABEL[code] || `code ${code}`; }

/** Pick the hourly slice closest to the shot time. */
function hourlyAt(weatherJson, when) {
  if (!weatherJson?.hourly?.time) return null;
  const targetMs = when.getTime();
  let best = -1, bestDelta = Infinity;
  for (let i = 0; i < weatherJson.hourly.time.length; i++) {
    const t = new Date(weatherJson.hourly.time[i]).getTime();
    const d = Math.abs(t - targetMs);
    if (d < bestDelta) { bestDelta = d; best = i; }
  }
  if (best < 0) return null;
  return {
    tempC: weatherJson.hourly.temperature_2m?.[best] ?? null,
    precipMm: weatherJson.hourly.precipitation?.[best] ?? null,
    windKph: weatherJson.hourly.wind_speed_10m?.[best] ?? null,
    code: weatherJson.hourly.weather_code?.[best] ?? null,
  };
}

/** Format a one-line conditions string the editor can grep / read aloud. */
function formatConditions(slice) {
  if (!slice) return null;
  const parts = [];
  if (slice.tempC != null) parts.push(`${Math.round(slice.tempC)}°C`);
  if (slice.code != null) parts.push(weatherCodeLabel(slice.code));
  if (slice.precipMm != null && slice.precipMm > 0.1) parts.push(`${slice.precipMm.toFixed(1)}mm rain`);
  if (slice.windKph != null) parts.push(`${Math.round(slice.windKph)}kph wind`);
  return parts.join(", ") || null;
}

/** Golden-hour check: within 90 min of sunrise OR sunset (industry-standard window). */
function goldenHourStatus(when, daily) {
  if (!daily?.sunrise?.[0] || !daily?.sunset?.[0]) return null;
  const sunrise = new Date(daily.sunrise[0]).getTime();
  const sunset = new Date(daily.sunset[0]).getTime();
  const t = when.getTime();
  const window = 90 * 60 * 1000;
  if (Math.abs(t - sunrise) <= window) return "morning-golden";
  if (Math.abs(t - sunset) <= window) return "evening-golden";
  return "non-golden";
}

/** Coarse session-slot label so multi-stint track days group sensibly. */
function sessionSlot(when) {
  const h = when.getHours();
  if (h < 9) return "early-morning";
  if (h < 12) return "morning";
  if (h < 15) return "midday";
  if (h < 18) return "afternoon";
  if (h < 20) return "evening";
  return "dusk";
}

/**
 * Run the full pipeline. Writes trackday-tags.json into the shoot folder and returns
 * an aggregate summary the LLM can speak ("ten clips morning golden-hour, five afternoon
 * dry, conditions held at twelve degrees with light wind").
 */
export async function trackdayTag(args = {}) {
  const folderAbs = await resolveFolder(args.folder);
  if (!folderAbs) return { ok: false, error: "no shoot folder found" };
  const folderName = path.basename(folderAbs);

  const all = (await readdir(folderAbs)).filter(f => MEDIA_EXTS.has(path.extname(f).toLowerCase())).sort();
  if (!all.length) return { ok: false, error: `no media in ${folderName}` };

  /* Sample to keep exiftool calls fast — full folders can be thousands of files. */
  const sampleCount = Math.max(20, Math.min(200, Number(args.sampleCount) || 80));
  const step = Math.max(1, Math.floor(all.length / sampleCount));
  const sampled = [];
  for (let i = 0; i < all.length && sampled.length < sampleCount; i += step) sampled.push(all[i]);

  const exif = await readExifBatch(folderAbs, sampled);
  if (!exif) return { ok: false, error: "exiftool not available or returned no parseable data" };

  /* Aggregate first-pass: collect any GPS pair and the full time range across the sample. */
  let lat = null, lon = null;
  let earliest = null, latest = null;
  const fileTimes = new Map();
  for (let i = 0; i < exif.length; i++) {
    const e = exif[i];
    const t = parseExifTime(e.DateTimeOriginal || e.CreateDate || e.FileModifyDate);
    if (t) {
      fileTimes.set(sampled[i], t);
      if (!earliest || t < earliest) earliest = t;
      if (!latest || t > latest) latest = t;
    }
    if (lat == null && Number.isFinite(e.GPSLatitude)) lat = e.GPSLatitude;
    if (lon == null && Number.isFinite(e.GPSLongitude)) lon = e.GPSLongitude;
  }
  if (!earliest) return { ok: false, error: "could not derive a date from EXIF or file mtime" };

  /* If operator passed an explicit location and we got no GPS, try a rough lat/lon lookup
   * via Open-Meteo's geocoding endpoint (also free, no key). */
  if ((lat == null || lon == null) && args.location) {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args.location)}&count=1`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json();
        const hit = j?.results?.[0];
        if (hit) { lat = hit.latitude; lon = hit.longitude; }
      }
    } catch {}
  }

  const weather = await fetchHistoricalWeather(earliest, lat, lon);

  /* Build per-file tag rows. */
  const rows = [];
  const slotCounts = {};
  const goldenCounts = { "morning-golden": 0, "evening-golden": 0, "non-golden": 0 };
  for (const file of sampled) {
    const when = fileTimes.get(file);
    if (!when) continue;
    const golden = weather ? goldenHourStatus(when, weather.daily) : null;
    const slot = sessionSlot(when);
    const conds = weather ? formatConditions(hourlyAt(weather, when)) : null;
    if (golden) goldenCounts[golden] = (goldenCounts[golden] || 0) + 1;
    slotCounts[slot] = (slotCounts[slot] || 0) + 1;
    rows.push({
      file,
      time: when.toISOString(),
      sessionSlot: slot,
      goldenHour: golden,
      conditions: conds,
    });
  }

  /* Persist sidecar under data/trackday/ — keeps the source shoot folder clean and
   * stops accidental client-side leakage of GPS/timestamp metadata. */
  if (!existsSync(TRACKDAY_DIR)) await mkdir(TRACKDAY_DIR, { recursive: true });
  const sidecarPath = path.join(TRACKDAY_DIR, `${folderName}.json`);
  const payload = {
    folder: folderName,
    generatedAt: new Date().toISOString(),
    location: args.location || null,
    coordinates: lat != null && lon != null ? { lat, lon } : null,
    timeRange: { from: earliest.toISOString(), to: latest.toISOString() },
    sampleSize: rows.length,
    totalFiles: all.length,
    weather: weather ? {
      sunrise: weather.daily?.sunrise?.[0] || null,
      sunset: weather.daily?.sunset?.[0] || null,
    } : null,
    slotCounts,
    goldenCounts,
    rows,
  };
  await writeFile(sidecarPath, JSON.stringify(payload, null, 2));

  const summaryLines = [
    `Tagged ${rows.length} of ${all.length} files in ${folderName}.`,
    weather ? `Sunrise ${weather.daily?.sunrise?.[0]?.slice(11, 16)}, sunset ${weather.daily?.sunset?.[0]?.slice(11, 16)}.` : "No weather (no GPS or location given).",
    `Slots: ${Object.entries(slotCounts).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    goldenCounts["morning-golden"] || goldenCounts["evening-golden"]
      ? `Golden hour: ${goldenCounts["morning-golden"] || 0} morning, ${goldenCounts["evening-golden"] || 0} evening.`
      : null,
  ].filter(Boolean).join(" ");

  return {
    ok: true,
    folder: folderName,
    sidecar: path.relative(PROJECT_DIR, sidecarPath),
    sampleSize: rows.length,
    totalFiles: all.length,
    location: args.location || (lat != null ? `${lat.toFixed(3)}, ${lon.toFixed(3)}` : null),
    coordinates: lat != null && lon != null ? { lat, lon } : null,
    slotCounts,
    goldenCounts,
    weather: weather ? {
      sunrise: weather.daily?.sunrise?.[0] || null,
      sunset: weather.daily?.sunset?.[0] || null,
    } : null,
    summary: summaryLines,
  };
}
