#!/usr/bin/env python3
"""Pydantic models for every structured (nested-object) MCP tool parameter (D-310).

WHAT THIS IS
    One reusable `BaseModel` per distinct *wire shape* that `mcp/server.py`'s tools
    accept as a nested argument — mask geometry, colour-wheel channels, keyframes,
    Motion layer targets, and so on — plus `to_wire()`, which turns a validated model
    back into the exact JSON dict the control server expects.

WHAT IT DOES
    Gives the MCP tool surface a real, introspectable `inputSchema`. Before this, every
    structured parameter in `server.py` was a bare `dict | None`, which MCP renders as
    `{"type": "object", "additionalProperties": true}` — no field names, no types, no
    contract beyond docstring prose (roadmap item 7 under "Make Colorist's MCP tool
    surface AI-first"). The MCP spec expects `inputSchema` to be real JSON Schema with
    typed `properties`; these models produce exactly that, so a client can introspect,
    autocomplete and validate, and a malformed argument fails at the tool boundary with
    a field-level message instead of somewhere downstream in TS or Rust.

WHAT IT DOES *NOT* DO
    - It does NOT normalise, rename, reorder or defaults-fill anything. `to_wire()` uses
      `exclude_unset=True`, so the dict posted to the control server is byte-identical to
      the dict the caller sent (verified: unknown keys, explicit nulls and alias
      spellings all survive untouched). Every default in this system stays where it
      already lives — in the frontend handler — and is deliberately NOT duplicated here.
    - It does NOT re-implement any validation the frontend already does, and it is not a
      second source of truth for these shapes. The handlers named below remain
      authoritative; these models describe them.
    - It does NOT cover flat scalar parameters (`track: int`, `mode: str`, ...). Those
      already carried real types and real schema.

THE ONE RULE THESE MODELS ARE BUILT ON
    **A model describes what the handler ACTUALLY accepts, not what its docstring
    claims.** Every shape here was read off its real consuming handler, not its
    docstring, because the two disagree in several places. The case that prompted this
    work: `add_component`'s docstring documents radial geometry as `{cx,cy,rx,ry}`, but
    `useChromaControl.ts` also accepts `centerX/centerY/radiusX/radiusY` through a
    `g.cx ?? g.centerX` fallback chain. A model written from the docstring alone would
    have rejected a shape that works today — making the tool more broken, not less. So
    where two spellings are both genuinely accepted, BOTH appear as explicit optional
    fields (see `RadialGeometry`, `MotionTarget.item_index`/`itemIndex`), which also
    makes the second shape visible in the published schema for the first time.

    The handlers this was read against:
      Colorist / global  app/src/hooks/useChromaControl.ts
      Edit  (`editor_*`) packages/editor/src/useEditorControl.ts, editorExport.ts
      Motion (`motion_*`) packages/motion/src/motionOps.ts

EXTRA-KEY POLICY (why some models forbid unknown keys and others allow them)
    `extra="forbid"` — used for small closed shapes whose handler reads a FIXED key
    whitelist and silently ignores everything else (colour-wheel channels, mask
    geometry, ROI, camera keys). There, an unknown key is already a silent no-op, so
    rejecting it converts a silent failure into the clear boundary error this change
    exists to provide. Forbidding also lets a union discriminate structurally —
    a `{startX: ...}` dict cannot validate as `RadialGeometry`.

    `extra="allow"` — used where the handler stores the object verbatim into the
    document (a clip keyframe reaches `project.json` intact) or where a hand-authored
    manifest may legitimately carry fields the Inspector does not know about
    (`MotionTarget`, `MotionSelection`). Forbidding there would reject data the system
    deliberately round-trips.

DELIBERATELY NOT ENFORCED
    Limits that would reject a call the app accepts today are documented in field
    descriptions rather than enforced, so this change cannot regress a working call:
      - `set_curve` keeps only the first 16 points (image_processing.rs) — extras are
        dropped downstream, not rejected here.
      - Motion ease `y` is clamped to [-0.75, 1.75] by the handler, with a warning.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# --------------------------------------------------------------------------- #
# wire conversion
# --------------------------------------------------------------------------- #

__all__ = [
    "to_wire",
    "ActiveScheduleEntry",
    "BezierPoints",
    "Camera2DKey",
    "Camera3DKey",
    "ClipHighlightSpec",
    "ClipKeyframe",
    "ClipSelector",
    "ColorWheelChannel",
    "CurvePoint",
    "CurveSpec",
    "DynamicZoomFraming",
    "EaseCurve",
    "EasePresetName",
    "CaptionScope",
    "ExportRenderer",
    "LoudnessPreset",
    "FitMode",
    "GapSelector",
    "HighlightBox",
    "LayerTransformKey",
    "LinearGeometry",
    "MaskGeometry",
    "MotionKeyTarget",
    "MotionSelection",
    "MotionTarget",
    "RadialGeometry",
    "Roi",
    "SpeedRampPoint",
    "ThemeFields",
    "ThemeFontSpec",
]


def to_wire(value: Any) -> Any:
    """Turn a validated model (or a list/dict of them) back into plain JSON.

    `exclude_unset=True` is the whole point: only the fields the caller actually
    supplied are emitted, so the payload posted to the control server is exactly the
    dict the caller sent — no defaults injected, no omitted key materialised as null.
    That keeps these models a pure *description* of the wire format rather than a
    second layer that quietly rewrites it.
    """
    if isinstance(value, BaseModel):
        return value.model_dump(exclude_unset=True, by_alias=True)
    if isinstance(value, list):
        return [to_wire(v) for v in value]
    if isinstance(value, dict):
        return {k: to_wire(v) for k, v in value.items()}
    return value


# --------------------------------------------------------------------------- #
# shared easing
# --------------------------------------------------------------------------- #

EaseCurve = Annotated[
    list[float],
    Field(
        min_length=4,
        max_length=4,
        description=(
            "Cubic-bezier control points [x1, y1, x2, y2]; P0=(0,0) and P3=(1,1) are "
            "implicit. Exactly four finite numbers."
        ),
    ),
]

# The four presets in `EASE_PRESETS` (packages/editor/src/timeline.ts). NOTE: CSS's
# "ease" is NOT among them — several docstrings claimed it was, and it is rejected at
# runtime (B-164).
EasePresetName = Literal["linear", "ease-in", "ease-out", "ease-in-out"]


class BezierPoints(BaseModel):
    """A cubic-bezier ease given as an object rather than a 4-array.

    Undocumented but fully accepted by `parseCurve` (useEditorControl.ts), which reads
    `Array.isArray(v) ? v : [v?.x1, v?.y1, v?.x2, v?.y2]`. Modelled so that typing the
    parameter does not silently drop a form that works today.
    """

    model_config = ConfigDict(extra="forbid")

    x1: float
    y1: float
    x2: float
    y2: float


# The three interchangeable forms `parseCurve` accepts for an Edit-tab easing argument.
CurveSpec = EasePresetName | EaseCurve | BezierPoints


# --------------------------------------------------------------------------- #
# Colorist — tone curve, colour wheels
# --------------------------------------------------------------------------- #


class CurvePoint(BaseModel):
    """One point on a tone curve (`set_curve`).

    Only the first 16 points of a channel are used — `convert_points_to_aligned` in
    app/src-tauri/src/image_processing.rs takes 16 and silently drops the rest. Points
    are not sorted or de-duplicated for you.
    """

    model_config = ConfigDict(extra="forbid")

    x: float = Field(description="Input level, 0..255.")
    y: float = Field(description="Output level, 0..255.")


class ColorWheelChannel(BaseModel):
    """One colour-grading wheel — shadows / midtones / highlights / global.

    These three keys are the entire accepted set: `useChromaControl.ts` keeps a value
    only `if (['hue','saturation','luminance'].includes(zk) && typeof zv === 'number')`.
    There is no r/g/b, lift/gamma/gain or sat/lum spelling. Each wheel is merged one
    level deep, so passing only `hue` leaves the wheel's saturation and luminance alone.
    """

    model_config = ConfigDict(extra="forbid")

    hue: float | None = Field(None, description="0..360.")
    saturation: float | None = Field(None, description="Roughly -100..100.")
    luminance: float | None = Field(None, description="Roughly -100..100.")


# --------------------------------------------------------------------------- #
# Colorist — mask geometry
# --------------------------------------------------------------------------- #


class RadialGeometry(BaseModel):
    """Radial sub-mask geometry, in SOURCE PIXELS (`add_component`).

    Every field is optional: the handler falls back to the sub-mask's own default for
    each one independently (centre = frame centre, radii = width/4, feather = 0.5), so
    a partial geometry is a legitimate call and is NOT rejected here.

    **Two accepted spellings.** `useChromaControl.ts` reads
    `centerX: g.cx ?? g.centerX`, `centerY: g.cy ?? g.centerY`,
    `radiusX: g.rx ?? g.radiusX`, `radiusY: g.ry ?? g.radiusY` — so the short form and
    the long form are equally valid, with the short form winning if both are given.
    Only the short form was ever documented; both are modelled here so the published
    schema finally shows the alternative (see this module's header, and D-310).
    """

    model_config = ConfigDict(extra="forbid")

    cx: float | None = Field(None, description="Centre x. Wins over centerX. Default: width/2.")
    cy: float | None = Field(None, description="Centre y. Wins over centerY. Default: height/2.")
    rx: float | None = Field(None, description="Radius x. Wins over radiusX. Default: width/4.")
    ry: float | None = Field(
        None, description="Radius y. Wins over radiusY. Default: width/4 (width, not height)."
    )
    centerX: float | None = Field(None, description="Alias for cx.")
    centerY: float | None = Field(None, description="Alias for cy.")
    radiusX: float | None = Field(None, description="Alias for rx.")
    radiusY: float | None = Field(None, description="Alias for ry.")
    rotation: float | None = Field(None, description="Degrees. Default 0.")
    feather: float | None = Field(None, description="0..1. Default 0.5.")


class LinearGeometry(BaseModel):
    """Linear (gradient) sub-mask geometry, in SOURCE PIXELS (`add_component`).

    Unlike radial geometry this shape has NO alias spellings — the handler reads
    `startX`/`startY`/`endX`/`endY`/`range` and nothing else (no x1/y1/x2/y2, no
    sx/sy/ex/ey). Every field is optional and independently defaulted by the handler.
    """

    model_config = ConfigDict(extra="forbid")

    startX: float | None = Field(None, description="Default: width * 0.25.")
    startY: float | None = Field(None, description="Default: height / 2.")
    endX: float | None = Field(None, description="Default: width * 0.75.")
    endY: float | None = Field(None, description="Default: height / 2.")
    range: float | None = Field(None, description="Gradient falloff. Default 50.")


# `add_component`'s geometry is discriminated by its sibling `type` argument rather than
# by a key inside the object, so this is a plain union. The two members have disjoint
# key sets and both forbid extras, which is what lets a dict resolve unambiguously.
# Types "subject" and "brush" ignore geometry entirely.
MaskGeometry = RadialGeometry | LinearGeometry


class Roi(BaseModel):
    """A region of interest drawn on the canvas for the user (`request_human`).

    Normalized 0..1 with a top-left origin. All four fields are required — the handler
    errors unless every one is a finite number — and each is clamped to 0..1
    independently, so `x + w` may exceed 1.
    """

    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    w: float = Field(description="Width. Not `width`.")
    h: float = Field(description="Height. Not `height`.")


# --------------------------------------------------------------------------- #
# Edit tab
# --------------------------------------------------------------------------- #


class SpeedRampPoint(BaseModel):
    """One segment boundary in a clip speed ramp (`set_clip_speed`).

    "From this SOURCE frame onward, play at this speed." Source frames are absolute in
    the file, not clip-relative and not timeline frames.
    """

    model_config = ConfigDict(extra="forbid")

    source_frame: int = Field(description="Absolute source frame. Not `frame`/`sourceFrame`.")
    speed: float = Field(
        description=(
            "Multiplier. Magnitude must be 0.05..20, either sign; negative plays "
            "backwards. 0 and out-of-range values are refused, not clamped."
        )
    )


class ClipSelector(BaseModel):
    """One clip in a selection (`editor_set_selection`).

    `track` is always required, even when addressing by `clipId` — the id is searched
    only within that track. `clipId` wins when both it and `clip` are given.
    """

    model_config = ConfigDict(extra="allow")

    track: int = Field(description="0-based track index. Always required.")
    clip: int | None = Field(None, description="0-based clip index within the track.")
    clipId: str | None = Field(
        None, description="Clip id. Wins over `clip`. Prefer this if anything may have moved."
    )

    @model_validator(mode="after")
    def _need_an_address(self) -> ClipSelector:
        if self.clip is None and self.clipId is None:
            raise ValueError("each clip entry needs `clip` (an index) or `clipId`")
        return self


class GapSelector(BaseModel):
    """A gap between two clips (`editor_set_selection`).

    `frame` must land inside a real, closeable gap — trailing space past the last clip
    is not a gap and is refused.
    """

    model_config = ConfigDict(extra="forbid")

    track: int
    frame: int = Field(description="A TIMELINE frame inside the gap.")


class ClipKeyframe(BaseModel):
    """One keyframe on a clip's own transform/audio timeline (`editor_set_clip_keyframes`).

    `extra="allow"` because the array is stored verbatim — unknown keys survive into
    `project.json` rather than being dropped.
    """

    model_config = ConfigDict(extra="allow")

    frame: float = Field(
        description=(
            "Clip SOURCE-frame-absolute. Strictly numeric: unlike most numeric "
            "arguments in the Edit tab this one is not string-coerced."
        )
    )
    params: dict[str, float] = Field(
        description=(
            "Subset of opacity / position_x / position_y / scale / rotation / "
            "corner_radius / crop_left / crop_top / crop_right / crop_bottom / "
            "volume / pan. Names outside that set are stored but have no effect."
        )
    )
    ease: dict[str, BezierPoints] | None = Field(
        None,
        description=(
            "Per-param easing for the segment STARTING at this key, keyed by param "
            "name. Real and load-bearing — this is how `editor_set_keyframe_ease` "
            "persists — though no docstring documented it before D-310."
        ),
    )


# `ClipHighlightSpec.box`: four fractions of the SOURCE image.
HighlightBox = Annotated[
    list[float],
    Field(
        min_length=4,
        max_length=4,
        description=(
            "[x0, y0, x1, y1] as fractions of the SOURCE image (0..1, top-left origin). "
            "Corners may come in any order; values are clamped to 0..1; the box must "
            "have area."
        ),
    ),
]


class ClipHighlightSpec(BaseModel):
    """One highlighter-pen sweep on a clip (`editor_set_clip_highlights`).

    Drawn on the clip's own picture, left to right, starting at source frame `at`; once
    swept it stays for the rest of the clip.
    """

    model_config = ConfigDict(extra="forbid")

    box: HighlightBox
    at: int = Field(
        description=(
            "Clip SOURCE frame the sweep starts on (the same axis as a keyframe's "
            "`frame`), >= 0."
        )
    )
    dur: int = Field(description="Frames the sweep takes, >= 0. 0 reveals the whole box at `at`.")
    color: str | None = Field(
        None, description="Hex colour, #RGB or #RRGGBB. Default #F2B63A (a highlighter yellow-ochre)."
    )
    opacity: float | None = Field(None, description="0..1. Default 0.45.")


class ThemeFontSpec(BaseModel):
    """One Google Fonts family a theme downloads (`motion_define_theme`)."""

    model_config = ConfigDict(extra="forbid")

    family: str = Field(
        description='Google Fonts family name exactly as Google spells it ("Newsreader", "IBM Plex Mono").'
    )
    weights: list[str] | None = Field(
        None, description='CSS weights to load, e.g. ["400", "600"]. Omitted loads the regular weight.'
    )
    italic: bool | None = Field(None, description="Load the italic face instead of the upright one.")


class ThemeFields(BaseModel):
    """Theme fields for `motion_define_theme`: every one optional, applied over the base.

    Colours are opaque #rrggbb (three.js discards alpha, so a translucent colour would render
    differently in 3D than in 2D).
    """

    model_config = ConfigDict(extra="forbid")

    description: str | None = Field(None, description='One line describing the look (optional).')
    bg: str | None = Field(None, description='Scene ground. Opaque #rrggbb colour.')
    bgDeep: str | None = Field(None, description='Second ground: panels, cards, 3D faces, the vignette edge. Opaque #rrggbb colour.')
    stroke: str | None = Field(None, description='Primary stroke: graph rings, roughjs default. Opaque #rrggbb colour.')
    strokeSoft: str | None = Field(None, description='Secondary lines: borders, graph edges. Opaque #rrggbb colour.')
    text: str | None = Field(None, description='Primary text. Opaque #rrggbb colour.')
    textDim: str | None = Field(None, description='Secondary text: captions, labels. Opaque #rrggbb colour.')
    accent: str | None = Field(None, description='Emphasis / active-state colour. Opaque #rrggbb colour.')
    accentSignal: str | None = Field(None, description='Signal / energy colour: fills, pulses, glows. Opaque #rrggbb colour.')
    strokeWidth: float | None = Field(None, description='Stroke width in px at 1080p, 0.5..20.')
    roughness: float | None = Field(None, description='roughjs roughness, 0..10. 0 draws exact geometry.')
    bowing: float | None = Field(None, description='roughjs bowing, 0..10. 0 keeps straight lines straight.')
    fontDisplay: str | None = Field(None, description='CSS font-family stack for headlines (no ; { } < > or backslash).')
    fontUi: str | None = Field(None, description='CSS font-family stack for labels and body.')
    fontMono: str | None = Field(None, description='CSS font-family stack for numbers and data.')
    ambientDriftPx: float | None = Field(None, description='Amplitude of the always-on drift in px, 0..20. 0 = nothing drifts.')
    fonts: list[ThemeFontSpec] | None = Field(
        None, description="Google Fonts families to download for the stacks above (at most 8)."
    )


class DynamicZoomFraming(BaseModel):
    """A start or end framing for a dynamic zoom (`editor_set_dynamic_zoom`).

    snake_case only — there is no x/y/zoom/positionX alias. Every field is optional and
    falls back to the framing it replaces, so `{"scale": 1.4}` zooms without recentring.
    """

    model_config = ConfigDict(extra="forbid")

    position_x: float | None = Field(None, description="Composition fraction offset from centre.")
    position_y: float | None = Field(None, description="Composition fraction offset from centre.")
    scale: float | None = Field(
        None, description="Multiplier; bigger is more zoomed in. Must be > 0."
    )


# `fit_overrides` values — the handler accepts exactly these two strings.
FitMode = Literal["fit", "stretch"]

# D-350 — `editor_export`'s `renderer`: which engine composites the PICTURE.
# "compositor" = the app's own live-preview compositor, rendered headlessly and
# piped into one ffmpeg process; "filter" = the original `-filter_complex` graph
# with one `-i` per clip. The handler accepts exactly these two strings.
ExportRenderer = Literal["filter", "compositor"]

# D-401 — `editor_export`'s `loudness_preset`: the delivery spec the finished
# mix is normalised to. "off" is the default (no post-processing at all).
LoudnessPreset = Literal["youtube", "broadcast", "podcast", "off"]

# D-411 Phase 0 — `editor_generate_captions_from_transcript`'s `scope`: caption
# one source FILE (shifted by `offset_frames`), or the whole TIMELINE from its
# stitched transcript, so every cue follows the edit's cuts. (The design note
# calls it `from`, which Python cannot take as a parameter name.)
CaptionScope = Literal["file", "timeline"]


# --------------------------------------------------------------------------- #
# Motion tab
# --------------------------------------------------------------------------- #


class MotionTarget(BaseModel):
    """What a Motion op acts on — a layer, a card, a scene or a camera.

    One shape parses every `target` argument (`parseSelectionArg`, motionOps.ts); what
    differs per tool is which `kind` values are meaningful afterwards, which the
    handler reports by name. All six are modelled so this never rejects a target a
    tool actually resolves.

    - kind "scene" / "camera" / "scene3d-camera": `kind` alone; index/id are ignored.
    - kind "layer" / "scene3d-child": needs `index` or `id` (id wins, and keeps naming
      the same layer after something moves).
    - kind "layer-item": needs `index` (the parent layer) AND `item_index` (the card).

    `scene_index` is a SIBLING of `target`, never a key inside it.
    """

    model_config = ConfigDict(extra="allow")

    kind: Literal["scene", "camera", "scene3d-camera", "layer", "scene3d-child", "layer-item"]
    index: int | None = Field(None, description="Position in the layer list.")
    id: str | None = Field(None, description="Stable layer id. Wins over `index`.")
    item_index: int | None = Field(None, description="Card index, for kind 'layer-item'.")
    itemIndex: int | None = Field(
        None,
        description=(
            "Alias for item_index — accepted by the handler "
            "(`target.item_index ?? target.itemIndex`) but undocumented before D-310."
        ),
    )


class MotionSelection(BaseModel):
    """One entry in a Motion multi-select (`selections`).

    Entries carry their own `scene_index`, so a selection may span scenes. Both the
    snake_case and camelCase spellings reach the handler through its `arg()` helper.
    """

    model_config = ConfigDict(extra="allow")

    target: MotionTarget
    scene_index: int | None = Field(None, description="Which scene this entry's target is in.")
    sceneIndex: int | None = Field(None, description="Alias for scene_index.")

    @model_validator(mode="after")
    def _need_scene(self) -> MotionSelection:
        if self.scene_index is None and self.sceneIndex is None:
            raise ValueError("each selection needs `scene_index` (or `sceneIndex`)")
        return self


class MotionKeyTarget(BaseModel):
    """One keyframe to shift (`motion_move_keys_by_delta`).

    A FLAT shape — `kind` sits on the entry itself, not inside a nested `target`, so
    this is deliberately not `MotionSelection`. Targets may mix lanes and scenes.
    """

    model_config = ConfigDict(extra="allow")

    kind: Literal["layer", "camera", "scene3d-camera", "active"] = Field(
        description="Which lane the key lives in. 'layer' and 'active' also need a layer index."
    )
    scene_index: int | None = Field(None, description="Which scene.")
    sceneIndex: int | None = Field(None, description="Alias for scene_index.")
    key_index: int | None = Field(None, description="Which key in that lane's array.")
    keyIndex: int | None = Field(None, description="Alias for key_index.")
    layer_index: int | None = Field(None, description="Required when kind is 'layer' or 'active'.")
    layerIndex: int | None = Field(None, description="Alias for layer_index.")
    base_at: float | None = Field(
        None,
        description=(
            "Optional start time to replay a captured drag from. Omit (or null) and the "
            "key's current time is read off the live manifest."
        ),
    )
    baseAt: float | None = Field(None, description="Alias for base_at.")

    @model_validator(mode="after")
    def _need_scene_and_key(self) -> MotionKeyTarget:
        if self.scene_index is None and self.sceneIndex is None:
            raise ValueError("each target needs `scene_index` (or `sceneIndex`)")
        if self.key_index is None and self.keyIndex is None:
            raise ValueError("each target needs `key_index` (or `keyIndex`)")
        needs_layer = self.kind in ("layer", "active")
        if needs_layer and self.layer_index is None and self.layerIndex is None:
            raise ValueError(f"kind '{self.kind}' needs `layer_index` (or `layerIndex`)")
        return self


class Camera2DKey(BaseModel):
    """One 2D camera keyframe (`motion_set_camera_2d`).

    Genuinely different from the 3D shape: x/y/zoom here, pos/look there.
    """

    model_config = ConfigDict(extra="forbid")

    at: float = Field(description="SECONDS from the scene's start. Strictly numeric.")
    x: float | None = Field(None, description="World x the camera centres on.")
    y: float | None = Field(None, description="World y the camera centres on.")
    zoom: float | None = Field(None, description="Multiplier; 1 = fit.")
    ease: EaseCurve | None = Field(None, description="Shapes the segment starting at this key.")


class Camera3DKey(BaseModel):
    """One 3D camera keyframe (`motion_set_camera_3d`).

    `pos` is required — a 3D camera key with no position is meaningless.
    """

    model_config = ConfigDict(extra="forbid")

    at: float = Field(description="SECONDS from the scene's start. Strictly numeric.")
    pos: Annotated[list[float], Field(min_length=3, max_length=3)] = Field(
        description="Camera position [x, y, z]."
    )
    look: Annotated[list[float], Field(min_length=3, max_length=3)] | None = Field(
        None, description="Look-at point [x, y, z]."
    )
    ease: EaseCurve | None = Field(None, description="Shapes the segment starting at this key.")


class LayerTransformKey(BaseModel):
    """One keyframe in a layer's animation (`motion_set_layer_transform_keys`).

    These values are additive DELTAS on top of the layer's static `transform.*` values,
    not absolute replacements (motion-engine/src/engine/schema.ts). A property absent
    from a key is simply not animated by it.
    """

    model_config = ConfigDict(extra="forbid")

    at: float = Field(description="SECONDS from the layer's SCENE start. Strictly numeric.")
    x: float | None = Field(None, description="World-pixel x delta.")
    y: float | None = Field(None, description="World-pixel y delta.")
    scale: float | None = None
    rot: float | None = Field(None, description="Rotation. Named `rot`, not `rotation`.")
    opacity: float | None = None
    ease: EaseCurve | None = Field(
        None,
        description=(
            "Shapes the segment starting at this key. x1/x2 are clamped to 0..1 and "
            "y1/y2 to -0.75..1.75, each with a warning rather than an error."
        ),
    )


class ActiveScheduleEntry(BaseModel):
    """One step in a `layers`/`layerstack` primitive's active schedule.

    A STEP, not an interpolation: "from `at` seconds onward, show child `i`", holding
    until the next entry. Hence there is no `ease` on it.
    """

    model_config = ConfigDict(extra="forbid")

    at: float = Field(description="SECONDS from the scene's start. Strictly numeric.")
    i: int = Field(ge=0, description="Which child to highlight.")
