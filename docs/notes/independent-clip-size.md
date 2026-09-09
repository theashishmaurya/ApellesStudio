# Independent per-axis clip sizing (D-193, 2026-09-07)

Terse version lives in `docs/08-decisions.md`'s D-193 entry — this note is the
worked-out design detail (the unit-choice reasoning, the exact GUI interaction
spec, and the Rust/TS parity comparison table) referenced from `Clip.box_width`'s
own doc comment, `ClipInspectorPanel.tsx`'s module doc, and `timelineExport.ts`'s
`buildClipFilterChain`.

## The problem, precisely

`Clip.scale` (D-136) is a single `f64` — a uniform multiplier of the clip's own
**natural footprint** (its SOURCE pixel resolution, mapped 1:1 into the project's
composition space). That is the correct default for "this clip's own native
size, resized" — a picture-in-picture bubble that keeps the source's own aspect
ratio at any zoom level. It is mathematically incapable of expressing anything
else: a box with an aspect ratio that differs from BOTH the clip's own source
AND the canvas is unreachable for any value of `scale`, on any canvas. B-074
found this the hard way trying to build a stacked before/after reel (full
width, half height, on both halves) and fixed the EXPORT-ONLY symptom
(`fitOverrides`, D-184) — this pass is the real, persisted, live-preview-correct
fix D-184 explicitly deferred.

## Unit choice: canvas-fraction, not natural-footprint-multiplier

Two candidate units for the new field, both considered seriously mid-implementation:

| | `scale_x`/`scale_y` (natural-footprint multiplier, `scale`'s own unit) | `box_width`/`box_height` (canvas fraction, `position_x`'s own unit) — **chosen** |
|---|---|---|
| Meaning | "N× this clip's own source size" | "N% of the output canvas" |
| Needs the clip's SOURCE resolution to place correctly? | Yes | No |
| Rust live-preview compositor can compute it? | Yes (already probes source resolution for `scale`) | Yes (already knows canvas size) |
| `timelineExport.ts` (pure, no-I/O) can compute it? | **No** — same B-074/D-184 gap `scale` already has | **Yes** — canvas size is a render parameter it already has |
| Rust/TS parity | Inherits `scale`'s existing gap | **Zero gap, by construction** |
| Mental model for the GUI's Width/Height-in-pixels control | "half the clip's own resolution" (needs the clip's resolution to reason about) | "half the canvas" (needs only the canvas's known, displayed size) |

`box_width`/`box_height` won on every axis of that comparison. The one real cost:
it is NOT unit-consistent with `scale` (one is canvas-relative, the other
source-relative) — accepted, because `scale` is not being replaced, only
supplemented. A clip with neither field set behaves exactly as it did before
D-193 (falls back to `natural * scale`); a clip with either field set bypasses
`natural`/`scale` entirely for that axis, using the canvas fraction directly.

## Persisted shape

```rust
// apelles_timeline::Clip
pub scale: f64,                    // unchanged — natural-footprint multiplier
pub box_width: Option<f64>,        // NEW — fraction of composition width, or None
pub box_height: Option<f64>,       // NEW — fraction of composition height, or None
```

`None` on either axis independently — a clip can override just width, just
height, or both. `#[serde(default, skip_serializing_if = "Option::is_none")]`,
the same additive-field convention `media_id`/`link_group` already use: a
pre-D-193 `project.json` has no such key, deserializes to `None`, zero
migration pass needed.

TS mirror on `Clip`: `box_width?: number | null; box_height?: number | null;`.

## Rust compositor: `effective_size`

```rust
impl ClipTransform {
    fn effective_size(&self, natural: (f64, f64), canvas: (u32, u32)) -> (f64, f64) {
        let scale = self.scale.max(0.0);
        let (cw, ch) = canvas;
        let w = self.box_width.map(|bw| bw * cw as f64).unwrap_or(natural.0 * scale);
        let h = self.box_height.map(|bh| bh * ch as f64).unwrap_or(natural.1 * scale);
        (w, h)
    }
}
```

`composite_layer_onto` calls this once per layer, in place of its old
`natural.0 * scale` / `natural.1 * scale` pair. Everything downstream (crop,
rotation, opacity, positioning) is unchanged — this only ever changes the box's
*size* going into the resize step.

`is_identity()` treats `box_width.is_some() || box_height.is_some()` as
"never identity," deliberately conservative: proving an override is a true
no-op needs the canvas size, which `ClipTransform` (a per-clip, canvas-agnostic
value) doesn't carry. Safe in both directions — an override that happens to be
a no-op just costs a few extra cycles through the real compositor path instead
of the single-layer fast path; there is no correctness risk either way.

Keyframing: `box_width`/`box_height` are resolved through the exact same
static-or-keyframed pattern every other field on `ClipTransform` uses. An
override with no keyframe data for its own key stays at its static value; a
clip with NO override (`None`) never has one invented from keyframe
interpolation, regardless of what else on the clip is keyframed.

## Export compiler: `buildClipFilterChain`

```ts
const widthExpr = clip.box_width != null
  ? `${opts.width}*${clip.box_width}`
  : `${opts.width}*${scale}`;               // pre-D-193 formula, unchanged

const heightExpr = clip.box_height != null
  ? `${opts.height}*${clip.box_height}`     // D-193 — wins over fitOverrides
  : fitMode === 'stretch'
    ? `${opts.height}*${scale}`             // B-074/D-184, unchanged
    : '-2';                                 // B-074/D-184, unchanged
```

`box_width` was always unconditional for width (fit/stretch never touched
width), so it just replaces the width formula outright. `box_height` is
genuinely a THIRD option alongside `fit`/`stretch` for height — once both
axes are explicitly known there's nothing left for ffmpeg's `-2` to compute,
and an explicit persisted value is a more specific signal than an
export-time-only default.

## GUI: Width/Height + ratio lock

`ClipInspectorPanel.tsx`, right below the existing `Scale` field:

- **Width** / **Height** — real pixel values, computed as
  `effectiveBoxWidth * geometry.compWidth` (and the height equivalent), where
  `effectiveBoxWidth = clip.box_width ?? geometry.naturalWidth * scale` and
  `geometry` comes from `chroma_timeline_clip_geometry` (D-136's existing
  command, extracted into a shared `useClipGeometry.ts` hook this pass so
  `TransformOverlay.tsx`'s own copy of the same fetch isn't duplicated).
- **Lock/unlock toggle** between them (a padlock icon, matching the reference
  UI the owner pointed at). Local `useState`, default `true` (locked) for a
  clip with no override yet, `false` for one that already has independent
  values — reset correctly per clip selection via a `key={clip.id}` on
  `EditorInspectorPanel.tsx`'s render of this panel.
  - **Locked**: editing either field recomputes the OTHER from the CURRENT
    on-screen ratio (`effectiveBoxHeight / effectiveBoxWidth` or its inverse)
    — both write `box_width`/`box_height` together.
  - **Unlocked**: editing one field writes only that axis; the other is
    RESTATED at its current resolved value in the same patch (not left
    implicit), so it can never silently drift later if `scale` itself
    changes independently.
- **Scale** (existing field, untouched signature) gains one new side effect:
  writing it now also clears `box_width`/`box_height` to `null` — an explicit
  "go back to simple uniform mode" affordance, since once an override exists
  `scale` alone can no longer describe the box.

## `TransformOverlay.tsx` (on-canvas handles) — correctness fix, not a scope expansion

The on-canvas drag handles (D-136, Phase 1) stay uniform-scale-only by design
— this pass did not build non-uniform on-canvas dragging. Two things WERE
fixed here, because leaving them alone would have been a real, silent
regression once `box_width`/`box_height` existed at all:

1. The STATIC box (rendered whenever no drag is in flight) now uses
   `clip.box_width ?? natural.width * scale` (and the height equivalent) —
   before this fix it would have shown the WRONG (uniform-only) box shape for
   any clip the Inspector had already given an independent size to.
2. Releasing a corner (scale) drag now explicitly writes `box_width: null,
   box_height: null` in its `set_clip_transform` commit — before this fix the
   op wouldn't have compiled (the fields are required), and leaving them
   unset/stale would have meant "drag a corner" silently did nothing visible
   on a clip that already had an override. A plain MOVE (reposition) drag
   preserves any existing override untouched — it never changes box size.

## Explicitly out of scope for this pass

- **Keyframing `box_width`/`box_height` through the GUI.** The engine supports
  it (same D-034 interpolator, reachable via `editor_set_clip_keyframes`
  directly with a `box_width`/`box_height` params key) but
  `EditorInspectorPanel.tsx`'s "Keyframe clip" button does not currently
  snapshot these two fields into a keyframe — so independent sizing cannot
  yet be animated over time through that one built-in affordance.
- **A visible canvas-boundary overlay / project-settings aspect-ratio UI.**
  Checked directly against this pass (`docs/04-roadmap.md` item 18) — NOT the
  same root cause, not a prerequisite. This pass's math is built against the
  composition size that already exists server-side (`ProjectSettings.width`/
  `height`, D-038) via the same `chroma_timeline_clip_geometry` command the
  Inspector already calls, so the numbers shown/written here are correct
  regardless of whether a human can SEE the canvas boundary on screen. What's
  missing there is purely presentational (a `PreviewPane.tsx` overlay) and a
  settings surface (editing `ProjectSettings` after project creation) — real,
  separate follow-up work.
- **Non-uniform scaling via on-canvas dragging.** See `TransformOverlay.tsx`'s
  section above — deliberately still Inspector-only.
