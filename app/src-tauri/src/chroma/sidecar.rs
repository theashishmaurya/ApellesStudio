//! Tauri bridge for Chroma's supervised Python sidecars (D-028, D-189).
//!
//! What it is: the app-side half of the D-142 `chroma-ai` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.5) — everything that genuinely
//! needs Tauri stayed here: the `#[tauri::command]` status wrappers and the
//! calls to spawn the supervisor threads from `lib.rs` `.setup()`.
//! What it does NOT do: any of the actual lifecycle logic (resolve the
//! sidecar dir + Python interpreter, health checks, content hashing,
//! spawn/backoff/respawn, external-process monitoring) — all of that is
//! `chroma_ai::sidecar` now. This file used to be the whole 704-line
//! implementation; see D-142 in `docs/08-decisions.md` for what moved and why.
//!
//! D-189/D-190: two sidecars are supervised now, `ai/` and `ai-media/`, by one
//! `SidecarSpec`-parameterized supervisor. That is why there are two spawn
//! entry points and two status commands here — `shutdown()` stayed a single
//! call, since it kills every child the supervisor owns.

pub use chroma_ai::sidecar::{
    SidecarStatus, shutdown, spawn_and_supervise, spawn_and_supervise_media,
};

/// `{ managed, healthy, pid?, restarts, stale, lastError? }` — backs the
/// Settings panel's "AI Sidecar" status card (D-101).
#[tauri::command]
pub fn chroma_ai_status() -> SidecarStatus {
    chroma_ai::sidecar::status_snapshot(&chroma_ai::sidecar::AI)
}

/// The same shape for the `ai-media/` sidecar — backs the Settings panel's
/// "Media Understanding Sidecar" card (D-189).
#[tauri::command]
pub fn chroma_ai_media_status() -> SidecarStatus {
    chroma_ai::sidecar::status_snapshot(&chroma_ai::sidecar::AI_MEDIA)
}
