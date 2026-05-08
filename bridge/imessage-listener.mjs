// @ts-check
/** imessage-listener.mjs - Inbound iMessage poller.
 *
 *  Watches the operator's local Messages chat.db (~/Library/Messages/chat.db)
 *  for new incoming messages from an allowlist of senders. When a matching
 *  message arrives — typically prefixed with a wake phrase — fires a callback
 *  with { from, body, ts }. The callback (wired in server.mjs) forwards
 *  the body through askLLMStream and replies via the existing send_imessage
 *  tool — same code path as voice, just different I/O.
 *
 *  Design choices:
 *
 *    Polling, not push.  macOS has no public hook for "new iMessage".
 *    Push would require a userland daemon registered with the Messages
 *    framework (private API). Polling chat.db every N seconds is reliable,
 *    visible (no hidden daemons), and gracefully tolerates bridge restarts.
 *
 *    SQLite via the system sqlite3 CLI, not better-sqlite3.  better-sqlite3
 *    would lock the chat.db file while open, conflicting with Messages.app.
 *    The shell-out pattern reads via WAL mode and releases the file lock
 *    immediately. ~50ms per poll on a typical chat.db.
 *
 *    Allowlist + trigger.  Default: disabled. The operator opts in by editing
 *    data/imessage-config.json to set enabled:true + listing their phone(s)
 *    + a trigger prefix. Anything from a non-allowlisted sender is ignored
 *    silently. Any allowlisted message that doesn't start with the trigger
 *    is also ignored — protects against forwarding everyday personal chat
 *    into the LLM by accident.
 *
 *    Full Disk Access required.  macOS will prompt the operator the first
 *    time the bridge tries to read chat.db. They approve in System Settings →
 *    Privacy & Security → Full Disk Access. Until approved, the poller logs
 *    "permission denied" and silently retries on the next interval.
 *
 *    State persistence.  Last-seen ROWID is stored in data/imessage-state.json
 *    so a bridge restart doesn't replay the last hour's messages. New install
 *    starts at the current high-watermark — incoming-only, never historical.
 */

import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(_execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const CHAT_DB = path.join(os.homedir(), "Library/Messages/chat.db");
const CONFIG_PATH = path.join(PROJECT_DIR, "data", "imessage-config.json");
const STATE_PATH = path.join(PROJECT_DIR, "data", "imessage-state.json");

const DEFAULT_CONFIG = {
  _comment: "Inbound iMessage adapter. Disabled by default — flip enabled:true and add at least one phone/email to allowedSenders to opt in. The bridge polls chat.db every pollIntervalMs and forwards any message from an allowlisted sender that starts with `trigger` to the LLM. Full Disk Access permission required (macOS prompts on first read).",
  enabled: false,
  allowedSenders: [],
  trigger: "hey jarvis",
  pollIntervalMs: 5000,
};

let _pollHandle = null;
let _onMessage = null;

/** Load config from disk. Falls back to DEFAULT_CONFIG on any I/O / parse
 *  error so a malformed file can't accidentally enable the listener. */
async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed.enabled,
      allowedSenders: Array.isArray(parsed.allowedSenders) ? parsed.allowedSenders.map(String) : [],
      trigger: String(parsed.trigger || DEFAULT_CONFIG.trigger).toLowerCase(),
      pollIntervalMs: Math.max(1000, Math.min(60_000, Number(parsed.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs)),
    };
  } catch {
    /* No config / unreadable — write a default-disabled file so the operator
     * has a clear template to edit. */
    try { await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true }); } catch {}
    try { await fsp.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2)); } catch {}
    return { ...DEFAULT_CONFIG };
  }
}

/** Read last-seen ROWID. Returns 0 on fresh install — that triggers the
 *  high-watermark backfill below so we don't replay all history on first
 *  enable. */
async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return { lastRowId: Number(parsed.lastRowId) || 0 };
  } catch { return { lastRowId: 0 }; }
}

async function saveState(state) {
  try {
    await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fsp.writeFile(STATE_PATH, JSON.stringify(state));
  } catch (e) {
    console.warn(`[imessage] could not persist state: ${e.message}`);
  }
}

/** Run a SQLite query against chat.db via the system sqlite3 CLI. We use
 *  -readonly + WAL mode so we don't lock the database while Messages.app
 *  is also writing to it. Output is JSON for easy parsing. */
async function runQuery(sql) {
  const { stdout } = await execFile("/usr/bin/sqlite3", [
    "-readonly",
    "-json",
    CHAT_DB,
    sql,
  ], { timeout: 8000 });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try { return JSON.parse(trimmed); }
  catch { return []; }
}

/** Get the highest ROWID in messages — used as a high-watermark on first
 *  enable so we don't reply to every historical text. */
async function getMaxRowId() {
  const rows = await runQuery("SELECT MAX(ROWID) AS max_rowid FROM message");
  return Number(rows[0]?.max_rowid) || 0;
}

/** Fetch new messages since the last-seen ROWID. We pull only inbound
 *  (is_from_me=0) to stop the operator's own outgoing replies (sent via
 *  send_imessage) from looping back through the listener.
 *
 *  Joins:
 *    message → handle (sender id)
 *
 *  attributedBody is the modern message format; the older `text` column
 *  is still populated for plain text messages so we read both and prefer
 *  whichever has content.
 */
async function fetchNewMessages(sinceRowId) {
  const sql = `
    SELECT
      m.ROWID AS rowid,
      m.date,
      m.is_from_me,
      m.text,
      h.id AS sender
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    WHERE m.ROWID > ${Number(sinceRowId) || 0}
      AND m.is_from_me = 0
      AND m.text IS NOT NULL
      AND LENGTH(TRIM(m.text)) > 0
    ORDER BY m.ROWID ASC
    LIMIT 50
  `;
  return await runQuery(sql);
}

/** Match a sender against the allowlist. Allowlist entries can be raw
 *  phone numbers (with or without leading +), email addresses, or partial
 *  matches (e.g. "+44770" matches all UK mobiles in that range). */
function senderIsAllowed(sender, allowed) {
  if (!sender) return false;
  const s = String(sender).trim().toLowerCase();
  return allowed.some((allowedSender) => {
    const a = String(allowedSender).trim().toLowerCase();
    if (!a) return false;
    return s === a || s.includes(a) || a.includes(s);
  });
}

/** One poll tick. Reads config (so live edits take effect without a
 *  restart), checks new messages, fires the callback for each that
 *  passes the allowlist + trigger checks, advances the watermark. */
/* Throttle the noisy 'Full Disk Access required?' warnings — the poll
 * fires every few seconds, but the operator only needs to see this once
 * a minute. Module-scope rather than the previous function-attached
 * static so it types cleanly. */
let _lastErrorLog = 0;

async function pollOnce() {
  const config = await loadConfig();
  if (!config.enabled || !config.allowedSenders.length) return;

  let state = await loadState();
  /* Fresh install — set the watermark to the current MAX(ROWID) so we
   * don't reply to every historical text. */
  if (state.lastRowId === 0) {
    try {
      state.lastRowId = await getMaxRowId();
      await saveState(state);
      console.log(`[imessage] watermark initialised at ROWID ${state.lastRowId}`);
    } catch (e) {
      /* First-poll permission errors are common (Full Disk Access). Log
       * once a minute, not every poll, to avoid spamming. */
      if (Date.now() - (_lastErrorLog || 0) > 60_000) {
        console.warn(`[imessage] cannot read chat.db (Full Disk Access required?): ${e.message}`);
        _lastErrorLog = Date.now();
      }
      return;
    }
  }

  let rows;
  try { rows = await fetchNewMessages(state.lastRowId); }
  catch (e) {
    if (Date.now() - (_lastErrorLog || 0) > 60_000) {
      console.warn(`[imessage] poll error: ${e.message}`);
      _lastErrorLog = Date.now();
    }
    return;
  }
  if (!rows.length) return;

  for (const row of rows) {
    const sender = row.sender;
    if (!senderIsAllowed(sender, config.allowedSenders)) continue;
    const body = String(row.text || "").trim();
    if (!body.toLowerCase().startsWith(config.trigger)) continue;
    /* Strip the trigger prefix before forwarding. e.g. "hey jarvis what's
     * the time" → "what's the time". */
    const stripped = body.slice(config.trigger.length).replace(/^[\s,:.-]+/, "").trim();
    if (!stripped) continue;
    if (typeof _onMessage === "function") {
      try { await _onMessage({ from: sender, body: stripped, raw: body, rowId: row.rowid }); }
      catch (e) { console.warn(`[imessage] handler threw: ${e.message}`); }
    }
  }
  /* Advance watermark even when no messages matched — the rows were
   * still consumed. */
  state.lastRowId = rows[rows.length - 1].rowid;
  await saveState(state);
}

/**
 * Start the listener. Idempotent — calling start() while already running
 * is a no-op. Pass an onMessage callback that takes { from, body, raw,
 * rowId } and dispatches the body through the LLM.
 *
 * @param {(msg: object) => Promise<void>} onMessage
 */
export async function start(onMessage) {
  if (_pollHandle) return { alreadyRunning: true };
  _onMessage = onMessage;
  /* Light-touch startup — log presence even if disabled, so the operator
   * sees the listener is configured. */
  const config = await loadConfig();
  console.log(`[imessage] listener ${config.enabled ? "ENABLED" : "disabled"} · ${config.allowedSenders.length} allowed sender(s) · trigger="${config.trigger}" · poll=${config.pollIntervalMs}ms`);
  /* Always start the poll loop — the per-tick check honours `enabled`,
   * so flipping the flag in the config file takes effect within one
   * poll interval without a bridge restart. */
  _pollHandle = setInterval(() => { pollOnce().catch(() => {}); }, config.pollIntervalMs);
  return { started: true, configPath: CONFIG_PATH };
}

export function stop() {
  if (_pollHandle) { clearInterval(_pollHandle); _pollHandle = null; _onMessage = null; }
}

/** Diagnostic snapshot for /imessage/status. Returns the FULL config so
 *  the settings UI can pre-populate fields (allowedSenders + trigger +
 *  poll interval). lastRowId is also included for the diagnostic tab. */
export async function status() {
  const config = await loadConfig();
  const state = await loadState();
  return {
    running: !!_pollHandle,
    enabled: config.enabled,
    allowedSenders: config.allowedSenders,
    allowedSenderCount: config.allowedSenders.length,
    trigger: config.trigger,
    pollIntervalMs: config.pollIntervalMs,
    lastRowId: state.lastRowId,
    chatDbReachable: await fsp.access(CHAT_DB).then(() => true, () => false),
  };
}

/** Save config to disk. The poll loop reads the file every tick, so the
 *  next poll picks up changes automatically — no listener restart needed.
 *
 *  Validates fields server-side: enabled boolean, allowedSenders array
 *  of strings, trigger non-empty, pollIntervalMs clamped to 1-60s. Bad
 *  inputs are coerced to safe defaults rather than rejected so the
 *  settings UI can't put the listener into an unbootable state. */
export async function saveConfig(input = {}) {
  const config = {
    _comment: DEFAULT_CONFIG._comment,
    enabled: !!input.enabled,
    allowedSenders: Array.isArray(input.allowedSenders)
      ? input.allowedSenders.map((s) => String(s).trim()).filter(Boolean)
      : [],
    trigger: String(input.trigger || DEFAULT_CONFIG.trigger).toLowerCase().trim(),
    pollIntervalMs: Math.max(1000, Math.min(60_000, Number(input.pollIntervalMs) || DEFAULT_CONFIG.pollIntervalMs)),
  };
  if (!config.trigger) config.trigger = DEFAULT_CONFIG.trigger;
  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`[imessage] config saved · enabled=${config.enabled} · ${config.allowedSenders.length} allowed sender(s) · trigger="${config.trigger}"`);
  return config;
}
