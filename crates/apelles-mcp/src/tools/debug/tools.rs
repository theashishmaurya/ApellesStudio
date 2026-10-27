//! The `debug_*` tools themselves — see `debug.rs` for why they live behind a gate.
//!
//! A separate file rather than an inline `mod { … }` for one concrete reason: an
//! inline module would have to be indented, and every tool description here is a raw
//! string whose bytes must stay exactly the Python docstring's. An indent pass breaks
//! that silently, and the parity gate catches it — twice, so far.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{ErrorData, tool, tool_router};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::args::WireArgs;
use crate::render;
use crate::server::ApellesMcp;

// Argument defaults — the Python signature's own.
fn default_debug_screenshot_inline() -> bool {
    false
}

fn default_debug_dom_tree_include_hidden() -> bool {
    false
}

fn default_debug_dom_tree_text() -> bool {
    true
}

fn default_debug_frame_timing_reset() -> bool {
    false
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugScreenshotArgs {
    #[serde(default)]
    pub out_path: Option<String>,
    #[serde(default)]
    pub window: Option<String>,
    #[serde(default = "default_debug_screenshot_inline")]
    pub inline: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSamplePixelArgs {
    pub path: String,
    pub x: i64,
    pub y: i64,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetActiveTabArgs {
    pub tab: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetSourcesPanelArgs {
    pub open: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetLibraryModeArgs {
    pub mode: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetEditorInspectorArgs {
    pub open: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetInspectorTabArgs {
    pub tab: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugDomTreeArgs {
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub max_depth: Option<i64>,
    #[serde(default)]
    pub max_nodes: Option<i64>,
    #[serde(default)]
    pub styles: Option<Vec<String>>,
    #[serde(default = "default_debug_dom_tree_include_hidden")]
    pub include_hidden: bool,
    #[serde(default = "default_debug_dom_tree_text")]
    pub text: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugFrameTimingArgs {
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default = "default_debug_frame_timing_reset")]
    pub reset: bool,
    #[serde(default)]
    pub window_ms: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetFpsOverlayArgs {
    pub enabled: bool,
    #[serde(default)]
    pub corner: Option<String>,
    #[serde(default)]
    pub update_ms: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugRecordVideoArgs {
    pub duration_secs: f64,
    #[serde(default)]
    pub out_path: Option<String>,
    #[serde(default)]
    pub fps: Option<i64>,
    #[serde(default)]
    pub width: Option<i64>,
    #[serde(default)]
    pub window: Option<String>,
}

#[tool_router(router = debug_router, vis = "pub")]
impl ApellesMcp {
    #[tool(
        name = "debug_ui_state",
        description = r#"Read the running app's real UI state: which tab is showing, which panels
    are open, what is selected, and every dialog currently on screen.

    Call this FIRST when you are about to drive the UI — it tells you what is
    already open, so you do not toggle a panel closed thinking you are opening
    it. Call it again after a `debug_set_*` to confirm the change landed
    (each setter also echoes its own field back, so a second call is only
    needed when you want the whole picture).

    Open dialogs are read off the DOM (`role="dialog"`/`alertdialog`), not off
    a store flag, so the list stays correct as modals are added to the app.

    Returns {shell:{activeTab,tabs,sourcesPanelOpen,wgpuSurfaceActive},
             editor:{inspectorOpen,inspectorTab,inspectorTabs,projectOpen,
                     timelineStatus,selection,selectedGap,playing,playhead},
             openDialogs:[{tag,role,label,rect}]}."#
    )]
    pub async fn debug_ui_state(&self) -> Result<CallToolResult, ErrorData> {
        // Tool name and op name differ here too — the op is `debug_get_ui_state`.
        let env = self.op("debug_get_ui_state", WireArgs::new()).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_screenshot",
        description = r#"Take a REAL screenshot of the running Apelles app's window and save it as
    a PNG. This is how you SEE the UI instead of inferring it from state.

    THE WORKFLOW (this is the whole point of the tool):
        1. call `debug_screenshot()`  ->  it returns {"path": "/abs/....png", ...}
        2. call the `Read` tool on that exact path  ->  the image is rendered
           into your context and you can actually look at it.
    Steps 1 and 2 are separate on purpose: the path is cheap, the image is not.
    Pass `inline=True` to skip step 2 and get the picture back in this call
    instead — convenient, but a full-resolution window is a large image, so
    prefer path + `Read` when you only need one look.

    Use it to check the things state polling cannot answer: is the on-canvas
    box where the picture actually is, does this panel overlap that one, is the
    colour/contrast right, did the layout break at this window size. For a
    before/after comparison, take one shot, make the change, take another, and
    `Read` both — the filenames are timestamped so they sort in order.

    Why this works when `screencapture` does not: macOS gates SYSTEM screen
    capture behind the Screen Recording permission, which an agent process here
    does not have. This is not screen capture — the app asks its own WKWebView
    to render itself (`takeSnapshotWithConfiguration:`), in the process that
    already owns it, so no permission is involved.

    Args:
        out_path: absolute destination. Default: a timestamped file under
            $TMPDIR/chroma-debug-screenshots/ (never inside the repo).
        window: Tauri window label. Default: the focused window, else "main".
        inline: also return the image itself, not just its path.

    LIMITS — read these before trusting a shot:
      * WEBVIEW, PLUS one deliberate exception. The native title bar, native
        menus, a native file/save dialog, and anything from another app are
        NOT in the image. If you opened a native dialog, the screenshot shows
        the page behind it. The one exception: the Colorist tab's picture is
        composited in on top of the webview capture (B-151) — it is a native
        wgpu surface painted behind the webview, invisible to a plain webview
        snapshot, so it is read back and pasted in separately. That overlay is
        a standard resize, not a byte-exact copy of the live shader output;
        for a pixel-exact colour check use `inspect_color`/`sample`/
        `sample_region` instead of reading pixels out of this screenshot.
      * The image is in real device pixels: `width`/`height` are CSS pixels x
        `scaleFactor` (2 on a Retina display). Divide by `scaleFactor` to map a
        screenshot coordinate back to a DOM coordinate.
      * A minimised or hidden window is a hard error, not a blank image.
      * macOS only.

    Returns {path, label, width, height, scaleFactor, bytes}."#
    )]
    pub async fn debug_screenshot(
        &self,
        Parameters(p): Parameters<DebugScreenshotArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Both are sent only when non-empty — an empty string is not a path or a window
        // name, and the app's own defaults are what an absent key selects.
        let args = WireArgs::new()
            .put("out_path", p.out_path.filter(|s| !s.is_empty()))
            .put("window", p.window.filter(|s| !s.is_empty()));
        let env = self.op("debug_screenshot", args).await?;
        // The screenshot is written to disk by the app (this op is answered natively in
        // `control.rs`, with no frontend round trip), so inlining it means reading the
        // file back — `render::file_png_result`, shared with `motion_preview_frame`.
        Ok(render::file_png_result(&env, p.inline, "saved"))
    }

    #[tool(
        name = "debug_sample_pixel",
        description = r#"Read the exact RGBA of ONE pixel out of a screenshot `debug_screenshot`
    saved. The numeric companion to looking at the image: use it to prove a
    colour claim ("that swatch really is the accent token", "the box edge lands
    on the picture edge, not 3px inside it") instead of eyeballing it.

    Coordinates are IMAGE pixels, not CSS pixels — multiply a DOM coordinate by
    the `scaleFactor` the screenshot returned (2 on a Retina display). Out of
    bounds is an error naming the real image size, so a coordinate-space
    mistake shows up immediately rather than as a wrong colour.

    Returns {x, y, r, g, b, a, hex, imageWidth, imageHeight}."#
    )]
    pub async fn debug_sample_pixel(
        &self,
        Parameters(p): Parameters<DebugSamplePixelArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("path", p.path)
            .set("x", p.x)
            .set("y", p.y);
        let env = self.op("debug_sample_pixel", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_active_tab",
        description = r#"Switch the app to a top-level tab: "edit", "motion" or "colorist".

    Drives `useShellStore.setActiveTab` — literally the function the tab
    button's onClick calls — so this is a real tab switch, not a simulated
    click on a coordinate. A 1-based index ("1"/"2"/"3", matching the
    Cmd/Ctrl+1/2/3 shortcut) is accepted too. An unknown name is refused with
    the accepted list rather than silently ignored.

    Note the tabs only render while a project is open; with none open the app
    shows the project launcher and this changes which tab is *behind* it.

    Returns {ok, activeTab}."#
    )]
    pub async fn debug_set_active_tab(
        &self,
        Parameters(p): Parameters<DebugSetActiveTabArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("tab", p.tab);
        let env = self.op("debug_set_active_tab", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_sources_panel",
        description = r#"Show or hide the shell's docked left library column — the same state the
    panel's own toggle drives (on the Edit tab, that toggle is the library
    rail's own buttons).

    D-263: this column shows the shared media pool by default, but the Edit
    tab's rail can switch it to that tab's Titles / Effects / Subtitles
    libraries. `debug_ui_state`'s `editor.libraryMode` says which one is
    showing, so a screenshot of this column can be read correctly; this tool
    still only controls whether the column is open at all.

    Returns {ok, sourcesPanelOpen}."#
    )]
    pub async fn debug_set_sources_panel(
        &self,
        Parameters(p): Parameters<DebugSetSourcesPanelArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("open", p.open);
        let env = self.op("debug_set_sources_panel", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_library_mode",
        description = r#"Switch which panel the Edit tab's left library column shows, and open
    the column so that panel is actually visible — the same state the library
    rail's own buttons drive.

    `mode` is one of "sources", "titles", "effects", "subtitles", "recut" or
    "index" (`debug_ui_state`'s `editor.libraryModes` lists them). The column
    is opened as well because the rail lives inside it: choosing a mode while
    the column is closed would change nothing on screen. Useful to reach the
    Recut panel and check a retake proposal there. An unknown mode is refused
    with the accepted list rather than silently ignored.

    Returns {ok, libraryMode, sourcesPanelOpen}."#
    )]
    pub async fn debug_set_library_mode(
        &self,
        Parameters(p): Parameters<DebugSetLibraryModeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("mode", p.mode);
        let env = self.op("debug_set_library_mode", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_editor_inspector",
        description = r#"Show or hide the Edit tab's Inspector column — the same state its own
    toggle button (top-right of the preview) drives.

    Useful as the first step of a verification loop: open the Inspector here,
    `debug_screenshot` to see it, `debug_dom_tree('[data-chroma-panel=
    "editor-inspector"]')` to check where it actually landed.

    Returns {ok, inspectorOpen}."#
    )]
    pub async fn debug_set_editor_inspector(
        &self,
        Parameters(p): Parameters<DebugSetEditorInspectorArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("open", p.open);
        let env = self.op("debug_set_editor_inspector", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_inspector_tab",
        description = r#"Switch the Edit tab's clip Inspector between its "video" and "audio"
    tabs (D-246) — the same state the tab bar's own button drives.

    The Inspector splits a clip's properties in two: Video holds Transform,
    Crop, Dynamic Zoom, Speed, Fade and the whole-clip Keyframes actions;
    Audio holds Volume/Pan and the four-band EQ. Only one is on screen at a
    time, so a `debug_screenshot` or a `debug_dom_tree` of the Inspector shows
    one of them — set the tab first when you are looking for a control on the
    other.

    You do NOT need this to EDIT anything: every control on both tabs already
    has its own MCP tool (`editor_set_clip_transform`, `set_clip_audio` /
    `editor_set_clip_*`, …) that writes the timeline directly, whichever tab
    is showing. This is for looking at the app, which is what the `debug_*`
    family is for.

    The choice is sticky and per session: a clip with no audio at all (a
    generated title) shows its Video tab regardless, without forgetting the
    choice. An unknown name is refused with the accepted list rather than
    silently ignored.

    Returns {ok, inspectorTab}."#
    )]
    pub async fn debug_set_inspector_tab(
        &self,
        Parameters(p): Parameters<DebugSetInspectorTabArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("tab", p.tab);
        let env = self.op("debug_set_inspector_tab", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_dom_tree",
        description = r#"Dump the real DOM under `selector`: element hierarchy, ids/classes,
    data-*/aria-*/role attributes, each element's `getBoundingClientRect()`,
    and a chosen set of computed styles.

    This answers WHY, where a screenshot only answers WHAT. "The panel looks
    too narrow" -> dump it and read the real width, its parent's width, and
    which one is `position:absolute`. "The button isn't visible" -> the node is
    flagged `invisible` (display:none/visibility:hidden) or `zeroArea`, with
    the styles that caused it right there.

    ALWAYS pass a `selector` when you know the region you care about — Apelles'
    full page is thousands of nodes and the default bounds will truncate it
    into uselessness. Stable hooks exist for the big panels:
    `[data-chroma-panel="editor-inspector"]`, `[data-chroma-panel="sources"]`.

    Coordinates are CSS pixels; `debug_screenshot` pixels are DEVICE pixels.
    Multiply by the screenshot's `scaleFactor` (== `viewport.devicePixelRatio`
    here) to point `debug_sample_pixel` at a rect from this dump.

    Args:
        selector: CSS selector for the root. Default "body". No match returns
            root=null (not an error); a malformed selector IS an error.
        max_depth: how deep to walk. Default 12.
        max_nodes: total node budget. Default 300, max 5000.
        styles: computed properties to report, e.g. ["display","width",
            "position"]. Default a small layout/colour set; [] for none.
        include_hidden: walk into display:none subtrees too. Default false.
        text: include each element's own direct text. Default true.

    Every bound REPORTS itself: `truncated` on the result, and
    `childrenTruncated: "depth"|"nodes"|"invisible"` on the node where it bit,
    so you can always tell "that's all there is" from "there was more"."#
    )]
    pub async fn debug_dom_tree(
        &self,
        Parameters(p): Parameters<DebugDomTreeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("includeHidden", p.include_hidden)
            .set("text", p.text)
            // Sent only when non-empty: an empty selector is not "the whole document",
            // it is no selector at all.
            .put("selector", p.selector.filter(|s| !s.is_empty()))
            .put("maxDepth", p.max_depth)
            .put("maxNodes", p.max_nodes)
            .put("styles", p.styles);
        let env = self.op("debug_dom_tree", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_frame_timing",
        description = r#"Read what the Edit tab's preview playback loop ACTUALLY did: the real
    frame-to-frame intervals, in the webview, as measured by the app itself.

    Use it to answer "is playback smooth?" — a question no Rust-side timing and
    no screenshot can answer. Two CADENCE channels, and the difference between
    them is the diagnosis:
      * `paint` — frames actually put on screen. Low fps here = decode/
        composite is too slow.
      * `raf`   — requestAnimationFrame ticks, i.e. how often the play loop got
        to run at all. Near-zero here with healthy `paint` means the WINDOW is
        throttled (backgrounded/occluded), not that rendering is slow. Bring
        the window to the front and measure again.

    Each returns {samples, intervalsMs, minMs, medianMs, p95Ms, maxMs, fps,
    hitches} — `hitches` counts intervals over twice the median, which is the
    "stutter" a human reports. min/median/p95/max/fps cover the whole ring
    buffer (240 samples); `intervalsMs` is just the tail.

    Plus two COST channels (D-282), which answer the next question — "the loop
    is at 40 fps, so where did the 25 ms GO?":
      * `fetch` — the `chroma_timeline_frame` round trip: Tauri IPC plus all of
        Rust's decode + composite + JPEG. Everything below the webview.
      * `tick`  — one whole pass of the play loop.
    Each returns {samples, msLatest, minMs, medianMs, p95Ms, maxMs, meanMs} —
    costs, so no fps and no hitches. Read them by SUBTRACTION:
      * `fetch.medianMs`                  → Rust + IPC
      * `tick.medianMs - fetch.medianMs`  → the loop's own JavaScript
      * `raf.medianMs  - tick.medianMs`   → React's render/commit + the wait
                                            for the next animation frame
    D-282's own profile of the owner's project, for comparison: 25.0 ms a
    frame, of which only ~3.5 ms was Rust — the preview's frame-rate ceiling is
    set on the webview side, not by the decoder.

    `scrub` (D-336) is a FIFTH channel and a separate question. `fetch`/`tick`/
    `raf` are recorded only inside the play loop; `scrub` times the same
    `chroma_timeline_frame` round trip on the PAUSED path, which the play
    numbers never covered. Compare the two directly: `scrub.medianMs` far above
    `fetch.medianMs` means the cost is the decode pipe being asked for frames
    BEHIND its read head — a kill-and-respawn plus an ffmpeg keyframe seek,
    measured at 248-337 ms against 6.7 ms for a sequential read — and not a
    slow webview. To fill this channel, move the playhead while PAUSED
    (`editor_set_playhead`) rather than playing.

    Measure properly: `debug_frame_timing(reset=True)` to clear, then
    `editor_set_playing(True)`, wait a few seconds, `editor_set_playing(False)`,
    then read. Numbers from before a reset mix scrubbing in with playback.
    Two traps worth knowing, both hit live while D-282 was profiling: a
    playhead already parked on the LAST frame makes playback stop instantly
    (one raf sample, no movement — check `editor_get_state`'s playhead against
    the timeline's length), and a stretch of timeline with a GAP under it
    decodes nothing at all, so it measures the loop's floor rather than real
    playback. Both look exactly like "it stalled" in the numbers.

    Args:
        limit: how many raw samples to return per channel. Default 60.
        reset: clear all four buffers first (and return the now-empty report).
        window_ms: derive every channel from only the last N milliseconds of
            samples instead of the whole 240-sample ring buffer. Omit for the
            whole buffer (the historical behaviour). Pass 2000 to read exactly
            what `debug_set_fps_overlay`'s on-screen readout is showing."#
    )]
    pub async fn debug_frame_timing(
        &self,
        Parameters(p): Parameters<DebugFrameTimingArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("limit", p.limit)
            // Presence-signalled: sent only when true, never as `false`.
            .put_if("reset", p.reset)
            // D-330 — the wire key is camelCase while the tool argument is
            // snake_case, matching how `out_path`/`maxDepth` already differ
            // across this boundary.
            .put("windowMs", p.window_ms);
        let env = self.op("debug_frame_timing", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_fps_overlay",
        description = r#"Burn a live frame-rate readout into the app's own window, so a
    screenshot or a recording carries its own measurement in the picture.

    The overlay shows the SAME `paint` and `raf` numbers `debug_frame_timing`
    reports — it formats those ring buffers, it does not measure anything of
    its own. That is the point: a number in a recording is only evidence if it
    is the same number the tooling answers. Read it back with
    `debug_frame_timing(window_ms=2000)` and the two agree exactly.

    WHY YOU WOULD USE IT: to show a performance change instead of asserting
    one. Turn it on, record with `debug_record_video`, and the footage proves
    its own frame rate. A before/after pair made this way is checkable by
    someone who was not there.

    What it shows, updated 4x a second (fast enough to track a stall, slow
    enough that the digits stay readable on camera):
        PAINT 12.4 fps      <- frames actually put on screen
        RAF   24.1 fps      <- how often the play loop got to run at all
        2.0s window · 3 hitches

    Read those exactly as you read `debug_frame_timing`: a near-zero `RAF`
    beside a healthy `PAINT` means the window is backgrounded and throttled,
    not that rendering is slow. `--` instead of a number means nothing has
    painted yet, which is different from painting at zero.

    It is fixed-position and cannot affect layout or swallow a click, and it
    is plain DOM on a timer rather than a React component — a readout that
    re-rendered the app four times a second would change the very frame rate
    it is reporting.

    NOT captured: the Colorist tab's picture is a native surface behind the
    webview, so a recording of that tab shows the overlay over an empty
    canvas. This is for the Edit tab.

    Args:
        enabled: True to show the readout, False to remove it.
        corner: top-left, top-right, bottom-left or bottom-right. Default
            top-right (the one corner that is never the subject of a
            performance recording). Kept from the previous call if omitted.
        update_ms: how often to refresh the number. Default 250, clamped to
            16..2000. The reply echoes what was actually applied."#
    )]
    pub async fn debug_set_fps_overlay(
        &self,
        Parameters(p): Parameters<DebugSetFpsOverlayArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            // Always sent — it is the one required argument, and `false` is a
            // real instruction here rather than an absent one.
            .set("enabled", Value::Bool(p.enabled))
            .put("corner", p.corner)
            .put("updateMs", p.update_ms);
        let env = self.op("debug_set_fps_overlay", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_record_video",
        description = r#"Record the running Apelles window to a real, playable video file. This
    is `debug_screenshot` over TIME — how you SHOW behaviour that only exists
    in motion (stutter, a lagging scrub, a slow first frame).

    THE WORKFLOW this exists for:
        1. debug_set_fps_overlay(enabled=True)   -> the readout is on screen
        2. editor_set_playing(True)              -> start the thing to record
        3. debug_record_video(duration_secs=10)  -> record it
        4. editor_set_playing(False)
        5. debug_frame_timing(window_ms=2000)    -> cross-check the number
    The result is footage with the app's own measured frame rate burned into
    it. Do the same on a fix branch and the two files are a real before/after.

    IT CAPTURES THE WEBVIEW, NOT THE SCREEN — same mechanism and same limits
    as `debug_screenshot` (no macOS Screen Recording permission is involved or
    needed). Native window chrome, menus and dialogs are invisible to it, and
    the Colorist tab's picture is a native surface behind the webview, so it
    does NOT appear. This is for the Edit tab. No audio is recorded.

    PUT THE WINDOW IN FRONT FIRST. A backgrounded macOS window has its
    requestAnimationFrame throttled to a stop, so playback does not really
    run and the recording measures the throttling instead of the app. The
    reply's `windowFocused` says which you got; if it is false, the footage is
    not evidence of anything.

    READ THE REPLY BEFORE TRUSTING THE FOOTAGE. Every number in it is
    measured, not requested:
      * `framesCaptured` / `framesDuplicated` — the recorder holds a fixed
        cadence so the video's wall clock matches real time. When a capture
        misses its slot the previous frame is repeated rather than letting the
        recording drift into slow motion, and that padding is COUNTED here. A
        large `framesDuplicated` means the capture could not keep up.
      * `capturedFps` — the capture rate genuinely achieved.
      * `captureMsMedian` / `captureMsP95` — what each capture cost the app
        being recorded. This is the observer cost; compare `debug_frame_timing`
        with and without a recording running before trusting a recorded fps.

    This call BLOCKS the app's whole control server for its full duration (the
    server answers one request at a time), so nothing else can be driven while
    it runs. Duration is capped at 120s for that reason.

    Args:
        duration_secs: how long to record, 0.1 to 120.
        out_path: absolute path for the .mp4. Default: a timestamped file in
            the same directory `debug_screenshot` writes to.
        fps: capture cadence, 1..60. Default 15 — above what this preview
            actually achieves, without stealing time from it.
        width: width of the finished video, in real pixels. Default 1280.
            WebKit rasterises at this size rather than the frame being
            downscaled afterwards, so it genuinely reduces what each capture
            costs the app: measured on a 2x display, 58.7ms per capture at
            native 2560px against 15.0ms at 1280. Pass 0 for native.
        window: which window by Tauri label. Default: the focused one."#
    )]
    pub async fn debug_record_video(
        &self,
        Parameters(p): Parameters<DebugRecordVideoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // The recording really does take `duration_secs`, and this op is
        // answered natively in the app rather than forwarded, so the budget
        // must cover the whole capture plus ffmpeg's final mux. Without it a
        // successful recording comes back as a client-side timeout — the
        // B-153 failure mode, in a tool whose runtime is knowable up front.
        // `as i64` truncates toward zero, which is what Python's `int()` does
        // — the two servers must put the same number on the wire. The floor
        // at zero is this side's own: the budget is unsigned here, and a
        // duration negative enough to underflow it is refused by the app
        // anyway (`debug_record::validate_duration`).
        let timeout_ms = ((p.duration_secs * 1000.0) as i64 + 60_000).max(0) as u64;
        let args = WireArgs::new()
            .set(
                "duration_secs",
                serde_json::Number::from_f64(p.duration_secs)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            )
            .put("out_path", p.out_path)
            .put("fps", p.fps)
            .put("width", p.width)
            .put("window", p.window);
        let env = self.op_with("debug_record_video", timeout_ms, args).await?;
        Ok(render::json_text(&env))
    }
}
