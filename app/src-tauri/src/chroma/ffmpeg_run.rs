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
//! **Both stdout AND stderr are captured and returned**, unlike
//! `apelles-motion`'s own `RenderOutcome` (stdout only, since Remotion's CLI
//! puts its real output there) — ffmpeg puts almost everything useful
//! (progress, encoder settings, the final "video:… audio:… muxing
//! overhead:" summary) on STDERR, even on a successful run, so a caller
//! that only got stdout back would see nothing informative most of the time.

use std::process::Command;

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
    let mut cmd = Command::new("ffmpeg");
    cmd.args(&req.args);
    cmd
}

/// Run `req`, blocking until `ffmpeg` exits. Callers on an async runtime
/// should wrap this in `spawn_blocking` (the Tauri command
/// `chroma_run_ffmpeg` does) — same convention `apelles_motion::run_render`
/// already established.
pub fn run_ffmpeg(req: &FfmpegRunRequest) -> Result<FfmpegRunOutcome, String> {
    let output = build_command(req)
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

        assert_eq!(cmd.get_program(), "ffmpeg");
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
        assert_eq!(cmd.get_program(), "ffmpeg");
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
            outcome.stdout_tail.to_lowercase().contains("ffmpeg version"),
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
        assert!(!outcome.ok, "an unrecognized flag should make ffmpeg exit non-zero");
        assert!(
            !outcome.stderr_tail.trim().is_empty(),
            "expected ffmpeg to explain the bad flag on stderr"
        );
    }
}
