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

## Current coverage: Colorist only (41 tools, real, verified via `mcp/server.py`)

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

## Edit tab / multi-track NLE — CLOSED, 21 tools (D-183, 2026-09-07; +1, D-185)

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
> | `get_timeline` | Read-only. Every track and clip, with the `index` mutating tools address a clip by and the `id` that survives a reorder. Reports fades + ducking. |
> | `editor_get_state` | Read-only. Project-open/load-status/playhead/playing/has-timeline. |
> | `editor_set_playhead` / `editor_set_playing` | Seek / play-pause. |
> | `editor_import_media` | Import absolute paths into the shared media pool — the prerequisite for `editor_add_clip`. |
> | `editor_add_clip` | Place a pool item on a track, trimmed to a source range. Called once per KEPT segment (not "place then cut a gap") to build a track from a raw recording. |
> | `editor_split_clip` / `editor_remove_clip` / `editor_remove_gap` / `editor_trim_clip` / `editor_move_clip` | The rest of the ripple-edit primitives — no new `EditOp` had to be invented for any of these; every one already existed in `packages/editor/src/timeline.ts`, only the MCP wrapper was missing. |
> | `editor_add_track` / `editor_set_track_gain` / `editor_set_track_locked` / `editor_set_track_hidden` | Track management. |
> | `set_clip_fade` / `set_track_duck` | Unchanged from D-147/D-149 (see above for the internal rename). |
> | `editor_set_clip_transform` | A clip's base position/scale/rotation/crop/opacity, as fractions of the output composition — the stacking/PIP primitive (D-136's normalised-fraction convention). |
> | `editor_set_clip_keyframes` | Animates ONE clip's own transform over time (e.g. zoom-in on a click) — scoped to that clip's own local timeline, never the whole track, so two clips on two tracks each zoom at their own moment while both stay visible. |
> | `editor_export` | Renders the WHOLE multi-track timeline (composited, cropped, keyframed, speed-adjusted) to a real output file via ffmpeg — the one tool that produces an actual video, everything else only edits in-memory state. v1 is video-only; audio mixing (gain/duck/fade) is a documented follow-up, not wired into the export yet. `fit_overrides` (D-184, B-074) lets a caller choose per-clip whether `scale` fits the clip's real aspect ratio into its box (`'fit'`, the default) or force-stretches to the canvas's own aspect ratio (`'stretch'`, the pre-D-184 behavior) — read `editor_export`'s own docstring before compositing more than one clip, it explains why `scale` alone can never produce a differently-shaped box than the canvas. |
> | `editor_get_capabilities` (D-185) | Static reference-only tool — no round trip to the app, works with no project open. Hard-won facts an agent would otherwise only learn by reading source or hitting them live: what `scale`/`fit_overrides` really control (a stacking/PIP primitive tied to the CLIP's own aspect ratio by default, not the canvas's — plus the crop-then-scale recipe for an exact half-canvas box), track paint order, per-clip keyframe scoping, export's real v1 scope, and B-069/B-070/B-071/B-073's rough edges (B-069 itself is fixed; documented here as a known failure shape worth recognizing if a similar crash recurs elsewhere). |
>
> Every mutating tool goes through `useEditorTimelineStore.applyOp` (or the
> equivalent real store action), so an agent's edit lands on the same undo stack
> a human's does — D-140's rule, restated in `mcp-architecture.md`.

**Net effect: an agent can now drive essentially the whole Edit tab** — import
media, assemble a track from raw footage (cut gaps/retakes by only placing the
segments to keep), split/trim/move/remove clips, manage tracks, composite/stack
multiple video tracks with per-clip keyframed zooms, and render the result to a
file. The one still-open piece: audio tracks (gain/duck/fade) are read but not
yet mixed into `editor_export`'s own output.

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
D-081's new `LayerList`/`Selection` (Motion tab, tonight) has no MCP surface
either, but selection is a pure UI-navigation concept — the manifest
get/save/render triad is the real, load-bearing gap.

## Gap: Media / Sources pool — 1 of 6 tools (D-183 added import only)

`editor_import_media` (D-183) covers `chroma_media_import`'s job — importing
absolute paths into the pool — but only that one; it exists because
`editor_add_clip` needs a pool item to place, not as a sweep of this section.
`chroma_media_list` / `_move` / `_remove` / `_create_folder` / `_folders` still
have no MCP tool: an agent can't query what's already in the pool, organize it
into folders, or remove items, independent of Colorist's own
`list_shots`/`add_shots` (project-timeline-scoped, not pool-scoped — a real,
different thing). This gap has a real, live-witnessed cost, not just a
theoretical one: B-073 (`docs/BUGS.md`) is a media-pool item stuck with no
`video` metadata after a transient probe failure, invisible to `editor_add_clip`
and impossible to inspect or clear via MCP — the session that hit it had to
read `project.json` by hand. `editor_get_capabilities` (D-185) documents this
as a known landmine since it's the best available mitigation until a real
`chroma_media_list`/`_remove` tool exists.

## Gap: Audio playback — 0 tools, lowest priority

`chroma_audio_play` / `_stop` / `_level` / `_waveform` — playback transport
control. Lower value for an agent than the above (an agent driving edits doesn't
obviously need to literally press play), but genuinely zero coverage; noted for
completeness rather than urgency.

## When shipping something new (going forward)

Before calling a new capability "done," check: does this need an MCP tool, and if
so is one actually built? If not, add a line to whichever gap section above it
belongs in (or a new section if it's a new area entirely) rather than letting this
doc silently drift out of date the way the roadmap's own "In flight" tracker would
if nobody touched it after the work landed.
