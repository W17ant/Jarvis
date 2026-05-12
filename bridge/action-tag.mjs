/** action-tag.mjs - defensive parser for `[ACTION:tool_name {...args}]`
 *  literal tags occasionally emitted by Qwen2.5 instead of clean function-
 *  call envelopes.
 *
 *  Why: Qwen's tool-call output is generally clean, but under specific
 *  conditions (long streams, after a tool error, long context with many
 *  tool definitions) the model occasionally falls back to inline literal
 *  action syntax instead of a structured tool_calls array. Without a
 *  parser, that text gets read aloud verbatim and the tool never fires.
 *
 *  Cousin pattern: ethanplusai/jarvis uses `[ACTION:X]` tags as their
 *  PRIMARY tool-call surface. We use OpenAI-style structured tool_calls
 *  as primary; this is purely the belt-and-braces fallback for when the
 *  model decides to be creative.
 *
 *  Tags supported:
 *    `[ACTION:tool_name]`                       - no args
 *    `[ACTION:tool_name {"key":"value"}]`       - JSON args
 *    `[ACTION:tool_name key=value]`             - simple kv (single-arg)
 *
 *  Returns:
 *    { stripped: string, calls: Array<{ name, args }> }
 *
 *  Where stripped is the text with every recognised tag removed (so it
 *  never gets spoken aloud), and calls is the list of parsed actions in
 *  the order they appeared. The dispatcher fires them through the same
 *  tool-call path the structured tool_calls take.
 */

const TAG_RE = /\[ACTION:\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{[^}]*\}|\s+[^\]]+)?\s*\]/g;

/** Parse text for action tags. Pure - doesn't dispatch. */
export function parse(text) {
  if (typeof text !== "string" || !text.includes("[ACTION:")) {
    return { stripped: text, calls: [] };
  }
  const matches = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    matches.push({ start: m.index, end: m.index + m[0].length, name: m[1], rawArgs: m[2] || "" });
  }
  if (!matches.length) return { stripped: text, calls: [] };

  let cursor = 0;
  const parts = [];
  const calls = [];
  for (const match of matches) {
    if (match.start > cursor) parts.push(text.slice(cursor, match.start));
    cursor = match.end;
    let args = {};
    const raw = match.rawArgs.trim();
    if (raw) {
      if (raw.startsWith("{")) {
        try { args = JSON.parse(raw); } catch { args = null; }
      } else {
        args = {};
        for (const kv of raw.split(/\s+/)) {
          const eq = kv.indexOf("=");
          if (eq > 0) {
            const k = kv.slice(0, eq).trim();
            const v = kv.slice(eq + 1).trim();
            if (k) args[k] = v;
          }
        }
      }
    }
    if (args !== null) {
      calls.push({ name: match.name, args });
    }
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return {
    stripped: parts.join("").replace(/\s{2,}/g, " ").trim(),
    calls,
  };
}
