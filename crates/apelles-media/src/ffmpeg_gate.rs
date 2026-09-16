//! ffmpeg_gate.rs — the ONE bound on how many `ffmpeg` child processes this
//! process may have running at once (D-334).
//!
//! What it is: a single global `tokio::sync::Semaphore` that every `ffmpeg`
//!   spawn which can fan out per-clip must hold a permit from.
//! What it does: caps concurrent extraction subprocesses, so a UI that mounts
//!   150 clips at once cannot start 150 4K decodes at once.
//! What it does NOT do: schedule, prioritise, or cancel. It is a count, not a
//!   queue with policy — a waiter gets a permit in roughly arrival order and
//!   that is all. It also does not cover `ffmpeg` processes that are
//!   long-lived streaming pipes rather than one-shot extractions
//!   (`decode_pipe`'s playback pipes), which are bounded by the number of
//!   tracks rather than by clip count and would deadlock behind a cap this
//!   small.
//!
//! **Why it is global rather than per-feature (the bug this fixes).** D-121
//! added a `Semaphore::new(3)` to [`crate::filmstrip`] after a real incident
//! (B-037): the owner's machine hit 11 simultaneous `ffmpeg` processes on
//! opening a multi-clip project and system load spiked past 200. That fix was
//! scoped to the filmstrip's own extraction and nothing else, which left two
//! holes. First, `video::extract_thumb` — the Colorist shot strip's per-shot
//! thumbnail — was never covered, and it fans out once per shot with no cache
//! at all, so opening the owner's 75-clip recut spawned 75 concurrent 4K
//! `ffmpeg` processes: the same incident, from a different call site, from a
//! tab the user need not even be looking at. Second, two independent
//! semaphores of 3 permit 6 processes, and a third would permit 9 — a
//! per-feature cap cannot express "this machine". The budget belongs to the
//! machine, so the semaphore does too.
//!
//! **Why 3.** Inherited from D-121's measured fix rather than re-derived: it
//! was chosen against the owner's real 4K HEVC footage on this same hardware
//! and held. With `-hwaccel videotoolbox` the limit that matters is the
//! hardware decoder's, not core count, so raising it with core count would be
//! the wrong knob.

use once_cell::sync::Lazy;
use tokio::sync::{Semaphore, SemaphorePermit};

/// How many one-shot `ffmpeg` extractions may run concurrently. See the module
/// doc for why this is one number for the whole process and why it is 3.
pub const MAX_CONCURRENT_EXTRACTIONS: usize = 3;

static GATE: Lazy<Semaphore> = Lazy::new(|| Semaphore::new(MAX_CONCURRENT_EXTRACTIONS));

/// Wait for a permit to spawn a one-shot `ffmpeg` extraction. Hold the
/// returned guard for as long as the child process runs; dropping it releases
/// the slot.
///
/// The semaphore is never closed, so the `acquire` cannot fail in practice —
/// but it is still handled rather than unwrapped, because a panic here would
/// take down a thumbnail fetch, and no thumbnail is worth that. A closed gate
/// degrades to "unbounded", which is exactly the behaviour that existed before
/// this module and so is safe as a floor.
pub async fn acquire() -> Option<SemaphorePermit<'static>> {
    GATE.acquire().await.ok()
}
