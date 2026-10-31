//! The AI-video-understanding feature flag (D-433): a persisted user setting, the
//! one gate every video analysis passes through, and the Mac's RAM figure the
//! Settings card shows next to it.
//!
//! What it is: video understanding (`ai-media/video_understand.py`, Qwen3-VL 4B)
//! is a rare, heavy feature — a ~2.9 GB lazy model download and ~9 GB peak memory
//! per call — so it is **off by default** and a user turns it on in Settings → Processing.
//! The flag lives in `settings.json` (`AppSettings::enable_video_understanding`,
//! the same file every other preference uses), not in a second store.
//!
//! What it does:
//!   - [`ensure_enabled`] is the choke point. `chroma_analyze_video`
//!     (`media_understanding.rs`) calls it before the sidecar job starts, and every
//!     caller — the Edit tab's store, the `editor_analyze_video` MCP tool — reaches
//!     the sidecar only through that command, so the GUI and the MCP cannot drift.
//!   - [`chroma_video_understanding_status`] / [`chroma_set_video_understanding`]
//!     read and write the flag for the Settings card (Settings → Processing); the MCP's `ai_env_status`
//!     (read) and `ai_set_video_understanding` (write) are the same two functions
//!     answered natively in `control.rs`.
//!   - [`total_memory_bytes`] reads the Mac's installed RAM (`sysinfo`, which on
//!     macOS is a `sysctl hw.memsize` read) so the card can warn on a small Mac.
//!
//! What it does NOT do: it never gates transcription (Parakeet stays on), never
//! blocks the toggle on low RAM (the warning is advice, the choice is the user's),
//! and does not load or unload the model — the sidecar is a subprocess per call,
//! so a disabled feature already costs no memory when idle.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::app_settings::{load_settings, save_settings};

/// Pushed whenever the flag changes, so every open surface (the Settings card, the
/// app's in-memory copy of `settings.json`) follows an MCP-driven change.
pub const STATUS_EVENT: &str = "video-understanding-status";

/// Below this much installed RAM the card shows its warning: the model's ~9 GB
/// peak leaves a 16 GB Mac little headroom for the editor itself.
pub const LOW_MEMORY_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// Where to turn it on — reported as `howToEnable`.
const HOW_TO_ENABLE: &str = "Settings → Processing → AI video understanding";

/// The user-facing refusal. One string so the GUI error, the Tauri error and the
/// MCP tool result are word-for-word the same.
pub const REFUSAL: &str = "AI video understanding is turned off. Turn it on in Settings → \
     Processing → AI video understanding (it downloads a ~3 GB model and uses up to ~9 GB of memory while \
     it runs), or ask the user to. Transcripts are not affected.";

/// What the Settings card and the MCP report about the flag.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoUnderstandingStatus {
    pub enabled: bool,
    /// Installed RAM in bytes, or `None` when it could not be read.
    pub total_memory_bytes: Option<u64>,
    /// `true` only when RAM is known AND below [`LOW_MEMORY_BYTES`].
    pub low_memory: bool,
    /// The refusal text while disabled, `None` while enabled.
    pub refusal: Option<String>,
    pub how_to_enable: String,
}

/// Installed RAM in bytes. `Err` when the OS reports zero (a failed read), so a
/// caller never mistakes "could not tell" for "no memory".
pub fn total_memory_bytes() -> Result<u64, String> {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    match sys.total_memory() {
        0 => Err("could not read this Mac's installed memory size".to_string()),
        bytes => Ok(bytes),
    }
}

/// Pure assembly of the status from the two facts — testable without an app.
pub fn describe(enabled: bool, total_memory: Option<u64>) -> VideoUnderstandingStatus {
    VideoUnderstandingStatus {
        enabled,
        total_memory_bytes: total_memory,
        low_memory: total_memory.is_some_and(|bytes| bytes < LOW_MEMORY_BYTES),
        refusal: (!enabled).then(|| REFUSAL.to_string()),
        how_to_enable: HOW_TO_ENABLE.to_string(),
    }
}

/// The choke point: `Ok` only when the flag is on.
pub fn ensure_enabled(enabled: bool) -> Result<(), String> {
    if enabled {
        Ok(())
    } else {
        Err(REFUSAL.to_string())
    }
}

/// The persisted flag. `Err` when `settings.json` exists but cannot be read
/// (B-194: never guess a default over a real, unreadable file).
pub fn read_enabled(app: &AppHandle) -> Result<bool, String> {
    Ok(load_settings(app.clone())?
        .enable_video_understanding
        .unwrap_or(false))
}

/// The current status; an unreadable RAM figure degrades to `None`, not an error.
pub fn status(app: &AppHandle) -> Result<VideoUnderstandingStatus, String> {
    let memory = total_memory_bytes()
        .map_err(|e| log::warn!("[video-understanding] {e}"))
        .ok();
    Ok(describe(read_enabled(app)?, memory))
}

/// Persist the flag, log the change (it is a user setting, so an MCP-driven change
/// must leave a trace), and tell every surface.
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<VideoUnderstandingStatus, String> {
    let mut settings = load_settings(app.clone())?;
    settings.enable_video_understanding = Some(enabled);
    save_settings(settings, app.clone())?;
    log::info!(
        "[video-understanding] AI video understanding turned {}",
        if enabled { "ON" } else { "OFF" }
    );
    let new_status = status(app)?;
    if let Err(e) = app.emit(STATUS_EVENT, new_status.clone()) {
        log::warn!("[video-understanding] could not announce the change: {e}");
    }
    Ok(new_status)
}

/// Settings card: read the flag and the Mac's RAM.
#[tauri::command]
pub fn chroma_video_understanding_status(
    app: AppHandle,
) -> Result<VideoUnderstandingStatus, String> {
    status(&app)
}

/// Settings card: turn the flag on or off.
#[tauri::command]
pub fn chroma_set_video_understanding(
    app: AppHandle,
    enabled: bool,
) -> Result<VideoUnderstandingStatus, String> {
    set_enabled(&app, enabled)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn the_gate_refuses_with_the_user_facing_message_when_off() {
        let err = ensure_enabled(false).expect_err("off must refuse");
        assert!(
            err.starts_with("AI video understanding is turned off."),
            "{err}"
        );
        assert!(err.contains("Settings → Processing"), "{err}");
        assert!(ensure_enabled(true).is_ok());
    }

    #[test]
    fn a_disabled_status_carries_the_refusal_and_an_enabled_one_does_not() {
        assert_eq!(
            describe(false, Some(32 * GIB)).refusal.as_deref(),
            Some(REFUSAL)
        );
        assert_eq!(describe(true, Some(32 * GIB)).refusal, None);
    }

    #[test]
    fn low_memory_is_strictly_below_16_gib_and_unknown_is_not_low() {
        assert!(describe(true, Some(8 * GIB)).low_memory);
        assert!(describe(true, Some(16 * GIB - 1)).low_memory);
        assert!(!describe(true, Some(16 * GIB)).low_memory);
        assert!(!describe(true, Some(64 * GIB)).low_memory);
        assert!(!describe(true, None).low_memory);
    }

    #[test]
    fn the_installed_ram_can_be_read_on_this_machine() {
        let bytes = total_memory_bytes().expect("every machine running the tests has RAM");
        assert!(bytes >= GIB, "implausible RAM figure: {bytes}");
    }

    /// The write op is spelled in three places no compiler connects: `control.rs`
    /// answers it natively, and both MCP servers post it. A rename on one side
    /// would silently fall through to the frontend registry as "unknown op".
    #[test]
    fn the_set_op_is_spelled_the_same_in_control_and_both_mcp_servers() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..");
        let read = |rel: &str| {
            std::fs::read_to_string(repo.join(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"))
        };
        assert!(
            read("app/src-tauri/src/chroma/control.rs")
                .contains("\"ai_set_video_understanding\" =>")
        );
        assert!(read("mcp/server.py").contains("_op(\"ai_set_video_understanding\""));
        assert!(
            read("crates/apelles-mcp/src/tools/ai_env.rs")
                .contains("self.op(\"ai_set_video_understanding\"")
        );
    }

    #[test]
    fn the_flag_defaults_off_and_a_file_without_it_reads_as_off() {
        assert_eq!(
            crate::app_settings::AppSettings::default().enable_video_understanding,
            Some(false)
        );
        let parsed: crate::app_settings::AppSettings =
            serde_json::from_str(r#"{"theme": "dark"}"#).expect("legacy file parses");
        assert!(!parsed.enable_video_understanding.unwrap_or(false));
    }
}
