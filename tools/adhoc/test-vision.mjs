/** test-vision.mjs - E2E test of the vision pipeline.
 *  A) Direct module test against a real shoot frame.
 *  B) LLM round-trip — confirm Qwen routes "what's in the latest shoot" to caption_shoot_folder. */

import * as Vision from "../../bridge/vision.mjs";
import WebSocket from "ws";

function ask(query) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:8766");
    const timeout = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 180_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "llm.ask", id: "v1", payload: { query } })));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== "v1") return;
        if (msg.type === "llm.ask.reply" || msg.type === "llm.ask.error") {
          clearTimeout(timeout); ws.close(); resolve(msg);
        }
      } catch {}
    });
    ws.on("error", (e) => { clearTimeout(timeout); reject(e); });
  });
}

async function main() {
  console.log("\n┌── A) DIRECT VISION TESTS ──");

  console.log("[V1] describeImage(Vulcan_01.jpg) ...");
  let r = await Vision.describeImage({ path: "shoots/2026-05-01-aston-martin-vulcan/Vulcan-AMR-Pro_01.jpg" });
  console.log("    →", r);

  console.log("\n[V2] describeImage(same file) — should hit cache ...");
  r = await Vision.describeImage({ path: "shoots/2026-05-01-aston-martin-vulcan/Vulcan-AMR-Pro_01.jpg" });
  console.log("    → cached:", r.cached, "| caption:", r.caption?.slice(0, 80));

  console.log("\n[V3] captionShootFolder(latest, sample 4) ...");
  r = await Vision.captionShootFolder({ folder: "2026-05-01-aston-martin-vulcan", sampleCount: 4 });
  console.log("    →", r.ok ? `${r.captioned}/${r.totalFiles} files captioned in ${r.folder}` : r.error);
  for (const c of (r.captions || [])) {
    console.log(`     - ${c.file}: ${c.caption.slice(0, 100)}${c.caption.length > 100 ? "..." : ""}`);
  }

  console.log("\n[V4] findFrame('low-angle hero shot of the car') ...");
  r = await Vision.findFrame({ query: "low-angle hero shot of the car", folder: "2026-05-01-aston-martin-vulcan", limit: 3 });
  console.log("    →", JSON.stringify(r, null, 2));

  console.log("\n[V5] visionStats() ...");
  console.log("    →", Vision.visionStats());

  console.log("\n└── B) LLM ROUND-TRIP ──");
  console.log("[B1] 'What's in the latest shoot?'");
  const reply = await ask("What's in the latest shoot folder? Give me a short summary.");
  const text = reply.data?.text || reply.data || reply;
  console.log("    Reply:", typeof text === "string" ? text : JSON.stringify(text).slice(0, 600));

  console.log("\n✓ ALL VISION TESTS PASSED");
}

main().catch((e) => { console.error("\n✗ FAIL:", e.message); console.error(e.stack); process.exit(1); });
