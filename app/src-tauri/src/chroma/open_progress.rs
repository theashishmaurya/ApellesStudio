//! The project open's progress reporter (B-369).
//!
//! What it is: [`OpenProgress`], the one object `project::open_manifest` tells
//!   where it is ("reading the project", "checking media 120 of 288", "decoding
//!   the first frame"), and that turns each of those into a
//!   [`OPEN_PROGRESS_EVENT`] Tauri event the frontend's branded loader shows and
//!   `editor_get_state` reports. It also times each phase and logs one summary
//!   line per open, so a slow open in the field says where its time went.
//! What it does: emit `{ openId, phase, done, total }` payloads, throttled for
//!   the per-clip phase (a 2,000-clip project must not send 2,000 events), and
//!   always emit a phase's first and last step so the count shown never lags.
//! What it does NOT do: decide the phase order or the words a person reads —
//!   the frontend's `openProgress.ts` reducer owns both — and it never fails an
//!   open: a dropped event costs a stale label, nothing else.
//!
//! `open_id` is the frontend's token for one `openProject` call. The events of
//! an older open that arrive late (Tauri events and command replies travel on
//! different channels) are told apart by it instead of by arrival order.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The event every open's progress is sent on.
pub const OPEN_PROGRESS_EVENT: &str = "chroma://project-open-progress";

/// The least time between two per-item events of one phase. ~30 Hz: faster
/// than a person reads a counter, slow enough that a large project's clip loop
/// spends its time probing, not serialising events.
pub const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(33);

/// The Rust-side phases of an open, in order. The frontend adds its own after
/// these (grades, timeline, previews); the names are the wire contract with
/// `app/src/store/openProgress.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OpenPhase {
    /// `project.json` read + the timeline ensured + the one-time grade migration.
    Reading,
    /// Every video clip's source checked online and probed (cached by
    /// path + mtime + size, `apelles_media::probe`).
    Media,
    /// The active clip's first frame decoded for the Colorist canvas.
    Preview,
}

impl OpenPhase {
    fn as_str(self) -> &'static str {
        match self {
            OpenPhase::Reading => "reading",
            OpenPhase::Media => "media",
            OpenPhase::Preview => "preview",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenProgressPayload {
    open_id: u64,
    phase: OpenPhase,
    done: usize,
    total: usize,
}

/// Whether a per-item step should be sent: always the first and the last, and
/// in between only once [`PROGRESS_EMIT_INTERVAL`] has passed since the last
/// one sent.
pub fn should_emit(done: usize, total: usize, since_last: Option<Duration>) -> bool {
    if done == 0 || done >= total {
        return true;
    }
    match since_last {
        None => true,
        Some(elapsed) => elapsed >= PROGRESS_EMIT_INTERVAL,
    }
}

struct Timing {
    current: Option<(&'static str, Instant)>,
    last_emit: Option<Instant>,
    spent: Vec<(&'static str, Duration)>,
}

/// One open's reporter. [`OpenProgress::silent`] for the callers that reuse
/// `open_manifest` without a loader on screen (relink, add/remove a clip):
/// they still get the timing log, no events.
pub struct OpenProgress {
    app: Option<AppHandle>,
    open_id: u64,
    started: Instant,
    timing: Mutex<Timing>,
}

impl OpenProgress {
    pub fn new(app: AppHandle, open_id: Option<u64>) -> Self {
        Self::build(open_id.map(|_| app), open_id.unwrap_or(0))
    }

    pub fn silent() -> Self {
        Self::build(None, 0)
    }

    fn build(app: Option<AppHandle>, open_id: u64) -> Self {
        Self {
            app,
            open_id,
            started: Instant::now(),
            timing: Mutex::new(Timing {
                current: None,
                last_emit: None,
                spent: Vec::new(),
            }),
        }
    }

    /// Enter `phase` (closing the timing of the one before) and send its first step.
    pub fn phase(&self, phase: OpenPhase, total: usize) {
        self.time(phase.as_str());
        self.emit(phase, 0, total);
    }

    /// Start timing a step the loader does not show (the manifest save), closing
    /// the one before. Logged by [`OpenProgress::finish`]; never emitted.
    pub fn time(&self, label: &'static str) {
        let mut t = self.timing.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        if let Some((prev, at)) = t.current.take() {
            t.spent.push((prev, now - at));
        }
        t.current = Some((label, now));
        t.last_emit = Some(now);
    }

    /// `done` of `total` items of the current phase are finished. Safe to call
    /// from several threads; throttled by [`should_emit`].
    pub fn step(&self, phase: OpenPhase, done: usize, total: usize) {
        let send = {
            let mut t = self.timing.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let send = should_emit(done, total, t.last_emit.map(|at| now - at));
            if send {
                t.last_emit = Some(now);
            }
            send
        };
        if send {
            self.emit(phase, done, total);
        }
    }

    fn emit(&self, phase: OpenPhase, done: usize, total: usize) {
        if let Some(app) = &self.app {
            let payload = OpenProgressPayload {
                open_id: self.open_id,
                phase,
                done,
                total,
            };
            if let Err(e) = app.emit(OPEN_PROGRESS_EVENT, payload) {
                log::warn!("[chroma::open_progress] emit failed: {e}");
            }
        }
    }

    /// Close the last phase and log where the open's time went.
    pub fn finish(&self, project: &str) {
        let mut t = self.timing.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((prev, at)) = t.current.take() {
            t.spent.push((prev, at.elapsed()));
        }
        let phases = t
            .spent
            .iter()
            .map(|(p, d)| format!("{p} {:.0} ms", d.as_secs_f64() * 1000.0))
            .collect::<Vec<_>>()
            .join(", ");
        log::info!(
            "[chroma::project] open {project}: {:.0} ms ({phases})",
            self.started.elapsed().as_secs_f64() * 1000.0
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_and_last_step_are_always_sent() {
        assert!(should_emit(0, 288, Some(Duration::ZERO)));
        assert!(should_emit(288, 288, Some(Duration::ZERO)));
        assert!(
            should_emit(5, 0, Some(Duration::ZERO)),
            "an empty phase is complete"
        );
    }

    #[test]
    fn steps_between_are_throttled() {
        assert!(!should_emit(10, 288, Some(Duration::from_millis(5))));
        assert!(should_emit(10, 288, Some(PROGRESS_EMIT_INTERVAL)));
        assert!(should_emit(10, 288, None));
    }

    #[test]
    fn a_silent_reporter_times_without_an_app() {
        let p = OpenProgress::silent();
        p.phase(OpenPhase::Reading, 0);
        p.phase(OpenPhase::Media, 3);
        p.step(OpenPhase::Media, 3, 3);
        p.time("save");
        p.finish("test");
        let t = p.timing.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(
            t.spent.iter().map(|(p, _)| *p).collect::<Vec<_>>(),
            vec!["reading", "media", "save"]
        );
    }

    #[test]
    fn the_payload_is_camel_case() {
        let v = serde_json::to_value(OpenProgressPayload {
            open_id: 7,
            phase: OpenPhase::Media,
            done: 1,
            total: 2,
        })
        .unwrap_or_default();
        assert_eq!(v["openId"], 7);
        assert_eq!(v["phase"], "media");
    }
}
