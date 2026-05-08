/** personal.mjs - Daily-life personal-assistant tools.
 *
 *  Four high-frequency operator commands — text someone, set a reminder,
 *  start a kitchen timer, play music — implemented entirely via macOS
 *  AppleScript (osascript). No API keys, no cloud cost, no external deps.
 *
 *  Why osascript: every native macOS app exposes a scripting interface, and
 *  these four touch four different ones (Messages, Reminders, an in-bridge
 *  timer registry, Music/Spotify). osascript is the lowest-common-denominator
 *  surface that works on any Mac without installing anything. The tradeoff
 *  is selectors that may break across macOS major versions — this module is
 *  scoped narrow enough that fixing breakage is a few-minute job.
 *
 *  Each tool is exposed via the bridge's standard tool dispatch path and
 *  goes through the existing NEEDS_CONFIRMATION gate where appropriate.
 */

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
const execFile = promisify(_execFile);

/** Run an AppleScript string with osascript -e. Returns stdout trimmed. */
async function runOsa(script) {
  const { stdout } = await execFile("/usr/bin/osascript", ["-e", script], { timeout: 10_000 });
  return String(stdout || "").trim();
}

/** Escape a string for embedding inside an AppleScript double-quoted literal.
 *  Backslash and quote — that's it. AppleScript's string syntax is simpler
 *  than JS's so don't over-engineer. */
function osaQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/* ------------------------------------------------------------------------- *
 * 1. iMessage / Messages
 *
 * Sends via the Messages app. Recipient can be a phone number, email, or a
 * contact name (Messages resolves names against Contacts). For names with
 * multiple matches we accept the first; the operator can use the phone
 * number explicitly if they want a specific contact.
 *
 * macOS asks for "Full Disk Access" the first time Messages is scripted —
 * the operator approves this once in System Settings → Privacy & Security.
 * ------------------------------------------------------------------------- */

export async function sendIMessage({ to, body }) {
  const recipient = String(to || "").trim();
  const message = String(body || "").trim();
  if (!recipient) return { ok: false, error: "to (phone/email/contact name) required" };
  if (!message) return { ok: false, error: "body required" };
  /* Resolution path: if recipient looks like a phone or email, send direct.
   * Otherwise, look up the first contact whose full name matches and use
   * their primary handle. The "first" picker is intentional — voice queries
   * like "text Adam" should pick the obvious one, not prompt for disambiguation. */
  const isPhoneOrEmail = /[@\d]/.test(recipient) && /[\d@]/.test(recipient);
  let script;
  if (isPhoneOrEmail) {
    script = `
tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy ${osaQuote(recipient)} of targetService
  send ${osaQuote(message)} to targetBuddy
end tell
return "sent"`;
  } else {
    /* Name lookup. Tries iMessage first, falls back to SMS via primary handle.
     * AppleScript's Contacts query returns a list — pick the first match. */
    script = `
tell application "Contacts"
  set matches to every person whose name contains ${osaQuote(recipient)}
  if (count of matches) = 0 then return "not_found"
  set p to item 1 of matches
  set handles to {}
  if (count of phones of p) > 0 then set end of handles to value of phone 1 of p
  if (count of emails of p) > 0 then set end of handles to value of email 1 of p
  if (count of handles) = 0 then return "no_handle"
  set targetHandle to item 1 of handles
end tell
tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  try
    set targetBuddy to buddy targetHandle of targetService
    send ${osaQuote(message)} to targetBuddy
  on error
    send ${osaQuote(message)} to targetHandle
  end try
end tell
return "sent"`;
  }
  try {
    const result = await runOsa(script);
    if (result === "not_found") return { ok: false, error: `No contact found matching "${recipient}". Try a phone number or email.` };
    if (result === "no_handle") return { ok: false, error: `Contact "${recipient}" has no phone or email on file.` };
    return { ok: true, sent: true, to: recipient, length: message.length };
  } catch (e) {
    /* errAEEventNotPermitted (-1743) → the operator hasn't granted automation
     * permission to Messages yet. Surface clearly so they know what to fix. */
    if (/-1743/.test(String(e.message))) {
      return { ok: false, error: "Messages automation not permitted. Open System Settings → Privacy & Security → Automation → enable osascript / Terminal access to Messages." };
    }
    return { ok: false, error: `osascript failed: ${e.message}` };
  }
}

/* ------------------------------------------------------------------------- *
 * 2. Apple Reminders
 *
 * Adds a reminder to the operator's default Reminders list. Optional due
 * date (any string osascript date can parse — "tomorrow at 6pm", explicit
 * "2026-05-15 18:00", etc). Uses an inline LLM-friendly date string so the
 * caller doesn't have to do timezone arithmetic.
 * ------------------------------------------------------------------------- */

export async function addReminder({ title, due = null, notes = "", listName = null }) {
  const t = String(title || "").trim();
  if (!t) return { ok: false, error: "title required" };
  /* Build the AppleScript record incrementally — only set fields the caller
   * provided so missing values don't override defaults with empty strings. */
  const props = [`name:${osaQuote(t)}`];
  if (notes) props.push(`body:${osaQuote(String(notes))}`);
  if (due) {
    /* Trust JavaScript for date parsing — it's far more forgiving than
     * AppleScript's `date "..."` literal. We pass an ISO-ish string that
     * AppleScript can re-parse, falling back to no-date if invalid. */
    const dt = new Date(due);
    if (Number.isFinite(dt.getTime())) {
      const localISO = dt.toISOString();
      props.push(`remind me date:(date ${osaQuote(localISO)})`);
    }
  }
  const listClause = listName
    ? `tell list ${osaQuote(String(listName))} to make new reminder with properties {${props.join(", ")}}`
    : `tell default list to make new reminder with properties {${props.join(", ")}}`;
  const script = `tell application "Reminders"
  ${listClause}
end tell
return "added"`;
  try {
    await runOsa(script);
    return { ok: true, title: t, due: due || null, list: listName || "default" };
  } catch (e) {
    if (/-1743/.test(String(e.message))) {
      return { ok: false, error: "Reminders automation not permitted. Approve in System Settings → Privacy & Security → Automation." };
    }
    return { ok: false, error: `osascript failed: ${e.message}` };
  }
}

/* ------------------------------------------------------------------------- *
 * 3. In-bridge timer
 *
 * Lives in-process — the bridge holds a Map of active timers and pushes
 * timer.fire events when they expire. The HUD shows them in a corner badge
 * (same flashPurchaseAuditBadge pattern), and Kokoro speaks the label.
 *
 * Why in-process not osascript: macOS has no native "kitchen timer" the way
 * iOS does. The Calendar app's "alert" requires an event with a start date,
 * which clutters the diary. A pure JS setTimeout + broadcast is cleaner.
 * ------------------------------------------------------------------------- */

const _activeTimers = new Map();

let _broadcaster = null;
/** Wired from server.mjs at boot — same pattern as Tasks/Notify. */
export function setBroadcaster(fn) { _broadcaster = typeof fn === "function" ? fn : null; }

export function setTimer({ minutes, label = null }) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return { ok: false, error: "minutes must be a positive number" };
  if (m > 720) return { ok: false, error: "Timer cap is 12 hours. For longer waits, use add_reminder." };
  const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const fireAt = Date.now() + m * 60 * 1000;
  const cleanLabel = String(label || `${m} minute timer`).slice(0, 80);
  /* Why setTimeout not setInterval: one-shot fires are simpler. We track
   * fireAt explicitly so the HUD can show a countdown rather than polling. */
  const handle = setTimeout(() => {
    _activeTimers.delete(id);
    if (_broadcaster) _broadcaster({ type: "timer.fire", data: { id, label: cleanLabel, fireAt } });
  }, m * 60 * 1000);
  _activeTimers.set(id, { id, label: cleanLabel, fireAt, handle });
  if (_broadcaster) _broadcaster({ type: "timer.set", data: { id, label: cleanLabel, fireAt, minutes: m } });
  return { ok: true, id, label: cleanLabel, minutes: m, fireAt };
}

export function listTimers() {
  return Array.from(_activeTimers.values()).map(({ id, label, fireAt }) => ({ id, label, fireAt, minutesLeft: Math.max(0, (fireAt - Date.now()) / 60_000) }));
}

export function cancelTimer({ id }) {
  const entry = _activeTimers.get(String(id || ""));
  if (!entry) return { ok: false, error: "timer not found" };
  clearTimeout(entry.handle);
  _activeTimers.delete(entry.id);
  if (_broadcaster) _broadcaster({ type: "timer.cancel", data: { id: entry.id } });
  return { ok: true, id: entry.id };
}

/* ------------------------------------------------------------------------- *
 * 4. Music control
 *
 * Plays via Apple Music or Spotify. Operator picks via { app } or we default
 * to Apple Music (always present on macOS). Spotify scripting requires the
 * Spotify desktop app installed and signed in.
 *
 * For Apple Music: a "search" instructs the app to load matching tracks
 * from the library. For Spotify: we use the play track URI form which
 * accepts a search query directly via the URI scheme.
 * ------------------------------------------------------------------------- */

export async function playMusic({ query = "", app = "music" }) {
  const q = String(query || "").trim();
  const target = String(app || "music").toLowerCase();
  if (!q) {
    /* No query — treat as "resume". For both apps, just send play. */
    const appName = target === "spotify" ? "Spotify" : "Music";
    try {
      await runOsa(`tell application ${osaQuote(appName)} to play`);
      return { ok: true, action: "resumed", app: appName };
    } catch (e) {
      return { ok: false, error: `Could not control ${appName}: ${e.message}` };
    }
  }

  if (target === "spotify") {
    /* Spotify accepts spotify:search:... URIs but practically we just open
     * a search in the app and tell it to play the top result. Keeps things
     * simple at the cost of one extra click sometimes. */
    const script = `
tell application "Spotify"
  activate
  set search query to ${osaQuote(q)}
end tell
delay 0.6
tell application "System Events" to keystroke return
return "searched"`;
    try {
      await runOsa(script);
      return { ok: true, action: "searched", app: "Spotify", query: q };
    } catch (e) {
      return { ok: false, error: `Spotify control failed: ${e.message}. Is the Spotify app installed and signed in?` };
    }
  }

  /* Apple Music — use library search + play of the first matching track. */
  const script = `
tell application "Music"
  activate
  set theTracks to (every track of library playlist 1 whose name contains ${osaQuote(q)} or artist contains ${osaQuote(q)})
  if (count of theTracks) > 0 then
    play (item 1 of theTracks)
    return "played_local"
  else
    -- Fall back to Apple Music's search UI; user picks.
    delay 0.3
    tell application "System Events" to keystroke "f" using {command down, option down}
    delay 0.2
    tell application "System Events" to keystroke ${osaQuote(q)}
    return "searched_remote"
  end if
end tell`;
  try {
    const r = await runOsa(script);
    return { ok: true, action: r, app: "Music", query: q };
  } catch (e) {
    return { ok: false, error: `Music control failed: ${e.message}` };
  }
}

export async function pauseMusic({ app = "music" } = {}) {
  const appName = String(app).toLowerCase() === "spotify" ? "Spotify" : "Music";
  try {
    await runOsa(`tell application ${osaQuote(appName)} to pause`);
    return { ok: true, action: "paused", app: appName };
  } catch (e) {
    return { ok: false, error: `Could not pause ${appName}: ${e.message}` };
  }
}

/* ------------------------------------------------------------------------- *
 * 5. Read article (URL → cleaned text)
 *
 * Fetches a URL, strips boilerplate, returns text the LLM can summarise.
 * Deliberately simple — no Readability port, no heavy dep. Strategy:
 *   1. Fetch with a normal browser UA so paywalls / bot-detectors don't
 *      reject us outright.
 *   2. Prefer text inside <article>, then <main>, then <body>.
 *   3. Strip <script>, <style>, <nav>, <header>, <footer>, <aside>.
 *   4. Cap at ~12k chars — most articles fit, longer ones get truncated
 *      with a clear marker so the LLM can flag if it needs more.
 *
 * The caller is the LLM — it receives the raw text and produces a summary
 * via the operator's chosen provider. We don't summarise here; that would
 * pin the choice of model.
 * ------------------------------------------------------------------------- */

const ARTICLE_MAX_CHARS = 12_000;

export async function readArticle({ url }) {
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, error: "url must be http:// or https://" };
  let html;
  try {
    const r = await fetch(u, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Jarvis/1.0",
        "accept": "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status} from ${u}` };
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("html")) return { ok: false, error: `Expected HTML, got ${ct}` };
    html = await r.text();
  } catch (e) {
    return { ok: false, error: `Fetch failed: ${e.message}` };
  }
  const text = extractArticleText(html);
  const truncated = text.length > ARTICLE_MAX_CHARS;
  const final = truncated ? text.slice(0, ARTICLE_MAX_CHARS) + "\n\n[truncated]" : text;
  /* Title pass — first <title> is good enough; readability libs do better
   * but the cost/benefit isn't there for a first pass. */
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return {
    ok: true,
    url: u,
    title: titleMatch ? titleMatch[1].trim().slice(0, 200) : null,
    chars: final.length,
    truncated,
    text: final,
  };
}

/** Crude HTML → text. Removes scripts/styles/nav/footer/aside, then strips
 *  tags, then collapses whitespace. Not as good as Readability but cheap and
 *  good enough for ~80% of articles. */
function extractArticleText(html) {
  let body = html;
  /* Prefer <article> when present — most outlets wrap their main column in one. */
  const articleMatch = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) body = articleMatch[1];
  else {
    const mainMatch = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) body = mainMatch[1];
  }
  /* Kill noise containers entirely (inc. their content). */
  body = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "");
  /* Convert block-level closes to newlines so paragraph breaks survive. */
  body = body.replace(/<\/(p|div|h[1-6]|li|br)\s*\/?>/gi, "\n");
  /* Strip remaining tags. Decode the four critical entities; anything more
   * exotic falls back to its raw form (good enough for an LLM consumer). */
  body = body.replace(/<[^>]+>/g, "");
  body = body.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  /* Collapse whitespace runs but preserve paragraph breaks. */
  body = body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return body;
}

/* ------------------------------------------------------------------------- *
 * 6. Take screenshot (optionally describe via vision LLM)
 *
 * Wraps macOS's `screencapture`. Three regions:
 *   - "screen" — full primary display (default)
 *   - "window" — interactive: operator clicks the window to capture
 *   - "selection" — interactive: operator drags a selection
 * Output saved to data/screenshots/. The caller (LLM) gets the path back
 * and can optionally pipe it to a vision-capable provider for description.
 * ------------------------------------------------------------------------- */

export async function takeScreenshot({ region = "screen" } = {}) {
  const dir = await import("node:path").then((p) => p.resolve(process.cwd(), "data", "screenshots"));
  const fs = await import("node:fs/promises");
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `screen-${ts}.png`;
  const path = (await import("node:path")).join(dir, filename);
  const args = ["-x"]; // -x suppresses the camera shutter sound
  switch (String(region).toLowerCase()) {
    case "window":    args.push("-W"); break;       // interactive window
    case "selection": args.push("-i", "-s"); break; // interactive selection, no overlay
    case "screen":
    default:                                            break; // full screen
  }
  args.push(path);
  try {
    await execFile("/usr/sbin/screencapture", args, { timeout: 30_000 });
    /* Verify the file actually appeared — interactive modes can be cancelled
     * by the operator hitting Esc, in which case screencapture exits 0 with
     * no output file. We surface that as a clear "cancelled" rather than a
     * fake success. */
    try { await fs.stat(path); }
    catch { return { ok: false, error: "Screenshot cancelled by operator." }; }
    return { ok: true, path, region: String(region) };
  } catch (e) {
    return { ok: false, error: `screencapture failed: ${e.message}` };
  }
}

/* ------------------------------------------------------------------------- *
 * 7. Set Focus mode
 *
 * macOS's Focus modes (Do Not Disturb, Work, Personal, etc) are scriptable
 * via the Shortcuts app. We invoke a pre-existing shortcut named exactly
 * the focus mode the operator wants. The shortcut's body is:
 *   `Set Focus → <Mode> → Turn On <until end of day | for N hours>`
 *
 * The operator builds the shortcut once in Shortcuts.app. We surface a clear
 * error if the named shortcut doesn't exist (so the LLM can tell them how
 * to set it up).
 * ------------------------------------------------------------------------- */

export async function setFocus({ mode, until = null }) {
  const m = String(mode || "").trim();
  if (!m) return { ok: false, error: "mode required (e.g. 'Do Not Disturb', 'Work', 'Personal')" };
  /* Convention: Shortcuts named "Focus On <mode>" toggle the mode on. */
  const shortcutName = `Focus On ${m}`;
  try {
    /* The `shortcuts` CLI ships with macOS 12+. We pipe the optional `until`
     * value as input; the Shortcut can ignore it or use it as it sees fit. */
    await execFile("/usr/bin/shortcuts", ["run", shortcutName, ...(until ? ["--input-text", String(until)] : [])], { timeout: 8_000 });
    return { ok: true, mode: m, until: until || null, hint: "Focus mode requested via Shortcuts. Watch the menu bar for the indicator." };
  } catch (e) {
    if (/no shortcuts named/i.test(String(e.stderr || e.message))) {
      return {
        ok: false,
        error: `No Shortcut named "${shortcutName}". In Shortcuts.app create one with body: Set Focus → ${m} → Turn On. Then try again.`,
      };
    }
    return { ok: false, error: `shortcuts CLI failed: ${e.message}` };
  }
}

/* ------------------------------------------------------------------------- *
 * 8. 1Password lookup
 *
 * Reads a single field from 1Password via the `op` CLI. Operator must have
 * `op` installed (brew install --cask 1password-cli) and have run `op signin`
 * at least once in the current session.
 *
 * We deliberately return the value to the LLM — that's the whole point. Trust
 * boundary: the LLM's response is read aloud / shown to the operator, never
 * sent over the network without an explicit downstream tool that the user
 * approved (e.g. send_imessage's confirmation gate).
 * ------------------------------------------------------------------------- */

export async function lookupPassword({ label, field = "password" }) {
  const l = String(label || "").trim();
  if (!l) return { ok: false, error: "label required (the 1Password item name)" };
  if (!/^[a-z_]+$/i.test(String(field))) return { ok: false, error: "field must be alphanumeric (e.g. 'password', 'username', 'totp')" };
  try {
    const { stdout } = await execFile("/usr/local/bin/op", ["item", "get", l, "--field", String(field), "--format=json"], { timeout: 10_000 });
    const j = JSON.parse(stdout || "{}");
    return { ok: true, label: l, field, value: j.value || j.totp || "" };
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/command not found|ENOENT/i.test(msg)) {
      return { ok: false, error: "1Password CLI not installed. Install with: brew install --cask 1password-cli" };
    }
    if (/not signed in|session expired/i.test(msg)) {
      return { ok: false, error: "1Password CLI session expired. Run: eval $(op signin)" };
    }
    if (/More than one item matches|isn't an item/i.test(msg)) {
      return { ok: false, error: `1Password lookup for "${l}" failed: ${msg.slice(0, 200)}` };
    }
    return { ok: false, error: `op failed: ${msg.slice(0, 200)}` };
  }
}

/* ------------------------------------------------------------------------- *
 * 9. Compose note (Apple Notes / Bear / Obsidian)
 *
 * Adds a note via the chosen app's scripting interface. Apple Notes has
 * native AppleScript; Bear has its x-callback-url scheme; Obsidian uses a
 * URL handler. Default is Apple Notes since it's preinstalled.
 *
 * For Bear/Obsidian, the operator must have the apps installed and the
 * relevant URL handlers registered. We surface clear errors if the URL
 * scheme fails.
 * ------------------------------------------------------------------------- */

export async function composeNote({ title, body = "", app = "notes" }) {
  const t = String(title || "").trim();
  if (!t) return { ok: false, error: "title required" };
  const target = String(app).toLowerCase();
  const content = `${t}\n\n${String(body || "")}`;

  if (target === "notes") {
    /* Apple Notes — make new note in default folder. The first line of the
     * body becomes the note's title in the UI. */
    const script = `
tell application "Notes"
  tell account "iCloud"
    set newNote to make new note with properties {name:${osaQuote(t)}, body:${osaQuote(content.replace(/\n/g, "<br>"))}}
  end tell
end tell
return "added"`;
    try {
      await runOsa(script);
      return { ok: true, app: "Apple Notes", title: t };
    } catch (e) {
      if (/-1743/.test(String(e.message))) {
        return { ok: false, error: "Notes automation not permitted. Approve in System Settings → Privacy & Security → Automation." };
      }
      return { ok: false, error: `Notes failed: ${e.message}` };
    }
  }

  if (target === "bear") {
    /* Bear's x-callback-url. We don't need a callback — fire-and-forget via
     * `open` with the URL constructed from the operator's title + body. */
    const url = `bear://x-callback-url/create?title=${encodeURIComponent(t)}&text=${encodeURIComponent(body)}&open_note=no`;
    try {
      await execFile("/usr/bin/open", [url], { timeout: 4_000 });
      return { ok: true, app: "Bear", title: t };
    } catch (e) {
      return { ok: false, error: `Bear URL handler failed: ${e.message}. Is Bear installed?` };
    }
  }

  if (target === "obsidian") {
    /* Obsidian URI scheme — requires Obsidian to be running and a default
     * vault to be set. */
    const url = `obsidian://new?name=${encodeURIComponent(t)}&content=${encodeURIComponent(body)}`;
    try {
      await execFile("/usr/bin/open", [url], { timeout: 4_000 });
      return { ok: true, app: "Obsidian", title: t };
    } catch (e) {
      return { ok: false, error: `Obsidian URL handler failed: ${e.message}. Is Obsidian installed and a vault configured?` };
    }
  }

  return { ok: false, error: `Unknown notes app "${app}". Use one of: notes, bear, obsidian.` };
}
