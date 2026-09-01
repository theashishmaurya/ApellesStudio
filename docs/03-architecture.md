# 03 — Architecture

Status: **draft**. This is the intended design, not the current state (current state:
scaffolding only).

## System shape

```
┌──────────────────────────────────────────────────────────────────────┐
│  Chroma app (Tauri)                                                   │
│                                                                      │
│   ┌────────────────────────┐        ┌───────────────────────────┐    │
│   │  Frontend (React/TS)   │  IPC   │  Rust core (src-tauri)     │    │
│   │  - adjustment panels   │◄──────►│  - grade graph (doc)       │    │
│   │  - video canvas + xport│        │  - wgpu render engine ✅   │    │
│   │  - scopes              │        │  - video I/O (ffmpeg) 🔨   │    │
│   │  - mask editor ✅      │        │  - shot / session model 🔨 │    │
│   │  - agent activity feed │        │  - scopes (wgsl compute)🔨 │    │
│   └────────────────────────┘        └────────────┬──────────────┘    │
└────────────────────────────────────────────────────┼─────────────────┘
                                                     │ local socket / stdio
                         ┌───────────────────────────┼───────────────────────┐
                         │                           │                       │
              ┌──────────▼─────────┐      ┌──────────▼──────────┐   ┌────────▼─────────┐
              │  MCP server 🔌     │      │  AI sidecar 🧪       │   │  grade.json      │
              │  (Rust or Python)  │      │  (Python, FastAPI)  │   │  on disk, git    │
              │  tools → core      │◄────►│  SAM2 / DepthV2 /   │   │  the source of   │
              │  every call returns│      │  CoTracker /        │   │  truth for a     │
              │  {frame, scopes}   │      │  color-matcher      │   │  shot's grade    │
              └────────┬───────────┘      └─────────────────────┘   └──────────────────┘
                       │ same protocol
              ┌────────▼───────────┐
              │  Claude Code / any │
              │  MCP client        │
              └────────────────────┘
```

## The four components

### 1. Engine — Rust core (`engine/src-tauri`, forked from RapidRAW)

**Keep from RapidRAW:** the wgpu renderer, WGSL grade shaders, adjustment model, shape +
depth masks, curves, wheels, LUT, white-balance picker, mask panel UI, non-destructive
stack. This is ~70% of the engine and it already runs.

**Add:**
- **Video I/O** — `ffmpeg` (via `ffmpeg-sidecar` crate or `ffmpeg-next` bindings) or
  `gstreamer-rs`. Decode → RGBA frames → the existing grade graph applies per frame →
  encode ProRes 4444 / DNxHR / H.264. Interactive path grades a **proxy** (half/quarter
  res or a cached still per playhead); export grades full-res.
- **Shot / session model** — a session holds N shots; a shot = `{ source_path, in, out,
  grade_doc, reference? }`. Serialised to `session.json` + one `grade.json` per shot.
- **Scopes** — WGSL compute passes over the rendered frame → waveform, RGB parade,
  vectorscope, histogram. Cheap; runs every frame.
- **Grade doc engine** — load/save/validate `grade.json` (`docs/06-grade-format.md`),
  and the rule that *the doc is authoritative* — the UI and the MCP layer both mutate
  the doc, the renderer reads the doc.

### 2. AI sidecar — Python, local

A separate process (FastAPI + uvicorn, or a raw asyncio socket server) because the
models are PyTorch and there is no Rust path worth fighting for.

| Model | Job | Notes |
|---|---|---|
| **SAM 2** | subject segmentation + **video propagation** | point/box/text prompt → per-frame matte (RLE). This is the gesture-proof subject mask. |
| **Depth Anything V2** | monocular depth map per frame | already integrated in RapidRAW for stills; extend to video + temporal smoothing |
| **CoTracker / TAPIR** | point + planar tracking | v2 — drives shape-mask keyframes |
| **color-matcher** | reference colour transfer | Reinhard / MKL / MVGD → a CDL or curve delta, not a baked image |
| matting model | edge/hair refinement on a coarse matte | e.g. `RobustVideoMatting` or guided filter |

Contract: HTTP/socket, requests are `{op, shot_id, frame_range, params}`, responses carry
mattes as RLE + a preview PNG, depth as a 16-bit PNG sequence or a packed buffer, colour
suggestions as grade-doc fragments. The sidecar never touches `grade.json` — it returns
data, the core applies it.

### 3. MCP server 🔌

Exposes the grade graph to an agent. Language TBD (D-008): Rust (shares the core crate,
one process) or Python (simplest, separate process talking to the core over the same
socket the UI uses).

Design rules:
- **Mirror the doc, not the UI.** Tools map to `grade.json` fields, not to buttons.
- **Every mutating tool returns `{ rendered_frame_png, scopes_json }`** so the agent can
  see what it did and iterate — the `apply → inspect → adjust` loop proven in the Palmier
  trials (`docs/05-research.md`).
- **Human handoff is a first-class op.** `request_human(reason, roi)` — the agent says
  "place a bezier on the jawline and track it," the UI highlights the ROI, the human does
  it, the agent continues from the updated doc.
- Full tool list: `docs/07-mcp-surface.md`.

### 4. GUI — forked RapidRAW frontend

RapidRAW is React + TS in a Tauri webview. Keep the panel system, adapt the canvas:
- **Still → video canvas.** Transport bar (play/scrub/step), playhead, in/out.
- **Timeline strip** of shots (not an edit timeline — a shot selector).
- **Scopes panel.**
- **Agent activity feed** — a running log of what the agent changed, each entry a diff of
  `grade.json`, each undoable. The human should always be able to see and revert the
  agent's moves.
- Mask editor: inherited, extended with keyframe handles.

## The hard problem: video presentation through Tauri

Tauri = system webview frontend + Rust backend, IPC between them. Piping 4K RGBA frames
over IPC as base64 on every scrub is a non-starter (D-006).

Options, in order of preference:
1. **wgpu renders directly to a native surface** composited under/over the webview
   (Tauri exposes the raw window handle; wgpu can target it). The webview holds only the
   UI chrome; the image is a native GPU layer. RapidRAW already has a "direct WGPU
   renderer" (changelog 2026-04-18) — extend that path.
2. **Shared GPU texture** — render to a texture the webview samples via WebGPU/WebGL
   (`webview` ↔ native GPU interop). Fiddly, platform-specific.
3. **Local video element** — encode the graded proxy to a short HLS/mp4 the `<video>`
   tag plays. Only viable for playback, not scrub-grading. Fallback for the review view.

**Decision needed early (D-006)** — this shapes the whole frontend.

## Is Rust + Tauri fast enough?

Short answer: **yes for the part that matters, with one caveat.**

- **Image processing** (the grade): Rust + wgpu compute shaders, native, GPU. At 4K a
  reasonable grade (primary + a few masks + curves + LUT) is well under one frame time
  on an Apple Silicon GPU. This is the same class of pipeline as Resolve's. Not a concern.
- **Video decode**: ffmpeg native, hardware-accelerated (VideoToolbox on macOS). Fast.
- **Tauri shell**: lightweight — small binary, low RAM vs Electron, native webview. The
  UI chrome (sliders, panels) is trivial load.
- **The caveat**: the *video canvas presentation path* (above). Get that right and
  full-res 4K interactive grading is realistic. Get it wrong (IPC frame copies) and it's
  a slideshow. This is an architecture decision, not a language limitation.
- **The models** (SAM2 / Depth): these run in the Python sidecar on MPS. SAM2 video is
  roughly a few fps to near-real-time depending on resolution; Depth Anything V2 small is
  fast. These are **setup-time** operations (run once, cache the matte/depth), not
  per-frame-interactive, so their speed matters less. Cache aggressively.

Verdict: the stack is a good fit. Rust+wgpu is arguably the *right* choice for a
grading engine (deterministic, fast, no GC pauses mid-scrub). Tauri is fine as long as
the image bypasses the webview.

## Tech stack (see D-001…D-008 for rationale)

| Layer | Choice | Alt considered |
|---|---|---|
| Engine base | fork **RapidRAW** (Rust + wgpu + Tauri) | libplacebo + own GUI; Natron; from scratch |
| GPU | **wgpu** / WGSL (inherited) | Metal direct; libplacebo |
| Video I/O | **ffmpeg** (`ffmpeg-sidecar` or `ffmpeg-next`) | gstreamer-rs |
| Colour mgmt | v1: display-referred Rec709. v2: **OpenColorIO** | — |
| AI models | **SAM 2, Depth Anything V2, CoTracker, color-matcher** | Palmier magic mask (credits); Resolve (closed) |
| AI runtime | **PyTorch + MPS**, FastAPI sidecar | ONNX Runtime; candle (Rust) — revisit |
| MCP server | **TBD** — Rust (shared crate) or Python (D-008) | — |
| Grade doc | **JSON**, git-tracked, zod/serde-validated | CDL+EDL; a binary format |
| Editor round-trip | **`.cube`** (primary) + **ProRes** (full) + **OTIO** (v2) | XML/AAF |

## Data flow — a grade, end to end

1. `open_shot(source, in, out)` → core creates a shot, decodes a proxy, writes an empty
   `grade.json`.
2. Agent: `read_scopes()` → sees the frame is warm/flat.
3. Agent: `match_to_reference(ref.png)` → sidecar returns a CDL fragment → core merges it
   into `grade.json` → returns `{frame, scopes}`.
4. Agent: `add_mask(kind=subject, prompt="person")` → sidecar runs SAM2 over the range →
   returns RLE mattes → core stores a `subject` mask with per-frame geometry → `{frame}`.
5. Agent: `apply_haze(depth_from=subject)` → core runs Depth Anything (sidecar), builds a
   depth-weighted adjustment (desaturate + lift + dehaze + blur) on the far region.
6. Agent: `request_human("refine the matte around the left hand, frames 40–70")` → UI
   flags it → human paints 3 correction strokes → `grade.json` updated.
7. Agent: `read_scopes()` → confirms → `export(cube)` + `export(prores)`.
8. `grade.json` committed to git. Re-render from it later = identical.
