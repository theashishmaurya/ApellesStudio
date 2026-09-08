//! Editor-tab audio playback (D-049) — `symphonia` decode → `rubato` resample
//! → `dasp_sample` format-convert → `cpal` device output, synced to the same
//! playhead the video preview (`chroma::edit` / [`crate::decode_pipe`])
//! already tracks.
//!
//! ## The one thing that did NOT move here (D-146)
//!
//! Moved out of `app/src-tauri/src/chroma/audio.rs` in D-146
//! (`docs/notes/crate-extraction-plan.md` §2.2) — but deliberately **not
//! whole**. The engine is media; *"which clip is under this timeline frame"*
//! is not. The original [`play`] resolved its sources through
//! `chroma::edit::resolve_video_position` / `resolve_audio_track_positions`,
//! i.e. timeline resolution, which sits a layer above this one (and belongs
//! to `chroma-compositor` when that becomes real, plan §2.8). So the split is:
//!
//! - **here:** the whole session protocol ([`begin_play`], [`stop`], the
//!   generation/`seq` ordering), the decode → resample → mix → `cpal` engine
//!   ([`start`], `run_session`), the waveform path ([`waveform`]), and
//!   [`AudioSourceSpec`] — "a file, a source second, an out-point, a gain."
//! - **`app/src-tauri/src/chroma/audio.rs`:** the five `#[tauri::command]`
//!   wrappers, and the body of `chroma_audio_play` that turns a timeline
//!   frame into a `Vec<AudioSourceSpec>`.
//!
//! The ordering that matters is preserved exactly: [`begin_play`] stamps
//! `requested_at` and claims the session *before* the caller resolves its
//! sources, so the resolution cost is still inside the skew `run_session`
//! measures and compensates for (D-125).
//!
//! What it is: a persistent, Rust-owned audio pipeline for the Edit tab's
//!   `<Player>` preview — real device audio during Play, run entirely
//!   independently of the existing wall-clock-driven video `rAF` loop
//!   (`PreviewPane.tsx`) rather than coupled to it frame-by-frame. See the
//!   "sync model" note below for why.
//! What it does: given the sources active at a playhead — the video track's
//!   own embedded audio, gated on [`crate::video::VideoInfo::has_audio`],
//!   **plus** (D-057, Phase C — see below) any clip on a genuine
//!   `TrackKind::Audio` track overlapping that position — [`start`] spawns one
//!   dedicated OS thread that: opens every source with `symphonia`, seeks each
//!   to its matching source time, decodes packets from all of them in
//!   lockstep, adapts channel count and resamples each to the output device's
//!   config (`rubato`) as needed, sums them with per-track gain and headroom
//!   handling ([`mix_sources`]), bit-depth-converts the mixed result to
//!   whatever `cpal`'s chosen output `SampleFormat` is (`dasp_sample`), and
//!   feeds a bounded ring buffer that the `cpal` output callback drains.
//!   [`stop`] tears the session down (pause / re-seek / unmount).
//!   [`level`] exposes the last measured RMS/peak of what the
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
//!   gap mid-session won't be picked up until the next Play/seek; each source
//!   does stop dead at its own clip's out-point rather than running on into the
//!   rest of the file, B-048), or long-session drift correction between the
//!   audio and video clocks (see below).
//!
//! ## Waveform extraction (D-051 — the mature timeline UI pass)
//!
//! [`waveform`] is a second, unrelated-at-runtime feature bolted
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
//! [`start`] is called at that exact same transition — and then
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
//! [`start`] was called, discards exactly that much audio from the
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
//! ### Request ordering (D-130 — the follow-up D-125 made necessary)
//!
//! Everything above assumes the transport commands happen in the order the
//! frontend issued them: the pause's `chroma_audio_stop` before the resume's
//! `chroma_audio_play`, and the newest play last. That was free while both were
//! plain `#[tauri::command]`s running inline on Tauri's main thread; D-125's
//! `(async)` turned each invoke into its own `tokio::spawn`ed task on a
//! multi-threaded runtime, which orders nothing. Both commands now carry a
//! monotonic `seq` stamped by the frontend at issue time and drop anything
//! already overtaken — see [`begin_request`] for the full reasoning and B-047
//! for what it looked like when they raced.
//!
//! ### Starting where you asked (D-133 — the container seek cannot be trusted)
//!
//! Everything above also assumes a session that is told to start at second N
//! *starts at second N*. Until D-133 that rested entirely on one ignored
//! `Result`: both [`open_source`] and [`decode_mono_range`] asked `symphonia`
//! to seek and then discarded the outcome, on the reasoning that "worst case
//! playback starts from wherever the reader already is."
//!
//! On the owner's real camera original that worst case is what happens on
//! **every** play, and "wherever the reader already is" means **the start of
//! the file** — so every Play, at any playhead, replayed the take from 0:00
//! while the picture carried on correctly from the playhead (the video preview
//! seeks through `ffmpeg`, which has no such problem). That is B-052's
//! "play and pause restart the audio, just audio."
//!
//! The cause is upstream and measured, not inferred: see [`StartTrim`] for the
//! `symphonia-format-isomp4` behaviour, the property of the file that trips it,
//! and the cost of the fix. Sources now reach their start time by **trimming on
//! the packets' own timestamps** ([`packet_skip`] / [`StartTrim`]), which is
//! correct whether the container's seek succeeded, failed, or landed early, and
//! the seek itself is kept only as the fast path — with its failure logged
//! rather than swallowed.
//!
//! ## Multi-track mixing (D-057, Phase C of `docs/notes/multi-track-nle.md`)
//!
//! D-049/D-050 (above) deliberately did not populate `chroma-timeline`'s
//! `TrackKind::Audio` — nothing yet needed a second, genuinely audio-only
//! source. This module now reads one when it exists
//! (`chroma::edit::resolve_audio_track_positions`), while leaving the
//! baseline video-embedded-audio path from D-050 completely intact as the
//! default/first source. When D-057 landed, nothing in the app populated an
//! `Audio` track at all — it was the mixing *capability* only, exercised in
//! this module's own tests via a hand-built `Timeline`, same spirit as D-054
//! landing `add_track`/`move_clip` before any UI called them.
//!
//! **D-129 changed that: the app really does populate audio tracks now.**
//! Dropping a video clip whose source has an audio stream creates a linked
//! audio `Clip` beside it (`docs/notes/av-linking.md`), so this mixer's
//! audio-track path is the live, everyday path for that clip's sound — and
//! that video clip's own embedded stream is deliberately **skipped**, or the
//! same audio would be summed with itself. See [`start`] and
//! `chroma_timeline::Clip::link_group`. Clips that predate D-129 have no
//! link group and keep the unchanged D-050 embedded path.
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

use chroma_types::{Biquad, BiquadCoeffs, EaseCurve, EqBand};
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

/// What to do with one packet while a source is still working its way forward
/// to the exact source time it was asked to start at (B-052 / D-133) — see
/// [`StartTrim`] for why that is done by packet timestamp rather than by
/// trusting the container's own seek.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PacketSkip {
    /// Every frame in this packet is before the target — drop the whole packet
    /// without decoding it at all.
    DropWhole,
    /// The packet straddles the target — decode it, then drop this many
    /// **source frames** off the front. Never zero (a packet starting exactly
    /// at the target is [`PacketSkip::Arrived`]).
    DropFrames(usize),
    /// The packet starts at or after the target — the source has arrived;
    /// nothing to trim on this packet or any later one.
    Arrived,
}

/// Classify one packet against the source time the session asked to start at.
/// `packet_secs` is the packet's presentation time and `packet_dur_secs` its
/// duration, both in real seconds; `src_rate` is the source's own sample rate,
/// so the frame count returned is in **source** frames — before channel
/// adaptation and resampling, which is where [`DecodedSource::ensure`] applies
/// it. Pure — no I/O.
///
/// Non-finite input, or a target at or behind the packet, is "arrived":
/// playing a few extra milliseconds is always the better failure than silently
/// discarding audio over a value that could not be interpreted.
pub(crate) fn packet_skip(
    packet_secs: f64,
    packet_dur_secs: f64,
    target_secs: f64,
    src_rate: u32,
) -> PacketSkip {
    if !packet_secs.is_finite() || !target_secs.is_finite() || packet_secs >= target_secs {
        return PacketSkip::Arrived;
    }
    let dur = if packet_dur_secs.is_finite() {
        packet_dur_secs.max(0.0)
    } else {
        0.0
    };
    if packet_secs + dur <= target_secs {
        return PacketSkip::DropWhole;
    }
    let frames = ((target_secs - packet_secs) * src_rate as f64)
        .round()
        .max(0.0) as usize;
    if frames == 0 {
        PacketSkip::Arrived
    } else {
        PacketSkip::DropFrames(frames)
    }
}

/// Reduce mono `samples` to `bucket_count` (min, max) peak pairs — the
/// amplitude envelope [`waveform`] returns for `Waveform.tsx` to
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
/// audio source in a [`start`] session) into one buffer, each
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
    /// Highest frontend request sequence accepted so far (D-130). Every
    /// [`start`] / [`stop`] carries the `seq` the
    /// frontend stamped it with *at the moment it was issued*; anything at or
    /// below this has been overtaken by a newer request and is dropped. This
    /// is what makes the two commands order-insensitive now that Tauri no
    /// longer runs them in issue order — see [`begin_request`].
    last_seq: u64,
    join: Option<thread::JoinHandle<()>>,
}

static SESSION: Lazy<Mutex<AudioSession>> = Lazy::new(|| {
    Mutex::new(AudioSession {
        generation: 0,
        last_seq: 0,
        join: None,
    })
});

/// Last-measured (rms, peak) of what the `cpal` output callback actually
/// wrote, updated roughly once a second of played audio. `(0.0, 0.0)` before
/// any playback or once a session stops — the verification hook for D-049
/// (see [`level`]); not wired to any meter UI.
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

/// `pub(crate)` since D-232: [`crate::scrub`]'s own thread checks the exact
/// same generation, because a scrub is a request on THIS transport rather than
/// a parallel one — see that module's doc.
pub(crate) fn is_current(my_gen: u64) -> bool {
    SESSION.lock().unwrap_or_else(|e| e.into_inner()).generation == my_gen
}

/// [`is_current`], reachable from `app/src-tauri`'s own transport-ordering
/// tests (D-146). Those tests drive the real `chroma_audio_play`/
/// `chroma_audio_stop` commands, which stayed app-side, so they are on the
/// other side of a crate boundary from the session state they assert on.
/// Behind `test-support`, enabled only from `[dev-dependencies]`.
#[cfg(any(test, feature = "test-support"))]
pub fn session_is_current(my_gen: u64) -> bool {
    is_current(my_gen)
}

/// [`begin_request`], same reason as [`session_is_current`].
#[cfg(any(test, feature = "test-support"))]
pub fn session_begin_request(seq: u64) -> Option<u64> {
    begin_request(seq)
}

/// The generation and the newest accepted request stamp — for tests to assert
/// that a stale command really was dropped rather than acted on. Test-only:
/// nothing in the running app needs to ask, and the house rule is no dead code
/// shipped "just in case". Behind `test-support` rather than `#[cfg(test)]`
/// since D-146 — same reason as [`session_is_current`].
#[cfg(any(test, feature = "test-support"))]
pub fn session_snapshot() -> (u64, u64) {
    let guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    (guard.generation, guard.last_seq)
}

/// Claim `seq` as the newest audio-transport request and tear down whatever
/// session is running, returning the new generation — or `None` if a **newer**
/// request has already been accepted, in which case this one is stale and must
/// do nothing at all (B-047 / D-130).
///
/// **Why this exists.** The play/stop protocol has always rested on one
/// invariant: the commands run in the order the frontend issued them. Until
/// D-125 that was free — both were plain `#[tauri::command]`, i.e.
/// `ExecutionContext::Blocking`, which Tauri runs inline on the main thread as
/// it drains IPC messages, so they were strictly FIFO *and* mutually exclusive.
/// D-125 changed both to `#[tauri::command(async)]` to keep a pause's thread
/// join off the main thread; for a synchronous `fn` that expands (read from
/// `tauri-macros-2.6.3`'s `command/wrapper.rs` → `tauri-2.11.5`'s
/// `ipc::InvokeResolver::respond_async_serialized`) to
/// `async_runtime::spawn(..)` → `tokio::spawn` on the **multi-threaded**
/// runtime. Two invokes issued back to back therefore become two independent
/// tasks with no ordering and no mutual exclusion, and the invariant the
/// protocol depends on silently disappeared.
///
/// Restoring it by reverting to `Blocking` would put the join back on the main
/// thread — the very thing D-125 fixed — and would leave the invariant implicit
/// and untested, exactly the shape of thing that broke here. So the ordering is
/// made **explicit** instead: the frontend stamps every request with a
/// monotonic sequence number at the instant it issues it (the same
/// request-token pattern `timelineStore.ts`'s `load()` already uses for the
/// same class of bug — B-034/D-112), and this function drops anything that has
/// been overtaken. Both commands become idempotent and order-insensitive, so it
/// no longer matters which tokio worker picks up which task first.
fn begin_request(seq: u64) -> Option<u64> {
    let (my_gen, old_join) = {
        let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        if seq <= guard.last_seq {
            log::debug!(
                "chroma audio: dropping stale request seq={seq} (newest accepted is {})",
                guard.last_seq
            );
            return None;
        }
        guard.last_seq = seq;
        guard.generation += 1;
        (guard.generation, guard.join.take())
    };
    if let Some(j) = old_join {
        let _ = j.join();
    }
    *LEVEL.lock().unwrap_or_else(|e| e.into_inner()) = (0.0, 0.0);
    Some(my_gen)
}

/// [`begin_request`] under the name the OTHER transport mode calls it by
/// (D-232). [`crate::scrub::begin`] claims this same single transport — that is
/// the whole reason a scrub and a play can never sound at once, with no second
/// protocol and no new invariant. Named rather than exposed as `begin_request`
/// so a reader of `scrub.rs` sees "claim the session", not a function whose doc
/// is entirely about play/stop ordering.
pub(crate) fn session_claim(seq: u64) -> Option<u64> {
    begin_request(seq)
}

/// Hand the session the thread handle for generation `my_gen`, so the NEXT
/// [`begin_request`] joins it before starting anything of its own — exactly
/// what [`start`] does for a play session, and for exactly the same reason: the
/// outgoing thread owns an open `cpal` output stream, and two of those alive at
/// once is a real, device-dependent hazard rather than merely untidy.
/// `pub(crate)` for [`crate::scrub::start`], which spawns the other kind of
/// thread this transport owns (D-232).
///
/// Installs nothing if `my_gen` has already been superseded — that handle is
/// then just orphaned bookkeeping (the thread still exits promptly on its own
/// via [`is_current`]), and overwriting a newer session's handle with it would
/// lose the one that actually needs joining.
pub(crate) fn session_install_join(my_gen: u64, handle: thread::JoinHandle<()>) {
    let mut guard = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if guard.generation == my_gen {
        guard.join = Some(handle);
    }
}

// --------------------------------------------------------------------------- //
// the transport entry points — each wrapped one-for-one by a
// `#[tauri::command]` in `app/src-tauri/src/chroma/audio.rs` (commands do not
// move; `docs/notes/crate-extraction-plan.md` §1)
// --------------------------------------------------------------------------- //

/// Stop whatever is currently playing (or a no-op if nothing is). Called on
/// pause and on unmount; also called implicitly by [`begin_play`]
/// before it starts a new session.
///
/// The wrapping command is `#[tauri::command(async)]` (D-125): this joins the
/// audio thread, which can take up to one of its poll intervals — that must
/// not happen on Tauri's main thread, where it would stall the window and
/// every other in-flight command. `(async)` on a synchronous `fn` is Tauri's
/// own "run this command off the main thread" mechanism, and keeps this
/// function directly callable from tests.
///
/// `seq` (D-130) is the frontend's monotonic request stamp — a stop that has
/// already been overtaken by a newer play/stop is dropped rather than killing
/// the session that superseded it. See [`begin_request`] for why that is
/// necessary rather than paranoid.
pub fn stop(seq: u64) {
    begin_request(seq);
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
pub fn set_volume(volume: f32) {
    let clamped = volume.clamp(0.0, 1.0);
    MASTER_VOLUME_BITS.store(clamped.to_bits(), std::sync::atomic::Ordering::Relaxed);
}

/// One audio source for a play session (D-057) — a source path, the source
/// second to start decoding from, and the linear gain to scale its
/// contribution by in the final mix (see [`mix_sources`]). Built once per
/// [`start`] call from whatever's active at `start_frame`; not
/// re-resolved mid-session (matches D-050's own "no re-seek mid-play" design
/// — see the module doc).
///
/// `pub` with `pub` fields since D-146: the caller that *builds* these is
/// `app/src-tauri`'s `chroma_audio_play`, because building one means resolving
/// the timeline, which this crate deliberately cannot do. This type is exactly
/// the boundary between the two — "a file, a source second, an out-point, a
/// gain" is a media fact; "which clip is under frame 1234" is not.
pub struct AudioSourceSpec {
    pub path: PathBuf,
    pub start_secs: f64,
    /// How much of the source this clip actually covers, measured forward from
    /// `start_secs` — the clip's **out-point** in source seconds (B-048 /
    /// D-130). Past it the source contributes silence, not the file's next few
    /// seconds: those belong to some other part of the timeline (or to nothing
    /// at all), and playing them is playing media the picture is not showing.
    /// `None` only when the clip's own length is unknown, which no caller
    /// produces today.
    pub duration_secs: Option<f64>,
    pub gain: f32,
    /// D-147 — this clip's fade in/out envelope, or `None` when the clip has
    /// no fade configured (every clip in every pre-D-147 project). `None` is
    /// not merely "an envelope that returns 1.0": [`mix_chunk`] skips the
    /// per-sample pass entirely for it, so the un-faded mix runs the exact
    /// same arithmetic it did before this field existed.
    ///
    /// Seconds, like `start_secs`/`duration_secs` above and for the same
    /// reason: a fade window measured in seconds is a media fact, whereas the
    /// clip's fade *frames* are not. The caller converts, in `app/src-tauri`'s
    /// `chroma::audio::fade_for_clip`.
    pub fade: Option<FadeEnvelope>,
    /// D-149 — this source's track-level ducking envelope, or `None` when its
    /// track has no `duck_from` set (every track in every pre-D-149 project).
    /// `None` is not "an envelope that returns 1.0": with both this and
    /// [`Self::fade`] absent, [`mix_chunk`] skips the per-sample pass entirely,
    /// so the un-ducked, un-faded mix runs exactly the arithmetic it always
    /// did.
    ///
    /// Seconds, and already resolved against the trigger track's clip layout,
    /// for the same reason `fade` is: which frames another track has clips on
    /// is a timeline fact, and the crate that mixes audio deliberately cannot
    /// see a timeline. The caller converts, in `app/src-tauri`'s
    /// `chroma::audio::duck_for_track`.
    pub duck: Option<DuckEnvelope>,
    /// D-223 — this clip's OWN volume and stereo pan, or `None` when it is at
    /// unity and centred (every clip in every pre-D-223 project, and the
    /// common case now). `None` is not "an envelope that returns 1.0": with
    /// this, [`Self::fade`] and [`Self::duck`] all absent, [`mix_chunk`] skips
    /// the per-sample pass entirely, so that mix runs exactly the arithmetic it
    /// always did.
    ///
    /// Distinct from `gain` above rather than folded into it, even though the
    /// static, un-panned case *could* be one multiplication: `gain` is the
    /// TRACK's fader, this is the CLIP's own level, they compose by
    /// multiplication, and either can be keyframed or panned independently of
    /// the other. Collapsing them here would make the mixer unable to say
    /// which of the two a level came from — and would silently lose the pan,
    /// which is not a scalar at all.
    ///
    /// Clip-local seconds, like `fade`, and for the same reason: turning a
    /// clip's keyframe *frames* into seconds needs a `chroma_timeline::Clip`
    /// and its probed rate, which this crate deliberately cannot see. The
    /// caller converts, in `app/src-tauri`'s `chroma::audio::level_for_clip`.
    pub level: Option<LevelEnvelope>,
    /// D-224 — this clip's own parametric-EQ bands, or **empty** when it has
    /// none (every clip in every pre-D-224 project, and the common case now).
    /// Empty is not "a band set that does nothing": with it, and no fade, duck
    /// or level, [`mix_chunk`] skips the per-sample pass entirely, so that mix
    /// runs exactly the arithmetic it always did.
    ///
    /// **The BANDS, not a built filter**, unlike the three envelopes above:
    /// biquad coefficients depend on the sample rate, and this struct is
    /// constructed by `app/src-tauri`'s `chroma_audio_play` before
    /// [`run_session`] has opened the device and learned it. [`EqFilter`] is
    /// therefore built inside `run_session`, at the real `out_rate` and with
    /// one cascade per real output channel.
    ///
    /// Carried verbatim from `chroma_timeline::Clip::eq_bands` — no conversion
    /// at all, which is why there is no `eq_for_clip` beside `fade_for_clip`
    /// and `level_for_clip`: a band is already in the only units it has
    /// (hertz, decibels, Q), none of which are frames.
    pub eq_bands: Vec<chroma_types::EqBand>,
    /// D-242 — this clip's SPEED RAMP, as the runs still ahead of the
    /// playhead, or **empty** when it plays at its recorded rate (every clip in
    /// every pre-D-236 project, and the common case now). Empty is not "a ramp
    /// that does nothing": [`open_source`] attaches no [`Retime`] stage at all
    /// for it, so an un-ramped source decodes through exactly the arithmetic it
    /// always did — no interpolation, no extra buffer, not one added
    /// multiplication in the hot loop.
    ///
    /// **Seconds relative to [`Self::start_secs`]**, like [`Self::fade`] and
    /// for the same reason: turning a clip's speed *frames* into seconds needs
    /// a `chroma_timeline::Clip` and its probed rate, which this crate
    /// deliberately cannot see. The caller converts, in `app/src-tauri`'s
    /// `chroma::audio::speed_for_clip` — the exact mirror of `@chroma/editor`'s
    /// `rampSegmentSeconds`, which is what the EXPORT compiles its
    /// `atrim`/`atempo`/`areverse` chain from.
    ///
    /// **When this is non-empty, [`Self::start_secs`] and
    /// [`Self::duration_secs`] each mean the one thing they always meant, but
    /// the two stop being the same number.** `start_secs` is where the source
    /// window OPENS — the lowest source second this session will read, which
    /// under a reversed run is *ahead* of the playhead in the file rather than
    /// under it, because symphonia decodes forwards and the retime plays that
    /// buffer backwards. `duration_secs` is, as ever, how many OUTPUT seconds
    /// this source contributes; for an un-retimed source one source second is
    /// one output second, which is why the distinction never had to be drawn
    /// before.
    pub speed: Vec<AudioSpeedSegment>,
}

/// One constant-speed run of a clip's ramp, as the live mixer takes it
/// (D-242). The exact counterpart of `@chroma/editor`'s
/// `SpeedSegmentSeconds`, which is what the exporter builds its per-segment
/// `atrim`/`atempo`/`areverse` chain from — the two are the same list, handed
/// to two different renderers, which is this feature's whole preview/export
/// parity argument.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioSpeedSegment {
    /// Inclusive, in SOURCE seconds relative to [`AudioSourceSpec::start_secs`].
    pub start_secs: f64,
    /// Exclusive, same axis.
    pub end_secs: f64,
    /// Source seconds consumed per output second. **Negative plays this run
    /// backwards** (D-241); its output length is `(end - start) / |speed|`
    /// either way.
    pub speed: f64,
}

/// One clip's fade envelope, in **seconds** (D-147).
///
/// Seconds, matching [`AudioSourceSpec`]'s own unit, because the envelope is
/// built by the caller — before [`run_session`] has opened the device and
/// learned its sample rate. The seconds→samples conversion happens once per
/// chunk in [`Self::apply`], which is handed the rate.
///
/// **Evaluated per sample-frame, not per video frame or per chunk.** A chunk is
/// 1024 frames ≈ 21 ms at 48 kHz, and a video frame is 21–42 ms; stepping a
/// gain envelope at either granularity is a staircase, and a staircase on a
/// gain envelope is audible zipper noise. Every channel of one sample-frame
/// shares one gain, as any real mixer does.
///
/// The evaluation is [`chroma_types::fade_gain`] — the same pure function
/// `chroma::edit`'s compositor reaches (via
/// `chroma_timeline::Clip::fade_multiplier_at`) for opacity. One curve model,
/// one implementation, no second copy of the bezier solve. That shared
/// function sits in L0 `chroma-types` precisely so this L1 crate can call it
/// without depending on the L2 timeline model — see that module's doc, and
/// `docs/notes/audio-fade-duck-crossfade-plan.md` §6b.
///
/// **Deliberately shaped as "a gain multiplier at position N", not as
/// fade-specific arithmetic inlined into the mixer.** Ducking (that doc's §4)
/// needs exactly this interface with a different function behind it, and this
/// is the seam it will reuse — the one thing this pass owed a feature it
/// deliberately did not build.
///
/// `pub` with `pub` fields for the same reason [`AudioSourceSpec`] is: the
/// caller that builds one is `app/src-tauri`, because building one means
/// reading a timeline clip, which this crate deliberately cannot do.
#[derive(Debug, Clone)]
pub struct FadeEnvelope {
    /// Seconds from the CLIP's own in-point to the first sample this session
    /// produces. Non-zero whenever playback starts mid-clip — what makes
    /// pressing Play halfway down a fade-out start halfway down it, rather
    /// than at the top of it.
    pub offset_secs: f64,
    /// The clip's full length, in seconds.
    pub len_secs: f64,
    pub fade_in_secs: f64,
    pub fade_out_secs: f64,
    pub in_curve: EaseCurve,
    pub out_curve: EaseCurve,
}

impl FadeEnvelope {
    /// The gain `session_secs` into this playback session.
    pub fn gain_at(&self, session_secs: f64) -> f32 {
        chroma_types::fade_gain(
            self.offset_secs + session_secs,
            self.len_secs,
            self.fade_in_secs,
            self.fade_out_secs,
            &self.in_curve,
            &self.out_curve,
        ) as f32
    }
}

/// Convert a decibel offset to the linear multiplier the mixer actually uses.
/// `0 dB` is exactly `1.0` (checked, not merely approximated: `powf(0.0)` is
/// exactly 1.0), `-6 dB` ≈ 0.501, `-∞` would be silence.
///
/// **This is the one place the dB/linear boundary is crossed.**
/// `chroma_timeline::Track::gain` is linear because it is a fader; `Track::
/// duck_db` is decibels because a duck *amount* is the number editors state in
/// dB. Storing each in the unit its own UI speaks, and converting once here at
/// the point of use, is the same discipline `crop_pixel_rect` follows for
/// normalised insets → pixels. Pure — no I/O.
pub(crate) fn db_to_linear(db: f64) -> f64 {
    if !db.is_finite() {
        return 1.0;
    }
    10f64.powf(db / 20.0)
}

/// Floor on a one-pole time constant, in seconds (D-149). A user-supplied
/// `0 ms` attack is a legitimate "as fast as you can" request, but `exp(-0/0)`
/// is `NaN`; flooring τ here keeps [`DuckEnvelope`]'s closed form free of a
/// special case while being far faster than one output sample-frame
/// (1 µs vs. ≈21 µs at 48 kHz), i.e. genuinely instantaneous in the only terms
/// the mixer can express.
const MIN_DUCK_TAU_SECS: f64 = 1e-6;

/// One piecewise segment of the smoothed presence signal (D-149): from `t0`
/// seconds onward it decays exponentially from `entry` toward `target`.
#[derive(Debug, Clone, Copy)]
struct DuckSegment {
    /// Session second this segment begins at. Segments are sorted and the
    /// first is always `0.0`.
    t0: f64,
    /// Where the smoother is heading: `1.0` while the trigger track sounds,
    /// `0.0` while it does not.
    target: f64,
    /// The smoothed value at `t0` — the previous segment's value carried
    /// forward, which is what makes the envelope continuous across every
    /// boundary (and therefore click-free).
    entry: f64,
    /// The time constant governing this segment: attack while `target == 1.0`
    /// (the duck engaging), release while it is `0.0` (the gain returning).
    tau: f64,
}

/// One ducked source's track-level ducking envelope (D-149).
///
/// **The same interface `FadeEnvelope` established, with a different function
/// behind it** — "give me a gain multiplier at position N," evaluated per
/// output sample-frame and multiplied into the source's own buffer before
/// [`mix_sources`] sees it. That was the one thing D-147 owed this feature, and
/// this is it being collected rather than a parallel mechanism being invented
/// (`docs/notes/audio-fade-duck-crossfade-plan.md` §4a).
///
/// ## Trigger detection: the model, not the signal
///
/// The trigger is a pure timeline-model query — *does the nominated track have
/// a clip covering this frame?* — resolved app-side into the session-relative
/// second spans this type is constructed from. Exact, deterministic, free, no
/// decode and no analysis, and it is what an editor means when they point at a
/// track and say "duck under this." Real RMS sidechain detection (so a pause
/// mid-sentence lets the bed back up) is a Phase 2 refinement that should reuse
/// the `waveform` peaks `media_cache` already holds; it is deliberately not
/// this.
///
/// ## The smoother: a one-pole, in closed form
///
/// A raw presence signal is a step function, and a step on a gain envelope is
/// an audible click at every clip boundary. The standard fix is a one-pole
/// smoother with separate attack and release time constants — fast attack so
/// the duck is down before the first word, slow release so the bed does not
/// pump between words.
///
/// The discrete one-pole is `y += a·(x − y)` with `a = 1 − e^(−1/(τ·fs))`.
/// Because the presence input here is **piecewise constant** with finitely many
/// transitions, that recursion has an exact closed form on each piece:
///
/// ```text
/// y(t) = target + (entry − target) · e^(−(t − t₀)/τ)
/// ```
///
/// so the whole envelope is precomputed as a short list of [`DuckSegment`]s
/// (one per transition, each carrying the value the previous segment ended on)
/// and evaluated by binary search plus one `exp`. Two reasons that is better
/// than running the recursion per sample:
///
/// 1. **It is sample-rate independent.** A recursion stepped at the device's
///    rate gives subtly different numbers at 44.1 kHz and 48 kHz; the closed
///    form gives the same envelope on every device, which is the determinism
///    invariant this project holds itself to. ([`tests::the_closed_form_is_the_
///    one_pole_recursion`] pins the two against each other so the claim is
///    checked rather than asserted.)
/// 2. **It is stateless**, so `gain_at` is a pure function of `(self, t)` —
///    evaluable out of order, testable without a session, and unaffected by
///    where a chunk boundary happens to fall.
///
/// **Starting mid-trigger is handled by construction**: the first segment's
/// `entry` equals its own `target`, i.e. the smoother begins in the steady
/// state for whatever is happening at the playhead. Pressing Play in the middle
/// of a line of dialogue starts fully ducked rather than ramping in — the same
/// property `FadeEnvelope::offset_secs` gives a mid-clip fade.
///
/// `pub` with a private field set, unlike [`FadeEnvelope`]: the segment list is
/// *derived*, not authored, and letting a caller write one directly would let
/// the `entry` chain go inconsistent with the taus. [`Self::new`] is the only
/// way to build one, and it takes exactly the numbers a caller has.
#[derive(Debug, Clone)]
pub struct DuckEnvelope {
    segments: Vec<DuckSegment>,
    /// The linear gain to reach while fully ducked — `db_to_linear(duck_db)`.
    ducked_gain: f64,
}

impl DuckEnvelope {
    /// Build the envelope for one ducked source, or `None` when it provably
    /// cannot change anything — no trigger spans in this session's range, or a
    /// `0 dB` duck. `None` matters: it is what keeps a track with ducking
    /// configured-but-inert on the same byte-identical mix path as one with no
    /// ducking at all (see [`AudioSourceSpec::duck`]).
    ///
    /// `trigger_spans` are `[start, end)` **session-relative seconds** on the
    /// trigger track, sorted and non-overlapping (which is what
    /// `chroma_timeline::Track::clip_spans_from` returns, merged, before the
    /// caller converts frames to seconds). A span reaching back before the
    /// playhead is clipped to `0.0`, which is how "Play pressed mid-dialogue"
    /// arrives here.
    ///
    /// `duck_db` is the signed dB offset while triggered; `attack_ms` /
    /// `release_ms` are the one-pole time constants (63.2% times — see the type
    /// doc), floored at [`MIN_DUCK_TAU_SECS`] so `0` means "instant" rather
    /// than `NaN`. Non-finite input degrades to the unset behaviour rather than
    /// poisoning the mix, matching `chroma_types::fade_gain`'s own posture.
    pub fn new(
        trigger_spans: &[(f64, f64)],
        duck_db: f32,
        attack_ms: f32,
        release_ms: f32,
    ) -> Option<Self> {
        let duck_db = if duck_db.is_finite() {
            duck_db as f64
        } else {
            0.0
        };
        if duck_db == 0.0 {
            return None; // unity — nothing to apply
        }
        let tau = |ms: f32| {
            let s = if ms.is_finite() {
                ms as f64 / 1000.0
            } else {
                0.0
            };
            s.max(MIN_DUCK_TAU_SECS)
        };
        let attack_tau = tau(attack_ms);
        let release_tau = tau(release_ms);

        // Presence transitions, in order. Spans are already sorted, merged and
        // non-overlapping, so pushing (start → 1) then (end → 0) per span
        // yields a strictly alternating, time-ordered target signal.
        let mut points: Vec<(f64, f64)> = Vec::with_capacity(trigger_spans.len() * 2 + 1);
        for &(s, e) in trigger_spans {
            if !s.is_finite() || !e.is_finite() || e <= 0.0 || e <= s {
                continue; // entirely behind the playhead, or empty
            }
            points.push((s.max(0.0), 1.0));
            points.push((e, 0.0));
        }
        if points.is_empty() {
            return None; // the trigger track never sounds in this session
        }
        // A session that starts *outside* a trigger clip opens un-ducked; one
        // that starts inside it already has a (0.0, 1.0) point from the clip
        // above, so there is nothing to prepend.
        if points[0].0 > 0.0 {
            points.insert(0, (0.0, 0.0));
        }

        // Chain the segments: each one enters at whatever value the previous
        // one had reached, which is what makes the envelope continuous.
        let mut segments: Vec<DuckSegment> = Vec::with_capacity(points.len());
        // The first segment starts in its own steady state — see the type doc.
        let mut entry = points[0].1;
        for (i, &(t0, target)) in points.iter().enumerate() {
            let seg_tau = if target >= 0.5 {
                attack_tau
            } else {
                release_tau
            };
            segments.push(DuckSegment {
                t0,
                target,
                entry,
                tau: seg_tau,
            });
            if let Some(&(next_t, _)) = points.get(i + 1) {
                entry = decay(entry, target, (next_t - t0).max(0.0), seg_tau);
            }
        }

        Some(Self {
            segments,
            ducked_gain: db_to_linear(duck_db),
        })
    }

    /// The smoothed presence (`0.0` = the trigger is silent and settled,
    /// `1.0` = fully ducked) at `session_secs`. Split out from
    /// [`Self::gain_at`] so the smoother's own behaviour — attack faster than
    /// release, continuity across boundaries — is testable without the dB
    /// conversion in the way.
    pub fn presence_at(&self, session_secs: f64) -> f64 {
        // `partition_point` over a list whose `t0`s are non-decreasing by
        // construction: the index of the last segment starting at or before
        // `session_secs`, saturating at 0 for a position before the session.
        let idx = self
            .segments
            .partition_point(|s| s.t0 <= session_secs)
            .saturating_sub(1);
        let seg = &self.segments[idx];
        decay(
            seg.entry,
            seg.target,
            (session_secs - seg.t0).max(0.0),
            seg.tau,
        )
    }

    /// The gain multiplier `session_secs` into this playback session — a
    /// straight interpolation between unity and the ducked level by the
    /// smoothed presence, so a half-engaged duck is half the *linear*
    /// reduction. (Interpolating in dB instead would be defensible and is
    /// deliberately not done: the envelope multiplies a linear buffer, and a
    /// second nonlinearity between the smoother and the samples would make the
    /// attack/release time constants no longer describe the gain the user
    /// hears.)
    pub fn gain_at(&self, session_secs: f64) -> f32 {
        let p = self.presence_at(session_secs);
        (1.0 + p * (self.ducked_gain - 1.0)) as f32
    }
}

/// One-pole decay: where a smoother sitting at `from` and heading for `target`
/// has got to after `elapsed` seconds with time constant `tau`. The closed form
/// of `y += a·(x − y)` — see [`DuckEnvelope`]'s doc. Pure — no I/O.
fn decay(from: f64, target: f64, elapsed: f64, tau: f64) -> f64 {
    target + (from - target) * (-elapsed / tau).exp()
}

/// One per-clip audio-level parameter over the clip's own timeline (D-223) —
/// either a single value for its whole length, or authored automation keys.
///
/// **Keys are in CLIP-LOCAL seconds** (0.0 = the clip's own in-point), like
/// every other number [`LevelEnvelope`] carries and for [`FadeEnvelope`]'s
/// stated reason: the envelope is built before the output device is open, so it
/// cannot be in sample-frames, and the clip's own keyframe *frames* are a
/// timeline fact this crate deliberately cannot resolve. `app/src-tauri`'s
/// `chroma::audio::level_for_clip` does that conversion.
///
/// [`Self::value_at`] mirrors `chroma::keyframes::interpolate_param` (D-034/
/// D-208 — the one interpolator the authoring UI, the compositor and the
/// exporter all already agree on): **linear between the two bracketing keys,
/// held flat outside them.** Not the bezier [`EaseCurve`] model — a fade is a
/// shaped ramp with no keys, an automation curve is keys with no shape, and
/// conflating them would mean a keyframed volume interpolating differently in
/// the mixer than the same keys do in the Inspector's own readout.
#[derive(Debug, Clone, PartialEq)]
pub enum LevelCurve {
    /// One value for the clip's whole length — the un-keyframed case, and the
    /// one every clip is in until someone animates it.
    Const(f64),
    /// `(clip_secs, value)` keys, **ascending by time** (the constructor's
    /// caller sorts; [`Self::value_at`] relies on it). An empty list behaves
    /// as though it were absent — see [`LevelEnvelope::new`], which never
    /// builds one.
    Keys(Vec<(f64, f64)>),
}

impl LevelCurve {
    /// This curve's value at `clip_secs` (clip-local seconds). Held flat before
    /// the first key and after the last — no extrapolation, exactly as
    /// `interpolate_param` and `piecewiseLinearExpr` (the exporter) both do.
    pub fn value_at(&self, clip_secs: f64) -> f64 {
        match self {
            Self::Const(v) => *v,
            Self::Keys(keys) => {
                let Some(first) = keys.first() else {
                    // Unreachable via `LevelEnvelope::new` (it never stores an
                    // empty key list); `0.0` rather than a panic if some future
                    // caller constructs one directly — but 0.0 is silence, so
                    // the branch is written to be reached by nobody.
                    return 0.0;
                };
                if clip_secs <= first.0 {
                    return first.1;
                }
                let last = keys[keys.len() - 1];
                if clip_secs >= last.0 {
                    return last.1;
                }
                // Strictly between the ends, so `hi` is in `1..keys.len()` and
                // both indexes below are in range by construction.
                // `partition_point` (a binary search on an ascending slice) —
                // this runs once per output sample-frame, i.e. 48 000 times a
                // second per source, which is precisely where a linear scan
                // over a long automation curve would start costing something.
                let hi = keys.partition_point(|k| k.0 <= clip_secs);
                let (t0, v0) = keys[hi - 1];
                let (t1, v1) = keys[hi];
                let span = t1 - t0;
                if span <= 0.0 {
                    return v1;
                }
                v0 + (v1 - v0) * ((clip_secs - t0) / span)
            }
        }
    }

    /// Is this curve exactly `identity` everywhere — i.e. does applying it
    /// change nothing at all? The test [`LevelEnvelope::new`] uses to answer
    /// "does this clip need a level envelope", so an un-touched clip keeps the
    /// mixer on the arithmetic it ran before D-223 existed.
    fn is_exactly(&self, identity: f64) -> bool {
        match self {
            Self::Const(v) => *v == identity,
            Self::Keys(keys) => keys.iter().all(|&(_, v)| v == identity),
        }
    }
}

/// One clip's own volume + stereo pan, as the mixer applies it (D-223).
///
/// **The same interface [`FadeEnvelope`] established and [`DuckEnvelope`]
/// reused** — "give me the gain at position N", evaluated per output
/// sample-frame and multiplied into the source's own buffer before
/// [`mix_sources`] sees it — with one deliberate difference: this one returns
/// a **per-channel pair**, because a pan is the one gain stage in this chain
/// that is not the same number on both channels. That is the whole reason it
/// is a distinct type rather than a second `FadeEnvelope`.
///
/// **Where it sits in the chain:** `track.gain × clip.volume × fade × duck`,
/// then the pan law splits the result per channel. `track.gain` stays in
/// [`mix_sources`]' own `gains` slice (untouched, D-057), the fade and duck
/// stay in [`SourceEnvelopes`] beside this — so all four multiply, and no
/// stage can silently override another.
///
/// `pub` with `pub` fields for [`AudioSourceSpec`]'s own reason: the caller
/// that builds one is `app/src-tauri`, because building one means reading a
/// `chroma_timeline::Clip` and its keyframes, which this crate deliberately
/// cannot do.
#[derive(Debug, Clone, PartialEq)]
pub struct LevelEnvelope {
    /// Seconds from the CLIP's own in-point to the first sample this session
    /// produces — non-zero whenever playback starts mid-clip, exactly as
    /// [`FadeEnvelope::offset_secs`] is, and for the same reason: pressing
    /// Play halfway through a volume ramp must start halfway up it.
    pub offset_secs: f64,
    /// Linear volume multiplier. `1.0` is unity.
    pub volume: LevelCurve,
    /// Normalised pan, `-1.0` hard left … `1.0` hard right. `0.0` is centre.
    pub pan: LevelCurve,
}

impl LevelEnvelope {
    /// An envelope for this clip, or `None` when it would do **nothing** —
    /// volume exactly unity and pan exactly centre, everywhere, which is every
    /// clip in every pre-D-223 project and the overwhelmingly common case now.
    ///
    /// `None` is not "an envelope that returns 1.0": with it, and no fade and
    /// no duck, [`SourceEnvelopes::apply`] skips the per-sample pass entirely,
    /// so that mix runs bit-for-bit the arithmetic it always did. Exactly the
    /// contract [`FadeEnvelope`] and [`DuckEnvelope`] already state.
    pub fn new(offset_secs: f64, volume: LevelCurve, pan: LevelCurve) -> Option<Self> {
        if volume.is_exactly(1.0) && pan.is_exactly(0.0) {
            return None;
        }
        Some(Self {
            offset_secs,
            volume,
            pan,
        })
    }

    /// `(volume, left, right)` at `session_secs` into this playback session:
    /// the clip's own linear volume, and the pan law's two channel
    /// multipliers. The caller multiplies `volume` into every channel and the
    /// pair into the first two — see [`SourceEnvelopes::apply`], which is the
    /// only caller and does exactly that.
    ///
    /// The guards live in `chroma_types` (`clip_volume` floors a negative or
    /// non-finite multiplier, `pan_gains` clamps and centres one) rather than
    /// here, so the exporter's own mirror of this math cannot drift from it.
    pub fn gains_at(&self, session_secs: f64) -> (f32, f32, f32) {
        let t = self.offset_secs + session_secs;
        let volume = chroma_types::clip_volume(self.volume.value_at(t));
        let (left, right) = chroma_types::pan_gains(self.pan.value_at(t));
        (volume as f32, left as f32, right as f32)
    }
}

/// One clip's parametric EQ, realised as a real cascade of stateful biquads —
/// **one cascade per output channel** (D-224).
///
/// **Per channel, because a biquad's state is its recent history**, and the
/// left channel's history is not the right channel's: sharing one filter
/// across channels would cross-feed them into each other, which is a stereo
/// image collapsing, not an equaliser. Every channel gets the same
/// coefficients and its own two state variables per band.
///
/// **Built here, from bands, rather than handed in ready-made** — see
/// [`AudioSourceSpec::eq_bands`]: coefficients depend on the sample rate, which
/// only [`run_session`] knows.
///
/// The math is entirely [`chroma_types::eq`]'s — this type owns the plumbing
/// (which cascade belongs to which channel, and when to skip) and nothing else,
/// exactly as [`FadeEnvelope`] owns no bezier arithmetic of its own.
#[derive(Debug, Clone, PartialEq)]
pub struct EqFilter {
    /// `channels[c]` is channel `c`'s cascade, one [`Biquad`] per ACTIVE band,
    /// in the band list's own order. (Order is irrelevant to the response — a
    /// cascade of LTI sections commutes — but keeping it stable keeps the
    /// filter's float rounding deterministic, which the repo's own
    /// same-doc-same-output rule asks for.)
    channels: Vec<Vec<Biquad>>,
}

impl EqFilter {
    /// A filter for these bands at `sample_rate`, or `None` when **no** band is
    /// active — a clip with no EQ, or with a materialised strip nobody has
    /// touched (every band a gain-using kind at exactly 0 dB).
    ///
    /// `None` is not "a filter that passes samples through": with it, and no
    /// fade/duck/level, [`SourceEnvelopes::apply`] returns without touching the
    /// buffer at all. Same contract the three envelopes state.
    pub fn new(bands: &[EqBand], sample_rate: u32, out_channels: usize) -> Option<Self> {
        let coeffs: Vec<BiquadCoeffs> = bands
            .iter()
            .filter_map(|b| b.coefficients(sample_rate as f64))
            .collect();
        if coeffs.is_empty() {
            return None;
        }
        let ch = out_channels.max(1);
        Some(Self {
            channels: (0..ch)
                .map(|_| coeffs.iter().copied().map(Biquad::new).collect())
                .collect(),
        })
    }

    /// Filter one interleaved sample-frame in place, each channel through its
    /// own cascade.
    ///
    /// A frame with MORE channels than this filter was built for (which
    /// [`SourceEnvelopes::apply`] cannot produce, since both are built from the
    /// same `out_channels`) leaves the extras untouched rather than reusing
    /// another channel's state — the same "do nothing rather than invent
    /// something" rule the pan law follows for a surround device's rear
    /// channels.
    fn process_frame(&mut self, frame: &mut [f32]) {
        for (channel, sample) in frame.iter_mut().enumerate() {
            let Some(cascade) = self.channels.get_mut(channel) else {
                continue;
            };
            // `f64` through the cascade — see `Biquad::process` for why an IIR
            // filter is the one place in this mixer worth the extra precision.
            let mut x = *sample as f64;
            for section in cascade.iter_mut() {
                x = section.process(x);
            }
            *sample = x as f32;
        }
    }
}

/// Apply a source's EQ and gain envelopes to one interleaved chunk in place —
/// **one pass, every stage** (D-147's fade, D-149's duck, D-223's level and
/// D-224's EQ), for ONE source.
///
/// One struct rather than two index-parallel `Option` slices threaded through
/// [`mix_chunk`]: they are always built, indexed and applied together, and
/// index-alignment with `decoded`/`gains` is a real invariant that a comment was
/// the only thing enforcing before D-149 added the second one. Making it
/// structural is cheaper than restating it — and it keeps `mix_chunk` inside
/// clippy's argument-count limit without a suppression.
///
/// `Default` (both `None`) is the case every clip in every pre-D-147 project is
/// in, and [`Self::apply`] returns immediately for it.
#[derive(Debug, Clone, Default)]
struct SourceEnvelopes {
    fade: Option<FadeEnvelope>,
    duck: Option<DuckEnvelope>,
    /// D-223 — this clip's own volume/pan. The third envelope, joining the
    /// same one-pass loop for the same reason the duck did rather than getting
    /// a second pass over the buffer.
    level: Option<LevelEnvelope>,
    /// D-224 — this clip's parametric EQ. Joins the same loop, ahead of the
    /// three gain stages (see [`Self::apply`] for why that order and not the
    /// other one). Unlike the three, it is **stateful**, which is what makes
    /// [`Self::apply`] take `&mut self`: a biquad carries its own recent
    /// history across chunk boundaries, and a filter restarted every 1024
    /// samples is a buzz, not an equaliser.
    eq: Option<EqFilter>,
}

impl SourceEnvelopes {
    /// Apply both envelopes to one interleaved chunk in place.
    ///
    /// `session_frame` is how many output sample-frames the session has already
    /// produced, including any [`discard_samples`] skipped for D-125's skew
    /// compensation, since those represent real timeline time that has passed.
    ///
    /// **They multiply, and they share the loop.** Both are gain multipliers
    /// over the same per-sample-frame position, so composing them is a product,
    /// not two passes over the buffer — and multiplication is the only
    /// composition under which neither silently overrides the other (the same
    /// argument `resolve_clip_transform` makes for a fade against keyframed
    /// opacity). A clip fading out on a track that is being ducked ends up at
    /// the product of both, which is what an editor expects and what a real
    /// mixer does with two gain stages in series.
    ///
    /// **All absent is an early return, not a loop of `× 1.0`** — that is what
    /// keeps a project with none of these features configured on exactly the
    /// arithmetic it ran before any of them existed.
    ///
    /// **D-223 — pan is the one stage that is not the same number on both
    /// channels**, so this is where the loop stops being "one gain per
    /// sample-frame". The rules, stated because they are choices rather than
    /// consequences:
    /// - **Channel 0 is left, channel 1 is right**, and only those two are
    ///   panned. Every further channel of a surround device gets the volume
    ///   alone — a real surround panner is a 2-D position, not this one number,
    ///   and quietly reusing the stereo pair's gains for the rears would be
    ///   inventing a panning law nobody asked for.
    /// - **A MONO output device ignores pan entirely** (volume still applies).
    ///   With one channel there is nowhere to move the source to, and applying
    ///   only the left multiplier would turn a hard-right pan into silence on a
    ///   mono device — losing the audio rather than positioning it.
    /// - A **mono source** is already duplicated across the output's channels
    ///   by [`adapt_channels`] long before this runs, so panning one works
    ///   without a special case: it becomes stereo-positioned mono, which is
    ///   what an editor means by panning a mono clip.
    fn apply(&mut self, buf: &mut [f32], out_channels: usize, session_frame: u64, out_rate: u32) {
        if self.fade.is_none() && self.duck.is_none() && self.level.is_none() && self.eq.is_none() {
            return;
        }
        let ch = out_channels.max(1);
        let rate = out_rate.max(1) as f64;
        for (f, frame) in buf.chunks_mut(ch).enumerate() {
            // D-224 — EQ runs FIRST, on the source as decoded, before any of
            // the gain stages below. Two reasons, and the second is the one
            // that matters: (1) it is the standard "insert before the fader"
            // topology every mixer uses, and (2) a biquad is linear but
            // TIME-INVARIANT, so filtering a signal a fade has already
            // time-varied is not the same operation as fading a filtered one —
            // the two orders genuinely differ, and only this one matches the
            // export's own filter chain (`eq → volume`, see
            // `timelineExportAudio.ts`'s `buildAudioSourceChain`). Getting
            // that backwards would make the preview and the render differ in a
            // way no test that measured only one of them would catch.
            if let Some(eq) = &mut self.eq {
                eq.process_frame(frame);
            }
            let t = (session_frame as f64 + f as f64) / rate;
            let mut g = 1.0f32;
            if let Some(env) = &self.fade {
                g *= env.gain_at(t);
            }
            if let Some(env) = &self.duck {
                g *= env.gain_at(t);
            }
            match &self.level {
                None => {
                    for s in frame.iter_mut() {
                        *s *= g;
                    }
                }
                Some(env) => {
                    let (volume, left, right) = env.gains_at(t);
                    let g = g * volume;
                    if ch >= 2 {
                        frame[0] *= g * left;
                        frame[1] *= g * right;
                        for s in frame[2..].iter_mut() {
                            *s *= g;
                        }
                    } else {
                        for s in frame.iter_mut() {
                            *s *= g;
                        }
                    }
                }
            }
        }
    }
}

/// A claimed audio-transport request: this call is the newest one the
/// frontend has issued, so it owns the session and may go on to [`start`] one.
///
/// D-146 split what used to be a single `chroma_audio_play` into this plus
/// [`start`], because the middle of it — turning `start_frame` into a set of
/// sources — is timeline resolution and belongs to the layer above this crate
/// (see the module doc). The order is load-bearing and is preserved exactly:
/// `requested_at` is stamped, then the session is claimed, and only then does
/// the caller resolve its sources, so that resolution's cost stays inside the
/// skew [`run_session`] measures and compensates for (D-125).
pub struct PlaySession {
    /// The generation [`begin_request`] handed out. `run_session` exits as
    /// soon as `SESSION.generation` no longer matches it.
    generation: u64,
    /// The instant the frontend asked for playback — the same moment the
    /// video rAF loop re-baselines its own `performance.now()` clock.
    /// Everything between it and the first sample reaching the DAC is skew
    /// the audio would otherwise carry for the whole session.
    requested_at: Instant,
}

/// Claim the audio transport for request `seq`, tearing down whatever session
/// is running, or return `None` if a **newer** request has already been
/// accepted — in which case the caller must do nothing at all (B-047 /
/// D-130). See [`begin_request`].
///
/// The wrapping command is `#[tauri::command(async)]` (D-125): see [`stop`] —
/// same reason, and here it also means the command isn't itself queued behind
/// a main-thread preview decode, which is precisely the latency the video
/// clock does not wait for.
pub fn begin_play(seq: u64) -> Option<PlaySession> {
    // Stamped *before* `begin_request`, which joins the outgoing session's
    // thread and can take up to one of its poll intervals.
    let requested_at = Instant::now();
    // Overtaken by a newer request before this task got a worker thread?
    // Starting anyway would replay the timeline from a playhead the picture
    // has already moved past (B-047).
    let generation = begin_request(seq)?;
    Some(PlaySession {
        generation,
        requested_at,
    })
}

/// Start a fresh session that decodes and mixes `sources` together (see
/// [`run_session`]) under the transport claimed by [`begin_play`].
///
/// An **empty** `sources` — no video clip at this position, or one with no
/// audio stream, and no audio-track clip either — is **not** an error: it just
/// means nothing plays, matching the video preview's own "blank frame past the
/// end" behaviour. The session stays claimed (silence *is* the correct output
/// for that playhead), which is exactly what the pre-D-146 code did.
///
/// Which sources these are is the caller's business, not this crate's:
/// `app/src-tauri`'s `chroma_audio_play` resolves the video track's own
/// embedded audio (D-050, at unity gain, via
/// `chroma::edit::resolve_video_position` — the same lookup the video preview
/// uses, gated on [`crate::video::VideoInfo::has_audio`]) plus, since D-057
/// Phase C, every clip on a genuine `TrackKind::Audio` track overlapping the
/// position, each at its own track's gain. D-129's A/V-link suppression lives
/// there too, for the same reason: it is a question about clips.
pub fn start(session: PlaySession, sources: Vec<AudioSourceSpec>) -> Result<(), String> {
    let PlaySession {
        generation: my_gen,
        requested_at,
    } = session;

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
pub fn level() -> (f32, f32) {
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
/// (checked via [`crate::probe::probe_cached`], the same cache
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
    let source_key = crate::media_cache::source_key(path).ok();
    let key = source_key
        .as_deref()
        .map(|k| peaks_cache_key(k, start_secs, duration_secs));

    if let Some(key) = key.as_deref()
        && let Some(hit) = PEAKS_MEM.lock().unwrap_or_else(|e| e.into_inner()).get(key)
    {
        return Ok(Arc::clone(hit));
    }
    if let Some(key) = key.as_deref()
        && let Some(peaks) = crate::media_cache::read_json::<Vec<(f32, f32)>>(NS_WAVEFORM, key)
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
        crate::media_cache::write_json(NS_WAVEFORM, key, peaks.as_ref());
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

/// The synchronous body of [`waveform`] — everything except
/// getting off the main thread. Split out (rather than making the tests
/// `#[tokio::test]`) for the same reason `project.rs` gives for its own
/// equivalent split: this module is otherwise entirely sync, and pulling a
/// tokio test runtime into it to exercise one command is a bigger change than
/// the thing being tested.
pub fn waveform_peaks(
    source_path: &str,
    start_secs: f64,
    duration_secs: f64,
    buckets: usize,
) -> Result<Vec<(f32, f32)>, String> {
    if duration_secs <= 0.0 || buckets == 0 {
        return Ok(Vec::new());
    }
    let path = PathBuf::from(source_path);
    let info = crate::probe::probe_cached(&path)?;
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
/// path between opening a project and the timeline appearing. The
/// `spawn_blocking` stays here rather than in the command wrapper so the
/// property is a fact about this function, not about who happens to call it.
pub async fn waveform(
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
/// A one-shot batch read for [`waveform`]; **not** shared with
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

    seek_source(
        format.as_mut(),
        track_id,
        start_secs,
        &path.display().to_string(),
    );
    // B-052 / D-133 — and then land on `start_secs` exactly, by packet
    // timestamp, whatever that seek did. A waveform drawn from the wrong part
    // of the file is the same defect as playing the wrong part of it; the
    // reason it was never *seen* is that every clip the app creates today
    // starts at `source_start: 0`, where there is nothing to seek to.
    let mut trim = start_trim(track.time_base, start_secs, src_rate);

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
        let head_drop_frames = match trim {
            None => 0,
            Some(t) => match t.classify(packet.pts, packet.dur) {
                PacketSkip::DropWhole => continue,
                PacketSkip::DropFrames(n) => {
                    trim = None;
                    n
                }
                PacketSkip::Arrived => {
                    trim = None;
                    0
                }
            },
        };
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue, // skip the bad packet, keep going
            Err(e) => return Err(format!("decode: {e}")),
        };

        let mut interleaved = vec![0f32; decoded.samples_interleaved()];
        decoded.copy_to_slice_interleaved(&mut interleaved);
        for frame in interleaved
            .chunks_exact(src_channels)
            .skip(head_drop_frames)
        {
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

/// How far into a source a session still has to skip before it is really at
/// the time it was asked to start at, and the track timebase to read packet
/// timestamps with (B-052 / D-133).
///
/// **Why the container's own seek is not trusted.** `open_source` and
/// [`decode_mono_range`] both ask `symphonia` to seek and then, until this
/// existed, ignored the result — "worst case playback starts from wherever the
/// reader already is." On the owner's real camera original
/// (`A001_08302215_C019.MOV`) that worst case is what actually happens, every
/// single time, and "wherever the reader already is" is **the start of the
/// file**. Measured, not theorised: that MOV carries a third, non-media data
/// track (a nanosecond-timebase metadata track, total duration `41666667` ns —
/// exactly one 24 fps frame) alongside its HEVC and AAC tracks, and
/// `symphonia-format-isomp4-0.6.1`'s `IsoMp4Reader::seek` seeks *every other*
/// track to the requested time with `?` before seeking the one that was asked
/// for (`demuxer.rs`, `SeekTo::Time`, whose own comment says it will "discard
/// the result" — it does not). So any seek past 0.042 s fails the whole call
/// with `SeekErrorKind::OutOfRange`, the audio track is left un-seeked at
/// sample 0, and every Play produced audio from 0:00 no matter where the
/// playhead was.
///
/// Trimming by the packets' own timestamps is correct whether the seek
/// succeeded, failed, or (`SeekMode` is ignored outright by that reader) landed
/// on an earlier sample than asked for — a measured 13 ms early on a
/// well-formed file, which this now also corrects. The catch-up costs one pass
/// of packet reads with no decoding: measured on that same 2.3 GB file, **56 ms
/// to reach 60 s and 249 ms to reach 300 s**, because the failed seek has
/// already moved the *video* track forward, so the reader hands back almost
/// nothing but the audio track's own packets while it catches up.
#[derive(Debug, Clone, Copy)]
struct StartTrim {
    target_secs: f64,
    time_base: symphonia::core::units::TimeBase,
    src_rate: u32,
}

impl StartTrim {
    /// [`packet_skip`] for one packet's `(pts, dur)` in this track's timebase.
    /// A timestamp the timebase cannot convert counts as arrived rather than as
    /// something to skip — see [`packet_skip`]'s own doc.
    fn classify(
        &self,
        pts: symphonia::core::units::Timestamp,
        dur: symphonia::core::units::Duration,
    ) -> PacketSkip {
        match (
            self.time_base.calc_time(pts).map(|t| t.as_secs_f64()),
            self.time_base.calc_duration(dur).map(|t| t.as_secs_f64()),
        ) {
            (Some(secs), Some(dur_secs)) => {
                packet_skip(secs, dur_secs, self.target_secs, self.src_rate)
            }
            _ => PacketSkip::Arrived,
        }
    }
}

/// The [`StartTrim`] for a source asked to start at `start_secs`, or `None`
/// when there is nothing to trim to (the very start of the file) or no timebase
/// to measure against. Shared by [`open_source`] and [`decode_mono_range`],
/// which otherwise deliberately duplicate their symphonia setup (see
/// `decode_mono_range`'s own doc).
fn start_trim(
    time_base: Option<symphonia::core::units::TimeBase>,
    start_secs: f64,
    src_rate: u32,
) -> Option<StartTrim> {
    if start_secs <= 0.0 || !start_secs.is_finite() {
        return None;
    }
    time_base.map(|time_base| StartTrim {
        target_secs: start_secs,
        time_base,
        src_rate,
    })
}

/// Ask `format` to seek `track_id` to `start_secs`, logging rather than
/// swallowing a failure. The return value is deliberately nothing: what the
/// caller does next is driven by [`StartTrim`], not by whether this worked —
/// see that type's doc for why the result cannot be trusted either way.
fn seek_source(
    format: &mut dyn symphonia::core::formats::FormatReader,
    track_id: u32,
    start_secs: f64,
    label: &str,
) {
    if start_secs <= 0.0 {
        return;
    }
    let Some(time) = Time::try_from_secs_f64(start_secs) else {
        return;
    };
    if let Err(e) = format.seek(
        SeekMode::Accurate,
        SeekTo::Time {
            time,
            track_id: Some(track_id),
        },
    ) {
        // Not fatal, and not silent either (B-052): the caller trims forward by
        // packet timestamp regardless, but a container that cannot be seeked is
        // a real, diagnosable property of the media worth one line per session.
        log::warn!(
            "chroma audio: {label} could not seek to {start_secs:.3}s ({e}) — \
             skipping forward by packet timestamps instead"
        );
    }
}

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
/// `pub(crate)` since D-232 — [`crate::scrub`] fills its decoded window through
/// exactly this type, so a scrub lands on the same source second, through the
/// same channel adaptation, resampling and B-052/D-133 start trim, that
/// playback would.
pub(crate) struct DecodedSource {
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
    /// Interleaved samples still inside the **clip's** out-point (B-048 /
    /// D-130), counting down as [`Self::take`] hands them out. `None` means no
    /// out-point is known and the source plays to the end of the file — the
    /// pre-D-130 behaviour, which no caller asks for any more.
    ///
    /// Without this, a session opened the source file and streamed it to EOF
    /// regardless of how long the clip under the playhead actually was: play a
    /// 7-second clip that sits above a different 517-second one and, the moment
    /// the picture cut to the clip below, you kept hearing the *first* file's
    /// audio underneath it. Reported as the voice overlapping / not matching
    /// the picture.
    remaining: Option<usize>,
    /// How far this source still has to skip to reach the source time it was
    /// asked to start at, cleared the moment it gets there (B-052 / D-133). See
    /// [`StartTrim`] for why a source cannot simply trust that the seek in
    /// [`open_source`] put it in the right place.
    start_trim: Option<StartTrim>,
    /// D-242 — this source's speed ramp, or `None` when it plays at its
    /// recorded rate (every clip in every pre-D-236 project, and the common
    /// case). `None` is not "a ramp that returns its own input": [`Self::ensure`]
    /// takes a different branch entirely for it, so an un-ramped source decodes
    /// through exactly the loop it always did.
    retime: Option<Retime>,
}

/// How many OUTPUT frames a retimed source produces per pass through
/// [`Retime::plan`]. Bounded so the position buffer and the input window each
/// pass needs stay small and cache-friendly; the mixer's own chunk is the same
/// order of magnitude, so this is almost always one pass.
const RETIME_CHUNK_FRAMES: usize = 1024;

/// One resolved run, in the only unit this stage works in: **input sample
/// FRAMES at the session's own output rate.** Seconds are converted away once,
/// in [`Retime::new`], so the per-frame hot loop never touches a rate again.
#[derive(Debug, Clone, Copy)]
struct RetimeRun {
    /// Inclusive input frame this run covers.
    start: f64,
    /// Exclusive input frame this run covers.
    end: f64,
    /// Signed; negative plays `[start, end)` backwards (D-241).
    speed: f64,
}

impl RetimeRun {
    /// The INPUT position this run sits at when its own output begins: its
    /// start forwards, its **end** in reverse. The exact counterpart of
    /// `chroma_timeline::speed_ramp::SpeedSegment::anchor_source_frame` — the
    /// same one-term generalisation, in sample frames rather than video frames.
    fn anchor(&self) -> f64 {
        if self.speed > 0.0 {
            self.start
        } else {
            self.end
        }
    }

    /// This run's OUTPUT length in frames, `len / |speed|`.
    fn out_len(&self) -> f64 {
        (self.end - self.start).max(0.0) / self.speed.abs()
    }
}

/// The output frames one [`Retime::plan`] pass will produce, as the INPUT
/// positions they read from — a plain `Vec<f64>` of fractional input frames,
/// one per output frame, plus the range they span.
struct RetimePlan {
    /// Fractional input frame per output frame, in output order.
    positions: Vec<f64>,
    /// The highest input frame any of them reads (already including the `+1`
    /// the linear interpolation needs), so the caller knows how far to decode.
    highest: f64,
}

impl RetimePlan {
    fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    fn highest_input_frame(&self) -> f64 {
        self.highest
    }
}

/// D-242 — the live mixer's RETIME stage: one clip's speed ramp applied to its
/// already-decoded, already-resampled, already-channel-adapted audio, so the
/// preview's sound advances through the source at the same rate its picture
/// does.
///
/// **What it is.** A variable-rate reader over a window of the source's output
/// stream. `chroma_timeline::speed_ramp` answers "which SOURCE frame does this
/// clip show at this OUTPUT position" for the picture; this asks the identical
/// question of the same ramp at *sample* resolution and reads the buffer
/// there, interpolating between the two neighbouring input frames.
///
/// **Why a resampler and not `atempo`.** The EXPORT preserves pitch, because
/// ffmpeg hands it a WSOLA implementation for free. The live mixer deliberately
/// does not: it VARISPEEDS, like tape — a 2x clip previews an octave up, a
/// reversed one previews backwards. That is a real, stated asymmetry with the
/// export (see D-242), not an oversight, and it is the same choice Premiere
/// makes by default ("Maintain Audio Pitch" is a checkbox you turn ON, not the
/// default). Two reasons it is the right one here: a phase vocoder or WSOLA is
/// a whole DSP subsystem with its own latency and artefacts to get wrong on the
/// real-time thread, where this is a multiply-add per sample; and what an
/// editor is checking when they scrub a ramp is *timing* — whether the hit
/// lands on the beat — which varispeed gets exactly right.
///
/// **What it does NOT do.** No pitch correction (above). No filtering beyond
/// the linear interpolation, so a heavily slowed run is soft rather than
/// aliased and a heavily sped-up one can alias — audible only above ~4x, and
/// the preview is a preview. It does not decode: it is handed input by
/// [`DecodedSource::ensure_retimed`] and only ever asks for more.
struct Retime {
    /// The ramp, in input frames at the session's output rate.
    runs: Vec<RetimeRun>,
    /// Total output frames this ramp produces — where the source falls silent.
    total_out_frames: f64,
    /// Interleaved input samples at the session's `(out_rate, out_channels)`.
    ///
    /// A `VecDeque` because a forward run consumes it from the front while more
    /// arrives at the back. A REVERSED run never drops anything: it enters at
    /// the run's last input frame and walks down, so it must hold the whole run
    /// at once. That is the real memory cost of live reverse, and it is small
    /// where the picture's is not — a 30-second reversed run at 48 kHz stereo
    /// is ~11 MB of `f32`, against the ~5 GB of raw frames the same 30 seconds
    /// of 1080p would be.
    input: VecDeque<f32>,
    /// The input frame index of `input`'s first frame — what makes the window
    /// slide without renumbering the positions the plan is expressed in.
    input_base: u64,
    /// Output frames produced so far; the plan's own clock.
    out_frame: u64,
    /// Channel count every buffer here is interleaved at.
    channels: usize,
}

impl Retime {
    /// Build the stage for `segments` (SOURCE seconds relative to the source's
    /// own open point) at the session's output rate, or `None` when there is
    /// nothing to retime — no segments at all, or a single forward 1x run,
    /// which is the identity and must not cost a resample.
    fn new(segments: &[AudioSpeedSegment], out_rate: u32, channels: usize) -> Option<Self> {
        if segments.is_empty() {
            return None;
        }
        let rate = out_rate as f64;
        let runs: Vec<RetimeRun> = segments
            .iter()
            .filter(|s| s.speed.is_finite() && s.speed != 0.0 && s.end_secs > s.start_secs)
            .map(|s| RetimeRun {
                start: s.start_secs * rate,
                end: s.end_secs * rate,
                speed: s.speed,
            })
            .collect();
        if runs.is_empty() {
            return None;
        }
        // The identity, spelled out: one forward run at exactly 1x reads its
        // input frame for frame, so attaching the stage would only add an
        // interpolation that returns its own input. Deliberately the same
        // "flat is not a second concept" rule `segments_are_flat` encodes on
        // the model side — a REVERSED single run is not identity and does not
        // take this exit.
        if runs.len() == 1 && runs[0].speed == 1.0 {
            return None;
        }
        let total_out_frames = runs.iter().map(RetimeRun::out_len).sum();
        Some(Self {
            runs,
            total_out_frames,
            input: VecDeque::new(),
            input_base: 0,
            out_frame: 0,
            channels: channels.max(1),
        })
    }

    /// The fractional INPUT frame this ramp reads at OUTPUT frame `out_pos` —
    /// the sample-resolution twin of
    /// `chroma_timeline::speed_ramp::source_frame_at_output`, written the same
    /// way against the same anchor so the sound cannot drift from the picture.
    fn input_frame_at(&self, out_pos: f64) -> f64 {
        let mut acc = 0.0;
        for (i, run) in self.runs.iter().enumerate() {
            let out_len = run.out_len();
            if out_pos < acc + out_len || i + 1 == self.runs.len() {
                return run.anchor() + (out_pos - acc) * run.speed;
            }
            acc += out_len;
        }
        0.0
    }

    /// Plan the next `frames` output frames, truncated at the ramp's own end.
    fn plan(&self, frames: usize) -> RetimePlan {
        let remaining = (self.total_out_frames - self.out_frame as f64).floor();
        let take = if remaining <= 0.0 {
            0
        } else {
            frames.min(remaining as usize)
        };
        let mut positions = Vec::with_capacity(take);
        let mut highest = f64::NEG_INFINITY;
        for k in 0..take {
            let p = self.input_frame_at((self.out_frame + k as u64) as f64);
            highest = highest.max(p);
            positions.push(p);
        }
        RetimePlan {
            positions,
            // `+ 1` because the interpolation reads the frame after the one it
            // lands in; without it a run's very last output frame would blend
            // against a zero that has not been decoded yet and click.
            highest: highest + 1.0,
        }
    }

    /// Has the input window been decoded far enough to serve a plan reaching
    /// `frame`?
    fn covers_input_frame(&self, frame: f64, channels: usize) -> bool {
        let have = self.input_base + (self.input.len() / channels.max(1)) as u64;
        (have as f64) > frame
    }

    /// Append freshly decoded output-rate samples to the input window.
    fn push_input(&mut self, interleaved: &[f32]) {
        self.input.extend(interleaved.iter().copied());
    }

    /// One interpolated input frame's `channel`-th sample.
    ///
    /// Before the window, or more than one frame past what the decoder
    /// produced, this is silence: a source that ran out really has nothing
    /// there, and holding a sample for seconds would be an audible DC step
    /// rather than an end.
    ///
    /// **The one-frame grace at the top is not slack, it is the exclusive
    /// end.** A reversed run's very first output frame sits at its range's
    /// EXCLUSIVE end — input frame `N` of an `N`-frame file — which by
    /// definition has not been decoded and never will be. Returning silence
    /// there puts a single-sample click at the head of every reversed clip.
    /// Holding the last real sample for that one frame is exactly right: it is
    /// the signal, one sample early.
    fn sample_at(&self, position: f64, channel: usize) -> f32 {
        let base = position.floor();
        if base < self.input_base as f64 {
            return 0.0;
        }
        let frames = self.input.len() / self.channels;
        let idx = (base as u64 - self.input_base) as usize;
        if idx >= frames {
            return if idx == frames && frames > 0 {
                self.input
                    .get((frames - 1) * self.channels + channel)
                    .copied()
                    .unwrap_or(0.0)
            } else {
                0.0
            };
        }
        let frac = (position - base) as f32;
        let a = self.input.get(idx * self.channels + channel).copied();
        let b = self.input.get((idx + 1) * self.channels + channel).copied();
        match (a, b) {
            (Some(a), Some(b)) => a + (b - a) * frac,
            // The very last decoded frame has no successor to blend toward;
            // holding it is right there (it IS the signal).
            (Some(a), None) => a,
            _ => 0.0,
        }
    }

    /// Produce this plan's output frames, advance the clock, and release the
    /// input the ramp can no longer reach.
    fn emit(&mut self, plan: &RetimePlan, channels: usize) -> Vec<f32> {
        let channels = channels.max(1);
        let mut out = Vec::with_capacity(plan.positions.len() * channels);
        for &position in &plan.positions {
            for c in 0..channels {
                out.push(self.sample_at(position, c));
            }
        }
        self.out_frame += plan.positions.len() as u64;

        // Release the input this ramp can never reach again — the lowest input
        // frame any REMAINING output frame will read, not the lowest this pass
        // happened to touch.
        //
        // The distinction is the whole correctness of reverse, and getting it
        // wrong is not subtle: a reversed run's first pass reads the TOP of its
        // range, so "drop below this pass's lowest position" throws away the
        // entire rest of the run before it has played a sample of it. Caught by
        // `a_reversed_clip_previews_its_audio_running_backwards`, which read
        // silence.
        let keep_from = self.min_future_input_frame().floor();
        if keep_from.is_finite() && keep_from > self.input_base as f64 {
            let available = (self.input.len() / channels) as u64;
            let drop_frames = (keep_from as u64 - self.input_base).min(available);
            self.input.drain(0..(drop_frames as usize * channels));
            self.input_base += drop_frames;
        }
        out
    }

    /// The lowest INPUT frame any output frame from here to the end of the ramp
    /// will read — the retention floor for [`Self::emit`]'s window.
    ///
    /// Per remaining run: a run not yet started can be entered anywhere in its
    /// range, so its floor is its own start. A run IN PROGRESS depends on which
    /// way it travels — a forward one will only ever climb from where it is, so
    /// its floor is the current position and the window really does slide; a
    /// reversed one is heading DOWN to its start, so its floor is that start
    /// and nothing is released until it finishes. That last case is why live
    /// reverse holds its whole run in memory, and why the doc on
    /// [`Retime::input`] states the size.
    fn min_future_input_frame(&self) -> f64 {
        let current = self.out_frame as f64;
        let mut acc = 0.0;
        let mut lowest = f64::INFINITY;
        for run in &self.runs {
            let out_end = acc + run.out_len();
            if out_end <= current {
                acc = out_end;
                continue; // wholly played
            }
            let floor_for_run = if current <= acc {
                run.start // not entered yet
            } else if run.speed > 0.0 {
                run.anchor() + (current - acc) * run.speed // climbing from here
            } else {
                run.start // descending toward here
            };
            lowest = lowest.min(floor_for_run);
            acc = out_end;
        }
        lowest
    }

    /// Has this ramp produced its whole output?
    fn is_finished(&self) -> bool {
        (self.out_frame as f64) >= self.total_out_frames
    }
}

impl DecodedSource {
    /// Decode further packets until `carry` holds at least `want` samples or
    /// this source hits EOF (setting `exhausted`, after which `carry` may
    /// stay short of `want` forever — that's fine, [`Self::take`] pads).
    ///
    /// D-242 — a source carrying a [`Retime`] takes the second branch: the
    /// decoded stream feeds the retime's own input window instead of `carry`,
    /// and `carry` is filled from what the retime resamples out of it. An
    /// un-retimed source (every clip in every pre-D-236 project) runs the first
    /// branch, which is the original loop, unchanged.
    fn ensure(&mut self, want: usize, out_channels: usize) -> Result<(), String> {
        if self.retime.is_none() {
            while self.carry.len() < want && !self.exhausted {
                match self.decode_chunk(out_channels)? {
                    Some(chunk) => self.carry.extend(chunk),
                    None => break,
                }
            }
            return Ok(());
        }
        self.ensure_retimed(want, out_channels)
    }

    /// [`Self::ensure`]'s retimed branch (D-242).
    ///
    /// Three steps per pass, in this order because each needs the previous
    /// one's answer: **plan** the output frames' input positions, **feed** the
    /// decoder until the input window covers them, then **emit**. Planning
    /// first is what makes reverse work at all — the highest input frame a
    /// backwards run needs is the one it starts on, so the retime has to say
    /// how far ahead to decode before anything can be produced.
    fn ensure_retimed(&mut self, want: usize, out_channels: usize) -> Result<(), String> {
        let channels = out_channels.max(1);
        while self.carry.len() < want {
            let Some(retime) = self.retime.as_ref() else {
                return Ok(());
            };
            let frames = want
                .saturating_sub(self.carry.len())
                .div_ceil(channels)
                .clamp(1, RETIME_CHUNK_FRAMES);
            let plan = retime.plan(frames);
            if plan.is_empty() {
                // The ramp has produced its whole output. Everything past it is
                // silence, exactly as running off the end of the file is.
                self.exhausted = true;
                return Ok(());
            }
            let need_through = plan.highest_input_frame();

            // Feed. `decode_chunk` returning `Some(empty)` is normal, not EOF —
            // rubato only emits once it has accumulated a full chunk — so the
            // loop is bounded by the decoder reaching EOF, not by any one pass
            // producing samples.
            while !self.exhausted {
                let covered = match self.retime.as_ref() {
                    Some(r) => r.covers_input_frame(need_through, channels),
                    None => true,
                };
                if covered {
                    break;
                }
                match self.decode_chunk(out_channels)? {
                    Some(chunk) => {
                        if let Some(r) = self.retime.as_mut() {
                            r.push_input(&chunk);
                        }
                    }
                    None => break,
                }
            }

            if let Some(r) = self.retime.as_mut() {
                self.carry.extend(r.emit(&plan, channels));
            }
        }
        Ok(())
    }

    /// Decode the next packet into interleaved samples at the session's own
    /// `(out_rate, out_channels)` — the body of the pre-D-242 `ensure` loop,
    /// lifted verbatim into its own step so the plain and the retimed paths can
    /// share one decoder without either re-spelling it.
    ///
    /// `Ok(None)` means EOF (and sets `exhausted`, as the loop always did);
    /// `Ok(Some(empty))` means "nothing came out of the resampler this time",
    /// which is routine and not an end.
    fn decode_chunk(&mut self, out_channels: usize) -> Result<Option<Vec<f32>>, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => {
                    self.exhausted = true;
                    return Ok(None);
                }
                Err(SymError::ResetRequired) => {
                    self.exhausted = true;
                    return Ok(None);
                }
                Err(SymError::IoError(_)) => {
                    self.exhausted = true;
                    return Ok(None);
                }
                Err(e) => return Err(format!("next_packet ({}): {e}", self.label)),
            };
            if packet.track_id != self.track_id {
                continue;
            }
            // B-052 / D-133 — land on the source time this session actually
            // asked for, by the packets' own timestamps, instead of assuming
            // `open_source`'s seek put us there. A packet entirely before the
            // target is dropped without being decoded at all (the whole reason
            // catching up on an unseekable container costs tens of
            // milliseconds rather than seconds).
            let head_drop_frames = match self.start_trim {
                None => 0,
                Some(trim) => match trim.classify(packet.pts, packet.dur) {
                    PacketSkip::DropWhole => continue,
                    PacketSkip::DropFrames(n) => {
                        self.start_trim = None;
                        n
                    }
                    PacketSkip::Arrived => {
                        self.start_trim = None;
                        0
                    }
                },
            };
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(SymError::DecodeError(_)) => continue, // skip the bad packet, keep going
                Err(e) => return Err(format!("decode ({}): {e}", self.label)),
            };
            let mut interleaved = vec![0f32; decoded.samples_interleaved()];
            decoded.copy_to_slice_interleaved(&mut interleaved);
            let head = (head_drop_frames * self.src_channels).min(interleaved.len());
            let adapted = adapt_channels(&interleaved[head..], self.src_channels, out_channels);
            return Ok(Some(self.resample.push(&adapted)?));
        }
    }

    /// Pop exactly `want` interleaved samples — decoding more first via
    /// [`Self::ensure`] if needed, padding with silence once this source is
    /// exhausted (its own contribution simply becomes silence for the rest
    /// of the session; the other sources are unaffected).
    ///
    /// Never hands out more than [`Self::remaining`] real samples: past the
    /// clip's out-point the rest of the window is silence and nothing further
    /// is decoded (B-048). Always returns exactly `want` samples either way, so
    /// every source stays in lockstep for [`mix_sources`].
    pub(crate) fn take(&mut self, want: usize, out_channels: usize) -> Result<Vec<f32>, String> {
        let allowed = match self.remaining {
            Some(r) => want.min(r),
            None => want,
        };
        self.ensure(allowed, out_channels)?;
        let mut out = Vec::with_capacity(want);
        for _ in 0..allowed {
            out.push(self.carry.pop_front().unwrap_or(0.0));
        }
        out.resize(want, 0.0);
        if let Some(r) = self.remaining.as_mut() {
            *r -= allowed;
        }
        Ok(out)
    }

    /// True once this source will never produce another non-silent sample —
    /// `run_session`'s whole-session-done check (every source, not just
    /// one) is `.all(DecodedSource::is_done)`. Reaching the clip's out-point
    /// counts as done just as much as reaching the file's end (B-048).
    ///
    /// D-242 — a RETIMED source is not done just because its decoder hit EOF:
    /// a reversed run has by then buffered the whole range it is about to play
    /// backwards, and a slowed one still has most of its output ahead of it. So
    /// the retime gets a say, and the real bound stays [`Self::remaining`] (the
    /// clip's OUTPUT length), which counts down on every `take` either way.
    pub(crate) fn is_done(&self) -> bool {
        if self.remaining == Some(0) {
            return true;
        }
        let retime_done = self.retime.as_ref().is_none_or(Retime::is_finished);
        self.exhausted && self.carry.is_empty() && retime_done
    }
}

/// Open `path`'s default audio track, seek to `start_secs`, and set up
/// resampling to the session's shared `(out_rate, out_channels)` — the common
/// "get a source ready to decode" setup every [`AudioSourceSpec`] in a
/// [`run_session`] call goes through. Mirrors [`decode_mono_range`]'s
/// symphonia open/probe/seek prefix (duplicated there for the documented
/// reason: the two diverge immediately after — one a bounded batch read, this
/// one a live streaming source kept open for the session's lifetime).
pub(crate) fn open_source(
    path: &Path,
    start_secs: f64,
    duration_secs: Option<f64>,
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

    let label = path.display().to_string();
    seek_source(format.as_mut(), track_id, start_secs, &label);

    let resample = Resample::new(src_rate, out_rate, out_channels)?;

    Ok(DecodedSource {
        label,
        format,
        decoder,
        track_id,
        src_channels,
        resample,
        carry: VecDeque::new(),
        exhausted: false,
        remaining: duration_secs.map(|d| clip_limit_samples(d, out_rate, out_channels)),
        // B-052 / D-133 — the seek above is an optimisation, not the thing that
        // establishes where playback starts; this is.
        start_trim: start_trim(track.time_base, start_secs, src_rate),
        // D-242 — attached separately, by `DecodedSource::with_speed`, so this
        // function keeps the signature its five other callers already use.
        retime: None,
    })
}

impl DecodedSource {
    /// D-242 — attach this source's speed ramp, if it has one.
    ///
    /// Separate from [`open_source`] rather than a sixth parameter on it: the
    /// ramp needs the session's real `out_rate`, which is the same thing
    /// `open_source` needs, but every other caller of that function
    /// (`crate::scrub`, and the crate's own device tests) has no ramp to give
    /// and should not have to say so. `None`/an identity ramp leaves the source
    /// exactly as opened — see [`Retime::new`].
    pub(crate) fn with_speed(
        mut self,
        segments: &[AudioSpeedSegment],
        out_rate: u32,
        out_channels: usize,
    ) -> Self {
        self.retime = Retime::new(segments, out_rate, out_channels);
        self
    }
}

/// How many interleaved output samples a clip of `duration_secs` covers at the
/// session's `(out_rate, out_channels)` — the clip out-point arithmetic behind
/// [`DecodedSource::remaining`] (B-048 / D-130). A non-finite or negative
/// duration is zero samples (nothing to play), not a panic or a wrap. Pure — no
/// I/O.
pub(crate) fn clip_limit_samples(duration_secs: f64, out_rate: u32, out_channels: usize) -> usize {
    if !duration_secs.is_finite() || duration_secs <= 0.0 {
        return 0;
    }
    (duration_secs * out_rate as f64) as usize * out_channels.max(1)
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
///
/// **D-147/D-149 — each source's gain envelopes are applied to its own buffer
/// BEFORE [`mix_sources`] sees it**, so `mix_sources` itself is completely
/// untouched: every one of D-057's headroom guarantees, and its byte-identical
/// single-source unity-gain passthrough, stand exactly as they were. A source
/// with neither a fade nor a duck (every clip in every pre-D-147 project)
/// skips the per-sample pass entirely, so that mix runs the same arithmetic it
/// always did — see [`SourceEnvelopes::apply`], where the two compose.
///
/// `pos_frames` is how many output sample-frames the session has already
/// produced, which is where the envelopes are evaluated from.
fn mix_chunk(
    decoded: &mut [DecodedSource],
    gains: &[f32],
    // D-224 — `&mut`, because an EQ carries state across chunks (a biquad's
    // own history) where the three gain envelopes are pure functions of time.
    envelopes: &mut [SourceEnvelopes],
    chunk_len: usize,
    out_channels: usize,
    pos_frames: u64,
    out_rate: u32,
) -> Result<Vec<f32>, String> {
    let mut bufs: Vec<Vec<f32>> = Vec::with_capacity(decoded.len());
    let mut none = SourceEnvelopes::default();
    for (i, ds) in decoded.iter_mut().enumerate() {
        let mut buf = ds.take(chunk_len, out_channels)?;
        envelopes.get_mut(i).unwrap_or(&mut none).apply(
            &mut buf,
            out_channels,
            pos_frames,
            out_rate,
        );
        bufs.push(buf);
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

/// Runs entirely on the dedicated thread [`start`] spawned for
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
    let mut envelopes: Vec<SourceEnvelopes> = Vec::with_capacity(sources.len());
    for (i, spec) in sources.iter().enumerate() {
        match open_source(
            &spec.path,
            spec.start_secs,
            spec.duration_secs,
            out_rate,
            out_channels,
        ) {
            Ok(ds) => {
                // D-242 — the ramp is attached here, not inside `open_source`,
                // because it needs `out_rate` (the device's, only known now)
                // and because no other caller of `open_source` has one.
                decoded.push(ds.with_speed(&spec.speed, out_rate, out_channels));
                gains.push(spec.gain);
                // D-147/D-149 — index-parallel with `decoded`/`gains`, which is
                // why it is pushed in the same arm: a source that failed to
                // open must not leave its envelopes behind to be applied to the
                // next source's buffer.
                envelopes.push(SourceEnvelopes {
                    fade: spec.fade.clone(),
                    duck: spec.duck.clone(),
                    level: spec.level.clone(),
                    // D-224 — built HERE rather than by the caller, because a
                    // biquad's coefficients are a function of the sample rate
                    // and `out_rate` is not known until the device is open a
                    // few lines above. Per output channel, for the same
                    // reason (see `EqFilter`).
                    eq: EqFilter::new(&spec.eq_bands, out_rate, out_channels),
                });
            }
            Err(e) if i == 0 => return Err(e), // the baseline source failing is a real error
            Err(e) => log::warn!(
                "chroma audio: skipping extra source {}: {e}",
                spec.path.display()
            ),
        }
    }

    // Every non-baseline source failed to open too (or `sources` somehow
    // ended up empty) — nothing to actually mix. Idle rather than erroring,
    // since the caller (`chroma_audio_play`) already treats "nothing to play"
    // as a non-error; the device is simply never started, so this session holds
    // no output stream open while it waits to be told to stop.
    if decoded.is_empty() {
        // Same "a stop landed during warm-up means never make a sound" gate the
        // real path below has (D-130) — this branch used to start the device
        // unconditionally, which opened an output stream for a session that had
        // already been superseded.
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
    // D-147 — output sample-frames produced by this session so far, and the
    // position every fade envelope is evaluated at. It must advance through
    // the skew discard below as well as through the real mixing: those
    // samples represent timeline time that *should already have played*, so
    // an envelope that did not advance through them would run the whole
    // warm-up late for the rest of the session.
    let mut pos_frames: u64 = 0;
    if skew_samples > 0 {
        discard_samples(&mut decoded, skew_samples, out_channels, chunk_len)?;
        pos_frames += (skew_samples / out_channels.max(1)) as u64;
    }

    let prefill_len = (PREFILL_SECS * out_rate as f64) as usize * out_channels.max(1);
    while ring.lock().unwrap_or_else(|e| e.into_inner()).len() < prefill_len
        && !decoded.iter().all(DecodedSource::is_done)
        && is_current(my_gen)
    {
        let mixed = mix_chunk(
            &mut decoded,
            &gains,
            &mut envelopes,
            chunk_len,
            out_channels,
            pos_frames,
            out_rate,
        )?;
        pos_frames += (mixed.len() / out_channels.max(1)) as u64;
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

        let mixed = mix_chunk(
            &mut decoded,
            &gains,
            &mut envelopes,
            chunk_len,
            out_channels,
            pos_frames,
            out_rate,
        )?;
        pos_frames += (mixed.len() / out_channels.max(1)) as u64;

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
pub(crate) fn build_output_stream(
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
                let volume =
                    f32::from_bits(MASTER_VOLUME_BITS.load(std::sync::atomic::Ordering::Relaxed));
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
        let read = || f32::from_bits(MASTER_VOLUME_BITS.load(std::sync::atomic::Ordering::Relaxed));

        set_volume(0.42);
        assert_eq!(read(), 0.42);

        set_volume(-1.0);
        assert_eq!(
            read(),
            0.0,
            "negative volume clamps to silence, not a negative multiplier"
        );

        set_volume(5.0);
        assert_eq!(
            read(),
            1.0,
            "volume above unity clamps to 1.0, not amplified beyond it"
        );

        set_volume(1.0);
        assert_eq!(
            read(),
            1.0,
            "leave MASTER_VOLUME_BITS at real unity for any test that runs after this one"
        );
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

    // --- D-147: clip fades in the mix ------------------------------------ //
    //
    // The envelope's own arithmetic is what lives here. Building one from a
    // timeline clip is `app/src-tauri`'s `chroma::audio::fade_for_clip` — this
    // crate cannot see a `Clip` — and its frames→seconds conversion is tested
    // there.

    /// A 1-second clip that is entirely a linear fade-in, at whatever rate the
    /// test hands [`SourceEnvelopes::apply`] — small enough that every expected
    /// value is hand-checkable.
    fn whole_clip_fade_in() -> FadeEnvelope {
        FadeEnvelope {
            offset_secs: 0.0,
            len_secs: 1.0,
            fade_in_secs: 1.0,
            fade_out_secs: 0.0,
            in_curve: EaseCurve::LINEAR,
            out_curve: EaseCurve::LINEAR,
        }
    }

    /// `SourceEnvelopes::apply` scales every channel of a sample-frame by the
    /// same gain, and really does ramp *within* one chunk — the per-sample-frame
    /// resolution that keeps a fade from stepping audibly.
    #[test]
    fn apply_ramps_within_a_chunk_and_scales_channels_together() {
        let env = whole_clip_fade_in();
        let mut buf = vec![1.0f32; 8 * 2]; // 8 sample-frames, stereo
        SourceEnvelopes {
            fade: Some(env),
            duck: None,
            level: None,
            eq: None,
        }
        .apply(&mut buf, 2, 0, 8);
        for f in 0..8 {
            let expected = f as f32 / 8.0;
            assert!(
                (buf[f * 2] - expected).abs() < 1e-6,
                "frame {f}: {}",
                buf[f * 2]
            );
            assert_eq!(buf[f * 2], buf[f * 2 + 1], "both channels share one gain");
        }
        // strictly increasing — a real ramp, not a per-chunk step
        assert!(buf[0] < buf[7 * 2]);
    }

    /// `session_frame` offsets the whole chunk, which is what makes the second
    /// chunk of a session continue the ramp instead of restarting it — and, by
    /// the same arithmetic, what makes `run_session` advancing `pos_frames`
    /// through `discard_samples` keep a fade aligned across D-125's skew
    /// compensation.
    #[test]
    fn apply_continues_the_ramp_across_chunks() {
        let env = whole_clip_fade_in();
        let mut second = vec![1.0f32; 4];
        // sample-frames 4..8 of 8
        SourceEnvelopes {
            fade: Some(env),
            duck: None,
            level: None,
            eq: None,
        }
        .apply(&mut second, 1, 4, 8);
        for (i, v) in second.iter().enumerate() {
            let expected = (4 + i) as f32 / 8.0;
            assert!((v - expected).abs() < 1e-6, "sample {i}: {v}");
        }
    }

    /// **The backward-compatibility case, at the mixer.** A source with no
    /// envelope of EITHER kind is byte-identical through [`mix_chunk`]'s
    /// envelope step to what it was before D-147/D-149 — the both-`None` case
    /// returns without touching the buffer at all, which is why `None` and "an
    /// envelope that returns 1.0" are not the same thing here.
    #[test]
    fn a_source_with_no_envelope_is_left_exactly_alone() {
        let original = vec![0.3f32, -0.7, 0.9, -0.1];
        let mut buf = original.clone();
        SourceEnvelopes::default().apply(&mut buf, 2, 0, 48_000);
        assert_eq!(buf, original, "no envelope must mean no arithmetic at all");
    }

    // --- D-149: ducking ---------------------------------------------------- //
    //
    // The smoother and the dB conversion are what live here. Turning a trigger
    // TRACK's clip layout into the session-relative second spans `new` takes is
    // `app/src-tauri`'s `chroma::audio::duck_for_track` — this crate cannot see
    // a `Timeline` — and is tested there.

    /// One 1-second trigger span starting 1 s into the session, with a −12 dB
    /// duck and easily-hand-checkable time constants.
    fn one_span_duck() -> DuckEnvelope {
        DuckEnvelope::new(&[(1.0, 2.0)], -12.0, 100.0, 400.0).expect("a real duck")
    }

    #[test]
    fn db_to_linear_matches_the_standard_amplitude_ratios() {
        assert_eq!(db_to_linear(0.0), 1.0, "0 dB must be EXACTLY unity");
        assert!((db_to_linear(-6.0) - 0.501_187).abs() < 1e-6);
        assert!((db_to_linear(-12.0) - 0.251_189).abs() < 1e-6);
        assert!((db_to_linear(-20.0) - 0.1).abs() < 1e-12);
        assert!(
            (db_to_linear(6.0) - 1.995_262).abs() < 1e-6,
            "a boost is allowed"
        );
        assert_eq!(db_to_linear(f64::NAN), 1.0, "nonsense degrades to unity");
    }

    /// **The one-pole is real, and this is the proof.** The closed form
    /// [`DuckEnvelope`] evaluates is the exact solution of the discrete
    /// recursion `y += a·(x − y)` with `a = 1 − e^(−1/(τ·fs))`; running that
    /// recursion sample by sample must land on the same numbers. This is what
    /// makes "a one-pole smoother with attack/release time constants" a checked
    /// claim rather than a description, and it is why the envelope can be
    /// sample-rate independent without being a different filter.
    #[test]
    fn the_closed_form_is_the_one_pole_recursion() {
        let tau = 0.05f64;
        let fs = 48_000.0f64;
        let a = 1.0 - (-1.0 / (tau * fs)).exp();
        let mut y = 0.0f64; // starting from silence, heading for full duck
        for n in 1..=(fs as usize / 10) {
            y += a * (1.0 - y);
            let t = n as f64 / fs;
            let closed = decay(0.0, 1.0, t, tau);
            assert!(
                (y - closed).abs() < 1e-9,
                "sample {n}: recursion {y} vs closed form {closed}"
            );
        }
    }

    /// τ is the 63.2% time by definition — one time constant covers `1 − 1/e`
    /// of the distance to the target, which is the number the `attack_ms` /
    /// `release_ms` fields actually mean.
    #[test]
    fn one_time_constant_covers_63_percent_of_the_distance() {
        let reached = decay(0.0, 1.0, 0.1, 0.1);
        assert!((reached - (1.0 - std::f64::consts::E.recip())).abs() < 1e-12);
        assert!((reached - 0.632_120).abs() < 1e-6);
    }

    /// **Attack is faster than release, and the envelope proves it rather than
    /// just being configured that way.** The same elapsed time after the
    /// trigger starts covers far more of the distance than after it stops.
    #[test]
    fn attack_engages_faster_than_release_recovers() {
        let env = one_span_duck(); // attack 100 ms, release 400 ms
        // 100 ms after the trigger starts: one attack τ in, 63.2% ducked.
        let engaging = env.presence_at(1.1);
        // 100 ms after it stops: a quarter of a release τ, ~22% recovered.
        // (The exact figure is 1 − 0.9999546·e^(−0.25), not 1 − e^(−0.25): the
        // attack had one full second, i.e. ten τ, and ten τ is 0.99995 of the
        // way down, not all of it. An exponential never actually arrives, and
        // the envelope is not quietly rounded to pretend otherwise.)
        let recovering = 1.0 - env.presence_at(2.1);
        assert!(
            (engaging - 0.632_120).abs() < 1e-5,
            "attack after one τ: {engaging}"
        );
        assert!(
            (recovering - 0.221_235).abs() < 1e-5,
            "release after a quarter τ: {recovering}"
        );
        assert!(
            engaging > recovering * 2.0,
            "the whole point of two time constants: {engaging} vs {recovering}"
        );
    }

    /// The envelope is **continuous** — no step at any boundary, which is the
    /// entire reason the smoother exists. Checked as "no adjacent pair of
    /// output sample-frames jumps more than a hair," swept across both
    /// transitions at a real output rate.
    #[test]
    fn the_envelope_never_steps_at_a_clip_boundary() {
        let env = one_span_duck();
        let fs = 48_000.0;
        let mut prev = env.gain_at(0.0);
        let mut worst = 0.0f32;
        for n in 1..(3.0 * fs) as usize {
            let g = env.gain_at(n as f64 / fs);
            worst = worst.max((g - prev).abs());
            prev = g;
        }
        // One sample of the fastest ramp here (τ = 100 ms over a 0.749 range)
        // moves ~1.6e-4; a raw step would be the whole 0.749.
        assert!(worst < 1e-3, "biggest single-sample gain jump: {worst}");
    }

    /// Unity outside the duck, and the full dB reduction once the smoother has
    /// settled well inside a long trigger span.
    #[test]
    fn gain_settles_at_unity_outside_and_the_full_reduction_inside() {
        let env = DuckEnvelope::new(&[(1.0, 5.0)], -12.0, 10.0, 300.0).expect("a real duck");
        assert!(
            (env.gain_at(0.0) - 1.0).abs() < 1e-6,
            "un-ducked before the trigger"
        );
        // 3.9 s into the span is 390 attack τ — settled to the floor.
        assert!(
            (env.gain_at(4.9) - 0.251_189).abs() < 1e-5,
            "−12 dB = 0.2512 linear, got {}",
            env.gain_at(4.9)
        );
        // 3 s past the end is 10 release τ — back to unity.
        assert!((env.gain_at(8.0) - 1.0).abs() < 1e-4, "recovered");
    }

    /// **Starting inside a trigger clip starts already ducked**, not ramping in
    /// from unity — the duck's counterpart of `FadeEnvelope::offset_secs`. A
    /// span reaching back before the playhead arrives here with a negative
    /// start.
    #[test]
    fn a_session_beginning_mid_trigger_starts_fully_ducked() {
        let env = DuckEnvelope::new(&[(-3.0, 2.0)], -12.0, 10.0, 300.0).expect("a real duck");
        assert_eq!(env.presence_at(0.0), 1.0);
        assert!((env.gain_at(0.0) - 0.251_189).abs() < 1e-5);
    }

    /// Two abutting trigger clips are ONE stretch of speech: the duck holds
    /// across the seam instead of releasing and re-attacking. The merging that
    /// makes this true is `Track::clip_spans_from`'s, but the envelope has to
    /// honour it, so this pins the behaviour from `new`'s input onward.
    #[test]
    fn abutting_trigger_spans_hold_the_duck_across_the_seam() {
        let merged = DuckEnvelope::new(&[(0.0, 4.0)], -12.0, 10.0, 300.0).expect("duck");
        // The seam at 2.0 s: fully settled, no recovery bump at all.
        assert!((merged.presence_at(2.0) - 1.0).abs() < 1e-6);
        // For contrast: an unmerged pair with even a 100 ms hole visibly lets go.
        let split = DuckEnvelope::new(&[(0.0, 2.0), (2.1, 4.0)], -12.0, 10.0, 300.0).expect("duck");
        assert!(
            split.presence_at(2.1) < 0.75,
            "a real gap must release: {}",
            split.presence_at(2.1)
        );
    }

    /// **The backward-compatibility gate.** Every "configured but inert" shape
    /// returns `None`, not an envelope that happens to compute 1.0 — which is
    /// what keeps those sources on `mix_chunk`'s untouched-buffer path.
    #[test]
    fn an_inert_duck_is_none_rather_than_a_unity_envelope() {
        assert!(
            DuckEnvelope::new(&[(0.0, 1.0)], 0.0, 10.0, 300.0).is_none(),
            "0 dB"
        );
        assert!(
            DuckEnvelope::new(&[], -12.0, 10.0, 300.0).is_none(),
            "no trigger clips"
        );
        assert!(
            DuckEnvelope::new(&[(-5.0, -1.0)], -12.0, 10.0, 300.0).is_none(),
            "every trigger span is behind the playhead"
        );
        assert!(
            DuckEnvelope::new(&[(1.0, 1.0)], -12.0, 10.0, 300.0).is_none(),
            "an empty span triggers nothing"
        );
        assert!(
            DuckEnvelope::new(&[(0.0, 1.0)], f32::NAN, 10.0, 300.0).is_none(),
            "a nonsense dB degrades to no duck, not to a NaN gain"
        );
    }

    /// A `0 ms` time constant is "instant", not `NaN` — the floor
    /// [`MIN_DUCK_TAU_SECS`] exists for exactly this, since a user can type it.
    #[test]
    fn a_zero_millisecond_time_constant_is_instant_not_nan() {
        let env = DuckEnvelope::new(&[(1.0, 2.0)], -12.0, 0.0, 0.0).expect("duck");
        for t in [0.0, 0.999, 1.0, 1.5, 2.0, 2.001, 3.0] {
            assert!(env.gain_at(t).is_finite(), "gain at {t} must be finite");
        }
        assert!(
            (env.gain_at(1.001) - 0.251_189).abs() < 1e-5,
            "down immediately"
        );
        assert!((env.gain_at(2.001) - 1.0).abs() < 1e-5, "back immediately");
    }

    /// **Fades and ducks compose by multiplication, in one pass.** A clip at
    /// half its fade AND fully ducked comes out at the product; neither
    /// envelope silently overrides the other.
    #[test]
    fn a_fade_and_a_duck_multiply_together() {
        let fade = whole_clip_fade_in(); // linear over 1 s, so gain == t
        let duck = DuckEnvelope::new(&[(-1.0, 10.0)], -6.0, 1.0, 1.0).expect("duck");
        // Settled from the first sample (the span already covers the playhead).
        let ducked = duck.gain_at(0.5) as f64;
        let mut buf = vec![1.0f32; 8]; // 8 mono sample-frames at 8 Hz = 1 s
        SourceEnvelopes {
            fade: Some(fade),
            duck: Some(duck.clone()),
            level: None,
            eq: None,
        }
        .apply(&mut buf, 1, 0, 8);
        let expected = 0.5 * ducked; // the fade at t = 0.5 is 0.5
        assert!(
            (buf[4] as f64 - expected).abs() < 1e-6,
            "frame 4: {} vs {expected}",
            buf[4]
        );
        // and the duck alone, on an un-faded source, is just the duck
        let mut plain = vec![1.0f32; 8];
        SourceEnvelopes {
            fade: None,
            duck: Some(duck.clone()),
            level: None,
            eq: None,
        }
        .apply(&mut plain, 1, 0, 8);
        assert!((plain[4] as f64 - ducked).abs() < 1e-6);
    }

    /// A duck ramps *within* a chunk and continues across chunk boundaries, the
    /// same per-sample-frame property the fade has — `session_frame` is the only
    /// thing that positions it, which is what makes `run_session` advancing
    /// `pos_frames` through `discard_samples` keep a duck aligned across
    /// D-125's skew compensation.
    #[test]
    fn a_duck_ramps_within_and_across_chunks() {
        // The trigger starts 0.5 s in, i.e. four sample-frames into the first
        // chunk at the 8 Hz rate below — so the duck engages mid-chunk rather
        // than being already settled at the session's first sample.
        let duck = DuckEnvelope::new(&[(0.5, 10.0)], -12.0, 500.0, 500.0).expect("duck");
        let mut first = vec![1.0f32; 8];
        let mut envs = SourceEnvelopes {
            fade: None,
            duck: Some(duck),
            level: None,
            eq: None,
        };
        envs.apply(&mut first, 1, 0, 8);
        let mut second = vec![1.0f32; 8];
        envs.apply(&mut second, 1, 8, 8);
        assert!(first[0] > first[7], "engaging within the chunk");
        assert!(
            second[0] < first[7],
            "the second chunk continues rather than restarting: {} then {}",
            first[7],
            second[0]
        );
        assert!(second[7] < second[0]);
    }

    // -------------------------------------------------------------------
    // D-223 — per-clip volume + pan
    // -------------------------------------------------------------------

    /// The migration contract, checked at the constructor rather than asserted
    /// in prose: an untouched clip gets NO envelope, which is what keeps
    /// [`SourceEnvelopes::apply`]'s early return (and therefore the pre-D-223
    /// mix, bit for bit) on the common path.
    #[test]
    fn an_unset_level_builds_no_envelope_at_all() {
        assert!(LevelEnvelope::new(0.0, LevelCurve::Const(1.0), LevelCurve::Const(0.0)).is_none());
        // …and a keyframed curve whose every key IS the identity is the same
        // thing — an agent that keyed volume at 1.0 everywhere changed nothing.
        assert!(
            LevelEnvelope::new(
                0.0,
                LevelCurve::Keys(vec![(0.0, 1.0), (2.0, 1.0)]),
                LevelCurve::Const(0.0)
            )
            .is_none()
        );
        // A real value, on either field alone, does build one.
        assert!(LevelEnvelope::new(0.0, LevelCurve::Const(0.5), LevelCurve::Const(0.0)).is_some());
        assert!(LevelEnvelope::new(0.0, LevelCurve::Const(1.0), LevelCurve::Const(-1.0)).is_some());
    }

    /// Automation keys interpolate linearly between the bracketing pair and
    /// **hold flat outside** them — the exact contract
    /// `chroma::keyframes::interpolate_param` (the authoring/preview side) and
    /// `piecewiseLinearExpr` (the exporter) both implement, so one keyframed
    /// volume means one thing in all three.
    #[test]
    fn a_keyed_level_curve_interpolates_linearly_and_holds_outside() {
        let c = LevelCurve::Keys(vec![(1.0, 0.0), (3.0, 1.0)]);
        assert_eq!(c.value_at(0.0), 0.0, "held before the first key");
        assert_eq!(c.value_at(1.0), 0.0);
        assert!((c.value_at(2.0) - 0.5).abs() < 1e-12, "midpoint");
        assert_eq!(c.value_at(3.0), 1.0);
        assert_eq!(c.value_at(9.0), 1.0, "held after the last key");
    }

    /// A pan really moves signal BETWEEN channels — the property that
    /// separates a real pan from "a second volume control". Hard left leaves
    /// the right channel at exactly zero and the left one ABOVE unity (the
    /// 0 dB-centre normalisation `chroma_types::pan` documents), and the two
    /// channels of one sample-frame get different numbers, which nothing else
    /// in this mixer does.
    #[test]
    fn a_hard_left_pan_silences_the_right_channel_and_boosts_the_left() {
        // 4 stereo sample-frames, every sample at 1.0.
        let mut buf = vec![1.0f32; 8];
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: LevelEnvelope::new(0.0, LevelCurve::Const(1.0), LevelCurve::Const(-1.0)),
            eq: None,
        }
        .apply(&mut buf, 2, 0, 8);
        for f in 0..4 {
            assert!(
                (buf[f * 2] - std::f32::consts::SQRT_2).abs() < 1e-6,
                "left {}",
                buf[f * 2]
            );
            assert_eq!(buf[f * 2 + 1], 0.0, "right");
        }
    }

    /// Centre + unity is a **bit-exact** no-op even when the envelope is built
    /// (it can be, if the other field is non-identity) — `pan_gains(0.0)` is
    /// exactly `(1.0, 1.0)`, not something that rounds to it.
    #[test]
    fn a_centred_half_volume_scales_both_channels_identically() {
        let mut buf = vec![1.0f32; 8];
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: LevelEnvelope::new(0.0, LevelCurve::Const(0.5), LevelCurve::Const(0.0)),
            eq: None,
        }
        .apply(&mut buf, 2, 0, 8);
        assert!(buf.iter().all(|&s| s == 0.5), "{buf:?}");
    }

    /// The composition order this feature is defined by:
    /// `fade × duck × clip volume`, then the pan law per channel. Checked as
    /// arithmetic against the individually-evaluated stages, so a future
    /// reordering that changed the result would fail here rather than sound
    /// subtly wrong.
    #[test]
    fn clip_volume_and_pan_multiply_with_the_fade_and_the_duck() {
        let fade = whole_clip_fade_in(); // linear over 1 s, so gain == t
        let duck = DuckEnvelope::new(&[(-1.0, 10.0)], -6.0, 1.0, 1.0).expect("duck");
        let ducked = duck.gain_at(0.5) as f64;
        let level = LevelEnvelope::new(0.0, LevelCurve::Const(0.5), LevelCurve::Const(-0.5))
            .expect("a real level");
        let (vol, l, r) = level.gains_at(0.5);

        let mut buf = vec![1.0f32; 16]; // 8 stereo frames at 8 Hz = 1 s
        SourceEnvelopes {
            fade: Some(fade),
            duck: Some(duck),
            level: Some(level),
            eq: None,
        }
        .apply(&mut buf, 2, 0, 8);

        let common = 0.5 * ducked * vol as f64; // fade at t=0.5 is 0.5
        assert!(
            (buf[8] as f64 - common * l as f64).abs() < 1e-6,
            "left {} vs {}",
            buf[8],
            common * l as f64
        );
        assert!(
            (buf[9] as f64 - common * r as f64).abs() < 1e-6,
            "right {} vs {}",
            buf[9],
            common * r as f64
        );
    }

    /// A **mono output device** ignores pan and keeps the volume — see
    /// [`SourceEnvelopes::apply`]'s own doc for why losing the audio (which
    /// applying the left multiplier alone would do to a hard-right pan) is the
    /// wrong answer.
    #[test]
    fn a_mono_output_device_ignores_pan_but_still_honours_volume() {
        let mut buf = vec![1.0f32; 4];
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: LevelEnvelope::new(0.0, LevelCurve::Const(0.5), LevelCurve::Const(1.0)),
            eq: None,
        }
        .apply(&mut buf, 1, 0, 8);
        assert!(buf.iter().all(|&s| s == 0.5), "{buf:?}");
    }

    /// A keyframed volume really ramps *within* a chunk and continues across
    /// chunk boundaries — the same per-sample-frame property the fade and the
    /// duck have, and the reason automation cannot be a per-chunk step (that
    /// would be zipper noise).
    #[test]
    fn a_keyframed_volume_ramps_within_and_across_chunks() {
        // 0 → 1 over two seconds; at 8 Hz that is 16 sample-frames.
        let level = LevelEnvelope::new(
            0.0,
            LevelCurve::Keys(vec![(0.0, 0.0), (2.0, 1.0)]),
            LevelCurve::Const(0.0),
        )
        .expect("a real level");
        let mut envs = SourceEnvelopes {
            fade: None,
            duck: None,
            level: Some(level),
            eq: None,
        };
        let mut first = vec![1.0f32; 8];
        envs.apply(&mut first, 1, 0, 8);
        let mut second = vec![1.0f32; 8];
        envs.apply(&mut second, 1, 8, 8);
        for f in 0..8 {
            assert!((first[f] - f as f32 / 16.0).abs() < 1e-6, "first[{f}]");
            assert!(
                (second[f] - (8 + f) as f32 / 16.0).abs() < 1e-6,
                "second[{f}]"
            );
        }
    }

    /// `offset_secs` is what makes pressing Play *inside* an automation ramp
    /// start part-way up it rather than at its beginning — the same property
    /// `a_mid_fade_play_starts_part_way_down_the_ramp` pins for a fade.
    #[test]
    fn a_mid_ramp_play_starts_part_way_up_the_automation() {
        let level = LevelEnvelope::new(
            1.0, // playback starts 1 s into the clip
            LevelCurve::Keys(vec![(0.0, 0.0), (2.0, 1.0)]),
            LevelCurve::Const(0.0),
        )
        .expect("a real level");
        let (vol, l, r) = level.gains_at(0.0);
        assert!((vol - 0.5).abs() < 1e-6, "{vol}");
        assert_eq!((l, r), (1.0, 1.0));
    }

    // --- D-224: per-clip parametric EQ ------------------------------------ //
    //
    // The cookbook coefficients and the analytic response are `chroma_types::
    // eq`'s own tests. What lives here is everything the MIXER adds on top of
    // them: per-channel state, state that survives a chunk boundary, the
    // stage's position in the chain, and the "no active band ⇒ no arithmetic"
    // contract every other envelope in this file also holds to.

    /// The reference band set both engines measure, mirroring
    /// `chroma_types::eq`'s own `reference_band_set` and
    /// `timelineExport.ffmpeg.test.ts`'s `REFERENCE_EQ_BANDS` exactly.
    fn reference_eq_bands() -> Vec<EqBand> {
        use chroma_types::EqBandKind;
        vec![
            EqBand {
                kind: EqBandKind::HighPass,
                freq_hz: 90.0,
                gain_db: 0.0,
                q: 0.71,
                enabled: true,
            },
            EqBand {
                kind: EqBandKind::Peak,
                freq_hz: 950.0,
                gain_db: -6.5,
                q: 1.8,
                enabled: true,
            },
            EqBand {
                kind: EqBandKind::HighShelf,
                freq_hz: 6_200.0,
                gain_db: 5.5,
                q: 0.62,
                enabled: true,
            },
            EqBand {
                kind: EqBandKind::LowShelf,
                freq_hz: 400.0,
                gain_db: 18.0,
                q: 0.9,
                enabled: false,
            },
        ]
    }

    /// **The real proof at the mixer, not at the math.** A sine goes through
    /// `SourceEnvelopes::apply` — the same code path a playing clip's samples
    /// take, in the same 1024-frame chunks — and the measured RMS gain matches
    /// the table `packages/editor/src/timelineExport.ffmpeg.test.ts` asserts
    /// against a REAL exported file for the same bands.
    ///
    /// Chunked deliberately: doing it in one buffer would pass even if the
    /// filter state were rebuilt per chunk, which is the exact defect this
    /// arrangement is here to catch.
    #[test]
    fn the_mixer_applies_the_response_the_export_measures_on_a_real_file() {
        const RATE: u32 = 48_000;
        // The same table `chroma_types::eq::tests::REFERENCE_RESPONSE_DB` and
        // the ffmpeg export test both carry. Kept literal here rather than
        // imported so that a change to any one of the three fails loudly in
        // the other two.
        for (freq, expected) in [
            (50.0f64, -10.5923f64),
            (120.0, -1.1989),
            (300.0, -0.2824),
            (1_000.0, -6.2239),
            (3_000.0, 0.2774),
            (8_000.0, 3.8671),
            (15_000.0, 5.3278),
        ] {
            let mut envs = SourceEnvelopes {
                fade: None,
                duck: None,
                level: None,
                eq: EqFilter::new(&reference_eq_bands(), RATE, 1),
            };
            assert!(envs.eq.is_some(), "the reference set must build a filter");

            let total = RATE as usize * 2; // two seconds
            let settle = total / 2;
            let chunk = 1024;
            let (mut in_sq, mut out_sq) = (0.0f64, 0.0f64);
            let mut pos = 0usize;
            while pos < total {
                let n = chunk.min(total - pos);
                let mut buf: Vec<f32> = (0..n)
                    .map(|i| {
                        (2.0 * std::f64::consts::PI * freq * (pos + i) as f64 / RATE as f64).sin()
                            as f32
                    })
                    .collect();
                let input = buf.clone();
                envs.apply(&mut buf, 1, pos as u64, RATE);
                for i in 0..n {
                    if pos + i >= settle {
                        in_sq += (input[i] as f64).powi(2);
                        out_sq += (buf[i] as f64).powi(2);
                    }
                }
                pos += n;
            }
            let measured = 10.0 * (out_sq / in_sq).log10();
            assert!(
                (measured - expected).abs() < 0.05,
                "{freq} Hz: the mixer measured {measured:.4} dB, the shared table says {expected:.4} dB"
            );
        }
    }

    /// **The backward-compatibility case, again at the mixer.** A clip with no
    /// bands, and a clip carrying the Inspector's materialised-but-untouched
    /// strip, both leave the buffer bit-identical — because neither builds a
    /// filter at all, so `apply` returns before touching it.
    #[test]
    fn a_clip_with_no_active_band_is_left_exactly_alone() {
        use chroma_types::EqBandKind;
        assert!(EqFilter::new(&[], 48_000, 2).is_none());
        // The default strip the Inspector authors: every band a gain-using
        // kind at exactly 0 dB.
        let untouched_strip = [
            EqBand {
                kind: EqBandKind::LowShelf,
                freq_hz: 120.0,
                gain_db: 0.0,
                q: 0.707,
                enabled: true,
            },
            EqBand {
                kind: EqBandKind::Peak,
                freq_hz: 2_500.0,
                gain_db: 0.0,
                q: 1.0,
                enabled: true,
            },
        ];
        assert!(EqFilter::new(&untouched_strip, 48_000, 2).is_none());

        let original = vec![0.3f32, -0.7, 0.9, -0.1];
        let mut buf = original.clone();
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: None,
            eq: EqFilter::new(&untouched_strip, 48_000, 2),
        }
        .apply(&mut buf, 2, 0, 48_000);
        assert_eq!(
            buf, original,
            "an inert strip must mean no arithmetic at all"
        );
    }

    /// Each channel gets its OWN filter state. Without that, the left
    /// channel's history would feed the right channel's output and the stereo
    /// image would collapse — so this feeds two channels completely different
    /// signals and checks each comes out as if it had been filtered alone.
    #[test]
    fn each_channel_is_filtered_through_its_own_state() {
        use chroma_types::EqBandKind;
        let bands = [EqBand {
            kind: EqBandKind::LowPass,
            freq_hz: 500.0,
            gain_db: 0.0,
            q: 0.707,
            enabled: true,
        }];
        // Left is an impulse, right is silence. If the two shared one filter,
        // the right channel would carry the left's ringing.
        let frames = 64;
        let mut stereo = vec![0.0f32; frames * 2];
        stereo[0] = 1.0;
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: None,
            eq: EqFilter::new(&bands, 48_000, 2),
        }
        .apply(&mut stereo, 2, 0, 48_000);

        // The same impulse alone through a mono filter — the reference.
        let mut mono = vec![0.0f32; frames];
        mono[0] = 1.0;
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: None,
            eq: EqFilter::new(&bands, 48_000, 1),
        }
        .apply(&mut mono, 1, 0, 48_000);

        for f in 0..frames {
            assert!(
                (stereo[f * 2] - mono[f]).abs() < 1e-7,
                "frame {f}: left {} vs mono {}",
                stereo[f * 2],
                mono[f]
            );
            assert_eq!(
                stereo[f * 2 + 1],
                0.0,
                "frame {f}: silence picked up the other channel's ringing"
            );
        }
    }

    /// Filter state survives a chunk boundary. A biquad rebuilt every chunk
    /// would restart its ringing at each edge — an audible ~47 Hz buzz at the
    /// real 1024-frame chunk size — so the two-chunk result must equal the
    /// one-buffer result exactly.
    #[test]
    fn filter_state_carries_across_chunk_boundaries() {
        use chroma_types::EqBandKind;
        let bands = [EqBand {
            kind: EqBandKind::HighPass,
            freq_hz: 300.0,
            gain_db: 0.0,
            q: 0.707,
            enabled: true,
        }];
        let signal: Vec<f32> = (0..32)
            .map(|i| (2.0 * std::f64::consts::PI * 100.0 * i as f64 / 48_000.0).sin() as f32)
            .collect();

        let mut whole = signal.clone();
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: None,
            eq: EqFilter::new(&bands, 48_000, 1),
        }
        .apply(&mut whole, 1, 0, 48_000);

        let mut envs = SourceEnvelopes {
            fade: None,
            duck: None,
            level: None,
            eq: EqFilter::new(&bands, 48_000, 1),
        };
        let mut first = signal[..16].to_vec();
        envs.apply(&mut first, 1, 0, 48_000);
        let mut second = signal[16..].to_vec();
        envs.apply(&mut second, 1, 16, 48_000);

        assert_eq!(first, whole[..16], "first chunk");
        assert_eq!(second, whole[16..], "second chunk — state did not carry");
    }

    /// **Order matters, and this pins it.** EQ runs on the source as decoded,
    /// BEFORE the gain stages — the same order `buildAudioSourceChain` emits
    /// (`eq → volume`). A biquad is linear but time-INVARIANT, so filtering a
    /// signal that a fade has already time-varied is a different operation
    /// from fading a filtered one; getting it backwards would make the preview
    /// and the render differ.
    #[test]
    fn the_eq_runs_before_the_gain_stages_not_after() {
        use chroma_types::EqBandKind;
        let bands = [EqBand {
            kind: EqBandKind::LowPass,
            freq_hz: 400.0,
            gain_db: 0.0,
            q: 0.707,
            enabled: true,
        }];
        // A fade-in over the whole buffer: a genuinely time-varying gain, so
        // the two orders give measurably different numbers.
        let fade = FadeEnvelope {
            offset_secs: 0.0,
            len_secs: 1.0,
            fade_in_secs: 1.0,
            fade_out_secs: 0.0,
            in_curve: EaseCurve::LINEAR,
            out_curve: EaseCurve::LINEAR,
        };
        let signal = vec![1.0f32; 8];

        let mut got = signal.clone();
        SourceEnvelopes {
            fade: Some(fade.clone()),
            duck: None,
            level: None,
            eq: EqFilter::new(&bands, 8, 1),
        }
        .apply(&mut got, 1, 0, 8);

        // Expected: filter FIRST, then scale by the fade — computed here the
        // long way round rather than by re-running the code under test.
        let mut eq_only = signal.clone();
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: None,
            eq: EqFilter::new(&bands, 8, 1),
        }
        .apply(&mut eq_only, 1, 0, 8);
        let expected: Vec<f32> = eq_only
            .iter()
            .enumerate()
            .map(|(f, v)| v * fade.gain_at(f as f64 / 8.0))
            .collect();
        for f in 0..8 {
            assert!(
                (got[f] - expected[f]).abs() < 1e-6,
                "frame {f}: {} vs eq-then-fade {}",
                got[f],
                expected[f]
            );
        }

        // …and the other order really is different, so this test is not
        // asserting a coincidence.
        let faded_first: Vec<f32> = signal
            .iter()
            .enumerate()
            .map(|(f, v)| v * fade.gain_at(f as f64 / 8.0))
            .collect();
        let mut then_eq = faded_first;
        SourceEnvelopes {
            fade: None,
            duck: None,
            level: None,
            eq: EqFilter::new(&bands, 8, 1),
        }
        .apply(&mut then_eq, 1, 0, 8);
        assert!(
            got.iter().zip(&then_eq).any(|(a, b)| (a - b).abs() > 1e-6),
            "the two orders are indistinguishable here — pick a signal where they are not"
        );
    }

    /// A surround device gets more channels than a stereo clip's filter was
    /// built for only if something upstream disagreed about `out_channels` —
    /// but the guard is real, and silently reusing another channel's state
    /// would be worse than leaving the extra alone.
    #[test]
    fn a_frame_wider_than_the_filter_leaves_the_extra_channels_untouched() {
        use chroma_types::EqBandKind;
        let mut eq = EqFilter::new(
            &[EqBand {
                kind: EqBandKind::LowPass,
                freq_hz: 500.0,
                gain_db: 0.0,
                q: 0.707,
                enabled: true,
            }],
            48_000,
            2,
        )
        .expect("active");
        let mut frame = [1.0f32, 1.0, 0.25, -0.5];
        eq.process_frame(&mut frame);
        assert_eq!((frame[2], frame[3]), (0.25, -0.5));
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
        let mixed = mix_sources(std::slice::from_ref(&buf), &[1.0], buf.len());
        assert_eq!(mixed, buf);
    }

    #[test]
    fn mix_sources_single_source_nonunity_gain_scales_without_limiting() {
        let buf = vec![0.4f32, -0.4, 0.2];
        let mixed = mix_sources(std::slice::from_ref(&buf), &[0.5], buf.len());
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

    // ------------------------------------------------------------------ //
    // B-048 / D-130 — a source stops at its clip's out-point.
    // ------------------------------------------------------------------ //

    #[test]
    fn clip_limit_samples_converts_seconds_to_interleaved_samples() {
        assert_eq!(clip_limit_samples(1.0, 48_000, 2), 96_000);
        assert_eq!(clip_limit_samples(0.5, 44_100, 1), 22_050);
    }

    #[test]
    fn clip_limit_samples_of_nothing_is_nothing() {
        assert_eq!(clip_limit_samples(0.0, 48_000, 2), 0);
        assert_eq!(clip_limit_samples(-1.0, 48_000, 2), 0);
        assert_eq!(clip_limit_samples(f64::NAN, 48_000, 2), 0);
        assert_eq!(clip_limit_samples(f64::INFINITY, 48_000, 2), 0);
    }

    fn have_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// B-048, the real regression test: a source must fall silent at its
    /// **clip's** out-point, not at the end of the file it happens to live in.
    ///
    /// Real decode, real `symphonia`, the real `open_source`/`take` path — a
    /// 3-second tone opened as a clip covering only its first second. Before
    /// this fix `DecodedSource` had no idea a clip had an out-point and
    /// streamed the file to EOF, so seconds two and three came out as loud as
    /// the first. On the owner's real timeline (a 166-frame screen recording
    /// stacked over a 12414-frame camera take, both starting at frame 0) that
    /// is the first clip's audio still playing underneath the picture after
    /// the compositor cut to the clip below it.
    #[test]
    fn a_source_falls_silent_at_its_clips_out_point_not_the_files_end() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let rate = 48_000u32;
        let channels = 2usize;
        let tone = synth_test_tone(dir.path(), 440, 3.0, rate);

        let mut ds = open_source(&tone, 0.0, Some(1.0), rate, channels)
            .expect("open the tone as a one-second clip");

        let chunk = 1024 * channels;
        let one_second = clip_limit_samples(1.0, rate, channels);
        let mut inside_peak = 0f32;
        let mut outside_peak = 0f32;
        let mut taken = 0usize;
        // Pull two and a half seconds' worth — well past the out-point.
        while taken < one_second * 5 / 2 {
            let buf = ds.take(chunk, channels).expect("take");
            for (i, s) in buf.iter().enumerate() {
                if taken + i < one_second {
                    inside_peak = inside_peak.max(s.abs());
                } else {
                    outside_peak = outside_peak.max(s.abs());
                }
            }
            taken += chunk;
        }

        assert!(
            inside_peak > 0.05,
            "inside the clip the tone must actually be audible (peak {inside_peak})"
        );
        assert_eq!(
            outside_peak, 0.0,
            "past the clip's out-point every sample must be exact silence — anything else is \
             the next part of the file playing under a picture that has already cut away"
        );
        assert!(ds.is_done(), "a source at its out-point is done");
    }

    /// The other half of that contract: `duration_secs: None` (no out-point
    /// known) still streams the whole file, so the change is genuinely scoped
    /// to clips that declare one.
    #[test]
    fn a_source_with_no_out_point_still_plays_past_one_second() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let rate = 48_000u32;
        let channels = 2usize;
        let tone = synth_test_tone(dir.path(), 440, 3.0, rate);

        let mut ds = open_source(&tone, 0.0, None, rate, channels).expect("open with no out-point");
        let chunk = 1024 * channels;
        let one_second = clip_limit_samples(1.0, rate, channels);
        let mut taken = 0usize;
        let mut after_one_second_peak = 0f32;
        while taken < one_second * 2 {
            let buf = ds.take(chunk, channels).expect("take");
            if taken >= one_second {
                after_one_second_peak = buf
                    .iter()
                    .fold(after_one_second_peak, |m, s| m.max(s.abs()));
            }
            taken += chunk;
        }
        assert!(
            after_one_second_peak > 0.05,
            "with no out-point the source keeps playing (peak {after_one_second_peak})"
        );
    }

    // ------------------------------------------------------------------ //
    // B-052 / D-133 — a source starts where it was asked to, even when the
    // container's own seek fails.
    // ------------------------------------------------------------------ //

    #[test]
    fn packet_skip_drops_packets_wholly_before_the_target() {
        // a 1024-frame AAC packet at 48 kHz is ~21.3 ms
        assert_eq!(
            packet_skip(0.0, 0.021_333, 3.0, 48_000),
            PacketSkip::DropWhole
        );
        assert_eq!(
            packet_skip(2.9, 0.021_333, 3.0, 48_000),
            PacketSkip::DropWhole
        );
        // exactly touching the target from below is still wholly before it
        assert_eq!(packet_skip(2.5, 0.5, 3.0, 48_000), PacketSkip::DropWhole);
    }

    #[test]
    fn packet_skip_trims_the_packet_that_straddles_the_target() {
        // starts 10 ms before the target -> drop 480 source frames at 48 kHz
        assert_eq!(
            packet_skip(2.99, 0.021_333, 3.0, 48_000),
            PacketSkip::DropFrames(480)
        );
        // a different source rate scales the frame count, not the time
        assert_eq!(
            packet_skip(2.99, 0.021_333, 3.0, 44_100),
            PacketSkip::DropFrames(441)
        );
    }

    #[test]
    fn packet_skip_at_or_past_the_target_has_arrived() {
        assert_eq!(packet_skip(3.0, 0.021, 3.0, 48_000), PacketSkip::Arrived);
        assert_eq!(packet_skip(4.0, 0.021, 3.0, 48_000), PacketSkip::Arrived);
        // sub-frame difference rounds to nothing to drop, which is "arrived",
        // never `DropFrames(0)` — a distinction `ensure` relies on to stop
        // classifying every subsequent packet.
        assert_eq!(
            packet_skip(3.0 - 1e-9, 0.021, 3.0, 48_000),
            PacketSkip::Arrived
        );
    }

    #[test]
    fn packet_skip_of_uninterpretable_timing_plays_rather_than_discards() {
        assert_eq!(
            packet_skip(f64::NAN, 0.021, 3.0, 48_000),
            PacketSkip::Arrived
        );
        assert_eq!(
            packet_skip(0.0, 0.021, f64::NAN, 48_000),
            PacketSkip::Arrived
        );
        // a non-finite duration is treated as zero-length rather than as
        // covering the target, so the packet is still correctly skipped
        assert_eq!(
            packet_skip(0.0, f64::INFINITY, 3.0, 48_000),
            PacketSkip::DropWhole
        );
    }

    /// Synthesize a `.mov` whose **video track is shorter than its audio
    /// track** — the structural property that makes
    /// `symphonia-format-isomp4-0.6.1` fail a seek outright (its `SeekTo::Time`
    /// seeks every *other* track to the requested time with `?` first, so one
    /// short sibling track poisons the whole call). This is the same failure
    /// the owner's real camera original hits via its 0.042-second metadata
    /// track, reproduced with nothing but `ffmpeg`, since a 2.3 GB camera
    /// original is not something this repo can carry as a fixture (D-050's own
    /// convention: real media is env-var-gated, synthesized media is built at
    /// test time).
    ///
    /// The audio is deliberately **silent for the first `tone_from_secs`
    /// seconds** and a loud 1 kHz tone after it, so "did this source start
    /// where it was asked to" is a question a test can answer from amplitude
    /// alone.
    fn synth_short_video_long_audio(dir: &Path, video_secs: f64, tone_from_secs: f64) -> PathBuf {
        let out = dir.join("short_video.mov");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("testsrc=size=160x120:rate=24:duration={video_secs}"),
                "-f",
                "lavfi",
                "-i",
                &format!(
                    "aevalsrc=if(gte(t\\,{tone_from_secs})\\,0.5*sin(2*PI*1000*t)\\,0):s=48000:d=6"
                ),
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ac",
                "2",
            ])
            .arg(&out)
            .status()
            .expect("spawn ffmpeg to synthesize a short-video/long-audio fixture");
        assert!(status.success(), "ffmpeg fixture synthesis failed");
        out
    }

    /// Open `path`'s audio track and report whether seeking it to `secs`
    /// actually works — the precondition the fixture above exists to create.
    fn container_seek_fails(path: &Path, secs: f64) -> bool {
        let file = std::fs::File::open(path).expect("open fixture");
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
            .expect("probe fixture");
        let track_id = format
            .default_track(TrackType::Audio)
            .expect("fixture has an audio track")
            .id;
        format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time {
                    time: Time::try_from_secs_f64(secs).expect("valid time"),
                    track_id: Some(track_id),
                },
            )
            .is_err()
    }

    /// Peak amplitude of the first `secs` seconds a source hands out.
    fn opening_peak(ds: &mut DecodedSource, secs: f64, rate: u32, channels: usize) -> f32 {
        let want = clip_limit_samples(secs, rate, channels);
        let chunk = 1024 * channels;
        let mut peak = 0f32;
        let mut taken = 0usize;
        while taken < want {
            let buf = ds.take(chunk, channels).expect("take");
            for s in &buf {
                peak = peak.max(s.abs());
            }
            taken += chunk;
        }
        peak
    }

    /// B-052, the real regression test. A source asked to start 3 seconds in
    /// must actually start 3 seconds in — even in a container `symphonia`
    /// refuses to seek, where before D-133 it silently started at 0:00 instead
    /// and every Play replayed the take from the top.
    #[test]
    fn a_source_starts_where_it_was_asked_to_even_when_the_container_seek_fails() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let rate = 48_000u32;
        let channels = 2usize;
        // video 2s, audio 6s, tone from t=2s
        let path = synth_short_video_long_audio(dir.path(), 2.0, 2.0);

        assert!(
            container_seek_fails(&path, 3.0),
            "this fixture only tests anything if symphonia really cannot seek it — if this \
             assertion ever fails, the upstream isomp4 seek was fixed and D-133's fallback \
             should be re-examined rather than the test relaxed"
        );

        // The control: at 0.0 there is nothing to skip to, and the fixture is
        // genuinely silent there. This is exactly what the broken path
        // produced for *every* start time.
        let mut from_zero =
            open_source(&path, 0.0, Some(6.0), rate, channels).expect("open at the start");
        let silent_peak = opening_peak(&mut from_zero, 0.5, rate, channels);
        assert!(
            silent_peak < 0.01,
            "the fixture's first half-second must be silent for this test to mean anything \
             (peak {silent_peak})"
        );

        let mut from_three =
            open_source(&path, 3.0, Some(3.0), rate, channels).expect("open three seconds in");
        let tone_peak = opening_peak(&mut from_three, 0.5, rate, channels);
        assert!(
            tone_peak > 0.1,
            "a source opened at 3.0s must start in the tone, not back at the silent head of \
             the file (peak {tone_peak}) — this is B-052: audio restarting from 0:00 on every \
             Play while the picture carried on from the playhead"
        );
    }

    /// The same property through the batch/waveform path, which had the
    /// identical swallowed seek: two different ranges of a real, unseekable
    /// source must decode to different audio. Env-gated on the owner's own
    /// camera original — the file the bug was actually reported against.
    /// Before D-133 these two came back **byte-identical**, because both
    /// silently decoded from 0:00.
    #[test]
    fn two_ranges_of_a_real_source_decode_to_different_audio() {
        let Ok(video_path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };
        let path = PathBuf::from(&video_path);
        let head = decode_mono_range(&path, 0.0, 0.5).expect("decode the head");
        let later = decode_mono_range(&path, 60.0, 0.5).expect("decode a minute in");
        assert!(
            head.iter().any(|s| s.abs() > 1e-4) || later.iter().any(|s| s.abs() > 1e-4),
            "at least one of the two ranges must be non-silent for this comparison to mean \
             anything"
        );
        let n = head.len().min(later.len());
        assert!(n > 0, "both ranges must decode some samples");
        assert_ne!(
            head[..n],
            later[..n],
            "0s and 60s of the same source must not decode to the same samples — identical \
             output is the signature of a swallowed seek failure (B-052)"
        );
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

    // ---------------------------------------------------------------------- //
    // D-242 — live-preview audio retiming
    // ---------------------------------------------------------------------- //

    /// Synthesize a WAV whose **sample VALUE encodes its own source time**:
    /// `x(t) = t / duration`, a slow linear ramp from 0 to ~1.
    ///
    /// The audio counterpart of `speedRamp.ffmpeg.test.ts`'s "every frame is a
    /// distinct grey" fixture, and it exists for exactly the same reason: it
    /// turns "which part of the source is playing right now" from a question
    /// you have to infer from an envelope or a spectrum into a number you can
    /// read straight off one sample. A retime that plays the wrong part of the
    /// source, at the wrong rate, or in the wrong direction is then off by an
    /// amount the assertion can state in seconds.
    ///
    /// `pcm_s16le` (not a lossy codec) so the value that goes in is the value
    /// that comes back, to within 1/32768 — three orders of magnitude finer
    /// than the tolerances below.
    fn synth_position_ramp_wav(dir: &Path, duration_secs: f64, rate: u32) -> PathBuf {
        let out = dir.join("position-ramp.wav");
        let status = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("aevalsrc=t/{duration_secs}:s={rate}:d={duration_secs}"),
                "-c:a",
                "pcm_s16le",
                "-ac",
                "1",
            ])
            .arg(&out)
            .status()
            .expect("spawn ffmpeg to synthesize a position-ramp fixture");
        assert!(status.success(), "ffmpeg fixture synthesis failed");
        out
    }

    /// Decode `path` through the real `open_source`/`with_speed`/`take` path
    /// and return the retimed OUTPUT as mono samples.
    fn retimed_output(
        path: &Path,
        segments: &[AudioSpeedSegment],
        output_secs: f64,
        rate: u32,
    ) -> Vec<f32> {
        let mut ds = open_source(path, 0.0, Some(output_secs), rate, 1)
            .expect("open the position-ramp fixture")
            .with_speed(segments, rate, 1);
        let mut out = Vec::new();
        // Pulled in the same fixed-size windows `run_session`'s mixing loop
        // uses, so the chunk-boundary behaviour under test is the real one.
        let chunk = 2048;
        while out.len() < (output_secs * rate as f64) as usize {
            let got = ds.take(chunk, 1).expect("take a retimed chunk");
            out.extend(got);
            if ds.is_done() {
                break;
            }
        }
        out
    }

    /// The source second the sample at output second `u` came from, recovered
    /// from its own value — the inverse of the fixture's `x(t) = t/duration`.
    fn source_secs_of(sample: f32, duration_secs: f64) -> f64 {
        sample as f64 * duration_secs
    }

    /// **An INDEPENDENT oracle** for the mixed ramp the two tests below use:
    /// source `[0,1)` forwards, `[1,3)` backwards at 2x, `[3,4)` forwards.
    ///
    /// Hand-written arithmetic rather than a call into the ramp code, and
    /// deliberately so. `chroma-media` sits BELOW `chroma-timeline` in the
    /// D-039 layering and must not depend on it even in a test — but the
    /// stronger reason is that checking [`Retime`] against a second copy of
    /// the same algorithm would prove only that the copy was faithful. Three
    /// lines of "where is playback at second `u`" that anyone can verify by
    /// eye is a real oracle; the shared-definition claim is then carried by
    /// this agreeing with what `speedRampReverse.ffmpeg.test.ts` measures out
    /// of real exported pixels for the identically-shaped ramp.
    fn mixed_ramp_oracle(out_secs: f64) -> f64 {
        if out_secs < 1.0 {
            out_secs // forwards from 0
        } else if out_secs < 2.0 {
            3.0 - (out_secs - 1.0) * 2.0 // entered at 3.0, descending at 2x
        } else {
            3.0 + (out_secs - 2.0) // forwards again from 3.0
        }
    }

    /// **The headline live-retiming proof (D-242): a ramped clip's preview
    /// audio advances through the source at the rate its PICTURE does.**
    ///
    /// Before D-242 this was a stated asymmetry — the picture previewed a ramp
    /// and the mixer played the sound at its recorded rate, so at output second
    /// 1.0 of a 2x clip the picture showed source second 2.0 and the sound was
    /// still at 1.0. This decodes real audio through the real source path and
    /// reads, from the samples themselves, which source second is actually
    /// sounding.
    #[test]
    fn a_sped_up_clip_previews_its_audio_at_the_ramps_own_rate() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let rate = 48_000u32;
        let dur = 4.0;
        let wav = synth_position_ramp_wav(dir.path(), dur, rate);

        // The whole 4 seconds at 2x = 2 seconds of output.
        let segs = [AudioSpeedSegment {
            start_secs: 0.0,
            end_secs: dur,
            speed: 2.0,
        }];
        let out = retimed_output(&wav, &segs, 2.0, rate);
        assert!(
            out.len() >= (1.9 * rate as f64) as usize,
            "expected ~2s of retimed output, got {} samples",
            out.len()
        );

        let mut worst: f64 = 0.0;
        for out_secs in [0.05, 0.25, 0.5, 0.9, 1.0, 1.4, 1.75, 1.9] {
            let idx = (out_secs * rate as f64) as usize;
            let measured = source_secs_of(out[idx], dur);
            // The picture's own answer, from the same model: at 2x, output
            // second u shows source second 2u.
            let expected = out_secs * 2.0;
            worst = worst.max((measured - expected).abs());
        }
        // 2 ms — a twentieth of a video frame at 24 fps. Generous on purpose:
        // the actual measured error is under 50 MICROseconds (the fixture's own
        // s16 quantisation), and the tolerance is set at the level below which
        // nothing is audible rather than at the level the implementation
        // happens to hit. None of the ways this could really be wrong is
        // anywhere near it: no retime at all is 1.9 s out at the end (see the
        // negative control below), half the rate is 0.95 s out, and the wrong
        // direction is 3.8 s out.
        assert!(
            worst < 0.002,
            "retimed audio is {worst:.4}s away from the source second the picture shows"
        );
    }

    /// The **negative control** for the test above: with the retime removed,
    /// the same fixture and the same assertions must be wrong by a lot. Without
    /// this, "within 2 ms" proves nothing — a broken measurement that always
    /// returned the expected value would pass just as well.
    #[test]
    fn the_unretimed_path_is_wrong_by_seconds_which_is_what_d239_fixed() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let rate = 48_000u32;
        let dur = 4.0;
        let wav = synth_position_ramp_wav(dir.path(), dur, rate);

        // No `with_speed` at all — the pre-D-242 mixer, which is also exactly
        // what an un-ramped clip still does today.
        let mut ds = open_source(&wav, 0.0, Some(2.0), rate, 1).expect("open");
        let mut out = Vec::new();
        while out.len() < 2 * rate as usize {
            out.extend(ds.take(2048, 1).expect("take"));
            if ds.is_done() {
                break;
            }
        }
        let idx = (1.9 * rate as f64) as usize;
        let measured = source_secs_of(out[idx], dur);
        // The picture at 2x is showing source second 3.8 here; the old mixer
        // plays 1.9. That 1.9-second gap IS the bug D-242 closes.
        assert!(
            (measured - 3.8).abs() > 1.5,
            "the un-retimed path should be ~1.9s behind the picture, but read {measured:.3}s"
        );
    }

    /// Reverse (D-241) in the live mixer: the sound must run BACKWARDS through
    /// the source, which is the case a forward-streaming decoder cannot do
    /// without the retime's buffered window.
    #[test]
    fn a_reversed_clip_previews_its_audio_running_backwards() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let rate = 48_000u32;
        let dur = 4.0;
        let wav = synth_position_ramp_wav(dir.path(), dur, rate);

        let segs = [AudioSpeedSegment {
            start_secs: 0.0,
            end_secs: dur,
            speed: -1.0,
        }];
        let out = retimed_output(&wav, &segs, dur, rate);
        assert!(
            out.len() >= (3.9 * rate as f64) as usize,
            "expected ~4s out"
        );

        let mut worst: f64 = 0.0;
        let mut previous = f64::INFINITY;
        for out_secs in [0.05, 0.5, 1.0, 2.0, 3.0, 3.5, 3.9] {
            let idx = (out_secs * rate as f64) as usize;
            let measured = source_secs_of(out[idx], dur);
            worst = worst.max((measured - (dur - out_secs)).abs());
            // ...and it must be strictly DESCENDING, which is the property a
            // merely-mis-scaled forward read could still fail.
            assert!(
                measured < previous,
                "reversed audio must descend through the source: {measured:.3}s after {previous:.3}s"
            );
            previous = measured;
        }
        assert!(
            worst < 0.002,
            "reversed audio is {worst:.4}s from where the picture is"
        );
    }

    /// A MIXED ramp — forward, backwards at 2x, forward — through the real
    /// decode path, checked against `chroma_timeline`'s own remap rather than
    /// against a formula re-spelled here. This is the audio half of what
    /// `speedRampReverse.ffmpeg.test.ts` proves for the picture, on the same
    /// shape of ramp, so a divergence between the two renderers shows up as one
    /// of these two tests failing rather than as a silent desync.
    #[test]
    fn a_mixed_forward_reverse_ramp_tracks_the_picture_run_for_run() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let rate = 48_000u32;
        let dur = 4.0;
        let wav = synth_position_ramp_wav(dir.path(), dur, rate);

        // source [0, 1) forwards, [1, 3) backwards at 2x, [3, 4) forwards
        // -> 1 + 1 + 1 = 3 seconds of output.
        let segs = [
            AudioSpeedSegment {
                start_secs: 0.0,
                end_secs: 1.0,
                speed: 1.0,
            },
            AudioSpeedSegment {
                start_secs: 1.0,
                end_secs: 3.0,
                speed: -2.0,
            },
            AudioSpeedSegment {
                start_secs: 3.0,
                end_secs: 4.0,
                speed: 1.0,
            },
        ];
        let out = retimed_output(&wav, &segs, 3.0, rate);
        assert!(
            out.len() >= (2.9 * rate as f64) as usize,
            "expected ~3s out"
        );

        let mut worst: f64 = 0.0;
        for out_secs in [0.1, 0.5, 0.95, 1.05, 1.5, 1.95, 2.05, 2.5, 2.9] {
            let idx = (out_secs * rate as f64) as usize;
            let measured = source_secs_of(out[idx], dur);
            worst = worst.max((measured - mixed_ramp_oracle(out_secs)).abs());
        }
        assert!(
            worst < 0.002,
            "live audio is {worst:.4}s from the source position the picture shows"
        );

        // And the reversed middle really descends, rather than being a forward
        // read that happens to land near the right values at the sample points.
        let at = |s: f64| source_secs_of(out[(s * rate as f64) as usize], dur);
        assert!(
            at(1.1) > at(1.4) && at(1.4) > at(1.9),
            "the middle run must descend"
        );
        assert!(
            at(2.1) < at(2.5) && at(2.5) < at(2.9),
            "the tail run must ascend again"
        );
    }

    /// An un-ramped source must be left **completely** alone: no retime stage,
    /// so not one interpolation, not one extra buffer. This is the property
    /// that keeps every pre-D-236 project's mix byte-identical, and it is
    /// cheap enough to assert directly.
    #[test]
    fn an_identity_ramp_builds_no_retime_stage_at_all() {
        assert!(Retime::new(&[], 48_000, 2).is_none());
        // One forward run at exactly 1x is the identity — it would only add an
        // interpolation that returns its own input.
        assert!(
            Retime::new(
                &[AudioSpeedSegment {
                    start_secs: 0.0,
                    end_secs: 3.0,
                    speed: 1.0,
                }],
                48_000,
                2
            )
            .is_none()
        );
        // A REVERSED run at 1x is NOT the identity and must build one.
        assert!(
            Retime::new(
                &[AudioSpeedSegment {
                    start_secs: 0.0,
                    end_secs: 3.0,
                    speed: -1.0,
                }],
                48_000,
                2
            )
            .is_some()
        );
        // Nonsense in, nothing out — never a stage that divides by zero.
        assert!(
            Retime::new(
                &[AudioSpeedSegment {
                    start_secs: 0.0,
                    end_secs: 3.0,
                    speed: 0.0,
                }],
                48_000,
                2
            )
            .is_none()
        );
    }

    /// The retime's own map, in isolation and at sample resolution, against
    /// the independent oracle above. Pure arithmetic — no decode, no ffmpeg,
    /// so it runs everywhere and pins the map even where the fixtures cannot
    /// be built.
    #[test]
    fn the_retimes_map_is_the_pictures_map_at_sample_resolution() {
        let rate = 48_000u32;
        let segs = [
            AudioSpeedSegment {
                start_secs: 0.0,
                end_secs: 1.0,
                speed: 1.0,
            },
            AudioSpeedSegment {
                start_secs: 1.0,
                end_secs: 3.0,
                speed: -2.0,
            },
            AudioSpeedSegment {
                start_secs: 3.0,
                end_secs: 4.0,
                speed: 1.0,
            },
        ];
        let retime = Retime::new(&segs, rate, 1).expect("a real ramp builds a stage");
        // Its output length is direction-independent: 1 + 2/2 + 1 = 3 seconds.
        assert_eq!(retime.total_out_frames, 3.0 * rate as f64);

        for k in (0..(3 * rate as usize)).step_by(97) {
            let out_secs = k as f64 / rate as f64;
            let mine = retime.input_frame_at(k as f64) / rate as f64;
            let expected = mixed_ramp_oracle(out_secs);
            assert!(
                (mine - expected).abs() < 1e-9,
                "output second {out_secs}: retime reads source {mine}, expected {expected}"
            );
        }
    }
}
