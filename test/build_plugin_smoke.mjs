#!/usr/bin/env node
/** build_plugin_smoke.mjs — end-to-end smoke for the plugin generator.
 *
 *  Exercises the plugin-generator module directly (the same code path
 *  the build_plugin tool calls), waits for the bridge's fs.watch to pick
 *  up the new plugin via /health/plugins, then deletes the test plugin.
 *
 *  Run with the bridge already running:
 *    node test/build_plugin_smoke.mjs
 *
 *  Prints PASS / FAIL per stage. Non-zero exit on any FAIL.
 */

import * as PluginGenerator from "../bridge/plugin-generator.mjs";
import { rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(__dirname, "..", "bridge", "plugins");
const BRIDGE = "http://localhost:8766";

const TEST_SLUGS = ["smoke-test-stub", "smoke-test-agent"];
let exitCode = 0;
function pass(name) { console.log(`  ✓ ${name}`); }
function fail(name, why) {
  console.log(`  ✗ ${name}: ${why}`);
  exitCode = 1;
}

async function fetchJSON(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function waitForPlugin(slug, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = await fetchJSON(`${BRIDGE}/health/plugins`);
    const found = (j?.plugins || j?.loaded || []).find?.((p) => p.name === slug);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function cleanupSlug(slug) {
  const dir = path.join(PLUGINS_DIR, slug);
  try { await rm(dir, { recursive: true, force: true }); } catch {}
}

async function main() {
  console.log("→ build_plugin smoke test\n");

  /* Pre-clean so a previous failed run doesn't poison this one. */
  for (const s of TEST_SLUGS) await cleanupSlug(s);

  /* Stage 1: bridge reachable */
  const healthz = await fetchJSON(`${BRIDGE}/healthz`);
  if (!healthz?.ok) { fail("bridge reachable", "/healthz did not return ok"); return; }
  pass("bridge reachable");

  /* Stage 2: STUB MODE — buildPlugin synchronously creates manifest + handler */
  console.log("\n[stub mode]");
  const stubResult = await PluginGenerator.buildPlugin({
    name: "smoke-test-stub",
    description: "Smoke test stub plugin",
    toolName: "smoke_stub_call",
    voiceIntent: "smoke test stub",
  });
  if (!stubResult.ok) { fail("buildPlugin returns ok", stubResult.error); return; }
  pass("buildPlugin returns ok");

  if (stubResult.mode !== "stub") fail("mode is stub", `got ${stubResult.mode}`);
  else pass("mode is stub");

  if (stubResult.needsAgentFill) fail("stub does not need agent fill", "needsAgentFill=true");
  else pass("stub does not need agent fill");

  const stubDir = path.join(PLUGINS_DIR, "smoke-test-stub");
  if (!existsSync(path.join(stubDir, "manifest.json"))) fail("manifest.json written", "missing");
  else pass("manifest.json written");
  if (!existsSync(path.join(stubDir, "handler.mjs"))) fail("handler.mjs written", "missing");
  else pass("handler.mjs written");

  /* Stage 3: bridge fs.watch hot-loads the plugin within ~1s */
  const loaded = await waitForPlugin("smoke-test-stub", 4000);
  if (!loaded) fail("plugin hot-loads via fs.watch", "not visible at /health/plugins after 4s");
  else {
    pass("plugin hot-loads via fs.watch");
    if (!loaded.tools?.includes("smoke_stub_call")) fail("tool registered", `tools=${JSON.stringify(loaded.tools)}`);
    else pass("tool registered");
  }

  /* Stage 4: AGENT-SEEDED MODE — buildPlugin returns agentPrompt */
  console.log("\n[agent-seeded mode]");
  const agentResult = await PluginGenerator.buildPlugin({
    name: "smoke-test-agent",
    description: "Smoke test agent plugin",
    toolName: "smoke_agent_call",
    voiceIntent: "smoke test agent",
    behaviour: "fetch some example endpoint and return the result",
  });
  if (!agentResult.ok) fail("agent buildPlugin returns ok", agentResult.error);
  else pass("agent buildPlugin returns ok");

  if (agentResult.mode !== "agent-seeded") fail("mode is agent-seeded", `got ${agentResult.mode}`);
  else pass("mode is agent-seeded");

  if (!agentResult.needsAgentFill) fail("agent flag set", "needsAgentFill=false");
  else pass("agent flag set");

  /* The buildAgentPrompt helper should produce a non-empty prompt the LLM can
   * pass to code_agent_run.code. We don't run code_agent_run here — that needs
   * confirmation + LLM output and is beyond a smoke test's scope. */
  const prompt = PluginGenerator.buildAgentPrompt({
    slug: "smoke-test-agent",
    toolName: "smoke_agent_call",
    voiceIntent: "smoke test agent",
    behaviour: "fetch some example endpoint and return the result",
  });
  if (!prompt || prompt.length < 200) fail("agent prompt non-trivial", `length=${prompt?.length}`);
  else pass("agent prompt non-trivial");

  /* Stage 5: collision protection — second buildPlugin without force fails */
  console.log("\n[collision protection]");
  const collide = await PluginGenerator.buildPlugin({
    name: "smoke-test-stub",
    description: "would clobber",
    toolName: "smoke_stub_call",
    voiceIntent: "x",
  });
  if (collide.ok) fail("rejects existing slug without force", "buildPlugin returned ok");
  else pass("rejects existing slug without force");

  const force = await PluginGenerator.buildPlugin({
    name: "smoke-test-stub",
    description: "force overwrite",
    toolName: "smoke_stub_call",
    voiceIntent: "x",
    force: true,
  });
  if (!force.ok) fail("accepts force=true", force.error);
  else pass("accepts force=true");

  /* Stage 6: validation — bad slug rejected */
  console.log("\n[validation]");
  const badSlug = await PluginGenerator.buildPlugin({
    name: "../escape-attempt",
    description: "bad",
    toolName: "x",
    voiceIntent: "x",
  });
  if (badSlug.ok) fail("rejects path-traversal slug", "buildPlugin allowed it");
  else pass("rejects path-traversal slug");

  const badTool = await PluginGenerator.buildPlugin({
    name: "ok-slug",
    description: "ok",
    toolName: "Bad-Name",
    voiceIntent: "x",
  });
  if (badTool.ok) fail("rejects non-snake_case tool name", "buildPlugin allowed it");
  else pass("rejects non-snake_case tool name");

  /* Cleanup */
  console.log("\n[cleanup]");
  for (const s of TEST_SLUGS) await cleanupSlug(s);
  pass("removed test plugins");

  console.log(`\n${exitCode === 0 ? "PASS" : "FAIL"}`);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("smoke test threw:", e);
  process.exit(1);
});
