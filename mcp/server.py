#!/usr/bin/env python3
"""Chroma MCP server (D-020).

Thin stdio MCP server. Every tool is a wrapper around the Chroma *control
server* — a tiny HTTP server running inside the Chroma desktop app
(`engine/src-tauri/src/chroma/control.rs`). The control server forwards each op
to the app's frontend, which applies it through the SAME store actions the GUI
buttons use and renders. So an edit made here moves the app's sliders and
re-renders its canvas; `get_state` reflects the user's manual edits too.

There is no grade/mask logic here and none in the control server — it all lives
in one place, the frontend store. Adding a capability = one entry in the
frontend `OPS` registry + one tool here.

Requires: the Chroma app running (the control server binds on start).
Base URL: http://127.0.0.1:${CHROMA_CONTROL_PORT:-19788}
"""

from __future__ import annotations

import os
from typing import Any

import httpx
from mcp.server.mcpserver import Image, MCPServer
from mcp.types import TextContent

PORT = os.environ.get("CHROMA_CONTROL_PORT", "19788")
BASE_URL = f"http://127.0.0.1:{PORT}"

SCOPE_DISCIPLINE = (
    "Grade by the numbers. Call `inspect_color` before and after a change and "
    "reason from the scope values (black/white points, per-zone means, warm-cool "
    "and green-magenta cast, clip %, hue histogram) or a named full-res region "
    "from `sample` / `sample_region`. Never claim a result ('looks balanced', "
    "'skin is natural', 'the cast is gone') without citing a scope value or a "
    "sampled region. Defer genuinely creative calls to the human."
)

mcp = MCPServer(
    "chroma",
    instructions=(
        "Drive the running Chroma color-grading app. Edits move the app's real "
        "UI and re-render its canvas; reads reflect the user's manual edits. "
        "The Chroma desktop app must be open. Call get_state first to see the "
        "current image/video, adjustments and masks.\n\n"
        + SCOPE_DISCIPLINE
        + "\n\nMutating tools return the rendered frame, its histogram, and the "
        "compact scope summary (the new measurement, for free) after the change."
    ),
)


def _op(op: str, **args: Any) -> dict:
    """POST one op to the control server, return the parsed JSON envelope."""
    try:
        r = httpx.post(
            f"{BASE_URL}/op",
            json={"op": op, "args": args},
            timeout=60.0,
        )
    except httpx.ConnectError as e:
        raise RuntimeError(
            f"Cannot reach the Chroma control server at {BASE_URL}. "
            "Is the Chroma desktop app running?"
        ) from e
    if r.status_code == 504:
        raise RuntimeError(
            "The Chroma app did not respond (its window may be closed or busy)."
        )
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
def set_curve(channel: str, points: list[dict]) -> list:
    """Replace a tone-curve channel. channel is one of luma|red|green|blue.
    points is an ordered list of {x, y} in 0..255 (both axes), e.g.
    [{"x":0,"y":0},{"x":128,"y":140},{"x":255,"y":255}].
    Grade by the numbers: verify the move on `inspect_color` (parade / black-white
    points / per-zone means), not the thumbnail."""
    return _result(_op("set_curve", channel=channel, points=points))


@mcp.tool()
def set_color_grade(
    shadows: dict | None = None,
    midtones: dict | None = None,
    highlights: dict | None = None,
    global_: dict | None = None,
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
            patch[name] = val
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
    """Move the video playhead to `frame` (0-based). Decodes that frame and
    re-renders it with the current grade. No-op if the loaded item is a still."""
    return _result(_op("seek", frame=frame))


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
    return _result(_op("add_subject_mask", **args))


@mcp.tool()
def add_component(
    mask_id: str,
    type: str,
    mode: str = "subtractive",
    bbox: list[float] | None = None,
    geometry: dict | None = None,
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
        args["geometry"] = geometry
    return _result(_op("add_component", **args))


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
    return _result(_op("track_subject", sub_mask_id=sub_mask_id, mode=mode))


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
def apply_haze(amount: float = 1.0, protect_subject: bool = True) -> list:
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

    Depth is computed per frame (the seek cache is busted); it is not keyframed —
    on a moving camera, re-run per section.

    Grade by the numbers: `inspect_color` before and after — whole-frame
    saturation should drop and the black point lift; `sample` a background pixel
    vs a subject pixel and confirm the background moved more.
    Returns {maskId, subMaskId, amount} and the rendered frame."""
    return _result(_op("apply_haze", amount=amount, protect_subject=protect_subject))


@mcp.tool()
def invert_mask(sub_mask_id: str) -> list:
    """Invert a sub-mask (grade the outside instead of the inside)."""
    return _result(_op("invert_mask", sub_mask_id=sub_mask_id))


@mcp.tool()
def delete_mask(mask_id: str) -> list:
    """Delete a whole mask container (mask_id from list_masks)."""
    return _result(_op("delete_mask", mask_id=mask_id))


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
    cast is gone') without citing a scope value or a sampled region. Defer
    genuinely creative calls to the human.
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
def request_human(reason: str, roi: dict | None = None) -> str:
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
        args["roi"] = roi
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
    """Render the current grade to a file.

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


if __name__ == "__main__":
    mcp.run()
