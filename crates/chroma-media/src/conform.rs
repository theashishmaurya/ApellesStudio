//! Conform a source onto its **nominal frame grid** (D-224, B-103).
//!
//! **What it is:** the one place that turns "I want source frame `N`" into the
//! `ffmpeg` input options and filter links that actually deliver it. Every
//! decode path in Chroma builds its command through here so that all of them
//! answer the same question the same way.
//!
//! **The invariant it exists to enforce.** Chroma's whole model — `Clip::
//! source_start`/`duration`, `timeline_frames_to_source`, keyframes, the audio
//! clock, `VideoInfo::frame_count` — treats a source as a CFR strip of frames
//! at `source_fps`. So there is exactly one correct meaning for "source frame
//! `N`":
//!
//! > **source frame `N` is the picture on screen at `N / source_fps` seconds** —
//! > the last coded frame whose PTS is `<= N / source_fps`.
//!
//! That is the *hold* semantics every NLE uses, and it is what makes a nominal
//! frame index a stable name for a moment in the source.
//!
//! **What it does NOT do:** it does not transcode, write a proxy, or touch the
//! source. The conform is a filter on the decode, computed fresh each time, so
//! `project.json` + the original file stay the only inputs to a render (the
//! determinism invariant in `CLAUDE.md`).
//!
//! ## Why this module had to exist (B-103)
//!
//! Before D-224 the decoders disagreed with the model, and with each other.
//! `decode_pipe` and `export::spawn_decoder` seeked by time *once* and then
//! **counted coded frames** — `-fps_mode passthrough`, one output frame per
//! coded frame. On a CFR source that is the same thing. On a **variable frame
//! rate** source it is not: coded frame `k` is not at `k / source_fps`, so the
//! picture drifted away from the index everything else was computed from, and
//! kept drifting for as long as the decoder ran sequentially.
//!
//! Measured on the owner's real macOS screen recording
//! (`before-1.09.51pm.mov`: `avg_frame_rate` 126780/2873 ≈ 44.128, but a real
//! 1/60 s tick base with 47 holds up to 0.567 s), coded-frame index `k` and
//! nominal frame `k` are **up to 4.07 s apart** (≈180 frames, at k=866). That
//! is the on-canvas transform box sitting still while the picture under it is
//! four seconds elsewhere — worse the longer playback ran since the last seek,
//! and snapping back whenever a scrub forced a respawn.
//!
//! ## How the conform works
//!
//! `fps=<num>/<den>:start_time=0:round=up` under `-copyts`, which resamples the
//! decoded stream onto the absolute grid `k / source_fps` — duplicating a held
//! frame and dropping a frame the grid has no slot for.
//!
//! - **`-copyts`** keeps PTS source-absolute, so grid slot `k` means the same
//!   instant no matter where the decoder was opened. Without it `-ss` rebases
//!   to zero and the grid would be relative to the seek point.
//! - **`round=up`** is the load-bearing option, not a default worth taking. The
//!   `fps` filter assigns an input frame with PTS `p` to output slot
//!   `round(p * fps)`, and that frame then holds until the next assignment.
//!   With `round=up` the slot is `ceil(p * fps)`, so slot `k` holds the last
//!   frame with `p <= k / fps` — exactly the invariant above. `near` (the
//!   ffmpeg default) and `down` both let a slot show a frame from the *future*
//!   at a grid boundary. Measured against ground truth over 49 grid indices of
//!   the real file: `round=up` 0 mismatches, `near` 20, `down` 29.
//! - **`-noaccurate_seek`** starts output at the keyframe at-or-before the seek
//!   target instead of discarding everything before it. The `fps` filter needs
//!   to *see* the held frame in order to duplicate it onto the grid, and an
//!   accurate seek throws exactly that frame away when the hold began before
//!   the seek point. It costs nothing: an accurate seek decodes from the same
//!   keyframe anyway, it just drops the result internally. This is why there is
//!   no pre-roll constant here — a fixed "seek back N seconds" guess would have
//!   to exceed the longest hold in the file, which is not knowable up front.
//!
//! **Cost, measured** (200 frames, hardware decode, scaled to the preview cap):
//! CFR 1920x1080 @30 — 2.51 → 2.50 ms/frame, i.e. free, because the filter is a
//! passthrough when the input already sits on the grid. The real VFR file —
//! 4.33 → 5.59 ms/frame, which is the conform doing real work. Both are far
//! inside the 17-31 ms/frame the `decode_pipe` module doc budgets, so this is
//! applied unconditionally rather than behind a "looks VFR" branch: one code
//! path, exercised by every source, is worth more than 1.26 ms on the footage
//! that needs it.

use crate::video::VideoInfo;

/// The `fps` filter's rounding mode. See the module doc — this specific value
/// is what makes a grid slot mean "the picture on screen at that instant".
const GRID_ROUND: &str = "up";

/// `ffmpeg` arguments that put a decode onto the source's nominal frame grid.
///
/// Empty (both fields) when the source has no usable frame rate — an
/// audio-only or unprobeable source — so a caller can splice it in
/// unconditionally and get its previous behaviour back.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GridDecode {
    /// Input options. These MUST be placed before `-i`.
    pub input_args: Vec<String>,
    /// Filter links to place at the FRONT of the `-vf` chain, in this order.
    pub filters: Vec<String>,
}

impl GridDecode {
    /// The filter links joined for `-vf`, with `extra` (the caller's own links,
    /// e.g. `scale=…`) appended. Returns `None` when nothing at all would be
    /// filtered, so a caller can omit `-vf` entirely.
    pub fn vf<'a>(&self, extra: impl IntoIterator<Item = &'a str>) -> Option<String> {
        let mut links: Vec<String> = self.filters.clone();
        links.extend(extra.into_iter().map(str::to_string));
        if links.is_empty() {
            None
        } else {
            Some(links.join(","))
        }
    }
}

/// The conform filter alone — for a decode that reads the source from the
/// start and needs no seek (the thumbnail strip). After this link, the filter
/// graph's frame counter `n` **is** the nominal frame index.
pub fn whole_source(info: &VideoInfo) -> GridDecode {
    let Some(filter) = grid_filter(info) else {
        return GridDecode::default();
    };
    GridDecode {
        input_args: vec!["-copyts".to_string()],
        filters: vec![filter],
    }
}

/// Seek to, and conform from, nominal frame `first`: the first frame the decode
/// emits is `first`, and each frame after it is the next nominal frame.
pub fn from_frame(info: &VideoInfo, first: u64) -> GridDecode {
    let Some(filter) = grid_filter(info) else {
        return GridDecode::default();
    };
    // Half a frame before `first`, used as BOTH the seek target and the select
    // threshold. Grid slots are `1 / fps` apart, so a threshold exactly midway
    // between `first - 1` and `first` has the largest possible margin on each
    // side — no float wobble in the `t` comparison can admit or drop a frame.
    // The same value as the seek target only has to be *not after* `first`;
    // `-noaccurate_seek` then lands on the keyframe at-or-before it, which is
    // what actually guarantees the held frame is visible to the filter.
    let at = seek_secs(info, first);
    GridDecode {
        input_args: vec![
            "-ss".to_string(),
            format!("{at:.6}"),
            "-noaccurate_seek".to_string(),
            "-copyts".to_string(),
        ],
        filters: vec![filter, format!("select=gte(t\\,{at:.6})")],
    }
}

/// The half-frame-early time [`from_frame`] seeks and selects at.
fn seek_secs(info: &VideoInfo, first: u64) -> f64 {
    let fps = info.fps();
    if fps <= 0.0 {
        return 0.0;
    }
    ((first as f64 - 0.5) / fps).max(0.0)
}

/// The nominal frame index whose grid slot contains `secs`.
///
/// The inverse of `VideoInfo::frame_to_secs`, rounded DOWN because a grid slot
/// holds its picture until the next slot begins — the same hold semantics the
/// module doc states.
pub fn frame_at_secs(info: &VideoInfo, secs: f64) -> u64 {
    let fps = info.fps();
    if fps <= 0.0 || !secs.is_finite() || secs <= 0.0 {
        return 0;
    }
    (secs * fps).floor().max(0.0) as u64
}

/// `fps=<num>/<den>:start_time=0:round=up`, or `None` if the source has no
/// usable rate to conform to.
fn grid_filter(info: &VideoInfo) -> Option<String> {
    if info.fps_num == 0 || info.fps_den == 0 {
        return None;
    }
    Some(format!(
        "fps={}/{}:start_time=0:round={GRID_ROUND}",
        info.fps_num, info.fps_den
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(fps_num: u32, fps_den: u32) -> VideoInfo {
        VideoInfo {
            resolution: chroma_types::Resolution::new(1920, 1080),
            fps_num,
            fps_den,
            duration_secs: 10.0,
            frame_count: 240,
            codec: "h264".into(),
            pix_fmt: "yuv420p".into(),
            color_primaries: String::new(),
            color_transfer: String::new(),
            color_space: String::new(),
            has_audio: false,
            audio_sample_rate: 0,
            audio_channels: 0,
        }
    }

    /// The rational is passed through verbatim, never a lossy `f64`. The real
    /// file's own rate — 126780/2873 — is not representable as a short decimal,
    /// and a rounded rate would re-introduce a slow drift of its own.
    #[test]
    fn the_grid_rate_is_the_exact_rational_from_the_probe() {
        let g = from_frame(&info(126780, 2873), 0);
        assert_eq!(g.filters[0], "fps=126780/2873:start_time=0:round=up");
    }

    /// `round=up` is the whole correctness argument (see the module doc). If
    /// this ever silently becomes `near` — the ffmpeg default — a grid slot can
    /// show a frame from the future and B-103 is back.
    #[test]
    fn the_rounding_mode_is_up_not_the_ffmpeg_default() {
        assert_eq!(GRID_ROUND, "up");
        let g = whole_source(&info(30, 1));
        assert!(g.filters[0].ends_with(":round=up"), "{}", g.filters[0]);
    }

    #[test]
    fn seek_and_select_are_half_a_frame_before_the_target() {
        let i = info(50, 1); // 0.02 s per frame
        let g = from_frame(&i, 100);
        // 100 frames = 2.0 s; half a frame earlier = 1.99 s
        assert_eq!(
            g.input_args,
            vec!["-ss", "1.990000", "-noaccurate_seek", "-copyts"]
        );
        assert_eq!(g.filters[1], "select=gte(t\\,1.990000)");
    }

    /// Frame 0 must not seek to a negative time, and must still admit itself.
    #[test]
    fn frame_zero_clamps_to_the_start_of_the_source() {
        let g = from_frame(&info(30, 1), 0);
        assert_eq!(g.input_args[1], "0.000000");
        assert_eq!(g.filters[1], "select=gte(t\\,0.000000)");
    }

    /// `-copyts` is not optional: without it `-ss` rebases timestamps to zero
    /// and `start_time=0` would grid from the seek point, making a frame index
    /// mean something different after every respawn.
    #[test]
    fn timestamps_are_kept_source_absolute() {
        assert!(
            from_frame(&info(30, 1), 900)
                .input_args
                .contains(&"-copyts".to_string())
        );
        assert!(
            whole_source(&info(30, 1))
                .input_args
                .contains(&"-copyts".to_string())
        );
    }

    /// A source with no usable rate (audio-only, unprobeable) yields nothing to
    /// splice in, so callers keep their pre-D-224 command exactly.
    #[test]
    fn a_source_with_no_frame_rate_conforms_to_nothing() {
        assert_eq!(from_frame(&info(0, 1), 10), GridDecode::default());
        assert_eq!(whole_source(&info(30, 0)), GridDecode::default());
        assert_eq!(
            from_frame(&info(0, 1), 10).vf(["scale=2:2"]),
            Some("scale=2:2".into())
        );
    }

    #[test]
    fn vf_puts_the_conform_ahead_of_the_callers_own_links() {
        let g = from_frame(&info(24, 1), 48);
        let vf = g.vf(["scale=1280:720:flags=fast_bilinear"]).expect("some");
        assert_eq!(
            vf,
            "fps=24/1:start_time=0:round=up,select=gte(t\\,1.979167),\
             scale=1280:720:flags=fast_bilinear"
        );
        assert!(g.vf(Vec::<&str>::new()).is_some());
        assert_eq!(GridDecode::default().vf(Vec::<&str>::new()), None);
    }

    /// The grid index of an instant rounds DOWN — slot `k` holds its picture
    /// until slot `k + 1` begins.
    #[test]
    fn an_instant_maps_to_the_grid_slot_holding_it() {
        let i = info(30, 1);
        assert_eq!(frame_at_secs(&i, 0.0), 0);
        assert_eq!(frame_at_secs(&i, 0.99 / 30.0), 0);
        assert_eq!(frame_at_secs(&i, 1.0 / 30.0), 1);
        assert_eq!(frame_at_secs(&i, 1.999 / 30.0), 1);
        assert_eq!(frame_at_secs(&i, 2.0), 60);
        // round trips against the forward map every other path uses
        for f in [0u64, 1, 7, 250] {
            assert_eq!(frame_at_secs(&i, i.frame_to_secs(f)), f);
        }
        // degenerate inputs are 0, never a panic or a negative cast
        assert_eq!(frame_at_secs(&i, -5.0), 0);
        assert_eq!(frame_at_secs(&i, f64::NAN), 0);
        assert_eq!(frame_at_secs(&info(0, 1), 3.0), 0);
    }
}
