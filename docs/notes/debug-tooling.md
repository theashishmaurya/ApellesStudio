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

## Status

Check `docs/CHANGELOG.md` (search "debug" or the date) for what has actually landed —
this file is the scope/tracker, not a live status board.
