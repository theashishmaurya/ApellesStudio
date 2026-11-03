//! **The process's one GPU render engine (D-449).**
//!
//! What it is: the `apelles_compositor::Engine` every timeline frame is drawn
//! by: the Edit tab's live preview (`chroma::edit::composite_video_frame`),
//! the Colorist's framed clip preview (`chroma::colorist_view`), and every
//! export segment worker (`chroma::edit_render`). One engine for playback and
//! export, as Final Cut Pro, DaVinci Resolve and Premiere Pro each run one
//! image engine for both.
//!
//! What it does: opens the engine on first use (one headless wgpu device,
//! `apelles_gpu`), hands it out to any thread, and turns its errors into the
//! `String` errors this crate's commands return.
//!
//! What it does NOT do: fall back to a CPU path. There is none (D-449): a
//! machine without a usable GPU cannot render a frame, and says so. After a
//! GPU error the engine is dropped, so the next frame opens a fresh device
//! rather than drawing on one that may have been lost; the failed frame itself
//! is still an error, never a silently different picture.

use std::sync::{Arc, Mutex};

use apelles_compositor::{ComposeError, Engine, FramePlan};
use apelles_types::Lut3d;
use image::RgbaImage;

static ENGINE: Mutex<Option<Arc<Engine>>> = Mutex::new(None);

/// The engine, opened on first use.
pub(crate) fn engine() -> Result<Arc<Engine>, String> {
    let mut slot = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = slot.as_ref() {
        return Ok(e.clone());
    }
    let engine = Arc::new(Engine::new().map_err(describe)?);
    *slot = Some(engine.clone());
    Ok(engine)
}

fn describe(e: ComposeError) -> String {
    format!("GPU compositor: {e}")
}

/// After a device-level failure, forget the engine so the next frame opens a
/// new device. A plan the device cannot hold (`TooLarge`) is a property of the
/// frame, not of the device, and keeps it.
fn settle<T>(r: Result<T, ComposeError>) -> Result<T, String> {
    match r {
        Ok(v) => Ok(v),
        Err(e) => {
            if matches!(e, ComposeError::Gpu(_) | ComposeError::Timeout(_)) {
                log::error!("GPU compositor: {e}; the device will be reopened for the next frame");
                *ENGINE.lock().unwrap_or_else(|p| p.into_inner()) = None;
            }
            Err(describe(e))
        }
    }
}

/// The engine's running totals (zero before it has opened). A render reads
/// them before and after to report its GPU stages (B-380).
pub(crate) fn stats() -> apelles_compositor::EngineStats {
    ENGINE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|e| e.stats())
        .unwrap_or_default()
}

/// Draw `plan`.
pub(crate) fn render(plan: &FramePlan) -> Result<RgbaImage, String> {
    submit(plan)?.wait()
}

/// Hand `plan` to the GPU and return at once; [`GpuFrame::wait`] for its
/// pixels. The export's writer thread does the waiting, so the GPU draws one
/// frame while the render worker decodes the next.
pub(crate) fn submit(plan: &FramePlan) -> Result<GpuFrame, String> {
    let engine = engine()?;
    settle(engine.submit(plan)).map(GpuFrame)
}

/// A frame on the GPU, not yet read back.
pub(crate) struct GpuFrame(apelles_compositor::PendingFrame);

impl GpuFrame {
    pub(crate) fn wait(self) -> Result<RgbaImage, String> {
        settle(self.0.wait())
    }
}

/// Apply a baked grade to a picture on the GPU (alpha untouched), for the one
/// caller that must draw on the graded pixels before they are composited: a
/// clip's highlighter strokes (D-396), drawn after its grade.
pub(crate) fn grade(img: &Arc<RgbaImage>, lut: &Arc<Lut3d>) -> Result<RgbaImage, String> {
    let engine = engine()?;
    settle(engine.grade(img, lut))
}

/// The engine on graded frames: against the Colorist's own render, and run to
/// run. Its parity with the CPU compositor it replaced was measured effect by
/// effect before that compositor was deleted (`docs/notes/
/// export-gpu-compositor.md` §15.4); the engine's own op-level contract is
/// tested in `apelles-compositor`.
#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use apelles_compositor::{Background, FramePlan, Layer, Source, Step};
    use apelles_types::adjustment::{AdjustmentLayer, AdjustmentOps};
    use image::{DynamicImage, Rgba, RgbaImage};

    /// PSNR over R, G, B (dB) and the largest channel difference.
    fn psnr_and_max(a: &RgbaImage, b: &RgbaImage) -> (f64, u8) {
        let (mut se, mut max) = (0f64, 0u8);
        for (p, q) in a.pixels().zip(b.pixels()) {
            for c in 0..3 {
                let d = p[c].abs_diff(q[c]);
                max = max.max(d);
                se += f64::from(d) * f64::from(d);
            }
        }
        let mse = se / (3.0 * f64::from(a.width()) * f64::from(a.height()));
        let psnr = if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (255.0f64 * 255.0 / mse).log10()
        };
        (psnr, max)
    }

    /// A deterministic textured picture: gradients plus fine detail.
    fn texture(w: u32, h: u32, seed: u32, alpha: bool) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| {
            let n = x
                .wrapping_mul(2_654_435_761)
                .wrapping_add(y.wrapping_mul(40_503))
                .wrapping_add(seed.wrapping_mul(97));
            let grad = |k: u32| ((x * 255 / w) * k + (y * 255 / h) * (3 - k)) / 3;
            Rgba([
                ((grad(1) + (n >> 27)) & 0xff) as u8,
                ((grad(2) + ((n >> 20) & 15)) & 0xff) as u8,
                ((x ^ y ^ seed) & 0xff) as u8,
                if alpha {
                    (((x + y) * 3) & 0xff) as u8
                } else {
                    255
                },
            ])
        })
    }

    fn layer(img: RgbaImage) -> Layer {
        let (w, h) = img.dimensions();
        Layer {
            source: Source::Rgba(Arc::new(img)),
            lut: None,
            crop: (0, 0, w, h),
            size: (w, h),
            origin: (0.0, 0.0),
            opacity: 1.0,
            corner_radius: 0.0,
            rotation_deg: 0.0,
        }
    }

    fn grade() -> serde_json::Value {
        serde_json::json!({ "exposure": 0.45, "contrast": 18.0, "saturation": 15.0,
            "temperature": 12.0, "tint": -6.0, "highlights": -25.0, "shadows": 20.0 })
    }

    fn graded_lut() -> Arc<apelles_types::Lut3d> {
        Arc::new(
            super::super::grade_lut::bake_lut3d(&grade(), apelles_types::lut3d::DEFAULT_SIZE, true)
                .expect("bake the grade through the Colorist shader")
                .lut,
        )
    }

    /// A graded clip's frame from the GPU engine against **the Colorist's own
    /// render of the same picture** (RapidRAW's grade shader, which baked the
    /// lattice the engine applies, D-256). Measured 2026-11-03: 49.2 dB, SSIM
    /// 0.9979, max 20, identical to what the CPU compositor scored against the
    /// same render. That gap is the 33³ lattice interpolating where the shader
    /// computes (D-449 §15.7), so the bound here guards against the engine
    /// drifting further from the Colorist, not against the lattice.
    #[test]
    fn a_graded_clip_stays_as_close_to_the_colorist_render_as_the_lattice_allows() {
        use crate::gpu_processing::RenderRequest;
        use crate::image_processing::get_all_adjustments_from_json;
        use crate::render_core::{self, OwnedRenderCaches};

        let picture = texture(1280, 720, 5, false);
        let mut l = layer(picture.clone());
        l.lut = Some(graded_lut());
        let gpu = super::render(&FramePlan {
            width: 1280,
            height: 720,
            background: Background::Solid([0, 0, 0, 255]),
            steps: vec![Step::Paint(l)],
        })
        .expect("GPU render");
        let ctx = render_core::init_gpu_context().expect("Colorist GPU context");
        let caches = OwnedRenderCaches::default();
        let colorist = render_core::render(
            &ctx,
            caches.as_ref(),
            &DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(picture).to_rgb8()),
            0,
            RenderRequest {
                adjustments: get_all_adjustments_from_json(&grade(), false, None),
                mask_bitmaps: &[],
                lut: None,
                roi: None,
            },
            "gpu_compositor_tests",
            false,
            None,
        )
        .expect("Colorist render")
        .to_rgba8();
        let (psnr, max) = psnr_and_max(&gpu, &colorist);
        eprintln!("graded clip, GPU engine vs Colorist render: PSNR {psnr:.2} dB, max {max}");
        assert!(psnr >= 48.5 && max <= 24, "PSNR {psnr:.2} dB, max {max}");
    }

    /// CLAUDE.md's render-path invariant on a graded fixture: a full explainer
    /// stack (base, a graded rounded PIP, a slide, a rotated card, a title, an
    /// adjustment clip) drawn five times gives the same bytes. The hash is
    /// printed so another day's run can be compared (`0438176df4831369` on the
    /// M4, 2026-11-03).
    #[test]
    fn a_graded_frame_hashes_the_same_every_time() {
        use std::hash::{Hash as _, Hasher as _};
        let photo = texture(1920, 1080, 3, false);
        let small = texture(640, 360, 7, false);
        let mut pip = layer(photo.clone());
        pip.lut = Some(graded_lut());
        pip.crop = (100, 50, 1800, 1030);
        pip.size = (720, 415);
        pip.origin = (1130.5, 610.25);
        pip.corner_radius = 28.0;
        let mut slide = layer(small.clone());
        slide.size = (900, 506);
        slide.origin = (-120.3, 80.0);
        slide.opacity = 0.9;
        let mut turned = layer(small);
        turned.size = (400, 225);
        turned.origin = (700.0, 120.0);
        turned.rotation_deg = 8.0;
        let mut title = layer(texture(1920, 1080, 11, true));
        title.opacity = 0.75;
        let ops = AdjustmentOps::build(
            &AdjustmentLayer {
                exposure: 0.3,
                contrast: 0.25,
                saturation: -0.4,
                temperature: 0.2,
                tint: -0.1,
            },
            0.8,
        );
        let plan = FramePlan {
            width: 1920,
            height: 1080,
            background: Background::Solid([0, 0, 0, 255]),
            steps: vec![
                Step::Paint(layer(photo)),
                Step::Paint(slide),
                Step::Paint(pip),
                Step::Paint(turned),
                Step::Paint(title),
                Step::Adjust(ops),
            ],
        };
        let first = super::render(&plan).expect("GPU render");
        let mut h = std::collections::hash_map::DefaultHasher::new();
        first.as_raw().hash(&mut h);
        eprintln!("graded full-stack frame: {:016x}", h.finish());
        for _ in 0..4 {
            assert_eq!(super::render(&plan).expect("GPU render"), first);
        }
    }

    /// What running the Colorist's own grade shader per frame would cost, the
    /// way `export::grade_frame` runs it (its own device, the frame uploaded,
    /// rendered, read back), against applying the baked lattice in the engine.
    /// The number D-449 §15.7's "per-frame shader" step is sized on. A
    /// measurement: `cargo test -p apelles --lib measure_the_colorist_shader --
    /// --ignored --nocapture`.
    #[test]
    #[ignore = "a timing measurement, not a pass/fail fact"]
    fn measure_the_colorist_shader_per_frame() {
        use crate::gpu_processing::RenderRequest;
        use crate::image_processing::get_all_adjustments_from_json;
        use crate::render_core::{self, OwnedRenderCaches};

        let ctx = render_core::init_gpu_context().expect("Colorist GPU context");
        let caches = OwnedRenderCaches::default();
        let lut = graded_lut();
        for (w, h) in [(1920u32, 1080u32), (3840, 2160)] {
            let picture = texture(w, h, 5, false);
            let rgb = DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(picture.clone()).to_rgb8());
            let shader = |_: ()| {
                render_core::render(
                    &ctx,
                    caches.as_ref(),
                    &rgb,
                    0,
                    RenderRequest {
                        adjustments: get_all_adjustments_from_json(&grade(), false, None),
                        mask_bitmaps: &[],
                        lut: None,
                        roi: None,
                    },
                    "gpu_compositor_measure",
                    false,
                    None,
                )
                .expect("Colorist render")
            };
            let mut l = layer(picture);
            l.lut = Some(lut.clone());
            let plan = FramePlan {
                width: w,
                height: h,
                background: Background::Solid([0, 0, 0, 255]),
                steps: vec![Step::Paint(l)],
            };
            let _ = shader(());
            let _ = super::render(&plan);
            let best = |f: &dyn Fn()| {
                (0..5)
                    .map(|_| {
                        let t = std::time::Instant::now();
                        f();
                        t.elapsed().as_secs_f64() * 1000.0
                    })
                    .fold(f64::INFINITY, f64::min)
            };
            let s = best(&|| {
                let _ = shader(());
            });
            let e = best(&|| {
                let _ = super::render(&plan).expect("GPU render");
            });
            eprintln!(
                "{w}x{h}: Colorist shader per frame {s:.1} ms; engine frame with the lattice {e:.1} ms"
            );
        }
    }
}
