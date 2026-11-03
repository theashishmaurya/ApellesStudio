//! ffmpeg_run.rs — generic `ffmpeg <argv>` execution primitive (D-183).
//!
//! What it is: a caller-built ffmpeg command line, spawned, with what happened
//!   reported back. It carries zero knowledge of what the args MEAN.
//! What it does NOT do: build an argv or validate it.
//!
//! [`FfmpegStdinSink`] streams frames that do not exist yet when ffmpeg starts
//! and arrive over seconds (the debug video recorder, `debug_record.rs`), through
//! [`build_command`]. Which `ffmpeg` binary that is, is not decided here at all:
//! it is `apelles_media::ffmpeg_locate`'s, the one resolver every spawn in the
//! workspace uses (D-389, B-253). (D-448 deleted the Edit export's filter-graph
//! runner, `chroma_run_editor_export`, that used to live here: every export is
//! the compositor's, `chroma::edit_render`.)
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

/// One ffmpeg invocation: just the argv that follows `ffmpeg` itself. No
/// cwd of its own (unlike `apelles_motion::RenderRequest`, which must run
/// inside `packages/motion-engine`) — every path an ffmpeg argv needs is
/// expected to already be absolute.
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

/// The last `n` lines of `s`.
fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join(
        "
",
    )
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
}
