//! The preview presenter (D-451): shows a frame the GPU engine drew, in the
//! preview's native layer, without the frame leaving the GPU.
//!
//! **The seam.** The engine (or anything else) hands over a [`PreviewFrame`]:
//! a [`FrameSource`] on the presenter's device ([`super::gpu`]) plus the
//! timeline position and the instant it was handed over. [`Presenter::present`]
//! acquires the layer's next drawable, runs one render pass that samples the
//! source into its [`Placement`], and presents. The source is only READ; the
//! caller keeps ownership and may reuse it for the next frame once `present`
//! returns (wgpu orders the work on the one queue).
//!
//! **What it does NOT do:** read anything back to the CPU (there is no
//! `MAP_READ` buffer and no `map_async` in this module), upload pixels, or
//! decide which frame to show.

use std::collections::VecDeque;
use std::num::NonZero;
use std::time::{Duration, Instant};

use serde::Serialize;

/// How many per-frame samples the stats keep (about 4 s at 60 Hz).
const STATS_CAPACITY: usize = 240;

/// How long `present` waits for the GPU to finish a frame before calling it a
/// fault rather than a slow frame.
const GPU_WAIT: Duration = Duration::from_secs(2);

/// Drawables in flight beyond the one on screen. 2 is wgpu's default and
/// what Core Animation itself uses (three drawables); 1 shortens the queue by
/// one refresh at the cost of stalls when a frame runs long.
const FRAME_LATENCY: u32 = 2;

/// One frame on the GPU, handed to the presenter.
pub(crate) struct PreviewFrame<'a> {
    pub source: FrameSource<'a>,
    /// The timeline position the frame is for (reported in the stats).
    pub position: u64,
    /// When the producer finished submitting the frame's GPU work.
    pub handed_over: Instant,
}

/// Where a frame's pixels are. Both live on [`super::gpu`]'s device.
pub(crate) enum FrameSource<'a> {
    /// An `Rgba8Unorm` texture with `TEXTURE_BINDING`.
    Texture(&'a wgpu::Texture),
    /// `apelles-compositor`'s canvas: a `STORAGE` buffer of `width * height`
    /// little-endian RGBA8 words, row-major, no row padding.
    PackedRgba8 {
        buffer: &'a wgpu::Buffer,
        width: u32,
        height: u32,
    },
}

/// Where the picture goes, in drawable pixels, and what fills the rest.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Placement {
    /// The drawable's size: the native view's size times the backing scale.
    pub drawable: (u32, u32),
    /// The picture box (x, y, width, height) in drawable pixels, origin top
    /// left. May extend past the drawable (a zoomed-in preview).
    pub picture: [f32; 4],
    /// The background, 0-1 display-referred RGBA.
    pub background: [f32; 4],
}

/// What one `present` measured.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PresentTiming {
    /// Waiting for a free drawable (Fifo pacing: this is where vsync shows up).
    pub acquire_ms: f64,
    /// Hand-over to `present()` called.
    pub to_present_ms: f64,
    /// Hand-over to the GPU having finished the present pass.
    pub to_gpu_done_ms: f64,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    picture: [f32; 4],
    background: [f32; 4],
    src_size: [u32; 2],
    _pad: [u32; 2],
}

/// Running per-frame measurements.
#[derive(Default)]
struct Stats {
    presented_at: VecDeque<Instant>,
    acquire_ms: VecDeque<f64>,
    to_present_ms: VecDeque<f64>,
    to_gpu_done_ms: VecDeque<f64>,
    frames: u64,
    reconfigures: u64,
    last_position: u64,
}

fn push<T>(q: &mut VecDeque<T>, v: T) {
    if q.len() == STATS_CAPACITY {
        q.pop_front();
    }
    q.push_back(v);
}

/// Min / median / p95 / max of a channel, in ms.
#[derive(Serialize, Default)]
pub(crate) struct Spread {
    pub n: usize,
    pub min: f64,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

fn spread(values: &VecDeque<f64>) -> Spread {
    if values.is_empty() {
        return Spread::default();
    }
    let mut v: Vec<f64> = values.iter().copied().collect();
    v.sort_by(f64::total_cmp);
    let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
    Spread {
        n: v.len(),
        min: v[0],
        p50: at(0.5),
        p95: at(0.95),
        max: v[v.len() - 1],
    }
}

/// A snapshot of the presenter's stats.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatsReport {
    pub frames: u64,
    pub reconfigures: u64,
    pub last_position: u64,
    /// Presents per second over the kept window.
    pub fps: f64,
    /// Intervals between consecutive presents.
    pub interval_ms: Spread,
    pub acquire_ms: Spread,
    pub to_present_ms: Spread,
    pub to_gpu_done_ms: Spread,
    pub drawable: (u32, u32),
    pub format: String,
}

/// Owns the surface and the one render pass.
pub(crate) struct Presenter {
    device: std::sync::Arc<wgpu::Device>,
    queue: std::sync::Arc<wgpu::Queue>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    texture_pipeline: wgpu::RenderPipeline,
    packed_pipeline: wgpu::RenderPipeline,
    texture_layout: wgpu::BindGroupLayout,
    packed_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    params: wgpu::Buffer,
    placement: Placement,
    stats: Stats,
}

impl Presenter {
    /// Build the presenter on `surface` (made from `gpu`'s instance).
    pub(crate) fn new(
        gpu: &apelles_gpu::GpuContext,
        surface: wgpu::Surface<'static>,
    ) -> Result<Self, String> {
        let caps = surface.get_capabilities(&gpu.adapter);
        // Non-sRGB, so the frame's bytes reach the drawable unchanged and the
        // layer's colour space tag alone says what they mean.
        let format = [
            wgpu::TextureFormat::Bgra8Unorm,
            wgpu::TextureFormat::Rgba8Unorm,
        ]
        .into_iter()
        .find(|f| caps.formats.contains(f))
        .ok_or_else(|| format!("no 8-bit non-sRGB surface format in {:?}", caps.formats))?;
        let alpha_mode = if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) {
            wgpu::CompositeAlphaMode::Opaque
        } else {
            caps.alpha_modes
                .first()
                .copied()
                .ok_or("the surface reports no alpha mode")?
        };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: 1,
            height: 1,
            present_mode: wgpu::PresentMode::Fifo,
            desired_maximum_frame_latency: FRAME_LATENCY,
            alpha_mode,
            view_formats: vec![],
        };
        let device = gpu.device.clone();
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("preview presenter"),
            source: wgpu::ShaderSource::Wgsl(include_str!("blit.wgsl").into()),
        });
        let params_entry = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let texture_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("preview presenter (texture)"),
            entries: &[
                params_entry,
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let packed_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("preview presenter (packed)"),
            entries: &[
                params_entry,
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline = |layout: &wgpu::BindGroupLayout, entry: &str| {
            let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("preview presenter"),
                bind_group_layouts: &[Some(layout)],
                immediate_size: 0,
            });
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("preview presenter"),
                layout: Some(&pl),
                vertex: wgpu::VertexState {
                    module: &module,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &module,
                    entry_point: Some(entry),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: NonZero::new(0),
                cache: None,
            })
        };
        let texture_pipeline = pipeline(&texture_layout, "fs_texture");
        let packed_pipeline = pipeline(&packed_layout, "fs_packed");
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("preview presenter"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("preview presenter params"),
            size: std::mem::size_of::<Params>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Ok(Self {
            device,
            queue: gpu.queue.clone(),
            surface,
            config,
            texture_pipeline,
            packed_pipeline,
            texture_layout,
            packed_layout,
            sampler,
            params,
            placement: Placement {
                drawable: (0, 0),
                picture: [0.0; 4],
                background: [0.0, 0.0, 0.0, 1.0],
            },
            stats: Stats::default(),
        })
    }

    /// Where the next frames go. Takes effect on the next [`Self::present`].
    pub(crate) fn set_placement(&mut self, placement: Placement) {
        self.placement = placement;
    }

    pub(crate) fn placement(&self) -> Placement {
        self.placement
    }

    /// Show `frame`. Blocks while every drawable is queued for the display
    /// (Fifo), then until the GPU has finished the pass, so the timing it
    /// returns is real rather than a submission time.
    pub(crate) fn present(&mut self, frame: &PreviewFrame<'_>) -> Result<PresentTiming, String> {
        let (w, h) = self.placement.drawable;
        if w == 0 || h == 0 {
            return Err("the preview surface has no size yet".to_string());
        }
        if (self.config.width, self.config.height) != (w, h) {
            self.config.width = w;
            self.config.height = h;
            self.surface.configure(&self.device, &self.config);
            self.stats.reconfigures += 1;
        }
        let acquire_started = Instant::now();
        let output = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&self.device, &self.config);
                self.stats.reconfigures += 1;
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(t)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
                    other => return Err(format!("no drawable after reconfigure: {other:?}")),
                }
            }
            other => return Err(format!("no drawable: {other:?}")),
        };
        let acquired = Instant::now();

        let src_size = match frame.source {
            FrameSource::Texture(t) => [t.width(), t.height()],
            FrameSource::PackedRgba8 { width, height, .. } => [width, height],
        };
        let params = Params {
            picture: self.placement.picture,
            background: self.placement.background,
            src_size,
            _pad: [0; 2],
        };
        self.queue
            .write_buffer(&self.params, 0, bytemuck::bytes_of(&params));
        let params_binding = wgpu::BindGroupEntry {
            binding: 0,
            resource: self.params.as_entire_binding(),
        };
        let texture_view;
        let (pipeline, bind_group) = match frame.source {
            FrameSource::Texture(t) => {
                texture_view = t.create_view(&wgpu::TextureViewDescriptor::default());
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("preview frame"),
                    layout: &self.texture_layout,
                    entries: &[
                        params_binding,
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&texture_view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                    ],
                });
                (&self.texture_pipeline, bg)
            }
            FrameSource::PackedRgba8 {
                buffer,
                width,
                height,
            } => {
                let need = u64::from(width) * u64::from(height) * 4;
                if buffer.size() < need {
                    return Err(format!(
                        "packed frame buffer holds {} bytes, {width}x{height} needs {need}",
                        buffer.size()
                    ));
                }
                let bg = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("preview frame"),
                    layout: &self.packed_layout,
                    entries: &[
                        params_binding,
                        wgpu::BindGroupEntry {
                            binding: 3,
                            resource: buffer.as_entire_binding(),
                        },
                    ],
                });
                (&self.packed_pipeline, bg)
            }
        };

        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("preview present"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("preview present"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        // Every pixel is written by the pass, so nothing to load.
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: NonZero::new(0),
            });
            pass.set_pipeline(pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        let index = self.queue.submit(Some(encoder.finish()));
        output.present();
        let presented = Instant::now();
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(index),
                timeout: Some(GPU_WAIT),
            })
            .map_err(|e| format!("the present pass did not finish: {e}"))?;
        let done = Instant::now();

        let ms = |a: Instant, b: Instant| b.saturating_duration_since(a).as_secs_f64() * 1000.0;
        let timing = PresentTiming {
            acquire_ms: ms(acquire_started, acquired),
            to_present_ms: ms(frame.handed_over, presented),
            to_gpu_done_ms: ms(frame.handed_over, done),
        };
        let s = &mut self.stats;
        s.frames += 1;
        s.last_position = frame.position;
        push(&mut s.presented_at, presented);
        push(&mut s.acquire_ms, timing.acquire_ms);
        push(&mut s.to_present_ms, timing.to_present_ms);
        push(&mut s.to_gpu_done_ms, timing.to_gpu_done_ms);
        Ok(timing)
    }

    pub(crate) fn reset_stats(&mut self) {
        self.stats = Stats::default();
    }

    pub(crate) fn stats(&self) -> StatsReport {
        let s = &self.stats;
        let intervals: VecDeque<f64> = s
            .presented_at
            .iter()
            .zip(s.presented_at.iter().skip(1))
            .map(|(a, b)| b.duration_since(*a).as_secs_f64() * 1000.0)
            .collect();
        let fps = match (s.presented_at.front(), s.presented_at.back()) {
            (Some(a), Some(b)) if s.presented_at.len() > 1 => {
                (s.presented_at.len() - 1) as f64 / b.duration_since(*a).as_secs_f64()
            }
            _ => 0.0,
        };
        StatsReport {
            frames: s.frames,
            reconfigures: s.reconfigures,
            last_position: s.last_position,
            fps,
            interval_ms: spread(&intervals),
            acquire_ms: spread(&s.acquire_ms),
            to_present_ms: spread(&s.to_present_ms),
            to_gpu_done_ms: spread(&s.to_gpu_done_ms),
            drawable: (self.config.width, self.config.height),
            format: format!("{:?}", self.config.format),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spread_of_an_empty_channel_is_zero() {
        let s = spread(&VecDeque::new());
        assert_eq!((s.n, s.p50, s.max), (0, 0.0, 0.0));
    }

    #[test]
    fn spread_reports_the_order_statistics() {
        let v: VecDeque<f64> = (1..=100).map(f64::from).collect();
        let s = spread(&v);
        assert_eq!((s.n, s.min, s.max), (100, 1.0, 100.0));
        assert_eq!(s.p50, 51.0);
        assert_eq!(s.p95, 95.0);
    }

    #[test]
    fn the_channel_keeps_only_the_last_window() {
        let mut q = VecDeque::new();
        for i in 0..(STATS_CAPACITY + 10) {
            push(&mut q, i);
        }
        assert_eq!(q.len(), STATS_CAPACITY);
        assert_eq!(q.front(), Some(&10));
    }
}
