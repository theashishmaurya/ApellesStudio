//! # `audio_clock` — where on the timeline the listener is, right now (D-454)
//!
//! **What it is:** the play session's master clock. The Edit preview's picture
//! (`app/src-tauri`'s `chroma::preview_surface`, drawn by the display's
//! refresh) asks [`position`] which timeline time is being heard at a given
//! instant and shows that frame, so the picture is slaved to the sound, the
//! way an NLE's viewer follows its audio clock.
//!
//! **What it does:** the output device's callback ([`crate::audio`]'s
//! `build_typed`) reports, for every buffer it fills, how many of its samples
//! were real timeline audio (not underrun silence) and how far ahead of the
//! callback the device will play that buffer (`cpal`'s
//! `OutputStreamTimestamp::playback − callback`). That makes one anchor: "the
//! first sample of this buffer, which is `n` session samples in, reaches the
//! DAC at instant `t`". [`position`] extrapolates from the latest anchor at
//! the session's playback rate. The session start ([`begin`]) says which
//! timeline time session sample 0 is (the start frame plus D-125's skew
//! discard).
//!
//! **What it does NOT do:** drive the audio (it only observes it), correct
//! drift (there is none to correct: the picture follows this clock), or know
//! about video frames (the caller converts seconds to its frame grid). With no
//! play session sounding (a silent timeline, a session still warming up, a
//! scrub) [`position`] is `None` and the caller keeps its own display clock.
//!
//! **Real-time safety.** The callback never blocks on it: it `try_lock`s and
//! skips the update when a reader holds the lock (a reader holds it for a
//! copy of five numbers), so the worst case is an anchor one buffer older.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How far past the last anchor [`position`] extrapolates before it stops
/// trusting it: two device buffers is ~20 ms; this is much longer so an
/// underrun or a device hiccup does not freeze the picture, while a session
/// that has really stopped (the device closed) does not run on forever.
const STALE_AFTER: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, Debug)]
struct Anchor {
    /// The play session these numbers belong to (`audio`'s generation).
    generation: u64,
    /// The timeline time of session sample 0, in seconds.
    base_secs: f64,
    /// Timeline seconds per real second (D-280's playback rate).
    rate: f64,
    /// The device's sample rate.
    out_rate: u32,
    /// Real (non-silence) sample frames handed to the device before the
    /// anchored (latest) buffer.
    frames_before: u64,
    /// The same count including the anchored buffer: the next buffer's
    /// `frames_before`.
    frames_through: u64,
    /// When the first sample of the anchored buffer reaches the DAC; `None`
    /// until the first callback.
    heard_at: Option<Instant>,
}

static ANCHOR: Mutex<Option<Anchor>> = Mutex::new(None);

/// A session's clock is starting: sample 0 of `generation` is timeline time
/// `base_secs`, played at `rate`, out of a device running at `out_rate`.
pub(crate) fn begin(generation: u64, base_secs: f64, rate: f64, out_rate: u32) {
    *ANCHOR.lock().unwrap_or_else(|e| e.into_inner()) = Some(Anchor {
        generation,
        base_secs,
        rate,
        out_rate,
        frames_before: 0,
        frames_through: 0,
        heard_at: None,
    });
}

/// The session `generation` is over.
pub(crate) fn end(generation: u64) {
    let mut slot = ANCHOR.lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_some_and(|a| a.generation == generation) {
        *slot = None;
    }
}

/// One output buffer of `generation`: `real_frames` of it were session audio,
/// and the device plays its first sample `latency` after `now`. Called from
/// the real-time callback; never blocks.
pub(crate) fn advance(generation: u64, real_frames: u64, now: Instant, latency: Duration) {
    let Ok(mut slot) = ANCHOR.try_lock() else {
        return;
    };
    if let Some(a) = slot.as_mut().filter(|a| a.generation == generation) {
        a.frames_before = a.frames_through;
        a.frames_through += real_frames;
        a.heard_at = Some(now + latency);
    }
}

/// The timeline time, in seconds, being heard at `at`, if a play session is
/// sounding; `None` otherwise.
pub fn position(at: Instant) -> Option<f64> {
    let a = (*ANCHOR.lock().unwrap_or_else(|e| e.into_inner()))?;
    if !crate::audio::is_current(a.generation) {
        return None;
    }
    position_of(&a, at)
}

fn position_of(a: &Anchor, at: Instant) -> Option<f64> {
    let heard_at = a.heard_at?;
    let since = if at >= heard_at {
        let d = at - heard_at;
        if d > STALE_AFTER {
            return None;
        }
        d.as_secs_f64()
    } else {
        -(heard_at - at).as_secs_f64()
    };
    let played = a.frames_before as f64 / f64::from(a.out_rate.max(1));
    Some(a.base_secs + a.rate * (played + since))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(frames_before: u64, heard_at: Instant, rate: f64) -> Anchor {
        Anchor {
            generation: 1,
            base_secs: 10.0,
            rate,
            out_rate: 48_000,
            frames_before,
            frames_through: frames_before + 512,
            heard_at: Some(heard_at),
        }
    }

    fn close(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-9)
    }

    #[test]
    fn no_buffer_played_yet_means_no_position() {
        let a = Anchor {
            heard_at: None,
            ..anchor(0, Instant::now(), 1.0)
        };
        assert_eq!(position_of(&a, Instant::now()), None);
    }

    #[test]
    fn the_position_is_the_base_plus_what_was_heard() {
        let t = Instant::now() + Duration::from_secs(1);
        // One second of samples before the anchored buffer, heard at `t`.
        let a = anchor(48_000, t, 1.0);
        assert!(close(position_of(&a, t), 11.0));
        assert!(close(
            position_of(&a, t + Duration::from_millis(250)),
            11.25
        ));
        // Before the buffer reaches the DAC the listener is still behind it.
        assert!(close(position_of(&a, t - Duration::from_millis(20)), 10.98));
    }

    #[test]
    fn the_playback_rate_scales_timeline_time() {
        let t = Instant::now();
        let a = anchor(48_000, t, 2.0);
        assert!(close(
            position_of(&a, t + Duration::from_millis(100)),
            10.0 + 2.0 * 1.1
        ));
    }

    #[test]
    fn a_clock_nobody_has_fed_for_a_while_is_not_trusted() {
        let t = Instant::now();
        let a = anchor(0, t, 1.0);
        assert!(position_of(&a, t + STALE_AFTER).is_some());
        assert_eq!(
            position_of(&a, t + STALE_AFTER + Duration::from_millis(1)),
            None
        );
    }

    #[test]
    fn a_buffer_moves_the_anchor_past_the_previous_buffers_real_frames() {
        begin(7, 0.0, 1.0, 48_000);
        let t = Instant::now();
        advance(7, 480, t, Duration::from_millis(10));
        advance(7, 480, t, Duration::from_millis(10));
        // Another session's buffer changes nothing.
        advance(8, 99_999, t, Duration::ZERO);
        let a = *ANCHOR.lock().unwrap_or_else(|e| e.into_inner());
        let a = a.unwrap_or_else(|| anchor(0, t, 0.0));
        assert_eq!((a.frames_before, a.frames_through), (480, 960));
        assert!(close(position_of(&a, t + Duration::from_millis(10)), 0.01));
        end(7);
        assert!(ANCHOR.lock().unwrap_or_else(|e| e.into_inner()).is_none());
    }
}
