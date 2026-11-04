//! # apelles-gpu — L0 domain crate (D-039 roadmap "apelles-gpu", D-144)
//!
//! **What it is:** the headless wgpu device/queue/limits construction that
//! backs Apelles' render path (D-014) — moved verbatim out of
//! `app/src-tauri/src/render_core.rs::init_gpu_context()`, which is now a
//! thin wrapper around this crate's [`init_gpu_context`].
//!
//! **What it does NOT do, and why — this is the real finding this crate's
//! extraction pass (D-141 → D-144) existed to resolve:** it does not export a
//! `GpuContext` that can drive an on-screen render. The app's own
//! `GpuContext` (`image_processing.rs`) carries a
//! `display: Arc<Mutex<Option<WgpuDisplay>>>` field, and `WgpuDisplay`
//! (`gpu_processing.rs`) owns a `wgpu::Surface<'static>` bound to a native
//! window, a `RenderPipeline` that presents to it, and `WgpuDisplay::render`
//! — genuinely app/GUI-side concepts (window surface lifecycle, present-time
//! scissor/clip math), not domain ones. They stay in `app/src-tauri`.
//!
//! So `GpuContext` really does split into two structs — the D-141 scoping
//! pass's "scenario B", left open on purpose pending a real read of both
//! definitions: this crate's [`GpuContext`] (device + queue + limits,
//! headless) is the Apelles-side half; `app/src-tauri`'s own
//! `image_processing::GpuContext` (unchanged) is the app-side half — this
//! crate's struct plus the `display` field. `render_core::init_gpu_context()`
//! bridges the two by calling this crate's constructor and adding an empty
//! `display: Arc::new(Mutex::new(None))`.
//!
//! It also does not export `render()` — that is a pass-through into
//! `gpu_processing::process_and_get_dynamic_image_inner`, whose signature
//! (`RenderCaches`, `RenderRequest`, `AllAdjustments`, mask bitmaps, LUTs …)
//! is entirely RapidRAW-core (`image_processing.rs`, `app_state.rs`,
//! `gpu_processing.rs`). Moving it means moving the whole grade path — that
//! is `apelles-grade`, a separate, later, much bigger effort, not this slice.

use std::sync::Arc;

/// A headless wgpu device + queue + adapter limits. No display surface — for
/// a batch render, a test, or (later) the Apelles control/MCP server.
///
/// The app's own `GpuContext` (`image_processing.rs`) is a *different* type
/// that wraps the same three fields plus a `display` field for the on-screen
/// present path — see the module doc for why they don't unify (D-144).
#[derive(Clone)]
pub struct GpuContext {
    /// The instance the adapter and device came from. Kept (D-451) because a
    /// window surface can only be configured with a device of the SAME
    /// instance. Since D-454 the app opens one of these for the whole process
    /// (`chroma::gpu_compositor::device`): the Edit preview's `CAMetalLayer`
    /// surface and the Colorist's window surface are both made from this
    /// instance, so frames the GPU engine draws on `device` are shown without
    /// leaving the GPU.
    pub instance: wgpu::Instance,
    /// The adapter `device` was opened on (surface capabilities are asked of
    /// it).
    pub adapter: wgpu::Adapter,
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub limits: wgpu::Limits,
}

/// Build a headless [`GpuContext`]: request a high-performance adapter,
/// enable `TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES` when the adapter has it,
/// open a device at the adapter's own limits. No `compatible_surface`, no
/// window handle.
///
/// Moved verbatim from `render_core::init_gpu_context()` (D-014); the only
/// change is the return type dropping the `display` field, which the
/// app-side wrapper now adds back.
pub fn init_gpu_context() -> Result<GpuContext, String> {
    #[allow(unused_mut)]
    let mut instance_desc = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
    // RapidRAW's own default, kept when the Colorist moved onto this device
    // (D-454): the primary backends on Windows unless `WGPU_BACKEND` says.
    #[cfg(target_os = "windows")]
    if std::env::var("WGPU_BACKEND").is_err() {
        instance_desc.backends = wgpu::Backends::PRIMARY;
    }
    let instance = wgpu::Instance::new(instance_desc);

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        compatible_surface: None,
        ..Default::default()
    }))
    .map_err(|e| format!("Failed to find a wgpu adapter: {e}"))?;

    let mut required_features = wgpu::Features::empty();
    if adapter
        .features()
        .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
    {
        required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
    }
    let limits = adapter.limits();

    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("Apelles Headless Device"),
        required_features,
        required_limits: limits.clone(),
        experimental_features: wgpu::ExperimentalFeatures::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .map_err(|e| e.to_string())?;

    device.on_uncaptured_error(Arc::new(|err: wgpu::Error| {
        log::error!("[wgpu-error] {err}");
    }));

    Ok(GpuContext {
        instance,
        adapter,
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
    })
}
