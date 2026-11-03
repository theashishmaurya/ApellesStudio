//! The preview's native view (D-451): a layer-hosting `NSView` whose layer is
//! a `CAMetalLayer`, inserted into the window directly BELOW the `WKWebView`
//! (both are subviews of wry's `WryWebViewParent`, the window's content view).
//! The window and the webview are already transparent (`tauri.conf.json`
//! `transparent`, wry's `drawsBackground = NO`), so wherever the DOM paints
//! nothing the layer shows through and everything the DOM does paint — the
//! React overlays — sits on top of it.
//!
//! Every function here runs on the main thread (AppKit's rule for views); the
//! callers reach it through Tauri's `with_webview`, which dispatches there and
//! hands over the `WKWebView`. The view is kept in a main-thread-only
//! `thread_local`, so no AppKit object ever crosses a thread.
//!
//! It does NOT draw: wgpu presents into the layer from whichever thread calls
//! `Presenter::present` (a `CAMetalLayer` allows that).

use std::cell::RefCell;

use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSView, NSWindowOrderingMode};
use objc2_core_graphics::CGColorSpace;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_quartz_core::{CAMetalLayer, CATransaction};
use objc2_web_kit::WKWebView;
use serde::{Deserialize, Serialize};

thread_local! {
    static VIEW: RefCell<Option<Retained<NSView>>> = const { RefCell::new(None) };
}

/// How the layer's bytes are tagged for the window server's colour matching.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ColorTag {
    /// IEC 61966-2-1. What WebKit assumes for the untagged JPEG the `<img>`
    /// preview shows today, so the switch is invisible (the default).
    Srgb,
    /// ITU-R BT.709 primaries and transfer, `kCGColorSpaceITUR_709` — the
    /// timeline's own space. ColorSync decodes it with the 709 OETF's inverse,
    /// which lifts shadows against sRGB (the long-known "QuickTime gamma"
    /// difference), so it is a product decision, not a default.
    Rec709,
    /// Display P3, for a frame already converted to it.
    P3,
}

/// A rectangle in the webview's CSS pixels (= AppKit points at page zoom 1),
/// origin top left, as `getBoundingClientRect` reports it.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub(crate) struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Create the view and its layer under `webview`, hidden until placed.
/// Returns the layer, which the caller turns into a wgpu surface; the view
/// keeps its own reference until [`remove`].
pub(crate) fn install(
    webview: &WKWebView,
    tag: ColorTag,
) -> Result<Retained<CAMetalLayer>, String> {
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
    let name = match tag {
        ColorTag::Srgb => unsafe { objc2_core_graphics::kCGColorSpaceSRGB },
        ColorTag::Rec709 => unsafe { objc2_core_graphics::kCGColorSpaceITUR_709 },
        ColorTag::P3 => unsafe { objc2_core_graphics::kCGColorSpaceDisplayP3 },
    };
    let space =
        CGColorSpace::with_name(Some(name)).ok_or("CoreGraphics has no such colour space")?;
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
    VIEW.with(|v| *v.borrow_mut() = Some(view));
    Ok(layer)
}

/// Move the view to `rect` (CSS pixels of the webview), or hide it. Returns
/// the backing scale factor the drawable must be sized by.
pub(crate) fn place(webview: &WKWebView, rect: CssRect, visible: bool) -> Result<f64, String> {
    MainThreadMarker::new().ok_or("native_view::place off the main thread")?;
    VIEW.with(|v| {
        let view = v.borrow();
        let view = view.as_ref().ok_or("the preview view is not installed")?;
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
        view.setFrame(frame);
        if let Some(layer) = view.layer() {
            layer.setContentsScale(scale);
        }
        view.setHidden(!visible);
        CATransaction::commit();
        Ok(scale)
    })
}

/// Where the view really is, for the stats: its frame in the webview's own
/// CSS coordinates (top-left origin, so it compares directly with the DOM
/// rectangle it should sit under), whether it is shown, whether it is ordered
/// below the webview in their common superview, and its layer's scale.
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

pub(crate) fn describe(webview: &WKWebView) -> Result<ViewReport, String> {
    MainThreadMarker::new().ok_or("native_view::describe off the main thread")?;
    VIEW.with(|v| {
        let view = v.borrow();
        let view = view.as_ref().ok_or("the preview view is not installed")?;
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
            contents_scale: view.layer().map(|l| l.contentsScale()).unwrap_or(0.0),
        })
    })
}

/// Take the view out of the window (idempotent).
pub(crate) fn remove() {
    VIEW.with(|v| {
        if let Some(view) = v.borrow_mut().take() {
            view.removeFromSuperview();
        }
    });
}
