# Internal debug tooling — for agent/dev use, never shipped

Owner, 2026-09-08: build a real set of internal tools that let an agent (a future
Claude Code session) inspect and drive the running Chroma app directly — screenshots,
UI state open/close/select, pixel-level inspection — instead of relying on the owner's
own eyes and manual screenshots every time a UI bug needs verifying. This doc is the
durable tracker for that initiative; individual pieces still get their own `D-NNN`/
bug entries as they land.

**The hard invariant: every tool here is debug-only and MUST be compiled/stripped out
of a production build** — never a runtime flag, never "just don't call it in prod,"
a real compile-time gate (`#[cfg(debug_assertions)]`, a Cargo feature, or equivalent)
so there is no path for one of these to ship. These are for us, not for an end user's
build of Chroma.

## Why this exists (the real, repeated problem)

Every agent this session that tried to live-verify a UI fix hit the same wall: this
process has no macOS Screen Recording permission, so `screencapture` fails outright,
and there's no way to see the real running app. The fallbacks used instead (MCP state
polling, blind `cliclick` coordinate guesses, pixel-sampling an EXPORTED file instead
of the live preview) all work but are strictly worse than actually looking at the
screen — and are why a bug like "the on-canvas box doesn't match the picture" took
several rounds of the owner's own screenshots before an agent could even confirm it.

## Pieces

1. **Screenshot capture** — in progress (2026-09-08). A Tauri command using
   WKWebView's own `takeSnapshot` API (an in-process capture the app does of its own
   window content, NOT a system-level screen grab — sidesteps the Screen Recording
   permission wall entirely, doesn't need it) plus an MCP tool wrapping it, so an
   agent can call the tool, get a real PNG path, and `Read` it to actually see current
   state. Status/branch: see `docs/CHANGELOG.md`'s dated entry once it lands.
2. **UI state open/close/select debug actions** — scoped, not started. Deterministic,
   non-pixel-coordinate ways to drive the UI for testing: open/close a specific panel
   (Inspector, Sources, a modal), select a tab/timeline/clip, trigger a specific state
   transition — through the same store actions a human's click already goes through,
   not a parallel simulation of one. Exposed as MCP tools, matching the screenshot
   tool's own naming/registration convention once that lands (dispatched right after,
   deliberately not in parallel — both would touch the same Tauri command-registration
   file and `mcp/server.py`, guaranteeing a merge conflict).
3. **Pixel/color inspection** — scoped alongside the screenshot tool: sample a real
   RGB value at given (x, y) from a captured screenshot, for the "color placement,
   pixel alignment" checks the owner named directly.
4. **DOM tree capture** — scoped, not started (owner, 2026-09-08: "build tools to
   capture the dom tree and other things which help you visualize, be smart about
   it"). A way to dump the running webview's real DOM structure (element hierarchy,
   computed styles, bounding rects) — not just pixels, so an agent can answer "why
   is this element positioned/sized/styled this way" directly instead of guessing
   from a screenshot alone. Likely a small in-page JS snippet invoked the same way
   the screenshot tool is invoked (a Tauri command that evaluates JS in the webview
   and returns the result — check what Tauri's own `eval`/`webview.eval` API already
   offers before building a custom bridge). Dispatch AFTER the screenshot tool lands
   (same Tauri-command-registration and `mcp/server.py` territory — parallel
   dispatch would just conflict).

5. **Preview frame-timing readout** — scoped, not started (found needed by D-217,
   2026-09-08). "Report the last N frame-to-frame intervals `PreviewPane` actually
   painted", as a debug op + MCP tool. D-217 fixed the Edit-tab preview's dominant
   per-frame cost (42.7 → 14.0 ms) and could measure that precisely in Rust, but
   **could not measure the thing the owner actually reported** — perceived playback
   smoothness — because there is no way to see webview-side paint timing. Two
   blockers found while trying, both worth knowing: a second app instance needs the
   `identifier` overridden (`tauri-plugin-single-instance`), and a **background**
   window's `requestAnimationFrame` is throttled to a stop, so the play loop does
   not tick at all in a non-frontmost instance. A frame-interval readout sidesteps
   both: the app measures itself and an agent reads the numbers. Same
   registration/naming convention as the screenshot tool, same
   `#[cfg(debug_assertions)]` gate as everything else here.

## Two different levels — don't conflate them

- **Component level** (a single component in isolation, e.g. `PreviewPane`/
  `TimelinePane`): mostly ALREADY SOLVED, before this initiative — the D-142
  browser harness (`app/harness.html?mode=preview` etc.) is a real Chromium tab,
  reachable via `chrome-devtools`/`claude-in-chrome` MCP tools INCLUDING their own
  screenshot action, with none of the Screen Recording permission problem (it's a
  normal browser tab, not the native window). Several agents this session already
  used it for real hit-testing/pointer-gesture verification. Prefer extending this
  harness (a new `?mode=` if one doesn't exist yet for what needs isolating) over
  building a new mechanism, for anything that can be exercised there.
- **Whole-app level** (the real, native, WKWebView-backed Tauri window, actually
  opening a project/tab/panel and interacting with it as a user would): this is the
  actual gap items 1–4 above exist to close — no existing tool reaches this level.
  "Work as a user — open things, edit things, take a screenshot to validate" (owner,
  2026-09-08) means items 1 (screenshot) and 2 (open/close/select) together, as one
  real loop: drive a real state change through the same store actions/Tauri commands
  a human's click would, then screenshot to confirm what actually rendered — not two
  independent tools used separately.

## Status

Check `docs/CHANGELOG.md` (search "debug" or the date) for what has actually landed —
this file is the scope/tracker, not a live status board.
