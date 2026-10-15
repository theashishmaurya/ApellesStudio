//! ffmpeg_locate.rs — the ONE place Apelles decides which `ffmpeg` / `ffprobe`
//! binary to run (D-389, B-253).
//!
//! **What it is:** a resolver, run once per tool per process and cached, that
//! turns "ffmpeg" into an absolute path to an executable, plus the two
//! `Command` constructors every spawn in the workspace goes through.
//!
//! **What it does:** walks a fixed ladder and takes the first rung that names a
//! real executable file:
//!
//! 1. **`CHROMA_FFMPEG` / `CHROMA_FFPROBE`** — the developer override D-015
//!    promised. A value with no path separator is looked up on `PATH`; a value
//!    that names nothing is logged and skipped, not fatal (the same rule
//!    `apelles_ai::sidecar::resolve_bin` uses for its `*_BIN` overrides).
//! 2. **Bundled** — next to our own executable (`current_exe()`'s directory).
//!    That is where a Tauri `externalBin` lands: `Contents/MacOS/` in a bundle,
//!    and `target/<profile>/` in a `tauri dev` run, where `tauri_build` copies
//!    the staged sidecar beside the binary it just built. One rule covers both.
//! 3. **Well-known install locations** — `/opt/homebrew/bin` (Apple Silicon
//!    Homebrew), then `/usr/local/bin` (Intel Homebrew, MacPorts-style manual
//!    installs). Checked by absolute path because an app launched from Finder
//!    inherits launchd's minimal `PATH`, which contains neither (B-253).
//! 4. **`PATH`** — searched here, not left to `execvp`, so the answer is an
//!    absolute path that can be logged and handed to a child process.
//!
//! If no rung matches, the result is a [`ToolMissing`] that says what was
//! looked for and where — not the bare "No such file or directory" a failed
//! `Command::new("ffmpeg").spawn()` produces.
//!
//! **What it does NOT do:** run the binary (no `-version` probe — an executable
//! file is the whole test, so resolution is a handful of `stat` calls), pick
//! codecs or flags, bound concurrency (that is [`crate::ffmpeg_gate`]), or
//! fetch/stage the bundled binary (that is `app/src-tauri/build.rs`, D-389).
//! It also never re-resolves: a binary installed after launch is picked up on
//! the next launch, which keeps every spawn in one process on one ffmpeg.

use std::ffi::{OsStr, OsString};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Install directories checked by absolute path, in order (rung 3). Homebrew's
/// Apple Silicon prefix first: v1 is macOS ARM (`docs/02-scope.md`).
pub const WELL_KNOWN_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// One of the two binaries this module resolves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FfTool {
    Ffmpeg,
    Ffprobe,
}

impl FfTool {
    /// The executable's file name, without a platform suffix.
    pub const fn name(self) -> &'static str {
        match self {
            FfTool::Ffmpeg => "ffmpeg",
            FfTool::Ffprobe => "ffprobe",
        }
    }

    /// The env var that overrides this tool (rung 1). Also the variable a child
    /// process is handed the resolved path in — see [`child_env`].
    pub const fn env_var(self) -> &'static str {
        match self {
            FfTool::Ffmpeg => "CHROMA_FFMPEG",
            FfTool::Ffprobe => "CHROMA_FFPROBE",
        }
    }

    fn file_name(self) -> String {
        format!("{}{}", self.name(), std::env::consts::EXE_SUFFIX)
    }
}

/// Which rung of the ladder produced a [`Resolved`] path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `CHROMA_FFMPEG` / `CHROMA_FFPROBE`.
    EnvOverride,
    /// Next to our own executable — the Tauri `externalBin` copy.
    Bundled,
    /// One of [`WELL_KNOWN_DIRS`].
    WellKnown,
    /// Found by searching `PATH`.
    Path,
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Source::EnvOverride => "env override",
            Source::Bundled => "bundled with the app",
            Source::WellKnown => "well-known install location",
            Source::Path => "PATH",
        })
    }
}

/// A resolved tool: the absolute path to run and how it was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub path: PathBuf,
    pub source: Source,
}

/// No rung named an executable. `Display` is the user-facing explanation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolMissing {
    pub tool: FfTool,
    /// Every location that was checked, in ladder order.
    pub searched: Vec<String>,
}

impl fmt::Display for ToolMissing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{name} not found (looked in: {where_}). The app normally ships its own {name}; \
             set {var} to a {name} binary to use a different one.",
            name = self.tool.name(),
            where_ = self.searched.join(", "),
            var = self.tool.env_var(),
        )
    }
}

impl std::error::Error for ToolMissing {}

impl From<ToolMissing> for std::io::Error {
    fn from(e: ToolMissing) -> Self {
        std::io::Error::new(std::io::ErrorKind::NotFound, e.to_string())
    }
}

/// Everything [`resolve`] reads from the outside world, gathered so the ladder
/// itself is a pure function a test can drive with temp dirs.
#[derive(Debug, Clone, Default)]
pub struct Inputs {
    /// The value of the tool's override env var, if set.
    pub env_override: Option<OsString>,
    /// The directory our own executable lives in.
    pub exe_dir: Option<PathBuf>,
    /// Rung 3's directories.
    pub well_known: Vec<PathBuf>,
    /// The `PATH` value.
    pub path_var: Option<OsString>,
}

impl Inputs {
    /// The real process environment for `tool`.
    pub fn from_process(tool: FfTool) -> Self {
        Self {
            env_override: std::env::var_os(tool.env_var()),
            exe_dir: std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf)),
            well_known: WELL_KNOWN_DIRS.iter().map(PathBuf::from).collect(),
            path_var: std::env::var_os("PATH"),
        }
    }
}

/// Is `p` a file we could execute? On Unix that means at least one execute bit.
fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn search_path(path_var: Option<&OsStr>, file_name: &OsStr) -> Option<PathBuf> {
    std::env::split_paths(path_var?)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(file_name))
        .find(|p| is_executable(p))
}

/// Walk the ladder for `tool` against `inputs`. Pure apart from `stat` calls.
pub fn resolve(tool: FfTool, inputs: &Inputs) -> Result<Resolved, ToolMissing> {
    let file_name = tool.file_name();
    let mut searched = Vec::new();

    if let Some(value) = inputs.env_override.as_deref().filter(|v| !v.is_empty()) {
        let as_path = Path::new(value);
        let hit = if as_path.components().count() > 1 || as_path.is_absolute() {
            is_executable(as_path).then(|| as_path.to_path_buf())
        } else {
            search_path(inputs.path_var.as_deref(), value)
        };
        if let Some(path) = hit {
            return Ok(Resolved {
                path,
                source: Source::EnvOverride,
            });
        }
        log::warn!(
            "[ffmpeg] {}={} is not an executable file — ignoring it",
            tool.env_var(),
            as_path.display()
        );
        searched.push(format!("{}={}", tool.env_var(), as_path.display()));
    }

    if let Some(dir) = &inputs.exe_dir {
        let p = dir.join(&file_name);
        if is_executable(&p) {
            return Ok(Resolved {
                path: p,
                source: Source::Bundled,
            });
        }
        searched.push(dir.display().to_string());
    }

    for dir in &inputs.well_known {
        let p = dir.join(&file_name);
        if is_executable(&p) {
            return Ok(Resolved {
                path: p,
                source: Source::WellKnown,
            });
        }
        searched.push(dir.display().to_string());
    }

    if let Some(path) = search_path(inputs.path_var.as_deref(), OsStr::new(&file_name)) {
        return Ok(Resolved {
            path,
            source: Source::Path,
        });
    }
    searched.push("PATH".to_string());

    Err(ToolMissing { tool, searched })
}

static FFMPEG: OnceLock<Result<Resolved, ToolMissing>> = OnceLock::new();
static FFPROBE: OnceLock<Result<Resolved, ToolMissing>> = OnceLock::new();

/// The process-wide, resolve-once answer for `tool`.
pub fn resolution(tool: FfTool) -> &'static Result<Resolved, ToolMissing> {
    let cell = match tool {
        FfTool::Ffmpeg => &FFMPEG,
        FfTool::Ffprobe => &FFPROBE,
    };
    cell.get_or_init(|| resolve(tool, &Inputs::from_process(tool)))
}

/// The absolute path of the `ffmpeg` to run.
pub fn ffmpeg_path() -> Result<&'static Path, ToolMissing> {
    path_of(FfTool::Ffmpeg)
}

/// The absolute path of the `ffprobe` to run.
pub fn ffprobe_path() -> Result<&'static Path, ToolMissing> {
    path_of(FfTool::Ffprobe)
}

fn path_of(tool: FfTool) -> Result<&'static Path, ToolMissing> {
    resolution(tool)
        .as_ref()
        .map(|r| r.path.as_path())
        .map_err(Clone::clone)
}

/// A `Command` for the resolved `ffmpeg`, with no arguments yet.
pub fn ffmpeg() -> Result<Command, ToolMissing> {
    ffmpeg_path().map(Command::new)
}

/// A `Command` for the resolved `ffprobe`, with no arguments yet.
pub fn ffprobe() -> Result<Command, ToolMissing> {
    ffprobe_path().map(Command::new)
}

/// `(env var, resolved path)` for each tool that resolved — what a child
/// process that runs ffmpeg itself (the Python `ai-media/` sidecar) is
/// spawned with, so it runs the same binary this process does rather than
/// whatever its own, possibly minimal, `PATH` happens to hold.
pub fn child_env() -> Vec<(&'static str, &'static Path)> {
    [FfTool::Ffmpeg, FfTool::Ffprobe]
        .into_iter()
        .filter_map(|t| path_of(t).ok().map(|p| (t.env_var(), p)))
        .collect()
}

/// Resolve both tools now and log the outcome. Called once at app startup so
/// the log says which ffmpeg this run uses before anything spawns one.
pub fn log_resolution() {
    for tool in [FfTool::Ffmpeg, FfTool::Ffprobe] {
        match resolution(tool) {
            Ok(r) => log::info!(
                "[ffmpeg] using {} at {} ({})",
                tool.name(),
                r.path.display(),
                r.source
            ),
            Err(e) => log::error!("[ffmpeg] {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_exe(dir: &Path, name: &str) -> PathBuf {
        std::fs::create_dir_all(dir).expect("create dir");
        let p = dir.join(name);
        std::fs::write(&p, b"#!/bin/sh\n").expect("write fake binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755))
                .expect("chmod fake binary");
        }
        p
    }

    /// Four populated rungs, each in its own temp dir, so every test below can
    /// knock out the rungs above the one it is checking.
    struct Ladder {
        _tmp: tempfile::TempDir,
        env_bin: PathBuf,
        exe_dir: PathBuf,
        well_known: PathBuf,
        on_path: PathBuf,
    }

    fn ladder(tool: FfTool) -> Ladder {
        let tmp = tempfile::tempdir().expect("tempdir");
        let name = tool.file_name();
        let env_bin = put_exe(&tmp.path().join("custom"), &name);
        let exe_dir = tmp.path().join("app");
        put_exe(&exe_dir, &name);
        let well_known = tmp.path().join("brew");
        put_exe(&well_known, &name);
        let on_path = tmp.path().join("pathdir");
        put_exe(&on_path, &name);
        Ladder {
            _tmp: tmp,
            env_bin,
            exe_dir,
            well_known,
            on_path,
        }
    }

    fn inputs(l: &Ladder) -> Inputs {
        Inputs {
            env_override: Some(l.env_bin.clone().into_os_string()),
            exe_dir: Some(l.exe_dir.clone()),
            well_known: vec![l.well_known.clone()],
            path_var: Some(std::env::join_paths([&l.on_path]).expect("join PATH")),
        }
    }

    #[test]
    fn env_override_wins_over_everything() {
        let l = ladder(FfTool::Ffmpeg);
        let r = resolve(FfTool::Ffmpeg, &inputs(&l)).expect("resolves");
        assert_eq!(r.source, Source::EnvOverride);
        assert_eq!(r.path, l.env_bin);
    }

    #[test]
    fn bundled_wins_when_there_is_no_override() {
        let l = ladder(FfTool::Ffprobe);
        let mut i = inputs(&l);
        i.env_override = None;
        let r = resolve(FfTool::Ffprobe, &i).expect("resolves");
        assert_eq!(r.source, Source::Bundled);
        assert_eq!(r.path, l.exe_dir.join(FfTool::Ffprobe.file_name()));
    }

    #[test]
    fn well_known_dir_beats_path() {
        let l = ladder(FfTool::Ffmpeg);
        let mut i = inputs(&l);
        i.env_override = None;
        i.exe_dir = None;
        let r = resolve(FfTool::Ffmpeg, &i).expect("resolves");
        assert_eq!(r.source, Source::WellKnown);
        assert_eq!(r.path.parent(), Some(l.well_known.as_path()));
    }

    #[test]
    fn path_is_the_last_rung() {
        let l = ladder(FfTool::Ffmpeg);
        let mut i = inputs(&l);
        i.env_override = None;
        i.exe_dir = None;
        i.well_known.clear();
        let r = resolve(FfTool::Ffmpeg, &i).expect("resolves");
        assert_eq!(r.source, Source::Path);
        assert_eq!(r.path.parent(), Some(l.on_path.as_path()));
    }

    /// A stale override must not take the app down with it: it is skipped and
    /// the next rung answers.
    #[test]
    fn an_override_naming_nothing_falls_through() {
        let l = ladder(FfTool::Ffmpeg);
        let mut i = inputs(&l);
        i.env_override = Some(l.exe_dir.join("does-not-exist").into_os_string());
        let r = resolve(FfTool::Ffmpeg, &i).expect("resolves");
        assert_eq!(r.source, Source::Bundled);
    }

    /// D-015's contract allowed a bare name; it is looked up on PATH.
    #[test]
    fn a_bare_name_override_is_looked_up_on_path() {
        let l = ladder(FfTool::Ffmpeg);
        put_exe(&l.on_path, "ffmpeg-pinned");
        let mut i = inputs(&l);
        i.env_override = Some(OsString::from("ffmpeg-pinned"));
        let r = resolve(FfTool::Ffmpeg, &i).expect("resolves");
        assert_eq!(r.source, Source::EnvOverride);
        assert_eq!(r.path, l.on_path.join("ffmpeg-pinned"));
    }

    /// A file without an execute bit is not a binary we can run, and taking it
    /// would turn a clean fall-through into a permission-denied spawn.
    #[cfg(unix)]
    #[test]
    fn a_non_executable_file_is_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let l = ladder(FfTool::Ffmpeg);
        let bundled = l.exe_dir.join(FfTool::Ffmpeg.file_name());
        std::fs::set_permissions(&bundled, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        let mut i = inputs(&l);
        i.env_override = None;
        let r = resolve(FfTool::Ffmpeg, &i).expect("resolves");
        assert_eq!(r.source, Source::WellKnown);
    }

    #[test]
    fn nothing_found_is_a_clear_error_naming_every_place_checked() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let empty = tmp.path().join("empty");
        std::fs::create_dir_all(&empty).expect("mkdir");
        let i = Inputs {
            env_override: None,
            exe_dir: Some(empty.clone()),
            well_known: vec![empty.join("brew")],
            path_var: Some(std::env::join_paths([&empty]).expect("join PATH")),
        };
        let err = resolve(FfTool::Ffprobe, &i).expect_err("nothing to find");
        assert_eq!(err.tool, FfTool::Ffprobe);
        assert_eq!(err.searched.len(), 3);
        let msg = err.to_string();
        assert!(msg.starts_with("ffprobe not found"), "{msg}");
        assert!(msg.contains("CHROMA_FFPROBE"), "{msg}");
        assert!(msg.contains(&empty.display().to_string()), "{msg}");
        let io: std::io::Error = err.into();
        assert_eq!(io.kind(), std::io::ErrorKind::NotFound);
    }
}
