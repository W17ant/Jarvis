#!/usr/bin/env node
/** build-tool-reference.mjs — Generate docs/tool-reference.md from the live
 *  bridge's /actions endpoint + config/actions.meta.json categorisation.
 *
 *  Why a script and not a build step: the bridge has to be running for the
 *  manifest to include plugin tools (hot-loaded at runtime). The script
 *  hits localhost:8766/actions, joins with the meta categories, and writes
 *  a reader-friendly markdown table.
 *
 *  Usage:
 *    node tools/build-tool-reference.mjs           # writes docs/tool-reference.md
 *    node tools/build-tool-reference.mjs --print   # prints to stdout instead
 *
 *  Run on a green CI job + before each release so the docs stay in sync. */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(HERE, "..");
const OUT_PATH = path.join(PROJECT_DIR, "docs", "tool-reference.md");

const CATEGORY_ORDER = ["communication", "productivity", "creative", "system", "memory", "plugin", "other"];
const CATEGORY_LABELS = {
  communication: "Communication",
  productivity: "Productivity",
  creative: "Creative",
  system: "System",
  memory: "Memory",
  plugin: "Plugins",
  other: "Other",
};

async function fetchActions() {
  try {
    const r = await fetch("http://localhost:8766/actions", { cache: "no-store" });
    if (!r.ok) throw new Error(`bridge returned ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error(`[tool-reference] cannot reach bridge: ${e.message}`);
    console.error(`[tool-reference] start the bridge first: ./launch.sh`);
    process.exit(1);
  }
}

function buildMarkdown(actions, categoryMeta) {
  const grouped = {};
  for (const a of actions) {
    const cat = a.category || "other";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(a);
  }

  const lines = [];
  const now = new Date().toISOString().slice(0, 10);
  lines.push(`# Jarvis tool reference`);
  lines.push("");
  lines.push(`> Auto-generated from \`bridge/server.mjs\` + \`config/actions.meta.json\`. Last updated: ${now}.`);
  lines.push(`> Run \`node tools/build-tool-reference.mjs\` to regenerate after adding tools or plugins.`);
  lines.push("");
  lines.push(`**${actions.length} tools** across ${Object.keys(grouped).length} categories. Plugin-registered tools appear under their declared category, falling back to "Plugins" if uncategorised.`);
  lines.push("");
  lines.push(`## Categories at a glance`);
  lines.push("");
  lines.push("| Category | Count | What it covers |");
  lines.push("| --- | --- | --- |");
  for (const cat of CATEGORY_ORDER) {
    if (!grouped[cat]?.length) continue;
    const blurb = categoryMeta[cat]?.blurb || "";
    lines.push(`| **${CATEGORY_LABELS[cat] || cat}** | ${grouped[cat].length} | ${blurb} |`);
  }
  lines.push("");

  for (const cat of CATEGORY_ORDER) {
    if (!grouped[cat]?.length) continue;
    lines.push(`## ${CATEGORY_LABELS[cat] || cat}`);
    if (categoryMeta[cat]?.blurb) lines.push("");
    if (categoryMeta[cat]?.blurb) lines.push(`> ${categoryMeta[cat].blurb}`);
    lines.push("");
    for (const a of grouped[cat].sort((x, y) => x.name.localeCompare(y.name))) {
      const label = a.label && a.label !== a.name ? `**${a.label}**` : `**${a.name}**`;
      const id = a.label && a.label !== a.name ? ` \\\`${a.name}\\\`` : "";
      const flags = [];
      if (a.destructive) flags.push("⚠️ confirms");
      const flagSuffix = flags.length ? ` (${flags.join(", ")})` : "";
      lines.push(`### ${label}${id}${flagSuffix}`);
      lines.push("");
      lines.push((a.description || "_(no description)_").trim());
      if (Array.isArray(a.phrasings) && a.phrasings.length) {
        lines.push("");
        lines.push("Voice examples:");
        for (const p of a.phrasings.slice(0, 4)) {
          lines.push(`- "${p}…"`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

const args = process.argv.slice(2);
const doPrint = args.includes("--print");

const j = await fetchActions();
const actions = j.actions || [];
let categoryMeta = {};
try {
  const fs = await import("node:fs/promises");
  const metaPath = path.join(PROJECT_DIR, "config", "actions.meta.json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  categoryMeta = meta._categories || {};
} catch (e) {
  console.warn(`[tool-reference] no actions.meta.json categories — using bare defaults: ${e.message}`);
}

const md = buildMarkdown(actions, categoryMeta);

if (doPrint) {
  console.log(md);
} else {
  writeFileSync(OUT_PATH, md, "utf8");
  console.log(`[tool-reference] wrote ${OUT_PATH} (${actions.length} tools, ${Object.keys(categoryMeta).length} categories)`);
}
