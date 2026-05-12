/** calendar.mjs - macOS Calendar.app integration via AppleScript.
 *  If the operator's Google account is synced to Calendar.app (default for most macOS users),
 *  events written here propagate back to Google automatically.
 *
 *  Tools:
 *    get_upcoming_events({ days })             - returns events from now to now+days
 *    add_calendar_event({ title, start, end, location, notes, calendarName })
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Run AppleScript and return stdout. Surfaces the real osascript stderr on
 *  failure rather than Node's default "Command failed: …" preamble — otherwise
 *  the HUD sees a useless echo of the script's first 40 chars. */
async function osa(script) {
  try {
    const { stdout, stderr } = await execFileP("osascript", ["-e", script], { maxBuffer: 8 * 1024 * 1024 });
    if (stderr && !stdout) throw new Error(humaniseAppleScriptError(stderr.trim()));
    return stdout;
  } catch (e) {
    /* execFileP rejection: e.stderr is the real osascript output, e.message is
     * Node's reformat. Prefer stderr; humanise common patterns so the HUD shows
     * "Calendar permission not granted" instead of "-1743 errAEEventNotPermitted". */
    const raw = (e.stderr || e.message || "").toString().trim();
    throw new Error(humaniseAppleScriptError(raw));
  }
}

/** Map opaque osascript errors to operator-readable messages. Falls back to the
 *  raw error if no pattern matches. */
function humaniseAppleScriptError(raw) {
  if (!raw) return "AppleScript failed (no message)";
  /* Common osascript exit codes the bridge has actually hit in the field. */
  if (/-1743|errAEEventNotPermitted|not authorized|not allowed assistive access/i.test(raw)) {
    return "Calendar permission not granted — open System Settings → Privacy & Security → Automation, give Terminal/Bridge access to Calendar.";
  }
  if (/-600|application isn't running|application is not running/i.test(raw)) {
    return "Calendar.app not running. Open it once manually, then retry.";
  }
  if (/-1719|invalid index|missing value/i.test(raw)) {
    return "Calendar returned an invalid index — likely an empty calendar. " + raw.split("\n")[0];
  }
  if (/syntax error|expected end of line/i.test(raw)) {
    return "AppleScript syntax error — please report. " + raw.split("\n")[0];
  }
  /* Unknown error: drop "Command failed:" / "execFile:" preambles + return the
   * tail line which is usually where osascript's actual diagnostic lives. */
  const cleaned = raw.replace(/^Command failed:.*\n?/, "").replace(/^.*execFileP?:?\s*/, "").trim();
  const tail = cleaned.split("\n").filter(Boolean).pop() || cleaned;
  return tail.slice(0, 200);
}

/* Why: `application "Calendar" is running` returns true even when only the widget
 * extension is alive (CalendarWidgetExtension). The actual GUI Calendar.app needs
 * to be running for `tell application "Calendar"` blocks to succeed — otherwise we
 * hit -600 ("Application isn't running") even though our `is running` check said
 * yes. Detecting the real GUI process via pgrep against the GUI binary path fixes
 * this. Cached after first successful detection so we don't re-pgrep every call. */
let calendarLaunched = false;
async function ensureCalendarRunning() {
  if (calendarLaunched) return;
  try {
    /* pgrep against the GUI binary specifically. The widget extension lives at
     * .../Calendar.app/Contents/PlugIns/CalendarWidgetExtension.appex/... — different
     * path. Exact match on the GUI executable means we only match the actual app. */
    const guiCheck = await execFileP("pgrep", ["-fl", "Calendar.app/Contents/MacOS/Calendar"]).catch(() => ({ stdout: "" }));
    const guiRunning = (guiCheck.stdout || "").trim().length > 0;
    if (!guiRunning) {
      await execFileP("open", ["-a", "Calendar"]);
      /* Poll for the GUI to actually accept AppleEvents — `open -a` returns immediately
       * but the app needs ~1-2s to register its scripting interface. Try up to 5s. */
      for (let i = 0; i < 25; i++) {
        await new Promise(r => setTimeout(r, 200));
        const r = await execFileP("pgrep", ["-fl", "Calendar.app/Contents/MacOS/Calendar"]).catch(() => ({ stdout: "" }));
        if ((r.stdout || "").trim().length > 0) break;
      }
    }
    calendarLaunched = true;
  } catch (e) {
    console.warn(`[calendar] could not ensure Calendar.app running: ${e.message}`);
  }
}

/** Format JS Date → AppleScript-friendly date string (system locale). */
function asDateExpr(d) {
  const yr = d.getFullYear(), mo = d.getMonth() + 1, dy = d.getDate();
  const hr = d.getHours(), mi = d.getMinutes(), se = d.getSeconds();
  // Build via "current date" then setters — robust across locales
  return `(my dateBuilder(${yr}, ${mo}, ${dy}, ${hr}, ${mi}, ${se}))`;
}

const dateBuilderHelper = `
on dateBuilder(yr, mo, dy, hr, mi, se)
  set d to current date
  set year of d to yr
  set month of d to mo
  set day of d to dy
  set hours of d to hr
  set minutes of d to mi
  set seconds of d to se
  return d
end dateBuilder

-- ISO-8601 formatter for AppleScript dates. Why: \`set evStart to (start date of ev as string)\`
-- produces a localised string ("Sunday, 4 May 2026 at 14:30:00") that JS Date() can't reliably
-- parse — every event then fails JS-side date filtering and the diary widget shows 0 events.
-- Outputting yyyy-mm-ddTHH:MM:SS gives JS a string it parses without locale assumptions.
on padTwo(n)
  set s to (n as integer) as string
  if (length of s) is 1 then return "0" & s
  return s
end padTwo

on isoDate(d)
  set yr to year of d as integer
  set mo to month of d as integer
  set dy to day of d as integer
  set hr to hours of d as integer
  set mi to minutes of d as integer
  set se to seconds of d as integer
  return (yr as string) & "-" & padTwo(mo) & "-" & padTwo(dy) & "T" & padTwo(hr) & ":" & padTwo(mi) & ":" & padTwo(se)
end isoDate
`;

/* ---------- TOOL: get upcoming events ---------- *
 *
 *  Cache: 5-minute TTL keyed by `${days}|${calendarName||""}`. Calendar.app
 *  via AppleScript is the slowest dependency in this module (~600ms when warm,
 *  several seconds on cold launch). Caching makes "what's on today" answer
 *  instantly after the first call; the prewarm module keeps the days:1 key
 *  warm so the first call is also instant. invalidate() clears the cache
 *  after a mutation so a freshly-added event surfaces immediately. */
const _cache = new Map(); /* key → { stamp, value } */
const CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidate() { _cache.clear(); }

export async function getUpcomingEvents({ days = 7, calendarName, force = false } = {}) {
  const key = `${days}|${calendarName || ""}`;
  if (!force) {
    const hit = _cache.get(key);
    if (hit && (Date.now() - hit.stamp) < CACHE_TTL_MS) {
      return { ...hit.value, fromCache: true };
    }
  }
  await ensureCalendarRunning();
  const now = new Date();
  const until = new Date(now.getTime() + days * 86400_000);
  const calClause = calendarName
    ? `calendar "${calendarName.replace(/"/g, '\\"')}"`
    : `every calendar`;

  /* AppleScript builds a list of "TITLE | YYYY-MM-DDTHH:MM | LOCATION" lines for events whose
   * start date is between now and until. Output one event per line. */
  /* Why: ensure Calendar is running BEFORE the first 'tell' block — `tell to launch` and
   * the next tell block share no synchronisation, so AppleScript can fire the query while
   * the app is still booting. We poll-and-wait up to 3s for `running` to be true so the
   * subsequent query has a live target. Without this we hit "-600 Application isn't running"
   * on a fresh login when the kiosk launches before Calendar.app is open. */
  const script = `${dateBuilderHelper}
set rangeStart to ${asDateExpr(now)}
set rangeEnd to ${asDateExpr(until)}
set output to ""

if application "Calendar" is not running then
  tell application "Calendar" to launch
  set tries to 0
  repeat while tries < 30 and not (application "Calendar" is running)
    delay 0.1
    set tries to tries + 1
  end repeat
  delay 0.5
end if

tell application "Calendar"
  set theCals to ${calClause}
  repeat with c in theCals
    try
      set theEvents to (every event of c whose start date is greater than or equal to rangeStart and start date is less than or equal to rangeEnd)
      repeat with ev in theEvents
        set evTitle to (summary of ev as string)
        set evStart to my isoDate(start date of ev)
        set evLoc to ""
        try
          set rawLoc to location of ev
          -- AppleScript's "missing value" coerces to the literal text "missing value"
          -- when there's no location set. Skip in that case so the diary doesn't
          -- render "missing value" verbatim under each event.
          if rawLoc is not missing value then set evLoc to (rawLoc as string)
        end try
        set output to output & evTitle & " | " & evStart & " | " & evLoc & " | " & (name of c as string) & linefeed
      end repeat
    end try
  end repeat
end tell
return output`;

  const stdout = await osa(script);
  const events = stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [title = "", start = "", location = "", calendar = ""] = line.split(" | ");
    return { title: title.trim(), start: start.trim(), location: location.trim(), calendar: calendar.trim() };
  });
  const value = { ok: true, count: events.length, events };
  _cache.set(key, { stamp: Date.now(), value });
  return value;
}

/* ---------- TOOL: add calendar event ---------- */
export async function addCalendarEvent({ title, start, end, location = "", notes = "", calendarName }) {
  if (!title) throw new Error("title required");
  if (!start) throw new Error("start required (ISO 8601 or parseable date)");

  const startDate = new Date(start);
  if (isNaN(startDate)) throw new Error(`invalid start date: ${start}`);
  // Default 1h if no end given
  const endDate = end ? new Date(end) : new Date(startDate.getTime() + 60 * 60_000);
  if (isNaN(endDate)) throw new Error(`invalid end date: ${end}`);

  const calClause = calendarName
    ? `(first calendar whose name is "${calendarName.replace(/"/g, '\\"')}")`
    : `(first writable calendar of every account whose calendar count > 0)`;

  /* If no calendarName given, just use the first calendar — usually the user's default. */
  const fallbackCal = calendarName ? calClause : `(first calendar)`;

  const script = `${dateBuilderHelper}
set theStart to ${asDateExpr(startDate)}
set theEnd to ${asDateExpr(endDate)}
set theTitle to "${title.replace(/"/g, '\\"')}"
set theLoc to "${location.replace(/"/g, '\\"')}"
set theNotes to "${notes.replace(/"/g, '\\"')}"
tell application "Calendar"
  activate
  set theCal to ${fallbackCal}
  set newEvent to make new event at end of events of theCal with properties {summary:theTitle, start date:theStart, end date:theEnd, location:theLoc, description:theNotes}
  return (summary of newEvent as string) & " | " & (start date of newEvent as string)
end tell`;

  const stdout = await osa(script);
  return { ok: true, created: stdout.trim(), title, start: startDate.toISOString(), end: endDate.toISOString() };
}
