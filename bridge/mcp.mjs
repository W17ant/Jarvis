/** mcp.mjs - Model Context Protocol server endpoint.
 *
 *  Why: every Flat-Out tool (caption_shoot_folder, draft_email, video_edit_from_shoot,
 *  remember, get_contact, …) is already callable via the bridge's WebSocket. Exposing
 *  them through MCP means Claude Desktop, Claude Code, Cursor, Continue, and any other
 *  MCP host can drive the same kiosk capabilities — turning the bridge into a shared
 *  agency utility instead of a single-HUD endpoint.
 *
 *  Transport: JSON-RPC 2.0 over a single HTTP POST endpoint (the simplest of the MCP
 *  transports — no SSE channel needed for tools-only servers since we don't push
 *  notifications). The client sends one request, gets one response. The bridge stays
 *  stateless across MCP calls (no session tracking) which matches the no-auth, single-
 *  operator, localhost-only deployment model.
 *
 *  Wired up by server.mjs at `POST /mcp`. Server passes in `tools` (the existing TOOLS
 *  array) + `executeTool` so we don't duplicate the tool registry / dispatch logic.
 *
 *  Out of scope for v1: prompts/list, resources/list, sampling, server-initiated
 *  notifications. Add those when an MCP host actually asks for them — the current
 *  Anthropic+Cursor+Continue trio only need tools.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "flat-out-bridge", version: "1.0.0" };

/** Build the MCP-shaped tools list from the bridge's TOOLS array. The bridge stores
 *  tools as { type:"function", function:{ name, description, parameters } } (OpenAI
 *  shape, since that's what Ollama's tool-calling expects). MCP wants flat
 *  { name, description, inputSchema }. */
function bridgeToolsToMcp(bridgeTools) {
  return (bridgeTools || []).map((t) => ({
    name: t.function?.name || t.name,
    description: t.function?.description || t.description || "",
    inputSchema: t.function?.parameters || t.parameters || { type: "object", properties: {} },
  }));
}

/** Wrap an executeTool result for MCP. MCP expects `{ content: [...], isError: bool }`.
 *  Tools that already return clean { ok: true, ...data } get serialised as JSON text;
 *  errors land with isError:true and the message extracted. Confirmation-required
 *  responses (`{ requires_confirmation: "...", hint: "..." }`) pass through as text
 *  content — the MCP host's UI is responsible for surfacing them to the operator. */
function wrapToolResult(result) {
  if (result && typeof result === "object" && result.error) {
    return {
      content: [{ type: "text", text: String(result.error) }],
      isError: true,
    };
  }
  /* Stringify the result. Most tools return structured data; the MCP host can parse
   * the JSON if it wants to surface specific fields. Cap at 16KB so a runaway tool
   * doesn't blow up the host's context window. */
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2).slice(0, 16384);
  return { content: [{ type: "text", text }], isError: false };
}

/** Build a JSON-RPC error response with the given code + message. */
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error: err };
}

/** Build a JSON-RPC success response. */
function rpcOk(id, result) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

/**
 * Handle a single JSON-RPC envelope.
 *
 * @param {object} req                 the incoming JSON-RPC request body
 * @param {object} ctx                 server-supplied dependencies
 * @param {Array}  ctx.tools           the bridge's TOOLS array
 * @param {Function} ctx.executeTool   async (name, args) => result
 * @returns {Promise<object|null>}     JSON-RPC response, or null for notifications
 */
export async function handleMcpRpc(req, ctx) {
  /* JSON-RPC notifications have no `id` field and the server MUST NOT respond. */
  const isNotification = !("id" in req);

  if (req.jsonrpc !== "2.0") {
    return isNotification ? null : rpcError(req.id, -32600, "invalid request: jsonrpc must be '2.0'");
  }
  const method = req.method;
  if (typeof method !== "string") {
    return isNotification ? null : rpcError(req.id, -32600, "invalid request: method missing");
  }

  try {
    switch (method) {
      case "initialize": {
        return rpcOk(req.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            /* listChanged: we don't currently push notifications when the tool list mutates
             * (it's static at boot), so listChanged stays false. Hosts re-list on demand. */
            tools: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
          /* instructions: a one-liner the host shows to the LLM/operator so they know
           * what this server is for. Helps when multiple MCP servers are registered. */
          instructions: "Flat-Out kiosk tools — automotive PR/content agency assistant. Provides shoot management, video editing, vision/captioning, calendar, mail, Frame.io, Premiere, Lightroom, and persistent memory operations against the operator's local Mac.",
        });
      }

      case "notifications/initialized":
        /* Spec-mandated notification from the client after a successful initialize.
         * No response — the `if (isNotification)` branch will swallow it before we
         * ever get here, but it's fine to handle it explicitly too. */
        return null;

      case "tools/list": {
        return rpcOk(req.id, { tools: bridgeToolsToMcp(ctx.tools) });
      }

      case "tools/call": {
        const params = req.params || {};
        const name = params.name;
        const args = params.arguments || {};
        if (!name || typeof name !== "string") {
          return rpcError(req.id, -32602, "params.name (tool name) is required");
        }
        let result;
        try {
          result = await ctx.executeTool(name, args);
        } catch (e) {
          /* Tool execution failures are still well-formed JSON-RPC responses with
           * isError:true — only protocol-level problems use rpcError. */
          return rpcOk(req.id, wrapToolResult({ error: String(e.message || e) }));
        }
        return rpcOk(req.id, wrapToolResult(result));
      }

      /* Empty stubs for the unimplemented capabilities. We declared `tools` only in
       * initialize.capabilities, so a well-behaved client shouldn't call these — but
       * answering -32601 cleanly lets misbehaving clients self-recover. */
      case "prompts/list":
        return rpcOk(req.id, { prompts: [] });
      case "resources/list":
        return rpcOk(req.id, { resources: [] });
      case "ping":
        return rpcOk(req.id, {});

      default:
        if (isNotification) return null;
        return rpcError(req.id, -32601, `method not found: ${method}`);
    }
  } catch (e) {
    /* Last-resort handler — catches any throw from the switch arms and converts to a
     * JSON-RPC internal-error so the client doesn't get a half-written response. */
    if (isNotification) return null;
    return rpcError(req.id, -32603, `internal error: ${e.message || e}`);
  }
}
