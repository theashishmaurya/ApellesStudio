//! **The Colorist grade as a native pass of the GPU render engine (D-450).**
//!
//! What it is: a clip's saved Colorist grade, run per frame by the Colorist's
//! own grade shader (RapidRAW's `GpuProcessor`, `gpu_processing.rs`) on the
//! GPU render engine's device, so a graded clip in the Edit preview and in the
//! export is the Colorist's picture (B-381). Replaces D-256's baked lattice for
//! both.
//!
//! What it does: [`grade_for_clip`] / [`resolve_clip_grade`] read a clip's
//! `grade.json` once per version of the file and resolve it to the shader's
//! inputs (`AllAdjustments`, the grade's own `.cube`); [`grade_source`] writes a
//! decoded frame into the shader's half-float input on the GPU, runs the
//! shader, and copies its output into a buffer the engine paints as a
//! [`Source::Gpu`] — no CPU read-back, no process-global state;
//! [`check_clip_grades`] is the export's pre-flight.
//!
//! What it does NOT do (yet), named in every grade's warnings: masks, the
//! Colorist crop and geometry (rotation, flips, orientation steps), and
//! relight. The Colorist's own export (`export::grade_frame`) builds those from
//! the process-global current frame (`chroma::state::current_video().frame`),
//! which the parallel export segments and the live preview cannot share; they
//! need explicit per-frame inputs first (D-450, `docs/notes/native-grade-pass.md`).
//!
//! Determinism: the shader is a per-pixel function of its inputs with fixed
//! loops (its grain is a hash of the pixel's image coordinate), so the same
//! grade on the same frame gives the same bytes
//! (`a_graded_frame_hashes_the_same_every_time`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use apelles_compositor::{GpuImage, Source};
use once_cell::sync::Lazy;
use serde_json::Value;

use crate::gpu_processing::{GpuProcessor, RenderRequest};
use crate::image_processing::{AllAdjustments, get_all_adjustments_from_json};

use super::{gpu_compositor, state};

/// A clip's grade, resolved to what the shader takes.
pub(crate) struct ClipGrade {
    adjustments: AllAdjustments,
    /// The grade's own `.cube` (the Colorist's LUT slot), parsed once.
    lut: Option<Arc<crate::lut_processing::Lut>>,
    /// What this wave does not carry yet, said in the Export panel before an
    /// export, and logged once per version of the file.
    pub(crate) warnings: Vec<String>,
}

/// `<project>/grades/<clip_id>.grade.json` — where the Colorist writes a clip's
/// grade (D-025's document, at D-070's clip-id-keyed name).
pub(crate) fn grade_file_for(project_dir: &Path, clip_id: &str) -> PathBuf {
    apelles_project::grade_dir(project_dir).join(format!("{clip_id}.grade.json"))
}

/// A grade file's staleness fingerprint: (mtime nanos, length). Only a "has the
/// file changed" test, never an input to the picture.
type Fingerprint = (i128, u64);

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0);
    Some((mtime, meta.len()))
}

/// What a grade file resolved to. `Ok(None)` is nothing to apply (no file, or
/// a grade that changes nothing); `Err` is a grade that exists and could not be
/// read — the preview shows the clip ungraded, the export refuses.
type Resolved = Result<Option<Arc<ClipGrade>>, String>;

static CACHE: Lazy<Mutex<HashMap<PathBuf, (Fingerprint, Resolved)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// The clip's grade in the open project, for the preview: a grade that cannot
/// be read is logged and the clip shown ungraded, because an Edit tab that
/// draws nothing is a worse failure. The export calls [`resolve_clip_grade`].
pub(crate) fn grade_for_clip(clip_id: &str) -> Option<Arc<ClipGrade>> {
    match resolve_clip_grade(clip_id) {
        Ok(g) => g,
        Err(e) => {
            log::warn!("[chroma::grade_pass] clip {clip_id}: {e}; previewing ungraded");
            None
        }
    }
}

/// The clip's grade in the open project, memoised on the grade file's
/// fingerprint.
pub(crate) fn resolve_clip_grade(clip_id: &str) -> Resolved {
    let Some(project) = state::current_project() else {
        return Ok(None);
    };
    let path = grade_file_for(&project.path, clip_id);
    let Some(fp) = fingerprint(&path) else {
        return Ok(None); // no grade file for this clip: the common case
    };
    if let Ok(cache) = CACHE.lock()
        && let Some((cached, resolved)) = cache.get(&path)
        && *cached == fp
    {
        return resolved.clone();
    }
    let resolved = load(&path).map(|g| {
        g.map(|g| {
            for w in &g.warnings {
                log::warn!("[chroma::grade_pass] clip {clip_id}: {w}");
            }
            Arc::new(g)
        })
    });
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(path, (fp, resolved.clone()));
    }
    resolved
}

/// Drop every memoised grade: for a test that rewrites one grade file within
/// one filesystem timestamp tick.
#[cfg(test)]
pub(crate) fn clear_cache() {
    if let Ok(mut c) = CACHE.lock() {
        c.clear();
    }
}

/// Read one `grade.json` (through `apelles_grade_model::load_grade`, the
/// Colorist's own loader, so schema migration happens in one place) and
/// resolve its `adjustments`.
fn load(path: &Path) -> Result<Option<ClipGrade>, String> {
    let grade = apelles_grade_model::load_grade(&path.to_string_lossy())?;
    let adjustments = grade
        .get("adjustments")
        .ok_or_else(|| format!("{} has no `adjustments`", path.display()))?;
    resolve(adjustments)
}

/// A grade document's `adjustments` → the shader's inputs, or `None` when the
/// grade changes nothing (the same `AllAdjustments` an empty grade gives, and
/// no `.cube`): such a clip keeps the plain-decode fast path.
pub(crate) fn resolve(adjustments: &Value) -> Result<Option<ClipGrade>, String> {
    let warnings = not_carried(adjustments);
    // Everything the shader reads, as the Colorist reads it. What this wave
    // does not carry (masks, relight) is removed so it cannot half-apply.
    let mut carried = adjustments.clone();
    if let Some(obj) = carried.as_object_mut() {
        obj.remove("masks");
        obj.remove("relightLights");
    }
    let resolved = get_all_adjustments_from_json(&carried, false, None);
    let lut = match carried.get("lutPath").and_then(Value::as_str) {
        Some(p) if !p.is_empty() => Some(Arc::new(
            crate::lut_processing::parse_lut_file(p)
                .map_err(|e| format!("its .cube LUT {p} could not be read: {e}"))?,
        )),
        _ => None,
    };
    let neutral = get_all_adjustments_from_json(&serde_json::json!({}), false, None);
    if lut.is_none() && bytemuck::bytes_of(&resolved) == bytemuck::bytes_of(&neutral) {
        return Ok(None);
    }
    Ok(Some(ClipGrade {
        adjustments: resolved,
        lut,
        warnings,
    }))
}

/// What in `adjustments` the native pass does not carry yet (D-450's scope).
fn not_carried(adjustments: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let visible_masks = adjustments
        .get("masks")
        .and_then(Value::as_array)
        .map(|m| {
            m.iter()
                .filter(|m| m.get("visible").and_then(Value::as_bool).unwrap_or(true))
                .count()
        })
        .unwrap_or(0);
    if visible_masks > 0 {
        out.push(format!(
            "its {visible_masks} masked / local layer(s) are not shown in the Edit tab and the export yet"
        ));
    }
    if adjustments.get("crop").is_some_and(|c| !c.is_null()) {
        out.push("its Colorist crop is not applied in the Edit tab and the export yet".to_string());
    }
    let turned = adjustments
        .get("rotation")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        != 0.0
        || adjustments
            .get("orientationSteps")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            != 0
        || adjustments
            .get("flipHorizontal")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || adjustments
            .get("flipVertical")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    if turned {
        out.push(
            "its Colorist rotation / flip is not applied in the Edit tab and the export yet"
                .to_string(),
        );
    }
    if adjustments
        .get("relightLights")
        .and_then(Value::as_array)
        .is_some_and(|l| !l.is_empty())
    {
        out.push("its relight is not shown in the Edit tab and the export yet".to_string());
    }
    out
}

/// The grade shader's state on the render device: the Colorist's
/// `GpuProcessor`, sized for the largest frame seen so far, and the half-float
/// input textures it reads, one per frame size in use (the preview and an
/// export draw at different sizes).
pub(crate) struct Grader {
    processor: GpuProcessor,
    max: (u32, u32),
    inputs: Vec<((u32, u32), wgpu::Texture)>,
}

/// How many input sizes are kept: the preview's two decode caps and an export.
const KEPT_INPUTS: usize = 3;

/// Grade `source` (a decoded frame of a graded clip) on the GPU and return the
/// graded picture as a [`Source::Gpu`] for the engine to paint.
///
/// One frame at a time on the device: the shader reuses its textures, so the
/// whole of it — the input write, the shader, and the copy out of its output
/// texture into a buffer this frame owns — runs under the grader's lock. The
/// copy is submitted before the lock is released, so the next frame's grade,
/// queued later on the same queue, cannot overwrite what this frame's engine
/// pass will read.
pub(crate) fn grade_source(source: &Source, grade: &ClipGrade) -> Result<Source, String> {
    let device = gpu_compositor::device()?;
    let (w, h) = source.dimensions();
    let mut slot = device.grader.lock().unwrap_or_else(|e| e.into_inner());
    let rebuild = match slot.as_ref() {
        Some(g) => g.max.0 < w || g.max.1 < h,
        None => true,
    };
    if rebuild {
        let (mw, mh) = match slot.as_ref() {
            Some(g) => (g.max.0.max(w), g.max.1.max(h)),
            None => (w, h),
        };
        // The Colorist sizes its processor the same way
        // (`process_and_get_dynamic_image_inner`).
        let max = ((mw + 255) & !255, (mh + 255) & !255);
        let processor = GpuProcessor::new(device.ctx.clone(), max.0, max.1)?;
        *slot = Some(Grader {
            processor,
            max,
            inputs: Vec::new(),
        });
    }
    let Some(grader) = slot.as_mut() else {
        return Err("the grade shader could not be built".to_string());
    };
    let input = grader.input(&device.ctx.device, (w, h));
    gpu_compositor::settle(device.engine.write_f16_texture(source, &input))?;
    let view = input.create_view(&wgpu::TextureViewDescriptor::default());
    grader
        .processor
        .run(
            &view,
            w,
            h,
            RenderRequest {
                adjustments: grade.adjustments,
                mask_bitmaps: &[],
                lut: grade.lut.clone(),
                roi: None,
            },
            true,
            true,
        )
        .inspect_err(|e| gpu_compositor::forget_device(e))?;
    // The shader's output is its RGBA8 `working_texture`; a texture-to-buffer
    // copy pads each row to 256 bytes, which the engine reads as the row
    // stride.
    let row_bytes =
        (w * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let buffer = device.ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("graded clip frame"),
        size: u64::from(row_bytes) * u64::from(h),
        usage: wgpu::BufferUsages::STORAGE
            | wgpu::BufferUsages::COPY_DST
            | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let mut encoder = device
        .ctx
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("graded clip frame copy"),
        });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &grader.processor.working_texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(row_bytes),
                rows_per_image: Some(h),
            },
        },
        wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
    );
    device.ctx.queue.submit(Some(encoder.finish()));
    Ok(Source::Gpu(GpuImage {
        buffer,
        width: w,
        height: h,
        row_pixels: row_bytes / 4,
    }))
}

impl Grader {
    /// The half-float input texture for a `size` frame, kept for reuse.
    fn input(&mut self, device: &wgpu::Device, size: (u32, u32)) -> wgpu::Texture {
        if let Some(i) = self.inputs.iter().position(|(s, _)| *s == size) {
            let entry = self.inputs.remove(i);
            let tex = entry.1.clone();
            self.inputs.push(entry); // most recently used last
            return tex;
        }
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("grade shader input"),
            size: wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        if self.inputs.len() >= KEPT_INPUTS {
            self.inputs.remove(0);
        }
        self.inputs.push((size, tex.clone()));
        tex
    }
}

/// What [`check_clip_grades`] hands the frontend (the Export panel's
/// pre-flight, `packages/editor/src/gradeLuts.ts`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GradeCheck {
    /// The clips with a grade the export will apply.
    pub graded: Vec<String>,
    /// What those grades do not carry yet, prefixed with the clip: shown in
    /// the Export panel before an export.
    pub warnings: Vec<String>,
}

/// The export's grade pre-flight: every clip's grade read, and what each one
/// does not carry yet. Errors rather than skipping: a clip that has a grade
/// which cannot be read refuses the export instead of shipping it ungraded.
pub fn check_clip_grades(clip_ids: &[String]) -> Result<GradeCheck, String> {
    let mut graded = Vec::new();
    let mut warnings = Vec::new();
    for clip_id in clip_ids {
        if let Some(g) = resolve_clip_grade(clip_id).map_err(|e| format!("clip {clip_id}: {e}"))? {
            warnings.extend(g.warnings.iter().map(|w| format!("clip {clip_id}: {w}")));
            graded.push(clip_id.clone());
        }
    }
    Ok(GradeCheck { graded, warnings })
}

/// The Export panel's grade pre-flight (`check_clip_grades`), off the Tauri
/// main thread. The name is the one the frontend has called since D-256, when
/// this baked lattices; the bridge-wide rename of legacy commands is roadmap
/// 00i's.
#[tauri::command]
pub async fn chroma_timeline_grade_luts(clip_ids: Vec<String>) -> Result<GradeCheck, String> {
    tokio::task::spawn_blocking(move || check_clip_grades(&clip_ids))
        .await
        .map_err(|e| format!("grade check task: {e}"))?
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use image::{DynamicImage, Rgba, RgbaImage};
    use serde_json::{Value, json};

    use crate::gpu_processing::RenderRequest;
    use crate::image_processing::get_all_adjustments_from_json;
    use crate::render_core::{self, OwnedRenderCaches};

    /// A deterministic photographic-ish picture: gradients, fine detail and
    /// edges, so blurs, local contrast and sharpening all have work to do.
    pub(super) fn picture(w: u32, h: u32, seed: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            let n = x
                .wrapping_mul(2_654_435_761)
                .wrapping_add(y.wrapping_mul(40_503))
                .wrapping_add(seed.wrapping_mul(97));
            let grad = |k: u32| ((x * 255 / w) * k + (y * 255 / h) * (3 - k)) / 3;
            let band = if (x / 97 + y / 61) % 2 == 0 { 40 } else { 0 };
            Rgba([
                ((grad(1) + (n >> 27) + band) & 0xff) as u8,
                ((grad(2) + ((n >> 20) & 15)) & 0xff) as u8,
                (((x ^ y) / 3 + seed + band) & 0xff) as u8,
                255,
            ])
        })
    }

    /// The grades the reference covers: the plain global grade, the local tone
    /// operators (the tonal blur), every neighbourhood / position effect the
    /// D-256 bake had to strip, and all of them at once.
    pub(super) fn grades() -> Vec<(&'static str, Value)> {
        vec![
            ("exposure-only", json!({ "exposure": 0.3 })),
            (
                "local-tone",
                json!({ "exposure": 0.45, "contrast": 18.0, "highlights": -25.0, "shadows": 20.0,
                        "whites": 10.0, "blacks": -12.0, "saturation": 15.0,
                        "temperature": 12.0, "tint": -6.0 }),
            ),
            (
                "neighbourhood",
                json!({ "sharpness": 40.0, "clarity": 30.0, "structure": 25.0, "dehaze": 20.0,
                        "vignetteAmount": -40.0, "grainAmount": 30.0, "glowAmount": 20.0,
                        "halationAmount": 15.0 }),
            ),
            (
                "everything",
                json!({ "exposure": 0.2, "contrast": 12.0, "highlights": -30.0, "shadows": 25.0,
                        "whites": 5.0, "blacks": -8.0, "saturation": -10.0, "vibrance": 20.0,
                        "temperature": -8.0, "tint": 4.0, "sharpness": 25.0, "clarity": 20.0,
                        "structure": 15.0, "dehaze": 10.0, "vignetteAmount": -25.0,
                        "grainAmount": 15.0, "glowAmount": 10.0, "halationAmount": 10.0 }),
            ),
        ]
    }

    pub(super) const SIZES: [(u32, u32); 3] = [(1920, 1080), (3840, 2160), (1283, 721)];

    /// The Colorist's own render of `img` under `grade` (`render_core::render`,
    /// read back), as RGBA8.
    pub(super) fn colorist_render(
        ctx: &crate::image_processing::GpuContext,
        caches: &OwnedRenderCaches,
        img: &RgbaImage,
        grade: &Value,
    ) -> RgbaImage {
        render_core::render(
            ctx,
            caches.as_ref(),
            &DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(img.clone()).to_rgb8()),
            0,
            RenderRequest {
                adjustments: get_all_adjustments_from_json(grade, false, None),
                mask_bitmaps: &[],
                lut: None,
                roi: None,
            },
            "grade_pass_reference",
            false,
            None,
        )
        .expect("Colorist render")
        .to_rgba8()
    }

    /// The engine frame of a clip graded natively: the decoded picture through
    /// [`super::grade_source`], painted 1:1 by the engine.
    fn native_frame(img: &RgbaImage, grade: &Value) -> RgbaImage {
        use apelles_compositor::{Background, FramePlan, Layer, Source, Step};
        let (w, h) = img.dimensions();
        let g = super::resolve(grade)
            .expect("resolve")
            .expect("a real grade");
        let rgb = DynamicImage::ImageRgba8(img.clone()).to_rgb8();
        let graded =
            super::grade_source(&Source::Rgb(std::sync::Arc::new(rgb)), &g).expect("grade");
        super::super::gpu_compositor::render(&FramePlan {
            width: w,
            height: h,
            background: Background::Solid([0, 0, 0, 255]),
            steps: vec![Step::Paint(Layer {
                source: graded,
                crop: (0, 0, w, h),
                size: (w, h),
                origin: (0.0, 0.0),
                opacity: 1.0,
                corner_radius: 0.0,
                rotation_deg: 0.0,
            })],
        })
        .expect("engine frame")
    }

    /// **B-381's fix, as a pixel claim.** A graded clip's frame drawn by the
    /// engine (the native pass) is the Colorist's own render of the same
    /// picture, bit for bit, for every grade the reference covers — the local
    /// tone operators and every neighbourhood / position effect the lattice
    /// could not carry included — at 1080p, 4K and an unaligned size. The
    /// lattice this replaced measured 49 dB / max 20 on the same comparison
    /// (D-449 §15.7) and about 20 dB on real footage (B-381).
    #[test]
    fn a_natively_graded_frame_is_the_colorist_render() {
        let ctx = render_core::init_gpu_context().expect("Colorist GPU context");
        let caches = OwnedRenderCaches::default();
        let mut failures = Vec::new();
        for (w, h) in SIZES {
            let img = picture(w, h, 7);
            for (name, grade) in grades() {
                let want = colorist_render(&ctx, &caches, &img, &grade);
                let got = native_frame(&img, &grade);
                let (mut differing, mut max) = (0u64, 0u8);
                for (p, q) in got.pixels().zip(want.pixels()) {
                    let d = (0..4).map(|c| p[c].abs_diff(q[c])).max().unwrap_or(0);
                    max = max.max(d);
                    differing += u64::from(d > 0);
                }
                eprintln!(
                    "{name} {w}x{h}: native vs Colorist: {differing} pixels differ, max {max}"
                );
                if differing > 0 {
                    failures.push(format!("{name} {w}x{h}: {differing} px, max {max}"));
                }
            }
        }
        assert!(
            failures.is_empty(),
            "the native grade is not the Colorist's: {failures:#?}"
        );
    }

    /// CLAUDE.md's render-path invariant on a natively graded frame: a graded
    /// clip under a rounded, minified, rotated graded PIP and a title, drawn
    /// five times, gives the same bytes. The hash is printed so another day's
    /// run on the same machine can be compared.
    #[test]
    fn a_graded_frame_hashes_the_same_every_time() {
        use apelles_compositor::{Background, FramePlan, Layer, Source, Step};
        use std::hash::{Hash as _, Hasher as _};
        let (_, everything) = grades().pop().expect("the everything grade");
        let g = super::resolve(&everything)
            .expect("resolve")
            .expect("graded");
        let base = DynamicImage::ImageRgba8(picture(1920, 1080, 3)).to_rgb8();
        let pip = DynamicImage::ImageRgba8(picture(1280, 720, 9)).to_rgb8();
        let layer = |source: Source, crop, size, origin, radius, rot| Layer {
            source,
            crop,
            size,
            origin,
            opacity: 1.0,
            corner_radius: radius,
            rotation_deg: rot,
        };
        let frame = || {
            let graded_base =
                super::grade_source(&Source::Rgb(std::sync::Arc::new(base.clone())), &g)
                    .expect("grade base");
            let graded_pip =
                super::grade_source(&Source::Rgb(std::sync::Arc::new(pip.clone())), &g)
                    .expect("grade pip");
            let mut title = picture(1920, 1080, 11);
            for p in title.pixels_mut() {
                p[3] = (p[0] / 2).max(10);
            }
            super::super::gpu_compositor::render(&FramePlan {
                width: 1920,
                height: 1080,
                background: Background::Solid([0, 0, 0, 255]),
                steps: vec![
                    Step::Paint(layer(
                        graded_base,
                        (0, 0, 1920, 1080),
                        (1920, 1080),
                        (0.0, 0.0),
                        0.0,
                        0.0,
                    )),
                    Step::Paint(layer(
                        graded_pip,
                        (40, 20, 1240, 700),
                        (640, 362),
                        (1180.4, 640.6),
                        24.0,
                        6.0,
                    )),
                    Step::Paint(layer(
                        Source::Rgba(std::sync::Arc::new(title)),
                        (0, 0, 1920, 1080),
                        (1920, 1080),
                        (0.0, 0.0),
                        0.0,
                        0.0,
                    )),
                ],
            })
            .expect("frame")
        };
        let first = frame();
        let mut h = std::collections::hash_map::DefaultHasher::new();
        first.as_raw().hash(&mut h);
        eprintln!("natively graded full-stack frame: {:016x}", h.finish());
        for _ in 0..4 {
            assert_eq!(frame(), first);
        }
    }

    /// What a graded clip costs per frame on the engine path (D-450): the
    /// decoded frame written to the shader's input, the shader, the copy into
    /// the engine's buffer, and an engine frame painting it, waited for. Best
    /// of 10, for each reference grade. A measurement:
    /// `cargo test -p apelles --lib measure_a_natively_graded_frame -- --ignored --nocapture`.
    #[test]
    #[ignore = "a timing measurement, not a pass/fail fact"]
    fn measure_a_natively_graded_frame() {
        for (w, h) in [(1920u32, 1080u32), (3840, 2160)] {
            let img = picture(w, h, 7);
            let _ = native_frame(&img, &grades()[1].1);
            for (name, grade) in grades() {
                let best = (0..10)
                    .map(|_| {
                        let t = std::time::Instant::now();
                        let _ = native_frame(&img, &grade);
                        t.elapsed().as_secs_f64() * 1000.0
                    })
                    .fold(f64::INFINITY, f64::min);
                eprintln!("{w}x{h} {name:<14} graded engine frame {best:7.1} ms");
            }
        }
    }

    /// **What the grade shader's passes cost on the GPU** (D-450): the
    /// Colorist's `GpuProcessor::run` with no CPU read-back, the way the engine
    /// runs it, for two grades at 1080p and 4K. The previous tiling (2048-px
    /// tiles) is built beside the current one on the same device and the two
    /// are run interleaved, best of 15 each, so another process's GPU load
    /// lands on both rather than on whichever ran second. A measurement:
    /// `cargo test -p apelles --lib measure_the_grade_shader -- --ignored --nocapture`.
    #[test]
    #[ignore = "a timing measurement, not a pass/fail fact"]
    fn measure_the_grade_shader_gpu_passes() {
        use crate::gpu_processing::GpuProcessor;
        use wgpu::util::DeviceExt as _;

        let ctx = render_core::init_gpu_context().expect("Colorist GPU context");
        let wait = || {
            let _ = ctx.device.poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_secs(30)),
            });
        };
        for (w, h) in [(1920u32, 1080u32), (3840, 2160)] {
            let img = DynamicImage::ImageRgba8(picture(w, h, 7));
            let f16s: Vec<half::f16> = img
                .to_rgba32f()
                .into_raw()
                .into_iter()
                .map(half::f16::from_f32)
                .collect();
            let tex = ctx.device.create_texture_with_data(
                &ctx.queue,
                &wgpu::TextureDescriptor {
                    label: Some("measure input"),
                    size: wgpu::Extent3d {
                        width: w,
                        height: h,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::Rgba16Float,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                },
                wgpu::util::TextureDataOrder::MipMajor,
                bytemuck::cast_slice(&f16s),
            );
            let view = tex.create_view(&Default::default());
            let (pw, ph) = ((w + 255) & !255, (h + 255) & !255);
            let tiled = GpuProcessor::new_with_tile_size(ctx.clone(), pw, ph, 2048).expect("tiled");
            let current = GpuProcessor::new(ctx.clone(), pw, ph).expect("current");
            for (name, grade) in grades().into_iter().filter(|(n, _)| *n != "exposure-only") {
                let request = || RenderRequest {
                    adjustments: get_all_adjustments_from_json(&grade, false, None),
                    mask_bitmaps: &[],
                    lut: None,
                    roi: None,
                };
                let (mut a, mut b) = (f64::INFINITY, f64::INFINITY);
                for _ in 0..15 {
                    let t = std::time::Instant::now();
                    tiled.run(&view, w, h, request(), true, true).expect("run");
                    wait();
                    a = a.min(t.elapsed().as_secs_f64() * 1000.0);
                    let t = std::time::Instant::now();
                    current
                        .run(&view, w, h, request(), true, true)
                        .expect("run");
                    wait();
                    b = b.min(t.elapsed().as_secs_f64() * 1000.0);
                }
                eprintln!("{w}x{h} {name:<14} 2048-px tiles {a:7.1} ms | current {b:7.1} ms");
            }
        }
    }

    /// **The shader's output pinned across a speed change** (D-450's
    /// bit-identical gate). `APELLES_GRADE_REF=write` renders every grade at
    /// every size through the Colorist's own path and saves PNGs (lossless)
    /// into `APELLES_GRADE_REF_DIR`; `=compare` renders again and requires
    /// every pixel to equal the saved one. Run `write` on the shader before a
    /// change and `compare` after it. Ignored by default because it needs that
    /// directory and writes ~100 MB.
    #[test]
    #[ignore = "a before/after gate for changes to the grade shader; needs APELLES_GRADE_REF and _DIR"]
    fn the_colorist_render_is_unchanged_by_a_shader_change() {
        let mode = std::env::var("APELLES_GRADE_REF").expect("APELLES_GRADE_REF=write|compare");
        let dir =
            PathBuf::from(std::env::var("APELLES_GRADE_REF_DIR").expect("APELLES_GRADE_REF_DIR"));
        std::fs::create_dir_all(&dir).expect("reference dir");
        let ctx = render_core::init_gpu_context().expect("Colorist GPU context");
        let caches = OwnedRenderCaches::default();
        let mut failures = Vec::new();
        for (w, h) in SIZES {
            let img = picture(w, h, 7);
            for (name, grade) in grades() {
                let out = colorist_render(&ctx, &caches, &img, &grade);
                let path = dir.join(format!("{name}-{w}x{h}.png"));
                match mode.as_str() {
                    "write" => out.save(&path).expect("save reference"),
                    "compare" => {
                        let want = image::open(&path).expect("open reference").to_rgba8();
                        let (mut differing, mut max) = (0u64, 0u8);
                        for (p, q) in out.pixels().zip(want.pixels()) {
                            let d = (0..4).map(|c| p[c].abs_diff(q[c])).max().unwrap_or(0);
                            max = max.max(d);
                            differing += u64::from(d > 0);
                        }
                        eprintln!("{name} {w}x{h}: {differing} pixels differ, max {max}");
                        if differing > 0 {
                            failures.push(format!("{name} {w}x{h}: {differing} px, max {max}"));
                        }
                    }
                    other => panic!("unknown APELLES_GRADE_REF {other}"),
                }
            }
        }
        assert!(
            failures.is_empty(),
            "the Colorist render changed: {failures:#?}"
        );
    }
}
