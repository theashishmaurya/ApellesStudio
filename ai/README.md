# ai/ — the AI sidecar

**Not built yet. Phase 2.**

A local Python service (FastAPI) the Rust core talks to over a socket. Runs the models
that have no good Rust path. Never touches `grade.json` — returns data, the core applies it.

## Planned models (all local, Apple Silicon MPS)

| Model | Job | Output |
|---|---|---|
| **SAM 2** | subject segmentation + video propagation | per-frame matte (RLE) + preview PNG |
| **Depth Anything V2** | monocular depth per frame (+ temporal smoothing) | 16-bit depth sequence / packed buffer |
| **CoTracker / TAPIR** | point + planar tracking (v2) | tracked point/homography per frame → mask keyframes |
| **color-matcher** ([hahnec](https://github.com/hahnec/color-matcher)) | reference colour transfer | a `grade.json` `adjust` fragment (CDL/curve), not a baked image |
| RobustVideoMatting / guided filter | matte edge/hair refinement | refined matte |

## Contract (draft)

- `POST /segment` `{shot_id, prompt, frame_range, threshold}` → job id
- `GET /job/{id}` → `{status, progress, result_ref}`
- `POST /depth` `{shot_id, frame_range}` → depth map ref
- `POST /match` `{shot_png, reference_png, method}` → `{adjust: {...}, gap_before, gap_after}`
- results written to the shot's cache dir; refs are paths

## Setup (when it exists)

```
cd ai && python -m venv .venv && .venv/bin/pip install -r requirements.txt
# models auto-download to ai/models/ on first use (gitignored)
```
