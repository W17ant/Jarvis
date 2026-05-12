# jarvis.rb — Homebrew formula scaffold for Jarvis AI Assistant.
#
# This file is NOT consumed from this repo location. To publish, copy it
# to a separate tap repository named `homebrew-jarvis` under your GitHub
# user, e.g. `W17ANT/homebrew-jarvis`. Operators install with:
#
#     brew tap w17ant/jarvis
#     brew install --cask jarvis     # once a signed DMG ships (post-v0.3)
#     brew install jarvis            # source-install for developer mode
#
# Why a tap and not a direct PR to homebrew/core: homebrew/core requires
# a notable user base (~30 stars, 1+ year old), reproducible builds, and
# no GUI components. Jarvis is too new and too kiosk-shaped to qualify.
# A personal tap is the standard interim workflow and trivial to migrate
# from later if the project graduates to homebrew/core.
#
# Status: SCAFFOLD. The url + sha256 below are placeholders. Before
# publishing:
#   1. Tag a release on the main repo: `git tag v0.2.0 && git push --tags`
#   2. GitHub auto-creates a tarball at:
#        https://github.com/W17ANT/Jarvis/archive/refs/tags/v0.2.0.tar.gz
#   3. Compute the sha256:
#        curl -L https://github.com/W17ANT/Jarvis/archive/refs/tags/v0.2.0.tar.gz | shasum -a 256
#   4. Replace the placeholder values below.
#   5. Test locally: `brew install --build-from-source ./homebrew/jarvis.rb`
#   6. Push to the tap repo.
class Jarvis < Formula
  desc "Voice-first AI assistant with an instrument-cluster HUD for Apple Silicon"
  homepage "https://github.com/W17ANT/Jarvis"
  url "https://github.com/W17ANT/Jarvis/archive/refs/tags/v0.2.0.tar.gz"
  sha256 "REPLACE_WITH_SHA256_OF_TARBALL"
  license "MIT"
  version "0.2.0"

  # Apple Silicon only for v1 — macmon, MLX-Whisper, and the audio loop are
  # all M-series specific. Intel Macs would need a separate formula with
  # different dependencies and a fallback for the missing temp source.
  depends_on arch: :arm64
  depends_on :macos => :ventura     # macOS 13+ for Whisper-MLX

  # Required runtime services. Each one runs as a separate child process
  # spawned by `launch.sh`. Ollama is the local LLM brain; macmon provides
  # sudoless CPU/GPU temps; node runs the bridge.
  depends_on "ollama"
  depends_on "node@22"
  depends_on "python@3.11"        # Whisper + Kokoro Python runtimes
  depends_on "vladkens/tap/macmon" => :recommended

  def install
    # Install everything under HOMEBREW_PREFIX/opt/jarvis. The launch.sh
    # script + bridge code live here; user data (config, memory, audit log)
    # stays in ~/Library/Application Support/Jarvis so brew uninstall
    # never deletes it.
    libexec.install Dir["*"]

    # Bin shim: `brew install jarvis` puts a `jarvis` command on the user's
    # PATH that calls into the libexec install's launch.sh.
    (bin/"jarvis").write <<~SHIM
      #!/bin/bash
      exec "#{libexec}/launch.sh" "$@"
    SHIM
    chmod 0755, bin/"jarvis"
  end

  def post_install
    # Run the npm install inside the libexec'd repo so the bridge has its
    # node_modules available. Done at post_install (not install) so we use
    # Homebrew's own pinned node@22 rather than whatever node was on PATH
    # at build time.
    system "#{Formula["node@22"].opt_bin}/npm", "ci", "--prefix", libexec
  end

  def caveats
    <<~CAVEATS
      Jarvis requires:
        • Ollama models — pulled on first run (default: qwen2.5:7b, ~5GB)
        • Microphone access — macOS will prompt on first wake-word attempt
        • A 27"+ display recommended for the kiosk HUD

      To launch:
        jarvis              # start the kiosk
        jarvis stop         # halt all services
        jarvis status       # what's running on which port
        jarvis restart      # nuke + restart cleanly

      To run on login automatically:
        cp #{libexec}/bridge/launchd/com.jarvis.bridge.plist ~/Library/LaunchAgents/
        # edit the WorkingDirectory key in the plist to match #{libexec}
        launchctl load ~/Library/LaunchAgents/com.jarvis.bridge.plist

      To uninstall cleanly (preserves user data):
        brew uninstall jarvis

      To wipe user data too:
        rm -rf "${HOME}/Library/Application Support/Jarvis"

      Documentation:
        https://github.com/W17ANT/Jarvis#readme
    CAVEATS
  end

  test do
    # Smoke test — formula passes if `jarvis status` runs and reports the
    # services as down (which they should be on a fresh install where
    # nothing has been launched yet).
    assert_match "static", shell_output("#{bin}/jarvis status 2>&1", 0)
  end
end
