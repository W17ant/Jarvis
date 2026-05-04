"""whisper_server.py - Local STT via faster-whisper. Replaces Chrome's cloud SpeechRecognition.

POST /transcribe  body: audio bytes (any format ffmpeg can decode — webm/opus/wav/m4a)
                  →  {"text": "...", "language": "en", "duration": float}
GET  /health      →  {"ok": true, "model": "..."}

Run: .venv/bin/python bridge/whisper_server.py
Port: 8768
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import sys
import tempfile
import threading

from faster_whisper import WhisperModel

MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
PORT = int(os.environ.get("WHISPER_PORT", "8768"))

print(f"[whisper] loading model '{MODEL_SIZE}' (large-v3-turbo is ~1.5GB; first run downloads it)…", flush=True)
# Why: large-v3-turbo at int8 runs ~6-8x real-time on M-series with the best conversational accuracy
# of any Whisper variant. Multilingual but English accuracy still beats medium.en.
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
print(f"[whisper] ready", flush=True)

_lock = threading.Lock()


# Why: this prompt is fed to Whisper as "previous context" so it expects these proper nouns.
# Massively improves recognition of "Flat-Out", car brands, and automotive jargon.
WHISPER_INITIAL_PROMPT = (
    "Hey Flat-Out. Flat-Out Media. Aston Martin. Vulcan. AMR Pro. DBX. Audi RS6. "
    "Porsche. Ferrari. Bentley. McLaren. Lamborghini. Quattro. Avant. Manchester. "
    "Goodwood. Silverstone. Capture One. Adobe Premiere. Lightroom. "
    "Hey Flat-Out, what's the time? Hey Flat-Out, edit the shoot. Hey Flat-Out, what's the weather?"
)


def transcribe_bytes(data: bytes) -> dict:
    """Transcribe raw audio bytes (ffmpeg-decodable). Returns text + meta."""
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as fp:
        fp.write(data)
        path = fp.name
    try:
        with _lock:
            segments, info = model.transcribe(
                path,
                language="en",   # force English even though large-v3-turbo is multilingual
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
                beam_size=5,
                best_of=5,
                temperature=[0.0, 0.2, 0.4],
                condition_on_previous_text=True,
                initial_prompt=WHISPER_INITIAL_PROMPT,
                compression_ratio_threshold=2.4,
                no_speech_threshold=0.45,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        return {"text": text, "language": info.language, "duration": info.duration}
    finally:
        try: os.unlink(path)
        except OSError: pass


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"ok": True, "model": MODEL_SIZE}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json"); self._cors()
            self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body); return
        self.send_response(404); self._cors(); self.end_headers()

    def do_POST(self):
        if self.path != "/transcribe":
            self.send_response(404); self._cors(); self.end_headers(); return
        length = int(self.headers.get("Content-Length", "0"))
        ctype = self.headers.get("Content-Type", "?")
        print(f"[whisper] POST /transcribe  len={length}B  content-type={ctype}", flush=True)
        if length == 0:
            print("[whisper] empty body", flush=True)
            self.send_response(400); self._cors(); self.end_headers()
            self.wfile.write(b"empty"); return
        data = self.rfile.read(length)
        # Save the last upload for inspection
        try:
            with open("/tmp/whisper-last-upload.bin", "wb") as f:
                f.write(data)
        except Exception:
            pass
        try:
            result = transcribe_bytes(data)
        except Exception as e:
            print(f"[whisper] transcribe failed: {e}", file=sys.stderr, flush=True)
            self.send_response(500); self._cors(); self.end_headers()
            self.wfile.write(f"transcribe error: {e}".encode()); return
        print(f"[whisper] → text={result['text']!r}  duration={result.get('duration', 0):.2f}s", flush=True)
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json"); self._cors()
        self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


def main():
    addr = ("127.0.0.1", PORT)
    print(f"[whisper] listening on http://{addr[0]}:{addr[1]}/  (POST /transcribe, GET /health)", flush=True)
    ThreadingHTTPServer(addr, Handler).serve_forever()


if __name__ == "__main__":
    main()
