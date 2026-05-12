/** screenshot-panel.js — Side panel for the most recently captured screenshot.
 *
 *  Subscribes to bridge broadcast `screenshot.taken` after take_screenshot
 *  completes. Renders the image, capture metadata, and an action toolbar
 *  (copy / save / describe-with-vision / open in Preview).
 *
 *  DOM is built with createElement + textContent. The image src is the
 *  bridge's /output/... static endpoint — no file:// or arbitrary paths.
 */

import * as Bridge from "./bridge-client.js";

const BRIDGE_BASE = "http://localhost:8766";

let _root = null;
const _state = { path: null, region: null, takenAt: null, description: null };

export function show(payload = {}) {
  ensureRoot();
  if (!_root) return;
  if (!_root.dataset.built) {
    buildShell();
    _root.dataset.built = "1";
    _root.style.width = "min(640px, 92vw)";
  }
  _root.hidden = false;
  _root.classList.remove("is-collapsed");
  requestAnimationFrame(() => _root.classList.add("is-open"));
  applyPayload(payload);
}

export function hide() {
  if (!_root) return;
  _root.classList.remove("is-open", "is-collapsed");
  setTimeout(() => {
    if (!_root || _root.classList.contains("is-open")) return;
    _root.hidden = true;
    _root.replaceChildren();
    delete _root.dataset.built;
    Object.assign(_state, { path: null, region: null, takenAt: null, description: null });
  }, 320);
}

function ensureRoot() {
  if (_root) return;
  _root = document.getElementById("screenshot-panel-root");
  if (!_root) console.warn("[screenshot-panel] #screenshot-panel-root not found");
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
  const grid = el("div", { class: "shot-grid" });

  const head = el("div", { class: "shot-head" });
  head.append(el("span", {}, "JARVIS · SCREENSHOT"));
  const closeBtn = el("button", { type: "button", class: "shot-action-btn" }, "CLOSE");
  closeBtn.addEventListener("click", () => hide());
  head.appendChild(closeBtn);

  const body = el("div", { class: "shot-body" });
  body.appendChild(el("div", { id: "shot-image", class: "shot-image" }));
  body.appendChild(el("div", { id: "shot-meta", class: "shot-meta" }));
  body.appendChild(el("div", { id: "shot-actions", class: "shot-actions" }));
  body.appendChild(el("div", { id: "shot-describe", class: "shot-describe-out", hidden: "" }));

  grid.append(head, body);
  _root.appendChild(grid);

  renderActions();
}

function applyPayload(payload) {
  if (!payload) return;
  _state.path     = payload.path || _state.path;
  _state.region   = payload.region || _state.region;
  _state.takenAt  = payload.takenAt || payload.taken_at || Date.now();
  _state.description = null;
  renderImage();
  renderMeta();
  renderActions();
  const dOut = _root?.querySelector("#shot-describe");
  if (dOut) { dOut.setAttribute("hidden", ""); dOut.replaceChildren(); }
}

function renderImage() {
  if (!_root) return;
  const mount = _root.querySelector("#shot-image");
  if (!mount) return;
  mount.replaceChildren();
  if (!_state.path) {
    mount.appendChild(el("div", {}, "No screenshot yet."));
    return;
  }
  const url = safeFileUrl(_state.path);
  if (!url) {
    mount.appendChild(el("div", {}, "Unable to display this screenshot."));
    return;
  }
  const img = el("img", { alt: "Screenshot" });
  img.src = url;
  mount.appendChild(img);
}

function renderMeta() {
  if (!_root) return;
  const mount = _root.querySelector("#shot-meta");
  if (!mount) return;
  mount.replaceChildren();
  const addRow = (label, value) => {
    if (value == null || value === "") return;
    const row = el("div", { class: "shot-meta-row" });
    row.append(el("span", { class: "shot-meta-label" }, label), el("span", {}, String(value)));
    mount.appendChild(row);
  };
  addRow("Region", _state.region || "screen");
  if (_state.takenAt) addRow("Captured", new Date(_state.takenAt).toLocaleTimeString());
}

function renderActions() {
  if (!_root) return;
  const mount = _root.querySelector("#shot-actions");
  if (!mount) return;
  mount.replaceChildren();
  const make = (label, handler, disabled = false) => {
    const b = el("button", { type: "button", class: "shot-action-btn", ...(disabled ? { disabled: "" } : {}) }, label);
    b.addEventListener("click", handler);
    return b;
  };
  const hasImg = !!_state.path;
  mount.append(
    make("COPY",     onCopy,     !hasImg),
    make("SAVE",     onSave,     !hasImg),
    make("DESCRIBE", onDescribe, !hasImg),
    make("OPEN",     onOpen,     !hasImg),
  );
}

async function onCopy() {
  if (!_state.path) return;
  try {
    await fetch(`${BRIDGE_BASE}/api/screenshot-panel/copy-to-clipboard`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: _state.path }),
    });
  } catch (e) { console.warn("[screenshot-panel] copy failed:", e.message); }
}

async function onSave() {
  if (!_state.path) return;
  try {
    await fetch(`${BRIDGE_BASE}/api/screenshot-panel/save`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: _state.path }),
    });
  } catch (e) { console.warn("[screenshot-panel] save failed:", e.message); }
}

async function onDescribe() {
  if (!_state.path || !_root) return;
  const out = _root.querySelector("#shot-describe");
  if (!out) return;
  out.removeAttribute("hidden");
  out.replaceChildren(el("div", {}, "Describing…"));
  try {
    const r = await fetch(`${BRIDGE_BASE}/api/screenshot-panel/describe`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: _state.path }),
    });
    const j = await r.json().catch(() => ({}));
    const desc = j?.description || j?.error || "No description returned.";
    out.replaceChildren(el("div", {}, desc));
    _state.description = desc;
  } catch (e) {
    out.replaceChildren(el("div", {}, `Failed: ${e.message}`));
  }
}

async function onOpen() {
  if (!_state.path) return;
  try {
    await fetch(`${BRIDGE_BASE}/api/screenshot-panel/open`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: _state.path }),
    });
  } catch (e) { console.warn("[screenshot-panel] open failed:", e.message); }
}

function safeFileUrl(p) {
  const s = String(p || "");
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  const m = s.match(/\/output\/(.+)$/);
  if (m) return `${BRIDGE_BASE}/output/${m[1]}`;
  return "";
}

Bridge.on("screenshot.taken", (msg) => show(msg.data || {}));
