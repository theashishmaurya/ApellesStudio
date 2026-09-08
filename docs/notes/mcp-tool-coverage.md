# MCP tool coverage — what's built vs. what's agent-controllable (2026-09-03)

Owner: "we need MCP for all the actions as well if not already building... keep a
track of all the things we build and document it there so later on we can take it
add MCP server tool for those." This is that tracking doc — a real, verified
inventory of every user-facing capability this app has, cross-referenced against
what the MCP surface (`mcp/server.py`, an MCP stdio server → `chroma::control`'s
HTTP control server, D-020, port 19788 → the same store actions/Tauri commands the
GUI itself calls) actually exposes today. **Not a build task by itself** — a
checklist to work from later, per the owner's own framing ("later on we can take it
and add MCP tools for those"). Update this doc every time a real new capability
ships, the same discipline `docs/04-roadmap.md`'s "Now" section gets.

## How the MCP surface works (so "add a tool" means the same thing every time)

`mcp/server.py` is the actual MCP server a Claude session (or any MCP client)
connects to. Every `@mcp.tool()` function in it calls the SAME control-server HTTP
endpoints (`chroma::control`, `app/src-tauri/src/chroma/control.rs`) that
`app/src/hooks/useChromaControl.ts` (mounted in `Editor.tsx`) already wires to real
GUI store actions — "one shared grade/mask state," per D-020's own doc: an MCP tool
call and a GUI button click both flow through the identical code path, so sliders
visibly move, undo/redo works, `get_state` reflects manual edits, and vice versa.
**Adding a new MCP tool for an existing Tauri command/store action is mechanical**
(a new `@mcp.tool()` in `mcp/server.py` + whatever the control server needs to
route it, following the exact pattern of any of the 41 tools already there — read
a couple, e.g. `set_curve`/`add_relight_light`, for the shape) — the real
prerequisite is the underlying capability already existing and being reachable from
`useChromaControl.ts`'s side of the bridge, which is what this doc tracks.

## Current coverage: Colorist only (42 tools, real, verified via `mcp/server.py`)

`open`, `get_state`, `get_grade`, `save_grade`, `load_grade`, `list_masks`,
`set_primary`, `set_curve`, `set_color_grade`, `seek`, `list_shots`,
`set_active_shot`, `add_shots`, `list_projects`, `open_project`, `new_project`,
`save_project`, `set_project_settings`, `add_subject_mask`, `add_component`,
`set_submask_mode`, `add_mask_keyframe`, `list_mask_keyframes`,
`clear_mask_keyframe`, `clear_mask_keyframes`, `track_subject`, `depth_track`,
`depth_track_status`, `set_mask_adjust`, `apply_haze`, `invert_mask`, `delete_mask`,
`list_relight_lights`, `add_relight_light`, `set_relight_light`,
`delete_relight_light`, `inspect_color`, `sample`, `sample_region`,
`match_to_reference`, `request_human`, `export`.

This is genuinely comprehensive for grading/masks/relight — an agent can drive
essentially the whole Colorist tab today. **Everything below is a real, verified
zero.**

## Edit tab / multi-track NLE — CLOSED, 50 tools (D-183, 2026-09-07; +1, D-191; +2, D-195; +1, D-196; +3, D-211; +1, D-214; +1, D-216; +1, D-218; +4, D-222; +1, D-223; +1, D-224; +4, D-226; +5, D-229; +2, D-230; +2, D-233)

<!-- The count above is the real one, re-counted 2026-09-08 against
     `grep -oE '^def (editor_[a-z_]+|get_timeline|set_clip_fade|set_track_duck)\(' mcp/server.py`
     minus the 4 media-understanding tools listed in their own section below.
     It replaces two contradictory headings (“23 tools” and “22 tools”) that had
     been sitting here as separate lines, both already stale — count it, don't
     increment it. -->


> **The gap tracked below is closed.** D-147 (clip fades) and D-149 (ducking)
> shipped the first three Edit-tab tools; D-183 shipped the other seventeen in one
> pass — read/seek, media import, clip placement/split/trim/move/remove, gap
> removal, track add/gain/lock/hide, compositing transform + per-clip keyframes,
> and a real multi-track export to a video file. See
> `docs/notes/mcp-architecture.md` for the pattern this followed (frontend
> `useEditorControl.ts`'s `editor_*`-prefixed ops, one `@mcp.tool()` wrapper each
> in `mcp/server.py`) and `docs/08-decisions.md`'s D-183 entry for the full story.
>
> `get_timeline`/`set_clip_fade`/`set_track_duck` also moved OUT of
> `useChromaControl.ts` (Colorist's catch-all) into `useEditorControl.ts` proper
> as part of the same pass — same Python tool names, since there was no reason to
> break an existing MCP caller over an internal rename; only the wire op each
> posts to the control server changed (`editor_get_timeline` etc).
>
> | Tool | What it does |
> |---|---|
> | `get_timeline` | Read-only. Every track and clip, with the `index` mutating tools address a clip by and the `id` that survives a reorder. Reports fades + ducking + each clip's own `volume`/`pan` (D-223) and its `eqBands`/`eqActive` (D-224), and (D-222) the timeline's own `markers`. |
> | `editor_get_state` | Read-only. Project-open + WHICH project (`openProject`, B-083)/load-status/playhead/playing/has-timeline, plus the current `selection` (`[{track, id}]`) and `selectedGap` (2026-09-07, B-085 follow-up — selection was previously invisible to everything outside the webview, so a selection bug could only be caught by eyeballing the window), plus `previewZoom` (D-218 — the preview VIEWPORT's own zoom/pan; read it before interpreting a `debug_screenshot` of the preview, since at a non-fit view the picture on screen is a magnified crop of the frame). |
> | `editor_set_playhead` / `editor_set_playing` | Seek / play-pause. |
> | `editor_set_selection` (D-216, 2026-09-08) | The WRITE half of `editor_get_state`'s `selection`/`selectedGap` — `clips=[{track, clip}]` or `[{track, clipId}]` (an array, so the GUI's real D-107 multi-select is reachable; `[]` clears), or `gap={track, frame}`, the two mutually exclusive exactly as in the store (D-105). **Why it matters, given that every editing tool already takes an explicit `track`/`clip` and needs no selection:** the Edit tab has surfaces that exist only FOR a selection — `TransformOverlay`'s on-canvas box and corner handles, and the Inspector's clip form, both gated on EXACTLY ONE clip being selected — and until this op nothing but a human's mouse could reach them, which is why every on-canvas fix (D-136, D-204, B-085, B-092, D-209) had to be verified by the owner clicking, or not at all. Pair it with `debug_screenshot` to actually see the box land. Validates every entry against the live timeline (a bad index or unknown id is a real error, never a stored selection of nothing) and a gap with the same `gapAt` the GUI's own empty-area click uses. **Not undoable** — see below. |
> | `editor_set_preview_zoom` (D-218, 2026-09-08) | Zoom/pan the preview VIEWPORT — `zoom` a multiplier where `1` = fit (0.25–8, clamped with the clamp reported in `note`), `"fit"` to reset zoom AND pan, optional `pan_x`/`pan_y` as fractions of the fitted picture offset from centre (legal range `±(zoom-1)/2`, reported back as `panLimit`). **Display-only — it is NOT a clip's transform**: nothing about the render or the export changes, only how large the frame is drawn on screen. Its use is inspection: at fit the preview is a ~960px-long-edge proxy of the whole frame, so a thin edge or a small title is a handful of pixels in a `debug_screenshot`; zoom to 200-400% and pan first and the same screenshot shows it. `editor_get_state`'s new `previewZoom` block is the read half, and reading it is what makes a preview screenshot interpretable at all (at a non-fit view the picture on screen is a magnified crop of the frame). **Not undoable** — same reasoning as `editor_set_selection`, see below. |
> | `editor_import_media` | Import absolute paths into the shared media pool — the prerequisite for `editor_add_clip`. |
> | `editor_remove_media` (2026-09-07, roadmap item 23) | Remove one or more items from the media pool by id — the pool's only correction mechanism today (no re-probe/expiry yet). Wraps the same `chroma_media_remove` the GUI's Sources panel already used; a clip on the timeline still referencing a removed item keeps playing/exporting fine (`Clip.source_path` is an independent copy, never re-read from the pool), only its `media_id` back-link goes stale — reported back in `stillReferencedBy`. |
> | `editor_add_clip` | Place a pool item on a track, trimmed to a source range. Called once per KEPT segment (not "place then cut a gap") to build a track from a raw recording. |
> | `editor_split_clip` / `editor_remove_clip` / `editor_remove_gap` / `editor_trim_clip` / `editor_move_clip` | The rest of the ripple-edit primitives — no new `EditOp` had to be invented for any of these; every one already existed in `packages/editor/src/timeline.ts`, only the MCP wrapper was missing. |
> | `editor_slip_clip` (D-195) | Slip a clip's SOURCE window in place — `start_frame`/`duration` stay fixed, only `source_start` moves (clamped to the source's own bounds, lockstep with a linked A/V pair). A real, previously-missing `EditOp` (`slip`), not a wrapper around an existing one. |
> | `editor_swap_clip_media` (D-195) | Repoint a clip at different already-imported source media while preserving everything else — transform/keyframes/fades/`link_group` — with `source_start`/`duration` re-clamped (never `start_frame`) if the new source is shorter, and `source_fps` always re-read from the NEW source. A real, previously-missing `EditOp` (`swap_media`); before this, changing a clip's source meant remove-and-re-add, losing every other field. |
> | `editor_add_text_clip` / `editor_set_text_clip` / `editor_text_fonts` (D-211, 2026-09-08) | Real text/title clips — rendered text burned into both the live preview and `editor_export`, so an agent never has to drop to raw `ffmpeg drawtext` for a label or a lower third. A title is an ORDINARY clip on an ORDINARY video track (there is no text track kind), so every other tool above works on it unchanged — move/trim/split/remove/fade, and `editor_set_clip_transform`'s `opacity`/`position_x`/`position_y` with `editor_set_clip_keyframes` animating them. It does NOT support `scale`/`rotation`/`crop_*`/`box_*` in either engine (the export compiles to ffmpeg's `drawtext`, which has none of them) — `editor_set_clip_transform` **refuses** a non-default value for one rather than storing something that renders nothing; a title's size is `editor_set_text_clip`'s own `size`, a fraction of the output frame's HEIGHT. `editor_text_fonts` lists the catalogue keys `font` takes and which of them this machine actually has a file for. Single-line only for now. See `docs/notes/text-title-clips.md`. |
> | `editor_import_subtitles` / `editor_export_subtitles` / `editor_add_caption` / `editor_set_caption` / `editor_set_caption_style` (D-229, 2026-09-08) | Real subtitles/captions, burned into both the live preview and `editor_export`. Unlike a title, a caption lives on its OWN track kind — `editor_add_track` with kind="subtitle" — because it composites over the finished picture whatever its track index and never occludes the video, and because its style belongs to the TRACK (one style for a whole imported file, with `editor_set_caption_style`'s optional `clip` overriding a single cue and `use_track_style=True` clearing that override). `editor_import_subtitles` reads `.srt`/`.vtt` and lands every cue as one undoable step, timed on the project's own frame rate by the backend so it cannot drift from the GUI importer; **TTML/XML/embedded-MXF are refused by name**, not half-parsed (D-229 §4). A caption IS an ordinary `Clip`, so move/trim/split/remove all work on it unchanged — but `editor_set_clip_transform`, fades and opacity do NOT apply (the export is `drawtext`, which cannot scale/rotate/crop a text box); its entire geometry is `editor_set_caption_style`. Caption text MAY be multi-line, which a title's may not. `editor_export_subtitles` writes a sidecar `.srt`/`.vtt` — not needed to get captions into the video, which `editor_export` already does. See `docs/notes/subtitles.md`. |
> | `editor_add_track` / `editor_set_track_gain` / `editor_set_track_locked` / `editor_set_track_hidden` | Track management. `editor_add_track` only ever APPENDS at the highest index (the bottom of the z-order stack, D-086) — see `editor_move_track` for getting a new track above existing footage. |
> | `editor_move_track` (D-214, 2026-09-08, roadmap item 24(e)) | Reorder the track LIST itself — `from_index`/`to_index`, the same `move_track` primitive the GUI's own drag-to-reorder track headers already used (D-094), now exposed to an agent. Closes the gap found live right after text/title clips shipped: `editor_add_track` alone could never get a new track compositing ABOVE existing footage (it only appends at the bottom), so an agent adding a title to a project that already had content had no way to make it visible. Both indices must name an existing track (a clear error otherwise, not a silent no-op); any human GUI selection is remapped to follow its track through the reorder, the same way the GUI's own drag does. |
> | `editor_add_adjustment_clip` / `editor_set_adjustment_clip` (D-230, 2026-09-08, roadmap item 27) | **Adjustment clips** — one colour correction applied top-down to every clip composited BENEATH it, for the span it covers, so an agent grades a whole region of the edit with one clip instead of touching each shot. It is an ORDINARY clip on an ORDINARY video track that contributes no picture of its own, so every other tool above works on it unchanged (move/trim/split/remove). **Which clips it reaches is decided entirely by track index** — it affects every visible video track with a HIGHER index than its own, so `track=0` grades the whole edit and an adjustment clip on the BOTTOM track affects nothing; `editor_add_adjustment_clip`'s result reports what the placed clip actually affects, because that is the one obvious way to get this wrong. Five parameters (`exposure`/`contrast`/`saturation`/`temperature`/`tint`, each -1..1, 0 = no change) — the Edit tab's own primary correction, deliberately NOT the Colorist's grading stack, which is wgpu-shader-only and so could not be reproduced in the ffmpeg export at all (D-230). `editor_set_adjustment_clip` is a PATCH, so changing saturation never resets exposure. Its `opacity` (via `editor_set_clip_transform`) is how strongly the correction mixes in, and is read STATICALLY — keyframing or fading it does NOT animate the correction in either engine, because ffmpeg fixes these filter coefficients at filter init; `position_*`/`scale`/`rotation`/`crop_*` do not apply at all (the correction is full-frame). Two adjustment clips on two tracks compose, lower one first. See `docs/notes/adjustment-clips.md`. |
> | `editor_list_markers` / `editor_add_marker` / `editor_set_marker` / `editor_remove_marker` (D-222, 2026-09-08, roadmap item 27) | Timeline markers — colour-coded, optionally titled flags pinned to a TIMELINE frame. No `track` argument on any of the four, deliberately: a marker belongs to the timeline, not to a clip or a track, so it survives the clip beneath it being trimmed, moved or deleted (`chroma_timeline::Timeline::markers`). `editor_add_marker`'s `frame` defaults to the playhead, matching the GUI's Marker button / `M` shortcut exactly; `color` takes a palette NAME (Resolve's own sixteen — `editor_list_markers` returns the live list) or a raw hex. `editor_set_marker` is a PATCH (an omitted field keeps its value; `""` clears a name/note), and an unrecognised colour is a real error rather than a silent no-change. `editor_get_timeline` reports the same frame-sorted list under its own `markers` key. **Undoable and persisted**, unlike `editor_set_selection`/`editor_set_preview_zoom` below — a marker is document content, not view state. |
> | `editor_list_transitions` / `editor_add_transition` / `editor_set_transition` / `editor_remove_transition` (D-226/D-227, 2026-09-08, roadmap item 27) | Transitions at an edit POINT — the timeline frame where one clip ends and the next begins on the SAME video track. The two clips stay abutting and never overlap; the transition bridges the cut and reads their HANDLE media (D-226), which is why `editor_list_transitions` reports each video track's real `cuts` (where one CAN go — not derivable from the clip list without re-implementing the end==start match) alongside what is already there, and why every transition reports its DERIVED `windowStartFrame`/`windowEndFrame`/`headHandleFrames`/`tailHandleFrames` rather than leaving an agent to redo the centre alignment's integer halving. Two kinds: `cross_dissolve` (needs handle media on both sides) and `dip_to_color` (needs NONE, so it always works). `editor_add_transition`'s `at_frame` defaults to the cut nearest the playhead, the same "act where the user is looking" default `editor_add_marker` takes. `alignment` (`center_at_cut` / `start_at_cut` / `end_at_cut`, Premiere's own names) decides WHICH clip pays for the transition and is the usual fix for insufficient media — a refusal names how many frames are missing and which alignment would fit. `editor_set_transition` is a PATCH and re-validates the MERGED shape (shortening always works, lengthening past the handles is refused with the same message the add path gives); `at_frame` is deliberately NOT patchable, since re-homing a transition would skip the placement checks. `editor_get_timeline` reports the same per-track list under its own `transitions` key, and `editor_get_capabilities` carries the handle/kind reference. **Undoable and persisted** — real `EditOp`s, the identical ones the timeline's own palette drag and badge popover use. |
> | `set_clip_fade` / `set_track_duck` | Unchanged from D-147/D-149 (see above for the internal rename). |
> | `editor_set_clip_audio` (D-223, 2026-09-08, roadmap 27) | One CLIP's own audio level and stereo position — `volume` (linear, `1.0` unity, floored at 0, no ceiling, deliberately the same unit as `editor_set_track_gain` in the same signal chain) and `pan` (`-1` left … `1` right). **Not a replacement for `editor_set_track_gain` and neither replaces the other**: that is the whole track's fader, this is one clip on it, and the mixer multiplies them — `track.gain × clip.volume × fade × duck`, then the pan law splits per channel. Both fields are independently optional (an omitted one is left alone, unlike `editor_set_clip_transform`'s required nine), and both are also KEYFRAMEABLE under the names `"volume"`/`"pan"` via `editor_set_clip_keyframes` — that is how an automation ramp is written. Returns what was actually stored plus the two per-channel gains the pan resolves to and the track's own gain, so a caller can reason about real level without re-deriving the law. The pan law is constant power at a **0 dB centre**, so a hard pan BOOSTS its destination channel 3.01 dB — stated in the tool text because a source already near full scale needs its `volume` lowered on the same call. `get_timeline` reports both fields. |
> | `editor_set_clip_eq` (D-224, 2026-09-08, roadmap 27) | One CLIP's own multi-band parametric EQ — the TONE control, as distinct from `editor_set_clip_audio`'s level and `editor_set_track_gain`'s track fader. **One BAND per call** (`band` 0..3, matching Resolve's own four-band Clip Equalizer, which is what the Inspector authors), with `kind` (`peak` bell / `low_shelf` / `high_shelf` / `high_pass` / `low_pass`), `freq_hz` (20..20k), `gain_db` (±24, ignored by the two pass kinds), `q` (0.1..20) and `enabled` all independently optional — the same partial-write shape `editor_set_clip_audio` has, so a gain nudge can never restate a frequency it never looked at. `clear=True` removes the EQ entirely. A clip with no EQ yet gets the default strip (low shelf 120 Hz / bell 500 Hz / bell 2.5 kHz / high shelf 8 kHz, **all at 0 dB, i.e. completely inert**) materialised on the first call. **STATIC, not keyframeable** — a stated decision, not a gap: ffmpeg's biquad filters parse their parameters once as numbers, so an animated EQ cannot be rendered at all, and this app does not offer a preview it cannot export (split the clip instead). The filters are real Audio EQ Cookbook biquads, applied BEFORE the volume/fade/duck gain stages in both the live mixer and the export, and the export feeds ffmpeg's generic `biquad` filter the SAME coefficients rather than naming its own `bass`/`treble` (whose shelves measurably do not implement the cookbook's Q). Returns what was actually stored, a one-line summary per band, `eqActive` (whether ANY band does something — an all-flat strip does not), and **`responseDb`: the resulting curve in dB at nine standard frequencies**, so a caller can verify the move landed without re-deriving a biquad. `get_timeline` reports `eqBands` + `eqActive`. |
> | `editor_set_clip_transform` | A clip's base position/scale/rotation/crop/opacity, as fractions of the output composition — the stacking/PIP primitive (D-136's normalised-fraction convention). `box_width`/`box_height` (D-193) let a caller size a clip's box on each axis INDEPENDENTLY as a fraction of the output composition — unlike `scale` (a uniform multiplier of the clip's own source resolution, which can only ever produce a box sharing the clip's own aspect ratio), these have no Rust/TS-export parity gap and are the real fix for the same limitation `editor_export`'s `fit_overrides` below works around at export time only. `null` clears a previously-set override (the Python tool's `clear_box_width`/`clear_box_height` booleans, since a bare omitted argument already means "leave it alone" on this tool). |
> | `editor_set_clip_keyframes` | Animates ONE clip's own transform over time (e.g. zoom-in on a click) — scoped to that clip's own local timeline, never the whole track, so two clips on two tracks each zoom at their own moment while both stay visible. |
> | `editor_set_keyframe_ease` (D-233, 2026-09-08, roadmap 27) | Shapes HOW one animated property moves between two of its keyframes — a real cubic-bezier ease on the segment STARTING at the frame you name, not just a named preset. Every segment is LINEAR by default (constant rate, dead stop at the next key), which is usually the single biggest reason a generated move reads as generated. Takes the same preset names / four control points, through the same parser, as `editor_set_clip_fade`'s curves; `curve=None` clears back to linear. Easing warps the RATE only — both endpoints still hit their authored values exactly, so it can never move a keyframe — and `y` outside `0..1` is legal and means real overshoot (anticipation, a bounce). Per property, so the same frame can ease `scale` differently from `opacity`. Refuses, naming the frames that do exist, when the frame is not actually a keyframe of that property. Preview and export interpret the curve identically (the export samples each eased segment into 20 linear steps — ffmpeg has no bezier solver — a MEASURED worst case of 1.4e-3, about a third of one 8-bit step). |
> | `editor_set_curve_editor` (D-233, 2026-09-08) | Opens the GUI's timeline curve editor lane on one clip property's curve, or closes it (`param=None`). **UI state only** — changes what is on screen, saves nothing, undoes nothing, exactly like `editor_set_preview_zoom` (D-218) and outside D-140's subject for the same reason. Its point is the handoff: an agent that has just set an ease with `editor_set_keyframe_ease` can SHOW the human that curve, in the same lane the Inspector's own per-property curve button opens, with its control points draggable. Refuses (naming what IS animated) rather than opening an empty lane for a property the clip does not animate. |
> | `editor_export` | Renders the WHOLE multi-track timeline (composited, cropped, keyframed, speed-adjusted, AND mixed audio, D-197) to a real output file via ffmpeg — the one tool that produces an actual video, everything else only edits in-memory state. `fit_overrides` (D-184, B-074) lets a caller choose per-clip whether `scale` fits the clip's real aspect ratio into its box (`'fit'`, the default) or force-stretches to the canvas's own aspect ratio (`'stretch'`, the pre-D-184 behavior) — read `editor_export`'s own docstring before compositing more than one clip, it explains why `scale` alone can never produce a differently-shaped box than the canvas. **D-197 — audio now mixes in automatically, no new parameter:** every visible audio-track clip's gain/duck/fade PLUS a video clip's own embedded audio (unless A/V-linked or its source isn't known to have audio) sum down to one real output stream, replicating the live mixer's exact semantics. The Edit tab also now has a real GUI Export button/dialog/sequential queue (D-198, `EditorExportDialog.tsx`/`exportQueueStore.ts`) wired through this SAME tool's underlying function — a convenience surface, not a second implementation. |
> | `editor_get_capabilities` (D-191) | Static reference-only tool — no round trip to the app, works with no project open. Hard-won facts an agent would otherwise only learn by reading source or hitting them live: what `scale`/`fit_overrides` really control (a stacking/PIP primitive tied to the CLIP's own aspect ratio by default, not the canvas's — plus the crop-then-scale recipe for an exact half-canvas box), track paint order, per-clip keyframe scoping, the per-property rule that a keyframe silently beats whatever `editor_set_clip_transform` wrote for that property (B-093/D-209 — the same trap the GUI's own on-canvas drag fell into), export's real v1 scope, and B-069/B-070/B-071/B-073's rough edges (B-069 itself is fixed; documented here as a known failure shape worth recognizing if a similar crash recurs elsewhere). |
> | `editor_export_fcpxml` (D-196) | Renders the WHOLE multi-track timeline to a real, DTD-verified **FCPXML 1.7** interchange document (no picture/audio produced) — the "move this edit to DaVinci Resolve / Final Cut Pro" export, a sibling of `editor_export` compiling the SAME `Timeline` model to a different output format (`packages/editor/src/timelineInterchange.ts`, D-183's own pattern). Maps clip placement/trims, track z-order (as fcpxml lanes), transform/crop/opacity, A/V `link_group`, and audio track gain; does NOT export `chroma_keyframes` animation, clip fades, or audio ducking (no verified FCPXML syntax for the first two without guessing, no static equivalent for the third) — every one of these surfaces in the tool's own `warnings` rather than a silent drop. Read `editor_export_fcpxml`'s own docstring and D-196's field-mapping table before relying on round-trip fidelity for anything beyond that list. XMEML/Premiere export is a separate, not-yet-built format — see D-196. |
>
> Every mutating tool goes through `useEditorTimelineStore.applyOp` (or the
> equivalent real store action), so an agent's edit lands on the same undo stack
> a human's does — D-140's rule, restated in `mcp-architecture.md`.
>
> **`editor_set_selection` and `editor_set_preview_zoom` are the two tools that
> deliberately push nothing onto
> that stack** (D-216, D-218), and neither is an exception to D-140 so much as outside
> its subject: `selection`/`selectedGap`/`previewView` are fields of the STORE, not of
> `Timeline`, so D-051's whole-`Timeline` undo snapshots have never carried
> them, nothing persists them to `project.json`, and every GUI path that writes
> them (`TimelinePane`'s clip click, its marquee, its gap click,
> `useCanvasClipPick`; the preview's own zoom buttons and ctrl-wheel) pushes
> nothing either. An MCP selection or zoom that WAS undoable would behave
> differently from the identical human click and would sit between the user and
> their last real edit on the next cmd-Z. Both drive the same store actions
> those paths call, which is the half of D-140 that does apply.

**Net effect: an agent can now drive essentially the whole Edit tab** — import
media, assemble a track from raw footage (cut gaps/retakes by only placing the
segments to keep), split/trim/move/remove clips, manage tracks, composite/stack
multiple video tracks with per-clip keyframed zooms, and render the result to a
file with its real mixed audio (D-197 — gain/duck/fade and embedded-audio
inclusion, no longer a silent video).

## Edit tab: media understanding — CLOSED, 4 tools (D-189, 2026-09-07)

> **What an agent could not do before this**, even with all 20 tools above: know
> what is actually IN the footage. It could cut a timeline precisely and had no
> way to decide *where* to cut, because nothing exposed the content of a file —
> only its structure. That is what these close. Scope + the dependency-isolation
> spike: `docs/notes/media-understanding-sidecar-scope.md`; the decision, D-189.
>
> | Tool | What it does |
> |---|---|
> | `editor_get_transcript` | Start a word-level transcript (mlx-whisper large-v3) — "what was SAID, and when." Per-word `start`/`end` in source seconds, i.e. enough to cut to an exact word. |
> | `editor_get_transcript_status` | Poll it. `state` is `running` / `done` (result attached) / `idle`. |
> | `editor_analyze_video` | Start a visual analysis — "what CHANGED on screen, and when." ffmpeg scene-detect supplies the (exact, deterministic) timing; Qwen3-VL only describes a before/after frame pair at each moment. |
> | `editor_analyze_video_status` | Poll it. Carries `truncated` — candidates hit the cap and were dropped, so raise `max_candidates` and re-run. |
>
> **The two capabilities are complementary, not alternatives**, and an agent must
> pick by content rather than by default: the transcript finds nothing in silent
> or music-only footage; the analysis finds nothing in a single continuous uncut
> shot (a talking head has no visual delta to key off). Both tool docstrings say
> so explicitly.
>
> **Why four tools and not two** (the scope doc sketched two): `chroma::control`'s
> `BRIDGE_TIMEOUT` is 20 s, and these jobs run for tens of seconds (transcript) to
> minutes (analysis, roughly 4x realtime). A blocking tool would 504 every time
> and the answer would never reach a caller. Start-then-poll is the same shape
> `depth_track`/`depth_track_status` already uses, for the same reason.
>
> These are also the one deliberate exception to
> `mcp-architecture.md`'s "a mutating tool goes through the same store action a
> GUI click does": they mutate nothing. They ask the `ai-media/` sidecar about a
> file on disk and cache the answer by path, so there is no undo history to
> preserve. Results are cached, so a repeat ask returns `state: "done"`
> immediately; `force=True` re-runs.

## Gap: Motion tab — 0 tools

`chroma_motion_get_manifest` / `chroma_motion_save_manifest` / `chroma_motion_render`
— no MCP tool touches any of these. An agent cannot read, edit, save, or render a
Motion scene manifest today, despite the whole `/animate` skill workflow (in the
*other* repo, `videoAgent`, this app is the target for) being built around an
agent authoring exactly this kind of manifest. This is arguably the highest-value
gap to close, if/when this is picked up — it's the one place "an agent driving
this app" and "the manifest-authoring workflow this app is *for*" directly meet.
D-081's new `LayerList`/`Selection` (Motion tab) has no MCP surface either. That
was dismissed here as "a pure UI-navigation concept"; **D-216 is the correction
to that reasoning for the Edit tab**, and the same caveat applies to Motion:
selection stops being pure navigation the moment a surface renders ONLY for a
selection (the Edit tab's on-canvas transform box did, and was unreachable for
it). Worth re-checking against Motion's own selection-gated UI when this is
picked up — the manifest get/save/render triad is still the bigger, more
load-bearing gap.

## Gap: Media / Sources pool — 2 of 6 tools (D-183 added import; `_remove` closed 2026-09-07)

`editor_import_media` (D-183) covers `chroma_media_import`'s job — importing
absolute paths into the pool. `editor_remove_media` (roadmap item 23,
2026-09-07) now covers `chroma_media_remove` too — the pool's only
correction mechanism today: an agent can delete a stuck/wrong item (a probe
that failed once, B-073/B-089) and re-import the same path for a fresh probe.
There is still no re-probe-on-demand/expiry (item 23's real architectural gap
remains open — this closes the tool-exposure gap only, not the underlying
"why did this go stale" problem).

`chroma_media_list` / `_move` / `_create_folder` / `_folders` still have no
MCP tool: an agent can't query what's already in the pool or organize it into
folders, independent of Colorist's own `list_shots`/`add_shots`
(project-timeline-scoped, not pool-scoped — a real, different thing). This
gap has a real, live-witnessed cost, not just a theoretical one: B-073
(`docs/BUGS.md`) is a media-pool item stuck with no `video` metadata after a
transient probe failure — as of `editor_remove_media` it can at least be
cleared and re-imported via MCP, but it still cannot be *inspected* via MCP
(no `chroma_media_list`) to confirm which item is the bad one before removing
it; the session that hit it had to read `project.json` by hand.
`editor_get_capabilities` (D-191) documents this as a known landmine.

## Gap: Audio playback — 0 tools, lowest priority

`chroma_audio_play` / `_stop` / `_level` / `_waveform` — playback transport
control. Lower value for an agent than the above (an agent driving edits doesn't
obviously need to literally press play), but genuinely zero coverage; noted for
completeness rather than urgency.

## Debug / UI verification — CLOSED, 8 tools (D-210 + D-219, 2026-09-08)

`debug_screenshot`, `debug_sample_pixel`. Not a *product* capability like
everything above — an agent-tooling one, and the reason it belongs in this doc
is that its absence was silently taxing every other entry here: an agent could
drive the whole Colorist and Edit surface through MCP but could not **look** at
the result, because macOS's Screen Recording permission blocks `screencapture`
for this process. `debug_screenshot` makes the window's WKWebView photograph
itself (no such permission involved — it is not screen capture); the workflow is
*call it → `Read` the returned path → actually see the UI*. `debug_sample_pixel`
reads one pixel's RGBA out of a saved shot, for a colour/alignment claim.

These two are the first ops answered by the control server **itself** in Rust
(`native_op` in `control.rs`) rather than forwarded to a frontend `OPS` entry —
see `docs/notes/debug-screenshot-tool.md` for why, and for the real limits
(webview only, device pixels, macOS only).

**D-219 added the other six**, which is what turns "look at the app" into a
loop that actually closes — drive a state change, photograph it, then check the
DOM behind the pixels:

| tool | what it does |
| --- | --- |
| `debug_ui_state` | active tab, Sources panel, Edit Inspector, selection/playhead, and every dialog the DOM has open. The read half of the four below. |
| `debug_set_active_tab` | Edit / Motion / Colorist, through `useShellStore.setActiveTab` — the function the tab button's own onClick calls. |
| `debug_set_sources_panel` | the shell's docked Sources column, through its own store action. |
| `debug_set_editor_inspector` | the Edit tab's Inspector column, ditto. |
| `debug_dom_tree` | bounded JSON of the real DOM under a selector: hierarchy, semantic attributes, `getBoundingClientRect()`, chosen computed styles. The "why is it positioned like that" answer a screenshot cannot give. |
| `debug_frame_timing` | the preview's real rAF/paint intervals — the webview-side smoothness measurement D-217 needed and had no way to take. |

Unlike D-210's pair these are **frontend** ops (`@chroma/debug`'s registry,
prefix `debug_`), because driving UI state means calling the same store action
the human's click calls — that is D-219's central decision, and it is why none
of them synthesises a click or takes a pixel coordinate.

All seven are **dev-build only** — internal debug tooling is never shipped
(CLAUDE.md). Rust: `#[cfg(debug_assertions)]` (B-100 fixed the two D-210
commands, which had been ungated). Frontend: `import.meta.env.DEV` plus a
dynamic import, so the registry is dropped from a production bundle. Scope,
status and the live verification loop: `docs/notes/debug-tooling.md`.

## When shipping something new (going forward)

Before calling a new capability "done," check: does this need an MCP tool, and if
so is one actually built? If not, add a line to whichever gap section above it
belongs in (or a new section if it's a new area entirely) rather than letting this
doc silently drift out of date the way the roadmap's own "In flight" tracker would
if nobody touched it after the work landed.
