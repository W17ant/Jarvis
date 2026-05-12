---
layout: ../layouts/Layout.astro
title: Troubleshooting
active: /troubleshooting
---

# Troubleshooting

Quick fixes for the issues that come up. If nothing here works, run `./tools/diagnose.sh` and attach the resulting tarball to a [GitHub issue](https://github.com/W17ANT/Jarvis/issues).

## "Bridge offline" toast

The HUD's WebSocket can't reach `localhost:8766`.

```bash
./launch.sh status     # what's running on which port?
./launch.sh restart    # nuke + restart all four services
tail /tmp/jarvis-bridge.log
```

Common causes:

- The bridge crashed at boot. Check `/tmp/jarvis-bridge.log` — usually a port conflict or a missing `.env` value.
- Ollama isn't running. `ollama serve` starts it; the bridge tolerates Ollama being down but voice commands will fail.
- Your firewall is blocking localhost. Unusual but happens with Little Snitch — allow `node` on `:8766`.

## STT / Whisper not online

The status pip in the calendar strip stays amber for `whisper`.

- Whisper needs Python 3.11. `python3.11 --version` should print `3.11.x`. If it points at 3.12, the MLX wheel won't load.
- The first launch downloads the MLX `large-v3-turbo` model (~1.5 GB). On slow connections this can take a few minutes; the pip stays amber until the first successful transcript.
- Reinstall: `cd bridge && rm -rf .venv && python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt`.

## TTS / Kokoro silent

The voice loop completes but no audio plays.

- Check `/tmp/jarvis-kokoro.log` for ONNX runtime errors. The Kokoro voice file lives at `bridge/kokoro_voices/<voice-id>.bin`; missing voices fall back silently to `bm_daniel` only if it exists.
- Confirm `~/Library/Audio/...` permissions — macOS sometimes prompts on first run.
- Browser autoplay policy blocks audio until the user has interacted with the page once. Click anywhere on the HUD before testing.

## Wake word not firing

- VAD threshold may be too low (mic picking up ambient noise constantly) or too high (genuine speech ignored). Open Settings and watch the live mic-level meter — the threshold mark should sit just above your room's idle level. Default `0.02` works for a quiet office; bump to `0.04` in a louder room.
- Kokoro's wake-word detector is regex-based on the Whisper transcript. Settings → Brand identity → "wake mishears" lets you add common Whisper mistranscriptions ("jervis", "jarviz", "hi jarvis").

## CPU/GPU temps show as `—`

`macmon` isn't installed or isn't on PATH.

```bash
brew install vladkens/tap/macmon
which macmon
./launch.sh restart
```

The HUD shows a one-time toast at startup if macmon is missing. The kiosk works without it — temps just stay blank.

## LLM "key invalid" toast

You've added an Anthropic / OpenAI key but it's wrong or revoked.

- Open Settings → API keys, paste the corrected key, save. The bridge picks it up without a restart.
- If you don't want cloud LLMs at all, leave both fields blank and set every routing slot to **Ollama** in Settings → LLM provider routing.

## Chrome window won't open

`./launch.sh` reports the static server is up but no Chrome appears.

- Chrome's `--app` mode requires Chrome to be installed. Brave, Arc, and Chromium also work. Set `BROWSER=brave` (or `chromium`) in `.env`.
- On a multi-monitor setup, Chrome may have remembered an off-screen window position. Close any dangling Chrome instances and re-launch.

## Diagnostic bundle

```bash
./tools/diagnose.sh
```

Drops a tarball on your Desktop with logs, system snapshot, brand config, plugin manifests, and last 7 days of session telemetry. **No `.env` and no `data/memory.db`** — safe to attach to a GitHub issue.

The Settings → Diagnostics panel has the same export button if you'd rather click than terminal.
