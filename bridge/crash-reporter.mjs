/** crash-reporter.mjs — local-first crash log + opt-in self-hosted upload.
 *
 *  Replaces the Sentry slot in the original Phase 3 roadmap with a
 *  privacy-respecting alternative: every unhandled exception or rejection
 *  in the bridge appends a sanitised row to data/audit/crashes/YYYY-MM-DD.jsonl,
 *  broadcasts a `system.crash` WS event so the HUD toasts, and (only if the
 *  operator has set JARVIS_CRASH_REPORT_URL in .env) POSTs the same row to
 *  that endpoint for the maintainer to see.
 *
 *  Why not Sentry: Sentry needs an account, sends to their cloud by default,
 *  and the privacy story is "trust the SDK to scrub." Our story is "the bridge
 *  itself never sends anything off-device unless you typed an URL into .env."
 *  Operators in regulated industries can stand up a one-file Cloudflare Worker
 *  to receive crashes; the rest just keep them local and check the Settings
 *  panel when something feels off.
 *
 *  Sanitisation rules (applied to every captured field):
 *    - Anything matching /sk-[A-Za-z0-9]{20,}/ → "sk-***REDACTED***"
 *    - process.env values that appear in stack frames → "***REDACTED***"
 *    - Absolute paths under $HOME → "~/<rel>"
 *    - Stack truncated to 4KB (catch infinite recursion etc)
 *
 *  The crash log itself stays under data/audit/crashes/ so the diagnostic
 *  bundle picks it up automatically (tools/diagnose.sh already includes
 *  data/audit/sessions/; we'll add crashes/ to the same bundle).
 */

import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const CRASHES_DIR = path.join(PROJECT_ROOT, "data", "audit", "crashes");

let _broadcaster = null;
let _bridgeVersion = "?";
let _bootStdoutBuffer = [];

/* Cached env-value patterns built once — every captured string is checked
 * against these to redact accidental key leaks. The pattern is the literal
 * env value (longer than 8 chars to avoid false positives on common words),
 * not the env name.
 *
 * Why the leading underscore in the regex: bare env vars like PWD, OLDPWD,
 * SHLVL would otherwise match (PWD ends in PWD literally). Requiring a
 * preceding underscore narrows to the *_KEY / *_TOKEN / *_SECRET / *_PASSWORD
 * / *_PWD shape that real secrets use. Bare KEY / TOKEN / SECRET names are
 * extraordinarily rare as secrets in the wild. */
let _redactValues = [];
function _rebuildRedactList() {
  _redactValues = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!/_(?:KEY|TOKEN|SECRET|PASSWORD|PWD)$/i.test(name)) continue;
    if (typeof value !== "string" || value.length < 8) continue;
    _redactValues.push(value);
  }
}

/** Inject the bridge's version + WS broadcaster + a rolling stdout buffer.
 *  The stdout buffer is the last 20 lines of bridge log lines — useful
 *  context when the maintainer reads a remote crash report cold. The
 *  buffer is OPT-IN per call: pass null to skip recording stdout. */
export function init({ version, broadcaster, stdoutTail = null } = {}) {
  if (version) _bridgeVersion = version;
  if (broadcaster) _broadcaster = broadcaster;
  if (Array.isArray(stdoutTail)) _bootStdoutBuffer = stdoutTail;
  _rebuildRedactList();
  /* Wire process-level handlers exactly once. Subsequent init() calls
   * (e.g. in tests) just refresh the version / broadcaster. */
  if (!process._jarvisCrashHookInstalled) {
    process.on("uncaughtException", (err) => report(err, "uncaughtException"));
    process.on("unhandledRejection", (reason) => report(reason, "unhandledRejection"));
    process._jarvisCrashHookInstalled = true;
  }
}

/** Sanitise a string: redact known-secret env values, sk-style API keys,
 *  and absolute home paths. Truncate to a max length so a recursive error
 *  message doesn't blow out the crash log. */
function _sanitise(s, maxLen = 4096) {
  if (typeof s !== "string") return String(s ?? "").slice(0, maxLen);
  let out = s;
  for (const v of _redactValues) {
    if (out.includes(v)) out = out.split(v).join("***REDACTED***");
  }
  out = out.replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-***REDACTED***");
  out = out.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***REDACTED***");
  if (process.env.HOME) {
    /* Replace absolute paths under $HOME with ~/<rel> so a stack trace from
     * one operator's machine doesn't reveal their username to another. */
    const home = process.env.HOME;
    out = out.split(home).join("~");
  }
  return out.length > maxLen ? out.slice(0, maxLen) + "…(truncated)" : out;
}

/** Append a stdout/log line to the rolling tail. Public so server.mjs can
 *  forward console.log etc into the buffer. Cap the buffer at 20 lines to
 *  keep the crash row small. */
export function logLine(line) {
  if (typeof line !== "string") return;
  _bootStdoutBuffer.push(_sanitise(line, 200));
  while (_bootStdoutBuffer.length > 20) _bootStdoutBuffer.shift();
}

/* Monotonic sequence number — breaks ties when two crashes land in the
 * same millisecond. Without this, recent() can't deterministically order
 * back-to-back failures. */
let _seq = 0;

/** Build a sanitised crash row + persist + broadcast. Public so internal
 *  code can `await CrashReporter.report(err, "manual")` for non-fatal but
 *  noteworthy errors (e.g. plugin handler threw), not just process-level
 *  unhandled cases. */
export async function report(errOrReason, source = "manual") {
  const err = errOrReason instanceof Error ? errOrReason : new Error(String(errOrReason));
  const row = {
    ts: Date.now(),
    seq: ++_seq,
    iso: new Date().toISOString(),
    source,
    name: _sanitise(err.name || "Error", 80),
    message: _sanitise(err.message || "(no message)", 1024),
    stack: _sanitise(err.stack || "", 4096),
    bridgeVersion: _bridgeVersion,
    /* Lightweight host context — chip, RAM, Node version. Mirrors what
     * tools/diagnose.sh's snapshot.txt records, but sanitised + persisted
     * so a remote crash report has the minimum needed to triage. */
    host: {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
    },
    /* Last 20 stdout lines — context the maintainer would otherwise have
     * to ask for. Already sanitised by logLine. */
    stdoutTail: [..._bootStdoutBuffer],
  };

  /* Persist to today's crash log. Keep the format identical to sessions.jsonl
   * so the diagnostic bundle handler doesn't need a new code path. */
  try {
    await mkdir(CRASHES_DIR, { recursive: true });
    const dateKey = row.iso.slice(0, 10);
    const file = path.join(CRASHES_DIR, `${dateKey}.jsonl`);
    await appendFile(file, JSON.stringify(row) + "\n", "utf8");
  } catch (writeErr) {
    /* Last-resort console.error — if we can't even write the crash log,
     * the operator at least gets a console line. Don't throw, would
     * recurse into our own handler. */
    console.error("[crash-reporter] failed to persist crash:", writeErr.message);
  }

  /* Broadcast for the HUD's toast layer. Subscribers of `system.crash`
   * (notifications.js) turn this into an error toast that survives the
   * potentially-broken bridge process. */
  try {
    _broadcaster?.({ type: "system.crash", data: { source: row.source, name: row.name, message: row.message, ts: row.ts } });
  } catch { /* broadcaster threw — nothing more we can do */ }

  /* Opt-in upload. JARVIS_CRASH_REPORT_URL is an operator-configured env
   * var; if absent, nothing leaves the device. We don't fail-fast on
   * upload errors — the local log is the source of truth. */
  const url = process.env.JARVIS_CRASH_REPORT_URL;
  if (url) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": `jarvis-bridge/${_bridgeVersion}` },
        body: JSON.stringify(row),
        /* 5s timeout — operator's network may be flaky and we don't want
         * crash reporting to delay process exit on a real fatal error. */
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* upload failed — local log holds */ }
  }

  return row;
}

/** Read recent crash rows for the /health/crashes endpoint. Per-day JSONL
 *  files; we read the N most recent days and parse each line. */
export function recent({ days = 7 } = {}) {
  if (!existsSync(CRASHES_DIR)) return [];
  let files;
  try {
    files = readdirSync(CRASHES_DIR).filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, days);
  } catch { return []; }
  const rows = [];
  for (const f of files) {
    try {
      const txt = readFileSync(path.join(CRASHES_DIR, f), "utf8");
      for (const line of txt.split("\n")) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable file */ }
  }
  /* Newest first. Sort by (ts, seq) descending so back-to-back crashes
   * within the same millisecond stay deterministically ordered. Cap at
   * 100 so a degenerate crash loop doesn't OOM the /health/crashes
   * response. */
  rows.sort((a, b) => {
    const dt = (b.ts || 0) - (a.ts || 0);
    if (dt !== 0) return dt;
    return (b.seq || 0) - (a.seq || 0);
  });
  return rows.slice(0, 100);
}

/** Per-day count summary for the Settings → Diagnostics panel. */
export function summary({ days = 7 } = {}) {
  const rows = recent({ days });
  const buckets = {};
  for (const r of rows) {
    const d = (r.iso || "").slice(0, 10);
    if (!d) continue;
    buckets[d] = (buckets[d] || 0) + 1;
  }
  return Object.entries(buckets)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}
