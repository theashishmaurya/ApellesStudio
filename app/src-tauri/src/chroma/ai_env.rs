//! Tauri bridge for the AI-env bootstrap (D-315).
//!
//! What it is: the app-side half of `apelles_ai::ai_env`, holding only the parts that
//! genuinely need Tauri — resolving where the lock file and the venv live in a
//! packaged bundle, emitting the live status event, and the two `#[tauri::command]`
//! wrappers. The state machine, the `uv` invocations, the retry/resume/heal logic and
//! all of the tests are in the crate (D-039 §1, D-145: commands do not move, engine
//! logic does not stay).
//!
//! What it does NOT do: any lifecycle decisions. It starts one thread and answers two
//! commands.
//!
//! **Why the paths are resolved here.** In a dev checkout everything is one directory
//! at the workspace root and the crate finds it by itself. In a bundle it is two
//! different directories, and neither is expressible without Tauri:
//!
//! | | dev checkout | packaged `.app` |
//! |---|---|---|
//! | `requirements.lock.txt`, `verify.py` | `<workspace>/ai-env/` | `Contents/Resources/resources/ai-env/` (read-only) |
//! | `.venv` | `<workspace>/ai-env/.venv` | `<app data>/ai-env/.venv` (writable) |
//!
//! They must be allowed to differ because a `.app` bundle is code-signed: writing a
//! 1.6 GB venv inside it would invalidate the signature. The dev case keeps both
//! together so that the app and a hand-run `ai-env/setup.sh` build and share exactly
//! one environment, which is what D-314 set up and what this must not break.

use apelles_ai::ai_env::{AiEnvPaths, AiEnvStatus};
use tauri::{Emitter, Manager};

/// The live status event. Kebab-case, like every other one-way push in this app
/// (`ai-connector-status-update`, `thumbnail-progress`, `focus-stack-progress`).
///
/// Tauri events are not buffered (see `chroma/control.rs`'s module doc), so a listener
/// that registers late misses everything sent before it. That is why
/// [`chroma_ai_env_status`] exists alongside this: the frontend reads the current state
/// once on mount and then keeps up via the event, rather than depending on having been
/// listening from the first millisecond of app start.
pub const STATUS_EVENT: &str = "ai-env-status";

/// Work out where the lock file and the venv are for this build, dev or bundled.
///
/// Returns `None` only when neither layout can be found, which the crate reports as
/// [`apelles_ai::ai_env::Phase::Unavailable`] — a real state with a real message, not a
/// crash.
fn resolve_paths(app: &tauri::AppHandle) -> Option<AiEnvPaths> {
    // Dev checkout first. If the workspace's own `ai-env/` is there, use it whole:
    // sharing one venv with `ai-env/setup.sh` is the entire point of D-314's layout,
    // and a dev build quietly building a second copy under Application Support would
    // waste 1.6 GB and split the two.
    if let Some(dev) = apelles_ai::ai_env::paths() {
        log::info!("[ai-env] dev layout: {}", dev.root.display());
        return Some(dev);
    }

    // Packaged: read-only inputs from the bundle, writable venv beside the app's other
    // data. `resources/ai-env/` is where `build.rs`'s `stage_ai_env_resources` puts
    // them, so this path is the same in a bundle and in a `tauri dev` target dir.
    let resources = app
        .path()
        .resolve("resources/ai-env", tauri::path::BaseDirectory::Resource)
        .ok()?;
    let data = app.path().app_data_dir().ok()?;
    let paths = AiEnvPaths {
        root: data.join("ai-env"),
        lock: resources.join("requirements.lock.txt"),
        verify: resources.join("verify.py"),
    };
    log::info!(
        "[ai-env] packaged layout: venv {} | resources {}",
        paths.venv().display(),
        resources.display()
    );
    Some(paths)
}

/// Start the bootstrap supervisor. Called from `lib.rs` `.setup()` on its own thread,
/// beside the three sidecar supervisors — deliberately at launch rather than on the
/// first AI-feature click, so the environment is usually already built by the time
/// anybody reaches for it.
///
/// Never blocks startup: the only work done on the calling thread is resolving two
/// paths.
pub fn spawn_and_supervise(app: tauri::AppHandle) {
    if let Some(paths) = resolve_paths(&app) {
        apelles_ai::ai_env::configure(paths);
    }
    std::thread::spawn(move || {
        apelles_ai::ai_env::supervise(move |status: &AiEnvStatus| {
            let _ = app.emit(STATUS_EVENT, status);
        });
    });
}

/// The current bootstrap state — the same struct the [`STATUS_EVENT`] carries.
///
/// Read once on mount by every surface that shows it (the Settings card, and each AI
/// feature's "still setting up" state), because the event stream alone cannot tell a
/// late listener what it missed.
#[tauri::command]
pub fn chroma_ai_env_status() -> AiEnvStatus {
    apelles_ai::ai_env::status_snapshot()
}

/// Retry the bootstrap now, skipping whatever backoff is in progress.
///
/// Returns `false` when there was nothing to retry (already ready, or already
/// working), so the caller can say "already running" instead of showing a spinner for
/// a click that did nothing.
#[tauri::command]
pub fn chroma_ai_env_retry() -> bool {
    apelles_ai::ai_env::retry_now()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The event name is a string shared with the frontend and the MCP layer and
    /// compiled into neither of them — a rename that misses one side is silent.
    #[test]
    fn the_status_event_name_is_the_kebab_case_one_the_frontend_listens_for() {
        assert_eq!(STATUS_EVENT, "ai-env-status");
    }

    /// `build.rs` stages the two runtime inputs into `resources/ai-env/`, and
    /// `resolve_paths` reads them back from exactly that subdirectory. Nothing makes
    /// those two strings agree at compile time, and a mismatch would only show up as a
    /// packaged build whose AI features can never bootstrap — invisible in every dev
    /// run, which is the shape of B-169 all over again.
    #[test]
    fn the_build_script_stages_the_resources_this_module_resolves() {
        let build_rs = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("build.rs"),
        )
        .expect("build.rs should be readable");
        assert!(
            build_rs.contains("join(\"resources\").join(\"ai-env\")"),
            "build.rs must stage into resources/ai-env/, which resolve_paths reads"
        );
        for name in ["requirements.lock.txt", "verify.py"] {
            assert!(
                build_rs.contains(name),
                "build.rs must stage {name} — resolve_paths expects it in the bundle"
            );
        }
    }

    /// The bundled `uv` has to actually be declared as an `externalBin`, or the whole
    /// mechanism ships with nothing to run. It lives in the macOS-only config because
    /// v1 is macOS ARM (`docs/02-scope.md`) and a Linux build must not break on a
    /// binary this repo does not fetch for it.
    #[test]
    fn uv_is_declared_as_an_external_bin_for_macos() {
        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.macos.conf.json"),
            )
            .expect("tauri.macos.conf.json should be readable"),
        )
        .expect("tauri.macos.conf.json should be valid JSON");

        let bins = conf["bundle"]["externalBin"]
            .as_array()
            .expect("bundle.externalBin should be an array");
        assert!(
            bins.iter().any(|b| b.as_str() == Some("binaries/uv")),
            "uv must be declared as an externalBin, got {bins:?}"
        );
    }
}
