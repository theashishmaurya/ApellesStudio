//! **The Colorist grade as a native pass of the GPU render engine (D-450).**
//!
//! What it is: a clip's saved Colorist grade, run by the Colorist's own grade
//! shader (RapidRAW's `GpuProcessor`, `gpu_processing.rs`) on the GPU render
//! engine's device, so a graded clip in the Edit preview and in the export is
//! the Colorist's picture rather than the baked-lattice approximation D-256
//! used. B-381.
//!
//! This file grows with the wave; its tests pin the shader's output so every
//! speed change to that shared shader can be held to bit-identical against
//! the Colorist render as it was before the change.

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
