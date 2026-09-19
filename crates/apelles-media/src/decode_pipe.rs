//! Persistent sequential-decode pipe for smooth scrub / playback (roadmap
//! round-2 item 5, D-030; multi-pipe pool + hardware decode, D-125; boundary
//! prefetch, D-324).
//!
//! What it is: one long-lived `ffmpeg -f rawvideo` process per *pipe slot* that
//!   streams frames sequentially, instead of a fresh process + keyframe seek +
//!   PNG round-trip per frame (`video::decode_frame`, D-015).
//! What it does: `playback_frame_scaled(slot, path, info, target, scale)`
//!   returns frame `target` as an 8-bit RGB `DynamicImage`. Cheap when `target`
//!   is the next frame or a short forward hop *for that slot*; a keyframe-seek
//!   respawn otherwise — or, since D-324, the adoption of a pipe `prefetch`
//!   primed for that exact jump.
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
//!
//! ## Why a respawn is prefetched rather than made cheaper (D-324, B-191)
//!
//! D-030 described a respawn as "no worse than today", which was true under its
//! stated assumption: rare scrubs on one long clip. A ripple-deleted timeline
//! (D-318/D-321) breaks that assumption completely — its cut boundaries are by
//! construction large, arbitrary jumps in source-frame space, so **every** one
//! of them is a forced respawn, and the owner's real recut had 95-155 of them
//! inside one continuous playthrough.
//!
//! What a respawn actually costs, measured on that footage (4K HEVC, decoded at
//! the preview's 1280 px scale): a sequential read is **6.7 ms**, a respawn is
//! **248-337 ms**, and `Command::spawn` is only **0.8-1.0 ms** of that. The cost
//! is ffmpeg's keyframe seek — not process creation, and not decode throughput.
//! That single fact decides the design: raising [`MAX_FORWARD_SKIP`] would only
//! discard more frames before paying the same seek, and proxy media (rejected
//! at D-030 and again at D-128) would still reseek at every boundary while
//! making cheaper the one part that was already 6.7 ms.
//!
//! So [`sync_prefetch`] spawns the next clip's `ffmpeg` early and lets the
//! seek happen *in that process*, concurrently, while this one keeps serving
//! the outgoing clip. Nothing reads the primed pipe until the boundary arrives,
//! which is what makes "spawn early, read later" the whole mechanism and why
//! there is no worker thread here. Measured end to end: 307 ms → 31 ms per cut.
//!
//! ## Why the standby set is a LIST per slot, and reconciled (D-330, B-200)
//!
//! D-324 kept exactly one standby per slot and aimed it at a single instant,
//! `pos + lookahead`. Two things break under a heavily recut timeline:
//!
//! 1. **A clip shorter than the lookahead has its own standby evicted by the
//!    clip after it.** With a single-instant lookahead the layer resolved at
//!    `pos + L` is already clip `N+2` while playback is still approaching clip
//!    `N+1`, so priming `N+2` replaced `N+1`'s standby before it was ever
//!    adopted — the boundary then paid the full respawn it was meant to hide,
//!    *and* wasted an `ffmpeg` doing it. The owner's real recut has 7 clips
//!    shorter than the lookahead, one of them a single frame.
//! 2. **A run of short clips needs its respawns overlapped, not serialised.**
//!    One standby per slot can only ever hide one boundary at a time.
//!
//! So the standby map holds up to [`MAX_STANDBY_PER_SLOT`] pipes per slot, and
//! [`sync_prefetch`] is **declarative**: the caller passes the complete set of
//! boundaries it wants primed, and anything primed but no longer wanted is
//! dropped. The Edit tab owns that decision because it is the only thing that
//! knows the edit list; this module only executes it. That also removes the
//! scattered "drop the standby if it can't serve this frame" cleanup D-324
//! needed, which was itself what made a chain impossible — a standby for a
//! LATER boundary cannot serve the current one by construction.
//!
//! ## Why the pool is keyed by (LANE, slot) since D-360
//!
//! A [`PipeSlot`] answers "which independently-sequential stream is this?" —
//! one per visible video track. That was the whole question while exactly one
//! thing walked the timeline at a time. D-350's headless render path made it
//! two (a preview and an export), and D-360's contiguous-segment render made it
//! N: several workers, each walking a *different stretch* of the same timeline
//! at the same moment, each decoding the same tracks.
//!
//! Every one of them calls [`retain_pipe_slots`] and [`sync_prefetch`] per
//! frame with the complete set of slots IT wants — both are declarative by
//! design (D-330) — so under one un-laned pool each walker released every other
//! walker's pipes on every frame. That is D-125/B-040's measured respawn storm
//! ("~0.85 fps") reproduced one level up. A [`PipeLane`] is the missing half of
//! the key: slot says which stream, lane says whose.
//!
//! **And the pool's lock is released across the blocking read** (D-360). It
//! used to be held for the whole of [`FramePipe::frame_scaled`] — the pipe
//! read, and on a respawn the 248-337 ms keyframe seek behind it — which made
//! every lane's decode serialise on one mutex regardless of how many lanes
//! there were. The pipe is checked out of the pool, read, and checked back in;
//! [`Checkout`]'s `Drop` is what guarantees it always returns. A second caller
//! for the *same* key waits, exactly as it used to wait on the pool mutex.
//!
//! ## The lead time is measured per source, not a constant (D-330)
//!
//! D-324 derived its fixed 0.5 s lead from a table measured on one file
//! (`…C038.MOV`), where a respawn cost 248-337 ms and 400 ms of lead brought the
//! first read down to 1.0 ms. That constant does not transfer: on the owner's
//! `…C040.MOV` the same measurement gives a **median 723 ms** time-to-first-frame
//! (min 460, max 2372 over 16 of the project's own cut points), and the lead
//! curve only reaches ~1 ms at **500-800 ms** of lead, with 400 ms still costing
//! 51 ms. Half a second was sitting exactly on the knee of the curve for this
//! footage, which is why cuts still hitched.
//!
//! Rather than pick a second magic constant that the next source file
//! invalidates too, every un-hidden respawn now *measures itself*
//! ([`record_seek_cost`]) and [`estimated_seek_ms`] reports an EWMA per source,
//! which the scheduler turns into that source's lead time. A respawn is the one
//! event that has to happen anyway, so the measurement is free.

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

/// How many boundaries one slot may have primed at once (D-330).
///
/// A run of clips shorter than the lead time needs its respawns overlapped, and
/// one standby per slot can only hide one boundary. Three is the smallest number
/// that covers the shapes this project actually contains — its longest run of
/// consecutive sub-lookahead clips is two — with one spare.
///
/// It is a cap and not a target: [`sync_prefetch`] primes only the boundaries
/// the caller actually asked for, which mid-clip is none at all. The cost of the
/// cap being wrong in the generous direction is bounded and was measured: a
/// spawned-and-killed 4K HEVC `ffmpeg` alongside a live sequential read moved
/// that read's median from 7.13 ms to 6.62 ms, i.e. not at all.
pub const MAX_STANDBY_PER_SLOT: usize = 3;

/// Per-source EWMA of what a respawn's keyframe seek actually costs, in ms
/// (D-330) — see the module doc. Written by [`record_seek_cost`] on every
/// un-hidden respawn, read by [`estimated_seek_ms`].
static SEEK_COST: Lazy<Mutex<HashMap<PathBuf, f64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Weight given to the newest sample. Low enough that one unlucky respawn
/// (a cold page cache, a busy machine) cannot swing the estimate far, high
/// enough that a genuinely different source converges within a handful of cuts.
const SEEK_COST_ALPHA: f64 = 0.3;

/// Fold one measured respawn — `open_scaled` through its first frame — into
/// `path`'s estimate.
fn record_seek_cost(path: &Path, ms: f64) {
    if !ms.is_finite() || ms < 0.0 {
        return;
    }
    let mut costs = SEEK_COST.lock().unwrap_or_else(|e| e.into_inner());
    let next = match costs.get(path) {
        Some(prev) => prev * (1.0 - SEEK_COST_ALPHA) + ms * SEEK_COST_ALPHA,
        None => ms,
    };
    costs.insert(path.to_path_buf(), next);
}

/// What a respawn on `path` has been measured to cost, or `None` if this source
/// has never paid one in this session.
///
/// The scheduler turns this into that source's prefetch lead time. `None` is not
/// a failure — it means "no cut has been crossed cold yet", and the caller is
/// expected to fall back to its own default rather than to guess from this
/// module's numbers.
pub fn estimated_seek_ms(path: &Path) -> Option<f64> {
    SEEK_COST
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(path)
        .copied()
}

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
    /// frame `start + n` as the rest of Apelles defines it — the picture at
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

    /// Whether this pipe can produce `target` by reading forward — i.e. without
    /// the kill-and-respawn a keyframe seek costs. The same source, the same
    /// output scale, and a target that is either the very next frame or a short
    /// enough forward hop to be cheaper to discard than to seek to.
    ///
    /// Factored out of [`Self::frame_scaled`] by D-324 because the prefetch
    /// needs to ask exactly this question of two *different* pipes: of the live
    /// one ("do I even need to prime anything?") and of a primed standby ("can
    /// this one be adopted for the frame actually being asked for?").
    fn can_serve(&self, path: &Path, target: u64, scale: Option<(u32, u32)>) -> bool {
        path == self.path
            && scale == self.scale
            && target >= self.next_index
            && target <= self.next_index + MAX_FORWARD_SKIP
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
        let need_restart = !self.can_serve(path, target, scale);

        if need_restart {
            // D-330 — a respawn is the one event that measures its own cost, so
            // measure it. `open_scaled` + the first `read_raw` IS the keyframe
            // seek the prefetch exists to hide, and the scheduler needs to know
            // how big it is on THIS source to know how far ahead to prime.
            // Timed here rather than around the call because only this branch
            // is a seek: the `else` below is a forward read, and an adopted
            // standby never reaches this branch at all.
            let started = std::time::Instant::now();
            *self = Self::open_scaled(path, info, target, scale)?;
            let img = self.read_raw()?;
            record_seek_cost(path, started.elapsed().as_secs_f64() * 1000.0);
            return Ok(DynamicImage::ImageRgb8(img));
        }
        while self.next_index < target {
            self.skip_raw()?;
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
    /// deliberate — see `apelles_timeline::LayerRole`.
    TrackTransition(usize),
}

/// **Which independent SET of decode pipes a caller owns (D-360).**
///
/// A [`PipeSlot`] says "this is one sequential stream"; a lane says "…belonging
/// to this one walker of the timeline". They are different questions, and
/// before D-360 only the first was asked — so two walkers at two different
/// timeline positions shared one pool and each one's per-frame
/// [`retain_pipe_slots`] / [`sync_prefetch`] released the other's pipes, every
/// frame. That is exactly the failure D-125/B-040 already fixed once, a level
/// up: the same reason two layers need two slots is the reason two walkers need
/// two lanes.
///
/// **[`PipeLane::LIVE`] is the whole app as it was before D-360** — the Edit
/// tab's preview, the Colorist tab, thumbnails. Nothing in the running app
/// passes anything else, so live playback's pool behaviour is unchanged by
/// construction rather than by care. Only `chroma::edit_render`'s headless
/// render workers take a [`PipeLane::render`] lane, one each.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct PipeLane(u16);

impl PipeLane {
    /// The live app. Everything that existed before D-360 runs here.
    pub const LIVE: PipeLane = PipeLane(0);

    /// The `n`th headless render worker's own lane — never [`Self::LIVE`], so a
    /// background render can neither release nor reposition a pipe the preview
    /// is using, and two render workers can never do it to each other.
    ///
    /// Saturating rather than wrapping: `n` is a segment index bounded by the
    /// machine's core count two layers up, so the clamp is unreachable — but
    /// wrapping it would silently alias lane 0, which is the one lane that must
    /// never be handed out here.
    pub fn render(n: usize) -> Self {
        PipeLane(n.saturating_add(1).min(u16::MAX as usize) as u16)
    }
}

/// What the pool is actually keyed by since D-360: one sequential stream,
/// belonging to one walker of the timeline.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
struct PipeKey {
    lane: PipeLane,
    slot: PipeSlot,
}

/// A pipe's state in the pool while a caller is decoding with it (D-360).
///
/// The pipe itself is not here — it has been handed to that caller and is out
/// of the map entirely, which is the entire point: the blocking pipe read that
/// follows must not hold the pool's lock, or every lane serialises on one
/// caller's `read_exact` and the lanes buy nothing (see [`check_out`]).
///
/// What stays behind is a claim on the key, so that a second caller for the
/// same key waits for the pipe rather than spawning a rival `ffmpeg` on the
/// same stream, and so that a release arriving mid-decode has somewhere to
/// record itself.
struct Checkedout {
    /// The source the checkout was made for. A release by path
    /// ([`drop_pipes_for_path`]) cannot see the pipe to ask it, so the pipe
    /// says where it is going before it leaves.
    path: PathBuf,
    /// Set by a release that ran while the pipe was out. [`check_in`] honours
    /// it by dropping the pipe instead of putting it back — a released pipe
    /// stays released, even if the release lost the race.
    doomed: bool,
}

/// One live-pipe entry: in the pool, or out with a caller.
enum LiveEntry {
    /// In the pool, mid-stream, ready to be checked out.
    Idle(FramePipe),
    /// Checked out — see [`Checkedout`].
    Busy(Checkedout),
}

/// The live pipes, plus D-324's primed-but-unread ones.
///
/// **One mutex over both maps, not two mutexes.** Every interesting operation
/// touches both (a decode may adopt a standby; a release must drop both a
/// slot's live pipe and its standby), so two locks would mean a lock ORDER —
/// an invariant nothing in the type system would hold us to, for no gain.
#[derive(Default)]
struct PipePool {
    /// One per key, mid-stream, `next_index` at whatever was last read — or a
    /// [`LiveEntry::Busy`] claim while some caller is decoding with it.
    live: HashMap<PipeKey, LiveEntry>,
    /// **D-324 — pipes spawned ahead of a known cut boundary and not yet read
    /// from. D-330 — up to [`MAX_STANDBY_PER_SLOT`] of them per slot, in the
    /// order the boundaries will be reached.**
    ///
    /// Each one's `ffmpeg` is already running, already past its keyframe seek,
    /// already decoding — which is the entire cost a respawn pays (measured:
    /// 0.8-1.0 ms to `spawn`, then 248-337 ms on D-324's source and a median
    /// 723 ms on the owner's `C040` before the first frame comes out). Adopting
    /// one at the boundary turns that into the ~1 ms of a pipe read.
    ///
    /// A standby is never *required*: [`playback_frame_scaled`] adopts one only
    /// if it can genuinely serve the frame being asked for, and otherwise
    /// respawns exactly as before. So a wrong prediction costs one wasted
    /// `ffmpeg`, never a wrong picture.
    ///
    /// **Why a list and not one** — see the module doc: a clip shorter than the
    /// lead time used to have its own standby evicted by the clip after it, and
    /// a run of short clips needs its respawns overlapped rather than
    /// serialised.
    standby: HashMap<PipeKey, Vec<FramePipe>>,
}

static PIPES: Lazy<Mutex<PipePool>> = Lazy::new(|| Mutex::new(PipePool::default()));

/// Signalled every time a checked-out pipe comes back (D-360). Waited on only
/// by a second caller for the *same* key — the case that used to serialise on
/// the pool mutex itself, and still serialises, just without holding the lock
/// that every other lane needs.
static PIPE_RETURNED: std::sync::Condvar = std::sync::Condvar::new();

/// Take `key`'s pipe OUT of the pool for the duration of a blocking decode,
/// adopting a primed standby first if the live pipe cannot serve this frame.
///
/// **Why the pipe leaves the map at all (D-360).** Everything expensive about a
/// decode — `read_exact` on the pipe, and on a respawn the keyframe seek behind
/// it, measured at 248-337 ms and a median 723 ms on the owner's C040 — happens
/// *inside* [`FramePipe::frame_scaled`]. Before D-360 that ran with the pool
/// mutex held, which was free while one thread walked the timeline and is fatal
/// the moment several do: N render segments would each wait their turn on one
/// global lock and decode exactly as sequentially as one of them did. Handing
/// the pipe out and taking the lock again only to hand it back is what makes a
/// lane's decode genuinely concurrent with every other lane's.
///
/// Blocks only on a second caller for this exact key, which is the same
/// serialisation the pool mutex used to impose on it.
fn check_out(key: PipeKey, path: &Path, target: u64, scale: Option<(u32, u32)>) -> Checkout {
    let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());
    while matches!(pool.live.get(&key), Some(LiveEntry::Busy(_))) {
        pool = PIPE_RETURNED.wait(pool).unwrap_or_else(|e| e.into_inner());
    }

    // D-324 — the boundary crossing. If this key's live pipe cannot serve
    // `target` (a cut: the source frame jumped somewhere a forward read can't
    // reach) but a standby primed for exactly this moment can, adopt it. The
    // old pipe drops here, killing its `ffmpeg`; the primed one takes its place
    // with its seek already paid.
    //
    // Both halves of the condition matter. Only consulting the standbys when the
    // live pipe has genuinely failed keeps the ordinary mid-clip frame on the
    // exact code path it was always on. And re-checking `can_serve` on the
    // standby itself is what makes a mispredicted prefetch harmless: playback
    // that jumped somewhere else entirely simply does not adopt it.
    let live_can_serve = matches!(
        pool.live.get(&key),
        Some(LiveEntry::Idle(p)) if p.can_serve(path, target, scale)
    );
    if !live_can_serve && let Some(primed) = pool.standby.get_mut(&key) {
        // **D-330 — take the one that serves this boundary and LEAVE the rest.**
        // D-324 removed the slot's standby unconditionally here, on the grounds
        // that a standby which cannot serve the current frame is an overtaken
        // prediction. That is exactly wrong once there is a chain: the standby
        // for boundary `N+2` cannot serve boundary `N+1` *by construction*, so
        // the unconditional drop was what made a chain impossible. Releasing a
        // genuinely stale standby is `sync_prefetch`'s job now — it is handed
        // the complete wanted set every frame and drops everything else.
        if let Some(i) = primed.iter().position(|p| p.can_serve(path, target, scale)) {
            let adopted = primed.remove(i);
            log::trace!(
                "decode pipe: adopted a primed pipe for {key:?} at frame {target} \
                 instead of respawning ({} standby left)",
                primed.len()
            );
            pool.live.insert(key, LiveEntry::Idle(adopted));
        }
    }

    let claim = LiveEntry::Busy(Checkedout {
        path: path.to_path_buf(),
        doomed: false,
    });
    let pipe = match pool.live.insert(key, claim) {
        Some(LiveEntry::Idle(pipe)) => Some(pipe),
        // Unreachable: the wait above returns only with this key not busy, and
        // the pool lock has been held ever since. Handled as "no pipe" rather
        // than a panic because this module's whole contract is that a pipe is a
        // fast path and never a new failure mode — the worst a miss can cost is
        // one respawn.
        Some(LiveEntry::Busy(_)) | None => None,
    };
    Checkout { key, pipe }
}

/// A pipe on loan from the pool, for exactly one decode (D-360).
///
/// **RAII, and that is load-bearing rather than tidy.** Every way out of a
/// decode — the frame, a pipe error, a hardware-decode fallback, a `?` on
/// something else entirely, a panic — has to return the key to the pool, or
/// that key stays [`LiveEntry::Busy`] forever and the next caller for it waits
/// on a condvar that will never be signalled. A `Drop` impl is the only exit
/// path a future edit to this function cannot forget to take.
struct Checkout {
    key: PipeKey,
    /// `None` once the decode has failed and the pipe has been discarded, or
    /// before one has been opened at all.
    pipe: Option<FramePipe>,
}

impl Drop for Checkout {
    fn drop(&mut self) {
        let key = self.key;
        let returning = self.pipe.take();
        // Dropped after the lock is released: killing and reaping an `ffmpeg`
        // is not something every other lane should be made to wait behind.
        let discarded = {
            let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());
            let doomed = matches!(
                pool.live.get(&key),
                Some(LiveEntry::Busy(c)) if c.doomed
            );
            match returning {
                Some(pipe) if !doomed => {
                    pool.live.insert(key, LiveEntry::Idle(pipe));
                    None
                }
                // Either the decode poisoned it (next call respawns clean, as
                // before D-360) or a release claimed it while it was out.
                other => {
                    pool.live.remove(&key);
                    other
                }
            }
        };
        PIPE_RETURNED.notify_all();
        drop(discarded);
    }
}

/// Mark `key` for release, or release it now — whichever is possible.
///
/// A pipe that is [`LiveEntry::Busy`] cannot simply be removed: some caller is
/// decoding with it and holds the only handle. Dooming it instead makes the
/// release land at [`Checkout::drop`], which is the same observable outcome one
/// decode later. Returns the pipe when it could be taken now, so the caller can
/// drop it outside the pool lock.
fn release_key(pool: &mut PipePool, key: PipeKey) -> Option<FramePipe> {
    match pool.live.get_mut(&key) {
        Some(LiveEntry::Busy(claim)) => {
            claim.doomed = true;
            None
        }
        _ => match pool.live.remove(&key) {
            Some(LiveEntry::Idle(pipe)) => Some(pipe),
            _ => None,
        },
    }
}

/// Decode `target` via `slot`'s playback pipe, creating / advancing /
/// restarting it as needed. On any failure the slot's pipe is dropped and the
/// error returned; callers should fall back to [`crate::video::decode_frame`].
///
/// Native-size convenience wrapper; scrub goes through
/// `playback_frame_scaled(.., None)`, kept for API symmetry.
#[allow(dead_code)]
pub fn playback_frame(
    lane: PipeLane,
    slot: PipeSlot,
    path: &Path,
    info: &VideoInfo,
    target: u64,
) -> Result<DynamicImage> {
    playback_frame_scaled(lane, slot, path, info, target, None)
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
///
/// **D-360 — the pool's lock is NOT held across the decode.** The pipe is
/// checked out of the pool, read off-lock, and checked back in; see
/// [`check_out`] for why, and [`Checkout`] for what guarantees it always goes
/// back. For a single-threaded caller (all of live playback) the observable
/// behaviour is identical to before.
pub fn playback_frame_scaled(
    lane: PipeLane,
    slot: PipeSlot,
    path: &Path,
    info: &VideoInfo,
    target: u64,
    scale: Option<(u32, u32)>,
) -> Result<DynamicImage> {
    let key = PipeKey { lane, slot };
    let mut held = check_out(key, path, target, scale);

    // D-330 — a COLD open is a keyframe seek too, and has to be measured like
    // one. It does not reach `frame_scaled`'s respawn branch: the pipe it opens
    // starts at `target`, so `can_serve` is true and the first frame is read
    // forward. Timed here instead, around the open and that first read
    // together, which is the same span `frame_scaled` measures for a respawn.
    let was_vacant = held.pipe.is_none();
    let started = std::time::Instant::now();
    if held.pipe.is_none() {
        held.pipe = Some(FramePipe::open_scaled(path, info, target, scale)?);
    }
    let Some(pipe) = held.pipe.as_mut() else {
        return Err(anyhow!("decode pipe vanished between open and read"));
    };

    let was_hwaccel = pipe.hwaccel;
    let decoded = pipe.frame_scaled(path, info, target, scale);
    if was_vacant && decoded.is_ok() {
        record_seek_cost(path, started.elapsed().as_secs_f64() * 1000.0);
    }
    match decoded {
        Ok(img) => Ok(img),
        Err(e) => {
            held.pipe = None; // poison → next call respawns clean
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
            held.pipe = Some(sw);
            Ok(img)
        }
    }
}

/// One cut boundary the caller wants primed — everything a spawn needs.
pub struct PrefetchSpec<'a> {
    /// Which sequential-decode stream this boundary belongs to.
    pub slot: PipeSlot,
    pub path: &'a Path,
    pub info: &'a VideoInfo,
    /// The clip's FIRST source frame — see `sync_prefetch`'s own doc.
    pub target: u64,
    pub scale: Option<(u32, u32)>,
}

/// **D-324/D-330 — make the primed standby set exactly `wanted`.**
///
/// Spawns an `ffmpeg` for each boundary in `wanted` that is not already primed,
/// so that by the time playback crosses into that clip the keyframe seek has
/// already happened in a separate process and the first read is a pipe read
/// rather than a ~0.7 s stall. Anything currently primed and NOT in `wanted` is
/// dropped, killing its `ffmpeg`.
///
/// **Declarative, not incremental, and that is the point (D-330).** The caller —
/// the Edit tab — is the only thing that knows the edit list, so it is the only
/// thing that can say which boundaries are still worth holding a process open
/// for. D-324's incremental `prefetch(one boundary)` had to guess at the
/// release side, and its guess ("drop a standby that cannot serve the frame in
/// hand") is precisely what stopped a chain of short clips from ever working:
/// the standby for boundary `N+2` cannot serve boundary `N+1`. Handing the whole
/// wanted set over each frame makes the lifetime question disappear — anything
/// not asked for is not wanted.
///
/// So this is also the ONLY thing that releases a standby in the normal course
/// of play, and callers must call it every frame, including with an empty
/// `wanted` when nothing should be primed at all (a scrub, a pause). The other
/// releases are exceptional: the file was replaced ([`drop_pipes_for_path`]) or
/// the session ended ([`reset`]).
///
/// **Cheap to call every frame.** A boundary already primed for exactly this
/// `(path, target, scale)` is left strictly alone — its seek keeps running,
/// undisturbed — so calling this on every frame of the approach is what makes
/// the lead time real rather than a spawn repeated per frame.
///
/// **No thread.** `Command::spawn` measured 0.8-1.0 ms against the owner's real
/// 4K HEVC footage, against 460-2372 ms for the seek-and-decode that follows it
/// — and that part already runs concurrently, in the child process, because
/// nothing reads the pipe until the boundary arrives. A worker thread would add
/// a lifetime and a cancellation protocol to hide a millisecond.
///
/// Errors are swallowed deliberately. A prefetch is an optimisation with a
/// complete fallback (the respawn that would have happened anyway), so a
/// failure to spawn one must never become a failure to show a frame.
///
/// **D-360 — scoped to one [`PipeLane`].** `wanted` is this lane's complete
/// set, so the release half must not reach into another lane's standbys: a
/// render segment priming nothing at all (every export frame is
/// `FrameIntent::Single`) would otherwise drop every boundary live playback had
/// primed, on every frame it rendered.
pub fn sync_prefetch(lane: PipeLane, wanted: &[PrefetchSpec<'_>]) {
    let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());

    // 1. Release everything no longer wanted. A standby matches a spec when it
    //    is the same source at the same scale primed at exactly that frame —
    //    `next_index` is where the pipe will start reading, and nothing has
    //    read from it, so it is still the frame it was spawned for.
    let still_wanted = |key: PipeKey, p: &FramePipe| {
        wanted.iter().any(|w| {
            w.slot == key.slot && w.path == p.path && w.scale == p.scale && w.target == p.next_index
        })
    };
    for (key, primed) in pool.standby.iter_mut() {
        if key.lane != lane {
            continue; // another lane's prediction is not ours to overrule
        }
        primed.retain(|p| still_wanted(*key, p));
    }
    pool.standby.retain(|_, primed| !primed.is_empty());

    // 2. Spawn whatever is wanted and not already running.
    for spec in wanted {
        let key = PipeKey {
            lane,
            slot: spec.slot,
        };
        // Reading forward from where this slot already is will reach the
        // boundary on its own — no second process needed. This is what makes a
        // clip already under the playhead cost nothing here.
        //
        // A pipe that is checked out right now (D-360) reads as "cannot serve",
        // which is conservative in the harmless direction — it costs at most one
        // standby `ffmpeg` that the next frame's `still_wanted` pass releases.
        // It also cannot arise on the path that matters: the Edit tab primes
        // AFTER it has decoded, on the same thread, so its own key is idle.
        if matches!(
            pool.live.get(&key),
            Some(LiveEntry::Idle(p)) if p.can_serve(spec.path, spec.target, spec.scale)
        ) {
            continue;
        }
        let primed = pool.standby.entry(key).or_default();
        if primed
            .iter()
            .any(|p| p.path == spec.path && p.scale == spec.scale && p.next_index == spec.target)
        {
            continue; // already seeking for exactly this boundary
        }
        if primed.len() >= MAX_STANDBY_PER_SLOT {
            continue; // the cap, not an error — the far boundaries wait a frame
        }
        match FramePipe::open_scaled(spec.path, spec.info, spec.target, spec.scale) {
            Ok(pipe) => {
                log::trace!(
                    "decode pipe: primed {:?} for {} @ frame {}",
                    spec.slot,
                    spec.path.display(),
                    spec.target
                );
                primed.push(pipe);
            }
            Err(e) => log::debug!(
                "decode pipe: could not prime {:?} for {} @ frame {}: {e}",
                spec.slot,
                spec.path.display(),
                spec.target
            ),
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
///
/// **D-330 — this releases LIVE pipes only.** D-324 had it release a slot's
/// standby on the same rule, which was right while the standby set was built
/// incrementally and nothing else could release it. It is now redundant and
/// therefore gone: [`sync_prefetch`] is handed the complete wanted set every
/// frame and drops everything else, so a standby for a track that has gone
/// hidden or been deleted is already released by the same call that stops
/// asking for it — one owner for that lifetime instead of two.
///
/// **D-360 — releases only `lane`'s own pipes.** Every walker of the timeline
/// calls this every frame with the slots visible at ITS position, so a
/// lane-blind release would have each render segment free the pipes of every
/// other segment and of the live preview, once per frame — the D-125/B-040
/// respawn storm, one level up.
pub fn retain_pipe_slots(lane: PipeLane, keep: &[PipeSlot]) {
    let mut dropped: Vec<FramePipe> = Vec::new();
    {
        let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());
        let release: Vec<PipeKey> = pool
            .live
            .keys()
            .copied()
            .filter(|key| {
                key.lane == lane
                    && match key.slot {
                        PipeSlot::Current => false,
                        other => !keep.contains(&other),
                    }
            })
            .collect();
        for key in release {
            dropped.extend(release_key(&mut pool, key));
        }
    }
    // Outside the lock: a `FramePipe`'s drop kills and reaps an `ffmpeg`.
    drop(dropped);
}

/// **Drop everything `lane` owns — live pipes and primed standbys (D-360).**
///
/// What a headless render worker calls when its segment is finished. Without
/// it a segment's decoders would stay resident until the process exited, which
/// is precisely the unbounded-per-unit shape B-229/B-230 were about: the whole
/// point of splitting an export into N segments is that the Nth one's cost
/// stops when it does.
///
/// Not how the live app resets itself — [`PipeLane::LIVE`] owns the Colorist
/// tab's [`PipeSlot::Current`] as well, and nothing but [`reset`] has the
/// standing to end that session.
pub fn release_lane(lane: PipeLane) {
    let mut dropped: Vec<FramePipe> = Vec::new();
    {
        let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());
        let keys: Vec<PipeKey> = pool
            .live
            .keys()
            .copied()
            .filter(|key| key.lane == lane)
            .collect();
        for key in keys {
            dropped.extend(release_key(&mut pool, key));
        }
        let primed: Vec<PipeKey> = pool
            .standby
            .keys()
            .copied()
            .filter(|key| key.lane == lane)
            .collect();
        for key in primed {
            dropped.extend(pool.standby.remove(&key).unwrap_or_default());
        }
    }
    drop(dropped);
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
    PIPES.lock().unwrap_or_else(|e| e.into_inner()).live.len()
}

/// How many D-324 standby pipes are primed right now, across every slot — the
/// observable the "a prefetch is adopted, superseded or released, never leaked"
/// contract is tested against. Test-only, same rationale and same gate as
/// [`open_pipe_count`].
///
/// D-330: counts PIPES, not slots. A slot may hold up to
/// [`MAX_STANDBY_PER_SLOT`] of them, and the number this has to bound is the
/// number of live `ffmpeg` processes.
#[cfg(any(test, feature = "test-support"))]
pub fn standby_pipe_count() -> usize {
    PIPES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .standby
        .values()
        .map(Vec::len)
        .sum()
}

/// Drop every playback pipe, primed standbys included (frees the ffmpeg
/// processes + their fds). Called from `state::set_current_video` when the clip
/// changes, and before an export.
/// D-360: a pipe checked out for a decode in flight cannot be taken away from
/// the thread holding it, so it is marked instead and dropped the moment that
/// decode returns — the same observable outcome, one frame later.
pub fn reset() {
    let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());
    let keys: Vec<PipeKey> = pool.live.keys().copied().collect();
    for key in keys {
        let _ = release_key(&mut pool, key);
    }
    pool.standby.clear();
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
///
/// **D-324 — drops a primed standby on that path too**, and counts it. Exactly
/// the same argument: a standby holds the replaced file's old inode open just
/// as firmly as a live pipe does, and adopting it after the swap would serve
/// the stale picture from a process nothing else can see.
pub fn drop_pipes_for_path(path: &Path) -> usize {
    let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());
    // D-330 — the measured seek cost goes with them. It is keyed by path, and
    // the path now points at a different file; what the old inode cost to seek
    // says nothing about what the new one will.
    SEEK_COST
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(path);
    let standby_count = |pool: &PipePool| pool.standby.values().map(Vec::len).sum::<usize>();
    let before = pool.live.len() + standby_count(&pool);
    // D-360 — across EVERY lane: the file on disk has been replaced, which is
    // true for the live preview and for a render segment alike. A checked-out
    // pipe is matched on the source its checkout recorded, since the pipe
    // itself is out with its caller and cannot be asked.
    let on_path: Vec<PipeKey> = pool
        .live
        .iter()
        .filter(|(_, entry)| match entry {
            LiveEntry::Idle(pipe) => pipe.path == path,
            LiveEntry::Busy(claim) => claim.path == path,
        })
        .map(|(key, _)| *key)
        .collect();
    let mut still_held = 0usize;
    for key in on_path {
        if release_key(&mut pool, key).is_none() {
            // Doomed rather than removed — it is out with a caller and leaves
            // the pool when that decode returns. It is no longer servable, so
            // it counts as dropped.
            still_held += 1;
        }
    }
    for primed in pool.standby.values_mut() {
        primed.retain(|pipe| pipe.path != path);
    }
    pool.standby.retain(|_, primed| !primed.is_empty());
    before - (pool.live.len() + standby_count(&pool)) + still_held
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Serialises every test that touches the process-global [`PIPES`] pool.
    ///
    /// The pool is one global, and these tests assert on its exact contents
    /// ([`open_pipe_count`], [`standby_pipe_count`]) after calling [`reset`],
    /// which clears it for the whole process. Run in parallel, one test's
    /// `reset()` lands in the middle of another's arrange/assert and the
    /// counts are whatever the interleaving happened to produce. Same
    /// reasoning — and the same "one lock, one global" rule — as
    /// `chroma::audio`'s `session_test_guard` and `PROJECT_STATE_LOCK`.
    ///
    /// Taken by every test below that calls `reset`, `prefetch`,
    /// `playback_frame*`, `retain_pipe_slots` or `drop_pipes_for_path` —
    /// including the ones that only `reset()` before driving their own
    /// standalone `FramePipe`, since that `reset()` is itself the thing that
    /// disturbs a concurrent pool test.
    static POOL_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn pool_guard() -> std::sync::MutexGuard<'static, ()> {
        POOL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn test_video() -> Option<PathBuf> {
        std::env::var("CHROMA_TEST_VIDEO")
            .ok()
            .map(PathBuf::from)
            .filter(|p| p.exists())
    }

    /// Prime exactly one boundary, ADDING it to whatever this slot already has.
    ///
    /// D-330 made the production API declarative ([`sync_prefetch`] is handed
    /// the complete wanted set), which is right for the scheduler and awkward
    /// for a test asserting one step at a time. This keeps those tests reading
    /// as "prime this, now assert" rather than rebuilding the whole wanted set
    /// on every line — it is a test affordance, not a second production path.
    fn prime_one(
        slot: PipeSlot,
        path: &Path,
        info: &VideoInfo,
        target: u64,
        scale: Option<(u32, u32)>,
    ) {
        /// One standby's identity, owned — `sync_prefetch` borrows its specs,
        /// so the snapshot of what is already primed has to outlive the lock.
        struct StandbyId {
            slot: PipeSlot,
            path: PathBuf,
            target: u64,
            scale: Option<(u32, u32)>,
        }

        let mut want: Vec<StandbyId> = PIPES
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .standby
            .iter()
            .flat_map(|(key, pipes)| {
                pipes.iter().map(|p| StandbyId {
                    slot: key.slot,
                    path: p.path.clone(),
                    target: p.next_index,
                    scale: p.scale,
                })
            })
            .collect();
        want.push(StandbyId {
            slot,
            path: path.to_path_buf(),
            target,
            scale,
        });
        let specs: Vec<PrefetchSpec<'_>> = want
            .iter()
            .map(|w| PrefetchSpec {
                slot: w.slot,
                path: &w.path,
                info,
                target: w.target,
                scale: w.scale,
            })
            .collect();
        sync_prefetch(PipeLane::LIVE, &specs);
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
        let _pool = pool_guard();
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
        playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &a, &info_a, 0).expect("a on track 0");
        playback_frame(PipeLane::LIVE, PipeSlot::Current, &a, &info_a, 0).expect("a on Current");
        playback_frame(PipeLane::LIVE, PipeSlot::Track(1), &b, &info_b, 0).expect("b on track 1");
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

    // ----------------------------------------------------------------- //
    // D-324 — the prefetch. A cut boundary is a large, arbitrary jump in
    // source-frame space, which is exactly the case `frame_scaled` answers
    // with a kill-and-respawn; on the recut timelines this was reported
    // against there are 95-155 of them inside one continuous playthrough.
    //
    // These build their own small fixtures with `ffmpeg` rather than gating
    // on `CHROMA_TEST_VIDEO`, because what they assert is *which pipe served
    // the frame* and *what was left running afterwards* — properties of the
    // pool's bookkeeping, true of any decodable file. The measured payoff on
    // real 4K HEVC footage lives in `prefetch_hides_the_respawn_on_real_footage`
    // below, which is env-gated like its siblings.
    // ----------------------------------------------------------------- //

    /// A 24 fps `testsrc` long enough to seek around inside.
    fn synth_seekable(dir: &Path, secs: u32) -> PathBuf {
        let out = dir.join("seekable.mp4");
        let status = Command::new(ffmpeg_bin())
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("testsrc=size=320x240:rate=24:duration={secs}"))
            .args(["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"])
            .arg(&out)
            .status()
            .expect("running ffmpeg to synthesize the seekable fixture");
        assert!(status.success(), "ffmpeg could not build the fixture");
        out
    }

    /// The core decision both the live pipe and a standby are judged by.
    #[test]
    fn can_serve_accepts_a_forward_hop_and_rejects_a_seek() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let other = synth_cfr(dir.path());
        let info = crate::video::probe(&vid).expect("probe");

        let pipe = FramePipe::open_with_hwaccel(&vid, &info, 100, None, false).expect("open");
        assert_eq!(pipe.next_index, 100);

        assert!(pipe.can_serve(&vid, 100, None), "its own opening frame");
        assert!(pipe.can_serve(&vid, 101, None), "the next frame");
        assert!(
            pipe.can_serve(&vid, 100 + MAX_FORWARD_SKIP, None),
            "the furthest forward hop still worth discarding to"
        );
        assert!(
            !pipe.can_serve(&vid, 100 + MAX_FORWARD_SKIP + 1, None),
            "one frame past the skip threshold is a seek"
        );
        assert!(!pipe.can_serve(&vid, 99, None), "backward is always a seek");
        assert!(
            !pipe.can_serve(&vid, 100, Some((160, 120))),
            "a change of output scale needs a fresh ffmpeg, whatever the frame"
        );
        assert!(
            !pipe.can_serve(&other, 100, None),
            "a different source is never servable"
        );
    }

    /// **The prefetch's whole point:** a pipe primed for a boundary is adopted
    /// when the boundary arrives, and hands back the right picture.
    #[test]
    fn a_primed_standby_is_adopted_at_the_boundary() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        // Playing along at frame 10 — a long way from the boundary below, so
        // the live pipe genuinely cannot reach it by reading forward.
        playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 10).expect("frame 10");
        assert_eq!(open_pipe_count(), 1);
        assert_eq!(standby_pipe_count(), 0);

        const BOUNDARY: u64 = 300;
        prime_one(PipeSlot::Track(0), &vid, &info, BOUNDARY, None);
        assert_eq!(
            standby_pipe_count(),
            1,
            "a target the live pipe cannot reach must be primed"
        );

        let got = playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, BOUNDARY)
            .expect("the boundary frame")
            .to_rgb8();
        assert_eq!(
            standby_pipe_count(),
            0,
            "the standby was adopted, not left running alongside the live pipe"
        );
        assert_eq!(open_pipe_count(), 1, "still exactly one pipe on this slot");

        // Adoption must not cost a frame, duplicate one, or land elsewhere.
        let want = crate::video::decode_frame(&vid, crate::video::FramePos::Index(BOUNDARY), &info)
            .expect("reference decode")
            .to_rgb8();
        assert!(
            mean_abs_diff(&got, &want) < 1.0,
            "the adopted pipe served the wrong frame"
        );

        // And the adopted pipe is a normal sequential pipe afterwards.
        let next = playback_frame(
            PipeLane::LIVE,
            PipeSlot::Track(0),
            &vid,
            &info,
            BOUNDARY + 1,
        )
        .expect("the frame after the boundary")
        .to_rgb8();
        let next_want =
            crate::video::decode_frame(&vid, crate::video::FramePos::Index(BOUNDARY + 1), &info)
                .expect("reference decode")
                .to_rgb8();
        assert!(
            mean_abs_diff(&next, &next_want) < 1.0,
            "reading on from an adopted pipe drifted"
        );
        reset();
    }

    /// Playback dropping a frame or two across the cut — the normal case under
    /// load, since the rAF loop skips frames to stay real-time — still adopts,
    /// because the standby is primed at the clip's FIRST frame and a few frames
    /// in is an ordinary forward skip from there.
    #[test]
    fn a_standby_still_serves_when_playback_lands_a_few_frames_late() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 10).expect("frame 10");
        const BOUNDARY: u64 = 300;
        prime_one(PipeSlot::Track(0), &vid, &info, BOUNDARY, None);

        let late = BOUNDARY + 3;
        let got = playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, late)
            .expect("a late landing")
            .to_rgb8();
        assert_eq!(standby_pipe_count(), 0, "adopted, not discarded");
        let want = crate::video::decode_frame(&vid, crate::video::FramePos::Index(late), &info)
            .expect("reference decode")
            .to_rgb8();
        assert!(
            mean_abs_diff(&got, &want) < 1.0,
            "a late landing must skip forward within the adopted pipe, not respawn"
        );
        reset();
    }

    /// A mispredicted prefetch is harmless: the frame is still right, and the
    /// stale `ffmpeg` is released rather than left holding a slot. This is what
    /// makes the prediction safe to make at all.
    ///
    /// **D-330 moved WHICH call does the releasing, deliberately.** Before, a
    /// `playback_frame*` that could not use the standby dropped it on the spot.
    /// That is incompatible with a chain — the standby for boundary `N+2`
    /// cannot serve boundary `N+1` by construction, so the on-the-spot drop
    /// would have thrown away exactly the prefetches the chain exists to keep.
    /// Releasing is [`sync_prefetch`]'s job now: it is handed the complete
    /// wanted set every frame and drops everything else, and the Edit tab calls
    /// it every frame including with an empty set on a scrub. So the property
    /// this test protects is unchanged at the level that matters — a worthless
    /// prediction does not pin an `ffmpeg` for the session — and the two halves
    /// are asserted separately below.
    #[test]
    fn a_standby_that_cannot_serve_is_discarded_and_the_frame_is_still_right() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 200).expect("frame 200");
        prime_one(PipeSlot::Track(0), &vid, &info, 300, None);
        assert_eq!(standby_pipe_count(), 1);

        // The user seeks backwards instead — the prediction is now worthless.
        let elsewhere = 40;
        let got = playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, elsewhere)
            .expect("a seek elsewhere")
            .to_rgb8();
        let want =
            crate::video::decode_frame(&vid, crate::video::FramePos::Index(elsewhere), &info)
                .expect("reference decode")
                .to_rgb8();
        assert!(
            mean_abs_diff(&got, &want) < 1.0,
            "an unusable standby must not affect the picture"
        );

        // …and the next frame's `sync_prefetch` — which a scrub makes with an
        // empty wanted set — is what releases it.
        sync_prefetch(PipeLane::LIVE, &[]);
        assert_eq!(
            standby_pipe_count(),
            0,
            "an overtaken prediction must release its ffmpeg, not pin it for the session"
        );
        reset();
    }

    /// **D-330 — a chain of boundaries, which is the whole point of the list.**
    ///
    /// A clip shorter than the lead time used to have its own standby evicted
    /// by the clip after it (B-200): with one standby per slot, priming `N+2`
    /// replaced `N+1` before `N+1` was ever reached, so that boundary paid the
    /// full respawn *and* wasted an `ffmpeg`. Three boundaries primed together
    /// must all survive, and each must be adopted by its own boundary in turn.
    #[test]
    fn a_chain_of_short_clip_boundaries_all_stay_primed_and_each_is_adopted() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 40);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 10).expect("frame 10");

        // Three cuts, each far enough from the last to be a genuine seek — the
        // shape of a run of sub-second clips on one track.
        const CUTS: [u64; 3] = [300, 600, 900];
        let want: Vec<PrefetchSpec<'_>> = CUTS
            .iter()
            .map(|&t| PrefetchSpec {
                slot: PipeSlot::Track(0),
                path: &vid,
                info: &info,
                target: t,
                scale: None,
            })
            .collect();
        sync_prefetch(PipeLane::LIVE, &want);
        assert_eq!(
            standby_pipe_count(),
            3,
            "all three boundaries must be primed at once — priming the far one \
             must not evict the near one, which is B-200"
        );

        // Crossing each boundary adopts that one and leaves the rest alone.
        for (i, &cut) in CUTS.iter().enumerate() {
            let got = playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, cut)
                .unwrap_or_else(|e| panic!("cut {cut}: {e}"))
                .to_rgb8();
            assert_eq!(
                standby_pipe_count(),
                CUTS.len() - 1 - i,
                "adopting the standby for {cut} must consume exactly one, \
                 leaving the later boundaries primed"
            );
            let reference =
                crate::video::decode_frame(&vid, crate::video::FramePos::Index(cut), &info)
                    .expect("reference decode")
                    .to_rgb8();
            assert!(
                mean_abs_diff(&got, &reference) < 1.0,
                "an adopted standby must produce the right picture at {cut}"
            );
            // Re-state what is still wanted, as the scheduler does each frame.
            sync_prefetch(PipeLane::LIVE, &want[i + 1..]);
        }
        reset();
    }

    /// The per-slot cap is a cap: asking for more boundaries than
    /// [`MAX_STANDBY_PER_SLOT`] primes that many and no more, rather than
    /// spawning an unbounded number of 4K `ffmpeg` processes.
    #[test]
    fn the_standby_chain_is_capped_per_slot() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 40);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        let targets: Vec<u64> = (1..=(MAX_STANDBY_PER_SLOT as u64 + 3))
            .map(|i| i * 200)
            .collect();
        let want: Vec<PrefetchSpec<'_>> = targets
            .iter()
            .map(|&t| PrefetchSpec {
                slot: PipeSlot::Track(0),
                path: &vid,
                info: &info,
                target: t,
                scale: None,
            })
            .collect();
        sync_prefetch(PipeLane::LIVE, &want);
        assert_eq!(standby_pipe_count(), MAX_STANDBY_PER_SLOT);
        reset();
    }

    /// D-330 — a respawn measures its own keyframe seek, which is what the
    /// scheduler's adaptive lead time is derived from. A source nothing has
    /// respawned on reports nothing, rather than a guess.
    #[test]
    fn a_respawn_records_what_its_seek_cost() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        // A cold open + first frame IS a respawn, so it is measured.
        playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 10).expect("frame 10");
        let first = estimated_seek_ms(&vid).expect("a cold open is a measured seek");
        assert!(first > 0.0, "a measured seek must be a real duration");

        // A sequential read is not a seek and must not be folded in.
        playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 11).expect("frame 11");
        assert_eq!(
            estimated_seek_ms(&vid),
            Some(first),
            "reading forward is not a respawn and must not move the estimate"
        );

        assert_eq!(
            estimated_seek_ms(&dir.path().join("never-decoded.mov")),
            None,
            "a source that has never respawned has nothing measured"
        );

        // D-260's file-replaced path also forgets the measurement: the new
        // inode is a different file, and its predecessor's seek cost says
        // nothing about it.
        drop_pipes_for_path(&vid);
        assert_eq!(
            estimated_seek_ms(&vid),
            None,
            "replacing the file must invalidate its measured seek cost too"
        );
        reset();
    }

    /// `sync_prefetch` is called every frame of the approach, so it has to be a
    /// no-op in the two cases that are not a boundary — or it would spawn (and
    /// kill) an `ffmpeg` per displayed frame, which is worse than the stall it
    /// exists to remove.
    ///
    /// The mid-clip half of this is the unit-level statement of the bug D-330
    /// fixed one layer up: it passes here because the target really is reachable
    /// by the live pipe, and the scheduler used to hand it a target that was
    /// one frame BEHIND the pipe (`max(clip.start_frame, pos)` resolved after
    /// the frame was decoded), which no `can_serve` could ever satisfy. See
    /// `chroma::edit::upcoming_boundary_targets`.
    #[test]
    fn prefetch_does_nothing_mid_clip_or_when_already_primed() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 100).expect("frame 100");

        // Mid-clip: the lookahead frame is a short forward hop the live pipe
        // will reach on its own.
        prime_one(PipeSlot::Track(0), &vid, &info, 112, None);
        assert_eq!(
            standby_pipe_count(),
            0,
            "a target the live pipe can already reach must not be primed"
        );

        // Approaching a real boundary: primed once…
        prime_one(PipeSlot::Track(0), &vid, &info, 400, None);
        assert_eq!(standby_pipe_count(), 1);
        // …and re-asking for the SAME boundary on the next frame must not kill
        // the seek that is already running and start it over.
        for _ in 0..5 {
            prime_one(PipeSlot::Track(0), &vid, &info, 400, None);
            assert_eq!(standby_pipe_count(), 1);
        }

        // **D-330 — a DIFFERENT boundary now JOINS it rather than replacing it.**
        // That is the behaviour change B-200 needed: under D-324's one-per-slot
        // map this line asserted `1`, and that eviction is exactly what stopped
        // a clip shorter than the lead time from ever keeping its own prefetch.
        // Which of the two is still wanted is the scheduler's call, expressed by
        // what it passes to `sync_prefetch` — asserted just below.
        prime_one(PipeSlot::Track(0), &vid, &info, 420, None);
        assert_eq!(standby_pipe_count(), 2);

        // …and saying only one of them is still wanted releases the other.
        sync_prefetch(
            PipeLane::LIVE,
            &[PrefetchSpec {
                slot: PipeSlot::Track(0),
                path: &vid,
                info: &info,
                target: 420,
                scale: None,
            }],
        );
        assert_eq!(standby_pipe_count(), 1);
        reset();
    }

    /// Every release path covers standbys too — the "don't leak ffmpeg
    /// processes" half of the contract, one assertion per way a prefetch can
    /// stop being wanted.
    #[test]
    fn standbys_are_released_by_every_path_that_releases_a_live_pipe() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");

        // (a) the slot stops being wanted.
        //
        // **D-330 — through `sync_prefetch`, not `retain_pipe_slots`.** D-324
        // had the per-frame slot release drop standbys too, which was right
        // while nothing else could release them. Now the scheduler states the
        // complete wanted set every frame, so a track that has gone hidden or
        // been deleted simply stops appearing in it — one owner for that
        // lifetime instead of two saying the same thing. `retain_pipe_slots` is
        // asserted to leave standbys alone precisely so the two cannot drift
        // back apart.
        reset();
        prime_one(PipeSlot::Track(3), &vid, &info, 100, None);
        assert_eq!(standby_pipe_count(), 1);
        retain_pipe_slots(PipeLane::LIVE, &[PipeSlot::Track(0)]);
        assert_eq!(
            standby_pipe_count(),
            1,
            "releasing LIVE slots must not touch the standby set — that is \
             `sync_prefetch`'s to own (D-330)"
        );
        sync_prefetch(PipeLane::LIVE, &[]);
        assert_eq!(
            standby_pipe_count(),
            0,
            "a track that went hidden/deleted must release its primed pipe too"
        );

        // (b) the file is replaced underneath it (D-260)
        reset();
        prime_one(PipeSlot::Track(0), &vid, &info, 100, None);
        playback_frame(PipeLane::LIVE, PipeSlot::Track(1), &vid, &info, 0)
            .expect("a live pipe too");
        assert_eq!(
            drop_pipes_for_path(&vid),
            2,
            "both the live pipe and the standby on that path are dropped, and counted"
        );
        assert_eq!(standby_pipe_count(), 0);
        assert_eq!(open_pipe_count(), 0);

        // (c) a wholesale reset
        reset();
        prime_one(PipeSlot::Track(0), &vid, &info, 100, None);
        assert_eq!(standby_pipe_count(), 1);
        reset();
        assert_eq!(standby_pipe_count(), 0, "reset clears standbys as well");
    }

    /// The measured claim, on the real footage the bug was reported against:
    /// crossing a cut costs a respawn's full keyframe seek without a prefetch,
    /// and a pipe read with one.
    ///
    /// ```text
    /// CHROMA_TEST_VIDEO=~/Downloads/A001_09122319_C038.MOV \
    ///   cargo test -p apelles-media prefetch_hides_the_respawn -- --nocapture
    /// ```
    #[test]
    fn prefetch_hides_the_respawn_on_real_footage() {
        let _pool = pool_guard();
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = crate::video::probe(&vid).expect("probe");
        let scale = scale_target(info.resolution.width, info.resolution.height, 1280);

        // Cuts far enough apart that each is a genuine seek, walked the way
        // playback walks them.
        let cuts: [u64; 4] = [4000, 9000, 13000, 2500];

        let mut without = Vec::new();
        for &cut in &cuts {
            reset();
            playback_frame_scaled(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 100, scale)
                .expect("warm");
            let t = std::time::Instant::now();
            playback_frame_scaled(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, cut, scale)
                .expect("cut");
            without.push(t.elapsed().as_secs_f64() * 1000.0);
        }

        let mut with = Vec::new();
        for &cut in &cuts {
            reset();
            playback_frame_scaled(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 100, scale)
                .expect("warm");
            prime_one(PipeSlot::Track(0), &vid, &info, cut, scale);
            // The lookahead D-324 actually uses: 0.5 s of playback, during
            // which the real preview would have been decoding frames of the
            // OUTGOING clip while this ffmpeg seeks in parallel.
            std::thread::sleep(std::time::Duration::from_millis(500));
            let t = std::time::Instant::now();
            playback_frame_scaled(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, cut, scale)
                .expect("cut");
            with.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        reset();

        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        let (a, b) = (mean(&without), mean(&with));
        eprintln!(
            "cut-boundary latency on {}: without prefetch {a:.1} ms {:?}, with prefetch {b:.1} ms {:?}",
            vid.display(),
            without.iter().map(|v| v.round()).collect::<Vec<_>>(),
            with.iter().map(|v| v.round()).collect::<Vec<_>>(),
        );
        assert!(
            b * 4.0 < a,
            "a primed pipe should turn a cut into a pipe read — got {b:.1} ms with the \
             prefetch against {a:.1} ms without, which is not the order-of-magnitude \
             difference the design rests on"
        );
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
        let _pool = pool_guard();
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
        let _pool = pool_guard();
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
        let _pool = pool_guard();
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
        let _pool = pool_guard();
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
    ///   cargo test -p apelles-media the_real_vfr_source
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
