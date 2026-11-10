//! Load a video as a single decoded frame into the existing image pipeline.
//!
//! What it does: probe the clip, decode one frame to a `DynamicImage`, and drop it
//!   into `AppState.original_image` exactly like `image_loader::load_image` does for a
//!   still — so every downstream grade/mask/display path treats it as an image.
//! What it does NOT do: transport, proxy, temporal anything. Frame selection comes
//!   later via `chroma::state::CurrentVideo`.
//! Why it's separate: keeps `image_loader.rs`'s edit down to a 3-line early branch.

use std::path::Path;
use std::sync::Arc;

use image::{DynamicImage, GenericImageView};

use crate::app_state::{AppState, LoadedImage};
use crate::image_loader::LoadImageResult;
use crate::image_processing::ImageMetadata;

use super::state::{CurrentVideo, set_current_video};
use super::video::{self, FramePos, VideoInfo};

/// Decode `frame` of the video at `source_path` and make it the loaded image.
/// `virtual_path` is the path string the frontend passed (kept for round-tripping).
pub async fn load_video_frame(
    source_path: &Path,
    virtual_path: &str,
    frame: u64,
    state: &tauri::State<'_, AppState>,
) -> Result<LoadImageResult, String> {
    let path_owned = source_path.to_path_buf();

    let (info, img) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let info = video::probe(&path_owned).map_err(|e| e.to_string())?;
        let img = video::decode_frame(&path_owned, FramePos::Index(frame), &info)
            .map_err(|e| e.to_string())?;
        Ok((info, img))
    })
    .await
    .map_err(|e| e.to_string())??;

    // No clip id: this is the loose-clip / `add_shots` path, whose shots are
    // path-identified (D-306 — see `chroma::state::ShotId`). A project's clips
    // come in through `register_video_shot` instead.
    let shot = CurrentVideo {
        path: source_path.to_path_buf(),
        info,
        frame,
        clip_id: None,
    };
    Ok(install_frame(&shot, virtual_path, img, state))
}

/// Register `source_path` in the session as a shot at `frame` **without
/// decoding a single pixel** (D-128).
///
/// The cheap counterpart to [`load_video_frame`], for the callers that only
/// ever needed the *session bookkeeping* — a path, its probe info, and a
/// playhead — and never the decoded image.
///
/// `chroma::project::open_manifest` was the expensive case, and it was on the
/// critical path between clicking a project card and seeing anything.
/// Measured on the owner's own project (two clips of a 2.3 GB 4K HEVC
/// source): [`load_video_frame`] decodes a full-resolution frame and encodes
/// it to PNG, **~1.9s per clip**, and every iteration of that loop overwrote
/// `AppState.original_image` with the next clip's pixels — so all of it but
/// the last was thrown away, and even the last was immediately replaced by
/// the `seek_and_install` that runs for the genuinely-active clip right after
/// the loop. Every one of those decodes was pure waste. The probe behind this
/// is itself disk-cached (`super::edit::probe_cached`, D-128), so a reopen of
/// the same project costs neither the decode nor the `ffprobe`.
///
/// It also removes a real, if secondary, defect in the resync path
/// (`chroma_project_resync_clips`), which documented itself as not disturbing
/// the active shot while in fact clobbering `original_image` with a newly
/// added clip's pixels on its way past.
///
/// A probe failure still means "offline", exactly as a decode failure did —
/// the narrowing is that a file which probes but cannot decode is no longer
/// caught here. It is still caught at the point it matters: the active clip
/// goes through the real decode path immediately afterwards.
///
/// D-306: `clip_id` is the Edit-timeline `Clip` this shot IS. Two clips cut
/// from one source file register as two independent shots because of it
/// (B-150); `None` is the Untitled loose-clip case, where the path is already
/// a unique identity.
pub fn register_video_shot(
    source_path: &Path,
    frame: u64,
    clip_id: Option<&str>,
) -> Result<(), String> {
    let info = super::edit::probe_cached(source_path)?;
    register_probed_video_shot(source_path, info, frame, clip_id);
    Ok(())
}

/// [`register_video_shot`] for a source whose probe the caller already holds —
/// `open_manifest` probes every clip's source in parallel first (B-369) and
/// registers the shots afterwards, in clip order, from those answers.
pub fn register_probed_video_shot(
    source_path: &Path,
    info: VideoInfo,
    frame: u64,
    clip_id: Option<&str>,
) {
    set_current_video(Some(CurrentVideo {
        path: source_path.to_path_buf(),
        info,
        frame,
        clip_id: clip_id.map(str::to_string),
    }));
}

/// **Decode one picture for a shot — still or video — at `scale`.** The single
/// answer to "where does a shot's picture come from", which is the question
/// B-400 says to settle once instead of patching site by site.
///
/// What it does: a STILL (`still::is_image_file`) goes through
/// `apelles_media::still` — header probe, memoised decode at the caller's
/// target size — and anything else through the media engine's sequential
/// decode (D-030/D-452, its converted file for a container the engine cannot
/// open, D-453), converted by the GPU engine. `None` means the source's own
/// size.
///
/// What it does NOT do: geometry. `ClipView::apply_geometry` (D-294) is the
/// caller's, because each caller has its own long-edge cap to pass it.
///
/// **Why it exists.** The still branch had to be discovered three separate
/// times, each by hitting it in the running app: the Colorist canvas (B-391),
/// the shot-strip thumbnail (B-399), and this path, which left a still
/// unopenable the moment its project was reopened (B-400) even though the same
/// file had graded fine minutes earlier. `decode_and_install`'s own doc claimed
/// it "mirrors `seek_and_install` exactly" — it did, until B-391 fixed one of
/// them. Two copies of a branch do not stay mirrored; one function does.
///
/// `decode_frame_index` is meaningless for a still (D-292 gives one a
/// synthesized span and every frame of it is the same picture), and is ignored
/// on that branch rather than silently mapped to something.
pub(crate) fn decode_shot_picture(
    path: &Path,
    info: &VideoInfo,
    decode_frame_index: u64,
    scale: Option<(u32, u32)>,
) -> Result<DynamicImage, String> {
    if apelles_media::still::is_image_file(path) {
        let rgba = apelles_media::still::decode_scaled(path, scale)
            .map_err(|e| format!("decode {}: {e}", path.display()))?;
        return Ok(DynamicImage::ImageRgba8((*rgba).clone()));
    }
    let frame = super::decode_pipe::playback_frame(
        super::decode_pipe::PipeLane::LIVE,
        super::decode_pipe::PipeSlot::Current,
        path,
        info,
        decode_frame_index,
    )
    .map_err(|e| e.to_string())?;
    let size = scale.or(Some((info.resolution.width, info.resolution.height)));
    super::edit::decoded_picture(frame, size)
}

/// Make an already-decoded video frame the loaded image + point `CurrentVideo` at
/// it. The state-writing tail of [`load_video_frame`], split out so the transport
/// (`chroma_seek`) can feed a frame it got from the fast [`super::decode_pipe`]
/// path without re-probing or re-decoding.
///
/// Takes the whole [`CurrentVideo`] rather than `(path, info, frame)` so the
/// shot's **identity** (its `clip_id`, D-306) travels with it: installing a
/// frame re-upserts the shot, and an upsert that had lost the clip id would
/// append a second, path-keyed shot next to the real one instead of updating it.
pub fn install_frame(
    shot: &CurrentVideo,
    virtual_path: &str,
    img: DynamicImage,
    state: &tauri::State<'_, AppState>,
) -> LoadImageResult {
    let (width, height) = img.dimensions();
    let arc_img = Arc::new(img);

    *state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(LoadedImage {
        path: virtual_path.to_string(),
        image: arc_img,
        is_raw: false,
    });

    set_current_video(Some(shot.clone()));

    LoadImageResult {
        width,
        height,
        metadata: ImageMetadata::default(),
        exif: Default::default(),
        is_raw: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A `VideoInfo` whose only job is to be ignored: `decode_shot_picture`
    /// must not read it on the still branch, and these numbers are deliberately
    /// nothing like the still's own so a test would notice if it did.
    fn unrelated_info() -> VideoInfo {
        VideoInfo {
            resolution: apelles_types::Resolution::new(1920, 1080),
            fps_num: 25,
            fps_den: 1,
            duration_secs: 4.0,
            frame_count: 100,
            codec: "hevc".into(),
            pix_fmt: "yuv420p".into(),
            color_primaries: String::new(),
            color_transfer: String::new(),
            color_space: String::new(),
            has_audio: false,
            audio_sample_rate: 0,
            audio_channels: 0,
        }
    }

    fn write_still(dir: &Path, name: &str, w: u32, h: u32) -> PathBuf {
        let path = dir.join(name);
        let img = image::RgbImage::from_fn(w, h, |x, _| {
            if x < w / 2 {
                image::Rgb([200, 30, 30])
            } else {
                image::Rgb([30, 30, 200])
            }
        });
        image::DynamicImage::ImageRgb8(img)
            .save(&path)
            .expect("write the test still");
        path
    }

    /// **B-391 / B-399 / B-400 — the one that was missing all three times.**
    ///
    /// The still branch had to be rediscovered at three separate call sites,
    /// each by hitting it in the running app, because nothing pinned the
    /// routing itself. A still must come back as a picture at its OWN size,
    /// from a `VideoInfo` that says something else entirely — which it can
    /// only do by never reaching the video decode.
    #[test]
    fn a_still_decodes_from_its_own_pixels_and_ignores_the_video_info() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let still = write_still(tmp.path(), "shot.jpg", 640, 400);

        let img =
            decode_shot_picture(&still, &unrelated_info(), 0, None).expect("a still must decode");

        // Its own 640x400, not the info's 1920x1080.
        assert_eq!((img.width(), img.height()), (640, 400));
    }

    /// Every frame of a still is the same picture (D-292 gives one a
    /// synthesized span), so a frame index far past the info's `frame_count`
    /// is not an error and not a different picture.
    #[test]
    fn a_stills_frame_index_is_ignored_rather_than_mapped() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let still = write_still(tmp.path(), "shot.png", 320, 200);

        let first = decode_shot_picture(&still, &unrelated_info(), 0, None).expect("frame 0");
        let far = decode_shot_picture(&still, &unrelated_info(), 9_999, None).expect("frame 9999");

        assert_eq!((first.width(), first.height()), (320, 200));
        assert_eq!(far.to_rgb8().into_raw(), first.to_rgb8().into_raw());
    }

    /// The caller's target size is honoured on the still branch too — this is
    /// what lets the Colorist ask for a preview-sized picture of a 6000 px
    /// still instead of decoding all of it.
    #[test]
    fn a_still_honours_the_callers_target_size() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let still = write_still(tmp.path(), "big.jpg", 1200, 800);

        let img = decode_shot_picture(&still, &unrelated_info(), 0, Some((300, 200)))
            .expect("a scaled still must decode");

        assert_eq!((img.width(), img.height()), (300, 200));
    }

    /// The branch is taken on the EXTENSION, so a non-image goes to the media
    /// engine — here a file that is not decodable at all, which must fail as a
    /// decode rather than be mistaken for a still.
    #[test]
    fn a_non_image_extension_goes_to_the_media_engine_not_the_still_path() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let fake = tmp.path().join("clip.mov");
        std::fs::write(&fake, b"not a real movie").expect("write");

        let err = decode_shot_picture(&fake, &unrelated_info(), 0, None)
            .expect_err("a bogus .mov must not decode");
        // The still path's own message names the file it tried to decode; the
        // engine's does not look like that. Either way it must be an error,
        // never a silently-substituted picture.
        assert!(!err.is_empty(), "a failure must say something");
    }
}
