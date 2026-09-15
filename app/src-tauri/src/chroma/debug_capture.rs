//! debug_capture.rs — in-process WKWebView screenshot + PNG pixel probe (D-210).
//!
//! What it is: the ONE way an agent (or a human filing a bug) gets a real,
//!   pixel-accurate picture of what this app's window is actually showing,
//!   from inside the app's own process. It asks the WKWebView that renders
//!   Apelles' whole UI to snapshot ITSELF
//!   (`-[WKWebView takeSnapshotWithConfiguration:completionHandler:]`,
//!   macOS 10.13+), converts the resulting `NSImage` to PNG bytes, and
//!   writes them to disk. A second, much smaller entry point reads one pixel
//!   back out of a saved PNG, which is what "is the box drawn on the right
//!   part of the picture / is this swatch the colour we set" verification
//!   actually needs.
//!
//! Why this exists at all: macOS gates SYSTEM-level screen capture
//!   (`screencapture(1)`, `CGWindowListCreateImage`, ScreenCaptureKit) behind
//!   the Screen Recording TCC permission, which a headless agent process in
//!   this repo does not have and cannot grant itself — every attempt to
//!   verify a UI fix by looking at the screen has failed on exactly that wall
//!   and had to fall back to indirect signals (state polling, probing an
//!   exported file instead of the live preview). `takeSnapshot` is not screen
//!   capture: it is a webview rendering its own content, in the process that
//!   already owns it, so no TCC permission, entitlement, or user prompt is
//!   involved. See `docs/notes/debug-screenshot-tool.md`.
//!
//! What it does NOT do: capture anything outside the webview — the native
//!   window chrome/title bar, a native menu, a native file dialog, another
//!   app, or a second display are all invisible to it (that IS system screen
//!   capture, and it is exactly what we cannot do). It also does not diff two
//!   screenshots, annotate one, or know anything about Apelles' UI: it hands
//!   back a PNG path and the caller looks at it.
//!
//! One deliberate exception to "just the webview" (B-151, 2026-09-10): the
//! Colorist tab's picture is not webview content at all — it is a native
//! wgpu surface painted directly onto the window BEHIND the webview
//! (`gpu_processing::WgpuDisplay`, `packages/shell/src/store.ts`'s
//! `wgpuSurfaceActive`), so `takeSnapshotWithConfiguration:` alone always
//! returned whatever static, deliberately-transparent DOM sat in the "hole"
//! that surface shows through — a blank frame, byte-identical no matter what
//! the grade did. `screenshot_to_file` now also reads back that surface's
//! current texture on demand (`gpu_processing::read_display_frame` — never on
//! the interactive render path, only here) and composites it into the
//! webview PNG at its own on-screen rect before writing the file, so the
//! result matches what a human actually sees. See `composite_wgpu_overlay`.
//!
//! Platform: macOS only, deliberately. v1 is macOS ARM (`docs/02-scope.md`)
//!   and the equivalent Windows/Linux calls are different APIs with different
//!   async shapes; the non-macOS build returns a real "not supported here"
//!   error rather than a silently blank image.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use tauri::{Manager, Runtime};

/// How long we wait for WebKit's completion handler after asking for the
/// snapshot. WebKit answers in single-digit milliseconds for a healthy
/// window; a budget this generous only ever matters when the web content
/// process is wedged, which is a real answer worth reporting rather than
/// hanging on.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Directory screenshots land in when the caller doesn't name a path.
/// Overridable with `CHROMA_DEBUG_SHOTS_DIR` (useful for pinning a session's
/// before/after pair somewhere specific, e.g. the repo's gitignored
/// `scratch/`). Deliberately NOT inside the repo by default: the app also
/// runs as a built `.app` with no repo anywhere near it, and a debug tool
/// must never drop files into a tracked tree.
const SHOTS_DIR_ENV: &str = "CHROMA_DEBUG_SHOTS_DIR";
const SHOTS_DIR_NAME: &str = "chroma-debug-screenshots";

/// One captured webview frame, still in memory.
#[derive(Debug, Clone)]
pub struct CapturedFrame {
    pub png: Vec<u8>,
    /// Real image pixels, i.e. CSS pixels × the window's backing scale
    /// factor (2 on a Retina display). Not CSS pixels.
    pub width: u32,
    pub height: u32,
}

/// One captured webview frame as tightly-packed RAW pixels (D-330).
///
/// Why this exists next to [`CapturedFrame`]: the video recorder needs tens
/// of frames per second, and PNG encoding is by far the most expensive step
/// of a screenshot — compressing a 2560×1440 frame costs far more than
/// WebKit spends rendering it. A recorder that went through PNG would be
/// measuring its own encoder, and worse, would steal enough main-thread time
/// to make the app's frame rate — the thing being recorded — visibly worse.
/// These bytes go straight down `ffmpeg`'s stdin instead, so nothing is
/// encoded twice and nothing is compressed on this side at all.
///
/// `rows` are already stripped of any `bytesPerRow` padding, so
/// `bytes.len() == width * height * bytes_per_pixel` exactly, which is what
/// `-f rawvideo` requires.
#[derive(Debug, Clone)]
pub struct CapturedRaw {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// The ffmpeg `-pixel_format` name that describes `bytes`' byte order
    /// EXACTLY as AppKit laid it out — see [`ffmpeg_pix_fmt`]. Carried
    /// rather than normalised because telling the encoder the real layout is
    /// free, whereas swizzling every pixel on this side is not.
    pub pix_fmt: &'static str,
}

/// Bytes per pixel for the pixel formats [`ffmpeg_pix_fmt`] can return.
pub(crate) fn pix_fmt_bytes_per_pixel(pix_fmt: &str) -> usize {
    match pix_fmt {
        "rgb24" => 3,
        _ => 4,
    }
}

/// Map an `NSBitmapImageRep`'s declared layout onto the ffmpeg
/// `-pixel_format` name for the same byte order (D-330). Pure integer/flag
/// logic, split out from the AppKit call so the mapping — the one part of
/// the raw path that is easy to get subtly, silently wrong — is unit-tested
/// without a window.
///
/// The flags describe MEMORY order. Without `ThirtyTwoBitLittleEndian` the
/// samples sit in their natural order (alpha-first ⇒ `ARGB`, otherwise
/// `RGBA`); with it, each 32-bit word is byte-swapped, so the same two cases
/// become `BGRA` and `ABGR`. Getting this backwards does not fail — it
/// produces a recording with the red and blue channels swapped, which is
/// exactly the kind of quietly-wrong output this tool must not emit.
///
/// `None` means "a layout this fast path does not claim to understand"
/// (floating-point samples, 16-bit channels, anything planar), and the caller
/// falls back to a real decode rather than guessing.
pub(crate) fn ffmpeg_pix_fmt(
    bits_per_pixel: i64,
    samples_per_pixel: i64,
    alpha_first: bool,
    little_endian: bool,
    floating_point: bool,
) -> Option<&'static str> {
    if floating_point {
        return None;
    }
    match (bits_per_pixel, samples_per_pixel) {
        (32, 4) => Some(match (little_endian, alpha_first) {
            (false, true) => "argb",
            (false, false) => "rgba",
            (true, true) => "bgra",
            (true, false) => "abgr",
        }),
        // 24bpp has no alpha to place and no 32-bit word to swap, so the
        // endianness flag cannot apply to it.
        (24, 3) if !little_endian => Some("rgb24"),
        _ => None,
    }
}

/// What a caller gets back after the frame has been written to disk.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugScreenshot {
    /// Absolute path of the written PNG — read this file to see the app.
    pub path: String,
    /// Which window was captured (Tauri label).
    pub label: String,
    pub width: u32,
    pub height: u32,
    /// `width`/`height` are CSS pixels × this. Divide by it to map a
    /// screenshot coordinate back to a DOM/CSS coordinate.
    pub scale_factor: f64,
    pub bytes: usize,
}

/// One pixel read back out of a saved PNG.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelSample {
    pub x: u32,
    pub y: u32,
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
    /// `#rrggbb`, for eyeballing against a CSS token value.
    pub hex: String,
    /// The image the sample came from, so a caller can tell immediately that
    /// it addressed a 2× screenshot with 1× coordinates.
    pub image_width: u32,
    pub image_height: u32,
}

/// Default output directory, honouring `CHROMA_DEBUG_SHOTS_DIR`.
pub fn shots_dir() -> PathBuf {
    match std::env::var(SHOTS_DIR_ENV) {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => std::env::temp_dir().join(SHOTS_DIR_NAME),
    }
}

/// `<shots_dir>/<label>-<local timestamp>.png`. Sortable, collision-free at
/// millisecond resolution, and self-describing — a before/after pair reads
/// in order in a directory listing.
fn generated_path(label: &str) -> PathBuf {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S-%3f");
    shots_dir().join(format!("{label}-{stamp}.png"))
}

/// Pick the window to capture. An explicit label wins; otherwise the focused
/// window, else `main`, else the only one there is. Every failure names the
/// labels that DO exist rather than just saying no.
fn resolve_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: Option<&str>,
) -> Result<tauri::WebviewWindow<R>, String> {
    let windows = app.webview_windows();
    if windows.is_empty() {
        return Err("no window is open — nothing to capture".to_string());
    }

    if let Some(label) = label {
        return windows.get(label).cloned().ok_or_else(|| {
            let mut have: Vec<&str> = windows.keys().map(String::as_str).collect();
            have.sort_unstable();
            format!("no window labelled '{label}' (open: {})", have.join(", "))
        });
    }

    if let Some(focused) = windows
        .values()
        .find(|w| w.is_focused().unwrap_or(false))
        .cloned()
    {
        return Ok(focused);
    }
    if let Some(main) = windows.get("main").cloned() {
        return Ok(main);
    }
    windows
        .values()
        .next()
        .cloned()
        .ok_or_else(|| "no window is open — nothing to capture".to_string())
}

/// [`resolve_window`] plus the checks that make a capture worth attempting
/// at all: a minimised or hidden window has no rendered web content, and an
/// honest error about that beats a black rectangle the caller then has to
/// diagnose. Shared by the screenshot and the D-330 video recorder — the
/// recorder needs exactly the same guarantee, and needs it BEFORE it spends
/// N seconds recording nothing.
pub(crate) fn resolve_capturable_window<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window_label: Option<&str>,
) -> Result<tauri::WebviewWindow<R>, String> {
    let window = resolve_window(app, window_label)?;
    let label = window.label().to_string();
    if window.is_minimized().unwrap_or(false) {
        return Err(format!(
            "window '{label}' is minimised — restore it before capturing"
        ));
    }
    if !window.is_visible().unwrap_or(true) {
        return Err(format!(
            "window '{label}' is hidden — show it before capturing"
        ));
    }
    Ok(window)
}

/// Capture `window`'s webview and write it to `out_path` (or a generated
/// path under [`shots_dir`]). Blocks the calling thread until WebKit's
/// completion handler fires, so it must NOT be called on the main thread —
/// the snapshot itself is dispatched there. The Tauri command and the
/// control-server route both call this from a background thread.
pub fn screenshot_to_file<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window_label: Option<&str>,
    out_path: Option<&str>,
) -> Result<DebugScreenshot, String> {
    let window = resolve_capturable_window(app, window_label)?;
    let label = window.label().to_string();
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let mut frame = capture_webview_png(&window)?;
    composite_wgpu_overlay(app, &mut frame);

    let path = match out_path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => generated_path(&label),
    };
    write_png(&path, &frame.png)?;

    log::info!(
        "[chroma::debug_capture] captured '{label}' {}x{} -> {}",
        frame.width,
        frame.height,
        path.display()
    );

    Ok(DebugScreenshot {
        path: path.to_string_lossy().into_owned(),
        label,
        width: frame.width,
        height: frame.height,
        scale_factor,
        bytes: frame.png.len(),
    })
}

/// Where (and at what size) to paste the wgpu overlay onto a screenshot, in
/// the screenshot's own pixel grid — pure geometry, no image data, so this is
/// unit-testable without a GPU or a running app (see the `tests` module).
///
/// Mirrors `shaders/display.wgsl`'s own placement exactly: the source image
/// is stretched to fill `rect`, then only the part of `rect` that falls
/// inside `clip` is actually visible (the shader's fragment stage returns the
/// background colour outside `clip`, never the texture). All of `rect`,
/// `clip` and `window` are in the SAME device-pixel grid the on-screen
/// `syncWgpu` (`Editor.tsx`) last posted them in.
#[derive(Debug, Clone, Copy, PartialEq)]
struct OverlayPlacement {
    /// Size to resize the whole (unclipped) source image to before cropping.
    resize_w: u32,
    resize_h: u32,
    /// Crop of the resized image that is actually visible (post-clip).
    crop_x: u32,
    crop_y: u32,
    crop_w: u32,
    crop_h: u32,
    /// Where that crop lands on the destination canvas.
    dst_x: i64,
    dst_y: i64,
}

/// `frame_w`/`frame_h` is the actual screenshot's pixel size, which can
/// differ slightly from `window` if the window was resized between the last
/// `syncWgpu` layout post and this screenshot — `sx`/`sy` correct for that.
/// Returns `None` when there is nothing visible to paste (the rect and clip
/// don't overlap, or either has a non-positive extent).
fn compute_overlay_placement(
    rect: [f32; 4],
    clip: [f32; 4],
    window: [f32; 2],
    frame_w: u32,
    frame_h: u32,
) -> Option<OverlayPlacement> {
    let win_w = window[0].max(1.0);
    let win_h = window[1].max(1.0);
    let sx = frame_w as f32 / win_w;
    let sy = frame_h as f32 / win_h;

    let clip_x0 = (clip[0] * sx).max(0.0);
    let clip_y0 = (clip[1] * sy).max(0.0);
    let clip_x1 = ((clip[0] + clip[2]) * sx).min(frame_w as f32);
    let clip_y1 = ((clip[1] + clip[3]) * sy).min(frame_h as f32);

    let rect_x0 = rect[0] * sx;
    let rect_y0 = rect[1] * sy;
    let rect_w = (rect[2] * sx).max(1.0);
    let rect_h = (rect[3] * sy).max(1.0);

    // The visible slice: the shader clips `rect` to `clip` (its own
    // scrollable/cropped viewport) before ever reaching the screen, so a
    // screenshot must intersect the same two rects rather than pasting the
    // whole (possibly larger) `rect` and overrunning neighbouring UI.
    let dst_x0 = rect_x0.max(clip_x0).max(0.0);
    let dst_y0 = rect_y0.max(clip_y0).max(0.0);
    let dst_x1 = (rect_x0 + rect_w).min(clip_x1);
    let dst_y1 = (rect_y0 + rect_h).min(clip_y1);
    if dst_x1 <= dst_x0 || dst_y1 <= dst_y0 {
        return None;
    }

    let resize_w = rect_w.round() as u32;
    let resize_h = rect_h.round() as u32;

    // Offset into the resized (whole-`rect`-sized) image by however much the
    // clip cut off its own top-left corner.
    let crop_x = (dst_x0 - rect_x0).round().max(0.0) as u32;
    let crop_y = (dst_y0 - rect_y0).round().max(0.0) as u32;
    let crop_w =
        ((dst_x1 - dst_x0).round().max(1.0) as u32).min(resize_w.saturating_sub(crop_x).max(1));
    let crop_h =
        ((dst_y1 - dst_y0).round().max(1.0) as u32).min(resize_h.saturating_sub(crop_y).max(1));

    Some(OverlayPlacement {
        resize_w,
        resize_h,
        crop_x,
        crop_y,
        crop_w,
        crop_h,
        dst_x: dst_x0.round() as i64,
        dst_y: dst_y0.round() as i64,
    })
}

/// Paste Colorist's native wgpu-rendered picture into a webview screenshot,
/// in place, if (and only if) that surface currently has something on screen
/// — see the module doc and `gpu_processing::read_display_frame` for why this
/// is necessary at all.
///
/// Failure here (a bad PNG decode, a texture readback that timed out) is
/// deliberately swallowed rather than turning the whole screenshot call into
/// an error: the webview frame captured just above is still a real, valid
/// screenshot on its own for every OTHER tab, and even for Colorist a
/// same-as-before blank is a strictly less useful failure mode than losing
/// the screenshot outright over a best-effort overlay. A warning is logged
/// either way so the gap is visible rather than silently swallowed.
fn composite_wgpu_overlay<R: Runtime>(app: &tauri::AppHandle<R>, frame: &mut CapturedFrame) {
    let state = app.state::<crate::AppState>();
    let Some((overlay, transform)) = crate::gpu_processing::read_display_frame(&state) else {
        return;
    };

    let mut canvas = match image::load_from_memory(&frame.png) {
        Ok(img) => img.to_rgba8(),
        Err(e) => {
            log::warn!(
                "[chroma::debug_capture] could not decode the webview snapshot to composite \
                 the Colorist wgpu overlay onto it: {e}"
            );
            return;
        }
    };

    let Some(placement) = compute_overlay_placement(
        transform.rect,
        transform.clip,
        transform.window,
        frame.width,
        frame.height,
    ) else {
        return;
    };

    let resized = image::imageops::resize(
        &overlay.to_rgba8(),
        placement.resize_w,
        placement.resize_h,
        image::imageops::FilterType::Triangle,
    );
    let visible = image::imageops::crop_imm(
        &resized,
        placement.crop_x,
        placement.crop_y,
        placement.crop_w,
        placement.crop_h,
    )
    .to_image();

    image::imageops::overlay(&mut canvas, &visible, placement.dst_x, placement.dst_y);

    let mut png_bytes = Vec::new();
    if let Err(e) = image::DynamicImage::ImageRgba8(canvas).write_to(
        &mut std::io::Cursor::new(&mut png_bytes),
        image::ImageFormat::Png,
    ) {
        log::warn!(
            "[chroma::debug_capture] could not re-encode the screenshot after compositing the \
             Colorist wgpu overlay: {e}"
        );
        return;
    }
    frame.png = png_bytes;
}

fn write_png(path: &Path, png: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, png).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Read one pixel out of a saved screenshot. Pure file I/O + decode — no
/// window, no app state, so it works on an old screenshot long after the app
/// has moved on.
pub fn sample_png_pixel(path: &str, x: u32, y: u32) -> Result<PixelSample, String> {
    let img = image::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let rgba = img.to_rgba8();
    let (image_width, image_height) = rgba.dimensions();
    if x >= image_width || y >= image_height {
        return Err(format!(
            "({x}, {y}) is outside the {image_width}x{image_height} image"
        ));
    }
    let px = rgba.get_pixel(x, y).0;
    Ok(PixelSample {
        x,
        y,
        r: px[0],
        g: px[1],
        b: px[2],
        a: px[3],
        hex: format!("#{:02x}{:02x}{:02x}", px[0], px[1], px[2]),
        image_width,
        image_height,
    })
}

// --------------------------------------------------------------------------
// The platform capture itself.
// --------------------------------------------------------------------------

/// Ask the window's webview to snapshot itself and hand back PNG bytes.
///
/// The snapshot has to be started on the main thread (AppKit), and WebKit
/// answers asynchronously on that same thread, so the shape is: dispatch onto
/// the main thread via Tauri's `with_webview`, kick off `takeSnapshot`, and
/// let its completion block send the encoded PNG back over a channel this
/// (background) thread is waiting on.
#[cfg(target_os = "macos")]
pub fn capture_webview_png<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<CapturedFrame, String> {
    capture_webview_with(window, None, png_from_ns_image)
}

/// Capture the webview as raw, tightly-packed pixels (D-330).
///
/// `snapshot_width` is WebKit's own `WKSnapshotConfiguration.snapshotWidth`,
/// **in points** — the supported way to ask for a SMALLER snapshot, which
/// makes WebKit rasterise less rather than making us downscale a full-size
/// one afterwards. That distinction is the whole reason the parameter is
/// plumbed through: for a recorder the cost of the capture is charged to the
/// app being recorded, so asking for fewer pixels up front is the difference
/// between measuring the app and measuring the measurement. `None` means the
/// native backing size, exactly as [`capture_webview_png`] takes it.
///
/// **Points, not pixels** — the resulting image comes back at
/// `snapshot_width × scaleFactor` real pixels, so passing a window's own
/// point width changes nothing at all on a Retina display. Callers that mean
/// an output resolution must divide by the scale factor first;
/// `debug_record::snapshot_width` is where that conversion lives, and its
/// doc records the live measurement that caught it.
#[cfg(target_os = "macos")]
pub fn capture_webview_raw<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    snapshot_width: Option<f64>,
) -> Result<CapturedRaw, String> {
    capture_webview_with(window, snapshot_width, raw_from_ns_image)
}

/// The shared snapshot plumbing behind [`capture_webview_png`] and
/// [`capture_webview_raw`] — dispatch to the main thread, ask WebKit for a
/// snapshot, and let its completion block send `convert`'s output back over
/// a channel this (background) thread waits on.
///
/// `convert` is a plain `fn` pointer rather than a closure on purpose: the
/// completion block must be `Send + 'static`, and a function pointer is both
/// without dragging any captured state across the thread boundary.
#[cfg(target_os = "macos")]
fn capture_webview_with<R: Runtime, T: Send + 'static>(
    window: &tauri::WebviewWindow<R>,
    snapshot_width: Option<f64>,
    convert: fn(&objc2_app_kit::NSImage) -> Result<T, String>,
) -> Result<T, String> {
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    let (tx, rx) = mpsc::channel::<Result<T, String>>();

    window
        .with_webview(move |platform| {
            let raw = platform.inner();
            if raw.is_null() {
                let _ = tx.send(Err("the window has no WKWebView handle".to_string()));
                return;
            }
            // SAFETY: Tauri documents `PlatformWebview::inner()` on macOS as
            // the window's `WKWebView`, and this closure runs on the main
            // thread while that webview is alive (Tauri owns it for the
            // lifetime of the window).
            let webview: &WKWebView = unsafe { &*raw.cast::<WKWebView>() };

            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = if !image.is_null() {
                    // SAFETY: WebKit hands the block a valid, autoreleased
                    // NSImage; we only borrow it for this call.
                    convert(unsafe { &*image })
                } else if !error.is_null() {
                    // SAFETY: as above, for the error branch.
                    let description = unsafe { &*error }.localizedDescription();
                    Err(format!("WKWebView takeSnapshot failed: {description}"))
                } else {
                    Err("WKWebView takeSnapshot returned neither an image nor an error".to_string())
                };
                let _ = tx.send(result);
            });

            // A `nil` configuration means "the whole visible viewport at its
            // native backing scale", which is what a screenshot wants. A
            // caller that named a `snapshot_width` gets a real
            // `WKSnapshotConfiguration` instead, so WebKit rasterises at that
            // width rather than us shrinking a full-size image afterwards.
            // `afterScreenUpdates` is deliberately left at its default (YES):
            // the point of a recording is what was actually on screen, and
            // turning it off trades that for speed we do not need.
            let config = snapshot_width.and_then(|width| {
                // `WKSnapshotConfiguration::new` demands proof we are on the
                // main thread. We are — `with_webview` dispatches there — but
                // the checked constructor is still the right way to say so.
                let mtm = objc2_foundation::MainThreadMarker::new()?;
                let config = unsafe { objc2_web_kit::WKSnapshotConfiguration::new(mtm) };
                let number = objc2_foundation::NSNumber::new_f64(width);
                unsafe { config.setSnapshotWidth(Some(&number)) };
                Some(config)
            });

            // SAFETY: a plain AppKit call on the main thread. WebKit copies
            // the completion block, so dropping our `RcBlock` afterwards is
            // correct.
            unsafe {
                webview
                    .takeSnapshotWithConfiguration_completionHandler(config.as_deref(), &handler);
            }
        })
        .map_err(|e| format!("could not reach the window's webview: {e}"))?;

    match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "WKWebView did not answer the snapshot within {}s — the web content process may be busy or wedged",
            CAPTURE_TIMEOUT.as_secs()
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("the snapshot request was dropped before it produced a frame".to_string())
        }
    }
}

/// `NSImage` → PNG bytes, via `NSBitmapImageRep` — AppKit's own encoder, so
/// the bytes match what any other macOS app would write, and the size we
/// report is the real pixel size of the backing representation (2× the CSS
/// size on a Retina display) rather than the point size.
#[cfg(target_os = "macos")]
fn png_from_ns_image(image: &objc2_app_kit::NSImage) -> Result<CapturedFrame, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "the snapshot had no bitmap representation".to_string())?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| "could not read the snapshot's bitmap representation".to_string())?;

    let properties = NSDictionary::new();
    // SAFETY: an empty, correctly-typed properties dictionary; PNG needs no
    // encoder options.
    let png =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
            .ok_or_else(|| "could not encode the snapshot as PNG".to_string())?;

    let width = rep.pixelsWide().max(0) as u32;
    let height = rep.pixelsHigh().max(0) as u32;
    if width == 0 || height == 0 {
        return Err("the snapshot came back empty (0x0)".to_string());
    }

    Ok(CapturedFrame {
        png: png.to_vec(),
        width,
        height,
    })
}

/// `NSImage` → tightly-packed raw pixels (D-330), with no image codec in the
/// path at all on the fast route.
///
/// Two routes, and which one ran is worth knowing when a recording looks
/// wrong:
///  * **Fast** — the rep's own buffer is already 8-bit, non-planar, and in a
///    layout [`ffmpeg_pix_fmt`] recognises, so this copies it row by row
///    (stripping any `bytesPerRow` padding) and names the layout for ffmpeg.
///    No decode, no encode, no channel swizzle.
///  * **Fallback** — anything else (planar, 16-bit, floating point). Decodes
///    the TIFF properly with the `image` crate and hands back RGBA8. Slower,
///    but correct, and it reports itself through `pix_fmt` rather than
///    guessing at a layout and silently swapping the colour channels.
#[cfg(target_os = "macos")]
fn raw_from_ns_image(image: &objc2_app_kit::NSImage) -> Result<CapturedRaw, String> {
    use objc2_app_kit::{NSBitmapFormat, NSBitmapImageRep};

    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "the snapshot had no bitmap representation".to_string())?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| "could not read the snapshot's bitmap representation".to_string())?;

    let width = rep.pixelsWide().max(0) as u32;
    let height = rep.pixelsHigh().max(0) as u32;
    if width == 0 || height == 0 {
        return Err("the snapshot came back empty (0x0)".to_string());
    }

    let format = rep.bitmapFormat();
    let pix_fmt = if rep.isPlanar() {
        None
    } else {
        ffmpeg_pix_fmt(
            rep.bitsPerPixel() as i64,
            rep.samplesPerPixel() as i64,
            format.contains(NSBitmapFormat::AlphaFirst),
            format.contains(NSBitmapFormat::ThirtyTwoBitLittleEndian),
            format.contains(NSBitmapFormat::FloatingPointSamples),
        )
    };

    if let Some(pix_fmt) = pix_fmt {
        let bpp = pix_fmt_bytes_per_pixel(pix_fmt);
        let stride = rep.bytesPerRow().max(0) as usize;
        let row_bytes = width as usize * bpp;
        let data = rep.bitmapData();
        if !data.is_null() && stride >= row_bytes {
            let mut bytes = Vec::with_capacity(row_bytes * height as usize);
            for row in 0..height as usize {
                // SAFETY: `bitmapData` is the rep's own buffer, which is
                // `bytesPerRow * pixelsHigh` bytes long and alive for as long
                // as `rep` is; every read below is inside that, and the rep
                // outlives this loop.
                let slice =
                    unsafe { std::slice::from_raw_parts(data.add(row * stride), row_bytes) };
                bytes.extend_from_slice(slice);
            }
            return Ok(CapturedRaw {
                bytes,
                width,
                height,
                pix_fmt,
            });
        }
    }

    // Fallback: a layout the fast path does not claim to understand. Decode
    // it properly rather than reinterpreting the bytes and hoping.
    log::debug!(
        "[chroma::debug_capture] snapshot layout not on the raw fast path \
         (bpp {}, spp {}, planar {}) — decoding the TIFF instead",
        rep.bitsPerPixel(),
        rep.samplesPerPixel(),
        rep.isPlanar(),
    );
    let decoded = image::load_from_memory(&tiff.to_vec())
        .map_err(|e| format!("could not decode the snapshot: {e}"))?
        .to_rgba8();
    let (width, height) = decoded.dimensions();
    Ok(CapturedRaw {
        bytes: decoded.into_raw(),
        width,
        height,
        pix_fmt: "rgba",
    })
}

#[cfg(not(target_os = "macos"))]
pub fn capture_webview_raw<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
    _snapshot_width: Option<f64>,
) -> Result<CapturedRaw, String> {
    Err(
        "webview snapshot is implemented for macOS only (WKWebView takeSnapshot) — see \
         docs/notes/debug-screenshot-tool.md"
            .to_string(),
    )
}

#[cfg(not(target_os = "macos"))]
pub fn capture_webview_png<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> Result<CapturedFrame, String> {
    Err(
        "webview snapshot is implemented for macOS only (WKWebView takeSnapshot) — see \
         docs/notes/debug-screenshot-tool.md"
            .to_string(),
    )
}

// --------------------------------------------------------------------------
// Tauri commands.
// --------------------------------------------------------------------------

/// Screenshot the app's own webview. `windowLabel` picks a window by label
/// (default: the focused one, else `main`); `outPath` picks an absolute
/// destination (default: a timestamped file under [`shots_dir`]). Runs on a
/// background thread because the capture blocks waiting on the main thread's
/// reply.
///
/// The label parameter is `window_label`, not `window`, deliberately: Tauri
/// injects a real `tauri::Window` for a parameter of that type, and a
/// same-named `Option<String>` next to it is exactly the kind of collision
/// that is easier to avoid than to debug.
#[tauri::command]
pub async fn chroma_debug_screenshot(
    app: tauri::AppHandle,
    window_label: Option<String>,
    out_path: Option<String>,
) -> Result<DebugScreenshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        screenshot_to_file(&app, window_label.as_deref(), out_path.as_deref())
    })
    .await
    .map_err(|e| format!("screenshot task panicked: {e}"))?
}

/// Read one pixel out of a saved screenshot. Coordinates are IMAGE pixels
/// (see `scaleFactor` on the screenshot result).
#[tauri::command]
pub async fn chroma_debug_sample_pixel(
    path: String,
    x: u32,
    y: u32,
) -> Result<PixelSample, String> {
    tauri::async_runtime::spawn_blocking(move || sample_png_pixel(&path, x, y))
        .await
        .map_err(|e| format!("pixel sample task panicked: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- compute_overlay_placement (B-151) -------------------------------

    #[test]
    fn full_window_rect_with_no_clipping_maps_one_to_one() {
        // The common "Colorist fills the whole preview pane, no scroll/crop"
        // case: rect == clip == the whole window, screenshot pixels == the
        // transform's own recorded window size. Nothing should be cropped.
        let p = compute_overlay_placement(
            [0.0, 0.0, 1000.0, 800.0],
            [0.0, 0.0, 1000.0, 800.0],
            [1000.0, 800.0],
            1000,
            800,
        )
        .expect("a full-window rect must be visible");
        assert_eq!(p.resize_w, 1000);
        assert_eq!(p.resize_h, 800);
        assert_eq!((p.crop_x, p.crop_y), (0, 0));
        assert_eq!((p.crop_w, p.crop_h), (1000, 800));
        assert_eq!((p.dst_x, p.dst_y), (0, 0));
    }

    #[test]
    fn a_clip_smaller_than_rect_crops_to_just_the_clip() {
        // The overlay is bigger than its visible viewport (e.g. zoomed in) —
        // only the clip's own window should end up on the screenshot, not
        // the whole (partially off-panel) rect.
        let p = compute_overlay_placement(
            [0.0, 0.0, 2000.0, 2000.0],
            [100.0, 200.0, 300.0, 400.0],
            [2000.0, 2000.0],
            2000,
            2000,
        )
        .expect("overlapping rect/clip must be visible");
        assert_eq!((p.crop_w, p.crop_h), (300, 400));
        assert_eq!((p.dst_x, p.dst_y), (100, 200));
        // crop offset into the resized (rect-sized) image is exactly where
        // the clip starts, since rect's own origin is (0,0).
        assert_eq!((p.crop_x, p.crop_y), (100, 200));
    }

    #[test]
    fn the_shells_hidden_sentinel_position_still_yields_no_visible_placement() {
        // `Editor.tsx`'s `syncWgpu` parks the rect off-window at -999999 when
        // nothing should be drawn — `read_display_frame` already short-circuits
        // on this before it ever reaches this function, but the geometry
        // itself must also treat it as "nothing to show" defensively (an
        // off-window rect can never intersect an on-window clip).
        let p = compute_overlay_placement(
            [-999_999.0, -999_999.0, 1.0, 1.0],
            [0.0, 0.0, 1000.0, 800.0],
            [1000.0, 800.0],
            1000,
            800,
        );
        assert!(p.is_none());
    }

    #[test]
    fn a_resized_window_scales_the_transform_to_the_real_screenshot_size() {
        // The screenshot came out at 2x the window size the last `syncWgpu`
        // transform was posted at (e.g. the window grew right before this
        // screenshot ran) — rect/clip must scale up by the same factor so the
        // overlay still lands in the right place on the LARGER screenshot.
        let p = compute_overlay_placement(
            [0.0, 0.0, 500.0, 400.0],
            [0.0, 0.0, 500.0, 400.0],
            [500.0, 400.0],
            1000,
            800,
        )
        .expect("must still be visible after scaling");
        assert_eq!((p.resize_w, p.resize_h), (1000, 800));
        assert_eq!((p.dst_x, p.dst_y), (0, 0));
    }

    #[test]
    fn a_rect_entirely_outside_the_clip_has_no_visible_placement() {
        let p = compute_overlay_placement(
            [900.0, 900.0, 100.0, 100.0],
            [0.0, 0.0, 500.0, 500.0],
            [1000.0, 1000.0],
            1000,
            1000,
        );
        assert!(p.is_none());
    }

    // -- ffmpeg_pix_fmt (D-330) ------------------------------------------

    #[test]
    fn natural_order_32bit_maps_to_argb_or_rgba_by_alpha_position() {
        assert_eq!(ffmpeg_pix_fmt(32, 4, true, false, false), Some("argb"));
        assert_eq!(ffmpeg_pix_fmt(32, 4, false, false, false), Some("rgba"));
    }

    #[test]
    fn little_endian_32bit_byte_swaps_each_word() {
        // The whole reason this mapping is a tested function: getting the
        // swap backwards does not fail, it silently records with red and
        // blue exchanged.
        assert_eq!(ffmpeg_pix_fmt(32, 4, true, true, false), Some("bgra"));
        assert_eq!(ffmpeg_pix_fmt(32, 4, false, true, false), Some("abgr"));
    }

    #[test]
    fn packed_24bit_rgb_is_recognised() {
        assert_eq!(ffmpeg_pix_fmt(24, 3, false, false, false), Some("rgb24"));
    }

    #[test]
    fn layouts_the_fast_path_does_not_understand_are_refused_not_guessed() {
        // Floating point samples, 16-bit channels, and a 24bpp rep that
        // somehow claims 32-bit-little-endian are all "fall back and decode
        // properly", never "reinterpret these bytes and hope".
        assert_eq!(ffmpeg_pix_fmt(32, 4, false, false, true), None);
        assert_eq!(ffmpeg_pix_fmt(64, 4, false, false, false), None);
        assert_eq!(ffmpeg_pix_fmt(48, 3, false, false, false), None);
        assert_eq!(ffmpeg_pix_fmt(24, 3, false, true, false), None);
        // 32bpp with only three samples (an ignored padding byte, `xRGB`) is
        // real on macOS but is NOT one of the four cases above, so it must
        // take the honest fallback rather than being mapped to `rgba`.
        assert_eq!(ffmpeg_pix_fmt(32, 3, false, false, false), None);
    }

    #[test]
    fn bytes_per_pixel_matches_every_format_the_mapper_can_return() {
        for fmt in ["argb", "rgba", "bgra", "abgr"] {
            assert_eq!(pix_fmt_bytes_per_pixel(fmt), 4, "{fmt}");
        }
        assert_eq!(pix_fmt_bytes_per_pixel("rgb24"), 3);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "chroma-debug-capture-test-{tag}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn generated_paths_are_png_files_named_after_the_window() {
        let path = generated_path("main");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("file name");
        assert!(name.starts_with("main-"), "unexpected name {name}");
    }

    #[test]
    fn write_png_creates_missing_parent_directories() {
        let root = temp_dir("write");
        let path = root.join("nested/deeper/shot.png");
        write_png(&path, b"not really a png, just bytes").expect("write");
        assert_eq!(
            std::fs::read(&path).expect("read back"),
            b"not really a png, just bytes"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sample_png_pixel_reads_the_exact_colour_at_a_coordinate() {
        let dir = temp_dir("sample");
        let path = dir.join("swatch.png");
        let mut img = image::RgbaImage::new(4, 3);
        img.put_pixel(2, 1, image::Rgba([18, 52, 86, 255]));
        img.save(&path).expect("save fixture");

        let sample = sample_png_pixel(path.to_str().expect("utf8 path"), 2, 1).expect("sample");
        assert_eq!((sample.r, sample.g, sample.b, sample.a), (18, 52, 86, 255));
        assert_eq!(sample.hex, "#123456");
        assert_eq!((sample.image_width, sample.image_height), (4, 3));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sample_png_pixel_refuses_a_coordinate_outside_the_image() {
        let dir = temp_dir("bounds");
        let path = dir.join("small.png");
        image::RgbaImage::new(2, 2)
            .save(&path)
            .expect("save fixture");

        let err = sample_png_pixel(path.to_str().expect("utf8 path"), 5, 0)
            .expect_err("out of bounds must be an error");
        assert!(err.contains("outside"), "unexpected error: {err}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
