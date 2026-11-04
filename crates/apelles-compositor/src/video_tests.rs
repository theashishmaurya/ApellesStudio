//! D-452 — the engine's Y'CbCr → RGB conversion against swscale, the
//! conversion the ffmpeg decode pipe produced for the same source (the pipe was
//! deleted by D-453; its command stays here as the reference).
//!
//! Each fixture is decoded twice: by the media engine (`apelles_media::
//! vt_decode`) and drawn 1:1 through this engine, and by ffmpeg to `rgb24` with
//! the exact command shape `decode_pipe` ran (the D-228 conform, hardware
//! decode, swscale's conversion). The two RGB pictures are compared per
//! channel: PSNR, the largest difference, and the share of channel values more
//! than one code apart.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use apelles_media::video::VideoInfo;
use apelles_media::vt_decode::Reader;
use image::RgbaImage;

use crate::{Background, Engine, FramePlan, Layer, Source, Step};

fn synth(dir: &Path, name: &str, lavfi: &str, args: &[&str]) -> PathBuf {
    let out = dir.join(name);
    let status = apelles_media::ffmpeg_locate::ffmpeg()
        .expect("ffmpeg")
        .args(["-v", "error", "-y", "-f", "lavfi", "-i", lavfi])
        .args(args)
        .arg(&out)
        .status()
        .expect("ffmpeg");
    assert!(status.success(), "could not build {name}");
    out
}

/// How ffmpeg converts the reference frame.
#[derive(Clone, Copy, Debug)]
enum Swscale {
    /// Exactly what the deleted ffmpeg decode pipe ran: hardware decode, then the
    /// auto-inserted scaler with its default flags (chroma replicated, the
    /// fast fixed-point tables).
    PipeDefault,
    /// swscale's precise path: interpolated chroma (`full_chroma_int`),
    /// accurate rounding. The same arithmetic the engine does.
    Accurate,
}

/// Nominal frame `n` through the decode pipe's command (the D-228 conform),
/// converted to rgb24 by swscale as `mode` says.
fn ffmpeg_rgb(path: &Path, info: &VideoInfo, n: u64, mode: Swscale) -> image::RgbImage {
    let grid = apelles_media::conform::from_frame(info, n);
    let mut cmd = apelles_media::ffmpeg_locate::ffmpeg().expect("ffmpeg");
    cmd.args(["-v", "error"]);
    if matches!(mode, Swscale::PipeDefault) {
        cmd.args(["-hwaccel", "videotoolbox"]);
    }
    cmd.args(&grid.input_args).arg("-i").arg(path).args(["-an"]);
    let flags = match mode {
        Swscale::PipeDefault => None,
        Swscale::Accurate => Some("scale=flags=bilinear+accurate_rnd+full_chroma_int"),
    };
    if let Some(vf) = grid.vf(flags) {
        cmd.args(["-vf", &vf]);
    }
    let out = cmd
        .args(["-fps_mode", "passthrough", "-frames:v", "1"])
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output()
        .expect("ffmpeg");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    image::RgbImage::from_raw(info.resolution.width, info.resolution.height, out.stdout)
        .expect("frame size")
}

fn engine_rgb(engine: &Arc<Engine>, path: &Path, info: &VideoInfo, n: u64) -> RgbaImage {
    let mut reader = Reader::open(path, info, n).expect("open");
    let frame = reader.next_frame().expect("frame");
    let (w, h) = frame.buffer.dimensions();
    let plan = FramePlan {
        width: w,
        height: h,
        background: Background::Solid([0, 0, 0, 255]),
        steps: vec![Step::Paint(Layer {
            source: Source::Video(frame),
            crop: (0, 0, w, h),
            size: (w, h),
            origin: (0.0, 0.0),
            opacity: 1.0,
            corner_radius: 0.0,
            rotation_deg: 0.0,
        })],
    };
    engine.render(&plan).expect("render")
}

struct Diff {
    psnr: f64,
    max: u8,
    over_one: f64,
}

fn diff(a: &RgbaImage, b: &image::RgbImage) -> Diff {
    let (mut se, mut max, mut over, mut n) = (0f64, 0u8, 0u64, 0u64);
    for (p, q) in a.pixels().zip(b.pixels()) {
        for c in 0..3 {
            let d = p[c].abs_diff(q[c]);
            max = max.max(d);
            se += f64::from(d) * f64::from(d);
            over += u64::from(d > 1);
            n += 1;
        }
    }
    let mse = se / n as f64;
    Diff {
        psnr: if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (255.0f64 * 255.0 / mse).log10()
        },
        max,
        over_one: over as f64 / n as f64,
    }
}

/// The fixtures: every layout the decoder requests, and the tags that pick
/// the matrix and range.
fn fixtures(dir: &Path) -> Vec<(&'static str, PathBuf)> {
    let src = "testsrc2=size=640x360:rate=30:duration=1";
    vec![
        (
            "h264 4:2:0 8-bit bt709 tv",
            synth(
                dir,
                "a.mp4",
                src,
                &[
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-colorspace",
                    "bt709",
                    "-color_primaries",
                    "bt709",
                    "-color_trc",
                    "bt709",
                ],
            ),
        ),
        (
            "h264 4:2:0 8-bit untagged tv",
            synth(
                dir,
                "b.mp4",
                src,
                &["-c:v", "libx264", "-pix_fmt", "yuv420p"],
            ),
        ),
        (
            "h264 4:2:0 8-bit bt709 pc",
            synth(
                dir,
                "c.mp4",
                src,
                &[
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuvj420p",
                    "-colorspace",
                    "bt709",
                    "-color_range",
                    "pc",
                ],
            ),
        ),
        (
            "hevc 4:2:0 10-bit bt709 tv",
            synth(
                dir,
                "d.mov",
                src,
                &[
                    "-c:v",
                    "libx265",
                    "-pix_fmt",
                    "yuv420p10le",
                    "-tag:v",
                    "hvc1",
                    "-colorspace",
                    "bt709",
                    "-color_primaries",
                    "bt709",
                    "-color_trc",
                    "bt709",
                    "-x265-params",
                    "log-level=error",
                ],
            ),
        ),
        (
            "prores 4:2:2 10-bit bt709 tv",
            synth(
                dir,
                "e.mov",
                src,
                &[
                    "-c:v",
                    "prores_ks",
                    "-profile:v",
                    "3",
                    "-pix_fmt",
                    "yuv422p10le",
                    "-colorspace",
                    "bt709",
                    "-color_primaries",
                    "bt709",
                    "-color_trc",
                    "bt709",
                ],
            ),
        ),
    ]
}

/// The largest per-channel difference allowed against swscale's precise
/// conversion: rounding of the same arithmetic (f32 on the GPU, swscale's own
/// fixed point).
const ACCURATE_MAX: u8 = 1;

/// The measurement behind the tolerance, printed with `--nocapture`, against
/// both of swscale's conversions.
#[test]
fn the_ycbcr_conversion_matches_swscale_within_a_code_value() {
    let engine = Arc::new(Engine::new().expect("engine"));
    let dir = tempfile::tempdir().expect("tempdir");
    for (name, path) in fixtures(dir.path()) {
        let info = apelles_media::video::probe(&path).expect("probe");
        for n in [0u64, 17] {
            let got = engine_rgb(&engine, &path, &info, n);
            for mode in [Swscale::Accurate, Swscale::PipeDefault] {
                let want = ffmpeg_rgb(&path, &info, n, mode);
                let d = diff(&got, &want);
                if let Ok(dump) = std::env::var("YCBCR_DUMP") {
                    let tag = format!("{}-{n}", name.replace(' ', "_").replace(':', ""));
                    got.save(format!("{dump}/{tag}-engine.png")).expect("save");
                    want.save(format!("{dump}/{tag}-swscale.png"))
                        .expect("save");
                }
                println!(
                    "{name:32} frame {n:2} vs swscale {:11}: PSNR {:6.2} dB, max {:3}, >1 code {:.4}%",
                    format!("{mode:?}"),
                    d.psnr,
                    d.max,
                    d.over_one * 100.0
                );
                if matches!(mode, Swscale::Accurate) {
                    assert!(d.max <= ACCURATE_MAX, "{name}: max {} codes", d.max);
                }
            }
        }
    }
}

#[test]
fn a_video_frame_renders_to_the_same_bytes_every_time() {
    let engine = Arc::new(Engine::new().expect("engine"));
    let dir = tempfile::tempdir().expect("tempdir");
    let (_, path) = fixtures(dir.path()).swap_remove(3);
    let info = apelles_media::video::probe(&path).expect("probe");
    let first = engine_rgb(&engine, &path, &info, 9);
    for _ in 0..4 {
        assert!(
            engine_rgb(&engine, &path, &info, 9) == first,
            "same frame, different bytes"
        );
    }
}

/// A textured, non-flat canvas: gradients in all three channels plus a
/// pattern, so chroma averaging and every matrix term are exercised.
fn test_canvas(w: u32, h: u32) -> RgbaImage {
    RgbaImage::from_fn(w, h, |x, y| {
        let r = (x * 255 / w.max(1)) as u8;
        let g = (y * 255 / h.max(1)) as u8;
        let b = (((x / 7) ^ (y / 5)) * 37 % 256) as u8;
        image::Rgba([r, g, b, 255])
    })
}

fn canvas_plan(img: &RgbaImage) -> FramePlan {
    FramePlan {
        width: img.width(),
        height: img.height(),
        background: Background::Image(Arc::new(img.clone())),
        steps: vec![],
    }
}

/// The NV12 the output kernel should write for `img`: Rec.709, video range,
/// chroma the mean of each 2x2 block — in f64, rounded half up.
fn reference_nv12(img: &RgbaImage) -> (Vec<u8>, Vec<u8>) {
    let (w, h) = img.dimensions();
    let (kr, kb) = (0.2126f64, 0.0722f64);
    let kg = 1.0 - kr - kb;
    let rgb = |x: u32, y: u32| {
        let p = img.get_pixel(x.min(w - 1), y.min(h - 1));
        (
            f64::from(p[0]) / 255.0,
            f64::from(p[1]) / 255.0,
            f64::from(p[2]) / 255.0,
        )
    };
    let q = |v: f64| (v + 0.5).floor().clamp(0.0, 255.0) as u8;
    let mut luma = Vec::with_capacity((w * h) as usize);
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = rgb(x, y);
            luma.push(q(16.0 + 219.0 * (kr * r + kg * g + kb * b)));
        }
    }
    let mut chroma = Vec::new();
    for cy in 0..h.div_ceil(2) {
        for cx in 0..w.div_ceil(2) {
            let mut s = (0.0, 0.0, 0.0);
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let (r, g, b) = rgb(cx * 2 + dx, cy * 2 + dy);
                s = (s.0 + r / 4.0, s.1 + g / 4.0, s.2 + b / 4.0);
            }
            let yy = kr * s.0 + kg * s.1 + kb * s.2;
            chroma.push(q(128.0 + 224.0 * (s.2 - yy) / (2.0 * (1.0 - kb))));
            chroma.push(q(128.0 + 224.0 * (s.0 - yy) / (2.0 * (1.0 - kr))));
        }
    }
    (luma, chroma)
}

fn max_diff(a: &[u8], b: &[u8]) -> u8 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

#[test]
fn a_frame_written_into_an_encoder_buffer_is_rec709_nv12_of_the_canvas() {
    use apelles_media::vt_encode::{H264_QUALITY, SegmentEncoder, VideoCodec};
    let engine = Arc::new(Engine::new().expect("engine"));
    let dir = tempfile::tempdir().expect("tempdir");
    // 1918 wide: neither the luma nor the chroma row is a multiple of 256
    // bytes, so the padded copy is exercised.
    let (w, h) = (1918, 1080);
    let enc = SegmentEncoder::create(
        &dir.path().join("t.mp4"),
        VideoCodec::H264 {
            quality: H264_QUALITY,
        },
        (w, h),
        (30, 1),
    )
    .expect("encoder");
    let img = test_canvas(w, h);
    let target = enc.pixel_buffer().expect("buffer");
    engine
        .submit_into(&canvas_plan(&img), &target, crate::OutputFormat::Nv12Rec709)
        .expect("submit")
        .wait()
        .expect("wait");
    let (want_y, want_c) = reference_nv12(&img);
    let (got_y, _, _) = apelles_media::vt_decode::read_plane(&target, 0);
    let (got_c, _, _) = apelles_media::vt_decode::read_plane(&target, 1);
    assert!(
        max_diff(&got_y, &want_y) <= 1,
        "luma off by {}",
        max_diff(&got_y, &want_y)
    );
    assert!(
        max_diff(&got_c, &want_c) <= 1,
        "chroma off by {}",
        max_diff(&got_c, &want_c)
    );
}

#[test]
fn a_frame_written_for_prores_is_the_canvas_as_bgra() {
    use apelles_media::vt_encode::{SegmentEncoder, VideoCodec};
    let engine = Arc::new(Engine::new().expect("engine"));
    let dir = tempfile::tempdir().expect("tempdir");
    let (w, h) = (642, 360);
    let enc = SegmentEncoder::create(
        &dir.path().join("t.mov"),
        VideoCodec::ProResHq,
        (w, h),
        (25, 1),
    )
    .expect("encoder");
    let img = test_canvas(w, h);
    let target = enc.pixel_buffer().expect("buffer");
    engine
        .submit_into(&canvas_plan(&img), &target, crate::OutputFormat::Bgra)
        .expect("submit")
        .wait()
        .expect("wait");
    let (got, _, _) = apelles_media::vt_decode::read_plane(&target, 0);
    let want: Vec<u8> = img
        .pixels()
        .flat_map(|p| [p[2], p[1], p[0], p[3]])
        .collect();
    assert!(got == want, "BGRA differs from the canvas");
}

/// D-452 + D-450 — a graded clip from a media-engine source: the grade
/// shader's half-float input written straight from the decoder's planes is
/// exactly the input written from the same frame converted to RGBA first.
#[test]
fn a_video_frame_feeds_the_grade_the_same_half_floats_as_its_rgba() {
    let engine = Arc::new(Engine::new().expect("engine"));
    let dir = tempfile::tempdir().expect("tempdir");
    let (_, path) = fixtures(dir.path()).swap_remove(0);
    let info = apelles_media::video::probe(&path).expect("probe");
    let mut reader = Reader::open(&path, &info, 5).expect("open");
    let frame = reader.next_frame().expect("frame");
    let (w, h) = frame.buffer.dimensions();
    let (device, queue) = engine.device_and_queue();
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("test f16"),
        size: wgpu::Extent3d {
            width: w,
            height: h,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let read = || -> Vec<u8> {
        let row = (w * 8).next_multiple_of(256);
        let staging = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("test f16 read"),
            size: u64::from(row * h),
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
                    bytes_per_row: Some(row),
                    rows_per_image: Some(h),
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
            .expect("poll");
        slice.get_mapped_range().to_vec()
    };
    let rgba = engine_rgb(&engine, &path, &info, 5);
    engine
        .write_f16_texture(&Source::Video(frame), &target)
        .expect("from the planes");
    let from_planes = read();
    engine
        .write_f16_texture(&Source::Rgba(Arc::new(rgba)), &target)
        .expect("from RGBA");
    assert!(read() == from_planes, "the two half-float inputs differ");
}
