"""whisper_server.py - Local STT. Tries MLX (Apple GPU) first, falls back to faster-whisper.

POST /transcribe              body: audio bytes (any format ffmpeg can decode)
                              →  {"text": "...", "language": "en", "duration": float}
POST /transcribe?segments=1   same body, returns timestamped segments instead
                              →  {"text": "...", "language": "en", "duration": float,
                                   "segments": [{"start": float, "end": float, "text": "..."}]}
GET  /health                  →  {"ok": true, "model": "...", "backend": "mlx" | "faster-whisper"}

Backends:
  mlx-whisper    — Apple GPU via the MLX framework. 2-3× faster than CPU int8
                   on M-series. Requires Apple Silicon. Tried first.
  faster-whisper — CPU int8 via CTranslate2. Universal fallback. Slower but
                   runs anywhere Python does.

Run: .venv/bin/python bridge/whisper_server.py
Port: 8768
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import platform
import sys
import tempfile
import threading

PORT = int(os.environ.get("WHISPER_PORT", "8768"))
MODEL_SIZE = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
# Allow operator to force a backend via env (useful for benchmarking or when
# MLX has a regression). Acceptable values: "mlx", "faster-whisper", "auto".
BACKEND_PREF = os.environ.get("WHISPER_BACKEND", "auto").lower()

# Why: this prompt is fed to Whisper as "previous context" so it expects these proper nouns.
# Improves recognition of "Flat-Out", car brands, and automotive jargon.
#
# IMPORTANT: keep this list to BARE TOKENS only — no example sentences. Earlier
# versions included "Hey Flat-Out, what's the time?" / "…what's the weather?"
# as priming examples. On short or quiet clips Whisper biased toward those
# example phrases and hallucinated "what's" / "What's the weather? × 27" when
# the operator actually said "Hey Flat-Out" alone. Reported by Adam — clip
# came back transcribed as `"whats'"` against the wake-test button. Removing
# the example sentences ended the bias; brand tokens still help recognition.
WHISPER_INITIAL_PROMPT = (
    "Hey Flat-Out. Flat-Out Media. Aston Martin. Vulcan. AMR Pro. DBX. Audi RS6. "
    "Porsche. Ferrari. Bentley. McLaren. Lamborghini. Quattro. Avant. Manchester. "
    "Goodwood. Silverstone. Capture One. Adobe Premiere. Lightroom."
)

# ──────────────────────────────────────────────────────────────────
# Backend selection
# ──────────────────────────────────────────────────────────────────

BACKEND = None
_mlx_repo = None
_fw_model = None
_lock = threading.Lock()


def _try_load_mlx():
    """Probe mlx-whisper. Returns True on success, False on any failure
    (missing package, non-arm64, model download failure, etc)."""
    if BACKEND_PREF == "faster-whisper":
        return False
    if platform.machine() not in ("arm64", "aarch64"):
        # MLX is Apple-Silicon-only. No point trying on Intel Macs.
        print(f"[whisper] mlx skipped — non-arm64 host ({platform.machine()})", flush=True)
        return False
    try:
        import mlx_whisper  # noqa: F401  — probe import only; we call mlx_whisper.transcribe per request
    except ImportError:
        print(f"[whisper] mlx-whisper not installed; falling back", flush=True)
        return False
    # Resolve a HuggingFace repo path that matches the requested MODEL_SIZE.
    # mlx-community converts the standard whisper checkpoints into MLX format
    # under a predictable naming scheme.
    global _mlx_repo
    _mlx_repo = f"mlx-community/whisper-{MODEL_SIZE}"
    print(f"[whisper] mlx ready · repo={_mlx_repo} · {platform.machine()}", flush=True)
    return True


def _try_load_faster_whisper():
    """Load the CPU int8 faster-whisper as a fallback."""
    if BACKEND_PREF == "mlx":
        return False
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(f"[whisper] faster-whisper not installed either — STT will fail", file=sys.stderr, flush=True)
        return False
    print(f"[whisper] loading faster-whisper '{MODEL_SIZE}' (first run downloads ~1.5GB)…", flush=True)
    global _fw_model
    _fw_model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
    print(f"[whisper] faster-whisper ready", flush=True)
    return True


# Try MLX first (per pref / availability), then fall back. The bridge logs
# which backend is live so the operator can see it in /tmp/flat-out-whisper.log.
if _try_load_mlx():
    BACKEND = "mlx"
elif _try_load_faster_whisper():
    BACKEND = "faster-whisper"
else:
    BACKEND = "none"
    print(f"[whisper] FATAL: no STT backend available. Install one: pip install mlx-whisper  OR  pip install faster-whisper", file=sys.stderr, flush=True)

def _transcribe_mlx(path: str, want_segments: bool) -> dict:
    """MLX backend. Calls mlx_whisper.transcribe per request — no persistent
    model object; MLX caches the loaded weights internally between calls.
    Returns the same shape as the faster-whisper path so the HTTP handler
    is backend-agnostic."""
    import mlx_whisper
    result = mlx_whisper.transcribe(
        path,
        path_or_hf_repo=_mlx_repo,
        language="en",
        condition_on_previous_text=True,
        initial_prompt=WHISPER_INITIAL_PROMPT,
        compression_ratio_threshold=2.4,
        no_speech_threshold=0.45,
        # MLX whisper temperatures parameter is the same shape as openai-whisper:
        # ascending list, falls back through them on low confidence.
        temperature=[0.0, 0.2, 0.4],
        # MLX doesn't have an in-engine VAD; we rely on whisper's no_speech_threshold
        # for silence rejection. For long-form / dictation we'd add silero VAD upstream.
    )
    text = (result.get("text") or "").strip()
    duration = float(result.get("segments", [{}])[-1].get("end", 0.0)) if result.get("segments") else 0.0
    out = {"text": text, "language": result.get("language", "en"), "duration": duration}
    if want_segments:
        out["segments"] = [
            {"start": float(s.get("start", 0.0)), "end": float(s.get("end", 0.0)), "text": (s.get("text") or "").strip()}
            for s in (result.get("segments") or [])
        ]
    return out


def _transcribe_faster_whisper(path: str, want_segments: bool) -> dict:
    """faster-whisper CPU int8 backend. Original implementation, kept as
    fallback when MLX isn't installed or available."""
    segments, info = _fw_model.transcribe(
        path,
        language="en",
        vad_filter=True,
        # Why: was 300ms — pairs with the HUD-side silence-watcher tail (now 800ms).
        # 150ms lets the VAD release sooner so trailing-silence trim happens within
        # the captured clip, shaving ~150ms off the transcribe wall-clock.
        vad_parameters={"min_silence_duration_ms": 150},
        beam_size=5,
        best_of=5,
        temperature=[0.0, 0.2, 0.4],
        condition_on_previous_text=True,
        initial_prompt=WHISPER_INITIAL_PROMPT,
        compression_ratio_threshold=2.4,
        no_speech_threshold=0.45,
    )
    seg_list = list(segments)
    text = " ".join(s.text.strip() for s in seg_list).strip()
    out = {"text": text, "language": info.language, "duration": info.duration}
    if want_segments:
        out["segments"] = [
            {"start": float(s.start), "end": float(s.end), "text": s.text.strip()}
            for s in seg_list
        ]
    return out


def transcribe_bytes(data: bytes, want_segments: bool = False) -> dict:
    """Dispatch to the active backend. Holds the GIL via _lock since both
    backends are single-context (MLX shares one Metal queue; faster-whisper's
    CTranslate2 model isn't thread-safe across decoders)."""
    if BACKEND == "none":
        return {"text": "", "language": "en", "duration": 0, "error": "no STT backend installed"}
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as fp:
        fp.write(data)
        path = fp.name
    try:
        with _lock:
            if BACKEND == "mlx":
                return _transcribe_mlx(path, want_segments)
            return _transcribe_faster_whisper(path, want_segments)
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
            body = json.dumps({
                "ok": BACKEND != "none",
                "model": MODEL_SIZE,
                "backend": BACKEND,
                "host_arch": platform.machine(),
            }).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json"); self._cors()
            self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body); return
        self.send_response(404); self._cors(); self.end_headers()

    def do_POST(self):
        # Accept /transcribe and /transcribe?segments=1 — strip the query for routing.
        path_only = self.path.split("?", 1)[0]
        if path_only != "/transcribe":
            self.send_response(404); self._cors(); self.end_headers(); return
        # ?segments=1 (or =true) opts into per-segment timestamped output.
        want_segments = False
        if "?" in self.path:
            qs = self.path.split("?", 1)[1]
            for pair in qs.split("&"):
                k, _, v = pair.partition("=")
                if k == "segments" and v.lower() in ("1", "true", "yes"):
                    want_segments = True
        length = int(self.headers.get("Content-Length", "0"))
        ctype = self.headers.get("Content-Type", "?")
        print(f"[whisper] POST /transcribe  len={length}B  content-type={ctype}  segments={want_segments}", flush=True)
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
            result = transcribe_bytes(data, want_segments=want_segments)
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
