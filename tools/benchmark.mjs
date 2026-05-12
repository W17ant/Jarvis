#!/usr/bin/env node
/** benchmark.mjs — voice-loop latency benchmark.
 *
 *  Why: T1 instrumented the pipeline (voice.js → bridge /perf → /health/timings)
 *  but no measurements ever shipped, leaving the "sub-1s first audio" claim
 *  in CHANGELOG.md and the README unverified. This script scrapes the
 *  rolling perf buffer + the persisted per-day sessions log and renders a
 *  human-readable benchmark report at docs/benchmarks.md.
 *
 *  Usage:
 *    npm run benchmark             # scrape + write report
 *    node tools/benchmark.mjs --transcribe-smoke
 *                                  # ALSO fire a known WAV at Whisper N times
 *                                  # and add a pure-STT cold-path block.
 *    node tools/benchmark.mjs --turns-required 5
 *                                  # min samples before the report renders.
 *                                  # Default 5 — anything less is too thin
 *                                  # to be representative.
 *
 *  The bridge MUST be running. If the perf buffer is empty (fresh restart,
 *  no voice usage since), the script tells the operator to wake Jarvis a
 *  handful of times first and exits without overwriting the existing report.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const REPORT_PATH = path.join(PROJECT_ROOT, "docs", "benchmarks.md");
const BRIDGE = "http://localhost:8766";

/** Headline target: first audio in the operator's ear within 1.0s of wake-end.
 * We tightened the segmenter to comma/colon at ≥12 chars for the first chunk
 * specifically to hit this number; if p50 voice_to_audio drifts above 1.0s
 * the segmenter or LLM stack regressed. */
const TARGET_VOICE_TO_AUDIO_P50_MS = 1000;

/** Friendly span labels — keep aligned with bridge/server.mjs's KEYS array
 * in the /health/timings handler. Every key MUST appear here. */
const SPAN_LABELS = {
  voice_to_recend: "wake → recording end",
  voice_to_whisper: "rec end → whisper request",
  whisper_roundtrip: "whisper request → response (network)",
  whisper_inference: "whisper internal compute (python)",
  voice_to_audio: "wake → first audio out",
  /* Sprint 11 — finer-grained spans isolating each stage of the pipeline.
   * recend_to_audio is the new headline (perceptual lag the operator feels). */
  recend_to_audio: "speech end → first audio  ★ headline",
  recend_to_whisper: "speech end → whisper response",
  whisper_to_llm: "whisper → LLM first sentence",
  llm_thinking: "LLM thinking (whisper → first sentence)",
  tts_synth: "TTS synth + decode (LLM first sentence → audio)",
};

const args = process.argv.slice(2);
const transcribeSmoke = args.includes("--transcribe-smoke");
const turnsArg = args.findIndex((a) => a === "--turns-required");
const TURNS_REQUIRED = turnsArg >= 0 ? Number(args[turnsArg + 1]) || 5 : 5;

/** Tiny helper — return null on any fetch failure rather than throwing,
 * so the script can run partial reports against a degraded bridge. */
async function safeFetch(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function fmt(ms) {
  if (ms == null) return "—";
  if (ms < 1) return `${Math.round(ms * 1000)}μs`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function pct(p50, target) {
  if (p50 == null) return "—";
  const ratio = (p50 / target) * 100;
  /* < 100% means we beat the target; render as "78% of budget". */
  return `${ratio.toFixed(0)}% of ${fmt(target)} budget`;
}

/** Render the rolling /health/timings buffer as a markdown table. */
function renderSpansTable(spans) {
  const rows = ["| Span | p50 | p95 | n | vs target |", "|---|---|---|---|---|"];
  for (const [key, label] of Object.entries(SPAN_LABELS)) {
    const s = spans[key];
    const p50 = s?.p50 != null ? fmt(s.p50) : "—";
    const p95 = s?.p95 != null ? fmt(s.p95) : "—";
    const n = s?.n ?? 0;
    const vs = key === "voice_to_audio" && s?.p50 != null
      ? pct(s.p50, TARGET_VOICE_TO_AUDIO_P50_MS)
      : "";
    rows.push(`| \`${key}\` — ${label} | ${p50} | ${p95} | ${n} | ${vs} |`);
  }
  return rows.join("\n");
}

/** Render the per-day session aggregates from /health/sessions. */
function renderSessionsTable(summary) {
  if (!summary?.length) return "_No persisted session data yet — telemetry starts populating after the first voice turn lands._";
  const rows = ["| Day | Turns | p50 audio | p95 audio | Errors |", "|---|---|---|---|---|"];
  for (const day of summary) {
    rows.push(`| ${day.date} | ${day.turns ?? 0} | ${fmt(day.audioP50)} | ${fmt(day.audioP95)} | ${day.errors ?? 0} |`);
  }
  return rows.join("\n");
}

/** OPTIONAL: smoke-test pure STT latency by POSTing a known WAV at Whisper.
 * Useful for catching MLX vs CPU regressions when the model swaps under us.
 * Skipped unless --transcribe-smoke is passed because it needs a sample WAV
 * the operator may not have on disk. */
async function transcribeSmokeBlock() {
  const wav = path.join(PROJECT_ROOT, "test", "fixtures", "hello-jarvis.wav");
  try {
    await fs.access(wav);
  } catch {
    return `_(--transcribe-smoke skipped: place a sample WAV at \`test/fixtures/hello-jarvis.wav\` and re-run.)_`;
  }
  const N = 5;
  const buf = await fs.readFile(wav);
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    try {
      const fd = new FormData();
      fd.append("audio", new Blob([buf], { type: "audio/wav" }), "hello.wav");
      const r = await fetch("http://localhost:8768/transcribe", { method: "POST", body: fd });
      if (r.ok) {
        await r.json();
        times.push(performance.now() - t0);
      }
    } catch { /* skip failed iteration */ }
  }
  if (!times.length) return `_(--transcribe-smoke failed: Whisper unreachable on :8768.)_`;
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(N * 0.5)];
  const p95 = times[Math.floor(N * 0.95)] ?? times[times.length - 1];
  return `Pure STT cold-path (Whisper /transcribe direct, N=${N}): p50 **${fmt(p50)}**, p95 **${fmt(p95)}**.`;
}

async function main() {
  const timings = await safeFetch(`${BRIDGE}/health/timings`);
  const sessions = await safeFetch(`${BRIDGE}/health/sessions?days=14`);
  const healthz = await safeFetch(`${BRIDGE}/healthz`);

  if (!timings || !healthz) {
    console.error("✗ Bridge unreachable on :8766. Run ./launch.sh restart first.");
    process.exit(1);
  }

  const samples = timings.samples ?? 0;
  if (samples < TURNS_REQUIRED) {
    console.error(`✗ Only ${samples} voice turn(s) recorded — need at least ${TURNS_REQUIRED} for a meaningful benchmark.`);
    console.error(`  Wake Jarvis a handful of times (\"hey jarvis, what's the weather\" works), then re-run:`);
    console.error(`  npm run benchmark`);
    console.error(`  Or override the threshold with --turns-required ${samples}`);
    process.exit(2);
  }

  const stamp = new Date().toISOString();
  const services = healthz.services || {};

  let smokeBlock = "";
  if (transcribeSmoke) {
    console.log("→ running --transcribe-smoke against Whisper…");
    smokeBlock = await transcribeSmokeBlock();
  }

  const report = `# Benchmarks

> Generated by \`tools/benchmark.mjs\` at ${stamp}.
> Bridge: ${services.bridge ? "✓" : "✗"}, Ollama: ${services.ollama ? "✓" : "✗"}, Kokoro: ${services.kokoro ? "✓" : "✗"}, Whisper: ${services.whisper ? "✓" : "✗"} (\`${healthz.whisperBackend}/${healthz.whisperModel}\`)

## Headline

**Voice-to-first-audio target: <1.0s p50.**

${(() => {
  const a = timings.spans.voice_to_audio;
  if (!a?.p50) return "_No \`voice_to_audio\` samples yet._";
  const verdict = a.p50 <= TARGET_VOICE_TO_AUDIO_P50_MS ? "✓ within budget" : "✗ over budget — investigate segmenter / LLM stack";
  return `Last ${a.n} turns: **p50 ${fmt(a.p50)}**, p95 ${fmt(a.p95)} — ${verdict}.`;
})()}

## Rolling buffer (last ${samples} turns)

Source: \`GET /health/timings\` — bridge keeps a rolling 50-turn perf buffer in memory.

${renderSpansTable(timings.spans)}

## Per-day persisted sessions

Source: \`GET /health/sessions?days=14\` — \`bridge/sessions.mjs\` appends one row per voice turn to \`data/audit/sessions/YYYY-MM-DD.jsonl\`. Survives bridge restarts; the rolling buffer above does not.

${renderSessionsTable(sessions?.summary)}

${smokeBlock ? `## Pure STT smoke\n\n${smokeBlock}\n` : ""}
## Methodology

1. Operator wakes Jarvis with the configured wake phrase (default: "hey jarvis").
2. \`voice.js\` fires \`performance.mark()\` calls at four boundaries: wake-start, rec-end, whisper-req, whisper-res.
3. \`tts-pipeline.js\` fires \`v.audio-play\` at \`source.start(0)\` — the moment the first audio sample hits the output device.
4. \`voice.js _reportPerfTimings()\` POSTs the span summary to \`/perf\` after each turn.
5. The bridge's \`/perf\` handler appends to a rolling 50-entry buffer (\`_perfBuffer\`) AND writes to the per-day session log.
6. \`/health/timings\` computes p50/p95 across the buffer; \`/health/sessions\` aggregates the persisted log.
7. This script scrapes both endpoints and renders the markdown above.

The pipeline measured: **wake-word fires → silence-detected → audio uploaded → Whisper transcript returned → first LLM token → segmenter emits first chunk → Kokoro synthesises → first audio plays**.

## Hardware context

| | |
|---|---|
| Chip | _(filled by operator: \`sysctl -n machdep.cpu.brand_string\`)_ |
| RAM | _(filled by operator: \`system_profiler SPHardwareDataType\`)_ |
| Whisper backend | \`${healthz.whisperBackend}\` |
| Whisper model | \`${healthz.whisperModel}\` |
| Default LLM | _(check \`config.json\` or \`/health\`)_ |

Numbers will vary between an M1 Max with 64GB and an M3 Pro with 18GB. Re-run this benchmark on each target operator's machine — there's no single "Jarvis is fast" claim.

## Reproducibility

\`\`\`bash
./launch.sh restart                # clean slate
# wake Jarvis 20+ times naturally — weather, calendar, knowledge questions
npm run benchmark                  # generates this file
npm run benchmark -- --transcribe-smoke
                                   # adds the pure-STT block (needs test/fixtures/hello-jarvis.wav)
\`\`\`

The output is committed at \`docs/benchmarks.md\` and re-generated on every run — overwrite is intentional. To compare runs over time, copy the file into a dated archive (\`docs/benchmarks/2026-05-09.md\`) before re-running.
`;

  await fs.writeFile(REPORT_PATH, report);
  console.log(`✓ wrote ${REPORT_PATH}`);
  console.log(`  ${samples} turns analysed`);
  if (timings.spans.voice_to_audio?.p50 != null) {
    const a = timings.spans.voice_to_audio;
    const verdict = a.p50 <= TARGET_VOICE_TO_AUDIO_P50_MS ? "✓ within target" : "✗ regression";
    console.log(`  voice_to_audio p50: ${fmt(a.p50)} (${verdict})`);
  }
}

main().catch((e) => {
  console.error("✗ benchmark failed:", e.message);
  process.exit(1);
});
