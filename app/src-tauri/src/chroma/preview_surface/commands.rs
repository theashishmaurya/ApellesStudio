//! The prototype's Tauri commands (D-451), reached only through
//! `@apelles/bridge`'s `previewSurface` bindings from the debug op
//! `debug_native_preview`. They install the native view, keep it under the
//! preview's rectangle, and feed the presenter from a prototype source
//! (`sources`): a GPU test pattern, or today's timeline frame uploaded.
//!
//! When the GPU engine plugs in, `start` / `place` / `stop` become the real
//! preview's lifecycle and `show` / `play` hand over the engine's frames
//! instead of a prototype source's (notes §7).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use objc2_web_kit::WKWebView;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::native_view::{self, ColorTag, CssRect};
use super::presenter::{Placement, PresentTiming, Presenter, PreviewFrame, StatsReport};
use super::sources::{Pattern, PatternTarget, Timeline};

/// What feeds the presenter.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceKind {
    /// The GPU test pattern, handed over as a texture.
    Pattern,
    /// The GPU test pattern, handed over as the engine's packed canvas buffer.
    PatternPacked,
    /// Today's decode + composite, uploaded into a texture.
    Timeline,
}

enum Source {
    Pattern(Option<Pattern>, PatternTarget),
    Timeline(Timeline),
}

struct Session {
    gpu: apelles_gpu::GpuContext,
    presenter: Presenter,
    source: Source,
    position: u64,
    dropped: u64,
}

impl Session {
    /// The pattern's size follows the picture box (what the engine would
    /// render at), its long edge capped at the drawable's.
    fn pattern_size(&self) -> (u32, u32) {
        let p = self.presenter.placement();
        let (dw, dh) = p.drawable;
        let (pw, ph) = (p.picture[2].max(1.0), p.picture[3].max(1.0));
        let cap = f64::from(dw.max(dh).max(1));
        let long = f64::from(pw.max(ph));
        let k = if long > cap { cap / long } else { 1.0 };
        (
            (f64::from(pw) * k).round().max(1.0) as u32,
            (f64::from(ph) * k).round().max(1.0) as u32,
        )
    }

    fn long_edge(&self) -> u32 {
        let (w, h) = self.pattern_size();
        w.max(h)
    }

    /// Produce `position` and present it.
    fn show(&mut self, position: u64, playing: bool) -> Result<ShowReport, String> {
        let long_edge = self.long_edge();
        let size = self.pattern_size();
        let (handed_over, render_ms, upload_ms) = match &mut self.source {
            Source::Pattern(pattern, target) => {
                if pattern.as_ref().is_none_or(|p| p.size() != size) {
                    *pattern = Some(Pattern::new(&self.gpu, *target, size));
                }
                let p = pattern.as_ref().ok_or("the test pattern was not created")?;
                let began = Instant::now();
                let at = p.draw(position);
                (at, at.duration_since(began).as_secs_f64() * 1000.0, 0.0)
            }
            Source::Timeline(t) => {
                let at = t.draw(position, long_edge, playing)?;
                (at, t.last_render_ms, t.last_upload_ms)
            }
        };
        let source = match &self.source {
            Source::Pattern(Some(p), _) => p.source(),
            Source::Timeline(t) => t.source().ok_or("no timeline frame yet")?,
            Source::Pattern(None, _) => return Err("the test pattern was not created".to_string()),
        };
        let timing = self.presenter.present(&PreviewFrame {
            source,
            position,
            handed_over,
        })?;
        self.position = position;
        Ok(ShowReport {
            position,
            render_ms,
            upload_ms,
            timing,
        })
    }
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

struct Player {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}

static PLAYER: Mutex<Option<Player>> = Mutex::new(None);

fn session() -> std::sync::MutexGuard<'static, Option<Session>> {
    SESSION.lock().unwrap_or_else(|e| e.into_inner())
}

/// Run `f` on the main thread with the main window's `WKWebView`.
fn on_webview<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&WKWebView) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the main window is not open")?;
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |platform| {
            let raw = platform.inner();
            let result = if raw.is_null() {
                Err("the window has no WKWebView".to_string())
            } else {
                // SAFETY: on macOS Tauri's `PlatformWebview::inner()` is the
                // window's live `WKWebView`, and this closure runs on the main
                // thread while Tauri keeps the webview alive.
                f(unsafe { &*raw.cast::<WKWebView>() })
            };
            let _ = tx.send(result);
        })
        .map_err(|e| format!("could not reach the webview: {e}"))?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "the main thread did not answer within 5 s".to_string())?
}

fn stop_player() {
    let player = PLAYER.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(p) = player {
        p.stop.store(true, Ordering::Relaxed);
        let _ = p.handle.join();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowReport {
    position: u64,
    render_ms: f64,
    upload_ms: f64,
    timing: PresentTiming,
}

/// Install the native view under the webview and open the presenter.
#[tauri::command]
pub async fn chroma_preview_surface_start(
    app: AppHandle,
    source: SourceKind,
    color: Option<ColorTag>,
) -> Result<(), String> {
    stop_player();
    let old = session().take();
    drop(old);
    let gpu = super::gpu()?;
    let instance = gpu.instance.clone();
    let tag = color.unwrap_or(ColorTag::Srgb);
    let surface = on_webview(&app, move |webview| {
        let layer = native_view::install(webview, tag)?;
        let ptr = objc2::rc::Retained::as_ptr(&layer) as *mut std::ffi::c_void;
        // SAFETY: `ptr` is a live `CAMetalLayer`; the surface retains it (wgpu-hal
        // `Surface::from_layer`) and the view holds its own reference, so it
        // outlives the surface.
        unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(ptr))
        }
        .map_err(|e| format!("could not make a surface from the preview layer: {e}"))
    })?;
    let presenter = Presenter::new(&gpu, surface)?;
    let source = match source {
        SourceKind::Pattern => Source::Pattern(None, PatternTarget::Texture),
        SourceKind::PatternPacked => Source::Pattern(None, PatternTarget::Packed),
        SourceKind::Timeline => Source::Timeline(Timeline::new(&gpu)),
    };
    *session() = Some(Session {
        gpu,
        presenter,
        source,
        position: 0,
        dropped: 0,
    });
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceArgs {
    /// The preview surface's rectangle (CSS pixels of the viewport).
    view: CssRect,
    /// The picture's box, same coordinates (follows zoom and pan).
    picture: CssRect,
    /// The pane's background, 0-1 RGBA.
    background: [f32; 4],
    visible: bool,
}

/// Move the native view under the preview's rectangle; repaints the current
/// frame at the new placement unless playback is about to anyway.
#[tauri::command]
pub async fn chroma_preview_surface_place(app: AppHandle, args: PlaceArgs) -> Result<(), String> {
    let view = args.view;
    let visible = args.visible;
    let scale = on_webview(&app, move |webview| {
        native_view::place(webview, view, visible)
    })?;
    let playing = PLAYER.lock().unwrap_or_else(|e| e.into_inner()).is_some();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = session();
        let s = guard.as_mut().ok_or("the preview surface is not started")?;
        let px = |v: f64| (v * scale).round().max(1.0) as u32;
        let p = args.picture;
        s.presenter.set_placement(Placement {
            drawable: (px(view.width), px(view.height)),
            picture: [
                ((p.x - view.x) * scale) as f32,
                ((p.y - view.y) * scale) as f32,
                (p.width * scale) as f32,
                (p.height * scale) as f32,
            ],
            background: args.background,
        });
        if visible && !playing {
            let position = s.position;
            s.show(position, false)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("place task: {e}"))?
}

/// Show one position (a scrub or a paused seek).
#[tauri::command]
pub async fn chroma_preview_surface_show(position: u64) -> Result<ShowReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = session();
        let s = guard.as_mut().ok_or("the preview surface is not started")?;
        s.show(position, false)
    })
    .await
    .map_err(|e| format!("show task: {e}"))?
}

/// Start (from `from` at `fps`) or stop playback on the presenter's own
/// thread. The thread draws the position the clock is at and presents it;
/// positions it could not reach in time are counted as dropped.
#[tauri::command]
pub async fn chroma_preview_surface_play(
    playing: bool,
    from: Option<u64>,
    fps: Option<f64>,
) -> Result<(), String> {
    stop_player();
    if !playing {
        return Ok(());
    }
    let fps = fps.filter(|f| f.is_finite() && *f > 0.0).unwrap_or(60.0);
    let from = match from {
        Some(f) => f,
        None => session().as_ref().map(|s| s.position).unwrap_or(0),
    };
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let handle = std::thread::Builder::new()
        .name("preview-surface-play".to_string())
        .spawn(move || {
            let began = Instant::now();
            let mut last: Option<u64> = None;
            while !flag.load(Ordering::Relaxed) {
                let due = from + (began.elapsed().as_secs_f64() * fps).floor() as u64;
                if last == Some(due) {
                    std::thread::sleep(Duration::from_micros(500));
                    continue;
                }
                let mut guard = session();
                let Some(s) = guard.as_mut() else { break };
                if let Some(l) = last {
                    s.dropped += due.saturating_sub(l + 1);
                }
                if let Err(e) = s.show(due, true) {
                    log::warn!("preview surface playback: {e}");
                    break;
                }
                last = Some(due);
            }
        })
        .map_err(|e| format!("could not start the playback thread: {e}"))?;
    *PLAYER.lock().unwrap_or_else(|e| e.into_inner()) = Some(Player { stop, handle });
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceStats {
    presenter: StatsReport,
    source: &'static str,
    dropped: u64,
    /// CPU→GPU bytes the source wrote (0 for the pattern; the engine's own
    /// output makes it 0 for real frames too).
    uploaded_bytes: u64,
    /// GPU→CPU bytes: there is no read-back path in this module, so this is
    /// 0 by construction, reported so a measurement records it.
    readback_bytes: u64,
    last_render_ms: f64,
    last_upload_ms: f64,
    /// Where the native view really is (AppKit's answer, in CSS pixels).
    view: native_view::ViewReport,
}

/// The presenter's measurements; `reset` clears them first.
#[tauri::command]
pub async fn chroma_preview_surface_stats(
    app: AppHandle,
    reset: Option<bool>,
) -> Result<SurfaceStats, String> {
    let view = on_webview(&app, native_view::describe)?;
    let mut guard = session();
    let s = guard.as_mut().ok_or("the preview surface is not started")?;
    if reset.unwrap_or(false) {
        s.presenter.reset_stats();
        s.dropped = 0;
        if let Source::Timeline(t) = &mut s.source {
            t.uploaded_bytes = 0;
        }
    }
    let (source, uploaded_bytes, last_render_ms, last_upload_ms) = match &s.source {
        Source::Pattern(_, PatternTarget::Texture) => ("pattern", 0, 0.0, 0.0),
        Source::Pattern(_, PatternTarget::Packed) => ("pattern-packed", 0, 0.0, 0.0),
        Source::Timeline(t) => (
            "timeline",
            t.uploaded_bytes,
            t.last_render_ms,
            t.last_upload_ms,
        ),
    };
    Ok(SurfaceStats {
        presenter: s.presenter.stats(),
        source,
        dropped: s.dropped,
        uploaded_bytes,
        readback_bytes: 0,
        last_render_ms,
        last_upload_ms,
        view,
    })
}

/// Stop playback, close the presenter and take the view out of the window.
#[tauri::command]
pub async fn chroma_preview_surface_stop(app: AppHandle) -> Result<(), String> {
    stop_player();
    let old = session().take();
    drop(old);
    on_webview(&app, |_| {
        native_view::remove();
        Ok(())
    })
}
