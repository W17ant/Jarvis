# Jarvis — Project Plan

A branded AI voice assistant + HUD for **Jarvis AI** (automotive PR & video agency, Leicester UK). Killer feature for  the agency specifically: voice-driven cinematic video editing pipeline — *"Jarvis, give me a 30-second the client teaser from yesterday's shoot"*.

---

## Current state (2026-05) — what's actually shipped

The plan below is the original phase breakdown from project kickoff. The codebase has moved well past Phase 0 and large sections of Phases 1-5 are now live. This block documents reality vs the plan.

### Shipped + working

**Voice loop (was Phase 1):** Local-only voice loop running on Ollama (Qwen 2.5 14B / 32B configurable per hardware tier) + Whisper STT + Kokoro TTS — no isair/jarvis fork. Wake-phrase `hey jarvis` with mishear variants. Sentence-level TTS streaming with mic-RMS barge-in detection (first audio in ~1s instead of waiting for the full reply). Bridge owns the WebSocket pubsub + tool dispatch.

**HUD overlay (was Phase 2):** Vanilla HTML/CSS/JS kiosk app loaded directly in Chrome via `./launch.sh kiosk` (no Electron / Tauri wrapper — the kiosk runs full-screen in Chrome's `--app` mode and that's enough for the deployment model). White-label brand config at `config/brand.json`, per-profile theming, editable widget layout (Cmd+L), tablet/iPad responsive variants, transparent plan-stage panel, demo mode (Cmd+D), command palette (Cmd+K), conversation history drawer (H), audit overlay, usage telemetry overlay, settings modal with folder configuration.

**Agency tool integrations (was Phase 3):** 76+ tools registered. Apple Mail (read summary, draft never-auto-send), Apple Calendar (events + add), web search (DuckDuckGo HTML), filesystem (under sandboxed shoots/output roots), Frame.io V4 review/comment workflow, Adobe Premiere ExtendScript via osascript (open project, import folder, create sequence, render). MCP server endpoint at `POST /mcp` exposes every tool to Claude Desktop / Cursor / Continue.

**Video pipeline (was Phase 4):** Local-only — no DaVinci, no Capture One, no Remotion (all dropped, see "Dropped" below). Canvas + ffmpeg + ImageMagick build the agency-branded teasers, YouTube thumbnails, YouTube shorts, brand-pack zip exports, contact sheets, watermarked variants, multi-aspect crops. Vision via local Qwen 2.5-VL captions + finds frames + scores clips. Optional containerised render env (`docker/render/Dockerfile`) for reproducible binary versions across operator Macs (`RENDER_USE_DOCKER=1`).

**Voice quality (was Phase 5):** Kokoro local TTS, British male voice (`bm_daniel`) default. Voice-cloning explicitly out — operator finds it "weird" (durable feedback memory). Voice picker in settings exposes the Kokoro voice library.

**Install + handoff (was Phase 6):** `install.sh` + `setup-wizard.mjs` + `install-daemon.sh` + Tailscale opt-in flow. Setup wizard handles agent name, wake phrase, voice, agency name, tagline, colours, logo, hardware tier (model auto-pick per chip family), API keys (FAL/Frame.io/SerpAPI/Hunter), and shoots/output folder roots. Per-installer brand reload via `POST /brand`.

**Beyond-original scope:** persistent memory (SQLite) with contacts / projects / facts / conversation summaries + nightly Dream Cycle hygiene; embedding-based tool router; accessibility-tree introspection (`bridge/window.mjs`); auto-cull duplicate stills; brand-pack export; pre-shoot kit checklist; EOD activity digest; multi-machine memory sync; press-cycle radar; manufacturer media-day calendar; editorial style memory; live shoot mode (phone-as-mic); audit log + undo recipes; cache pruning at 5GB cap.

### Dropped (originally in the plan but removed)

- **DaVinci Resolve Python bridge** —  the agency edits in Premiere; nobody's grading in Resolve. Whole video pipeline rebuilt around canvas + ffmpeg instead.
- **Capture One scripting** —  the agency doesn't run Capture One. Tethering goes through Lightroom or direct-to-card. AppleScript hook idea shelved.
- **Remotion** — paid licence at >3 employees ($100-500/mo). Branded graphics stay in the canvas + ffmpeg overlay filtergraph pipeline; if iteration speed becomes painful the LGPL MLT framework is the documented backup.
- **isair/jarvis fork** — bridge is a from-scratch Node.js server. Borrowed concepts (embedding tool router, MCP support) but not the codebase.
- **ElevenLabs cloud TTS** — Kokoro local proved good enough for the brand voice.
- **Voice cloning (F5-TTS / ElevenLabs Pro)** — operator finds it weird. Off-the-shelf voices only.
- **Adobe CC bundling via UXP** — current Premiere integration uses ExtendScript via osascript, not UXP. UXP is on the roadmap if/when ExtendScript gets EOL'd in 2026-09.
- **Electron / Tauri wrapper** — Chrome `--app` mode covers the kiosk requirement without the build / signing / update overhead.

### Still pending (small)

- Operator manual + handover document with screenshots (TODO.md flagged 🟥).
- Brand white-label install path verification on a fresh Mac (verify `setup-wizard.mjs --non-interactive` cleans every Jarvis string).
- HUD performance baseline measurement on M1 Max vs target M5 Max.
- Embeddings model version pin (record nomic-embed model + version with each row to invalidate on upgrade).
- CLAUDE.md at project root for future AI sessions on the codebase's conventions.

The bulk of Phase 1-6 plus several never-planned wins are live. The remaining items are documentation polish + verification, not feature work.

---

## Phase 0 — Sandbox (DONE)

`/Users/Antony/Desktop/Jarvis/` — browser-based HUD prototype.

- Brand-true: Oswald + Rubik fonts (extracted from jarvismedia.org), `#00d4ff` arc-reactor cyan + `#0077a8` deep,  the agency dial + wordmark assets in `assets/`.
- Centerpiece: animated 0–200 speedometer with red-zone, ticks, numerals, breathing needle,  the agency dial layered behind, "FLAT/OUT" core mark.
- Live UK clock, calendar strip, weather panel, comms feed, launch panel, telemetry waveform, fake live system stats.
- Voice demo: Web Speech API picks up "Jarvis" wake word, canned replies, system TTS, speedo state lights up (listening / thinking / speaking).
- Fullscreen: press `F`, double-click speedo, or run `./launch.sh` (Chrome `--app` mode, no browser chrome) / `./launch.sh kiosk`.
- Real verbatim  the agency phrases used: *"we live and breathe automotive"*, *"stepping your automotive business up a gear"*.

Purpose: visual proof-of-concept for the client meeting. Not the deliverable.

---

## Phase 1 — Live Voice Brain (1 week)

Wire the HUD to a real LLM running locally on the M1 Max.

- Install Ollama + pull `qwen2.5:14b` (main reasoning) and `qwen2.5:3b` (cascade router for chatty queries). 32b was tried for "showpiece" quality but pegged GPU on M5 Max and was retired.
- Install isair/jarvis as the voice loop framework (already prebuilt for macOS arm64).
- Replace canned `cannedReply()` in `voice.js` with calls to local jarvis backend.
- Fork isair/jarvis to broadcast state events (`listening`/`thinking`/`speaking`/`tool-running`) over a local websocket — HUD subscribes and lights the speedo accordingly.
- Confirm tool-calling reliability at 14B before deciding final model.

**Deliverable:** end-to-end voice demo on the M1 Max, no canned answers.

---

## Phase 2 — Branded HUD Overlay (2 weeks)

Wrap the HUD as a transparent desktop overlay, replace browser entirely.

- **Electron** (or **Tauri** for smaller binary) wrapper.
- Transparent always-on-top window option, multi-monitor aware.
- Hide/show toggle, position memory, configurable opacity.
- Replace Web Speech API with native mic input (better quality, no Chrome dependency).
- Bundle Ollama + jarvis + HUD into a single installable `.app`.
- Code-sign for macOS (Apple Developer ID required — client supplies or we register on their behalf, ~£99/year).

**Deliverable:** double-clickable Mac app that runs the full HUD on top of (or instead of) the desktop.

---

## Phase 3 — Agency Tool Integrations (1–2 weeks)

What the assistant can actually *do*. MCP server per integration so each is isolated.

- **Mail** — Apple Mail / Outlook AppleScript wrapper (read counts, summarise unread, draft reply for approval — never auto-send).
- **Calendar** — Apple Calendar / Google Calendar (today/week, create event from voice).
- **Music** — Spotify Web API (play playlists, control transport).
- **Capture One** — AppleScript scripting for retouch queue inspection, session opens.
- **Adobe CC** — UXP scripts for Premiere/Photoshop ("open today's project", "export 1080p H.264").
- **agency DAM** — depends on what they actually use (Capture One Cultural Heritage, NetX, Bynder, custom?). Discovery question.
- **Filesystem** — read/list/move within designated  the agency project folders. No deletes without confirmation.
- **Web search** — DuckDuckGo / Brave (already built into jarvis).

**Deliverable:** 6–8 working voice commands covering daily agency flow.

---

## Phase 4 — Cinematic Video Pipeline (4–6 weeks) ← the value driver

Voice-driven AI video editing tailored to automotive content. **This is what justifies the project economically for a media agency.**

### 4a. Image-to-Video via Fal.ai

Static car photos → cinematic motion clips for social/editorial.

- **Fal.ai integration** as a primary tool — pay-per-use, no monthly lock-in, single API across multiple model providers.
- Models to wire up:
  - **Kling 2.1 Master** — best realism for automotive subjects (~$0.35/clip)
  - **Veo 3** — photorealistic with native audio (~$0.50/clip)
  - **Luma Dream Machine** — fastest cinematic camera moves (~$0.30/clip)
  - **Runway Gen-3 Turbo** — short-form fast iteration (~$0.05/sec)
  - **Wan 2.2** — open-weights fallback for sensitive client work
- LLM picks the right model based on prompt + cost target, builds the motion prompt ("slow cinematic dolly from grille to driver window, golden hour, shallow DOF"), calls Fal, gets back MP4.
- Output drops into a watch-folder Premiere/Resolve picks up.
- Voice flow: *"Jarvis, animate yesterday's hero shot of the DBX, slow orbit, 4 seconds"* → done in ~30s.

### 4b. Voice-Driven Rough Cuts

- **DaVinci Resolve Studio** integration — Python scripting API, called from jarvis tool layer.
- Resolve's Neural Engine: scene cut detection, smart reframe, auto color match across angles, voice isolation.
- LLM picks beat-synced cut points (call out to a small audio analysis script for BPM/transient detection).
- Apply the agency's signature LUT/grade automatically (we extract their look from a reference reel during discovery).
- Smart-reframe to deliver 9:16 / 1:1 / 16:9 from one master.
- Voice flow: *"30-second teaser from yesterday's the client, vertical, beat-synced"* → 60-second turnaround for a rough cut.

### 4c. Adobe Premiere/Photoshop Automation

- **Premiere via UXP** — Sensei AI (auto rough-cut, auto-reframe, enhanced speech, generative extend).
- **Photoshop via UXP** — batch retouch, generative fill on car shots.
- **Adobe Firefly Video** for clip extension when shots run short.

### 4d. Smart Asset Search

- Embedding the DAM (clip metadata + visual thumbnails) into a local vector DB (Qdrant or sqlite-vss).
- Voice flow: *"Find me all green car shots from 2024 with low-angle hero framing"* → semantic search returns matches.
- Auto-tagging on ingest using a vision model (Qwen2.5-VL or GPT-4o for cost vs latency tradeoff).

### 4e. Brand-Consistent Output

- "agency editorial style" encoded as a rules pack: cold-open with engine sound, mid-build, hero shot at 60% mark, logo close on red blade.
- Built during discovery by sitting with their lead editor, watching them work, abstracting decisions.
- Versioned — they can tweak the style, the LLM picks up the new rules immediately.

**Deliverable:** A genuinely market-leading capability for an agency this size. Pitch to client: *"Cuts the time-to-rough-cut on every social deliverable from 2 hours to 5 minutes."*

---

## Phase 5 — Voice Quality (1 week)

The single biggest gap between TikTok demos and a credible client install.

**Pick one path:**

- **Local-only:** Kokoro-82M (free, Apache 2.0, runs on CPU) or Orpheus 3B (better, needs ~6GB VRAM). Sounds "decent audiobook narrator", not Hollywood.
- **Cloud-hybrid:** ElevenLabs (~£20/month, sounds genuinely human, handles emotion and unusual words). Privacy tradeoff is theatre — only the response text leaves the building, never their files. **Strong recommendation for a client-facing showpiece.**
- **Voice clone:** F5-TTS or ElevenLabs Pro — clone one of the agency's people so "Jarvis" sounds like an actual member of the team. Distinctive and on-brand. Adds ~1 week.

**Deliverable:** A voice that doesn't sound like a 2010 GPS.

---

## Phase 6 — Install + Training + Handoff (1 week)

- Install on the agency's actual machine (we'll spec it during discovery — 64GB+ M-series Mac strongly recommended).
- Setup wizard for non-technical staff.
- Two training sessions: (1) lead editor on the video pipeline, (2) general staff on voice commands + admin.
- Documentation: command cheatsheet, troubleshooting guide, "when to call us" matrix.
- Maintenance contract: Ollama updates, model upgrades, OS compat (macOS 27 will land mid-cycle), bug fixes. Suggested: ~£200/month retainer or per-incident.

**Deliverable:** A running install at the agency's Leicester office, trained staff, support agreement.

---

## Stack Decisions

| Layer | Choice | Why |
|---|---|---|
| LLM | Qwen 2.5 14B (start) → 32B (ship) | Best tool-calling per param; fits comfortably on M1 Max 64GB |
| Voice loop | isair/jarvis (forked) | Mature, prebuilt mac binary, MCP support, active project |
| ASR | Whisper medium (.en) | Built into jarvis, GPU-accelerated on Apple Silicon |
| TTS | ElevenLabs (recommended) / Kokoro (fallback) | See Phase 5 |
| Wake word | "Jarvis" anywhere in sentence | jarvis's intent judge handles this natively |
| Wrapper | Electron (or Tauri for smaller) | Transparent overlay, multi-monitor, code-signable |
| Image-to-video | Fal.ai (pay-per-use) | Single API for Kling/Veo/Luma/Runway, no monthly lock-in |
| NLE | DaVinci Resolve Studio (they have it) | Python scriptable, neural engine, free upgrade for them |
| Photo/Video | Adobe CC (they have it) | UXP scripting, Sensei AI, Firefly |
| Memory | jarvis built-in (knowledge graph) | Already self-organising, auto-redacts sensitive info |
| MCP servers | Per-integration (Mail, CC, Resolve, Fal, DAM) | Isolated, swappable, future-proof |

---

## Hardware

- **M1 Max 64GB**: confirmed sufficient for 32B local model + Whisper + TTS + HUD overlay simultaneously. No upgrade needed.
- **If client wants a dedicated machine**: M4 Max 64GB Studio (~£3k) — 2x the bandwidth of M1 Max, can run 70B models comfortably for "actually impressive" tier.
- **Display**: Single 27"+ for desk install, 32" 4K for reception showpiece. Multi-monitor supported in Phase 2 wrapper.

---

## Discovery Questions Still Outstanding

Before final scope/quote, need from FOM:

1. **Where does it live?** Reception showpiece, lead editor's desk, or both?
2. **Which DAM?** Capture One Cultural Heritage / NetX / Bynder / shared drive / something else?
3. **Email client?** Apple Mail, Outlook, web Gmail?
4. **Their signature look** — give us 3 example reels they consider "definitively FOM" so we can encode the editorial style.
5. **Voice clone yes/no** — happy for an AI voice based on a real team member?
6. **Privacy red lines** — anything that absolutely cannot leave the building? (Determines local-only vs hybrid choices.)
7. **Budget envelope + timeline expectation.**

---

## Timeline (estimated)

| Phase | Duration | Cumulative |
|---|---|---|
| 0 — Sandbox | done | — |
| 1 — Live voice brain | 1 wk | 1 wk |
| 2 — HUD overlay | 2 wks | 3 wks |
| 3 — Tool integrations | 1–2 wks | 4–5 wks |
| 4 — Video pipeline | 4–6 wks | 8–11 wks |
| 5 — Voice quality | 1 wk | 9–12 wks |
| 6 — Install + handoff | 1 wk | 10–13 wks |

Realistic full project: **~3 months** for a polished, production install. Phase 0+1 alone (visual demo + working voice) could be ready in ~10 days for an early client preview.

---

## Budget Reality

| Tier | What you get | Rough range |
|---|---|---|
| **Demo-only** | Phase 0 sandbox polished + delivered | £1.5–3k |
| **Voice MVP** | Phases 0–2: HUD overlay + working voice on their Mac | £6–9k |
| **Full agency assistant** | Phases 0–3 + Phase 5: voice loop + tool integrations + good TTS, no video | £10–14k |
| **Full incl. video pipeline** | Everything | £15–25k |
| **Ongoing** | Maintenance retainer | £200/mo or per-incident |

These are working ranges, not quotes. Real number depends on discovery answers.

---

## Risks

- **macOS 27 lands mid-build** — Apple's annual cycle hits in autumn 2026, could break dictation again ([already broke once on 26.4.1](https://github.com/isair/jarvis/issues/172)).
- **Resolve API quirks** — the Python API is not perfectly documented; expect 1–2 days of figuring out edge cases.
- **DAM integration unknown** — until we know what they use, can't fully scope Phase 3.
- **Tool-calling regressions on smaller models** — if 14B isn't reliable enough for video commands, we're forced to 32B which doubles RAM headroom requirements.
- **Voice misfires in noisy office** — Phase 1 needs to test wake-word detection in real environmental noise.
- **Fal.ai pricing variability** — model prices change; build a cost ceiling per request into the tool layer.

---

## Right Now — Outstanding on Phase 0

Small visual polish remaining on the sandbox:

-  the agency logo currently a watermark — bring it back to prominent (per recent client direction).
- Verify wake button repositioning didn't introduce overlap with the calendar dates.
- Stress-test voice demo in noisy environment before client meeting.

Once Phase 0 is signed off, discovery doc goes to client → quote → Phase 1 starts.
