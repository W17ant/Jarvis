/** providers.mjs - Unified LLM chat surface across Ollama / Anthropic / OpenAI.
 *
 *  Why this exists separately from server.mjs's askLLM/askLLMStream: the main
 *  voice chat loop is tightly tuned for Ollama + qwen2.5 tool-calling and
 *  changing it risks regressing the working voice path. New tools that need
 *  a different model (e.g. browse_web wants Claude with vision) call into
 *  THIS module instead. Both surfaces can coexist; if the operator later
 *  wants to switch main chat to Claude, askLLM() can be repointed at chat()
 *  here without rewriting the routing logic.
 *
 *  Routing knobs (env-driven, edited via .env or the HUD's API keys modal):
 *    LLM_PROVIDER_DEFAULT   = ollama | anthropic | openai
 *    LLM_PROVIDER_VISION    = anthropic | openai     (must support vision)
 *    LLM_PROVIDER_HIGHSTAKES = anthropic | openai | ollama
 *    ANTHROPIC_API_KEY, ANTHROPIC_MODEL
 *    OPENAI_API_KEY, OPENAI_MODEL
 *    OLLAMA_URL (already used elsewhere)
 *
 *  None of these are required — if a key is missing the provider isn't
 *  available and pickProvider() falls back to ollama. The browse_web tool
 *  hard-fails if no vision-capable provider is configured (because driving
 *  a browser from text-only is unreliable enough that we'd rather refuse).
 */

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
/* OPENAI_API is env-configurable so any OpenAI-compatible server can sub in.
 * Use case: point at mlx-lm.server (http://localhost:8080/v1/chat/completions
 * by default) to serve a locally fine-tuned LoRA adapter through the same
 * code path as the cloud OpenAI provider. Set OPENAI_API_KEY to any
 * non-empty string (mlx-lm.server doesn't check) and LLM_PROVIDER_DEFAULT
 * to "openai" — bridge then routes to the local MLX server. */
const OPENAI_API = process.env.OPENAI_API_BASE || "https://api.openai.com/v1/chat/completions";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

/* Lazy import for the system-warnings registry — avoids a top-level circular
 * with server.mjs (server imports providers, providers reaches back through
 * the registry which server also imports). Inlined dynamic import keeps both
 * sides clean and means a missing/renamed module fails soft (warning skipped,
 * actual error still propagates). */
async function _registerAuthWarning(provider, status) {
  try {
    const SW = await import("../system-warnings.mjs");
    SW.register({
      code: `llm-key-invalid:${provider}`,
      title: `${provider.toUpperCase()} key rejected`,
      body: status === 401
        ? `The configured API key was rejected (HTTP 401). Open Settings → API keys and update it.`
        : `${provider.toUpperCase()} returned HTTP ${status} — your key may be missing scope or rate-limited.`,
      action: { label: "OPEN SETTINGS", href: "javascript:document.getElementById('settingsBtn')?.click()" },
    });
  } catch { /* registry not wired (e.g. unit tests) — silent */ }
}

/* Lazy-loaded usage logger — kept out of the import block to avoid a
 * circular import risk when usage-log.mjs grows. Imported on first call,
 * cached thereafter. */
let _usageLogger = null;
async function logUsage(entry) {
  try {
    if (!_usageLogger) _usageLogger = await import("../usage-log.mjs");
    await _usageLogger.recordUsage(entry);
  } catch { /* logging never breaks the chat path */ }
}

/* ---------- GLOBAL OLLAMA CONCURRENCY GUARD ----------
 *
 * Apple Silicon's Metal context can't safely serve >1 ollama generation
 * concurrently — the GPU thrashes and on the M5 Max it's been observed
 * to crash. We force ollama calls to serialise here so every code path
 * (voice loop, crew agents, browse, transcribe, anything else) shares
 * the same single-slot semaphore. Cloud providers stay unbounded by
 * this layer; their rate limits are enforced by the API.
 *
 * The semaphore lives in this module rather than per-caller so
 * crew.mjs no longer needs its own copy. Crew spec validation still
 * refuses parallel-mode all-ollama crews because they'd serialise
 * here anyway — that refusal is for clarity, not safety. */
const _ollamaQueue = { inFlight: 0, waiting: [] };
const OLLAMA_MAX_INFLIGHT = 1;

export async function withOllamaSlot(fn) {
  const release = await acquireOllamaSlot();
  try { return await fn(); }
  finally { release(); }
}

/** Explicit acquire/release pair for the streaming path — fetch() returns
 *  when headers arrive but the GPU is still busy generating. The streaming
 *  consumer must hold the slot until the body is fully read, then call
 *  the returned release(). For non-streaming callers, withOllamaSlot above
 *  handles the bookkeeping automatically. */
export async function acquireOllamaSlot() {
  if (_ollamaQueue.inFlight >= OLLAMA_MAX_INFLIGHT) {
    await new Promise((resolve) => _ollamaQueue.waiting.push(resolve));
  }
  _ollamaQueue.inFlight += 1;
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    _ollamaQueue.inFlight -= 1;
    const next = _ollamaQueue.waiting.shift();
    if (next) next();
  };
}

/** Diagnostic snapshot for /health and /crew/concurrency. */
export function ollamaConcurrencyStatus() {
  return { inFlight: _ollamaQueue.inFlight, queued: _ollamaQueue.waiting.length, max: OLLAMA_MAX_INFLIGHT };
}

/** Default model per provider — overridable via env. Picked for Nov 2026 leaderboard:
 *  Claude Sonnet 4.6 is fast + has vision + tool use; GPT-4o is the OpenAI peer. */
function defaultsFor(provider) {
  switch (provider) {
    case "anthropic": return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    case "openai":    return process.env.OPENAI_MODEL    || "gpt-4o";
    case "ollama":    return process.env.OLLAMA_MODEL    || "qwen2.5:14b";
    default: return null;
  }
}

/** Diagnostic snapshot — what's configured + reachable. Used by the audit
 *  endpoint and the HUD's settings modal so the operator sees at a glance
 *  which providers are live. */
export function listProviders() {
  return [
    { name: "ollama",    available: true,                                 model: defaultsFor("ollama"),    needsKey: false },
    { name: "anthropic", available: !!process.env.ANTHROPIC_API_KEY,      model: defaultsFor("anthropic"), needsKey: true  },
    { name: "openai",    available: !!process.env.OPENAI_API_KEY,         model: defaultsFor("openai"),    needsKey: true  },
  ];
}

/** Pick a provider for a workload. The workload string is one of:
 *    "default"     — chat / drafting (env: LLM_PROVIDER_DEFAULT)
 *    "vision"      — image / screenshot interpretation
 *    "highstakes"  — irreversible decisions (purchases, future stock orders)
 *  Falls back to ollama if the configured provider is missing its API key. */
export function pickProvider(workload = "default") {
  const envKey = {
    default:    "LLM_PROVIDER_DEFAULT",
    vision:     "LLM_PROVIDER_VISION",
    highstakes: "LLM_PROVIDER_HIGHSTAKES",
  }[workload] || "LLM_PROVIDER_DEFAULT";
  const want = (process.env[envKey] || "ollama").toLowerCase();
  if (want === "anthropic" && !process.env.ANTHROPIC_API_KEY) return "ollama";
  if (want === "openai" && !process.env.OPENAI_API_KEY) return "ollama";
  return want;
}

/**
 * Unified chat call. Returns { text, toolCalls, provider, model, usage }.
 * Vision content is supported by passing { type: "image", source: { ... } } in
 * any user message — the adapter translates per-provider.
 *
 * @param {object} opts
 * @param {string} [opts.provider]   — explicit override; otherwise pickProvider()
 * @param {string} [opts.workload]   — used by pickProvider when no explicit provider
 * @param {string} [opts.model]      — explicit override of provider default
 * @param {Array}  opts.messages     — [{ role, content }] — content can be string or array of parts
 * @param {Array}  [opts.tools]      — OpenAI-style tool definitions; translated for Anthropic
 * @param {number} [opts.maxTokens]  — default 1024
 * @param {AbortSignal} [opts.signal]
 */
export async function chat({ provider, workload = "default", model, messages, tools, maxTokens = 1024, signal } = {}) {
  const p = (provider || pickProvider(workload)).toLowerCase();
  const m = model || defaultsFor(p);
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("chat() requires non-empty messages array");
  if (p === "anthropic") return await anthropicChat({ model: m, messages, tools, maxTokens, signal });
  if (p === "openai")    return await openaiChat({ model: m, messages, tools, maxTokens, signal });
  if (p === "ollama")    return await ollamaChat({ model: m, messages, tools, signal });
  throw new Error(`Unknown provider: ${p}`);
}

/* ---------- ANTHROPIC ----------
 * Messages API. The system prompt is hoisted to a top-level field. Tool
 * definitions use Anthropic's input_schema shape (a subset of OpenAI's
 * function-call schema). Image content uses { type: "image", source: { type: "base64", media_type, data } }. */
async function anthropicChat({ model, messages, tools, maxTokens, signal }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const systemMsg = messages.find((m) => m.role === "system");
  const convo = messages.filter((m) => m.role !== "system").map(adaptMessageForAnthropic);

  /* Anthropic prompt caching — wrap the system prompt as a content block
   * marked cache_control: ephemeral. Anthropic stores the cached prefix
   * for ~5 minutes; subsequent requests with the same prefix hit the
   * cache for ~90% input-token cost reduction + measurable TTFT win.
   *
   * Why system but not tools: a single cache breakpoint on system covers
   * the largest stable chunk (1k+ tokens of operator persona, scope rules,
   * confirmation contract, memory hints). Tools are also stable but
   * cache_control would need to be added to the LAST tool definition,
   * which couples this code to TOOLS array ordering. System-only is the
   * 80/20 win — tools-caching is a follow-up if we need more.
   *
   * Disable via OPT_OUT_PROMPT_CACHE=1 if a particular run needs no
   * cache (e.g. when system content is being rapidly iterated). */
  const useCache = process.env.OPT_OUT_PROMPT_CACHE !== "1" && systemMsg?.content;
  const body = {
    model,
    max_tokens: maxTokens,
    system: useCache
      ? [{ type: "text", text: systemMsg.content, cache_control: { type: "ephemeral" } }]
      : (systemMsg?.content || undefined),
    messages: convo,
  };
  if (tools?.length) body.tools = tools.map(toolToAnthropic);
  const t0 = Date.now();
  const r = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      /* prompt-caching-2024-07-31 became GA but the beta header is still
       * accepted and explicit about the feature being in use. Keeping it
       * makes the request self-documenting. */
      "anthropic-beta": "prompt-caching-2024-07-31",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    /* Log even on failure — the operator wants to know about wasted retries. */
    logUsage({ provider: "anthropic", model, elapsedMs: Date.now() - t0, source: "providers.chat", error: `${r.status}: ${txt.slice(0, 120)}` });
    /* 401/403 surface as toasts so the operator can fix their key without
     * reading bridge logs. Higher codes (5xx, rate limits) stay invisible
     * because they're transient and would just spam. */
    if (r.status === 401 || r.status === 403) _registerAuthWarning("anthropic", r.status);
    throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 400)}`);
  }
  const j = await r.json();
  /* Anthropic returns cache_creation_input_tokens (when system was first
   * cached) and cache_read_input_tokens (when system was reused). Sum
   * them into tokensIn for accurate cost accounting; also log the cached
   * count separately so the operator can see the cache working. */
  const cachedIn = (j.usage?.cache_read_input_tokens || 0);
  const writtenIn = (j.usage?.cache_creation_input_tokens || 0);
  logUsage({
    provider: "anthropic",
    model: j.model || model,
    tokensIn: (j.usage?.input_tokens || 0) + cachedIn + writtenIn,
    tokensOut: j.usage?.output_tokens || 0,
    cachedIn,
    cachedWritten: writtenIn,
    elapsedMs: Date.now() - t0,
    source: "providers.chat",
  });
  /* Anthropic returns content as an array of blocks (text + tool_use). Normalise
   * to { text, toolCalls } so downstream code doesn't care which provider it hit. */
  let text = "";
  const toolCalls = [];
  for (const block of j.content || []) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input });
  }
  return { text, toolCalls, provider: "anthropic", model: j.model, usage: j.usage };
}

/** Translate one message from the unified format (string content or array of
 *  parts) to Anthropic's expected shape. We accept parts of type "text" and
 *  "image"; anything else passes through unchanged so a future "tool_result"
 *  block can be added without rewriting this. */
function adaptMessageForAnthropic(msg) {
  if (typeof msg.content === "string") return { role: msg.role, content: msg.content };
  if (!Array.isArray(msg.content)) return msg;
  const content = msg.content.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") return { type: "image", source: p.source };
    return p;
  });
  return { role: msg.role, content };
}

/** OpenAI-style tool → Anthropic input_schema shape. The bodies are nearly
 *  identical; we strip the OpenAI-specific "type: function" wrapper. */
function toolToAnthropic(t) {
  const fn = t.function || t;
  return { name: fn.name, description: fn.description, input_schema: fn.parameters };
}

/* ---------- OPENAI ----------
 * Chat Completions API. OpenAI's tool spec matches what's already in TOOLS, so
 * no adaptation needed beyond stripping our internal extra fields. Vision uses
 * { type: "image_url", image_url: { url: "data:image/png;base64,..." } }. */
async function openaiChat({ model, messages, tools, maxTokens, signal }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages.map(adaptMessageForOpenAI),
  };
  if (tools?.length) body.tools = tools;
  const t0 = Date.now();
  const r = await fetch(OPENAI_API, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    logUsage({ provider: "openai", model, elapsedMs: Date.now() - t0, source: "providers.chat", error: `${r.status}: ${txt.slice(0, 120)}` });
    if (r.status === 401 || r.status === 403) _registerAuthWarning("openai", r.status);
    throw new Error(`OpenAI ${r.status}: ${txt.slice(0, 400)}`);
  }
  const j = await r.json();
  logUsage({
    provider: "openai",
    model: j.model || model,
    tokensIn: j.usage?.prompt_tokens || 0,
    tokensOut: j.usage?.completion_tokens || 0,
    elapsedMs: Date.now() - t0,
    source: "providers.chat",
  });
  const choice = j.choices?.[0];
  const text = choice?.message?.content || "";
  const toolCalls = (choice?.message?.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function?.name,
    args: safeJsonParse(tc.function?.arguments),
  }));
  return { text, toolCalls, provider: "openai", model: j.model, usage: j.usage };
}

function adaptMessageForOpenAI(msg) {
  if (typeof msg.content === "string") return msg;
  if (!Array.isArray(msg.content)) return msg;
  const content = msg.content.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image" && p.source?.type === "base64") {
      return { type: "image_url", image_url: { url: `data:${p.source.media_type};base64,${p.source.data}` } };
    }
    return p;
  });
  return { role: msg.role, content };
}

/* ---------- OLLAMA ----------
 * Local /api/chat. Mostly a passthrough — kept here so the unified chat() call
 * works regardless of provider. Tool calls use Qwen 2.5's OpenAI-compatible
 * shape, which matches what we already feed Anthropic post-translation. */
async function ollamaChat({ model, messages, tools, signal }) {
  const t0 = Date.now();
  /* Serialise behind the global ollama semaphore — see top of file. */
  const r = await withOllamaSlot(() => fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: messages.map(adaptMessageForOllama),
      tools: tools?.length ? tools : undefined,
      stream: false,
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30s",
    }),
    signal,
  }));
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    logUsage({ provider: "ollama", model, elapsedMs: Date.now() - t0, source: "providers.chat", error: `${r.status}: ${txt.slice(0, 120)}` });
    throw new Error(`Ollama ${r.status}: ${txt.slice(0, 400)}`);
  }
  const j = await r.json();
  logUsage({
    provider: "ollama",
    model,
    tokensIn: j.prompt_eval_count || 0,
    tokensOut: j.eval_count || 0,
    elapsedMs: Date.now() - t0,
    source: "providers.chat",
  });
  const text = j.message?.content || "";
  const toolCalls = (j.message?.tool_calls || []).map((tc) => ({
    id: tc.id || `tc_${Math.random().toString(36).slice(2, 10)}`,
    name: tc.function?.name,
    args: typeof tc.function?.arguments === "string" ? safeJsonParse(tc.function.arguments) : tc.function?.arguments,
  }));
  return { text, toolCalls, provider: "ollama", model, usage: { prompt_tokens: j.prompt_eval_count, completion_tokens: j.eval_count } };
}

/** Ollama supports image content via { role: "user", images: ["base64..."] }
 *  rather than a content array — different shape from OpenAI/Anthropic. */
function adaptMessageForOllama(msg) {
  if (typeof msg.content === "string") return msg;
  if (!Array.isArray(msg.content)) return msg;
  const textParts = [];
  const images = [];
  for (const p of msg.content) {
    if (p.type === "text") textParts.push(p.text);
    if (p.type === "image" && p.source?.type === "base64") images.push(p.source.data);
  }
  return { role: msg.role, content: textParts.join("\n"), images: images.length ? images : undefined };
}

/** Tolerant JSON parse — returns {} on bad input. Used for tool-call arg
 *  decoding where a malformed arg shouldn't crash the whole turn. */
function safeJsonParse(s) {
  if (typeof s !== "string") return s || {};
  try { return JSON.parse(s); } catch { return {}; }
}
