/** code-agent-worker.mjs - Sandboxed runtime for LLM-authored JS.
 *
 *  Loaded by bridge/code-agent.mjs as a worker_threads child. Runs the
 *  operator-confirmed LLM-generated code in a Node `vm` context that only
 *  exposes a `tools` proxy + `console` + safe builtins. Tool calls round-
 *  trip via postMessage to the main thread which dispatches via the
 *  bridge's executeTool. The user code looks synchronous-async to itself
 *  ("await tools.list_shoots()") but the actual dispatch happens in the
 *  parent process.
 *
 *  Why a separate worker rather than vm.runInContext on the main thread:
 *  worker isolation means a runaway loop or infinite recursion can be
 *  killed via worker.terminate() without taking down the bridge. The vm
 *  context's own `timeout` option only stops synchronous code; async
 *  loops await tools.* forever otherwise. terminate() handles both.
 *
 *  Why no fs / network / process access in the sandbox:
 *  - The tools surface IS the file/network/process access. Tools come
 *    with their own confirmation gates and rails (run_shell, write_file).
 *  - Direct fs/network would let the LLM bypass NEEDS_CONFIRMATION.
 *  - Audit trail: every external action goes through the tool dispatch
 *    log; direct access wouldn't.
 */

import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";

/* ---------- OUTPUT CAPTURE ---------- */
const stdout = [];
const stderr = [];

function stringify(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); }
  catch { return String(v); }
}

const sandboxConsole = {
  log:   (...args) => { if (stdout.length < 500) stdout.push(args.map(stringify).join(" ")); },
  error: (...args) => { if (stderr.length < 500) stderr.push(args.map(stringify).join(" ")); },
  warn:  (...args) => { if (stderr.length < 500) stderr.push("[warn] " + args.map(stringify).join(" ")); },
  info:  (...args) => { if (stdout.length < 500) stdout.push(args.map(stringify).join(" ")); },
  debug: (...args) => { if (stdout.length < 500) stdout.push("[debug] " + args.map(stringify).join(" ")); },
};

/* ---------- TOOL PROXY ----------
 * LLM code calls tools.<name>(args). We turn each such call into a
 * postMessage round-trip to the main thread, which dispatches via
 * executeTool and posts the result back. The promise resolves when
 * the result message arrives.
 */
const _pending = new Map();
let _nextCallId = 0;

const toolsProxy = new Proxy({}, {
  get(_, name) {
    if (typeof name !== "string") return undefined;
    /* Special-case Symbol.iterator etc — avoid throwing on prototype lookups. */
    if (name === "then" || name === "constructor" || name === "toString") return undefined;
    return (args = {}) => {
      const id = ++_nextCallId;
      return new Promise((resolve, reject) => {
        _pending.set(id, { resolve, reject });
        parentPort.postMessage({ type: "tool", id, name, args });
      });
    };
  },
});

parentPort.on("message", (msg) => {
  if (msg.type === "tool.result") {
    const cb = _pending.get(msg.id);
    if (!cb) return;
    _pending.delete(msg.id);
    if (msg.error) cb.reject(new Error(msg.error));
    else cb.resolve(msg.result);
  }
});

/* ---------- SANDBOX CONTEXT ----------
 * Whitelist approach: explicitly enumerate what the LLM code can see.
 * Anything not in this object is undefined inside the vm context. The
 * builtins below are the standard JS surface — Math, Date, JSON, etc —
 * minus anything that touches I/O (no fs, no net, no process). */
const sandbox = {
  tools: toolsProxy,
  console: sandboxConsole,
  /* Standard JS values. */
  JSON, Math, Date,
  Promise, Array, Object, String, Number, Boolean, Symbol,
  Error, TypeError, RangeError, SyntaxError,
  Map, Set, WeakMap, WeakSet,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  /* Async helpers. setTimeout is essential — without it the LLM can't
   * write polling loops or rate-limit its own tool calls. clearTimeout
   * mirrors. We do NOT expose setInterval — too easy to leak. */
  setTimeout, clearTimeout,
};

const ctx = vm.createContext(sandbox);

/* ---------- EXECUTION ----------
 * Wrap the user code in an async IIFE so they can `return value` to
 * provide a result + use top-level await. The whole IIFE is run in the
 * vm context with displayErrors so SyntaxError messages are useful. */
(async () => {
  const wrapped = `(async () => {\n${workerData.code}\n})()`;
  let result;
  try {
    result = await vm.runInContext(wrapped, ctx, {
      /* No `timeout` option — vm's sync timeout doesn't help with async
       * hangs anyway; the parent's worker.terminate() handles those. */
      displayErrors: true,
      filename: "user-code.js",
    });
  } catch (e) {
    parentPort.postMessage({
      type: "done",
      ok: false,
      error: e.message,
      stack: e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : null,
      stdout, stderr,
    });
    return;
  }
  /* Result must be JSON-serialisable to cross the worker boundary. If the
   * user returned a function, undefined, etc, coerce sensibly. */
  let returnValue = result;
  try { returnValue = JSON.parse(JSON.stringify(result === undefined ? null : result)); }
  catch { returnValue = String(result); }
  parentPort.postMessage({ type: "done", ok: true, result: returnValue, stdout, stderr });
})();
