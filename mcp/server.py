#!/usr/bin/env python3
"""Apelles MCP server (D-020).

Thin stdio MCP server. Every tool is a wrapper around the Apelles *control
server* — a tiny HTTP server running inside the Apelles desktop app
(`app/src-tauri/src/chroma/control.rs`). The control server forwards each op
to the app's frontend, which applies it through the SAME store actions the GUI
buttons use and renders. So an edit made here moves the app's sliders and
re-renders its canvas; `get_state` reflects the user's manual edits too.

There is no grade/mask logic here and none in the control server — it all lives
in one place, the frontend store. Adding a capability = one entry in the
frontend `OPS` registry + one tool here.

The one exception is the `debug_*` pair (D-210): those ops are answered by the
control server itself, in Rust, with no frontend round trip — a screenshot is a
picture of the webview, not a fact about the store, and the moment it is most
worth having is when the frontend is too wedged to answer.

Requires: the Apelles app running (the control server binds on start).
Base URL: http://127.0.0.1:${CHROMA_CONTROL_PORT:-19788}
"""

from __future__ import annotations

import builtins  # this module defines a tool named `open`, shadowing the builtin
import json
import os
from typing import Any

import httpx
from mcp.server.mcpserver import Image, MCPServer
from mcp.types import TextContent

# D-310 — real Pydantic models for every structured (nested-object) parameter, so each
# tool publishes a typed `inputSchema` instead of a bare `{"type": "object"}`. `to_wire`
# turns a validated model back into the exact dict the caller sent; see schemas.py.
from schemas import (
    ActiveScheduleEntry,
    Camera2DKey,
    Camera3DKey,
    ClipKeyframe,
    ClipSelector,
    ColorWheelChannel,
    CurvePoint,
    CurveSpec,
    DynamicZoomFraming,
    EaseCurve,
    ExportRenderer,
    FitMode,
    GapSelector,
    LayerTransformKey,
    MaskGeometry,
    MotionKeyTarget,
    MotionSelection,
    MotionTarget,
    Roi,
    SpeedRampPoint,
    to_wire,
)

PORT = os.environ.get("CHROMA_CONTROL_PORT", "19788")
BASE_URL = f"http://127.0.0.1:{PORT}"

SCOPE_DISCIPLINE = (
    "Grade by the numbers. Call `inspect_color` before and after a change and "
    "reason from the scope values (black/white points, per-zone means, warm-cool "
    "and green-magenta cast, clip %, hue histogram) or a named full-res region "
    "from `sample` / `sample_region`. Never claim a result ('looks balanced', "
    "'skin is natural', 'the cast is gone') without citing a scope value or a "
    "sampled region. Approach each result adversarially: assume the grade is "
    "still flawed and hunt for the cast, clipping, or crushed detail you have "
    "not ruled out. Defer genuinely creative calls to the human."
)

mcp = MCPServer(
    "apelles",
    instructions=(
        "Drive the running Apelles color-grading app. Edits move the app's real "
        "UI and re-render its canvas; reads reflect the user's manual edits. "
        "The Apelles desktop app must be open. Call get_state first to see the "
        "current image/video, adjustments and masks.\n\n"
        + SCOPE_DISCIPLINE
        + "\n\nMutating tools return the rendered frame, its histogram, and the "
        "compact scope summary (the new measurement, for free) after the change."
        + "\n\nThe Edit tab (multi-track NLE: import/place/trim/composite/export, "
        "`editor_*`-prefixed tools) is a separate surface from grading above. "
        "Call `editor_get_capabilities` once before your first "
        "`editor_set_clip_transform`/`editor_set_clip_keyframes`/`editor_export` "
        "in a session — it is static reference data (no app round trip) covering "
        "non-obvious compositing rules and known rough edges an agent would "
        "otherwise only find by reading source or hitting them live."
        + "\n\nThe Motion tab (`motion_*`-prefixed tools, D-257) is the third "
        "surface: a scene-based motion-graphics builder — scenes, layers built "
        "from a primitive catalog, per-layer keyframes with real bezier easing, "
        "2D/3D cameras, and a Remotion render to one video file PER SCENE. Its "
        "single source of truth is the scene manifest, the way `grade.json` is "
        "for grading. Call `motion_get_state` first (what is open, what is "
        "selected, one row per scene) and `motion_list_primitives` once before "
        "your first `motion_add_layer` — that one is static reference data "
        "listing every primitive and the fields each accepts. Note that times "
        "in Motion are SECONDS within a scene, not absolute frames."
    ),
)


# How long the app's frontend is given to apply + render + reply, per op
# (B-153). The control server's own default is 20s, which is right for the
# ops that are a store write plus a render — and wrong for the handful that
# run a real model. `_op` sends the budget because THIS layer is the one that
# knows which tool is which; `control.rs` has no op list by design.
DEFAULT_OP_TIMEOUT_MS = 20_000
#: SAM 2 + ViTMatte over a full 4K frame through the AI sidecar. Measured in
#: tens of seconds on a cold model, which is exactly how a *successful*
#: `add_subject_mask` came back to the caller as a bare tool error (B-153).
AI_MASK_TIMEOUT_MS = 180_000

# D-318's recut detectors used to have a 180_000 budget here, on the reasoning
# that a cold decode of a long 4K source is not 20s-fast. B-188 proved that far
# too optimistic — a real 16.5-minute 4K file took 244s and blew it anyway — and
# D-321 fixed the cause (an O(n^2) resample, now 4.9s) AND made both detectors
# START-then-POLL, so they answer within a 12s grace window or hand back a
# pollable `state: "running"`. Neither can block for minutes any more, so both
# are back on `DEFAULT_OP_TIMEOUT_MS` and the special budget is gone.
#: B-071 — extra client-side slack covering the control server's own cold-start
#: readiness wait (`control.rs`'s `BRIDGE_READY_TIMEOUT`), which sits on TOP of
#: the per-op budget below rather than eating into it. The two are a pair: if
#: this is smaller, a real cold start comes back as a bare httpx read timeout
#: instead of the server's own "still starting up, nothing was applied" answer,
#: which is the whole point of having that answer.
READY_GRACE_S = 30.0


def _op(op: str, timeout_ms: int = DEFAULT_OP_TIMEOUT_MS, **args: Any) -> dict:
    """POST one op to the control server, return the parsed JSON envelope.

    `timeout_ms` is how long the app's frontend gets to answer; the control
    server clamps it. A tool that drives a model rather than a slider must pass
    its own (see `AI_MASK_TIMEOUT_MS`). It is a transport concern, not an op
    argument — it rides beside `args`, never inside it, so no frontend op may
    take a parameter of this name.
    """
    try:
        r = httpx.post(
            f"{BASE_URL}/op",
            json={"op": op, "args": args, "timeout_ms": timeout_ms},
            # Always outlive the app-side budget, so a real frontend timeout
            # comes back as the control server's own explanatory 504 envelope
            # rather than as an httpx read timeout with nothing in it.
            # `READY_GRACE_S` covers the readiness wait the server may add on
            # top of that budget on a cold start (B-071).
            timeout=timeout_ms / 1000 + READY_GRACE_S + 15.0,
        )
    except httpx.ConnectError as e:
        raise RuntimeError(
            f"Cannot reach the Apelles control server at {BASE_URL}. "
            "Is the Apelles desktop app running?"
        ) from e
    if r.status_code == 503:
        # B-071: the app is up but its frontend has not finished subscribing —
        # nothing was emitted, so nothing can have half-run. Returned as a normal
        # `{ok: false, error}` envelope for the same reason 504 is below: the
        # reason is the useful part, and raising here would hand the caller a
        # bare "Error executing tool <name>" with the explanation thrown away —
        # which is exactly how this bug presented in the first place.
        return r.json()
    if r.status_code == 504:
        # B-153: NOT an exception. The control server's own contract is that a
        # failure is a normal `{ok, error}` answer with a reason in it — the
        # client reads `ok`/`error`, not the status code — and raising here
        # broke that for the one case where the detail matters most: the
        # frontend keeps working after the timeout, so the op may well have
        # SUCCEEDED. Raising also meant FastMCP masked the reason entirely and
        # the caller saw a bare "Error executing tool <name>".
        return r.json()
    r.raise_for_status()
    return r.json()


def _result(env: dict) -> list:
    """Turn a control-server envelope into MCP content: rendered frame + JSON."""
    out: list = []
    img = env.get("image_b64")
    if img:
        import base64

        out.append(Image(data=base64.b64decode(img), format="jpeg").to_image_content())
    summary = {
        "ok": env.get("ok"),
        "error": env.get("error"),
        "result": env.get("result"),
        "frame": env.get("frame"),
        "scopes": env.get("scopes"),
        "histogram": env.get("histogram"),
        "adjustments": env.get("adjustments"),
    }
    import json

    out.append(TextContent(type="text", text=json.dumps(summary, indent=2, default=str)))
    return out


def _data_url_to_png_bytes(data_url: str | None) -> bytes | None:
    if not data_url or not data_url.startswith("data:"):
        return None
    import base64

    return base64.b64decode(data_url.split(",", 1)[1])


def _inspect_result(env: dict) -> list:
    """inspect_color envelope -> readable scope JSON + parade & vectorscope images."""
    import base64
    import json

    if not env.get("ok"):
        return [TextContent(type="text", text=json.dumps(env, indent=2, default=str))]

    res = env.get("result") or {}
    out: list = []
    for key in ("parade", "vectorscope"):
        raw = _data_url_to_png_bytes(res.get(key))
        if raw:
            out.append(Image(data=raw, format="png").to_image_content())

    readable = {
        "scopes": res.get("scopes"),
        "histogram": res.get("histogram"),
        "frameSize": res.get("frameSize"),
    }
    if res.get("reference"):
        readable["reference"] = res["reference"]
    if res.get("gap"):
        readable["gap"] = res["gap"]
        reading = res["gap"].get("reading")
        if reading:
            readable["reading"] = reading
    out.append(TextContent(type="text", text=json.dumps(readable, indent=2, default=str)))
    return out


# --------------------------------------------------------------------------- #
# read
# --------------------------------------------------------------------------- #
@mcp.tool()
def open(path: str) -> str:
    """Load a still or video into the editor by ABSOLUTE path — the headless
    equivalent of picking it in the library. Returns {path, ready, size, video}.
    Follow with get_state / inspect_color."""
    return json.dumps(_op("open", path=path), indent=2, default=str)


@mcp.tool()
def get_state() -> str:
    """Full current state: the loaded image/video, primary adjustments, and a
    summary of every mask (ids, types, per-mask adjustments). Reflects the
    user's manual edits in the app. Call this before editing."""
    import json

    return json.dumps(_op("get_state"), indent=2, default=str)


@mcp.tool()
def get_grade() -> str:
    """The full grade.json document — the git-committable grade ("the grade is
    code", D-025). A versioned wrapper: {schema: "chroma.grade/1", shot: {source,
    width, height, fps, frameCount, colorSpace, reference}, adjustments: {...the
    live RapidRAW grade + masks...}, notes}. Reflects the user's manual edits.
    Use `save_grade` to write it to disk, `load_grade` to apply one."""
    import json

    return json.dumps(_op("get_grade"), indent=2, default=str)


@mcp.tool()
def save_grade(path: str | None = None) -> str:
    """Write the current grade to a grade.json file on disk. Omit `path` to save
    beside the source clip as <name>.grade.json.

    Static mask mattes are externalised to a sibling <name>.mattes/ folder (the
    JSON keeps a {"$matte": ...} reference), and a tracked-matte folder is
    referenced, not copied — so moving the project needs its .chroma/mattes/ dir
    too. The result is small and diff-able: commit grade.json + its .mattes/ dir
    to the project repo. A one-knob change is a one-line diff.

    Returns {path, matteFiles, trackDirs}. It is a local file the user asked for
    — no confirm-before-write; the resolved path is always returned."""
    import json

    args = {"path": path} if path else {}
    env = _op("save_grade", **args)
    res = env.get("result") or {}
    return json.dumps(
        {"ok": env.get("ok"), "error": env.get("error"), **res}, indent=2, default=str
    )


@mcp.tool()
def load_grade(path: str) -> list:
    """Apply a grade.json (ABSOLUTE path) — externalised mattes are inlined and a
    tracked-matte folder is resolved. Runs a schema migration; a grade.json from
    a newer major version is rejected with a clear error.

    v1 does NOT auto-switch clips: if the doc's `shot.source` differs from the
    open clip you get a `sourceMismatch` warning in the result — open the right
    clip first (`open`) for the grade to land on the intended footage.

    Returns the rendered frame + scopes + {applied, shot, sourceMismatch}."""
    return _result(_op("load_grade", path=path))


@mcp.tool()
def list_masks() -> str:
    """Every mask container and its sub-masks: ids, type, mode, visible/invert,
    per-mask adjustments, and whether a sub-mask is tracked across the clip."""
    import json

    return json.dumps(_op("list_masks"), indent=2, default=str)


# --------------------------------------------------------------------------- #
# primary grade
# --------------------------------------------------------------------------- #
@mcp.tool()
def set_primary(
    exposure: float | None = None,
    contrast: float | None = None,
    highlights: float | None = None,
    shadows: float | None = None,
    whites: float | None = None,
    blacks: float | None = None,
    temperature: float | None = None,
    tint: float | None = None,
    saturation: float | None = None,
    vibrance: float | None = None,
    dehaze: float | None = None,
    clarity: float | None = None,
    structure: float | None = None,
    sharpness: float | None = None,
    vignetteAmount: float | None = None,
) -> list:
    """Set primary (whole-image) grade knobs. Only the args you pass change;
    the rest are left as-is. Ranges roughly match the app's sliders
    (exposure ~ -5..5 stops, most others -100..100). Returns the rendered frame
    plus the new scope summary. Grade by the numbers: call `inspect_color` before
    and after and reason from the scope values, not the thumbnail. Never claim a
    result without citing a scope value or a sampled region."""
    patch = {k: v for k, v in locals().items() if v is not None}
    return _result(_op("set_primary", patch=patch))


@mcp.tool()
def set_curve(channel: str, points: list[CurvePoint]) -> list:
    """Replace a tone-curve channel. channel is one of luma|red|green|blue.
    points is an ordered list of {x, y} in 0..255 (both axes), e.g.
    [{"x":0,"y":0},{"x":128,"y":140},{"x":255,"y":255}].
    Grade by the numbers: verify the move on `inspect_color` (parade / black-white
    points / per-zone means), not the thumbnail."""
    return _result(_op("set_curve", channel=channel, points=to_wire(points)))


@mcp.tool()
def set_color_grade(
    shadows: ColorWheelChannel | None = None,
    midtones: ColorWheelChannel | None = None,
    highlights: ColorWheelChannel | None = None,
    global_: ColorWheelChannel | None = None,
    blending: float | None = None,
    balance: float | None = None,
) -> list:
    """Color-grading wheels. shadows/midtones/highlights/global_ are each
    {hue, saturation, luminance} (hue 0..360, sat/lum ~ -100..100); pass only
    the wheel(s) you want to move. blending and balance are 0..100 / -100..100.
    Grade by the numbers: check the per-zone means and the cast on `inspect_color`
    before and after; don't judge the wheels from the thumbnail."""
    patch: dict = {}
    for name, val in (
        ("shadows", shadows),
        ("midtones", midtones),
        ("highlights", highlights),
        ("global", global_),
    ):
        if val is not None:
            patch[name] = to_wire(val)
    if blending is not None:
        patch["blending"] = blending
    if balance is not None:
        patch["balance"] = balance
    return _result(_op("set_color_grade", patch=patch))


# --------------------------------------------------------------------------- #
# transport
# --------------------------------------------------------------------------- #
@mcp.tool()
def seek(frame: int) -> list:
    """Move the video playhead to `frame` and re-render it with the current
    grade. No-op if the loaded item is a still.

    **`frame` is CLIP-LOCAL (D-294).** 0 is the active clip's own in-point on
    the Edit timeline, not frame 0 of the source file, and the last valid frame
    is `get_state().shot.frameCount - 1` — the CLIP's length, not the file's.
    The picture you get back also carries that clip's real transform (crop,
    scale, rotation, position), so what you measure with `inspect_color` /
    `sample` is what the Edit preview and the export actually show. A loose clip
    opened outside a project (an "Untitled" session) has no clip, so there
    `frame` is just the source frame, as before."""
    return _result(_op("seek", frame=frame))


# --------------------------------------------------------------------------- #
# Edit tab — timeline read + clip fades (D-147) + track ducking (D-149)
#
# The first Edit-tab tools on this surface; everything above is Colorist.
# `get_timeline` exists because `set_clip_fade(track, clip, ...)` is unusable
# without a way to learn a track/clip index — it is scoped to that need, not an
# attempt to close the whole Edit-tab MCP gap (D-183 below is that attempt).
#
# D-183 moved the frontend handlers for these three ops out of
# `useChromaControl.ts` (Colorist's own catch-all) into `@apelles/editor`'s own
# `useEditorControl.ts`, renamed `editor_get_timeline` / `editor_set_clip_fade`
# / `editor_set_track_duck` — every Edit-tab op now lives under that one
# prefix, `docs/notes/mcp-architecture.md`'s "every tab owns its own ops"
# rule. Same tool NAMES here (`get_timeline` etc. — no reason to break callers
# of this MCP surface over an internal rename), just the `_op(...)` wire name
# each posts to the control server changed to match.
# --------------------------------------------------------------------------- #
@mcp.tool()
def get_timeline() -> str:
    """The active edit timeline: every track and every clip on it, with the
    indices the mutating Edit-tab tools address clips by.

    Returns {id, name, durationFrames, tracks: [{index, kind: "video"|"audio",
    gain, locked, hidden, duckFrom, duckDb, duckAttackMs, duckReleaseMs,
    clips: [{index, id, name, sourcePath, startFrame, duration, sourceStart,
    sourceLen, sourceFps, linkGroup, fadeInFrames, fadeOutFrames, fadeInCurve,
    fadeOutCurve, fadeInCurveName, fadeOutCurveName, volume, pan, eqBands,
    eqActive}]}]}.

    `volume`/`pan` (D-223) are the CLIP's own level and stereo position, which
    MULTIPLY with the track's own `gain` rather than replacing it — see
    editor_set_clip_audio.

    `eqBands` (D-224) is that clip's own parametric EQ, `[]` when it has none;
    `eqActive` says whether ANY of those bands actually changes the sound. Read
    it: a four-band strip whose gains are all 0 dB is completely inert, and
    `eqBands` being non-empty is NOT the same as the clip being filtered. See
    editor_set_clip_eq.

    All positions and durations are in FRAMES, not seconds — the unit every
    Edit-tab number is in. `index` is what set_clip_fade and set_track_duck
    address; `id` is the stable identity that survives a reorder, for re-finding
    a clip after an edit. `duckFrom` is null on a track that is not ducked.

    B-077 — `startFrame` (and `durationFrames`) are TIMELINE frames (this
    timeline's own rate); `duration`/`sourceStart`/`sourceLen` are a CLIP'S
    OWN native frames, which only match the timeline's rate when `sourceFps`
    equals it. A clip's real length in seconds is `duration / (sourceFps or
    the timeline's own rate)`, NOT `duration / durationFrames`'s implied rate
    — dividing a clip's native frame count by the wrong rate is exactly the
    bug that once showed a 47.86s clip as 88s. `sourceFps` is null for a clip
    probed before this field existed, or genuinely same-rate as the timeline.

    Read-only, cheap, no side effects."""
    import json

    return json.dumps(_op("editor_get_timeline"), indent=2, default=str)


@mcp.tool()
def set_clip_fade(
    track: int,
    clip: int,
    fade_in_frames: int | None = None,
    fade_out_frames: int | None = None,
    fade_in_curve: CurveSpec | None = None,
    fade_out_curve: CurveSpec | None = None,
) -> str:
    """Set a clip's fade in / fade out. `track` and `clip` are the 0-based
    indices from get_timeline.

    Durations are in FRAMES (not seconds, not percent). Negative or fractional
    values are floored to whole frames >= 0; the returned values are what was
    actually stored, so check them rather than assuming. A fade LONGER than the
    clip is allowed and is deliberately not clamped: the two windows then
    overlap and their multipliers multiply, so a clip fully fading in and out
    sits at 0.25 in the middle. Omitting a duration leaves that one as it is.

    A curve is either a preset NAME -- exactly "linear" | "ease-in" |
    "ease-out" | "ease-in-out", no others (B-165: CSS's own "ease" is NOT one
    of them and is rejected, not silently substituted) -- or four cubic-bezier
    control points [x1, y1, x2, y2], the same model CSS cubic-bezier() and
    After Effects keyframe easing use (P0=(0,0) and P3=(1,1) implicit; x is
    progress through the fade window, y the multiplier at that progress). An
    unknown preset name is rejected, not silently substituted. Curves always come back
    as four control points plus the matching preset name if there is one, so a
    curve read and written back is exactly what was read.

    Two real properties to set this with, rather than guess at:

    1. A fade on a VIDEO clip fades its picture (opacity) AND its own embedded
       audio (gain) together -- one handle, as Premiere's and Resolve's fade
       handle does. To fade them differently, unlink the clip's audio; it
       becomes its own clip with its own fade. A clip on an audio track fades
       gain only.
    2. The curve is a straight multiplier on amplitude / alpha, NOT a
       perceptual one. Perceived loudness is roughly logarithmic in amplitude,
       so a perceptually even AUDIO fade-in is nearer "ease-in" than "linear"
       ("linear" is the exact straight ramp, and is the default). Picture has
       no equivalent skew. Pick with that stated rather than assuming one curve
       suits both.

    Undoable: this goes through the same store action and the same undo stack
    the GUI's own Inspector writes to, so a human can Cmd+Z it."""
    import json

    args: dict = {"track": track, "clip": clip}
    if fade_in_frames is not None:
        args["fade_in_frames"] = fade_in_frames
    if fade_out_frames is not None:
        args["fade_out_frames"] = fade_out_frames
    if fade_in_curve is not None:
        args["fade_in_curve"] = to_wire(fade_in_curve)
    if fade_out_curve is not None:
        args["fade_out_curve"] = to_wire(fade_out_curve)
    return json.dumps(_op("editor_set_clip_fade", **args), indent=2, default=str)


@mcp.tool()
def set_clip_speed(
    track: int,
    clip: int,
    speed: float | None = None,
    points: list[SpeedRampPoint] | None = None,
) -> str:
    """Retime a clip -- a flat speed change, or a real SPEED RAMP that varies
    over the clip (D-236). `track` and `clip` are the 0-based indices from
    get_timeline.

    Pass exactly one of:

    * `speed` -- one multiplier for the whole clip. `2.0` plays it twice as
      fast in half the timeline space, `0.5` half as fast in twice the space,
      `1.0` clears any ramp back to normal. NEGATIVE plays it BACKWARDS at that
      rate: `-1.0` is the plain "reverse this clip", `-2.0` is backwards at
      double speed. Magnitude 0.05-20, either sign; a value outside that is
      REFUSED, not clamped, so a typo cannot silently retime to something else.
      `0` is refused too -- that is not slow, it is a clip that never advances.
    * `points` -- a ramp, as a list of `{"source_frame": int, "speed": float}`.
      Each point means "from this SOURCE frame onward, play at this speed", so
      the clip becomes a run of constant-speed segments. Source frames are
      absolute in the file (the same space as a clip's `source_start` and a
      keyframe's `frame`), NOT clip-relative and NOT timeline frames -- which
      is what makes a ramp survive a later trim: the speed stays on the moment
      in the footage you put it on. Points are sorted on the way in and only
      ONE is kept per source frame (last wins), so the stored list may be
      shorter than what you sent. A point that merely restates the speed
      already in force is deliberately KEPT, not tidied away -- it is a real
      split you can then give its own speed, which is the normal authoring
      order. `[]` clears the ramp.

    Five things worth knowing before you use it:

    1. **A flat speed IS a one-segment ramp.** `speed=2` and
       `points=[{"source_frame": <in-point>, "speed": 2}]` are the same edit and
       store identically. There is no separate flat mechanism to keep in step.
    2. **It changes the clip's LENGTH on the timeline, not its start.** A
       retimed clip still begins at its own `start_frame`; the clips after it
       do NOT move, so speeding a clip up opens a gap and slowing it down
       overlaps its neighbour. Close it yourself (editor_remove_gap, or
       editor_move_clip). This matches Resolve with ripple off.
    3. **Picture and sound are retimed together.** In the EXPORT the audio
       pitch is preserved (an `atempo` chain per segment); in the live PREVIEW
       it is not -- the mixer varispeeds, so a sped-up clip previews
       chipmunked and a reversed one previews backwards, like tape (D-242).
       Timing matches either way, which is the thing you are editing to.
       A clip's own fades, volume and pan automation follow the retime too --
       a key stays on the source moment you authored it against, and a fade is
       measured in PLAYBACK order, so a reversed clip's fade-in is still at the
       start of what the viewer sees.
    4. **The preview and the export agree frame for frame.** Both read the same
       remap; `editor_get_state` and the exported file will show the same
       source frame at the same timeline position.
    5. **Reverse is per RUN, not per clip** (D-241). A ramp may mix forward and
       reversed segments -- `[{0, 1.0}, {48, -2.0}, {96, 1.0}]` plays forwards,
       then whips backwards at 2x, then forwards again. Reversing does not
       change how long a run occupies: `-2.0` and `2.0` take exactly the same
       timeline space, so flipping a sign never moves the clip's out-point.
       Reverse costs REAL MEMORY at export (ffmpeg buffers the reversed run's
       frames), bounded to that run rather than the whole source file.
    6. **Smoothed S-curve speed transitions are still not supported** -- a
       speed change is a step. A gradual ramp can be approximated by adding
       more points.

    Returns the stored points, the RESOLVED segments (which is what actually
    plays -- after a trim, some of your points may no longer bite), and the
    clip's source vs. output length in frames.

    Undoable: this goes through the same store action and the same undo stack
    the GUI's own Inspector Speed section writes to, so a human can Cmd+Z it."""
    import json

    args: dict = {"track": track, "clip": clip}
    if speed is not None:
        args["speed"] = speed
    if points is not None:
        args["points"] = to_wire(points)
    return json.dumps(_op("editor_set_clip_speed", **args), indent=2, default=str)


@mcp.tool()
def set_track_duck(
    track: int,
    duck_from: int | None = None,
    duck_db: float | None = None,
    attack_ms: float | None = None,
    release_ms: float | None = None,
) -> str:
    """Duck one track under another: lower `track` whenever the track named by
    `duck_from` has a clip playing. The music-under-dialogue move. `track` and
    `duck_from` are the 0-based track indices from get_timeline.

    `duck_from=None` turns ducking OFF for this track. A track cannot duck from
    itself, and an index that is not a real track is rejected rather than stored
    — both would be silently ignored by the mixer, which would look like the
    tool worked and the feature didn't.

    THE THREE NUMBERS, which are real DSP parameters and not a "strength" dial:

    - `duck_db` -- how far down, in DECIBELS, while the trigger track sounds.
      -12 is the usual dialogue-over-music amount; -6 is gentle, -18 is heavy.
      0 dB is unity, i.e. no duck at all. (Note this is dB while `gain` on the
      same track is a LINEAR multiplier -- a fader level is naturally linear, a
      duck amount is the number editors actually state in dB.)
    - `attack_ms` -- how fast the duck engages, as a one-pole TIME CONSTANT:
      the time to cover 63.2% of the way down. Default 10 ms. Short, so the
      duck is already down before the first syllable is audible; long enough
      and the first word rides over the bed.
    - `release_ms` -- how fast the gain comes back, same definition. Default
      300 ms. Deliberately much slower than the attack: a fast release makes
      the bed pump audibly between words. 300-500 ms is the usual range.

    Two properties worth setting this with rather than guessing at:

    1. The trigger is the trigger track's CLIP LAYOUT, not its loudness. A pause
       mid-sentence does NOT let the bed back up -- only a real gap between
       clips does, and two clips butted end to start read as one continuous
       stretch. If you want the bed rising in every breath, cut the dialogue
       track into the phrases you want.
    2. Ducking is a TRACK relationship, so it applies to every clip on the
       track, for the whole timeline -- there is no per-clip duck.

    Undoable: this goes through the same store action and the same undo stack
    the GUI's own track header writes to, so a human can Cmd+Z it.

    Returns what was actually STORED (the values are normalised on the way in --
    a negative time constant becomes 0), so read the response rather than
    assuming the request landed verbatim."""
    import json

    args: dict = {"track": track, "duck_from": duck_from}
    if duck_db is not None:
        args["duck_db"] = duck_db
    if attack_ms is not None:
        args["attack_ms"] = attack_ms
    if release_ms is not None:
        args["release_ms"] = release_ms
    return json.dumps(_op("editor_set_track_duck", **args), indent=2, default=str)


# --------------------------------------------------------------------------- #
# Edit tab, continued (D-183) — closing the whole Edit-tab MCP gap that
# D-147/D-149 above deliberately left open. Every tool below wraps one
# `editor_*` op in `@apelles/editor`'s `useEditorControl.ts` — read that file's
# own `OPS` map for the authoritative behavior; these are thin wrappers, same
# shape as `get_timeline`/`set_clip_fade`/`set_track_duck` above.
#
# `editor_get_capabilities` (D-191) is the one exception: it is pure static
# documentation, answered entirely in this process with NO round trip to
# `chroma::control` — deliberately, so it works even with no project open and
# no Apelles window running at all. See docs/08-decisions.md's D-191 entry
# (and D-184's own closing note, which flagged this as a separate, parallel
# effort) for why this exists: D-183's own first live use surfaced real,
# hard-won facts (the `scale`/aspect-ratio gap fixed by D-184/B-074, plus
# B-069/B-070/B-071/B-073's rough edges) that no docstring said, discoverable
# only by reading source or hitting them live.
# --------------------------------------------------------------------------- #
EDITOR_CAPABILITIES: dict[str, Any] = {
    "read_before_calling": [
        "editor_set_clip_transform",
        "editor_set_clip_keyframes",
        "editor_export",
    ],
    "compositing": {
        "scale": (
            "`scale` on editor_set_clip_transform/editor_export is a stacking / "
            "picture-in-picture primitive, NOT a 'fill this exact box' primitive. "
            "`overlay_width = the clip's OWN NATIVE footprint in the composition "
            "* scale`, in BOTH engines — so `scale = 1.0` means 'this clip at its "
            "own size in the composition', NOT 'fill the frame': a 1280x720 "
            "source in a 1920x1080 composition is two thirds of the frame wide at "
            "`scale = 1.0`. D-353 (fixes B-208, 2026-09-18) made the EXPORT agree "
            "with that. It used to read `scale` as a plain fraction of the output "
            "canvas (`overlay_width = canvas_width * scale`), which is the same "
            "number only when a clip's source resolution matches the project "
            "composition — the usual case, but never a rule — so a clip cut from "
            "a differently-sized source exported at a different size than the "
            "preview had shown. The direction was chosen deliberately: making the "
            "PREVIEW read a canvas fraction instead would have silently resized "
            "every clip in every existing project carrying a non-default `scale`, "
            "on open. An export whose sources are all the composition's own size "
            "is unchanged, byte for byte. `box_width`/`box_height` are canvas "
            "fractions in BOTH engines and remain the most direct way to state an "
            "exact box (D-346 closed the one case where that was false — see "
            "B-223). The overlay's HEIGHT is the interesting part: in the live "
            "preview (Rust `composite_layer_onto`, D-136, "
            "app/src-tauri/src/chroma/edit.rs) it is the overlay's WIDTH times "
            "the clip's own POST-CROP aspect ratio, which is exactly what the "
            "export's default `'fit'` asks ffmpeg for (`h='-2'`), so the two "
            "agree. D-346 (fixes B-218/B-223, 2026-09-18) made that true: it used "
            "to be the clip's fit-to-canvas footprint's height times `scale`, "
            "i.e. the UNCROPPED aspect ratio — the same number only for an "
            "uncropped clip that sets neither `box_width` nor `box_height`, which "
            "is every clip in every project before that date and why nothing had "
            "diverged. The preview still has no 'stretch' concept at all; it "
            "always behaves as `'fit'`. In export (`timelineExport.ts`'s "
            "`buildClipFilterChain`) it depends on `editor_export`'s "
            "`fit_overrides` (D-184, fixing B-074): the default, `'fit'`, lets "
            "ffmpeg auto-compute height from the clip's own real post-crop aspect "
            "ratio (undistorted, but will not exactly fill an arbitrary target "
            "box); the explicit opt-in `'stretch'` forces the height from `scale` "
            "the same native-footprint way (`native_height_in_composition * "
            "scale`), so the box keeps the UNCROPPED source's shape whatever the "
            "crop did to the real picture — correct only for a genuine "
            "same-aspect PIP bubble or a deliberate distort effect. (D-353 "
            "changed `'stretch'` too, for the same reason: `scale` has to mean "
            "ONE thing, so both modes read it as a native-footprint multiple and "
            "`fit_overrides` decides only where the HEIGHT comes from. For a "
            "source the same shape as the canvas — `'stretch'`'s own main use — "
            "the box is still canvas-shaped, exactly as before.) Before D-184, "
            "export had no 'fit' option at all — every overlay was forced to the "
            "canvas's aspect ratio unconditionally, which is what made a "
            "full-width/half-height stacked layout mathematically impossible for "
            "any canvas. Read `editor_export`'s own docstring for the complete "
            "`fit_overrides` contract before compositing more than one clip onto "
            "a canvas."
        ),
        "full_width_half_height_recipe": (
            "To land a clip in exactly one half of a stacked comparison layout "
            "(e.g. the top half of a 9:16 canvas) with `fit_overrides` left at "
            "its default `'fit'`, `scale` alone will NOT give you an exact "
            "half-height box — the height follows the clip's own cropped aspect "
            "ratio, not the canvas's. Recipe: get the clip's native width/height "
            "from editor_import_media's probe result; choose crop_top/crop_bottom "
            "(or crop_left/crop_right) so the CROPPED frame's aspect ratio equals "
            "the target box's aspect ratio (target_w / target_h); THEN set scale "
            "so target_w == the clip's own native width in composition pixels * "
            "scale — i.e. `scale = target_w / native_width`, NOT `target_w / "
            "canvas_width` (D-353/B-208; for a source at the composition's own "
            "size those are the same number, which is why the old wording worked "
            "for every same-size project). crop is applied before scale. "
            "position_y places the resulting box's top-left corner as a fraction "
            "of the canvas — in the LIVE PREVIEW too, since D-338/B-201 — and it "
            "does not center or clamp the box into a slot for you, and ffmpeg "
            "rounds the computed height to the nearest even pixel, so treat it as "
            "approximate when computing an offset against it."
        ),
        "position_and_crop_units": (
            "position_x / position_y name the overlay box's TOP-LEFT CORNER "
            "as fractions of the OUTPUT canvas (0..1; 0,0 = the canvas's "
            "top-left corner, and 0.5,0.5 puts the box's top-left corner at "
            "the canvas centre) — not pixels, not fractions of the clip's own "
            "source resolution, and NOT an offset from the canvas centre. "
            "crop_left/top/right/bottom are fractions (0..1) of the CLIP "
            "trimmed off each edge, applied before scale. D-338 (fixes B-201, "
            "2026-09-16) made this true of the LIVE PREVIEW as well as the "
            "export: before it the Rust compositor centred a layer and read "
            "position_x/position_y as an offset from that centre, so a "
            "non-full-frame overlay checked in the preview landed "
            "(1 - box_fraction)/2 of the canvas away in the exported file, on "
            "each axis, silently. Existing projects needed no migration (the "
            "two readings coincide exactly at full frame, which is where "
            "every stored clip sat), but distrust any non-full-frame "
            "placement worked out against the old behaviour. One consequence "
            "to plan around: because position_* is the top-left corner, "
            "raising `scale` alone grows the box DOWN and to the RIGHT in "
            "both engines — to zoom about a box's own centre, move "
            "position_x/position_y by half the size change yourself. "
            "CROP-THEN-SCALE is true of the live preview as well, since D-346 "
            "(fixes B-218, 2026-09-18): it resizes the crop's SUB-IMAGE into "
            "the placement box, so the kept picture FILLS the box and the "
            "box's height follows the cropped aspect ratio — the same picture "
            "the export has always produced. Until that date the preview "
            "applied the crop as an alpha mask over the already-scaled full "
            "frame, so a cropped clip covered only the crop's own fraction of "
            "its box there; distrust any crop+scale placement worked out "
            "against a preview older than that, and note that B-218's own "
            "recorded 'workaround' (`scale: 1.0` plus a compensating "
            "`position_x`) was preview-only and exports completely "
            "differently."
        ),
        "corner_radius": (
            "corner_radius (D-344) rounds a clip's placement box, and is the "
            "one geometry field measured in OUTPUT-CANVAS PIXELS rather than "
            "as a fraction of it — a human means '16 px of round', and does "
            "not want that rescaled when the box moves or resizes, which is "
            "the same unit every reference uses (CSS border-radius, Premiere's "
            "Rounded Corners, Resolve's Rounded Corner). 0 (the default, and "
            "every pre-D-344 clip) is square corners and renders "
            "byte-identically to a build without the feature in BOTH engines — "
            "neither emits any masking work for it. Applied AFTER crop and "
            "scale and BEFORE rotation, so a rotated clip's rounded corners "
            "rotate with it; it MULTIPLIES the existing alpha rather than "
            "replacing it, so it composes with crop, opacity, fades and "
            "dissolves rather than overriding any of them. A radius larger "
            "than half the box's shorter side clamps to that — a pill, or a "
            "circle on a square box — rather than degenerating. Keyframeable "
            "under the same name via editor_set_clip_keyframes (the exporter's "
            "mask is re-evaluated per frame, so an animated radius is a "
            "picture both engines can genuinely produce — unlike a title's "
            "scale, see text_title_clips). It does NOT apply to a text/title "
            "clip or an adjustment clip and editor_set_clip_transform refuses "
            "a non-default value for one rather than storing something that "
            "renders nothing. The live preview and the ffmpeg export agree to "
            "within ffmpeg's own 1/255 alpha quantisation, measured against "
            "real output on both sides rather than asserted — see "
            "docs/notes/rounded-corners.md."
        ),
        "z_order": (
            "Track index 0 is painted LAST — topmost, on top of every other "
            "track — in both the live preview and export. Higher track "
            "indices paint first, further back. This is the opposite of "
            "'higher number = on top'."
        ),
        "keyframes_are_per_clip": (
            "editor_set_clip_keyframes animates ONE clip's own transform on "
            "its own local (source-frame-relative) timeline. Two clips on two "
            "different tracks each hold an independent keyframe list and can "
            "zoom at their own moment with zero interaction — there is no "
            "track-level or whole-timeline keyframe concept."
        ),
        "keyframe_segments_are_linear_until_you_ease_them": (
            "D-232: every keyframe segment interpolates LINEARLY by default — "
            "constant rate, and a dead stop at the next key. That is usually "
            "the single biggest reason a generated move looks generated. "
            "editor_set_keyframe_ease sets a real cubic-bezier ease on ONE "
            "property's segment (the one STARTING at the frame you name), "
            "taking the same preset names and control points as "
            "editor_set_clip_fade's curves. Easing warps the RATE only: both "
            "endpoints still hit their authored values exactly, so it can "
            "never move a keyframe. `y` outside 0..1 is legal and means "
            "overshoot. The live preview solves the curve exactly per frame; "
            "editor_export approximates each eased segment as 20 linear steps "
            "(ffmpeg has no bezier solver), which is below one output "
            "quantisation step — the two agree on every authored keyframe "
            "exactly. editor_set_curve_editor opens the same curve in the GUI "
            "so a human can see and redrag it."
        ),
        "a_keyframe_overrides_the_static_field_per_property": (
            "PER PROPERTY, a keyframe wins over the value "
            "editor_set_clip_transform writes, at EVERY frame — the static "
            "field is only ever a fallback for a property no keyframe names "
            "(D-208: the resolver brackets each property over only its own "
            "keys). So editor_set_clip_transform(scale=...) on a clip whose "
            "keyframes name `scale` is a real, persisted write that changes "
            "no rendered frame, while the same call's `position_y` on the "
            "same clip DOES take effect if no key names position_y. To move "
            "an animated property, write a keyframe for it "
            "(editor_set_clip_keyframes) instead — which is exactly what the "
            "GUI's on-canvas drag and its Inspector number fields now do "
            "(B-093/D-209, D-208). Verify with editor_get_state: compare the "
            "clip's static field against its chroma_keyframes params."
        ),
        "text_title_clips": (
            "D-211: a TEXT/TITLE clip (editor_add_text_clip) is an ORDINARY "
            "clip on an ORDINARY video track — there is no text track kind. "
            "It composites over the video by the same track-index z-order as "
            "everything else, so put the title on a LOWER track index than "
            "the footage it labels. B-129/D-262: OMIT `track` and it gets a "
            "brand-new video track at index 0 (above everything) in one op — "
            "do that rather than reusing a footage track, where a title lands "
            "in a GAP and renders over black instead of over the shot. An "
            "explicit non-video `track` is refused now, not silently placed, "
            "and a new track at 0 renumbers every existing track (the result "
            "reports `track`, `createdTrack` and `trackCount`). Every ordinary "
            "clip tool works on it: move, trim, split, remove, fade, "
            "editor_set_clip_transform's opacity/position_x/position_y, and "
            "editor_set_clip_keyframes on those. But `scale`, `rotation`, "
            "`crop_*` and `box_width`/`box_height` do NOT apply to a title in "
            "either the live preview or the export, and "
            "editor_set_clip_transform REFUSES a non-default value for one "
            "rather than storing something that renders nothing — a title's "
            "size is editor_set_text_clip's own `size` (a fraction of the "
            "output frame's HEIGHT, not pixels). The reason is parity, not "
            "laziness: the export compiles a title to ffmpeg's `drawtext`, "
            "which can place and fade a text box and nothing else, so a "
            "preview that scaled or rotated one would be showing a picture "
            "the export cannot produce. Widening both engines together is "
            "Phase 2 — see docs/notes/text-title-clips.md."
        ),
        "adjustment_clips": (
            "D-229: an ADJUSTMENT CLIP (editor_add_adjustment_clip) is an "
            "ordinary clip on an ordinary video track that contributes NO "
            "picture of its own — it applies one colour correction to "
            "everything composited BENEATH it, for the span it covers. Which "
            "clips it reaches is decided entirely by track index: it affects "
            "every visible video track with a HIGHER index than its own, so "
            "track 0 grades the whole edit and an adjustment clip on the "
            "BOTTOM track affects nothing (the most common way to be "
            "surprised by it). Its five parameters (exposure, contrast, "
            "saturation, temperature, tint; each -1..1, 0 = no change) are "
            "the Edit tab's own primary correction, NOT the Colorist's "
            "grading stack — that is a separate surface, applies to one clip, "
            "and is GPU-shader-only so it could not be reproduced in the "
            "ffmpeg export at all. Its `opacity` (via "
            "editor_set_clip_transform) is how strongly the correction mixes "
            "in, and is read STATICALLY: keyframing it or fading the clip "
            "does NOT animate the correction in either engine, because ffmpeg "
            "fixes these filter coefficients at filter init. Position, scale, "
            "rotation and crop do not apply — the correction is full-frame. "
            "Two adjustment clips on two tracks compose, lower one first. "
            "See docs/notes/adjustment-clips.md."
        ),
        "selection_gated_surfaces": (
            "D-216: you do NOT need a selection to edit anything — every "
            "mutating editor_* tool takes an explicit track/clip. But the "
            "Edit tab has two surfaces that render ONLY for a selection of "
            "EXACTLY ONE clip: the on-canvas transform box and its four "
            "corner handles, and the Inspector's per-clip form. If you are "
            "about to debug_screenshot the preview or the Inspector to check "
            "a transform, call editor_set_selection(clips=[{'track': t, "
            "'clip': i}]) first or you will photograph an empty canvas and "
            "conclude the wrong thing. The response's `singleClipSelected` "
            "tells you whether that condition now holds; `trackLocked` on a "
            "selected clip means the box draws but the drag handles do not."
        ),
        "preview_viewport_zoom": (
            "D-218: the preview has its own VIEWPORT zoom + pan "
            "(editor_set_preview_zoom; reported by editor_get_state as "
            "`previewZoom`). It is display-only — it is NOT a clip's "
            "scale/position and changes nothing about what renders or "
            "exports. Two things follow for you. (1) READ it before "
            "interpreting a debug_screenshot of the preview: at a non-fit "
            "view the picture on screen is a magnified CROP of the frame, so "
            "a clip that looks off-centre may just be being looked at from "
            "off-centre. (2) USE it when checking fine detail: at fit the "
            "preview is a ~960px-long-edge proxy of the whole frame, so a "
            "thin edge, a small title or a colour boundary is a handful of "
            "pixels; zoom to 200-400% and pan to the area first. Set it back "
            "to \"fit\" when you are done so the user does not find their "
            "viewer left magnified into a corner. 100% means FIT, not 1:1 "
            "with the output resolution — and because the preview IS a "
            "capped proxy, magnifying it enlarges proxy pixels rather than "
            "revealing full-resolution detail."
        ),
    },
    "export": {
        "v1_scope": (
            "D-197: editor_export now mixes real audio too, automatically — "
            "no new parameter needed. Every visible audio-track clip (its "
            "own track's gain, D-057; ducking, D-149; fade in/out, D-147) "
            "PLUS a video clip's own embedded audio (when its source is "
            "known to have one and it is not A/V-linked to a separate audio "
            "clip, D-129) mix down to one real output audio stream, matching "
            "the exact semantics the live preview's own audio mixer already "
            "implements — set gain/duck/fade via editor_set_track_gain / "
            "editor_set_track_duck / editor_set_clip_fade as usual and the "
            "NEXT editor_export call just includes them. The one thing this "
            "compiler cannot determine itself (it never probes a file) is "
            "whether a VIDEO clip's source actually HAS an audio stream at "
            "all — resolved automatically from the media pool's own probed "
            "info, so a clip whose source was never probed for audio (e.g. "
            "one added before that metadata existed) conservatively "
            "contributes no embedded audio rather than risk a broken export; "
            "re-import via editor_import_media to (re)probe it if embedded "
            "audio is missing from an export that should have it."
        ),
        "per_clip_level": (
            "D-223: a clip's own `volume`/`pan` (editor_set_clip_audio, or "
            "keyframed via editor_set_clip_keyframes) export exactly as they "
            "play — the same `track gain x clip volume x fade x duck` product "
            "then the same constant-power pan law, verified by real "
            "per-channel level measurement of real exported files. Mono "
            "sources included: a panned MONO clip used to export 3 dB below "
            "what the preview played, because the exporter upmixed it to "
            "stereo through ffmpeg's power-preserving rematrix while the live "
            "mixer duplicates the channel at unity — fixed (B-101/D-269), the "
            "exporter now performs the same unity duplicate for a source "
            "probed as mono. If a mono clip predates the probed channel count "
            "and no editor_list_media has run to backfill it, the old upmix "
            "is kept rather than guessed at; call editor_list_media once (or "
            "editor_reprobe_media that item) and re-export."
        ),
        "per_clip_eq": (
            "D-224: a clip's own parametric EQ (editor_set_clip_eq) exports "
            "exactly as it plays. Both engines run the SAME Audio EQ Cookbook "
            "biquad coefficients — the exporter compiles each band to "
            "ffmpeg's generic `biquad` filter fed those numbers, rather than "
            "naming ffmpeg's own `equalizer`/`bass`/`treble`, because its "
            "shelves measurably do NOT implement the cookbook's Q "
            "parameterisation (0.25-0.37 dB off, measured). Verified by a "
            "real frequency-response measurement of real ffmpeg output "
            "against the same table the live mixer's own cascade measures. "
            "The EQ is applied BEFORE the volume/fade/duck gain stages, in "
            "both engines. It is STATIC, not keyframeable: ffmpeg's biquad "
            "filters parse their parameters once as numbers, so an animated "
            "EQ is not expressible in an export at all, and this app does "
            "not offer a preview it cannot render. One inherent, measured "
            "detail: the exporter designs its coefficients at 48 kHz while "
            "the live mixer designs at the output device's own rate, so on a "
            "44.1 kHz device the two curves differ by the bilinear warping "
            "alone (<= 0.036 dB across 50 Hz-15 kHz) — the standard property "
            "of any biquad EQ, not a divergence between the two paths."
        ),
        "speed_ramp": (
            "D-236: set_clip_speed is the REAL way to retime a clip — a "
            "persisted `Clip.speed_points` ramp that the live preview and the "
            "export both honour, frame for frame, and that a human can also "
            "edit in the Inspector's Speed section. Prefer it over "
            "editor_export's `speed_overrides` for anything you want to see "
            "before you render. A flat speed is just a one-segment ramp "
            "(`speed=2`), so there is no second mechanism to learn: points "
            "sit on ABSOLUTE SOURCE frames (so a ramp survives a later trim), "
            "each segment plays at a constant rate, and picture and sound are "
            "retimed together with pitch preserved. It changes the clip's "
            "LENGTH on the timeline but NOT its start_frame and does NOT "
            "ripple its neighbours — speeding a clip up opens a gap you have "
            "to close yourself. Not supported: reverse (negative) speed, "
            "smoothed S-curve speed transitions (approximate one with more "
            "points), and a speed change on a clip a transition joins (the "
            "export refuses that combination outright, with a named reason)."
        ),
        "speed_overrides": (
            "speed_overrides is export-time ONLY — it does not touch the "
            "clip's stored trim/duration, so editor_set_playhead scrubbing "
            "and the GUI still show the clip at 1x. D-236 supersedes it for "
            "most uses: set_clip_speed stores a real, previewable ramp "
            "instead, and a clip carrying one IGNORES its speed_overrides "
            "entry (the persisted ramp wins, rather than the two multiplying) "
            "— so do not set both on the same clip and expect them to "
            "compose. The sped-up clip's "
            "on-timeline window shrinks to duration/speed inside the "
            "export's own placement math; nothing else needs adjusting for "
            "it to line up against unsped clips on other tracks. "
            "`fit_overrides` mirrors this exact shape (`{clip_id: value}`, "
            "export-time-only) for the unrelated aspect-ratio knob above. "
            "D-224: a speed override on a clip a TRANSITION joins is refused "
            "outright at compile time (a real named error, not a silent "
            "skip) — a speed change moves that clip's edge away from the cut "
            "the transition sits on, so the two cannot both be honoured."
        ),
    },
    "still_images": {
        "a_still_is_an_ordinary_clip": (
            "D-292: a STILL IMAGE (.png/.jpg/.jpeg/.webp/.tif/.tiff/.bmp) is a "
            "first-class media-pool source and an ordinary video-track clip — "
            "it has a real source_path and media_id, and every op applies to "
            "it unchanged: trim, slip, split, roll, transitions, "
            "editor_set_clip_transform, keyframes, fades, the Colorist grade. "
            "It is NOT a separate clip kind the way a title "
            "(editor_add_text_clip) or an adjustment clip is — those are "
            "GENERATED and carry no source file at all. Whether a clip is a "
            "still is read off its source path's extension, so nothing has to "
            "be told twice and editor_swap_clip_media can point a clip at a "
            "still or away from one freely."
        ),
        "it_has_no_length_so_one_is_synthesized": (
            "A still genuinely has no duration, frame rate or frame count, and "
            "the pool reports none: editor_list_media gives it an `image` key "
            "(width/height only) where footage has `video`. editor_add_clip "
            "therefore places it at 3 SECONDS at the project's rate by default "
            "— the same default a title gets — rather than 'the rest of the "
            "source'. Pass `duration` for anything else. Its reported "
            "`sourceLen` is a synthesized ONE HOUR of trim headroom, not a "
            "length: it exists so a still can be extended freely, and reading "
            "it as 'how long this source is' is the one real trap here."
        ),
        "video_tracks_only": (
            "A still is refused on an audio track (it is picture with no audio "
            "stream, so unlike a video clip it can never be an audio source), "
            "and it never gets a linked audio half on drop. Animated GIF and "
            "camera RAW are deliberately not importable at all — a GIF is not "
            "one frame, and RAW cannot be opened by the export engine."
        ),
    },
    "colorist_grade": {
        "it_is_automatic": (
            "D-256: a clip's COLORIST GRADE is now live on the Edit "
            "timeline. Grade a clip in the Colorist tab (set_primary, "
            "set_color_grade, set_curve, save_grade...) and the very same "
            "clip on the Edit timeline previews graded, and exports graded, "
            "with NO extra call and no per-clip toggle — there is nothing to "
            "switch on. Before D-256 a Colorist grade had literally no "
            "effect on that footage in the Edit tab, so an agent that "
            "learned the old behaviour should unlearn it: you no longer need "
            "to bake a LUT by hand or re-export from Colorist to get a "
            "graded cut."
        ),
        "the_link_is_the_clip_id": (
            "A grade belongs to a CLIP, not to a source file (D-070's "
            "unified clip identity): it is stored at "
            "`<project>/grades/<clip.id>.grade.json`. Two clips cut from the "
            "same file grade independently — which is Resolve's own default "
            "and is usually what you want, but does mean that splitting a "
            "graded clip does NOT copy its grade onto the new half. Check "
            "with editor_get_grade_status."
        ),
        "what_it_carries": (
            "The GLOBAL grade, exactly: exposure, contrast, curves, colour "
            "wheels, HSL, and an applied .cube. It is carried as a 33-cube "
            "3D LUT baked by running an identity lattice through the "
            "Colorist's own GPU pipeline once, so the Edit preview and the "
            "ffmpeg export apply the identical numbers (measured equal to "
            "the code, not approximately). What a 3D LUT CANNOT carry is "
            "anything spatial: mask/local layers, the Colorist crop, and "
            "depth relight are dropped, and each drop is reported — as a "
            "warning in editor_get_grade_status, in the Export dialog, and "
            "in the app log. If editor_get_grade_status lists warnings for a "
            "clip, the exported file will legitimately differ from what the "
            "Colorist tab shows for it; nothing else will."
        ),
        "identity_is_nothing": (
            "A clip that was never graded, or whose grade was reset, has NO "
            "LUT applied at all — not an identity one — so its preview and "
            "its exported pixels are bit-identical to a build without this "
            "feature. `graded: false` from editor_get_grade_status means "
            "exactly that, and covers both 'no grade file' and 'a grade file "
            "that does nothing'."
        ),
    },
    "transitions": {
        "model": (
            "D-224: a transition BRIDGES a cut — the two clips stay abutting "
            "and never overlap. `editor_add_transition(track, at_frame=...)` "
            "takes the TIMELINE frame where one clip ends and the next "
            "begins (editor_list_transitions reports each video track's real "
            "`cuts`); the covered window is DERIVED from that plus the "
            "duration and the alignment, and is reported back as "
            "`window_start_frame`/`window_end_frame`. Removing a transition "
            "restores the plain cut and re-trims nothing, because nothing "
            "moved to make room for it in the first place."
        ),
        "handles": (
            "A CROSS DISSOLVE shows both clips at once, so one of them must "
            "supply frames from OUTSIDE its own trim: `head_handle_frames` "
            "before the incoming clip's in-point, `tail_handle_frames` past "
            "the outgoing clip's out-point. A cut made by editor_split_clip "
            "has plenty of both by construction; two whole files butted "
            "together have neither, and the add is REFUSED with a reason "
            "naming exactly how many frames are missing. Three fixes, in "
            "order of least effort: change `alignment` ('start_at_cut' needs "
            "no head handle, 'end_at_cut' needs no tail handle), shorten "
            "`duration_frames`, or use kind='dip_to_color', which needs NO "
            "handle media at all and therefore always works."
        ),
        "kinds": (
            "Two in v1: 'cross_dissolve' (the incoming clip fades up over "
            "the outgoing one) and 'dip_to_color' (both dip through a solid "
            "colour, black unless you pass `color`). Both render identically "
            "in the live preview and in editor_export — verified by real "
            "pixel measurement on both sides, not by argv inspection."
        ),
    },
    "known_gaps_and_landmines": {
        "animated_captions_D241": (
            "An ANIMATED caption (editor_add_caption_preset, or "
            "editor_set_caption_style with animation != 'none') is drawn WORD "
            "BY WORD, and two things about that are not guessable. (1) There "
            "is deliberately NO per-word scale, no rounded highlight box and "
            "no fading/sweeping box: ffmpeg's fontsize is the input to the "
            "very glyph measurement that makes the live preview and the "
            "export agree (D-212), and drawbox has neither a corner radius "
            "nor a per-frame alpha expression — so any of them would be a "
            "preview the export cannot reproduce. Asking for a 'pop' or a "
            "'pill' gets a slide and a square box, on purpose. (2) Word "
            "timings are DERIVED from each word's character count across the "
            "cue, not from speech — a .srt carries no word timings — so a "
            "karaoke preset is only as tight as that approximation until the "
            "transcript-driven follow-up lands. Also note an animated caption "
            "emits roughly one filtergraph node per word, so setting a "
            "several-hundred-cue imported .srt to animate builds a very large "
            "graph; that path is not optimised. See D-243 and "
            "docs/notes/caption-presets.md."
        ),
        "media_pool_stuck_item_B073": (
            "FIXED (docs/BUGS.md B-073), and the recovery is now one call. A "
            "media-pool item whose FIRST probe failed (e.g. a transient "
            "file-access race) is pooled with no video metadata, which makes "
            "editor_add_clip refuse it — editor_list_media names it "
            "(usable: false, plus a `problem` string; the response's "
            "`unusable` array is just the ids). Fix the underlying file "
            "problem, then editor_reprobe_media those ids: the item is "
            "re-probed in place and comes back usable, keeping its id and "
            "every reference to it. editor_import_media on the identical "
            "path now heals such an item too (it used to dedup to a silent "
            "no-op, which is how this bug was found). Never recreate a "
            "project or hand-read project.json for this. A source that is "
            "STILL missing comes back honestly unusable — check the "
            "response's `stillUnusable`, don't assume the re-probe worked."
        ),
        "control_server_wedge_B069": (
            "FIXED (docs/BUGS.md B-069, a Rules-of-Hooks violation in "
            "TimelinePane.tsx) but worth knowing the failure mode existed: a "
            "single uncaught React render crash in one Edit-tab panel wedged "
            "the WHOLE control-server bridge — every editor_* op, including a "
            "plain read like editor_get_state, failed or timed out, not just "
            "ops touching the crashed panel. No error boundary exists around "
            "any Edit-tab panel yet, so a *different* future crash there "
            "could still reproduce this. If a previously-working "
            "editor_get_state call suddenly times out or errors, suspect a "
            "control-server wedge — restart the Apelles app; don't retry in a "
            "loop."
        ),
        "first_call_after_restart_B071": (
            "The FIRST editor_* call right after restarting the Apelles app "
            "can fail once and then succeed on an immediate identical retry "
            "(a stale pooled HTTP connection to the old process's now-closed "
            "socket). See docs/BUGS.md B-071 (status: open). One retry is the "
            "correct response — it is not a sign anything is actually broken."
        ),
        "macos_screen_recording_filenames_B070": (
            "macOS names screen recordings with a NARROW NO-BREAK SPACE "
            "(U+202F), not a regular space, before AM/PM — e.g. 'Screen "
            "Recording 2026-09-07 at 1.08.16 PM.mov'. A hand-typed path "
            "using an ordinary space will silently fail to match the real "
            "file in ANY tool, including editor_import_media — this is not a "
            "Apelles bug (docs/BUGS.md B-070; every process doing direct-path "
            "access hits the identical trap). Resolve the real path via a "
            "shell glob or a directory listing first; never hand-transcribe "
            "a visible screen-recording filename into a tool call."
        ),
    },
    "architecture": (
        "Every editor_* tool call and every GUI click go through the exact "
        "same store (`useEditorTimelineStore`, D-020's one-shared-state "
        "rule) — an edit made here moves the app's real timeline, and a "
        "human's manual edit is immediately visible to get_timeline. See "
        "docs/notes/mcp-architecture.md for the full four-layer picture "
        "(MCP client -> mcp/server.py -> chroma::control -> "
        "useEditorControl.ts -> the store). One consequence: a render crash "
        "anywhere in that shared tree can take the whole bridge down with "
        "it (see control_server_wedge_B069 above — now fixed, but the "
        "structural risk of an uncaught crash elsewhere in that tree is "
        "not)."
    ),
    "workflow_tip": (
        "Live-test the surface before trusting it for a real edit: call "
        "editor_get_state (cheap read), then do one real mutating round "
        "trip (e.g. new_project or editor_add_track) and confirm "
        "editor_get_state / get_timeline actually reflects the change — "
        "BEFORE building a real edit on top of it. Discovering a wedged "
        "bridge mid-task (B-069's own failure mode, now fixed, but the "
        "class of bug it represents is not structurally prevented) costs "
        "far more than finding a dead surface upfront."
    ),
}


@mcp.tool()
def editor_get_capabilities() -> str:
    """Hard-won, non-obvious facts about the Edit tab's compositing/export
    model and its rough edges — the things reading `mcp/server.py`'s other
    docstrings alone will NOT tell you, because they were only discovered by
    reading Apelles' own source or hitting them live. Call this ONCE per
    session, before your first `editor_set_clip_transform` /
    `editor_set_clip_keyframes` / `editor_export`, not per-op.

    Static reference data: answered entirely in this process, no round trip
    to the running app — the only `editor_*`-prefixed tool that works with no
    Apelles window running and no project open at all.

    Covers: what `scale`/`fit_overrides` actually control in the live preview
    vs. export (a stacking/picture-in-picture primitive, not a "fill this
    exact box" primitive — plus the recipe for landing a clip in an exact
    half-canvas slot anyway), track paint order, why keyframes are per-clip,
    why a keyframe silently beats `editor_set_clip_transform` per property,
    export's real v1 scope (video only), how a STILL IMAGE differs from
    footage (D-292 — it has no length, so one is synthesized), and known rough
    edges worth testing
    for before trusting a real edit (a stuck media-pool entry, a one-time
    flake right after an app restart, a macOS screen-recording filename trap
    that will silently break ANY tool given a hand-typed path, an animated
    caption's two non-guessable rules, and a now-fixed control-server wedge
    worth knowing the shape of).

    Returns a structured dict, not prose to scan — read the `known_gaps_and_
    landmines` and `compositing` keys first."""
    return json.dumps(EDITOR_CAPABILITIES, indent=2, default=str)


@mcp.tool()
def editor_get_state() -> str:
    """The Edit tab's own top-level state: whether a project is open AND
    which one (`openProject`, its `.chroma` path — B-083), load status,
    playhead position, whether it is playing, whether a timeline exists at
    all, and the current `selection` (a list of `{track, id}`) plus
    `selectedGap`. Cheap, read-only — call before anything else if you don't
    already know a project is open, to confirm which project the Edit tab is
    actually on after an `open_project`/`new_project` switch, or to see what
    the user currently has selected.

    Also reports `previewZoom` (D-218) — the preview VIEWPORT's own zoom/pan
    (`zoom`, `pct`, `panX`, `panY`, `fit`). Read it before interpreting a
    `debug_screenshot` of the preview: at a non-fit view the picture on screen
    is a magnified crop of the frame, so a clip that looks off-centre may
    simply be being looked at from off-centre. `editor_set_preview_zoom` is
    the write half.

    Also reports `waveformView` (D-232) — whether the viewer is showing its
    audio waveform strip under the picture. `editor_set_waveform_view` is that
    one's write half; `editor_get_waveform` reads the envelope itself."""
    import json

    return json.dumps(_op("editor_get_state"), indent=2, default=str)


@mcp.tool()
def editor_get_grade_status() -> str:
    """Which clips on the Edit timeline carry a real **Colorist grade** — and
    what, if anything, that grade loses on the way there (D-256).

    Returns `clips` (`{clipId, name, graded}` per video clip), `gradedCount`,
    and `warnings`. `graded: true` means this clip previews AND exports with
    its Colorist grade applied — automatically, with no toggle; see
    `editor_get_capabilities`' `colorist_grade` key for the model. `graded:
    false` covers both "never graded" and "graded, then reset to nothing":
    either way no LUT is applied at all, and the pixels are identical to a
    build without the feature.

    **Read `warnings` before trusting an export to match the Colorist tab.**
    The grade crosses into the Edit tab as a baked 3D LUT, which carries the
    whole global grade exactly but *cannot* carry anything spatial — a mask /
    local layer, the Colorist crop, depth relight. Each such drop is listed
    here, named by clip. An empty `warnings` list means the exported file is
    the grade, in full.

    Use it to confirm a grade actually landed on the clip you meant (the link
    is the CLIP id, not the source file — two clips cut from one file grade
    independently, and splitting a graded clip does not copy the grade onto
    the new half), and to check a timeline before `editor_export`.

    Cheap to call repeatedly: each clip's lattice is memoised on its grade
    file's own mtime, so asking twice costs nothing."""
    import json

    return json.dumps(_op("editor_get_grade_status"), indent=2, default=str)


@mcp.tool()
def editor_set_playhead(frame: int) -> str:
    """Move the Edit tab's playhead to an exact frame (0-based, absolute
    timeline frame)."""
    import json

    return json.dumps(_op("editor_set_playhead", frame=frame), indent=2, default=str)


@mcp.tool()
def editor_set_playing(playing: bool) -> str:
    """Start (`True`) or stop (`False`) Edit-tab playback.

    **This is the whole transport — picture AND sound.** There is not a
    separate audio play/stop: the viewer keys `chroma_audio_play`/
    `chroma_audio_stop` off this same flag, so starting playback here starts
    the real mixed audio session too. Whether anything is audible also depends
    on the monitor (`editor_set_audio_monitor`); `editor_get_audio_level` is
    how you check that sound actually reached the output device.

    How far the playhead travels per second of real time depends on
    `editor_set_playback_rate` — the response repeats it for that reason."""
    import json

    return json.dumps(_op("editor_set_playing", playing=playing), indent=2, default=str)


@mcp.tool()
def editor_set_playback_rate(rate: float) -> str:
    """Set the Edit tab's **preview playback rate** — how many timeline seconds
    the transport plays per real second. The same control the human uses next
    to play/pause in the viewer's transport bar (D-280).

    **This is NOT a clip's speed.** It changes how fast you WATCH and nothing
    else: no clip is touched, nothing is persisted, nothing is undoable, and an
    export taken while the preview is at 4x renders *exactly* what an export at
    1x renders. If what you actually want is to make a clip play fast in the
    finished video, that is `editor_set_clip_speed` (D-236) — a different tool
    that edits the cut. "Make this faster" is genuinely ambiguous between the
    two; pick deliberately.

    `1` is normal. `2` / `3` / `4` are the review speeds the viewer offers as
    one-click presets; anything from `0.25` to `8` is accepted and anything
    outside that is CLAMPED rather than rejected (the response says so when it
    clamped). `0.5` and below play slower than real time.

    **Audio keeps up and stays intelligible.** Fast playback is not muted and
    not chipmunked: the mixer time-stretches the mixed output with pitch
    preserved (WSOLA), so dialogue at 3x is still dialogue. That is deliberately
    different from a *clip's* speed ramp, which varispeeds like tape (D-242).

    Safe to set while playing — the transport re-baselines picture and sound
    together from wherever the playhead is, so you continue rather than jump.

    `editor_get_state` reports the current value as `playbackRate`."""
    import json

    return json.dumps(_op("editor_set_playback_rate", rate=rate), indent=2, default=str)


@mcp.tool()
def editor_set_audio_monitor(
    volume: float | None = None, muted: bool | None = None
) -> str:
    """Set the Edit tab's **master monitoring volume** (`0..1`) and/or its mute
    flag — the same speaker button and volume slider in the viewer's transport
    bar the human uses, driving the same `chroma_audio_set_volume` multiplier
    applied in the real audio output callback.

    **Monitoring only.** This is what the room hears while previewing. It is
    not a track's `gain` (`editor_set_track_gain`), not a clip's `volume`
    (`editor_set_clip_audio`), and it changes NOTHING about what
    `editor_export` renders — an export at monitor-muted comes out with
    exactly the audio it would have anyway.

    Pass either argument alone to leave the other as it is. `volume` is
    clamped to `0..1` rather than rejected (the backend clamps too), and the
    response says so when it clamped. Volume and mute are independent: muting
    remembers where the slider was, so unmuting restores it.

    `editor_get_state` reports the current pair as `monitor`. (D-266.)"""
    import json

    args: dict = {}
    if volume is not None:
        args["volume"] = volume
    if muted is not None:
        args["muted"] = muted
    return json.dumps(_op("editor_set_audio_monitor", **args), indent=2, default=str)


@mcp.tool()
def editor_get_audio_level() -> str:
    """Read the **last measured RMS and peak of the audio actually written to
    the output device** — the concrete answer to "is sound really coming out
    right now", which you have no ears for and a human does not need a tool
    for.

    Use it to verify a playback claim rather than asserting one: start
    playback (`editor_set_playing`), wait about a second, then read this. A
    non-zero `rms`/`peak` is real, non-silent PCM having reached the real
    device through the whole mixer.

    **Read the window before trusting a zero.** The measurement refreshes only
    once per ~1 second of playback, so it lags a change by up to that long and
    stays STALE (not zeroed) after a stop — the response carries `windowSecs`,
    the current `playing`/`muted`/`volume`, and a `note` naming which of those
    explains what you are seeing. Zeroes right after pressing play usually mean
    the first window has not completed yet.

    This is not a meter and cannot be polled as one; a level for a FILE, at any
    resolution you like, is `editor_get_waveform` instead. (D-266.)"""
    import json

    return json.dumps(_op("editor_get_audio_level"), indent=2, default=str)


@mcp.tool()
def editor_set_waveform_view(open: bool) -> str:
    """Show (`True`) or hide (`False`) the Edit-tab viewer's **audio waveform
    strip** (D-232, roadmap item 27) — the band drawn between the picture and
    the position bar, showing a 4-second window of the audio around the
    playhead with a line at the playhead itself.

    The same flag the human's waveform-toggle button in the transport bar
    drives, not a parallel one. Useful before a `debug_screenshot` of the
    preview (the strip changes what the transport area contains), and to leave
    the user looking at the audio you have been reasoning about.

    To read the envelope as NUMBERS rather than pixels, use
    `editor_get_waveform` — that is the tool for actually inspecting audio;
    this one only changes what is on screen."""
    import json

    return json.dumps(_op("editor_set_waveform_view", open=open), indent=2, default=str)


@mcp.tool()
def editor_get_waveform(
    frame: int | None = None,
    window_secs: float | None = None,
    buckets: int | None = None,
) -> str:
    """The audio amplitude envelope around a timeline frame — **the same window
    the viewer's waveform strip draws, as numbers** (D-232, roadmap item 27).

    This is the agent-side half of Apelles' audio scrubbing feature. Tape-style
    scrub (dragging the playhead and hearing the audio under it) is a live
    pointer gesture and has, deliberately, no MCP tool of its own — you cannot
    hear it, and `editor_set_playhead` already moves the playhead observably.
    What a scrub actually tells a human is *where the sound is*, and this
    returns exactly that.

    Use it to answer questions you would otherwise have to ask the user to
    listen for: where a sentence starts or ends, whether a cut lands in silence
    or mid-word, whether a clip is silent at all, how loud one stretch is
    against another. Pair it with `editor_get_transcript` (D-189) when you need
    words as well as levels.

    - `frame` — the timeline frame to centre on. Defaults to the current
      playhead.
    - `window_secs` — how much source audio to cover, centred on that frame
      (default 4, matching the strip). Clamped forward at the head of a file.
    - `buckets` — how many `[min, max]` amplitude pairs to reduce it to
      (default 64, max 2000). More buckets = finer time resolution.

    Returns the resolved `source` (`path`, `sourceSecs`, `track`, `clipId`,
    `gain`), the `window` it covered (including `clipStartFraction`/
    `clipEndFraction` — the part of the window that is actually this clip's own
    trimmed material, outside which the source exists but is not on your
    timeline), and `peaks`: one `[min, max]` pair per bucket, each in `-1..1`.
    An all-zero pair is silence.

    `gain` (B-110) is the linear level this source is actually heard at —
    `track.gain × clip.volume`. The `peaks` are the SOURCE's own and are NOT
    scaled by it, so multiply if you want what reaches the speakers: a bed at
    `gain: 0.4` whose peaks read `0.8` is heard at `0.32`. Compare two clips'
    loudness by their peaks AND their gains, never by peaks alone.

    `source: null` is a normal answer, not an error: a gap, a title/adjustment
    clip, a muted audio track, or past the end of the timeline. It resolves the
    one audible source the way playback does — a real audio track first
    (topmost wins), otherwise the video clip's own embedded audio unless that
    clip is A/V-linked (D-129). **One source, not the mix** — where several
    clips overlap this frame, playback sums all of them and this reports only
    the winner (see D-232; the mix is a roadmap follow-up)."""
    import json

    args: dict = {}
    if frame is not None:
        args["frame"] = frame
    if window_secs is not None:
        args["windowSecs"] = window_secs
    if buckets is not None:
        args["buckets"] = buckets
    return json.dumps(_op("editor_get_waveform", **args), indent=2, default=str)


@mcp.tool()
def editor_set_selection(
    clips: list[ClipSelector] | None = None,
    gap: GapSelector | None = None,
) -> str:
    """Set what the Edit tab has SELECTED — the write half of
    `editor_get_state`'s `selection`/`selectedGap` (D-216, roadmap item 26).
    Until this existed, selection was readable and not writable, so nothing
    but a human's mouse click could put a clip into the selected state.

    **Why you would call this at all**, given that every editing capability
    already takes an explicit `track`/`clip` and needs no selection: the Edit
    tab has real surfaces that only exist FOR a selection, and this is the
    only way to reach them.

    - The **on-canvas transform box** (`TransformOverlay` — the box + corner
      handles drawn over the preview) renders only when EXACTLY ONE clip is
      selected. Without this tool, that whole surface is undrivable and, more
      to the point, uncheckable: pair this with `debug_screenshot` to actually
      SEE the box land on the picture (that is what this tool was built for —
      B-093/D-209 shipped with its on-canvas tier unverified because there was
      no way to select anything).
    - The **Inspector** shows a clip's own form under the same
      exactly-one-clip rule, so a screenshot of it is only meaningful once
      something is selected.
    - It also lets you leave the app in the state a human expects to find:
      select the clip you just added/moved so the user sees it highlighted.

    **Arguments — pass exactly one of `clips` or `gap`.**

    `clips`: a list of `{"track": N, "clip": I}` or `{"track": N, "clipId":
    "..."}` entries. Both address forms are accepted because the two halves of
    this surface speak different dialects — `editor_get_state`/
    `editor_get_timeline` hand you ids, every mutating `editor_*` tool takes
    an index — and converting between them would otherwise cost you a round
    trip. `clipId` wins if you pass both. An index is only meaningful against
    the track's current Vec order, so prefer `clipId` if anything may have
    been reordered since you read the timeline.

    - Select one clip: `clips=[{"track": 0, "clip": 2}]`
    - Multi-select (the same thing cmd-click does in the GUI):
      `clips=[{"track": 0, "clip": 0}, {"track": 1, "clip": 3}]`
    - **Clear everything**: `clips=[]`

    `gap`: `{"track": N, "frame": F}` selects a GAP (empty space between two
    clips) instead — mutually exclusive with a clip selection, exactly as in
    the GUI. `frame` must fall inside a real gap (one with a clip after it);
    trailing empty space past the last clip is not a gap and is refused
    rather than silently selecting nothing. The response reports the gap's
    real `gapStart`/`gapEnd` bounds, so you can hand `gapStart` straight to
    `editor_remove_gap`, plus `closeable` (B-236): a real gap can still be
    one `editor_remove_gap` refuses — on a sync-locked timeline, when another
    sync-locked track has a clip straddling the gap's end (B-033) — and when
    it is `false`, `closeRefusedReason` is the reason, the same text the
    GUI's disabled Close Gap button shows.

    **Not undoable, by design** (D-216): selection is UI state, not document
    content — it is not part of the `Timeline` that gets persisted, so the
    undo stack has never carried it and neither does this. A human's click
    pushes nothing either; this behaves identically. Re-select with another
    call rather than looking for an undo.

    Every entry is validated against the live timeline — a bad track index,
    a bad clip index, or an unknown clip id is a real error, not a silently
    stored selection of something that does not exist.

    The response reads the selection straight back off the store, plus
    `singleClipSelected` (whether the on-canvas transform box / Inspector clip
    form will now draw) and, per selected clip, `trackLocked` (a locked
    track's clip still gets a box but no draggable corner handles) and
    `trackHidden`."""
    import json

    args: dict = {}
    if clips is not None:
        args["clips"] = to_wire(clips)
    if gap is not None:
        args["gap"] = to_wire(gap)
    return json.dumps(_op("editor_set_selection", **args), indent=2, default=str)


@mcp.tool()
def editor_set_preview_zoom(
    zoom: float | str,
    pan_x: float | None = None,
    pan_y: float | None = None,
) -> str:
    """Zoom and pan the Edit tab's PREVIEW VIEWPORT — how big the composited
    frame is drawn on screen (D-218, roadmap item 25). The GUI half is the
    `−  100%  +` cluster at the right of the preview's transport bar, and
    ctrl/pinch-scroll over the picture.

    **This is display-only. It is NOT a clip's transform.** It changes nothing
    about what renders or exports — no `Clip.scale`, no `position_x`/
    `position_y`, no composition size. If you want the PICTURE to be bigger in
    the finished video, that is `editor_set_clip_transform`. This tool only
    magnifies your own view of the frame, exactly like zooming a photo viewer.

    **Why you would call it**: to inspect detail in a `debug_screenshot`. At
    fit, the preview is a ~960px-long-edge proxy of the whole frame, so a thin
    edge, a small title, or a colour boundary is a handful of pixels. Zoom to
    200-400% and pan to the area first and the same screenshot shows it
    legibly. Also worth setting back to `"fit"` when you are done, so the user
    does not find their viewer left magnified into a corner.

    `zoom`: a multiplier where **1 = fit** (the whole frame visible, the
    default), 2 = twice that size, 0.5 = half. Range 0.25-8; outside it the
    value is clamped and the response says so in `note`. Pass the string
    `"fit"` to reset zoom AND pan in one call — the same thing clicking the
    percentage readout does.

    `pan_x` / `pan_y`: which part of the picture the viewport looks at, as a
    fraction of the FITTED picture's width/height offset from centre —
    `0` is centred, positive moves the picture right/down (i.e. reveals what
    is to its left/top). Omitted → the current pan is kept. The legal range is
    `±(zoom - 1) / 2`, which is `0` at or below fit (there is nothing
    off-screen to pan to) and is reported back as `panLimit`.

    Not undoable, by design (same reasoning as `editor_set_selection`, D-216):
    a viewport zoom is UI state, not part of the `Timeline` document, so it is
    never persisted and never sits between the user and their last real edit
    on an undo. `editor_get_state` reports the current view as
    `previewZoom`."""
    import json

    args: dict = {"zoom": zoom}
    if pan_x is not None:
        args["panX"] = pan_x
    if pan_y is not None:
        args["panY"] = pan_y
    return json.dumps(_op("editor_set_preview_zoom", **args), indent=2, default=str)


@mcp.tool()
def editor_import_media(paths: list[str], folder: str | None = None) -> str:
    """Import one or more absolute file paths into the project's shared media
    pool. Required before `editor_add_clip` can place them — that tool looks
    an item up by the `id`/`sourcePath` this one returns.

    A macOS screen recording's filename has a NARROW NO-BREAK SPACE (U+202F),
    not a regular space, before AM/PM — a hand-typed path with an ordinary
    space silently matches nothing. Resolve the real path via a shell glob or
    directory listing first; see `editor_get_capabilities` for the full story
    (docs/BUGS.md B-070). If this reports success but a later `editor_add_clip`
    on the same path still can't find the pool item, see B-073 there too —
    don't just retry.

    A path already in the pool is skipped, not duplicated — with one
    exception (B-073): an entry whose own first probe failed and therefore
    has no probed metadata is re-probed here and returned if it now succeeds,
    so re-importing really is a valid repair for that case. To repair such an
    item by id instead — keeping its id and every reference to it — use
    `editor_reprobe_media`.

    STILL IMAGES are importable too (D-292): `.png`, `.jpg`/`.jpeg`, `.webp`,
    `.tif`/`.tiff`, `.bmp`. They come back with an `image` key (width/height)
    where footage has `video`, and are placed by `editor_add_clip` on a video
    track with a synthesized duration — see that tool. Animated GIF and camera
    RAW are deliberately NOT importable: a GIF is not one frame, and RAW cannot
    be opened by the export engine."""
    import json

    args: dict = {"paths": paths}
    if folder is not None:
        args["folder"] = folder
    return json.dumps(_op("editor_import_media", **args), indent=2, default=str)


@mcp.tool()
def editor_remove_media(ids: list[str]) -> str:
    """Remove one or more items from the project's shared media pool by id
    (`editor_import_media`'s/a pool item's own `id`, not a source path).
    Wraps the SAME `chroma_media_remove` Tauri command the GUI's own Sources
    panel delete action already calls — no separate/new removal logic.

    **For a pool item that is merely STALE or UNPROBED, reach for
    `editor_reprobe_media` first, not this** (B-073, fixed): that re-probes
    the item in place, keeping its id and every reference to it, which is
    almost always what you want for a source whose probe failed once or whose
    file has since been fixed. Remove is for an item you genuinely want gone
    from the pool — a wrong file, a duplicate, a path that will never come
    back.

    An id already gone from the pool (already removed, a stale id) is
    silently skipped, not an error — same "the caller's own already-rendered
    list can be stale" reasoning `chroma_media_remove` itself documents.
    Does not touch the file on disk (media is always referenced in place,
    never owned by the project) — only the pool's reference to it and its
    cached thumbnail.

    **A clip already placed on the timeline that references a removed item
    does NOT go offline, error, or get cascade-removed — investigated, not
    assumed.** A `Clip` copies its `source_path` from the pool item at the
    moment it's placed and never re-reads the pool afterward; only
    `Clip.media_id` — a back-link used for legacy grade-file migration
    bookkeeping, never for playback/rendering/export — goes stale. So a clip
    built from a removed pool item keeps playing/exporting fine as long as
    its source file is still on disk; it simply becomes invisible/unmanaged
    in the Sources panel and its `media_id` no longer resolves to any pool
    item. The response's `stillReferencedBy` array lists every timeline
    clip (by `track`/`clip` index and `clipId`) whose `media_id` matched one
    of the ids you just removed, so you can tell whether you just orphaned
    a live clip's pool entry before deciding whether that's what you
    wanted."""
    import json

    return json.dumps(_op("editor_remove_media", ids=ids), indent=2, default=str)


@mcp.tool()
def editor_list_media() -> str:
    """List everything in the project's shared media pool — every item's `id`,
    `name`, `sourcePath`, the bin it is filed in, its probed video metadata,
    and whether its source file is on disk right now.

    Call this before `editor_add_clip` whenever you did not import the item
    yourself in this session: `editor_add_clip` resolves a pool item by `id` or
    `sourcePath`, and this is the only way to learn either for media a human
    imported, a `new_project` seeded, or a Motion render produced.

    Reads through to disk (the same `chroma_media_list` the GUI's Sources panel
    lists from), not off a cached array — so it is also the way to check what
    an import actually did.

    **Every row carries `usable`, and an unusable one explains itself in
    `problem`.** `editor_add_clip` refuses any item that never probed
    successfully, and that refusal — not the pool state itself — is the symptom
    you would otherwise hit (see `docs/BUGS.md` B-073). The response's
    `unusable` array is the ids of exactly those items, so "which one is the
    broken one" is one call rather than a hand-read of `project.json`.
    `video.hasAudio: null` means "never probed for that", NOT "silent".

    **`video` vs `image` (D-292).** A row has exactly one of them. `video` is
    moving footage (or an audio-only source). `image` is a STILL — width and
    height only, because a still genuinely has no rate, duration or frame
    count; a still is usable with no frame count at all, and `editor_add_clip`
    synthesizes its length. Neither key present means the probe failed.

    `hasThumb` is a boolean, deliberately: the real thumbnail is a base64 JPEG
    data URL that would swamp this response and means nothing to you anyway.

    (D-266.)"""
    import json

    return json.dumps(_op("editor_list_media"), indent=2, default=str)


@mcp.tool()
def editor_reprobe_media(ids: list[str]) -> str:
    """Re-probe media-pool items by id — the repair action for an item
    `editor_list_media` reports as `usable: false` (B-073, fixed).

    A pool item whose FIRST probe failed (an offline drive, a file still
    being written, a transient ffprobe error) is stored with no video
    metadata at all, so `editor_add_clip` refuses it: there is no frame count
    to place a clip with. Before this tool the item was also unrepairable —
    re-importing the identical path deduped to a no-op and nothing ever
    re-read it.

    **The sequence:** fix the underlying file problem (remount the drive,
    restore the file, wait for the write to finish), then call this with the
    ids `editor_list_media` listed in `unusable`. The item is re-probed in
    place and keeps its id, so every clip and reference that already points
    at it stays valid — unlike remove-and-re-import, which mints a new id.

    **Check `stillUnusable` in the response, don't assume it worked.** A
    source that is still unavailable comes back unchanged and honestly
    unusable rather than as a false success you would only discover at the
    next `editor_add_clip`. `unknownIds` lists any id that is not in the pool
    at all (skipped, not an error). Ids you did not name are never touched.

    On demand only, by design: a re-probe is a real ffprobe (plus a thumbnail
    regeneration if the source actually changed), so `editor_list_media` does
    not fire one for every row behind your back. Wraps the same
    `chroma_media_reprobe` command as the Sources panel's own "Re-probe" row
    action."""
    import json

    return json.dumps(_op("editor_reprobe_media", ids=ids), indent=2, default=str)


@mcp.tool()
def editor_list_media_folders() -> str:
    """List the media pool's bins (D-045/D-059) with how many items each one
    holds, plus the count sitting at the pool `root`.

    A bin is a plain path string on an item (`"b-roll"`, `"b-roll/day1"`), not
    a separate entity — `folders` is the union of explicitly-created bins and
    bins implied by an item's own `folder`. The pool root is not a folder and
    never appears in the list; it is what `folder: null` means, and its item
    count is reported separately.

    `editor_list_media` returns the same `folders` list alongside the items, so
    this tool is for when you want the shape of the pool without its
    contents."""
    import json

    return json.dumps(_op("editor_list_media_folders"), indent=2, default=str)


@mcp.tool()
def editor_create_media_folder(path: str) -> str:
    """Create a bin in the media pool — the same "New folder" action the GUI's
    Sources panel offers, wrapping the same `chroma_media_create_folder`
    command.

    `path` is the whole bin path, `/`-separated for a nested bin
    (`"b-roll/day1"`), and the bin may stay empty: that is exactly what this
    command exists for, since a bin implied only by an item's `folder` string
    needs no creating at all (pass `folder` to `editor_import_media` or
    `editor_move_media` instead, and it is registered for you).

    Idempotent — creating a bin that already exists is a no-op, not an error.
    The response's `created` says which of the two happened, and `folders` is
    the full refreshed list."""
    import json

    return json.dumps(_op("editor_create_media_folder", path=path), indent=2, default=str)


@mcp.tool()
def editor_move_media(id: str, folder: str | None) -> str:
    """Re-file one media-pool item into a different bin — the same move the
    GUI's Sources panel performs when a human drags an item onto a bin.

    `id` is a pool item's own id (`editor_list_media` reports them, as does
    `editor_import_media`'s result); a source path is not accepted, since the
    same path can only ever be in the pool once but the id is what the backend
    keys on.

    `folder` is REQUIRED and may be `None`, which means the pool root — the
    argument has no "leave it alone" value on purpose, because `None` already
    means something specific and a caller who omitted it would silently root
    the item. A bin named here that does not exist yet is registered on the
    way, so `editor_create_media_folder` first is optional.

    Filing is pure organisation: it changes nothing about the item's source
    path, its probe, any clip already placed from it, or any render."""
    import json

    return json.dumps(_op("editor_move_media", id=id, folder=folder), indent=2, default=str)


@mcp.tool()
def editor_add_clip(
    track: int,
    media_id: str | None = None,
    source_path: str | None = None,
    source_start: int | None = None,
    duration: int | None = None,
    start_frame: int | None = None,
    at_index: int | None = None,
    ripple: bool = False,
    name: str | None = None,
) -> str:
    """Place a clip from an already-imported media-pool item (`editor_import_media`)
    onto a track, trimmed to `[source_start, source_start+duration)` of the
    source's own frames. Pass either `media_id` or `source_path` to identify
    the pool item.

    Calling this once per KEPT segment, with back-to-back `start_frame`
    values, is how a gap or an unwanted section (a retake, a silence) is cut
    out of a raw recording — you don't place the whole clip and then remove
    a gap; you place only the parts you want, already sitting where they
    should land. `source_start` defaults to 0 and `duration` to the rest of
    the source if omitted. `at_index` inserts at a specific position on the
    track instead of appending; `ripple=True` shifts later clips to make
    room rather than overlapping them.

    STILL IMAGES (D-292). A pool item that is a still (PNG/JPEG/TIFF/WebP/BMP —
    `editor_list_media` reports it with an `image` key instead of `video`) is
    placed exactly like footage, on a VIDEO track. A still has no length of its
    own, so two things differ:

    * `duration` defaults to **3 seconds at the project's rate**, not "the rest
      of the source" — pass `duration` explicitly for any other length, in
      timeline frames. It is the same default a title gets, for the same reason.
    * `source_start` is meaningless on a still (every frame is the same
      picture); leave it at 0. Its reported `sourceLen` is a synthesized ONE
      HOUR of trim headroom, not a real length — so a still can be extended
      about as far as you like, and a `duration` up to that ceiling is accepted.

    A still is refused on an audio track: it is picture with no audio stream."""
    import json

    args: dict = {"track": track, "ripple": ripple}
    if media_id is not None:
        args["mediaId"] = media_id
    if source_path is not None:
        args["sourcePath"] = source_path
    if source_start is not None:
        args["sourceStart"] = source_start
    if duration is not None:
        args["duration"] = duration
    if start_frame is not None:
        args["startFrame"] = start_frame
    if at_index is not None:
        args["atIndex"] = at_index
    if name is not None:
        args["name"] = name
    return json.dumps(_op("editor_add_clip", **args), indent=2, default=str)


@mcp.tool()
def editor_edit_in(
    edit_type: str,
    media_id: str | None = None,
    source_path: str | None = None,
    track: int | None = None,
    at_frame: int | None = None,
    source_start: int | None = None,
    duration: int | None = None,
    name: str | None = None,
) -> str:
    """Edit a media-pool source into the timeline using one of the SEVEN real
    edit types, rather than just placing it at a position (`editor_add_clip`).
    This is the same operation the app's own edit overlay performs when a clip
    is dragged onto the preview, so a human and you produce identical results.

    `edit_type` is one of, and every one of them acts at `at_frame` (the
    playhead by default) on `track` (the first video track by default):

    - `insert` — pushes everything at/after the playhead down to make room,
      splitting whatever clip the playhead is inside. The only type that
      lengthens the timeline by exactly the source's own length.
    - `overwrite` — writes over whatever is there for the new clip's length.
      Clips it lands inside are trimmed or split; clips it swallows whole are
      removed. Nothing's position changes: the timeline stays the same length.
    - `replace` — swaps the clip UNDER THE PLAYHEAD for this source, kept to
      that clip's exact start and exact length (the source is re-cut, not
      retimed). Refused if the source is too short to cover the slot — use
      `fit_to_fill` for that. Note this is NOT `editor_swap_clip_media`, which
      keeps the existing clip and only changes which file it points at,
      preserving its transform/keyframes/grade; `replace` is a new edit.
    - `fit_to_fill` — the same slot as `replace`, but the source keeps its full
      marked length and gets a flat speed ramp calculated to fill the slot
      exactly (see `editor_set_clip_speed`). Refused if that speed would fall
      outside 0.05x–20x.
    - `place_on_top` — puts the clip on the next video track ABOVE the
      destination that has room at the playhead, creating a new topmost video
      track if none has any. For titles, graphics, picture-in-picture. Nothing
      on the track below is disturbed. **The response's `track` is where it
      really landed, which may be a track that did not exist before, and every
      other track's index will have shifted down by one when that happens —
      re-read `editor_get_state` before addressing tracks by index again.**
    - `append` — after the last edit on the destination track, ignoring the
      playhead entirely.
    - `ripple_overwrite` — replaces the clip under the playhead even at a
      different length: a longer source pushes everything after it down, a
      shorter one pulls everything in, so no gap is ever left.

    Identify the source with `media_id` or `source_path` (import it first with
    `editor_import_media`), optionally trimmed to `[source_start,
    source_start+duration)` of its own frames exactly as `editor_add_clip`
    takes them.

    Every one of the seven is ONE undo entry, named for the edit type. A
    refused edit returns a real `error` sentence saying why and changes
    nothing — it is never a silent no-op. `insert` and `ripple_overwrite` are
    additionally refused when a sync-locked track has a clip straddling the
    frame they would ripple from (docs/BUGS.md B-033)."""
    import json

    args: dict = {"editType": edit_type}
    if media_id is not None:
        args["mediaId"] = media_id
    if source_path is not None:
        args["sourcePath"] = source_path
    if track is not None:
        args["track"] = track
    if at_frame is not None:
        args["atFrame"] = at_frame
    if source_start is not None:
        args["sourceStart"] = source_start
    if duration is not None:
        args["duration"] = duration
    if name is not None:
        args["name"] = name
    return json.dumps(_op("editor_edit_in", **args), indent=2, default=str)


@mcp.tool()
def editor_text_fonts() -> str:
    """List the font families a text/title clip can use, and which of them
    this machine actually has a font file for.

    Call this once before your first `editor_add_text_clip` in a session. The
    `key` of each entry is what `font` takes on `editor_add_text_clip` /
    `editor_set_text_clip` — a catalogue key like "sans-bold", NOT a system
    font name like "Helvetica" and NOT a file path. A family whose
    `available` is false has no font file on this machine and will be
    refused: the live preview and the export both read the SAME file, so
    substituting a different face would make the exported title silently
    disagree with the one you previewed.

    Also returns `defaultTitle`, the exact text layer a title gets when you
    omit `font`/`size`/`color`.

    You normally do NOT need to read `group`/`bold`/`italic` off individual
    entries yourself (D-240): `editor_add_text_clip`/`editor_set_text_clip`/
    `editor_import_subtitles`/`editor_set_caption_style` all take `bold`/
    `italic` booleans directly and resolve the right catalogue key for you.
    They are here for the rare case you want to enumerate exactly which keys
    are siblings of which."""
    import json

    return json.dumps(_op("editor_text_fonts"), indent=2, default=str)


@mcp.tool()
def editor_add_text_clip(
    content: str,
    track: int | None = None,
    start_frame: int | None = None,
    duration: int | None = None,
    font: str | None = None,
    bold: bool | None = None,
    italic: bool | None = None,
    size: float | None = None,
    color: str | None = None,
    ripple: bool = False,
    name: str | None = None,
) -> str:
    """Add a TEXT / TITLE clip — real rendered text burned into the picture,
    in both the live preview and `editor_export`. This is what to use for a
    label, a lower third, an intro card or a "BEFORE"/"AFTER" tag; you never
    need to drop to raw `ffmpeg drawtext` for it.

    **Leave `track` out.** Omitted (the recommended call), the title lands on
    a BRAND-NEW video track inserted at index 0 — the top of the compositing
    stack, above everything you already have — in one atomic operation, which
    is exactly what the Edit tab's own Titles button does. A title is an
    OVERLAY: it has to sit on its own layer over the picture, not share a
    track with it. Sharing a track puts the title in a GAP in your footage,
    where it renders over BLACK instead of over the shot (B-129 — this is a
    real bug that shipped in a real project, caused by this parameter having
    been mandatory and this docstring having taught the dance below).

    Pass an explicit `track` only when you specifically want the title on an
    existing video track. It MUST be a video track: a title is picture, and
    putting one on an audio or subtitle track composites into nothing. That
    is now refused with a real message rather than silently accepted.

    **A title is otherwise an ordinary clip on an ordinary VIDEO track**, not
    a special track type — the same shape Resolve and Premiere use. Track
    index order is compositing z-order (lower index = on top). Every ordinary
    clip tool works on the title unchanged — `editor_move_clip`,
    `editor_trim_clip`, `editor_split_clip`, `editor_remove_clip`,
    `editor_set_clip_fade`.

    **The result reports the track it really landed on, `createdTrack` (did
    this call make a new one) and the new `trackCount`.** A new track at index
    0 renumbers every existing track by one, so re-read indices from the
    result — or from `editor_get_state` — before your next call rather than
    reusing indices you held from before.

    `content` is a SINGLE line — multi-line titles are not supported yet and
    a `\\n` is refused rather than silently flattened. Add a second title
    clip on a second track for a second line.

    `duration` is in TIMELINE frames (default: 3 seconds at the project's own
    rate). `start_frame` places it at an exact timeline frame (default:
    appended after whatever is already on that track); `ripple=True` shifts
    later clips on that track out of the way instead of refusing to overlap.

    `font` is a catalogue KEY from `editor_text_fonts` (default "sans-bold").
    `size` is a fraction of the OUTPUT FRAME'S HEIGHT, not pixels — 0.12 (the
    default) is a big title, 0.05 is a modest caption. Deliberately a
    fraction, so the same title renders identically at every preview quality
    and at full export resolution. `color` is `#RGB` or `#RRGGBB`.

    `bold`/`italic` toggle weight/slant WITHOUT you having to know which raw
    catalogue key is which (D-240) — pass either on top of any `font`
    ("sans", "serif", "condensed", "mono" all have real bold/italic/bold-italic
    faces; omitting `font` composes against the current/default family). A
    family with no such face on this machine (`impact`, `sans-black` — neither
    ships an italic, and both are already at their own maximum weight) just
    ignores whichever toggle it cannot honour rather than erroring.

    **What else you can do to a title:** its OPACITY and POSITION are
    ordinary clip properties — `editor_set_clip_transform` with
    `position_x`/`position_y` (fractions of the frame, 0,0 = centred) and
    `opacity`, and `editor_set_clip_keyframes` animates either of them, the
    same way it animates a video clip's. `editor_set_clip_fade` fades it in
    and out.

    **What you cannot do (it is refused, not ignored):** `scale`, `rotation`,
    `crop_*` and `box_width`/`box_height` do NOT apply to a title in either
    the preview or the export. Use this tool's own `size` to make the text
    bigger — `editor_set_clip_transform` will return an error rather than
    store a value that would render nothing."""
    import json

    # `track` omitted is meaningful (a new video track on top), so it is only
    # sent when the caller actually named one.
    args: dict = {"content": content, "ripple": ripple}
    for key, val in (
        ("track", track),
        ("startFrame", start_frame),
        ("duration", duration),
        ("font", font),
        ("bold", bold),
        ("italic", italic),
        ("size", size),
        ("color", color),
        ("name", name),
    ):
        if val is not None:
            args[key] = val
    return json.dumps(_op("editor_add_text_clip", **args), indent=2, default=str)


@mcp.tool()
def editor_set_text_clip(
    track: int,
    clip: int,
    content: str | None = None,
    font: str | None = None,
    bold: bool | None = None,
    italic: bool | None = None,
    size: float | None = None,
    color: str | None = None,
) -> str:
    """Change an existing TEXT clip's own text properties. Omitted fields keep
    their current value — this reads the clip back first and merges, so
    changing the colour never resets the text.

    Refused if `track`/`clip` names a media clip rather than a title (a media
    clip has no text layer to patch), if the track is locked, if `content`
    contains a newline (single-line only for now), or if `font` names a
    family this machine has no font file for (see `editor_text_fonts`).

    `bold`/`italic` (D-240) toggle weight/slant against whatever `font` ends
    up being — pass `font` in the SAME call to change family and weight/slant
    together, or omit `font` to toggle bold/italic on the clip's CURRENT
    family without restating it (a bold-only call never resets the family).

    `size` is a fraction of the output frame's HEIGHT, `color` is
    `#RGB`/`#RRGGBB`. For a title's POSITION, OPACITY, fade or keyframes use
    the ordinary clip tools (`editor_set_clip_transform`,
    `editor_set_clip_keyframes`, `editor_set_clip_fade`) — a title is a real
    clip and those all work on it."""
    import json

    args: dict = {"track": track, "clip": clip}
    for key, val in (
        ("content", content),
        ("font", font),
        ("bold", bold),
        ("italic", italic),
        ("size", size),
        ("color", color),
    ):
        if val is not None:
            args[key] = val
    return json.dumps(_op("editor_set_text_clip", **args), indent=2, default=str)


@mcp.tool()
def editor_import_subtitles(
    path: str,
    offset_frames: int | None = None,
    font: str | None = None,
    bold: bool | None = None,
    italic: bool | None = None,
    size: float | None = None,
    color: str | None = None,
    box_enabled: bool | None = None,
    box_color: str | None = None,
    box_opacity: float | None = None,
    align: str | None = None,
    position_x: float | None = None,
    position_y: float | None = None,
    animation: str | None = None,
    active_color: str | None = None,
    spoken_color: str | None = None,
    upcoming_color: str | None = None,
    highlight_color: str | None = None,
    highlight_opacity: float | None = None,
    highlight_pad_x: float | None = None,
    highlight_pad_y: float | None = None,
    enter_secs: float | None = None,
    enter_rise: float | None = None,
    word_gap: float | None = None,
) -> str:
    """Import a SubRip (.srt) or WebVTT (.vtt) subtitle file as a new SUBTITLE
    track, with every cue placed and timed from the file.

    Adds ONE new track at the bottom of the track list and fills it with one
    caption clip per cue — a single undoable step, not one per cue. Returns the
    new track's index and how many cues landed.

    **TTML/XML/embedded-MXF subtitles are NOT supported** (D-228). That is a
    deliberate refusal, not an oversight: TTML cue times only resolve correctly
    once `ttp:timeBase`/`ttp:frameRate` are honoured, and a subset parser would
    import real broadcast files with silently wrong timings. Convert to .srt
    first.

    Timings come from the file and are converted to this project's own frame
    rate by the backend, so they cannot drift from what the GUI importer would
    produce. `offset_frames` shifts every cue — pass the playhead frame to drop
    a file in mid-timeline rather than at 00:00.

    The style arguments set the whole TRACK's style (the reference NLE's "Track
    Style"), which is how a whole imported file is styled in one action; every
    one of them is optional and defaults sensibly. Use
    `editor_set_caption_style` afterwards to change it, or to override one
    single cue.

    `bold`/`italic` (D-240) toggle weight/slant against `font` (or the
    catalogue default if `font` is omitted) — the same composition
    `editor_set_caption_style`'s own `bold`/`italic` use.

    `animation` and the per-word arguments (`active_color`, `spoken_color`,
    `upcoming_color`, `highlight_color`, `highlight_opacity`,
    `highlight_pad_x`, `highlight_pad_y`, `enter_secs`, `enter_rise`,
    `word_gap`) mean exactly what they mean on `editor_set_caption_style` — see
    that tool for each one. They are here so an imported file can land already
    animated in one call. Pass the literal string "default" to a per-word
    colour to CLEAR it rather than set it.

    A caption is positioned entirely by its style — `position_x`/`position_y`
    are normalised 0–1 anchors, `size` is a fraction of the frame HEIGHT.
    `editor_set_clip_transform` does NOT apply to captions."""
    import json

    args: dict = {"path": path}
    if offset_frames is not None:
        args["offsetFrames"] = offset_frames
    for key, val in (
        ("font", font),
        ("bold", bold),
        ("italic", italic),
        ("size", size),
        ("color", color),
        ("boxEnabled", box_enabled),
        ("boxColor", box_color),
        ("boxOpacity", box_opacity),
        ("align", align),
        ("positionX", position_x),
        ("positionY", position_y),
        ("animation", animation),
        ("highlightOpacity", highlight_opacity),
        ("highlightPadX", highlight_pad_x),
        ("highlightPadY", highlight_pad_y),
        ("enterSecs", enter_secs),
        ("enterRise", enter_rise),
        ("wordGap", word_gap),
    ):
        if val is not None:
            args[key] = val
    # The per-word colours need a way to be CLEARED, not just set — "no accent
    # on the spoken words" is a real style, and an omitted argument cannot mean
    # it (omitted means "leave alone"). The literal string "default" is that
    # clear token, sent down as JSON null.
    for key, val in (
        ("activeColor", active_color),
        ("spokenColor", spoken_color),
        ("upcomingColor", upcoming_color),
        ("highlightColor", highlight_color),
    ):
        if val is not None:
            args[key] = None if val == "default" else val
    return json.dumps(_op("editor_import_subtitles", **args), indent=2, default=str)


@mcp.tool()
def editor_export_subtitles(track: int, path: str) -> str:
    """Write one subtitle track's captions out as a standalone .srt or .vtt
    file (the format is chosen by `path`'s extension; anything else writes
    SubRip).

    This is the SIDECAR half of delivering subtitles. It is not needed to get
    captions into the video — `editor_export` already burns every visible
    subtitle track into the rendered picture. Use this when a platform wants
    the caption file separately.

    Cues are written in timeline order regardless of the order they were added
    in. Refused if `track` is not a subtitle track."""
    import json

    return json.dumps(_op("editor_export_subtitles", track=track, path=path), indent=2, default=str)


@mcp.tool()
def editor_generate_captions_from_transcript(
    path: str | None = None,
    media_id: str | None = None,
    source_path: str | None = None,
    offset_frames: int | None = None,
    max_words: int | None = None,
    max_duration_s: float | None = None,
    max_pause_gap_s: float | None = None,
    force: bool = False,
    font: str | None = None,
    size: float | None = None,
    color: str | None = None,
    box_enabled: bool | None = None,
    box_color: str | None = None,
    box_opacity: float | None = None,
    align: str | None = None,
    position_x: float | None = None,
    position_y: float | None = None,
) -> str:
    """Auto-caption a file straight from its D-189 transcript — the timed-word
    follow-up to `editor_import_subtitles` (D-229/D-238). Same result (a new
    SUBTITLE track, one caption clip per cue, one undoable step) with no
    hand-authored `.srt` required: this transcribes the file itself and groups
    the timed words into cues.

    **Auto-starts the transcript job and returns its `state`** — the same
    start-then-poll shape `editor_get_transcript` uses (`chroma::control`'s
    bridge caps at 20 s; a transcript takes tens of seconds). `state:
    "running"` or `"idle"` means: wait a few seconds and call this tool again
    with the SAME file — results are cached by path, so a repeat call costs
    nothing once done and captions are generated on that same call. `force`
    re-transcribes even if a result is cached (the file changed on disk).

    Identify the file with `path` (any absolute path, does not need to be
    imported first), or `media_id`/`source_path` for a project media-pool
    item — same resolution rule as `editor_get_transcript`.

    **Cue grouping** (see `packages/editor/src/captionsFromTranscript.ts` for
    the full reasoning): a transcript SEGMENT is always a cue boundary
    (the transcript's own segment breaks are reused as sentence/clause
    boundaries); within one segment a cue breaks at `max_words` words
    (default 8), `max_duration_s` seconds of source span (default 3.0), or a
    pause to the next word of at least `max_pause_gap_s` (default 0.7) —
    whichever comes first. Override any of the three for unusually fast/slow
    or unusually pause-heavy speech.

    Refused (with a real explanation) if the transcript came back with no
    word-level timestamps at all (silent/music-only footage, or a prior
    `editor_get_transcript` call that passed `word_timestamps=False`).

    `offset_frames` shifts every cue — pass the playhead frame to drop the
    track in mid-timeline rather than at 00:00. The style arguments are
    identical to `editor_import_subtitles`'s own (they set the whole new
    TRACK's style); use `editor_set_caption_style` afterwards to change it."""
    import json

    args = _media_args(path, media_id, source_path)
    if offset_frames is not None:
        args["offsetFrames"] = offset_frames
    if max_words is not None:
        args["maxWords"] = max_words
    if max_duration_s is not None:
        args["maxDurationS"] = max_duration_s
    if max_pause_gap_s is not None:
        args["maxPauseGapS"] = max_pause_gap_s
    if force:
        args["force"] = True
    for key, val in (
        ("font", font),
        ("size", size),
        ("color", color),
        ("boxEnabled", box_enabled),
        ("boxColor", box_color),
        ("boxOpacity", box_opacity),
        ("align", align),
        ("positionX", position_x),
        ("positionY", position_y),
    ):
        if val is not None:
            args[key] = val
    return json.dumps(
        _op("editor_generate_captions_from_transcript", **args), indent=2, default=str
    )


@mcp.tool()
def editor_add_caption(
    track: int,
    text: str,
    start_frame: int | None = None,
    duration: int | None = None,
) -> str:
    """Add ONE caption to an existing subtitle track — for writing captions by
    hand rather than importing a file.

    `track` must already be a subtitle track (`editor_add_track` with
    kind="subtitle"); adding a caption to a video or audio track is refused,
    because the compositor only ever looks for captions on subtitle tracks and
    it would be an invisible clip.

    Unlike a TITLE (`editor_add_text_clip`), `text` MAY contain newlines — a
    two-line cue is normal and renders identically in the preview and the
    export. `duration` defaults to 2 seconds' worth of frames.

    The caption's look comes from its track's style, not from this call — see
    `editor_set_caption_style`."""
    import json

    args: dict = {"track": track, "text": text}
    if start_frame is not None:
        args["startFrame"] = start_frame
    if duration is not None:
        args["duration"] = duration
    return json.dumps(_op("editor_add_caption", **args), indent=2, default=str)


@mcp.tool()
def editor_set_caption(track: int, clip: int, text: str) -> str:
    """Change one existing caption's text. Newlines are allowed (that is what
    makes it a caption rather than a title).

    Refused if `track`/`clip` names something that is not a caption, or if the
    track is locked. A caption's TIMING is its clip's own timing — move or trim
    it with the ordinary clip tools (`editor_move_clip`, `editor_trim_clip`,
    `editor_split_clip`), which all work on a caption exactly as on any other
    clip."""
    import json

    return json.dumps(
        _op("editor_set_caption", track=track, clip=clip, text=text), indent=2, default=str
    )


@mcp.tool()
def editor_list_caption_presets() -> str:
    """List the styled caption looks the Styles library offers (D-243).

    Each entry carries its `id` (what `editor_add_caption_preset` takes), a
    label and group, a one-line description, the animation kind it uses, its
    provenance `note`, and the full `style` it would apply.

    This is the SAME list the Edit tab's Captions panel shows, read from the
    same place — an agent can reach every look a human can.

    Static data, but read through the app so it can never drift from what the
    panel is actually offering in this build."""
    import json

    return json.dumps(_op("editor_list_caption_presets"), indent=2, default=str)


@mcp.tool()
def editor_add_caption_preset(
    preset: str,
    track: int | None = None,
    text: str | None = None,
    start_frame: int | None = None,
    duration: int | None = None,
    place_caption: bool = True,
) -> str:
    """Apply a styled caption preset, creating what it needs (D-243).

    The one-call way to get a good-looking caption onto the timeline: it styles
    a subtitle track with the preset and, by default, drops a caption on it so
    the look is immediately visible.

    - `preset` — an id from `editor_list_caption_presets`. An unknown id is
      refused with the valid ids listed.
    - `track` — an existing SUBTITLE track to style. Omitted: the first
      subtitle track is reused, or a new one is created if there is none.
    - `text` — the caption to place. Omitted, a readable sample line is used,
      chosen so a per-word animation actually reads as animated.
    - `start_frame` — where to place it. Omitted: the playhead.
    - `duration` — TIMELINE frames. Omitted: 3 seconds, which is long enough
      that an animated preset resolves rather than flickering.
    - `place_caption` — pass False to restyle a track that already has cues on
      it without adding another.

    A preset is nothing but a style: everything it sets stays editable
    afterwards with `editor_set_caption_style`, and the whole thing is one
    undo step.

    Presets adapted from HyperFrames' caption catalogue (Apache-2.0,
    github.com/heygen-com/hyperframes) are reimplemented natively — see each
    preset's `note` for what differs and why (D-244)."""
    import json

    args: dict = {"preset": preset, "placeCaption": place_caption}
    if track is not None:
        args["track"] = track
    if text is not None:
        args["text"] = text
    if start_frame is not None:
        args["startFrame"] = start_frame
    if duration is not None:
        args["duration"] = duration
    return json.dumps(_op("editor_add_caption_preset", **args), indent=2, default=str)


@mcp.tool()
def editor_set_caption_style(
    track: int,
    clip: int | None = None,
    use_track_style: bool | None = None,
    font: str | None = None,
    bold: bool | None = None,
    italic: bool | None = None,
    size: float | None = None,
    color: str | None = None,
    box_enabled: bool | None = None,
    box_color: str | None = None,
    box_opacity: float | None = None,
    box_padding: float | None = None,
    line_spacing: float | None = None,
    align: str | None = None,
    position_x: float | None = None,
    position_y: float | None = None,
    animation: str | None = None,
    active_color: str | None = None,
    spoken_color: str | None = None,
    upcoming_color: str | None = None,
    highlight_color: str | None = None,
    highlight_opacity: float | None = None,
    highlight_pad_x: float | None = None,
    highlight_pad_y: float | None = None,
    enter_secs: float | None = None,
    enter_rise: float | None = None,
    word_gap: float | None = None,
) -> str:
    """Style a subtitle track — font, size, colour, background box, position
    and ANIMATION — or override the style of ONE caption on it.

    With `clip` omitted this sets the TRACK's style, which every caption on it
    uses. That is almost always what you want: a whole imported file is styled
    once. With `clip` given it sets that one cue's own override; pass
    `use_track_style=True` with a `clip` to drop the override and go back to
    the track's style.

    Omitted fields keep their current value.

    - `font` — a catalogue key from `editor_text_fonts` ("sans-bold", …), not a
      system font name. A family this machine has no file for is refused here
      rather than failing the export, because the preview and the export must
      read the same file.
    - `bold` / `italic` (D-240) — toggle weight/slant against whatever `font`
      ends up being: pass `font` in the SAME call to change family and
      weight/slant together, or omit `font` to toggle bold/italic on the
      CURRENT style's family (the cue's own if it has an override, else the
      track's) without restating it. A family with no such face on this
      machine (`impact`, `sans-black`) ignores whichever toggle it cannot
      honour rather than erroring.
    - `size` — fraction of the frame HEIGHT (0.055 ≈ a normal subtitle).
    - `color` / `box_color` — `#RGB` or `#RRGGBB`.
    - `box_opacity` — 0–1. `box_enabled=False` removes the background entirely.
    - `box_padding` / `line_spacing` — fractions of the resolved font size.
    - `align` — "left" | "center" | "right"; each LINE of a cue is aligned
      independently, which is the subtitle convention.
    - `position_x` / `position_y` — normalised 0–1 anchors. `position_y` is
      where the LAST line sits; extra lines of a multi-line cue stack UPWARD
      from it, so a cue growing to two lines keeps its bottom line put.

    These are the only geometry a caption has: `editor_set_clip_transform`,
    fades and opacity keyframes do NOT apply to a caption (D-228 — the export
    draws it with ffmpeg's `drawtext`, which cannot scale, rotate or crop a
    text box, so offering those would let the preview show something the export
    cannot reproduce).

    ## Animation (D-243)

    An animated caption is drawn WORD BY WORD. Word timings are derived from
    each word's length across the cue — a `.srt` carries no word timings — so
    they need no extra input.

    - `animation` — "none" (D-229's static caption, the default) | "highlight"
      (line stays up, the live word gets a filled box) | "karaoke" (line stays
      up, words recolour as they are spoken) | "slam" (one word at a time,
      sliding in from alternating sides) | "build" (the line assembles word by
      word). An unknown value is ignored rather than stored.
    - `active_color` / `spoken_color` / `upcoming_color` — per-word fills.
      Pass the literal string "default" to clear one back to the caption's own
      `color` (omitting it leaves it alone, which is a different thing).
    - `highlight_color` — the box behind the live word; "default" removes the
      box entirely, which is what separates a plain karaoke recolour from a
      highlight.
      `highlight_opacity` 0–1, `highlight_pad_x`/`highlight_pad_y` as fractions
      of the font size.
    - `enter_secs` — how long one word's entrance takes.
    - `enter_rise` — how far a word rises into place ("build" only), as a
      fraction of the font size.
    - `word_gap` — tracking between words, as a fraction of the font size. An
      animated caption positions each word itself, so this stands in for a
      space.

    **Deliberately absent: per-word SCALE.** ffmpeg's `fontsize` is the input
    to the very measurement that makes the preview and the export agree
    (D-212), so animating it would re-open a divergence D-229 closed. The
    highlight box is square and switches on/off per word for the same class of
    reason — `drawbox` has neither a corner radius nor an alpha expression.

    Every one of these is a plain style field, so a preset applied with
    `editor_add_caption_preset` can be adjusted afterwards with this tool."""
    import json

    args: dict = {"track": track}
    if clip is not None:
        args["clip"] = clip
    if use_track_style is not None:
        args["useTrackStyle"] = use_track_style
    for key, val in (
        ("font", font),
        ("bold", bold),
        ("italic", italic),
        ("size", size),
        ("color", color),
        ("boxEnabled", box_enabled),
        ("boxColor", box_color),
        ("boxOpacity", box_opacity),
        ("boxPadding", box_padding),
        ("lineSpacing", line_spacing),
        ("align", align),
        ("positionX", position_x),
        ("positionY", position_y),
        ("animation", animation),
        ("highlightOpacity", highlight_opacity),
        ("highlightPadX", highlight_pad_x),
        ("highlightPadY", highlight_pad_y),
        ("enterSecs", enter_secs),
        ("enterRise", enter_rise),
        ("wordGap", word_gap),
    ):
        if val is not None:
            args[key] = val
    # The per-word colours need a way to be CLEARED, not just set — "no accent
    # on the spoken words" is a real style, and an omitted argument cannot mean
    # it (omitted means "leave alone"). The literal string "default" is that
    # clear token, sent down as JSON null.
    for key, val in (
        ("activeColor", active_color),
        ("spokenColor", spoken_color),
        ("upcomingColor", upcoming_color),
        ("highlightColor", highlight_color),
    ):
        if val is not None:
            args[key] = None if val == "default" else val
    return json.dumps(_op("editor_set_caption_style", **args), indent=2, default=str)


@mcp.tool()
def editor_add_adjustment_clip(
    track: int | None = None,
    start_frame: int | None = None,
    duration: int | None = None,
    exposure: float | None = None,
    contrast: float | None = None,
    saturation: float | None = None,
    temperature: float | None = None,
    tint: float | None = None,
    ripple: bool = False,
    name: str | None = None,
) -> str:
    """Add an ADJUSTMENT CLIP — one colour correction applied top-down to
    EVERY clip beneath it on lower-priority tracks, for the span it covers.
    This is the tool for "warm the whole second half up", "desaturate this
    section", "lift the contrast across these three shots" — one clip
    instead of grading each shot individually (D-229).

    **It contributes no picture of its own.** It is an operator on whatever
    is composited under it, so the frame you see is your footage, corrected.
    Adding one changes nothing at all until you set a parameter.

    **Which clips it reaches is decided ENTIRELY by track index, and this is
    the one thing to get right.** Track index order is z-order: lower index =
    higher priority = on top. An adjustment clip affects every visible video
    track with a HIGHER index than its own — i.e. everything below it. So
    the topmost track grades the whole edit; an adjustment clip on the bottom
    track affects nothing and is the single most common way to be surprised by
    this tool.

    **So leave `track` out.** Omitted (the recommended call), the clip lands
    on a BRAND-NEW video track inserted at index 0 — the top of the stack, so
    it grades everything — in one atomic operation, which is what the Edit
    tab's own Effects button does. Pass an explicit `track` only to target an
    existing video track; it MUST be a video track, and an audio or subtitle
    one is now refused with a real message rather than silently accepted
    (B-129). The result reports the track it really landed on, `createdTrack`
    and the new `trackCount` — a new track at index 0 renumbers every existing
    track, so re-read indices from the result before your next call.

    **The five parameters**, each `-1.0..1.0` and `0` = no change. They are
    the Edit tab's own primary correction, not the Colorist's full grading
    stack (that is a separate surface with its own `set_*` tools, and it
    applies to ONE clip; this applies to a whole region of the timeline):
      `exposure`     — stops; a gain of 2^value. +0.5 is half a stop up.
      `contrast`     — about the mid-grey pivot. +1 doubles it, -1 goes flat.
      `saturation`   — -1 is greyscale, +1 is double.
      `temperature`  — positive is WARMER (red up, blue down), negative cooler.
      `tint`         — positive is MAGENTA (green down), negative greener.

    `duration` is in TIMELINE frames (default: 3 seconds at the project's own
    rate) — this is the span of the edit the correction covers.
    `start_frame` places it at an exact timeline frame (default: appended
    after whatever is already on that track); `ripple=True` shifts later
    clips on that track out of the way instead of refusing to overlap.

    **Stacking works**: two adjustment clips on two tracks compose, the lower
    one applying first. Every ordinary clip tool works on it unchanged —
    `editor_move_clip`, `editor_trim_clip`, `editor_split_clip`,
    `editor_remove_clip`.

    **Its OPACITY is how strongly the correction is mixed in** (`1.0` = full,
    `0.5` = half), via the ordinary `editor_set_clip_transform`. It is read
    STATICALLY: keyframing it or fading the clip will NOT animate the
    correction, in either the preview or the export, because ffmpeg fixes
    these filter coefficients when the filter starts. Position, scale,
    rotation and crop do not apply at all — the correction is full-frame.

    The preview and `editor_export` run the same maths, verified against real
    ffmpeg to within 1/255."""
    import json

    # As in `editor_add_text_clip`: an omitted `track` is meaningful (a new
    # video track on top), so it is only sent when the caller named one.
    args: dict = {"ripple": ripple}
    for key, val in (
        ("track", track),
        ("startFrame", start_frame),
        ("duration", duration),
        ("exposure", exposure),
        ("contrast", contrast),
        ("saturation", saturation),
        ("temperature", temperature),
        ("tint", tint),
        ("name", name),
    ):
        if val is not None:
            args[key] = val
    return json.dumps(_op("editor_add_adjustment_clip", **args), indent=2, default=str)


@mcp.tool()
def editor_set_adjustment_clip(
    track: int,
    clip: int,
    exposure: float | None = None,
    contrast: float | None = None,
    saturation: float | None = None,
    temperature: float | None = None,
    tint: float | None = None,
) -> str:
    """Change an existing ADJUSTMENT CLIP's colour correction. Omitted
    parameters keep their current value — this merges against the clip's
    existing correction, so changing saturation never resets exposure.

    Each parameter is `-1.0..1.0`, `0` = no change; see
    `editor_add_adjustment_clip` for what each one does. Values outside the
    range are clamped rather than refused.

    Refused if `track`/`clip` names a clip that is not an adjustment clip, or
    if the track is locked.

    To change WHICH clips the correction reaches, move the adjustment clip to
    a different track (`editor_move_clip`) — it affects every visible video
    track with a higher index than its own. To change the SPAN it covers,
    trim or move it like any other clip. To change how strongly it is mixed
    in, set its `opacity` with `editor_set_clip_transform`."""
    import json

    args: dict = {"track": track, "clip": clip}
    for key, val in (
        ("exposure", exposure),
        ("contrast", contrast),
        ("saturation", saturation),
        ("temperature", temperature),
        ("tint", tint),
    ):
        if val is not None:
            args[key] = val
    return json.dumps(_op("editor_set_adjustment_clip", **args), indent=2, default=str)


@mcp.tool()
def editor_split_clip(track: int, clip: int, at_frame: int) -> str:
    """Split one clip on the timeline into two, at an exact TIMELINE frame.
    `track`/`clip` are the 0-based indices from `get_timeline`."""
    import json

    return json.dumps(_op("editor_split_clip", track=track, clip=clip, atFrame=at_frame), indent=2, default=str)


@mcp.tool()
def editor_remove_clip(track: int, clip: int) -> str:
    """Remove one clip from the timeline, leaving a gap in its place. Follow
    with `editor_remove_gap` to ripple-close the gap, or leave it if the gap
    is wanted (e.g. to hold a still frame of nothing).

    If the clip is one half of an A/V link group, removing it removes its
    linked partner too (the same as `editor_swap_clip_media`'s own A/V link
    but the OPPOSITE of that tool's behavior — that one deliberately does
    NOT propagate; this one deliberately does, matching the GUI's own
    delete). The response's `removed` list names every clip actually taken
    out, `{track, clip, id}` each, so a second deletion shows up here
    instead of only in a later `get_timeline` read (B-221)."""
    import json

    return json.dumps(_op("editor_remove_clip", track=track, clip=clip), indent=2, default=str)


@mcp.tool()
def editor_remove_gap(track: int, frame: int) -> str:
    """Ripple-delete the empty gap on `track` at `frame` (any frame inside
    the gap works), shifting every later clip on that track earlier to close
    it. Does nothing to other tracks."""
    import json

    return json.dumps(_op("editor_remove_gap", track=track, frame=frame), indent=2, default=str)


@mcp.tool()
def editor_trim_clip(track: int, clip: int, edge: str, delta: int, ripple: bool = False) -> str:
    """Trim a clip's `edge` ("start" or "end") by `delta` frames — positive
    shortens the clip, negative extends it back into previously-trimmed
    source material (up to the source's own bounds).

    `ripple=False` (the default, and the behaviour this tool has always had):
    only this clip changes. Shortening leaves a real gap; extending is refused
    outright if the neighbour is in the way.

    `ripple=True` (D-235): everything after this clip on the SAME track shifts
    to follow the new out point, so no gap is opened and a neighbour no longer
    blocks the trim — it gets pushed instead. A head ripple leaves the clip's
    `start_frame` where it is and pulls the rest of the track in behind it.
    Sync-locked tracks ripple with it; a clip straddling the ripple point on
    one of them refuses the whole op rather than being split (B-033).

    This is the same edit the GUI's Alt/Option-drag on a clip edge performs
    (D-235's context-sensitive trim tool)."""
    import json

    return json.dumps(
        _op("editor_trim_clip", track=track, clip=clip, edge=edge, delta=delta, ripple=ripple),
        indent=2,
        default=str,
    )


@mcp.tool()
def editor_roll_edit(track: int, clip: int, delta: int) -> str:
    """Roll the edit point at the END of `clip`: move the outgoing clip's out
    point and the incoming clip's in point together by `delta` TIMELINE frames
    (positive = later), so one side lengthens by exactly what the other loses
    and the sequence's total duration does not change (D-235).

    `clip` is the OUTGOING side — the clip BEFORE the cut. There must be a clip
    butted exactly against its end; across a gap there is no edit point to roll
    and the call does nothing. Clamped to whichever side runs out of source
    media first, and refused whole if neither side can absorb the delta.

    A/V link groups on either side roll in lockstep. This is the same edit the
    GUI performs when you Alt/Option-drag an edge that IS an edit point."""
    import json

    return json.dumps(_op("editor_roll_edit", track=track, clip=clip, delta=delta), indent=2, default=str)


@mcp.tool()
def editor_slide_clip(track: int, clip: int, delta: int) -> str:
    """Slide a clip along the timeline by `delta` TIMELINE frames WITHOUT
    changing its own duration or its source window — its neighbours absorb the
    movement instead: the clip before it lengthens/shortens at its out point,
    the clip after it at its in point (D-235). "A slide is a roll between 3
    clips."

    Contrast the two neighbouring tools: `editor_move_clip` changes where the
    clip is and leaves the neighbours alone (opening or closing real gaps);
    `editor_slip_clip` changes what the clip SHOWS and moves nothing. A slide
    changes only where it sits between untouched cuts on either side.

    A side with no touching neighbour is clamped by the real free space there
    instead, so a slide still works at the head or tail of a track. Refused if
    there is neither a neighbour nor an obstacle on either side — that is a
    plain move, so use `editor_move_clip`. This is the same edit the GUI
    performs when you Alt/Option-drag the LOWER half of a clip's body."""
    import json

    return json.dumps(_op("editor_slide_clip", track=track, clip=clip, delta=delta), indent=2, default=str)


@mcp.tool()
def editor_slip_clip(track: int, clip: int, delta: int) -> str:
    """Slip a clip's SOURCE window WITHOUT moving it on the timeline: unlike
    `editor_trim_clip`, `start_frame` and `duration` both stay exactly fixed
    — only which part of the source media plays changes. `delta` shifts
    `source_start` by that many TIMELINE frames (positive = later source
    material, negative = earlier), clamped to the source's own `[0,
    source_len)` bounds.

    A clip that is part of an A/V link group slips in lockstep with the rest
    of the group (same reason `editor_trim_clip` does) — unlink it in the
    GUI's Unlink button first for an independent slip of just one half."""
    import json

    return json.dumps(_op("editor_slip_clip", track=track, clip=clip, delta=delta), indent=2, default=str)


@mcp.tool()
def editor_swap_clip_media(
    track: int,
    clip: int,
    media_id: str | None = None,
    source_path: str | None = None,
) -> str:
    """Replace a clip's underlying source media in place — pass either
    `media_id` or `source_path` to identify the NEW already-imported
    (`editor_import_media`) pool item. Everything else about the clip is
    preserved exactly: `start_frame`, its full compositing transform
    (position/scale/box size/rotation/crop/opacity), keyframes, fades, and
    its A/V link group (the swap does NOT propagate to a linked clip — the
    two halves no longer necessarily share anything once one's file is
    replaced).

    If the new source is SHORTER than the clip's current source window,
    `source_start` is kept exactly where it was (if it still fits) and
    `duration` is shrunk to fit what remains — the clip's timeline footprint
    can shrink as a result (never `start_frame` itself), rather than this
    call being refused. `source_fps` is always re-read from the NEW source's
    own real probed rate, never carried over from the old one — before
    calling this on a clip whose length matters, consider whether you also
    want to re-trim/re-check it afterward with `get_timeline`.

    The new source may be a STILL IMAGE (D-292), and swapping TO one never
    shortens the clip: a still's synthesized extent is an hour. Swapping AWAY
    from one to real footage can, by the shrink rule above."""
    import json

    args: dict = {"track": track, "clip": clip}
    if media_id is not None:
        args["mediaId"] = media_id
    if source_path is not None:
        args["sourcePath"] = source_path
    return json.dumps(_op("editor_swap_clip_media", **args), indent=2, default=str)


@mcp.tool()
def editor_move_clip(
    from_track: int,
    clip: int,
    start_frame: int,
    to_track: int | None = None,
    ripple: bool = False,
) -> str:
    """Move a clip to `start_frame`, optionally onto a different track
    (`to_track`; default: stays on `from_track`). `ripple=True` shifts later
    clips out of the way rather than overlapping them."""
    import json

    args: dict = {"fromTrack": from_track, "clip": clip, "startFrame": start_frame, "ripple": ripple}
    if to_track is not None:
        args["toTrack"] = to_track
    return json.dumps(_op("editor_move_clip", **args), indent=2, default=str)


@mcp.tool()
def editor_add_track(track_kind: str = "video", index: int | None = None) -> str:
    """Add a new, empty track to the timeline. `track_kind` is "video",
    "audio" or "subtitle". Returns the new track's index.

    A "subtitle" track is what `editor_add_caption` needs (D-228); it takes no
    part in the video z-order and nothing in the audio mix, so the paragraph
    below about compositing order does not apply to one. To bring in a whole
    `.srt`/`.vtt` file instead, use `editor_import_subtitles`, which creates
    its own track.

    **Track index order IS compositing z-order — lower index paints on top
    (D-086).** With `index` omitted this APPENDS at the highest index, i.e.
    the BOTTOM of the stack, which is NOT where a title/overlay wants to be.

    `index` (B-115) puts the new track at an exact position instead: `0` is
    the top of the compositing stack (above all existing footage — what you
    want for a title, an overlay or an adjustment clip), and `len(tracks)` is
    the same append you get by omitting it. Anything outside `0..len(tracks)`
    is refused with an error rather than silently appending. It is a
    convenience, not a new primitive — it runs exactly the `editor_add_track`
    + `editor_move_track` pair this docstring used to tell you to run
    yourself, which is also the pair the human GUI runs when a clip is dragged
    above the top track. Two undo entries either way; `editor_move_track`
    remains the tool for reordering tracks that already exist."""
    import json

    args: dict[str, object] = {"trackKind": track_kind}
    if index is not None:
        args["index"] = index
    return json.dumps(_op("editor_add_track", **args), indent=2, default=str)


@mcp.tool()
def editor_move_track(from_index: int, to_index: int) -> str:
    """Reorder the track LIST itself — move the track currently at
    `from_index` so it ends up at `to_index`, shifting every track between
    the two by one to close the gap (exactly `Vec::remove(from)` then
    `insert(to, _)` — the identical primitive the GUI's own drag-to-reorder
    track headers already use, `apelles_timeline::Timeline::move_track`).

    **Track index order IS compositing z-order — lower index paints on
    top (D-086).** `editor_add_track` only ever appends at the highest index
    (the bottom of the stack), so this is the tool that gets a newly-added
    track compositing ABOVE existing footage: the normal real-world sequence
    for adding a title/overlay to a project that already has content is
    `editor_add_track()` (lands at, say, index 2 on a 2-track project) then
    `editor_move_track(from_index=2, to_index=0)` to bring it to the top,
    BEFORE placing a clip on it — see `editor_add_text_clip`'s own docstring
    for the full recipe.

    Both indices must name an EXISTING track (refused with an error
    otherwise, not a silent no-op) — this only reorders, it never creates or
    deletes a track. `from_index == to_index` is accepted and is a real
    no-op. Every clip on the moved track keeps its own position/trim/
    keyframes/fades exactly as they were — only its track's position in the
    list (hence its z-order) changes. Any clip selection the human GUI
    currently holds is remapped to follow its track through the reorder, the
    same way the GUI's own drag does, so an agent-driven reorder can never
    leave the human's on-screen selection silently pointing at the wrong
    track."""
    import json

    return json.dumps(_op("editor_move_track", **{"from": from_index, "to": to_index}), indent=2, default=str)


@mcp.tool()
def editor_set_track_gain(track: int, gain: float) -> str:
    """Set an audio track's linear gain multiplier (1.0 = unity, 0.0 = muted)."""
    import json

    return json.dumps(_op("editor_set_track_gain", track=track, gain=gain), indent=2, default=str)


@mcp.tool()
def editor_set_track_locked(track: int, locked: bool) -> str:
    """Lock or unlock a track. A locked track refuses per-clip edits
    (trim/split/remove/move/transform/keyframes) until unlocked."""
    import json

    return json.dumps(_op("editor_set_track_locked", track=track, locked=locked), indent=2, default=str)


@mcp.tool()
def editor_set_track_hidden(track: int, hidden: bool) -> str:
    """Show or hide a video track. A hidden track is skipped by both the
    live preview compositor and `editor_export`."""
    import json

    return json.dumps(_op("editor_set_track_hidden", track=track, hidden=hidden), indent=2, default=str)


@mcp.tool()
def editor_list_markers() -> str:
    """Every marker on the current timeline, in frame order — a marker is a
    colour-coded, optionally titled flag pinned to a TIMELINE frame ("client
    wants a cut here", "sync point", "VFX shot start").

    Markers belong to the TIMELINE, not to any clip or track: there is no
    `track` argument on any of the four marker tools, and a marker survives
    the clip beneath it being trimmed, moved to another track, or deleted.
    They are pure annotation — nothing in the live preview or in
    `editor_export`'s output is affected by one.

    Each entry is `{id, frame, color, durationFrames, endFrame, name, note}`;
    `name`/`note` are `null` when unset. A marker may span a RANGE rather than
    flag one frame: `durationFrames` is 0 for a point marker (the default, and
    what every marker made before ranges existed is) and `endFrame` is the
    derived last frame it covers, inclusive — equal to `frame` for a point
    marker. `id` is what `editor_set_marker`/`editor_remove_marker` take.
    Also returns `palette`, the marker colour names `editor_add_marker` and
    `editor_set_marker` accept. `editor_get_timeline` reports the same list
    under its own `markers` key, so this tool is the cheap way to re-read just
    the markers after writing one."""
    import json

    return json.dumps(_op("editor_list_markers"), indent=2, default=str)


@mcp.tool()
def editor_add_marker(
    frame: int | None = None,
    color: str | None = None,
    name: str | None = None,
    note: str | None = None,
    duration_frames: int | None = None,
) -> str:
    """Pin a marker to a timeline frame — the same action the GUI's Marker
    button and its `M` shortcut perform.

    `frame` omitted means "at the playhead", exactly like the GUI's own
    button, so `editor_set_playhead(...)` then `editor_add_marker()` is the
    natural pair. `color` is a palette NAME (blue, cyan, green, yellow, red,
    pink, purple, fuchsia, rose, lavender, sky, mint, lemon, sand, cocoa,
    cream — `editor_list_markers` returns the live list) or a raw `#RGB` /
    `#RRGGBB` hex; omitted gives blue, the same default DaVinci Resolve uses.
    `name` is the short title shown next to the flag on the ruler; `note` is
    longer free text visible only in the marker's own popover.

    `duration_frames` makes the marker span a RANGE rather than flag a single
    frame: omitted (or 0) is a point marker, the default and what every marker
    made before this parameter existed is. A ranged marker covers
    `frame` through `frame + duration_frames` inclusive and draws as a bar on
    the ruler instead of a pin. The response reports `durationFrames` and the
    derived `endFrame` for both kinds, so a point marker reads back as
    `durationFrames: 0` with `endFrame` equal to `frame`.

    A marker is real document content: it is written into `project.json` and
    a GUI undo (⌘Z) removes it, unlike `editor_set_selection` /
    `editor_set_preview_zoom`, which change only what the user is looking at.
    Any frame is legal, including one past the last clip. Returns the created
    marker including its generated `id`."""
    import json

    args: dict = {}
    for key, val in (
        ("frame", frame),
        ("color", color),
        ("name", name),
        ("note", note),
        ("durationFrames", duration_frames),
    ):
        if val is not None:
            args[key] = val
    return json.dumps(_op("editor_add_marker", **args), indent=2, default=str)


@mcp.tool()
def editor_set_marker(
    id: str,
    frame: int | None = None,
    color: str | None = None,
    name: str | None = None,
    note: str | None = None,
    duration_frames: int | None = None,
) -> str:
    """Change an existing marker's frame, colour, span, title or note. `id`
    comes from `editor_list_markers` (or from `editor_add_marker`'s response).

    A PATCH, not a full replace: every argument you omit keeps its current
    value, so recolouring a marker needs no restating of its note. To CLEAR a
    title or a note, pass the empty string `""` for it — omitting it leaves it
    alone. `color` takes the same palette name or hex `editor_add_marker`
    does, and an unrecognised one is an error rather than a silent no-change.

    `duration_frames` follows the same convention: omitted leaves the span
    untouched, a positive number makes the marker span `frame` through
    `frame + duration_frames` inclusive, and **0 clears it back to a point
    marker** — the span's equivalent of passing `""` to clear a title.

    Moving a marker's `frame` re-sorts it into place; the list this and
    `editor_list_markers` report is always in frame order. Returns the marker
    as it now stands."""
    import json

    args: dict = {"id": id}
    for key, val in (
        ("frame", frame),
        ("color", color),
        ("name", name),
        ("note", note),
        ("durationFrames", duration_frames),
    ):
        if val is not None:
            args[key] = val
    return json.dumps(_op("editor_set_marker", **args), indent=2, default=str)


@mcp.tool()
def editor_remove_marker(id: str) -> str:
    """Delete one marker. `id` comes from `editor_list_markers`. An unknown
    id is an error naming the ids that DO exist, not a silent no-op. Removing
    a marker touches nothing else on the timeline — no clip, no track, no
    ripple — and is undoable in the GUI like any other edit. Returns the
    marker that was removed."""
    import json

    return json.dumps(_op("editor_remove_marker", id=id), indent=2, default=str)


@mcp.tool()
def editor_list_transitions(track: int | None = None) -> str:
    """Every transition on the timeline — and, just as usefully, every real
    CUT a new one could go on.

    A transition sits at an EDIT POINT: the timeline frame where one clip ends
    and the next begins on the SAME video track (D-224). The clips themselves
    never overlap; the transition bridges the cut and reads each clip's handle
    media (see `editor_get_capabilities`'s `transitions` key). So this returns,
    per video track: `cuts` (the frames a transition may be added at) and
    `transitions` (what is already there).

    Each transition reports its stored `kind`/`atFrame`/`duration`/`alignment`/
    `color` AND its derived `windowStartFrame`/`windowEndFrame` (the frames it
    actually covers) plus `headHandleFrames`/`tailHandleFrames` (how much media
    outside its own trim each clip has to supply). Read the derived numbers
    rather than recomputing them — the centre alignment's integer halving is
    easy to get wrong by a frame.

    Pass `track` to narrow to one; omit it for all. Also returns the `kinds`
    this build supports, the legal `alignments`, and the default duration.
    `editor_get_timeline` reports the same per-track list under its own
    `transitions` key."""
    import json

    args: dict = {}
    if track is not None:
        args["track"] = track
    return json.dumps(_op("editor_list_transitions", **args), indent=2, default=str)


@mcp.tool()
def editor_add_transition(
    track: int,
    kind: str = "cross_dissolve",
    at_frame: int | None = None,
    duration_frames: int | None = None,
    alignment: str = "center_at_cut",
    color: str | None = None,
) -> str:
    """Put a transition on a cut — the same action as dragging one out of the
    timeline's Transitions palette onto that cut.

    `kind` is `cross_dissolve` (the incoming clip fades up over the outgoing
    one — needs handle media on both) or `dip_to_color` (both clips dip through
    a solid colour — needs NO handle media, so it always works). `color` is a
    palette name or `#RRGGBB` hex and applies to `dip_to_color` only; omitted
    means black.

    `at_frame` omitted means "the cut nearest the playhead", so
    `editor_set_playhead(...)` then `editor_add_transition(track=0)` is the
    natural pair — the response says which cut it actually landed on.
    `at_frame` given must be an EXACT cut frame; `editor_list_transitions`
    reports the real ones and an inexact frame is an error listing them.

    `alignment` decides which clip pays for the transition, and it is not
    cosmetic: `center_at_cut` (the default) takes half its length of handle
    from each side, `start_at_cut` takes it all from the outgoing clip's tail
    and none from the incoming clip's head, `end_at_cut` is the mirror.

    Refused, with a real reason, rather than silently mangled: no cut there, a
    locked or non-video track, a window that would swallow a neighbouring clip,
    an overlap with another transition, or — for a cross dissolve —
    insufficient handle media, in which case the message names how many frames
    are missing and which alignment would fit. Returns the created transition
    including its generated `id` and its derived window."""
    import json

    args: dict = {"track": track, "kind": kind, "alignment": alignment}
    if at_frame is not None:
        args["atFrame"] = at_frame
    if duration_frames is not None:
        args["durationFrames"] = duration_frames
    if color is not None:
        args["color"] = color
    return json.dumps(_op("editor_add_transition", **args), indent=2, default=str)


@mcp.tool()
def editor_set_transition(
    track: int,
    id: str,
    kind: str | None = None,
    duration_frames: int | None = None,
    alignment: str | None = None,
    color: str | None = None,
) -> str:
    """Change a placed transition's type, length, alignment or dip colour.
    `id` comes from `editor_list_transitions` (or from
    `editor_add_transition`'s own response).

    A PATCH: every argument you omit keeps its current value. `at_frame` is
    deliberately NOT changeable — moving a transition to a different cut is
    removing it from one and adding it to another, and a patch that silently
    re-homed it would skip the placement checks the add path runs.

    The MERGED result must still be legal, so shortening a dissolve always
    works and lengthening one past its handle media is refused with the same
    message `editor_add_transition` would have given. Pass `color=""` to clear
    a dip back to black. Returns the transition as it now stands."""
    import json

    args: dict = {"track": track, "id": id}
    if kind is not None:
        args["kind"] = kind
    if duration_frames is not None:
        args["durationFrames"] = duration_frames
    if alignment is not None:
        args["alignment"] = alignment
    if color is not None:
        args["color"] = color
    return json.dumps(_op("editor_set_transition", **args), indent=2, default=str)


@mcp.tool()
def editor_remove_transition(track: int, id: str) -> str:
    """Delete one transition, restoring the plain cut. `id` comes from
    `editor_list_transitions`. An unknown id is an error naming the ids that DO
    exist, not a silent no-op.

    Touches no clip: the two clips never moved to make room for the transition
    (they stay abutting and non-overlapping — D-224), so removing it re-trims
    nothing and ripples nothing. Undoable in the GUI like any other edit.
    Returns the transition that was removed."""
    import json

    return json.dumps(_op("editor_remove_transition", track=track, id=id), indent=2, default=str)


@mcp.tool()
def editor_set_clip_transform(
    track: int,
    clip: int,
    opacity: float | None = None,
    position_x: float | None = None,
    position_y: float | None = None,
    scale: float | None = None,
    box_width: float | None = None,
    box_height: float | None = None,
    clear_box_width: bool = False,
    clear_box_height: bool = False,
    rotation: float | None = None,
    crop_left: float | None = None,
    crop_top: float | None = None,
    crop_right: float | None = None,
    crop_bottom: float | None = None,
    corner_radius: float | None = None,
) -> str:
    """Set a clip's BASE (unkeyframed) compositing transform — e.g. to place
    it in one half of a stacked before/after comparison layout.
    (0..1), applied before `scale`. Omitted fields keep the clip's current
    value — this tool reads the clip back first, it never silently resets a
    field you didn't mention.

    **BASE means "the fallback for a property no keyframe names."** Per
    property, a keyframe overrides this value at every frame (D-208), so on
    an animated clip a field you set here can be a real, persisted write that
    changes no rendered frame. Check `chroma_keyframes` in
    `editor_get_state` first; to move a property that IS keyed, write a
    keyframe for it with `editor_set_clip_keyframes` instead — the same thing
    the GUI's on-canvas drag does (B-093/D-209).

    `scale` is a stacking/picture-in-picture primitive: it ties the
    overlay's width to the canvas, but its HEIGHT follows the CLIP'S OWN
    aspect ratio in the live preview (there is no 'stretch' option here —
    that only exists as `editor_export`'s `fit_overrides`, D-184). It does
    NOT alone produce an exact-height box like a full-width/half-canvas
    slot. Call `editor_get_capabilities` once before your first use of this
    tool for the full explanation and the crop-then-scale recipe for hitting
    an exact target box.

    `box_width`/`box_height` (D-193) are an INDEPENDENT-AXIS override —
    a fraction of the OUTPUT composition, same convention as
    `position_x`/`position_y` — that replaces `scale`'s natural-footprint
    sizing for that axis, making the crop-then-scale recipe above
    unnecessary for the common case. `scale` alone can only ever produce a
    box with the clip's own SOURCE aspect ratio (B-074's own finding,
    generalised past just fixing `editor_export`); `box_width`/`box_height`
    are how you place a clip into an arbitrary, differently-shaped region —
    e.g. `box_width=1.0, box_height=0.5` fills the full canvas width at
    exactly half its height, regardless of the clip's own resolution.
    Setting only one axis leaves the other on `scale`'s formula. Omit both
    to leave whatever override already exists (or its absence) untouched;
    pass `clear_box_width=True` / `clear_box_height=True` to explicitly
    remove a previously-set override and go back to `scale`-derived sizing
    on that axis (a bare `float | None` can't distinguish "not mentioned"
    from "clear it", since `None` is already this tool's own "not
    mentioned" convention for every other field — these two flags are the
    escape hatch for the one field pair where "explicitly go back to
    scale" is itself a real, distinct thing you might want to say).

    `corner_radius` (D-344) rounds the clip's placement box, in OUTPUT-CANVAS
    PIXELS — not a fraction, unlike every geometry field above it. `0` (the
    default) is square corners and renders byte-identically to a build without
    this feature. It is applied AFTER crop and scale and BEFORE rotation, so a
    rotated clip's rounded corners rotate with it, and it multiplies the
    existing alpha rather than replacing it, so it composes with crop, opacity,
    fades and dissolves. A radius larger than half the box's shorter side
    clamps to that, giving a pill or a circle rather than a degenerate shape.
    Keyframeable via `editor_set_clip_keyframes` under the same
    `corner_radius` name. Does NOT apply to a text/title clip or an adjustment
    clip — both are refused rather than silently ignored, for the same reason
    `scale` is."""
    import json

    args: dict = {"track": track, "clip": clip}
    for key, val in (
        ("opacity", opacity),
        ("position_x", position_x),
        ("position_y", position_y),
        ("scale", scale),
        ("rotation", rotation),
        ("crop_left", crop_left),
        ("crop_top", crop_top),
        ("crop_right", crop_right),
        ("crop_bottom", crop_bottom),
        ("corner_radius", corner_radius),
    ):
        if val is not None:
            args[key] = val
    if clear_box_width:
        args["box_width"] = None
    elif box_width is not None:
        args["box_width"] = box_width
    if clear_box_height:
        args["box_height"] = None
    elif box_height is not None:
        args["box_height"] = box_height
    return json.dumps(_op("editor_set_clip_transform", **args), indent=2, default=str)


@mcp.tool()
def editor_set_clip_audio(
    track: int,
    clip: int,
    volume: float | None = None,
    pan: float | None = None,
) -> str:
    """Set ONE CLIP's own audio level and stereo position (D-223). `track` and
    `clip` are the 0-based indices from get_timeline.

    This is NOT `editor_set_track_gain`, and neither replaces the other: that
    one is the whole track's fader, this is one clip on it, and the mixer
    MULTIPLIES them. Turning down a track quietens every clip on it; this is
    how you quieten one line of dialogue, or place one clip in the stereo
    field, without touching its neighbours.

    - `volume` -- a LINEAR multiplier, 1.0 = unity, 0.5 ~= -6 dB, 0.0 = silent.
      Linear (not dB) deliberately, to match `editor_set_track_gain`'s own unit
      in the same signal chain. Floored at 0; NO ceiling -- values above 1
      really do boost, which the mixer's limiter then has to deal with.
    - `pan` -- -1.0 hard left, 0.0 centre, 1.0 hard right. Clamped to that
      range. The law is CONSTANT POWER with a 0 dB CENTRE, so a hard pan
      BOOSTS the destination channel by 3.01 dB rather than attenuating the
      other one: lower `volume` on the same call if the source is already near
      full scale. A mono source panned becomes stereo-positioned mono.

    Omitting a field leaves it exactly as it was -- unlike
    editor_set_clip_transform, whose omitted fields reset. Both are stored per
    CLIP and survive trim/split (a split gives both halves the same level).

    HOW IT COMPOSES, which is the thing to reason with rather than guess at:
    `track gain x clip volume x clip fade x track duck`, then the pan law
    splits that per channel. Every stage multiplies; none overrides another.
    So a clip already fading out is quieter still if you halve its volume, and
    a ducked track ducks a boosted clip too.

    WHAT IT AFFECTS: sound only. On an audio-track clip that is the whole clip.
    On a video clip it is that clip's own EMBEDDED audio -- and nothing at all
    once that audio has been unlinked into its own clip (D-129), which is where
    the level then lives. A title/text clip has no audio and ignores both.

    Both are KEYFRAMEABLE under the names "volume" and "pan" via
    editor_set_clip_keyframes -- that is how you write an automation ramp (a
    fade under dialogue, a pan sweep). Keyed values are interpolated linearly
    and applied per output sample, in the live mixer and in `editor_export`
    alike.

    Returns what was actually STORED, plus the two per-channel gains the pan
    resolves to and the track's own gain, so a caller can reason about the
    real level without re-deriving the law.

    Undoable: same store action and same undo stack the GUI's own Inspector
    Audio rows write to, so a human can Cmd+Z it."""
    import json

    args: dict = {"track": track, "clip": clip}
    if volume is not None:
        args["volume"] = volume
    if pan is not None:
        args["pan"] = pan
    return json.dumps(_op("editor_set_clip_audio", **args), indent=2, default=str)


@mcp.tool()
def editor_set_clip_eq(
    track: int,
    clip: int,
    band: int | None = None,
    kind: str | None = None,
    freq_hz: float | None = None,
    gain_db: float | None = None,
    q: float | None = None,
    enabled: bool | None = None,
    clear: bool = False,
) -> str:
    """Set ONE BAND of one clip's parametric EQ (D-224). `track` and `clip` are
    the 0-based indices from get_timeline; `band` is 0..3.

    This is the tool for shaping a clip's TONE, as distinct from its LEVEL
    (editor_set_clip_audio) and its track's fader (editor_set_track_gain). The
    real moves it exists for: cut rumble and handling noise out of dialogue
    (`kind="high_pass", freq_hz=80`), take the boxiness out of a room recording
    (`kind="peak", freq_hz=300, gain_db=-4, q=1.5`), add air to a voice
    (`kind="high_shelf", freq_hz=8000, gain_db=3`), or notch a hum
    (`kind="peak", freq_hz=60, gain_db=-18, q=8`).

    FOUR BANDS, matching DaVinci Resolve's own Clip Equalizer. A clip with no
    EQ yet gets the default strip on the first call -- low shelf 120 Hz, bell
    500 Hz, bell 2.5 kHz, high shelf 8 kHz, ALL AT 0 dB, i.e. completely inert
    until you give one a real gain or switch it to a pass filter.

    `kind` -- one of:
      - "peak"       a bell centred on freq_hz. The default, and how you make a
                     notch too (deep negative gain_db at a high q).
      - "low_shelf"  boost/cut everything BELOW freq_hz, flat above.
      - "high_shelf" boost/cut everything ABOVE freq_hz, flat below.
      - "high_pass"  2-pole roll-off below freq_hz. IGNORES gain_db.
      - "low_pass"   2-pole roll-off above freq_hz. IGNORES gain_db.
    `freq_hz` -- 20 .. 20000, clamped. Centre frequency for a bell, corner for
      a shelf or a pass filter (a shelf reaches HALF its gain at its corner and
      the full gain well past it; a Butterworth pass filter is -3 dB there).
    `gain_db` -- -24 .. +24, clamped. Ignored by the two pass kinds.
    `q` -- 0.1 .. 20, clamped. Higher is narrower. 0.707 (Butterworth) is the
      right default for a shelf or a pass filter; 1-2 is a musical bell, 6+ is
      a surgical notch.
    `enabled` -- per-band bypass. False keeps the band's settings but takes it
      out of the chain -- the only way to bypass a pass filter, which has no
      gain to zero.
    `clear=True` -- remove the clip's EQ entirely, back to unfiltered. Ignores
      every other field.

    Omitting a field leaves it exactly as it was, like editor_set_clip_audio
    and unlike editor_set_clip_transform. Set up a full EQ with one call per
    band.

    HOW IT COMPOSES: the EQ runs FIRST, on the clip's own audio as decoded,
    BEFORE `track gain x clip volume x clip fade x track duck` and before the
    pan. So a boost here really does make the clip louder, and the way to
    compensate is editor_set_clip_audio's `volume`.

    STATIC, NOT KEYFRAMEABLE -- deliberately, and this is the one real
    limitation to know about. ffmpeg's biquad filters parse their parameters
    once, as numbers, so a swept/animated EQ cannot be rendered at all; rather
    than offer a preview the export cannot reproduce, an EQ here is one setting
    for the whole clip. Split the clip if you need it to change part-way.
    (`volume` and `pan` ARE keyframeable -- see editor_set_clip_keyframes.)

    WHAT IT AFFECTS: sound only, exactly like editor_set_clip_audio. On an
    audio-track clip that is the whole clip; on a video clip it is that clip's
    EMBEDDED audio, and nothing at all once that audio has been unlinked into
    its own clip (D-129). A title/text clip has no audio and ignores it.

    Returns what was actually STORED (every field is clamped on the way in),
    a one-line summary of each band, `eqActive` (whether the EQ does anything
    at all -- an all-flat strip does not), and `responseDb`: the resulting
    curve in dB at nine standard frequencies, so you can check the move landed
    without re-deriving a biquad. Reason from `responseDb`, not from what you
    asked for.

    Undoable: same store action and same undo stack the GUI's own Inspector EQ
    section writes to, so a human can Cmd+Z it -- including a human dragging a
    band's own point on the Inspector's response graph (D-237), which writes
    through this exact op. `responseDb` is the same curve that graph draws
    (both read `eqResponseDb`), so it's the fastest way to check a drag or a
    call landed the same shape without a screenshot."""
    import json

    args: dict = {"track": track, "clip": clip}
    if clear:
        args["clear"] = True
        return json.dumps(_op("editor_set_clip_eq", **args), indent=2, default=str)
    if band is not None:
        args["band"] = band
    for key, val in (("kind", kind), ("freq_hz", freq_hz), ("gain_db", gain_db), ("q", q)):
        if val is not None:
            args[key] = val
    if enabled is not None:
        args["enabled"] = enabled
    return json.dumps(_op("editor_set_clip_eq", **args), indent=2, default=str)


@mcp.tool()
def editor_set_clip_keyframes(track: int, clip: int, keyframes: list[ClipKeyframe]) -> str:
    """Animate a SINGLE clip's own transform over time — e.g. a zoom-in at
    the moment of a click. Keyframes are scoped to this one clip only (its
    own local timeline), never the whole track or timeline, so two clips on
    two different tracks can each zoom at their own moment while both stay
    visible throughout.

    `keyframes` REPLACES the clip's entire keyframe list — pass all of them
    every time, not just the one you're adding. Each entry is
    `{"frame": <source-frame-absolute int>, "params": {<subset of
    opacity/position_x/position_y/scale/rotation/corner_radius/crop_left/
    crop_top/crop_right/crop_bottom/volume/pan>: <number>}}`. Values are
    piecewise-linearly interpolated between keyframes, held constant before
    the first and after the last.

    `volume` and `pan` (D-223) are this clip's own AUDIO level and stereo
    position — the same two properties `editor_set_clip_audio` sets
    statically, keyed here for a real automation ramp. (A clip's EQ is NOT in
    that list and cannot be keyed — see editor_set_clip_eq for why.) They are applied per
    output SAMPLE (not per video frame) in both the live mixer and
    `editor_export`, so a ramp is smooth rather than stepped.

    Interpolation is PER PROPERTY (D-208): each param is resolved over only
    the keys that name it, so an entry naming a `params` SUBSET animates just
    those and leaves the rest alone rather than freezing them. A property
    with at least one key ignores its static `editor_set_clip_transform`
    value entirely — see `editor_get_capabilities`."""
    import json

    return json.dumps(
        _op("editor_set_clip_keyframes", track=track, clip=clip, keyframes=to_wire(keyframes)),
        indent=2,
        default=str,
    )


@mcp.tool()
def editor_set_keyframe_ease(
    track: int,
    clip: int,
    param: str,
    frame: int,
    curve: CurveSpec | None = None,
) -> str:
    """Shape HOW one animated property moves between two of its keyframes —
    a real cubic-bezier ease, not just a named preset.

    By default every keyframe segment is LINEAR: the property changes at a
    constant rate and stops dead at the next key, which is what makes a
    machine-authored move read as machine-authored. This is the fix. It sets
    the ease on the segment that STARTS at `frame` and runs to `param`'s next
    keyframe.

    `param` is one of opacity / position_x / position_y / scale / rotation /
    corner_radius / crop_left / crop_top / crop_right / crop_bottom / volume /
    pan — the same names `editor_set_clip_keyframes` writes.

    `frame` is a clip SOURCE-frame-absolute number and must be an EXISTING
    keyframe of that property; if it is not, this reports the frames that do
    exist rather than silently doing nothing. Easing is per property, so the
    same frame can carry a different curve for `scale` than for `opacity`.

    `curve` is either a preset NAME -- exactly "linear" | "ease-in" |
    "ease-out" | "ease-in-out", no others (B-165: CSS's own "ease" is NOT one
    of them and is rejected) -- or four cubic-bezier control points
    [x1, y1, x2, y2]: the same model, and the same parser, as
    `editor_set_clip_fade`'s curves. `x` is progress from this keyframe to the
    next, `y` is how far through the value change you are at that progress.
    P0=(0,0)/P3=(1,1) are implicit, so an ease can never move a keyframe — both
    ends still hit their authored values exactly.

    `y` may go outside 0..1 on purpose: that is OVERSHOOT (anticipation, a
    bounce past the target and back). `x` is clamped to 0..1, because a control
    point outside the segment horizontally makes the curve non-invertible and
    meaningless. `curve=None` clears the ease back to linear.

    A typical natural move is "ease-in-out" on the middle segments and
    "ease-out" on the last one. Set it and then look: `editor_set_curve_editor`
    opens this exact curve in the GUI so a human can see and redrag it.

    The live preview and `editor_export` interpret the curve identically (the
    export approximates it as 20 linear steps per segment, well under one
    output quantisation step, because ffmpeg has no bezier solver).

    Undoable: same store action and same undo stack as the GUI's own curve
    editor, so a human can Cmd+Z it."""
    import json

    args: dict = {"track": track, "clip": clip, "param": param, "frame": frame}
    if curve is not None:
        args["curve"] = to_wire(curve)
    return json.dumps(_op("editor_set_keyframe_ease", **args), indent=2, default=str)


@mcp.tool()
def editor_set_curve_editor(
    track: int | None = None,
    clip: int | None = None,
    param: str | None = None,
) -> str:
    """Open the GUI's timeline curve editor on one clip property's animation
    curve, or close it (`param=None`).

    This changes what is ON SCREEN, not the project — nothing here is saved or
    undoable. Use it to SHOW a human the curve you just set with
    `editor_set_keyframe_ease`: the lane opens under the timeline, time-aligned
    with the clip, with that property's keyframes on a real bezier curve whose
    control points they can drag.

    `param` must be a property the clip actually animates; if it is not, this
    reports which properties are animated rather than opening an empty lane."""
    import json

    args: dict = {}
    if track is not None:
        args["track"] = track
    if clip is not None:
        args["clip"] = clip
    if param is not None:
        args["param"] = param
    return json.dumps(_op("editor_set_curve_editor", **args), indent=2, default=str)


@mcp.tool()
def editor_set_dynamic_zoom(
    track: int,
    clip: int,
    start: DynamicZoomFraming | None = None,
    end: DynamicZoomFraming | None = None,
    ease: str | None = None,
) -> str:
    """Animate a push-in or pull-out across a clip's WHOLE length by naming
    where it is framed at the start and where at the end — the shortcut for
    "slowly zoom into this shot", instead of computing keyframes by hand.

    This is the agent half of the Edit tab's Dynamic Zoom (D-234), the same
    feature a human drives by dragging a green (start) and a red (end) box in
    the viewer. Both interfaces run the identical box→keyframe math and write
    the identical op, so what you author here is what the boxes show, and vice
    versa. Calling this also turns those boxes on for the clip, so a human
    watching sees exactly what you did.

    `start` and `end` are `{"position_x": …, "position_y": …, "scale": …}` —
    the SAME three fields (and the same units) as editor_set_clip_transform:
    `position_*` are composition fractions offset from centre, `scale` is a
    multiplier where bigger = more zoomed IN. Everything is optional and the
    defaults are the useful ones:

    - omit `start` → the clip's CURRENT framing at its first frame;
    - omit `end` → that framing pushed in 1.2x (a gentle punch-in), or the
      clip's existing end framing if it already has a dynamic zoom;
    - omit a single FIELD inside either → the value that end already has, so
      `end={"scale": 1.4}` zooms without recentring the shot.

    `ease` is one of `linear` (default), `ease-in`, `ease-out`,
    `ease-in-out` — the same four curves editor_set_clip_fade offers.

    WHAT IT WRITES, exactly: ordinary `position_x`/`position_y`/`scale`
    keyframes on this one clip, spanning its whole source window. There is no
    separate 'dynamic zoom' object -- once written it is indistinguishable
    from keys you could have authored with editor_set_clip_keyframes, which
    means editor_get_state shows it, both the preview and editor_export
    already render it, and a human can Cmd+Z it. `linear` writes exactly two
    keys; any other ease is baked into ~21, because the keyframe model
    interpolates linearly between keys on both sides of the wire and sampling
    the curve is the only ease BOTH renderers reproduce.

    REPLACES, does not append: any existing `position_x`/`position_y`/`scale`
    keys on this clip are dropped first (a dynamic zoom spans the whole clip,
    so two overlapping animations of the same properties would be
    meaningless). Every OTHER animated property is left untouched -- opacity,
    rotation, the crop insets, volume, pan.

    REFUSED on a title/text clip (its scale is pinned to 1 by both renderers)
    and on an adjustment clip (its correction is full-frame, it has no
    geometry) rather than silently animating nothing.

    Returns the two framings actually used, the ease, the clip's source-frame
    span, how many keyframes were written, and `animates` -- false when the
    two framings came out identical, i.e. you wrote a hold rather than a
    zoom."""
    import json

    args: dict = {"track": track, "clip": clip}
    if start is not None:
        args["start"] = to_wire(start)
    if end is not None:
        args["end"] = to_wire(end)
    if ease is not None:
        args["ease"] = ease
    return json.dumps(_op("editor_set_dynamic_zoom", **args), indent=2, default=str)


# D-362 (fixes B-231) — how often, and for how long, `editor_export` waits out a
# render whose own call already timed out on the bridge.
#
# Two seconds because an export is measured in minutes: second-by-second
# resolution buys a poller nothing and each poll is a real HTTP round trip. The
# ceiling is deliberately generous — the renderer's own stall watchdog is what
# guarantees a HUNG export stops being `running` (within its own timeout), so
# this one exists only to stop the tool blocking forever on a render that is
# genuinely, honestly still going. Past it the last real status is returned
# rather than an invented failure, and `editor_export_status` picks up where
# this left off.
EXPORT_POLL_INTERVAL_S = 2.0
EXPORT_POLL_MAX_S = 2 * 60 * 60


def _await_compositor_export(env: dict, out_path: str) -> dict:
    """Poll `editor_export_status` until the render really settles (D-362).

    Called only when `editor_export`'s own call came back as a transport
    failure — which, on a real export, is the expected outcome rather than a
    real one. Returns an envelope shaped like the one it replaces, so a caller
    cannot tell whether its export happened to fit inside the bridge's budget.
    """
    import time

    deadline = time.monotonic() + EXPORT_POLL_MAX_S
    status: dict = {}
    while time.monotonic() < deadline:
        try:
            status = _op("editor_export_status").get("result") or {}
        except RuntimeError:
            # The app is genuinely unreachable — that IS the real failure, and
            # it is the one already in `env`.
            return env
        state = status.get("state")
        if state in (None, "idle"):
            # Nothing is running and nothing ever ran: the render never
            # started, so the original transport error is the honest answer.
            return env
        if state != "running":
            return {
                "ok": state == "done",
                "error": status.get("error"),
                "result": {"outPath": out_path, **status},
            }
        time.sleep(EXPORT_POLL_INTERVAL_S)
    return {
        "ok": False,
        "error": (
            f"the export was still rendering after {EXPORT_POLL_MAX_S / 3600:.0f}h — it has NOT "
            "failed and has not been stopped; poll editor_export_status to follow it"
        ),
        "result": {"outPath": out_path, **status},
    }


@mcp.tool()
def editor_export(
    out_path: str,
    width: int,
    height: int,
    fps: float | None = None,
    speed_overrides: dict[str, float] | None = None,
    fit_overrides: dict[str, FitMode] | None = None,
    freeze_overrides: dict[str, bool] | None = None,
    renderer: ExportRenderer | None = None,
) -> str:
    """Render the open project's ENTIRE multi-track timeline — every visible
    video track/clip, composited in z-order (track 0 on top), cropped,
    keyframed and speed-adjusted — to a single output file via ffmpeg. This
    is the only Edit-tab tool that produces a real output file;
    `editor_get_timeline` and every `editor_set_*`/`editor_add_*` tool above
    only change in-memory state.

    `width`/`height` are the output composition's pixel size (every clip's
    `position_x`/`position_y`/`scale` from `editor_set_clip_transform` are
    fractions of this). `fps` defaults to the timeline's own rate.
    `speed_overrides` is `{clip_id: multiplier}` (e.g. `{"clip-abc": 1.2}`)
    — an EXPORT-TIME-ONLY speed change; it does not touch the clip's stored
    trim/duration, so scrubbing it in the GUI still plays at 1x.

    **`scale` is a WIDTH fraction of the output composition, not a box
    shape (B-074)** — read this before compositing more than one clip onto
    a track/canvas. `overlay_width = width * clip.scale` always; the
    overlay's HEIGHT depends on `fit_overrides` (`{clip_id: "fit" |
    "stretch"}`, EXPORT-TIME-ONLY, mirrors `speed_overrides`'s own shape):
    `"fit"` (the default for any clip with no entry here) lets ffmpeg
    compute height from the clip's own real, post-crop aspect ratio — the
    overlay is correctly proportioned, undistorted, and generally will NOT
    exactly fill a target box unless you chose `width`/`height`/`scale` to
    make it so. `"stretch"` forces height to `height * clip.scale` too —
    i.e. the overlay ALWAYS has exactly the OUTPUT canvas's own aspect
    ratio, at any `scale`, regardless of the source's real shape (correct
    for a same-aspect picture-in-picture bubble, or a deliberate distort
    effect; wrong for fitting arbitrary footage into a differently-shaped
    region). Concretely: a full-width/half-height stacked layout (two clips,
    one per half of a 9:16 canvas) is mathematically impossible to get
    undistorted via `"stretch"` for ANY canvas size, because that box's
    aspect ratio necessarily differs from the canvas's own — use `"fit"`
    (the default) for that layout, and compute `position_y` yourself from
    the clip's own known resolution (`editor_import_media`'s probe result)
    to center or top-align the resulting box within its slot; ffmpeg
    round-trips height to the nearest even pixel count under `"fit"`, so
    treat the exact rendered height as approximate when computing that
    offset.

    **`source_start`/`duration`/a keyframe's `frame` are all in the CLIP's
    OWN native source frame rate (B-075), not this export's `fps`** —
    handled automatically as long as the clip has `source_fps` set (true for
    any clip placed via `editor_add_clip`), never something you need to
    convert yourself.

    `freeze_overrides` (`{clip_id: true}`, EXPORT-TIME-ONLY, D-188, mirrors
    `speed_overrides`'s own shape) holds a clip's own real LAST FRAME, frozen,
    for the rest of the export's total runtime instead of it simply
    disappearing once its own content ends — e.g. a shorter/sped-up clip
    stacked next to a longer one that keeps playing. A clip already at or
    past the overall total runtime is unaffected (no-op, never a
    negative-duration hold).

    D-197: real audio now mixes into the output automatically — every
    visible audio-track clip (gain/D-057, ducking/D-149, fade/D-147) plus a
    video clip's own embedded audio (unless A/V-linked, D-129, or its
    source isn't known to have audio), summed and soft-limited. No new
    parameter needed; read `editor_get_capabilities`'s `export.v1_scope`
    entry for the one real caveat (an unprobed video source's embedded audio
    conservatively defaults to silent).

    **This call blocks, and on a real project it WILL exceed the 20s frontend
    round trip — which is expected, and is not the export failing** (D-362,
    fixes B-231). A minutes-long export outlives that budget, so the bridge
    answers `ok: false` with a "no reply from the frontend" error while the
    render carries on and succeeds. On the `"compositor"` renderer this tool
    handles that for you: it then polls `editor_export_status` until the
    render really settles, and returns THAT outcome, so what you get back is
    the export's own answer rather than the timeout's. Call
    `editor_export_status` yourself at any point to watch progress, or to pick
    a render back up if this call is interrupted. The `"filter"` renderer
    reports no progress at all — nothing outside ffmpeg knows where it is — so
    there a timeout really does leave the output file as your only signal.

    **`renderer` (D-350) — which engine composites the picture.**
    `"compositor"` renders every frame through the app's OWN live-preview
    compositor and pipes it into one ffmpeg process that only compresses and
    muxes; `"filter"` (the default, and everything described above) compiles
    the whole composite into an ffmpeg `-filter_complex` graph with one `-i`
    per clip. Prefer `"compositor"` for a HEAVILY CUT timeline — the filter
    path's memory and thread use both scale with the clip count
    (B-228/B-229/B-230: a real ~79-clip 4K project reached 56 GB and 3,065
    threads on one process), while the render path opens exactly one input
    whatever the clip count, and it is by construction the same picture the
    Edit tab previews. It is opt-in while it is phase 1: it does NOT yet
    support `speed_overrides`, `fit_overrides` or `freeze_overrides` (all
    EXPORT-TIME-ONLY knobs the live compositor has no notion of) and REFUSES
    rather than silently ignoring one."""
    import json

    args: dict = {"outPath": out_path, "width": width, "height": height}
    if fps is not None:
        args["fps"] = fps
    if speed_overrides is not None:
        args["speedOverrides"] = speed_overrides
    if fit_overrides is not None:
        args["fitOverrides"] = fit_overrides
    if freeze_overrides is not None:
        args["freezeOverrides"] = freeze_overrides
    if renderer is not None:
        args["renderer"] = renderer
    env = _op("editor_export", **args)
    # D-362 (fixes B-231 facet 1) — the bridge's 20s budget is shorter than a
    # real export, so a healthy one reliably comes back as a transport failure
    # (`ok: false`) while the render is still going and will succeed. That is
    # the false negative B-231 is half made of. The render itself publishes
    # real progress on the compositor path, so rather than hand the caller a
    # verdict that is simply wrong, poll for the true one.
    if renderer == "compositor" and not env.get("ok"):
        env = _await_compositor_export(env, out_path)
    # B-091 — the compiled ffmpeg `args` (the FULL filter_complex, verbatim)
    # made this response grow with keyframe count/precision until it was
    # observed hitting an unreliable size boundary: the same general payload
    # size sometimes got a graceful "saved to a file" truncation and
    # sometimes failed the whole tool call outright with no detail, even
    # though the real ffmpeg render succeeded either way. `args` is genuinely
    # useful for debugging a failed compile, but is the wrong DEFAULT once a
    # timeline has more than a handful of keyframes — a caller almost always
    # only needs to know whether it succeeded and where the file landed, not
    # the literal argv. Dropped here (the MCP boundary), not in the TS
    # compiler itself, so `editor_export`'s own real return value stays the
    # complete, undiminished one for any in-app/test caller.
    result = env.get("result")
    if isinstance(result, dict) and "args" in result:
        result = {k: v for k, v in result.items() if k != "args"}
        env = {**env, "result": result}
    return json.dumps(env, indent=2, default=str)


@mcp.tool()
def editor_export_status() -> str:
    """Poll the running — or most recently finished — `editor_export` render
    (D-362, fixes B-231). Takes no arguments, starts nothing, and is free to
    call as often as you like.

    **Read `state` first.** `running` (still going; poll again), `done` (the
    file is written and finalised), `failed` (`error` says why), `stalled`
    (see below), or `idle` (no export has run in this session).

    **`stalled` is a real, named failure and it matters.** It means a render
    worker wrote no frame at all for `stallTimeoutSecs`, so the export was
    declared hung, its encoder killed, and the render abandoned. **The output
    file is incomplete and was never finalised — it will not play, and it must
    not be used or shipped.** Re-run the export. Before D-362 this state
    reported nothing whatsoever: the file simply stopped growing and every
    other signal continued to look healthy, which is the whole of B-231's
    second half.

    **Progress.** `percent` (0-100) is the real fraction of the render —
    `framesWritten / framesTotal` summed across every concurrent segment, not
    an elapsed-time guess. `segmentsDone`/`segmentsTotal` and the per-segment
    `segments` rows report the shape of it, which the percentage alone cannot:
    four segments evenly at 78% and three finished with one wedged read the
    same overall and are very different situations. `etaMs` is a rough
    estimate taken from the slowest unfinished segment (a render ends when its
    last worker does). While `phase` is `concatenating` every frame is already
    rendered and the segments are being joined and the audio muxed.

    **Only the `"compositor"` renderer reports progress.** The `"filter"`
    renderer hands the whole job to one ffmpeg and learns nothing until it
    exits, so an export run that way is invisible here."""
    import json

    return json.dumps(_op("editor_export_status"), indent=2, default=str)


@mcp.tool()
def editor_export_fcpxml(
    out_path: str,
    width: int,
    height: int,
    fps: float | None = None,
    project_name: str | None = None,
) -> str:
    """Export the open project's ENTIRE multi-track timeline as a real,
    standard **FCPXML 1.7** document — the Final Cut Pro X XML Interchange
    Format DaVinci Resolve and Final Cut Pro both import natively (D-196).
    Unlike `editor_export`, this produces no picture/audio at all — a text
    file describing the EDIT itself, so the same cuts/composite/trims can be
    finished in another NLE instead of (or in addition to) Apelles' own
    render.

    Verified against Apple's own real, published FCPXML 1.7 DTD (a real DTD
    validator, not a guess at the XML shape) — see
    `packages/editor/src/timelineInterchange.ts`'s own header doc and D-196
    in `docs/08-decisions.md` for the full field-mapping table. Real, honest
    scope, not a stub:

    MAPS: clip placement/trims (`start_frame`/`source_start`/`duration`),
    track z-order (Apelles' own "track 0 = topmost" convention becomes the
    HIGHEST fcpxml `lane` number), the compositing transform
    (`position_x`/`position_y`/`scale`/`box_width`/`box_height`/`rotation`),
    crop, static opacity, A/V `link_group` (exported as one shared FCPXML
    `<asset>` with the video half `srcEnable="video"` and the audio half
    `srcEnable="audio"` — the real FCP mechanism for "same file, video-only
    vs audio-only"), and audio track gain (`Track.gain`, as `adjust-volume`
    dB on every clip on that track).

    DOES NOT MAP, on purpose (each surfaces in this call's own `warnings`
    array when it actually applies to this timeline, never a silent drop):
    per-clip animated transform (`chroma_keyframes`), clip fades
    (`fade_in_frames`/`fade_out_frames`), audio ducking
    (`Track.duck_from`/`duck_db`/...) — FCPXML itself has no static
    equivalent for ducking, matching the format's own documented exclusion
    of audio volume automation — and `editor_export`'s own ffmpeg-only,
    non-persisted export-time parameters (`speed_overrides`/
    `fit_overrides`/`freeze_overrides`), which have no `Clip` field to read
    here at all.

    A clip's exact scale/crop conversion needs its SOURCE's real pixel
    resolution; this tool passes through whatever the media pool already has
    probed (`editor_import_media`'s result) automatically. A clip with no
    probed resolution (an offline source, or one added before probing)
    falls back to assuming the OUTPUT canvas's own aspect ratio — exact for
    a plain full-canvas clip, approximate for a scaled/cropped/PIP one, and
    always called out by name in `warnings` when it's actually load-bearing.

    `width`/`height` are the output composition's pixel size, the same
    convention `editor_export` already uses. `fps` defaults to the
    timeline's own exact rate. Does NOT export XMEML/FCP7 XML (the
    Premiere-targeted sibling interchange format) — a precise, scoped,
    not-yet-built follow-up, see D-196."""
    import json

    args: dict = {"outPath": out_path, "width": width, "height": height}
    if fps is not None:
        args["fps"] = fps
    if project_name is not None:
        args["projectName"] = project_name
    return json.dumps(_op("editor_export_fcpxml", **args), indent=2, default=str)


# --------------------------------------------------------------------------- #
# Edit tab: media understanding (D-189) — "what was said" and "what changed on
# screen," from the `ai-media/` sidecar. Both are START-then-POLL, like
# `depth_track`/`depth_track_status` below: `chroma::control`'s bridge times out
# at 20s and these jobs run for tens of seconds to minutes, so a blocking tool
# could never return a result. Both cache by path — a repeat ask is free.
# --------------------------------------------------------------------------- #
def _media_args(path: str | None, media_id: str | None, source_path: str | None) -> dict:
    args: dict = {}
    if path is not None:
        args["path"] = path
    if media_id is not None:
        args["mediaId"] = media_id
    if source_path is not None:
        args["sourcePath"] = source_path
    return args


@mcp.tool()
def editor_get_transcript(
    path: str | None = None,
    media_id: str | None = None,
    source_path: str | None = None,
    language: str | None = None,
    word_timestamps: bool = True,
    force: bool = False,
) -> str:
    """Start a word-level transcript of an audio/video file — "what was SAID,
    and when." Use this to find a moment by its SPOKEN content: a talking-head
    take where nothing changes visually but every content move is in the
    speech. Returns immediately with `state`; poll
    `editor_get_transcript_status` until `state` is `"done"`, then read
    `words` / `segments` / `text` off that response.

    **`state: "done"` can come back on this very first call** — results are
    cached per file, so a repeat ask costs nothing. `force=True` re-runs anyway
    (use it when the file on disk changed).

    Identify the file with `path` (any absolute path — it does NOT have to
    be imported first, since "what's in this file?" is usually the question you
    want answered BEFORE importing), or with `media_id`/`source_path` for an
    item already in the project's media pool.

    `language` is an ISO code ("en", "de", ...) for one of Parakeet's 25
    European languages, or omitted — Parakeet then picks the language itself and
    does not report which it chose. Languages outside that set (Hindi, for one,
    and so Hinglish) are unsupported: a named one is refused, and an omitted one
    comes back as fluent wrong English. `word_timestamps=True` (the default)
    gives per-word start/end times — the format you need to cut to an exact
    word; `False` is faster but segment-level only.

    Complements `editor_analyze_video`, does not overlap it: this finds NOTHING
    in silent or music-only footage. Roughly 12 s for a short clip, longer for
    a long one (Parakeet, local)."""
    import json

    args = _media_args(path, media_id, source_path)
    args["wordTimestamps"] = word_timestamps
    if language is not None:
        args["language"] = language
    if force:
        args["force"] = True
    return json.dumps(_op("editor_get_transcript", **args), indent=2, default=str)


@mcp.tool()
def editor_get_transcript_status(
    path: str | None = None,
    media_id: str | None = None,
    source_path: str | None = None,
) -> str:
    """Poll a transcript started by `editor_get_transcript`, identified by the
    same file. `state` is `"running"` (keep polling), `"done"` (the result is
    on this response: `text`, `segments`, and `words` with per-word
    `start`/`end` in source seconds), or `"idle"` (nothing was ever started for
    this file — call `editor_get_transcript` first). A failure comes back as an
    `error` instead."""
    import json

    return json.dumps(
        _op("editor_get_transcript_status", **_media_args(path, media_id, source_path)),
        indent=2,
        default=str,
    )


@mcp.tool()
def editor_get_timeline_transcript(start: bool = False) -> str:
    """Read what the WHOLE TIMELINE says, in timeline order and in TIMELINE
    frames — "what does this sequence say?" (D-329).

    **Use this, not `editor_get_transcript`, for any question about the
    sequence.** `editor_get_transcript` answers per FILE, in that file's own
    source seconds. A timeline is a set of trimmed, reordered windows onto one
    or more files, so a file's transcript contains speech you CUT OUT and gives
    times that are not where the words land in the edit. This tool does that
    mapping for you: it walks the clips in timeline order, keeps only the
    speech each clip actually shows, and converts every row to the timeline
    frame it plays at — at the clip's own `source_fps`, which is the step that
    is easy to get wrong by hand (a clip's `duration`/`source_start` are its
    OWN native frames while `start_frame` is a timeline frame; see B-077).

    It is the same stitch the Edit tab's Index panel renders, so what you read
    here is exactly what the user is looking at.

    Returns `rows`, in timeline order, each `{clipId, track, sourcePath,
    startFrame, endFrame, sourceStart, sourceEnd, text}`. `startFrame` is what
    to pass to `editor_set_playhead` to jump to that line. Also `fps`, and
    `sources`: one entry per distinct source FILE with `{path, clipCount,
    state}` — `clipCount` is how many clips play from it, and `state` is
    `"done"` / `"running"` / `"idle"` / `"error"`.

    **Transcription is per FILE, and a timeline usually reuses one file many
    times** (a silence cut makes dozens of clips from one `.MOV`), so a
    sequence of 40 clips typically needs one or two jobs, not 40. Pass
    `start=True` to kick off the missing ones — one per file, cached files
    skipped, and a previous failure retried. Then poll this same tool until
    `pending` is `0`. Each job is a full Parakeet run: seconds to
    tens of seconds per file.

    **`rows` is always usable, even while `pending > 0`** — it covers every
    file that IS transcribed, so a partly-transcribed timeline gives you real
    rows now rather than nothing. Finds nothing in silent or music-only
    footage, which is normal and not an error.

    Reads video tracks only (hidden tracks, title/adjustment clips and still
    images are skipped, and a still has no audio to transcribe)."""
    import json

    args: dict = {}
    if start:
        args["start"] = True
    return json.dumps(_op("editor_get_timeline_transcript", **args), indent=2, default=str)


@mcp.tool()
def editor_analyze_video(
    path: str | None = None,
    media_id: str | None = None,
    source_path: str | None = None,
    question: str | None = None,
    scene_threshold: float | None = None,
    min_gap_s: float | None = None,
    max_candidates: int | None = None,
    force: bool = False,
) -> str:
    """Start a visual analysis of a video — "what CHANGED on screen, and when,"
    with EXACT timestamps. Returns immediately with `state`; poll
    `editor_analyze_video_status` until `"done"`, then read `events`
    (`[{time_s, event}]`) off that response.

    Timing comes from ffmpeg's own scene-change detection (deterministic,
    frame-accurate) and never from the model — the model only DESCRIBES a
    before/after frame pair at each detected moment, since a single static
    frame cannot show a click, a cut, or a spinner appearing; only the delta
    can. So `time_s` is trustworthy in a way a model-reported timestamp is not.

    Works well on anything with real visual change: screen recordings (clicks,
    spinners, toasts), ads, edited multi-shot footage. Finds NOTHING in a
    single continuous uncut shot (a talking head) — there is no scene change to
    key off; use `editor_get_transcript` for that content instead. The two are
    complementary, not alternatives.

    Identify the file with `path` (any absolute path — it does NOT have to
    be imported first, since "what's in this file?" is usually the question you
    want answered BEFORE importing), or with `media_id`/`source_path` for an
    item already in the project's media pool.

    `question` steers what each moment is described AS — "What UI event does
    this show?" for a screen recording, "What product or shot is this?" for an
    ad. The default is deliberately generic.

    `scene_threshold` (default 0.12, lower = more candidates), `min_gap_s`
    (1.0) and `max_candidates` (15) are CONTENT-DEPENDENT: the defaults were
    tuned against a slow screen recording, and a fast-cut ad or trailer has far
    more real cuts per second. **If the response has `truncated: true`,
    candidates were silently dropped at the cap — raise `max_candidates` and
    re-run.** For action-heavy footage raise `min_gap_s` too: sustained motion
    produces genuinely similar frames, which the model then describes
    similarly, a known and documented limit rather than a bug.

    Runs at roughly 4x realtime. Results are cached per file, so `state:
    "done"` can come back on this first call; `force=True` re-runs anyway."""
    import json

    args = _media_args(path, media_id, source_path)
    if question is not None:
        args["question"] = question
    if scene_threshold is not None:
        args["sceneThreshold"] = scene_threshold
    if min_gap_s is not None:
        args["minGapS"] = min_gap_s
    if max_candidates is not None:
        args["maxCandidates"] = max_candidates
    if force:
        args["force"] = True
    return json.dumps(_op("editor_analyze_video", **args), indent=2, default=str)


@mcp.tool()
def editor_analyze_video_status(
    path: str | None = None,
    media_id: str | None = None,
    source_path: str | None = None,
) -> str:
    """Poll an analysis started by `editor_analyze_video`, identified by the
    same file. `state` is `"running"` (keep polling), `"done"` (the result is
    on this response: `events` as `[{time_s, event}]`, plus `truncated` and
    `meta`), or `"idle"` (nothing was ever started for this file). A failure
    comes back as an `error` instead."""
    import json

    return json.dumps(
        _op("editor_analyze_video_status", **_media_args(path, media_id, source_path)),
        indent=2,
        default=str,
    )


# --------------------------------------------------------------------------- #
# Edit tab: recut (D-318) — find the dead air and the flubbed takes in a clip
# that is already on the timeline, then cut the ones you accept. Both detectors
# are READ-ONLY: they return candidates and never modify the timeline. The one
# tool here that DOES cut is `editor_ripple_delete_ranges`, and it only ever
# cuts ranges you hand it.
# --------------------------------------------------------------------------- #
@mcp.tool()
def editor_detect_silences(
    track: int,
    clip: int | None = None,
    min_silence_ms: float | None = None,
    force: bool = False,
) -> str:
    """Find the stretches of a timeline clip — or of a WHOLE TRACK — where
    **nobody is speaking**: "where is the dead air." Uses a real on-device
    voice-activity model (Silero VAD, D-319) over the audio, so it needs no
    transcript.

    - `track` — required.
    - `clip` — **optional**. Name a clip index (`editor_get_timeline` lists
      them) to ask about that one clip. **Omit it to sweep every analysable
      clip on the track in a single call** (D-342, fixes B-216) — do this for
      any cleanup pass, because asking one clip at a time is how whole stretches
      of a long timeline get skipped. A sweep is one request no matter how many
      clips it covers; calling this per clip is one request each.
    - `min_silence_ms` — the shortest gap worth reporting (default 600). Below
      about 400 you start getting the pauses *inside* sentences, which are not
      cut points.
    - `force` — re-run even though this exact clip range and threshold has
      already been analysed (the answer is cached per range+threshold).

    Either way only each clip's OWN trimmed range is analysed, so a source
    trimmed to its second half never reports silence from material nobody sees.

    **Reading the answer: check `state` first** (D-321). A normal clip finishes
    inside this call and comes back `state: "done"` with `silences`. A long one
    comes back `state: "running"` — the detection is still going, so poll
    `editor_detect_silences_status` with the same arguments until it says
    `done`. The answer is held for you either way; it is never computed and
    thrown away.

    Each entry of `silences` carries `startSecs`/`endSecs` (source seconds, what
    was measured), `sourceStartFrame`/`sourceEndFrame` (the clip's own source
    frames) and `startFrame`/`endFrame` — **timeline** frames, which is what
    `editor_ripple_delete_ranges` takes. An empty list is a normal answer, not
    an error: that clip has no gap that long.

    **A SWEEP (no `clip`) answers in a different, aggregate shape**, built so
    the clips that need a decision are readable without scanning the rest:
    `flagged` is the clips that found something, in full, each with its own
    `clip` index and `silences`; `clean` is a bare list of clip indices that
    came back with nothing; `running` / `notStarted` / `failed` / `skipped` say
    what has not answered and why; `totals` counts all of it. Act on `flagged`.

    **Nothing is cut**, by either form. This proposes; you decide. Pass the
    ranges you accept to `editor_ripple_delete_ranges`."""
    import json

    args: dict = {"track": track}
    if clip is not None:
        args["clip"] = clip
    if min_silence_ms is not None:
        args["minSilenceMs"] = min_silence_ms
    if force:
        args["force"] = True
    return json.dumps(_op("editor_detect_silences", **args), indent=2, default=str)


@mcp.tool()
def editor_detect_silences_status(
    track: int,
    clip: int | None = None,
    min_silence_ms: float | None = None,
) -> str:
    """Poll a silence detection started by `editor_detect_silences` (D-321).

    Pass the SAME `track` / `clip` / `min_silence_ms` you started it with — a
    detection is cached per clip range and threshold, so different arguments are
    a different question and will read as `state: "idle"`.

    `clip` is optional here for the same reason it is on the start tool (D-342):
    **omit it to poll a whole-track sweep**, and the answer comes back in the
    same aggregate shape the sweep returned, one request for the whole track.

    `state` is `running` (still going — poll again), `done` (with `silences`,
    exactly as `editor_detect_silences` returns them) or `idle` (nothing was
    ever started at this threshold). Starting nothing itself, this is a pure
    read and free to call."""
    import json

    args: dict = {"track": track}
    if clip is not None:
        args["clip"] = clip
    if min_silence_ms is not None:
        args["minSilenceMs"] = min_silence_ms
    return json.dumps(_op("editor_detect_silences_status", **args), indent=2, default=str)


@mcp.tool()
def editor_detect_retakes(
    track: int,
    clip: int | None = None,
    similarity: float | None = None,
    window_secs: float | None = None,
    min_words: int | None = None,
    max_span_utterances: int | None = None,
    phrase_min_words: int | None = None,
    recover_dark_regions: bool = True,
    force: bool = False,
) -> str:
    """Group the places in a timeline clip — or across a WHOLE TRACK — where the
    speaker **said the same line more than once**: the flubbed take, the
    stumble, the third attempt.

    Unlike `editor_detect_silences` this needs the transcript, because a retake
    is a fact about words. If one has not been made yet this starts it and
    returns `state: "running"` with a `note` — poll
    `editor_get_transcript_status`, then call this again. A transcript is made
    once per SOURCE FILE, so a sweep of fifty clips cut from one recording
    costs one transcription, not fifty.

    Once the words exist, the grouping itself follows the same start-then-poll
    contract as `editor_detect_silences` (D-321): `state: "done"` with `groups`
    if it finished inside this call, otherwise `state: "running"` — poll
    `editor_detect_retakes_status` with the same arguments. `force` re-runs a
    grouping that is already cached for this range and these thresholds.

    - `track` — required.
    - `clip` — **optional**. Name a clip index to ask about that one clip.
      **Omit it to sweep every analysable clip on the track in a single call**
      (D-342, fixes B-216) — do this for any cleanup pass. Asking one clip at a
      time is exactly how real retakes survived to a final cut. Either way the
      words are read across the whole continuous TAKE a clip belongs to rather
      than that clip alone (D-364, below); a named clip is still answered about
      on its own.
    - `similarity` — how alike two utterances must be to count as the same line
      (0..1, default 0.82).
    - `window_secs` — how far apart two takes may be (default 30). A line
      repeated half an hour later is a callback, not a retake.
    - `min_words` — a take with fewer than this many DISTINCT words is never
      grouped (default 3), which is what stops every "Yeah." pairing with every
      other one.
    - `max_span_utterances` — how many adjacent transcript utterances may be
      joined into one take (default 3). This is what finds a restart the ASR cut
      on segment boundaries of its own, which do not line up with the
      speaker's (D-327): a take is a SPAN of utterances, so one delivery can
      cover several. 1 restores the old utterance-to-utterance behaviour.
    - `phrase_min_words` — the detector's SECOND, independent signal (D-365):
      the shortest repeated PHRASE, in words, that marks two spans as one
      self-correction even when `similarity` says they are different sentences
      (default 3; **0 turns it off**). `similarity` asks "is this the same LINE
      again" and misses the equally common disfluency where a speaker repairs
      one phrase inside two otherwise-different sentences — measured on real
      footage, "and the third one called speculative speculating and the third
      one's called speculating speculative" against "speculative decoding okay
      and the third one call is speculative decoding and it's kind of clever"
      scores 0.495 against the 0.82 bar. A pair matched by EITHER signal is a
      group. The tradeoff is real and measured: across two whole real
      transcripts (698 utterance pairs) this arm newly admits 22 pairs, 21 of
      them genuine missed retakes and 1 a false positive — a deliberate
      parallel construction ("Every word turns itself into a question." /
      "Every other word turns itself into a kind of answer key..."), which text
      alone cannot tell from a repair. Groups found this way report a LOW
      `similarity`, so they sort to the top of anything ranked by it.
    - `recover_dark_regions` — **default true, and leave it that way** (D-349,
      B-216). The ASR's whole-file pass silently declines to transcribe some
      utterances inside windows it otherwise reads confidently: Parakeet
      dropped 19 stretches (about 93 s) across the three measured sources, with
      no error and no low-confidence score to filter on. Measured on Whisper,
      which this was first built against, the loss was **biased towards
      near-duplicate repeated material** — i.e. towards retakes — so grouping the raw transcript is
      blind in exactly the place this tool is looking. With this on, each clip's
      range is scanned for stretches where the VAD hears a voice and the
      transcript has no words, those windows are re-transcribed on their own,
      and the recovered lines are spliced in before grouping. The answer then
      carries `darkRegions` (how many holes were found) and
      `recoveredUtterances` (how many grouped lines exist only because of it).
      Set it false only when you already know the source is clean and want the
      answer in one round trip: the scan and each re-read are extra passes, so a
      first call typically returns `state: "transcribing"` once or twice more
      than it would otherwise.

    **Detection reads a continuous TAKE, not a clip** (D-364, fixes B-237).
    Consecutive clips cut from one uninterrupted stretch of one source file —
    what an earlier fine-grained silence pass leaves behind — are merged back
    into one run and grouped once. They have to be: a clip is routinely shorter
    than the sentence it is part of (the project this was measured on has clips
    of 0.25s and 0.58s), so a restart's two halves land in different clips and a
    view scoped to one clip can never hold both. Six of seven real retakes on
    that project spanned 2-5 clips each and were invisible for exactly that
    reason. A run stops at a change of source file, a jump backwards through the
    source, or more removed material than `window_secs` — nothing is compared
    that was never one take — and only material still ON the timeline is read,
    so a removed stretch between two clips of a run contributes nothing.

    Each group has `takes`, a `similarity` score, and `keep` — the index of the
    take this **suggests** keeping, which is the last one, normally what the
    speaker settled on. `keep` is a suggestion and nothing more: text alone
    cannot always tell a retake from a later line that merely extends an earlier
    one, so read the `text` before cutting.

    Each take carries its `text`, its `startSecs`/`endSecs`, the `clips` it
    lands in, and one `segments` entry per clip with the same three frame spaces
    `editor_detect_silences` returns. **A take inside one clip also carries the
    flat `startFrame`/`endFrame` it always did; a take that spans several does
    NOT** — no single range describes it, and a clamped one would quietly
    under-cut. Pass every entry of `segments` to `editor_ripple_delete_ranges`.

    A single-clip answer also carries `readAcrossClips` when the clip was read
    as part of a longer run: the clip indices that run covered.

    **A SWEEP (no `clip`) answers in a different, aggregate shape**: `flagged`
    is the clips that found something, in full, each with its own `clip` index
    and `groups`; `clean` is a bare list of clip indices with nothing in them;
    `running` / `transcribing` / `notStarted` / `failed` / `skipped` say what
    has not answered and why (`transcribing` is waiting on the words, not on
    the grouping); `totals` counts all of it, and `runs` says how many
    continuous takes the track's clips were read as. A group that spans several
    clips is reported ONCE, under the earliest clip it touches, with every clip
    it covers named inside its takes. Act on `flagged`.

    **Every group carries `status`** (D-382): the detector's groups go through
    the same deterministic coverage gate an `editor_propose_retakes` group
    does, mapped onto the track's words by word midpoint. `"verified"` means
    every word a cut would remove survives in the kept take; `"refused"` comes
    with `reason`, `reasonText` and `offending` — the words the cut would lose.
    This detector over-cuts (B-246), so do not cut a refused group unless the
    person has listened and asks for it. For your own judgement of the track
    instead, read it with `editor_get_word_transcript` and propose with
    `editor_propose_retakes`; this tool is the deterministic fallback.

    **Nothing is cut**, by either form. Pass the takes you want gone to
    `editor_ripple_delete_ranges`."""
    import json

    args: dict = {"track": track}
    if clip is not None:
        args["clip"] = clip
    if similarity is not None:
        args["similarity"] = similarity
    if window_secs is not None:
        args["windowSecs"] = window_secs
    if min_words is not None:
        args["minWords"] = min_words
    if max_span_utterances is not None:
        args["maxSpanUtterances"] = max_span_utterances
    if phrase_min_words is not None:
        args["phraseMinWords"] = phrase_min_words
    if not recover_dark_regions:
        args["recoverDarkRegions"] = False
    if force:
        args["force"] = True
    return json.dumps(_op("editor_detect_retakes", **args), indent=2, default=str)


@mcp.tool()
def editor_detect_retakes_status(
    track: int,
    clip: int | None = None,
    similarity: float | None = None,
    window_secs: float | None = None,
    min_words: int | None = None,
    max_span_utterances: int | None = None,
    phrase_min_words: int | None = None,
    recover_dark_regions: bool = True,
) -> str:
    """Poll a retake grouping started by `editor_detect_retakes` (D-321).

    Pass the SAME arguments you started it with — a grouping is cached per
    range and per threshold set, so different arguments read as `state: "idle"`.

    `clip` is optional here for the same reason it is on the start tool (D-342):
    **omit it to poll a whole-track sweep**, and the answer comes back in the
    same aggregate shape the sweep returned, one request for the whole track.

    Naming a clip polls the whole continuous take that clip belongs to (D-364,
    B-237) and reports the groups that actually touch the clip you named, so a
    poll and a sweep can never disagree about the same material.

    `state` is `running`, `done` (with `groups`, exactly as
    `editor_detect_retakes` returns them) or `idle`. If the transcript itself is
    still being made this reports that instead, with a `note` pointing at
    `editor_get_transcript_status` — the same answer the start tool gives, since
    there is nothing to group until there are words. `state: "transcribing"` can
    also mean the D-349 dark-region scan or one of its re-reads is still going;
    the `note` says which. Keep `recover_dark_regions` the same as you started
    with, for the same reason the thresholds must match. Polling carries a job
    the start tool began on to its answer (the scan's re-reads, then the
    grouping), so keep polling this rather than calling the start tool again
    (B-249). For arguments no start call used it is a pure read that starts
    nothing, and says so with `state: "idle"`."""
    import json

    args: dict = {"track": track}
    if clip is not None:
        args["clip"] = clip
    if similarity is not None:
        args["similarity"] = similarity
    if window_secs is not None:
        args["windowSecs"] = window_secs
    if min_words is not None:
        args["minWords"] = min_words
    if max_span_utterances is not None:
        args["maxSpanUtterances"] = max_span_utterances
    if phrase_min_words is not None:
        args["phraseMinWords"] = phrase_min_words
    if not recover_dark_regions:
        args["recoverDarkRegions"] = False
    return json.dumps(_op("editor_detect_retakes_status", **args), indent=2, default=str)


@mcp.tool()
def editor_get_word_transcript(
    track: int,
    offset: int | None = None,
    max_words: int | None = None,
    start: bool = False,
) -> str:
    """Read one timeline track as numbered words, to find its RETAKES yourself
    (D-380). The app runs no model for this: you judge, it checks.

    Returns `text` — one word per line, `index<TAB>start-end<TAB>word`, times in
    the source file's seconds, with `--- segment` hint lines (a new segment also
    starts at every clip boundary) — plus `viewId`, `totalWords`, `offset`,
    `returned` and `nextOffset`. **The first page (offset 0) also carries
    `instructions`: the rules to judge by and how to answer. Read them before
    proposing anything.** They are the rules a blind evaluation measured at
    0.00 s of unique speech lost across nine runs.

    - `track` — required. The view is every clip on it that has audio, in play
      order, showing only the words those clips still show (a word belongs to
      the clip holding its midpoint).
    - `offset` / `max_words` — paging (default 2500 words a page, at most 4000).
      Indices are GLOBAL: page two starts at `nextOffset`, not at 0. Keep
      calling until `nextOffset` is null.
    - `start` — transcribe any source on the track that has no transcript yet
      (once per file). Until every source has one this answers
      `state: "transcribing"` and serves no words, because the indices would
      shift when the rest lands.

    **`viewId` is what your indices mean.** It changes whenever the track's
    words change — an edit, a newly finished transcript, an applied re-read —
    and `editor_propose_retakes` / `editor_retranscribe_words` refuse a stale
    one. Re-read and re-derive when that happens.

    `editor_detect_retakes` is the deterministic fallback detector; it does not
    read this view's judgement and is gated the same way (D-382). Nothing is
    cut by this tool."""
    import json

    args: dict = {"track": track}
    if offset is not None:
        args["offset"] = offset
    if max_words is not None:
        args["maxWords"] = max_words
    if start:
        args["start"] = True
    return json.dumps(_op("editor_get_word_transcript", **args), indent=2, default=str)


@mcp.tool()
def editor_propose_retakes(track: int, groups: list, view_id: str | None = None) -> str:
    """Hand the app YOUR retake groups for one track, as word-index ranges from
    `editor_get_word_transcript` (D-380). Each group goes through a
    deterministic coverage gate and is stored for the person to review in the
    Recut panel. **Nothing is cut.**

    - `track` — required.
    - `view_id` — the `viewId` your indices were read under. A stale one is
      refused outright and nothing changes: re-read, re-derive, resubmit.
    - `groups` — `[{"line": str, "takes": [{"first": int, "last": int}, ...],
      "keep": int, "note": str, "confirm": {"<word index>": "<reason>"}}]`.
      Takes are inclusive word ranges in spoken order, non-overlapping; `keep`
      indexes `takes`. `line`, `note` and `confirm` are optional. **Each call
      REPLACES the track's whole set**, so send every group you still stand by.
      An empty list clears it (no `view_id` needed).

    The gate accepts a group only if every word a deleted take holds also
    survives in the kept take (stopwords, fillers, false starts and stutters
    forgiven; near-identical spellings of long words match). It cannot hear,
    and does not judge which take is better. Each group comes back as:

    - `verified` — the gate proved the deletions lose no word;
    - `ai_confirmed` — the gate refused on content, and you vouched for every
      word it named via `confirm`; shown to the person with your reasons;
    - `refused` — with `reason`, `reasonText` and `offending` (word indices and
      words). `notConfirmable: true` means the group is malformed or fights
      another group, so it must be fixed, not confirmed.

    **Resolving a refusal is your loop:** (1) narrow the take so unique words
    fall outside it; (2) if a word looks misheard, `editor_retranscribe_words`
    over that stretch and apply a better reading (the `viewId` then changes);
    (3) if the content truly survives (an inflection, a mishearing the re-read
    kept, a word only in the abandoned attempt), resubmit with `confirm` giving
    a reason for EVERY offending word; (4) otherwise drop it. An unresolved
    group stays `refused` and is still shown to the person, untickable.

    Each take carries its `text` and `segments` — the same timeline-frame
    entries `editor_detect_retakes` returns — so if the person asks you to cut,
    pass every segment of every non-kept take to `editor_ripple_delete_ranges`.
    Do not cut unless asked."""
    import json

    args: dict = {"track": track, "groups": groups}
    if view_id is not None:
        args["viewId"] = view_id
    return json.dumps(_op("editor_propose_retakes", **args), indent=2, default=str)


@mcp.tool()
def editor_retranscribe_words(
    track: int,
    view_id: str,
    first: int,
    last: int,
    apply: bool = False,
    force: bool = False,
) -> str:
    """Re-run the speech recogniser over a stretch of words, to check whether
    a word the coverage gate refused was misheard (D-380). ASR only — the app
    makes no judgement; deciding whether the new reading is better is yours.

    - `track`, `view_id` — as in `editor_propose_retakes`; a stale `view_id`
      is refused.
    - `first` / `last` — the inclusive word range to check (one source file,
      at most about a minute with context). The app re-reads that audio in
      isolation with ~2 s of context either side, never cutting a word in half.
    - `apply` — false (default): a PREVIEW. Returns `current` (the view's words
      in that window, with their indices) beside `reread` (the fresh reading)
      and `identical`; nothing changes. true: splice the reading into the
      file's transcript — for every consumer, the Transcript panel and the
      detectors included — and return the new `viewId`, the words now in the
      window with their new indices, and `indexShift` (how far every later
      index moved). Re-derive your groups, then resubmit with the new `viewId`.
    - `force` — re-run a re-read already cached for this window.

    A re-read takes a few seconds; one that outlasts this call answers
    `state: "running"` — call again with the same arguments to collect it.
    Nothing is cut."""
    import json

    args: dict = {"track": track, "viewId": view_id, "first": first, "last": last}
    if apply:
        args["apply"] = True
    if force:
        args["force"] = True
    return json.dumps(_op("editor_retranscribe_words", **args), indent=2, default=str)


@mcp.tool()
def editor_detect_dark_regions(
    track: int,
    clip: int,
    min_dark_secs: float | None = None,
    max_word_secs: float | None = None,
    rms_floor_scale: float | None = None,
    force: bool = False,
) -> str:
    """Find the stretches of a clip where **there is speech nobody transcribed**
    (D-349, fixes the transcription half of B-216).

    The ASR's whole-file pass does not merely mis-hear some utterances — it can
    emit no words for them, inside a window it is otherwise reading
    confidently. There is no error, no warning and no low-confidence score to
    filter on, so the transcript reads plausibly and is missing a sentence.
    Measured on real footage with Parakeet: 19 dropped stretches (about 93 s)
    across three sources.

    This tool crosses the two signals the app already has — the acoustic VAD
    ("is anyone talking") and the transcript ("what was read") — and reports
    where they disagree.

    - `track` / `clip` — required. Only the clip's own trimmed source range is
      scanned. (No whole-track sweep: unlike the other two detectors, the
      answer here is normally consumed by `editor_detect_retakes`, which runs
      this automatically over every clip it groups.)
    - `min_dark_secs` — how much unaccounted-for speech a stretch must hold
      before it is flagged (default 1.2). Measured on a plateau: 1.0 to 1.5 give
      the same answer on both test files.
    - `max_word_secs` — a transcript word LONGER than this contributes no
      coverage. The default is NO bound: Parakeet cannot stretch a word across
      a hole, so there is nothing for a bound to catch. Pass a real value (e.g.
      2.0) only for a transcript from an aligner that can smear one word over
      a silent stretch.
    - `rms_floor_scale` — multiplier on the amplitude floor (default 1.0). The
      floor is calibrated **per file** from the quietest speech this recording's
      own transcript read correctly, never a constant — mic, gain and room
      differ per shoot. Below 1.0 trades precision for recall.

    `state: "done"` carries `regions`, each in the same three frame spaces
    `editor_detect_silences` returns, plus the `stretch…` bounds it was found in
    and its `rmsPeak`. It also carries `rmsFloor` / `calibrationSpans` /
    `gatedOut`: **`rmsFloor: null` means the range held too few
    well-transcribed utterances to calibrate a gate, so the answer is ungated**
    and "no regions" is weaker evidence than usual. Otherwise start-then-poll
    like the other two — `editor_detect_dark_regions_status` with the same
    arguments.

    **Nothing is cut and nothing is re-transcribed by this tool** — it reports.
    `editor_detect_retakes` is what re-reads these windows in isolation and
    splices the recovered words into the transcript it groups."""
    import json

    args: dict = {"track": track, "clip": clip}
    if min_dark_secs is not None:
        args["minDarkSecs"] = min_dark_secs
    if max_word_secs is not None:
        args["maxWordSecs"] = max_word_secs
    if rms_floor_scale is not None:
        args["rmsFloorScale"] = rms_floor_scale
    if force:
        args["force"] = True
    return json.dumps(_op("editor_detect_dark_regions", **args), indent=2, default=str)


@mcp.tool()
def editor_detect_dark_regions_status(
    track: int,
    clip: int,
    min_dark_secs: float | None = None,
    max_word_secs: float | None = None,
    rms_floor_scale: float | None = None,
) -> str:
    """Poll a dark-region scan started by `editor_detect_dark_regions` (D-349).

    Pass the SAME arguments you started it with — a scan is cached per clip
    range and per threshold set, so different arguments read as `state: "idle"`.
    `state` is `running`, `done` (with `regions`, exactly as the start tool
    returns them) or `idle`. If the transcript itself is still being made this
    reports that instead, with a `note` pointing at
    `editor_get_transcript_status`: a dark region is defined against the
    transcript's own words, so there is nothing to compare the audio to until
    they exist. A pure read."""
    import json

    args: dict = {"track": track, "clip": clip}
    if min_dark_secs is not None:
        args["minDarkSecs"] = min_dark_secs
    if max_word_secs is not None:
        args["maxWordSecs"] = max_word_secs
    if rms_floor_scale is not None:
        args["rmsFloorScale"] = rms_floor_scale
    return json.dumps(_op("editor_detect_dark_regions_status", **args), indent=2, default=str)


@mcp.tool()
def editor_ripple_delete_ranges(track: int, ranges: list) -> str:
    """Cut N stretches out of one track and close every gap behind them, **as a
    single edit** — the apply half of `editor_detect_silences` /
    `editor_detect_retakes`, and the same thing the Recut panel's Cut button
    does.

    - `track` — the track index to cut on.
    - `ranges` — a list of `{"startFrame": int, "endFrame": int}` in **TIMELINE**
      frames, half-open. The `startFrame`/`endFrame` of a detected silence or
      retake take are already in exactly this form.

    Ranges are sorted, merged and applied back-to-front for you, so overlapping
    or out-of-order input is safe and you never have to compensate for an
    earlier cut having moved a later one.

    One call is **one undo entry**, however many ranges it removes — which is
    the reason this exists rather than looping `editor_split_clip` +
    `editor_remove_clip` + `editor_remove_gap` yourself. The `undo` tool
    reverses the whole call as that one entry.

    **Read the answer; do not assume it (B-197).** `ok: true` means every range
    really was cut. A range that CANNOT be — a sync-locked track has a clip
    straddling the point its ripple would have to close (B-033), an A/V-linked
    partner cannot be razored there (D-129), the range describes no real
    material — is left ENTIRELY alone (its material stays, no half-cut hole),
    and the call answers `ok: false` with `applied` (how many ranges did land,
    still as one undo entry), `requested`, and `skipped`: each un-cut range's
    `startFrame`/`endFrame` and the `reason` it was refused. Re-read the
    timeline before trusting any frame number you were holding, or undo.
    Refused outright with an `error`, nothing applied, if the track is locked
    or not one range could be cut."""
    import json

    return json.dumps(
        _op("editor_ripple_delete_ranges", track=track, ranges=ranges),
        indent=2,
        default=str,
    )


# --------------------------------------------------------------------------- #
# multi-shot session (D-033)
# --------------------------------------------------------------------------- #
@mcp.tool()
def list_shots() -> str:
    """Every shot in the session and which one is active. A grading job is N
    shots from one shoot; each shot keeps its own grade (grade.json sidecar,
    D-025) and its own agent-activity feed. Returns {shots: [{path, name,
    frameCount, frame, width, height, fps, ...}], active, count}. An empty
    `shots` means a single still / nothing loaded."""
    import json

    return json.dumps(_op("list_shots"), indent=2, default=str)


@mcp.tool()
def undo() -> str:
    """Undo the most recent undoable action, on ANY tab — exactly what Cmd/Ctrl+Z
    does (D-383). The history is one stack shared by Edit, Motion and Colorist,
    so this reverses the latest thing done anywhere, whether a person or an
    agent did it, and the app switches to the tab that action belonged to, the
    way the keyboard shortcut does. A multi-step tool such as
    `editor_ripple_delete_ranges` is one entry, so one `undo` reverses all of it.

    An empty stack is not an error: you get `ok: true` and `undone: null`
    with a `note`. Read `undone` before acting on the result — it names what was
    reversed — and `undoLabel` to see what the NEXT `undo` would reverse.

    Returns {ok, undone: {tab, label} | null, activeTab, canUndo, canRedo,
    undoLabel, redoLabel, note?}."""
    import json

    return json.dumps(_op("undo"), indent=2, default=str)


@mcp.tool()
def redo() -> str:
    """Redo the action `undo` last reversed, on any tab — exactly what Cmd/Ctrl+Y
    does (D-383). A fresh edit after an undo discards the redo branch, so redo
    only works until you do something else. The app switches to the tab the
    redone action belongs to. An empty redo stack is `ok: true` with
    `redone: null` and a `note`, not an error.

    Returns {ok, redone: {tab, label} | null, activeTab, canUndo, canRedo,
    undoLabel, redoLabel, note?}."""
    import json

    return json.dumps(_op("redo"), indent=2, default=str)


@mcp.tool()
def set_active_shot(index: int | None = None, path: str | None = None) -> list:
    """Switch the active shot by 0-based `index` (from list_shots) or by `path`
    / filename. Saves the current shot's grade, loads the target, restores its
    grade (neutral if it has none), and scopes the activity feed to it. Grade
    each shot in turn: set_active_shot(1) -> grade -> set_active_shot(2) -> grade.
    Returns the target shot's rendered frame + the updated shot list."""
    args: dict = {}
    if index is not None:
        args["index"] = index
    if path is not None:
        args["path"] = path
    if not args:
        return _result({"ok": False, "error": "pass index or path", "result": None})
    return _result(_op("set_active_shot", **args))


@mcp.tool()
def add_shots(paths: list[str]) -> list:
    """Add one or more clips to the session by ABSOLUTE path and switch to the
    last one. A clip already in the session is updated in place. Use this to load
    a whole shoot, then grade shot by shot with set_active_shot. Returns the
    newly-active shot's frame + the shot list."""
    return _result(_op("add_shots", paths=paths))


# --------------------------------------------------------------------------- #
# project model (D-037)
# --------------------------------------------------------------------------- #
@mcp.tool()
def list_projects() -> str:
    """Every saved Apelles project in the projects folder (`~/Movies/Chroma` by
    default), newest first. A project is a `<name>.chroma` directory holding
    project.json (shots referenced by absolute source path — media is never
    copied), thumb.jpg, and grades/<shotId>.grade.json per shot. Returns
    {projects: [{name, path, modified, shotCount}], folder}. Open one with
    open_project."""
    import json

    return json.dumps(_op("list_projects"), indent=2, default=str)


@mcp.tool()
def open_project(name_or_path: str) -> str:
    """Open a saved project by name (see list_projects) or absolute `.chroma`
    path. Loads its shots into the session, restores each shot's grade, and puts
    the app in the editor. A shot whose source file is missing is flagged "media
    offline" — not fatal; relink it in the app. Returns {opened: {name, path},
    shots}.

    Switches the WHOLE app, every tab: the Edit tab reloads this project's own
    timeline and media pool, and the Motion tab its manifest (B-083). Their
    reload is a beat behind this call's return — if an `editor_*` op right
    after this says the timeline is still loading, retry it once."""
    import json

    arg = name_or_path
    key = "path" if ("/" in arg or arg.endswith(".chroma")) else "name"
    return json.dumps(_op("open_project", **{key: arg}), indent=2, default=str)


@mcp.tool()
def new_project(name: str, media_paths: list[str] | None = None) -> str:
    """Create a new `<name>.chroma` project in the projects folder from the given
    media (absolute paths; may be empty and added later), then open it in the
    editor. Media is referenced in place, never copied. Returns {created:
    {name, path}}.

    B-171: `media_paths` lands in the Edit tab's media pool only — NOT placed
    on the timeline. Follow with editor_add_clip (per path, in whatever order
    you actually want them) to place any of them.

    Like open_project, this switches every tab onto the new project — the Edit
    tab's timeline/media pool and the Motion tab's manifest all reload for it
    (B-083), a beat behind this call's return."""
    import json

    return json.dumps(
        _op("new_project", name=name, media_paths=media_paths or []),
        indent=2,
        default=str,
    )


@mcp.tool()
def save_project() -> str:
    """Save the open project: rewrite project.json (shots + active shot),
    persist the active shot's grade.json, and regenerate the launcher thumb.
    Autosave already does this on a debounce while editing — call this to force
    an immediate write. Errors if no project is loaded or the session is an
    unsaved "Untitled" (save it as a project in the app first)."""
    import json

    return json.dumps(_op("save_project"), indent=2, default=str)


@mcp.tool()
def set_project_settings(
    width: int | None = None,
    height: int | None = None,
    fps: float | None = None,
    color_space: str | None = None,
) -> str:
    """Set the open project's output spec (D-038): one resolution / frame rate /
    colour space for the whole (possibly multi-shot) project instead of deriving
    everything from whichever clip is loaded.

    Partial merge — only the arguments you pass are changed; the rest are left
    as-is. A project with no settings behaves exactly as clip-derived (the
    default). Export uses width+height (the graded composite is resized to it as
    the final step) and fps (encoder timebase). `color_space` (`rec709` /
    `rec2020` / `dci-p3` / `srgb`) is **stored + surfaced only** — a real
    colour-managed pipeline is D-004, not this. Returns the merged settings.

    Needs a saved project loaded (open_project / new_project first)."""
    import json

    args: dict[str, Any] = {}
    if width is not None:
        args["width"] = width
    if height is not None:
        args["height"] = height
    if fps is not None:
        args["fps"] = fps
    if color_space is not None:
        args["colorSpace"] = color_space
    if not args:
        return json.dumps({"error": "pass at least one of width, height, fps, color_space"})
    return json.dumps(_op("set_project_settings", **args), indent=2, default=str)


# --------------------------------------------------------------------------- #
# masks
# --------------------------------------------------------------------------- #
@mcp.tool()
def add_subject_mask(bbox: list[float] | None = None, mode: str = "additive") -> list:
    """Add a new mask container with an AI subject sub-mask and generate the
    matte. bbox is [x0, y0, x1, y1] in source pixels around the subject; omit
    for a near-full-frame prompt. On a video this routes through SAM 2 (sidecar);
    on a still, ONNX SAM.

    mode is the sub-mask's composition mode: "additive" (default), "subtractive",
    or "intersect" — the same Add / Subtract / Intersect the app's mask menu uses.
    Returns {maskId, subMaskId, mode} and the rendered frame."""
    args: dict = {"mode": mode}
    if bbox is not None:
        args["bbox"] = bbox
    return _result(_op("add_subject_mask", timeout_ms=AI_MASK_TIMEOUT_MS, **args))


@mcp.tool()
def add_component(
    mask_id: str,
    type: str,
    mode: str = "subtractive",
    bbox: list[float] | None = None,
    geometry: MaskGeometry | None = None,
) -> list:
    """Add a sub-mask (a "component") to an EXISTING mask container — the agent's
    equivalent of the app's "Add to / Subtract from / Intersect with Mask" menu.

    Use it to refine a mask by composition: a `subtractive` Subject component
    carves a SAM-segmented region out of the container's matte (edge-aware);
    a `subtractive` Radial or Linear carves a geometric region. An `additive`
    component grows the mask.

    type: "subject" | "radial" | "linear" | "brush".
    mode: "subtractive" (default — the usual reason to add a component),
          "additive", or "intersect".
    bbox: [x0,y0,x1,y1] source px — for type "subject" (the SAM prompt box).
    geometry: for "radial" {cx,cy,rx,ry,rotation?,feather?};
              for "linear" {startX,startY,endX,endY,range?}.  (source px)

    Returns {maskId, subMaskId, type, mode} and the rendered frame. To change a
    component's mode later use `set_submask_mode`."""
    args: dict = {"mask_id": mask_id, "type": type, "mode": mode}
    if bbox is not None:
        args["bbox"] = bbox
    if geometry is not None:
        args["geometry"] = to_wire(geometry)
    return _result(_op("add_component", timeout_ms=AI_MASK_TIMEOUT_MS, **args))


@mcp.tool()
def set_submask_mode(sub_mask_id: str, mode: str) -> list:
    """Set a sub-mask's composition mode: "additive", "subtractive", or
    "intersect" (same as the app's Add / Subtract from / Intersect with Mask).
    sub_mask_id is from get_state / list_masks. Flipping a component to
    "subtractive" carves it out of the rest of its mask container."""
    return _result(_op("set_submask_mode", sub_mask_id=sub_mask_id, mode=mode))


@mcp.tool()
def add_mask_keyframe(
    mask_id: str, sub_mask_id: str, frame: int | None = None
) -> list:
    """Keyframe a SHAPE sub-mask's geometry (D-034). Snapshots the sub-mask's
    current geometry — radial: centre / radii / rotation / feather; linear:
    endpoints / range; brush: stroke points — as a keyframe at `frame` (default:
    the current frame). The engine interpolates the geometry per source frame on
    scrub / playback / export, so a mask that can't be SAM-tracked (a hand, a
    product, a light, a reflection, a patch of sky) follows the subject by hand.

    Workflow: seek(0) -> add_mask (radial over the face) -> add_mask_keyframe;
    seek(90) -> move the mask (add_mask again with new geometry, or the app's
    controls) -> add_mask_keyframe. The mask now glides between the keys.

    Geometry ONLY — grade adjustments, mode, invert, opacity are not keyframed.
    Re-calling at a frame that already has a key updates it. A sub-mask can't be
    both AI-tracked (chromaTrackDir) and keyframed — tracked wins. mask_id /
    sub_mask_id are from list_masks / get_state."""
    args: dict = {"mask_id": mask_id, "sub_mask_id": sub_mask_id}
    if frame is not None:
        args["frame"] = frame
    return _result(_op("add_mask_keyframe", **args))


@mcp.tool()
def list_mask_keyframes(mask_id: str, sub_mask_id: str) -> str:
    """List a shape sub-mask's geometry keyframes (D-034): the frame index and
    the snapshotted geometry params for each. Returns {maskId, subMaskId, type,
    tracked, keyframes: [{frame, params}]}. Empty `keyframes` = a static mask."""
    import json

    return json.dumps(
        _op("list_mask_keyframes", mask_id=mask_id, sub_mask_id=sub_mask_id),
        indent=2,
        default=str,
    )


@mcp.tool()
def clear_mask_keyframe(mask_id: str, sub_mask_id: str, frame: int) -> list:
    """Remove ONE geometry keyframe (D-034), the one at `frame` (a frame from
    list_mask_keyframes). When the last keyframe is removed the sub-mask becomes
    fully static again."""
    return _result(
        _op("clear_mask_keyframe", mask_id=mask_id, sub_mask_id=sub_mask_id, frame=frame)
    )


@mcp.tool()
def clear_mask_keyframes(mask_id: str, sub_mask_id: str) -> list:
    """Remove ALL geometry keyframes from a shape sub-mask (D-034) — it goes back
    to a single static geometry (whatever it currently interpolates to is NOT
    baked; the sub-mask keeps its base parameters)."""
    return _result(
        _op("clear_mask_keyframes", mask_id=mask_id, sub_mask_id=sub_mask_id)
    )


@mcp.tool()
def track_subject(sub_mask_id: str, mode: str = "fast") -> list:
    """Propagate a subject sub-mask across the whole clip (SAM 2 memory
    propagation). mode: "fast" (guided-filter edge, upgrades to ViTMatte on
    seek-settle) or "quality" (ViTMatte every frame — the pre-export pass).
    The matte is read from disk per frame at render time."""
    return _result(
        _op("track_subject", timeout_ms=AI_MASK_TIMEOUT_MS, sub_mask_id=sub_mask_id, mode=mode)
    )


@mcp.tool()
def depth_track(
    from_frame: int | None = None,
    to_frame: int | None = None,
    step: int = 1,
    input_size: int = 518,
    sub_mask_id: str | None = None,
) -> str:
    """Precompute a **temporally-consistent depth map for every frame** of the
    clip (Video Depth Anything — Small, in the AI sidecar) and point a depth
    sub-mask at the cache. This is what makes `apply_haze` track a MOVING CAMERA
    without the depth flickering — a per-frame model can't, a video-depth model
    (temporal attention across frames, like DaVinci Resolve's z-depth) can.

    Run `apply_haze` first (it creates the depth sub-mask); then call this to
    upgrade that mask from the static single-frame bake to the per-frame track.
    `sub_mask_id` defaults to the "Depth Haze" depth sub-mask.

    from_frame / to_frame: default the whole clip (a 4K clip — narrow the range).
    step: save density (every frame is still fed to the model). input_size: 518
      default; lower = faster, coarser.

    NON-blocking — the first run also downloads the ~112 MB checkpoint, and a
    long clip is minutes. Returns {started, jobId, dir, total} immediately; poll
    `depth_track_status`. Once done, scrub/playback/export read the per-frame
    depth automatically."""
    return json.dumps(
        _op("depth_track", from_frame=from_frame, to_frame=to_frame, step=step,
            input_size=input_size, sub_mask_id=sub_mask_id),
        indent=2, default=str,
    )


@mcp.tool()
def depth_track_status() -> str:
    """Poll the depth track started by `depth_track`. Returns
    {running, done, total, tracked} — `tracked: true` once a depth sub-mask
    carries the per-frame cache dir (the pass finished and the render now uses
    it). `running: false` with `tracked: false` means it errored or was
    cancelled — check the app log for '[depth]' / '[sidecar]' lines."""
    return json.dumps(_op("depth_track_status"), indent=2, default=str)


# --------------------------------------------------------------------------- #
# the AI environment (D-315)
#
# Every AI-backed tool above and in the Edit tab runs through one of two Python
# sidecars, and both run from ONE ~1.6 GB virtual environment the app builds
# itself, in the background, from its first launch. Until that finishes, those
# tools cannot work — so the state of the build is part of the agent-facing
# surface, not an implementation detail. These two ops are answered by
# `control.rs` in Rust with no frontend round trip (D-315), so they still answer
# while the app window is starting up, which is exactly when the build is
# running.
# --------------------------------------------------------------------------- #
@mcp.tool()
def ai_env_status() -> str:
    """Is the shared Python environment every AI feature needs built yet — and
    if not, how far along is it (D-315)?

    Call this when an AI-backed tool (`add_subject_mask`, `track_subject`,
    `depth_track`, `editor_get_transcript`, `editor_analyze_video`) fails with an
    error whose first word is `ai_env_not_ready`. That prefix is the machine
    signal that the environment is still being built — it is NOT a bad request
    and NOT a crashed sidecar, and the same call will work once this reports
    `"ready"`.

    Returns {phase, detail, packagesDone, packagesTotal, attempt, retryInSecs,
    lastError, venv, elapsedSecs}. Branch on `phase`:

      "ready"                usable now, so an AI failure is something else
      "checking" | "installingPython" | "creatingVenv" |
      "installingPackages" | "repairing"
                             still working — wait and poll. `packagesDone` /
                             `packagesTotal` are real counts parsed from uv, so
                             3/91 -> 60/91 is progress and a frozen pair with a
                             climbing `elapsedSecs` is one big wheel downloading
      "failed"               an attempt failed and another is already scheduled
                             in `retryInSecs` (almost always: no internet).
                             `ai_env_retry` skips that wait
      "unavailable"          cannot be built here at all — no bundled uv, no
                             lock file, or CHROMA_AI_ENV_NO_BOOTSTRAP is set.
                             NOT retried on a timer and NOT fixable by waiting,
                             so tell the human instead of polling

    Nothing else is blocked: Edit, Motion, Colorist, grading and export all work
    throughout. A non-ready phase is a reason to route around the AI tools for
    now, never a reason to stop working."""
    import json

    return json.dumps(_op("ai_env_status"), indent=2, default=str)


@mcp.tool()
def ai_env_retry() -> str:
    """Attempt the AI-environment build again right now, instead of waiting out
    the backoff `ai_env_status` reports in `retryInSecs` (D-315). Worth calling
    once you have fixed the likely cause — reconnecting the network is the usual
    one; pointless otherwise, since the backoff will try again by itself.

    Returns the same snapshot `ai_env_status` does, plus `started`: `true` if an
    attempt was really triggered, `false` if there was nothing to trigger —
    already `"ready"`, an attempt already running, or `"unavailable"` (which no
    amount of retrying changes). `false` is a normal answer, not a failure; read
    `phase` and act on that rather than calling this again.

    Retrying costs little and loses nothing: uv's wheel cache survives every
    failed attempt, so a build that died part-way resumes from what it had
    already downloaded rather than starting over."""
    import json

    return json.dumps(_op("ai_env_retry"), indent=2, default=str)


@mcp.tool()
def set_mask_adjust(
    mask_id: str,
    exposure: float | None = None,
    contrast: float | None = None,
    highlights: float | None = None,
    shadows: float | None = None,
    whites: float | None = None,
    blacks: float | None = None,
    temperature: float | None = None,
    tint: float | None = None,
    saturation: float | None = None,
    vibrance: float | None = None,
    dehaze: float | None = None,
    clarity: float | None = None,
    structure: float | None = None,
    sharpness: float | None = None,
    blur: float | None = None,
) -> list:
    """Grade *through* a mask — same knobs as set_primary, applied only where
    the mask (mask_id, from list_masks) is. Only passed args change.

    `blur` (0–100, mask-only) defocuses the masked region: the shader blends it
    toward a pre-blurred (~40px) copy of the frame, weighted by mask * blur/100.
    Use it to soften a background behind a subtractive-subject / depth mask
    ("blur the background"); `apply_haze` already dials it in.

    Grade by the numbers: sample the masked region (`sample_region`) before and
    after and cite the values; don't eyeball the matted area. For blur, a
    high-frequency edge under the mask should lose local contrast."""
    patch = {k: v for k, v in locals().items() if k != "mask_id" and v is not None}
    return _result(_op("set_mask_adjust", mask_id=mask_id, patch=patch))


@mcp.tool()
def apply_haze(amount: float = 1.0, protect_subject: bool = True, tracked: bool = False) -> list:
    """Depth-weighted atmospheric haze on the background — one action, pushes the
    subject forward.

    Adds a "Depth Haze" mask: the matte is a full-range depth mask, inverted, so
    its weight tracks distance (the subject ~0, the far wall ~max); the grade is
    negative dehaze (adds haze in-shader) + desaturation + a lifted black point
    and shadows + a background defocus (per-mask blur, D-027), all scaled by
    `amount` (1.0 = default, 0.4 subtle, 1.6 heavy).

    protect_subject (default true): a tracked ai-subject mask's own grade
    composites on top and keeps the subject punchy, so nothing extra is needed.
    Caveat: a subject physically in the far-depth band still picks up some haze.

    Depth: by default a single-frame Depth Anything V2 bake (static — fine for a
    locked-off shot; flickers on a moving camera). `tracked=true` (video only)
    also kicks off a `depth_track` — a per-frame temporally-consistent depth map
    (Video Depth Anything) that the render then follows frame-by-frame. That runs
    in the background (minutes on a long clip); poll `depth_track_status`. You
    can also call `depth_track` later to upgrade an existing haze mask.

    Grade by the numbers: `inspect_color` before and after — whole-frame
    saturation should drop and the black point lift; `sample` a background pixel
    vs a subject pixel and confirm the background moved more.
    Returns {maskId, subMaskId, amount, tracked} and the rendered frame."""
    return _result(
        _op(
            "apply_haze",
            timeout_ms=AI_MASK_TIMEOUT_MS,
            amount=amount,
            protect_subject=protect_subject,
            tracked=tracked,
        )
    )


@mcp.tool()
def invert_mask(sub_mask_id: str) -> list:
    """Invert a sub-mask (grade the outside instead of the inside)."""
    return _result(_op("invert_mask", sub_mask_id=sub_mask_id))


@mcp.tool()
def delete_mask(mask_id: str) -> list:
    """Delete a whole mask container (mask_id from list_masks)."""
    return _result(_op("delete_mask", mask_id=mask_id))


# --------------------------------------------------------------------------- #
# relight (D-048, MCP wrapping D-054)
# --------------------------------------------------------------------------- #
@mcp.tool()
def list_relight_lights() -> str:
    """List every light in the "Relight" grade layer (D-048) plus its depth
    source. Returns {lights: [{id, kind, x, y, radius, intensity, color,
    visible, chromaKeyframes?}], depthDir}. kind is "key" | "fill" | "rim" |
    "ambient" — only "ambient" changes the shading math (uniform tint, no
    position/falloff); the other three are UI presets sharing one math path.
    x/y/radius are 0-100 percentages of frame size. depthDir is the tracked
    Video-Depth-Anything directory (depth_track / "Track Depth" in the
    Relight panel) key/fill/rim lights shade against — null means those
    positional lights currently render as a no-op UNLESS a static depth bake
    exists (see the Relight panel's "Bake Depth" button, D-054); ambient
    lights need no depth source at all."""
    import json

    return json.dumps(_op("list_relight_lights"), indent=2, default=str)


@mcp.tool()
def add_relight_light(
    kind: str = "key",
    x: float | None = None,
    y: float | None = None,
    radius: float | None = None,
    intensity: float | None = None,
    color: str | None = None,
) -> list:
    """Add a light to the "Relight" grade layer (D-048) — a deterministic,
    depth-driven virtual light, the agent's path to relight without driving
    the canvas puck (RelightPuckLayer) directly.

    kind: "key" | "fill" | "rim" | "ambient". Each has a sensible preset
    default (e.g. "key" = warm, screen-left, tight falloff) applied first;
    only the args you pass override it. "ambient" ignores x/y/radius (it
    tints the whole frame uniformly, no position/falloff).

    x/y: 0-100, percentage of frame width/height. radius: 0-100, percentage
    of the longer frame dimension — falloff distance, ignored for ambient.
    intensity: 0-200 (100 = the shader's baseline light strength). color:
    "#rrggbb".

    A positional (key/fill/rim) light needs a depth source to actually shade
    anything — run depth_track first (temporal, video only), or use the
    Relight panel's "Bake Depth" button (static single-frame fallback,
    D-054, also works on a still). Returns {light} and the rendered frame."""
    args: dict = {"kind": kind}
    if x is not None:
        args["x"] = x
    if y is not None:
        args["y"] = y
    if radius is not None:
        args["radius"] = radius
    if intensity is not None:
        args["intensity"] = intensity
    if color is not None:
        args["color"] = color
    return _result(_op("add_relight_light", **args))


@mcp.tool()
def set_relight_light(
    id: str,
    x: float | None = None,
    y: float | None = None,
    radius: float | None = None,
    intensity: float | None = None,
    color: str | None = None,
    visible: bool | None = None,
    kind: str | None = None,
) -> list:
    """Update an existing relight light (id from list_relight_lights /
    add_relight_light). Only passed args change. Same field meanings as
    add_relight_light. Set visible=false to temporarily disable a light
    without deleting it. Returns {id, patch} and the rendered frame."""
    patch = {k: v for k, v in locals().items() if k != "id" and v is not None}
    return _result(_op("set_relight_light", id=id, **patch))


@mcp.tool()
def delete_relight_light(id: str) -> list:
    """Delete one light from the "Relight" grade layer (id from
    list_relight_lights). Does not touch the depth track/bake or any other
    light."""
    return _result(_op("delete_relight_light", id=id))


# --------------------------------------------------------------------------- #
# scopes — grade by the numbers
# --------------------------------------------------------------------------- #
@mcp.tool()
def inspect_color(frame: int | None = None, reference: str | None = None) -> list:
    """Measure the current frame. Returns the RGB parade and vectorscope as
    images, plus a numeric summary: black/white points (1st/99th-pct luma),
    luma + per-channel clip %, mean RGB, per-zone (shadow/mid/highlight) means,
    the measured colour cast (warmCool = mid R-B, greenMagenta = mid G-(R+B)/2),
    mean saturation, and a 12-bin saturation-weighted hue histogram (an orange
    cluster ~ skin, cyan/blue ~ sky). The histogram is passed through from the app.

    Pass `reference` (an absolute image path) to also get that image's scopes and
    a `gap` object of HINTS that map onto knobs (not commands): an EV-ish
    exposure delta, temperature/tint direction + magnitude, contrast spread, and
    a saturation ratio, with a one-line reading.

    Grade by the numbers. Call this before and after a change and reason from the
    scope values. Never claim a result ('looks balanced', 'skin is natural', 'the
    cast is gone') without citing a scope value or a sampled region. Read the
    result adversarially — assume a cast, clip or crushed channel is still there
    and look for the one you have not ruled out. Defer genuinely creative calls
    to the human.
    """
    args: dict = {}
    if frame is not None:
        args["frame"] = frame
    if reference is not None:
        args["reference"] = reference
    return _inspect_result(_op("inspect_color", **args))


@mcp.tool()
def sample(x: int, y: int) -> list:
    """Read the RGB (and hex + luma) of one pixel of the current rendered frame.
    x, y are in the returned frame's pixel space (see `frameSize` from
    inspect_color). Use it to check a known-neutral wall actually reads neutral."""
    return _result(_op("sample", x=x, y=y))


@mcp.tool()
def sample_region(x: int, y: int, w: int, h: int) -> list:
    """Mean / min / max RGB over a rectangle of the current rendered frame
    (x, y, w, h in the frame's pixel space). Use it to measure skin on a cheek,
    a grey card, the darkest / brightest patch."""
    return _result(_op("sample_region", x=x, y=y, w=w, h=h))


# --------------------------------------------------------------------------- #
# match to reference — automated grade-by-the-numbers loop
# --------------------------------------------------------------------------- #
@mcp.tool()
def match_to_reference(
    reference: str,
    strength: float = 1.0,
    max_iters: int = 4,
    tolerance: float = 3.0,
) -> list:
    """Auto-grade the current shot toward a reference image.

    Measures the scope gap to `reference` (an ABSOLUTE image path) and
    iteratively applies a DAMPED primary correction — exposure, temperature,
    tint, contrast, saturation — re-measuring after each step until the combined
    gap is below `tolerance` or `max_iters` is reached. This automates the
    measure -> adjust -> re-measure discipline.

    - strength: overall scale on each correction (1.0 default; lower = gentler).
    - max_iters: cap on iterations (default 4; 1..12).
    - tolerance: combined-gap magnitude to stop at (default 3.0). The magnitude
      weights |EV| x8, warm-cool + green-magenta cast (channel-code units),
      |saturation| x20, and black/white-point deltas.

    Merges into the PRIMARY grade, not a new layer — a reference match is a
    balance. Creative look, curves, and mask work are separate and untouched.

    Returns {converged, iterations, gap_before, gap_after, applied (cumulative
    primary delta), trace: [{iter, damp, gapMag_before, gapMag_after, patch,
    cumulative}]} plus the final rendered frame + scope summary. Scope-first:
    inspect the result and confirm the cast / black point moved toward the
    reference; don't declare a match from the thumbnail. Defer the creative call.
    """
    return _result(
        _op(
            "match_reference",
            reference=reference,
            strength=strength,
            max_iters=max_iters,
            tolerance=tolerance,
        )
    )


# --------------------------------------------------------------------------- #
# request_human — hand back to the user
# --------------------------------------------------------------------------- #
@mcp.tool()
def request_human(reason: str, roi: Roi | None = None) -> str:
    """Hand back to the user — call this when you are genuinely unsure, when a
    call is creative rather than technical, or when you are done and want them to
    review.

    This is NOT a routine step. Use it for: "the skin tone is a judgement call I
    shouldn't make", "the matte edge on the hair needs manual cleanup here",
    "I've balanced the shot to the reference — does this look right to you?".
    Don't use it to narrate ordinary progress.

    reason: a short, specific sentence shown to the user in a banner.
    roi: optional {x, y, w, h} normalized to 0..1 (top-left origin) — a region
      drawn as a rectangle on the canvas so the user knows where to look
      (e.g. a face crop, a matte-edge artifact, the darkest patch).

    Non-blocking: this posts the request and returns immediately with
    {posted: true, reason, roi}. It does NOT wait for the user. To find out
    whether they have acted, call `get_state` and read `pendingHumanRequest`:
    it becomes null / `cleared: true` once they click "Resume agent". Keep going
    once it's cleared.

    Every change you made is already visible to the user in the GUI "Agent
    activity" feed, with a per-field diff and an undo button — you don't need to
    summarise your edits here, just say what you need from them."""
    import json

    args: dict = {"reason": reason}
    if roi is not None:
        args["roi"] = to_wire(roi)
    return json.dumps(_op("request_human", **args), indent=2, default=str)


# --------------------------------------------------------------------------- #
# export — a colour tool must output
# --------------------------------------------------------------------------- #
@mcp.tool()
def export(
    kind: str = "prores",
    path: str | None = None,
    from_frame: int | None = None,
    to_frame: int | None = None,
    quality: int | None = None,
) -> str:
    """Render the ACTIVE CLIP's grade to a file — the Colorist single-clip
    render, not the timeline. `editor_export` is the timeline exporter; use that
    one for a cut, and this one when you want one clip's grade rendered at full
    fidelity.

    **What this does that `editor_export` cannot (D-297):** it renders through
    the real wgpu grading pipeline, so the SPATIAL half of a grade — mask layers
    / local adjustments, relight, the Colorist crop — reaches the file.
    `editor_export` carries only the global grade, baked to a 3D LUT (D-256),
    and warns when it drops the rest.

    **`from_frame`/`to_frame` are CLIP-LOCAL (D-294)**, like `seek`: 0 is the
    clip's in-point on the Edit timeline and the range is bounded by
    `get_state().shot.frameCount`. The rendered picture carries the clip's own
    transform, so it matches what the Colorist preview shows. A clip with a
    SPEED RAMP is refused — this render does one linear decode pass; export it
    from the Edit tab, whose exporter honours ramps.

    kind:
      - "prores" (default) — ProRes 422 HQ .mov (prores_ks -profile:v 3, 10-bit 422)
      - "h264"             — .mp4 (libx264 -crf 18)
      - "cube"             — bake the PRIMARY grade (global only, no masks) to a
                             33³ .cube 3D LUT for use in another app

    path: output file. Omit to write next to the source clip as
      <name>.graded.mov / .mp4 / .cube.
    from_frame / to_frame: video only; default = the whole clip.
    quality: h264 → -crf (0-51, lower = better); prores → -profile:v (0-5).

    Video export runs in the background; this polls to completion and returns the
    resolved path, frame count, elapsed time, and any warning (e.g. masked layers
    dropped from a .cube). It is a local file the user asked for — no confirm.
    """
    import json
    import time

    if kind == "cube":
        env = _op("export", kind="cube", path=path)
        res = env.get("result") or {}
        return json.dumps(
            {"ok": env.get("ok"), "error": env.get("error"), **res}, indent=2, default=str
        )

    start = _op(
        "export",
        kind=kind,
        path=path,
        **{k: v for k, v in (("from", from_frame), ("to", to_frame), ("quality", quality)) if v is not None},
    )
    if not start.get("ok"):
        return json.dumps(start, indent=2, default=str)
    kicked = start.get("result") or {}

    last = {}
    while True:
        time.sleep(1.0)
        env = _op("export_progress")
        p = env.get("result") or {}
        last = p
        if not p.get("running"):
            break

    return json.dumps(
        {
            "ok": last.get("error") is None,
            "out_path": last.get("out_path") or kicked.get("out_path"),
            "frames": last.get("done"),
            "total": last.get("total"),
            "error": last.get("error"),
            "kickoff": kicked,
        },
        indent=2,
        default=str,
    )


# --------------------------------------------------------------------------- #
# debug — actually look at the app's screen (D-210)
# --------------------------------------------------------------------------- #
@mcp.tool()
def debug_screenshot(
    out_path: str | None = None,
    window: str | None = None,
    inline: bool = False,
) -> list:
    """Take a REAL screenshot of the running Apelles app's window and save it as
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

    Returns {path, label, width, height, scaleFactor, bytes}."""
    import json

    args: dict[str, Any] = {}
    if out_path:
        args["out_path"] = out_path
    if window:
        args["window"] = window
    env = _op("debug_screenshot", **args)

    res = env.get("result") or {}
    out: list = []
    if inline and env.get("ok") and res.get("path"):
        try:
            with builtins.open(res["path"], "rb") as fh:
                out.append(Image(data=fh.read(), format="png").to_image_content())
        except OSError as e:
            res = {**res, "inlineError": f"saved, but could not be read back: {e}"}

    out.append(
        TextContent(
            type="text",
            text=json.dumps(
                {"ok": env.get("ok"), "error": env.get("error"), **res},
                indent=2,
                default=str,
            ),
        )
    )
    return out


@mcp.tool()
def debug_sample_pixel(path: str, x: int, y: int) -> str:
    """Read the exact RGBA of ONE pixel out of a screenshot `debug_screenshot`
    saved. The numeric companion to looking at the image: use it to prove a
    colour claim ("that swatch really is the accent token", "the box edge lands
    on the picture edge, not 3px inside it") instead of eyeballing it.

    Coordinates are IMAGE pixels, not CSS pixels — multiply a DOM coordinate by
    the `scaleFactor` the screenshot returned (2 on a Retina display). Out of
    bounds is an error naming the real image size, so a coordinate-space
    mistake shows up immediately rather than as a wrong colour.

    Returns {x, y, r, g, b, a, hex, imageWidth, imageHeight}."""
    import json

    return json.dumps(
        _op("debug_sample_pixel", path=path, x=x, y=y), indent=2, default=str
    )


# --------------------------------------------------------------------------- #
# debug — drive and inspect the real UI (D-219)
#
# The other half of D-210's screenshot: these DRIVE real UI state and DUMP the
# real DOM, so "open the Inspector, screenshot it, check the element is really
# there and really that colour" is one loop an agent can run end to end.
#
# Every write below goes through the SAME zustand store action the human's own
# click calls — no synthesised clicks, no pixel coordinates, so the result is
# deterministic and it proves the app works rather than proving a simulation
# works.
#
# All of these are DEV-BUILD ONLY (CLAUDE.md: internal debug tooling is never
# shipped). They are answered by `@apelles/debug`'s op registry, which a
# production `vite build` drops entirely.
# --------------------------------------------------------------------------- #
@mcp.tool()
def debug_ui_state() -> str:
    """Read the running app's real UI state: which tab is showing, which panels
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
             openDialogs:[{tag,role,label,rect}]}."""
    import json

    return json.dumps(_op("debug_get_ui_state"), indent=2, default=str)


@mcp.tool()
def debug_set_active_tab(tab: str) -> str:
    """Switch the app to a top-level tab: "edit", "motion" or "colorist".

    Drives `useShellStore.setActiveTab` — literally the function the tab
    button's onClick calls — so this is a real tab switch, not a simulated
    click on a coordinate. A 1-based index ("1"/"2"/"3", matching the
    Cmd/Ctrl+1/2/3 shortcut) is accepted too. An unknown name is refused with
    the accepted list rather than silently ignored.

    Note the tabs only render while a project is open; with none open the app
    shows the project launcher and this changes which tab is *behind* it.

    Returns {ok, activeTab}."""
    import json

    return json.dumps(_op("debug_set_active_tab", tab=tab), indent=2, default=str)


@mcp.tool()
def debug_set_sources_panel(open: bool) -> str:
    """Show or hide the shell's docked left library column — the same state the
    panel's own toggle drives (on the Edit tab, that toggle is the library
    rail's own buttons).

    D-263: this column shows the shared media pool by default, but the Edit
    tab's rail can switch it to that tab's Titles / Effects / Subtitles
    libraries. `debug_ui_state`'s `editor.libraryMode` says which one is
    showing, so a screenshot of this column can be read correctly; this tool
    still only controls whether the column is open at all.

    Returns {ok, sourcesPanelOpen}."""
    import json

    return json.dumps(
        _op("debug_set_sources_panel", open=open), indent=2, default=str
    )


@mcp.tool()
def debug_set_library_mode(mode: str) -> str:
    """Switch which panel the Edit tab's left library column shows, and open
    the column so that panel is actually visible — the same state the library
    rail's own buttons drive.

    `mode` is one of "sources", "titles", "effects", "subtitles", "recut" or
    "index" (`debug_ui_state`'s `editor.libraryModes` lists them). The column
    is opened as well because the rail lives inside it: choosing a mode while
    the column is closed would change nothing on screen. Useful to reach the
    Recut panel and check a retake proposal there. An unknown mode is refused
    with the accepted list rather than silently ignored.

    Returns {ok, libraryMode, sourcesPanelOpen}."""
    import json

    return json.dumps(_op("debug_set_library_mode", mode=mode), indent=2, default=str)


@mcp.tool()
def debug_set_editor_inspector(open: bool) -> str:
    """Show or hide the Edit tab's Inspector column — the same state its own
    toggle button (top-right of the preview) drives.

    Useful as the first step of a verification loop: open the Inspector here,
    `debug_screenshot` to see it, `debug_dom_tree('[data-chroma-panel=
    "editor-inspector"]')` to check where it actually landed.

    Returns {ok, inspectorOpen}."""
    import json

    return json.dumps(
        _op("debug_set_editor_inspector", open=open), indent=2, default=str
    )


@mcp.tool()
def debug_set_inspector_tab(tab: str) -> str:
    """Switch the Edit tab's clip Inspector between its "video" and "audio"
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

    Returns {ok, inspectorTab}."""
    import json

    return json.dumps(_op("debug_set_inspector_tab", tab=tab), indent=2, default=str)


@mcp.tool()
def debug_dom_tree(
    selector: str | None = None,
    max_depth: int | None = None,
    max_nodes: int | None = None,
    styles: list[str] | None = None,
    include_hidden: bool = False,
    text: bool = True,
) -> str:
    """Dump the real DOM under `selector`: element hierarchy, ids/classes,
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
    so you can always tell "that's all there is" from "there was more"."""
    import json

    args: dict[str, Any] = {"includeHidden": include_hidden, "text": text}
    if selector:
        args["selector"] = selector
    if max_depth is not None:
        args["maxDepth"] = max_depth
    if max_nodes is not None:
        args["maxNodes"] = max_nodes
    if styles is not None:
        args["styles"] = styles
    return json.dumps(_op("debug_dom_tree", **args), indent=2, default=str)


@mcp.tool()
def debug_frame_timing(
    limit: int | None = None, reset: bool = False, window_ms: int | None = None
) -> str:
    """Read what the Edit tab's preview playback loop ACTUALLY did: the real
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
            what `debug_set_fps_overlay`'s on-screen readout is showing."""
    import json

    args: dict[str, Any] = {}
    if limit is not None:
        args["limit"] = limit
    if reset:
        args["reset"] = True
    if window_ms is not None:
        args["windowMs"] = window_ms
    return json.dumps(_op("debug_frame_timing", **args), indent=2, default=str)


@mcp.tool()
def debug_set_fps_overlay(
    enabled: bool,
    corner: str | None = None,
    update_ms: int | None = None,
) -> str:
    """Burn a live frame-rate readout into the app's own window, so a
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
            16..2000. The reply echoes what was actually applied."""
    import json

    args: dict[str, Any] = {"enabled": enabled}
    if corner is not None:
        args["corner"] = corner
    if update_ms is not None:
        args["updateMs"] = update_ms
    return json.dumps(_op("debug_set_fps_overlay", **args), indent=2, default=str)


@mcp.tool()
def debug_record_video(
    duration_secs: float,
    out_path: str | None = None,
    fps: int | None = None,
    width: int | None = None,
    window: str | None = None,
) -> str:
    """Record the running Apelles window to a real, playable video file. This
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
        window: which window by Tauri label. Default: the focused one."""
    import json

    args: dict[str, Any] = {"duration_secs": duration_secs}
    if out_path is not None:
        args["out_path"] = out_path
    if fps is not None:
        args["fps"] = fps
    if width is not None:
        args["width"] = width
    if window is not None:
        args["window"] = window
    # The recording genuinely takes `duration_secs`, and this op is answered
    # natively in Rust rather than forwarded, so the budget has to cover the
    # whole capture plus ffmpeg's final mux — otherwise a perfectly good
    # recording comes back to the caller as a client-side read timeout
    # (exactly the B-153 failure mode, in a tool whose runtime is knowable in
    # advance rather than merely long).
    timeout_ms = int(duration_secs * 1000) + 60_000
    return json.dumps(
        _op("debug_record_video", timeout_ms=timeout_ms, **args), indent=2, default=str
    )



# --------------------------------------------------------------------------- #
# Motion tab — the visual motion-graphics builder (D-257)
#
# Every tool below posts one `motion_*` op to the SAME control server the
# Colorist and Edit tools use (`chroma::control`, port 19788), which forwards
# it to `@apelles/motion`'s `useMotionControl.ts` -> `motionOps.ts`. Each
# mutating op calls the SAME `manifestEdit.ts` function the equivalent GUI
# gesture calls and commits through the SAME `useMotionManifest().commit`, so
# an agent's edit lands on the same `@apelles/history` undo stack a human's
# does and the tab visibly re-renders. See `docs/notes/mcp-architecture.md`.
#
# The manifest is this tab's single source of truth, exactly as `grade.json`
# is for Colorist and `Timeline` is for Edit.
#
# Addressing, shared by every layer-level tool — `scene_index` plus a `target`:
#     {"kind": "layer", "index": 0}          a 2D layer in scene.layers
#     {"kind": "layer", "id": "headline"}    the same, by stable id (preferred)
#     {"kind": "scene3d-child", "index": 1}  a 3D child in scene.scene3d.children
#     {"kind": "layer-item", "index": 1, "item_index": 2}  one CARD in a `layers`
#     {"kind": "scene"} | {"kind": "camera"} | {"kind": "scene3d-camera"}
# `id` wins over `index` when both are given and survives a reorder or an
# insert elsewhere in the array — read ids off `motion_list_layers` and prefer
# them. An index-only target is the honest fallback for a hand-written
# manifest whose layers carry no ids.
#
# Times are SECONDS, per scene — a keyframe's `at` is seconds from its own
# scene's start, never an absolute frame. `motion_get_state` reports each
# scene's `startFrame` if you need to convert.
# --------------------------------------------------------------------------- #


@mcp.tool()
def motion_get_manifest() -> str:
    """Read the Motion tab's LIVE scene manifest — the whole document, exactly
    as the preview is rendering it right now (parsed, not necessarily saved).

    The manifest is this tab's single source of truth, the way `grade.json` is
    for Colorist: `{title, width, height, fps, scenes: [{id, dur, camera?,
    layers?, scene3d?}]}`. Every other `motion_*` tool edits some part of it.

    Returns it alongside `loadState` ("ready" / "loading" / "no-project" /
    "error"), `parseError` (non-null when the raw-JSON editor currently holds
    something that does not parse — the preview keeps showing the last good
    value), `dirty` (unsaved changes) and `saveError`.

    For orientation prefer `motion_get_state` (scene summary + selection +
    playhead) and `motion_list_layers` (the addressing index) — this returns
    the entire document, which is a lot to read when you only need to know
    what is there."""
    import json

    return json.dumps(_op("motion_get_manifest"), indent=2, default=str)


@mcp.tool()
def motion_get_state() -> str:
    """Orientation for the Motion tab — call this FIRST. The Motion analogue of
    `editor_get_state`, and the read half of `motion_select`/
    `motion_set_selection`.

    Returns:
      * `loadState` / `dirty` / `parseError` / `saveError` — is this tab usable
        at all. A Motion manifest lives inside a project, so `"no-project"`
        means open one in the Colorist tab first. This tool ANSWERS in that
        case rather than erroring, which is how you find it out.
      * `selection` — what is selected right now, as `[{sceneIndex, target}]`,
        the exact shape `motion_set_selection` takes back.
      * `playheadFrame` / `playerMounted` — where the preview is parked.
      * `fps`, `totalFrames`, `width`, `height`, `title` — the document's own
        output spec, all four of them written by
        `motion_set_project_settings`.
      * `render` — where a `motion_render` is: `state` (`idle`/`running`/
        `error`), `scenesTotal` / `scenesDone` / `doneSceneIds` (real
        progress), `sceneId` (the one rendering right now), and
        `failedSceneId` + `error` when one failed. **This is how you find out
        a render failed.** A multi-scene render always outlives the 20s
        control-bridge timeout, so `motion_render`'s own reply is gone before
        a mid-loop failure happens; poll here instead of counting files on
        disk, which cannot tell "still rendering" from "stopped on a failure".
        A failed render stops at the failing scene, so `doneSceneIds` is
        exactly what is on disk and `failedSceneId` is what to fix.
      * `scenes` — one row per scene: `index`, `id`, `dur` (SECONDS), its
        absolute `startFrame` in the combined timeline, `layerCount`,
        `scene3dChildCount`, `camera2dKeys`, `camera3dKeys`.

    **Times in this tab are SECONDS, per scene, not absolute frames.** A
    keyframe's `at` is seconds from its own scene's start; `startFrame` here is
    what converts between the two (`frame = startFrame + at * fps`), and
    `motion_seek` accepts either form so you rarely have to do it yourself."""
    import json

    return json.dumps(_op("motion_get_state"), indent=2, default=str)


@mcp.tool()
def motion_list_layers(scene_index: int | None = None) -> str:
    """Every addressable layer in the manifest, flattened, with the exact
    `target` every mutating tool wants — the Motion analogue of
    `editor_get_timeline`'s clip list.

    Per row: `sceneIndex`, `target` (ready to paste), `use` (which primitive),
    `label` (the same one-line name the GUI's own layer list shows),
    `position` and `size` in world px (null when that primitive has none —
    e.g. a `graph` or a 3D child is not draggable), `transformKeyCount`,
    `activeKeyCount`, and `itemCount` for a `layers` primitive.

    Use it to turn "the headline text in the second scene" into a real
    address, and to see which layers carry an `id` — prefer id-addressing, it
    survives a reorder; a bare index does not.

    Args:
        scene_index: only list this scene. Omit for every scene."""
    import json

    args: dict[str, Any] = {}
    if scene_index is not None:
        args["scene_index"] = scene_index
    return json.dumps(_op("motion_list_layers", **args), indent=2, default=str)


@mcp.tool()
def motion_list_primitives() -> str:
    """Static reference: every primitive the motion engine can render, and the
    fields each one accepts. The Motion counterpart of
    `editor_get_capabilities` — call it once before your first
    `motion_add_layer` / `motion_set_layer_field`.

    Per primitive: the `use` string `motion_add_layer` requires, a one-line
    description of what it is for, `in3d` (whether it is a three.js object
    that must live in `scene.scene3d.children` rather than `scene.layers` —
    `motion_add_layer` places it correctly for you either way, and
    `container` states which target kind addresses it), the editable `fields`
    (key, label, kind) `motion_set_layer_field` accepts, and whether it has a
    draggable `position` / resizable `size` at all.

    Also returns `themes` (the registered looks, for
    `motion_set_project_theme`) and the `defaultTheme` a manifest with no
    `theme` key renders in, `projectFields` (the manifest's own top-level
    fields, for `motion_set_project_settings`), `sceneFields` (for
    `motion_set_scene_field`),
    `layerTransformFields` (for `motion_set_layer_transform_field`),
    `layerTransformKeyFields`, and the 2D/3D camera key fields.

    Several `fields` are `kind: "json"` — the primitive's own CONTENT, an array
    of objects rather than a scalar knob. Their labels spell out the item shape,
    because that shape is not otherwise discoverable: `graph`'s `edges`, for
    one, take `{from, to, directed?, weight?}`, where `weight` (0-1, default 1)
    scales how bright and how thick that edge draws — which is what lets a full
    mesh show WHICH connections matter rather than drawing every one the same.

    Without this, a legal `use` value or a field key is only discoverable by
    reading the app's source. `motion_set_layer_field` will still WRITE an
    unknown key (a hand-authored manifest may legitimately carry one) but
    warns — so check here first if something you set has no visible effect."""
    import json

    return json.dumps(_op("motion_list_primitives"), indent=2, default=str)


@mcp.tool()
def motion_set_project_theme(theme: str | None = None) -> str:
    """Set the DOCUMENT's theme — which registered look the whole manifest renders
    in (`manifest.theme`). A project-level setting: not per scene, not per
    layer. The document's other project-level fields (`title`/`width`/
    `height`/`fps`) are `motion_set_project_settings`; this one is separate
    because it is an enum that CLEARS to a default rather than a value.

    `motion_list_primitives` lists the registered `themes` and names the
    `defaultTheme`. Today there are two:

      - `dark-excalidraw` (the default) — flat dark slate, off-white
        hand-drawn roughjs strokes, Kalam lettering, one red and one blue
        accent, everything drifting very slightly.
      - `apelles-studio` — apelles.studio's own editorial look: warm-black
        basalt ground, marble ink, ONE ochre working colour, Newsreader /
        Instrument Sans / IBM Plex Mono, exact (non-sketch) geometry and no
        ambient drift.

    A theme supplies DEFAULTS only. A scene's own `bg`, and a layer's own
    `color` / `font` / `accent`, still win over it — so re-theming never
    silently discards a colour that was set deliberately, and a layer pinned
    to a literal colour will NOT follow the new palette.

    Pass null to clear the field back to the default look. That DELETES the
    key rather than writing the default's name into it, which is the shape
    every manifest authored before themes existed already has.

    An unregistered name is rejected outright, unlike `motion_set_scene_field`
    (which warns and writes anyway): the manifest schema declares this field
    as an enum, so a name outside the registry would not parse at all.

    Undoable in the app (Cmd/Ctrl+Z), like any other Motion edit.

    Args:
        theme: the theme name, or null to clear it back to the default."""
    import json

    return json.dumps(_op("motion_set_project_theme", theme=theme), indent=2, default=str)


@mcp.tool()
def motion_set_project_settings(
    title: str | None = None,
    width: int | None = None,
    height: int | None = None,
    fps: float | None = None,
    reflow: bool = True,
) -> str:
    """Set the manifest's OWN top-level fields — the document's name and its
    output spec. The Motion twin of `set_project_settings` (Colorist), and
    until this existed these four were reachable only by hand-editing the
    raw-JSON manifest (B-222).

    `width`/`height` are the pixel size EVERY scene renders at; `fps` is the
    timebase every `at`/`dur` in SECONDS is converted against; `title` is the
    document's own label. Read them back from `motion_get_state`.

    Partial merge — only the arguments you pass are changed — and ONE commit
    (one Cmd/Ctrl+Z) for all of them, which is why `width` and `height` are
    arguments of the same tool rather than two calls: a resize sent in two
    steps passes through a wrong aspect ratio on the way.

    **Validation is a refusal, not a clamp.** Remotion validates these itself
    and throws: `width`/`height` must be positive INTEGERS, `fps` a positive
    number (fractional is fine — 23.976/29.97 are real). A bad value does not
    render badly, it takes down the live preview, so it is rejected here and
    the manifest is left alone. An ODD width/height is legal and returns a
    `warning`: the h264 render silently rounds it DOWN to even.

    **Changing `width`/`height`/`fps` makes every EXISTING scene render stale**
    — those files were produced at the old spec, and any Edit-tab clip reading
    one is now the wrong size (or the wrong length). The reply says so in
    `renders`: `stale`, how many `scenes` have a render and how many `clips`
    read them, and `sceneIds`. It does NOT re-render — a render is explicit,
    `motion_render`, never a side effect. `linkDataAvailable: false` means no
    link data reached the tab at all, which is not the same answer as
    "nothing has been rendered yet" (see `motion_get_edit_links`).

    **`reflow` (D-346, DEFAULT TRUE) moves the LAYERS with the canvas**, and
    is the thing to understand before resizing anything. A layer's `x`/`y`/
    `size` are RAW WORLD PIXELS — there is no design-space normalisation
    anywhere between the manifest and the rendered DOM — so changing
    `width`/`height` on its own leaves every layer at its old coordinates in a
    differently-shaped frame: the composition sits in one corner with dead
    space around it, at the wrong relative size. Doubling a 1920x1080 manifest
    to 4K that way does NOT give you a 4K graphic, it gives you a broken one
    (which is why `Config.setScale(2)` renders at 4K instead, D-342).

    With `reflow` on, the whole layout is remapped onto the new canvas in the
    same commit: x-positions and widths by `newW/oldW`, y-positions and
    heights by `newH/oldH`, and anything that cannot stretch per axis without
    distorting (a font `size`, a `nodeR`, a `matrix` `cell`/`gap`, a
    `deviceframe` `scale`) by `min` of the two. A `graph`'s own node
    coordinates, an `emphasis` box's `[x,y,w,h]`, a plot annotation's `dy` and
    every `transform` key's pixel offset move with it. The reply reports
    `scaleX`/`scaleY`/`scaleUniform` and how many `layersMoved`.

    It is a proportional remap, NOT a layout engine: it does not know that
    text wraps. A reflow that changes the ASPECT RATIO puts everything in the
    right place at the right relative size and can still leave a caption that
    was one line sitting on three — expect to fix the overflows afterwards,
    not to re-place every layer. Timing (`at`/`dur`/`stagger`), content (a
    `plot`'s `values`/`baseline`, an edge's `weight`, `rows`/`cols`, any
    `seed`) and `scene3d` children (3D world units, not canvas pixels) are
    deliberately untouched; skipped 3D scenes are named in `warning`.

    Pass `reflow=False` for the raw behaviour — write the dimensions, move
    nothing — e.g. when the layers were already authored for the new canvas.

    `theme` is NOT set here — it is an enum with its own clear-to-default
    semantics: `motion_set_project_theme`.

    Args:
        title: the document's name. Trimmed; an empty one is refused.
        width: output width in px — a positive integer.
        height: output height in px — a positive integer.
        fps: frames per second — positive, fractional allowed.
        reflow: remap every layer onto the new canvas (default True). Ignored,
            with a `warning`, when neither width nor height changes."""
    import json

    args: dict[str, Any] = {}
    if title is not None:
        args["title"] = title
    if width is not None:
        args["width"] = width
    if height is not None:
        args["height"] = height
    if fps is not None:
        args["fps"] = fps
    if not args:
        return json.dumps({"error": "pass at least one of title, width, height, fps"})
    args["reflow"] = reflow
    return json.dumps(_op("motion_set_project_settings", **args), indent=2, default=str)


@mcp.tool()
def motion_add_scene(after_scene_index: int | None = None, id: str | None = None) -> str:
    """Add a new empty 4-second scene — the same action the layer panel's own
    "+ Scene" button performs.

    Scenes play back to back in array order, and each renders to its OWN
    separate video file (see `motion_render`), so a scene is the unit of "one
    shot" here, not a track. The new scene is inserted directly AFTER
    `after_scene_index` (matching the GUI, which inserts after whatever is
    selected) or appended at the end when omitted. Every later scene's index
    shifts by one — re-read `motion_get_state` afterwards.

    **Name it here.** A scene's `id` is its DISPLAY NAME — the layer panel's
    section header, the scene selector, and the filename `motion_render` writes
    (`motion/renders/<id>.mp4`). Pass `id` and the scene is created under that
    name; omit it and you get a generated `scene-xxxxxx` you would then have to
    rename, which is harder once the scene has been rendered and placed (see
    `motion_set_scene_field`). An id must be non-empty, free of "/", "\\" and
    control characters (it becomes a filename), and not already taken by
    another scene — any of those is refused with a reason, and nothing is
    created.

    Returns the new scene's `sceneIndex`/`sceneId` and a `selection` addressing
    it. Set its length with
    `motion_set_scene_field(key="dur", value=<seconds>)`.

    Args:
        after_scene_index: insert after this scene. Omit to append.
        id: the new scene's name. Omit for a generated one."""
    import json

    args: dict[str, Any] = {}
    if after_scene_index is not None:
        args["after_scene_index"] = after_scene_index
    if id is not None:
        args["id"] = id
    return json.dumps(_op("motion_add_scene", **args), indent=2, default=str)


@mcp.tool()
def motion_delete_scene(scene_index: int) -> str:
    """Delete a whole scene — every layer in it, its camera and its 3D block go
    with it. The same action the layer panel's own per-scene delete button
    performs (which asks for a confirming second click; this tool does not).

    **Refused for the last remaining scene**: a manifest must have at least one
    (the schema enforces it), so there is no "empty composition" state to reach
    this way. Delete the layers instead, or add another scene first.

    Every LATER scene's index shifts down by one, so any `scene_index` you were
    holding is stale afterwards — re-read `motion_get_state`. The live GUI
    selection is moved to the scene that took the deleted one's place, since the
    old one no longer exists.

    Undoable in the app (Cmd/Ctrl+Z), like any other Motion edit.

    Args:
        scene_index: which scene to delete."""
    import json

    return json.dumps(_op("motion_delete_scene", scene_index=scene_index), indent=2, default=str)


@mcp.tool()
def motion_duplicate_scene(scene_index: int) -> str:
    """Copy a whole scene — layers, camera, 3D block — in directly after itself.
    The layer panel's own per-scene duplicate button.

    This is the tool for "the same shot again, with one thing changed": each
    scene renders to its OWN video file (`motion_render`), so duplicating one is
    how you get a variant without rebuilding it layer by layer.

    The copy gets a NEW scene id and a new `id` on every layer inside it, so
    nothing you address by `id` afterwards is ambiguous. Every later scene's
    index shifts up by one — re-read `motion_get_state`.

    Returns the copy's `sceneIndex`/`sceneId` and a `selection` addressing it.

    Args:
        scene_index: the scene to copy."""
    import json

    return json.dumps(_op("motion_duplicate_scene", scene_index=scene_index), indent=2, default=str)


@mcp.tool()
def motion_set_scene_field(scene_index: int, key: str, value: Any = None, force: bool = False) -> str:
    """Set one field on a SCENE itself (not on a layer) — most often `dur`, the
    scene's length in SECONDS, which decides how long its shot runs and is the
    clamp every keyframe time in it is bound to.

    `motion_list_primitives`' `sceneFields` lists the known keys; an
    unrecognised one is still written (a hand-authored manifest may carry
    fields the Inspector does not know) but comes back with a `warning`.

    **`key="id"` is a RENAME and is checked, not just written.** A scene's id
    is its display name AND the name of the file it renders to
    (`motion/renders/<id>.mp4`) AND the key the Motion→Edit link is made of —
    the `motionSceneId` stamp put on the media-pool item at render time. A
    rename does NOT follow that stamp, so renaming a scene whose render is
    already in Sources (or placed on the Edit timeline) would leave those clips
    reading the old file while a re-render writes a new one under the new name,
    refreshing nothing. That case is refused with a reason naming the clips it
    would orphan; pass `force=true` to do it anyway and accept the broken link.
    An id that is empty, has leading/trailing whitespace, contains "/", "\\" or
    a control character, or collides with another scene is refused outright —
    `force` does not lift those. To rename a scene cleanly: rename it, then
    re-render it and re-place (or re-link) its clips.

    Args:
        scene_index: which scene.
        key: the field, e.g. "dur" or "id".
        value: the new value. Pass null to DELETE the field.
        force: for key="id" only — rename even though it orphans a render."""
    import json

    return json.dumps(
        _op("motion_set_scene_field", scene_index=scene_index, key=key, value=value, force=force),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_camera_2d(scene_index: int, keys: list[Camera2DKey]) -> str:
    """Replace a scene's 2D camera animation — the push-ins and pans over the
    flat layers, `[{at, x?, y?, zoom?, ease?}]`.

    `at` is SECONDS from this scene's start. `x`/`y` are the world point the
    camera centres on and `zoom` is a multiplier (`1` = fit). One key alone is
    a static framing; two or more animate between them.

    **This REPLACES the whole array** — it is the only way to change a camera
    key's VALUES, because the app has no granular per-key camera write. To
    tweak one key: read the array from `motion_get_manifest`, edit it, send it
    all back. (`motion_move_camera_keyframe` retimes ONE key without a
    resend, but cannot change its values.)

    `ease` is a 4-number cubic bezier `[x1, y1, x2, y2]`. `x1`/`x2` outside
    `0..1` are clamped with a warning (the runtime throws on them); `y`
    outside `0..1` is legal and means real overshoot -- but not unbounded
    (B-166): `y1`/`y2` are silently clamped to `-0.75..1.75`, with a warning
    if that changed anything. A malformed ease is a hard error, never
    silently dropped.

    Args:
        scene_index: which scene.
        keys: the complete new key list, in any order (sorted by `at`)."""
    import json

    return json.dumps(
        _op("motion_set_camera_2d", scene_index=scene_index, keys=to_wire(keys)),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_camera_3d(scene_index: int, keys: list[Camera3DKey]) -> str:
    """Replace a scene's 3D camera animation — `[{at, pos: [x,y,z], look?:
    [x,y,z], ease?}]`, needing at least one key.

    Only meaningful for a scene that HAS a `scene3d` block. A scene without
    one is refused by name, and the only way to create one today is to add a
    3D primitive (`motion_add_layer` with a `use` whose `in3d` is true — see
    `motion_list_primitives`), which brings a default camera with it.

    Same wholesale-replace rule and same `ease` validation as
    `motion_set_camera_2d`; see that tool for both.

    Args:
        scene_index: which scene.
        keys: the complete new key list (non-empty)."""
    import json

    return json.dumps(
        _op("motion_set_camera_3d", scene_index=scene_index, keys=to_wire(keys)),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_add_layer(scene_index: int, use: str) -> str:
    """Create a layer — the same action the Catalog panel's own primitive rows
    perform. This is how anything gets onto a Motion scene.

    `use` names the primitive (`motion_list_primitives` lists them all with
    what each is for). A schema-valid DEFAULT instance is inserted, so the
    result renders immediately; shape it afterwards with
    `motion_set_layer_field` (its own content/preset fields),
    `motion_set_layer_position` / `_size` (where and how big) and
    `motion_set_layer_transform_field` (scale/rotation/opacity).

    Placement is automatic and not yours to choose: a 2D primitive goes into
    `scene.layers`, a 3D one into `scene.scene3d.children` (creating that
    block, with a default camera, if the scene had none). Layers paint in
    array order — a later layer draws ON TOP — so use `motion_reorder_layers`
    to change what covers what.

    Returns the `selection` addressing the new layer; hand it straight to the
    next call.

    Args:
        scene_index: which scene to add to.
        use: the primitive, e.g. "text". An unknown value is refused with the
            full legal list."""
    import json

    return json.dumps(
        _op("motion_add_layer", scene_index=scene_index, use=use), indent=2, default=str
    )


@mcp.tool()
def motion_delete_layer(scene_index: int, target: MotionTarget) -> str:
    """Remove one layer (or one 3D scene child) — the delete button on that row
    in the layer list.

    **Address it by `id` when you can.** Deleting a layer shifts every index
    after it, so a plan that deletes several layers by bare `index` deletes the
    wrong ones after the first. `motion_list_layers` gives you each layer's
    `target` including its `id`, and an `id` keeps naming the same layer no
    matter what moves. (A hand-authored manifest's layers may have no `id` at
    all — then delete from the HIGHEST index downwards.)

    The GUI selection moves to the layer that slid into the deleted slot, or to
    the parent scene when that was the last one. Emptying `scene.layers`
    removes the key rather than leaving an empty array; an emptied
    `scene3d.children` stays, because the 3D camera lives in that same block.

    Undoable in the app (Cmd/Ctrl+Z). Returns what was removed and how many
    layers remain.

    Args:
        scene_index: which scene the layer is in.
        target: {kind, index?, id?} — kind is "layer" or "scene3d-child"."""
    import json

    return json.dumps(
        _op("motion_delete_layer", scene_index=scene_index, target=to_wire(target)),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_duplicate_layer(scene_index: int, target: MotionTarget) -> str:
    """Copy one layer (or 3D scene child) in directly ABOVE itself in paint
    order — the duplicate button on that row in the layer list.

    Every field is deep-copied — position, size, transform, keyframes, a
    `layers` primitive's cards — except the `id`, which is regenerated. The
    copy lands at `index + 1`, so it draws on top of the original; everything
    above it shifts up one.

    Returns the `selection` addressing the copy — hand it straight to
    `motion_set_layer_position` / `motion_set_layer_field` to make it differ
    from what it was copied from. This is usually two calls instead of the five
    or six that rebuilding a similar layer from `motion_add_layer` would take.

    Args:
        scene_index: which scene the layer is in.
        target: {kind, index?, id?} — kind is "layer" or "scene3d-child"."""
    import json

    return json.dumps(
        _op("motion_duplicate_layer", scene_index=scene_index, target=to_wire(target)),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_reorder_layers(
    scene_index: int,
    from_index: int,
    to_index: int,
    kind: str = "layer",
) -> str:
    """Move a layer within its scene's array — the drag-to-reorder gesture in
    the layer list.

    **Array order IS paint order**: a later index draws on top of an earlier
    one. This is the tool for "put the title above the background" and it is
    the only one that changes occlusion.

    Both indices must already exist, `from_index` must differ from `to_index`,
    and `to_index` is the moved layer's FINAL resting index (0..count-1), not
    an "insert before" slot. Reordering across scenes is not supported — a
    layer belongs to its scene.

    Any layer addressed by bare `index` elsewhere in your plan moves with
    this; re-read `motion_list_layers`, or address by `id`, which follows the
    layer automatically.

    Args:
        scene_index: which scene.
        from_index: the layer's current index.
        to_index: where it should end up.
        kind: "layer" (2D, default) or "scene3d-child" (3D children)."""
    import json

    return json.dumps(
        _op(
            "motion_reorder_layers",
            scene_index=scene_index,
            from_index=from_index,
            to_index=to_index,
            kind=kind,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_layer_field(
    scene_index: int, target: MotionTarget, key: str, value: Any = None
) -> str:
    """Set one of a layer's OWN fields — its content and look: a text layer's
    `text`/`size`/`align`, a preset name, a colour, a `layers` primitive's
    `items`, and so on. The workhorse for shaping a layer after
    `motion_add_layer` creates it.

    Call `motion_list_primitives` for the legal keys per `use`. An unknown key
    is still WRITTEN (a hand-authored manifest may carry fields the Inspector
    does not know about) but returns a `warning` — check it if your change had
    no visible effect.

    This is NOT the tool for geometry: position/size have their own
    (`motion_set_layer_position` / `_size`), and scale/rotation/opacity live
    on the transform wrapper (`motion_set_layer_transform_field`).

    Args:
        scene_index: which scene.
        target: which layer — `{"kind": "layer", "index": N}` or
            `{"kind": "layer", "id": "..."}` (id preferred; see this section's
            header). Must resolve to a layer or scene3d-child.
        key: the field name.
        value: the new value. Pass null to DELETE the field."""
    import json

    return json.dumps(
        _op(
            "motion_set_layer_field",
            scene_index=scene_index,
            target=to_wire(target),
            key=key,
            value=value,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_field_on_layers(
    selections: list[MotionSelection],
    key: str,
    value: Any = None,
    transform: bool = False,
) -> str:
    """Set the SAME field across several layers at once — the Inspector's own
    multi-select lockstep edit.

    **Not the same as calling `motion_set_layer_field` N times**: this is ONE
    undo entry, exactly as a human's multi-select edit is, instead of N the
    user would have to press Cmd+Z through one at a time.

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`. They may span
            different scenes. Entries that no longer resolve are dropped and
            reported as `droppedCount` rather than failing the call.
        key: the field name.
        value: the new value; null DELETES the field.
        transform: False (default) writes the layer's own top-level field, as
            `motion_set_layer_field` does. True writes the nested
            `transform.<key>` instead — the generic scale/rot/opacity group
            every primitive shares, which is what you want when the selected
            layers are of different `use` types and share no other fields."""
    import json

    return json.dumps(
        _op(
            "motion_set_field_on_layers",
            selections=to_wire(selections),
            key=key,
            value=value,
            transform=transform,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_layer_item(
    scene_index: int,
    target: MotionTarget,
    key: str | None = None,
    value: Any = None,
    dx: float | None = None,
    dy: float | None = None,
    reset: bool = False,
) -> str:
    """Edit ONE CARD inside a `layers`-primitive layer (the stacked-cards
    primitive) — its label, or where it sits relative to its computed spot.

    `target` must be `{"kind": "layer-item", "index": L, "item_index": C}`
    where `index` is the parent layer's own index and `item_index` the card's
    position in its `items` array. Cards carry no id, so this is index-only;
    re-read `motion_list_layers` (`itemCount`) if the list may have changed.

    Pass EXACTLY ONE of:
      * `dx` + `dy` — the card's pixel offset from where the layout would
        otherwise put it (the per-card drag gesture).
      * `key` (+ `value`) — any other field on the card, e.g. "label" or
        "sublabel". A card stored as a plain string is promoted to an object
        automatically, preserving its text as `label`.
      * `reset=True` — drop both offsets in ONE undo step, back to the
        computed default position.

    Args:
        scene_index: which scene.
        target: the card (see above).
        key: the field to set, when editing a field.
        value: its new value; null deletes the field.
        dx: horizontal pixel offset (requires dy).
        dy: vertical pixel offset (requires dx).
        reset: True to clear both offsets."""
    import json

    args: dict[str, Any] = {"scene_index": scene_index, "target": to_wire(target)}
    if reset:
        args["reset"] = True
    if dx is not None:
        args["dx"] = dx
    if dy is not None:
        args["dy"] = dy
    if key is not None:
        args["key"] = key
        args["value"] = value
    return json.dumps(_op("motion_set_layer_item", **args), indent=2, default=str)


@mcp.tool()
def motion_select(scene_index: int, target: MotionTarget) -> str:
    """Select exactly ONE thing and move the preview to it — the layer-list row
    click, precisely: it replaces the selection and seeks the player so what
    you selected is actually on screen.

    The seek is conditional, matching the GUI exactly: it jumps to the layer's
    own visible start only when the playhead is not ALREADY inside that
    layer's window, so "scrub to a moment, then select what is there" does not
    throw your position away. For a scene/camera target the same rule applies
    at the scene boundary. `seekedTo` reports the frame it moved to, or null
    if it deliberately stayed put.

    Use `motion_set_selection` for multi-select or to select WITHOUT seeking.

    **Not undoable** — selection is UI state, not document content, exactly as
    with `editor_set_selection`. A human's click pushes nothing onto the undo
    stack either.

    Args:
        scene_index: which scene.
        target: what to select — a layer, scene3d-child, layer-item, or one of
            `{"kind": "scene"}` / `{"kind": "camera"}` /
            `{"kind": "scene3d-camera"}`."""
    import json

    return json.dumps(
        _op("motion_select", scene_index=scene_index, target=to_wire(target)), indent=2, default=str
    )


@mcp.tool()
def motion_set_selection(selections: list[MotionSelection]) -> str:
    """Set the WHOLE selection — the marquee / shift-click half of the canvas
    selection model, and the write half of `motion_get_state`'s `selection`.
    Unlike `motion_select` it takes any number of targets and never seeks.

    **Why this matters even though every editing tool takes an explicit
    target** (the same reasoning as `editor_set_selection`): the Motion tab has
    real surfaces that render ONLY for a selection — the Inspector's property
    form, the on-canvas transform box and its resize handles, the
    align/distribute controls, the keyframe timeline's per-row lanes. Until
    this existed nothing but a mouse could put the app into the state those
    surfaces need, so none of them could be driven or screenshot-verified.
    Pair it with `debug_screenshot` to actually see what you selected.

    It is also how you leave the app where a human expects to find it: select
    the layer you just created so the user sees it highlighted.

    Every entry is validated against the live manifest — an unresolvable
    target is a real error and the selection is left untouched, never
    partially applied. `selections=[]` clears.

    **Not undoable**, for the same reason as `motion_select`.

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`; `[]` clears."""
    import json

    return json.dumps(
        _op("motion_set_selection", selections=to_wire(selections)), indent=2, default=str
    )


@mcp.tool()
def motion_set_layer_position(scene_index: int, target: MotionTarget, x: float, y: float) -> str:
    """Move a layer to an absolute WORLD-pixel position — the canvas drag.

    World pixels are the manifest's own coordinate space (`width`/`height`
    from `motion_get_state`, typically 1920x1080), NOT screen pixels and not
    fractions — so `x=960, y=540` is the centre of a 1080p composition.

    Writes the primitive's OWN position field, so it is refused (naming the
    `use`) for a primitive that has none — a `graph` or a 3D child. Check
    `motion_list_layers`' `position`: null there means not positionable this
    way.

    **A keyframe beats this.** If the layer has `transform.keys` carrying
    `x`/`y`, the animation wins at render time and this static write will not
    be visible — animate with `motion_set_layer_transform_keys` /
    `motion_add_layer_keyframe` instead, or clear the keys first.

    Args:
        scene_index: which scene.
        target: which layer.
        x: world-pixel x.
        y: world-pixel y."""
    import json

    return json.dumps(
        _op("motion_set_layer_position", scene_index=scene_index, target=to_wire(target), x=x, y=y),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_layer_size(scene_index: int, target: MotionTarget, w: float, h: float) -> str:
    """Resize a layer in WORLD pixels — the canvas resize handles.

    Same world-pixel space as `motion_set_layer_position`. Which field this
    actually writes depends on the primitive (a box, a width, a font size); a
    primitive with no resizable field refuses, naming its `use`. Check
    `motion_list_layers`' `size` — null means not resizable this way, and a
    null `h` there means only the width is settable (text, whose height
    follows its own size).

    Args:
        scene_index: which scene.
        target: which layer.
        w: world-pixel width.
        h: world-pixel height."""
    import json

    return json.dumps(
        _op("motion_set_layer_size", scene_index=scene_index, target=to_wire(target), w=w, h=h),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_layer_transform_field(
    scene_index: int, target: MotionTarget, key: str, value: Any = None
) -> str:
    """Set one field of a layer's generic TRANSFORM wrapper — this is the tool
    for **scale, rotation and opacity**.

    It is genuinely different from `motion_set_layer_position` / `_size`:
    those write the primitive's own native geometry (a text layer's own x/y,
    an emphasis layer's own box), whereas this writes the post-transform every
    primitive shares regardless of type. `motion_list_primitives`'
    `layerTransformFields` lists the real keys.

    **A keyframe silently beats a static transform value.** The response says
    so explicitly when the layer already has `transform.keys` — that is the
    single easiest way to set something here and see nothing change. Animate
    via `motion_set_layer_transform_keys` instead in that case.

    Setting the LAST remaining transform field to null removes the whole
    `transform` object rather than leaving an empty one behind.

    Args:
        scene_index: which scene.
        target: which layer.
        key: "scale", "rot", "opacity", ... (see layerTransformFields).
        value: the new value; null DELETES the field."""
    import json

    return json.dumps(
        _op(
            "motion_set_layer_transform_field",
            scene_index=scene_index,
            target=to_wire(target),
            key=key,
            value=value,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_move_layers_by_delta(
    selections: list[MotionSelection],
    dx: float,
    dy: float,
    auto_key: bool = False,
    at: float | None = None,
) -> str:
    """Nudge one or more layers by a shared (dx, dy) in world pixels, relative
    to where they are NOW — the multi-select canvas drag.

    Each layer's base is read fresh off the current manifest, so this composes
    predictably; layers with no draggable position are skipped and reported as
    `droppedCount` rather than failing the call.

    **`auto_key` is the important half.** With `auto_key=False` (default) this
    writes each layer's STATIC position — which is invisible on a layer that
    is already animated, since keyframes win. With `auto_key=True` (plus `at`,
    the time in seconds within the layer's scene) it does exactly what the
    real canvas drag does: a layer that is already keyframed gets a keyframe
    UPSERTED at that moment instead, so the move becomes part of the
    animation; a layer that is not keyframed still gets its static position
    moved. A mixed selection routes per layer, and `keyedCount` reports how
    many took the keyframe path.

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`.
        dx: horizontal world-pixel delta.
        dy: vertical world-pixel delta.
        auto_key: True to keyframe already-animated layers (requires `at`).
        at: seconds within the scene, required when auto_key is True."""
    import json

    args: dict[str, Any] = {"selections": to_wire(selections), "dx": dx, "dy": dy}
    if auto_key:
        args["auto_key"] = True
    if at is not None:
        args["at"] = at
    return json.dumps(_op("motion_move_layers_by_delta", **args), indent=2, default=str)


@mcp.tool()
def motion_align_layers(selections: list[MotionSelection], edge: str) -> str:
    """Align 2+ layers to a shared edge or centre line — the align buttons.

    `edge` is one of `left`, `centerH`, `right` (horizontal) or `top`,
    `centerV`, `bottom` (vertical). Layers align to the bounding box of the
    whole selection, exactly as in any design tool.

    Needs at least 2 selections that actually resolve to a draggable position;
    unresolvable or non-positionable ones are dropped (`droppedCount`) and the
    call is refused if fewer than 2 remain.

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`.
        edge: left | centerH | right | top | centerV | bottom."""
    import json

    return json.dumps(
        _op("motion_align_layers", selections=to_wire(selections), edge=edge), indent=2, default=str
    )


@mcp.tool()
def motion_distribute_layers(selections: list[MotionSelection], axis: str) -> str:
    """Space 3+ layers with equal gaps along one axis — the distribute buttons.

    The outermost two stay put and everything between them is redistributed
    evenly. Needs at least 3 resolvable, positionable selections (fewer is
    refused — with 2 there is nothing to distribute).

    Args:
        selections: `[{"scene_index": N, "target": {...}}, ...]`.
        axis: "horizontal" or "vertical"."""
    import json

    return json.dumps(
        _op("motion_distribute_layers", selections=to_wire(selections), axis=axis),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_layer_transform_keys(
    scene_index: int, target: MotionTarget, keys: list[LayerTransformKey]
) -> str:
    """Replace a layer's whole animation — `[{at, x?, y?, scale?, rot?,
    opacity?, ease?}]`. This is the main way to animate anything in Motion.

    `at` is SECONDS from the layer's own SCENE start (not absolute frames, and
    not from the layer's own `at`). Values interpolate between consecutive
    keys; a property absent from a key is simply not animated by it. One key
    alone is a static hold.

    **Keyframes override static values** for the properties they carry — a
    keyed `scale` beats anything `motion_set_layer_transform_field` wrote, and
    keyed `x`/`y` beat `motion_set_layer_position`. That precedence is the
    usual reason a static write appears to do nothing.

    `ease` per key is a cubic bezier `[x1, y1, x2, y2]` shaping the segment
    that STARTS at that key. `x1`/`x2` outside `0..1` are clamped with a
    warning; `y` outside `0..1` is legal and means overshoot (anticipation, a
    bounce) -- but not unbounded (B-166): `y1`/`y2` are silently clamped to
    `-0.75..1.75`, with a warning if that changed anything. A malformed ease
    is a hard error. Unknown fields in a key are dropped rather than stored.

    Passing `keys=[]` REMOVES the animation entirely, back to the layer's
    static values.

    Args:
        scene_index: which scene.
        target: which layer.
        keys: the complete new key list."""
    import json

    return json.dumps(
        _op(
            "motion_set_layer_transform_keys",
            scene_index=scene_index,
            target=to_wire(target),
            keys=to_wire(keys),
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_add_layer_keyframe(
    scene_index: int,
    target: MotionTarget,
    at: float,
    x: float | None = None,
    y: float | None = None,
    ease: EaseCurve | None = None,
) -> str:
    """Add (or overwrite) ONE position keyframe at a moment — the auto-keyframe
    a canvas drag performs, without replacing the rest of the animation the
    way `motion_set_layer_transform_keys` does.

    With `x`/`y` omitted it keys the layer WHERE IT ALREADY IS at `at` —
    interpolating its current animation if it has one. That is how you author
    a hold: key the current position at two times, then move only the later
    one. With `x`/`y` given they are used verbatim.

    An existing key at the same frame is overwritten IN PLACE, preserving its
    other properties (`scale`/`rot`/`opacity`) and only changing `x`/`y`.

    `ease` is applied to the same key in the SAME undo step (a bezier
    `[x1,y1,x2,y2]`; same clamping rules as
    `motion_set_layer_transform_keys`).

    Refused for a primitive with no draggable position unless you pass
    explicit `x` and `y`.

    Args:
        scene_index: which scene.
        target: which layer.
        at: SECONDS from the scene's start.
        x: optional explicit world-pixel x.
        y: optional explicit world-pixel y.
        ease: optional [x1, y1, x2, y2]."""
    import json

    args: dict[str, Any] = {"scene_index": scene_index, "target": to_wire(target), "at": at}
    if x is not None:
        args["x"] = x
    if y is not None:
        args["y"] = y
    if ease is not None:
        args["ease"] = ease
    return json.dumps(_op("motion_add_layer_keyframe", **args), indent=2, default=str)


@mcp.tool()
def motion_move_layer_keyframe(
    scene_index: int,
    target: MotionTarget,
    key_index: int,
    new_at: float,
    lane: str = "transform",
) -> str:
    """Retime ONE existing keyframe — drag it along the keyframe timeline —
    without touching its values.

    `key_index` indexes the layer's key array as `motion_get_manifest` /
    `motion_list_layers` report it. A key moved past a neighbour re-sorts, so
    indices after this call may differ: re-read before retiming another.

    `new_at` is clamped to the scene's own `[0, dur]` and never refused for
    being out of range — the response's `warning` says when it was clamped.

    Args:
        scene_index: which scene.
        target: which layer.
        key_index: which key in that lane's array.
        new_at: its new time, SECONDS from the scene's start.
        lane: "transform" (default — the animation keys) or "active" (a
            `layers`/`layerstack` primitive's step schedule, which the
            keyframe timeline draws as its own row)."""
    import json

    return json.dumps(
        _op(
            "motion_move_layer_keyframe",
            scene_index=scene_index,
            target=to_wire(target),
            key_index=key_index,
            new_at=new_at,
            lane=lane,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_delete_layer_keyframe(scene_index: int, target: MotionTarget, key_index: int) -> str:
    """Remove ONE keyframe from a layer's `transform.keys`.

    Deleting the LAST remaining key removes the animation entirely (reported
    as `clearedAnimation`), at which point the layer's static position/
    transform values take over again — which is usually what you want, but is
    a visible change, not a no-op.

    Indices shift after a delete; `remainingKeyCount` is returned so you can
    re-plan without a round trip.

    Args:
        scene_index: which scene.
        target: which layer.
        key_index: which key to remove."""
    import json

    return json.dumps(
        _op(
            "motion_delete_layer_keyframe",
            scene_index=scene_index,
            target=to_wire(target),
            key_index=key_index,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_move_camera_keyframe(
    scene_index: int, key_index: int, new_at: float, camera: str = "2d"
) -> str:
    """Retime ONE camera keyframe — the camera's own half of the keyframe
    timeline's drag gesture.

    Changes only WHEN the key fires, never its values; use
    `motion_set_camera_2d` / `_3d` for values (they replace the whole array).
    Clamped to the scene's `[0, dur]` with a warning, never refused for range.
    A key moved past a neighbour re-sorts, so re-read before retiming another.

    Args:
        scene_index: which scene.
        key_index: which key in that camera's array.
        new_at: its new time, SECONDS from the scene's start.
        camera: "2d" (default) or "3d"."""
    import json

    return json.dumps(
        _op(
            "motion_move_camera_keyframe",
            scene_index=scene_index,
            key_index=key_index,
            new_at=new_at,
            camera=camera,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_move_keys_by_delta(targets: list[MotionKeyTarget], delta_seconds: float) -> str:
    """Shift MANY keyframes by one shared time delta — the keyframe timeline's
    box-select-then-nudge gesture. The tool for "start this whole animation
    half a second later" without recomputing every `at` yourself.

    Targets may mix lanes and scenes freely. Each is
    `{"scene_index": N, "kind": ..., "key_index": K}` where `kind` is:
      * `"layer"`  — a layer's `transform.keys` (needs `layer_index`)
      * `"active"` — a `layers` primitive's step schedule (needs `layer_index`)
      * `"camera"` / `"scene3d-camera"` — that scene's camera keys

    Each key's base time is read off the current manifest, so you only supply
    the delta. (`base_at` may be given per target to replay a real drag from a
    captured start; normally omit it.)

    Clamping is PER KEY, never a group veto: a key that hits its scene's edge
    stops there while the others move the full delta. Every target is
    validated BEFORE anything is written, so a bad one fails the whole call
    rather than half-applying it. Keys re-sort, so re-read indices afterwards.

    Args:
        targets: the keys to move (see above).
        delta_seconds: how far to shift them; negative moves earlier."""
    import json

    return json.dumps(
        _op("motion_move_keys_by_delta", targets=to_wire(targets), delta_seconds=delta_seconds),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_set_keyframe_ease(
    scene_index: int,
    key_index: int,
    ease: EaseCurve | None = None,
    lane: str = "layer",
    target: MotionTarget | None = None,
) -> str:
    """Set (or clear) ONE keyframe's easing curve — the bezier curve editor,
    reachable in a single call instead of resending a whole key array.

    **This is the difference between motion that reads as authored and motion
    that reads as generated.** Every segment is LINEAR by default: a constant
    rate with a dead stop at the next key. An ease shapes the RATE only — both
    endpoints still hit their authored values at their authored times, so
    easing can never move a keyframe.

    `ease` is `[x1, y1, x2, y2]`, a cubic bezier's two control points.
    Familiar shapes: `[0.4, 0, 0.2, 1]` ease-in-out, `[0, 0, 0.2, 1]` ease-out
    (fast start, gentle landing), `[0.4, 0, 1, 1]` ease-in. `x1`/`x2` outside
    `0..1` are CLAMPED with a warning (the runtime throws on them); `y`
    outside `0..1` is legal and is real overshoot — `[0.3, 0, 0.3, 1.4]`
    overshoots and settles back — but not unbounded (B-166): `y1`/`y2` are
    silently clamped to `-0.75..1.75`, with a warning if that changed
    anything.

    Pass `ease=null` to CLEAR it back to linear. Omitting `ease` entirely is
    an error, since there would be nothing to do.

    Args:
        scene_index: which scene.
        key_index: which key in that lane's array.
        ease: [x1, y1, x2, y2], or null to clear.
        lane: "layer" (default, needs `target`), "camera", or
            "scene3d-camera". An "active" step schedule has no ease — it does
            not interpolate — and is refused by name.
        target: which layer, required when lane is "layer"."""
    import json

    args: dict[str, Any] = {
        "scene_index": scene_index,
        "key_index": key_index,
        "lane": lane,
        "ease": ease,
    }
    if target is not None:
        args["target"] = to_wire(target)
    return json.dumps(_op("motion_set_keyframe_ease", **args), indent=2, default=str)


@mcp.tool()
def motion_set_layer_active_schedule(
    scene_index: int, target: MotionTarget, schedule: list[ActiveScheduleEntry]
) -> str:
    """Set which child of a `layers`/`layerstack` primitive is highlighted, and
    from when — its `active` STEP schedule.

    `schedule` is `[{"at": seconds, "i": childIndex}, ...]`. It is a STEP, not
    an interpolation: `{"at": 2, "i": 1}` means "from 2s onward show child 1",
    holding until the next entry. Hence there is no `ease` anywhere on it.

    This is how a stacked-cards explainer walks down its list over time.
    `motion_move_layer_keyframe(lane="active")` retimes one step;
    `motion_move_keys_by_delta` with `kind="active"` shifts several.

    Passing `schedule=[]` removes the field entirely, back to whatever static
    `active` value the layer had.

    Args:
        scene_index: which scene.
        target: the `layers`/`layerstack` layer.
        schedule: the complete new step list."""
    import json

    return json.dumps(
        _op(
            "motion_set_layer_active_schedule",
            scene_index=scene_index,
            target=to_wire(target),
            schedule=to_wire(schedule),
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_seek(
    frame: int | None = None, scene_index: int | None = None, at: float | None = None
) -> str:
    """Move the Motion preview's playhead — the equivalent of clicking the
    timeline ruler. Do this before `debug_screenshot` to photograph a specific
    moment of the animation.

    Two ways to say where, whichever is easier:
      * `frame` — an absolute frame in the whole combined timeline.
      * `scene_index` + `at` — SECONDS within that scene, which is the same
        space every keyframe `at` is in, so you can seek straight to a key you
        just wrote without converting anything.

    `frame` wins if both are given. Out-of-range values are CLAMPED to the
    real timeline with a warning rather than refused.

    Args:
        frame: absolute frame.
        scene_index: which scene, when seeking scene-relative.
        at: seconds within that scene (default 0)."""
    import json

    args: dict[str, Any] = {}
    if frame is not None:
        args["frame"] = frame
    if scene_index is not None:
        args["scene_index"] = scene_index
    if at is not None:
        args["at"] = at
    return json.dumps(_op("motion_seek", **args), indent=2, default=str)


@mcp.tool()
def motion_save_manifest() -> str:
    """Write the manifest to its sidecar file inside the project now — the Save
    button.

    Edits made by every other `motion_*` tool live in the app's in-memory
    document (and are fully undoable there) until this is called.
    `motion_render` saves first automatically if the document is dirty, so an
    explicit save is only needed when you want the file on disk WITHOUT
    rendering.

    Returns the real sidecar `path` on success, or the real failure message —
    never a silent success.

    Does not create a project: a Motion manifest lives inside one, so a
    project must already be open."""
    import json

    return json.dumps(_op("motion_save_manifest"), indent=2, default=str)


@mcp.tool()
def motion_get_edit_links() -> str:
    """What each Motion scene feeds in the Edit tab: its rendered file, and
    every clip on the open Edit timeline reading it (D-260).

    This is the read half of "re-render, auto-replace" — call it to see what a
    `motion_render` will refresh before you run one, or to confirm what it
    refreshed after. The Motion tab shows a human the identical fact as an
    "N in Edit" badge on the scene row, off the identical value.

    Per scene: `index`, `sceneId`, `rendered` (has this scene ever been
    rendered into this project's Sources?), `mediaId` / `sourcePath` (its pool
    item and file, null when not), `clipCount`, and `clips` — each with the
    `track`/`clip` indices `editor_*` tools address by, plus the clip's id and
    name.

    `rendered: false` and a top-level `available: false` are different
    answers. The first means that scene has no render in the pool yet. The
    second means no link data reached the tab at all (no project open) — do
    not read the per-scene rows as "nothing is linked" in that case.

    A scene that is `rendered: true` with `clipCount: 0` has been rendered and
    is sitting in Sources, but has never been placed — re-rendering it changes
    nothing on the timeline. Use `editor_add_clip` with its `mediaId` to place
    it.

    **`rendered` and `clipCount` are answered against the file a re-render
    will actually WRITE (B-219).** A project copied on the filesystem (Finder,
    `cp -R`) keeps the ORIGINAL project's absolute media paths, so its Motion
    pool items point at files no render of this project can reach. Such a
    scene reads `rendered: false`, `clipCount: 0`, `refreshedByRender: false`,
    with the whole inherited link reported separately as `staleLink`
    (`mediaId` / `sourcePath` / `clipCount` / `clips` / `reason`), and the
    response carries a top-level `warning`. Those clips are really on the
    timeline and really play — they just will not be refreshed by a render.
    Fix: `motion_render` the scene to produce this project's own file, then
    `editor_swap_clip_media` those clips onto it.

    `refreshedByRender` is three-valued: `true` (the render lands on this
    file), `false` (the copied-project case above), `null` (no project root
    reached the tab — the question was not asked, which is not a "no")."""
    import json

    return json.dumps(_op("motion_get_edit_links"), indent=2, default=str)


@mcp.tool()
def motion_list_layer_presets() -> str:
    """List the user's saved COMPONENTS — layers they tuned once and kept for
    reuse. The Catalog tab's "Components" section, as data.

    A component is a named, frozen copy of one layer fragment: every field it
    had when it was saved, INCLUDING its `transform` and its keyframes. It is
    not a new kind of object — inserting one produces an ordinary layer, and
    nothing links the two afterwards.

    These are USER-level and shared across projects, unlike the manifest. This
    tool needs no project open, so it is a safe thing to call while deciding
    what to build.

    Each entry carries `id` (pass it to `motion_add_layer_from_preset`),
    `name`, `use`, `createdAt`, and the full `layer` fragment so you can see
    what you would be inserting before you insert it. Newest first.

    Distinct from `motion_list_primitives`, which lists the ten BUILT-IN
    primitives and their fields. That one is what the engine can draw; this one
    is what this user has already made."""
    import json

    return json.dumps(_op("motion_list_layer_presets"), indent=2, default=str)


@mcp.tool()
def motion_save_layer_preset(scene_index: int, target: MotionTarget, name: str) -> str:
    """Save one existing layer to the component library under `name` — the
    Inspector's "Save as component" box.

    The whole fragment is captured as it stands, keyframes and all, minus the
    layer's `id`. Use this when a layer has been tuned into something worth
    having again: a `matrix` set up as a real attention heatmap, a `graph`
    wired to a specific architecture, a `text` with the exact size and entrance
    you want. Rebuilding one of those from `motion_add_layer` is five or ten
    `motion_set_layer_field` calls; inserting the saved one is a single call.

    The library is user-level and shared across projects, so a component saved
    while working on one project is available in every other one.

    Editing the layer afterwards does NOT change the component, and editing the
    component does not change layers already inserted from it. It is a copy,
    deliberately — see `motion_add_layer_from_preset`.

    Args:
        scene_index: which scene the layer is in.
        target: {kind, index?, id?} — kind is "layer" or "scene3d-child".
        name: what to call it in the library. Leading/trailing whitespace is
            trimmed and interior runs collapsed; an empty name is refused."""
    import json

    return json.dumps(
        _op(
            "motion_save_layer_preset",
            scene_index=scene_index,
            target=to_wire(target),
            name=name,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_add_layer_from_preset(scene_index: int, preset_id: str) -> str:
    """Insert a saved component into a scene — the "+ Add to scene" button on a
    row of the Catalog tab's Components section.

    Get `preset_id` from `motion_list_layer_presets`. The new layer reproduces
    the component exactly, keyframes included, with a fresh `id`.

    Placement is decided by the PRIMITIVE, not by you: a `particleflow`,
    `labelbox` or `layerstack` component goes into `scene3d.children` (creating
    that container, with a default camera, if the scene has none); every other
    kind is appended to `scene.layers`. This is the same rule
    `motion_add_layer` follows.

    The insert is a COPY. Nothing links the new layer back to the component:
    changing the component later does not restyle this layer, and deleting the
    component does not remove it. Edit the result with
    `motion_set_layer_field` / `motion_set_layer_position` like any other
    layer.

    Returns the `selection` addressing the new layer.

    Args:
        scene_index: which scene to add it to.
        preset_id: the component's `id` from `motion_list_layer_presets`."""
    import json

    return json.dumps(
        _op(
            "motion_add_layer_from_preset",
            scene_index=scene_index,
            preset_id=preset_id,
        ),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_delete_layer_preset(preset_id: str) -> str:
    """Remove one saved component from the library — the trash button on its
    Catalog row.

    This is safe in a way that deleting a component in a design tool is not:
    layers already inserted from it are ordinary layers and are left completely
    alone, in this project and every other one. Only the library entry goes.

    Needs no project open, for the same reason `motion_list_layer_presets`
    does not: the library is user-level state, not part of any manifest.

    Args:
        preset_id: the component's `id` from `motion_list_layer_presets`."""
    import json

    return json.dumps(
        _op("motion_delete_layer_preset", preset_id=preset_id),
        indent=2,
        default=str,
    )


@mcp.tool()
def motion_render() -> str:
    """Render the Motion manifest to REAL video files, via Remotion — the one
    Motion tool that produces something outside the app. Saves first if dirty.

    **One video file PER SCENE**, never one combined video: a manifest with
    three scenes produces three MP4s, and the response's `results` array
    carries each one's `sceneId` and `outputPath`. That is deliberate — a
    scene is the unit of "one shot" here, and separate files are what an edit
    can actually cut between.

    **How a rendered scene reaches the Edit tab — NOT what you might assume.**
    Every rendered file is imported into the Edit tab's Sources media pool
    AUTOMATICALLY, at the pool root, as each scene finishes. You do NOT need
    to call `editor_import_media` on these paths; it has already happened.
    What is NOT automatic is PLACEMENT: nothing is put on the Edit timeline,
    deliberately, because the app cannot know which track or position you
    want. So the real chain is:

        motion_render  ->  (files auto-appear in Sources)
                       ->  editor_add_clip / editor_edit_in to place one

    **Re-rendering a scene REFRESHES the Edit clips already placed from it
    (D-260).** This replaced the old "there is no live link" rule. A scene
    always renders to the same per-scene file, so a re-render replaces that
    file atomically and every Edit clip reading it picks the new content up by
    itself — in the preview and in the export — with its length and frame rate
    re-read from the new render. You do NOT re-import, and you do NOT call
    `editor_swap_clip_media`. Call `motion_get_edit_links` to see what a
    re-render will refresh (or did). The one case where it does NOT hold is a
    project copied on the filesystem, whose pool still names the ORIGINAL
    project's files — `motion_get_edit_links` reports that as `staleLink` and
    says what to do about it (B-219).

    It is still not a live embed, and the difference matters: nothing
    re-renders on its own. Editing the manifest changes nothing downstream
    until you call this tool again — the render is the explicit trigger, by
    design, because a render is expensive and a surprise one mid-edit is
    worse than an out-of-date clip you chose not to refresh yet.

    **A slow render can look like a failure and is not.** The control bridge
    gives up after 20 seconds while the render keeps running to completion on
    disk. If this returns a timeout error, treat it as INCONCLUSIVE rather
    than failed, and poll `motion_get_state`'s `render` block instead of
    re-rendering (which would just start a second render). That block is the
    definitive answer: `running` with a scene counter means wait, `idle` with
    `scenesDone == scenesTotal` means it finished, and `error` names the scene
    that failed and why (B-202). Counting files in Sources cannot tell those
    three apart."""
    import json

    return json.dumps(_op("motion_render"), indent=2, default=str)

if __name__ == "__main__":
    mcp.run()
