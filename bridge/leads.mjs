/** leads.mjs - Monthly outreach pack generator (SerpAPI + Hunter.io + Qwen).
 *
 *  Tool: generate_outreach_pack({ month?, focus?, dryRun?, limit? })
 *
 *  Pipeline:
 *    1. Read config/leads.json — search queries, target manufacturers, exclude rules.
 *    2. Run each query through SerpAPI (Google) → result URLs + snippets.
 *    3. Extract unique target domains from those results, filtering excludes.
 *    4. For each domain, hit Hunter.io Domain Search → named contacts with verified emails.
 *    5. Filter contacts to roles in config.targetDepartments (marketing/PR/comms).
 *    6. For each contact, draft a personalised 2-3 line opener via Qwen.
 *    7. Save to SQLite (outreach_leads table) for dedupe + history.
 *    8. Render a branded PDF the operator can take action on.
 *
 *  Auth: SERPAPI_KEY + HUNTER_API_KEY in .env (setup-wizard prompts for both).
 *  Free tiers cover ~10 leads/month; paid plans get more headroom.
 */

import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { createPdf } from "./pdf.mjs";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA_DIR = path.join(PROJECT_DIR, "data");
const CONFIG_PATH = path.join(PROJECT_DIR, "config", "leads.json");

/* Why: env vars are loaded by server.mjs AFTER ES-module imports resolve, so reading
 * process.env at top-level captures undefined → fallback to 32b → GPU thrash. Lazy
 * lookup so the .env-set OLLAMA_MODEL=qwen2.5:14b actually wins on the M1 Max dev box. */
const OLLAMA_URL = () => process.env.OLLAMA_URL || "http://localhost:11434";
const TEXT_MODEL = () => process.env.OLLAMA_MODEL || "qwen2.5:14b";

const db = new Database(path.join(DATA_DIR, "memory.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS outreach_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  role TEXT,
  company TEXT,
  domain TEXT,
  hook TEXT,
  opener TEXT,
  source_query TEXT,
  source_url TEXT,
  pack_month TEXT,
  confidence TEXT,
  created_at INTEGER NOT NULL,
  contacted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_leads_month ON outreach_leads(pack_month);
CREATE INDEX IF NOT EXISTS idx_leads_domain ON outreach_leads(domain);
`);

/** SerpAPI Google search — returns slimmed organic results. */
async function serpApiSearch(query, num = 8) {
  const key = process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY not set");
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${num}&api_key=${encodeURIComponent(key)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`serpapi ${r.status}`);
  const j = await r.json();
  return (j.organic_results || []).map(x => ({
    title: x.title,
    link: x.link,
    snippet: x.snippet || (x.snippet_highlighted_words || []).join(" ") || "",
    source: x.source,
  }));
}

/** Hunter.io Domain Search — named contacts at a domain plus the email pattern. */
async function hunterDomainSearch(domain, { department, limit = 10 } = {}) {
  const key = process.env.HUNTER_API_KEY;
  if (!key) throw new Error("HUNTER_API_KEY not set");
  const params = new URLSearchParams({ domain, limit: String(limit), api_key: key });
  if (department) params.set("department", department);
  const url = `https://api.hunter.io/v2/domain-search?${params.toString()}`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, status: r.status, domain };
  const j = await r.json();
  return {
    ok: true,
    domain,
    pattern: j.data?.pattern || null,
    contacts: (j.data?.emails || []).slice(0, limit).map(c => ({
      firstName: c.first_name,
      lastName: c.last_name,
      position: c.position,
      department: c.department,
      email: c.value,
      confidence: c.confidence,
      verification: c.verification?.status,
    })),
  };
}

const TLD_RX = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,})\b/i;
function domainFromUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    const m = (u || "").match(TLD_RX);
    return m ? m[1].toLowerCase() : null;
  }
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return { queries: [], manufacturers: [], targetDepartments: [], excludeDomains: [], excludeExistingClients: [] };
  }
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) { return { _error: e.message, queries: [], manufacturers: [], targetDepartments: [], excludeDomains: [] }; }
}

/** Single-shot Qwen call for the personalised opener. */
async function ollamaPersonaliseOpener(lead, contextSnippet) {
  const r = await fetch(`${OLLAMA_URL()}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: TEXT_MODEL(),
      stream: false,
      keep_alive: "5m",
      options: { temperature: 0.6 },
      messages: [
        { role: "system", content: "You write COLD outreach openers for an automotive PR/content agency (Flat-Out Media). Output the FIRST 2-3 sentences only — no greeting, no signoff, no subject line. The opener must reference something concrete from the prospect's recent activity (not generic flattery), then pivot to a specific reason a Flat-Out conversation is worth their time. British English. No emojis. No 'Hope this finds you well'." },
        { role: "user", content: `Prospect: ${lead.firstName} ${lead.lastName}, ${lead.position} at ${lead.company}.\nContext from recent web activity: ${contextSnippet || "(no specific news surfaced)"}\n\nWrite the opener.` },
      ],
    }),
  });
  if (!r.ok) return "";
  const j = await r.json();
  return (j.message?.content || "").trim();
}

/**
 * Build a monthly outreach pack: discover, enrich, personalise, render.
 *
 * @param {object} args
 * @param {string} [args.month]     YYYY-MM tag for dedupe + naming. Default current month.
 * @param {string} [args.focus]     Free-form focus override ("just McLaren this month").
 * @param {number} [args.limit=20]  Max final leads in the pack.
 * @param {boolean} [args.dryRun]   Skip Hunter + Qwen; return the discovered domains only.
 */
export async function generateOutreachPack(args = {}) {
  if (!process.env.SERPAPI_KEY) {
    return { ok: false, error: "SERPAPI_KEY not set — get one at https://serpapi.com and add to .env (or re-run setup-wizard)" };
  }
  if (!process.env.HUNTER_API_KEY && !args.dryRun) {
    return { ok: false, error: "HUNTER_API_KEY not set — get one at https://hunter.io and add to .env (or re-run setup-wizard). Pass dryRun:true to skip enrichment." };
  }

  const month = args.month || new Date().toISOString().slice(0, 7);
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
  const cfg = loadConfig();
  if (cfg._error) return { ok: false, error: `bad config/leads.json: ${cfg._error}` };

  /* Build the query set — substitute {manufacturer} placeholders. */
  const queries = [];
  for (const tpl of (cfg.queries || [])) {
    const tplStr = tpl.query || "";
    if (tplStr.includes("{manufacturer}")) {
      for (const m of (cfg.manufacturers || [])) {
        queries.push({ query: tplStr.replace("{manufacturer}", m), manufacturer: m, limit: tpl.limit || 8 });
      }
    } else {
      queries.push({ query: tplStr, manufacturer: null, limit: tpl.limit || 8 });
    }
  }
  if (args.focus) {
    /* Override: replace manufacturers with operator's focus. */
    const focusQueries = [];
    for (const tpl of (cfg.queries || [])) {
      if ((tpl.query || "").includes("{manufacturer}")) {
        focusQueries.push({ query: tpl.query.replace("{manufacturer}", args.focus), manufacturer: args.focus, limit: tpl.limit || 8 });
      }
    }
    if (focusQueries.length) queries.splice(0, queries.length, ...focusQueries);
  }
  if (queries.length === 0) return { ok: false, error: "no queries to run — populate config/leads.json" };

  const excludes = new Set([
    ...(cfg.excludeDomains || []),
    ...(cfg.excludeExistingClients || []).filter(s => !s.startsWith("_")),
  ].map(d => d.toLowerCase().replace(/^www\./, "")));

  const domainMap = new Map();
  let serpCalls = 0;
  for (const q of queries) {
    let results;
    try { results = await serpApiSearch(q.query, q.limit); serpCalls++; }
    catch (e) { console.warn(`[leads] serpapi failed for "${q.query}": ${e.message}`); continue; }
    for (const r of results) {
      const d = domainFromUrl(r.link);
      if (!d) continue;
      if (excludes.has(d)) continue;
      /* Skip generic news aggregators — we want sources where a PR/marketing person actually works. */
      if (/^(news|press|search|jobs|careers)\.|aggregator/.test(d)) continue;
      if (!domainMap.has(d)) domainMap.set(d, { domain: d, manufacturer: q.manufacturer, hits: [] });
      const slot = domainMap.get(d);
      slot.hits.push({ title: r.title, snippet: r.snippet, link: r.link, query: q.query });
      if (q.manufacturer && !slot.manufacturer) slot.manufacturer = q.manufacturer;
    }
  }

  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      month,
      queries: queries.length,
      serpCalls,
      domains: [...domainMap.values()].slice(0, 50),
    };
  }

  /* Hunter enrichment per domain. */
  const targetDepts = (cfg.targetDepartments || []).map(s => s.toLowerCase());
  const leads = [];
  let hunterCalls = 0;
  for (const slot of domainMap.values()) {
    if (leads.length >= limit) break;
    const res = await hunterDomainSearch(slot.domain, { department: "communications,marketing,pr", limit: 5 }).catch(() => null);
    hunterCalls++;
    if (!res?.ok || !res.contacts.length) continue;

    const relevant = res.contacts.filter(c => {
      const role = (c.position || "").toLowerCase();
      return targetDepts.some(d => role.includes(d) || (c.department || "").toLowerCase().includes(d));
    });
    const pickFrom = relevant.length ? relevant : res.contacts.slice(0, 2);

    for (const c of pickFrom) {
      if (!c.email) continue;
      if (leads.length >= limit) break;
      /* Dedupe across past packs — skip already-stored emails. */
      const existing = db.prepare("SELECT id FROM outreach_leads WHERE LOWER(email) = LOWER(?)").get(c.email);
      if (existing) continue;

      const company = slot.manufacturer || slot.domain.split(".")[0].replace(/^[a-z]/, ch => ch.toUpperCase());
      const hook = slot.hits[0]?.title || "";
      const contextSnippet = slot.hits.slice(0, 2).map(h => `${h.title} — ${h.snippet}`).join("\n");
      const lead = {
        email: c.email,
        firstName: c.firstName || "",
        lastName: c.lastName || "",
        position: c.position || "",
        company,
        domain: slot.domain,
        hook,
        confidence: c.verification === "valid" ? "high" : (c.confidence >= 80 ? "medium" : "low"),
        sourceUrl: slot.hits[0]?.link || null,
        sourceQuery: slot.hits[0]?.query || null,
      };
      lead.opener = await ollamaPersonaliseOpener(lead, contextSnippet).catch(() => "");
      leads.push(lead);
    }
  }

  /* Persist to memory.db so future packs can dedupe + the standup can flag follow-ups. */
  const insert = db.prepare(`INSERT OR IGNORE INTO outreach_leads
    (email, name, role, company, domain, hook, opener, source_query, source_url, pack_month, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const now = Date.now();
  for (const l of leads) {
    insert.run(l.email, `${l.firstName} ${l.lastName}`.trim(), l.position, l.company, l.domain, l.hook, l.opener, l.sourceQuery, l.sourceUrl, month, l.confidence, now);
  }

  /* Render PDF. */
  const pdfData = {
    title: `Outreach Pack — ${month}`,
    month,
    leads,
    summary: `${leads.length} new leads across ${new Set(leads.map(l => l.domain)).size} domains. ${serpCalls} SerpAPI search${serpCalls === 1 ? "" : "es"}, ${hunterCalls} Hunter lookup${hunterCalls === 1 ? "" : "s"}.`,
  };
  const pdf = await createPdf({ template: "outreach-pack", data: pdfData });

  return {
    ok: true,
    month,
    leadCount: leads.length,
    serpCalls,
    hunterCalls,
    pdf,
    leads: leads.map(l => ({ ...l, opener: undefined })),
  };
}

/** Read leads — used by team_standup to flag follow-ups. */
export function listLeads({ month, contacted } = {}) {
  let sql = "SELECT * FROM outreach_leads";
  const params = [];
  const where = [];
  if (month) { where.push("pack_month = ?"); params.push(month); }
  if (contacted === true) where.push("contacted_at IS NOT NULL");
  if (contacted === false) where.push("contacted_at IS NULL");
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at DESC LIMIT 100";
  return db.prepare(sql).all(...params);
}

export function markLeadContacted({ email }) {
  if (!email) return { ok: false, error: "email required" };
  const r = db.prepare("UPDATE outreach_leads SET contacted_at = ? WHERE LOWER(email) = LOWER(?)").run(Date.now(), email);
  return { ok: r.changes > 0, changes: r.changes };
}

export function leadsStats() {
  return {
    total: db.prepare("SELECT COUNT(*) as n FROM outreach_leads").get().n,
    contacted: db.prepare("SELECT COUNT(*) as n FROM outreach_leads WHERE contacted_at IS NOT NULL").get().n,
    months: db.prepare("SELECT COUNT(DISTINCT pack_month) as n FROM outreach_leads").get().n,
    keysConfigured: { serpapi: !!process.env.SERPAPI_KEY, hunter: !!process.env.HUNTER_API_KEY },
  };
}
