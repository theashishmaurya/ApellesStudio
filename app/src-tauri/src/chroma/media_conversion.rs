//! **The app's half of optimized media (D-453): which sources a project asks
//! to convert, when, the GUI's progress event and the cancel command.**
//!
//! What it is: the thin layer between `apelles_media::optimized_media` (the
//! conversion, its queue and its state) and the app: the project, its media
//! pool, Tauri.
//!
//! What it does:
//! - [`install`] binds the no-project folder and forwards every change of a
//!   conversion's state or progress to the webview as
//!   [`CONVERSION_EVENT`] (`{ sourcePath, conversion }`), which the media pool
//!   store (`@apelles/bridge`'s `useMediaPoolStore`) applies to its items.
//! - [`convert_project_sources`] asks for every video source a project holds —
//!   its pool and its timelines' clips — to be converted if the media engine
//!   cannot open it, and prunes converted files nothing maps to any more. Run
//!   on project open (so an existing project whose sources need converting is
//!   converted then, with the same progress UI) and on import.
//! - [`chroma_media_cancel_conversion`] — the Sources panel's Cancel and
//!   `editor_cancel_media_conversion`'s command: cancel by pool item id.
//!
//! What it does NOT do: convert anything itself, or decide where converted
//! files live (`optimized_media`), or rewrite a project: clips and pool items
//! keep naming the original file, and the decode maps it.

use std::path::{Path, PathBuf};

use apelles_media::optimized_media::{self, ConversionStatus};
use apelles_project::ProjectManifest;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The event every conversion progress or state change is sent as.
pub const CONVERSION_EVENT: &str = "chroma://media-conversion";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConversionEvent<'a> {
    source_path: String,
    conversion: &'a ConversionStatus,
}

/// Bind the app cache's optimized-media folder and the progress event. Called
/// once from `setup`.
pub fn install(app: &AppHandle, app_cache_dir: &Path) {
    optimized_media::init(app_cache_dir);
    let app = app.clone();
    optimized_media::set_listener(move |source, conversion| {
        let event = ConversionEvent {
            source_path: source.to_string_lossy().into_owned(),
            conversion,
        };
        if let Err(e) = app.emit(CONVERSION_EVENT, &event) {
            log::debug!("[chroma::media_conversion] emit: {e}");
        }
    });
}

/// Every video source `manifest` holds that has a picture: its pool's video
/// items (an audio-only source has nothing to convert) and every clip on every
/// timeline (a clip placed before the pool existed may not be in it).
fn video_sources(manifest: &ProjectManifest) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let pool = manifest
        .media
        .iter()
        .filter(|m| m.video.as_ref().is_some_and(|v| v.resolution.width > 0))
        .map(|m| m.source_path.as_str());
    let clips = manifest
        .timelines
        .iter()
        .flat_map(|t| t.tracks.iter())
        .flat_map(|t| t.clips.iter())
        .filter(|c| c.text.is_none() && !c.is_adjustment())
        .map(|c| c.source_path.as_str());
    pool.chain(clips)
        .filter(|p| !p.is_empty() && seen.insert(*p))
        .map(PathBuf::from)
        .filter(|p| optimized_media::needs_conversion(p))
        .collect()
}

/// Ask for every source in `manifest` the media engine cannot open to be
/// converted (those already converted, queued, running, failed or cancelled
/// this session are left alone: a cancel holds until a re-probe), and
/// remove converted files no source maps to any more. Cheap when nothing needs
/// doing: a `stat` per such source.
pub fn convert_project_sources(project_dir: &Path, manifest: &ProjectManifest) {
    let sources = video_sources(manifest);
    optimized_media::request(&sources);
    let folder = project_dir.join(optimized_media::FOLDER);
    let freed = optimized_media::prune(&folder, &sources);
    if freed > 0 {
        log::info!(
            "[chroma::media_conversion] removed {:.1} MB of converted media nothing uses",
            freed as f64 / 1e6
        );
    }
}

/// Ask for `paths` to be converted again if their last conversion failed or
/// was cancelled (a re-probe is the user's "try this source again").
pub fn retry(paths: &[PathBuf]) {
    optimized_media::retry(paths);
}

/// One pool item's cancel, as the Sources panel and
/// `editor_cancel_media_conversion` report it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CancelOutcome {
    pub id: String,
    pub source_path: String,
    /// There was a conversion queued or running to cancel.
    pub was_converting: bool,
    /// Where the item's conversion stands now (`None`: the media engine opens
    /// it as it is, so it never needed one).
    pub conversion: Option<ConversionStatus>,
}

/// Cancel the conversions of the pool items `ids` in `manifest`. An id not in
/// the pool is reported back in `unknown`, not treated as an error.
pub fn cancel_items(
    manifest: &ProjectManifest,
    ids: &[String],
) -> (Vec<CancelOutcome>, Vec<String>) {
    let mut outcomes = Vec::new();
    let mut unknown = Vec::new();
    for id in ids {
        let Some(item) = manifest.media.iter().find(|m| &m.id == id) else {
            unknown.push(id.clone());
            continue;
        };
        let path = Path::new(&item.source_path);
        let was_converting = optimized_media::cancel(path);
        outcomes.push(CancelOutcome {
            id: id.clone(),
            source_path: item.source_path.clone(),
            was_converting,
            conversion: optimized_media::status(path),
        });
    }
    (outcomes, unknown)
}

/// The result of [`chroma_media_cancel_conversion`].
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CancelConversionResult {
    pub items: Vec<CancelOutcome>,
    pub unknown_ids: Vec<String>,
}

/// The Sources panel's Cancel on a converting item, and
/// `editor_cancel_media_conversion`: stop the conversions of these pool items.
/// A running one's `ffmpeg` is killed and its partial file removed; a queued
/// one never starts. The item stays in the pool, unconvertible until it is
/// re-probed (`chroma_media_reprobe`), which asks for it again.
#[tauri::command]
pub async fn chroma_media_cancel_conversion(
    ids: Vec<String>,
) -> Result<CancelConversionResult, String> {
    if ids.is_empty() {
        return Err("no pool item ids given".into());
    }
    let dir = super::state::current_project()
        .map(|p| p.path)
        .ok_or_else(|| "no project open — create or open one first".to_string())?;
    let manifest = super::project::load_manifest(&dir)?;
    let (items, unknown_ids) = cancel_items(&manifest, &ids);
    Ok(CancelConversionResult { items, unknown_ids })
}

#[cfg(test)]
mod tests {
    use super::*;
    use apelles_media::optimized_media::ConversionState;
    use apelles_project::{MediaItem, MediaVideoInfo};

    fn item(id: &str, path: &str, width: u32) -> MediaItem {
        MediaItem {
            id: id.into(),
            source_path: path.into(),
            name: id.into(),
            added: String::new(),
            video: Some(MediaVideoInfo {
                resolution: apelles_types::Resolution::new(width, if width > 0 { 240 } else { 0 }),
                fps: 30.0,
                frame_count: 30,
                duration_secs: 1.0,
                has_audio: Some(false),
                audio_channels: Some(0),
            }),
            image: None,
            folder: None,
            motion_scene_id: None,
        }
    }

    #[test]
    fn only_video_sources_the_media_engine_cannot_open_are_asked_for() {
        let mut manifest = ProjectManifest::fresh("t");
        manifest.media = vec![
            item("a", "/m/a.mkv", 320),
            item("b", "/m/b.mov", 320),
            item("c", "/m/c.webm", 0), // audio only
            item("d", "/m/d.mts", 320),
        ];
        let sources = video_sources(&manifest);
        assert_eq!(
            sources,
            vec![PathBuf::from("/m/a.mkv"), PathBuf::from("/m/d.mts")]
        );
    }

    /// An existing project — written before optimized media existed — whose
    /// pool holds a Matroska source: opening it (what `open_manifest` calls)
    /// converts that source into the project's own folder, the pool item
    /// reports the conversion as it runs, and the decode then reads it.
    #[test]
    fn opening_an_existing_project_converts_its_sources_and_the_pool_reports_it() {
        let _guard = crate::chroma::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().expect("tempdir");
        let mkv = tmp.path().join("existing.mkv");
        let status = apelles_media::ffmpeg_locate::ffmpeg()
            .expect("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=320x240:rate=30:duration=2")
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&mkv)
            .status()
            .expect("ffmpeg");
        assert!(status.success());
        let (dir, manifest) = apelles_project::new_project_in(
            tmp.path(),
            "existing",
            &[mkv.to_string_lossy().into_owned()],
        )
        .expect("project");
        let item = manifest.media.first().expect("the pool item").clone();
        assert!(
            apelles_project::MediaItemDto::from(&item)
                .conversion
                .is_none(),
            "not asked for yet"
        );

        crate::chroma::state::set_project(Some(crate::chroma::state::ProjectRef {
            path: dir.clone(),
            name: "existing".into(),
        }));
        convert_project_sources(&dir, &manifest);
        let first = apelles_project::MediaItemDto::from(&item)
            .conversion
            .expect("queued on open");
        assert_ne!(first.state, ConversionState::Failed, "{:?}", first.error);
        let wire = serde_json::to_value(apelles_project::MediaItemDto::from(&item)).expect("json");
        assert!(wire["conversion"]["state"].is_string(), "{wire}");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let c = apelles_project::MediaItemDto::from(&item)
                .conversion
                .expect("still reported");
            match c.state {
                ConversionState::Ready => break,
                ConversionState::Failed | ConversionState::Cancelled => panic!("{c:?}"),
                _ => {}
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the conversion finishes"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let converted = optimized_media::converted_file(&mkv).expect("converted");
        assert!(converted.starts_with(dir.join(optimized_media::FOLDER)));
        // The project file still names the original.
        let saved = apelles_project::load_manifest(&dir).expect("load");
        assert_eq!(saved.media[0].source_path, mkv.to_string_lossy());
        // Opening it again converts nothing a second time.
        convert_project_sources(&dir, &manifest);
        assert_eq!(
            optimized_media::status(&mkv).map(|s| s.state),
            Some(ConversionState::Ready)
        );
        crate::chroma::state::set_project(None);
    }

    #[test]
    fn cancelling_an_unknown_id_reports_it_rather_than_failing() {
        let mut manifest = ProjectManifest::fresh("t");
        manifest.media = vec![item("a", "/m/a.mov", 320)];
        let (items, unknown) = cancel_items(&manifest, &["a".into(), "zzz".into()]);
        assert_eq!(unknown, vec!["zzz".to_string()]);
        assert_eq!(items.len(), 1);
        assert!(!items[0].was_converting);
        assert_eq!(items[0].conversion, None, "a .mov needs no conversion");
    }
}
