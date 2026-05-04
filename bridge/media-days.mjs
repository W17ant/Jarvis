/** media-days.mjs - Manufacturer media-day / press-event calendar.
 *
 *  Why: an automotive PR/content agency wins by knowing what's on before competitors
 *  do. Media days, track days, launch events, embargo dates — all live in scattered
 *  press emails, calendar invites, and word-of-mouth. This module gives FOM a single
 *  store keyed by manufacturer + date so "what's coming up at Goodwood?" or "is
 *  the client doing a press day this month?" returns a real answer instead of a guess.
 *
 *  Operator adds events via voice ("add a media day for the manufacturer on June 15 at
 *  Goodwood, vehicle's the new model S"), via the LLM after a press email lands, or by
 *  hand-editing data/media-days.jsonl. Web-search-driven discovery is opt-in
 *  (find_media_days tool) — we don't crawl on a schedule because most manufacturer
 *  press calendars sit behind login walls and the false-positive rate is too high
 *  for autonomous ingestion.
 *
 *  Storage: shares memory.db (better-sqlite3) so the data lives alongside contacts +
 *  projects + facts and gets covered by the existing nightly backup.
 *
 *  Exports:
 *    addMediaDay({ manufacturer, vehicle?, date, location?, kind?, notes?, sourceUrl? })
 *    listMediaDays({ manufacturer?, daysAhead?, includesPast? })
 *    deleteMediaDay({ id })
 *    upcomingSummary(daysAhead = 60)   - one-line "3 events: the client (Jun 15)…" for COMMS panel
 */

import Database from "better-sqlite3";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DB_PATH = path.join(PROJECT_DIR, "data", "memory.db");

/* Share the memory.db handle with memory.mjs / shotflag.mjs / autocull.mjs so all
 * agency state lives in one snapshot. WAL mode is set by memory.mjs on first open. */
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/* Schema — kept narrow because the operator adds events by hand or via voice. Date
 * stored as ISO 8601 yyyy-mm-dd (or yyyy-mm-ddTHH:MM if a specific time matters)
 * so range queries are pure string comparisons against ISO-now. */
db.prepare(`
  CREATE TABLE IF NOT EXISTS media_days (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    manufacturer TEXT NOT NULL,
    vehicle TEXT,
    date TEXT NOT NULL,                    -- ISO yyyy-mm-dd or yyyy-mm-ddTHH:MM
    location TEXT,
    kind TEXT,                             -- 'press-day' | 'track-day' | 'launch' | 'embargo' | 'other'
    notes TEXT,
    source_url TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(manufacturer, vehicle, date)    -- prevents duplicate adds when the LLM re-creates from the same email
  )
`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_media_days_date ON media_days(date)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_media_days_make ON media_days(manufacturer)`).run();

/** Normalise a manufacturer name for de-duping. "Aston Martin" / "aston martin" /
 *  "Aston-Martin" all collapse so the unique constraint actually catches duplicates. */
function normaliseMake(s) {
  return String(s || "").toLowerCase().replace(/[-_\s]+/g, " ").trim();
}

/** Parse a freeform date like "June 15", "15/6/2026", "2026-06-15" into ISO yyyy-mm-dd.
 *  Returns null if we can't interpret it — the caller decides whether to reject the add
 *  or fall through to today's date. */
export function parseDate(input) {
  if (!input) return null;
  const s = String(input).trim();
  /* Already ISO. */
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s)) return s;

  /* Try Date parse — handles "June 15 2026", "15 June 2026", "Mon, 15 Jun 2026", etc.
   * If no year is given, assume the next occurrence (this year if still ahead, else next).
   * That's the right call for a calendar tool — operator says "June 15", they mean
   * the next June 15 that hasn't happened yet. */
  const now = new Date();
  let d = new Date(s);
  if (isNaN(d.getTime())) {
    /* Try with current year appended for bare "Jun 15" / "15 June" inputs. */
    d = new Date(`${s} ${now.getFullYear()}`);
    if (isNaN(d.getTime())) return null;
  }
  if (!/\d{4}/.test(s) && d < now) {
    /* Bare day/month input that resolves to a past date — bump to next year. */
    d.setFullYear(d.getFullYear() + 1);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Add a media-day event. Returns { id, normalised: { ... } } or { error } on duplicate.
 *
 * @param {object} args
 * @param {string} args.manufacturer    e.g. "the manufacturer"
 * @param {string} [args.vehicle]       e.g. "the new model S"
 * @param {string} args.date            ISO or freeform; passed through parseDate
 * @param {string} [args.location]      e.g. "Goodwood", "Silverstone"
 * @param {string} [args.kind]          press-day | track-day | launch | embargo | other
 * @param {string} [args.notes]
 * @param {string} [args.sourceUrl]
 */
export function addMediaDay(args) {
  const make = String(args.manufacturer || "").trim();
  if (!make) return { error: "manufacturer required" };
  const isoDate = parseDate(args.date);
  if (!isoDate) return { error: `cannot parse date: ${args.date}` };
  const kind = String(args.kind || "press-day").toLowerCase();
  if (!["press-day", "track-day", "launch", "embargo", "other"].includes(kind)) {
    return { error: `kind must be press-day / track-day / launch / embargo / other` };
  }
  try {
    const info = db.prepare(`
      INSERT INTO media_days (manufacturer, vehicle, date, location, kind, notes, source_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      make,
      args.vehicle || null,
      isoDate,
      args.location || null,
      kind,
      args.notes || null,
      args.sourceUrl || null,
      Date.now(),
    );
    return { ok: true, id: info.lastInsertRowid, manufacturer: make, vehicle: args.vehicle || null, date: isoDate, location: args.location || null, kind };
  } catch (e) {
    /* SQLite UNIQUE violation = duplicate add. Surface gracefully so the LLM doesn't
     * loop trying to re-add when an email is reprocessed. */
    if (String(e.message).includes("UNIQUE")) {
      return { ok: false, duplicate: true, error: `already in calendar: ${make} ${args.vehicle || ""} ${isoDate}`.trim() };
    }
    return { error: e.message };
  }
}

/**
 * List media-day events. Defaults to upcoming-only within the next 60 days.
 *
 * @param {object} [args]
 * @param {string} [args.manufacturer]    case-insensitive substring match
 * @param {number} [args.daysAhead=60]    upper bound on date filter; 0 means "any future"
 * @param {boolean} [args.includesPast]   include events whose date has already passed
 */
export function listMediaDays({ manufacturer, daysAhead = 60, includesPast = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const upper = daysAhead > 0
    ? new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10)
    : "9999-12-31";

  const conditions = [];
  const params = [];
  if (!includesPast) { conditions.push("date >= ?"); params.push(today); }
  conditions.push("date <= ?"); params.push(upper);
  if (manufacturer) {
    conditions.push("LOWER(manufacturer) LIKE ?");
    params.push(`%${normaliseMake(manufacturer)}%`);
  }

  const sql = `SELECT id, manufacturer, vehicle, date, location, kind, notes, source_url
                 FROM media_days
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY date ASC, manufacturer ASC`;
  return db.prepare(sql).all(...params).map((r) => ({
    id: r.id,
    manufacturer: r.manufacturer,
    vehicle: r.vehicle,
    date: r.date,
    location: r.location,
    kind: r.kind,
    notes: r.notes,
    sourceUrl: r.source_url,
  }));
}

/** Delete by id. Returns { ok: true, removed: 1 } or { ok: false, removed: 0 }. */
export function deleteMediaDay({ id }) {
  if (!Number.isFinite(Number(id))) return { ok: false, error: "id required" };
  const info = db.prepare("DELETE FROM media_days WHERE id = ?").run(Number(id));
  return { ok: info.changes > 0, removed: info.changes };
}

/** One-line summary for the COMMS panel. "3 media days: the client the new model S (Jun 15) ·
 *  McLaren launch (Jun 22) · Bentley press (Jul 02)". Empty string if nothing. */
export function upcomingSummary(daysAhead = 60) {
  const evts = listMediaDays({ daysAhead });
  if (!evts.length) return "";
  const fmt = (d) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const items = evts.slice(0, 3).map((e) =>
    `${e.manufacturer.split(/\s+/)[0]}${e.vehicle ? " " + e.vehicle : ""} (${fmt(e.date)})`
  );
  const more = evts.length > 3 ? ` +${evts.length - 3}` : "";
  return `${evts.length} media day${evts.length === 1 ? "" : "s"}: ${items.join(" · ")}${more}`;
}
