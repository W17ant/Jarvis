/** undo.mjs - Per-process undo stack for destructive tool dispatches.
 *
 *  Why: voice misfires happen — "skip this" misheard as "keep this", a clearance
 *  revoked for the wrong client, a flag tagged on the wrong shot. The architect's
 *  P2.3 plan: inverse-action recipes for destructive tools, scoped narrowly so we
 *  don't try to undo a video render or a sent email.
 *
 *  Stack is in-memory, capped at 8 entries, FIFO-evicted. Survives bridge process
 *  lifetime; on restart the stack is empty (acceptable — undo is a "few seconds
 *  ago" affordance, not a transaction log).
 *
 *  An inverse recipe is just:
 *    { description: "human-readable summary",
 *      run: async () => { ... } }   // returns { ok: true } / { ok: false, error }
 *
 *  Tools register themselves via push(...) AFTER their forward run succeeds.
 *  The undo_last tool pops the most-recent recipe + runs it. */

const STACK_LIMIT = 8;
const stack = [];   /* { description, run, pushedAt } */

export function push(recipe) {
  if (!recipe || typeof recipe.run !== "function") return;
  stack.push({ ...recipe, pushedAt: Date.now() });
  if (stack.length > STACK_LIMIT) stack.shift();
}

export function peek() {
  return stack.length ? { description: stack[stack.length - 1].description, age: Date.now() - stack[stack.length - 1].pushedAt } : null;
}

/** Pop the most-recent recipe and run its inverse. Returns the inverse's result
 *  prefixed with the description so the LLM can confirm it back to the operator. */
export async function pop() {
  if (stack.length === 0) {
    return { ok: false, error: "Nothing to undo." };
  }
  const recipe = stack.pop();
  try {
    const result = await recipe.run();
    return { ok: true, undid: recipe.description, result };
  } catch (e) {
    /* If the inverse itself fails, push the recipe back on so the operator can retry. */
    stack.push(recipe);
    return { ok: false, undid: recipe.description, error: String(e?.message || e) };
  }
}

/** Clear the stack — used when starting a fresh conversation or on demand. */
export function clear() { stack.length = 0; }

/** Inspect — for the audit log + future HUD undo toast. */
export function size() { return stack.length; }
