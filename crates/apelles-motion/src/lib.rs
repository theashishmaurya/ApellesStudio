//! # apelles-motion — L2 domain crate (D-039 roadmap "Motion tab MVP", D-046)
//!
//! **What it is:** the manifest → render bridge for the Motion tab. Turns a
//! finished scene manifest (the JSON `@apelles/motion-engine` compiles — see
//! `packages/motion-engine/src/engine/schema.ts`) into a real render by running
//! the engine's renderer, `node scripts/render.mts` (D-417: `@remotion/renderer`
//! over a prebuilt Remotion bundle), with the Node, browser and engine files the
//! one resolver in `apelles-motion-runtime` located.
//!
//! **Why Rust wraps Node instead of the other way round:** the Remotion
//! engine (7 primitives, a manifest compiler, React/Three.js rendering) IS
//! the fat core for motion graphics — reimplementing that in Rust would
//! throw away real, working, non-trivial code to satisfy an architectural
//! preference. `apelles-motion` is the one deliberate exception to "the fat
//! core is Rust" in this workspace's thin-shell/fat-core rule; see D-046 in
//! `docs/08-decisions.md`.
//!
//! **What it does NOT do:** no manifest schema validation beyond "is this
//! parseable JSON" — the manifest schema's single source of truth is the
//! `zod` schema in `packages/motion-engine/src/engine/schema.ts` (and
//! Remotion's own `calculateMetadata` re-validates it on render); duplicating
//! that schema in Rust would just drift. No GPU, no media decode, no
//! progress reporting (`run_render` blocks the calling thread for the whole
//! render — the Tauri command wraps it in `spawn_blocking`). No downloading or
//! locating of Node / Chrome (that is `apelles-motion-runtime`, D-417).
//!
//! **Status:** D-046 — the render-bridge MVP. See `crates/apelles-motion/README.md`.

pub mod assets;
pub mod components;
pub mod job;
pub mod still;
pub mod templates;

use std::path::{Path, PathBuf};
use std::process::Command;

use apelles_types::ChromaError;

pub use apelles_motion_runtime::{MotionRuntime, RuntimeSource};

/// One render job: a manifest + the runtime that renders it + where the
/// output goes.
#[derive(Debug, Clone)]
pub struct RenderRequest {
    /// The located runtime (Node, browser, engine files) — D-417.
    pub runtime: MotionRuntime,
    /// Where engine bundles are cached (`still::ensure_bundle`).
    pub bundle_cache: PathBuf,
    /// Absolute path to the manifest JSON (`--props=`).
    pub manifest_path: PathBuf,
    /// Absolute output file path — its extension picks the codec (`.mp4` →
    /// H.264, `.mov` → ProRes; `scripts/render.mts`'s `codecFor`).
    pub output_path: PathBuf,
    /// The Remotion composition id to render. Always `"Animation"` for a
    /// manifest-driven render — the engine's `*Demo` compositions are
    /// dev-only living references, not render targets.
    pub composition_id: String,
    /// D-180 — an inclusive `(start, end)` absolute-frame range, rendering
    /// only that sub-range of the composition (`--frames=<start>-<end>`)
    /// instead of the whole thing. `None` renders every frame. Deliberately
    /// just two numbers, not a scene id/index — this crate stays
    /// manifest-shape agnostic (this module's own doc comment: "no manifest
    /// schema validation beyond is this parseable JSON"); the frontend already
    /// owns `sceneStartFrame`/`sceneDurationFrames`
    /// (`packages/motion-engine/src/engine/build.ts`) and computes the range
    /// itself before this request is ever built — duplicating that scene math
    /// in Rust would just drift from the one real source of it.
    pub frame_range: Option<(u32, u32)>,
    /// D-404 — the project's asset folder, served to the engine as `public/`,
    /// which is where an `image` layer's `sha256:` id resolves. `None` serves none.
    pub public_dir: Option<PathBuf>,
}

impl RenderRequest {
    pub fn new(
        runtime: MotionRuntime,
        bundle_cache: impl Into<PathBuf>,
        manifest_path: impl Into<PathBuf>,
        output_path: impl Into<PathBuf>,
    ) -> Self {
        Self {
            runtime,
            bundle_cache: bundle_cache.into(),
            manifest_path: manifest_path.into(),
            output_path: output_path.into(),
            composition_id: "Animation".to_string(),
            frame_range: None,
            public_dir: None,
        }
    }

    /// Builder for D-180's per-scene export — see `frame_range`'s own doc
    /// comment for why this takes raw frame numbers, not a scene reference.
    pub fn with_frame_range(mut self, start: u32, end: u32) -> Self {
        self.frame_range = Some((start, end));
        self
    }

    /// D-404 — serve `dir` as the engine's `public/` folder.
    pub fn with_public_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.public_dir = Some(dir.into());
        self
    }
}

/// The finished render's location + a tail of the renderer's stdout — surfaced to
/// the UI as a plain success log, never parsed for structured progress.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RenderOutcome {
    pub output_path: PathBuf,
    pub stdout_tail: String,
}

/// Check the request is runnable before spawning anything: the engine
/// directory and manifest file must exist, and the manifest must at least
/// parse as JSON. A fast, clear failure here beats a cryptic Node/zod error
/// surfacing three process-levels down.
pub fn validate_request(req: &RenderRequest) -> Result<(), ChromaError> {
    if !req.runtime.engine_dir.is_dir() {
        return Err(ChromaError::NotFound(format!(
            "motion engine dir: {}",
            req.runtime.engine_dir.display()
        )));
    }
    let manifest_text = std::fs::read_to_string(&req.manifest_path).map_err(|e| {
        ChromaError::NotFound(format!("manifest {}: {e}", req.manifest_path.display()))
    })?;
    serde_json::from_str::<serde_json::Value>(&manifest_text)
        .map_err(|e| ChromaError::Invalid(format!("manifest is not valid JSON: {e}")))?;
    Ok(())
}

/// The renderer script, relative to the engine folder (D-417).
pub const RENDER_SCRIPT: &str = "scripts/render.mts";

/// `node <engine>/scripts/render.mts <mode>`, plus the runtime's own browser
/// and compositor when it manages them — the start of every render command.
/// Pure: unit-tested without spawning.
pub fn runner_command(rt: &MotionRuntime, mode: &str) -> Command {
    let mut cmd = Command::new(&rt.node);
    cmd.current_dir(&rt.engine_dir);
    cmd.arg(rt.engine_dir.join(RENDER_SCRIPT));
    cmd.arg(mode);
    if let Some(browser) = &rt.browser_executable {
        cmd.arg(format!("--browser-executable={}", browser.display()));
    }
    if let Some(dir) = &rt.binaries_dir {
        cmd.arg(format!("--binaries-directory={}", dir.display()));
    }
    cmd
}

/// The video render of `req` from the bundle at `bundle_dir` — pure, so the
/// exact argv is unit-testable without spawning anything.
pub fn build_command(req: &RenderRequest, bundle_dir: &Path) -> Command {
    let mut cmd = runner_command(&req.runtime, "video");
    cmd.args([
        format!("--serve-url={}", bundle_dir.display()),
        format!("--composition={}", req.composition_id),
        format!("--props={}", req.manifest_path.display()),
        format!("--output={}", req.output_path.display()),
    ]);
    if let Some((start, end)) = req.frame_range {
        cmd.arg(format!("--frames={start}-{end}"));
    }
    cmd
}

/// Give one renderer invocation its own HTTP port.
///
/// Remotion's renderer serves the bundle over a local HTTP server and, without
/// a port, looks for a free one starting at 3000. That check is not
/// atomic across processes: two invocations started together (a preview while
/// a scene renders, two previews) can settle on the same port, and one then
/// loads the other's bundle. Seen live in the preview determinism tests: a
/// 404 for the other bundle's `index.html`, and with two valid bundles it would
/// render the wrong composition without any error. The OS hands out a distinct
/// ephemeral port here, released just before `remotion` binds it; the OS does
/// not reissue a just-released ephemeral port at once, so the window left is
/// negligible.
pub fn with_own_port(mut cmd: Command) -> Result<Command, ChromaError> {
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map_err(|e| {
            ChromaError::Invalid(format!("could not reserve a local port for remotion: {e}"))
        })?
        .port();
    cmd.arg(format!("--port={port}"));
    Ok(cmd)
}

/// Run a `remotion` command built by `build` on its own port
/// ([`with_own_port`]), retrying once on a fresh port if `remotion` reports the
/// port as taken (the sub-millisecond window between releasing the reserved
/// port and `remotion` binding it). A second clash is returned as the failed
/// run it is, never as a render of something else.
pub fn output_with_own_port(
    build: impl Fn() -> Command,
) -> Result<std::process::Output, ChromaError> {
    let spawn = |cmd: Command| {
        let mut cmd = cmd;
        cmd.output()
            .map_err(|e| ChromaError::Invalid(format!("failed to spawn the motion renderer: {e}")))
    };
    let first = spawn(with_own_port(build())?)?;
    if first.status.success() || !port_was_taken(&first.stderr) {
        return Ok(first);
    }
    spawn(with_own_port(build())?)
}

/// Whether `remotion`'s stderr says its HTTP server could not bind.
fn port_was_taken(stderr: &[u8]) -> bool {
    let text = String::from_utf8_lossy(stderr);
    text.contains("EADDRINUSE") || text.contains("address already in use")
}

/// Validate, bundle (or reuse the bundle), then run the render synchronously
/// (blocks until Node exits). Callers on an async runtime should wrap this in
/// `spawn_blocking` (the job worker runs it on its own thread).
pub fn run_render(req: &RenderRequest) -> Result<RenderOutcome, ChromaError> {
    validate_request(req)?;
    let bundle = still::ensure_bundle(&req.runtime, &req.bundle_cache, req.public_dir.as_deref())?;
    let output = output_with_own_port(|| build_command(req, &bundle))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        return Err(ChromaError::Invalid(format!(
            "motion render exited {code}: {}",
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
pub(crate) fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A developer-shaped runtime (the browser and compositor are Remotion's own).
    pub(crate) fn dev_runtime(engine: &str) -> MotionRuntime {
        MotionRuntime {
            source: RuntimeSource::Developer,
            node: PathBuf::from("/usr/bin/node"),
            engine_dir: PathBuf::from(engine),
            prebuilt_bundle: None,
            browser_executable: None,
            binaries_dir: None,
        }
    }

    /// A managed runtime: its own Chrome and compositor, a prebuilt bundle.
    pub(crate) fn managed_runtime() -> MotionRuntime {
        MotionRuntime {
            source: RuntimeSource::Managed,
            node: PathBuf::from("/rt/node/bin/node"),
            engine_dir: PathBuf::from("/App/Resources/motion-engine"),
            prebuilt_bundle: Some(PathBuf::from("/App/Resources/motion-engine/bundle")),
            browser_executable: Some(PathBuf::from("/rt/chrome/chrome-headless-shell")),
            binaries_dir: Some(PathBuf::from("/rt/compositor")),
        }
    }

    pub(crate) fn args(cmd: &Command) -> Vec<String> {
        cmd.get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn build_command_runs_the_engine_renderer_with_node() {
        let req = RenderRequest::new(
            dev_runtime("/engine"),
            "/c",
            "/tmp/manifest.json",
            "/tmp/out.mp4",
        );
        let cmd = build_command(&req, Path::new("/c/bundle-ab"));

        assert_eq!(cmd.get_program(), "/usr/bin/node");
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/engine")));
        assert_eq!(
            args(&cmd),
            vec![
                "/engine/scripts/render.mts",
                "video",
                "--serve-url=/c/bundle-ab",
                "--composition=Animation",
                "--props=/tmp/manifest.json",
                "--output=/tmp/out.mp4",
            ]
        );
    }

    #[test]
    fn a_managed_runtime_passes_its_own_browser_and_compositor() {
        let req = RenderRequest::new(managed_runtime(), "/c", "/m.json", "/o.mp4");
        let a = args(&build_command(&req, Path::new("/b")));
        assert_eq!(a[0], "/App/Resources/motion-engine/scripts/render.mts");
        assert!(a.contains(&"--browser-executable=/rt/chrome/chrome-headless-shell".to_string()));
        assert!(a.contains(&"--binaries-directory=/rt/compositor".to_string()));
    }

    #[test]
    fn build_command_appends_frames_flag_when_a_range_is_set() {
        let req = RenderRequest::new(
            dev_runtime("/engine"),
            "/c",
            "/tmp/manifest.json",
            "/tmp/out.mp4",
        )
        .with_frame_range(120, 299);
        let a = args(&build_command(&req, Path::new("/b")));
        assert_eq!(a.last().map(String::as_str), Some("--frames=120-299"));
    }

    #[test]
    fn build_command_omits_frames_flag_by_default() {
        let req = RenderRequest::new(
            dev_runtime("/engine"),
            "/c",
            "/tmp/manifest.json",
            "/tmp/out.mp4",
        );
        assert!(
            !args(&build_command(&req, Path::new("/b")))
                .iter()
                .any(|a| a.starts_with("--frames="))
        );
    }

    #[test]
    fn a_taken_port_is_recognised_from_remotion_stderr() {
        assert!(port_was_taken(
            b"Error: listen EADDRINUSE: address already in use 127.0.0.1:50825"
        ));
        assert!(!port_was_taken(b"Error: Cannot find module"));
    }

    #[test]
    fn with_own_port_appends_a_distinct_port_each_time() {
        let req = RenderRequest::new(
            dev_runtime("/engine"),
            "/c",
            "/tmp/manifest.json",
            "/tmp/out.mp4",
        );
        let port_of = |cmd: Command| -> u16 {
            cmd.get_args()
                .filter_map(|a| a.to_str()?.strip_prefix("--port=")?.parse().ok())
                .next()
                .unwrap_or(0)
        };
        let bundle = Path::new("/b");
        let a = port_of(with_own_port(build_command(&req, bundle)).expect("port a"));
        let b = port_of(with_own_port(build_command(&req, bundle)).expect("port b"));
        assert!(a > 0 && b > 0, "a --port flag is appended: {a} {b}");
        assert_ne!(a, b, "two invocations get two ports");
    }

    #[test]
    fn validate_request_rejects_missing_engine_dir() {
        let req = RenderRequest::new(
            dev_runtime("/no/such/engine/dir"),
            "/c",
            "/tmp/manifest.json",
            "/tmp/out.mp4",
        );
        let err = validate_request(&req).unwrap_err();
        assert!(matches!(err, ChromaError::NotFound(_)));
    }

    #[test]
    fn validate_request_rejects_missing_manifest() {
        let dir = std::env::temp_dir();
        let req = RenderRequest::new(
            dev_runtime(&dir.to_string_lossy()),
            "/c",
            "/no/such/chroma-motion-manifest.json",
            "/tmp/out.mp4",
        );
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

        let req = RenderRequest::new(
            dev_runtime(&dir.to_string_lossy()),
            "/c",
            &bad,
            "/tmp/out.mp4",
        );
        let err = validate_request(&req).unwrap_err();
        assert!(matches!(err, ChromaError::Invalid(_)));

        let _ = std::fs::remove_file(&bad);
    }

    #[test]
    fn validate_request_accepts_a_valid_manifest() {
        let dir = std::env::temp_dir();
        let good = dir.join(format!("chroma-motion-test-ok-{}.json", std::process::id()));
        std::fs::write(&good, r#"{"title":"t","scenes":[]}"#).unwrap();

        let req = RenderRequest::new(
            dev_runtime(&dir.to_string_lossy()),
            "/c",
            &good,
            "/tmp/out.mp4",
        );
        assert!(validate_request(&req).is_ok());

        let _ = std::fs::remove_file(&good);
    }
}
