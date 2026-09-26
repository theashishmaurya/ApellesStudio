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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// The regression guard for B-206/D-336: a burst of requests for more
    /// one-shot extractions than the gate allows must never let more than
    /// [`MAX_CONCURRENT_EXTRACTIONS`] of them hold a permit AT THE SAME TIME.
    ///
    /// This is a COUNTING invariant, not a timing one, per
    /// `docs/notes/performance-instrumentation.md`'s standing rule — a wall-clock
    /// assertion here would be exactly the kind of number a loaded CI/dev
    /// machine renders meaningless. What is asserted is the one thing that
    /// survives contention: the maximum number of permits ever held at once,
    /// tracked by an atomic counter every waiter increments on acquire and
    /// decrements on drop, sampled continuously by a watcher task.
    ///
    /// Verified to actually catch a regression, not just pass vacuously: with
    /// `acquire()` temporarily replaced by a body that always returns `None`
    /// (no gating at all), this assertion fails as expected.
    #[tokio::test]
    async fn a_burst_of_requests_never_exceeds_max_concurrent_extractions() {
        const BURST: usize = 5 * MAX_CONCURRENT_EXTRACTIONS;
        let concurrent = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::with_capacity(BURST);
        for _ in 0..BURST {
            let concurrent = concurrent.clone();
            let peak = peak.clone();
            handles.push(tokio::spawn(async move {
                let _permit = acquire().await;
                let now = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                // Hold the permit long enough that a wrong (unbounded) gate
                // would provably let more than the cap run at once, without
                // making the test itself slow.
                tokio::time::sleep(Duration::from_millis(20)).await;
                concurrent.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        assert!(
            peak.load(Ordering::SeqCst) <= MAX_CONCURRENT_EXTRACTIONS,
            "gate let {} extractions run at once, cap is {} — a burst of {} requests must never exceed it",
            peak.load(Ordering::SeqCst),
            MAX_CONCURRENT_EXTRACTIONS,
            BURST,
        );
    }

    /// The other half of the same guard: the gate must not be so strict that it
    /// deadlocks or drops requests — every one of a burst eventually gets
    /// served. Paired with the test above so "always ok=None" (a closed/broken
    /// gate) cannot pass the concurrency assertion vacuously.
    #[tokio::test]
    async fn every_request_in_a_burst_is_eventually_served() {
        const BURST: usize = 5 * MAX_CONCURRENT_EXTRACTIONS;
        let served = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::with_capacity(BURST);
        for _ in 0..BURST {
            let served = served.clone();
            handles.push(tokio::spawn(async move {
                if acquire().await.is_some() {
                    served.fetch_add(1, Ordering::SeqCst);
                }
            }));
        }
        for h in handles {
            h.await.unwrap();
        }

        assert_eq!(served.load(Ordering::SeqCst), BURST);
    }
}
