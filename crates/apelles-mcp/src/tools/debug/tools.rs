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
use crate::schemas::{PointerTarget, PointerWatch};
use crate::server::ApellesMcp;

/// D-434 — the UI harness's input tools carry a whole gesture plus its settle time
/// in one op, and the app refuses any plan longer than 60 s, so one fixed budget
/// above that covers every legal call. `mcp/server.py`'s `INPUT_OP_TIMEOUT_MS`.
const INPUT_OP_TIMEOUT_MS: u64 = 90_000;

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
pub struct DebugSetEditorLayoutArgs {
    #[serde(default)]
    pub browser_open: Option<bool>,
    #[serde(default)]
    pub browser_width: Option<f64>,
    #[serde(default)]
    pub inspector_width: Option<f64>,
    #[serde(default)]
    pub timeline_height: Option<f64>,
    #[serde(default)]
    pub reset_timeline_height: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetInspectorTabArgs {
    pub tab: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetInspectorSectionArgs {
    pub id: String,
    pub open: bool,
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

fn default_debug_pointer_measure() -> bool {
    false
}

fn default_debug_key_measure() -> bool {
    false
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugPointerArgs {
    pub action: String,
    pub target: PointerTarget,
    #[serde(default)]
    pub to: Option<PointerTarget>,
    #[serde(default)]
    pub path: Option<Vec<PointerTarget>>,
    #[serde(default)]
    pub button: Option<String>,
    #[serde(default)]
    pub modifiers: Option<Vec<String>>,
    #[serde(default)]
    pub steps: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub hold_ms: Option<i64>,
    #[serde(default)]
    pub delta_x: Option<f64>,
    #[serde(default)]
    pub delta_y: Option<f64>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default = "default_debug_pointer_measure")]
    pub measure: bool,
    #[serde(default)]
    pub watch: Option<PointerWatch>,
    #[serde(default)]
    pub settle_ms: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugKeyArgs {
    #[serde(default)]
    pub keys: Option<Vec<String>>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub hold_ms: Option<i64>,
    #[serde(default)]
    pub gap_ms: Option<i64>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default = "default_debug_key_measure")]
    pub measure: bool,
    #[serde(default)]
    pub watch: Option<PointerWatch>,
    #[serde(default)]
    pub settle_ms: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugPerfEntriesArgs {
    #[serde(default)]
    pub prefix: Option<String>,
    #[serde(default)]
    pub clear: bool,
    #[serde(default)]
    pub wait_idle_ms: Option<i64>,
    #[serde(default)]
    pub trace_release_ms: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetOcclusionThrottlingArgs {
    pub enabled: bool,
    #[serde(default)]
    pub window: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
pub struct DebugSetWebkitLayerDebugArgs {
    #[serde(default)]
    pub borders: Option<bool>,
    #[serde(default)]
    pub repaint_counters: Option<bool>,
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

    The Motion player shows a custom component layer (D-409) as frames the
    renderer process drew. `motion.customProxies` reports each one: component,
    props, status (waiting / rendering / ready / error), how many layers show
    it, and its frame count and folder or its error. Use it to confirm the
    player really draws a custom layer, without a screenshot.

    A panel that crashed while rendering shows "The <panel> panel crashed"
    with a Reload panel button instead of taking the window down.
    `crashedPanels` lists every panel doing that now: its name, the error,
    React's component stack, when, and how many times. Ask the human to press
    Reload panel; the rest of the app, and its tools, keep working.

    Returns {shell:{activeTab,tabs,sourcesPanelOpen,wgpuSurfaceActive},
             editor:{inspectorOpen,inspectorTab,inspectorTabs,projectOpen,
                     timelineStatus,selection,selectedGap,playing,playhead},
             openDialogs:[{tag,role,label,rect}],
             motion:{customProxies:[{component,props,status,viewers,
                                     frames?,dir?,cached?,error?}]},
             crashedPanels:[{panel,message,stack,componentStack,at,count}]}."#
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
      * WEBVIEW, PLUS two deliberate exceptions. The native title bar, native
        menus, a native file/save dialog, and anything from another app are
        NOT in the image. If you opened a native dialog, the screenshot shows
        the page behind it. The exceptions are the two pictures drawn by the
        GPU on native layers behind the webview, invisible to a plain webview
        snapshot, so each is read back and pasted in separately: the
        Colorist tab's picture (B-151), on top of the capture, and the Edit
        tab's preview (D-454), under the capture's transparent preview area so
        the on-canvas handles and guides stay on top as on screen. Both are a
        standard resize of the frame, not a byte-exact copy of the screen; for
        a pixel-exact colour check use `inspect_color`/`sample`/
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
        description = r#"Show or hide the shell's docked Sources column on the Motion and
    Colorist tabs — the same state that column's own toggle drives.

    The Edit tab has no shell column (D-432 P5): it lays out its own media
    browser beside the viewer, shown and hidden with `debug_set_editor_layout`
    (`browser_open`) and switched between libraries with
    `debug_set_library_mode`.

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
        description = r#"Switch which library the Edit tab's media browser shows, and show the
    browser so that library is actually visible — the same state the browser's
    own tab bar drives (D-432 P5; it replaced the old left icon rail).

    `mode` is one of "sources", "titles", "effects", "subtitles", "recut",
    "music", "clipper" or "index" (`debug_ui_state`'s `editor.libraryModes`
    lists them). The browser is shown as well because choosing a library while
    it is hidden would change nothing on screen. Useful to reach the Recut
    panel and check a retake proposal there. An unknown mode is refused with
    the accepted list rather than silently ignored.

    Returns {ok, libraryMode, browserOpen}."#
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
    toggle button (right end of the viewer header) drives.

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
        name = "debug_set_editor_layout",
        description = r#"Set the Edit tab's panel layout (D-432 P5) — the same state the human
    sets by dragging its splits: browser | viewer | Inspector across the top,
    the timeline across the full width below.

    Every argument is optional; give at least one. Sizes are CSS pixels and are
    clamped to each split's bounds (browser 220-480, Inspector 264-440,
    timeline at least 180), exactly as a drag is. The layout persists across
    relaunches like a drag does. `debug_ui_state`'s `editor.layout` reports
    the current values (`timelineHeight: null` means never resized: the
    default 42 % share).

    Useful to put the window into a known shape before `debug_screenshot` or a
    harness scenario, or to reproduce a layout the human reported.

    Args:
        browser_open: show or hide the media browser (left).
        browser_width: the browser's width.
        inspector_width: the Inspector's width (shown or hidden with
            `debug_set_editor_inspector`).
        timeline_height: the timeline's height.
        reset_timeline_height: go back to the default 42 % share (overrides
            `timeline_height`).

    Returns {ok, layout} with the layout as it now stands."#
    )]
    pub async fn debug_set_editor_layout(
        &self,
        Parameters(p): Parameters<DebugSetEditorLayoutArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = WireArgs::new()
            .put("browserOpen", p.browser_open)
            .put("browserWidth", p.browser_width)
            .put("inspectorWidth", p.inspector_width);
        // `null` is the op's own "back to the default share", so the reset
        // flag sends it explicitly rather than omitting the key.
        args = if p.reset_timeline_height {
            args.set("timelineHeight", serde_json::Value::Null)
        } else {
            args.put("timelineHeight", p.timeline_height)
        };
        let env = self.op("debug_set_editor_layout", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_inspector_section",
        description = r#"Open or collapse one section of the Edit tab's clip Inspector — the same
    state the section header's own click drives (v0.3.0). Sections start
    collapsed and the user's choice is remembered per section, so a
    `debug_screenshot` or a UI-harness step that needs a control inside one
    (the Scale slider in "transform", Opacity in "compositing") opens it first.

    `id`: transform, compositing, crop, dynamic-zoom, speed, fade, keyframes,
    highlights, audio, eq, project-settings, timeline-settings. An unknown id
    is refused with that list. Like a click, the choice persists.

    You do NOT need this to EDIT anything (every control has its own
    `editor_*` tool); it is for looking at and driving the app's UI.

    Returns {ok, id, open}."#
    )]
    pub async fn debug_set_inspector_section(
        &self,
        Parameters(p): Parameters<DebugSetInspectorSectionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new().set("id", p.id).set("open", p.open);
        let env = self.op("debug_set_inspector_section", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_inspector_tab",
        description = r#"Switch the Edit tab's clip Inspector between its "video", "audio",
    "speed" and "info" tabs (D-246; four since v0.3.0) — the same state the
    tab bar's own button drives.

    The Inspector splits a clip's properties: Video holds Transform,
    Compositing, Crop, Dynamic Zoom, Highlights, Fade and the whole-clip
    Keyframes actions; Audio holds Volume/Pan and the four-band EQ; Speed
    holds the retime; Info is a read-only page of the clip's media facts and
    its in / out. Only one is on screen at a time, so a `debug_screenshot` or
    a `debug_dom_tree` of the Inspector shows one of them — set the tab first
    when you are looking for a control on another.

    You do NOT need this to EDIT anything: every control on both tabs already
    has its own MCP tool (`editor_set_clip_transform`, `set_clip_audio` /
    `editor_set_clip_*`, …) that writes the timeline directly, whichever tab
    is showing. This is for looking at the app, which is what the `debug_*`
    family is for.

    The choice is sticky and per session: a clip without the chosen tab (a
    generated title has no Audio or Speed) shows its Video tab regardless,
    without forgetting the choice. An unknown name is refused with the accepted list rather than
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
        description = r#"Read what the Edit tab's preview playback ACTUALLY did: the real
    frame-to-frame intervals, as the app itself measured them.

    Use it to answer "is playback smooth?" — a question no screenshot can
    answer. Since D-454 the preview is drawn natively (a Metal layer under the
    webview) and played by a loop in Rust that is clocked by the display and
    follows the audio clock. Two CADENCE channels, and the difference between
    them is the diagnosis:
      * `paint` — NEW frames put on the glass (each frame the playback loop
        shows; each paused show). Low fps here with a healthy `raf` = the
        engine's draw (decode + composite) is too slow for the timeline's rate.
      * `raf`   — the playback loop's ticks, one per present (the display's
        refresh, ~60 fps on a 60 Hz display while playing). Near zero while
        playing = the loop is not running.

    Each returns {samples, intervalsMs, minMs, medianMs, p95Ms, maxMs, fps,
    hitches} — `hitches` counts intervals over twice the median, which is the
    "stutter" a human reports. min/median/p95/max/fps cover the whole ring
    buffer (240 samples); `intervalsMs` is just the tail. A 30 fps timeline on
    a 60 Hz display reads paint ~30, raf ~60.

    Plus one COST channel, `scrub` (D-334): the PAUSED show round trip
    (`chroma_preview_surface_show`: IPC, decode, composite, present). A
    `scrub.medianMs` in the hundreds of ms is the decoder seeking to a new
    spot, not a slow webview. To fill it, move the playhead while PAUSED
    (`editor_set_playhead`). (D-290's `fetch` / `tick` channels went with the
    webview play loop D-454 replaced: no frame crosses the IPC while playing.)

    Measure properly: `debug_frame_timing(reset=True)` to clear, then
    `editor_set_playing(True)`, wait a few seconds, `editor_set_playing(False)`,
    then read. Numbers from before a reset mix scrubbing in with playback.
    A playhead already parked on the LAST frame makes playback stop instantly
    (check `editor_get_state`'s playhead against the timeline's length).

    Args:
        limit: how many raw samples to return per channel. Default 60.
        reset: clear every buffer first (and return the now-empty report).
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
    needed). Native window chrome, menus and dialogs are invisible to it. The
    Edit tab's preview is a native surface behind the webview (D-454) and is
    composited into every recorded frame, so playback shows; the Colorist
    tab's picture is not. This is for the Edit tab. No audio is recorded.

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
    #[tool(
        name = "debug_pointer",
        description = r#"Drive the running app with REAL pointer input — move, press, release,
    click, double-click, drag along a path, wheel, pinch — the way a hand on
    the trackpad does, and get back what it hit and what the page received.

    This is for testing the INPUT HANDLING itself (hit zones, drag thresholds,
    trim handles, snapping, marquee, scrubbing). To merely put the UI into a
    state, the `debug_set_*` and `editor_*` tools are the honest route.

    HOW IT IS DELIVERED (`mode`):
      * "native" — real NSEvents delivered to the window's WKWebView through
        AppKit's own responder methods (WebKit's test-runner pattern). The page
        sees `isTrusted` events with real hit-testing, pointer capture and
        default actions. No macOS permission is needed, the real cursor does
        not move, and the window need not be in front.
      * "synthetic" — DOM events made inside the page. `isTrusted` is false
        and the browser runs none of its own behaviour for them; a handler that
        works this way can still be broken for a human.
      * "auto" (default) — native inside the app, synthetic elsewhere. The
        reply's `mode` says which ran, and `fallbackReason` why, if it fell back.

    TARGETS never need hard-coded pixels: `{"testid": "timeline-clip"}`,
    `{"selector": "[data-chroma-clip-id='c1']", "at": {"fx": 1, "dx": -3}}`
    (3 px inside the right edge), `{"nodeId": "1.0.3"}` from debug_dom_tree,
    raw `{"x": 400, "y": 300}` CSS px, or — for `to`/`path` — `{"byX": 40}`,
    40 px right of the previous point. The timeline's stable test ids are
    listed in docs/notes/ui-harness.md. A target that matches nothing, has no
    box, or lies off-screen is refused with the reason and nothing is sent.

    READ THE REPLY:
      * `targets[]` — each resolved point, the element named, and `hit`: what
        `elementFromPoint` reports there. `hitInside: false` means something
        else (an overlay) is on top and will take the press.
      * `observed` — what the page actually received: per-type `counts`,
        `trusted`/`untrusted`, and each down/up/click/key with its target.
        Zero `pointerdown`s after a click means the input never arrived.
      * `native` — how delivery went (`windowKey`, `occlusionDetection`, the
        mouse-move path, whether DOM `buttons` was made truthful).
      * `perf` (with `measure`) — frame times p50/p95/max and dropped frames
        against 16.7 ms, input-to-next-frame latency, and store commits after
        the input. `frames.samples: 0` means rAF never ran: the window is
        throttled — call debug_set_occlusion_throttling(enabled=False).
      * `watch` (with `watch`) — per-frame rects of the watched elements and
        the cursor under the pointer: whether the UI moved DURING the drag,
        not just where it ended up.

    Args:
        action: move, down, up, click, doubleClick, drag, wheel, pinch or
            html5Drag. `down` and `up` may be separate calls; the button stays
            held between. `html5Drag` is an HTML5 drag-and-drop from `target`
            to `to` (e.g. a Sources-panel clip onto the timeline): dragstart,
            dragover along the path and drop, with one real DataTransfer,
            through the page's own handlers. It is always synthetic, because
            macOS starts a native drag session only from a real mouse. The
            reply says whether the drop target accepted it (`dropAccepted`)
            and whether it dropped.
        target: where it starts (or, for click/wheel/pinch, where it happens).
        to: where a drag ends.
        path: waypoints a drag (or a move) passes through before `to`.
        button: left (default), right or middle.
        modifiers: held for the whole gesture, e.g. ["alt"], ["meta", "shift"]
            (meta = Cmd). The modifier KEYS are pressed before and released
            after, as a hand does it.
        steps: interpolated moves per path segment (drag/move, default 12),
            or events for a wheel (5) or pinch (8).
        duration_ms: how long the moves take (drag default 300).
        hold_ms: pause after pressing before moving (default 50), or how long
            a click holds the button (default 40).
        delta_x: wheel horizontal CSS px.
        delta_y: wheel vertical CSS px; negative scrolls up. With
            modifiers=["ctrl"] this is the timeline's zoom gesture.
        scale: pinch zoom factor, e.g. 1.5 in, 0.5 out (native mode only
            sends a real trackpad magnify).
        mode: auto (default), native or synthetic.
        measure: also return `perf`.
        watch: {selectors, cursor, maxFrames} to sample every frame.
        settle_ms: keep observing this long after the last event (default
            120, max 5000)."#
    )]
    pub async fn debug_pointer(
        &self,
        Parameters(p): Parameters<DebugPointerArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        // Wire keys are camelCase where the tool argument is snake_case, as for
        // `windowMs` above; `measure` is presence-signalled (sent only when true).
        let args = WireArgs::new()
            .set("action", p.action)
            .set("target", p.target)
            .put("to", p.to)
            .put("path", p.path)
            .put("button", p.button)
            .put("modifiers", p.modifiers)
            .put("steps", p.steps)
            .put("durationMs", p.duration_ms)
            .put("holdMs", p.hold_ms)
            .put("deltaX", p.delta_x)
            .put("deltaY", p.delta_y)
            .put("scale", p.scale)
            .put("mode", p.mode)
            .put_if("measure", p.measure)
            .put("watch", p.watch)
            .put("settleMs", p.settle_ms);
        let env = self
            .op_with("debug_pointer", INPUT_OP_TIMEOUT_MS, args)
            .await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_key",
        description = r#"Press real keys in the running app — shortcuts, combos, or typed text —
    delivered the same way as debug_pointer (native NSEvents into the
    WKWebView by default; see that tool for `mode`, `measure`, `watch` and
    how to read `observed`).

    Keys are DOM `KeyboardEvent.code` names, which is what the app's own
    shortcuts match on: "Space", "KeyM", "ArrowLeft", "Delete", "Backspace",
    "Enter", "Escape", "Digit1", "F5" ... A combo joins modifiers with "+":
    "meta+KeyZ" (Cmd+Z), "meta+shift+KeyZ", "alt+ArrowRight". Each entry of
    `keys` is pressed and released in turn, `gap_ms` apart.

    The reply's `focused` names the element that had focus — key events go to
    it, so a key that "does nothing" while an input field is focused is the
    app's typing guard working, not a broken shortcut.

    Args:
        keys: combos pressed one after another, e.g. ["Space"], ["meta+KeyZ"].
        text: text typed character by character (US layout), instead of keys.
        phase: press (default) = down then up; down / up = only that half,
            to hold a key across calls (e.g. hold K while tapping L).
        hold_ms: how long each key is held (default 30).
        gap_ms: pause between keys (default 50).
        mode: auto (default), native or synthetic.
        measure: also return `perf`.
        watch: {selectors, cursor, maxFrames} to sample every frame.
        settle_ms: keep observing this long after the last key (default 120)."#
    )]
    pub async fn debug_key(
        &self,
        Parameters(p): Parameters<DebugKeyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("keys", p.keys)
            .put("text", p.text)
            .put("phase", p.phase)
            .put("holdMs", p.hold_ms)
            .put("gapMs", p.gap_ms)
            .put("mode", p.mode)
            .put_if("measure", p.measure)
            .put("watch", p.watch)
            .put("settleMs", p.settle_ms);
        let env = self.op_with("debug_key", INPUT_OP_TIMEOUT_MS, args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_perf_entries",
        description = r#"Read the app's own timing marks for the Edit timeline's edit gestures
    (`performance.mark` / `performance.measure` entries named `apelles:*`), so a
    gesture's phases are exact numbers instead of a profiler's proportions
    (docs/notes/timeline-drag-perf.md).

    Marks the app writes during a trim / ripple / slide / slip / roll gesture
    (development builds of the web layer only; a production web bundle writes
    none and says so in `build`):
      * `apelles:edit:press` - the press claimed the gesture.
      * `apelles:edit:preview` (measure) - one live preview: the op applied to a
        copy plus the style writes, per pointer move.
      * `apelles:edit:commit` - the release called the op.
      * `apelles:edit:commit-rendered` (measure) - from the commit to React
        having rendered the result.
      * `apelles:edit:commit-painted` (measure) - from the commit to the frame
        after it.

    Args:
        prefix: keep only entries whose name starts with this (default
            `apelles:`).
        clear: also delete the matching entries after reading, so the next read
            holds only the next gesture.
        wait_idle_ms: before reading, wait until the page has been idle (frames
            on time, no long task) for about this long, at most five seconds;
            use it between building a fixture and measuring.
        trace_release_ms: arm the release tracer (`releaseTrace.ts`, B-374):
            from every following `apelles:edit:commit` for this many ms
            (0 disarms, at most 2000), forced layouts, timer / rAF / message /
            observer callbacks, listeners added after arming and main-thread
            gaps are written as `apelles:trace:<kind>|<label>` measures, read
            back with `prefix: "apelles:trace:"`.

    Returns {entries: [{name, entryType, startTime, duration}], build: {dev},
    idle?: {waitedMs, reached}, trace?: {armed, windowMs, unwrapped}}."#
    )]
    pub async fn debug_perf_entries(
        &self,
        Parameters(p): Parameters<DebugPerfEntriesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let mut args = WireArgs::new()
            .put("prefix", p.prefix)
            .put("waitIdleMs", p.wait_idle_ms)
            .put("traceReleaseMs", p.trace_release_ms);
        if p.clear {
            args = args.set("clear", Value::Bool(true));
        }
        let env = self.op("debug_perf_entries", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_occlusion_throttling",
        description = r#"Turn WebKit's occlusion throttling for the app window on or off.

    WebKit treats a covered window like a background tab and throttles its
    `requestAnimationFrame` to a stop. The agent driving the app is almost
    never the frontmost window, so with throttling on, playback does not tick,
    `debug_frame_timing` reads `raf.samples: 0`, frame-time measurements from
    debug_pointer/debug_key report no frames, and anything scheduled on a
    frame (an unmount, an animation) never completes. Pass `enabled=False`
    before measuring or screenshotting animated UI; pass `enabled=True` to
    restore the normal, battery-friendly behaviour afterwards.

    This is WebKit's own test-runner switch
    (`_setWindowOcclusionDetectionEnabled:`), applied to this one webview.
    It changes nothing about what is drawn — only whether a covered window
    keeps drawing.

    Args:
        enabled: True = normal (covered window throttles), False = keep
            running while covered.
        window: which window by Tauri label. Default: the focused one, else main.

    Returns {before, after, window}."#
    )]
    pub async fn debug_set_occlusion_throttling(
        &self,
        Parameters(p): Parameters<DebugSetOcclusionThrottlingArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .set("enabled", Value::Bool(p.enabled))
            .put("window", p.window);
        let env = self.op("debug_set_occlusion_throttling", args).await?;
        Ok(render::json_text(&env))
    }

    #[tool(
        name = "debug_set_webkit_layer_debug",
        description = r#"Show or hide WebKit's compositing debug overlays on the app window.

    Two switches, the ones Safari calls "Show compositing borders" and "Show
    repaint counters": a coloured border round every COMPOSITED layer (so you can
    see which elements the browser promoted to their own layer and which it
    paints into a shared one), and a repaint count in each layer's corner that
    rises every time WebKit repaints it. They answer a paint-isolation question
    ("does this clip repaint while another is dragged?") that frame times only
    hint at: take a `debug_screenshot` mid-gesture and read the counters.

    Pass only the flags you want to change; with neither it is a pure read.
    Both default to off and you should turn them off again afterwards: they
    paint on top of the page and change what a pixel probe or a screenshot sees.
    Whether `debug_screenshot` (a WKWebView snapshot) includes the overlays
    depends on how WebKit draws them; if a screenshot shows none, capture the
    window instead (`debug_record_video` frames).

    These are WebKit SPI (`-[WKPreferences _setCompositingBordersVisible:]` and
    `_setCompositingRepaintCountersVisible:`), checked with `respondsToSelector:`
    first; a WebKit without them returns an error naming the missing selector.
    Debug builds only, like every `debug_*` tool.

    Args:
        borders: True = draw layer borders, False = hide them, omitted = leave.
        repaint_counters: True = draw repaint counters, False = hide them,
            omitted = leave.
        window: which window by Tauri label. Default: the focused one, else main.

    Returns {borders: {before, after}, repaintCounters: {before, after}, window}."#
    )]
    pub async fn debug_set_webkit_layer_debug(
        &self,
        Parameters(p): Parameters<DebugSetWebkitLayerDebugArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let args = WireArgs::new()
            .put("borders", p.borders)
            .put("repaintCounters", p.repaint_counters)
            .put("window", p.window.filter(|s| !s.is_empty()));
        let env = self.op("debug_set_webkit_layer_debug", args).await?;
        Ok(render::json_text(&env))
    }
}
