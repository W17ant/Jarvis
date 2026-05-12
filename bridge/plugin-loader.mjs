/** plugin-loader.mjs — Hot-reloadable plugin runtime for Jarvis tools.
 *
 *  A plugin is a directory under bridge/plugins/<name>/ containing:
 *    - manifest.json — { name, version, description, tools: [...], env: [...],
 *                         handler: "./handler.mjs", confirmation: {...} }
 *    - handler.mjs   — exports `default async (toolName, args, ctx) => result`
 *
 *  At boot the loader scans bridge/plugins/, validates each manifest, dynamic-
 *  imports each handler, and registers the declared tools into the host's
 *  TOOLS array (and any confirmation templates into NEEDS_CONFIRMATION).
 *  An fs.watch on the plugins directory picks up file edits → debounce 500ms
 *  → reload that plugin → broadcast "plugins.reloaded" so the HUD knows.
 *
 *  Confirmation gates use a SAFE template-string pattern (not code eval).
 *  A plugin declares confirmation: { tool_name: "About to {action}: are you sure?" }
 *  Placeholders in {curly} are substituted from the args object at gate time.
 *  This keeps the bridge from running arbitrary plugin-author code at the
 *  confirmation-summary stage (the only place the host would have called
 *  plugin code synchronously outside the dispatch path).
 *
 *  Security model:
 *    - Manifest schema is validated; malformed plugins are skipped with a
 *      clear log line, not silently ignored.
 *    - Handler signature is checked (must be an async function).
 *    - Required env vars are checked before load — plugin is skipped (with a
 *      hint logged) if a required key is missing.
 *    - Plugins receive a ctx object exposing host primitives (memory,
 *      executeTool, broadcastToClients, log) but NOT raw fs / child_process
 *      / http. They stay inside the same audit + confirmation gates as
 *      built-in tools.
 *    - Single-operator-kiosk trust model: the operator owns the filesystem;
 *      plugins they drop in are assumed trusted. Plugin signing / sandboxing
 *      is a Phase-5 concern, not the MVP.
 */

import { readFileSync, existsSync } from "node:fs";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(HERE, "plugins");

/* In-memory plugin registry. Keyed by plugin name → { manifest, handler,
 * tools (subset of TOOLS owned by this plugin), confirmations (subset of
 * NEEDS_CONFIRMATION owned by this plugin) }. */
const _plugins = new Map();

/* Wired at init() time so the loader can mutate the host's TOOLS array
 * + NEEDS_CONFIRMATION map + tool dispatch in place. The host calls init()
 * during boot with refs to these collections. */
let _hostTools = null;          /* the host's TOOLS array (mutated in place) */
let _hostConfirmations = null;  /* the host's NEEDS_CONFIRMATION object (mutated in place) */
let _hostCtx = null;            /* utilities passed to plugin handlers */
let _broadcaster = null;        /* WS broadcaster for plugins.reloaded events */

/** Initialise the loader with refs to the host arrays it will mutate. */
export function init({ tools, confirmations, ctx, broadcaster }) {
  _hostTools = tools;
  _hostConfirmations = confirmations;
  _hostCtx = ctx;
  _broadcaster = broadcaster;
}

/** Render a confirmation template with values from the args object.
 *  Placeholders are {key}; missing keys render as the literal placeholder
 *  text so the operator can see the gap rather than a silent empty string.
 *  No code eval — pure string substitution. */
function _renderConfirmTemplate(template, args) {
  return String(template).replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key) => {
    /* Support dotted paths so plugins can read nested args (e.g. {target.email}). */
    const parts = key.split(".");
    let v = args || {};
    for (const p of parts) {
      if (v == null || typeof v !== "object") return match;
      v = v[p];
    }
    if (v == null || v === "") return match;
    return String(v);
  });
}

/** Parse + validate a manifest. Returns the parsed object on success, or
 *  null with a logged reason on failure. Validation is conservative —
 *  better to skip a buggy plugin than crash the bridge. */
function _parseManifest(manifestPath) {
  let raw;
  try { raw = readFileSync(manifestPath, "utf8"); }
  catch (e) { console.warn(`[plugin] could not read ${manifestPath}: ${e.message}`); return null; }
  let mf;
  try { mf = JSON.parse(raw); }
  catch (e) { console.warn(`[plugin] ${manifestPath} parse failed: ${e.message}`); return null; }
  if (!mf || typeof mf !== "object") { console.warn(`[plugin] ${manifestPath}: not an object`); return null; }
  if (typeof mf.name !== "string" || !/^[a-z][a-z0-9-]{1,40}$/i.test(mf.name)) {
    console.warn(`[plugin] ${manifestPath}: invalid name (must be alphanumeric + hyphen, 2-41 chars)`);
    return null;
  }
  if (!Array.isArray(mf.tools) || !mf.tools.length) {
    console.warn(`[plugin] ${mf.name}: tools array missing or empty`);
    return null;
  }
  for (const t of mf.tools) {
    if (!t.name || !/^[a-z][a-z0-9_]+$/i.test(t.name)) {
      console.warn(`[plugin] ${mf.name}: tool name "${t.name}" is invalid (must be alphanumeric + underscore)`);
      return null;
    }
    if (!t.description) {
      console.warn(`[plugin] ${mf.name}: tool "${t.name}" missing description`);
      return null;
    }
    if (!t.parameters || typeof t.parameters !== "object") {
      console.warn(`[plugin] ${mf.name}: tool "${t.name}" missing parameters schema`);
      return null;
    }
  }
  if (typeof mf.handler !== "string") {
    console.warn(`[plugin] ${mf.name}: handler path missing`);
    return null;
  }
  return mf;
}

/** Check that all required env vars listed in the manifest are present.
 *  Returns the array of missing var names (empty = OK). */
function _missingEnv(mf) {
  if (!Array.isArray(mf.env)) return [];
  return mf.env.filter((k) => typeof k === "string" && !process.env[k]);
}

/** Load a single plugin from its directory. Returns true on success, false
 *  on any failure (logged). Idempotent — calling twice on the same plugin
 *  unloads first then re-loads. */
async function _loadOne(pluginDir) {
  const manifestPath = path.join(pluginDir, "manifest.json");
  if (!existsSync(manifestPath)) return false;
  const mf = _parseManifest(manifestPath);
  if (!mf) return false;

  /* Unload any previous instance of this plugin before re-registering. */
  if (_plugins.has(mf.name)) _unloadOne(mf.name);

  const missing = _missingEnv(mf);
  if (missing.length) {
    console.warn(`[plugin] ${mf.name}: skipping — missing env vars: ${missing.join(", ")} (add to .env then reload)`);
    return false;
  }

  /* Resolve handler path relative to the plugin dir, then dynamic-import.
   * Cache-bust via ?t= so file edits actually re-run instead of returning
   * the previously-loaded module from Node's import cache. */
  const handlerPath = path.resolve(pluginDir, mf.handler);
  if (!existsSync(handlerPath)) {
    console.warn(`[plugin] ${mf.name}: handler ${mf.handler} not found`);
    return false;
  }
  let mod;
  try {
    const cacheBust = `?t=${Date.now()}`;
    mod = await import(`file://${handlerPath}${cacheBust}`);
  } catch (e) {
    console.warn(`[plugin] ${mf.name}: handler import failed: ${e.message}`);
    return false;
  }
  const handler = mod.default || mod.handle || mod.handler;
  if (typeof handler !== "function") {
    console.warn(`[plugin] ${mf.name}: handler module must export a default async function`);
    return false;
  }

  /* Register tools into the host's TOOLS array. Each tool gets the standard
   * { type: "function", function: { name, description, parameters } } shape
   * the rest of the bridge expects. */
  const toolEntries = mf.tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
  for (const entry of toolEntries) _hostTools.push(entry);

  /* Register confirmation templates as summariser closures. The closure
   * does pure string interpolation — no eval, no Function constructor. */
  const registeredConfirmations = [];
  if (mf.confirmation && typeof mf.confirmation === "object") {
    for (const [toolName, template] of Object.entries(mf.confirmation)) {
      if (typeof template !== "string") continue;
      _hostConfirmations[toolName] = (args) => _renderConfirmTemplate(template, args);
      registeredConfirmations.push(toolName);
    }
  }

  _plugins.set(mf.name, {
    manifest: mf,
    handler,
    pluginDir,
    toolNames: toolEntries.map((t) => t.function.name),
    confirmations: registeredConfirmations,
  });

  console.log(`[plugin] loaded ${mf.name} v${mf.version || "?"} (${toolEntries.length} tool${toolEntries.length === 1 ? "" : "s"})`);
  return true;
}

/** Remove a plugin's tools + confirmations from the host arrays. */
function _unloadOne(name) {
  const p = _plugins.get(name);
  if (!p) return;
  /* Filter the host's TOOLS array in place — splice every entry whose name
   * matches one of this plugin's tools. */
  for (let i = _hostTools.length - 1; i >= 0; i--) {
    if (p.toolNames.includes(_hostTools[i].function?.name)) {
      _hostTools.splice(i, 1);
    }
  }
  for (const t of p.confirmations) delete _hostConfirmations[t];
  _plugins.delete(name);
  console.log(`[plugin] unloaded ${name}`);
}

/** Scan + load every plugin in bridge/plugins/. Idempotent. */
export async function loadAll() {
  if (!existsSync(PLUGINS_DIR)) {
    console.log(`[plugin] no plugins/ directory — skipping`);
    return { loaded: 0 };
  }
  let dirs;
  try {
    dirs = (await fs.readdir(PLUGINS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(PLUGINS_DIR, d.name));
  } catch (e) {
    console.warn(`[plugin] readdir failed: ${e.message}`);
    return { loaded: 0 };
  }
  let loaded = 0;
  for (const dir of dirs) {
    if (await _loadOne(dir)) loaded++;
  }
  console.log(`[plugin] loaded ${loaded}/${dirs.length} plugin${dirs.length === 1 ? "" : "s"}`);
  return { loaded, total: dirs.length };
}

/** Hot-reload watcher. Debounces 500ms per directory so multi-file saves
 *  (manifest + handler at once) only trigger one reload. */
const _watchDebounce = new Map();
export function startWatcher() {
  if (!existsSync(PLUGINS_DIR)) return;
  watch(PLUGINS_DIR, { recursive: true }, (event, filename) => {
    if (!filename) return;
    /* Resolve the plugin directory the change happened inside. */
    const parts = filename.split(path.sep);
    const pluginName = parts[0];
    if (!pluginName) return;
    const pluginDir = path.join(PLUGINS_DIR, pluginName);
    /* Debounce per-plugin so manifest.json + handler.mjs saves don't double-load. */
    if (_watchDebounce.has(pluginName)) clearTimeout(_watchDebounce.get(pluginName));
    _watchDebounce.set(pluginName, setTimeout(async () => {
      _watchDebounce.delete(pluginName);
      if (!existsSync(pluginDir)) {
        /* Directory was removed — unload its tools. */
        _unloadOne(pluginName);
        if (_broadcaster) _broadcaster({ type: "plugins.reloaded", data: { name: pluginName, action: "removed" } });
        return;
      }
      const ok = await _loadOne(pluginDir);
      if (_broadcaster) _broadcaster({ type: "plugins.reloaded", data: { name: pluginName, action: ok ? "reloaded" : "failed" } });
    }, 500));
  });
  console.log(`[plugin] watching ${PLUGINS_DIR}`);
}

/** Returns true if a tool name is owned by a plugin (rather than the
 *  built-in switch). Used by the host's executeTool dispatcher to route
 *  to the plugin's handler instead of the default-case "unknown tool"
 *  fallthrough. */
export function ownsTool(name) {
  for (const p of _plugins.values()) {
    if (p.toolNames.includes(name)) return true;
  }
  return false;
}

/** Dispatch a tool call to its plugin handler. Caller (executeTool) has
 *  already passed the confirmation gate + audit logging path; the handler
 *  just runs and returns its result. Errors propagate. */
export async function dispatch(name, args) {
  for (const p of _plugins.values()) {
    if (p.toolNames.includes(name)) {
      return await p.handler(name, args || {}, _hostCtx);
    }
  }
  throw new Error(`plugin tool not found: ${name}`);
}

/** Read-only view of the registry — used by /health/plugins endpoint
 *  and any diagnostic display. Does NOT include handler functions or
 *  filesystem paths beyond the directory. */
export function status() {
  const out = [];
  for (const [name, p] of _plugins.entries()) {
    out.push({
      name,
      version: p.manifest.version || null,
      description: p.manifest.description || "",
      tools: p.toolNames,
      env: p.manifest.env || [],
    });
  }
  return out;
}
