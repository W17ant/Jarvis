# Jarvis HUD — Outstanding Work

Living todo list. Honest reckoning: a lot of this list was stale by the time anyone read it. **Last sync: 2026-05-07** after a major sprint that shipped 22+ commits in one session (MLX Whisper, voice loop ~3-4× faster, six voice.js extractions, vitest scaffold, CONTRIBUTING.md).

**Legend**: 🟥 critical · 🟧 high · 🟨 medium · 🟩 low · ⚙️ architecture · 🚀  the agency workflow win

---

## Currently outstanding

Items that are NOT shipped and need real work. The "Shipped" sections below capture what was previously here as outstanding but is now done.

### Tractable in a focused session (under a day)

- 🟧 ⚙️ **voice.js extraction tail** — six modules out, voice.js at 1620 LOC (down from 3105). Remaining: `passive-vad.js` (~250 LOC, biggest), `tts-pipeline.js` (~150 LOC, speakStream + barge-in), `conversation-mode.js` (~150 LOC), `demo-recorder.js` (~100 LOC), inbox/PDF/thumbnail event-handler cluster (~150 LOC). All need the deps-injection pattern established this sprint.
- 🟧 ⚙️ **Per-runId abort flags** — tonight shipped a HUD STOP button but it's still global cancel only. Crew has per-crewId abort already; Vision and Browse need the same. Then `/cancel?runId=X` + per-row × buttons in tasks.js.
- 🟧 🚀 **Lightroom catalogue read-only via SQLite** — `.lrcat` files are SQLite. New tool `find_lr_photo({rating, date_range, keyword})` for "find five-star shots from the Bentley shoot". No plugin install needed; read-only is safe.
- 🟧 **Anthropic prompt caching** — when `LLM_PROVIDER=anthropic`, wrap system+tools in `cache_control: ephemeral`. ~90% input-token cost cut + ~500ms TTFT improvement on repeat turns. Cloud-only — no effect on Ollama.
- 🟨 **Frame.io official SDK migration** — replace hand-rolled REST client in `bridge/frameio.mjs` with `@frameio/api`. Saves writing types.

### Multi-day projects

- 🟧 🚀 **Live shoot mode (phone-as-mic)** (~1 week) — the one transformative piece of the original Phase 5 plan still missing. Phone walks the studio, real-time captions per shot, "flag this as hero" mid-frame, contact sheet ready by lunch.
- 🟧 🚀 **Multi-machine memory sync** (~3-5 days) — periodic backup of `data/memory.db` to NAS / shared encrypted folder. Needs conflict-resolution design first.
- 🟧 ⚙️ **Plugin SDK shape** (~3-5 days) — `bridge/skills/<name>/` convention so new tools drop in without editing `server.mjs`. Architectural — design pass first.
- 🟨 ⚙️ **Containerised render env polish** (~3-5 days) — Docker per video job with ffmpeg + ImageMagick + exiftool pre-baked. Scaffold ships behind `RENDER_USE_DOCKER=1`; reliable parity with host pipeline isn't done.
- 🟨 **Lane-grouped progress viz** (~1-2 days) — video pipeline stages as parallel lanes in the task strip.
- 🟩 **Tablet/iPad responsive variant** (~2-3 days) — operator's iPad mirrors HUD when away from desk.
- 🟩 **Layout customisation** (~3 days) — drag panels to reposition, save per-profile.

### Needs Adam's involvement

- 🟧 **Argos / Amazon UK / MPB checkout codegen** — adapter scaffolds shipped weeks ago, click-by-click checkout intentionally stubbed. Needs Playwright codegen against a real logged-in basket session.
- 🟨 **Hand-over doc with screenshots** — full visual walkthrough of installation + setup. Needs Adam's screenshots from a fresh M-series Mac install.

### Already evaluated and discarded — don't waste time

- ❌ **MLX-LM for the chat model** — tested 7th May 2026; Ollama wins on hot TTFT (74ms vs 133ms) due to its prefix cache. MLX wins cold start but `KEEP_ALIVE=24h` keeps weights hot.
- ❌ **Kokoro sub-sentence streaming** — tested 7th May 2026; `create_stream` yields one chunk per sentence. No latency win at sentence granularity.

### Borrowable from competitor / adjacent projects

Audit pass over OpenClaw + NextChat + Cherry Studio + AionUi (Open-Assistant is archived — skipped). Items below are things THESE projects do that Jarvis doesn't, plus an honest reading of which are worth stealing for a vertical voice kiosk and which would dissolve the identity.

**Worth doing:**

- 🟧 ⚙️ **Plugin / extension SDK shape** (~3-5 days) — both OpenClaw (`packages/plugin-sdk`) and AionUi (`skills/` directory, three sources: builtin / custom / Extension SDK) ship a contract third parties can extend without forking. Jarvis adds tools by editing `bridge/server.mjs` — fine while there's one builder, doesn't scale to community contributions. A `bridge/skills/<name>/` convention with a stable function signature would let plugins land as drop-ins.
- 🟧 🚀 **Document RAG / knowledge base** (~3 days, Cherry Studio pattern) — currently `data/memory.db` holds contacts/projects/facts as one-line items. A document-level RAG would let Adam drop a brand brief, client onboarding PDF, or past press release into a "knowledge" folder and have Jarvis cite from it on any query. Uses the existing nomic-embed pipeline; just needs a new `documents` table + chunking + retrieval-into-context wiring.
- 🟧 📨 **iMessage in / TTS out adapter** (~1 day) — thin AppleScript bridge: incoming iMessage → bridge → reply text → bridge → osascript reply with optional Kokoro audio attachment. Lets Adam interact with Jarvis from his phone without WhatsApp / Telegram bloat. Useful even for a single-operator kiosk because you're not always at the desk.
- 🟧 ⚙️ **Vitest test infrastructure** (~1 day) — Cherry Studio + AionUi both run vitest + playwright. Jarvis has minimal automated tests; the bridge surface is ~7000 LOC. A test pass with fixture data for the dispatch path, fast-path, tool router, and purchases rails would catch regressions on every commit.
- 🟨 🚀 **Office document tools** (~2-3 days, AionUi pattern) — AionUi's built-in skills include pptx, docx, xlsx, mermaid. Jarvis has rich PDF generation but no Office formats. `generate_pptx({ template, slides })` for client decks and `generate_xlsx({ data, layout })` for shoot logs would close a real  the agency workflow gap.
- 🟨 🚀 **Mermaid diagram generation** (~half day, AionUi pattern) — render mermaid → SVG/PNG for workflow diagrams, brand-structure maps, shoot timelines. Cheap addition; image generation already in the pipeline.
- 🟨 🚀 **Multi-agent orchestration** (~3-5 days, AionUi "Cowork" pattern) — let the LLM spin up parallel sub-agents for independent research tasks ("compare these three lenses across WEX / MPB / Park Cameras simultaneously"). Each sub-agent uses request_browse + a focused goal; results merge into a final report. Builds on existing browse + provider infrastructure.

**Considered and skipped:**

- ❌ **Tauri / Electron native packaging** (NextChat / Cherry Studio / AionUi) — Jarvis is intentionally Chrome `--app` mode. Custom packaging adds an installer to maintain across platforms; the kiosk surface stays cleaner with the existing approach. Revisit if cross-platform becomes a goal.
- ❌ **Multi-channel adapters beyond iMessage** (Telegram / Slack / Discord — OpenClaw pattern) — would dissolve the voice-first identity. iMessage is the one exception because it's local osascript and fits the Mac kiosk model.
- ❌ **MCP marketplace UI** (Cherry Studio) — niche; Jarvis already exposes MCP at `/mcp`. A marketplace assumes a community that doesn't exist yet.
- ❌ **Open-Assistant patterns** — archived 2023; the inference / RLHF tooling targets cloud LLM training, irrelevant to a local voice kiosk.

### Multi-agent orchestration (audit pass over CrewAI / OpenAI Agents SDK / smolagents / Aider / Goose)

The bottleneck on local hardware is one Ollama process serving requests sequentially — concurrent agents thrash the GPU. **Cloud APIs (Anthropic / OpenAI) don't share that constraint** — 3-5 concurrent Claude calls is fine for the API and bounded by API key rate limits, not by Adam's M5 Max. So multi-agent is genuinely viable when the workload routes to cloud.

**Worth building (highest priority of this audit):**

- 🟥 🚀 **Crew orchestrator** (~3-5 days, CrewAI-shaped) — `bridge/crew.mjs` with two orchestration modes:
  - `sequential` — pipeline tasks (research → draft → format → publish). Each step on its own agent with its own tool subset.
  - `parallel` — manager dispatches independent sub-agents simultaneously. Cloud-only — agents routed to Ollama queue serially since GPU is single-context. Cloud agents fan out properly concurrent.

  New tool: `spawn_crew({ task, mode, agents })`. Each agent spec includes role, goal, allowed tools, and a provider override (so you can force a sub-agent to use Claude even when the main loop is on Ollama).

  First real workflow: "compare these three lenses across WEX / MPB / Park Cameras" → 3 parallel `request_browse` agents on Claude → results merged for the operator. Currently the same query runs 3 sequential browses, ~90s. With cloud parallelism: ~30s.

- 🟧 🚀 **CodeAgent escape hatch** (~2 days, smolagents pattern) — `code_agent_run({ goal })` lets the LLM write a small Python (or TypeScript) script that calls Jarvis tools dynamically, runs in a sandbox, returns the result. Escapes the static tool catalogue when a workflow needs novel composition the LLM didn't have a tool for. Pairs with the bridge's existing `run_shell` confirmation gate but with a tighter sandboxed runtime.

- 🟧 ⚙️ **Provider concurrency guard** (~half day) — formalise the cloud-only parallelism rule in `llm/providers.mjs`: any code path requesting >1 concurrent call MUST route to a cloud provider with a key set; Ollama requests serialise behind a single in-flight semaphore. Not user-visible but stops the LLM from accidentally crashing the GPU by spawning a parallel local crew.

- 🟧 🚀 **"Studio map" / project-state summary** (~1 day, Aider repo-map pattern) — pre-compute a structured "what's in this kiosk right now" digest (active shoots + their state, recent tasks, top contacts, current Frame.io review queue) that's cheap context for any LLM call. Cached, refreshed on inbox-watcher events. Tokens-on-budget so it scales.

**Considered + skipped:**

- ❌ **Goose's ACP (Agent Communication Protocol)** — over-engineered for a single-kiosk scenario. Useful if Jarvis becomes multi-process or multi-machine; revisit then. The pattern overlaps with the plugin SDK shape we're already adding.
- ❌ **Aider's "multiple coder modes"** — Jarvis's tool routing already differentiates drafting vs chat vs tool-call hops via the cascade router + tool-router filter. Adding mode-specific coders would duplicate that.
- ❌ **OpenAI Agents SDK (Swarm successor)** — Python-only, would require a Python service alongside the Node bridge. The orchestration patterns it ships are simpler than CrewAI's; we can replicate them in `bridge/crew.mjs` without taking on a Python runtime.

**Why this matters more than other items in this section:** Adam asked about it directly. The infrastructure to make it work (pluggable providers, cost telemetry, tool router, cancel) is all already shipped in PR #1. The crew orchestrator is the natural follow-on — it's the layer that turns "Jarvis runs one tool at a time" into "Jarvis dispatches a task force when the workload justifies it".

---

## Shipped — sprint of 2026-05-06 → 2026-05-07

The big push. Voice loop ~3-4× faster end-to-end, voice.js -48% in size, real test net in place.

- ✅ **MLX-accelerated Whisper** (commit `9ed7d36`) — 6.78× faster STT (3080ms → 450ms hot on a 7.8s clip). `whisper_server.py` auto-selects MLX on Apple Silicon, falls back to faster-whisper. Bridge `/healthz` surfaces active backend; HUD pip tooltip shows it.
- ✅ **Tier-1 voice-loop latency wins** (`0453e12`) — `SILENCE_MS` 1400→800ms, faster-whisper VAD 300→150ms, deferred filler with cancel-on-first-sentence. ~1s shaved off every turn.
- ✅ **Speculative mid-utterance whisper partial** (`9da199c`) — fires at chunk #6 (~1.5s), uses partial directly if silence-detect arrives within 1s. Saves another ~450ms on short queries.
- ✅ **Ollama prefix-cache fix** (`101f0a4`) — local time was in SYSTEM, invalidated cache every minute. Moved to user message; SYSTEM stable through the whole day → consistent 74ms TTFT.
- ✅ **Filler-phrase TTS cache** (`c86d7ed`) — first call pays full Kokoro synth (~400-1100ms), every repeat returns cached WAV in ~10ms. ~100× speedup on warm fillers.
- ✅ **HUD STOP button** (`3e6e4e4`) — visible kill-switch above the active-task strip. Per-task × buttons deferred (`/cancel` is global today).
- ✅ **Wake-word check button** (`62482f0`) — settings modal records 3s, transcribes via Whisper, runs `WakeParse.containsWake` — pass/fail verdict pill.
- ✅ **Vitest scaffold + 58 tests** (`a3b89f3` + `6c1671e`) — fast-path regression coverage including all of Adam's reported phrasings, plus tool-router fallback paths. `npm test` runs in ~140ms.
- ✅ **5 fast-path gap closes** (`6c1671e`) — `whats the time` (no apostrophe), `what time is it right now` (trailing context), `set timer for 10 minutes`, `sleep mode` / `go quiet` / `shush`, `thats all` / `thats enough`.
- ✅ **Scope-refusal bug fix** (`c0a2417`) — Adam reported "I'm only here for automotive Jarvis tasks" refusal on map queries. Fast-path regex liberalised + SYSTEM prompt got an explicit "DO NOT REFUSE GENERAL TASKS" block.
- ✅ **macOS device-change auto-recovery** (`892f0cb`) — listens for `navigator.mediaDevices.devicechange`, drops cached `wf.micStream` + analyser when the operator switches input. Self-healing.
- ✅ **Whisper `initial_prompt` slim** (`126ed65`) — example sentences ("Hey Jarvis, what's the time?") were biasing Whisper toward "what's" hallucinations on quiet clips. Brand tokens only now.
- ✅ **Passive cycle ReferenceError fix** (`e68b563`) — voice.js extraction removed `WHISPER_URL` const but cyclePassive still referenced it. Every wake-detect attempt was failing silently. Restored.
- ✅ **CONTRIBUTING.md** (`892f0cb`) — workflow guide for Adam to use Claude Code on the codebase: branch convention, commit style, service map, test commands, curated task list.
- ✅ **voice.js extractions × 6** (3105 → 1620 LOC, -48%): wake-parsing (`00f2705`), settings-modal (`7cb0616`, -1000 LOC), setup-modal (`15000b5`), mic-test (`d2fb671`), timer-hud (`9466003`), whisper-stt (`c0883cf`).

---

## Shipped (was previously listed as outstanding)

The TODO had marked these critical / high / medium. They're all in the code now:

- ✅ Embedding-based tool router (`bridge/tool-router.mjs` + nomic-embed)
- ✅ Auto-cull a shoot folder (`auto_cull` tool, `bridge/autocull.mjs`)
- ✅ Brand-pack auto-export (`build_brand_pack`, `bridge/brandpack.mjs`)
- ✅ Pre-shoot kit checklist (`pre_shoot_checklist`)
- ✅ Press-cycle radar (`press_cycle_radar`, daily schedule)
- ✅ Manufacturer media-day calendar (`add_media_day` / `list_media_days`)
- ✅ EOD activity digest (`request_eod_digest`, `bridge/eod-digest.mjs`)
- ✅ Editorial style memory + visual style learner (`extract_style`, `learn_visual_style`)
- ✅ Sentence-level TTS streaming + barge-in (`askLLMStream` + `startBargeInMonitor`)
- ✅ Wake-flick on detected wake word (already wired in voice.js)
- ✅ Demo / Clean mode toggle (Shift+Cmd+D)
- ✅ Help / cheat sheet HUD (`?` opens searchable command list from `/actions`)
- ✅ Action manifest (`GET /actions`)
- ✅ Accessibility-tree primitive (`read_active_window`)
- ✅ Per-turn conversation history persistence + drawer (`H` key, `bridge/memory.mjs`)
- ✅ MCP server support (`POST /mcp` JSON-RPC)
- ✅ Reduced motion / high contrast / bigger text (Shift+Cmd+M/C/T)
- ✅ Containerised render env scaffold (`RENDER_USE_DOCKER=1`)
- ✅ Cost / usage telemetry (`bridge/usage-log.mjs` + Agent Console)
- ✅ Cancel active jobs (`cancel_active_jobs` tool, Vision + Browse cooperative abort)
- ✅ Multi-operator profile picker — boot lock-screen (`hud.js` `maybeShowProfileLockScreen`)
- ✅ HUD command palette — Cmd+K, free-text + tool-browse modes
- ✅ First-run onboarding tips — pinned bottom-left for 60s, per-profile flag
- ✅ Per-profile theming — already persisted in profiles.js Storage namespacing
- ✅ Fast-path handler — `bridge/fast-path.mjs` skips the LLM on time / timer / sleep / map / greetings, ~500ms end-to-end vs ~2s

---

---

## Current session — agentic capabilities + ops fixes (2026-05-06)

### Shipped this session

- ✅ **Pluggable LLM providers** — `bridge/llm/providers.mjs` unifies Anthropic / OpenAI / Ollama under one `chat()` call. Routing by workload (default / vision / highstakes). Env-driven keys.
- ✅ **`open_url` tool** — fast no-API-cost path for "show me a map of X". Hard-validates http(s).
- ✅ **`request_browse` tool** — Playwright + Claude/GPT vision inner loop. URL denylist (banks, gov, brokers), prompt-injection guard, action allowlist (click/type/scroll/wait/navigate/done), refuses to type card-shaped strings.
- ✅ **`enter_sleep_mode` tool** — voice "shut down" / "go to sleep" mutes mic, dims speedo via `state.sleep` broadcast.
- ✅ **Purchase rails (Patches A/B/C/D)** — `bridge/purchases.mjs` with budget caps + allowlist + tiered confirmation + append-only journal. Typed-confirm modal in HUD for £25–30. macOS Keychain card vault (`bridge/cards.mjs` + `tools/register-card.sh`). Argos UK adapter scaffolded (selectors stubbed).
- ✅ **Speed knobs** — `launch.sh` sets `OLLAMA_NUM_PARALLEL=1`, `FLASH_ATTENTION=1`, `KV_CACHE_TYPE=q8_0`, `KEEP_ALIVE=24h`, `MAX_LOADED_MODELS=2` via launchctl. `.env` carries `OLLAMA_KEEP_ALIVE=24h` and `OLLAMA_FAST_MODEL=qwen2.5:3b`. Operator must quit + relaunch Ollama once for the launchctl vars to take effect.
- ✅ **Location-lookup bug** — `lockLocation: true` in config.json was short-circuiting auto-detect. Fixed: defaulted false, force-flag added to `autoDetectLocation`, `/config/redetect` always forces + persists.
- ✅ **`./launch.sh stop` UX** — now closes the Chrome HUD app-mode window AND prints "nothing to stop" when ports already free.
- ✅ **Capture One + Lightroom** removed from launcher panel per Adam's request.
- ✅ **Weather icon onerror fallback** — failed loads fall back to `cloudy.svg` and log the failed name.
- ✅ **`models` array in `package.json`** — `tools/update.sh` will auto-pull `qwen2.5:3b` for Adam.
- ✅ **Ultra tier patched in install.sh** — was 32b/32b (crashed M5 Max GPU), now 14b/7b matching max tier.
- ✅ **Skip VL pre-warm at boot** — `bridge/warmup.mjs` now defers qwen2.5vl:7b to first vision call. Override with `WARMUP_VL=1`. Boot log shows `VL deferred to first call`.
- ✅ **3-stage cascade router classifier hop** — `bridge/model-router.mjs` exposes `pickAsync()` with a 3b SIMPLE/COMPLEX hop on top of the existing regex/length heuristics. 600ms timeout, falls back to heuristics on failure.
- ✅ **Stale 32b references in docs** — `README.md`, `SECURITY.md`, `PLAN.md` updated to reflect 14b + 3b + 7b VL stack.
- ✅ **Personal-assistant tool quartet** — `bridge/personal.mjs` ships `send_imessage` (voice-gated), `add_reminder`, `set_timer` / `list_timers` / `cancel_timer` (in-HUD countdown badge + Kokoro fire announcement + Web Audio beep), `play_music` / `pause_music` (Music + Spotify via osascript). All zero-API-cost.
- ✅ **HUD audit panel for purchase journal** — Shift+Cmd+J opens a dedicated Agent Console modal with scrollable journal (newest first), running totals, daily/weekly cap reminder. Pulls from `/purchases/audit?limit=50`.
- ✅ **HUD API-key entry UI** — same Agent Console modal. Fields for Anthropic + OpenAI keys (masked display when set, never returned in clear by bridge), plus three workload routing dropdowns (default / vision / highstakes). POSTs to `/api-keys` which now allowlists `anthropic|openai|ollama` for routing values.
- ✅ **`models` array in `package.json`** — `tools/update.sh` will auto-pull `qwen2.5:3b` for Adam alongside the existing models.

- ✅ **Wider personal-assistant tools shipped** (`bridge/personal.mjs`):
  - `read_article({url})` — fetch + clean HTML extraction (article / main / body), 12k char cap, returns title + text for the LLM to summarise
  - `take_screenshot({region})` — `screencapture` for screen / window / selection. Saves to `data/screenshots/`. Detects operator-cancelled interactive captures.
  - `set_focus({mode, until})` — invokes a `Focus On <mode>` Shortcut. Clear setup error if the Shortcut doesn't exist
  - `lookup_password({label, field})` — 1Password CLI `op item get`. **Confirmation-gated**. Detects missing `op`, expired session, ambiguous matches
  - `compose_note({title, body, app})` — Apple Notes (osascript) / Bear (x-callback-url) / Obsidian (URI handler)
- ✅ **`update.sh` ships clear post-update operator instructions** — colour-coded numbered list covering: HUD refresh, macOS automation prompts, voice-command examples, the new Shift+Cmd+J shortcut, log paths, rollback options
- ✅ **`update.sh` auto-restarts Ollama** — quits the menu-bar Ollama.app, waits for the daemon to exit, relaunches, polls `:11434` until ready. Only thing the operator has to do manually is approve macOS Automation prompts on first use of the new tools.

### Outstanding from this session — deferred / not safe to ship blind

- 🟧 **Argos / Amazon UK / MPB checkout form-fill** — three adapter scaffolds shipped (search → product pick → basket cap-check), checkout-step click-by-click intentionally stubbed. Each needs one-off Playwright codegen on a real logged-in session so the form selectors are verified against the live DOM. Bot-detection severity: Argos low, MPB low, Amazon medium (captchas + interstitials).
- 🟨 **`set_lights({scene, room})`** — Philips Hue API integration. Skipped because it needs per-install Hue bridge IP + bridge user token, plus the operator may not have Hue at all. Add when there's a known target setup.

### Shipped after the first commit pair

- ✅ **Category-tiered spending caps** — replaced flat per-tx cap with category-specific limits. Photography £1500/tx, electronics £300, travel £500, groceries £50, takeaway £40, default £75. Plus per-category daily/weekly/monthly + a global cross-category daily ceiling of £2000.
- ✅ **Expanded merchant allowlist** — 25 UK retailers across 8 categories: groceries (Tesco/Sainsbury's/Ocado/Waitrose), takeaway (Uber Eats/Deliveroo/Just Eat), electronics (Currys/AO), photography (WEX/Park Cameras/MPB/Calumet), homeware (John Lewis/IKEA/Wayfair), travel (Skyscanner/Kayak/Booking/Trainline/National Rail), office (Ryman/Viking), default (Amazon/Argos).
- ✅ **`search_products` tool** — uses request_browse to compare options on a merchant without buying. Returns shortlist; operator picks; LLM follows up with request_purchase. Lets the operator say "find me a 50mm prime under £400" without committing.
- ✅ **`find_flights` tool** — drives Skyscanner search via request_browse. Read-only — does NOT book. Operator goes to airline directly via open_url after picking.
- ✅ **`learn_visual_style` tool** (`bridge/visual-style.mjs`) — folder OR list of paths, both stills AND videos. ffmpeg samples 4 keyframes per video file. Vision LLM produces structured prose (palette/lighting/contrast/framing/grading/mood) alongside the existing numerical signature. Stored in style-memory's edit_styles table.

### Shipped after the autonomy expansion

- ✅ **Embedding-based tool router** (`bridge/tool-router.mjs`) — at 97 tools the full TOOLS array was too much context for qwen2.5:14b's tool-selector. Now: each tool's `name + description + param-names` embedded via `nomic-embed-text` at boot (1.5s, persisted to `data/tool-index.json`, hash-invalidated on TOOLS change). Per query, embed the operator's utterance, cosine-rank the catalogue, pass top-20 + 10 always-on tools (recall, web_search, open_url, enter_sleep_mode, etc) to Ollama. Wired into both `askLLM` (non-streaming) and `askLLMStream`. Resolved once per query so all hops share the same filtered set.
- ✅ **`/health` exposes index status** — `toolRouter: { ready, toolCount, hash, alwaysOn }`. The Agent Console will surface this in a future patch.

### What's needed for video-style learning to work end-to-end

- The local `qwen2.5vl:7b` can ingest the extracted keyframes but produces less-detailed prose than Claude / GPT-4o. For best results, set `LLM_PROVIDER_VISION=anthropic` (or `openai`) in the Agent Console — falls back to Ollama silently if no key is set.
- Adam needs `ffmpeg` on PATH (already required by Jarvis for video editing — should already be there via Homebrew).

---

## Architectural debt to clear before P1

🟥 ⚙️ **voice.js extraction** (~2 days)
File is at 2,400 LOC and growing. Before notifications + history + palette + multi-profile pile in, split into:
- `bridge-client.js` — WebSocket + pending-reply tracking
- `tts.js` — Kokoro client + sanitiser + Web Audio playback
- `state.js` — `setState` + speedo + camera + storage
- `modal-queue.js` — `queueModal` + showVideo / showPdf / showThumbnail
Touches: voice.js (split), index.html (new module imports). No behaviour change; pure refactor.

🟧 ⚙️ **Action manifest** (~1 day)
Voice tool registry + command palette + help cheat-sheet + audit log filters all need the same source of truth. Generate `config/actions.json` from the bridge's tool schemas at boot. Locks the contract before P1.4 (palette).

🟧 ⚙️ **Universal `runId` audit** (~half day)
P0.1 added `runId` to four heavy tools. Audit every other `broadcastToClients` callsite — `pdf.complete`, `yt.thumbnail.complete`, `inbox.dropped`, `diary.refresh` — and standardise the envelope `{type, runId?, ts, data}` per the architect's lock-in.

---

## P1 — Operator productivity (week 3-5 of the original plan)

🟥 **P1.1 Notification queue** (~2 days)
Replace the `queueModal` one-at-a-time pattern with a real queue surface. Bell icon top-right, scrollable history of recent terminal task states. Hard dep on P0.1 task model. *Agency win: when a teaser, PDF, and email-draft all complete in 30 seconds, the operator gets a coherent timeline instead of three modals fighting for focus.*

🟥 **P1.2 Conversation history drawer** (~1.5 days)
`conversationHistory` already exists in memory; persist it. Slide-out from the right edge (H key or swipe up from bottom). Per-turn timestamps + which tools fired. Hidden in demo mode. *Agency win: "what did I tell you about Ben's preferences yesterday?" gets answered by the operator scrolling, not by a recall query.*

🟧 **P1.3 Demo / Clean mode toggle** (~half day)
Single Cmd+D flips a body class. Hides: debug panel, transcript bubble, system-pod exact %s (show pretty bars only), notification timestamps, conversation drawer, REC indicator. Auto-clears inbox prompts. *Agency win: client walks into the studio, operator hits Cmd+D, kiosk goes from operational to cinematic in 100ms.*

🟧 **P1.4 Command palette (Cmd+K)** (~2 days)
Keyboard fallback for everything voice does, plus dev affordances. Pulls actions from the manifest above. Recent-commands and suggested-next in the picker. *Agency win: noisy production office, Daniel's voice can't reach the mic, operator types "press release press-car goodwood" instead of shouting.*

🟧 **P1.5 Help / onboarding HUD** (~1 day)
First-run beyond setup: a "what to say" cheat panel pinned for first 60s of first session, dismissible. Reads from action manifest. Idle nudges every 10 minutes ("try saying 'cut a teaser from the latest shoot'"). *Agency win: junior staff or visiting clients get instant proficiency.*

---

## P2 — Enterprise (week 6-10)

🟧 **P2.1 Multi-operator profiles** (~3 days)
LocalStorage namespace prep is done (P0.5). Modal: profile picker on lock-screen. Each profile carries voice/colour/tier/launchers + own `clientId` for the audit log. *Agency win: lead photographer, editor, MD all use the kiosk; settings + memory + voice stay personal.*

🟧 **P2.2 Audit log view** (~2 days)
Hard dep on P1.1 + P2.1. Bridge writes `data/audit/YYYY-MM.jsonl` append-only with `{ts, operator, tool, args, result, runId}`. HUD reads via paged `/audit` route. Searchable. *Agency win: "who sent that draft to the client?" is answerable. Compliance / retention story for the agency.*

🟨 **P2.3 Undo** (~3 days, scoped)
Only meaningful for destructive tools (`expire_usage_rights`, `revoke_rights`, file moves, label changes). Inverse-action recipes recorded by the audit log. Don't try to undo renders or sends. *Agency win: voice "scratch that" + toast undo prevent the 30-second-after-send "wait no" panic.*

🟧 **P2.4 Project context switcher** (~4 days)
Right rail becomes "ACTIVE PROJECTS" — cards for the most-recent 3 shoot folders, click to scope all subsequent voice commands. `find_frame` defaults to the active project's folder, generated PDFs auto-fill `client`, recent conversations filter to that project. *Agency win: this is the missing axis for "I'm working on the press car campaign" — the agency's actual mental model.*

---

## P3 — Polish & scale (opportunistic)

🟨 **Per-profile theming** (~1 day) — each operator's brand colour persists per session
🟩 **Keyboard navigation pass** (~1 day) — skip-links, focus rings, ARIA polish
🟩 **Reduced motion / high contrast / font scale toggles** (~1 day) — accessibility chrome for visitors
🟩 **Tablet/iPad responsive variant** (~2-3 days) — operator's iPad mirrors HUD when away from desk
🟩 **Cost / usage telemetry** (~1 day) — queries today, tokens, model swap suggestions
🟩 **Layout customisation** (~3 days) — drag panels to reposition, save per-profile

---

## Workstream B follow-ups (speedo expressiveness)

🟨 **Wake-flick on detected wake word** (~half day)
The `flick` mood exists but isn't wired. Hook the wake-word detector → `__speedo.flash("flick")` → quick 0→40 acknowledgement before transitioning to `listening`. *Agency win: visible "I heard you" beat before the listening state — even before audio confirms.*

🟩 **Speedo idle recovery after error** (~2 hours)
`amber-drop` returns to `idle` after 1.5s. Verify it doesn't get stuck if a fresh task starts mid-amber. Add a guard.

---

## Borrowed ideas worth implementing

### From comparison research (Jarvis-themed repos)

🟥 🚀 **Embedding-based tool router + planner** (~2-3 days, isair pattern)
At ~30 tools we're approaching context-rot. Filter the tool catalogue per query using the existing nomic-embed index, then have a small pre-pass decompose multi-step requests into an ordered task list. *Single highest-leverage borrow from the field.*

🟧 **Transparent plan stage** (~1.5 days, microsoft/JARVIS pattern)
Surface the LLM's intended tool calls in a panel BEFORE firing them. Operator can interrupt before a 90-second video render starts on a misheard command. Pairs naturally with the speedo's `thinking-climb` mood — the panel slides in while the needle climbs.

🟨 **MCP server support** (~3-5 days)
isair speaks MCP; we don't. Adding it lets us cheaply integrate Home Assistant / GitHub / Notion / Linear. The bridge adopts MCP-server protocol; existing tools surface as MCP tools.

### From novel-assistants research

🟥 🚀 **Accessibility-tree primitive** (~half day, the architectural lesson)
`read_active_window()` + `read_recent_changes(seconds)` tools that consume macOS `AXUIElement` trees. Cheaper, faster, more accurate than vision for app-aware queries. Once it exists:
- "What's open in Premiere right now?" — reads the timeline + clip names
- "What was on screen 30 seconds ago?" — diff over cached tree
- Scenario detection — load only Premiere-relevant tools when Premiere is foreground
*Single highest-leverage technical move on the list.*

🟧 🚀 **Memory Dream Cycle** (~1-2 days, Thoth pattern)
Nightly job over `data/memory.db`:
- Merge Levenshtein-near contacts (already detected, never collapsed)
- Decay confidence on facts not referenced in N days
- Ask Qwen to infer one new relation per cluster (`Ben Collins` works at `the manufacturer`, both tagged with `the hero` → infer `Ben is the press car project lead`)
*Memory sharpens instead of bloating.*

🟨 🚀 **Sentence-level TTS streaming + barge-in** (~weekend, parlor pattern)
Currently Kokoro waits for full Qwen output before speaking. Stream sentence-by-sentence; let operator interrupt mid-utterance. Cuts perceived latency in half. Pairs with VAD on the wake mic.

🟨 **Lane-grouped progress viz** (~1-2 days, CoWork-OS pattern)
Our video pipeline already has stages: scan → segment → encode → concat → final. Render them as parallel lanes in the task strip with live ffmpeg tail. Bonus for client demos: they watch the work happen.

🟨 **Containerised render environment** (~3-5 days, bytebot pattern)
Spawn a Docker container per video job with ffmpeg + ImageMagick + exiftool pre-baked. `run_shell` allowlist becomes obsolete — the container IS the sandbox. Concurrent renders no longer fight over `output/`.

🟩 **Scenario engine** (~1 day, DearVa pattern, requires accessibility tree first)
Detect active app + current state and load only the relevant tools into Qwen's context. Premiere → editing tools. Mail → drafting tools. Frame.io → review tools. Tool-calling accuracy jumps.

---

## agency-specific workflow wins

These don't appear in any reference repo because they're agency-specific. Each one is a clean tool addition that drops into an existing operator command.

🟥 🚀 **Auto-cull a shoot folder** (~1 day)
"Cull today's shoot" → Vision compares all stills, groups near-duplicates, picks the sharpest of each group, marks the rest as "skip" via `flag_shot`. Operator reviews the keepers. *Saves 30-60 minutes of manual culling per shoot.*

🟥 🚀 **Brand-pack auto-export** (~1 day)
Given a hero shot: generate watermarked + non-watermarked variants in 16:9 / 9:16 / 1:1 / 4:5, with brand boilerplate frame and a delivery zip. *One voice command replaces 8 minutes of manual exports per hero.*

🟧 🚀 **Live shoot mode** (~1 week, was Phase 5 in original plan)
Phone-as-mic walks the studio. Real-time captioning per shot. "Flag this as hero" works as the photographer is mid-frame. Contact sheet ready by lunch. *Transforms the workflow not just the surface.*

🟧 🚀 **Manufacturer media-day calendar** (~2 days)
Web-scrape the manufacturer / McLaren / Bentley press calendars + cache locally. "What's coming up at Goodwood?" gets a real answer. Surfaces pitch opportunities. *Replaces the "I think the client has something in July" guesswork.*

🟧 🚀 **Pre-shoot kit checklist** (~1 day)
Voice: "kit check for tomorrow's Bentley shoot" → reads project brief, vehicle type, location weather, generates checklist (lenses by focal need, batteries by camera count, lighting by indoor/outdoor, comms by crew count). PDF to phone. *Eliminates the "did we pack the wide?" pre-shoot panic.*

🟨 🚀 **Editorial style memory from past  the agency edits** (~3 days)
Feed last 20 hero edits into Vision + Qwen. Extract grading preferences (warm-cool bias, contrast curve, saturation). When the operator says "match the  the agency look", apply learned preferences as Lumetri starting values. *Captures Marcus's grading signature so junior editors hit it on first attempt.*

🟨 🚀 **EOD activity digest** (~1 day)
Daily summary email at 18:00 — renders shipped, PDFs generated, contacts added, Frame.io reviews completed, hours spent. *Replaces the "what did I do today" ten minutes at the end of every day.*

🟨 🚀 **Multi-machine sync of memory** (~3-5 days)
Periodic backup of `data/memory.db` to a NAS or shared encrypted folder. Operator A's contacts available on operator B's kiosk. *Agency knowledge becomes shared, not personal.*

🟩 🚀 **Press-cycle radar** (~3 days)
Daily web search across Top Gear / Autocar / Carwow + manufacturer press pages for "new launch" / "embargoed". When something pops, surface as a pitch opportunity in the COMMS panel. *Agency wins by being the first to call.*

---

## Integrations — open-source / no paid licence required

The agency doesn't run DaVinci Resolve or Capture One, so anything gated behind those (or behind Remotion's company licence) is out. The integrations below all work with the agency's actual stack: Premiere + Lightroom + Frame.io + ffmpeg + canvas.

### Skip / don't invest

🟩 **Remotion** — paid for companies >3 employees ($100-500/mo). Drop. Keep the canvas + ffmpeg filtergraph pipeline; if iteration speed becomes painful, revisit MLT below.
🟩 **Capture One scripting** —  the agency doesn't run Capture One. Tethering is via Lightroom or direct-to-card. Drop the AppleScript hook idea.
🟩 **DaVinci Resolve Python bridge / FCPXML round-trip** —  the agency edits in Premiere; nobody's grading in Resolve. Drop.
🟩 **`pymiere` (Premiere Python wrapper)** — unmaintained, relies on dying ExtendScript. Stay on UXP.
🟩 **CEP / ExtendScript for new work** — September 2026 EOL. Existing scripts fine until then; don't add more.
🟩 **After Effects scripting** — still ExtendScript-only, UXP "planned" with no date. AE is mostly avoidable for our pipeline.
🟩 **Adobe Audition automation** — ExtendScript only, no useful CLI. ffmpeg + NLE-side render covers our needs.
🟩 **Lightroom Classic Lua plugin** — overkill for our use. Continue with XMP sidecars (already shipped) — the most robust integration anyway.
🟩 **Lightroom CC / mobile sync API** — invite-only / enterprise. Not available.
🟩 **Final Cut Pro Workflow Extensions** — macOS-only, Swift + Xcode + App Store distribution. Heavy lift unless  the agency has FCP editors.

### Worth knowing about, not urgent

🟨 **Frame.io V4 official TypeScript SDK** (`@frameio/api` on npm) — replace our hand-rolled REST client. Saves writing types. ~half day.

🟨 **Lightroom catalogue read-only via SQLite** (~half day) — `.lrcat` files are just SQLite. Power feature for "find me…" voice commands ("every 5-star photo of a shoot from 2025"). No plugin install needed — read-only is safe.

🟨 **MLT framework** — open-source (LGPL) clip-based composition engine behind Kdenlive/Shotcut. `melt` CLI renders `.mlt` XML timelines. Better than ffmpeg filtergraphs for clip-based composition. Worth a look if the canvas + ffmpeg pipeline starts feeling brittle.

---

## Sources from the research pass

[Premiere UXP API](https://developer.adobe.com/premiere-pro/uxp/) · [Premiere Pro Scripting Guide (community)](https://ppro-scripting.docsforadobe.dev/) · [Frame.io V4 dev site](https://developer.adobe.com/frameio) · [Frame.io V4 TS SDK](https://next.developer.frame.io/platform/docs/sdk-reference/type-script-sdk-reference) · [Lightroom Classic SDK](https://developer.adobe.com/lightroom-classic/) · [MLT framework](https://www.mltframework.org/docs/buildscripts/)

---

## Quality-of-life

🟨 **Onboarding for fresh M5 Max install** — `./install.sh` + `setup-wizard.mjs` + `install-daemon.sh` flow tested on a clean machine
🟨 **Bridge restart resilience** — currentVideoRun / Tasks state survive a bridge restart mid-render (PID file + recovery path)
🟨 **Frame caching budget** — `data/frame-cache/` grows unboundedly; add LRU eviction at 5GB
🟨 **Embeddings model version pin** — `nomic-embed-text` updates would invalidate stored embeddings; record model + version with each embedding row
🟩 **HUD performance baseline** — measure FPS budget on M1 Max vs target M5 Max; document tier overrides
🟩 **Brand white-label install path** — currently FOM-tinted in many places; verify `setup-wizard.mjs --non-interactive` cleans every Jarvis string

---

## Documentation

🟥 **Hand-over document with screenshots** — full visual walkthrough of installation + setup for visual learners. Cover: clone repo → install.sh → setup-wizard.mjs (each prompt with a screenshot) → first launch → wake-word setup → quick wins (drop a shoot folder, ask for a teaser). Should let a non-technical operator install on a fresh M-series Mac in under 30 minutes without hand-holding.
🟨 **Operator manual** — voice command cheat-sheet, error recovery, "when to call us"
🟨 **PLAN.md update** — current state vs original phase plan; what shipped vs what's pending
🟨 **CHANGELOG.md** — running record of features by month
🟩 **CLAUDE.md** at project root — guide for future AI sessions on the codebase's conventions

---

## How to read this list

Priorities are based on **impact for  the agency specifically**, not generic engineering value. The 🚀 items move the agency's daily work forward; the ⚙️ items keep the codebase from collapsing under its own weight as we scale.

### Two perspectives on "what next"

**Codebase-health route** — keeps the kiosk shippable as it grows:
1. **🟥 ⚙️ voice.js extraction** — without it P1 work piles into one unrefactorable file
2. **🟥 ⚙️ Action manifest** — locks the contract before palette + help + audit log all need it
3. **🟥 🚀 Embedding-based tool router** — the substance gap with isair/jarvis; unlocks growth past 30 tools

**Agency-impact route** — biggest weekly time-savers for FOM:
1. **🟥 🚀 Auto-cull a shoot folder** — 30-60 min saved per shoot, builds on existing Vision + flag_shot
2. **🟥 🚀 Brand-pack auto-export** — replaces 8 minutes of manual exports per hero shot
3. **🟧 🚀 Live shoot mode (phone-as-mic)** — flag heroes mid-frame, contact sheet ready by lunch

### Recommended sequence

The four open-source items left to ship, in order of complexity (smallest → largest):
1. **Sentence-level TTS streaming + barge-in** (~1-2 days) — perceived-latency win, smallest scope
2. **MCP server support** (~3-5 days) — opens Home Assistant / GitHub / Notion integrations
3. **Containerised render env** (~3-5 days) — Docker per video job; concurrent renders stop fighting over `output/`
4. **Live shoot mode** (~1 week) — phone-as-mic walks the studio

