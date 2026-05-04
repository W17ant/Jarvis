/** container.mjs - Docker render-environment helper.
 *
 *  Why: macOS Homebrew ffmpeg / ImageMagick versions drift between operator machines.
 *  When RENDER_USE_DOCKER=1 is set in .env, shell commands route through the
 *  flat-out/render image (built via docker/render/build.sh) so the render produces
 *  identical output regardless of host Mac. Concurrent renders also stop fighting over
 *  shared system temp dirs because each container gets its own /tmp.
 *
 *  Default behaviour: pass-through to the host. The bridge keeps working without
 *  Docker installed; the operator opts in only when they want reproducibility.
 *
 *  Mount strategy:
 *    /shoots  ← Paths.getShootsDir()   (read-only — render is read-only on source media)
 *    /output  ← Paths.getOutputDir()   (read-write — where deliverables land)
 *    /assets  ← PROJECT_DIR/assets     (read-only — FOM logos, fonts)
 *  Plus the working dir is set to /output so relative paths in shell commands resolve
 *  the same way as on the host (where cwd is the project root and `output/foo.mp4`
 *  lands in the right place).
 *
 *  Exports:
 *    isContainerEnabled()                 - true if RENDER_USE_DOCKER=1 AND docker is reachable
 *    runInContainer(cmd, opts)            - exec a shell command inside the image
 *                                            { stdout, stderr, exitCode }
 *    rewriteHostPathsToContainer(cmd)     - rewrite /Users/.../shoots/ → /shoots/ etc
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import * as Paths from "./paths.mjs";

const execp = promisify(exec);
const IMAGE_TAG = "flat-out/render:latest";

const PROJECT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ASSETS_DIR = path.join(PROJECT_DIR, "assets");

/* Cache the docker-availability probe — checking on every call would add 50-200ms per
 * shell invocation. Re-probe on bridge restart since Docker Desktop may come and go. */
let dockerAvailable = null;
let dockerProbedAt = 0;
const DOCKER_PROBE_TTL_MS = 60_000;

async function probeDocker() {
  /* Skip probe if RENDER_USE_DOCKER isn't set — most installs don't enable this. */
  if (process.env.RENDER_USE_DOCKER !== "1") return false;
  if (dockerAvailable !== null && Date.now() - dockerProbedAt < DOCKER_PROBE_TTL_MS) {
    return dockerAvailable;
  }
  dockerProbedAt = Date.now();
  try {
    await execp("docker info >/dev/null 2>&1", { timeout: 3000 });
    /* Also verify the image exists — building it is the operator's job, but giving them
     * a clear "image missing, run docker/render/build.sh" message beats a cryptic
     * "docker run failed" deeper in the pipeline. */
    await execp(`docker image inspect ${IMAGE_TAG} >/dev/null 2>&1`, { timeout: 3000 });
    dockerAvailable = true;
  } catch {
    dockerAvailable = false;
    if (process.env.RENDER_USE_DOCKER === "1") {
      console.warn(`[container] RENDER_USE_DOCKER=1 set but ${IMAGE_TAG} not available. Run docker/render/build.sh. Falling back to host binaries for this session.`);
    }
  }
  return dockerAvailable;
}

/** True if the bridge can route shell commands through the render container right now. */
export async function isContainerEnabled() {
  return probeDocker();
}

/** Rewrite host-side absolute paths in a shell command to their container-side equivalents.
 *  Example: "/Volumes/Workdrive/Shoots/2026-05-01/IMG.jpg" → "/shoots/2026-05-01/IMG.jpg".
 *  Operates string-level (not AST-level) so it's best-effort — for complex commands the
 *  caller should use $SHOOTS / $OUTPUT vars set in env (see runInContainer). */
export function rewriteHostPathsToContainer(cmd) {
  const shoots = Paths.getShootsDir();
  const output = Paths.getOutputDir();
  /* Replace longest path first to avoid partial overlaps (output rooted under shoots, etc). */
  const pairs = [[shoots, "/shoots"], [output, "/output"], [ASSETS_DIR, "/assets"], [PROJECT_DIR, "/work"]]
    .sort((a, b) => b[0].length - a[0].length);
  let out = cmd;
  for (const [host, container] of pairs) {
    /* Use split+join instead of regex to avoid escaping headaches with paths containing dots/slashes. */
    out = out.split(host).join(container);
  }
  return out;
}

/**
 * Run a shell command inside the flat-out/render container. Mounts shoots (ro),
 * output (rw), and assets (ro) at known container paths. The current operator's
 * uid/gid is passed via --user so files created in /output are owned by them, not root.
 *
 * @param {string} cmd                       full shell command (auto-rewritten for container paths)
 * @param {object} [opts]
 * @param {number} [opts.timeout=300000]     5 min default
 * @param {number} [opts.maxBuffer=4194304]  4MB stdout/stderr buffer
 * @returns {Promise<{stdout, stderr, exitCode}>}
 */
export async function runInContainer(cmd, { timeout = 300_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const rewritten = rewriteHostPathsToContainer(cmd);
  const shoots = Paths.getShootsDir();
  const output = Paths.getOutputDir();

  /* Build the docker run argument list. --rm = remove on exit so we don't leak containers.
   * --network none = no internet access from inside the render env (the host bridge handles
   * any web fetching). -i = interactive so stdin pipes work; not -t because we don't have a TTY.
   *
   * Mount strategy:
   *   /work    ← PROJECT_DIR (rw — tools/adhoc + output writes inside project still work)
   *   /shoots  ← Paths.getShootsDir() (ro)
   *   /output  ← Paths.getOutputDir() (rw)
   *   /assets  ← PROJECT_DIR/assets (ro)
   * Cwd = /work so relative paths from the LLM (e.g. `output/foo.mp4`, `shoots/X/IMG.jpg`)
   * resolve identically to the host. Absolute paths still work via the rewrite step. */
  const dockerArgs = [
    "run", "--rm", "-i",
    "--network", "none",
    "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    "-v", `${PROJECT_DIR}:/work:rw`,
    "-v", `${shoots}:/shoots:ro`,
    "-v", `${output}:/output:rw`,
    "-v", `${ASSETS_DIR}:/assets:ro`,
    "-e", "SHOOTS=/shoots",
    "-e", "OUTPUT=/output",
    "-e", "ASSETS=/assets",
    "-w", "/work",
    IMAGE_TAG,
    rewritten,
  ];

  const { stdout, stderr } = await execp(
    `docker ${dockerArgs.map(a => /[\s'"]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a).join(" ")}`,
    { timeout, maxBuffer }
  ).catch((e) => {
    /* execp throws on non-zero exit — surface stdout/stderr that come back on the error. */
    return { stdout: e.stdout || "", stderr: e.stderr || String(e.message || e), exitCode: e.code ?? 1 };
  });
  return { stdout, stderr, exitCode: 0 };
}
