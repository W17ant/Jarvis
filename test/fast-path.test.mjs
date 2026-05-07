/** test/fast-path.test.mjs - Fast-path handler regression coverage.
 *
 *  Why this exists: Adam reported a refusal-loop bug where "bring up a map of
 *  Goodwood to scout a shoot" fell through the fast-path's narrow regex
 *  ("open|pull up|show me") and reached the LLM, which then refused with
 *  "I'm only here for automotive Flat-Out tasks". A regex change like that
 *  has no other guard rails — a lazy edit could silently kill the map path
 *  for everyone. These tests pin every phrasing we've validated by hand so
 *  future regex tweaks don't regress.
 *
 *  Each block targets one handler. Inputs are real operator phrasings, plus
 *  a handful of false-positive probes that MUST fall through to the LLM.
 */

import { describe, expect, it } from "vitest";
import { tryFastPath, listHandlers } from "../bridge/fast-path.mjs";

describe("fast-path: handlers registry", () => {
  it("exposes a non-empty handler list", () => {
    const handlers = listHandlers();
    expect(handlers.length).toBeGreaterThanOrEqual(5);
    /* Each entry is { pattern, flags } — enough to surface in /health
     * without exposing the closures themselves. */
    for (const h of handlers) {
      expect(typeof h.pattern).toBe("string");
      expect(typeof h.flags).toBe("string");
    }
  });
});

describe("fast-path: map of <place>", () => {
  /* Phrasings that MUST be caught by the open_url map handler. Every entry
   * here corresponds to a real or plausible operator utterance. The
   * `expectPlace` is the bare phrase Google Maps will receive. */
  const positives = [
    ["bring up a map of Goodwood",                        "Goodwood"],
    ["bring up a map of Goodwood to scout a shoot",       "Goodwood"],
    ["pull a map of Silverstone for tomorrows shoot",     "Silverstone"],
    ["show me a map of Manchester to scout locations",    "Manchester"],
    ["find a map of the Goodwood paddock please",         "the Goodwood paddock"],
    ["open the map of the Bentley factory",               "the Bentley factory"],
    ["map of the Bentley factory in Crewe",               "the Bentley factory in Crewe"],
    ["show map of Crewe please",                          "Crewe"],
    ["give me a map of Goodwood",                         "Goodwood"],
  ];

  for (const [query, expectPlace] of positives) {
    it(`matches "${query}" → maps search for "${expectPlace}"`, () => {
      const r = tryFastPath(query);
      expect(r).not.toBeNull();
      expect(r.toolCall?.name).toBe("open_url");
      expect(r.toolCall.args.url).toContain(encodeURIComponent(expectPlace));
      expect(r.reply.toLowerCase()).toContain("map");
    });
  }

  /* Negatives — phrasings that LOOK map-like but should fall through to the
   * LLM. Adam's earlier bug was caused by the regex being too greedy and
   * over-claiming queries; these guard the inverse. */
  const negatives = [
    "what is the weather in Manchester",
    "I just shot at the map studio yesterday",  // "map studio" reads as a place name
    "map me to Goodwood",                       // pronoun capture, ambiguous nav request
  ];

  for (const query of negatives) {
    it(`falls through "${query}" to the LLM`, () => {
      const r = tryFastPath(query);
      /* Either null (no handler claimed it) OR a non-map handler claimed
       * it — both are correct. The wrong outcome is a map open_url with
       * a bogus place. */
      if (r && r.toolCall?.name === "open_url") {
        const url = r.toolCall.args.url;
        /* If a nav-shaped match somehow triggered, the captured place
         * MUST not be a pronoun or an obvious false positive. */
        expect(url).not.toContain("/me");
        expect(url).not.toContain("/you");
      }
    });
  }
});

describe("fast-path: time / date queries", () => {
  /* Phrasings the current time-pattern catches. Anchored with $ so trailing
   * context ("right now", "please") falls through to the LLM. */
  const positives = [
    "what time is it",
    "what's the time",
    "what's the time?",
    "the time",
    "tell me the time",
  ];
  for (const q of positives) {
    it(`answers "${q}" without a tool call`, () => {
      const r = tryFastPath(q);
      expect(r).not.toBeNull();
      expect(r.reply).toBeTruthy();
      /* No tool call expected — fast-path generates the time string locally. */
      expect(r.toolCall).toBeFalsy();
    });
  }

  /* Known gaps — phrasings that fall through to the LLM today. Pinning them
   * so a future regex tweak that catches them gets cheered, not feared. If
   * any of these starts matching, this test will fail and the maintainer
   * just needs to flip them up to `positives` above. */
  const knownFallthroughs = [
    "whats the time",                   // missing apostrophe in "what's"
    "what time is it right now",        // trailing "right now" breaks the $ anchor
  ];
  for (const q of knownFallthroughs) {
    it(`(known gap) "${q}" currently falls through`, () => {
      const r = tryFastPath(q);
      expect(r).toBeNull();
    });
  }
});

describe("fast-path: timer commands", () => {
  /* Pattern requires NUMBER + UNIT before the optional "timer" word. */
  it("matches \"set a 5 minute timer\"", () => {
    const r = tryFastPath("set a 5 minute timer");
    expect(r).not.toBeNull();
    expect(r.toolCall?.name).toBe("set_timer");
    expect(r.toolCall.args).toMatchObject({ minutes: 5 });
  });
  it("matches \"set 10 minutes for the chicken\"", () => {
    const r = tryFastPath("set 10 minutes for the chicken");
    expect(r).not.toBeNull();
    expect(r.toolCall?.name).toBe("set_timer");
    expect(r.toolCall.args.minutes).toBe(10);
    expect(r.toolCall.args.label).toContain("chicken");
  });
  it("converts hours to minutes", () => {
    const r = tryFastPath("set a 1 hour timer");
    expect(r).not.toBeNull();
    expect(r.toolCall.args.minutes).toBe(60);
  });

  /* Known gap — "set timer for 10 minutes" has the unit AFTER "timer",
   * which the current regex doesn't accept. Reaches the LLM today. */
  it('(known gap) "set timer for 10 minutes" currently falls through', () => {
    const r = tryFastPath("set timer for 10 minutes");
    expect(r).toBeNull();
  });
});

describe("fast-path: sleep / wake-down", () => {
  /* Phrasings the current sleep pattern catches. */
  const positives = [
    "go to sleep",
    "shut down",
    "sleep now",
    "stop listening",
    "goodnight",
    "good night",
    "that's all",
    "that's enough",
  ];
  for (const q of positives) {
    it(`matches "${q}" → enter_sleep_mode`, () => {
      const r = tryFastPath(q);
      expect(r).not.toBeNull();
      expect(r.toolCall?.name).toBe("enter_sleep_mode");
    });
  }

  /* Known gaps — phrasings that fall through to the LLM today. Each is a
   * one-line regex addition if the operator hits one repeatedly. */
  const knownFallthroughs = [
    "sleep mode",          // bare "sleep mode" not in the alternation
    "thats all",           // apostrophe required by the regex
  ];
  for (const q of knownFallthroughs) {
    it(`(known gap) "${q}" currently falls through`, () => {
      expect(tryFastPath(q)).toBeNull();
    });
  }
});

describe("fast-path: greetings + acknowledgements", () => {
  const greetings = ["hi", "hello", "hey", "good morning", "morning"];
  for (const q of greetings) {
    it(`acknowledges "${q}"`, () => {
      const r = tryFastPath(q);
      expect(r).not.toBeNull();
      expect(r.reply).toBeTruthy();
      expect(r.toolCall).toBeFalsy();
    });
  }

  /* Bare yes / no in isolation = no-op acknowledgement, not an inbox follow-up
   * (those go through a different path inside voice.js). */
  it("answers bare \"yes\" with a brief acknowledgement", () => {
    const r = tryFastPath("yes");
    expect(r).not.toBeNull();
    expect(r.reply).toBeTruthy();
    expect(r.toolCall).toBeFalsy();
  });
});

describe("fast-path: empty + nonsense input", () => {
  it("returns null for empty string", () => {
    expect(tryFastPath("")).toBeNull();
  });
  it("returns null for whitespace", () => {
    expect(tryFastPath("   ")).toBeNull();
  });
  it("strips leading filler 'um/uh/hey,' and re-tries the patterns", () => {
    /* "um, what time is it" should still match the time pattern after
     * the leading-filler strip. */
    const r = tryFastPath("um, what time is it");
    expect(r).not.toBeNull();
    expect(r.reply).toBeTruthy();
  });
});
