/** action-tag.test.mjs - vitest coverage for the [ACTION:X] fallback parser.
 *
 *  Action tags are the belt-and-braces path for when Qwen2.5 emits a tool
 *  call as inline literal text instead of a structured tool_calls array.
 *  Each test pins an expected behaviour: tag detection, arg parsing
 *  (JSON + key=value forms), graceful skip on malformed args, and clean
 *  stripping so the spoken text never includes the literal tag syntax.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../bridge/action-tag.mjs";

describe("action-tag parser", () => {
  it("returns input unchanged when no tags present", () => {
    const r = parse("Hello sir, the weather is fine.");
    expect(r.stripped).toBe("Hello sir, the weather is fine.");
    expect(r.calls).toEqual([]);
  });

  it("handles non-string input safely", () => {
    expect(parse(null).calls).toEqual([]);
    expect(parse(undefined).calls).toEqual([]);
    expect(parse(123).calls).toEqual([]);
  });

  it("parses a bare tag with no args", () => {
    const r = parse("Got it. [ACTION:get_upcoming_events] Let me check.");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("get_upcoming_events");
    expect(r.calls[0].args).toEqual({});
    expect(r.stripped).toBe("Got it. Let me check.");
  });

  it("parses a tag with JSON args", () => {
    const r = parse('Looking up. [ACTION:get_weather {"location":"London"}] Done.');
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("get_weather");
    expect(r.calls[0].args).toEqual({ location: "London" });
    expect(r.stripped).toBe("Looking up. Done.");
  });

  it("parses a tag with simple key=value args", () => {
    const r = parse("[ACTION:set_timer minutes=5 label=tea]");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0].name).toBe("set_timer");
    expect(r.calls[0].args).toEqual({ minutes: "5", label: "tea" });
  });

  it("parses multiple tags in one stream", () => {
    const r = parse('[ACTION:get_mail_summary] then [ACTION:list_reminders {"listName":"Work"}]');
    expect(r.calls.length).toBe(2);
    expect(r.calls[0].name).toBe("get_mail_summary");
    expect(r.calls[1].name).toBe("list_reminders");
    expect(r.calls[1].args).toEqual({ listName: "Work" });
  });

  it("drops the tag (and its call) when JSON args are malformed", () => {
    const r = parse('[ACTION:bad_tool {not json}]');
    /* Malformed JSON inside braces — we reject the whole tag rather than
     * fire with garbage args. The tag is stripped; the call list is
     * empty so nothing dispatches. */
    expect(r.calls).toEqual([]);
    expect(r.stripped).toBe("");
  });

  it("preserves text on either side of a tag", () => {
    const r = parse("Sure thing. [ACTION:open_url url=https://example.com] On its way.");
    expect(r.calls.length).toBe(1);
    expect(r.stripped).toBe("Sure thing. On its way.");
  });

  it("collapses double spaces left by tag removal", () => {
    /* When a tag was preceded AND followed by a space, removing it leaves
     * a "  " — the parser collapses to a single space. */
    const r = parse("Hello   [ACTION:ping]   world");
    expect(r.stripped).toBe("Hello world");
  });

  it("ignores tags with non-identifier names", () => {
    /* "[ACTION:123-bad]" doesn't match the [a-zA-Z_][a-zA-Z0-9_]* identifier
     * regex — pass through as plain text. */
    const r = parse("[ACTION:123-bad]");
    expect(r.calls).toEqual([]);
    expect(r.stripped).toBe("[ACTION:123-bad]");
  });
});
