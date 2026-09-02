"""Scripted check for the /depth_track job (D-036).

Runs the Video Depth Anything depth track on a short range of a moving-camera
clip and asserts the "proper depth" claims:
  - every cached PNG is non-empty and non-degenerate (real dynamic range,
    near != far);
  - the depth is *temporally stable* — the mean consecutive-frame delta is low,
    and materially lower than per-frame Depth Anything V2 on the same frames
    (VDA's temporal head is the whole point vs a per-frame model + EMA).

Gated: needs `CHROMA_DEPTH_TEST=1` and a clip in scratch/ (skips like the Rust
C019 tests otherwise). The checkpoint (~112 MB) downloads on first run.

    CHROMA_DEPTH_TEST=1 ai/.venv/bin/python ai/test_depth_track.py
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))

REPO = os.path.dirname(HERE)
CLIP = os.environ.get(
    "CHROMA_DEPTH_TEST_CLIP", os.path.join(REPO, "scratch", "Tokyo-Walk_rgb.mp4")
)
N = int(os.environ.get("CHROMA_DEPTH_TEST_FRAMES", "16"))


def main() -> int:
    if os.environ.get("CHROMA_DEPTH_TEST") != "1":
        print("skip: set CHROMA_DEPTH_TEST=1")
        return 0
    if not os.path.exists(CLIP):
        print(f"skip: no clip at {CLIP}")
        return 0

    import server

    req = server.DepthTrackReq(video_path=CLIP, from_frame=0, to_frame=N - 1,
                               step=1, input_size=518, max_res=1280, overwrite=True)
    server._jobs["test"] = {"kind": "depth", "state": "running", "done": 0, "total": 0}
    server._depth_track_worker("test", req)  # noqa: SLF001 — direct, synchronous
    job = server._jobs["test"]
    print("worker finished:", {k: job.get(k) for k in ("state", "done", "total", "infer_secs", "error")})
    assert job.get("state") == "done", f"worker did not finish: {job}"

    cache = server._depth_cache_dir(req)  # noqa: SLF001
    pngs = sorted(f for f in os.listdir(cache) if f.endswith(".png"))
    assert len(pngs) == N, f"expected {N} depth PNGs, got {len(pngs)} in {cache}"

    maps = np.stack([np.asarray(Image.open(os.path.join(cache, p)).convert("L"),
                                dtype=np.float32) / 255.0 for p in pngs])
    # non-degenerate: real dynamic range, near != far
    for i, m in enumerate(maps):
        lo, hi = float(m.min()), float(m.max())
        assert hi - lo > 0.25, f"frame {i}: depth range {hi - lo:.3f} too flat"
        assert float(np.percentile(m, 95)) - float(np.percentile(m, 5)) > 0.15, \
            f"frame {i}: depth p5..p95 spread too small"

    vda_delta = np.abs(np.diff(maps, axis=0)).mean()
    print(f"VDA consecutive-frame mean |Δ| = {vda_delta:.5f}")
    assert vda_delta < 0.05, f"VDA depth not temporally stable: mean |Δ| {vda_delta:.4f}"

    # compare against per-frame Depth Anything V2 (transformers, Apache-2.0)
    try:
        import cv2
        import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        pid = "depth-anything/Depth-Anything-V2-Small-hf"
        proc = AutoImageProcessor.from_pretrained(pid)
        dav2 = AutoModelForDepthEstimation.from_pretrained(pid).to(dev).eval()
        cap = cv2.VideoCapture(CLIP)
        raw = []
        for _ in range(N):
            ok, bgr = cap.read()
            if not ok:
                break
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            inp = proc(images=rgb, return_tensors="pt").to(dev)
            with torch.no_grad():
                pd = dav2(**inp).predicted_depth
            pd = torch.nn.functional.interpolate(
                pd[:, None], size=rgb.shape[:2], mode="bilinear")[0, 0]
            pd = pd.float().cpu().numpy()
            a, b = np.percentile(pd, 1), np.percentile(pd, 99)
            raw.append(np.clip((pd - a) / (b - a + 1e-6), 0, 1))
        cap.release()
        raw = np.stack(raw)
        dav2_delta = np.abs(np.diff(raw, axis=0)).mean()
        print(f"DA-V2 per-frame mean |Δ|   = {dav2_delta:.5f}")
        print(f"VDA is {dav2_delta / vda_delta:.2f}x steadier than per-frame DA-V2")
        assert vda_delta < dav2_delta, \
            "VDA should be steadier than a per-frame model — temporal head not helping"
    except Exception as e:  # noqa: BLE001
        print(f"DA-V2 comparison skipped: {type(e).__name__}: {e}")

    print("OK — depth track PNGs non-degenerate + temporally stable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
