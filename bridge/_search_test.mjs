/** _search_test.mjs - smoke test the web_search tool path */
import WS from "ws";
const ws = new WS("ws://localhost:8766");
ws.on("open", () => ws.send(JSON.stringify({
  id: "1", type: "llm.ask",
  payload: { query: "what is the Aston Martin Vulcan AMR Pro? Search the web for the latest info." }
})));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "stats") return;
  console.log("[" + m.type + "]", JSON.stringify(m.data || m.error).slice(0, 800));
  ws.close(); process.exit(0);
});
setTimeout(() => { console.log("timeout"); process.exit(1); }, 90000);
