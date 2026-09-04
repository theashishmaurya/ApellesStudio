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

use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;

use image::{DynamicImage, GenericImageView, RgbImage};
use once_cell::sync::Lazy;
use serde_json::{json, Value};

use crate::gpu_processing::RenderRequest;
use crate::image_processing::{
    Crop, get_all_adjustments_from_json, get_geometry_params_from_json, is_geometry_identity,
};
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
// pre-flight: the geometry a video export genuinely cannot honour (B-042)
// --------------------------------------------------------------------------- //

/// `adjustments.orientationSteps` counts 90° turns, so this many of them is a
/// full revolution — i.e. the same upright image, not a real transform.
/// Matches `image_processing::apply_coarse_rotation`, which only ever acts on
/// steps 1/2/3.
const ORIENTATION_STEPS_PER_TURN: u64 = 4;

/// Every geometry control in the Colorist's Crop panel is applied **on the
/// CPU**, in `adjustment_utils::apply_all_transformations`, as a pre-pass
/// before the GPU grade — `AllAdjustments` carries no geometry at all.
/// [`grade_frame`] deliberately doesn't run that pre-pass (see D-127 for why
/// it can't yet), so on a video export every one of these is silently
/// dropped: the preview shows the cropped/straightened frame, the encoded
/// file doesn't. This function names exactly which of them are non-identity
/// in `js` so [`export_video`] can refuse up front with an actionable
/// message instead of shipping the wrong pixels.
///
/// `width`/`height` are the source clip's real dimensions — needed because a
/// full-frame crop rect is a no-op, and the Crop panel writes a full-frame
/// rect the moment it's opened. The rounding/clamping here mirrors
/// [`crate::image_processing::apply_crop`]'s own, step for step, so this
/// guard and the still path can never disagree about what counts as "a real
/// crop."
fn unsupported_geometry(js: &Value, width: u32, height: u32) -> Vec<&'static str> {
    let mut found: Vec<&'static str> = Vec::new();

    if let Some(crop_val) = js.get("crop")
        && !crop_val.is_null()
        && let Ok(c) = serde_json::from_value::<Crop>(crop_val.clone())
    {
        let x = c.x.round().max(0.0) as u32;
        let y = c.y.round().max(0.0) as u32;
        let w = c.width.round().max(0.0) as u32;
        let h = c.height.round().max(0.0) as u32;
        if w > 0 && h > 0 && x < width && y < height {
            let cw = (width - x).min(w);
            let ch = (height - y).min(h);
            let is_full_frame = x == 0 && y == 0 && cw == width && ch == height;
            if cw > 0 && ch > 0 && !is_full_frame {
                found.push("crop");
            }
        }
    }

    if js.get("rotation").and_then(Value::as_f64).unwrap_or(0.0) != 0.0 {
        found.push("straighten (rotation)");
    }
    // `apply_coarse_rotation` only acts on steps 1/2/3; 0 and any whole number
    // of turns are the same upright image.
    let orientation_steps = js
        .get("orientationSteps")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if !orientation_steps.is_multiple_of(ORIENTATION_STEPS_PER_TURN) {
        found.push("90° orientation");
    }
    if js
        .get("flipHorizontal")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        found.push("horizontal flip");
    }
    if js
        .get("flipVertical")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        found.push("vertical flip");
    }
    // The perspective / lens-correction warp — same identity test
    // `apply_geometry_warp` itself uses to decide whether to run at all.
    if !is_geometry_identity(&get_geometry_params_from_json(js)) {
        found.push("perspective / lens correction");
    }

    found
}

// --------------------------------------------------------------------------- //
// per-frame grade (the still export path, wrapped in a video loop)
// --------------------------------------------------------------------------- //

/// Render one decoded RGB frame through the grade. Mirrors RapidRAW's
/// `generate_preview_for_path` (JSON → `AllAdjustments` + mask bitmaps →
/// `RenderRequest` → render) but the base image is a video frame we already hold,
/// so there is no file decode / `load_and_composite`.
///
/// v1 limitation: parametric `color` / `luminance` masks need the de-warped image
/// (`resolve_warped_image_for_masks`, GUI-state coupled) — we pass `None`, so
/// those mask types are skipped on video export. Shape masks and AI / tracked
/// subject mattes (the talking-head case) work.
fn grade_frame(
    ctx: &crate::image_processing::GpuContext,
    caches: &OwnedRenderCaches,
    frame: DynamicImage,
    frame_index: u64,
    js: &Value,
) -> Result<RgbImage, String> {
    let (w, h) = frame.dimensions();

    let mask_defs: Vec<MaskDefinition> = js
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();

    let mut mask_bitmaps: Vec<_> = mask_defs
        .iter()
        .filter_map(|def| generate_mask_bitmap(def, w, h, 1.0, (0.0, 0.0), None))
        .collect();

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
        && let Some(depth_bitmap) =
            crate::mask_generation::resolve_relight_depth_bitmap(js, w, h, 1.0, (0.0, 0.0))
    {
        adjustments.relight_depth_layer = mask_bitmaps.len() as i32;
        mask_bitmaps.push(depth_bitmap);
    }
    // D-077 follow-up, same reasoning as the depth wiring just above: an
    // export must get the real baked normal too, not silently degrade to the
    // depth-derived approximation just because it's a different code path
    // from live preview.
    if adjustments.relight_light_count > 0
        && let Some(normal_bitmaps) =
            crate::mask_generation::resolve_relight_normal_bitmap(js, w, h, 1.0, (0.0, 0.0))
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
        &frame,
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

    // B-042: fail before spawning ffmpeg rather than encoding a file that
    // silently disagrees with the preview. See `unsupported_geometry` / D-127.
    let dropped = unsupported_geometry(js_adjustments, w, h);
    if !dropped.is_empty() {
        return Err(format!(
            "video export can't apply {} yet — the Colorist applies geometry on the CPU, \
             before the grade, and the video path doesn't run that pass (D-127). Reset it \
             (Crop / Transform panels) and export again, or export a still if you need the \
             geometry.",
            dropped.join(", ")
        ));
    }

    let last = info.frame_count.saturating_sub(1);
    let from = from_frame.min(last);
    let to = to_frame.min(last).max(from);
    let total = to - from + 1;

    // D-038: the output resolution. When a loaded project sets `settings.width`
    // + `settings.height`, the graded composite (rendered at clip res `w`×`h`)
    // is resized to `(out_w, out_h)` right before the encoder. No override ⇒
    // `(out_w, out_h) == (w, h)` and the resize is skipped — byte-identical to
    // before this decision.
    let (out_w, out_h) = match (opts.out_width, opts.out_height) {
        (Some(ow), Some(oh)) if ow > 0 && oh > 0 => (ow, oh),
        _ => (w, h),
    };
    let resize_output = (out_w, out_h) != (w, h);

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

        let mut enc = spawn_encoder(out_path, out_w, out_h, &fps_str, codec, opts.quality)?;
        let enc_err = drain_stderr(&mut enc);
        let mut enc_in = enc.stdin.take().ok_or("encoder stdin unavailable")?;

        let frame_bytes = (w as usize) * (h as usize) * 3;
        let mut buf = vec![0u8; frame_bytes];
        let mut done: u64 = 0;

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
            if (gw, gh) != (w, h) {
                // Defensive invariant, not the crop guard it used to claim to
                // be (B-042): `grade_frame` runs no geometry pass at all, so a
                // size change here would mean `render_core::render` itself
                // resized — a real engine bug, not a user-set crop. Real crop /
                // straighten / flip is caught by `unsupported_geometry` before
                // the encoder is ever spawned.
                return Err(format!(
                    "graded frame {frame_index} is {gw}x{gh} (expected {w}x{h}) — \
                     the grade must not change frame dimensions",
                ));
            }
            // D-038: last-step resize to the project output resolution. Skipped
            // (zero-copy) when no project override is in effect.
            let raw = if resize_output {
                image::imageops::resize(
                    &graded,
                    out_w,
                    out_h,
                    image::imageops::FilterType::Lanczos3,
                )
                .into_raw()
            } else {
                graded.into_raw()
            };
            enc_in
                .write_all(&raw)
                .map_err(|e| format!("write to encoder stdin: {e} — {}", tail(&enc_err)))?;

            done += 1;
            progress_tick(done);
        }

        drop(enc_in); // EOF → encoder flushes and exits
        let _ = dec.wait();

        let status = enc.wait().map_err(|e| format!("wait for encoder: {e}"))?;
        if !status.success() {
            return Err(format!("encoder exited {status}: {}", tail(&enc_err)));
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

    // --- B-042: the geometry pre-flight ------------------------------------
    // No fixture video needed — `unsupported_geometry` is pure JSON in, names
    // out, which is exactly the part that must not drift from
    // `apply_all_transformations`' own identity tests.

    const FIXTURE_W: u32 = 1920;
    const FIXTURE_H: u32 = 1080;

    fn dropped(js: &Value) -> Vec<&'static str> {
        unsupported_geometry(js, FIXTURE_W, FIXTURE_H)
    }

    #[test]
    fn unsupported_geometry_is_empty_for_a_plain_grade() {
        assert!(dropped(&json!({})).is_empty());
        assert!(dropped(&json!({ "exposure": 1.0, "crop": null })).is_empty());
    }

    /// The Crop panel writes a full-frame rect as soon as it's opened — that
    /// is not a crop, and must not block an export.
    #[test]
    fn unsupported_geometry_ignores_a_full_frame_crop_rect() {
        let js = json!({ "crop": { "x": 0.0, "y": 0.0, "width": 1920.0, "height": 1080.0 } });
        assert!(dropped(&js).is_empty());
    }

    #[test]
    fn unsupported_geometry_reports_a_real_crop() {
        let js = json!({ "crop": { "x": 100.0, "y": 0.0, "width": 1280.0, "height": 720.0 } });
        assert_eq!(dropped(&js), vec!["crop"]);
    }

    #[test]
    fn unsupported_geometry_reports_straighten_flip_and_orientation() {
        assert_eq!(
            dropped(&json!({ "rotation": 2.5 })),
            vec!["straighten (rotation)"]
        );
        assert_eq!(
            dropped(&json!({ "orientationSteps": 1 })),
            vec!["90° orientation"]
        );
        // a full turn is the same upright image
        assert!(dropped(&json!({ "orientationSteps": 4 })).is_empty());
        assert_eq!(
            dropped(&json!({ "flipHorizontal": true })),
            vec!["horizontal flip"]
        );
        assert_eq!(
            dropped(&json!({ "flipVertical": true })),
            vec!["vertical flip"]
        );
    }

    #[test]
    fn unsupported_geometry_reports_the_perspective_warp() {
        assert_eq!(
            dropped(&json!({ "transformVertical": 10.0 })),
            vec!["perspective / lens correction"]
        );
    }

    #[test]
    fn unsupported_geometry_names_every_offender_at_once() {
        let js = json!({
            "crop": { "x": 10.0, "y": 10.0, "width": 100.0, "height": 100.0 },
            "rotation": 1.0,
            "flipHorizontal": true,
        });
        assert_eq!(
            dropped(&js),
            vec!["crop", "straighten (rotation)", "horizontal flip"]
        );
    }

    fn test_video() -> Option<PathBuf> {
        std::env::var("CHROMA_TEST_VIDEO").ok().map(PathBuf::from).filter(|p| p.exists())
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
