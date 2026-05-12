/** mac-control.mjs — macOS system actions over osascript.
 *
 *  Voice-first kiosk verbs that Siri does badly on the Mac: open
 *  applications by name, set system volume, lock the screen, type text
 *  into the focused app. Each verb is a thin osascript wrapper — no
 *  Swift/ObjC bridge, no third-party deps, just AppleScript via
 *  `osascript -e`.
 *
 *  Permissions:
 *    - openApp / setVolume / lockScreen — no special permission needed
 *      beyond the bridge process being a normal user process.
 *    - typeText — requires Accessibility permission (System Settings →
 *      Privacy & Security → Accessibility). osascript surfaces a clear
 *      error if it's missing; the wrapper maps it to a friendly message.
 *
 *  Caller pattern (in tool-router):
 *    case "open_app": return await MacControl.openApp(args.name);
 *
 *  Confirmation gating for typeText is the tool-router's job, not this
 *  module's — keeps the AppleScript layer dumb so it stays testable
 *  without a HUD round-trip.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const OSA_TIMEOUT_MS = 3000;

/** Sanitise a string for safe AppleScript string-literal embedding.
 *  AppleScript strings use double quotes; the only escape we need is for
 *  inner double quotes (\") and backslash (\\). No unicode quoting needed
 *  — osascript accepts UTF-8 directly. */
function escapeForApplescript(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Run an AppleScript and return its trimmed stdout. Maps the common
 *  Accessibility-permission errors to a friendly explanation. */
async function runScript(script) {
  try {
    const { stdout } = await execFileP("osascript", ["-e", script], {
      timeout: OSA_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (e) {
    const stderr = String(e.stderr || e.message || "");
    if (stderr.includes("not allowed assistive access") ||
        stderr.includes("1002") || stderr.includes("-25211")) {
      return {
        ok: false,
        error: "Accessibility permission required — grant via System Settings → Privacy & Security → Accessibility.",
      };
    }
    return { ok: false, error: stderr.slice(0, 200) || "osascript failed" };
  }
}

/** Activate (open + foreground) a macOS application by name.
 *  Examples: "Photoshop", "Safari", "Mail", "Visual Studio Code".
 *
 *  AppleScript's `tell application "X" to activate` both launches the app
 *  if needed and brings it to the front if already running. Returns the
 *  resolved bundle name from System Events so the caller can confirm.
 */
export async function openApp(name) {
  if (!name || typeof name !== "string") return { ok: false, error: "missing app name" };
  const safe = escapeForApplescript(name);
  /* The `tell application` form is liberal — accepts "Photoshop",
   * "Adobe Photoshop 2024", or the bundle ID. If the name doesn't match
   * a registered app, osascript errors with "Application isn't running". */
  const script = `tell application "${safe}" to activate`;
  const r = await runScript(script);
  if (!r.ok) {
    /* Friendly "app not found" mapping — osascript's error is opaque. */
    if (r.error.includes("isn't running") || r.error.includes("-1728")) {
      return { ok: false, error: `Application "${name}" not found. Check spelling or full name (e.g. "Adobe Photoshop 2024").` };
    }
    return r;
  }
  return { ok: true, app: name };
}

/** Set macOS output volume to a 0-100 integer. Mutes at 0.
 *  Returns the level that was set (clamped). */
export async function setVolume(level) {
  const n = Math.max(0, Math.min(100, Math.round(Number(level))));
  if (!Number.isFinite(n)) return { ok: false, error: "volume must be a number 0-100" };
  const script = `set volume output volume ${n}`;
  const r = await runScript(script);
  if (!r.ok) return r;
  return { ok: true, level: n };
}

/** Lock the screen — display sleeps immediately, password required on
 *  wake (assuming the operator has require-password-after-sleep enabled
 *  in Lock Screen settings, which is the macOS default).
 *
 *  Uses pmset rather than AppleScript Cmd+Ctrl+Q because pmset works
 *  even without Accessibility permission. */
export async function lockScreen() {
  try {
    await execFileP("pmset", ["displaysleepnow"], { timeout: 2000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

/** Type a string into whatever app is currently focused — useful for
 *  filling forms by voice ("type my email address"), pasting boilerplate,
 *  or quick search-bar entry without touching the keyboard.
 *
 *  REQUIRES Accessibility permission (System Events keystroke). The
 *  tool-router should confirmation-gate this verb because typing into
 *  the wrong app (especially a password field) is destructive. */
export async function typeText(text) {
  if (typeof text !== "string") return { ok: false, error: "missing text" };
  if (text.length === 0) return { ok: false, error: "empty text" };
  if (text.length > 4000) return { ok: false, error: "text too long (max 4000 chars)" };
  const safe = escapeForApplescript(text);
  const script = `tell application "System Events" to keystroke "${safe}"`;
  const r = await runScript(script);
  if (!r.ok) return r;
  return { ok: true, length: text.length };
}
