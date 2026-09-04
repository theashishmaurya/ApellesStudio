//! Editor-tab audio playback (D-049) — `symphonia` decode → `rubato` resample
//! → `dasp_sample` format-convert → `cpal` device output, synced to the same
//! playhead the video preview (`edit.rs` / `decode_pipe.rs`) already tracks.
//!
//! What it is: a persistent, Rust-owned audio pipeline for the Edit tab's
//!   `<Player>` preview — real device audio during Play, run entirely
//!   independently of the existing wall-clock-driven video `rAF` loop
//!   (`PreviewPane.tsx`) rather than coupled to it frame-by-frame. See the
//!   "sync model" note below for why.
//! What it does: [`chroma_audio_play`] resolves `start_frame` on the active
//!   timeline to every currently-active audio source — the video track's own
//!   embedded audio (via [`super::edit::resolve_video_position`], the exact
//!   same lookup the video preview uses, gated on
//!   [`super::video::VideoInfo::has_audio`]) **plus** (D-057, Phase C — see
//!   below) any clip on a genuine `TrackKind::Audio` track overlapping that
//!   position — and spawns one dedicated OS thread that: opens every source
//!   with `symphonia`, seeks each to its matching source time, decodes
//!   packets from all of them in lockstep, adapts channel count and
//!   resamples each to the output device's config (`rubato`) as needed,
//!   sums them with per-track gain and headroom handling
//!   ([`mix_sources`]), bit-depth-converts the mixed result to whatever
//!   `cpal`'s chosen output `SampleFormat` is (`dasp_sample`), and feeds a
//!   bounded ring buffer that the `cpal` output callback drains.
//!   [`chroma_audio_stop`] tears the session down (pause / re-seek / unmount).
//!   [`chroma_audio_level`] exposes the last measured RMS/peak of what the
//!   output callback actually wrote — the verification hook (see D-049); it
//!   is not wired to any meter UI yet.
//! What it does NOT do: pan/stereo-positioning per track (D-057 scoped this
//!   out — see that decision), audio effects beyond the mix's own headroom
//!   limiter, persisted mute/solo UI (Phase D, blocked on this landing),
//!   audio during scrubbing while paused (silence is correct there — only
//!   real Play produces sound), export audio (`export.rs` stays video-only,
//!   untouched by this module), re-resolving which sources are active mid-
//!   session (a source's set is fixed at the moment `chroma_audio_play` is
//!   called, same as D-050's "no re-seek mid-play" — a clip beginning after a
//!   gap mid-session won't be picked up until the next Play/seek), or long-
//!   session drift correction between the audio and video clocks (see below).
//!
//! ## Waveform extraction (D-051 — the mature timeline UI pass)
//!
//! [`chroma_audio_waveform`] is a second, unrelated-at-runtime feature bolted
//! onto this module because it shares `symphonia` decode plumbing: given a
//! source path and a `[start_secs, start_secs + duration_secs)` range, it
//! decodes just that range, mixes it to mono, and reduces it to a fixed
//! number of (min, max) peak-per-bucket pairs ([`peaks_from_samples`], pure
//! and unit tested) for `TimelinePane.tsx`'s `Waveform.tsx` to draw on a
//! `<canvas>`. It is a **one-shot batch read**, not a streaming session — no
//! `cpal`, no `rubato` (peak extraction doesn't care what rate the samples
//! are at, only their relative amplitude), no ring buffer, no `SESSION`
//! state. [`decode_mono_range`]'s symphonia open/probe/seek setup duplicates
//! ~20 lines of [`run_session`]'s (open file → probe → find audio track →
//! make decoder → seek) rather than sharing a helper — see that function's
//! doc for why.
//!
//! ## The sync-model decision (D-049)
//!
//! Two designs were on the table:
//!
//!   **(A) poll-and-fill keyed off the displayed frame** — treat audio like
//!   another per-frame decode, matching whatever frame the video side just
//!   requested. Rejected: `cpal`'s output callback asks for samples at
//!   device-buffer granularity (single-digit milliseconds), far finer and
//!   completely untied to the frontend's 60fps `rAF` tick / per-frame IPC
//!   call. Driving it from there would either starve the callback (audible
//!   underrun/glitching) or require an IPC rate far beyond what one JPEG-a-
//!   frame preview channel is built for.
//!
//!   **(B) a persistent streaming audio thread with its own buffer** — chosen.
//!   The Rust-owned pipeline above free-runs against the *audio device's own
//!   hardware clock* (the `cpal` callback cadence), completely decoupled from
//!   the per-frame IPC/`rAF` loop.
//!
//! Having chosen (B), the remaining question is how audio and video *stay*
//! in sync once both are running. The most robust answer — video queries the
//! audio thread's current playback position every `rAF` tick and snaps to it
//! — was **not** built this pass: it needs a new polling round-trip on the
//! video side that does not exist today, for a session length (a preview /
//! scrub tool, not hours of continuous transport) where the alternative is
//! already accurate enough. Instead: both sides start from the *same*
//! `playhead` frame at the *same* "begin playing" moment — the video
//! preview's `rAF` loop already re-baselines its `performance.now()` start
//! time on every Play toggle (see `PreviewPane.tsx`), and
//! [`chroma_audio_play`] is called at that exact same transition — and then
//! run **open-loop** against real wall-clock time independently of each
//! other: video paced by `performance.now()`, audio paced by the output
//! device's DAC clock. Remaining error is the two clocks' mutual drift over a
//! session (device-clock-vs-OS-wall-clock drift is on the order of tens of
//! parts-per-million — imperceptible over a realistic preview session, not
//! something this scrub/preview tool needs to correct for today).
//! **Known, deliberate limitation:** no drift correction for a very long
//! continuous play session, no re-sync on a mid-play seek (there isn't one —
//! see below). If drift is ever reported in practice, the natural next step is
//! exactly the audio-is-the-master-clock design sketched above.
//!
//! ### Start-up skew compensation (D-125 — a real reported failure, not theory)
//!
//! "Both sides start at the same moment" is the whole load-bearing assumption
//! above, and D-050 estimated the gap at "one IPC round-trip, single-digit ms."
//! That estimate was wrong in practice. The video clock re-baselines the
//! instant the frontend toggles Play, but the audio pipeline still has to open
//! the output device, probe each container and seek every source before it can
//! produce a single sample — and D-050 started the `cpal` stream *before* all of
//! that, so the callback drained an empty ring and [`pull_or_silence`] emitted
//! silence for the entire warm-up. Because the ring is a plain FIFO with no
//! timestamps, that head silence is never made up: audio ended up permanently
//! behind the picture by however long the warm-up took, which the owner heard
//! and reported as lagging audio.
//!
//! **Measured, not assumed:** against the owner's own `A001_08302215_C019.MOV`
//! (4K HEVC + 48 kHz AAC), the warm-up is **157 ms** with the file already warm
//! in the page cache and **431-635 ms** cold, across repeated runs on an idle
//! machine. Broadcast tolerance for audio *lagging* picture is around 45 ms, so
//! even the best case was audible and the typical case badly so. In the running
//! app it was worse again, because `chroma_audio_play` was a main-thread
//! command queued behind a preview decode that itself took hundreds of
//! milliseconds (see D-125).
//!
//! [`run_session`] now measures the real elapsed time from the moment
//! [`chroma_audio_play`] was called, discards exactly that much audio from the
//! sources ([`skew_compensation`] / [`discard_samples`] — decode runs orders of
//! magnitude faster than real time, so this is cheap), prefills
//! [`PREFILL_SECS`] into the ring, and only *then* starts the device. That
//! makes the open-loop model's premise actually true instead of assumed,
//! without adding the per-tick position polling D-050 deliberately declined to
//! build. Compensation is capped at [`MAX_SKEW_COMPENSATION_SECS`] so a
//! pathological warm-up can never silently skip audible content.
//!
//! `chroma_audio_play(start_frame)` doubles as "seek and play" — there is no
//! separate seek-while-playing command, because the video loop already
//! restarts its own wall-clock baseline fresh on every Play toggle, so the
//! frontend only ever needs to call this at that same transition (see
//! `PreviewPane.tsx`).
//!
//! ## Multi-track mixing (D-057, Phase C of `docs/notes/multi-track-nle.md`)
//!
//! D-049/D-050 (above) deliberately did not populate `chroma-timeline`'s
//! `TrackKind::Audio` — nothing yet needed a second, genuinely audio-only
//! source. This module now reads one when it exists
//! ([`super::edit::resolve_audio_track_positions`]), while leaving the
//! baseline video-embedded-audio path from D-050 completely intact as the
//! default/first source. **Still nothing in the app populates an
//! `Audio` track** (Phase D UI is blocked on this landing — see the note) —
//! this is the mixing *capability*, exercised in this module's own tests via
//! a hand-built `Timeline`, same spirit as D-054 landing `add_track`/
//! `move_clip` before any UI called them.
//!
//! **Where per-track gain lives:** `chroma_timeline::Track::gain` (a plain
//! `f32`, default `1.0`) — on the model, not a side table in this module or
//! in `chroma::project`. `chroma-timeline`'s own module doc draws the line at
//! "no media, no rendering, no compositing"; a numeric mix-level multiplier
//! is none of those — it's exactly the kind of plain editorial property
//! (like `Clip::start_frame`, D-054) that belongs in the domain model so it
//! persists with the project and Phase D's future mute/volume UI has a real
//! field to read and write, not a parallel map this module would have to
//! keep in sync with track add/remove. This module owns *interpreting* that
//! number (the mixing math, [`mix_sources`]/[`soft_limit`]) — reading media
//! and touching `cpal` is squarely `chroma::audio`'s job, not
//! `chroma-timeline`'s.
//!
//! **Headroom:** summed sources are passed through a soft (tanh) limiter,
//! not a hard clamp or a blanket `1/N` pre-scale — see [`mix_sources`]'s own
//! doc for the three options considered and why. The pre-existing single-
//! source (D-050) case takes a provably identical code path (no summation,
//! no limiter) — see that same doc.
//!
//! **Scoped out this pass, deliberately:** stereo panning / positioning per
//! track. Mono gain scaling (this module already collapses everything to the
//! output device's channel count via [`adapt_channels`] regardless of source
//! channel count) covers Phase C's actual goal — mixing N sources with
//! per-track level control — without the real extra complexity a pan law
//! would add (equal-power vs. linear pan, mid/side handling once more than
//! stereo is in play). Nothing in `docs/notes/multi-track-nle.md`'s Phase C
//! scope asks for it; revisit if/when Phase D's UI wants a pan control.
//!
//! ## The ring buffer
//!
//! A plain `Mutex<VecDeque<f32>>`, not a lock-free SPSC ring (e.g. the
//! `ringbuf` crate) — a deliberate MVP simplification: the `cpal` callback
//! holds the lock only for a fast pop loop, not decode/resample work: a
//! measurable glitch would require the decode thread to hold the lock for a
//! problematic stretch, which does not happen in this design (it does the
//! actual decode/resample work *outside* the lock and only locks briefly to
//! extend the buffer). Documented here as the first thing to revisit if
//! audio glitching is ever observed in practice.
//!
//! Fork hygiene (D-003): all new code; `chroma/mod.rs` gains `pub mod audio;`,
//! `lib.rs` three new `generate_handler!` lines.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use dasp_sample::FromSample;
use once_cell::sync::Lazy;
use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, SeekMode, SeekTo, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::units::Time;

// --------------------------------------------------------------------------- //
// pure logic — unit tested (see the `tests` module at the bottom)
// --------------------------------------------------------------------------- //

/// Adapt an interleaved `f32` buffer from `src_channels` to `dst_channels`.
/// Mono → N duplicates the one channel to every output channel; N → mono
/// averages; a channel-count change in either other direction maps each
/// output channel to the nearest source channel index (good enough for the
/// stereo↔5.1-ish cases this MVP is unlikely to actually hit — a talking-head
/// / screen-capture source is overwhelmingly mono or stereo). `src_channels
/// == dst_channels` (the common case) is a no-op copy. Pure — no I/O.
pub(crate) fn adapt_channels(src: &[f32], src_channels: usize, dst_channels: usize) -> Vec<f32> {
    if src_channels == 0 || dst_channels == 0 || src_channels == dst_channels {
        return src.to_vec();
    }
    let frames = src.len() / src_channels;
    let mut out = Vec::with_capacity(frames * dst_channels);
    for f in 0..frames {
        let frame = &src[f * src_channels..f * src_channels + src_channels];
        if src_channels == 1 {
            out.extend(std::iter::repeat_n(frame[0], dst_channels));
        } else if dst_channels == 1 {
            out.push(frame.iter().sum::<f32>() / src_channels as f32);
        } else {
            for d in 0..dst_channels {
                let s = (d * src_channels / dst_channels).min(src_channels - 1);
                out.push(frame[s]);
            }
        }
    }
    out
}

/// Pop up to `want` interleaved samples off the front of `buf`, padding with
/// silence (`0.0`) on underrun. Returns the samples plus whether it
/// underran. This is the windowing the `cpal` output callback does every
/// call — pulled out as a pure function so it has a real correct/incorrect
/// answer independent of any actual audio device. Pure — no I/O.
pub(crate) fn pull_or_silence(buf: &mut VecDeque<f32>, want: usize) -> (Vec<f32>, bool) {
    let mut out = Vec::with_capacity(want);
    let mut underran = false;
    for _ in 0..want {
        match buf.pop_front() {
            Some(s) => out.push(s),
            None => {
                out.push(0.0);
                underran = true;
            }
        }
    }
    (out, underran)
}

/// Expected output frame count for resampling `input_frames` from `in_rate`
/// to `out_rate` — the sizing math behind [`RateConverter`]'s output buffer.
/// Pure arithmetic — a real correct/incorrect answer, no I/O.
pub(crate) fn resampled_frame_count(input_frames: usize, in_rate: u32, out_rate: u32) -> usize {
    if in_rate == 0 {
        return 0;
    }
    ((input_frames as u64 * out_rate as u64) / in_rate as u64) as usize
}

/// How many interleaved samples of start-up latency to skip past, and the
/// seconds that corresponds to — the arithmetic behind [`run_session`]'s
/// warm-up compensation (D-125). `skew_secs` is real elapsed time between the
/// frontend asking for playback (the same instant the video clock re-baselines)
/// and the audio pipeline being ready to feed the device; the result is how far
/// into the sources to advance so the first sample that actually reaches the
/// DAC is the one the picture is already showing.
///
/// Clamped at [`MAX_SKEW_COMPENSATION_SECS`] — past that, skipping would throw
/// away audible content, so the caller leaves the remainder as real offset and
/// logs it. A negative or non-finite `skew_secs` (not reachable from
/// `Instant::elapsed`, but this is pure arithmetic with a real correct answer)
/// compensates nothing. Pure — no I/O.
pub(crate) fn skew_compensation(
    skew_secs: f64,
    out_rate: u32,
    out_channels: usize,
) -> (usize, f64) {
    if !skew_secs.is_finite() || skew_secs <= 0.0 {
        return (0, 0.0);
    }
    let capped = skew_secs.min(MAX_SKEW_COMPENSATION_SECS);
    let samples = (capped * out_rate as f64) as usize * out_channels.max(1);
    (samples, capped)
}

/// Reduce mono `samples` to `bucket_count` (min, max) peak pairs — the
/// amplitude envelope [`chroma_audio_waveform`] returns for `Waveform.tsx` to
/// draw as a canvas waveform (D-051). Splits `samples` into `bucket_count`
/// contiguous, near-equal-sized chunks (`i * n / bucket_count` boundaries, so
/// the remainder spreads across the trailing buckets by at most one sample
/// each rather than dumping it all in the last one) and takes the signed
/// min/max value in each. `bucket_count == 0` or empty `samples` → an empty
/// `Vec`; `bucket_count` at or beyond `samples.len()` still returns exactly
/// `bucket_count` pairs, some singleton buckets. Pure — no I/O.
pub(crate) fn peaks_from_samples(samples: &[f32], bucket_count: usize) -> Vec<(f32, f32)> {
    let n = samples.len();
    if n == 0 || bucket_count == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(bucket_count);
    for b in 0..bucket_count {
        let start = b * n / bucket_count;
        let end = ((b + 1) * n / bucket_count).max(start + 1).min(n);
        let chunk = &samples[start..end];
        let (mut lo, mut hi) = (chunk[0], chunk[0]);
        for &s in &chunk[1..] {
            if s < lo {
                lo = s;
            }
            if s > hi {
                hi = s;
            }
        }
        out.push((lo, hi));
    }
    out
}

/// Smooth soft-knee limiter (D-057, Phase C mixing) — `tanh(x)`. Guarantees
/// `|soft_limit(x)| <= 1.0` for any finite `x` (mathematically `|tanh(x)| <
/// 1` strictly; at `f32` precision an extreme `x` — far beyond anything a
/// real audio mix produces — rounds to exactly `1.0`, not past it, so the
/// property that actually matters, *never exceeding full scale*, still
/// holds), is odd (`soft_limit(-x) == -soft_limit(x)`) and passes small-
/// magnitude input through almost unchanged (`tanh'(0) == 1`, so the error
/// at typical dialogue/music amplitudes — well under ±0.3 — is third-order
/// in `x`, inaudible) while compressing only as a summed mix approaches or
/// exceeds full scale. This is the standard shape for a master-bus limiter:
/// it avoids the harsh, audibly distorted digital clipping a hard
/// `clamp(-1.0, 1.0)` would produce the moment two or more simultaneously
/// loud sources sum past unity. Pure — no I/O. See [`mix_sources`] for
/// where/when it's actually applied.
pub(crate) fn soft_limit(x: f32) -> f32 {
    x.tanh()
}

/// Mix `buffers` (equal-length, interleaved, already channel-adapted and
/// resampled to the output device's rate/channel count — one per active
/// audio source in a [`chroma_audio_play`] session) into one buffer, each
/// scaled by its own `gains[i]` first (D-057's per-track gain).
///
/// **Headroom approach — chosen and justified (D-057):** a track at `gain ==
/// 0.0` (muted) is dropped entirely *before* deciding how many sources are
/// really contributing, rather than summed-then-multiplied-by-zero. Once
/// only the still-nonzero-gain sources remain:
/// - **Exactly one (or zero) active source → no summation, no limiter.** The
///   buffer is returned as-is (`gain == 1.0`, the default for both a freshly
///   added track and the baseline video-embedded-audio source) or scaled by
///   its own gain, and nothing else touches it. This is what keeps two
///   things exactly true, not just approximately: (1) the pre-D-057
///   single-embedded-audio-track case (D-050, still the only real scenario
///   until a project actually gets a populated audio track) takes an
///   **identical code path with identical output**, not merely
///   indistinguishable output — no limiter, no multiply-by-1.0 rounding, to
///   this function's caller; (2) muting one of two active tracks
///   (`gains = [1.0, 0.0]`) makes the mix **exactly** (not approximately)
///   equal to the other source alone, a real bit-for-bit checkable property
///   this module's tests assert directly, not just "sounds about right."
/// - **Two or more active sources → sum, then pass every summed sample
///   through [`soft_limit`].** Chosen over the two other standard options the
///   brief named: pre-scaling every source by `1/N` guarantees no clipping
///   too, but permanently quietens a mix even when the sources are never
///   simultaneously near full scale (the common real case — e.g. dialogue
///   and a music bed rarely peak together), which is a worse default than
///   this tool's users would expect; a hard `clamp` avoids the `1/N`
///   loudness tax but produces true digital clipping (audible distortion) on
///   whatever moments *do* sum past unity. A soft (tanh) limiter gets the
///   best of both: normal-level mixes pass through at full loudness
///   (unaffected in practice — see [`soft_limit`]'s own doc), and only the
///   rare simultaneous-peak moment is smoothly compressed instead of
///   harshly clipped.
///
/// `len` is every buffer's length (all callers already guarantee this — see
/// [`DecodedSource::take`]); `buffers.len() != gains.len()` is a caller bug,
/// `debug_assert`ed rather than handled, since both always come from the
/// same per-source `Vec` zip in [`run_session`]. Pure — no I/O.
pub(crate) fn mix_sources(buffers: &[Vec<f32>], gains: &[f32], len: usize) -> Vec<f32> {
    debug_assert_eq!(buffers.len(), gains.len());
    let active: Vec<usize> = (0..buffers.len()).filter(|&i| gains[i] != 0.0).collect();

    if active.len() <= 1 {
        return match active.first() {
            None => vec![0.0; len],
            Some(&i) if gains[i] == 1.0 => buffers[i].clone(),
            Some(&i) => buffers[i].iter().map(|s| s * gains[i]).collect(),
        };
    }

    let mut out = vec![0f32; len];
    for &i in &active {
        for (o, s) in out.iter_mut().zip(buffers[i].iter()) {
            *o += s * gains[i];
        }
    }
    for o in out.iter_mut() {
        *o = soft_limit(*o);
    }
    out
}

// --------------------------------------------------------------------------- //
// rate conversion (rubato) — a thin chunking wrapper, integration-verified
// (see the module doc comment / the task's boot-verification), not unit
// tested: its correctness is "does real audio come out sounding right",
// which a pure unit test can't meaningfully assert.
// --------------------------------------------------------------------------- //

/// Buffers arbitrary-sized interleaved input chunks (symphonia packets vary
/// in frame count) and resamples exactly `chunk_frames`-sized windows through
/// a `rubato` `SincFixedIn` resampler as soon as enough have accumulated.
/// **Known gap:** the final partial chunk at end-of-stream (< `chunk_frames`
/// leftover, ≤ ~21 ms at the settings below) is never flushed through — a
/// clip's last fraction of a second of audio can be silently dropped. Cheap
/// to fix later (`rubato::Resampler::process_partial`) if it's ever audible;
/// not done here to keep the decode-loop shutdown path simple for the MVP.
struct RateConverter {
    resampler: SincFixedIn<f32>,
    channels: usize,
    chunk_frames: usize,
    in_rate: u32,
    out_rate: u32,
    /// per-channel accumulation of not-yet-resampled input frames
    acc: Vec<Vec<f32>>,
}

impl RateConverter {
    fn new(in_rate: u32, out_rate: u32, channels: usize) -> Result<Self, String> {
        let ratio = out_rate as f64 / in_rate as f64;
        let params = SincInterpolationParameters {
            sinc_len: 128,
            f_cutoff: 0.95,
            oversampling_factor: 128,
            interpolation: SincInterpolationType::Linear,
            window: WindowFunction::BlackmanHarris2,
        };
        let chunk_frames = 1024;
        let resampler = SincFixedIn::<f32>::new(ratio, 2.0, params, chunk_frames, channels.max(1))
            .map_err(|e| format!("rubato resampler init: {e}"))?;
        Ok(Self {
            resampler,
            channels: channels.max(1),
            chunk_frames,
            in_rate,
            out_rate,
            acc: vec![Vec::new(); channels.max(1)],
        })
    }

    /// Feed interleaved input samples (already at `channels` channel count);
    /// returns interleaved resampled output — empty if not enough input has
    /// accumulated yet for a full chunk.
    fn push_interleaved(&mut self, interleaved: &[f32]) -> Result<Vec<f32>, String> {
        for frame in interleaved.chunks_exact(self.channels) {
            for (c, s) in frame.iter().enumerate() {
                self.acc[c].push(*s);
            }
        }

        // Sized once up front via the same math `resampled_frame_count` is
        // unit-tested against, so the common multi-chunk push doesn't pay for
        // a `Vec` regrowth on every chunk it resamples.
        let expect_frames = resampled_frame_count(
            interleaved.len() / self.channels,
            self.in_rate,
            self.out_rate,
        );
        let mut out = Vec::with_capacity(expect_frames * self.channels);
        while self.acc[0].len() >= self.chunk_frames {
            let chunk: Vec<Vec<f32>> = self
                .acc
                .iter()
                .map(|c| c[..self.chunk_frames].to_vec())
                .collect();
            let waves_out = self
                .resampler
                .process(&chunk, None)
                .map_err(|e| format!("rubato process: {e}"))?;
            for c in self.acc.iter_mut() {
                c.drain(0..self.chunk_frames);
            }
            let out_frames = waves_out.first().map(Vec::len).unwrap_or(0);
            for f in 0..out_frames {
                for c in waves_out.iter().take(self.channels) {
                    out.push(c[f]);
                }
            }
        }
        Ok(out)
    }
}

/// Either a no-op passthrough (source and device sample rates already match —
/// the common case, e.g. 48 kHz source into a 48 kHz device) or a real
/// [`RateConverter`]. Keeping the fast path explicit avoids paying rubato's
/// chunking machinery when there is nothing to convert.
enum Resample {
    Passthrough,
    Convert(RateConverter),
}

impl Resample {
    fn new(in_rate: u32, out_rate: u32, channels: usize) -> Result<Self, String> {
        if in_rate == out_rate {
            Ok(Resample::Passthrough)
        } else {
            Ok(Resample::Convert(RateConverter::new(
                in_rate, out_rate, channels,
            )?))
        }
    }

    fn push(&mut self, interleaved: &[f32]) -> Result<Vec<f32>, String> {
        match self {
            Resample::Passthrough => Ok(interleaved.to_vec()),
            Resample::Convert(rc) => rc.push_interleaved(interleaved),
        }
    }
}

// --------------------------------------------------------------------------- //
// session state — one audio session at a time (single-video-track MVP);
// mirrors decode_pipe.rs's PIPE / state.rs's THUMB_CACHE module-global style
// --------------------------------------------------------------------------- //

struct AudioSession {
    /// bumped on every play/stop call; the audio thread checks this and exits
    /// as soon as it no longer matches — the teardown signal for both a
    /// deliberate stop and a rapid re-play superseding it.
    generation: u64,
    join: Option<thread::JoinHandle<()>>,
}

static SESSION: Lazy<Mutex<AudioSession>> = Lazy::new(|| {
    Mutex::new(AudioSession {
        generation: 0,
        join: None,
    })
});

/// Last-measured (rms, peak) of what the `cpal` output callback actually
/// wrote, updated roughly once a second of played audio. `(0.0, 0.0)` before
/// any playback or once a session stops — the verification hook for D-049
/// (see [`chroma_audio_level`]); not wired to any meter UI.
static LEVEL: Lazy<Mutex<(f32, f32)>> = Lazy::new(|| Mutex::new((0.0, 0.0)));

/// Master preview-monitoring volume (D-126) — a linear multiplier applied to
/// every sample as it leaves the ring buffer, in `build_typed`'s real-time
/// output callback. Deliberately **not** [`AudioSourceSpec::gain`]/
/// `chroma_timeline::Track::gain` — those are project data (D-057, persisted,
/// per-track, feeds the actual mix). This is a local, unpersisted "how loud is
/// the monitor" control the player's own transport bar drives, independent of
/// what the project's tracks are actually set to. An `AtomicU32` holding an
/// `f32`'s bits (not a `Mutex<f32>`) because the real-time audio callback must
/// never block; `Ordering::Relaxed` is correct here since this is a single
/// scalar with no other memory access that needs to stay ordered against it.
/// Starts at real unity gain (`1.0`, not a sentinel) — `f32::to_bits` is a
/// `const fn` on this workspace's Rust 1.98, so there's no ambiguous "unset"
/// state to special-case.
static MASTER_VOLUME_BITS: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(1.0f32.to_bits());

fn is_current(my_gen: u64) -> bool {
    SESSION.lock().unwrap_or_else(|e| e.into_inner()).generation == my_gen
}

/// Bump the generation (invalidating any in-flight audio thread) and join
/// whatever thread was previously running. Returns the new generation.
fn stop_and_bump_generation() -> u64 {
    let (my_gen, old_join) = {
        let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        guard.generation += 1;
        (guard.generation, guard.join.take())
    };
    if let Some(j) = old_join {
        let _ = j.join();
    }
    *LEVEL.lock().unwrap_or_else(|e| e.into_inner()) = (0.0, 0.0);
    my_gen
}

// --------------------------------------------------------------------------- //
// tauri commands
// --------------------------------------------------------------------------- //

/// Stop whatever is currently playing (or a no-op if nothing is). Called on
/// pause and on unmount; also called implicitly by [`chroma_audio_play`]
/// before it starts a new session.
///
/// `(async)` (D-125): this joins the audio thread, which can take up to one of
/// its poll intervals — that must not happen on Tauri's main thread, where it
/// would stall the window and every other in-flight command. `(async)` on a
/// synchronous `fn` is Tauri's own "run this command off the main thread"
/// mechanism, and keeps the function directly callable from tests.
#[tauri::command(async)]
pub fn chroma_audio_stop() {
    stop_and_bump_generation();
}

/// Set the master preview-monitoring volume (D-126) — a `0.0..=1.0` linear
/// multiplier applied to every sample in the real `cpal` output callback
/// (see [`MASTER_VOLUME_BITS`]'s own doc for why this exists separately from
/// per-track `gain`). Takes effect on whatever's currently playing, not just
/// the next session — there's nothing to restart. Out-of-range input is
/// clamped rather than rejected: a UI slider can't produce anything outside
/// `0.0..=1.0` by construction, and the one real caller most likely to send a
/// slightly-off value is a mute toggle round-tripping a remembered volume, not
/// a genuine error worth surfacing.
#[tauri::command]
pub fn chroma_audio_set_volume(volume: f32) {
    let clamped = volume.clamp(0.0, 1.0);
    MASTER_VOLUME_BITS.store(clamped.to_bits(), std::sync::atomic::Ordering::Relaxed);
}

/// One audio source for a play session (D-057) — a source path, the source
/// second to start decoding from, and the linear gain to scale its
/// contribution by in the final mix (see [`mix_sources`]). Built once per
/// [`chroma_audio_play`] call from whatever's active at `start_frame`; not
/// re-resolved mid-session (matches D-050's own "no re-seek mid-play" design
/// — see the module doc).
struct AudioSourceSpec {
    path: PathBuf,
    start_secs: f64,
    gain: f32,
}

/// Seek-and-play in one call: resolve `start_frame` on the active timeline to
/// every currently-active audio source — the video track's own embedded
/// audio (D-050's original, still-default behaviour, unchanged: always at
/// unity gain, resolved via the same [`super::edit::resolve_video_position`]
/// lookup the video preview uses) **plus** (D-057, Phase C) any clip on a
/// genuine `TrackKind::Audio` track that overlaps `start_frame`, each at its
/// own track's gain — and start a fresh session that decodes and mixes all of
/// them together (see [`run_session`]). No active source anywhere (no video
/// clip at this position, or one with no audio stream, and no audio-track
/// clip either) is **not** an error: it just means nothing plays, matching
/// the video preview's own "blank frame past the end" behaviour.
/// `(async)` (D-125): see [`chroma_audio_stop`] — same reason, and here it also
/// means the command isn't itself queued behind a main-thread preview decode,
/// which is precisely the latency the video clock does not wait for.
#[tauri::command(async)]
pub fn chroma_audio_play(start_frame: u64) -> Result<(), String> {
    // The instant the frontend asked for playback — the same moment the video
    // rAF loop re-baselines its own `performance.now()` clock. Everything
    // between here and the first sample reaching the DAC is skew the audio
    // would otherwise carry for the whole session (D-125); `run_session`
    // measures against this and compensates for it.
    let requested_at = Instant::now();
    let my_gen = stop_and_bump_generation();

    let mut sources: Vec<AudioSourceSpec> = Vec::new();

    if let Some((clip, source_frame, info)) = super::edit::resolve_video_position(start_frame)? {
        if info.has_audio {
            sources.push(AudioSourceSpec {
                path: PathBuf::from(&clip.source_path),
                start_secs: info.frame_to_secs(source_frame),
                gain: 1.0,
            });
        } else {
            log::debug!(
                "chroma_audio_play: {} has no audio stream — nothing from the video track",
                clip.source_path
            );
        }
    }

    for (path, start_secs, gain) in super::edit::resolve_audio_track_positions(start_frame)? {
        sources.push(AudioSourceSpec {
            path,
            start_secs,
            gain,
        });
    }

    if sources.is_empty() {
        return Ok(());
    }

    let handle = thread::Builder::new()
        .name("chroma-audio".into())
        .spawn(move || {
            let n = sources.len();
            if let Err(e) = run_session(sources, my_gen, requested_at) {
                log::warn!("chroma audio session ({n} source(s)): {e}");
            }
        })
        .map_err(|e| format!("spawn audio thread: {e}"))?;

    // Only install the handle if we're still the current generation — a
    // near-simultaneous stop/re-play could have bumped it again already
    // while the thread above was spawning; if so, this handle would just be
    // orphaned bookkeeping (the thread itself still exits promptly on its
    // own via `is_current`, this only affects whether `stop_and_bump_
    // generation` gets to `join()` it tidily).
    let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if guard.generation == my_gen {
        guard.join = Some(handle);
    }
    Ok(())
}

/// Last-measured (rms, peak) of the audio actually written to the output
/// device, roughly once per second of playback; `(0.0, 0.0)` when nothing is
/// playing. Not consumed by any UI yet — the concrete, pollable proxy for "is
/// cpal really producing non-silent PCM" (D-049 verification).
#[tauri::command]
pub fn chroma_audio_level() -> (f32, f32) {
    *LEVEL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Downsampled amplitude envelope for `source_path`'s `[start_secs,
/// start_secs + duration_secs)` range (D-051) — what `Waveform.tsx` draws
/// instead of decoding PCM in the browser. `source_path`/`start_secs`/
/// `duration_secs` are exactly a timeline clip's `source_path`/
/// `source_start`/`duration` converted to seconds by the caller (the same
/// frame→seconds convention `timelineFps` already uses elsewhere in
/// `@chroma/editor` — this command takes seconds, not frames, so it has no
/// opinion on the project's fps). `buckets` is how many (min, max) pairs to
/// reduce to — callers pass roughly the clip's on-screen pixel width so one
/// bucket is about one canvas column.
///
/// Returns an empty `Vec` — not an error — for a source with no audio stream
/// (checked via [`super::edit::probe_cached`], the same cache
/// `chroma_timeline_frame`/`chroma_audio_play` already share) or a
/// non-positive `duration_secs`/`buckets`: the same "nothing to draw" shape
/// `chroma_timeline_frame`'s blank-frame return uses, so a silent clip's
/// waveform request doesn't have to be treated as failure in the frontend.
/// Peak buckets cached per second of source (D-128). The waveform is drawn at
/// roughly one bucket per 2 on-screen px, so at the UI's maximum zoom (480
/// px/s, `ruler.ts`) a second of source is 240 px and wants ~120 buckets.
/// This is that, rounded up — fine enough that re-bucketing down to any real
/// request is visually identical to decoding for it, and coarse enough that a
/// long clip's cached envelope stays small (a 517-second clip is 128k pairs,
/// ~1 MB on disk).
const CACHED_PEAKS_PER_SEC: f64 = 128.0;
/// Ceiling on a cached envelope's bucket count, so a very long source can't
/// produce an unbounded cache entry.
const MAX_CACHED_PEAKS: usize = 1_000_000;

const NS_WAVEFORM: &str = "waveform";

/// One source range's amplitude envelope: `(min, max)` per bucket. `Arc` so a
/// cache hit is a refcount bump rather than a clone of a long clip's envelope.
type PeakEnvelope = Arc<Vec<(f32, f32)>>;

/// In-process envelopes, in front of the disk cache — a scroll/zoom re-render
/// asks for the same range many times a second and shouldn't touch the
/// filesystem for it.
static PEAKS_MEM: Lazy<Mutex<HashMap<String, PeakEnvelope>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const MAX_PEAKS_MEM: usize = 200;

fn peaks_cache_key(source_key: &str, start_secs: f64, duration_secs: f64) -> String {
    // Whole milliseconds, so two calls for the same real clip range can't
    // miss each other over float noise (`1.2000000000000002` vs `1.2`) —
    // the same rounding D-119's own cache key used, for the same reason.
    let ms = |s: f64| (s.max(0.0) * 1000.0).round() as u64;
    format!(
        "{source_key}-s{}-d{}-r{}",
        ms(start_secs),
        ms(duration_secs),
        CACHED_PEAKS_PER_SEC as u32
    )
}

/// The cached, fixed-resolution amplitude envelope for a source range:
/// memory → disk → a real `symphonia` decode.
///
/// **Why the caller's `buckets` is deliberately not part of the key (D-128).**
/// Before this, `chroma_audio_waveform` had no Rust-side cache at all and
/// `Waveform.tsx` keyed its own on the bucket count, which it derives from the
/// clip's *on-screen pixel width* — so every zoom step, every panel resize,
/// every window resize was a brand-new key and therefore a brand-new full
/// audio decode of the clip's whole range. That is precisely the defect D-124
/// found and fixed on the filmstrip side ("what is fetched no longer depends
/// on how wide the clip is drawn") and it was still live here. Caching one
/// fixed-resolution envelope and re-bucketing it in memory makes zoom free
/// for the waveform too.
fn cached_peaks(path: &Path, start_secs: f64, duration_secs: f64) -> Result<PeakEnvelope, String> {
    let source_key = super::media_cache::source_key(path).ok();
    let key = source_key
        .as_deref()
        .map(|k| peaks_cache_key(k, start_secs, duration_secs));

    if let Some(key) = key.as_deref()
        && let Some(hit) = PEAKS_MEM.lock().unwrap_or_else(|e| e.into_inner()).get(key)
    {
        return Ok(Arc::clone(hit));
    }
    if let Some(key) = key.as_deref()
        && let Some(peaks) = super::media_cache::read_json::<Vec<(f32, f32)>>(NS_WAVEFORM, key)
    {
        let peaks = Arc::new(peaks);
        let mut mem = PEAKS_MEM.lock().unwrap_or_else(|e| e.into_inner());
        if mem.len() > MAX_PEAKS_MEM {
            mem.clear();
        }
        mem.insert(key.to_string(), Arc::clone(&peaks));
        return Ok(peaks);
    }

    let began = std::time::Instant::now();
    let samples = decode_mono_range(path, start_secs.max(0.0), duration_secs)?;
    let cached_buckets = ((duration_secs.max(0.0) * CACHED_PEAKS_PER_SEC).ceil() as usize)
        .clamp(1, MAX_CACHED_PEAKS);
    let peaks = Arc::new(peaks_from_samples(&samples, cached_buckets));
    // Same discipline D-124 established for the filmstrip: a real decode
    // leaves a trace, a cache hit does not. The whole reason that feature
    // took three rounds to diagnose was that a slow decode and an absent one
    // looked identical from outside.
    log::info!(
        "chroma_audio_waveform: {} [{:.2}s +{:.2}s] -> {} peaks in {:.2}s",
        path.display(),
        start_secs,
        duration_secs,
        peaks.len(),
        began.elapsed().as_secs_f64(),
    );

    if let Some(key) = key.as_deref() {
        super::media_cache::write_json(NS_WAVEFORM, key, peaks.as_ref());
        let mut mem = PEAKS_MEM.lock().unwrap_or_else(|e| e.into_inner());
        if mem.len() > MAX_PEAKS_MEM {
            mem.clear();
        }
        mem.insert(key.to_string(), Arc::clone(&peaks));
    }
    Ok(peaks)
}

/// Re-bucket an already-computed envelope down (or up) to `buckets` pairs,
/// taking the min/max across each group so a peak is never averaged away.
/// Pure — the half of the waveform path that a zoom change now costs.
pub(crate) fn rebucket_peaks(peaks: &[(f32, f32)], buckets: usize) -> Vec<(f32, f32)> {
    let n = peaks.len();
    if n == 0 || buckets == 0 {
        return Vec::new();
    }
    if buckets >= n {
        return peaks.to_vec();
    }
    let mut out = Vec::with_capacity(buckets);
    for b in 0..buckets {
        let start = b * n / buckets;
        let end = ((b + 1) * n / buckets).max(start + 1).min(n);
        let (mut lo, mut hi) = peaks[start];
        for &(l, h) in &peaks[start + 1..end] {
            if l < lo {
                lo = l;
            }
            if h > hi {
                hi = h;
            }
        }
        out.push((lo, hi));
    }
    out
}

/// The synchronous body of [`chroma_audio_waveform`] — everything except
/// getting off the main thread. Split out (rather than making the tests
/// `#[tokio::test]`) for the same reason `project.rs` gives for its own
/// equivalent split: this module is otherwise entirely sync, and pulling a
/// tokio test runtime into it to exercise one command is a bigger change than
/// the thing being tested.
pub(crate) fn waveform_peaks(
    source_path: &str,
    start_secs: f64,
    duration_secs: f64,
    buckets: usize,
) -> Result<Vec<(f32, f32)>, String> {
    if duration_secs <= 0.0 || buckets == 0 {
        return Ok(Vec::new());
    }
    let path = PathBuf::from(source_path);
    let info = super::edit::probe_cached(&path)?;
    if !info.has_audio {
        return Ok(Vec::new());
    }
    let peaks = cached_peaks(&path, start_secs, duration_secs)?;
    Ok(rebucket_peaks(&peaks, buckets))
}

/// `async` + `spawn_blocking` (D-128). A non-`async` Tauri command runs on
/// the app's **main thread**, and this one can do a multi-second `symphonia`
/// decode — so every visible audio-bearing clip's waveform was decoding on
/// the same thread that paints the window. Cheap to fix, and it is on the
/// path between opening a project and the timeline appearing.
#[tauri::command]
pub async fn chroma_audio_waveform(
    source_path: String,
    start_secs: f64,
    duration_secs: f64,
    buckets: usize,
) -> Result<Vec<(f32, f32)>, String> {
    tokio::task::spawn_blocking(move || {
        waveform_peaks(&source_path, start_secs, duration_secs, buckets)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decode `path`'s default audio track from `start_secs` for `duration_secs`,
/// mixed down to mono `f32` at the source's native sample rate — no
/// resampling, since [`peaks_from_samples`]'s bucket reduction only needs
/// enough samples per bucket to be representative, not a fixed output rate.
/// A one-shot batch read for [`chroma_audio_waveform`]; **not** shared with
/// [`run_session`] despite overlapping symphonia setup (open → probe → find
/// audio track → make decoder → seek) — deliberately duplicated rather than
/// extracted into a common helper, because the two diverge immediately after
/// that point (this one collects a bounded mono `Vec` and returns; that one
/// streams indefinitely through `rubato` resampling into a live `cpal`
/// callback) and factoring the shared prefix out would mean threading a
/// `Box<dyn FormatReader + 'static>` + `Box<dyn Decoder>` pair back out of a
/// helper into `run_session`'s already-verified (D-050) playback path for a
/// ~20-line dedup — judged not worth the risk of touching tested, working
/// code for this pass.
fn decode_mono_range(path: &Path, start_secs: f64, duration_secs: f64) -> Result<Vec<f32>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("probe: {e}"))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or("no audio track")?
        .clone();
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("audio track has no codec parameters")?
        .clone();
    let src_rate = codec_params
        .sample_rate
        .ok_or("audio track has no sample rate")?;
    let src_channels = codec_params
        .channels
        .as_ref()
        .map(|c| c.count())
        .unwrap_or(1)
        .max(1);

    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &Default::default())
        .map_err(|e| format!("make decoder: {e}"))?;

    if start_secs > 0.0
        && let Some(time) = Time::try_from_secs_f64(start_secs)
    {
        // Same "not fatal" treatment as `run_session`'s seek: worst case, the
        // extracted range starts a little late in the source.
        let _ = format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time,
                track_id: Some(track_id),
            },
        );
    }

    let target_frames = (duration_secs * src_rate as f64).ceil() as usize;
    let mut mono: Vec<f32> = Vec::with_capacity(target_frames.min(8 * 1024 * 1024));

    'decode: while mono.len() < target_frames {
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break 'decode, // source shorter than the requested range — return what we have
            Err(SymError::ResetRequired) => break 'decode,
            Err(SymError::IoError(_)) => break 'decode,
            Err(e) => return Err(format!("next_packet: {e}")),
        };
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue, // skip the bad packet, keep going
            Err(e) => return Err(format!("decode: {e}")),
        };

        let mut interleaved = vec![0f32; decoded.samples_interleaved()];
        decoded.copy_to_slice_interleaved(&mut interleaved);
        for frame in interleaved.chunks_exact(src_channels) {
            mono.push(frame.iter().sum::<f32>() / src_channels as f32);
            if mono.len() >= target_frames {
                break;
            }
        }
    }

    Ok(mono)
}

// --------------------------------------------------------------------------- //
// the audio thread — owns every source's symphonia decoder, the cpal stream,
// and the ring buffer between them for its whole lifetime; nothing here is
// ever moved to another thread (sidesteps needing `cpal::Stream: Send`, which
// varies by host backend — see the `run_session` doc below)
// --------------------------------------------------------------------------- //

/// One already-open, mid-decode audio source (D-057) — a `symphonia`
/// format reader + decoder for a single source file, already resampled and
/// channel-adapted to the session's shared output rate/channel count, plus a
/// small carry buffer of already-produced-but-not-yet-consumed interleaved
/// samples. `symphonia` packets and `rubato` chunks come out in whatever
/// sizes they come in, which rarely line up with the fixed-size window
/// [`run_session`]'s mixing loop pulls every source in lockstep by — `carry`
/// is what absorbs that mismatch (produced-but-unread samples sit here
/// between [`Self::ensure`] calls) so every source can be asked for exactly
/// the same number of samples regardless of its own internal packet/chunk
/// sizes.
struct DecodedSource {
    label: String,
    format: Box<dyn symphonia::core::formats::FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::audio::AudioDecoder>,
    track_id: u32,
    src_channels: usize,
    resample: Resample,
    carry: VecDeque<f32>,
    /// Set once `next_packet` reports EOF/reset for this source — its
    /// contribution to the mix from then on is silence (padding in
    /// [`Self::take`]), not an end to the whole session (other sources may
    /// still be playing; see `run_session`'s loop condition).
    exhausted: bool,
}

impl DecodedSource {
    /// Decode further packets until `carry` holds at least `want` samples or
    /// this source hits EOF (setting `exhausted`, after which `carry` may
    /// stay short of `want` forever — that's fine, [`Self::take`] pads).
    fn ensure(&mut self, want: usize, out_channels: usize) -> Result<(), String> {
        while self.carry.len() < want && !self.exhausted {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => {
                    self.exhausted = true;
                    break;
                }
                Err(SymError::ResetRequired) => {
                    self.exhausted = true;
                    break;
                }
                Err(SymError::IoError(_)) => {
                    self.exhausted = true;
                    break;
                }
                Err(e) => return Err(format!("next_packet ({}): {e}", self.label)),
            };
            if packet.track_id != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(SymError::DecodeError(_)) => continue, // skip the bad packet, keep going
                Err(e) => return Err(format!("decode ({}): {e}", self.label)),
            };
            let mut interleaved = vec![0f32; decoded.samples_interleaved()];
            decoded.copy_to_slice_interleaved(&mut interleaved);
            let adapted = adapt_channels(&interleaved, self.src_channels, out_channels);
            let resampled = self.resample.push(&adapted)?;
            self.carry.extend(resampled);
        }
        Ok(())
    }

    /// Pop exactly `want` interleaved samples — decoding more first via
    /// [`Self::ensure`] if needed, padding with silence once this source is
    /// exhausted (its own contribution simply becomes silence for the rest
    /// of the session; the other sources are unaffected).
    fn take(&mut self, want: usize, out_channels: usize) -> Result<Vec<f32>, String> {
        self.ensure(want, out_channels)?;
        let mut out = Vec::with_capacity(want);
        for _ in 0..want {
            out.push(self.carry.pop_front().unwrap_or(0.0));
        }
        Ok(out)
    }

    /// True once this source will never produce another non-silent sample —
    /// `run_session`'s whole-session-done check (every source, not just
    /// one) is `.all(DecodedSource::is_done)`.
    fn is_done(&self) -> bool {
        self.exhausted && self.carry.is_empty()
    }
}

/// Open `path`'s default audio track, seek to `start_secs`, and set up
/// resampling to the session's shared `(out_rate, out_channels)` — the common
/// "get a source ready to decode" setup every [`AudioSourceSpec`] in a
/// [`run_session`] call goes through. Mirrors [`decode_mono_range`]'s
/// symphonia open/probe/seek prefix (duplicated there for the documented
/// reason: the two diverge immediately after — one a bounded batch read, this
/// one a live streaming source kept open for the session's lifetime).
fn open_source(
    path: &Path,
    start_secs: f64,
    out_rate: u32,
    out_channels: usize,
) -> Result<DecodedSource, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open: {e}"))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|e| format!("probe: {e}"))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or("no audio track")?
        .clone();
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .and_then(|p| p.audio())
        .ok_or("audio track has no codec parameters")?
        .clone();
    let src_rate = codec_params
        .sample_rate
        .ok_or("audio track has no sample rate")?;
    let src_channels = codec_params
        .channels
        .as_ref()
        .map(|c| c.count())
        .unwrap_or(1)
        .max(1);

    let decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_params, &Default::default())
        .map_err(|e| format!("make decoder: {e}"))?;

    if start_secs > 0.0
        && let Some(time) = Time::try_from_secs_f64(start_secs)
    {
        // A seek failure this early (e.g. a container that can't seek
        // precisely) isn't fatal — worst case playback starts from wherever
        // the reader already is (typically the very start).
        let _ = format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time,
                track_id: Some(track_id),
            },
        );
    }

    let resample = Resample::new(src_rate, out_rate, out_channels)?;

    Ok(DecodedSource {
        label: path.display().to_string(),
        format,
        decoder,
        track_id,
        src_channels,
        resample,
        carry: VecDeque::new(),
        exhausted: false,
    })
}

/// How much audio to have buffered before the output device is started
/// (D-125). Enough that an ordinary scheduling hiccup on the decode thread
/// can't underrun the `cpal` callback the instant playback begins; small
/// enough that producing it is a couple of milliseconds of decode, which the
/// warm-up compensation above then accounts for anyway.
const PREFILL_SECS: f64 = 0.15;

/// Ceiling on how much start-up latency [`run_session`] will silently skip
/// past to keep audio aligned with the picture (D-125). Beyond this, skipping
/// would throw away audible content, so the remainder is left as real offset
/// and logged instead.
const MAX_SKEW_COMPENSATION_SECS: f64 = 2.0;

/// Pull one `chunk_len` window from every source in lockstep and mix it —
/// the single step both the prefill and the steady-state loop in
/// [`run_session`] run, factored out so they cannot drift apart.
fn mix_chunk(
    decoded: &mut [DecodedSource],
    gains: &[f32],
    chunk_len: usize,
    out_channels: usize,
) -> Result<Vec<f32>, String> {
    let mut bufs: Vec<Vec<f32>> = Vec::with_capacity(decoded.len());
    for ds in decoded.iter_mut() {
        bufs.push(ds.take(chunk_len, out_channels)?);
    }
    Ok(mix_sources(&bufs, gains, chunk_len))
}

/// Decode and throw away `n` interleaved samples from every source in
/// lockstep — how [`run_session`] skips the audio that should already have
/// played while the pipeline was warming up (D-125). Sources that are already
/// exhausted simply pad silence, exactly as they do in the mix.
fn discard_samples(
    decoded: &mut [DecodedSource],
    n: usize,
    out_channels: usize,
    chunk_len: usize,
) -> Result<(), String> {
    let mut left = n;
    while left > 0 {
        let want = left.min(chunk_len);
        for ds in decoded.iter_mut() {
            ds.take(want, out_channels)?;
        }
        left -= want;
    }
    Ok(())
}

/// Runs entirely on the dedicated thread [`chroma_audio_play`] spawned for
/// it. Opens the default `cpal` output device once, opens every one of
/// `sources` (D-057: the baseline video-embedded audio plus any overlapping
/// `TrackKind::Audio` clips) via [`open_source`], and drives a mixing loop
/// that pulls a fixed-size window of interleaved samples from every still-
/// active source in lockstep, sums them via [`mix_sources`] (unchanged,
/// single-source behaviour when `sources.len() == 1` — see that function's
/// doc for why this keeps the pre-D-057 single-track case byte-identical),
/// and writes the mixed window into the ring buffer the `cpal` callback
/// drains — until either every source is exhausted (then idles, keeping the
/// device stream open — silent — until told to stop) or `my_gen` is
/// superseded.
///
/// **If `sources[0]` (the baseline) fails to open, that's a real error** —
/// same contract this function always had for its one source. **If any later
/// source (an audio-track clip) fails to open, it's logged and dropped, not
/// fatal** — a broken/offline music-bed clip shouldn't take down a session
/// that would otherwise have played the video's dialogue track fine; the
/// remaining sources still mix.
///
/// The `cpal::Stream` is a local variable here, created and dropped on this
/// same thread, and is never stored in the `SESSION` static or otherwise
/// moved across threads — deliberately sidesteps relying on `Stream: Send`
/// (its `Send`-ness is backend-dependent; CoreAudio's does resolve to `Send`
/// in practice via its `Monitor: Send + Sync` supertrait bound, but pinning
/// the whole design on that rather than needing it at all is simpler and
/// more portable).
fn run_session(
    sources: Vec<AudioSourceSpec>,
    my_gen: u64,
    requested_at: Instant,
) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no default audio output device")?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("default_output_config: {e}"))?;
    let sample_format = supported.sample_format();
    let out_rate = supported.sample_rate();
    let out_channels = supported.channels() as usize;
    let stream_config: cpal::StreamConfig = supported.into();

    let ring_cap = (out_rate as usize * out_channels).max(1); // ~1s
    let ring: Arc<Mutex<VecDeque<f32>>> =
        Arc::new(Mutex::new(VecDeque::with_capacity(ring_cap * 2)));

    // Built (which opens the device) but deliberately NOT started yet — see
    // the warm-up compensation below. Starting it here, as D-050 originally
    // did, means the callback drains an empty ring and `pull_or_silence`
    // emits silence for the whole warm-up, which the ring's plain FIFO then
    // carries as a permanent audio-behind-video offset.
    let stream = build_output_stream(
        &device,
        &stream_config,
        sample_format,
        out_channels,
        ring.clone(),
    )?;

    let mut decoded: Vec<DecodedSource> = Vec::with_capacity(sources.len());
    let mut gains: Vec<f32> = Vec::with_capacity(sources.len());
    for (i, spec) in sources.iter().enumerate() {
        match open_source(&spec.path, spec.start_secs, out_rate, out_channels) {
            Ok(ds) => {
                decoded.push(ds);
                gains.push(spec.gain);
            }
            Err(e) if i == 0 => return Err(e), // the baseline source failing is a real error
            Err(e) => log::warn!(
                "chroma audio: skipping extra source {}: {e}",
                spec.path.display()
            ),
        }
    }

    // Every non-baseline source failed to open too (or `sources` somehow
    // ended up empty) — nothing to actually mix. Idle exactly like the EOF
    // case below rather than erroring, since the caller (`chroma_audio_play`)
    // already treats "nothing to play" as a non-error.
    if decoded.is_empty() {
        stream.play().map_err(|e| format!("stream.play: {e}"))?;
        while is_current(my_gen) {
            thread::sleep(Duration::from_millis(50));
        }
        return Ok(());
    }

    // Matches `RateConverter::chunk_frames` — not load-bearing that it does
    // (any window size works), just keeps the two aligned so a resampled
    // source rarely straddles a window boundary mid-`rubato`-chunk.
    let chunk_frames = 1024;
    let chunk_len = chunk_frames * out_channels.max(1);

    // --- warm-up compensation + prefill (D-125) -------------------------- //
    //
    // D-050's open-loop sync model is only correct if audio and video really
    // do begin from the same playhead frame at the same instant; it assumed
    // the gap between them was "one IPC round-trip, single-digit ms." It is
    // not: opening the output device, probing a large container and seeking
    // every source is real work, and it all happens *after* the video's rAF
    // loop has already re-baselined its wall clock. Whatever that took, the
    // audio would otherwise be exactly that far behind the picture for the
    // rest of the session — the design's own stated failure mode, just at a
    // magnitude it did not anticipate.
    //
    // So: discard the samples that *should* already have played during the
    // warm-up, then prefill a little, then start the device. Discarding is
    // cheap — decode runs orders of magnitude faster than real time — and it
    // is the only correction that keeps the two clocks aligned without
    // introducing the per-tick position polling D-050 deliberately did not
    // build.
    let skew = requested_at.elapsed().as_secs_f64();
    let (skew_samples, capped_skew) = skew_compensation(skew, out_rate, out_channels);
    if skew > MAX_SKEW_COMPENSATION_SECS {
        // Something pathological (an unresponsive device, a source that took
        // seconds to seek). Compensating the whole way would skip audible
        // content, so cap it and say so rather than silently jumping ahead.
        log::warn!(
            "chroma audio: {skew:.2}s of start-up latency exceeds the \
             {MAX_SKEW_COMPENSATION_SECS:.1}s compensation cap — audio will start \
             {:.2}s behind the picture",
            skew - MAX_SKEW_COMPENSATION_SECS
        );
    }
    if skew_samples > 0 {
        discard_samples(&mut decoded, skew_samples, out_channels, chunk_len)?;
    }

    let prefill_len = (PREFILL_SECS * out_rate as f64) as usize * out_channels.max(1);
    while ring.lock().unwrap_or_else(|e| e.into_inner()).len() < prefill_len
        && !decoded.iter().all(DecodedSource::is_done)
        && is_current(my_gen)
    {
        let mixed = mix_chunk(&mut decoded, &gains, chunk_len, out_channels)?;
        ring.lock().unwrap_or_else(|e| e.into_inner()).extend(mixed);
    }

    // A stop (or a superseding play) that landed during the warm-up means this
    // session should never make a sound at all — starting the device now would
    // emit a brief blip of the prefill before the loops below noticed and tore
    // it down.
    if !is_current(my_gen) {
        return Ok(());
    }

    log::debug!(
        "chroma audio: warm-up {:.0}ms (compensated {:.0}ms), prefilled {} samples, starting stream",
        skew * 1000.0,
        capped_skew * 1000.0,
        prefill_len
    );
    stream.play().map_err(|e| format!("stream.play: {e}"))?;

    'mix: loop {
        if !is_current(my_gen) {
            break 'mix;
        }
        if decoded.iter().all(DecodedSource::is_done) {
            break 'mix; // every source exhausted — fall through to the idle wait below
        }

        let mixed = mix_chunk(&mut decoded, &gains, chunk_len, out_channels)?;

        // Backpressure: block briefly while the ring buffer is comfortably
        // full rather than growing it unbounded — bail out early if a
        // stop/re-play superseded us while waiting.
        loop {
            let len = ring.lock().unwrap_or_else(|e| e.into_inner()).len();
            if len < ring_cap * 2 || !is_current(my_gen) {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        if !is_current(my_gen) {
            break 'mix;
        }
        ring.lock().unwrap_or_else(|e| e.into_inner()).extend(mixed);
    }

    // Every source exhausted (or a benign reset/EOF-shaped error) — keep the
    // device stream open (it'll drain to silence once the ring buffer empties
    // on its own) until told to stop, rather than reopening the device every
    // time playback runs past the end of the longest source's audio.
    while is_current(my_gen) {
        thread::sleep(Duration::from_millis(50));
    }
    Ok(()) // `stream` drops here, closing the device
}

/// Build the `cpal` output stream for whichever `sample_format` the device's
/// default config actually is, dispatching to a generic body via
/// `dasp_sample::FromSample` for the `f32` (internal pipeline) → device
/// sample-type conversion.
fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    channels: usize,
    ring: Arc<Mutex<VecDeque<f32>>>,
) -> Result<cpal::Stream, String> {
    let out_rate = config.sample_rate;
    match sample_format {
        cpal::SampleFormat::F32 => build_typed::<f32>(device, config, out_rate, channels, ring),
        cpal::SampleFormat::I16 => build_typed::<i16>(device, config, out_rate, channels, ring),
        cpal::SampleFormat::U16 => build_typed::<u16>(device, config, out_rate, channels, ring),
        other => Err(format!("unsupported cpal output sample format {other:?}")),
    }
}

fn build_typed<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    out_rate: u32,
    channels: usize,
    ring: Arc<Mutex<VecDeque<f32>>>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + FromSample<f32>,
{
    // ~1s of interleaved samples — how often the RMS/peak window (and the
    // D-049 verification log line) refreshes.
    let window_len = (out_rate as usize * channels.max(1)).max(1);
    let mut window_count = 0usize;
    let mut window_sumsq = 0f64;
    let mut window_peak = 0f32;

    device
        .build_output_stream(
            *config,
            move |data: &mut [T], _info: &cpal::OutputCallbackInfo| {
                let (samples, _underran) = {
                    let mut buf = ring.lock().unwrap_or_else(|e| e.into_inner());
                    pull_or_silence(&mut buf, data.len())
                };
                // D-126: the master monitoring volume, applied here — after
                // the ring buffer, before the device and before the RMS/peak
                // meter — so `chroma_audio_level` (and any future meter UI)
                // reports what's actually audible, not the pre-mute signal.
                let volume = f32::from_bits(
                    MASTER_VOLUME_BITS.load(std::sync::atomic::Ordering::Relaxed),
                );
                for (dst, s) in data.iter_mut().zip(samples.iter()) {
                    let s = s * volume;
                    *dst = T::from_sample(s);
                    window_sumsq += (s as f64) * (s as f64);
                    window_peak = window_peak.max(s.abs());
                }
                window_count += samples.len();
                if window_count >= window_len {
                    let rms = (window_sumsq / window_count as f64).sqrt() as f32;
                    *LEVEL.lock().unwrap_or_else(|e| e.into_inner()) = (rms, window_peak);
                    log::info!("chroma audio: rms={rms:.4} peak={window_peak:.4}");
                    window_count = 0;
                    window_sumsq = 0.0;
                    window_peak = 0.0;
                }
            },
            move |err| log::warn!("chroma audio stream error: {err}"),
            None,
        )
        .map_err(|e| format!("build_output_stream: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// D-126: `chroma_audio_set_volume` clamps to `0.0..=1.0` and the real
    /// `Ordering::Relaxed` atomic round-trips exactly — no other test in this
    /// module touches `MASTER_VOLUME_BITS`, so this is safe against Rust's
    /// default parallel test execution without needing its own lock.
    #[test]
    fn chroma_audio_set_volume_clamps_and_round_trips() {
        let read = || {
            f32::from_bits(MASTER_VOLUME_BITS.load(std::sync::atomic::Ordering::Relaxed))
        };

        chroma_audio_set_volume(0.42);
        assert_eq!(read(), 0.42);

        chroma_audio_set_volume(-1.0);
        assert_eq!(read(), 0.0, "negative volume clamps to silence, not a negative multiplier");

        chroma_audio_set_volume(5.0);
        assert_eq!(read(), 1.0, "volume above unity clamps to 1.0, not amplified beyond it");

        chroma_audio_set_volume(1.0);
        assert_eq!(read(), 1.0, "leave MASTER_VOLUME_BITS at real unity for any test that runs after this one");
    }

    #[test]
    fn adapt_channels_mono_to_stereo_duplicates() {
        let mono = vec![0.1, 0.2, 0.3];
        let stereo = adapt_channels(&mono, 1, 2);
        assert_eq!(stereo, vec![0.1, 0.1, 0.2, 0.2, 0.3, 0.3]);
    }

    #[test]
    fn adapt_channels_stereo_to_mono_averages() {
        let stereo = vec![1.0, 3.0, -1.0, -3.0];
        let mono = adapt_channels(&stereo, 2, 1);
        assert_eq!(mono, vec![2.0, -2.0]);
    }

    #[test]
    fn adapt_channels_same_count_is_passthrough() {
        let stereo = vec![0.1, -0.2, 0.3, -0.4];
        assert_eq!(adapt_channels(&stereo, 2, 2), stereo);
    }

    #[test]
    fn adapt_channels_zero_channels_is_passthrough() {
        let buf = vec![0.5, 0.6];
        assert_eq!(adapt_channels(&buf, 0, 2), buf);
        assert_eq!(adapt_channels(&buf, 2, 0), buf);
    }

    #[test]
    fn pull_or_silence_exact_available() {
        let mut buf: VecDeque<f32> = [1.0, 2.0, 3.0].into_iter().collect();
        let (out, underran) = pull_or_silence(&mut buf, 3);
        assert_eq!(out, vec![1.0, 2.0, 3.0]);
        assert!(!underran);
        assert!(buf.is_empty());
    }

    #[test]
    fn pull_or_silence_pads_on_underrun() {
        let mut buf: VecDeque<f32> = [1.0, 2.0].into_iter().collect();
        let (out, underran) = pull_or_silence(&mut buf, 5);
        assert_eq!(out, vec![1.0, 2.0, 0.0, 0.0, 0.0]);
        assert!(underran);
    }

    #[test]
    fn pull_or_silence_empty_buffer_is_all_silence() {
        let mut buf: VecDeque<f32> = VecDeque::new();
        let (out, underran) = pull_or_silence(&mut buf, 4);
        assert_eq!(out, vec![0.0, 0.0, 0.0, 0.0]);
        assert!(underran);
    }

    #[test]
    fn resampled_frame_count_math() {
        assert_eq!(resampled_frame_count(48_000, 48_000, 48_000), 48_000); // passthrough rate
        assert_eq!(resampled_frame_count(44_100, 44_100, 48_000), 48_000); // 44.1k -> 48k, 1s
        assert_eq!(resampled_frame_count(48_000, 48_000, 44_100), 44_100); // 48k -> 44.1k, 1s
        assert_eq!(resampled_frame_count(1_000, 0, 48_000), 0); // guard against div-by-zero
    }

    #[test]
    fn skew_compensation_converts_seconds_to_interleaved_samples() {
        // 100 ms of 48 kHz stereo = 4800 frames = 9600 interleaved samples.
        assert_eq!(skew_compensation(0.1, 48_000, 2), (9_600, 0.1));
        // mono halves it
        assert_eq!(skew_compensation(0.1, 48_000, 1), (4_800, 0.1));
    }

    #[test]
    fn skew_compensation_is_capped_so_it_never_skips_audible_content() {
        let (samples, capped) = skew_compensation(10.0, 48_000, 2);
        assert_eq!(capped, MAX_SKEW_COMPENSATION_SECS);
        assert_eq!(
            samples,
            (MAX_SKEW_COMPENSATION_SECS * 48_000.0) as usize * 2
        );
    }

    #[test]
    fn skew_compensation_of_nothing_compensates_nothing() {
        assert_eq!(skew_compensation(0.0, 48_000, 2), (0, 0.0));
        assert_eq!(skew_compensation(-1.0, 48_000, 2), (0, 0.0));
        assert_eq!(skew_compensation(f64::NAN, 48_000, 2), (0, 0.0));
    }

    #[test]
    fn peaks_from_samples_min_max_per_bucket() {
        // 4 samples, 2 buckets -> [0,1] and [2,3]
        let samples = [0.2, -0.5, 0.9, -0.1];
        let peaks = peaks_from_samples(&samples, 2);
        assert_eq!(peaks, vec![(-0.5, 0.2), (-0.1, 0.9)]);
    }

    #[test]
    fn peaks_from_samples_empty_or_zero_buckets_is_empty() {
        assert_eq!(peaks_from_samples(&[], 10), Vec::new());
        assert_eq!(peaks_from_samples(&[0.1, 0.2], 0), Vec::new());
    }

    #[test]
    fn peaks_from_samples_covers_every_sample_exactly_once() {
        // an odd sample count that doesn't divide evenly into the bucket
        // count — every sample must land in exactly one bucket's min/max,
        // none dropped, none double-counted (the i*n/bucket_count boundary
        // math is the thing under test here).
        let samples: Vec<f32> = (0..17).map(|i| i as f32).collect();
        let peaks = peaks_from_samples(&samples, 5);
        assert_eq!(peaks.len(), 5);
        assert_eq!(peaks[0].0, 0.0); // first bucket's min is the first sample
        assert_eq!(peaks[4].1, 16.0); // last bucket's max is the last sample
        // monotonically increasing input -> monotonically increasing bucket maxima
        for w in peaks.windows(2) {
            assert!(w[1].1 >= w[0].1);
        }
    }

    #[test]
    fn peaks_from_samples_more_buckets_than_samples_still_returns_bucket_count() {
        let samples = [1.0, -1.0];
        let peaks = peaks_from_samples(&samples, 5);
        assert_eq!(peaks.len(), 5);
    }

    #[test]
    fn peaks_from_samples_single_sample_bucket_has_equal_min_max() {
        let peaks = peaks_from_samples(&[0.42], 1);
        assert_eq!(peaks, vec![(0.42, 0.42)]);
    }

    // --- D-057: the mixer's headroom math (soft_limit / mix_sources) --------

    #[test]
    fn soft_limit_is_bounded_odd_and_near_identity_for_small_input() {
        assert_eq!(soft_limit(0.0), 0.0);
        assert!(
            (soft_limit(0.1) - 0.1).abs() < 0.001,
            "near-identity at low level"
        );
        assert!((soft_limit(0.5) - 0.5f32.tanh()).abs() < 1e-6);
        // A moderate overshoot (3.0 — plausible from 3 simultaneously loud
        // unity-gain sources) is compressed but stays strictly under full
        // scale at f32 precision.
        assert!(
            soft_limit(3.0) < 1.0 && soft_limit(3.0) > 0.99,
            "compressed, still under unity"
        );
        assert!(soft_limit(-3.0) > -1.0 && soft_limit(-3.0) < -0.99);
        // The real, load-bearing safety property — never *exceeds* full
        // scale — holds even at an extreme input where f32 rounds
        // `tanh(x)` to exactly 1.0 (mathematically `tanh(x) < 1` always, but
        // an f32 this close to 1.0 has no representable value between it and
        // 1.0 to round to): still no digital-clipping overshoot, which is
        // the guarantee that actually matters for the mixer.
        assert!(soft_limit(1e6) <= 1.0);
        assert!(soft_limit(-1e6) >= -1.0);
        assert_eq!(soft_limit(-2.0), -soft_limit(2.0), "odd function");
    }

    #[test]
    fn mix_sources_single_source_unity_gain_is_a_byte_identical_passthrough() {
        // The D-050 regression contract: with exactly one active source at
        // the default gain, mix_sources must not alter the buffer at all —
        // no multiply, no limiter — so the pre-existing single-embedded-
        // audio-track playback path is provably unchanged by this change.
        let buf = vec![0.1f32, -0.9, 0.37, -0.02, 0.6];
        let mixed = mix_sources(&[buf.clone()], &[1.0], buf.len());
        assert_eq!(mixed, buf);
    }

    #[test]
    fn mix_sources_single_source_nonunity_gain_scales_without_limiting() {
        let buf = vec![0.4f32, -0.4, 0.2];
        let mixed = mix_sources(&[buf.clone()], &[0.5], buf.len());
        assert_eq!(mixed, vec![0.2, -0.2, 0.1]);
    }

    #[test]
    fn mix_sources_two_sources_sums_them() {
        let a = vec![0.1f32, 0.2, 0.3];
        let b = vec![0.05f32, -0.1, 0.05];
        let mixed = mix_sources(&[a.clone(), b.clone()], &[1.0, 1.0], 3);
        // Both nonzero and under the limiter's near-identity range at these
        // small magnitudes, so this is (within soft_limit's negligible
        // low-level error) the true sum, not silence and not just one input.
        for i in 0..3 {
            let expected = soft_limit(a[i] + b[i]);
            assert!((mixed[i] - expected).abs() < 1e-6);
        }
        assert_ne!(mixed, a, "not just the first source");
        assert_ne!(mixed, b, "not just the second source");
    }

    /// The exact, checkable "mute via gain" property the task brief asks
    /// for: muting one of two active sources (`gain == 0.0`) must make the
    /// mix **identical** to the other source alone — not approximately, not
    /// "close enough" — because a muted source is dropped before the
    /// active-source count (and therefore whether the limiter engages at
    /// all) is decided.
    #[test]
    fn mix_sources_muting_one_of_two_sources_equals_the_other_alone() {
        let a = vec![0.9f32, -0.8, 0.95, -0.99]; // deliberately loud — would
        // engage the limiter if both sources were summed, proving the
        // muted branch really does skip summation+limiting entirely, not
        // just "happen to look the same" at low amplitude.
        let b = vec![0.7f32, 0.6, -0.5, 0.4];

        let mix_mute_b = mix_sources(&[a.clone(), b.clone()], &[1.0, 0.0], 4);
        assert_eq!(mix_mute_b, a, "muting b must equal a alone, exactly");

        let mix_mute_a = mix_sources(&[a.clone(), b.clone()], &[0.0, 1.0], 4);
        assert_eq!(mix_mute_a, b, "muting a must equal b alone, exactly");

        // and both are provably different from the real (unmuted) mix — the
        // mute genuinely changes the output, this isn't a no-op comparison
        let both_active = mix_sources(&[a.clone(), b.clone()], &[1.0, 1.0], 4);
        assert_ne!(both_active, a);
        assert_ne!(both_active, b);
    }

    #[test]
    fn mix_sources_all_gains_zero_is_silence() {
        let a = vec![0.5f32, 0.5];
        let b = vec![0.5f32, 0.5];
        let mixed = mix_sources(&[a, b], &[0.0, 0.0], 2);
        assert_eq!(mixed, vec![0.0, 0.0]);
    }

    #[test]
    fn mix_sources_loud_overlapping_sources_never_exceed_unity() {
        // Three simultaneously loud sources — a naive sum would blow well
        // past full scale (up to 3.0); the limiter must keep every sample
        // inside [-1, 1].
        let a = vec![0.9f32; 8];
        let b = vec![0.9f32; 8];
        let c = vec![0.9f32; 8];
        let mixed = mix_sources(&[a, b, c], &[1.0, 1.0, 1.0], 8);
        assert!(
            mixed.iter().all(|s| s.abs() <= 1.0),
            "never exceeds full scale: {mixed:?}"
        );
        // and it's still meaningfully louder than a single source alone —
        // the limiter compresses, it doesn't silence
        assert!(mixed[0] > 0.9, "still louder than any one source alone");
    }

    #[test]
    fn generation_bump_invalidates_a_session() {
        // stop_and_bump_generation with nothing running just advances the
        // counter and is safe to call repeatedly (mirrors chroma_audio_stop
        // being called on an already-silent preview / on unmount).
        let g1 = stop_and_bump_generation();
        let g2 = stop_and_bump_generation();
        assert!(g2 > g1);
        assert!(!is_current(g1));
        assert!(is_current(g2));
    }

    /// Build a throwaway one-clip-video-track `.chroma` project on disk
    /// pointing at `video_path`, and make it the open project via
    /// `state::set_project` — no Tauri runtime needed, since none of these
    /// commands take a `tauri::State`. The returned `TempDir` must be kept
    /// alive for the project directory to stay on disk; the caller is
    /// responsible for `state::set_project(None)` once done.
    fn open_test_project(video_path: &str) -> tempfile::TempDir {
        open_test_project_with_audio_track(video_path, None)
    }

    /// D-057: [`open_test_project`], optionally with a second, genuine
    /// `TrackKind::Audio` track added — `(audio_clip_source_path, gain)` —
    /// holding one clip at `start_frame: 0` covering the same position the
    /// tests below play from. This is the real fixture Phase C's own test
    /// requirement asks for: "a `Timeline` with a video track (embedded
    /// audio) + a genuine `TrackKind::Audio` track holding a real
    /// audio-bearing clip."
    fn open_test_project_with_audio_track(
        video_path: &str,
        audio_track: Option<(&str, f32)>,
    ) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("AudioTest.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let clip = chroma_timeline::Clip {
            id: "clip1".into(),
            shot_id: None,
            media_id: None,
            name: "test".into(),
            source_path: video_path.to_string(),
            source_start: 0,
            duration: 100_000, // longer than any real test clip; exact value is irrelevant here
            source_len: 100_000,
            start_frame: 0, // D-054: the only clip on its track
            ..Default::default()
        };
        let mut tracks = vec![chroma_timeline::Track {
            kind: chroma_timeline::TrackKind::Video,
            clips: vec![clip],
            gain: 1.0,
            locked: false,
            hidden: false,
            sync_locked: true,
        }];
        if let Some((audio_path, gain)) = audio_track {
            tracks.push(chroma_timeline::Track {
                kind: chroma_timeline::TrackKind::Audio,
                clips: vec![chroma_timeline::Clip {
                    id: "audio-clip1".into(),
                    shot_id: None,
                    media_id: None,
                    name: "audio-track-test".into(),
                    source_path: audio_path.to_string(),
                    source_start: 0,
                    duration: 100_000,
                    source_len: 100_000,
                    start_frame: 0, // overlaps the video clip's [0, 100_000)
                    ..Default::default()
                }],
                gain,
                locked: false,
                hidden: false,
                sync_locked: true,
            });
        }
        let timeline = chroma_timeline::Timeline {
            id: "tl1".into(),
            name: "AudioTest".into(),
            rate: None,
            tracks,
        };
        let manifest = super::super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "AudioTest".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings: Default::default(),
            timelines: vec![timeline],
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        };
        super::super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::super::state::set_project(Some(super::super::state::ProjectRef {
            path: project_dir,
            name: "AudioTest".into(),
        }));
        tmp
    }

    /// Synthesize a short pure-tone `.m4a` (AAC-in-MP4, matching this
    /// crate's `symphonia` feature set — `isomp4` + `aac`, no `wav`/`pcm`
    /// support enabled) via `ffmpeg`'s `sine` test source — a second,
    /// genuinely distinct real audio signal for the mixing tests below to
    /// sum against `CHROMA_TEST_AUDIO_VIDEO`'s content. `ffmpeg` is already a
    /// hard dependency of this repo's pipeline (`video.rs`'s own doc); there
    /// is no committed binary audio fixture in this repo (every existing
    /// audio/video test fixture is an env-var-gated real file, not something
    /// checked in — see D-050), so generating one at test time, into a
    /// tempdir, mirrors that same convention rather than adding a first
    /// binary fixture file to source control. `sample_rate` is passed
    /// explicitly so the synthesized tone can be made to match a real
    /// fixture's own rate (48 kHz for `CHROMA_TEST_AUDIO_VIDEO`, per D-050) —
    /// letting a test decode both through [`decode_mono_range`] and mix them
    /// sample-for-sample without needing `rubato` in the test itself.
    fn synth_test_tone(dir: &Path, freq_hz: u32, duration_secs: f64, sample_rate: u32) -> PathBuf {
        let out = dir.join("tone.m4a");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "sine=frequency={freq_hz}:duration={duration_secs}:sample_rate={sample_rate}"
                ),
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ac",
                "2",
            ])
            .arg(&out)
            .status()
            .expect("spawn ffmpeg to synthesize a test tone");
        assert!(status.success(), "ffmpeg tone synthesis failed");
        out
    }

    // Integration test — only runs if CHROMA_TEST_AUDIO_VIDEO points at a real
    // file with an audio stream (this repo's own real project's one shot,
    // `pexels_28808272.mp4`, has none — see D-049, and the sibling test
    // below). Calls the real `chroma_audio_play` command exactly as
    // `PreviewPane.tsx` does, and asserts the `cpal` output callback actually
    // wrote non-silent PCM — the concrete D-049 verification proxy,
    // end-to-end through the real command surface rather than only the pure
    // helpers above.
    #[test]
    fn chroma_audio_play_produces_non_silent_pcm_end_to_end() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let _tmp = open_test_project(&video_path);
        let played = chroma_audio_play(0);
        thread::sleep(Duration::from_millis(1500));
        let (rms, peak) = chroma_audio_level();
        chroma_audio_stop();
        super::super::state::set_project(None);

        played.expect("chroma_audio_play");
        eprintln!(
            "chroma_audio_play_produces_non_silent_pcm_end_to_end ({video_path}): rms={rms:.4} peak={peak:.4}"
        );
        assert!(
            peak > 0.001,
            "expected non-silent PCM out of the real cpal output stream after 1.5s of playback, got peak={peak}"
        );
    }

    // Integration test — only runs if CHROMA_TEST_SILENT_VIDEO points at a
    // real file confirmed (via `ffprobe`) to have NO audio stream — this
    // repo's own real project's shot (`pexels_28808272.mp4`) is exactly such
    // a file, found live while wiring up the sibling test above (see D-049).
    // A source with no audio must play back silently, without error — this
    // pins that "silent is correct, not a bug" behaviour.
    #[test]
    fn chroma_audio_play_on_a_source_with_no_audio_is_a_silent_no_op() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_SILENT_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_SILENT_VIDEO to run (a real file confirmed to have no audio stream)"
            );
            return;
        };

        let _tmp = open_test_project(&video_path);
        let played = chroma_audio_play(0);
        thread::sleep(Duration::from_millis(300));
        let (rms, peak) = chroma_audio_level();
        chroma_audio_stop();
        super::super::state::set_project(None);

        played.expect("chroma_audio_play should be Ok even when the source has no audio stream");
        assert_eq!(
            (rms, peak),
            (0.0, 0.0),
            "a source with no audio stream must not produce any device output"
        );
    }

    // --- D-057 (Phase C) mixing tests ---------------------------------------

    /// The deterministic core of the Phase C test requirement: decode two
    /// real, distinct audio-bearing files (`CHROMA_TEST_AUDIO_VIDEO`'s real
    /// content, and a freshly-synthesized 440 Hz tone at the same sample
    /// rate) via the same `decode_mono_range` path `chroma_audio_waveform`
    /// already uses, then mix them with `mix_sources` exactly as
    /// `run_session` does per-window — no `cpal`, no live device, no
    /// wall-clock sleep, so this is fully deterministic and asserts *exact*
    /// numeric properties on real decoded PCM rather than a live-device
    /// rms/peak proxy: the mix is genuinely the sum of both sources (not
    /// either one alone, not silence), and muting the tone (`gain == 0.0`)
    /// makes the mix identical, sample-for-sample, to the video's audio
    /// decoded alone.
    #[test]
    fn real_decoded_sources_mix_and_mute_correctly() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        // 48 kHz matches CHROMA_TEST_AUDIO_VIDEO's real fixture
        // (A001_08302215_C019.MOV, AAC 48 kHz/2ch — see D-050), so both
        // sources decode at the same native rate and can be mixed
        // sample-index-aligned without needing rubato in the test itself.
        let tone_path = synth_test_tone(tmp.path(), 440, 2.0, 48_000);

        let dur = 2.0;
        let video_mono =
            decode_mono_range(Path::new(&video_path), 0.0, dur).expect("decode video audio");
        let tone_mono = decode_mono_range(&tone_path, 0.0, dur).expect("decode synthesized tone");
        assert!(
            tone_mono.iter().any(|s| s.abs() > 0.01),
            "the synthesized tone itself must be genuinely non-silent"
        );

        let len = video_mono.len().min(tone_mono.len());
        assert!(len > 0, "both sources must decode some real samples");
        let video_mono = &video_mono[..len];
        let tone_mono = &tone_mono[..len];

        // Both active (unity gain each) — genuinely the sum, not either
        // source alone.
        let mixed = mix_sources(&[video_mono.to_vec(), tone_mono.to_vec()], &[1.0, 1.0], len);
        assert_ne!(
            mixed, video_mono,
            "mix must not just be the video's own audio"
        );
        assert_ne!(mixed, tone_mono, "mix must not just be the tone");
        assert!(
            mixed.iter().any(|s| s.abs() > 0.0),
            "mix must not be silence"
        );

        // The checkable gain property: muting the tone track (gain == 0.0)
        // must make the mix *exactly* equal to the video's audio decoded
        // alone — bit-for-bit, not approximately.
        let muted_tone = mix_sources(&[video_mono.to_vec(), tone_mono.to_vec()], &[1.0, 0.0], len);
        assert_eq!(
            muted_tone, video_mono,
            "muting the tone track (gain=0.0) must equal the video's audio alone"
        );

        // And symmetrically: muting the video track must equal the tone alone.
        let muted_video = mix_sources(&[video_mono.to_vec(), tone_mono.to_vec()], &[0.0, 1.0], len);
        assert_eq!(
            muted_video, tone_mono,
            "muting the video track (gain=0.0) must equal the tone alone"
        );
    }

    /// End-to-end through the real command surface (D-057): a genuine
    /// two-track `Timeline` — the video's embedded audio on the video track,
    /// plus a synthesized tone clip on a real `TrackKind::Audio` track
    /// (`Track::clip_at` resolving it via `resolve_audio_track_positions`,
    /// exactly what a future Phase D UI's "add an audio track" would
    /// eventually produce) — played through the real `chroma_audio_play`
    /// command, exactly as `PreviewPane.tsx` would call it. Proves the whole
    /// pipeline (timeline resolution → `run_session` opening 2 sources →
    /// real `cpal` output) actually engages for a multi-track project, using
    /// the same live-device rms/peak proxy D-050 introduced (a sandboxed
    /// agent can't literally listen — see that decision).
    #[test]
    fn chroma_audio_play_mixes_a_genuine_audio_track_with_the_video_track() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        let tone_path = synth_test_tone(tmp.path(), 440, 3.0, 48_000);

        let _project = open_test_project_with_audio_track(
            &video_path,
            Some((&tone_path.display().to_string(), 1.0)),
        );
        let played = chroma_audio_play(0);
        thread::sleep(Duration::from_millis(1500));
        let (rms, peak) = chroma_audio_level();
        chroma_audio_stop();
        super::super::state::set_project(None);

        played.expect("chroma_audio_play with a video track + a genuine audio track");
        eprintln!(
            "chroma_audio_play_mixes_a_genuine_audio_track_with_the_video_track: rms={rms:.4} peak={peak:.4}"
        );
        assert!(
            peak > 0.001,
            "expected non-silent mixed PCM out of the real cpal output stream, got peak={peak}"
        );
    }

    /// The same two-track project as above, but the audio track's gain is
    /// `0.0` — end-to-end proof that `Track::gain` really reaches the mixer:
    /// still non-silent (the video's own audio still plays), but this is
    /// the live-device sibling of `real_decoded_sources_mix_and_mute_correctly`'s
    /// exact, deterministic version of the same property.
    #[test]
    fn chroma_audio_play_with_a_muted_audio_track_still_plays_the_video() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let tmp = tempfile::tempdir().expect("tempdir");
        let tone_path = synth_test_tone(tmp.path(), 440, 3.0, 48_000);

        let _project = open_test_project_with_audio_track(
            &video_path,
            Some((&tone_path.display().to_string(), 0.0)),
        );
        let played = chroma_audio_play(0);
        thread::sleep(Duration::from_millis(1500));
        let (_rms, peak) = chroma_audio_level();
        chroma_audio_stop();
        super::super::state::set_project(None);

        played.expect("chroma_audio_play with a muted audio track");
        assert!(
            peak > 0.001,
            "the video's own audio must still play even with the audio track muted, got peak={peak}"
        );
    }

    // Integration test (D-051) — real symphonia decode + bucket reduction,
    // gated on the same CHROMA_TEST_AUDIO_VIDEO fixture the D-050 playback
    // test uses (a real file confirmed to have an audio stream).
    // `chroma_audio_waveform` takes a bare source path — no open project
    // needed, unlike `chroma_audio_play`.
    #[test]
    fn chroma_audio_waveform_returns_nonflat_peaks_for_a_real_file() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };

        let peaks = waveform_peaks(&video_path, 0.0, 2.0, 100).expect("waveform_peaks");
        assert_eq!(peaks.len(), 100, "requested bucket count must be honoured");
        assert!(
            peaks.iter().any(|(lo, hi)| *hi > *lo || *hi != 0.0),
            "expected at least some non-silent peaks decoding 2s of {video_path}"
        );
    }

    // A source confirmed to have NO audio stream (CHROMA_TEST_SILENT_VIDEO,
    // same fixture the D-050 silent-playback test uses) must return an empty
    // peaks Vec, not an error — mirrors chroma_timeline_frame's blank-frame
    // "nothing to draw" contract.
    #[test]
    fn chroma_audio_waveform_on_a_silent_source_is_an_empty_ok() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_SILENT_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_SILENT_VIDEO to run (a real file confirmed to have no audio stream)"
            );
            return;
        };

        let peaks = waveform_peaks(&video_path, 0.0, 2.0, 100).expect("waveform_peaks");
        assert_eq!(peaks, Vec::new());
    }

    #[test]
    fn chroma_audio_waveform_zero_duration_or_buckets_is_an_empty_ok_without_touching_disk() {
        // a nonexistent path proves this returns early on the duration_secs/
        // buckets guard rather than attempting to open/probe it.
        assert_eq!(
            waveform_peaks("/nonexistent/path.mp4", 0.0, 0.0, 100).unwrap(),
            Vec::new()
        );
        assert_eq!(
            waveform_peaks("/nonexistent/path.mp4", 0.0, 2.0, 0).unwrap(),
            Vec::new()
        );
    }
}
