---
layout: ../layouts/Layout.astro
title: Plugin authoring
active: /plugins
---

# Authoring a Jarvis plugin

Drop a directory into `bridge/plugins/<name>/` with a manifest and a handler. The bridge picks it up at boot, hot-reloads on file edits, and registers your tools alongside the built-in 60-tool catalogue. Plugin tools are auto-exposed via the MCP server too — Claude Desktop / Cursor / Continue see them automatically.

## File layout

```
bridge/plugins/my-plugin/
├── manifest.json     # tool schemas + handler path + env requirements
├── handler.mjs       # default async function (toolName, args, ctx) => result
└── README.md         # optional — what your plugin does, how to use it
```

## Manifest

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "One-line summary of what this plugin does.",
  "tools": [
    {
      "name": "my_tool",
      "description": "What the LLM should know about when to call this. Be specific — this is what the embedding tool-router matches against.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Required input." },
          "limit": { "type": "integer", "description": "Optional max results." }
        },
        "required": ["query"]
      }
    }
  ],
  "env": ["MY_API_KEY"],
  "handler": "./handler.mjs",
  "confirmation": {
    "my_tool": "About to call my_tool with query \"{query}\". Confirm?"
  }
}
```

### Field reference

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Alphanumeric + hyphen, 2-41 chars. Must match the directory name. |
| `version` | recommended | Semver string. Surfaced in `/health/plugins`. |
| `description` | yes | One-line plugin summary. |
| `tools` | yes | Array of `{ name, description, parameters }`. The shape matches the OpenAI function-calling schema. |
| `env` | optional | Array of env var names that MUST be set (in `.env`) for the plugin to load. Plugin is skipped at boot if any are missing — the bridge logs a hint. |
| `handler` | yes | Path to the handler module, relative to the plugin directory. |
| `confirmation` | optional | Map of `toolName` → template string. When present, the operator must confirm before the tool runs. Placeholders `{key}` are substituted from the args at runtime. Supports dotted paths (`{user.email}`). |

### Tool naming rules

- `name` must be lowercase alphanumeric + underscore: `my_tool`, `fetch_weather`, `send_to_slack`.
- It must NOT collide with any built-in tool name. Check `/health` `toolCount` before vs after — if your plugin's tool clashes, the most-recently-registered wins, but the surprise is yours.
- Pick descriptive names. The embedding tool-router uses `name + description` as the search corpus when matching the operator's voice query to a tool.

## Handler

```js
// bridge/plugins/my-plugin/handler.mjs
export default async function handle(toolName, args, ctx) {
  if (toolName === "my_tool") {
    const r = await fetch(`https://api.example.com/?q=${encodeURIComponent(args.query)}`, {
      headers: { Authorization: `Bearer ${process.env.MY_API_KEY}` },
    });
    if (!r.ok) return { error: `upstream ${r.status}` };
    const data = await r.json();
    /* The LLM reads the returned object and uses it to compose a reply.
     * Include a `summary` field if you want a TTS-friendly plain-English
     * line the assistant can read aloud verbatim. */
    return {
      ok: true,
      results: data.items.slice(0, args.limit || 10),
      summary: `Found ${data.items.length} matches for "${args.query}".`,
    };
  }
  return { error: `unknown tool: ${toolName}` };
}
```

The handler module's default export must be an async function with the signature `(toolName, args, ctx) => result`.

### The `ctx` object

Plugins receive a context object with safe primitives:

| `ctx.*` | Use for |
|---|---|
| `ctx.log(...args)` | Console logging that prefixes `[plugin]` for clarity. |
| `ctx.broadcastToClients({ type, data })` | Push a WebSocket event to the HUD (e.g. progress updates, notifications). |
| `ctx.memory` | The `bridge/memory.mjs` module — `recall`, `saveFact`, `searchFacts`, etc. Plugins can persist facts across sessions. |
| `ctx.executeTool(name, args)` | Invoke any other registered tool — built-in or plugin. Confirmation + audit gates apply transparently. |

What you DON'T get: a sandboxed `fs` / `http` / `child_process`. Plugins run in the same Node.js process as the bridge. Use Node's standard APIs directly when needed; trust model is "operator owns the filesystem, plugins they drop in are trusted."

## Hot reload

The bridge watches `bridge/plugins/` recursively. Any file change in a plugin directory triggers a debounced (500ms) reload:

1. The plugin's existing tools are unregistered from the host's TOOLS array.
2. The manifest is re-parsed and re-validated.
3. The handler module is dynamic-imported with a cache-bust (`?t=<timestamp>`) so your edits actually run.
4. Tools re-register; the HUD receives a `plugins.reloaded` WebSocket event.

If you delete a plugin's directory while the bridge is running, its tools are unregistered cleanly — no restart needed.

## Confirmation gates

If a tool is destructive (sends a message, makes a purchase, deletes data), declare a confirmation template in the manifest:

```json
"confirmation": {
  "send_message": "About to send \"{text}\" to {recipient}. Proceed?"
}
```

The bridge will refuse to run the tool until the LLM passes `confirmed: true` in the args. The operator sees the rendered template (with `{text}` and `{recipient}` substituted from the actual args) and confirms by voice. This is the same gate the built-in destructive tools use (`draft_email`, `request_purchase`, etc.).

Templates are pure string substitution — no code eval. Use `{a.b.c}` for nested args (`args.user.email` becomes `{user.email}`).

## Required env vars

Plugins that need API keys declare them in `manifest.json`:

```json
"env": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]
```

If any listed var is missing from `.env`, the plugin is **skipped** at boot with a log line:

```
[plugin] my-plugin: skipping — missing env vars: STRIPE_SECRET_KEY (add to .env then reload)
```

Add the keys via the settings panel's API keys section (bridge writes to `.env`), then touch the manifest to trigger a reload.

## The "ask Jarvis to write it" workflow

The settings panel hints: *"Ask Jarvis to wire this key into a tool."* That promise is real — the operator can voice-instruct:

> "Jarvis, write me a plugin called weather-uk that uses MET_OFFICE_API_KEY to fetch the forecast for a UK postcode."

The code agent (`bridge/code-agent.mjs`) scaffolds a manifest + handler stub from the request, drops them into `bridge/plugins/weather-uk/`, and the watcher auto-loads the plugin. Operator gets a reviewable scaffold; iteration is voice-driven.

## Verification

Once your plugin is in place:

```bash
# Confirm the plugin loaded
curl http://localhost:8766/health/plugins | jq

# Confirm tool count went up
curl http://localhost:8766/health | jq '.toolCount'

# Drive a voice command — say "Jarvis, run my-tool with query foo"
# The HUD shows the tool dispatching; the audit log records the call.
```

If something goes wrong, the bridge log (`/tmp/jarvis-bridge.log`) tells you why:
- `[plugin] my-plugin: handler import failed: ...` — syntax error in your handler module
- `[plugin] my-plugin: tool name "X" is invalid` — manifest field doesn't match the regex
- `[plugin] my-plugin: skipping — missing env vars: ...` — env var not set

## Reference plugin

`bridge/plugins/example-quote/` ships with the project — a 50-line plugin that returns a random programming quote. Use it as a template:

```bash
cp -r bridge/plugins/example-quote bridge/plugins/my-plugin
# Edit manifest.json + handler.mjs
# The watcher auto-loads on save
```

## What plugins can't do (yet)

- **Bundled npm dependencies** — plugins use whatever's in the bridge's `node_modules`. Add a `package.json` in your plugin dir if you really need a dep, but install it manually for now (`cd bridge/plugins/my-plugin && npm install`). Plugin marketplace + auto-install is Phase 5 work.
- **Per-plugin sandboxing** — single-operator-kiosk trust model. Don't load plugins from untrusted authors.
- **Cross-plugin state** — no shared in-memory bus. Use `ctx.memory` (SQLite) to persist or `ctx.broadcastToClients` to message via WebSocket.
- **Frontend extensions** — plugins extend the bridge only. UI/HUD changes aren't part of the plugin model. (Roadmap: Phase 5 plugin marketplace will support this.)
