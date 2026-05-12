---
layout: ../layouts/Layout.astro
title: Privacy
active: /privacy
---

# Privacy

Jarvis is local-first by design. This document is the explicit, auditable answer to the question *"what does Jarvis send off-device?"*

## TL;DR

**Nothing leaves your machine without your explicit, per-action consent.**

- No analytics SDK.
- No metrics endpoint.
- No telemetry server.
- No "anonymous usage data" toggle that's actually opted-in by default.

The only paths off-device are ones the operator triggers themselves.

## What's local-only (always)

| Data | Where it lives |
|---|---|
| Voice transcripts | Whisper on `localhost:8768`, never sent anywhere else |
| LLM context + replies | Ollama on `localhost:11434` for local models, see "External LLM providers" below for cloud |
| Conversation history | `data/memory.db` (SQLite) on this machine |
| Tool audit log | `data/audit/YYYY-MM.jsonl` on this machine |
| Session metrics (latency / wakes / queries) | `data/audit/sessions/YYYY-MM-DD.jsonl` on this machine |
| Brand config | `config/brand.json` on this machine |
| API keys | `.env` on this machine |
| Knowledge base (your docs) | `docs/knowledge/` on this machine, indexed in `data/memory.db` |
| Plugin code | `bridge/plugins/` on this machine |

None of these touch the network unless the operator explicitly invokes a tool that does.

## What goes off-device — and only when

Three categories of outbound traffic exist. All three are operator-initiated.

### 1. Tools you call that hit the internet

When you say "search the web for X", `web_search` makes a request to a search provider (default: SerpAPI if configured, else falls back to a public Open-Meteo / DuckDuckGo path). When you say "open mail.com", a Chromium browser navigates there. When you say "draft email to X", the bridge talks to your local Mail.app via AppleScript — no network in that case.

The audit log records every such call. The operator can review it at any time:

```bash
tail data/audit/$(date +%Y-%m).jsonl
```

### 2. External LLM providers (only when configured)

If you've added an `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` via the settings panel and configured one of the routing slots (chat / vision / high-stakes) to use a cloud provider, queries that hit that workload go to that provider's API. This is opt-in: by default, every workload routes to local Ollama.

What the cloud provider sees: the query text + relevant tool definitions + the conversation context. What they DON'T see: anything you didn't include in the query (memory, audit log, knowledge base content unless that turn referenced it).

To stay 100% local: don't add cloud keys. Default routing stays on Ollama.

### 3. Diagnostic ZIPs (manual, by you)

The settings panel has an *Export diagnostic* button. When clicked it runs `tools/diagnose.sh` which bundles:

- `/tmp/jarvis-*.log` (bridge / Kokoro / Whisper / static server logs)
- `config/brand.json`
- `bridge/plugins/*/manifest.json` (manifests only — never plugin source code)
- `data/audit/sessions/` (last 7 days of session metrics)
- A snapshot of `/health/timings`, `/health/sessions`, `/health/plugins`
- macOS / chip / Node version info

The bundle drops on your Desktop. **Nothing is sent automatically.** The operator chooses whether to email it (the script optionally opens a Mail.app draft addressed to the maintainer; the operator still has to hit Send).

What the bundle does NOT contain:
- `.env` (API keys, secrets)
- `data/memory.db` (your conversation history)
- `data/audit/YYYY-MM.jsonl` (full tool dispatch log)
- Knowledge base contents

If you want to share a richer bundle, you can attach those manually — but the default has the privacy-leaning subset.

## Audit trail

Every tool dispatch is logged to `data/audit/YYYY-MM.jsonl` with timestamp, tool name, args, result snippet (truncated to 4KB), error, runId, and durationMs. This is the operator's source of truth for "did Jarvis do anything I didn't want?" — grep / cat / less it like any plain text log.

The audit log is local, append-only, never sent anywhere by Jarvis itself.

## Voice telemetry

When the latency-debug panel is open (Shift+Cmd+P), the HUD posts `performance.mark()` summaries to `/perf` after every voice turn. The bridge writes a sanitised row to `data/audit/sessions/YYYY-MM-DD.jsonl`:

```json
{"ts":1715210400000,"heard":"hey jarvis what time is it","voiceToWhisperMs":420,"whisperInferenceMs":210,"voiceToAudioMs":1100,"error":null}
```

Note: only the heard text + latency spans. No tool args, no LLM reply, no system metadata beyond the spans. The diagnostic ZIP bundles these rows; nothing else exports them.

## How to verify

The trust-but-verify path: read the bridge source.

- `bridge/server.mjs` — every HTTP / WebSocket endpoint. Search for `fetch(` to find every outbound network call.
- `bridge/sessions.mjs` — the session telemetry writer. Confirm it's `appendFile` + nothing else.
- `bridge/llm/providers.mjs` — provider router. Confirm Anthropic / OpenAI calls are gated behind explicit env vars.
- `tools/diagnose.sh` — the bundle composition. Confirm it never auto-emails, only opens a draft.

The codebase is MIT — fork it, audit it, host it yourself. There's no separate hosted service watching what you do.

## What we don't promise

- **Network-level privacy from your ISP / OS.** Jarvis runs on your Mac; macOS itself sends some telemetry to Apple if you haven't disabled it. Ollama similarly may check for updates. These are out of Jarvis's control.
- **Privacy from cloud LLM providers** when you opt-in to one. Read their terms. Anthropic and OpenAI both publish data-retention policies.
- **Privacy from people with physical access to your Mac.** `data/memory.db` is plain SQLite, `.env` is plaintext. Use FileVault.

## Reporting privacy issues

If you find anything that contradicts this doc — a network call that isn't operator-initiated, a leak through the audit log, anything that touches `.env` — file an issue at <https://github.com/W17ant/Jarvis/issues> with the **privacy** label. Privacy bugs are top-priority.
