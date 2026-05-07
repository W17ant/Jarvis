/** vitest.config.mjs - Test runner config.
 *
 *  Tests live in ./test/*.test.mjs and target the bridge's pure-logic
 *  modules (fast-path, tool-router fallbacks). Anything that needs Ollama,
 *  Whisper, or Kokoro running is a separate integration concern — those
 *  belong in a CI harness, not the fast unit loop here.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.mjs"],
    /* Why node, not jsdom: we test bridge modules that don't touch the DOM.
     * Sticking to node keeps the runner fast and avoids surprises around
     * fetch / globalThis differences. */
    environment: "node",
    /* Most tests are pure logic and finish in <50ms. Tight timeout surfaces
     * accidental network calls or async hangs immediately. */
    testTimeout: 5000,
  },
});
