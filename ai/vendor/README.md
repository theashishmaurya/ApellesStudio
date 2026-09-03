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

## `moge/`

**MoGe-2** (Microsoft, CVPR 2025), the real per-pixel surface-normal model backing
Relight's "Bake Normals" (D-077, follow-up to D-076). `apply_relight`'s previous
normal was a crude finite-difference of the depth texture — flat and blob-like on
real footage (owner, live: "that not light that's just color"). This is a real
trained normal-estimation network instead, same "AI bakes a map once, shader
shades live against it" pattern D-036's depth track already established.

- Source: <https://github.com/microsoft/MoGe> (`moge/model/v2.py` + its
  dependency closure only — NOT v1/v3). Package version `3.0.0` (pip-installed
  transiently to vendor from, 2026-09-03) — pulled from PyPI/GitHub's published
  `moge` package, `model/` and `utils/` subtrees.
- Licence: **MIT** (`moge/LICENSE`), except the DINOv2 backbone
  (`model/modules/dinov2/`), which is **Apache-2.0** (Meta AI) — both
  commercial-safe. **DSINE (Bae & Davison, CVPR 2024) was evaluated first and
  rejected** — Imperial College London's academic-only licence, not usable in a
  shipped product.
- Why v2, not v3 (MoGe's own latest): v3 hard-depends on `flex-gemm` (built on
  Triton), and Triton publishes no macOS wheels — dead on arrival on Apple
  Silicon. v2 is plain PyTorch ops throughout, confirmed running on MPS.
- Why the small `-normal` checkpoint (`Ruicheng/moge-2-vits-normal`, 35M
  params, `huggingface_hub`-downloaded on first use, not vendored): the other
  MoGe-2 checkpoints (no `-normal` suffix) don't produce a normal map at all;
  `vitb`/`vitl` are larger for marginal quality gain we don't need for a
  cheap-tint relight pass.
- **MPS quirk, patched at the call site (not in this vendored code):**
  `MoGeModel.infer(..., use_fp16=True)` is the default — triggers "Input type
  (c10::Half) and bias type (float) should be the same" on MPS (an autocast
  dtype-mismatch bug in this model's own fp32-output-projection path, not
  something we can fix by patching a device string). The sidecar's own call
  site passes `use_fp16=False` instead. Confirmed working end to end on MPS:
  ~0.65s warm at 1080p, ~0.8s at 4K.
- Trimmed from the upstream package: `v1.py`, `v3.py`,
  `modules/flex_sparse_blocks.py`, `modules/sparse_unet.py` (v3-only),
  `test/`, `scripts/`, `train/`, and every `utils/` file `v2.py`'s own import
  chain doesn't reach — kept only `geometry_torch.py`, `geometry_numpy.py`,
  `tools.py`. No logic changes to any kept file.
- External (non-vendored) deps: `utils3d_moge` (a small pure-Python geometry
  utility package `v2.py` imports directly — pinned git dep in
  `ai/requirements.txt`, not vendored, not the model itself), `scipy`,
  `huggingface_hub` (all in `ai/requirements.txt`).
