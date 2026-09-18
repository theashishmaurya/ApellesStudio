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
use std::process::{Command, Stdio};
use std::time::Instant;

use apelles_project::manifest::ProjectSettings;
use apelles_timeline::Timeline;

use super::edit::{self, FrameIntent};
use super::export::{drain_stderr, tail};
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
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TimelineRenderOutcome {
    pub ok: bool,
    pub frames: u64,
    pub ms: u128,
    pub stderr_tail: String,
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
/// **Blocking, and deliberately synchronous** — one frame is composited, then
/// written, then the next. Backpressure is just pipe flow control, exactly as
/// `chroma::export`'s single-clip renderer has done since D-022: if the encoder
/// falls behind, `write_all` blocks and no unbounded queue of 4K frames builds
/// up in this process. That is the whole memory story of this path.
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
    let (max_long_edge, needs_resize) = canvas_plan(comp, out);

    let started = Instant::now();
    let mut child = Command::new(ffmpeg_bin())
        .args(&req.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn ffmpeg encoder: {e}"))?;
    let stderr = drain_stderr(&mut child);
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "encoder stdin unavailable".to_string())?;

    // The frame written when the timeline shows nothing at all at this
    // position — a gap under every track. Opaque black, which is exactly what
    // the compositor's own canvas starts as and what the ffmpeg path's
    // `color=black[base]` produced there.
    let blank: image::RgbaImage =
        image::ImageBuffer::from_pixel(out.0, out.1, image::Rgba([0, 0, 0, 255]));

    let mut written = 0u64;
    let mut render_err: Option<String> = None;
    for pos in 0..req.frames {
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
        if let Err(e) = stdin.write_all(frame.as_raw()) {
            render_err = Some(format!(
                "write frame {pos} to encoder: {e} — {}",
                tail(&stderr)
            ));
            break;
        }
        written += 1;
    }

    drop(stdin); // EOF → the encoder flushes and exits
    let status = child.wait().map_err(|e| format!("wait for encoder: {e}"))?;

    if let Some(e) = render_err {
        return Err(e);
    }
    if !status.success() {
        return Err(format!("encoder exited {status}: {}", tail(&stderr)));
    }
    Ok(TimelineRenderOutcome {
        ok: true,
        frames: written,
        ms: started.elapsed().as_millis(),
        stderr_tail: tail(&stderr),
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
    use std::path::{Path, PathBuf};

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
    }

    struct ParityFixture {
        comp_width: u32,
        comp_height: u32,
        fps: f64,
        source_frames: u32,
        colors: std::collections::HashMap<String, [u8; 3]>,
        sample_frames: Vec<u64>,
        timeline: Timeline,
        filter_args: Vec<String>,
        pipe_args: Vec<String>,
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
            sample_frames: Vec<u64>,
            timeline: Timeline,
            filter_args: Vec<String>,
            pipe_args: Vec<String>,
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
            sample_frames: w.sample_frames,
            timeline: w.timeline,
            filter_args: w.filter_args,
            pipe_args: w.pipe_args,
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

    /// The parity fixture's media, at the parity composition's own size.
    fn generate_media(fx: &ParityFixture, dir: &Path) -> Result<(), String> {
        for (name, rgb) in &fx.colors {
            generate_one(
                dir,
                name,
                *rgb,
                (fx.comp_width, fx.comp_height),
                fx.source_frames,
                fx.fps,
            )?;
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
            let once =
                edit::render_timeline_frame(&timeline, &settings, *n, None, FrameIntent::Single)
                    .expect("render once")
                    .expect("a visible frame");
            let twice =
                edit::render_timeline_frame(&timeline, &settings, *n, None, FrameIntent::Single)
                    .expect("render twice")
                    .expect("a visible frame");
            assert_eq!(
                once.to_rgba8().into_raw(),
                twice.to_rgba8().into_raw(),
                "frame {n} rendered two different pictures from one document"
            );
        }
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
