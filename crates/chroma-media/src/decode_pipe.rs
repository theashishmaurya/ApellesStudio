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
//! ## Frame `N` means the same thing here as everywhere else (D-228, B-104)
//!
//! Every spawn is built through [`crate::conform`], so "frame `N`" is the
//! picture at `N / source_fps` seconds — the same definition the timeline, the
//! keyframes, the audio clock, the export and `video::decode_frame` use. That
//! is a real constraint on this module in particular: it is the only decoder
//! that keeps reading *without* re-seeking, so it is the only one where a
//! per-frame error could accumulate. It no longer can — see B-104 for what
//! happened when it did.
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

use anyhow::{Context, Result, anyhow};
use image::{DynamicImage, RgbImage};
use once_cell::sync::Lazy;

use crate::video::VideoInfo;

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
    /// rgb24 stream, **conformed to the source's nominal frame grid**
    /// ([`crate::conform`], D-228) so the `n`th frame out of this pipe is source
    /// frame `start + n` as the rest of Chroma defines it — the picture at
    /// `(start + n) / source_fps` seconds.
    ///
    /// B-104: this used to be `-ss (start-0.5)/fps` + `-fps_mode passthrough`,
    /// i.e. seek once by time and then **count coded frames**. That is only the
    /// same thing on CFR footage. On a variable-frame-rate source the two
    /// diverge without bound between respawns — measured at up to 4.07 s on the
    /// owner's own screen recording — which is what detached the on-canvas
    /// transform box from the picture it was drawn over.
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
            // "a nominal rate", not "a CFR source": since D-228 a
            // variable-frame-rate source is decoded through this pipe just
            // like any other — it is conformed to the rate `probe` measured.
            // What is still required is that there BE a rate and a picture
            // size, i.e. a real probed video rather than an audio-only or
            // unprobeable file.
            return Err(anyhow!(
                "decode pipe needs a probed video (a nominal frame rate + dimensions)"
            ));
        }
        let (out_w, out_h) = scale.unwrap_or((info.resolution.width, info.resolution.height));
        let grid = crate::conform::from_frame(info, start);
        let own_scale = scale.map(|(sw, sh)| format!("scale={sw}:{sh}:flags=fast_bilinear"));

        let mut cmd = Command::new(ffmpeg_bin());
        cmd.args(["-hide_banner", "-loglevel", "error"]);
        if hwaccel {
            // Decoded frames are downloaded back to system memory (no
            // `-hwaccel_output_format`), so the `-vf scale` below and the
            // rgb24 output stay exactly as they are in software — verified
            // byte-identical on both this project's HEVC and H.264 sources.
            cmd.args(["-hwaccel", "videotoolbox"]);
        }
        cmd.args(&grid.input_args)
            .arg("-i")
            .arg(path)
            .args(["-an", "-sn"]);
        if let Some(vf) = grid.vf(own_scale.as_deref()) {
            cmd.args(["-vf", &vf]);
        }
        // `passthrough` is correct *because* the conform above already put the
        // stream on the grid — one output frame per grid slot. It is what stops
        // ffmpeg adding a second, redundant rate conversion of its own.
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
        RgbImage::from_raw(self.w, self.h, buf)
            .ok_or_else(|| anyhow!("rgb frame buffer size mismatch"))
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
    /// D-226 — the SECOND clip a video track shows while a cross-dissolve
    /// transition is running on it, keyed by that same track index.
    ///
    /// A transition is the one situation where a single track has two different
    /// sources open at two different positions for the same displayed frame, so
    /// it needs a second slot for exactly [`Self::Track`]'s own stated reason:
    /// sharing one would make each of the two calls restart the other's
    /// `ffmpeg` process, every frame, for the whole transition (B-040's measured
    /// ~0.85 fps failure mode). Which of the two clips lands here is
    /// deliberate — see `chroma_timeline::LayerRole`.
    TrackTransition(usize),
}

static PIPES: Lazy<Mutex<HashMap<PipeSlot, FramePipe>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Decode `target` via `slot`'s playback pipe, creating / advancing /
/// restarting it as needed. On any failure the slot's pipe is dropped and the
/// error returned; callers should fall back to [`crate::video::decode_frame`].
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

/// Drop every timeline pipe whose slot is not in `keep` — the Edit-tab preview
/// calls this once per frame with the slots actually visible there, so a track
/// that goes hidden, is deleted, or simply has a gap under the playhead releases
/// its `ffmpeg` process instead of holding one open for the rest of the session.
/// Bounds the pool at "one pipe per currently visible video layer" without
/// needing an arbitrary cap.
///
/// [`PipeSlot::Current`] is never dropped: it belongs to the Colorist tab's own
/// session, not to the Edit tab's frame, and nothing here knows whether that tab
/// still wants it.
///
/// **D-226 — takes real [`PipeSlot`]s, not bare track indices.** A cross
/// dissolve gives one track two live slots ([`PipeSlot::Track`] and
/// [`PipeSlot::TrackTransition`]) with genuinely different lifetimes: the
/// partner slot must be released the moment the transition window ends, while
/// the track's own slot keeps running. A track-index keep-list could not say
/// that, so it would have leaked one `ffmpeg` process per transition for the
/// rest of the session.
pub fn retain_pipe_slots(keep: &[PipeSlot]) {
    PIPES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|slot, _| match slot {
            PipeSlot::Current => true,
            other => keep.contains(other),
        });
}

/// How many pipes — and therefore how many live `ffmpeg` processes — the pool
/// currently holds. The observable the "one pipe per visible layer, released
/// when a layer goes away" contract is actually tested against (D-125).
/// Test-only — nothing in the running app needs to ask, and the house rule is
/// no dead code shipped "just in case". Behind the `test-support` feature
/// since D-146 rather than `#[cfg(test)]`: the tests that assert this contract
/// live in `app/src-tauri/src/chroma/edit.rs` (they drive the real multi-layer
/// compositor, which is what allocates and releases the slots), and a separate
/// crate's `#[cfg(test)]` items are unreachable from there. `app/src-tauri`
/// enables the feature from its `[dev-dependencies]` only, so a release build
/// still links none of this.
#[cfg(any(test, feature = "test-support"))]
pub fn open_pipe_count() -> usize {
    PIPES.lock().unwrap_or_else(|e| e.into_inner()).len()
}

/// Drop every playback pipe (frees the ffmpeg processes + their fds). Called
/// from `state::set_current_video` when the clip changes, and before an export.
pub fn reset() {
    PIPES.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// Drop every pipe currently decoding `path`, and report how many were dropped.
///
/// **Why this is needed at all, and why the other caches did not need it**
/// (D-260). Every *derived* cache over a source file in this crate keys on
/// [`crate::media_cache::source_key`] — `blake3(path ‖ mtime ‖ len)` — so a file
/// replaced in place is a key miss and a stale answer is impossible
/// ([`crate::probe`]'s own B-056 note is the history of getting that wrong).
/// A pipe is not a cache: it is a **live `ffmpeg` process with the file already
/// open**, and [`FramePipe::frame_scaled`] only respawns on a change of path,
/// scale, or seek distance — never on a change of the file's *content*. So when
/// a file is atomically replaced underneath it (`chroma::motion`'s render →
/// temp → `rename`, D-260), the process keeps its handle on the unlinked old
/// inode and keeps serving the OLD picture, correctly and indefinitely, while
/// every other consumer has already moved to the new one.
///
/// Deliberately by path and not [`reset`]: a Motion re-render replaces one
/// file, and dropping the whole pool would respawn an `ffmpeg` process for every
/// other visible layer and for the Colorist's own [`PipeSlot::Current`] — a
/// visible stall (B-040's measured failure mode) charged to clips that did not
/// change. [`PipeSlot::Current`] IS dropped when it is the pipe on this path,
/// unlike in [`retain_pipe_slots`]: there the caller is the Edit tab's
/// per-frame release, which has no business judging the Colorist's session; here
/// the file it is reading has genuinely been replaced.
pub fn drop_pipes_for_path(path: &Path) -> usize {
    let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());
    let before = pool.len();
    pool.retain(|_, pipe| pipe.path != path);
    before - pool.len()
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

    /// D-260 — `drop_pipes_for_path` drops exactly the pipes on that file and
    /// leaves every other one running.
    ///
    /// The "leaves every other one running" half is the whole reason this is
    /// not a [`reset`]: a Motion re-render replaces ONE file, and dropping the
    /// pool would respawn an `ffmpeg` process for every other visible layer and
    /// for the Colorist's own [`PipeSlot::Current`] — a stall charged to clips
    /// that did not change (B-040's measured failure mode).
    ///
    /// Uses `ffmpeg` directly to make two tiny fixtures rather than the
    /// env-gated real footage its siblings need: the property is about which
    /// entries leave the map, so any two decodable files will do.
    #[test]
    fn drop_pipes_for_path_drops_only_that_file() {
        let ffmpeg_ok = std::process::Command::new("ffmpeg")
            .arg("-version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ffmpeg_ok {
            eprintln!("skip: ffmpeg not on PATH");
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let make = |name: &str| {
            let p = tmp.path().join(name);
            let ok = std::process::Command::new("ffmpeg")
                .args([
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:size=64x64:rate=24:duration=1",
                    "-pix_fmt",
                    "yuv420p",
                ])
                .arg(&p)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .expect("spawn ffmpeg");
            assert!(ok.success());
            p
        };
        let a = make("a.mp4");
        let b = make("b.mp4");

        reset();
        let info_a = crate::video::probe(&a).expect("probe a");
        let info_b = crate::video::probe(&b).expect("probe b");
        // Three live pipes: two on `a` (one of them the Colorist's own slot,
        // which this call MUST drop and `retain_pipe_slots` never would), one
        // on `b`.
        playback_frame(PipeSlot::Track(0), &a, &info_a, 0).expect("a on track 0");
        playback_frame(PipeSlot::Current, &a, &info_a, 0).expect("a on Current");
        playback_frame(PipeSlot::Track(1), &b, &info_b, 0).expect("b on track 1");
        assert_eq!(open_pipe_count(), 3);

        assert_eq!(
            drop_pipes_for_path(&a),
            2,
            "both pipes on `a`, and only those"
        );
        assert_eq!(open_pipe_count(), 1, "`b`'s pipe keeps running");

        // Idempotent, and never touches an unrelated file.
        assert_eq!(drop_pipes_for_path(&a), 0);
        assert_eq!(open_pipe_count(), 1);
        reset();
    }

    #[test]
    fn pipe_matches_single_frame_decode() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = crate::video::probe(&vid).expect("probe");

        // frames 300, 301, 302 sequential out of the pipe...
        let mut pipe = FramePipe::open(&vid, &info, 300).expect("open pipe");
        let p300 = pipe.frame(&vid, &info, 300).expect("f300").to_rgb8();
        let p301 = pipe.frame(&vid, &info, 301).expect("f301").to_rgb8();
        let p302 = pipe.frame(&vid, &info, 302).expect("f302").to_rgb8();

        // ...must equal the independent per-frame decode path.
        for (n, piped) in [(300u64, &p300), (301, &p301), (302, &p302)] {
            let one = crate::video::decode_frame(&vid, crate::video::FramePos::Index(n), &info)
                .expect("decode_frame")
                .to_rgb8();
            assert_eq!(piped.dimensions(), one.dimensions(), "frame {n} dims");
            let diff = mean_abs_diff(piped, &one);
            assert!(
                diff < 1.0,
                "frame {n}: mean|Δ| {diff} between pipe and decode_frame"
            );
        }
    }

    #[test]
    fn pipe_forward_skip_and_backward_restart() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = crate::video::probe(&vid).expect("probe");
        let mut pipe = FramePipe::open(&vid, &info, 0).expect("open");

        let a = pipe
            .frame(&vid, &info, 10)
            .expect("skip fwd to 10")
            .to_rgb8();
        let b = pipe
            .frame(&vid, &info, 2)
            .expect("restart back to 2")
            .to_rgb8();

        let a_ref = crate::video::decode_frame(&vid, crate::video::FramePos::Index(10), &info)
            .expect("d10")
            .to_rgb8();
        let b_ref = crate::video::decode_frame(&vid, crate::video::FramePos::Index(2), &info)
            .expect("d2")
            .to_rgb8();
        assert!(mean_abs_diff(&a, &a_ref) < 1.0, "forward-skip landed wrong");
        assert!(
            mean_abs_diff(&b, &b_ref) < 1.0,
            "backward-restart landed wrong"
        );
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
        let info = crate::video::probe(&vid).expect("probe");
        let scale = scale_target(info.resolution.width, info.resolution.height, 1280);
        assert!(scale.is_some(), "C019 is 4K, should scale");
        let (sw, sh) = scale.unwrap();

        let mut pipe = FramePipe::open_scaled(&vid, &info, 200, scale).expect("open scaled");
        // three sequential scaled frames, correct dims, forward index advances
        for n in 200u64..203 {
            let f = pipe
                .frame_scaled(&vid, &info, n, scale)
                .expect("scaled frame")
                .to_rgb8();
            assert_eq!(f.dimensions(), (sw, sh), "frame {n} not at scale target");
        }
        // a scale change forces a respawn (native size back)
        let native = pipe
            .frame_scaled(&vid, &info, 203, None)
            .expect("native frame")
            .to_rgb8();
        assert_eq!(
            native.dimensions(),
            (info.resolution.width, info.resolution.height)
        );
    }

    // ----------------------------------------------------------------- //
    // B-104 / D-228 — the nominal frame grid, on a real VFR source.
    //
    // These synthesize their own footage with `ffmpeg` (the same technique
    // `audio.rs`'s tests use for test tones) rather than gating on
    // `CHROMA_TEST_VIDEO`, because the property under test needs a source
    // whose frame timing is KNOWN, not merely real.
    //
    // The fixture: `testsrc` at 30 fps for 4 s (120 frames, every frame
    // visibly different), with coded frames 30..=89 dropped and the survivors'
    // timestamps left untouched. That is 60 coded frames over 4.000 s, so
    // `avg_frame_rate` — and therefore `source_fps` — is exactly 15, while the
    // real picture holds still from t=0.9667 to t=3.0.
    //
    // On the 15 fps nominal grid that hold is unambiguous:
    //   slot 14 -> t=0.9333 -> coded frame 28
    //   slot 15 -> t=1.0000 -> coded frame 29   <-- hold starts
    //   slot 44 -> t=2.9333 -> coded frame 29   <-- hold ends
    //   slot 45 -> t=3.0000 -> coded frame 30
    // so slots 15..=44 MUST be one still picture and slots 14/45 MUST differ
    // from it. Pre-fix the pipe returned coded frames 15..=44 for those slots
    // — thirty different pictures, wandering up to 2 s away from the instant
    // the index names. That is B-104 in miniature.
    // ----------------------------------------------------------------- //

    /// 30 fps `testsrc`, coded frames 30..=89 dropped, timestamps preserved =>
    /// a genuine VFR source with `avg_frame_rate` 15 and one long hold.
    fn synth_vfr_with_a_hold(dir: &Path) -> PathBuf {
        let out = dir.join("vfr_hold.mp4");
        let status = Command::new(ffmpeg_bin())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("testsrc=size=160x120:rate=30:duration=4")
            .args([
                "-vf",
                "select='not(between(n,30,89))'",
                "-fps_mode",
                "passthrough",
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&out)
            .status()
            .expect("running ffmpeg to synthesize the VFR fixture");
        assert!(status.success(), "ffmpeg could not build the VFR fixture");
        out
    }

    /// Open a pipe with hardware decode **off**.
    ///
    /// These tests are about which *frame* a nominal index resolves to, and
    /// `videotoolbox` is a confound for that: on this synthetic h264 it returns
    /// the correct frame with slightly different pixels than the software
    /// decoder (measured mean|Δ| ≈ 1.8 — larger than the ≈ 0.5 between two
    /// adjacent `testsrc` frames), so a pixel threshold could not tell "wrong
    /// frame" from "different decoder". Forcing software makes the comparison
    /// exact. `pipe_matches_single_frame_decode` above still exercises the
    /// hardware path, on real footage, at the tolerance that difference needs.
    fn open_software(path: &Path, info: &VideoInfo, start: u64) -> FramePipe {
        FramePipe::open_with_hwaccel(path, info, start, None, false).expect("open pipe")
    }

    /// Plain 30 fps `testsrc` — the control, to prove the conform changes
    /// nothing for footage that already sits on its own grid.
    fn synth_cfr(dir: &Path) -> PathBuf {
        let out = dir.join("cfr.mp4");
        let status = Command::new(ffmpeg_bin())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("testsrc=size=160x120:rate=30:duration=3")
            .args(["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"])
            .arg(&out)
            .status()
            .expect("running ffmpeg to synthesize the CFR fixture");
        assert!(status.success(), "ffmpeg could not build the CFR fixture");
        out
    }

    /// The fixture is only a fixture if it really is variable-rate — assert the
    /// shape the other tests reason from, so a future ffmpeg that silently
    /// re-times it fails HERE rather than as a confusing failure downstream.
    #[test]
    fn the_vfr_fixture_really_is_variable_rate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_vfr_with_a_hold(dir.path());
        let info = crate::video::probe(&vid).expect("probe");
        assert_eq!((info.fps_num, info.fps_den), (15, 1), "avg_frame_rate");
        assert_eq!(info.frame_count, 60, "coded frames");
        assert!(
            (info.duration_secs - 4.0).abs() < 0.05,
            "{}",
            info.duration_secs
        );
        // 60 coded frames over 4 s is 15/s on AVERAGE — which is exactly what
        // makes this fixture dangerous, and exactly why `probe` preferring
        // `avg_frame_rate` is not the bug. The average is *right*; the source's
        // real tick is 30/s with a 2 s gap in it, so no single scalar rate can
        // describe where its frames actually are. That the average is
        // self-consistent is asserted here so the number is not mistaken for a
        // probe error later.
        assert!(
            (info.fps() * info.duration_secs - info.frame_count as f64).abs() < 1.0,
            "avg rate x duration should reproduce the coded frame count"
        );
    }

    /// **The B-104 regression test.** Across a hold, consecutive nominal frames
    /// name the same instant-range and must therefore be the same picture.
    #[test]
    fn a_held_frame_is_held_for_every_grid_slot_it_covers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_vfr_with_a_hold(dir.path());
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        // Walk the pipe forward exactly as playback does — no seeking.
        let mut pipe = open_software(&vid, &info, 0);
        let mut frames = Vec::new();
        for n in 0..=46u64 {
            frames.push(pipe.frame(&vid, &info, n).expect("frame").to_rgb8());
        }

        // Inside the hold every slot resolves to the SAME coded frame, so this
        // is byte equality, not a tolerance.
        for n in 16..=44usize {
            let d = mean_abs_diff(&frames[15], &frames[n]);
            assert_eq!(
                d, 0.0,
                "grid slot {n} is inside the hold that slot 15 starts, so it must be the \
                 identical picture — mean|Δ| {d}. Anything non-zero here is B-104: the pipe \
                 is counting coded frames again instead of nominal ones."
            );
        }

        // ...and the hold really is a hold, not a source that never changes.
        // `testsrc`'s adjacent frames sit ≈ 0.5 apart, so 0.1 is a comfortable
        // floor for "these are genuinely different pictures" while staying well
        // above the 0.0 the hold itself produces.
        const DISTINCT: f64 = 0.1;
        let before = mean_abs_diff(&frames[14], &frames[15]);
        let after = mean_abs_diff(&frames[44], &frames[45]);
        assert!(
            before > DISTINCT,
            "slot 14 precedes the hold and must differ from it ({before})"
        );
        assert!(
            after > DISTINCT,
            "slot 45 follows the hold and must differ from it ({after})"
        );
        // Guard the guard: if the fixture ever became a still image, every
        // assertion above would pass vacuously.
        assert!(
            mean_abs_diff(&frames[0], &frames[1]) > DISTINCT,
            "the fixture's own frames must differ, or this test proves nothing"
        );
    }

    /// A nominal frame index names one picture, no matter where the decoder
    /// happened to be opened. This is the property the live preview actually
    /// depends on: a scrub respawns the pipe, playback does not, and before
    /// D-228 those two routes to the same index returned different pictures —
    /// which is why the drift *snapped back* whenever the owner scrubbed.
    #[test]
    fn a_frame_is_the_same_picture_wherever_the_pipe_was_opened() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_vfr_with_a_hold(dir.path());
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        for target in [5u64, 15, 30, 44, 45, 55] {
            // reached by reading forward from the very start
            let mut seq = open_software(&vid, &info, 0);
            let mut walked = None;
            for n in 0..=target {
                walked = Some(seq.frame(&vid, &info, n).expect("walk").to_rgb8());
            }
            let walked = walked.expect("at least one frame");

            // reached by opening the pipe directly on it
            let opened = open_software(&vid, &info, target)
                .frame(&vid, &info, target)
                .expect("direct")
                .to_rgb8();

            let d = mean_abs_diff(&walked, &opened);
            assert_eq!(
                d, 0.0,
                "frame {target}: sequential vs. respawn differ, mean|Δ| {d}"
            );
        }
    }

    /// The pipe and the single-frame decoder are the same answer to the same
    /// question — including on VFR footage, where they used to disagree. The
    /// pipe falls back to `decode_frame` on any error, so a disagreement here
    /// would show up live as the picture jumping at a random moment.
    #[test]
    fn pipe_and_single_frame_decode_agree_on_a_vfr_source() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_vfr_with_a_hold(dir.path());
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        let mut pipe = open_software(&vid, &info, 0);
        for n in [0u64, 7, 15, 29, 44, 45, 58] {
            let piped = pipe.frame(&vid, &info, n).expect("pipe").to_rgb8();
            let one = crate::video::decode_frame(&vid, crate::video::FramePos::Index(n), &info)
                .expect("decode_frame")
                .to_rgb8();
            let d = mean_abs_diff(&piped, &one);
            assert_eq!(d, 0.0, "frame {n}: pipe vs decode_frame mean|Δ| {d}");
        }
    }

    /// The same agreement stated the other way round, on the axis that matters
    /// most: a `FramePos::Secs` question and a `FramePos::Index` question about
    /// the same instant must land on the same grid slot.
    #[test]
    fn a_time_query_and_a_frame_query_land_on_the_same_grid_slot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_vfr_with_a_hold(dir.path());
        let info = crate::video::probe(&vid).expect("probe");

        for n in [3u64, 20, 40, 50] {
            let by_index =
                crate::video::decode_frame(&vid, crate::video::FramePos::Index(n), &info)
                    .expect("by index")
                    .to_rgb8();
            // anywhere strictly inside slot `n`'s own span
            let secs = info.frame_to_secs(n) + 0.4 / info.fps();
            let by_time =
                crate::video::decode_frame(&vid, crate::video::FramePos::Secs(secs), &info)
                    .expect("by time")
                    .to_rgb8();
            assert_eq!(
                mean_abs_diff(&by_index, &by_time),
                0.0,
                "slot {n} via secs {secs}"
            );
        }
    }

    /// The control. On footage that is already on its grid the conform must be
    /// a no-op: every consecutive frame still advances (nothing is spuriously
    /// duplicated) and the two decode paths still agree.
    #[test]
    fn a_cfr_source_is_unaffected_by_the_conform() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_cfr(dir.path());
        let info = crate::video::probe(&vid).expect("probe");
        assert_eq!((info.fps_num, info.fps_den), (30, 1));
        reset();

        let mut pipe = open_software(&vid, &info, 0);
        let mut prev: Option<RgbImage> = None;
        for n in 0..12u64 {
            let f = pipe.frame(&vid, &info, n).expect("frame").to_rgb8();
            if let Some(p) = &prev {
                assert!(
                    mean_abs_diff(p, &f) > 0.1,
                    "frame {n} duplicates {}: the conform must not stall a CFR source",
                    n - 1
                );
            }
            let one = crate::video::decode_frame(&vid, crate::video::FramePos::Index(n), &info)
                .expect("decode_frame")
                .to_rgb8();
            assert_eq!(
                mean_abs_diff(&f, &one),
                0.0,
                "frame {n}: pipe vs decode_frame"
            );
            prev = Some(f);
        }
    }

    /// The same property as the synthetic tests, against a **real** VFR source,
    /// checked with an oracle that shares no code with the thing under test:
    /// `ffprobe`'s own PTS list says which coded frame is on screen at
    /// `n / source_fps`, and that frame is decoded by coded index.
    ///
    /// Env-gated (`CHROMA_TEST_VFR_VIDEO`) the same way
    /// [`pipe_matches_single_frame_decode`] is — real footage lives outside the
    /// repo. Run against the clip B-104 was reported on:
    ///
    /// ```text
    /// CHROMA_TEST_VFR_VIDEO=scratch/reel-src/before-1.09.51pm.mov \
    ///   cargo test -p chroma-media the_real_vfr_source
    /// ```
    #[test]
    fn the_real_vfr_source_resolves_every_index_to_the_picture_on_screen() {
        let Some(vid) = std::env::var("CHROMA_TEST_VFR_VIDEO")
            .ok()
            .map(PathBuf::from)
            .filter(|p| p.exists())
        else {
            eprintln!("skip: set CHROMA_TEST_VFR_VIDEO to a real variable-frame-rate clip");
            return;
        };
        let info = crate::video::probe(&vid).expect("probe");
        let fps = info.fps();
        assert!(fps > 0.0, "the fixture needs a real frame rate");

        // The oracle: every coded frame's presentation time, straight from
        // ffprobe. Nothing in `conform`/`decode_pipe` contributes to this.
        let out = Command::new(crate::video::ffprobe_bin())
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "frame=pts_time",
                "-of",
                "csv=p=0",
            ])
            .arg(&vid)
            .output()
            .expect("ffprobe frame list");
        let mut pts: Vec<f64> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().trim_end_matches(',').parse::<f64>().ok())
            .collect();
        pts.sort_by(|a, b| a.partial_cmp(b).expect("no NaN in a PTS list"));
        assert!(pts.len() > 1, "need a real frame list");

        // Only meaningful on footage that is actually variable-rate: if index
        // and time already agree everywhere, the test proves nothing.
        let worst = pts
            .iter()
            .enumerate()
            .map(|(k, p)| (p - k as f64 / fps).abs())
            .fold(0.0f64, f64::max);
        assert!(
            worst > 1.0 / fps,
            "CHROMA_TEST_VFR_VIDEO is effectively constant-rate (worst drift {worst:.4}s) — \
             point it at a screen recording or phone clip to exercise B-104"
        );
        eprintln!(
            "{} — {:.4} fps nominal, {} coded frames, worst index-vs-time drift {worst:.3}s",
            vid.display(),
            fps,
            pts.len()
        );

        // Reach each index the way playback does: one respawn, then sequential
        // reads. That is the arrangement in which B-104's error accumulated.
        let probes: Vec<u64> = [20u64, 208, 500, 866, 1020, 1228, 1600, 1948]
            .into_iter()
            .filter(|n| (*n as usize) < pts.len())
            .collect();
        let start = probes[0].saturating_sub(5);
        let mut pipe = open_software(&vid, &info, start);

        // Which coded frame did we get? Asked as "which of the candidates is
        // closest", not "is the residual zero".
        //
        // On real footage the residual against the right frame is small but not
        // always exactly zero: the pipe decodes forward from a seek, the oracle
        // decodes from frame 0, and H.264 recovery points that are not IDRs let
        // those two arrive at very slightly different pixels. That is an ffmpeg
        // property, not a frame mismatch — and it is exactly why this asserts
        // the ARGMIN over a neighbourhood. A wrong frame loses to the right one
        // by orders of magnitude; decoder noise does not move the argmin at all.
        for n in probes {
            let got = pipe.frame(&vid, &info, n).expect("pipe frame").to_rgb8();

            // truth: the last coded frame at or before n / fps
            let t = n as f64 / fps;
            let j = pts.partition_point(|p| *p <= t + 1e-9).saturating_sub(1);

            let here = mean_abs_diff(&got, &decode_coded_frame(&vid, j as u64));
            assert!(
                here < 1.0,
                "nominal frame {n} (t={t:.4}s) is not coded frame {j} (pts {:.4}) at all — \
                 mean|Δ| {here}",
                pts[j]
            );
            for k in 1..=3usize {
                for other in [j.checked_sub(k), (j + k < pts.len()).then_some(j + k)]
                    .into_iter()
                    .flatten()
                {
                    let d = mean_abs_diff(&got, &decode_coded_frame(&vid, other as u64));
                    assert!(
                        d > here,
                        "nominal frame {n} (t={t:.4}s) resolved closer to coded frame {other} \
                         (pts {:.4}, mean|Δ| {d}) than to coded frame {j} (pts {:.4}, \
                         mean|Δ| {here}) — the grid is off",
                        pts[other],
                        pts[j]
                    );
                }
            }
            eprintln!(
                "  frame {n:>5} (t={t:>8.4}s) -> coded {j:>5} (pts {:>8.4}) ok",
                pts[j]
            );
        }
    }

    /// Decode one frame **by coded index**, bypassing the nominal grid entirely
    /// — the independent oracle the real-file test compares against. Test-only
    /// on purpose: nothing in the app should ever address a source this way,
    /// which is the whole point of `conform`.
    fn decode_coded_frame(path: &Path, coded: u64) -> RgbImage {
        let out = Command::new(ffmpeg_bin())
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args([
                "-vf",
                &format!("select=eq(n\\,{coded})"),
                "-fps_mode",
                "passthrough",
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "png",
                "-pix_fmt",
                "rgb24",
                "-",
            ])
            .output()
            .expect("ffmpeg oracle decode");
        assert!(
            out.status.success(),
            "oracle decode of coded frame {coded} failed"
        );
        image::load_from_memory(&out.stdout)
            .expect("oracle PNG")
            .to_rgb8()
    }

    fn mean_abs_diff(a: &RgbImage, b: &RgbImage) -> f64 {
        let (n, sum) = a
            .as_raw()
            .iter()
            .zip(b.as_raw())
            .fold((0u64, 0u64), |(n, s), (x, y)| {
                (n + 1, s + (*x as i64 - *y as i64).unsigned_abs())
            });
        if n == 0 { 0.0 } else { sum as f64 / n as f64 }
    }
}
