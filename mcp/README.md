# mcp/ — Chroma MCP server (D-020)

A thin stdio MCP server that lets Claude drive the **running Chroma desktop app**.
Claude and the app share **one** grade/mask state: an MCP edit moves the app's
sliders and re-renders its canvas; a read reflects the user's manual edits.

```
Claude (MCP client)
  │  stdio
mcp/server.py
  │  HTTP  POST /op {op, args}
app/src-tauri/src/chroma/control.rs   (control server, in the app, port 19788)
  │  Tauri events  chroma://request  /  chroma://response/<id>
app/src/hooks/useChromaControl.ts     (frontend — owns all grade/mask state)
  │  the SAME store actions the GUI buttons call
useEditorStore  →  render  →  { rendered frame, histogram, adjustments }
```

There is **no grade or mask logic** in this server or in `control.rs` — every op
is dispatched to a real frontend action (`setAdjustments`, the `useAiMasking`
handlers). That's what keeps MCP and the UI from ever diverging. See
`../docs/08-decisions.md` D-020 and `../docs/notes/control-server/SPEC.md`.

## Setup

```bash
cd mcp
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Add to Claude Code

The Chroma desktop app must be running (the control server binds on app start),
with an image or video open.

```bash
claude mcp add chroma -- /ABS/PATH/chroma/mcp/.venv/bin/python /ABS/PATH/chroma/mcp/server.py
```

Set `CHROMA_CONTROL_PORT` in the env if you overrode it on the app side
(default `19788`).

## Tools — 77

The table below is the **Colorist** surface (grading, masks, relight, scopes,
export). The Edit tab's own 30 `editor_*` tools — read/seek/**selection**
(D-216), media import/removal, clip placement/split/trim/slip/swap/move/remove,
gap removal, text/title clips (D-211), track management, transform +
keyframes, multi-track export, FCPXML interchange, and 4 media-understanding
tools from D-189 (listed at the end of this table) — are documented with their
behaviour in `../docs/notes/mcp-tool-coverage.md`, which is the authoritative
per-tab inventory; the pattern every tab follows is
`../docs/notes/mcp-architecture.md`. The 2 `debug_*` tools (D-210) are
debug-build-only and documented in `../docs/notes/debug-screenshot-tool.md`.


| tool | what it does |
|---|---|
| `get_state` | loaded image/video, primary adjustments, mask summary, **the multi-shot `session`**, **the loaded `project`** (`{name, path, dirty, settings}` or null for an Untitled session) — reflects manual edits |
| `list_projects` | every saved `<name>.chroma` project in the projects folder (`~/Movies/Chroma` default), newest first — `{projects: [{name, path, modified, shotCount}], folder}` (D-037) |
| `open_project(name_or_path)` | open a project — loads its shots + per-shot grades into the session, enters the editor; a missing source file is flagged "media offline" (D-037) |
| `new_project(name, media_paths?)` | scaffold `<name>.chroma` from the given media (referenced in place, never copied) + open it (D-037) |
| `save_project()` | force an immediate write of project.json + the active shot's grade.json + the launcher thumb (autosave does this on a debounce otherwise) (D-037) |
| `set_project_settings(width?, height?, fps?, color_space?)` | partial-merge the open project's output spec — resolution + timebase + colour space. Export resizes the graded composite to width×height and uses fps; `color_space` is stored + surfaced only pending colour management (D-038) |
| `list_masks` | every mask container + sub-masks (ids, type, per-mask adjustments, tracked?) |
| `list_shots` | every shot in the session + which is active — a grading job is N shots, each keeps its own grade + activity feed (D-033) |
| `set_active_shot(index?, path?)` | switch the active shot — saves the current shot's grade, restores the target's, scopes the activity feed. Grade shot by shot in one session (D-033) |
| `add_shots(paths)` | add clips to the session by absolute path + switch to the last (D-033) |
| `set_primary(**knobs)` | exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, dehaze, clarity, structure, sharpness, vignetteAmount |
| `set_curve(channel, points)` | replace a tone-curve channel (`luma\|red\|green\|blue`), points `[{x,y}]` 0..255 |
| `set_color_grade(shadows?, midtones?, highlights?, global_?, blending?, balance?)` | colour-grading wheels |
| `seek(frame)` | move the video playhead, decode + re-render that frame |
| `add_subject_mask(bbox?, mode="additive")` | new container + AI subject sub-mask + generate the matte (SAM 2 on video); `mode` = additive/subtractive/intersect |
| `add_component(mask_id, type, mode="subtractive", bbox?, geometry?)` | add a sub-mask to an existing container — the "Add to / Subtract from / Intersect with Mask" menu. `type` = subject/radial/linear/brush. A subtractive Subject component carves a SAM region out; a subtractive Radial/Linear carves a shape out (D-023) |
| `set_submask_mode(sub_mask_id, mode)` | flip a component's composition mode (additive/subtractive/intersect) |
| `add_mask_keyframe(mask_id, sub_mask_id, frame?)` | snapshot a **shape** sub-mask's geometry (centre/radii/rotation, endpoints, brush points) as a keyframe at `frame` (default: current). The engine interpolates the geometry per frame on scrub/playback/export — hand-track a mask SAM can't follow. Geometry only; tracked sub-masks can't be keyframed (D-034) |
| `list_mask_keyframes(mask_id, sub_mask_id)` | the sub-mask's geometry keyframes `[{frame, params}]` (D-034) |
| `clear_mask_keyframe(mask_id, sub_mask_id, frame)` | remove one keyframe; the last one removed → static mask (D-034) |
| `clear_mask_keyframes(mask_id, sub_mask_id)` | remove all keyframes → static mask (D-034) |
| `track_subject(sub_mask_id, mode="fast")` | propagate a subject sub-mask across the whole clip |
| `apply_haze(amount=1.0, protect_subject=True, tracked=False)` | one action → depth-weighted atmospheric haze on the background (inverted full-range depth mask + negative-dehaze/desat/black-lift/defocus grade). `tracked=True` (video) also runs `depth_track` so the haze follows a moving camera (D-024, D-036) |
| `depth_track(from_frame?, to_frame?, step?, input_size?, sub_mask_id?)` | precompute a **temporally-consistent** depth map for every frame (Video Depth Anything — Small, sidecar) and point a depth sub-mask at the cache — this is what makes `apply_haze` follow a moving camera without flicker (a per-frame model + EMA can't; a video-depth model, like Resolve's z-depth, can). Non-blocking; the Rust Depth Anything V2 static bake stays the fallback for stills / un-tracked haze (D-036) |
| `depth_track_status()` | poll `depth_track` → `{running, done, total, tracked}` (D-036) |
| `set_mask_adjust(mask_id, **knobs)` | grade *through* a mask — same knobs as `set_primary` |
| `invert_mask(sub_mask_id)` | grade the outside instead of the inside |
| `delete_mask(mask_id)` | delete a whole mask container |
| `inspect_color(frame?, reference?)` | measure the frame — parade + vectorscope images + numeric summary (black/white points, per-zone means, warm-cool + green-magenta cast, clip %, hue histogram); with `reference` (abs path) also its scopes + a `gap` of knob hints (D-021) |
| `sample(x, y)` | RGB + hex + luma of one pixel of the rendered frame |
| `sample_region(x, y, w, h)` | mean / min / max RGB over a rectangle |
| `match_to_reference(reference, strength=1.0, max_iters=4, tolerance=3.0)` | auto-grade toward a reference image — measure the scope gap, iterate a **damped** primary correction (exposure / temperature / tint / contrast / saturation) with roll-back-on-worse until the gap is small. Merges into `primary` (a balance). Returns `{converged, iterations, gap_before, gap_after, applied, trace}` + the final frame + scopes (D-026) |
| `export(kind, path?, from_frame?, to_frame?, quality?)` | render the grade to a file — `prores` (default) / `h264` clip or a `cube` primary-grade LUT. Video export polls to completion; returns the resolved path + frame count. Default `path` = beside the source as `<name>.graded.{mov,mp4,cube}` (D-022) |
| `request_human(reason, roi?)` | hand back to the user — a **non-blocking** handoff for genuine uncertainty / a creative call / "please review". Posts a GUI banner (+ an ROI rectangle on the canvas if `roi` = `{x,y,w,h}` normalized 0..1). Returns an ack immediately; poll `get_state().pendingHumanRequest` — it goes null/`cleared` once the user clicks "Resume agent" (D-032) |
| `editor_get_transcript(path?, media_id?, source_path?, language?, word_timestamps=True, force=False)` | start a word-level transcript — "what was SAID, and when" (mlx-whisper large-v3, via the `ai-media/` sidecar). Returns a `state`; poll `editor_get_transcript_status`. Cached per file; finds nothing in silent footage (D-189) |
| `editor_get_transcript_status(path?, media_id?, source_path?)` | poll it — `running` / `done` (with `text`, `segments`, per-word `start`/`end`) / `idle` |
| `editor_analyze_video(path?, media_id?, source_path?, question?, scene_threshold?, min_gap_s?, max_candidates?, force=False)` | start a visual analysis — "what CHANGED on screen, and when." ffmpeg scene-detect gives the exact timing, Qwen3-VL only describes each before/after frame pair. Finds nothing in a continuous uncut shot — use the transcript there (D-189) |
| `editor_analyze_video_status(path?, media_id?, source_path?)` | poll it — `running` / `done` (with `events: [{time_s, event}]` + `truncated`) / `idle` |

Every mutating tool returns the re-rendered frame (as an MCP image when the app
can supply one) plus the histogram, the full adjustments doc, **and the compact
`scopes` summary** (the new measurement after the change). The four
media-understanding tools above are the exception: they mutate nothing, so they
return plain JSON.

## Agent activity feed (D-032)

Every mutating tool call also shows up in the app's **"Agent activity" dock**
(fixed, bottom-left): a newest-first list with a one-line summary, an expandable
per-field grade diff, and a jump-to-here **Undo** the user can hit. `seek` /
`open` (pure navigation) aren't listed; `match_to_reference`'s internal
iterations collapse to one entry. You don't need to narrate your edits — the
user can see them. This is what "one shared state, not two divergent ones"
(`docs/00-vision.md`) looks like in the GUI. `request_human` is the other half:
call it when you need the human, not to report routine progress.

## Scope-first discipline

**Grade by the numbers.** Call `inspect_color` before and after a change and
reason from the scope values (black/white points, per-zone means, warm-cool and
green-magenta cast, clip %, hue histogram) or a named full-res region from
`sample` / `sample_region`. Never claim a result ('looks balanced', 'skin is
natural', 'the cast is gone') without citing a scope value or a sampled region.
Read each result adversarially — assume a cast, clip, or crushed channel is still
there and look for the one you have not ruled out. Defer genuinely creative calls
to the human. See `../docs/notes/agent-visual-feedback.md`.

Whether the tools + skill + prompt actually enforce this loop — measure, adjust,
re-measure, converge on a target rather than drift — is a regression test:
`eval/` (task set + offline scorer + committed baseline). See `../eval/README.md`
and `../docs/notes/eval-harness.md` (D-035).

Adding a capability = one entry in the owning tab's own `OPS` registry + one
tool here. Which hook that is depends on the tab — `useChromaControl.ts`
(Colorist), `@chroma/editor`'s `useEditorControl.ts` (`editor_*`),
`@chroma/motion`'s `useMotionControl.ts` (`motion_*`). The full recipe, and the
op-prefix convention that keeps two hooks from racing for one response, is
`../docs/notes/mcp-architecture.md`.

## Troubleshooting

- **"Cannot reach the Chroma control server"** — the app isn't running, or it's
  on another port (`CHROMA_CONTROL_PORT`).
- **"The Chroma app did not respond"** (504) — the app window is closed or no
  image/video is loaded. The bridge only runs while the editor view is mounted
  (i.e. something is open).
- **No image in the response, only the histogram** — known v1 limitation: the app
  renders to a native WGPU surface, so the frame is a best-effort headless
  re-render (`generate_uncropped_preview`). The histogram + adjustments are always
  accurate; sync is the requirement, the frame is a nice-to-have.
