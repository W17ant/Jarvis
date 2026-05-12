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
 *  collapse whitespace, first 40 chars. Why 40: two sources covering the same
 *  story usually share a long opening clause but diverge in trailing detail
 *  ("…across the south" vs "…across the south of England"). 40 chars captures
 *  the shared opening without false-matching totally different stories that
 *  happen to share a short word. */
export function normaliseHeadline(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
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

// ─── Cache + lifecycle ───────────────────────────────────────────────────────

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

// ─── Internal helpers ────────────────────────────────────────────────────────

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
  // Why: 8 concurrent requests is polite to the HN Firebase API — enough
  // throughput to fetch 20 items quickly, not so many as to hammer a free API.
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
