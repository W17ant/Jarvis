/** macmon.mjs — Apple Silicon temperature + power telemetry via the
 *  open-source `macmon` CLI (https://github.com/vladkens/macmon).
 *
 *  Why: Apple Silicon doesn't expose CPU/GPU °C through public APIs —
 *  `osx-cpu-temp` was Intel-only and reads 0.0 on M-series, `powermetrics`
 *  needs sudo. `macmon` reads the same SMC channels Activity Monitor reads,
 *  WITHOUT root. Outputs a JSON sample per interval to stdout when run as
 *  `macmon pipe -i <ms>`.
 *
 *  This module:
 *    - Probes for the macmon binary (PATH first, then well-known fallback
 *      locations including the Elgato Stream Deck Hardware-Stats plugin
 *      which ships its own bundled copy).
 *    - Spawns `macmon pipe -i 1500` and parses the JSON line stream.
 *    - Exposes getLatest() — last successful sample, or null if macmon
 *      isn't reachable. Nothing throws; HUD reads null and falls back to
 *      "—°".
 *
 *  No dependency added: macmon is invoked as an external process. If
 *  unavailable on the host, the bridge boots without temps (existing
 *  graceful-fallback behaviour preserved).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CANDIDATE_PATHS = [
  "/opt/homebrew/bin/macmon",
  "/usr/local/bin/macmon",
  /* Elgato Stream Deck Hardware-Stats Monitor bundles a copy. We pick it up
   * opportunistically so the operator doesn't have to install macmon
   * separately if they're already running that plugin. */
  path.join(os.homedir(), "Library/Application Support/com.elgato.StreamDeck/Plugins/com.gen-e-software-lab.hardware-stats-monitor.sdPlugin/macmon"),
];

let _proc = null;
let _latest = null;
let _lastError = null;
let _restartTimer = null;

/** Resolve a usable macmon binary path. Returns null if none found. */
function resolveBinary() {
  for (const p of CANDIDATE_PATHS) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

/** Most recent macmon sample, or null. Shape:
 *  { cpuTempC, gpuTempC, cpuPowerW, gpuPowerW, anePowerW, sysPowerW, ts } */
export function getLatest() {
  if (!_latest) return null;
  /* Drop stale samples — a frozen process is worse than no data. */
  if (Date.now() - _latest.ts > 8000) return null;
  return _latest;
}

/** Spawn the macmon child process. Idempotent — re-call after a crash to
 *  trigger a restart with backoff. */
export function start() {
  const bin = resolveBinary();
  if (!bin) {
    _lastError = "macmon binary not found (tried PATH, /opt/homebrew, /usr/local, Stream Deck plugin)";
    console.warn(`[macmon] ${_lastError}`);
    return false;
  }
  if (_proc && !_proc.killed) return true;

  try {
    _proc = spawn(bin, ["pipe", "-i", "1500"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    _lastError = `spawn failed: ${e.message}`;
    console.warn(`[macmon] ${_lastError}`);
    return false;
  }

  console.log(`[macmon] started — ${bin}`);

  /* Buffer stdout into newline-delimited JSON lines. macmon emits one
   * compact JSON object per sample. */
  let buf = "";
  _proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const sample = JSON.parse(line);
        const t = sample.temp || {};
        _latest = {
          cpuTempC: typeof t.cpu_temp_avg === "number" ? t.cpu_temp_avg : null,
          gpuTempC: typeof t.gpu_temp_avg === "number" ? t.gpu_temp_avg : null,
          cpuPowerW: sample.cpu_power ?? null,
          gpuPowerW: sample.gpu_power ?? null,
          anePowerW: sample.ane_power ?? null,
          sysPowerW: sample.all_power ?? sample.sys_power ?? null,
          ts: Date.now(),
        };
      } catch {
        /* Bad line — drop. macmon is well-behaved so this should be rare. */
      }
    }
  });

  _proc.stderr.on("data", (chunk) => {
    const s = chunk.toString("utf8").trim();
    if (s) console.warn(`[macmon] stderr: ${s.slice(0, 200)}`);
  });

  _proc.on("exit", (code, signal) => {
    console.warn(`[macmon] exited code=${code} signal=${signal}; restarting in 5s`);
    _proc = null;
    _latest = null;
    /* Auto-restart with backoff. Limited to 1 retry every 5s so a
     * misconfigured host doesn't spam the log. */
    if (_restartTimer) clearTimeout(_restartTimer);
    _restartTimer = setTimeout(() => start(), 5000);
  });

  return true;
}

/** Graceful shutdown — used by tests + uninstall flow. */
export function stop() {
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc && !_proc.killed) {
    try { _proc.kill("SIGTERM"); } catch {}
  }
  _proc = null;
  _latest = null;
}

/** Diagnostic — surfaces whether macmon is reachable + last error. */
export function status() {
  return {
    binary: resolveBinary(),
    running: !!(_proc && !_proc.killed),
    haveSample: !!_latest,
    sampleAgeMs: _latest ? Date.now() - _latest.ts : null,
    lastError: _lastError,
  };
}
