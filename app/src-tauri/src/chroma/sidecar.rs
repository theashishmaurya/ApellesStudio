//! Tauri bridge for the `ai/` FastAPI sidecar (D-028).
//!
//! What it is: the app-side half of the D-142 `chroma-ai` extraction
//! (`docs/notes/crate-extraction-plan.md` §2.5) — everything that genuinely
//! needs Tauri stayed here: the `#[tauri::command] chroma_ai_status` wrapper
//! and the call to spawn the supervisor thread from `lib.rs` `.setup()`.
//! What it does NOT do: any of the actual lifecycle logic (resolve the
//! sidecar dir + Python interpreter, health checks, content hashing,
//! spawn/backoff/respawn, external-process monitoring) — all of that is
//! `chroma_ai::sidecar` now. This file used to be the whole 704-line
//! implementation; see D-142 in `docs/08-decisions.md` for what moved and why.

pub use chroma_ai::sidecar::{shutdown, spawn_and_supervise, SidecarStatus};

/// `{ managed, healthy, pid?, restarts, stale, lastError? }` — backs the
/// Settings panel's "AI Sidecar" status card (D-101).
#[tauri::command]
pub fn chroma_ai_status() -> SidecarStatus {
    chroma_ai::sidecar::status_snapshot()
}
