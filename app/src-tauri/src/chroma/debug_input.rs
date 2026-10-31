//! debug_input.rs — trusted native input into the app's own WKWebView (D-434).
//!
//! What it is: the native half of the UI harness's `debug_pointer` /
//!   `debug_key` (`@apelles/debug`'s `input/`). The frontend resolves targets
//!   and plans a gesture as a timed list of primitive events in CSS pixels;
//!   this module turns each one into a real `NSEvent` and delivers it to the
//!   window's `WKWebView` through the responder methods AppKit itself would
//!   call — `mouseDown:`, `mouseDragged:`, `mouseUp:`, `scrollWheel:`,
//!   `magnifyWithEvent:`, `keyDown:`, `keyUp:`, `flagsChanged:`.
//!
//! Why this shape (D-434 has the full comparison): it is the pattern WebKit's
//!   own test runner uses (`Tools/WebKitTestRunner/mac/EventSenderProxy.mm`
//!   builds `NSEvent`s and calls `[targetView mouseDown:event]` directly,
//!   wrapped in `[NSApp _setCurrentEvent:]`). Events delivered this way enter
//!   WebKit's normal input path, so the page receives `isTrusted` DOM events
//!   with real hit-testing, pointer capture, default actions and WebKit's own
//!   coalescing — the things an in-page synthetic event skips. And because
//!   nothing goes through the window server (`CGEventPost`), no Accessibility
//!   / PostEvent permission is needed, the owner's real cursor never moves,
//!   and the window does not have to be frontmost.
//!
//! Two pieces of process-global state, both scoped to an injection:
//!   - `+[NSEvent pressedMouseButtons]` is overridden while an injected button
//!     is held. WebKit fills DOM `buttons` from that class method (the real
//!     hardware state, `PlatformEventFactoryMac.mm`), so without this every
//!     injected drag would report `buttons: 0`. DumpRenderTree swizzles the
//!     same method for the same reason. It is restored as soon as a call ends
//!     with no button held.
//!   - WebKit's occlusion detection (`-[WKWebView
//!     _setWindowOcclusionDetectionEnabled:]`, the SPI WebKitTestRunner uses)
//!     can be switched off so a covered window keeps running
//!     `requestAnimationFrame` — the throttling that has blocked every
//!     measurement in `docs/notes/debug-tooling.md` (B-124, D-217, D-330).
//!     Explicit, through `debug_set_occlusion_throttling`; never implicit.
//!
//! What it does NOT do: resolve targets, plan gestures, or observe what the
//!   page received — all frontend (`@apelles/debug`). The wire format and the
//!   pure mapping rules (validation, coordinates, virtual keys, characters)
//!   are the `apelles-ui-input` crate, unit-tested there without the app.
//!   It also does not post
//!   OS-level events, so it cannot reach native menus, file dialogs or another
//!   app; it drives the webview only.
//!
//! **Debug-only.** The whole module is `#[cfg(debug_assertions)]` in
//!   `chroma/mod.rs`, and its command and native op are gated the same way
//!   (B-100 / D-219), so none of it exists in a release build.
//!
//! Private API, honestly labelled: `_setCurrentEvent:`, `_simulateMouseMove:`
//!   and `_setWindowOcclusionDetectionEnabled:` are WebKit/AppKit SPI, each
//!   called only after `respondsToSelector:`, and the pinch event is built from
//!   undocumented `CGEvent` gesture fields; the report says which path each
//!   delivery actually took so a mismatch is visible, not silent.

pub use apelles_ui_input::{InjectReport, LowEvent, Viewport};

#[cfg(target_os = "macos")]
pub use mac::{inject, set_occlusion_detection};

/// Non-macOS twin: there is no native input path here yet. The message is
/// matched by the frontend's `auto` mode (`isUnsupported`), which then falls
/// back to synthetic dispatch and SAYS so in its reply.
#[cfg(not(target_os = "macos"))]
pub fn inject<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _window_label: Option<&str>,
    _events: &[LowEvent],
    _viewport: Viewport,
) -> Result<InjectReport, String> {
    Err("native input is not supported on this platform (macOS only, D-434)".into())
}

#[cfg(not(target_os = "macos"))]
pub fn set_occlusion_detection<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    _window_label: Option<&str>,
    _enabled: bool,
) -> Result<apelles_ui_input::OcclusionReport, String> {
    Err("occlusion throttling control is not supported on this platform (macOS only, D-434)".into())
}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Mutex, mpsc};
    use std::time::Duration;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, Imp, NSObject, NSObjectProtocol, Sel};
    use objc2::{ClassType, msg_send, sel};
    use objc2_app_kit::{
        NSApplication, NSEvent, NSEventModifierFlags, NSEventType, NSResponder, NSScreen, NSView,
        NSWindow,
    };
    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventFlags, CGEventType, CGScrollEventUnit,
    };
    use objc2_foundation::{MainThreadMarker, NSPoint, NSProcessInfo, NSString};
    use objc2_web_kit::WKWebView;
    use tauri::Runtime;

    use crate::chroma::debug_capture::resolve_capturable_window;
    use apelles_ui_input::{
        InjectReport, KeyPhase, LowEvent, MagnifyPhase, MouseButton, MouseKind, OcclusionReport,
        Viewport, css_to_view, key_characters, modifier_bits, mouse_kind, validate, view_scale,
        virtual_key,
    };

    /// How long one event may take to be delivered on the main thread before
    /// the injection is abandoned (a wedged main thread is an answer).
    const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);

    /// `NSEventTypeGesture` and the private `CGEvent` gesture fields a pinch is
    /// built from (the values touch-simulation tools and WebKit's own pinch
    /// testing use; undocumented, so `magnify_built` reports whether AppKit
    /// really produced a Magnify event from them).
    const CG_EVENT_TYPE_GESTURE: u32 = 29;
    const CG_FIELD_GESTURE_HID_TYPE: u32 = 110;
    const CG_FIELD_GESTURE_ZOOM_VALUE: u32 = 113;
    const CG_FIELD_GESTURE_PHASE: u32 = 132;
    const IOHID_EVENT_TYPE_ZOOM: i64 = 8;
    const GESTURE_PHASE_BEGAN: i64 = 1;
    const GESTURE_PHASE_CHANGED: i64 = 2;
    const GESTURE_PHASE_ENDED: i64 = 4;

    /// The injected button state `+[NSEvent pressedMouseButtons]` reports
    /// while overridden. DOM `buttons` bits and AppKit's are the same
    /// (left 1, right 2, other 4).
    static PRESSED: AtomicUsize = AtomicUsize::new(0);
    /// The original implementation while the override is installed.
    static ORIGINAL_PRESSED_IMP: Mutex<Option<Imp>> = Mutex::new(None);

    extern "C-unwind" fn injected_pressed_mouse_buttons(_cls: &AnyClass, _sel: Sel) -> usize {
        PRESSED.load(Ordering::SeqCst)
    }

    fn pressed_method() -> Option<&'static objc2::runtime::Method> {
        NSEvent::class().class_method(sel!(pressedMouseButtons))
    }

    /// Install the override (idempotent). Returns whether it is in place.
    fn install_pressed_override() -> bool {
        let Ok(mut original) = ORIGINAL_PRESSED_IMP.lock() else {
            return false;
        };
        if original.is_some() {
            return true;
        }
        let Some(method) = pressed_method() else {
            return false;
        };
        // SAFETY: `injected_pressed_mouse_buttons` has the exact ABI of
        // `+[NSEvent pressedMouseButtons]` (receiver, selector → NSUInteger);
        // `Imp` is the runtime's type-erased function pointer, and the runtime
        // calls it back with that signature.
        let imp: Imp = unsafe {
            std::mem::transmute::<extern "C-unwind" fn(&AnyClass, Sel) -> usize, Imp>(
                injected_pressed_mouse_buttons,
            )
        };
        // SAFETY: replacing a class method's IMP with one of identical
        // signature; the previous IMP is kept and restored by
        // `restore_pressed_override`.
        *original = Some(unsafe { method.set_implementation(imp) });
        true
    }

    fn restore_pressed_override() {
        let Ok(mut original) = ORIGINAL_PRESSED_IMP.lock() else {
            return;
        };
        if let (Some(imp), Some(method)) = (original.take(), pressed_method()) {
            // SAFETY: putting back the implementation `install_pressed_override` saved.
            unsafe {
                method.set_implementation(imp);
            }
        }
    }

    fn responds(obj: &NSObject, sel: Sel) -> bool {
        obj.respondsToSelector(sel)
    }

    fn occlusion_enabled(webview: &WKWebView) -> Option<bool> {
        let sel = sel!(_windowOcclusionDetectionEnabled);
        if !responds(webview, sel) {
            return None;
        }
        // SAFETY: a BOOL-returning getter, checked with respondsToSelector: first.
        Some(unsafe { msg_send![webview, _windowOcclusionDetectionEnabled] })
    }

    /// Run `f` on the main thread with the window's WKWebView and wait for it.
    fn on_webview<R: Runtime, T: Send + 'static>(
        window: &tauri::WebviewWindow<R>,
        f: impl FnOnce(&WKWebView, MainThreadMarker) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel::<Result<T, String>>();
        window
            .with_webview(move |platform| {
                let raw = platform.inner();
                let result = match MainThreadMarker::new() {
                    _ if raw.is_null() => Err("the window has no WKWebView handle".to_string()),
                    None => Err("webview callback did not run on the main thread".to_string()),
                    Some(mtm) => {
                        // SAFETY: Tauri documents `PlatformWebview::inner()` on
                        // macOS as the window's live `WKWebView`, and this
                        // closure runs on the main thread (checked above).
                        let webview: &WKWebView = unsafe { &*raw.cast::<WKWebView>() };
                        f(webview, mtm)
                    }
                };
                let _ = tx.send(result);
            })
            .map_err(|e| format!("could not reach the window's webview: {e}"))?;
        rx.recv_timeout(DELIVERY_TIMEOUT).map_err(|_| {
            "the main thread did not deliver the event within 5s — the app may be busy or wedged"
                .to_string()
        })?
    }

    /// The state captured once per injection.
    #[derive(Clone, Copy)]
    struct Geometry {
        scale: f64,
        height: f64,
        flipped: bool,
    }

    pub fn inject<R: Runtime>(
        app: &tauri::AppHandle<R>,
        window_label: Option<&str>,
        events: &[LowEvent],
        viewport: Viewport,
    ) -> Result<InjectReport, String> {
        validate(events)?;
        let window = resolve_capturable_window(app, window_label)?;

        let (geometry, mut report) = on_webview(&window, move |webview, _mtm| {
            let bounds = webview.bounds();
            let scale = view_scale(bounds.size.width, viewport)?;
            let override_ok = install_pressed_override();
            let window_key = webview.window().is_some_and(|w| w.isKeyWindow());
            let report = InjectReport {
                pressed_buttons_override: override_ok,
                window_key,
                occlusion_detection: occlusion_enabled(webview),
                view_scale: scale,
                mouse_move_path: if responds(webview, sel!(_simulateMouseMove:)) {
                    "simulateMouseMove".into()
                } else {
                    "mouseMoved".into()
                },
                ..InjectReport::default()
            };
            Ok((
                Geometry {
                    scale,
                    height: bounds.size.height,
                    flipped: webview.isFlipped(),
                },
                report,
            ))
        })?;

        let mut outcome = Ok(());
        for (i, ev) in events.iter().enumerate() {
            let delay = ev.delay_ms();
            if delay > 0.0 {
                std::thread::sleep(Duration::from_secs_f64(delay / 1000.0));
            }
            let ev_owned = ev.clone();
            match on_webview(&window, move |webview, mtm| {
                deliver(webview, mtm, &ev_owned, geometry)
            }) {
                Ok(flags) => {
                    report.dispatched += 1;
                    if let Some(m) = flags.wheel_window_matched {
                        report.wheel_window_matched = Some(m);
                    }
                    if let Some(m) = flags.magnify_built {
                        report.magnify_built = Some(m);
                    }
                }
                Err(e) => {
                    outcome = Err(format!("event {i}: {e}"));
                    break;
                }
            }
        }

        // A gesture that ends with nothing held gives `pressedMouseButtons`
        // back to the hardware; one that leaves a button down (a `down` call
        // continued by a later `up` call) keeps the override until then.
        if outcome.is_err() || PRESSED.load(Ordering::SeqCst) == 0 {
            PRESSED.store(0, Ordering::SeqCst);
            let _ = on_webview(&window, |_, _| {
                restore_pressed_override();
                Ok(())
            });
        }
        outcome.map(|()| report)
    }

    #[derive(Default)]
    struct DeliveryFlags {
        wheel_window_matched: Option<bool>,
        magnify_built: Option<bool>,
    }

    fn timestamp() -> f64 {
        NSProcessInfo::processInfo().systemUptime()
    }

    /// Deliver one event the way AppKit would: as the application's current
    /// event, to the view's responder method.
    fn with_current_event(mtm: MainThreadMarker, event: &NSEvent, f: impl FnOnce()) {
        let app = NSApplication::sharedApplication(mtm);
        let can_set = responds(&app, sel!(_setCurrentEvent:));
        if can_set {
            // SAFETY: AppKit SPI taking an NSEvent (or nil), checked first.
            let _: () = unsafe { msg_send![&*app, _setCurrentEvent: event] };
        }
        f();
        if can_set {
            let none: Option<&NSEvent> = None;
            // SAFETY: as above, clearing it.
            let _: () = unsafe { msg_send![&*app, _setCurrentEvent: none] };
        }
    }

    /// Where key events go: the window's first responder when it is the
    /// webview or inside it (WebKit's own content view), else the webview.
    fn key_target(webview: &WKWebView, window: Option<&NSWindow>) -> Retained<NSResponder> {
        let view: &NSView = webview;
        if let Some(responder) = window.and_then(|w| w.firstResponder())
            && let Ok(responder_view) = responder.clone().downcast::<NSView>()
            && responder_view.isDescendantOf(view)
        {
            return responder;
        }
        let view: Retained<NSView> = Retained::from(view);
        Retained::into_super(view)
    }

    fn deliver(
        webview: &WKWebView,
        mtm: MainThreadMarker,
        ev: &LowEvent,
        g: Geometry,
    ) -> Result<DeliveryFlags, String> {
        let window = webview.window();
        let window_number = window.as_ref().map_or(0, |w| w.windowNumber());
        let to_window = |x: f64, y: f64| -> NSPoint {
            let (vx, vy) = css_to_view(x, y, g.scale, g.height, g.flipped);
            webview.convertPoint_toView(NSPoint::new(vx, vy), None)
        };
        let mut flags = DeliveryFlags::default();

        match ev {
            LowEvent::Mouse {
                phase,
                x,
                y,
                button,
                buttons,
                click_count,
                modifiers,
                ..
            } => {
                let kind = mouse_kind(*phase, *button, *buttons);
                let ty = match kind {
                    MouseKind::Moved => NSEventType::MouseMoved,
                    MouseKind::Down(MouseButton::Left) => NSEventType::LeftMouseDown,
                    MouseKind::Down(MouseButton::Right) => NSEventType::RightMouseDown,
                    MouseKind::Down(MouseButton::Middle) => NSEventType::OtherMouseDown,
                    MouseKind::Up(MouseButton::Left) => NSEventType::LeftMouseUp,
                    MouseKind::Up(MouseButton::Right) => NSEventType::RightMouseUp,
                    MouseKind::Up(MouseButton::Middle) => NSEventType::OtherMouseUp,
                    MouseKind::Dragged(MouseButton::Left) => NSEventType::LeftMouseDragged,
                    MouseKind::Dragged(MouseButton::Right) => NSEventType::RightMouseDragged,
                    MouseKind::Dragged(MouseButton::Middle) => NSEventType::OtherMouseDragged,
                };
                let pressure = match kind {
                    MouseKind::Down(_) | MouseKind::Dragged(_) => 1.0,
                    MouseKind::Up(_) | MouseKind::Moved => 0.0,
                };
                // What the hardware would report DURING this event: after a
                // press it includes the button, after a release it does not.
                PRESSED.store(*buttons as usize, Ordering::SeqCst);
                let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
                    ty,
                    to_window(*x, *y),
                    NSEventModifierFlags::from_bits_retain(modifier_bits(*modifiers) as usize),
                    timestamp(),
                    window_number,
                    None,
                    0,
                    (*click_count).max(0) as isize,
                    pressure,
                )
                .ok_or("AppKit refused to build the mouse event")?;
                with_current_event(mtm, &event, || match kind {
                    MouseKind::Down(MouseButton::Left) => webview.mouseDown(&event),
                    MouseKind::Down(MouseButton::Right) => webview.rightMouseDown(&event),
                    MouseKind::Down(MouseButton::Middle) => webview.otherMouseDown(&event),
                    MouseKind::Up(MouseButton::Left) => webview.mouseUp(&event),
                    MouseKind::Up(MouseButton::Right) => webview.rightMouseUp(&event),
                    MouseKind::Up(MouseButton::Middle) => webview.otherMouseUp(&event),
                    MouseKind::Dragged(MouseButton::Left) => webview.mouseDragged(&event),
                    MouseKind::Dragged(MouseButton::Right) => webview.rightMouseDragged(&event),
                    MouseKind::Dragged(MouseButton::Middle) => webview.otherMouseDragged(&event),
                    MouseKind::Moved => {
                        if responds(webview, sel!(_simulateMouseMove:)) {
                            // SAFETY: WebKit testing SPI taking an NSEvent,
                            // checked with respondsToSelector: first.
                            let _: () = unsafe { msg_send![webview, _simulateMouseMove: &*event] };
                        } else {
                            webview.mouseMoved(&event);
                        }
                    }
                });
            }
            LowEvent::Wheel {
                x,
                y,
                delta_x,
                delta_y,
                modifiers,
                ..
            } => {
                let screen_point = global_point(mtm, window.as_deref(), to_window(*x, *y));
                // CG's wheel axis is the opposite sign of DOM `deltaY`.
                let cg = CGEvent::new_scroll_wheel_event2(
                    None,
                    CGScrollEventUnit::Pixel,
                    2,
                    (-delta_y).round() as i32,
                    (-delta_x).round() as i32,
                    0,
                )
                .ok_or("CoreGraphics refused to build the scroll event")?;
                CGEvent::set_location(Some(&cg), screen_point);
                CGEvent::set_flags(Some(&cg), CGEventFlags(modifier_bits(*modifiers)));
                CGEvent::set_integer_value_field(
                    Some(&cg),
                    CGEventField::MouseEventWindowUnderMousePointer,
                    window_number as i64,
                );
                CGEvent::set_integer_value_field(
                    Some(&cg),
                    CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent,
                    window_number as i64,
                );
                let event =
                    NSEvent::eventWithCGEvent(&cg).ok_or("AppKit refused the scroll event")?;
                flags.wheel_window_matched = Some(event.windowNumber() == window_number);
                with_current_event(mtm, &event, || webview.scrollWheel(&event));
            }
            LowEvent::Magnify {
                x,
                y,
                magnification,
                phase,
                modifiers,
                ..
            } => {
                let cg = CGEvent::new(None).ok_or("CoreGraphics refused to build an event")?;
                CGEvent::set_type(Some(&cg), CGEventType(CG_EVENT_TYPE_GESTURE));
                CGEvent::set_location(
                    Some(&cg),
                    global_point(mtm, window.as_deref(), to_window(*x, *y)),
                );
                CGEvent::set_flags(Some(&cg), CGEventFlags(modifier_bits(*modifiers)));
                CGEvent::set_integer_value_field(
                    Some(&cg),
                    CGEventField(CG_FIELD_GESTURE_HID_TYPE),
                    IOHID_EVENT_TYPE_ZOOM,
                );
                CGEvent::set_double_value_field(
                    Some(&cg),
                    CGEventField(CG_FIELD_GESTURE_ZOOM_VALUE),
                    *magnification,
                );
                let gesture_phase = match phase {
                    MagnifyPhase::Begin => GESTURE_PHASE_BEGAN,
                    MagnifyPhase::Change => GESTURE_PHASE_CHANGED,
                    MagnifyPhase::End => GESTURE_PHASE_ENDED,
                };
                CGEvent::set_integer_value_field(
                    Some(&cg),
                    CGEventField(CG_FIELD_GESTURE_PHASE),
                    gesture_phase,
                );
                let event =
                    NSEvent::eventWithCGEvent(&cg).ok_or("AppKit refused the gesture event")?;
                let built = event.r#type() == NSEventType::Magnify;
                flags.magnify_built = Some(built);
                if !built {
                    return Err(format!(
                        "the pinch event came out as NSEventType {} rather than Magnify — this macOS \
                         does not build gestures from these CGEvent fields; use a ctrl+wheel instead",
                        event.r#type().0
                    ));
                }
                with_current_event(mtm, &event, || webview.magnifyWithEvent(&event));
            }
            LowEvent::Key {
                phase,
                code,
                key,
                modifiers,
                ..
            } => {
                let key_code =
                    virtual_key(code).ok_or_else(|| format!("no virtual key for {code:?}"))?;
                let (chars, unmodified) = key_characters(code, key);
                let ty = match phase {
                    KeyPhase::Down => NSEventType::KeyDown,
                    KeyPhase::Up => NSEventType::KeyUp,
                };
                let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                    ty,
                    NSPoint::new(0.0, 0.0),
                    NSEventModifierFlags::from_bits_retain(modifier_bits(*modifiers) as usize),
                    timestamp(),
                    window_number,
                    None,
                    &NSString::from_str(&chars),
                    &NSString::from_str(&unmodified),
                    false,
                    key_code,
                )
                .ok_or("AppKit refused to build the key event")?;
                let target = key_target(webview, window.as_deref());
                with_current_event(mtm, &event, || match phase {
                    KeyPhase::Down => target.keyDown(&event),
                    KeyPhase::Up => target.keyUp(&event),
                });
            }
            LowEvent::Modifier {
                code, modifiers, ..
            } => {
                let key_code =
                    virtual_key(code).ok_or_else(|| format!("no virtual key for {code:?}"))?;
                let empty = NSString::from_str("");
                let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                    NSEventType::FlagsChanged,
                    NSPoint::new(0.0, 0.0),
                    NSEventModifierFlags::from_bits_retain(modifier_bits(*modifiers) as usize),
                    timestamp(),
                    window_number,
                    None,
                    &empty,
                    &empty,
                    false,
                    key_code,
                )
                .ok_or("AppKit refused to build the modifier event")?;
                let target = key_target(webview, window.as_deref());
                with_current_event(mtm, &event, || target.flagsChanged(&event));
            }
        }
        Ok(flags)
    }

    /// A window point → CoreGraphics global coordinates (origin top-left of the
    /// primary display), which is what a `CGEvent` location is in.
    fn global_point(mtm: MainThreadMarker, window: Option<&NSWindow>, p: NSPoint) -> NSPoint {
        let Some(window) = window else {
            return p;
        };
        let screen = window.convertPointToScreen(p);
        let primary_height = NSScreen::screens(mtm)
            .firstObject()
            .map_or(0.0, |s| s.frame().size.height);
        NSPoint::new(screen.x, primary_height - screen.y)
    }

    pub fn set_occlusion_detection<R: Runtime>(
        app: &tauri::AppHandle<R>,
        window_label: Option<&str>,
        enabled: bool,
    ) -> Result<OcclusionReport, String> {
        let window = resolve_capturable_window(app, window_label)?;
        let label = window.label().to_string();
        on_webview(&window, move |webview, _| {
            let before = occlusion_enabled(webview).ok_or(
                "this WebKit has no _setWindowOcclusionDetectionEnabled: — occlusion throttling cannot be changed",
            )?;
            // SAFETY: a BOOL setter, present (the getter above answered).
            let _: () = unsafe { msg_send![webview, _setWindowOcclusionDetectionEnabled: enabled] };
            let after = occlusion_enabled(webview).unwrap_or(before);
            Ok(OcclusionReport {
                before,
                after,
                window: label,
            })
        })
    }
}

// --------------------------------------------------------------------------
// Tauri command.
// --------------------------------------------------------------------------

/// Deliver a planned gesture to the window's webview as real `NSEvent`s.
/// Called by `@apelles/debug`'s `dispatchNative`; blocks a worker thread for
/// the gesture's own duration (its delays), never the main thread.
#[tauri::command]
pub async fn chroma_debug_inject_input(
    app: tauri::AppHandle,
    events: Vec<LowEvent>,
    viewport: Viewport,
    window_label: Option<String>,
) -> Result<InjectReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        inject(&app, window_label.as_deref(), &events, viewport)
    })
    .await
    .map_err(|e| format!("input injection task panicked: {e}"))?
}
