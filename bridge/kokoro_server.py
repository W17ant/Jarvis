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


def synthesise(text: str, voice: str | None = None, speed: float = 1.0) -> bytes:
    voice = voice or DEFAULT_VOICE
    with _lock:
        samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-gb")
    if samples.dtype != np.float32:
        samples = samples.astype(np.float32)
    buf = BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


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
