#!/usr/bin/env node
/**
 * latency-report.mjs — fetch the bridge's rolling perf buffer and pretty-print
 * p50/p95 per pipeline stage. Used to capture before/after numbers during
 * Sprint 11's voice latency pass.
 *
 * Usage:  node tools/latency-report.mjs [--samples N]
 *
 * Why this script lives here: the HUD overlay (S11-T2) is great for at-a-glance
 * during testing, but a CLI is what you check into docs/benchmarks.md.
 */
const BRIDGE = process.env.JARVIS_BRIDGE || "http://localhost:8766";

/** Friendlier names for the table — dump JSON span keys → display labels. */
const LABELS = {
  voice_to_recend:    "User spoke for",
  voice_to_whisper:   "Wake → Whisper",
  whisper_roundtrip:  "Whisper roundtrip",
  whisper_inference:  "Whisper (server)",
  voice_to_audio:     "Wake → first audio",
  recend_to_audio:    "Speech-end → first audio  ★",
  recend_to_whisper:  "Speech-end → Whisper",
  whisper_to_llm:     "Whisper → LLM 1st sent.",
  llm_thinking:       "LLM thinking",
  tts_synth:          "TTS synth + decode",
};

/** Colour helper — green if p50 under target, red if over, yellow in between. */
function colour(label, p50) {
  if (label === "recend_to_audio") {
    if (p50 < 800)  return `\x1b[32m${p50}ms\x1b[0m`;     // good
    if (p50 < 1200) return `\x1b[33m${p50}ms\x1b[0m`;     // warn
    return `\x1b[31m${p50}ms\x1b[0m`;                     // bad
  }
  return `${p50}ms`;
}

async function main() {
  let res;
  try {
    res = await fetch(`${BRIDGE}/health/timings`);
  } catch (e) {
    console.error(`Bridge not reachable at ${BRIDGE} — is it running?`);
    process.exit(1);
  }
  const j = await res.json();
  if (!j.ok || !j.spans) {
    console.error("Bridge returned malformed timings response");
    process.exit(1);
  }

  console.log(`\nJarvis voice pipeline — last ${j.samples} samples\n`);
  console.log(`  ${"Stage".padEnd(28)} ${"p50".padStart(8)}   ${"p95".padStart(8)}   n`);
  console.log(`  ${"─".repeat(28)} ${"─".repeat(8)}   ${"─".repeat(8)}   ──`);

  for (const [key, label] of Object.entries(LABELS)) {
    const stat = j.spans[key];
    if (!stat) {
      console.log(`  ${label.padEnd(28)} ${"—".padStart(8)}   ${"—".padStart(8)}   0`);
      continue;
    }
    const p50 = colour(key, stat.p50);
    const p95 = `${stat.p95}ms`;
    /* padEnd doesn't account for ANSI codes — pad the raw number, not the colourised string */
    const p50pad = p50.padStart(8 + (p50.length - String(stat.p50 + "ms").length));
    console.log(`  ${label.padEnd(28)} ${p50pad}   ${p95.padStart(8)}   ${stat.n}`);
  }

  console.log(`\n  ★ headline metric — Sprint 11 target: p50 < 800ms\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
