/** influencer-wizard-panel.js — Side-panel wizard for "create an influencer".
 *
 *  Mounts when the bridge broadcasts `influencer.wizard.show`. Asks four
 *  questions (sex, vibe, content type, optional reference URL), then on
 *  GO posts the answers to /api/influencer/pipeline/start and renders the
 *  pipeline's progress + results as the bridge broadcasts
 *  `influencer.pipeline.update` events.
 *
 *  All DOM is built with createElement + textContent (no innerHTML
 *  anywhere). Image / video sources go through safeFileUrl() which only
 *  allows http(s) URLs or paths under the project's output/ folder served
 *  by the bridge.
 */

import * as Bridge from "./bridge-client.js";

/** HUD is on :8765 but the bridge HTTP API lives on :8766. The pipeline
 *  start route and /output static-serve are on the bridge. */
const BRIDGE_BASE = "http://localhost:8766";

const VIBE_PRESETS  = ["cinematic", "candid", "polished", "editorial"];
const SEX_OPTIONS   = ["male", "female", "other"];
const CONTENT_TYPES = ["brand-product", "faceless", "dances"];

let _root = null;
/** Current wizard state — answers + activeRunId. */
const _state = { sex: null, vibe: null, contentType: null, sourceUrl: "", runId: null };

export function show() {
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
}

export function hide() {
  if (!_root) return;
  _root.classList.remove("is-open", "is-collapsed");
  setTimeout(() => {
    if (!_root || _root.classList.contains("is-open")) return;
    _root.hidden = true;
    _root.replaceChildren();
    delete _root.dataset.built;
    Object.assign(_state, { sex: null, vibe: null, contentType: null, sourceUrl: "", runId: null });
  }, 320);
}

function ensureRoot() {
  if (_root) return;
  _root = document.getElementById("influencer-wizard-root");
  if (!_root) console.warn("[inf-wizard] #influencer-wizard-root not found");
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

  const grid = el("div", { class: "inf-wizard-grid" });

  /* Header */
  const head = el("div", { class: "inf-wizard-head" });
  head.append(el("span", {}, "CREATE AN INFLUENCER"));
  const closeBtn = el("button", { type: "button", class: "news-panel-toggle", style: "position:static;width:auto;height:auto;padding:4px 10px;transform:none" }, "CLOSE");
  closeBtn.addEventListener("click", () => hide());
  head.appendChild(closeBtn);

  /* Body */
  const body = el("div", { class: "inf-wizard-body" });
  body.append(
    buildQuestion("Sex", "sex", SEX_OPTIONS),
    buildQuestion("Vibe", "vibe", VIBE_PRESETS),
    buildQuestion("Content type", "contentType", CONTENT_TYPES),
    buildUrlInput(),
    buildGoRow(),
    buildProgress(),
    buildResults(),
  );

  grid.append(head, body);
  _root.appendChild(grid);
}

function buildQuestion(label, key, options) {
  const wrap = el("div", { class: "inf-q" });
  wrap.appendChild(el("div", { class: "inf-q-label" }, label));
  const chips = el("div", { class: "inf-chips" });
  for (const opt of options) {
    const b = el("button", { type: "button", class: "inf-chip", "data-key": key, "data-value": opt }, opt);
    b.addEventListener("click", () => selectChip(key, opt));
    chips.appendChild(b);
  }
  wrap.appendChild(chips);
  return wrap;
}

function buildUrlInput() {
  const wrap = el("div", { class: "inf-q" });
  wrap.appendChild(el("div", { class: "inf-q-label" }, "Reference URL (optional — TikTok / IG / YouTube)"));
  const inp = el("input", { type: "text", class: "inf-url-input", id: "inf-url", placeholder: "https://www.tiktok.com/..." });
  inp.addEventListener("input", () => { _state.sourceUrl = inp.value.trim(); });
  wrap.appendChild(inp);
  return wrap;
}

function buildGoRow() {
  const row = el("div", { class: "inf-go-row" });
  const go = el("button", { type: "button", class: "inf-go-btn", id: "inf-go", disabled: "" }, "GO");
  go.addEventListener("click", onGoClick);
  row.appendChild(go);
  return row;
}

function buildProgress() {
  const wrap = el("div", { class: "inf-progress", id: "inf-progress", hidden: "" });
  for (const stage of ["refs", "hero", "caption", "video"]) {
    const row = el("div", { class: "inf-stage-row", "data-stage": stage, "data-status": "pending" });
    row.append(el("span", {}, stageLabel(stage)), el("span", { class: "inf-stage-status" }, "pending"));
    wrap.appendChild(row);
  }
  return wrap;
}

function buildResults() {
  return el("div", { class: "inf-results", id: "inf-results" });
}

function stageLabel(s) {
  return ({ refs: "Reference portrait", hero: "Hero image", caption: "Captions", video: "Animated clip" })[s] || s;
}

function selectChip(key, value) {
  _state[key] = value;
  /* Reflect in DOM: toggle is-active on all chips for this key. */
  if (!_root) return;
  for (const b of _root.querySelectorAll(`.inf-chip[data-key="${key}"]`)) {
    b.classList.toggle("is-active", b.dataset.value === value);
  }
  refreshGoButton();
}

function refreshGoButton() {
  const go = _root?.querySelector("#inf-go");
  if (!go) return;
  const ready = _state.sex && _state.vibe && _state.contentType;
  if (ready) go.removeAttribute("disabled");
  else go.setAttribute("disabled", "");
}

async function onGoClick() {
  if (!_state.sex || !_state.vibe || !_state.contentType) return;
  /* Disable controls and show progress strip. */
  const go = _root.querySelector("#inf-go");
  if (go) go.setAttribute("disabled", "");
  const prog = _root.querySelector("#inf-progress");
  if (prog) prog.removeAttribute("hidden");
  resetStages();
  /* Fire the pipeline. */
  try {
    const r = await fetch(`${BRIDGE_BASE}/api/influencer/pipeline/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sex: _state.sex,
        vibe: _state.vibe,
        contentType: _state.contentType,
        sourceUrl: _state.sourceUrl || undefined,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.warn("[inf-wizard] start failed:", j);
  } catch (e) {
    console.warn("[inf-wizard] start threw:", e.message);
  }
}

function resetStages() {
  if (!_root) return;
  for (const row of _root.querySelectorAll(".inf-stage-row")) {
    row.dataset.status = "pending";
    const status = row.querySelector(".inf-stage-status");
    if (status) status.textContent = "pending";
  }
  const results = _root.querySelector("#inf-results");
  if (results) results.replaceChildren();
}

/* ── Voice transcript → chip auto-fill ─────────────────────────────────── */

/** Map a Whisper partial transcript onto the four wizard fields. voice.js
 *  dispatches `jarvis.stt.partial` from _dictationOnPartial for any panel
 *  that wants live STT input. Matching is permissive — operator can
 *  over-speak any chip and click the desired value to override. */
function parseTranscriptIntoState(text) {
  if (!_root || _root.hidden) return;
  const t = String(text || "").toLowerCase();
  /* Sex */
  if (/\b(male|man|guy|dude|bloke)\b/.test(t) && !/\bfemale\b/.test(t)) selectChip("sex", "male");
  else if (/\b(female|woman|girl|lady)\b/.test(t)) selectChip("sex", "female");
  else if (/\bother\b/.test(t)) selectChip("sex", "other");
  /* Vibe */
  if (/\bcinematic|cinema\b/.test(t)) selectChip("vibe", "cinematic");
  else if (/\bcandid|phone\b/.test(t)) selectChip("vibe", "candid");
  else if (/\bpolished|commercial\b/.test(t)) selectChip("vibe", "polished");
  else if (/\beditorial|magazine\b/.test(t)) selectChip("vibe", "editorial");
  /* Content type */
  if (/\b(brand|product)\b/.test(t)) selectChip("contentType", "brand-product");
  else if (/\bfaceless\b/.test(t)) selectChip("contentType", "faceless");
  else if (/\bdanc/.test(t)) selectChip("contentType", "dances");
  /* URL — first http(s) URL containing a known social host. */
  const urlMatch = t.match(/https?:\/\/\S*(?:tiktok\.com|instagram\.com|youtube\.com|youtu\.be)\S*/);
  if (urlMatch) {
    const inp = _root.querySelector("#inf-url");
    if (inp) { inp.value = urlMatch[0]; _state.sourceUrl = urlMatch[0]; }
  }
  /* GO trigger phrases (only fire when all three chips set). */
  if (/\b(go|start|do it|fire it|kick off)\b/.test(t) && _state.sex && _state.vibe && _state.contentType) {
    const go = _root.querySelector("#inf-go");
    if (go && !go.hasAttribute("disabled")) go.click();
  }
}

window.addEventListener("jarvis.stt.partial", (ev) => {
  const text = ev?.detail?.text;
  if (text) parseTranscriptIntoState(text);
});

/* ── Pipeline event handlers + result rendering ────────────────────────── */

/** Update one stage row + append result content for relevant stages. */
function applyPipelineUpdate(data) {
  if (!_root || _root.hidden) return;
  const { stage, status, payload } = data || {};
  if (!stage) return;
  const row = _root.querySelector(`.inf-stage-row[data-stage="${stage}"]`);
  if (row) {
    row.dataset.status = status;
    const s = row.querySelector(".inf-stage-status");
    if (s) s.textContent = status;
  }
  if (status !== "done") return;
  const results = _root.querySelector("#inf-results");
  if (!results) return;
  if (stage === "hero" && payload?.hero_path) {
    const slot = el("div", { class: "inf-result-slot" });
    slot.appendChild(el("h3", {}, "Hero image"));
    const img = el("img", { alt: "Hero image" });
    img.src = safeFileUrl(payload.hero_path);
    slot.appendChild(img);
    results.appendChild(slot);
  } else if (stage === "video" && payload?.clip_path) {
    const slot = el("div", { class: "inf-result-slot" });
    slot.appendChild(el("h3", {}, payload.source === "motion" ? "Motion-control clip" : "Animated clip"));
    const v = el("video", { controls: true, autoplay: true, muted: true, loop: true, playsinline: true });
    v.src = safeFileUrl(payload.clip_path);
    slot.appendChild(v);
    results.appendChild(slot);
  } else if (stage === "caption" && payload?.captions) {
    const slot = el("div", { class: "inf-result-slot" });
    slot.appendChild(el("h3", {}, "Captions"));
    for (const [platform, text] of Object.entries(payload.captions)) {
      const block = el("div", { class: "inf-caption-block" });
      block.append(
        el("div", { class: "inf-caption-block-label" }, platform.toUpperCase()),
        el("div", {}, String(text || "")),
      );
      slot.appendChild(block);
    }
    results.appendChild(slot);
  }
}

/** Resolve a bridge-side local file path into a URL the browser can load.
 *  The bridge serves /output/... statically; we accept absolute paths under
 *  the project's output/ folder and rewrite them. Anything else returns ""
 *  so we don't request file:// (browser-blocked) or a random absolute path. */
function safeFileUrl(p) {
  const s = String(p || "");
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  const m = s.match(/\/output\/(.+)$/);
  if (m) return `${BRIDGE_BASE}/output/${m[1]}`;
  return "";
}

Bridge.on("influencer.wizard.show", () => show());
Bridge.on("influencer.pipeline.update", (msg) => applyPipelineUpdate(msg.data));
Bridge.on("influencer.pipeline.complete", () => {
  /* Pipeline done — append a footer with REGENERATE and SAVE & USE.
   * SAVE & USE just closes the panel; the locked influencer is already
   * persisted by the orchestrator's lock_influencer step. */
  if (!_root || _root.hidden) return;
  const results = _root.querySelector("#inf-results");
  if (!results || results.querySelector(".inf-footer")) return;
  const footer = el("div", { class: "inf-footer inf-go-row" });
  const regen = el("button", { type: "button", class: "inf-regen-btn" }, "REGENERATE");
  regen.addEventListener("click", onGoClick);
  const save = el("button", { type: "button", class: "inf-save-btn" }, "SAVE & USE");
  save.addEventListener("click", () => hide());
  footer.append(regen, save);
  results.appendChild(footer);
});
