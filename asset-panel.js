/** asset-panel.js — Side panel for generated images + videos.
 *
 *  Subscribes to bridge broadcasts after generate_teaser_image and
 *  animate_teaser_image complete. Shows the current asset (image or video),
 *  metadata (prompt, aspect, elapsed, influencer), an action toolbar
 *  (regenerate / animate / copy / save / open), and a history strip of the
 *  last 3 runs from disk.
 *
 *  DOM is built with createElement + textContent throughout. Image / video
 *  src values go through safeFileUrl() which only accepts http(s) URLs or
 *  paths under the project's output/ folder (served by the bridge).
 */

import * as Bridge from "./bridge-client.js";

const BRIDGE_BASE = "http://localhost:8766";

let _root = null;
/** Current rendered asset state. */
const _state = { runId: null, kind: null, mediaPath: null, prompt: "", aspect: "", elapsedMs: null, influencer: null };

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
  applyAssetPayload(payload);
  refreshHistory();
}

export function hide() {
  if (!_root) return;
  _root.classList.remove("is-open", "is-collapsed");
  setTimeout(() => {
    if (!_root || _root.classList.contains("is-open")) return;
    _root.hidden = true;
    _root.replaceChildren();
    delete _root.dataset.built;
    Object.assign(_state, { runId: null, kind: null, mediaPath: null, prompt: "", aspect: "", elapsedMs: null, influencer: null });
  }, 320);
}

function ensureRoot() {
  if (_root) return;
  _root = document.getElementById("asset-panel-root");
  if (!_root) console.warn("[asset-panel] #asset-panel-root not found");
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
  const grid = el("div", { class: "asset-grid" });

  const head = el("div", { class: "asset-head" });
  head.append(el("span", {}, "JARVIS · ASSET"));
  const closeBtn = el("button", { type: "button", class: "asset-action-btn" }, "CLOSE");
  closeBtn.addEventListener("click", () => hide());
  head.appendChild(closeBtn);

  const body = el("div", { class: "asset-body" });
  body.appendChild(el("div", { id: "asset-media", class: "asset-media" }));
  body.appendChild(el("div", { id: "asset-meta", class: "asset-meta" }));
  body.appendChild(el("div", { id: "asset-actions", class: "asset-actions" }));
  body.appendChild(el("div", { id: "asset-prompt-editor", class: "asset-prompt", hidden: "" }));
  body.appendChild(el("h3", { class: "asset-history-label" }, "Recent"));
  body.appendChild(el("div", { id: "asset-history", class: "asset-history" }));

  grid.append(head, body);
  _root.appendChild(grid);

  renderActions();
}

function applyAssetPayload(payload) {
  if (!payload) return;
  /* Accept either shape: from teaser.image_ready / teaser.video_ready / asset.panel.show. */
  _state.runId      = payload.run_id || payload.runId || _state.runId;
  _state.kind       = payload.kind || (payload.clipPath ? "video" : payload.imagePath ? "image" : _state.kind);
  _state.mediaPath  = payload.imagePath || payload.clipPath || payload.path || _state.mediaPath;
  _state.prompt     = payload.prompt || payload.motion_prompt || _state.prompt;
  _state.aspect     = payload.aspect || _state.aspect;
  _state.elapsedMs  = payload.elapsed_ms != null ? payload.elapsed_ms : _state.elapsedMs;
  _state.influencer = payload.influencer || _state.influencer;
  renderMedia();
  renderMeta();
  renderActions();
}

function renderMedia() {
  if (!_root) return;
  const mount = _root.querySelector("#asset-media");
  if (!mount) return;
  mount.replaceChildren();
  if (!_state.mediaPath) {
    mount.appendChild(el("div", { class: "asset-media-empty" }, "Generate an image to see it here."));
    return;
  }
  const url = safeFileUrl(_state.mediaPath);
  if (!url) {
    mount.appendChild(el("div", { class: "asset-media-empty" }, "Unable to display this asset."));
    return;
  }
  if (_state.kind === "video") {
    const v = el("video", { controls: true, autoplay: true, muted: true, loop: true, playsinline: true });
    v.src = url;
    mount.appendChild(v);
  } else {
    const img = el("img", { alt: "Generated image" });
    img.src = url;
    mount.appendChild(img);
  }
}

function renderMeta() {
  if (!_root) return;
  const mount = _root.querySelector("#asset-meta");
  if (!mount) return;
  mount.replaceChildren();
  const addRow = (label, value) => {
    if (value == null || value === "") return;
    const row = el("div", { class: "asset-meta-row" });
    row.append(el("span", { class: "asset-meta-label" }, label), el("span", {}, String(value)));
    mount.appendChild(row);
  };
  addRow("Run", _state.runId);
  addRow("Kind", _state.kind);
  addRow("Aspect", _state.aspect);
  if (_state.elapsedMs != null) addRow("Generated in", `${(_state.elapsedMs / 1000).toFixed(1)}s`);
  if (_state.influencer) addRow("Influencer", _state.influencer);
  if (_state.prompt) {
    const promptRow = el("div", { class: "asset-meta-row" });
    promptRow.append(
      el("span", { class: "asset-meta-label" }, "Prompt"),
      el("span", { style: "max-width:380px; display:inline-block;" }, _state.prompt.length > 200 ? _state.prompt.slice(0, 200) + "…" : _state.prompt),
    );
    mount.appendChild(promptRow);
  }
}

function renderActions() {
  if (!_root) return;
  const mount = _root.querySelector("#asset-actions");
  if (!mount) return;
  mount.replaceChildren();
  const make = (label, handler, opts = {}) => {
    const b = el("button", { type: "button", class: "asset-action-btn", ...(opts.disabled ? { disabled: "" } : {}) }, label);
    b.addEventListener("click", handler);
    return b;
  };
  const hasMedia = !!_state.mediaPath;
  mount.append(
    make("REGENERATE", openPromptEditor, { disabled: !_state.runId }),
    make("ANIMATE",    onAnimate,        { disabled: !(hasMedia && _state.kind === "image") }),
    make("COPY",       onCopy,           { disabled: !hasMedia }),
    make("SAVE",       onSave,           { disabled: !hasMedia }),
    make("OPEN",       onOpen,           { disabled: !hasMedia }),
  );
}

function openPromptEditor() {
  if (!_root) return;
  const wrap = _root.querySelector("#asset-prompt-editor");
  if (!wrap) return;
  wrap.replaceChildren();
  wrap.removeAttribute("hidden");
  const ta = el("textarea", { class: "asset-prompt-textarea", rows: 4 });
  ta.value = _state.prompt || "";
  const row = el("div", { class: "asset-prompt-row" });
  const submit = el("button", { type: "button", class: "asset-action-btn" }, "REGENERATE");
  const cancel = el("button", { type: "button", class: "asset-action-btn" }, "CANCEL");
  submit.addEventListener("click", async () => {
    submit.setAttribute("disabled", "");
    try {
      await fetch(`${BRIDGE_BASE}/api/asset-panel/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: _state.runId, prompt: ta.value.trim(), aspect: _state.aspect, influencer: _state.influencer }),
      });
      wrap.setAttribute("hidden", "");
    } catch (e) {
      console.warn("[asset-panel] regenerate failed:", e.message);
      submit.removeAttribute("disabled");
    }
  });
  cancel.addEventListener("click", () => { wrap.setAttribute("hidden", ""); });
  row.append(submit, cancel);
  wrap.append(ta, row);
}

async function onAnimate() {
  if (!_state.runId) return;
  try {
    await fetch(`${BRIDGE_BASE}/api/asset-panel/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: _state.runId }),
    });
  } catch (e) { console.warn("[asset-panel] animate failed:", e.message); }
}

async function onCopy() {
  if (!_state.mediaPath) return;
  try {
    await fetch(`${BRIDGE_BASE}/api/asset-panel/copy-to-clipboard`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: _state.mediaPath }),
    });
  } catch (e) { console.warn("[asset-panel] copy failed:", e.message); }
}

async function onSave() {
  if (!_state.mediaPath) return;
  try {
    await fetch(`${BRIDGE_BASE}/api/asset-panel/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: _state.mediaPath }),
    });
  } catch (e) { console.warn("[asset-panel] save failed:", e.message); }
}

async function onOpen() {
  if (!_state.mediaPath) return;
  try {
    await fetch(`${BRIDGE_BASE}/api/asset-panel/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: _state.mediaPath }),
    });
  } catch (e) { console.warn("[asset-panel] open failed:", e.message); }
}

async function refreshHistory() {
  if (!_root) return;
  const mount = _root.querySelector("#asset-history");
  if (!mount) return;
  mount.replaceChildren();
  try {
    const r = await fetch(`${BRIDGE_BASE}/api/asset-panel/history`);
    if (!r.ok) return;
    const j = await r.json();
    const items = Array.isArray(j?.items) ? j.items.slice(0, 3) : [];
    for (const it of items) {
      const thumb = el("button", { type: "button", class: "asset-history-thumb", title: it.prompt || it.run_id });
      const url = safeFileUrl(it.path);
      if (url) {
        if (it.kind === "video") {
          const v = el("video", { muted: true, playsinline: true });
          v.src = url;
          thumb.appendChild(v);
        } else {
          const img = el("img", { alt: it.run_id || "" });
          img.src = url;
          thumb.appendChild(img);
        }
      }
      thumb.addEventListener("click", () => {
        applyAssetPayload({ run_id: it.run_id, kind: it.kind, path: it.path, prompt: it.prompt });
      });
      mount.appendChild(thumb);
    }
  } catch (e) { /* history is best-effort */ }
}

function safeFileUrl(p) {
  const s = String(p || "");
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  const m = s.match(/\/output\/(.+)$/);
  if (m) return `${BRIDGE_BASE}/output/${m[1]}`;
  return "";
}

Bridge.on("teaser.image_ready",  (msg) => { show({ ...msg.data, kind: "image" }); });
Bridge.on("teaser.video_ready",  (msg) => { show({ ...msg.data, kind: "video" }); });
Bridge.on("asset.panel.show",    (msg) => { show({ ...msg.data }); });
