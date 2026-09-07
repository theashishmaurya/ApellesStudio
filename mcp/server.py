#!/usr/bin/env python3
"""Chroma MCP server (D-020).

Thin stdio MCP server. Every tool is a wrapper around the Chroma *control
server* — a tiny HTTP server running inside the Chroma desktop app
(`app/src-tauri/src/chroma/control.rs`). The control server forwards each op
to the app's frontend, which applies it through the SAME store actions the GUI
buttons use and renders. So an edit made here moves the app's sliders and
re-renders its canvas; `get_state` reflects the user's manual edits too.

There is no grade/mask logic here and none in the control server — it all lives
in one place, the frontend store. Adding a capability = one entry in the
frontend `OPS` registry + one tool here.

The one exception is the `debug_*` pair (D-209): those ops are answered by the
control server itself, in Rust, with no frontend round trip — a screenshot is a
picture of the webview, not a fact about the store, and the moment it is most
worth having is when the frontend is too wedged to answer.

Requires: the Chroma app running (the control server binds on start).
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
    "chroma",
    instructions=(
        "Drive the running Chroma color-grading app. Edits move the app's real "
        "UI and re-render its canvas; reads reflect the user's manual edits. "
        "The Chroma desktop app must be open. Call get_state first to see the "
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
# Edit tab — timeline read + clip fades (D-147) + track ducking (D-149)
#
# The first Edit-tab tools on this surface; everything above is Colorist.
# `get_timeline` exists because `set_clip_fade(track, clip, ...)` is unusable
# without a way to learn a track/clip index — it is scoped to that need, not an
# attempt to close the whole Edit-tab MCP gap (D-183 below is that attempt).
#
# D-183 moved the frontend handlers for these three ops out of
# `useChromaControl.ts` (Colorist's own catch-all) into `@chroma/editor`'s own
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
    fadeOutCurve, fadeInCurveName, fadeOutCurveName}]}]}.

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
    fade_in_curve: str | list[float] | None = None,
    fade_out_curve: str | list[float] | None = None,
) -> str:
    """Set a clip's fade in / fade out. `track` and `clip` are the 0-based
    indices from get_timeline.

    Durations are in FRAMES (not seconds, not percent). Negative or fractional
    values are floored to whole frames >= 0; the returned values are what was
    actually stored, so check them rather than assuming. A fade LONGER than the
    clip is allowed and is deliberately not clamped: the two windows then
    overlap and their multipliers multiply, so a clip fully fading in and out
    sits at 0.25 in the middle. Omitting a duration leaves that one as it is.

    A curve is either a preset NAME -- "linear" | "ease-in" | "ease-out" |
    "ease-in-out" (also "ease", CSS's own) -- or four cubic-bezier control
    points [x1, y1, x2, y2], the same model CSS cubic-bezier() and After
    Effects keyframe easing use (P0=(0,0) and P3=(1,1) implicit; x is progress
    through the fade window, y the multiplier at that progress). An unknown
    preset name is rejected, not silently substituted. Curves always come back
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
        args["fade_in_curve"] = fade_in_curve
    if fade_out_curve is not None:
        args["fade_out_curve"] = fade_out_curve
    return json.dumps(_op("editor_set_clip_fade", **args), indent=2, default=str)


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
# `editor_*` op in `@chroma/editor`'s `useEditorControl.ts` — read that file's
# own `OPS` map for the authoritative behavior; these are thin wrappers, same
# shape as `get_timeline`/`set_clip_fade`/`set_track_duck` above.
#
# `editor_get_capabilities` (D-191) is the one exception: it is pure static
# documentation, answered entirely in this process with NO round trip to
# `chroma::control` — deliberately, so it works even with no project open and
# no Chroma window running at all. See docs/08-decisions.md's D-191 entry
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
            "`scale` on editor_set_clip_transform/editor_export is a "
            "stacking / picture-in-picture primitive, NOT a 'fill this exact "
            "box' primitive. `overlay_width = canvas_width * scale` ALWAYS, "
            "in both the live preview and export. The overlay's HEIGHT is "
            "the interesting part: in the live preview (Rust "
            "`composite_layer_onto`, D-136, app/src-tauri/src/chroma/edit.rs) "
            "it is the clip's own fit-to-canvas footprint's height times "
            "`scale` (uniform on both axes — the preview has no 'stretch' "
            "concept at all). In export (`timelineExport.ts`'s "
            "`buildClipFilterChain`) it depends on `editor_export`'s "
            "`fit_overrides` (D-184, fixing B-074): the default, `'fit'`, "
            "lets ffmpeg auto-compute height from the clip's own real "
            "post-crop aspect ratio (undistorted, but will not exactly fill "
            "an arbitrary target box); the explicit opt-in `'stretch'` "
            "forces height to `canvas_height * scale` too, i.e. the overlay "
            "ALWAYS has exactly the canvas's own aspect ratio regardless of "
            "the source's real shape — correct only for a genuine same-aspect "
            "PIP bubble or a deliberate distort effect. Before D-184, export "
            "had no 'fit' option at all — every overlay was forced to the "
            "canvas's aspect ratio unconditionally, which is what made a "
            "full-width/half-height stacked layout mathematically impossible "
            "for any canvas. Read `editor_export`'s own docstring for the "
            "complete `fit_overrides` contract before compositing more than "
            "one clip onto a canvas."
        ),
        "full_width_half_height_recipe": (
            "To land a clip in exactly one half of a stacked comparison "
            "layout (e.g. the top half of a 9:16 canvas) with `fit_overrides` "
            "left at its default `'fit'`, `scale` alone will NOT give you an "
            "exact half-height box — the height follows the clip's own "
            "cropped aspect ratio, not the canvas's. Recipe: get the clip's "
            "native width/height from editor_import_media's probe result; "
            "choose crop_top/crop_bottom (or crop_left/crop_right) so the "
            "CROPPED frame's aspect ratio equals the target box's aspect "
            "ratio (target_w / target_h); THEN set scale so target_w == "
            "canvas_width * scale. crop is applied before scale. position_y "
            "places the resulting box's top-left corner as a fraction of the "
            "canvas — it does not center or clamp the box into a slot for "
            "you, and ffmpeg rounds the computed height to the nearest even "
            "pixel, so treat it as approximate when computing an offset "
            "against it."
        ),
        "position_and_crop_units": (
            "position_x / position_y / scale are fractions of the OUTPUT "
            "canvas (0..1, 0,0 = top-left) — not pixels, and not fractions of "
            "the clip's own source resolution. crop_left/top/right/bottom are "
            "fractions (0..1) of the CLIP trimmed off each edge, applied "
            "before scale."
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
        "speed_overrides": (
            "speed_overrides is export-time ONLY — it does not touch the "
            "clip's stored trim/duration, so editor_set_playhead scrubbing "
            "and the GUI still show the clip at 1x. The sped-up clip's "
            "on-timeline window shrinks to duration/speed inside the "
            "export's own placement math; nothing else needs adjusting for "
            "it to line up against unsped clips on other tracks. "
            "`fit_overrides` mirrors this exact shape (`{clip_id: value}`, "
            "export-time-only) for the unrelated aspect-ratio knob above."
        ),
    },
    "known_gaps_and_landmines": {
        "media_pool_stuck_item_B073": (
            "A media-pool item whose FIRST probe failed (e.g. a transient "
            "file-access race) never gets re-probed and is invisible to "
            "editor_add_clip after the project is reopened — even though "
            "editor_import_media on the identical path reports success. "
            "There is no chroma_media_list / _remove MCP tool to inspect or "
            "clear it (a tracked gap, docs/notes/mcp-tool-coverage.md). See "
            "docs/BUGS.md B-073 (status: open). If editor_add_clip keeps "
            "refusing a path you just imported, don't just retry the same "
            "call — recreate the project, or read project.json by hand to "
            "confirm the pool entry actually has a `video` block with real "
            "metadata."
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
            "control-server wedge — restart the Chroma app; don't retry in a "
            "loop."
        ),
        "first_call_after_restart_B071": (
            "The FIRST editor_* call right after restarting the Chroma app "
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
            "Chroma bug (docs/BUGS.md B-070; every process doing direct-path "
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
    reading Chroma's own source or hitting them live. Call this ONCE per
    session, before your first `editor_set_clip_transform` /
    `editor_set_clip_keyframes` / `editor_export`, not per-op.

    Static reference data: answered entirely in this process, no round trip
    to the running app — the only `editor_*`-prefixed tool that works with no
    Chroma window running and no project open at all.

    Covers: what `scale`/`fit_overrides` actually control in the live preview
    vs. export (a stacking/picture-in-picture primitive, not a "fill this
    exact box" primitive — plus the recipe for landing a clip in an exact
    half-canvas slot anyway), track paint order, why keyframes are per-clip,
    export's real v1 scope (video only), and known rough edges worth testing
    for before trusting a real edit (a stuck media-pool entry, a one-time
    flake right after an app restart, a macOS screen-recording filename trap
    that will silently break ANY tool given a hand-typed path, and a
    now-fixed control-server wedge worth knowing the shape of).

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
    the user currently has selected."""
    import json

    return json.dumps(_op("editor_get_state"), indent=2, default=str)


@mcp.tool()
def editor_set_playhead(frame: int) -> str:
    """Move the Edit tab's playhead to an exact frame (0-based, absolute
    timeline frame)."""
    import json

    return json.dumps(_op("editor_set_playhead", frame=frame), indent=2, default=str)


@mcp.tool()
def editor_set_playing(playing: bool) -> str:
    """Start (`True`) or stop (`False`) Edit-tab playback."""
    import json

    return json.dumps(_op("editor_set_playing", playing=playing), indent=2, default=str)


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
    don't just retry."""
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

    **This is the only correction mechanism the pool has right now** (roadmap
    item 23, 2026-09-07): `editor_import_media`'s dedup treats "already known
    by this exact source path" as permanent, so a pool item whose probe
    failed once (a transient race, or a real probe bug — see `docs/BUGS.md`
    B-073/B-089) stays wrong for the rest of the project's life otherwise.
    There is still no re-probe-on-demand or expiry (that remains an open
    architectural gap, not fixed by this tool) — the only way to fix a
    stuck/wrong item today is `editor_remove_media` the bad id, then
    `editor_import_media` the same path again to get a fresh probe.

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
    room rather than overlapping them."""
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
def editor_split_clip(track: int, clip: int, at_frame: int) -> str:
    """Split one clip on the timeline into two, at an exact TIMELINE frame.
    `track`/`clip` are the 0-based indices from `get_timeline`."""
    import json

    return json.dumps(_op("editor_split_clip", track=track, clip=clip, atFrame=at_frame), indent=2, default=str)


@mcp.tool()
def editor_remove_clip(track: int, clip: int) -> str:
    """Remove one clip from the timeline, leaving a gap in its place. Follow
    with `editor_remove_gap` to ripple-close the gap, or leave it if the gap
    is wanted (e.g. to hold a still frame of nothing)."""
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
def editor_trim_clip(track: int, clip: int, edge: str, delta: int) -> str:
    """Trim a clip's `edge` ("start" or "end") by `delta` frames — positive
    shortens the clip, negative extends it back into previously-trimmed
    source material (up to the source's own bounds)."""
    import json

    return json.dumps(_op("editor_trim_clip", track=track, clip=clip, edge=edge, delta=delta), indent=2, default=str)


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
    want to re-trim/re-check it afterward with `get_timeline`."""
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
def editor_add_track(track_kind: str = "video") -> str:
    """Add a new, empty track to the timeline. `track_kind` is "video" or
    "audio". Returns the new track's index."""
    import json

    return json.dumps(_op("editor_add_track", trackKind=track_kind), indent=2, default=str)


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
) -> str:
    """Set a clip's BASE (unkeyframed) compositing transform — e.g. to place
    it in one half of a stacked before/after comparison layout.
    (0..1), applied before `scale`. Omitted fields keep the clip's current
    value — this tool reads the clip back first, it never silently resets a
    field you didn't mention.

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
    scale" is itself a real, distinct thing you might want to say)."""
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
def editor_set_clip_keyframes(track: int, clip: int, keyframes: list[dict]) -> str:
    """Animate a SINGLE clip's own transform over time — e.g. a zoom-in at
    the moment of a click. Keyframes are scoped to this one clip only (its
    own local timeline), never the whole track or timeline, so two clips on
    two different tracks can each zoom at their own moment while both stay
    visible throughout.

    `keyframes` REPLACES the clip's entire keyframe list — pass all of them
    every time, not just the one you're adding. Each entry is
    `{"frame": <source-frame-absolute int>, "params": {<subset of
    opacity/position_x/position_y/scale/rotation/crop_left/crop_top/
    crop_right/crop_bottom>: <number>}}`. Values are piecewise-linearly
    interpolated between keyframes, held constant before the first and after
    the last."""
    import json

    return json.dumps(_op("editor_set_clip_keyframes", track=track, clip=clip, keyframes=keyframes), indent=2, default=str)


@mcp.tool()
def editor_export(
    out_path: str,
    width: int,
    height: int,
    fps: float | None = None,
    speed_overrides: dict[str, float] | None = None,
    fit_overrides: dict[str, str] | None = None,
    freeze_overrides: dict[str, bool] | None = None,
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
    conservatively defaults to silent). Blocks until ffmpeg finishes; there
    is no progress reporting yet — use the Edit tab's own Export dialog
    (D-198) for a real queued/backgrounded multi-export GUI flow instead."""
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
    env = _op("editor_export", **args)
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
    finished in another NLE instead of (or in addition to) Chroma's own
    render.

    Verified against Apple's own real, published FCPXML 1.7 DTD (a real DTD
    validator, not a guess at the XML shape) — see
    `packages/editor/src/timelineInterchange.ts`'s own header doc and D-196
    in `docs/08-decisions.md` for the full field-mapping table. Real, honest
    scope, not a stub:

    MAPS: clip placement/trims (`start_frame`/`source_start`/`duration`),
    track z-order (Chroma's own "track 0 = topmost" convention becomes the
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

    `language` is an ISO code ("en", "hi") or omitted to auto-detect
    (code-switched speech auto-detects fine). `word_timestamps=True` (the
    default) gives per-word start/end times — the format you need to cut to an
    exact word; `False` is faster but segment-level only.

    Complements `editor_analyze_video`, does not overlap it: this finds NOTHING
    in silent or music-only footage. Roughly 12 s for a short clip, longer for
    a long one (mlx-whisper large-v3, local)."""
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
# project model (D-037)
# --------------------------------------------------------------------------- #
@mcp.tool()
def list_projects() -> str:
    """Every saved Chroma project in the projects folder (`~/Movies/Chroma` by
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
    return _result(_op("apply_haze", amount=amount, protect_subject=protect_subject, tracked=tracked))


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


# --------------------------------------------------------------------------- #
# debug — actually look at the app's screen (D-209)
# --------------------------------------------------------------------------- #
@mcp.tool()
def debug_screenshot(
    out_path: str | None = None,
    window: str | None = None,
    inline: bool = False,
) -> list:
    """Take a REAL screenshot of the running Chroma app's window and save it as
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
      * WEBVIEW ONLY. The native title bar, native menus, a native file/save
        dialog, and anything from another app are NOT in the image. If you
        opened a native dialog, the screenshot shows the page behind it.
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


if __name__ == "__main__":
    mcp.run()
