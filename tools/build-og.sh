#!/usr/bin/env bash
# build-og.sh — re-render the OG card PNGs from the SVG master.
#
# Why a script: the SVG is the editable source, but social platforms
# (Twitter, Slack, Facebook, GitHub repo social-preview upload) all
# require raster. Re-running this on every SVG edit keeps the PNG +
# the .github/social-preview.png in sync without anyone remembering
# the rsvg-convert flags.
#
# Requires: rsvg-convert (Homebrew: `brew install librsvg`).
# Falls back to ImageMagick if rsvg-convert isn't on PATH.

set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$HERE/docs-site/public/og-card.svg"
PNG_DOCS="$HERE/docs-site/public/og-card.png"
PNG_REPO="$HERE/.github/social-preview.png"

if [[ ! -f "$SVG" ]]; then
  echo "✗ Source SVG missing: $SVG" >&2
  exit 1
fi

# 1280×640 is GitHub's recommended social-preview size; OG meta uses 1200×630.
# Render both targets at the actual served size to avoid mid-rasterisation
# upscaling artifacts.

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1200 -h 630 "$SVG" -o "$PNG_DOCS"
  rsvg-convert -w 1280 -h 640 "$SVG" -o "$PNG_REPO"
elif command -v magick >/dev/null 2>&1; then
  echo "  → falling back to ImageMagick (rsvg-convert not found)"
  magick -background none -density 150 "$SVG" -resize 1200x630 "$PNG_DOCS"
  magick -background none -density 150 "$SVG" -resize 1280x640 "$PNG_REPO"
else
  echo "✗ Need either rsvg-convert (brew install librsvg) or magick (ImageMagick) on PATH." >&2
  exit 1
fi

echo "  ✓ docs OG card  → $PNG_DOCS ($(du -k "$PNG_DOCS" | cut -f1) KB)"
echo "  ✓ repo preview  → $PNG_REPO ($(du -k "$PNG_REPO" | cut -f1) KB)"
echo ""
echo "  Upload \$PNG_REPO as the GitHub repo social preview:"
echo "    https://github.com/W17ANT/Jarvis/settings"
