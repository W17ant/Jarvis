/** _subject_test.mjs - verify subject extraction + RS6 cache hit (no Fal cost). */
import WS from "ws";

const ws = new WS("ws://localhost:8766");
const queries = [
  "Flat-Out, create a 30 second video for Instagram from yesterday's shoot",
  "Flat-Out, make a teaser of the batmobile",
  "Flat-Out, create a video of an ice cream van for stories",
  "Flat-Out, build a 30s reel from yesterday's Aston Martin DBX shoot",
  "Flat-Out, generate a teaser featuring a vintage Land Rover Defender",
];
let pending = queries.length;
const tStart = Date.now();

ws.on("open", () => {
  queries.forEach((q, i) => {
    ws.send(JSON.stringify({ id: `t-${i}`, type: "extract.subject", payload: { query: q } }));
  });
});

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "stats") return;
  if (m.type === "extract.subject.reply") {
    const i = parseInt(m.id.slice(2));
    const dt = ((Date.now() - tStart) / 1000).toFixed(1);
    console.log(`[+${dt}s] "${queries[i]}"\n   → subject: "${m.data.subject}"\n`);
    if (--pending === 0) { ws.close(); process.exit(0); }
  }
});

setTimeout(() => { console.log("timeout"); process.exit(1); }, 90000);
