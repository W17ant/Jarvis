/** weather-panel.js — Side panel for current weather + 5-day forecast.
 *
 *  Subscribes to bridge broadcast `weather.show` (fired by the show-me-the-
 *  weather fast-path). Renders a "now" block plus a forecast strip from the
 *  cached get_weather data — sub-second open because the data was already
 *  warmed by the prewarm module.
 *
 *  DOM is built with createElement + textContent (no innerHTML). No
 *  payload-derived URLs are inserted into the DOM — weather has no link-
 *  bearing fields. Numbers and labels only.
 */

import * as Bridge from "./bridge-client.js";

const BRIDGE_BASE = "http://localhost:8766";

let _root = null;
let _state = { data: null };

export function show(payload = {}) {
  ensureRoot();
  if (!_root) return;
  if (!_root.dataset.built) {
    buildShell();
    _root.dataset.built = "1";
    _root.style.width = "min(560px, 92vw)";
  }
  _root.hidden = false;
  _root.classList.remove("is-collapsed");
  requestAnimationFrame(() => _root.classList.add("is-open"));
  _state.data = payload;
  renderPayload();
}

export function hide() {
  if (!_root) return;
  _root.classList.remove("is-open", "is-collapsed");
  setTimeout(() => {
    if (!_root || _root.classList.contains("is-open")) return;
    _root.hidden = true;
    _root.replaceChildren();
    delete _root.dataset.built;
    _state.data = null;
  }, 320);
}

function ensureRoot() {
  if (_root) return;
  _root = document.getElementById("weather-panel-root");
  if (!_root) console.warn("[weather-panel] #weather-panel-root not found");
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    node.setAttribute(k, v === true ? "" : String(v));
  }
  if (text != null) node.textContent = String(text);
  return node;
}

function buildShell() {
  _root.replaceChildren();
  const grid = el("div", { class: "weather-grid" });

  const head = el("div", { class: "weather-head" });
  head.append(el("span", {}, "JARVIS · WEATHER"));
  const ctrls = el("span");
  const refresh = el("button", { type: "button", class: "weather-refresh-btn" }, "REFRESH");
  refresh.addEventListener("click", onRefresh);
  const close = el("button", { type: "button", class: "weather-refresh-btn", style: "margin-left:6px" }, "CLOSE");
  close.addEventListener("click", () => hide());
  ctrls.append(refresh, close);
  head.appendChild(ctrls);

  const body = el("div", { class: "weather-body" });
  body.appendChild(el("div", { id: "weather-now", class: "weather-now" }));
  body.appendChild(el("div", { id: "weather-forecast", class: "weather-forecast" }));

  grid.append(head, body);
  _root.appendChild(grid);
}

function renderPayload() {
  if (!_root) return;
  const data = _state.data || {};
  const nowMount = _root.querySelector("#weather-now");
  const fcMount  = _root.querySelector("#weather-forecast");
  if (!nowMount || !fcMount) return;

  /* Now block. */
  nowMount.replaceChildren();
  const temp = data?.now?.temp;
  const code = data?.now?.code;
  if (temp != null) {
    nowMount.appendChild(el("div", { class: "weather-now-temp" }, `${temp}°`));
    nowMount.appendChild(el("div", { class: "weather-now-label" }, `${codeIcon(code)} ${codeLabel(code)}`));
  } else {
    nowMount.appendChild(el("div", { class: "weather-now-label" }, "Loading…"));
  }
  const placeName = data?.location?.name || "";
  const country   = data?.location?.country || "";
  if (placeName) {
    nowMount.appendChild(el("div", { class: "weather-location" }, country ? `${placeName}, ${country}` : placeName));
  }

  /* Forecast strip. */
  fcMount.replaceChildren();
  const forecast = Array.isArray(data?.forecast) ? data.forecast.slice(0, 5) : [];
  if (forecast.length === 0) {
    fcMount.appendChild(el("div", { class: "weather-now-label" }, "Forecast unavailable."));
    return;
  }
  for (const d of forecast) {
    const cell = el("div", { class: "weather-day" });
    cell.appendChild(el("div", { class: "weather-day-name" }, shortDayName(d.date)));
    cell.appendChild(el("div", { class: "weather-day-icon" }, codeIcon(d.code)));
    cell.appendChild(el("div", { class: "weather-day-temp" }, `${d.hi}° / ${d.lo}°`));
    if (d.rain_mm != null && d.rain_mm > 0) {
      cell.appendChild(el("div", { class: "weather-day-rain" }, `${d.rain_mm.toFixed(1)} mm`));
    }
    fcMount.appendChild(cell);
  }
}

function shortDayName(isoDate) {
  if (!isoDate) return "—";
  try {
    return new Date(isoDate).toLocaleDateString("en-GB", { weekday: "short" });
  } catch { return "—"; }
}

/** WMO weather code → emoji icon. Matches the server-side wmoLabel ranges. */
function codeIcon(code) {
  if (code == null) return "•";
  if (code === 0) return "☀️";
  if (code <= 3)  return "⛅";
  if (code <= 48) return "🌫";
  if (code <= 67) return "🌧";
  if (code <= 77) return "❄️";
  if (code <= 82) return "🌦";
  if (code <= 99) return "⛈";
  return "•";
}

function codeLabel(code) {
  if (code == null) return "—";
  if (code === 0) return "clear";
  if (code <= 3)  return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 67) return "rainy";
  if (code <= 77) return "snowy";
  if (code <= 82) return "showers";
  if (code <= 99) return "thunderstorms";
  return "unknown";
}

async function onRefresh() {
  try {
    await fetch(`${BRIDGE_BASE}/api/weather-panel/refresh`, { method: "POST" });
  } catch (e) { console.warn("[weather-panel] refresh failed:", e.message); }
}

Bridge.on("weather.show",   (msg) => show(msg.data || {}));
Bridge.on("weather.update", (msg) => show(msg.data || {}));
