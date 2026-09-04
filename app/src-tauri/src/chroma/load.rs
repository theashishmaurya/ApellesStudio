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

use super::state::{set_current_video, CurrentVideo};
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

    Ok(install_frame(source_path, virtual_path, frame, info, img, state))
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
pub fn register_video_shot(source_path: &Path, frame: u64) -> Result<(), String> {
    let info = super::edit::probe_cached(source_path)?;
    set_current_video(Some(CurrentVideo {
        path: source_path.to_path_buf(),
        info,
        frame,
    }));
    Ok(())
}

/// Make an already-decoded video frame the loaded image + point `CurrentVideo` at
/// it. The state-writing tail of [`load_video_frame`], split out so the transport
/// (`chroma_seek`) can feed a frame it got from the fast [`super::decode_pipe`]
/// path without re-probing or re-decoding.
pub fn install_frame(
    source_path: &Path,
    virtual_path: &str,
    frame: u64,
    info: VideoInfo,
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

    set_current_video(Some(CurrentVideo {
        path: source_path.to_path_buf(),
        info,
        frame,
    }));

    LoadImageResult {
        width,
        height,
        metadata: ImageMetadata::default(),
        exif: Default::default(),
        is_raw: false,
    }
}
