//! The preview presenter (D-451, made the product preview by D-454): shows a
//! frame the GPU engine drew, in the preview's native layer, without the frame
//! leaving the GPU.
//!
//! **Two steps, two submissions.**
//! 1. [`Presenter::write_frame`] is the engine's preview terminal (the third
//!    one beside the read-back and the encoder's pixel buffer): recorded into
//!    the ENGINE's own command buffer, it unpacks the finished canvas into the
//!    presenter's retained frame texture, 1:1, exact bytes. The canvas can go
//!    back to the engine's pool as soon as that submission is done.
//! 2. [`Presenter::present`] acquires the layer's next drawable and draws the
//!    retained frame into its picture box (linear filter) with the letterbox
//!    around it, then presents. A playback refresh that has no new frame, a
//!    moved or resized preview and a zoom all re-present the retained frame
//!    without asking the engine for anything.
//!
//! The retained frame is also what `debug_screenshot` reads back on demand
//! (debug builds only, [`Presenter::read_frame`]), as the Colorist's surface
//! does (B-151).
//!
//! **Pacing.** `Fifo` with a frame latency of 1: Core Animation holds two
//! drawables, one on screen and at most one queued, so a present never runs
//! more than one refresh ahead of the glass and `get_current_texture` blocks
//! until the display has taken the previous one. The playback loop
//! (`super::player`) is clocked by exactly that wait.
//!
//! **What it does NOT do:** read anything back on the frame path (the only
//! `MAP_READ` buffer here is the debug screenshot's), upload pixels, or
//! decide which frame to show.

use std::cell::RefCell;
use std::num::NonZero;
use std::sync::Arc;
use std::time::Instant;

use super::native_view::PREVIEW_SPACE;
use crate::chroma::gpu_compositor::RenderDevice;

/// Drawables queued beyond the one on screen: one, so the picture is never
/// more than one refresh behind the clock that chose it (D-454; the
/// prototype's 2 queued up to two refreshes, `docs/notes/preview-gpu-surface.md`
/// §5).
const FRAME_LATENCY: u32 = 1;

/// The retained frame's format: what the engine's canvas holds, unpacked.
const FRAME_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Where the picture goes, in drawable pixels, and what fills the rest.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Placement {
    /// The drawable's size: the native view's size times the backing scale.
    pub drawable: (u32, u32),
    /// The picture box (x, y, width, height) in drawable pixels, origin top
    /// left. May extend past the drawable (a zoomed-in preview).
    pub picture: [f32; 4],
    /// The letterbox colour, 0-1 RGBA as the webview paints it (sRGB); the
    /// presenter matches it into the layer's space before drawing it.
    pub background: [f32; 4],
}

impl Placement {
    /// The size the engine should draw a frame at for this placement: the
    /// picture box's long edge, capped at the drawable's long edge (a zoomed-in
    /// view gets more pixels, never more than the screen can show), rounded up
    /// to [`RENDER_EDGE_STEP`] so a live resize changes it rarely. `None`
    /// before the first placement.
    pub(crate) fn render_long_edge(&self) -> Option<u32> {
        let (dw, dh) = self.drawable;
        let long = self.picture[2].max(self.picture[3]);
        if dw == 0 || dh == 0 || long.is_nan() || long < 1.0 {
            return None;
        }
        let cap = dw.max(dh);
        let want = (long.ceil() as u32).min(cap);
        Some(want.div_ceil(RENDER_EDGE_STEP) * RENDER_EDGE_STEP)
    }
}

/// The granularity of [`Placement::render_long_edge`], in pixels. The decode
/// pipes are opened at the render size (D-125: a new size respawns them), so a
/// panel drag must not change it on every pixel; 128 px is well under the
/// difference anyone sees in a preview and keeps a full-width drag of the
/// Inspector to a handful of steps.
pub(crate) const RENDER_EDGE_STEP: u32 = 128;

/// What one `present` measured (D-454 stats).
#[derive(Clone, Copy, Debug)]
pub(crate) struct PresentTiming {
    /// Waiting for a free drawable: the display's pacing.
    pub acquire_ms: f64,
    /// From asking for a drawable to `present()` returning (debug stats).
    #[cfg(debug_assertions)]
    pub total_ms: f64,
    /// When the drawable became available (the playback loop's clock tick).
    pub acquired_at: Instant,
    /// `false` when the layer had no drawable to give: the window is occluded
    /// (or the display asleep), so nothing was presented and the display set
    /// no cadence (Core Animation's `nextDrawable` timed out or wgpu reported
    /// the surface occluded).
    pub shown: bool,
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    picture: [f32; 4],
    background: [f32; 4],
    src_size: [u32; 2],
    _pad: [u32; 2],
}

/// The engine's finished frame, kept on the GPU.
struct Retained {
    /// Read back by the debug screenshot only; the view keeps it alive.
    #[cfg(debug_assertions)]
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    size: (u32, u32),
}

/// **The engine's preview terminal (D-454), as `chroma::gpu_compositor`'s
/// `Destination::Present` carries it**: the presenter a frame is drawn into,
/// lent for one frame. A `RefCell` because the destination is shared (`&`)
/// down the render path while the terminal needs the presenter mutably, once,
/// on the thread that submits.
pub(crate) struct PresentTarget<'a> {
    presenter: RefCell<&'a mut Presenter>,
}

impl<'a> PresentTarget<'a> {
    pub(crate) fn new(presenter: &'a mut Presenter) -> Self {
        Self {
            presenter: RefCell::new(presenter),
        }
    }

    /// Nothing to draw and no size to draw black at: show the letterbox alone.
    pub(crate) fn clear_frame(&self) -> Result<(), String> {
        self.presenter
            .try_borrow_mut()
            .map_err(|_| "the preview is already being drawn".to_string())?
            .clear_frame();
        Ok(())
    }

    /// Record the unpack of the engine's finished canvas into the retained
    /// frame, in the engine's own submission.
    pub(crate) fn write(
        &self,
        out: &mut apelles_compositor::FrameOutput,
        canvas: &apelles_compositor::Canvas<'_>,
    ) -> Result<(), apelles_compositor::ComposeError> {
        let mut presenter = self.presenter.try_borrow_mut().map_err(|_| {
            apelles_compositor::ComposeError::Gpu("the preview is already being drawn".into())
        })?;
        presenter
            .write_frame(out.encoder(), canvas.buffer, (canvas.width, canvas.height))
            .map_err(apelles_compositor::ComposeError::Gpu)
    }
}

/// Owns the surface, the retained frame and the two passes.
pub(crate) struct Presenter {
    device: Arc<RenderDevice>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    present_pipeline: wgpu::RenderPipeline,
    unpack_pipeline: wgpu::RenderPipeline,
    present_layout: wgpu::BindGroupLayout,
    unpack_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    params: wgpu::Buffer,
    frame: Option<Retained>,
    reconfigures: u64,
    /// The last letterbox colour asked for (the UI's sRGB) and what is drawn
    /// for it in the layer's Rec.709 (`viewer_space::ViewerSpace::ui_colour`, D-457).
    letterbox: ([f32; 4], [f32; 4]),
}

impl Presenter {
    /// Build the presenter on `surface` (made from `device`'s instance).
    pub(crate) fn new(
        device: Arc<RenderDevice>,
        surface: wgpu::Surface<'static>,
    ) -> Result<Self, String> {
        let caps = surface.get_capabilities(&device.gpu.adapter);
        // Non-sRGB, so the frame's bytes reach the drawable unchanged and the
        // layer's colour space tag alone says what they mean (§6).
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
        let gpu = &device.gpu.device;
        let module = gpu.create_shader_module(wgpu::ShaderModuleDescriptor {
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
        let present_layout = gpu.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("preview present"),
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
        let unpack_layout = gpu.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("preview unpack"),
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
        let pipeline = |layout: &wgpu::BindGroupLayout, entry: &str, target| {
            let pl = gpu.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("preview presenter"),
                bind_group_layouts: &[Some(layout)],
                immediate_size: 0,
            });
            gpu.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
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
                        format: target,
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
        let present_pipeline = pipeline(&present_layout, "fs_present", format);
        let unpack_pipeline = pipeline(&unpack_layout, "fs_unpack", FRAME_FORMAT);
        let sampler = gpu.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("preview presenter"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let params = gpu.create_buffer(&wgpu::BufferDescriptor {
            label: Some("preview presenter params"),
            size: std::mem::size_of::<Params>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Ok(Self {
            device,
            surface,
            config,
            present_pipeline,
            unpack_pipeline,
            present_layout,
            unpack_layout,
            sampler,
            params,
            frame: None,
            reconfigures: 0,
            letterbox: ([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0, 1.0]),
        })
    }

    /// `ui`, the pane's colour as the webview paints it, as the layer must be
    /// given it to show that same colour (B-398: the Rec.709 tag decodes with
    /// a 2.4 power, so the raw sRGB value showed darker than the panel around
    /// it). Matched by ColorSync once per colour, not per present.
    fn letterbox(&mut self, ui: [f32; 4]) -> [f32; 4] {
        if self.letterbox.0 != ui {
            self.letterbox = (ui, PREVIEW_SPACE.ui_colour(ui));
        }
        self.letterbox.1
    }

    /// The render device this presenter's surface is configured with.
    pub(crate) fn device(&self) -> &Arc<RenderDevice> {
        &self.device
    }

    /// Drop the retained frame: the next present shows the letterbox alone (a
    /// timeline with no frame size has no picture to show).
    pub(crate) fn clear_frame(&mut self) {
        self.frame = None;
    }

    /// **The engine's preview terminal.** Record, into `encoder` (the engine's
    /// own, after the frame's work), the unpack of `canvas` — the engine's
    /// packed RGBA8 canvas of `size` — into the retained frame. No pixel
    /// leaves the GPU.
    pub(crate) fn write_frame(
        &mut self,
        encoder: &mut wgpu::CommandEncoder,
        canvas: &wgpu::Buffer,
        size: (u32, u32),
    ) -> Result<(), String> {
        let (w, h) = size;
        let need = u64::from(w) * u64::from(h) * 4;
        if w == 0 || h == 0 || canvas.size() < need {
            return Err(format!(
                "the canvas holds {} bytes, {w}x{h} needs {need}",
                canvas.size()
            ));
        }
        let gpu = self.device.gpu.device.clone();
        if self.frame.as_ref().is_none_or(|f| f.size != size) {
            let texture = gpu.create_texture(&wgpu::TextureDescriptor {
                label: Some("preview frame"),
                size: wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: FRAME_FORMAT,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.frame = Some(Retained {
                #[cfg(debug_assertions)]
                texture,
                view,
                size,
            });
        }
        let frame = self
            .frame
            .as_ref()
            .ok_or("the preview frame was not created")?;
        // Its own small uniform: `params` is the present pass's, and both are
        // written before either submission runs.
        let params = wgpu::util::DeviceExt::create_buffer_init(
            gpu.as_ref(),
            &wgpu::util::BufferInitDescriptor {
                label: Some("preview unpack params"),
                contents: bytemuck::bytes_of(&Params {
                    picture: [0.0, 0.0, w as f32, h as f32],
                    background: [0.0, 0.0, 0.0, 1.0],
                    src_size: [w, h],
                    _pad: [0; 2],
                }),
                usage: wgpu::BufferUsages::UNIFORM,
            },
        );
        let bind_group = gpu.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("preview unpack"),
            layout: &self.unpack_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: canvas.as_entire_binding(),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("preview unpack"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &frame.view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    // Every pixel is written by the pass.
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: NonZero::new(0),
        });
        pass.set_pipeline(&self.unpack_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1);
        Ok(())
    }

    /// Show the retained frame (or the letterbox alone before the first one)
    /// at `placement`: acquire a drawable — waiting while the one queued
    /// drawable is still waiting for the display — draw, present.
    pub(crate) fn present(&mut self, placement: Placement) -> Result<PresentTiming, String> {
        let (w, h) = placement.drawable;
        if w == 0 || h == 0 {
            return Err("the preview surface has no size yet".to_string());
        }
        let gpu = self.device.gpu.device.clone();
        if (self.config.width, self.config.height) != (w, h) {
            self.config.width = w;
            self.config.height = h;
            self.surface.configure(&gpu, &self.config);
            self.reconfigures += 1;
        }
        let started = Instant::now();
        let output = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(t)
            | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.surface.configure(&gpu, &self.config);
                self.reconfigures += 1;
                match self.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(t)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
                    other => return Err(format!("no drawable after reconfigure: {other:?}")),
                }
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                let now = Instant::now();
                let ms = now.saturating_duration_since(started).as_secs_f64() * 1000.0;
                return Ok(PresentTiming {
                    acquire_ms: ms,
                    #[cfg(debug_assertions)]
                    total_ms: ms,
                    acquired_at: now,
                    shown: false,
                });
            }
            other => return Err(format!("no drawable: {other:?}")),
        };
        let acquired_at = Instant::now();
        let background = self.letterbox(placement.background);

        // Before the first frame the picture box shows the letterbox colour:
        // a 1x1 source outside every picture box.
        let (src_size, picture) = match &self.frame {
            Some(f) => ([f.size.0, f.size.1], placement.picture),
            None => ([1, 1], [0.0, 0.0, 0.0, 0.0]),
        };
        let queue = &self.device.gpu.queue;
        queue.write_buffer(
            &self.params,
            0,
            bytemuck::bytes_of(&Params {
                picture,
                background,
                src_size,
                _pad: [0; 2],
            }),
        );
        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = gpu.create_command_encoder(&wgpu::CommandEncoderDescriptor {
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
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: f64::from(background[0]),
                            g: f64::from(background[1]),
                            b: f64::from(background[2]),
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: NonZero::new(0),
            });
            if let Some(frame) = &self.frame {
                let bind_group = gpu.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("preview present"),
                    layout: &self.present_layout,
                    entries: &[
                        wgpu::BindGroupEntry {
                            binding: 0,
                            resource: self.params.as_entire_binding(),
                        },
                        wgpu::BindGroupEntry {
                            binding: 1,
                            resource: wgpu::BindingResource::TextureView(&frame.view),
                        },
                        wgpu::BindGroupEntry {
                            binding: 2,
                            resource: wgpu::BindingResource::Sampler(&self.sampler),
                        },
                    ],
                });
                pass.set_pipeline(&self.present_pipeline);
                pass.set_bind_group(0, &bind_group, &[]);
                pass.draw(0..3, 0..1);
            }
        }
        queue.submit(Some(encoder.finish()));
        output.present();
        #[cfg(debug_assertions)]
        let done = Instant::now();
        let ms = |a: Instant, b: Instant| b.saturating_duration_since(a).as_secs_f64() * 1000.0;
        Ok(PresentTiming {
            acquire_ms: ms(started, acquired_at),
            #[cfg(debug_assertions)]
            total_ms: ms(started, done),
            acquired_at,
            shown: true,
        })
    }

    /// The drawable's size and how many times the surface was reconfigured.
    #[cfg(debug_assertions)]
    pub(crate) fn surface_report(&self) -> ((u32, u32), u64, String) {
        (
            (self.config.width, self.config.height),
            self.reconfigures,
            format!("{:?}", self.config.format),
        )
    }

    /// **Debug only (B-151's pattern):** the retained frame read back to the
    /// CPU, for `debug_screenshot` to composite at the native view's rect. One
    /// on-demand copy, never on the frame path.
    #[cfg(debug_assertions)]
    pub(crate) fn read_frame(&self) -> Result<Option<image::RgbaImage>, String> {
        let Some(frame) = &self.frame else {
            return Ok(None);
        };
        let (w, h) = frame.size;
        let gpu = &self.device.gpu.device;
        let row = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = gpu.create_buffer(&wgpu::BufferDescriptor {
            label: Some("preview screenshot read-back"),
            size: u64::from(row) * u64::from(h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("preview screenshot read-back"),
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &frame.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: Some(h),
                },
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        let index = self.device.gpu.queue.submit(Some(encoder.finish()));
        let (tx, rx) = std::sync::mpsc::channel();
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |r| drop(tx.send(r)));
        gpu.poll(wgpu::PollType::Wait {
            submission_index: Some(index),
            timeout: Some(std::time::Duration::from_secs(5)),
        })
        .map_err(|e| format!("the screenshot read-back did not finish: {e}"))?;
        rx.recv()
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("the screenshot read-back could not be mapped: {e}"))?;
        let mapped = buffer.slice(..).get_mapped_range();
        let mut pixels = Vec::with_capacity((w * h * 4) as usize);
        for r in mapped.chunks(row as usize).take(h as usize) {
            pixels.extend_from_slice(&r[..(w * 4) as usize]);
        }
        drop(mapped);
        buffer.unmap();
        Ok(image::RgbaImage::from_raw(w, h, pixels))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(drawable: (u32, u32), picture: [f32; 4]) -> Placement {
        Placement {
            drawable,
            picture,
            background: [0.0, 0.0, 0.0, 1.0],
        }
    }

    #[test]
    fn the_render_follows_the_picture_box_in_steps() {
        // A 1356x640 drawable with a 1138x640 picture: 1138 -> 1152.
        let p = at((1356, 640), [109.0, 0.0, 1138.0, 640.0]);
        assert_eq!(p.render_long_edge(), Some(1152));
        // One more pixel of panel does not change it.
        let p = at((1358, 640), [110.0, 0.0, 1139.0, 640.0]);
        assert_eq!(p.render_long_edge(), Some(1152));
    }

    #[test]
    fn a_zoomed_in_picture_is_capped_at_the_drawable() {
        let p = at((1356, 640), [-1000.0, -500.0, 4552.0, 2560.0]);
        assert_eq!(p.render_long_edge(), Some(1408));
    }

    #[test]
    fn no_placement_means_no_render_size() {
        assert_eq!(at((0, 0), [0.0; 4]).render_long_edge(), None);
        assert_eq!(
            at((100, 100), [0.0, 0.0, 0.0, 0.0]).render_long_edge(),
            None
        );
    }
}
