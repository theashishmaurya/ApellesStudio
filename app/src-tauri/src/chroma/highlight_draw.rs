//! **highlight_draw.rs — the compositor's clip highlighter strokes** (D-396,
//! B-271).
//!
//! What it is: the preview/Edit compositor's half of D-396's clip highlights.
//! `chroma::edit` calls [`highlighted_picture`] on a clip's decoded picture,
//! after the Colorist grade and before any geometry, so the strokes follow every
//! crop, push-in and rotation (the ffmpeg exporter's `geq` nodes sit at exactly
//! that point).
//!
//! What it does: [`apply_highlights_to_rgba`] is the plain drawing operator,
//! `c' = c + k·(highlight − c)` per stroke in list order (see its doc).
//! [`highlighted_picture`] wraps it for a **shared still**, whose buffer is the
//! decode cache's own and so must never be written in place: it keeps one
//! working copy per clip, redraws only the rows the strokes touch, and once
//! every sweep has finished hands back the same finished picture with no work at
//! all (B-271: the first version cloned the whole ~18 MB source every frame,
//! including every frame after the last sweep).
//!
//! What it does NOT do: know anything about timelines, geometry or the exporter
//! (the cross-engine pixel table lives with the tests in `chroma::edit`), or
//! cache anything for a video clip, whose decoded frame is already private and
//! is drawn on in place.

use std::sync::{Arc, Mutex};

use apelles_timeline::Highlight;
use apelles_timeline::highlight::Sweep;
use image::RgbaImage;

use super::edit::for_each_row_mut;

/// Clips whose working copy is kept. A highlighted still is one image at the
/// preview's decode size, and an edit only ever plays a few at once, so the
/// bound is memory (a few tens of MB), not hit rate.
const MEMO_CAPACITY: usize = 4;

/// One clip's working copy, valid for exactly the source picture and highlight
/// list it was built from.
struct Entry {
    clip_id: String,
    /// The decode cache's picture, kept to restore rows from and to recognise
    /// the same source by identity.
    original: Arc<RgbaImage>,
    highlights: Vec<Highlight>,
    /// `original` with the strokes of the last drawn frame on it.
    working: Arc<RgbaImage>,
    /// The rows (`start..end`) the last draw touched, which are the only rows
    /// that can differ from `original`.
    dirty: Option<(u32, u32)>,
    /// Whether `working` holds the picture of a state in which every sweep has
    /// finished (which no later frame changes).
    complete: bool,
}

/// Most recently used first.
static MEMO: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

/// Draw a clip's highlighter strokes onto its decoded picture, reusing a
/// per-clip working copy when the picture is a shared still.
///
/// A picture nobody else holds (a freshly decoded video frame) is drawn on in
/// place by [`apply_highlights_to_rgba`], exactly as before.
pub(super) fn highlighted_picture(
    clip_id: &str,
    img: &mut Arc<RgbaImage>,
    highlights: &[Highlight],
    source_frame: i64,
) {
    if highlights.is_empty() {
        return;
    }
    if Arc::strong_count(img) == 1 {
        apply_highlights_to_rgba(img, highlights, source_frame);
        return;
    }
    let (w, h) = img.dimensions();
    let sweeps = sweeps_at(highlights, source_frame, w, h);
    if sweeps.is_empty() {
        return;
    }
    let complete = highlights
        .iter()
        .all(|hl| hl.progress_at(source_frame) >= 1.0);

    // The entry leaves the list while it is worked on, so two renders of
    // different clips never wait on each other's drawing. A poisoned lock
    // degrades to a fresh entry: the memo is an optimisation, not a result.
    let taken = MEMO.lock().ok().and_then(|mut memo| {
        memo.iter()
            .position(|e| {
                e.clip_id == clip_id && Arc::ptr_eq(&e.original, img) && e.highlights == highlights
            })
            .map(|i| memo.remove(i))
    });
    let mut entry = taken.unwrap_or_else(|| Entry {
        clip_id: clip_id.to_owned(),
        original: Arc::clone(img),
        highlights: highlights.to_vec(),
        working: Arc::new(RgbaImage::clone(img)),
        dirty: None,
        complete: false,
    });

    if !(entry.complete && complete) {
        // Unique unless a previous frame's picture is still alive elsewhere, in
        // which case `make_mut` copies and the entry carries on with its own.
        let working = Arc::make_mut(&mut entry.working);
        let stride = w as usize * 4;
        if let Some((y0, y1)) = entry.dirty {
            let (lo, hi) = (y0 as usize * stride, y1 as usize * stride);
            working.as_mut()[lo..hi].copy_from_slice(&entry.original.as_raw()[lo..hi]);
        }
        entry.dirty = draw_sweeps(working, &sweeps);
        entry.complete = complete;
    }
    *img = Arc::clone(&entry.working);

    if let Ok(mut memo) = MEMO.lock() {
        memo.insert(0, entry);
        memo.truncate(MEMO_CAPACITY);
    }
}

/// D-396 — draw a clip's highlighter strokes onto its decoded picture.
///
/// Each stroke is the pen's current rounded rectangle (`Highlight::sweep_at`),
/// blended with the plain "over" operator at `coverage × opacity`: `c' = c +
/// k·(highlight − c)`. Strokes apply in list order, a later one over an
/// earlier. The ffmpeg exporter's `geq` node computes the identical expression,
/// so a stroke measures the same in the preview and the export (the pixel test
/// in `timelineExportHighlight.ffmpeg.test.ts` holds that to one level).
///
/// **Normal blend, not multiply**, measured on both page polarities (D-396): a
/// multiplied stroke is invisible on a dark article page, while an over blend at
/// the default 0.45 keeps dark text on a white page at a 4.8:1 contrast against
/// the stroke and light text on a dark page at 4.1:1 (WCAG contrast ratios).
///
/// `Arc::make_mut` copies a still's shared decode-cache buffer only when a
/// stroke is actually visible this frame; before the first sweep begins, or on
/// a clip with none, the buffer is untouched and uncopied. Callers holding a
/// shared still go through [`highlighted_picture`] instead, which does not copy
/// per frame.
pub(super) fn apply_highlights_to_rgba(
    img: &mut Arc<RgbaImage>,
    highlights: &[Highlight],
    source_frame: i64,
) {
    if highlights.is_empty() {
        return;
    }
    let (w, h) = img.dimensions();
    let sweeps = sweeps_at(highlights, source_frame, w, h);
    if sweeps.is_empty() {
        return;
    }
    draw_sweeps(Arc::make_mut(img), &sweeps);
}

fn sweeps_at(highlights: &[Highlight], source_frame: i64, w: u32, h: u32) -> Vec<Sweep> {
    highlights
        .iter()
        .filter_map(|hl| hl.sweep_at(source_frame, w, h))
        .collect()
}

/// Blend every sweep onto `img`, touching only the rows the strokes can reach.
/// Returns that row span (`start..end`), `None` when no pixel could change.
fn draw_sweeps(img: &mut RgbaImage, sweeps: &[Sweep]) -> Option<(u32, u32)> {
    let (w, h) = img.dimensions();
    let (y0, y1) = sweeps
        .iter()
        .map(|s| {
            let (_, y0, _, y1) = s.pixel_bounds(w, h);
            (y0, y1)
        })
        .reduce(|(a0, a1), (b0, b1)| (a0.min(b0), a1.max(b1)))?;
    if y1 <= y0 {
        return None;
    }
    let stride = w as usize * 4;
    let band = &mut img.as_mut()[y0 as usize * stride..y1 as usize * stride];
    for_each_row_mut(band, stride, |row_in_band, row| {
        let y = y0 + row_in_band as u32;
        for sweep in sweeps {
            let (x0, sy0, x1, sy1) = sweep.pixel_bounds(w, h);
            if y < sy0 || y >= sy1 {
                continue;
            }
            for x in x0..x1 {
                let k = f64::from(sweep.coverage(x, y)) * f64::from(sweep.opacity);
                if k <= 0.0 {
                    continue;
                }
                let px = &mut row[x as usize * 4..x as usize * 4 + 3];
                for (c, &target) in px.iter_mut().zip(sweep.rgb.iter()) {
                    let cur = f64::from(*c);
                    // Truncates, deliberately: ffmpeg's `geq` floors the float
                    // it computes to the 8-bit level, and agreeing with it by
                    // construction beats rounding "more correctly" and
                    // differing from the export by a level on half the pixels.
                    *c = (cur + k * (f64::from(target) - cur)).clamp(0.0, 255.0) as u8;
                }
            }
        }
    });
    Some((y0, y1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn noisy(w: u32, h: u32, seed: u32) -> RgbaImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let v = |k: u32| {
                ((x.wrapping_mul(2654435761)
                    .wrapping_add(y.wrapping_mul(40503)))
                    ^ seed.wrapping_mul(k + 1)) as u8
            };
            Rgba([v(1), v(2), v(3), v(4)])
        })
    }

    fn stroke(rect: [f64; 4], at: i64, dur: i64) -> Highlight {
        Highlight {
            rect,
            at,
            dur,
            color: None,
            opacity: None,
        }
    }

    /// A shared still, as the decode cache hands it out (two holders).
    fn shared(base: &RgbaImage) -> (Arc<RgbaImage>, Arc<RgbaImage>) {
        let cache = Arc::new(base.clone());
        (Arc::clone(&cache), cache)
    }

    /// **The memoised path draws exactly what the plain operator draws**, on
    /// every frame of a two-stroke clip, played forward and then scrubbed
    /// backwards (the rows a later frame no longer covers are restored), and
    /// the decode cache's own picture is never written.
    #[test]
    fn memoised_frames_equal_the_plain_operator_forward_and_scrubbing_back() {
        let base = noisy(120, 80, 11);
        let hls = [
            stroke([0.1, 0.1, 0.9, 0.3], 2, 10),
            stroke([0.2, 0.55, 0.7, 0.85], 6, 12),
        ];
        let (still, cache) = shared(&base);
        let frames: Vec<i64> = (0..24)
            .chain((0..24).rev())
            .chain([30, 5, 17, 40])
            .collect();
        for frame in frames {
            let mut got = Arc::clone(&still);
            highlighted_picture("memo-equal", &mut got, &hls, frame);
            let mut want = Arc::new(base.clone());
            apply_highlights_to_rgba(&mut want, &hls, frame);
            assert_eq!(*got, *want, "frame {frame}");
            assert_eq!(*cache, base, "the decode cache's picture was modified");
        }
    }

    /// Once every sweep has finished the same finished picture comes back
    /// without any redraw, and before the first sweep the shared picture is
    /// returned as is.
    #[test]
    fn a_finished_clip_reuses_one_picture_and_an_unstarted_one_is_untouched() {
        let base = noisy(60, 40, 5);
        let hls = [stroke([0.1, 0.2, 0.9, 0.8], 4, 6)];
        let (still, _cache) = shared(&base);

        let mut early = Arc::clone(&still);
        highlighted_picture("memo-done", &mut early, &hls, 3);
        assert!(Arc::ptr_eq(&early, &still), "no copy before the sweep");

        let mut first = Arc::clone(&still);
        highlighted_picture("memo-done", &mut first, &hls, 10);
        let mut later = Arc::clone(&still);
        highlighted_picture("memo-done", &mut later, &hls, 9_999);
        assert!(
            Arc::ptr_eq(&first, &later),
            "the finished picture is reused"
        );
        assert_ne!(*first, base);
    }

    /// A video frame nobody else holds is drawn on in place, as before.
    #[test]
    fn a_private_frame_is_drawn_in_place() {
        let base = noisy(40, 30, 2);
        let hls = [stroke([0.0, 0.0, 1.0, 1.0], 0, 0)];
        let mut frame = Arc::new(base.clone());
        let before = Arc::as_ptr(&frame);
        highlighted_picture("memo-video", &mut frame, &hls, 0);
        assert_eq!(Arc::as_ptr(&frame), before);
        assert_ne!(*frame, base);
    }

    /// The pre-B-271 operator, verbatim (whole-image row walk behind a
    /// `make_mut` on the shared still), kept only as the benchmark's baseline.
    fn legacy_apply(img: &mut Arc<RgbaImage>, highlights: &[Highlight], source_frame: i64) {
        let (w, h) = img.dimensions();
        let sweeps = sweeps_at(highlights, source_frame, w, h);
        if sweeps.is_empty() {
            return;
        }
        let stride = w as usize * 4;
        for_each_row_mut(Arc::make_mut(img).as_mut(), stride, |y, row| {
            for sweep in &sweeps {
                let (x0, y0, x1, y1) = sweep.pixel_bounds(w, h);
                if (y as u32) < y0 || (y as u32) >= y1 {
                    continue;
                }
                for x in x0..x1 {
                    let k = f64::from(sweep.coverage(x, y as u32)) * f64::from(sweep.opacity);
                    if k <= 0.0 {
                        continue;
                    }
                    let px = &mut row[x as usize * 4..x as usize * 4 + 3];
                    for (c, &target) in px.iter_mut().zip(sweep.rgb.iter()) {
                        let cur = f64::from(*c);
                        *c = (cur + k * (f64::from(target) - cur)).clamp(0.0, 255.0) as u8;
                    }
                }
            }
        });
    }

    /// B-271 measurement, not a pass/fail test: 240 frames of a 2880x1620 still
    /// with two highlights, through the pre-fix operator (a full clone of the
    /// shared still per frame) and through [`highlighted_picture`].
    /// `cargo test -p apelles --release highlight_draw -- --ignored --nocapture`
    #[test]
    #[ignore = "timing harness (B-271); run with --release --nocapture"]
    fn bench_shared_still_two_highlights_240_frames() {
        let base = noisy(2880, 1620, 3);
        let hls = [
            stroke([0.1, 0.1, 0.9, 0.2], 10, 30),
            stroke([0.1, 0.4, 0.8, 0.5], 40, 30),
        ];
        let (still, _cache) = shared(&base);
        let time = |f: &dyn Fn(i64)| {
            let t = std::time::Instant::now();
            for frame in 0..240 {
                f(frame);
            }
            t.elapsed()
        };
        let per_frame_clone = time(&|frame| {
            let mut img = Arc::clone(&still);
            legacy_apply(&mut img, &hls, frame);
            std::hint::black_box(&img);
        });
        let memoised = time(&|frame| {
            let mut img = Arc::clone(&still);
            highlighted_picture("memo-bench", &mut img, &hls, frame);
            std::hint::black_box(&img);
        });
        println!(
            "B-271 240 frames 2880x1620, 2 highlights: per-frame clone {per_frame_clone:?} ({:.2} ms/frame), memoised {memoised:?} ({:.2} ms/frame)",
            per_frame_clone.as_secs_f64() * 1000.0 / 240.0,
            memoised.as_secs_f64() * 1000.0 / 240.0,
        );
    }
}
