//! The pool of sequential decode streams for scrub, playback and export
//! (roadmap round-2 item 5, D-030; multi-stream pool, D-125; boundary
//! prefetch, D-324; lanes, D-360; the media engine, D-452; optimized media,
//! D-453).
//!
//! What it is: one long-lived decode stream per *slot* (one per visible video
//!   track) per *lane* (one per walker of the timeline) that reads frames in
//!   order, instead of a fresh decode + keyframe seek per frame. A stream is
//!   the in-process media engine (`vt_decode::Reader`: AVFoundation +
//!   VideoToolbox, frames left in IOSurfaces for the GPU engine, D-452). A
//!   source the media engine cannot open (Matroska / WebM, AVI, MPEG-TS, MXF)
//!   is read through the `.mov` it was converted into once
//!   ([`crate::optimized_media`], D-453); there is no other decoder.
//! What it does: `playback_frame(lane, slot, path, info, target)` returns
//!   frame `target` as a [`VideoFrame`]. Cheap when `target` is the frame last
//!   handed out (a hold, a slow ramp: D-452), the next one, or a short forward
//!   hop *for that slot*; a keyframe-seek reopen otherwise — or, since D-324,
//!   the adoption of a stream primed for that exact jump.
//! What it does NOT do: audio, colour conversion or scaling (the GPU engine
//!   converts and resamples a frame), the grade, caching decoded frames beyond
//!   the last, or converting a source (it reports one not converted yet).
//! Failure: any stream error drops that slot's stream and returns `Err`, as it
//!   is (D-452: no fallback).
//!
//! The history below describes the `ffmpeg` pipes this pool held until D-452
//! (one `ffmpeg -f rawvideo` process per stream); the pool's shape — slots,
//! lanes, standbys, measured seek costs — is unchanged, with each process
//! replaced by a reader thread.
//!
//! ## Frame `N` means the same thing here as everywhere else (D-228, B-104)
//!
//! Every stream is conformed to the nominal grid (`vt_decode` reimplements
//! [`crate::conform`]'s `fps` filter exactly), so "frame `N`" is the picture at
//! `N / source_fps` seconds — the same definition the timeline, the keyframes,
//! the audio clock, the export and `video::decode_frame` use. That is a real
//! constraint on this module in particular: it is the only decoder that keeps
//! reading *without* re-seeking, so it is the only one where a per-frame error
//! could accumulate. It no longer can — see B-104 for what happened when it did.
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
//! used to be held for the whole of [`FramePipe::frame`] — the pipe
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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Result, anyhow};
use once_cell::sync::Lazy;

use crate::video::VideoInfo;
pub use crate::vt_decode::VideoFrame;

/// How far forward we'll fast-skip (discard decoded frames) before a reopen —
/// with its keyframe seek — becomes the cheaper option. ~2 s at 24 fps.
const MAX_FORWARD_SKIP: u64 = 48;

/// How many boundaries one slot may have primed at once (D-330).
///
/// A run of clips shorter than the lead time needs its reopens overlapped, and
/// one standby per slot can only hide one boundary. Three is the smallest number
/// that covers the shapes this project actually contains — its longest run of
/// consecutive sub-lookahead clips is two — with one spare.
///
/// It is a cap and not a target: [`sync_prefetch`] primes only the boundaries
/// the caller actually asked for, which mid-clip is none at all. The cost of the
/// cap being wrong in the generous direction is bounded and was measured: a
/// spawned-and-killed 4K HEVC `ffmpeg` alongside a live sequential read moved
/// that read's median from 7.13 ms to 6.62 ms, i.e. not at all. (A standby is a
/// reader thread now, D-452, which is cheaper still.)
pub const MAX_STANDBY_PER_SLOT: usize = 3;

/// Per-source EWMA of what a reopen's keyframe seek actually costs, in ms
/// (D-330) — see the module doc. Written by [`record_seek_cost`] on every
/// un-hidden reopen, read by [`estimated_seek_ms`].
static SEEK_COST: Lazy<Mutex<HashMap<PathBuf, f64>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Weight given to the newest sample. Low enough that one unlucky reopen
/// (a cold page cache, a busy machine) cannot swing the estimate far, high
/// enough that a genuinely different source converges within a handful of cuts.
const SEEK_COST_ALPHA: f64 = 0.3;

/// Fold one measured reopen — `open` through its first frame — into `path`'s
/// estimate.
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

/// What a reopen on `path` has been measured to cost, or `None` if this source
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

/// One sequential decode stream: a media-engine reader (D-452) over the
/// source, or over its converted file when the media engine cannot open the
/// source itself (D-453).
pub struct FramePipe {
    /// The source as the timeline names it — the original, never its converted
    /// file — so the pool's keys, releases by path and seek costs all speak of
    /// the file the user placed.
    path: PathBuf,
    /// absolute source frame index the next read will return
    next_index: u64,
    /// D-452 — the frame last handed out, and its index. A request for the
    /// same frame again (a held frame, a slow-motion ramp that shows each
    /// source frame twice) is answered from here instead of by a seek.
    last: Option<(u64, VideoFrame)>,
    reader: crate::vt_decode::Reader,
}

/// Even-dimension downscale target for a `long_edge` cap. Returns `None` when the
/// source already fits (no scaling needed). Used to size a preview canvas and a
/// scaled still; a video stream always decodes at its full size (D-452).
pub fn scale_target(src_w: u32, src_h: u32, long_edge: u32) -> Option<(u32, u32)> {
    let long = src_w.max(src_h);
    if long == 0 || long <= long_edge {
        return None;
    }
    let ratio = long_edge as f64 / long as f64;
    let mut w = (src_w as f64 * ratio).round() as u32;
    let mut h = (src_h as f64 * ratio).round() as u32;
    w &= !1; // most codecs and the encoders want even dims
    h &= !1;
    Some((w.max(2), h.max(2)))
}

impl FramePipe {
    /// Start decoding `path` from absolute frame `start`, **conformed to the
    /// source's nominal frame grid** (D-228) so the `n`th frame out of this
    /// pipe is source frame `start + n` — the picture at `(start + n) /
    /// source_fps` seconds.
    ///
    /// D-452 — decoded in process by the media engine (`vt_decode`,
    /// VideoToolbox, frames left on the GPU side at full size). D-453 — a
    /// source AVFoundation cannot open is read through its converted file
    /// ([`crate::optimized_media::decode_source`]); one not converted yet is an
    /// error that names it and says where its conversion stands.
    pub fn open(path: &Path, info: &VideoInfo, start: u64) -> Result<Self> {
        let source = crate::optimized_media::decode_source(path, info)?;
        let decode_info = source.info.as_ref().unwrap_or(info);
        Ok(Self {
            path: path.to_path_buf(),
            next_index: start,
            last: None,
            reader: crate::vt_decode::Reader::open(&source.path, decode_info, start)?,
        })
    }

    /// The next frame on the grid.
    fn read(&mut self) -> Result<VideoFrame> {
        let index = self.next_index;
        let frame = self.reader.next_frame()?;
        if frame.index != index {
            return Err(anyhow!(
                "the media engine returned frame {} for {index}",
                frame.index
            ));
        }
        self.next_index += 1;
        self.last = Some((index, frame.clone()));
        Ok(frame)
    }

    /// Read and discard the next frame (a forward hop shorter than a seek).
    fn skip(&mut self) -> Result<()> {
        drop(self.reader.next_frame()?);
        self.next_index += 1;
        Ok(())
    }

    /// D-452 — the frame last handed out, if it is `target`.
    fn repeat_of(&self, target: u64) -> Option<VideoFrame> {
        match &self.last {
            Some((index, frame)) if *index == target => Some(frame.clone()),
            _ => None,
        }
    }

    /// Whether this pipe can produce `target` by reading forward — i.e. without
    /// the reopen a keyframe seek costs. The same source, and a target that is
    /// the frame it last handed out (a held frame, or a ramp slower than real
    /// time asking for the same source frame twice: D-452), the very next
    /// frame, or a short enough forward hop to be cheaper to discard than to
    /// seek to.
    ///
    /// Factored out of [`Self::frame`] by D-324 because the prefetch needs to ask
    /// exactly this question of two *different* pipes: of the live one ("do I
    /// even need to prime anything?") and of a primed standby ("can this one be
    /// adopted for the frame actually being asked for?").
    fn can_serve(&self, path: &Path, target: u64) -> bool {
        path == self.path
            && (self.repeat_of(target).is_some()
                || (target >= self.next_index && target <= self.next_index + MAX_FORWARD_SKIP))
    }

    /// Absolute frame `target`. A change of `path`, a backward step past the
    /// last frame handed out, or a forward jump past [`MAX_FORWARD_SKIP`]
    /// forces a keyframe-seek reopen.
    pub fn frame(&mut self, path: &Path, info: &VideoInfo, target: u64) -> Result<VideoFrame> {
        if !self.can_serve(path, target) {
            // D-330 — a reopen is the one event that measures its own cost, so
            // measure it. `open` + the first read IS the keyframe seek the
            // prefetch exists to hide, and the scheduler needs to know how big
            // it is on THIS source to know how far ahead to prime. Timed here
            // rather than around the call because only this branch is a seek:
            // the path below is a forward read, and an adopted standby never
            // reaches this branch at all.
            let started = std::time::Instant::now();
            *self = Self::open(path, info, target)?;
            let frame = self.read()?;
            record_seek_cost(path, started.elapsed().as_secs_f64() * 1000.0);
            return Ok(frame);
        }
        if let Some(frame) = self.repeat_of(target) {
            return Ok(frame);
        }
        while self.next_index < target {
            self.skip()?;
        }
        self.read()
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
/// or each call reopens the other's stream (B-040).
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
    /// sharing one would make each of the two calls reopen the other's
    /// stream, every frame, for the whole transition (B-040's measured
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
        PipeLane(n.saturating_add(1).min(u16::MAX as usize - 1) as u16)
    }

    /// D-432 P3 — the Edit tab's two-up trim viewer: the outgoing and incoming
    /// frames shown while a roll / slip / slide is dragged, one sequential
    /// stream per half (slots `Track(0)` / `Track(1)`). Its own lane so a
    /// trim drag's decodes can neither release nor reposition a pipe the live
    /// preview is using, and the preview's per-frame release can never kill
    /// them. The top of the range, which [`Self::render`] stops one short of.
    pub const TRIM_VIEW: PipeLane = PipeLane(u16::MAX);
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
/// same key waits for the pipe rather than opening a rival reader on the
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
    /// Each one's reader is already running, already past its keyframe seek,
    /// already decoding — which is the entire cost a respawn pays (measured:
    /// 0.8-1.0 ms to `spawn`, then 248-337 ms on D-324's source and a median
    /// 723 ms on the owner's `C040` before the first frame comes out). Adopting
    /// one at the boundary turns that into the ~1 ms of a pipe read.
    ///
    /// A standby is never *required*: [`playback_frame`] adopts one only
    /// if it can genuinely serve the frame being asked for, and otherwise
    /// respawns exactly as before. So a wrong prediction costs one wasted
    /// reader, never a wrong picture.
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
/// *inside* [`FramePipe::frame`]. Before D-360 that ran with the pool
/// mutex held, which was free while one thread walked the timeline and is fatal
/// the moment several do: N render segments would each wait their turn on one
/// global lock and decode exactly as sequentially as one of them did. Handing
/// the pipe out and taking the lock again only to hand it back is what makes a
/// lane's decode genuinely concurrent with every other lane's.
///
/// Blocks only on a second caller for this exact key, which is the same
/// serialisation the pool mutex used to impose on it.
fn check_out(key: PipeKey, path: &Path, target: u64) -> Checkout {
    let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());
    while matches!(pool.live.get(&key), Some(LiveEntry::Busy(_))) {
        pool = PIPE_RETURNED.wait(pool).unwrap_or_else(|e| e.into_inner());
    }

    // D-324 — the boundary crossing. If this key's live pipe cannot serve
    // `target` (a cut: the source frame jumped somewhere a forward read can't
    // reach) but a standby primed for exactly this moment can, adopt it. The
    // old pipe drops here, stopping its reader; the primed one takes its place
    // with its seek already paid.
    //
    // Both halves of the condition matter. Only consulting the standbys when the
    // live pipe has genuinely failed keeps the ordinary mid-clip frame on the
    // exact code path it was always on. And re-checking `can_serve` on the
    // standby itself is what makes a mispredicted prefetch harmless: playback
    // that jumped somewhere else entirely simply does not adopt it.
    let live_can_serve = matches!(
        pool.live.get(&key),
        Some(LiveEntry::Idle(p)) if p.can_serve(path, target)
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
        if let Some(i) = primed.iter().position(|p| p.can_serve(path, target)) {
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
        // Dropped after the lock is released: stopping and joining a reader
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

/// Decode `target` via `slot`'s pipe in `lane`, creating / advancing /
/// reopening it as needed. On a failure the slot's pipe is dropped and the
/// error returned — there is no second decoder to retry on (D-452), and a
/// source still being converted (D-453) says so in the error.
///
/// **D-360 — the pool's lock is NOT held across the decode.** The pipe is
/// checked out of the pool, read off-lock, and checked back in; see
/// [`check_out`] for why, and [`Checkout`] for what guarantees it always goes
/// back. For a single-threaded caller (all of live playback) the observable
/// behaviour is identical to before.
pub fn playback_frame(
    lane: PipeLane,
    slot: PipeSlot,
    path: &Path,
    info: &VideoInfo,
    target: u64,
) -> Result<VideoFrame> {
    let key = PipeKey { lane, slot };
    let mut held = check_out(key, path, target);

    // D-330 — a COLD open is a keyframe seek too, and has to be measured like
    // one. It does not reach `frame`'s reopen branch: the pipe it opens starts
    // at `target`, so `can_serve` is true and the first frame is read forward.
    // Timed here instead, around the open and that first read together, which
    // is the same span `frame` measures for a reopen.
    let was_vacant = held.pipe.is_none();
    let started = std::time::Instant::now();
    if held.pipe.is_none() {
        held.pipe = Some(FramePipe::open(path, info, target)?);
    }
    let Some(pipe) = held.pipe.as_mut() else {
        return Err(anyhow!("decode pipe vanished between open and read"));
    };
    match pipe.frame(path, info, target) {
        Ok(frame) => {
            if was_vacant {
                record_seek_cost(path, started.elapsed().as_secs_f64() * 1000.0);
            }
            Ok(frame)
        }
        Err(e) => {
            held.pipe = None; // poison → next call reopens clean
            Err(e)
        }
    }
}

/// One cut boundary the caller wants primed — everything an open needs.
pub struct PrefetchSpec<'a> {
    /// Which sequential-decode stream this boundary belongs to.
    pub slot: PipeSlot,
    pub path: &'a Path,
    pub info: &'a VideoInfo,
    /// The clip's FIRST source frame — see `sync_prefetch`'s own doc.
    pub target: u64,
}

/// **D-324/D-330 — make the primed standby set exactly `wanted`.**
///
/// Opens a reader for each boundary in `wanted` that is not already primed, so
/// that by the time playback crosses into that clip the keyframe seek has
/// already happened on that reader's own thread (D-452; a separate `ffmpeg`
/// process before it) and the first read is a channel receive rather than a
/// seek-length stall. Anything currently primed and NOT in `wanted` is dropped,
/// stopping its reader.
///
/// **Declarative, not incremental, and that is the point (D-330).** The caller —
/// the Edit tab — is the only thing that knows the edit list, so it is the only
/// thing that can say which boundaries are still worth holding a reader open
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
/// `(path, target)` is left strictly alone — its seek keeps running,
/// undisturbed — so calling this on every frame of the approach is what makes
/// the lead time real rather than an open repeated per frame.
///
/// Errors are swallowed deliberately. A prefetch is an optimisation with a
/// complete fallback (the reopen that would have happened anyway), so a
/// failure to open one — a source still being converted, say — must never
/// become a failure to show a frame.
///
/// **D-360 — scoped to one [`PipeLane`].** `wanted` is this lane's complete
/// set, so the release half must not reach into another lane's standbys: a
/// render segment priming nothing at all (every export frame is
/// `FrameIntent::Single`) would otherwise drop every boundary live playback had
/// primed, on every frame it rendered.
pub fn sync_prefetch(lane: PipeLane, wanted: &[PrefetchSpec<'_>]) {
    let mut pool = PIPES.lock().unwrap_or_else(|e| e.into_inner());

    // 1. Release everything no longer wanted. A standby matches a spec when it
    //    is the same source primed at exactly that frame — `next_index` is
    //    where the pipe will start reading, and nothing has read from it, so it
    //    is still the frame it was opened for.
    let still_wanted = |key: PipeKey, p: &FramePipe| {
        wanted
            .iter()
            .any(|w| w.slot == key.slot && w.path == p.path && w.target == p.next_index)
    };
    for (key, primed) in pool.standby.iter_mut() {
        if key.lane != lane {
            continue; // another lane's prediction is not ours to overrule
        }
        primed.retain(|p| still_wanted(*key, p));
    }
    pool.standby.retain(|_, primed| !primed.is_empty());

    // 2. Open whatever is wanted and not already running.
    for spec in wanted {
        let key = PipeKey {
            lane,
            slot: spec.slot,
        };
        // Reading forward from where this slot already is will reach the
        // boundary on its own — no second reader needed. This is what makes a
        // clip already under the playhead cost nothing here.
        //
        // A pipe that is checked out right now (D-360) reads as "cannot serve",
        // which is conservative in the harmless direction — it costs at most one
        // standby reader that the next frame's `still_wanted` pass releases.
        // It also cannot arise on the path that matters: the Edit tab primes
        // AFTER it has decoded, on the same thread, so its own key is idle.
        if matches!(
            pool.live.get(&key),
            Some(LiveEntry::Idle(p)) if p.can_serve(spec.path, spec.target)
        ) {
            continue;
        }
        let primed = pool.standby.entry(key).or_default();
        if primed
            .iter()
            .any(|p| p.path == spec.path && p.next_index == spec.target)
        {
            continue; // already seeking for exactly this boundary
        }
        if primed.len() >= MAX_STANDBY_PER_SLOT {
            continue; // the cap, not an error — the far boundaries wait a frame
        }
        match FramePipe::open(spec.path, spec.info, spec.target) {
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
/// its reader instead of holding one open for the rest of the session.
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
/// that, so it would have leaked one stream per transition for the
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
    // Outside the lock: a `FramePipe`'s drop stops and joins its reader.
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

/// How many pipes — and therefore how many live readers — the pool
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
/// number of live readers (each a decode thread holding decoded frames, D-452).
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

/// Drop every playback pipe, primed standbys included (stops their readers
/// and closes their files). Called from `state::set_current_video` when the clip
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
/// A pipe is not a cache: it is a **live reader with the file already
/// open**, and [`FramePipe::frame`] only reopens on a change of path or
/// seek distance — never on a change of the file's *content*. So when
/// a file is atomically replaced underneath it (`chroma::motion`'s render →
/// temp → `rename`, D-260), the reader keeps its handle on the unlinked old
/// inode and keeps serving the OLD picture, correctly and indefinitely, while
/// every other consumer has already moved to the new one.
///
/// Deliberately by path and not [`reset`]: a Motion re-render replaces one
/// file, and dropping the whole pool would reopen a reader for every
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
/// the stale picture from a reader nothing else can see.
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

    use image::RgbImage;

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
    /// `playback_frame`, `retain_pipe_slots` or `drop_pipes_for_path` —
    /// including the ones that only `reset()` before driving their own
    /// standalone `FramePipe`, since that `reset()` is itself the thing that
    /// disturbs a concurrent pool test.
    static POOL_TEST_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn pool_guard() -> std::sync::MutexGuard<'static, ()> {
        POOL_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A decoded frame's luma plane: the media engine decodes H.264 luma
    /// bit-exactly whether a frame is reached by a seek or a forward read
    /// (`engine_pipe_tests`), so "the same frame" is an equality here.
    fn luma(frame: VideoFrame) -> Vec<u8> {
        crate::vt_decode::read_plane(&frame.buffer, 0).0
    }

    fn played(
        lane: PipeLane,
        slot: PipeSlot,
        path: &Path,
        info: &VideoInfo,
        target: u64,
    ) -> Vec<u8> {
        luma(playback_frame(lane, slot, path, info, target).expect("frame"))
    }

    /// The reference picture for nominal frame `n`: a fresh reader opened
    /// there, sharing nothing with the pool under test. (That a fresh reader's
    /// frame `n` is ffmpeg's conformed frame `n` is `vt_decode`'s own test.)
    fn reference(path: &Path, info: &VideoInfo, n: u64) -> Vec<u8> {
        let mut reader = crate::vt_decode::Reader::open(path, info, n).expect("open");
        luma(reader.next_frame().expect("reference frame"))
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
    fn prime_one(slot: PipeSlot, path: &Path, info: &VideoInfo, target: u64) {
        /// One standby's identity, owned — `sync_prefetch` borrows its specs,
        /// so the snapshot of what is already primed has to outlive the lock.
        struct StandbyId {
            slot: PipeSlot,
            path: PathBuf,
            target: u64,
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
                })
            })
            .collect();
        want.push(StandbyId {
            slot,
            path: path.to_path_buf(),
            target,
        });
        let specs: Vec<PrefetchSpec<'_>> = want
            .iter()
            .map(|w| PrefetchSpec {
                slot: w.slot,
                path: &w.path,
                info,
                target: w.target,
            })
            .collect();
        sync_prefetch(PipeLane::LIVE, &specs);
    }

    /// D-260 — `drop_pipes_for_path` drops exactly the pipes on that file and
    /// leaves every other one running.
    ///
    /// The "leaves every other one running" half is the whole reason this is
    /// not a [`reset`]: a Motion re-render replaces ONE file, and dropping the
    /// pool would reopen a reader for every other visible layer and for the
    /// Colorist's own [`PipeSlot::Current`] — a stall charged to clips that did
    /// not change (B-040's measured failure mode).
    #[test]
    fn drop_pipes_for_path_drops_only_that_file() {
        let _pool = pool_guard();
        let tmp = tempfile::tempdir().expect("tempdir");
        let make = |name: &str| {
            let p = tmp.path().join(name);
            let ok = crate::ffmpeg_locate::ffmpeg()
                .expect("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=black:size=64x64:rate=24:duration=1",
                    "-pix_fmt",
                    "yuv420p",
                ])
                .arg(&p)
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
        played(PipeLane::LIVE, PipeSlot::Track(0), &a, &info_a, 0);
        played(PipeLane::LIVE, PipeSlot::Current, &a, &info_a, 0);
        played(PipeLane::LIVE, PipeSlot::Track(1), &b, &info_b, 0);
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
    // source-frame space, which is exactly the case `frame` answers with a
    // reopen; on the recut timelines this was reported against there are
    // 95-155 of them inside one continuous playthrough.
    //
    // What these assert is *which pipe served the frame* and *what was left
    // running afterwards* — properties of the pool's bookkeeping, true of any
    // decodable file — so they build their own small fixtures. The measured
    // payoff on real footage lives in `prefetch_hides_the_respawn_on_real_footage`
    // below, which is env-gated.
    // ----------------------------------------------------------------- //

    /// A 24 fps `testsrc` long enough to seek around inside.
    fn synth_seekable(dir: &Path, secs: u32) -> PathBuf {
        let out = dir.join("seekable.mp4");
        let status = crate::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
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

        let pipe = FramePipe::open(&vid, &info, 100).expect("open");
        assert_eq!(pipe.next_index, 100);

        assert!(pipe.can_serve(&vid, 100), "its own opening frame");
        assert!(pipe.can_serve(&vid, 101), "the next frame");
        assert!(
            pipe.can_serve(&vid, 100 + MAX_FORWARD_SKIP),
            "the furthest forward hop still worth discarding to"
        );
        assert!(
            !pipe.can_serve(&vid, 100 + MAX_FORWARD_SKIP + 1),
            "one frame past the skip threshold is a seek"
        );
        assert!(!pipe.can_serve(&vid, 99), "backward is always a seek");
        assert!(
            !pipe.can_serve(&other, 100),
            "a different source is never servable"
        );
    }

    /// Reading forward past a gap and stepping back both land on the right
    /// frame: the forward hop by discarding, the step back by a reopen.
    #[test]
    fn a_forward_skip_and_a_backward_reopen_land_on_the_right_frame() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 4);
        let info = crate::video::probe(&vid).expect("probe");
        let mut pipe = FramePipe::open(&vid, &info, 0).expect("open");
        let a = luma(pipe.frame(&vid, &info, 10).expect("skip forward to 10"));
        let b = luma(pipe.frame(&vid, &info, 2).expect("reopen back at 2"));
        assert!(a == reference(&vid, &info, 10), "forward skip landed wrong");
        assert!(
            b == reference(&vid, &info, 2),
            "backward reopen landed wrong"
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
        played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 10);
        assert_eq!(open_pipe_count(), 1);
        assert_eq!(standby_pipe_count(), 0);

        const BOUNDARY: u64 = 300;
        prime_one(PipeSlot::Track(0), &vid, &info, BOUNDARY);
        assert_eq!(
            standby_pipe_count(),
            1,
            "a target the live pipe cannot reach must be primed"
        );

        let got = played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, BOUNDARY);
        assert_eq!(
            standby_pipe_count(),
            0,
            "the standby was adopted, not left running alongside the live pipe"
        );
        assert_eq!(open_pipe_count(), 1, "still exactly one pipe on this slot");
        // Adoption must not cost a frame, duplicate one, or land elsewhere.
        assert!(
            got == reference(&vid, &info, BOUNDARY),
            "the adopted pipe served the wrong frame"
        );
        // And the adopted pipe is a normal sequential pipe afterwards.
        let next = played(
            PipeLane::LIVE,
            PipeSlot::Track(0),
            &vid,
            &info,
            BOUNDARY + 1,
        );
        assert!(
            next == reference(&vid, &info, BOUNDARY + 1),
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

        played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 10);
        const BOUNDARY: u64 = 300;
        prime_one(PipeSlot::Track(0), &vid, &info, BOUNDARY);

        let late = BOUNDARY + 3;
        let got = played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, late);
        assert_eq!(standby_pipe_count(), 0, "adopted, not discarded");
        assert!(
            got == reference(&vid, &info, late),
            "a late landing must skip forward within the adopted pipe, not reopen"
        );
        reset();
    }

    /// A mispredicted prefetch is harmless: the frame is still right, and the
    /// stale reader is released rather than left holding a slot. This is what
    /// makes the prediction safe to make at all.
    ///
    /// **D-330 moved WHICH call does the releasing, deliberately.** Before, a
    /// `playback_frame*` that could not use the standby dropped it on the spot.
    /// That is incompatible with a chain — the standby for boundary `N+2`
    /// cannot serve boundary `N+1` by construction, so the on-the-spot drop
    /// would have thrown away exactly the prefetches the chain exists to keep.
    /// Releasing is [`sync_prefetch`]'s job now: it is handed the complete
    /// wanted set every frame and drops everything else, and the Edit tab calls
    /// it every frame including with an empty set on a scrub.
    #[test]
    fn a_standby_that_cannot_serve_is_discarded_and_the_frame_is_still_right() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 200);
        prime_one(PipeSlot::Track(0), &vid, &info, 300);
        assert_eq!(standby_pipe_count(), 1);

        // The user seeks backwards instead — the prediction is now worthless.
        let elsewhere = 40;
        let got = played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, elsewhere);
        assert!(
            got == reference(&vid, &info, elsewhere),
            "an unusable standby must not affect the picture"
        );

        // …and the next frame's `sync_prefetch` — which a scrub makes with an
        // empty wanted set — is what releases it.
        sync_prefetch(PipeLane::LIVE, &[]);
        assert_eq!(
            standby_pipe_count(),
            0,
            "an overtaken prediction must release its reader, not pin it for the session"
        );
        reset();
    }

    /// **D-330 — a chain of boundaries, which is the whole point of the list.**
    ///
    /// A clip shorter than the lead time used to have its own standby evicted
    /// by the clip after it (B-200): with one standby per slot, priming `N+2`
    /// replaced `N+1` before `N+1` was ever reached, so that boundary paid the
    /// full reopen *and* wasted a stream. Three boundaries primed together must
    /// all survive, and each must be adopted by its own boundary in turn.
    #[test]
    fn a_chain_of_short_clip_boundaries_all_stay_primed_and_each_is_adopted() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 40);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 10);

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
            let got = played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, cut);
            assert_eq!(
                standby_pipe_count(),
                CUTS.len() - 1 - i,
                "adopting the standby for {cut} must consume exactly one, \
                 leaving the later boundaries primed"
            );
            assert!(
                got == reference(&vid, &info, cut),
                "an adopted standby must produce the right picture at {cut}"
            );
            // Re-state what is still wanted, as the scheduler does each frame.
            sync_prefetch(PipeLane::LIVE, &want[i + 1..]);
        }
        reset();
    }

    /// The per-slot cap is a cap: asking for more boundaries than
    /// [`MAX_STANDBY_PER_SLOT`] primes that many and no more, rather than
    /// opening an unbounded number of 4K readers.
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
            })
            .collect();
        sync_prefetch(PipeLane::LIVE, &want);
        assert_eq!(standby_pipe_count(), MAX_STANDBY_PER_SLOT);
        reset();
    }

    /// D-330 — a reopen measures its own keyframe seek, which is what the
    /// scheduler's adaptive lead time is derived from. A source nothing has
    /// reopened on reports nothing, rather than a guess.
    #[test]
    fn a_respawn_records_what_its_seek_cost() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");
        reset();

        // A cold open + first frame IS a reopen, so it is measured.
        played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 10);
        let first = estimated_seek_ms(&vid).expect("a cold open is a measured seek");
        assert!(first > 0.0, "a measured seek must be a real duration");

        // A sequential read is not a seek and must not be folded in.
        played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 11);
        assert_eq!(
            estimated_seek_ms(&vid),
            Some(first),
            "reading forward is not a reopen and must not move the estimate"
        );

        assert_eq!(
            estimated_seek_ms(&dir.path().join("never-decoded.mov")),
            None,
            "a source that has never reopened has nothing measured"
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
    /// no-op in the two cases that are not a boundary — or it would open (and
    /// stop) a reader per displayed frame, which is worse than the stall it
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

        played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 100);

        // Mid-clip: the lookahead frame is a short forward hop the live pipe
        // will reach on its own.
        prime_one(PipeSlot::Track(0), &vid, &info, 112);
        assert_eq!(
            standby_pipe_count(),
            0,
            "a target the live pipe can already reach must not be primed"
        );

        // Approaching a real boundary: primed once…
        prime_one(PipeSlot::Track(0), &vid, &info, 400);
        assert_eq!(standby_pipe_count(), 1);
        // …and re-asking for the SAME boundary on the next frame must not stop
        // the seek that is already running and start it over.
        for _ in 0..5 {
            prime_one(PipeSlot::Track(0), &vid, &info, 400);
            assert_eq!(standby_pipe_count(), 1);
        }

        // **D-330 — a DIFFERENT boundary now JOINS it rather than replacing it.**
        prime_one(PipeSlot::Track(0), &vid, &info, 420);
        assert_eq!(standby_pipe_count(), 2);

        // …and saying only one of them is still wanted releases the other.
        sync_prefetch(
            PipeLane::LIVE,
            &[PrefetchSpec {
                slot: PipeSlot::Track(0),
                path: &vid,
                info: &info,
                target: 420,
            }],
        );
        assert_eq!(standby_pipe_count(), 1);
        reset();
    }

    /// Every release path covers standbys too — the "don't leak streams" half
    /// of the contract, one assertion per way a prefetch can stop being wanted.
    #[test]
    fn standbys_are_released_by_every_path_that_releases_a_live_pipe() {
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let vid = synth_seekable(dir.path(), 20);
        let info = crate::video::probe(&vid).expect("probe");

        // (a) the slot stops being wanted — through `sync_prefetch`, not
        // `retain_pipe_slots` (D-330: one owner for a standby's lifetime).
        reset();
        prime_one(PipeSlot::Track(3), &vid, &info, 100);
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
        prime_one(PipeSlot::Track(0), &vid, &info, 100);
        played(PipeLane::LIVE, PipeSlot::Track(1), &vid, &info, 0);
        assert_eq!(
            drop_pipes_for_path(&vid),
            2,
            "both the live pipe and the standby on that path are dropped, and counted"
        );
        assert_eq!(standby_pipe_count(), 0);
        assert_eq!(open_pipe_count(), 0);

        // (c) a wholesale reset
        reset();
        prime_one(PipeSlot::Track(0), &vid, &info, 100);
        assert_eq!(standby_pipe_count(), 1);
        reset();
        assert_eq!(standby_pipe_count(), 0, "reset clears standbys as well");
    }

    /// D-453 — through the pool, a source the media engine cannot open is read
    /// from its converted file once there is one, and is an error that names
    /// it until then. The pool keys the stream by the ORIGINAL path, so a
    /// release by path still finds it.
    #[test]
    fn a_source_that_needs_converting_plays_through_its_converted_file() {
        let _queue = crate::optimized_media::tests::queue_turn();
        let _pool = pool_guard();
        let dir = tempfile::tempdir().expect("tempdir");
        let project = dir.path().join("pool.chroma");
        std::fs::create_dir_all(&project).expect("project dir");
        crate::optimized_media::set_project_dir(Some(&project));
        let mkv = dir.path().join("pool.mkv");
        let status = crate::ffmpeg_locate::ffmpeg()
            .expect("ffmpeg")
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg("testsrc2=size=320x240:rate=30:duration=2")
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&mkv)
            .status()
            .expect("ffmpeg");
        assert!(status.success());
        let info = crate::video::probe(&mkv).expect("probe");
        reset();

        let err = playback_frame(PipeLane::LIVE, PipeSlot::Track(0), &mkv, &info, 5)
            .expect_err("not converted yet");
        assert!(err.to_string().contains("pool.mkv"), "{err}");
        assert_eq!(open_pipe_count(), 0, "a failed open leaves no pipe");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while crate::optimized_media::converted_file(&mkv).is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the conversion finishes"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let got = played(PipeLane::LIVE, PipeSlot::Track(0), &mkv, &info, 5);
        let source = crate::optimized_media::decode_source(&mkv, &info).expect("converted");
        let decode_info = source.info.as_ref().expect("the converted file's facts");
        assert!(
            got == reference(&source.path, decode_info, 5),
            "frame 5 of the converted file"
        );
        assert_eq!(drop_pipes_for_path(&mkv), 1, "keyed by the original path");
        reset();
        crate::optimized_media::set_project_dir(None);
    }

    /// The measured claim, on real footage: crossing a cut costs a reopen's
    /// full keyframe seek without a prefetch, and a channel receive with one.
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

        // Cuts far enough apart that each is a genuine seek, walked the way
        // playback walks them.
        let cuts: [u64; 4] = [4000, 9000, 13000, 2500];

        let mut without = Vec::new();
        for &cut in &cuts {
            reset();
            played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 100);
            let t = std::time::Instant::now();
            played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, cut);
            without.push(t.elapsed().as_secs_f64() * 1000.0);
        }

        let mut with = Vec::new();
        for &cut in &cuts {
            reset();
            played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, 100);
            prime_one(PipeSlot::Track(0), &vid, &info, cut);
            // The lookahead D-324 actually uses: 0.5 s of playback, during
            // which the real preview would have been decoding frames of the
            // OUTGOING clip while this reader seeks in parallel.
            std::thread::sleep(std::time::Duration::from_millis(500));
            let t = std::time::Instant::now();
            played(PipeLane::LIVE, PipeSlot::Track(0), &vid, &info, cut);
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
            "a primed reader should turn a cut into a channel receive — got {b:.1} ms with \
             the prefetch against {a:.1} ms without"
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
        let (w, h) = scale_target(1999, 1125, 1280).expect("a 1999-wide source scales");
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
    }

    // ----------------------------------------------------------------- //
    // B-104 / D-228 — the nominal grid of the single-frame decoder
    // (`video::decode_frame`, the thumbnails' and the Colorist's still-frame
    // path), on a variable-frame-rate fixture. The media engine's own grid is
    // tested against ffmpeg's in `vt_decode`.
    // ----------------------------------------------------------------- //

    /// 30 fps `testsrc` with frames 30..89 dropped and their timestamps kept:
    /// frame 29 is on screen for two seconds.
    fn synth_vfr_with_a_hold(dir: &Path) -> PathBuf {
        let out = dir.join("vfr_hold.mp4");
        let status = crate::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
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

    /// Plain 30 fps `testsrc`.
    fn synth_cfr(dir: &Path) -> PathBuf {
        let out = dir.join("cfr.mp4");
        let status = crate::ffmpeg_locate::ffmpeg()
            .expect("an ffmpeg to build the fixture")
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
        // 60 coded frames over 4 s is 15/s on AVERAGE: right, but no single
        // scalar rate can describe where the frames of a 30/s source with a 2 s
        // gap actually are.
        assert!(
            (info.fps() * info.duration_secs - info.frame_count as f64).abs() < 1.0,
            "avg rate x duration should reproduce the coded frame count"
        );
    }

    /// A `FramePos::Secs` question and a `FramePos::Index` question about the
    /// same instant must land on the same grid slot.
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

#[cfg(test)]
mod engine_pipe_tests;
