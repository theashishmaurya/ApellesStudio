//! Chroma's own bit of process state, kept out of upstream's `AppState` so the
//! fork diff stays minimal (D-003).
//!
//! **Multi-shot session (D-033).** A grading job is N shots from one shoot. The
//! process now holds a [`Session`] — an ordered `Vec` of [`Shot`]s + which one is
//! *active*. `current_video()` returns the active shot's clip, so every existing
//! caller (`chroma_seek`, `export`, `mask`, `playback`, …) keeps working
//! unchanged. Per-shot grade + activity-feed state lives in the frontend (D-020 /
//! D-032) keyed by shot path; this module only tracks the shot list, the active
//! index, and each shot's playhead. Still a module global (no `.chroma` project
//! bundle — see D-033); a `.chroma/session.json` path list is a deferred
//! follow-up.

use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use super::video::VideoInfo;

/// One shot in the session: a clip path, its probe info, and the playhead the
/// transport last left it on. (Type name kept as `CurrentVideo` so the D-015…
/// D-032 call sites don't churn; a `Shot` alias is exported for new code.)
#[derive(Debug, Clone)]
pub struct CurrentVideo {
    pub path: PathBuf,
    pub info: VideoInfo,
    /// frame index currently decoded into `AppState.original_image`
    pub frame: u64,
}

/// A shot in the multi-shot session (D-033). Alias of [`CurrentVideo`].
pub type Shot = CurrentVideo;

/// An ordered set of shots + which one is active. Pure — no I/O, no cache
/// invalidation; the module-global wrappers below handle that so this is
/// parallel-test-safe.
#[derive(Debug, Clone, Default)]
pub struct Session {
    pub shots: Vec<Shot>,
    pub active: usize,
}

impl Session {
    pub fn active_shot(&self) -> Option<&Shot> {
        self.shots.get(self.active)
    }

    fn active_path(&self) -> Option<PathBuf> {
        self.active_shot().map(|s| s.path.clone())
    }

    /// Upsert `shot` by path: an existing shot with the same path is replaced in
    /// place and made active; a new path is appended and made active. Returns
    /// `true` if the *active clip path* changed as a result (the caller then
    /// resets the thumb cache + decode pipe, both bound to one clip).
    pub fn upsert(&mut self, shot: Shot) -> bool {
        let before = self.active_path();
        match self.shots.iter().position(|s| s.path == shot.path) {
            Some(i) => {
                self.shots[i] = shot;
                self.active = i;
            }
            None => {
                self.shots.push(shot);
                self.active = self.shots.len() - 1;
            }
        }
        self.active_path() != before
    }

    /// Make shot `index` active. Errors if out of range.
    pub fn set_active(&mut self, index: usize) -> Result<(), String> {
        if index >= self.shots.len() {
            return Err(format!(
                "shot index {index} out of range (session has {} shot(s))",
                self.shots.len()
            ));
        }
        self.active = index;
        Ok(())
    }

    /// Remove shot `index`. The active index clamps toward 0 so it keeps
    /// pointing at the same shot where possible. Returns the new active shot, or
    /// `None` when the session is now empty.
    pub fn remove(&mut self, index: usize) -> Result<Option<Shot>, String> {
        if index >= self.shots.len() {
            return Err(format!(
                "shot index {index} out of range (session has {} shot(s))",
                self.shots.len()
            ));
        }
        self.shots.remove(index);
        if self.shots.is_empty() {
            self.active = 0;
            return Ok(None);
        }
        if index < self.active || self.active >= self.shots.len() {
            self.active = self.active.saturating_sub(1).min(self.shots.len() - 1);
        }
        Ok(self.shots.get(self.active).cloned())
    }
}

static SESSION: Lazy<Mutex<Session>> = Lazy::new(|| Mutex::new(Session::default()));

fn lock() -> std::sync::MutexGuard<'static, Session> {
    SESSION.lock().unwrap_or_else(|e| e.into_inner())
}

// --------------------------------------------------------------------------- //
// loaded project (D-037) — the saved `<name>.chroma` the session came from
// --------------------------------------------------------------------------- //

/// The project the current session was opened from. `None` = an in-memory
/// "Untitled" session (a loose clip via the file picker / MCP `open`), which
/// still seeks / plays / exports / tracks — it just has nowhere to auto-save.
#[derive(Debug, Clone)]
pub struct ProjectRef {
    /// the `<name>.chroma` directory
    pub path: PathBuf,
    pub name: String,
}

static PROJECT: Lazy<Mutex<Option<ProjectRef>>> = Lazy::new(|| Mutex::new(None));

/// Bind (or clear) the loaded project so `chroma_project_save` knows where to
/// write. Set on open / new / relink; cleared only on an explicit close.
pub fn set_project(p: Option<ProjectRef>) {
    *PROJECT.lock().unwrap_or_else(|e| e.into_inner()) = p;
}

/// The loaded project, if the session came from one.
pub fn current_project() -> Option<ProjectRef> {
    PROJECT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Set / replace the loaded clip. `Some(shot)` upserts it into the session by
/// path (a fresh open of a new clip appends a shot; a seek / re-open of a clip
/// already in the session updates it in place). `None` clears the whole session.
///
/// A change of *active clip path* invalidates the thumbnail strip and the
/// persistent playback decode pipe (D-030) — both are bound to one clip.
pub fn set_current_video(v: Option<CurrentVideo>) {
    let mut s = lock();
    let path_changed = match v {
        None => {
            if s.shots.is_empty() {
                false
            } else {
                *s = Session::default();
                true
            }
        }
        Some(shot) => s.upsert(shot),
    };
    if path_changed {
        *THUMB_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
        super::decode_pipe::reset();
    }
}

/// The active shot's clip. Every legacy caller uses this — it is unchanged from
/// the single-clip days, it just reads `session.shots[session.active]` now.
pub fn current_video() -> Option<CurrentVideo> {
    lock().active_shot().cloned()
}

/// Point the active shot's "currently decoded frame" marker at `frame` without
/// touching the clip. The video export loop (`chroma::export`) walks this per
/// frame so `chroma::mask::tracked_full_mask` (D-019) fetches the matching matte
/// PNG. The GUI transport uses `chroma_seek` (which also re-decodes) — this is
/// the no-decode setter for a caller that already holds the pixels.
pub fn set_current_frame(frame: u64) {
    let mut s = lock();
    let a = s.active;
    if let Some(cv) = s.shots.get_mut(a) {
        cv.frame = frame;
    }
}

// --------------------------------------------------------------------------- //
// session API (D-033) — thin wrappers over `Session` + cache invalidation
// --------------------------------------------------------------------------- //

/// `(shots, active index)` — a clone for the `chroma_session_list` command.
pub fn session_shots() -> (Vec<Shot>, usize) {
    let s = lock();
    (s.shots.clone(), s.active)
}

/// Make shot `index` active. Resets the thumb cache + decode pipe if the active
/// clip path changed. Returns the now-active shot.
pub fn session_set_active(index: usize) -> Result<Shot, String> {
    let mut s = lock();
    let before = s.active_path();
    s.set_active(index)?;
    let shot = s.shots[index].clone();
    let changed = before.as_deref() != Some(shot.path.as_path());
    drop(s);
    if changed {
        *THUMB_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
        super::decode_pipe::reset();
    }
    Ok(shot)
}

/// Remove shot `index`. Returns the new active shot (`None` if the session is
/// now empty). Resets the thumb cache + decode pipe if the active clip changed.
pub fn session_remove(index: usize) -> Result<Option<Shot>, String> {
    let mut s = lock();
    let before = s.active_path();
    let now_active = s.remove(index)?;
    let after = s.active_path();
    drop(s);
    if before != after {
        *THUMB_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
        super::decode_pipe::reset();
    }
    Ok(now_active)
}

/// `(video path, requested count, data-url strings)` — the timeline strip, decoded once.
type ThumbStrip = (PathBuf, u32, Vec<(u64, String)>);
static THUMB_CACHE: Lazy<Mutex<Option<ThumbStrip>>> = Lazy::new(|| Mutex::new(None));

pub fn cached_thumbs(path: &PathBuf, count: u32) -> Option<Vec<(u64, String)>> {
    let t = THUMB_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    match &*t {
        Some((p, c, v)) if p == path && *c == count => Some(v.clone()),
        _ => None,
    }
}

pub fn store_thumbs(path: PathBuf, count: u32, thumbs: Vec<(u64, String)>) {
    *THUMB_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((path, count, thumbs));
}

// Tracked-matte lookup is now stateless: the sub-mask stores its `/track` cache
// dir in `params.chromaTrackDir`, and `chroma::mask::tracked_full_mask` reads
// `<dir>/<current_frame>.png` at render time. No session map to keep in sync.

// --------------------------------------------------------------------------- //
// tests — the pure `Session` model (no video I/O, parallel-safe)
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> VideoInfo {
        VideoInfo {
            resolution: chroma_types::Resolution::new(1920, 1080),
            fps_num: 24,
            fps_den: 1,
            duration_secs: 10.0,
            frame_count: 240,
            codec: "h264".into(),
            pix_fmt: "yuv420p".into(),
            color_primaries: "bt709".into(),
            color_transfer: "bt709".into(),
            color_space: "bt709".into(),
            has_audio: false,
            audio_sample_rate: 0,
            audio_channels: 0,
        }
    }

    fn shot(name: &str, frame: u64) -> Shot {
        Shot { path: PathBuf::from(format!("/clips/{name}.mov")), info: info(), frame }
    }

    #[test]
    fn single_shot_upsert_is_the_only_shot_and_active() {
        let mut s = Session::default();
        assert!(s.upsert(shot("A", 0))); // 0 -> 1 shot, path appears => changed
        assert_eq!(s.shots.len(), 1);
        assert_eq!(s.active, 0);
        assert_eq!(s.active_shot().unwrap().path, PathBuf::from("/clips/A.mov"));

        // a seek on the same clip: upsert in place, NOT a path change
        assert!(!s.upsert(shot("A", 120)));
        assert_eq!(s.shots.len(), 1);
        assert_eq!(s.active_shot().unwrap().frame, 120);
    }

    #[test]
    fn add_list_set_active_remove() {
        let mut s = Session::default();
        s.upsert(shot("A", 0));
        assert!(s.upsert(shot("B", 0))); // append -> active moves to B
        assert!(s.upsert(shot("C", 0)));
        assert_eq!(s.shots.len(), 3);
        assert_eq!(s.active, 2);

        s.set_active(0).unwrap();
        assert_eq!(s.active_shot().unwrap().path, PathBuf::from("/clips/A.mov"));
        assert!(s.set_active(9).is_err());

        // remove a shot before the active one -> active shifts to stay on B
        s.set_active(1).unwrap(); // B
        let now = s.remove(0).unwrap().unwrap(); // drop A
        assert_eq!(now.path, PathBuf::from("/clips/B.mov"));
        assert_eq!(s.shots.len(), 2);
        assert_eq!(s.active, 0);

        // remove the active shot -> clamps onto the next
        let now = s.remove(0).unwrap().unwrap();
        assert_eq!(now.path, PathBuf::from("/clips/C.mov"));

        // remove the last -> empty session
        assert!(s.remove(0).unwrap().is_none());
        assert!(s.remove(0).is_err());
    }

    #[test]
    fn upsert_of_existing_path_switches_active_and_reports_change() {
        let mut s = Session::default();
        s.upsert(shot("A", 0));
        s.upsert(shot("B", 0)); // active = B
        // re-open A (still in the session): active flips back to A => changed
        assert!(s.upsert(shot("A", 0)));
        assert_eq!(s.active, 0);
        // upsert B again while B is not active => changed
        assert!(s.upsert(shot("B", 30)));
        assert_eq!(s.active, 1);
        assert_eq!(s.active_shot().unwrap().frame, 30);
    }

    #[test]
    fn active_shot_change_busts_the_thumb_cache() {
        // exercises the module-global wrapper (not just the pure model): a
        // path-changing upsert must drop the thumb strip, which is bound to one
        // clip. Paths are unique to this test so a parallel export test (also a
        // `set_current_video` caller) can only ever *also* bust the cache, never
        // repopulate it (nothing but `chroma_frame_thumbnails` calls store_thumbs).
        let a = PathBuf::from("/thumbtest/A-unique.mov");
        let b = PathBuf::from("/thumbtest/B-unique.mov");
        set_current_video(Some(Shot { path: a.clone(), info: info(), frame: 0 }));
        store_thumbs(a.clone(), 48, vec![(0, "data:,x".into())]);
        assert!(cached_thumbs(&a, 48).is_some());

        set_current_video(Some(Shot { path: b.clone(), info: info(), frame: 0 }));
        assert!(cached_thumbs(&a, 48).is_none(), "switching shots must bust the thumb cache");
    }

    #[test]
    fn remove_after_active_does_not_move_active() {
        let mut s = Session::default();
        s.upsert(shot("A", 0));
        s.upsert(shot("B", 0));
        s.upsert(shot("C", 0));
        s.set_active(1).unwrap(); // B
        s.remove(2).unwrap(); // drop C (after active)
        assert_eq!(s.active_shot().unwrap().path, PathBuf::from("/clips/B.mov"));
    }
}
