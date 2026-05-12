---
name: Bug report
about: Something is broken — voice loop, HUD, tool dispatch, install, anything.
title: '[bug] '
labels: bug
assignees: ''
---

## What happened

<!-- One sentence: what did you do, what did Jarvis do (or not do)? -->

## What you expected

<!-- Voice command? Tool? HUD widget? Be specific. -->

## Reproduction

<!-- Steps a stranger could follow on a clean install. -->

1.
2.
3.

## Diagnostic bundle

The fastest way to give us context is to attach a diagnostic ZIP. From Settings →
Diagnostics, click **Export diagnostic ZIP**, then drag the resulting file from
your Desktop into this issue.

The bundle includes: bridge logs, brand config, plugin manifests, last 7 days of
session telemetry, and live `/health/*` snapshots. It does **NOT** include `.env`
(API keys), `data/memory.db` (your conversation history), or the full audit log.

If you'd rather not attach the bundle, paste the relevant excerpt from
`/tmp/jarvis-bridge.log` here:

```
<paste log here>
```

## Environment

- **Mac model**: <!-- e.g. M2 Pro, M3 Max, M4 -->
- **macOS version**: <!-- Settings → About — e.g. 14.5 -->
- **Jarvis version**: <!-- check `package.json`'s `version` field, or `git describe --tags` -->
- **Whisper backend**: <!-- check Settings → Diagnostics for `mlx/large-v3-turbo` etc. -->
- **Default LLM**: <!-- Ollama / Anthropic / OpenAI -->

## Anything else?

<!-- Screenshots, screen recording, or anything else useful. -->
