/** test-memory.mjs - End-to-end test of persistent memory.
 *  Two layers:
 *    A) Direct module test — addContact / getContact / recall / saveConversation in process.
 *       Confirms SQLite + Ollama embeddings work and the API contract holds.
 *    B) LLM round-trip — ask Qwen "what's Ben's email" via WS and watch the bridge log
 *       to confirm it selects get_contact (no draft_email here — Mail side effect).
 */

import * as Memory from "../../bridge/memory.mjs";
import WebSocket from "ws";

const BRIDGE_URL = process.env.BRIDGE_URL || "ws://localhost:8766";

function ask(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 90_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "llm.ask", id: "t1", payload: { query } })));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== "t1") return;
        if (msg.type === "llm.ask.reply" || msg.type === "llm.ask.error") {
          clearTimeout(timeout); ws.close(); resolve(msg);
        }
      } catch {}
    });
    ws.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function main() {
  console.log("\n┌── A) DIRECT MODULE TESTS ──");

  console.log("[A1] addContact(Ben Collins) ...");
  let r = await Memory.addContact({
    name: "Ben Collins",
    email: "ben@astonmartin.com",
    company: "Aston Martin",
    role: "Head of Marketing",
    notes: "Prefers email over phone. Worked with us on the Vulcan teaser.",
  });
  console.log("    →", r);
  if (!r.ok) throw new Error("addContact failed");

  console.log("[A2] getContact('Ben Collins') exact match ...");
  r = await Memory.getContact({ name: "Ben Collins" });
  console.log("    →", r);
  if (!r.ok || r.contact.email !== "ben@astonmartin.com") throw new Error("exact lookup failed");

  console.log("[A3] getContact('Ben') partial match ...");
  r = await Memory.getContact({ name: "Ben" });
  console.log("    →", r);
  if (!r.ok) throw new Error("partial lookup failed");

  console.log("[A4] getContact('benn') typo → semantic fallback ...");
  r = await Memory.getContact({ name: "benn collins" });
  console.log("    →", r);

  console.log("[A5] addProject(Vulcan Teaser) ...");
  r = await Memory.addProject({
    name: "Aston Martin Vulcan Teaser 2026",
    client: "Aston Martin",
    status: "in-progress",
    notes: "30s cinematic cut, top-gear style, due Friday. Lead contact: Ben Collins.",
  });
  console.log("    →", r);

  console.log("[A6] remember(stable preference) ...");
  r = await Memory.remember({
    content: "Aston Martin always wants vertical 9:16 cuts delivered alongside the master 16:9.",
    tags: ["aston-martin", "deliverables"],
  });
  console.log("    →", r);

  console.log("[A7] recall('what does aston martin need for deliverables') ...");
  r = await Memory.recall({ query: "what does aston martin need for deliverables", limit: 5 });
  console.log("    →", JSON.stringify(r, null, 2));
  if (!r.ok || r.count === 0) throw new Error("recall returned no results");

  console.log("[A8] saveConversation(...) ...");
  r = await Memory.saveConversation({
    summary: "Operator added Ben Collins as Aston Martin's head of marketing. Confirmed Vulcan teaser deliverables Friday with vertical + horizontal cuts.",
    topics: ["Ben Collins", "Aston Martin", "Vulcan", "deliverables"],
    startedAt: Date.now() - 600_000,
    endedAt: Date.now(),
  });
  console.log("    →", r);

  console.log("[A9] memoryStats() ...");
  console.log("    →", Memory.memoryStats());

  console.log("\n└── B) LLM ROUND-TRIP (single question, watch bridge log for tool selection) ──");
  console.log("[B1] 'What email do we have for Ben Collins?'");
  const reply = await ask("What email address do we have on file for Ben Collins?");
  const text = reply.data?.text || reply.data || reply;
  console.log("    Reply:", typeof text === "string" ? text : JSON.stringify(text).slice(0, 400));
  console.log("    (Check bridge log: should show '[bridge] tool call: get_contact(...)' before this reply.)");

  console.log("\n✓ ALL DIRECT TESTS PASSED");
}

main().catch((e) => { console.error("\n✗ FAIL:", e.message); console.error(e.stack); process.exit(1); });
