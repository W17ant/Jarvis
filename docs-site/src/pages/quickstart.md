---
layout: ../layouts/Layout.astro
title: Quickstart
active: /quickstart
---

# Quickstart

Five minutes from `git clone` to wake-word.

## Requirements

- macOS 13+ on Apple Silicon (M1, M2, M3, or M4). Intel Macs are not supported in v1.
- 16 GB RAM minimum (32 GB recommended for the 14B Qwen variant).
- 30 GB free disk for the LLM weights and Whisper model.
- A working microphone (built-in is fine; the kiosk auto-detects).

## Install

```bash
git clone https://github.com/W17ANT/Jarvis.git
cd Jarvis
./tools/install.sh
```

The installer:

1. Installs Homebrew dependencies — `ollama`, `python3.11`, `vladkens/tap/macmon`.
2. Pulls the default Ollama models (`qwen2.5:7b` for chat, `nomic-embed-text` for retrieval).
3. Creates `data/`, `config/`, `.env` with sane defaults.
4. Runs the setup wizard for agent name + wake phrase.

## First launch

```bash
./launch.sh
```

This starts four services in the background:

- **bridge** (`:8766`) — Node WebSocket + HTTP server. Voice routing, tool dispatch, MCP endpoint.
- **static** (`:8765`) — serves `index.html` to Chrome.
- **kokoro** (`:8767`) — Python TTS server.
- **whisper** (`:8768`) — Python STT server (MLX `large-v3-turbo`).

A Chrome window opens at `http://localhost:8765` in `--app` mode. The HUD takes about 600ms to paint after the bridge reports ready.

## First voice command

Say **"hey jarvis"** (or whatever wake phrase you set). The reactor at the centre pulses cyan when listening. Try:

- *"What's the weather?"*
- *"Open mail."*
- *"What can you do?"* — opens the COMMANDS panel listing all 60+ voice-callable tools.

If nothing happens, see [Troubleshooting](/troubleshooting).

## Stop / restart

```bash
./launch.sh stop      # stops all four services
./launch.sh restart   # stops, then starts again
./launch.sh status    # what's running on which port
```

## Update

```bash
./tools/update.sh
```

Pulls the latest commits, refreshes Ollama models if the manifest changed, and respects your `.brand-lock` file (white-label installs won't lose their custom brand).

## Where do I configure things?

Press the **SETTINGS** button (top-right of the HUD) for:

- LLM provider routing (chat / vision / high-stakes — Ollama default, Anthropic / OpenAI opt-in)
- API keys (generic NAME=VALUE editor)
- Brand identity (agent name, wake phrase, colours, fonts)
- VAD threshold + live mic-level meter
- Diagnostics (last 7 days session metrics + export ZIP)

The `?` button next to SETTINGS opens the COMMANDS panel — every voice-callable tool grouped by category, with example phrasings.
