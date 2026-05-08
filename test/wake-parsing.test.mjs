/** test/wake-parsing.test.mjs - Wake-word + utterance-classifier coverage.
 *
 *  WakeParse is on the hot path of every passive cycle: Whisper transcribes,
 *  containsWake() decides whether the operator triggered Jarvis. A regex
 *  drift here means either every utterance triggers (false positive
 *  paranoia) or nothing triggers (operator said "hey jarvis" all night and
 *  nothing happened — exactly the bug we hit when WHISPER_URL was missing).
 *
 *  Tests pin:
 *    - canonical wake-phrase forms (with + without hyphen, all-lower, mixed case)
 *    - common Whisper mishearings caught by JARVIS_FUZZY_PATTERNS
 *    - extractQuery strip of wake + leading filler
 *    - quickExtractSubject for "of/from the X" phrasings
 *    - isAffirmative / isDismissal helpers used by the inbox + conversation
 *      follow-up paths
 *    - setBrand() with non-Jarvis agent names — fuzzy patterns must NOT
 *      apply when the brand is something else
 */

import { describe, expect, it, beforeEach } from "vitest";
import * as WakeParse from "../wake-parsing.js";

beforeEach(() => {
  /* Each test starts with the default Jarvis brand state. setBrand is
   * idempotent so repeated calls reset cleanly. */
  WakeParse.setBrand({
    agentName: "Jarvis",
    wakeVariants: ["jarvis", "hey jarvis", "jervis", "jarviz"],
  });
});

describe("WakeParse.containsWake — canonical forms", () => {
  const positives = [
    "hey jarvis",
    "Hey Jarvis",
    "HEY JARVIS",
    "jarvis, what's the time?",
    "ok jarvis are you there",
    "hi jarvis can you help",
    "jarvis",
  ];
  for (const text of positives) {
    it(`matches "${text}"`, () => {
      expect(WakeParse.containsWake(text)).toBe(true);
    });
  }
});

describe("WakeParse.containsWake — fuzzy mishearings (Whisper)", () => {
  /* Real shapes Whisper has produced for "hey jarvis" on quiet / accented
   * speech. JARVIS_FUZZY_PATTERNS exists specifically for this — drift
   * here means the operator shouts at the kiosk and nothing answers. */
  const positives = [
    "hey jervis",
    "hey jarviz",
    "hey jarves",
    "ay jarvis",
    "hi jarvis",
    "ok jervis",
    "yo jarvis",
  ];
  for (const text of positives) {
    it(`fuzzy-matches "${text}"`, () => {
      expect(WakeParse.containsWake(text)).toBe(true);
    });
  }
});

describe("WakeParse.containsWake — negatives", () => {
  /* Phrases that should NOT trigger wake. False-positives mean Jarvis
   * jumps in mid-conversation (operator's on a phone call etc) — terrible UX. */
  const negatives = [
    "",
    "the weather is nice today",
    "what time is the meeting",
    "looking at flat surfaces",
    "I had an out-of-office reply",
    "thanks for the update",
  ];
  for (const text of negatives) {
    it(`does NOT match "${text}"`, () => {
      expect(WakeParse.containsWake(text)).toBe(false);
    });
  }
});

describe("WakeParse.containsWake — non-Jarvis brand", () => {
  it("uses only configured wakeVariants when agent isn't Jarvis", () => {
    WakeParse.setBrand({ agentName: "Astro", wakeVariants: ["hey astro", "astro"] });
    expect(WakeParse.containsWake("hey astro")).toBe(true);
    expect(WakeParse.containsWake("astro, what's the time?")).toBe(true);
    /* The Jarvis fuzzy patterns must NOT apply to other brands. */
    expect(WakeParse.containsWake("hey jervis")).toBe(false);
    expect(WakeParse.containsWake("hey jarviz")).toBe(false);
  });
});

describe("WakeParse.extractQuery", () => {
  it("strips wake + leading filler", () => {
    expect(WakeParse.extractQuery("hey jarvis what's the time")).toBe("what's the time");
    expect(WakeParse.extractQuery("Jarvis please show me the diary")).toBe("show me the diary");
    expect(WakeParse.extractQuery("jarvis can you check the weather")).toBe("check the weather");
  });
  it("handles trailing punctuation in wake variants", () => {
    expect(WakeParse.extractQuery("hey jarvis, what's the weather")).toBe(", what's the weather");
  });
  it("returns empty when input is just the wake word", () => {
    expect(WakeParse.extractQuery("jarvis")).toBe("");
    expect(WakeParse.extractQuery("hey jarvis")).toBe("");
  });
  it("safe on empty / null / undefined", () => {
    expect(WakeParse.extractQuery("")).toBe("");
    expect(WakeParse.extractQuery(null)).toBe("");
    expect(WakeParse.extractQuery(undefined)).toBe("");
  });
});

describe("WakeParse.quickExtractSubject", () => {
  it("matches 'of yesterday's X shoot' patterns", () => {
    const s = WakeParse.quickExtractSubject("cut a teaser of yesterday's Bentley shoot");
    expect(s).toContain("Bentley");
  });
  it("matches 'for X for instagram' patterns", () => {
    const s = WakeParse.quickExtractSubject("make a hero featuring the Aston Martin for instagram");
    expect(s).toBeTruthy();
    expect(s.length).toBeGreaterThanOrEqual(3);
  });
  it("returns null for queries without a clean subject", () => {
    expect(WakeParse.quickExtractSubject("what's the time")).toBeNull();
    expect(WakeParse.quickExtractSubject("hello there")).toBeNull();
  });
  it("rejects subjects too short or too long", () => {
    /* The pattern should reject "of an X" where X is 1-2 chars. */
    expect(WakeParse.quickExtractSubject("of a")).toBeNull();
  });
});

describe("WakeParse.isAffirmative", () => {
  const yes = ["yes", "yeah", "yep", "sure", "ok", "okay", "go ahead", "do it", "please", "sounds good"];
  for (const q of yes) {
    it(`treats "${q}" as affirmative`, () => {
      expect(WakeParse.isAffirmative(q)).toBe(true);
    });
  }
  const no = ["no", "nope", "cancel", "stop", "not now", "later"];
  for (const q of no) {
    it(`does NOT treat "${q}" as affirmative`, () => {
      expect(WakeParse.isAffirmative(q)).toBe(false);
    });
  }
});

describe("WakeParse.isDismissal", () => {
  const dismissals = [
    "that's all",
    "thats all",
    "that's it",
    "that's enough",
    "thanks that's all",
    "no more questions",
    "goodbye",
    "bye",
    "bye jarvis",
    "stop listening",
    "quit listening",
  ];
  for (const q of dismissals) {
    it(`treats "${q}" as dismissal`, () => {
      expect(WakeParse.isDismissal(q)).toBe(true);
    });
  }
  const not = ["yes", "what's next", "tell me more", "and another thing"];
  for (const q of not) {
    it(`does NOT treat "${q}" as dismissal`, () => {
      expect(WakeParse.isDismissal(q)).toBe(false);
    });
  }
});

describe("WakeParse.brandState diagnostic", () => {
  it("exposes the loaded agent name + wake variants", () => {
    const s = WakeParse.brandState();
    expect(s.agentName).toBe("Jarvis");
    expect(s.wakeVariants).toEqual(expect.arrayContaining(["jarvis", "hey jarvis"]));
  });
  it("returns a copy, not the live array", () => {
    const s = WakeParse.brandState();
    s.wakeVariants.push("MUTATED");
    /* If brandState returned the live ref, this push would persist. */
    const s2 = WakeParse.brandState();
    expect(s2.wakeVariants).not.toContain("MUTATED");
  });
});
