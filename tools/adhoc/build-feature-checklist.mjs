/** build-feature-checklist.mjs - One-off PDF: feature checklist for client sign-off.
 *  Two sections — already built (ticked) + proposed (empty checkbox each, yes/no).
 *  Branded with the FOM marketing wordmark treatment (heavy black FLAT-OUT + red MEDIA). */

import puppeteer from "puppeteer-core";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const OUT_DIR = path.join(PROJECT_DIR, "output", "pdf");
const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const BUILT = {
  "Voice & memory": [
    'Voice control with wake word "Hey Flat-Out" — runs entirely on the office Mac, no cloud',
    "Persistent memory of contacts, projects and conversations across sessions",
    "Confirmation gate before any client-visible action (no auto-sends)",
    "Cancel any task instantly with ESC or voice",
  ],
  "Vision (image & video understanding)": [
    "Describes any shoot frame for a press release (make/model, angle, lighting)",
    "Summarises an entire shoot folder by voice",
    'Finds specific shots by description ("front-grille close-ups", "low-angle hero")',
    "Scores video clips for trailer suitability and picks the best 3-second segment",
    "Auto-crops to 9:16, 1:1, 4:5 with the subject kept centered",
  ],
  "Production & editing": [
    "Cuts cinematic teasers (flash cuts, speed ramps, beat-synced music, FOM intro/outro)",
    "Drives Adobe Premiere Pro 2025 by voice (open, import, sequence, render)",
    "Applies Lightroom presets to RAW folders via XMP sidecars",
    "Image-to-video generation via Fal.ai Kling",
  ],
  "Client comms & admin": [
    "Generates branded PDFs: quotes, briefs, shoot reports, press releases",
    "Reads and adds Calendar events (synced to Google)",
    "Drafts emails — always opens for review, never auto-sends",
    "Frame.io review by voice — list pending, read comments, post replies, approve/reject",
    "Web search for up-to-the-minute info",
  ],
};

const PROPOSED = {
  "Email & comms": [
    "Smart inbox triage — categorise as client / sales / internal, surface what needs a reply today",
    "Threaded reply drafts — reads the full thread, drafts contextual response in two tones (formal/casual)",
    "Day-of-shoot status email draft to client",
  ],
  "Reporting": [
    "Auto-generated shoot report PDF — image/video counts, file sizes, hero shot picks, estimated edit time",
    "Monthly client snapshot — jobs delivered, hours, hero shots per client",
    "Time-to-deliver tracking per project (RAW in → final out)",
    "Project profitability dashboard (requires accounting integration — Xero / FreeAgent / QuickBooks?)",
  ],
  "Pre-shoot planning": [
    "Call sheet generator (location, weather, golden hour, crew, kit, contacts)",
    "Kit checklist by shoot type (track day / studio / press launch)",
    "Location + weather-window planner for proposed shoot dates",
  ],
  "On the shoot day": [
    'Voice memos against the shoot ("remember to reshoot rear 3/4")',
    "Shot list read-aloud with tick-off",
    'Timers ("5-minute warning for golden hour")',
    "Take quality flagging by voice for the editor to find later",
  ],
  "Editing & post": [
    "One-command export of all aspect ratios (16:9, 9:16, 1:1, 4:5) from a single master",
    "Auto-subtitle generation for social cuts (SRT)",
    "Hero-frame contact sheet (top 6-12 stills picked automatically)",
    "Colour reference matching — describe a reference, get LUT/curve suggestions",
    "Batch watermark application",
  ],
  "Content & captions": [
    "Platform-specific caption generator — Instagram, LinkedIn, TikTok with appropriate tone for each",
    "Press release draft from 4-5 bullet points dictated by voice",
    "Hashtag research per platform",
  ],
  "Asset library": [
    "Auto-tag every new shoot on import (vehicle, location, conditions) so search just works",
    '"Find similar shots" across all past shoots',
    "Usage rights tracking per asset (which client cleared this for which use?)",
  ],
  "Sales & pitching": [
    "Pitch deck draft from a brief",
    "Competitor brand monitoring (Top Gear, AutoCar, Carwow daily/weekly digest)",
    "Inbound lead consolidation across email + LinkedIn + website form",
  ],
  "Automotive specifics": [
    'Vehicle spec quick lookup ("what\'s the Vulcan\'s torque?")',
    "Manufacturer tone-of-voice checker (Aston Martin / McLaren caption draft review)",
    "Track-day metadata auto-tag (lap times, weather, conditions)",
  ],
  "Internal team": [
    'Junior onboarding mode — "how do we usually grade an Aston shoot?" pulls past notes',
    "Team standup summary by voice",
  ],
};

const html = `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Flat-Out Media — Feature Checklist</title>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Oswald:wght@300;400;500;600;700&family=Rubik:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #ffffff; color: #111; font-family: "Rubik", system-ui, sans-serif; font-size: 10.5pt; line-height: 1.4; }
  .page { padding: 22mm 18mm 16mm; }

  .masthead { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 2px solid #E10600; padding-bottom: 10px; margin-bottom: 16px; }
  .wordmark { display: flex; flex-direction: column; line-height: 0.85; }
  .wordmark__primary { font-family: "Anton", "Oswald", sans-serif; font-size: 44pt; letter-spacing: -0.01em; color: #111; line-height: 0.85; text-transform: uppercase; }
  .wordmark__suffix  { font-family: "Oswald", sans-serif; font-weight: 600; font-size: 11pt; letter-spacing: 0.55em; color: #E10600; text-transform: uppercase; margin-top: 4px; margin-right: -0.55em; }
  .meta { text-align: right; font-family: "Oswald", sans-serif; }
  .meta__title { font-size: 14pt; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: #111; }
  .meta__sub   { font-size: 9pt; letter-spacing: 0.18em; color: #6a6a6a; text-transform: uppercase; margin-top: 2px; }

  .intro { font-size: 10.5pt; color: #444; margin-bottom: 18px; max-width: 165mm; }

  .section { margin-bottom: 16px; break-inside: avoid; }
  .section__head { display: flex; align-items: baseline; gap: 12px; border-bottom: 1px solid #d8d8d8; padding-bottom: 4px; margin-bottom: 8px; }
  .section__title { font-family: "Oswald", sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 0.18em; font-size: 11pt; color: #111; }
  .section__rule  { flex: 1; height: 1px; background: transparent; }
  .section--built .section__title { color: #1c8c2c; }
  .section--proposed .section__title { color: #111; }

  .group { margin-bottom: 10px; break-inside: avoid; }
  /* Why: "Sales & pitching" was splitting awkwardly across pages 1/2 — force a clean
   * page break before it so the second page starts on a section boundary. */
  .group--break-before { break-before: page; page-break-before: always; }
  .group__title { font-family: "Oswald", sans-serif; font-weight: 500; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.22em; color: #888; margin-bottom: 4px; }

  .item { display: flex; gap: 10px; align-items: flex-start; padding: 4px 0; break-inside: avoid; }
  .item__box { flex: 0 0 11pt; width: 11pt; height: 11pt; border: 1.4px solid #111; border-radius: 1px; margin-top: 2px; position: relative; background: #fff; }
  .item__box--checked { border-color: #1c8c2c; background: #1c8c2c; }
  .item__box--checked::after {
    content: ""; position: absolute; left: 2.4pt; top: 0.7pt; width: 4.5pt; height: 7pt;
    border: solid #fff; border-width: 0 1.6pt 1.6pt 0; transform: rotate(45deg);
  }
  .item__yn   { flex: 0 0 auto; font-family: "Oswald", sans-serif; font-size: 8pt; letter-spacing: 0.18em; color: #888; margin-top: 2px; }
  .item__text { flex: 1; color: #1a1a1a; }

  .footer { position: fixed; bottom: 8mm; left: 18mm; right: 18mm; display: flex; justify-content: space-between; font-family: "Oswald", sans-serif; font-size: 8pt; letter-spacing: 0.22em; text-transform: uppercase; color: #aaa; }
  .footer__brand { color: #E10600; font-weight: 600; }
</style>
</head>
<body>
<div class="page">
  <div class="masthead">
    <div class="wordmark">
      <span class="wordmark__primary">FLAT-OUT</span>
      <span class="wordmark__suffix">MEDIA</span>
    </div>
    <div class="meta">
      <div class="meta__title">Assistant — Feature Checklist</div>
      <div class="meta__sub">For client sign-off · ${new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" })}</div>
    </div>
  </div>

  <div class="intro">
    Section A is what's already built into the assistant — these capabilities are live and ready to use.
    Section B is what we can add — please tick the items you'd like included so we can prioritise.
  </div>

  <div class="section section--built">
    <div class="section__head">
      <div class="section__title">A · Already built</div>
      <div class="section__rule"></div>
    </div>
    ${Object.entries(BUILT).map(([group, items]) => `
      <div class="group">
        <div class="group__title">${group}</div>
        ${items.map(t => `
          <div class="item">
            <div class="item__box item__box--checked"></div>
            <div class="item__text">${t}</div>
          </div>
        `).join("")}
      </div>
    `).join("")}
  </div>

  <div class="section section--proposed">
    <div class="section__head">
      <div class="section__title">B · Proposed — please tick</div>
      <div class="section__rule"></div>
    </div>
    ${Object.entries(PROPOSED).map(([group, items]) => {
      /* Why: trigger a clean page break at "Sales & pitching" so it starts page 2,
       * keeps groups intact and the right-hand column aligned. */
      const breakClass = group === "Sales & pitching" ? " group--break-before" : "";
      return `
      <div class="group${breakClass}">
        <div class="group__title">${group}</div>
        ${items.map(t => `
          <div class="item">
            <div class="item__box"></div>
            <div class="item__text">${t}</div>
          </div>
        `).join("")}
      </div>`;
    }).join("")}
  </div>

  <div class="footer">
    <div class="footer__brand">FLAT-OUT MEDIA</div>
    <div>flatoutmedia.org</div>
  </div>
</div>
</body></html>`;

if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outPath = path.join(OUT_DIR, `feature-checklist-${ts}.pdf`);

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

console.log("✓ wrote", outPath);
