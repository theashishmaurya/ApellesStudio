//! Tauri-free render entry points (D-014).
//!
//! The grade compute path — GPU context init and `RenderRequest -> DynamicImage`
//! — with **no `tauri::State` / `tauri::AppHandle`**, so it can run from a test, a
//! batch binary, or the Apelles control/MCP server without a live GUI.
//!
//! This is a *seam*, not a rewrite: the heavy body still lives in
//! `gpu_processing::process_and_get_dynamic_image_inner` (now parameterised on
//! [`RenderCaches`] instead of `AppState`); the GUI commands in `gpu_processing`
//! stay as thin wrappers that build a `RenderCaches` from `AppState`. Keep it that
//! way so upstream RapidRAW fixes to the render path still cherry-pick.
//!
//! **D-144 update:** the actual headless wgpu device/queue/limits construction
//! now lives in the `apelles-gpu` crate (`crates/apelles-gpu`) — this module's
//! [`init_gpu_context`] is a thin wrapper that calls `apelles_gpu::init_gpu_context()`
//! and adds the `display` field back on, so its signature (and every one of the
//! 6 `render_core::` call sites in `chroma/export.rs`, `chroma/playback.rs` and
//! `chroma/relight.rs`) is unchanged. `render()` itself, and `GpuContext` as used
//! here, stay exactly as they were — see the crate's module doc for why they
//! don't move (the grade path, `apelles-grade`, is a separate later effort).

// The headless entry points (`render`, `init_gpu_context`, `OwnedRenderCaches`) are
// unused until the Apelles control/MCP server lands — that's the point of the seam.
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
///
/// D-144: the device/queue/limits construction itself now lives in
/// `apelles_gpu::init_gpu_context()` — this wrapper calls it and adds the
/// app-side `display` field (always `None` here; only the GUI path ever
/// populates it), so the return type and every call site are unchanged.
pub fn init_gpu_context() -> Result<GpuContext, String> {
    let headless = apelles_gpu::init_gpu_context()?;
    Ok(GpuContext {
        device: headless.device,
        queue: headless.queue,
        limits: headless.limits,
        display: Arc::new(Mutex::new(None)),
    })
}
