/** sessions.mjs — Local-first session telemetry.
 *
 *  Writes a per-day JSONL file with one row per voice turn:
 *    { ts, heard, wakeMs, whisperMs, audioMs, error? }
 *  And a small in-memory rollup so /health/sessions can return
 *  per-day aggregates without re-reading the whole month.
 *
 *  Privacy guarantee: this lives entirely in data/audit/sessions/.
 *  Nothing leaves the machine. The diagnostic ZIP exporter (which the
 *  operator runs manually) is the ONLY way these rows ever leave the
 *  filesystem — and only if the operator explicitly emails the bundle.
 *  No analytics SDK, no /metrics endpoint, no telemetry server.
 */

import { mkdir, appendFile, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const SESSIONS_DIR = path.join(PROJECT_DIR, "data", "audit", "sessions");

function _todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function _fileFor(dateKey) {
  return path.join(SESSIONS_DIR, `${dateKey}.jsonl`);
}

/** Append a single voice-turn row to today's session log. Best-effort —
 *  errors are swallowed (mkdir / write failures shouldn't take down the
 *  voice loop). Caller passes whatever fields are known; missing values
 *  are fine. */
export async function recordTurn(row) {
  try {
    if (!existsSync(SESSIONS_DIR)) await mkdir(SESSIONS_DIR, { recursive: true });
    const line = JSON.stringify({
      ts: row.ts || Date.now(),
      heard: typeof row.heard === "string" ? row.heard.slice(0, 200) : null,
      voiceToWhisperMs: row.voiceToWhisperMs ?? null,
      whisperInferenceMs: row.whisperInferenceMs ?? null,
      voiceToAudioMs: row.voiceToAudioMs ?? null,
      error: row.error || null,
    }) + "\n";
    await appendFile(_fileFor(_todayKey()), line, "utf8");
  } catch { /* telemetry must never crash the bridge */ }
}

/** Read + aggregate the last N days of session logs. Returns one entry
 *  per day (most recent first) with counts + latency percentiles. */
export async function getDailySummary({ days = 7 } = {}) {
  if (!existsSync(SESSIONS_DIR)) return [];
  let files;
  try {
    files = (await readdir(SESSIONS_DIR))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse()
      .slice(0, Math.max(1, days));
  } catch { return []; }

  const out = [];
  for (const f of files) {
    const dateKey = f.replace(/\.jsonl$/, "");
    let raw;
    try { raw = await readFile(path.join(SESSIONS_DIR, f), "utf8"); }
    catch { continue; }
    const rows = raw.split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    /* Compute percentiles for whatever latency fields are present. */
    const pct = (arr, q) => {
      const sorted = arr.filter((n) => typeof n === "number" && n >= 0).sort((a, b) => a - b);
      if (!sorted.length) return null;
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    };
    const audioMs = rows.map((r) => r.voiceToAudioMs);
    const whisperMs = rows.map((r) => r.whisperInferenceMs);
    out.push({
      date: dateKey,
      turns: rows.length,
      errors: rows.filter((r) => r.error).length,
      audioP50: pct(audioMs, 0.5),
      audioP95: pct(audioMs, 0.95),
      whisperP50: pct(whisperMs, 0.5),
      whisperP95: pct(whisperMs, 0.95),
    });
  }
  return out;
}

/** Read raw rows for one day — used by the diagnostic exporter to
 *  bundle into the ZIP. Capped at 10k lines as a safety. */
export async function readDay(dateKey) {
  const f = _fileFor(dateKey);
  if (!existsSync(f)) return [];
  try {
    const raw = await readFile(f, "utf8");
    return raw.split("\n").filter(Boolean).slice(0, 10_000).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** Disk path of the sessions directory — exposed so diagnose.sh can find it. */
export function sessionsDir() { return SESSIONS_DIR; }
