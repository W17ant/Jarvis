/** code-agent.mjs - Smolagents-style escape hatch.
 *
 *  The LLM hits limits when a workflow needs novel composition the static
 *  tool catalogue doesn't cover ("for each shoot folder modified today,
 *  generate a contact sheet then post the cheapest result to Frame.io").
 *  CodeAgent gives the LLM a way to write a small async JS function that
 *  composes tool calls, with full looping / branching / variable scoping —
 *  the same things tool-calling-via-JSON struggles to express.
 *
 *  Three guarantees:
 *
 *    1. Sandbox isolation. User code runs in a worker_threads child,
 *       inside a vm.createContext with an explicit allowlist of globals.
 *       No fs / process / require / network — only `tools` (proxy) +
 *       `console` (captured) + safe JS builtins.
 *
 *    2. Hard timeout. Worker.terminate() kills runaway loops including
 *       async hangs (vm's own timeout only stops sync code). Default 30s,
 *       configurable per call up to 120s cap.
 *
 *    3. Audit trail. Every code_agent_run lands in data/code-agent-log.jsonl
 *       with the code snippet, allowedTools, result, elapsed. Operator
 *       can review what the LLM actually executed.
 *
 *  Confirmation gate: ALWAYS. Code execution is the highest-trust thing
 *  the LLM can do; a malformed bit of LLM-generated JS could touch
 *  every confirmation-gated tool the operator allowed via allowedTools.
 *  NEEDS_CONFIRMATION wraps it so the operator hears the snippet
 *  summarised before "yes/go ahead" approves the run.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
/* Pass the worker as a file:// URL rather than a path string — under
 * --input-type=module the Worker constructor can mistake a path for an
 * eval string. URL form is unambiguous. */
const WORKER_URL = new URL("./code-agent-worker.mjs", import.meta.url);
const LOG_PATH = path.join(PROJECT_DIR, "data", "code-agent-log.jsonl");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_CODE_LENGTH = 16_000;

/* ---------- TOOL DISPATCH HOOK ----------
 * server.mjs hands us the executeTool function at boot. We call into it
 * for every tools.* invocation the user code makes. Kept as a module
 * variable rather than an import to avoid a circular dependency. */
let _executeTool = null;
export function setToolExecutor(fn) { _executeTool = typeof fn === "function" ? fn : null; }

/* ---------- BROADCAST HOOK ---------- */
let _broadcaster = null;
export function setBroadcaster(fn) { _broadcaster = typeof fn === "function" ? fn : null; }
function emit(type, data) { if (_broadcaster) try { _broadcaster({ type, data }); } catch {} }

/** Append one row to the audit log. Best-effort — never throws. */
async function appendAudit(entry) {
  try {
    await fsp.mkdir(path.dirname(LOG_PATH), { recursive: true });
    await fsp.appendFile(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) { console.warn(`[code-agent] audit append failed: ${e.message}`); }
}

/**
 * Run user-supplied JS code in a sandboxed worker. Returns a structured
 * envelope the LLM can read or speak from.
 *
 * @param {object} args
 * @param {string} args.code           User-authored JS, executed as the body
 *                                     of an async IIFE. May `return value`
 *                                     and use top-level await.
 * @param {string[]} [args.allowedTools]  Tool name allowlist. Empty/null →
 *                                     all tools available. Recommended:
 *                                     LLM specifies the minimal set.
 * @param {number} [args.timeoutMs=30000] Hard timeout. Capped at 120000.
 * @param {string} [args.purpose]      Free-form description for the audit
 *                                     log. Optional.
 */
export async function runCode({ code, allowedTools = null, timeoutMs = DEFAULT_TIMEOUT_MS, purpose = null } = {}) {
  if (!_executeTool) return { ok: false, error: "code agent not initialised: setToolExecutor was never called" };
  if (typeof code !== "string" || !code.trim()) return { ok: false, error: "code (string) is required" };
  if (code.length > MAX_CODE_LENGTH) return { ok: false, error: `code exceeds ${MAX_CODE_LENGTH}-char cap (got ${code.length})` };
  const cap = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  /* Empty / null allowedTools = NO tools available. Forces the LLM to
   * enumerate the surface it needs; removes the "undefined = allow all"
   * footgun where a missing field accidentally grants full tool access.
   * The tool spec already requires the field; this is defence-in-depth. */
  const allowSet = Array.isArray(allowedTools) ? new Set(allowedTools) : new Set();

  const runId = `code_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const t0 = Date.now();
  const toolCallsLog = [];

  emit("code-agent.started", { runId, codeLength: code.length, allowedTools: [...allowSet], timeoutMs: cap, purpose });

  const result = await new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: { code, timeoutMs: cap },
        /* No stdout/stderr piping — we capture inside the worker via the
         * sandboxConsole so output is structured + bounded. */
      });
    } catch (e) {
      resolve({ ok: false, error: `worker spawn failed: ${e.message}` });
      return;
    }

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { worker.terminate(); } catch {}
      resolve({ ok: false, error: `code execution timed out after ${cap}ms`, timedOut: true });
    }, cap);

    worker.on("message", async (msg) => {
      if (msg.type === "tool") {
        /* Tool call from sandbox. Validate against the allowlist, dispatch,
         * post the result back. Errors come back as the rejection of the
         * user code's `await tools.X(...)`. */
        let toolResult, toolError;
        if (!allowSet.has(msg.name)) {
          toolError = `tool "${msg.name}" not in allowedTools`;
        } else {
          try { toolResult = await _executeTool(msg.name, msg.args || {}); }
          catch (e) { toolError = String(e.message || e); }
        }
        toolCallsLog.push({ name: msg.name, args: msg.args, ok: !toolError });
        emit("code-agent.tool", { runId, name: msg.name, ok: !toolError });
        try { worker.postMessage({ type: "tool.result", id: msg.id, result: toolResult, error: toolError }); }
        catch { /* worker may have terminated — ignore */ }
      }
      if (msg.type === "done") {
        clearTimeout(timer);
        if (!killed) {
          try { worker.terminate(); } catch {}
          resolve({
            ok: msg.ok,
            returnValue: msg.result,
            stdout: msg.stdout || [],
            stderr: msg.stderr || [],
            error: msg.error || null,
            stack: msg.stack || null,
          });
        }
      }
    });

    worker.on("error", (e) => {
      clearTimeout(timer);
      if (!killed) {
        try { worker.terminate(); } catch {}
        resolve({ ok: false, error: `worker errored: ${e.message}` });
      }
    });
    /* Worker exit before "done" — usually means a fatal sandbox-level
     * failure (e.g. vm.runInContext itself threw). We resolve with what
     * we have. */
    worker.on("exit", (code) => {
      clearTimeout(timer);
      if (!killed) resolve({ ok: false, error: `worker exited with code ${code} before completion` });
    });
  });

  const elapsedMs = Date.now() - t0;
  const auditRow = {
    ts: t0,
    iso: new Date(t0).toISOString(),
    runId,
    purpose,
    codeLength: code.length,
    codePreview: code.slice(0, 600),     /* full code in a separate field for size budget */
    code,
    allowedTools: [...allowSet],
    timeoutMs: cap,
    elapsedMs,
    ok: result.ok,
    returnValue: result.returnValue ?? null,
    stdout: result.stdout || [],
    stderr: result.stderr || [],
    error: result.error || null,
    timedOut: !!result.timedOut,
    toolCallCount: toolCallsLog.length,
    toolCalls: toolCallsLog,
  };
  await appendAudit(auditRow);
  emit("code-agent.complete", {
    runId, ok: result.ok, elapsedMs,
    toolCallCount: toolCallsLog.length,
    error: result.error || null,
  });

  return {
    ok: result.ok,
    runId,
    returnValue: result.returnValue ?? null,
    stdout: result.stdout || [],
    stderr: result.stderr || [],
    error: result.error || null,
    timedOut: !!result.timedOut,
    elapsedMs,
    toolCallCount: toolCallsLog.length,
    toolCalls: toolCallsLog.map((t) => t.name),
  };
}

/** Read recent audit rows for the Agent Console. Newest first. */
export async function recentRuns({ limit = 20 } = {}) {
  try {
    const raw = await fsp.readFile(LOG_PATH, "utf8");
    const rows = raw.split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return rows.slice(-Math.max(1, Math.min(200, limit))).reverse();
  } catch { return []; }
}
