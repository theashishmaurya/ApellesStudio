# 09 — Engine notes (RapidRAW code-read)

Living map of the RapidRAW fork, branched from upstream commit `4f6a365` (2026-08-31,
shallow).

> **As of D-040 (2026-09-02):** the fork is no longer a git submodule — its working
> tree is **vendored at `app/`** (was submodule branch `chroma`, tip `41e9326`).
> Pre-fold history is archived in `engine-history.bundle` (repo root, gitignored).
> There is no live `upstream` remote anymore.
>
> **As of D-281 (2026-09-10):** `app/` is owned code now, not a tracked-upstream drop
> (owner: "it's fine if we change things in rapidraw, as we now gonna own it"). This
> file is no longer a required ledger of every divergence from upstream — a change to
> `app/` just needs the usual `D-NNN`/`B-NNN` in the usual places, same as anywhere
> else in the repo. Kept as a historical map / for entries genuinely worth recording,
> not as a cherry-pick-tracking obligation.

Read status: **first pass, not built yet.** ~35k LOC Rust in `app/src-tauri/src/`.

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
| `lib.rs` | 2436 | Tauri app setup, **116 `#[tauri::command]`s** — the app's whole API surface |
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

## Frontend — `app/src/` (React/TS, 114 files, ~42k LOC)

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
  · v1 limitations: no audio;
  ~~parametric `color`/`luminance` masks skipped on video export (need GUI-state
  `resolve_warped_image_for_masks`)~~ — fixed in **D-135**: `prepare_frame` holds the
  source frame, so it builds the warped image itself with `apply_geometry_warp` (a
  borrow at identity), conditional on a mask actually needing it;
  ~~crop/ROI on video errors~~ — **superseded by D-135, 2026-09-04**. The history is
  worth keeping straight: originally the whole CPU geometry pre-pass was silently
  *dropped* and the export "succeeded" with the wrong pixels (B-042); D-127 made it
  refuse, which is what briefly made this line accurate; D-135 makes the export
  actually **apply** crop / straighten / flip / 90° / lens warp, spawning the encoder
  from the first graded frame's measured size and rasterising masks at that size with
  the real crop offset. `unsupported_geometry` is deleted. The only geometry an export
  still refuses is a crop that rounds to zero in either axis under the even-dimension
  rule (`yuv420p` needs a multiple of 2; we round **down**, trimming ≤1 row/column);
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
  one-line "Apelles runs all AI locally" note (`CloudDashboard` now dead but left in
  place). Kills the `<TitleBar>` React error + the Clerk dev-key console warnings.
  No Rust change. All Apelles AI is local (the `ai/` sidecar + in-process ONNX), so
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

- **2026-09-02** · **agent activity feed + `request_human` (D-032)** — frontend
  only, **no `src-tauri` / Rust change** (the op rides the generic `POST /op`
  bridge path).
  · New (all Apelles-owned): `src/store/useAgentStore.ts` (the feed + the
  single-slot `request_human` state), `src/utils/agentActivity.ts` (`diffAdjustments`
  — structural before/after grade diff, mask containers matched by id, matte
  blobs collapsed to `<matte>`; `summarizeActivity` — per-op one-liners),
  `src/components/chroma/AgentActivityDock.tsx` (fixed bottom-left dock: feed
  with per-entry expandable diff + jump-to-here undo, + the `request_human`
  banner), `src/components/chroma/AgentRoiHighlight.tsx` (canvas ROI rect).
  · `src/hooks/useChromaControl.ts` (Apelles-only file, D-020): new `request_human`
  op (validates `reason`, clamps `roi` to 0..1, `useAgentStore.postHumanRequest`,
  returns an ack — added to `READ_ONLY` so no settle); `get_state` now returns
  `pendingHumanRequest`; the `chroma://request` handler records one
  `AgentActivityEntry` per mutating op (snapshot `{historyIndex, adjustments}`
  before `fn`; after settle, `debouncedSetHistory.flush()` to force one history
  entry, then `diffAdjustments` + `recordActivity`; `seek`/`open`/read-only ops
  skipped). Imports `debouncedSetHistory` from `useEditorActions`.
  · Upstream-file edits (minimal): `src/App.tsx` +2 (import + `<AgentActivityDock/>`
  next to the other app-level mounts), `src/components/panel/editor/ImageCanvas.tsx`
  +2 (import + `<AgentRoiHighlight>` in the existing absolute overlay layer, same
  coordinate space as the mask overlay).
  · `mcp/server.py` — `request_human(reason, roi?)` tool (24 tools now).
  `mcp/README.md` tool count + list updated.
  · Verified: `npx tsc --noEmit` — 74 pre-existing unrelated errors (baseline
  unchanged), none in a touched/new file; `python3 -m py_compile mcp/server.py`
  clean. Bridge listener doesn't hot-reload → running-app behaviour is an open
  manual smoke test. Detail: `docs/notes/agent-activity-feed.md`.

- **2026-09-02** · **multi-shot session + shot strip (D-033)** — Rust + frontend,
  no `AppState` / image-loader change.
  · `src/chroma/state.rs` — the single `CURRENT_VIDEO: Option<CurrentVideo>`
  global becomes a `Session { shots: Vec<Shot>, active }` global (`Shot` is a type
  alias of `CurrentVideo` — the D-015…D-032 call sites are untouched).
  `current_video()` keeps its signature (returns `shots[active]`);
  `set_current_video(Some)` now **upserts by path** (fresh clip → append + make
  active; seek / re-open → update in place), `set_current_video(None)` clears the
  session; the thumb-cache + `decode_pipe::reset()` fire iff the active clip path
  changed. `set_current_frame` mutates the active shot. New: `session_shots` /
  `session_set_active` / `session_remove` wrappers + the pure `Session` struct
  (5 unit tests).
  · new `src/chroma/session.rs` (self-contained: `chroma_session_list` /
  `_add` / `_set_active` / `_remove` / `_thumbnail`, `ShotDto` / `SessionDto`).
  `_add` funnels through `load::load_video_frame`; `_set_active` / `_remove`
  decode the newly-active shot's frame via the D-030 pipe (falls back to
  `video::decode_frame`) and `load::install_frame` it.
  · `src/chroma/video.rs` — `+ extract_thumb(path, info, frame, height)`: one
  small preview JPEG (data URL) per shot for the strip.
  · Upstream-file edits (minimal): `chroma/mod.rs` +2 (`pub mod session;` + doc
  line), `lib.rs` +5 (`generate_handler!` lines). No Cargo change.
  · Frontend: new `src/store/useSessionStore.ts` (shot list + `grades` per-shot
  cache + switch/add/remove/copy thunks — `switchToShot` stashes the live grade,
  restores the target's via `setAdjustments` + `resetHistory`, calls
  `useAgentStore.scopeToShot`), new `src/components/chroma/ShotStrip.tsx` (the
  strip — the doc-09 "replace `components/panel/library/` with a shot strip"
  line; the library browser is left in place, the strip is additive).
  `src/store/useAgentStore.ts` +3 (`activeShotKey`, `shotFeeds`, `scopeToShot`)
  — the D-032 feed is now per-shot. `src/hooks/useChromaControl.ts` (Apelles-only
  file) — `list_shots` / `set_active_shot` / `add_shots` ops, `get_state` +=
  `session`. Upstream-file edit: `src/components/panel/BottomBar.tsx` +4 (import
  + `<ShotStrip/>` + a session-sync effect).
  · `mcp/server.py` — `list_shots` / `set_active_shot` / `add_shots` (24 → 27).
  `mcp/README.md` tool list updated.
  · Verified: `cargo check --no-default-features` clean; `cargo test
  --no-default-features chroma::` 23/23; `npx tsc --noEmit` baseline unchanged
  (74 pre-existing, none in a touched file); `py_compile` clean, 27 tools.
  Bridge listener + running app not driven → strip interaction + MCP round-trip
  are an open manual smoke test (`docs/notes/multi-shot.md`).

- **2026-09-02** · **mask keyframes (D-034)** — Rust + frontend, no `lib.rs` /
  Cargo / `AppState` change (the ops ride the generic `POST /op` bridge).
  · new `src-tauri/src/chroma/keyframes.rs` (self-contained, pure): `Keyframe`,
  `parse_keyframes` (frame-sorted; `None` on absent/empty/malformed),
  `interpolate(&[Keyframe], frame)` (linear scalars, shortest-arc `rotation`,
  clamp/hold outside the range, brush `points`/`lines` element-wise-lerp when the
  shape matches else snap-to-nearest), `interpolated_parameters(&Value)` — the
  hook: `Some(params with geometry overlaid, chromaKeyframes stripped)` for a
  keyframed shape sub-mask on a video; `None` (zero-cost) for un-keyframed / a
  tracked sub-mask (`chromaTrackDir` wins) / a still. 14 unit tests.
  · **Upstream-file edit — `mask_generation.rs`:** ONE hook call at the top of
  `generate_sub_mask_bitmap` (just after the `visible` check) — mirrors the D-019
  `tracked_full_mask` precedent in `generate_ai_subject_bitmap`:
  `if let Some(interp) = crate::chroma::keyframes::interpolated_parameters(&sub_mask.parameters)
  { let mut sm = sub_mask.clone(); sm.parameters = interp; return
  generate_sub_mask_bitmap(&sm, …); }`. Recursion terminates — the returned
  params have `chromaKeyframes` removed. Nothing else in the file changed.
  · `chroma/mod.rs` +2 (`pub mod keyframes;` + a doc line).
  · Frontend: new `src/utils/maskKeyframes.ts` (mirror of the Rust interpolator —
  same rules/cases; drives the interpolated canvas overlay + the keyframe
  button/drag), new `src/components/chroma/MaskKeyframeBar.tsx` (mounted in the
  Apelles-owned `ChromaTimeline` — ◆ keyframe button + a diamond track + delete /
  clear). Apelles-only `src/hooks/useChromaControl.ts` += 4 ops
  (`add_mask_keyframe` / `list_mask_keyframes` / `clear_mask_keyframe` /
  `clear_mask_keyframes`; `list_mask_keyframes` is `READ_ONLY`).
  · **Upstream-file edit — `src/components/panel/editor/ImageCanvas.tsx` +~4:**
  imports (`useChromaStore` + `maskKeyframes` helpers); a `chromaFrame`
  subscription; `updateSubMaskKeyframeAware` (a `useCallback` wrapping the
  `updateSubMask` prop — when the target shape sub-mask has keyframes, a
  `{parameters}` update becomes an `upsertKeyframe` at `chromaFrame`, not a new
  static geometry); the mask-overlay `renderSubMask` swaps in
  `effectiveParameters(base.parameters, chromaFrame)` so the on-canvas shape is
  the interpolated one; `onUpdate={updateSubMaskKeyframeAware}` on `<MaskOverlay>`.
  · `mcp/server.py` +4 tools (27 → 31). `mcp/README.md` tool table updated.
  · Verified: `cargo check --no-default-features` clean; `cargo test
  --no-default-features chroma::` **37/37** (23 + 14). `npx tsc --noEmit` 74
  pre-existing, none in a touched/new file. `py_compile` clean, 31 tools. Export
  (D-022) + playback (D-031) interpolate for free — both set
  `current_video().frame` before the grade (`export.rs` `set_current_frame` per
  frame; `commands::seek_and_install` → `install_frame` → `set_current_video`).
  Running-app path is an open manual smoke test (`docs/notes/mask-keyframes.md`).

- **2026-09-02** · **depth track (D-036)** — per-frame temporally-consistent
  depth, model in the `ai/` sidecar (Video Depth Anything — Small, Apache-2.0),
  render-time read in Rust. Mirrors the D-018/D-019 subject track.
  · new `src-tauri/src/chroma/depth.rs` (self-contained): `chroma_depth_track` /
  `chroma_depth_track_status` (thin bridges to the sidecar `/depth_track`,
  mirror `chroma::mask::chroma_track_subject` / `_status`), and
  `tracked_depth_map(&Value) -> Option<GrayImage>` — the render-time read:
  `params.chromaDepthDir` + `current_video().frame` → nearest `<n>.png` ≤ frame
  (holds between samples for `step > 1`). `None` (→ static bake, byte-identical)
  when the param is absent/empty, no video, or nothing cached. 4 unit tests.
  · **Upstream-file edit — `mask_generation.rs::generate_ai_depth_bitmap`:** ONE
  hook, exactly the D-019 `tracked_full_mask` shape in `generate_ai_subject_bitmap`
  — `let depth_map = match crate::chroma::depth::tracked_depth_map(params_value)
  { Some(full) => generate_ai_bitmap_from_full_mask(&full, &tf), None =>
  generate_ai_bitmap_from_base64(&params.mask_data_base64?, &tf)? };` (+ moved the
  `data_url` bind out so a track-only sub-mask with no base64 still renders).
  Nothing else in the file changed. The band/invert/feather maths below are
  untouched — VDA's PNG is bright=near, same as the Rust DA-V2 bake.
  · `chroma/mod.rs` +2 (`pub mod depth;` + a doc line). `lib.rs` +2
  `generate_handler!` lines. **No `AppState` / Cargo change** — the Rust DA-V2
  ONNX path (`ai_processing::run_depth_anything_model`, `ai_commands::generate_ai_depth_mask`)
  is untouched and stays the static single-frame bake for stills / un-tracked haze.
  · Frontend: `src/hooks/useAiMasking.ts` — new `handleTrackDepth` (mirror of
  `handleTrackSubject`); `handleAddDepthHaze` gains `tracked?` (video only →
  also runs the track and stamps `chromaDepthDir`). `src/store/useChromaStore.ts`
  +2 (`depthTrackProgress` + setter). Apelles-only `src/hooks/useChromaControl.ts`
  += `depth_track` (non-blocking — starts the job, fire-and-forget poll stamps
  the dir) + `depth_track_status` ops; `apply_haze` op forwards `tracked`.
  `src/utils/agentActivity.ts` +1 formatter. **Upstream-file edit —
  `src/components/panel/right/MasksPanel.tsx` +~10:** thread `handleTrackDepth` /
  `chromaDepthTrackProgress` through to `SettingsPanel`, one "Track depth over
  clip" button in the `Mask.AiDepth && chromaIsVideo` block (mirrors the subject
  track button right above it).
  · `ai/server.py` — `/depth_track` + `/depth_track/{job_id}` (mirror `/track`):
  bg job in `_jobs` tagged `kind:"depth"`, cancels a running depth job only,
  `_GPU` lock around the infer, `_free_gpu()` in `finally`, lazy checkpoint
  download to `ai/models/`, global (whole-clip) percentile normalisation for
  temporal stability. `sys.path` += `ai/vendor/`. `/health` += `video_depth`.
  New `ai/vendor/video_depth_anything/` (vendored, Apache-2.0 — not
  pip-installable; `ai/vendor/README.md` documents the licence + the vits-only
  rule + the 3 local edits). `ai/requirements.txt` += `einops`, `easydict`.
  New `ai/test_depth_track.py` (gated `CHROMA_DEPTH_TEST=1` + a scratch/ clip).
  · `mcp/server.py` +2 tools (`depth_track`, `depth_track_status`; `apply_haze`
  += `tracked`) → **33**. `mcp/README.md` + `ai/README.md` updated.
  · Verified: `cargo check --no-default-features` clean; `cargo test
  --no-default-features chroma::` **41/41** (37 + 4 depth-read). `npx tsc
  --noEmit` 74 pre-existing (baseline unchanged), none in a touched/new file.
  `py_compile` clean for `mcp/server.py` + `ai/server.py`; `import server` OK,
  33 tools. `ai/test_depth_track.py` on Tokyo-Walk (16 frames): worker `done`,
  PNGs non-degenerate, VDA consec |Δ| 0.0032 vs per-frame DA-V2 0.0050 (1.54×
  steadier). Sidecar `/depth_track` HTTP path + the running-app button/scrub are
  an open manual smoke test (`docs/notes/depth-track.md`).

- **2026-09-02** · **Project launcher + `<name>.chroma` project model (D-037)** —
  the home screen becomes a grid of saved projects, not RapidRAW's folder browser.
  · New: `src/chroma/project.rs` — `ProjectManifest` + load/save (pure
  `serde_json` + `std::fs`, no GPU/`AppState`, like `grade.rs`) + commands
  `chroma_project_list` / `_open` / `_new` / `_save` / `_relink` / `_current` /
  `_settings_dir` / `_set_dir`. 8 new tests (**41 → 49** chroma tests).
  · `src/chroma/state.rs` += a `ProjectRef {path,name}` module-global
  (`set_project` / `current_project`) so save knows where to write.
  `current_video()` unchanged. `video.rs::extract_thumb` reused for `thumb.jpg`.
  · **Upstream-file edits (minimal):** `chroma/mod.rs` +2, `lib.rs` +8
  `generate_handler!` lines. `src/store/useUIStore.ts` — default
  `activeView: 'library'` → `'projects'`. `src/App.tsx` — one import, one
  `useProjectAutosave()` call, **one routing conditional**
  (`activeView === 'projects'` → `<ProjectLauncher/>`, else `<LibraryView/>`
  unchanged) + the Settings-overlay gate `hasRoots` →
  `(hasRoots || activeView === 'projects')`. `src/hooks/useAppNavigation.ts` —
  the editor "back" button routes to `'projects'` (folder / album navigation
  still routes to `'library'`; **LibraryView / albums / culling NOT deleted**).
  · Apelles-only frontend: new `components/chroma/ProjectLauncher.tsx`, new
  `hooks/useProjectAutosave.ts`. `store/useSessionStore.ts` (D-033) extends with
  `projectPath` / `projectName` / `gradeDir` / `dirty` / `shotIds` /
  `offlineShots` + `openProject` / `newProject` / `saveProject` /
  `saveUntitledAs` / `relinkShot` / `_hydrateOpenDto`; `switchToShot` flushes the
  outgoing shot's grade, `addShots` / `removeShot` keep `shotIds` synced.
  `hooks/useChromaControl.ts` += ops `list_projects` / `open_project` /
  `new_project` / `save_project` + `get_state().project`.
  `components/chroma/ShotStrip.tsx` += offline-shot cards + Relink + an Untitled
  "Save project" pill.
  · `mcp/server.py` +4 tools → **37**. `mcp/README.md` updated.
  · Grades for a project shot save to `<name>.chroma/grades/<shotId>.grade.json`
  (inside the project — media is only referenced), via the same
  `chroma_save_grade` command with an explicit path. D-025's matte / `$trackDir`
  / `$depthDir` rules unchanged.
  · Verified: `cargo check --no-default-features` clean; `cargo test
  --no-default-features chroma::` **49/49**. `npx tsc --noEmit` 74 pre-existing
  (baseline unchanged via `git stash -u`), none in a new/touched file.
  `py_compile` + `import server` clean, 37 tools. Launcher grid / New-Project /
  autosave / reopen / media-offline+relink are an open manual smoke test
  (`docs/notes/project-model.md`).

- **2026-09-02** · **Per-project `settings` = a typed output spec (D-038)** —
  D-037's reserved free-form `settings: Value` gets a real shape:
  `ProjectSettings { width?, height?, fps?, color_space? }`, all optional. Absent
  settings = clip-derived everywhere (byte-identical exports), so it is purely
  additive; `chroma.project/1` schema major is unchanged.
  · `src/chroma/project.rs` — new `ProjectSettings` struct + `merge_patch()` +
  `infer_settings_from_clip()`; `ProjectManifest.settings` is now typed
  (`#[serde(default)]`, deserializes leniently from legacy `{}` / `{fps:24}`);
  `ProjectOpenDto.settings` typed; `new_project_in` seeds settings by probing the
  first shot's clip; new command `chroma_project_set_settings(path?, partial)`
  (partial merge → save `project.json` → return merged). 5 new tests
  (**49 → 54**): typed round-trip, legacy `{fps:24}` still loads, empty/absent
  → all `None`, `merge_patch` semantics, new-project infers from an ffmpeg-made
  clip; + a gated `export_resolution_override` test in `export.rs`.
  · `src/chroma/export.rs` — `ExportOpts` gains `out_width` / `out_height`; when
  set, the graded composite (rendered at clip res) is Lanczos3-resized to that
  as the last step before the encoder (a few lines at the existing dimension
  read). `chroma_export_video` reads the loaded project's `settings` and feeds
  `width`/`height` → resize and `fps` → the existing `fps_override` path (an
  explicit `fps_override` arg still wins). No project / no settings ⇒ the resize
  is skipped, output is unchanged. `color_space` is stored + surfaced only —
  encoder pass-through / display transform deferred to D-004.
  · **Upstream-file edits:** `lib.rs` +1 (`chroma_project_set_settings` in
  `generate_handler!`). Nothing else in Rust core.
  · Apelles-only frontend: `store/useSessionStore.ts` += `ProjectSettings` type,
  `projectSettings` state (hydrated from `_hydrateOpenDto`'s `dto.settings`),
  `setProjectSettings(partial)` thunk. `hooks/useChromaControl.ts` +=
  `get_state().project.settings` + op `set_project_settings`. New
  `components/chroma/ProjectSettingsModal.tsx` (resolution / fps presets +
  custom + "match first clip", colour-space dropdown with a "metadata only"
  hint). `components/chroma/ShotStrip.tsx` += a "Settings" gear (real projects
  only) opening the modal.
  · `mcp/server.py` +1 tool → **38** (`set_project_settings`). `mcp/README.md`
  + `docs/07-mcp-surface.md` updated.
  · Verified: `cargo check --no-default-features` clean; `cargo test
  --no-default-features chroma::` **54/54**. `npx tsc --noEmit` 74 pre-existing
  (baseline unchanged via `git stash -u`), none in a new/touched file.
  `py_compile` + `import server` clean, **38** tools. Editor "Project settings"
  modal, a 1080p-override export, a clear-to-clip-res export, and MCP
  `set_project_settings` + `get_state` are an open manual smoke test
  (`docs/notes/project-model.md`) — the `useEffect([])` bridge listener does not
  hot-reload; a stale cargo fingerprint may need `cargo clean -p apelles` + a
  dev-server restart to link the new command.

- **2026-09-02** · **Editor tab MVP — single-track timeline + scrub preview (D-041)** —
  new crate consumer: `app/src-tauri` gains a path dep
  `apelles-timeline = { path = "../../crates/apelles-timeline" }` (D-039 L2, made
  real in this task). All bridge code is new: `src/chroma/edit.rs` — three
  commands (`chroma_timeline_get` / `_set` / `_frame`), a per-clip `VideoInfo`
  probe cache, timeline build-from-shots, and a **standalone decode→jpeg preview
  path** (`decode_pipe::playback_frame_scaled` → `image` JPEG q80 → `data:` URL)
  that is deliberately independent of the Colorist `AppState` / wgpu / grade
  render path.
  · **Upstream-file edits (minimal):** `chroma/mod.rs` +1 (`pub mod edit;` +
  doc line); `chroma/project.rs` — `ProjectManifest.timeline:
  Option<apelles_timeline::Timeline>` (`#[serde(default)]`, schema major
  unchanged, threaded through `fresh()`); `lib.rs` +3 `generate_handler!` lines;
  `app/src-tauri/Cargo.toml` +1 path dep. Nothing else in Rust core.
  · **Frontend (`@apelles/editor`, greenfield):** `timeline.ts` (model mirror +
  pure ops), `timelineStore.ts` (`useEditorTimelineStore` zustand), `PreviewPane`
  (img + transport + rAF play loop), `TimelinePane`
  (`@xzdarcy/react-timeline-editor`), `EditorTab` (layout + empty state). New
  deps on `@apelles/editor` only: `@xzdarcy/react-timeline-editor`,
  `@tauri-apps/api`, `zustand`.
  · Verified: `cargo build --no-default-features` clean; `cargo test
  --no-default-features -p apelles-timeline` **9/9**; `cargo test
  --no-default-features chroma::` **54/54** (unchanged); `npm install` clean;
  `cd app && npx tsc --noEmit` **74** (baseline unchanged, none in
  `packages/editor`); `cd app && npm run build` (vite prod) green. **Manual
  smoke test open** (open a project in the Colorist tab → Edit tab → scrub /
  split / trim / reorder / delete / restart-persistence). New commands were
  added → a `cargo clean -p apelles` + dev-server restart may be needed to
  clear the stale-incremental-fingerprint issue before the commands link.

- **2026-09-02** · **Strip RapidRAW's DAM/welcome/library/community shell (D-043)**
  — the largest single divergence from upstream to date, and the first that
  **deletes** rather than adds. Prior analysis: `docs/notes/colorist-strip.md`.
  Overrides D-003 ("keep everything cherry-pickable") for this one layer: the
  library/welcome/albums/culling/community code will never run again in Apelles,
  so keeping it as dead routed code was pure noise, and the branding actively
  misled. The **grading engine stays untouched** — wgsl shader, masks,
  adjustments model, every `panel/right/*` panel, canvas/preview, scopes, LUT,
  curves, wheels, `components/chroma/*` — this divergence is scoped to the
  DAM/shell layer only.
  · **Frontend deleted:** `components/views/LibraryView.tsx`,
  `components/panel/MainLibrary.tsx`, `components/panel/library/` (whole dir:
  `CullingView`, `LibraryGrid`, `LibraryHeader`, `LibraryItems`),
  `components/panel/CommunityPage.tsx`, `components/panel/right/FolderTree.tsx`
  (~1126 LOC — the folder-tree/album-tree "Sources" panel the owner named
  directly), `components/modals/CullingModal.tsx`,
  `components/modals/ImportSettingsModal.tsx` (orphaned once the import-into-folder
  flow it served went with FolderTree). `ColumnWidths` relocated from
  `MainLibrary.tsx` into `useLibraryStore.ts` (its only surviving consumer).
  · **`App.tsx` gutted:** the `<LibraryView>` mount → `<ColoristEmptyState/>`
  (new, `components/chroma/`); `activeView`-derived routing collapsed —
  `hasMainContent` is now `!!selectedImage`, `isWgpuActive` drops the
  `activeView === 'editor'` clause; `handleGoHome` / `handleBackToLibrary` /
  `handleContinueSession` / `handleSelectSubfolder` / `handleSelectAlbum` /
  `handleOpenFolder` and the folder/album drag-drop targets are gone; the
  `hasRoots` gate on the settings overlay dropped (folder-tree state).
  · **`useUIStore.activeView` deleted** (was `'editor' | 'library' | 'community'`
  — collapsed to its one surviving value). Album/import/folder modal state
  (`isCreate/RenameFolderModalOpen`, `isImportModalOpen`,
  `isCreate/RenameAlbumModalOpen`, `albumActionTarget`, `folderActionTarget`,
  `importSourcePaths`/`importTargetFolder`) and the now-dead `searchFocusRequest`
  / `requestSearchFocus` (their only caller, `focus_search`, was library-only)
  deleted. `Panel.FolderTree` removed from the switcher + default layouts.
  · **`useLibraryStore`** — kept (27 importers, several are keepers: `Editor.tsx`,
  `BottomBar.tsx`, `Filmstrip.tsx`, `MetadataPanel.tsx`, …) but pruned of
  `rootPaths`, `currentFolderPath`, `expandedFolders`, `folderTrees`,
  `pinnedFolderTrees`, `albumTree`, `activeAlbumId`, `expandedAlbumGroups`,
  `isTreeLoading`, `libraryScrollTop`. Kept: `imageList`, `multiSelectedPaths`,
  `libraryActivePath`, `libraryActiveAdjustments`, `imageRatings`,
  `isViewLoading`, `sortCriteria`, `filterCriteria`, `searchCriteria` (the last
  one is itself dead — nothing calls `setSearchCriteria` any more since
  `LibraryHeader`'s `SearchInput` is gone with it — left alone as a follow-up,
  not touched this pass, since `useSortedLibrary.ts`'s filtering logic still
  reads it and wasn't in this task's file list).
  · **Hooks gutted**, each down to what still operates on the actively-edited
  image / filmstrip selection, independent of any library folder concept:
  `useAppNavigation.ts` (610 → `handleImageSelect` only),
  `useKeyboardShortcuts.ts` (`open_image` / `paste_files` / `toggle_folder_tree`
  / `toggle_library_exif` / `focus_search` actions + the library grid-nav
  builtin + the Escape ladder's home/back-to-library rungs deleted;
  `activeView === 'editor'` guards simplified to `!!selectedImage`),
  `useAppContextMenus.ts` (`buildAddToAlbumMenu`, `handleFolderTreeContextMenu`,
  `handleAlbumTreeContextMenu`, `handleMainLibraryContextMenu` deleted; the
  editor + thumbnail context menus survive, pruned of Add/Remove-from-Album),
  `useLibraryActions.ts` (`refreshAllFolderTrees`, `handleTogglePinFolder`,
  `handleCreateAlbumItem`, `handleRenameAlbumItem` deleted), `useFileOperations.ts`
  (`handleCreateFolder`, `handleRenameFolder`, `handlePasteFiles`,
  `startImportFiles`/`handleStartImport`/`handleImportClick` deleted —
  import-into-library and paste-into-folder have no destination without
  FolderTree), `useAppInitialization.ts` (pinned/root folder-tree restore on
  launch, `libraryViewMode`, the "Continue Session" preloaded-folder-contents
  optimization, `lastFolderState` persistence, and the folder-image-counts
  re-fetch effect all deleted — app settings/theme/workspace/thumbnails/
  sort-filter/language init unchanged), `useTauriListeners.ts` (`indexing-*`
  and `import-*` event listeners deleted — their Rust emitters went with
  `start_background_indexing` / `import_files`).
  · **Two things the analysis didn't anticipate**, resolved consistently with
  its intent rather than deferred: (1) `export_processing::run_headless_export`
  calls `file_management::list_images_recursive` directly, in-process — not
  through any frontend `invoke`, so the earlier `Invokes.*` usage audit missed
  it. Kept as a plain internal fn (dropped `#[tauri::command]`, not registered
  in `generate_handler!` — no longer reachable from the frontend at all).
  (2) `TetheringPanel`'s capture button required a browsed library folder
  (`destinationFolder: currentFolderPath`) and would always show "select a
  folder first" with FolderTree gone; it now owns a one-off native folder
  picker instead, asked for lazily on first capture and remembered for the
  session — TetheringPanel stays fully functional without reintroducing the
  DAM. Also caught: `update_rotational_disk_flag`'s only two callers
  (`list_images_in_dir` / `list_images_recursive`) were both going away, which
  would have silently frozen HDD-aware thumbnail throttling at its default
  (assume-SSD) forever — moved the call into `start_thumbnail_workers`'s
  per-thumbnail loop instead (more accurate than the old once-per-folder-browse
  approximation, not just a preserved behaviour).
  · **Rust removed** — Tier 1 (album/community, nothing else referenced them):
  `fetch_community_presets`, `generate_all_community_previews`, `mod culling`
  (`culling::cull_images`, 318 LOC), `file_management::{save_community_preset,
  get_albums, save_albums, add_to_album, get_album_images, get_albums_path}` +
  the `AlbumItem`/`Album`/`AlbumGroup` enum + `sort_album_tree` +
  `sync_album_path_changes` (the last one had 3 call sites inside otherwise-kept
  functions — `delete_files_from_disk`, `delete_files_with_associated`,
  `rename_files` — stripped the call + the now-write-only `renames`/`deletions`
  collections from each, kept everything else in those three). Tier 2 (the
  FolderTree "Sources" panel decision — analysis recommended taking it in this
  pass since it unlocks Tier 2, and that's what happened):
  `file_management::{list_images_in_dir, get_folder_tree, get_folder_children,
  get_pinned_folder_trees, get_folder_tree_sync, create_folder, delete_folder,
  rename_folder, move_files, copy_files, import_files,
  get_or_create_internal_library_root, get_internal_library_root_path}` +
  `FolderNode`/`ImportSettings` structs + `has_subdirs`/`scan_dir_lazy` helpers;
  `tagging::{start_background_indexing, clear_ai_tags, clear_all_tags}` +
  their private helpers (`rrdata_source_path`, `sync_xmp_for_rrdata`) and the
  CLIP/HSV auto-tagging cluster (`generate_tags_with_clip`, `extract_color_tags`,
  `preprocess_clip_image`, `softmax`, `rgb_to_hsv`) — all unreachable once
  `SettingsPanel`'s "Clear AI tags" / "Clear all tags" / "Clear sidecars" rows
  (root-folder scoped, always-empty without FolderTree) were pruned; the whole
  `tagging_utils/` module (`TAG_CANDIDATES` 590 entries, `TAG_HIERARCHY`) went
  with it, and `AppState.indexing_task_handle`. Also removed as newly-orphaned:
  `file_management::{get_cache_key_hash, get_cached_or_generate_thumbnail_image}`
  (only caller was the deleted CLIP indexer) and, after auditing the real
  invoke-string surface post-frontend-edits (not just trusting the
  analysis's Tier-1/Tier-2 lists at face value — two entries there turned out
  wrong): **kept** `tagging::{add_tag_for_paths, remove_tag_for_paths}`
  (analysis had these as Tier 2, but the kept editor/thumbnail tagging
  context-menu — `TaggingSubMenu` — calls them directly) and **removed**
  `file_management::read_exif_for_paths` (analysis had this as a keeper; its
  only real caller was the deleted `handleSelectSubfolder`'s bulk-EXIF-on-scan
  path). `file_management.rs` net **−1366 lines** (4222 → ~2860), all via named
  function/struct deletion — no reformatting of surviving code beyond what
  those deletions required; `tagging.rs` **533 → 94 lines**.
  · **Deferred, not touched this pass** (flagged, not fixed — outside this
  task's file list, no build/test impact, just `dead_code` warnings):
  `ai_processing.rs`'s CLIP model download/cache infra (`CLIP_MODEL_URL` +co,
  `get_or_init_clip_models`, the `AiState.clip_models` field) — its only caller
  was the deleted `generate_tags_with_clip`, but removing it means touching
  `AiState`'s struct definition and other init sites, a bigger blast radius
  than this pass's Tier-1/Tier-2 Rust list. `app/bench/replay.js` (RapidRAW's
  own benchmark tooling) has a `back-to-library` step that's now permanently
  dead — separate from and not gated by this task's verification.
  · **Branding**: `tauri.conf.json` window title, `TitleBar.tsx` (unrouted,
  kept for reference), `SettingsPanel.tsx`'s `CloudDashboard` `getrapidraw.com`
  links (removed — the buttons were unreachable anyway, `isPro` never true per
  D-029), the exported-file EXIF `Software` tag and the skeleton-XMP
  `x:xmptk` attribute (`RapidRAW` → `Apelles` — these ship in every exported
  file/sidecar, not just UI chrome) all fixed. i18n: `library.splash.*` block
  (welcome splash — brand/version/donate/contribute/continue-session copy)
  removed from **all 13 locale files**; every other `RapidRAW` string
  (`settings.thanks.description`, `settings.general.nativeTitlebarDesc`, the
  AI-connector provider blurbs, the OSS-credits list entries) renamed to
  `Apelles` in all 13 locales; `*.rapidRawPreset` label reworded to drop the
  brand word entirely (`"RapidRAW Preset"` → `"Preset"`, and equivalent for
  each locale's translation) rather than just swapping the brand name in, per
  the analysis's call. Explanatory code comments citing "RapidRAW" as the
  upstream engine name are accurate provenance, not branding — left alone
  (`utils/scopes.ts`, `hooks/useChromaControl.ts`, `hooks/useAiMasking.ts`,
  `chroma/*.rs` module docs, etc. — `grep -rn "RapidRAW" app/src app/src-tauri/src`
  is a clean list of exactly these after this pass).
  · Verified: `cargo build --no-default-features` clean (only the pre-flagged
  `ai_processing.rs` CLIP warnings, deferred above); `cargo test
  --no-default-features chroma::` **54/54** (unchanged); `cd app && npx tsc
  --noEmit` **64** (down from the 74 baseline — deleting ~7800 LOC of files that
  carried some of the baseline errors, e.g. `FolderTree.tsx`'s own type issues,
  lowered the count; zero *new* errors — diffed the full before/after error
  list, not just the count); `cd app && npm run build` (vite prod) green.
  Net: **app/src + app/src-tauri/src: 51 files changed, 363 insertions(+), 7823
  deletions(-)** (`git diff --stat` — close to the analysis's −7000..−9000
  estimate), plus the 13 locale-file edits.

- **2026-09-02** · new: `src-tauri/src/chroma/relight.rs` (pure + 10 tests,
  incl. a real-GPU determinism test), `src/utils/relightUtils.ts`,
  `src/components/panel/editor/RelightPuckLayer.tsx`,
  `src/components/chroma/RelightPanel.tsx` · edits: `image_processing.rs`
  (+`RelightLightGpu`, `AllAdjustments` +3 fields — the 2 pad fields are
  `pub(crate)`, not private, so `export_processing.rs` can construct a full
  `AllAdjustments` via `..Default::default()` — + `get_all_adjustments_from_json`
  hook), `mask_generation.rs` (+`generate_relight_depth_bitmap`), `lib.rs`
  (`process_preview_job` appends a resolved depth bitmap to `mask_bitmaps`,
  a `let`-chain per clippy), `export_processing.rs`
  (`build_single_mask_adjustments` zeroes relight too — a per-mask isolation
  export, relight is global not mask-scoped), `shaders/shader.wgsl`
  (+`RelightLight` struct, `AllAdjustments` +3 fields, `apply_relight`+3
  helper fns, one call site pre-vignette), `chroma/mod.rs` (+1 `pub mod`),
  `utils/adjustments.ts` (+`RelightLight` interface, `Adjustments` +2 fields),
  `utils/maskKeyframes.ts` (+1 `GEOMETRY_KEYS` entry), `ImageCanvas.tsx`
  (+`isRelighting` prop + puck-layer mount + drag handler, ~30 lines),
  `Editor.tsx`/`App.tsx` (panel wiring), `store/useEditorStore.ts`
  (+`activeRelightLightId`), `hooks/useAiMasking.ts`
  (+`handleTrackRelightDepth`), `hooks/useChromaControl.ts` (+4 ops:
  `list_relight_lights`/`add_relight_light`/`set_relight_light`/
  `delete_relight_light`, mirroring `add_mask`'s shape),
  `components/ui/AppProperties.tsx` (+`Panel.Relight`),
  `components/panel/PanelSwitcher.tsx` (+icon/tooltip), `store/useUIStore.ts`
  (panel registration), `i18n/locales/en.json` (+1 tooltip key).
  · **Interactive relight (D-048 — mislabeled "D-046" in this note until
  D-054 fixed it; D-046 is actually "Media pool pass 3"):** a new "Relight"
  grade layer + a depth-driven WGSL shading pass, riding D-024's existing
  mask-texture-array plumbing (one more `textureLoad` layer, no new bind
  group) and D-036's existing depth-track sidecar job (same commands, a new
  top-level `relightDepthDir` target instead of a mask's parameters). No
  `AppState` / Cargo / Tauri-command / bind-group change. Verified against
  the real running app + a real project over the control-server bridge
  (D-048's "Verified" section has the detail). Full design in D-048. Small
  deferred follow-ups (static depth-bake fallback, export wiring, a Preset
  tab, MCP tool wrapping) landed 2026-09-03 as D-054.

- **2026-09-03** — **Interactive relight follow-ups (D-054)**, on top of
  D-048's vendored-file edits above · edits: `mask_generation.rs`
  (+`generate_relight_depth_bitmap_static` — decodes a static base64 depth
  bake through the existing `generate_ai_bitmap_from_base64` warp path;
  +`resolve_relight_depth_bitmap` — the one entry point every render path
  now calls, tracked dir first then static-bake fallback; +6 tests),
  `lib.rs` (`process_preview_job` now calls `resolve_relight_depth_bitmap`
  instead of its old inline dir-then-bitmap two-step — same behaviour for
  the tracked case, the fallback for free). `chroma/export.rs` (new Apelles
  code, not an upstream-fork file) wires the same resolver into
  `grade_frame` — see D-054 for the full write-up.

- **2026-09-04** — **Per-clip crop in the Edit-tab compositor (D-132)** ·
  **zero upstream-file edits** — the whole change lives in Apelles' own
  `chroma/edit.rs` (`crop_pixel_rect`, crop applied at the head of
  `composite_layer_onto`, `ClipTransform::is_identity` gating the
  single-layer fast path) plus the `apelles-timeline` crate. Logged anyway
  because it *deliberately did not* reach for the upstream function that
  looks like it fits: `image_processing::apply_crop` (Colorist's) takes an
  absolute-pixel `{x, y, width, height}` on one loaded still and physically
  shrinks the image. The Edit tab needs a normalised, per-layer window that
  crops **in place** inside a multi-layer composite (D-127 Finding 3) — the
  two share a word, not a code path, and folding them together would have
  pushed compositor concerns into the stills path. Also fixed here:
  **B-053**, the single-layer preview path skipping compositing — and so the
  whole D-082 transform — unconditionally.

- **2026-09-04** — **Video export honours the Colorist's geometry (D-135,
  B-042)** · **zero upstream-file edits** — everything is in Apelles' own
  `chroma/export.rs` (`prepare_frame`, `align_encoder_dims`,
  `resolve_encoder_dims`, `fit_frame_to_encoder`, `EncoderPipe`, and
  `unsupported_geometry` deleted). Logged because it is the opposite move to
  D-132's: where the Edit-tab crop *deliberately did not* reach for
  `image_processing::apply_crop`, this one deliberately **calls the upstream
  chain wholesale** — `adjustment_utils::apply_all_transformations`, plus
  `image_processing::apply_geometry_warp` for the parametric-mask warp — rather
  than re-implementing warp → lens blur → 90° → flip → straighten → crop with
  export-flavoured rounding. Same principle both times (extend upstream, don't
  reimplement it); the two crops just sit on opposite sides of it because
  Colorist's geometry *is* the stills pre-pass and the Edit tab's is not. A
  second copy of that chain's arithmetic is also why the encoder is now sized
  from the first graded frame's measured dimensions instead of a predicted
  size: a predicted one could drift from the upstream function by a pixel and
  shear the whole file.

- **2026-09-05** — **Per-clip fades (D-147)** · **zero upstream-file edits.**
  Everything is in Apelles' own files: `crates/apelles-types/src/{fade.rs,
  lib.rs}`, `crates/apelles-timeline/src/lib.rs`,
  `crates/apelles-media/src/audio.rs`, `chroma/audio.rs`, `chroma/edit.rs`,
  `packages/editor/*`, and one
  Apelles-owned frontend file in the fork, `app/src/hooks/useChromaControl.ts`
  (the D-020 MCP bridge — a Apelles addition, not an upstream RapidRAW file), which
  gains two ops in its existing `OPS` registry and an `@apelles/editor` import.
  No `generate_handler!` line was added: the fade rides the existing
  `chroma_timeline_get`/`chroma_timeline_set` verbatim-document contract rather
  than getting a command of its own, so the Tauri surface is unchanged. Logged
  because the *absence* of an upstream edit is the point — a new clip property
  reaching both the compositor and the audio mixer is exactly the kind of change
  that could have leaked into `image_processing.rs`, and did not.

- **2026-09-07** — **Canvas click-to-select (D-204, fixing B-085)** · **zero
  upstream-file edits.** All of the behaviour is in `packages/editor/*`
  (`canvasPick.ts`, `useCanvasClipPick.ts`, `transformGeometry.ts`,
  `useClipGeometry.ts`, `PreviewPane.tsx`, `TransformOverlay.tsx`). The only
  file touched inside the fork is `app/src/harness-main.tsx` — a Apelles
  addition (D-142's permanent pointer-gesture browser harness), not an upstream
  RapidRAW file: its `chroma_timeline_clip_geometry` stub now resolves its real
  track/clip arguments instead of returning one fixed answer, so two layers can
  have genuinely different boxes to hit-test against. No new Tauri command and
  no `generate_handler!` line: the fix reuses `chroma_timeline_clip_geometry`
  and `chroma_timeline_composition_size` exactly as they are. Logged because
  the *absence* of a backend change is the point — the note's own open question
  had assumed a new per-layer-rect command was required, and it was not.

- **2026-09-07** — **B-087: two `getState()`-in-render bugs fixed** ·
  upstream-file edits (both pre-existing upstream files, no new modules):
  `src/components/views/EditorView.tsx` (the `useEditorStore` selector's
  `useShallow` object gains `copiedAdjustments: state.copiedAdjustments`, and
  `isPasteDisabled` reads it from the destructured selector result instead of
  `useEditorStore.getState().copiedAdjustments === null`) and `src/App.tsx`
  (`ImageDragOverlayNode`'s `url` becomes `useProcessStore((s) =>
  s.thumbnails[activeItem.path])` instead of a `.getState()` read). Both were a
  real Rules-of-React violation flagged by D-201's React Compiler bailout audit
  (`docs/notes/react-compiler-coverage.md`): a `getState()` read inside a render
  body has no subscription, so a change to that field alone re-renders nothing —
  the Colorist "Paste" button stayed disabled after copying adjustments until
  something else happened to re-render `EditorView`. See `docs/BUGS.md` B-087.

- **2026-09-08** — **Debug webview screenshot (D-210)** · new Apelles code only,
  plus three one-to-two-line upstream-file edits. New: `src-tauri/src/chroma/
  debug_capture.rs` (the `WKWebView takeSnapshot` capture + PNG pixel probe)
  and `src/hooks/useDebugScreenshot.ts` (a Apelles addition, not an upstream
  RapidRAW file — the Cmd/Ctrl+Shift+D affordance). Upstream-file edits, all
  minimal: `src-tauri/src/chroma/mod.rs` (+`pub mod debug_capture;` and its
  doc-list line — a Apelles-owned file anyway), `src-tauri/src/lib.rs` (+2
  `generate_handler!` lines, `chroma_debug_screenshot` /
  `chroma_debug_sample_pixel`), and `src/App.tsx` (+2: the import and the
  `useDebugScreenshot()` call, mounted next to the existing
  `useChromaControl()` / `useProjectAutosave()` / `useColoristHistoryBridge()`
  block — the same pattern D-051 and the AgentActivityDock already use).
  `src-tauri/Cargo.toml` gains four macOS-only dependency lines (`block2`,
  `objc2-app-kit`, `objc2-foundation`, `objc2-web-kit`) — all already in the
  workspace lock via tauri/wry/muda/cpal, so no new crate enters the build.
  Deliberately NOT touched: `window_customizer.rs`, the one existing
  ObjC-interop file (it uses `objc` 0.2 + raw `msg_send!`; new code uses the
  typed `objc2` stack instead — see D-210 — and churning working upstream code
  to unify the two was not worth it). `chroma/control.rs`'s new `native_op()`
  is in a Apelles-owned file.

- **2026-09-08** — **Text/title clips (D-211/D-212/D-213)** · **zero
  upstream-file edits.** The whole feature lands in Apelles-owned code: a new
  `app/src-tauri/src/chroma/text.rs` (the font catalogue + `ab_glyph`
  rasteriser), additions inside `app/src-tauri/src/chroma/edit.rs` (Apelles'
  own module), `crates/apelles-timeline` and `packages/editor/*`. The upstream
  footprint is the usual two lines and nothing else: `pub mod text;` in
  `app/src-tauri/src/chroma/mod.rs` and one `chroma::text::chroma_text_fonts,`
  entry in `lib.rs`'s `generate_handler!` — exactly the shape D-003 asks for.
  `app/src-tauri/Cargo.toml` gains one dependency line (`ab_glyph`, already in
  the workspace lock at that version as `imageproc`'s own dependency, so the
  lock's only change is the new direct edge). No `image_processing.rs` edit, no
  grade-path edit, no change to any upstream React component: a title is
  composited by `chroma::edit`'s own CPU compositor, which upstream RapidRAW
  does not have.

- **2026-09-08** — **Preview compositor + frame IPC payload (D-217)** · **zero
  upstream-file edits.** Everything is inside Apelles-owned code:
  `app/src-tauri/src/chroma/edit.rs` (`blend_layer_sampled`, the
  `timeline_frame` → `timeline_frame_image` + `encode_preview_jpeg` split, and
  `chroma_timeline_frame` now returning `tauri::ipc::Response` instead of a
  `String`), plus `packages/editor/*`. `app/src-tauri/src/chroma/project.rs`'s
  own test was updated for the new return type — also a Apelles file. **No
  `lib.rs` change at all:** the command's `generate_handler!` entry is
  unchanged, since the macro does not name the return type. `app/src/
  harness-main.tsx` (the Apelles-owned browser harness, see the 2026-09-08
  D-210 entry above) had its `chroma_timeline_frame` stub switched to raw
  bytes to keep modelling the real backend. No new dependency, so `Cargo.toml`
  and the lock are untouched.

- **2026-09-08** — **Preview viewport zoom (D-218) + B-099** · **zero upstream-
  file edits, zero Rust edits.** All of the behaviour is in `packages/editor/*`
  (`previewZoom.ts`, `usePreviewContentBox.ts`, `PreviewPane.tsx`,
  `TransformOverlay.tsx`, `CanvasBoundary.tsx`, `useCanvasClipPick.ts`,
  `timelineStore.ts`, `useEditorControl.ts`) and `packages/player/*`
  (`Player.tsx`'s zoom prop set). The only file touched inside the fork is
  `app/src/harness-main.tsx` — the Apelles-owned browser harness again (see the
  two entries above), and this time as a **bug fix, B-099**: the entry
  immediately above switched its `chroma_timeline_frame` stub to
  `atob(STUB_FRAME_BASE64)` but left the `data:image/jpeg;base64,` prefix on
  that constant, so `atob` threw at module load and the whole harness page
  mounted nothing. The prefix is now gone (the constant is the bare payload its
  own name always claimed), which is what made the real-Chromium verification
  of D-218 possible at all. No backend change of any kind: a viewport zoom is
  display-only and the compositor never learns about it.

- **2026-09-08** — **Transitions (D-226/D-227) + B-103** · **zero upstream-file
  edits.** Everything inside the fork is in Apelles' own `src/chroma/edit.rs`
  (the `VisibleLayer`-shaped layer list, the colour-plate arm and the
  `with_transition_alpha` multiply in `composite_video_frame`, the `pipe_slot`
  helper, and a new `preview_transition_tests` module). No `generate_handler!`
  line changed: the four `editor_*_transition` ops are frontend control-bridge
  ops (`@apelles/editor`'s `useEditorControl.ts`), not Tauri commands, so
  `lib.rs` is untouched. The rest is Apelles-owned crates
  (`crates/apelles-timeline`'s `Transition`/`VisibleLayer`,
  `crates/apelles-media`'s `PipeSlot::TrackTransition` +
  `retain_track_slots` → `retain_pipe_slots`) and `packages/editor/*`
  (`timeline.ts`, `timelineExport.ts`, `editorExport.ts`, `TimelinePane.tsx`,
  the new `TimelineTransitions.tsx`) plus `mcp/server.py`. No new dependency:
  `Cargo.toml` and the lock are untouched. **The three Rust files touched here
  were also `cargo fmt`-normalised**, which reformats some pre-existing code in
  them — the tree was not rustfmt-clean at HEAD under the current toolchain, so
  formatting only the new code was not possible without leaving those files
  non-conformant; no other file was reformatted.

- **2026-09-08** — **Italic/bold faces + a Bold/Italic style toggle (D-240)**
  · **zero upstream-file edits.** Everything lands inside the same
  already-Apelles-owned `app/src-tauri/src/chroma/text.rs` D-212 created (10 new
  `TEXT_FONTS` entries + `group`/`bold`/`italic` metadata on `FontFamily`/
  `ResolvedFont`), `packages/editor/*` (`textFonts.ts`'s new
  `composeFontStyleKey`/`fontStyleOf`/`baseFontFamilies`,
  `TextClipInspectorPanel.tsx`/`CaptionInspectorPanel.tsx`'s toggle buttons,
  `useEditorControl.ts`'s `bold`/`italic` op-arg handling) and `mcp/server.py`.
  No `generate_handler!` change — `chroma_text_fonts` was already registered
  by D-212, only its return payload grew fields. No new dependency: the 10 new
  candidate paths are the SAME macOS system font families D-212 already
  references (Arial/Arial Narrow/Georgia/Times New Roman/Courier New), never a
  file vendored into the repo, so `Cargo.toml` and the lock are untouched.


- **2026-09-09** — **The Colorist grade rendering on the Edit timeline
  (D-256)** · **one upstream-file line.** The whole bridge is a new
  Apelles-owned module, `app/src-tauri/src/chroma/grade_lut.rs`, plus edits to
  Apelles-owned files only (`chroma/edit.rs`'s compositor, `chroma/export.rs`'s
  `bake_primary_lut` — whose body moved into the new module rather than being
  copied — `chroma/project.rs`'s two `join("grades")` call sites, and
  `chroma/mod.rs`'s module list). The Apelles crates take the rest
  (`apelles-types`' new pure `lut3d` module, `apelles-project`'s new
  `grade_dir`), as do `packages/editor/*` (the new `gradeLuts.ts`,
  `timelineExport.ts`, `editorExport.ts`, `EditorExportDialog.tsx`,
  `useEditorControl.ts`) and `mcp/server.py`.

  **The upstream footprint is exactly one `generate_handler!` line in
  `lib.rs`** (`chroma::grade_lut::chroma_timeline_grade_luts`). Nothing else
  upstream is touched: crucially, the grade **shader and `gpu_processing` are
  read, never modified** — the bake calls the existing headless
  `render_core::render` seam (D-014) with an identity lattice as its input
  image, which is precisely what D-022's own `.cube` bake already did. So the
  one thing this decision depends on from upstream is a call, not a change,
  and an upstream shader fix still cherry-picks cleanly and simply changes what
  the lattice bakes to.

  **No new dependency.** `rayon` (used to parallelise the per-frame lattice
  application) was already an `app/src-tauri` dependency; `Cargo.toml` and the
  lock are untouched.

  **Formatting:** unlike D-226's entry above, no file was `cargo fmt`-
  normalised here. The tree is still not rustfmt-clean at HEAD under the
  current toolchain, so a whole-file format would have reformatted unrelated
  pre-existing code in `edit.rs`/`export.rs`/`project.rs`; the new code was
  written to rustfmt's own output shape instead and the touched files were left
  otherwise byte-identical, keeping the diff scoped to this change.


- **2026-09-09 — D-260 (Motion→Edit "auto re-render, auto-replace").**

  **Upstream footprint: exactly one `generate_handler!` line in `lib.rs`**
  (`chroma::project::chroma_media_refresh`). Nothing else upstream is touched.

  Everything else is inside our own `src/chroma/` or in the `crates/`:
  - `chroma/motion.rs` — the render now writes to a staging sibling and
    `rename`s it onto the destination, then drops any live decode pipe on that
    path. Apelles-only file (created by D-046); no upstream code involved.
  - `chroma/project.rs` — a new `chroma_media_refresh` command beside the
    existing `chroma_media_*` family. Apelles-only file.
  - `crates/apelles-media/src/decode_pipe.rs` — a new
    `drop_pipes_for_path`; nothing existing changed.
  - `crates/apelles-media/src/filmstrip.rs` — B-127: `KEYFRAME_MEM` now carries
    the `source_key` it was measured under. Behaviour change is strictly "a
    replaced file is re-measured instead of serving a stale answer."
  - `crates/apelles-project/src/manifest.rs` — an optional
    `MediaItem::motion_scene_id`, a `refresh_media` model function, and
    `thumb_is_stale`.

  **No new dependency.** `Cargo.toml` and the lock are untouched.

  **Formatting:** as with D-256, no file was whole-file `cargo fmt`-normalised.
  The tree is still not rustfmt-clean at HEAD under the current toolchain, so a
  blanket format would have reformatted unrelated pre-existing code in a dozen
  files (`export.rs`, `state.rs`, `video.rs`, …). `cargo fmt` was run and then
  reverted on every file this change does not otherwise touch, keeping the diff
  scoped; the new code is rustfmt's own output shape.


When we change `engine/`: keep new code under `src/chroma/`, keep upstream-file edits to
the minimum, log them here so upstream fixes still cherry-pick (per CLAUDE.md / D-003).

---

## D-273 (2026-09-10) — the keybind registry moved out of the fork

**What changed in `app/`:**

- **`app/src/utils/keyboardUtils.ts` — DELETED.** Its `KEYBIND_DEFINITIONS`
  (45 rows), `KEYBIND_SECTIONS`, `normalizeCombo`, `formatKeyCode` and the
  `symMap` are now `packages/keymap/src/{shortcuts,combo}.ts`, behaviour
  unchanged. The move was forced by layering, not preference: `packages/*` may
  not import from `app/src`, so the Edit and Motion tabs could never have used
  the fork's registry where it sat — which is exactly why they had grown their
  own hardcoded keys. Action **ids and default combos are byte-identical**, so
  the `keybinds` map already in a user's `settings.json` keeps working.
- **`app/src/hooks/useKeyboardShortcuts.ts`** — no longer owns a `window`
  listener or its own combo map. The same `actions` table (unchanged
  behaviour, including every `shouldFire` guard) is now registered with
  `@apelles/keymap`'s shared dispatcher via `useShortcuts`, and every row is
  `scope: 'colorist'` so it cannot fire under the Edit or Motion tab (B-138).
  Its two `builtinShortcuts` (Escape-backs-out, contextual mask-Delete) keep a
  small listener of their own — deliberately not registry rows, being modal
  contextual gestures rather than rebindable shortcuts.
- **`app/src/components/panel/SettingsPanel.tsx`** — the inlined keybind editor
  (the `KeybindRow` component, `handleKeybindSave`, `conflictingKeys`, and the
  section-rendering block) is **removed**; that card now points at the new
  app-level Keyboard Shortcuts window. Moved rather than duplicated: the fork's
  pane listed Colorist's actions only and was unreachable without switching to
  the Colorist tab first.
- **`app/src/Root.tsx`** — new bridge effects hydrating `@apelles/keymap` from
  `appSettings.keybinds` and handing it a persistence sink back to
  `handleSettingsChange`, plus `translate={t}` passed to `Shell` so the fork's
  13 translated locales still render translated Colorist rows.

**No Rust change.** `app_settings.rs`'s `keybinds: HashMap<String, Vec<String>>`
is generic enough to carry the new action ids as-is; `Cargo.toml` and the lock
are untouched.

**Cherry-pick impact:** an upstream change to RapidRAW's `keyboardUtils.ts` or
to `SettingsPanel.tsx`'s keybind section will now conflict. Upstream keybind
*definition* changes port to `packages/keymap/src/shortcuts.ts` (the
`colorist(...)` rows); upstream *behaviour* changes to a shortcut's action port
to `useKeyboardShortcuts.ts`'s `actions` table, which is otherwise unchanged.
