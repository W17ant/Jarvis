/** memory.mjs - Persistent cross-session memory: contacts, projects, free-form facts.
 *  Storage: SQLite (better-sqlite3, synchronous, fast).
 *  Search: local embeddings via Ollama nomic-embed-text — semantic recall across all stored items.
 *
 *  Tools the LLM can call:
 *    add_contact         - upsert a contact: name, email, phone, company, role, notes
 *    get_contact         - look up a contact by name (fuzzy + semantic fallback)
 *    list_contacts       - list all contacts (or filter by company)
 *    remember            - store a free-form fact
 *    recall              - semantic search across facts, contacts, projects, past chats
 *    save_conversation   - persist a session summary so future turns can recall it
 *    add_project         - track a project (FOM-side or client-side)
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "memory.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

/* ---------- SCHEMA ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  role TEXT,
  notes TEXT,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  client TEXT,
  status TEXT,
  notes TEXT,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  tags TEXT,
  embedding BLOB,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,
  topics TEXT,
  embedding BLOB,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);

/* Per-turn persistence — every operator query and Jarvis reply lands here.
 * conversation_summaries is kept too (end-of-session digests for long-term
 * recall); turns are the raw transcript. session_id groups turns from the
 * same HUD load. tools_json is the JSON-stringified list of tool names that
 * fired during the turn (e.g. ["recall","draft_email"]) — used by the HUD
 * drawer to render tool chips per row. */
CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  role TEXT NOT NULL,                 -- "user" | "assistant"
  content TEXT NOT NULL,
  tools_json TEXT                     -- JSON array of tool names; NULL when no tools fired
);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_ts ON conversation_turns(ts);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_session ON conversation_turns(session_id, ts);

/* Document RAG — knowledge base of operator-curated reference docs.
 * Distinct from operator memory (facts/contacts/projects): documents are
 * STATIC reference material (brand briefs, client onboarding PDFs, past
 * press releases) the LLM cites from. Chunks carry their own embedding
 * for cosine search; FTS5 virtual table below gives keyword search for
 * hybrid retrieval. */
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,           -- absolute path on disk
  rel_path TEXT NOT NULL,              -- relative to knowledge root, for display
  format TEXT NOT NULL,                -- "txt" | "md" | "pdf" | "docx" | "html"
  bytes INTEGER NOT NULL,
  hash TEXT NOT NULL,                  -- sha256 of file content; used to detect changes
  mtime_ms INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  title TEXT,                          -- best-effort title (first heading or filename)
  notes TEXT                           -- operator-supplied free-form metadata, optional
);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
CREATE INDEX IF NOT EXISTS idx_documents_format ON documents(format);

CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,                      -- 768-dim float32, NULL until embedded
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_document ON doc_chunks(document_id);

/* FTS5 virtual table over chunk content. Lets us do keyword / phrase
 * search alongside vector similarity for hybrid retrieval. We materialise
 * the content into the FTS shadow table at insert time; the rowid links
 * back to doc_chunks.id so we can join scores. */
CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks_fts USING fts5(
  content,
  content='doc_chunks',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS doc_chunks_ai AFTER INSERT ON doc_chunks BEGIN
  INSERT INTO doc_chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS doc_chunks_ad AFTER DELETE ON doc_chunks BEGIN
  INSERT INTO doc_chunks_fts(doc_chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
`);

/* Workspaces v2: tag every memory row with the workspace it was captured in.
 * NULL means "no workspace was active when this row was created" — those
 * rows surface in every scope so legacy data isn't trapped. The ALTER TABLE
 * migrations are idempotent — they swallow the SQLite "duplicate column"
 * error so a re-run on a v2 install doesn't crash boot. */
function _addColumnIfMissing(table, name, decl) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
for (const tbl of [
  "contacts", "projects", "facts",
  "conversation_summaries", "conversation_turns",
  "documents",
]) {
  _addColumnIfMissing(tbl, "workspace_id", "TEXT");
}
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_contacts_ws ON contacts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_facts_ws ON facts(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_conv_turns_ws ON conversation_turns(workspace_id, ts);
  CREATE INDEX IF NOT EXISTS idx_conv_summaries_ws ON conversation_summaries(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_documents_ws ON documents(workspace_id);
`);

/* Active-workspace getter injected from outside (server.mjs wires it on boot).
 * Memory functions read it lazily so the workspace filter follows whatever is
 * active at the time of the query. Setting null disables the default filter. */
let _getActiveWorkspaceSlug = () => null;
export function setActiveWorkspaceProvider(fn) {
  if (typeof fn === "function") _getActiveWorkspaceSlug = fn;
}

/* ---------- EMBEDDINGS via Ollama ---------- */
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

async function embed(text) {
  const r = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  if (!r.ok) throw new Error(`embedding ${r.status}`);
  const j = await r.json();
  return j.embedding;
}

function vectorToBuffer(vec) { return Buffer.from(new Float32Array(vec).buffer); }
function bufferToVector(buf) {
  if (!buf) return null;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/* Why: short-string typos ("Benn Collins" vs "Ben Collins") embed too closely to
 * other names but still score below the 0.5 semantic threshold. Levenshtein on the
 * lowercased name catches single-char edits cheaply before falling through to embeddings. */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, dp[j - 1], dp[j]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

/* ---------- CONTACTS ---------- */
export async function addContact({ name, email = null, phone = null, company = null, role = null, notes = null, workspaceId = undefined } = {}) {
  if (!name) return { ok: false, error: "name required" };
  const now = Date.now();
  /* Composite text for the embedding so semantic search hits across name + role + company + notes */
  const composite = [name, role, company, notes, email].filter(Boolean).join(" — ");
  let emb = null;
  try { emb = vectorToBuffer(await embed(composite)); } catch (e) { console.warn("[memory] embed failed:", e.message); }
  const ws = workspaceId !== undefined ? workspaceId : _getActiveWorkspaceSlug();

  const existing = db.prepare("SELECT id FROM contacts WHERE LOWER(name) = LOWER(?)").get(name);
  if (existing) {
    /* On update we DON'T re-stamp workspace_id — a contact created in one
     * scope shouldn't silently jump scopes when the operator updates them
     * from another workspace. The original scope wins. */
    db.prepare(`UPDATE contacts SET email=COALESCE(?,email), phone=COALESCE(?,phone), company=COALESCE(?,company),
                role=COALESCE(?,role), notes=COALESCE(?,notes), embedding=COALESCE(?,embedding), updated_at=?
                WHERE id=?`).run(email, phone, company, role, notes, emb, now, existing.id);
    return { ok: true, action: "updated", id: existing.id, name };
  }
  const r = db.prepare(`INSERT INTO contacts (name, email, phone, company, role, notes, embedding, created_at, updated_at, workspace_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(name, email, phone, company, role, notes, emb, now, now, ws || null);
  return { ok: true, action: "created", id: r.lastInsertRowid, name };
}

export async function getContact({ name, email = null }) {
  if (!name && !email) return { ok: false, error: "name or email required" };

  if (email) {
    const r = db.prepare("SELECT id, name, email, phone, company, role, notes FROM contacts WHERE LOWER(email) = LOWER(?)").get(email);
    if (r) return { ok: true, contact: r };
  }
  if (name) {
    const exact = db.prepare("SELECT id, name, email, phone, company, role, notes FROM contacts WHERE LOWER(name) = LOWER(?)").get(name);
    if (exact) return { ok: true, contact: exact };

    const like = db.prepare(`SELECT id, name, email, phone, company, role, notes FROM contacts
                             WHERE LOWER(name) LIKE LOWER(?) ORDER BY length(name) ASC LIMIT 1`).get(`%${name}%`);
    if (like) return { ok: true, contact: like, matchType: "partial" };

    /* Levenshtein step — handle "Benn" / "Bem" / "Bencollins" before paying for embeddings.
     * Allow up to ~25% of the query length in edits, capped at 3, so short queries don't get loose. */
    const lcQuery = name.toLowerCase();
    const allRows = db.prepare("SELECT id, name, email, phone, company, role, notes FROM contacts").all();
    const maxEdits = Math.min(3, Math.max(1, Math.floor(lcQuery.length / 4)));
    let bestEdit = null;
    for (const r of allRows) {
      const d = levenshtein(lcQuery, r.name.toLowerCase());
      if (d <= maxEdits && (!bestEdit || d < bestEdit.dist)) bestEdit = { row: r, dist: d };
    }
    if (bestEdit) {
      return { ok: true, contact: bestEdit.row, matchType: "fuzzy", editDistance: bestEdit.dist };
    }

    /* Last resort — semantic match in case the operator used a nickname / role / company */
    try {
      const queryVec = await embed(name);
      const all = db.prepare("SELECT id, name, email, phone, company, role, notes, embedding FROM contacts").all();
      if (all.length === 0) return { ok: false, error: `no contacts stored yet — add ${name} first` };
      const ranked = all.map(r => ({ ...r, score: cosine(queryVec, bufferToVector(r.embedding)) }))
                        .sort((a, b) => b.score - a.score);
      if (ranked[0] && ranked[0].score > 0.5) {
        const { embedding, score, ...c } = ranked[0];
        return { ok: true, contact: c, matchType: "semantic", confidence: +score.toFixed(3) };
      }
    } catch {}
  }
  return { ok: false, error: `no match for "${name}"` };
}

export function listContacts({ company = null } = {}) {
  const rows = company
    ? db.prepare("SELECT id, name, email, company, role FROM contacts WHERE LOWER(company) LIKE LOWER(?) ORDER BY name").all(`%${company}%`)
    : db.prepare("SELECT id, name, email, company, role FROM contacts ORDER BY name").all();
  return { ok: true, count: rows.length, contacts: rows };
}

/* ---------- FACTS / FREE-FORM MEMORY ---------- */
export async function remember({ content, tags = [], workspaceId = undefined } = {}) {
  if (!content) return { ok: false, error: "content required" };
  let emb = null;
  try { emb = vectorToBuffer(await embed(content)); } catch (e) { console.warn("[memory] embed failed:", e.message); }
  const ws = workspaceId !== undefined ? workspaceId : _getActiveWorkspaceSlug();
  const r = db.prepare(`INSERT INTO facts (content, tags, embedding, created_at, workspace_id) VALUES (?, ?, ?, ?, ?)`)
              .run(content, JSON.stringify(tags || []), emb, Date.now(), ws || null);
  return { ok: true, id: r.lastInsertRowid, content };
}

/** Workspace-aware semantic recall.
 *
 *  Defaults to filtering each source table by the active workspace (rows
 *  with NULL workspace_id are surfaced everywhere — legacy data isn't
 *  trapped). Pass allWorkspaces=true to bypass the filter and search the
 *  full corpus; use when the operator says "search across all workspaces"
 *  or when a workspace's scope is intentionally porous (a "personal"
 *  baseline that wants to see consulting facts too). */
export async function recall({ query, limit = 5, workspaceId = undefined, allWorkspaces = false } = {}) {
  if (!query) return { ok: false, error: "query required" };
  let queryVec;
  try { queryVec = await embed(query); }
  catch (e) { return { ok: false, error: `embed: ${e.message}` }; }

  /* Build the workspace-scope WHERE fragment. The (workspace_id IS NULL OR
   * workspace_id = ?) shape lets unscoped rows leak into every workspace's
   * scope — operators who never used workspaces still see their old facts. */
  const ws = allWorkspaces ? null : (workspaceId !== undefined ? workspaceId : _getActiveWorkspaceSlug());
  const wsClause = ws ? " WHERE (workspace_id IS NULL OR workspace_id = ?)" : "";
  const wsParams = ws ? [ws] : [];

  /* Search facts + contacts + projects + past conversation summaries in one ranked set */
  const items = [
    ...db.prepare("SELECT id, content as text, 'fact' as kind, tags, created_at, embedding FROM facts" + wsClause).all(...wsParams),
    ...db.prepare("SELECT id, name || ' (' || COALESCE(role,'')|| ' at ' || COALESCE(company,'')|| ') — ' || COALESCE(notes,'') as text, 'contact' as kind, NULL as tags, created_at, embedding FROM contacts" + wsClause).all(...wsParams),
    ...db.prepare("SELECT id, name || ' — ' || COALESCE(notes,'') as text, 'project' as kind, NULL as tags, created_at, embedding FROM projects" + wsClause).all(...wsParams),
    ...db.prepare("SELECT id, summary as text, 'conversation' as kind, topics as tags, ended_at as created_at, embedding FROM conversation_summaries" + wsClause).all(...wsParams),
  ];
  const ranked = items
    .map(r => ({ ...r, score: cosine(queryVec, bufferToVector(r.embedding)) }))
    .filter(r => r.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => ({ kind: r.kind, text: r.text, score: +r.score.toFixed(3) }));
  return { ok: true, count: ranked.length, results: ranked };
}

/* ---------- CONVERSATION SUMMARIES ---------- */
export async function saveConversation({ summary, topics = [], startedAt, endedAt }) {
  if (!summary) return { ok: false, error: "summary required" };
  let emb = null;
  try { emb = vectorToBuffer(await embed(summary)); } catch {}
  const r = db.prepare(`INSERT INTO conversation_summaries (summary, topics, embedding, started_at, ended_at)
                        VALUES (?, ?, ?, ?, ?)`)
              .run(summary, JSON.stringify(topics || []), emb, startedAt || Date.now(), endedAt || Date.now());
  return { ok: true, id: r.lastInsertRowid };
}

/* ---------- PER-TURN PERSISTENCE ----------
 * Append-only log of every operator query and Jarvis reply. Each row is a
 * single turn keyed by session_id (one HUD load = one session). Used by
 * the HUD's history drawer for "what did I ask about yesterday" type queries
 * without spinning up the more expensive recall() embedding search.
 *
 * No embeddings on turns — they'd 50× the embedding compute and the recall
 * tool already handles semantic search via conversation_summaries. Turns
 * are the literal transcript; summaries are the searchable distillation. */

/** Append a single turn. Synchronous SQLite write — better-sqlite3's
 *  prepared statement is fast enough that we don't need async.
 *
 *  Workspaces v2: stamps the row with the active workspace slug at write
 *  time. Caller can override by passing workspaceId explicitly (used by
 *  iMessage relay and other paths where the active HUD workspace doesn't
 *  match the conversation's scope). NULL = unscoped (legacy turns + turns
 *  written before any workspace was activated). */
export function appendTurn({ sessionId, role, content, tools = null, workspaceId = undefined } = {}) {
  if (!sessionId || !role || !content) return { ok: false, error: "sessionId, role, content required" };
  const toolsJson = (Array.isArray(tools) && tools.length) ? JSON.stringify(tools) : null;
  const ws = workspaceId !== undefined ? workspaceId : _getActiveWorkspaceSlug();
  const r = db.prepare(`INSERT INTO conversation_turns (session_id, ts, role, content, tools_json, workspace_id) VALUES (?, ?, ?, ?, ?, ?)`)
              .run(String(sessionId), Date.now(), String(role), String(content), toolsJson, ws || null);
  return { ok: true, id: r.lastInsertRowid };
}

/** Recent turns paginated by timestamp. The HUD's drawer uses limit=50 by
 *  default; the search box does substring filtering client-side because the
 *  result sets are small (max ~1000 turns over a typical week of use).
 *
 *  Workspaces v2: defaults to filtering by the active workspace's slug.
 *  Pass workspaceId: null explicitly to bypass the filter ("show me
 *  conversations from every workspace"). Rows with NULL workspace_id
 *  (legacy turns) are surfaced in every scope so they're never trapped. */
export function recentTurns({ limit = 50, beforeTs = null, sessionId = null, workspaceId = undefined, allWorkspaces = false } = {}) {
  const cap = Math.max(1, Math.min(500, Number(limit) || 50));
  const params = [];
  let where = "1=1";
  if (beforeTs) { where += " AND ts < ?"; params.push(Number(beforeTs)); }
  if (sessionId) { where += " AND session_id = ?"; params.push(String(sessionId)); }
  /* Workspace scoping: default to the active slug; explicit workspaceId
   * arg overrides; allWorkspaces=true bypasses entirely. The (workspace_id
   * IS NULL OR workspace_id = ?) shape keeps unscoped legacy rows visible
   * inside any workspace's drawer. */
  if (!allWorkspaces) {
    const ws = workspaceId !== undefined ? workspaceId : _getActiveWorkspaceSlug();
    if (ws) {
      where += " AND (workspace_id IS NULL OR workspace_id = ?)";
      params.push(String(ws));
    }
  }
  const rows = db.prepare(`SELECT id, session_id, ts, role, content, tools_json
                           FROM conversation_turns
                           WHERE ${where}
                           ORDER BY ts DESC
                           LIMIT ?`).all(...params, cap);
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    ts: r.ts,
    role: r.role,
    content: r.content,
    tools: r.tools_json ? (() => { try { return JSON.parse(r.tools_json); } catch { return []; } })() : [],
  }));
}

/* ---------- DOCUMENT RAG STORAGE ----------
 * Schema lives at top of file. These functions are the storage primitives;
 * the chunking/parsing logic lives in bridge/knowledge.mjs which calls
 * here to persist + retrieve. */

/** Insert (or replace) a document row. If a document with the same path
 *  already exists, we delete it first (CASCADE drops its chunks too) so
 *  re-ingest is a clean operation. Returns the new id. */
export function upsertDocument({ path: filePath, relPath, format, bytes, hash, mtimeMs, title = null, notes = null, workspaceId = undefined } = {}) {
  if (!filePath) throw new Error("path required");
  db.prepare("DELETE FROM documents WHERE path = ?").run(filePath);
  const ws = workspaceId !== undefined ? workspaceId : _getActiveWorkspaceSlug();
  const r = db.prepare(`INSERT INTO documents
    (path, rel_path, format, bytes, hash, mtime_ms, ingested_at, chunk_count, title, notes, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(filePath, relPath, format, bytes, hash, mtimeMs, Date.now(), title, notes, ws || null);
  return r.lastInsertRowid;
}

/** Insert one chunk. The embedding is computed by the caller (knowledge.mjs)
 *  to keep this module synchronous. Returns the chunk id. */
export function insertChunk({ documentId, chunkIndex, content, embedding, charStart, charEnd }) {
  const emb = embedding ? vectorToBuffer(embedding) : null;
  const r = db.prepare(`INSERT INTO doc_chunks (document_id, chunk_index, content, embedding, char_start, char_end)
                        VALUES (?, ?, ?, ?, ?, ?)`)
              .run(documentId, chunkIndex, content, emb, charStart, charEnd);
  return r.lastInsertRowid;
}

/** Update a document's chunk_count after all chunks land. */
export function setDocumentChunkCount(documentId, count) {
  db.prepare("UPDATE documents SET chunk_count = ? WHERE id = ?").run(count, documentId);
}

/** Look up a document by path. Used to detect changes pre-ingest:
 *  if hash matches what's on disk, skip re-ingest. */
export function getDocumentByPath(filePath) {
  return db.prepare("SELECT id, path, rel_path, format, bytes, hash, mtime_ms, ingested_at, chunk_count, title FROM documents WHERE path = ?").get(filePath);
}

/** Drop a document by path (CASCADE deletes its chunks + FTS rows). */
export function deleteDocumentByPath(filePath) {
  return db.prepare("DELETE FROM documents WHERE path = ?").run(filePath).changes;
}

/** All known documents, newest first. Caps at limit to keep response sane. */
export function listDocuments({ limit = 200 } = {}) {
  const cap = Math.max(1, Math.min(1000, Number(limit) || 200));
  return db.prepare(`SELECT id, path, rel_path, format, bytes, mtime_ms, ingested_at, chunk_count, title
                     FROM documents ORDER BY ingested_at DESC LIMIT ?`).all(cap);
}

/** Hybrid search across the knowledge base.
 *
 *  1. Vector similarity — embed the query, cosine against every chunk
 *     embedding. Cheap (a few thousand rows × 768 dims is ~5ms).
 *  2. FTS5 BM25 — keyword/phrase ranking over the FTS shadow table.
 *  3. Reciprocal Rank Fusion (RRF) — merge the two ranked lists with
 *     `score = sum(1 / (k + rank_i))` per chunk. RRF is the standard
 *     "no-tuning" hybrid combiner — it doesn't require calibrating
 *     vector vs BM25 score scales which would otherwise drift across
 *     different domains.
 *
 *  Returns top-K chunks with source document metadata for citation.
 */
export async function searchKnowledge({ query, topK = 8, workspaceId = undefined, allWorkspaces = false } = {}) {
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "query required" };
  const cap = Math.max(1, Math.min(20, Number(topK) || 8));

  /* Workspace scoping for chunks: chunks inherit their parent document's
   * workspace_id via a JOIN on documents. NULL workspace_id surfaces in
   * every scope (legacy chunks, never-scoped docs). */
  const ws = allWorkspaces ? null : (workspaceId !== undefined ? workspaceId : _getActiveWorkspaceSlug());

  /* Vector pass: rank every chunk by cosine. */
  let qVec;
  try { qVec = await embed(q.slice(0, 1500)); }
  catch (e) { return { ok: false, error: `embedding failed: ${e.message}` }; }
  const vectorSql = ws
    ? `SELECT c.id, c.document_id, c.chunk_index, c.content, c.embedding
       FROM doc_chunks c
       LEFT JOIN documents d ON d.id = c.document_id
       WHERE c.embedding IS NOT NULL AND (d.workspace_id IS NULL OR d.workspace_id = ?)`
    : `SELECT id, document_id, chunk_index, content, embedding FROM doc_chunks WHERE embedding IS NOT NULL`;
  const vectorParams = ws ? [ws] : [];
  const allChunks = db.prepare(vectorSql).all(...vectorParams);
  const vectorRanked = allChunks
    .map((c) => ({ id: c.id, score: cosine(qVec, bufferToVector(c.embedding)), content: c.content, documentId: c.document_id, chunkIndex: c.chunk_index }))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap * 3);

  /* FTS5 pass: keyword ranking. SQLite escapes special chars natively when
   * the query is wrapped in double quotes; we additionally split into terms
   * for OR-style matching so "press launch" matches docs containing either. */
  const ftsQuery = q.split(/\s+/).filter(Boolean).map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
  let ftsRanked = [];
  if (ftsQuery) {
    try {
      const ftsSql = ws
        ? `SELECT doc_chunks.id AS id, doc_chunks.document_id AS documentId, doc_chunks.chunk_index AS chunkIndex,
                  doc_chunks.content AS content, bm25(doc_chunks_fts) AS bm25_score
           FROM doc_chunks_fts
           JOIN doc_chunks ON doc_chunks.id = doc_chunks_fts.rowid
           LEFT JOIN documents d ON d.id = doc_chunks.document_id
           WHERE doc_chunks_fts MATCH ? AND (d.workspace_id IS NULL OR d.workspace_id = ?)
           ORDER BY bm25_score
           LIMIT ?`
        : `SELECT doc_chunks.id AS id, doc_chunks.document_id AS documentId, doc_chunks.chunk_index AS chunkIndex,
                  doc_chunks.content AS content, bm25(doc_chunks_fts) AS bm25_score
           FROM doc_chunks_fts JOIN doc_chunks ON doc_chunks.id = doc_chunks_fts.rowid
           WHERE doc_chunks_fts MATCH ?
           ORDER BY bm25_score
           LIMIT ?`;
      const ftsParams = ws ? [ftsQuery, ws, cap * 3] : [ftsQuery, cap * 3];
      ftsRanked = db.prepare(ftsSql).all(...ftsParams);
    } catch { /* malformed FTS query — skip and rely on vector */ }
  }

  /* Reciprocal Rank Fusion — k=60 is the published default. */
  const RRF_K = 60;
  const fused = new Map();
  vectorRanked.forEach((c, i) => {
    fused.set(c.id, { id: c.id, content: c.content, documentId: c.documentId, chunkIndex: c.chunkIndex, score: 1 / (RRF_K + i), vectorRank: i + 1, vectorScore: c.score });
  });
  ftsRanked.forEach((c, i) => {
    const existing = fused.get(c.id);
    if (existing) {
      existing.score += 1 / (RRF_K + i);
      existing.ftsRank = i + 1;
    } else {
      fused.set(c.id, { id: c.id, content: c.content, documentId: c.documentId, chunkIndex: c.chunkIndex, score: 1 / (RRF_K + i), ftsRank: i + 1 });
    }
  });
  const merged = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, cap);

  /* Hydrate with document metadata for citation. We pull paths in one
   * query rather than per-chunk for performance. */
  const docIds = [...new Set(merged.map((m) => m.documentId))];
  const docs = docIds.length
    ? db.prepare(`SELECT id, path, rel_path, format, title FROM documents WHERE id IN (${docIds.map(() => "?").join(",")})`).all(...docIds)
    : [];
  const docMap = new Map(docs.map((d) => [d.id, d]));

  return {
    ok: true,
    query: q,
    results: merged.map((m) => {
      const doc = docMap.get(m.documentId) || {};
      return {
        chunkId: m.id,
        chunkIndex: m.chunkIndex,
        content: m.content,
        score: Number(m.score.toFixed(6)),
        vectorRank: m.vectorRank || null,
        vectorScore: m.vectorScore != null ? Number(m.vectorScore.toFixed(4)) : null,
        ftsRank: m.ftsRank || null,
        source: {
          documentId: m.documentId,
          relPath: doc.rel_path,
          title: doc.title,
          format: doc.format,
        },
      };
    }),
  };
}

/** Aggregate stats for /knowledge/status and the Agent Console. */
export function knowledgeStats() {
  const docs = db.prepare("SELECT COUNT(*) AS n FROM documents").get().n;
  const chunks = db.prepare("SELECT COUNT(*) AS n FROM doc_chunks").get().n;
  const embedded = db.prepare("SELECT COUNT(*) AS n FROM doc_chunks WHERE embedding IS NOT NULL").get().n;
  const lastIngest = db.prepare("SELECT MAX(ingested_at) AS ts FROM documents").get().ts;
  return { documents: docs, chunks, embedded, lastIngestAt: lastIngest || null };
}

/** Distinct session ids in the last N days, with per-session turn counts.
 *  Lets the drawer offer a "jump to this session" picker. */
export function listSessions({ days = 14 } = {}) {
  const since = Date.now() - Math.max(1, Number(days) || 14) * 86400_000;
  return db.prepare(`SELECT session_id, MIN(ts) AS started_at, MAX(ts) AS ended_at, COUNT(*) AS turn_count
                     FROM conversation_turns
                     WHERE ts >= ?
                     GROUP BY session_id
                     ORDER BY ended_at DESC`).all(since);
}

/* ---------- PROJECTS ---------- */
export async function addProject({ name, client = null, status = null, notes = null, workspaceId = undefined } = {}) {
  if (!name) return { ok: false, error: "name required" };
  const now = Date.now();
  const composite = [name, client, status, notes].filter(Boolean).join(" — ");
  let emb = null;
  try { emb = vectorToBuffer(await embed(composite)); } catch {}
  const ws = workspaceId !== undefined ? workspaceId : _getActiveWorkspaceSlug();
  const existing = db.prepare("SELECT id FROM projects WHERE LOWER(name) = LOWER(?)").get(name);
  if (existing) {
    db.prepare(`UPDATE projects SET client=COALESCE(?,client), status=COALESCE(?,status), notes=COALESCE(?,notes),
                embedding=COALESCE(?,embedding), updated_at=? WHERE id=?`)
      .run(client, status, notes, emb, now, existing.id);
    return { ok: true, action: "updated", id: existing.id, name };
  }
  const r = db.prepare(`INSERT INTO projects (name, client, status, notes, embedding, created_at, updated_at, workspace_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(name, client, status, notes, emb, now, now, ws || null);
  return { ok: true, action: "created", id: r.lastInsertRowid, name };
}

export function listProjects({ client = null } = {}) {
  const rows = client
    ? db.prepare("SELECT id, name, client, status, notes FROM projects WHERE LOWER(client) LIKE LOWER(?) ORDER BY updated_at DESC").all(`%${client}%`)
    : db.prepare("SELECT id, name, client, status, notes FROM projects ORDER BY updated_at DESC").all();
  return { ok: true, count: rows.length, projects: rows };
}

export function memoryStats() {
  return {
    contacts: db.prepare("SELECT COUNT(*) as n FROM contacts").get().n,
    projects: db.prepare("SELECT COUNT(*) as n FROM projects").get().n,
    facts: db.prepare("SELECT COUNT(*) as n FROM facts").get().n,
    conversations: db.prepare("SELECT COUNT(*) as n FROM conversation_summaries").get().n,
  };
}

/* ---------- BACKUPS ----------
 * Why: contacts, projects, facts and conversation summaries accumulate over time —
 * a single corrupt write or accidental delete loses irreplaceable client data.
 * Strategy: snapshot once per day at bridge boot, keep 30 days, atomic file copy
 * via SQLite's online backup API (safe even if WAL has uncommitted writes).
 */
import { mkdirSync as mkdirSyncFs, readdirSync, statSync, unlinkSync } from "node:fs";
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_RETENTION_DAYS = 30;

/**
 * Snapshot memory.db to data/backups/memory-YYYY-MM-DD.db.
 * Idempotent — skips if today's backup already exists. Prunes old backups.
 * @returns {{ok:boolean, path?:string, skipped?:boolean, pruned?:number}}
 */
export async function backupMemoryDb() {
  try {
    if (!existsSync(BACKUP_DIR)) mkdirSyncFs(BACKUP_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    const dest = path.join(BACKUP_DIR, `memory-${today}.db`);

    if (existsSync(dest)) {
      const pruned = pruneOldBackups();
      return { ok: true, skipped: true, path: dest, pruned };
    }

    /* Why: better-sqlite3's .backup() is async — it copies pages incrementally so concurrent
     * writers aren't blocked. Returns a Promise that resolves once the backup file is closed.
     * Don't stat the file until after the await or you'll race the backup writer. */
    await db.backup(dest);
    const sizeKB = Math.round(statSync(dest).size / 1024);
    const pruned = pruneOldBackups();

    /* Multi-machine sync — if the operator configured MEMORY_SYNC_PATH (an
     * external path: NAS mount, iCloud Drive, Dropbox, etc.), copy today's
     * snapshot there too. Mirrors a single canonical filename ("memory-latest.db")
     * so consumers always know where to fetch from. The dated snapshots stay
     * local — sync target is for cross-kiosk read-only consumption. */
    let synced = null;
    const SYNC_PATH = process.env.MEMORY_SYNC_PATH;
    if (SYNC_PATH) {
      try {
        const fsModule = await import("node:fs/promises");
        if (!existsSync(SYNC_PATH)) await fsModule.mkdir(SYNC_PATH, { recursive: true });
        synced = path.join(SYNC_PATH, "memory-latest.db");
        await fsModule.copyFile(dest, synced);
      } catch (e) {
        console.warn(`[memory] sync to ${SYNC_PATH} failed: ${e.message}`);
        synced = null;
      }
    }

    console.log(`[memory] backup saved: ${path.relative(DATA_DIR, dest)} (${sizeKB}KB)${pruned ? `, pruned ${pruned} old` : ""}${synced ? `, synced → ${synced}` : ""}`);
    return { ok: true, path: dest, sizeKB, pruned, synced };
  } catch (e) {
    console.warn(`[memory] backup failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** Delete backups older than BACKUP_RETENTION_DAYS. Returns count pruned. */
function pruneOldBackups() {
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;
  try {
    for (const f of readdirSync(BACKUP_DIR)) {
      if (!f.startsWith("memory-") || !f.endsWith(".db")) continue;
      const full = path.join(BACKUP_DIR, f);
      if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); pruned++; }
    }
  } catch {}
  return pruned;
}
