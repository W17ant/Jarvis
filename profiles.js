/** profiles.js - Multi-operator profile registry.
 *
 *  Why: the kiosk gets used by lead photographer, editor, and MD. Each wants
 *  their own voice, colour preferences, tier, and (eventually) audit-log
 *  attribution. Storage already namespaces every key under
 *  flatout.<profile>.<key> — this module manages the registry of profile ids
 *  and switches the active one, prompting a reload so every consumer rereads
 *  the new namespace.
 *
 *  Registry shape (stored top-level at flatout.profiles, NOT namespaced):
 *    [{ id: "default", name: "Default", createdAt }, { id: "marcus", name: "Marcus", ... }]
 *
 *  Switching profiles:
 *    1. Storage.setProfile(newId) — flips the namespace
 *    2. localStorage.setItem("flatout.activeProfile", newId) — persists the choice
 *    3. location.reload() — every consumer rereads through the new prefix
 *
 *  Creating profiles:
 *    new profile = clean slate (no inherited keys). Operator goes through the
 *    normal settings flow (voice picker, colour swatch, tier) to set theirs up.
 *    No "copy from default" — keeps the model simple. */

import * as Storage from "./storage.js";

const REGISTRY_KEY = "flatout.profiles";        /* top-level — not namespaced */
const ACTIVE_KEY = "flatout.activeProfile";     /* top-level — drives Storage prefix */

const DEFAULT_PROFILE = { id: "default", name: "Default", createdAt: 0 };

/** Read the registry, falling back to default. Returns array. */
export function list() {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return [DEFAULT_PROFILE];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return [DEFAULT_PROFILE];
    /* Always guarantee a "default" entry exists — guards against accidental
     * registry corruption deleting the only profile. */
    if (!arr.find(p => p.id === "default")) arr.unshift(DEFAULT_PROFILE);
    return arr;
  } catch {
    return [DEFAULT_PROFILE];
  }
}

/** Persist the registry. */
function save(profiles) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(profiles));
}

/** Active profile id — sticky across sessions. */
export function activeId() {
  return localStorage.getItem(ACTIVE_KEY) || "default";
}

/** Active profile object. */
export function active() {
  const id = activeId();
  return list().find(p => p.id === id) || DEFAULT_PROFILE;
}

/**
 * Create a new profile. id is auto-derived from the name unless provided. Returns
 * the new profile (or null on duplicate id).
 */
export function create({ name, id }) {
  const cleanName = String(name || "").trim() || "Operator";
  const cleanId = String(id || cleanName).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `op-${Date.now().toString(36)}`;

  const profiles = list();
  if (profiles.some(p => p.id === cleanId)) return null;
  const profile = { id: cleanId, name: cleanName, createdAt: Date.now() };
  profiles.push(profile);
  save(profiles);
  return profile;
}

/** Delete a profile + every namespaced key under it. Default cannot be deleted. */
export function remove(id) {
  if (id === "default") return false;
  const profiles = list().filter(p => p.id !== id);
  save(profiles);
  /* Sweep the operator's namespaced keys. */
  const prefix = `flatout.${id}.`;
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(prefix)) keysToRemove.push(k);
  }
  for (const k of keysToRemove) localStorage.removeItem(k);
  /* If we deleted the active profile, fall back to default. */
  if (activeId() === id) localStorage.setItem(ACTIVE_KEY, "default");
  return true;
}

/** Sync the active operator with the bridge so audit log entries get attributed
 *  correctly. Fire-and-forget — bridge timeout / unreachability is non-fatal. */
function syncOperatorWithBridge(id) {
  fetch("http://localhost:8766/operator", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  }).catch(() => { /* bridge offline — audit will fall back to "default" */ });
}

/** Switch active profile. Reloads the page so every module reads the new namespace. */
export function switchTo(id) {
  if (id === activeId()) return;     /* no-op */
  const profile = list().find(p => p.id === id);
  if (!profile) return;
  localStorage.setItem(ACTIVE_KEY, id);
  Storage.setProfile(id);
  syncOperatorWithBridge(id);
  /* Reload so storage.js + every consumer (voice, hud, history, demo) rereads
   * under the new namespace. Cleanest contract — no live re-wiring required. */
  location.reload();
}

/** Sync the persisted active project with the bridge so the LLM's system prompt
 *  reflects it from the first ask. Runs after profile init (Storage namespace
 *  must be active before we read activeProject). */
function syncActiveProjectWithBridge() {
  const projectId = Storage.get("activeProject", "");
  /* Skip if empty — bridge defaults to no scope, no need to post. */
  if (!projectId) return;
  fetch("http://localhost:8766/project/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: projectId }),
  }).catch(() => { /* bridge offline */ });
}

/** Boot path — apply the persisted active profile to Storage so every other
 *  module sees the right namespace from their first call. Called by the
 *  bootstrap script BEFORE any other module does Storage.get/set. */
export function init() {
  const id = activeId();
  Storage.setProfile(id);
  /* Best-effort sync to bridge so audit log + project context start working immediately. */
  syncOperatorWithBridge(id);
  syncActiveProjectWithBridge();
}
