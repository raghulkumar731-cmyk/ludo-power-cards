"""
backend_server.py — Photo → 3D (AI) backend for the 3D Studio's "Photo → 3D" mode.

Wraps TripoSR (https://github.com/VAST-AI-Research/TripoSR, MIT-licensed) in a small
FastAPI app with one real endpoint: POST /generate, which takes an uploaded photo and
returns a rigged-ready .glb mesh.

Per the README:
    cp backend_server.py <your TripoSR clone>/
    pip install -r requirements.txt
    uvicorn backend_server:app --host 0.0.0.0 --port 8000

Quick test once running:
    curl -F "photo=@/path/to/some_photo.jpg" http://localhost:8000/generate -o model.glb

The game's index.html expects the response body to be the raw .glb bytes, which it feeds
straight into THREE.GLTFLoader — see generateFromPhoto() in the studio's inline script.
"""

import io
import os
import tempfile
import time
from collections import defaultdict, deque

import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from PIL import Image

# TripoSR's own package — only importable once you've cloned TripoSR and copied this
# file into that clone (see README step 1). Not something you `pip install` separately.
from tsr.system import TSR
from tsr.utils import remove_background, resize_foreground

# ---------------------------------------------------------------------------
# Config — tweak these via environment variables at deploy time, no code changes needed.
# ---------------------------------------------------------------------------

# Lock this down to your game's real domain before going live, e.g.
#   ALLOWED_ORIGINS=https://your-username.github.io
# Comma-separated list; defaults to "*" (anyone) which is fine for local testing only.
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")

# Optional shared-secret header. If set, every request to /generate must include
#   X-API-Key: <the same value>
# Leave unset while testing locally; set it once this is deployed and reachable by anyone.
API_SECRET = os.environ.get("API_SECRET", "")

# Mesh extraction resolution — higher looks better but is slower. 256 is TripoSR's
# own default and a good balance for a mobile game asset.
MESH_RESOLUTION = int(os.environ.get("MESH_RESOLUTION", "256"))

# Reject anything bigger than this before it ever reaches the model.
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "10"))

# Naive in-memory per-IP rate limit: N requests per WINDOW_SECONDS. Fine for a single
# server instance; swap for something Redis-backed if you ever run more than one.
RATE_LIMIT_REQUESTS = int(os.environ.get("RATE_LIMIT_REQUESTS", "5"))
RATE_LIMIT_WINDOW_SECONDS = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "60"))

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# ---------------------------------------------------------------------------
# Model — loaded once at process start (this is the expensive part: ~1.5GB download
# the first time, cached by Hugging Face afterwards). Every request below reuses
# this same instance rather than reloading it, which is what makes a "scale to
# zero" GPU container (RunPod/Modal) practical: one load per cold start, not per request.
# ---------------------------------------------------------------------------

print(f"[backend_server] Loading TripoSR on {DEVICE}... (first run downloads model weights)")
_model = TSR.from_pretrained(
    "stabilityai/TripoSR",
    config_name="config.yaml",
    weight_name="model.ckpt",
)
_model.renderer.set_chunk_size(8192)
_model.to(DEVICE)
print("[backend_server] Model ready.")

app = FastAPI(title="Photo → 3D (TripoSR) backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Rate limiting — simple sliding window per client IP.
# ---------------------------------------------------------------------------

_request_log: dict[str, deque] = defaultdict(deque)


def _check_rate_limit(client_ip: str) -> None:
    now = time.time()
    log = _request_log[client_ip]
    while log and now - log[0] > RATE_LIMIT_WINDOW_SECONDS:
        log.popleft()
    if len(log) >= RATE_LIMIT_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail=f"Too many requests — limit is {RATE_LIMIT_REQUESTS} per {RATE_LIMIT_WINDOW_SECONDS}s.",
        )
    log.append(now)


def _check_api_secret(request: Request) -> None:
    if not API_SECRET:
        return  # not enforced unless you set API_SECRET
    if request.headers.get("x-api-key") != API_SECRET:
        raise HTTPException(status_code=401, detail="Missing or invalid X-API-Key header.")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
def health():
    """Quick check that the server is up and the model loaded — hit this first."""
    return {"status": "ok", "device": DEVICE}


@app.post("/generate")
async def generate(request: Request, photo: UploadFile = File(...)):
    """
    Takes an uploaded photo (multipart/form-data, field name "photo") and returns a
    .glb mesh generated by TripoSR, ready to hand to THREE.GLTFLoader.
    """
    _check_api_secret(request)
    _check_rate_limit(request.client.host if request.client else "unknown")

    if not photo.content_type or not photo.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image.")

    raw = await photo.read()
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Photo too large — max {MAX_UPLOAD_MB}MB.")

    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read that file as an image.")

    try:
        glb_bytes = _run_triposr(image)
    except Exception as exc:  # noqa: BLE001 — surface a clean 500 instead of a stack trace to the client
        print(f"[backend_server] Generation failed: {exc}")
        raise HTTPException(status_code=500, detail="3D generation failed on the server.")

    return Response(content=glb_bytes, media_type="model/gltf-binary")


def _run_triposr(image: Image.Image) -> bytes:
    """Runs the actual TripoSR pipeline on a single image and returns raw .glb bytes."""
    # Background removal + foreground framing — TripoSR expects a clean subject on
    # a plain background, same preprocessing as TripoSR's own run.py example.
    image = remove_background(image)
    image = resize_foreground(image, 0.85)
    image = np.array(image).astype(np.float32) / 255.0
    if image.shape[-1] == 4:
        # composite the alpha channel onto a mid-gray background, matching TripoSR's own script
        image = image[:, :, :3] * image[:, :, 3:4] + (1 - image[:, :, 3:4]) * 0.5
    image = Image.fromarray((image * 255.0).astype(np.uint8))

    with torch.no_grad():
        scene_codes = _model([image], device=DEVICE)
        mesh = _model.extract_mesh(scene_codes, resolution=MESH_RESOLUTION)[0]

    with tempfile.NamedTemporaryFile(suffix=".glb", delete=True) as tmp:
        mesh.export(tmp.name)
        tmp.seek(0)
        return tmp.read()
