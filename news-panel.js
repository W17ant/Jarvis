/** news-panel.js — Full-screen news mode driven by bridge broadcasts.
 *
 *  Mounts when the bridge sends { type: "news.show", data: cache }, unmounts
 *  on { type: "news.hide" } or Esc. While mounted: renders the live Sky News
 *  YouTube embed plus two columns of headlines, polls TTS state to duck
 *  YouTube volume during assistant speech, and exposes a manual refresh
 *  button that POSTs /api/news/refresh.
 *
 *  All DOM is built with createElement + textContent (no innerHTML anywhere).
 *  This makes XSS through a poisoned RSS feed structurally impossible even
 *  if upstream sanitisation regresses.
 */

import * as Bridge from "./bridge-client.js";
import { isSpeaking } from "./tts.js";

/** Sky News' 24/7 live broadcast video ID. The /embed/live_stream?channel=ID
 *  URL pattern returned "video unavailable" — Sky appears to block the
 *  channel-live embed on third-party domains. The direct video-ID embed
 *  works. Sky's live ID has been stable as YDvsBbKfLPA for a long time but
 *  CAN rotate — if the panel ever shows "video unavailable", search YouTube
 *  for "sky news live" and update this constant. */
const SKY_NEWS_LIVE_VIDEO_ID = "YDvsBbKfLPA";

const WIDTH_KEY     = "news-panel:width";   /* localStorage key for persisted width */
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

/** Slide the panel out and tear down media + listeners. */
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
  toggle.textContent = "›";
  toggle.addEventListener("click", () => {
    if (isCollapsed()) expand();
    else collapse();
  });
  _root.appendChild(toggle);

  /* Resize handle — sits inside the panel's left edge. */
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
  try { localStorage.setItem(WIDTH_KEY, String(_root.getBoundingClientRect().width)); }
  catch {}
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

/** HUD is served on :8765 but the bridge HTTP API lives on :8766. The
 *  refresh route is on the bridge — must hit it by absolute URL or the
 *  HUD server replies 501 Unsupported method. */
const BRIDGE_BASE = "http://localhost:8766";

async function onRefreshClick() {
  try {
    const r = await fetch(`${BRIDGE_BASE}/api/news/refresh`, { method: "POST" });
    if (!r.ok) console.warn("[news-panel] refresh failed:", r.status);
    /* On success the bridge broadcasts news.update; subscriber re-renders. */
  } catch (e) {
    console.warn("[news-panel] refresh threw:", e.message);
  }
}

/* ── YouTube IFrame Player ───────────────────────────────────────────────── */

/** Load the YouTube IFrame API once, lazily, on first mount. The script
 *  defines window.onYouTubeIframeAPIReady — we hook into it with a one-shot
 *  promise so mountYouTubePlayer can await readiness. */
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
     * (YT.Player only accepts a video ID, not a channel). We then attach a
     * YT.Player wrapper to the iframe so we can call setVolume() for ducking. */
    const iframe = document.createElement("iframe");
    iframe.id = "news-player-iframe";
    iframe.src = `https://www.youtube.com/embed/${SKY_NEWS_LIVE_VIDEO_ID}?enablejsapi=1&autoplay=1`;
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
/* ── TTS volume ducking ──────────────────────────────────────────────────── */

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

/* Bridge wire-up. */
Bridge.on("news.show",   (msg) => show(msg.data || {}));
Bridge.on("news.hide",   () => hide());
Bridge.on("news.update", (msg) => { if (_root && !_root.hidden) renderColumns(msg.data || {}); });
