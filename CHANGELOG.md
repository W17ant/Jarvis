# Changelog

Running record of features shipped to the Jarvis HUD kiosk. Newest first.

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
