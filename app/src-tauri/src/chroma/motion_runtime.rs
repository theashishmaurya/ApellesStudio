//! Tauri bridge for Motion's render runtime (D-417).
//!
//! What it is: the app-side half of `apelles_motion_runtime::manager` — the parts
//! that genuinely need Tauri: working out where this build's engine files and
//! downloaded runtime live (dev checkout or installed app), emitting the live
//! status event, and the three `#[tauri::command]`s. The downloads, checksums,
//! atomic install, integrity check and the resolver are all in the crate (D-039,
//! D-145: commands do not move, engine logic does not stay).
//!
//! What it does NOT do: decide when to download. The Motion tab asks the first
//! time it opens (owner decision recorded with D-391), an agent asks with
//! `motion_install_runtime`; nothing downloads at launch.
//!
//! | | dev checkout (`tauri dev`) | installed `.app` |
//! |---|---|---|
//! | engine files | `packages/motion-engine` | `Contents/Resources/motion-engine` (the engine pack, read-only) |
//! | Node / Chrome / compositor | the developer's own `node` (or the downloaded runtime) | `<app data>/motion-runtime/<key>/` |
//!
//! Gated on `tauri::is_dev()` rather than on "does the checkout exist", for the
//! reason `ai_env::resolve_paths` gives: on the machine that built the release the
//! checkout exists, and the release would then behave differently there only.

use std::path::PathBuf;

use apelles_motion_runtime::manager::{self, RuntimeStatus};
use apelles_motion_runtime::{Layout, MotionRuntime};
use tauri::{Emitter, Manager};

/// The live status event (kebab-case like every one-way push in this app). Tauri
/// events are not buffered, so the frontend reads [`chroma_motion_runtime_status`]
/// once and then follows this.
pub const STATUS_EVENT: &str = "motion-runtime-status";
/// Where the engine pack sits in the bundle's Resources (`tauri.macos.release.conf.json`).
pub const PACK_RESOURCE_DIR: &str = "motion-engine";
/// The downloaded runtime's folder under the app data directory.
pub const RUNTIME_DIR: &str = "motion-runtime";

/// `packages/motion-engine`, from this crate's compile-time location — dev only.
fn checkout_engine_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("motion-engine")
}

/// Settle the layout. Called once from `.setup()`, before any Motion command can
/// run; logs what a render would use right now (the cheap integrity check).
pub fn configure(app: &tauri::AppHandle) {
    let runtime_root = match app.path().app_data_dir() {
        Ok(dir) => dir.join(RUNTIME_DIR),
        Err(e) => {
            log::error!("[motion-runtime] no app data dir, Motion renders are unavailable: {e}");
            return;
        }
    };
    let layout = if tauri::is_dev() {
        Layout::Dev {
            engine_dir: checkout_engine_dir(),
            runtime_root,
        }
    } else {
        match app
            .path()
            .resolve(PACK_RESOURCE_DIR, tauri::path::BaseDirectory::Resource)
        {
            Ok(pack_dir) => Layout::Packaged {
                pack_dir,
                runtime_root,
            },
            Err(e) => {
                log::error!(
                    "[motion-runtime] no Resources dir, Motion renders are unavailable: {e}"
                );
                return;
            }
        }
    };
    log::info!("[motion-runtime] layout {layout:?}");
    manager::configure(layout);
    let status = manager::status();
    log::info!("[motion-runtime] {:?}: {}", status.state, status.detail);
}

/// The runtime every Motion render path uses, or the `motion_runtime_not_ready: …`
/// explanation.
pub fn require() -> Result<MotionRuntime, String> {
    manager::require()
}

/// This build's engine files (the built-in components are listed from here even
/// before anything is downloaded).
pub fn engine_dir() -> PathBuf {
    manager::engine_dir().unwrap_or_else(checkout_engine_dir)
}

/// Start the download in the background, pushing [`STATUS_EVENT`] as it moves.
/// `false` when there is nothing to start (ready, or already busy).
pub fn install(app: &tauri::AppHandle) -> bool {
    let app = app.clone();
    manager::start_install(move |status| {
        if let Err(e) = app.emit(STATUS_EVENT, status) {
            log::warn!("[motion-runtime] could not emit the status event: {e}");
        }
    })
}

/// What `chroma_motion_runtime_install` and `motion_install_runtime` answer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAnswer {
    /// `true` when this call started a download; `false` is a normal answer
    /// (already ready, or already downloading).
    pub started: bool,
    #[serde(flatten)]
    pub status: RuntimeStatus,
}

/// The current status (cheap).
#[tauri::command]
pub fn chroma_motion_runtime_status() -> RuntimeStatus {
    manager::status()
}

/// Download and install the runtime in the background (or say why not).
#[tauri::command]
pub fn chroma_motion_runtime_install(app: tauri::AppHandle) -> InstallAnswer {
    let started = install(&app);
    InstallAnswer {
        started,
        status: manager::status(),
    }
}

/// "Remove Motion runtime": delete the downloaded runtime. Refused while it is
/// downloading.
#[tauri::command]
pub fn chroma_motion_runtime_remove(app: tauri::AppHandle) -> Result<RuntimeStatus, String> {
    let status = manager::remove().map_err(|e| e.to_string())?;
    let _ = app.emit(STATUS_EVENT, &status);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_file(rel: &str) -> String {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        std::fs::read_to_string(repo.join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"))
    }

    /// The event name and the not-ready token are shared with the frontend
    /// (`@apelles/bridge`'s `motionRuntime.ts`) and compiled into neither side.
    #[test]
    fn the_frontend_spells_the_event_and_the_not_ready_token_the_same() {
        let ts = repo_file("packages/bridge/src/motionRuntime.ts");
        assert!(
            ts.contains(&format!("'{STATUS_EVENT}'")),
            "motionRuntime.ts listens for {STATUS_EVENT}"
        );
        let code = apelles_motion_runtime::NOT_READY_CODE;
        assert!(
            ts.contains(&format!("'{code}'")),
            "motionRuntime.ts names {code}"
        );
    }

    /// `control.rs` answers the three ops natively, both MCP servers post them, and
    /// the status tool's description names the token a refused render carries. A
    /// rename on one side is silent until an agent hits it.
    #[test]
    fn the_runtime_ops_are_spelled_the_same_everywhere_they_are_written_down() {
        let control = repo_file("app/src-tauri/src/chroma/control.rs");
        let python = repo_file("mcp/server.py");
        let rust = repo_file("crates/apelles-mcp/src/tools/motion/runtime.rs");
        for op in [
            "motion_runtime_status",
            "motion_install_runtime",
            "motion_remove_runtime",
        ] {
            assert!(
                control.contains(&format!("\"{op}\" =>")),
                "control.rs must answer '{op}'"
            );
            assert!(
                python.contains(&format!("_op(\"{op}\")")),
                "mcp/server.py must post '{op}'"
            );
            assert!(
                rust.contains(&format!("self.op(\"{op}\"")),
                "apelles-mcp must post '{op}'"
            );
        }
        let code = apelles_motion_runtime::NOT_READY_CODE;
        assert!(
            python.contains(code) && rust.contains(code),
            "both descriptions name {code}"
        );
    }

    /// The pack is staged by the release pre-build and mapped into Resources under
    /// the name `configure` resolves; nothing makes those agree at compile time.
    #[test]
    fn the_release_overlay_ships_the_engine_pack_where_configure_looks() {
        let here = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let read_json = |rel: &str| -> serde_json::Value {
            let text = std::fs::read_to_string(here.join(rel))
                .unwrap_or_else(|e| panic!("{rel} should be readable: {e}"));
            serde_json::from_str(&text).unwrap_or_else(|e| panic!("{rel} is not JSON: {e}"))
        };
        let release = read_json("tauri.macos.release.conf.json");
        let resources = release["bundle"]["resources"]
            .as_object()
            .unwrap_or_else(|| panic!("the release overlay maps resources, got {release}"));
        assert_eq!(
            resources
                .get("motion-engine-pack/")
                .and_then(|v| v.as_str()),
            Some(format!("{PACK_RESOURCE_DIR}/").as_str()),
            "the pack is staged at app/src-tauri/motion-engine-pack/ and lands in Resources/{PACK_RESOURCE_DIR}/"
        );
        // A `--config` merge replaces `resources` wholesale: everything the base
        // config ships must still be there.
        let base = read_json("tauri.conf.json");
        for dir in base["bundle"]["resources"].as_array().into_iter().flatten() {
            let dir = dir.as_str().unwrap_or_default();
            assert_eq!(
                resources.get(&format!("{dir}/")).and_then(|v| v.as_str()),
                Some(format!("{dir}/").as_str()),
                "the release overlay must keep the base resource {dir}"
            );
        }

        let pkg = read_json("../package.json");
        let script = pkg["scripts"]["tauri:before-build"]
            .as_str()
            .unwrap_or_default();
        assert!(
            script.contains("build-pack.mts --out=src-tauri/motion-engine-pack"),
            "the release pre-build must stage the engine pack, got {script:?}"
        );
    }
}
