//! The Edit preview's Tauri commands (D-451, the product preview since
//! D-454), reached only through `@apelles/bridge`'s `previewSurface`
//! bindings from `@apelles/editor`'s `nativePreview.ts`.
//!
//! - `start` / `stop`: install the native view below the webview and open the
//!   presenter on the process's one render device; take it down.
//! - `place`: keep the view under the preview's rectangle and the picture in
//!   its box. While paused the retained frame is re-presented inside the
//!   same Core Animation transaction as the move (`presentsWithTransaction`),
//!   so a live panel drag never shows the picture behind its hole.
//! - `show`: draw one position (a scrub, a seek, an edit) and present it.
//! - `play`: start or stop the display-clocked, audio-slaved playback loop
//!   (`super::player`).
//! - `fullscreen`: the window's native fullscreen, which the webview's layout
//!   then gives to the viewer (§8: DOM fullscreen would move the page into a
//!   window the native view is not in).
//! - `stats` (debug builds only): what the presenter and the loop measured.
//!
//! No pixel crosses IPC in either direction: a rectangle, a position or a flag
//! does.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::{Duration, Instant};

use objc2_web_kit::WKWebView;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use super::native_view::{self, CssRect};
use super::player::{self, PlayRequest};
use super::presenter::{Placement, Presenter};
use crate::chroma::edit::FrameIntent;
use crate::chroma::gpu_compositor::{self, GpuFrame, RenderDevice};

/// The presenter and the frame the GPU may still be writing into it.
struct Session {
    app: AppHandle,
    presenter: Presenter,
    /// The engine's last submission into the presenter, held until the next
    /// one so its pooled buffers are released only once the GPU is done (by
    /// then, a refresh later, it is).
    in_flight: Option<GpuFrame>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Where the picture goes. Kept apart from [`SESSION`] so the main thread can
/// update it without waiting for a frame being drawn.
static PLACEMENT: Mutex<Option<Placement>> = Mutex::new(None);

/// Whether the native view is shown. A hidden layer's drawables are never
/// taken by the display, so they come back at once: presenting to it would
/// spin the playback loop rather than pace it.
static VISIBLE: AtomicBool = AtomicBool::new(false);

static PLAYER: Mutex<Option<player::Handle>> = Mutex::new(None);

/// Debug builds only: emitted once per present of the playback loop.
#[cfg(debug_assertions)]
const PRESENT_EVENT: &str = "chroma://preview-present";

fn session() -> MutexGuard<'static, Option<Session>> {
    SESSION.lock().unwrap_or_else(|e| e.into_inner())
}

fn placement() -> Option<Placement> {
    *PLACEMENT.lock().unwrap_or_else(|e| e.into_inner())
}

fn is_playing() -> bool {
    PLAYER.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// Run `f` on the main thread with the main window's `WKWebView`.
pub(crate) fn on_webview<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
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

/// Install the view and make a presenter for it on `device`.
fn open_presenter(app: &AppHandle, device: Arc<RenderDevice>) -> Result<Presenter, String> {
    let instance = device.gpu.instance.clone();
    let surface = on_webview(app, move |webview| {
        let layer = native_view::install(webview)?;
        let ptr = objc2::rc::Retained::as_ptr(&layer) as *mut std::ffi::c_void;
        // SAFETY: `ptr` is a live `CAMetalLayer`; the surface retains it
        // (wgpu-hal `Surface::from_layer`) and the view holds its own
        // reference, so it outlives the surface.
        unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(ptr))
        }
        .map_err(|e| format!("could not make a surface from the preview layer: {e}"))
    })?;
    Presenter::new(device, surface)
}

/// The session, with a presenter on the CURRENT render device: after a GPU
/// failure the device is reopened (`gpu_compositor::forget_device`), and a
/// surface configured with the forgotten one is rebuilt here.
fn current(guard: &mut Option<Session>) -> Result<&mut Session, String> {
    let s = guard.as_mut().ok_or("the preview is not started")?;
    let device = gpu_compositor::device()?;
    if !device.is_current(&s.presenter.device().gpu.device) {
        s.in_flight = None;
        s.presenter = open_presenter(&s.app, device)?;
    }
    Ok(s)
}

/// Draw `position` into the presenter (the engine's preview terminal).
fn draw(s: &mut Session, position: u64, intent: FrameIntent) -> Result<f64, String> {
    let p = placement().ok_or("the preview has not been placed yet")?;
    let long_edge = p
        .render_long_edge()
        .ok_or("the preview has no picture box yet")?;
    let began = Instant::now();
    // The previous submission is a refresh old: done, so this does not wait.
    s.in_flight = None;
    s.in_flight =
        crate::chroma::edit::draw_preview_frame(position, long_edge, intent, &mut s.presenter)?;
    let ms = began.elapsed().as_secs_f64() * 1000.0;
    #[cfg(debug_assertions)]
    super::stats::record_draw(ms);
    Ok(ms)
}

fn present(s: &mut Session) -> Result<super::presenter::PresentTiming, String> {
    let p = placement().ok_or("the preview has not been placed yet")?;
    let timing = s.presenter.present(p)?;
    #[cfg(debug_assertions)]
    super::stats::record_present(&timing);
    Ok(timing)
}

/// Install the native view under the webview and open the presenter.
#[tauri::command]
pub async fn chroma_preview_surface_start(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        stop_player();
        drop(session().take());
        let presenter = open_presenter(&app, gpu_compositor::device()?)?;
        *session() = Some(Session {
            app,
            presenter,
            in_flight: None,
        });
        Ok(())
    })
    .await
    .map_err(|e| format!("start task: {e}"))?
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceReport {
    /// The long edge the engine draws at changed: the frame on screen is a
    /// resample until the webview asks for it again (`show`), which it does
    /// once the layout has settled.
    needs_render: bool,
    /// Whether the move and the re-present were one Core Animation commit.
    presented_with_move: bool,
}

/// Move the native view under the preview's rectangle.
#[tauri::command]
pub async fn chroma_preview_surface_place(
    app: AppHandle,
    args: PlaceArgs,
) -> Result<PlaceReport, String> {
    let playing = is_playing();
    on_webview(&app, move |webview| {
        let view = args.view;
        native_view::place(webview, view, args.visible, !playing, |scale| {
            let px = |v: f64| (v * scale).round().max(1.0) as u32;
            let p = args.picture;
            let next = Placement {
                drawable: (px(view.width), px(view.height)),
                picture: [
                    ((p.x - view.x) * scale) as f32,
                    ((p.y - view.y) * scale) as f32,
                    (p.width * scale) as f32,
                    (p.height * scale) as f32,
                ],
                background: args.background,
            };
            let before = PLACEMENT
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .replace(next);
            let needs_render = before.and_then(|b| b.render_long_edge()) != next.render_long_edge();
            VISIBLE.store(args.visible, Ordering::Relaxed);
            // Paused: re-present the frame at its new place in this very
            // transaction. Never wait for a frame being drawn here (the main
            // thread): if the session is busy, that draw presents at the new
            // placement itself a moment later.
            let mut presented_with_move = false;
            if args.visible
                && !playing
                && let Ok(mut guard) = SESSION.try_lock()
                && let Some(s) = guard.as_mut()
            {
                let began = Instant::now();
                match s.presenter.present(next) {
                    Ok(_) => presented_with_move = true,
                    Err(e) => log::debug!("preview place: {e}"),
                }
                #[cfg(debug_assertions)]
                super::stats::record_place(began.elapsed().as_secs_f64() * 1000.0);
                #[cfg(not(debug_assertions))]
                let _ = began;
            }
            PlaceReport {
                needs_render,
                presented_with_move,
            }
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowReport {
    position: u64,
    render_ms: f64,
    acquire_ms: f64,
}

/// Draw `position` and show it (a scrub, a paused seek, an edit landing).
#[tauri::command]
pub async fn chroma_preview_surface_show(position: u64) -> Result<ShowReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = session();
        let s = current(&mut guard)?;
        let render_ms = draw(s, position, FrameIntent::Single)?;
        let timing = present(s)?;
        Ok(ShowReport {
            position,
            render_ms,
            acquire_ms: timing.acquire_ms,
        })
    })
    .await
    .map_err(|e| format!("show task: {e}"))?
}

/// Roadmap 00r 5d (c) — draw the two-up trim viewer's two source frames into
/// the surface and show them, in place of the timeline's frame, while a roll,
/// slip or slide is dragged. Latest-wins is the caller's (`nativePreview.ts`
/// runs one request at a time); `chroma_trim_view_end` releases the trim
/// lane's decoders when the gesture ends.
#[tauri::command]
pub async fn chroma_preview_surface_two_up(
    left: Option<crate::chroma::edit::TwoUpHalf>,
    right: Option<crate::chroma::edit::TwoUpHalf>,
) -> Result<ShowReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = session();
        let s = current(&mut guard)?;
        let p = placement().ok_or("the preview has not been placed yet")?;
        let long_edge = p
            .render_long_edge()
            .ok_or("the preview has no picture box yet")?;
        let began = Instant::now();
        s.in_flight = None;
        s.in_flight = crate::chroma::edit::draw_two_up_frame(
            left.as_ref(),
            right.as_ref(),
            long_edge,
            &mut s.presenter,
        )?;
        let render_ms = began.elapsed().as_secs_f64() * 1000.0;
        #[cfg(debug_assertions)]
        super::stats::record_draw(render_ms);
        let timing = present(s)?;
        Ok(ShowReport {
            position: 0,
            render_ms,
            acquire_ms: timing.acquire_ms,
        })
    })
    .await
    .map_err(|e| format!("two-up task: {e}"))?
}

fn stop_player() {
    let player = PLAYER.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(p) = player {
        p.stop();
    }
}

/// The real screen the playback loop drives.
struct LiveScreen;

impl player::Screen for LiveScreen {
    fn draw(&mut self, frame: u64) -> Result<(), String> {
        let mut guard = session();
        let s = current(&mut guard)?;
        draw(s, frame, FrameIntent::Playing).map(|_| ())
    }

    fn present(&mut self) -> Result<Instant, String> {
        // Hidden (another tab, a minimised window): nothing to show and no
        // display to pace by; wait a refresh's worth.
        if !VISIBLE.load(Ordering::Relaxed) {
            std::thread::sleep(player::DEFAULT_REFRESH);
            return Ok(Instant::now());
        }
        let timing = {
            let mut guard = session();
            let s = current(&mut guard)?;
            let timing = present(s)?;
            // Debug builds only: one event per display tick of the loop, which
            // `debug_frame_timing`'s `raf` channel records (the UI harness's
            // playback floor reads it).
            #[cfg(debug_assertions)]
            if timing.shown {
                use tauri::Emitter;
                let _ = s.app.emit(PRESENT_EVENT, ());
            }
            timing
        };
        // An occluded window gives no drawable and so no cadence: wait one
        // refresh's worth instead of spinning (the only time the loop is not
        // clocked by the display; the picture is not visible then).
        if !timing.shown {
            std::thread::sleep(player::DEFAULT_REFRESH);
        }
        Ok(timing.acquired_at)
    }

    fn shown(&mut self, frame: u64, clock_at_glass: Option<f64>) {
        #[cfg(debug_assertions)]
        super::stats::record_shown(frame, clock_at_glass);
        #[cfg(not(debug_assertions))]
        let _ = (frame, clock_at_glass);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayArgs {
    playing: bool,
    /// The frame on screen when Play was pressed.
    from: u64,
    fps: f64,
    /// D-280's playback rate.
    rate: f64,
    /// The timeline's length in frames.
    end: u64,
    /// The webview's monotonic stamp for this request: commands run as
    /// independent tasks, so a Pause and the Play right after it can arrive
    /// in either order; a request older than one already handled is dropped
    /// (the audio transport's D-130 protocol).
    seq: u64,
}

/// The newest play request handled, and the lock that runs them one at a time.
static PLAY_SEQ: Mutex<u64> = Mutex::new(0);

/// Start or stop playback. Starting while playing restarts from `from` (a
/// seek, a rate change).
#[tauri::command]
pub async fn chroma_preview_surface_play(app: AppHandle, args: PlayArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut newest = PLAY_SEQ.lock().unwrap_or_else(|e| e.into_inner());
        if args.seq <= *newest {
            return Ok(());
        }
        *newest = args.seq;
        stop_player();
        if !args.playing {
            return Ok(());
        }
        if !args.fps.is_finite() || args.fps <= 0.0 {
            return Err(format!("a timeline frame rate of {} cannot play", args.fps));
        }
        let req = PlayRequest {
            from: args.from,
            fps: args.fps,
            rate: if args.rate > 0.0 { args.rate } else { 1.0 },
            end: args.end,
        };
        #[cfg(debug_assertions)]
        super::stats::begin_play(req.fps);
        let handle = player::Handle::start(app, req, LiveScreen)?;
        *PLAYER.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
        Ok(())
    })
    .await
    .map_err(|e| format!("play task: {e}"))?
}

/// Stop playback, close the presenter and take the view out of the window.
#[tauri::command]
pub async fn chroma_preview_surface_stop(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        stop_player();
        drop(session().take());
        *PLACEMENT.lock().unwrap_or_else(|e| e.into_inner()) = None;
        VISIBLE.store(false, Ordering::Relaxed);
        on_webview(&app, |_| {
            native_view::remove();
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("stop task: {e}"))?
}

/// The window's native fullscreen on or off (§8). The webview hears the
/// result as `chroma://window-fullscreen` (`lib.rs`'s resize handler), however
/// it was reached (this command, the green button, Ctrl-Cmd-F, Esc).
#[tauri::command]
pub async fn chroma_preview_surface_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("the main window is not open")?;
    window
        .set_fullscreen(on)
        .map_err(|e| format!("could not change fullscreen: {e}"))
}

/// **Debug builds only (B-151's pattern for the Edit preview):** the frame on
/// screen, read back, and where the native view is in the webview's CSS
/// pixels, for `debug_screenshot` to composite into its webview snapshot,
/// which cannot see a native layer. `None` when the preview is not showing.
#[cfg(debug_assertions)]
pub(crate) fn screenshot_frame<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Option<(image::RgbaImage, native_view::ViewReport, Placement)>, String> {
    let view = match on_webview(app, native_view::describe) {
        Ok(v) if !v.hidden && v.width >= 1.0 && v.height >= 1.0 => v,
        _ => return Ok(None),
    };
    let Some(p) = placement() else {
        return Ok(None);
    };
    let guard = session();
    let Some(s) = guard.as_ref() else {
        return Ok(None);
    };
    Ok(s.presenter.read_frame()?.map(|img| (img, view, p)))
}

/// **Debug builds only:** the presenter's and the playback loop's
/// measurements (`debug_native_preview_stats`, `debug_frame_timing`); `reset`
/// clears them first.
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn chroma_preview_surface_stats(
    app: AppHandle,
    reset: Option<bool>,
) -> Result<super::stats::StatsReport, String> {
    if reset.unwrap_or(false) {
        super::stats::reset();
    }
    let view = on_webview(&app, native_view::describe).ok();
    let surface = session().as_ref().map(|s| s.presenter.surface_report());
    Ok(super::stats::report(view, surface, is_playing()))
}
