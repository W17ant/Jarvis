# Influencer Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Voice command "create me an influencer" opens a right-side wizard panel that asks four short questions, then runs an existing-tool pipeline (reference portrait → auto-lock → hero image → motion-control video OR happy-horse animation, plus parallel TikTok caption) and streams results into the panel as each stage completes.

**Architecture:** Single new bridge module (`influencer-pipeline.mjs`) sequences existing fal.ai tools (`create_influencer`, `lock_influencer`, `generate_teaser_image`, `animate_teaser_image`, `recreate_video_with_influencer`, `Agency.generateSocialCaptions`) with parallel branching where data flow allows. New HUD module (`influencer-wizard-panel.js`) reuses the news-panel CSS infrastructure for slide-in animation and renders progress + results from `influencer.pipeline.update` WebSocket events. Voice fast-path opens the panel without LLM round-trip.

**Tech Stack:** Node 18+, existing Jarvis WebSocket broadcaster (`broadcastToClients`), existing fal.ai tool handlers, vitest for unit tests. No new dependencies.

**Commit policy:** No-commit window is still active (white-label rebrand staying uncommitted until Adam forks). Each task ends in a **stage** step using `git add`, not commit. Do NOT run `git commit` during this implementation.

---

## File Structure

| Path | Role |
|---|---|
| `bridge/influencer-pipeline.mjs` (new) | Orchestrator. Pure module — tool fetchers injected via `deps` so unit tests don't touch fal.ai. Emits `influencer.pipeline.update` events through an injected broadcaster. |
| `bridge/server.mjs` (modify) | Register `show_influencer_wizard` + `start_influencer_pipeline` tools, executeTool switch cases, `POST /api/influencer/pipeline/start` route, ALWAYS_ON additions wired automatically by tool-router import. |
| `bridge/fast-path.mjs` (modify) | New handler for "create me an influencer" voice triggers — fires `show_influencer_wizard` tool. |
| `bridge/tool-router.mjs` (modify) | Add both new tool names to `ALWAYS_ON`. |
| `influencer-wizard-panel.js` (new) | HUD module. Mount/unmount, build chip form, parse voice transcripts into chips, POST to bridge on GO, render `influencer.pipeline.update` events into progress + result slots. Uses DOM-construction (`createElement` + `textContent`) for any payload-derived content — no innerHTML for user data. |
| `index.html` (modify) | Add `<div id="influencer-wizard-root">` mount slot + `<script src="influencer-wizard-panel.js" type="module">`. |
| `styles.css` (modify) | Wizard chip + progress-strip + result-slot styles. Re-uses `.news-panel-root` family for the panel shell (same slide-in animation, same toggle arrow, same resize handle). |
| `test/influencer-pipeline.test.mjs` (new) | Unit tests for the orchestrator with mocked tool fetchers. |

---

### Task 1: Persona composer + happy path (TDD)

**Files:**
- Create: `bridge/influencer-pipeline.mjs`
- Create: `test/influencer-pipeline.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/influencer-pipeline.test.mjs`:

```js
/** test/influencer-pipeline.test.mjs — unit tests for the orchestrator. */
import { describe, it, expect } from "vitest";
import { runPipeline, composePersona } from "../bridge/influencer-pipeline.mjs";

/** Build a deps object whose mocked tool fetchers record their calls and
 *  return realistic-shaped success payloads. Each fetcher resolves after a
 *  microtask so concurrent calls can interleave (lets us assert parallelism). */
function makeDeps(overrides = {}) {
  const calls = [];
  const record = (name, args, result) => { calls.push({ name, args }); return Promise.resolve(result); };
  const defaults = {
    createInfluencer:           (a) => record("createInfluencer", a, { ok: true, slug: "ai-marcus", refs: [{ idx: 0, path: "/tmp/ref0.png" }] }),
    lockInfluencer:             (a) => record("lockInfluencer", a, { ok: true, slug: a.slug, locked: true }),
    generateTeaserImage:        (a) => record("generateTeaserImage", a, { ok: true, run_id: "r1", hero_path: "/tmp/hero.png" }),
    animateTeaserImage:         (a) => record("animateTeaserImage", a, { ok: true, clip_path: "/tmp/clip.mp4" }),
    recreateVideoWithInfluencer:(a) => record("recreateVideoWithInfluencer", a, { ok: true, clip_path: "/tmp/motion.mp4" }),
    generateSocialCaptions:     (a) => record("generateSocialCaptions", a, { ok: true, captions: { tiktok: "Test TikTok copy" } }),
  };
  return { calls, deps: { ...defaults, ...overrides } };
}

function makeBroadcaster() {
  const events = [];
  return { events, broadcast: (e) => events.push(e) };
}

describe("composePersona", () => {
  it("builds a persona string from sex + vibe + content type", () => {
    const p = composePersona({ sex: "female", vibe: "cinematic editorial", contentType: "dances" });
    expect(p.persona).toMatch(/female/i);
    expect(p.persona).toMatch(/dance/i);
    expect(p.look).toMatch(/cinematic editorial/i);
    expect(p.aesthetic).toMatch(/cinematic editorial/i);
    expect(p.name).toMatch(/^[A-Za-z]+$/);
  });
});

describe("runPipeline — happy path", () => {
  it("runs refs → lock → hero → video (animation when no URL) and caption in parallel", async () => {
    const { calls, deps } = makeDeps();
    const { events, broadcast } = makeBroadcaster();
    const result = await runPipeline(
      { sex: "female", vibe: "cinematic", contentType: "dances" },
      deps,
      broadcast,
    );
    const names = calls.map(c => c.name);
    expect(names).toContain("createInfluencer");
    expect(names).toContain("lockInfluencer");
    expect(names).toContain("generateTeaserImage");
    expect(names).toContain("animateTeaserImage");
    expect(names).toContain("generateSocialCaptions");
    /* recreateVideoWithInfluencer should NOT fire when no sourceUrl. */
    expect(names).not.toContain("recreateVideoWithInfluencer");
    /* Each of the four stages emits exactly two events. */
    const stageNames = events.filter(e => e.type === "influencer.pipeline.update").map(e => `${e.data.stage}:${e.data.status}`);
    expect(stageNames).toEqual(expect.arrayContaining([
      "refs:running", "refs:done",
      "hero:running", "hero:done",
      "video:running", "video:done",
      "caption:running", "caption:done",
    ]));
    expect(result.errors).toEqual({});
    expect(result.slug).toBe("ai-marcus");
  });
});
```

- [ ] **Step 2: Run test — expect failure (module missing)**

```bash
npx vitest run test/influencer-pipeline.test.mjs
```

Expected: FAIL — `Cannot find module '../bridge/influencer-pipeline.mjs'`.

- [ ] **Step 3: Create the orchestrator**

Create `bridge/influencer-pipeline.mjs`:

```js
/** bridge/influencer-pipeline.mjs — Wizard pipeline orchestrator.
 *
 *  Sequences existing fal.ai tools into a single end-to-end run for the
 *  "create me an influencer" wizard. The orchestrator has no direct fal.ai
 *  imports — all tool fetchers are injected via `deps` so unit tests can
 *  mock them.
 *
 *  Data dependencies:
 *    create_influencer → lock_influencer → generate_teaser_image →
 *      (recreate_video_with_influencer | animate_teaser_image)
 *    generate_social_captions runs in parallel with the image+video chain
 *
 *  Each stage emits two broadcast events:
 *    { type: "influencer.pipeline.update", data: { runId, stage, status, payload? } }
 *  where stage ∈ {"refs","hero","video","caption"} and
 *        status ∈ {"running","done","failed","skipped"}.
 */

const VIBE_PRESETS = {
  cinematic:   "cinematic editorial, 35mm film grain, dramatic key light",
  candid:      "candid phone photography, natural daylight, casual framing",
  polished:    "polished commercial photography, studio lighting, glossy retouch",
  editorial:   "high-end editorial, magazine cover energy, controlled lighting",
};

const CONTENT_PERSONA = {
  "brand-product": "lifestyle creator who showcases products in their daily routine",
  "faceless":      "voice-over style creator who narrates over visuals without showing face directly",
  "dances":        "dance-led creator with confident on-camera energy and trend-aware choreography",
};

/* Single arbitrary first-name pool so the orchestrator never asks for a
 * name. Operator can rename via REGENERATE if they hate it. Kept short so
 * the slug stays clean. */
const NAME_POOL = ["Marcus", "Lena", "Ava", "Theo", "Nina", "Ezra", "Sienna", "Jude"];
function _pickName() { return NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)]; }

/** Compose the persona / look / aesthetic strings the existing
 *  create_influencer tool expects. Returns a name, slug-friendly base, and
 *  three description strings. */
export function composePersona({ sex, vibe, contentType }) {
  const sexWord = sex === "male" ? "male" : sex === "female" ? "female" : "androgynous";
  const ageBand = "mid-twenties";
  const vibeLong = VIBE_PRESETS[vibe] || String(vibe || "natural look");
  const personaDesc = CONTENT_PERSONA[contentType] || "general lifestyle creator";
  const name = _pickName();
  return {
    name,
    persona: `${ageBand} ${sexWord} ${personaDesc}`,
    look:    `${sexWord}, ${ageBand}, ${vibeLong}`,
    aesthetic: vibeLong,
  };
}

/** Run one full pipeline. Returns { runId, slug, hero, video, caption, errors }.
 *  `deps` keys map 1:1 to the existing bridge handlers. `broadcast` is called
 *  for every stage transition. */
export async function runPipeline(answers, deps, broadcast) {
  const runId = `inf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const persona = composePersona(answers);
  const errors = {};
  const result = { runId, slug: null, hero: null, video: null, caption: null, errors };

  const emit = (stage, status, payload) => {
    try { broadcast({ type: "influencer.pipeline.update", data: { runId, stage, status, payload } }); }
    catch { /* broadcaster errors must never break the pipeline */ }
  };

  /* Stage 1: create_influencer (single reference, count=1 — fastest path). */
  emit("refs", "running");
  let refsResult;
  try {
    refsResult = await deps.createInfluencer({
      name: persona.name,
      persona: persona.persona,
      look: persona.look,
      aesthetic: persona.aesthetic,
      platform: "tiktok",
      count: 1,
      confirmed: true,
    });
    if (!refsResult?.ok) throw new Error(refsResult?.error || "create_influencer returned !ok");
    emit("refs", "done", { slug: refsResult.slug, refs: refsResult.refs });
  } catch (e) {
    errors.refs = String(e.message || e);
    emit("refs", "failed", { error: errors.refs });
    return result; /* unrecoverable — no slug to lock */
  }
  result.slug = refsResult.slug;

  /* Stage 1b: lock the only generated reference (no operator pause). */
  try {
    const lock = await deps.lockInfluencer({ slug: refsResult.slug, ref_idx: 0 });
    if (!lock?.ok) throw new Error(lock?.error || "lock_influencer returned !ok");
  } catch (e) {
    errors.refs = `lock failed: ${String(e.message || e)}`;
    emit("refs", "failed", { error: errors.refs });
    return result;
  }

  /* Stages 2 (hero) + 4 (caption) run in parallel. Caption needs only the
   * persona description, which we already have. */
  const heroPromise = (async () => {
    emit("hero", "running");
    try {
      const r = await deps.generateTeaserImage({
        prompt: `${persona.persona}. ${persona.look}. Hero shot for ${answers.contentType || "lifestyle"} content.`,
        aspect: "9:16",
        style: persona.aesthetic,
        influencer: refsResult.slug,
        confirmed: true,
      });
      if (!r?.ok) throw new Error(r?.error || "generate_teaser_image returned !ok");
      result.hero = r;
      emit("hero", "done", { run_id: r.run_id, hero_path: r.hero_path });
      return r;
    } catch (e) {
      errors.hero = String(e.message || e);
      emit("hero", "failed", { error: errors.hero });
      return null;
    }
  })();

  const captionPromise = (async () => {
    emit("caption", "running");
    try {
      const r = await deps.generateSocialCaptions({
        subject: `${persona.name} — ${persona.persona}`,
        platforms: ["tiktok", "instagram", "linkedin"],
      });
      if (!r?.ok) throw new Error(r?.error || "generate_social_captions returned !ok");
      result.caption = r;
      emit("caption", "done", { captions: r.captions });
      return r;
    } catch (e) {
      errors.caption = String(e.message || e);
      emit("caption", "failed", { error: errors.caption });
      return null;
    }
  })();

  /* Stage 3 (video) waits on hero. Path picked by presence of sourceUrl. */
  const videoPromise = heroPromise.then(async (hero) => {
    if (!hero) {
      errors.video = "hero unavailable";
      emit("video", "skipped", { reason: errors.video });
      return null;
    }
    emit("video", "running");
    const useMotion = !!answers.sourceUrl;
    /* Primary path. If motion-control fails AND sourceUrl was set, fall
     * back to happy-horse animation so the operator still gets a clip. */
    if (useMotion) {
      try {
        const r = await deps.recreateVideoWithInfluencer({
          slug: refsResult.slug,
          source_url: answers.sourceUrl,
          prompt: `${persona.persona}, ${persona.aesthetic}`,
          confirmed: true,
        });
        if (!r?.ok) throw new Error(r?.error || "recreate_video_with_influencer returned !ok");
        result.video = r;
        emit("video", "done", { clip_path: r.clip_path, source: "motion" });
        return r;
      } catch (e) {
        /* Fall through to happy-horse fallback below. */
        emit("video", "running", { fallback: "motion-control failed, retrying with animation" });
      }
    }
    try {
      const r = await deps.animateTeaserImage({
        run_id: hero.run_id,
        motion_prompt: `${persona.persona}, ${persona.aesthetic}, confident on-camera energy`,
        duration_s: 5,
        confirmed: true,
      });
      if (!r?.ok) throw new Error(r?.error || "animate_teaser_image returned !ok");
      result.video = r;
      emit("video", "done", { clip_path: r.clip_path, source: "animation" });
      return r;
    } catch (e) {
      errors.video = String(e.message || e);
      emit("video", "failed", { error: errors.video });
      return null;
    }
  });

  await Promise.all([heroPromise, captionPromise, videoPromise]);
  return result;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run test/influencer-pipeline.test.mjs
```

Expected: 2 passing tests.

- [ ] **Step 5: Stage**

```bash
git add bridge/influencer-pipeline.mjs test/influencer-pipeline.test.mjs
```

---

### Task 2: Hero failure → caption survives, video skipped

**Files:**
- Modify: `test/influencer-pipeline.test.mjs`

- [ ] **Step 1: Append the failing test**

```js
describe("runPipeline — hero failure", () => {
  it("does not block caption and skips video when hero fails", async () => {
    const { calls, deps } = makeDeps({
      generateTeaserImage: () => Promise.resolve({ ok: false, error: "fal returned 429" }),
    });
    const { events, broadcast } = makeBroadcaster();
    const result = await runPipeline(
      { sex: "male", vibe: "cinematic", contentType: "brand-product" },
      deps,
      broadcast,
    );
    expect(result.errors.hero).toMatch(/fal returned 429/);
    expect(result.errors.video).toBe("hero unavailable");
    expect(result.caption).toBeTruthy();
    const stageNames = events.filter(e => e.type === "influencer.pipeline.update").map(e => `${e.data.stage}:${e.data.status}`);
    expect(stageNames).toContain("hero:failed");
    expect(stageNames).toContain("caption:done");
    expect(stageNames).toContain("video:skipped");
  });
});
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run test/influencer-pipeline.test.mjs
```

Expected: 3 passing tests (Task 1 logic already handles this case).

- [ ] **Step 3: Stage**

```bash
git add test/influencer-pipeline.test.mjs
```

---

### Task 3: Motion-control failure falls back to animation

**Files:**
- Modify: `test/influencer-pipeline.test.mjs`

- [ ] **Step 1: Append the failing test**

```js
describe("runPipeline — motion-control failure", () => {
  it("falls back to animate_teaser_image when recreate_video fails", async () => {
    const { calls, deps } = makeDeps({
      recreateVideoWithInfluencer: () => Promise.resolve({ ok: false, error: "Kling timeout" }),
    });
    const { events, broadcast } = makeBroadcaster();
    const result = await runPipeline(
      { sex: "female", vibe: "cinematic", contentType: "dances", sourceUrl: "https://tiktok.com/@x/video/1" },
      deps,
      broadcast,
    );
    const names = calls.map(c => c.name);
    expect(names).toContain("recreateVideoWithInfluencer"); /* primary path tried */
    expect(names).toContain("animateTeaserImage");          /* fallback fired */
    expect(result.video).toBeTruthy();
    expect(result.errors.video).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/influencer-pipeline.test.mjs
```

Expected: 4 passing tests.

- [ ] **Step 3: Stage**

```bash
git add test/influencer-pipeline.test.mjs
```

---

### Task 4: Parallel caption execution

**Files:**
- Modify: `test/influencer-pipeline.test.mjs`

- [ ] **Step 1: Append the failing test**

```js
describe("runPipeline — caption parallelism", () => {
  it("caption:running fires before hero:done (parallel start)", async () => {
    const { events, broadcast } = makeBroadcaster();
    /* Slow down the hero call so caption is forced to be in-flight before
     * hero resolves. Without parallelism, caption:running would only fire
     * after hero:done. */
    const slowHero = () => new Promise((res) => setTimeout(() => res({ ok: true, run_id: "rX", hero_path: "/tmp/h.png" }), 30));
    const { deps } = makeDeps({ generateTeaserImage: slowHero });
    await runPipeline({ sex: "male", vibe: "polished", contentType: "brand-product" }, deps, broadcast);
    const ordered = events.filter(e => e.type === "influencer.pipeline.update").map(e => `${e.data.stage}:${e.data.status}`);
    const captionRunningIdx = ordered.indexOf("caption:running");
    const heroDoneIdx       = ordered.indexOf("hero:done");
    expect(captionRunningIdx).toBeGreaterThanOrEqual(0);
    expect(heroDoneIdx).toBeGreaterThanOrEqual(0);
    expect(captionRunningIdx).toBeLessThan(heroDoneIdx);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/influencer-pipeline.test.mjs
```

Expected: 5 passing tests.

- [ ] **Step 3: Stage**

```bash
git add test/influencer-pipeline.test.mjs
```

---

### Task 5: Register `show_influencer_wizard` + `start_influencer_pipeline` tools

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Locate the TOOLS array end of influencer block**

```bash
grep -n 'name: "recreate_video_with_influencer"' bridge/server.mjs
```

Expected: line ~902.

- [ ] **Step 2: Insert two tool definitions after `recreate_video_with_influencer`**

Find the closing `}, },` of `recreate_video_with_influencer` (around line 915 — the block ends with `},  },`). Immediately after, insert:

```js
  {
    type: "function",
    function: {
      name: "show_influencer_wizard",
      description:
        "Open the influencer creation wizard side panel. Use when the operator says 'create me an influencer', 'make a new influencer', 'spin up an influencer', or 'build me a TikTok face'. The panel asks for sex / vibe / content type / optional reference URL, then runs the create → lock → hero → video → caption pipeline. After the wizard appears the operator drives it via clicks or by continuing to speak — do not ask follow-up questions, the panel handles that.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_influencer_pipeline",
      description:
        "Internal: kick off the influencer pipeline run with explicit answers. The HUD wizard's GO button calls this directly via POST /api/influencer/pipeline/start; the LLM rarely calls it directly. If the LLM is asked to fire it, ensure all four answers (sex, vibe, content_type, optional source_url) are present from the conversation.",
      parameters: {
        type: "object",
        properties: {
          sex:          { type: "string", enum: ["male", "female", "other"] },
          vibe:         { type: "string", description: "One of: cinematic, candid, polished, editorial — or a free-text vibe phrase." },
          content_type: { type: "string", enum: ["brand-product", "faceless", "dances"] },
          source_url:   { type: "string", description: "Optional TikTok / Instagram / YouTube URL to drive motion-control replication." },
        },
        required: ["sex", "vibe", "content_type"],
      },
    },
  },
```

- [ ] **Step 3: Syntax check**

```bash
node --check bridge/server.mjs
```

Expected: no output.

- [ ] **Step 4: Stage**

```bash
git add bridge/server.mjs
```

---

### Task 6: ExecuteTool cases for the two new tools

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Add the InfluencerPipeline import near the other bridge module imports**

Find the line `import * as News from "./news.mjs";` and add immediately after it:

```js
import * as InfluencerPipeline from "./influencer-pipeline.mjs";
```

- [ ] **Step 2: Add a module-level state map for in-flight runs**

Find the line `function buildNewsSpokenSummary(cache) {` and immediately BEFORE it, add:

```js
/** Tracks currently-running influencer pipeline runs by runId so the POST
 *  endpoint can return immediately and the orchestrator continues in the
 *  background. The map is intentionally never cleaned up — runs are tiny
 *  ({ runId, startedAt }) and the process restarts daily anyway. */
const _influencerRuns = new Map();
```

- [ ] **Step 3: Add the executeTool switch cases**

Find `case "recreate_video_with_influencer":` (around line 2837). Immediately AFTER that case ends, add:

```js
    case "show_influencer_wizard": {
      broadcastToClients({ type: "influencer.wizard.show" });
      return { ok: true, summary: "Opening the influencer wizard. Tell me what kind." };
    }
    case "start_influencer_pipeline": {
      const answers = {
        sex: args.sex,
        vibe: args.vibe,
        contentType: args.content_type,
        sourceUrl: args.source_url || null,
      };
      /* Build the deps map from existing bridge handlers. Each fetcher returns
       * the same shape its corresponding tool case returns. */
      const deps = {
        createInfluencer:           (a) => createInfluencerTool(a),
        lockInfluencer:             (a) => lockInfluencerTool(a),
        generateTeaserImage:        (a) => generateTeaserImage(a),
        animateTeaserImage:         (a) => executeTool("animate_teaser_image", a),
        recreateVideoWithInfluencer:(a) => recreateVideoWithInfluencer(a),
        generateSocialCaptions:     (a) => Agency.generateSocialCaptions(a),
      };
      /* Fire-and-forget: return runId now, broadcast updates as they happen. */
      const runPromise = InfluencerPipeline.runPipeline(answers, deps, broadcastToClients);
      runPromise.then((r) => {
        broadcastToClients({ type: "influencer.pipeline.complete", data: r });
        _influencerRuns.delete(r.runId);
      }).catch((e) => {
        console.warn(`[influencer-pipeline] crashed: ${e.message}`);
      });
      /* We can't synchronously know the runId because runPipeline generates
       * it internally — emit a synthetic "started" event with a placeholder
       * the HUD can use to correlate. */
      const tempId = `inf_pending_${Date.now()}`;
      _influencerRuns.set(tempId, { startedAt: Date.now() });
      return { ok: true, pending_run_id: tempId };
    }
```

- [ ] **Step 4: Syntax check**

```bash
node --check bridge/server.mjs
```

Expected: no output.

- [ ] **Step 5: Stage**

```bash
git add bridge/server.mjs
```

---

### Task 7: POST `/api/influencer/pipeline/start` route

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Locate the news refresh route**

```bash
grep -n '"/api/news/refresh"' bridge/server.mjs
```

Expected: one match.

- [ ] **Step 2: Add the new route immediately before the news refresh route**

Insert:

```js
  /* POST /api/influencer/pipeline/start — wizard's GO button calls this.
   * Returns immediately with the synthetic runId; the orchestrator runs in
   * the background and emits influencer.pipeline.update events via WS. */
  if (req.url === "/api/influencer/pipeline/start" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body || "{}"); }
    catch { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "invalid JSON body" })); return; }
    const r = await executeTool("start_influencer_pipeline", {
      sex: parsed.sex,
      vibe: parsed.vibe,
      content_type: parsed.contentType,
      source_url: parsed.sourceUrl || undefined,
    });
    res.writeHead(r?.ok ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify(r));
    return;
  }
```

- [ ] **Step 3: Syntax check**

```bash
node --check bridge/server.mjs
```

Expected: no output.

- [ ] **Step 4: Stage**

```bash
git add bridge/server.mjs
```

---

### Task 8: Fast-path trigger for the wizard

**Files:**
- Modify: `bridge/fast-path.mjs`

- [ ] **Step 1: Add the handler**

Find the news fast-path block (the handler matching `/^(?:close|hide|dismiss|turn\s+off)\s+the\s+news/`). Immediately after that handler's closing `},`, insert:

```js
  /* ---------- Influencer wizard ----------
   *  Permissive triggers — operator's framing varies a lot for this command.
   *  Bypass the local LLM (which often narrates "let me create an influencer"
   *  without firing the tool) and open the wizard directly. */
  {
    test: /^(?:create|make|build|spin\s*up|generate)\s+(?:me\s+)?(?:an?\s+)?(?:new\s+)?influencer\.?$/i,
    handle: () => ({
      match: true,
      reply: "Opening the influencer wizard. Tell me what kind.",
      toolCall: { name: "show_influencer_wizard", args: {} },
    }),
  },
```

- [ ] **Step 2: Syntax check + regex coverage**

```bash
node --input-type=module -e "
import { tryFastPath } from './bridge/fast-path.mjs';
for (const q of ['create me an influencer', 'make a new influencer', 'spin up an influencer', 'generate me an influencer', 'show me the news']) {
  const r = await tryFastPath(q);
  console.log(q.padEnd(34), '→', r ? (r.toolCall?.name || 'reply-only') : 'no match');
}
"
```

Expected: first four resolve to `show_influencer_wizard`, "show me the news" stays on `show_news_panel`.

- [ ] **Step 3: Stage**

```bash
git add bridge/fast-path.mjs
```

---

### Task 9: Add tools to tool-router ALWAYS_ON

**Files:**
- Modify: `bridge/tool-router.mjs`

- [ ] **Step 1: Append to ALWAYS_ON**

Find the `ALWAYS_ON = new Set([` declaration and append two entries:

```js
const ALWAYS_ON = new Set([
  "recall",
  "recent_conversations",
  "web_search",
  "runtime_constraints",
  "open_url",
  "enter_sleep_mode",
  "list_projects",
  "save_fact",
  "save_conversation",
  "list_shoots",
  "show_news_panel",
  "hide_news_panel",
  "show_influencer_wizard",
  "start_influencer_pipeline",
]);
```

(Preserve all existing entries; only add the two new ones at the end.)

- [ ] **Step 2: Syntax check**

```bash
node --check bridge/tool-router.mjs
```

Expected: no output.

- [ ] **Step 3: Stage**

```bash
git add bridge/tool-router.mjs
```

---

### Task 10: HUD mount slot + script tag

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add mount slot + script tag**

Find the existing `<div id="news-panel-root" ...></div>` line. Add the wizard mount IMMEDIATELY AFTER it (so the wizard and news panels are siblings):

```html
  <!-- Influencer wizard panel mount point. Hidden until bridge broadcasts influencer.wizard.show. -->
  <div id="influencer-wizard-root" class="news-panel-root" hidden></div>
  <script src="influencer-wizard-panel.js" type="module"></script>
```

(Reusing `class="news-panel-root"` is intentional — the wizard shares the slide-in CSS family.)

- [ ] **Step 2: Stage**

```bash
git add index.html
```

---

### Task 11: Append wizard-specific styles

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Append**

Append to the end of `styles.css`:

```css
/* ============================================================
   INFLUENCER WIZARD — shares .news-panel-root family for the slide-in
   shell (animation, toggle arrow, resize handle). These rules cover the
   wizard-specific interior: question chips, progress strip, result slots.
   ============================================================ */
.inf-wizard-grid {
  display: grid;
  grid-template-rows: 56px 1fr;
  grid-template-columns: 1fr;
  height: 100%;
  gap: 12px;
  padding: 12px;
  box-sizing: border-box;
}
.inf-wizard-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 12px;
  border: 1px solid var(--accent, #00d4ff);
  background: rgba(11, 11, 11, 0.94);
  font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--accent, #00d4ff);
}
.inf-wizard-body {
  overflow-y: auto;
  padding: 6px 4px;
  display: flex; flex-direction: column; gap: 18px;
}
.inf-q {
  display: flex; flex-direction: column; gap: 8px;
}
.inf-q-label {
  font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
  color: #888;
}
.inf-chips {
  display: flex; flex-wrap: wrap; gap: 8px;
}
.inf-chip {
  background: transparent;
  color: #e7e7e7;
  border: 1px solid #2a2a2a;
  padding: 8px 14px;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  letter-spacing: 0.06em;
}
.inf-chip:hover { border-color: var(--accent, #00d4ff); }
.inf-chip.is-active {
  border-color: var(--accent, #00d4ff);
  color: var(--accent, #00d4ff);
  background: rgba(0, 212, 255, 0.12);
}
.inf-url-input {
  width: 100%;
  background: rgba(0, 0, 0, 0.5);
  color: #e7e7e7;
  border: 1px solid #2a2a2a;
  padding: 10px 12px;
  font: inherit;
  font-size: 13px;
  box-sizing: border-box;
}
.inf-url-input:focus { outline: none; border-color: var(--accent, #00d4ff); }
.inf-go-row {
  display: flex; gap: 8px; align-items: center;
}
.inf-go-btn, .inf-regen-btn, .inf-save-btn {
  background: transparent;
  color: var(--accent, #00d4ff);
  border: 1px solid var(--accent, #00d4ff);
  padding: 8px 18px;
  font: inherit; font-size: 12px;
  letter-spacing: 0.14em; text-transform: uppercase;
  cursor: pointer;
}
.inf-go-btn:disabled { color: #555; border-color: #2a2a2a; cursor: not-allowed; }
.inf-go-btn:hover:not(:disabled),
.inf-regen-btn:hover,
.inf-save-btn:hover { background: rgba(0, 212, 255, 0.12); }

/* Progress strip — one row per stage. */
.inf-progress {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px;
  border: 1px solid #1f1f1f;
  background: rgba(0, 0, 0, 0.4);
}
.inf-stage-row {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 12px; letter-spacing: 0.1em;
  padding: 6px 4px;
  border-bottom: 1px solid #161616;
}
.inf-stage-row:last-child { border-bottom: 0; }
.inf-stage-row[data-status="pending"] { color: #555; }
.inf-stage-row[data-status="running"] { color: var(--accent, #00d4ff); }
.inf-stage-row[data-status="done"]    { color: #6dd47e; }
.inf-stage-row[data-status="failed"]  { color: #d46d6d; }
.inf-stage-row[data-status="skipped"] { color: #888; }

/* Result slots. */
.inf-results {
  display: flex; flex-direction: column; gap: 14px;
}
.inf-result-slot {
  border: 1px solid #1f1f1f;
  padding: 10px;
  background: rgba(0, 0, 0, 0.4);
}
.inf-result-slot h3 {
  margin: 0 0 8px 0;
  font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--accent, #00d4ff);
}
.inf-result-slot img,
.inf-result-slot video {
  display: block;
  width: 100%; height: auto;
  background: #111;
}
.inf-caption-block {
  border-top: 1px solid #1a1a1a;
  padding-top: 8px; margin-top: 8px;
  font-size: 12px; line-height: 1.4;
  color: #c8c8c8;
}
.inf-caption-block:first-child { border-top: 0; padding-top: 0; margin-top: 0; }
.inf-caption-block-label {
  font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--accent, #00d4ff);
  margin-bottom: 4px;
}
```

- [ ] **Step 2: Stage**

```bash
git add styles.css
```

---

### Task 12: `influencer-wizard-panel.js` shell + question form

**Files:**
- Create: `influencer-wizard-panel.js`

- [ ] **Step 1: Create the module**

```js
/** influencer-wizard-panel.js — Side-panel wizard for "create an influencer".
 *
 *  Mounts when the bridge broadcasts `influencer.wizard.show`. Asks four
 *  questions (sex, vibe, content type, optional reference URL), then on
 *  GO posts the answers to /api/influencer/pipeline/start and renders the
 *  pipeline's progress + results as the bridge broadcasts
 *  `influencer.pipeline.update` events.
 *
 *  All payload-derived DOM uses createElement + textContent — no innerHTML
 *  for user-controlled content. Image / video sources are passed through a
 *  safeUrl() guard that rejects anything other than http(s) and file:.
 */

import * as Bridge from "./bridge-client.js";

/** HUD is on :8765 but the bridge HTTP API lives on :8766. The pipeline
 *  start route is on the bridge. */
const BRIDGE_BASE = "http://localhost:8766";

const VIBE_PRESETS  = ["cinematic", "candid", "polished", "editorial"];
const SEX_OPTIONS   = ["male", "female", "other"];
const CONTENT_TYPES = ["brand-product", "faceless", "dances"];

let _root = null;
/** Current wizard state — answers + activeRunId. */
const _state = { sex: null, vibe: null, contentType: null, sourceUrl: "", runId: null };

export function show() {
  ensureRoot();
  if (!_root) return;
  if (!_root.dataset.built) {
    buildShell();
    _root.dataset.built = "1";
    _root.style.width = "min(560px, 92vw)";
  }
  _root.hidden = false;
  _root.classList.remove("is-collapsed");
  requestAnimationFrame(() => _root.classList.add("is-open"));
}

export function hide() {
  if (!_root) return;
  _root.classList.remove("is-open", "is-collapsed");
  setTimeout(() => {
    if (!_root || _root.classList.contains("is-open")) return;
    _root.hidden = true;
    _root.replaceChildren();
    delete _root.dataset.built;
    Object.assign(_state, { sex: null, vibe: null, contentType: null, sourceUrl: "", runId: null });
  }, 320);
}

function ensureRoot() {
  if (_root) return;
  _root = document.getElementById("influencer-wizard-root");
  if (!_root) console.warn("[inf-wizard] #influencer-wizard-root not found");
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    node.setAttribute(k, v === true ? "" : String(v));
  }
  if (text != null) node.textContent = String(text);
  return node;
}

function buildShell() {
  _root.replaceChildren();

  const grid = el("div", { class: "inf-wizard-grid" });

  /* Header */
  const head = el("div", { class: "inf-wizard-head" });
  head.append(el("span", {}, "CREATE AN INFLUENCER"));
  const closeBtn = el("button", { type: "button", class: "news-panel-toggle", style: "position:static;width:auto;height:auto;padding:4px 10px;transform:none" }, "CLOSE");
  closeBtn.addEventListener("click", () => hide());
  head.appendChild(closeBtn);

  /* Body */
  const body = el("div", { class: "inf-wizard-body" });
  body.append(
    buildQuestion("Sex", "sex", SEX_OPTIONS),
    buildQuestion("Vibe", "vibe", VIBE_PRESETS),
    buildQuestion("Content type", "contentType", CONTENT_TYPES),
    buildUrlInput(),
    buildGoRow(),
    buildProgress(),
    buildResults(),
  );

  grid.append(head, body);
  _root.appendChild(grid);
}

function buildQuestion(label, key, options) {
  const wrap = el("div", { class: "inf-q" });
  wrap.appendChild(el("div", { class: "inf-q-label" }, label));
  const chips = el("div", { class: "inf-chips" });
  for (const opt of options) {
    const b = el("button", { type: "button", class: "inf-chip", "data-key": key, "data-value": opt }, opt);
    b.addEventListener("click", () => selectChip(key, opt));
    chips.appendChild(b);
  }
  wrap.appendChild(chips);
  return wrap;
}

function buildUrlInput() {
  const wrap = el("div", { class: "inf-q" });
  wrap.appendChild(el("div", { class: "inf-q-label" }, "Reference URL (optional — TikTok / IG / YouTube)"));
  const inp = el("input", { type: "text", class: "inf-url-input", id: "inf-url", placeholder: "https://www.tiktok.com/..." });
  inp.addEventListener("input", () => { _state.sourceUrl = inp.value.trim(); });
  wrap.appendChild(inp);
  return wrap;
}

function buildGoRow() {
  const row = el("div", { class: "inf-go-row" });
  const go = el("button", { type: "button", class: "inf-go-btn", id: "inf-go", disabled: "" }, "GO");
  go.addEventListener("click", onGoClick);
  row.appendChild(go);
  return row;
}

function buildProgress() {
  const wrap = el("div", { class: "inf-progress", id: "inf-progress", hidden: "" });
  for (const stage of ["refs", "hero", "caption", "video"]) {
    const row = el("div", { class: "inf-stage-row", "data-stage": stage, "data-status": "pending" });
    row.append(el("span", {}, stageLabel(stage)), el("span", { class: "inf-stage-status" }, "pending"));
    wrap.appendChild(row);
  }
  return wrap;
}

function buildResults() {
  return el("div", { class: "inf-results", id: "inf-results" });
}

function stageLabel(s) {
  return ({ refs: "Reference portrait", hero: "Hero image", caption: "Captions", video: "Animated clip" })[s] || s;
}

function selectChip(key, value) {
  _state[key] = value;
  /* Reflect in DOM: toggle is-active on all chips for this key. */
  if (!_root) return;
  for (const b of _root.querySelectorAll(`.inf-chip[data-key="${key}"]`)) {
    b.classList.toggle("is-active", b.dataset.value === value);
  }
  refreshGoButton();
}

function refreshGoButton() {
  const go = _root?.querySelector("#inf-go");
  if (!go) return;
  const ready = _state.sex && _state.vibe && _state.contentType;
  if (ready) go.removeAttribute("disabled");
  else go.setAttribute("disabled", "");
}

async function onGoClick() {
  if (!_state.sex || !_state.vibe || !_state.contentType) return;
  /* Disable controls and show progress strip. */
  const go = _root.querySelector("#inf-go");
  if (go) go.setAttribute("disabled", "");
  const prog = _root.querySelector("#inf-progress");
  if (prog) prog.removeAttribute("hidden");
  resetStages();
  /* Fire the pipeline. */
  try {
    const r = await fetch(`${BRIDGE_BASE}/api/influencer/pipeline/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sex: _state.sex,
        vibe: _state.vibe,
        contentType: _state.contentType,
        sourceUrl: _state.sourceUrl || undefined,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.warn("[inf-wizard] start failed:", j);
  } catch (e) {
    console.warn("[inf-wizard] start threw:", e.message);
  }
}

function resetStages() {
  if (!_root) return;
  for (const row of _root.querySelectorAll(".inf-stage-row")) {
    row.dataset.status = "pending";
    const status = row.querySelector(".inf-stage-status");
    if (status) status.textContent = "pending";
  }
  const results = _root.querySelector("#inf-results");
  if (results) results.replaceChildren();
}

/* Bridge subscriptions are added in Task 14 (events handler). */
Bridge.on("influencer.wizard.show", () => show());
```

- [ ] **Step 2: Smoke-check syntax**

```bash
node --check influencer-wizard-panel.js
```

Expected: no output.

- [ ] **Step 3: Quick browser smoke**

Open the HUD. In the console:

```js
import("./influencer-wizard-panel.js").then(m => m.show());
```

Expected: panel slides in from the right, four questions visible, GO button disabled until all three chip rows have a selection. Click each chip — `is-active` highlight applies. Type a URL — state updates. Close button hides.

- [ ] **Step 4: Stage**

```bash
git add influencer-wizard-panel.js
```

---

### Task 13: Voice-transcript → chip auto-fill

**Files:**
- Modify: `influencer-wizard-panel.js`

- [ ] **Step 1: Add the auto-fill listener**

Append to `influencer-wizard-panel.js`, just before the `Bridge.on(...)` line at the bottom:

```js
/** Map a Whisper partial transcript onto the four wizard fields. The wizard
 *  subscribes to the bridge's `jarvis.stream.sentence` events while the panel
 *  is open (TtsPipeline mirrors STT partials to that channel via voice.js).
 *  Matching is permissive — the operator can over-speak any chip and click
 *  the desired value to override. */
function parseTranscriptIntoState(text) {
  if (!_root || _root.hidden) return;
  const t = String(text || "").toLowerCase();
  /* Sex */
  if (/\b(male|man|guy|dude|bloke)\b/.test(t) && !/\bfemale\b/.test(t)) selectChip("sex", "male");
  else if (/\b(female|woman|girl|lady)\b/.test(t)) selectChip("sex", "female");
  else if (/\bother\b/.test(t)) selectChip("sex", "other");
  /* Vibe */
  if (/\bcinematic|cinema\b/.test(t)) selectChip("vibe", "cinematic");
  else if (/\bcandid|phone\b/.test(t)) selectChip("vibe", "candid");
  else if (/\bpolished|commercial\b/.test(t)) selectChip("vibe", "polished");
  else if (/\beditorial|magazine\b/.test(t)) selectChip("vibe", "editorial");
  /* Content type */
  if (/\b(brand|product)\b/.test(t)) selectChip("contentType", "brand-product");
  else if (/\bfaceless\b/.test(t)) selectChip("contentType", "faceless");
  else if (/\bdanc/.test(t)) selectChip("contentType", "dances");
  /* URL — first http(s) URL containing a known social host. */
  const urlMatch = t.match(/https?:\/\/\S*(?:tiktok\.com|instagram\.com|youtube\.com|youtu\.be)\S*/);
  if (urlMatch) {
    const inp = _root.querySelector("#inf-url");
    if (inp) { inp.value = urlMatch[0]; _state.sourceUrl = urlMatch[0]; }
  }
  /* GO trigger phrases (only fire when ready). */
  if (/\b(go|start|do it|fire it|kick off)\b/.test(t) && _state.sex && _state.vibe && _state.contentType) {
    const go = _root.querySelector("#inf-go");
    if (go && !go.hasAttribute("disabled")) go.click();
  }
}

window.addEventListener("jarvis.stream.sentence", (ev) => {
  const text = ev?.detail?.text;
  if (text) parseTranscriptIntoState(text);
});
```

Note: the existing voice pipeline dispatches `jarvis.stream.sentence` (see `tts-pipeline.js:246`) on every assistant sentence; for user-side STT we need a different event. The codebase fires the user transcript via `handleHeard` — not as a DOM event. For now we subscribe to `jarvis.stream.sentence` as a placeholder; the post-implementation manual test (Task 18) will confirm whether the STT partial is reaching the wizard. If it's not, add a `window.dispatchEvent(new CustomEvent("jarvis.stt.partial", { detail: { text } }))` in `voice.js`'s `handleHeard` and switch the listener here to that event. The plan calls this out so the implementer expects a follow-up.

Actually replace the listener above with the one below — wires the STT partial event we'll add in Task 14:

```js
window.addEventListener("jarvis.stt.partial", (ev) => {
  const text = ev?.detail?.text;
  if (text) parseTranscriptIntoState(text);
});
```

- [ ] **Step 2: Stage**

```bash
git add influencer-wizard-panel.js
```

---

### Task 14: Emit `jarvis.stt.partial` from voice.js

**Files:**
- Modify: `voice.js`

- [ ] **Step 1: Locate the live-dictation partial listener**

```bash
grep -n "_dictationOnPartial" voice.js
```

Expected: definition + the setHandlers / setPartialListener call in cyclePassive.

- [ ] **Step 2: Make `_dictationOnPartial` dispatch a window event**

Replace the body of `_dictationOnPartial` (currently writes the partial into the textarea) with the textarea write PLUS a window event so other panels can subscribe:

```js
function _dictationOnPartial(text) {
  try {
    const field = document.getElementById("textInputField");
    if (field) {
      const stripped = WakeParse.containsWake(text) ? WakeParse.extractQuery(text) : text;
      field.value = stripped;
    }
    /* Fan out to any other panel that subscribes to live STT partials
     * (e.g. the influencer wizard's chip auto-fill). */
    window.dispatchEvent(new CustomEvent("jarvis.stt.partial", { detail: { text } }));
  } catch {}
}
```

- [ ] **Step 3: Smoke-check**

```bash
node --check voice.js
```

Expected: no output.

- [ ] **Step 4: Stage**

```bash
git add voice.js
```

---

### Task 15: Pipeline event handlers + result rendering

**Files:**
- Modify: `influencer-wizard-panel.js`

- [ ] **Step 1: Add the handler**

Append to `influencer-wizard-panel.js` after the `jarvis.stt.partial` listener:

```js
/** Update one stage row + append result content for relevant stages. */
function applyPipelineUpdate(data) {
  if (!_root || _root.hidden) return;
  const { stage, status, payload } = data || {};
  if (!stage) return;
  const row = _root.querySelector(`.inf-stage-row[data-stage="${stage}"]`);
  if (row) {
    row.dataset.status = status;
    const s = row.querySelector(".inf-stage-status");
    if (s) s.textContent = status;
  }
  if (status !== "done") return;
  const results = _root.querySelector("#inf-results");
  if (!results) return;
  if (stage === "hero" && payload?.hero_path) {
    const slot = el("div", { class: "inf-result-slot" });
    slot.appendChild(el("h3", {}, "Hero image"));
    const img = el("img", { alt: "Hero image" });
    img.src = safeFileUrl(payload.hero_path);
    slot.appendChild(img);
    results.appendChild(slot);
  } else if (stage === "video" && payload?.clip_path) {
    const slot = el("div", { class: "inf-result-slot" });
    slot.appendChild(el("h3", {}, payload.source === "motion" ? "Motion-control clip" : "Animated clip"));
    const v = el("video", { controls: true, autoplay: true, muted: true, loop: true, playsinline: true });
    v.src = safeFileUrl(payload.clip_path);
    slot.appendChild(v);
    results.appendChild(slot);
  } else if (stage === "caption" && payload?.captions) {
    const slot = el("div", { class: "inf-result-slot" });
    slot.appendChild(el("h3", {}, "Captions"));
    for (const [platform, text] of Object.entries(payload.captions)) {
      const block = el("div", { class: "inf-caption-block" });
      block.append(
        el("div", { class: "inf-caption-block-label" }, platform.toUpperCase()),
        el("div", {}, String(text || "")),
      );
      slot.appendChild(block);
    }
    results.appendChild(slot);
  }
}

/** Resolve a bridge-side local file path into a URL the browser can load.
 *  The bridge serves /output/... statically; we accept absolute paths under
 *  the project's output/ folder and rewrite them to http://localhost:8766/output/<rest>.
 *  Anything else returns "" so we don't request file:// (browser-blocked) or
 *  a random absolute path. */
function safeFileUrl(p) {
  const s = String(p || "");
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  const m = s.match(/\/output\/(.+)$/);
  if (m) return `${BRIDGE_BASE}/output/${m[1]}`;
  return "";
}

Bridge.on("influencer.pipeline.update", (msg) => applyPipelineUpdate(msg.data));
Bridge.on("influencer.pipeline.complete", () => {
  /* Pipeline done — append a footer with REGENERATE and SAVE & USE.
   * SAVE & USE just closes the panel; the locked influencer is already
   * persisted by the orchestrator's lock_influencer step. */
  if (!_root || _root.hidden) return;
  const results = _root.querySelector("#inf-results");
  if (!results || results.querySelector(".inf-footer")) return;
  const footer = el("div", { class: "inf-footer inf-go-row" });
  const regen = el("button", { type: "button", class: "inf-regen-btn" }, "REGENERATE");
  regen.addEventListener("click", onGoClick);
  const save = el("button", { type: "button", class: "inf-save-btn" }, "SAVE & USE");
  save.addEventListener("click", () => hide());
  footer.append(regen, save);
  results.appendChild(footer);
});
```

- [ ] **Step 2: Syntax check**

```bash
node --check influencer-wizard-panel.js
```

Expected: no output.

- [ ] **Step 3: Stage**

```bash
git add influencer-wizard-panel.js
```

---

### Task 16: Ensure bridge serves `/output/...` static files

**Files:**
- Modify: `bridge/server.mjs` (only if not already serving — check first)

- [ ] **Step 1: Check whether the bridge already serves /output**

```bash
grep -n '"/output\|"output/\|req.url.*startsWith("/output' bridge/server.mjs | head -5
```

If the search returns matches showing GET handling for `/output/...`, skip the rest of this task.

- [ ] **Step 2: If absent, add a minimal static handler**

Find a quiet spot near other GET handlers (after `/health/sessions` is fine). Insert:

```js
  /* GET /output/<rest> — read-only static serve from the project's output/
   * folder. Used by the influencer wizard to display generated hero images
   * and clips. Resolves the path safely (no traversal outside output/) and
   * picks a content-type by extension. */
  if (req.url?.startsWith("/output/") && req.method === "GET") {
    const decoded = decodeURIComponent(req.url.slice("/output/".length).split("?")[0]);
    const safeRel = path.posix.normalize(decoded);
    if (safeRel.startsWith("..") || safeRel.startsWith("/")) {
      res.writeHead(400); res.end("bad path"); return;
    }
    const full = path.resolve(path.join(PROJECT_ROOT, "output", safeRel));
    /* Defence: the resolved absolute path must still start with the output dir. */
    if (!full.startsWith(path.resolve(PROJECT_ROOT, "output"))) {
      res.writeHead(400); res.end("bad path"); return;
    }
    try {
      const stat = await fs.promises.stat(full);
      if (!stat.isFile()) { res.writeHead(404); res.end("not a file"); return; }
      const ext = path.extname(full).toLowerCase();
      const type = ({ ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".mp4":"video/mp4", ".webm":"video/webm" })[ext] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      fs.createReadStream(full).pipe(res);
    } catch (e) {
      res.writeHead(404); res.end("not found");
    }
    return;
  }
```

Verify `path`, `fs`, and `PROJECT_ROOT` are already in scope (they are — used elsewhere in `server.mjs`).

- [ ] **Step 3: Syntax check**

```bash
node --check bridge/server.mjs
```

Expected: no output.

- [ ] **Step 4: Stage**

```bash
git add bridge/server.mjs
```

---

### Task 17: End-to-end manual verification

**Files:** (no code changes)

- [ ] **Step 1: Restart bridge + hard-refresh HUD**

```bash
./launch.sh restart
```

Then Cmd+Shift+R on the Jarvis tab.

- [ ] **Step 2: Voice trigger**

Say: "Hey Jarvis, create me an influencer."

Expected: panel slides in from the right (~560px wide). Header reads "CREATE AN INFLUENCER". Three chip rows + URL input + GO button visible. GO disabled.

- [ ] **Step 3: Click-fill the chips and GO**

Click `female`, `cinematic`, `dances`. GO becomes enabled. Leave the URL empty. Click GO.

Expected:
- Progress strip appears with four rows in `pending`.
- `refs` flips to `running` ~immediately. ~25s later flips to `done` and a reference image isn't shown (no result slot fires for `refs`).
- `hero` flips to `running` next. `caption` flips to `running` in parallel (verify by watching both rows tick at once).
- `caption` finishes first (~2-3s). Caption block appears in results.
- `hero` finishes (~15s). Hero image appears in results.
- `video` flips to `running`. Animated clip finishes (~30s). Clip appears in results, auto-plays muted/looped.
- Footer with REGENERATE + SAVE & USE appears.

- [ ] **Step 4: Voice-fill test**

REGENERATE → progress resets. Say: "male, polished, brand product." Then "go."

Expected: chips highlight as you speak; once all three are set, "go" fires the GO button automatically. Pipeline runs again.

- [ ] **Step 5: Motion-control path**

REGENERATE → paste a TikTok URL into the URL input. Click GO.

Expected: `video` row uses `recreate_video_with_influencer` (Kling). Result label reads "Motion-control clip". If Kling fails, panel auto-falls-back to animation and labels the clip "Animated clip" instead.

- [ ] **Step 6: Stage remaining changes**

```bash
git status
git add -u
```

(Do NOT `git commit` — see plan header policy.)

---

## Self-Review

**Spec coverage:**

- Wizard slide-in side panel reusing news-panel CSS family → Tasks 10, 11, 12
- Four questions (sex / vibe / content type / URL) with chip + voice input → Tasks 12, 13, 14
- Auto-lock ref #1 → Task 1 (`runPipeline` calls `lockInfluencer({ ref_idx: 0 })` after a count:1 `createInfluencer`)
- Parallel hero + caption → Task 1 (`heroPromise` and `captionPromise` started independently); Task 4 explicitly tests it
- Motion-control video when URL provided, animation otherwise → Task 1 branches on `answers.sourceUrl`
- Motion-control failure falls back to animation → Task 1; Task 3 tests it
- `influencer.pipeline.update` events at every stage transition → Task 1's `emit()` helper
- Voice fast-path "create me an influencer" → Task 8
- Tool registration + ALWAYS_ON → Tasks 5, 9
- POST `/api/influencer/pipeline/start` → Task 7
- Result rendering (image / video / caption) → Task 15
- Static serving of generated files → Task 16
- Error handling for each failure mode in spec table → Task 1 (refs/lock/hero), Task 3 (motion fallback), Task 15 (UI rendering of `skipped`)
- Manual end-to-end verification → Task 17

**Placeholder scan:** No `TBD`, `TODO`, `implement later`, or "similar to Task N" refs. The Task 13 transcript-event story is fully resolved within the task (writes the placeholder listener, then immediately rewrites it to the real `jarvis.stt.partial` event after Task 14 adds the dispatch). Both the listener and the dispatcher are shown in full.

**Type consistency:** The orchestrator `deps` keys (`createInfluencer`, `lockInfluencer`, `generateTeaserImage`, `animateTeaserImage`, `recreateVideoWithInfluencer`, `generateSocialCaptions`) match exactly across Task 1's implementation, Task 1's test mocks, Task 6's executeTool wiring, and the spec's named tool list. Event type `influencer.pipeline.update` and stage names (`refs`, `hero`, `video`, `caption`) match across orchestrator emit calls (Task 1), test assertions (Tasks 1-4), and HUD handler (Task 15).
