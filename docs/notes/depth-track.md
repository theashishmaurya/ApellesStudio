# Depth track — per-frame temporal depth (D-036)

The depth-haze preset (D-024) baked **one** Depth Anything V2 map and reused it
for every frame. On a locked-off talking head that's fine. On a moving camera the
depth is wrong for every frame but the one it was computed on — the haze crawls,
the fg/bg separation slips, edges shimmer.

The fix is a **depth track**: precompute depth for every frame, temporally
stable, cached to disk, read at render time keyed by the current source frame —
exactly the shape of the SAM subject track (D-018 `/track` → per-frame matte
PNGs → D-019 render-time read via `chromaTrackDir`). The depth equivalent of
`chromaTrackDir` is **`chromaDepthDir`**.

## Why a temporal model, not per-frame + EMA

DaVinci Resolve's Depth Map moved from a per-frame model to a
**temporally-consistent video depth model** ("z-depth estimation is now temporal,
it understands the motion of depth"). That's the bar. Running a per-frame model
and smoothing its output with an exponential moving average is *not* that — it
smooths the output of a model that doesn't know frames are related, so it lags on
motion, smears depth edges across a pan, and can't reason about occlusion.

**Video Depth Anything — Small** (CVPR 2025 Highlight) is the current SOTA
zero-shot open video-depth model: the Depth Anything V2 DINOv2 ViT-S backbone +
a **spatial-temporal head** — temporal self-attention across a 32-frame window
plus a temporal-gradient consistency loss. Temporal consistency is native.

### Licence — read before touching the model

| encoder | checkpoint licence | use? |
|---|---|---|
| **`vits`** | **Apache-2.0** | **yes — this is the only one** |
| `vitb` | CC-BY-NC-4.0 (non-commercial) | **NO** |
| `vitl` | CC-BY-NC-4.0 (non-commercial) | **NO** |

Chroma ships as a real product. `vitb`/`vitl` would poison the licence. The
sidecar's `VDA_CFG` is pinned to `vits`; `ai/vendor/README.md` repeats this.
The vendored *code* is Apache-2.0 regardless.

## Where it runs — the `ai/` sidecar, not Rust ONNX

Depth Anything V2 (single-frame) already runs in Rust as ONNX (`ort`). But VDA's
value is the cross-frame attention threaded through the whole window with
keyframe alignment between windows — the same "the stateful video loop is fragile
to reproduce as an ONNX export" case that put SAM 2's video memory in the Python
sidecar (D-009 / D-012). The sidecar already has torch + MPS.

- **Vendored**, not pip-installable: `ai/vendor/video_depth_anything/` (commit
  `4f5ae23`). 3 local edits, all in `ai/vendor/README.md`.
- Checkpoint `video_depth_anything_vits.pth` (~112 MB fp32) **lazy-downloads** to
  `ai/models/` on first `/depth_track`, like every other model. Not bundled.
- **MPS fp32** always (fp16 is flaky for these solvers — same lesson as
  ViTMatte / enhance-voice). CPU is the fallback if MPS is absent.

The Rust DA-V2 ONNX path is **unchanged** — static single-frame bake for stills
and for `apply_haze` before a track has been run.

## The job — `/depth_track` (mirrors `/track`)

```
POST /depth_track  {video_path, from_frame=0, to_frame=-1, step=1,
                    input_size=518, max_res=1280, overwrite=false}
  -> {job_id, kind:"depth", state, dir, ...}
GET  /depth_track/{job_id}  -> {state, done, total, dir, infer_secs, error}
```

- background thread, entry in `_jobs` tagged `kind:"depth"`; a new `/depth_track`
  cancels a running **depth** job only (leaves a subject `/track` alone).
- `_GPU` lock around the infer; `_free_gpu()` in `finally` (B-002).
- decodes `[from_frame, end]` → downscale to `max_res` long edge → **one**
  `model.infer_video_depth(frames, fps, input_size, device, fp32=True)` →
  per-frame PNGs `<video_dir>/.chroma/depth/<key>/<frame:06d>.png` + `_depth.json`.
- `key` = `sha1(abspath, from_frame, to_frame, input_size, max_res)[:12]` —
  mirrors `/track`'s `_cache_key` / D-025's `$trackDir` convention.
- **Normalisation is the one temporal-smoothing choice.** VDA's *values* are
  already temporally consistent; normalising each frame independently would
  re-introduce brightness pumping. So the job normalises **once across the whole
  clip** — 1/99 percentile clip → `u8`, **bright = near** (VDA disparity
  orientation = Depth Anything V2's = what `generate_ai_depth_bitmap` expects; the
  preset inverts).
- `step` = save density only; every frame is fed to the model (dense temporal
  head), same semantics as `/track` post-D-018.
- **Memory:** the whole requested range is decoded into RAM before the infer
  (VDA's windowing needs the sequence). The job refuses a range that would need
  > ~6 GB and asks you to narrow `from`/`to` or lower `max_res`.
- **Cancel granularity:** per-run, not per-frame *during* the infer —
  `infer_video_depth` is one call; `cancelled` is checked before it and during
  the PNG write. A mid-infer cancel waits for that infer to return. Fine for a
  bake.
- **Speed:** ~1–1.5 fps on MPS for VDA-Small (16 frames ≈ 11 s incl. the 32-frame
  window pad). A precompute, not interactive. A 4K clip → narrow the range,
  lower `max_res` / `input_size`.

## Render-time read (mirrors D-019)

`src/chroma/depth.rs::tracked_depth_map(&Value) -> Option<GrayImage>`:

- `params.chromaDepthDir` + `chroma::state::current_video().frame` → the nearest
  `<n>.png` with `n <= frame` (holds a map between samples when `step > 1`).
- `None` — no `chromaDepthDir` / empty / no video / nothing cached yet → the
  caller falls back to the static `mask_data_base64` bake, **byte-identical to
  pre-D-036**.

**One** hook, in `mask_generation.rs::generate_ai_depth_bitmap` — the exact shape
of `tracked_full_mask` in `generate_ai_subject_bitmap` (D-019):

```rust
let depth_map = match crate::chroma::depth::tracked_depth_map(params_value) {
    Some(full) => generate_ai_bitmap_from_full_mask(&full, &tf),
    None => generate_ai_bitmap_from_base64(&params.mask_data_base64?, &tf)?,
};
```

`current_video().frame` is set per frame by **scrub** (`seek_and_install`),
**playback** (`chroma_play_frame`, D-031) and **export** (`export.rs`
`set_current_frame`) — confirmed by reading all three — so all three animate the
depth for free, in lockstep with the frame being graded.

## Surface

- **UI:** "Track depth over clip" button in the depth sub-mask settings (video
  only) — mirrors the "Track subject across clip" button right above it, with a
  `depthTrackProgress` indicator.
- `useAiMasking.handleTrackDepth(subMaskId)` — mirror of `handleTrackSubject`.
- `handleAddDepthHaze({ amount?, protectSubject?, tracked? })` — `tracked: true`
  (video) also runs the track and stamps `chromaDepthDir` on the new sub-mask.
- **MCP:** `depth_track(from_frame?, to_frame?, step?, input_size?)` (non-blocking
  — starts the job, returns `{started, jobId, dir, total}`),
  `depth_track_status()` → `{running, done, total, tracked}`. `apply_haze` gains
  `tracked`.

## `grade.json`

`chromaDepthDir` round-trips as `{"$depthDir": "<rel-or-abs>"}` under the same
D-025 rule as `chromaTrackDir`'s `$trackDir` — **referenced, not copied**; moving
a project needs the clip's `.chroma/depth/` dir too. (Follows the existing
externalisation path; see `docs/notes/grade-json.md`.)

## Manual smoke test (open — bridge listener + app not driven)

1. Open a **moving-camera** clip (`scratch/pexels_28808272.mp4` for 4K, or
   `scratch/Tokyo-Walk_rgb.mp4`).
2. MCP: `apply_haze({})` → static bake haze appears. Scrub a few seconds — the
   depth *lags* (the haze band sits where the camera *was*).
3. MCP: `depth_track()` (or the "Track depth over clip" button). Poll
   `depth_track_status` until `tracked: true`.
4. Scrub / play again — the haze band now **tracks the moving camera**; the
   subject/near field stays clear, no frame-to-frame shimmer.
5. Export a short range (`export({kind:"h264", from_frame, to_frame})`) — the
   graded MP4 shows the depth following per frame (export reads `chromaDepthDir`
   via the same hook).
6. A **still** + a depth mask with no `chromaDepthDir` render exactly as before
   (regression check — the Rust `chroma::depth` tests cover the read logic).

## Deferred

- A flow-warped / guided cross-frame filter on top of VDA (only if a specific
  clip still crawls — VDA's head already covers what per-frame can't).
- Per-frame progress *during* the infer (needs reimplementing VDA's outer window
  loop).
- Batching depth + subject into one sidecar pass.
- `.chroma/depth/` cleanup / GC (grows one dir per (clip, range, res)).
