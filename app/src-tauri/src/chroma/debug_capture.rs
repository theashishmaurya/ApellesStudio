//! debug_capture.rs — in-process WKWebView screenshot + PNG pixel probe (D-210).
//!
//! What it is: the ONE way an agent (or a human filing a bug) gets a real,
//!   pixel-accurate picture of what this app's window is actually showing,
//!   from inside the app's own process. It asks the WKWebView that renders
//!   Chroma's whole UI to snapshot ITSELF
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
//!   screenshots, annotate one, or know anything about Chroma's UI: it hands
//!   back a PNG path and the caller looks at it.
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
    let window = resolve_window(app, window_label)?;
    let label = window.label().to_string();

    // An honest error beats a black rectangle: a minimised or hidden window
    // has no rendered web content to snapshot.
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

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let frame = capture_webview_png(&window)?;

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
    use block2::RcBlock;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::WKWebView;

    let (tx, rx) = mpsc::channel::<Result<CapturedFrame, String>>();

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
                    png_from_ns_image(unsafe { &*image })
                } else if !error.is_null() {
                    // SAFETY: as above, for the error branch.
                    let description = unsafe { &*error }.localizedDescription();
                    Err(format!("WKWebView takeSnapshot failed: {description}"))
                } else {
                    Err("WKWebView takeSnapshot returned neither an image nor an error".to_string())
                };
                let _ = tx.send(result);
            });

            // SAFETY: a plain AppKit call on the main thread; a `nil`
            // configuration means "the whole visible viewport at its native
            // backing scale", which is exactly what we want. WebKit copies
            // the completion block, so dropping our `RcBlock` afterwards is
            // correct.
            unsafe {
                webview.takeSnapshotWithConfiguration_completionHandler(None, &handler);
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
