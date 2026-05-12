/** workspaces.test.mjs - vitest unit tests for the workspaces module.
 *
 *  We exercise the in-memory + SQLite paths directly. Each test gets a
 *  fresh module instance via the cache-bust pattern so module-level state
 *  (active slug) doesn't bleed across cases. The shared on-disk DB does
 *  pick up rows from previous tests, so each test cleans up after itself
 *  by deleting the slugs it created.
 */

import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function freshImport() {
  const { pathToFileURL } = await import("node:url");
  const filePath = path.resolve(HERE, "..", "bridge", "workspaces.mjs");
  const url = new URL(pathToFileURL(filePath));
  url.searchParams.set("t", String(Date.now()));
  return await import(url.href);
}

/** Test slugs are namespaced so a stray failure doesn't pollute real
 *  workspaces an operator might have created. */
const T = (suffix) => `test-ws-${suffix}-${process.pid}`;

describe("workspaces", () => {
  let WS;

  beforeEach(async () => {
    WS = await freshImport();
    /* Clean any slugs from previous failed runs. The pid suffix usually
     * changes between runs but vitest can re-use a worker. */
    for (const w of WS.list()) {
      if (w.slug.startsWith("test-ws-")) WS.remove(w.slug);
    }
  });

  it("creates a workspace and returns the row", () => {
    const w = WS.create({ slug: T("create"), label: "Test create" });
    expect(w.slug).toBe(T("create"));
    expect(w.label).toBe("Test create");
    expect(typeof w.created_at).toBe("number");
    WS.remove(T("create"));
  });

  it("rejects bad slugs", () => {
    expect(() => WS.create({ slug: "BadCase", label: "x" })).toThrow();
    expect(() => WS.create({ slug: "../escape", label: "x" })).toThrow();
    expect(() => WS.create({ slug: "a", label: "x" })).toThrow();   // too short
    expect(() => WS.create({ slug: "no spaces", label: "x" })).toThrow();
  });

  it("rejects reserved slugs", () => {
    expect(() => WS.create({ slug: "new", label: "x" })).toThrow();
    expect(() => WS.create({ slug: "active", label: "x" })).toThrow();
    expect(() => WS.create({ slug: "default", label: "x" })).toThrow();
  });

  it("requires a label", () => {
    expect(() => WS.create({ slug: T("nolabel"), label: "" })).toThrow();
    expect(() => WS.create({ slug: T("nolabel"), label: "   " })).toThrow();
  });

  it("rejects duplicates", () => {
    WS.create({ slug: T("dup"), label: "first" });
    expect(() => WS.create({ slug: T("dup"), label: "second" })).toThrow();
    WS.remove(T("dup"));
  });

  it("lists workspaces last-active first", () => {
    const a = WS.create({ slug: T("la-a"), label: "A" });
    const b = WS.create({ slug: T("la-b"), label: "B" });
    WS.setActive(T("la-a"));
    const all = WS.list().filter((w) => w.slug.startsWith("test-ws-la-"));
    expect(all[0].slug).toBe(T("la-a"));
    WS.remove(T("la-a"));
    WS.remove(T("la-b"));
  });

  it("setActive / getActive round-trips", () => {
    WS.create({ slug: T("active"), label: "Active" });
    WS.setActive(T("active"));
    const a = WS.getActive();
    expect(a.slug).toBe(T("active"));
    WS.setActive(null);
    expect(WS.getActive()).toBeNull();
    WS.remove(T("active"));
  });

  it("setActive throws for unknown slug", () => {
    expect(() => WS.setActive("does-not-exist-xyz")).toThrow();
  });

  it("getActive returns null after the active workspace is deleted", () => {
    WS.create({ slug: T("ghost"), label: "Ghost" });
    WS.setActive(T("ghost"));
    WS.remove(T("ghost"));
    expect(WS.getActive()).toBeNull();
  });

  it("update edits label / description / handbook without changing slug", () => {
    WS.create({ slug: T("upd"), label: "Old", description: "old desc" });
    const updated = WS.update(T("upd"), { label: "New", handbook: "rules" });
    expect(updated.label).toBe("New");
    expect(updated.description).toBe("old desc");  // untouched
    expect(updated.handbook).toBe("rules");
    expect(updated.slug).toBe(T("upd"));
    WS.remove(T("upd"));
  });

  it("systemPromptHint returns empty when no active workspace", () => {
    WS.setActive(null);
    expect(WS.systemPromptHint()).toBe("");
  });

  it("systemPromptHint includes label, description, and handbook when active", () => {
    WS.create({
      slug: T("hint"),
      label: "Consulting",
      description: "Solo consulting practice",
      handbook: "Always cite sources. Never use exclamation marks.",
    });
    WS.setActive(T("hint"));
    const hint = WS.systemPromptHint();
    expect(hint).toContain("Consulting");
    expect(hint).toContain("Solo consulting practice");
    expect(hint).toContain("Always cite sources");
    WS.remove(T("hint"));
  });

  it("remove returns false for non-existent slug", () => {
    expect(WS.remove("nope-doesnt-exist-xyz")).toBe(false);
  });

  /* ── Workspaces v1: working_root + tool_allowlist + creative_style_path ── */

  it("create stores workingRoot when provided", () => {
    const w = WS.create({
      slug: T("wr"),
      label: "WR",
      workingRoot: "/Volumes/Workdrive/Consulting",
    });
    expect(w.workingRoot).toBe("/Volumes/Workdrive/Consulting");
    WS.remove(T("wr"));
  });

  it("create stores toolAllowlist as a parsed array", () => {
    const w = WS.create({
      slug: T("ta"),
      label: "TA",
      toolAllowlist: ["get_mail_summary", "draft_email", "search_knowledge"],
    });
    expect(Array.isArray(w.toolAllowlist)).toBe(true);
    expect(w.toolAllowlist.length).toBe(3);
    expect(w.toolAllowlist).toContain("draft_email");
    WS.remove(T("ta"));
  });

  it("create stores creativeStylePath when provided", () => {
    const w = WS.create({
      slug: T("cs"),
      label: "CS",
      creativeStylePath: "creative-style.consulting.md",
    });
    expect(w.creativeStylePath).toBe("creative-style.consulting.md");
    WS.remove(T("cs"));
  });

  it("update mutates v1 fields without disturbing each other", () => {
    WS.create({ slug: T("upd-v1"), label: "U", workingRoot: "/a", toolAllowlist: ["x"] });
    /* Patch only toolAllowlist; workingRoot must survive untouched. */
    const updated = WS.update(T("upd-v1"), { toolAllowlist: ["y", "z"] });
    expect(updated.workingRoot).toBe("/a");
    expect(updated.toolAllowlist).toEqual(["y", "z"]);
    WS.remove(T("upd-v1"));
  });

  it("update can clear toolAllowlist by passing empty array", () => {
    WS.create({ slug: T("clear-ta"), label: "C", toolAllowlist: ["x"] });
    const updated = WS.update(T("clear-ta"), { toolAllowlist: [] });
    expect(updated.toolAllowlist).toBeNull();
    WS.remove(T("clear-ta"));
  });

  it("seedDefaultIfEmpty creates a 'personal' workspace when table is empty", () => {
    /* Snapshot every existing workspace so we can restore them after.
     * Earlier versions of this test wiped the live DB (including the
     * operator's real workspaces) — a destructive side-effect across
     * test runs. We now save full row state, do the wipe-and-seed
     * inside a try/finally, and restore everything on exit. */
    const snapshot = WS.list();
    const wasActiveSlug = WS.getActive()?.slug || null;
    try {
      for (const w of snapshot) WS.remove(w.slug);
      const seeded = WS.seedDefaultIfEmpty();
      expect(seeded?.slug).toBe("personal");
      expect(seeded?.label).toBe("Personal");
      /* Active workspace gets set by seedDefault. */
      expect(WS.getActive()?.slug).toBe("personal");
      WS.remove("personal");
    } finally {
      /* Restore every workspace we wiped, with all their fields. */
      for (const w of snapshot) {
        try {
          WS.create({
            slug: w.slug,
            label: w.label,
            description: w.description,
            handbook: w.handbook,
            workingRoot: w.workingRoot,
            toolAllowlist: w.toolAllowlist,
            creativeStylePath: w.creativeStylePath,
            voice: w.voice,
            accentColor: w.accentColor,
            agentLabel: w.agentLabel,
          });
        } catch { /* slug collision = somehow already restored, skip */ }
      }
      if (wasActiveSlug && WS.get(wasActiveSlug)) WS.setActive(wasActiveSlug);
    }
  });

  it("seedDefaultIfEmpty is a no-op when any workspace exists", () => {
    /* Snapshot count before so we can assert "didn't add new rows". The
     * earlier check `WS.get("personal") === null` was wrong — an operator
     * who's used the kiosk has a real "personal" workspace they care
     * about, and the test was reading their live data. */
    WS.create({ slug: T("noseed"), label: "Existing" });
    const before = WS.list().length;
    const seeded = WS.seedDefaultIfEmpty();
    expect(seeded).toBeNull();
    expect(WS.list().length).toBe(before);
    WS.remove(T("noseed"));
  });

  /* ── Workspaces v3: voice persona + insights ── */

  it("create stores voice when provided", () => {
    const w = WS.create({ slug: T("voice"), label: "Voice WS", voice: "bf_emma" });
    expect(w.voice).toBe("bf_emma");
    WS.remove(T("voice"));
  });

  it("update can set + clear voice independently of other fields", () => {
    WS.create({ slug: T("vupd"), label: "V", handbook: "rules" });
    let updated = WS.update(T("vupd"), { voice: "bm_george" });
    expect(updated.voice).toBe("bm_george");
    expect(updated.handbook).toBe("rules");      // untouched
    updated = WS.update(T("vupd"), { voice: null });
    expect(updated.voice).toBeNull();
    expect(updated.handbook).toBe("rules");
    WS.remove(T("vupd"));
  });

  it("insights returns counts for an empty workspace", () => {
    WS.create({ slug: T("ins-empty"), label: "Empty" });
    const i = WS.insights(T("ins-empty"));
    expect(i.slug).toBe(T("ins-empty"));
    expect(i.counts.turns).toBe(0);
    expect(i.counts.documents).toBe(0);
    expect(i.counts.facts).toBe(0);
    WS.remove(T("ins-empty"));
  });

  it("insights returns null for a non-existent workspace", () => {
    expect(WS.insights("does-not-exist-xyz")).toBeNull();
  });

  /* ── Workspaces v4: persona fields + scoped systemPromptHint ── */

  it("create stores accentColor + agentLabel when provided", () => {
    const w = WS.create({
      slug: T("persona"),
      label: "Persona",
      accentColor: "#ffb84a",
      agentLabel: "Friday",
    });
    expect(w.accentColor).toBe("#ffb84a");
    expect(w.agentLabel).toBe("Friday");
    WS.remove(T("persona"));
  });

  it("rejects malformed accentColor on create", () => {
    expect(() => WS.create({ slug: T("badhex"), label: "X", accentColor: "amber" })).toThrow(/hex/);
    expect(() => WS.create({ slug: T("badhex2"), label: "X", accentColor: "#fff" })).toThrow(/hex/);
  });

  it("update accepts accentColor + agentLabel patches independently", () => {
    WS.create({ slug: T("ppatch"), label: "P", accentColor: "#00d4ff", agentLabel: "Jarvis" });
    let updated = WS.update(T("ppatch"), { agentLabel: "Friday" });
    expect(updated.agentLabel).toBe("Friday");
    expect(updated.accentColor).toBe("#00d4ff");          // untouched
    updated = WS.update(T("ppatch"), { accentColor: null });
    expect(updated.accentColor).toBeNull();
    expect(updated.agentLabel).toBe("Friday");
    WS.remove(T("ppatch"));
  });

  it("systemPromptHint accepts a slug override (per-call dispatch)", () => {
    WS.create({ slug: T("scope-a"), label: "A", handbook: "Rules from A." });
    WS.create({ slug: T("scope-b"), label: "B", handbook: "Rules from B." });
    /* Active is A; explicit override should pull B's handbook. */
    WS.setActive(T("scope-a"));
    const hintActive = WS.systemPromptHint();
    expect(hintActive).toContain("Rules from A.");
    const hintOverride = WS.systemPromptHint(T("scope-b"));
    expect(hintOverride).toContain("Rules from B.");
    expect(hintOverride).not.toContain("Rules from A.");
    /* Override with non-existent slug returns "" cleanly. */
    expect(WS.systemPromptHint("does-not-exist-xyz")).toBe("");
    WS.remove(T("scope-a"));
    WS.remove(T("scope-b"));
  });
});
