#!/usr/bin/env node
/** setup-wizard.mjs - Interactive white-label installer.
 *
 *  Asks the operator: agent name, wake phrase, agency name, tagline, brand colours, logo path,
 *  voice. Writes config/brand.json. Optionally invalidates the bridge cache via /brand/reload
 *  (best-effort — most installs run this BEFORE starting the bridge anyway).
 *
 *  Usage:
 *    node tools/setup-wizard.mjs
 *    node tools/setup-wizard.mjs --non-interactive --name "Jarvis" --agency "Acme" --primary "#FF6600"
 *    node tools/setup-wizard.mjs --skip-keys     # don't prompt for FAL_KEY / FRAMEIO_TOKEN
 *    node tools/setup-wizard.mjs --falKey fal-… --frameioToken fio-…   # set keys non-interactively
 */

import { readFile, writeFile, copyFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const BRAND_PATH = path.join(PROJECT_DIR, "config", "brand.json");
const ENV_PATH = path.join(PROJECT_DIR, ".env");

/* ---------- .env helpers ---------- */
/** Parse a .env file into { KEY: value }. Tolerates quoted values + blank lines. */
function readEnv(filePath) {
  const out = {};
  if (!existsSync(filePath)) return out;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
/** Re-emit a .env file. Values are written raw (no quoting) — they shouldn't contain newlines or # in practice. */
function writeEnv(filePath, kv) {
  const lines = [
    "# .env — bridge env vars. Do not commit. Generated/updated by tools/setup-wizard.mjs.",
    "",
  ];
  for (const [k, v] of Object.entries(kv)) {
    if (v === "" || v === undefined || v === null) continue;
    lines.push(`${k}=${v}`);
  }
  return writeFile(filePath, lines.join("\n") + "\n");
}

/* ---------- prompt helpers ---------- */
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise(r => rl.question(`  ${q}${def ? ` [${def}]` : ""}: `, a => r(a.trim() || def || "")));

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
};
const heading = (s) => console.log(`\n${C.bold}${C.cyan}▶ ${s}${C.reset}`);
const ok = (s) => console.log(`  ${C.green}✓${C.reset} ${s}`);
const warn = (s) => console.log(`  ${C.yellow}!${C.reset} ${s}`);

/* ---------- arg parsing for --non-interactive ---------- */
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--non-interactive") flags.nonInteractive = true;
  else if (a.startsWith("--")) {
    const k = a.slice(2); const v = argv[i + 1];
    if (v && !v.startsWith("--")) { flags[k] = v; i++; }
    else flags[k] = true;
  }
}

/* ---------- mishear expansion (mirrors brand.mjs) ---------- */
function expandMishears(name) {
  const n = name.toLowerCase().trim();
  const stripped = n.replace(/[^a-z0-9 ]/g, "");
  const compact = stripped.replace(/\s+/g, "");
  return [...new Set([
    `hey ${n}`, `hey ${stripped}`, `hey ${compact}`,
    `hi ${n}`, `hi ${stripped}`,
    `hey, ${n}`, `hey, ${stripped}`,
    n, stripped, compact, `${n}s`, `${compact}s`,
  ])];
}

/* ---------- color sanitization ---------- */
function normalizeHex(input, fallback) {
  if (!input) return fallback;
  const m = input.trim().match(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (!m) return fallback;
  return "#" + m[1].toUpperCase();
}
function hexToRgba(hex, alpha) {
  const n = hex.replace("#", "");
  const long = n.length === 3 ? n.split("").map(c => c + c).join("") : n;
  const r = parseInt(long.slice(0, 2), 16);
  const g = parseInt(long.slice(2, 4), 16);
  const b = parseInt(long.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
function darken(hex, amount = 0.4) {
  const n = hex.replace("#", "");
  const long = n.length === 3 ? n.split("").map(c => c + c).join("") : n;
  const f = (i) => Math.max(0, Math.round(parseInt(long.slice(i, i + 2), 16) * (1 - amount))).toString(16).padStart(2, "0");
  return ("#" + f(0) + f(2) + f(4)).toUpperCase();
}

/* ---------- main ---------- */
/**
 * Print the FOM ASCII banner if the file is present and the terminal is wide enough.
 * Why: the kiosk has a strong brand identity in the HUD; carrying that into the install
 * terminal makes the agency feel like a single product instead of generic CLI scripts.
 */
async function printBanner() {
  const banner = path.join(PROJECT_DIR, "assets", "fom-ascii.txt");
  if (!existsSync(banner)) return;
  /* The asset is ~144 columns wide — only render if the terminal can hold it without
   * line-wrapping that destroys the shape. Fall back to a tight box otherwise. */
  const cols = process.stdout.columns || 80;
  if (cols < 145) return;
  try {
    const txt = await readFile(banner, "utf8");
    process.stdout.write(`${C.red}${txt}${C.reset}\n`);
  } catch {}
}

async function main() {
  await printBanner();
  console.log(`${C.bold}${C.cyan}  ── SETUP WIZARD ──${C.reset}`);
  console.log(`${C.dim}  Configure the kiosk for this install. Re-run anytime to change settings.${C.reset}\n`);

  let existing = {};
  if (existsSync(BRAND_PATH)) {
    try { existing = JSON.parse(await readFile(BRAND_PATH, "utf8")); ok(`Found existing config — values shown as defaults.`); }
    catch { warn(`Existing brand.json could not be parsed — starting fresh.`); }
  }

  const interactive = !flags.nonInteractive;

  /* Why: when the operator passes flags to change the agent/agency, fields they DIDN'T pass
   * should derive from the new identity, not silently inherit Flat-Out values from an old
   * existing config. Track whether identity changed so downstream defaults derive correctly. */
  const identityChanged = !!(flags.name || flags.agency);

  /* ---------- AGENT ---------- */
  heading("Agent identity");
  console.log(C.dim + "  This is the assistant's name (used in the wake phrase and persona).\n  Examples: Flat-Out, Jarvis, Watson, Echo, Pilot." + C.reset);
  const agentName = flags.name || (interactive
    ? await ask("Agent name", existing.agent?.name || "Flat-Out")
    : (existing.agent?.name || "Flat-Out"));
  /* If the agent name changed, wake phrase derives from the new name unless explicitly overridden. */
  const wakeDefault = (existing.agent?.name === agentName && existing.agent?.wakePhrase)
    ? existing.agent.wakePhrase
    : `hey ${agentName.toLowerCase()}`;
  const wakePhrase = flags.wakePhrase || (interactive
    ? await ask(`Wake phrase`, wakeDefault)
    : wakeDefault);
  const voice = flags.voice || (interactive
    ? await ask(`Default voice (bm_daniel/bm_george/bm_lewis/bm_fable/bf_emma/bf_alice/bf_isabella/bf_lily)`, existing.agent?.voice || "bm_daniel")
    : (existing.agent?.voice || "bm_daniel"));

  /* ---------- AGENCY ---------- */
  heading("Agency identity");
  const agencyName = flags.agency || (interactive
    ? await ask("Agency / brand name", existing.agency?.name || "Flat-Out Media")
    : (existing.agency?.name || "Flat-Out Media"));
  /* Tagline / social / domain inherit only if agency name is unchanged — otherwise they're
   * Flat-Out artefacts that don't belong on a re-skinned install. */
  const agencyChanged = existing.agency?.name && existing.agency.name !== agencyName;
  const tagline = flags.tagline || (interactive
    ? await ask("Tagline", agencyChanged ? "" : (existing.agency?.tagline || "we live and breathe automotive"))
    : (agencyChanged ? "" : (existing.agency?.tagline || "")));
  const social = flags.social || (interactive
    ? await ask("Social handle (optional)", agencyChanged ? "" : (existing.agency?.social || ""))
    : (agencyChanged ? "" : (existing.agency?.social || "")));
  const domain = flags.domain || (interactive
    ? await ask("Website / domain (optional)", agencyChanged ? "" : (existing.agency?.domain || ""))
    : (agencyChanged ? "" : (existing.agency?.domain || "")));

  /* ---------- COLOURS ---------- */
  heading("Brand colours");
  console.log(C.dim + "  Hex like #E10600 or #fff. The deep variant + glow + tint are derived automatically." + C.reset);
  const primary = normalizeHex(flags.primary || (interactive
    ? await ask("Primary brand colour", existing.colors?.primary || "#E10600")
    : (existing.colors?.primary || "#E10600")), "#E10600");
  /* If the primary colour changed, derive the deep variant from it — don't inherit the old
   * deep red when the new primary is, say, orange. */
  const primaryChanged = existing.colors?.primary && existing.colors.primary !== primary;
  const deepDefault = primaryChanged ? darken(primary, 0.4) : (existing.colors?.primaryDeep || darken(primary, 0.4));
  const primaryDeep = normalizeHex(flags.primaryDeep || (interactive
    ? await ask("Primary deep variant (Enter to derive)", deepDefault)
    : deepDefault), darken(primary, 0.4));

  /* ---------- LOGO ---------- */
  heading("Logo");
  console.log(C.dim + "  Path relative to project root. PNG works for all browsers; SVG is sharper but optional." + C.reset);
  const wordmarkPng = flags.logoPng || (interactive
    ? await ask("Wordmark PNG path", existing.logo?.wordmarkPng || "assets/fom-wordmark.png")
    : (existing.logo?.wordmarkPng || "assets/fom-wordmark.png"));
  if (wordmarkPng && !existsSync(path.join(PROJECT_DIR, wordmarkPng))) {
    warn(`Logo not found at ${wordmarkPng} — placeholder kept; drop the file in before launch.`);
  }

  /* ---------- BUILD CONFIG ---------- */
  const brand = {
    _comment: "Generated by tools/setup-wizard.mjs. Re-run the wizard or edit by hand to update.",
    agent: {
      name: agentName,
      wakePhrase: wakePhrase.toLowerCase(),
      wakeMishears: existing.agent?.wakeMishears && agentName === existing.agent?.name
        ? existing.agent.wakeMishears
        : expandMishears(agentName),
      voice,
    },
    agency: { name: agencyName, tagline, social, domain },
    colors: {
      primary,
      primaryDeep,
      primaryGlow: hexToRgba(primary, 0.55),
      primaryTint: hexToRgba(primary, 0.06),
      ink0: existing.colors?.ink0 || "#000000",
      ink1: existing.colors?.ink1 || "#0a0a0a",
      ink2: existing.colors?.ink2 || "#141414",
      text: existing.colors?.text || "#f4f4f4",
      textDim: existing.colors?.textDim || "rgba(244, 244, 244, 0.55)",
    },
    fonts: existing.fonts || { display: "Oswald", body: "Rubik", mono: "JetBrains Mono" },
    logo: {
      wordmarkPng,
      wordmarkSvg: existing.logo?.wordmarkSvg || null,
      iconPng: existing.logo?.iconPng || null,
      iconSvg: existing.logo?.iconSvg || null,
    },
  };

  /* ---------- FOLDERS ----------
   * Why: every install wants their shoots and deliverables on a fast / large drive that
   * isn't always the project folder. Capturing this here AND in /settings means the
   * operator never has to edit brand.json by hand. Empty answer = use defaults
   * (project_dir/shoots, project_dir/output) — which is the right call for a kiosk that
   * lives entirely on internal storage. */
  heading("Folders");
  console.log(C.dim + "  Where the kiosk reads shoots from and writes deliverables to.\n  Absolute paths land outside the project; relative paths resolve under the project root.\n  Output auto-organises into youtube/{thumbnails,shorts}, instagram/{reels,posts}, tiktok,\n  brand-packs, pdf, watermarked, aspects, portraits, contactsheets, premiere-renders, videos." + C.reset);

  const shootsDir = flags.shootsDir || (interactive
    ? await ask("Shoots root", existing.paths?.shoots || "shoots")
    : (existing.paths?.shoots || ""));
  const outputDir = flags.outputDir || (interactive
    ? await ask("Output root", existing.paths?.output || "output")
    : (existing.paths?.output || ""));

  if (shootsDir || outputDir) {
    brand.paths = {};
    if (shootsDir) brand.paths.shoots = shootsDir;
    if (outputDir) brand.paths.output = outputDir;
  }

  /* ---------- HARDWARE TIER ---------- */
  /* Why: 32b text + 32b VL needs ~46GB GPU during VL inference and stalls on M1 Max 64GB.
   * Picker maps a chip name → tested-safe model defaults so the operator doesn't have to
   * remember which b-count fits their machine. Per Ollama: there is no qwen2.5vl:14b —
   * VL family is 3b/7b/32b/72b — so "middle" = 14b text + 7b VL, not 14b/14b. */
  heading("Hardware tier");
  console.log(C.dim + "  Sets the local model sizes. M5 Max gets press-release-grade 32b/32b;\n  M1/M2/M3 Max get the safe 14b/7b middle that won't thrash the GPU." + C.reset);

  /* Preset combos — each maps a hardware story to a tested-safe (text, VL) pair. The
   * "custom" option drops to a sub-prompt where the operator picks text + VL independently
   * from the full valid range (text 7b/14b/32b/72b × VL 3b/7b/32b/72b). */
  /* Tier definitions — each captures:
   *   text      : main text model (used for tool dispatch + draft writes)
   *   vl        : vision-language model
   *   keepAlive : VL model keep_alive (text uses textKeepAlive)
   *   textKeepAlive : how long Ollama keeps the text model resident between turns
   *   fast      : optional smaller model for fast-path queries (model router).
   *               Only populated on tiers with the RAM headroom for two text models.
   * Tiers without `fast` get OLLAMA_FAST_MODEL deleted from .env so the model
   * router becomes a no-op — single-model queries on lower-tier hardware. */
  const TIERS = {
    "ultra":     { label: "Mac Studio Ultra / 128 GB+ — 72b/72b (massive, ~80 GB)", text: "qwen2.5:72b", vl: "qwen2.5vl:72b", keepAlive: "30m", textKeepAlive: "30m", fast: "qwen2.5:14b" },
    "m5-max":    { label: "M5 Max / 96 GB+ — 32b/32b (production target, press-release grade)", text: "qwen2.5:32b", vl: "qwen2.5vl:32b", keepAlive: "30m", textKeepAlive: "30m", fast: "qwen2.5:14b" },
    "pro-plus":  { label: "M-series Max 64 GB with conversational priority — 32b text + 7b VL", text: "qwen2.5:32b", vl: "qwen2.5vl:7b", keepAlive: "10m", textKeepAlive: "10m", fast: "qwen2.5:7b" },
    "m1-max":    { label: "M1/M2/M3 Max 64 GB — 14b text + 7b VL (safe middle, recommended)", text: "qwen2.5:14b", vl: "qwen2.5vl:7b", keepAlive: "5m", textKeepAlive: "5m", fast: null },
    "m-pro":     { label: "M-series Pro 32 GB — 14b/7b", text: "qwen2.5:14b", vl: "qwen2.5vl:7b", keepAlive: "5m", textKeepAlive: "5m", fast: null },
    "lite":      { label: "Smaller / older Mac 16 GB — 7b/3b (fast, lower accuracy)", text: "qwen2.5:7b", vl: "qwen2.5vl:3b", keepAlive: "30s", textKeepAlive: "30s", fast: null },
    "custom":    { label: "Custom — pick text and VL sizes independently", text: null, vl: null, keepAlive: null, textKeepAlive: null, fast: null },
    "keep":      { label: "Keep current .env values unchanged", text: null, vl: null, keepAlive: null, textKeepAlive: null, fast: null, _keep: true },
  };

  const TEXT_OPTIONS = ["qwen2.5:7b", "qwen2.5:14b", "qwen2.5:32b", "qwen2.5:72b"];
  const VL_OPTIONS = ["qwen2.5vl:3b", "qwen2.5vl:7b", "qwen2.5vl:32b", "qwen2.5vl:72b"];

  const tierDefault = (() => {
    const t = (existingEnv.OLLAMA_MODEL || "");
    if (t.includes("72b")) return "ultra";
    if (t.includes("32b")) return "m5-max";
    if (t.includes("14b")) return "m1-max";
    if (t.includes("7b"))  return "lite";
    return "m1-max";
  })();

  let tierKey = flags.tier || tierDefault;
  if (!flags.nonInteractive) {
    console.log("");
    Object.entries(TIERS).forEach(([k, v]) => console.log(`    ${k.padEnd(10)} — ${v.label}`));
    const ans = await ask("\n  Tier", tierDefault);
    if (ans && TIERS[ans]) tierKey = ans;
  }
  let tier = TIERS[tierKey] || TIERS["m1-max"];

  /* If they picked "custom", prompt for the two sizes separately. Each list is presented
   * with the model size explicit so the operator knows the disk + GPU cost upfront. */
  if (tierKey === "custom" && !flags.nonInteractive) {
    console.log("\n  Text model — qwen2.5:Xb (handles voice routing + reasoning + most replies)");
    TEXT_OPTIONS.forEach(m => console.log(`    ${m}${m.includes("72b") ? "  (~40 GB — needs 96 GB+ RAM)" : m.includes("32b") ? "  (~19 GB)" : m.includes("14b") ? "  (~9 GB)" : "  (~5 GB)"}`));
    const customText = await ask("  text model", existingEnv.OLLAMA_MODEL || "qwen2.5:14b");
    console.log("\n  Vision model — qwen2.5vl:Xb (image + frame captioning, no 14b variant exists)");
    VL_OPTIONS.forEach(m => console.log(`    ${m}${m.includes("72b") ? "  (~40 GB)" : m.includes("32b") ? "  (~21 GB)" : m.includes("7b") ? "  (~6 GB)" : "  (~3 GB)"}`));
    const customVl = await ask("  vl model", existingEnv.VL_MODEL || "qwen2.5vl:7b");
    const customKa = await ask("  VL keep_alive (e.g. 30s, 5m, 10m)", existingEnv.VL_KEEP_ALIVE || "30s");
    tier = { label: "Custom", text: customText, vl: customVl, keepAlive: customKa };
  }

  ok(`Tier: ${tierKey} → ${tier.label}`);
  if (tier.text) {
    ok(`  models: ${tier.text} text + ${tier.vl} vision`);
    ok(`  keep_alive: text ${tier.textKeepAlive || tier.keepAlive}, vl ${tier.keepAlive}`);
    if (tier.fast) ok(`  fast-path model: ${tier.fast} (router enabled — short queries skip the big model)`);
    else if (tierKey !== "custom") ok(`  fast-path model: disabled (single-model on this tier to save RAM)`);
  } else if (tier._keep) {
    ok(`  keeping existing values: OLLAMA_MODEL=${existingEnv.OLLAMA_MODEL || "(unset)"}, VL_MODEL=${existingEnv.VL_MODEL || "(unset)"}`);
  }

  /* ---------- API KEYS ---------- */
  /* Why: optional integrations (Fal.ai for image-to-video, Frame.io for review-by-voice).
   * Both have graceful fallbacks if unset, but most demo installs want them. The keys land
   * in .env so the bridge picks them up via process.env. Skipping is fine — set later. */
  heading("Optional integrations");
  const existingEnv = readEnv(ENV_PATH);
  const skipKeys = !!flags.skipKeys || !interactive;

  console.log(C.dim + "  Press Enter to skip any key — set later by editing .env." + C.reset);

  let falKey = flags.falKey ?? existingEnv.FAL_KEY ?? "";
  let frameioToken = flags.frameioToken ?? existingEnv.FRAMEIO_TOKEN ?? "";
  let serpapiKey = flags.serpapiKey ?? existingEnv.SERPAPI_KEY ?? "";
  let hunterKey = flags.hunterKey ?? existingEnv.HUNTER_API_KEY ?? "";

  if (!skipKeys) {
    console.log("");
    console.log(C.dim + "  Fal.ai — needed only for image-to-video generation (Kling). Free tier: https://fal.ai" + C.reset);
    const falInput = await ask("FAL_KEY", falKey ? `${falKey.slice(0, 6)}…(unchanged, press Enter)` : "(skip)");
    if (falInput && !falInput.includes("…")) falKey = falInput;
    else if (falInput === "(skip)" || falInput === "") { /* keep */ }

    console.log("");
    console.log(C.dim + "  Frame.io — voice review/comment workflow. Token: https://developer.frame.io/app" + C.reset);
    const fioInput = await ask("FRAMEIO_TOKEN", frameioToken ? `${frameioToken.slice(0, 8)}…(unchanged, press Enter)` : "(skip)");
    if (fioInput && !fioInput.includes("…")) frameioToken = fioInput;
    else if (fioInput === "(skip)" || fioInput === "") { /* keep */ }

    console.log("");
    console.log(C.dim + "  SerpAPI — Google search results for the monthly outreach pack. https://serpapi.com (free tier: 100/mo)" + C.reset);
    const serpInput = await ask("SERPAPI_KEY", serpapiKey ? `${serpapiKey.slice(0, 8)}…(unchanged, press Enter)` : "(skip)");
    if (serpInput && !serpInput.includes("…")) serpapiKey = serpInput;
    else if (serpInput === "(skip)" || serpInput === "") { /* keep */ }

    console.log("");
    console.log(C.dim + "  Hunter.io — email lookup for the outreach pack. https://hunter.io (free tier: 25 searches/mo)" + C.reset);
    const hunterInput = await ask("HUNTER_API_KEY", hunterKey ? `${hunterKey.slice(0, 8)}…(unchanged, press Enter)` : "(skip)");
    if (hunterInput && !hunterInput.includes("…")) hunterKey = hunterInput;
    else if (hunterInput === "(skip)" || hunterInput === "") { /* keep */ }
  }

  /* Status lines. */
  if (falKey) ok(`FAL_KEY set (${falKey.slice(0, 6)}…)`);
  else warn("FAL_KEY not set — image-to-video disabled");
  if (frameioToken) ok(`FRAMEIO_TOKEN set (${frameioToken.slice(0, 8)}…)`);
  else warn("FRAMEIO_TOKEN not set — frameio_* tools disabled");
  if (serpapiKey) ok(`SERPAPI_KEY set (${serpapiKey.slice(0, 8)}…)`);
  else warn("SERPAPI_KEY not set — outreach pack disabled");
  if (hunterKey) ok(`HUNTER_API_KEY set (${hunterKey.slice(0, 8)}…)`);
  else warn("HUNTER_API_KEY not set — outreach pack will fail at enrichment step");

  const newEnv = { ...existingEnv };
  if (falKey) newEnv.FAL_KEY = falKey;
  if (frameioToken) newEnv.FRAMEIO_TOKEN = frameioToken;
  if (serpapiKey) newEnv.SERPAPI_KEY = serpapiKey;
  if (hunterKey) newEnv.HUNTER_API_KEY = hunterKey;
  /* Apply the chosen hardware tier to model env vars. "custom" leaves whatever the operator
   * already had so hand-tuned configs survive a re-run of the wizard. */
  if (tier.text) {
    newEnv.OLLAMA_MODEL = tier.text;
    newEnv.VL_MODEL = tier.vl;
    newEnv.VL_KEEP_ALIVE = tier.keepAlive;
    /* Text-model keep_alive — separate from VL so we can be aggressive on capable
     * hardware without forcing the (sometimes much bigger) VL model to stay resident. */
    if (tier.textKeepAlive) newEnv.OLLAMA_KEEP_ALIVE = tier.textKeepAlive;
    /* Fast model — only set on tiers that have RAM headroom for two resident text
     * models. Server.mjs's model-router only routes when this is set; on lower
     * tiers we explicitly DELETE the env var so an old config doesn't enable
     * routing on hardware that can't handle it. */
    if (tier.fast) {
      newEnv.OLLAMA_FAST_MODEL = tier.fast;
    } else {
      delete newEnv.OLLAMA_FAST_MODEL;
    }
  }
  await writeEnv(ENV_PATH, newEnv);
  ok(`Wrote ${path.relative(PROJECT_DIR, ENV_PATH)} (${Object.keys(newEnv).length} entries)`);

  /* Tailscale opt-in deferred to the end of main() — runs AFTER brand.json is on disk
   * and the bridge has been told to reload, so a yes-to-Tailscale answer doesn't strand
   * the install in a partially-configured state. */
  let promptTailscale = !flags.skipTailscale && !flags.nonInteractive;

  /* ---------- WRITE ---------- */
  heading("Writing config");
  if (existsSync(BRAND_PATH)) {
    const backup = BRAND_PATH + ".bak";
    await copyFile(BRAND_PATH, backup);
    ok(`Backed up existing config → ${path.relative(PROJECT_DIR, backup)}`);
  }
  await writeFile(BRAND_PATH, JSON.stringify(brand, null, 2) + "\n");
  ok(`Wrote ${path.relative(PROJECT_DIR, BRAND_PATH)} (${(JSON.stringify(brand).length / 1024).toFixed(1)}KB)`);

  /* ---------- BEST-EFFORT BRIDGE RELOAD ---------- */
  try {
    const r = await fetch("http://localhost:8766/brand", { method: "POST" });
    if (r.ok) ok("Bridge picked up new config (live reload).");
  } catch {} // bridge may not be running yet — that's fine

  /* ---------- REMOTE ACCESS (TAILSCALE) ----------
   * Why: at this point brand.json + .env are written and the bridge has been pinged for
   * reload — kiosk is fully configured. NOW it's safe to optionally hand off to the
   * Tailscale installer, which has its own prompts and may take a minute or two while
   * the operator authenticates in the browser. */
  if (promptTailscale) {
    heading("Remote access (optional)");
    console.log(C.dim + "  Tailscale gives you a private mesh between your devices — open the HUD on\n  your phone in Safari from anywhere, no port forwarding or public exposure. Free." + C.reset);
    const ans = await ask("Set up Tailscale now? [y/N]", "n");
    if (/^y/i.test(ans)) {
      const installer = path.join(PROJECT_DIR, "tools", "install-tailscale.sh");
      if (!existsSync(installer)) {
        warn(`installer missing: ${installer} — skipping`);
      } else {
        /* Hand the terminal to the installer — it has interactive prompts of its own.
         * Close readline first so its keystrokes don't fight ours. */
        rl.close();
        try {
          const { spawnSync } = await import("node:child_process");
          const r = spawnSync("bash", [installer], { stdio: "inherit" });
          if (r.status !== 0) warn(`Tailscale installer exited with status ${r.status}.`);
        } catch (e) {
          warn(`could not run installer: ${e.message}`);
        }
        console.log(`\n${C.bold}${C.green}  Setup complete.${C.reset}\n  Start: ./launch.sh kiosk\n`);
        return;
      }
    } else {
      ok("skipped — set up later with: ./tools/install-tailscale.sh");
    }
  }

  console.log(`\n${C.bold}${C.green}  Setup complete.${C.reset}`);
  console.log(`\n  Next:`);
  console.log(`    ./launch.sh kiosk     # start in fullscreen`);
  console.log(`    ./launch.sh           # windowed test\n`);

  rl.close();
}

main().catch(e => { console.error(`\n${C.red}✗${C.reset} ${e.message}\n${e.stack}`); rl.close(); process.exit(1); });
