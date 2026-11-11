# Jarvis

[![Version](https://img.shields.io/badge/version-0.3.0-00d4ff?style=flat-square)](CHANGELOG.md)
[![CI](https://github.com/W17ANT/Jarvis/actions/workflows/ci.yml/badge.svg)](https://github.com/W17ANT/Jarvis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-00d4ff?style=flat-square)](LICENSE)
[![Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-0077a8?style=flat-square&logo=apple&logoColor=white)](https://en.wikipedia.org/wiki/Apple_silicon)
[![Local-first](https://img.shields.io/badge/runtime-local%20first-00d4ff?style=flat-square)](docs/privacy.md)
[![Tests](https://img.shields.io/badge/tests-205%20%E2%9C%93-5fd97a?style=flat-square)](https://github.com/W17ANT/Jarvis/actions/workflows/ci.yml)

**A voice-first AI assistant with an instrument-cluster HUD.**
*Local LLM. Real CPU/GPU temps. Kiosk-mode. White-label.*

> Iron Man's interface, your Mac's brain. MIT.

```
              ╦  ╔═╗ ╦═╗ ╦  ╦ ╦ ╔═╗
              ║  ╠═╣ ╠╦╝ ╚╗╔╝ ║ ╚═╗
              ╩  ╩ ╩ ╩╚═  ╚╝  ╩ ╚═╝
```

[**Quickstart →**](https://aoneill.co.uk/arc/quickstart/) · [**White-label install →**](docs/install-for-clients.md) · [**Privacy →**](docs/privacy.md) · [**76+ tools →**](docs/tool-reference.md) · [**Plugin authoring →**](docs/plugin-authoring.md) · [**Vision & roadmap →**](docs/vision-and-roadmap.md)

**Built by [Antony O'Neill](https://www.linkedin.com/in/antonyoneilladl/) · [aoneill.co.uk](https://aoneill.co.uk) · MIT licensed**

---

## What it is

A complete on-prem voice-first AI workstation for Apple Silicon. Wake it with your custom phrase. It listens, thinks, talks back, and runs tools — all without a cloud round-trip by default. The HUD looks like an arc-reactor instrument cluster on a 27"+ display: real CPU/GPU temps via [macmon](https://github.com/vladkens/macmon), live mic waveform centerpiece, paired core-telemetry dials, and a transcript drawer that surfaces every tool the agent ran.

White-label by design — every brand string, colour, and wake phrase lives in `config/brand.json`. Hot-load plugins drop into `bridge/plugins/<name>/`. 76+ voice-callable tools categorised across communication / productivity / creative / system / memory.

Whisper STT → Ollama LLM → Kokoro TTS pipeline. Default config: nothing leaves your Mac.

---

## How this is different

There are several "voice-first AI for Mac" projects in the wild. Most are cloud-first wrappers — your voice → Anthropic → cloud TTS → back to you. They're fast and demo-friendly because rented intelligence is fast. They're also unsuitable for anyone whose data can't legally / contractually go through Anthropic.

This one is the opposite trade:

| | Cloud-first AI assistants | This kiosk |
|---|---|---|
| Brain | Cloud LLM (Anthropic / OpenAI) | Local Ollama (default qwen2.5:7b) |
| STT | Cloud (Web Speech API) | Local MLX Whisper |
| TTS | Cloud (Fish Audio / ElevenLabs) | Local Kokoro |
| API keys required | Yes (~$10-50/mo per operator) | None |
| Workspace scope (per-context personas, scoped memory + audit) | No | Yes — ship Workspaces v0-v4 |
| White-label | Hardcoded brand | `config/brand.json` rebrands the whole HUD |
| Plugin scaffolding | Fork the codebase | Voice command → `build_plugin` → working plugin in 500ms |
| MCP server | No | Yes — every tool exposed to Claude Desktop / Cursor |
| Apple Silicon telemetry | Decorative | Real CPU/GPU temps via macmon |
| First-time-up cost | $0 + ~30 min install | $0 + ~30 min install |
| Per-month cost | $10-50 (API) | $0 |

If you want the fastest possible voice loop and don't care about who sees your data, the cloud-first projects are excellent. If you're a lawyer / accountant / consultant / journalist / clinician / regulated-business owner who cannot put client data through Anthropic, this one is for you.

---

## ✨ What it can do

| | |
|---|---|
| **Voice loop** | Wake on *"hey Jarvis"*. Sentence-level streaming TTS — first audio in your ear in ~1s. Mic-RMS barge-in cancels mid-sentence. Filler phrases ("On it.") cover LLM thinking time. |
| **Vision** | Qwen 2.5-VL captions images, describes screens, OCRs documents. *"What does this whiteboard say?"* |
| **Apple Mail / Calendar** | Summarise unread, draft emails (never auto-sent), add calendar events. Reminders fire 15 min + 5 min before each event. |
| **Code agent** | `code_agent_run` spins a sandboxed Claude / Qwen worker — edits files, runs tests, commits. Background tasks surface in the HUD as a queue you can voice-cancel. |
| **Persistent memory** | SQLite + embeddings (nomic-embed-text). Contacts, projects, facts, conversation summaries. Recall across sessions. Nightly Dream Cycle dedupes near-duplicate entries. |
| **Knowledge base** | Drop markdown / PDF / docx into `docs/knowledge/`. Hybrid retrieval (vector + BM25 RRF) with source citations on every reply. Ask any question that might be in your docs and get the receipts. |
| **Document generation** | PDF (templated), DOCX, XLSX, PPTX. Pipe data → polished deliverables. |
| **YouTube creative** | Thumbnails (1280×720), shorts (9:16), promo packs — vision picks hero frames + engine inlays automatically. |
| **Social captions** | Multi-platform caption drafts (Instagram / LinkedIn / TikTok) with hashtag research and brand-tone validation. |
| **MCP server** | Every bridge tool exposed via JSON-RPC at `POST /mcp`. Drive the same kiosk from Claude Desktop, Cursor, Continue. |
| **Agentic purchases** | Pre-funded virtual debit card via macOS Keychain. Category-tiered caps. UK retailer allowlist. Auto/voice/typed confirmation tiers. Append-only audit journal. Simulator-mode default. |
| **Pluggable LLM providers** | Anthropic / OpenAI / local Ollama all behind one `chat()` call. Workload routing — default chat to Ollama, vision to Claude, high-stakes to Claude. Live token + cost telemetry in the Agent Console so spend never surprises. |
| **Embedding tool router** | At 60 tools the full catalogue overwhelms the 7b selector. nomic-embed-text indexes each tool at boot; per-query the catalogue is filtered to top-20 + 10 always-on. Live transparency in the Agent Console shows which tools the model actually saw. |
| **Web-use loop** | `request_browse` drives a real Chromium with Playwright + a vision LLM — clicks, types, scrolls, reads. URL denylist (banks, gov, brokers), prompt-injection guard, action allowlist. Use for "find the cheapest X", "summarise this page", "fill this form for me". |
| **Conversation history** | Every turn persisted to SQLite. Right-edge slide-out drawer (`H` key) shows everything searchable across sessions, with tool chips per row. |
| **Personal-assistant tools** | iMessage, Apple Reminders, in-HUD timers, Apple Music / Spotify, Apple Notes / Bear / Obsidian, Mozilla Readability article fetch, screencapture, macOS Focus mode, 1Password CLI lookup. Zero-API-cost daily-life primitives via osascript. |
| **Video transcription** | `transcribe_video` strips audio with ffmpeg → local Whisper for timestamped speech segments → samples N keyframes → vision LLM captions each one. Returns interleaved narrative. |
| **White-label brand** | Every brand string, color, font, and wake phrase lives in `config/brand.json`. The setup wizard re-skins the entire HUD without code changes. `.brand-lock` + `update.sh` guard prevent silent rebrands. |

### Keyboard shortcuts

- `?` — searchable command cheat sheet (every tool, with confirmation/always-on flags)
- `H` — conversation history drawer
- `Shift+Cmd+J` — Agent Console (LLM keys + workload routing + tool router live picks + LLM usage rollup + purchase audit log)
- `Shift+Cmd+D` — demo / clean mode (hides numeric readouts, REC indicator, timestamps for client visits)
- `Shift+Cmd+M` / `+C` / `+T` — accessibility: reduced-motion / high-contrast / bigger-text
- `Esc` — closes any open modal / drawer; mid-task = cancel the active browse / caption batch

---

## 🚀 Install (M-series Mac, ~30 minutes)

**Prerequisites:** macOS 14+, Apple Silicon (M1/M2/M3/M4/M5), 64 GB+ RAM recommended (32 GB works on a smaller model tier), Homebrew. Internet for the initial Ollama model pull.

```bash
git clone https://github.com/W17ANT/Jarvis.git
cd Jarvis
./install.sh
```

The installer pulls Ollama, the Qwen 2.5 + Qwen 2.5-VL models, sets up Whisper + Kokoro Python venvs, and pins ffmpeg / ImageMagick / exiftool via Homebrew.

**You must then run the setup wizard manually** — the kiosk needs `config/brand.json` to start cleanly. If `install.sh` offers to auto-launch the wizard at the end, accept; otherwise (e.g. on a re-install where `config/brand.json` already exists) run it yourself:

```bash
node tools/setup-wizard.mjs
```

The wizard asks for:
- Agent name + wake phrase + voice (any of Kokoro's 50+ voices)
- Agency name, tagline, brand colours, logo
- Hardware tier (auto-picks model sizes that fit your chip — all M-series Maxes get qwen2.5:14b text + qwen2.5vl:7b vision, smaller chips drop to 7b/3b. The previous 32b/32b combo crashed M5 Max GPUs and was retired)
- Optional API keys (Frame.io for review workflow, SerpAPI for press radar, Hunter.io for outreach)
- Shoots + output folder roots (point at a NAS / external SSD if you want)

Done. **Launch the kiosk** (also a manual step — `install.sh` does not start it for you):

```bash
./launch.sh kiosk         # full-screen kiosk mode
./launch.sh                # windowed test
./launch.sh restart       # kill all services and start fresh
./launch.sh stop          # stop everything
```

The HUD opens in Chrome's `--app` mode (no browser chrome). Say "hey [agent name]" and start working.

---

## 🎨 Creative style guide (your CLAUDE.md)

`config/creative-style.md` is the agency house style — editorial voice, words you use vs avoid, edit pacing, visual preferences. The bridge reads it on every message and applies it to every generated draft (email, caption, press release, video brief).

```bash
cp config/creative-style.example.md config/creative-style.md
open -e config/creative-style.md   # edit in TextEdit
```

The example template is opinionated — copy, then tweak. Changes take effect on the next message; no bridge restart needed. The settings panel in the HUD also exposes a textarea for editing it on-screen.

---

## 🔄 Update from upstream

Made changes to the repo? Pull them onto a deployed kiosk with one command:

```bash
./tools/update.sh           # full update
./tools/update.sh --check   # dry run — show what would change
```

Backs up `memory.db`, stashes any local edits, `git pull --ff-only`, `npm install`, rebuilds native bindings, refreshes Python deps, pulls any new Ollama models declared in `package.json`, then restarts the launchd agent (or warns if it isn't installed).

---

## 🆘 Something broken? Send a diagnostic

```bash
./tools/diagnose.sh
```

Bundles every relevant log (`/tmp/jarvis-*.log`), a system snapshot (Mac model, RAM, Node version, healthz output, port bindings), and `config/brand.json` into a tarball on your Desktop. On macOS it also opens a pre-filled Mail draft to **Antony@aoneill.co.uk** with the bundle attached. No secrets — `.env` is excluded.

Common gotchas (full FAQ in `docs/install-guide.html` pages 11–13):

- **Mic dead?** Check System Settings → Sound → Input. If the MacBook lid is closed and you're on an external monitor, the built-in mic is disabled — use a USB mic or pair an iPhone via Continuity Camera.
- **Red bridge dot?** `./launch.sh restart` — kills every running instance and starts them fresh. Self-heals native binding mismatches automatically (Homebrew Node upgrades).
- **Bug report?** Right-click in the HUD → Inspect → Console tab → `⌘ A` → copy → paste into your email, then attach the diagnose bundle above.

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
              │  76+ tool dispatch · MCP server        │
              │  Sentence-level LLM streaming · Audit   │
              │  Tasks · Undo · Memory · Notifications  │
              └─┬──────┬──────┬──────┬──────────┘
                │      │      │      │
            Ollama  Whisper Kokoro  AppleScript
            (Qwen   (STT)   (TTS)   (Mail · Calendar
             14b +                   · Premiere · Lightroom)
             3b fast +
             7b VL)
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

- **Speech-end → first audio**: target p50 <800ms on M-series (the perceptual lag the operator feels). Sprint 11 added a per-turn instrumentation pipeline (`v.rec-end → v.audio-play` perf marks, `tools/latency-report.mjs` CLI summary, optional `?debug=latency` HUD overlay) so any regression surfaces immediately.
- **Subsequent turns**: ~300ms first-token latency with `keep_alive: 24h` and `OLLAMA_FLASH_ATTENTION=1` set via launchctl.
- **Tool routing on capable hardware**: short routing queries hit the 3b fast model (~500ms); long-form drafts + tool dispatch hit 14b. Roughly 5× faster on chat-style queries without giving up quality on writes. Embedding-based tool filter caches per-query embeddings so repeats skip the ~150-400ms `nomic-embed-text` roundtrip.
- **Pre-warm on boot**: parallel probes to Ollama (text + VL), Kokoro, Whisper hide the 2-3s cold-start tax. Whisper now warms via a background silent-clip transcribe at server boot. `/diary` cache prewarmed via one fanout call (saves ~5s on first HUD load).
- **Health-poll latency**: `/healthz` cached server-side with 1s TTL so two HUD windows don't double-fanout to Ollama/Kokoro/Whisper. `/diary` cached with 18s TTL + in-flight Promise dedup (concurrent callers share one AppleScript run).
- **Optional Docker render env** — `RENDER_USE_DOCKER=1` routes shell commands through a pinned Debian image with ffmpeg + ImageMagick + exiftool. Reproducible across operator Macs.

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
    "jarvis": {
      "url": "http://localhost:8766/mcp"
    }
  }
}
```

That's it. All 60 tools become available. Tools that require operator confirmation surface their `requires_confirmation` payload back through the host's UI.

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
npx remotion render JarvisOverview     ~/Downloads/jarvis-overview.mp4       # full install + capability tour
npx remotion render JarvisCapabilities ~/Downloads/jarvis-capabilities.mp4   # deep-dive on what it does
npx remotion render JarvisUninstall    ~/Downloads/jarvis-uninstall.mp4      # short uninstall walkthrough
npx remotion render JarvisTikTok       ~/Downloads/jarvis-tiktok.mp4         # 9:16 social cut
```

---

## 🛠️ Customise / white-label for your agency

The kiosk is brand-configurable end-to-end via `config/brand.json` + `.env`. Re-run `tools/setup-wizard.mjs` at any time to change agent name, wake phrase, brand colours, voice, hardware tier, or folders. The setup wizard rewrites `config/brand.json` and pings the running bridge at `POST /brand` to live-reload — no restart needed for the brand swap. For non-brand changes (model swap, voice swap), the settings modal in the HUD has the same controls.

---

## 📜 Licence

Jarvis is open source under MIT — fork it, brand it, ship it. The code carries no client trademarks. The original development was funded by a private commercial deployment; the white-label distribution stripped the bespoke automotive-agency tooling so the kiosk competes head-on with hosted assistants while staying fully on-device. See `LICENSE` if present.

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
