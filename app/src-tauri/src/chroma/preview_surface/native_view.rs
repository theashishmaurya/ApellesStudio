//! The preview's native view (D-451, D-454): a layer-hosting `NSView` whose
//! layer is a `CAMetalLayer`, inserted into the window directly BELOW the
//! `WKWebView` (both are subviews of wry's `WryWebViewParent`, the window's
//! content view). The window and the webview are already transparent
//! (`tauri.conf.json` `transparent`, wry's `drawsBackground = NO`), so wherever
//! the DOM paints nothing the layer shows through and everything the DOM does
//! paint — the React overlays — sits on top of it.
//!
//! Every function here runs on the main thread (AppKit's rule for views); the
//! callers reach it through Tauri's `with_webview`, which dispatches there and
//! hands over the `WKWebView`. The view and its layer are kept in a
//! main-thread-only `thread_local`, so no AppKit object ever crosses a thread.
//!
//! It does NOT draw: wgpu presents into the layer from whichever thread calls
//! `Presenter::present` (a `CAMetalLayer` allows that), or from inside
//! [`place`]'s transaction on the main thread while paused.

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_core_graphics::CGColorSpace;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_quartz_core::{CAMetalLayer, CATransaction};
use objc2_web_kit::WKWebView;
use serde::{Deserialize, Serialize};

struct Installed {
    view: Retained<NSView>,
    layer: Retained<CAMetalLayer>,
}

thread_local! {
    static VIEW: RefCell<Option<Installed>> = const { RefCell::new(None) };
}

/// A rectangle in the webview's CSS pixels (= AppKit points at page zoom 1),
/// origin top left, as `getBoundingClientRect` reports it.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub(crate) struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Create the view and its layer under `webview`, hidden until placed.
/// Returns the layer, which the caller turns into a wgpu surface; the view
/// keeps its own reference until [`remove`].
///
/// **The layer is tagged ITU-R BT.709 (owner, 2026-11-04; D-454)**,
/// `kCGColorSpaceITUR_709`: the engine's frames are the timeline's Rec.709
/// R'G'B', the space the export is encoded and tagged in, so the viewer shows
/// what a ColorSync-managed player (QuickTime Player) shows for the exported
/// file. The window server converts the layer from BT.709 — its primaries and
/// white point, decoded with the inverse of the BT.709 camera OETF — to the
/// display's own profile. On a Display P3 panel (every Apple-silicon MacBook)
/// that is a gamut mapping INTO P3, which contains all of BT.709: nothing
/// clips, and saturated colours are not stretched out to P3. The decoding
/// curve renders shadows somewhat lighter than an sRGB tag on the same bytes
/// would (the long-known "QuickTime gamma" difference); the old `<img>`
/// preview was untagged, i.e. sRGB, and showed them darker.
/// `docs/notes/preview-gpu-surface.md` §6.
pub(crate) fn install(webview: &WKWebView) -> Result<Retained<CAMetalLayer>, String> {
    let mtm = MainThreadMarker::new().ok_or("native_view::install off the main thread")?;
    remove();
    // SAFETY: a plain AppKit getter on the main thread; the returned view is
    // retained, so it stays valid for as long as we hold it.
    let parent = unsafe { webview.superview() }
        .ok_or("the webview has no superview to place the preview under")?;

    let layer = CAMetalLayer::new();
    layer.setOpaque(true);
    // Implicit animations off for the layer's own geometry: a moved or resized
    // preview must land in one frame, not ease over 0.25 s.
    layer.setNeedsDisplayOnBoundsChange(false);
    // SAFETY: a CoreGraphics constant, valid for the life of the process.
    let name = unsafe { objc2_core_graphics::kCGColorSpaceITUR_709 };
    let space =
        CGColorSpace::with_name(Some(name)).ok_or("CoreGraphics has no BT.709 colour space")?;
    layer.setColorspace(Some(&space));

    let view = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1.0, 1.0)),
    );
    // Layer-hosting: our layer is the view's own (set before `wantsLayer`).
    view.setLayer(Some(&layer));
    view.setWantsLayer(true);
    view.setHidden(true);
    parent.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, Some(webview));
    VIEW.with(|v| {
        *v.borrow_mut() = Some(Installed {
            view,
            layer: layer.clone(),
        })
    });
    Ok(layer)
}

/// Move the view to `rect` (CSS pixels of the webview), or hide it, and run
/// `within` inside the same Core Animation transaction, after the move, with
/// the backing scale factor the drawable is sized by.
///
/// With `transactional`, the layer's `presentsWithTransaction` is on for the
/// duration of `within` only: a present made there (wgpu reads the flag at
/// acquire, then presents after `waitUntilScheduled`, on this thread) is
/// committed together with the move, so a live panel drag never shows the
/// picture a frame behind its hole (D-454). It is off again before the
/// commit, so the playback thread's presents are never tied to the main
/// thread's transactions (a transactional present off the main thread is not
/// paced by the display).
pub(crate) fn place<T>(
    webview: &WKWebView,
    rect: CssRect,
    visible: bool,
    transactional: bool,
    within: impl FnOnce(f64) -> T,
) -> Result<T, String> {
    MainThreadMarker::new().ok_or("native_view::place off the main thread")?;
    VIEW.with(|v| {
        let installed = v.borrow();
        let installed = installed
            .as_ref()
            .ok_or("the preview view is not installed")?;
        // SAFETY: as in `install`.
        let parent = unsafe { webview.superview() }.ok_or("the webview has no superview")?;
        let scale = webview
            .window()
            .map(|w| w.backingScaleFactor())
            .unwrap_or(1.0);
        let bounds = webview.bounds();
        // CSS y grows downward; convert to the webview's own coordinates
        // whichever way it is flipped, then let AppKit map it to the parent.
        let y = if webview.isFlipped() {
            rect.y
        } else {
            bounds.size.height - rect.y - rect.height
        };
        let in_webview = NSRect::new(
            NSPoint::new(rect.x, y),
            NSSize::new(rect.width, rect.height),
        );
        let frame = webview.convertRect_toView(in_webview, Some(&parent));
        CATransaction::begin();
        CATransaction::setDisableActions(true);
        installed.view.setFrame(frame);
        installed.layer.setContentsScale(scale);
        installed.view.setHidden(!visible);
        installed.layer.setPresentsWithTransaction(transactional);
        let out = within(scale);
        installed.layer.setPresentsWithTransaction(false);
        CATransaction::commit();
        Ok(out)
    })
}

/// Where the view really is: its frame in the webview's own CSS coordinates
/// (top-left origin, so it compares directly with the DOM rectangle it should
/// sit under), whether it is shown, whether it is ordered below the webview
/// in their common superview, and its layer's scale. `debug_screenshot` uses
/// it to put the picture where the window shows it.
#[cfg(debug_assertions)]
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewReport {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub hidden: bool,
    pub below_webview: bool,
    pub contents_scale: f64,
}

#[cfg(debug_assertions)]
pub(crate) fn describe(webview: &WKWebView) -> Result<ViewReport, String> {
    MainThreadMarker::new().ok_or("native_view::describe off the main thread")?;
    VIEW.with(|v| {
        let installed = v.borrow();
        let installed = installed
            .as_ref()
            .ok_or("the preview view is not installed")?;
        let view = &installed.view;
        let in_webview = view.convertRect_toView(view.bounds(), Some(webview));
        let bounds = webview.bounds();
        let y = if webview.isFlipped() {
            in_webview.origin.y
        } else {
            bounds.size.height - in_webview.origin.y - in_webview.size.height
        };
        // SAFETY: as in `install`.
        let parent = unsafe { webview.superview() }.ok_or("the webview has no superview")?;
        let subviews = parent.subviews();
        let webview_view: &NSView = webview;
        let index_of = |target: &NSView| subviews.iter().position(|s| std::ptr::eq(&*s, target));
        let below_webview = match (index_of(view), index_of(webview_view)) {
            (Some(a), Some(b)) => a < b,
            _ => false,
        };
        Ok(ViewReport {
            x: in_webview.origin.x,
            y,
            width: in_webview.size.width,
            height: in_webview.size.height,
            hidden: view.isHidden(),
            below_webview,
            contents_scale: installed.layer.contentsScale(),
        })
    })
}

/// Take the view out of the window (idempotent).
pub(crate) fn remove() {
    VIEW.with(|v| {
        if let Some(installed) = v.borrow_mut().take() {
            installed.view.removeFromSuperview();
        }
    });
}
