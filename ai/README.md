# ai/ — AI models

**Revised 2026-09-01 after the engine code-read (see `../docs/09-engine-notes.md`, D-009).**

RapidRAW already runs its AI (Depth Anything V2, SAM v1, U2-Net, CLIP, LaMa) as **ONNX
via `ort` (ONNX Runtime), in-process in Rust — no Python.** Chroma matches that.

So **this directory is NOT the v1 critical path.** In-process ONNX is the default. This
sidecar exists only for:

1. **Prototyping** — try a model in Python before committing to an ONNX + `ort` port.
2. **Models with no usable ONNX export** — e.g. CoTracker/TAPIR (verify), SAM 2 video
   memory-attention if the ONNX path proves too painful.
3. **`color-matcher`** ([hahnec](https://github.com/hahnec/color-matcher)) — small,
   pure-Python; may reimplement in Rust (`ndarray`/`nalgebra` are already engine deps).
4. **v3 experiments** — IC-Light relight (diffusion, slow, non-deterministic — bake-step
   only, D-013).

## In-process (Rust `ort`) — the real plan

| Model | Where | Status |
|---|---|---|
| Depth Anything V2 (ViT-S) | `engine/src-tauri/src/ai_processing.rs` | ✅ exists — extend to video |
| SAM 2 (subject + video track) | new, alongside RapidRAW's SAM 1 | D-012 |
| U2-Net (fallback foreground) | `ai_processing.rs` | ✅ exists |
| guided-filter matte refine | pure Rust | to write |

## If the sidecar is needed (contract draft)

FastAPI, local, lifecycle managed by the Rust core. `POST /op {op, shot_id, frame_range,
params}` → job id → poll. Results written to the shot cache dir; never touches `grade.json`.
