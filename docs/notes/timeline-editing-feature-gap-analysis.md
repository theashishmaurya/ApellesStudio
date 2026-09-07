# Edit-tab timeline-editing feature gap analysis (2026-09-07)

Owner asked, pointing at a competitor's own docs (Palmier, a similar AI-native editor):
compare its documented timeline-editing feature set against what Chroma's Edit tab
actually has today, and scope the gaps. This is a comparison + scope note, not a build
log — nothing below has been built as part of writing this.

Method: cross-referenced Palmier's 17 documented timeline-editing features against
`packages/editor/src/timeline.ts` (the real `EditOp`/`Clip`/`Track` model),
`docs/notes/mcp-tool-coverage.md`'s Edit-tab tool table, and this session's own D-NNN/
B-NNN history. Every "have" below is traceable to a real `EditOp` case or MCP tool that
exists today — not assumed from a feature's plausibility.

## Already have (verified against real code)

| Feature | Chroma's real equivalent |
|---|---|
| Trimming | `editor_trim_clip` / `trim_start`/`trim_end` `EditOp`s (D-051/D-058 edge-drag) |
| Splitting/Razoring | `editor_split_clip` / `split` `EditOp` |
| Ripple editing | `ripple: true` on `add_clip`/`move_clip`, `editor_remove_gap`, `shiftClipsAtOrAfter` |
| Clip linking/unlinking (J-cut/L-cut) | `link`/`unlink` `EditOp`s (D-129, `av-linking.md`) |
| Sync lock | `Track.sync_locked` (D-106), enforced in ripple ops |
| Fade handles | `set_clip_fade` (D-147), `fade_in_frames`/`fade_out_frames` + curves |
| Keyframing (position/scale/rotation/opacity/crop) | `editor_set_clip_keyframes` — all of `position_x`/`position_y`/`scale`/`rotation`/`crop_*`/`opacity` are keyframeable per-clip |

## Real gaps (nothing in the model or tool surface covers these)

1. **Slip editing** — adjusting a clip's `source_start` (what part of the source plays)
   WITHOUT moving its `start_frame` or changing its `duration`. Every existing trim op
   changes duration; nothing changes only the source window in place. A real, missing
   `EditOp` (`slip`), small and well-bounded — clamped against `source_len` the same way
   `trim_start`/`trim_end` already are.
2. **Media swapping** — replace a clip's `source_path`/`media_id` while preserving its
   `start_frame`/`duration`/transform/keyframes/fades exactly. Nothing today lets you
   re-point an existing clip at different source media; the only way to change source is
   remove-and-re-add, which loses every other field. A real, missing `EditOp`.
3. **Blur as a keyframeable param** — `editor_set_clip_keyframes` covers `position_x`/
   `position_y`/`scale`/`rotation`/`crop_*`/`opacity` but `Clip` has no blur field at all
   (keyframeable or otherwise). Not just a keyframing gap — the base compositing model
   itself has no blur primitive.
4. **Audio volume keyframes within a clip** — `Track.gain` (D-057) is a track-level
   constant; nothing lets volume vary OVER TIME within one clip (a fade-up mid-clip, a
   ducking automation curve authored by hand rather than the existing `duck_from`
   auto-ducking primitive). A real gap distinct from track gain and from `set_clip_fade`
   (which only ramps at the head/tail, not an arbitrary curve).
5. **Markers (point & range)** — no marker concept exists anywhere in the Edit-tab model
   at all: no way to drop a note/flag at a timeline position or over a range that
   survives edits (ripples, trims) the way a real marker should. A foundational gap —
   several other Palmier features (Agent Review, part of Timeline Index) are built ON
   TOP of markers existing first.
6. **Agent Review (AI marker feedback workflow)** — depends on (5) existing first; not
   scoped further here since it's a whole separate workflow feature, not a primitive.
7. **Nested timelines (compound clips)** — placing one timeline as a single clip inside
   another, for reuse. `project.json` already models a project as `timelines: [...]`
   (plural) with an `activeTimeline` index, but nothing lets a TIMELINE be referenced
   AS A CLIP on another timeline. A real, structurally significant gap — likely needs a
   new `Clip` source-kind (source = another timeline id, not a media file) threaded
   through the compositor and exporter both.
8. **Timeline Index (transcript/caption/marker text-navigation panel)** — the DATA half
   of this now exists (D-189/D-190's `editor_get_transcript`, word-level timestamps,
   just merged into `main` this same session) but there is no UI panel that lets a human
   search the transcript text and jump the playhead to a match, or manage
   captions/markers as a navigable list. A real, currently-buildable gap now that the
   underlying transcript data is available — was not true before today's sidecar merge.
9. **Canvas guides (grid/safe-zone/format overlays)** — related to, but broader than, the
   canvas-boundary work already dispatched this session (roadmap item 18/the in-flight
   preview-fix agent): that work adds ONE frame showing the output composition's own
   edge. Palmier's "canvas guides" implies configurable overlays on top of that (a grid,
   broadcast-safe-title/action zones, aspect-ratio reference lines for a DIFFERENT target
   format than the current export). Scope as a follow-up to the canvas-boundary work,
   not a duplicate of it — check that agent's outcome before starting this.
10. **Frame capture (export the current composited frame as a still image)** — Colorist
    has still-image workflows for grading, but nothing in the Edit tab lets you grab the
    CURRENT COMPOSITE (whatever's showing in the multi-track preview, post-transform/
    keyframe/crop) as a new still image asset. A real, small, well-bounded gap — likely
    a single new Tauri command + MCP tool once the live-preview-compositor work (also
    in flight this session) lands, since it needs the same composite the fixed preview
    will already be able to render.

## Needs live verification, not a confirmed gap

- **Multiple timelines** — `project.json`'s own schema already supports an array of
  timelines with an active index (`activeTimeline`), and the real Edit-tab GUI (seen
  live this session, screenshot evidence) shows a tab strip with a "+" control next to
  the current timeline's name tab — suggesting this may ALREADY be a real, working
  feature, not a gap. Nobody has explicitly exercised "create a second timeline, switch
  between them" this session to confirm. Verify before assuming either way.

## Not scoped further here (out of this note's own scope)

Whichever of the above the owner wants built next is a real, separate dispatch each —
this note is the comparison or the "what's missing," not a build plan. Items 1–2 (slip,
media swap) are the smallest, most self-contained, and most clearly missing primitives
if a quick win is wanted first. Items 5–7 (markers, agent review, nested timelines) are
each substantial enough to warrant their own scoping pass before a build, not a
same-pass bundle with anything else.
