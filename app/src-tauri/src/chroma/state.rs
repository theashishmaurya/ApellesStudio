//! Apelles' own bit of process state, kept out of upstream's `AppState` so the
//! fork diff stays minimal (D-003).
//!
//! **Multi-shot session (D-033).** A grading job is N shots from one shoot. The
//! process now holds a [`Session`] — an ordered `Vec` of [`Shot`]s + which one is
//! *active*. `current_video()` returns the active shot's clip, so every existing
//! caller (`chroma_seek`, `export`, `mask`, `playback`, …) keeps working
//! unchanged. Per-shot grade + activity-feed state lives in the frontend (D-020 /
//! D-032) keyed by shot identity; this module only tracks the shot list, the
//! active index, and each shot's playhead. Still a module global (no `.chroma`
//! project bundle — see D-033); a `.chroma/session.json` path list is a deferred
//! follow-up.
//!
//! **Per-clip shot identity (D-306, B-150).** A shot's identity is its
//! [`ShotId`] — the Edit-timeline `Clip` id when the session came from a real
//! project, the source path when it did not (an Untitled loose-clip session,
//! where a path IS unique). It used to be the source path in *both* cases, and
//! that collapsed two timeline clips of one source file onto a single shot: the
//! second clip was invisible in Colorist and could not be graded at all (B-150),
//! and the session's own index space silently diverged from the timeline's
//! (B-030). Grades on disk have been per-clip since D-070
//! (`<grade_dir>/<clip id>.grade.json`) — this makes the *decode* session agree
//! with them.

use std::path::PathBuf;
use std::sync::Mutex;

use once_cell::sync::Lazy;

use super::video::VideoInfo;

/// What makes a shot *that* shot (D-306, B-150).
///
/// - [`ShotId::Clip`] — the shot is one `apelles_timeline::Clip` on the open
///   project's active timeline, identified by that clip's id. Two clips trimmed
///   from the same source file are two shots, gradeable independently, exactly
///   as the Edit tab and the per-clip grade files already treat them.
/// - [`ShotId::Path`] — an Untitled loose-clip session (file picker / MCP
///   `open`): there is no project, no timeline and therefore no clip, and the
///   source path is already unique per shot. This is the pre-D-306 behaviour,
///   kept verbatim for the case it was always right for.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ShotId {
    Clip(String),
    Path(PathBuf),
}

/// One shot in the session: a clip path, its probe info, and the playhead the
/// transport last left it on. (Type name kept as `CurrentVideo` so the D-015…
/// D-032 call sites don't churn; a `Shot` alias is exported for new code.)
#[derive(Debug, Clone)]
pub struct CurrentVideo {
    pub path: PathBuf,
    pub info: VideoInfo,
    /// frame index currently decoded into `AppState.original_image`
    pub frame: u64,
    /// D-306: the Edit-timeline `Clip` this shot IS, when there is one.
    /// `None` = an Untitled loose-clip session — see [`ShotId`].
    pub clip_id: Option<String>,
}

/// A shot in the multi-shot session (D-033). Alias of [`CurrentVideo`].
pub type Shot = CurrentVideo;

impl CurrentVideo {
    /// This shot's identity (D-306) — the key [`Session`] dedupes, prunes and
    /// resolves by. Never the raw path when a clip id is present.
    pub fn identity(&self) -> ShotId {
        match &self.clip_id {
            Some(id) => ShotId::Clip(id.clone()),
            None => ShotId::Path(self.path.clone()),
        }
    }
}

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

    /// Upsert `shot` by its [`ShotId`] (D-306): an existing shot with the same
    /// identity is replaced in place and made active; a new identity is appended
    /// and made active.
    ///
    /// Returns `true` if the *active clip path* changed as a result (the caller
    /// then resets the decode pipe, which is bound to one clip **file**). Note
    /// the deliberate asymmetry: identity is per-clip, but the decode pipe is
    /// per-file, so switching between two clips of the same source needs no
    /// pipe reset — only a seek.
    pub fn upsert(&mut self, shot: Shot) -> bool {
        let before = self.active_path();
        let key = shot.identity();
        match self.shots.iter().position(|s| s.identity() == key) {
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

    /// D-071: drop every shot whose [`ShotId`] isn't in `keep` — the Edit-tab
    /// timeline resync's cleanup pass, so a clip removed from the timeline
    /// stops lingering forever as a "ghost" shot in the session (nothing
    /// pruned this before; only a full `set_current_video(None)` reset
    /// cleared the whole session at once, on a full project open). Iterates
    /// from the end so each `remove`'s own index stays valid as items drop.
    /// Returns the dropped identities, for the caller's own logging.
    ///
    /// D-306: keyed by identity, not path. Pruning by path would drop *both*
    /// shots of a doubled source file the moment one of the two clips left the
    /// timeline — and keep both when only one should survive.
    pub fn prune_except(&mut self, keep: &std::collections::HashSet<ShotId>) -> Vec<ShotId> {
        let mut dropped = Vec::new();
        let mut i = self.shots.len();
        while i > 0 {
            i -= 1;
            let id = self.shots[i].identity();
            if !keep.contains(&id) {
                dropped.push(id);
                let _ = self.remove(i);
            }
        }
        dropped
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
/// its [`ShotId`] (a fresh open of a new clip appends a shot; a seek / re-open
/// of a shot already in the session updates it in place). `None` clears the
/// whole session.
///
/// D-306: callers that install a frame for a shot the session already holds
/// **must** carry that shot's `clip_id` through, or the upsert appends a second,
/// path-keyed shot alongside the real one instead of updating it. Every such
/// caller goes through `load::install_frame`, which takes the whole
/// [`CurrentVideo`] for exactly that reason.
///
/// A change of *active clip path* invalidates the persistent playback decode
/// pipe (D-030), which is bound to one clip.
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

/// `shots`' index for the shot whose [`ShotId`] is `want` — the one index
/// space [`Session::set_active`]/[`session_set_active`] ever validate against.
///
/// B-030 (path era) and B-150 (D-306): a caller resolving "which clip should be
/// active" must look the target up in the session's own space, never in the raw
/// timeline clip list it built the target from. Before D-306 those two spaces
/// genuinely differed (a repeated source path collapsed into one shot, so every
/// later raw index over-shot); with per-clip identity they now agree for a real
/// project — but resolving through this function is still the correct, checked
/// way to cross between them, because they still differ whenever a clip is
/// *offline* (no session shot at all).
///
/// Pure/testable on purpose — `open_manifest`/the resync path both need this
/// and can't otherwise be unit-tested directly (real `tauri::State` I/O).
pub fn resolve_session_index(shots: &[Shot], want: &ShotId) -> Option<usize> {
    shots.iter().position(|s| &s.identity() == want)
}

/// D-071: drop every session shot whose [`ShotId`] isn't in `keep` — see
/// `Session::prune_except`'s doc for why this exists at all. Resets the
/// decode pipe only if the *active* shot was one of the ones
/// dropped (mirrors `session_set_active`'s own invalidation rule — an
/// unrelated shot disappearing from the list doesn't invalidate anything
/// bound to the still-active one).
pub fn prune_session_except(keep: &std::collections::HashSet<ShotId>) -> Vec<ShotId> {
    let mut s = lock();
    let before = s.active_path();
    let dropped = s.prune_except(keep);
    let changed = s.active_path() != before;
    drop(s);
    if changed {
        super::decode_pipe::reset();
    }
    dropped
}

/// Make shot `index` active. Resets the decode pipe if the active
/// clip path changed. Returns the now-active shot.
pub fn session_set_active(index: usize) -> Result<Shot, String> {
    let mut s = lock();
    let before = s.active_path();
    s.set_active(index)?;
    let shot = s.shots[index].clone();
    let changed = before.as_deref() != Some(shot.path.as_path());
    drop(s);
    if changed {
        super::decode_pipe::reset();
    }
    Ok(shot)
}

/// Remove shot `index`. Returns the new active shot (`None` if the session is
/// now empty). Resets the decode pipe if the active clip changed.
pub fn session_remove(index: usize) -> Result<Option<Shot>, String> {
    let mut s = lock();
    let before = s.active_path();
    let now_active = s.remove(index)?;
    let after = s.active_path();
    drop(s);
    if before != after {
        super::decode_pipe::reset();
    }
    Ok(now_active)
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
            resolution: apelles_types::Resolution::new(1920, 1080),
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

    /// An Untitled-session shot: no clip id, so its identity is its path
    /// (the pre-D-306 model, still exactly right for a loose clip).
    fn shot(name: &str, frame: u64) -> Shot {
        Shot {
            path: PathBuf::from(format!("/clips/{name}.mov")),
            info: info(),
            frame,
            clip_id: None,
        }
    }

    /// A project shot: one Edit-timeline clip `clip_id`, cut from `name.mov`.
    fn clip_shot(name: &str, clip_id: &str, frame: u64) -> Shot {
        Shot {
            path: PathBuf::from(format!("/clips/{name}.mov")),
            info: info(),
            frame,
            clip_id: Some(clip_id.to_string()),
        }
    }

    fn paths(s: &Session) -> Vec<PathBuf> {
        s.shots.iter().map(|sh| sh.path.clone()).collect()
    }

    fn clip_ids(s: &Session) -> Vec<Option<String>> {
        s.shots.iter().map(|sh| sh.clip_id.clone()).collect()
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
    fn remove_after_active_does_not_move_active() {
        let mut s = Session::default();
        s.upsert(shot("A", 0));
        s.upsert(shot("B", 0));
        s.upsert(shot("C", 0));
        s.set_active(1).unwrap(); // B
        s.remove(2).unwrap(); // drop C (after active)
        assert_eq!(s.active_shot().unwrap().path, PathBuf::from("/clips/B.mov"));
    }

    // --- D-306 / B-150: per-clip shot identity ----------------------------

    #[test]
    fn two_clips_of_one_source_file_are_two_independent_shots() {
        // B-150's exact repro, as a unit test: the owner's project has two
        // Edit-timeline clips of `A001_09091123_C024.MOV` (one on Video 1,
        // one on Video 2, different rotation and trim). Before D-306 the
        // second one collapsed onto the first and was invisible in Colorist
        // — `list_shots` returned ONE entry for the file, and there was no
        // way to address, view or grade the other clip at all.
        let mut s = Session::default();
        s.upsert(clip_shot("C024", "clip-video1", 131));
        s.upsert(clip_shot("C024", "clip-video2", 131));

        assert_eq!(s.shots.len(), 2, "two clips of one file must be two shots");
        assert_eq!(
            paths(&s),
            vec![
                PathBuf::from("/clips/C024.mov"),
                PathBuf::from("/clips/C024.mov")
            ],
            "both shots still point at the same source file"
        );
        assert_eq!(
            clip_ids(&s),
            vec![Some("clip-video1".into()), Some("clip-video2".into())],
            "…and are told apart by clip id, not by path"
        );
        // the second one is addressable in its own right
        assert_eq!(
            resolve_session_index(&s.shots, &ShotId::Clip("clip-video2".into())),
            Some(1)
        );
        assert!(s.set_active(1).is_ok());
        assert_eq!(
            s.active_shot().unwrap().clip_id.as_deref(),
            Some("clip-video2")
        );
    }

    #[test]
    fn re_upserting_the_same_clip_updates_it_in_place() {
        // The seek / re-install path: same clip id, new playhead. Must NOT
        // append a second shot, and (same file) must not report a path change.
        let mut s = Session::default();
        s.upsert(clip_shot("C024", "clip-video1", 0));
        s.upsert(clip_shot("C024", "clip-video2", 0));
        assert!(!s.upsert(clip_shot("C024", "clip-video2", 900)));
        assert_eq!(s.shots.len(), 2);
        assert_eq!(s.active_shot().unwrap().frame, 900);
    }

    #[test]
    fn switching_between_two_clips_of_one_file_is_not_a_path_change() {
        // Identity is per-clip; the decode pipe is per-FILE. Flipping between
        // two clips cut from the same source must not report a path change
        // (which is what triggers a pipe reset) — only a seek is needed.
        let mut s = Session::default();
        s.upsert(clip_shot("C024", "clip-video1", 0));
        assert!(
            !s.upsert(clip_shot("C024", "clip-video2", 0)),
            "same file ⇒ no decode-pipe invalidation"
        );
        // a genuinely different file does report the change
        assert!(s.upsert(clip_shot("C030", "clip-c030", 0)));
    }

    #[test]
    fn a_clip_id_shot_and_a_path_shot_of_one_file_do_not_collide() {
        // Mixed identities never merge: an Untitled loose-clip shot keyed by
        // path is not the same thing as a timeline clip that happens to read
        // the same file.
        let mut s = Session::default();
        s.upsert(shot("C024", 0)); // no clip id — path identity
        s.upsert(clip_shot("C024", "clip-video1", 0));
        assert_eq!(s.shots.len(), 2);
        assert_eq!(
            resolve_session_index(&s.shots, &ShotId::Path(PathBuf::from("/clips/C024.mov"))),
            Some(0)
        );
        assert_eq!(
            resolve_session_index(&s.shots, &ShotId::Clip("clip-video1".into())),
            Some(1)
        );
    }

    // --- D-071: prune_except (the Edit-tab timeline resync's cleanup) -----

    fn path_ids<const N: usize>(names: [&str; N]) -> std::collections::HashSet<ShotId> {
        names
            .into_iter()
            .map(|n| ShotId::Path(PathBuf::from(format!("/clips/{n}.mov"))))
            .collect()
    }

    #[test]
    fn prune_except_drops_only_shots_outside_keep() {
        let mut s = Session::default();
        s.upsert(shot("A", 0));
        s.upsert(shot("B", 0));
        s.upsert(shot("C", 0));
        let dropped = s.prune_except(&path_ids(["A", "C"]));
        assert_eq!(dropped, vec![ShotId::Path(PathBuf::from("/clips/B.mov"))]);
        let remaining = paths(&s);
        assert_eq!(remaining.len(), 2);
        assert!(remaining.contains(&PathBuf::from("/clips/A.mov")));
        assert!(remaining.contains(&PathBuf::from("/clips/C.mov")));
    }

    #[test]
    fn prune_except_keeps_the_active_shot_active_when_it_survives() {
        let mut s = Session::default();
        s.upsert(shot("A", 0));
        s.upsert(shot("B", 0));
        s.upsert(shot("C", 0));
        s.set_active(1).unwrap(); // B
        s.prune_except(&path_ids(["A", "B"])); // drops C, which is after the active index
        assert_eq!(s.active_shot().unwrap().path, PathBuf::from("/clips/B.mov"));
    }

    #[test]
    fn prune_except_is_a_real_no_op_when_everything_is_kept() {
        let mut s = Session::default();
        s.upsert(shot("A", 0));
        s.upsert(shot("B", 0));
        s.set_active(1).unwrap();
        let dropped = s.prune_except(&path_ids(["A", "B"]));
        assert!(dropped.is_empty());
        assert_eq!(s.shots.len(), 2);
        assert_eq!(s.active_shot().unwrap().path, PathBuf::from("/clips/B.mov"));
    }

    #[test]
    fn prune_except_drops_one_of_two_clips_sharing_a_source_file() {
        // D-306's real point for the resync path: deleting ONE of two clips of
        // the same file from the Edit timeline must drop exactly that shot.
        // Pruning by path could only ever drop both or neither.
        let mut s = Session::default();
        s.upsert(clip_shot("C024", "clip-video1", 0));
        s.upsert(clip_shot("C024", "clip-video2", 0));
        s.upsert(clip_shot("C030", "clip-c030", 0));
        let keep: std::collections::HashSet<ShotId> = [
            ShotId::Clip("clip-video1".into()),
            ShotId::Clip("clip-c030".into()),
        ]
        .into();
        let dropped = s.prune_except(&keep);
        assert_eq!(dropped, vec![ShotId::Clip("clip-video2".into())]);
        assert_eq!(
            clip_ids(&s),
            vec![Some("clip-video1".into()), Some("clip-c030".into())]
        );
    }

    #[test]
    fn resolve_session_index_crosses_from_the_timeline_space_to_the_session_space() {
        // The B-030 guard, restated for D-306. `clips` is the timeline's own
        // per-clip list; the session holds a shot per ONLINE clip. An offline
        // clip has no shot, so the two index spaces still differ and a caller
        // must resolve through this helper rather than reuse a raw index.
        let mut s = Session::default();
        s.upsert(clip_shot("C024", "clip-a", 0)); // timeline index 0, session index 0
        // timeline index 1 ("clip-offline") is offline: never registered
        s.upsert(clip_shot("C030", "clip-c", 0)); // timeline index 2, session index 1

        assert_eq!(
            resolve_session_index(&s.shots, &ShotId::Clip("clip-c".into())),
            Some(1),
            "must be the session's index (1), not the timeline's (2)"
        );
        // and the found index is real: set_active only ever validates against
        // this same space, so feeding it the helper's answer must not error.
        assert!(s.set_active(1).is_ok());

        // a clip that was never registered resolves to None, not a stale guess
        // — the caller (open_manifest) already `.unwrap_or(0)`s this.
        assert_eq!(
            resolve_session_index(&s.shots, &ShotId::Clip("clip-offline".into())),
            None
        );
    }

    #[test]
    fn resolve_session_index_also_addresses_an_untitled_sessions_shots_by_path() {
        // An Untitled session's shots have no clip id, so their identity IS
        // their path — the same helper, the other `ShotId` variant.
        let mut s = Session::default();
        s.upsert(shot("A", 0));
        s.upsert(shot("C", 0));
        assert_eq!(
            resolve_session_index(&s.shots, &ShotId::Path(PathBuf::from("/clips/C.mov"))),
            Some(1)
        );
        assert_eq!(
            resolve_session_index(&s.shots, &ShotId::Path(PathBuf::from("/clips/nope.mov"))),
            None
        );
    }

    // `prune_session_except` itself (the module-level wrapper around the
    // static global `SESSION`) is intentionally not unit-tested here — every
    // other test in this file operates on a local `Session::default()`
    // specifically to stay parallel-test-safe against that global, and this
    // module has no existing lock for tests that need to touch it for real
    // (unlike `project.rs`'s `PROJECT_STATE_LOCK`). The wrapper itself is a
    // thin lock+call+cache-invalidate pass-through over `prune_except`,
    // which is fully covered above; real end-to-end coverage of the whole
    // resync path (including this wrapper) lives in `project.rs`'s
    // `chroma_project_resync_clips` integration test instead.
}
