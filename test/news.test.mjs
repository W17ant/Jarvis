/** test/news.test.mjs — unit tests for bridge/news.mjs */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name) => readFileSync(path.join(HERE, "fixtures/news", name), "utf8");

import { parseRss, parseHnItem, normaliseHeadline, mergeAndDedupe, fetchAll } from "../bridge/news.mjs";
import { start, stop, getCached, refresh } from "../bridge/news.mjs";

describe("parseRss", () => {
  it("parses Sky News items with CDATA titles", () => {
    const items = parseRss(FIX("sky.xml"), "sky");
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: "UK weather: storms expected across the south",
      url: "https://news.sky.com/story/uk-weather-storms-1",
      source: "sky",
    });
    expect(items[0].publishedAt).toBeGreaterThan(0);
  });

  it("parses BBC items with plain titles", () => {
    const items = parseRss(FIX("bbc.xml"), "bbc");
    expect(items).toHaveLength(2);
    expect(items[0].title).toMatch(/UK weather/i);
    expect(items[0].source).toBe("bbc");
  });

  it("parses Guardian items", () => {
    const items = parseRss(FIX("guardian.xml"), "guardian");
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("guardian");
  });

  it("returns empty array on malformed XML", () => {
    const items = parseRss("not xml at all", "sky");
    expect(items).toEqual([]);
  });
});

describe("normaliseHeadline", () => {
  it("lowercases and strips punctuation", () => {
    expect(normaliseHeadline("UK Weather: Storms Expected!"))
      .toBe("uk weather storms expected");
  });

  it("caps at 40 chars", () => {
    const long = "a".repeat(100);
    expect(normaliseHeadline(long)).toHaveLength(40);
  });

  it("returns empty for empty input", () => {
    expect(normaliseHeadline("")).toBe("");
    expect(normaliseHeadline(null)).toBe("");
  });
});

describe("mergeAndDedupe", () => {
  it("returns newest-first across sources", () => {
    const sky = [{ title: "A", url: "u1", source: "sky", publishedAt: 1000 }];
    const bbc = [{ title: "B", url: "u2", source: "bbc", publishedAt: 2000 }];
    const merged = mergeAndDedupe([sky, bbc]);
    expect(merged.map(m => m.title)).toEqual(["B", "A"]);
  });

  it("drops duplicates by normalised headline, keeping the newer one", () => {
    const sky = [{ title: "UK weather: storms expected across the south", url: "u1", source: "sky", publishedAt: 1000 }];
    const bbc = [{ title: "UK weather: Storms expected across the south of England!", url: "u2", source: "bbc", publishedAt: 2000 }];
    const merged = mergeAndDedupe([sky, bbc]);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("bbc");
  });

  it("respects the limit argument", () => {
    const arr = Array.from({ length: 30 }, (_, i) => ({
      title: `story ${i}`, url: `u${i}`, source: "sky", publishedAt: 1000 + i,
    }));
    expect(mergeAndDedupe([arr], 5)).toHaveLength(5);
  });
});

describe("parseHnItem", () => {
  it("normalises a valid HN story", () => {
    const raw = JSON.parse(FIX("hn-item-43000001.json"));
    const item = parseHnItem(raw);
    expect(item).toMatchObject({
      id: 43000001,
      title: "Show HN: A faster RSS parser written in Rust",
      url: "https://example.com/rust-rss",
      score: 312,
    });
    expect(item.publishedAt).toBeGreaterThan(0);
  });

  it("returns null for non-story types", () => {
    expect(parseHnItem({ type: "comment", title: "x", url: "y" })).toBeNull();
  });

  it("returns null for items missing title or url", () => {
    expect(parseHnItem({ type: "story", title: "x" })).toBeNull();
    expect(parseHnItem(null)).toBeNull();
  });
});

describe("fetchAll", () => {
  it("returns parsed items per source via injected fetch", async () => {
    const mockFetch = async (url) => {
      if (url.includes("skynews.com"))   return mockResp(FIX("sky.xml"));
      if (url.includes("bbci.co.uk"))    return mockResp(FIX("bbc.xml"));
      if (url.includes("theguardian"))   return mockResp(FIX("guardian.xml"));
      if (url.endsWith("topstories.json")) return mockResp(FIX("hn-topstories.json"));
      if (url.includes("/item/43000001")) return mockResp(FIX("hn-item-43000001.json"));
      if (url.includes("/item/43000002")) return mockResp(FIX("hn-item-43000002.json"));
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await fetchAll({ fetchImpl: mockFetch });
    expect(result.errors.sky).toBeNull();
    expect(result.errors.bbc).toBeNull();
    expect(result.errors.guardian).toBeNull();
    expect(result.errors.hn).toBeNull();
    expect(result.topStories.length).toBeGreaterThan(0);
    expect(result.hn).toHaveLength(2);
    expect(result.hn[0].title).toMatch(/Rust|OpenAI/);
  });

  it("records per-source errors without failing the whole call", async () => {
    const mockFetch = async (url) => {
      if (url.includes("skynews.com")) throw new Error("network down");
      if (url.includes("bbci.co.uk"))  return mockResp(FIX("bbc.xml"));
      if (url.includes("theguardian")) return mockResp(FIX("guardian.xml"));
      if (url.endsWith("topstories.json")) return mockResp(FIX("hn-topstories.json"));
      if (url.includes("/item/")) return mockResp(FIX("hn-item-43000001.json"));
      throw new Error(`unexpected: ${url}`);
    };
    const result = await fetchAll({ fetchImpl: mockFetch });
    expect(result.errors.sky).toMatch(/network down/);
    expect(result.errors.bbc).toBeNull();
    expect(result.topStories.length).toBeGreaterThan(0);
  });
});

function mockResp(body) {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

describe("cache lifecycle", () => {
  it("getCached returns an empty shape before any fetch", () => {
    stop();
    const c = getCached();
    expect(c.topStories).toEqual([]);
    expect(c.hn).toEqual([]);
    expect(c.fetchedAt.sky).toBe(0);
  });

  it("refresh() with injected fetch populates the cache", async () => {
    stop();
    const mockFetch = async (url) => {
      if (url.includes("skynews"))     return mockResp(FIX("sky.xml"));
      if (url.includes("bbci"))        return mockResp(FIX("bbc.xml"));
      if (url.includes("theguardian")) return mockResp(FIX("guardian.xml"));
      if (url.endsWith("topstories.json")) return mockResp(FIX("hn-topstories.json"));
      if (url.includes("/item/43000001")) return mockResp(FIX("hn-item-43000001.json"));
      if (url.includes("/item/43000002")) return mockResp(FIX("hn-item-43000002.json"));
      throw new Error(`unexpected: ${url}`);
    };
    await refresh({ fetchImpl: mockFetch });
    const c = getCached();
    expect(c.topStories.length).toBeGreaterThan(0);
    expect(c.hn.length).toBe(2);
    expect(c.fetchedAt.sky).toBeGreaterThan(0);
  });

  it("keeps last good cache when a later refresh fails", async () => {
    stop();
    const goodFetch = async (url) => {
      if (url.includes("skynews"))     return mockResp(FIX("sky.xml"));
      if (url.includes("bbci"))        return mockResp(FIX("bbc.xml"));
      if (url.includes("theguardian")) return mockResp(FIX("guardian.xml"));
      if (url.endsWith("topstories.json")) return mockResp(FIX("hn-topstories.json"));
      if (url.includes("/item/")) return mockResp(FIX("hn-item-43000001.json"));
      throw new Error(`unexpected: ${url}`);
    };
    await refresh({ fetchImpl: goodFetch });
    const before = getCached();
    expect(before.topStories.length).toBeGreaterThan(0);

    const failFetch = async () => { throw new Error("all down"); };
    await refresh({ fetchImpl: failFetch });
    const after = getCached();
    expect(after.topStories.length).toBe(before.topStories.length);
    expect(after.errors.sky).toMatch(/all down/);
  });
});
