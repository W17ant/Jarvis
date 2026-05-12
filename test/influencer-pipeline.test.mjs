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
  /* Wrap each override so its calls are still recorded — tests assert against
   * `calls` regardless of whether the fetcher succeeded or failed. */
  const wrappedOverrides = {};
  for (const [name, fn] of Object.entries(overrides)) {
    wrappedOverrides[name] = (args) => { calls.push({ name, args }); return Promise.resolve(fn(args)); };
  }
  return { calls, deps: { ...defaults, ...wrappedOverrides } };
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

describe("runPipeline — hero failure", () => {
  it("does not block caption and skips video when hero fails", async () => {
    const { deps } = makeDeps({
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
