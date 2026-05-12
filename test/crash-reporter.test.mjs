/** crash-reporter.test.mjs — vitest unit tests for the sanitisation logic.
 *
 *  These tests don't need a running bridge (unlike test/build_plugin_smoke.mjs)
 *  because we exercise the report() function directly. The persisted file
 *  lands in a temp dir we clean between runs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { rm, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* The module writes under PROJECT_ROOT/data/audit/crashes — we run the
 * test ahead of any other test that might leave rows there, and clean
 * before each test. The directory is shared with the live bridge but
 * tests run synchronously, so there's no concurrency issue. */
const CRASH_DIR = path.resolve(HERE, "..", "data", "audit", "crashes");

async function freshImport() {
  /* Cache-bust import so each test gets a fresh module instance —
   * crash-reporter holds module-level state (broadcaster, redact list)
   * and a stale instance bleeds across test cases.
   *
   * Use pathToFileURL rather than string-templating so we get a
   * properly-formed file:// URL (vite's SSR resolver warns on the
   * malformed `file://${absolutePath}` shape). */
  const { pathToFileURL } = await import("node:url");
  const filePath = path.resolve(HERE, "..", "bridge", "crash-reporter.mjs");
  const url = new URL(pathToFileURL(filePath));
  url.searchParams.set("t", String(Date.now()));
  return await import(url.href);
}

describe("crash-reporter", () => {
  beforeEach(async () => {
    /* Clear today's crash log so each test starts from a known state. */
    try { await rm(CRASH_DIR, { recursive: true, force: true }); } catch {}
    await mkdir(CRASH_DIR, { recursive: true });
  });

  it("persists a sanitised row to data/audit/crashes/YYYY-MM-DD.jsonl", async () => {
    const CR = await freshImport();
    CR.init({ version: "test-0.0.1" });
    const row = await CR.report(new Error("boom"), "test");
    expect(row.name).toBe("Error");
    expect(row.message).toBe("boom");
    expect(row.bridgeVersion).toBe("test-0.0.1");
    expect(row.source).toBe("test");

    const dateKey = new Date().toISOString().slice(0, 10);
    const file = path.join(CRASH_DIR, `${dateKey}.jsonl`);
    const txt = await readFile(file, "utf8");
    const lines = txt.trim().split("\n");
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.message).toBe("boom");
  });

  it("redacts sk-style API keys from messages", async () => {
    const CR = await freshImport();
    CR.init({ version: "x" });
    const fakeKey = "sk-abcdef0123456789ABCDEFGHIJKLMNOP";
    const row = await CR.report(new Error(`upstream said ${fakeKey} is invalid`), "test");
    expect(row.message).not.toContain(fakeKey);
    expect(row.message).toContain("sk-***REDACTED***");
  });

  it("redacts Bearer tokens", async () => {
    const CR = await freshImport();
    CR.init({ version: "x" });
    const row = await CR.report(new Error("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6 was rejected"), "test");
    expect(row.message).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6");
    expect(row.message).toContain("Bearer ***REDACTED***");
  });

  it("redacts known-secret env values from stack traces", async () => {
    /* Set a fake API key BEFORE init so _rebuildRedactList catches it. */
    process.env.SMOKE_FAKE_API_KEY = "supersecret-12345-XYZ";
    try {
      const CR = await freshImport();
      CR.init({ version: "x" });
      const row = await CR.report(new Error("config had supersecret-12345-XYZ baked in"), "test");
      expect(row.message).not.toContain("supersecret-12345-XYZ");
      expect(row.message).toContain("***REDACTED***");
    } finally {
      delete process.env.SMOKE_FAKE_API_KEY;
    }
  });

  it("replaces $HOME absolute paths with ~", async () => {
    const CR = await freshImport();
    CR.init({ version: "x" });
    const fakePath = `${process.env.HOME}/Desktop/Jarvis/bridge/server.mjs:42:11`;
    const row = await CR.report(new Error(`Cannot read at ${fakePath}`), "test");
    expect(row.message).not.toContain(process.env.HOME);
    expect(row.message).toContain("~");
  });

  it("captures the rolling stdout tail when logLine() is called", async () => {
    const CR = await freshImport();
    CR.init({ version: "x" });
    CR.logLine("[bridge] booted");
    CR.logLine("[bridge] got query");
    const row = await CR.report(new Error("crashed after queries"), "test");
    expect(row.stdoutTail).toEqual(["[bridge] booted", "[bridge] got query"]);
  });

  it("caps the stdout tail at 20 lines (FIFO)", async () => {
    const CR = await freshImport();
    CR.init({ version: "x" });
    for (let i = 0; i < 30; i++) CR.logLine(`line-${i}`);
    const row = await CR.report(new Error("c"), "test");
    expect(row.stdoutTail.length).toBe(20);
    /* The 10 oldest lines should have been dropped — first surviving = line-10. */
    expect(row.stdoutTail[0]).toBe("line-10");
    expect(row.stdoutTail[19]).toBe("line-29");
  });

  it("recent() returns rows newest-first across days", async () => {
    const CR = await freshImport();
    CR.init({ version: "x" });
    await CR.report(new Error("first"), "test");
    await CR.report(new Error("second"), "test");
    const recent = CR.recent({ days: 7 });
    expect(recent.length).toBeGreaterThanOrEqual(2);
    /* Newest first: "second" should precede "first". */
    const firstIdx = recent.findIndex((r) => r.message === "first");
    const secondIdx = recent.findIndex((r) => r.message === "second");
    expect(secondIdx).toBeLessThan(firstIdx);
  });

  it("summary() aggregates counts per day", async () => {
    const CR = await freshImport();
    CR.init({ version: "x" });
    await CR.report(new Error("a"), "test");
    await CR.report(new Error("b"), "test");
    const summary = CR.summary({ days: 7 });
    expect(summary.length).toBe(1);
    expect(summary[0].count).toBeGreaterThanOrEqual(2);
  });

  it("broadcasts system.crash to wired subscriber", async () => {
    const CR = await freshImport();
    let received = null;
    CR.init({ version: "x", broadcaster: (m) => { received = m; } });
    await CR.report(new Error("broadcast me"), "test");
    expect(received?.type).toBe("system.crash");
    expect(received.data.message).toBe("broadcast me");
    expect(received.data.source).toBe("test");
  });
});
