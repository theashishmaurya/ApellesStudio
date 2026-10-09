//! **What one frame of the Edit tab's headless render costs — estimated from
//! the document alone (B-234 lever 2, D-373).**
//!
//! What it is: a cheap, pure, integer **work estimate** per timeline frame,
//! built by asking `Timeline::resolve_visible_video_layers_at` which layers
//! composite there and classifying each one against the branches
//! `chroma::edit`'s compositor would actually take. `chroma::edit_render` cuts
//! the contiguous-segment partition on the cumulative curve this produces, so
//! the lanes finish together instead of the concat waiting on whichever lane
//! drew the expensive end of the timeline.
//!
//! What it does NOT do:
//! - **Decode, probe or open anything.** Every input is a field already in the
//!   `Timeline`, plus one filename-extension test (`still::is_image_file`,
//!   which is pure string work). A cost model that had to `ffprobe` 98 clips
//!   before the render could start would cost more than the imbalance it
//!   removes.
//! - **Predict wall-clock.** The units are relative and only their RATIOS are
//!   claimed; nothing here converts to seconds, and no caller may.
//! - **Decide how many segments to use, or where the cuts land.**
//!   `edit_render::plan_segment_count` and `edit_render::segment_ranges` own
//!   both; this module only says what each frame costs.
//! - **Resolve keyframes, fades or transitions' alpha.** See
//!   [`composite_cost`] for exactly what that costs in accuracy and why it is
//!   the right trade here.
//! - **Count PROCESSES.** This is work per frame, not resident cost. A boundary
//!   moved into a stretch where more tracks have content makes that lane spawn
//!   one more decode `ffmpeg` per extra track, and nothing here knows that.
//!   `edit_render::plan_segment_count` owns the process bound (B-234/D-369,
//!   `cores / procs_per_segment`) and owns it for the whole render rather than
//!   per segment, so a partition that shifts the per-lane process count is
//!   outside what either of them models. It is measurable — D-373's own
//!   `measure_segmented_render_balance` hit it, 5-6 % and repeatable — and it
//!   is the first thing to look at if a real project ever regresses on a
//!   work-balanced split. See `docs/notes/export-gpu-compositor.md` §10.7.
//!
//! **Why an estimate at all, rather than measuring.** The straggler B-234's
//! 2026-10-06 profiling caught — one lane writing 45 % of its siblings' bytes
//! and then running ~24× faster the moment they finished — is set before the
//! first frame is rendered, by where the partition fell. Anything measured
//! during the render is already too late to move the boundary, and anything
//! measured beforehand means rendering the frames twice.

use std::path::Path;

use apelles_timeline::{Clip, LayerSource, Timeline, VisibleLayer};

use super::edit;

/// The cost of a frame that composites nothing extra: the canvas fill, the
/// RGBA hand-off to the writer thread, and the encoder's own per-frame work.
///
/// One unit, and every other weight below is expressed against it, so a frame
/// can never cost zero — which is what keeps the cumulative curve **strictly
/// increasing** and therefore searchable by `partition_point`.
const FRAME_BASE: u32 = 1;

/// One video layer's decode: `decode_pipe::playback_frame_scaled` plus the
/// RGBA conversion.
///
/// **Three, because that is roughly the measured ratio.** On the 20-clip /
/// 1080p / 240-frame stress fixture, `docs/notes/export-gpu-compositor.md`
/// §9.1 measured 11.03 s of decode over 480 layer-decodes (23.0 ms each),
/// and §10.5's post-D-351 one-segment total of 14.45 s leaves ~3.4 s of
/// compositing over 480 layers (~7 ms each) once D-351 put the per-pixel
/// passes on every core. That is ~3:1, and §10.5's own closing caveat says
/// the ratio only grows at 4K, where decode is a larger share of each frame.
const VIDEO_DECODE: u32 = 3;

/// A still layer's "decode": a hit in `apelles_media::still`'s cache and an
/// `Arc` clone (D-292 — a still never reaches `decode_pipe` and never holds a
/// `PipeSlot`). Free against a real decode, so it is weighted as free.
const STILL_DECODE: u32 = 0;

/// A text layer's rasterise: `chroma::text`'s own cache hands back the shared
/// `Arc` (D-211), so like a still this is free against a decode. The layer is
/// still composited, which [`composite_cost`] charges for.
const TEXT_RASTER: u32 = 0;

/// Painting one layer through `composite_layer_onto`'s **fused** path
/// (`blend_layer_sampled`, D-217): crop, scale, opacity and the source-over
/// blend in a single pass bounded by the canvas.
const COMPOSITE_BLEND: u32 = 1;

/// Painting one layer through the **general** path instead: `image::imageops::
/// resize` materialises a full intermediate buffer and `overlay_parallel` then
/// reads it, so roughly twice the fused path's traffic for the same picture.
///
/// Reached whenever the placement box is smaller than the source — D-217's
/// fast path is guarded on a ratio ≥ 1 because a genuine minification needs
/// `Triangle`'s widening support.
const COMPOSITE_RESIZED: u32 = 2;

/// Painting one **rotated** layer: `imageproc`'s `rotate_about_center` needs
/// the buffer as `Rgba32F`, so the layer is converted up (4 bytes/px → 16),
/// rotated with bilinear interpolation, and converted back — three full-buffer
/// passes, the widest of them at four times the bytes.
const COMPOSITE_ROTATED: u32 = 6;

/// One adjustment clip's `apply_adjustment_to_canvas`: a full-canvas per-pixel
/// colour pass, row-parallel exactly like the composite, so one blend's worth.
const ADJUSTMENT_PASS: u32 = 1;

/// The three paint weights are an ORDER, not three independent numbers — the
/// fused path is the cheapest thing `composite_layer_onto` can do and the
/// rotation round-trip the dearest. Asserted at compile time so an edit to one
/// of them cannot silently invert the ranking this model's whole value rests
/// on (the same `const _: () = assert!(..)` idiom `apelles_types::adjustment`
/// already uses on its own coefficient bounds).
const _: () = assert!(COMPOSITE_BLEND < COMPOSITE_RESIZED);
const _: () = assert!(COMPOSITE_RESIZED < COMPOSITE_ROTATED);
/// And a decode is dearer than the paint it feeds — the measured 3:1 above.
const _: () = assert!(COMPOSITE_BLEND < VIDEO_DECODE);

/// The most frames [`frame_cost_curve`] will actually resolve layers at.
///
/// A guard, not a tuning knob. Resolving every frame of a normal export is
/// microseconds per frame and nobody notices; a multi-hour render at 60 fps is
/// hundreds of thousands of frames, and the planner must not spend real time
/// deciding where to cut. Past this many frames the curve is sampled on a
/// stride and each sample is held across its stride, which is ample for a
/// boundary that only has to land within a second or two of the ideal — a
/// segment is [`super::edit_render::MIN_SEGMENT_FRAMES`] frames at the very
/// least, and in practice thousands.
const MAX_COST_SAMPLES: u64 = 20_000;

/// The estimated cost of every frame in `0..frames`, in the units above.
///
/// **Exactly `frames` entries, always** — the partition in
/// `edit_render::segment_ranges` is built from this slice's length, and D-362's
/// progress percentage is only a true fraction of the render because those
/// ranges partition it exactly. A curve that was short by one would move that
/// contract, so the length is the function's own invariant rather than the
/// caller's problem.
pub(super) fn frame_cost_curve(timeline: &Timeline, frames: u64) -> Vec<u32> {
    let stride = frames.div_ceil(MAX_COST_SAMPLES).max(1);
    let mut curve: Vec<u32> = Vec::with_capacity(frames as usize);
    let mut pos = 0u64;
    while pos < frames {
        let run = stride.min(frames - pos);
        curve.extend(std::iter::repeat_n(frame_cost(timeline, pos), run as usize));
        pos += run;
    }
    curve
}

/// What `edit::render_timeline_frame` would cost at timeline position `pos`.
///
/// The layer set is resolved by the renderer's own resolver and filtered by the
/// renderer's own `edit::layer_is_renderable`, so this can never disagree with
/// the render about *which* layers exist at `pos` — only about what each one
/// costs.
pub(super) fn frame_cost(timeline: &Timeline, pos: u64) -> u32 {
    let layers: Vec<VisibleLayer<'_>> = timeline
        .resolve_visible_video_layers_at(pos as i64)
        .into_iter()
        .filter(edit::layer_is_renderable)
        .collect();

    // D-132/B-053's single-layer fast path: one visible layer with nothing to
    // apply to it is returned as a **plain decode** — no canvas, no composite
    // pass at all. That is the cheapest frame this renderer has, and telling it
    // apart from a composited one is most of the point of this model.
    //
    // Optimistic by exactly one [`COMPOSITE_BLEND`]: the real guard also
    // demands the source be the same pixel size as the composition and the clip
    // be ungraded, and neither is knowable without a probe and a stat. Being
    // wrong by one unit on the cheapest frame in the render is the right side
    // to be wrong on — the alternative is doing I/O here.
    if let [only] = layers.as_slice()
        && let Some(cost) = plain_decode_cost(only)
    {
        return FRAME_BASE + cost;
    }

    FRAME_BASE + layers.iter().map(layer_cost).sum::<u32>()
}

/// The cost of `layer` when it is the ONLY layer and takes the plain-decode
/// fast path — or `None` when it cannot take it, in which case the caller
/// charges the ordinary [`layer_cost`].
///
/// Mirrors `edit::render_timeline_frame`'s `single_plain` guard for everything
/// the document alone can answer: a generated layer (text, adjustment, a
/// transition's colour plate) has no plain decode to return, a transition alpha
/// below 1.0 is a real blend, and a non-identity transform is the whole of
/// D-132/B-053.
fn plain_decode_cost(layer: &VisibleLayer<'_>) -> Option<u32> {
    if layer.alpha < 1.0 {
        return None;
    }
    let LayerSource::Clip { clip, .. } = &layer.source else {
        return None;
    };
    if clip.is_generated() || composite_cost(clip) != COMPOSITE_BLEND || clip.opacity < 1.0 {
        return None;
    }
    Some(decode_cost(clip))
}

/// What one visible layer adds to its frame: its decode (if it has one) plus
/// its paint.
fn layer_cost(layer: &VisibleLayer<'_>) -> u32 {
    match &layer.source {
        // D-226 — a dip-to-colour plate is generated at canvas size and painted
        // full-frame: no decode, one blend.
        LayerSource::Color { .. } => COMPOSITE_BLEND,
        LayerSource::Clip { clip, .. } => {
            // D-230 — an adjustment clip has no picture at all. One whose
            // correction provably does nothing is dropped by the compositor
            // before the pass runs, so it costs nothing here either.
            if clip.is_adjustment() {
                return clip.adjustment_ops().map_or(0, |_| ADJUSTMENT_PASS);
            }
            decode_cost(clip) + composite_cost(clip)
        }
    }
}

/// Where this clip's pixels come from: a `decode_pipe` stream, a cached still,
/// or a cached text raster.
fn decode_cost(clip: &Clip) -> u32 {
    if clip.is_text() {
        TEXT_RASTER
    } else if apelles_media::still::is_image_file(Path::new(&clip.source_path)) {
        STILL_DECODE
    } else {
        VIDEO_DECODE
    }
}

/// Which branch of `composite_layer_onto` this clip's transform would take.
///
/// **Read from the clip's STATIC fields, deliberately — no keyframe
/// resolution, no fade.** Resolving the real per-frame transform means parsing
/// `chroma_keyframes` once per keyframed layer per sampled frame, which is real
/// time spent before the render can start, and the whole error it would remove
/// is at most [`COMPOSITE_ROTATED`] − [`COMPOSITE_BLEND`] on a layer whose
/// transform animates across a branch boundary. The terms this model exists to
/// separate — how many layers composite at all, and how many of them decode —
/// are exact either way. Named here rather than buried so the next reader knows
/// it is a decision and not an oversight.
///
/// The same reasoning covers fades: `fade_in_frames`/`fade_out_frames` drop a
/// clip's opacity below 1.0 for a window measured in a handful of frames, which
/// moves the estimate by one unit over a span far shorter than any segment.
fn composite_cost(clip: &Clip) -> u32 {
    // Fully transparent, or cropped away entirely: `composite_layer_onto`
    // returns before painting anything. Both insets are clamped the way
    // `crop_pixel_rect` clamps them, so a negative inset is no crop.
    let kept = |near: f64, far: f64| 1.0 - near.clamp(0.0, 1.0) - far.clamp(0.0, 1.0);
    if clip.opacity <= 0.0
        || kept(clip.crop_left, clip.crop_right) <= 0.0
        || kept(clip.crop_top, clip.crop_bottom) <= 0.0
    {
        return 0;
    }
    if clip.rotation != 0.0 {
        return COMPOSITE_ROTATED;
    }
    // D-217's fused path is guarded on the placement box being at least as
    // large as the (cropped) source, so a layer deliberately shrunk below its
    // natural footprint — a PIP, a split-screen panel — goes the general way,
    // through a full intermediate buffer. `box_width`/`box_height` (D-193)
    // override the box size outright, so an override below full canvas is the
    // same situation stated differently.
    let shrunk_box = |b: Option<f64>| b.is_some_and(|v| v < 1.0);
    if clip.scale < 1.0 || shrunk_box(clip.box_width) || shrunk_box(clip.box_height) {
        return COMPOSITE_RESIZED;
    }
    COMPOSITE_BLEND
}

#[cfg(test)]
mod tests {
    use super::*;
    use apelles_timeline::{Track, TrackKind};

    /// A video clip of `frames` frames starting at `start`, with no transform
    /// at all — the identity case every other fixture below perturbs.
    fn clip(id: &str, start: i64, frames: i64) -> Clip {
        Clip {
            id: id.to_string(),
            source_path: format!("/tmp/{id}.mp4"),
            start_frame: start,
            source_start: 0,
            duration: frames,
            ..Default::default()
        }
    }

    fn video_track(clips: Vec<Clip>) -> Track {
        Track {
            kind: TrackKind::Video,
            clips,
            ..Default::default()
        }
    }

    fn timeline(tracks: Vec<Track>) -> Timeline {
        Timeline {
            tracks,
            ..Default::default()
        }
    }

    #[test]
    fn the_curve_has_exactly_one_entry_per_frame() {
        let tl = timeline(vec![video_track(vec![clip("a", 0, 50)])]);
        for frames in [0u64, 1, 50, 120] {
            assert_eq!(
                frame_cost_curve(&tl, frames).len() as u64,
                frames,
                "{frames}: the partition's own length contract"
            );
        }
    }

    #[test]
    fn every_frame_costs_at_least_one_so_the_curve_strictly_increases() {
        // An empty timeline still writes a frame, and the cumulative curve has
        // to stay searchable.
        let tl = timeline(vec![video_track(vec![])]);
        assert!(frame_cost_curve(&tl, 10).iter().all(|&c| c >= 1));
    }

    #[test]
    fn a_lone_untransformed_clip_is_the_cheapest_frame_there_is() {
        let tl = timeline(vec![video_track(vec![clip("a", 0, 10)])]);
        // The plain-decode fast path: a decode and nothing else.
        assert_eq!(frame_cost(&tl, 0), FRAME_BASE + VIDEO_DECODE);
    }

    #[test]
    fn a_second_layer_costs_a_second_decode_and_a_second_paint() {
        let one = timeline(vec![video_track(vec![clip("a", 0, 10)])]);
        let two = timeline(vec![
            video_track(vec![clip("a", 0, 10)]),
            video_track(vec![clip("b", 0, 10)]),
        ]);
        // Two layers also lose the single-layer fast path, so the top layer
        // starts paying for its own paint as well.
        assert_eq!(
            frame_cost(&two, 0),
            FRAME_BASE + 2 * (VIDEO_DECODE + COMPOSITE_BLEND)
        );
        assert!(frame_cost(&two, 0) > 2 * frame_cost(&one, 0) - FRAME_BASE);
    }

    #[test]
    fn a_hidden_track_costs_nothing() {
        let mut tl = timeline(vec![
            video_track(vec![clip("a", 0, 10)]),
            video_track(vec![clip("b", 0, 10)]),
        ]);
        tl.tracks[1].hidden = true;
        assert_eq!(frame_cost(&tl, 0), FRAME_BASE + VIDEO_DECODE);
    }

    #[test]
    fn a_gap_costs_only_the_frame_itself() {
        let tl = timeline(vec![video_track(vec![clip("a", 0, 10)])]);
        assert_eq!(frame_cost(&tl, 50), FRAME_BASE);
    }

    #[test]
    fn a_still_layer_does_not_pay_for_a_decode() {
        let mut still = clip("s", 0, 10);
        still.source_path = "/tmp/s.png".to_string();
        let tl = timeline(vec![
            video_track(vec![still]),
            video_track(vec![clip("b", 0, 10)]),
        ]);
        assert_eq!(
            frame_cost(&tl, 0),
            FRAME_BASE + (STILL_DECODE + COMPOSITE_BLEND) + (VIDEO_DECODE + COMPOSITE_BLEND)
        );
    }

    #[test]
    fn a_shrunk_or_rotated_layer_costs_more_to_paint_than_a_plain_one() {
        let plain = clip("a", 0, 10);
        let mut shrunk = clip("a", 0, 10);
        shrunk.scale = 0.4;
        let mut rotated = clip("a", 0, 10);
        rotated.rotation = 12.0;

        assert_eq!(composite_cost(&plain), COMPOSITE_BLEND);
        assert_eq!(composite_cost(&shrunk), COMPOSITE_RESIZED);
        assert_eq!(composite_cost(&rotated), COMPOSITE_ROTATED);
    }

    #[test]
    fn a_layer_that_paints_nothing_costs_nothing_to_paint() {
        let mut invisible = clip("a", 0, 10);
        invisible.opacity = 0.0;
        assert_eq!(composite_cost(&invisible), 0);

        let mut cropped_away = clip("a", 0, 10);
        cropped_away.crop_left = 0.6;
        cropped_away.crop_right = 0.6;
        assert_eq!(composite_cost(&cropped_away), 0);

        // A negative inset is no crop, matching `crop_pixel_rect`'s own clamp.
        let mut negative = clip("a", 0, 10);
        negative.crop_left = -0.5;
        assert_eq!(composite_cost(&negative), COMPOSITE_BLEND);
    }

    #[test]
    fn an_adjustment_clip_costs_a_full_canvas_pass_and_an_identity_one_costs_nothing() {
        use apelles_timeline::AdjustmentLayer;

        let mut identity = clip("adj", 0, 10);
        identity.source_path = String::new();
        identity.adjustment = Some(AdjustmentLayer::default());
        let mut real = identity.clone();
        real.adjustment = Some(AdjustmentLayer {
            exposure: 0.5,
            ..Default::default()
        });

        let base = video_track(vec![clip("a", 0, 10)]);
        let with_identity = timeline(vec![video_track(vec![identity]), base.clone()]);
        let with_real = timeline(vec![video_track(vec![real]), base]);

        assert_eq!(
            frame_cost(&with_identity, 0),
            FRAME_BASE + VIDEO_DECODE + COMPOSITE_BLEND,
            "an adjustment that provably does nothing is dropped before the pass"
        );
        assert_eq!(
            frame_cost(&with_real, 0),
            FRAME_BASE + VIDEO_DECODE + COMPOSITE_BLEND + ADJUSTMENT_PASS
        );
    }

    /// The property the whole of B-234 lever 2 rests on: a span of stacked 4K
    /// camera really does read as more work than a span of one flat panel.
    #[test]
    fn a_stacked_span_costs_more_per_frame_than_a_single_layer_span() {
        let tl = timeline(vec![
            video_track(vec![clip("top", 0, 100)]),
            video_track(vec![clip("mid", 0, 100)]),
            video_track(vec![clip("base", 0, 200)]),
        ]);
        let curve = frame_cost_curve(&tl, 200);
        let stacked = curve[50];
        let alone = curve[150];
        assert!(
            stacked >= 2 * alone,
            "a three-layer frame ({stacked}) must read as much costlier than a \
             one-layer frame ({alone})"
        );
    }

    /// Past [`MAX_COST_SAMPLES`] the curve is sampled on a stride — it must
    /// still be one entry per frame, and still carry the shape.
    #[test]
    fn a_very_long_render_is_sampled_but_still_covers_every_frame() {
        let frames = MAX_COST_SAMPLES * 3 + 7;
        let half = (frames / 2) as i64;
        let tl = timeline(vec![
            video_track(vec![clip("top", 0, half)]),
            video_track(vec![clip("base", 0, frames as i64)]),
        ]);
        let curve = frame_cost_curve(&tl, frames);
        assert_eq!(curve.len() as u64, frames);
        assert!(
            curve[(half / 2) as usize] > curve[(frames - 10) as usize],
            "the sampled curve must still see the two-layer half as costlier"
        );
    }
}
