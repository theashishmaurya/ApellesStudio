"""Chroma AI sidecar — local, MPS. FastAPI over SAM 2 (via ultralytics) + ViTMatte.

Endpoints
  GET  /health                       -> {ok, device, models}
  POST /segment  {image_b64, ...}     -> {matte_b64}   (one frame)
  POST /track    {video_path, ...}    -> {mattes: [{frame, matte_b64}], ...}  (video)

A "matte" is a single-channel PNG, white = subject, base64 (no data: prefix).
Prompts: `box` [x1,y1,x2,y2] or `points` [[x,y,label], ...] (label 1=fg, 0=bg),
in pixel coords of the given image/frame. `auto_person: true` runs a quick person
detector and uses the most central person box instead.

Matte pipeline (D-016): SAM 2 gives a coarse *segmentation* (what) — its 256px
decoder staircases at 4K. We then build a trimap (erode/dilate the coarse mask,
band between = unknown) and run **ViTMatte** over the unknown band to get a real
edge-accurate alpha. `refine: false` on /segment returns the raw SAM mask.
"""
from __future__ import annotations

import base64
import io
import os
import time
from typing import Optional

import cv2
import numpy as np
import torch
from fastapi import FastAPI
from PIL import Image
from pydantic import BaseModel

DEVICE = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")
os.makedirs(MODELS_DIR, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", MODELS_DIR)

VITMATTE_ID = os.environ.get("CHROMA_VITMATTE", "hustvl/vitmatte-small-composition-1k")

app = FastAPI(title="chroma-ai")

_sam = None
_detector = None
_matte = None  # (processor, model)


def sam():
    global _sam
    if _sam is None:
        from ultralytics import SAM

        _sam = SAM(os.path.join(MODELS_DIR, "sam2.1_s.pt"))
        _sam.to(DEVICE)
    return _sam


def matte():
    """ViTMatte — trimap-based matting for the edge refine (D-016)."""
    global _matte
    if _matte is None:
        from transformers import VitMatteForImageMatting, VitMatteImageProcessor

        proc = VitMatteImageProcessor.from_pretrained(VITMATTE_ID)
        model = VitMatteForImageMatting.from_pretrained(VITMATTE_ID).to(DEVICE).eval()
        _matte = (proc, model)
    return _matte


def _refine_matte(rgb: np.ndarray, coarse: np.ndarray, box, band: int = 22,
                  max_side: int = 1600) -> np.ndarray:
    """coarse binary mask -> trimap -> ViTMatte alpha. Runs on a padded crop
    around `box` for speed; alpha upscaled back to full res."""
    H, W = coarse.shape
    b = (coarse > 0.5).astype(np.uint8)
    if box is None:
        ys, xs = np.where(b)
        if len(xs) == 0:
            return coarse.astype(np.float32)
        box = [xs.min(), ys.min(), xs.max(), ys.max()]
    pad = 60
    x0, y0 = max(0, int(box[0]) - pad), max(0, int(box[1]) - pad)
    x1, y1 = min(W, int(box[2]) + pad), min(H, int(box[3]) + pad)
    crop, bcrop = rgb[y0:y1, x0:x1], b[y0:y1, x0:x1]
    ch, cw = crop.shape[:2]

    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (band * 2 + 1,) * 2)
    tri = np.full((ch, cw), 128, np.uint8)
    tri[cv2.dilate(bcrop, k) == 0] = 0
    tri[cv2.erode(bcrop, k) == 1] = 255

    scale = min(1.0, max_side / max(ch, cw))
    if scale < 1.0:
        cs = (int(cw * scale), int(ch * scale))
        crop_s = cv2.resize(crop, cs, interpolation=cv2.INTER_AREA)
        tri_s = cv2.resize(tri, cs, interpolation=cv2.INTER_NEAREST)
    else:
        crop_s, tri_s = crop, tri

    proc, model = matte()
    inp = proc(images=Image.fromarray(crop_s), trimaps=Image.fromarray(tri_s),
               return_tensors="pt")
    inp = {kk: v.to(DEVICE) for kk, v in inp.items()}
    with torch.no_grad():
        alpha = model(**inp).alphas[0, 0].float().cpu().numpy()
    alpha = alpha[:crop_s.shape[0], :crop_s.shape[1]]
    if scale < 1.0:
        alpha = cv2.resize(alpha, (cw, ch), interpolation=cv2.INTER_LINEAR)

    full = np.zeros((H, W), np.float32)
    full[y0:y1, x0:x1] = np.clip(alpha, 0, 1)
    return full


def detector():
    global _detector
    if _detector is None:
        from ultralytics import YOLO

        _detector = YOLO(os.path.join(MODELS_DIR, "yolo11n.pt"))
    return _detector


def _b64_to_image(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def _mask_to_b64(mask: np.ndarray) -> str:
    """mask: HxW bool/float -> single-channel PNG base64."""
    m = (np.clip(mask, 0, 1) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(m, mode="L").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _central_person_box(img: Image.Image) -> Optional[list[float]]:
    r = detector().predict(img, classes=[0], verbose=False, device=DEVICE)[0]
    if r.boxes is None or len(r.boxes) == 0:
        return None
    w, h = img.size
    cx, cy = w / 2, h / 2
    best, best_score = None, -1.0
    for b in r.boxes.xyxy.cpu().numpy():
        bx, by = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
        area = (b[2] - b[0]) * (b[3] - b[1])
        # prefer big + central
        dist = ((bx - cx) / w) ** 2 + ((by - cy) / h) ** 2
        score = area / (w * h) - dist
        if score > best_score:
            best, best_score = b.tolist(), score
    return best


class SegmentReq(BaseModel):
    image_b64: str
    box: Optional[list[float]] = None
    points: Optional[list[list[float]]] = None
    auto_person: bool = True
    refine: bool = True          # D-016: ViTMatte edge refine
    trimap_band: int = 22        # px (full-res) of "unknown" either side of the SAM edge


@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE, "models": os.listdir(MODELS_DIR),
            "vitmatte": VITMATTE_ID}


@app.post("/segment")
def segment(req: SegmentReq):
    t0 = time.time()
    img = _b64_to_image(req.image_b64)

    box = req.box
    pts = req.points
    if box is None and pts is None and req.auto_person:
        box = _central_person_box(img)
        if box is None:  # fall back to a centre point
            w, h = img.size
            pts = [[w / 2, h * 0.45, 1]]

    kw = {"verbose": False, "device": DEVICE}
    if box is not None:
        kw["bboxes"] = [box]
    if pts is not None:
        kw["points"] = [[p[0], p[1]] for p in pts]
        kw["labels"] = [int(p[2]) if len(p) > 2 else 1 for p in pts]

    res = sam().predict(img, **kw)[0]
    if res.masks is None or len(res.masks) == 0:
        return {"error": "no mask produced"}
    mask = res.masks.data[0].cpu().numpy().astype(np.float32)
    W, H = img.size
    if mask.shape != (H, W):
        mask = cv2.resize(mask, (W, H), interpolation=cv2.INTER_LINEAR)
    sam_ms = round((time.time() - t0) * 1000)

    refined = False
    if req.refine:
        try:
            t1 = time.time()
            mask = _refine_matte(np.asarray(img), mask, box, band=req.trimap_band)
            refine_ms = round((time.time() - t1) * 1000)
            refined = True
        except Exception as e:  # fall back to the raw SAM mask, don't fail the call
            refine_ms = None
            print(f"[refine] skipped: {type(e).__name__}: {e}")
    else:
        refine_ms = None

    return {
        "matte_b64": _mask_to_b64(mask),
        "width": W,
        "height": H,
        "used_box": box,
        "refined": refined,
        "ms": round((time.time() - t0) * 1000),
        "sam_ms": sam_ms,
        "refine_ms": refine_ms,
    }
