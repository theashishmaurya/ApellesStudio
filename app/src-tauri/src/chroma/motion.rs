//! motion.rs — the Motion tab bridge (D-039 roadmap "Motion tab MVP", D-046).
//!
//! What it is: Tauri commands for the Motion tab — persist the current
//!   project's one scene manifest to a sidecar file
//!   (`<project>.chroma/motion/manifest.json`, the same "path-addressed
//!   sidecar" convention `grade.rs` uses for each shot's `grade.json`) and
//!   drive a real render through the `chroma-motion` crate
//!   (→ `npx remotion render` in `packages/motion-engine`).
//! What it does: `chroma_motion_get_manifest` / `chroma_motion_save_manifest`
//!   read/write that sidecar for the currently open project, resolved via
//!   `state::current_project()` — the same source `edit.rs`'s
//!   `current_project_dir()` reads. `chroma_motion_render` resolves
//!   `packages/motion-engine` relative to this crate's own source location
//!   and calls `chroma_motion::run_render` on a blocking thread, returning
//!   once the render finishes (no progress reporting this pass).
//!   **D-259** — `chroma_motion_render` additionally makes the rest of the app
//!   see the new file: it renders to a staging sibling and `rename`s it onto
//!   the destination (atomic replace — nothing ever reads half a video, see
//!   [`staging_path`]), then drops any live decode pipe still holding the old
//!   inode open. That plus the pool reconcile the frontend does next
//!   (`chroma_media_refresh`) is what makes "re-render a scene and the clip
//!   already on the Edit timeline updates" true without a live embedded
//!   renderer. It still does NOT know about the media pool or the timeline —
//!   the provenance stamp and the clip refresh are the app layer's
//!   (`app/src/Root.tsx`), same D-062 layering.
//! What it does NOT do: no manifest schema validation — the frontend
//!   validates against the `zod` schema in
//!   `packages/motion-engine/src/engine/schema.ts` before ever calling
//!   save/render (see D-046). No `ProjectManifest` field: a sidecar file, not
//!   a `project.json` field, specifically to avoid touching the
//!   heavily-in-flight `project.rs` — see the D-046 decision. No multi-manifest
//!   / scene management — one manifest per project, this pass's scope.
//!
//! Fork hygiene (D-003): all new code. Upstream footprint is `pub mod motion;`
//! in `chroma/mod.rs` + the `generate_handler!` lines in `lib.rs`.

use std::path::{Path, PathBuf};

use serde_json::Value;

use chroma_motion::RenderRequest;

use super::state;

fn current_project_dir() -> Result<PathBuf, String> {
    state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — open one in the Colorist tab".to_string())
}

/// `<project>.chroma/motion/manifest.json` — the one scene manifest the
/// Motion tab edits for this project (D-046: singular, "one manifest per
/// project" per this pass's scope; multi-manifest is deferred).
fn manifest_path(project_dir: &Path) -> PathBuf {
    project_dir.join("motion").join("manifest.json")
}

/// `packages/motion-engine`, resolved from this crate's own compile-time
/// location (`app/src-tauri` → `../../packages/motion-engine`) rather than a
/// runtime guess. Correct for `npm run tauri:dev`; a packaged build bundling
/// (or downloading) the engine separately is a later step — the engine is a
/// dev-time Node project today, not shipped in the app bundle (D-046).
fn engine_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("packages")
        .join("motion-engine")
}

/// The current project's saved motion manifest, or `null` if none has been
/// saved yet (a fresh project — the tab falls back to the engine's own
/// sample manifest in that case).
#[tauri::command]
pub fn chroma_motion_get_manifest() -> Result<Option<Value>, String> {
    let dir = current_project_dir()?;
    let path = manifest_path(&dir);
    if !path.is_file() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Persist `manifest` as the current project's motion manifest. The caller
/// (the Motion tab) has already validated it against the engine's `zod`
/// schema — this only pretty-prints and writes.
#[tauri::command]
pub fn chroma_motion_save_manifest(manifest: Value) -> Result<String, String> {
    let dir = current_project_dir()?;
    let path = manifest_path(&dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let pretty = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{pretty}\n"))
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionRenderResult {
    pub output_path: String,
    pub stdout_tail: String,
}

// NOTE (D-259): the `From<RenderOutcome>` conversion this type used to carry is
// gone on purpose. `RenderOutcome::output_path` is now the STAGING path — where
// the render wrote — and this type's `output_path` is the destination it was
// renamed onto. Those are two different files, so a blanket conversion between
// them could only ever report the wrong one; the command builds the result
// explicitly, after the rename, instead.

/// D-259 — where a render actually writes before it becomes the real output:
/// a fixed sibling of the destination, `<name>.rendering.mp4`.
///
/// **This is the whole answer to "is overwriting a file mid-project safe?"**
/// A re-render of a scene already placed on the Edit timeline replaces a file
/// that other things may be reading *right now* — the preview's decode pipe (a
/// live `ffmpeg` process), and an export job whose argv was frozen at enqueue
/// time (D-198) and which may be part-way through reading it. Writing the new
/// video over the old bytes in place gives both of them a torn file. Rendering
/// beside it and finishing with [`std::fs::rename`] does not: `rename(2)` over
/// an existing path on one filesystem is atomic, so a reader either has the
/// complete old file (its handle keeps the now-unlinked inode alive and intact
/// to EOF) or opens the complete new one. There is no state in which anything
/// observes half a video.
///
/// A **fixed** temp name, not a timestamped or random one, because
/// `CLAUDE.md`'s render-path invariant forbids wall-clock and un-seeded inputs
/// and this names a real file; concurrent renders are already excluded by
/// D-046's "one render at a time". A crashed render leaves this file behind and
/// the next render of the same scene overwrites it, which is why it is
/// `.rendering.mp4` rather than a hidden dotfile — a leftover should be
/// legible, not mysterious.
fn staging_path(output: &Path) -> PathBuf {
    let stem = output
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "render".to_string());
    let ext = output
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_else(|| "mp4".to_string());
    output.with_file_name(format!("{stem}.rendering.{ext}"))
}

/// `<project>.chroma/motion/render.mp4` — the default whole-manifest render
/// destination when the caller doesn't name one AND doesn't name a scene
/// (`scene_id: None`). A single fixed name (not timestamped): this pass is
/// "one manifest per project", so a render at a well-known path
/// re-render/overwrites is the right default; a save-dialog / render history
/// is a later step.
///
/// D-180 — with a `scene_id`, the default instead becomes
/// `<project>.chroma/motion/renders/<scene_id>.mp4`: the frontend's own
/// per-scene export loop (`packages/motion/src/useMotionManifest.ts`'s
/// `render()`) passes the scene id but never a full path, so this is the ONE
/// place project-relative render paths get computed — kept here (not the
/// frontend) since only this side actually knows where the project lives
/// (`current_project_dir`/`state::current_project`).
fn default_output_path(project_dir: &Path, scene_id: Option<&str>) -> PathBuf {
    match scene_id {
        Some(id) => project_dir
            .join("motion")
            .join("renders")
            .join(format!("{id}.mp4")),
        None => project_dir.join("motion").join("render.mp4"),
    }
}

/// Render the current project's saved manifest via `npx remotion render`
/// (the `chroma-motion` crate), to `output_path` or, if `None`,
/// [`default_output_path`]. The manifest must already be saved
/// (`chroma_motion_save_manifest`) before calling this. Blocks on a
/// background thread until the render finishes — no progress reporting, one
/// render at a time (D-046).
///
/// D-180 — `frame_range`, an inclusive `(start, end)` ABSOLUTE composition
/// frame range, renders only that sub-range (`RenderRequest::with_frame_range`
/// → Remotion's own `--frames=start-end`) instead of the whole manifest.
/// `scene_id`, when given (and `output_path` is `None`), picks
/// [`default_output_path`]'s per-scene naming. This command stays
/// manifest-shape agnostic exactly as its own module doc comment already
/// promises — it never computes a scene's own frame range itself; the
/// frontend (`packages/motion/src/useMotionManifest.ts`'s `render()`, which
/// already owns `sceneStartFrame`/`sceneDurationFrames`) works it out and
/// passes the two numbers straight through. Both `None` renders every frame
/// to the single whole-manifest default path, unchanged from this command's
/// pre-D-180 behavior.
#[tauri::command]
pub async fn chroma_motion_render(
    output_path: Option<String>,
    frame_range: Option<(u32, u32)>,
    scene_id: Option<String>,
) -> Result<MotionRenderResult, String> {
    let dir = current_project_dir()?;
    let manifest = manifest_path(&dir);
    if !manifest.is_file() {
        return Err("no motion manifest saved for this project yet".to_string());
    }
    let out = output_path
        .map(PathBuf::from)
        .unwrap_or_else(|| default_output_path(&dir, scene_id.as_deref()));
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    // D-259 — render beside the destination, then rename onto it. See
    // `staging_path`'s own doc for why an in-place overwrite is not safe here
    // and a rename is.
    let staging = staging_path(&out);
    let mut req = RenderRequest::new(engine_dir(), manifest, staging.clone());
    if let Some((start, end)) = frame_range {
        req = req.with_frame_range(start, end);
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || chroma_motion::run_render(&req))
        .await
        .map_err(|e| format!("render task panicked: {e}"))?
        .map_err(|e| e.to_string())?;

    std::fs::rename(&staging, &out).map_err(|e| {
        // Leave the staged file where it is: it is a complete, correct render
        // and the previous output is still intact, so the recoverable state is
        // the one worth reporting.
        format!(
            "rendered to {} but could not move it onto {}: {e}",
            staging.display(),
            out.display()
        )
    })?;

    // D-259 — the one cache in this workspace that a replaced file does NOT
    // invalidate on its own: a decode pipe is a live `ffmpeg` process holding
    // the old (now unlinked) inode open, and it respawns on a change of path,
    // never of content. Everything else derived from this file — the probe, the
    // filmstrip chunks, the waveform peaks — is `blake3(path ‖ mtime ‖ len)`-
    // keyed (D-128) and re-reads by itself. See
    // `chroma_media::decode_pipe::drop_pipes_for_path`.
    let dropped = chroma_media::decode_pipe::drop_pipes_for_path(&out);
    if dropped > 0 {
        log::info!(
            "[chroma::motion] re-render of {} — dropped {dropped} live decode pipe(s) on it",
            out.display()
        );
    }

    Ok(MotionRenderResult {
        output_path: out.to_string_lossy().to_string(),
        stdout_tail: outcome.stdout_tail,
    })
}

/// D-259 — the end-to-end claim, checked through the real preview compositor:
/// **re-rendering a Motion scene changes what an already-placed Edit clip
/// shows.**
///
/// The Remotion render itself is not exercised (it is `npx remotion render`, a
/// Node toolchain, not something a unit test may depend on). What IS exercised
/// is every step this decision actually built: the staging → `rename` replace,
/// the decode-pipe invalidation, the pool reconcile, and the preview reading
/// the new pixels. `ffmpeg` stands in for Remotion as the thing that writes the
/// file, exactly as the preview tests in `chroma::edit` already do.
#[cfg(test)]
mod motion_relink_tests {
    use std::path::{Path, PathBuf};

    use chroma_timeline::{Clip, Timeline, Track, TrackKind};

    use super::super::PROJECT_STATE_LOCK;

    const W: u32 = 160;
    const H: u32 = 90;
    const SCENE_ID: &str = "hook";

    fn have_ffmpeg() -> bool {
        std::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    /// A flat, solid-colour clip — `ffmpeg` standing in for a Remotion render
    /// of a one-colour scene. Solid so a single sampled pixel is the whole
    /// assertion, and 2 s so several frames exist to read without restarting a
    /// pipe.
    fn solid_clip(path: &Path, colour: &str, secs: u32) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir render dir");
        }
        let ok = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                &format!("color={colour}:size={W}x{H}:rate=24:duration={secs}"),
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn ffmpeg");
        assert!(ok.success(), "generating the {colour} fixture failed");
    }

    fn empty_manifest() -> super::super::project::ProjectManifest {
        super::super::project::ProjectManifest {
            schema: "chroma.project/1".into(),
            name: "Motion".into(),
            created: String::new(),
            modified: String::new(),
            shots: Vec::new(),
            active_shot: 0,
            active_clip_id: None,
            settings: super::super::project::ProjectSettings {
                width: Some(W),
                height: Some(H),
                ..Default::default()
            },
            timelines: Vec::new(),
            active_timeline: 0,
            media: Vec::new(),
            folders: Vec::new(),
        }
    }

    /// A project whose one timeline holds one clip reading `render`, with that
    /// file in the media pool stamped as scene `SCENE_ID`'s render — i.e. the
    /// exact state after "render a scene, then place it on the Edit timeline."
    fn open_project_with_placed_render(dir: &Path, render: &Path) {
        let mut manifest = empty_manifest();
        manifest.timelines = vec![Timeline {
            id: "tl1".into(),
            name: "Motion".into(),
            rate: None,
            tracks: vec![Track {
                kind: TrackKind::Video,
                clips: vec![Clip {
                    id: "placed".into(),
                    name: "hook.mp4".into(),
                    source_path: render.to_string_lossy().into_owned(),
                    source_start: 0,
                    duration: 48,
                    source_len: 48,
                    start_frame: 0,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            markers: Vec::new(),
        }];
        // The pool half, through the real reconcile — this is what stamps the
        // provenance and probes the file.
        let (items, _) = super::super::project::refresh_media(
            &mut manifest,
            &[render.to_string_lossy().into_owned()],
            Some(SCENE_ID),
        );
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].motion_scene_id.as_deref(), Some(SCENE_ID));
        manifest.timelines[0].tracks[0].clips[0].media_id = Some(items[0].id.clone());
        super::super::project::save_manifest(dir, &manifest).expect("save manifest");
        super::super::state::set_project(Some(super::super::state::ProjectRef {
            path: dir.to_path_buf(),
            name: "Motion".into(),
        }));
    }

    /// The mid-frame pixel of the real preview frame the Edit tab would show.
    fn preview_pixel(frame: u64) -> [u8; 3] {
        let jpeg = super::super::edit::timeline_frame(frame, Some(W)).expect("preview frame");
        let img = image::load_from_memory(&jpeg)
            .expect("decode jpeg")
            .to_rgb8();
        let p = img.get_pixel(W / 2, H / 2);
        [p[0], p[1], p[2]]
    }

    fn is_red(p: [u8; 3]) -> bool {
        p[0] > 120 && p[1] < 90 && p[2] < 90
    }

    fn is_blue(p: [u8; 3]) -> bool {
        p[2] > 120 && p[0] < 90 && p[1] < 90
    }

    /// Everything `chroma_motion_render` does around the render itself:
    /// write beside the destination, `rename` onto it, drop live pipes.
    /// `invalidate: false` is the NEGATIVE CONTROL — the same replace with the
    /// one line this decision adds taken out.
    fn re_render(out: &Path, colour: &str, invalidate: bool) {
        let staging = super::staging_path(out);
        solid_clip(&staging, colour, 2);
        std::fs::rename(&staging, out).expect("rename staged render onto the output");
        if invalidate {
            chroma_media::decode_pipe::drop_pipes_for_path(out);
        }
    }

    fn render_path(dir: &Path) -> PathBuf {
        super::default_output_path(dir, Some(SCENE_ID))
    }

    /// THE headline assertion. Frame 1 is read after frame 0 on purpose: a
    /// backward seek would respawn the decode pipe by itself and the test would
    /// pass without the mechanism under test existing at all (see the negative
    /// control below, which is the proof that it would).
    #[test]
    fn a_motion_re_render_changes_an_already_placed_edit_clip() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("Motion.chroma");
        std::fs::create_dir_all(&dir).expect("mkdir project");
        let out = render_path(&dir);

        solid_clip(&out, "red", 2);
        open_project_with_placed_render(&dir, &out);
        chroma_media::decode_pipe::reset();

        let before = preview_pixel(0);
        assert!(
            is_red(before),
            "the placed clip should show the first render, got {before:?}"
        );

        re_render(&out, "blue", true);

        let after = preview_pixel(1);
        assert!(
            is_blue(after),
            "the placed clip should show the RE-render with no re-import and no swap, got {after:?}"
        );
        assert_ne!(
            before, after,
            "the Edit-side picture must actually have changed"
        );
    }

    /// The negative control, in this repo's D-256 style: with the one call this
    /// decision adds removed, the very same sequence leaves the Edit clip
    /// showing the OLD render. That is what proves the test measures the
    /// wiring rather than some incidental respawn.
    ///
    /// It also demonstrates the other half of the atomic-replace argument: the
    /// live `ffmpeg` process keeps reading the old, now-unlinked inode to EOF
    /// and gets a complete, correct old frame — never a torn one.
    #[test]
    fn without_the_pipe_invalidation_the_clip_keeps_showing_the_old_render() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("Motion.chroma");
        std::fs::create_dir_all(&dir).expect("mkdir project");
        let out = render_path(&dir);

        solid_clip(&out, "red", 2);
        open_project_with_placed_render(&dir, &out);
        chroma_media::decode_pipe::reset();

        assert!(is_red(preview_pixel(0)));
        re_render(&out, "blue", false);
        let after = preview_pixel(1);
        assert!(
            is_red(after),
            "without dropping the pipe the old inode is still being read — got {after:?}"
        );
    }

    /// The pool half: a re-render updates the item's probed facts, the stamp is
    /// idempotent, and an unchanged file writes nothing.
    #[test]
    fn the_pool_item_is_re_probed_and_keeps_its_scene_stamp() {
        if !have_ffmpeg() {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let _guard = PROJECT_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("Motion.chroma");
        std::fs::create_dir_all(&dir).expect("mkdir project");
        let out = render_path(&dir);
        let path = out.to_string_lossy().into_owned();

        solid_clip(&out, "red", 2);
        let mut manifest = empty_manifest();
        let (first, changed) =
            super::super::project::refresh_media(&mut manifest, &[path.clone()], Some(SCENE_ID));
        assert!(changed, "adding an item is a change");
        let id = first[0].id.clone();
        assert_eq!(
            first[0].video.as_ref().expect("probed").frame_count,
            48,
            "2s at 24fps"
        );

        // A LONGER re-render — the case that actually has to reach the clips.
        let staging = super::staging_path(&out);
        solid_clip(&staging, "blue", 4);
        std::fs::rename(&staging, &out).expect("rename");

        let (second, changed) =
            super::super::project::refresh_media(&mut manifest, &[path.clone()], Some(SCENE_ID));
        assert!(changed, "a longer render is a real change to the pool item");
        assert_eq!(
            manifest.media.len(),
            1,
            "refreshed in place, never duplicated"
        );
        assert_eq!(
            second[0].id, id,
            "the pool item keeps its identity across a re-render"
        );
        assert_eq!(second[0].motion_scene_id.as_deref(), Some(SCENE_ID));
        assert_eq!(
            second[0].video.as_ref().expect("probed").frame_count,
            96,
            "4s at 24fps — the re-probe is what makes the new length reach the timeline"
        );

        // Idempotent: reconciling an unchanged file writes nothing.
        let (_, changed) =
            super::super::project::refresh_media(&mut manifest, &[path], Some(SCENE_ID));
        assert!(
            !changed,
            "reconciling an unchanged file must not dirty the manifest"
        );
    }

    /// `staging_path` is a deterministic sibling of the destination — never a
    /// timestamped or random name (CLAUDE.md's render-path invariant), and
    /// never in a temp dir a cleaner could empty mid-render.
    #[test]
    fn the_staging_path_is_a_deterministic_sibling_of_the_output() {
        let out = PathBuf::from("/p/.chroma/motion/renders/hook.mp4");
        let staged = super::staging_path(&out);
        assert_eq!(
            staged,
            PathBuf::from("/p/.chroma/motion/renders/hook.rendering.mp4")
        );
        assert_eq!(
            staged.parent(),
            out.parent(),
            "same directory — so rename is atomic"
        );
        assert_eq!(staged, super::staging_path(&out), "same input, same name");
        assert_ne!(staged, out);
    }
}
