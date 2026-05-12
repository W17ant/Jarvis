---
title: Influencer Creation Wizard — side-panel pipeline
date: 2026-05-11
status: approved
---

# Influencer Creation Wizard

## Purpose

Operator says "create me an influencer" and a right-side panel slides in. The panel asks four short questions (sex, vibe, content type, optional reference URL). On confirm, an orchestrator runs the existing fal.ai tool chain — reference portrait → auto-lock → hero image → (motion-control video OR happy-horse animation) plus parallel TikTok caption — and the panel renders each result as it lands.

End-to-end target: ~60-90 seconds, ~$0.85-$1.00 per influencer creation. Existing voice path (manual sequencing through `create_influencer` → `lock_influencer` → `generate_teaser_image` → ...) used to take 3-5 minutes with operator pauses between each tool call.

## Architecture

```
┌─────────────────────────────────┐    ┌─────────────────────────────────┐
│ influencer-wizard-panel.js      │    │ bridge/influencer-pipeline.mjs  │
│  (new HUD side panel — same     │    │  (new orchestrator)             │
│   slide-in pattern as news)     │    │                                 │
│                                 │    │  - runPipeline({...}, broadcast)│
│  - 4 chip-rows + URL input      │◀──▶│  - sequences: refs → lock →     │
│  - voice transcripts auto-fill  │    │    hero → (motion OR animation) │
│  - 3-row live progress strip    │    │    plus parallel caption        │
│  - results stream in            │    │  - emits pipeline.update events │
└─────────────────────────────────┘    └─────────────────────────────────┘
            ▲                                          │
            │ Bridge.on("influencer.pipeline.*")       │ broadcastToClients
            │ Bridge.on("influencer.wizard.show")      │
            └──────────────────────────────────────────┘
                                       │
                                       ▼ (no changes)
                          ┌─────────────────────────────┐
                          │ Existing tools (unchanged): │
                          │   create_influencer         │
                          │   lock_influencer           │
                          │   generate_teaser_image     │
                          │   recreate_video_w_infl     │
                          │   generate_teaser_video     │
                          │   write_captions            │
                          └─────────────────────────────┘
```

## Pipeline shape

Parallel where the data dependency allows.

```
t=0    ──┬─ create_influencer({ count: 1 })             ~$0.08, ~15-25s
         │     ↓
         ├─ AUTO-LOCK ref #1 (no operator pause)            instant
         │     ↓
t≈25s  ──┼─ generate_teaser_image (hero shot)           ~$0.04, ~10-15s   ┐
         │                                                                │ parallel
         ├─ write_captions (TikTok + IG + LinkedIn)      $0    , ~2-3s    │
         │                                                                ┘
t≈40s  ──┼─ Either:
         │   • recreate_video_with_influencer            ~$0.84, ~30-60s
         │       (when reference URL supplied; uses Kling Motion Control v3 Pro)
         │   • generate_teaser_video                     ~$0.70, ~25-35s
         │       (when no URL; happy-horse animates the hero, 5s clip)
         │
t≈70s    └── pipeline done.
```

Total elapsed: ~60-90s. Total spend: ~$0.85-$1.00.

The caption stage is independent of hero — it only needs the persona description, available before any image work runs. It races alongside the image generation.

The video stage waits for hero image because both the motion-control tool and happy-horse take the hero as their input frame.

## Components

### `bridge/influencer-pipeline.mjs` (new)

Single public entry point — every dependency is injected so unit tests don't touch the real fal.ai API.

```js
/**
 * @param {object} answers              Operator answers from the wizard.
 *   @param {string} answers.sex         "male" | "female" | "other"
 *   @param {string} answers.vibe        Free text, e.g. "cinematic editorial",
 *                                       "candid phone", "polished commercial".
 *   @param {string} answers.contentType "brand-product" | "faceless" | "dances"
 *   @param {string} [answers.sourceUrl] Optional TikTok / IG / YT URL for
 *                                       Kling motion-control replication.
 * @param {object} deps  Injected tool fetchers.
 *   @param {(args) => Promise<any>} deps.createInfluencer
 *   @param {(args) => Promise<any>} deps.lockInfluencer
 *   @param {(args) => Promise<any>} deps.generateTeaserImage
 *   @param {(args) => Promise<any>} deps.recreateVideoWithInfluencer
 *   @param {(args) => Promise<any>} deps.generateTeaserVideo
 *   @param {(args) => Promise<any>} deps.writeCaptions
 * @param {(event) => void} broadcast    Called with each pipeline.update.
 * @returns {Promise<{ runId, slug, hero, video, caption, errors }>}
 */
export async function runPipeline(answers, deps, broadcast) { ... }
```

Internal contract: every emit is shape `{ type: "influencer.pipeline.update", data: { runId, stage, status, payload? } }` where `stage ∈ {"refs","hero","video","caption"}` and `status ∈ {"pending","running","done","failed"}`. Each stage emits exactly two events (`running` then `done`/`failed`).

Persona translation — the wizard's `{sex, vibe, contentType}` is composed into the `persona` / `look` strings the existing `create_influencer` expects. Tiny templated string assembly in this module; no LLM call.

### `influencer-wizard-panel.js` (new HUD module)

Reuses the news-panel slide-in CSS infrastructure (`.is-open`, `.is-collapsed`, toggle arrow, resize handle). Different content inside the panel:

- **Header**: "CREATE AN INFLUENCER" + close button
- **Section 1 — Questions**:
  - Sex: three chips (Male / Female / Other)
  - Vibe: four preset chips (Cinematic / Candid Phone / Polished Commercial / Editorial) + free-text override
  - Content type: three chips (Brand-Product / Faceless / Dances)
  - Reference URL: optional text input
  - "GO" button (disabled until sex, vibe, content type all set)
- **Section 2 — Progress strip** (visible after GO):
  - Row per stage: refs → hero → video → caption
  - Each row shows status icon + label + elapsed time
- **Section 3 — Results** (each slot appears as the pipeline emits its `done` event):
  - Reference image (thumbnail)
  - Hero image (full-width preview)
  - Video (HTML5 `<video>` with controls)
  - Caption text (per-platform, copy-to-clipboard button per block)
- **Footer**: "REGENERATE" (re-fires the pipeline with same answers) and "SAVE & USE" (closes the panel, locks the influencer into the active workspace)

Voice integration — while the panel is open, the existing live-dictation listener feeds Whisper partials into a helper that parses the most-recent transcript with simple regex matchers. Matchers:

| Pattern | Effect |
|---|---|
| `\b(male|man|guy)\b` / `\b(female|woman|girl)\b` / `\bother\b` | Sets sex chip |
| `\b(cinematic|editorial|candid|polished|commercial)\b` | Sets vibe chip |
| `\b(brand|product|faceless|dance|dancing)\b` | Sets content-type chip |
| Any URL containing `tiktok.com`, `instagram.com`, `youtube.com` | Fills URL input |
| `\bgo\b` / `\bstart\b` / `\bdo it\b` | Triggers GO button when all chips set |

Operator can click any chip to override a voice-set value.

### `bridge/server.mjs` (extend)

Three small additions:

- New tool: `show_influencer_wizard` (zero args) — broadcasts `influencer.wizard.show`. Voice fast-path: "create me an influencer", "make a new influencer", "spin up an influencer".
- New tool: `start_influencer_pipeline({ sex, vibe, content_type, source_url? })` — returns `{ runId }` immediately, runs the orchestrator on a background task, broadcasts `influencer.pipeline.update` events.
- New route: `POST /api/influencer/pipeline/start` — same surface as the tool but the wizard's GO button calls it directly (skips LLM). Body: `{sex, vibe, contentType, sourceUrl?}`.

### `bridge/fast-path.mjs` (extend)

```js
test: /^(?:create|make|spin up|build)\s+(?:me\s+)?(?:an?\s+)?(?:new\s+)?influencer\.?$/i,
handle: () => ({ match: true, reply: "Opening the influencer wizard.", toolCall: { name: "show_influencer_wizard", args: {} } }),
```

### `bridge/tool-router.mjs` (extend)

Add both new tools to `ALWAYS_ON`.

## Data flow

1. Operator: "Hey Jarvis, create me an influencer."
2. STT → fast-path matches → `show_influencer_wizard` tool fires → bridge broadcasts `influencer.wizard.show`.
3. `influencer-wizard-panel.js` mounts the panel via the existing slide-in mechanism. Voice transcript stream continues to feed the live-dictation hook, which now also parses chip values.
4. Operator clicks GO (or says "go" / "start").
5. HUD POSTs `/api/influencer/pipeline/start` with the answers.
6. Bridge `runPipeline()` fires; emits `influencer.pipeline.update` at each stage transition.
7. HUD subscribes via `Bridge.on("influencer.pipeline.*", handler)`, renders the progress strip + result slots as events arrive.
8. Pipeline completes. Footer reveals SAVE & USE / REGENERATE buttons.
9. SAVE & USE → panel closes, the locked influencer is now the default for downstream image/video tools in the active workspace.

## Error handling

| Failure | Behaviour |
|---|---|
| `create_influencer` fails (FAL_KEY missing, safety reject, network) | Panel shows "Reference generation failed: \<message\>" with a RETRY button. No downstream stages fire. |
| `lock_influencer` fails | Same: blocks downstream. RETRY re-fires from `create_influencer`. |
| `generate_teaser_image` fails | Caption stage continues. Video stage is auto-skipped and marked "skipped (hero unavailable)". |
| `recreate_video_with_influencer` fails (Kling timeout / bad URL / Kling-side error) | Auto-fall-back to `generate_teaser_video` (happy-horse) on the hero image. Panel notes "fell back to animation — motion source unavailable". |
| `generate_teaser_video` fails | Panel shows error in the video slot. Pipeline marks done; image + caption stand alone. |
| `write_captions` fails | Non-blocking. Caption slot reads "—". |
| Operator closes panel mid-run | Pipeline keeps running in the background (fal.ai jobs can't be aborted mid-flight). Results discarded; subsequent broadcasts ignored (no subscriber). |
| Operator clicks REGENERATE during a run | Mark current run as superseded; start a new `runId`. Old broadcasts dropped by `runId` mismatch in the HUD handler. |

## Testing

**Unit — `test/influencer-pipeline.test.mjs` (new)**

Each test injects mocked tool fetchers and a broadcast collector. Assertions:

- Happy path: refs → lock → hero → video → caption fires in order; caption runs in parallel with hero (its `running` event is emitted before hero's `done`).
- Hero failure: caption still emits `done`; video stage emits `failed` with reason "hero unavailable"; pipeline returns with `errors.hero` set.
- Motion-control failure: when `sourceUrl` is set and `recreateVideoWithInfluencer` rejects, pipeline falls back to `generateTeaserVideo` and emits one extra `running` event for video, then `done`.
- Each stage emits exactly two events (running + terminal).
- `broadcast` receives event payloads with the correct shape (`{type, data:{runId, stage, status, ...}}`).

**Manual checklist**

- Voice "create me an influencer" → panel slides in.
- Voice "female, cinematic, dances" while panel open → three chips highlight.
- Click GO → progress strip appears; reference image arrives ~25s in; hero appears ~40s in; caption appears ~30s in; video appears ~70s in.
- Pause/close mid-run: panel disappears, no console errors.
- REGENERATE re-fires pipeline cleanly.
- SAVE & USE: subsequent `generate_teaser_image` call (without specifying influencer) picks up the locked face.

## Out of scope (YAGNI)

- Generating multiple reference portraits and letting operator pick the face. Auto-locks ref #1 for speed. Operator's manual override is REGENERATE.
- Persisting wizard answers across sessions.
- Multi-influencer batch creation.
- Voice cloning of any kind (operator's standing preference: off-the-shelf TTS only).
- Side-panel migrations of OTHER visual tools (brand pack, teaser pipeline, screenshot). Separate follow-up if this pattern earns its keep.
- Editing existing influencers via the wizard (current lock-by-name flow stays).
- Per-platform aspect-ratio variants of the video (the wizard produces one TikTok-shaped clip).

## File touch list

- `bridge/influencer-pipeline.mjs` (new — orchestrator)
- `bridge/server.mjs` (extend — register two tools, executeTool cases, POST route)
- `bridge/fast-path.mjs` (extend — "create me an influencer" trigger)
- `bridge/tool-router.mjs` (extend — add two tools to `ALWAYS_ON`)
- `influencer-wizard-panel.js` (new — HUD module)
- `index.html` (extend — mount slot + script tag)
- `styles.css` (extend — wizard chip + result styles)
- `test/influencer-pipeline.test.mjs` (new — orchestrator unit tests)
