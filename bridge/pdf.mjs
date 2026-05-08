/** pdf.mjs - Branded PDF generation via puppeteer-core (uses the system Chrome we already launch).
 *
 *  Tool: create_pdf({ template, data })
 *    template: "quote" | "brief" | "shoot-report" | "press-release"
 *    data: free-form object — LLM populates the template's placeholders
 *
 *  Output: ~/Desktop/Jarvis/output/pdf/<template>-<timestamp>.pdf
 */

import puppeteer from "puppeteer-core";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import * as Paths from "./paths.mjs";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
/* PDF_OUT resolved via Paths.getOutputSubdir("pdfs") at write time. */
const ASSET_DIR = path.join(PROJECT_DIR, "assets");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const ACCENT_CYAN = "#00d4ff";
const ACCENT_DEEP = "#0077a8";

/* Why: read the agent logos as base64 so they embed in the PDF without disk path dependencies. */
let logoCache = null;
function getLogos() {
  if (logoCache) return logoCache;
  try {
    const wordmark = readFileSync(path.join(ASSET_DIR, "jarvis-wordmark.png")).toString("base64");
    const dial = readFileSync(path.join(ASSET_DIR, "jarvis-dial.png")).toString("base64");
    logoCache = { wordmark: `data:image/png;base64,${wordmark}`, dial: `data:image/png;base64,${dial}` };
  } catch { logoCache = { wordmark: "", dial: "" }; }
  return logoCache;
}

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/* ---------- TEMPLATES ----------
 * Each returns full HTML for a single-page (or multi-page) PDF.
 * Templates accept a `data` object — the LLM is instructed to populate matching keys. */

function tmplBase(bodyHtml, opts = {}) {
  const { dial, wordmark } = getLogos();
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escHtml(opts.title || "Jarvis AI")}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@300;400;600;700&family=Rubik:wght@300;400;500;600&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Rubik', sans-serif; color: #1a1a1a; padding: 0; }
  .page { padding: 60px 64px; min-height: 100vh; position: relative; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 24px; border-bottom: 2px solid ${ACCENT_CYAN}; margin-bottom: 40px; }
  .header img.wordmark { height: 56px; filter: invert(1); }
  .header__meta { font-family: 'Oswald', sans-serif; font-size: 11px; letter-spacing: 0.3em; color: ${ACCENT_CYAN}; text-align: right; text-transform: uppercase; }
  h1 { font-family: 'Oswald', sans-serif; font-weight: 700; font-size: 42px; letter-spacing: 0.02em; line-height: 1.1; margin-bottom: 8px; text-transform: uppercase; }
  h2 { font-family: 'Oswald', sans-serif; font-weight: 600; font-size: 16px; letter-spacing: 0.25em; color: ${ACCENT_CYAN}; margin: 32px 0 12px; text-transform: uppercase; }
  p, li { font-size: 13px; line-height: 1.6; margin-bottom: 8px; }
  ul, ol { padding-left: 22px; margin: 8px 0 16px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
  th, td { padding: 10px 12px; border-bottom: 1px solid #e0e0e0; text-align: left; vertical-align: top; }
  th { font-family: 'Oswald', sans-serif; font-weight: 600; font-size: 11px; letter-spacing: 0.25em; text-transform: uppercase; color: ${ACCENT_CYAN}; }
  tr.total td { font-weight: 700; border-top: 2px solid ${ACCENT_CYAN}; border-bottom: none; padding-top: 14px; }
  .key-value { display: grid; grid-template-columns: 180px 1fr; gap: 8px 24px; margin: 16px 0; font-size: 13px; }
  .key-value .k { font-family: 'Oswald', sans-serif; font-size: 11px; letter-spacing: 0.25em; color: ${ACCENT_CYAN}; padding-top: 2px; text-transform: uppercase; }
  .footer { position: absolute; bottom: 36px; left: 64px; right: 64px; padding-top: 16px; border-top: 1px solid #e0e0e0; font-family: 'Oswald', sans-serif; font-size: 10px; letter-spacing: 0.25em; color: #999; display: flex; justify-content: space-between; text-transform: uppercase; }
  .accent-bar { height: 4px; background: ${ACCENT_CYAN}; margin-bottom: 32px; }
  .blade { position: absolute; bottom: 60px; right: 60px; width: 200px; height: 200px; opacity: 0.06; background: url('${dial}') center/contain no-repeat; pointer-events: none; }
  blockquote { border-left: 3px solid ${ACCENT_CYAN}; padding-left: 18px; margin: 16px 0; font-style: italic; color: #555; }
</style>
</head><body>
<div class="page">
  <div class="header">
    <img class="wordmark" src="${wordmark}" alt="Jarvis AI" />
    <div class="header__meta">${escHtml(opts.docType || "DOCUMENT")}<br/>${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</div>
  </div>
  <div class="accent-bar"></div>
  ${bodyHtml}
  <div class="blade"></div>
  <div class="footer">
    <span>JARVIS AI</span>
    <span>WE LIVE AND BREATHE AUTOMOTIVE</span>
    <span></span>
  </div>
</div>
</body></html>`;
}

function templateQuote(d) {
  const items = Array.isArray(d.lineItems) ? d.lineItems : [];
  const subtotal = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const vat = d.vatRate != null ? subtotal * (Number(d.vatRate) / 100) : subtotal * 0.20;
  const total = subtotal + vat;
  const fmt = (n) => "£" + n.toFixed(2);
  return tmplBase(`
    <h1>${escHtml(d.title || "Quote")}</h1>
    <p>For ${escHtml(d.client || "—")}</p>
    <div class="key-value">
      <div class="k">Quote No.</div><div>${escHtml(d.quoteNumber || `JV-${Date.now().toString().slice(-6)}`)}</div>
      <div class="k">Project</div><div>${escHtml(d.project || "—")}</div>
      <div class="k">Valid Until</div><div>${escHtml(d.validUntil || "30 days from issue")}</div>
      ${d.shootDates ? `<div class="k">Shoot Dates</div><div>${escHtml(d.shootDates)}</div>` : ""}
    </div>
    <h2>Line Items</h2>
    <table>
      <thead><tr><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>
        ${items.map(i => `<tr><td>${escHtml(i.description || "")}</td><td style="text-align:right">${fmt(Number(i.amount) || 0)}</td></tr>`).join("")}
        <tr><td>Subtotal</td><td style="text-align:right">${fmt(subtotal)}</td></tr>
        <tr><td>VAT (${d.vatRate != null ? d.vatRate : 20}%)</td><td style="text-align:right">${fmt(vat)}</td></tr>
        <tr class="total"><td>Total</td><td style="text-align:right">${fmt(total)}</td></tr>
      </tbody>
    </table>
    ${d.notes ? `<h2>Notes</h2><p>${escHtml(d.notes)}</p>` : ""}
    <h2>Terms</h2>
    <p>50% deposit on acceptance, balance on delivery. Quote subject to change if scope changes. All prices exclude expenses (travel, stock, third-party licensing) unless stated.</p>
  `, { docType: "QUOTE", title: d.title || "Quote" });
}

function templateBrief(d) {
  return tmplBase(`
    <h1>${escHtml(d.title || "Shoot Brief")}</h1>
    <p>${escHtml(d.client || "")} ${d.subject ? "— " + escHtml(d.subject) : ""}</p>
    <div class="key-value">
      <div class="k">Subject</div><div>${escHtml(d.subject || "—")}</div>
      <div class="k">Date(s)</div><div>${escHtml(d.dates || "TBC")}</div>
      <div class="k">Location</div><div>${escHtml(d.location || "TBC")}</div>
      <div class="k">Deliverables</div><div>${escHtml(d.deliverables || "—")}</div>
      ${d.crew ? `<div class="k">Crew</div><div>${escHtml(d.crew)}</div>` : ""}
    </div>
    ${d.objectives ? `<h2>Objectives</h2><p>${escHtml(d.objectives)}</p>` : ""}
    ${d.shotList ? `<h2>Shot List</h2><ol>${(Array.isArray(d.shotList) ? d.shotList : String(d.shotList).split("\n")).filter(Boolean).map(s => `<li>${escHtml(s)}</li>`).join("")}</ol>` : ""}
    ${d.notes ? `<h2>Notes</h2><p>${escHtml(d.notes)}</p>` : ""}
  `, { docType: "BRIEF", title: d.title || "Brief" });
}

function templateShootReport(d) {
  return tmplBase(`
    <h1>${escHtml(d.title || "Shoot Report")}</h1>
    <p>${escHtml(d.client || "")} ${d.subject ? "— " + escHtml(d.subject) : ""}</p>
    <div class="key-value">
      <div class="k">Date</div><div>${escHtml(d.date || new Date().toLocaleDateString("en-GB"))}</div>
      <div class="k">Location</div><div>${escHtml(d.location || "—")}</div>
      <div class="k">Weather</div><div>${escHtml(d.weather || "—")}</div>
      <div class="k">Crew</div><div>${escHtml(d.crew || "—")}</div>
      <div class="k">Files Captured</div><div>${escHtml(d.fileCount || "—")}</div>
    </div>
    ${d.summary ? `<h2>Summary</h2><p>${escHtml(d.summary)}</p>` : ""}
    ${d.highlights ? `<h2>Highlights</h2><ul>${(Array.isArray(d.highlights) ? d.highlights : String(d.highlights).split("\n")).filter(Boolean).map(s => `<li>${escHtml(s)}</li>`).join("")}</ul>` : ""}
    ${d.issues ? `<h2>Issues</h2><p>${escHtml(d.issues)}</p>` : ""}
    ${d.nextSteps ? `<h2>Next Steps</h2><p>${escHtml(d.nextSteps)}</p>` : ""}
  `, { docType: "SHOOT REPORT", title: d.title || "Shoot Report" });
}

function templatePressRelease(d) {
  return tmplBase(`
    <h1>${escHtml(d.headline || "Press Release")}</h1>
    <p style="color:${ACCENT_CYAN};font-family:'Oswald',sans-serif;letter-spacing:0.3em;font-size:11px;text-transform:uppercase">FOR IMMEDIATE RELEASE — ${escHtml(d.releaseDate || new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }).toUpperCase())}</p>
    ${d.subhead ? `<h2 style="color:#1a1a1a;letter-spacing:0">${escHtml(d.subhead)}</h2>` : ""}
    ${d.dateline ? `<p><strong>${escHtml(d.dateline)}</strong> — ${escHtml(d.lead || "")}</p>` : (d.lead ? `<p>${escHtml(d.lead)}</p>` : "")}
    ${d.body ? `<div>${String(d.body).split(/\n+/).filter(Boolean).map(p => `<p>${escHtml(p)}</p>`).join("")}</div>` : ""}
    ${d.quote ? `<blockquote>${escHtml(d.quote)}${d.quoteAttribution ? `<br/><br/><strong>— ${escHtml(d.quoteAttribution)}</strong>` : ""}</blockquote>` : ""}
    ${d.boilerplate ? `<h2>About</h2><p>${escHtml(d.boilerplate)}</p>` : ""}
    ${d.contact ? `<h2>Press Contact</h2><p>${escHtml(d.contact)}</p>` : ""}
  `, { docType: "PRESS RELEASE", title: d.headline || "Press Release" });
}

/* Why: outreach pack is a working document — operator ticks off leads as they're contacted,
 * adds hand-written notes, refers back next month. Density matters: each lead is a short
 * card with the key info (name/role/email/source) plus the AI-drafted opener inset for quick
 * skim-and-tweak before sending. Confidence dot colour-codes verification status. */
function templateOutreachPack(d) {
  const leads = Array.isArray(d.leads) ? d.leads : [];
  const cardHtml = leads.map((l, i) => {
    const dotColor = l.confidence === "high" ? "#1c8c2c" : (l.confidence === "medium" ? "#d49100" : "#b04040");
    const fullName = `${l.firstName || ""} ${l.lastName || ""}`.trim() || "(no name)";
    return `
      <div class="lead">
        <div class="lead__head">
          <div class="lead__num">${String(i + 1).padStart(2, "0")}</div>
          <div class="lead__primary">
            <div class="lead__name">${escHtml(fullName)}</div>
            <div class="lead__role">${escHtml(l.position || "")}${l.position && l.company ? " · " : ""}${escHtml(l.company || "")}</div>
          </div>
          <div class="lead__email">
            <span class="lead__dot" style="background:${dotColor}"></span>
            <a href="mailto:${escHtml(l.email)}">${escHtml(l.email)}</a>
          </div>
        </div>
        ${l.hook ? `<div class="lead__hook"><strong>Hook:</strong> ${escHtml(l.hook)}</div>` : ""}
        ${l.opener ? `<div class="lead__opener">${escHtml(l.opener).replace(/\n/g, "<br/>")}</div>` : ""}
        ${l.sourceUrl ? `<div class="lead__source"><a href="${escHtml(l.sourceUrl)}">${escHtml(l.sourceUrl).slice(0, 90)}</a></div>` : ""}
      </div>
    `;
  }).join("");

  return tmplBase(`
    <style>
      .lead { break-inside: avoid; padding: 14px 0; border-bottom: 1px solid #e0e0e0; }
      .lead:last-child { border-bottom: none; }
      .lead__head { display: flex; align-items: center; gap: 14px; }
      .lead__num { font-family: 'Oswald', sans-serif; font-weight: 600; color: ${ACCENT_CYAN}; font-size: 18px; min-width: 32px; }
      .lead__primary { flex: 1; }
      .lead__name { font-family: 'Oswald', sans-serif; font-weight: 600; font-size: 13pt; color: #111; }
      .lead__role { font-size: 9.5pt; color: #555; margin-top: 1px; }
      .lead__email { display: flex; align-items: center; gap: 6px; font-size: 9.5pt; }
      .lead__email a { color: ${ACCENT_CYAN}; text-decoration: none; }
      .lead__dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
      .lead__hook { font-size: 9pt; color: #444; margin-top: 6px; }
      .lead__opener { font-size: 10pt; color: #1a1a1a; margin-top: 8px; padding: 8px 12px; background: #f7f7f7; border-left: 3px solid ${ACCENT_CYAN}; line-height: 1.45; }
      .lead__source { font-size: 8pt; color: #999; margin-top: 4px; }
      .lead__source a { color: #999; text-decoration: none; }
      .pack-summary { font-size: 10pt; color: #444; margin-bottom: 14px; padding: 10px 14px; background: #faf3f3; border-left: 3px solid ${ACCENT_CYAN}; }
      .pack-legend { font-size: 8pt; color: #888; margin-top: 4px; letter-spacing: 0.06em; }
    </style>
    <h1>${escHtml(d.title || "Outreach Pack")}</h1>
    <div class="pack-summary">${escHtml(d.summary || `${leads.length} leads`)}</div>
    <div class="pack-legend">CONFIDENCE: <span style="color:#1c8c2c">●</span> verified  <span style="color:#d49100">●</span> high pattern match  <span style="color:#b04040">●</span> low confidence — verify before sending</div>
    ${cardHtml || `<p style="color:#999;font-style:italic">No leads in this pack. Re-run with a different focus, or check that SERPAPI_KEY and HUNTER_API_KEY are configured.</p>`}
  `, { docType: "OUTREACH PACK", title: d.title || "Outreach Pack" });
}

/* Why: hero contact sheet has its own grid layout (3 columns, captions under each thumb,
 * source-tag pill so editor knows whether the operator flagged or vision picked it).
 * Thumbs come in as base64 data URIs already sized to ~600px in contactsheet.mjs so the
 * PDF stays under ~5MB even for 12 shots. */
function templateContactSheet(d) {
  const sheets = Array.isArray(d.sheets) ? d.sheets : [];
  const cards = sheets.map((s, i) => {
    const sourceLabel = s.source === "flagged" ? "OP. FLAGGED" : "AUTO PICK";
    const sourceColor = s.source === "flagged" ? ACCENT_CYAN : "#666";
    return `
      <div class="thumb">
        <div class="thumb__num">${String(i + 1).padStart(2, "0")}</div>
        <img src="${s.dataUri}" alt="${escHtml(s.file)}"/>
        <div class="thumb__meta">
          <div class="thumb__file">${escHtml(s.file)}</div>
          <div class="thumb__src" style="color:${sourceColor}">${sourceLabel}</div>
        </div>
        ${s.caption ? `<div class="thumb__caption">${escHtml(s.caption).slice(0, 140)}</div>` : ""}
      </div>
    `;
  }).join("");

  return tmplBase(`
    <style>
      .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 18px; }
      .thumb { break-inside: avoid; position: relative; border: 1px solid #e0e0e0; padding: 8px; background: #fafafa; }
      .thumb img { width: 100%; height: 140px; object-fit: cover; display: block; }
      .thumb__num { position: absolute; top: 4px; left: 4px; background: ${ACCENT_CYAN}; color: #fff; font-family: 'Oswald', sans-serif; font-size: 10px; padding: 2px 6px; letter-spacing: 0.15em; z-index: 1; }
      .thumb__meta { display: flex; justify-content: space-between; align-items: baseline; padding-top: 8px; gap: 8px; }
      .thumb__file { font-family: 'Oswald', sans-serif; font-size: 9pt; letter-spacing: 0.06em; color: #222; word-break: break-all; flex: 1; }
      .thumb__src { font-family: 'Oswald', sans-serif; font-size: 7pt; letter-spacing: 0.18em; }
      .thumb__caption { font-size: 8pt; color: #555; line-height: 1.35; padding-top: 4px; }
      .sheet-summary { font-size: 10pt; color: #444; margin-top: 6px; padding: 10px 14px; background: #f7f7f7; border-left: 3px solid ${ACCENT_CYAN}; }
    </style>
    <h1>${escHtml(d.title || "Hero Selects")}</h1>
    <p>${escHtml(d.client || "")}${d.subject ? " — " + escHtml(d.subject) : ""}</p>
    ${d.summary ? `<div class="sheet-summary">${escHtml(d.summary)}</div>` : ""}
    <div class="grid">${cards}</div>
  `, { docType: "CONTACT SHEET", title: d.title || "Contact Sheet" });
}

const TEMPLATES = {
  quote: templateQuote,
  brief: templateBrief,
  "shoot-report": templateShootReport,
  "press-release": templatePressRelease,
  "outreach-pack": templateOutreachPack,
  "contact-sheet": templateContactSheet,
};

/** Render a template + data to a PDF on disk. Returns { path, url, size }. */
export async function createPdf({ template, data }) {
  const builder = TEMPLATES[String(template || "").toLowerCase()];
  if (!builder) throw new Error(`unknown template: ${template}. Use one of: ${Object.keys(TEMPLATES).join(", ")}`);
  const pdfOut = Paths.getOutputSubdir("pdfs");

  const html = builder(data || {});
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${template}-${ts}.pdf`;
  const outPath = path.join(pdfOut, filename);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });
  } finally {
    await browser.close();
  }

  const { statSync } = await import("node:fs");
  const size = statSync(outPath).size;
  return { ok: true, path: outPath, url: `/output/pdf/${filename}`, size, template };
}

/** List supported templates (for the LLM tool spec). */
export function listTemplates() { return Object.keys(TEMPLATES); }
