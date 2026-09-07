---
name: chroma-comparison-reel
description: Build a stacked before/after (or side-by-side) comparison Reel from raw screen recordings using Chroma's own Edit-tab MCP tools end-to-end — import, place, composite/stack, per-clip zoom keyframes, whole-clip speed change, export. Use when asked to turn two or more raw recordings into a comparison-style vertical/portrait video inside this repo's Chroma app. Not for grading (that's Chroma's Colorist MCP tools) and not for a from-scratch HyperFrames composition (that's the hyperframes skill family in a different repo).
---

# Chroma comparison reel

What this is: a checked-in, repeatable procedure for the one real end-to-end job this
repo's Edit-tab MCP surface (D-183, `mcp/server.py`'s `editor_*` tools) has actually been
used for in production — stacking two or more screen recordings into one comparison Reel,
driven entirely through Chroma's own MCP tools, no raw ffmpeg scripting alongside the app.
What it does NOT do: grade the result (Colorist's own MCP tools, `mcp/server.py`'s
non-`editor_*` tools, are a separate surface — see `docs/notes/mcp-architecture.md`), or
build a from-scratch animated composition (that's the `hyperframes` skill family, a
different tool for a different job). Created by D-192 (`docs/08-decisions.md`), the same
session that shipped D-183/D-184/D-191 and hit the gaps this skill exists to route around
(`docs/BUGS.md` B-069/B-070/B-071/B-073/B-074).

**The standing rule this whole workflow runs on** (owner, verbatim, mid-session): *"wtf
then why are we building chroma when you want to do it with ffmpeg? never do such edits"*
— a missing Chroma capability gets built into the tool (an MCP op), never worked around by
scripting the edit outside the app. If a step below seems to need raw ffmpeg against the
source files instead of an `editor_*` call, that is a real MCP gap, not a shortcut to take
— go build the tool (`docs/notes/mcp-architecture.md`'s recipe), don't route around it.

## 0. Prerequisites

- The Chroma desktop app is running (`npm run tauri:dev` from the repo root, or
  `cd app && npm run tauri dev`) — every `editor_*` tool needs its control server
  (port 19788) up.
- The `chroma` MCP server is connected in this Claude Code session (`claude mcp list`
  should show it). If you just added or changed a tool in `mcp/server.py`, **restart
  Claude Code** — a (re)connected MCP server's tools only become visible after a full
  exit + relaunch, not immediately (`docs/notes/mcp-architecture.md`'s recipe, step 4).
- Read `editor_get_capabilities` (D-191) once, right now, before anything else below.
  It is static reference data — no app round trip, works even before you've confirmed
  the app is up — and covers the compositing/export facts and rough edges this whole
  skill is built around. This skill tells you WHEN to use each fact; that tool is the
  live, authoritative WHAT.

## 1. Live-test the MCP surface before trusting it for a real edit

Do this before opening or creating the real project, every session — not because it
usually fails, but because the one time it doesn't work is much more expensive to find
out about mid-edit than up front. `docs/BUGS.md` B-069 (now FIXED — a Rules-of-Hooks
violation in `TimelinePane.tsx`) is exactly the failure shape this guards against: a
single unrelated React crash in one Edit-tab panel wedged the ENTIRE control-server
bridge — every `editor_*` op, including plain reads, started failing — discovered
mid-task instead of at the start, because nothing had live-tested the surface first. The
specific cause is fixed; no error boundary exists yet around Edit-tab panels, so a
*different* future crash could still reproduce the same shape.

1. Call `editor_get_state` — a cheap read. Confirm it returns, not an error/timeout.
2. Do one real mutating round trip: `new_project` (or `open_project` on a scratch
   project) followed by `editor_add_track`. Then call `editor_get_state` /
   `get_timeline` again and confirm the change actually landed — not just that the
   call returned `ok: true`.
3. If step 1 or 2 fails or hangs: **restart the Chroma app** and retry. Don't loop
   retries against a wedged bridge hoping it clears itself.
4. If the very first `editor_*` call right after an app restart fails once, retry it
   immediately — that one is expected (`docs/BUGS.md` B-071, a stale pooled HTTP
   connection to the previous process). A second failure is a real problem, not this.

Only proceed to real work once this passes.

## 2. Resolve source file paths safely — the macOS filename trap

**Never hand-type a `.mov` filename you read off the Finder/Desktop that contains
"AM"/"PM".** macOS names screen recordings with a NARROW NO-BREAK SPACE (U+202F), not a
regular space, before AM/PM — e.g. `Screen Recording 2026-09-07 at 1.08.16 PM.mov` looks
identical to the eye and to a hand-typed literal, but the bytes differ, so a hand-typed
path with an ordinary space silently matches nothing (`docs/BUGS.md` B-070). This breaks
ANY tool given a literal path, including `editor_import_media`, `ffprobe`, and a plain
shell `ls` on the "same" path — it is not a Chroma bug.

Always resolve the real path one of these ways, never by transcribing what you see:

```bash
# a shell glob resolves the real bytes:
ls ~/Desktop/*2026-09-07*.mov

# or copy to a plain ASCII-safe name first and use that everywhere after:
cp ~/Desktop/"$(ls ~/Desktop | grep 'Screen Recording 2026-09-07')" \
   ~/my_projects/chroma/scratch/reel-src/before.mov
```

Copying to `chroma/scratch/reel-src/<plain-name>.mov` once, up front, and using only
those plain names for every subsequent `editor_import_media` call is the durable fix —
cheaper than re-resolving the glob on every tool call.

## 3. Plan the layout before touching `editor_set_clip_transform`

Read `editor_get_capabilities`'s `compositing` section in full before this step if you
haven't already — the short version: `scale` ties the overlay's WIDTH to the canvas, but
its HEIGHT follows the CLIP's own aspect ratio by default (`editor_export`'s
`fit_overrides` default, `'fit'`, D-184) — not the canvas's. It does **not** alone
produce an exact-height box like "top half of a 9:16 canvas." (There is also an explicit
`'stretch'` opt-in on `editor_export` that forces the canvas's aspect ratio instead — the
old, pre-D-184 behavior, correct only for a genuine same-aspect PIP bubble; the recipe
below assumes the `'fit'` default, which is what an undistorted stacked comparison
needs.)

**To land a clip in an exact slot** (e.g. each of two clips filling exactly one half of
a 1080x1920 canvas, 1080x960 each):

1. Get the clip's native resolution from `editor_import_media`'s probe result (or
   `get_timeline`).
2. Pick `crop_top`/`crop_bottom` (or `crop_left`/`crop_right`) so the CROPPED frame's
   aspect ratio equals the target box's aspect ratio (`target_w / target_h`) — crop is
   applied before scale.
3. Set `scale` so `target_w == canvas_width * scale`.
4. Set `position_y` (or `position_x`) to place that box's top-left corner as a fraction
   of the canvas — it does not center or clamp into a slot for you; compute both boxes'
   `position_y` values yourself (e.g. `0` and `0.5` for an even top/bottom split).

**Track paint order**: track index 0 paints LAST (topmost) — the opposite of "higher
number = on top." Put whichever layer should be visually on top (e.g. a label/logo
overlay) on track 0.

## 4. Build the project — the real `editor_*` tool sequence

This is the sequence this skill was extracted from, verified end-to-end against a real
reel:

1. `new_project(name, media_paths=[])` — create empty, or `open_project` an existing one.
2. `editor_import_media(paths=[...])` — the plain-ASCII-safe paths from step 2, once per
   source file. If a path you just imported is later reported as "no pool item matching"
   by `editor_add_clip`, see `docs/BUGS.md` B-073 before assuming you mistyped it —
   don't just retry the same import.
3. `editor_add_track(track_kind="video")` — once per visual layer (e.g. one per source
   recording being stacked).
4. `editor_add_clip(track=N, source_path=..., source_start=..., duration=..., ...)` —
   place each KEPT segment. To cut a gap or a bad take out of a raw recording, call this
   once per segment you want to KEEP, with back-to-back `start_frame`s — don't place the
   whole clip and then remove a gap.
5. `editor_set_clip_transform(track=N, clip=I, position_x=..., position_y=..., scale=...,
   crop_top=..., crop_bottom=...)` — the base layout from step 3, once per clip.
6. `editor_set_clip_keyframes(track=N, clip=I, keyframes=[...])` — per-clip zoom/reframe
   moments (e.g. a punch-in at the moment of a click). Scoped to that ONE clip's own
   local timeline — two clips on two tracks each zoom at their own moment with zero
   interaction, by construction. Pass the clip's ENTIRE keyframe list every call, not
   just the one you're adding.
7. Repeat 4-6 for every clip on every track.
8. `editor_export(out_path=..., width=..., height=..., fps=..., speed_overrides={clip_id:
   multiplier})` — `speed_overrides` is export-time only (e.g. `{"clip-abc": 1.2}` for a
   whole-clip 1.2x); it does not touch the clip's stored trim, so scrubbing the timeline
   still plays at 1x. Leave `fit_overrides` unset for an undistorted stacked comparison
   (its default, `'fit'`, is what step 3's recipe assumes); pass
   `fit_overrides={clip_id: "stretch"}` only for a deliberate same-aspect PIP bubble or
   distort effect. v1 export is video-only — audio tracks are not mixed into the output
   file yet (a documented gap, not a bug — check `docs/notes/mcp-tool-coverage.md` before
   assuming this has since changed).

Verify the exported file exists and has a sane duration/size before calling the job
done — `editor_export` blocks until ffmpeg finishes and reports the resolved path.

## 5. Optional: cross-repo video understanding + local SFX generation

Legitimate today, as a one-off pattern, NOT something to build into Chroma itself yet: a
real migration of this into Chroma's own `ai/` sidecar is scoped in
`docs/notes/media-understanding-sidecar-scope.md` but not done — read that doc rather
than re-deriving the migration plan here, and don't start that migration as a side
effect of building a reel.

Until that migration lands, reach into the sibling `videoAgent` repo directly for two
things Chroma's own MCP surface doesn't cover yet:

```bash
# Understand what's actually in a clip (for deciding zoom moments, cut points):
python3 ~/my_projects/videoAgent/video_understand.py <path>

# Generate a local SFX cue (e.g. a zoom-whoosh) with mlx-audiocraft:
python3 ~/my_projects/videoAgent/audiocraft_generate.py --model audiogen-medium \
  --prompt "..." --out ~/my_projects/chroma/scratch/reel-sfx/<name>.wav
```

Note: `audiocraft_generate.py`'s model load has shown a large (~17GB) transient memory
spike in Activity Monitor that self-resolves within ~90s (`docs/BUGS.md` B-072, deferred
by the owner, not chased down) — not alarming on its own, but don't run several of these
concurrently without knowing that.

## 6. Architecture context (why the gaps above exist at all)

Every `editor_*` MCP tool call and every GUI click go through the exact same store
(`useEditorTimelineStore`, D-020's one-shared-state rule) — this is *why* an agent's edit
is visible to a human's GUI and vice versa, and it's also why a render crash anywhere in
that shared React tree can wedge the whole out-of-process MCP bridge (B-069's own
failure shape, now fixed but structurally not prevented): there is no isolation between
"one panel's render crashed" and "the control server can no longer answer any request."
See `docs/notes/mcp-architecture.md` for the full four-layer picture (MCP client →
`mcp/server.py` → `chroma::control` → `useEditorControl.ts` → the store) and
`docs/08-decisions.md`'s D-183/D-184/D-191 entries for how this tool surface and its
documentation tool came to exist.

## Reference

- `editor_get_capabilities` (D-191) — the live, structured source of truth for the
  compositing/export facts and known landmines this skill references; call it, don't
  assume this document stays byte-for-byte in sync with it forever.
- `docs/notes/mcp-architecture.md` — the four-layer MCP pattern, and the "one MCP server,
  not one per tab" rule.
- `docs/notes/mcp-tool-coverage.md` — what's covered vs. genuinely missing (Motion tab:
  zero tools; media pool: import only, no list/remove).
- `docs/BUGS.md` B-069 (control-server wedge, fixed), B-070 (macOS filename trap), B-071
  (post-restart flake), B-072 (audiocraft memory spike), B-073 (stuck media-pool item),
  B-074 (the `scale`/aspect-ratio bug, fixed by D-184).
- `docs/08-decisions.md` D-183 (the Edit-tab MCP surface itself), D-184 (`fit_overrides`),
  D-191 (the capabilities tool), D-192 (this skill).
- `docs/notes/media-understanding-sidecar-scope.md` — the scoped, not-yet-started plan to
  bring §5's cross-repo calls into Chroma's own `ai/` sidecar. Read it before touching
  that migration; it is out of scope for this skill.
