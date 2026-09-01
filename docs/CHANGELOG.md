# CHANGELOG

One or two lines per session. Detail lives in the decision it references.

## [Unreleased]

- **2026-09-01** — **Depth-haze preset (D-024)**. `apply_haze({amount?, protect_subject?})`
  / an "Add depth haze" button / `useAiMasking.handleAddDepthHaze` → a "Depth Haze" mask:
  a full-range `ai-depth` sub-mask **inverted** so the matte value tracks distance, graded
  with negative `dehaze` (adds haze) + `saturation -25` + `blacks +10` + `shadows +8`, all
  × `amount`. Depth is a **static** bake (per-frame / temporal smoothing deferred);
  `chroma_seek` now busts `ai_state.depth_map` so a re-apply on another frame is correct.
  No per-mask blur (no such field — deferred). Verified on the 1080×1920 talking-head clip:
  `inspect_color` blackPoint 17→33, saturation 0.33→0.24; background pixels lift ~10 luma +
  desaturate while the subject face is untouched; `amount` 0.4/1.0/1.6 scales monotonically.
  Also landed: `useChromaControl` **mounted at app level** (was `Editor`-only) + a new
  `open(path)` op/tool. Engine edit: `chroma_seek` +5 lines, `cargo check` clean. Detail:
  `docs/notes/depth-haze.md`.
- **2026-09-01** — **Video export + `.cube` bake (D-022)**. New
  `engine/src-tauri/src/chroma/export.rs`: `export_video` (one `ffmpeg -f rawvideo`
  decode pipe → `render_core::render` per frame, one GPU ctx for the run → one `ffmpeg`
  encode pipe; ProRes 422 HQ / H.264) and `bake_primary_lut` (`size³` identity lattice
  through the primary grade only → `.cube`, warns on dropped masked layers). Per-frame
  tracked matte via new `chroma::state::set_current_frame` (D-019). Commands
  `chroma_export_video` (background + `chroma_export_progress`) / `chroma_bake_lut`;
  frontend `export` / `export_progress` bridge ops; MCP `export(kind, path?, from?, to?)`.
  Verified on the 1080×1920 test clip: neutral + `exposure` + tracked-subject exports
  (`ffprobe` + frame spot-checks) and a warm `.cube` that reddens a grey ramp in ffmpeg.
  Detail: `docs/notes/export.md`.
- **2026-09-01** — **Scopes + `inspect_color` (D-021)**. New `engine/src/utils/scopes.ts`
  (pure JS, no deps): `computeScopes` (black/white points, luma + per-channel clip %,
  per-zone means, warm-cool + green-magenta cast, 12-bin saturation-weighted hue
  histogram, mean saturation), `renderParade` / `renderVectorscope` PNGs, `computeGap`
  (subject→reference hints that map onto knobs), `samplePoint` / `sampleRegion`.
  Wired into `useChromaControl` as read-only ops `inspect_color(frame?, reference?)` /
  `sample` / `sample_region`; every mutating op response now also carries the compact
  `scopes`. Reference images load via the existing `generate_preview_for_path` command
  — **zero engine Rust change**. `mcp/`: 3 new tools + scope-first discipline ("grade by
  the numbers; cite a scope value or a named region; defer the creative call") in the
  server instructions, the mutating tool docstrings, and `mcp/README.md`. Pure functions
  unit-checked on synthetic ImageData (grey / ramp / warm-cast / orange / clip / gap).
  Detail: `docs/notes/scopes.md`.
- **2026-09-01** — Repo scaffolded. `engine/` submodule = RapidRAW. Docs written (vision,
  PRD, scope, architecture, roadmap, research, grade-format, MCP surface, decisions).
  `CLAUDE.md` rules.
- **2026-09-01** — Engine code-read (`docs/09`). Rust 1.98, `cargo check` passes.
  Findings that shaped decisions: AI is ONNX-in-Rust not Python (**D-009**); `WgpuDisplay`
  is the native video-surface path (**D-006**); render core is Tauri-coupled → extract
  `render_core` (**D-014**). Added D-012 (SAM 1→2), D-013 (relight → v3).
- **2026-09-01** — ffmpeg → 4K Rec709 frame from the C019 test take works. Disk cleaned
  (3.6 → 38 GiB free).
- **2026-09-01** — D-003 decided (standalone hard fork; still keep changes clean for
  upstream cherry-picks), D-012 decided (SAM 2, no fallback).
- **2026-09-01** — App builds + launches (`tauri dev`, 7m18s). Phase 0 done.
  Phase 1 started: `src/chroma/video.rs` — ffmpeg probe + single-frame decode (D-015),
  first engine divergence (all under `src/chroma/`, +1 line in `lib.rs`). Tests pass
  against the real C019 4K take.

## Releases

_(none — pre-v1)_

- **2026-09-01** — Minimal video-open path built: a video loads as frame 0 through the
  existing grade pipeline (`src/chroma/{state,load}.rs` + 3 one-line hooks). Engine on
  branch `chroma`. App rebuilt + running.
- **2026-09-01** — Video transport bar + timeline view (filmstrip → 48-frame thumbnail
  strip when a video is loaded, click/drag to seek). Backend: `chroma_seek`,
  `chroma_video_info`, `chroma_frame_thumbnails` (cached).
- **2026-09-01** — SAM 2 subject mask working (D-012 → Python sidecar, `ai/`,
  `ultralytics` on MPS). Clean silhouette matte on the 4K test frame — the ellipse's
  hands problem is solved. `/segment` supports box + multi-point (+/−) prompts.
- **2026-09-01** — Matte edge refine (**D-016**): SAM 2's 256px decoder staircases at 4K;
  guided-filter finesse (the Resolve approach) failed on the low-contrast test shot; added
  a trimap → **ViTMatte** stage → clean edge. Worklog + before/after in
  `docs/notes/matte-edge-pipeline/`. `transformers` + `opencv-contrib-python` added.
- **2026-09-01** — Subject mask wired into the engine: `src/chroma/mask.rs` —
  `chroma_subject_mask` bridges the current frame → sidecar `/segment` → an `ai-subject`
  mask (RapidRAW's own type, so the grade UI + render are untouched). Box-drag on a loaded
  video now routes to SAM 2 + ViTMatte instead of ONNX SAM. `chroma_ai_health` for a UI
  hint. Engine + frontend both compile; app runs.
- **2026-09-01** — Per-frame subject **tracking**. Sidecar `/track` (background job,
  mattes cached to `<video>/.chroma/mattes/<key>/`), `/refine_track` (upgrade one frame to
  ViTMatte). Engine: `chroma_track_subject`, `chroma_track_status`,
  `chroma_subject_matte_for_frame`, `chroma_refine_tracked_frame`. Frontend: "Track subject
  across clip" + "Finalize matte" buttons + seek swaps the frame's matte. **fast/quality
  modes** — guided-filter edge on the pass, full ViTMatte on the visible frame.
- **2026-09-01** — Tracking rewritten to **SAM 2 memory propagation** (**D-018**):
  `SAM2DynamicInteractivePredictor` (in the installed ultralytics — no new dep), prompt
  once, ~180ms/frame, every frame gets a matte. Gotchas: `conf≈0`, `obj_ids` 0-indexed,
  refine the loose prompt box to a YOLO person box first.
- **2026-09-01** — **B-002 fixed**: sidecar climbed to ~12 GB after repeated Re-track
  (fresh predictor per pass never returned to the MPS pool + concurrent stacking). `_GPU`
  lock serialises model calls; one reused predictor; `_free_gpu()` after every op; `/track`
  cancels a running pass. Plateaus ~1.3 GB now.
- **2026-09-01** — **D-014 done**: `render_core.rs` seam — the render fn takes
  `RenderCaches` (the 2 GPU-cache mutexes) instead of `tauri::State<AppState>`; added
  `init_gpu_context()` (surface-free). GUI render path byte-identical. Unblocks headless
  render + the control/MCP server (next).
- **2026-09-01** — Tracking display reworked (**D-019**): matte is read from disk **at
  render time** (`params.chromaTrackDir` → `tracked_full_mask` → `<dir>/<frame>.png`) in
  `generate_ai_subject_bitmap`, not swapped into `adjustments` per seek. Fixes the
  overlay-regen storm, the frozen timeline, and the frame/matte desync (offset red blob).
  Persists with the project — no re-track on reopen. Also fixed: `ChromaTimeline` root
  capture-phase `stopPropagation` was eating strip clicks. **Mask follows the frame
  perfectly in-app now.**
- **2026-09-01** — **Control server + MCP bridge (D-020) — v1**. `src/chroma/control.rs`
  (`tiny_http`, port 19788, spawned in `.setup()`) ⇄ Tauri events ⇄ new
  `src/hooks/useChromaControl.ts` (mounted in `Editor.tsx`). One shared grade/mask state:
  every MCP op calls the same store action the GUI buttons do (`setAdjustments`, the
  `useAiMasking` handlers, `chroma_seek`) — sliders move, history/undo work, `get_state`
  reflects manual edits. New `mcp/` dir: Python stdio MCP server, 11 tools
  (`get_state, set_primary, set_curve, set_color_grade, seek, list_masks, add_subject_mask,
  track_subject, set_mask_adjust, invert_mask, delete_mask`). Mutating ops return the
  rendered frame (`generate_uncropped_preview`) + histogram + adjustments. Verified end to
  end with `curl` and an MCP client against the C019 take (exposure moves the slider + the
  canvas; subject mask created on the video). Engine edits: `Cargo.toml` +1, `mod.rs` +1,
  `lib.rs` +6. `cargo check` clean.
- **2026-09-01** — Mask refinement decided (**D-023**): use RapidRAW's existing
  Add/Subtract/Intersect composition (works with SAM Subject too), NOT a +/− point
  mechanism. No point UI built. MCP gains `add_subject_mask(mode)`,
  `add_component(mask_id, type, mode)`, `set_submask_mode` — all through the same
  `createSubMask`/`updateSubMask` a slider uses. `ai/` + engine `points` support left
  unused.
