# apelles-timeline

**Layer 2 (domain model).** The OTIO-*shaped* edit model for the Edit tab:
tracks of clips, position helpers, and the edit ops.

- **Deps:** `apelles-types`, `serde`, `thiserror`. **Pure** — no `wgpu`, no
  `ffmpeg`, no media probing, no rendering. Callers pass source frame counts.
- **Serde:** our own plain JSON for v1. OTIO-shaped (the OpenTimelineIO *data
  model*), but a real `.otio` interchange exporter is a later step (D-041).
- **Fade curves (D-147)** — `FadeCurve` / `fade_gain`, a pure-`f64` cubic-bezier
  easing evaluator with no I/O — are **re-exported from `apelles-types`
  (L0)**, not defined here. They started here, but the second consumer turned
  out to be `apelles-media`'s audio mixer at **L1**, *below* this crate, and
  D-039's dependency graph is one-way: L1 cannot reach up to L2 for a solver,
  and copying the bezier math into the mixer is the duplication CLAUDE.md
  forbids. So the shared half moved down to the layer both consumers can see;
  `apelles_timeline::{FadeCurve, fade_gain}` still resolve. `Clip`'s own fade
  fields and `Clip::fade_multiplier_at` (frames → the compositor's `opacity`
  multiplier) stay here, where the model is. None of it touches the D-034
  keyframe engine, which stays strictly linear.

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
0–1 edge insets into the clip's own source (D-132) — and per-clip **fades**:
`fade_in_frames`/`fade_out_frames` plus a `FadeCurve` each (D-147). Every one of
those is *carried* here and *applied* one layer up, in `app/src-tauri` — this
crate still renders nothing. **`Timeline::markers` (D-222)** is the one field
here that is never applied anywhere: a `Marker` (`{id, frame, color, name?,
note?}`) is a timeline-anchored *annotation*, not a render input, so nothing
composites, mixes or exports it. It hangs off the `Timeline` rather than a
`Clip` precisely so it survives the clip beneath it being trimmed, moved or
deleted; its edit ops live in `@apelles/editor`'s `timeline.ts` with every other
op that actually runs. The fade is the one with an evaluator attached
(`Clip::fade_multiplier_at`, over `apelles-types`' curve math — see above); the
*result* is still applied up there, and for audio in `apelles-media`.

**`Track::transitions` (D-226)** — a `Transition` per **edit point**: the cut it
straddles (`at_frame`), a kind (`CrossDissolve` / `DipToColor`), a duration and
an alignment. **This crate's "clips on one track never overlap" invariant is
completely unchanged** — a transition *bridges* the cut rather than making the
two clips overlap, which is the whole point of D-226's choice; what it costs
instead is **handle media** (`Clip::source_frame_at` /
`clamped_source_frame_at`, the extrapolated read outside a clip's own trim).
The visible consequence here is that `Timeline::resolve_visible_video_layers_at`
returns `VisibleLayer`s rather than bare `(track, &Clip, source_frame)` tuples:
a track can now contribute two of them (a dissolve's two clips) or a generated
colour plate with no clip at all (a dip). Same division of labour as every other
field above — this crate resolves *which* layers, at what alpha, from what
source frame, and renders none of them. Full design: `docs/notes/transitions.md`.

Ripple-roll-slip-slide / transcript→EDL / OTIO export land in later, tracked steps.
