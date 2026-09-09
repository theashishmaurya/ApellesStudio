//! # apelles-ai — L2 domain crate (D-145, crate-extraction-plan.md §2.5)
//!
//! **What it is:** the Apelles AI sidecar client — everything about talking to
//! the `ai/` FastAPI sidecar (SAM 2 → ViTMatte subject matting, D-016; Video
//! Depth Anything depth tracking, D-036) that does not require `tauri::State`,
//! an `AppHandle`, or a fork-side global (`chroma::state::current_video()`).
//!
//! Four modules — three per source file it was extracted from, plus one added
//! later:
//! - [`sidecar`] — process lifecycle: spawn, health-poll, content-hash
//!   staleness detection, capped-backoff respawn, external-process monitoring
//!   (from `app/src-tauri/src/chroma/sidecar.rs`, D-028/D-101). Since D-190 it
//!   supervises **N** sidecars from one `SidecarSpec`-parameterized
//!   implementation, not just `ai/`.
//! - [`media_understanding`] — the `ai-media/` sidecar's HTTP client:
//!   `/transcribe` + `/understand_video` and their two job-status polls
//!   (D-189). Written here rather than extracted from the fork, since the
//!   capability is new — but the same shape as [`depth`], for the same reason.
//! - [`depth`] — the `/depth_track` + `/depth_track/<id>` HTTP client and the
//!   per-frame tracked-depth-PNG lookup (from `chroma/depth.rs`, D-036).
//! - [`mask`] — the `/segment`, `/track`, `/track/<id>`, `/refine_track`,
//!   `/health` HTTP client and the per-frame tracked-matte-PNG lookup (from
//!   `chroma/mask.rs`, D-016/D-018/D-019).
//!
//! **What does NOT live here, and why** (D-039 §1, "commands do not move" —
//! traced against `tauri-macros-2.6.3`; see `docs/notes/crate-extraction-plan.md`
//! §1): every `#[tauri::command]` (`chroma_ai_status`, `chroma_depth_track`,
//! `chroma_depth_track_status`, `chroma_subject_mask`, `chroma_track_subject`,
//! `chroma_track_status`, `chroma_refine_tracked_frame`, `chroma_ai_health`)
//! stays in `app/src-tauri/src/chroma/{sidecar,depth,mask}.rs` as a thin
//! wrapper around this crate. `chroma_subject_mask` additionally needs
//! `crate::get_cached_full_warped_image` and returns
//! `crate::ai_processing::AiSubjectMaskParameters` — both real fork types this
//! crate must not depend on or duplicate — so its whole warped-frame-fetch +
//! params-construction body stays app-side too; only the `/segment` wire call
//! ([`mask::segment`]) moved.
//!
//! **The two real signature changes (D-145):** the original app-side
//! `depth::tracked_depth_map` and `mask::tracked_full_mask` each read a
//! fork-side global (`chroma::state::current_video()?.frame`) directly.
//! Neither this crate's [`depth::depth_map_at`] nor [`mask::mask_at`] can see
//! that global, so both take the frame index as a plain argument instead — a
//! strictly better signature (testable with no global). The app-side function
//! of the old name keeps its old `(&serde_json::Value)` signature — so
//! `mask_generation.rs`'s call sites needed no edits — and now just resolves
//! the dir + frame and calls in. `mask_generation.rs` was not touched.
//!
//! **What it does NOT do:** no GPU, no video decode, no `grade.json`, no
//! knowledge of the frontend's mask-parameter JSON shape (`chromaDepthDir` /
//! `chromaTrackDir` extraction stays app-side, next to the fork types that
//! define those params).

pub mod depth;
pub mod mask;
pub mod media_understanding;
pub mod sidecar;

/// The Apelles AI sidecar's base URL — `http://127.0.0.1:<CHROMA_AI_PORT or 8765>`.
/// Shared by every submodule that talks to the sidecar over HTTP (`depth`,
/// `mask`); `sidecar`'s own supervisor talks raw TCP for `/health` and keeps
/// its own `port() -> u16` for that.
pub fn sidecar_base_url() -> String {
    let port = std::env::var("CHROMA_AI_PORT").unwrap_or_else(|_| "8765".to_string());
    format!("http://127.0.0.1:{port}")
}
