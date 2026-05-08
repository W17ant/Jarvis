# Contributing to Jarvis

Quick guide for working on the Jarvis codebase with Claude Code.

---

## What you need

1. **Claude Code** (the CLI, not the desktop app):
   ```
   npm install -g @anthropic-ai/claude-code
   ```
   The desktop app can't edit files or run commands — it's chat only. Use the CLI.

2. **Claude Pro / Max subscription** OR an Anthropic API key. Pro/Max includes Code under your usage limits; API key bills per-token.

3. The repo cloned at `~/Desktop/Jarvis` (or wherever — adjust paths in `launch.sh` if you move it).

---

## Daily workflow

```bash
cd ~/Desktop/Jarvis

# 1. Sync with main BEFORE you start
git checkout main
git pull

# 2. Branch — always
git checkout -b adam/<short-description>
#   examples:
#     adam/fix-frameio-thumbnail
#     adam/add-mclaren-press-fast-path
#     adam/tweak-filler-phrases

# 3. Run Claude
claude
#   describe what you want, it'll edit files, run tests, etc.

# 4. Verify before pushing
npm test                  # should be green
node --check bridge/server.mjs   # syntax-check the bridge

# 5. Push + open PR
git push -u origin adam/<short-description>
gh pr create
```

Then ping Antony for review, or merge yourself if it's a small self-contained change you've tested.

---

## Commit conventions

- **Conventional commit prefixes**: `feat:`, `fix:`, `refactor:`, `perf:`, `docs:`, `test:`, `chore:`
- **NO Claude attribution.** Don't include `Co-Authored-By: Claude` lines. Just commit under your own git identity.
- **Why over what.** Explain the motivation in the body, not the diff. Reader can read the diff for "what".
- **Short title.** Under 70 chars. Body wraps at ~72.

Example:
```
fix(fast-path): catch "what's the time tomorrow"

The trailing "tomorrow" used to break the $-anchor and the query
fell through to the LLM (~2s). Now caught locally — STT + Kokoro
only, ~500ms.

Tests bumped from 58 → 60 green.
```

---

## Service map

| Service        | Port | Started by    | Stop with                | Logs                         |
|----------------|------|---------------|--------------------------|------------------------------|
| Static (HUD)   | 8765 | `./launch.sh` | `./launch.sh stop`       | `/tmp/jarvis-static.log`   |
| Bridge (Node)  | 8766 | `./launch.sh` | `./launch.sh stop`       | `/tmp/jarvis-bridge.log`   |
| Kokoro (TTS)   | 8767 | `./launch.sh` | `./launch.sh stop`       | `/tmp/jarvis-kokoro.log`   |
| Whisper (STT)  | 8768 | `./launch.sh` | `./launch.sh stop`       | `/tmp/jarvis-whisper.log`  |
| Ollama         | 11434| menu-bar app  | quit menu-bar app        | (no log file, see Console)   |

**When you change a file, what restarts?**

- HUD files (`*.js`, `*.html`, `*.css` at repo root): just refresh the browser window. Static server serves live.
- Bridge files (`bridge/*.mjs`): kill bridge PID + relaunch (`./launch.sh stop && ./launch.sh`).
- Kokoro / Whisper Python: kill PID + relaunch via `./launch.sh`.
- Tests (`test/*.test.mjs`): no restart needed — `npm test` runs them in isolation.

---

## Test commands

| What                     | Command                              | Expected duration |
|--------------------------|--------------------------------------|-------------------|
| Full unit suite          | `npm test`                           | ~150ms            |
| Watch mode               | `npm run test:watch`                 | -                 |
| Bridge syntax-check      | `node --check bridge/server.mjs`     | ~50ms             |
| HUD module syntax        | `node --check voice.js`              | ~50ms             |
| Python syntax            | `python3 -c "import ast; ast.parse(open('bridge/whisper_server.py').read())"` | instant |

Run `npm test` before every PR. CI doesn't enforce it yet but the suite is fast — no excuse.

---

## Touch with care

These have just been worked on or are sensitive — coordinate with Antony before changing:

- `bridge/server.mjs` SYSTEM prompt blocks (lines ~3025 and ~3275). Just had a refusal-loop bug fixed; tweaking these can re-introduce scope refusals.
- `bridge/llm/providers.mjs` — Ollama concurrency guard. Breaking this nukes the GPU.
- `bridge/tool-router.mjs` — embedding cache. Hash-keyed; bad changes silently invalidate the cache.
- `bridge/whisper_server.py` — MLX backend selection, cache logic.
- `tasks.js` + `bridge/server.mjs` `/cancel` endpoint — just shipped per-task UX.

**Already evaluated and rejected** — don't waste time exploring:

- **MLX-LM for the chat model.** Tested vs Ollama; Ollama wins on hot TTFT (74ms vs 133ms) because of its prefix cache. MLX wins cold start but `KEEP_ALIVE=24h` keeps weights hot.
- **Kokoro sub-sentence streaming.** Tested; Kokoro yields one chunk per sentence. No latency win there.

---

## Quick task list

Self-contained items Claude Code can ship in one session. Each has clear acceptance criteria. Pick whichever you actually want.

### Easy (under 30 min)

1. **Add a fast-path pattern.** If there's a phrasing you keep saying and Jarvis keeps routing through the LLM, add it to `bridge/fast-path.mjs`. Add tests in `test/fast-path.test.mjs`. The existing patterns are good templates.
   - Example: "open Frame.io" → `open_url` to `https://app.frame.io`
   - Example: "show today's diary" → existing tool but a fast-path can shortcut

2. **Add filler phrases.** Edit `tts.js` (`FILLERS_SHORT` / `FILLERS_LONG`) AND `bridge/kokoro_server.py` (`_CACHEABLE_PHRASES`). The two lists must stay in sync — comment in the Python file says so. New phrases get cached on first use.

3. **Tune wake-word fuzzy patterns.** If Whisper keeps mishearing "Hey Jarvis" as something specific (e.g., "hey flag out"), add the misheard form to `wake-parsing.js` `FLATOUT_FUZZY_PATTERNS`.

4. **Adjust launcher tiles.** Edit `index.html` `<section class="panel--launch">` and the matching CSS in `styles.css`. Add / remove / reorder app shortcuts.

5. **Per-profile theme tweak.** Each profile has its own brand colour in localStorage. Settings modal already exposes it. If you want a non-red accent baked in for a specific profile, edit `config/brand.json`.

### Medium (1-2 hr)

6. **Per-task cancel buttons.** Currently the STOP pill cancels everything. Extend `/cancel` in `bridge/server.mjs` to accept `?runId=`, then add a small × button per row in `tasks.js` that POSTs the runId. Each long-running module (Vision / Browse / Crew) needs to honour the runId-keyed flag — Crew already does, the others would need small changes.

7. **Frame.io official SDK.** Replace the hand-rolled REST client in `bridge/frameio.mjs` with `@frameio/api` (npm package). Saves writing types. Acceptance: existing tests still pass + a quick smoke test against your real Frame.io account.

8. **Lightroom catalogue read-only via SQLite.** `.lrcat` files are SQLite databases. Add a tool `find_lr_photo({rating, date_range, keyword})` that reads the catalogue (no plugin install needed — read-only is safe). Tool dispatch goes in `bridge/server.mjs` TOOLS array.

9. **Add a new tool to the bridge.** If there's a Mac-side workflow you keep doing manually, wrap it. New file `bridge/<your-tool>.mjs`, export a function, register in `TOOLS` array in `bridge/server.mjs`, dispatch in `executeTool()`. Existing tools like `bridge/personal.mjs` (`send_imessage`, `add_reminder`) are good templates.

### Bigger (half day +)

10. **Voice.js extraction tail.** Five modules left to extract from `voice.js` (currently 1620 LOC). Talk to Antony first — there's a deps-injection pattern established tonight that needs continuity. Candidates: `passive-vad.js`, `tts-pipeline.js`, `conversation-mode.js`, `demo-recorder.js`, the modal-event handlers (`handleInboxDropped` / `handleThumbnailComplete` / `handlePdfComplete`).

11. **Anthropic prompt caching.** When `LLM_PROVIDER=anthropic`, wrap system + tools in `cache_control: ephemeral`. ~90% input-token cost cut + ~500ms TTFT improvement. Only helps Claude routes — no effect on local Ollama path.

12. **Streaming Whisper proper.** Tier-2 speculative-partial covers ~80% of short queries. True streaming would catch longer queries too — partial transcribes every 1s, fed to LLM as soon as the partial stabilises. Complex; talk to Antony.

### Multi-day (don't try alone)

13. **Live shoot mode (phone-as-mic).** ~1 week. Phone walks the studio, real-time captioning per shot, "flag this as hero" mid-frame. Biggest agency-impact item but needs design conversation first.

14. **Multi-machine memory sync.** 3-5 days. Periodic `data/memory.db` backup to NAS / encrypted folder. Needs conflict-resolution design before code.

15. **Plugin SDK shape.** 3-5 days. `bridge/skills/<name>/` convention so new tools drop in without editing `server.mjs`. Architectural — plan first.

---

## When stuck

Tail the logs:
```bash
tail -f /tmp/jarvis-static.log /tmp/jarvis-bridge.log /tmp/jarvis-kokoro.log /tmp/jarvis-whisper.log
```

Check service health:
```bash
curl -s http://localhost:8766/healthz | jq
```

Restart everything cleanly:
```bash
./launch.sh stop && ./launch.sh
```

If Claude Code keeps suggesting the same broken thing, give it more context — paste an error, paste a file path, tell it what you've already tried.
