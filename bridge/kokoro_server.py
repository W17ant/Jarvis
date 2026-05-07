"""kokoro_server.py - Local TTS server using Kokoro-82M (free, Apache 2.0).

POST /tts  body: {"text": "...", "voice": "bf_emma"}  →  audio/wav bytes
GET  /health  →  {"ok": true, "voices": [...]}

Run: .venv/bin/python bridge/kokoro_server.py
Port: 8767 (so it doesn't fight Node bridge on 8766 or static server on 8765)
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
import sys
import threading

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

# Why: load the ONNX model + voice bank once at startup; warm calls only pay synthesis.
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_PATH = os.path.join(PROJECT_ROOT, "assets", "kokoro", "kokoro-v1.0.onnx")
VOICES_PATH = os.path.join(PROJECT_ROOT, "assets", "kokoro", "voices-v1.0.bin")

print(f"[kokoro] loading model from {MODEL_PATH}", flush=True)
kokoro = Kokoro(MODEL_PATH, VOICES_PATH)
VOICES = kokoro.get_voices() if hasattr(kokoro, "get_voices") else []
print(f"[kokoro] ready — {len(VOICES)} voices loaded", flush=True)

# Why: bf_emma is a UK female voice. Falls back to any af_ (American female) if missing.
DEFAULT_VOICE = next((v for v in VOICES if v.startswith("bf_") and "emma" in v.lower()), None) \
             or next((v for v in VOICES if v.startswith("bf_")), None) \
             or next((v for v in VOICES if v.startswith("am_")), None) \
             or (VOICES[0] if VOICES else "bf_emma")
print(f"[kokoro] default voice: {DEFAULT_VOICE}", flush=True)

_lock = threading.Lock()

# ──────────────────────────────────────────────────────────────────
# Filler-phrase cache
# ──────────────────────────────────────────────────────────────────
# Why: the HUD's tts.js picks fillers from a fixed pool of 14 short
# acknowledgements ("On it, sir.", "Let me check that for you, …").
# Before this cache, EVERY turn that hit the filler path paid full
# Kokoro synthesis (~400-750ms for a short filler, ~700-1100ms for a
# long one). Bench showed Kokoro yields the entire sentence as a single
# chunk — no sub-sentence streaming gain — so the only way to drop
# filler-TTS latency is to skip synthesis entirely on repeats.
#
# Strategy: lazy cache. First time we see a phrase + voice combo, synth
# normally and store the WAV bytes. Subsequent identical requests
# return cached bytes in ~microseconds. Default-voice cache is fully
# warm within the operator's first ~14 turns; switching voices warms
# its own cache lazily.
#
# Memory: 14 phrases × ~4 voices × ~100KB each ≈ 5MB max. Trivial.
# Coupling: this list MUST stay in sync with FILLERS_SHORT + FILLERS_LONG
# in tts.js. If they drift, the new strings just won't be cached (cache
# misses fall through to full synth) — degraded performance but not a
# correctness bug.
_CACHEABLE_PHRASES = frozenset({
    # FILLERS_SHORT
    "On it, sir.",
    "Right away.",
    "Working on it.",
    "One moment.",
    "Coming up.",
    "Just a sec.",
    # FILLERS_LONG
    "Let me check that for you, sir, just a moment.",
    "Right, give me a few seconds to dig that out.",
    "Looking into that for you now, sir, won't be a moment.",
    "On it — pulling that together for you now.",
    "One second, sir, let me have a proper look.",
    "Working on it, sir — just a moment to gather everything.",
    "Right you are, let me see what we've got.",
    "Hold tight, I'll have something for you in a moment.",
    # Common acks the LLM itself often emits
    "Yes, sir.",
    "Of course.",
    "Got it.",
    "Sorted.",
})

_phrase_cache: dict[tuple[str, str], bytes] = {}
_cache_hits = 0
_cache_misses = 0


def synthesise(text: str, voice: str | None = None, speed: float = 1.0) -> bytes:
    global _cache_hits, _cache_misses
    voice = voice or DEFAULT_VOICE
    cache_key = (text, voice)
    # Fast path: cached phrase, default speed only (speed != 1.0 is rare and
    # would otherwise pollute the cache).
    if speed == 1.0 and cache_key in _phrase_cache:
        _cache_hits += 1
        return _phrase_cache[cache_key]
    with _lock:
        samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-gb")
    if samples.dtype != np.float32:
        samples = samples.astype(np.float32)
    buf = BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    audio = buf.getvalue()
    # Cache only the canonical filler phrases — never user-content. text was
    # already trimmed by the handler.
    if speed == 1.0 and text in _CACHEABLE_PHRASES:
        _phrase_cache[cache_key] = audio
        _cache_misses += 1
    return audio


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"ok": True, "voices": VOICES, "default": DEFAULT_VOICE}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/tts/cache-status":
            # Diagnostic — surfaces filler-cache hit rate to the bridge / HUD.
            entries = [{"text": t, "voice": v, "bytes": len(b)} for (t, v), b in _phrase_cache.items()]
            body = json.dumps({
                "hits": _cache_hits,
                "misses": _cache_misses,
                "size": len(_phrase_cache),
                "totalBytes": sum(len(b) for b in _phrase_cache.values()),
                "entries": entries,
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404); self._cors(); self.end_headers()

    def do_POST(self):
        if self.path != "/tts":
            self.send_response(404); self._cors(); self.end_headers(); return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception as e:
            self.send_response(400); self._cors(); self.end_headers()
            self.wfile.write(f"bad json: {e}".encode()); return
        text = (payload.get("text") or "").strip()
        if not text:
            self.send_response(400); self._cors(); self.end_headers()
            self.wfile.write(b"empty text"); return
        try:
            audio = synthesise(text, payload.get("voice"), float(payload.get("speed", 1.0)))
        except Exception as e:
            print(f"[kokoro] synthesise failed: {e}", file=sys.stderr, flush=True)
            self.send_response(500); self._cors(); self.end_headers()
            self.wfile.write(f"synth error: {e}".encode()); return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self._cors()
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    # quieter logs
    def log_message(self, fmt, *args):
        pass


def main():
    port = int(os.environ.get("KOKORO_PORT", "8767"))
    addr = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(addr, Handler)
    print(f"[kokoro] listening on http://{addr[0]}:{addr[1]}/  (POST /tts, GET /health)", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
