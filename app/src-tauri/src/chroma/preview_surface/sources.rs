//! Prototype frame sources for the preview presenter (D-451): what stands in
//! for `apelles-compositor` until it draws on the presenter's device.
//!
//! - [`Pattern`]: a GPU test pattern drawn by a compute pass into a texture
//!   or into a packed RGBA8 buffer shaped like the engine's canvas. Its frames
//!   never touch the CPU, so it measures the presenter alone.
//! - [`Timeline`]: today's preview frame (`chroma::edit::timeline_frame_image`,
//!   decode + composite) uploaded into a texture. It shows real frames
//!   following the real layout; its upload is the cost the engine's own
//!   on-device output removes, and it is counted, not hidden.
//!
//! Neither is product code: the engine replaces both (notes §7).

use std::sync::Arc;
use std::time::Instant;

use super::presenter::FrameSource;
use crate::chroma::edit::{FrameIntent, timeline_frame_image};

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct PatternParams {
    size: [u32; 2],
    frame: u32,
    _pad: u32,
}

/// Where the pattern is drawn: the two shapes the seam accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PatternTarget {
    Texture,
    Packed,
}

pub(crate) struct Pattern {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    target: PatternTarget,
    size: (u32, u32),
    texture: wgpu::Texture,
    buffer: wgpu::Buffer,
    params: wgpu::Buffer,
    pipeline: wgpu::ComputePipeline,
    bind_group: wgpu::BindGroup,
}

impl Pattern {
    pub(crate) fn new(
        gpu: &apelles_gpu::GpuContext,
        target: PatternTarget,
        size: (u32, u32),
    ) -> Self {
        let device = gpu.device.clone();
        let (w, h) = (size.0.max(1), size.1.max(1));
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("preview test pattern"),
            source: wgpu::ShaderSource::Wgsl(include_str!("pattern.wgsl").into()),
        });
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("preview test pattern"),
            size: wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("preview test pattern (packed)"),
            size: u64::from(w) * u64::from(h) * 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        let params = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("preview test pattern params"),
            size: std::mem::size_of::<PatternParams>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("preview test pattern"),
            layout: None,
            module: &module,
            entry_point: Some(match target {
                PatternTarget::Texture => "to_texture",
                PatternTarget::Packed => "to_buffer",
            }),
            compilation_options: Default::default(),
            cache: None,
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let params_entry = wgpu::BindGroupEntry {
            binding: 0,
            resource: params.as_entire_binding(),
        };
        let out_entry = match target {
            PatternTarget::Texture => wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&view),
            },
            PatternTarget::Packed => wgpu::BindGroupEntry {
                binding: 2,
                resource: buffer.as_entire_binding(),
            },
        };
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("preview test pattern"),
            layout: &pipeline.get_bind_group_layout(0),
            entries: &[params_entry, out_entry],
        });
        Self {
            device,
            queue: gpu.queue.clone(),
            target,
            size: (w, h),
            texture,
            buffer,
            params,
            pipeline,
            bind_group,
        }
    }

    pub(crate) fn size(&self) -> (u32, u32) {
        self.size
    }

    /// Draw frame `frame`; returns when its GPU work is submitted (the
    /// hand-over instant).
    pub(crate) fn draw(&self, frame: u64) -> Instant {
        let params = PatternParams {
            size: [self.size.0, self.size.1],
            frame: (frame & u64::from(u32::MAX)) as u32,
            _pad: 0,
        };
        self.queue
            .write_buffer(&self.params, 0, bytemuck::bytes_of(&params));
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("preview test pattern"),
            });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("preview test pattern"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.dispatch_workgroups(self.size.0.div_ceil(16), self.size.1.div_ceil(16), 1);
        }
        self.queue.submit(Some(encoder.finish()));
        Instant::now()
    }

    pub(crate) fn source(&self) -> FrameSource<'_> {
        match self.target {
            PatternTarget::Texture => FrameSource::Texture(&self.texture),
            PatternTarget::Packed => FrameSource::PackedRgba8 {
                buffer: &self.buffer,
                width: self.size.0,
                height: self.size.1,
            },
        }
    }
}

/// Today's preview frame, uploaded.
pub(crate) struct Timeline {
    device: Arc<wgpu::Device>,
    queue: Arc<wgpu::Queue>,
    texture: Option<wgpu::Texture>,
    /// Bytes written to the GPU so far (the cost the engine's own output
    /// removes).
    pub uploaded_bytes: u64,
    /// The last decode + composite time, ms.
    pub last_render_ms: f64,
    /// The last upload time, ms.
    pub last_upload_ms: f64,
}

impl Timeline {
    pub(crate) fn new(gpu: &apelles_gpu::GpuContext) -> Self {
        Self {
            device: gpu.device.clone(),
            queue: gpu.queue.clone(),
            texture: None,
            uploaded_bytes: 0,
            last_render_ms: 0.0,
            last_upload_ms: 0.0,
        }
    }

    /// Render timeline position `pos` at `long_edge` and upload it. A position
    /// with nothing visible keeps the previous picture's size, in black.
    pub(crate) fn draw(
        &mut self,
        pos: u64,
        long_edge: u32,
        playing: bool,
    ) -> Result<Instant, String> {
        let intent = if playing {
            FrameIntent::Playing
        } else {
            FrameIntent::Single
        };
        let started = Instant::now();
        let image = timeline_frame_image(pos, Some(long_edge), intent)?;
        let rgba = match image {
            Some(img) => img.to_rgba8(),
            None => {
                let (w, h) = self
                    .texture
                    .as_ref()
                    .map(|t| (t.width(), t.height()))
                    .unwrap_or((16, 9));
                image::RgbaImage::from_pixel(w, h, image::Rgba([0, 0, 0, 255]))
            }
        };
        let rendered = Instant::now();
        let (w, h) = rgba.dimensions();
        let stale = self
            .texture
            .as_ref()
            .is_none_or(|t| (t.width(), t.height()) != (w, h));
        if stale {
            self.texture = Some(self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("preview timeline frame"),
                size: wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            }));
        }
        let texture = self
            .texture
            .as_ref()
            .ok_or("the timeline frame texture was not created")?;
        self.queue.write_texture(
            texture.as_image_copy(),
            rgba.as_raw(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * 4),
                rows_per_image: Some(h),
            },
            texture.size(),
        );
        self.queue.submit(None);
        let uploaded = Instant::now();
        self.uploaded_bytes += u64::from(w) * u64::from(h) * 4;
        self.last_render_ms = rendered.duration_since(started).as_secs_f64() * 1000.0;
        self.last_upload_ms = uploaded.duration_since(rendered).as_secs_f64() * 1000.0;
        Ok(uploaded)
    }

    pub(crate) fn source(&self) -> Option<FrameSource<'_>> {
        self.texture.as_ref().map(FrameSource::Texture)
    }
}
