//! Engine tests against a real GPU. Parity with the CPU compositor this
//! engine replaced was measured op by op in `app/src-tauri` while both existed
//! (`docs/notes/export-gpu-compositor.md` §15); these pin the engine's own
//! contract: exact copies stay exact, identities stay identities, and the same
//! plan gives the same bytes every time.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use apelles_types::adjustment::AdjustmentOps;
use image::{Pixel as _, Rgba, RgbaImage};

use crate::{Background, Engine, FramePlan, Layer, Source, Step};

fn engine() -> &'static Arc<Engine> {
    static ENGINE: OnceLock<Arc<Engine>> = OnceLock::new();
    ENGINE.get_or_init(|| match Engine::new() {
        Ok(e) => Arc::new(e),
        Err(e) => panic!("these tests need the GPU (v1 runs on Apple Silicon only): {e}"),
    })
}

/// A deterministic textured picture: every channel varies, alpha included.
fn texture(w: u32, h: u32, alpha: bool) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let v = x
            .wrapping_mul(2_654_435_761)
            .wrapping_add(y.wrapping_mul(40_503));
        Rgba([
            (v >> 3) as u8,
            (x * 7 + y * 3) as u8,
            (x ^ y) as u8,
            if alpha { (v >> 11) as u8 } else { 255 },
        ])
    })
}

fn layer(src: RgbaImage) -> Layer {
    let (w, h) = src.dimensions();
    Layer {
        source: Source::Rgba(Arc::new(src)),
        crop: (0, 0, w, h),
        size: (w, h),
        origin: (0.0, 0.0),
        opacity: 1.0,
        corner_radius: 0.0,
        rotation_deg: 0.0,
    }
}

fn plan(w: u32, h: u32, steps: Vec<Step>) -> FramePlan {
    FramePlan {
        width: w,
        height: h,
        background: Background::Solid([0, 0, 0, 255]),
        steps,
    }
}

#[test]
fn an_opaque_one_to_one_layer_is_copied_exactly() {
    let src = texture(64, 48, false);
    let out = engine()
        .render(&plan(64, 48, vec![Step::Paint(layer(src.clone()))]))
        .unwrap();
    assert_eq!(out, src);
}

#[test]
fn an_rgb_source_is_widened_exactly() {
    let rgba = texture(37, 21, false);
    let rgb = image::DynamicImage::ImageRgba8(rgba.clone()).to_rgb8();
    let mut l = layer(rgba.clone());
    l.source = Source::Rgb(Arc::new(rgb));
    let out = engine()
        .render(&plan(37, 21, vec![Step::Paint(l)]))
        .unwrap();
    assert_eq!(out, rgba);
}

#[test]
fn a_translucent_plate_blends_as_the_image_crate_does() {
    let mut l = layer(RgbaImage::new(1, 1));
    l.source = Source::Solid {
        width: 16,
        height: 8,
        rgba: [200, 40, 90, 255],
    };
    l.crop = (0, 0, 16, 8);
    l.size = (16, 8);
    l.opacity = 0.37;
    let bg = texture(16, 8, false);
    let mut p = plan(16, 8, vec![Step::Paint(l)]);
    p.background = Background::Image(Arc::new(bg.clone()));
    let out = engine().render(&p).unwrap();
    let a = (255.0f32 * 0.37).round() as u8;
    for (x, y, px) in out.enumerate_pixels() {
        let mut want = *bg.get_pixel(x, y);
        want.blend(&Rgba([200, 40, 90, a]));
        assert_eq!(*px, want, "pixel {x},{y}");
    }
}

#[test]
fn an_identity_adjustment_changes_nothing() {
    let src = texture(40, 30, false);
    let l = layer(src.clone());
    let out = engine()
        .render(&plan(
            40,
            30,
            vec![Step::Paint(l), Step::Adjust(AdjustmentOps::IDENTITY)],
        ))
        .unwrap();
    assert_eq!(out, src);
}

/// Every one of the 2^24 RGB inputs, through operators built from real layer
/// values (`AdjustmentOps::build`, as an adjustment clip builds them), against
/// the CPU definition `apply_rgb8`. The tables reproduce stage 1 exactly; stage
/// 2's fixed-point sum can land on the other side of an exact half from the
/// CPU's f64 `Σ / 255 · 255` round trip, so a difference of one code value is
/// allowed and the share of such inputs is bounded.
#[test]
fn the_adjustment_matches_its_cpu_definition_on_every_rgb_value() {
    use apelles_types::adjustment::AdjustmentLayer;
    let layers = [
        AdjustmentLayer {
            exposure: 0.3,
            contrast: 0.25,
            saturation: -0.4,
            temperature: 0.2,
            tint: -0.1,
        },
        AdjustmentLayer {
            exposure: -0.7,
            contrast: -0.35,
            saturation: 0.6,
            temperature: -0.45,
            tint: 0.3,
        },
    ];
    let cube = Arc::new(RgbaImage::from_fn(4096, 4096, |x, y| {
        let v = y * 4096 + x;
        Rgba([
            (v & 0xff) as u8,
            ((v >> 8) & 0xff) as u8,
            (v >> 16) as u8,
            255,
        ])
    }));
    for (li, l) in layers.iter().enumerate() {
        for mix in [1.0, 0.55] {
            let ops = AdjustmentOps::build(l, mix);
            let mut p = plan(4096, 4096, vec![Step::Adjust(ops)]);
            p.background = Background::Image(cube.clone());
            let out = engine().render(&p).unwrap();
            let mut off_by_one = 0u64;
            for (x, y, px) in out.enumerate_pixels() {
                let s = cube.get_pixel(x, y);
                let want = ops.apply_rgb8([s[0], s[1], s[2]]);
                for c in 0..3 {
                    let d = (i32::from(px[c]) - i32::from(want[c])).abs();
                    assert!(
                        d <= 1,
                        "layer {li} mix {mix}: {s:?} channel {c}: {} vs {}",
                        px[c],
                        want[c]
                    );
                    off_by_one += d as u64;
                }
                assert_eq!(px[3], 255);
            }
            let share = off_by_one as f64 / (3.0 * 16_777_216.0);
            eprintln!(
                "adjustment layer {li} mix {mix}: {off_by_one} channel values off by one ({share:.2e})"
            );
            assert!(share < 1e-4, "{share}");
        }
    }
}

/// A picture already on the device (D-450: a clip the Colorist's shader
/// graded), handed over as a padded-stride buffer, is copied exactly, and
/// [`Engine::read_gpu_image`] reads it back exactly, padding stripped.
#[test]
fn a_gpu_source_with_a_padded_stride_is_copied_exactly() {
    let src = texture(37, 21, true);
    let row_pixels = 64u32; // 256 bytes: a texture-to-buffer copy's row
    let mut padded = vec![0u8; (row_pixels * 21 * 4) as usize];
    for y in 0..21usize {
        let from = &src.as_raw()[y * 37 * 4..(y + 1) * 37 * 4];
        padded[y * 256..y * 256 + 37 * 4].copy_from_slice(from);
    }
    let buffer = {
        use wgpu::util::DeviceExt as _;
        let (device, _) = engine().device_and_queue();
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("test gpu image"),
            contents: &padded,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        })
    };
    let image = crate::GpuImage {
        buffer,
        width: 37,
        height: 21,
        row_pixels,
    };
    assert_eq!(engine().read_gpu_image(&image).unwrap(), src);
    // Painted 1:1 and opaque, so source-over is a plain replace and the canvas
    // must equal the picture (the translucent blend's own ±1 is pinned by
    // `a_translucent_plate_blends_as_the_image_crate_does`).
    let opaque = RgbaImage::from_fn(37, 21, |x, y| {
        let p = src.get_pixel(x, y);
        Rgba([p[0], p[1], p[2], 255])
    });
    let mut bytes = vec![0u8; (row_pixels * 21 * 4) as usize];
    for y in 0..21usize {
        bytes[y * 256..y * 256 + 37 * 4]
            .copy_from_slice(&opaque.as_raw()[y * 37 * 4..(y + 1) * 37 * 4]);
    }
    let buffer = {
        use wgpu::util::DeviceExt as _;
        let (device, _) = engine().device_and_queue();
        device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("test gpu image, opaque"),
            contents: &bytes,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        })
    };
    let mut l = layer(RgbaImage::new(1, 1));
    l.source = Source::Gpu(crate::GpuImage {
        buffer,
        width: 37,
        height: 21,
        row_pixels,
    });
    l.crop = (0, 0, 37, 21);
    l.size = (37, 21);
    let out = engine()
        .render(&plan(37, 21, vec![Step::Paint(l)]))
        .unwrap();
    assert_eq!(out, opaque);
}

/// The grade shader's input, filled on the GPU, is bit-identical to what the
/// Colorist fills it with on the CPU (`image`'s `to_rgba32f`, then
/// `half::f16::from_f32`), for every 8-bit value of every channel.
#[test]
fn the_half_float_input_matches_the_colorists_own_conversion() {
    let (device, queue) = engine().device_and_queue();
    let img = RgbaImage::from_fn(256, 4, |x, y| {
        let v = x as u8;
        Rgba([v, 255 - v, v ^ (y as u8 * 37), if y == 3 { v } else { 255 }])
    });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("test f16"),
        size: wgpu::Extent3d {
            width: 256,
            height: 4,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    for source in [
        Source::Rgba(Arc::new(img.clone())),
        Source::Rgb(Arc::new(
            image::DynamicImage::ImageRgba8(img.clone()).to_rgb8(),
        )),
    ] {
        let rgba = match &source {
            Source::Rgb(rgb) => image::DynamicImage::ImageRgb8(rgb.as_ref().clone()).to_rgba8(),
            _ => img.clone(),
        };
        engine().write_f16_texture(&source, &target).unwrap();
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test f16 read"),
            size: 256 * 4 * 8,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = device.create_command_encoder(&Default::default());
        enc.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256 * 8),
                    rows_per_image: Some(4),
                },
            },
            target.size(),
        );
        queue.submit(Some(enc.finish()));
        let slice = staging.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        device
            .poll(wgpu::PollType::Wait {
                submission_index: None,
                timeout: Some(std::time::Duration::from_secs(20)),
            })
            .unwrap();
        let got: Vec<u16> = bytemuck::cast_slice(&slice.get_mapped_range()).to_vec();
        let want: Vec<u16> = image::DynamicImage::ImageRgba8(rgba)
            .to_rgba32f()
            .into_raw()
            .into_iter()
            .map(|f| half::f16::from_f32(f).to_bits())
            .collect();
        assert_eq!(got, want);
    }
}

/// CLAUDE.md's render-path invariant on this engine: one plan exercising every
/// kernel (fused magnify with rounded corners, minify, rotation,
/// translucency, an adjustment), drawn repeatedly, gives identical bytes.
#[test]
fn a_frame_renders_to_the_same_bytes_every_time() {
    let base = texture(320, 180, false);
    let pip = texture(400, 300, true);
    let mut back = layer(base);
    back.size = (640, 360);
    back.corner_radius = 24.0;
    let mut small = layer(pip.clone());
    small.crop = (20, 10, 380, 290);
    small.size = (200, 140);
    small.origin = (300.4, 40.6);
    small.opacity = 0.8;
    small.corner_radius = 12.0;
    let mut turned = layer(pip);
    turned.size = (150, 110);
    turned.origin = (40.0, 200.0);
    turned.rotation_deg = 17.0;
    let p = plan(
        640,
        360,
        vec![
            Step::Paint(back),
            Step::Paint(small),
            Step::Paint(turned),
            Step::Adjust(AdjustmentOps {
                gain: [1.1, 1.0, 0.9],
                offset: 0.01,
                sat: [[0.9, 0.05, 0.05], [0.05, 0.9, 0.05], [0.05, 0.05, 0.9]],
            }),
        ],
    );
    let first = engine().render(&p).unwrap();
    for _ in 0..5 {
        assert_eq!(engine().render(&p).unwrap(), first);
    }
    // And from several threads at once: concurrent frames share the device
    // and the pool, never a buffer.
    std::thread::scope(|s| {
        let handles: Vec<_> = (0..4).map(|_| s.spawn(|| engine().render(&p))).collect();
        for h in handles {
            assert_eq!(h.join().unwrap().unwrap(), first);
        }
    });
}

/// A frame submitted and then dropped without being waited for (an export
/// whose encoder died with frames still queued) must not hand a still-mapped
/// staging buffer to the next frame: that frame would fail validation.
#[test]
fn a_frame_dropped_unread_does_not_poison_the_next_one() {
    let p = plan(320, 180, vec![Step::Paint(layer(texture(320, 180, false)))]);
    for _ in 0..4 {
        drop(engine().submit(&p).unwrap());
    }
    let want = engine().render(&p).unwrap();
    for _ in 0..4 {
        assert_eq!(engine().render(&p).unwrap(), want);
    }
}

/// Where a frame's CPU time goes on the engine side: recording + upload
/// (`submit`) and the wait + read-back, for an explainer-shaped 1080p frame
/// (a full-frame RGB base, a minified rounded PIP, a title). A measurement,
/// not an assertion: `cargo test -p apelles-compositor -- --ignored --nocapture`.
#[test]
#[ignore = "a timing measurement, not a pass/fail fact"]
fn measure_the_cost_of_one_frame() {
    let rgb = |w, h| Arc::new(image::DynamicImage::ImageRgba8(texture(w, h, false)).to_rgb8());
    let base = rgb(1920, 1080);
    let pip_src = rgb(1920, 1080);
    let title = Arc::new(texture(1920, 1080, true));
    let mut steps = Vec::new();
    let mut b = layer(RgbaImage::new(1, 1));
    b.source = Source::Rgb(base);
    b.crop = (0, 0, 1920, 1080);
    b.size = (1920, 1080);
    steps.push(Step::Paint(b));
    let mut p = layer(RgbaImage::new(1, 1));
    p.source = Source::Rgb(pip_src);
    p.crop = (0, 0, 1920, 1080);
    p.size = (640, 360);
    p.origin = (1200.0, 650.0);
    p.corner_radius = 24.0;
    steps.push(Step::Paint(p));
    let mut t = layer(RgbaImage::new(1, 1));
    t.source = Source::Rgba(title.clone());
    t.crop = (0, 0, 1920, 1080);
    t.size = (1920, 1080);
    steps.push(Step::Paint(t));
    let p = plan(1920, 1080, steps);
    let _ = engine().render(&p).unwrap();
    let n = 60;
    let (mut submit, mut wait) = (Duration::ZERO, Duration::ZERO);
    for _ in 0..n {
        let s = Instant::now();
        let f = engine().submit(&p).unwrap();
        submit += s.elapsed();
        let w = Instant::now();
        f.wait().unwrap();
        wait += w.elapsed();
    }
    eprintln!(
        "1080p explainer frame: submit (record + upload) {:.2} ms, wait + read-back {:.2} ms",
        submit.as_secs_f64() * 1000.0 / n as f64,
        wait.as_secs_f64() * 1000.0 / n as f64
    );
}
