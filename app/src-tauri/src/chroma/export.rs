//! Video export (roadmap item 2) + a `.cube` bake of the primary grade.
//!
//! What it is: the "a colour tool must output" layer. Decode the loaded clip
//!   frame-by-frame with ffmpeg, run each frame through the *same* grade path the
//!   GUI uses (`render_core::render`, D-014), pipe the graded RGB into one
//!   persistent ffmpeg encoder → a ProRes / H.264 file.
//! What it does NOT do: audio, timeline/shot assembly, colour-managed output
//!   transforms beyond what the grade shader already bakes, GPU-accelerated
//!   decode, or a live progress bar in the canvas. Those are later layers.
//! Why one encoder child + a raw pipe (not image2pipe / per-frame files):
//!   zero temp-file churn, backpressure is just pipe flow-control, deterministic.
//!   See D-022.
//!
//! Fork hygiene (D-003): all new code, one `pub mod export;` in `chroma/mod.rs`
//! and three `generate_handler!` lines in `lib.rs`. Divergence log: docs/09.
//!
//! D-049: `chroma_export_video`/`chroma_export_progress`/`chroma_bake_lut` were
//! reachable only from the agent/MCP control surface (`useChromaControl.ts`'s
//! `export` op) — no GUI caller existed. The Colorist tab's Export dialog
//! (`app/src/components/chroma/ExportDialog.tsx`) is now the primary GUI
//! caller: it polls `chroma_export_progress` for its progress bar and passes
//! explicit `out_width`/`out_height` for its resolution field (see
//! `resolve_export_resolution`). No export-logic change beyond that param.
//!
//! D-135: the export **honours the Colorist's geometry** — crop, straighten,
//! flips, 90° steps and the perspective/lens warp. `grade_frame` runs the same
//! `adjustment_utils::apply_all_transformations` CPU pre-pass the still export
//! and the live preview run, builds its mask bitmaps against the *transformed*
//! frame with the real crop offset, and the encoder is spawned from the size
//! that pass actually produced rather than the source clip's. This replaces
//! D-127's `unsupported_geometry` refusal, which is gone.

use std::borrow::Cow;
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use image::{DynamicImage, GenericImageView, GrayImage, RgbImage};
use once_cell::sync::Lazy;
use serde_json::{json, Value};

use crate::adjustment_utils::apply_all_transformations;
use crate::gpu_processing::RenderRequest;
use crate::image_processing::{apply_geometry_warp, get_all_adjustments_from_json};
use crate::mask_generation::{generate_mask_bitmap, MaskDefinition};
use crate::render_core::{self, OwnedRenderCaches};

use super::state::{current_video, set_current_frame, set_current_video};
use super::video::{self, VideoInfo};

// --------------------------------------------------------------------------- //
// public types
// --------------------------------------------------------------------------- //

#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ExportOpts {
    /// "prores" (default) | "h264"
    #[serde(default)]
    pub codec: Option<String>,
    /// h264: overrides `-crf` (default 18). prores: overrides `-profile:v` (default 3).
    #[serde(default)]
    pub quality: Option<i64>,
    /// force the output frame rate; default = the source's exact rate.
    #[serde(default)]
    pub fps_override: Option<f64>,
    /// D-038: force the output resolution (the graded composite, rendered at
    /// clip res, is resized to this as the last step before the encoder). Both
    /// must be set and > 0 or the clip's own dimensions are used (unchanged).
    #[serde(default)]
    pub out_width: Option<u32>,
    #[serde(default)]
    pub out_height: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExportResult {
    pub out_path: String,
    pub frames: u64,
    pub ms: u128,
    pub codec: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LutBakeResult {
    pub out_path: String,
    pub size: u32,
    /// non-fatal notes — e.g. "grade had masked layers a 3D LUT can't represent".
    pub warnings: Vec<String>,
}

// --------------------------------------------------------------------------- //
// progress (module-global — there is only ever one export at a time)
// --------------------------------------------------------------------------- //

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ExportProgress {
    pub running: bool,
    pub done: u64,
    pub total: u64,
    pub out_path: Option<String>,
    pub error: Option<String>,
}

static PROGRESS: Lazy<Mutex<ExportProgress>> = Lazy::new(|| Mutex::new(ExportProgress::default()));

fn progress_reset(total: u64, out_path: &str) {
    let mut p = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    *p = ExportProgress {
        running: true,
        done: 0,
        total,
        out_path: Some(out_path.to_string()),
        error: None,
    };
}
fn progress_tick(done: u64) {
    let mut p = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    p.done = done;
}
fn progress_finish(err: Option<String>) {
    let mut p = PROGRESS.lock().unwrap_or_else(|e| e.into_inner());
    p.running = false;
    if err.is_some() {
        p.error = err;
    }
}
pub fn progress_snapshot() -> ExportProgress {
    PROGRESS.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// --------------------------------------------------------------------------- //
// ffmpeg helpers
// --------------------------------------------------------------------------- //

fn ffmpeg_bin() -> String {
    std::env::var("CHROMA_FFMPEG").unwrap_or_else(|_| "ffmpeg".to_string())
}

/// Drain a child's stderr on a thread, keeping the last ~16 KiB for error reports.
fn drain_stderr(child: &mut Child) -> std::sync::Arc<Mutex<Vec<u8>>> {
    let sink = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
    if let Some(mut err) = child.stderr.take() {
        let sink2 = sink.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match err.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut g = sink2.lock().unwrap_or_else(|e| e.into_inner());
                        g.extend_from_slice(&buf[..n]);
                        let len = g.len();
                        if len > 16_384 {
                            g.drain(0..len - 16_384);
                        }
                    }
                }
            }
        });
    }
    sink
}

fn tail(sink: &std::sync::Arc<Mutex<Vec<u8>>>) -> String {
    let g = sink.lock().unwrap_or_else(|e| e.into_inner());
    String::from_utf8_lossy(&g).chars().rev().take(1200).collect::<String>().chars().rev().collect()
}

/// Spawn the decoder for `[from, to]` as raw rgb24.
///
/// D-030: `-ss` back ~1 s + `-copyts` + `select` **by absolute timestamp `t`**
/// (not decoded-frame index `n`). D-022 walked from frame 0 with
/// `select=between(n,…)` because an input `-ss` shifts `n` and would desync the
/// per-frame tracked mattes (D-019, keyed by absolute source frame). Selecting by
/// `t` with `-copyts` keeps timestamps source-absolute — frame `from` is still
/// frame `from` — while skipping the O(from) decode from 0. `from = 0` ⇒ `-ss 0`
/// and `select` passes everything, i.e. unchanged.
fn spawn_decoder(path: &Path, info: &VideoInfo, from: u64, to: u64) -> Result<Child, String> {
    let count = to.saturating_sub(from) + 1;
    let fps = info.fps();
    // seek a second before `from` (throwaway pre-roll), select from a half-frame
    // before `from` — the margin points backward so a frame-rate rounding wobble
    // can't skip the first frame forward.
    let (seek_secs, select_t) = if fps > 0.0 {
        (((from as f64) / fps - 1.0).max(0.0), ((from as f64 - 0.5) / fps).max(0.0))
    } else {
        (0.0, 0.0)
    };
    Command::new(ffmpeg_bin())
        .args(["-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{seek_secs:.6}"))
        .args(["-copyts", "-i"])
        .arg(path)
        .args([
            "-an",
            "-sn",
            "-vf",
            &format!("select=gte(t\\,{select_t:.6})"),
            "-frames:v",
            &count.to_string(),
            "-fps_mode",
            "passthrough",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn ffmpeg decoder: {e}"))
}

/// Spawn the encoder: raw rgb24 in on stdin, codec-encoded file out.
fn spawn_encoder(
    out_path: &Path,
    w: u32,
    h: u32,
    fps: &str,
    codec: &str,
    quality: Option<i64>,
) -> Result<Child, String> {
    let mut cmd = Command::new(ffmpeg_bin());
    cmd.args(["-y", "-hide_banner", "-loglevel", "error"])
        .args(["-f", "rawvideo", "-pixel_format", "rgb24"])
        .args(["-video_size", &format!("{w}x{h}")])
        .args(["-framerate", fps])
        .args(["-i", "-"]);

    match codec {
        "h264" => {
            let crf = quality.unwrap_or(18).clamp(0, 51).to_string();
            cmd.args(["-c:v", "libx264", "-crf", &crf, "-pix_fmt", "yuv420p"]);
        }
        _ => {
            let profile = quality.unwrap_or(3).clamp(0, 5).to_string();
            cmd.args(["-c:v", "prores_ks", "-profile:v", &profile, "-pix_fmt", "yuv422p10le"]);
        }
    }

    cmd.arg(out_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn ffmpeg encoder: {e}"))
}

// --------------------------------------------------------------------------- //
// output geometry: what size the encoder is actually told to expect (D-135)
// --------------------------------------------------------------------------- //

/// Chroma-subsampling alignment for the encoder's frame size.
///
/// h.264 here is written as `yuv420p`, which subsamples 2× on **both** axes —
/// libx264 rejects an odd width or an odd height outright. ProRes here is
/// `yuv422p10le`, which subsamples 2× horizontally only, so it needs an even
/// width. We apply the stricter of the two to every codec, so the same crop
/// frames identically in a ProRes master and an h.264 review copy instead of
/// differing by a row depending on which button was pressed.
const ENCODER_DIM_ALIGN: u32 = 2;

/// The mask/relight raster scale for an export.
///
/// The live-preview path rasterises masks at *preview* resolution and passes
/// the downscale factor as `effective_scale`, with `scaled_crop_offset =
/// unscaled_crop_offset * effective_scale` (`lib.rs::process_preview_job`).
/// An export renders every frame at full resolution, so that factor is 1 and
/// the scaled offset is just the unscaled one — the same arithmetic, with the
/// scale term collapsed. Named rather than a bare `1.0` because it is the
/// thing that makes [`prepare_frame`]'s crop offset and the preview's agree.
const EXPORT_MASK_SCALE: f32 = 1.0;

/// The frame size the encoder is spawned with, and how a graded frame gets
/// there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct EncoderDims {
    width: u32,
    height: u32,
    /// `true` → the graded frame is **resampled** to `width`×`height` (the
    /// D-038 project / D-049 dialog output-resolution override). `false` →
    /// it is at most **trimmed** by the even-dimension rule, never resampled,
    /// so every kept pixel is bit-identical to what the grade produced.
    resample: bool,
}

/// Round a frame size DOWN to [`ENCODER_DIM_ALIGN`].
///
/// Down, not up. Rounding up has to invent the extra row/column — pad it with
/// black (content that isn't in the shot) or resample the whole frame to
/// stretch into it (softens every pixel to fix one edge). Rounding down drops
/// at most one row and one column of real pixels off the right/bottom edge
/// with no resampling at all. That is the rule ffmpeg users write by hand
/// (`scale=trunc(iw/2)*2:trunc(ih/2)*2`) and the one HandBrake applies through
/// its "modulus" setting, which defaults to 2.
///
/// Premiere and Resolve never hit this case: their Crop is a *filter* inside a
/// fixed sequence/timeline resolution, so the encoded size is whatever the
/// sequence says and a free-form crop rect can't change it. Chroma's Colorist
/// crop is a stills-style crop that genuinely sets the output size (D-127
/// Finding 1, and it is `react-image-crop` writing absolute pixels), so it is
/// the one place that needs a stated rounding policy.
fn align_encoder_dims(width: u32, height: u32) -> (u32, u32) {
    (
        width - width % ENCODER_DIM_ALIGN,
        height - height % ENCODER_DIM_ALIGN,
    )
}

/// Decide the encoder's frame size from what the geometry pass actually
/// produced, plus any explicit output-resolution override.
///
/// `geometry` is the size of a *graded, transformed* frame — measured, not
/// predicted (see [`export_video`]: the encoder is spawned after the first
/// frame has been through the pipeline, precisely so this can't drift from
/// `apply_all_transformations`' own arithmetic).
fn resolve_encoder_dims(
    geometry: (u32, u32),
    override_dims: (Option<u32>, Option<u32>),
) -> Result<EncoderDims, String> {
    // Same "both set and positive, or it's absent" convention as `ExportOpts`
    // and `resolve_export_resolution`.
    let (target, resample) = match override_dims {
        (Some(ow), Some(oh)) if ow > 0 && oh > 0 => ((ow, oh), true),
        _ => (geometry, false),
    };
    let (width, height) = align_encoder_dims(target.0, target.1);
    if width == 0 || height == 0 {
        return Err(format!(
            "the requested output frame is {}x{}, which rounds to {width}x{height} under the \
             even-dimension rule the encoder's pixel format requires — an encodable frame needs \
             at least {ENCODER_DIM_ALIGN}x{ENCODER_DIM_ALIGN} pixels. Widen the crop (or the \
             output resolution) and export again.",
            target.0, target.1
        ));
    }
    Ok(EncoderDims {
        width,
        height,
        resample,
    })
}

/// Bring one graded frame to the size the encoder was spawned with.
///
/// Three cases, in the order they're cheap: already the right size (the
/// overwhelmingly common one — zero copy); an explicit output-resolution
/// override (resample, D-038's existing Lanczos3 behaviour); or the ≤1px
/// even-dimension trim, which crops the right/bottom edge rather than
/// resampling so the surviving pixels are untouched.
fn fit_frame_to_encoder(graded: RgbImage, dims: EncoderDims) -> RgbImage {
    if graded.dimensions() == (dims.width, dims.height) {
        return graded;
    }
    if dims.resample {
        return image::imageops::resize(
            &graded,
            dims.width,
            dims.height,
            image::imageops::FilterType::Lanczos3,
        );
    }
    image::imageops::crop_imm(&graded, 0, 0, dims.width, dims.height).to_image()
}

/// The encoder child plus everything needed to talk to it and to report its
/// failures. Held in an `Option` by [`export_video`] because it can only be
/// spawned once the first frame's real output size is known (D-135).
struct EncoderPipe {
    child: Child,
    stderr: Arc<Mutex<Vec<u8>>>,
    stdin: ChildStdin,
    dims: EncoderDims,
}

// --------------------------------------------------------------------------- //
// per-frame grade (the still export path, wrapped in a video loop)
// --------------------------------------------------------------------------- //

/// The CPU pre-pass one export frame goes through before the GPU grade:
/// `adjustment_utils::apply_all_transformations` (perspective/lens warp → lens
/// blur → 90° steps → flips → straighten → crop) plus the mask bitmaps, built
/// against the **transformed** frame and offset by the real crop origin.
///
/// This is the fix at the centre of D-135. Before it, [`grade_frame`] ran no
/// geometry pass at all and rasterised its masks at full frame size with a
/// hardcoded `(0.0, 0.0)` crop offset, while the live-preview path
/// (`lib.rs::process_preview_job`) passed a real `scaled_crop_offset` — so the
/// two disagreed about where a mask sits the moment a crop existed, on top of
/// the export dropping the crop itself (B-042). The shape here is deliberately
/// the same as the still path's (`lib.rs::generate_preview_for_path`):
/// transform, measure the transformed size, rasterise the masks at that size
/// with that offset.
///
/// Split out of [`grade_frame`] so the geometry and the mask alignment — the
/// two halves B-042 got wrong — are unit-testable on real pixels without a GPU
/// adapter.
///
/// Returns the transformed frame (borrowed, zero-copy, when every geometry
/// control is at identity), its mask bitmaps, and the unscaled crop offset the
/// relight resolvers in [`grade_frame`] need to reuse.
fn prepare_frame<'a>(
    frame: &'a DynamicImage,
    js: &Value,
) -> (Cow<'a, DynamicImage>, Vec<GrayImage>, (f32, f32)) {
    let (transformed, crop_offset) = apply_all_transformations(Cow::Borrowed(frame), js);
    let (tw, th) = transformed.dimensions();

    let mask_defs: Vec<MaskDefinition> = js
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    // Parametric `color` / `luminance` masks sample the *warped* (pre-crop,
    // pre-rotation) picture to decide what's in the mask. The GUI reads that
    // out of `AppState`'s `full_warped_cache` via
    // `resolve_warped_image_for_masks`, which an export has no `tauri::State`
    // to reach — which is why `grade_frame` used to pass `None` and document
    // those mask types as skipped on video export. But the source frame is
    // right here, and `apply_geometry_warp` is a plain borrow when the
    // lens/perspective params are identity, so we can just build it, only for
    // grades that actually contain such a mask. That v1 limitation is gone.
    let warped = mask_defs
        .iter()
        .any(MaskDefinition::requires_warped_image)
        .then(|| apply_geometry_warp(frame, js));

    let bitmaps = mask_defs
        .iter()
        .filter_map(|def| {
            generate_mask_bitmap(
                def,
                tw,
                th,
                EXPORT_MASK_SCALE,
                crop_offset,
                warped.as_deref(),
            )
        })
        .collect();

    (transformed, bitmaps, crop_offset)
}

/// Render one decoded RGB frame through the geometry pre-pass and the grade.
/// Mirrors RapidRAW's `generate_preview_for_path` (transform → mask bitmaps →
/// `AllAdjustments` → `RenderRequest` → render) but the base image is a video
/// frame we already hold, so there is no file decode / `load_and_composite`.
///
/// The returned frame is at the **transformed** size, which a crop or a 90°
/// step makes different from the source clip's — [`export_video`] measures it
/// and spawns the encoder from it (D-135).
fn grade_frame(
    ctx: &crate::image_processing::GpuContext,
    caches: &OwnedRenderCaches,
    frame: DynamicImage,
    frame_index: u64,
    js: &Value,
) -> Result<RgbImage, String> {
    let (transformed, mut mask_bitmaps, crop_offset) = prepare_frame(&frame, js);
    let (w, h) = transformed.dimensions();

    let mut adjustments = get_all_adjustments_from_json(js, false, None);
    // Interactive relight follow-up (D-054): D-048 deliberately left every
    // `mask_bitmaps` build site OTHER than the live-preview path
    // (`process_preview_job` in `lib.rs`) at `relight_depth_layer == -1`, so a
    // positional light rendered in the GUI went inert on a real export —
    // only `apply_relight`'s ambient term (no depth needed) survived. Wire
    // the same resolver the preview path uses in here too, so an export
    // matches what the user actually saw. `resolve_relight_depth_bitmap`
    // prefers a tracked depth dir (per-frame, keyed off
    // `chroma::state::current_video().frame`, which `set_current_frame` above
    // the `grade_frame` call already points at this exact frame) and falls
    // back to a static single-frame bake when no track exists.
    if adjustments.relight_light_count > 0
        && let Some(depth_bitmap) = crate::mask_generation::resolve_relight_depth_bitmap(
            js,
            w,
            h,
            EXPORT_MASK_SCALE,
            crop_offset,
        )
    {
        adjustments.relight_depth_layer = mask_bitmaps.len() as i32;
        mask_bitmaps.push(depth_bitmap);
    }
    // D-077 follow-up, same reasoning as the depth wiring just above: an
    // export must get the real baked normal too, not silently degrade to the
    // depth-derived approximation just because it's a different code path
    // from live preview.
    if adjustments.relight_light_count > 0
        && let Some(normal_bitmaps) = crate::mask_generation::resolve_relight_normal_bitmap(
            js,
            w,
            h,
            EXPORT_MASK_SCALE,
            crop_offset,
        )
    {
        adjustments.relight_normal_layer = mask_bitmaps.len() as i32;
        mask_bitmaps.extend(normal_bitmaps);
    }
    let lut = js
        .get("lutPath")
        .and_then(|p| p.as_str())
        .and_then(|p| crate::lut_processing::parse_lut_file(p).ok())
        .map(std::sync::Arc::new);

    // transform_hash keys the GPU input-texture cache — it MUST change per frame
    // or frame N is graded through frame N-1's pixels.
    let graded = render_core::render(
        ctx,
        caches.as_ref(),
        transformed.as_ref(),
        frame_index.wrapping_add(1),
        RenderRequest { adjustments, mask_bitmaps: &mask_bitmaps, lut, roi: None },
        "export",
        false,
        None,
    )?;

    Ok(graded.to_rgb8())
}

// --------------------------------------------------------------------------- //
// export_video
// --------------------------------------------------------------------------- //

/// Render `[from_frame, to_frame]` of the clip at `video_path` through
/// `js_adjustments` and encode to `out_path`. Blocking (ffmpeg + GPU) — call it
/// off the async runtime (the Tauri command wraps it in `spawn_blocking`).
///
/// D-135: the encoded frame size is the size the Colorist's geometry actually
/// produces, not the source clip's — a crop or a 90° step changes it. The
/// encoder is therefore spawned lazily, on the first graded frame, so the size
/// ffmpeg is told is measured from the real pipeline rather than predicted by a
/// second copy of `apply_all_transformations`' arithmetic that could drift from
/// it.
pub fn export_video(
    video_path: &Path,
    out_path: &Path,
    js_adjustments: &Value,
    from_frame: u64,
    to_frame: u64,
    opts: ExportOpts,
) -> Result<ExportResult, String> {
    let started = Instant::now();
    let info: VideoInfo = video::probe(video_path).map_err(|e| e.to_string())?;
    let (w, h) = (info.resolution.width, info.resolution.height);
    if w == 0 || h == 0 {
        return Err("probe returned zero dimensions".into());
    }

    let last = info.frame_count.saturating_sub(1);
    let from = from_frame.min(last);
    let to = to_frame.min(last).max(from);
    let total = to - from + 1;

    // D-135: the encoder's frame size is no longer knowable here. The
    // Colorist's crop / 90° steps change it, and the only non-drifting way to
    // learn what `apply_all_transformations` produces is to run it — so the
    // encoder is spawned from the *first graded frame's* measured size, inside
    // the loop below (`resolve_encoder_dims`). Before D-135 this was computed
    // up front from the source clip's `(w, h)` plus the D-038/D-049 override,
    // which is exactly why a crop could never reach the file.
    let override_dims = (opts.out_width, opts.out_height);

    let codec = match opts.codec.as_deref() {
        Some("h264") => "h264",
        _ => "prores",
    };
    let fps_str = match opts.fps_override {
        Some(f) if f > 0.0 => format!("{f}"),
        // D-053: `chroma_types::Rational`'s `Display` is exactly this
        // `"{num}/{den}"` ffmpeg-arg form — was a bare `format!` before.
        _ if info.fps_den != 0 && info.fps_num != 0 => {
            chroma_types::Rational::new(info.fps_num as i64, info.fps_den as i64).to_string()
        }
        _ => "24".to_string(),
    };

    // Free the persistent playback decode pipe (D-030) for the duration of the
    // export — one fewer idle ffmpeg holding a read fd on the same clip.
    super::decode_pipe::reset();

    // The grade path fetches tracked mattes for `current_video().frame` (D-019).
    // Point Chroma's clip state at the export target, restore it afterwards.
    let prev = current_video();
    set_current_video(Some(super::state::CurrentVideo {
        path: video_path.to_path_buf(),
        info: info.clone(),
        frame: from,
    }));
    let restore = |prev: Option<super::state::CurrentVideo>| {
        if let Some(p) = prev {
            set_current_video(Some(p));
        }
    };

    progress_reset(total, &out_path.to_string_lossy());

    let run = || -> Result<u64, String> {
        let ctx = render_core::init_gpu_context()?;
        let caches = OwnedRenderCaches::default();

        let mut dec = spawn_decoder(video_path, &info, from, to)?;
        let dec_err = drain_stderr(&mut dec);
        let mut dec_out = BufReader::new(dec.stdout.take().ok_or("decoder stdout unavailable")?);

        let frame_bytes = (w as usize) * (h as usize) * 3;
        let mut buf = vec![0u8; frame_bytes];
        let mut done: u64 = 0;

        // D-135: spawned on the first graded frame, once its real (post-
        // geometry) size is known. `geometry` remembers that size so a later
        // frame that somehow transforms differently is caught rather than
        // silently letter-boxed by the encoder.
        let mut enc: Option<EncoderPipe> = None;
        let mut geometry: (u32, u32) = (0, 0);

        for i in 0..total {
            match dec_out.read_exact(&mut buf) {
                Ok(()) => {}
                Err(e) => {
                    return Err(format!(
                        "decoder ended early at frame {}/{} ({e}): {}",
                        done,
                        total,
                        tail(&dec_err)
                    ));
                }
            }
            let frame_index = from + i;
            set_current_frame(frame_index);

            let src = RgbImage::from_raw(w, h, buf.clone())
                .ok_or("rgb frame buffer size mismatch")?;
            let graded = grade_frame(
                &ctx,
                &caches,
                DynamicImage::ImageRgb8(src),
                frame_index,
                js_adjustments,
            )?;
            let (gw, gh) = graded.dimensions();

            if enc.is_none() {
                geometry = (gw, gh);
                let dims = resolve_encoder_dims(geometry, override_dims)?;
                let mut child = spawn_encoder(
                    out_path,
                    dims.width,
                    dims.height,
                    &fps_str,
                    codec,
                    opts.quality,
                )?;
                let stderr = drain_stderr(&mut child);
                let stdin = child.stdin.take().ok_or("encoder stdin unavailable")?;
                enc = Some(EncoderPipe { child, stderr, stdin, dims });
            } else if (gw, gh) != geometry {
                // A grade's geometry is frame-independent by construction
                // (`apply_all_transformations` reads only `adjustments`), so
                // this can't happen from a user setting — it would mean the
                // transform or the render resized mid-stream, and the encoder
                // has already been told one fixed size. Fail rather than ship a
                // file whose frames are silently misaligned.
                return Err(format!(
                    "graded frame {frame_index} is {gw}x{gh}, but frame {from} was {}x{} — the \
                     geometry pass must produce the same size for every frame of one export",
                    geometry.0, geometry.1
                ));
            }
            let pipe = enc.as_mut().ok_or("encoder pipe unavailable")?;

            let raw = fit_frame_to_encoder(graded, pipe.dims).into_raw();
            pipe.stdin
                .write_all(&raw)
                .map_err(|e| format!("write to encoder stdin: {e} — {}", tail(&pipe.stderr)))?;

            done += 1;
            progress_tick(done);
        }

        let _ = dec.wait();

        // `total` is always >= 1 (`to = to.max(from)`), so the encoder exists
        // unless the loop returned early — but a `?` on an empty range is
        // still better than an `unwrap`.
        let EncoderPipe { mut child, stderr, stdin, .. } =
            enc.ok_or("no frames were graded, so no encoder was ever spawned")?;
        drop(stdin); // EOF → encoder flushes and exits

        let status = child.wait().map_err(|e| format!("wait for encoder: {e}"))?;
        if !status.success() {
            return Err(format!("encoder exited {status}: {}", tail(&stderr)));
        }
        Ok(done)
    };

    let result = run();
    restore(prev);

    match result {
        Ok(frames) => {
            progress_finish(None);
            Ok(ExportResult {
                out_path: out_path.to_string_lossy().to_string(),
                frames,
                ms: started.elapsed().as_millis(),
                codec: codec.to_string(),
            })
        }
        Err(e) => {
            progress_finish(Some(e.clone()));
            Err(e)
        }
    }
}

// --------------------------------------------------------------------------- //
// .cube bake — primary grade only
// --------------------------------------------------------------------------- //

/// Run a `size³` identity RGB lattice through the **primary grade only** (no
/// masks, no LUT-on-LUT, no geometry) and write it as a `.cube` 3D LUT.
pub fn bake_primary_lut(
    js_adjustments: &Value,
    size: u32,
    out_path: &Path,
) -> Result<LutBakeResult, String> {
    let size = size.clamp(2, 64);
    let n = size as usize;

    // strip everything a 3D LUT can't carry
    let mut primary = js_adjustments.clone();
    let mut warnings = Vec::new();
    if let Some(masks) = primary.get("masks").and_then(|m| m.as_array()) {
        let visible = masks
            .iter()
            .filter(|m| m.get("visible").and_then(|v| v.as_bool()).unwrap_or(true))
            .count();
        if visible > 0 {
            warnings.push(format!(
                "grade has {visible} masked/local layer(s); a 3D LUT is global-only — baked the primary grade, dropped the masks"
            ));
        }
    }
    if primary.get("lutPath").and_then(|p| p.as_str()).is_some() {
        warnings.push("grade already applies a .cube LUT; it was NOT chained into this bake (no LUT-on-LUT)".into());
    }
    for k in ["masks", "lutPath", "crop"] {
        if let Some(obj) = primary.as_object_mut() {
            obj.remove(k);
        }
    }
    if let Some(obj) = primary.as_object_mut() {
        obj.insert("rotation".into(), json!(0.0));
        obj.insert("flipHorizontal".into(), json!(false));
        obj.insert("flipVertical".into(), json!(false));
        obj.insert("orientationSteps".into(), json!(0));
    }

    // identity lattice: x = r, y = b*size + g, value = channel / (size-1)
    let w = size;
    let hgt = size * size;
    let denom = (size - 1).max(1) as f32;
    let mut grid = RgbImage::new(w, hgt);
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let px = image::Rgb([
                    (r as f32 / denom * 255.0).round().clamp(0.0, 255.0) as u8,
                    (g as f32 / denom * 255.0).round().clamp(0.0, 255.0) as u8,
                    (b as f32 / denom * 255.0).round().clamp(0.0, 255.0) as u8,
                ]);
                grid.put_pixel(r as u32, (b * n + g) as u32, px);
            }
        }
    }

    let ctx = render_core::init_gpu_context()?;
    let caches = OwnedRenderCaches::default();
    let adjustments = get_all_adjustments_from_json(&primary, false, None);
    let graded = render_core::render(
        &ctx,
        caches.as_ref(),
        &DynamicImage::ImageRgb8(grid),
        0,
        RenderRequest { adjustments, mask_bitmaps: &[], lut: None, roi: None },
        "bake_lut",
        false,
        None,
    )?;
    let graded = graded.to_rgb8();

    let mut out = String::with_capacity(n * n * n * 24 + 128);
    out.push_str("TITLE \"Chroma primary grade\"\n");
    out.push_str(&format!("LUT_3D_SIZE {size}\n"));
    out.push_str("DOMAIN_MIN 0.0 0.0 0.0\n");
    out.push_str("DOMAIN_MAX 1.0 1.0 1.0\n");
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let p = graded.get_pixel(r as u32, (b * n + g) as u32);
                out.push_str(&format!(
                    "{:.6} {:.6} {:.6}\n",
                    p[0] as f32 / 255.0,
                    p[1] as f32 / 255.0,
                    p[2] as f32 / 255.0
                ));
            }
        }
    }

    std::fs::write(out_path, out).map_err(|e| format!("write {}: {e}", out_path.display()))?;
    Ok(LutBakeResult {
        out_path: out_path.to_string_lossy().to_string(),
        size,
        warnings,
    })
}

// --------------------------------------------------------------------------- //
// Tauri commands (kept here so lib.rs only gains generate_handler! lines)
// --------------------------------------------------------------------------- //

fn default_out_path(kind: &str) -> Result<PathBuf, String> {
    let cv = current_video().ok_or("no video loaded")?;
    let dir = cv.path.parent().ok_or("clip has no parent dir")?;
    let stem = cv.path.file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    let name = match kind {
        "cube" => format!("{stem}.graded.cube"),
        "h264" => format!("{stem}.graded.mp4"),
        _ => format!("{stem}.graded.mov"),
    };
    Ok(dir.join(name))
}

/// D-049: resolve the export's output resolution. An explicit pair from the
/// caller (the Export dialog's "Custom" resolution field) wins outright; else
/// the D-038 project spec; else `(None, None)` — `export_video`'s own
/// clip-derived default. A partial explicit pair (only one of width/height,
/// or a non-positive value) is treated as absent, same convention as
/// `ExportOpts`/`export_video`'s own `(Some(ow), Some(oh)) if ow > 0 && oh > 0`
/// guard.
fn resolve_export_resolution(
    explicit: (Option<u32>, Option<u32>),
    project: (Option<u32>, Option<u32>),
) -> (Option<u32>, Option<u32>) {
    match explicit {
        (Some(w), Some(h)) if w > 0 && h > 0 => (Some(w), Some(h)),
        _ => project,
    }
}

/// Start a background export of the loaded clip. Returns immediately with the
/// frame total; poll [`chroma_export_progress`]. `js_adjustments` is the live
/// grade doc from the frontend store. `out_width`/`out_height` (D-049, the
/// Export dialog's resolution field) override the D-038 project spec, which
/// in turn overrides the clip's own dimensions — see
/// [`resolve_export_resolution`].
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn chroma_export_video(
    out_path: Option<String>,
    from_frame: Option<u64>,
    to_frame: Option<u64>,
    codec: Option<String>,
    quality: Option<i64>,
    fps_override: Option<f64>,
    out_width: Option<u32>,
    out_height: Option<u32>,
    js_adjustments: Value,
) -> Result<Value, String> {
    let cv = current_video().ok_or("no video loaded")?;
    {
        let p = progress_snapshot();
        if p.running {
            return Err(format!("an export is already running ({}/{})", p.done, p.total));
        }
    }

    let kind = codec.clone().unwrap_or_else(|| "prores".to_string());
    let out = match out_path {
        Some(p) => PathBuf::from(p),
        None => default_out_path(&kind)?,
    };

    let last = cv.info.frame_count.saturating_sub(1);
    let from = from_frame.unwrap_or(0).min(last);
    let to = to_frame.unwrap_or(last).min(last).max(from);

    // D-038: a loaded project's output spec (resolution + timebase) overrides
    // the clip-derived output. Absent settings ⇒ every field stays `None` ⇒
    // the export is unchanged. An explicit `fps_override` arg (the export
    // dialog) still wins over the project's fps; D-049 adds the same explicit-
    // wins-over-project precedence for resolution.
    let proj = super::state::current_project()
        .and_then(|p| super::project::load_manifest(&p.path).ok())
        .map(|m| m.settings)
        .unwrap_or_default();

    let (resolved_w, resolved_h) =
        resolve_export_resolution((out_width, out_height), (proj.width, proj.height));

    let opts = ExportOpts {
        codec,
        quality,
        fps_override: fps_override.or(proj.fps),
        out_width: resolved_w,
        out_height: resolved_h,
    };
    let video_path = cv.path.clone();
    let out_str = out.to_string_lossy().to_string();

    progress_reset(to - from + 1, &out_str);

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = export_video(&video_path, &out, &js_adjustments, from, to, opts) {
            log::error!("[chroma::export] {e}");
        }
    });

    Ok(json!({ "started": true, "out_path": out_str, "from": from, "to": to, "total": to - from + 1 }))
}

/// Poll the running / last export.
#[tauri::command]
pub fn chroma_export_progress() -> ExportProgress {
    progress_snapshot()
}

/// Bake the primary grade to a `.cube` file. Synchronous (a 33³ lattice renders
/// in well under a second).
#[tauri::command]
pub async fn chroma_bake_lut(
    out_path: Option<String>,
    size: Option<u32>,
    js_adjustments: Value,
) -> Result<LutBakeResult, String> {
    let out = match out_path {
        Some(p) => PathBuf::from(p),
        None => default_out_path("cube")?,
    };
    let size = size.unwrap_or(33);
    tauri::async_runtime::spawn_blocking(move || bake_primary_lut(&js_adjustments, size, &out))
        .await
        .map_err(|e| e.to_string())?
}

// --------------------------------------------------------------------------- //
// tests
// --------------------------------------------------------------------------- //

#[cfg(test)]
mod tests {
    use super::*;

    // D-049: explicit dialog resolution > project spec > clip-derived (None).
    #[test]
    fn resolve_export_resolution_explicit_wins() {
        assert_eq!(
            resolve_export_resolution((Some(1280), Some(720)), (Some(3840), Some(2160))),
            (Some(1280), Some(720))
        );
    }

    #[test]
    fn resolve_export_resolution_falls_back_to_project() {
        assert_eq!(
            resolve_export_resolution((None, None), (Some(3840), Some(2160))),
            (Some(3840), Some(2160))
        );
    }

    #[test]
    fn resolve_export_resolution_falls_back_to_clip_derived_when_neither_set() {
        assert_eq!(
            resolve_export_resolution((None, None), (None, None)),
            (None, None)
        );
    }

    #[test]
    fn resolve_export_resolution_ignores_partial_or_zero_explicit() {
        // only one dimension set, or a zero — treated as absent, not a crash/half-apply.
        assert_eq!(
            resolve_export_resolution((Some(1280), None), (Some(3840), Some(2160))),
            (Some(3840), Some(2160))
        );
        assert_eq!(
            resolve_export_resolution((Some(0), Some(720)), (Some(3840), Some(2160))),
            (Some(3840), Some(2160))
        );
    }

    // --- D-135 / B-042: the geometry pass is really in the export path -----
    //
    // These run on real `RgbImage`/`GrayImage` pixels with asserted values, no
    // GPU adapter and no fixture video: `prepare_frame` is deliberately split
    // out of `grade_frame` so the two halves B-042 got wrong — the geometry
    // itself, and the mask crop offset — are testable without one.

    /// An 8×8 frame whose every pixel encodes its own coordinates in R and G
    /// (`R = x * 16`, `G = y * 16`), so any assertion about *which* source
    /// pixel ended up where is exact rather than "it looks cropped".
    fn coordinate_frame(w: u32, h: u32) -> DynamicImage {
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x * 16) as u8, (y * 16) as u8, 0])
        }))
    }

    fn at(img: &DynamicImage, x: u32, y: u32) -> (u8, u8) {
        let p = img.to_rgb8();
        let px = p.get_pixel(x, y);
        (px[0], px[1])
    }

    /// A base64 PNG data URL for a full-frame matte that is white inside
    /// `rect` and black elsewhere — the shape `chromaTrackDir`-less AI masks
    /// (and, at the same resolution, D-019's tracked mattes) are read from.
    fn matte_data_url(w: u32, h: u32, rect: (u32, u32, u32, u32)) -> String {
        use base64::{Engine as _, engine::general_purpose};
        use image::{ImageFormat, Luma};
        use std::io::Cursor;

        let (rx, ry, rw, rh) = rect;
        let matte = GrayImage::from_fn(w, h, |x, y| {
            let inside = x >= rx && x < rx + rw && y >= ry && y < ry + rh;
            Luma([if inside { 255 } else { 0 }])
        });
        let mut buf = Cursor::new(Vec::new());
        matte.write_to(&mut buf, ImageFormat::Png).unwrap();
        format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(buf.get_ref())
        )
    }

    /// An `ai-subject` mask carrying a full-frame matte. This is the same
    /// `generate_ai_bitmap_from_full_mask` alignment path a **tracked** matte
    /// (D-019, `params.chromaTrackDir`) takes — `generate_ai_subject_bitmap`
    /// picks the tracked PNG over the base64 and hands both to that one
    /// function with the same `TransformParams` — but it needs no
    /// `chroma::state::current_video()`, so it doesn't race the end-to-end
    /// export tests over that global.
    fn subject_mask_grade(data_url: &str, crop: Option<Value>) -> Value {
        let mut js = json!({
            "masks": [{
                "id": "m1", "name": "subject", "visible": true, "invert": false,
                "opacity": 100.0, "adjustments": { "exposure": 1.0 },
                "subMasks": [{
                    "id": "s1", "type": "ai-subject", "visible": true,
                    "mode": "additive", "invert": false, "opacity": 100.0,
                    "parameters": {
                        "startX": 0.0, "startY": 0.0, "endX": 8.0, "endY": 8.0,
                        "maskDataBase64": data_url
                    }
                }]
            }]
        });
        if let Some(c) = crop {
            js["crop"] = c;
        }
        js
    }

    /// A grade with no geometry must not copy a single pixel — the transformed
    /// frame is still a borrow of the decoded one, and the offset is zero.
    #[test]
    fn prepare_frame_is_zero_copy_and_offset_free_without_geometry() {
        let frame = coordinate_frame(8, 8);
        let (transformed, masks, offset) = prepare_frame(&frame, &json!({ "exposure": 1.0 }));

        assert!(
            matches!(transformed, Cow::Borrowed(_)),
            "an ungeometried export frame must not be cloned"
        );
        assert_eq!(transformed.dimensions(), (8, 8));
        assert_eq!(offset, (0.0, 0.0));
        assert!(masks.is_empty());
    }

    /// A full-frame crop rect — which the Crop panel writes the moment it is
    /// opened — is not a crop, and must stay zero-copy (D-127 made a point of
    /// this for the refusal; it matters just as much now that the pass runs).
    #[test]
    fn prepare_frame_treats_a_full_frame_crop_rect_as_no_crop() {
        let frame = coordinate_frame(8, 8);
        let js = json!({ "crop": { "x": 0.0, "y": 0.0, "width": 8.0, "height": 8.0 } });
        let (transformed, _, offset) = prepare_frame(&frame, &js);

        assert!(matches!(transformed, Cow::Borrowed(_)));
        assert_eq!(transformed.dimensions(), (8, 8));
        assert_eq!(offset, (0.0, 0.0));
    }

    /// The core of B-042: a real crop changes the export frame's size AND
    /// picks the right pixels out of the source.
    #[test]
    fn prepare_frame_really_crops() {
        let frame = coordinate_frame(8, 8);
        let js = json!({ "crop": { "x": 2.0, "y": 1.0, "width": 4.0, "height": 3.0 } });
        let (transformed, _, offset) = prepare_frame(&frame, &js);

        assert_eq!(transformed.dimensions(), (4, 3));
        assert_eq!(offset, (2.0, 1.0));
        // top-left of the cropped frame is source (2, 1); bottom-right is (5, 3)
        assert_eq!(at(&transformed, 0, 0), (2 * 16, 16));
        assert_eq!(at(&transformed, 3, 2), (5 * 16, 3 * 16));
    }

    #[test]
    fn prepare_frame_really_flips_and_rotates_by_90() {
        let frame = coordinate_frame(8, 8);

        let flipped = prepare_frame(&frame, &json!({ "flipHorizontal": true })).0;
        assert_eq!(flipped.dimensions(), (8, 8));
        assert_eq!(at(&flipped, 0, 0), (7 * 16, 0));

        let flipped_v = prepare_frame(&frame, &json!({ "flipVertical": true })).0;
        assert_eq!(at(&flipped_v, 0, 0), (0, 7 * 16));

        // A 90° step on a non-square frame swaps the encoded dimensions — the
        // single most obvious way the old "spawn the encoder with the clip's
        // own size" code shipped a wrong file.
        let wide = coordinate_frame(8, 4);
        let turned = prepare_frame(&wide, &json!({ "orientationSteps": 1 })).0;
        assert_eq!(turned.dimensions(), (4, 8));
        // rotate90 sends source (0, h-1) to output (0, 0)
        assert_eq!(at(&turned, 0, 0), (0, 3 * 16));

        // A whole revolution is the same upright image, and stays zero-copy.
        let full_turn = prepare_frame(&wide, &json!({ "orientationSteps": 4 })).0;
        assert!(matches!(full_turn, Cow::Borrowed(_)));
        assert_eq!(full_turn.dimensions(), (8, 4));
    }

    /// Straighten keeps the frame size (`imageproc::rotate_about_center` fills
    /// the same canvas) and rotates the content, leaving transparent corners —
    /// which is why the Crop panel auto-writes a centred crop alongside it.
    #[test]
    fn prepare_frame_really_straightens() {
        let white = DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 16, image::Rgb([255; 3])));
        let straightened = prepare_frame(&white, &json!({ "rotation": 20.0 })).0;

        assert_eq!(straightened.dimensions(), (16, 16));
        // centre survives, the corner is rotated out of frame (border is
        // transparent black, so `to_rgb8` reads 0)
        assert_eq!(at(&straightened, 8, 8), (255, 255));
        assert_eq!(at(&straightened, 0, 0), (0, 0));
    }

    /// Piece 2 + piece 3 of roadmap item 15, together: the mask bitmap is
    /// rasterised at the *cropped* size and shifted by the *real* crop offset,
    /// so a matte baked at the un-cropped resolution (D-019's documented
    /// assumption, which tracked mattes still satisfy) lands on the right
    /// pixels. The `(0.0, 0.0)` the export used to hardcode is asserted here
    /// to be a genuinely different, wrong answer — not a harmless default.
    #[test]
    fn mask_bitmaps_follow_the_crop_offset() {
        let frame = coordinate_frame(8, 8);
        // white matte square at source (4..6, 2..4)
        let url = matte_data_url(8, 8, (4, 2, 2, 2));
        let js = subject_mask_grade(
            &url,
            Some(json!({ "x": 3.0, "y": 1.0, "width": 4.0, "height": 4.0 })),
        );

        let (transformed, masks, offset) = prepare_frame(&frame, &js);
        assert_eq!(transformed.dimensions(), (4, 4));
        assert_eq!(offset, (3.0, 1.0));
        assert_eq!(masks.len(), 1);

        let m = &masks[0];
        assert_eq!(m.dimensions(), (4, 4));
        // source (4,2) → cropped (1,1); source (5,3) → cropped (2,2)
        assert_eq!(m.get_pixel(1, 1)[0], 255);
        assert_eq!(m.get_pixel(2, 2)[0], 255);
        // just outside the square
        assert_eq!(m.get_pixel(0, 0)[0], 0);
        assert_eq!(m.get_pixel(3, 3)[0], 0);

        // What the export did before D-135: same mask definition, same output
        // size, but the hardcoded zero offset. It puts the subject two pixels
        // up and three across from where the picture actually has it.
        let defs: Vec<MaskDefinition> =
            serde_json::from_value(js["masks"].clone()).expect("mask defs");
        let wrong = generate_mask_bitmap(&defs[0], 4, 4, EXPORT_MASK_SCALE, (0.0, 0.0), None)
            .expect("bitmap");
        assert_ne!(
            wrong.as_raw(),
            m.as_raw(),
            "a (0,0) crop offset must produce a visibly different mask — if it doesn't, \
             this test isn't proving anything"
        );
        assert_eq!(wrong.get_pixel(1, 1)[0], 0);
    }

    /// Without a crop, the mask path is unchanged from before D-135 — the same
    /// bitmap, at the same size, with the same (zero) offset.
    #[test]
    fn mask_bitmaps_are_unchanged_without_a_crop() {
        let frame = coordinate_frame(8, 8);
        let url = matte_data_url(8, 8, (4, 2, 2, 2));
        let js = subject_mask_grade(&url, None);

        let (_, masks, offset) = prepare_frame(&frame, &js);
        assert_eq!(offset, (0.0, 0.0));
        let defs: Vec<MaskDefinition> =
            serde_json::from_value(js["masks"].clone()).expect("mask defs");
        let reference = generate_mask_bitmap(&defs[0], 8, 8, EXPORT_MASK_SCALE, (0.0, 0.0), None)
            .expect("bitmap");
        assert_eq!(masks[0].as_raw(), reference.as_raw());
        assert_eq!(masks[0].get_pixel(4, 2)[0], 255);
    }

    // --- D-135: the encoder's frame size ------------------------------------

    #[test]
    fn align_encoder_dims_rounds_down_to_even() {
        assert_eq!(align_encoder_dims(1920, 1080), (1920, 1080));
        assert_eq!(align_encoder_dims(1281, 721), (1280, 720));
        assert_eq!(align_encoder_dims(1, 1), (0, 0));
    }

    #[test]
    fn resolve_encoder_dims_uses_the_measured_geometry_size() {
        // no override: the geometry's own size, evened down
        assert_eq!(
            resolve_encoder_dims((1280, 720), (None, None)).unwrap(),
            EncoderDims { width: 1280, height: 720, resample: false }
        );
        assert_eq!(
            resolve_encoder_dims((1281, 721), (None, None)).unwrap(),
            EncoderDims { width: 1280, height: 720, resample: false }
        );
    }

    #[test]
    fn resolve_encoder_dims_honours_and_evens_an_override() {
        assert_eq!(
            resolve_encoder_dims((1920, 1080), (Some(1280), Some(720))).unwrap(),
            EncoderDims { width: 1280, height: 720, resample: true }
        );
        // D-049 let an odd custom resolution through to libx264, which rejects
        // it outright — the same rule fixes that on the way past.
        assert_eq!(
            resolve_encoder_dims((1920, 1080), (Some(1281), Some(721))).unwrap(),
            EncoderDims { width: 1280, height: 720, resample: true }
        );
        // a partial / non-positive override is absent, same as `ExportOpts`
        assert_eq!(
            resolve_encoder_dims((1920, 1080), (Some(1280), None)).unwrap(),
            EncoderDims { width: 1920, height: 1080, resample: false }
        );
    }

    /// The one geometry case that still can't be encoded, and says so.
    #[test]
    fn resolve_encoder_dims_refuses_a_sub_pixel_crop() {
        let err = resolve_encoder_dims((1, 400), (None, None)).unwrap_err();
        assert!(err.contains("1x400"), "{err}");
        assert!(err.contains("even-dimension rule"), "{err}");
    }

    /// The even trim is a crop, not a resample: the kept pixels come through
    /// bit-identical and only the odd row/column is dropped.
    #[test]
    fn fit_frame_to_encoder_trims_rather_than_resampling() {
        let graded =
            RgbImage::from_fn(5, 3, |x, y| image::Rgb([(x * 16) as u8, (y * 16) as u8, 0]));
        let dims = resolve_encoder_dims((5, 3), (None, None)).unwrap();
        assert_eq!((dims.width, dims.height), (4, 2));

        let fitted = fit_frame_to_encoder(graded, dims);
        assert_eq!(fitted.dimensions(), (4, 2));
        assert_eq!(fitted.get_pixel(0, 0).0, [0, 0, 0]);
        assert_eq!(fitted.get_pixel(3, 1).0, [3 * 16, 16, 0]);
    }

    #[test]
    fn fit_frame_to_encoder_resamples_only_for_an_override() {
        let graded = RgbImage::from_pixel(8, 8, image::Rgb([200, 100, 50]));
        let dims = resolve_encoder_dims((8, 8), (Some(4), Some(4))).unwrap();
        let fitted = fit_frame_to_encoder(graded.clone(), dims);
        assert_eq!(fitted.dimensions(), (4, 4));

        // and an already-correct frame is handed straight back
        let same = resolve_encoder_dims((8, 8), (None, None)).unwrap();
        assert_eq!(
            fit_frame_to_encoder(graded.clone(), same).into_raw(),
            graded.into_raw()
        );
    }

    fn test_video() -> Option<PathBuf> {
        std::env::var("CHROMA_TEST_VIDEO").ok().map(PathBuf::from).filter(|p| p.exists())
    }

    /// Synthesise a tiny high-contrast clip with ffmpeg, so the end-to-end
    /// encode tests below prove something on any machine instead of quietly
    /// skipping unless `CHROMA_TEST_VIDEO` happens to be set. `testsrc` is
    /// chosen for the contrast: a mis-placed crop can't average out against it.
    fn synth_clip(name: &str, w: u32, h: u32, frames: u32) -> Option<PathBuf> {
        let out = std::env::temp_dir().join(name);
        let _ = std::fs::remove_file(&out);
        let ok = Command::new(ffmpeg_bin())
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i"])
            .arg(format!("testsrc=size={w}x{h}:rate=24:duration=2"))
            .args([
                "-frames:v",
                &frames.to_string(),
                "-c:v",
                "libx264",
                "-crf",
                "0",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&out)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        (ok && out.exists()).then_some(out)
    }

    /// Mean absolute per-channel difference between two same-sized RGB images.
    fn mean_abs_diff(a: &RgbImage, b: &RgbImage) -> f64 {
        assert_eq!(a.dimensions(), b.dimensions());
        let sum: u64 = a
            .as_raw()
            .iter()
            .zip(b.as_raw())
            .map(|(p, q)| (*p as i32 - *q as i32).unsigned_abs() as u64)
            .sum();
        sum as f64 / a.as_raw().len() as f64
    }

    fn gpu_or_skip(what: &str) -> bool {
        if render_core::init_gpu_context().is_err() {
            eprintln!("skip: no GPU adapter available for {what}");
            return false;
        }
        true
    }

    // --- D-135 end-to-end: real ffmpeg, real encoded files ------------------

    /// The headline B-042 fix. A crop must change the encoded file's real
    /// dimensions AND land on the right pixels — asserted against the source
    /// clip's own frame, cropped by `image` rather than by our pipeline.
    #[test]
    fn export_encodes_a_real_crop() {
        if !gpu_or_skip("export_encodes_a_real_crop") {
            return;
        }
        let Some(vid) = synth_clip("chroma_geom_src_crop.mp4", 160, 120, 6) else {
            eprintln!("skip: ffmpeg unavailable");
            return;
        };
        let out = std::env::temp_dir().join("chroma_geom_cropped.mov");
        let _ = std::fs::remove_file(&out);

        let js = json!({ "crop": { "x": 20.0, "y": 10.0, "width": 100.0, "height": 60.0 } });
        let res = export_video(&vid, &out, &js, 0, 5, ExportOpts::default()).expect("export");
        assert_eq!(res.frames, 6);

        let probed = video::probe(&out).expect("probe output");
        assert_eq!(
            (probed.resolution.width, probed.resolution.height),
            (100, 60),
            "the encoder was still told the source clip's size"
        );

        // and the encoded pixels are the cropped region, not the top-left 100×60
        let src_info = video::probe(&vid).expect("probe source");
        let src0 = video::decode_frame(&vid, video::FramePos::Index(0), &src_info)
            .expect("decode source frame 0");
        let expected = src0.crop_imm(20, 10, 100, 60).to_rgb8();
        let got = video::decode_frame(&out, video::FramePos::Index(0), &probed)
            .expect("decode exported frame 0")
            .to_rgb8();
        let mad = mean_abs_diff(&expected, &got);
        assert!(mad < 10.0, "exported crop is not the region the user chose: mean|Δ| {mad}");

        // sanity: the WRONG crop (the un-offset top-left) really is a different
        // picture, so the assertion above isn't passing by coincidence.
        let wrong = src0.crop_imm(0, 0, 100, 60).to_rgb8();
        assert!(mean_abs_diff(&wrong, &got) > 20.0);

        // CLAUDE.md's render-path rule: same doc + same frames ⇒ identical
        // pixels. The geometry pass is CPU float work (`rotate_about_center`,
        // `warp_image_geometry`), so it belongs under that rule too.
        let again = std::env::temp_dir().join("chroma_geom_cropped_again.mov");
        let _ = std::fs::remove_file(&again);
        export_video(&vid, &again, &js, 0, 5, ExportOpts::default()).expect("second export");
        assert_eq!(
            std::fs::read(&out).unwrap(),
            std::fs::read(&again).unwrap(),
            "a cropped export is not deterministic"
        );
    }

    /// A 90° step swaps the encoded dimensions — the case the old
    /// spawn-with-the-clip's-size code could not have produced at all.
    #[test]
    fn export_encodes_a_90_degree_step() {
        if !gpu_or_skip("export_encodes_a_90_degree_step") {
            return;
        }
        let Some(vid) = synth_clip("chroma_geom_src_turn.mp4", 160, 120, 4) else {
            eprintln!("skip: ffmpeg unavailable");
            return;
        };
        let out = std::env::temp_dir().join("chroma_geom_turned.mov");
        let _ = std::fs::remove_file(&out);

        export_video(&vid, &out, &json!({ "orientationSteps": 1 }), 0, 3, ExportOpts::default())
            .expect("export");
        let probed = video::probe(&out).expect("probe output");
        assert_eq!((probed.resolution.width, probed.resolution.height), (120, 160));
    }

    /// An odd-sized crop must produce a valid h.264 file, not a libx264
    /// rejection — `yuv420p` needs even dimensions and `react-image-crop`
    /// never guarantees them. Rounded DOWN, so at most one row/column is lost.
    #[test]
    fn export_evens_an_odd_crop_for_h264() {
        if !gpu_or_skip("export_evens_an_odd_crop_for_h264") {
            return;
        }
        let Some(vid) = synth_clip("chroma_geom_src_odd.mp4", 160, 120, 4) else {
            eprintln!("skip: ffmpeg unavailable");
            return;
        };
        let out = std::env::temp_dir().join("chroma_geom_odd.mp4");
        let _ = std::fs::remove_file(&out);

        let js = json!({ "crop": { "x": 11.0, "y": 7.0, "width": 101.0, "height": 61.0 } });
        export_video(
            &vid,
            &out,
            &js,
            0,
            3,
            ExportOpts { codec: Some("h264".into()), ..Default::default() },
        )
        .expect("odd-crop h264 export");

        let probed = video::probe(&out).expect("probe output");
        assert_eq!((probed.resolution.width, probed.resolution.height), (100, 60));
    }

    /// The refusal that replaces D-127's: a crop too small to encode names
    /// itself, and no file is produced.
    #[test]
    fn export_refuses_a_sub_pixel_crop() {
        if !gpu_or_skip("export_refuses_a_sub_pixel_crop") {
            return;
        }
        let Some(vid) = synth_clip("chroma_geom_src_tiny.mp4", 160, 120, 2) else {
            eprintln!("skip: ffmpeg unavailable");
            return;
        };
        let out = std::env::temp_dir().join("chroma_geom_tiny.mov");
        let _ = std::fs::remove_file(&out);

        let js = json!({ "crop": { "x": 0.0, "y": 0.0, "width": 1.0, "height": 60.0 } });
        let err = export_video(&vid, &out, &js, 0, 1, ExportOpts::default())
            .expect_err("a 1px-wide crop is not encodable");
        assert!(err.contains("even-dimension rule"), "{err}");
        assert!(!out.exists(), "no encoder should have been spawned");
    }

    /// A grade with no geometry must encode exactly as it did before D-135 —
    /// the source clip's own dimensions, no trim, no resample.
    #[test]
    fn export_without_geometry_is_unchanged() {
        if !gpu_or_skip("export_without_geometry_is_unchanged") {
            return;
        }
        let Some(vid) = synth_clip("chroma_geom_src_plain.mp4", 160, 120, 4) else {
            eprintln!("skip: ffmpeg unavailable");
            return;
        };
        let out = std::env::temp_dir().join("chroma_geom_plain.mov");
        let _ = std::fs::remove_file(&out);

        export_video(&vid, &out, &json!({ "exposure": 0.0 }), 0, 3, ExportOpts::default())
            .expect("export");
        let probed = video::probe(&out).expect("probe output");
        assert_eq!((probed.resolution.width, probed.resolution.height), (160, 120));
    }

    /// D-030: the seeked decoder must hand back the *same* absolute frames the
    /// old walk-from-0 path did — a 1-frame shift would desync tracked mattes.
    #[test]
    fn seeked_decoder_is_frame_aligned() {
        use std::io::Read as _;
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = video::probe(&vid).expect("probe");
        let (from, to) = (500u64, 503u64);
        let fb = info.resolution.width as usize * info.resolution.height as usize * 3;

        let mut dec = spawn_decoder(&vid, &info, from, to).expect("spawn");
        let mut out = dec.stdout.take().unwrap();
        for n in from..=to {
            let mut buf = vec![0u8; fb];
            out.read_exact(&mut buf).unwrap_or_else(|e| panic!("frame {n}: {e}"));
            let piped = image::RgbImage::from_raw(info.resolution.width, info.resolution.height, buf).unwrap();
            let one = video::decode_frame(&vid, video::FramePos::Index(n), &info)
                .expect("decode_frame")
                .to_rgb8();
            let (cnt, sum) = piped.as_raw().iter().zip(one.as_raw()).fold(
                (0u64, 0u64),
                |(c, s), (a, b)| (c + 1, s + (*a as i64 - *b as i64).unsigned_abs()),
            );
            let mad = sum as f64 / cnt as f64;
            assert!(mad < 1.0, "frame {n}: mean|Δ| {mad} — seeked decoder is off by a frame");
        }
        let _ = dec.wait();
    }

    #[test]
    fn export_neutral_30_frames() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let out = std::env::temp_dir().join("chroma_export_neutral.mov");
        let _ = std::fs::remove_file(&out);
        let res = export_video(&vid, &out, &json!({}), 0, 29, ExportOpts::default())
            .expect("export");
        assert_eq!(res.frames, 30);
        assert!(out.exists());
        eprintln!("neutral: {res:?}");
    }

    /// D-038: an output-resolution override resizes the encoded file; the same
    /// export with no override is unchanged (the resize path is skipped).
    #[test]
    fn export_resolution_override() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let info = video::probe(&vid).expect("probe");

        // no override → output dims == clip dims (byte-for-byte the old path)
        let plain = std::env::temp_dir().join("chroma_export_res_plain.mov");
        let _ = std::fs::remove_file(&plain);
        export_video(&vid, &plain, &json!({}), 0, 9, ExportOpts::default()).expect("plain export");
        let pi = video::probe(&plain).expect("probe plain");
        assert_eq!((pi.resolution.width, pi.resolution.height), (info.resolution.width, info.resolution.height));

        // half-res override → encoded file is that resolution
        let (hw, hh) = (info.resolution.width / 2, info.resolution.height / 2);
        let scaled = std::env::temp_dir().join("chroma_export_res_scaled.mov");
        let _ = std::fs::remove_file(&scaled);
        export_video(
            &vid,
            &scaled,
            &json!({}),
            0,
            9,
            ExportOpts { out_width: Some(hw), out_height: Some(hh), ..Default::default() },
        )
        .expect("scaled export");
        let si = video::probe(&scaled).expect("probe scaled");
        assert_eq!((si.resolution.width, si.resolution.height), (hw, hh));
    }

    #[test]
    fn export_exposure_brighter() {
        let Some(vid) = test_video() else {
            eprintln!("skip: set CHROMA_TEST_VIDEO");
            return;
        };
        let out = std::env::temp_dir().join("chroma_export_bright.mov");
        let _ = std::fs::remove_file(&out);
        export_video(&vid, &out, &json!({ "exposure": 1.0 }), 0, 29, ExportOpts::default())
            .expect("export");
        assert!(out.exists());
    }

    /// D-054: a positional relight light must survive a real export, not just
    /// the live preview (D-048 left `grade_frame` at `relight_depth_layer ==
    /// -1` deliberately — this is the "wire it in" follow-up). Exercises
    /// `grade_frame` directly (no `CHROMA_TEST_VIDEO` fixture needed — a
    /// synthetic in-memory frame + a synthetic static depth bake via
    /// `relightDepthBake`, the D-054 fallback) so this test runs in any
    /// environment with a GPU adapter, matching `relight.rs`'s
    /// `relight_render_is_deterministic`'s own skip-without-GPU convention.
    /// A real, correct/incorrect answer: the lit frame's pixels must differ
    /// from the unlit frame's — "the code path is reached" is not enough.
    #[test]
    fn export_positional_relight_light_changes_pixels() {
        use base64::{Engine as _, engine::general_purpose};
        use image::{GrayImage, ImageFormat, Luma, Rgb};
        use std::io::Cursor;

        let Ok(ctx) = render_core::init_gpu_context() else {
            eprintln!(
                "skip: no GPU adapter available for export_positional_relight_light_changes_pixels"
            );
            return;
        };
        let caches = OwnedRenderCaches::default();

        const W: u32 = 48;
        const H: u32 = 48;

        // Real per-pixel variation, not a flat fill — a flat frame can't
        // reveal a shading bug where the light math never actually samples
        // per-pixel colour.
        let frame = DynamicImage::ImageRgb8(RgbImage::from_fn(W, H, |x, y| {
            Rgb([((x * 5) % 255) as u8, ((y * 5) % 255) as u8, 96])
        }));

        // A synthetic depth bake: radial "near in the middle" gradient, same
        // shape the relight.rs GPU determinism test uses, encoded as the
        // static-bake data URL (`relightDepthBake`) rather than pushed
        // straight into `mask_bitmaps` — this exercises the D-054 fallback
        // resolution path end-to-end, not just the shader.
        let depth = GrayImage::from_fn(W, H, |x, y| {
            let dx = x as f32 - (W as f32 / 2.0);
            let dy = y as f32 - (H as f32 / 2.0);
            let dist = (dx * dx + dy * dy).sqrt() / ((W as f32).hypot(H as f32) / 2.0);
            Luma([(255.0 * (1.0 - dist.min(1.0))) as u8])
        });
        let mut buf = Cursor::new(Vec::new());
        depth.write_to(&mut buf, ImageFormat::Png).unwrap();
        let depth_bake = format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(buf.get_ref())
        );

        let js_lit = json!({
            "relightLights": [{
                "kind": "key", "x": 25.0, "y": 35.0, "radius": 50.0,
                "intensity": 160.0, "color": "#ff9040", "visible": true
            }],
            "relightDepthBake": depth_bake,
        });
        let lit = grade_frame(&ctx, &caches, frame.clone(), 0, &js_lit).expect("lit export frame");

        let js_unlit = json!({});
        let unlit = grade_frame(&ctx, &caches, frame, 0, &js_unlit).expect("unlit export frame");

        assert_eq!(lit.dimensions(), unlit.dimensions());
        assert_ne!(
            lit.into_raw(),
            unlit.into_raw(),
            "a positional relight light with a static depth bake made no difference to an exported frame"
        );
    }

    /// Tracked-subject export: an `ai-subject` mask carrying a `chromaTrackDir`
    /// + a strong exposure lift. Proves the per-frame matte (D-019) is fetched
    /// for the frame being encoded — set `CHROMA_TEST_MATTE_DIR` to a `/track`
    /// cache dir for the test clip.
    #[test]
    fn export_tracked_range() {
        let (Some(vid), Ok(dir)) = (test_video(), std::env::var("CHROMA_TEST_MATTE_DIR")) else {
            eprintln!("skip: set CHROMA_TEST_VIDEO + CHROMA_TEST_MATTE_DIR");
            return;
        };
        let js = json!({
            "masks": [{
                "id": "m1", "name": "subject", "visible": true, "invert": false, "opacity": 100.0,
                "adjustments": { "exposure": 5.0 },
                "subMasks": [{
                    "id": "s1", "type": "ai-subject", "visible": true, "mode": "additive",
                    "parameters": {
                        "startX": 0.0, "startY": 0.0, "endX": 1080.0, "endY": 1920.0,
                        "chromaTrackDir": dir,
                    }
                }]
            }]
        });
        let out = std::env::temp_dir().join("chroma_export_tracked.mov");
        let _ = std::fs::remove_file(&out);
        let res = export_video(&vid, &out, &js, 0, 260, ExportOpts::default()).expect("export");
        assert_eq!(res.frames, 261);
        eprintln!("tracked: {res:?} -> {}", out.display());
    }

    #[test]
    fn bake_lut_warm() {
        // no GPU in CI is fine — this test is opt-in via CHROMA_TEST_VIDEO env
        if test_video().is_none() {
            eprintln!("skip: set CHROMA_TEST_VIDEO (proxy for 'GPU available')");
            return;
        }
        let out = std::env::temp_dir().join("chroma_bake_warm.cube");
        let _ = std::fs::remove_file(&out);
        // RapidRAW `temperature` is a ~-100..100 slider (SCALES.temperature = 25), not Kelvin.
        let res = bake_primary_lut(&json!({ "temperature": 20.0 }), 17, &out).expect("bake");
        assert_eq!(res.size, 17);
        let body = std::fs::read_to_string(&out).unwrap();
        assert!(body.contains("LUT_3D_SIZE 17"));

        let rows: Vec<[f32; 3]> = body
            .lines()
            .filter_map(|l| {
                let p: Vec<f32> = l.split_whitespace().filter_map(|x| x.parse().ok()).collect();
                (p.len() == 3 && !l.contains("DOMAIN")).then(|| [p[0], p[1], p[2]])
            })
            .collect();
        assert_eq!(rows.len(), 17 * 17 * 17);
        // centre lattice point (input mid-grey) must come out warmer: R > B.
        let mid = 17usize / 2;
        let centre = rows[mid + mid * 17 + mid * 17 * 17];
        assert!(
            centre[0] > centre[2] + 0.01,
            "warm push should lift R over B at mid-grey, got {centre:?}"
        );
    }
}
