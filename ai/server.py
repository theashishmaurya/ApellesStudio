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
import hashlib
import io
import json
import os
import threading
import time
import uuid
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


def _quick_finesse(rgb: np.ndarray, mask: np.ndarray, box, band: int = 22) -> np.ndarray:
    """Fast edge cleanup — region clean + guided filter (source luma guide). ~30-60ms.
    Not as clean as ViTMatte on a low-contrast edge, but 50x faster; used for the
    /track pass, then upgraded per-frame on demand."""
    H, W = mask.shape
    b = (mask > 0.5).astype(np.uint8)
    if box is None:
        ys, xs = np.where(b)
        if len(xs) == 0:
            return mask.astype(np.float32)
        box = [xs.min(), ys.min(), xs.max(), ys.max()]
    pad = 40
    x0, y0 = max(0, int(box[0]) - pad), max(0, int(box[1]) - pad)
    x1, y1 = min(W, int(box[2]) + pad), min(H, int(box[3]) + pad)
    g, bc = rgb[y0:y1, x0:x1], b[y0:y1, x0:x1]

    n, lab, st, _ = cv2.connectedComponentsWithStats(bc, 8)
    if n > 1:
        bc = (lab == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    bc = cv2.morphologyEx(bc, cv2.MORPH_CLOSE, k)
    ff = bc.copy()
    cv2.floodFill(ff, np.zeros((bc.shape[0] + 2, bc.shape[1] + 2), np.uint8), (0, 0), 1)
    bc = (bc | (1 - ff)).astype(np.float32)

    a = cv2.GaussianBlur(bc, (0, 0), 0.6)
    guide = cv2.cvtColor(g, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
    a = cv2.ximgproc.guidedFilter(guide, a, 4, 1e-4)
    a = np.clip((a - 0.4) / 0.2, 0, 1)

    full = np.zeros((H, W), np.float32)
    full[y0:y1, x0:x1] = a
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


def _segment_array(rgb: np.ndarray, box=None, pts=None, auto_person=True,
                   refine=True, trimap_band=22, quick=False):
    """rgb HxWx3 uint8 -> (matte float HxW in [0,1], meta dict). Raises on no mask.

    refine=True  → ViTMatte edge (clean, ~2-3s).
    quick=True   → guided-filter edge (fast, ~50ms) when not refining.
    both False   → raw SAM mask (staircased)."""
    t0 = time.time()
    H, W = rgb.shape[:2]
    pil = Image.fromarray(rgb)

    if box is None and pts is None and auto_person:
        box = _central_person_box(pil)
        if box is None:
            pts = [[W / 2, H * 0.45, 1]]

    kw = {"verbose": False, "device": DEVICE}
    if box is not None:
        kw["bboxes"] = [box]
    if pts is not None:
        kw["points"] = [[p[0], p[1]] for p in pts]
        kw["labels"] = [int(p[2]) if len(p) > 2 else 1 for p in pts]

    res = sam().predict(pil, **kw)[0]
    if res.masks is None or len(res.masks) == 0:
        raise ValueError("no mask produced")
    mask = res.masks.data[0].cpu().numpy().astype(np.float32)
    if mask.shape != (H, W):
        mask = cv2.resize(mask, (W, H), interpolation=cv2.INTER_LINEAR)
    sam_ms = round((time.time() - t0) * 1000)

    refined, refine_ms = False, None
    if refine:
        try:
            t1 = time.time()
            mask = _refine_matte(rgb, mask, box, band=trimap_band)
            refine_ms = round((time.time() - t1) * 1000)
            refined = True
        except Exception as e:
            print(f"[refine] skipped: {type(e).__name__}: {e}")
    elif quick:
        try:
            mask = _quick_finesse(rgb, mask, box, band=trimap_band)
        except Exception as e:
            print(f"[quick] skipped: {type(e).__name__}: {e}")

    return mask, {"width": W, "height": H, "used_box": box, "refined": refined,
                  "sam_ms": sam_ms, "refine_ms": refine_ms}


@app.post("/segment")
def segment(req: SegmentReq):
    t0 = time.time()
    rgb = np.asarray(_b64_to_image(req.image_b64))
    try:
        mask, meta = _segment_array(rgb, req.box, req.points, req.auto_person,
                                    req.refine, req.trimap_band)
    except ValueError as e:
        return {"error": str(e)}
    return {"matte_b64": _mask_to_b64(mask), "ms": round((time.time() - t0) * 1000), **meta}


# ---------------------------------------------------------------------------
# /track  — precompute a subject matte per frame, cached to disk. The subject
# is followed frame-to-frame by re-detecting the person (YOLO) nearest the
# previous box; good enough for a mostly-stationary talking head. True SAM 2
# memory propagation is a later upgrade.
# ---------------------------------------------------------------------------

class TrackReq(BaseModel):
    video_path: str
    from_frame: int = 0
    to_frame: int = -1          # -1 = end
    step: int = 1              # segment every Nth frame; engine holds between
    box: Optional[list[float]] = None
    points: Optional[list[list[float]]] = None
    mode: str = "fast"        # "fast" = guided-filter edge (~0.5s/frame),
                              # "quality" = ViTMatte edge (~3s/frame)
    trimap_band: int = 22
    overwrite: bool = False


_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _cache_key(req: TrackReq) -> str:
    h = hashlib.sha1(
        json.dumps([os.path.abspath(req.video_path), req.box, req.points,
                    req.step, req.trimap_band], sort_keys=True).encode()
    ).hexdigest()[:12]
    return h


def _cache_dir(req: TrackReq) -> str:
    d = os.path.join(os.path.dirname(os.path.abspath(req.video_path)),
                     ".chroma", "mattes", _cache_key(req))
    os.makedirs(d, exist_ok=True)
    return d


def _quality_set(cache: str) -> set[int]:
    """Frames in this cache dir that carry a ViTMatte edge (not the fast one)."""
    p = os.path.join(cache, "_quality.json")
    try:
        with open(p) as f:
            return set(json.load(f))
    except Exception:
        return set()


def _mark_quality(cache: str, frame: int) -> None:
    s = _quality_set(cache)
    s.add(int(frame))
    tmp = os.path.join(cache, "_quality.json.tmp")
    with open(tmp, "w") as f:
        json.dump(sorted(s), f)
    os.replace(tmp, os.path.join(cache, "_quality.json"))


def _iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def _track_worker(job_id: str, req: TrackReq):
    job = _jobs[job_id]
    try:
        cap = cv2.VideoCapture(req.video_path)
        if not cap.isOpened():
            raise RuntimeError(f"cannot open {req.video_path}")
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        end = total - 1 if req.to_frame < 0 else min(req.to_frame, total - 1)
        frames = list(range(req.from_frame, end + 1, req.step))
        job["total"] = len(frames)
        cache = _cache_dir(req)
        prev_box = req.box
        quality = req.mode == "quality"
        hi = _quality_set(cache)
        try:
            matte()  # warm ViTMatte (fast pass → for on-seek refine; quality pass → the loop)
        except Exception:
            pass

        cap.set(cv2.CAP_PROP_POS_FRAMES, req.from_frame)
        next_idx = 0
        cur = req.from_frame
        while next_idx < len(frames):
            target = frames[next_idx]
            # read forward to the target frame
            while cur <= target:
                ok, bgr = cap.read()
                if not ok:
                    bgr = None
                    break
                cur += 1
            if bgr is None:
                break
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

            out_path = os.path.join(cache, f"{target:06d}.png")
            # fast pass: skip any frame we already have.
            # quality pass: skip only frames already at ViTMatte quality.
            already = os.path.exists(out_path) and (not quality or target in hi)
            if already and not req.overwrite:
                job["done"] = next_idx + 1
                next_idx += 1
                continue

            # follow the subject: person box nearest the previous one
            box = req.box
            if req.points is None:
                dets = _all_person_boxes(rgb)
                if dets:
                    if prev_box is not None:
                        box = max(dets, key=lambda d: _iou(d, prev_box))
                    else:
                        box = max(dets, key=lambda d: (d[2] - d[0]) * (d[3] - d[1]))
                    prev_box = box
                elif prev_box is not None:
                    box = prev_box

            try:
                mask, _ = _segment_array(rgb, box, req.points, auto_person=False,
                                         refine=quality, quick=not quality,
                                         trimap_band=req.trimap_band)
                Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8), "L").save(out_path)
                if quality:
                    _mark_quality(cache, target)
            except ValueError:
                pass  # leave a gap; engine holds the previous matte

            job["done"] = next_idx + 1
            next_idx += 1

        cap.release()
        job["state"] = "done"
        job["dir"] = cache
    except Exception as e:  # noqa
        job["state"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"


def _all_person_boxes(rgb: np.ndarray) -> list[list[float]]:
    r = detector().predict(rgb, classes=[0], verbose=False, device=DEVICE)[0]
    if r.boxes is None:
        return []
    return [b.tolist() for b in r.boxes.xyxy.cpu().numpy()]


@app.post("/track")
def track(req: TrackReq):
    if not os.path.exists(req.video_path):
        return {"error": f"no such file: {req.video_path}"}
    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {"state": "running", "done": 0, "total": 0,
                     "key": _cache_key(req), "dir": _cache_dir(req)}
    threading.Thread(target=_track_worker, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id, **_jobs[job_id]}


@app.get("/track/{job_id}")
def track_status(job_id: str):
    return _jobs.get(job_id, {"state": "unknown"})


class RefineTrackReq(BaseModel):
    video_path: str
    dir: str
    frame: int
    box: Optional[list[float]] = None
    trimap_band: int = 22


@app.post("/refine_track")
def refine_track(req: RefineTrackReq):
    """Upgrade one cached tracked frame to a ViTMatte edge, overwriting it. The
    engine calls this on seek-settle so the frame you're looking at is hi-res
    while the rest of the pass stays fast."""
    cap = cv2.VideoCapture(req.video_path)
    cap.set(cv2.CAP_PROP_POS_FRAMES, req.frame)
    ok, bgr = cap.read()
    cap.release()
    if not ok:
        return {"error": f"read frame {req.frame} failed"}
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    box = req.box
    if box is None:
        dets = _all_person_boxes(rgb)
        box = max(dets, key=lambda d: (d[2] - d[0]) * (d[3] - d[1])) if dets else None
    try:
        mask, meta = _segment_array(rgb, box, None, auto_person=False,
                                    refine=True, trimap_band=req.trimap_band)
    except ValueError as e:
        return {"error": str(e)}
    os.makedirs(req.dir, exist_ok=True)
    Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8), "L").save(
        os.path.join(req.dir, f"{req.frame:06d}.png"))
    _mark_quality(req.dir, req.frame)
    return {"matte_b64": _mask_to_b64(mask), **meta}
