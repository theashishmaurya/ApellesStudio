# apelles-ui-input

**Debug tooling (D-434).** The platform-independent half of the UI harness's trusted
native input.

The frontend gesture planner (`@apelles/debug`'s `src/input/plan.ts`) turns a gesture —
"drag from here to there in 300 ms with Alt held", "press Cmd+Z" — into a timed list of
primitive events. This crate is that list's Rust side and every rule about turning it into
an OS event that has a right answer:

- `LowEvent` / `Viewport` / `InjectReport` / `OcclusionReport` — the wire format, field for
  field with `input/types.ts`;
- `validate` — refuses a plan this side should not play (too many events, a non-finite
  coordinate, a negative or huge delay, longer than 60 s, a key with no virtual key);
- `css_to_view` / `view_scale` — CSS pixels → the webview's own (flipped or unflipped)
  coordinates;
- `modifier_bits` — AppKit's `NSEventModifierFlags` (shared with `CGEventFlags`);
- `mouse_kind` — a move with a button held is that button's drag event;
- `virtual_key` — DOM `KeyboardEvent.code` → Carbon `kVK_*` (WebKit derives `code` back
  from it, so it must be exact);
- `key_characters` — the `characters` / `charactersIgnoringModifiers` pair, including
  AppKit's function-key code points for the arrows, Delete, Home/End, F-keys.

## Boundary

- **Deps:** `serde` only. No platform code, no Tauri, no objc.
- **Does not deliver anything.** Building `NSEvent`s and calling the WKWebView's responder
  methods is `app/src-tauri/src/chroma/debug_input.rs`, which needs the window. That module
  is `#[cfg(debug_assertions)]`, so a release build calls nothing in this crate.
- **Depended on by:** `app/src-tauri` (that module) only.

Why a crate rather than a module in the app: these rules are where the bugs would be (a
wrong virtual key, a flipped y), and here they unit-test in under a second; in the app they
would need the whole app crate built to run a test.

## Testing

`cargo test -p apelles-ui-input` — the wire format deserialises exactly what the frontend
sends, validation refuses what it should, coordinates map for flipped and unflipped views,
every letter has a distinct Carbon key code, key characters follow AppKit.
