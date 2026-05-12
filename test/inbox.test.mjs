/** inbox.test.mjs - vitest coverage for the Smart Inbox aggregator.
 *
 *  Pure-logic tests against the normaliser + cache + sort behaviour.
 *  We mock the source handlers (mail / calendar / reminders) at the
 *  module's setSources hook so the tests don't depend on a running
 *  bridge OR on Apple Mail / Calendar being populated.
 */

import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function freshImport() {
  const { pathToFileURL } = await import("node:url");
  const filePath = path.resolve(HERE, "..", "bridge", "inbox.mjs");
  const url = new URL(pathToFileURL(filePath));
  url.searchParams.set("t", String(Date.now()));
  return await import(url.href);
}

const MAIL_FIX = [
  { id: "m1", from: "Sarah <sarah@client.com>", subject: "Audit follow-up", dateMs: Date.now() - 60 * 60 * 1000, unread: true, preview: "Quick question on section 4" },
  { id: "m2", from: "newsletter@bigcorp.com", subject: "Weekly digest", dateMs: Date.now() - 30 * 60 * 1000, unread: false, preview: null },
];

const NEAR_EVENT = { id: "e1", title: "Standup", startMs: Date.now() + 15 * 60 * 1000, organiser: "team" };
const FAR_EVENT = { id: "e2", title: "Quarterly review", startMs: Date.now() + 4 * 60 * 60 * 1000, organiser: "ops" };

describe("inbox aggregator", () => {
  let Inbox;

  beforeEach(async () => {
    Inbox = await freshImport();
    /* clearSources resets every wired handler + nukes the cache so
     * sub-ms Date.now() collisions in freshImport don't leak previous
     * tests' mocks into this one. */
    Inbox.clearSources();
  });

  it("returns empty when no sources are wired", async () => {
    const r = await Inbox.aggregate();
    expect(r.items).toEqual([]);
    expect(r.sources).toEqual({ mail: 0, events: 0, reminders: 0 });
  });

  it("aggregates mail + events into a normalised item list", async () => {
    Inbox.setSources({
      getMailSummary: async () => ({ ok: true, messages: MAIL_FIX }),
      getUpcomingEvents: async () => ({ ok: true, events: [NEAR_EVENT, FAR_EVENT] }),
    });
    const r = await Inbox.aggregate();
    expect(r.items.length).toBe(4);
    /* Imminent event should be first under default sort. */
    expect(r.items[0].kind).toBe("event");
    expect(r.items[0].what).toBe("Standup");
    expect(r.items[0].urgency_hints.isImminent).toBe(true);
    /* Counts should reflect the source. */
    expect(r.sources).toEqual({ mail: 2, events: 2, reminders: 0 });
  });

  it("normalises email rows with all required fields", async () => {
    Inbox.setSources({
      getMailSummary: async () => ({ ok: true, messages: [MAIL_FIX[0]] }),
    });
    const r = await Inbox.aggregate();
    const m = r.items[0];
    expect(m.kind).toBe("email");
    expect(m.who).toBe(MAIL_FIX[0].from);
    expect(m.what).toBe(MAIL_FIX[0].subject);
    expect(m.urgency_hints.unread).toBe(true);
    expect(m.preview).toBe("Quick question on section 4");
    expect(typeof m.when).toBe("number");
  });

  it("computes minutesAway + isImminent on event normalisation", async () => {
    Inbox.setSources({
      getUpcomingEvents: async () => ({ ok: true, events: [NEAR_EVENT, FAR_EVENT] }),
    });
    const r = await Inbox.aggregate();
    const near = r.items.find((it) => it.what === "Standup");
    const far = r.items.find((it) => it.what === "Quarterly review");
    expect(near.urgency_hints.isImminent).toBe(true);
    expect(far.urgency_hints.isImminent).toBe(false);
    expect(near.urgency_hints.minutesAway).toBeGreaterThan(0);
    expect(near.urgency_hints.minutesAway).toBeLessThan(60);
  });

  it("caches results within the 60s TTL", async () => {
    let mailCallCount = 0;
    Inbox.setSources({
      getMailSummary: async () => { mailCallCount++; return { ok: true, messages: MAIL_FIX }; },
    });
    const r1 = await Inbox.aggregate();
    expect(r1.fromCache).toBe(false);
    const r2 = await Inbox.aggregate();
    expect(r2.fromCache).toBe(true);
    expect(mailCallCount).toBe(1);
  });

  it("force:true bypasses the cache and re-fetches", async () => {
    let mailCallCount = 0;
    Inbox.setSources({
      getMailSummary: async () => { mailCallCount++; return { ok: true, messages: MAIL_FIX }; },
    });
    await Inbox.aggregate();
    const r = await Inbox.aggregate({ force: true });
    expect(r.fromCache).toBe(false);
    expect(mailCallCount).toBe(2);
  });

  it("invalidate() drops the cache", async () => {
    let mailCallCount = 0;
    Inbox.setSources({
      getMailSummary: async () => { mailCallCount++; return { ok: true, messages: MAIL_FIX }; },
    });
    await Inbox.aggregate();
    Inbox.invalidate();
    await Inbox.aggregate();
    expect(mailCallCount).toBe(2);
  });

  it("source failures don't blow up the aggregate", async () => {
    Inbox.setSources({
      getMailSummary: async () => { throw new Error("AppleScript timed out"); },
      getUpcomingEvents: async () => ({ ok: true, events: [NEAR_EVENT] }),
    });
    const r = await Inbox.aggregate();
    /* Mail throws, events succeed — we still get the event. */
    expect(r.items.length).toBe(1);
    expect(r.items[0].kind).toBe("event");
    expect(r.sources.mail).toBe(0);
    expect(r.sources.events).toBe(1);
  });

  it("non-ok source response is treated as empty (not error)", async () => {
    Inbox.setSources({
      getMailSummary: async () => ({ ok: false, error: "Mail not granted" }),
    });
    const r = await Inbox.aggregate();
    expect(r.items.length).toBe(0);
    expect(r.sources.mail).toBe(0);
  });

  it("default sort puts imminent events ahead of further-out items regardless of when", async () => {
    /* This email is older (more recent unix-ms = future) but the imminent event should still win the top slot. */
    const futureMail = { id: "future", from: "x@y", subject: "Z", dateMs: Date.now() + 30 * 60 * 1000 };
    Inbox.setSources({
      getMailSummary: async () => ({ ok: true, messages: [futureMail] }),
      getUpcomingEvents: async () => ({ ok: true, events: [NEAR_EVENT] }),
    });
    const r = await Inbox.aggregate();
    expect(r.items[0].kind).toBe("event");
    expect(r.items[0].urgency_hints.isImminent).toBe(true);
  });

  it("truncates 'what' to 120 chars to keep rows tight", async () => {
    const longSubject = "A".repeat(500);
    Inbox.setSources({
      getMailSummary: async () => ({ ok: true, messages: [{ id: "m", from: "x", subject: longSubject, dateMs: Date.now() }] }),
    });
    const r = await Inbox.aggregate();
    expect(r.items[0].what.length).toBe(120);
  });
});
