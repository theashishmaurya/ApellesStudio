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
//! What it does NOT do: build a filtergraph, validate the argv, know an
//!   output path exists, or report progress (`run_ffmpeg` blocks the
//!   calling thread for the whole run — the Tauri command wraps it in
//!   `spawn_blocking`, the exact same shape `chroma::motion::
//!   chroma_motion_render` already uses).
//!
//! **Two execution shapes** (D-330 added the second): [`run_ffmpeg`] is
//! one-shot — spawn, wait, hand back the output — which is right whenever the
//! whole input already exists on disk. [`FfmpegStdinSink`] is the streaming
//! one, for a caller whose frames do not exist yet when ffmpeg starts and
//! arrive over seconds (the debug video recorder, `debug_record.rs`). Both go
//! through the same [`build_command`], so there is still exactly one place
//! this app decides which `ffmpeg` binary to run.
//!
//! **Both stdout AND stderr are captured and returned**, unlike
//! `apelles-motion`'s own `RenderOutcome` (stdout only, since Remotion's CLI
//! puts its real output there) — ffmpeg puts almost everything useful
//! (progress, encoder settings, the final "video:… audio:… muxing
//! overhead:" summary) on STDERR, even on a successful run, so a caller
//! that only got stdout back would see nothing informative most of the time.

use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

/// Which `ffmpeg` to run. `CHROMA_FFMPEG` overrides it, matching
/// `apelles-media`'s `video.rs`/`decode_pipe.rs` and `chroma::export` — this
/// module hard-coded the bare name until D-330 needed the same override for
/// the debug recorder, and having one of four ffmpeg call sites ignore the
/// env var was a trap, not a feature.
pub fn ffmpeg_bin() -> String {
    std::env::var("CHROMA_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

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
/// `Command` construction itself needs. Split out from [`run_ffmpeg`] so
/// the exact argv is unit-testable without actually spawning `ffmpeg`,
/// mirroring `apelles_motion::build_command`'s own reason for existing.
pub fn build_command(req: &FfmpegRunRequest) -> Command {
    let mut cmd = Command::new(ffmpeg_bin());
    cmd.args(&req.args);
    cmd
}

/// A running `ffmpeg` that frames are fed to over stdin (D-330).
///
/// Why this exists next to [`run_ffmpeg`]: that one is one-shot — it spawns,
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
        let mut child = build_command(req)
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

/// Run `req`, blocking until `ffmpeg` exits. Callers on an async runtime
/// should wrap this in `spawn_blocking` (the Tauri command
/// `chroma_run_ffmpeg` does) — same convention `apelles_motion::run_render`
/// already established.
pub fn run_ffmpeg(req: &FfmpegRunRequest) -> Result<FfmpegRunOutcome, String> {
    // B-243 — `_graph_file` must stay in scope until ffmpeg has exited.
    let (args, _graph_file) = spill_oversized_filtergraph(&req.args)
        .map_err(|e| format!("failed to write filtergraph script: {e}"))?;
    let output = build_command(&FfmpegRunRequest::new(args))
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    Ok(FfmpegRunOutcome {
        ok: output.status.success(),
        stdout_tail: tail(&String::from_utf8_lossy(&output.stdout), 20),
        stderr_tail: tail(&String::from_utf8_lossy(&output.stderr), 40),
    })
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

/// Run an arbitrary ffmpeg command line — see this module's own doc
/// comment for why this command has no idea what `args` means. Blocks on a
/// background thread until ffmpeg exits (no progress reporting this pass,
/// same floor `chroma_motion_render` already holds for its own render).
#[tauri::command]
pub async fn chroma_run_ffmpeg(args: Vec<String>) -> Result<FfmpegRunOutcome, String> {
    let req = FfmpegRunRequest::new(args);
    tauri::async_runtime::spawn_blocking(move || run_ffmpeg(&req))
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
        let cmd = build_command(&req);

        assert_eq!(cmd.get_program(), ffmpeg_bin().as_str());
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(args, vec!["-y", "-i", "/tmp/in.mov", "/tmp/out.mp4"]);
    }

    #[test]
    fn build_command_with_no_args_is_just_the_bare_program() {
        let req = FfmpegRunRequest::new(vec![]);
        let cmd = build_command(&req);
        assert_eq!(cmd.get_program(), ffmpeg_bin().as_str());
        assert_eq!(cmd.get_args().count(), 0);
    }

    /// A real integration test — `ffmpeg` is already a hard dependency
    /// everywhere else in this crate's own siblings (`apelles-media`,
    /// `chroma::export`'s own module doc: "Decode the loaded clip
    /// frame-by-frame with ffmpeg"), so it's safe to assume present here
    /// too. `-version` is one of the few ffmpeg invocations that writes its
    /// real output to STDOUT rather than stderr.
    #[test]
    fn run_ffmpeg_version_succeeds_with_stdout() {
        let req = FfmpegRunRequest::new(vec!["-version".to_string()]);
        let outcome = run_ffmpeg(&req).expect("spawning ffmpeg itself must not fail");
        assert!(outcome.ok, "ffmpeg -version should exit 0");
        assert!(
            outcome
                .stdout_tail
                .to_lowercase()
                .contains("ffmpeg version"),
            "expected ffmpeg's own version banner on stdout, got: {}",
            outcome.stdout_tail
        );
    }

    /// A rejected argv reports failure with a real, non-empty stderr tail —
    /// confirming this actually captures something useful, not just a bool.
    #[test]
    fn run_ffmpeg_reports_failure_and_stderr_for_a_bad_flag() {
        let req = FfmpegRunRequest::new(vec!["-not-a-real-flag".to_string()]);
        let outcome = run_ffmpeg(&req).expect("spawning ffmpeg itself must not fail");
        assert!(
            !outcome.ok,
            "an unrecognized flag should make ffmpeg exit non-zero"
        );
        assert!(
            !outcome.stderr_tail.trim().is_empty(),
            "expected ffmpeg to explain the bad flag on stderr"
        );
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
