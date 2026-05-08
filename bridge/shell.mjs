/** shell.mjs - Sandboxed shell + file tools for Qwen.
 *  Lets the LLM compose ad-hoc commands when no curated tool fits — bounded by:
 *    - allowlist of safe binaries
 *    - blocklist of dangerous patterns
 *    - cwd pinned to project directory
 *    - 30s timeout
 *    - stdout/stderr returned to the LLM (so it can self-correct)
 *
 *  Tools exposed:
 *    run_shell(command, justification)   - runs a single shell command
 *    write_file(relPath, content)        - writes a file under tools/adhoc/ or output/
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import * as Paths from "./paths.mjs";
import * as Container from "./container.mjs";

const execp = promisify(exec);

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ADHOC_DIR = path.join(PROJECT_DIR, "tools", "adhoc");
/* OUTPUT_DIR resolved at call sites via Paths.getOutputDir() — operator-configurable. */

/* Why: only let Qwen reach binaries we've vetted as safe + useful for this domain.
 * No sudo / system mutation / privilege escalation. Adding new ones is a deliberate decision. */
const ALLOWED_BINARIES = new Set([
  "ls", "cat", "head", "tail", "wc", "find", "stat", "file",
  "echo", "printf", "tr", "cut", "sort", "uniq", "awk", "sed", "grep",
  "ffmpeg", "ffprobe", "magick", "convert", "sips", "exiftool",
  "curl", "jq", "python3", "node", "osascript",
  "mkdir", "cp", "mv", "ln", "touch", "true", "false", "test",
  "date", "basename", "dirname", "realpath", "pwd", "which",
  "open",
]);

const DANGEROUS_PATTERNS = [
  /\bsudo\b/i, /\bdoas\b/i,
  /\brm\s+-(?:rf?|fr)\b/i, /\brm\s+--recursive\b/i,
  /\bdd\s+if=/i, /\bmkfs\b/i, /\bformat\b/i,
  /\bchmod\s+(?:-R\s+)?7/i, /\bchown\b/i,
  /\bpasswd\b/i, /\bsu\b\s/i,
  /\beval\b/, /\bexec\b/, /\bsource\s+/i,
  /\bcurl[^|]*\|\s*(?:bash|sh|zsh)/i,    // curl ... | bash
  /\bwget[^|]*\|\s*(?:bash|sh|zsh)/i,
  /\bnc\s+-/i, /\bncat\b/i, /\bmkfifo\b/i,
  /\/dev\/tcp\b/, /\/dev\/udp\b/,
  /:\(\)\{/,                              // fork bomb
  />\s*\/(?:etc|var|System|usr|bin|sbin)\b/i,
];

function pickBinary(cmd) {
  // Crude but effective: take the first whitespace-delimited token, strip env-var assignments
  const trimmed = cmd.trim().replace(/^([A-Z_][A-Z0-9_]*=\S+\s+)+/i, "");
  const first = trimmed.split(/\s+/)[0] || "";
  return path.basename(first);
}

function checkSafety(cmd) {
  if (!cmd || typeof cmd !== "string") return "empty command";
  if (cmd.length > 4000) return "command too long (>4000 chars)";
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) return `blocked dangerous pattern: ${re.source}`;
  }
  // Permit pipelines + && / ;: but every binary on the line must be allowlisted
  const segments = cmd.split(/[;&|]+/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const bin = pickBinary(seg);
    if (!bin) continue;
    if (!ALLOWED_BINARIES.has(bin)) {
      return `binary not in allowlist: '${bin}' (allowed: ${[...ALLOWED_BINARIES].slice(0, 10).join(", ")}, ...)`;
    }
  }
  return null;
}

/* ---------- TOOL: run_shell ---------- */
export async function runShell({ command, justification, cwd, timeoutSec }) {
  if (!command) return { ok: false, error: "command required" };
  const reason = checkSafety(command);
  if (reason) return { ok: false, error: `safety: ${reason}` };

  // Pin cwd to project or a known subdir — never outside
  let workDir = PROJECT_DIR;
  if (cwd) {
    const abs = path.resolve(PROJECT_DIR, cwd);
    if (!abs.startsWith(PROJECT_DIR)) return { ok: false, error: `cwd outside project: ${cwd}` };
    workDir = abs;
  }

  /* If RENDER_USE_DOCKER is set AND the jarvis/render image is built, route through
   * the container for reproducible binary versions across operator machines. The
   * container has shoots (ro) and output (rw) mounted; PROJECT_DIR/assets is mounted
   * read-only too. Mac-specific binaries (osascript, sips) aren't in the image and
   * won't work — those tools fall back to the host path automatically because the
   * container exec returns a non-zero exit, but the cleaner option is for the operator
   * to keep RENDER_USE_DOCKER unset on macOS-heavy installs. */
  const useContainer = await Container.isContainerEnabled();
  console.log(`[shell] ${justification ? "(" + justification + ") " : ""}${useContainer ? "[docker] " : ""}$ ${command}  (cwd=${path.relative(PROJECT_DIR, workDir) || "."})`);
  try {
    const result = useContainer
      ? await Container.runInContainer(command, { timeout: Math.min(300_000, (timeoutSec || 30) * 1000) })
      : await execp(command, {
          cwd: workDir,
          timeout: Math.min(60_000, (timeoutSec || 30) * 1000),
          maxBuffer: 8 * 1024 * 1024,
          shell: "/bin/bash",
        });
    const { stdout, stderr } = result;
    /* Why: clip large outputs so the LLM context doesn't explode on `find` / `cat large.log` */
    const clip = (s) => {
      const str = (s || "").toString();
      if (str.length <= 4000) return str;
      return str.slice(0, 2000) + `\n... [${str.length - 4000} chars elided] ...\n` + str.slice(-2000);
    };
    return { ok: true, stdout: clip(stdout), stderr: clip(stderr), exitCode: 0 };
  } catch (e) {
    return {
      ok: false,
      exitCode: e.code || 1,
      error: e.message,
      stdout: (e.stdout || "").toString().slice(0, 4000),
      stderr: (e.stderr || "").toString().slice(0, 4000),
    };
  }
}

/* ---------- TOOL: write_file ---------- */
export async function writeFileSandboxed({ relPath, content }) {
  if (!relPath || typeof content !== "string") return { ok: false, error: "relPath + content required" };

  // Restrict to tools/adhoc/ or the configurable output dir for safety. Note: relative
  // paths still resolve under PROJECT_DIR (so "output/foo.txt" works regardless of where
  // the operator's actual output dir lives), and absolute paths under the output dir
  // are accepted via the second allowlist entry.
  const abs = path.resolve(PROJECT_DIR, relPath);
  const allowedRoots = [ADHOC_DIR, Paths.getOutputDir(), path.join(PROJECT_DIR, "output")];
  if (!allowedRoots.some(root => abs.startsWith(root))) {
    return { ok: false, error: `path must be under tools/adhoc/ or output/: ${relPath}` };
  }
  if (content.length > 200_000) return { ok: false, error: "content too large (>200KB)" };

  const dir = path.dirname(abs);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(abs, content);
  console.log(`[shell] wrote ${path.relative(PROJECT_DIR, abs)} (${content.length} bytes)`);
  return { ok: true, path: abs, relativePath: path.relative(PROJECT_DIR, abs), bytes: content.length };
}

/** Helpful for the capabilities tool — list what's allowed. */
export function shellAllowlist() {
  return Array.from(ALLOWED_BINARIES);
}
