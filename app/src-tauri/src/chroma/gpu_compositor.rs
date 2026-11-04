//! **The process's one GPU device (D-454), with the render engine (D-449) and
//! the Colorist's grade shader (D-450) on it.**
//!
//! What it is: the one wgpu instance, adapter, device and queue the app opens,
//! and the `apelles_compositor::Engine` every timeline frame is drawn by: the
//! Edit tab's live preview (`chroma::preview_surface`), the Colorist's framed
//! clip preview (`chroma::colorist_view`), and every export segment worker
//! (`chroma::edit_render`). One engine for playback and export, as Final Cut
//! Pro, DaVinci Resolve and Premiere Pro each run one image engine for both,
//! and one device for everything that draws, as they do.
//!
//! What it does: opens the device on first use (`apelles_gpu::init_gpu_context`)
//! and builds the engine on it. Everything else that draws reaches the device
//! through here, so what one of them makes another can read without leaving
//! the GPU:
//! - the Colorist's `GpuProcessor`, through [`RenderDevice::ctx`] (the grade in
//!   the engine, `chroma::grade_pass`) and through
//!   `gpu_processing::get_or_init_gpu_context` (the Colorist tab itself, whose
//!   full-window surface, B-006, is made from [`RenderDevice::gpu`]'s instance);
//! - the Edit preview's presenter (`chroma::preview_surface`), whose
//!   `CAMetalLayer` surface must come from the same instance as the device it
//!   is configured with (D-451).
//!
//! It hands them out to any thread and turns their errors into the `String`
//! errors this crate's commands return.
//!
//! What it does NOT do: fall back to a CPU path. There is none (D-449): a
//! machine without a usable GPU cannot render a frame, and says so. After a
//! GPU error the device is dropped, so the next frame opens a fresh one rather
//! than drawing on one that may have been lost; the failed frame itself is
//! still an error, never a silently different picture. The holders of a
//! surface (the Colorist's context, the preview presenter) notice the new
//! device by identity ([`RenderDevice::is_current`]) and rebuild on it.

use std::sync::{Arc, Mutex};

use apelles_compositor::{ComposeError, Engine, FramePlan};
use image::RgbaImage;

/// The device every frame is drawn on, with what runs on it.
pub(crate) struct RenderDevice {
    /// The one instance, adapter, device and queue (D-454). A surface is made
    /// from `gpu.instance` and configured with `gpu.device`.
    pub(crate) gpu: apelles_gpu::GpuContext,
    /// The app's own headless context over the same device: what the
    /// Colorist's `GpuProcessor` is built on.
    pub(crate) ctx: crate::image_processing::GpuContext,
    pub(crate) engine: Arc<Engine>,
    /// The grade shader's state on this device (`chroma::grade_pass`): built on
    /// the first graded frame, one at a time (its textures are reused).
    pub(crate) grader: Mutex<Option<super::grade_pass::Grader>>,
}

impl RenderDevice {
    /// The engine and the grade shader's slot, on `gpu`'s device.
    pub(crate) fn on(gpu: apelles_gpu::GpuContext) -> Self {
        let engine = Arc::new(Engine::with_device(gpu.device.clone(), gpu.queue.clone()));
        Self {
            ctx: crate::render_core::headless_context(&gpu),
            gpu,
            engine,
            grader: Mutex::new(None),
        }
    }

    /// Whether `device` is this render device's, not one forgotten after a
    /// failure: how a cached surface or processor knows to rebuild.
    pub(crate) fn is_current(&self, device: &Arc<wgpu::Device>) -> bool {
        Arc::ptr_eq(&self.gpu.device, device)
    }
}

static DEVICE: Mutex<Option<Arc<RenderDevice>>> = Mutex::new(None);

/// The render device, opened on first use.
pub(crate) fn device() -> Result<Arc<RenderDevice>, String> {
    let mut slot = DEVICE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(d) = slot.as_ref() {
        return Ok(d.clone());
    }
    let gpu = apelles_gpu::init_gpu_context().map_err(|e| describe(ComposeError::NoDevice(e)))?;
    let device = Arc::new(RenderDevice::on(gpu));
    *slot = Some(device.clone());
    Ok(device)
}

/// The engine, opened on first use.
pub(crate) fn engine() -> Result<Arc<Engine>, String> {
    Ok(device()?.engine.clone())
}

fn describe(e: ComposeError) -> String {
    format!("GPU compositor: {e}")
}

/// After a device-level failure, forget the device so the next frame opens a
/// new one. A plan the device cannot hold (`TooLarge`) is a property of the
/// frame, not of the device, and keeps it.
pub(crate) fn settle<T>(r: Result<T, ComposeError>) -> Result<T, String> {
    match r {
        Ok(v) => Ok(v),
        Err(e) => {
            if matches!(e, ComposeError::Gpu(_) | ComposeError::Timeout(_)) {
                forget_device(&e.to_string());
            }
            Err(describe(e))
        }
    }
}

/// Drop the device after a failure on it (the engine's, or the grade
/// shader's), so the next frame opens a fresh one.
pub(crate) fn forget_device(why: &str) {
    log::error!("GPU compositor: {why}; the device will be reopened for the next frame");
    *DEVICE.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// The engine's running totals (zero before it has opened). A render reads
/// them before and after to report its GPU stages (B-380).
pub(crate) fn stats() -> apelles_compositor::EngineStats {
    DEVICE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|d| d.engine.stats())
        .unwrap_or_default()
}

/// Draw `plan` and read it back.
pub(crate) fn render(plan: &FramePlan) -> Result<RgbaImage, String> {
    submit(plan, &Destination::ReadBack)?.wait()
}

/// Where a finished frame goes: the engine's terminals of its one output step
/// (D-452's `Engine::submit_with`).
pub(crate) enum Destination<'a> {
    /// Back to the CPU as pixels (a thumbnail, any picture a caller needs).
    ReadBack,
    /// D-452 — into an encoder's pixel buffer with no read-back (the export).
    Encoder {
        buffer: apelles_types::video_frame::PixelBuffer,
        format: apelles_compositor::OutputFormat,
    },
    /// **D-454 — into the Edit preview's native surface**, unpacked by the
    /// presenter's pass in the frame's own submission; nothing is read back.
    #[cfg(target_os = "macos")]
    Present(&'a super::preview_surface::presenter::PresentTarget<'a>),
    #[cfg(not(target_os = "macos"))]
    #[doc(hidden)]
    _Lifetime(std::marker::PhantomData<&'a ()>),
}

/// Hand `plan` to the GPU, to `to`, and return at once; [`GpuFrame::wait`] for
/// a read-back's pixels, or [`GpuFrame::wait_written`] for an encoder buffer.
/// The export's writer thread does the waiting, so the GPU draws one frame
/// while the render worker decodes the next.
pub(crate) fn submit(plan: &FramePlan, to: &Destination<'_>) -> Result<GpuFrame, String> {
    let engine = engine()?;
    match to {
        Destination::ReadBack => settle(engine.submit(plan)).map(GpuFrame::ReadBack),
        Destination::Encoder { buffer, format } => {
            settle(engine.submit_into(plan, buffer, *format)).map(GpuFrame::Written)
        }
        #[cfg(target_os = "macos")]
        Destination::Present(target) => settle(
            engine.submit_with(plan, |out, canvas| target.write(out, canvas)),
        )
        .map(|(pending, ())| GpuFrame::Presented {
            _in_flight: pending,
        }),
        #[cfg(not(target_os = "macos"))]
        Destination::_Lifetime(_) => Err("no such destination".to_string()),
    }
}

/// A frame on the GPU, not yet finished.
pub(crate) enum GpuFrame {
    /// To be read back.
    ReadBack(apelles_compositor::PendingFrame),
    /// Being written into an encoder's buffer (D-452).
    Written(apelles_compositor::PendingGpu),
    /// D-454 — drawn into the preview's surface. Held (never read) until the
    /// next frame, so the engine's pooled buffers go back only once the GPU is
    /// done (`PendingGpu`'s waiting drop).
    Presented {
        _in_flight: apelles_compositor::PendingGpu,
    },
}

impl GpuFrame {
    /// The frame's pixels.
    pub(crate) fn wait(self) -> Result<RgbaImage, String> {
        match self {
            GpuFrame::ReadBack(f) => settle(f.wait()),
            GpuFrame::Written(_) => {
                Err("this frame was written into an encoder's buffer, not read back".into())
            }
            GpuFrame::Presented { .. } => {
                Err("a frame drawn into the preview has no pixels to read back".into())
            }
        }
    }

    /// Wait until the encoder's buffer holds the frame (D-452).
    pub(crate) fn wait_written(self) -> Result<(), String> {
        match self {
            GpuFrame::Written(f) => settle(f.wait()),
            GpuFrame::ReadBack(_) | GpuFrame::Presented { .. } => {
                Err("this frame is not an encoder write".into())
            }
        }
    }
}

/// D-452 — a decoded frame as RGBA pixels, at `size` (its own size when
/// `None`): one plain layer through the engine, which converts a media-engine
/// frame from Y'CbCr and resamples it exactly as it would inside a timeline
/// frame. For the callers that need the picture itself on the CPU (the
/// Colorist's image pipeline, the two-up trim viewer's JPEG, a clip's
/// highlight strokes drawn over its decoded picture).
pub(crate) fn picture(
    source: apelles_compositor::Source,
    size: Option<(u32, u32)>,
) -> Result<RgbaImage, String> {
    render(&one_layer_plan(source, size))
}

/// **A picture resized on the GPU and left there**, as a
/// [`apelles_compositor::Source::Gpu`] the engine (and the grade pass) read in
/// place: [`picture`]'s one-layer plan, with the finished canvas copied into a
/// buffer of its own instead of being read back. The Edit preview grades a
/// clip at the picture box's size this way (D-450's scrub/playback rule), so a
/// graded 4K source costs the grade a preview-sized frame rather than a 4K one.
pub(crate) fn resized(
    source: apelles_compositor::Source,
    size: (u32, u32),
) -> Result<apelles_compositor::Source, String> {
    let engine = engine()?;
    let (device, _) = engine.device_and_queue();
    let device = device.clone();
    let plan = one_layer_plan(source, Some(size));
    let (pending, image) = settle(engine.submit_with(&plan, |out, canvas| {
        let bytes = u64::from(canvas.width) * u64::from(canvas.height) * 4;
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("apelles preview-sized picture"),
            size: bytes,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_DST
                | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        out.encoder()
            .copy_buffer_to_buffer(canvas.buffer, 0, &buffer, 0, bytes);
        Ok(apelles_compositor::GpuImage {
            buffer,
            width: canvas.width,
            height: canvas.height,
            row_pixels: canvas.width,
        })
    }))?;
    // The copy reads the engine's pooled canvas: let the submission finish
    // before that canvas can be handed out again. A later submission on this
    // queue (the grade) runs after it either way.
    settle(pending.wait())?;
    Ok(apelles_compositor::Source::Gpu(image))
}

/// `source` painted as the only layer of a frame of `size` (its own size when
/// `None`), filling it.
fn one_layer_plan(source: apelles_compositor::Source, size: Option<(u32, u32)>) -> FramePlan {
    let (w, h) = source.dimensions();
    let (ow, oh) = size.unwrap_or((w, h));
    FramePlan {
        width: ow,
        height: oh,
        background: apelles_compositor::Background::Solid([0, 0, 0, 255]),
        steps: vec![apelles_compositor::Step::Paint(apelles_compositor::Layer {
            source,
            crop: (0, 0, w, h),
            size: (ow, oh),
            origin: (0.0, 0.0),
            opacity: 1.0,
            corner_radius: 0.0,
            rotation_deg: 0.0,
        })],
    }
}
