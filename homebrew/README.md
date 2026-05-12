# Homebrew tap scaffold

This directory holds the Homebrew formula for Jarvis. **It is not consumed from here** — Homebrew expects formulas to live in a separate tap repository.

## Publishing the tap

1. Create a new GitHub repo named `homebrew-jarvis` under the same user that owns the main Jarvis repo:

   ```bash
   gh repo create homebrew-jarvis --public \
     --description "Homebrew tap for Jarvis AI Assistant"
   ```

2. Initialise the tap structure (Homebrew expects formulas in `Formula/` at the tap root):

   ```bash
   git clone git@github.com:W17ANT/homebrew-jarvis.git
   cd homebrew-jarvis
   mkdir -p Formula
   cp ../Jarvis/homebrew/jarvis.rb Formula/jarvis.rb
   git add Formula/jarvis.rb
   git commit -m "feat: initial Jarvis formula"
   git push
   ```

3. Tag a release on the main Jarvis repo:

   ```bash
   git tag v0.2.0
   git push --tags
   ```

4. Compute the tarball's `sha256` and update `Formula/jarvis.rb`:

   ```bash
   curl -L https://github.com/W17ANT/Jarvis/archive/refs/tags/v0.2.0.tar.gz \
     | shasum -a 256
   ```

5. Test the formula locally:

   ```bash
   brew install --build-from-source ./Formula/jarvis.rb
   ```

6. Operators can then install with:

   ```bash
   brew tap w17ant/jarvis
   brew install jarvis
   ```

## Why a tap, not homebrew/core?

`homebrew/core` requires:

- A reasonably large user base (community standard: ~30 stars, 1+ year old)
- Reproducible builds with deterministic outputs
- No GUI components (Jarvis fails this — Chrome `--app` is part of the kiosk)

A personal tap is the standard interim workflow and trivial to migrate from later if Jarvis graduates.

## Why not `brew install --cask`?

Cask is for distributing pre-built `.app` bundles. Jarvis doesn't have one yet — it's `git clone` + `npm install` + run. Once a signed DMG ships (Phase 3 in the roadmap), we'll add a cask formula alongside this source formula and operators can pick whichever fits.
