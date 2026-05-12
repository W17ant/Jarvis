/** call-context.mjs — async-local-storage for per-LLM-call workspace scope.
 *
 *  Why this exists: Workspaces v0–v3 used a single module-level "active
 *  workspace" stored in workspaces.mjs. That works when there's one HUD
 *  window driving the bridge. v4 introduces multi-window kiosks where
 *  each window pins to a different workspace persona — Window 1 is
 *  "Jarvis" in Consulting scope, Window 2 is "Friday" in Personal scope.
 *  When Window 2 sends an llm.askStream message, the bridge needs to
 *  dispatch in *Friday's* scope, not whichever workspace was active
 *  globally.
 *
 *  AsyncLocalStorage is the right primitive: every async chain spawned
 *  inside `withWorkspace(slug, fn)` sees `getCallWorkspace() === slug`,
 *  even across awaits. When the call completes, the override is gone.
 *  Concurrent calls (Window 1's voice and Window 2's voice firing at the
 *  same time) get isolated stores.
 *
 *  Memory.setActiveWorkspaceProvider and Audit.setActiveWorkspaceProvider
 *  are wired in server.mjs to consult getCallWorkspace() FIRST, falling
 *  back to Workspaces.getActive() when no per-call override is in flight.
 *  Result: tool dispatch + memory writes + audit + system prompt
 *  injection all see the calling window's workspace, with zero changes
 *  to the call sites that read the providers.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const _als = new AsyncLocalStorage();

/** Run a function with a workspace pinned for the duration of every async
 *  chain it kicks off. Returns whatever fn returns. Preserves error
 *  semantics — fn rejecting still rejects from the outside. */
export function withWorkspace(slug, fn) {
  if (!slug) return fn();
  return _als.run({ workspace: String(slug).trim().toLowerCase() }, fn);
}

/** Read the per-call workspace slug, or null when no override is in flight. */
export function getCallWorkspace() {
  return _als.getStore()?.workspace || null;
}
