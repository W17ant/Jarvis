# Changelog

Running record of features shipped to the Jarvis HUD kiosk. Newest first.

The project follows [Semantic Versioning](https://semver.org/) loosely — a
0.x bump means breaking config / on-disk schema; minor bumps add features
without forcing operator-side changes.

## [Unreleased]

_Working block. New entries land here; consolidated into the next release header on cut._

### Sprint 12 — workspace persona swap (single-window, deep)

The dual-window experiment (Jarvis main + `?workspace=friday` second tab side-by-side) ran into an unfixable Chrome-on-macOS networking quirk: parallel localhost WS upgrades + concurrent fetches exhausted Chrome's per-origin connection pool, causing /healthz timeouts that flickered the "WAITING FOR BRIDGE" splash. Worked perfectly in Safari. Rather than ship Safari-only, we pivoted to **single-window with deep persona swap on workspace switch**. Switching from Jarvis to Friday in the workspace switcher now:

- **Re-themes the entire HUD chrome** — accent colour, wordmark, agent label, faceted-crystal centerpiece (was concentric arc-reactor).
- **Swaps the wake phrase live** — "TAP / SAY HEY JARVIS" becomes "TAP / SAY HEY FRIDAY". Per-workspace `wake_phrase` column added to the workspaces table; `voice.js` re-binds the wake-parse module on `workspace.switched`.
- **Swaps the voice persona** — `bm_daniel` (Daniel) for Jarvis, `bf_isabella` (Isabella) for Friday. Continues working through the existing per-workspace `voice` field.
- **Swaps the boot greeting tone** — Jarvis still says "All systems online, N tools at the ready, sir"; Friday says "Evening, Antony. Inbox is in front of me — want to triage what matters?". Per-persona greeting templates in `_composeGreeting()`.
- **Dispatches every voice query to the active workspace's scope** — handbook, tool allowlist, voice, working_root all per-workspace via the existing AsyncLocalStorage per-call dispatch (Sprint 7).

The dual-window code path (URL pin via `?workspace=<slug>`) survives — pinned windows still apply persona styling at boot — but is no longer the recommended demo pattern.

#### Bridge perf hardening (the real fix that came out of the dual-window debug)

The dual-window debug session uncovered real bridge issues that affect single-window too:

- **HUD WebSocket consolidated** (`hud.js`). Was opening its OWN WS to receive live stats, separate from `bridge-client.js`'s WS used for the streaming protocol. Now subscribes to `bridge-client`'s pubsub. **One WS per tab instead of two** — halves the load on Chrome's localhost networking.
- **`/healthz` cache** (`bridge/server.mjs`). 1-second TTL keeps the response body memoised so repeated polls (HUD's bridge-status checker + the latency overlay) skip the parallel fanout to Ollama/Kokoro/Whisper. Bridge log shows `[cache] healthz HIT/MISS`.
- **`/diary` cache + in-flight dedup + pre-warm** (`bridge/server.mjs`). The HAR analysis of a 2-tab Chrome session showed `/diary` taking 8-20s (AppleScript fanout to Calendar + Mail) and piling up in Chrome's 6-slot per-origin connection pool, blocking `/healthz` polls behind it. 18s TTL, in-flight Promise coalesce so concurrent callers share one fanout, and a 500ms-after-boot pre-warm so the cache is hot before the HUD lands. Bridge log shows `[cache] diary HIT/MISS/COALESCE` + `[warmup] /diary cache primed in Xms`.
- **Bridge-status switched to WS-driven liveness** (`bridge-status.js`). Previously polled `/healthz` independently, which raced with WS upgrade timing during dual-tab boot bursts and flickered the splash. Now subscribes to `bridge.online`/`bridge.offline` events from `bridge-client` and pauses the `/healthz` poll while WS is connected. Splash only shows on real WS-down events.
- **HTTP access log** (`bridge/server.mjs`). Every non-noisy request emits `[http] METHOD /path STATUS DURms port=N` with a `SLOW` tag for >1000ms requests. The remote port differentiates per-tab connections so dual-client traffic patterns are visible without DevTools.

#### Friday persona

- **Faceted-crystal reactor** (`index.html`, `styles.css`). Distinct centerpiece for Friday — hex outer frame + 8 alternating crystal facets meeting at a bright pupil, COMMS-01 anchor tag mirroring Jarvis's CORE-01. Persona-driven CSS swap via `body[data-persona="friday"]` that workspace-switcher.js sets on switch. Default state shows the cyan arc-reactor SVG.
- **Particle orb resized + thinned** (`orb.js`). Was 5000 particles on a Fibonacci sphere at z=3 (operator: "fuzzy ball"); now 1200 particles at z=5 with larger per-point size. Reads as orbiting points around a void rather than a dense mass.
- **Per-workspace wake phrase schema** (`bridge/workspaces.mjs`). Idempotent ALTER TABLE adds `wake_phrase TEXT` to the workspaces table. Friday's column defaults to `"hey friday"` for fresh installs (existing installs need a one-shot PATCH).
- **Friday persona handbook** (`config/handbooks/friday.md`). Drafted communications-focused persona — warmer tone, Inbox/Calendar/PR-led, suggests when to switch back to Jarvis. Operator pastes it into the workspace handbook editor (`Cmd+W` → ✎ on the Friday row) or PATCHes via curl.

#### Other fixes

- **Bridge cycling diagnostics** — instrumented `bridge-client.js` and `hud.js` WS lifecycles with timing + close codes. Critical for the future when the same bug recurs on a different machine.
- **`marketing/` + `.planning/` + `graphify-out/` gitignored** — local artefacts no longer eligible to land in commits.

### Sprint 11 — voice latency pass

Tightened the loop from "feels OK" to "feels real-time". Three load-bearing changes plus a new debug surface so future regressions surface immediately.

- **Headline metric switched to `recend_to_audio`** — the perceptual lag from the operator finishing speaking to the first audio chunk leaving the speaker. Was previously implicit in `voice_to_audio` (which includes how long the user spoke); the new mark gives a single number the operator feels. Added `v.llm-first-sentence` perf-mark in `tts-pipeline.js` so we can isolate the LLM-thinking slice from TTS synthesis. Span labels propagated through `bridge/server.mjs`'s `/health/timings` aggregator and `tools/benchmark.mjs`.
- **Streaming-TTS first-audio mark fixed** (`tts.js`). Previously `v.audio-play` only fired in the legacy non-streaming path, so every voice query reported `voice_to_audio: null`. Mark now drops in `drain()` right before `source.start(0)` with a 5s freshness check so stale marks from a prior turn don't leak.
- **Whisper warmup at boot** (`bridge/whisper_server.py`). Background thread fires a 0.5s silent transcribe immediately after the server binds — so the FIRST real operator request doesn't pay model-weights-load cost. Saves ~1-3s on cold-start sessions.
- **Whisper inference knobs**: `condition_on_previous_text=False` (independent turns don't benefit from re-fed prior context, ~5-10% saved per call) and `temperature=[0.0, 0.2]` instead of `[0.0, 0.2, 0.4]` (the third fallback rarely improved transcripts but was the source of hallucinated phrases on quiet audio).
- **Tool-router query embedding cache** (`bridge/tool-router.mjs`). Tiny LRU on normalised query strings — repeated queries (testing, demos, conversation-mode follow-ups) skip the ~150-400ms `nomic-embed-text` roundtrip entirely.
- **HUD latency overlay** (`latency-overlay.js`). Self-mounting debug chip — top-right of the HUD when `?debug=latency` is in the URL or `localStorage["debug.latency"]==="1"`. Polls `/health/timings` every 800ms and renders the most recent turn's per-stage breakdown with a colour-coded total (green <800ms · amber <1.2s · red ≥1.2s). Doubles as demo-video b-roll.
- **CLI report**: `node tools/latency-report.mjs` — pretty-printed p50/p95 per stage from the rolling buffer. For checking baselines into `docs/benchmarks.md` without leaving the terminal.

### Sprint 10 — visual parity + LLM robustness

Two gap-closes after auditing what other voice-AI projects (notably ethanplusai/jarvis) do well that we didn't:

- **Three.js audio-reactive particle orb** as an alternative HUD centerpiece (`orb.js`). 5000 particles distributed on a Fibonacci sphere, vertex-displaced per-frame by the existing voice waveform analyser (low/mid/high frequency bands). State-driven breathing: gentle in idle, magnetised in listening, swirling at thinking, expanded shimmer at speaking. Shader-based rendering on the GPU, throttled to 30fps to share budget with the SVG centerpiece's animations. Three.js loads from CDN on first use — operators on the reactor preset never pay the network round-trip. Closes the visual gap with cloud-first siblings whose particle orb is the canonical demo GIF.
- **Per-workspace accent on the orb**. The orb reads `--accent` from CSS so workspace-pinned windows colour-code automatically — Jarvis cyan, Friday amber, etc. Workspace switch fires `refreshAccent()` so the swap is instant.
- **Centerpiece picker** in Settings (`settingsCenterpiece`). Reactor (default) | Particle orb. Hot-swaps without reload via `window.__hud.setCenterpiece(choice)` — mounts/unmounts the orb on the live `.speedo` container.
- **Action-tag fallback parser** (`bridge/action-tag.mjs`). Defensive parser for `[ACTION:tool_name {...args}]` literal tags that Qwen2.5 occasionally emits instead of clean function-call envelopes. Returns stripped text + parsed calls so the dispatcher can route them through the same executeTool path. Belt-and-braces — never replaces structured tool_calls, just a safety net for the model's creative moments. Cousin pattern to ethanplusai/jarvis's primary action surface; we use it as the secondary.
- **Coverage**: 10 new vitest cases for the action-tag parser (no-tag pass-through, bare tags, JSON args, kv args, multiple tags in one stream, malformed-JSON skip, non-identifier rejection, whitespace collapse). Total now **205 tests / 8 files**.

## [0.3.0] — 2026-05-09 — Workstation depth (Horizon 2 complete)

The release that made the operator-workstation pitch real. Sprints 2-9 in one cut: the kiosk that builds its own tools, switches operating contexts mid-conversation, runs parallel personas across windows, scopes every byte of memory + audit per workspace, exports its scope as a portable bundle, and surfaces the day's priorities through a workspace-aware briefing — all local-first, all white-label, all open MIT.

### TL;DR for the changelog reader

- **Workspaces** went from "label" (v0) to "operating context" (v4). Switching scopes now changes working dir + tool catalogue + creative voice + LLM scope + accent colour + agent label simultaneously. Per-call dispatch via AsyncLocalStorage means two windows running parallel personas (Jarvis + Friday) don't interfere.
- **Smart Inbox** ships as the first proactive-intelligence surface. Mail + Calendar + Reminders aggregate into a unified ranked list; the active workspace's handbook drives the priority logic; voice triage ("brief me") + voice action ("reply to the first one") + clickable HUD panel on the right rail.
- **Plugin system** is fully self-extending. `build_plugin` voice tool scaffolds working plugins that hot-load within 500ms; optional code-agent mode fills in the handler logic.
- **Privacy story is documented.** Self-hosted crash reporter with sanitisation. No analytics SDK. No telemetry server. `docs/privacy.md` audits what does (and crucially doesn't) leave the device.
- **195 vitest tests / 7 files. Typecheck clean. CI green on every push. Bridge boots in <1s.**

### Sprint 9 — Smart Inbox v1: actionable triage

- **Personal.listReminders + Inbox reminders source**. Closes the third inbox source; AppleScript reader returns title / due / notes / list. Smart Inbox aggregator pulls all three sources in parallel.
- **`act_on_inbox_item` voice tool**. Resolves ordinals ("the first one", "second", "third") against the cached briefing, routes to reply / open / snooze / accept / decline / complete. Routes through existing draft_email + open_url + Reminders bridges. Cache invalidates after every action.
- **Inbox panel — clickable rows**. Each row in the HUD inbox is a button — click opens Mail/Calendar/Reminders.app. New `POST /tool-dispatch` endpoint with a non-destructive tool allowlist for HUD-click → bridge dispatch without LLM round-trip.
- **Handbook editor — markdown preview + snippets**. Live preview pane next to the textarea. Snippet dropdown inserts starter blocks (Priorities directive / Vocabulary / Tone / Words to avoid / Reply examples) so operators have a clear path to "I've got nothing" → "I've got a useful handbook".

### Sprint 8 — Smart Inbox: proactive intelligence

The pivot from "voice assistant for tools" to "voice assistant that surfaces what matters before you ask."

- **Inbox aggregator** (`bridge/inbox.mjs`). Pulls from the existing get_mail_summary + get_upcoming_events surfaces, normalises into a unified `{ kind, source, when, who, what, preview, urgency_hints, raw }` shape. 60s TTL cache shared between the HUD panel and the briefing tool. Source-failure isolation — mail throwing doesn't blow up the calendar pull. Reminders source reserved for v1 (Personal.listReminders not yet wired).
- **`smart_inbox_briefing` voice tool** (the demo-video money shot). Aggregates sources → reads active workspace's handbook → asks the LLM to rank top-N priorities with one-line rationales + a closing one-sentence take. Operator says *"Hey Jarvis, brief me"* and gets a workspace-aware triage in ~2s. Phrasings: "what's important", "what should I do first", "what's on my plate", "morning briefing", "what's the day looking like".
- **Workspace-aware priorities**. The active workspace's `handbook` is injected verbatim into the rank prompt with the prefix *"Workspace priority directives — apply strictly when ranking"*. Operators write prose like *"client emails outrank everything", "calendar items in next hour are sacred"* and Friday vs Jarvis vs Photo Agency get genuinely different briefings from the same inbox.
- **HUD inbox panel** (`inbox.js`). Right-rail collapsible card. Polls `/inbox` every 5min, shows top-5 items inline with kind icons + sender + time hint + 2-line subject. Imminent events get a red border accent (`#ff5a3a`) so the eye lands there first. Manual ↻ refresh button forces a fresh pull. Replaces `launch` in the default layout (existing operators with persisted layouts keep what they had).
- **Coverage** (`test/inbox.test.mjs`). 11 vitest cases: empty state, normalisation field-coverage, imminent-event detection, cache TTL, force-bypass, invalidate, source-failure isolation, non-ok source handling, sort priority, truncation. Total now 195 tests / 7 files.
- **Docs** (`docs/smart-inbox.md`). Vocabulary, voice flow, HUD panel behaviour, workspace handbook examples per persona (consulting / personal / photo agency), what's NOT in v1, how to add a new source.

### Sprint 7 — Workspaces v4: parallel personas across windows

The conceptual leap: **a second window isn't a second view, it's a second persona.** Operator runs `localhost:8765/?workspace=friday&mode=reactor` in a second Chrome window — that window pins itself to the Friday workspace, applies Friday's accent colour to the HUD chrome, shows "FRIDAY" in the wordmark, and (most importantly) every voice command from that window dispatches to the bridge with Friday's scope. Same brain, parallel personas.

- **HUD handbook editor** (`workspace-switcher.js`, `index.html`, `bridge/server.mjs PATCH /workspaces/<slug>`). Inline modal textarea editor for workspace handbooks. ✎ button on each workspace switcher row opens the editor pre-populated with current handbook. Save → PATCH bridge endpoint → DB update → broadcast `workspace.updated` → next LLM call uses the new handbook (system prompt rebuilds per call). Operator can now shape scope rules without leaving the kiosk.
- **HUD view modes** (`?mode=reactor`, `?mode=ambient`). URL params strip chrome for secondary displays. `reactor` keeps the central reactor + waveform + state chip + workspace chip (so the operator knows which scope a window is in). `ambient` drops everything else — reactor only, full-screen, hidden cursor, for wall-mounted at-rest displays. Same WS connection, same brain — just a different visual surface. CSS-only via `html[data-mode="reactor|ambient"]` descendant selectors.
- **Workspace persona fields** (`bridge/workspaces.mjs`). `accent_color` + `agent_label` columns added via idempotent ALTER TABLE. accent_color validated as `#rrggbb` hex; HUD applies it to `--accent` + derives `--accent-deep`/`--accent-glow`/`--accent-tint` via the same shading function the brand bootstrap uses. agent_label overrides the wordmark + transcript role badge + document.title. Both apply only when the window is workspace-pinned (default windows keep brand defaults).
- **Per-call workspace dispatch** (`bridge/call-context.mjs`, multi-window architecture). New `AsyncLocalStorage`-backed call context: `withWorkspace(slug, fn)` runs every async chain inside fn with the workspace pinned, even across awaits. Concurrent calls (Window 1's voice and Window 2's voice firing simultaneously) get isolated stores. Memory + Audit providers consult `getCallWorkspace()` first, falling back to `Workspaces.getActive()` outside any call. `askLLM` and `askLLMStream` accept a `workspace` arg and run their entire body inside `withWorkspace()` when set. WS message handler forwards `payload.workspace` from the HUD → into the dispatch. voice.js + tts-pipeline.js read `window.__pinnedWorkspace` (set by the inline script in index.html from the `?workspace=` URL param) and forward it. The system prompt builder takes a slug override so the per-call workspace's handbook lands in the prompt.
- **Coverage**: 4 new vitest tests covering persona round-trip, hex validation, independent persona-field patches, and `systemPromptHint(slugOverride)` per-call behaviour. Total now 184 tests / 6 files.

### Sprint 6 — Workspaces v3: the operator-workstation promise made complete

- **Auto-import knowledge from working_root** (`bridge/server.mjs#applyWorkspaceOverrides`). When a workspace with `working_root` becomes active, the bridge fires `Knowledge.ingestAll(workingRoot)` in the background. Idempotent — files whose sha256 hasn't changed since the last scan are skipped without re-embedding. Stamps documents with the active workspace via the v2 provider so they land in the workspace's scoped knowledge base. Plus new `refresh_workspace_knowledge` voice tool for explicit re-scan.
- **Per-workspace voice persona** (`bridge/workspaces.mjs`, `voice.js`). Workspace gets an optional `voice` column (Kokoro voice id, e.g. `bm_daniel`, `bf_emma`). When active, overrides the global Settings → Voice preference. `Voice.setWorkspaceVoice()` consumed by the workspace-switcher on `workspace.switched` events so a voice switch happens mid-session. New `VOICE·DANIEL` style chip in the workspace switcher modal telegraphs which workspaces have a custom persona.
- **Workspace-scoped audit log** (`bridge/audit.mjs`). Every audit row now stamps with the active workspace's slug. `audit.query` defaults to filtering by active scope (legacy NULL-workspace rows surface in every scope so historical data isn't trapped). `GET /audit` exposes `?workspace=consulting`, `?allWorkspaces=1` query params + returns scope metadata.
- **Workspace insights** (`workspaces.insights(slug)`, new `workspace_insights` voice tool, `GET /workspaces/<slug>/insights`). Per-workspace stats: turn count (all-time + last-7-days), conversation summaries, contacts, projects, facts, indexed documents, last-active timestamp. Six COUNT(*) queries on indexed `workspace_id` columns — sub-millisecond. HUD: ⓘ button on each workspace switcher row expands an inline panel with the stats grid.
- **Coverage**: 4 new vitest cases covering voice persona round-trip and insights for empty/non-existent workspaces. Total now 180 tests / 6 files.

### Sprint 5 — Workspaces v2: the workstation that remembers

Promotes workspaces from "different config per scope" to "different *brain* per scope." Conversation history, knowledge base, contacts, projects, and facts are all now workspace-aware. Plus portable export bundles so an operator can move a workstation to a new Mac.

- **Workspace-scoped memory** (`bridge/memory.mjs`). `workspace_id` column added to `contacts` / `projects` / `facts` / `conversation_summaries` / `conversation_turns` / `documents` via idempotent ALTER TABLE migrations (re-running on a v1 install is safe). Per-table indexes added. Active-workspace provider injected via `setActiveWorkspaceProvider(fn)` so memory.mjs reads the slug lazily — workspace switches mid-session take effect immediately.
- **Default-scoped writes**: `appendTurn`, `remember`, `addContact`, `addProject`, `upsertDocument` all stamp the active workspace's slug at write time. NULL = unscoped (legacy turns) — those rows surface in every scope so existing data isn't trapped.
- **Default-scoped reads**: `recall` (semantic across facts + contacts + projects + summaries) and `searchKnowledge` (vector + BM25 hybrid) filter by the active workspace's slug. Both accept `allWorkspaces: true` to bypass the filter when the operator says "search across all workspaces". `recentTurns` (HUD history drawer) does the same.
- **Workspace-aware HUD drawer** (`history.js`). Conversation drawer header shows a cyan workspace chip telegraphing the active scope. Async-fetch from `/workspaces` so the chip stays current after a workspace switch — no manual refresh needed.
- **Portable workspace bundles** (`bridge/workspace-export.mjs`). `export_workspace` voice tool produces a `<slug>-<stamp>.jarvis-workspace.tgz` on the operator's Desktop:
  - `manifest.json` (workspace metadata + bundleVersion + counts)
  - `handbook.md`, `creative-style.md` (content, not paths — the path is meaningless on the import machine)
  - JSONL files for facts / contacts / projects / conversation_summaries / documents
  - `conversation_turns.jsonl` is OPT-IN via `includeTurns: true` (raw transcript is the most personal data; summaries are always included as the high-signal compressed form)
  - `import_workspace` voice tool consumes the bundle. Refuses to clobber an existing workspace of the same slug unless `overwrite: true`. Confirmation-gated.
  - Streamed via `tar -czf` (BSD tar, `--no-mac-metadata` for portable bundles); inspect with `tar -tzf`.
  - `bundleFingerprint()` exposes a deterministic sha256 for dedupe.
- **Coverage**: 9 vitest tests for round-trip integrity, v1-field preservation, scoped-rows export, includeTurns toggle, collision protection, fingerprint determinism. Total now 176 tests / 6 files.

### Sprint 4 — Workspaces v1: depth on the wedge

Lifts workspaces from "context label" to "operating context" — the kiosk now actually behaves differently per workspace, not just nominally.

- **Per-workspace `working_root`** (`bridge/workspaces.mjs`, `bridge/paths.mjs`). When a workspace declares its own working dir, `Paths.getWorkingDir()` returns the workspace's path for the rest of the turn (or until next switch). `Paths.setWorkspaceOverride()` is the bridge's hook into paths.mjs without a circular import. The 58 existing call sites that use `getShootsDir()` / `getWorkingDir()` automatically pick up the override.
- **Per-workspace `tool_allowlist`** (skill packs). Workspace stores a JSON array of tool names; when active, the LLM only sees those built-in + plugin tools — narrows the catalogue from 60+ to 5-15 relevant ones. Workspace-management tools (`create_workspace`, `switch_workspace`, `list_workspaces`, `delete_workspace`) are unconditionally exposed so the operator can never get trapped inside a workspace with no escape. New helper `getEffectiveTools()` in server.mjs flows through both LLM call paths via the embedding tool router.
- **Per-workspace `creative_style_path`** (`bridge/creative-style.mjs`). Workspace can point at a workspace-specific `creative-style.md` — different voice for consulting vs photo agency vs personal. Resolved relative to the workspace's `working_root` if that's set, else PROJECT_ROOT. Override flows through `setOverridePath()`; cache invalidates on every override change so a switch immediately picks up the new file.
- **`shoots/` → `working/` rename**. `Paths.getWorkingDir()` is the new primary; `getShootsDir()` is preserved as a deprecated alias returning the same path so the 58 call sites don't all need to update at once. brand.json `paths.working` is the new key (preferred); `paths.shoots` honoured as legacy. Default directory on a fresh install is `working/`; existing installs with `shoots/` keep using it (cache prefers an existing on-disk dir over creating a new one).
- **HUD workspace switcher chip** (`workspace-switcher.js`, calendar strip). Pill chip in the top bar shows the active workspace label (or "(no workspace)"). Click → modal listing all workspaces with switch / create / delete-via-voice / clear-active. Cmd+W toggle. Live-updates on `workspace.switched/created/deleted` WS events. Persists active slug to localStorage so a bridge restart re-asserts the operator's choice. Meta chips (`ROOT` / `TOOLS·N` / `HANDBOOK` / `STYLE`) on each row tell the operator at-a-glance which workspaces have v1 fields configured.
- **First-run seeding** (`Workspaces.seedDefaultIfEmpty()`). On a fresh install (zero workspaces in `data/memory.db`), the bridge auto-creates a "Personal" workspace + activates it. No-op on every subsequent boot, even if the operator deletes the default. The HUD chip shows "Personal" out of the box instead of "(no workspace)".
- **Coverage**: 7 new vitest cases for v1 fields + seed behaviour. Total now 167 tests / 5 files.

### Sprint 3 — workstation foundations

- **Workspaces v0** (`bridge/workspaces.mjs`). First-class operating contexts — the operator is "in their consulting workspace" or "photo agency workspace" and switching changes the LLM's system prompt scope. v0 ships:
  - SQLite-backed `workspaces` table (slug PK, label, description, handbook, created_at, last_active) on `data/memory.db`
  - Four voice-callable tools: `create_workspace`, `switch_workspace`, `list_workspaces`, `delete_workspace` (last is confirmation-gated)
  - System prompt injection — when a workspace is active, its handbook lands in every askLLM call so the LLM follows scope-specific rules
  - HTTP endpoints `GET /workspaces` + `POST /workspaces/active` so the HUD can re-assert the operator's choice across bridge restarts
  - Slug validation (`/^[a-z][a-z0-9-]{1,40}$/`) rejects mixed-case input rather than silently lowercasing it; reserved slugs (`new`, `delete`, `list`, `active`, `default`) blocked
  - Vitest coverage (13 tests) + per-test cleanup so the shared DB doesn't accumulate residue
  - Horizon-2 wedge — future versions tie workspace switching to working-dir defaults, per-workspace skill packs, and scoped contact / project lookups
- **Crash reporter** (`bridge/crash-reporter.mjs`, `data/audit/crashes/`, `GET /health/crashes`). Replaces the Sentry slot in the original Phase 3 roadmap with a privacy-first alternative:
  - Captures `uncaughtException` + `unhandledRejection` at the process level
  - Sanitises every captured field: redacts known-secret env values (matched by name pattern `*_KEY|*_TOKEN|*_SECRET|*_PASSWORD|*_PWD`), `sk-…` tokens, `Bearer …` headers, `$HOME` absolute paths
  - Appends a sanitised row to `data/audit/crashes/YYYY-MM-DD.jsonl`
  - Broadcasts `system.crash` over WS so the HUD toasts even when the bridge is about to die
  - Optional opt-in upload via `JARVIS_CRASH_REPORT_URL` env var (no Sentry account needed; operator can stand up a one-file Cloudflare Worker)
  - Monotonic `seq` field breaks ties when crashes land in the same millisecond — `recent()` ordering is deterministic
  - 10 vitest tests cover redaction, sanitisation, and ordering
  - `tools/diagnose.sh` now bundles the last 7 days of crashes alongside the existing session telemetry
- **Onboarding wizard polish** — first-launch HUD modal now covers brand identity end-to-end: agent name, wake phrase, agency, six accent-colour chips + custom hex, plus the existing voice / mic / location / tier fields. Submit POSTs to `/brand` (writes `config/brand.json`, broadcasts `brand.updated`, HUD live-reloads). `install.sh` flipped the CLI brand wizard from default-on to opt-in (`--with-cli-wizard`) — the in-kiosk experience is now Terminal-free for non-tech operators.

### Sprint 2 — the self-extending kiosk

- **`build_plugin` tool** (`bridge/plugin-generator.mjs`, `bridge/server.mjs`). Voice command → Jarvis scaffolds a working plugin → plugin-loader's `fs.watch` hot-loads it within 500ms → the new tool is callable in the same session. Two modes:
  - **Stub mode** (no `behaviour` arg): writes `manifest.json` + `handler.mjs` with a placeholder return value. Operator opens the handler and replaces the body with real logic; the watcher hot-reloads on save.
  - **Agent-seeded mode** (`behaviour` arg present): writes the manifest plus a seed handler, returns an `agentPrompt` the LLM can pass to `code_agent_run` to fill in real logic. The operator hears one confirmation for the scaffold and a second for the agent run.
  - Slug + tool name validated against the same regexes the plugin loader uses, so a generated plugin never gets rejected at load. Path-traversal slugs (`../escape`) and non-snake_case tool names refused.
  - Collision protection: refuses to clobber an existing plugin of the same slug unless the operator explicitly grants `force: true` via voice.
  - Confirmation gate (`build_plugin`) shows the slug, tool name, voice intent, and mode (stub / agent) before any files are written.
  - `plugin.built` WS event fires alongside the watcher's `plugins.reloaded` so the HUD can distinguish "scaffolded by build_plugin" from "operator edited an existing plugin".
- **Smoke test** (`test/build_plugin_smoke.mjs`, `npm run test:smoke:plugin`). 16-stage end-to-end check against a running bridge: stub mode generates files + hot-loads, agent mode returns the prompt, collision protection holds, validation rejects bad input, cleanup leaves no residue. Standalone (not vitest) because it requires a live bridge.
- `actions.meta.json` entry under the **system** category with phrasings like "build a plugin", "make me a tool", "I want jarvis to be able to". The COMMANDS panel now surfaces it.

## [0.2.0] — 2026-05-09 — White-label rebrand

Flat-Out Media-flavoured fork relicensed and re-skinned as **Jarvis AI Assistant**, a generic voice-first AI workstation for Apple Silicon. Every FOM-specific tool, vocabulary, and brand asset replaced with neutral equivalents; the operator can now ship the whole kiosk to a client by editing `config/brand.json`.

### White-label rebrand

- Tools surface trimmed 110 → 60 — agency-specific tools (Frame.io, Lightroom, Premiere, MailerLite, etc.) removed; generic ones (mail, calendar, knowledge base, code-agent, browser) kept.
- Palette swap to arc-reactor cyan (`#00d4ff` / `#0077a8`) replacing FOM red. All 4000+ lines of `styles.css` audited.
- `config/brand.json` runtime brand identity (agent name, agency, wake phrase, colours, fonts, logo paths). Live-editable via the Settings → Brand Identity panel; bridge broadcasts `brand.updated` and the HUD soft-reloads.
- `.brand-lock` guard in `tools/update.sh` so a forked install can pull upstream code without losing its custom brand.
- Setup wizard prompts for agent name / agency on fresh installs; embedded Jarvis defaults if skipped.
- Removed FOM-residual env vars (`FRAMEIO_*`, `SERPAPI_KEY`, `HUNTER_*`) from boot summary; replaced with the generic NAME=VALUE custom-keys editor.

### HUD instrument-cluster rebuild

- New centrepiece: arc-reactor concentric rings + per-core CPU arc (replaces the FOM-styled tachometer).
- Real Apple Silicon temps via [macmon](https://github.com/vladkens/macmon) (sudoless SMC reader). CPU/GPU °C + per-domain wattage land on the rim chips and core-telemetry pod every 1.5s.
- Voice waveform centerpiece (canvas, DPR-scaled, 30fps RAF) replaces the static brand wordmark.
- Paired core-telemetry dials: CPU usage / CPU temp, GPU usage / GPU temp, RAM / VRAM, internet down / up.
- Rim chips: CORE / SYS-DIAG / AUDIO / NET-IO. Right-hemisphere radar sweep (4s linear).
- Editable widget layout — Cmd+L drags / resizes side widgets; per-profile persistence via Storage; reset button in Settings.

### Sprint 1 — depth bets

- **T1: Latency instrumentation + sub-1s.** `performance.mark()` chain across `voice.js → bridge → kokoro → audio-play`. `/perf` POST aggregates rolling p50/p95 over the last 50 turns. Sentence segmenter loosened to comma/colon at ≥12 chars for the first chunk. Shift+Cmd+P opens the latency debug panel.
- **T2: Plugin scaffold.** `bridge/plugin-loader.mjs` hot-loads any `bridge/plugins/<name>/{manifest.json, handler.mjs}`. Confirmation gates use safe template-string substitution (no dynamic-eval). Sample plugin: `example-quote`. See `docs/plugin-authoring.md`.
- **T3: First-run experience.** `onboarding-tour.js` 90s guided tour (3 steps + completion). Subscribes to voice.js's `onQueryHandled`. Boot greeting in `tts.js` composed from `/weather` + `/health` so Jarvis says "Good morning sir, partly clouded 14°C, all systems online — what can I help with?" instead of dead air.
- **T4: Tool discoverability.** Permanent `?` COMMANDS button in calendar strip. `config/actions.meta.json` categorises 61 tools into communication / productivity / creative / system / memory. `npm run docs:tools` regenerates `docs/tool-reference.md` from the bridge's `/actions` introspection.
- **T5: Local-first telemetry + diagnostic ZIP.** `bridge/sessions.mjs` appends per-turn rows to `data/audit/sessions/YYYY-MM-DD.jsonl`. `/health/sessions?days=N` returns aggregated p50/p95. `tools/diagnose.sh --no-email` bundles last 7 days + plugin manifests + brand config + log files (excludes `.env`, `data/memory.db`, full audit log). `docs/privacy.md` documents what does and doesn't leave the device.

### Phase 1 — stabilisation

- `startStatsFallback` no longer wakes the JS event loop 40×/min when the bridge is alive. Self-rescheduling timeout pulls down to a 4s heartbeat when stats are flowing.
- `layout.js` now re-applies the saved layout on viewport-resize (debounced 150ms) so future breakpoint-aware sizing has a clean hook.
- Brand-bootstrap exposes `window.__brandReady` (Promise) + dispatches `brand:applied` so module scripts can deterministically gate on the brand fetch.
- **Silent failures now toast.** New `bridge/system-warnings.mjs` central registry. Macmon-missing fires at boot if the binary isn't found. LLM 401/403 surfaces from Anthropic / OpenAI providers. Bridge offline / online emits from `bridge-client.js` after a 2s grace. Dedupe by code so retries don't spam.
- Radar sweep rotation pinned to viewBox centre — was orbiting the SVG top-left corner because `transform-origin: 0 0`.
- GitHub Actions CI: typecheck + vitest + shellcheck on every push.

### Architecture

- MCP server at `POST /mcp` exposes all 60+ bridge tools to any MCP host (Claude Desktop, Cursor, Continue). JSON-RPC 2.0 — `initialize`, `tools/list`, `tools/call`, `ping`.
- Tool router with embedding-based filtering keeps the system prompt under 8k tokens regardless of plugin count.
- 5-bucket tool categorisation drives both the `?` panel and tool-pick relevance.
- Editable LLM provider routing per workload (chat / vision / high-stakes) — Ollama default, Anthropic / OpenAI opt-in via Settings → API Keys.

### Known not-yet-done (deferred)

- Signed DMG installer (needs Apple Developer Program signup).
- Sparkle auto-update + LaunchAgent daemon — LaunchAgent plist landed, Sparkle pending the DMG.
- 90s demo video — operator-recorded, not generated.
- Cross-platform port (macmon abstraction, Linux temp reader). v1 stays Apple Silicon.

---

## 2026-05 (current sprint)

### HUD UX polish
- **Editable widget layout** (`layout.js`). Cmd+L enters edit mode; drag widgets to swap, click size cycler for 1×1 / 1×2 / 1×3. Per-profile persistence via Storage. EDIT LAYOUT + RESET LAYOUT buttons in settings footer for discoverability. Six side panels (month, system, comms, weather, clock, launch) become rearrangeable; centre speedo + bottom telemetry stay fixed.
- **Settings modal scrolls** (`styles.css`). 90dvh cap with sticky head + actions/footer so the panel never overruns the viewport. Brand-aligned red scrollbar.
- **Notifications drawer close button** (`notifications.js`). Discoverable × button next to CLEAR.
- **Calendar widget unstuck** (`bridge/server.mjs`, `hud.js`). Two bugs: `/diary` filter checked `e.startDate` but events have `e.start`; `pollDiary()` silently returned on errors leaving the loading state forever. Now surfaces explicit error states (bridge offline, calendar timeout, calendar permission denied).
- **TUNE button relocated** to top-left so it stops covering the DOWN/UP telemetry value.
- **Per-profile theming polish**: "Reset to brand default" link clears the per-profile accent override.
- **Plan stage panel** (`plan.js`). Bridge broadcasts `tool.proposed` before slow / external-side-effect tools fire; centred top-of-screen panel shows "ABOUT TO: cut a the press car teaser" with 1.8s window for Esc to cancel via `/cancel`. Pre-empts misheard 90s renders.
- **Keyboard accessibility pass**. Skip-link to wake button. Global `:focus-visible` red ring on every interactive element. `role="dialog"` + `aria-modal` on settings + setup modals.

### Voice loop
- **Sentence-level TTS streaming + barge-in** (`bridge/server.mjs#askLLMStream`, `tts.js`, `voice.js`). LLM streams via Ollama NDJSON, splits on sentence boundaries, queues each sentence to Kokoro independently. First audio in ~1s instead of waiting for the full reply (~5s on a multi-sentence answer). Mic-RMS monitor during speaking-real cancels TTS when the operator interrupts (>0.18 RMS for 250ms).

### Bridge architecture
- **Configurable shoots / output folders** (`bridge/paths.mjs`). Single source of truth for shoots + output roots. `getShootsDir()`, `getOutputDir()`, `getOutputSubdir(key)`, `OUTPUT_SUBDIRS` taxonomy (`youtube/{thumbnails,shorts}`, `instagram/{reels,posts}`, `tiktok`, `brand-packs`, `pdf`, `watermarked`, etc). Settings modal "Folders" section + setup wizard prompts. Persisted to `config/brand.json .paths`. 16 bridge modules migrated from hardcoded `path.join(PROJECT_DIR, "shoots"/"output")` to the helper.
- **MCP server** (`bridge/mcp.mjs`). JSON-RPC 2.0 endpoint at `POST /mcp`. Implements `initialize`, `tools/list`, `tools/call`, `ping`. Exposes all 76+ bridge tools to any MCP host (Claude Desktop, Claude Code, Cursor, Continue) — connect with `{"url": "http://localhost:8766/mcp"}`.
- **Containerised render env** (`docker/render/Dockerfile`, `bridge/container.mjs`). Pinned Debian-bookworm-slim image with ffmpeg + ImageMagick + exiftool. `RENDER_USE_DOCKER=1` routes shell commands through the image with `/work` (rw), `/shoots` (ro), `/output` (rw), `/assets` (ro) mounts. Reproducible binary versions across operator Macs.
- **Live shoot mode** (`live.html`, `live.js`, bridge endpoints). Phone-as-mic companion view at `GET /live`. Push-to-talk records → `POST /live/transcribe` proxies to Whisper → flag-intent regex routes "hero" / "reshoot" / "skip" / "maybe" / "keep" to `flag_shot` on the most recent file. Quick-action chips (HERO / KEEP / MAYBE / RESHOOT) skip the STT round-trip. Events broadcast back over WebSocket so the kiosk's task strip + the phone's feed stay in lockstep.

### Agency tooling
- **Manufacturer media-day calendar** (`bridge/media-days.mjs`). SQLite table on memory.db with `addMediaDay / listMediaDays / deleteMediaDay`. UNIQUE constraint prevents duplicate adds when the LLM re-processes the same press email. Freeform date parser ("June 15", "15/6/26", ISO) auto-rolls bare day-month input to next future occurrence. 3 new tools; `delete_media_day` gated by NEEDS_CONFIRMATION. Comms strip surfaces the next 3 upcoming events.
- **Editorial style memory** (`bridge/style-memory.mjs`). ImageMagick-driven extraction of mean RGB / luminance / contrast / saturation / warm-bias from a folder of finished edits. Stored as a named "style" in memory.db with a deterministic colourist's prose description ("warm bias, mid saturation, medium contrast, balanced exposure"). 5 new tools: `extract_style`, `list_styles`, `recall_style`, `compare_to_style`, `delete_style`. `compare_to_style` returns adjustment guidance ("cool by 0.04; raise contrast by 0.03").
- **Cost / usage telemetry** (`bridge/usage.mjs`, `usage.js`). `GET /usage` aggregates audit log into a daily snapshot (dispatches, errors, error rate, avg duration, fal call count, top tools, by-operator breakdown). VIEW USAGE button in settings opens a centred overlay with five-tile headline + tool-list breakdown.

### Stability
- **TTS sanitiser bug fix**: regex character class `[0-ᾟ]` was wiping ASCII letters silently. Replaced with Unicode property escape `\p{Extended_Pictographic}`.
- **TTS ratio-vs-time misclassification**: "16:9" was treated as a clock time. Now requires both parts to be 2 digits.
- **vision.mjs:268** undefined `folderName` (would crash callers) → fixed to `folder`.

### Dropped (not pursued)
- **Remotion** — paid for companies >3 employees ($100-500/mo). Keeping canvas + ffmpeg pipeline.
- **Capture One** scripting —  the lead client doesn't run Capture One.
- **DaVinci Resolve / FCPXML bridge** —  the lead client edits in Premiere; nobody's grading in Resolve.
- **Voice cloning** (F5-TTS, ElevenLabs Pro) — operator finds it weird; sticking to off-the-shelf Kokoro voices.

---

## Earlier sprints

(Pre-sprint state — see git log for granular history. Major shipped items: voice.js extraction, action manifest, runId audit, P1 notification queue + history drawer + demo mode + Cmd+K palette + help nudges, P2 multi-operator profiles + audit log + undo + project context switcher, embedding-based tool router, accessibility-tree primitive, Memory Dream Cycle, lane-grouped task progress, auto-cull, brand-pack auto-export, pre-shoot checklist, EOD digest, multi-machine memory sync, press-cycle radar.)
