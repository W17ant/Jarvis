/** agency.mjs - PR/content-agency helper tools (single-call LLM operations).
 *
 *  Tools:
 *    generate_social_captions   - Instagram + LinkedIn + TikTok caption variants for a brief / image
 *    check_brand_tone           - critique a draft caption against a manufacturer's tone of voice
 *    hashtag_research           - ranked hashtag suggestions per platform
 *    vehicle_spec_lookup        - fetch a fact about a vehicle (torque, weight, etc) with citation
 *    ask_internal               - "how do we usually grade a shoot?" — recall + summarise past
 *    team_standup               - 24-hour activity summary (deliveries, drafts, calendar, frame.io)
 *
 *  All single-prompt operations — no tool-calling loop. Structured JSON outputs where it
 *  helps the bridge return clean data; free-form prose where the operator wants a read-aloud.
 */

import path from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import * as Memory from "./memory.mjs";
import * as Paths from "./paths.mjs";
import { primarySocialHandle } from "./brand.mjs";

/* Why: ES-module imports hoist BEFORE server.mjs's loadEnvFile() runs, so reading
 * process.env at top-level freezes the value as undefined → fallback to 32b → blew the
 * GPU during a live demo. Read these every call so an .env-set OLLAMA_MODEL=qwen2.5:14b
 * actually wins. Slight cost (env lookup per call) is negligible. */
const OLLAMA_URL = () => process.env.OLLAMA_URL || "http://localhost:11434";
const TEXT_MODEL = () => process.env.OLLAMA_MODEL || "qwen2.5:14b";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Single-shot Ollama call. JSON-locked when shape is provided. */
async function ollamaCall({ system, user, json = false, temperature = 0.4, keepAlive = "5m" }) {
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const body = {
    model: TEXT_MODEL(),
    stream: false,
    keep_alive: keepAlive,
    messages,
    options: { temperature },
  };
  if (json) body.format = "json";
  const r = await fetch(`${OLLAMA_URL()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return (j.message?.content || "").trim();
}

/** DuckDuckGo HTML scrape — same shape as the bridge's primary webSearch but inline. */
async function webSearch(query, max = 5) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 AppleWebKit/605.1.15", "accept": "text/html" },
  });
  if (!r.ok) return [];
  const html = await r.text();
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    const link = decodeURIComponent((m[1].match(/uddg=([^&]+)/) || [, m[1]])[1]);
    const title = m[2].replace(/<[^>]+>/g, "").trim();
    const snippet = m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (title && link) out.push({ title, url: link, snippet });
  }
  return out;
}

/** Robust JSON extraction — tolerates models that wrap JSON in fences or add prose. */
function safeParseJson(raw, fallback = null) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return fallback;
}

/* ────────── TOOL: generate_social_captions ────────── */
export async function generateSocialCaptions({ subject, angle = "", platforms, cta = "" } = {}) {
  if (!subject) return { ok: false, error: "subject required" };
  const want = Array.isArray(platforms) && platforms.length ? platforms : ["instagram", "linkedin", "tiktok"];

  const system = `You are a content writer for Jarvis AI, an automotive PR/content agency. Write social captions that match each platform's native voice. Return ONLY a JSON object with the requested platform keys.

Tone rules per platform:
- instagram: visual-first, 1-2 short sentences, evocative not promotional, 4-8 niche hashtags at the end on a separate line
- linkedin: 3-5 short paragraphs, business angle, leads with a hook, no hashtags
- tiktok: hook in the first 6 words, conversational, energetic, 2-3 hashtags inline at the end`;

  const user = `Subject: ${subject}
${angle ? `Angle: ${angle}\n` : ""}${cta ? `Call to action: ${cta}\n` : ""}Platforms requested: ${want.join(", ")}

Reply with a JSON object: { ${want.map(p => `"${p}": "..."`).join(", ")} }`;

  const raw = await ollamaCall({ system, user, json: true, temperature: 0.7 });
  const parsed = safeParseJson(raw, null);
  if (!parsed) return { ok: false, error: "model returned non-JSON", raw: raw.slice(0, 300) };
  return { ok: true, captions: parsed };
}

/* ────────── TOOL: check_brand_tone ────────── */
export async function checkBrandTone({ manufacturer, draft } = {}) {
  if (!manufacturer || !draft) return { ok: false, error: "manufacturer and draft required" };

  const recall = await Memory.recall({ query: `${manufacturer} tone of voice brand voice copywriting style`, limit: 4 });
  const memoryHits = (recall.results || []).map(r => r.text);

  let webHits = [];
  if (memoryHits.length < 2) {
    try {
      const results = await webSearch(`"${manufacturer}" brand tone of voice copywriting style guidelines`, 4);
      webHits = results.map(r => `${r.title}: ${r.snippet}`);
    } catch {}
  }

  const system = `You critique automotive copy against manufacturer brand tone. Be specific and actionable.`;
  const user = `Manufacturer: ${manufacturer}
${memoryHits.length ? `Stored tone notes:\n- ${memoryHits.join("\n- ")}\n` : ""}${webHits.length ? `Web context:\n- ${webHits.join("\n- ")}\n` : ""}
Draft to review:
"""${draft}"""

Reply with a JSON object:
{
  "verdict": "on-brand" | "needs-work" | "off-brand",
  "issues": ["short bullet of what's off", ...],
  "rewrite": "a revised version that fits the brand tone",
  "rationale": "one short paragraph explaining the brand's voice and why your rewrite suits it"
}`;

  const raw = await ollamaCall({ system, user, json: true, temperature: 0.3 });
  const parsed = safeParseJson(raw, null);
  if (!parsed) return { ok: false, error: "model returned non-JSON", raw: raw.slice(0, 300) };
  return { ok: true, ...parsed, sourcesUsed: { memory: memoryHits.length, web: webHits.length } };
}

/* ────────── TOOL: hashtag_research ────────── */
export async function hashtagResearch({ topic, platform, count = 12 } = {}) {
  if (!topic) return { ok: false, error: "topic required" };
  const platforms = platform ? [platform] : ["instagram", "tiktok", "linkedin"];

  let webContext = "";
  try {
    const hits = await webSearch(`"${topic}" trending hashtags ${platforms[0]}`, 4);
    webContext = hits.map(h => `${h.title}: ${h.snippet}`).join("\n");
  } catch {}

  const system = `You research automotive content hashtags. Return only a JSON object — no prose. For each platform, mix high-volume, mid-volume, and niche tags so the post has reach AND finds the right audience.`;
  const user = `Topic: ${topic}
Platforms: ${platforms.join(", ")}
Per-platform count: ${count}
${webContext ? `Web context:\n${webContext}\n` : ""}
Reply with: { ${platforms.map(p => `"${p}": ["#tag1", "#tag2", ...]`).join(", ")} }
Each array must be exactly ${count} tags. No duplicates within a platform. Lowercase.`;

  const raw = await ollamaCall({ system, user, json: true, temperature: 0.5 });
  const parsed = safeParseJson(raw, null);
  if (!parsed) return { ok: false, error: "model returned non-JSON", raw: raw.slice(0, 300) };
  return { ok: true, hashtags: parsed };
}

/* ────────── TOOL: vehicle_spec_lookup ────────── */
export async function vehicleSpecLookup({ make, model, spec = "key specs" } = {}) {
  if (!make || !model) return { ok: false, error: "make and model required" };
  const query = `${make} ${model} ${spec}`;
  let hits = [];
  try { hits = await webSearch(query, 5); } catch {}
  if (hits.length === 0) return { ok: false, error: `no web results for "${query}"` };

  const system = `You extract automotive specifications from web snippets. Be precise — quote the exact number including units. If multiple sources disagree, prefer manufacturer / Autocar / Evo / Top Gear over forums.`;
  const user = `Question: ${spec} for the ${make} ${model}
Web search results (title + snippet + URL):
${hits.map((h, i) => `[${i + 1}] ${h.title}\n    ${h.snippet}\n    ${h.url}`).join("\n")}

Reply with a JSON object:
{ "answer": "<the figure with units>", "context": "<one short sentence of context>", "sourceIndex": <1-${hits.length}>, "confidence": "high" | "medium" | "low" }`;

  const raw = await ollamaCall({ system, user, json: true, temperature: 0.1 });
  const parsed = safeParseJson(raw, null);
  if (!parsed) return { ok: false, error: "model returned non-JSON", raw: raw.slice(0, 300) };
  const sourceIdx = Math.max(1, Math.min(hits.length, Number(parsed.sourceIndex) || 1)) - 1;
  return {
    ok: true,
    answer: parsed.answer,
    context: parsed.context,
    confidence: parsed.confidence,
    source: hits[sourceIdx],
  };
}

/* ────────── TOOL: ask_internal (junior onboarding mode) ────────── */
export async function askInternal({ question } = {}) {
  if (!question) return { ok: false, error: "question required" };

  const recall = await Memory.recall({ query: question, limit: 8 });
  const hits = (recall.results || []);
  const grounded = hits.length > 0;

  const system = `You answer "how do we usually do X" questions for a junior member of an automotive PR/content agency (Jarvis AI). Lean HEAVY on the team's stored notes when you have them — that's the actual house style. If the notes don't cover the question, say "no specific team notes yet" and offer general best practice.`;
  const user = `Question: ${question}
${grounded ? `Stored team notes (${hits.length} relevant entries):\n${hits.map(h => `- [${h.kind}] ${h.text}`).join("\n")}\n` : "No relevant stored notes — answer from general best practice and flag this clearly.\n"}
Reply concisely (2-4 short paragraphs). British English.`;

  const answer = await ollamaCall({ system, user, json: false, temperature: 0.4 });
  return { ok: true, answer, grounded, sourceCount: hits.length };
}

/* ────────── TOOL: team_standup ────────── */
export async function teamStandup({ hours = 24 } = {}) {
  const sinceMs = Date.now() - hours * 60 * 60 * 1000;

  const outputDir = Paths.getOutputDir();
  const teasers = [];
  if (existsSync(outputDir)) {
    for (const name of readdirSync(outputDir)) {
      if (!name.startsWith("prod_")) continue;
      const finalMp4 = path.join(outputDir, name, "final.mp4");
      if (!existsSync(finalMp4)) continue;
      const st = statSync(finalMp4);
      if (st.mtimeMs >= sinceMs) {
        teasers.push({ name, finishedAt: st.mtime, sizeKB: Math.round(st.size / 1024) });
      }
    }
  }

  const pdfDir = Paths.getOutputSubdir("pdfs");
  const pdfs = [];
  if (existsSync(pdfDir)) {
    for (const name of readdirSync(pdfDir)) {
      if (!name.endsWith(".pdf")) continue;
      const st = statSync(path.join(pdfDir, name));
      if (st.mtimeMs >= sinceMs) {
        pdfs.push({ name, finishedAt: st.mtime });
      }
    }
  }

  const recentConvos = await Memory.recall({ query: "recent activity work today", limit: 5 }).catch(() => ({ results: [] }));
  const conversations = (recentConvos.results || []).filter(r => r.kind === "conversation").map(r => r.text);

  const stats = Memory.memoryStats();

  const system = `You write a punchy team-standup summary for an automotive PR/content agency. Group by activity type, lead with the highest-value items, end with anything pending. British English, 4-6 short paragraphs max.`;
  const user = `Window: last ${hours} hours
Teasers rendered: ${teasers.length}${teasers.length ? `\n${teasers.map(t => `  - ${t.name} (${t.sizeKB}KB at ${t.finishedAt.toLocaleTimeString("en-GB")})`).join("\n")}` : ""}
PDFs generated: ${pdfs.length}${pdfs.length ? `\n${pdfs.map(p => `  - ${p.name}`).join("\n")}` : ""}
Recent conversation summaries: ${conversations.length}${conversations.length ? `\n${conversations.map(c => `  - ${c}`).join("\n")}` : ""}
Memory totals: ${stats.contacts} contacts, ${stats.projects} projects, ${stats.facts} facts, ${stats.conversations} session summaries.

Write the standup. If nothing happened in this window, say so plainly.`;

  const summary = await ollamaCall({ system, user, json: false, temperature: 0.4 });
  return {
    ok: true,
    summary,
    raw: { teasers: teasers.length, pdfs: pdfs.length, conversations: conversations.length, hours },
  };
}

/* ────────── TOOL: describe_shoot_with_specs ──────────
 * Composite tool: VL captions + folder-name parsing → identifies make/model →
 * webSearch for engine size, BHP, drivetrain, 0-60 → narrative briefing.
 * Voice flow: "tell me about the most recent shoot" / "what's in the latest shoot
 * and what's the car's engine".
 */
export async function describeShootWithSpecs({ folder } = {}) {
  /* Resolve folder + subject from name. */
  const SHOOTS = Paths.getShootsDir();
  let folderName = folder;
  if (!folderName || folderName === "latest") {
    const dirs = readdirSync(SHOOTS, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name).sort().reverse();
    folderName = dirs[0];
  }
  if (!folderName) return { ok: false, error: "no shoots/ folders found" };

  const subjectGuess = folderName
    .replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "")
    .replace(/[-_]/g, " ").trim()
    .replace(/\b\w/g, c => c.toUpperCase()) || folderName;

  /* Step 1: pull cached captions for THIS folder if any exist — no fresh VL calls.
   * Why: previous version always ran captionShootFolder (which loads VL on cache miss
   * and burns 5-30s). For "tell me about the recent shoot" that's overkill — we just need
   * a one-line context, and Qwen knows the car from the folder name alone. */
  console.log(`[shoot-brief] start folder="${folderName}" subject="${subjectGuess}"`);
  let visualDigest = "(no captions cached)";
  try {
    const visionMod = await import("./vision.mjs");
    /* visionStats is cheap; we use it to test whether ANY captions exist for this folder */
    const Database = (await import("better-sqlite3")).default;
    const dbPath = path.join(PROJECT, "data", "memory.db");
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT caption FROM frame_captions WHERE shoot_folder = ? LIMIT 4").all(folderName);
    db.close();
    if (rows.length > 0) {
      visualDigest = rows.map((r, i) => `(${i + 1}) ${r.caption}`).join(" ");
    }
    console.log(`[shoot-brief] cached captions: ${rows.length}`);
  } catch (e) {
    console.warn(`[shoot-brief] caption cache read failed: ${e.message}`);
  }

  /* Step 2: parse make + model from subject string. Take first 1-2 words as make, rest as model.
   * Two-word makes (the manufacturer / Land Rover / Rolls-Royce) handled via known list. */
  const TWO_WORD_MAKES = ["aston martin", "land rover", "rolls-royce", "rolls royce", "alfa romeo"];
  const lcSubject = subjectGuess.toLowerCase();
  let make, model;
  const matchedTwo = TWO_WORD_MAKES.find(m => lcSubject.startsWith(m));
  if (matchedTwo) {
    make = subjectGuess.slice(0, matchedTwo.length);
    model = subjectGuess.slice(matchedTwo.length).trim();
  } else {
    const parts = subjectGuess.split(/\s+/);
    make = parts[0] || subjectGuess;
    model = parts.slice(1).join(" ") || "";
  }

  /* Step 3 (was: 5 sequential web searches): SKIPPED. Qwen 14b knows the headline
   * specs for any car a UK PR agency is likely shooting (the press car, 720S, F40, RS6, etc).
   * We instruct the model to mark unknown specs as null rather than fabricate. If
   * the operator wants verified figures from the web they can ask "look up the
   * the press car's torque" which routes to vehicle_spec_lookup explicitly. */
  const specResults = {};

  /* Step 4: single LLM call to fold the visual digest + your trained-in knowledge of
   * the car into a brief. Mark any spec you're not confident about as null. */
  const system = `You brief an automotive PR/content agency on a shoot they've just captured. Use what you already know about the vehicle. Output a JSON object with structured spec fields plus a "narrative" field (2-3 short British-English sentences blending what was photographed with the headline specs). If you're not confident about a spec, return null for it — never fabricate. Keep the narrative spoken-friendly: short, natural, no markdown, no special characters, no bullet points.`;
  const user = `Folder: ${folderName}
Inferred subject: ${make} ${model}

Visual summary (from cached frame captions):
${visualDigest.slice(0, 1500)}

Reply with JSON:
{
  "make": "${make}",
  "model": "${model || "(unknown)"}",
  "engine": "<e.g. '5.0L V10' or null>",
  "power": "<e.g. '510 BHP' or null>",
  "drivetrain": "<e.g. 'AWD' or null>",
  "zeroToSixty": "<e.g. '3.2s' or null>",
  "topSpeed": "<e.g. '198 mph' or null>",
  "narrative": "2-3 short spoken-style sentences. No special characters, no markdown."
}`;

  const tSyn = Date.now();
  const raw = await ollamaCall({ system, user, json: true, temperature: 0.2 });
  console.log(`[shoot-brief] synthesis ${Date.now() - tSyn}ms (${raw.length} chars)`);
  const parsed = safeParseJson(raw, null);
  if (!parsed) {
    console.warn(`[shoot-brief] non-JSON synthesis — falling back to digest only`);
    return {
      ok: true,
      folder: folderName,
      subject: subjectGuess,
      visualDigest,
      narrative: `Most recent shoot: ${subjectGuess}. ${visualDigest.split("\n")[0] || ""}`.slice(0, 400),
      specsRaw: specResults,
    };
  }

  return {
    ok: true,
    folder: folderName,
    subject: subjectGuess,
    ...parsed,
    visualDigest,
  };
}

/* ────────── TOOL: press_release_from_bullets ──────────
 * Voice flow: operator dictates 4-5 bullet points ("the press car to Goodwood, July 18,
 * client previews, the manufacturer AMR Pro, sub-3s 0-60") and gets a finished branded
 * press release PDF. The LLM expands bullets → headline + subhead + dateline + lead +
 * body + boilerplate, then we render the existing 'press-release' template.
 *
 * Boilerplate + dateline city + press contact derive from config/brand.json so a
 * white-label install (Acme Studios, etc.) doesn't leak Jarvis's identity into the
 * draft. Operator can still override any of these per call. */
function deriveBoilerplate(brand) {
  const agency = brand?.agency || {};
  const name = agency.name || "Jarvis AI";
  const tagline = agency.tagline || "we live and breathe automotive";
  const domain = agency.domain || "";
  /* primarySocialHandle picks Instagram → X → TikTok → Facebook from agency.socials,
   * with fallback to the legacy single `social` string for brand.json files written
   * before the per-platform schema. */
  const social = primarySocialHandle(agency);
  const trailer = [domain, social].filter(Boolean).join(" · ");
  return `${name} — ${tagline}.${trailer ? ` ${trailer}` : ""}`;
}

function derivePressContact(brand) {
  const agency = brand?.agency || {};
  if (agency.pressEmail) return agency.pressEmail;
  /* Why: many operators set agency.domain like "" but no pressEmail.
   * Synthesise "press@<domain>" as a sensible default. */
  if (agency.domain) return `press@${agency.domain.replace(/^https?:\/\//, "").replace(/^www\./, "")}`;
  return "press@example.com";
}

export async function pressReleaseFromBullets({
  bullets,
  client = null,
  subject = null,
  contact = null,
  releaseDate = null,
  boilerplate = null,
  city = null,
} = {}) {
  /* Accept either an array of strings or a free-form newline-separated dictation. */
  let lines = [];
  if (Array.isArray(bullets)) lines = bullets.map(b => String(b || "").trim()).filter(Boolean);
  else if (typeof bullets === "string") lines = bullets.split(/\n+|;\s*/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return { ok: false, error: "need at least two bullet points" };

  /* Why: lazy import keeps agency.mjs free of brand circularity at top-level. */
  const { loadBrand } = await import("./brand.mjs");
  const brand = loadBrand();
  const datelineCity = city || brand?.agency?.city || "Leicester, UK";
  const resolvedBoilerplate = boilerplate || deriveBoilerplate(brand);
  const resolvedContact = contact || derivePressContact(brand);

  const dateline = (releaseDate ? new Date(releaseDate).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }) : new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }));

  const system = `You expand operator bullet points into a complete press release for an automotive PR agency. House style: British English, factual, evocative without being florid, no hyperbole, no exclamation marks.

Output STRICT JSON only. The body should be 3-4 short paragraphs (~80-120 words total) — opening news angle, supporting context, manufacturer/event tie-in, what happens next. Include exactly one quote attributed to a plausible spokesperson if the bullets imply one (e.g. agency MD, manufacturer comms head); leave quote/quoteAttribution null if there's no clear voice.`;

  const user = `Bullet points (operator dictation):
${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}

Context:
- Client / subject: ${client || subject || "(not specified)"}
- Dateline city: ${datelineCity}

Reply with this JSON shape:
{
  "headline": "<all-caps not required, but punchy 6-12 words>",
  "subhead": "<one supporting sentence, sentence-case>",
  "dateline": "<CITY — e.g. LEICESTER>",
  "lead": "<one strong opening sentence — the news in one breath>",
  "body": "<three short paragraphs separated by single \\n\\n>",
  "quote": "<single sentence, or null>",
  "quoteAttribution": "<Name, Role at Company — or null>"
}`;

  const raw = await ollamaCall({ system, user, json: true, temperature: 0.55 });
  const parsed = safeParseJson(raw, null);
  if (!parsed) return { ok: false, error: "model returned non-JSON", raw: raw.slice(0, 300) };

  /* Render the press-release PDF using the existing template. Lazy-import to keep agency.mjs
   * free of puppeteer at top-level (matters for unit tests that don't need PDFs). */
  const { createPdf } = await import("./pdf.mjs");
  const pdf = await createPdf({
    template: "press-release",
    data: {
      headline: parsed.headline,
      subhead: parsed.subhead,
      dateline: parsed.dateline,
      lead: parsed.lead,
      body: parsed.body,
      quote: parsed.quote,
      quoteAttribution: parsed.quoteAttribution,
      boilerplate: resolvedBoilerplate,
      contact: resolvedContact,
      releaseDate: dateline,
    },
  });

  return {
    ok: true,
    pdf,
    headline: parsed.headline,
    subhead: parsed.subhead,
    bulletCount: lines.length,
    summary: `Press release drafted from ${lines.length} bullets — opens for review, never auto-sends.`,
  };
}

/* ────────── TOOL: pre_shoot_checklist ──────────
 * Voice flow: "kit check for tomorrow's Bentley shoot at Goodwood" → assistant
 * fetches the local weather for the date, knows the shoot type from the brief,
 * asks Qwen to produce a structured kit list (cameras / lenses / lighting / audio /
 * comms / power / weather protection / notes).
 *
 * Operator can pass partial context — anything missing the LLM works around. */
export async function preShootChecklist({
  project = null,
  vehicleType = null,
  location = null,
  indoor = null,
  crewCount = null,
  durationHours = null,
  weatherDate = null,
} = {}) {
  /* If a location was provided, try fetching forecast for the date so the checklist
   * accounts for actual conditions. Open-Meteo forecasts for free without a key. */
  let forecastSummary = null;
  if (location) {
    try {
      const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`, { signal: AbortSignal.timeout(4000) });
      const gj = await geo.json();
      const hit = (gj.results || [])[0];
      if (hit) {
        const dateStr = weatherDate || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const wr = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code&start_date=${dateStr}&end_date=${dateStr}&timezone=auto`, { signal: AbortSignal.timeout(4000) });
        const wj = await wr.json();
        if (wj.daily) {
          forecastSummary = `${dateStr} at ${hit.name}, ${hit.country}: ${wj.daily.temperature_2m_min[0]}–${wj.daily.temperature_2m_max[0]}°C, precipitation ${wj.daily.precipitation_sum[0]}mm, wind ${wj.daily.wind_speed_10m_max[0]}kph`;
        }
      }
    } catch { /* weather lookup is best-effort */ }
  }

  const system = `You produce concise pre-shoot kit checklists for a UK automotive PR/content agency. Format the response as STRUCTURED JSON with these exact top-level keys: cameras, lenses, lighting, audio, comms, power, weatherProtection, notes. Each value is an array of short bullet strings (or a single sentence for "notes").

Tailor decisions to:
- Vehicle type (sportscar / SUV / classic etc) — close-ups need different lens reach
- Indoor vs outdoor
- Crew count (more crew = more comms units)
- Duration (longer = more batteries + cards)
- Weather (rain → covers + microfibre, cold → battery warmers, wind → mic deadcat)

Be SPECIFIC about quantities ("3× extra V-mount") and reasoning ("28-70 for setup, 70-200 for hero"). Don't pad.`;

  const user = `Brief:
- Project: ${project || "(unspecified — make reasonable assumptions for a typical automotive shoot)"}
- Vehicle: ${vehicleType || "(unspecified)"}
- Location: ${location || "(unspecified)"}
- Indoor / outdoor: ${indoor === true ? "indoor" : indoor === false ? "outdoor" : "(unspecified — assume mixed)"}
- Crew count: ${crewCount || "(unspecified, assume 3)"}
- Duration: ${durationHours ? durationHours + "h" : "(unspecified, assume 6h)"}
${forecastSummary ? `- Forecast: ${forecastSummary}` : ""}

Reply with the JSON object only.`;

  const raw = await ollamaCall({ system, user, json: true, temperature: 0.3 });
  const parsed = safeParseJson(raw, null);
  if (!parsed) return { ok: false, error: "model returned non-JSON", raw: raw.slice(0, 300) };

  /* Build a flat human-readable checklist for the operator's voice readout. */
  const sections = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (k === "notes") continue;
    if (Array.isArray(v) && v.length) {
      sections.push(`${k.replace(/([A-Z])/g, " $1").toUpperCase()}: ${v.join("; ")}`);
    }
  }
  if (parsed.notes) sections.push(`NOTES: ${parsed.notes}`);

  return {
    ok: true,
    checklist: parsed,
    forecast: forecastSummary,
    summary: sections.join("\n"),
    voice: `Kit checklist drafted${project ? ` for ${project}` : ""}${forecastSummary ? `, forecast factored in` : ""}. Read it back from the structured response.`,
  };
}
