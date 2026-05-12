/** workspace-export.mjs - portable workspace bundles.
 *
 *  Why: an operator who builds up a "Consulting" workspace over months
 *  (handbook, tool allowlist, creative-style, accumulated facts +
 *  contacts + conversation history) should be able to move it to a new
 *  Mac, share a stripped version with a colleague, or archive it before
 *  a major refactor. Without an export path, that knowledge is locked
 *  inside one operator's memory.db.
 *
 *  Bundle shape (.tgz):
 *    manifest.json           — workspace metadata + version + integrity hash
 *    handbook.md             — workspace.handbook content (if any)
 *    creative-style.md       — workspace's creative-style file content (if any)
 *    facts.jsonl             — facts scoped to this workspace
 *    contacts.jsonl          — contacts scoped to this workspace
 *    projects.jsonl          — projects scoped to this workspace
 *    conversation_summaries.jsonl  — summaries scoped to this workspace
 *    conversation_turns.jsonl      — raw turn log (PRESENT only when explicit
 *                                    --include-turns flag passed; turns are
 *                                    the most personal data in the bundle)
 *    documents.jsonl         — document metadata (NOT chunks; chunks would
 *                              bloat the bundle and re-ingestion regenerates
 *                              them from the source files anyway)
 *
 *  Privacy: by default, conversation_turns are EXCLUDED. Operators have
 *  to explicitly opt-in to bundle the raw transcript ("yes, share my
 *  consulting conversations with my new Mac"). Summaries land by default
 *  because they're the high-signal compressed form.
 *
 *  Format: tar.gz so the operator can inspect with standard tools (Finder
 *  preview, `tar -tzf bundle.jarvis-workspace`). No proprietary container.
 */

import Database from "better-sqlite3";
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const DB_PATH = path.join(PROJECT_ROOT, "data", "memory.db");

const BUNDLE_VERSION = 1;

/** Produce a JSONL string from an array. Each row gets its own line. */
function _toJsonl(rows) {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** Streamed tar -czf wrapper. Resolves with the tarball path on success.
 *  Uses /usr/bin/tar (BSD tar on macOS) which handles --no-mac-metadata
 *  + supports xattr stripping, so the bundle stays portable. */
async function _tarDirectoryGzip(srcDir, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-czf", outPath,
      "--no-mac-metadata",
      "-C", srcDir,
      ".",
    ];
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(outPath);
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/** Streamed tar -xzf wrapper. */
async function _untarGzip(tarPath, destDir) {
  return new Promise((resolve, reject) => {
    const args = ["-xzf", tarPath, "-C", destDir];
    const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(destDir);
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 400)}`));
    });
  });
}

/** Export a workspace to a .tgz bundle. The output lands on the operator's
 *  Desktop by default; pass `outDir` to override. */
export async function exportWorkspace({ slug, outDir = null, includeTurns = false } = {}) {
  if (!slug) throw new Error("slug required");
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const w = db.prepare("SELECT * FROM workspaces WHERE slug = ?").get(slug);
    if (!w) throw new Error(`workspace "${slug}" not found`);

    /* Collect every workspace-scoped row across the schema. NULL workspace_id
     * rows are NOT included — they belong to "global" scope and exporting
     * them would bleed the operator's other workspaces' data. */
    const facts = db.prepare("SELECT id, content, tags, created_at FROM facts WHERE workspace_id = ?").all(slug);
    const contacts = db.prepare("SELECT id, name, email, phone, company, role, notes, created_at, updated_at FROM contacts WHERE workspace_id = ?").all(slug);
    const projects = db.prepare("SELECT id, name, client, status, notes, created_at, updated_at FROM projects WHERE workspace_id = ?").all(slug);
    const summaries = db.prepare("SELECT id, summary, topics, started_at, ended_at FROM conversation_summaries WHERE workspace_id = ?").all(slug);
    const documents = db.prepare("SELECT id, path, rel_path, format, bytes, hash, mtime_ms, ingested_at, chunk_count, title, notes FROM documents WHERE workspace_id = ?").all(slug);
    const turns = includeTurns
      ? db.prepare("SELECT id, session_id, ts, role, content, tools_json FROM conversation_turns WHERE workspace_id = ?").all(slug)
      : [];

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bundleName = `${slug}-${stamp}.jarvis-workspace.tgz`;
    const outRoot = outDir || path.join(os.homedir(), "Desktop");
    const outPath = path.join(outRoot, bundleName);

    /* Stage in a tempdir so a failure mid-write doesn't leave a half-bundle. */
    const stageDir = await mkdtemp(path.join(os.tmpdir(), "jarvis-ws-export-"));
    try {
      const manifest = {
        bundleVersion: BUNDLE_VERSION,
        exportedAt: Date.now(),
        workspace: {
          slug: w.slug,
          label: w.label,
          description: w.description,
          handbook: w.handbook,
          workingRoot: w.working_root,
          toolAllowlist: w.tool_allowlist ? JSON.parse(w.tool_allowlist) : null,
          creativeStylePath: w.creative_style_path,
          createdAt: w.created_at,
        },
        counts: {
          facts: facts.length,
          contacts: contacts.length,
          projects: projects.length,
          conversationSummaries: summaries.length,
          conversationTurns: turns.length,
          documents: documents.length,
        },
        includeTurns,
      };
      await writeFile(path.join(stageDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      if (w.handbook) await writeFile(path.join(stageDir, "handbook.md"), w.handbook, "utf8");

      /* If the workspace has a creative-style file, copy its content into the
       * bundle (not just the path — the path is meaningless on the import
       * machine). The content is what matters. */
      if (w.creative_style_path) {
        let stylePath = w.creative_style_path;
        if (!path.isAbsolute(stylePath)) {
          stylePath = path.resolve(w.working_root || PROJECT_ROOT, stylePath);
        }
        if (existsSync(stylePath)) {
          try {
            const styleContent = await readFile(stylePath, "utf8");
            await writeFile(path.join(stageDir, "creative-style.md"), styleContent, "utf8");
          } catch { /* skip — bundle still valid without the style file */ }
        }
      }

      await writeFile(path.join(stageDir, "facts.jsonl"), _toJsonl(facts), "utf8");
      await writeFile(path.join(stageDir, "contacts.jsonl"), _toJsonl(contacts), "utf8");
      await writeFile(path.join(stageDir, "projects.jsonl"), _toJsonl(projects), "utf8");
      await writeFile(path.join(stageDir, "conversation_summaries.jsonl"), _toJsonl(summaries), "utf8");
      await writeFile(path.join(stageDir, "documents.jsonl"), _toJsonl(documents), "utf8");
      if (includeTurns) {
        await writeFile(path.join(stageDir, "conversation_turns.jsonl"), _toJsonl(turns), "utf8");
      }

      await _tarDirectoryGzip(stageDir, outPath);
    } finally {
      await rm(stageDir, { recursive: true, force: true });
    }

    const st = await stat(outPath);
    return {
      ok: true,
      path: outPath,
      sizeBytes: st.size,
      manifest: {
        slug,
        includeTurns,
        /* Mirror the on-disk manifest.json's count field names exactly so
         * callers / tests can read either shape without surprise. */
        counts: {
          facts: facts.length,
          contacts: contacts.length,
          projects: projects.length,
          conversationSummaries: summaries.length,
          conversationTurns: turns.length,
          documents: documents.length,
        },
      },
    };
  } finally {
    db.close();
  }
}

/** Import a workspace bundle. The slug from the manifest is used as the
 *  new workspace's primary key; if a workspace with the same slug already
 *  exists, the import errors unless `overwrite: true` is passed. Conflict
 *  protection is the operator's only safety against accidentally clobbering
 *  an active workspace's accumulated data with a stale archive. */
export async function importWorkspace({ bundlePath, overwrite = false, includeTurns = true } = {}) {
  if (!bundlePath) throw new Error("bundlePath required");
  if (!existsSync(bundlePath)) throw new Error(`bundle not found: ${bundlePath}`);

  const stageDir = await mkdtemp(path.join(os.tmpdir(), "jarvis-ws-import-"));
  try {
    await _untarGzip(bundlePath, stageDir);

    const manifestPath = path.join(stageDir, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error("bundle missing manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.bundleVersion !== BUNDLE_VERSION) {
      throw new Error(`bundle version ${manifest.bundleVersion} not supported (need ${BUNDLE_VERSION})`);
    }
    const w = manifest.workspace;
    if (!w?.slug) throw new Error("manifest missing workspace.slug");

    const db = new Database(DB_PATH);
    try {
      const existing = db.prepare("SELECT slug FROM workspaces WHERE slug = ?").get(w.slug);
      if (existing && !overwrite) {
        throw new Error(`workspace "${w.slug}" already exists; pass overwrite: true to replace`);
      }
      if (existing && overwrite) {
        /* Delete every workspace-scoped row before re-inserting so the
         * import lands on a clean slate. */
        db.prepare("DELETE FROM facts WHERE workspace_id = ?").run(w.slug);
        db.prepare("DELETE FROM contacts WHERE workspace_id = ?").run(w.slug);
        db.prepare("DELETE FROM projects WHERE workspace_id = ?").run(w.slug);
        db.prepare("DELETE FROM conversation_summaries WHERE workspace_id = ?").run(w.slug);
        db.prepare("DELETE FROM conversation_turns WHERE workspace_id = ?").run(w.slug);
        db.prepare("DELETE FROM documents WHERE workspace_id = ?").run(w.slug);
        db.prepare("DELETE FROM workspaces WHERE slug = ?").run(w.slug);
      }

      const now = Date.now();
      db.prepare(`
        INSERT INTO workspaces (slug, label, description, handbook, working_root, tool_allowlist, creative_style_path, created_at, last_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        w.slug, w.label, w.description || null, w.handbook || null,
        w.workingRoot || null,
        Array.isArray(w.toolAllowlist) && w.toolAllowlist.length ? JSON.stringify(w.toolAllowlist) : null,
        w.creativeStylePath || null,
        w.createdAt || now,
      );

      /* JSONL re-ingestion. We re-stamp every row's workspace_id with the
       * imported slug so even if the bundle was hand-edited, the import is
       * consistent. */
      const counts = { facts: 0, contacts: 0, projects: 0, summaries: 0, turns: 0, documents: 0 };
      const importJsonl = async (filename, insertPrep) => {
        const filePath = path.join(stageDir, filename);
        if (!existsSync(filePath)) return 0;
        const lines = (await readFile(filePath, "utf8")).split("\n").filter(Boolean);
        let n = 0;
        for (const line of lines) {
          try {
            const row = JSON.parse(line);
            insertPrep(row);
            n++;
          } catch { /* skip malformed line */ }
        }
        return n;
      };

      counts.facts = await importJsonl("facts.jsonl", (r) => {
        db.prepare("INSERT INTO facts (content, tags, created_at, workspace_id) VALUES (?, ?, ?, ?)")
          .run(r.content || "", r.tags || null, r.created_at || now, w.slug);
      });
      counts.contacts = await importJsonl("contacts.jsonl", (r) => {
        db.prepare(`INSERT INTO contacts (name, email, phone, company, role, notes, created_at, updated_at, workspace_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(r.name || "", r.email || null, r.phone || null, r.company || null, r.role || null, r.notes || null,
               r.created_at || now, r.updated_at || now, w.slug);
      });
      counts.projects = await importJsonl("projects.jsonl", (r) => {
        db.prepare(`INSERT INTO projects (name, client, status, notes, created_at, updated_at, workspace_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(r.name || "", r.client || null, r.status || null, r.notes || null, r.created_at || now, r.updated_at || now, w.slug);
      });
      counts.summaries = await importJsonl("conversation_summaries.jsonl", (r) => {
        db.prepare(`INSERT INTO conversation_summaries (summary, topics, started_at, ended_at, workspace_id)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(r.summary || "", r.topics || null, r.started_at || now, r.ended_at || now, w.slug);
      });
      counts.documents = await importJsonl("documents.jsonl", (r) => {
        db.prepare(`INSERT INTO documents (path, rel_path, format, bytes, hash, mtime_ms, ingested_at, chunk_count, title, notes, workspace_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(r.path || "", r.rel_path || null, r.format || null, r.bytes || null, r.hash || null,
               r.mtime_ms || null, r.ingested_at || now, r.chunk_count || 0, r.title || null, r.notes || null, w.slug);
      });
      if (includeTurns) {
        counts.turns = await importJsonl("conversation_turns.jsonl", (r) => {
          db.prepare(`INSERT INTO conversation_turns (session_id, ts, role, content, tools_json, workspace_id)
                      VALUES (?, ?, ?, ?, ?, ?)`)
            .run(r.session_id || "imported", r.ts || now, r.role || "user", r.content || "", r.tools_json || null, w.slug);
        });
      }

      return { ok: true, slug: w.slug, label: w.label, counts, overwritten: !!existing };
    } finally {
      db.close();
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

/** Compute a quick fingerprint of a bundle for dedupe / verification. */
export async function bundleFingerprint(bundlePath) {
  const buf = await readFile(bundlePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}
