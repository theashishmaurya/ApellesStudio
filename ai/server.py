"""Chroma AI sidecar — local, MPS. FastAPI over SAM 2 (via ultralytics).

Endpoints
  GET  /health                       -> {ok, device, models}
  POST /segment  {image_b64, ...}     -> {matte_b64}   (one frame)
  POST /track    {video_path, ...}    -> {mattes: [{frame, matte_b64}], ...}  (video)

A "matte" is a single-channel PNG, white = subject, base64 (no data: prefix).
Prompts: `box` [x1,y1,x2,y2] or `points` [[x,y,label], ...] (label 1=fg, 0=bg),
in pixel coords of the given image/frame. `auto_person: true` runs a quick person
detector and uses the most central person box instead.
"""
from __future__ import annotations

import base64
import io
import os
import time
from typing import Optional

import numpy as np
import torch
from fastapi import FastAPI
from PIL import Image
from pydantic import BaseModel

DEVICE = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")
os.makedirs(MODELS_DIR, exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", MODELS_DIR)

app = FastAPI(title="chroma-ai")

_sam = None
_detector = None


def sam():
    global _sam
    if _sam is None:
        from ultralytics import SAM

        _sam = SAM(os.path.join(MODELS_DIR, "sam2.1_s.pt"))
        _sam.to(DEVICE)
    return _sam


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


@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE, "models": os.listdir(MODELS_DIR)}


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
    return {
        "matte_b64": _mask_to_b64(mask),
        "width": img.size[0],
        "height": img.size[1],
        "used_box": box,
        "ms": round((time.time() - t0) * 1000),
    }
