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
