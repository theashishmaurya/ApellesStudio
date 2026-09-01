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
(the wheels), `react-image-crop`, `framer-motion`, `i18next`, `@clerk/react` (auth — for
a community-presets feature; **strip or ignore for v1**).

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

When we change `engine/`: keep new code under `src/chroma/`, keep upstream-file edits to
the minimum, log them here so upstream fixes still cherry-pick (per CLAUDE.md / D-003).
