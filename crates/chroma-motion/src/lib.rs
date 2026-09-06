//! # chroma-motion — L2 domain crate (D-039 roadmap "Motion tab MVP", D-046)
//!
//! **What it is:** the manifest → render bridge for the Motion tab. Turns a
//! finished scene manifest (the JSON `@chroma/motion-engine` compiles — see
//! `packages/motion-engine/src/engine/schema.ts`) into a real render by
//! shelling out to the engine's own, already-documented render command:
//! `npx remotion render Animation <output> --props=<manifest>` run inside
//! `packages/motion-engine/`.
//!
//! **Why Rust wraps Node instead of the other way round:** the Remotion
//! engine (7 primitives, a manifest compiler, React/Three.js rendering) IS
//! the fat core for motion graphics — reimplementing that in Rust would
//! throw away real, working, non-trivial code to satisfy an architectural
//! preference. `chroma-motion` is the one deliberate exception to "the fat
//! core is Rust" in this workspace's thin-shell/fat-core rule; see D-046 in
//! `docs/08-decisions.md`.
//!
//! **What it does NOT do:** no manifest schema validation beyond "is this
//! parseable JSON" — the manifest schema's single source of truth is the
//! `zod` schema in `packages/motion-engine/src/engine/schema.ts` (and
//! Remotion's own `calculateMetadata` re-validates it on render); duplicating
//! that schema in Rust would just drift. No GPU, no media decode, no
//! progress reporting (`run_render` blocks the calling thread for the whole
//! render — the Tauri command wraps it in `spawn_blocking`).
//!
//! **Status:** D-046 — the render-bridge MVP. See `crates/chroma-motion/README.md`.

use std::path::PathBuf;
use std::process::Command;

use chroma_types::ChromaError;

/// One render job: a manifest + where the engine lives + where the output goes.
#[derive(Debug, Clone)]
pub struct RenderRequest {
    /// `packages/motion-engine` — the Remotion project directory `npx` runs in.
    pub engine_dir: PathBuf,
    /// Absolute path to the manifest JSON (`--props=`).
    pub manifest_path: PathBuf,
    /// Absolute output file path — its extension picks the Remotion codec
    /// (`.mp4`, `.mov` for a transparent ProRes4444 overlay, …).
    pub output_path: PathBuf,
    /// The Remotion composition id to render. Always `"Animation"` for a
    /// manifest-driven render — the engine's `*Demo` compositions are
    /// dev-only living references, not render targets.
    pub composition_id: String,
    /// D-180 — an inclusive `(start, end)` absolute-frame range, rendering
    /// only that sub-range of the composition (Remotion's own
    /// `--frames=<start>-<end>` CLI flag) instead of the whole thing.
    /// `None` renders every frame, unchanged from this struct's original
    /// shape. Deliberately just two numbers, not a scene id/index — this
    /// crate stays manifest-shape agnostic (this module's own doc comment:
    /// "no manifest schema validation beyond is this parseable JSON"); the
    /// frontend already owns `sceneStartFrame`/`sceneDurationFrames`
    /// (`packages/motion-engine/src/engine/build.ts`) and computes the range
    /// itself before this request is ever built — duplicating that scene
    /// math in Rust would just drift from the one real source of it.
    pub frame_range: Option<(u32, u32)>,
}

impl RenderRequest {
    pub fn new(
        engine_dir: impl Into<PathBuf>,
        manifest_path: impl Into<PathBuf>,
        output_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            engine_dir: engine_dir.into(),
            manifest_path: manifest_path.into(),
            output_path: output_path.into(),
            composition_id: "Animation".to_string(),
            frame_range: None,
        }
    }

    /// Builder for D-180's per-scene export — see `frame_range`'s own doc
    /// comment for why this takes raw frame numbers, not a scene reference.
    pub fn with_frame_range(mut self, start: u32, end: u32) -> Self {
        self.frame_range = Some((start, end));
        self
    }
}

/// The finished render's location + a tail of `npx`'s stdout — surfaced to
/// the UI as a plain success log, never parsed for structured progress.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RenderOutcome {
    pub output_path: PathBuf,
    pub stdout_tail: String,
}

/// Check the request is runnable before spawning anything: the engine
/// directory and manifest file must exist, and the manifest must at least
/// parse as JSON. A fast, clear failure here beats a cryptic `npx`/zod error
/// surfacing three process-levels down.
pub fn validate_request(req: &RenderRequest) -> Result<(), ChromaError> {
    if !req.engine_dir.is_dir() {
        return Err(ChromaError::NotFound(format!(
            "motion engine dir: {}",
            req.engine_dir.display()
        )));
    }
    let manifest_text = std::fs::read_to_string(&req.manifest_path).map_err(|e| {
        ChromaError::NotFound(format!("manifest {}: {e}", req.manifest_path.display()))
    })?;
    serde_json::from_str::<serde_json::Value>(&manifest_text)
        .map_err(|e| ChromaError::Invalid(format!("manifest is not valid JSON: {e}")))?;
    Ok(())
}

/// Build the `npx remotion render` invocation for `req` — pure, no I/O
/// beyond what `Command` construction itself needs. Split out from
/// [`run_render`] so the exact argv/cwd is unit-testable without actually
/// spawning `npx`.
pub fn build_command(req: &RenderRequest) -> Command {
    let mut cmd = Command::new("npx");
    cmd.current_dir(&req.engine_dir);
    cmd.args([
        "remotion",
        "render",
        req.composition_id.as_str(),
        &req.output_path.to_string_lossy(),
        &format!("--props={}", req.manifest_path.display()),
    ]);
    if let Some((start, end)) = req.frame_range {
        cmd.arg(format!("--frames={start}-{end}"));
    }
    cmd
}

/// Validate, then run the render synchronously (blocks until `npx` exits).
/// Callers on an async runtime should wrap this in `spawn_blocking` (the
/// Tauri command `chroma_motion_render` does).
pub fn run_render(req: &RenderRequest) -> Result<RenderOutcome, ChromaError> {
    validate_request(req)?;
    let output = build_command(req)
        .output()
        .map_err(|e| ChromaError::Invalid(format!("failed to spawn npx: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        return Err(ChromaError::Invalid(format!(
            "remotion render exited {code}: {}",
            tail(&stderr, 40)
        )));
    }

    Ok(RenderOutcome {
        output_path: req.output_path.clone(),
        stdout_tail: tail(&String::from_utf8_lossy(&output.stdout), 20),
    })
}

/// The last `n` lines of `s` — enough context to explain a failure without
/// dumping a whole bundler log into an error string.
fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_command_sets_cwd_and_argv() {
        let req = RenderRequest::new("/engine", "/tmp/manifest.json", "/tmp/out.mp4");
        let cmd = build_command(&req);

        assert_eq!(cmd.get_program(), "npx");
        assert_eq!(cmd.get_current_dir(), Some(std::path::Path::new("/engine")));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "remotion",
                "render",
                "Animation",
                "/tmp/out.mp4",
                "--props=/tmp/manifest.json",
            ]
        );
    }

    #[test]
    fn build_command_appends_frames_flag_when_a_range_is_set() {
        let req = RenderRequest::new("/engine", "/tmp/manifest.json", "/tmp/out.mp4")
            .with_frame_range(120, 299);
        let cmd = build_command(&req);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                "remotion",
                "render",
                "Animation",
                "/tmp/out.mp4",
                "--props=/tmp/manifest.json",
                "--frames=120-299",
            ]
        );
    }

    #[test]
    fn build_command_omits_frames_flag_by_default() {
        let req = RenderRequest::new("/engine", "/tmp/manifest.json", "/tmp/out.mp4");
        let cmd = build_command(&req);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(!args.iter().any(|a| a.starts_with("--frames=")));
    }

    #[test]
    fn validate_request_rejects_missing_engine_dir() {
        let req = RenderRequest::new("/no/such/engine/dir", "/tmp/manifest.json", "/tmp/out.mp4");
        let err = validate_request(&req).unwrap_err();
        assert!(matches!(err, ChromaError::NotFound(_)));
    }

    #[test]
    fn validate_request_rejects_missing_manifest() {
        let dir = std::env::temp_dir();
        let req = RenderRequest::new(dir, "/no/such/chroma-motion-manifest.json", "/tmp/out.mp4");
        let err = validate_request(&req).unwrap_err();
        assert!(matches!(err, ChromaError::NotFound(_)));
    }

    #[test]
    fn validate_request_rejects_non_json_manifest() {
        let dir = std::env::temp_dir();
        let bad = dir.join(format!(
            "chroma-motion-test-bad-{}.json",
            std::process::id()
        ));
        std::fs::write(&bad, "not json").unwrap();

        let req = RenderRequest::new(&dir, &bad, "/tmp/out.mp4");
        let err = validate_request(&req).unwrap_err();
        assert!(matches!(err, ChromaError::Invalid(_)));

        let _ = std::fs::remove_file(&bad);
    }

    #[test]
    fn validate_request_accepts_a_valid_manifest() {
        let dir = std::env::temp_dir();
        let good = dir.join(format!("chroma-motion-test-ok-{}.json", std::process::id()));
        std::fs::write(&good, r#"{"title":"t","scenes":[]}"#).unwrap();

        let req = RenderRequest::new(&dir, &good, "/tmp/out.mp4");
        assert!(validate_request(&req).is_ok());

        let _ = std::fs::remove_file(&good);
    }
}
