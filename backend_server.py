"""
backend_server.py
------------------
FastAPI backend for the "Photo -> 3D (AI)" mode in the game's 3D Studio tab.

Takes an uploaded photo, runs it through TripoSR (open-source, MIT-licensed
single-image-to-3D model) to reconstruct a mesh, and returns a .glb file
that the frontend loads directly with THREE.GLTFLoader (see STUDIO_API_BASE
in index.html).

SETUP
-----
TripoSR isn't on PyPI, so this file expects to sit *inside* a clone of the
official repo (or point TRIPOSR_REPO_PATH at wherever you cloned it):

    git clone https://github.com/VAST-AI-Research/TripoSR.git
    cd TripoSR
    pip install -r requirements.txt
    cp /path/to/backend_server.py .
    pip install fastapi "uvicorn[standard]" python-multipart

Run it:
    uvicorn backend_server:app --host 0.0.0.0 --port 8000

The first request downloads the model weights (~1.5GB, from Hugging Face's
stabilityai/TripoSR) and caches them under ~/.cache/huggingface — that needs
internet access once, not on every request.

Needs a CUDA GPU with >=8GB VRAM to be fast. Falls back to CPU automatically
if no GPU is found, but CPU inference is minutes-per-image — fine for local
testing, not for real players.

See README.md in this folder for hosting notes (pay-per-use GPU providers
so you're not paying for an idle box between player requests).
"""

import io
import os
import sys
import tempfile
import time
import logging
import shutil
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from PIL import Image

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("studio-backend")

# ---- Make sure we can import TripoSR's `tsr` package ------------------------
# Defaults to "next to this file" (i.e. you copied this file into the cloned
# TripoSR repo, as the setup instructions above say). Override with the env
# var if you'd rather keep this file somewhere else.
TRIPOSR_REPO_PATH = os.environ.get("TRIPOSR_REPO_PATH", str(Path(__file__).parent))
sys.path.insert(0, TRIPOSR_REPO_PATH)

try:
    import torch
    import rembg
    from tsr.system import TSR
    from tsr.utils import remove_background, resize_foreground
except ImportError as e:
    raise SystemExit(
        "Couldn't import torch / rembg / tsr. Make sure this file lives inside "
        "a clone of https://github.com/VAST-AI-Research/TripoSR with its "
        "requirements.txt installed, or set TRIPOSR_REPO_PATH to that clone's "
        f"location. Original import error: {e}"
    )

# ---- Config ------------------------------------------------------------------
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
FOREGROUND_RATIO = 0.85        # how much of the frame the subject should fill after crop
MESH_RESOLUTION = 256          # marching-cubes grid size — higher = finer mesh, slower
MAX_UPLOAD_MB = 15
ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}

if DEVICE == "cpu":
    log.warning("No CUDA GPU found — running on CPU. Expect minutes per image, not seconds.")

app = FastAPI(title="3D Studio — Photo to 3D backend")

# Wide open for local dev. Before you ship, replace "*" with your game's real
# origin(s) (e.g. the domain your index.html is actually served from).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

log.info("Loading TripoSR weights on %s (first run downloads them)...", DEVICE)
_model = TSR.from_pretrained(
    "stabilityai/TripoSR",
    config_name="config.yaml",
    weight_name="model.ckpt",
)
_model.renderer.set_chunk_size(8192)
_model.to(DEVICE)
_rembg_session = rembg.new_session()
log.info("Model ready.")


@app.get("/health")
def health():
    """Quick liveness/readiness check — hit this from your deploy platform."""
    return {"status": "ok", "device": DEVICE}


@app.post("/generate")
async def generate(photo: UploadFile = File(...)):
    """
    Accepts one photo (multipart/form-data field name "photo"), returns a
    .glb mesh. This is the endpoint studioPhotoGenBtn should POST to, at
    STUDIO_API_BASE + "/generate".
    """
    if photo.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(400, f"Unsupported image type: {photo.content_type}")

    raw = await photo.read()
    if len(raw) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(400, f"Image too large — keep uploads under {MAX_UPLOAD_MB}MB.")

    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Couldn't read that file as an image.")

    started = time.time()
    try:
        image = remove_background(image, _rembg_session)
        image = resize_foreground(image, FOREGROUND_RATIO)
        image = image.convert("RGB")  # TripoSR expects RGB after the foreground crop

        with torch.no_grad():
            scene_codes = _model([image], device=DEVICE)
            mesh = _model.extract_mesh(
                scene_codes, has_vertex_color=True, resolution=MESH_RESOLUTION
            )[0]
    except Exception as e:
        log.exception("Generation failed")
        raise HTTPException(500, f"3D generation failed: {e}")

    out_dir = Path(tempfile.mkdtemp(prefix="studio3d_"))
    out_path = out_dir / "model.glb"
    mesh.export(str(out_path))
    log.info("Generated %s in %.1fs", out_path.name, time.time() - started)

    def _cleanup():
        shutil.rmtree(out_dir, ignore_errors=True)

    return FileResponse(
        out_path,
        media_type="model/gltf-binary",
        filename="model.glb",
        background=BackgroundTask(_cleanup),
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
