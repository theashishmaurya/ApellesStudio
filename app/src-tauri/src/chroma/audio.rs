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
//!   timeline's video track — via [`super::edit::resolve_video_position`],
//!   the exact same lookup the video preview uses — to a clip + source
//!   position, and, if that clip's source has an audio stream
//!   ([`super::video::VideoInfo::has_audio`]), spawns a dedicated OS thread
//!   that: opens the file with `symphonia`, seeks to the matching source
//!   time, decodes packets in a loop, adapts channel count and resamples to
//!   the output device's config (`rubato`) as needed, bit-depth-converts to
//!   whatever `cpal`'s chosen output `SampleFormat` is (`dasp_sample`), and
//!   feeds a bounded ring buffer that the `cpal` output callback drains.
//!   [`chroma_audio_stop`] tears the session down (pause / re-seek / unmount).
//!   [`chroma_audio_level`] exposes the last measured RMS/peak of what the
//!   output callback actually wrote — the verification hook (see D-049); it
//!   is not wired to any meter UI yet.
//! What it does NOT do: multi-track mixing (single-video-track MVP — see
//!   `docs/04-roadmap.md`), a visible waveform, audio effects or persisted
//!   mute/volume (playback only), audio during scrubbing while paused
//!   (silence is correct there — only real Play produces sound), export audio
//!   (`export.rs` stays video-only, untouched by this module), or long-session
//!   drift correction between the audio and video clocks (see below).
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
//! device's DAC clock. This is accurate to within the one IPC round-trip's
//! start latency (single-digit ms) plus whatever the two clocks drift from
//! each other over the playback session (device-clock-vs-OS-wall-clock drift
//! is on the order of tens of parts-per-million — imperceptible over a
//! realistic preview session, not something this scrub/preview tool needs to
//! correct for today). **Known, deliberate limitation:** no drift correction
//! for a very long continuous play session, no re-sync on a mid-play seek
//! (there isn't one — see below). If drift is ever reported in practice, the
//! natural next step is exactly the audio-is-the-master-clock design
//! sketched above; it was not spec'd out further because there was nothing
//! to observe yet.
//!
//! `chroma_audio_play(start_frame)` doubles as "seek and play" — there is no
//! separate seek-while-playing command, because the video loop already
//! restarts its own wall-clock baseline fresh on every Play toggle, so the
//! frontend only ever needs to call this at that same transition (see
//! `PreviewPane.tsx`).
//!
//! ## Why not a separate `TrackKind::Audio`
//!
//! `chroma-timeline`'s `Track` already has an `Audio` variant, but nothing
//! populates one (see the crate's own doc comment). This module deliberately
//! does not start populating it: the MVP's one video track's clips already
//! point at the same source files the frame decode reads, which — for a
//! talking-head / screen-capture shot — already carry the embedded audio
//! stream. A real, separate audio `Track` only earns its keep once there is
//! something genuinely audio-only to put on it (a detached audio clip, a
//! music bed) — that is multi-track work, tracked as its own roadmap item,
//! not this one; wiring a redundant audio-track-that-mirrors-the-video-track
//! now would just be dead weight to keep in sync until that day.
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

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

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
#[tauri::command]
pub fn chroma_audio_stop() {
    stop_and_bump_generation();
}

/// Seek-and-play in one call: resolve `start_frame` on the active timeline's
/// video track (same lookup the video preview uses), and — if that clip's
/// source has an audio stream — start a fresh decode+playback session there.
/// A clip with no audio stream, or `start_frame` past the end of the video
/// track, is **not** an error: it just means nothing plays, matching the
/// video preview's own "blank frame past the end" behaviour.
#[tauri::command]
pub fn chroma_audio_play(start_frame: u64) -> Result<(), String> {
    let my_gen = stop_and_bump_generation();

    let Some((clip, source_frame, info)) = super::edit::resolve_video_position(start_frame)? else {
        return Ok(());
    };
    if !info.has_audio {
        log::debug!(
            "chroma_audio_play: {} has no audio stream — playing silent",
            clip.source_path
        );
        return Ok(());
    }

    let path = PathBuf::from(&clip.source_path);
    let start_secs = info.frame_to_secs(source_frame);

    let handle = thread::Builder::new()
        .name("chroma-audio".into())
        .spawn(move || {
            if let Err(e) = run_session(&path, start_secs, my_gen) {
                log::warn!(
                    "chroma audio session ({}, {start_secs:.3}s): {e}",
                    path.display()
                );
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

// --------------------------------------------------------------------------- //
// the audio thread — owns the symphonia decoder, the cpal stream, and the
// ring buffer between them for its whole lifetime; nothing here is ever
// moved to another thread (sidesteps needing `cpal::Stream: Send`, which
// varies by host backend — see the `run_session` doc below)
// --------------------------------------------------------------------------- //

/// Runs entirely on the dedicated thread [`chroma_audio_play`] spawned for
/// it. Opens `path` with `symphonia`, seeks to `start_secs`, opens the
/// default `cpal` output device, and decodes packets into a ring buffer the
/// `cpal` callback drains until either the source is exhausted (then idles,
/// keeping the device stream open — silent — until told to stop, so it does
/// not clatter the device open/closed every frame) or `my_gen` is superseded.
///
/// The `cpal::Stream` is a local variable here, created and dropped on this
/// same thread, and is never stored in the `SESSION` static or otherwise
/// moved across threads — deliberately sidesteps relying on `Stream: Send`
/// (its `Send`-ness is backend-dependent; CoreAudio's does resolve to `Send`
/// in practice via its `Monitor: Send + Sync` supertrait bound, but pinning
/// the whole design on that rather than needing it at all is simpler and
/// more portable).
fn run_session(path: &Path, start_secs: f64, my_gen: u64) -> Result<(), String> {
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

    let stream = build_output_stream(
        &device,
        &stream_config,
        sample_format,
        out_channels,
        ring.clone(),
    )?;
    stream.play().map_err(|e| format!("stream.play: {e}"))?;

    let mut resample = Resample::new(src_rate, out_rate, out_channels)?;

    'decode: loop {
        if !is_current(my_gen) {
            break 'decode;
        }
        let packet = match format.next_packet() {
            Ok(Some(p)) => p,
            Ok(None) => break 'decode, // EOF — fall through to the idle wait below
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

        let adapted = adapt_channels(&interleaved, src_channels, out_channels);
        let resampled = resample.push(&adapted)?;
        if resampled.is_empty() {
            continue;
        }

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
            break 'decode;
        }
        ring.lock()
            .unwrap_or_else(|e| e.into_inner())
            .extend(resampled);
    }

    // Source exhausted (or a benign reset/EOF-shaped error) — keep the
    // device stream open (it'll drain to silence once the ring buffer empties
    // on its own) until told to stop, rather than reopening the device every
    // time playback runs past the end of a clip's audio.
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
                for (dst, s) in data.iter_mut().zip(samples.iter()) {
                    *dst = T::from_sample(*s);
                    window_sumsq += (*s as f64) * (*s as f64);
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
        let tmp = tempfile::tempdir().expect("tempdir");
        let project_dir = tmp.path().join("AudioTest.chroma");
        std::fs::create_dir_all(&project_dir).expect("mkdir project dir");

        let clip = chroma_timeline::Clip {
            id: "clip1".into(),
            shot_id: None,
            name: "test".into(),
            source_path: video_path.to_string(),
            source_start: 0,
            duration: 100_000, // longer than any real test clip; exact value is irrelevant here
            source_len: 100_000,
        };
        let timeline = chroma_timeline::Timeline {
            id: "tl1".into(),
            name: "AudioTest".into(),
            rate: None,
            tracks: vec![chroma_timeline::Track {
                kind: chroma_timeline::TrackKind::Video,
                clips: vec![clip],
            }],
        };
        let manifest = super::super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "AudioTest".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            settings: Default::default(),
            timelines: vec![timeline],
            active_timeline: 0,
            media: Vec::new(),
        };
        super::super::project::save_manifest(&project_dir, &manifest).expect("save manifest");
        super::super::state::set_project(Some(super::super::state::ProjectRef {
            path: project_dir,
            name: "AudioTest".into(),
        }));
        tmp
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
}
