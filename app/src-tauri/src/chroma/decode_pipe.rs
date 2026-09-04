//! Persistent sequential-decode pipe for smooth scrub / playback (roadmap
//! round-2 item 5, D-030; multi-pipe pool + hardware decode, D-125).
//!
//! What it is: one long-lived `ffmpeg -f rawvideo` process per *pipe slot* that
//!   streams frames sequentially, instead of a fresh process + keyframe seek +
//!   PNG round-trip per frame (`video::decode_frame`, D-015).
//! What it does: `playback_frame_scaled(slot, path, info, target, scale)`
//!   returns frame `target` as an 8-bit RGB `DynamicImage`. Cheap when `target`
//!   is the next frame or a short forward hop *for that slot*; a keyframe-seek
//!   respawn otherwise (no worse than the old per-frame path).
//! What it does NOT do: audio, colour management, the GPU grade, caching decoded
//!   frames. It is purely "give me frame N fast, in order".
//! Fallback: any pipe error drops that slot's pipe and returns `Err` — callers
//!   fall back to `video::decode_frame`. The pipe is a fast path, never a new
//!   failure mode.
//!
//! ## Why a pool of pipes and not one (D-125, B-040)
//!
//! D-030 kept exactly one process-global pipe, which was correct while the only
//! caller was Colorist's single "currently loaded video". D-088's multi-layer
//! Edit-tab compositor then started decoding **several** layers for one
//! displayed frame through that same single pipe — and since a pipe restarts
//! whenever the path changes *or* the target frame goes backwards, every layer
//! after the first forced a full `ffmpeg` respawn + keyframe seek. On a real
//! three-video-track project that is three 4K-HEVC process spawns **per
//! displayed frame**. Measured two ways against the owner's own project:
//! ~1.2 s per composited frame at the raw `ffmpeg` level in pure software, and
//! **618-660 ms/frame through this module** once hardware decode (below) was
//! already in place. Giving each layer its own slot restores the
//! sequential-decode property the module was built for — the same measurement,
//! same files, same code path, drops to **17-31 ms/frame** (a back-to-back
//! before/after run under identical machine load measured 618 → 23-31).
//!
//! ## Hardware decode (D-125, extending D-121)
//!
//! D-121 measured Apple `videotoolbox` decode of the owner's real 4K HEVC
//! footage at **38% CPU vs. 393%** for the identical, byte-identical output, and
//! applied it to the filmstrip-thumbnail path only. The same argument applies
//! here with more force — this path runs at playback rate, and the CPU it frees
//! is exactly what the real-time audio thread (`chroma::audio`, D-050) needs to
//! avoid ring-buffer underruns. Same policy as D-121: try hardware, fall back to
//! software on failure (hardware decode does not cover every codec/pixel format)
//! and remember the failure per path so the fallback is paid once, not per
//! respawn.

use std::collections::{HashMap, HashSet};
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

/// Sources whose hardware decode attempt has already failed once — retried in
/// software from then on rather than paying (and logging) the failure on every
/// respawn. Mirrors D-121's "try hardware, fall back to software, say so"
/// policy for the thumbnail path.
static NO_HWACCEL: Lazy<Mutex<HashSet<PathBuf>>> = Lazy::new(|| Mutex::new(HashSet::new()));

fn hwaccel_allowed(path: &Path) -> bool {
    !NO_HWACCEL
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(path)
}

fn disable_hwaccel(path: &Path) {
    NO_HWACCEL
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path.to_path_buf());
}

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
    /// Whether this process was spawned with `-hwaccel videotoolbox` (D-125) —
    /// read on failure to decide whether a software retry is worth attempting.
    hwaccel: bool,
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
    /// so a 4K frame is never CPU-downscaled per frame. Hardware decode is used
    /// unless this source has already failed at it once (D-125).
    pub fn open_scaled(
        path: &Path,
        info: &VideoInfo,
        start: u64,
        scale: Option<(u32, u32)>,
    ) -> Result<Self> {
        Self::open_with_hwaccel(path, info, start, scale, hwaccel_allowed(path))
    }

    /// The real spawn. `hwaccel` is threaded explicitly so the software retry
    /// after a hardware-decode failure ([`playback_frame_scaled`]) can force it
    /// off without racing the [`NO_HWACCEL`] memo it just wrote.
    fn open_with_hwaccel(
        path: &Path,
        info: &VideoInfo,
        start: u64,
        scale: Option<(u32, u32)>,
        hwaccel: bool,
    ) -> Result<Self> {
        let fps = info.fps();
        if fps <= 0.0 || info.resolution.width == 0 || info.resolution.height == 0 {
            return Err(anyhow!("decode pipe needs a probed CFR video (fps + dimensions)"));
        }
        let seek = ((start as f64 - 0.5) / fps).max(0.0);
        let (out_w, out_h) = scale.unwrap_or((info.resolution.width, info.resolution.height));

        let mut cmd = Command::new(ffmpeg_bin());
        cmd.args(["-hide_banner", "-loglevel", "error"]);
        if hwaccel {
            // Decoded frames are downloaded back to system memory (no
            // `-hwaccel_output_format`), so the `-vf scale` below and the
            // rgb24 output stay exactly as they are in software — verified
            // byte-identical on both this project's HEVC and H.264 sources.
            cmd.args(["-hwaccel", "videotoolbox"]);
        }
        cmd.arg("-ss")
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
            hwaccel,
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
// process-global pool of playback pipes, one per slot (D-125) — mirrors
// state.rs's THUMB_CACHE module-global style. Was a single `Option<FramePipe>`
// until D-088's multi-layer compositor started decoding several sources for one
// displayed frame through it; see the module doc for the measured cost.
// --------------------------------------------------------------------------- //

/// Which independently-sequential decode stream a call wants. Two callers that
/// interleave *different* sources or *different* positions must not share one,
/// or each call restarts the other's `ffmpeg` process (B-040).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum PipeSlot {
    /// The Colorist tab's single "currently loaded video" (`state::current_video`)
    /// — one clip at a time by construction, so one slot is right for all of it.
    Current,
    /// The Edit tab's preview: one slot per timeline **video track index**, so
    /// each composited layer keeps its own sequential decoder across frames.
    /// Keyed by track index rather than source path because two tracks can
    /// legitimately hold the same file at different positions — the real
    /// project this was found on does exactly that.
    Track(usize),
}

static PIPES: Lazy<Mutex<HashMap<PipeSlot, FramePipe>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Decode `target` via `slot`'s playback pipe, creating / advancing /
/// restarting it as needed. On any failure the slot's pipe is dropped and the
/// error returned; callers should fall back to [`super::video::decode_frame`].
///
/// Native-size convenience wrapper; scrub goes through
/// `playback_frame_scaled(.., None)`, kept for API symmetry.
#[allow(dead_code)]
pub fn playback_frame(
    slot: PipeSlot,
    path: &Path,
    info: &VideoInfo,
    target: u64,
) -> Result<DynamicImage> {
    playback_frame_scaled(slot, path, info, target, None)
}

/// As [`playback_frame`], but ffmpeg downscales each frame to `scale` first
/// (D-031). Switching `scale` (e.g. entering / leaving playback) costs one
/// respawn, same as a seek jump.
///
/// A failure on a hardware-accelerated pipe is retried **once** in software
/// before being reported (D-125) — hardware decode does not cover every
/// codec/pixel format, and a source that can't use it should degrade to the
/// pre-D-125 software behaviour rather than to no preview at all. The failure
/// is logged and remembered per source ([`NO_HWACCEL`]) so later respawns of
/// the same file go straight to software.
pub fn playback_frame_scaled(
    slot: PipeSlot,
    path: &Path,
    info: &VideoInfo,
    target: u64,
    scale: Option<(u32, u32)>,
) -> Result<DynamicImage> {
    let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());

    let pipe = match pool.entry(slot) {
        std::collections::hash_map::Entry::Occupied(o) => o.into_mut(),
        std::collections::hash_map::Entry::Vacant(v) => {
            v.insert(FramePipe::open_scaled(path, info, target, scale)?)
        }
    };

    match pipe.frame_scaled(path, info, target, scale) {
        Ok(img) => Ok(img),
        Err(e) => {
            let was_hwaccel = pipe.hwaccel;
            pool.remove(&slot); // poison → next call respawns clean
            if !was_hwaccel {
                return Err(e);
            }
            log::warn!(
                "decode pipe: hardware decode failed for {} ({e}) — retrying in software",
                path.display()
            );
            disable_hwaccel(path);
            let mut sw = FramePipe::open_with_hwaccel(path, info, target, scale, false)?;
            let img = sw.frame_scaled(path, info, target, scale)?;
            pool.insert(slot, sw);
            Ok(img)
        }
    }
}

/// Drop every pipe whose slot is a [`PipeSlot::Track`] not in `keep` — the
/// Edit-tab preview calls this once per frame with the track indices actually
/// visible there, so a track that goes hidden, is deleted, or simply has a gap
/// under the playhead releases its `ffmpeg` process instead of holding one open
/// for the rest of the session. Bounds the pool at "one pipe per currently
/// visible video layer" without needing an arbitrary cap.
pub fn retain_track_slots(keep: &[usize]) {
    PIPES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|slot, _| match slot {
            PipeSlot::Current => true,
            PipeSlot::Track(i) => keep.contains(i),
        });
}

/// How many pipes — and therefore how many live `ffmpeg` processes — the pool
/// currently holds. The observable the "one pipe per visible layer, released
/// when a layer goes away" contract is actually tested against (D-125).
/// Test-only — nothing in the running app needs to ask, and the house rule is
/// no dead code shipped "just in case".
#[cfg(test)]
pub fn open_pipe_count() -> usize {
    PIPES.lock().unwrap_or_else(|e| e.into_inner()).len()
}

/// Drop every playback pipe (frees the ffmpeg processes + their fds). Called
/// from `state::set_current_video` when the clip changes, and before an export.
pub fn reset() {
    PIPES.lock().unwrap_or_else(|e| e.into_inner()).clear();
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
        let scale = scale_target(info.resolution.width, info.resolution.height, 1280);
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
        assert_eq!(native.dimensions(), (info.resolution.width, info.resolution.height));
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
