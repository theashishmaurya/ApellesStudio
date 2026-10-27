//! The one resolver every Motion render path asks: which Node, which browser,
//! which engine files (D-417) — the Motion twin of `apelles_media::ffmpeg_locate`.
//!
//! **Precedence, first hit wins:**
//!
//! 1. **Developer override** — only in a developer checkout ([`Layout::Dev`]):
//!    `APELLES_MOTION_NODE`, else the `node` on `PATH` (or Homebrew's), if it is
//!    Node 22.18 or newer. The browser and compositor are then Remotion's own
//!    (`node_modules/.remotion`, `@remotion/compositor-*`), exactly what a
//!    developer's `npx remotion` used before. `APELLES_MOTION_MANAGED=1` skips
//!    this rung, to exercise the downloaded runtime from a dev build.
//! 2. **The installed runtime** — `<app data>/motion-runtime/<key>/`, if
//!    `store::inspect` finds it intact: its Node, its Chrome Headless Shell
//!    (passed to Remotion as `browserExecutable`) and its compositor (passed as
//!    `binariesDirectory`).
//! 3. **Not ready** — with the reason (missing / outdated / broken).
//!
//! In an installed app ([`Layout::Packaged`]) rung 1 does not exist: a release
//! build never runs whatever `node` happens to be on the machine (the same rule
//! D-390 applies to the Python sidecars).
//!
//! **The engine files** (`scripts/render.mts`, the component check, built-in
//! components, the JS packages they import) are the checkout's
//! `packages/motion-engine` in development and the engine pack in the app's
//! Resources (`motion-engine/`, built by `scripts/build-pack.mts`) in a
//! release, which also carries a prebuilt Remotion bundle so nothing is
//! bundled on a user's machine. [`engine_dir`] answers that without needing a
//! runtime, so the component library can be listed before anything downloads.
//!
//! **What it does NOT do:** download (see `store` / `manager`), or spawn
//! anything except one `node --version` per candidate, cached for the process.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::pins::{self, ArtifactId, NODE_MIN_VERSION};
use crate::store::{self, InstallState};

/// Overrides the developer's Node (development builds only).
pub const NODE_OVERRIDE_ENV: &str = "APELLES_MOTION_NODE";
/// `1` makes a development build use the downloaded runtime instead of the
/// developer's own Node.
pub const USE_MANAGED_ENV: &str = "APELLES_MOTION_MANAGED";
/// Places Homebrew puts `node`, checked after `PATH` (an app started from
/// Finder or `launchd` has a minimal `PATH`).
const WELL_KNOWN_NODE: [&str; 2] = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];

/// Where this build keeps its engine files and its downloaded runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Layout {
    /// A developer checkout (`tauri dev`, `cargo test`).
    Dev {
        /// `packages/motion-engine`.
        engine_dir: PathBuf,
        /// Where a downloaded runtime goes (only used with `APELLES_MOTION_MANAGED=1`
        /// or when the developer has no usable Node).
        runtime_root: PathBuf,
    },
    /// An installed app.
    Packaged {
        /// `Contents/Resources/motion-engine` (read-only, code-signed).
        pack_dir: PathBuf,
        /// `<app data>/motion-runtime`.
        runtime_root: PathBuf,
    },
}

impl Layout {
    /// The engine files this build renders with.
    pub fn engine_dir(&self) -> &Path {
        match self {
            Layout::Dev { engine_dir, .. } => engine_dir,
            Layout::Packaged { pack_dir, .. } => pack_dir,
        }
    }

    /// `<app data>/motion-runtime`.
    pub fn runtime_root(&self) -> &Path {
        match self {
            Layout::Dev { runtime_root, .. } | Layout::Packaged { runtime_root, .. } => {
                runtime_root
            }
        }
    }

    /// A release pack carries a prebuilt bundle; a checkout bundles its sources.
    pub fn prebuilt_bundle(&self) -> Option<PathBuf> {
        match self {
            Layout::Dev { .. } => None,
            Layout::Packaged { pack_dir, .. } => Some(pack_dir.join("bundle")),
        }
    }
}

/// The engine files for `layout` (see the module doc).
pub fn engine_dir(layout: &Layout) -> &Path {
    layout.engine_dir()
}

/// Which rung answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeSource {
    /// The developer's own Node (development builds only).
    Developer,
    /// The downloaded runtime.
    Managed,
}

/// A located, runnable Motion runtime: everything a render command needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MotionRuntime {
    pub source: RuntimeSource,
    /// The Node binary.
    pub node: PathBuf,
    /// The engine files (`scripts/`, `src/`, `components/`, `node_modules/`).
    pub engine_dir: PathBuf,
    /// A prebuilt Remotion bundle (release), or `None` to bundle the engine's
    /// sources (development).
    pub prebuilt_bundle: Option<PathBuf>,
    /// The Chrome Headless Shell to render with, or `None` for Remotion's own.
    pub browser_executable: Option<PathBuf>,
    /// The Remotion compositor folder, or `None` for the npm-installed one.
    pub binaries_dir: Option<PathBuf>,
}

impl MotionRuntime {
    /// A runtime made of the developer's checkout and `node` — what tests and
    /// examples run with. `None` when no usable Node is found.
    pub fn developer(engine_dir: &Path) -> Option<MotionRuntime> {
        let env = Env::from_process();
        let node = developer_node(&env, &|p| probe_node(p))?;
        Some(MotionRuntime {
            source: RuntimeSource::Developer,
            node,
            engine_dir: engine_dir.to_path_buf(),
            prebuilt_bundle: None,
            browser_executable: None,
            binaries_dir: None,
        })
    }
}

/// Why no runtime is available.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotReady {
    pub state: InstallState,
    /// What the developer rung found, in a development build (`None` in a release).
    pub developer: Option<String>,
}

/// The environment the resolver reads, captured once so tests can supply their own.
#[derive(Debug, Clone, Default)]
pub struct Env {
    pub node_override: Option<PathBuf>,
    pub use_managed: bool,
    pub path: Option<OsString>,
    /// Checked after `PATH` (Homebrew's `node`; empty in tests).
    pub well_known: Vec<PathBuf>,
}

impl Env {
    pub fn from_process() -> Env {
        Env {
            node_override: std::env::var_os(NODE_OVERRIDE_ENV)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            use_managed: std::env::var(USE_MANAGED_ENV).is_ok_and(|v| v == "1"),
            path: std::env::var_os("PATH"),
            well_known: WELL_KNOWN_NODE.iter().map(PathBuf::from).collect(),
        }
    }
}

/// `node --version` for a candidate: `Ok((major, minor, patch))` or why not.
pub type NodeProbe<'a> = &'a dyn Fn(&Path) -> Result<(u32, u32, u32), String>;

/// Resolve the runtime for `layout` (see the module doc for the precedence).
pub fn resolve(
    layout: &Layout,
    env: &Env,
    probe: NodeProbe<'_>,
) -> Result<MotionRuntime, NotReady> {
    let developer = match layout {
        Layout::Dev { engine_dir, .. } if !env.use_managed => match developer_node(env, probe) {
            Some(node) => {
                return Ok(MotionRuntime {
                    source: RuntimeSource::Developer,
                    node,
                    engine_dir: engine_dir.clone(),
                    prebuilt_bundle: None,
                    browser_executable: None,
                    binaries_dir: None,
                });
            }
            None => Some(format!(
                "no Node {}.{}+ found ({NODE_OVERRIDE_ENV}, PATH, Homebrew)",
                NODE_MIN_VERSION.0, NODE_MIN_VERSION.1
            )),
        },
        Layout::Dev { .. } => Some(format!(
            "{USE_MANAGED_ENV}=1: the developer's Node is skipped"
        )),
        Layout::Packaged { .. } => None,
    };
    let key = pins::runtime_key();
    match store::inspect(layout.runtime_root(), &key, &pins::ARTIFACTS) {
        InstallState::Ready { dir, .. } => Ok(managed(layout, &dir)),
        state => Err(NotReady { state, developer }),
    }
}

/// The runtime made of an installed runtime folder and `layout`'s engine files.
pub fn managed(layout: &Layout, dir: &Path) -> MotionRuntime {
    let artifact = |id: ArtifactId| store::artifact_dir(dir, id);
    let entry = |id: ArtifactId| {
        let a = pins::ARTIFACTS.iter().find(|a| a.id == id);
        a.map(|a| artifact(id).join(a.entry))
            .unwrap_or_else(|| artifact(id))
    };
    MotionRuntime {
        source: RuntimeSource::Managed,
        node: entry(ArtifactId::Node),
        engine_dir: layout.engine_dir().to_path_buf(),
        prebuilt_bundle: layout.prebuilt_bundle(),
        browser_executable: Some(entry(ArtifactId::Chrome)),
        binaries_dir: Some(artifact(ArtifactId::Compositor)),
    }
}

/// The developer's Node: the override, else `PATH`, else Homebrew — the first
/// one that is new enough.
fn developer_node(env: &Env, probe: NodeProbe<'_>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = &env.node_override {
        candidates.push(p.clone());
    } else {
        if let Some(path) = &env.path {
            candidates.extend(std::env::split_paths(path).map(|d| d.join("node")));
        }
        candidates.extend(env.well_known.iter().cloned());
    }
    candidates
        .into_iter()
        .filter(|c| c.is_file())
        .find(|c| probe(c).is_ok_and(|v| v >= NODE_MIN_VERSION))
}

/// Parse `v24.13.0` (what `node --version` prints).
pub fn parse_node_version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.trim().strip_prefix('v')?.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts
        .next()?
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    Some((major, minor, patch))
}

/// `node --version`, run once per path per process.
pub fn probe_node(node: &Path) -> Result<(u32, u32, u32), String> {
    type Cache = Mutex<HashMap<PathBuf, Result<(u32, u32, u32), String>>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(node) {
        return hit.clone();
    }
    let answer = std::process::Command::new(node)
        .arg("--version")
        .output()
        .map_err(|e| format!("{}: {e}", node.display()))
        .and_then(|out| {
            parse_node_version(&String::from_utf8_lossy(&out.stdout))
                .ok_or_else(|| format!("{}: unexpected --version output", node.display()))
        });
    cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(node.to_path_buf(), answer.clone());
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{STAMP_FILE, Stamp, StampedArtifact};
    use std::os::unix::fs::PermissionsExt;

    fn touch_exe(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        std::fs::create_dir_all(path.parent().ok_or("no parent")?)?;
        std::fs::write(path, bytes)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
        Ok(())
    }

    /// A runtime folder that passes `store::inspect` for the real pins.
    fn fake_managed(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let dir = store::runtime_dir(root, &pins::runtime_key());
        let mut artifacts = Vec::new();
        for a in pins::ARTIFACTS {
            touch_exe(&store::artifact_dir(&dir, a.id).join(a.entry), b"x")?;
            artifacts.push(StampedArtifact {
                id: a.id,
                version: a.version.into(),
                sha256: a.sha256.into(),
                entry: a.entry.into(),
                entry_size: 1,
            });
        }
        let stamp = Stamp {
            format_version: 1,
            key: pins::runtime_key(),
            artifacts,
            unpacked_bytes: 3,
        };
        std::fs::write(dir.join(STAMP_FILE), serde_json::to_string(&stamp)?)?;
        Ok(dir)
    }

    fn new_enough(_: &Path) -> Result<(u32, u32, u32), String> {
        Ok((24, 13, 0))
    }

    #[test]
    fn a_developer_checkout_prefers_the_developers_node() -> Result<(), Box<dyn std::error::Error>>
    {
        let tmp = tempfile::tempdir()?;
        let bin = tmp.path().join("bin");
        touch_exe(&bin.join("node"), b"")?;
        fake_managed(&tmp.path().join("rt"))?;
        let layout = Layout::Dev {
            engine_dir: tmp.path().join("engine"),
            runtime_root: tmp.path().join("rt"),
        };
        let env = Env {
            path: Some(bin.clone().into_os_string()),
            ..Env::default()
        };
        let rt = resolve(&layout, &env, &new_enough).map_err(|e| format!("{e:?}"))?;
        assert_eq!(rt.source, RuntimeSource::Developer);
        assert_eq!(rt.node, bin.join("node"));
        assert_eq!(rt.browser_executable, None, "Remotion's own browser");
        assert_eq!(rt.prebuilt_bundle, None, "bundled from the checkout");
        Ok(())
    }

    #[test]
    fn the_override_wins_over_path() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        touch_exe(&tmp.path().join("bin/node"), b"")?;
        touch_exe(&tmp.path().join("pinned/node"), b"")?;
        let layout = Layout::Dev {
            engine_dir: tmp.path().join("engine"),
            runtime_root: tmp.path().join("rt"),
        };
        let env = Env {
            node_override: Some(tmp.path().join("pinned/node")),
            path: Some(tmp.path().join("bin").into_os_string()),
            ..Env::default()
        };
        let rt = resolve(&layout, &env, &new_enough).map_err(|e| format!("{e:?}"))?;
        assert_eq!(rt.node, tmp.path().join("pinned/node"));
        Ok(())
    }

    #[test]
    fn a_too_old_developer_node_falls_through_to_the_installed_runtime()
    -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let bin = tmp.path().join("bin");
        touch_exe(&bin.join("node"), b"")?;
        let dir = fake_managed(&tmp.path().join("rt"))?;
        let layout = Layout::Dev {
            engine_dir: tmp.path().join("engine"),
            runtime_root: tmp.path().join("rt"),
        };
        let env = Env {
            path: Some(bin.into_os_string()),
            ..Env::default()
        };
        let old = |_: &Path| -> Result<(u32, u32, u32), String> { Ok((22, 17, 9)) };
        let rt = resolve(&layout, &env, &old).map_err(|e| format!("{e:?}"))?;
        assert_eq!(rt.source, RuntimeSource::Managed);
        assert_eq!(rt.node, dir.join("node/bin/node"));
        assert_eq!(
            rt.browser_executable,
            Some(dir.join("chrome/chrome-headless-shell"))
        );
        assert_eq!(rt.binaries_dir, Some(dir.join("compositor")));
        assert_eq!(
            rt.engine_dir,
            tmp.path().join("engine"),
            "still the checkout's engine"
        );
        Ok(())
    }

    #[test]
    fn managed_mode_skips_the_developers_node() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let bin = tmp.path().join("bin");
        touch_exe(&bin.join("node"), b"")?;
        let layout = Layout::Dev {
            engine_dir: tmp.path().join("engine"),
            runtime_root: tmp.path().join("rt"),
        };
        let env = Env {
            path: Some(bin.into_os_string()),
            use_managed: true,
            ..Env::default()
        };
        let err = resolve(&layout, &env, &new_enough)
            .err()
            .ok_or("resolved")?;
        assert_eq!(err.state, InstallState::Missing);
        Ok(())
    }

    #[test]
    fn an_installed_app_never_runs_the_machines_node() -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let bin = tmp.path().join("bin");
        touch_exe(&bin.join("node"), b"")?;
        let layout = Layout::Packaged {
            pack_dir: tmp.path().join("Resources/motion-engine"),
            runtime_root: tmp.path().join("rt"),
        };
        let env = Env {
            path: Some(bin.into_os_string()),
            node_override: Some(tmp.path().join("bin/node")),
            ..Env::default()
        };
        let err = resolve(&layout, &env, &new_enough)
            .err()
            .ok_or("resolved")?;
        assert_eq!(err.state, InstallState::Missing);
        assert_eq!(err.developer, None);

        let dir = fake_managed(&tmp.path().join("rt"))?;
        let rt = resolve(&layout, &env, &new_enough).map_err(|e| format!("{e:?}"))?;
        assert_eq!(rt.source, RuntimeSource::Managed);
        assert_eq!(rt.node, dir.join("node/bin/node"));
        assert_eq!(
            rt.prebuilt_bundle,
            Some(tmp.path().join("Resources/motion-engine/bundle"))
        );
        assert_eq!(rt.engine_dir, tmp.path().join("Resources/motion-engine"));
        Ok(())
    }

    #[test]
    fn nothing_anywhere_is_missing_with_the_developer_reason()
    -> Result<(), Box<dyn std::error::Error>> {
        let tmp = tempfile::tempdir()?;
        let layout = Layout::Dev {
            engine_dir: tmp.path().join("engine"),
            runtime_root: tmp.path().join("rt"),
        };
        let env = Env {
            path: Some(tmp.path().join("empty").into_os_string()),
            ..Env::default()
        };
        let err = resolve(&layout, &env, &new_enough)
            .err()
            .ok_or("resolved")?;
        assert_eq!(err.state, InstallState::Missing);
        assert!(err.developer.is_some_and(|d| d.contains("no Node 22.18+")));
        Ok(())
    }

    #[test]
    fn node_versions_parse() {
        assert_eq!(parse_node_version("v24.13.0\n"), Some((24, 13, 0)));
        assert_eq!(parse_node_version("v22.18.0-nightly"), Some((22, 18, 0)));
        assert_eq!(parse_node_version("24.1.0"), None);
        assert!((22, 18, 0) >= NODE_MIN_VERSION && (22, 17, 99) < NODE_MIN_VERSION);
    }
}
