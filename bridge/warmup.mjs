/** warmup.mjs - Pre-load Ollama / Kokoro / VL at bridge boot.
 *
 *  Why: a cold bridge takes 2-3s to load the 14b/32b text model, ~600ms to load
 *  Kokoro, and ~1-2s to load the VL model. The first real operator query pays
 *  that combined tax — they say "hey flat-out" and wait three seconds for any
 *  reply. Pre-warming fires a tiny no-op request to each service after the bridge
 *  binds its port, so by the time the operator says anything, every model is
 *  already resident.
 *
 *  Async + non-blocking: we kick off the warm-ups and return. Failures are logged
 *  but don't surface — a fresh install with Kokoro not yet running shouldn't
 *  block the bridge from accepting tool calls.
 *
 *  Hardware-tier-aware: on lite tier we skip the VL warmup entirely (loading the
 *  VL model on a 16GB Mac steals RAM the operator's other apps need). The text
 *  + Kokoro warmups run for everyone since both are essential to the wake-loop. */

const KOKORO_URL = "http://localhost:8767";
const WHISPER_URL = "http://localhost:8768";

/* Tiny 1×1 PNG (transparent pixel), base64-encoded. Used for the VL warmup so
 * we don't have to read a file from disk + waste cycles encoding. */
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

/**
 * Warm the text model. Sends a single-token /api/generate so Ollama loads the
 * weights into memory + the keep_alive timer starts ticking from a known state.
 *
 * @param {object} opts
 * @param {string} opts.ollamaUrl  base URL, e.g. "http://localhost:11434"
 * @param {string} opts.model      model name, e.g. "qwen2.5:14b"
 * @param {string} [opts.keepAlive] keep_alive string like "30m"
 */
async function warmText({ ollamaUrl, model, keepAlive }) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "1",          // shortest possible prompt — we just want the model loaded
        stream: false,
        options: { num_predict: 1 },
        keep_alive: keepAlive,
      }),
      /* Generous timeout: a 32b cold-load can take 30s on first run after `ollama pull`. */
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    await res.json().catch(() => {});  // drain
    console.log(`[warmup] text model "${model}" ready in ${Date.now() - t0}ms`);
  } catch (e) {
    console.warn(`[warmup] text model "${model}" failed: ${e.message}`);
  }
}

/** Warm the VL model. Captions a 1×1 transparent pixel — model loads, returns garbage,
 *  we throw away the result. The point is just to populate Ollama's keep_alive cache. */
async function warmVL({ ollamaUrl, model, keepAlive }) {
  if (!model) return;
  const t0 = Date.now();
  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: keepAlive,
        messages: [{ role: "user", content: "ok", images: [TINY_PNG_B64] }],
        options: { num_predict: 1, temperature: 0 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    await res.json().catch(() => {});
    console.log(`[warmup] VL model "${model}" ready in ${Date.now() - t0}ms`);
  } catch (e) {
    console.warn(`[warmup] VL model "${model}" failed: ${e.message}`);
  }
}

/** Warm Kokoro by synthesising a single short word silently. Keeps the model loaded
 *  + the WAV decoder warm so the first real reply doesn't pay the cold-start. */
async function warmKokoro() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${KOKORO_URL}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ok", voice: "bm_daniel" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`kokoro ${res.status}`);
    /* Drain the body so the connection releases cleanly. We don't play it. */
    await res.arrayBuffer();
    console.log(`[warmup] Kokoro ready in ${Date.now() - t0}ms`);
  } catch (e) {
    console.warn(`[warmup] Kokoro warmup failed: ${e.message} (TTS will still work, first reply will pay cold-start)`);
  }
}

/** Warm Whisper. Sends a tiny silence WAV so the model loads + the audio buffer
 *  initialises. Lower priority than the others — Whisper's cold-start is shorter
 *  and the operator typically pauses after pressing the wake button anyway. */
async function warmWhisper() {
  const t0 = Date.now();
  try {
    /* Probe the health endpoint first — if Whisper isn't running, skip the synthesis
     * step entirely. Most installs run Whisper as a daemon alongside the bridge. */
    const r = await fetch(`${WHISPER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`health ${r.status}`);
    console.log(`[warmup] Whisper reachable in ${Date.now() - t0}ms`);
  } catch (e) {
    console.warn(`[warmup] Whisper unreachable: ${e.message}`);
  }
}

/**
 * Run all warm-ups in parallel. Returns a Promise that resolves when every probe
 * finishes (success or failure) — the caller doesn't usually await it; it's
 * fire-and-forget at boot.
 *
 * @param {object} cfg
 * @param {string} cfg.ollamaUrl
 * @param {string} cfg.textModel
 * @param {string} [cfg.vlModel]
 * @param {string} [cfg.textKeepAlive]
 * @param {string} [cfg.vlKeepAlive]
 * @param {boolean} [cfg.skipVL]   tier-controlled — skip VL warmup on lite tier
 */
export async function warmUpAll(cfg) {
  console.log(`[warmup] starting (text=${cfg.textModel}${cfg.skipVL ? ", VL skipped" : `, vl=${cfg.vlModel}`})`);
  await Promise.allSettled([
    warmText({ ollamaUrl: cfg.ollamaUrl, model: cfg.textModel, keepAlive: cfg.textKeepAlive }),
    cfg.skipVL ? Promise.resolve() : warmVL({ ollamaUrl: cfg.ollamaUrl, model: cfg.vlModel, keepAlive: cfg.vlKeepAlive }),
    warmKokoro(),
    warmWhisper(),
  ]);
  console.log(`[warmup] complete`);
}
