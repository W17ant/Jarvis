---
title: News Panel — live Sky News + top stories + tech feed
date: 2026-05-11
status: approved
---

# News Panel

## Purpose

When the user asks about the news, Jarvis slides a full-width side panel in from the right edge of the HUD. It shows:

1. **Sky News live YouTube stream** (left, ~55% width inside the panel) — channel-based embed so it always tracks the currently live broadcast.
2. **Top Stories** column — Sky News, BBC, and Guardian RSS feeds merged and de-duped.
3. **Tech / HN** column — Hacker News top stories (broader than AI-only; major AI stories surface there organically).

The panel opens to 100 vw by default with a ~280 ms slide-in animation. An arrow toggle on its left edge collapses it back off-screen (leaving a small tab visible on the right edge so the operator can re-open without going through the LLM). The same left edge is a drag handle for resizing — the operator can pull the panel narrower; the chosen width is persisted across sessions via localStorage.

Feeds are fetched on bridge boot and refreshed every 60 minutes so there is no fetch delay when the panel opens. A manual refresh button covers the rare case the operator wants fresher results.

## Architecture

```
┌─────────────────────────┐    ┌──────────────────────────┐
│  bridge/news.mjs        │    │  bridge/tool-router.mjs  │
│  - fetchers (RSS, HN)   │    │  - registers             │
│  - merge / de-dup       │◀───┤    show_news_panel tool  │
│  - in-memory cache      │    │  - handler emits WS broadcast     │
│  - 60-min interval      │    │    news.show + summary   │
└──────────┬──────────────┘    └─────────────┬────────────┘
           │                                 │
           │ getCached()                     │ WS broadcast: news.show
           ▼                                 ▼
                              ┌──────────────────────────┐
                              │  news-panel.js (HUD)     │
                              │  - mount full-screen     │
                              │  - YT IFrame Player API  │
                              │  - TTS volume ducking    │
                              │  - manual refresh button │
                              └──────────────────────────┘
```

## Components

### `bridge/news.mjs` (new)

- **Fetchers (parallel, all behind `Promise.allSettled`)**
  - Sky News: `https://feeds.skynews.com/feeds/rss/home.xml`
  - BBC: `https://feeds.bbci.co.uk/news/rss.xml`
  - Guardian: `https://www.theguardian.com/uk/rss`
  - Hacker News: `https://hacker-news.firebaseio.com/v0/topstories.json` → first 20 IDs → `item/{id}.json` per item (parallel, capped at 20 concurrent fetches)
- **Parsing:** `fast-xml-parser` (new dep, ~20kB, no transitive deps). Handles CDATA + entities. RSS shape varies slightly per source; per-source mapper functions return a normalised `{ title, url, source, publishedAt }` shape.
- **Merge + de-dup:** sort merged top-stories by `publishedAt` desc, drop items whose normalised headline (lowercase, first 60 chars, stripped of punctuation) matches one already kept. Keep up to 12 in the column.
- **Cache shape:**
  ```js
  {
    topStories: [{ title, url, source, publishedAt }, ...],
    hn: [{ title, url, by, score, descendants }, ...],
    fetchedAt: { sky: 1234, bbc: 1234, guardian: 1234, hn: 1234 },
    errors: { sky: null, bbc: 'timeout', ... }
  }
  ```
- **Lifecycle:** `start()` fetches immediately, then `setInterval(refresh, 60*60*1000)`. Refresh logs errors per source, keeps last good payload on failure.
- **Exports:** `start()`, `stop()`, `refresh()`, `getCached()`.

### `bridge/tool-router.mjs` (existing — extend)

Register tool:

```js
{
  name: 'show_news_panel',
  description: "Open the news panel with live Sky News, top UK headlines (Sky/BBC/Guardian), and top tech stories from Hacker News. Use when the user asks about news, headlines, top stories, what's happening, current events, or wants a catch-up.",
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const cached = news.getCached();
    sse.broadcast('news.show', cached);
    return { ok: true, summary: buildShortSpokenSummary(cached) };
  }
}
```

The returned `summary` is a 1–2 sentence text headline the LLM can speak while the panel mounts (e.g. "Headlines this hour: <first sky headline>, plus <bbc headline>. Showing the live feed now.").

Also register `hide_news_panel` (parameters: `{}`) that emits `news.hide` — covers explicit voice dismissal like "close the news".

### `bridge/server.mjs` (existing — wire startup)

Call `news.start()` after server is up. Wrapped in try/catch — news failure must not block bridge boot.

### `news-panel.js` (new HUD module)

- **Mount target:** new `<div id="news-panel-root" class="news-panel-root" hidden></div>` in `index.html` at the body level (above other HUD layers).
- **Open/close mechanics:** the root is always present after first mount. State is tracked via classes `is-open` / `is-collapsed`. Slide-in is a CSS `transform: translateX(100%) → translateX(0)` transition (~280ms cubic-bezier). Collapsed state slides back to `translateX(calc(100% - 32px))` so the toggle arrow remains visible as a 32 px tab on the right edge.
- **Layout:** CSS grid inside the panel, 3 columns: `[live 55%] [stories 22.5%] [tech 22.5%]`. Header row spans all three.
- **Toggle arrow:** absolutely positioned 32 px square on the panel's left edge, vertically centred. Shows `›` when open (click → collapse) and `‹` when collapsed (click → expand).
- **Resize handle:** a 6 px hot-zone along the panel's left edge, `cursor: ew-resize`. Pointer-drag adjusts the panel's width between a 480 px minimum and 100 vw maximum. Final width persists to `localStorage["news-panel:width"]` and is restored on next open.
- **YouTube embed:** iframe using YouTube's channel-based live URL pattern: `https://www.youtube.com/embed/live_stream?channel=<SKY_NEWS_CHANNEL_ID>&enablejsapi=1&autoplay=1`. Channel ID resolved during implementation (verify against the official Sky News channel page; the `live_stream?channel=` pattern always points to that channel's currently-live broadcast). Loads YT IFrame Player API script once; wraps in `new YT.Player(...)`.
- **Audio ducking:** subscribe to existing bridge WS broadcast events for TTS lifecycle (confirm exact event names during implementation — likely `tts.start` / `tts.end` based on `tts-pipeline.js`). On TTS start → `player.setVolume(15)`; on TTS end → `player.setVolume(70)`. Default volume on mount: 70.
- **WS broadcast listeners:**
  - `news.show` → mount, render, animate in
  - `news.hide` → animate out, unmount (destroys YT player to stop the stream)
  - `news.update` (optional, fired by manual refresh) → re-render columns without reloading video
- **Header controls:**
  - Current time (live clock)
  - "Refresh" button → `fetch('/api/news/refresh', { method: 'POST' })` → bridge calls `news.refresh()` → emits `news.update`
  - Close button (×) + Esc handler → emits a local `news.hide`
- **Story rendering:** each item is `<a target="_blank" rel="noopener">` so clicks open in default browser. Source badge (Sky/BBC/Guardian) + relative time ("12m ago").

### `index.html`, `styles.css`

- Add `<div id="news-panel-root">` mount slot.
- Load `news-panel.js` as a module.
- Styles: dark backdrop (rgba(0,0,0,0.92)), accent borders matching existing HUD palette (`var(--accent)`), monospaced headline font matching the HUD aesthetic, smooth fade/slide-in (~220ms).

## Data Flow

1. **Boot:** `server.mjs` → `news.start()` → parallel fetch all four sources → cache populated (typically <2s; bridge does not wait on it).
2. **Voice query:** user says "what's the news" → STT → LLM → `show_news_panel` tool call.
3. **Tool handler:** reads `news.getCached()` → emits WS broadcast `news.show` with payload → returns short spoken summary text.
4. **Frontend:** HUD receives `news.show` → `news-panel.js` mounts overlay, renders columns from payload, instantiates YT player.
5. **TTS playback:** existing TTS pipeline emits its lifecycle events → news panel ducks YT volume → restores on TTS end.
6. **Dismissal:** Esc / close / "close news" → WS broadcast or local `news.hide` → YT player destroyed → overlay unmounts.
7. **Background refresh:** `setInterval` re-fetches every 60 min; if the panel is open when refresh completes, bridge emits `news.update` so columns update silently.

## Error Handling

| Failure | Behaviour |
|---|---|
| Individual RSS feed timeout/parse error | Log to bridge stderr, keep last cached items from that source, mark column header with " · stale Nm" indicator |
| All three RSS feeds fail (cold cache) | Show Top Stories column with "feeds unavailable — retrying" placeholder; HN column still renders |
| HN API fails | Tech column shows "Hacker News unavailable"; Top Stories renders normally |
| YouTube iframe fails to load (network, geo-blocked, stream ended) | Replace iframe area with static placeholder "live stream unavailable — try refresh" |
| Bridge startup fetch fails entirely | Tool handler returns cache-empty summary; HUD shows "no news cached yet — refreshing" and triggers a manual refresh on mount |
| Tool fired but bridge has no WS broadcast clients (HUD not loaded) | No-op; tool still returns summary text so LLM can speak headlines |

## Testing

**Unit — `test/news.test.mjs` (new)**
- Per-source RSS fixture parsing (one fixture XML per source committed under `test/fixtures/news/`)
- HN parser given fixture JSON
- Merge/de-dup: feed it overlapping headlines, assert de-dup keeps newest
- Cache contract: `getCached()` returns last good payload after a simulated fetch failure
- Refresh interval: use fake timers, assert second fetch fires after 60 min

**Smoke — extend `test/_smoke.mjs` if present, else new `test/news.smoke.mjs`**
- Bridge boots, `news.start()` resolves cache populated for ≥1 source within 5s
- Tool `show_news_panel` returns ok + non-empty summary

**Manual checklist (covered in implementation phase)**
- Voice "what's the news" → panel appears, video plays, columns populated
- Speak a follow-up while panel is open → YT volume ducks then restores
- Click refresh → columns update without video reload
- Esc → panel closes, video stops (verify no audio bleeding through)

## Dependencies

New: `fast-xml-parser` (~20kB, MIT, zero deps). Already-available: Node 18+ built-in `fetch`, existing WS broadcast broadcaster in `bridge/server.mjs`, existing tool-router registration pattern.

## Out of Scope (YAGNI)

- Per-source enable/disable toggles or custom RSS URLs in settings (can add later if requested)
- Image thumbnails on story rows (RSS images are inconsistent; adds layout complexity)
- Breaking-news auto-bumped refresh cadence (live stream covers real-time events)
- Routing YouTube audio through the Jarvis output device pipeline (browser iframe API exposes volume only; full audio routing would need a separate native bridge — overkill for v1)
- Per-story TTS readout ("read me the third headline") — possible later, but not in this spec
- Persisting cache to disk across bridge restarts (in-memory is fine; cold-boot fetch is <2s)

## File Touch List

- `bridge/news.mjs` (new)
- `bridge/tool-router.mjs` (extend — register two tools)
- `bridge/server.mjs` (extend — call `news.start()` on boot, add `/api/news/refresh` route)
- `news-panel.js` (new)
- `index.html` (extend — add mount slot + script tag)
- `styles.css` (extend — news panel styles)
- `package.json` (extend — add `fast-xml-parser`)
- `test/news.test.mjs` (new)
- `test/fixtures/news/{sky,bbc,guardian}.xml`, `test/fixtures/news/hn.json` (new)
