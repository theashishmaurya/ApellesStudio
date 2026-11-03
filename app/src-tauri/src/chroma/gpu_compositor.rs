//! **The process's one GPU render engine (D-449), on the device the Colorist's
//! grade shader also runs on (D-450).**
//!
//! What it is: the `apelles_compositor::Engine` every timeline frame is drawn
//! by: the Edit tab's live preview (`chroma::edit::composite_video_frame`),
//! the Colorist's framed clip preview (`chroma::colorist_view`), and every
//! export segment worker (`chroma::edit_render`). One engine for playback and
//! export, as Final Cut Pro, DaVinci Resolve and Premiere Pro each run one
//! image engine for both.
//!
//! What it does: opens one headless wgpu device on first use, as the app's own
//! `GpuContext` (`render_core::init_gpu_context`), and builds the engine on
//! it, so a clip graded by the Colorist's `GpuProcessor`
//! (`chroma::grade_pass`) hands its pixels to the engine without leaving the
//! GPU; hands both out to any thread; and turns their errors into the
//! `String` errors this crate's commands return.
//!
//! What it does NOT do: fall back to a CPU path. There is none (D-449): a
//! machine without a usable GPU cannot render a frame, and says so. After a
//! GPU error the device is dropped, so the next frame opens a fresh one rather
//! than drawing on one that may have been lost; the failed frame itself is
//! still an error, never a silently different picture.

use std::sync::{Arc, Mutex};

use apelles_compositor::{ComposeError, Engine, FramePlan};
use image::RgbaImage;

/// The device every frame is drawn on, with what runs on it.
pub(crate) struct RenderDevice {
    /// The app's own context for the device (no display surface): what the
    /// Colorist's `GpuProcessor` is built on.
    pub(crate) ctx: crate::image_processing::GpuContext,
    pub(crate) engine: Arc<Engine>,
    /// The grade shader's state on this device (`chroma::grade_pass`): built on
    /// the first graded frame, one at a time (its textures are reused).
    pub(crate) grader: Mutex<Option<super::grade_pass::Grader>>,
}

impl RenderDevice {
    /// The engine and the grade shader's slot, on `ctx`'s device.
    pub(crate) fn on(ctx: crate::image_processing::GpuContext) -> Self {
        let engine = Arc::new(Engine::with_device(ctx.device.clone(), ctx.queue.clone()));
        Self {
            ctx,
            engine,
            grader: Mutex::new(None),
        }
    }
}

static DEVICE: Mutex<Option<Arc<RenderDevice>>> = Mutex::new(None);

/// The render device, opened on first use.
pub(crate) fn device() -> Result<Arc<RenderDevice>, String> {
    let mut slot = DEVICE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(d) = slot.as_ref() {
        return Ok(d.clone());
    }
    let ctx =
        crate::render_core::init_gpu_context().map_err(|e| describe(ComposeError::NoDevice(e)))?;
    let device = Arc::new(RenderDevice::on(ctx));
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
