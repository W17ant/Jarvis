/** workspace-export.test.mjs - round-trip + safety tests for export bundles.
 *
 *  Uses the live data/memory.db (same as workspaces.test.mjs) but only
 *  touches namespaced test slugs. The bundle file lands in os.tmpdir()
 *  so we don't pollute the operator's Desktop with test artifacts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(HERE, "..", "data", "memory.db");

async function freshImport(name) {
  const { pathToFileURL } = await import("node:url");
  const filePath = path.resolve(HERE, "..", "bridge", name);
  const url = new URL(pathToFileURL(filePath));
  url.searchParams.set("t", String(Date.now()));
  return await import(url.href);
}

const T = (suffix) => `test-exp-${suffix}-${process.pid}`;

describe("workspace-export", () => {
  let WS, WE, tmpDir;

  beforeEach(async () => {
    WS = await freshImport("workspaces.mjs");
    WE = await freshImport("workspace-export.mjs");
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "jarvis-ws-test-"));
    /* Clean any test residue. */
    for (const w of WS.list()) {
      if (w.slug.startsWith("test-exp-")) WS.remove(w.slug);
    }
    /* Wipe scoped rows for these test slugs across all known tables. */
    const db = new Database(DB_PATH);
    try {
      for (const tbl of ["facts", "contacts", "projects", "conversation_summaries", "conversation_turns", "documents"]) {
        db.prepare(`DELETE FROM ${tbl} WHERE workspace_id LIKE 'test-exp-%'`).run();
      }
    } finally { db.close(); }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    for (const w of WS.list()) {
      if (w.slug.startsWith("test-exp-")) WS.remove(w.slug);
    }
  });

  it("exports an empty workspace and produces a valid bundle file", async () => {
    WS.create({ slug: T("empty"), label: "Empty WS" });
    const result = await WE.exportWorkspace({ slug: T("empty"), outDir: tmpDir });
    expect(result.ok).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    const st = await stat(result.path);
    expect(st.size).toBeGreaterThan(0);
    expect(result.manifest.slug).toBe(T("empty"));
  });

  it("export refuses to bundle a non-existent workspace", async () => {
    await expect(WE.exportWorkspace({ slug: "does-not-exist-xyz", outDir: tmpDir })).rejects.toThrow();
  });

  it("export captures workspace v1 fields (handbook, working_root, tool_allowlist)", async () => {
    WS.create({
      slug: T("rich"),
      label: "Rich WS",
      description: "test workspace with everything",
      handbook: "Use British English. Cite sources.",
      workingRoot: "/Volumes/Test/Rich",
      toolAllowlist: ["draft_email", "search_knowledge"],
    });
    const exported = await WE.exportWorkspace({ slug: T("rich"), outDir: tmpDir });
    expect(exported.ok).toBe(true);

    /* Re-import under a different slug - we have to first delete the
     * original since the manifest has the same slug. Use overwrite. */
    const imported = await WE.importWorkspace({ bundlePath: exported.path, overwrite: true });
    expect(imported.ok).toBe(true);
    expect(imported.slug).toBe(T("rich"));

    /* Verify v1 fields round-tripped through the import. */
    const restored = WS.get(T("rich"));
    expect(restored.handbook).toBe("Use British English. Cite sources.");
    expect(restored.workingRoot).toBe("/Volumes/Test/Rich");
    expect(restored.toolAllowlist).toEqual(["draft_email", "search_knowledge"]);
  });

  it("export captures scoped rows (facts) and import restores them", async () => {
    WS.create({ slug: T("facts"), label: "Facts WS" });
    /* Insert directly via SQLite to avoid needing the active-workspace
     * provider wired in tests. */
    const db = new Database(DB_PATH);
    try {
      db.prepare("INSERT INTO facts (content, tags, created_at, workspace_id) VALUES (?, ?, ?, ?)")
        .run("workspace-scoped fact 1", JSON.stringify(["test"]), Date.now(), T("facts"));
      db.prepare("INSERT INTO facts (content, tags, created_at, workspace_id) VALUES (?, ?, ?, ?)")
        .run("workspace-scoped fact 2", JSON.stringify(["test"]), Date.now(), T("facts"));
    } finally { db.close(); }

    const exported = await WE.exportWorkspace({ slug: T("facts"), outDir: tmpDir });
    expect(exported.manifest.counts.facts).toBe(2);

    /* Wipe + re-import. */
    const dbW = new Database(DB_PATH);
    try { dbW.prepare("DELETE FROM facts WHERE workspace_id = ?").run(T("facts")); } finally { dbW.close(); }
    WS.remove(T("facts"));

    const imported = await WE.importWorkspace({ bundlePath: exported.path });
    expect(imported.counts.facts).toBe(2);

    const dbR = new Database(DB_PATH, { readonly: true });
    try {
      const row = dbR.prepare("SELECT COUNT(*) as n FROM facts WHERE workspace_id = ?").get(T("facts"));
      expect(row.n).toBe(2);
    } finally { dbR.close(); }
  });

  it("includeTurns false (default) excludes conversation_turns from bundle", async () => {
    WS.create({ slug: T("noturns"), label: "NoTurns" });
    const db = new Database(DB_PATH);
    try {
      db.prepare(`INSERT INTO conversation_turns (session_id, ts, role, content, tools_json, workspace_id)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run("test-session", Date.now(), "user", "private chat content", null, T("noturns"));
    } finally { db.close(); }

    const exported = await WE.exportWorkspace({ slug: T("noturns"), outDir: tmpDir });
    expect(exported.manifest.counts.conversationTurns).toBe(0);
  });

  it("includeTurns true bundles turns and import restores them", async () => {
    WS.create({ slug: T("withturns"), label: "WithTurns" });
    const db = new Database(DB_PATH);
    try {
      db.prepare(`INSERT INTO conversation_turns (session_id, ts, role, content, tools_json, workspace_id)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run("test-session", Date.now(), "user", "turn one", null, T("withturns"));
    } finally { db.close(); }

    const exported = await WE.exportWorkspace({ slug: T("withturns"), outDir: tmpDir, includeTurns: true });
    expect(exported.manifest.counts.conversationTurns).toBe(1);

    /* Wipe + re-import. */
    const dbW = new Database(DB_PATH);
    try { dbW.prepare("DELETE FROM conversation_turns WHERE workspace_id = ?").run(T("withturns")); } finally { dbW.close(); }
    WS.remove(T("withturns"));

    const imported = await WE.importWorkspace({ bundlePath: exported.path, includeTurns: true });
    expect(imported.counts.turns).toBe(1);
  });

  it("import refuses to clobber an existing workspace without overwrite", async () => {
    WS.create({ slug: T("clobber"), label: "First" });
    const exported = await WE.exportWorkspace({ slug: T("clobber"), outDir: tmpDir });
    /* Create a new "version" of the workspace - trying to import should fail. */
    await expect(WE.importWorkspace({ bundlePath: exported.path })).rejects.toThrow(/already exists/);
  });

  it("import succeeds with overwrite:true", async () => {
    WS.create({ slug: T("overw"), label: "Original" });
    const exported = await WE.exportWorkspace({ slug: T("overw"), outDir: tmpDir });
    const imported = await WE.importWorkspace({ bundlePath: exported.path, overwrite: true });
    expect(imported.ok).toBe(true);
    expect(imported.overwritten).toBe(true);
  });

  it("bundleFingerprint is deterministic for the same bundle", async () => {
    WS.create({ slug: T("fp"), label: "FP" });
    const exported = await WE.exportWorkspace({ slug: T("fp"), outDir: tmpDir });
    const fp1 = await WE.bundleFingerprint(exported.path);
    const fp2 = await WE.bundleFingerprint(exported.path);
    expect(fp1).toEqual(fp2);
    expect(fp1.length).toBe(64);   // sha256 hex
  });
});
