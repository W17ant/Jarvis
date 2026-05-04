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
`);

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
export async function addContact({ name, email = null, phone = null, company = null, role = null, notes = null }) {
  if (!name) return { ok: false, error: "name required" };
  const now = Date.now();
  /* Composite text for the embedding so semantic search hits across name + role + company + notes */
  const composite = [name, role, company, notes, email].filter(Boolean).join(" — ");
  let emb = null;
  try { emb = vectorToBuffer(await embed(composite)); } catch (e) { console.warn("[memory] embed failed:", e.message); }

  const existing = db.prepare("SELECT id FROM contacts WHERE LOWER(name) = LOWER(?)").get(name);
  if (existing) {
    db.prepare(`UPDATE contacts SET email=COALESCE(?,email), phone=COALESCE(?,phone), company=COALESCE(?,company),
                role=COALESCE(?,role), notes=COALESCE(?,notes), embedding=COALESCE(?,embedding), updated_at=?
                WHERE id=?`).run(email, phone, company, role, notes, emb, now, existing.id);
    return { ok: true, action: "updated", id: existing.id, name };
  }
  const r = db.prepare(`INSERT INTO contacts (name, email, phone, company, role, notes, embedding, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(name, email, phone, company, role, notes, emb, now, now);
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
export async function remember({ content, tags = [] }) {
  if (!content) return { ok: false, error: "content required" };
  let emb = null;
  try { emb = vectorToBuffer(await embed(content)); } catch (e) { console.warn("[memory] embed failed:", e.message); }
  const r = db.prepare(`INSERT INTO facts (content, tags, embedding, created_at) VALUES (?, ?, ?, ?)`)
              .run(content, JSON.stringify(tags || []), emb, Date.now());
  return { ok: true, id: r.lastInsertRowid, content };
}

export async function recall({ query, limit = 5 }) {
  if (!query) return { ok: false, error: "query required" };
  let queryVec;
  try { queryVec = await embed(query); }
  catch (e) { return { ok: false, error: `embed: ${e.message}` }; }

  /* Search facts + contacts + projects + past conversation summaries in one ranked set */
  const items = [
    ...db.prepare("SELECT id, content as text, 'fact' as kind, tags, created_at, embedding FROM facts").all(),
    ...db.prepare("SELECT id, name || ' (' || COALESCE(role,'')|| ' at ' || COALESCE(company,'')|| ') — ' || COALESCE(notes,'') as text, 'contact' as kind, NULL as tags, created_at, embedding FROM contacts").all(),
    ...db.prepare("SELECT id, name || ' — ' || COALESCE(notes,'') as text, 'project' as kind, NULL as tags, created_at, embedding FROM projects").all(),
    ...db.prepare("SELECT id, summary as text, 'conversation' as kind, topics as tags, ended_at as created_at, embedding FROM conversation_summaries").all(),
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

/* ---------- PROJECTS ---------- */
export async function addProject({ name, client = null, status = null, notes = null }) {
  if (!name) return { ok: false, error: "name required" };
  const now = Date.now();
  const composite = [name, client, status, notes].filter(Boolean).join(" — ");
  let emb = null;
  try { emb = vectorToBuffer(await embed(composite)); } catch {}
  const existing = db.prepare("SELECT id FROM projects WHERE LOWER(name) = LOWER(?)").get(name);
  if (existing) {
    db.prepare(`UPDATE projects SET client=COALESCE(?,client), status=COALESCE(?,status), notes=COALESCE(?,notes),
                embedding=COALESCE(?,embedding), updated_at=? WHERE id=?`)
      .run(client, status, notes, emb, now, existing.id);
    return { ok: true, action: "updated", id: existing.id, name };
  }
  const r = db.prepare(`INSERT INTO projects (name, client, status, notes, embedding, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(name, client, status, notes, emb, now, now);
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
