# chroma-timeline

**Layer 2 (domain model).** The OTIO-*shaped* edit model for the Edit tab:
tracks of clips, position helpers, and the edit ops.

- **Deps:** `chroma-types`, `serde`, `thiserror`. **Pure** — no `wgpu`, no
  `ffmpeg`, no media probing, no rendering. Callers pass source frame counts.
- **Serde:** our own plain JSON for v1. OTIO-shaped (the OpenTimelineIO *data
  model*), but a real `.otio` interchange exporter is a later step (D-041).

## API (D-041)

- `Timeline::from_shots(&[(id, source_path, name, source_frame_count)])` — one
  video track, each shot a full-length clip back to back.
- `Track::clip_at(timeline_frame) -> Option<(&Clip, source_frame)>`,
  `Timeline::duration() -> i64`.
- Edit ops, each `Result<(), TimelineError>`, each unit-tested: `reorder`,
  `trim_start`, `trim_end` (clamped to `[0, source_len]`), `split`, `remove`.
- `Clip` carries a stable `id`, an optional `shot_id`, and `source_len`.

## Status

D-041 — the Edit-tab MVP model. Grown since, each field in its own decision (the
module doc in `src/lib.rs` is the authoritative, per-field version of this list):
multi-track with explicit `Clip::start_frame` and real gaps (D-054), track `gain`
(D-057), `locked` / `hidden` plus the compositing transform
`opacity`/`position_x`/`position_y`/`scale`/`rotation` and `chroma_keyframes`
(D-082/D-086), cross-track `sync_locked` (D-106), A/V `link_group` (D-129), and
per-clip **crop** — `crop_left`/`crop_top`/`crop_right`/`crop_bottom`, normalised
0–1 edge insets into the clip's own source (D-132). Every one of those is
*carried* here and *applied* one layer up, in `app/src-tauri` — this crate still
renders nothing.

Ripple-roll-slip-slide / transcript→EDL / OTIO export land in later, tracked steps.
