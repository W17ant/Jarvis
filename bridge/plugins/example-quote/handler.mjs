/** example-quote handler — reference implementation for the plugin runtime.
 *
 *  The default export receives (toolName, args, ctx) and returns whatever
 *  shape the LLM should consume. ctx exposes the host primitives the plugin
 *  is allowed to call back into:
 *    - ctx.log(...)              — bridge console logging
 *    - ctx.memory                — bridge/memory.mjs (recall, save_fact, etc.)
 *    - ctx.executeTool(n, a)     — call ANY other registered tool (built-in
 *                                   or plugin); confirmation + audit gates
 *                                   apply transparently.
 *    - ctx.broadcastToClients(m) — push WS event to the HUD
 *
 *  Plugins that need network or filesystem should call those APIs directly —
 *  Node has no per-module sandbox, so we lean on the operator-trusted
 *  filesystem rather than runtime isolation. The audit log captures every
 *  tool call regardless of whether it's a plugin or built-in.
 */

const QUOTES = [
  { text: "Premature optimization is the root of all evil.", author: "Donald Knuth" },
  { text: "There are only two hard things in Computer Science: cache invalidation and naming things.", author: "Phil Karlton" },
  { text: "Talk is cheap. Show me the code.", author: "Linus Torvalds" },
  { text: "Simplicity is prerequisite for reliability.", author: "Edsger Dijkstra" },
  { text: "The best error message is the one that never shows up.", author: "Thomas Fuchs" },
  { text: "Make it work, make it right, make it fast.", author: "Kent Beck" },
  { text: "If you don't have time to do it right, when will you have time to do it over?", author: "John Wooden" },
  { text: "Walking on water and developing software from a specification are easy if both are frozen.", author: "Edward Berard" },
  { text: "Programs must be written for people to read, and only incidentally for machines to execute.", author: "Hal Abelson" },
  { text: "It's not a bug — it's an undocumented feature.", author: "Anonymous" },
];

export default async function handle(toolName, args, ctx) {
  if (toolName !== "random_quote") {
    return { error: `example-quote does not handle tool: ${toolName}` };
  }
  const q = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  ctx?.log?.(`served random_quote → "${q.text.slice(0, 40)}…" — ${q.author}`);
  return {
    ok: true,
    quote: q.text,
    author: q.author,
    /* The LLM will read this back to the operator; format it as a complete
     * sentence so the TTS sounds natural. */
    summary: `${q.text} — ${q.author}`,
  };
}
