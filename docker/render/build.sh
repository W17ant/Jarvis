#!/usr/bin/env bash
# Build the jarvis/render container image.
#
# Why a script not a one-liner: ensures the image tag stays consistent with what
# bridge/container.mjs expects, and prints a friendly error if Docker isn't running
# (Docker Desktop on macOS sometimes silently exits and `docker build` errors are
# cryptic). Run from project root: ./docker/render/build.sh

set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCKERFILE="$PROJECT_DIR/docker/render/Dockerfile"
TAG="jarvis/render:latest"

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found. Install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "✗ docker daemon not reachable. Is Docker Desktop running?"
  exit 1
fi

echo "▶ building $TAG..."
docker build -t "$TAG" -f "$DOCKERFILE" "$PROJECT_DIR/docker/render"

echo "✓ built $TAG"
echo ""
echo "  Enable in the bridge by setting RENDER_USE_DOCKER=1 in .env."
echo "  Test the image:  docker run --rm $TAG 'ffmpeg -version'"
