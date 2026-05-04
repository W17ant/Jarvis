# Jarvis · Flat-Out HUD

> A fully-local, voice-driven AI kiosk built for an automotive PR & content agency. Wake it. Ask it. Watch it work.

```
                     FLAT-OUT
                        MEDIA          we live and breathe automotive
```

**Built by [Antony O'Neill](https://www.linkedin.com/in/antonyoneilladl/) · [aoneill.co.uk](https://aoneill.co.uk) · [antony@aoneill.co.uk](mailto:antony@aoneill.co.uk)**

A complete on-prem AI assistant: local Qwen brain, local Whisper STT, local Kokoro TTS, no cloud round-trip for inference, no client work leaving your machine. Stark-style HUD on a 27"+ display. 76+ tools spanning vision, video editing, Premiere automation, Lightroom XMP, Frame.io review, Apple Mail / Calendar, persistent memory, MCP server, and a phone-as-mic live shoot mode.

---

## ✨ What it can do

| | |
|---|---|
| **Voice loop** | Wake on *"hey Flat-Out"*. Sentence-level streaming TTS — first audio in your ear in ~1s. Mic-RMS barge-in cancels mid-sentence. Filler phrases ("On it, sir.") cover LLM thinking time. |
| **Vision** | Qwen 2.5-VL captions every keyframe, scores clips for trailer cuts, finds shots by description. *"Find the front-grille hero on the press car."* |
| **Cinematic edits** | Voice → ffmpeg pipeline. Flash cuts, speed ramps, beat-synced cuts, brand intro / tail card, single-word stacked outro text. *"Cut a 30-second teaser of yesterday's shoot, vertical, closing card V12 BEAST."* |
| **Brand pack export** | One command → 16:9 / 9:16 / 1:1 / 4:5 crops, watermarked + clean variants, zipped for the client. |
| **Frame.io review** | List pending review, read comments, reply by voice, set status. Client-visible writes always confirm. |
| **Apple Mail / Calendar** | Summarise unread, draft emails (never auto-sent), add calendar events. Reminders fire 15 min + 5 min before each event. |
| **Premiere Pro 2025** | ExtendScript via osascript — open project, import folders, build rough cut sequences, render. |
| **Lightroom presets** | Write XMP sidecars so RAWs open with the preset already applied. No need to launch Lightroom. |
| **Persistent memory** | SQLite + embeddings (nomic-embed-text). Contacts, projects, facts, conversation summaries. Recall across sessions. Nightly Dream Cycle dedupes near-duplicate contacts. |
| **Editorial style memory** | ImageMagick-driven extraction of warm-cool bias / saturation / contrast / luminance from a folder of finished edits. *"Compare this Bentley grade to the FOM signature look."* |
| **Press radar + media-day calendar** | Daily sweep across automotive press for tracked manufacturers. Manual + auto event tracking. |
| **Live shoot mode** | Phone-as-mic companion view at `GET /live`. Photographer taps HERO mid-frame; editor at the desk sees it land in real time. |
| **MCP server** | Every bridge tool exposed via JSON-RPC at `POST /mcp`. Drive the same kiosk from Claude Desktop, Cursor, Continue. |

---

## 🚀 Install (M-series Mac, ~30 minutes)

**Prerequisites:** macOS 14+, Apple Silicon (M1/M2/M3/M4/M5), 64 GB+ RAM recommended (32 GB works on a smaller model tier), Homebrew. Internet for the initial Ollama model pull.

```bash
git clone https://github.com/W17ANT/Jarvis.git
cd Jarvis
./install.sh
```

The installer pulls Ollama, the Qwen 2.5 + Qwen 2.5-VL models, sets up Whisper + Kokoro Python venvs, and pins ffmpeg / ImageMagick / exiftool via Homebrew. Then run the wizard:

```bash
node tools/setup-wizard.mjs
```

The wizard asks for:
- Agent name + wake phrase + voice (any of Kokoro's 50+ voices)
- Agency name, tagline, brand colours, logo
- Hardware tier (auto-picks model sizes that fit your chip — M5 Max gets 32b/32b, M1 Max gets 14b/7b)
- Optional API keys (Frame.io for review workflow, SerpAPI for press radar, Hunter.io for outreach)
- Shoots + output folder roots (point at a NAS / external SSD if you want)

Done. Launch:

```bash
./launch.sh kiosk         # full-screen kiosk mode
./launch.sh                # windowed test
```

The HUD opens in Chrome's `--app` mode (no browser chrome). Say "hey [agent name]" and start working.

---

## 🧹 Uninstall

```bash
./tools/uninstall-wizard.sh              # interactive — confirms each step
./tools/uninstall-wizard.sh --yes        # auto-yes for everything except user data
./tools/uninstall-wizard.sh --purge      # wipe everything including user data + Ollama models
./tools/uninstall-wizard.sh --dry-run    # show what would happen, change nothing
```

---

## 🏗️ Architecture

```
                ┌─────────────────────────────────────────┐
                │  HUD (Chrome --app, vanilla HTML/JS)    │
                │  speedo · widgets · transcript · TUNE   │
                └──────────────────┬──────────────────────┘
                            WebSocket
                                   │
              ┌────────────────────┴────────────────────┐
              │            Bridge (Node 22)             │
              │ ─────────────────────────────────────── │
              │  76+ tool dispatch · MCP server         │
              │  Sentence-level LLM streaming · Audit   │
              │  Tasks · Undo · Memory · Notifications  │
              └─┬──────┬──────┬──────┬──────────┘
                │      │      │      │
            Ollama  Whisper Kokoro  AppleScript
            (Qwen   (STT)   (TTS)   (Mail · Calendar
             14b/                    · Premiere · Lightroom)
             32b
             VL)
```

- **HUD** — vanilla HTML/CSS/JS. No framework. 17 modules: voice loop, layout grid, plan stage, command palette, audit overlay, usage telemetry, conversation history, demo mode, profiles, notifications, etc. White-labelable via `config/brand.json`.
- **Bridge** — Node 22 server on `ws://localhost:8766`. Owns the WebSocket pubsub + tool registry. 39 modules covering Frame.io, Premiere, Lightroom, calendar, mail, vision, edit, brand-pack, watermark, contact-sheet, memory, agency, shotflag, autocull, trackday, press-radar, media-days, style-memory, paths, MCP, audit, undo, dream-cycle, daily-digest, cache-prune, container, model-router, warmup, notifications, etc.
- **Local AI** — Ollama serves Qwen 2.5 (text) + Qwen 2.5-VL (vision). Whisper Python service for STT. Kokoro Python service for TTS. All four run on `localhost`. Nothing leaves the box for inference.

---

## 🎯 Designed for an automotive content agency

The 🚀 features are agency-flavoured, not generic kiosk demos. The bridge knows about:

- **Shoots organised as `shoots/<date>-<vehicle-slug>/`** — every tool that takes a folder accepts a subject phrase, so *"the press car shoot"* resolves to the right folder via fuzzy match.
- **Brand-aligned output structure** — `output/youtube/{thumbnails,shorts}`, `output/instagram/{reels,posts}`, `output/tiktok`, `output/brand-packs`, `output/pdf`, `output/watermarked`, etc. The taxonomy is fixed; tools land in the right bucket automatically.
- **Confirmation gates on client-visible writes** — `draft_email`, `frameio_add_comment`, `frameio_set_status`, `add_calendar_event`, `apply_lightroom_preset`, `premiere_render_active_sequence`, `crop_to_portrait`, `run_shell`, `write_file`, and ten more all require explicit operator confirmation. The LLM cannot send a single email without you saying "yes".
- **Per-operator profiles** — the kiosk supports multiple operators (lead photographer, editor, MD). Each gets their own voice, brand-colour override, hardware tier, and audit-log identity.

---

## ⚡ Performance

- **Cold start to first audio**: ~1s on M5 Max (32b text model, sentence-level streaming hides cold-start)
- **Subsequent turns**: ~300ms first-token latency with `keep_alive: 30m`
- **Tool routing on capable hardware**: short routing queries hit the 14b fast model; long-form drafts hit 32b. Roughly 40-50% faster on chat-style queries without giving up quality on writes
- **Pre-warm on boot**: parallel probes to Ollama (text + VL), Kokoro, Whisper hide the 2-3s cold-start tax
- **Optional Docker render env** — `RENDER_USE_DOCKER=1` routes shell commands through a pinned Debian image with ffmpeg + ImageMagick + exiftool. Reproducible across operator Macs

---

## 🔐 Privacy + Security

- **Nothing leaves the box for inference** — Ollama / Whisper / Kokoro all run on localhost.
- **Confirmation gate** on every destructive / client-visible tool. The LLM cannot send mail, post a Frame.io comment, change a Frame.io status, render via Premiere, or apply a Lightroom preset without explicit "yes" / "go ahead" / "proceed" from the operator.
- **Sandboxed `run_shell`** — allowlist of safe binaries (ffmpeg / magick / exiftool / sips / find / awk / sed / grep / python3 / node / osascript / curl / jq, and more), denylist of dangerous patterns (`sudo`, `rm -rf`, `eval`, `dd`, `curl | bash`), cwd pinned to project root, 30s timeout, clipped stdout. Optional containerisation via Docker.
- **Audit log** — every tool dispatch with operator id + result + duration is appended to `data/audit/YYYY-MM.jsonl`. View via the HUD's `VIEW AUDIT LOG` button.
- **Path-traversal guards** — all file-system tools resolve through `paths.mjs#isWithinAllowedRoots` (PROJECT_DIR / shoots / output) and refuse anything outside.
- **Optional Tailscale opt-in** during install for remote access from your phone or another machine, without exposing the kiosk publicly.
- **Local-only by default** — no telemetry, no analytics, no remote update server. The bridge speaks only to localhost services + the explicit external APIs you opted into via `.env` (Frame.io, SerpAPI, Hunter.io). Each is independently revocable.

---

## 🔌 MCP — drive it from anywhere

Every tool is exposed via the Model Context Protocol at `POST http://localhost:8766/mcp`. To connect from Claude Desktop / Cursor / Continue:

```json
{
  "mcpServers": {
    "flatout": {
      "url": "http://localhost:8766/mcp"
    }
  }
}
```

That's it. All 76+ tools become available. Tools that require operator confirmation surface their `requires_confirmation` payload back through the host's UI.

---

## 📂 Repo layout

```
Jarvis/
├── index.html              ← HUD entry point
├── styles.css              ← brand chrome
├── voice.js                ← voice loop, mic, conversation state
├── bridge-client.js        ← WebSocket + pubsub
├── tts.js                  ← Kokoro client + sentence queue + filler pool
├── speedo.js layout.js plan.js audit.js usage.js …  ← HUD modules
├── live.html live.js       ← phone-as-mic companion
├── bridge/
│   ├── server.mjs          ← bridge HTTP + WS dispatcher
│   ├── paths.mjs           ← single source of truth for shoots / output dirs
│   ├── model-router.mjs    ← fast vs main model picker
│   ├── warmup.mjs          ← cold-start hide
│   ├── mcp.mjs             ← Model Context Protocol endpoint
│   ├── notifications.mjs   ← reminder + health scheduler
│   ├── memory.mjs          ← SQLite contacts/projects/facts + Dream Cycle
│   ├── vision.mjs          ← Qwen-VL captions, find_frame, score_clip
│   ├── edit.mjs            ← cinematic teaser pipeline
│   ├── brandpack.mjs watermark.mjs contactsheet.mjs autocull.mjs
│   ├── frameio.mjs lightroom.mjs premiere.mjs calendar.mjs mail.mjs
│   ├── shotflag.mjs trackday.mjs press-radar.mjs media-days.mjs
│   ├── style-memory.mjs    ← editorial grading signature extraction
│   └── …                   ← 39 modules total
├── remotion/               ← branded marketing/install/uninstall/social videos
├── docker/render/          ← optional containerised ffmpeg/magick env
├── tools/
│   ├── setup-wizard.mjs    ← first-run wizard
│   ├── uninstall-wizard.sh ← teardown
│   ├── install-tailscale.sh
│   ├── install-daemon.sh   ← LaunchAgent for kiosk auto-start
│   └── adhoc/              ← test fixtures
├── config/
│   ├── brand.example.json  ← white-label template
│   ├── actions.meta.json   ← tool labels + voice phrasings
│   ├── launcher.json       ← quick-launch panel entries
│   └── press-radar.json    ← tracked manufacturers + outlets
├── assets/                 ← fonts, icons, kokoro models, weather icons, brand
├── install.sh launch.sh
├── README.md PLAN.md TODO.md CHANGELOG.md DEMO.md SECURITY.md
└── .gitignore
```

---

## 🎬 Demo videos

Marketing + install videos live in `remotion/` (a small Remotion project — no licence cost for individual / ≤3-employee-company use). Render any of them:

```bash
cd remotion
npm install                                          # first run only
node scripts/generate-narration.mjs                  # synth voiceover via Kokoro (bridge must be running)
npx remotion render FlatOutOverview     ~/Downloads/flat-out-overview.mp4       # full install + capability tour
npx remotion render FlatOutCapabilities ~/Downloads/flat-out-capabilities.mp4   # deep-dive on what it does
npx remotion render FlatOutUninstall    ~/Downloads/flat-out-uninstall.mp4      # short uninstall walkthrough
npx remotion render FlatOutTikTok       ~/Downloads/flat-out-tiktok.mp4         # 9:16 social cut
```

---

## 🛠️ Customise / white-label for your agency

The kiosk is brand-configurable end-to-end via `config/brand.json` + `.env`. Re-run `tools/setup-wizard.mjs` at any time to change agent name, wake phrase, brand colours, voice, hardware tier, or folders. The setup wizard rewrites `config/brand.json` and pings the running bridge at `POST /brand` to live-reload — no restart needed for the brand swap. For non-brand changes (model swap, voice swap), the settings modal in the HUD has the same controls.

---

## 📜 Licence

This is a working delivery for a specific agency. Treat the public copy as a reference for what's possible with local-only AI assistants — fork it, learn from it, swap the brand for your own. Trademark / wordmark / logo / brand colours of "Flat-Out Media" remain owned by Flat-Out Media. The code is offered under MIT — see `LICENSE` if present.

---

## 🤝 Credits

- **Ollama** — local LLM serving
- **Qwen 2.5 + 2.5-VL** (Alibaba) — text + vision models
- **Whisper** (OpenAI) — speech-to-text
- **Kokoro 82M** (hexgrad / Apache 2.0) — text-to-speech
- **nomic-embed-text** — embeddings for semantic memory
- **better-sqlite3** — synchronous SQLite for the memory layer
- **Phosphor Icons** — UI icon set
- **Bybas weather icons** — weather panel
- **Remotion** — programmatic video composition for the marketing pieces
- **ffmpeg + ImageMagick + exiftool** — render pipeline workhorses
- **Oswald + Rubik + JetBrains Mono** (Google Fonts) — type stack
