/** live.js - Live Shoot Mode controller for the phone-as-mic companion view.
 *
 *  Why: photographers shoot tethered with both hands on the camera; they can't reach
 *  for the kiosk to flag a hero or note an issue mid-frame. With the phone hanging on
 *  a strap they thumb-tap the mic, say "flag as hero" or "caption that low-angle", and
 *  the kiosk reacts in real time. The bridge fans the same events into the main HUD's
 *  task strip so the editor at the desk sees what's happening in the studio.
 *
 *  Architecture:
 *    - Push-to-talk mic (MediaRecorder webm/opus → POST /live/transcribe → Whisper)
 *    - Quick-action chips fire flag_shot directly (no STT round-trip needed)
 *    - WebSocket subscription to bridge events → feed updates in real time
 *    - Active shoot picker scopes everything to one folder
 *
 *  Auto-detects bridge URL from the page origin so the operator can scan the QR code,
 *  the kiosk shows on screen and the phone connects without manual config. */

const BRIDGE_HTTP = window.location.origin;
const BRIDGE_WS = BRIDGE_HTTP.replace(/^http/, "ws");

/* ────────── DOM refs ────────── */
const feedEl = document.getElementById("feed");
const projectSel = document.getElementById("projectSel");
const micBtn = document.getElementById("micBtn");
const micStatus = document.getElementById("micStatus");
const connStatus = document.getElementById("connStatus");

/* ────────── State ────────── */
let activeProject = "";
let mediaRecorder = null;
let chunks = [];
let recording = false;
let ws = null;

/* ────────── Helpers ────────── */
/** Remove all children from a node — safer than innerHTML="". Used when rebuilding
 *  select / feed lists from server data. */
function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/* ────────── Connection ────────── */
function connectWS() {
  ws = new WebSocket(`${BRIDGE_WS}`);
  ws.addEventListener("open", () => {
    connStatus.textContent = "connected";
    connStatus.style.color = "#00ff88";
  });
  ws.addEventListener("close", () => {
    connStatus.textContent = "disconnected — retrying";
    connStatus.style.color = "var(--accent)";
    /* Why: if the operator's phone goes to sleep + wakes, the WS dies silently. Retry
     * with a small backoff so they don't have to refresh the page after every break. */
    setTimeout(connectWS, 2000);
  });
  ws.addEventListener("error", () => { /* close handler retries */ });
  ws.addEventListener("message", onWsMessage);
}

function onWsMessage(ev) {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  /* Echo the bridge's live events back into the feed so the photographer sees their
   * action confirmed. Only types we actively care about — everything else (HUD state,
   * task strip events) we ignore on the phone. */
  if (m.type === "live.caption" || m.type === "live.flag" || m.type === "live.note") {
    pushFeed({ kind: m.type.replace("live.", ""), text: m.data?.text || "(no text)" });
  }
}

/* ────────── Feed ────────── */
function pushFeed({ kind, text }) {
  const empty = feedEl.querySelector(".feed__empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = "feed__row" + (kind === "flag" || kind === "note" ? " feed__row--action" : "");
  const time = document.createElement("div");
  time.className = "feed__time";
  time.textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const t = document.createElement("div");
  t.className = "feed__text";
  t.textContent = text;
  row.appendChild(time);
  row.appendChild(t);
  /* Newest at top so the operator never has to scroll for the latest action. */
  feedEl.insertBefore(row, feedEl.firstChild);
  /* Cap at 30 rows — a phone running for hours shouldn't accumulate unbounded DOM. */
  while (feedEl.children.length > 30) feedEl.removeChild(feedEl.lastChild);
}

/* ────────── Projects ────────── */
async function loadProjects() {
  try {
    const r = await fetch(`${BRIDGE_HTTP}/projects`, { cache: "no-store" });
    if (!r.ok) throw new Error(`bridge ${r.status}`);
    const j = await r.json();
    clearNode(projectSel);
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "(latest shoot)";
    projectSel.appendChild(empty);
    for (const p of (j.items || [])) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.label}  (${p.images || 0}i · ${p.videos || 0}v)`;
      projectSel.appendChild(o);
    }
    activeProject = j.active || "";
    projectSel.value = activeProject;
  } catch (e) {
    clearNode(projectSel);
    const o = document.createElement("option");
    o.textContent = `bridge offline — ${e.message}`;
    projectSel.appendChild(o);
  }
}
projectSel.addEventListener("change", async () => {
  activeProject = projectSel.value;
  /* Persist on the bridge so the kiosk + phone stay in sync. */
  try {
    await fetch(`${BRIDGE_HTTP}/project/active`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: activeProject || null }),
    });
  } catch {}
});

/* ────────── Mic / push-to-talk ────────── */
async function ensureRecorder() {
  if (mediaRecorder) return mediaRecorder;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  /* Mobile Safari only supports a subset of MediaRecorder mime types. webm/opus works
   * on Chrome Android; mp4 is the Safari-iOS fallback. The bridge re-encodes via
   * Whisper which accepts both. */
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus"
             : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4"
             : "";
  mediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  mediaRecorder.addEventListener("dataavailable", (ev) => { if (ev.data.size) chunks.push(ev.data); });
  mediaRecorder.addEventListener("stop", onRecordingStop);
  return mediaRecorder;
}

async function startRec() {
  if (recording) return;
  try { await ensureRecorder(); }
  catch (e) {
    setMicStatus(`mic blocked: ${e.message}`, "error");
    return;
  }
  chunks = [];
  recording = true;
  mediaRecorder.start();
  micBtn.classList.add("is-recording");
  setMicStatus("recording…");
}

async function stopRec() {
  if (!recording) return;
  recording = false;
  micBtn.classList.remove("is-recording");
  setMicStatus("processing…");
  try { mediaRecorder.stop(); } catch {}
}

async function onRecordingStop() {
  if (!chunks.length) {
    setMicStatus("nothing recorded", "error");
    setTimeout(() => setMicStatus("tap and hold"), 1500);
    return;
  }
  const blob = new Blob(chunks, { type: chunks[0].type });
  chunks = [];

  /* Send the audio blob raw with its mime type as Content-Type. Bridge avoids a
   * multipart parser by accepting the body as-is and forwarding to Whisper. The
   * active project is sent as a query param since the body is binary. */
  let result;
  try {
    const r = await fetch(`${BRIDGE_HTTP}/live/transcribe?project=${encodeURIComponent(activeProject || "")}`, {
      method: "POST",
      headers: { "content-type": blob.type || "audio/webm" },
      body: blob,
    });
    if (!r.ok) throw new Error(`bridge ${r.status}`);
    result = await r.json();
  } catch (e) {
    setMicStatus(`failed: ${e.message}`, "error");
    setTimeout(() => setMicStatus("tap and hold"), 2000);
    return;
  }
  setMicStatus("sent", "ok");
  setTimeout(() => setMicStatus("tap and hold"), 1200);

  const text = (result?.text || "").trim();
  if (!text) {
    pushFeed({ kind: "caption", text: "(silence)" });
    return;
  }
  pushFeed({ kind: "caption", text });

  /* The bridge auto-routes the transcript on its side (flag intents trigger flag_shot,
   * everything else lands in the operator's HUD as a transcript message). The
   * /live/transcribe response includes any tool action that fired so we can echo it. */
  if (result.action) pushFeed({ kind: result.action.kind || "note", text: result.action.summary || JSON.stringify(result.action) });
}

function setMicStatus(text, kind) {
  micStatus.textContent = text;
  micStatus.className = "mic__status" + (kind ? ` is-${kind}` : "");
}

/* Push-and-hold semantics: pointerdown starts, pointerup/leave/cancel stops. Pointer
 * events handle both touch and mouse so the page works on a desktop browser too
 * (useful for testing). */
micBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); startRec(); });
micBtn.addEventListener("pointerup",   (e) => { e.preventDefault(); stopRec(); });
micBtn.addEventListener("pointerleave",(e) => { if (recording) stopRec(); });
micBtn.addEventListener("pointercancel", () => stopRec());

/* ────────── Quick actions ────────── */
async function fireQuickFlag(status) {
  try {
    const r = await fetch(`${BRIDGE_HTTP}/live/flag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, folder: activeProject || null }),
    });
    if (!r.ok) throw new Error(`bridge ${r.status}`);
    const j = await r.json();
    pushFeed({ kind: "flag", text: `${status.toUpperCase()} → ${j.file || "(latest shot)"}` });
  } catch (e) {
    pushFeed({ kind: "flag", text: `flag failed: ${e.message}` });
  }
}
document.getElementById("actHero").addEventListener("click",    () => fireQuickFlag("hero"));
document.getElementById("actKeep").addEventListener("click",    () => fireQuickFlag("keep"));
document.getElementById("actMaybe").addEventListener("click",   () => fireQuickFlag("maybe"));
document.getElementById("actReshoot").addEventListener("click", () => fireQuickFlag("reshoot"));

/* ────────── Boot ────────── */
loadProjects();
connectWS();
