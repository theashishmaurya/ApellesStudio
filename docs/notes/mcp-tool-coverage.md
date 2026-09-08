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

## Edit tab / multi-track NLE — CLOSED, 60 tools (D-183, 2026-09-07; +1, D-191; +2, D-195; +1, D-196; +3, D-211; +1, D-214; +1, D-216; +1, D-218; +4, D-222; +1, D-223; +1, D-224; +4, D-226; +5, D-229; +2, D-230; +2, D-232; +2, D-233; +1, D-234; +1, D-236; +1, D-238; +1, D-239; +2, D-243)

> **Count re-verified 2026-09-08, after merging D-238 (auto-captioning), D-239
> (seven edit types) AND D-243 (caption preset library) into main, directly
> against the merged `mcp/server.py`**:
> `grep -cE '^def (editor_[a-z_]+|get_timeline|set_clip_fade|set_track_duck|set_clip_speed)\(' mcp/server.py`
> returns 64, minus the 4 media-understanding tools (`editor_get_transcript`,
> `editor_get_transcript_status`, `editor_analyze_video`,
> `editor_analyze_video_status`) that have their own section below, is **60**.
>
> **Why two more branches each reported a different number first, and why
> neither was wrong for its own moment.** D-239's own branch (before D-238
> landed) correctly predicted "58" for the D-238+D-239 merge, which the note
> below confirmed; D-243's branch was cut before either had landed, so its own
> heading said 56 (+2 for its own two new tools) against the same pre-D-239
> counting-bug grep D-239 itself found and fixed. Three branches touching the
> same running total is the same scenario as before, one number larger: count
> against the final merged file, don't try to reconcile stale numbers.
>
> Earlier headings independently recomputed this total mid-merge (48, 50, 53,
> 56, 57, 58) from partial views; all are superseded. The `+N` breakdown is
> the historical log its authors wrote and has not been re-audited entry by
> entry; treat the total as authoritative and the breakdown as provenance.

<!-- The count above is the real one, re-counted 2026-09-08 (D-239) against
     `grep -cE '^def (editor_[a-z_]+|get_timeline|set_clip_fade|set_track_duck|set_clip_speed)\(' mcp/server.py`
     minus the 4 media-understanding tools listed in their own section below.
     `set_clip_speed` was added to that alternation by D-239 — it is an Edit-tab
     tool without the `editor_` prefix, exactly like the three before it, and
     was being silently missed. If a future Edit tool lands without the prefix,
     add it here too or this count goes quietly wrong again.
     It replaces contradictory headings (“23 tools” and “22 tools”) that had
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
> | `editor_edit_in` (D-239, 2026-09-08, roadmap item 27) | **The seven edit types**, and the difference between this and `editor_add_clip` above is the difference between an EDIT and a placement: `editor_add_clip` puts a clip at a position, this performs one of `insert` / `overwrite` / `replace` / `fit_to_fill` / `place_on_top` / `append` / `ripple_overwrite` at the playhead, on the destination track. Insert splits what the playhead is inside and pushes everything after it down; overwrite writes over it and moves nothing; replace and fit_to_fill both take the exact slot of the clip under the playhead (the first by re-cutting the source, the second by giving it a flat D-236 speed ramp calculated to fit); place_on_top goes on the next video track ABOVE, creating a new topmost one if needed; ripple_overwrite swaps the clip under the playhead at a different length and ripples the difference. One `edit_in` `EditOp`, one undo entry named for the type, and a real `error` sentence (from the shared `checkEditIn`) rather than a silent no-op whenever it is refused. GUI: drag a Sources item over the preview and drop it on one of the seven overlay targets. **`place_on_top` can create a track at index 0, which shifts every other track's index** — re-read `editor_get_state` afterwards; the response's own `track`/`trackCount` say whether it happened. |
> | `editor_split_clip` / `editor_remove_clip` / `editor_remove_gap` / `editor_trim_clip` / `editor_move_clip` | The rest of the ripple-edit primitives — no new `EditOp` had to be invented for any of these; every one already existed in `packages/editor/src/timeline.ts`, only the MCP wrapper was missing. |
> | `editor_slip_clip` (D-195; GUI gesture D-235) | Slip a clip's SOURCE window in place — `start_frame`/`duration` stay fixed, only `source_start` moves (clamped to the source's own bounds, lockstep with a linked A/V pair). A real, previously-missing `EditOp` (`slip`), not a wrapper around an existing one. **Shipped MCP-only for two days with no human affordance at all** — the human-AND-AI gap from the AI side, closed by D-235's Alt-drag on a clip's upper half. |
> | `editor_trim_clip`'s `ripple` (D-235, 2026-09-08, roadmap item 27) | The trim tool's ripple mode. Default `False` is the pre-D-235 behaviour byte for byte (only this clip changes; shortening leaves a real gap, extending is refused if a neighbour blocks it — D-058's non-rippling-by-construction model). `True` shifts everything after this clip on the SAME track to follow its new out point, so no gap opens and a blocking neighbour is pushed rather than refusing the trim; a HEAD ripple leaves `start_frame` where it is and pulls the rest of the track in behind it. Not a new op kind — it is the same `ripple` flag `editor_add_clip`/`editor_move_clip` already carry, over the same single ripple-shift primitive, so sync-locked tracks ripple with it and a clip straddling the ripple point on one of them refuses the whole op rather than being split (B-033). |
> | `editor_roll_edit` (D-235, 2026-09-08, roadmap item 27) | **Roll** the edit point at the END of `clip`: the outgoing clip's out point and the incoming clip's in point move together by the same delta, so one side gains exactly what the other loses and the sequence's total duration does not change — which is what separates it from a ripple. `clip` names the OUTGOING side (the clip BEFORE the cut), and there must be a clip butted exactly against its end: across a gap there is no edit point and the call does nothing. Clamped to whichever side runs out of source first; A/V link groups on both sides roll in lockstep or the op is refused whole. A genuinely new `EditOp`. GUI: Alt-drag an edge that IS an edit point. |
> | `editor_slide_clip` (D-235, 2026-09-08, roadmap item 27) | **Slide** a clip along the timeline without changing its own duration or its source window — its neighbours absorb the movement (the one before at its out point, the one after at its in point). "A slide is a roll between 3 clips." The three neighbouring tools are easy to confuse and are genuinely different: `editor_move_clip` changes WHERE the clip is and leaves neighbours alone (opening/closing real gaps); `editor_slip_clip` changes WHAT it shows and moves nothing; a slide changes only where it sits between untouched cuts. A side with no touching neighbour is clamped by the real free space there, so it still works at the head or tail of a track; refused if there is neither a neighbour nor an obstacle on either side, since that is a plain move. A genuinely new `EditOp`. GUI: Alt-drag the LOWER half of a clip's body. |
> | `editor_swap_clip_media` (D-195) | Repoint a clip at different already-imported source media while preserving everything else — transform/keyframes/fades/`link_group` — with `source_start`/`duration` re-clamped (never `start_frame`) if the new source is shorter, and `source_fps` always re-read from the NEW source. A real, previously-missing `EditOp` (`swap_media`); before this, changing a clip's source meant remove-and-re-add, losing every other field. |
> | `editor_add_text_clip` / `editor_set_text_clip` / `editor_text_fonts` (D-211, 2026-09-08) | Real text/title clips — rendered text burned into both the live preview and `editor_export`, so an agent never has to drop to raw `ffmpeg drawtext` for a label or a lower third. A title is an ORDINARY clip on an ORDINARY video track (there is no text track kind), so every other tool above works on it unchanged — move/trim/split/remove/fade, and `editor_set_clip_transform`'s `opacity`/`position_x`/`position_y` with `editor_set_clip_keyframes` animating them. It does NOT support `scale`/`rotation`/`crop_*`/`box_*` in either engine (the export compiles to ffmpeg's `drawtext`, which has none of them) — `editor_set_clip_transform` **refuses** a non-default value for one rather than storing something that renders nothing; a title's size is `editor_set_text_clip`'s own `size`, a fraction of the output frame's HEIGHT. `editor_text_fonts` lists the catalogue keys `font` takes and which of them this machine actually has a file for. `editor_add_text_clip`/`editor_set_text_clip` also take `bold`/`italic` booleans (D-240) that compose the right catalogue key on top of `font` without the caller needing to know the raw string — a family with no such face (`impact`/`sans-black`) just ignores whichever toggle it cannot honour. Single-line only for now. See `docs/notes/text-title-clips.md`. |
> | `editor_import_subtitles` / `editor_export_subtitles` / `editor_add_caption` / `editor_set_caption` / `editor_set_caption_style` (D-229, 2026-09-08) | Real subtitles/captions, burned into both the live preview and `editor_export`. Unlike a title, a caption lives on its OWN track kind — `editor_add_track` with kind="subtitle" — because it composites over the finished picture whatever its track index and never occludes the video, and because its style belongs to the TRACK (one style for a whole imported file, with `editor_set_caption_style`'s optional `clip` overriding a single cue and `use_track_style=True` clearing that override). `editor_import_subtitles` reads `.srt`/`.vtt` and lands every cue as one undoable step, timed on the project's own frame rate by the backend so it cannot drift from the GUI importer; **TTML/XML/embedded-MXF are refused by name**, not half-parsed (D-229 §4). A caption IS an ordinary `Clip`, so move/trim/split/remove all work on it unchanged — but `editor_set_clip_transform`, fades and opacity do NOT apply (the export is `drawtext`, which cannot scale/rotate/crop a text box); its entire geometry is `editor_set_caption_style`. Caption text MAY be multi-line, which a title's may not. `editor_import_subtitles`/`editor_set_caption_style` also take `bold`/`italic` booleans (D-240), the same composition `editor_set_text_clip`'s use. `editor_export_subtitles` writes a sidecar `.srt`/`.vtt` — not needed to get captions into the video, which `editor_export` already does. See `docs/notes/subtitles.md`. |
> | `editor_list_caption_presets` / `editor_add_caption_preset` (D-243, 2026-09-08, roadmap item 28) | **Styled caption presets**, and the animation half of `editor_set_caption_style` below. `editor_list_caption_presets` returns the library the Edit tab's own Captions panel shows — id, label, tone group, description, animation kind, provenance note and the full style each would apply. `editor_add_caption_preset` applies one and, by default, drops a caption so the look is immediately visible; it finds or CREATES the subtitle track it needs, so it is a single call from an empty timeline to a styled, animated caption (`place_caption=False` restyles a track that already has cues). **A preset is not an object** — it is a `CaptionStyle`, written through the same `set_caption_style` op the Inspector uses, which is exactly why everything it sets stays editable afterwards and why the whole thing is one undo step. `editor_set_caption_style` gains `animation` ("none" | "highlight" | "karaoke" | "slam" | "build"), the three per-word colours, the highlight box's colour/opacity/padding, and `enter_secs`/`enter_rise`/`word_gap`; the per-word colours take the literal string `"default"` to CLEAR back to the caption's own colour, since omitting an argument means "leave alone" and clearing an accent is otherwise unreachable. An animated caption is drawn word by word, with word timings DERIVED from each word's length across the cue (a `.srt` carries none). **Per-word scale is deliberately absent**, along with rounded and fading highlight boxes: ffmpeg's `fontsize` is the input to the very measurement that makes the preview and the export agree (D-212), and `drawbox` has neither a corner radius nor a per-frame alpha expression — so offering any of them would be a preview the export cannot reproduce. See `docs/notes/caption-presets.md`, and D-243 for the 11 catalogue looks NOT built and why. |
> | `editor_add_track` / `editor_set_track_gain` / `editor_set_track_locked` / `editor_set_track_hidden` | Track management. `editor_add_track` APPENDS at the highest index (the bottom of the z-order stack, D-086) unless given an `index` (B-115, 2026-09-08): `index=0` puts the new track at the TOP of the stack, above all existing footage — what a title, an overlay or an adjustment clip wants — by running the same `add_track` + `move_track` pair the human's own drag-a-clip-above-the-top-track gesture runs. Out of `0..len(tracks)` is refused with an error rather than silently appending. `editor_move_track` remains the tool for reordering tracks that already exist. |
> | `editor_move_track` (D-214, 2026-09-08, roadmap item 24(e)) | Reorder the track LIST itself — `from_index`/`to_index`, the same `move_track` primitive the GUI's own drag-to-reorder track headers already used (D-094), now exposed to an agent. Closes the gap found live right after text/title clips shipped: `editor_add_track` alone could never get a new track compositing ABOVE existing footage (it only appends at the bottom), so an agent adding a title to a project that already had content had no way to make it visible. Both indices must name an existing track (a clear error otherwise, not a silent no-op); any human GUI selection is remapped to follow its track through the reorder, the same way the GUI's own drag does. |
> | `editor_add_adjustment_clip` / `editor_set_adjustment_clip` (D-230, 2026-09-08, roadmap item 27) | **Adjustment clips** — one colour correction applied top-down to every clip composited BENEATH it, for the span it covers, so an agent grades a whole region of the edit with one clip instead of touching each shot. It is an ORDINARY clip on an ORDINARY video track that contributes no picture of its own, so every other tool above works on it unchanged (move/trim/split/remove). **Which clips it reaches is decided entirely by track index** — it affects every visible video track with a HIGHER index than its own, so `track=0` grades the whole edit and an adjustment clip on the BOTTOM track affects nothing; `editor_add_adjustment_clip`'s result reports what the placed clip actually affects, because that is the one obvious way to get this wrong. Five parameters (`exposure`/`contrast`/`saturation`/`temperature`/`tint`, each -1..1, 0 = no change) — the Edit tab's own primary correction, deliberately NOT the Colorist's grading stack, which is wgpu-shader-only and so could not be reproduced in the ffmpeg export at all (D-230). `editor_set_adjustment_clip` is a PATCH, so changing saturation never resets exposure. Its `opacity` (via `editor_set_clip_transform`) is how strongly the correction mixes in, and is read STATICALLY — keyframing or fading it does NOT animate the correction in either engine, because ffmpeg fixes these filter coefficients at filter init; `position_*`/`scale`/`rotation`/`crop_*` do not apply at all (the correction is full-frame). Two adjustment clips on two tracks compose, lower one first. See `docs/notes/adjustment-clips.md`. |
> | `editor_list_markers` / `editor_add_marker` / `editor_set_marker` / `editor_remove_marker` (D-222, 2026-09-08, roadmap item 27) | Timeline markers — colour-coded, optionally titled flags pinned to a TIMELINE frame. No `track` argument on any of the four, deliberately: a marker belongs to the timeline, not to a clip or a track, so it survives the clip beneath it being trimmed, moved or deleted (`chroma_timeline::Timeline::markers`). `editor_add_marker`'s `frame` defaults to the playhead, matching the GUI's Marker button / `M` shortcut exactly; `color` takes a palette NAME (Resolve's own sixteen — `editor_list_markers` returns the live list) or a raw hex. `editor_set_marker` is a PATCH (an omitted field keeps its value; `""` clears a name/note), and an unrecognised colour is a real error rather than a silent no-change. `editor_get_timeline` reports the same frame-sorted list under its own `markers` key. **Undoable and persisted**, unlike `editor_set_selection`/`editor_set_preview_zoom` below — a marker is document content, not view state. |
> | `editor_list_transitions` / `editor_add_transition` / `editor_set_transition` / `editor_remove_transition` (D-226/D-227, 2026-09-08, roadmap item 27) | Transitions at an edit POINT — the timeline frame where one clip ends and the next begins on the SAME video track. The two clips stay abutting and never overlap; the transition bridges the cut and reads their HANDLE media (D-226), which is why `editor_list_transitions` reports each video track's real `cuts` (where one CAN go — not derivable from the clip list without re-implementing the end==start match) alongside what is already there, and why every transition reports its DERIVED `windowStartFrame`/`windowEndFrame`/`headHandleFrames`/`tailHandleFrames` rather than leaving an agent to redo the centre alignment's integer halving. Two kinds: `cross_dissolve` (needs handle media on both sides) and `dip_to_color` (needs NONE, so it always works). `editor_add_transition`'s `at_frame` defaults to the cut nearest the playhead, the same "act where the user is looking" default `editor_add_marker` takes. `alignment` (`center_at_cut` / `start_at_cut` / `end_at_cut`, Premiere's own names) decides WHICH clip pays for the transition and is the usual fix for insufficient media — a refusal names how many frames are missing and which alignment would fit. `editor_set_transition` is a PATCH and re-validates the MERGED shape (shortening always works, lengthening past the handles is refused with the same message the add path gives); `at_frame` is deliberately NOT patchable, since re-homing a transition would skip the placement checks. `editor_get_timeline` reports the same per-track list under its own `transitions` key, and `editor_get_capabilities` carries the handle/kind reference. **Undoable and persisted** — real `EditOp`s, the identical ones the timeline's own palette drag and badge popover use. |
> | `set_clip_fade` / `set_track_duck` | Unchanged from D-147/D-149 (see above for the internal rename). |
> | `editor_set_clip_audio` (D-223, 2026-09-08, roadmap 27) | One CLIP's own audio level and stereo position — `volume` (linear, `1.0` unity, floored at 0, no ceiling, deliberately the same unit as `editor_set_track_gain` in the same signal chain) and `pan` (`-1` left … `1` right). **Not a replacement for `editor_set_track_gain` and neither replaces the other**: that is the whole track's fader, this is one clip on it, and the mixer multiplies them — `track.gain × clip.volume × fade × duck`, then the pan law splits per channel. Both fields are independently optional (an omitted one is left alone, unlike `editor_set_clip_transform`'s required nine), and both are also KEYFRAMEABLE under the names `"volume"`/`"pan"` via `editor_set_clip_keyframes` — that is how an automation ramp is written. Returns what was actually stored plus the two per-channel gains the pan resolves to and the track's own gain, so a caller can reason about real level without re-deriving the law. The pan law is constant power at a **0 dB centre**, so a hard pan BOOSTS its destination channel 3.01 dB — stated in the tool text because a source already near full scale needs its `volume` lowered on the same call. `get_timeline` reports both fields. |
> | `editor_set_clip_eq` (D-224, 2026-09-08, roadmap 27) | One CLIP's own multi-band parametric EQ — the TONE control, as distinct from `editor_set_clip_audio`'s level and `editor_set_track_gain`'s track fader. **One BAND per call** (`band` 0..3, matching Resolve's own four-band Clip Equalizer, which is what the Inspector authors), with `kind` (`peak` bell / `low_shelf` / `high_shelf` / `high_pass` / `low_pass`), `freq_hz` (20..20k), `gain_db` (±24, ignored by the two pass kinds), `q` (0.1..20) and `enabled` all independently optional — the same partial-write shape `editor_set_clip_audio` has, so a gain nudge can never restate a frequency it never looked at. `clear=True` removes the EQ entirely. A clip with no EQ yet gets the default strip (low shelf 120 Hz / bell 500 Hz / bell 2.5 kHz / high shelf 8 kHz, **all at 0 dB, i.e. completely inert**) materialised on the first call. **STATIC, not keyframeable** — a stated decision, not a gap: ffmpeg's biquad filters parse their parameters once as numbers, so an animated EQ cannot be rendered at all, and this app does not offer a preview it cannot export (split the clip instead). The filters are real Audio EQ Cookbook biquads, applied BEFORE the volume/fade/duck gain stages in both the live mixer and the export, and the export feeds ffmpeg's generic `biquad` filter the SAME coefficients rather than naming its own `bass`/`treble` (whose shelves measurably do not implement the cookbook's Q). Returns what was actually stored, a one-line summary per band, `eqActive` (whether ANY band does something — an all-flat strip does not), and **`responseDb`: the resulting curve in dB at nine standard frequencies**, so a caller can verify the move landed without re-deriving a biquad. `get_timeline` reports `eqBands` + `eqActive`. |
> | `editor_set_clip_speed` (D-236 + D-241/D-242, 2026-09-08, roadmap 27) | **Retimes a clip — a flat speed change, or a real SPEED RAMP that varies over its length.** Exactly one of `speed` (one multiplier for the whole clip) or `points` (a list of `{source_frame, speed}`, each meaning "from this SOURCE frame onward, play at this rate"). **A flat speed IS a one-segment ramp** — `speed=2` and a single point at the in-point are the same edit and store identically, so there is no second mechanism to learn; this GENERALISES `editor_export`'s `speed_overrides` rather than sitting beside it, and a clip carrying its own ramp IGNORES its `speed_overrides` entry (precedence, not composition — multiplying would match neither the preview nor the dialog's own number). Points sit on ABSOLUTE source frames, the same space as `source_start` and a keyframe's `frame`, which is what makes a ramp survive a later trim: the speed stays on the moment in the footage you put it on, and a point scrolled outside the trim window still governs the head. Range 0.05–20, **refused rather than clamped** so a typo cannot silently retime to something else. Unlike `speed_overrides` this is a real persisted `Clip.speed_points` the LIVE PREVIEW honours frame-for-frame — proved against real decoded pixels, not argv (`speedRamp.ffmpeg.test.ts`). Picture and sound are retimed together with pitch preserved (per-segment `atrim`/`atempo`/`concat`), and the clip's own fades and volume/pan automation follow the retime — a key stays on the source moment it was authored against. **It changes the clip's LENGTH but not its `start_frame`, and does NOT ripple**: speeding a clip up opens a gap you close yourself (`editor_remove_gap` / `editor_move_clip`), matching Resolve with ripple off. Returns the stored points, the RESOLVED segments (what actually plays — after a trim some of your points may no longer bite), and source vs. output length. **Reverse (D-241) is supported, per RUN**: a NEGATIVE speed plays that run backwards (`-1` = backwards at recorded rate, `-2` = backwards at double speed), so a ramp can mix directions, and reversing never changes how long a run occupies — flipping a sign cannot move the clip out-point or a neighbour. Magnitude 0.05-20 either sign; `0` is refused (not slow, just frozen). Reverse costs real memory at export (ffmpeg buffers the reversed run's frames, bounded to that run rather than the source file). One asymmetry stated on the tool itself: the EXPORT preserves pitch, the LIVE PREVIEW varispeeds (D-242), so a sped-up clip previews chipmunked and a reversed one previews backwards, like tape — timing matches either way. Not supported, deliberately: smoothed S-curve transitions (approximate with more points), and a speed change on a clip a transition joins (the export refuses that combination with a named reason). Same op and same undo stack as the Inspector's own Speed section. |
> | `editor_set_clip_transform` | A clip's base position/scale/rotation/crop/opacity, as fractions of the output composition — the stacking/PIP primitive (D-136's normalised-fraction convention). `box_width`/`box_height` (D-193) let a caller size a clip's box on each axis INDEPENDENTLY as a fraction of the output composition — unlike `scale` (a uniform multiplier of the clip's own source resolution, which can only ever produce a box sharing the clip's own aspect ratio), these have no Rust/TS-export parity gap and are the real fix for the same limitation `editor_export`'s `fit_overrides` below works around at export time only. `null` clears a previously-set override (the Python tool's `clear_box_width`/`clear_box_height` booleans, since a bare omitted argument already means "leave it alone" on this tool). |
> | `editor_set_clip_keyframes` | Animates ONE clip's own transform over time (e.g. zoom-in on a click) — scoped to that clip's own local timeline, never the whole track, so two clips on two tracks each zoom at their own moment while both stay visible. |
> | `editor_set_keyframe_ease` (D-233, 2026-09-08, roadmap 27) | Shapes HOW one animated property moves between two of its keyframes — a real cubic-bezier ease on the segment STARTING at the frame you name, not just a named preset. Every segment is LINEAR by default (constant rate, dead stop at the next key), which is usually the single biggest reason a generated move reads as generated. Takes the same preset names / four control points, through the same parser, as `editor_set_clip_fade`'s curves; `curve=None` clears back to linear. Easing warps the RATE only — both endpoints still hit their authored values exactly, so it can never move a keyframe — and `y` outside `0..1` is legal and means real overshoot (anticipation, a bounce). Per property, so the same frame can ease `scale` differently from `opacity`. Refuses, naming the frames that do exist, when the frame is not actually a keyframe of that property. Preview and export interpret the curve identically (the export samples each eased segment into 20 linear steps — ffmpeg has no bezier solver — a MEASURED worst case of 1.4e-3, about a third of one 8-bit step). |
> | `editor_set_curve_editor` (D-233, 2026-09-08) | Opens the GUI's timeline curve editor lane on one clip property's curve, or closes it (`param=None`). **UI state only** — changes what is on screen, saves nothing, undoes nothing, exactly like `editor_set_preview_zoom` (D-218) and outside D-140's subject for the same reason. Its point is the handoff: an agent that has just set an ease with `editor_set_keyframe_ease` can SHOW the human that curve, in the same lane the Inspector's own per-property curve button opens, with its control points draggable. Refuses (naming what IS animated) rather than opening an empty lane for a property the clip does not animate. |
> | `editor_set_dynamic_zoom` (D-234, 2026-09-08, roadmap item 27) | **Push in or pull out across a whole clip by naming where it is framed at each end** — the one-call version of what would otherwise be a hand-computed keyframe list, and the agent half of the Edit viewer's green/red Dynamic Zoom boxes. `start`/`end` are `{position_x, position_y, scale}` in the SAME units as `editor_set_clip_transform`, and everything is optional with useful defaults: an omitted `start` is the clip's current framing at its first frame, an omitted `end` is that pushed in 1.2x, and an omitted FIELD inside either falls back to that end's own value (so `end={"scale": 1.4}` zooms without recentring the shot). `ease` is one of the four `FADE_PRESETS` (`linear` default, `ease-in`, `ease-out`, `ease-in-out`). **What it writes is ordinary keyframes** — there is no separate dynamic-zoom object, so once written it is indistinguishable from keys posted through `editor_set_clip_keyframes`, which is exactly why both renderers already handle it and a human can Cmd+Z it (D-234). `linear` writes two keys; any other ease is baked into ~21, because the keyframe model interpolates linearly between keys on both sides of the wire and sampling is the only ease BOTH engines reproduce. **Replaces, does not append:** existing `position_x`/`position_y`/`scale` keys are dropped first (a dynamic zoom spans the whole clip, so two overlapping animations of the same properties would be meaningless), while every OTHER animated property — opacity, rotation, crop, volume, pan — is left untouched. Refused on a text clip (its `scale` is pinned by both renderers) and an adjustment clip (full-frame, no geometry), per B-053's refuse-don't-silently-drop rule. Returns the framings actually used, the span, the keyframe count, and `animates` — false when the two framings came out identical, i.e. you wrote a hold rather than a zoom. It also arms the viewer's own boxes on that clip, so a human sees what you authored on the surface they would have used. Runs the SAME `applyDynamicZoom` and the SAME op the on-canvas drag commits through — one code path, two entry points. |
> | `editor_export` | Renders the WHOLE multi-track timeline (composited, cropped, keyframed, speed-adjusted, AND mixed audio, D-197) to a real output file via ffmpeg — the one tool that produces an actual video, everything else only edits in-memory state. `fit_overrides` (D-184, B-074) lets a caller choose per-clip whether `scale` fits the clip's real aspect ratio into its box (`'fit'`, the default) or force-stretches to the canvas's own aspect ratio (`'stretch'`, the pre-D-184 behavior) — read `editor_export`'s own docstring before compositing more than one clip, it explains why `scale` alone can never produce a differently-shaped box than the canvas. **D-197 — audio now mixes in automatically, no new parameter:** every visible audio-track clip's gain/duck/fade PLUS a video clip's own embedded audio (unless A/V-linked or its source isn't known to have audio) sum down to one real output stream, replicating the live mixer's exact semantics. The Edit tab also now has a real GUI Export button/dialog/sequential queue (D-198, `EditorExportDialog.tsx`/`exportQueueStore.ts`) wired through this SAME tool's underlying function — a convenience surface, not a second implementation. |
> | `editor_set_waveform_view` / `editor_get_waveform` (D-232, 2026-09-08, roadmap item 27) | The Edit viewer's **audio waveform strip** (the band between the picture and the position bar), and the envelope it draws. `editor_set_waveform_view(open)` is the write half of `editor_get_state`'s new `waveformView` and drives the SAME store flag the human's transport toggle drives — useful before a `debug_screenshot` of the preview, since the strip changes what the transport area contains. `editor_get_waveform(frame?, window_secs?, buckets?)` is the one that does real work: it returns the resolved `source` (`path`, `sourceSecs`, `track`, `clipId`, and since B-110 `gain` — the linear level that source is actually heard at, `track.gain × clip.volume`; the `peaks` are the source's own and are NOT scaled by it, so multiply if you want what reaches the speakers), the `window` it covered — including `clipStartFraction`/`clipEndFraction`, the part that is actually this clip's own trimmed material rather than source that merely exists — and `peaks`, one `[min, max]` amplitude pair per bucket in `-1..1`. It resolves the audible source exactly as playback does (a real audio track first, topmost wins; else the video clip's embedded audio unless A/V-linked, D-129), and `source: null` is a normal answer for a gap, a title clip, a muted track or past the end. Use it to answer what a human would otherwise have to listen for: where a sentence starts, whether a cut lands mid-word, whether a clip is silent at all. **Not undoable** (`waveformView` is view state — see below). |
> | *(no `editor_scrub` — deliberate)* | D-232's other half, **tape-style scrub audio**, ships as a GUI-only gesture on purpose, and it is the one place this document records a *chosen* asymmetry rather than a gap. Dragging the playhead now plays short grains of the audio under it; its entire content is "sound, now, while my hand moves". An agent cannot hear it, and `editor_set_playhead` already moves the playhead observably, so an `editor_scrub(from, to)` would be an awkward wrapper around a seek. CLAUDE.md's "a human AND an AI" rule is met by giving the agent the same *capability* in the form it can use — `editor_get_waveform` above, the envelope as numbers — not the identical gesture. See D-232 §5. |
> | `editor_get_capabilities` (D-191) | Static reference-only tool — no round trip to the app, works with no project open. Hard-won facts an agent would otherwise only learn by reading source or hitting them live: what `scale`/`fit_overrides` really control (a stacking/PIP primitive tied to the CLIP's own aspect ratio by default, not the canvas's — plus the crop-then-scale recipe for an exact half-canvas box), track paint order, per-clip keyframe scoping, the per-property rule that a keyframe silently beats whatever `editor_set_clip_transform` wrote for that property (B-093/D-209 — the same trap the GUI's own on-canvas drag fell into), export's real v1 scope, and B-069/B-070/B-071/B-073's rough edges (B-069 itself is fixed; documented here as a known failure shape worth recognizing if a similar crash recurs elsewhere). |
> | `editor_export_fcpxml` (D-196) | Renders the WHOLE multi-track timeline to a real, DTD-verified **FCPXML 1.7** interchange document (no picture/audio produced) — the "move this edit to DaVinci Resolve / Final Cut Pro" export, a sibling of `editor_export` compiling the SAME `Timeline` model to a different output format (`packages/editor/src/timelineInterchange.ts`, D-183's own pattern). Maps clip placement/trims, track z-order (as fcpxml lanes), transform/crop/opacity, A/V `link_group`, and audio track gain; does NOT export `chroma_keyframes` animation, clip fades, or audio ducking (no verified FCPXML syntax for the first two without guessing, no static equivalent for the third) — every one of these surfaces in the tool's own `warnings` rather than a silent drop. Read `editor_export_fcpxml`'s own docstring and D-196's field-mapping table before relying on round-trip fidelity for anything beyond that list. XMEML/Premiere export is a separate, not-yet-built format — see D-196. |
>
> Every mutating tool goes through `useEditorTimelineStore.applyOp` (or the
> equivalent real store action), so an agent's edit lands on the same undo stack
> a human's does — D-140's rule, restated in `mcp-architecture.md`.
>
> **`editor_set_selection`, `editor_set_preview_zoom` and
> `editor_set_waveform_view` are the tools that
> deliberately push nothing onto
> that stack** (D-216, D-218, D-232), and none is an exception to D-140 so much as outside
> its subject: `selection`/`selectedGap`/`previewView`/`waveformView` are fields of the STORE, not of
> `Timeline`, so D-051's whole-`Timeline` undo snapshots have never carried
> them, nothing persists them to `project.json`, and every GUI path that writes
> them (`TimelinePane`'s clip click, its marquee, its gap click,
> `useCanvasClipPick`; the preview's own zoom buttons and ctrl-wheel; its
> waveform toggle) pushes
> nothing either. An MCP selection, zoom or waveform toggle that WAS undoable would behave
> differently from the identical human click and would sit between the user and
> their last real edit on the next cmd-Z. All three drive the same store actions
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

## Motion tab — CLOSED, 32 tools (D-255, 2026-09-09)

> **This section used to be headed "Gap: Motion tab — 0 tools" and called it
> "arguably the highest-value gap to close… the one place 'an agent driving this
> app' and 'the manifest-authoring workflow this app is *for*' directly meet."**
> It is closed. Count:
> `grep -c '^def motion_' mcp/server.py` returns **32**, and a cross-language
> check confirms those 32 Python wire names and the 32 op keys in
> `packages/motion/src/motionOps.ts` agree exactly.
>
> 18 of the 32 wrap ops that already existed on the bridge (D-167→D-170) and were
> simply never exposed — the "Step 2 was never done for that tab" case
> `mcp-architecture.md` described. The other **14 are new ops**, because Step 2
> alone would have left real, shipped GUI gestures with nothing to wrap: adding a
> scene, reordering layers, setting scale/rotation/opacity, retiming a camera
> key, easing one keyframe, editing a card, multi-select field edits, and reading
> the selection at all.

| Tool | What it does |
|---|---|
| `motion_get_state` (new) | Read-only orientation, the Motion analogue of `editor_get_state` — `loadState`/`dirty`/`parseError`, the live `selection`, `playheadFrame`, `fps`/`totalFrames`/`width`/`height`, and one row per scene (`id`, `dur` in SECONDS, absolute `startFrame`, layer/child/camera-key counts). **Answers rather than erroring when no project is open** — that is how an agent finds that out. Call it first. |
| `motion_get_manifest` | The whole live document, exactly as the preview renders it (parsed, not necessarily saved). Prefer `motion_get_state`/`motion_list_layers` for orientation; this is a lot to read. |
| `motion_list_layers` (new) | The addressing INDEX — every layer flattened, each with the exact `target` a mutating tool wants, its `use`, the same `label` the GUI's layer list shows, world-space `position`/`size`, and key counts. What `editor_get_timeline` is for clips. |
| `motion_list_primitives` (new) | Static reference, no app round trip — the Motion counterpart of `editor_get_capabilities`. Every primitive's `use` string, what it is for, whether it is 2D or a 3D child (and which target kind addresses it), the editable fields per primitive, plus scene/transform/camera-key field lists. Without it, a legal `use` or field key was only discoverable by reading the app's source. |
| `motion_add_scene` (new) | The layer panel's "+ Scene" button (D-178) — a new 4s scene after the given index. Each scene renders to its OWN video file, so a scene is the unit of "one shot". |
| `motion_set_scene_field` | One field on the scene itself — most often `dur`, the length in SECONDS that every keyframe in it is clamped to. |
| `motion_set_camera_2d` / `_3d` | Replace a scene's camera animation WHOLESALE. The only way to change a camera key's VALUES — `manifestEdit.ts` has no granular per-key camera write, stated on both tools rather than worked around. |
| `motion_add_layer` | The Catalog panel's insert (D-151) — a schema-valid default instance of a primitive, placed into `scene.layers` or `scene.scene3d.children` automatically by its own `in3d` flag. |
| `motion_reorder_layers` (new) | The layer list's drag-to-reorder (D-177). **Array order IS paint order**, so this is the only tool that changes what covers what. |
| `motion_set_layer_field` | A layer's own content/look fields. Writes an unknown key anyway (a hand-authored manifest may carry one) but returns a `warning` — the usual explanation for "I set it and nothing happened". |
| `motion_set_field_on_layers` (new) | The Inspector's multi-select lockstep edit. **One undo entry**, unlike N single calls — which is the whole point. `transform=True` writes the nested transform group instead. |
| `motion_set_layer_item` (new) | One CARD inside a `layers` primitive (D-182/B-068): its `dx`/`dy` offset (the per-card drag), any other field, or `reset=True` (both offsets in one undo step). |
| `motion_select` | The layer-list row click: select one thing AND seek to it — conditionally, matching the GUI exactly (see B-125, which is the drift this fixed). Reports `seekedTo`, or `null` when it deliberately stayed put. |
| `motion_set_selection` (new) | The marquee / shift-click half: the whole array, no seek, `[]` clears. **The Motion answer to D-216's reasoning** — this tab has surfaces that render ONLY for a selection (the Inspector's form, the on-canvas transform box and resize handles, align/distribute, the keyframe timeline's per-row lanes), and until this existed nothing but a mouse could reach them. Pair with `debug_screenshot`. |
| `motion_set_layer_position` / `_size` | The canvas drag / resize handles, in WORLD pixels (the manifest's own space, not screen px and not fractions). Refused, naming the `use`, for a primitive that has no such field. |
| `motion_set_layer_transform_field` (new) | **The tool for scale, rotation and opacity** — the generic transform wrapper every primitive shares (D-157), as distinct from the two above, which write a primitive's own native geometry. Warns when the layer already has keyframes, since a keyed property silently beats a static one. |
| `motion_move_layers_by_delta` | The multi-select canvas drag. `auto_key=True` (+ `at`) routes each layer the way the real drag does — an already-keyframed layer gets a keyframe UPSERTED instead of a static write, a mixed selection routes per layer (D-159). |
| `motion_align_layers` / `motion_distribute_layers` | The align (2+) and distribute (3+) buttons. |
| `motion_set_layer_transform_keys` | Replace a layer's whole animation. `at` is SECONDS from its SCENE's start. `[]` removes the animation entirely. |
| `motion_add_layer_keyframe` | Upsert ONE key without replacing the rest — the auto-keyframe a canvas drag performs. With `x`/`y` omitted it keys the layer WHERE IT ALREADY IS at that moment, which is how a hold is authored. Attaches `ease` in the SAME undo step. |
| `motion_move_layer_keyframe` | Retime one key, values untouched. `lane="active"` retimes a step schedule instead. Clamped to the scene's `[0, dur]` with a warning, never refused for range. |
| `motion_delete_layer_keyframe` (new) | Remove one key. Deleting the last one clears the animation (`clearedAnimation`) — a visible change, not a no-op. |
| `motion_move_camera_keyframe` (new) | Retime one camera key, 2D or 3D — the camera's own half of the timeline drag gesture. |
| `motion_move_keys_by_delta` (new) | The box-select-then-nudge gesture (D-163) — many keys, across lanes and scenes, one shared delta. **D-169 deliberately left this out**, on the grounds that its `baseAtSeconds` is captured at a live drag's start and an MCP call has no drag to capture from; resolved by reading each base off the current manifest, the same "current position is the only honest base for a one-shot op" rule `motion_move_layers_by_delta` already used. Clamping is per key, never a group veto; every target is validated before anything is written. |
| `motion_set_keyframe_ease` (new) | D-164's real bezier model on ONE existing key, in one call instead of a whole-array resend. `x1`/`x2` outside `0..1` are clamped with a warning (B-062 — the runtime throws on them); `y` outside `0..1` is legal and is real overshoot. `null` clears to linear. An `active` step schedule has no ease and is refused by name. |
| `motion_set_layer_active_schedule` (new) | A `layers`/`layerstack` primitive's `active` STEP schedule (D-178/B-067) — which child shows, from when. A step, not an interpolation, hence no ease anywhere on it. |
| `motion_seek` | Move the playhead — an absolute `frame`, or `{scene_index, at}` in the same seconds space every keyframe uses. Clamped with a warning, never refused. Do this before a `debug_screenshot` of a specific moment. |
| `motion_save_manifest` | Write the sidecar now. Returns the real path or the real error, never a silent success. |
| `motion_render` | The real Remotion render — **one video file PER SCENE** (D-180), never one combined video. See the note below on what actually happens to those files. |

> **Every mutating op goes through `useMotionManifest().commit`**, the same path
> an Inspector edit takes, so an agent's edit lands on the same
> `@chroma/history` undo stack a human's does (D-140). **`motion_select`,
> `motion_set_selection` and `motion_seek` deliberately push nothing** — the same
> carve-out, for the same reason, as `editor_set_selection`/
> `editor_set_preview_zoom`: selection and playhead are component state, not
> part of the manifest, nothing persists them, and the GUI's own click pushes
> nothing either.
>
> **The Motion→Edit boundary, since it is easy to assume wrongly** (this pass
> began with the wrong assumption and corrected it against `app/src/Root.tsx`):
> a rendered scene is imported into the Edit tab's Sources pool **automatically**,
> per scene, by `onMotionRendered` → `useMediaPoolStore.importPaths` (D-062).
> **You do not call `editor_import_media` on these paths** — it has already
> happened. What is not automatic is PLACEMENT on the timeline, left as one
> explicit action deliberately. And there is **no live link**: a rendered file is
> a flat video frozen at render time, so re-editing the manifest changes nothing
> already imported or placed.
>
> **Structural note.** The op registry now lives in
> `packages/motion/src/motionOps.ts` as a pure `createMotionOps(ctx)` factory;
> `useMotionControl.ts` is the thin listener shell. That split is what makes the
> ops testable at all in this package's `node` vitest environment — the reason
> the whole D-167→D-170 surface had shipped with zero tests. There are now 78,
> each mutating one asserting the op produces the IDENTICAL manifest the GUI's
> own `manifestEdit.ts` call produces. See D-255.

**Still open for Motion, deliberately (D-255):** there is **no delete-a-layer or
delete-a-scene tool**, because `manifestEdit.ts` has no delete function and the
GUI has no delete gesture — adding one MCP-only would break the human-AND-AI rule
from the other side, which is the defect this pass exists to fix. It is a real
product gap and both halves should land together. Also deferred: a
`motion_snap_to_layer` (needs a live screen-space measurement, not a manifest
read), and granular camera-key VALUE editing (no such write function exists;
`motion_set_camera_2d`/`_3d` replace the array).

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

## Debug / UI verification — CLOSED, 9 tools (D-210 + D-219, 2026-09-08; +1, D-246)

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
| `debug_set_inspector_tab` | that Inspector's own Video/Audio tab (D-246), through `useEditorTimelineStore.setInspectorTab` — the action the tab button's own onClick calls. Only one tab renders at a time, so this is what puts the half you want to look at on screen before a screenshot or a DOM dump. |
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
