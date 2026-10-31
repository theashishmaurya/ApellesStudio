//! apelles-ui-input — the platform-independent half of the UI harness's
//! native input (D-434).
//!
//! What it is: the wire format the frontend's gesture planner
//!   (`@apelles/debug`'s `input/plan.ts`) sends for real input — [`LowEvent`]
//!   — plus everything about turning it into an OS event that has a correct
//!   answer and therefore a unit test: plan validation, CSS-pixel → view-point
//!   mapping, AppKit modifier bits, DOM `code` → macOS virtual key, the
//!   characters a key event carries, and which AppKit mouse event a primitive
//!   is.
//!
//! What it does NOT do: deliver anything. The macOS delivery (building
//!   `NSEvent`s and calling the `WKWebView`'s responder methods) and the Tauri
//!   command live in the app, `app/src-tauri/src/chroma/debug_input.rs`,
//!   because they need the window. This crate has no platform code and no
//!   dependency beyond `serde`, so its tests run in seconds without building
//!   the app.
//!
//! Debug tooling only: the app reaches this crate solely from its
//!   `#[cfg(debug_assertions)]` `debug_input` module, so a release build calls
//!   nothing in it (B-100 / D-219's gate). See `README.md`.

use serde::{Deserialize, Serialize};

/// Most events one call may carry — the frontend's `MAX_PLAN_EVENTS`, enforced
/// again here because this is the side that holds the main thread.
pub const MAX_EVENTS: usize = 2000;
/// Longest wait allowed before any one event.
pub const MAX_DELAY_MS: f64 = 10_000.0;
/// Longest a whole injection may take, end to end.
pub const MAX_TOTAL_MS: f64 = 60_000.0;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct Modifiers {
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub meta: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MousePhase {
    Move,
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyPhase {
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MagnifyPhase {
    Begin,
    Change,
    End,
}

/// One primitive event — the frontend's `LowEvent` (`input/types.ts`), field
/// for field.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LowEvent {
    Mouse {
        phase: MousePhase,
        x: f64,
        y: f64,
        button: MouseButton,
        buttons: u32,
        click_count: i64,
        modifiers: Modifiers,
        delay_ms: f64,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        modifiers: Modifiers,
        delay_ms: f64,
    },
    Magnify {
        x: f64,
        y: f64,
        magnification: f64,
        phase: MagnifyPhase,
        modifiers: Modifiers,
        delay_ms: f64,
    },
    Key {
        phase: KeyPhase,
        code: String,
        key: String,
        modifiers: Modifiers,
        delay_ms: f64,
    },
    /// A modifier key going down or up. The frontend also sends `phase` and
    /// `key`; AppKit's `flagsChanged:` carries neither (the new state is in
    /// `modifiers`), so they are not read here.
    Modifier {
        code: String,
        modifiers: Modifiers,
        delay_ms: f64,
    },
}

impl LowEvent {
    /// How long to wait before dispatching this event, in ms.
    pub fn delay_ms(&self) -> f64 {
        match self {
            LowEvent::Mouse { delay_ms, .. }
            | LowEvent::Wheel { delay_ms, .. }
            | LowEvent::Magnify { delay_ms, .. }
            | LowEvent::Key { delay_ms, .. }
            | LowEvent::Modifier { delay_ms, .. } => *delay_ms,
        }
    }

    /// The event's CSS-pixel position, for the kinds that have one.
    pub fn point(&self) -> Option<(f64, f64)> {
        match self {
            LowEvent::Mouse { x, y, .. }
            | LowEvent::Wheel { x, y, .. }
            | LowEvent::Magnify { x, y, .. } => Some((*x, *y)),
            LowEvent::Key { .. } | LowEvent::Modifier { .. } => None,
        }
    }
}

/// The page's CSS viewport, as `window.innerWidth/innerHeight` reported it.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
}

/// What one injection did — mirrored by the frontend's `NativeReport`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InjectReport {
    pub dispatched: usize,
    /// `simulateMouseMove` (WebKit's testing SPI) or `mouseMoved`.
    pub mouse_move_path: String,
    /// Whether `+[NSEvent pressedMouseButtons]` was actually reporting an
    /// injected button during this call (H10): true only when a button was
    /// held when the call began or an event in it holds one. The override is
    /// installed on every call, but on a plain move, key or wheel it reports
    /// nothing held, and saying `true` there described the install, not a use.
    pub pressed_buttons_override: bool,
    pub window_key: bool,
    /// `_windowOcclusionDetectionEnabled`; `None` when the SPI is absent.
    pub occlusion_detection: Option<bool>,
    /// Webview points per CSS pixel used to map coordinates.
    pub view_scale: f64,
    /// For wheel events: whether the `NSEvent` built from the `CGEvent` was
    /// associated with this window (if not, WebKit reads its location as
    /// screen coordinates and the wheel lands elsewhere).
    pub wheel_window_matched: Option<bool>,
    /// For wheel events built without a window (H8): whether the CGEvent
    /// location was rewritten into window space so WebKit's conversion lands
    /// on the aimed point instead of reading it as screen coordinates.
    pub wheel_location_corrected: Option<bool>,
    /// For a buttonless move delivered to a window that was not key (H5):
    /// whether the window was made key first, because WebKit drops a plain
    /// mouse move for an inactive window. `None` when no such move was sent.
    pub made_key_for_move: Option<bool>,
    /// For pinch events: whether the built event really is `NSEventTypeMagnify`.
    pub magnify_built: Option<bool>,
}

/// Whether `+[NSEvent pressedMouseButtons]` is reporting a held button for
/// this call (H10): a button was already down when it began (`held_at_start`,
/// the continuing half of a `down` / `up` pair), or any mouse event in it
/// leaves one down.
pub fn override_in_effect(events: &[LowEvent], held_at_start: bool) -> bool {
    held_at_start
        || events
            .iter()
            .any(|e| matches!(e, LowEvent::Mouse { buttons, .. } if *buttons != 0))
}

/// Whether a mouse event is a buttonless move into a window that is not key
/// (H5). WebKit ignores those, while a drag (a button held) is delivered either
/// way, so only this case makes the window key first.
pub fn move_needs_key_window(phase: MousePhase, buttons_after: u32, window_key: bool) -> bool {
    matches!(phase, MousePhase::Move) && buttons_after == 0 && !window_key
}

/// The CGEvent location (global, origin top-left of the primary display) that
/// makes an `NSEvent` built WITHOUT a window report `locationInWindow ==
/// window_point` (H8). With no window, AppKit reports the screen position
/// (origin bottom-left) as `locationInWindow`, and WebKit then converts that as
/// if it were window space; handing it the window-space point directly, in the
/// flipped global convention, makes the conversion a no-op that lands right.
pub fn windowless_event_location(
    window_point: (f64, f64),
    primary_screen_height: f64,
) -> (f64, f64) {
    (window_point.0, primary_screen_height - window_point.1)
}

/// Refuse a plan this module should not play: too many events, a non-finite
/// coordinate, a negative or huge delay, or too long overall. Every refusal
/// names the event.
pub fn validate(events: &[LowEvent]) -> Result<(), String> {
    if events.is_empty() {
        return Err("no events to inject".into());
    }
    if events.len() > MAX_EVENTS {
        return Err(format!(
            "{} events is over the {MAX_EVENTS}-event limit",
            events.len()
        ));
    }
    let mut total = 0.0;
    for (i, ev) in events.iter().enumerate() {
        let d = ev.delay_ms();
        if !d.is_finite() || !(0.0..=MAX_DELAY_MS).contains(&d) {
            return Err(format!(
                "event {i}: delayMs {d} is outside 0..={MAX_DELAY_MS}"
            ));
        }
        total += d;
        if let Some((x, y)) = ev.point()
            && (!x.is_finite() || !y.is_finite())
        {
            return Err(format!("event {i}: coordinates must be finite"));
        }
        if let LowEvent::Key { code, .. } | LowEvent::Modifier { code, .. } = ev
            && virtual_key(code).is_none()
        {
            return Err(format!("event {i}: no macOS virtual key for code {code:?}"));
        }
    }
    if total > MAX_TOTAL_MS {
        return Err(format!(
            "the plan waits {total} ms in total — over the {MAX_TOTAL_MS} ms limit"
        ));
    }
    Ok(())
}

/// CSS pixels (viewport space, origin top-left) → the webview's own view
/// coordinates. `scale` is points per CSS px; an unflipped view counts y from
/// the bottom.
pub fn css_to_view(x: f64, y: f64, scale: f64, view_height: f64, flipped: bool) -> (f64, f64) {
    let vx = x * scale;
    let vy = y * scale;
    (vx, if flipped { vy } else { view_height - vy })
}

/// Points per CSS pixel: the webview's width over the page's CSS width. `1.0`
/// for an unzoomed page; refuses a degenerate viewport rather than dividing
/// by zero.
pub fn view_scale(view_width: f64, viewport: Viewport) -> Result<f64, String> {
    // `is_finite && > 0` rather than `!(x > 0)`, so a NaN is refused too.
    let positive = |v: f64| v.is_finite() && v > 0.0;
    if !positive(viewport.width) || !positive(viewport.height) || !positive(view_width) {
        return Err(format!(
            "cannot map coordinates: webview width {view_width}, page viewport {}×{}",
            viewport.width, viewport.height
        ));
    }
    Ok(view_width / viewport.width)
}

/// `NSEventModifierFlags` bits for a modifier set (Shift 1<<17, Control 1<<18,
/// Option 1<<19, Command 1<<20 — AppKit's and `CGEventFlags`' shared values).
pub fn modifier_bits(m: Modifiers) -> u64 {
    let mut bits = 0u64;
    if m.shift {
        bits |= 1 << 17;
    }
    if m.ctrl {
        bits |= 1 << 18;
    }
    if m.alt {
        bits |= 1 << 19;
    }
    if m.meta {
        bits |= 1 << 20;
    }
    bits
}

/// Which AppKit event a mouse primitive is. A move with a button held is that
/// button's DRAG event — what a real hand produces and what WebKit routes to
/// its drag handling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseKind {
    Moved,
    Down(MouseButton),
    Up(MouseButton),
    Dragged(MouseButton),
}

pub fn mouse_kind(phase: MousePhase, button: MouseButton, buttons_after: u32) -> MouseKind {
    match phase {
        MousePhase::Down => MouseKind::Down(button),
        MousePhase::Up => MouseKind::Up(button),
        MousePhase::Move if buttons_after & 1 != 0 => MouseKind::Dragged(MouseButton::Left),
        MousePhase::Move if buttons_after & 2 != 0 => MouseKind::Dragged(MouseButton::Right),
        MousePhase::Move if buttons_after & 4 != 0 => MouseKind::Dragged(MouseButton::Middle),
        MousePhase::Move => MouseKind::Moved,
    }
}

/// DOM `KeyboardEvent.code` → macOS virtual key code (`kVK_*`, Carbon
/// `Events.h`). WebKit derives `code` back from this number, so it is the
/// field that must be exact.
pub fn virtual_key(code: &str) -> Option<u16> {
    let letter = |c: u8| -> Option<u16> {
        // kVK_ANSI_A..Z are not alphabetical; this is Events.h's own order.
        const TABLE: [u16; 26] = [
            0x00, 0x0B, 0x08, 0x02, 0x0E, 0x03, 0x05, 0x04, 0x22, 0x26, 0x28, 0x25, 0x2E, 0x2D,
            0x1F, 0x23, 0x0C, 0x0F, 0x01, 0x11, 0x20, 0x09, 0x0D, 0x07, 0x10, 0x06,
        ];
        TABLE.get(usize::from(c.checked_sub(b'A')?)).copied()
    };
    if let Some(rest) = code.strip_prefix("Key") {
        let bytes = rest.as_bytes();
        return if bytes.len() == 1 {
            letter(bytes[0])
        } else {
            None
        };
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        const DIGITS: [u16; 10] = [0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19];
        let d: usize = rest.parse().ok()?;
        return DIGITS.get(d).copied();
    }
    if let Some(rest) = code.strip_prefix('F') {
        const FKEYS: [u16; 12] = [
            0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F,
        ];
        if let Ok(n) = rest.parse::<usize>() {
            return n.checked_sub(1).and_then(|i| FKEYS.get(i)).copied();
        }
    }
    Some(match code {
        "Space" => 0x31,
        "Enter" => 0x24,
        "Escape" => 0x35,
        "Backspace" => 0x33,
        "Delete" => 0x75,
        "Tab" => 0x30,
        "ArrowLeft" => 0x7B,
        "ArrowRight" => 0x7C,
        "ArrowDown" => 0x7D,
        "ArrowUp" => 0x7E,
        "Home" => 0x73,
        "End" => 0x77,
        "PageUp" => 0x74,
        "PageDown" => 0x79,
        "Minus" => 0x1B,
        "Equal" => 0x18,
        "BracketLeft" => 0x21,
        "BracketRight" => 0x1E,
        "Backslash" => 0x2A,
        "Semicolon" => 0x29,
        "Quote" => 0x27,
        "Comma" => 0x2B,
        "Period" => 0x2F,
        "Slash" => 0x2C,
        "Backquote" => 0x32,
        "ShiftLeft" => 0x38,
        "ShiftRight" => 0x3C,
        "ControlLeft" => 0x3B,
        "ControlRight" => 0x3E,
        "AltLeft" => 0x3A,
        "AltRight" => 0x3D,
        "MetaLeft" => 0x37,
        "MetaRight" => 0x36,
        _ => return None,
    })
}

/// The `characters` / `charactersIgnoringModifiers` pair AppKit would put on a
/// key event. Printable keys carry the text the press types (`key`, which the
/// frontend already shifted) and its unshifted form; the named keys carry
/// AppKit's own function-key code points (`NSUpArrowFunctionKey` …), which
/// WebKit maps back to `key` values like `ArrowUp`.
pub fn key_characters(code: &str, key: &str) -> (String, String) {
    let function = |c: u32| char::from_u32(c).map(String::from).unwrap_or_default();
    let named = match code {
        "Enter" => Some("\r".to_string()),
        "Escape" => Some("\u{1b}".to_string()),
        "Backspace" => Some("\u{7f}".to_string()),
        "Tab" => Some("\t".to_string()),
        "ArrowUp" => Some(function(0xF700)),
        "ArrowDown" => Some(function(0xF701)),
        "ArrowLeft" => Some(function(0xF702)),
        "ArrowRight" => Some(function(0xF703)),
        "Delete" => Some(function(0xF728)),
        "Home" => Some(function(0xF729)),
        "End" => Some(function(0xF72B)),
        "PageUp" => Some(function(0xF72C)),
        "PageDown" => Some(function(0xF72D)),
        _ => code
            .strip_prefix('F')
            .and_then(|n| n.parse::<u32>().ok())
            .filter(|n| (1..=12).contains(n))
            .map(|n| function(0xF704 + n - 1)),
    };
    if let Some(s) = named {
        return (s.clone(), s);
    }
    let unshifted = if code.starts_with("Key") {
        key.to_lowercase()
    } else {
        key.to_string()
    };
    (key.to_string(), unshifted)
}

/// `debug_set_occlusion_throttling`'s answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcclusionReport {
    /// Whether WebKit throttles this window when it is covered, before the call.
    pub before: bool,
    /// …and after it.
    pub after: bool,
    pub window: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mouse(phase: MousePhase, buttons: u32, delay_ms: f64) -> LowEvent {
        LowEvent::Mouse {
            phase,
            x: 10.0,
            y: 20.0,
            button: MouseButton::Left,
            buttons,
            click_count: 1,
            modifiers: Modifiers::default(),
            delay_ms,
        }
    }

    #[test]
    fn the_frontend_wire_format_deserialises() {
        let json = r#"[
            {"kind":"mouse","phase":"down","x":1.5,"y":2,"button":"left","buttons":1,"clickCount":1,
             "modifiers":{"shift":false,"ctrl":false,"alt":true,"meta":false},"delayMs":0},
            {"kind":"wheel","x":1,"y":2,"deltaX":0,"deltaY":-20,"modifiers":{"shift":false,"ctrl":true,"alt":false,"meta":false},"delayMs":16},
            {"kind":"magnify","x":1,"y":2,"magnification":0.1,"phase":"change","modifiers":{"shift":false,"ctrl":false,"alt":false,"meta":false},"delayMs":0},
            {"kind":"key","phase":"down","code":"KeyZ","key":"z","modifiers":{"shift":false,"ctrl":false,"alt":false,"meta":true},"delayMs":0},
            {"kind":"modifier","phase":"up","code":"AltLeft","key":"Alt","modifiers":{"shift":false,"ctrl":false,"alt":false,"meta":false},"delayMs":0}
        ]"#;
        let events: Vec<LowEvent> = serde_json::from_str(json).expect("wire format");
        assert_eq!(events.len(), 5);
        assert!(matches!(
            events[0],
            LowEvent::Mouse {
                phase: MousePhase::Down,
                buttons: 1,
                modifiers: Modifiers { alt: true, .. },
                ..
            }
        ));
        assert!(matches!(events[1], LowEvent::Wheel { delta_y, .. } if delta_y == -20.0));
        assert!(validate(&events).is_ok());
    }

    #[test]
    fn the_buttons_override_is_only_reported_when_a_button_is_involved() {
        let plain_move = [mouse(MousePhase::Move, 0, 0.0)];
        assert!(
            !override_in_effect(&plain_move, false),
            "a hover holds nothing"
        );
        assert!(!override_in_effect(&[], false));
        assert!(override_in_effect(
            &[mouse(MousePhase::Down, 1, 0.0)],
            false
        ));
        assert!(
            override_in_effect(&[mouse(MousePhase::Move, 1, 0.0)], false),
            "a drag move"
        );
        // The `up` half of a continued gesture: nothing held after it, but one
        // was held when the call began.
        assert!(override_in_effect(&[mouse(MousePhase::Up, 0, 0.0)], true));
        let key = LowEvent::Key {
            phase: KeyPhase::Down,
            code: "KeyZ".into(),
            key: "z".into(),
            modifiers: Modifiers::default(),
            delay_ms: 0.0,
        };
        assert!(!override_in_effect(&[key], false));
    }

    #[test]
    fn only_a_buttonless_move_into_a_non_key_window_needs_the_window_made_key() {
        assert!(move_needs_key_window(MousePhase::Move, 0, false));
        assert!(
            !move_needs_key_window(MousePhase::Move, 0, true),
            "already key"
        );
        assert!(
            !move_needs_key_window(MousePhase::Move, 1, false),
            "a drag is delivered anyway"
        );
        assert!(!move_needs_key_window(MousePhase::Down, 1, false));
        assert!(!move_needs_key_window(MousePhase::Up, 0, false));
    }

    #[test]
    fn a_windowless_wheel_event_is_located_so_appkit_reports_the_window_point() {
        // 900-high primary display; the wanted window-space point is (100, 250)
        // from the window's bottom-left. AppKit reports screen y from the bottom,
        // i.e. 900 - cg_y, which must come back as 250.
        let (x, cg_y) = windowless_event_location((100.0, 250.0), 900.0);
        assert_eq!(x, 100.0);
        assert_eq!(900.0 - cg_y, 250.0);
    }

    #[test]
    fn validate_refuses_what_should_not_be_played() {
        assert!(validate(&[]).is_err());
        assert!(validate(&[mouse(MousePhase::Move, 0, -1.0)]).is_err());
        assert!(validate(&[mouse(MousePhase::Move, 0, MAX_DELAY_MS + 1.0)]).is_err());
        let mut nan = mouse(MousePhase::Move, 0, 0.0);
        if let LowEvent::Mouse { x, .. } = &mut nan {
            *x = f64::NAN;
        }
        assert!(validate(&[nan]).is_err());
        let too_many: Vec<LowEvent> = (0..=MAX_EVENTS)
            .map(|_| mouse(MousePhase::Move, 0, 0.0))
            .collect();
        assert!(validate(&too_many).unwrap_err().contains("limit"));
        let too_long: Vec<LowEvent> = (0..7)
            .map(|_| mouse(MousePhase::Move, 0, MAX_DELAY_MS))
            .collect();
        assert!(validate(&too_long).unwrap_err().contains("in total"));
        let bad_key = LowEvent::Key {
            phase: KeyPhase::Down,
            code: "KeyÉ".into(),
            key: "é".into(),
            modifiers: Modifiers::default(),
            delay_ms: 0.0,
        };
        assert!(validate(&[bad_key]).unwrap_err().contains("virtual key"));
    }

    #[test]
    fn css_points_map_into_flipped_and_unflipped_views() {
        // A 2x page zoom: 1 CSS px = 2 view points.
        assert_eq!(css_to_view(10.0, 30.0, 2.0, 1000.0, true), (20.0, 60.0));
        assert_eq!(css_to_view(10.0, 30.0, 2.0, 1000.0, false), (20.0, 940.0));
        assert_eq!(
            view_scale(
                1280.0,
                Viewport {
                    width: 1280.0,
                    height: 720.0
                }
            ),
            Ok(1.0)
        );
        assert!(
            view_scale(
                1280.0,
                Viewport {
                    width: 0.0,
                    height: 720.0
                }
            )
            .is_err()
        );
    }

    #[test]
    fn a_move_with_a_button_held_is_that_buttons_drag() {
        assert_eq!(
            mouse_kind(MousePhase::Move, MouseButton::Left, 0),
            MouseKind::Moved
        );
        assert_eq!(
            mouse_kind(MousePhase::Move, MouseButton::Left, 1),
            MouseKind::Dragged(MouseButton::Left)
        );
        assert_eq!(
            mouse_kind(MousePhase::Move, MouseButton::Left, 2),
            MouseKind::Dragged(MouseButton::Right)
        );
        assert_eq!(
            mouse_kind(MousePhase::Down, MouseButton::Middle, 4),
            MouseKind::Down(MouseButton::Middle)
        );
    }

    #[test]
    fn modifier_bits_are_appkits() {
        assert_eq!(modifier_bits(Modifiers::default()), 0);
        let all = Modifiers {
            shift: true,
            ctrl: true,
            alt: true,
            meta: true,
        };
        assert_eq!(
            modifier_bits(all),
            (1 << 17) | (1 << 18) | (1 << 19) | (1 << 20)
        );
    }

    #[test]
    fn virtual_keys_match_carbon_events_h() {
        assert_eq!(virtual_key("KeyA"), Some(0x00));
        assert_eq!(virtual_key("KeyZ"), Some(0x06));
        assert_eq!(virtual_key("KeyM"), Some(0x2E));
        assert_eq!(virtual_key("Digit0"), Some(0x1D));
        assert_eq!(virtual_key("Space"), Some(0x31));
        assert_eq!(virtual_key("Delete"), Some(0x75));
        assert_eq!(virtual_key("Backspace"), Some(0x33));
        assert_eq!(virtual_key("F12"), Some(0x6F));
        assert_eq!(virtual_key("MetaLeft"), Some(0x37));
        assert_eq!(virtual_key("F13"), None);
        assert_eq!(virtual_key("KeyAB"), None);
        assert_eq!(virtual_key("Nope"), None);
    }

    #[test]
    fn every_letter_has_a_distinct_virtual_key() {
        let mut codes: Vec<u16> = (b'A'..=b'Z')
            .map(|c| virtual_key(&format!("Key{}", c as char)).expect("letter"))
            .collect();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes.len(), 26);
    }

    #[test]
    fn key_characters_follow_appkit() {
        assert_eq!(key_characters("KeyZ", "Z"), ("Z".into(), "z".into()));
        assert_eq!(key_characters("Digit1", "!"), ("!".into(), "!".into()));
        assert_eq!(key_characters("Space", " "), (" ".into(), " ".into()));
        assert_eq!(key_characters("ArrowLeft", "ArrowLeft").0, "\u{F702}");
        assert_eq!(key_characters("Delete", "Delete").0, "\u{F728}");
        assert_eq!(key_characters("Backspace", "Backspace").0, "\u{7f}");
        assert_eq!(key_characters("F1", "F1").0, "\u{F704}");
    }
}
