//! The Edit preview's playback loop (D-454): clocked by the display, slaved to
//! the sound.
//!
//! **What it is:** one thread per play. Each turn of its loop asks the
//! presenter for a drawable, which (Fifo, one queued drawable) returns only
//! when the display has taken the previous one: the display's refresh is the
//! loop's clock, there is no timer. Before each present it works out which
//! timeline frame will be on the glass when that drawable is shown — the
//! audio clock's position (`apelles_media::audio_clock`) at that instant, or
//! the wall clock from the moment Play was pressed while no sound is playing
//! (a silent stretch, the audio still warming up) — and, when that frame is
//! not the one already drawn, has the engine draw it. A refresh whose frame is
//! already up re-presents it (a 30 fps timeline on a 60 Hz display draws one
//! frame for every two refreshes).
//!
//! **What it does:** keeps the picture where the sound is, at any playback
//! rate, dropping frames when the engine is slower than the timeline and
//! never queuing more than one drawable; reports each newly shown frame to the
//! webview (`chroma://preview-playhead`) so the playhead, the timecode and the
//! timeline follow the picture rather than a clock of their own; stops at the
//! end of the timeline.
//!
//! **What it does NOT do:** start or stop the audio (the webview's transport
//! does that, at the same transition, as before: `chroma_audio_play`), seek
//! (a seek while playing restarts the loop), or play backwards (the transport
//! plays forward only; J is a scrub, `@apelles/editor`'s `shuttle.ts`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

/// The event carrying each frame the loop newly shows.
pub(crate) const PLAYHEAD_EVENT: &str = "chroma://preview-playhead";

/// What a refresh is assumed to last before the first two acquires have
/// measured it (a 60 Hz display).
pub(crate) const DEFAULT_REFRESH: Duration = Duration::from_micros(16_667);

/// The measured refresh follows the acquire-to-acquire interval through an
/// exponential average with this weight on each new sample, ignoring an
/// interval longer than [`MAX_REFRESH`] (a dropped frame, not a refresh).
const REFRESH_SMOOTHING: f64 = 0.1;
const MAX_REFRESH: Duration = Duration::from_millis(50);

/// One play, as the webview asked for it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PlayRequest {
    /// The frame on screen when Play was pressed.
    pub from: u64,
    /// The timeline's frame rate.
    pub fps: f64,
    /// Timeline seconds per real second (D-280), used while no audio clock is
    /// sounding.
    pub rate: f64,
    /// The timeline's length in frames: playing reaches `end - 1` and stops.
    pub end: u64,
}

impl PlayRequest {
    /// The frame whose interval contains timeline time `secs`.
    fn frame_at(&self, secs: f64) -> u64 {
        if secs.is_nan() || secs <= 0.0 || self.fps.is_nan() || self.fps <= 0.0 {
            return 0;
        }
        // A hair of tolerance so a time computed as exactly a frame boundary
        // is not floored into the frame before it.
        (secs * self.fps + 1e-6).floor() as u64
    }
}

/// The payload of [`PLAYHEAD_EVENT`].
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlayheadEvent {
    pub frame: u64,
    /// The end of the timeline was reached; playback has stopped.
    pub ended: bool,
}

/// The timeline time to show at `glass`: the sound's, or the wall clock's.
pub(crate) fn clock_secs(req: &PlayRequest, started: Instant, glass: Instant) -> (f64, bool) {
    if let Some(secs) = apelles_media::audio_clock::position(glass) {
        return (secs, true);
    }
    let base = if req.fps > 0.0 {
        req.from as f64 / req.fps
    } else {
        0.0
    };
    let elapsed = glass.saturating_duration_since(started).as_secs_f64();
    (base + req.rate * elapsed, false)
}

/// What the loop needs from the session, so it can be driven by the real
/// presenter or, in tests, by a scripted one.
pub(crate) trait Screen {
    /// Have the engine draw `frame` into the retained frame.
    fn draw(&mut self, frame: u64) -> Result<(), String>;
    /// Show the retained frame; returns when the drawable was acquired.
    fn present(&mut self) -> Result<Instant, String>;
    /// One newly shown frame, with the timeline time the clock said was being
    /// heard when it reached the glass (for the A/V measurement).
    fn shown(&mut self, frame: u64, clock_at_glass: Option<f64>);
}

/// The loop itself: run until `stop` or the end of the timeline. Returns the
/// last frame shown and whether the end was reached.
pub(crate) fn run(
    req: PlayRequest,
    screen: &mut dyn Screen,
    stop: &AtomicBool,
    mut on_frame: impl FnMut(PlayheadEvent),
) -> Result<(u64, bool), String> {
    let started = Instant::now();
    let mut drawn = req.from;
    let mut refresh = DEFAULT_REFRESH;
    let mut last_acquired: Option<Instant> = None;
    let last = req.end.saturating_sub(1);
    while !stop.load(Ordering::Relaxed) {
        // A frame drawn now is presented on the next free drawable, which the
        // display shows one refresh after that (`Presenter`'s pacing): two
        // refreshes after the last acquire.
        let glass = match last_acquired {
            Some(a) => a + refresh * 2,
            None => Instant::now() + refresh,
        };
        let (secs, _) = clock_secs(&req, started, glass);
        // Never backwards: a clock that dips behind the frame already drawn
        // (the wall clock handing over to the audio clock as the sound starts)
        // holds the picture rather than seeking the decoders back.
        let due = req.frame_at(secs).max(drawn);
        if due > last {
            // Show the last frame, then stop.
            if drawn != last {
                screen.draw(last)?;
                screen.present()?;
            }
            on_frame(PlayheadEvent {
                frame: last,
                ended: true,
            });
            return Ok((last, true));
        }
        let fresh = due != drawn;
        if fresh {
            screen.draw(due)?;
            drawn = due;
        }
        let acquired = screen.present()?;
        if let Some(prev) = last_acquired {
            let interval = acquired.saturating_duration_since(prev);
            if interval > Duration::ZERO && interval < MAX_REFRESH {
                refresh = Duration::from_secs_f64(
                    refresh.as_secs_f64() * (1.0 - REFRESH_SMOOTHING)
                        + interval.as_secs_f64() * REFRESH_SMOOTHING,
                );
            }
        }
        last_acquired = Some(acquired);
        if fresh {
            let on_glass = acquired + refresh;
            screen.shown(drawn, apelles_media::audio_clock::position(on_glass));
            on_frame(PlayheadEvent {
                frame: drawn,
                ended: false,
            });
        }
    }
    Ok((drawn, false))
}

/// A running play.
pub(crate) struct Handle {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl Handle {
    /// Start playing on a thread of its own; `screen` is built on that thread.
    pub(crate) fn start(
        app: tauri::AppHandle,
        req: PlayRequest,
        mut screen: impl Screen + Send + 'static,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("preview-play".to_string())
            .spawn(move || {
                let emit = |e: PlayheadEvent| {
                    if let Err(err) = app.emit(PLAYHEAD_EVENT, e) {
                        log::warn!(
                            "preview playback: could not report frame {}: {err}",
                            e.frame
                        );
                    }
                };
                if let Err(e) = run(req, &mut screen, &flag, emit) {
                    log::warn!("preview playback stopped: {e}");
                    // The transport must not stay "playing" over a frozen
                    // picture: report where it stopped, as an end.
                    let _ = app.emit(
                        PLAYHEAD_EVENT,
                        PlayheadEvent {
                            frame: req.from,
                            ended: true,
                        },
                    );
                }
            })
            .map_err(|e| format!("could not start the playback thread: {e}"))?;
        Ok(Self { stop, thread })
    }

    /// Stop and wait for the thread (at most one refresh plus one frame).
    pub(crate) fn stop(self) {
        self.stop.store(true, Ordering::Relaxed);
        if self.thread.join().is_err() {
            log::error!("the preview playback thread panicked");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A screen whose display refreshes every `refresh` of simulated time.
    struct Scripted {
        drawn: Vec<u64>,
        presents: u32,
        stop_after: u32,
        stop: Arc<AtomicBool>,
    }

    impl Screen for Scripted {
        fn draw(&mut self, frame: u64) -> Result<(), String> {
            self.drawn.push(frame);
            Ok(())
        }
        fn present(&mut self) -> Result<Instant, String> {
            self.presents += 1;
            if self.presents >= self.stop_after {
                self.stop.store(true, Ordering::Relaxed);
            }
            std::thread::sleep(Duration::from_millis(4));
            Ok(Instant::now())
        }
        fn shown(&mut self, _frame: u64, _clock: Option<f64>) {}
    }

    fn req(from: u64, end: u64) -> PlayRequest {
        PlayRequest {
            from,
            fps: 30.0,
            rate: 1.0,
            end,
        }
    }

    #[test]
    fn frames_are_found_on_their_own_grid() {
        let r = req(0, 100);
        assert_eq!(r.frame_at(0.0), 0);
        assert_eq!(r.frame_at(1.0), 30);
        assert_eq!(r.frame_at(1.0 / 30.0), 1);
        assert_eq!(r.frame_at(1.0 / 30.0 - 1e-3), 0);
        assert_eq!(r.frame_at(-1.0), 0);
    }

    #[test]
    fn with_no_sound_the_wall_clock_runs_from_the_start_frame() {
        let r = PlayRequest {
            rate: 2.0,
            ..req(30, 1000)
        };
        let t = Instant::now();
        let (secs, audio) = clock_secs(&r, t, t + Duration::from_millis(500));
        assert!(!audio);
        assert!((secs - 2.0).abs() < 1e-9);
    }

    #[test]
    fn the_loop_draws_each_frame_once_and_reports_it_in_order() {
        let stop = Arc::new(AtomicBool::new(false));
        let mut screen = Scripted {
            drawn: Vec::new(),
            presents: 0,
            stop_after: 60,
            stop: stop.clone(),
        };
        let mut seen = Vec::new();
        let (_, ended) =
            run(req(10, 100_000), &mut screen, &stop, |e| seen.push(e.frame)).unwrap_or((0, true));
        assert!(!ended);
        assert!(!screen.drawn.is_empty());
        // Never the same frame drawn twice in a row, never backwards.
        assert!(screen.drawn.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(seen, screen.drawn);
        // Fewer draws than presents: refreshes with nothing new re-present.
        assert!(screen.drawn.len() as u32 <= screen.presents);
    }

    #[test]
    fn the_loop_stops_on_the_last_frame() {
        let stop = Arc::new(AtomicBool::new(false));
        let mut screen = Scripted {
            drawn: Vec::new(),
            presents: 0,
            stop_after: u32::MAX,
            stop: stop.clone(),
        };
        let mut seen = Vec::new();
        let result = run(req(0, 3), &mut screen, &stop, |e| seen.push(e));
        assert_eq!(result, Ok((2, true)));
        let end = seen.last().copied();
        assert!(end.is_some_and(|e| e.ended && e.frame == 2));
    }
}
