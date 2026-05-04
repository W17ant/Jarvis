#!/usr/bin/env bash
# install-music.sh — set up the music library for the teaser pipeline.
#
# Auto-download from CDN sources (Bensound / Pixabay / FreePD / archive.org) is unreliable —
# they 404 / paywall / redirect frequently. Instead this script creates the directory + manifest
# with a clear schema, and prints instructions for adding tracks manually.
#
# Once tracks are in place, the teaser pipeline mixes them in at -14dB under source video audio.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MUSIC_DIR="$HERE/assets/music"
mkdir -p "$MUSIC_DIR"

if [[ ! -f "$MUSIC_DIR/manifest.json" ]]; then
  cat > "$MUSIC_DIR/manifest.json" <<'EOF'
{
  "_comment": "Backing tracks for the teaser pipeline. Drop .mp3 files in this folder and add an entry below for each one. BPM drives beat-aligned cut timing. mood lets Qwen pick a track that fits the request ('epic', 'driving', 'cinematic', 'chase', 'action').",
  "tracks": [
    {
      "file": "example.mp3",
      "bpm": 140,
      "mood": "epic",
      "loudness": -14,
      "tags": ["cinematic", "trailer", "high-tempo"]
    }
  ]
}
EOF
  echo "[music] created manifest schema at $MUSIC_DIR/manifest.json"
fi

cat <<'INFO'

[music] Folder ready: assets/music/

To add tracks (one of these works in seconds):

  1. Pixabay Music — https://pixabay.com/music/  (royalty-free, CC0, no attribution)
     - Filter by "Cinematic" / "Action" / "Sport"
     - Click track → Download → drop .mp3 into assets/music/

  2. YouTube Audio Library — https://studio.youtube.com/channel/<id>/music
     - Filter by mood: Bright, Dramatic
     - Download → drop into assets/music/

  3. Free Music Archive — https://freemusicarchive.org/
     - Filter by genre + permission "Commercial OK"

  4. Or use any track you already own with a commercial license.

After dropping tracks, edit manifest.json:
  - file:      filename in this folder
  - bpm:       beats per minute (look it up at tunebat.com if unsure)
  - mood:      one of [epic, driving, cinematic, chase, action]
  - loudness:  approx LUFS (default -14)
  - tags:      free-form descriptors

The teaser pipeline mixes the chosen track at -14dB under source video audio.

INFO

ls -lh "$MUSIC_DIR" 2>/dev/null
