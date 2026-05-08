/** storage.js - Profile-namespaced localStorage helper.
 *
 *  All persisted browser-side state lives under `jarvis.<profile>.<name>`. This
 *  module is the only place that knows the key shape. Consumers call get / set /
 *  remove with bare logical names.
 *
 *  Why a module: voice.js owned this as an IIFE while hud.js read `localStorage`
 *  directly with hand-typed namespaced keys. Splitting it out means there's exactly
 *  one place that knows the prefix scheme — when multi-operator profiles ship in
 *  P2.1, swapping the active profile id flips every key for every consumer with no
 *  per-file migration needed.
 *
 *  One-shot legacy migration runs at module load: any pre-namespacing keys
 *  (`jarvis.foo`) get moved into the default profile (`jarvis.default.foo`) and
 *  the legacy entries are deleted. Idempotent — safe to run on every page load. */

const PREFIX = "jarvis";
let activeProfile = "default";

function profileKey(name) { return `${PREFIX}.${activeProfile}.${name}`; }

/* Why: every key the kiosk has historically written. The legacy migration only
 * touches these — random unknown keys aren't moved (they belong to other apps or
 * a future feature we don't yet know about). */
const KNOWN_LEGACY_KEYS = [
  "voice", "preferredAudioDeviceId", "preferredAudioDeviceLabel",
  "setupDone", "agency", "tier", "cameraMode",
];

(function migrateLegacyKeys() {
  let migrated = 0, cleaned = 0;
  for (const k of KNOWN_LEGACY_KEYS) {
    const legacy = `${PREFIX}.${k}`;
    const target = `${PREFIX}.default.${k}`;
    const v = localStorage.getItem(legacy);
    if (v == null) continue;
    /* Why: target wins if both exist (newer namespacing is canonical), but the
     * legacy dust gets cleaned up either way so it doesn't drift back into use. */
    if (localStorage.getItem(target) == null) {
      localStorage.setItem(target, v);
      migrated++;
    } else {
      cleaned++;
    }
    localStorage.removeItem(legacy);
  }
  if (migrated || cleaned) console.log(`[storage] migrated ${migrated}, cleaned ${cleaned} legacy keys`);
})();

/** Read a key, falling back to a default if unset. */
export function get(name, fallback = null) {
  const v = localStorage.getItem(profileKey(name));
  return v == null ? fallback : v;
}

/** Write a key. Value is stored as-is (caller stringifies if needed). */
export function set(name, value) {
  localStorage.setItem(profileKey(name), value);
}

/** Remove a key. */
export function remove(name) {
  localStorage.removeItem(profileKey(name));
}

/** Switch the active profile. P2.1 will wire this to a profile picker; today only
 *  "default" is used. Triggers no migration — caller is expected to swap consumers
 *  before/after as appropriate. */
export function setProfile(id) {
  activeProfile = String(id || "default");
}

/** Current active profile id. */
export function getProfile() { return activeProfile; }
