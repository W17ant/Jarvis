# Flat-Out HUD — Outstanding Work

Living todo list. Everything discussed in our planning sessions that hasn't shipped yet. FOM-flavoured throughout — items are sequenced for an automotive PR/content agency's daily workflow, not generic kiosk polish.

**Legend**: 🟥 critical · 🟧 high · 🟨 medium · 🟩 low · ⚙️ architecture · 🚀 FOM workflow win

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
Replace the `queueModal` one-at-a-time pattern with a real queue surface. Bell icon top-right, scrollable history of recent terminal task states. Hard dep on P0.1 task model. *FOM win: when a teaser, PDF, and email-draft all complete in 30 seconds, the operator gets a coherent timeline instead of three modals fighting for focus.*

🟥 **P1.2 Conversation history drawer** (~1.5 days)
`conversationHistory` already exists in memory; persist it. Slide-out from the right edge (H key or swipe up from bottom). Per-turn timestamps + which tools fired. Hidden in demo mode. *FOM win: "what did I tell you about Ben's preferences yesterday?" gets answered by the operator scrolling, not by a recall query.*

🟧 **P1.3 Demo / Clean mode toggle** (~half day)
Single Cmd+D flips a body class. Hides: debug panel, transcript bubble, system-pod exact %s (show pretty bars only), notification timestamps, conversation drawer, REC indicator. Auto-clears inbox prompts. *FOM win: client walks into the studio, operator hits Cmd+D, kiosk goes from operational to cinematic in 100ms.*

🟧 **P1.4 Command palette (Cmd+K)** (~2 days)
Keyboard fallback for everything voice does, plus dev affordances. Pulls actions from the manifest above. Recent-commands and suggested-next in the picker. *FOM win: noisy production office, Daniel's voice can't reach the mic, operator types "press release press-car goodwood" instead of shouting.*

🟧 **P1.5 Help / onboarding HUD** (~1 day)
First-run beyond setup: a "what to say" cheat panel pinned for first 60s of first session, dismissible. Reads from action manifest. Idle nudges every 10 minutes ("try saying 'cut a teaser from the latest shoot'"). *FOM win: junior staff or visiting clients get instant proficiency.*

---

## P2 — Enterprise (week 6-10)

🟧 **P2.1 Multi-operator profiles** (~3 days)
LocalStorage namespace prep is done (P0.5). Modal: profile picker on lock-screen. Each profile carries voice/colour/tier/launchers + own `clientId` for the audit log. *FOM win: lead photographer, editor, MD all use the kiosk; settings + memory + voice stay personal.*

🟧 **P2.2 Audit log view** (~2 days)
Hard dep on P1.1 + P2.1. Bridge writes `data/audit/YYYY-MM.jsonl` append-only with `{ts, operator, tool, args, result, runId}`. HUD reads via paged `/audit` route. Searchable. *FOM win: "who sent that draft to the client?" is answerable. Compliance / retention story for the agency.*

🟨 **P2.3 Undo** (~3 days, scoped)
Only meaningful for destructive tools (`expire_usage_rights`, `revoke_rights`, file moves, label changes). Inverse-action recipes recorded by the audit log. Don't try to undo renders or sends. *FOM win: voice "scratch that" + toast undo prevent the 30-second-after-send "wait no" panic.*

🟧 **P2.4 Project context switcher** (~4 days)
Right rail becomes "ACTIVE PROJECTS" — cards for the most-recent 3 shoot folders, click to scope all subsequent voice commands. `find_frame` defaults to the active project's folder, generated PDFs auto-fill `client`, recent conversations filter to that project. *FOM win: this is the missing axis for "I'm working on the press car campaign" — the agency's actual mental model.*

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
The `flick` mood exists but isn't wired. Hook the wake-word detector → `__speedo.flash("flick")` → quick 0→40 acknowledgement before transitioning to `listening`. *FOM win: visible "I heard you" beat before the listening state — even before audio confirms.*

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

## FOM-specific workflow wins

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

🟨 🚀 **Editorial style memory from past FOM edits** (~3 days)
Feed last 20 hero edits into Vision + Qwen. Extract grading preferences (warm-cool bias, contrast curve, saturation). When the operator says "match the FOM look", apply learned preferences as Lumetri starting values. *Captures Marcus's grading signature so junior editors hit it on first attempt.*

🟨 🚀 **EOD activity digest** (~1 day)
Daily summary email at 18:00 — renders shipped, PDFs generated, contacts added, Frame.io reviews completed, hours spent. *Replaces the "what did I do today" ten minutes at the end of every day.*

🟨 🚀 **Multi-machine sync of memory** (~3-5 days)
Periodic backup of `data/memory.db` to a NAS or shared encrypted folder. Operator A's contacts available on operator B's kiosk. *Agency knowledge becomes shared, not personal.*

🟩 🚀 **Press-cycle radar** (~3 days)
Daily web search across Top Gear / Autocar / Carwow + manufacturer press pages for "new launch" / "embargoed". When something pops, surface as a pitch opportunity in the COMMS panel. *Agency wins by being the first to call.*

---

## Integrations — open-source / no paid licence required

FOM doesn't run DaVinci Resolve or Capture One, so anything gated behind those (or behind Remotion's company licence) is out. The integrations below all work with the agency's actual stack: Premiere + Lightroom + Frame.io + ffmpeg + canvas.

### Skip / don't invest

🟩 **Remotion** — paid for companies >3 employees ($100-500/mo). Drop. Keep the canvas + ffmpeg filtergraph pipeline; if iteration speed becomes painful, revisit MLT below.
🟩 **Capture One scripting** — FOM doesn't run Capture One. Tethering is via Lightroom or direct-to-card. Drop the AppleScript hook idea.
🟩 **DaVinci Resolve Python bridge / FCPXML round-trip** — FOM edits in Premiere; nobody's grading in Resolve. Drop.
🟩 **`pymiere` (Premiere Python wrapper)** — unmaintained, relies on dying ExtendScript. Stay on UXP.
🟩 **CEP / ExtendScript for new work** — September 2026 EOL. Existing scripts fine until then; don't add more.
🟩 **After Effects scripting** — still ExtendScript-only, UXP "planned" with no date. AE is mostly avoidable for our pipeline.
🟩 **Adobe Audition automation** — ExtendScript only, no useful CLI. ffmpeg + NLE-side render covers our needs.
🟩 **Lightroom Classic Lua plugin** — overkill for our use. Continue with XMP sidecars (already shipped) — the most robust integration anyway.
🟩 **Lightroom CC / mobile sync API** — invite-only / enterprise. Not available.
🟩 **Final Cut Pro Workflow Extensions** — macOS-only, Swift + Xcode + App Store distribution. Heavy lift unless FOM has FCP editors.

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
🟩 **Brand white-label install path** — currently FOM-tinted in many places; verify `setup-wizard.mjs --non-interactive` cleans every Flat-Out string

---

## Documentation

🟥 **Hand-over document with screenshots** — full visual walkthrough of installation + setup for visual learners. Cover: clone repo → install.sh → setup-wizard.mjs (each prompt with a screenshot) → first launch → wake-word setup → quick wins (drop a shoot folder, ask for a teaser). Should let a non-technical operator install on a fresh M-series Mac in under 30 minutes without hand-holding.
🟨 **Operator manual** — voice command cheat-sheet, error recovery, "when to call us"
🟨 **PLAN.md update** — current state vs original phase plan; what shipped vs what's pending
🟨 **CHANGELOG.md** — running record of features by month
🟩 **CLAUDE.md** at project root — guide for future AI sessions on the codebase's conventions

---

## How to read this list

Priorities are based on **impact for FOM specifically**, not generic engineering value. The 🚀 items move the agency's daily work forward; the ⚙️ items keep the codebase from collapsing under its own weight as we scale.

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

