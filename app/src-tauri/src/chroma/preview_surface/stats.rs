//! **Debug builds only (D-454):** what the Edit preview's presenter and
//! playback loop measured, for `debug_native_preview_stats` and the
//! `paint` / `raf` channels of `debug_frame_timing` (the UI harness's
//! playback floor reads those). Compiled out of a release build with the
//! rest of the debug tooling; every call site is `#[cfg(debug_assertions)]`.
//!
//! - **presents**: one per drawable presented (the loop's display-clocked
//!   tick while playing; the `raf` channel's successor).
//! - **shown**: one per NEW frame on the glass (the `paint` channel's).
//! - **A/V**: for each shown frame, the frame's midpoint time minus the audio
//!   clock's position at the instant the frame is predicted to reach the glass
//!   (acquire + one refresh). Positive = the picture is ahead of the sound.
//! - **draw**: the engine's preview frame, from asking to submitted.
//! - **place**: a paused re-present made inside the move's transaction.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;

use super::native_view::ViewReport;
use super::presenter::PresentTiming;

/// Samples kept per channel: about 8 s at 60 Hz.
const CAPACITY: usize = 480;

#[derive(Default)]
struct Stats {
    /// When each present's drawable was acquired.
    presents: VecDeque<Instant>,
    acquire_ms: VecDeque<f64>,
    present_ms: VecDeque<f64>,
    /// When each new frame was shown.
    shown: VecDeque<Instant>,
    av_offset_ms: VecDeque<f64>,
    draw_ms: VecDeque<f64>,
    place_ms: VecDeque<f64>,
    fps: f64,
    frames_shown: u64,
    last_frame: u64,
}

static STATS: Mutex<Option<Stats>> = Mutex::new(None);

fn with(f: impl FnOnce(&mut Stats)) {
    let mut slot = STATS.lock().unwrap_or_else(|e| e.into_inner());
    f(slot.get_or_insert_with(Stats::default));
}

fn push<T>(q: &mut VecDeque<T>, v: T) {
    if q.len() == CAPACITY {
        q.pop_front();
    }
    q.push_back(v);
}

pub(crate) fn reset() {
    *STATS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

pub(crate) fn begin_play(fps: f64) {
    with(|s| s.fps = fps);
}

pub(crate) fn record_present(t: &PresentTiming) {
    if !t.shown {
        return;
    }
    with(|s| {
        push(&mut s.presents, t.acquired_at);
        push(&mut s.acquire_ms, t.acquire_ms);
        push(&mut s.present_ms, t.total_ms);
    });
}

pub(crate) fn record_shown(frame: u64, clock_at_glass: Option<f64>) {
    let now = Instant::now();
    with(|s| {
        push(&mut s.shown, now);
        s.frames_shown += 1;
        s.last_frame = frame;
        if let Some(heard) = clock_at_glass
            && s.fps > 0.0
        {
            let midpoint = (frame as f64 + 0.5) / s.fps;
            push(&mut s.av_offset_ms, (midpoint - heard) * 1000.0);
        }
    });
}

pub(crate) fn record_draw(ms: f64) {
    with(|s| push(&mut s.draw_ms, ms));
}

pub(crate) fn record_place(ms: f64) {
    with(|s| push(&mut s.place_ms, ms));
}

/// Min / median / p95 / max of a channel.
#[derive(Serialize, Default)]
pub(crate) struct Spread {
    pub n: usize,
    pub min: f64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

pub(crate) fn spread(values: impl IntoIterator<Item = f64>) -> Spread {
    let mut v: Vec<f64> = values.into_iter().collect();
    if v.is_empty() {
        return Spread::default();
    }
    v.sort_by(f64::total_cmp);
    let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
    Spread {
        n: v.len(),
        min: v[0],
        p50: at(0.5),
        p95: at(0.95),
        max: v[v.len() - 1],
    }
}

fn intervals(q: &VecDeque<Instant>) -> Vec<f64> {
    q.iter()
        .zip(q.iter().skip(1))
        .map(|(a, b)| b.duration_since(*a).as_secs_f64() * 1000.0)
        .collect()
}

/// Milliseconds before `now` of each timestamp, oldest first: the
/// webview turns them into `performance.now()` timestamps for its frame
/// timing report.
fn ages(q: &VecDeque<Instant>, now: Instant) -> Vec<f64> {
    q.iter()
        .map(|t| now.saturating_duration_since(*t).as_secs_f64() * 1000.0)
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatsReport {
    playing: bool,
    frames_shown: u64,
    last_frame: u64,
    /// Presents (display ticks) and new frames per second, over the window.
    present_fps: f64,
    shown_fps: f64,
    present_interval_ms: Spread,
    shown_interval_ms: Spread,
    acquire_ms: Spread,
    present_ms: Spread,
    draw_ms: Spread,
    place_ms: Spread,
    /// Picture minus sound, ms (see the module doc).
    av_offset_ms: Spread,
    /// The same, as absolute values.
    av_abs_offset_ms: Spread,
    /// How long ago each present / new frame happened, ms, oldest first.
    present_ages_ms: Vec<f64>,
    shown_ages_ms: Vec<f64>,
    drawable: Option<(u32, u32)>,
    reconfigures: Option<u64>,
    format: Option<String>,
    view: Option<ViewReport>,
}

fn rate(q: &VecDeque<Instant>) -> f64 {
    match (q.front(), q.back()) {
        (Some(a), Some(b)) if q.len() > 1 => {
            (q.len() - 1) as f64 / b.duration_since(*a).as_secs_f64()
        }
        _ => 0.0,
    }
}

pub(crate) fn report(
    view: Option<ViewReport>,
    surface: Option<((u32, u32), u64, String)>,
    playing: bool,
) -> StatsReport {
    let mut slot = STATS.lock().unwrap_or_else(|e| e.into_inner());
    let s = slot.get_or_insert_with(Stats::default);
    let now = Instant::now();
    let (drawable, reconfigures, format) = match surface {
        Some((d, r, f)) => (Some(d), Some(r), Some(f)),
        None => (None, None, None),
    };
    StatsReport {
        playing,
        frames_shown: s.frames_shown,
        last_frame: s.last_frame,
        present_fps: rate(&s.presents),
        shown_fps: rate(&s.shown),
        present_interval_ms: spread(intervals(&s.presents)),
        shown_interval_ms: spread(intervals(&s.shown)),
        acquire_ms: spread(s.acquire_ms.iter().copied()),
        present_ms: spread(s.present_ms.iter().copied()),
        draw_ms: spread(s.draw_ms.iter().copied()),
        place_ms: spread(s.place_ms.iter().copied()),
        av_offset_ms: spread(s.av_offset_ms.iter().copied()),
        av_abs_offset_ms: spread(s.av_offset_ms.iter().map(|v| v.abs())),
        present_ages_ms: ages(&s.presents, now),
        shown_ages_ms: ages(&s.shown, now),
        drawable,
        reconfigures,
        format,
        view,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spread_of_an_empty_channel_is_zero() {
        let s = spread(Vec::new());
        assert_eq!((s.n, s.p50, s.max), (0, 0.0, 0.0));
    }

    #[test]
    fn spread_reports_the_order_statistics() {
        let s = spread((1..=100).map(f64::from));
        assert_eq!((s.n, s.min, s.max), (100, 1.0, 100.0));
        assert_eq!(s.p50, 51.0);
        assert_eq!(s.p95, 95.0);
    }

    #[test]
    fn a_channel_keeps_only_its_window() {
        let mut q = VecDeque::new();
        for i in 0..(CAPACITY + 10) {
            push(&mut q, i);
        }
        assert_eq!(q.len(), CAPACITY);
        assert_eq!(q.front(), Some(&10));
    }
}
