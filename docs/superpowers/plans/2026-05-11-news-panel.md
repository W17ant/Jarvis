# News Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-screen news mode triggered by an LLM tool call. Live Sky News YouTube on the left; merged Sky/BBC/Guardian top stories and Hacker News top tech stories on the right. Pre-fetched on bridge boot and refreshed hourly.

**Architecture:** A new `bridge/news.mjs` module owns RSS/HN fetching, in-memory caching, and a 60-minute refresh interval. Two tools (`show_news_panel`, `hide_news_panel`) registered in `bridge/server.mjs`'s `TOOLS` array drive a new front-end module `news-panel.js` via the existing WebSocket broadcast (`broadcastToClients`). Front-end ducks YouTube volume during TTS by polling `tts.isSpeaking()` every 250 ms — no changes needed to the existing TTS pipeline. The panel slides in from the right edge (CSS transform), can be collapsed back to a 32 px edge-tab via an arrow toggle, and can be resized by dragging its left edge (width persists in localStorage).

**Tech Stack:** Node 18+ built-in `fetch`, new dep `fast-xml-parser`, existing Jarvis WebSocket broadcaster, YouTube IFrame Player API. Front-end DOM construction uses `createElement` / `textContent` for any payload-derived content to prevent XSS even if upstream escaping is bypassed.

**Commit policy for this session:** Per the active no-commit window (Jarvis white-label rebrand staying uncommitted until Adam forks), each task ends in a **stage** step using `git add`, **not** a commit. Do NOT run `git commit` during this implementation. The user will batch commits later.

---

## File Structure

| Path | Role |
|---|---|
| `bridge/news.mjs` (new) | Feed fetchers, parsers, merge/de-dup, cache, refresh scheduler. Pure module; no Express or WS coupling. |
| `bridge/server.mjs` (modify) | Import news module, call `News.start()` on boot, register two tools in `TOOLS`, add executeTool switch cases, add `POST /api/news/refresh` route. |
| `bridge/tool-router.mjs` (modify) | Add `show_news_panel` and `hide_news_panel` to `ALWAYS_ON` set so they reach the LLM regardless of similarity ranking. |
| `news-panel.js` (new) | Front-end module: mounts/unmounts overlay, renders columns, instantiates YT player, ducks volume during TTS, handles refresh + Esc + close. |
| `index.html` (modify) | Add `<div id="news-panel-root">` mount slot + `<script type="module" src="./news-panel.js">`. |
| `styles.css` (modify) | News panel styles — full-screen overlay, 3-column grid, story rows, header. |
| `package.json` (modify) | Add `fast-xml-parser` dependency. |
| `test/news.test.mjs` (new) | Unit tests for parsers, merge/de-dup, cache, refresh error fallback. |
| `test/fixtures/news/sky.xml`, `bbc.xml`, `guardian.xml`, `hn-topstories.json`, `hn-item-43000001.json`, `hn-item-43000002.json` (new) | Sample feed payloads. |

---

### Task 1: Add fast-xml-parser dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dep**

Run from project root:

```bash
npm install --save fast-xml-parser
```

Expected: `package.json` gains `"fast-xml-parser": "^4.x.x"` under `"dependencies"`; `package-lock.json` updates.

- [ ] **Step 2: Verify it imports**

Run:

```bash
node -e "import('fast-xml-parser').then(m => console.log(typeof m.XMLParser))"
```

Expected output: `function`

- [ ] **Step 3: Stage (do not commit)**

```bash
git add package.json package-lock.json
```

---

### Task 2: Create RSS + HN test fixtures

**Files:**
- Create: `test/fixtures/news/sky.xml`
- Create: `test/fixtures/news/bbc.xml`
- Create: `test/fixtures/news/guardian.xml`
- Create: `test/fixtures/news/hn-topstories.json`
- Create: `test/fixtures/news/hn-item-43000001.json`
- Create: `test/fixtures/news/hn-item-43000002.json`

- [ ] **Step 1: Create the fixtures directory**

```bash
mkdir -p test/fixtures/news
```

- [ ] **Step 2: Write sky.xml**

Create `test/fixtures/news/sky.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Sky News Home</title>
    <link>https://news.sky.com</link>
    <item>
      <title><![CDATA[UK weather: storms expected across the south]]></title>
      <link>https://news.sky.com/story/uk-weather-storms-1</link>
      <pubDate>Mon, 11 May 2026 09:00:00 GMT</pubDate>
      <guid>https://news.sky.com/story/uk-weather-storms-1</guid>
    </item>
    <item>
      <title><![CDATA[Markets rally on rate-cut hopes]]></title>
      <link>https://news.sky.com/story/markets-rally-2</link>
      <pubDate>Mon, 11 May 2026 08:30:00 GMT</pubDate>
      <guid>https://news.sky.com/story/markets-rally-2</guid>
    </item>
  </channel>
</rss>
```

- [ ] **Step 3: Write bbc.xml**

Create `test/fixtures/news/bbc.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>BBC News - Home</title>
    <link>https://www.bbc.co.uk/news</link>
    <item>
      <title>UK weather: Storms expected across the south of England</title>
      <description>Forecasters warn of heavy rain.</description>
      <link>https://www.bbc.co.uk/news/uk-1</link>
      <pubDate>Mon, 11 May 2026 09:05:00 GMT</pubDate>
      <guid isPermaLink="false">bbc-uk-1</guid>
    </item>
    <item>
      <title>Premier League title race goes to final day</title>
      <link>https://www.bbc.co.uk/sport/football/final-day-2</link>
      <pubDate>Mon, 11 May 2026 07:50:00 GMT</pubDate>
      <guid isPermaLink="false">bbc-sport-2</guid>
    </item>
  </channel>
</rss>
```

- [ ] **Step 4: Write guardian.xml**

Create `test/fixtures/news/guardian.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Guardian — UK</title>
    <link>https://www.theguardian.com/uk</link>
    <item>
      <title>Chancellor unveils new housing plan</title>
      <link>https://www.theguardian.com/politics/housing-plan-3</link>
      <pubDate>Mon, 11 May 2026 08:45:00 GMT</pubDate>
      <guid>https://www.theguardian.com/politics/housing-plan-3</guid>
    </item>
  </channel>
</rss>
```

- [ ] **Step 5: Write hn-topstories.json**

Create `test/fixtures/news/hn-topstories.json`:

```json
[43000001, 43000002]
```

- [ ] **Step 6: Write hn-item-43000001.json**

Create `test/fixtures/news/hn-item-43000001.json`:

```json
{
  "by": "alice",
  "descendants": 42,
  "id": 43000001,
  "score": 312,
  "time": 1747920000,
  "title": "Show HN: A faster RSS parser written in Rust",
  "type": "story",
  "url": "https://example.com/rust-rss"
}
```

- [ ] **Step 7: Write hn-item-43000002.json**

Create `test/fixtures/news/hn-item-43000002.json`:

```json
{
  "by": "bob",
  "descendants": 18,
  "id": 43000002,
  "score": 145,
  "time": 1747918800,
  "title": "OpenAI announces new reasoning model",
  "type": "story",
  "url": "https://example.com/openai-model"
}
```

- [ ] **Step 8: Stage**

```bash
git add test/fixtures/news
```

---

### Task 3: Build per-source RSS parsers (TDD)

**Files:**
- Create: `bridge/news.mjs`
- Create: `test/news.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `test/news.test.mjs`:

```js
/** test/news.test.mjs — unit tests for bridge/news.mjs */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = (name) => readFileSync(path.join(HERE, "fixtures/news", name), "utf8");

import { parseRss, parseHnItem, normaliseHeadline, mergeAndDedupe } from "../bridge/news.mjs";

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
```

- [ ] **Step 2: Run the test — expect failure (module doesn't exist yet)**

```bash
npx vitest run test/news.test.mjs
```

Expected: FAIL — `Cannot find module '../bridge/news.mjs'`.

- [ ] **Step 3: Create bridge/news.mjs with parsers and helpers**

Create `bridge/news.mjs`:

```js
/** bridge/news.mjs — Live news feed fetcher + cache.
 *
 *  Owns four feeds (Sky / BBC / Guardian RSS, Hacker News top-stories API).
 *  Fetches on `start()`, caches in memory, refreshes every 60 minutes.
 *  The bridge tool-router exposes `getCached()` to the show_news_panel tool;
 *  the front-end news-panel.js renders whatever's cached the moment the
 *  panel is asked to open — no fetch delay on user demand. */

import { XMLParser } from "fast-xml-parser";

/** RSS source endpoints. Order matters only for log readability. */
export const FEEDS = {
  sky:      "https://feeds.skynews.com/feeds/rss/home.xml",
  bbc:      "https://feeds.bbci.co.uk/news/rss.xml",
  guardian: "https://www.theguardian.com/uk/rss",
};

export const HN_TOP_URL  = "https://hacker-news.firebaseio.com/v0/topstories.json";
export const HN_ITEM_URL = (id) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  cdataPropName: "__cdata",
  textNodeName: "#text",
});

/** Parse one RSS document into a normalised list. Returns [] on any failure.
 *  Per-source quirks: Sky uses CDATA titles, BBC sometimes inlines HTML in
 *  description, Guardian's <pubDate> can be missing — we tolerate all three. */
export function parseRss(xml, source) {
  if (!xml || typeof xml !== "string") return [];
  let doc;
  try { doc = xmlParser.parse(xml); } catch { return []; }
  const channel = doc?.rss?.channel;
  if (!channel) return [];
  const rawItems = Array.isArray(channel.item) ? channel.item : (channel.item ? [channel.item] : []);
  const out = [];
  for (const it of rawItems) {
    const title = extractText(it.title);
    const url   = extractText(it.link);
    if (!title || !url) continue;
    const publishedAt = parseRssDate(extractText(it.pubDate));
    out.push({ title, url, source, publishedAt });
  }
  return out;
}

/** Pull the text out of a value that fast-xml-parser may have returned as a
 *  plain string, a CDATA wrapper, or an attribute-bearing object. */
function extractText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object") {
    if (typeof v.__cdata === "string") return v.__cdata.trim();
    if (typeof v["#text"] === "string") return v["#text"].trim();
  }
  return "";
}

/** RFC 822-ish RSS date → epoch ms. Returns 0 if unparseable (still valid sort
 *  key — items with no date sink to the bottom). */
function parseRssDate(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/** Normalise a headline for de-dup comparison: lowercase, strip punctuation,
 *  collapse whitespace, first 60 chars. Why 60: two sources covering the same
 *  story usually share a long opening phrase; capping prevents false matches
 *  on totally different stories that happen to share a short word. */
export function normaliseHeadline(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** Merge multiple per-source arrays into one list sorted newest-first, with
 *  duplicates dropped (keeping the newest occurrence of each headline). Cap
 *  at `limit` items. */
export function mergeAndDedupe(arrays, limit = 12) {
  const all = arrays.flat().filter(Boolean);
  all.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  const seen = new Set();
  const out = [];
  for (const item of all) {
    const key = normaliseHeadline(item.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** Normalise one Hacker News item record from the firebase API. */
export function parseHnItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type !== "story") return null;
  if (!raw.title || !raw.url) return null;
  return {
    id: raw.id,
    title: String(raw.title),
    url: String(raw.url),
    by: raw.by || "",
    score: Number(raw.score) || 0,
    descendants: Number(raw.descendants) || 0,
    publishedAt: Number(raw.time) ? raw.time * 1000 : 0,
  };
}
```

- [ ] **Step 4: Re-run tests — expect pass**

```bash
npx vitest run test/news.test.mjs
```

Expected: 4 passing tests.

- [ ] **Step 5: Stage**

```bash
git add bridge/news.mjs test/news.test.mjs
```

---

### Task 4: Test merge/de-dup, normaliser, and parseHnItem

**Files:**
- Modify: `test/news.test.mjs`

- [ ] **Step 1: Append the tests**

Append to `test/news.test.mjs`:

```js
describe("normaliseHeadline", () => {
  it("lowercases and strips punctuation", () => {
    expect(normaliseHeadline("UK Weather: Storms Expected!"))
      .toBe("uk weather storms expected");
  });

  it("caps at 60 chars", () => {
    const long = "a".repeat(100);
    expect(normaliseHeadline(long)).toHaveLength(60);
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
```

- [ ] **Step 2: Run tests — expect pass**

```bash
npx vitest run test/news.test.mjs
```

Expected: all tests pass.

- [ ] **Step 3: Stage**

```bash
git add test/news.test.mjs
```

---

### Task 5: Add fetchAll with injected fetch — TDD

**Files:**
- Modify: `bridge/news.mjs`
- Modify: `test/news.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/news.test.mjs`:

```js
import { fetchAll } from "../bridge/news.mjs";

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
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx vitest run test/news.test.mjs -t fetchAll
```

Expected: FAIL — `fetchAll` not exported.

- [ ] **Step 3: Append fetchAll + fetchHnTop to bridge/news.mjs**

```js
/** Fetch all four sources in parallel via Promise.allSettled. `fetchImpl` is
 *  the global fetch by default but can be injected by tests. Returns the
 *  same cache shape the module stores internally:
 *      { topStories: [...], hn: [...], fetchedAt: {...}, errors: {...} } */
export async function fetchAll({ fetchImpl = globalThis.fetch, hnLimit = 20 } = {}) {
  const now = Date.now();
  const sources = Object.keys(FEEDS); /* sky, bbc, guardian */
  const rssTasks = sources.map(async (src) => {
    const res = await fetchImpl(FEEDS[src]);
    if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
    const xml = await res.text();
    return parseRss(xml, src);
  });
  const hnTask = fetchHnTop({ fetchImpl, hnLimit });

  const settled = await Promise.allSettled([...rssTasks, hnTask]);
  const errors = { sky: null, bbc: null, guardian: null, hn: null };
  const fetchedAt = { sky: 0, bbc: 0, guardian: 0, hn: 0 };
  const perSource = [];

  sources.forEach((src, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      perSource.push(r.value);
      fetchedAt[src] = now;
    } else {
      errors[src] = String(r.reason?.message || r.reason || "fetch failed");
    }
  });
  const hnSettled = settled[sources.length];
  let hn = [];
  if (hnSettled.status === "fulfilled") {
    hn = hnSettled.value;
    fetchedAt.hn = now;
  } else {
    errors.hn = String(hnSettled.reason?.message || hnSettled.reason || "fetch failed");
  }

  const topStories = mergeAndDedupe(perSource, 12);
  return { topStories, hn, fetchedAt, errors };
}

/** Pull the top HN stories. Two-step: GET topstories.json (array of IDs), then
 *  GET item/<id>.json for the first `hnLimit`, parallel but capped at 8 inflight
 *  to be polite to the API. */
async function fetchHnTop({ fetchImpl, hnLimit }) {
  const res = await fetchImpl(HN_TOP_URL);
  if (!res.ok) throw new Error(`hn topstories: HTTP ${res.status}`);
  const ids = await res.json();
  if (!Array.isArray(ids)) throw new Error("hn topstories: not an array");
  const slice = ids.slice(0, hnLimit);
  const out = [];
  const CONC = 8;
  for (let i = 0; i < slice.length; i += CONC) {
    const batch = slice.slice(i, i + CONC);
    const items = await Promise.allSettled(batch.map(async (id) => {
      const r = await fetchImpl(HN_ITEM_URL(id));
      if (!r.ok) throw new Error(`hn item ${id}: HTTP ${r.status}`);
      const raw = await r.json();
      return parseHnItem(raw);
    }));
    for (const it of items) {
      if (it.status === "fulfilled" && it.value) out.push(it.value);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run test/news.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Stage**

```bash
git add bridge/news.mjs test/news.test.mjs
```

---

### Task 6: Cache + start()/stop() + refresh() — TDD

**Files:**
- Modify: `bridge/news.mjs`
- Modify: `test/news.test.mjs`

- [ ] **Step 1: Write the failing test**

Append to `test/news.test.mjs`:

```js
import { start, stop, getCached, refresh } from "../bridge/news.mjs";

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
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx vitest run test/news.test.mjs -t "cache lifecycle"
```

Expected: FAIL — exports not found.

- [ ] **Step 3: Append cache + lifecycle to bridge/news.mjs**

```js
/** In-memory cache. Reset only by `stop()` (tests + bridge shutdown). */
let _cache = emptyCache();
let _timer = null;

/** Default refresh cadence: 60 minutes. Spec: headlines barely change faster
 *  than this, and the live Sky News YouTube stream covers true breaking news. */
const REFRESH_MS = 60 * 60 * 1000;

function emptyCache() {
  return {
    topStories: [],
    hn: [],
    fetchedAt: { sky: 0, bbc: 0, guardian: 0, hn: 0 },
    errors:    { sky: null, bbc: null, guardian: null, hn: null },
  };
}

/** Return the current cache. Always safe to call — returns the empty shape
 *  before the first fetch lands. */
export function getCached() {
  return _cache;
}

/** Trigger a fresh fetch. If a source fails, its slot in `errors` records the
 *  reason; older items survive in the merged top-stories list until the next
 *  successful fetch supersedes them. */
export async function refresh({ fetchImpl = globalThis.fetch } = {}) {
  const next = await fetchAll({ fetchImpl });
  /* Merge survival: if the new fetch returned nothing for a list but the cache
   * still has items, keep the cached items so the panel never goes blank
   * mid-day because of a transient outage. */
  if (next.topStories.length === 0 && _cache.topStories.length > 0) {
    next.topStories = _cache.topStories;
  }
  if (next.hn.length === 0 && _cache.hn.length > 0) {
    next.hn = _cache.hn;
  }
  _cache = next;
  return _cache;
}

/** Kick off background refresh. Performs an immediate fetch, then re-fetches
 *  every REFRESH_MS. Errors are logged but do not throw — bridge boot must
 *  not be blocked by news being down. */
export function start({ fetchImpl = globalThis.fetch, intervalMs = REFRESH_MS } = {}) {
  stop();
  refresh({ fetchImpl }).catch((e) => {
    console.warn(`[news] initial refresh failed: ${e.message}`);
  });
  _timer = setInterval(() => {
    refresh({ fetchImpl }).catch((e) => {
      console.warn(`[news] scheduled refresh failed: ${e.message}`);
    });
  }, intervalMs);
  /* Don't keep the event loop alive solely for this timer. */
  if (typeof _timer.unref === "function") _timer.unref();
}

/** Stop the scheduler and clear the cache. */
export function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _cache = emptyCache();
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run test/news.test.mjs
```

Expected: all tests pass.

- [ ] **Step 5: Stage**

```bash
git add bridge/news.mjs test/news.test.mjs
```

---

### Task 7: Wire News.start() into bridge boot

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Add the import**

Find the cluster of imports like `import * as Tasks from "./tasks.mjs";`. Add this beside them:

```js
import * as News from "./news.mjs";
```

- [ ] **Step 2: Add the start call after CrashReporter.init**

Confirm the insertion line:

```bash
grep -n "CrashReporter.init" bridge/server.mjs
```

Expected: one match (around line 1843). Immediately after that statement, add:

```js
/* Background news cache — populate on boot, refresh every 60 min. Failures
 * here must NOT block startup; the news.mjs module logs warnings internally. */
try { News.start(); } catch (e) { console.warn(`[server] News.start failed: ${e.message}`); }
```

- [ ] **Step 3: Syntax-check**

```bash
node --check bridge/server.mjs
```

Expected: no output.

- [ ] **Step 4: Boot test**

```bash
node bridge/server.mjs &
SERVER_PID=$!
sleep 4
ps -p $SERVER_PID > /dev/null && echo "alive" || echo "dead"
kill $SERVER_PID 2>/dev/null
```

Expected: prints `alive`. Server stdout may contain `[news]` warnings if the network is unreachable — that's fine.

- [ ] **Step 5: Stage**

```bash
git add bridge/server.mjs
```

---

### Task 8: Register show_news_panel + hide_news_panel tools

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Locate the TOOLS array**

```bash
grep -n "^const TOOLS = \[" bridge/server.mjs
```

Expected: one line near 525.

- [ ] **Step 2: Insert the two tool definitions inside TOOLS**

Pick a neighbour — e.g. just after the `open_url` tool block (around line 1290). Insert:

```js
  {
    type: "function",
    function: {
      name: "show_news_panel",
      description:
        "Open the news panel: live Sky News YouTube on the left, merged top UK headlines (Sky/BBC/Guardian) and Hacker News top tech stories on the right. Use when the operator asks for 'the news', 'headlines', 'top stories', 'what's happening', 'catch me up', or 'what's the news'. The panel uses cached data so it appears instantly. After opening, briefly speak the top headline so the operator hears it as the panel mounts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "hide_news_panel",
      description:
        "Close the news panel and stop the live Sky News stream. Use when the operator says 'close the news', 'hide the news', 'turn that off' while the news panel is showing, or naturally moves on to another topic.",
      parameters: { type: "object", properties: {} },
    },
  },
```

- [ ] **Step 3: Syntax-check**

```bash
node --check bridge/server.mjs
```

Expected: no output.

- [ ] **Step 4: Stage**

```bash
git add bridge/server.mjs
```

---

### Task 9: Add executeTool switch cases + spoken-summary helper

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Locate the relevant switch**

```bash
grep -n "case \"enter_sleep_mode\":" bridge/server.mjs
```

Expected: one match near 2302.

- [ ] **Step 2: Add the two cases**

Add inside the switch in `_executeToolInner`, near `case "enter_sleep_mode"`:

```js
    case "show_news_panel": {
      const cached = News.getCached();
      const summary = buildNewsSpokenSummary(cached);
      broadcastToClients({ type: "news.show", data: cached });
      return { ok: true, summary };
    }
    case "hide_news_panel": {
      broadcastToClients({ type: "news.hide" });
      return { ok: true };
    }
```

- [ ] **Step 3: Add the spoken-summary helper**

Add this helper as a top-level function in `bridge/server.mjs` (near other module-level helpers, e.g. just above `executeTool`):

```js
/** Build a 1–2 sentence summary the LLM can speak while the news panel mounts.
 *  Picks the freshest top-story headline and, if there's also fresh HN content,
 *  appends a one-clause tech tease. Falls back to a generic line on a cold,
 *  empty cache (boot before any successful fetch). */
function buildNewsSpokenSummary(cache) {
  if (!cache) return "Opening the news panel now.";
  const top = cache.topStories?.[0];
  const hn  = cache.hn?.[0];
  if (!top && !hn) return "Opening the news panel now — feeds are still loading.";
  const parts = [];
  if (top) parts.push(`Top story: ${top.title}.`);
  if (hn)  parts.push(`In tech: ${hn.title}.`);
  return parts.join(" ");
}
```

- [ ] **Step 4: Syntax-check**

```bash
node --check bridge/server.mjs
```

Expected: no output.

- [ ] **Step 5: Stage**

```bash
git add bridge/server.mjs
```

---

### Task 10: Add POST /api/news/refresh route

**Files:**
- Modify: `bridge/server.mjs`

- [ ] **Step 1: Locate the API route cluster**

```bash
grep -n "app\.post\|app\.get(\"/api" bridge/server.mjs | head -10
```

Expected: existing `/api/*` route registrations.

- [ ] **Step 2: Add the route**

Insert near other `/api` routes:

```js
/* Manual refresh of the news cache — triggered by the panel's refresh button.
 * Re-fetches all four sources and re-broadcasts the cache so the panel updates
 * without reloading the YouTube iframe. */
app.post("/api/news/refresh", async (_req, res) => {
  try {
    const next = await News.refresh();
    broadcastToClients({ type: "news.update", data: next });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

- [ ] **Step 3: Syntax-check**

```bash
node --check bridge/server.mjs
```

Expected: no output.

- [ ] **Step 4: Stage**

```bash
git add bridge/server.mjs
```

---

### Task 11: Add tools to tool-router ALWAYS_ON

**Files:**
- Modify: `bridge/tool-router.mjs`

- [ ] **Step 1: Locate the ALWAYS_ON set**

```bash
grep -n "ALWAYS_ON = new Set" bridge/tool-router.mjs
```

Expected: one line near the top of the file.

- [ ] **Step 2: Add the two names**

Edit the ALWAYS_ON set to include the new tools. The current set contains entries like `"recall"`, `"web_search"`, etc. Add two lines, preserving every existing entry:

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
]);
```

(If the existing list differs from the snippet above, keep all existing entries and append the two new ones at the end.)

- [ ] **Step 3: Syntax-check**

```bash
node --check bridge/tool-router.mjs
```

Expected: no output.

- [ ] **Step 4: Stage**

```bash
git add bridge/tool-router.mjs
```

---

### Task 12: Add HUD mount slot + script tag

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Locate the body closing tag**

```bash
grep -n "</body>" index.html
```

Expected: one match.

- [ ] **Step 2: Add the mount slot just before </body>**

Insert immediately before `</body>`:

```html
    <!-- News panel mount point. Hidden until bridge broadcasts news.show. -->
    <div id="news-panel-root" class="news-panel-root" hidden></div>
```

- [ ] **Step 3: Add news-panel.js to module scripts**

Find any existing `<script type="module" src="...">` line. Add alongside them:

```html
    <script type="module" src="./news-panel.js"></script>
```

- [ ] **Step 4: Stage**

```bash
git add index.html
```

---

### Task 13: Add news panel styles

**Files:**
- Modify: `styles.css`

- [ ] **Step 1: Append styles**

Append to the end of `styles.css`:

```css
/* ============================================================
   NEWS PANEL — full-width side panel that slides in from the right
   edge of the viewport. While "open" it covers the HUD. A left-edge
   arrow toggles it to a "collapsed" state where only a 32px tab
   remains visible on the right edge. The left edge also acts as a
   resize handle (cursor: ew-resize) — drag to make the panel
   narrower; width is persisted to localStorage by news-panel.js.
   ============================================================ */
.news-panel-root[hidden] { display: none; }
.news-panel-root {
  position: fixed;
  top: 0; bottom: 0; right: 0;
  /* Width is set inline by news-panel.js (default 100vw, persisted).
   * The inline style wins over this fallback. */
  width: 100vw;
  background: rgba(0, 0, 0, 0.92);
  color: #e7e7e7;
  z-index: 9000;
  font-family: "JetBrains Mono", ui-monospace, Menlo, monospace;
  /* Start off-screen; .is-open transitions to translateX(0). */
  transform: translateX(100%);
  transition: transform 280ms cubic-bezier(0.22, 0.61, 0.36, 1);
  will-change: transform;
}
.news-panel-root.is-open {
  transform: translateX(0);
}
.news-panel-root.is-collapsed {
  /* Reveal only the 32px toggle tab on the right edge of the screen. */
  transform: translateX(calc(100% - 32px));
}
/* While the user is dragging the resize handle we want immediate width
 * tracking, not the 280ms transform transition. */
.news-panel-root.is-resizing { transition: none; }

/* Left-edge arrow toggle. Always visible. Square button — text content
 * is replaced by news-panel.js to mirror open/collapsed state. */
.news-panel-toggle {
  position: absolute;
  top: 50%; left: 0;
  transform: translate(-100%, -50%);
  width: 32px; height: 64px;
  background: rgba(11, 11, 11, 0.94);
  border: 1px solid var(--accent, #00d4ff);
  border-right: none;
  color: var(--accent, #00d4ff);
  font: inherit; font-size: 18px; line-height: 1;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  user-select: none;
}
.news-panel-toggle:hover { background: rgba(0, 212, 255, 0.12); }
/* When collapsed, the panel itself is slid 32px-from-right; the toggle
 * sits at the panel's local left edge which is exactly the visible tab. */
.news-panel-root.is-collapsed .news-panel-toggle {
  /* No translate — the tab sits at left: 0 of the (now-mostly-offscreen) panel. */
  transform: translate(0, -50%);
}

/* 6px-wide resize hot-zone overlaying the panel's left edge. */
.news-panel-resize {
  position: absolute;
  top: 0; left: 0; bottom: 0;
  width: 6px;
  cursor: ew-resize;
  /* Above the toggle? No — toggle sits OUTSIDE the panel's left edge so
   * they don't collide. Resize handle stays inside, on the inner left edge. */
  z-index: 1;
}

.news-panel-grid {
  display: grid;
  grid-template-rows: 56px 1fr;
  grid-template-columns: 55% 22.5% 22.5%;
  grid-template-areas:
    "head head head"
    "live stories tech";
  height: 100%;
  gap: 12px;
  padding: 12px;
  box-sizing: border-box;
}
.news-panel-head {
  grid-area: head;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 12px;
  border: 1px solid var(--accent, #00d4ff);
  background: rgba(11, 11, 11, 0.94);
  font-size: 12px; letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--accent, #00d4ff);
}
.news-panel-head .news-clock { font-variant-numeric: tabular-nums; color: #e7e7e7; }
.news-panel-head button {
  background: transparent; color: var(--accent, #00d4ff);
  border: 1px solid var(--accent, #00d4ff); padding: 4px 10px;
  font: inherit; cursor: pointer; letter-spacing: 0.12em;
}
.news-panel-head button:hover { background: rgba(0, 212, 255, 0.12); }
.news-panel-live {
  grid-area: live;
  border: 1px solid #1f1f1f;
  position: relative;
  overflow: hidden;
}
.news-panel-live iframe {
  position: absolute; inset: 0; width: 100%; height: 100%; border: 0;
}
.news-panel-live-fallback {
  display: flex; align-items: center; justify-content: center;
  height: 100%; color: #888; font-size: 13px;
}
.news-panel-col {
  border: 1px solid #1f1f1f;
  padding: 12px 14px;
  overflow-y: auto;
}
.news-panel-col.stories { grid-area: stories; }
.news-panel-col.tech    { grid-area: tech; }
.news-panel-col h2 {
  margin: 0 0 10px 0;
  font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--accent, #00d4ff);
  border-bottom: 1px solid #1f1f1f;
  padding-bottom: 8px;
}
.news-panel-col h2 .stale {
  color: #b46; font-size: 10px; margin-left: 8px;
}
.news-row {
  display: block;
  padding: 8px 0;
  border-bottom: 1px solid #1a1a1a;
  color: #e7e7e7; text-decoration: none;
  font-size: 13px; line-height: 1.4;
}
.news-row:hover { color: var(--accent, #00d4ff); }
.news-row-title { display: block; }
.news-row-meta {
  display: block;
  margin-top: 3px;
  color: #888;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.news-row-meta .src {
  display: inline-block;
  padding: 1px 6px; margin-right: 6px;
  border: 1px solid #2a2a2a;
}
.news-panel-empty {
  color: #888; font-size: 12px; padding: 10px 0;
}
```

- [ ] **Step 2: Stage**

```bash
git add styles.css
```

---

### Task 14: Build news-panel.js — DOM-safe shell, columns, refresh, Esc

**Files:**
- Create: `news-panel.js`

- [ ] **Step 1: Create the module**

Create `news-panel.js`:

```js
/** news-panel.js — Full-screen news mode driven by bridge broadcasts.
 *
 *  Mounts when the bridge sends { type: "news.show", data: cache }, unmounts
 *  on { type: "news.hide" } or Esc. While mounted: renders the live Sky News
 *  YouTube embed plus two columns of headlines, polls TTS state to duck
 *  YouTube volume during assistant speech, and exposes a manual refresh
 *  button that POSTs /api/news/refresh.
 *
 *  All payload-derived content is built with createElement + textContent.
 *  innerHTML is used only for the static shell where no user-controlled
 *  string is interpolated. This makes XSS through a poisoned RSS feed
 *  structurally impossible even if upstream sanitisation regresses.
 */

import * as Bridge from "./bridge-client.js";
import { isSpeaking } from "./tts.js";

/** Sky News official YouTube channel. The /embed/live_stream?channel=… URL
 *  always points at that channel's currently-live broadcast — no need to
 *  track individual video IDs (which rotate). Verified against the official
 *  Sky News channel page during implementation.
 *  Channel ID: UCoMdktPbSTixAyNGwb-UYkQ */
const SKY_NEWS_CHANNEL_ID = "UCoMdktPbSTixAyNGwb-UYkQ";

const WIDTH_KEY    = "news-panel:width";   /* localStorage key for persisted width */
const DEFAULT_WIDTH = "100vw";              /* operator picked full-width */
const MIN_WIDTH_PX  = 480;

let _root      = null;
let _player    = null;
let _duckTimer = null;
let _ttsDucked = false;
let _clockTimer = null;
let _escHandler = null;

/** Mount and render the panel from a cache payload. Idempotent — repeat calls
 *  while open just re-render columns and ensure the panel is in the open state.
 *  The slide-in is driven by toggling `.is-open` on the root after a tick so
 *  the CSS transition picks up the transform change. */
export function show(cache) {
  ensureRoot();
  if (!_root) return;
  if (!_root.dataset.built) {
    buildShell();
    _root.dataset.built = "1";
    applyPersistedWidth();
  }
  _root.hidden = false;
  _root.classList.remove("is-collapsed");
  /* requestAnimationFrame ensures the browser sees the un-hidden state with
   * translateX(100%) before we transition to translateX(0). Without it the
   * panel can appear in its final position with no animation. */
  requestAnimationFrame(() => _root.classList.add("is-open"));
  renderColumns(cache);
  attachEsc();
  startClock();
  mountYouTubePlayer();
  startVolumeDucking();
}

/** Slide the panel out and tear down media + listeners. Called by the close
 *  button, Esc key, the bridge news.hide event, or by collapse() when it
 *  decides to fully unmount (currently it doesn't — collapse is non-destructive). */
export function hide() {
  if (!_root) return;
  _root.classList.remove("is-open", "is-collapsed");
  stopVolumeDucking();
  stopClock();
  detachEsc();
  destroyPlayer();
  /* Wait for the transition to finish before hiding so the slide-out plays.
   * 320ms matches CSS 280ms + a small buffer for slow frames. */
  setTimeout(() => {
    if (!_root) return;
    if (_root.classList.contains("is-open")) return; /* re-opened during the wait */
    _root.hidden = true;
    _root.replaceChildren();
    delete _root.dataset.built;
  }, 320);
}

/** Collapse to the edge tab without tearing down the iframe. Cheap to expand
 *  again — the YT player keeps playing in the background. */
function collapse() {
  if (!_root) return;
  _root.classList.add("is-collapsed");
  updateToggleArrow();
}

/** Re-expand from the collapsed state. */
function expand() {
  if (!_root) return;
  _root.classList.remove("is-collapsed");
  updateToggleArrow();
}

function isCollapsed() {
  return !!(_root && _root.classList.contains("is-collapsed"));
}

function ensureRoot() {
  if (_root) return;
  _root = document.getElementById("news-panel-root");
  if (!_root) {
    console.warn("[news-panel] #news-panel-root not found in DOM");
  }
}

/** Build the static shell: toggle arrow, resize handle, grid (header +
 *  three regions). Uses createElement throughout so there is no template
 *  string into which attacker-controlled data could be spliced. */
function buildShell() {
  _root.replaceChildren();

  /* Toggle arrow — outside the grid so it sits on the panel's left edge. */
  const toggle = el("button", { type: "button", class: "news-panel-toggle",
    "aria-label": "Collapse news panel" });
  toggle.textContent = "›"; /* updateToggleArrow() will refresh if state changes */
  toggle.addEventListener("click", () => {
    if (isCollapsed()) expand();
    else collapse();
  });
  _root.appendChild(toggle);

  /* Resize handle — also outside the grid, sits inside the panel's left edge. */
  const resize = el("div", { class: "news-panel-resize", "aria-hidden": "true" });
  resize.addEventListener("pointerdown", onResizeStart);
  _root.appendChild(resize);

  const grid = el("div", { class: "news-panel-grid" });

  const head = el("div", { class: "news-panel-head" });
  head.append(
    el("span", {}, "JARVIS · NEWS"),
    el("span", { class: "news-clock" }),
  );
  const controls = el("span");
  const refreshBtn = el("button", { type: "button" }, "REFRESH");
  refreshBtn.addEventListener("click", onRefreshClick);
  const closeBtn = el("button", { type: "button", style: "margin-left:6px" }, "CLOSE");
  closeBtn.addEventListener("click", () => hide());
  controls.append(refreshBtn, closeBtn);
  head.appendChild(controls);

  const live = el("div", { class: "news-panel-live" });
  live.appendChild(el("div", { id: "news-player-mount" }));
  const fallback = el("div", { class: "news-panel-live-fallback", hidden: "" },
    "live stream unavailable — try refresh");
  live.appendChild(fallback);

  const stories = el("div", { class: "news-panel-col stories" });
  stories.append(
    el("h2", { class: "news-stories-head" }, "Top Stories"),
    el("div", { class: "news-stories-list" }),
  );

  const tech = el("div", { class: "news-panel-col tech" });
  tech.append(
    el("h2", { class: "news-tech-head" }, "Tech · Hacker News"),
    el("div", { class: "news-tech-list" }),
  );

  grid.append(head, live, stories, tech);
  _root.appendChild(grid);

  updateToggleArrow();
}

/** Set the arrow glyph based on current state.  ›  when open (click → close
 *  the panel away);  ‹  when collapsed (click → bring it back). */
function updateToggleArrow() {
  if (!_root) return;
  const t = _root.querySelector(".news-panel-toggle");
  if (!t) return;
  t.textContent = isCollapsed() ? "‹" : "›";
  t.setAttribute("aria-label", isCollapsed() ? "Expand news panel" : "Collapse news panel");
}

/* ── Resize drag ─────────────────────────────────────────────────────────── */

let _resizeStartX = 0;
let _resizeStartW = 0;

function onResizeStart(e) {
  if (!_root) return;
  e.preventDefault();
  _resizeStartX = e.clientX;
  _resizeStartW = _root.getBoundingClientRect().width;
  _root.classList.add("is-resizing");
  /* Capture all pointer events on the resize handle so a drag past the panel
   * edge keeps tracking. Falls back to window listeners if setPointerCapture
   * is unavailable (older browsers). */
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  e.target.addEventListener("pointermove", onResizeMove);
  e.target.addEventListener("pointerup",   onResizeEnd, { once: true });
  e.target.addEventListener("pointercancel", onResizeEnd, { once: true });
}

function onResizeMove(e) {
  if (!_root) return;
  /* Dragging RIGHT (positive dx) shrinks the panel because its left edge is
   * the handle. So newWidth = startWidth - dx. */
  const dx = e.clientX - _resizeStartX;
  const next = clamp(_resizeStartW - dx, MIN_WIDTH_PX, window.innerWidth);
  _root.style.width = `${next}px`;
}

function onResizeEnd(e) {
  if (!_root) return;
  _root.classList.remove("is-resizing");
  try { e.target.releasePointerCapture(e.pointerId); } catch {}
  e.target.removeEventListener("pointermove", onResizeMove);
  /* Persist the chosen width. Store the px value; on next open we apply it
   * unless it would be wider than the current viewport (in which case we cap). */
  try { localStorage.setItem(WIDTH_KEY, String(_root.getBoundingClientRect().width)); }
  catch {} /* private mode / quota — silent best-effort */
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function applyPersistedWidth() {
  if (!_root) return;
  let stored;
  try { stored = localStorage.getItem(WIDTH_KEY); } catch { stored = null; }
  const parsed = stored ? parseInt(stored, 10) : NaN;
  if (Number.isFinite(parsed) && parsed >= MIN_WIDTH_PX) {
    _root.style.width = `${Math.min(parsed, window.innerWidth)}px`;
  } else {
    _root.style.width = DEFAULT_WIDTH;
  }
}

/** Tiny helper. Attributes are set via setAttribute (no innerHTML path). */
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    node.setAttribute(k, v === true ? "" : String(v));
  }
  if (text != null) node.textContent = String(text);
  return node;
}

/** Re-render the two columns and the stale markers from a cache payload. */
function renderColumns(cache) {
  if (!_root) return;
  const stories = _root.querySelector(".news-stories-list");
  const tech    = _root.querySelector(".news-tech-list");
  if (stories) replaceWithRows(stories, cache?.topStories, "stories");
  if (tech)    replaceWithRows(tech,    cache?.hn,         "tech");
  updateStaleHeaders(cache);
}

function replaceWithRows(host, items, kind) {
  host.replaceChildren();
  if (!items || items.length === 0) {
    host.appendChild(el("div", { class: "news-panel-empty" },
      kind === "tech" ? "no tech stories cached yet" : "no headlines cached yet"));
    return;
  }
  for (const it of items) host.appendChild(buildRow(it, kind));
}

function buildRow(it, kind) {
  const a = el("a", {
    class: "news-row",
    href: safeUrl(it.url),
    target: "_blank",
    rel: "noopener noreferrer",
  });
  a.appendChild(el("span", { class: "news-row-title" }, it.title || ""));

  const meta = el("span", { class: "news-row-meta" });
  const srcLabel = kind === "tech" ? "HN" : String(it.source || "").toUpperCase();
  meta.appendChild(el("span", { class: "src" }, srcLabel));
  meta.appendChild(el("span", {}, relativeTime(it.publishedAt)));
  a.appendChild(meta);
  return a;
}

/** Only allow http(s) hrefs into the DOM. javascript:, data:, file: rejected.
 *  Returns "#" for anything we don't trust — the link becomes a no-op. */
function safeUrl(u) {
  const s = String(u || "");
  if (!/^https?:\/\//i.test(s)) return "#";
  return s;
}

function updateStaleHeaders(cache) {
  const TWO_HRS = 2 * 60 * 60 * 1000;
  const now = Date.now();

  const storiesHead = _root.querySelector(".news-stories-head");
  if (storiesHead) {
    storiesHead.replaceChildren(document.createTextNode("Top Stories"));
    const lastTop = Math.max(
      cache?.fetchedAt?.sky || 0,
      cache?.fetchedAt?.bbc || 0,
      cache?.fetchedAt?.guardian || 0,
    );
    if (lastTop && now - lastTop > TWO_HRS) {
      storiesHead.appendChild(el("span", { class: "stale" }, "· stale"));
    }
  }

  const techHead = _root.querySelector(".news-tech-head");
  if (techHead) {
    techHead.replaceChildren(document.createTextNode("Tech · Hacker News"));
    const lastHn = cache?.fetchedAt?.hn || 0;
    if (lastHn && now - lastHn > TWO_HRS) {
      techHead.appendChild(el("span", { class: "stale" }, "· stale"));
    }
  }
}

function relativeTime(epochMs) {
  if (!epochMs) return "";
  const diff = Date.now() - epochMs;
  const m = Math.round(diff / 60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(epochMs).toLocaleDateString();
}

function startClock() {
  stopClock();
  const tick = () => {
    if (!_root) return;
    const c = _root.querySelector(".news-clock");
    if (c) c.textContent = new Date().toLocaleTimeString();
  };
  tick();
  _clockTimer = setInterval(tick, 1000);
}
function stopClock() { if (_clockTimer) { clearInterval(_clockTimer); _clockTimer = null; } }

function attachEsc() {
  if (_escHandler) return;
  _escHandler = (e) => { if (e.key === "Escape") hide(); };
  window.addEventListener("keydown", _escHandler);
}
function detachEsc() {
  if (!_escHandler) return;
  window.removeEventListener("keydown", _escHandler);
  _escHandler = null;
}

async function onRefreshClick() {
  try {
    const r = await fetch("/api/news/refresh", { method: "POST" });
    if (!r.ok) console.warn("[news-panel] refresh failed:", r.status);
    /* On success the bridge broadcasts news.update; the subscriber re-renders. */
  } catch (e) {
    console.warn("[news-panel] refresh threw:", e.message);
  }
}

/* YouTube + ducking are implemented in Tasks 15 and 16. */
function mountYouTubePlayer()  { /* implemented in Task 15 */ }
function destroyPlayer()        { /* implemented in Task 15 */ }
function startVolumeDucking()   { /* implemented in Task 16 */ }
function stopVolumeDucking()    { /* implemented in Task 16 */ }

/* Bridge wire-up. */
Bridge.on("news.show",   (msg) => show(msg.data || {}));
Bridge.on("news.hide",   () => hide());
Bridge.on("news.update", (msg) => { if (_root && !_root.hidden) renderColumns(msg.data || {}); });
```

- [ ] **Step 2: Smoke-check in the HUD**

Open the HUD in a browser. From the JS console:

```js
import("./news-panel.js").then(m => m.show({
  topStories: [
    { title: "Test headline", url: "https://example.com", source: "sky", publishedAt: Date.now() - 60000 },
    { title: "Malicious <script>alert(1)</script> attempt", url: "javascript:alert(1)", source: "bbc", publishedAt: Date.now() - 120000 },
  ],
  hn: [{ title: "Test HN item", url: "https://example.com/hn", publishedAt: Date.now() - 180000 }],
  fetchedAt: { sky: Date.now(), bbc: 0, guardian: 0, hn: Date.now() },
  errors: {},
}));
```

Expected:
- Panel slides in from the right edge over ~280 ms.
- Header, three regions (live area empty for now), two columns visible.
- The malicious row renders the title text literally (no script execution); its link's href becomes `#` (try clicking it — nothing happens).
- Click the `›` arrow on the left edge → panel collapses to a 32 px tab on the right. Click the `‹` on the tab → expands again.
- Drag the inner left edge (cursor changes to ↔) inward — panel narrows live. Release → width persists. Reload the HUD and re-trigger `show(...)` → panel opens at the persisted width.
- Esc → panel slides out, root becomes hidden after the animation completes.

- [ ] **Step 3: Stage**

```bash
git add news-panel.js
```

---

### Task 15: YouTube IFrame Player API integration

**Files:**
- Modify: `news-panel.js`

- [ ] **Step 1: Replace the two placeholder functions**

Find this exact block near the bottom of `news-panel.js`:

```js
/* YouTube + ducking are implemented in Tasks 15 and 16. */
function mountYouTubePlayer()  { /* implemented in Task 15 */ }
function destroyPlayer()        { /* implemented in Task 15 */ }
```

Replace it with:

```js
/* YouTube IFrame API loader. Loads once, lazily, on first mount. The script
 * defines a global window.onYouTubeIframeAPIReady callback — we hook into it
 * with a one-shot promise so mountYouTubePlayer can await readiness. */
let _ytApiReady = null;
function loadYouTubeApi() {
  if (_ytApiReady) return _ytApiReady;
  _ytApiReady = new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try { prev && prev(); } catch {}
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.head.appendChild(script);
  });
  return _ytApiReady;
}

async function mountYouTubePlayer() {
  if (!_root) return;
  const mount = _root.querySelector("#news-player-mount");
  const fallback = _root.querySelector(".news-panel-live-fallback");
  if (!mount) return;
  try {
    await loadYouTubeApi();
    /* Build the iframe ourselves so we can use the channel-based live URL
     * (the YT.Player constructor only accepts a video ID, not a channel).
     * We still attach a YT.Player wrapper to the iframe afterwards so we
     * can call setVolume() for ducking. */
    const iframe = document.createElement("iframe");
    iframe.id = "news-player-iframe";
    iframe.src = `https://www.youtube.com/embed/live_stream?channel=${SKY_NEWS_CHANNEL_ID}&enablejsapi=1&autoplay=1`;
    iframe.allow = "autoplay; encrypted-media; picture-in-picture";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.setAttribute("frameborder", "0");
    mount.replaceWith(iframe);

    _player = new window.YT.Player("news-player-iframe", {
      events: {
        onReady: (e) => {
          try { e.target.setVolume(70); e.target.playVideo(); } catch {}
        },
        onError: () => {
          if (fallback) fallback.removeAttribute("hidden");
        },
      },
    });
  } catch (e) {
    console.warn("[news-panel] YT mount failed:", e.message);
    if (fallback) fallback.removeAttribute("hidden");
  }
}

function destroyPlayer() {
  if (_player) {
    try { _player.destroy(); } catch {}
    _player = null;
  }
  /* If destroy() didn't run (player wasn't ready yet), still remove any
   * iframe so the live stream stops downloading audio. */
  const stray = _root && _root.querySelector("#news-player-iframe");
  if (stray) stray.remove();
}
```

- [ ] **Step 2: Verify in browser**

Reload the HUD. Trigger `show(...)` from the console (use the safe payload from Task 14 Step 2).

Expected: the Sky News live stream loads in the left panel within ~3–5 s and starts playing. Press Esc → the iframe is removed and audio stops.

If autoplay-with-sound is blocked by the browser, video will play silently until clicked — that's expected browser behaviour, not a bug.

- [ ] **Step 3: Stage**

```bash
git add news-panel.js
```

---

### Task 16: TTS volume ducking via isSpeaking() poll

**Files:**
- Modify: `news-panel.js`

- [ ] **Step 1: Replace the ducking stubs**

Find this exact block:

```js
function startVolumeDucking()   { /* implemented in Task 16 */ }
function stopVolumeDucking()    { /* implemented in Task 16 */ }
```

Replace with:

```js
/** Poll-based ducking: every 250 ms ask tts.js whether it's mid-speech and
 *  set the YouTube player's volume accordingly. 250 ms feels coincident with
 *  the assistant starting to talk and never thrashes the iframe API. */
const DUCK_VOL     = 15;
const NORMAL_VOL   = 70;
const DUCK_POLL_MS = 250;

function startVolumeDucking() {
  stopVolumeDucking();
  _duckTimer = setInterval(() => {
    if (!_player || typeof _player.setVolume !== "function") return;
    const speaking = isSpeaking();
    if (speaking && !_ttsDucked) {
      try { _player.setVolume(DUCK_VOL); } catch {}
      _ttsDucked = true;
    } else if (!speaking && _ttsDucked) {
      try { _player.setVolume(NORMAL_VOL); } catch {}
      _ttsDucked = false;
    }
  }, DUCK_POLL_MS);
}

function stopVolumeDucking() {
  if (_duckTimer) { clearInterval(_duckTimer); _duckTimer = null; }
  _ttsDucked = false;
}
```

- [ ] **Step 2: Verify in browser**

With the news panel open and Sky News playing, trigger a TTS line from the console:

```js
import("./tts.js").then(m => m.enqueueSentence("Testing ducking. The news audio should drop while I'm speaking and come back after.", "default"));
```

Expected: YouTube volume drops to ~15% during the spoken sentence and returns to ~70% within ~250 ms of TTS ending.

- [ ] **Step 3: Stage**

```bash
git add news-panel.js
```

---

### Task 17: End-to-end verification

**Files:** (no code changes — pure verification)

- [ ] **Step 1: Boot the bridge + HUD**

```bash
./launch.sh
```

Or the project's normal start command. Wait for HUD ready + bridge online.

- [ ] **Step 2: Ask for the news**

Voice or text: "Jarvis, what's the news?" (or "headlines", "top stories", "catch me up").

Expected behaviour:
1. LLM picks `show_news_panel`.
2. Bridge broadcasts `news.show` with the current cache.
3. HUD news-panel mounts the full-screen overlay.
4. Sky News YouTube live starts playing.
5. Jarvis speaks the one-line summary ("Top story: …. In tech: …."). Volume ducks during the summary and restores after.
6. Stories column shows ≥3 headlines (Sky/BBC/Guardian merged). Tech column shows ≥10 HN items.

- [ ] **Step 3: Test the refresh button**

Click REFRESH in the header.

Expected: column rows re-render (timestamps shift). The YouTube iframe does not reload.

- [ ] **Step 4: Test collapse / expand**

Click the `›` arrow on the panel's left edge.

Expected: panel slides right until only the 32 px arrow tab is visible on the right edge. YouTube keeps playing in the background (you can hear it; ducking still works during TTS). Click the tab → panel slides back open. Arrow glyph flips between `›` and `‹` each time.

- [ ] **Step 5: Test resize + persistence**

Drag the inner left edge of the panel inward.

Expected: panel narrows in real time (no transition lag while dragging). Release → width persists to `localStorage["news-panel:width"]`. Verify with the JS console: `localStorage.getItem("news-panel:width")` returns a px value. Reload the HUD and re-open the panel via voice — it opens at the persisted width. Drag back to the right edge → panel widens back to full-width.

- [ ] **Step 6: Test dismissal**

Press Esc, click CLOSE, or say "close the news".

Expected: panel slides out to the right, YouTube playback stops, no audio bleed, root becomes `hidden` after the animation completes.

- [ ] **Step 7: Test cold-cache behaviour**

Stop the bridge. Edit `bridge/news.mjs` temporarily — change one feed URL to a bogus host (e.g. `https://nope.invalid/feed`). Restart. Trigger the panel immediately.

Expected:
- Panel still opens.
- The affected source contributes no items (no crash, no blank panel).
- Other sources render normally.
- Server stdout includes a `[news] … failed: …` warning.

Revert the temporary URL change before staging.

- [ ] **Step 8: Stage any remaining changes**

```bash
git status
git add -u
```

(Do NOT run `git commit` — see plan header policy.)

---

## Self-Review

**Spec coverage:**
- Sky / BBC / Guardian RSS → Tasks 2, 3, 5
- Hacker News top stories → Tasks 2, 4, 5
- Merge / de-dup → Tasks 3 (helpers), 4 (tests)
- In-memory cache + 60-min refresh → Task 6
- Boot-time `start()` → Task 7
- `show_news_panel` / `hide_news_panel` tools → Tasks 8, 9
- ALWAYS_ON inclusion → Task 11
- `/api/news/refresh` route → Task 10
- Side-slide panel (full-width default, transform-based animation) → Tasks 12, 13, 14
- 3-column layout inside the panel → Task 13
- Arrow toggle (collapse to edge-tab + expand) → Tasks 13, 14
- Resize handle with localStorage persistence → Tasks 13, 14, 17 Step 5
- YouTube channel-based live embed → Task 15
- TTS volume ducking → Task 16
- Manual refresh button → Tasks 10, 14
- Esc + close dismissal → Task 14
- Error handling: per-source error fields, stale headers, YT fallback → Tasks 5, 6, 14, 15
- DOM-safe rendering (no XSS through poisoned feeds) → Task 14
- End-to-end verification → Task 17

**Placeholder scan:** No `TBD`, `TODO`, "add appropriate", or undefined-symbol references. Stub-then-fill is bounded — Task 14's stubs are explicitly named and immediately replaced in Tasks 15 and 16 with the exact replacement text shown.

**Type consistency:** Cache shape `{ topStories, hn, fetchedAt, errors }` is used identically across `bridge/news.mjs`, the `show_news_panel` tool handler in `bridge/server.mjs`, and `news-panel.js`. Tool names `show_news_panel` / `hide_news_panel` and event types `news.show` / `news.hide` / `news.update` match across registration, ALWAYS_ON, broadcast, and Bridge.on subscriptions.
