//! ffmpeg_run.rs — generic `ffmpeg <argv>` execution primitive (D-183).
//!
//! What it is: the ONE place this app spawns an arbitrary, caller-built
//!   ffmpeg command line and reports what happened. It carries zero
//!   knowledge of what the args MEAN — no filtergraph construction, no
//!   timeline/clip model, nothing. That knowledge lives entirely in
//!   `packages/editor/src/timelineExport.ts` (D-183's Edit-tab timeline
//!   exporter, a pure TS function that reads the real `Timeline`/`Clip[]`
//!   model and emits one ffmpeg argv) — this command just runs whatever
//!   argv it's handed, mirroring `crates/apelles-motion`'s own
//!   `build_command`/`run_render` split (pure argv builder, unit-testable
//!   without spawning anything; a thin execute wrapper on top of it) one
//!   level more generic, since this one has no fixed program args of its
//!   own at all beyond the `ffmpeg` binary itself.
//! What it does NOT do: build a filtergraph or validate the argv.
//!
//! **Two execution shapes** (D-330 added the second, D-441 reshaped the first):
//! [`run_editor_export`] is the Edit export's filter-graph run — spawn, wait,
//! hand back the output — attached to `export_job`'s cancel registration so a
//! running export can be stopped, with the output folder created first and the
//! optional loudness pass (D-401) inside the same run. [`FfmpegStdinSink`] is the
//! streaming one, for a caller whose frames do not exist yet when ffmpeg starts
//! and arrive over seconds (the debug video recorder, `debug_record.rs`). Both
//! go through the same [`build_command`]. Which `ffmpeg` binary that is, is not
//! decided here at all: it is `apelles_media::ffmpeg_locate`'s, the one
//! resolver every spawn in the workspace uses (D-389, B-253).
//!
//! **Both stdout AND stderr are captured and returned**, unlike
//! `apelles-motion`'s own `RenderOutcome` (stdout only, since Remotion's CLI
//! puts its real output there) — ffmpeg puts almost everything useful
//! (progress, encoder settings, the final "video:… audio:… muxing
//! overhead:" summary) on STDERR, even on a successful run, so a caller
//! that only got stdout back would see nothing informative most of the time.

use std::io::Write;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use apelles_media::loudness::{LoudnessReport, LoudnessTarget};

use super::export_job;

/// One ffmpeg invocation: just the argv that follows `ffmpeg` itself. No
/// cwd of its own (unlike `apelles_motion::RenderRequest`, which must run
/// inside `packages/motion-engine`) — every path an ffmpeg argv needs is
/// expected to already be absolute, since the caller (`timelineExport.ts`)
/// builds it from the project's own absolute source/output paths.
#[derive(Debug, Clone)]
pub struct FfmpegRunRequest {
    pub args: Vec<String>,
}

impl FfmpegRunRequest {
    pub fn new(args: Vec<String>) -> Self {
        Self { args }
    }
}

/// The finished run's outcome — both tails always populated (not just on
/// failure): ffmpeg's own encoding summary/output-file stats land on
/// stderr even when `ok` is `true`, so a caller inspecting only a failure
/// path would miss them on a real success too.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FfmpegRunOutcome {
    pub ok: bool,
    pub stdout_tail: String,
    pub stderr_tail: String,
}

/// Build the `ffmpeg <args>` invocation — pure, no I/O beyond what
/// `Command` construction itself needs. Split out from [`run_editor_export`] so
/// the exact argv is unit-testable without actually spawning `ffmpeg`,
/// mirroring `apelles_motion::build_command`'s own reason for existing.
///
/// Fails only when no `ffmpeg` can be found at all, with the resolver's own
/// explanation of where it looked.
pub fn build_command(req: &FfmpegRunRequest) -> Result<Command, String> {
    let mut cmd = apelles_media::ffmpeg_locate::ffmpeg().map_err(|e| e.to_string())?;
    cmd.args(&req.args);
    Ok(cmd)
}

/// A running `ffmpeg` that frames are fed to over stdin (D-330).
///
/// Why this exists next to [`run_editor_export`]: that one is one-shot — it spawns,
/// waits, and hands back the whole output. The debug video recorder cannot
/// work that way, because its input does not exist yet when ffmpeg starts:
/// frames are captured live, over seconds, and must go down the pipe as they
/// arrive. Buffering them instead is not an option at these sizes (a single
/// 1280×720 RGBA frame is 3.7 MB, so even a short recording is gigabytes).
///
/// The stderr drain on a background thread is not optional and is the reason
/// this is a struct rather than two free functions: ffmpeg writes progress to
/// stderr continuously, and a pipe nobody reads fills its OS buffer and
/// blocks the writer — which here means ffmpeg stops consuming stdin and the
/// recorder deadlocks partway through. Same shape `chroma::export`'s own
/// streaming encoder already uses, for the same reason.
pub struct FfmpegStdinSink {
    child: Child,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl FfmpegStdinSink {
    /// Spawn `ffmpeg <args>` with stdin piped and stderr drained. The argv
    /// must describe stdin as the input (`-i -`); nothing here checks that,
    /// exactly as [`build_command`] carries no knowledge of what its args
    /// mean.
    pub fn spawn(req: &FfmpegRunRequest) -> Result<Self, String> {
        let mut child = build_command(req)?
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut pipe) = child.stderr.take() {
            let sink = Arc::clone(&stderr);
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match std::io::Read::read(&mut pipe, &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(mut guard) = sink.lock() {
                                guard.extend_from_slice(&buf[..n]);
                            }
                        }
                    }
                }
            });
        }

        Ok(Self { child, stderr })
    }

    /// Write one frame's bytes to ffmpeg's stdin.
    ///
    /// A broken pipe here means ffmpeg has already exited — almost always
    /// because it rejected the argv — so the error carries its stderr tail
    /// rather than a bare `EPIPE` the caller could do nothing with.
    pub fn write_frame(&mut self, bytes: &[u8]) -> Result<(), String> {
        // Cloned before the mutable borrow of `child` below: reading the
        // stderr buffer inside the error path would otherwise be a second
        // borrow of `self` while the first is still live.
        let stderr = Arc::clone(&self.stderr);
        let stdin = self
            .child
            .stdin
            .as_mut()
            .ok_or_else(|| "ffmpeg's stdin was already closed".to_string())?;
        stdin.write_all(bytes).map_err(|e| {
            format!(
                "ffmpeg stopped accepting frames ({e}) — it exited early. Its own last words:\n{}",
                tail_of(&stderr, 40)
            )
        })
    }

    /// Close stdin (ffmpeg's signal to flush and finish muxing) and wait for
    /// it to exit.
    pub fn finish(mut self) -> Result<FfmpegRunOutcome, String> {
        // Dropping stdin is what tells ffmpeg the stream ended; without it
        // ffmpeg waits for more input forever and `wait` never returns.
        drop(self.child.stdin.take());

        let status = self
            .child
            .wait()
            .map_err(|e| format!("could not wait for ffmpeg: {e}"))?;

        let mut stdout = Vec::new();
        if let Some(mut pipe) = self.child.stdout.take() {
            let _ = std::io::Read::read_to_end(&mut pipe, &mut stdout);
        }

        Ok(FfmpegRunOutcome {
            ok: status.success(),
            stdout_tail: tail(&String::from_utf8_lossy(&stdout), 20),
            stderr_tail: self.stderr_tail(40),
        })
    }

    fn stderr_tail(&self, lines: usize) -> String {
        tail_of(&self.stderr, lines)
    }
}

/// The last `lines` lines of a drained stderr buffer. A free function rather
/// than a method so the error path in `write_frame` can reach it while the
/// child process is mutably borrowed.
fn tail_of(stderr: &Arc<Mutex<Vec<u8>>>, lines: usize) -> String {
    match stderr.lock() {
        Ok(guard) => tail(&String::from_utf8_lossy(&guard), lines),
        Err(_) => String::new(),
    }
}

/// Spill a very large `-filter_complex` graph to a file past this many
/// bytes (B-243). Not the OS limit itself: macOS's `ARG_MAX` is 1 MiB for
/// argv AND envp COMBINED, so the real ceiling for one argument depends on
/// the caller's environment and cannot be computed reliably here. This is a
/// deliberately conservative bar — comfortably spawnable everywhere, and
/// high enough that an ordinary export's argv is untouched and still reads
/// as one copy-pasteable command line in a log.
const MAX_INLINE_FILTERGRAPH_BYTES: usize = 100_000;

/// A filtergraph written to a temp file, deleted when this is dropped.
///
/// It must outlive the `ffmpeg` process, which is the whole reason this is a
/// value the caller holds rather than a file written and forgotten inside a
/// helper: `-filter_complex_script` makes ffmpeg READ the path at startup,
/// so deleting it before the child has run is a race that would surface as
/// an unreproducible "No such file or directory" on busy machines only.
pub struct SpilledFiltergraph {
    path: std::path::PathBuf,
}

impl Drop for SpilledFiltergraph {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// B-243 — rewrite `-filter_complex <graph>` to `-filter_complex_script
/// <file>` when the graph is too big to pass as an argument.
///
/// Why here and not in `timelineExport.ts`, which builds the argv: the limit
/// being hit is a property of process spawning, not of the timeline model,
/// and the TS builder is deliberately pure (no I/O, unit-testable without a
/// filesystem). Doing it at the spawn boundary also fixes it once for every
/// caller rather than for the one that happened to hit it first.
///
/// Returns the args to actually spawn plus, when a spill happened, the guard
/// that owns the temp file's lifetime.
pub fn spill_oversized_filtergraph(
    args: &[String],
) -> std::io::Result<(Vec<String>, Option<SpilledFiltergraph>)> {
    let Some(flag_idx) = args.iter().position(|a| a == "-filter_complex") else {
        return Ok((args.to_vec(), None));
    };
    let Some(graph) = args.get(flag_idx + 1) else {
        return Ok((args.to_vec(), None));
    };
    if graph.len() <= MAX_INLINE_FILTERGRAPH_BYTES {
        return Ok((args.to_vec(), None));
    }

    // Nanosecond suffix as well as the pid: two exports from the same
    // process must not collide on the same scratch file.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "apelles-filtergraph-{}-{stamp}.txt",
        std::process::id()
    ));
    std::fs::write(&path, graph)?;

    let mut out = args.to_vec();
    out[flag_idx] = "-filter_complex_script".to_string();
    out[flag_idx + 1] = path.to_string_lossy().into_owned();
    Ok((out, Some(SpilledFiltergraph { path })))
}

/// The last `n` lines of `s` — enough context to explain a failure (or
/// confirm a real success) without dumping ffmpeg's whole console log into
/// the result. Copied verbatim from `apelles_motion`'s own private `tail()`
/// helper (`crates/apelles-motion/src/lib.rs`) rather than importing it —
/// that crate doesn't export it, and duplicating four lines of pure string
/// logic is cheaper than widening its own public API for a second caller.
fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// What [`run_editor_export`] reports (D-441).
#[derive(Debug, Clone, serde::Serialize)]
pub struct EditorExportRunOutcome {
    pub ok: bool,
    /// The run was cancelled; its partial output is gone.
    pub cancelled: bool,
    pub stdout_tail: String,
    pub stderr_tail: String,
    /// D-401 — what the loudness pass measured and did, when one was asked for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loudness: Option<LoudnessReport>,
}

impl EditorExportRunOutcome {
    fn cancelled(stdout_tail: String) -> Self {
        Self {
            ok: false,
            cancelled: true,
            stdout_tail,
            stderr_tail: export_job::CANCELLED_MESSAGE.to_string(),
            loudness: None,
        }
    }
}

/// **The filter-graph Edit export, start to finish, cancellable (D-183, D-401,
/// D-441).**
///
/// Spawns the caller's argv (one ffmpeg that composites, encodes and muxes the
/// whole timeline) as a `SharedChild` attached to the export's
/// [`export_job`] registration under `cancel_token`, so the Export panel's
/// Cancel and `editor_cancel_export` can stop it. Creates the output folder
/// first (the panel's default is `~/Movies/<project>/`, which does not exist
/// before the first export). When `loudness` is given, the finished file is
/// normalised in place by `apelles_media::loudness` inside the same
/// registration (D-401), so a cancel during that pass is honoured too.
///
/// A cancelled run removes its partial output (and the loudness pass's scratch
/// files) and returns `cancelled: true`. A failed run reports ffmpeg's own
/// stderr tail.
pub fn run_editor_export(
    req: &FfmpegRunRequest,
    output: &Path,
    cancel_token: Option<&str>,
    loudness: Option<LoudnessTarget>,
) -> Result<EditorExportRunOutcome, String> {
    let guard = match export_job::register(cancel_token) {
        Ok(g) => g,
        Err(reason) if reason == export_job::CANCELLED_MESSAGE => {
            return Ok(EditorExportRunOutcome::cancelled(String::new()));
        }
        Err(e) => return Err(e),
    };
    export_job::ensure_output_dir(output)?;
    // B-243 — `_graph_file` must stay in scope until ffmpeg has exited.
    let (args, _graph_file) = spill_oversized_filtergraph(&req.args)
        .map_err(|e| format!("failed to write filtergraph script: {e}"))?;
    let mut cmd = build_command(&FfmpegRunRequest::new(args))?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = Arc::new(
        shared_child::SharedChild::spawn(&mut cmd)
            .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?,
    );
    guard.attach(&child);
    let stdout = drain(child.take_stdout());
    let stderr = drain(child.take_stderr());
    let status = child
        .wait()
        .map_err(|e| format!("could not wait for ffmpeg: {e}"))?;
    let stdout_tail = tail(&String::from_utf8_lossy(&joined(stdout)), 20);
    let stderr_tail = tail(&String::from_utf8_lossy(&joined(stderr)), 40);
    if guard.is_cancelled() {
        export_job::discard_partial_output(output);
        return Ok(EditorExportRunOutcome::cancelled(stdout_tail));
    }
    if !status.success() {
        return Ok(EditorExportRunOutcome {
            ok: false,
            cancelled: false,
            stdout_tail,
            stderr_tail,
            loudness: None,
        });
    }
    let Some(target) = loudness else {
        return Ok(EditorExportRunOutcome {
            ok: true,
            cancelled: false,
            stdout_tail,
            stderr_tail,
            loudness: None,
        });
    };
    let report = apelles_media::loudness::normalise_in_place(output, target);
    if guard.is_cancelled() {
        export_job::discard_partial_output(output);
        return Ok(EditorExportRunOutcome::cancelled(stdout_tail));
    }
    Ok(match report {
        Ok(report) => EditorExportRunOutcome {
            ok: true,
            cancelled: false,
            stdout_tail,
            stderr_tail,
            loudness: Some(report),
        },
        Err(e) => EditorExportRunOutcome {
            ok: false,
            cancelled: false,
            stdout_tail,
            stderr_tail: format!("the export was written but loudness normalisation failed: {e}"),
            loudness: None,
        },
    })
}

/// Read a child's pipe to the end on a background thread. Both pipes must be
/// drained while the child runs: one nobody reads fills its OS buffer and
/// stalls ffmpeg.
fn drain<R: std::io::Read + Send + 'static>(
    pipe: Option<R>,
) -> Option<std::thread::JoinHandle<Vec<u8>>> {
    pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut out = Vec::new();
            // A read error ends the drain; whatever was read is still the tail.
            let _ = std::io::Read::read_to_end(&mut pipe, &mut out);
            out
        })
    })
}

/// The bytes a [`drain`] thread read, once the child has exited (its pipe then
/// hits end of file, so the join is prompt).
fn joined(drain: Option<std::thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    drain.and_then(|h| h.join().ok()).unwrap_or_default()
}

/// The Edit export's filter-graph run (D-441): [`run_editor_export`] on a
/// worker thread. `output` is the file the argv writes (its folder is created;
/// a cancelled run removes it), `cancelToken` the export queue's job id, and
/// `loudness` the optional D-401 target.
#[tauri::command]
pub async fn chroma_run_editor_export(
    args: Vec<String>,
    output: String,
    cancel_token: Option<String>,
    loudness: Option<LoudnessTarget>,
) -> Result<EditorExportRunOutcome, String> {
    let req = FfmpegRunRequest::new(args);
    tauri::async_runtime::spawn_blocking(move || {
        run_editor_export(&req, Path::new(&output), cancel_token.as_deref(), loudness)
    })
    .await
    .map_err(|e| format!("ffmpeg task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_command_sets_program_and_argv_in_order() {
        let req = FfmpegRunRequest::new(vec![
            "-y".to_string(),
            "-i".to_string(),
            "/tmp/in.mov".to_string(),
            "/tmp/out.mp4".to_string(),
        ]);
        let Ok(cmd) = build_command(&req) else {
            eprintln!("skip: no ffmpeg found");
            return;
        };

        assert_eq!(
            Some(cmd.get_program()),
            apelles_media::ffmpeg_locate::ffmpeg_path()
                .ok()
                .map(|p| p.as_os_str())
        );
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["-y", "-i", "/tmp/in.mov", "/tmp/out.mp4"]);
    }

    #[test]
    fn build_command_with_no_args_is_just_the_bare_program() {
        let req = FfmpegRunRequest::new(vec![]);
        let Ok(cmd) = build_command(&req) else {
            eprintln!("skip: no ffmpeg found");
            return;
        };
        assert_eq!(
            Some(cmd.get_program()),
            apelles_media::ffmpeg_locate::ffmpeg_path()
                .ok()
                .map(|p| p.as_os_str())
        );
        assert_eq!(cmd.get_args().count(), 0);
    }

    /// D-441 — a running filter-path export is stopped by a cancel under its
    /// job id, reports `cancelled`, and leaves no partial file; its output
    /// folder was created for it.
    #[test]
    fn a_cancelled_editor_export_stops_and_removes_its_partial_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("new folder").join("cancel-me.mp4");
        // A long synthetic encode: minutes of work unless it is stopped.
        let args: Vec<String> = [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1280x720:rate=30",
            "-t",
            "600",
            "-c:v",
            "libx264",
            "-preset",
            "veryslow",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(out.to_string_lossy().into_owned()))
        .collect();
        let canceller = std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(800));
            super::super::export_job::cancel("ffmpeg-run-cancel")
        });
        let started = std::time::Instant::now();
        let outcome = run_editor_export(
            &FfmpegRunRequest::new(args),
            &out,
            Some("ffmpeg-run-cancel"),
            None,
        )
        .expect("the run itself must not error");
        assert!(canceller.join().expect("join").was_running);
        assert!(outcome.cancelled && !outcome.ok, "{outcome:?}");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(30),
            "stopped promptly"
        );
        assert!(!out.exists(), "the partial file is removed");
        assert!(
            out.parent().is_some_and(std::path::Path::is_dir),
            "the folder was created"
        );
    }

    /// A rejected argv reports failure with a real, non-empty stderr tail —
    /// confirming the run captures something useful, not just a bool.
    #[test]
    fn a_failed_editor_export_reports_ffmpegs_own_reason() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("never.mp4");
        let req = FfmpegRunRequest::new(vec!["-not-a-real-flag".to_string()]);
        let outcome = run_editor_export(&req, &out, None, None).expect("spawning must not fail");
        assert!(!outcome.ok && !outcome.cancelled);
        assert!(
            !outcome.stderr_tail.trim().is_empty(),
            "expected ffmpeg to explain the bad flag on stderr"
        );
    }

    /// A real, tiny encode finishes `ok` and writes its file.
    #[test]
    fn a_short_editor_export_finishes_and_writes_its_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let out = dir.path().join("ok.mp4");
        let args: Vec<String> = [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x64:rate=10",
            "-t",
            "0.5",
        ]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(out.to_string_lossy().into_owned()))
        .collect();
        let outcome =
            run_editor_export(&FfmpegRunRequest::new(args), &out, None, None).expect("run");
        assert!(outcome.ok, "{outcome:?}");
        assert!(out.exists());
    }

    /// B-243 — an ordinary export's argv is left completely alone, so the
    /// common path keeps its one copy-pasteable command line.
    #[test]
    fn a_small_filtergraph_is_left_inline() {
        let args = vec![
            "-filter_complex".to_string(),
            "[0:v][1:v]overlay[out]".to_string(),
            "-map".to_string(),
            "[out]".to_string(),
        ];
        let (out, guard) = spill_oversized_filtergraph(&args).expect("no I/O should be needed");
        assert!(guard.is_none(), "a tiny graph must not spill to a file");
        assert_eq!(out, args);
    }

    /// B-243's actual defect: a 98-clip timeline's graph exceeded the OS
    /// argv limit and `ffmpeg` could not be spawned at all. Pre-fix this
    /// returned the graph inline and the spawn failed with
    /// `Argument list too long (os error 7)`.
    #[test]
    fn an_oversized_filtergraph_spills_to_a_script_file() {
        let graph = "x".repeat(MAX_INLINE_FILTERGRAPH_BYTES + 1);
        let args = vec![
            "-i".to_string(),
            "/tmp/a.mov".to_string(),
            "-filter_complex".to_string(),
            graph.clone(),
            "-map".to_string(),
            "[out]".to_string(),
        ];
        let (out, guard) = spill_oversized_filtergraph(&args).expect("temp write must succeed");
        let guard = guard.expect("an oversized graph must spill");

        assert_eq!(out[2], "-filter_complex_script");
        assert_ne!(out[3], graph, "the graph must not still be inline");
        assert_eq!(
            std::fs::read_to_string(&out[3]).expect("the script file must exist while running"),
            graph,
            "the spilled file must hold the graph verbatim"
        );
        // Everything either side of the flag is untouched.
        assert_eq!(&out[0..2], &args[0..2]);
        assert_eq!(&out[4..], &args[4..]);

        let path = out[3].clone();
        drop(guard);
        assert!(
            !std::path::Path::new(&path).exists(),
            "the temp file must be cleaned up when the guard drops"
        );
    }

    /// An argv with no filtergraph at all is a no-op — the helper runs on
    /// every ffmpeg invocation, including the debug recorder's.
    #[test]
    fn an_argv_without_a_filtergraph_is_untouched() {
        let args = vec![
            "-i".to_string(),
            "-".to_string(),
            "/tmp/out.mp4".to_string(),
        ];
        let (out, guard) = spill_oversized_filtergraph(&args).expect("no I/O should be needed");
        assert!(guard.is_none());
        assert_eq!(out, args);
    }
}
