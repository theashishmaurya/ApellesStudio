# ai/ — Chroma AI sidecar

Local FastAPI service. Models run on MPS (Apple Silicon). Nothing here is on the network;
nothing here touches `grade.json` — it returns mattes, the engine applies them.

## Run

```
cd ai && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
./run.sh                 # -> http://127.0.0.1:8765  (CHROMA_AI_PORT to change)
```

Models auto-download to `ai/models/` on first use (`sam2.1_s.pt` ~88 MB, `yolo11n.pt` ~5 MB).
The engine spawns this process; `run.sh` is for standalone testing.

## Endpoints

| | |
|---|---|
| `GET /health` | `{ok, device, models}` |
| `POST /segment` | one frame → `{matte_b64, width, height, used_box, ms}` |
| `POST /track` *(planned)* | video → per-frame mattes (SAM 2 memory propagation) |

### `/segment` request

```jsonc
{
  "image_b64": "<PNG/JPEG bytes, base64, no data: prefix>",
  "box":   [x1, y1, x2, y2],          // optional, pixel coords
  "points": [[x, y, 1], [x, y, 0]],   // optional; label 1 = include (+), 0 = exclude (−)
  "auto_person": true                  // if no box/points: YOLO finds the most central person
}
```

`matte_b64` is a single-channel PNG, white = selected.

## Models (D-009, D-012)

| Model | Job |
|---|---|
| **SAM 2.1 small** (via `ultralytics`) | segmentation; box / multi-point (+/−) prompts; video memory (planned) |
| **YOLO11n** | person detection for `auto_person` |

Decided as a **Python sidecar**, not ONNX/`ort` — SAM 2's video-memory loop is too fragile
to reproduce as an ONNX export. Everything else in the engine stays ONNX-in-Rust.
