/** dream-cycle.mjs - Periodic memory hygiene.
 *
 *  Why: data/memory.db accretes contacts and conversation summaries forever.
 *  Without periodic compaction the operator's recall becomes noisier over time
 *  (three "Ben Collins" rows from typos), and Qwen's context window gets stuffed
 *  with stale conversations that no longer matter.
 *
 *  v1 sweep performs two operations:
 *    1. Merge near-duplicate contacts — Levenshtein ≤ 2 on the lowercased name.
 *       The OLDER row is merged INTO the newer (latest update wins for any field
 *       the older has that the newer doesn't). Older row deleted.
 *    2. Archive conversation summaries older than 90 days — actually delete from
 *       conversation_summaries since the embedding still lives in their topics
 *       indirectly via the relevant projects/contacts.
 *
 *  Skipped for v1 (require schema changes):
 *    - Confidence-decay on facts (no confidence column yet)
 *    - Qwen-driven relation inference (no relations table yet)
 *
 *  Schedule: 03:30 local time daily. Bridge boot also runs a sweep on boot
 *  if the last sweep was more than 24h ago. */

import Database from "better-sqlite3";
import path from "node:path";
import { existsSync } from "node:fs";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DB_PATH = path.join(PROJECT_DIR, "data", "memory.db");

/* Reuse the same Levenshtein implementation memory.mjs uses for fuzzy contact
 * matching — single-edit dupes are exactly the typo class we want to catch. */
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

/** Find pairs of contacts that look like typos of each other. */
function findContactDuplicates(db) {
  const rows = db.prepare("SELECT id, name, email, phone, company, role, notes, updated_at FROM contacts").all();
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      /* Same email = always a dup, regardless of name. */
      if (a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase()) {
        pairs.push([a, b]);
        continue;
      }
      /* Otherwise Levenshtein ≤ 2 on the name (lowercased) — covers "Ben" / "Benn"
       * and "Ben Collins" / "Bencollins" but not "Ben" / "Sam". Skip exact equals. */
      const an = (a.name || "").toLowerCase().trim();
      const bn = (b.name || "").toLowerCase().trim();
      if (!an || !bn || an === bn) continue;
      const d = levenshtein(an, bn);
      if (d <= 2 && Math.abs(an.length - bn.length) <= 2) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** Merge older row into newer — coalesces fields and deletes the older. */
function mergeContacts(db, a, b) {
  /* Determine "newer" by updated_at. Newer is the survivor. */
  const survivor = a.updated_at >= b.updated_at ? a : b;
  const removed  = a.updated_at >= b.updated_at ? b : a;

  /* Coalesce — survivor keeps its fields where set, fills in blanks from removed. */
  const merged = {
    name:    survivor.name    || removed.name,
    email:   survivor.email   || removed.email,
    phone:   survivor.phone   || removed.phone,
    company: survivor.company || removed.company,
    role:    survivor.role    || removed.role,
    notes:   survivor.notes   || removed.notes,
  };

  db.prepare("UPDATE contacts SET email=?, phone=?, company=?, role=?, notes=?, updated_at=? WHERE id=?")
    .run(merged.email, merged.phone, merged.company, merged.role, merged.notes, Date.now(), survivor.id);
  db.prepare("DELETE FROM contacts WHERE id=?").run(removed.id);
  return { kept: survivor.name, removed: removed.name };
}

/** Drop conversation summaries older than `days` days. */
function archiveOldConversations(db, days = 90) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const r = db.prepare("DELETE FROM conversation_summaries WHERE ended_at < ?").run(cutoff);
  return r.changes;
}

/**
 * Run one sweep. Returns a report the LLM can read aloud or log to audit.
 */
export async function runCycle({ archiveDays = 90, dryRun = false } = {}) {
  if (!existsSync(DB_PATH)) return { ok: false, error: "memory.db not found — nothing to compact" };
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const contactsBefore = db.prepare("SELECT COUNT(*) as n FROM contacts").get().n;
  const convsBefore    = db.prepare("SELECT COUNT(*) as n FROM conversation_summaries").get().n;

  const dupes = findContactDuplicates(db);
  const mergeResults = [];
  if (!dryRun) {
    /* Why: process pairs sequentially so the db state is consistent if one fails;
     * the next iteration sees the updated state. Skip pairs where one side has
     * already been deleted. */
    for (const [a, b] of dupes) {
      const stillExists = db.prepare("SELECT 1 FROM contacts WHERE id IN (?, ?) LIMIT 2").all(a.id, b.id);
      if (stillExists.length < 2) continue;
      mergeResults.push(mergeContacts(db, a, b));
    }
  }

  const convsArchived = dryRun ? 0 : archiveOldConversations(db, archiveDays);

  const contactsAfter = db.prepare("SELECT COUNT(*) as n FROM contacts").get().n;
  const convsAfter    = db.prepare("SELECT COUNT(*) as n FROM conversation_summaries").get().n;

  db.close();

  return {
    ok: true,
    dryRun,
    contacts: {
      before: contactsBefore,
      after: contactsAfter,
      duplicatesFound: dupes.length,
      merged: mergeResults,
    },
    conversations: {
      before: convsBefore,
      after: convsAfter,
      archived: convsArchived,
      cutoffDays: archiveDays,
    },
    summary: dryRun
      ? `Dry run — would merge ${dupes.length} contact pairs and archive ${convsBefore - convsAfter} old conversations.`
      : `Merged ${mergeResults.length} contact pairs, archived ${convsArchived} conversations older than ${archiveDays} days.`,
  };
}

/** Schedule daily run at 03:30 local. Bridge calls this at boot. */
export function schedule() {
  const next = () => {
    const now = new Date();
    const target = new Date();
    target.setHours(3, 30, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
  };
  const arm = () => {
    setTimeout(async () => {
      try {
        const r = await runCycle();
        if (r.ok) console.log(`[dream-cycle] ${r.summary}`);
      } catch (e) {
        console.warn(`[dream-cycle] failed: ${e.message}`);
      }
      arm();
    }, next());
  };
  arm();
}
