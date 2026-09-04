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

## Gap: Edit tab / multi-track NLE — 0 tools

Every Tauri command in `chroma::edit` (`app/src-tauri/src/chroma/edit.rs`) has no
MCP equivalent at all:

- `chroma_timeline_get` / `chroma_timeline_set` / `chroma_timeline_frame`
- `chroma_timeline_list` / `chroma_timeline_create` / `chroma_timeline_set_active`
- `chroma_timeline_add_track` / `chroma_timeline_remove_track` /
  `chroma_timeline_move_clip` (Phase A, D-054 — dedicated Tauri commands exist, but
  note: the real frontend (`packages/editor`) doesn't call these directly today —
  it computes a whole new `Timeline` client-side (`timeline.ts`'s pure `applyOp`)
  and persists via the generic `chroma_timeline_set`, matching this app's
  established "verbatim whole-document storage" contract. An MCP tool for "add a
  track" etc. could either call the dedicated Rust commands directly (simpler,
  but a second code path from what the GUI actually exercises) or replicate the
  op-then-set-whole-timeline pattern (matches the GUI exactly, more moving parts
  for a tool to get right) — worth a real decision when this gets built, not
  assumed here.
- **Everything landing from tonight's P0 NLE build** (D-080/D-086/D-088, still
  in progress as this doc is written — re-check `docs/08-decisions.md`'s latest
  D-NNN entries for the final list once that work lands): `set_track_gain`
  (mute), `set_track_locked`, `set_track_hidden`, `move_track` (rearrange
  z-order), `set_clip_transform` (position/scale/rotation/opacity) and its
  keyframe variants (reusing the D-034 keyframe engine the same way relight's
  `add_mask_keyframe`-style tools already do — that's real precedent to follow,
  not a new pattern to invent).
- Split/trim/reorder/remove clip ops (`packages/editor/src/timeline.ts`'s
  `EditOp` variants) have no Rust-side dedicated command at all today (client
  computes, `chroma_timeline_set` persists) — same "which path does a tool
  call" question as above applies to all of them, not just the track ops.

> **The "which path does a tool call" question is answered — D-140, 2026-09-05.**
> A *mutating* Edit-tab tool goes through the GUI's own path
> (`@chroma/editor`'s `timelineStore.applyOp` → debounced `chroma_timeline_set`),
> not the dedicated Rust commands. Reason: `applyOp` pushes a before/after
> snapshot pair onto the shared `@chroma/history` undo stack (D-051) and
> `chroma_timeline_move_clip` does not, so calling the Rust command directly
> would produce an agent edit the user cannot undo — a violation of MCP design
> rule 7 ("one shared state… the UI and the agent never diverge") and of
> `00-vision.md`'s "reviewable and undoable, not a black box." No new plumbing
> is needed: `useChromaControl()` is mounted app-level in `App.tsx` (verified),
> and `app` already depends on `@chroma/editor`. The dedicated Rust commands
> stay what D-138 built them for — headless/scripting callers outside the app.
> D-140's own Phase 1 also ships the minimal read op this whole section
> presupposes: `get_timeline` (shaped `chroma_timeline_get`), without which no
> tool can name a clip. See `docs/notes/pacing-audio-assistance-plan.md` §6.

**Net effect: an agent cannot touch the Edit tab / NLE at all right now** — no
adding clips, no trimming, no track management, none of tonight's new
compositing/lock/hide/rearrange/keyframe work either, once it ships.

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

## Gap: Media / Sources pool — 0 tools

`chroma_media_import` / `_list` / `_move` / `_remove` / `_create_folder` /
`_folders` — no MCP tool. An agent can't import media, organize the pool, or query
what's available, independent of Colorist's own `list_shots`/`add_shots` (which
are project-timeline-scoped, not pool-scoped — a real, different thing).

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
