/** demo.js - Demo / clean mode toggle.
 *
 *  Cmd+D (or Ctrl+D on Linux/Win) flips a body.is-demo class. CSS rules in
 *  styles.css drive the actual hiding — this module only owns the toggle + the
 *  persistence so a client visit can survive a reload.
 *
 *  Hidden in demo mode:
 *    - notification timestamps + drawer (operator can still receive them, just
 *      not see the time-ago labels)
 *    - history drawer (H key becomes a no-op)
 *    - rec indicator (the recording demo dot)
 *    - system-pod numeric readouts (CPU/GPU/RAM percentages — arcs stay)
 *    - stat-row + telemetry-row text (NET / DOWN / UP / LAT readouts)
 *    - debug widgets (if any)
 *
 *  Visible in demo mode (intentionally — the cinematic surface):
 *    - speedometer + needle + voice state
 *    - weather panel with icons
 *    - calendar strip + brand wordmark
 *    - comms panel
 *    - launch panel
 *    - waveform / task strip in the bottom
 *    - wake button + TUNE plate */

import * as Storage from "./storage.js";

const STORAGE_KEY = "demoMode";

let isOn = false;

/** Apply the current state to the body class + persist. */
function apply() {
  document.body.classList.toggle("is-demo", isOn);
  Storage.set(STORAGE_KEY, isOn ? "true" : "false");
}

/** Toggle on/off — bound to Cmd+D / Ctrl+D. */
export function toggle() {
  isOn = !isOn;
  apply();
  console.log(`[demo] ${isOn ? "ON" : "OFF"}`);
}

export function setDemoMode(on) {
  isOn = !!on;
  apply();
}

export function isDemoMode() { return isOn; }

/** Read persisted value at boot + bind keyboard. */
export function init() {
  isOn = Storage.get(STORAGE_KEY) === "true";
  apply();

  document.addEventListener("keydown", (e) => {
    /* Cmd+D on macOS, Ctrl+D on Linux/Windows. Both modifier keys cover the kiosk
     * deployment targets. Skip when typing into an input so the operator can still
     * use Cmd+D as expected in form fields. */
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key !== "d" && e.key !== "D") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    toggle();
  });
}
