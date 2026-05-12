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
