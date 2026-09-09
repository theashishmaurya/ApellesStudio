//! Tape-style audio scrubbing (D-232) — the Edit tab's **position-driven**
//! playback mode, beside [`crate::audio`]'s time-driven one.
//!
//! What it is: while the user is actively dragging the playhead (the timeline
//! cursor, or the player's own position bar), a dedicated thread repeatedly
//! emits a short **grain** of audio read from wherever the playhead is *right
//! now*. Hold the pointer still and the same 60 ms repeats — the characteristic
//! "wow" of a tape head parked against a moving reel; drag, and each successive
//! grain starts further along, which is the scrub sound every NLE has. Reference:
//! `scratch/resolve-reference/scrubbing.jpg` (roadmap item 27, "Audio scrubbing +
//! waveform toggle").
//!
//! What it does: owns one OS thread per scrub gesture. That thread opens the
//! default `cpal` output device once (via [`crate::audio`]'s own
//! `build_output_stream`, so the D-126 master monitoring volume and the D-049
//! rms/peak verification hook apply to a scrub exactly as they do to playback),
//! keeps a decoded PCM **window** of the source around the playhead, and pushes
//! one windowed grain per iteration into the ring buffer the device callback
//! drains. [`update`] is how the frontend moves the read head — a plain store
//! into a mutex, at pointer-move rate.
//!
//! What it does NOT do:
//! - **No varispeed / pitch shift.** A real tape deck's scrub changes pitch with
//!   drag speed. This plays every grain at unity rate. See D-232 for the
//!   weighing — the short version is that a variable-ratio resampler in the
//!   scrub path is a real DSP subsystem, the drag-speed signal derived from
//!   pointer events is noisy, and constant-pitch granular scrub is what
//!   Premiere/Resolve's own playhead drag actually sounds like.
//! - **No mixing.** A scrub monitors exactly ONE source — the clip the frontend
//!   resolved under the playhead — where [`crate::audio::start`] mixes every
//!   active source. Re-anchoring N decoders on every window crossing is N times
//!   the stall, for a monitoring aid whose job is "what is at this frame".
//!   Roadmap follow-up, not a hidden gap. It does now monitor that one source at
//!   the LEVEL the mix would give it ([`ScrubSource::gain`], B-110) — "one
//!   source" was always the deliberate part; "at the wrong loudness" was not.
//! - **No envelopes.** The static level above is the whole of it: fades,
//!   ducking, pan, EQ and keyframed volume are all things [`crate::audio`]'s
//!   mixer runs per sample-frame against a session clock a scrub does not have
//!   (its position comes from the pointer, not from elapsed time).
//! - **No timeline resolution.** Same boundary the whole crate keeps (D-146):
//!   it is handed a path and a source second, never a timeline frame. The
//!   frontend resolves — see D-232 for why that is the right side of the line
//!   here specifically, and not merely the convenient one.
//! - **No separate transport.** A scrub is a third request on
//!   [`crate::audio`]'s existing single-transport generation/`seq` protocol
//!   (D-130), not a parallel subsystem: pressing Play during a scrub, or
//!   starting a scrub during Play, supersedes the other through exactly the
//!   machinery that already makes two plays or a play/stop pair
//!   order-insensitive. That is the load-bearing decision in D-232.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use once_cell::sync::Lazy;

use crate::audio::{
    build_output_stream, is_current, open_source, session_claim, session_install_join,
};

// --------------------------------------------------------------------------- //
// tuning constants — every one of these is a latency/quality trade-off, so each
// says which way it trades
// --------------------------------------------------------------------------- //

/// How much source audio one grain covers. Long enough to carry real pitch
/// information (a 60 ms window holds ~3 cycles of a 50 Hz fundamental and
/// hundreds of a speech formant, so dialogue stays recognisable), short enough
/// that a fast drag does not sound like chopped-up playback.
const GRAIN_SECS: f64 = 0.060;

/// Raised-cosine fade at each end of every grain. Without it, each grain's
/// abrupt start and end is a step discontinuity in the waveform — an audible
/// click per grain, ~17 of them a second. 8 ms is short enough not to hollow
/// out the grain's middle and long enough to remove the click.
const GRAIN_FADE_SECS: f64 = 0.008;

/// How far *behind* the requested position a freshly-decoded window starts, so
/// dragging backwards keeps hitting the window instead of re-anchoring on every
/// grain. Deliberately generous relative to [`WINDOW_SECS`]: backward drags are
/// as common as forward ones and are the case a naive "decode forward from
/// here" window handles worst.
const PRE_ROLL_SECS: f64 = 1.5;

/// Total decoded window length. At 48 kHz stereo this is ~1.5 MB of `f32` — the
/// only real memory this mode holds — and covers `WINDOW_SECS - PRE_ROLL_SECS`
/// = 2.5 s of forward drag before a re-anchor.
const WINDOW_SECS: f64 = 4.0;

/// How many grains the ring buffer is allowed to run ahead of the device before
/// the scrub thread blocks.
///
/// **This is the scrub's latency**, and the trade is direct: fewer grains means
/// the sound tracks the pointer more tightly, but leaves less buffered audio to
/// absorb the ~20–40 ms `symphonia` re-anchor decode, which would then underrun
/// audibly. Three grains ≈ 180 ms of cushion — comfortably more than a
/// re-anchor, and within the range a scrub is expected to feel "attached" at.
const RING_GRAINS: usize = 3;

/// Poll interval while the thread is blocked on backpressure. Well under one
/// grain, so waking up late cannot itself cause an underrun.
const BACKPRESSURE_POLL: Duration = Duration::from_millis(2);

// --------------------------------------------------------------------------- //
// pure logic — unit tested (see the `tests` module at the bottom)
// --------------------------------------------------------------------------- //

/// Grain length in sample-frames at `out_rate`, always at least 1 — the size of
/// every read [`ScrubWindow::read`] performs and every buffer
/// [`apply_grain_envelope`] shapes. Pure — no I/O.
pub(crate) fn grain_frames(out_rate: u32) -> usize {
    ((GRAIN_SECS * out_rate as f64) as usize).max(1)
}

/// Fade length in sample-frames, clamped so the two fades can never overlap
/// (which would make the grain's own peak gain less than unity and audibly
/// duck every grain's centre). Pure — no I/O.
pub(crate) fn fade_frames(out_rate: u32, grain: usize) -> usize {
    ((GRAIN_FADE_SECS * out_rate as f64) as usize).min(grain / 2)
}

/// The source second a window decoded for `at_secs` should begin at — `at_secs`
/// less the pre-roll, floored at the start of the file. Pure — no I/O.
pub(crate) fn anchor_secs(at_secs: f64) -> f64 {
    if !at_secs.is_finite() {
        return 0.0;
    }
    (at_secs - PRE_ROLL_SECS).max(0.0)
}

/// Apply the raised-cosine fade in/out **in place** to one interleaved grain.
///
/// `fade` is in sample-frames and is applied symmetrically: frame `i < fade`
/// scales by `0.5 * (1 - cos(pi * (i + 0.5) / fade))`, and the last `fade`
/// frames mirror it. The half-frame offset means the very first and last
/// sample-frames are near-silent rather than exactly silent, which loses
/// nothing audible and keeps the envelope symmetric about the grain's centre.
/// `fade == 0` leaves the buffer untouched. Pure — no I/O.
pub(crate) fn apply_grain_envelope(grain: &mut [f32], channels: usize, fade: usize) {
    let channels = channels.max(1);
    let frames = grain.len() / channels;
    if fade == 0 || frames == 0 {
        return;
    }
    let ramp = |i: usize| -> f32 {
        let x = (i as f64 + 0.5) / fade as f64;
        (0.5 - 0.5 * (std::f64::consts::PI * x).cos()) as f32
    };
    for i in 0..fade.min(frames) {
        let g = ramp(i);
        for c in 0..channels {
            grain[i * channels + c] *= g;
        }
    }
    for i in 0..fade.min(frames) {
        let g = ramp(i);
        let f = frames - 1 - i;
        for c in 0..channels {
            grain[f * channels + c] *= g;
        }
    }
}

/// Scale one grain by its source's linear level, in place (B-110). A `gain` of
/// exactly 1.0 is the common case and skips the pass entirely; a non-finite or
/// negative value is treated as unity rather than silencing or phase-inverting
/// the monitor, since it can only come from a malformed manifest. Pure — no I/O.
pub(crate) fn apply_gain(grain: &mut [f32], gain: f32) {
    if !gain.is_finite() || gain < 0.0 || gain == 1.0 {
        return;
    }
    for s in grain.iter_mut() {
        *s *= gain;
    }
}

/// One decoded stretch of a source, interleaved at the output device's own
/// `(rate, channels)` — the thing a scrub actually reads its grains out of.
///
/// Held for as long as the playhead stays inside it, which for an ordinary drag
/// is most of the gesture: that is the entire point, since re-anchoring means a
/// fresh `symphonia` probe + seek + decode and everything else here is a memcpy.
pub(crate) struct ScrubWindow {
    path: PathBuf,
    start_secs: f64,
    rate: u32,
    channels: usize,
    /// How many sample-frames of real audio `samples` actually holds. Shorter
    /// than [`WINDOW_SECS`] only when the source ended inside the window.
    frames: usize,
    samples: Vec<f32>,
    /// The decode stopped because the SOURCE ended, not because the window was
    /// full. Without this a playhead parked in the last second of a file would
    /// re-anchor on every single grain forever, since no window can ever cover
    /// a position past the end of the media.
    hit_eof: bool,
}

impl ScrubWindow {
    /// Does this window already hold everything a grain at `at_secs` needs?
    ///
    /// A position past the decoded audio is covered when the source ended
    /// inside this window (see [`Self::hit_eof`]) — reading there yields
    /// silence, which is the correct answer, not a reason to decode again.
    pub(crate) fn covers(&self, path: &Path, at_secs: f64) -> bool {
        if self.path != path || !at_secs.is_finite() || at_secs < self.start_secs {
            return false;
        }
        if self.hit_eof {
            return true;
        }
        let end = self.start_secs + self.frames as f64 / self.rate.max(1) as f64;
        at_secs + GRAIN_SECS <= end
    }

    /// Read `want` interleaved sample-frames starting at source second
    /// `at_secs`, padding with silence for anything outside the decoded range
    /// (before its start, past the source's end, or a window that came back
    /// short). Always returns exactly `want * channels` samples, so the caller's
    /// grain size never depends on where in the source it landed. Pure — no I/O.
    pub(crate) fn read(&self, at_secs: f64, want: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; want * self.channels];
        if !at_secs.is_finite() {
            return out;
        }
        let offset = ((at_secs - self.start_secs) * self.rate as f64).round() as i64;
        for i in 0..want {
            let src = offset + i as i64;
            if src < 0 {
                continue;
            }
            let src = src as usize;
            if src >= self.frames {
                break;
            }
            let from = src * self.channels;
            let to = i * self.channels;
            out[to..to + self.channels].copy_from_slice(&self.samples[from..from + self.channels]);
        }
        out
    }

    /// Decode a fresh window covering `at_secs` (starting [`PRE_ROLL_SECS`]
    /// earlier, so a backward drag stays inside it) at the output device's
    /// `(rate, channels)`.
    ///
    /// Reuses [`open_source`] verbatim — the same probe → seek → channel-adapt →
    /// resample setup a playback source goes through, including B-052/D-133's
    /// packet-timestamp start trim, so a scrub lands on exactly the source
    /// second playback would have. `duration_secs: None`: a scrub window is
    /// bounded by [`WINDOW_SECS`] here, not by any clip out-point — the
    /// frontend never asks for a position outside the clip in the first place,
    /// and a window that pre-rolled across the clip's in-point would otherwise
    /// come back empty.
    fn decode(path: &Path, at_secs: f64, rate: u32, channels: usize) -> Result<Self, String> {
        let start_secs = anchor_secs(at_secs);
        let mut source = open_source(path, start_secs, None, rate, channels)?;
        let want_frames = ((WINDOW_SECS * rate as f64) as usize).max(1);
        let chunk = 4096usize;
        let mut samples: Vec<f32> = Vec::with_capacity(want_frames * channels);
        let mut frames = 0usize;
        let mut hit_eof = false;
        while frames < want_frames {
            if source.is_done() {
                hit_eof = true;
                break;
            }
            let take = chunk.min(want_frames - frames);
            samples.extend(source.take(take * channels, channels)?);
            frames += take;
        }
        Ok(Self {
            path: path.to_path_buf(),
            start_secs,
            rate,
            channels,
            frames,
            samples,
            hit_eof,
        })
    }
}

// --------------------------------------------------------------------------- //
// the scrub target — where the read head is, right now
// --------------------------------------------------------------------------- //

/// Where a scrub should be reading from: a media file and a second inside it.
///
/// Exactly [`crate::audio::AudioSourceSpec`]'s own boundary shape ("a file, a
/// source second"), for exactly the same reason — "which clip is under timeline
/// frame N" is a question this crate deliberately cannot answer (D-146).
#[derive(Clone, Debug, PartialEq)]
pub struct ScrubSource {
    pub path: PathBuf,
    pub source_secs: f64,
    /// The linear level this source is heard at — the same `gain` the mixer
    /// applies to the matching [`crate::audio::AudioSourceSpec`] during
    /// playback, resolved by the frontend as `track.gain × clip.volume`.
    ///
    /// **B-110.** A scrub used to carry no level at all and every grain went
    /// out at unity, so monitoring a track the user had faded down was audibly
    /// louder than playing it — the same clip, at a loudness the timeline does
    /// not have. Only the STATIC level: fades, ducking, pan, EQ and keyframed
    /// volume are envelope/DSP this mode still does not run (see the module
    /// doc's "does NOT do" list).
    pub gain: f32,
}

/// The newest position the frontend has asked for, or `None` when the playhead
/// is somewhere with no audio under it (a gap, a silent clip, past the end) —
/// which is a real, ordinary state that must sound like silence rather than
/// like the last grain repeating forever.
///
/// A plain `Mutex`, not an atomic: it carries a `PathBuf`, and it is touched
/// once per pointer move on one side and once per grain (~17 Hz) on the other —
/// never inside the real-time `cpal` callback, which is the only place a lock
/// would actually be a problem.
static TARGET: Lazy<Mutex<Option<ScrubSource>>> = Lazy::new(|| Mutex::new(None));

fn target() -> Option<ScrubSource> {
    TARGET
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .cloned()
}

/// A claimed scrub transport — the [`crate::audio`] session generation this
/// gesture owns. Mirrors [`crate::audio::PlaySession`], minus its
/// `requested_at`: a scrub has no start-up skew to compensate, because there is
/// no wall-clock video timeline for it to stay aligned with. Its position comes
/// from the pointer, every grain, which is a stronger form of the same sync.
pub struct ScrubSession {
    generation: u64,
}

/// Claim the audio transport for scrub request `seq`, tearing down whatever
/// session — a playback session or an earlier scrub — is running, or return
/// `None` if a **newer** request has already been accepted (D-130).
///
/// This is the whole coexistence story with normal playback, and it is
/// deliberately not a separate protocol: [`crate::audio::stop`],
/// [`crate::audio::begin_play`] and this function all funnel through the same
/// `begin_request`, so "a scrub cannot play over the top of playback" needs no
/// new code and no new invariant — it is the same single-transport rule that
/// already holds between two plays.
pub fn begin(seq: u64) -> Option<ScrubSession> {
    session_claim(seq).map(|generation| ScrubSession { generation })
}

/// Start the scrub thread for a claimed session, reading from `first` until
/// [`update`] moves it.
pub fn start(session: ScrubSession, first: Option<ScrubSource>) -> Result<(), String> {
    let ScrubSession { generation } = session;
    *TARGET.lock().unwrap_or_else(|e| e.into_inner()) = first;
    let handle = thread::Builder::new()
        .name("chroma-audio-scrub".into())
        .spawn(move || {
            if let Err(e) = run_scrub(generation) {
                log::warn!("chroma audio scrub session: {e}");
            }
        })
        .map_err(|e| format!("spawn scrub thread: {e}"))?;
    // The same hand-off `audio::start` makes for a play session, and for the
    // same reason: this thread owns an open `cpal` output stream, so whatever
    // supersedes it must JOIN it before opening one of its own. Without this a
    // scrub thread outlives its own gesture, and the next session's device open
    // races the outgoing one's close.
    session_install_join(generation, handle);
    Ok(())
}

/// Move the read head. Called at pointer-move rate for the whole drag.
///
/// **Deliberately carries no `seq`**, unlike every other transport entry point.
/// The D-130 stamps exist because play and stop are *edge* commands whose
/// effect depends on which one landed last, and Tauri no longer runs them in
/// issue order. A position is a *level*: it is absolute, idempotent, and
/// last-writer-wins is exactly the semantics a scrub wants — an update that
/// arrives out of order and loses is an update the pointer has already moved
/// past. (Its wrapping command is a plain blocking `#[tauri::command]` for the
/// same reason: it only stores into the mutex above, so there is nothing to get
/// off the main thread, and running inline keeps updates in issue order anyway.)
///
/// A no-op when no scrub is running: the value is overwritten by the next
/// [`start`], so a stray late update from a finished gesture cannot leak into
/// the next one.
pub fn update(source: Option<ScrubSource>) {
    *TARGET.lock().unwrap_or_else(|e| e.into_inner()) = source;
}

/// End the scrub gesture — the same [`crate::audio::stop`] a pause issues,
/// because it is the same transport.
pub fn end(seq: u64) {
    crate::audio::stop(seq);
    // Ordering note: `stop` may have been dropped as stale (a newer play/scrub
    // already owns the transport), in which case clearing the target here would
    // silence a scrub that legitimately superseded this one. So the target is
    // NOT cleared — `start` sets it, and a scrub thread that no longer owns the
    // generation exits on its own next iteration regardless of what it holds.
}

// --------------------------------------------------------------------------- //
// the scrub thread
// --------------------------------------------------------------------------- //

/// Runs on the thread [`start`] spawned. Opens the default `cpal` output device
/// once, then loops: read the newest target, make sure a decoded window covers
/// it, cut one enveloped grain out of that window, and push it into the ring
/// buffer the device callback drains — until the generation is superseded.
///
/// The `cpal::Stream` is a local, created and dropped on this same thread and
/// never moved — the same deliberate sidestep of `Stream: Send`
/// `crate::audio`'s `run_session` documents.
fn run_scrub(my_gen: u64) -> Result<(), String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or("no default audio output device")?;
    let supported = device
        .default_output_config()
        .map_err(|e| format!("default_output_config: {e}"))?;
    let sample_format = supported.sample_format();
    let out_rate = supported.sample_rate();
    let out_channels = (supported.channels() as usize).max(1);
    let stream_config: cpal::StreamConfig = supported.into();

    let ring: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::new()));
    let stream = build_output_stream(
        &device,
        &stream_config,
        sample_format,
        out_channels,
        ring.clone(),
    )?;

    let grain = grain_frames(out_rate);
    let fade = fade_frames(out_rate, grain);
    let grain_len = grain * out_channels;
    let high_water = grain_len * RING_GRAINS;

    // A scrub has no prefill: the whole point is that the first grain is
    // audible as soon as it exists. Underrunning for a few ms at the very start
    // is `pull_or_silence`'s ordinary silence padding, not a glitch anyone can
    // hear at the head of a gesture.
    stream.play().map_err(|e| format!("stream.play: {e}"))?;

    let mut window: Option<ScrubWindow> = None;
    // A path whose decode already failed. Retrying it every grain would spend
    // the whole gesture in `symphonia`'s probe for a file that is not going to
    // open; the frontend moving to a different clip clears it.
    let mut failed: Option<PathBuf> = None;

    while is_current(my_gen) {
        if ring.lock().unwrap_or_else(|e| e.into_inner()).len() >= high_water {
            thread::sleep(BACKPRESSURE_POLL);
            continue;
        }

        let Some(at) = target() else {
            // Nothing audible under the playhead. Silence, at the same rate the
            // real grains are produced, so the device keeps a steady stream.
            window = None;
            failed = None;
            ring.lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(std::iter::repeat_n(0.0f32, grain_len));
            continue;
        };

        if failed.as_deref() == Some(at.path.as_path()) {
            ring.lock()
                .unwrap_or_else(|e| e.into_inner())
                .extend(std::iter::repeat_n(0.0f32, grain_len));
            continue;
        }
        failed = None;

        let covered = window
            .as_ref()
            .is_some_and(|w| w.covers(&at.path, at.source_secs));
        if !covered {
            match ScrubWindow::decode(&at.path, at.source_secs, out_rate, out_channels) {
                Ok(w) => window = Some(w),
                Err(e) => {
                    // Not fatal to the gesture: the user is still dragging, and
                    // the next clip along may well open fine.
                    log::warn!("chroma audio scrub: {} — {e}", at.path.display());
                    window = None;
                    failed = Some(at.path.clone());
                    continue;
                }
            }
        }

        let Some(w) = window.as_ref() else { continue };
        let mut buf = w.read(at.source_secs, grain);
        apply_grain_envelope(&mut buf, out_channels, fade);
        // B-110 — the source's own level, applied per grain rather than baked
        // into the window, because the frontend can change it mid-gesture
        // (dragging across a cut into a clip on a quieter track) and a decoded
        // window outlives many grains.
        apply_gain(&mut buf, at.gain);
        ring.lock().unwrap_or_else(|e| e.into_inner()).extend(buf);
    }

    Ok(()) // `stream` drops here, closing the device
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A window with a known, easily-checked signal: sample-frame `i` holds the
    /// value `i` in every channel, so a read's offset arithmetic is readable
    /// straight off the returned numbers.
    fn ramp_window(start_secs: f64, rate: u32, channels: usize, frames: usize) -> ScrubWindow {
        let mut samples = Vec::with_capacity(frames * channels);
        for i in 0..frames {
            for _ in 0..channels {
                samples.push(i as f32);
            }
        }
        ScrubWindow {
            path: PathBuf::from("/fixture.m4a"),
            start_secs,
            rate,
            channels,
            frames,
            samples,
            hit_eof: false,
        }
    }

    // --- grain sizing ----------------------------------------------------- //

    #[test]
    fn a_grain_is_the_configured_length_and_never_zero() {
        assert_eq!(grain_frames(48_000), 2_880); // 60 ms at 48 kHz
        assert_eq!(grain_frames(44_100), 2_646);
        assert_eq!(
            grain_frames(1),
            1,
            "a nonsense rate still yields a real grain"
        );
        assert_eq!(grain_frames(0), 1);
    }

    /// **The two fades can never overlap.** If they did, the grain's own centre
    /// would be scaled below unity and every grain would audibly duck — the
    /// exact failure a naive `min(fade, frames)` would let through for a very
    /// short grain.
    #[test]
    fn the_two_fades_can_never_overlap() {
        assert_eq!(fade_frames(48_000, grain_frames(48_000)), 384); // 8 ms
        let tiny = 10;
        assert!(fade_frames(48_000, tiny) <= tiny / 2);
    }

    // --- the grain envelope ----------------------------------------------- //

    /// Both ends are near-silent, the middle is untouched, and the shape is
    /// monotone into the grain — what stops each grain boundary being an audible
    /// click.
    #[test]
    fn the_grain_envelope_fades_both_ends_and_leaves_the_middle_alone() {
        let frames = 100;
        let fade = 10;
        let mut grain = vec![1.0f32; frames];
        apply_grain_envelope(&mut grain, 1, fade);

        assert!(grain[0] < 0.02, "first frame near-silent, got {}", grain[0]);
        assert!(
            grain[frames - 1] < 0.02,
            "last frame near-silent, got {}",
            grain[frames - 1]
        );
        for i in 0..fade - 1 {
            assert!(grain[i] < grain[i + 1], "fade-in rises at {i}");
            assert!(
                grain[frames - 1 - i] < grain[frames - 2 - i],
                "fade-out rises inward at {i}"
            );
        }
        for g in &grain[fade..frames - fade] {
            assert_eq!(*g, 1.0, "the grain's body must be untouched");
        }
    }

    /// The envelope is per-sample-FRAME, not per sample: with two channels the
    /// same gain lands on both, so the fade cannot introduce a stereo image
    /// wobble.
    #[test]
    fn the_grain_envelope_applies_the_same_gain_to_every_channel() {
        let mut grain = vec![1.0f32; 40 * 2];
        apply_grain_envelope(&mut grain, 2, 5);
        for f in 0..40 {
            assert_eq!(grain[f * 2], grain[f * 2 + 1], "frame {f}");
        }
    }

    #[test]
    fn a_zero_fade_leaves_the_grain_exactly_as_it_was() {
        let mut grain = vec![0.5f32; 20];
        apply_grain_envelope(&mut grain, 1, 0);
        assert!(grain.iter().all(|g| *g == 0.5));
    }

    // --- per-grain level (B-110) ------------------------------------------- //

    /// The whole point of B-110: a source the timeline plays at 0.4 must be
    /// MONITORED at 0.4, not at unity. Before the fix a scrub carried no level
    /// at all, so a faded-down music bed was audibly hotter under the playhead
    /// than it was in playback.
    #[test]
    fn a_grain_is_scaled_by_its_source_level() {
        let mut grain = vec![1.0f32, -0.5, 0.25, -1.0];
        apply_gain(&mut grain, 0.4);
        assert_eq!(grain, vec![0.4, -0.2, 0.1, -0.4]);
    }

    /// Unity is the common case and must be bit-exact, not "multiplied by a
    /// 1.0 we computed" — the same no-op-rather-than-a-pass rule
    /// `FadeEnvelope`'s `None` case follows in `crate::audio`.
    #[test]
    fn a_unity_level_leaves_the_grain_bit_identical() {
        let original = vec![0.3f32, -0.7, 0.0, 1.0];
        let mut grain = original.clone();
        apply_gain(&mut grain, 1.0);
        assert_eq!(grain, original);
    }

    /// A level of exactly zero is a real state (a clip whose own `volume` is 0
    /// on an unmuted track) and must be silence, not a skipped pass.
    #[test]
    fn a_zero_level_is_real_silence() {
        let mut grain = vec![1.0f32, -1.0, 0.5];
        apply_gain(&mut grain, 0.0);
        assert!(grain.iter().all(|s| *s == 0.0));
    }

    /// **A malformed level can only come from a hand-edited manifest, and must
    /// not be able to invert the monitor's phase or NaN the output device.**
    /// Both fall back to unity rather than to silence: losing the level is a
    /// far smaller fault than losing the sound.
    #[test]
    fn a_nonsense_level_falls_back_to_unity_rather_than_inverting_or_nan() {
        for bad in [-1.0f32, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let original = vec![0.5f32, -0.25];
            let mut grain = original.clone();
            apply_gain(&mut grain, bad);
            assert_eq!(grain, original, "level {bad} must be treated as unity");
        }
    }

    // --- window anchoring -------------------------------------------------- //

    #[test]
    fn a_window_anchors_a_pre_roll_behind_the_position_but_never_before_zero() {
        assert_eq!(anchor_secs(10.0), 10.0 - PRE_ROLL_SECS);
        assert_eq!(anchor_secs(0.4), 0.0, "clamped at the head of the file");
        assert_eq!(anchor_secs(f64::NAN), 0.0);
    }

    // --- window coverage --------------------------------------------------- //

    /// The decision that makes a scrub cheap: a position already inside the
    /// decoded window costs a memcpy, and only leaving it costs a real decode.
    #[test]
    fn a_position_inside_the_decoded_window_needs_no_re_decode() {
        let w = ramp_window(2.0, 48_000, 2, 48_000 * 4); // [2s, 6s)
        assert!(w.covers(Path::new("/fixture.m4a"), 3.0));
        assert!(w.covers(Path::new("/fixture.m4a"), 2.0), "its very start");
        assert!(
            !w.covers(Path::new("/fixture.m4a"), 1.9),
            "before the window"
        );
        assert!(
            !w.covers(Path::new("/fixture.m4a"), 5.99),
            "a grain from here would run past the window's end"
        );
        assert!(
            w.covers(Path::new("/fixture.m4a"), 5.9),
            "a grain from here still fits"
        );
    }

    /// A different clip under the playhead is always a re-decode, however well
    /// the seconds happen to line up — the failure this guards is a drag across
    /// a cut silently continuing to monitor the outgoing clip.
    #[test]
    fn a_different_source_never_reuses_the_window() {
        let w = ramp_window(2.0, 48_000, 2, 48_000 * 4);
        assert!(!w.covers(Path::new("/other.m4a"), 3.0));
    }

    /// **Parking in the last second of a file must not re-anchor forever.**
    /// No window can cover a position past the end of the media, so without the
    /// EOF flag every grain there would pay a full probe + seek + decode.
    #[test]
    fn a_window_that_hit_the_end_of_the_source_still_covers_positions_past_it() {
        let mut w = ramp_window(2.0, 48_000, 2, 4_800); // only 0.1 s decoded
        assert!(
            !w.covers(Path::new("/fixture.m4a"), 2.5),
            "short window, source still running: decode more"
        );
        w.hit_eof = true;
        assert!(
            w.covers(Path::new("/fixture.m4a"), 2.5),
            "short because the SOURCE ended: silence is the right answer"
        );
        assert!(
            !w.covers(Path::new("/fixture.m4a"), 1.0),
            "…but a position before the window is still a re-decode"
        );
    }

    // --- reading a grain out of a window ----------------------------------- //

    /// The offset arithmetic: reading at the window's own start second gives
    /// sample-frame 0, and one second later gives frame `rate`.
    #[test]
    fn a_read_lands_on_the_sample_frame_the_source_second_names() {
        let w = ramp_window(2.0, 1_000, 1, 4_000);
        assert_eq!(w.read(2.0, 3), vec![0.0, 1.0, 2.0]);
        assert_eq!(w.read(3.0, 3), vec![1_000.0, 1_001.0, 1_002.0]);
        assert_eq!(w.read(2.5, 2), vec![500.0, 501.0]);
    }

    /// Interleaving is preserved: each sample-frame's channels stay together.
    #[test]
    fn a_stereo_read_keeps_its_frames_interleaved() {
        let w = ramp_window(0.0, 1_000, 2, 100);
        assert_eq!(w.read(0.0, 3), vec![0.0, 0.0, 1.0, 1.0, 2.0, 2.0]);
    }

    /// **A read always returns exactly what was asked for**, whatever it lands
    /// on — otherwise the grain length, and so the scrub's own timing, would
    /// depend on where in the source the pointer happened to be.
    #[test]
    fn a_read_outside_the_decoded_range_is_silence_padded_to_full_length() {
        let w = ramp_window(2.0, 1_000, 2, 1_000); // [2s, 3s)
        let before = w.read(1.998, 4); // 2 frames before the window, then 2 real
        assert_eq!(before.len(), 8);
        assert_eq!(&before[0..4], &[0.0, 0.0, 0.0, 0.0]);
        assert_eq!(&before[4..8], &[0.0, 0.0, 1.0, 1.0]);

        let past = w.read(2.999, 4); // 1 real frame, then past the end
        assert_eq!(past.len(), 8);
        assert_eq!(&past[0..2], &[999.0, 999.0]);
        assert!(past[2..].iter().all(|s| *s == 0.0));

        let far = w.read(100.0, 4);
        assert_eq!(far.len(), 8);
        assert!(far.iter().all(|s| *s == 0.0));

        let nonsense = w.read(f64::NAN, 4);
        assert_eq!(nonsense.len(), 8);
        assert!(nonsense.iter().all(|s| *s == 0.0));
    }

    // --- the target hand-off ----------------------------------------------- //

    /// **The decode half of a scrub, on real media** — deliberately separate
    /// from `app/src-tauri`'s end-to-end `cpal` test, because the two can fail
    /// for completely different reasons and a single "no sound" assertion
    /// cannot tell them apart. This one says only: a real window decoded from a
    /// real file at a real position holds real, non-silent PCM, and a grain cut
    /// out of it survives the envelope.
    ///
    /// Gated on the same `CHROMA_TEST_AUDIO_VIDEO` fixture every other
    /// real-audio test in this repo uses (D-050) — there is no committed binary
    /// audio fixture here by design.
    #[test]
    fn a_real_window_decodes_real_non_silent_audio() {
        let Ok(path) = std::env::var("CHROMA_TEST_AUDIO_VIDEO") else {
            eprintln!(
                "skip: set CHROMA_TEST_AUDIO_VIDEO to run (a real file with an audio stream)"
            );
            return;
        };
        let rate = 48_000u32;
        let channels = 2usize;
        let w = ScrubWindow::decode(Path::new(&path), 1.0, rate, channels)
            .expect("decode a scrub window from real media");
        assert!(w.frames > 0, "an empty window decodes no audio at all");
        let peak = w.samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(
            peak > 0.001,
            "expected non-silent PCM in the window, got peak={peak}"
        );

        let grain = grain_frames(rate);
        let mut buf = w.read(1.0, grain);
        assert_eq!(buf.len(), grain * channels);
        apply_grain_envelope(&mut buf, channels, fade_frames(rate, grain));
        let grain_peak = buf.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(
            grain_peak > 0.001,
            "expected a non-silent grain out of a non-silent window, got peak={grain_peak}"
        );
    }

    /// [`update`] is last-writer-wins and needs no ordering stamp — see its own
    /// doc. Holding still therefore means every grain reads the same position,
    /// which is what makes a parked playhead repeat rather than drift.
    #[test]
    fn the_newest_update_is_what_the_next_grain_reads() {
        update(Some(ScrubSource {
            path: PathBuf::from("/a.m4a"),
            source_secs: 1.0,
            gain: 1.0,
        }));
        update(Some(ScrubSource {
            path: PathBuf::from("/a.m4a"),
            source_secs: 2.0,
            gain: 1.0,
        }));
        assert_eq!(target().map(|t| t.source_secs), Some(2.0));
        update(None);
        assert_eq!(target(), None, "a gap under the playhead is a real state");
    }
}
