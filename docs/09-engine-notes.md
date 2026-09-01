# 09 — Engine notes (RapidRAW code-read)

Living map of `engine/` (RapidRAW), branched from upstream commit `4f6a365` (2026-08-31,
shallow). Update this whenever we learn more or diverge from upstream.

Read status: **first pass, not built yet.** ~35k LOC Rust in `src-tauri/src/`.

---

## Toolchain (blocker for building)

| Need | Have (2026-09-01) | Action |
|---|---|---|
| Rust **1.98+**, edition 2024 (`Cargo.toml`) | rustc **1.72.1** | `rustup update stable` — hard blocker, nothing compiles until then |
| Node 18+ | v24.13.0 ✅ | — |
| `cargo-tauri` | not installed | `cargo install tauri-cli` or use `npm run tauri` |
| wgpu 29.0 backend (Metal) | — | fine on Apple Silicon once Rust is updated |

`wgpu` is pinned to `29.0` with the comment *"Downgraded to prevent P3 color shifts on
Apple devices."* → upstream cares about colour accuracy on Mac. Do not bump wgpu without
checking P3 output.

Recorded as **B-001** in `BUGS.md`.

---

## Layout — `src-tauri/src/`

| File | LOC | What it is |
|---|---:|---|
| `lib.rs` | 2435 | Tauri app setup, **115 `#[tauri::command]`s** — the app's whole API surface |
| `gpu_processing.rs` | 2021 | **the wgpu pipeline** — device/queue, textures, the grade compute passes. Core of what we're extending. |
| `image_processing.rs` | 3439 | adjustment/grade logic — the params → shader-uniform translation, the ordering |
| `mask_generation.rs` | 1511 | mask model — shape masks, AI mask plumbing, `generate_mask_overlay` |
| `ai_processing.rs` | 1759 | **ONNX model loading + inference** (see AI section) |
| `ai_commands.rs` | 430 | the tauri commands that call the AI models |
| `ai_connector.rs` | — | cloud AI fallback (`check_ai_connector_status`) — optional, off by default |
| `lut_processing.rs` | 723 | `.cube` parse + apply, LUT previews |
| `lens_blur.rs` | 1035 | AI depth-of-field / bokeh (uses the depth map) |
| `export_processing.rs` | 1701 | export/encode |
| `image_loader.rs` | 1009 | image + RAW decode (`rawler`, `memmap2` for big files) |
| `app_state.rs`, `app_settings.rs` | — | in-memory state, persisted settings |
| `cache_utils.rs` | 311 | preview/thumbnail caching |
| `shaders/*.wgsl` | — | `shader.wgsl` (main grade), `blur.wgsl`, `display.wgsl`, `flare.wgsl` |
| focus_stacking / panorama / hdr_deghosting / inpainting / denoising / negative_conversion / lens_correction / culling / tagging | ~10k | features we **don't** need for grading — leave alone, may strip later |

## The grade path (what we care about)

- Frontend sends adjustment params → `apply_adjustments` (`lib.rs` command) →
  `image_processing.rs` builds the pipeline → `gpu_processing.rs` runs wgsl compute passes
  → rendered image back.
- Non-destructive: params in, pixels out, source untouched. Exactly the model our
  `grade.json` needs.
- **v1 plan:** video = call this path per frame. First spike: decode one frame with
  ffmpeg, hand it to `apply_adjustments`, confirm we get a graded frame out.

### `shaders/shader.wgsl` (1910 LOC) — the grade compute shader

More capable than expected. Bindings:
- `input_texture` → `output_texture` (`rgba8unorm` storage)
- `adjustments: AllAdjustments` = `{ global: GlobalAdjustments, mask_adjustments:
  array<MaskAdjustments, 32> }` — **up to 32 masks, each with its own full adjustment set.**
  Maps 1:1 to our `grade.json` masked entries.
- `mask_textures: texture_2d_array<f32>` — masks are a texture array. **An AI matte
  (SAM/depth) is just a slot in this array.** Our SAM2 per-frame matte → mask texture.
- `lut_texture: texture_3d<f32>` + sampler — standard 3D LUT.
- 4 pre-blurred input textures (sharpness / tonal / clarity / structure) + a flare texture.

Ops already implemented in-shader: linear + **filmic exposure**, tonal + highlight
recovery, **color calibration**, white balance (in linear), creative sat/vibrance, **HSL
panel (8 colours)**, **colour grading wheels (shadows/mids/highs/global + blend + balance)**,
local contrast, sharpen, **dehaze** (← the "haze" the user wants = `apply_dehaze` with a
*negative* amount, per-mask), noise reduction, CA correction, **AgX tone-mapping /
gamut-compress** (modern display transform), 16-point cubic-hermite curves, dither.

Works in **linear light** internally (`srgb_to_linear` / `linear_to_srgb`), has **V-Log**
support (`linear_to_vlog`). Solid colour-science foundation — better than "display-referred
Rec709 only" implies; D-004 (ACES later) is less urgent than thought.

**Implication:** most of v1's grading ops already exist in this shader. Our engine work is
mostly *around* it: video I/O, the `grade.json` ↔ uniform bridge, mask texture management
per frame, scopes, MCP. Not writing grade math.

### `gpu_processing.rs` — more of our plumbing already exists

- **`WgpuDisplay`** — `wgpu::Surface<'static>` + `RenderPipeline` + `DisplayTransform`
  (`rect`, `clip`, `window`, `image_size`, `bg_primary/secondary`). **This is the
  render-to-native-surface path — RapidRAW already renders the image straight to a wgpu
  surface with its own pan/zoom, not as base64 through the webview.** → **D-006 largely
  answered: yes, and it's built.** For video we feed decoded frames into this same
  surface path.
- **`RenderRequest { adjustments: AllAdjustments, mask_bitmaps: &[ImageBuffer<Luma<u8>>],
  lut, roi }`** — **masks are passed as grayscale (`Luma<u8>`) bitmaps.** An AI matte
  (SAM / depth) is exactly that. For video, swap `mask_bitmaps` per frame. Clean fit.
- **`apply_adjustments`** command already takes `js_adjustments: serde_json::Value` (the
  grade is *already* JSON-driven), `is_interactive` (proxy vs full), `roi`,
  `request_analytics`, **`compute_waveform` + `active_waveform_channel`.**
- **Analytics** — `process_and_get_dynamic_image_with_analytics`, `AnalyticsConfig`, async
  readback buffer; `HistogramData` + `calculate_histogram_from_image`. So **histogram +
  single-channel waveform already exist.** We add: RGB parade + vectorscope.
- `process_and_get_dynamic_image` / `_with_analytics` = the headless render entry points
  (no surface) — what the MCP `render_still` will call.

**Net:** the video surface (D-006), the JSON-driven grade, the grayscale-bitmap mask
input, and half the scopes are already there. v1 engine work shrinks to: **video decode →
frame → existing render path**, per-frame mask swap, the `grade.json` schema + bridge,
2 more scopes, and the MCP server.

## AI stack — **all ONNX via `ort` (ONNX Runtime), in-process in Rust**

This is the big finding. No Python. `ort = "=2.0.0-rc.10"` with `load-dynamic`.

| Model | File | Purpose | For us |
|---|---|---|---|
| **SAM (ViT-B)** — v1 | `sam_vit_b_01ec64_{encoder,decoder}.onnx` | point/box subject mask, **single frame** | **swap/augment with SAM 2** (has ONNX exports incl. video memory) for tracked mattes — D-012 |
| **Depth Anything V2** (ViT-S) | `depth_anything_v2_vits.onnx` | monocular depth | reuse directly; extend to per-frame video + temporal smoothing |
| U2-Net / U2-Netp | `u2net.onnx` (320px) | salient foreground mask | maybe a cheap fallback subject mask |
| Sky seg | `skyseg_u2net.onnx` | sky mask | not needed for talking-head |
| CLIP | `clip_model.onnx` | auto-tagging | not needed |
| NIND denoise, LaMa | — | denoise / inpaint | not needed for grading |

Commands already present: `generate_ai_subject_mask`, `precompute_ai_subject_mask`,
`generate_ai_depth_mask`, `generate_full_image_depth_map`, `generate_ai_foreground_mask`,
`generate_ai_sky_mask`, `generate_mask_overlay`.

Models auto-download in `build.rs` / on first use, SHA-256 checked, stored in a models dir.

### Consequence for the architecture

**The "Python AI sidecar" (`ai/`, doc 03 component 2) is downgraded.** For v1:
- SAM 2 + Depth Anything V2 run **in-process via `ort`**, same as RapidRAW does today.
- No socket boundary, no Python env for the user to manage.
- The sidecar survives only as: (a) a prototyping shortcut, (b) a home for models with no
  usable ONNX export (CoTracker/TAPIR — check), (c) `color-matcher` (small pure-Python;
  could also be reimplemented in Rust with `ndarray`/`nalgebra` — both already deps).

→ Update **D-009**. Update doc 03 architecture diagram. Update `ai/README.md`.

## Masks — `mask_generation.rs`

- **`MaskDefinition` + `SubMask`** are `serde` types (parsed from `serde_json::Value` in
  `generate_mask_overlay`) — masks are **already JSON-serialisable**, maps to `grade.json`.
- Every generator returns a **`GrayImage` (`Luma<u8>`)**: shapes
  (`generate_radial_bitmap`, `_linear_`, `_brush_`, `_flow_`), AI
  (`generate_ai_subject_bitmap`, `_depth_`, `_foreground_`, `_sky_`), plus
  `color`/`luminance`/`all` range masks.
- **`generate_ai_bitmap_from_base64(data_url, tf)`** — ingests an *external* matte as a
  base64 image. **This is the hook for our SAM 2 tracked matte: feed a per-frame matte in
  through this path** without touching the model code.
- `TransformParams` — masks live in a crop/rotate-aware transform space.
- `get_cached_or_generate_mask` — a caching layer we extend to be frame-keyed for video.

Pipeline: `MaskDefinition` (JSON) → `generate_mask_bitmap` → `GrayImage` →
`RenderRequest.mask_bitmaps`. Video + tracking: per frame, regenerate from keyframed
geometry OR push a per-frame matte via the base64 path.

## Frontend — `engine/src/` (React/TS, 114 files, ~42k LOC)

| Dir | Role | Our plan |
|---|---|---|
| `components/adjustments/` | the grade panels (primary, curves, wheels, HSL, masks) | **keep** — this is the human-control UI |
| `components/panel/editor/` + `overlays/` | canvas + mask-draw overlays | **extend** — add transport bar + playhead over the existing canvas |
| `components/panel/right/` | right sidebar | keep / adapt |
| `components/panel/library/` | file/folder browser | **replace** with a shot strip (clip-oriented, not folder-oriented) |
| `store/`, `context/`, `hooks/` | state | extend with shot/session + agent-activity state |
| `components/views/` | app views | add / adapt |

Frontend deps of note: `konva` (2D canvas — the mask editor), `@uiw/react-color-wheel`
(the wheels), `react-image-crop`, `framer-motion`, `i18next`. (`@clerk/react` — auth for
RapidRAW's community-presets / hosted-AI feature — **removed** in D-029; the three
`useUser`/`useAuth`/`useClerk` call sites now use local null-returning stubs.)

## What RapidRAW does NOT have (our build list, confirmed)

- **No video.** Zero video deps. No decode, no frames, no timeline, no temporal state.
- **No mask tracking / keyframes.** SAM is per-image; masks are static.
- **No node graph.** Adjustment stack (fine — D-005).
- **No MCP / agent surface.** 115 tauri commands but no external protocol.
- **No scopes** (waveform/vectorscope/parade) — has histogram-ish auto-adjust analysis only.
- **No shot-match-to-reference.**
- Depth is per-still; video would flicker without temporal smoothing.

## Render entry points are Tauri-coupled (→ D-014)

- `process_and_get_dynamic_image(context: &GpuContext, state: &tauri::State<AppState>,
  base_image: &DynamicImage, transform_hash: u64, request: RenderRequest, caller_id: &str)
  -> Result<DynamicImage, String>`
- `get_or_init_gpu_context(state: &tauri::State<AppState>, app_handle: &tauri::AppHandle)`
- So the grade path can't run from a plain binary / test / MCP server. **D-014**: extract
  a Tauri-free `render_core` (`render(gpu, base, req) -> DynamicImage` + `init_gpu_context()`);
  Tauri commands become thin wrappers. First task of Phase 1.
- Notes: `RenderRequest { adjustments: AllAdjustments, mask_bitmaps: &[GrayImage], lut,
  roi }`. Image-dimension guard: if `w|h > max_texture_dimension_2d` it bypasses the GPU
  and returns the source unprocessed (log warning) — watch this at 4K/8K.

## Test asset

`scratch/frame_c019_10s.png` — a 4K frame from `~/Downloads/A001_08302215_C019.MOV` (the
one raw take kept for testing). Source: HEVC, 3840×2160, 24fps, **Rec709** (space +
transfer + primaries — matches D-004 v1 assumption), yuv420p, 517s. The same talking-head
shot used in the Palmier grading trials. ffmpeg decode → frame works; the frame→grade half
waits on D-014.

## Divergence log (our changes to `engine/`)

Branched from upstream `4f6a365`. Append `{date · files · why}`.

Engine is on branch **`chroma`** (branched from `4f6a365`). Our commits live there;
`origin` still = upstream RapidRAW. User adds a personal GitHub remote later.

- **2026-09-01** · new: `src/chroma/{mod,video,state,load}.rs` · edits: `lib.rs` (+`mod chroma;`),
  `image_loader.rs::load_image` (+3-line early branch for video), `formats.rs`
  (`is_supported_image_file` accepts video), `file_management.rs`
  (`get_supported_file_types` exposes `"video"`), frontend `useFileOperations.ts` (Video
  filter group).
  · **Minimal video-open path:** a video loads as its frame 0 into `AppState.original_image`,
  same shape as a still — all grade/mask/display paths unchanged. `chroma::state::CurrentVideo`
  holds the clip for the future transport. 4 tests pass (incl. real C019 probe+decode).
- **2026-09-01** · new: `src/chroma/{commands,state}.rs` grow (transport) + frontend
  `store/useChromaStore.ts`, `components/panel/editor/ChromaTimeline.tsx`, hooks
  `useImageLoader.ts` / `useImageProcessing.ts` / `useFileOperations.ts`, `BottomBar.tsx`.
  · **Transport:** timeline thumbnail strip + play/step/scrub; `chroma_seek`,
  `chroma_video_info`, `chroma_frame_thumbnails`.
- **2026-09-01** · new: `src/chroma/mask.rs` · edits: `lib.rs` (+2 handler lines),
  frontend `hooks/useAiMasking.ts` (route the AI-subject box-drag to `chroma_subject_mask`
  when a video is loaded; skip the ONNX `precompute_ai_subject_mask` for video).
  · **Subject matte (D-016):** `chroma_subject_mask` grabs the de-warped frame → POSTs to
  the `ai/` sidecar `/segment` → returns an `AiSubjectMaskParameters` (same shape as the
  ONNX SAM path) so the mask decode / grade UI / render are all untouched. `chroma_ai_health`
  for a UI hint. Uses the existing `reqwest` dep. v1 limitation: click coords not
  un-rotated → subject mask wrong on a rotated/flipped clip.
- **2026-09-01** · `src/chroma/mask.rs` (+`state.rs`) · **tracking:** `chroma_track_subject`
  → sidecar `/track` (bg job); `chroma_track_status`; `chroma_subject_matte_for_frame` reads
  the nearest cached PNG ≤ frame; `chroma_refine_tracked_frame` → `/refine_track` upgrades
  one frame to ViTMatte. Frontend `useAiMasking.ts` (Track handler + seek-swap effect +
  debounced refine), `MasksPanel`/`SettingsPanel` (buttons), `useChromaStore.ts`.
- **2026-09-01 PM** · **SAM 2 propagation (D-018):** sidecar `/track` rewritten to
  `SAM2DynamicInteractivePredictor`.
- **2026-09-01 PM** · **D-014 render_core seam** — new `src-tauri/src/render_core.rs`
  (`mod render_core;` in `lib.rs`). `gpu_processing::process_and_get_dynamic_image_inner`
  sig: `state: &tauri::State<AppState>` → `caches: &render_core::RenderCaches<'_>`
  (`{ gpu_processor, gpu_image_cache }`), now `pub(crate)`, body unchanged. The two GUI
  wrappers build `RenderCaches` from `state` inline. `render_core::render` /
  `init_gpu_context` / `OwnedRenderCaches` are the headless API (unused pending the MCP
  server). No behaviour change to the GUI render path.
- **2026-09-01 PM** · **render-time matte (D-019)** — the shipping design.
  `mask_generation.rs::generate_ai_subject_bitmap` gained a 4-line branch: if
  `params["chromaTrackDir"]` is set, `mask = crate::chroma::mask::tracked_full_mask(params)`
  → `generate_ai_bitmap_from_full_mask` (else the old base64 path). `chroma/mask.rs`:
  `tracked_full_mask` (reads `<dir>/<current_video().frame>.png`), `chroma_refine_tracked_frame(track_dir, frame)`.
  `chroma_track_subject` dropped its `sub_mask_id` arg (returns `dir`, frontend stores it).
  Removed from `state.rs`: `TRACK_DIRS` + accessors. Removed command:
  `chroma_subject_matte_for_frame`. Frontend: `handleTrackSubject` stores `chromaTrackDir`
  on the sub-mask; `useChromaSubjectTracking` is now just the seek-settle ViTMatte upgrade;
  `Editor.tsx` overlay effect + a single hook mount both key on `frameNonce`;
  `ChromaTimeline` root capture-phase `stopPropagation` removed (was eating strip clicks).
- **2026-09-01 PM** · **control server + MCP bridge (D-020)** — new
  `src-tauri/src/chroma/control.rs` (~150 lines): a blocking `tiny_http` server on
  `127.0.0.1:${CHROMA_CONTROL_PORT:-19788}`, spawned on a thread from `.setup()`. `GET
  /health` (liveness + a best-effort `get_state`), `POST /op {op,args}` (also `POST /<op>`).
  Each request → `app.emit("chroma://request", {id,op,args})`, `app.once("chroma://response/<id>")`,
  20s `mpsc` timeout → 200 / 504. **Zero grade/mask logic** — it just forwards; the op
  registry lives in the frontend.
  · Upstream-file edits (minimal): `Cargo.toml` +1 (`tiny_http = "0.12"`), `chroma/mod.rs` +1
  (`pub mod control;`), `lib.rs` +6 (one `std::thread::spawn` block in `.setup()`).
  · Frontend: new `src/hooks/useChromaControl.ts` — `listen("chroma://request")`, an `OPS`
  registry where **every op calls a real store action** (`useEditorActions().setAdjustments`,
  `useAiMasking()` handlers, `chroma_seek`) so MCP edits move the same sliders/history a drag
  does. Mounted once in `components/panel/Editor.tsx` (+2 lines, next to
  `useChromaSubjectTracking()`). Ops: `get_state, set_primary, set_curve, set_color_grade,
  seek, list_masks, add_subject_mask, track_subject, set_mask_adjust, invert_mask, delete_mask`.
  · Frame for "the agent's eyes": the app renders to a native WGPU surface (D-006), so
  `apply_adjustments` returns `WGPU_RENDER` and never fills `finalPreviewUrl`. The bridge
  instead calls `generate_uncropped_preview` (existing command) and captures its
  `preview-update-uncropped` JPEG data URL — a real headless re-render of the current
  adjustments + masks. Histogram + adjustments come straight from the store.
  · New dir `mcp/` (repo root): Python stdio MCP server (`server.py`, own `.venv`,
  `requirements.txt`, `README.md`) — 11 thin tools, each `POST /op`. `mcp` SDK 2.x
  (`MCPServer`). Not part of `engine/`.
  · v1 limitations: the bridge only runs while the editor view is mounted (an image/video
  must be open); on a fresh app launch the control server is up but `/op` 504s until
  something is loaded.

- **2026-09-01 PM** · **scopes + `inspect_color` (D-021)** — frontend only, **no
  Rust / no `src-tauri` change**. New `src/utils/scopes.ts` (pure, no deps:
  `computeScopes`, `computeGap`, `samplePoint`, `sampleRegion`, `renderParade`,
  `renderVectorscope`). `src/hooks/useChromaControl.ts`: 3 new read-only ops
  (`inspect_color`, `sample`, `sample_region`) + `settleAndCapture` now folds the
  compact `computeScopes` output into every mutating op response as `scopes`.
  Reference images load via the existing `generate_preview_for_path` command
  (neutral adjustments) — no new command, no assetProtocol scope change. `mcp/`:
  3 new tools + scope-first discipline text in the server instructions, the
  mutating tool docstrings, and `mcp/README.md`. Detail: `docs/notes/scopes.md`.

- **2026-09-01 PM** · **video export + `.cube` bake (D-022)** — new
  `src-tauri/src/chroma/export.rs` (self-contained: `export_video`,
  `bake_primary_lut`, 3 commands, `ExportProgress` module-global). Rides
  `render_core::render` + `init_gpu_context` + `OwnedRenderCaches` (D-014) — the
  first real consumer of that seam. Per-frame grade mirrors
  `generate_preview_for_path` (JSON → `AllAdjustments` + `generate_mask_bitmap` →
  `RenderRequest`) with a decoded video frame as the base (no
  `load_and_composite`). One `ffmpeg -f rawvideo` decode pipe (`select=between(n,…)`,
  no input `-ss`) → grade → one `ffmpeg` encode pipe (`prores_ks -profile:v 3` /
  `libx264 -crf 18`). `transform_hash = frame` so the GPU input-texture cache
  doesn't reuse frame 0.
  · Upstream-file edits (minimal): `chroma/mod.rs` +2 (`pub mod export;` + doc line),
  `lib.rs` +3 (`generate_handler!` lines), `chroma/video.rs` +1 (`#[allow(dead_code)]`
  on the test-only `FramePos::Secs`).
  · New in `chroma/state.rs`: `set_current_frame(u64)` — no-decode playhead setter so the
  export loop drives `tracked_full_mask` (D-019) frame by frame; saves/restores
  `CurrentVideo` around the run.
  · Frontend: `src/hooks/useChromaControl.ts` — `export` / `export_progress` ops (both
  READ_ONLY: no settle). `mcp/server.py` — `export(kind, path?, from_frame?, to_frame?,
  quality?)`, polls progress for video.
  · v1 limitations: no audio; parametric `color`/`luminance` masks skipped on video
  export (need GUI-state `resolve_warped_image_for_masks`); crop/ROI on video errors;
  ~~decode is from frame 0 each export (proxy layer = later)~~ — fixed in D-030
  (`spawn_decoder` seeks via `-ss`+`-copyts`+timestamp `select`). Detail: `docs/notes/export.md`.

- **2026-09-01 PM** · **depth-haze preset (D-024)** — mostly frontend.
  · Rust (1 upstream file): `chroma/commands.rs::chroma_seek` +5 lines — clears
  `state.ai_state.depth_map` alongside the other per-frame caches. Reason:
  `ai_commands::generate_ai_depth_mask` caches the depth map by
  `hash(path + geometry)`; on a video both are constant across frames, so a depth
  mask re-generated after a seek would silently use frame 0's depth. `cargo check
  --no-default-features` clean.
  · Frontend: `hooks/useAiMasking.ts` — new `handleAddDepthHaze({amount?, protectSubject?})`
  (builds a "Depth Haze" `MaskContainer` with an inverted full-range `ai-depth` sub-mask
  + the haze grade, calls the existing `handleGenerateAiDepthMask`). `components/panel/right/MasksPanel.tsx`
  — one "Add depth haze" button in the empty-state AI area. `hooks/useChromaControl.ts`
  — `apply_haze` + `open` ops. `mcp/server.py` — `apply_haze` + `open` tools.
  · **`useChromaControl` moved `Editor.tsx` → `App.tsx`** (app-level mount): the bridge
  now answers `/op` before a file is open (was a documented v1 limitation; Phase 4 line).
  Single mount — removed the `Editor` call + import. Paired with the `open(path)` op which
  sets `selectedImage` and lets `useImageLoader`'s effect do the decode.
  · No new engine mask code — the preset rides `generate_ai_depth_bitmap` +
  `MaskDefinition.invert` as-is. ~~`MaskAdjustments` has no blur field → no background
  blur (deferred).~~ Background blur shipped in D-027 (below). Depth Anything V2 ONNX
  output is bright=near; full-range + invert makes the matte value track distance.
  Detail: `docs/notes/depth-haze.md`.

- **2026-09-01 PM** · **`grade.json` save/load (D-025)** — new
  `src-tauri/src/chroma/grade.rs` (self-contained: `chroma_save_grade`,
  `chroma_load_grade`, `SaveResult`, schema helpers, 3 unit tests). Pure
  `serde_json` + `std::fs` — **no GPU, no `AppState`, no store**. Save takes the
  v1 wrapper doc the frontend assembled (`{schema, shot, adjustments, notes}`,
  `adjustments` = the live grade), walks
  `adjustments.masks[].subMasks[].parameters`: each static matte
  (`maskDataBase64` / `mask_data_base64`) → `<gradeName>.mattes/<subMaskId>.png` +
  `{"$matte": "<rel>"}`; `chromaTrackDir` → `{"$trackDir": "<rel-or-abs>"}`
  (referenced, not copied — D-019); pretty-print. Load reverses it + a
  `chroma.grade/<major>` migration gate (v1 identity stub; hard-errors
  newer/unknown major).
  · Upstream-file edits (minimal): `chroma/mod.rs` +2 (`pub mod grade;` + doc
  line), `lib.rs` +2 (`generate_handler!`). `cargo check --no-default-features`
  clean; `cargo test chroma::grade` 3/3.
  · Frontend (nothing else in `src-tauri`): `src/hooks/useChromaControl.ts` —
  `assembleGrade()` + `defaultGradePath()` helpers, ops `get_grade` / `save_grade`
  / `load_grade` (load → `setAdjustments(() =>
  normalizeLoadedAdjustments(grade.adjustments))` + `bumpFrameNonce`; `get_grade`
  + `save_grade` are READ_ONLY). `mcp/server.py` — 3 tools.
  · v1 limitations: one grade per open clip (no multi-shot session model);
  `load_grade` does not switch clips — it flags a `shot.source` mismatch and
  applies anyway; a project move needs the clip's `.chroma/mattes/` dir (the
  `$trackDir` target) alongside `grade.json` + its `.mattes/`. Detail:
  `docs/notes/grade-json.md`.

- **2026-09-01 PM** · **per-mask blur (D-027)** — this one touches **two upstream
  files' hot paths**, tracked carefully:
  · `shaders/shader.wgsl` (2 edits): (1) `MaskAdjustments` struct — renamed the dead
  field `_pad_cg1` → `blur` (no size / offset change); (2) `main()` — a ~20-line loop
  right after the per-mask `apply_color_grading` loop that blends
  `composite_rgb_linear` toward the existing `structure_blurred` sample (the ~40 px
  pre-blur), weight `clamp(mask_influence · blur/100, 0, 1)`, in linear light before
  tone-mapping. No new binding / texture / pass.
  · `image_processing.rs` (2 edits): `MaskAdjustments` Rust struct `_pad_cg1: f32` →
  `pub blur: f32` (mirrors the WGSL rename, `#[repr(C)]` + `bytemuck` layout
  unchanged); `get_mask_adjustments_from_json` reads
  `get_val("details", "blur", 1.0).max(0.0)` in place of the `_pad_cg1: 0.0` literal.
  · **No new `src/chroma/` file** — the change is inherently in the shared shader +
  the JSON→uniform translation. `cargo check --no-default-features` + `cargo test
  chroma::` (11/11) clean; `cargo clippy` clean.
  · Frontend: `utils/adjustments.ts` (`DetailsAdjustment.Blur`, `MaskAdjustments.blur`,
  `INITIAL_MASK_ADJUSTMENTS.blur = 0`), `components/adjustments/Details.tsx` (a
  mask-only "Blur" slider in the Presence group), `i18n/locales/en.json` (+1 key),
  `hooks/useChromaControl.ts` (`MASK_ONLY_KNOBS` set + `blur` accepted by
  `set_mask_adjust`; new `add_mask` op for a plain radial/linear container),
  `hooks/useAiMasking.ts` (`handleAddDepthHaze` recipe += `blur`). `mcp/server.py`
  (`set_mask_adjust` gains a `blur` param; `apply_haze` docstring).
  · Limits: fixed ~40 px radius, ungraded blur sample (shared pre-pass). A
  variable-radius post-grade defocus is a separate pass (approach b), deferred.
  Detail: `docs/notes/mask-blur.md`.

- **2026-09-01 PM** · **sidecar lifecycle (D-028)** — new
  `src-tauri/src/chroma/sidecar.rs` (self-contained: `spawn_and_supervise`,
  `shutdown`, `chroma_ai_status`). Resolves `ai/` + a python interpreter, spawns
  `uvicorn` (`std::process::Command`, no `tauri-plugin-shell`), pipes its
  stdout/stderr to `log::info!("[sidecar] …")`, polls `/health` (a raw
  `TcpStream` HTTP GET — the runtime `reqwest` here has no `blocking` feature),
  restarts on crash with capped backoff, and is killed on app exit. Detects an
  already-running external sidecar and only monitors it (never owns/kills it).
  · Upstream-file edits (minimal): `chroma/mod.rs` +1 (`pub mod sidecar;`),
  `lib.rs` +1 (`std::thread::spawn` in `.setup()`, after `setup_logging` so
  `[sidecar]` lines land in `app.log`), +2 (`chroma::sidecar::shutdown()` in the
  `.run(...)` `ExitRequested`/`Exit` arms, before the existing `libc::_exit(0)` —
  that call skips destructors, so the kill has to happen first), +1
  (`generate_handler!` line for `chroma_ai_status`). `chroma/mask.rs`: the two
  "sidecar unreachable" error strings now mention the auto-start +
  `CHROMA_AI_NO_SPAWN`. No new crate, no Cargo.toml change.
  · `cargo check --no-default-features` clean.
  · **Known gap:** `resolve_ai_dir` keys off `env!("CARGO_MANIFEST_DIR")`, a
  build-machine path — fine for `npm run tauri dev`, wrong for a packaged `.app`.
  Flagged as a Phase 4 packaging TODO, not fixed here (`CHROMA_AI_DIR` /
  `CHROMA_AI_PYTHON` are the escape hatches meanwhile). Detail:
  `docs/notes/sidecar-lifecycle.md`.

- **2026-09-02** · **Strip `@clerk/react` (D-029)** — frontend only. `package.json`
  (dep removed) + `package-lock.json`. `App.tsx`: dropped the `ClerkProvider` import,
  the hard-coded `CLERK_PUBLISHABLE_KEY`, and the `<ClerkProvider>` wrapper around
  `AppWrapper`. `hooks/useAiMasking.ts`, `components/panel/right/AIPanel.tsx`,
  `components/panel/SettingsPanel.tsx`: dropped the `@clerk/react` imports, added
  local null-returning stubs (`useUser` → `{user:null}`, `useAuth` → `{getToken: async
  ()=>null}`, `useClerk` → `{signOut: async ()=>{}}`) so RapidRAW's cloud-provider
  code paths compile and behave as "unauthenticated" (which they already handle).
  `SettingsPanel.tsx`: the `<SignIn>` / `<CloudDashboard>` block replaced with a
  one-line "Chroma runs all AI locally" note (`CloudDashboard` now dead but left in
  place). Kills the `<TitleBar>` React error + the Clerk dev-key console warnings.
  No Rust change. All Chroma AI is local (the `ai/` sidecar + in-process ONNX), so
  there is no account to sign into.

- **2026-09-02** · **persistent decode pipe / smooth playback (D-030)** — new
  `src-tauri/src/chroma/decode_pipe.rs` (self-contained: `FramePipe` +
  process-global `playback_frame` / `reset`, 2 unit tests). One long-lived
  `ffmpeg -ss <(start-0.5)/fps> -i clip -f rawvideo -pix_fmt rgb24 -` per clip;
  `frame(target)` = one sequential `read_exact` for a step, discard-to-target for
  a short forward hop (≤48), kill+respawn for a jump / backward. Raw rgb24 out —
  no per-frame PNG encode/decode. `Drop` kills the child; any pipe error drops the
  pipe and the caller falls back.
  · `chroma/commands.rs::chroma_seek` — decodes via `decode_pipe::playback_frame`
  first, falls back to `video::decode_frame` on error, then
  `load::install_frame`. Cache-clearing logic unchanged.
  · `chroma/load.rs` — split the state-writing tail of `load_video_frame` into a
  new `pub fn install_frame(source, virtual, frame, info, img, state)` so the
  transport can install a frame it already holds (no re-probe / re-decode).
  `load_video_frame` now just calls it.
  · `chroma/state.rs::set_current_video` — reworked the "clip changed" check to
  compare the outgoing `CurrentVideo.path` (not the thumb-cache path, which is
  `None` until the strip is built and would have churned the pipe on every early
  seek). On a real path change it now clears `THUMB_CACHE` **and**
  `decode_pipe::reset()`.
  · `chroma/export.rs::spawn_decoder` — now takes `&VideoInfo` and seeks:
  `-ss <(from/fps)-1s> -copyts` + `select=gte(t,(from-0.5)/fps)` + `-frames:v
  count`. Selecting by **absolute timestamp `t`** (not decoded-frame index `n`)
  is what makes an input `-ss` matte-safe — the concern D-022 avoided by walking
  from frame 0. `from = 0` ⇒ unchanged. Also `decode_pipe::reset()` at export
  entry (free the idle pipe fd).
  · Upstream-file edits: `chroma/mod.rs` +2 (`pub mod decode_pipe;` + doc line).
  No `lib.rs` change (no new command), no Cargo.toml change.
  · `cargo check --no-default-features` clean; `cargo test chroma::` 14/14
  (incl. `seeked_decoder_is_frame_aligned`, `pipe_matches_single_frame_decode`).
  Measured on C019 (3840×2160 HEVC, 24fps): 24 sequential frames decode in
  **0.61 s (~39 fps)** via the pipe vs **15.3 s (~1.6 fps)** as 24 `-ss`+PNG
  spawns. Frontend regrade + IPC per frame is now the ceiling — still open.
  Detail: `docs/notes/smooth-playback.md`.

- **2026-09-02** · **real-time playback / fused play-frame command (D-031)** — new
  `src-tauri/src/chroma/playback.rs` (self-contained: `chroma_play_frame` command,
  `playback_dim`, `PLAYBACK_LONG_EDGE`, the headless timing harness + a
  `playback_dim` unit test).
  · `chroma/decode_pipe.rs` (all new code, no behaviour change to D-030's paths):
  `scale_target(src_w, src_h, long_edge) -> Option<(w,h)>` (even-dim downscale
  target), `FramePipe::open_scaled` / `frame_scaled` / module `playback_frame_scaled`
  — an optional `scale: Option<(u32,u32)>` passed to `ffmpeg -vf
  scale=W:H:flags=fast_bilinear`; a scale change joins path-change / backward /
  long-jump as a respawn trigger. D-030's `open` / `frame` / `playback_frame` are
  now `..._scaled(.., None)` wrappers, `#[allow(dead_code)]` (only the D-030 tests
  call them). New tests: `scale_target_math`, `scaled_pipe_is_sequential_and_downscaled`.
  · `chroma/commands.rs` — `chroma_seek`'s body extracted verbatim into
  `pub async fn seek_and_install(frame, scale_long_edge: Option<u32>, state: &tauri::State<..>)`;
  `chroma_seek` is now a one-line wrapper (`seek_and_install(frame, None, &state)`).
  The decode call uses `playback_frame_scaled` (scale derived from
  `scale_long_edge` via `scale_target`), fallback to `video::decode_frame`
  unchanged. `install_frame` still gets the native `VideoInfo` (so
  `chroma_video_info` keeps reporting native dims to the timeline); only
  `original_image` is the scaled frame, and only during playback.
  · Upstream-file edits (minimal): `chroma/mod.rs` +2 (`pub mod playback;` + doc
  line), `lib.rs` +1 (`chroma::playback::chroma_play_frame` in `generate_handler!`).
  No Cargo change. `chroma_play_frame` reuses the existing `PreviewJob` /
  `preview_worker_tx` path — it builds one job (`is_interactive: false`,
  `target_resolution: Some(dim)`) exactly like the `apply_adjustments` command and
  awaits the oneshot.
  · Frontend: `src/components/panel/editor/ChromaTimeline.tsx` — the `setInterval`
  playback effect + `seekInFlight`/`pending` mutex replaced by a
  `requestAnimationFrame` wall-clock loop calling `chroma_play_frame` (skips
  missed frames, one in flight at a time); a second effect settles full-res on
  pause via the existing `goToFrame`. `useEditorStore` imported for the live
  adjustments. Scrub (`doSeek` → `chroma_seek` + `bumpFrameNonce`) unchanged.
  · `cargo check --no-default-features` clean; `cargo test --no-default-features
  chroma::` 18/18. Harness on C019: **36.5 fps** @ 1280 px (grade 26.6 ms +
  scaled decode 0.83 ms), vs 14.5 fps on the old 4K path. Detail:
  `docs/notes/playback-30fps.md`.

When we change `engine/`: keep new code under `src/chroma/`, keep upstream-file edits to
the minimum, log them here so upstream fixes still cherry-pick (per CLAUDE.md / D-003).
