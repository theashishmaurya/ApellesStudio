//! **The Edit tab's headless timeline renderer (D-350, phase 1).**
//!
//! What it is: the picture half of `editor_export`, rendered by the SAME
//! compositor the Edit tab's live preview uses — `edit::render_timeline_frame`,
//! i.e. `composite_video_frame` → `composite_layer_onto` — walked frame by
//! frame over the export's whole duration and piped, as one raw RGBA stream,
//! into a single `ffmpeg` process that does nothing but compress and mux it.
//!
//! What it does NOT do:
//! - **Composite anything itself.** Every geometry, crop, corner-radius,
//!   opacity, keyframe, transition-alpha, adjustment-clip, title and caption
//!   decision is made by `chroma::edit`'s compositor, unchanged. This module is
//!   a loop, a resize and a pipe. That is the entire point of D-350: preview and
//!   export stop being two implementations of the same maths.
//! - **Build ffmpeg arguments.** The argv comes in from
//!   `packages/editor/src/timelineExport.ts`'s `buildPipeExportFfmpegArgs`,
//!   which also compiles the audio mix (D-197, reused unchanged). Same
//!   "the caller owns the content" split `chroma::ffmpeg_run` and
//!   `chroma::write_text_file` already use — no ffmpeg-arg knowledge lives here
//!   beyond the frame geometry it must agree with the caller about.
//! - **Mix audio.** `timelineExportAudio.ts` already does that, well and
//!   tested; D-350 explicitly left it alone.
//!
//! **Why this shape rather than more ffmpeg flags** (the full argument is
//! D-350; the measured pathologies are B-228/B-229/B-230): the old picture path
//! opens one `-i` per CLIP and builds one `-filter_complex` graph with a
//! per-clip `overlay`/`crop`/`scale`/`geq` chain, so both decoder frame-thread
//! pools and filter-instance thread pools multiply by the clip count. Here the
//! encoder has exactly **one** input — a pipe — no matter how many clips the
//! timeline has, and decoding is done by `apelles_media::decode_pipe`, which
//! holds **one process per visible video TRACK**, not per clip. Both halves of
//! the multiplication are gone by construction rather than by a cap.
//!
//! See `docs/notes/export-gpu-compositor.md` for the design, the measured
//! numbers, and what phase 1 deliberately defers.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Instant;

use apelles_project::manifest::ProjectSettings;
use apelles_timeline::Timeline;
use shared_child::SharedChild;

use super::edit::{self, FrameIntent};
use super::export::{drain_stderr_pipe, tail};
use super::export_status::{self, ExportJob};
use super::ffmpeg_run::ffmpeg_bin;

/// One headless render + encode.
///
/// `args` is the COMPLETE ffmpeg argv, already including this render's own raw
/// video input (`-f rawvideo -pixel_format rgba -video_size WxH -framerate F -i
/// -`) and everything after it. `width`/`height`/`frames` restate, in typed
/// form, the geometry that argv declares — this module renders to them and
/// would otherwise have to parse the argv back to find them out.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TimelineRenderRequest {
    pub args: Vec<String>,
    pub width: u32,
    pub height: u32,
    /// How many frames to render. The caller derives it from exactly the
    /// duration the old path put in its `-t`, so the two paths' picture lengths
    /// agree by construction rather than by two independent roundings.
    pub frames: u64,
    /// **D-360 — the argv for rendering this export as N contiguous segments.**
    ///
    /// Optional, and absent means "single stream", for two reasons: an export
    /// queued before D-360 and run after it carries no segment argv (the queue
    /// freezes a job's plan at enqueue time), and this side — not the
    /// compiler — decides whether splitting is worth it at all, since only it
    /// knows the machine. See [`plan_segment_count`].
    #[serde(default)]
    pub segments: Option<SegmentedEncodePlan>,
    /// **D-362 — the file this render is writing, for the status readout.**
    ///
    /// The path is already inside `args` (it is the output argv's last
    /// positional), but finding it there means parsing an argv this module
    /// deliberately does not understand — the D-350 split. The caller knows it
    /// outright, so it says it. Optional because it is a label, not an input:
    /// a request without one renders identically and simply reports no
    /// `output`.
    #[serde(default)]
    pub output: Option<String>,
}

/// The two extra argvs a segmented render needs, compiled by
/// `timelinePipeExport.ts` alongside the single-stream one (D-360).
///
/// Both carry a placeholder — [`SEGMENT_OUT_TOKEN`], [`CONCAT_LIST_TOKEN`] —
/// for the one thing the compiler cannot know: where this run's temporary
/// files landed. Everything else about them, the codec, the audio graph, the
/// mapping, is still compiled entirely on the TypeScript side, which is D-350's
/// "the caller owns the content" split unchanged.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentedEncodePlan {
    /// One segment's encode: the raw-video input, and a **video-only** output.
    pub segment_args: Vec<String>,
    /// The concat demuxer reading the finished segments, plus the audio mix —
    /// which is compiled for the whole timeline and so cannot be split.
    pub concat_args: Vec<String>,
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

/// **D-360 — the hard ceiling on concurrent segments: a memory bound that the
/// throughput measurement then independently agreed with.**
///
/// Each segment holds its own encoder process plus one `decode_pipe` `ffmpeg`
/// per visible video track, so the render's total process and memory cost is
/// `segments × (tracks + 1)`. That product is exactly the shape B-229 and B-230
/// were: a per-unit cost nobody bounded. Bounding the multiplier here — rather
/// than letting it follow the core count on whatever machine this runs on — is
/// what keeps a 32-core box from turning a 3.2 GB export into a 25 GB one.
///
/// **Six because it was measured, not because it is a round number.** The
/// throughput sweep ([`parity_tests::measure_segmented_render_throughput`],
/// recorded in `docs/notes/export-gpu-compositor.md` §10.5) plateaus at four
/// segments and is flat-to-slightly-worse beyond it — best-of-3 on the 1080p
/// stress fixture: 4 → 8.79 s, 6 → 8.91 s, 8 → 9.19 s, with an earlier
/// independent sweep agreeing that 8 loses to 4-6. So eight costs a third more
/// concurrent encoders and decoders than six for no throughput at all, which is
/// the wrong side of this constant's own argument. Six keeps the whole plateau
/// and is still below the owner's 10 logical cores, so the measured
/// configuration is the bounded one. The 4K case — where each segment's
/// resident cost is four times larger — is unmeasured, and every unknown there
/// points the same way: fewer, not more.
const MAX_SEGMENTS: usize = 6;

/// The argv placeholder `timelinePipeExport.ts` writes where a segment's own
/// output file goes, and the one it writes for the concat list. Substituted
/// here because only this side knows the temporary directory; the argv is
/// otherwise still compiled entirely by the caller, which is the D-350 split.
///
/// Their TypeScript twins are `SEGMENT_OUT_TOKEN` / `CONCAT_LIST_TOKEN` in
/// `packages/editor/src/timelinePipeExport.ts`, kept honest by
/// `the_segment_argv_tokens_match_the_typescript_compiler` reading them out of
/// the shared fixture — the same cross-engine pair pattern D-338/B-201 uses.
const SEGMENT_OUT_TOKEN: &str = "{{APELLES_SEGMENT_OUT}}";
const CONCAT_LIST_TOKEN: &str = "{{APELLES_CONCAT_LIST}}";

/// How many contiguous segments to split a render of `frames` into on THIS
/// machine (D-360).
///
/// Bounded three ways, in order: by the work available
/// ([`MIN_SEGMENT_FRAMES`]), by the cores available, and by
/// [`MAX_SEGMENTS`]. A short export comes back as 1 and takes the
/// single-stream path unchanged.
fn plan_segment_count(frames: u64) -> usize {
    let cores = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1);
    let by_work = (frames / MIN_SEGMENT_FRAMES) as usize;
    by_work.min(cores).clamp(1, MAX_SEGMENTS)
}

/// Split `frames` into `segments` contiguous, non-overlapping ranges that
/// cover `0..frames` exactly.
///
/// **The remainder is spread, not dumped on the last segment.** With
/// `frames = 5605` and 8 segments the difference is one frame per worker
/// against five on one of them, which is nothing; the reason to do it properly
/// is that "every frame belongs to exactly one range, and the ranges are
/// contiguous and in order" is the property the concatenated output's
/// frame-accuracy rests on, and it is easier to see in arithmetic that cannot
/// drop a remainder than in arithmetic that has to remember to add it back.
fn segment_ranges(frames: u64, segments: usize) -> Vec<std::ops::Range<u64>> {
    let segments = segments.max(1) as u64;
    let base = frames / segments;
    let extra = frames % segments;
    let mut ranges = Vec::with_capacity(segments as usize);
    let mut start = 0u64;
    for i in 0..segments {
        let len = base + u64::from(i < extra);
        ranges.push(start..start + len);
        start += len;
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

/// Render `timeline` at `req.width`×`req.height` for `req.frames` frames and
/// pipe it into the ffmpeg invocation `req.args` names.
///
/// **Blocking, and rendered in frame order** — frame `n` is composited before
/// frame `n + 1` is started, because `decode_pipe`'s pipes are strictly
/// sequential forward readers and asking one for a frame it has already passed
/// costs a kill-and-respawn (248-337 ms measured). See
/// [`WRITE_AHEAD`] and `docs/notes/export-gpu-compositor.md` §9 for why that
/// makes a naive `par_iter` over frame indices the wrong shape here, and what
/// IS parallel instead.
///
/// **Handing the finished frame off is not in that order-bound path**, though:
/// it goes to a writer thread through a bounded channel, so the copy into the
/// pipe, the kernel buffer and the encoder's own latency overlap the next
/// frame's compositing instead of stalling it. Backpressure is the channel's
/// bound — the memory story is [`WRITE_AHEAD`] frames, not an unbounded queue.
pub fn render_timeline(
    timeline: &Timeline,
    settings: &ProjectSettings,
    req: &TimelineRenderRequest,
) -> Result<TimelineRenderOutcome, String> {
    if req.width == 0 || req.height == 0 {
        return Err("render width and height must both be > 0".to_string());
    }
    let out = (req.width, req.height);
    let comp = edit::composition_size(settings, timeline)?;
    let canvas = canvas_plan(comp, out);
    let started = Instant::now();

    // D-360 — split into contiguous segments when the caller compiled the argv
    // for it AND this machine and this export are big enough to be worth it.
    // D-362 — the partition is decided HERE, once, whichever path runs, because
    // the progress tracker is built from the same ranges the workers walk: the
    // percentage is only a true fraction of the render because those ranges
    // partition it exactly, so they must not be derived twice.
    let segments = match &req.segments {
        Some(_) => plan_segment_count(req.frames),
        None => 1,
    };
    // No segment may be empty: it would spawn an encoder, write nothing, and
    // hand the concat demuxer a zero-frame file.
    let segments = segments.clamp(1, req.frames.max(1) as usize);
    let ranges = segment_ranges(req.frames, segments);

    let job = export_status::begin(
        req.frames,
        &ranges,
        req.output.clone(),
        export_status::STALL_TIMEOUT,
    )?;

    let outcome = match (&req.segments, ranges.len()) {
        (Some(plan), n) if n > 1 => render_segmented(
            timeline, settings, req, plan, &ranges, out, canvas, &job, started,
        ),
        _ => render_range(
            timeline,
            settings,
            &req.args,
            out,
            canvas,
            0..req.frames,
            apelles_media::decode_pipe::PipeLane::render(0),
            &job,
            0,
        )
        .map(|one| TimelineRenderOutcome {
            ok: true,
            frames: one.written,
            segments: 1,
            ms: started.elapsed().as_millis(),
            stderr_tail: one.stderr_tail,
        }),
    };

    // D-362 — the watchdog's verdict outranks whatever error its own kill
    // produced downstream. Killing a wedged encoder surfaces as a broken pipe,
    // which names the symptom; the stall reason names the cause, and is the
    // thing a caller (or B-231's next reader) actually needs to see.
    match outcome {
        Ok(o) => {
            job.finish(Ok(()));
            Ok(o)
        }
        Err(e) => {
            let e = job.stall_reason().unwrap_or(e);
            job.finish(Err(e.clone()));
            Err(e)
        }
    }
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

/// What one segment's worker produced.
struct SegmentOutcome {
    written: u64,
    stderr_tail: String,
}

/// **Render `range` of the timeline into the encoder `args` names, and nothing
/// else** — the loop D-350 phase 1 built and D-351 pipelined, with its frame
/// range and its decode-pipe lane made parameters (D-360).
///
/// One call is one contiguous stretch of frames, one `ffmpeg`, one output file
/// and one decode-pipe lane, decoded strictly forward from `range.start`. The
/// whole of the segmented path is N of these run at once; the single-stream
/// path is one of them over the whole timeline. There is deliberately no third
/// spelling of this loop.
#[allow(clippy::too_many_arguments)]
fn render_range(
    timeline: &Timeline,
    settings: &ProjectSettings,
    args: &[String],
    out: (u32, u32),
    canvas: (Option<u32>, bool),
    range: std::ops::Range<u64>,
    lane: apelles_media::decode_pipe::PipeLane,
    job: &Arc<ExportJob>,
    segment: usize,
) -> Result<SegmentOutcome, String> {
    let (max_long_edge, needs_resize) = canvas;
    // Frees this segment's decoders however this function returns.
    let _lane = LaneGuard(lane);
    // D-362 — a `SharedChild`, not a `std::process::Child`, so the stall
    // watchdog on another thread can kill this encoder. That is the only thing
    // that can free a writer wedged in `write_all` on a pipe whose reader has
    // stopped reading (B-231 facet 2): a blocking pipe write has no timeout,
    // and killing by raw pid races with the `wait` below reaping it.
    let child = Arc::new(
        SharedChild::spawn(
            Command::new(ffmpeg_bin())
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped()),
        )
        .map_err(|e| format!("spawn ffmpeg encoder: {e}"))?,
    );
    let stderr = drain_stderr_pipe(child.take_stderr());
    let mut stdin = child
        .take_stdin()
        .ok_or_else(|| "encoder stdin unavailable".to_string())?;
    // Registered before the first frame, so a segment that wedges on its very
    // first write is watched too — not only one that stops partway.
    job.attach_encoder(segment, child.clone());

    // The frame written when the timeline shows nothing at all at this
    // position — a gap under every track. Opaque black, which is exactly what
    // the compositor's own canvas starts as and what the ffmpeg path's
    // `color=black[base]` produced there.
    let blank: image::RgbaImage =
        image::ImageBuffer::from_pixel(out.0, out.1, image::Rgba([0, 0, 0, 255]));

    // D-351 — the writer. It owns `stdin` and does nothing but drain the
    // channel in the order the compositor produced it, so **frame order on the
    // wire is structural**: a `sync_channel` is FIFO and there is exactly one
    // producer, so there is no reordering for a sort to undo. ffmpeg is reading
    // this as a headerless `rawvideo` stream, where frame N is simply "the Nth
    // `width * height * 4` bytes" — a swap would not error, it would silently
    // emit a shuffled video, which is why the ordering guarantee wants to be a
    // property of the structure rather than of a comparison somewhere.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(WRITE_AHEAD);
    let writer = {
        // D-362 — the progress heartbeat is taken HERE, one tick per frame that
        // really reached the encoder's stdin. This is the most downstream point
        // this path controls, which is what lets one counter serve as both the
        // progress number and the watchdog's liveness signal: it freezes
        // whether the compositor stalled, the hand-off channel jammed, or the
        // encoder stopped reading.
        let job = job.clone();
        std::thread::spawn(move || -> Result<u64, std::io::Error> {
            let mut n = 0u64;
            for frame in rx {
                stdin.write_all(&frame)?;
                n += 1;
                job.frame_written(segment);
            }
            drop(stdin); // EOF → the encoder flushes and exits
            Ok(n)
        })
    };

    let mut render_err: Option<String> = None;
    for pos in range.clone() {
        // D-360 — a sibling segment has already failed, so this one's remaining
        // frames are work nobody will use. Checked per frame rather than not at
        // all so a failure surfaces in about one frame's time instead of after
        // every other segment has rendered itself out in full. D-362 — the
        // watchdog sets the same flag, so a stall stops every segment here too,
        // not only the one that wedged.
        if job.abort().load(std::sync::atomic::Ordering::Relaxed) {
            render_err = Some("another segment failed".to_string());
            break;
        }
        let frame = match edit::render_timeline_frame(
            timeline,
            settings,
            pos,
            max_long_edge,
            // **`Single`, not `Playing` — measured, and the opposite of the
            // obvious choice.** An export walks strictly forward, which looks
            // exactly like the access pattern `Playing`'s cut-boundary prefetch
            // (D-324) exists to smooth. It is not. That prefetch spawns a
            // STANDBY decoder for each boundary about half a second ahead, which
            // pays for itself when a human is watching frames arrive in real
            // time and cannot when the render is already going as fast as the
            // decoders will allow: on the 20-cut measurement fixture (clips of
            // 0.4 s, i.e. shorter than the lookahead, which is what "heavily
            // cut" means) `Playing` spawned a standby per cut and cost
            // **+35% peak RSS and 3x the wall time** against `Single` for a
            // byte-identical picture — 1964 MB / 40.0 s versus 1451 MB / 12.8 s.
            // The stall it avoids is a real cost; it is just a much smaller one
            // than running two decoders where one would do. See
            // `docs/notes/export-gpu-compositor.md` §6.
            FrameIntent::Single,
            lane,
        ) {
            Ok(Some(img)) => {
                let rgba = img.to_rgba8();
                if needs_resize || rgba.dimensions() != out {
                    image::imageops::resize(
                        &rgba,
                        out.0,
                        out.1,
                        image::imageops::FilterType::Triangle,
                    )
                } else {
                    rgba
                }
            }
            Ok(None) => blank.clone(),
            Err(e) => {
                render_err = Some(format!("frame {pos}: {e}"));
                break;
            }
        };
        if tx.send(frame.into_raw()).is_err() {
            // The writer is gone, which only happens when its `write_all`
            // failed — its own error is the real one, so take that below
            // rather than reporting "the channel closed".
            render_err = Some(format!("frame {pos}: encoder stopped reading"));
            break;
        }
    }

    drop(tx); // ends the writer's `for frame in rx`, which drops `stdin` → EOF
    // The writer is still draining up to `WRITE_AHEAD` frames here, and that
    // final flush can wedge exactly like any other write — so this join happens
    // BEFORE the segment stops being watched, deliberately.
    let joined = writer.join();
    job.segment_finished(segment);
    let written = match joined {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => {
            // The encoder may well still be alive and waiting for input that
            // will never come, so it is killed rather than waited on.
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("write to encoder: {e} — {}", tail(&stderr)));
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("the encoder writer thread panicked".to_string());
        }
    };
    // D-362 — bounded, because the watchdog has stopped watching this segment
    // and an encoder that took EOF and then never exited would hang the whole
    // export here with nothing left to notice it. Same budget as the per-frame
    // watchdog: this is the same "it stopped doing anything" question, asked at
    // the one point where there are no frames left to count.
    let status = wait_bounded(&child, job.stall_after(), "the encoder")?;

    if let Some(e) = render_err {
        return Err(format!("{e} — {}", tail(&stderr)));
    }
    if !status.success() {
        return Err(format!("encoder exited {status}: {}", tail(&stderr)));
    }
    let wanted = range.end - range.start;
    if written != wanted {
        // The encoder read a headerless raw stream, so a short write is not an
        // error anywhere below this line — it is simply a shorter video. Said
        // here or not at all.
        return Err(format!(
            "segment {}..{} wrote {written} frames, not {wanted}",
            range.start, range.end
        ));
    }
    Ok(SegmentOutcome {
        written,
        stderr_tail: tail(&stderr),
    })
}

/// **D-360 — the contiguous-segment render: N workers, N lanes, N encoders,
/// one concatenation.**
///
/// Splits `0..req.frames` into `segments` contiguous ranges and renders them at
/// once, each into its own file, then hands the files to the caller-compiled
/// concat argv — which is also where the audio mix is muxed in, since the sound
/// is compiled for the whole timeline and has no notion of the split.
///
/// **Why this is the shape that scales where D-351's could not** (the full
/// argument is D-351's own §9.2): giving each worker every Lth frame leaves
/// every worker *decoding* every frame, because a decode pipe can only skip
/// forward — so wall time stays `N·d + N·c/L` and only the composite term
/// improves. Contiguous ranges divide both terms, because worker `k` decodes
/// only the frames in its own range. What that costs is a whole segment of
/// finished frames in flight, which is tens of GB at 4K — and is exactly what
/// giving each segment its OWN encoder removes: nothing is buffered that
/// [`WRITE_AHEAD`] does not already bound, per segment.
///
/// **Frame accuracy across a boundary is structural, not checked afterwards.**
/// [`segment_ranges`] partitions `0..frames`, each worker asserts it wrote its
/// own range's length exactly, and this function asserts the total. A frame
/// cannot be dropped or duplicated at a boundary without one of those three
/// failing, which matters because the concat demuxer would stitch a short
/// segment together with the next one perfectly happily and ship a video one
/// frame out of sync from that point on.
#[allow(clippy::too_many_arguments)]
fn render_segmented(
    timeline: &Timeline,
    settings: &ProjectSettings,
    req: &TimelineRenderRequest,
    plan: &SegmentedEncodePlan,
    ranges: &[std::ops::Range<u64>],
    out: (u32, u32),
    canvas: (Option<u32>, bool),
    job: &Arc<ExportJob>,
    started: Instant,
) -> Result<TimelineRenderOutcome, String> {
    let dir = tempfile::Builder::new()
        .prefix("apelles-render-")
        .tempdir()
        .map_err(|e| format!("create the segment directory: {e}"))?;
    // The partition comes in from `render_timeline`, which derived it once —
    // D-362, because `job`'s progress arithmetic is only a true fraction of the
    // render if the ranges the workers walk are the ranges it was built from.
    let files: Vec<PathBuf> = (0..ranges.len())
        .map(|i| dir.path().join(format!("segment-{i:03}.mp4")))
        .collect();
    let argvs = files
        .iter()
        .map(|f| substitute_token(&plan.segment_args, SEGMENT_OUT_TOKEN, f))
        .collect::<Result<Vec<_>, String>>()?;

    let results: Vec<Result<SegmentOutcome, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = ranges
            .iter()
            .zip(&argvs)
            .enumerate()
            .map(|(i, (range, args))| {
                let range = range.clone();
                scope.spawn(move || {
                    let outcome = render_range(
                        timeline,
                        settings,
                        args,
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

    let mut written = 0u64;
    let mut stderr_tail = String::new();
    for (i, result) in results.into_iter().enumerate() {
        match result {
            Ok(outcome) => {
                written += outcome.written;
                if !outcome.stderr_tail.is_empty() {
                    stderr_tail = outcome.stderr_tail;
                }
            }
            Err(e) => return Err(format!("segment {i}: {e}")),
        }
    }
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

    let list = dir.path().join("segments.txt");
    let listing: String = files.iter().map(|f| concat_list_line(f)).collect();
    std::fs::write(&list, listing).map_err(|e| format!("write the concat list: {e}"))?;
    let concat = substitute_token(&plan.concat_args, CONCAT_LIST_TOKEN, &list)?;
    // A `SharedChild` here too, for [`wait_bounded`]: the concat makes no
    // per-frame progress for the watchdog to read, so it bounds itself. It is
    // `-c:v copy` over finished files and normally takes seconds — but "it
    // normally finishes" is exactly what B-231 says about the rest of this path.
    let joiner = Arc::new(
        SharedChild::spawn(
            Command::new(ffmpeg_bin())
                .args(&concat)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::piped()),
        )
        .map_err(|e| format!("spawn the concat step: {e}"))?,
    );
    let concat_err = drain_stderr_pipe(joiner.take_stderr());
    let status = wait_bounded(&joiner, job.stall_after(), "the concat step")?;
    if !status.success() {
        return Err(format!(
            "concatenating {} segments exited {}: {}",
            files.len(),
            status,
            tail(&concat_err)
        ));
    }

    Ok(TimelineRenderOutcome {
        ok: true,
        frames: written,
        segments: files.len(),
        ms: started.elapsed().as_millis(),
        stderr_tail,
    })
}

/// `editor_export`'s D-350 render path, as a Tauri command: resolve the OPEN
/// project's active timeline once, then [`render_timeline`] it.
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
        let (timeline, settings) = edit::resolve_timeline_and_settings(false)?;
        render_timeline(&timeline, &settings, &req)
    })
    .await
    .map_err(|e| format!("timeline render task: {e}"))?
}

/// The raw-video input every D-350 render is piped into, as an argv prefix.
///
/// Test-only, and deliberately so: production always takes its argv whole from
/// `timelinePipeExport.ts`'s `pipeVideoInputArgs`, because splitting argv
/// construction across two languages is exactly the two-implementations problem
/// D-350 exists to remove. This exists so this module's own tests can build a
/// real encoder invocation without a TypeScript compiler in the loop, and
/// `'the render path emits no video filter graph at all'` in
/// `packages/editor/src/exportParityFixture.test.ts` is what keeps the two
/// spellings honest — the same cross-engine pair pattern D-338/B-201 uses.
#[cfg(test)]
fn pipe_input_args(width: u32, height: u32, fps: f64) -> Vec<String> {
    vec![
        "-y".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pixel_format".into(),
        "rgba".into(),
        "-video_size".into(),
        format!("{width}x{height}"),
        "-framerate".into(),
        format!("{fps}"),
        "-i".into(),
        "-".into(),
    ]
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

    /// **D-360 — the property the concatenated output's frame accuracy rests
    /// on.** Every frame belongs to exactly one segment, the segments are
    /// contiguous and in order, and they cover the whole render. A partition
    /// that lost or repeated a frame would not fail anywhere else: the concat
    /// demuxer stitches whatever it is given, so a short segment simply ships a
    /// video that is out of sync from that point on.
    #[test]
    fn segment_ranges_partition_the_render_exactly() {
        for (frames, segments) in [(60u64, 4usize), (5605, 8), (100, 3), (7, 4), (1, 1), (0, 4)] {
            let ranges = segment_ranges(frames, segments);
            assert_eq!(ranges.len(), segments, "{frames}/{segments}: segment count");
            assert_eq!(ranges[0].start, 0, "{frames}/{segments}: starts at zero");
            assert_eq!(
                ranges[ranges.len() - 1].end,
                frames,
                "{frames}/{segments}: ends at the last frame"
            );
            for pair in ranges.windows(2) {
                assert_eq!(
                    pair[0].end, pair[1].start,
                    "{frames}/{segments}: {pair:?} leaves a hole or overlaps"
                );
            }
            let covered: u64 = ranges.iter().map(|r| r.end - r.start).sum();
            assert_eq!(covered, frames, "{frames}/{segments}: total frames");
            // The remainder is spread, so no two segments differ by more than
            // one frame — the whole point of splitting is that they finish
            // together.
            let lens: Vec<u64> = ranges.iter().map(|r| r.end - r.start).collect();
            let (lo, hi) = (
                lens.iter().copied().min().unwrap_or(0),
                lens.iter().copied().max().unwrap_or(0),
            );
            assert!(hi - lo <= 1, "{frames}/{segments}: uneven split {lens:?}");
        }
    }

    /// D-360 — a render too short to be worth splitting takes the
    /// single-stream path, whatever the machine's core count.
    #[test]
    fn a_short_render_is_not_split() {
        assert_eq!(plan_segment_count(0), 1);
        assert_eq!(plan_segment_count(MIN_SEGMENT_FRAMES - 1), 1);
        assert_eq!(plan_segment_count(MIN_SEGMENT_FRAMES), 1);
        // And a long one is bounded by MAX_SEGMENTS however many cores exist.
        assert!(plan_segment_count(u32::MAX as u64) <= MAX_SEGMENTS);
    }

    #[test]
    fn substitute_token_demands_exactly_one_placeholder() {
        let out = Path::new("/tmp/seg-000.mp4");
        let ok = vec!["-i".to_string(), SEGMENT_OUT_TOKEN.to_string()];
        assert_eq!(
            substitute_token(&ok, SEGMENT_OUT_TOKEN, out),
            Ok(vec!["-i".to_string(), "/tmp/seg-000.mp4".to_string()])
        );
        assert!(substitute_token(&[], SEGMENT_OUT_TOKEN, out).is_err());
        let twice = vec![SEGMENT_OUT_TOKEN.to_string(), SEGMENT_OUT_TOKEN.to_string()];
        assert!(substitute_token(&twice, SEGMENT_OUT_TOKEN, out).is_err());
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

    #[test]
    fn pipe_input_args_declare_rgba_at_the_render_size() {
        let args = pipe_input_args(1920, 1080, 30.0);
        assert_eq!(args[args.len() - 2..], ["-i".to_string(), "-".to_string()]);
        assert!(args.contains(&"rawvideo".to_string()));
        assert!(args.contains(&"rgba".to_string()));
        assert!(args.contains(&"1920x1080".to_string()));
    }
}

/// **D-350's decisive verification: the old ffmpeg-filter-graph path and the new
/// compositor render path, rendered from one document and compared PIXEL BY
/// PIXEL.**
///
/// Everything in here spawns real `ffmpeg`, generates real media and decodes
/// real frames — and is skipped (not failed) when `ffmpeg`/`ffprobe` are not on
/// PATH, matching `timelineExport.ffmpeg.test.ts`'s own convention so a missing
/// binary cannot break an otherwise-green run.
///
/// The document, and BOTH compiled argvs, come from
/// `app/src-tauri/tests/fixtures/export-parity.json`, which
/// `packages/editor/src/exportParityFixture.test.ts` writes and — on every one
/// of its own runs — re-asserts against the live TypeScript compilers. So this
/// test is measuring today's old path, not a snapshot of it: the fixture cannot
/// drift without that test failing first. See
/// `docs/notes/export-gpu-compositor.md` §5.
#[cfg(test)]
mod parity_tests {
    use super::*;
    use apelles_media::decode_pipe::PipeLane;

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

    fn have(bin: &str) -> bool {
        Command::new(bin)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn ffmpeg_available() -> bool {
        have(&ffmpeg_bin()) && have("ffprobe")
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
                let wall = time_one_render(&timeline, &settings, st, dir, out, canvas, segments);
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
    ) -> f64 {
        let target = dir.join(format!("stress-{segments}.mp4"));
        let started = Instant::now();
        let outcome = if segments == 1 {
            render_timeline(
                timeline,
                settings,
                &TimelineRenderRequest {
                    args: localise(&st.pipe_args, dir, &target),
                    width: st.width,
                    height: st.height,
                    frames: st.pipe_frames,
                    segments: None,
                    output: None,
                },
            )
        } else {
            let plan = SegmentedEncodePlan {
                segment_args: localise(&st.segment_args, dir, &target),
                concat_args: localise(&st.concat_args, dir, &target),
            };
            render_at_segments(
                timeline,
                settings,
                &TimelineRenderRequest {
                    args: Vec::new(),
                    width: st.width,
                    height: st.height,
                    frames: st.pipe_frames,
                    segments: None,
                    output: None,
                },
                &plan,
                segments,
                out,
                canvas,
            )
        }
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
        filter_args: Vec<String>,
        pipe_args: Vec<String>,
        pipe_frames: u64,
        segment_args: Vec<String>,
        concat_args: Vec<String>,
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
        filter_args: Vec<String>,
        pipe_args: Vec<String>,
        pipe_frames: u64,
        segment_args: Vec<String>,
        concat_args: Vec<String>,
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
            filter_args: Vec<String>,
            pipe_args: Vec<String>,
            pipe_frames: u64,
            segment_args: Vec<String>,
            concat_args: Vec<String>,
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
            filter_args: w.filter_args,
            pipe_args: w.pipe_args,
            pipe_frames: w.pipe_frames,
            segment_args: w.segment_args,
            concat_args: w.concat_args,
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
        let status = Command::new(ffmpeg_bin())
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

    fn localise_timeline(timeline: &Timeline, dir: &Path) -> Timeline {
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

    fn run_ffmpeg(args: &[String]) -> Result<(), String> {
        let out = Command::new(ffmpeg_bin())
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
            "-vsync".into(),
            "0".into(),
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
        max_channel: i32,
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
        let mut max_channel = 0i32;
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
                max_channel = max_channel.max(worst);
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
            max_channel,
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

    /// **The test D-350 exists for.** One document → both engines → real
    /// decoded pixels at five real timestamps, covering a keyframed slide, a
    /// rounded box and a crop, over a second full-frame layer.
    #[test]
    fn render_path_matches_the_filter_graph_path_pixel_for_pixel() {
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

        let old_out = dir.join("old.mp4");
        let new_out = dir.join("new.mp4");
        run_ffmpeg(&localise(&fx.filter_args, dir, &old_out)).expect("the old filter-graph export");

        let timeline = localise_timeline(&fx.timeline, dir);
        let settings = settings_for(&fx);
        let req = TimelineRenderRequest {
            args: localise(&fx.pipe_args, dir, &new_out),
            width: fx.comp_width,
            height: fx.comp_height,
            frames: fx.pipe_frames,
            segments: None,
            output: None,
        };
        let outcome = render_timeline(&timeline, &settings, &req).expect("the new render path");
        assert_eq!(
            outcome.frames, fx.pipe_frames,
            "the render path must write every frame it was asked for"
        );

        let mut worst = f64::INFINITY;
        for (i, n) in fx.sample_frames.iter().enumerate() {
            let a = frame_of(&old_out, *n, &dir.join(format!("old{i}.png"))).expect("old frame");
            let b = frame_of(&new_out, *n, &dir.join(format!("new{i}.png"))).expect("new frame");
            let d = compare(&a, &b);
            eprintln!(
                "frame {n}: PSNR {:.1} dB · differing {:.3}% · SOLID {:.4}% · worst channel {} · bbox {:?}",
                d.psnr_db,
                d.gross_share * 100.0,
                d.solid_share * 100.0,
                d.max_channel,
                d.bbox
            );
            worst = worst.min(d.psnr_db);
            assert!(
                d.solid_share <= MAX_SOLID_DIFF_SHARE,
                "frame {n}: {:.4}% of pixels differ SOLIDLY (a filled region, not a boundary \
                 line) — limit {:.4}%, difference bounded by {:?}. The two engines drew a \
                 different picture here, not the same one a pixel apart.",
                d.solid_share * 100.0,
                MAX_SOLID_DIFF_SHARE * 100.0,
                d.bbox
            );
            assert!(
                d.gross_share <= MAX_GROSS_DIFF_SHARE,
                "frame {n}: {:.2}% of pixels differ by more than {GROSS_DIFF_CHANNEL}/255 in some \
                 channel (limit {:.2}%) — too much boundary to be one pixel of rounding",
                d.gross_share * 100.0,
                MAX_GROSS_DIFF_SHARE * 100.0
            );
        }
        eprintln!(
            "worst PSNR across {} frames: {worst:.1} dB",
            fx.sample_frames.len()
        );
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

    /// **D-351 — every frame reaches the encoder, once, in timeline order.**
    ///
    /// The hand-off to the encoder is a bounded channel and a writer thread now,
    /// so the frames are no longer written by the same thread that composited
    /// them. ffmpeg reads that pipe as headerless `rawvideo`, where frame N is
    /// nothing but "the Nth `w * h * 4` bytes" — a dropped, duplicated or
    /// swapped frame would not raise an error anywhere, it would silently ship a
    /// shuffled video. So the ordering is asserted directly rather than trusted:
    /// the render's own output is taken **losslessly** (`-f rawvideo`, no codec
    /// in the loop) and every frame of it is compared byte-for-byte against what
    /// the compositor produces for that position, in order.
    ///
    /// Byte equality, not a tolerance — with no encoder between them the two
    /// must be the identical buffer, which also makes a one-frame offset
    /// (the failure a per-frame *marker* would catch) impossible to pass: the
    /// fixture's picture genuinely differs frame to frame, since its pip slides.
    #[test]
    fn the_piped_stream_carries_every_frame_in_timeline_order() {
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

        // A lossless sink: rgba in, rgba out, no filter and no codec, so the
        // file IS the byte stream this path wrote.
        let raw = dir.join("ordered.raw");
        let mut args = pipe_input_args(w, h, fx.fps);
        args.extend([
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            "rgba".into(),
        ]);
        args.push(raw.to_string_lossy().into_owned());

        let req = TimelineRenderRequest {
            args,
            width: w,
            height: h,
            frames: fx.pipe_frames,
            segments: None,
            output: None,
        };
        let outcome = render_timeline(&timeline, &settings, &req).expect("the render path");
        assert_eq!(
            outcome.frames, fx.pipe_frames,
            "the render reported a different frame count than it was asked for"
        );

        let bytes = std::fs::read(&raw).expect("read the raw stream back");
        let frame_len = w as usize * h as usize * 4;
        assert_eq!(
            bytes.len(),
            frame_len * fx.pipe_frames as usize,
            "the piped stream is not exactly {} whole frames — a frame was dropped or duplicated",
            fx.pipe_frames
        );

        for pos in 0..fx.pipe_frames {
            let want = edit::render_timeline_frame(
                &timeline,
                &settings,
                pos,
                None,
                FrameIntent::Single,
                PipeLane::LIVE,
            )
            .expect("render for comparison")
            .expect("a visible frame")
            .to_rgba8()
            .into_raw();
            let got = &bytes[pos as usize * frame_len..(pos as usize + 1) * frame_len];
            assert!(
                want == got,
                "frame {pos} of the piped stream is not the frame the compositor produced for \
                 position {pos} — the writer reordered, dropped or duplicated a frame"
            );
        }
    }

    /// **B-231 facet 2, PROVEN rather than asserted: a real `ffmpeg` that
    /// really stops reading is caught by the watchdog, killed, and named.**
    ///
    /// The hang B-231 describes is an encoder left alive at 0% CPU with the
    /// render wedged writing into it — a blocking pipe write with no timeout,
    /// which previously meant no error, ever, and a frozen unfinalised output
    /// file as the only evidence. A watchdog that cannot be shown to fire is
    /// not a fix, so this reproduces that exact state with a real process
    /// rather than simulating it.
    ///
    /// **How the stall is constructed, and why it is genuine:** `-re` makes
    /// ffmpeg read its input at the input's own declared frame rate, so
    /// `-framerate 0.02` is one frame every 50 seconds. After the kernel pipe
    /// buffer and [`WRITE_AHEAD`] fill — a few frames — the writer thread
    /// blocks in `write_all` and stays there, which is facet 2's shape exactly:
    /// the child is healthy, the render makes no progress, and nothing in the
    /// process is in a position to notice. Measured before this test was
    /// written: 5 frames in 59.6 s, the writer blocked for the whole of it.
    ///
    /// The job's stall budget is seconds here rather than [`STALL_TIMEOUT`]'s
    /// two minutes, which is the only reason this can be a test — the
    /// threshold is a per-job value for exactly that reason.
    #[test]
    fn a_stalled_encoder_is_killed_and_reported() {
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
        let out = (w, h);
        let comp = edit::composition_size(&settings, &timeline).expect("composition size");

        let args: Vec<String> = vec![
            "-y".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            // The stall itself: read the input at its declared rate, and
            // declare a rate of one frame per 50 seconds.
            "-re".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pixel_format".into(),
            "rgba".into(),
            "-video_size".into(),
            format!("{w}x{h}"),
            "-framerate".into(),
            "0.02".into(),
            "-i".into(),
            "-".into(),
            // Nothing is being measured about the output, so it goes nowhere.
            "-f".into(),
            "null".into(),
            "-".into(),
        ];

        const STALL: std::time::Duration = std::time::Duration::from_secs(4);
        // The real partition function, at one segment — the same call
        // `render_timeline` makes for an unsplit render.
        let ranges = segment_ranges(fx.pipe_frames, 1);
        let job = export_status::begin(
            fx.pipe_frames,
            &ranges,
            Some("/tmp/never-finished.mp4".to_string()),
            STALL,
        )
        .expect("begin");

        let started = Instant::now();
        let result = render_range(
            &timeline,
            &settings,
            &args,
            out,
            canvas_plan(comp, out),
            0..fx.pipe_frames,
            PipeLane::render(0),
            &job,
            0,
        );
        let elapsed = started.elapsed();
        assert!(result.is_err(), "a stalled render must not report success");
        job.finish(result.map(|_| ()).map_err(|e| e.clone()));

        // 1 — it really was stopped by the watchdog, not by finishing.
        let reason = job
            .stall_reason()
            .expect("the watchdog must have fired on a genuinely stalled encoder");
        assert!(reason.contains("stalled"), "{reason}");
        assert!(reason.contains("wrote no frame"), "{reason}");

        // 2 — and it really was the hang that was caught, not a slow success:
        // at one frame per 50 s this argv cannot have written 60 frames, and
        // the whole call returned in a small multiple of the stall budget
        // instead of never.
        assert!(
            elapsed < STALL * 6,
            "the watchdog must end a stalled render promptly, took {elapsed:?}"
        );

        // 3 — what a CALLER sees. This is the actual B-231 fix: a polled status
        // that says the export is dead and that its file is not usable, where
        // before there was no signal of any kind.
        let status = export_status::snapshot();
        assert_eq!(status.state, export_status::ExportState::Stalled);
        assert!(status.frames_written < fx.pipe_frames);
        let error = status.error.expect("a stalled export reports an error");
        assert!(error.contains("incomplete"), "{error}");
        assert!(
            status.note.contains("HUNG"),
            "the note must not read like a normal failure: {}",
            status.note
        );
    }

    /// **The other half of B-231: the status really moves WHILE a real render
    /// is running, not just once it has finished.**
    ///
    /// A progress value that is only correct at the end is exactly the thing
    /// B-231 already had — `TimelineRenderOutcome` has always reported the
    /// final frame count. What was missing is a number a caller whose
    /// `editor_export` already timed out can read mid-flight, so that is what
    /// this samples: a render on one thread, `snapshot()` polled from another.
    ///
    /// **Deliberately throttled to be deterministic.** `-re` at the fixture's
    /// own frame rate makes the encoder consume in real time, so this
    /// fixture's 60 frames take ~2.5 s and a mid-flight window is guaranteed
    /// rather than raced for. The counter under test is identical either way —
    /// the writer ticks it per frame regardless of how fast the encoder drains
    /// — and the unthrottled, genuinely concurrent case is covered by
    /// `the_segmented_render_is_the_same_video_as_the_single_stream_one`'s own
    /// end-state assertions plus `export_status`' `progress_sums_across_
    /// concurrent_segments`.
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
        generate_media(&fx, dir).expect("generate fixture media");
        let timeline = localise_timeline(&fx.timeline, dir);
        let settings = settings_for(&fx);
        let (w, h) = (fx.comp_width, fx.comp_height);
        let out = (w, h);
        let comp = edit::composition_size(&settings, &timeline).expect("composition size");

        let mut args = vec![
            "-y".to_string(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-re".into(),
        ];
        args.extend(pipe_input_args(w, h, fx.fps).into_iter().skip(4));
        args.extend(["-f".to_string(), "null".into(), "-".into()]);

        // The real partition function, at one segment — the same call
        // `render_timeline` makes for an unsplit render.
        let ranges = segment_ranges(fx.pipe_frames, 1);
        let job = export_status::begin(
            fx.pipe_frames,
            &ranges,
            Some("/tmp/in-flight.mp4".to_string()),
            export_status::STALL_TIMEOUT,
        )
        .expect("begin");

        let mut samples: Vec<(u64, f64)> = Vec::new();
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                render_range(
                    &timeline,
                    &settings,
                    &args,
                    out,
                    canvas_plan(comp, out),
                    0..fx.pipe_frames,
                    PipeLane::render(0),
                    &job,
                    0,
                )
            });
            while !worker.is_finished() {
                let s = export_status::snapshot();
                samples.push((s.frames_written, s.percent));
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            worker
                .join()
                .expect("the render thread")
                .expect("the throttled render");
        });
        job.finish(Ok(()));

        // It moved, and it moved in the middle — a sample that is neither
        // "nothing yet" nor "already everything".
        assert!(
            samples.iter().any(|(n, _)| *n > 0 && *n < fx.pipe_frames),
            "no sample caught the render in flight: {samples:?}"
        );
        // And it only ever went forwards. A progress bar that goes backwards is
        // worse than none.
        for pair in samples.windows(2) {
            assert!(
                pair[1].0 >= pair[0].0 && pair[1].1 >= pair[0].1,
                "progress went backwards: {:?} then {:?}",
                pair[0],
                pair[1]
            );
        }
        // And it lands exactly on the whole render, not near it.
        let done = export_status::snapshot();
        assert_eq!(done.state, export_status::ExportState::Done);
        assert_eq!(done.frames_written, fx.pipe_frames);
        assert_eq!(done.percent, 100.0);
        assert_eq!(done.segments_done, 1);
        assert_eq!(done.phase, None);
    }

    /// Drive [`render_segmented`] at a segment count the test names, doing
    /// exactly what [`render_timeline`] does around it: derive the partition
    /// once, open the D-362 progress job from those same ranges, and close it
    /// with the outcome. `plan_segment_count` answers 1 for renders this short
    /// (`MIN_SEGMENT_FRAMES` is 90), so these tests cannot get a split by
    /// asking [`render_timeline`] for one — but they must not skip the job
    /// either, or they would be exercising a path production no longer has.
    fn render_at_segments(
        timeline: &Timeline,
        settings: &ProjectSettings,
        req: &TimelineRenderRequest,
        plan: &SegmentedEncodePlan,
        segments: usize,
        out: (u32, u32),
        canvas: (Option<u32>, bool),
    ) -> Result<TimelineRenderOutcome, String> {
        let segments = segments.clamp(1, req.frames.max(1) as usize);
        let ranges = segment_ranges(req.frames, segments);
        let job = export_status::begin(
            req.frames,
            &ranges,
            req.output.clone(),
            export_status::STALL_TIMEOUT,
        )?;
        let outcome = render_segmented(
            timeline,
            settings,
            req,
            plan,
            &ranges,
            out,
            canvas,
            &job,
            Instant::now(),
        );
        job.finish(outcome.as_ref().map(|_| ()).map_err(Clone::clone));
        outcome
    }

    /// How many video frames `video` actually contains, counted rather than
    /// derived from a duration — the number a dropped or duplicated frame at a
    /// segment boundary changes, and the one the container's own metadata is
    /// least likely to be honest about.
    fn frame_count(video: &Path) -> Result<u64, String> {
        let out = Command::new("ffprobe")
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

        let single = render_timeline(
            &timeline,
            &settings,
            &TimelineRenderRequest {
                args: localise(&fx.pipe_args, dir, &single_out),
                width: fx.comp_width,
                height: fx.comp_height,
                frames: fx.pipe_frames,
                segments: None,
                output: None,
            },
        )
        .expect("the single-stream render");
        assert_eq!(single.segments, 1, "the single-stream path must not split");

        let req = TimelineRenderRequest {
            args: Vec::new(), // unused: `render_segmented` takes the plan below
            width: fx.comp_width,
            height: fx.comp_height,
            frames: fx.pipe_frames,
            segments: None,
            output: None,
        };
        let plan = SegmentedEncodePlan {
            segment_args: localise(&fx.segment_args, dir, &segmented_out),
            concat_args: localise(&fx.concat_args, dir, &segmented_out),
        };
        let out = (fx.comp_width, fx.comp_height);
        let comp = edit::composition_size(&settings, &timeline).expect("composition size");
        let many = render_at_segments(
            &timeline,
            &settings,
            &req,
            &plan,
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
        let boundaries: Vec<u64> = segment_ranges(fx.pipe_frames, SEGMENTS)
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

    /// D-360 — the two placeholder spellings are one fact, written on both
    /// sides of the language boundary. The same cross-engine pair
    /// `pipe_input_args_declare_rgba_at_the_render_size` is half of.
    #[test]
    fn the_segment_argv_tokens_match_the_typescript_compiler() {
        let fx = load_fixture();
        assert_eq!(
            fx.segment_args
                .iter()
                .filter(|a| a.as_str() == SEGMENT_OUT_TOKEN)
                .count(),
            1,
            "the compiled segment argv must carry {SEGMENT_OUT_TOKEN} exactly once"
        );
        assert_eq!(
            fx.concat_args
                .iter()
                .filter(|a| a.as_str() == CONCAT_LIST_TOKEN)
                .count(),
            1,
            "the compiled concat argv must carry {CONCAT_LIST_TOKEN} exactly once"
        );
        // A segment is video only, and is bounded by its pipe closing rather
        // than by a duration that knows nothing about its range.
        assert!(
            !fx.segment_args.iter().any(|a| a == "-t"),
            "a segment argv must not carry -t"
        );
        assert!(
            !fx.segment_args.iter().any(|a| a == "-filter_complex"),
            "a segment argv must not carry an audio graph"
        );
        // The concat step copies the picture: re-encoding it would cost a
        // second generation for nothing.
        assert!(
            fx.concat_args.windows(2).any(|w| w == ["-c:v", "copy"]),
            "the concat step must stream-copy the video"
        );
    }

    /// **The live resource measurement B-230's own write-up says this repo was
    /// missing** ("nothing in this repo fails a build when an export's peak
    /// memory or thread count regresses — both halves of this blowup were found
    /// by a human watching Activity Monitor").
    ///
    /// `#[ignore]`d on purpose: it samples a live process's real footprint and
    /// thread count, which is a MEASUREMENT, not a pass/fail fact — a CI box
    /// with a different core count produces different numbers for the old path
    /// by design (that is the bug: its cost scales with the machine). Run it by
    /// hand and read the numbers:
    ///
    /// ```text
    /// cargo test -p apelles --lib chroma::edit_render::parity_tests::measure -- --ignored --nocapture
    /// ```
    ///
    /// The recorded run is in `docs/notes/export-gpu-compositor.md` §6.
    #[test]
    #[ignore = "a live resource measurement, not a pass/fail assertion — see the doc comment"]
    fn measure_resource_use_against_the_filter_graph_path() {
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

        eprintln!(
            "\n=== D-350 resource measurement: {} clips, {}x{}, {} frames ===",
            st.clips, st.width, st.height, st.pipe_frames
        );

        // --- the OLD path: one ffmpeg process, one `-i` per clip ---
        let old_out = dir.join("stress-old.mp4");
        let old_args = localise(&st.filter_args, dir, &old_out);
        let started = Instant::now();
        let mut child = Command::new(ffmpeg_bin())
            .args(&old_args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the old path");
        let old = sample_until_exit(&mut child);
        let old_ms = started.elapsed().as_millis();
        eprintln!(
            "filter-graph path : peak RSS {:>7.1} MB · peak threads {:>5} · {} inputs · {old_ms} ms",
            old.peak_rss_mb,
            old.peak_threads,
            st.filter_args.iter().filter(|a| a.as_str() == "-i").count()
        );

        // --- the NEW path: this process composites, one ffmpeg encodes ---
        // Measured as the WHOLE tree (this test binary + the encoder + every
        // `decode_pipe` child), because that is the honest comparison: the old
        // path's number is everything it costs, so the new path's must be too.
        let new_out = dir.join("stress-new.mp4");
        let req = TimelineRenderRequest {
            args: localise(&st.pipe_args, dir, &new_out),
            width: st.width,
            height: st.height,
            frames: st.pipe_frames,
            segments: None,
            output: None,
        };
        let timeline = localise_timeline(&st.timeline, dir);
        let settings = ProjectSettings {
            width: Some(st.width),
            height: Some(st.height),
            fps: Some(fx.fps),
            color_space: None,
        };
        // **The baseline has to come out, or this compares the wrong things.**
        // The old path's number is one freshly-spawned `ffmpeg` and nothing
        // else. The new path runs INSIDE a process — here a `cargo test` binary
        // carrying the whole app's linked runtime (tokio, wgpu, the ONNX
        // runtime), in the real app the Tauri process itself — which is already
        // holding hundreds of MB and dozens of threads before a single frame is
        // composited. Reporting that total against a bare ffmpeg would flatter
        // the old path by exactly the size of the app, which is not a fact about
        // either export path. So: sample the host process at rest first, and
        // report the DELTA over it alongside the absolute.
        let baseline = sample_tree(std::process::id()).unwrap_or_default();
        eprintln!(
            "  (host process at rest: {:.1} MB · {} threads — subtracted below)",
            baseline.peak_rss_mb, baseline.peak_threads
        );

        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let peak = std::sync::Arc::new(std::sync::Mutex::new(Sample::default()));
        let sampler = {
            let (stop, peak) = (stop.clone(), peak.clone());
            std::thread::spawn(move || {
                let me = std::process::id();
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Some(s) = sample_tree(me) {
                        let mut g = peak.lock().unwrap_or_else(|e| e.into_inner());
                        g.peak_rss_mb = g.peak_rss_mb.max(s.peak_rss_mb);
                        g.peak_threads = g.peak_threads.max(s.peak_threads);
                        g.peak_children = g.peak_children.max(s.peak_children);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            })
        };
        let started = Instant::now();
        let outcome = render_timeline(&timeline, &settings, &req).expect("the render path");
        let new_ms = started.elapsed().as_millis();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = sampler.join();
        let new = peak.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let d_rss = new.peak_rss_mb - baseline.peak_rss_mb;
        let d_threads = new.peak_threads.saturating_sub(baseline.peak_threads);
        eprintln!(
            "compositor path   : peak RSS {:>7.1} MB · peak threads {:>5} · 1 input · {new_ms} ms \
             ({} frames)",
            new.peak_rss_mb, new.peak_threads, outcome.frames
        );
        eprintln!(
            "  ... of which the EXPORT itself: {:>7.1} MB · {:>5} threads · {} ffmpeg children at peak",
            d_rss, d_threads, new.peak_children
        );
        eprintln!(
            "\nexport-attributable  RSS {:+.0}%  ·  threads {:+.0}%  ·  wall {:+.0}%",
            (d_rss / old.peak_rss_mb - 1.0) * 100.0,
            (d_threads as f64 / old.peak_threads as f64 - 1.0) * 100.0,
            (new_ms as f64 / old_ms as f64 - 1.0) * 100.0
        );
        eprintln!(
            "(the old path's cost scales with the {} clips; the new path's ffmpeg count is bounded \
             by the VISIBLE VIDEO TRACK count plus one encoder — {} tracks here)",
            st.clips,
            st.timeline.tracks.len()
        );
    }

    #[derive(Debug, Clone, Default)]
    struct Sample {
        peak_rss_mb: f64,
        peak_threads: u64,
        /// How many processes other than the root were in the tree — for the
        /// render path this is "the encoder plus every live decode pipe", the
        /// number D-350 claims is bounded by track count rather than clip count.
        peak_children: usize,
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
    fn sample_tree(root: u32) -> Option<Sample> {
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
        let mut s = Sample {
            peak_children: tree.len().saturating_sub(1),
            ..Default::default()
        };
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

    /// Sample `child` (and its descendants) every 100 ms until it exits,
    /// returning the peak.
    fn sample_until_exit(child: &mut std::process::Child) -> Sample {
        let mut peak = Sample::default();
        loop {
            if let Some(s) = sample_tree(child.id()) {
                peak.peak_rss_mb = peak.peak_rss_mb.max(s.peak_rss_mb);
                peak.peak_threads = peak.peak_threads.max(s.peak_threads);
                peak.peak_children = peak.peak_children.max(s.peak_children);
            }
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        peak
    }

    /// **The resource claim, measured rather than asserted** (B-228/B-229/B-230
    /// were all found by watching a process, not by a test).
    ///
    /// A 40-clip timeline compiles, on the old path, to 40 decoder inputs and a
    /// 40-stage overlay chain. On the render path it compiles to ONE input,
    /// whatever the clip count — so the two numbers this checks are the two
    /// multiplications those three bugs were. This asserts the compiled shape
    /// (which is deterministic and CI-safe); the live footprint/thread numbers
    /// are in `docs/notes/export-gpu-compositor.md` §6.
    #[test]
    fn the_render_path_opens_one_input_however_many_clips_there_are() {
        let fx = load_fixture();
        let inputs = |args: &[String]| args.iter().filter(|a| a.as_str() == "-i").count();
        assert_eq!(
            inputs(&fx.pipe_args),
            1,
            "the render path must open exactly one input — the pipe"
        );
        let clips: usize = fx.timeline.tracks.iter().map(|t| t.clips.len()).sum();
        assert_eq!(
            inputs(&fx.filter_args),
            clips,
            "the old path opens one input per clip, which is the multiplication D-350 removes"
        );
    }
}
