//! A tiny in-process registry for Motion's slow one-shot operations (B-321).
//!
//! **What it is:** `start` runs a closure on its own thread and hands back a job
//! id at once; `poll` reports whether that job is still running, finished with a
//! JSON result, or failed with a message. The custom-component proof (three
//! render passes, 1-3 min) and the preview still (a first engine bundle, ~20 s)
//! go through it.
//!
//! **Why:** those two used to be ONE Tauri `invoke` that stayed pending for the
//! whole render. Live, the render finished on disk and the pending `invoke` never
//! resolved in the webview (B-321), so the bridge reply that waited on it timed
//! out and the caller lost a result that existed. A start call that returns in
//! milliseconds followed by short polls never depends on one long-lived `invoke`
//! surviving.
//!
//! **What it does NOT do:** persist anything (a restarted app has no jobs; a
//! poll for an unknown id says so), cancel a job, or stream progress. A finished
//! job is handed over exactly once, by the `poll` that sees it finish.

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::Serialize;
use serde_json::Value;

/// How a job stands, as `poll` reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LongOpPoll {
    /// Still running: poll again.
    Running,
    /// Finished; `result` is the closure's value. Reported once.
    Done { result: Value },
    /// The closure returned an error (or panicked). Reported once.
    Failed { error: String },
}

enum Slot {
    Running,
    Finished(Result<Value, String>),
}

/// Finished jobs nobody ever polled are dropped beyond this many, oldest id
/// first, so an abandoned caller cannot grow the registry without bound.
const MAX_UNCLAIMED: usize = 64;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn registry() -> &'static Mutex<HashMap<u64, Slot>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u64, Slot>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock() -> MutexGuard<'static, HashMap<u64, Slot>> {
    // A poisoned lock only means a thread panicked while holding it; the map is
    // still a valid map of slots, so recover it rather than refuse every poll.
    registry().lock().unwrap_or_else(|p| p.into_inner())
}

/// Run `work` on its own thread; the returned id is what `poll` takes.
pub fn start<F>(work: F) -> Result<String, String>
where
    F: FnOnce() -> Result<Value, String> + Send + 'static,
{
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    lock().insert(id, Slot::Running);
    let spawned = std::thread::Builder::new()
        .name(format!("motion-longop-{id}"))
        .spawn(move || {
            let outcome = catch_unwind(AssertUnwindSafe(work))
                .unwrap_or_else(|_| Err("the operation panicked".to_string()));
            let mut map = lock();
            map.insert(id, Slot::Finished(outcome));
            prune_unclaimed(&mut map);
        });
    match spawned {
        Ok(_) => Ok(id.to_string()),
        Err(e) => {
            lock().remove(&id);
            Err(format!("could not start the operation: {e}"))
        }
    }
}

fn prune_unclaimed(map: &mut HashMap<u64, Slot>) {
    let mut finished: Vec<u64> = map
        .iter()
        .filter(|(_, s)| matches!(s, Slot::Finished(_)))
        .map(|(id, _)| *id)
        .collect();
    if finished.len() <= MAX_UNCLAIMED {
        return;
    }
    finished.sort_unstable();
    for id in &finished[..finished.len() - MAX_UNCLAIMED] {
        map.remove(id);
    }
}

/// The state of job `id`. A finished job is removed as it is reported.
pub fn poll(id: &str) -> Result<LongOpPoll, String> {
    let key: u64 = id
        .parse()
        .map_err(|_| format!("'{id}' is not an operation id"))?;
    let mut map = lock();
    match map.get(&key) {
        None => Err(format!(
            "no operation '{id}' (it was already reported, or the app restarted)"
        )),
        Some(Slot::Running) => Ok(LongOpPoll::Running),
        Some(Slot::Finished(_)) => match map.remove(&key) {
            Some(Slot::Finished(Ok(result))) => Ok(LongOpPoll::Done { result }),
            Some(Slot::Finished(Err(error))) => Ok(LongOpPoll::Failed { error }),
            _ => Err(format!("no operation '{id}'")),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn wait(id: &str) -> LongOpPoll {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match poll(id).unwrap() {
                LongOpPoll::Running if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                other => return other,
            }
        }
    }

    #[test]
    fn start_returns_before_the_work_finishes_and_poll_reports_it_once() {
        let (release, gate) = mpsc::channel::<()>();
        let id = start(move || {
            gate.recv().ok();
            Ok(serde_json::json!({ "path": "a.png" }))
        })
        .unwrap();
        assert_eq!(poll(&id).unwrap(), LongOpPoll::Running);
        release.send(()).unwrap();
        assert_eq!(
            wait(&id),
            LongOpPoll::Done {
                result: serde_json::json!({ "path": "a.png" })
            }
        );
        assert!(poll(&id).is_err(), "a finished job is handed over once");
    }

    #[test]
    fn a_failed_job_reports_its_message() {
        let id = start(|| Err("no runtime".to_string())).unwrap();
        assert_eq!(
            wait(&id),
            LongOpPoll::Failed {
                error: "no runtime".to_string()
            }
        );
    }

    #[test]
    fn a_panicking_job_fails_instead_of_staying_running_forever() {
        let id = start(|| panic!("boom")).unwrap();
        assert_eq!(
            wait(&id),
            LongOpPoll::Failed {
                error: "the operation panicked".to_string()
            }
        );
    }

    #[test]
    fn an_unknown_or_malformed_id_is_an_error() {
        assert!(poll("999999999").is_err());
        assert!(poll("abc").is_err());
    }

    #[test]
    fn the_wire_shape_is_tagged_by_state() {
        let v = serde_json::to_value(LongOpPoll::Running).unwrap();
        assert_eq!(v, serde_json::json!({ "state": "running" }));
        let v = serde_json::to_value(LongOpPoll::Done {
            result: serde_json::json!(1),
        })
        .unwrap();
        assert_eq!(v, serde_json::json!({ "state": "done", "result": 1 }));
    }
}
