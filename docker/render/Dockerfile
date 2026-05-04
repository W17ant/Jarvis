# Flat-Out render container — ffmpeg, ImageMagick, exiftool, jq baked in.
#
# Why: macOS Homebrew ffmpeg / ImageMagick versions drift between operator machines,
# which silently changes filtergraph behaviour (drawtext font fallback, scale algorithm
# defaults, ImageMagick policy.xml). Pinning the render binaries in a container means
# the kiosk produces identical output regardless of which Mac it's running on.
#
# The bridge mounts the operator's shoots root read-only and output root read-write,
# so a runaway tool can only damage what's inside output/. PROJECT_DIR's assets/
# (FOM logos, fonts) is mounted read-only too.
#
# Build:    docker/render/build.sh
# Toggle:   set RENDER_USE_DOCKER=1 in .env to route run_shell through this image.

FROM debian:bookworm-slim

# Pin to bookworm so future Debian releases don't silently bump tool versions.
ARG DEBIAN_FRONTEND=noninteractive

# ffmpeg + ImageMagick + exiftool: the three render-stage workhorses. jq for JSON
# wrangling in shell pipelines (the LLM frequently needs it). Plus coreutils + findutils
# + procps so the standard shell utilities behave like the operator expects on macOS.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      imagemagick \
      libimage-exiftool-perl \
      jq \
      curl \
      coreutils \
      findutils \
      procps \
      ca-certificates \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# ImageMagick's default policy.xml on Debian bans PDF/PS/TIFF for security. Most of our
# uses are JPEG/PNG read-only — but the brand-pack pipeline needs PDF write for one path.
# Loosen the policy here only inside the container; the container's mount surface is
# already restricted to shoots+output+assets so the additional risk is bounded.
RUN sed -i 's|<policy domain="coder" rights="none" pattern="PDF" />|<policy domain="coder" rights="read\|write" pattern="PDF" />|' /etc/ImageMagick-6/policy.xml || true

# Run as a non-root user. The bridge uses --user $(id -u):$(id -g) at runtime so files
# created in the mounted output dir are owned by the operator, not root.
RUN useradd --create-home --shell /bin/bash render
USER render
WORKDIR /work

# Default entrypoint is bash so the bridge can pass arbitrary commands. The actual
# command + args come from `docker run flat-out/render <cmd> <args...>`.
ENTRYPOINT ["/bin/bash", "-c"]
CMD ["echo 'flat-out/render ready — pass a command via docker run flat-out/render \"<cmd>\"'"]
