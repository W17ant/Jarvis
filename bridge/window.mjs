/** window.mjs - Active-window introspection via macOS Accessibility API.
 *
 *  Why: vision models are the wrong hammer for "what's open in Premiere?" type
 *  queries when the OS already exposes a structured UI tree via AXUIElement.
 *  Cheaper, faster, more accurate. screenpipe / PokeClaw / DearVa all converged
 *  on the same insight in the local-LLM space.
 *
 *  This module is the v1 primitive — minimum useful surface:
 *    - readActiveWindow()       — app name + window title + visible top-level controls
 *
 *  Implementation uses osascript (already in our shell allowlist for Mail/Calendar)
 *  rather than a Swift/ObjC AX bridge. AppleScript's System Events dictionary
 *  is shallower than the raw AX API but covers the common case without adding
 *  a Swift dependency to the install.
 *
 *  Permissions: the kiosk needs Accessibility permission granted in System
 *  Preferences once. The setup-wizard prompts; this module just degrades to
 *  "no permission" if it isn't granted yet. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/* AppleScript that returns "appName | windowTitle | child1Role:child1Name | ..." for
 * the frontmost app. Limited to the first 12 immediate children of the front window
 * to keep the response fast and focused on the high-signal controls. */
const SCRIPT = `
tell application "System Events"
  set out to ""
  try
    set frontApp to first application process whose frontmost is true
    set appName to name of frontApp
    set out to appName & "|"
    try
      set winTitle to name of front window of frontApp
      set out to out & winTitle
    end try
    set out to out & "|"
    try
      set kids to every UI element of front window of frontApp
      set i to 0
      repeat with k in kids
        if i is greater than 11 then exit repeat
        try
          set out to out & "; " & (role of k) & ":" & (name of k)
        end try
        set i to i + 1
      end repeat
    end try
  on error errMsg
    set out to "|||error:" & errMsg
  end try
  return out
end tell
`;

/**
 * Read the foreground app's active window — name, title, top-level UI elements.
 *
 * @returns {Promise<{ok: boolean, app?: string, title?: string, children?: Array<{role,name}>, error?: string}>}
 */
export async function readActiveWindow() {
  try {
    const { stdout } = await execFileP("osascript", ["-e", SCRIPT], {
      timeout: 3000,
      maxBuffer: 1 * 1024 * 1024,
    });
    const raw = stdout.trim();
    if (!raw) return { ok: false, error: "no response from System Events" };

    const parts = raw.split("|", 3);
    const app = parts[0] || "";
    const title = parts[1] || "";
    const childrenRaw = parts[2] || "";
    /* The childrenRaw chunk is "; role:name; role:name; ..." — split + filter. */
    const children = childrenRaw.split(";")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const m = s.match(/^(\w+(?:\s\w+)?):(.*)$/);
        if (!m) return { role: "?", name: s };
        return { role: m[1], name: m[2] || "" };
      });

    /* Detect the AppleScript "error:" sentinel that the script returns when it
     * can't access System Events (typically permissions missing). */
    if (childrenRaw.startsWith("error:")) {
      return { ok: false, error: childrenRaw.slice(6) || "accessibility permission missing" };
    }
    return { ok: true, app, title, children };
  } catch (e) {
    /* osascript may exit non-zero if Accessibility permission isn't granted;
     * surface a friendly message rather than the raw stderr. */
    const stderr = String(e.stderr || e.message || "");
    if (stderr.includes("not allowed assistive access") || stderr.includes("1002") || stderr.includes("-25211")) {
      return { ok: false, error: "Accessibility permission required — grant via System Settings → Privacy & Security → Accessibility." };
    }
    return { ok: false, error: stderr.slice(0, 200) || "osascript failed" };
  }
}
