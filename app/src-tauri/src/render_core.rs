//! Tauri-free render entry points (D-014).
//!
//! The grade compute path — GPU context init and `RenderRequest -> DynamicImage`
//! — with **no `tauri::State` / `tauri::AppHandle`**, so it can run from a test, a
//! batch binary, or the Chroma control/MCP server without a live GUI.
//!
//! This is a *seam*, not a rewrite: the heavy body still lives in
//! `gpu_processing::process_and_get_dynamic_image_inner` (now parameterised on
//! [`RenderCaches`] instead of `AppState`); the GUI commands in `gpu_processing`
//! stay as thin wrappers that build a `RenderCaches` from `AppState`. Keep it that
//! way so upstream RapidRAW fixes to the render path still cherry-pick.

// The headless entry points (`render`, `init_gpu_context`, `OwnedRenderCaches`) are
// unused until the Chroma control/MCP server lands — that's the point of the seam.
#![allow(dead_code)]

use std::sync::{Arc, Mutex};

use image::DynamicImage;

use crate::app_state::{AnalyticsConfig, GpuImageCache, GpuProcessorState};
use crate::gpu_processing::RenderRequest;
use crate::image_processing::GpuContext;

/// The two mutable GPU caches the renderer needs. `AppState` owns them in the GUI
/// (`state.render_caches()`); a headless caller keeps its own pair.
pub struct RenderCaches<'a> {
    pub gpu_processor: &'a Mutex<Option<GpuProcessorState>>,
    pub gpu_image_cache: &'a Mutex<Option<GpuImageCache>>,
}

/// Owned caches for a headless render session (batch / MCP). Start empty; the
/// renderer fills them on first use, same as the GUI.
#[derive(Default)]
pub struct OwnedRenderCaches {
    pub gpu_processor: Mutex<Option<GpuProcessorState>>,
    pub gpu_image_cache: Mutex<Option<GpuImageCache>>,
}

impl OwnedRenderCaches {
    pub fn as_ref(&self) -> RenderCaches<'_> {
        RenderCaches {
            gpu_processor: &self.gpu_processor,
            gpu_image_cache: &self.gpu_image_cache,
        }
    }
}

/// Render `base_image` through `request` and return the processed image.
///
/// Thin pass-through to the moved body. `output_to_display` is a GUI concept
/// (present to the native surface) — leave it `false` headless; `analytics_config`
/// drives the scopes readback and is optional.
#[allow(clippy::too_many_arguments)]
pub fn render(
    context: &GpuContext,
    caches: RenderCaches<'_>,
    base_image: &DynamicImage,
    transform_hash: u64,
    request: RenderRequest<'_>,
    caller_id: &str,
    output_to_display: bool,
    analytics_config: Option<AnalyticsConfig>,
) -> Result<DynamicImage, String> {
    crate::gpu_processing::process_and_get_dynamic_image_inner(
        context,
        &caches,
        base_image,
        transform_hash,
        request,
        caller_id,
        output_to_display,
        analytics_config,
    )
}

/// A Tauri-free GPU context: device + queue, **no display surface**. For headless
/// render. The GUI uses `gpu_processing::get_or_init_gpu_context`, which also wires
/// the native `WgpuDisplay` surface and needs the `AppHandle` + window.
pub fn init_gpu_context() -> Result<GpuContext, String> {
    let instance_desc = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
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
        label: Some("Chroma Headless Device"),
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
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
        display: Arc::new(Mutex::new(None)),
    })
}
