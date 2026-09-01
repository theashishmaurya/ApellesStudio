# BUGS

Real defects only — in our code or the engine. Not setup/housekeeping. Move to GitHub
Issues once public.

```
## B-NNN — title
status: open | fixed | wontfix   ·   severity: blocker | high | medium | low   ·   area: …
repro / expected / actual / cause / fix
```

## Known engine constraints (design around these — not bugs)

- Render entry points are Tauri-coupled → **D-014** (extract `render_core`).
- Masks are static per image — no keyframe/tracking model. We add it.
- Depth Anything is wired for stills; per-frame video depth needs temporal smoothing or it flickers.
- `process_and_get_dynamic_image` bypasses the GPU and returns the source unprocessed if `w|h > max_texture_dimension_2d` — watch at 8K.

## Open

_(none)_

## Fixed

## B-002 — AI sidecar climbs to ~12 GB after repeated "Re-track"
status: fixed (2026-09-01) · severity: high · area: ai/server.py
- **repro:** load a video, track a subject, hit "Re-track subject across clip" several times (or scrub a lot during a track).
- **expected:** sidecar RSS bounded — one predictor + models ≈ 1–1.5 GB.
- **actual:** ~12 GB (mostly compressed under memory pressure; `ps` RSS showed ~330 MB resident, Activity Monitor "Memory" 12 GB). Machine hit 20 GB swap.
- **cause:** each `/track` built a *fresh* `SAM2DynamicInteractivePredictor` (~1 GB into the MPS pool, which never returns to the OS); track + on-seek `/refine_track` + ViTMatte warm-up ran concurrently, stacking their MPS working sets. The propagation loop itself is flat (verified — `memory_bank` stays at 1).
- **fix:** `_GPU` lock serialises every model call (per-frame in the track loop so refine interleaves); `_get_video_predictor` reuses one instance with per-track state reset; `_free_gpu()` (`empty_cache` + `gc`) after every `/segment`, `/refine_track`, and track pass; `/track` cancels any still-running track. Measured after: plateaus ~1.3 GB across repeated tracks, refines pull it back toward ~800 MB (577 MB after an hour of heavy testing).

## B-003 — tracking seek: render storm, frozen timeline, offset overlay
status: fixed (2026-09-01) · severity: high · area: engine + frontend
- **repro:** track a subject, click/scrub the timeline.
- **actual:** timeline playhead frozen; canvas re-rendering continuously (`apply_adjustments` ~30×/s); red overlay a person-shaped blob offset from the actual subject.
- **cause:** (1) `useAiMasking` (with the per-seek matte-swap effect) is mounted in 3 components → 3× work per seek, and it fired on every intermediate drag frame — each a `setAdjustments` + full re-render. (2) frame vs matte desync: `frameNonce` bumps faster than `setAdjustments` settles → frame-N matte on frame-M image. (3) `ChromaTimeline` root `onPointerDownCapture={e=>e.stopPropagation()}` ate the strip's own `onPointerDown` — clicks did nothing.
- **fix:** **D-019** — matte read from disk at render time (`generate_ai_subject_bitmap` → `tracked_full_mask`), no per-seek `setAdjustments`; a seek just bumps `frameNonce`. Root capture-phase `stopPropagation` moved onto the strip handler.
