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
import sys
import threading
import time
import urllib.request
import uuid
from typing import Optional

# Vendored model code that isn't pip-installable (Video Depth Anything — D-036).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "vendor"))

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

# One Apple GPU — serialise every model call so a track pass, an on-seek refine
# and a segment can't stack their MPS working sets on top of each other. Held
# per-frame in the track loop (released between frames) so /refine_track can
# interleave.
_GPU = threading.Lock()

_sam = None
_detector = None
_matte = None  # (processor, model)
_video_pred = None  # reused SAM 2 video predictor (state reset per track)


def _free_gpu():
    """Return cached MPS/CUDA blocks to the OS and collect Python garbage."""
    import gc

    try:
        if DEVICE == "mps":
            torch.mps.empty_cache()
        elif DEVICE == "cuda":
            torch.cuda.empty_cache()
    except Exception:
        pass
    gc.collect()


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
            "vitmatte": VITMATTE_ID,
            "video_depth": os.path.exists(os.path.join(MODELS_DIR, VDA_CKPT_NAME))}


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
        with _GPU:
            mask, meta = _segment_array(rgb, req.box, req.points, req.auto_person,
                                        req.refine, req.trimap_band)
    except ValueError as e:
        return {"error": str(e)}
    finally:
        _free_gpu()
    return {"matte_b64": _mask_to_b64(mask), "ms": round((time.time() - t0) * 1000), **meta}


# ---------------------------------------------------------------------------
# /track  — precompute a subject matte per frame, cached to disk. The subject
# is followed by **SAM 2 memory propagation**: prompt once on the start frame,
# then feed frames in order — the model carries the object forward in its memory
# bank (no re-detection, no re-prompting), ~180ms/frame. Edge is then finished
# fast (guided filter) or hi-res (ViTMatte, "quality" mode / on-seek upgrade).
# ---------------------------------------------------------------------------

class TrackReq(BaseModel):
    video_path: str
    from_frame: int = 0        # prompt frame; propagation runs forward from here
    to_frame: int = -1         # -1 = end
    step: int = 1              # save a matte every Nth frame (every frame is still
                              # fed to the predictor so memory stays dense)
    box: Optional[list[float]] = None
    points: Optional[list[list[float]]] = None
    mode: str = "fast"        # "fast" = guided-filter edge (~0.25s/frame),
                              # "quality" = ViTMatte edge (~2.7s/frame)
    trimap_band: int = 22
    overwrite: bool = False


_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _get_video_predictor(max_obj: int = 1):
    """The SAM 2 video predictor, reused across tracks with its per-track state
    reset. One instance ever — a fresh one each track was ~1 GB into the MPS pool
    that never came back.

    conf must be ~0 — SAM 2's object-presence score sits ~0.15-0.20 after the
    /32 clamp and the default conf would filter every mask out."""
    global _video_pred
    from ultralytics.models.sam.predict import SAM2DynamicInteractivePredictor

    if _video_pred is None or _video_pred._max_obj_num < max_obj:
        _video_pred = None
        _free_gpu()
        ov = {"model": os.path.join(MODELS_DIR, "sam2.1_s.pt"), "device": DEVICE,
              "verbose": False, "save": False, "conf": 0.001}
        _video_pred = SAM2DynamicInteractivePredictor(overrides=ov, max_obj_num=max_obj)
    else:
        # reset per-track state (no clean reset() on this class)
        _video_pred.memory_bank.clear()
        _video_pred.obj_idx_set.clear()
        _video_pred.vision_feats = None
        _video_pred.high_res_features = None
        _video_pred.feat_sizes = None
        _free_gpu()
    return _video_pred


def _cache_key(req: TrackReq) -> str:
    h = hashlib.sha1(
        json.dumps([os.path.abspath(req.video_path), req.box, req.points,
                    req.from_frame, req.trimap_band], sort_keys=True).encode()
    ).hexdigest()[:12]
    return h


def _cache_dir(req: TrackReq) -> str:
    d = os.path.join(os.path.dirname(os.path.abspath(req.video_path)),
                     ".chroma", "mattes", _cache_key(req))
    os.makedirs(d, exist_ok=True)
    return d


def _mask_bbox(m: np.ndarray):
    ys, xs = np.where(m > 0.5)
    if len(xs) == 0:
        return None
    return [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]


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


def _all_person_boxes(rgb: np.ndarray) -> list[list[float]]:
    r = detector().predict(rgb, classes=[0], verbose=False, device=DEVICE)[0]
    if r.boxes is None:
        return []
    return [b.tolist() for b in r.boxes.xyxy.cpu().numpy()]


def _box_overlap(a, b) -> float:
    """Intersection area of a with b, normalised by a's area — 'how much of the
    YOLO box falls inside the user's box'."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    area_a = max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))
    return inter / area_a


def _finish_edge(rgb, mask, quality, band):
    box = _mask_bbox(mask)
    if box is None:
        return mask
    if quality:
        try:
            with _GPU:                     # ViTMatte is on the GPU
                return _refine_matte(rgb, mask, box, band=band)
        except Exception as e:
            print(f"[refine] {type(e).__name__}: {e}")
            return mask
    try:
        return _quick_finesse(rgb, mask, box, band=band)  # CPU, no lock
    except Exception as e:
        print(f"[quick] {type(e).__name__}: {e}")
        return mask


def _track_worker(job_id: str, req: TrackReq):
    job = _jobs[job_id]
    cap = None
    try:
        cap = cv2.VideoCapture(req.video_path)
        if not cap.isOpened():
            raise RuntimeError(f"cannot open {req.video_path}")
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        end = total - 1 if req.to_frame < 0 else min(req.to_frame, total - 1)
        job["total"] = len(range(req.from_frame, end + 1, req.step))
        cache = _cache_dir(req)
        quality = req.mode == "quality"
        hi = _quality_set(cache)
        try:
            matte()  # warm ViTMatte (fast → on-seek refine; quality → the loop)
        except Exception:
            pass

        cap.set(cv2.CAP_PROP_POS_FRAMES, req.from_frame)
        ok, bgr = cap.read()
        if not ok:
            raise RuntimeError(f"cannot read frame {req.from_frame}")
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        H, W = rgb.shape[:2]

        # Prompt the subject on the start frame. SAM 2 is very box-sensitive — a
        # loose hand-drawn box segments only the head — so refine to a real YOLO
        # person box (the one best overlapping the user's box) before prompting.
        box = req.box
        pts = req.points
        if pts is None:
            dets = _all_person_boxes(rgb)
            if dets:
                if box is not None:
                    box = max(dets, key=lambda d: _box_overlap(d, box))
                else:
                    W2, H2 = W / 2, H / 2
                    box = max(dets, key=lambda d: (d[2] - d[0]) * (d[3] - d[1])
                              - (((d[0] + d[2]) / 2 - W2) / W) ** 2 * (W * H)
                              - (((d[1] + d[3]) / 2 - H2) / H) ** 2 * (W * H))
            elif box is None:
                box = _central_person_box(Image.fromarray(rgb))
        if box is None and pts is None:
            raise RuntimeError("no subject to track (no box/points, no person found)")

        pkw = {"source": rgb, "obj_ids": [0], "update_memory": True}
        if box is not None:
            pkw["bboxes"] = [box]
        if pts is not None:
            pkw["points"] = [[p[0], p[1]] for p in pts]
            pkw["labels"] = [int(p[2]) if len(p) > 2 else 1 for p in pts]
        with _GPU:
            pred = _get_video_predictor(max_obj=1)
            pred(**pkw)

        # remember the prompt for /refine_track
        with open(os.path.join(cache, "_track.json"), "w") as f:
            json.dump({"from_frame": req.from_frame, "box": box, "points": pts,
                       "video_path": os.path.abspath(req.video_path)}, f)

        done = 0
        cur = req.from_frame
        while cur <= end:
            if job.get("cancelled"):
                job["state"] = "cancelled"
                return
            if cur > req.from_frame:
                ok, bgr = cap.read()
                if not ok:
                    break
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                with _GPU:                             # <- memory propagation
                    res = pred(source=rgb)[0]
                m = (res.masks.data[0].cpu().numpy().astype(np.float32)
                     if (res.masks is not None and len(res.masks)) else np.zeros((H, W), np.float32))
            else:
                with _GPU:
                    res = pred(source=rgb, obj_ids=[0])
                m = (res[0].masks.data[0].cpu().numpy().astype(np.float32)
                     if (res[0].masks is not None and len(res[0].masks)) else np.zeros((H, W), np.float32))

            save_this = (cur - req.from_frame) % req.step == 0
            if save_this:
                out_path = os.path.join(cache, f"{cur:06d}.png")
                already = os.path.exists(out_path) and (not quality or cur in hi)
                if not (already and not req.overwrite):
                    if m.any():
                        edged = _finish_edge(rgb, m, quality, req.trimap_band)
                        Image.fromarray((np.clip(edged, 0, 1) * 255).astype(np.uint8), "L").save(out_path)
                        if quality:
                            _mark_quality(cache, cur)
                done += 1
                job["done"] = done
            cur += 1

        job["state"] = "done"
        job["dir"] = cache
    except Exception as e:  # noqa
        job["state"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
    finally:
        if cap is not None:
            cap.release()
        # release the predictor's memory bank + return the MPS pool (the predictor
        # object itself is reused — see _get_video_predictor)
        if _video_pred is not None:
            with _GPU:
                _video_pred.memory_bank.clear()
                _video_pred.obj_idx_set.clear()
                _video_pred.vision_feats = None
                _video_pred.high_res_features = None
        _free_gpu()


@app.post("/track")
def track(req: TrackReq):
    if not os.path.exists(req.video_path):
        return {"error": f"no such file: {req.video_path}"}
    # one track at a time — cancel any still running so predictors don't stack
    for j in _jobs.values():
        if j.get("state") == "running":
            j["cancelled"] = True
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
    while the rest of the pass stays fast.

    Re-segments this one frame with SAM 2 (image mode) seeded by the fast
    matte's bbox — cheap, and doesn't need to replay propagation to this frame."""
    cap = cv2.VideoCapture(req.video_path)
    cap.set(cv2.CAP_PROP_POS_FRAMES, req.frame)
    ok, bgr = cap.read()
    cap.release()
    if not ok:
        return {"error": f"read frame {req.frame} failed"}
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    box = req.box
    if box is None:
        # seed from the fast matte we already have for this frame
        fast = os.path.join(req.dir, f"{req.frame:06d}.png")
        if os.path.exists(fast):
            box = _mask_bbox(np.asarray(Image.open(fast).convert("L")).astype(np.float32) / 255.0)
    if box is None:
        # fall back to the tracked prompt box
        try:
            with open(os.path.join(req.dir, "_track.json")) as f:
                box = json.load(f).get("box")
        except Exception:
            pass
    try:
        with _GPU:
            mask, meta = _segment_array(rgb, box, None, auto_person=box is None,
                                        refine=True, trimap_band=req.trimap_band)
    except ValueError as e:
        return {"error": str(e)}
    finally:
        _free_gpu()
    os.makedirs(req.dir, exist_ok=True)
    Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8), "L").save(
        os.path.join(req.dir, f"{req.frame:06d}.png"))
    _mark_quality(req.dir, req.frame)
    return {"matte_b64": _mask_to_b64(mask), **meta}


# ---------------------------------------------------------------------------
# /depth_track  — precompute a *temporally-consistent* depth map per frame,
# cached to disk. Mirrors /track (D-036). The model is **Video Depth Anything —
# Small** (vits, Apache-2.0): a DINOv2 ViT-S backbone + a spatial-temporal head
# whose temporal self-attention makes the depth stable frame-to-frame — this is
# what DaVinci Resolve's "temporal z-depth" does, and what a per-frame model +
# a hand-rolled EMA can only approximate. The vitb / vitl checkpoints are
# CC-BY-NC-4.0 (non-commercial) — do NOT use them; Chroma ships as a product.
#
# The engine's Rust Depth Anything V2 (ONNX) path is unchanged — it stays the
# static single-frame bake for stills and for apply_haze when no track exists.
# ---------------------------------------------------------------------------

VDA_CKPT_NAME = "video_depth_anything_vits.pth"
VDA_URL = ("https://huggingface.co/depth-anything/Video-Depth-Anything-Small/"
           "resolve/main/video_depth_anything_vits.pth")
# vits config (run.py model_configs) — DO NOT switch encoder (licence, above).
VDA_CFG = dict(encoder="vits", features=64, out_channels=[48, 96, 192, 384])

_vda = None  # loaded VideoDepthAnything, on DEVICE, eval()


def _vda_device() -> str:
    # fp16 on MPS is flaky for these solvers (same lesson as ViTMatte /
    # enhance-voice) — we always run fp32; CPU is the fallback if MPS is absent.
    return DEVICE if DEVICE in ("mps", "cuda") else "cpu"


def _download(url: str, dest: str) -> None:
    tmp = dest + ".part"
    print(f"[depth] downloading {os.path.basename(dest)} …")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)
    print(f"[depth] saved {dest} ({os.path.getsize(dest) // (1 << 20)} MB)")


def video_depth():
    """Lazy-load VDA-Small. Checkpoint (~112 MB fp32) downloads to ai/models/ on
    first call, exactly like the SAM / ViTMatte / YOLO weights (none bundled)."""
    global _vda
    if _vda is None:
        import torch as _torch
        from video_depth_anything import VideoDepthAnything

        ckpt = os.path.join(MODELS_DIR, VDA_CKPT_NAME)
        if not os.path.exists(ckpt):
            _download(VDA_URL, ckpt)
        m = VideoDepthAnything(**VDA_CFG)
        m.load_state_dict(_torch.load(ckpt, map_location="cpu"), strict=True)
        _vda = m.to(_vda_device()).eval()
    return _vda


class DepthTrackReq(BaseModel):
    video_path: str
    from_frame: int = 0
    to_frame: int = -1        # -1 = end
    step: int = 1             # save density (every frame is still fed to the model)
    input_size: int = 518     # VDA default; smaller = faster, less detail
    max_res: int = 1280       # long-edge cap for decode + storage (VDA's own default)
    overwrite: bool = False


def _depth_cache_key(req: DepthTrackReq) -> str:
    return hashlib.sha1(
        json.dumps([os.path.abspath(req.video_path), req.from_frame, req.to_frame,
                    req.input_size, req.max_res], sort_keys=True).encode()
    ).hexdigest()[:12]


def _depth_cache_dir(req: DepthTrackReq) -> str:
    d = os.path.join(os.path.dirname(os.path.abspath(req.video_path)),
                     ".chroma", "depth", _depth_cache_key(req))
    os.makedirs(d, exist_ok=True)
    return d


def _even(v: int) -> int:
    return v if v % 2 == 0 else v + 1


def _depth_track_worker(job_id: str, req: DepthTrackReq):
    job = _jobs[job_id]
    cap = None
    try:
        import numpy as _np

        cap = cv2.VideoCapture(req.video_path)
        if not cap.isOpened():
            raise RuntimeError(f"cannot open {req.video_path}")
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
        end = total - 1 if req.to_frame < 0 else min(req.to_frame, total - 1)
        save_frames = list(range(req.from_frame, end + 1, req.step))
        job["total"] = len(save_frames)
        cache = _depth_cache_dir(req)

        if job.get("cancelled"):
            job["state"] = "cancelled"
            return

        # decode [from_frame .. end], downscale to max_res long edge
        cap.set(cv2.CAP_PROP_POS_FRAMES, req.from_frame)
        ok, bgr = cap.read()
        if not ok:
            raise RuntimeError(f"cannot read frame {req.from_frame}")
        H0, W0 = bgr.shape[:2]
        scale = min(1.0, req.max_res / max(H0, W0)) if req.max_res > 0 else 1.0
        W, H = (_even(round(W0 * scale)), _even(round(H0 * scale))) if scale < 1.0 else (W0, H0)

        def prep(b):
            rgb = cv2.cvtColor(b, cv2.COLOR_BGR2RGB)
            if (W, H) != (W0, H0):
                rgb = cv2.resize(rgb, (W, H), interpolation=cv2.INTER_AREA)
            return rgb

        frames = [prep(bgr)]
        cur = req.from_frame
        while cur < end:
            ok, bgr = cap.read()
            if not ok:
                break
            frames.append(prep(bgr))
            cur += 1
            if job.get("cancelled"):
                job["state"] = "cancelled"
                return
        frames_np = _np.stack(frames)
        del frames

        # est. peak RAM: frame stack + float32 depth stack
        est_gb = frames_np.nbytes * 7 / (1 << 30)
        if est_gb > 6.0:
            raise RuntimeError(
                f"depth track would need ~{est_gb:.1f} GB RAM for "
                f"{len(frames_np)} frames at {W}x{H}; narrow from_frame/to_frame "
                f"or lower max_res")

        model = video_depth()
        dev = _vda_device()
        t0 = time.time()
        with _GPU:
            if job.get("cancelled"):
                job["state"] = "cancelled"
                return
            depths, _ = model.infer_video_depth(
                frames_np, fps, input_size=req.input_size, device=dev, fp32=True)
        job["infer_secs"] = round(time.time() - t0, 1)

        # Global (whole-clip) normalisation — VDA's values are already temporally
        # consistent; a per-frame min/max would re-introduce brightness pumping.
        # 1/99 percentile clip for robustness. Output is disparity-like: bright =
        # near (matches Depth Anything V2's ONNX orientation — the depth-haze
        # preset inverts it).
        lo = float(_np.percentile(depths, 1))
        hi = float(_np.percentile(depths, 99))
        rng = hi - lo if hi > lo else 1.0
        u8 = _np.clip((depths - lo) / rng, 0.0, 1.0)
        u8 = (u8 * 255.0 + 0.5).astype(_np.uint8)

        done = 0
        for i, f in enumerate(save_frames):
            if job.get("cancelled"):
                job["state"] = "cancelled"
                return
            out_path = os.path.join(cache, f"{f:06d}.png")
            if req.overwrite or not os.path.exists(out_path):
                idx = f - req.from_frame
                if idx < len(u8):
                    Image.fromarray(u8[idx], mode="L").save(out_path)
            done += 1
            job["done"] = done

        with open(os.path.join(cache, "_depth.json"), "w") as fh:
            json.dump({"model": "video_depth_anything_vits", "from_frame": req.from_frame,
                       "to_frame": end, "step": req.step, "input_size": req.input_size,
                       "res": [W, H], "src_res": [W0, H0], "norm": [lo, hi],
                       "video_path": os.path.abspath(req.video_path),
                       "infer_secs": job.get("infer_secs")}, fh)
        job["state"] = "done"
        job["dir"] = cache
    except Exception as e:  # noqa
        job["state"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"
    finally:
        if cap is not None:
            cap.release()
        _free_gpu()


@app.post("/depth_track")
def depth_track(req: DepthTrackReq):
    if not os.path.exists(req.video_path):
        return {"error": f"no such file: {req.video_path}"}
    # one depth track at a time — cancel a running one, leave subject /track alone
    for j in _jobs.values():
        if j.get("kind") == "depth" and j.get("state") == "running":
            j["cancelled"] = True
    job_id = "d" + uuid.uuid4().hex[:11]
    _jobs[job_id] = {"kind": "depth", "state": "running", "done": 0, "total": 0,
                     "key": _depth_cache_key(req), "dir": _depth_cache_dir(req)}
    threading.Thread(target=_depth_track_worker, args=(job_id, req), daemon=True).start()
    return {"job_id": job_id, **_jobs[job_id]}


@app.get("/depth_track/{job_id}")
def depth_track_status(job_id: str):
    return _jobs.get(job_id, {"state": "unknown"})
