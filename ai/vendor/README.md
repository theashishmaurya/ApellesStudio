# ai/vendor/

Third-party model code vendored into the sidecar (not pip-installable), kept
here so the fork stays a clean diff and the licence travels with the code.

## `video_depth_anything/`

**Video Depth Anything — Small (`vits`)**, the temporally-consistent video depth
model used by the `/depth_track` job (D-036).

- Source: <https://github.com/DepthAnything/Video-Depth-Anything>
  (`video_depth_anything/` package, commit `4f5ae23`, 2026-09-02).
- Licence: **Apache-2.0** (`video_depth_anything/LICENSE`). Bytedance Ltd.
  - The **`vits` checkpoint is Apache-2.0**. The `vitb` / `vitl` checkpoints are
    **CC-BY-NC-4.0 (non-commercial)** — Chroma ships as a real product, so
    **only `vits` may be used**. Do not "upgrade" the encoder.
- Local modifications:
  - `_align.py` — the two `utils/util.py` helpers `video_depth.py` imports,
    pulled in-package (no repo-root `utils` dependency). Unmodified logic.
  - `video_depth.py` — import line repointed to `._align`.
  - `video_depth_stream.py` removed — the experimental streaming path is unused
    (the job runs the offline `infer_video_depth`, per D-036).
  - `__init__.py` added.
- Checkpoint (`video_depth_anything_vits.pth`, ~112 MB fp32) is **not vendored** —
  the sidecar lazy-downloads it to `ai/models/` on first `/depth_track`, exactly
  like the SAM / ViTMatte / YOLO weights.
- Optional dep: `einops` (in `ai/requirements.txt`). `xformers` is used only if
  present (guarded) — not required on MPS.
