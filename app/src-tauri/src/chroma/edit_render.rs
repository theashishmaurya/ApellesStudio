//! **The Edit tab's headless timeline renderer (D-350; in process end to end
//! since D-452).**
//!
//! What it is: the picture half of `editor_export`, rendered by the SAME GPU
//! engine the Edit tab's live preview uses — `edit::render_timeline_frame_deferred`
//! — walked frame by frame over the export's whole duration in contiguous
//! segments (D-360), each segment's frames written by the engine straight into
//! the pixel buffers of its own VideoToolbox encoder
//! (`apelles_media::vt_encode`), then joined and given its sound by one
//! `ffmpeg` remux.
//!
//! What it does NOT do:
//! - **Composite anything itself.** Every geometry, crop, corner-radius,
//!   opacity, keyframe, transition-alpha, adjustment-clip, title and caption
//!   decision is made by `chroma::edit` and drawn by `apelles-compositor`.
//!   This module is a loop, a hand-off and a join.
//! - **Mix audio or build ffmpeg arguments.** The remux argv (the segments'
//!   concat list, the audio mix D-197 compiles, `-c:v copy`) comes in whole
//!   from `packages/editor/src/timelinePipeExport.ts`; the only thing this
//!   side substitutes is the list file's path ([`CONCAT_LIST_TOKEN`]).
//! - **Read a frame back, or pipe one.** Since D-452 a decoded frame stays in
//!   the decoder's IOSurface, the engine draws from it, and the finished frame
//!   is written into the encoder's IOSurface: no rgb24 pipe in, no RGBA pipe
//!   out, no encoder process.
//!
//! See `docs/notes/export-gpu-compositor.md` (§16 for D-452) for the design,
//! the measured numbers, and what is deliberately deferred.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;

use apelles_media::ffmpeg_locate;
use apelles_media::loudness::{self, LoudnessReport, LoudnessTarget};
use apelles_project::manifest::ProjectSettings;
use apelles_timeline::{Timeline, TrackKind};
use shared_child::SharedChild;

use super::edit::{self, FrameIntent};
use super::export::{drain_stderr_pipe, tail};
use super::export_job;
use super::export_status::{self, ExportJob};

/// One headless render + encode.
///
/// `width`/`height`/`frames`/`fps`/`format` say what to render and how to
/// compress it (D-452: the encoder is in process, so these are typed fields
/// rather than an ffmpeg argv); `args` is the remux that joins the
/// segments and adds the sound.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TimelineRenderRequest {
    pub width: u32,
    pub height: u32,
    /// How many frames to render. The caller derives it from exactly the
    /// duration it puts in the remux's `-t`, so the picture's length and the
    /// file's agree by construction rather than by two independent roundings.
    pub frames: u64,
    /// The export's frame rate (D-452: the encoder's clock; [`frame_rate`]
    /// turns it into the exact rational the file is timed by).
    pub fps: f64,
    /// D-441 — the file format: H.264 in an `.mp4`, or ProRes 422 HQ in a
    /// `.mov` (D-452: the VideoToolbox session it selects).
    pub format: ExportVideoFormat,
    /// **D-360/D-452 — the remux argv.** The concat demuxer over this
    /// render's finished segments (the list's path is [`CONCAT_LIST_TOKEN`]),
    /// the whole timeline's audio mix, `-c:v copy` and the output. Compiled
    /// entirely by `timelinePipeExport.ts`'s `buildMuxArgs`.
    pub args: Vec<String>,
    /// **D-362 — the file this render is writing, for the status readout.**
    ///
    /// The path is already inside `args` (it is its last positional), but
    /// finding it there means parsing an argv this module deliberately does
    /// not understand. The caller knows it outright, so it says it. Optional
    /// because it is a label, not an input: a request without one renders
    /// identically and simply reports no `output`.
    #[serde(default)]
    pub output: Option<String>,
    /// **D-401 — normalise the finished file's audio to this loudness target.**
    ///
    /// Done HERE rather than by the caller after this returns, for one reason:
    /// the status slot. `editor_export`'s own call outlives the bridge's budget
    /// on a real export and the MCP layer then polls `editor_export_status` for
    /// the verdict — which would read `done` the instant the render ended and
    /// hand back a file still being rewritten. Running it inside the job makes
    /// the `normalising` phase and the before/after numbers part of the status
    /// the poller reads. The picture is never re-encoded (`-c:v copy`).
    #[serde(default)]
    pub loudness: Option<LoudnessTarget>,
    /// **D-411 Phase 0 — which timeline to render.** `None` is the active
    /// timeline. An export of a named timeline — `editor_export(timeline_id=…)`,
    /// or the Export dialog's Timeline picker — carries its id, so the render
    /// draws THAT timeline rather than whichever one happens to be active when
    /// a queued job reaches the front.
    #[serde(default, rename = "timelineId")]
    pub timeline_id: Option<String>,
    /// **D-441 — the export queue's job id, so this render can be cancelled.**
    /// A cancel stops every segment's loop at its next frame, abandons its
    /// encoder (the partial segment is a temporary file), and kills the remux
    /// if it is running; the render returns `cancelled: true` with its partial
    /// output removed. `None` (a direct caller) cannot be cancelled.
    #[serde(default, rename = "cancelToken")]
    pub cancel_token: Option<String>,
    /// **D-448 — the document to draw.** The compiler hands over the timeline
    /// it compiled this request's sound from — with the export's Clip
    /// exceptions (`clipExceptions.ts`) already written into it as clip data —
    /// so the picture and the sound come from one copy. `None` (a direct
    /// caller) draws the stored timeline named by [`Self::timeline_id`]. The
    /// project settings are read from the project either way.
    #[serde(default)]
    pub timeline: Option<Timeline>,
}

/// D-441/D-452 — what the picture is compressed as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub enum ExportVideoFormat {
    /// H.264 at D-446's measured VideoToolbox quality, in an `.mp4`.
    #[serde(rename = "h264")]
    H264,
    /// Apple ProRes 422 HQ, in a `.mov`.
    #[serde(rename = "prores_hq")]
    ProresHq,
}

impl ExportVideoFormat {
    fn codec(self) -> apelles_media::vt_encode::VideoCodec {
        match self {
            ExportVideoFormat::H264 => apelles_media::vt_encode::VideoCodec::H264 {
                quality: apelles_media::vt_encode::H264_QUALITY,
            },
            ExportVideoFormat::ProresHq => apelles_media::vt_encode::VideoCodec::ProResHq,
        }
    }

    /// The pixel buffers the engine writes for this format's encoder.
    fn output(self) -> apelles_compositor::OutputFormat {
        match self {
            ExportVideoFormat::H264 => apelles_compositor::OutputFormat::Nv12Rec709,
            ExportVideoFormat::ProresHq => apelles_compositor::OutputFormat::Bgra,
        }
    }

    /// The segments' container: the output's (the remux copies the video).
    fn segment_extension(self) -> &'static str {
        match self {
            ExportVideoFormat::H264 => "mp4",
            ExportVideoFormat::ProresHq => "mov",
        }
    }
}

/// **D-452 — the export's frame rate as the exact rational its file is timed
/// by.** The timeline stores a rate as an `f64`; the encoder's clock is a
/// `CMTime` timescale. An NTSC rate (within a hundredth of `n / 1.001` for a
/// whole `n`) is `n·1000 / 1001` exactly, a whole rate is itself, and any other
/// is the nearest thousandth — so 29.97 and 30000/1001 both write the same
/// 29.97 fps file, and a frame is never a rounding of the rate.
pub(crate) fn frame_rate(fps: f64) -> Result<(u32, u32), String> {
    if !(fps.is_finite() && fps > 0.0 && fps <= 1000.0) {
        return Err(format!("{fps} is not an export frame rate"));
    }
    let whole = fps.round();
    if (fps - whole).abs() < 1e-6 {
        return Ok((whole as u32, 1));
    }
    let ntsc = (fps * 1.001).round();
    if (fps * 1.001 - ntsc).abs() < 0.01 {
        return Ok(((ntsc as u32) * 1000, 1001));
    }
    Ok(((fps * 1000.0).round() as u32, 1000))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TimelineRenderOutcome {
    pub ok: bool,
    pub frames: u64,
    /// How many contiguous segments this render actually used (D-360) — 1 for
    /// the single-stream path. Reported because it is decided here, from the
    /// machine, and is otherwise invisible to the caller that asked for it.
    pub segments: usize,
    pub ms: u128,
    pub stderr_tail: String,
    /// D-401 — what the loudness pass measured and did, when one was requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loudness: Option<LoudnessReport>,
    /// D-441 — the render was cancelled (`ok` is then `false` and the partial
    /// output has been removed).
    pub cancelled: bool,
    /// B-380 — where this render's time went, stage by stage.
    pub stages: RenderStages,
}

/// **B-380 — where a render's time went.**
///
/// Measured, not estimated: each field is an `Instant` pair around the stage it
/// names, taken where that stage already runs. Two kinds of number, and the
/// difference matters when reading them:
///
/// - **wall** (`render_ms`, `concat_ms`, `loudness_ms`): elapsed time of a phase
///   of the export, as the person waits for it. They add up to `ms`, give or
///   take set-up.
/// - **summed over segments** (`frame_ms`, `resize_ms`, `handoff_wait_ms`): each
///   segment worker's own time in that step, added across the workers. With N
///   segments running at once these can total up to N × `render_ms`; their
///   RATIO to each other is what says which step a worker spends its life in.
///
/// `handoff_wait_ms` is the compositor blocked on a full [`WRITE_AHEAD`]
/// channel, i.e. waiting for the ENCODER: near zero means the encoder keeps up
/// and the compositor is the bottleneck; large means the opposite. `frame_ms`
/// is decode + composite (`render_timeline_frame` does both). D-449 — the
/// `gpu_*` fields split the composite out of it: the GPU engine's own counters
/// across this render (summed over the segment workers, and over anything else
/// drawing at the same time, which in an export is nothing): recording and
/// uploading each frame (on the worker, so inside `frame_ms`), waiting for the
/// GPU to finish it and copying it back (on the segment's writer thread,
/// overlapped with the worker's next frame), and the bytes moved each way.
/// `frame_ms - gpu_record_ms` is then decode and the CPU-side frame set-up
/// (layer resolution, titles, captions).
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderStages {
    pub frame_ms: u64,
    pub resize_ms: u64,
    pub handoff_wait_ms: u64,
    pub render_ms: u64,
    pub concat_ms: u64,
    pub loudness_ms: u64,
    pub gpu_frames: u64,
    pub gpu_record_ms: u64,
    pub gpu_wait_ms: u64,
    pub gpu_readback_ms: u64,
    pub gpu_upload_bytes: u64,
    pub gpu_readback_bytes: u64,
    /// D-452 — summed over the segments' writer threads: handing finished
    /// frames to the VideoToolbox encoder and writing its file (waiting on the
    /// media engine and AVAssetWriter).
    pub encode_ms: u64,
}

impl RenderStages {
    /// Fill the `gpu_*` fields from the engine's counters across this render.
    fn with_engine(mut self, before: &apelles_compositor::EngineStats) -> Self {
        let d = super::gpu_compositor::stats().since(before);
        self.gpu_frames = d.frames;
        self.gpu_record_ms = millis(d.record);
        self.gpu_wait_ms = millis(d.gpu);
        self.gpu_readback_ms = millis(d.readback);
        self.gpu_upload_bytes = d.upload_bytes;
        self.gpu_readback_bytes = d.readback_bytes;
        self
    }

    /// The summed-over-segments half, from each worker's outcome.
    fn from_segments<'a>(parts: impl IntoIterator<Item = &'a SegmentOutcome>) -> Self {
        let mut st = RenderStages::default();
        for p in parts {
            st.frame_ms += millis(p.frame_time);
            st.resize_ms += millis(p.resize_time);
            st.handoff_wait_ms += millis(p.handoff_wait);
            st.encode_ms += millis(p.encode_time);
        }
        st
    }
}

fn millis(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// How many finished frames may sit between the compositor and the encoder
/// (D-351).
///
/// **A bound, chosen for memory, not a queue depth to tune.** Each buffered
/// frame is one full output-size RGBA canvas — 33.2 MB at 3840×2160 — so this
/// number times the frame size IS the extra resident memory this hand-off can
/// ever cost: 133 MB at 4K, 33 MB at 1080p. Deliberately small: the only thing
/// it has to cover is the encoder's jitter frame to frame, and B-229/B-230 were
/// both "a per-unit cost nobody bounded", so a render path that answered them
/// by growing an unbounded frame queue of its own would have reintroduced their
/// exact shape one layer up.
///
/// Four rather than one because a `sync_channel(0)` rendezvous would put the
/// encoder's latency straight back on the compositor's thread, which is the
/// whole point of the hand-off.
const WRITE_AHEAD: usize = 4;

/// **D-360 — the smallest stretch of timeline worth giving its own worker.**
///
/// Every segment starts COLD: one keyframe seek per visible video track before
/// its first frame, measured by `decode_pipe` itself at 248-337 ms and a median
/// 723 ms on the owner's C040 footage. That cost is paid once per segment and
/// amortised over the frames in it, so the split only pays when a segment is
/// many times longer than its own start-up. At the ~16 fps this path renders
/// the 1080p stress fixture at, 90 frames is ~5.6 s of work against ~0.7 s of
/// cold start — a ~12% tax on that segment, against the whole core it buys.
/// Below that the arithmetic turns over and a split makes the export slower.
const MIN_SEGMENT_FRAMES: u64 = 90;

/// **The ceiling on concurrent segments (D-360; retuned by D-452).**
///
/// D-360 set six from a throughput sweep, when each segment was an ffmpeg
/// encoder plus one ffmpeg decoder per visible track, all competing for the
/// cores. Since D-452 a segment is a few threads around the media engine: its
/// frames decode on the hardware decoder, are drawn on the GPU and encode on
/// the hardware encoder, and the CPU is nearly idle (5–7% of ten cores on the
/// benchmark). What every segment now shares is that one hardware encoder.
/// Measured on the 60 s benchmark (`export_bench`, best of one per count, a
/// busy shared machine):
///
/// | segments | 1080p | 4K |
/// |---|---|---|
/// | 1 | 0.18× | 0.50× |
/// | 2 | 0.13–0.16× | 0.49× |
/// | 3 | 0.14× | 0.49× |
/// | 4 | 0.14× | 0.50× |
/// | 6 | 0.15× | — |
///
/// At 4K the encoder is the floor at any count; at 1080p a second segment keeps
/// it fed while the first one decodes, and more change nothing. Two keeps the
/// whole gain with the fewest seams and the least memory.
const MAX_SEGMENTS: usize = 2;

/// The argv placeholder `timelinePipeExport.ts` writes where the remux's
/// concat list goes. Substituted here because only this side knows the
/// temporary directory; the argv is otherwise compiled entirely by the caller,
/// which is the D-350 split.
///
/// Its TypeScript twin is `CONCAT_LIST_TOKEN` in
/// `packages/editor/src/timelinePipeExport.ts`, kept honest by
/// `the_mux_argv_token_matches_the_typescript_compiler` reading it out of the
/// shared fixture — the same cross-engine pair pattern D-338/B-201 uses.
const CONCAT_LIST_TOKEN: &str = "{{APELLES_CONCAT_LIST}}";

/// How many contiguous segments to split a render of `frames` into on THIS
/// machine (D-360; the core bound corrected by B-234/D-369).
///
/// Bounded four ways: by the work available
/// ([`MIN_SEGMENT_FRAMES`]), by the cores available **divided by how many
/// processes each segment actually spawns**, by available memory over the
/// estimated per-segment footprint at the output size (B-340), and by
/// [`MAX_SEGMENTS`]. A short
/// export comes back as 1 and takes the single-stream path unchanged.
///
/// **B-234 — why `procs_per_segment` and not just `cores`.** [`MAX_SEGMENTS`]'s
/// own doc states the cost model: a segment costs `tracks + 1` processes (one
/// encoder plus one `decode_pipe` per visible video track), so a render costs
/// `segments × (tracks + 1)`. That product was used to argue the MEMORY
/// ceiling but never applied to the CPU bound, which compared `segments`
/// against `cores` as though a segment were one process. On a 2-video-track
/// project that is a 3× undercount: 6 segments on 10 cores is 18 processes,
/// not 6.
///
/// Measured on the real 98-clip 4K c038 export (B-234's 2026-10-06 profiling):
/// 18 ffmpeg processes, load average ~50 on 10 logical cores, and one
/// straggler lane that wrote **+4.7 MB in 10.5 min while contending, then
/// +57.8 MB in 5 min once the other five finished** — ~24× faster with
/// nothing else changed. Lanes were starving each other, and because the
/// concat waits on the slowest, the wall clock paid the contention AND then
/// waited on the straggler. That measurement is also what ruled out the
/// "cores already saturated by useful work" explanation: saturation cannot
/// produce a 24× speedup from merely removing competition.
///
/// Dividing is the conservative choice rather than a tuned one. There is no
/// measured oversubscription ratio that works — the honest reading of the
/// evidence is one process per core, and [`MAX_SEGMENTS`]'s own closing line
/// about the unmeasured 4K case ("every unknown there points the same way:
/// fewer, not more") points here too.
fn plan_segment_count(frames: u64, procs_per_segment: usize, width: u32, height: u32) -> usize {
    let cores = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1);
    segment_count_for(
        frames,
        procs_per_segment,
        cores,
        available_memory_bytes(),
        width,
        height,
    )
}

/// Resident bytes per output pixel for one decode stream (D-452: the media
/// engine's reader holds its read-ahead plus the frame in hand and the last one
/// handed out, each 1.5 bytes a pixel at 4:2:0, 3 at 10-bit). Measured: the 4K
/// benchmark's two segments of three tracks added 143 MB in all, far under
/// this; it errs high.
const DECODER_BYTES_PER_PIXEL: u64 = 12;
/// Resident bytes per output pixel for the segment's VideoToolbox encoder (its
/// pool of target buffers and its own reference frames). An estimate that
/// errs high, as above.
const ENCODER_BYTES_PER_PIXEL: u64 = 16;
/// The [`WRITE_AHEAD`] frames in flight to the encoder: pool buffers of up to 4
/// bytes a pixel each (BGRA for ProRes).
const WRITE_AHEAD_BYTES_PER_PIXEL: u64 = 4 * WRITE_AHEAD as u64;
/// Fixed per-segment overhead (threads, the encoder session, GPU state).
const SEGMENT_FIXED_BYTES: u64 = 100 * 1024 * 1024;
/// Share of the memory available right now that an export may plan to use. The
/// rest is headroom for the app, the OS and other work, so a 16 GB Mac is not
/// pushed into compression or swap (B-340).
const MEMORY_BUDGET_PERCENT: u64 = 50;

/// Estimated resident bytes of ONE segment at `width`x`height` with
/// `procs_per_segment` processes (one encoder + a decoder per visible video
/// track). The codec is not an input: the compiled argv is opaque to this side
/// (D-350), and the encoder constant is sized for the heaviest case.
fn segment_memory_bytes(procs_per_segment: usize, width: u32, height: u32) -> u64 {
    let pixels = u64::from(width) * u64::from(height);
    let decoders = procs_per_segment.saturating_sub(1) as u64;
    SEGMENT_FIXED_BYTES
        + pixels
            * (decoders * DECODER_BYTES_PER_PIXEL
                + ENCODER_BYTES_PER_PIXEL
                + WRITE_AHEAD_BYTES_PER_PIXEL)
}

/// Memory available to start new work right now, in bytes (`sysinfo`, already
/// a dependency of this crate). 0 when the platform cannot report it, which
/// plans a single segment: the conservative answer.
fn available_memory_bytes() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.available_memory()
}

/// The pure form of [`plan_segment_count`]: every machine input is a parameter
/// so the memory bound (B-340) is unit-testable.
fn segment_count_for(
    frames: u64,
    procs_per_segment: usize,
    cores: usize,
    available_bytes: u64,
    width: u32,
    height: u32,
) -> usize {
    let by_work = (frames / MIN_SEGMENT_FRAMES) as usize;
    // `max(1)` on both: a caller reporting zero tracks (an audio-only or empty
    // timeline) must not divide by zero, and a machine the core count divides
    // away to nothing still renders — as one segment.
    let by_cores = (cores / procs_per_segment.max(1)).max(1);
    let budget = available_bytes / 100 * MEMORY_BUDGET_PERCENT;
    let per_segment = segment_memory_bytes(procs_per_segment, width, height).max(1);
    let by_memory = usize::try_from(budget / per_segment)
        .unwrap_or(usize::MAX)
        .max(1);
    by_work.min(by_cores).min(by_memory).clamp(1, MAX_SEGMENTS)
}

/// How many processes one segment of this timeline spawns: one encoder plus
/// one `decode_pipe` `ffmpeg` per VISIBLE VIDEO track (B-234/D-369).
///
/// Hidden video tracks are excluded because they are skipped by
/// `resolve_visible_video_layers_at` entirely and so never open a pipe; audio
/// tracks are excluded because this render path produces picture only (the
/// audio is the caller's own argv, one process for the whole export, not one
/// per segment).
fn procs_per_segment(timeline: &Timeline) -> usize {
    let visible_video = timeline
        .tracks
        .iter()
        .filter(|t| matches!(t.kind, TrackKind::Video) && !t.hidden)
        .count();
    visible_video + 1
}

/// The partition [`render_timeline`] hands its workers: `segments` contiguous,
/// non-overlapping ranges covering `0..frames` exactly, cut on this timeline's
/// own estimated work curve (B-234 lever 2, D-373).
///
/// One segment needs no curve and no arithmetic, so it does not build one.
fn plan_segment_ranges(
    timeline: &Timeline,
    frames: u64,
    segments: usize,
) -> Vec<std::ops::Range<u64>> {
    if segments <= 1 {
        let whole: std::ops::Range<u64> = 0..frames;
        return vec![whole];
    }
    segment_ranges(
        &super::render_cost::frame_cost_curve(timeline, frames),
        segments,
    )
}

/// Split `0..costs.len()` into `segments` contiguous, non-overlapping ranges of
/// roughly **equal estimated work**, where `costs[f]` is what frame `f` is
/// expected to cost (`chroma::render_cost`).
///
/// **Why work and not frame count (B-234 lever 2, D-373).** This function used
/// to divide the frame count, spreading the remainder so no two segments
/// differed by more than one frame — which is the right answer only if frames
/// are equal work, and they are not. A span of stacked full-frame 4K camera
/// costs several times a span that is one flat graphics panel, so equal-frame
/// lanes finish at wildly different times, and because the concat waits on the
/// slowest the export's wall clock is set by the straggler: measured on the real
/// 98-clip 4K c038 project at final segment sizes of **[367, 361, 176] MB**,
/// with the third lane tracking at ~45 % of its siblings for the entire run.
///
/// **Three properties, all of them load-bearing rather than tidy:**
/// 1. **The ranges partition `0..frames` exactly** — contiguous, in order, no
///    gaps and no overlaps. The concatenated output's frame accuracy rests on
///    it (the concat demuxer stitches whatever it is handed, so a segment one
///    frame short ships a valid file that is one frame out of sync from there
///    on), and D-362's progress percentage is only a true fraction of the
///    render because the tracker is built from these same ranges.
/// 2. **No segment is shorter than [`MIN_SEGMENT_FRAMES`]** where the render is
///    long enough to allow it. A segment pays a cold keyframe seek per visible
///    video track before its first frame (~0.7 s median), so a work-balanced
///    cut that handed a lane a handful of very expensive frames would spend
///    more on start-up than it saved on balance. Where the render is *not* long
///    enough, the floor drops to `frames / segments` and then to one frame — a
///    split this short never reaches production (`plan_segment_count` answers 1
///    for it) but the arithmetic must still be total.
/// 3. **Equal costs give an equal-frame split**, to within one frame, so a
///    timeline whose frames really are uniform partitions exactly as it did
///    before D-373.
///
/// The cumulative curve is strictly increasing (every frame costs at least
/// `render_cost`'s own frame base), which is what lets the ideal cut for each
/// segment be found by binary search rather than by walking.
fn segment_ranges(costs: &[u32], segments: usize) -> Vec<std::ops::Range<u64>> {
    let segments = segments.max(1) as u64;
    let frames = costs.len() as u64;
    if frames == 0 {
        // Nothing to render: still answer with the segment count asked for, so
        // the caller's own "one argv per range" bookkeeping holds.
        return vec![0..0; segments as usize];
    }
    let mut cum: Vec<u64> = Vec::with_capacity(costs.len() + 1);
    cum.push(0);
    for &c in costs {
        cum.push(cum[cum.len() - 1] + u64::from(c));
    }
    let total = cum[costs.len()];
    let min_len = MIN_SEGMENT_FRAMES.min(frames / segments).max(1);

    let mut ranges = Vec::with_capacity(segments as usize);
    let mut start = 0u64;
    for i in 1..=segments {
        if i == segments {
            ranges.push(start..frames);
            break;
        }
        // The first frame at which the cumulative cost reaches this segment's
        // ideal share of the whole.
        let ideal = cum.partition_point(|&c| c < total * i / segments) as u64;
        // Clamped so every later segment still has `min_len` frames to take,
        // and — where that leaves room — so this one is at least `min_len`
        // long itself. The reserve wins over the minimum, because a segment
        // below the minimum is slow while an EMPTY segment is a zero-frame
        // file handed to the concat demuxer.
        let hi = frames.saturating_sub((segments - i) * min_len).max(start);
        let lo = (start + min_len).min(hi);
        let end = ideal.clamp(lo, hi);
        ranges.push(start..end);
        start = end;
    }
    ranges
}

/// Replace the single occurrence of `token` in `args` with `value`.
///
/// An exact whole-argument match, and exactly one of them — a token that is
/// missing, or present twice, is a compiler/renderer disagreement about the
/// argv contract and is reported rather than papered over.
fn substitute_token(args: &[String], token: &str, value: &Path) -> Result<Vec<String>, String> {
    let hits = args.iter().filter(|a| a.as_str() == token).count();
    if hits != 1 {
        return Err(format!(
            "the segmented export argv must contain {token} exactly once, found {hits}"
        ));
    }
    Ok(args
        .iter()
        .map(|a| {
            if a.as_str() == token {
                value.to_string_lossy().into_owned()
            } else {
                a.clone()
            }
        })
        .collect())
}

/// One line of an ffmpeg **concat demuxer** list.
///
/// The demuxer's own quoting rules: the path is single-quoted, and a literal
/// `'` inside it is written `'\''`. Our paths are generated inside a temporary
/// directory and contain neither, but escaping is a property of the format, not
/// of the paths we happen to produce.
fn concat_list_line(path: &Path) -> String {
    format!("file '{}'\n", path.to_string_lossy().replace('\'', "'\\''"))
}

/// Releases a render worker's whole decode-pipe lane when its segment ends
/// (D-360), however it ends.
///
/// RAII rather than a call at the bottom of the loop: a segment that returns
/// early on a decode error must still free its `ffmpeg` processes, and "the
/// Nth segment's cost stops when the Nth segment does" is the bound
/// [`MAX_SEGMENTS`] is multiplied against.
struct LaneGuard(apelles_media::decode_pipe::PipeLane);

impl Drop for LaneGuard {
    fn drop(&mut self) {
        apelles_media::decode_pipe::release_lane(self.0);
    }
}

/// The **canvas** to composite into for an output of `out` pixels, given a
/// composition of `comp` — and whether the finished canvas still needs a
/// resize to reach `out`.
///
/// Rendering straight into the output size when we can is not an optimisation
/// detail, it is most of the cost: a 4K composition exported at 1080p
/// composites four times as many pixels per layer per frame if the canvas is
/// the composition. `max_long_edge` is exactly the knob the live preview
/// already uses for this, and every geometry field in the model is a ratio of
/// the composition (D-136), so the picture is the same at either canvas size up
/// to resampling.
///
/// Returns `(max_long_edge, needs_resize)`. `needs_resize` is true only when
/// the aspect ratios genuinely differ (or the output is an UPSCALE, which
/// `scale_target` refuses to do) — in which case the canvas is the composition
/// and the final `resize` to `out` is a real, deliberate stretch, matching what
/// the ffmpeg path's own output `scale` would have done.
fn canvas_plan(comp: (u32, u32), out: (u32, u32)) -> (Option<u32>, bool) {
    let long_edge = out.0.max(out.1);
    match apelles_media::decode_pipe::scale_target(comp.0, comp.1, long_edge) {
        Some(canvas) if canvas == out => (Some(long_edge), false),
        Some(_) => (Some(long_edge), true),
        // The output is at least as large as the composition on its long edge:
        // composite at the composition's own size (never upscale a layer twice)
        // and let the one final resize do the enlargement.
        None => (None, comp != out),
    }
}

/// Render `timeline` at `req.width`×`req.height` for `req.frames` frames, in
/// [`plan_segment_count`] contiguous segments, each into its own VideoToolbox
/// encoder, then remux them with the sound into `req.output` (D-360, D-452).
///
/// **Blocking, and each segment rendered in frame order** — frame `n` is
/// composited before frame `n + 1` is started, because a decode stream is a
/// strictly sequential forward reader and asking one for a frame it has
/// already passed costs a seek. See `docs/notes/export-gpu-compositor.md` §9
/// for why that makes a naive `par_iter` over frame indices the wrong shape,
/// and what IS parallel instead (segments).
///
/// **Handing the finished frame off is not in that order-bound path**: the
/// worker submits frame `n` to the GPU, written into one of its encoder's pool
/// buffers, and hands it to the segment's writer thread through a bounded
/// channel ([`WRITE_AHEAD`]); the writer waits for the GPU and gives the
/// buffer to the encoder while the worker decodes frame `n + 1`.
pub fn render_timeline(
    timeline: &Timeline,
    settings: &ProjectSettings,
    req: &TimelineRenderRequest,
) -> Result<TimelineRenderOutcome, String> {
    if req.width == 0 || req.height == 0 {
        return Err("render width and height must both be > 0".to_string());
    }
    let out = (req.width, req.height);
    // B-276 — a project with no size of its own is composed at the requested
    // output size, the same reading the export compiler takes, rather than
    // refused.
    let comp = edit::derived_composition_size(settings, timeline)?.unwrap_or(out);
    let canvas = canvas_plan(comp, out);
    grade_preflight(timeline)?;
    let started = Instant::now();
    let engine_before = super::gpu_compositor::stats();

    // D-441 — registered before anything starts, so a job cancelled while it
    // was being started is refused here instead of rendering anyway.
    let cancel = match export_job::register(req.cancel_token.as_deref()) {
        Ok(g) => g,
        Err(reason) if reason == export_job::CANCELLED_MESSAGE => {
            return Ok(cancelled_outcome(started));
        }
        Err(e) => return Err(e),
    };
    if let Some(output) = req.output.as_deref() {
        export_job::ensure_output_dir(Path::new(output))?;
    }

    // D-360 — split into contiguous segments when this machine and this
    // export are big enough to be worth it. D-362 — the partition is decided
    // HERE, once, because the progress tracker is built from the same ranges
    // the workers walk. D-373 — cut on this timeline's own estimated WORK
    // curve, not on the frame count, so the lanes finish together.
    let segments = plan_segment_count(
        req.frames,
        procs_per_segment(timeline),
        req.width,
        req.height,
    );
    // No segment may be empty: it would write a file with no frames.
    let segments = segments.clamp(1, req.frames.max(1) as usize);
    let ranges = plan_segment_ranges(timeline, req.frames, segments);

    let job = export_status::begin(
        req.frames,
        &ranges,
        req.output.clone(),
        export_status::STALL_TIMEOUT,
    )?;
    // D-441 — the remux this job attaches is now also killed by a cancel, and
    // the per-frame loops stop on it.
    job.bind_cancel(cancel.handle().clone());

    let outcome = render_segmented(timeline, settings, req, &ranges, out, canvas, &job, started);

    // D-441 — a cancel outranks every other outcome: a loudness pass that
    // finished after the cancel produced a file nobody wants. Remove what was
    // written.
    if cancel.is_cancelled() {
        return Ok(finish_cancelled(req, &job, started));
    }

    // D-362 — the watchdog's verdict outranks whatever error the stop it
    // caused produced downstream: the stall reason names the cause.
    match outcome {
        Ok(mut o) => {
            o.stages = o.stages.with_engine(&engine_before);
            // D-401 — the loudness pass is part of the job: the status reads
            // `normalising`, not `done`, until the file is final.
            match req.loudness {
                None => {
                    job.finish(Ok(()));
                    Ok(o)
                }
                Some(target) => match normalise_output(req, target, &job) {
                    Ok(_) if cancel.is_cancelled() => Ok(finish_cancelled(req, &job, started)),
                    Ok(report) => {
                        // B-380 — the pass is the time since the render's
                        // own `ms`, and the export's `ms` now includes it.
                        let now = started.elapsed();
                        o.stages.loudness_ms =
                            millis(now).saturating_sub(u64::try_from(o.ms).unwrap_or(u64::MAX));
                        o.ms = now.as_millis();
                        o.loudness = Some(report);
                        job.finish(Ok(()));
                        Ok(o)
                    }
                    Err(e) => {
                        job.finish(Err(e.clone()));
                        Err(e)
                    }
                },
            }
        }
        Err(e) => {
            let e = job.stall_reason().unwrap_or(e);
            job.finish(Err(e.clone()));
            Err(e)
        }
    }
}

/// D-448 / D-450 — every graded clip's grade, read before the first frame.
/// The preview's per-frame lookup (`grade_pass::grade_for_clip`) shows a clip
/// ungraded when its grade cannot be read, which is the right degrade on
/// screen and the wrong one in a file: here such a grade refuses the render,
/// naming the clip, instead of exporting it without its grade. Memoised, so a
/// timeline the Export panel's pre-flight (`chroma_timeline_grade_luts`)
/// already checked costs a cache lookup per clip.
fn grade_preflight(timeline: &Timeline) -> Result<(), String> {
    for track in &timeline.tracks {
        if !matches!(track.kind, apelles_timeline::TrackKind::Video) {
            continue;
        }
        for clip in track.clips.iter().filter(|c| !c.is_generated()) {
            super::grade_pass::resolve_clip_grade(&clip.id).map_err(|e| {
                format!(
                    "clip {}'s Colorist grade could not be read, so it was not exported: {e}",
                    clip.name
                )
            })?;
        }
    }
    Ok(())
}

/// D-441 — what a render that was cancelled before it started answers.
fn cancelled_outcome(started: Instant) -> TimelineRenderOutcome {
    TimelineRenderOutcome {
        ok: false,
        frames: 0,
        segments: 0,
        ms: started.elapsed().as_millis(),
        stderr_tail: export_job::CANCELLED_MESSAGE.to_string(),
        loudness: None,
        cancelled: true,
        stages: RenderStages::default(),
    }
}

/// D-441 — settle a cancelled render: the status slot reads `cancelled`, and
/// the partial output (and any loudness scratch file) is removed. The segment
/// directory is a `TempDir` and has already removed itself.
fn finish_cancelled(
    req: &TimelineRenderRequest,
    job: &ExportJob,
    started: Instant,
) -> TimelineRenderOutcome {
    job.finish_cancelled();
    if let Some(output) = req.output.as_deref() {
        export_job::discard_partial_output(Path::new(output));
    }
    cancelled_outcome(started)
}

/// D-401 — run the loudness pass over the finished render, inside its job.
fn normalise_output(
    req: &TimelineRenderRequest,
    target: LoudnessTarget,
    job: &ExportJob,
) -> Result<LoudnessReport, String> {
    let output = req
        .output
        .as_deref()
        .ok_or("a loudness target needs the export's output path")?;
    job.enter_normalise();
    let report = loudness::normalise_in_place(Path::new(output), target)?;
    job.set_loudness(report.clone());
    Ok(report)
}

/// **Wait for a child, but never forever (D-362).**
///
/// Every `wait` in this module is on an `ffmpeg` that has already been told
/// there is no more input, so it should exit promptly — but B-231 facet 2 is
/// precisely an `ffmpeg` that stopped doing anything while staying alive, and a
/// plain `wait` on one of those is an unkillable, unreportable hang. Past the
/// limit the child is killed and the caller gets a real error naming what it
/// was waiting for.
fn wait_bounded(
    child: &SharedChild,
    limit: std::time::Duration,
    what: &str,
) -> Result<std::process::ExitStatus, String> {
    match child.wait_timeout(limit) {
        Ok(Some(status)) => Ok(status),
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "{what} stopped responding: it did not exit within {}s of being told its input \
                 had ended, and was killed. Any output file it was writing is incomplete and was \
                 never finalised.",
                limit.as_secs()
            ))
        }
        Err(e) => Err(format!("wait for {what}: {e}")),
    }
}

/// D-452 — one frame on its way to a segment's encoder: the GPU is writing
/// it into `buffer`, one of the encoder's own pool buffers.
struct Outgoing {
    frame: super::gpu_compositor::GpuFrame,
    buffer: apelles_types::video_frame::PixelBuffer,
}

/// What one segment's worker produced.
struct SegmentOutcome {
    written: u64,
    /// B-380 — this worker's time in `render_timeline_frame_deferred` (decode
    /// and recording the frame), blocked handing frames to its writer, and the
    /// writer's time in the encoder. See [`RenderStages`].
    frame_time: std::time::Duration,
    resize_time: std::time::Duration,
    handoff_wait: std::time::Duration,
    encode_time: std::time::Duration,
}

/// **Render `range` of the timeline into its own video-only file, and nothing
/// else** — the loop D-350 built and D-351 pipelined, with its frame range and
/// its decode lane made parameters (D-360), and its encoder in process
/// (D-452).
///
/// One call is one contiguous stretch of frames, one VideoToolbox encoder, one
/// file and one decode lane, decoded strictly forward from `range.start`.
/// There is deliberately no second spelling of this loop.
#[allow(clippy::too_many_arguments)]
fn render_range(
    timeline: &Timeline,
    settings: &ProjectSettings,
    format: ExportVideoFormat,
    rate: (u32, u32),
    file: &Path,
    out: (u32, u32),
    canvas: (Option<u32>, bool),
    range: std::ops::Range<u64>,
    lane: apelles_media::decode_pipe::PipeLane,
    job: &Arc<ExportJob>,
    segment: usize,
) -> Result<SegmentOutcome, String> {
    let (max_long_edge, _needs_resize) = canvas;
    // Frees this segment's decoders however this function returns.
    let _lane = LaneGuard(lane);
    let encoder = apelles_media::vt_encode::SegmentEncoder::create(file, format.codec(), out, rate)
        .map_err(|e| format!("{e:#}"))?;
    let pool = encoder.buffers();
    let output = format.output();

    // D-351 — the writer. It owns the encoder and does nothing but drain the
    // channel in the order the worker produced it, so **frame order in the
    // file is structural**: a `sync_channel` is FIFO and there is exactly one
    // producer. The progress heartbeat (D-362) is taken here, one tick per
    // frame that really reached the encoder, which is what lets one counter
    // serve as both the progress number and the watchdog's liveness signal.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Outgoing>(WRITE_AHEAD);
    let writer = {
        let job = job.clone();
        std::thread::spawn(move || -> Result<(u64, std::time::Duration), String> {
            let mut encoder = encoder;
            let mut encode_time = std::time::Duration::ZERO;
            let mut n = 0u64;
            for item in rx {
                item.frame.wait_written()?;
                let started = Instant::now();
                encoder
                    .encode(&item.buffer)
                    .map_err(|e| format!("encode: {e:#}"))?;
                encode_time += started.elapsed();
                n += 1;
                job.frame_written(segment);
            }
            let started = Instant::now();
            encoder.finish().map_err(|e| format!("{e:#}"))?;
            encode_time += started.elapsed();
            Ok((n, encode_time))
        })
    };

    let mut render_err: Option<String> = None;
    let mut frame_time = std::time::Duration::ZERO;
    let mut handoff_wait = std::time::Duration::ZERO;
    for pos in range.clone() {
        // D-360/D-362/D-441 — a sibling failed, the watchdog fired, or the
        // export was cancelled: this segment's remaining frames are work
        // nobody will use.
        if job.should_stop() {
            render_err = Some("another segment failed, or the export was cancelled".to_string());
            break;
        }
        let frame_started = Instant::now();
        let buffer = match pool.pixel_buffer() {
            Ok(b) => b,
            Err(e) => {
                render_err = Some(format!("frame {pos}: {e:#}"));
                break;
            }
        };
        let to = super::gpu_compositor::Destination::Encoder {
            buffer: buffer.clone(),
            format: output,
        };
        let rendered = edit::render_timeline_frame_deferred(
            timeline,
            settings,
            pos,
            max_long_edge,
            // **`Single`, not `Playing` — measured.** An export walks strictly
            // forward, which looks like the access pattern `Playing`'s
            // cut-boundary prefetch (D-324) exists to smooth, but a standby per
            // boundary half a second ahead only pays when a person watches in
            // real time; at full speed it ran two decoders where one would do
            // (+35% peak RSS, 3x wall time on the 20-cut fixture, §6).
            FrameIntent::Single,
            lane,
            &to,
        )
        .and_then(|r| match r {
            Some(edit::RenderedFrame::Gpu(frame)) => Ok(frame),
            // Nothing visible here — a gap under every track: opaque black,
            // which is what the compositor's canvas starts as.
            None => super::gpu_compositor::submit(
                &apelles_compositor::FramePlan {
                    width: out.0,
                    height: out.1,
                    background: apelles_compositor::Background::Solid([0, 0, 0, 255]),
                    steps: Vec::new(),
                },
                &to,
            ),
        });
        frame_time += frame_started.elapsed();
        let frame = match rendered {
            Ok(f) => f,
            Err(e) => {
                render_err = Some(format!("frame {pos}: {e}"));
                break;
            }
        };
        let handoff_started = Instant::now();
        let sent = tx.send(Outgoing { frame, buffer });
        handoff_wait += handoff_started.elapsed();
        if sent.is_err() {
            // The writer is gone, which only happens when its GPU wait or its
            // encode failed — its own error is the real one, taken below.
            render_err = Some(format!("frame {pos}: the encoder stopped"));
            break;
        }
    }

    drop(tx); // ends the writer's loop → the encoder finishes its file
    let joined = writer.join();
    job.segment_finished(segment);
    let (written, encode_time) = match joined {
        Ok(Ok(done)) => done,
        Ok(Err(e)) => return Err(render_err.map_or(e.clone(), |r| format!("{r} — {e}"))),
        Err(_) => return Err("the encoder writer thread panicked".to_string()),
    };
    if let Some(e) = render_err {
        return Err(e);
    }
    let wanted = range.end - range.start;
    if written != wanted {
        return Err(format!(
            "segment {}..{} wrote {written} frames, not {wanted}",
            range.start, range.end
        ));
    }
    Ok(SegmentOutcome {
        written,
        frame_time,
        resize_time: std::time::Duration::ZERO,
        handoff_wait,
        encode_time,
    })
}

/// **D-360 — the contiguous-segment render: N workers, N lanes, N encoders,
/// one remux.**
///
/// Renders each of `ranges` at once, each into its own file, then hands the
/// files to the caller-compiled remux argv — which is also where the audio mix
/// is muxed in, since the sound is compiled for the whole timeline and has no
/// notion of the split. One segment is the same path with one range.
///
/// **Why this is the shape that scales where D-351's could not** (§9.2):
/// giving each worker every Lth frame leaves every worker *decoding* every
/// frame, because a decode stream can only read forward. Contiguous ranges
/// divide the decode too, because worker `k` decodes only its own range.
///
/// **Frame accuracy across a boundary is structural, not checked afterwards.**
/// [`segment_ranges`] partitions `0..frames`, each worker asserts it wrote its
/// own range's length exactly, and this function asserts the total; each
/// segment file's clock is exact at `n / fps` (D-452), so the concat demuxer
/// joins them without a seam.
#[allow(clippy::too_many_arguments)]
fn render_segmented(
    timeline: &Timeline,
    settings: &ProjectSettings,
    req: &TimelineRenderRequest,
    ranges: &[std::ops::Range<u64>],
    out: (u32, u32),
    canvas: (Option<u32>, bool),
    job: &Arc<ExportJob>,
    started: Instant,
) -> Result<TimelineRenderOutcome, String> {
    let rate = frame_rate(req.fps)?;
    let dir = tempfile::Builder::new()
        .prefix("apelles-render-")
        .tempdir()
        .map_err(|e| format!("create the segment directory: {e}"))?;
    let files: Vec<PathBuf> = (0..ranges.len())
        .map(|i| dir.path().join(segment_file_name(i, req.format)))
        .collect();

    let results: Vec<Result<SegmentOutcome, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = ranges
            .iter()
            .zip(&files)
            .enumerate()
            .map(|(i, (range, file))| {
                let range = range.clone();
                scope.spawn(move || {
                    let outcome = render_range(
                        timeline,
                        settings,
                        req.format,
                        rate,
                        file,
                        out,
                        canvas,
                        range,
                        apelles_media::decode_pipe::PipeLane::render(i),
                        job,
                        i,
                    );
                    if outcome.is_err() {
                        job.abort()
                            .store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    outcome
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err("a segment worker panicked".to_string()))
            })
            .collect()
    });

    let render_ms = millis(started.elapsed());
    let mut written = 0u64;
    let mut finished: Vec<SegmentOutcome> = Vec::with_capacity(results.len());
    for (i, result) in results.into_iter().enumerate() {
        match result {
            Ok(outcome) => {
                written += outcome.written;
                finished.push(outcome);
            }
            Err(e) if ranges.len() == 1 => return Err(e),
            Err(e) => return Err(format!("segment {i}: {e}")),
        }
    }
    let mut stages = RenderStages::from_segments(&finished);
    stages.render_ms = render_ms;
    if written != req.frames {
        return Err(format!(
            "the segments wrote {written} frames between them, not the {} asked for",
            req.frames
        ));
    }

    // D-362 — every frame is rendered; what is left is the join and the audio
    // mux. Said out loud so the last stretch of a long export reads as
    // `concatenating` rather than a stuck 100%.
    job.enter_concat();
    let concat_started = Instant::now();
    let list = dir.path().join("segments.txt");
    let listing: String = files.iter().map(|f| concat_list_line(f)).collect();
    std::fs::write(&list, listing).map_err(|e| format!("write the concat list: {e}"))?;
    let mux = substitute_token(&req.args, CONCAT_LIST_TOKEN, &list)?;
    // A `SharedChild`, for [`wait_bounded`] and so a cancel can kill it: the
    // remux makes no per-frame progress for the watchdog to read, so it bounds
    // itself. It is `-c:v copy` over finished files and normally takes
    // seconds — but "it normally finishes" is exactly what B-231 says about
    // the rest of this path.
    let joiner = Arc::new(
        SharedChild::spawn(
            ffmpeg_locate::ffmpeg()
                .map_err(|e| e.to_string())?
                .args(&mux)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped()),
        )
        .map_err(|e| format!("spawn the remux: {e}"))?,
    );
    job.attach_aux(&joiner);
    let mux_err = drain_stderr_pipe(joiner.take_stderr());
    let status = wait_bounded(&joiner, job.stall_after(), "the remux")?;
    if !status.success() {
        return Err(format!(
            "joining {} segments and adding the sound exited {}: {}",
            files.len(),
            status,
            tail(&mux_err)
        ));
    }
    stages.concat_ms = millis(concat_started.elapsed());
    Ok(TimelineRenderOutcome {
        ok: true,
        frames: written,
        segments: files.len(),
        ms: started.elapsed().as_millis(),
        stderr_tail: tail(&mux_err),
        loudness: None,
        cancelled: false,
        stages,
    })
}

/// **D-441/D-452 — a segment's file name, in the OUTPUT's container.**
///
/// Segments are `-c:v copy`-remuxed into the output, so they are the
/// container that holds the output's codec: an H.264 export's segments are
/// `.mp4`, the ProRes master's are `.mov` (the mp4 muxer does not take
/// ProRes).
fn segment_file_name(index: usize, format: ExportVideoFormat) -> String {
    format!("segment-{index:03}.{}", format.segment_extension())
}

/// `editor_export`'s D-350 render path, as a Tauri command: resolve the OPEN
/// project's timeline once (the active one, or `req.timeline_id`'s — D-411),
/// then [`render_timeline`] it.
///
/// Resolving once — rather than per frame, as the preview path did before D-350
/// split `render_timeline_frame` out — is not a micro-optimisation: the
/// document cannot change while this runs, and a 4-minute 60 fps export would
/// otherwise re-parse the project manifest ~14,000 times.
#[tauri::command]
pub async fn chroma_render_timeline_export(
    req: TimelineRenderRequest,
) -> Result<TimelineRenderOutcome, String> {
    tokio::task::spawn_blocking(move || {
        let (stored, settings) =
            edit::resolve_timeline_by_id_and_settings(req.timeline_id.as_deref())?;
        // D-448 — the compiled copy when the compiler sent one.
        let timeline = req.timeline.as_ref().unwrap_or(&stored);
        render_timeline(timeline, &settings, &req)
    })
    .await
    .map_err(|e| format!("timeline render task: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canvas_plan_renders_straight_into_a_matching_downscale() {
        // The common case: a 4K composition exported at 1080p. Same aspect, so
        // the compositor's own canvas IS the output and nothing is resized
        // afterwards — a quarter of the per-layer pixel work of compositing at
        // 4K and then shrinking.
        assert_eq!(canvas_plan((3840, 2160), (1920, 1080)), (Some(1920), false));
    }

    #[test]
    fn canvas_plan_resizes_when_the_aspect_ratio_really_differs() {
        // 16:9 composition, 1:1 output — a genuine stretch, which the ffmpeg
        // path's own output `scale` would also have done. `scale_target` gives
        // 1080x608 for a 1080 long edge, so a real resize to 1080x1080 follows.
        let (le, resize) = canvas_plan((3840, 2160), (1080, 1080));
        assert_eq!(le, Some(1080));
        assert!(resize, "a differing aspect ratio must still be resized");
    }

    #[test]
    fn canvas_plan_never_upscales_the_canvas_to_reach_a_larger_output() {
        // Output larger than the composition: composite at the composition's
        // own size (so no layer is enlarged twice) and enlarge once at the end.
        assert_eq!(canvas_plan((1280, 720), (1920, 1080)), (None, true));
    }

    #[test]
    fn canvas_plan_is_a_no_op_when_output_is_the_composition() {
        assert_eq!(canvas_plan((1920, 1080), (1920, 1080)), (None, false));
    }

    /// Assert [`segment_ranges`]' own contract on one answer: `segments`
    /// contiguous ranges, in order, covering `0..frames` with no gap and no
    /// overlap. Returns the lengths so a caller can go on to assert what KIND
    /// of split it got.
    ///
    /// **D-360 — this is the property the concatenated output's frame accuracy
    /// rests on.** A partition that lost or repeated a frame would not fail
    /// anywhere else: the concat demuxer stitches whatever it is given, so a
    /// short segment simply ships a video that is out of sync from that point
    /// on. D-362 added a second consumer with the same requirement — the
    /// progress tracker is built from these ranges, so the percentage is only a
    /// true fraction of the render if they partition it exactly.
    fn assert_partitions(
        ranges: &[std::ops::Range<u64>],
        frames: u64,
        segments: usize,
    ) -> Vec<u64> {
        let what = format!("{frames} frames / {segments} segments");
        assert_eq!(ranges.len(), segments, "{what}: segment count");
        assert_eq!(ranges[0].start, 0, "{what}: starts at zero");
        assert_eq!(
            ranges[ranges.len() - 1].end,
            frames,
            "{what}: ends at the last frame"
        );
        for pair in ranges.windows(2) {
            assert_eq!(
                pair[0].end, pair[1].start,
                "{what}: {pair:?} leaves a hole or overlaps"
            );
        }
        let lens: Vec<u64> = ranges.iter().map(|r| r.end - r.start).collect();
        assert_eq!(lens.iter().sum::<u64>(), frames, "{what}: total frames");
        lens
    }

    /// D-360/D-373 — the exact-partition property, over a flat curve (every
    /// frame the same cost) and over two deliberately lopsided ones. Whatever
    /// the curve, the ranges still cover the render exactly.
    #[test]
    fn segment_ranges_partition_the_render_exactly() {
        for (frames, segments) in [(60u64, 4usize), (5605, 8), (100, 3), (7, 4), (1, 1), (0, 4)] {
            let f = frames as usize;
            let curves: [Vec<u32>; 3] = [
                vec![7; f],
                // All the work at the front, and all of it at the back: the two
                // shapes most likely to push a boundary off the end.
                (0..f).map(|i| if i < f / 4 { 50 } else { 1 }).collect(),
                (0..f).map(|i| if i < f / 4 { 1 } else { 50 }).collect(),
            ];
            for (which, costs) in curves.iter().enumerate() {
                let ranges = segment_ranges(costs, segments);
                let lens = assert_partitions(&ranges, frames, segments);
                assert!(
                    lens.iter().sum::<u64>() == frames,
                    "curve {which}: {lens:?}"
                );
            }
        }
    }

    /// D-373 — a timeline whose frames really are uniform must partition
    /// exactly as it did before the cost model existed: within one frame of an
    /// even split. The cost model only has licence to move a boundary when the
    /// work is actually uneven.
    #[test]
    fn a_flat_cost_curve_still_splits_by_equal_frames() {
        for (frames, segments) in [(60u64, 4usize), (5605, 8), (100, 3), (7, 4), (240, 2)] {
            for cost in [1u32, 5, 11] {
                let lens = assert_partitions(
                    &segment_ranges(&vec![cost; frames as usize], segments),
                    frames,
                    segments,
                );
                let (lo, hi) = (
                    lens.iter().copied().min().unwrap_or(0),
                    lens.iter().copied().max().unwrap_or(0),
                );
                assert!(
                    hi - lo <= 1,
                    "{frames}/{segments} at a flat cost of {cost}: uneven split {lens:?}"
                );
            }
        }
    }

    /// **D-373 — the whole point of lever 2, and the assertion equal-frame
    /// splitting fails.**
    ///
    /// The first third of this render costs ten times the rest, exactly the
    /// shape B-234 measured on the real c038 project ([367, 361, 176] MB across
    /// three lanes). An equal-frame split would cut at 1000/2000; a
    /// work-balanced one has to cut much earlier, and the costs either side of
    /// the cuts have to come out close.
    #[test]
    fn segment_ranges_cut_early_when_the_work_is_front_loaded() {
        const FRAMES: u64 = 3_000;
        let costs: Vec<u32> = (0..FRAMES)
            .map(|f| if f < FRAMES / 3 { 30 } else { 3 })
            .collect();
        let total: u64 = costs.iter().map(|&c| u64::from(c)).sum();

        let ranges = segment_ranges(&costs, 3);
        let lens = assert_partitions(&ranges, FRAMES, 3);

        // 1 — the cuts really did move, and in the right direction. Equal
        //     frames would be [1000, 1000, 1000].
        assert!(
            lens[0] < 600,
            "the expensive first lane must get far fewer than its equal share \
             of the frames: {lens:?}"
        );
        assert!(
            lens[2] > 1_500,
            "the cheap last lane must get far more: {lens:?}"
        );

        // 2 — and the point of moving them: the lanes' estimated work is close,
        //     where an equal-frame split is wildly out. The ideal is
        //     total / 3 per lane.
        let cost_of = |r: &std::ops::Range<u64>| -> u64 {
            costs[r.start as usize..r.end as usize]
                .iter()
                .map(|&c| u64::from(c))
                .sum()
        };
        let balanced: Vec<u64> = ranges.iter().map(cost_of).collect();
        let spread = |c: &[u64]| {
            c.iter().copied().max().unwrap_or(0) as f64
                / c.iter().copied().min().unwrap_or(1) as f64
        };
        let equal_frames: Vec<u64> = (0..3)
            .map(|i| cost_of(&(i * FRAMES / 3..(i + 1) * FRAMES / 3)))
            .collect();
        assert!(
            spread(&balanced) < 1.1,
            "work-balanced lanes must be within 10% of each other: {balanced:?} \
             (ideal {} each)",
            total / 3
        );
        assert!(
            spread(&equal_frames) > 5.0,
            "this fixture has to be one equal-frame splitting really fails, or \
             the test proves nothing: {equal_frames:?}"
        );
    }

    /// D-373 — a cost-balanced cut must not produce a segment too short to
    /// amortise its own cold start, however concentrated the work is. The
    /// ideal cut here is at frame 5; [`MIN_SEGMENT_FRAMES`] is what stops it.
    #[test]
    fn segment_ranges_never_go_below_the_minimum_segment_length() {
        const FRAMES: u64 = 1_000;
        let costs: Vec<u32> = (0..FRAMES)
            .map(|f| if f < 10 { 10_000 } else { 1 })
            .collect();
        for segments in 2..=MAX_SEGMENTS {
            let lens = assert_partitions(&segment_ranges(&costs, segments), FRAMES, segments);
            assert!(
                lens.iter().all(|&l| l >= MIN_SEGMENT_FRAMES),
                "{segments} segments: {lens:?} has one below {MIN_SEGMENT_FRAMES}"
            );
        }
    }

    /// D-373 — the partition the planner actually hands the workers, derived
    /// from a real `Timeline` rather than a hand-written curve: a two-layer
    /// first half and a one-layer second half must not be cut down the middle.
    #[test]
    fn the_planner_splits_a_lopsided_timeline_off_centre() {
        use apelles_timeline::{Clip, Track, TrackKind};
        const FRAMES: u64 = 600;

        let clip = |id: &str, start: i64, duration: i64| Clip {
            id: id.to_string(),
            source_path: format!("/tmp/{id}.mp4"),
            start_frame: start,
            source_start: 0,
            duration,
            ..Default::default()
        };
        let track = |clips: Vec<Clip>| Track {
            kind: TrackKind::Video,
            clips,
            ..Default::default()
        };
        let timeline = Timeline {
            tracks: vec![
                // An overlay over the first half only.
                track(vec![clip("over", 0, FRAMES as i64 / 2)]),
                track(vec![clip("base", 0, FRAMES as i64)]),
            ],
            ..Default::default()
        };

        let lens = assert_partitions(&plan_segment_ranges(&timeline, FRAMES, 2), FRAMES, 2);
        assert!(
            lens[0] < FRAMES / 2,
            "the lane holding the stacked half must take fewer frames: {lens:?}"
        );
        assert_eq!(
            plan_segment_ranges(&timeline, FRAMES, 1),
            vec![0..FRAMES],
            "one segment is the whole render, with no curve built at all"
        );
    }

    /// D-360 — a render too short to be worth splitting takes the
    /// single-stream path, whatever the machine's core count.
    #[test]
    fn a_short_render_is_not_split() {
        assert_eq!(plan_segment_count(0, 2, 1920, 1080), 1);
        assert_eq!(plan_segment_count(MIN_SEGMENT_FRAMES - 1, 2, 1920, 1080), 1);
        assert_eq!(plan_segment_count(MIN_SEGMENT_FRAMES, 2, 1920, 1080), 1);
        // And a long one is bounded by MAX_SEGMENTS however many cores exist.
        assert!(plan_segment_count(u32::MAX as u64, 1, 1920, 1080) <= MAX_SEGMENTS);
    }

    /// B-234/D-369 — the core bound counts PROCESSES, not segments. A segment
    /// costs `tracks + 1` processes, so a heavier timeline must get fewer
    /// lanes on the same machine. Pre-fix this returned `MAX_SEGMENTS` for
    /// every one of these, which is how a 2-track export came to run 18
    /// ffmpeg processes on 10 cores.
    #[test]
    fn more_processes_per_segment_means_fewer_segments() {
        let long = u32::MAX as u64;
        let cores = std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(1);

        let mut prev = usize::MAX;
        for procs in 1..=8usize {
            let got = plan_segment_count(long, procs, 1920, 1080);
            assert!(
                got <= prev,
                "more processes per segment must never INCREASE the lane \
                 count: {procs} procs gave {got}, previous gave {prev}"
            );
            assert!(got >= 1, "must always render: {procs} procs gave 0");
            // The invariant that matters: total processes stay within the
            // machine, unless one segment alone already exceeds it.
            assert!(
                got * procs <= cores.max(procs),
                "{got} segments x {procs} procs = {} exceeds {cores} cores",
                got * procs
            );
            prev = got;
        }
    }

    /// B-340 — the segment count is bounded by memory too: a machine with
    /// little free memory gets one segment at 4K, more memory never means
    /// fewer segments, and every case still renders.
    #[test]
    fn the_segment_count_is_bounded_by_available_memory() {
        const MB: u64 = 1024 * 1024;
        let long = u32::MAX as u64;
        let many_cores = 64;
        let count =
            |procs, mb: u64, w, h| segment_count_for(long, procs, many_cores, mb * MB, w, h);
        // Planned footprint stays inside the budget whenever more than one lane runs.
        for mb in [256u64, 512, 1024, 2048, 16 * 1024] {
            let n = count(4, mb, 3840, 2160);
            assert!(n >= 1);
            if n > 1 {
                assert!(
                    n as u64 * segment_memory_bytes(4, 3840, 2160) <= mb * MB / 2,
                    "{n} lanes overshoot half of {mb} MB"
                );
            }
            assert!(
                count(4, mb * 2, 3840, 2160) >= n,
                "more memory, fewer lanes"
            );
            // 4K never gets more lanes than 1080p on the same RAM.
            assert!(n <= count(4, mb, 1920, 1080));
        }
        assert_eq!(
            count(4, 512, 3840, 2160),
            1,
            "512 MB free is one 4K segment"
        );
        assert_eq!(count(2, 16 * 1024, 1920, 1080), MAX_SEGMENTS);
        // No reported memory (or none free) still renders as one segment.
        assert_eq!(count(3, 0, 3840, 2160), 1);
    }

    /// A timeline with no visible video track still renders — the divisor is
    /// never zero, and the encoder itself is the `+ 1`.
    #[test]
    fn a_zero_track_timeline_still_plans_at_least_one_segment() {
        assert_eq!(
            plan_segment_count(u32::MAX as u64, 0, 1920, 1080),
            1.max(plan_segment_count(u32::MAX as u64, 0, 1920, 1080))
        );
        assert!(plan_segment_count(u32::MAX as u64, 0, 1920, 1080) >= 1);
    }

    /// B-234/D-369 — hidden video tracks open no decode pipe, so they must not
    /// cost a segment's budget; audio tracks never do either.
    #[test]
    fn procs_per_segment_counts_only_visible_video_tracks() {
        use apelles_timeline::{Track, TrackKind};
        let track = |kind, hidden| Track {
            kind,
            clips: vec![],
            gain: 1.0,
            locked: false,
            hidden,
            ..Default::default()
        };
        let tl = Timeline {
            tracks: vec![
                track(TrackKind::Video, false),
                track(TrackKind::Video, false),
                track(TrackKind::Video, true),  // hidden — no pipe
                track(TrackKind::Audio, false), // audio — no pipe on this path
            ],
            ..Default::default()
        };
        // 2 visible video + 1 encoder.
        assert_eq!(procs_per_segment(&tl), 3);

        assert_eq!(procs_per_segment(&Timeline::default()), 1);
    }

    #[test]
    fn segments_take_the_outputs_container() {
        assert_eq!(
            segment_file_name(0, ExportVideoFormat::ProresHq),
            "segment-000.mov"
        );
        assert_eq!(
            segment_file_name(12, ExportVideoFormat::H264),
            "segment-012.mp4"
        );
    }

    #[test]
    fn substitute_token_demands_exactly_one_placeholder() {
        let list = Path::new("/tmp/segments.txt");
        let ok = vec!["-i".to_string(), CONCAT_LIST_TOKEN.to_string()];
        assert_eq!(
            substitute_token(&ok, CONCAT_LIST_TOKEN, list),
            Ok(vec!["-i".to_string(), "/tmp/segments.txt".to_string()])
        );
        assert!(substitute_token(&[], CONCAT_LIST_TOKEN, list).is_err());
        let twice = vec![CONCAT_LIST_TOKEN.to_string(), CONCAT_LIST_TOKEN.to_string()];
        assert!(substitute_token(&twice, CONCAT_LIST_TOKEN, list).is_err());
    }

    /// D-452 — the encoder's clock: an NTSC rate is exact n·1000/1001, a whole
    /// rate itself, anything else to the nearest thousandth.
    #[test]
    fn a_frame_rate_is_the_exact_rational_its_file_is_timed_by() {
        assert_eq!(frame_rate(30.0), Ok((30, 1)));
        assert_eq!(frame_rate(29.97), Ok((30000, 1001)));
        assert_eq!(frame_rate(30000.0 / 1001.0), Ok((30000, 1001)));
        assert_eq!(frame_rate(23.976), Ok((24000, 1001)));
        assert_eq!(frame_rate(59.94), Ok((60000, 1001)));
        assert_eq!(frame_rate(12.5), Ok((12500, 1000)));
        assert!(frame_rate(0.0).is_err());
        assert!(frame_rate(f64::NAN).is_err());
    }

    /// The concat demuxer's own quoting, not ours — a path is single-quoted and
    /// a literal quote inside it is `'\''`.
    #[test]
    fn a_concat_list_line_quotes_the_path() {
        assert_eq!(
            concat_list_line(Path::new("/tmp/a b/seg.mp4")),
            "file '/tmp/a b/seg.mp4'\n"
        );
        assert_eq!(
            concat_list_line(Path::new("/tmp/it's/seg.mp4")),
            "file '/tmp/it'\\''s/seg.mp4'\n"
        );
    }
}

/// **The render path end to end: real media, real `ffmpeg`, real decoded
/// frames** — skipped (not failed) when `ffmpeg`/`ffprobe` are not on PATH, so a
/// missing binary cannot break an otherwise-green run.
///
/// The documents and the compiled argvs come from
/// `app/src-tauri/tests/fixtures/export-parity.json`, which
/// `packages/editor/src/exportParityFixture.test.ts` writes and — on every one
/// of its own runs — re-asserts against the live TypeScript compiler, so the
/// fixture cannot drift without that test failing first. (Until D-448 this
/// module also compared the output pixel by pixel with the deleted ffmpeg
/// filter-graph export; `docs/notes/export-gpu-compositor.md` §5 and §14.)
/// B-380 — the export benchmark (decode / composite / encode / mux / loudness,
/// both encoders). A child of this module so it can drive
/// [`render_segmented`] at a chosen segment count, as the D-360 sweep does.
#[cfg(test)]
#[path = "export_bench.rs"]
mod export_bench;

#[cfg(test)]
mod parity_tests {
    use super::*;
    use apelles_media::decode_pipe::PipeLane;
    use std::process::Command;

    /// How close is close enough — and **why PSNR is reported but not asserted
    /// on**, which is the one genuinely non-obvious thing about this test.
    ///
    /// Two different engines rendering the same geometry are never bit-identical:
    /// ffmpeg's `swscale` and `image`'s `Triangle` weight their taps
    /// differently, `overlay` truncates a fractional x where `composite_layer_
    /// onto` rounds it, and both outputs then survive an independent libx264
    /// pass. On this fixture's FLAT-COLOUR sources that residue is concentrated
    /// entirely in a one-pixel line along a box's border — and a one-pixel line
    /// between two saturated colours is a per-pixel delta of ~170, which drags
    /// PSNR down hard while being, visibly, nothing at all. The real measured
    /// values (`cargo test -p apelles --lib chroma::edit_render::parity --
    /// --nocapture`, 2026-09-18):
    ///
    /// ```text
    /// frame  5  PSNR 33.1 dB · differing 0.312% · SOLID 0.0000%   (keyframed slide, x = 53.33 px)
    /// frame 15  PSNR 41.8 dB · differing 0.000% · SOLID 0.0000%   (same slide, x = 160 px exactly)
    /// frame 25  PSNR 33.1 dB · differing 0.312% · SOLID 0.0000%   (same slide, x = 266.67 px)
    /// frame 35  PSNR 43.3 dB · differing 0.023% · SOLID 0.0000%   (rounded corners — the arc's AA)
    /// frame 50  PSNR 43.1 dB · differing 0.000% · SOLID 0.0000%   (crop-then-scale)
    /// ```
    ///
    /// Frames 15 and 50 are **pixel-for-pixel identical** — a box on an integer
    /// boundary and a cropped-then-scaled box come out of the two engines the
    /// same. Every frame that differs at all differs only where x lands on a
    /// fraction of a pixel, and the difference's bounding box is exactly the
    /// box's own outline. So the two metrics this actually asserts on are:
    ///
    /// - **`solid_share`** — the difference mask after a 3x3 EROSION. A
    ///   boundary that landed a pixel over is a one-pixel-thin line and erodes
    ///   to nothing; a box in the wrong place, at the wrong size, in the wrong
    ///   colour, or missing entirely is a filled region and survives. It
    ///   measures 0.0000% on every frame above, so the limit is set just above
    ///   zero rather than at a tolerated level.
    /// - **`gross_share`** — the whole difference, eroded or not, as a backstop
    ///   against a boundary that is many pixels thick rather than one. 2% is
    ///   ~6x the observed worst (0.312%), i.e. room for a couple of pixels of
    ///   rounding on every edge but nowhere near a displaced box.
    const GROSS_DIFF_CHANNEL: i32 = 24;
    const MAX_GROSS_DIFF_SHARE: f64 = 0.02;
    const MAX_SOLID_DIFF_SHARE: f64 = 0.0005;

    fn have(bin: &Path) -> bool {
        Command::new(bin)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    pub(super) fn ffmpeg_available() -> bool {
        ffmpeg_locate::ffmpeg_path().is_ok_and(have)
            && ffmpeg_locate::ffprobe_path().is_ok_and(have)
    }

    /// **D-351's own number: how fast does this path actually render?**
    ///
    /// Renders the stress fixture straight on the compositor — no encoder, so
    /// what it times is decode + composite and nothing else — and reports
    /// frames per second. `#[ignore]`d for the same reason
    /// [`measure_resource_use_against_the_filter_graph_path`] is: it samples a
    /// live machine, so it is a MEASUREMENT to read, not a threshold to fail a
    /// build on (a different core count is a different, equally correct
    /// number — which is the whole point of scaling with the cores available).
    ///
    /// ```text
    /// cargo test -p apelles --lib chroma::edit_render::parity_tests::measure_render_throughput -- --ignored --nocapture
    /// ```
    ///
    /// **Run it against `RAYON_NUM_THREADS=1` to see D-351's own A/B**, on one
    /// binary at one moment, which is the only comparison this machine's load
    /// cannot distort:
    ///
    /// ```text
    /// RAYON_NUM_THREADS=1 cargo test ... # the pre-D-351 compositor
    /// ```
    ///
    /// The recorded runs are in `docs/notes/export-gpu-compositor.md` §9.
    #[test]
    #[ignore = "a live throughput measurement, not a pass/fail assertion — see the doc comment"]
    fn measure_render_throughput() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_stress_media(&fx, dir).expect("generate stress media");
        let st = &fx.stress;
        let (w, h) = (st.width, st.height);
        let timeline = localise_timeline(&st.timeline, dir);
        let settings = ProjectSettings {
            width: Some(w),
            height: Some(h),
            fps: Some(fx.fps),
            color_space: None,
        };
        // Warm the probe/grade caches so frame 0 is not charged for them.
        let _ = edit::render_timeline_frame(
            &timeline,
            &settings,
            0,
            Some(w),
            FrameIntent::Single,
            PipeLane::LIVE,
        );

        let started = Instant::now();
        for pos in 0..st.pipe_frames {
            edit::render_timeline_frame(
                &timeline,
                &settings,
                pos,
                Some(w),
                FrameIntent::Single,
                PipeLane::LIVE,
            )
            .unwrap_or_else(|e| panic!("render frame {pos}: {e}"));
        }
        let total = started.elapsed().as_secs_f64();
        eprintln!(
            "\n=== D-351 render throughput: {} clips, {w}x{h}, {} frames ===\n\
             {total:.2} s  ·  {:.1} fps  ·  {:.1} ms/frame  \
             (rayon threads: {})\n",
            st.clips,
            st.pipe_frames,
            st.pipe_frames as f64 / total,
            total * 1000.0 / st.pipe_frames as f64,
            rayon::current_num_threads(),
        );
    }

    /// **D-360's own number: the WHOLE export, at one segment and at several.**
    ///
    /// Differs from [`measure_render_throughput`] deliberately, and the
    /// difference is the point. That one times the compositor alone, which is
    /// what D-351 was changing. This one times
    /// [`render_timeline`]/[`render_segmented`] end to end — decode, composite,
    /// encode and, for the segmented runs, the concatenation — because that is
    /// the number the owner's "under 1x the video's runtime" goal is about, and
    /// a speedup that appeared only with the encoder taken out would not be one.
    ///
    /// The sweep is over the segment count rather than a single reading at
    /// [`plan_segment_count`]'s own answer, because the shape of the curve is
    /// the finding — where it stops paying says whether the bound in
    /// [`MAX_SEGMENTS`] is in the right place.
    ///
    /// ```text
    /// cargo test -p apelles --lib chroma::edit_render::parity_tests::measure_segmented -- --ignored --nocapture
    /// ```
    ///
    /// `#[ignore]`d for the same reason every measurement here is: it samples a
    /// live machine, so a different core count is a different and equally
    /// correct number. The recorded runs are in
    /// `docs/notes/export-gpu-compositor.md` §10.
    #[test]
    #[ignore = "a live throughput measurement, not a pass/fail assertion — see the doc comment"]
    fn measure_segmented_render_throughput() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_stress_media(&fx, dir).expect("generate stress media");
        let st = &fx.stress;
        let timeline = localise_timeline(&st.timeline, dir);
        let settings = ProjectSettings {
            width: Some(st.width),
            height: Some(st.height),
            fps: Some(fx.fps),
            color_space: None,
        };
        let out = (st.width, st.height);
        let comp = edit::composition_size(&settings, &timeline).expect("composition size");
        let canvas = canvas_plan(comp, out);
        let runtime = st.pipe_frames as f64 / fx.fps;

        /// How many times each configuration is timed.
        ///
        /// **Not statistical ceremony — a single reading here was measured to be
        /// worthless.** Two back-to-back sweeps of this same fixture disagreed
        /// by 2x on the one-segment baseline (24.24 s, then 12.38 s) because
        /// other builds on the machine come and go on a timescale *shorter than
        /// one sweep*. A reading taken while a sibling `rustc` happens to be
        /// running is not a fact about this code.
        const REPEATS: usize = 3;

        /// The configurations, swept INSIDE each repeat rather than each one
        /// repeated in turn: drift over a minute then lands on every
        /// configuration roughly equally instead of concentrating in whichever
        /// one happened to be running when load arrived.
        ///
        /// **Deliberately runs PAST [`MAX_SEGMENTS`]**, by calling
        /// [`render_segmented`] directly rather than through
        /// [`plan_segment_count`]. The 8 here is the evidence for that cap
        /// being 6 — a sweep that stopped at the cap could never show that
        /// going beyond it costs processes and returns nothing.
        const PLAN: [usize; 5] = [1, 2, 4, 6, 8];

        eprintln!(
            "\n=== D-360 segmented export: {} clips, {}x{}, {} frames ({runtime:.2} s of video) ===\n\
             best of {REPEATS}, all configurations swept within each repeat",
            st.clips, st.width, st.height, st.pipe_frames,
        );

        // Best (minimum) wall time seen for each configuration. The MINIMUM,
        // not the mean: every source of error on a shared machine is additive
        // and one-directional — another process can only ever make this render
        // slower, never faster — so the fastest observed run is the closest
        // this harness gets to the cost of the code itself, and averaging in a
        // contended run just launders someone else's build into our number.
        let mut best = [f64::INFINITY; PLAN.len()];
        for repeat in 1..=REPEATS {
            for (slot, segments) in PLAN.iter().copied().enumerate() {
                let wall =
                    time_one_render(&timeline, &settings, st, dir, out, canvas, segments, fx.fps);
                best[slot] = best[slot].min(wall);
                eprint!("  repeat {repeat}: {segments} seg {wall:>6.2}s\r");
            }
        }

        eprintln!(
            "\n{:>4}  {:>9}  {:>8}  {:>8}  {:>7}",
            "segs", "best", "fps", "xruntime", "speedup",
        );
        let baseline = best[0];
        for (slot, segments) in PLAN.iter().copied().enumerate() {
            let wall = best[slot];
            eprintln!(
                "{segments:>4}  {wall:>8.2}s  {:>8.1}  {:>8.2}  {:>6.2}x",
                st.pipe_frames as f64 / wall,
                wall / runtime,
                baseline / wall,
            );
        }
        eprintln!(
            "\n(\"under 1x\" means the xruntime column is below 1.00 — this fixture is \
             {runtime:.2} s of video. {} logical cores.)\n",
            std::thread::available_parallelism()
                .map(std::num::NonZeroUsize::get)
                .unwrap_or(0),
        );
    }

    /// **D-373 — why [`measure_segmented_render_throughput`]'s before/after is
    /// unchanged, stated exactly rather than inferred from two noisy timings.**
    ///
    /// The stress fixture's own cost curve is **constant**: every one of its 240
    /// frames carries the same two layers (one full-length base clip plus one of
    /// 20 back-to-back cuts above it), and none of the perturbations the fixture
    /// does carry — four clips with a 10 % left crop — crosses a cost boundary.
    /// A flat curve means the work-balanced partition IS the equal-frame
    /// partition, so the sweep measures the same two renders before and after
    /// D-373 and any difference between the two tables is this machine, not this
    /// code.
    ///
    /// Asserting that here is worth more than a timing: it turns "the sweep
    /// looks the same" into "the sweep is rendering identical ranges", and it
    /// will start failing the day the fixture grows a clip that makes the curve
    /// genuinely uneven — at which point the sweep becomes able to measure
    /// D-373 and this test is the signal to go and read it.
    ///
    /// Needs no media and no ffmpeg: the cost model never opens a file.
    #[test]
    fn the_stress_fixtures_cost_curve_is_flat_so_d373_cannot_move_its_split() {
        let fx = load_fixture();
        let st = &fx.stress;
        let timeline = st.timeline.clone();

        let curve = super::super::render_cost::frame_cost_curve(&timeline, st.pipe_frames);
        assert_eq!(curve.len() as u64, st.pipe_frames);
        let first = curve[0];
        assert!(
            curve.iter().all(|&c| c == first),
            "the stress fixture is supposed to be uniform; it is not, so the \
             D-360 sweep CAN now measure D-373 — go and read it. curve: {curve:?}"
        );

        // And therefore the partition is the equal-frame one, at every segment
        // count the sweep uses.
        for segments in [2usize, 4, 6, 8] {
            let ranges = plan_segment_ranges(&timeline, st.pipe_frames, segments);
            let lens: Vec<u64> = ranges.iter().map(|r| r.end - r.start).collect();
            assert_eq!(lens.iter().sum::<u64>(), st.pipe_frames);
            let (lo, hi) = (
                lens.iter().copied().min().unwrap_or(0),
                lens.iter().copied().max().unwrap_or(0),
            );
            assert!(
                hi - lo <= 1,
                "{segments} segments on a flat curve must still be an even \
                 split: {lens:?}"
            );
        }
    }

    /// **D-373 — does cutting on the WORK curve instead of the frame count
    /// actually finish sooner?**
    ///
    /// [`measure_segmented_render_throughput`] cannot answer that, and the
    /// reason is a property of its fixture rather than of the change: the
    /// 20-clip / 1080p / 240-frame stress case is **uniform**. Every frame
    /// carries the same two layers — one full-length base clip plus one of 20
    /// back-to-back cuts above it — so its cost curve is flat, the
    /// work-balanced split *is* the equal-frame split frame for frame, and the
    /// before/after sweep is expected to be unchanged (it is; see
    /// `docs/notes/export-gpu-compositor.md` §10.7).
    ///
    /// So this one makes the fixture lopsided, out of the fixture's **own**
    /// generated media and nothing else: every clip covering the FIRST half of
    /// the render gets a real `rotation`, which sends its layer down
    /// `composite_layer_onto`'s dearest branch (`rgba8 → rgba32f → bilinear
    /// rotate → rgba8`, three full-buffer passes, one of them at four times the
    /// bytes) while the second half stays on D-217's fused path. Then it renders
    /// that timeline twice at the same lane count — once on an **equal-frame**
    /// partition (D-360's arithmetic, reproduced here so the comparison is
    /// against the real thing) and once on [`plan_segment_ranges`]' cost-based
    /// one.
    ///
    /// **Why rotation, and not "fewer layers in the second half" — which is the
    /// obvious skew and was this harness's first attempt.** Truncating a track
    /// so the second half has fewer layers changes how many DECODE PROCESSES a
    /// lane needs, and changes it *differently for the two partitions*: the
    /// cost-based cut reaches back into the stacked region, so its cheap lane
    /// spawns extra decoders its equal-frame counterpart never had. That version
    /// measured the cost-based partition **consistently 5-6 % slower in every
    /// repeat** (9.75 s vs 10.30 s best-of-5) — D-369's contention term, not
    /// noise. It is a true and useful finding about this model (it costs WORK,
    /// not PROCESSES — see `chroma::render_cost`'s own "what it does not do")
    /// but it says nothing about whether balancing work helps, because the two
    /// partitions were not running the same number of processes. Rotation skews
    /// the per-frame compositing cost while leaving track occupancy identical
    /// everywhere, so every lane spawns the same processes wherever the boundary
    /// falls and the comparison isolates the one variable.
    ///
    /// **Read the spread, not just the two numbers.** 240 frames is ~10 s of
    /// render, and this machine's run-to-run spread on the identical
    /// configuration has been measured at ±25 % (see
    /// [`measure_segmented_render_throughput`]'s own note). The per-lane
    /// ESTIMATED work this also prints is deterministic, and at this fixture's
    /// size it is the half to trust.
    ///
    /// ```text
    /// cargo test -p apelles --lib chroma::edit_render::parity_tests::measure_segmented_render_balance -- --ignored --nocapture
    /// ```
    ///
    /// `#[ignore]`d, best-of-`REPEATS`, and alternating the two partitions
    /// inside each repeat, for exactly the reasons
    /// [`measure_segmented_render_throughput`] gives: a single reading on a
    /// shared machine is not a fact about this code.
    #[test]
    #[ignore = "a live throughput measurement, not a pass/fail assertion — see the doc comment"]
    fn measure_segmented_render_balance() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_stress_media(&fx, dir).expect("generate stress media");
        let st = &fx.stress;

        // The skew, in two steps. Neither changes which tracks have content
        // where, so both partitions spawn the same processes — see the doc
        // comment for why that is the whole design of this harness.
        let mut timeline = localise_timeline(&st.timeline, dir);
        let half = st.pipe_frames as i64 / 2;

        // 1 — the base track's one full-length clip becomes two clips meeting
        //     at the half, so the rotation in step 2 can apply to one of them.
        //     Same track, so still one `PipeSlot` and one decode `ffmpeg`, and
        //     still covering every frame of the render.
        let base = timeline
            .tracks
            .iter_mut()
            .rfind(|t| t.kind == TrackKind::Video)
            .expect("the stress fixture's base video track");
        assert_eq!(
            base.clips.len(),
            1,
            "the base track is one full-length clip"
        );
        let mut tail = base.clips[0].clone();
        base.clips[0].duration = half;
        tail.id = format!("{}-tail", tail.id);
        tail.start_frame = half;
        tail.source_start += half;
        tail.duration = st.pipe_frames as i64 - half;
        base.clips.push(tail);

        // 2 — every clip starting in the first half gets a real rotation.
        //     17 degrees: enough to be a genuine rotation rather than a no-op,
        //     and an odd angle so no axis-aligned shortcut could ever apply.
        const SKEW_ROTATION_DEG: f64 = 17.0;
        for track in &mut timeline.tracks {
            for clip in &mut track.clips {
                if clip.start_frame < half {
                    clip.rotation = SKEW_ROTATION_DEG;
                }
            }
        }

        let settings = ProjectSettings {
            width: Some(st.width),
            height: Some(st.height),
            fps: Some(fx.fps),
            color_space: None,
        };
        let out = (st.width, st.height);
        let comp = edit::composition_size(&settings, &timeline).expect("composition size");
        let canvas = canvas_plan(comp, out);

        /// Two lanes, because the skew is a half: it is the smallest split that
        /// has an expensive lane and a cheap one, and the one whose imbalance is
        /// easiest to read off the numbers.
        const SEGMENTS: usize = 2;
        const REPEATS: usize = 5;

        // D-360's own equal-frame arithmetic, reproduced rather than referenced
        // because D-373 replaced it — this is the baseline being measured
        // against, so it has to be stated.
        let equal: Vec<std::ops::Range<u64>> = {
            let base = st.pipe_frames / SEGMENTS as u64;
            let extra = st.pipe_frames % SEGMENTS as u64;
            let mut start = 0;
            (0..SEGMENTS as u64)
                .map(|i| {
                    let len = base + u64::from(i < extra);
                    let r = start..start + len;
                    start += len;
                    r
                })
                .collect()
        };
        let balanced = plan_segment_ranges(&timeline, st.pipe_frames, SEGMENTS);

        // The deterministic half of this measurement, and the half worth
        // trusting at this fixture's size: what the model says each lane is
        // carrying under each partition. No timer, no machine, no noise.
        let curve = super::super::render_cost::frame_cost_curve(&timeline, st.pipe_frames);
        let lane_work = |ranges: &[std::ops::Range<u64>]| -> Vec<u64> {
            ranges
                .iter()
                .map(|r| {
                    curve[r.start as usize..r.end as usize]
                        .iter()
                        .map(|&c| u64::from(c))
                        .sum()
                })
                .collect()
        };
        let imbalance = |w: &[u64]| {
            w.iter().copied().max().unwrap_or(0) as f64
                / w.iter().copied().min().unwrap_or(1) as f64
        };

        eprintln!(
            "\n=== D-373 work-balanced segments: {}x{}, {} frames, every layer \
             rotated for the first {half} and none after ===\n\
             estimated work per lane (deterministic, chroma::render_cost):\n\
             \x20 equal-frame {equal:?} {:?} imbalance {:.2}x\n\
             \x20 cost-based  {balanced:?} {:?} imbalance {:.2}x\n\
             wall clock, best of {REPEATS}, both partitions rendered within each repeat:",
            st.width,
            st.height,
            st.pipe_frames,
            lane_work(&equal),
            imbalance(&lane_work(&equal)),
            lane_work(&balanced),
            imbalance(&lane_work(&balanced)),
        );

        let mut best = [f64::INFINITY; 2];
        let mut worst = [0.0f64; 2];
        for repeat in 1..=REPEATS {
            for (slot, ranges) in [&equal, &balanced].into_iter().enumerate() {
                let target = dir.join(format!("balance-{slot}.mp4"));
                let started = Instant::now();
                let outcome = render_at_ranges(
                    &timeline,
                    &settings,
                    &request(
                        localise(&st.mux_args, dir, &target),
                        (st.width, st.height),
                        st.pipe_frames,
                        fx.fps,
                    ),
                    ranges,
                    out,
                    canvas,
                )
                .unwrap_or_else(|e| panic!("render on {ranges:?}: {e}"));
                assert_eq!(outcome.frames, st.pipe_frames);
                let wall = started.elapsed().as_secs_f64();
                best[slot] = best[slot].min(wall);
                worst[slot] = worst[slot].max(wall);
                eprint!("  repeat {repeat}: partition {slot} {wall:>6.2}s\r");
            }
        }

        // **The harness says when it could not measure.** The two minima are
        // only comparable if each configuration's own spread is smaller than
        // the gap between them; otherwise the "faster" row is just the one that
        // happened to catch the quietest moment on a shared machine, and
        // quoting its ratio would be exactly the error D-360's own harness note
        // was written about.
        let gap = (best[0] - best[1]).abs();
        let spread = (worst[0] - best[0]).max(worst[1] - best[1]);
        eprintln!(
            "\n  equal-frame  min {:>6.2}s  max {:>6.2}s\n\
             \x20 cost-based   min {:>6.2}s  max {:>6.2}s\n\
             \x20 {}\n",
            best[0],
            worst[0],
            best[1],
            worst[1],
            if spread > gap {
                format!(
                    "INCONCLUSIVE: the {spread:.2}s run-to-run spread on this machine \
                     is larger than the {gap:.2}s gap between the two partitions. \
                     Trust the per-lane estimate above, not these timings; the real \
                     c038 project is the fixture that can answer this."
                )
            } else {
                format!("-> {:.2}x for the cost-based partition", best[0] / best[1])
            },
        );
    }

    /// One timed render of the stress fixture at `segments`, for
    /// [`measure_segmented_render_throughput`]. Returns wall seconds.
    #[allow(clippy::too_many_arguments)]
    fn time_one_render(
        timeline: &Timeline,
        settings: &ProjectSettings,
        st: &StressCase,
        dir: &Path,
        out: (u32, u32),
        canvas: (Option<u32>, bool),
        segments: usize,
        fps: f64,
    ) -> f64 {
        let target = dir.join(format!("stress-{segments}.mp4"));
        let started = Instant::now();
        let req = request(
            localise(&st.mux_args, dir, &target),
            (st.width, st.height),
            st.pipe_frames,
            fps,
        );
        let outcome = render_at_segments(timeline, settings, &req, segments, out, canvas)
            .unwrap_or_else(|e| panic!("render at {segments} segments: {e}"));
        assert_eq!(
            outcome.frames, st.pipe_frames,
            "a timing run that did not render every frame is not a timing of this render"
        );
        started.elapsed().as_secs_f64()
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StressCase {
        clips: usize,
        width: u32,
        height: u32,
        colors: std::collections::HashMap<String, [u8; 3]>,
        source_frames: u32,
        timeline: Timeline,
        mux_args: Vec<String>,
        pipe_frames: u64,
    }

    struct ParityFixture {
        comp_width: u32,
        comp_height: u32,
        fps: f64,
        source_frames: u32,
        colors: std::collections::HashMap<String, [u8; 3]>,
        /// B-208/D-353 — each named source's OWN pixel size. The fixture's
        /// media is no longer uniformly the composition's size: `c-scaled`'s
        /// source is deliberately half of it on each axis, which is the only
        /// geometry in which `scale`'s two readings differ.
        sizes: std::collections::HashMap<String, [u32; 2]>,
        sample_frames: Vec<u64>,
        timeline: Timeline,
        mux_args: Vec<String>,
        pipe_frames: u64,
        stress: StressCase,
    }

    fn load_fixture() -> ParityFixture {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/export-parity.json");
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "{}: {e} — regenerate it with WRITE_EXPORT_PARITY_FIXTURE=1 npx vitest run \
                 packages/editor/src/exportParityFixture.test.ts",
                path.display()
            )
        });
        // The fixture is written by a TypeScript compiler, so its keys are
        // camelCase; the Rust `Timeline` inside it is snake_case serde, which is
        // exactly how it is persisted in a real `.chroma` file.
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            comp_width: u32,
            comp_height: u32,
            fps: f64,
            source_frames: u32,
            colors: std::collections::HashMap<String, [u8; 3]>,
            sizes: std::collections::HashMap<String, [u32; 2]>,
            sample_frames: Vec<u64>,
            timeline: Timeline,
            mux_args: Vec<String>,
            pipe_frames: u64,
            stress: StressCase,
        }
        let w: Wire = serde_json::from_str(&raw).expect("parity fixture is not valid JSON");
        ParityFixture {
            comp_width: w.comp_width,
            comp_height: w.comp_height,
            fps: w.fps,
            source_frames: w.source_frames,
            colors: w.colors,
            sizes: w.sizes,
            sample_frames: w.sample_frames,
            timeline: w.timeline,
            mux_args: w.mux_args,
            pipe_frames: w.pipe_frames,
            stress: w.stress,
        }
    }

    /// Generate the fixture's media: one flat-colour h.264 file per named
    /// source, at the composition's own size and rate. Real files, because both
    /// paths decode them for real.
    fn generate_one(
        dir: &Path,
        name: &str,
        rgb: [u8; 3],
        size: (u32, u32),
        frames: u32,
        fps: f64,
    ) -> Result<(), String> {
        let secs = frames as f64 / fps;
        let status = ffmpeg_locate::ffmpeg()
            .map_err(|e| e.to_string())?
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!(
                "color=c=0x{:02x}{:02x}{:02x}:size={}x{}:rate={fps}:duration={secs}",
                rgb[0], rgb[1], rgb[2], size.0, size.1
            ))
            .args(["-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p"])
            .arg(dir.join(name))
            .status()
            .map_err(|e| format!("spawn ffmpeg for {name}: {e}"))?;
        if !status.success() {
            return Err(format!("generating {name} failed: {status}"));
        }
        Ok(())
    }

    /// The parity fixture's media, each at **its own** size (B-208/D-353) —
    /// which for every source but `c-scaled`'s is still the composition's. A
    /// name the fixture lists no size for falls back to the composition, which
    /// is what every source was before D-353.
    fn generate_media(fx: &ParityFixture, dir: &Path) -> Result<(), String> {
        for (name, rgb) in &fx.colors {
            let size = fx
                .sizes
                .get(name)
                .map(|s| (s[0], s[1]))
                .unwrap_or((fx.comp_width, fx.comp_height));
            generate_one(dir, name, *rgb, size, fx.source_frames, fx.fps)?;
        }
        Ok(())
    }

    /// The stress case's own media, at ITS composition size — see the fixture's
    /// `STRESS_MEDIA` note for why it does not share the parity fixture's.
    fn generate_stress_media(fx: &ParityFixture, dir: &Path) -> Result<(), String> {
        let st = &fx.stress;
        for (name, rgb) in &st.colors {
            generate_one(
                dir,
                name,
                *rgb,
                (st.width, st.height),
                st.source_frames,
                fx.fps,
            )?;
        }
        Ok(())
    }

    /// Rewrite the fixture's placeholder paths (`OUT`, and each bare media
    /// name) to this run's own temp paths.
    fn localise(args: &[String], dir: &Path, out: &Path) -> Vec<String> {
        args.iter()
            .map(|a| {
                if a == "OUT" {
                    out.to_string_lossy().to_string()
                } else if a.ends_with(".mp4") && !a.contains('/') {
                    dir.join(a).to_string_lossy().to_string()
                } else {
                    a.clone()
                }
            })
            .collect()
    }

    pub(super) fn localise_timeline(timeline: &Timeline, dir: &Path) -> Timeline {
        let mut tl = timeline.clone();
        for track in &mut tl.tracks {
            for clip in &mut track.clips {
                if !clip.source_path.is_empty() {
                    clip.source_path = dir.join(&clip.source_path).to_string_lossy().to_string();
                }
            }
        }
        tl
    }

    pub(super) fn run_ffmpeg(args: &[String]) -> Result<(), String> {
        let out = ffmpeg_locate::ffmpeg()
            .map_err(|e| e.to_string())?
            .args(args)
            .output()
            .map_err(|e| format!("spawn ffmpeg: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "ffmpeg exited {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }

    /// Decode frame `n` of `video` as RGB8. `select=eq(n,N)` counts DECODED
    /// frames from zero, which is the same index the compositor's own `pos` is.
    fn frame_of(video: &Path, n: u64, into: &Path) -> Result<image::RgbImage, String> {
        run_ffmpeg(&[
            "-v".into(),
            "error".into(),
            "-y".into(),
            "-i".into(),
            video.to_string_lossy().to_string(),
            "-vf".into(),
            format!("select=eq(n\\,{n})"),
            "-fps_mode".into(),
            "passthrough".into(),
            "-frames:v".into(),
            "1".into(),
            into.to_string_lossy().to_string(),
        ])?;
        Ok(image::open(into)
            .map_err(|e| format!("open {}: {e}", into.display()))?
            .to_rgb8())
    }

    struct Diff {
        psnr_db: f64,
        gross_share: f64,
        /// The share of grossly-different pixels whose whole 3x3 neighbourhood
        /// is ALSO grossly different — a morphological erosion of the
        /// difference mask. See [`compare`] for why this, not PSNR, is the
        /// metric that actually distinguishes "a boundary landed a pixel over"
        /// from "the two engines drew a different picture".
        solid_share: f64,
        /// The bounding box of every differing pixel, for a failure message
        /// that says WHERE the two engines disagreed.
        bbox: Option<(u32, u32, u32, u32)>,
    }

    /// Compare two decoded frames three ways — see [`Diff`] and the threshold
    /// constants for what each one is for.
    fn compare(a: &image::RgbImage, b: &image::RgbImage) -> Diff {
        assert_eq!(a.dimensions(), b.dimensions(), "frames differ in SIZE");
        let (w, h) = a.dimensions();
        let mut sq = 0f64;
        let mut mask = vec![false; (w * h) as usize];
        let mut bbox: Option<(u32, u32, u32, u32)> = None;
        for y in 0..h {
            for x in 0..w {
                let (pa, pb) = (a.get_pixel(x, y), b.get_pixel(x, y));
                let mut worst = 0i32;
                for c in 0..3 {
                    let d = pa[c] as i32 - pb[c] as i32;
                    sq += (d * d) as f64;
                    worst = worst.max(d.abs());
                }
                if worst > GROSS_DIFF_CHANNEL {
                    mask[(y * w + x) as usize] = true;
                    bbox = Some(match bbox {
                        None => (x, y, x, y),
                        Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                    });
                }
            }
        }
        let gross = mask.iter().filter(|m| **m).count() as u64;
        // Erode: keep only pixels whose entire 3x3 neighbourhood also differs.
        // A boundary that landed one pixel over is a one-pixel-thin line and
        // survives no erosion at all; a box in the wrong place, at the wrong
        // size, or in the wrong colour is a filled region and survives almost
        // entirely.
        let at = |x: i64, y: i64| -> bool {
            if x < 0 || y < 0 || x >= w as i64 || y >= h as i64 {
                return false;
            }
            mask[(y as u32 * w + x as u32) as usize]
        };
        let mut solid = 0u64;
        for y in 0..h as i64 {
            for x in 0..w as i64 {
                if !at(x, y) {
                    continue;
                }
                if (-1..=1).all(|dy| (-1..=1).all(|dx| at(x + dx, y + dy))) {
                    solid += 1;
                }
            }
        }
        let px = (w as f64) * (h as f64);
        let mse = sq / (px * 3.0);
        Diff {
            psnr_db: if mse <= 0.0 {
                f64::INFINITY
            } else {
                10.0 * (255.0f64 * 255.0 / mse).log10()
            },
            gross_share: gross as f64 / px,
            solid_share: solid as f64 / px,
            bbox,
        }
    }

    fn settings_for(fx: &ParityFixture) -> ProjectSettings {
        ProjectSettings {
            width: Some(fx.comp_width),
            height: Some(fx.comp_height),
            fps: Some(fx.fps),
            color_space: None,
        }
    }

    /// CLAUDE.md's determinism rule, applied to this path: the same document at
    /// the same frame must produce the same bytes, twice. Straight on the
    /// compositor (no encoder), so a codec's own non-determinism cannot mask a
    /// renderer's.
    #[test]
    fn rendering_the_same_frame_twice_produces_identical_bytes() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_media(&fx, dir).expect("generate fixture media");
        let timeline = localise_timeline(&fx.timeline, dir);
        let settings = settings_for(&fx);

        for n in &fx.sample_frames {
            let once = edit::render_timeline_frame(
                &timeline,
                &settings,
                *n,
                None,
                FrameIntent::Single,
                PipeLane::LIVE,
            )
            .expect("render once")
            .expect("a visible frame");
            let twice = edit::render_timeline_frame(
                &timeline,
                &settings,
                *n,
                None,
                FrameIntent::Single,
                PipeLane::LIVE,
            )
            .expect("render twice")
            .expect("a visible frame");
            assert_eq!(
                once.to_rgba8().into_raw(),
                twice.to_rgba8().into_raw(),
                "frame {n} rendered two different pictures from one document"
            );
        }
    }

    /// **D-351/D-452 — every frame reaches the file, once, in timeline order.**
    ///
    /// The hand-off is a bounded channel and a writer thread, and since D-452
    /// the writer hands each frame to the in-process encoder as a pixel buffer
    /// the GPU wrote — a dropped, duplicated or swapped frame would not raise an
    /// error anywhere, it would silently ship a shuffled video. So the order is
    /// asserted on the finished file: every frame of it, decoded, against what
    /// the compositor draws for that position. The encoder is lossy, so the
    /// check is "closest to its own position": each decoded frame must match the
    /// preview of its own position (PSNR at least [`ORDER_MIN_PSNR_DB`]) and be
    /// closer to it than to the preview of either neighbour wherever the two
    /// neighbours really differ — the fixture's pip slides every frame.
    #[test]
    fn the_encoded_file_carries_every_frame_in_timeline_order() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_media(&fx, dir).expect("generate fixture media");
        let timeline = localise_timeline(&fx.timeline, dir);
        let settings = settings_for(&fx);
        let (w, h) = (fx.comp_width, fx.comp_height);
        let file = dir.join("ordered.mp4");
        let req = request(
            localise(&fx.mux_args, dir, &file),
            (w, h),
            fx.pipe_frames,
            fx.fps,
        );
        let outcome = render_timeline(&timeline, &settings, &req).expect("the render path");
        assert_eq!(outcome.frames, fx.pipe_frames);

        // Every frame of the file, decoded once (the stream is Rec.709-tagged,
        // which ffmpeg's conversion honours).
        let decoded = Command::new(ffmpeg_locate::ffmpeg_path().expect("ffmpeg"))
            .args(["-v", "error", "-i"])
            .arg(&file)
            .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            .output()
            .expect("decode the export");
        let frame_len = (w * h * 3) as usize;
        assert_eq!(
            decoded.stdout.len(),
            frame_len * fx.pipe_frames as usize,
            "the file is not exactly {} frames",
            fx.pipe_frames
        );
        let preview = |pos: u64| -> image::RgbImage {
            edit::render_timeline_frame(
                &timeline,
                &settings,
                pos,
                None,
                FrameIntent::Single,
                PipeLane::LIVE,
            )
            .expect("render for comparison")
            .expect("a visible frame")
            .to_rgb8()
        };
        let previews: Vec<image::RgbImage> = (0..fx.pipe_frames).map(preview).collect();
        for pos in 0..fx.pipe_frames as usize {
            let got = image::RgbImage::from_raw(
                w,
                h,
                decoded.stdout[pos * frame_len..(pos + 1) * frame_len].to_vec(),
            )
            .expect("a frame");
            let own = compare(&got, &previews[pos]).psnr_db;
            assert!(
                own >= ORDER_MIN_PSNR_DB,
                "frame {pos} of the file is {own:.1} dB from the compositor's frame {pos}"
            );
            for n in [pos.wrapping_sub(1), pos + 1] {
                let Some(neighbour) = previews.get(n) else {
                    continue;
                };
                if compare(neighbour, &previews[pos]).psnr_db > 45.0 {
                    continue; // the two positions look alike: nothing to tell apart
                }
                let other = compare(&got, neighbour).psnr_db;
                assert!(
                    own > other,
                    "frame {pos} of the file looks more like position {n} ({other:.1} dB) than \
                     its own ({own:.1} dB) — the writer reordered, dropped or duplicated a frame"
                );
            }
        }
    }

    /// The least PSNR a decoded H.264 frame of the fixture keeps against the
    /// compositor's own frame: flat colour and hard edges at VideoToolbox's
    /// quality 0.70 measure well above it, and a frame from the wrong position
    /// (a displaced box) far below.
    const ORDER_MIN_PSNR_DB: f64 = 30.0;

    /// **The other half of B-231: the status really moves WHILE a real render
    /// is running, not just once it has finished.**
    ///
    /// A progress value that is only correct at the end is exactly the thing
    /// B-231 already had. What was missing is a number a caller whose
    /// `editor_export` already timed out can read mid-flight, so that is what
    /// this samples: a render on one thread, `snapshot()` polled from another,
    /// on the stress fixture (enough frames that a sample lands mid-render).
    #[test]
    fn the_status_advances_while_a_real_render_is_in_flight() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_stress_media(&fx, dir).expect("generate stress media");
        let st = &fx.stress;
        let timeline = localise_timeline(&st.timeline, dir);
        let settings = ProjectSettings {
            width: Some(st.width),
            height: Some(st.height),
            fps: Some(fx.fps),
            color_space: None,
        };
        let out = (st.width, st.height);
        let comp = edit::composition_size(&settings, &timeline).expect("composition size");
        let file = dir.join("in-flight.mp4");
        let req = request(
            localise(&st.mux_args, dir, &file),
            out,
            st.pipe_frames,
            fx.fps,
        );

        let ranges = plan_segment_ranges(&timeline, st.pipe_frames, 1);
        let job = export_status::begin(
            st.pipe_frames,
            &ranges,
            Some(file.to_string_lossy().into_owned()),
            export_status::STALL_TIMEOUT,
        )
        .expect("begin");

        let mut samples: Vec<(u64, f64)> = Vec::new();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                render_segmented(
                    &timeline,
                    &settings,
                    &req,
                    &ranges,
                    out,
                    canvas_plan(comp, out),
                    &job,
                    Instant::now(),
                )
            });
            while !worker.is_finished() {
                let s = export_status::snapshot();
                samples.push((s.frames_written, s.percent));
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            worker
                .join()
                .expect("the render thread")
                .expect("the render");
        });
        job.finish(Ok(()));

        // It moved, and it moved in the middle — a sample that is neither
        // "nothing yet" nor "already everything".
        assert!(
            samples.iter().any(|(n, _)| *n > 0 && *n < st.pipe_frames),
            "no sample caught the render in flight: {samples:?}"
        );
        // And it only ever went forwards.
        for pair in samples.windows(2) {
            assert!(
                pair[1].0 >= pair[0].0 && pair[1].1 >= pair[0].1,
                "progress went backwards: {:?} then {:?}",
                pair[0],
                pair[1]
            );
        }
        // And it lands exactly on the whole render.
        let done = export_status::snapshot();
        assert_eq!(done.state, export_status::ExportState::Done);
        assert_eq!(done.frames_written, st.pipe_frames);
        assert_eq!(done.percent, 100.0);
        assert_eq!(done.segments_done, 1);
    }

    /// D-452 — the same document, the same frame, the same bytes, through the
    /// in-process encoder: two exports of the fixture decode to identical
    /// frames (CLAUDE.md's determinism rule is about the picture; D-446 found
    /// VideoToolbox's bitstream decodes identically run to run and its
    /// container bytes may not be).
    #[test]
    fn two_exports_of_one_document_decode_to_the_same_frames() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_media(&fx, dir).expect("generate fixture media");
        let timeline = localise_timeline(&fx.timeline, dir);
        let settings = settings_for(&fx);
        let size = (fx.comp_width, fx.comp_height);
        let decode = |file: &Path| -> Vec<u8> {
            Command::new(ffmpeg_locate::ffmpeg_path().expect("ffmpeg"))
                .args(["-v", "error", "-i"])
                .arg(file)
                .args(["-f", "rawvideo", "-pix_fmt", "yuv420p", "-"])
                .output()
                .expect("decode")
                .stdout
        };
        let mut frames = Vec::new();
        for run in 0..2 {
            let file = dir.join(format!("run-{run}.mp4"));
            let req = request(
                localise(&fx.mux_args, dir, &file),
                size,
                fx.pipe_frames,
                fx.fps,
            );
            render_timeline(&timeline, &settings, &req).expect("export");
            frames.push(decode(&file));
        }
        assert!(!frames[0].is_empty());
        assert!(
            frames[0] == frames[1],
            "one document exported twice decoded to different frames"
        );
    }

    /// An H.264 export request of `frames` frames at `w`x`h`, `fps`, its remux
    /// argv `args` (D-452: the picture is encoded in process; the argv only
    /// joins the segments and adds any sound).
    pub(super) fn request(
        args: Vec<String>,
        (w, h): (u32, u32),
        frames: u64,
        fps: f64,
    ) -> TimelineRenderRequest {
        TimelineRenderRequest {
            args,
            width: w,
            height: h,
            frames,
            fps,
            format: ExportVideoFormat::H264,
            output: None,
            loudness: None,
            timeline_id: None,
            cancel_token: None,
            timeline: None,
        }
    }

    /// A remux argv with no sound, into `out`: the concat list, `-c:v copy`.
    fn video_only_mux(out: &Path) -> Vec<String> {
        [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            CONCAT_LIST_TOKEN,
            "-map",
            "0:v",
            "-c:v",
            "copy",
        ]
        .iter()
        .map(|a| a.to_string())
        .chain(std::iter::once(out.to_string_lossy().into_owned()))
        .collect()
    }

    /// Drive [`render_segmented`] at a segment count the test names, doing
    /// exactly what [`render_timeline`] does around it: derive the partition
    /// once, open the D-362 progress job from those same ranges, and close it
    /// with the outcome. `plan_segment_count` answers 1 for renders this short
    /// (`MIN_SEGMENT_FRAMES` is 90), so these tests cannot get a split by
    /// asking [`render_timeline`] for one — but they must not skip the job
    /// either, or they would be exercising a path production no longer has.
    pub(super) fn render_at_segments(
        timeline: &Timeline,
        settings: &ProjectSettings,
        req: &TimelineRenderRequest,
        segments: usize,
        out: (u32, u32),
        canvas: (Option<u32>, bool),
    ) -> Result<TimelineRenderOutcome, String> {
        let segments = segments.clamp(1, req.frames.max(1) as usize);
        let ranges = plan_segment_ranges(timeline, req.frames, segments);
        render_at_ranges(timeline, settings, req, &ranges, out, canvas)
    }

    /// [`render_at_segments`] with the partition supplied rather than planned —
    /// what [`measure_segmented_render_balance`] needs in order to render the
    /// same timeline twice at the same lane count on two different partitions.
    #[allow(clippy::too_many_arguments)]
    fn render_at_ranges(
        timeline: &Timeline,
        settings: &ProjectSettings,
        req: &TimelineRenderRequest,
        ranges: &[std::ops::Range<u64>],
        out: (u32, u32),
        canvas: (Option<u32>, bool),
    ) -> Result<TimelineRenderOutcome, String> {
        let job = export_status::begin(
            req.frames,
            ranges,
            req.output.clone(),
            export_status::STALL_TIMEOUT,
        )?;
        let engine_before = super::super::gpu_compositor::stats();
        let outcome = render_segmented(
            timeline,
            settings,
            req,
            ranges,
            out,
            canvas,
            &job,
            Instant::now(),
        );
        job.finish(outcome.as_ref().map(|_| ()).map_err(Clone::clone));
        outcome.map(|mut o| {
            o.stages = o.stages.with_engine(&engine_before);
            o
        })
    }

    /// How many video frames `video` actually contains, counted rather than
    /// derived from a duration — the number a dropped or duplicated frame at a
    /// segment boundary changes, and the one the container's own metadata is
    /// least likely to be honest about.
    pub(super) fn frame_count(video: &Path) -> Result<u64, String> {
        let out = ffmpeg_locate::ffprobe()
            .map_err(|e| e.to_string())?
            .args([
                "-v",
                "error",
                "-count_frames",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=nb_read_frames",
                "-of",
                "csv=p=0",
            ])
            .arg(video)
            .output()
            .map_err(|e| format!("spawn ffprobe: {e}"))?;
        String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<u64>()
            .map_err(|e| format!("ffprobe frame count for {}: {e}", video.display()))
    }

    /// **D-360's decisive test: N contiguous segments, concatenated, are the
    /// same video as one stream — checked hardest exactly where a split could
    /// hide.**
    ///
    /// Segment boundaries are the only place this architecture can go wrong,
    /// and it can go wrong silently: the concat demuxer stitches whatever it is
    /// handed, so a segment one frame short produces a perfectly valid file
    /// that is a frame out of sync from that boundary onward, with no error
    /// from anything. So this asserts three separate things, on the real
    /// four-segment output of the real path:
    ///
    /// 1. **The count.** `ffprobe -count_frames` on both files, against each
    ///    other and against the frame count asked for.
    /// 2. **The boundaries.** Every frame either side of every boundary
    ///    (`b-1`, `b`, `b+1`) decoded from both files and compared. This
    ///    fixture's pip **slides one step per frame**, so a one-frame offset is
    ///    a displaced box — a filled region, which is precisely what
    ///    `solid_share` measures and a one-pixel boundary line is not.
    /// 3. **The rest.** The same five sample frames phase 1's old-vs-new test
    ///    uses, so a segmented render is compared against the single-stream one
    ///    away from the boundaries too.
    ///
    /// Four segments over 60 frames puts boundaries at 15, 30 and 45 —
    /// `plan_segment_count` would say 1 for a render this short, so
    /// [`render_segmented`] is driven directly rather than through
    /// [`render_timeline`]'s own planning.
    #[test]
    fn the_segmented_render_is_the_same_video_as_the_single_stream_one() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_media(&fx, dir).expect("generate fixture media");
        let timeline = localise_timeline(&fx.timeline, dir);
        let settings = settings_for(&fx);

        const SEGMENTS: usize = 4;
        let single_out = dir.join("single.mp4");
        let segmented_out = dir.join("segmented.mp4");

        let size = (fx.comp_width, fx.comp_height);
        let single = render_timeline(
            &timeline,
            &settings,
            &request(
                localise(&fx.mux_args, dir, &single_out),
                size,
                fx.pipe_frames,
                fx.fps,
            ),
        )
        .expect("the single-stream render");
        assert_eq!(single.segments, 1, "the single-stream path must not split");

        let req = request(
            localise(&fx.mux_args, dir, &segmented_out),
            size,
            fx.pipe_frames,
            fx.fps,
        );
        let out = size;
        let comp = edit::composition_size(&settings, &timeline).expect("composition size");
        let many = render_at_segments(
            &timeline,
            &settings,
            &req,
            SEGMENTS,
            out,
            canvas_plan(comp, out),
        )
        .expect("the segmented render");
        assert_eq!(many.segments, SEGMENTS);
        assert_eq!(
            many.frames, fx.pipe_frames,
            "the segments must write every frame between them"
        );

        // 1 — the counts, from the files themselves.
        let (n_single, n_many) = (
            frame_count(&single_out).expect("count the single-stream output"),
            frame_count(&segmented_out).expect("count the segmented output"),
        );
        eprintln!("frames: single-stream {n_single} · {SEGMENTS} segments {n_many}");
        assert_eq!(
            n_many, n_single,
            "the segmented output has a different number of frames than the single-stream one \
             — a frame was dropped or duplicated at a boundary"
        );
        assert_eq!(
            n_many, fx.pipe_frames,
            "the segmented output is not the length it was asked for"
        );

        // 2 + 3 — the pixels, hardest at the boundaries.
        let boundaries: Vec<u64> = plan_segment_ranges(&timeline, fx.pipe_frames, SEGMENTS)
            .iter()
            .skip(1)
            .map(|r| r.start)
            .collect();
        // Derived, not hard-coded: the fixture's frame count is owned by the
        // TypeScript compiler and has already changed once (D-353 added a
        // fifth clip), so a literal here would be a test that silently stops
        // testing the boundaries it names.
        assert_eq!(
            boundaries.len(),
            SEGMENTS - 1,
            "four segments have three interior boundaries"
        );
        assert!(
            boundaries.iter().all(|b| *b > 0 && *b < fx.pipe_frames),
            "every boundary must fall strictly inside the render: {boundaries:?}"
        );
        eprintln!(
            "segment boundaries at {boundaries:?} of {} frames",
            fx.pipe_frames
        );
        let mut sample: Vec<u64> = boundaries
            .iter()
            .flat_map(|b| [b.saturating_sub(1), *b, b + 1])
            .chain(fx.sample_frames.iter().copied())
            .filter(|n| *n < fx.pipe_frames)
            .collect();
        sample.sort_unstable();
        sample.dedup();

        for (i, n) in sample.iter().enumerate() {
            let a = frame_of(&single_out, *n, &dir.join(format!("one{i}.png"))).expect("one");
            let b = frame_of(&segmented_out, *n, &dir.join(format!("many{i}.png"))).expect("many");
            let d = compare(&a, &b);
            let at_boundary = boundaries.contains(n);
            eprintln!(
                "frame {n:>3}{} PSNR {:.1} dB · differing {:.3}% · SOLID {:.4}%",
                if at_boundary {
                    " (boundary)"
                } else {
                    "           "
                },
                d.psnr_db,
                d.gross_share * 100.0,
                d.solid_share * 100.0,
            );
            assert!(
                d.solid_share <= MAX_SOLID_DIFF_SHARE,
                "frame {n}: {:.4}% of pixels differ SOLIDLY between the single-stream and the \
                 {SEGMENTS}-segment render (limit {:.4}%, bbox {:?}). The two renders drew a \
                 different picture — at a boundary this is a dropped or duplicated frame.",
                d.solid_share * 100.0,
                MAX_SOLID_DIFF_SHARE * 100.0,
                d.bbox
            );
            assert!(
                d.gross_share <= MAX_GROSS_DIFF_SHARE,
                "frame {n}: {:.2}% of pixels differ grossly (limit {:.2}%)",
                d.gross_share * 100.0,
                MAX_GROSS_DIFF_SHARE * 100.0
            );
        }
    }

    /// **D-360 — a lane changes which `ffmpeg` decoded a frame, never the
    /// frame.**
    ///
    /// The whole safety argument for rendering N stretches of one timeline at
    /// once is that `decode_pipe`'s lanes are an allocation strategy and
    /// nothing else: frame `N` is the picture at `N / source_fps` however the
    /// decoder got there (D-228/B-104), so a segment worker that seeks cold
    /// into the middle of a clip must produce exactly what a sequential walk
    /// through that clip produces. Asserted on raw compositor output, with no
    /// encoder in the way to mask a difference.
    #[test]
    fn a_frame_is_the_same_in_any_decode_lane() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fx = load_fixture();
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = dir.path();
        generate_media(&fx, dir).expect("generate fixture media");
        let timeline = localise_timeline(&fx.timeline, dir);
        let settings = settings_for(&fx);

        for n in &fx.sample_frames {
            // The live lane, walking forward from the start as the preview
            // does...
            let live = edit::render_timeline_frame(
                &timeline,
                &settings,
                *n,
                None,
                FrameIntent::Single,
                PipeLane::LIVE,
            )
            .expect("render on the live lane")
            .expect("a visible frame");
            // ...and a render lane meeting this frame cold, as a segment
            // worker whose range starts here does.
            let segment = edit::render_timeline_frame(
                &timeline,
                &settings,
                *n,
                None,
                FrameIntent::Single,
                PipeLane::render(3),
            )
            .expect("render on a segment lane")
            .expect("a visible frame");
            apelles_media::decode_pipe::release_lane(PipeLane::render(3));
            assert_eq!(
                live.to_rgba8().into_raw(),
                segment.to_rgba8().into_raw(),
                "frame {n} came out differently on a segment lane than on the live lane"
            );
        }
    }

    /// D-360 — the concat-list placeholder is one fact, written on both sides
    /// of the language boundary, and the remux copies the picture the app
    /// encoded (D-452) rather than encoding it again.
    #[test]
    fn the_mux_argv_token_matches_the_typescript_compiler() {
        let fx = load_fixture();
        assert_eq!(
            fx.mux_args
                .iter()
                .filter(|a| a.as_str() == CONCAT_LIST_TOKEN)
                .count(),
            1,
            "the compiled remux must carry {CONCAT_LIST_TOKEN} exactly once"
        );
        assert!(
            fx.mux_args.windows(2).any(|w| w == ["-c:v", "copy"]),
            "the remux must stream-copy the video"
        );
        assert_eq!(
            fx.mux_args.iter().filter(|a| a.as_str() == "-c:v").count(),
            1
        );
    }

    #[derive(Debug, Clone, Default)]
    pub(super) struct Sample {
        pub(super) peak_rss_mb: f64,
        pub(super) peak_threads: u64,
    }

    /// One reading for `pid` and every descendant of it: summed resident memory
    /// in MB and summed OS thread count.
    ///
    /// `ps` rather than a crate, because these are the same two numbers
    /// Activity Monitor shows, which is how B-229/B-230 were reported and
    /// therefore the only way this measurement is comparable to theirs. In two
    /// calls because **macOS `ps` has no thread-count column at all** (`thcount`
    /// and `nlwp` are both "keyword not found"): the tree and its RSS come from
    /// one `ps -A`, and each process's thread count from `ps -M -p <pid>`, which
    /// prints one row per thread under a single header line.
    pub(super) fn sample_tree(root: u32) -> Option<Sample> {
        let out = Command::new("ps")
            .args(["-Ao", "pid=,ppid=,rss="])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut rows: Vec<(u32, u32, f64)> = Vec::new();
        for line in text.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 3 {
                continue;
            }
            if let (Ok(pid), Ok(ppid), Ok(rss_kb)) = (
                f[0].parse::<u32>(),
                f[1].parse::<u32>(),
                f[2].parse::<f64>(),
            ) {
                rows.push((pid, ppid, rss_kb));
            }
        }
        let mut tree = vec![root];
        let mut grew = true;
        while grew {
            grew = false;
            for (pid, ppid, _) in &rows {
                if tree.contains(ppid) && !tree.contains(pid) {
                    tree.push(*pid);
                    grew = true;
                }
            }
        }
        let mut s = Sample::default();
        for (pid, _, rss_kb) in rows {
            if tree.contains(&pid) {
                s.peak_rss_mb += rss_kb / 1024.0;
                s.peak_threads += threads_of(pid);
            }
        }
        Some(s)
    }

    /// How many OS threads `pid` has, per `ps -M` — its output is one header
    /// line followed by one line per thread. `0` if the process has already
    /// exited, which is the right answer for a peak sampler.
    fn threads_of(pid: u32) -> u64 {
        Command::new("ps")
            .args(["-M", "-p", &pid.to_string()])
            .output()
            .ok()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .skip(1)
                    .filter(|l| !l.trim().is_empty())
                    .count() as u64
            })
            .unwrap_or(0)
    }

    /// **The resource claim, measured rather than asserted** (B-228/B-229/B-230
    /// were all found by watching a process, not by a test).
    ///
    /// The render path compiles to ONE input whatever the clip count — the
    /// per-clip decoder multiplication those three bugs were is gone by
    /// construction. This asserts the compiled shape (deterministic and
    /// CI-safe); the live numbers are in `docs/notes/export-gpu-compositor.md`
    /// §6.
    #[test]
    fn the_render_path_opens_one_input_however_many_clips_there_are() {
        let fx = load_fixture();
        let inputs = |args: &[String]| args.iter().filter(|a| a.as_str() == "-i").count();
        assert_eq!(
            inputs(&fx.mux_args),
            1,
            "the render path must open exactly one picture input — the segments"
        );
        assert_eq!(
            inputs(&fx.stress.mux_args),
            1,
            "a 20-clip timeline too — one input whatever the clip count"
        );
    }

    /// B-276 — a project with no frame size of its own (no settings, nothing
    /// on a video track to read one from: here a voice-over-only timeline)
    /// exports at the size the export asked for, instead of refusing with "no
    /// clip to derive a composition size from". The export compiler reads such
    /// a project's composition as that same output size, so this is the two
    /// engines agreeing, not a guess. (The fixture keeps the empty video track
    /// a new project has; a timeline with NO video track at all is
    /// [`an_audio_only_timeline_exports_a_black_picture_and_its_sound`], B-290.)
    #[test]
    fn a_sizeless_project_exports_at_the_requested_size() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let timeline = Timeline {
            id: "tl1".into(),
            name: "Timeline 1".into(),
            rate: None,
            tracks: vec![
                apelles_timeline::Track {
                    kind: apelles_timeline::TrackKind::Video,
                    ..Default::default()
                },
                apelles_timeline::Track {
                    kind: apelles_timeline::TrackKind::Audio,
                    clips: vec![apelles_timeline::Clip {
                        id: "vo".into(),
                        name: "vo".into(),
                        source_path: "/nonexistent/vo.wav".into(),
                        duration: 24,
                        source_len: 24,
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            ],
            markers: Vec::new(),
            ..Default::default()
        };
        let settings = ProjectSettings::default();
        assert!(
            edit::composition_size(&settings, &timeline).is_err(),
            "the fixture really is sizeless"
        );
        let dir = tempfile::tempdir().expect("tempdir");
        let req = request(
            video_only_mux(&dir.path().join("sizeless.mp4")),
            (64, 36),
            3,
            24.0,
        );
        let outcome = render_timeline(&timeline, &settings, &req)
            .expect("a sizeless project renders at the export's own size");
        assert_eq!(outcome.frames, 3);
    }

    /// **B-290 — an audio-only timeline exports through the compositor as a
    /// black picture at the requested size plus its sound, for its full
    /// length.** A timeline with NO video track at all (a cut voiceover) used to
    /// fail at frame 0 with "timeline has no video track"; every frame is now a
    /// nothing-visible frame, which this path writes as its opaque black
    /// `blank`.
    ///
    /// The argv has the shape `buildPipeExportPlan` compiles for such a
    /// timeline — the raw-video pipe, one audio input mapped beside it, `-t` at
    /// the audio's length — and the finished FILE is checked with ffprobe: one
    /// video stream at the export size, one audio stream, the right duration,
    /// and black pixels.
    #[test]
    fn an_audio_only_timeline_exports_a_black_picture_and_its_sound() {
        if !ffmpeg_available() {
            eprintln!("skipping: ffmpeg/ffprobe not on PATH");
            return;
        }
        // One export at a time: the status slot is process-wide.
        let _guard = super::super::PROJECT_STATE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        const FPS: f64 = 24.0;
        const SECS: f64 = 2.0;
        const FRAMES: u64 = 48;
        const OUT: (u32, u32) = (160, 90);
        let dir = tempfile::tempdir().expect("tempdir");
        let tone = dir.path().join("vo.wav");
        run_ffmpeg(&[
            "-v".into(),
            "error".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("sine=frequency=440:duration={SECS}:sample_rate=48000"),
            tone.to_string_lossy().to_string(),
        ])
        .expect("synthesise the voiceover");

        let timeline = Timeline {
            id: "vo".into(),
            name: "Voiceover".into(),
            rate: Some(apelles_types::Rational::new(24, 1)),
            tracks: vec![apelles_timeline::Track {
                kind: apelles_timeline::TrackKind::Audio,
                clips: vec![apelles_timeline::Clip {
                    id: "vo".into(),
                    name: "vo".into(),
                    source_path: tone.to_string_lossy().to_string(),
                    duration: FRAMES as i64,
                    source_len: FRAMES as i64,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let settings = ProjectSettings {
            width: Some(1920),
            height: Some(1080),
            fps: Some(FPS),
            color_space: None,
        };
        let out = dir.path().join("vo.mp4");
        // The remux `buildPipeExportPlan` compiles for such a timeline: the
        // rendered (black) segments, one audio input, `-t` at its length.
        let args: Vec<String> = [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            CONCAT_LIST_TOKEN,
            "-i",
            &tone.to_string_lossy(),
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:a",
            "aac",
            "-c:v",
            "copy",
            "-t",
            "2",
            &out.to_string_lossy(),
        ]
        .map(String::from)
        .to_vec();
        let req = request(args, OUT, FRAMES, FPS);
        let outcome =
            render_timeline(&timeline, &settings, &req).expect("an audio-only timeline exports");
        assert_eq!(outcome.frames, FRAMES);

        let probe = ffmpeg_locate::ffprobe()
            .expect("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,width,height:format=duration",
                "-of",
                "json",
            ])
            .arg(&out)
            .output()
            .expect("spawn ffprobe");
        let json: serde_json::Value =
            serde_json::from_slice(&probe.stdout).expect("ffprobe answers JSON");
        let streams = json["streams"].as_array().expect("a stream list");
        let video: Vec<&serde_json::Value> = streams
            .iter()
            .filter(|s| s["codec_type"] == "video")
            .collect();
        assert_eq!(video.len(), 1, "one video stream: {json}");
        assert_eq!(video[0]["width"], OUT.0);
        assert_eq!(video[0]["height"], OUT.1);
        assert_eq!(
            streams
                .iter()
                .filter(|s| s["codec_type"] == "audio")
                .count(),
            1,
            "one audio stream: {json}"
        );
        let duration: f64 = json["format"]["duration"]
            .as_str()
            .and_then(|d| d.parse().ok())
            .expect("a container duration");
        assert!(
            (duration - SECS).abs() < 0.1,
            "the export runs the voiceover's {SECS} s, not {duration} s"
        );
        assert_eq!(frame_count(&out).expect("frame count"), FRAMES);

        let frame = frame_of(&out, 24, &dir.path().join("f24.png")).expect("decode frame 24");
        assert!(
            frame.pixels().all(|p| p.0.iter().all(|c| *c <= 20)),
            "the picture is black (yuv420p limited range may lift it a few levels)"
        );
    }
}
