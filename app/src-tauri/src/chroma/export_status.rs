//! **The Edit tab export's live progress, as a VALUE — and the stall watchdog
//! that turns a hung render into a reported failure (D-362, fixes B-231).**
//!
//! What it is: one process-global slot holding the most recent
//! `editor_export` compositor render's progress, written by
//! [`super::edit_render`]'s workers as they go and read — without a frontend
//! round trip — by `editor_export_status` (the MCP op, answered natively in
//! `chroma::control`) and by `chroma_editor_export_status` (the Tauri command
//! the Export dialog polls). The same numbers reach a human and an agent,
//! which is CLAUDE.md's "every feature is built for a human AND an AI" for a
//! progress readout.
//!
//! What it does NOT do:
//! - **Render, encode, or know anything about ffmpeg.** It is counters, a
//!   snapshot and a timer. [`super::edit_render`] owns the render.
//! - **Track more than one export.** There is exactly one slot, because
//!   `exportQueueStore` runs one job at a time (D-198) and `editor_export` is
//!   a single blocking op. A second concurrent render would overwrite the
//!   first's numbers — which is why [`begin`] refuses to start one.
//! - **Cover the FILTER-graph export path.** That path hands the whole job to
//!   one ffmpeg and learns nothing until it exits; progress for it would mean
//!   parsing ffmpeg's stderr, which is exactly what D-350 exists to stop doing.
//!   A filter-path export never opens a job here at all, so this answers
//!   whatever the last COMPOSITOR export left behind — `idle` on a session
//!   that has run none. Both MCP tool descriptions say so outright, since
//!   "no progress" and "no progress yet" are not the same answer.
//! - **Push events.** It is polled, matching this repo's own established
//!   progress pattern (`chroma::export`'s `chroma_export_progress` for the
//!   Colorist tab) — and, more to the point, an event stream cannot answer
//!   B-231's actual question, which a caller asks *after* its op already timed
//!   out and any event it missed is gone.
//!
//! **The progress value, and why it is what it is** (the D-362 decision): the
//! primary number is `framesWritten / framesTotal`, summed across every
//! concurrent segment. D-360 split the render into N contiguous ranges that
//! partition `0..frames` exactly — a property that file already unit-tests —
//! so the sum over workers is a true fraction of the whole render with no
//! double counting and no gap, however the segments are interleaved in time.
//! `segmentsDone`/`segmentsTotal` and the per-segment rows are reported
//! alongside it because the percentage alone hides the shape: four segments
//! evenly at 78% and three finished with one wedged at 12% are the same
//! percentage and very different situations, and the second is the one B-231
//! was filed about.
//!
//! **A frame counts when it is WRITTEN to the encoder, not when it is
//! composited.** That is the most downstream point this path controls, so the
//! same counter freezes whether the compositor stalled, the hand-off channel
//! jammed or the encoder stopped reading — which is what lets one counter be
//! both the progress number and the watchdog's heartbeat. It can only ever
//! under-report, by at most the `WRITE_AHEAD` frames in flight.

use std::ops::Range;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use shared_child::SharedChild;

/// **How long a segment may write no frame at all before the export is
/// declared hung, its encoder killed, and a real error reported.**
///
/// B-231 facet 2: a render task stopped making progress while the `apelles`
/// process stayed healthy, and nothing ever reported it — the `ffmpeg` child
/// sat at 0% CPU, the output file froze mid-write, and the only evidence was a
/// human noticing the file had stopped growing. Two minutes of total silence
/// from a worker is that, and nothing else.
///
/// **Two minutes, from the measured frame times, deliberately with a large
/// margin.** The 1080p stress fixture renders at 16.6 fps single-stream and
/// 27.3 fps segmented (D-360 §10.5), i.e. 37-60 ms a frame; 4K is roughly four
/// times that. The slowest legitimate single frame this path has is a cold
/// keyframe seek per visible track on a segment's first frame, measured by
/// `decode_pipe` at 248-337 ms and a median 723 ms on the owner's C040
/// footage — call it a few seconds for a multi-track 4K segment starting cold.
/// 120 s is more than an order of magnitude above that, which matters because
/// the one condition that actually coincided with B-231's hang was severe
/// system memory pressure (swap at ~9.3/10 GB, from an unrelated concurrent
/// build), and a machine that deep into swap can make a single honest frame
/// take tens of seconds. A watchdog whose false alarm kills a healthy 4K export
/// would be worse than the bug it is here to catch, so the threshold is set
/// where a false alarm is implausible and a real hang still surfaces in two
/// minutes instead of never.
pub const STALL_TIMEOUT: Duration = Duration::from_secs(120);

/// How often the watchdog thread looks. Small next to [`STALL_TIMEOUT`] so the
/// reported stall time is accurate to well under a second, and cheap — it
/// reads a handful of atomics and sleeps.
const WATCHDOG_TICK: Duration = Duration::from_millis(500);

/// The one slot. `None` until the first compositor export of this session.
static CURRENT: Mutex<Option<Arc<ExportJob>>> = Mutex::new(None);

/// Monotonic id per render, so a caller can tell "still the export I started"
/// from "a later one".
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);

/// Where an export is, as its first field — the same vocabulary, in the same
/// position, the `editor_detect_*_status` family already answers in (D-321),
/// so an agent reads `state` first whatever it is polling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportState {
    /// No compositor export has run in this session. Nothing to poll; start one.
    Idle,
    /// A render is in flight. Poll again.
    Running,
    /// The last render finished and wrote every frame it was asked for.
    Done,
    /// The last render failed and said why (`error`).
    Failed,
    /// The last render was killed by the watchdog after [`STALL_TIMEOUT`] of a
    /// worker writing nothing at all. **The output file is incomplete and not
    /// finalised** — this is B-231 facet 2, reported instead of silent.
    Stalled,
}

/// One segment's row in the status.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentStatus {
    pub index: usize,
    pub start_frame: u64,
    pub end_frame: u64,
    pub frames_written: u64,
    pub done: bool,
    /// How long since this segment last wrote a frame. The number the watchdog
    /// is comparing against [`STALL_TIMEOUT`], exposed so a caller can see a
    /// worker going quiet before the watchdog acts on it.
    pub seconds_since_progress: f64,
}

/// What `editor_export_status` and `chroma_editor_export_status` both answer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStatus {
    pub state: ExportState,
    /// `"rendering"` or `"concatenating"` while `state` is `running`, else
    /// absent. The concat is `-c:v copy` over the finished segments and is
    /// usually seconds, but it is not nothing, and without this the last
    /// stretch of a long export would read as a stuck 100%.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<&'static str>,
    pub job_id: u64,
    pub frames_total: u64,
    pub frames_written: u64,
    /// `framesWritten / framesTotal`, 0-100, one decimal. See this module's
    /// header for why this is the primary number.
    pub percent: f64,
    pub segments_total: usize,
    pub segments_done: usize,
    pub segments: Vec<SegmentStatus>,
    pub elapsed_ms: u128,
    /// A rough estimate of how much longer, or absent when nothing has been
    /// written yet to estimate from.
    ///
    /// **Taken from the SLOWEST unfinished segment, not from the aggregate
    /// rate** — the render ends when its last worker does, so the aggregate
    /// rate systematically under-estimates the tail as earlier segments retire
    /// and stop contributing to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The watchdog's threshold, in seconds, so a caller polling this can size
    /// its own patience from the same number rather than a guess.
    pub stall_timeout_secs: u64,
    pub note: String,
}

/// Which half of a segmented render is running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Rendering,
    Concatenating,
}

/// One segment's counters, written by its own worker and read by the watchdog
/// and by [`snapshot`].
struct SegmentTrack {
    range: Range<u64>,
    written: AtomicU64,
    /// Milliseconds since the job started, of this segment's last advance.
    /// Seeded at registration so a worker that never writes its first frame is
    /// still watched from the moment it began.
    last_ms: AtomicU64,
    done: AtomicBool,
    /// This segment's encoder, while it has one. The watchdog kills it to
    /// unblock a writer wedged in `write_all` — nothing else can, since a
    /// blocking pipe write has no timeout.
    encoder: Mutex<Option<Arc<SharedChild>>>,
}

/// One render's whole progress. Held by the renderer for the duration and left
/// in [`CURRENT`] afterwards, so a caller whose op already timed out can still
/// read what happened.
pub struct ExportJob {
    id: u64,
    started: Instant,
    frames_total: u64,
    output: Option<String>,
    stall_after: Duration,
    segments: Vec<SegmentTrack>,
    phase: Mutex<Phase>,
    /// Set by a failing worker (a sibling's failure) or by the watchdog (a
    /// stall). [`super::edit_render`]'s loop checks it once a frame.
    abort: AtomicBool,
    /// The watchdog's verdict, once it has one.
    stalled: Mutex<Option<String>>,
    /// `None` while running; `Some` once the render has returned, either way.
    finished: Mutex<Option<Result<(), String>>>,
}

impl ExportJob {
    /// The flag [`super::edit_render`]'s per-frame loop checks: a sibling
    /// segment failed, or the watchdog killed this export.
    pub fn abort(&self) -> &AtomicBool {
        &self.abort
    }

    /// One frame reached the encoder. Two relaxed atomics, against a frame that
    /// costs tens of milliseconds — the counter is free at this scale.
    pub fn frame_written(&self, segment: usize) {
        if let Some(s) = self.segments.get(segment) {
            s.written.fetch_add(1, Ordering::Relaxed);
            s.last_ms
                .store(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
        }
    }

    /// Hand the watchdog this segment's encoder, so a wedged write can be
    /// unblocked by killing it.
    pub fn attach_encoder(&self, segment: usize, child: Arc<SharedChild>) {
        if let Some(s) = self.segments.get(segment) {
            *s.encoder.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        }
    }

    /// This segment is finished (or has given up): stop watching it, and stop
    /// holding its child.
    pub fn segment_finished(&self, segment: usize) {
        if let Some(s) = self.segments.get(segment) {
            s.done.store(true, Ordering::Relaxed);
            *s.encoder.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    /// Every segment is written; the concat is now the only thing left.
    pub fn enter_concat(&self) {
        *self.phase.lock().unwrap_or_else(|e| e.into_inner()) = Phase::Concatenating;
    }

    /// The watchdog's verdict, if it fired. [`super::edit_render`] prefers this
    /// over whatever downstream error the kill produced — a killed encoder
    /// surfaces as a broken pipe, which describes the symptom and not the
    /// cause.
    pub fn stall_reason(&self) -> Option<String> {
        self.stalled
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// How long a worker may go quiet in THIS job. Normally [`STALL_TIMEOUT`];
    /// a test names its own so the watchdog can be proven to fire without a
    /// two-minute test.
    pub fn stall_after(&self) -> Duration {
        self.stall_after
    }

    /// The render is over, however it ended. After this the slot answers
    /// `done` / `failed` / `stalled` and the watchdog thread exits.
    pub fn finish(&self, result: Result<(), String>) {
        *self.finished.lock().unwrap_or_else(|e| e.into_inner()) = Some(result);
    }

    fn is_finished(&self) -> bool {
        self.finished
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }
}

/// Start tracking a render of `frames_total` frames split into `ranges`, and
/// start its watchdog.
///
/// Returns `Err` if a render is already in flight: two at once would overwrite
/// each other's counters, and — more importantly — the second would be
/// competing with the first for exactly the bounded encoder/decoder budget
/// D-360's `MAX_SEGMENTS` exists to cap. `exportQueueStore` already runs one
/// job at a time (D-198); this makes that a rule rather than a convention.
pub fn begin(
    frames_total: u64,
    ranges: &[Range<u64>],
    output: Option<String>,
    stall_after: Duration,
) -> Result<Arc<ExportJob>, String> {
    let mut slot = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(live) = slot.as_ref()
        && !live.is_finished()
    {
        return Err(format!(
            "an export is already rendering ({} of {} frames) — poll editor_export_status and \
             wait for it to finish",
            live.segments
                .iter()
                .map(|s| s.written.load(Ordering::Relaxed))
                .sum::<u64>(),
            live.frames_total
        ));
    }

    let job = Arc::new(ExportJob {
        id: NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed),
        started: Instant::now(),
        frames_total,
        output,
        stall_after,
        segments: ranges
            .iter()
            .map(|r| SegmentTrack {
                range: r.clone(),
                written: AtomicU64::new(0),
                last_ms: AtomicU64::new(0),
                done: AtomicBool::new(false),
                encoder: Mutex::new(None),
            })
            .collect(),
        phase: Mutex::new(Phase::Rendering),
        abort: AtomicBool::new(false),
        stalled: Mutex::new(None),
        finished: Mutex::new(None),
    });
    *slot = Some(job.clone());
    drop(slot);

    spawn_watchdog(job.clone());
    Ok(job)
}

/// **The watchdog (D-362, B-231 facet 2).**
///
/// One thread per render. Every [`WATCHDOG_TICK`] it asks each unfinished
/// segment how long since it last wrote a frame; the first one past the job's
/// stall threshold is recorded by name, has its encoder killed, and aborts the
/// whole render.
///
/// **Killing the encoder is the only thing that can unblock the stall it is
/// catching.** The wedged thread is inside `write_all` on a pipe whose reader
/// has stopped reading; a blocking pipe write has no timeout and no interrupt,
/// so the reader has to go away. `SharedChild` is what makes that safe from
/// another thread — killing a `std::process::Child` needs `&mut`, and doing it
/// by raw pid races with the renderer's own `wait` reaping it.
fn spawn_watchdog(job: Arc<ExportJob>) {
    std::thread::Builder::new()
        .name("apelles-export-watchdog".into())
        .spawn(move || {
            loop {
                std::thread::sleep(WATCHDOG_TICK);
                if job.is_finished() {
                    return;
                }
                // The concat step is not per-frame work, so there is no
                // heartbeat to watch; it bounds itself with its own
                // `wait_timeout` in `edit_render`.
                if *job.phase.lock().unwrap_or_else(|e| e.into_inner()) != Phase::Rendering {
                    continue;
                }
                let now_ms = job.started.elapsed().as_millis() as u64;
                let limit_ms = job.stall_after.as_millis() as u64;
                for (i, seg) in job.segments.iter().enumerate() {
                    if seg.done.load(Ordering::Relaxed) {
                        continue;
                    }
                    let quiet_ms = now_ms.saturating_sub(seg.last_ms.load(Ordering::Relaxed));
                    if quiet_ms < limit_ms {
                        continue;
                    }
                    let reason = format!(
                        "the export stalled: segment {} of {} (frames {}..{}) wrote no frame for \
                         {:.0}s, having written {} of its {}. Its encoder was killed and the \
                         export abandoned — the output file is incomplete and was never \
                         finalised, so do not use it. This is a hung render task in a process \
                         that is otherwise healthy (B-231); the known trigger is severe system \
                         memory pressure.",
                        i + 1,
                        job.segments.len(),
                        seg.range.start,
                        seg.range.end,
                        quiet_ms as f64 / 1000.0,
                        seg.written.load(Ordering::Relaxed),
                        seg.range.end - seg.range.start,
                    );
                    log::error!("[chroma::export_status] {reason}");
                    *job.stalled.lock().unwrap_or_else(|e| e.into_inner()) = Some(reason);
                    // Order matters: abort first, so a sibling that is still
                    // making progress stops at its next frame rather than
                    // running on after this one's encoder dies.
                    job.abort.store(true, Ordering::Relaxed);
                    for other in job.segments.iter() {
                        let child = other
                            .encoder
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .take();
                        if let Some(child) = child
                            && let Err(e) = child.kill()
                        {
                            log::warn!("[chroma::export_status] killing a stalled encoder: {e}");
                        }
                    }
                    return;
                }
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| {
            // A render without a watchdog is the pre-D-362 behaviour, not a
            // reason to refuse to export — say so and carry on.
            log::error!("[chroma::export_status] could not start the stall watchdog: {e}");
        });
}

/// What `editor_export_status` answers. Cheap, and safe to call as often as a
/// caller likes: a handful of atomic loads and one short lock.
pub fn snapshot() -> ExportStatus {
    let job = CURRENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .cloned();
    let Some(job) = job else {
        return ExportStatus {
            state: ExportState::Idle,
            phase: None,
            job_id: 0,
            frames_total: 0,
            frames_written: 0,
            percent: 0.0,
            segments_total: 0,
            segments_done: 0,
            segments: Vec::new(),
            elapsed_ms: 0,
            eta_ms: None,
            output: None,
            error: None,
            stall_timeout_secs: STALL_TIMEOUT.as_secs(),
            note: "no compositor export has run in this session — start one with editor_export \
                   (renderer: \"compositor\"). Note that the filter-graph renderer reports no \
                   progress at all; only the compositor path does."
                .to_string(),
        };
    };

    let finished = job
        .finished
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let stalled = job.stall_reason();
    let elapsed_ms = job.started.elapsed().as_millis();
    let now_ms = elapsed_ms as u64;

    let mut frames_written = 0u64;
    let mut segments_done = 0usize;
    let mut eta_ms: Option<u128> = None;
    let segments: Vec<SegmentStatus> = job
        .segments
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let written = s.written.load(Ordering::Relaxed);
            let done = s.done.load(Ordering::Relaxed);
            frames_written += written;
            if done {
                segments_done += 1;
            } else if written > 0 {
                // This segment's own measured rate, extrapolated over what it
                // has left. The render's ETA is the worst of these, not the
                // aggregate — see `ExportStatus::eta_ms`.
                let total = s.range.end - s.range.start;
                let remaining = total.saturating_sub(written);
                let per_frame_ms = elapsed_ms / u128::from(written).max(1);
                let mine = per_frame_ms * u128::from(remaining);
                eta_ms = Some(eta_ms.map_or(mine, |e: u128| e.max(mine)));
            }
            SegmentStatus {
                index: i,
                start_frame: s.range.start,
                end_frame: s.range.end,
                frames_written: written,
                done,
                seconds_since_progress: now_ms.saturating_sub(s.last_ms.load(Ordering::Relaxed))
                    as f64
                    / 1000.0,
            }
        })
        .collect();

    let phase = *job.phase.lock().unwrap_or_else(|e| e.into_inner());
    let (state, error) = match (&finished, &stalled) {
        // A stall is reported as a stall whether or not the render has
        // unwound yet: the verdict is the watchdog's, and the downstream
        // broken-pipe error it causes describes the symptom, not the cause.
        (_, Some(reason)) => (ExportState::Stalled, Some(reason.clone())),
        (Some(Ok(())), None) => (ExportState::Done, None),
        (Some(Err(e)), None) => (ExportState::Failed, Some(e.clone())),
        (None, None) => (ExportState::Running, None),
    };
    let running = state == ExportState::Running;

    let percent = if job.frames_total == 0 {
        0.0
    } else {
        let raw = frames_written as f64 * 100.0 / job.frames_total as f64;
        (raw.clamp(0.0, 100.0) * 10.0).round() / 10.0
    };

    let note = match state {
        ExportState::Running if phase == Phase::Concatenating => format!(
            "every frame is rendered; joining the {} segments and muxing the audio. Poll again.",
            job.segments.len()
        ),
        ExportState::Running => format!(
            "rendering — {frames_written} of {} frames ({percent:.1}%) across {} segment(s), \
             {segments_done} finished. Poll editor_export_status again; a real export takes \
             minutes, and editor_export's own call will time out long before it ends.",
            job.frames_total,
            job.segments.len()
        ),
        ExportState::Done => format!(
            "finished: {frames_written} frames written in {:.1}s across {} segment(s).",
            elapsed_ms as f64 / 1000.0,
            job.segments.len()
        ),
        ExportState::Failed => {
            "the export failed — `error` is the renderer's own reason.".to_string()
        }
        ExportState::Stalled => {
            "the export HUNG and was killed by the stall watchdog. The output file is incomplete \
             and unplayable; re-run the export."
                .to_string()
        }
        ExportState::Idle => String::new(),
    };

    ExportStatus {
        state,
        phase: running.then_some(match phase {
            Phase::Rendering => "rendering",
            Phase::Concatenating => "concatenating",
        }),
        job_id: job.id,
        frames_total: job.frames_total,
        frames_written,
        percent,
        segments_total: job.segments.len(),
        segments_done,
        segments,
        elapsed_ms,
        eta_ms: running.then_some(eta_ms).flatten(),
        output: job.output.clone(),
        error,
        stall_timeout_secs: job.stall_after.as_secs(),
        note,
    }
}

/// Poll the running or last-finished compositor export (D-362).
///
/// The Tauri half of the same snapshot `editor_export_status` answers over the
/// control server — the Export dialog polls this while a job runs so the GUI
/// and an agent are reading one value, not two implementations of it.
#[tauri::command]
pub fn chroma_editor_export_status() -> ExportStatus {
    snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`CURRENT`] is one process-global slot, and `edit_render`'s own render
    /// tests write to it too — so these take the same repo-wide test mutex
    /// those do rather than a second one of their own, which would leave the
    /// two families free to clobber each other's job.
    use super::super::PROJECT_STATE_LOCK as TEST_LOCK;

    fn reset() {
        *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    #[test]
    fn an_untouched_session_is_idle_and_says_how_to_start_one() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let s = snapshot();
        assert_eq!(s.state, ExportState::Idle);
        assert_eq!(s.frames_written, 0);
        assert!(s.note.contains("editor_export"));
    }

    /// **The progress value's core property (D-362).** D-360's ranges partition
    /// the render exactly, so the sum over concurrent workers is a true
    /// fraction of the whole — whatever order they advance in.
    #[test]
    fn progress_sums_across_concurrent_segments() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let ranges = [0..25u64, 25..50, 50..75, 75..100];
        let job = begin(100, &ranges, Some("/tmp/out.mp4".into()), STALL_TIMEOUT).expect("begin");

        // Out of order and unevenly, the way real workers advance.
        for _ in 0..10 {
            job.frame_written(2);
        }
        for _ in 0..5 {
            job.frame_written(0);
        }
        for _ in 0..25 {
            job.frame_written(3);
        }
        job.segment_finished(3);

        let s = snapshot();
        assert_eq!(s.state, ExportState::Running);
        assert_eq!(s.frames_written, 40);
        assert_eq!(s.percent, 40.0);
        assert_eq!(s.segments_total, 4);
        assert_eq!(s.segments_done, 1);
        assert_eq!(s.phase, Some("rendering"));
        assert_eq!(s.segments[2].frames_written, 10);
        assert!(s.segments[3].done);
        // Segment 1 has written nothing, so it contributes no ETA — but
        // segment 0, at 5 of 25, is the slowest of those that have.
        assert!(s.eta_ms.is_some(), "an ETA once anything has been written");

        job.finish(Ok(()));
        let s = snapshot();
        assert_eq!(s.state, ExportState::Done);
        assert_eq!(s.phase, None, "a finished export has no phase");
        assert_eq!(s.eta_ms, None, "nor an ETA");
        assert_eq!(s.output.as_deref(), Some("/tmp/out.mp4"));
    }

    /// A second render cannot start while one is live — two would overwrite
    /// each other's counters and double the bounded encoder budget.
    #[test]
    fn a_second_export_is_refused_while_one_runs() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let ranges = [0..5u64, 5..10];
        let first = begin(10, &ranges, None, STALL_TIMEOUT).expect("the first");
        let Err(err) = begin(10, &ranges, None, STALL_TIMEOUT) else {
            panic!("a second export must be refused while the first is live");
        };
        assert!(err.contains("already rendering"), "{err}");
        first.finish(Ok(()));
        // …and is allowed once the first is done.
        begin(10, &ranges, None, STALL_TIMEOUT).expect("after the first finished");
    }

    /// **The watchdog fires on a worker that goes silent, names it, and aborts
    /// the render** — the unit-level half of B-231 facet 2 (the end-to-end
    /// half, against a real ffmpeg that really stops reading, is
    /// `edit_render`'s `a_stalled_encoder_is_killed_and_reported`).
    #[test]
    fn the_watchdog_fires_on_a_silent_segment() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let job = begin(100, &[0..50, 50..100], None, Duration::from_millis(300)).expect("begin");
        // Segment 0 keeps working; segment 1 never writes anything.
        let deadline = Instant::now() + Duration::from_secs(5);
        while job.stall_reason().is_none() && Instant::now() < deadline {
            job.frame_written(0);
            std::thread::sleep(Duration::from_millis(20));
        }
        let reason = job.stall_reason().expect("the watchdog fired");
        assert!(reason.contains("segment 2 of 2"), "{reason}");
        assert!(reason.contains("50..100"), "{reason}");
        assert!(
            job.abort().load(Ordering::Relaxed),
            "a stall must abort the render"
        );
        let s = snapshot();
        assert_eq!(s.state, ExportState::Stalled);
        assert!(s.error.is_some());
        job.finish(Err("aborted".into()));
        // The stall verdict survives the unwind: the broken-pipe error the kill
        // causes is the symptom, and this is the cause.
        assert_eq!(snapshot().state, ExportState::Stalled);
    }

    /// A segment that finishes is no longer watched — otherwise every
    /// completed segment would trip the watchdog while its siblings ran on.
    #[test]
    fn a_finished_segment_is_not_watched() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset();
        let job = begin(100, &[0..50, 50..100], None, Duration::from_millis(200)).expect("begin");
        job.frame_written(1);
        job.segment_finished(1);
        let deadline = Instant::now() + Duration::from_millis(1200);
        while Instant::now() < deadline {
            job.frame_written(0);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            job.stall_reason().is_none(),
            "a finished segment must not trip the watchdog"
        );
        job.finish(Ok(()));
    }
}
