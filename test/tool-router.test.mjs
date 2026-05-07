/** test/tool-router.test.mjs - Tool-router fallback path coverage.
 *
 *  The embedding-based scoring path needs a live Ollama running nomic-embed,
 *  which isn't appropriate for unit tests. What IS testable in isolation:
 *
 *    1. The "no index" fallback — pickRelevant returns the full TOOLS array
 *       so the chat path stays correct when Ollama is unreachable. This is
 *       the one we MUST not regress: a silently-broken router would mean
 *       only "always-on" tools reach the LLM.
 *    2. The "empty query" fallback — returns the always-on subset.
 *    3. The shape of the result object — bridge code in askLLM /
 *       askLLMStream destructures { tools, picked, scores, elapsedMs,
 *       fallback } and would crash on shape drift.
 *    4. indexStatus() shape for /health.
 *
 *  We don't mock Ollama. If anyone wants integration tests covering the
 *  real cosine path, that's a separate fixture (and lives outside vitest's
 *  fast loop).
 */

import { describe, expect, it } from "vitest";
import { pickRelevant, indexStatus } from "../bridge/tool-router.mjs";

/* Minimal tool fixture — shape mirrors OpenAI function-tool spec which is
 * what bridge/server.mjs's TOOLS uses. */
const FAKE_TOOLS = [
  { type: "function", function: { name: "set_timer",       description: "Start a kitchen timer.", parameters: {} } },
  { type: "function", function: { name: "open_url",        description: "Open a URL in the operator's browser.", parameters: {} } },
  { type: "function", function: { name: "request_browse",  description: "Drive a browser via Playwright + vision.", parameters: {} } },
  { type: "function", function: { name: "video_edit_from_shoot", description: "Cut a teaser from a shoot folder.", parameters: {} } },
  { type: "function", function: { name: "recall",          description: "Recall stored memory.", parameters: {} } },
];

describe("tool-router: fallback paths", () => {
  it("returns full TOOLS when no index is built", async () => {
    /* Without buildIndex() being called, _index is null inside the module.
     * pickRelevant must degrade gracefully. */
    const r = await pickRelevant("anything", FAKE_TOOLS);
    expect(r).toBeDefined();
    expect(r.tools).toHaveLength(FAKE_TOOLS.length);
    expect(r.fallback).toBe("no_index");
    expect(r.picked).toEqual(expect.arrayContaining(FAKE_TOOLS.map((t) => t.function.name)));
  });

  it("preserves the full result shape on fallback", async () => {
    const r = await pickRelevant("anything", FAKE_TOOLS);
    expect(r).toMatchObject({
      tools: expect.any(Array),
      picked: expect.any(Array),
      scores: expect.any(Object),
      elapsedMs: expect.any(Number),
      fallback: expect.any(String),
    });
  });

  it("handles empty query without crashing", async () => {
    /* Empty query with no index built — falls back to no_index path FIRST
     * (the index check happens before the empty-query check). Either way,
     * no exception. */
    const r = await pickRelevant("", FAKE_TOOLS);
    expect(r).toBeDefined();
    expect(r.fallback).toBeTruthy();
  });

  it("handles undefined query without crashing", async () => {
    const r = await pickRelevant(undefined, FAKE_TOOLS);
    expect(r).toBeDefined();
    expect(r.fallback).toBeTruthy();
  });

  it("handles empty TOOLS array without crashing", async () => {
    const r = await pickRelevant("set a timer", []);
    expect(r).toBeDefined();
    expect(r.tools).toHaveLength(0);
    expect(r.picked).toHaveLength(0);
  });
});

describe("tool-router: indexStatus", () => {
  it("returns a stable shape for /health", () => {
    const s = indexStatus();
    expect(s).toBeDefined();
    /* Bridge /health expects ready, toolCount, hash, alwaysOn — keep this
     * pin so a future field rename doesn't silently break the diagnostic. */
    /* hash is null when no index has been built, string after buildIndex —
     * we just check the field exists, since `expect.anything()` doesn't
     * accept null. */
    expect(s).toMatchObject({
      ready: expect.any(Boolean),
      toolCount: expect.any(Number),
      alwaysOn: expect.any(Array),
    });
    expect("hash" in s).toBe(true);
  });
});
