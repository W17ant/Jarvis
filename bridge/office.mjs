/** office.mjs - Microsoft Office document generators (pptx / docx / xlsx).
 *
 *  Closes the FOM workflow gap where the kiosk could generate rich PDFs
 *  but couldn't ship a client deck or shoot log in the formats the
 *  operator's clients actually expect. Each generator produces a real
 *  Office file (Office Open XML under the hood) — no PDFs-with-Office-
 *  extensions, no LibreOffice round-trips, no proprietary deps.
 *
 *  Pure-JS libraries:
 *    pptxgenjs (~200KB) — PowerPoint .pptx
 *    docx      (~200KB) — Word .docx
 *    exceljs   (~400KB) — Excel .xlsx
 *
 *  Output paths follow the existing brand convention — output/pptx/,
 *  output/docx/, output/xlsx/. Each generator returns the absolute path
 *  + filename so the LLM can speak it back or hand off to other tools.
 *
 *  Brand colours come from config/brand.json so the visual identity
 *  stays consistent with the HUD's accent. Falls back to FOM red if
 *  the brand isn't loaded.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import { fileURLToPath } from "node:url";
import PptxGenJS from "pptxgenjs";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } from "docx";
import ExcelJS from "exceljs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");

const PPTX_DIR = path.join(PROJECT_DIR, "output", "pptx");
const DOCX_DIR = path.join(PROJECT_DIR, "output", "docx");
const XLSX_DIR = path.join(PROJECT_DIR, "output", "xlsx");

/** Read the operator's brand colour from config/brand.json. Falls back to
 *  FOM red on any read error so generators never block on a missing config. */
async function brandHex() {
  try {
    const raw = await fsp.readFile(path.join(PROJECT_DIR, "config", "brand.json"), "utf8");
    const j = JSON.parse(raw);
    return (j.agency?.redHex || "#E10600").replace(/^#/, "");
  } catch {
    return "E10600";
  }
}

/** Brand agency name + tagline from config — used in the master pages /
 *  document footers. Falls back to operator-friendly defaults. */
async function brandMeta() {
  try {
    const raw = await fsp.readFile(path.join(PROJECT_DIR, "config", "brand.json"), "utf8");
    const j = JSON.parse(raw);
    return {
      agency:  j.agency?.name || "Flat-Out Media",
      tagline: j.agency?.tagline || "we live and breathe automotive",
    };
  } catch {
    return { agency: "Flat-Out Media", tagline: "we live and breathe automotive" };
  }
}

/** Slugify the title to a filesystem-safe filename. Strip everything that
 *  isn't alphanumeric / dash, collapse runs, cap at 80 chars. Timestamp
 *  suffix prevents collisions when the operator generates the same-titled
 *  file twice. */
function slugify(title, ext) {
  const base = String(title || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${base || "untitled"}-${stamp}.${ext}`;
}

/* ─────────────────────────────────────────────────────────────────
 *  PPTX — client deck generator
 * ─────────────────────────────────────────────────────────────────
 *  Slide types accepted in `slides[]`:
 *
 *    { type: "cover", title, subtitle? }
 *    { type: "section", title }                   — section divider
 *    { type: "content", title, body|bullets }     — body = string OR array of bullet strings
 *    { type: "image", title?, imagePath }         — full-bleed image with caption
 *    { type: "two-column", title, left, right }   — body text in two cols
 *
 *  The first slide of any deck is implicitly a cover slide if not provided.
 *  All slides inherit a master with brand-coloured accent bar.
 */
export async function generatePptx({ title, slides, subtitle = null }) {
  if (!title || typeof title !== "string") return { ok: false, error: "title (string) required" };
  if (!Array.isArray(slides) || slides.length === 0) return { ok: false, error: "slides must be a non-empty array" };

  const accent = await brandHex();
  const brand = await brandMeta();
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";       // 13.33 × 7.5 inches, 16:9
  pres.title = title;
  pres.author = brand.agency;
  pres.company = brand.agency;

  /* Master slide — accent bar on the left + agency footer. Every content
   * slide inherits this. */
  pres.defineSlideMaster({
    title: "FOM_MASTER",
    background: { color: "0B0B0B" },
    objects: [
      { rect: { x: 0, y: 0, w: 0.18, h: 7.5, fill: { color: accent } } },
      { text: {
          text: brand.agency,
          options: { x: 0.5, y: 7.0, w: 12.5, h: 0.3, fontSize: 9, fontFace: "Helvetica", color: "888888", align: "left" },
      } },
      { text: {
          text: brand.tagline,
          options: { x: 0.5, y: 7.2, w: 12.5, h: 0.2, fontSize: 8, fontFace: "Helvetica", color: "555555", italic: true },
      } },
    ],
  });

  /* If the first slide isn't explicitly a cover, prepend one. */
  const slidesNormalised = slides[0]?.type === "cover"
    ? slides
    : [{ type: "cover", title, subtitle }, ...slides];

  for (const s of slidesNormalised) {
    const slide = pres.addSlide({ masterName: "FOM_MASTER" });
    switch (s.type) {
      case "cover":
        slide.addText(s.title || title, { x: 0.6, y: 2.5, w: 12.0, h: 1.5, fontSize: 44, fontFace: "Helvetica", bold: true, color: "FFFFFF" });
        if (s.subtitle || subtitle) slide.addText(s.subtitle || subtitle, { x: 0.6, y: 4.2, w: 12.0, h: 0.6, fontSize: 18, fontFace: "Helvetica", color: accent, italic: true });
        slide.addText(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), { x: 0.6, y: 5.5, w: 6.0, h: 0.3, fontSize: 11, fontFace: "Helvetica", color: "888888" });
        break;
      case "section":
        slide.addText(s.title, { x: 0.6, y: 3.0, w: 12.0, h: 1.2, fontSize: 36, fontFace: "Helvetica", bold: true, color: accent });
        break;
      case "image": {
        if (s.title) slide.addText(s.title, { x: 0.6, y: 0.4, w: 12.0, h: 0.7, fontSize: 24, fontFace: "Helvetica", bold: true, color: "FFFFFF" });
        if (s.imagePath) {
          /* pptxgenjs accepts a path or a base64 data URL. We pass the path
           * and let the library inline it on save. Operator's responsibility
           * that the image file exists at write time. */
          slide.addImage({ path: s.imagePath, x: 0.5, y: s.title ? 1.3 : 0.5, w: 12.3, h: s.title ? 5.4 : 6.2, sizing: { type: "contain", w: 12.3, h: s.title ? 5.4 : 6.2 } });
        }
        break;
      }
      case "two-column":
        slide.addText(s.title || "", { x: 0.6, y: 0.4, w: 12.0, h: 0.7, fontSize: 24, fontFace: "Helvetica", bold: true, color: "FFFFFF" });
        slide.addText(s.left || "",   { x: 0.6, y: 1.3, w: 5.9, h: 5.5, fontSize: 14, fontFace: "Helvetica", color: "DDDDDD", valign: "top" });
        slide.addText(s.right || "",  { x: 6.8, y: 1.3, w: 5.9, h: 5.5, fontSize: 14, fontFace: "Helvetica", color: "DDDDDD", valign: "top" });
        break;
      case "content":
      default: {
        slide.addText(s.title || "", { x: 0.6, y: 0.4, w: 12.0, h: 0.7, fontSize: 24, fontFace: "Helvetica", bold: true, color: "FFFFFF" });
        if (Array.isArray(s.bullets)) {
          slide.addText(s.bullets.map((b) => ({ text: b, options: { bullet: { code: "25CF" } } })), {
            x: 0.6, y: 1.3, w: 12.0, h: 5.5, fontSize: 16, fontFace: "Helvetica", color: "DDDDDD", valign: "top",
          });
        } else if (s.body) {
          slide.addText(s.body, { x: 0.6, y: 1.3, w: 12.0, h: 5.5, fontSize: 16, fontFace: "Helvetica", color: "DDDDDD", valign: "top" });
        }
        break;
      }
    }
  }

  await fsp.mkdir(PPTX_DIR, { recursive: true });
  const filename = slugify(title, "pptx");
  const outPath = path.join(PPTX_DIR, filename);
  await pres.writeFile({ fileName: outPath });
  const stat = await fsp.stat(outPath);
  return { ok: true, path: outPath, filename, sizeKB: Math.round(stat.size / 1024), slideCount: slidesNormalised.length };
}

/* ─────────────────────────────────────────────────────────────────
 *  DOCX — Word document generator
 * ─────────────────────────────────────────────────────────────────
 *  Shape: { title, sections: [{ heading, paragraphs[] }] }. Each section
 *  becomes an H1 + paragraphs. The first paragraph of the document is the
 *  brand footer-line (agency name); the title appears as H1 at the top.
 *
 *  No images for v1 — text-only briefs / scripts / reports. Image support
 *  via ImageRun is straightforward to add later if the operator asks.
 */
export async function generateDocx({ title, sections, subtitle = null }) {
  if (!title || typeof title !== "string") return { ok: false, error: "title (string) required" };
  if (!Array.isArray(sections) || sections.length === 0) return { ok: false, error: "sections must be a non-empty array" };
  const accent = await brandHex();
  const brand = await brandMeta();
  /* Compose the children paragraph list flat. docx doesn't have a true
   * "section" abstraction at the document level for what we want — it
   * uses headings + body. Each input section produces one heading + N
   * body paragraphs. */
  const children = [];
  /* Title — large bold, centered, accent-coloured. */
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title, bold: true, size: 48, color: accent })],
  }));
  if (subtitle) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: subtitle, italics: true, size: 24, color: "666666" })],
    }));
  }
  /* Date stamp. */
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), size: 20, color: "999999" })],
  }));
  children.push(new Paragraph({ children: [new TextRun("")] }));   // blank line

  for (const section of sections) {
    if (section.heading) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: section.heading, bold: true, size: 28, color: accent })],
      }));
    }
    const paragraphs = Array.isArray(section.paragraphs) ? section.paragraphs : (section.body ? [section.body] : []);
    for (const p of paragraphs) {
      children.push(new Paragraph({
        children: [new TextRun({ text: p, size: 22 })],
        spacing: { after: 200 },
      }));
    }
  }
  /* Footer paragraph — agency name + tagline in small grey. */
  children.push(new Paragraph({ children: [new TextRun("")] }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: `${brand.agency} · ${brand.tagline}`, size: 16, italics: true, color: "888888" })],
  }));

  const doc = new Document({
    creator: brand.agency,
    title,
    description: subtitle || title,
    sections: [{ children }],
  });

  await fsp.mkdir(DOCX_DIR, { recursive: true });
  const filename = slugify(title, "docx");
  const outPath = path.join(DOCX_DIR, filename);
  const buf = await Packer.toBuffer(doc);
  await fsp.writeFile(outPath, buf);
  const stat = await fsp.stat(outPath);
  return { ok: true, path: outPath, filename, sizeKB: Math.round(stat.size / 1024), sectionCount: sections.length };
}

/* ─────────────────────────────────────────────────────────────────
 *  XLSX — Excel workbook generator
 * ─────────────────────────────────────────────────────────────────
 *  Shape: { title, sheets: [{ name, headers, rows }] }. Each sheet gets
 *  styled headers (bold, brand-coloured row), auto-sized columns, and
 *  a frozen top row. Rows can be objects keyed by header or arrays of
 *  values in header order — both supported.
 */
export async function generateXlsx({ title, sheets }) {
  if (!title || typeof title !== "string") return { ok: false, error: "title (string) required" };
  if (!Array.isArray(sheets) || sheets.length === 0) return { ok: false, error: "sheets must be a non-empty array" };
  const accent = await brandHex();
  const brand = await brandMeta();
  const wb = new ExcelJS.Workbook();
  wb.creator = brand.agency;
  wb.created = new Date();
  wb.title = title;

  for (const sh of sheets) {
    const sheetName = String(sh.name || "Sheet").slice(0, 31).replace(/[\/\\?\*\[\]:]/g, "");
    const ws = wb.addWorksheet(sheetName);
    const headers = Array.isArray(sh.headers) ? sh.headers : [];
    if (headers.length) {
      ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, Math.min(40, String(h).length + 6)) }));
      /* Style the header row — brand colour fill, white bold text. */
      const headerRow = ws.getRow(1);
      headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
      headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${accent}` } };
      headerRow.alignment = { vertical: "middle", horizontal: "left" };
      ws.views = [{ state: "frozen", ySplit: 1 }];
    }
    /* Add rows. Each row can be an array of values or an object keyed
     * by header. The library handles both via addRow. */
    const rows = Array.isArray(sh.rows) ? sh.rows : [];
    for (const row of rows) ws.addRow(row);
    /* Light banding on alternate rows for readability. */
    for (let i = 2; i <= rows.length + 1; i++) {
      if (i % 2 === 0) {
        const r = ws.getRow(i);
        r.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F5F5" } };
      }
    }
  }

  await fsp.mkdir(XLSX_DIR, { recursive: true });
  const filename = slugify(title, "xlsx");
  const outPath = path.join(XLSX_DIR, filename);
  await wb.xlsx.writeFile(outPath);
  const stat = await fsp.stat(outPath);
  return { ok: true, path: outPath, filename, sizeKB: Math.round(stat.size / 1024), sheetCount: sheets.length };
}
