/** frameio.mjs - Frame.io V4 client.
 *  Lets the operator review Frame.io traffic by voice: "what's pending review",
 *  "read me the comments on the press car cut", "leave a comment saying 'on it'", etc.
 *
 *  Auth: Developer token in FRAMEIO_TOKEN (issued from https://developer.frame.io/app).
 *  V4 API base: https://api.frame.io/v4
 *
 *  All tools degrade gracefully when the token isn't set — the bridge stays up and
 *  every Frame.io call returns { ok: false, error: "FRAMEIO_TOKEN not set" } so Qwen
 *  can tell the operator instead of crashing the conversation.
 */

const API_BASE = process.env.FRAMEIO_API_BASE || "https://api.frame.io/v4";
const TOKEN = () => process.env.FRAMEIO_TOKEN || "";

/* Why: account ID is a one-time lookup ('whoami' returns the active account). Cache after
 * first successful call so subsequent tools skip the round-trip. Reset to null on auth errors
 * so a re-auth is attempted next call. */
let cachedAccountId = null;

/** Low-level fetch wrapper — adds auth header, parses JSON, normalizes error shape. */
async function fio(method, pathSeg, body = null, opts = {}) {
  const token = TOKEN();
  if (!token) return { ok: false, error: "FRAMEIO_TOKEN not set — get a developer token at https://developer.frame.io/app and add FRAMEIO_TOKEN=… to .env" };

  const url = `${API_BASE}${pathSeg}`;
  const init = {
    method,
    headers: {
      "authorization": `Bearer ${token}`,
      "accept": "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  let res;
  try { res = await fetch(url, init); }
  catch (e) { return { ok: false, error: `network: ${e.message}` }; }

  /* Why: Frame.io errors come back as JSON with { error: { message, code } } or plain text on 5xx.
   * Don't trust the body to always be JSON — parse defensively so a 500 HTML page doesn't crash us. */
  const text = await res.text().catch(() => "");
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) cachedAccountId = null;
    return {
      ok: false,
      status: res.status,
      error: data?.error?.message || data?.message || `HTTP ${res.status}`,
      body: data,
    };
  }
  return { ok: true, data };
}

/** Resolve the active Frame.io account ID for token. Cached. */
async function getAccountId() {
  if (cachedAccountId) return { ok: true, accountId: cachedAccountId };
  const me = await fio("GET", "/me");
  if (!me.ok) return me;
  /* V4 'me' returns { data: { id, account_id, ... } } — the account_id field is what we need. */
  const acct = me.data?.data?.account_id || me.data?.account_id;
  if (!acct) return { ok: false, error: `could not resolve account_id from /me response: ${JSON.stringify(me.data).slice(0, 200)}` };
  cachedAccountId = acct;
  return { ok: true, accountId: acct };
}

/* ---------- TOOL: list_pending_review ---------- */
/**
 * List files currently in 'in_review' (or any provided status) across the account's projects.
 * Optionally narrow to a single project name.
 */
export async function listPendingReview({ projectName = null, limit = 25 } = {}) {
  const acctRes = await getAccountId();
  if (!acctRes.ok) return acctRes;
  const acct = acctRes.accountId;

  /* List projects in the account, then files per project. V4 paginates with page/page_size. */
  const projRes = await fio("GET", `/accounts/${acct}/projects?page_size=50`);
  if (!projRes.ok) return projRes;
  const projects = projRes.data?.data || [];
  const matching = projectName
    ? projects.filter(p => p.name?.toLowerCase().includes(projectName.toLowerCase()))
    : projects;
  if (matching.length === 0) return { ok: true, count: 0, files: [], note: projectName ? `no project matches "${projectName}"` : "no projects in account" };

  const out = [];
  for (const p of matching) {
    const filesRes = await fio("GET", `/projects/${p.id}/files?status=in_review&page_size=${Math.min(50, limit)}`);
    if (!filesRes.ok) continue;
    for (const f of (filesRes.data?.data || [])) {
      out.push({
        id: f.id,
        name: f.name,
        project: p.name,
        projectId: p.id,
        status: f.status,
        durationSec: f.media_metadata?.duration_in_ms ? Math.round(f.media_metadata.duration_in_ms / 1000) : null,
        uploadedAt: f.uploaded_at || f.inserted_at,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return { ok: true, count: out.length, files: out };
}

/* ---------- TOOL: get_comments ---------- */
/**
 * Fetch comments on a file. Returns timecoded comments so the operator can
 * navigate to specific frames if they want to act on the feedback.
 */
export async function getComments({ fileId, limit = 25 }) {
  if (!fileId) return { ok: false, error: "fileId required" };
  const r = await fio("GET", `/files/${fileId}/comments?page_size=${Math.min(50, limit)}`);
  if (!r.ok) return r;
  const comments = (r.data?.data || []).map(c => ({
    id: c.id,
    text: c.text || c.body || "",
    author: c.owner?.name || c.author?.name || "(unknown)",
    /* timestamp is in milliseconds for V4 */
    timecodeSec: typeof c.timestamp === "number" ? Math.round(c.timestamp / 1000) : null,
    createdAt: c.inserted_at || c.created_at,
    completed: !!c.completed,
  }));
  return { ok: true, count: comments.length, comments };
}

/* ---------- TOOL: add_comment ---------- */
/**
 * Drop a comment on a file. Optional timecode (seconds into the clip) lets the operator
 * pin feedback to a specific frame ("at 0:23 the colour grade is too warm").
 */
export async function addComment({ fileId, text, timecodeSec = null }) {
  if (!fileId || !text) return { ok: false, error: "fileId and text required" };
  const body = { text };
  if (typeof timecodeSec === "number" && timecodeSec >= 0) {
    body.timestamp = Math.round(timecodeSec * 1000);  // V4 expects ms
  }
  const r = await fio("POST", `/files/${fileId}/comments`, body);
  if (!r.ok) return r;
  return { ok: true, commentId: r.data?.data?.id || r.data?.id, fileId, text, timecodeSec };
}

/* ---------- TOOL: set_asset_status ---------- */
/**
 * Change the review status of a file. Frame.io statuses: in_progress | needs_review | approved | rejected.
 * Used after the operator hears the comments and decides to approve/reject by voice.
 */
export async function setAssetStatus({ fileId, status }) {
  if (!fileId || !status) return { ok: false, error: "fileId and status required" };
  const valid = ["in_progress", "needs_review", "approved", "rejected"];
  if (!valid.includes(status)) return { ok: false, error: `status must be one of: ${valid.join(", ")}` };
  const r = await fio("PATCH", `/files/${fileId}`, { status });
  if (!r.ok) return r;
  return { ok: true, fileId, status, name: r.data?.data?.name };
}

/* ---------- TOOL: search_files ---------- */
/**
 * Search for files by name across the account. Useful when the operator references a clip
 * by name ("the press car v3") without knowing the file ID.
 */
export async function searchFiles({ query, limit = 10 }) {
  if (!query) return { ok: false, error: "query required" };
  const acctRes = await getAccountId();
  if (!acctRes.ok) return acctRes;
  const r = await fio("GET", `/accounts/${acctRes.accountId}/files/search?q=${encodeURIComponent(query)}&page_size=${Math.min(25, limit)}`);
  if (!r.ok) return r;
  const files = (r.data?.data || []).map(f => ({
    id: f.id,
    name: f.name,
    status: f.status,
    project: f.project?.name,
    projectId: f.project?.id,
    durationSec: f.media_metadata?.duration_in_ms ? Math.round(f.media_metadata.duration_in_ms / 1000) : null,
  }));
  return { ok: true, count: files.length, files };
}

/** Status snapshot for /capabilities — does the bridge actually have a working token? */
export function frameioStatus() {
  return {
    configured: !!TOKEN(),
    apiBase: API_BASE,
    accountId: cachedAccountId,
  };
}

/** Force a re-resolution of account_id on next call (e.g. after token rotation). */
export function invalidateFrameioCache() { cachedAccountId = null; }
