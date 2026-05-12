/** fal.mjs — fal.ai REST client with sync + queue endpoints + download helper.
 *
 *  Two entry points:
 *
 *    run(modelId, input, opts)
 *      Synchronous endpoint (https://fal.run/<modelId>). Best for fast models
 *      (image gen ~3-8s). Returns the parsed JSON output once the model
 *      completes. Throws if the API rejects the request or the model errors.
 *
 *    submit(modelId, input)
 *      Queue endpoint (https://queue.fal.run/<modelId>). Returns immediately
 *      with a request_id + a poll() helper. Use for slow models (video gen
 *      30-90s) where the sync endpoint may exceed Cloudflare's connection
 *      timeout. poll() defaults to 2s interval, 60 max attempts (2 minutes).
 *
 *    download(url, destPath)
 *      Stream a fal.ai-hosted output URL to a local file. Most fal models
 *      return signed URLs that expire after ~1 hour, so we always pull the
 *      bytes locally rather than referencing the remote URL.
 *
 *  Auth: reads FAL_KEY from process.env. Throws a clear error if missing
 *  rather than silently returning 401 — operators see "FAL_KEY not set" in
 *  the bridge log + the tool reply, and know exactly what to do.
 *
 *  Why this lives at bridge-level and not per-tool: the kiosk is going to
 *  grow more fal.ai capabilities over time (audio gen, image edit, lip-sync,
 *  etc) and they should all share one client + retry + cost-logging surface.
 */

import { writeFile, readFile } from "node:fs/promises";
import { basename } from "node:path";

const FAL_BASE_SYNC = "https://fal.run";
const FAL_BASE_QUEUE = "https://queue.fal.run";
const FAL_BASE_STORAGE = "https://rest.alpha.fal.ai";

/** Read FAL_KEY from env. Throw with an operator-friendly message if missing. */
function _getKey() {
  const k = process.env.FAL_KEY || "";
  if (!k) {
    throw new Error(
      "FAL_KEY not set in .env — fal.ai features (image / video generation) " +
      "are disabled. Sign up at fal.ai, copy the key from your dashboard, " +
      "then add `FAL_KEY=<your-key>` to .env and restart the bridge."
    );
  }
  return k;
}

/** True if FAL_KEY is configured. Used by tool registration to decide whether
 *  to advertise fal-backed tools to the LLM. */
export function isConfigured() {
  return !!(process.env.FAL_KEY || "").trim();
}

/**
 * Sync-endpoint call. Submits the input + waits on the same connection until
 * the model produces a result. Best for image gen / fast models.
 *
 * @param {string} modelId  fal.ai model slug, e.g. "fal-ai/nano-banana/pro"
 * @param {object} input    request body, model-specific
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  abort the fetch after this many ms (default 120s)
 * @returns {Promise<object>}  parsed JSON output from the model
 */
export async function run(modelId, input, { timeoutMs = 120_000 } = {}) {
  const key = _getKey();
  const t0 = Date.now();
  const r = await fetch(`${FAL_BASE_SYNC}/${modelId}`, {
    method: "POST",
    headers: {
      "Authorization": `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const elapsed = Date.now() - t0;
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`fal.ai ${modelId} returned ${r.status} after ${elapsed}ms: ${errText.slice(0, 400)}`);
  }
  const out = await r.json();
  console.log(`[fal] ${modelId} sync ok in ${elapsed}ms`);
  return out;
}

/**
 * Queue-endpoint submission. Returns a handle with poll() for waiting on
 * completion. Use for video-gen and other long-running models.
 *
 * @param {string} modelId
 * @param {object} input
 * @returns {Promise<{ requestId: string, poll: (intervalMs?: number, maxAttempts?: number) => Promise<object> }>}
 */
export async function submit(modelId, input) {
  const key = _getKey();
  const t0 = Date.now();
  const r = await fetch(`${FAL_BASE_QUEUE}/${modelId}`, {
    method: "POST",
    headers: {
      "Authorization": `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    throw new Error(`fal.ai submit ${modelId} ${r.status}: ${errText.slice(0, 400)}`);
  }
  const j = await r.json();
  console.log(`[fal] ${modelId} queued (request_id=${j.request_id}) in ${Date.now() - t0}ms`);
  /* fal.ai's queue returns absolute URLs to status + result endpoints. We
   * keep them as-is and only need the API key to authenticate the polls. */
  const statusUrl = j.status_url;
  const responseUrl = j.response_url;
  return {
    requestId: j.request_id,
    statusUrl,
    responseUrl,
    /**
     * Poll the queue every intervalMs until COMPLETED or FAILED, then fetch
     * the response body. Throws on FAILED or after maxAttempts intervals.
     */
    async poll(intervalMs = 2000, maxAttempts = 60) {
      const pollStart = Date.now();
      for (let i = 0; i < maxAttempts; i++) {
        const sr = await fetch(statusUrl, { headers: { "Authorization": `Key ${key}` } });
        if (sr.ok) {
          const status = await sr.json();
          if (status.status === "COMPLETED") {
            const result = await fetch(responseUrl, { headers: { "Authorization": `Key ${key}` } });
            if (!result.ok) {
              throw new Error(`fal.ai ${modelId} completed but result fetch ${result.status}`);
            }
            console.log(`[fal] ${modelId} completed in ${Date.now() - pollStart}ms (${i + 1} polls)`);
            return result.json();
          }
          if (status.status === "FAILED") {
            throw new Error(`fal.ai ${modelId} FAILED: ${JSON.stringify(status).slice(0, 400)}`);
          }
          /* IN_QUEUE / IN_PROGRESS — keep waiting. */
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`fal.ai ${modelId} timed out after ${maxAttempts * intervalMs}ms (${maxAttempts} polls)`);
    },
  };
}

/**
 * Stream a fal.ai-hosted output URL to a local file. fal returns signed URLs
 * that expire after ~1h, so we always pull the bytes immediately rather than
 * referencing the remote URL in downstream code.
 *
 * @param {string} url      remote URL (signed)
 * @param {string} destPath absolute local path to write to
 * @returns {Promise<string>} resolved destPath
 */
export async function download(url, destPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fal.ai download ${url} → ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(destPath, buf);
  return destPath;
}

/**
 * Upload a local file to fal-storage and get back a hosted https URL that
 * fal models accept as image_url / video_url / audio_url etc.
 *
 * Why this matters: data URIs are documented as accepted but in practice
 * many fal models — Kling Motion Control specifically — return 422 on
 * data-URI video inputs above ~1MB. Hosted URLs always work. This helper
 * implements fal's two-step storage protocol:
 *   1. POST /storage/upload/initiate  → { upload_url, file_url }
 *   2. PUT upload_url with the file bytes
 *   3. file_url is the persistent hosted URL (~1h signed validity in
 *      practice, plenty for a model call that completes in minutes)
 *
 * @param {string} localPath    absolute local path to the file
 * @param {object} [opts]
 * @param {string} [opts.contentType]  MIME type. Default inferred from
 *   extension; falls back to application/octet-stream.
 * @param {string} [opts.fileName]     name to register on fal-storage.
 *   Default the basename of localPath.
 * @returns {Promise<string>}  the hosted file_url
 */
export async function upload(localPath, { contentType, fileName } = {}) {
  const key = _getKey();
  const bytes = await readFile(localPath);
  const name = fileName || basename(localPath);
  const ct = contentType || _guessContentType(name);

  /* Step 1 — initiate. Returns a presigned upload_url + the public file_url. */
  const initRes = await fetch(`${FAL_BASE_STORAGE}/storage/upload/initiate`, {
    method: "POST",
    headers: {
      "Authorization": `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file_name: name, content_type: ct }),
  });
  if (!initRes.ok) {
    const errText = await initRes.text().catch(() => "");
    throw new Error(`fal.ai storage initiate ${initRes.status}: ${errText.slice(0, 300)}`);
  }
  const { upload_url, file_url } = await initRes.json();
  if (!upload_url || !file_url) throw new Error("fal.ai storage initiate returned no urls");

  /* Step 2 — PUT the bytes. The presigned URL has its own auth, no Authorization
   * header needed. Content-Type must match the initiate value or the signed
   * URL rejects the upload. */
  const putRes = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": ct },
    body: bytes,
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => "");
    throw new Error(`fal.ai storage PUT ${putRes.status}: ${errText.slice(0, 300)}`);
  }
  return file_url;
}

/**
 * Detect fal's safety/content reject. nano-banana / nano-banana-pro / pro-2
 * return a 422 with a body containing "did not generate the expected output
 * for this prompt" when the safety filter blocks specific trademarks,
 * celebrity names, or otherwise gated content. Distinct from schema errors
 * (which mention "field required", "value is not a valid", etc.) so we don't
 * blindly retry on missing fields.
 */
export function isSafetyReject(error) {
  const s = String(error?.message || error || "").toLowerCase();
  if (s.includes("did not generate the expected output")) return true;
  if (s.includes("unsafe content") && s.includes("422")) return true;
  if (s.includes("safety_tolerance") && s.includes("422")) return true;
  return false;
}

/**
 * Image-gen with one safety-rephrase retry. If `run` fails with isSafetyReject,
 * call the supplied `rephrase` callback to rewrite the prompt without the
 * problematic terms, then retry the SAME model once. Any other error
 * propagates immediately. Returns the model output (parsed JSON).
 *
 * Why decoupled from a specific LLM: server.mjs owns the Ollama URL + model
 * router; we don't want fal.mjs to depend on those. The caller passes a
 * rephrase function that takes a prompt string and returns a safer one.
 *
 * @param {string} modelId
 * @param {object} input            must contain a string `prompt` field
 * @param {object} [opts]
 * @param {(prompt: string) => Promise<string>} [opts.rephrase]
 *                                  rewrite callback; if absent, no retry
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ result: object, retried: boolean, originalPrompt?: string, saferPrompt?: string }>}
 */
export async function runImageWithSafetyRetry(modelId, input, { rephrase, timeoutMs } = {}) {
  try {
    const result = await run(modelId, input, { timeoutMs });
    return { result, retried: false };
  } catch (e) {
    if (!isSafetyReject(e) || typeof rephrase !== "function") throw e;
    if (!input?.prompt) throw e;
    let safer;
    try {
      safer = await rephrase(input.prompt);
    } catch (e2) {
      throw new Error(`fal ${modelId} safety reject; rephrase callback failed: ${e2.message}`);
    }
    if (!safer || safer.trim() === input.prompt.trim()) throw e;
    console.log(`[fal] ${modelId} safety reject — retrying with rephrased prompt`);
    const result = await run(modelId, { ...input, prompt: safer }, { timeoutMs });
    return { result, retried: true, originalPrompt: input.prompt, saferPrompt: safer };
  }
}

/** Best-effort MIME guess from filename extension. fal's storage init accepts
 *  any content_type but the matching PUT must use the SAME value, so we keep
 *  the table tight and predictable rather than introducing a heavy mime
 *  dependency. */
function _guessContentType(name) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  switch (ext) {
    case "mp4":  return "video/mp4";
    case "mov":  return "video/quicktime";
    case "webm": return "video/webm";
    case "png":  return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif":  return "image/gif";
    case "wav":  return "audio/wav";
    case "mp3":  return "audio/mpeg";
    default:     return "application/octet-stream";
  }
}
