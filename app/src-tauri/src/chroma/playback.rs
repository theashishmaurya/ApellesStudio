//! Real-time playback path (roadmap round-2 item 5 tail, D-031).
//!
//! D-030 fixed *decode* (the persistent [`super::decode_pipe`]); the remaining
//! ceiling it named was the frontend regrade + **two** IPC calls per playback
//! frame: `chroma_seek` (decode + swap the base frame) → `bumpFrameNonce` → a
//! React effect → `apply_adjustments` (a full-res 4K WGSL grade).
//!
//! This module collapses that to **one** command, [`chroma_play_frame`]:
//!   decode via the pipe → swap into `AppState.original_image` (exactly
//!   `chroma_seek`'s body, shared via [`super::commands::seek_and_install`]) →
//!   dispatch **one** preview job at a reduced *playback resolution* → return.
//!   No nonce, no second IPC, no React round-trip, grade at ~1280 px not 4K.
//!
//! The single-frame scrub path ([`super::commands::chroma_seek`]) is unchanged
//! and still shares the decode+install half.
//!
//! Fork hygiene (D-003): all new code; `lib.rs` gains one `generate_handler!`
//! line, `chroma/mod.rs` one `pub mod playback;`.

use crate::app_state::{AppState, PreviewJob};

/// Long-edge resolution the grade runs at *during playback*. 4K talking-head
/// footage graded frame-by-frame at native res is the D-030 ceiling; nobody
/// pixel-peeps at 24-30 fps. On pause the frontend triggers a normal full-res
/// regrade (the `frameNonce` effect), so quality at rest is unchanged.
pub const PLAYBACK_LONG_EDGE: u32 = 1280;

/// Clamp a requested playback dim to something sane: never upscale past the
/// source, never below 256, default [`PLAYBACK_LONG_EDGE`].
pub fn playback_dim(requested: Option<u32>, source_long_edge: u32) -> u32 {
    let want = requested.unwrap_or(PLAYBACK_LONG_EDGE).clamp(256, 4096);
    if source_long_edge > 0 {
        want.min(source_long_edge)
    } else {
        want
    }
}

/// Decode `frame` via the persistent pipe, swap it into the editor's base image,
/// then grade + present it at playback resolution — all in one IPC call.
///
/// `js_adjustments` is the live grade doc from the frontend store (same value
/// `apply_adjustments` gets). Returns the preview worker's bytes — `WGPU_RENDER`
/// on the native-surface path (macOS/Windows default; the grade is painted
/// straight to the wgpu surface). On Linux (`use_wgpu_renderer = false`) it
/// returns a JPEG; the playback loop currently ignores the body, so Linux
/// playback would show a stale frame — a known gap, video is macOS-first for v1.
#[tauri::command]
pub async fn chroma_play_frame(
    frame: u64,
    js_adjustments: serde_json::Value,
    target_resolution: Option<u32>,
    state: tauri::State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    // 1. decode + install (shared with chroma_seek — clears the per-frame pixel
    //    caches, runs the decode pipe, swaps AppState.original_image, and points
    //    CurrentVideo.frame at `frame` so tracked mattes (D-019) stay in lockstep).
    let source_long_edge = {
        let cv = super::state::current_video();
        cv.map(|c| c.info.resolution.width.max(c.info.resolution.height)).unwrap_or(0)
    };
    let dim = playback_dim(target_resolution, source_long_edge);
    super::commands::seek_and_install(frame, Some(dim), &state).await?;

    // 2. dispatch ONE preview job at playback resolution. Mirrors the
    //    `apply_adjustments` command body; the preview worker coalesces, and we
    //    await this job before the next frame is ever requested, so the grade
    //    always renders the frame we just installed.
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let tx_guard = state
            .preview_worker_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let worker_tx = tx_guard.as_ref().ok_or("preview worker not running")?;
        worker_tx
            .send(PreviewJob {
                adjustments: js_adjustments,
                is_interactive: false,
                target_resolution: Some(dim),
                roi: None,
                request_analytics: false,
                compute_waveform: false,
                active_waveform_channel: None,
                responder: tx,
            })
            .map_err(|e| format!("send to preview worker: {e}"))?;
    }

    let bytes = rx
        .await
        .map_err(|_| "preview job superseded or worker failed".to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

// --------------------------------------------------------------------------- //
// headless timing harness (D-031) — the throughput proxy for the ceiling
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Instant;

    use image::{DynamicImage, GenericImageView};
    use serde_json::json;

    use crate::gpu_processing::RenderRequest;
    use crate::image_processing::get_all_adjustments_from_json;
    use crate::mask_generation::{generate_mask_bitmap, MaskDefinition};
    use crate::render_core::{self, OwnedRenderCaches};

    fn test_video() -> Option<PathBuf> {
        std::env::var("CHROMA_TEST_VIDEO")
            .ok()
            .map(PathBuf::from)
            .filter(|p| p.exists())
    }

    #[test]
    fn playback_dim_clamps() {
        assert_eq!(playback_dim(None, 3840), PLAYBACK_LONG_EDGE);
        assert_eq!(playback_dim(None, 720), 720); // never upscale
        assert_eq!(playback_dim(Some(1920), 3840), 1920);
        assert_eq!(playback_dim(Some(50), 3840), 256); // floor
        assert_eq!(playback_dim(Some(1280), 0), 1280); // unknown source
    }

    /// The D-031 throughput proxy. On the C019 clip, loop N frames through the
    /// **real** playback path minus the IPC + native surface:
    ///   scaled decode pipe (ffmpeg downscales to playback res, D-031) →
    ///   `render_core::render` (a real WGSL grade, headless, D-014 — the same
    ///   call `export.rs` uses). Prints ms/frame split decode vs grade + fps.
    ///
    /// This is the ceiling proxy: end-to-end also pays one IPC hop + the wgpu
    /// surface present, which a human smoke test covers.
    #[test]
    fn playback_throughput_c019() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = crate::chroma::video::probe(&vid).expect("probe");
        let long_edge: u32 = std::env::var("CHROMA_BENCH_LONG_EDGE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(PLAYBACK_LONG_EDGE);
        let n_frames: u64 = std::env::var("CHROMA_BENCH_FRAMES")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(60);
        let start_frame: u64 = 300;

        // a realistic non-trivial grade: exposure + contrast + saturation + WB +
        // a curve — the kind of primary a talking-head shot actually gets.
        let js = json!({
            "exposure": 0.35,
            "contrast": 18.0,
            "saturation": 12.0,
            "temperature": 8.0,
            "tint": -3.0,
            "highlights": -20.0,
            "shadows": 15.0,
            "curves": { "luma": [[0, 8], [64, 60], [192, 200], [255, 250]] }
        });

        let mask_defs: Vec<MaskDefinition> = js
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_default();

        let scale = crate::chroma::decode_pipe::scale_target(info.resolution.width, info.resolution.height, long_edge);

        let ctx = render_core::init_gpu_context().expect("gpu ctx");
        let caches = OwnedRenderCaches::default();

        let render_once = |img: &DynamicImage, hash: u64, tag: &str| {
            let (w, h) = img.dimensions();
            let masks: Vec<_> = mask_defs
                .iter()
                .filter_map(|d| generate_mask_bitmap(d, w, h, 1.0, (0.0, 0.0), None))
                .collect();
            render_core::render(
                &ctx,
                caches.as_ref(),
                img,
                hash,
                RenderRequest {
                    adjustments: get_all_adjustments_from_json(&js, false, None),
                    mask_bitmaps: &masks,
                    lut: None,
                    roi: None,
                },
                tag,
                false,
                None,
            )
            .expect("render")
        };

        // warm up the pipe + GPU (first frame pays spawn + shader compile + upload)
        let warm = crate::chroma::decode_pipe::playback_frame_scaled(&vid, &info, start_frame, scale)
            .expect("warm decode");
        let _ = render_once(&warm, 1, "playback_bench_warm");

        let mut t_decode = std::time::Duration::ZERO;
        let mut t_grade = std::time::Duration::ZERO;
        let loop_start = Instant::now();

        for i in 0..n_frames {
            let f = start_frame + 1 + i;

            let d0 = Instant::now();
            let frame =
                crate::chroma::decode_pipe::playback_frame_scaled(&vid, &info, f, scale)
                    .expect("decode");
            t_decode += d0.elapsed();

            let g0 = Instant::now();
            let _out = render_once(&frame, f.wrapping_add(1), "playback_bench");
            t_grade += g0.elapsed();
        }

        let total = loop_start.elapsed();
        let per = total.as_secs_f64() / n_frames as f64;
        eprintln!(
            "\n=== D-031 playback throughput — C019 {}x{} @ {} fps, grade @ {} px long edge, {} frames ===",
            info.resolution.width, info.resolution.height, info.fps(), long_edge, n_frames
        );
        eprintln!(
            "  scaled decode (ffmpeg): {:.2} ms/frame   grade: {:.2} ms/frame",
            t_decode.as_secs_f64() * 1000.0 / n_frames as f64,
            t_grade.as_secs_f64() * 1000.0 / n_frames as f64,
        );
        eprintln!(
            "  TOTAL:  {:.2} ms/frame   => {:.1} fps effective (headless, no IPC / no surface)\n",
            per * 1000.0,
            1.0 / per,
        );
        eprintln!(
            "  NOTE: run this test alone (`--test-threads=1`, or by name) for a real\n  \
             number — the other chroma GPU/ffmpeg tests in parallel inflate it badly.\n  \
             Uncontended on C019: ~25 ms/frame / ~40 fps @ 1280 px (was ~69 ms / 14.5 fps\n  \
             on the old full-4K path). See docs/notes/playback-30fps.md.\n"
        );

        // A perf threshold in a parallel test suite flakes on GPU contention, so
        // the hard 30 fps check is opt-in (`CHROMA_BENCH_ASSERT=1`, best with
        // `--test-threads=1`). Always keep a loose floor to catch a hang / a
        // wholesale regression of the scaled-decode + reduced-res path.
        assert!(
            per < 0.5,
            "playback path took {:.0} ms/frame — something is badly broken",
            per * 1000.0
        );
        if std::env::var("CHROMA_BENCH_ASSERT").is_ok() {
            assert!(
                per < 1.0 / 30.0,
                "playback throughput {:.1} fps / {:.2} ms/frame is below the 30 fps bar",
                1.0 / per,
                per * 1000.0
            );
        }
    }
}
