//! Persistent sequential-decode pipe for smooth scrub / playback (roadmap
//! round-2 item 5, D-030).
//!
//! What it is: one long-lived `ffmpeg -f rawvideo` process per loaded clip that
//!   streams frames sequentially, instead of a fresh process + keyframe seek +
//!   PNG round-trip per frame (`video::decode_frame`, D-015).
//! What it does: `playback_frame(path, info, target)` returns frame `target` as
//!   an 8-bit RGB `DynamicImage`. Cheap when `target` is the next frame or a
//!   short forward hop; a keyframe-seek respawn otherwise (no worse than the
//!   old per-frame path).
//! What it does NOT do: audio, colour management, the GPU grade, caching decoded
//!   frames. It is purely "give me frame N fast, in order".
//! Fallback: any pipe error drops the pipe and returns `Err` — callers fall back
//!   to `video::decode_frame`. The pipe is a fast path, never a new failure mode.

use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use image::{DynamicImage, RgbImage};
use once_cell::sync::Lazy;

use super::video::VideoInfo;

fn ffmpeg_bin() -> String {
    std::env::var("CHROMA_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// How far forward we'll fast-skip (discard decoded frames) before a respawn —
/// with its keyframe seek — becomes the cheaper option. ~2 s at 24 fps.
const MAX_FORWARD_SKIP: u64 = 48;

pub struct FramePipe {
    path: PathBuf,
    child: Child,
    stdout: BufReader<ChildStdout>,
    /// absolute source frame index the next `read_raw()` will return
    next_index: u64,
    frame_bytes: usize,
    /// output frame dimensions — the *source* size, or a downscale target when
    /// `scale` is set (D-031 playback: ffmpeg's SIMD scaler is far cheaper than a
    /// CPU downscale of a 4K frame every playback frame).
    w: u32,
    h: u32,
    /// `Some((w, h))` if ffmpeg is scaling the output; `None` = native size.
    scale: Option<(u32, u32)>,
}

/// Even-dimension downscale target for a `long_edge` cap. Returns `None` when the
/// source already fits (no scaling needed).
pub fn scale_target(src_w: u32, src_h: u32, long_edge: u32) -> Option<(u32, u32)> {
    let long = src_w.max(src_h);
    if long == 0 || long <= long_edge {
        return None;
    }
    let ratio = long_edge as f64 / long as f64;
    let mut w = (src_w as f64 * ratio).round() as u32;
    let mut h = (src_h as f64 * ratio).round() as u32;
    w &= !1; // ffmpeg scaler + most codecs want even dims
    h &= !1;
    Some((w.max(2), h.max(2)))
}

impl Drop for FramePipe {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl FramePipe {
    /// Spawn ffmpeg decoding `path` from absolute frame `start` to EOF as a raw
    /// rgb24 stream. `-ss (start-0.5)/fps` before `-i` is an accurate seek that
    /// lands exactly on `start` for CFR footage (verified, D-030); the half-frame
    /// margin always points backward so an `avg`-vs-`r` frame-rate rounding
    /// wobble can't skip a frame forward.
    #[allow(dead_code)] // native-size wrapper; production path is `open_scaled`
    pub fn open(path: &Path, info: &VideoInfo, start: u64) -> Result<Self> {
        Self::open_scaled(path, info, start, None)
    }

    /// As [`FramePipe::open`], but ffmpeg downscales every frame to `scale`
    /// (`Some((w, h))`) before it hits the pipe. Used by the playback path (D-031)
    /// so a 4K frame is never CPU-downscaled per frame.
    pub fn open_scaled(
        path: &Path,
        info: &VideoInfo,
        start: u64,
        scale: Option<(u32, u32)>,
    ) -> Result<Self> {
        let fps = info.fps();
        if fps <= 0.0 || info.width == 0 || info.height == 0 {
            return Err(anyhow!("decode pipe needs a probed CFR video (fps + dimensions)"));
        }
        let seek = ((start as f64 - 0.5) / fps).max(0.0);
        let (out_w, out_h) = scale.unwrap_or((info.width, info.height));

        let mut cmd = Command::new(ffmpeg_bin());
        cmd.args(["-hide_banner", "-loglevel", "error", "-ss"])
            .arg(format!("{seek:.6}"))
            .arg("-i")
            .arg(path)
            .args(["-an", "-sn"]);
        if let Some((sw, sh)) = scale {
            cmd.args(["-vf", &format!("scale={sw}:{sh}:flags=fast_bilinear")]);
        }
        cmd.args([
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

        let mut child = cmd
            .spawn()
            .with_context(|| format!("spawning decode pipe for {}", path.display()))?;

        let stdout = BufReader::with_capacity(
            1 << 20,
            child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("decode pipe stdout unavailable"))?,
        );

        Ok(Self {
            path: path.to_path_buf(),
            child,
            stdout,
            next_index: start,
            frame_bytes: out_w as usize * out_h as usize * 3,
            w: out_w,
            h: out_h,
            scale,
        })
    }

    fn read_raw(&mut self) -> Result<RgbImage> {
        let mut buf = vec![0u8; self.frame_bytes];
        self.stdout
            .read_exact(&mut buf)
            .context("reading a frame from the decode pipe")?;
        self.next_index += 1;
        RgbImage::from_raw(self.w, self.h, buf).ok_or_else(|| anyhow!("rgb frame buffer size mismatch"))
    }

    fn skip_raw(&mut self) -> Result<()> {
        let mut buf = vec![0u8; self.frame_bytes];
        self.stdout
            .read_exact(&mut buf)
            .context("skipping a frame in the decode pipe")?;
        self.next_index += 1;
        Ok(())
    }

    /// Absolute frame `target` as an 8-bit RGB image, optionally downscaled to
    /// `scale` by ffmpeg. A change of `path` or `scale`, a backward step, or a
    /// forward jump past [`MAX_FORWARD_SKIP`] forces a keyframe-seek respawn.
    pub fn frame_scaled(
        &mut self,
        path: &Path,
        info: &VideoInfo,
        target: u64,
        scale: Option<(u32, u32)>,
    ) -> Result<DynamicImage> {
        let need_restart = path != self.path
            || scale != self.scale
            || target < self.next_index
            || target > self.next_index + MAX_FORWARD_SKIP;

        if need_restart {
            *self = Self::open_scaled(path, info, target, scale)?;
        } else {
            while self.next_index < target {
                self.skip_raw()?;
            }
        }
        Ok(DynamicImage::ImageRgb8(self.read_raw()?))
    }

    /// Absolute frame `target` as an 8-bit RGB image (native size).
    #[allow(dead_code)] // native-size wrapper; production path is `frame_scaled`
    pub fn frame(&mut self, path: &Path, info: &VideoInfo, target: u64) -> Result<DynamicImage> {
        let need_restart = path != self.path
            || self.scale.is_some()
            || target < self.next_index
            || target > self.next_index + MAX_FORWARD_SKIP;

        if need_restart {
            *self = Self::open(path, info, target)?;
        } else {
            while self.next_index < target {
                self.skip_raw()?;
            }
        }
        Ok(DynamicImage::ImageRgb8(self.read_raw()?))
    }
}

// --------------------------------------------------------------------------- //
// process-global playback pipe (there is only ever one clip loaded — mirrors
// state.rs's THUMB_CACHE)
// --------------------------------------------------------------------------- //

static PIPE: Lazy<Mutex<Option<FramePipe>>> = Lazy::new(|| Mutex::new(None));

/// Decode `target` via the process-global playback pipe, creating / advancing /
/// restarting it as needed. On any failure the pipe is dropped and the error
/// returned; callers should fall back to [`super::video::decode_frame`].
#[allow(dead_code)] // native-size convenience wrapper; scrub goes through
                    // `playback_frame_scaled(.., None)`, kept for API symmetry
pub fn playback_frame(path: &Path, info: &VideoInfo, target: u64) -> Result<DynamicImage> {
    playback_frame_scaled(path, info, target, None)
}

/// As [`playback_frame`], but ffmpeg downscales each frame to `scale` first
/// (D-031). Switching `scale` (e.g. entering / leaving playback) costs one
/// respawn, same as a seek jump.
pub fn playback_frame_scaled(
    path: &Path,
    info: &VideoInfo,
    target: u64,
    scale: Option<(u32, u32)>,
) -> Result<DynamicImage> {
    let mut guard = PIPE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(FramePipe::open_scaled(path, info, target, scale)?);
    }
    let pipe = guard.as_mut().unwrap();
    match pipe.frame_scaled(path, info, target, scale) {
        Ok(img) => Ok(img),
        Err(e) => {
            *guard = None; // poison → next call respawns clean
            Err(e)
        }
    }
}

/// Drop the playback pipe (frees the ffmpeg process + its fd). Called from
/// `state::set_current_video` when the clip changes, and before an export.
pub fn reset() {
    *PIPE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_video() -> Option<PathBuf> {
        std::env::var("CHROMA_TEST_VIDEO")
            .ok()
            .map(PathBuf::from)
            .filter(|p| p.exists())
    }

    #[test]
    fn pipe_matches_single_frame_decode() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = crate::chroma::video::probe(&vid).expect("probe");

        // frames 300, 301, 302 sequential out of the pipe...
        let mut pipe = FramePipe::open(&vid, &info, 300).expect("open pipe");
        let p300 = pipe.frame(&vid, &info, 300).expect("f300").to_rgb8();
        let p301 = pipe.frame(&vid, &info, 301).expect("f301").to_rgb8();
        let p302 = pipe.frame(&vid, &info, 302).expect("f302").to_rgb8();

        // ...must equal the independent per-frame decode path.
        for (n, piped) in [(300u64, &p300), (301, &p301), (302, &p302)] {
            let one = crate::chroma::video::decode_frame(
                &vid,
                crate::chroma::video::FramePos::Index(n),
                &info,
            )
            .expect("decode_frame")
            .to_rgb8();
            assert_eq!(piped.dimensions(), one.dimensions(), "frame {n} dims");
            let diff = mean_abs_diff(piped, &one);
            assert!(diff < 1.0, "frame {n}: mean|Δ| {diff} between pipe and decode_frame");
        }
    }

    #[test]
    fn pipe_forward_skip_and_backward_restart() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = crate::chroma::video::probe(&vid).expect("probe");
        let mut pipe = FramePipe::open(&vid, &info, 0).expect("open");

        let a = pipe.frame(&vid, &info, 10).expect("skip fwd to 10").to_rgb8();
        let b = pipe.frame(&vid, &info, 2).expect("restart back to 2").to_rgb8();

        let a_ref = crate::chroma::video::decode_frame(&vid, crate::chroma::video::FramePos::Index(10), &info)
            .expect("d10")
            .to_rgb8();
        let b_ref = crate::chroma::video::decode_frame(&vid, crate::chroma::video::FramePos::Index(2), &info)
            .expect("d2")
            .to_rgb8();
        assert!(mean_abs_diff(&a, &a_ref) < 1.0, "forward-skip landed wrong");
        assert!(mean_abs_diff(&b, &b_ref) < 1.0, "backward-restart landed wrong");
    }

    #[test]
    fn scale_target_math() {
        assert_eq!(scale_target(3840, 2160, 1280), Some((1280, 720)));
        assert_eq!(scale_target(2160, 3840, 1280), Some((720, 1280))); // portrait
        assert_eq!(scale_target(1920, 1080, 1280), Some((1280, 720)));
        assert_eq!(scale_target(1280, 720, 1280), None); // already fits
        assert_eq!(scale_target(1000, 562, 1280), None); // smaller than cap
        // odd source rounds to even
        let (w, h) = scale_target(1999, 1125, 1280).unwrap();
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
    }

    #[test]
    fn scaled_pipe_is_sequential_and_downscaled() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = crate::chroma::video::probe(&vid).expect("probe");
        let scale = scale_target(info.width, info.height, 1280);
        assert!(scale.is_some(), "C019 is 4K, should scale");
        let (sw, sh) = scale.unwrap();

        let mut pipe = FramePipe::open_scaled(&vid, &info, 200, scale).expect("open scaled");
        // three sequential scaled frames, correct dims, forward index advances
        for n in 200u64..203 {
            let f = pipe.frame_scaled(&vid, &info, n, scale).expect("scaled frame").to_rgb8();
            assert_eq!(f.dimensions(), (sw, sh), "frame {n} not at scale target");
        }
        // a scale change forces a respawn (native size back)
        let native = pipe.frame_scaled(&vid, &info, 203, None).expect("native frame").to_rgb8();
        assert_eq!(native.dimensions(), (info.width, info.height));
    }

    fn mean_abs_diff(a: &RgbImage, b: &RgbImage) -> f64 {
        let (n, sum) = a
            .as_raw()
            .iter()
            .zip(b.as_raw())
            .fold((0u64, 0u64), |(n, s), (x, y)| (n + 1, s + (*x as i64 - *y as i64).unsigned_abs()));
        if n == 0 {
            0.0
        } else {
            sum as f64 / n as f64
        }
    }
}
