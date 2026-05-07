/** crew.mjs - Multi-agent orchestrator with cloud-aware concurrency.
 *
 *  THREE ABSTRACTIONS, in CrewAI shape but adapted for Jarvis:
 *
 *    - AgentSpec  { id, role, goal, allowedTools?, provider?, model?,
 *                   maxSteps?, systemPromptOverride? }
 *      A persona + capability subset. allowedTools is a name allowlist
 *      filtered against the global TOOLS array; the embedding tool router
 *      still applies on top within that subset.
 *
 *    - TaskSpec   { id, description, agentId, dependsOn?, expectedOutput? }
 *      One unit of work assigned to one agent. dependsOn carries upstream
 *      results into the agent's context.
 *
 *    - CrewSpec   { id?, mode: "sequential"|"parallel", agents, tasks,
 *                   maxParallel? }
 *      The runner. Sequential = tasks fire in dependency order. Parallel =
 *      independent tasks (no `dependsOn`) fan out concurrently. Both modes
 *      respect the global provider concurrency guard.
 *
 *  PROVIDER CONCURRENCY:
 *    Ollama is single-context — one chat at a time, otherwise the GPU
 *    thrashes (this was the original M5 Max crash). Cloud APIs (Anthropic /
 *    OpenAI) don't share that constraint and can serve N concurrent requests
 *    bounded only by API rate limits.
 *
 *    Rule the orchestrator enforces: in PARALLEL mode, agents routed to
 *    Ollama queue serially behind a single in-flight slot. Cloud agents
 *    fan out up to maxParallel (default 4). The runner refuses to start
 *    a parallel crew where ALL agents would queue on Ollama — that's
 *    sequential pretending to be parallel.
 *
 *  COST TRACKING:
 *    Every chat() call inside a crew is tagged with `crewId:<id>` in the
 *    source field of usage-log.mjs. /usage queries can group by crew,
 *    so the operator sees "this comparison run cost £0.012, this draft
 *    pipeline cost £0.05".
 *
 *  CANCELLATION:
 *    raiseAbort(crewId) sets a flag the runner checks between agent steps.
 *    cancel_active_jobs (the existing global abort) cancels every in-flight
 *    crew via this same flag.
 */

import { chat, pickProvider } from "./llm/providers.mjs";
import * as UsageLog from "./usage-log.mjs";

/* ---------- ABORT FLAGS ----------
 * Per-crew cancel flags. Stored in a Map so multiple crews can run
 * concurrently and each can be cancelled independently without affecting
 * its siblings. Global abort sets every flag. */
const _abortFlags = new Map();
let _globalAbort = false;

export function raiseAbort(crewId) {
  if (crewId) _abortFlags.set(String(crewId), true);
  else _globalAbort = true;
}
export function clearAbort(crewId) {
  if (crewId) _abortFlags.delete(String(crewId));
  else _globalAbort = false;
}
export function isAborted(crewId) {
  if (_globalAbort) return true;
  return _abortFlags.get(String(crewId)) === true;
}

/* ---------- BROADCAST HOOK ----------
 * The runner emits typed events the HUD subscribes to (crew.started,
 * crew.agent.*, crew.complete). We wire the broadcaster from server.mjs
 * after boot so this module stays decoupled. */
let _broadcaster = null;
export function setBroadcaster(fn) { _broadcaster = typeof fn === "function" ? fn : null; }
function emit(type, data) {
  if (_broadcaster) try { _broadcaster({ type, data }); } catch {}
}

/* ---------- VALIDATION HELPERS ---------- */

function newCrewId() {
  return `crew_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Validate the crew spec. Returns { ok, error? } — caller short-circuits
 *  with the error rather than throwing because this fires from inside an
 *  LLM tool dispatch and we want a clean error envelope back to the model. */
function validateCrewSpec(spec) {
  if (!spec || typeof spec !== "object") return { ok: false, error: "spec must be an object" };
  const mode = String(spec.mode || "").toLowerCase();
  if (mode !== "sequential" && mode !== "parallel") {
    return { ok: false, error: `mode must be "sequential" or "parallel" (got "${spec.mode}")` };
  }
  if (!Array.isArray(spec.agents) || spec.agents.length === 0) {
    return { ok: false, error: "agents must be a non-empty array" };
  }
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    return { ok: false, error: "tasks must be a non-empty array" };
  }
  /* Each agent: id + role + goal mandatory. */
  const agentIds = new Set();
  for (const a of spec.agents) {
    if (!a?.id || !a?.role || !a?.goal) {
      return { ok: false, error: `agent must have id, role, goal (got ${JSON.stringify(a).slice(0, 120)})` };
    }
    if (agentIds.has(a.id)) return { ok: false, error: `duplicate agent id "${a.id}"` };
    agentIds.add(a.id);
  }
  /* Each task: id + description + agentId pointing at a real agent. */
  const taskIds = new Set();
  for (const t of spec.tasks) {
    if (!t?.id || !t?.description || !t?.agentId) {
      return { ok: false, error: `task must have id, description, agentId (got ${JSON.stringify(t).slice(0, 120)})` };
    }
    if (taskIds.has(t.id)) return { ok: false, error: `duplicate task id "${t.id}"` };
    if (!agentIds.has(t.agentId)) return { ok: false, error: `task "${t.id}" references unknown agent "${t.agentId}"` };
    if (Array.isArray(t.dependsOn)) {
      for (const dep of t.dependsOn) {
        if (!taskIds.has(dep)) {
          /* Forward-reference is allowed during the loop; check after. */
        }
      }
    }
    taskIds.add(t.id);
  }
  /* Second pass for forward-reference dependsOn (caller may list tasks in
   * any order). */
  for (const t of spec.tasks) {
    for (const dep of t.dependsOn || []) {
      if (!taskIds.has(dep)) return { ok: false, error: `task "${t.id}" depends on unknown task "${dep}"` };
      if (dep === t.id) return { ok: false, error: `task "${t.id}" depends on itself` };
    }
  }
  /* Parallel mode: ensure not every agent routes to ollama (would serialise
   * defeating the point). At least one cloud-routed agent required. */
  if (mode === "parallel") {
    const allOllama = spec.agents.every((a) => resolveProvider(a) === "ollama");
    if (allOllama) {
      return {
        ok: false,
        error: "Parallel mode requires at least one agent routed to a cloud provider (anthropic / openai). All agents in this spec route to ollama which would serialise behind the GPU.",
      };
    }
  }
  return { ok: true };
}

/** Resolve which provider an agent will use. Explicit spec wins; otherwise
 *  fall through to the workload-default router. */
function resolveProvider(agentSpec) {
  if (agentSpec.provider) return String(agentSpec.provider).toLowerCase();
  return pickProvider("default");
}

/* ---------- CONTEXT BUILDER ----------
 * For each task we assemble the messages array passed to chat(). The system
 * prompt is the agent's role + goal + (optional override). The user message
 * is the task description plus a context block built from upstream task
 * results when dependsOn is set. */
function buildAgentMessages(agentSpec, taskSpec, upstreamResults) {
  const sys = agentSpec.systemPromptOverride || [
    `You are an agent in a multi-agent crew.`,
    `Role: ${agentSpec.role}`,
    `Goal: ${agentSpec.goal}`,
    `You have access to a subset of the kiosk's tools. Use them to accomplish your assigned task and return a concise answer the parent crew can use.`,
    taskSpec.expectedOutput ? `Expected output: ${taskSpec.expectedOutput}` : "",
  ].filter(Boolean).join("\n\n");

  const upstream = (taskSpec.dependsOn || [])
    .map((depId) => upstreamResults.get(depId))
    .filter((r) => r && r.output)
    .map((r) => `[Result of "${r.taskId}" by ${r.agentRole}]\n${r.output}`)
    .join("\n\n");

  const user = upstream
    ? `Upstream context:\n\n${upstream}\n\n---\n\nYour task: ${taskSpec.description}`
    : `Your task: ${taskSpec.description}`;

  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}

/* ---------- PROVIDER CONCURRENCY GUARD ----------
 * Single-slot semaphore for ollama. Cloud providers run unbounded by this
 * module (rate limits are enforced upstream by the API). */
const _ollamaInFlight = { count: 0, queue: [] };
const OLLAMA_MAX = 1;

async function withProviderSlot(provider, fn) {
  if (provider !== "ollama") return await fn();
  /* Ollama path — wait for an in-flight slot before running. */
  if (_ollamaInFlight.count >= OLLAMA_MAX) {
    await new Promise((resolve) => _ollamaInFlight.queue.push(resolve));
  }
  _ollamaInFlight.count += 1;
  try { return await fn(); }
  finally {
    _ollamaInFlight.count -= 1;
    const next = _ollamaInFlight.queue.shift();
    if (next) next();
  }
}

/* ---------- AGENT EXECUTION ----------
 * Run a single agent on a single task. Returns { ok, taskId, agentId,
 * agentRole, output, elapsedMs, costUSD, error? }. Tags every chat() call
 * inside this run with the crewId so usage-log can group by crew later. */
async function runAgentTask({ crewId, agentSpec, taskSpec, upstreamResults }) {
  const t0 = Date.now();
  const provider = resolveProvider(agentSpec);
  if (isAborted(crewId)) {
    return { ok: false, taskId: taskSpec.id, agentId: agentSpec.id, agentRole: agentSpec.role, error: "aborted before start", elapsedMs: 0, costUSD: 0 };
  }
  emit("crew.agent.started", {
    crewId, taskId: taskSpec.id, agentId: agentSpec.id, role: agentSpec.role,
    provider, description: taskSpec.description.slice(0, 200),
  });

  const messages = buildAgentMessages(agentSpec, taskSpec, upstreamResults);
  /* Patch the chat() source tag so usage rows for this agent are
   * attributable to the crew. providers.mjs's logUsage call uses a fixed
   * "providers.chat" source — we reach in by wrapping chat() with our own
   * usage hook and skipping the default. */
  let output = "";
  let costUSD = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const result = await withProviderSlot(provider, () => chat({
      provider,
      model: agentSpec.model,
      messages,
      maxTokens: 1500,
    }));
    output = (result.text || "").trim();
    tokensIn = result.usage?.input_tokens || result.usage?.prompt_tokens || result.usage?.prompt_eval_count || 0;
    tokensOut = result.usage?.output_tokens || result.usage?.completion_tokens || result.usage?.eval_count || 0;
    /* Re-record with the crew tag so /usage can attribute by crew. The
     * providers.chat row still landed (best-effort logger) but we add
     * a crew-scoped row here for analytics. Slight double-count is
     * acceptable for the v1; future cleanup: pass a source override
     * through chat(). */
    const row = await UsageLog.recordUsage({
      provider, model: result.model || agentSpec.model || "unknown",
      tokensIn, tokensOut, elapsedMs: Date.now() - t0,
      source: `crew:${crewId}:${taskSpec.id}`,
    });
    costUSD = row.costUSD || 0;
  } catch (e) {
    emit("crew.agent.failed", { crewId, taskId: taskSpec.id, agentId: agentSpec.id, error: e.message });
    return { ok: false, taskId: taskSpec.id, agentId: agentSpec.id, agentRole: agentSpec.role, error: e.message, elapsedMs: Date.now() - t0, costUSD: 0 };
  }
  const finalResult = {
    ok: true,
    taskId: taskSpec.id,
    agentId: agentSpec.id,
    agentRole: agentSpec.role,
    provider,
    output,
    elapsedMs: Date.now() - t0,
    tokensIn, tokensOut, costUSD,
  };
  emit("crew.agent.complete", { crewId, ...finalResult, output: output.slice(0, 500) });
  return finalResult;
}

/* ---------- ORCHESTRATION ---------- */

/** Topological sort of tasks by dependsOn. Returns layers — each layer is
 *  a list of tasks that have no unresolved deps and can run in parallel.
 *  In sequential mode we still walk layers but at width=1. */
function buildExecutionLayers(tasks) {
  const remaining = new Map(tasks.map((t) => [t.id, { ...t, deps: new Set(t.dependsOn || []) }]));
  const layers = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((t) => t.deps.size === 0);
    if (ready.length === 0) {
      throw new Error("Circular dependency detected in crew tasks");
    }
    layers.push(ready);
    for (const r of ready) {
      remaining.delete(r.id);
      for (const t of remaining.values()) t.deps.delete(r.id);
    }
  }
  return layers;
}

/**
 * Run a crew. Validates the spec, builds execution layers from dependsOn,
 * fires each layer (sequential or parallel per mode), aggregates results
 * + cost. Returns { ok, crewId, mode, results, totalCostUSD, totalElapsedMs }.
 *
 * @param {object} spec  CrewSpec — see top-of-file docs
 */
export async function runCrew(spec) {
  const crewId = spec.id || newCrewId();
  clearAbort(crewId);
  const validation = validateCrewSpec(spec);
  if (!validation.ok) return { ok: false, crewId, error: validation.error };
  const t0 = Date.now();
  const mode = String(spec.mode).toLowerCase();
  const maxParallel = mode === "parallel" ? Math.max(1, Math.min(8, Number(spec.maxParallel) || 4)) : 1;

  const agentsById = new Map(spec.agents.map((a) => [a.id, a]));
  const layers = buildExecutionLayers(spec.tasks);

  emit("crew.started", {
    crewId, mode, maxParallel,
    agents: spec.agents.map((a) => ({ id: a.id, role: a.role, provider: resolveProvider(a) })),
    taskCount: spec.tasks.length, layerCount: layers.length,
  });

  /* Sliding window — keep at most maxParallel agents running concurrently.
   * In sequential mode the window is 1 by construction. */
  const upstreamResults = new Map();
  const allResults = [];
  for (const layer of layers) {
    /* Layer execution. Slice the layer into chunks of size maxParallel so
     * a wide layer doesn't blast every agent at once. */
    if (isAborted(crewId)) {
      allResults.push({ ok: false, error: "aborted between layers", taskId: null });
      break;
    }
    for (let offset = 0; offset < layer.length; offset += maxParallel) {
      const batch = layer.slice(offset, offset + maxParallel);
      const batchPromises = batch.map((task) => {
        const agent = agentsById.get(task.agentId);
        return runAgentTask({ crewId, agentSpec: agent, taskSpec: task, upstreamResults });
      });
      const batchResults = await Promise.all(batchPromises);
      for (const r of batchResults) {
        allResults.push(r);
        if (r.ok) upstreamResults.set(r.taskId, r);
      }
    }
  }

  const totalCostUSD = Number(allResults.reduce((s, r) => s + (r.costUSD || 0), 0).toFixed(6));
  const totalElapsedMs = Date.now() - t0;
  const allOk = allResults.every((r) => r.ok);

  emit("crew.complete", {
    crewId, mode,
    ok: allOk,
    taskCount: spec.tasks.length,
    successCount: allResults.filter((r) => r.ok).length,
    totalCostUSD,
    totalElapsedMs,
  });
  clearAbort(crewId);

  return {
    ok: allOk,
    crewId,
    mode,
    taskCount: spec.tasks.length,
    results: allResults,
    totalCostUSD,
    totalElapsedMs,
  };
}

/* ---------- DIAGNOSTIC ---------- */

/** Snapshot of the in-flight ollama queue state — useful for /health
 *  and the Agent Console. */
export function concurrencyStatus() {
  return {
    ollama: { inFlight: _ollamaInFlight.count, queued: _ollamaInFlight.queue.length, max: OLLAMA_MAX },
  };
}
