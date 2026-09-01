# ai/ — Chroma AI sidecar

Local FastAPI service. Models run on MPS (Apple Silicon). Nothing here is on the network;
nothing here touches `grade.json` — it returns mattes, the engine applies them.

## Run

**The app starts this for you now (D-028).** First set up the venv once:

```
cd ai && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Then just launch Chroma — `engine/src-tauri/src/chroma/sidecar.rs` spawns
`uvicorn` on app start, pipes its logs into `app.log` (grep `[sidecar]`), and
restarts it if it crashes. Details + env vars (`CHROMA_AI_DIR`,
`CHROMA_AI_PYTHON`, `CHROMA_AI_PORT`, `CHROMA_AI_NO_SPAWN`) in
`docs/notes/sidecar-lifecycle.md`.

Manual start still works for standalone testing — the app detects an already-
running sidecar and leaves it alone instead of spawning a second one:

```
./run.sh                 # -> http://127.0.0.1:8765  (CHROMA_AI_PORT to change)
```

Models auto-download on first use: `sam2.1_s.pt` ~88 MB + `yolo11n.pt` ~5 MB to
`ai/models/`; `vitmatte-small` ~100 MB to the HF cache.

## Endpoints

| | |
|---|---|
| `GET /health` | `{ok, device, models, vitmatte}` |
| `POST /segment` | one frame → `{matte_b64, width, height, refined, sam_ms, refine_ms}` |
| `POST /track` | `{video_path, from_frame, to_frame, step, box?, points?, mode}` → `{job_id, dir, ...}`; bg job, mattes cached to `<video_dir>/.chroma/mattes/<key>/<frame:06d>.png` |
| `GET /track/{job_id}` | `{state, done, total, dir}` |
| `POST /refine_track` | `{video_path, dir, frame, box?}` → upgrade one cached frame to a ViTMatte edge, returns `{matte_b64}` |

Tracking = **SAM 2 memory propagation** (`SAM2DynamicInteractivePredictor`, D-018):
prompt once on `from_frame` (the loose box is refined to a YOLO person box first),
then feed frames in order — the model carries the object forward, ~180ms/frame.
`mode`: `"fast"` (guided-filter edge) or `"quality"` (ViTMatte). One object per call.

### `/segment` request

```jsonc
{
  "image_b64": "<PNG/JPEG bytes, base64, no data: prefix>",
  "box":   [x1, y1, x2, y2],          // optional, pixel coords
  "points": [[x, y, 1], [x, y, 0]],   // optional; label 1 = include (+), 0 = exclude (−)
  "auto_person": true,                 // if no box/points: YOLO finds the most central person
  "refine": true,                      // D-016: ViTMatte edge refine (default on)
  "trimap_band": 22                    // px either side of the SAM edge marked "unknown"
}
```

`matte_b64` is a single-channel PNG, white = selected. Response also carries
`refined`, `sam_ms`, `refine_ms`. With `refine: true` the matte is SAM 2 → trimap →
ViTMatte (see `docs/notes/matte-edge-pipeline/`); `false` returns the raw SAM mask.

## Models (D-009, D-012)

| Model | Job |
|---|---|
| **SAM 2.1 small** (via `ultralytics`) | segmentation; box / multi-point (+/−) prompts; video memory (planned) |
| **ViTMatte small** (via `transformers`) | trimap → alpha; the edge refine (D-016) |
| **YOLO11n** | person detection for `auto_person` |

Decided as a **Python sidecar**, not ONNX/`ort` — SAM 2's video-memory loop is too fragile
to reproduce as an ONNX export. Everything else in the engine stays ONNX-in-Rust.
