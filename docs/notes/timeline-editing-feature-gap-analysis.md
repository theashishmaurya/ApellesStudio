# Edit-tab timeline-editing feature gap analysis (2026-09-07)

Owner asked, pointing at a competitor's own docs (Palmier, a similar AI-native editor):
compare its documented timeline-editing feature set against what Apelles' Edit tab
actually has today, and scope the gaps. This is a comparison + scope note, not a build
log — nothing below has been built as part of writing this.

Method: cross-referenced Palmier's 17 documented timeline-editing features against
`packages/editor/src/timeline.ts` (the real `EditOp`/`Clip`/`Track` model),
`docs/notes/mcp-tool-coverage.md`'s Edit-tab tool table, and this session's own D-NNN/
B-NNN history. Every "have" below is traceable to a real `EditOp` case or MCP tool that
exists today — not assumed from a feature's plausibility.

## Already have (verified against real code)

| Feature | Apelles' real equivalent |
|---|---|
| Trimming | `editor_trim_clip` / `trim_start`/`trim_end` `EditOp`s (D-051/D-058 edge-drag) |
| Splitting/Razoring | `editor_split_clip` / `split` `EditOp` |
| Ripple editing | `ripple: true` on `add_clip`/`move_clip`, `editor_remove_gap`, `shiftClipsAtOrAfter` |
| Clip linking/unlinking (J-cut/L-cut) | `link`/`unlink` `EditOp`s (D-129, `av-linking.md`) |
| Sync lock | `Track.sync_locked` (D-106), enforced in ripple ops |
| Fade handles | `set_clip_fade` (D-147), `fade_in_frames`/`fade_out_frames` + curves; draggable on-clip handles on the timeline itself since D-207 |
| Keyframing (position/scale/rotation/opacity/crop) | `editor_set_clip_keyframes` — all of `position_x`/`position_y`/`scale`/`rotation`/`crop_*`/`opacity` are keyframeable per-clip |

## Real gaps (nothing in the model or tool surface covers these)

1. ~~**Slip editing**~~ **DONE (D-195, 2026-09-07).** A real `slip` `EditOp` in
   `packages/editor/src/timeline.ts` — adjusts `source_start` in place, clamped
   against `source_len` the same way `trim_start`/`trim_end` already are, lockstep
   with a linked A/V pair. MCP: `editor_slip_clip`. 8 new unit tests.
2. ~~**Media swapping**~~ **DONE (D-195, 2026-09-07).** A real `swap_media`
   `EditOp` — repoints a clip's `source_path`/`media_id` while preserving
   `start_frame`/transform/keyframes/fades/`link_group` exactly, re-clamping
   `source_start`/`duration` (never `start_frame`) if the new source is shorter,
   always re-reading `source_fps` from the new source. MCP:
   `editor_swap_clip_media`. 8 new unit tests. See D-195 in
   `docs/08-decisions.md` for the re-clamp judgment call's full reasoning.
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

11. **Previewing a source before you place it (a source viewer)** — owner, 2026-11-04,
    hit live while building the launch film: "when i click on something i should be able
    to preview". Clicking a media tile in Sources does **nothing** unless you are in
    multi-select mode — `SourcesPanel.tsx`'s tile is
    `onClick={() => selecting && toggleSelected(it.id)}`, so outside that mode the click
    is swallowed. The only ways to see what a source actually is today are its static
    thumbnail, dragging it onto the timeline, or `editor_get_moment_view` from an agent.
    Every NLE answers this with a source viewer: Premiere and Resolve open the clip in a
    Source monitor with its own playhead and In/Out marks; Final Cut skims it in place
    under the pointer. Apelles already has most of the parts — `scrubSource.ts` exists,
    the preview surface can draw any `{sourcePath, sourceFrame}` pair (that is exactly
    what `chroma_preview_surface_two_up` does for the trim viewer, roadmap 00r 5d c), and
    the decode lanes are per-purpose already (`PipeLane::TRIM_VIEW`), so a `SOURCE_VIEW`
    lane is the same shape. The missing pieces are the click-to-open behaviour, somewhere
    to put the picture (the existing preview, switched to source mode, versus a second
    pane), and In/Out on the source so a marked range can be dragged to the timeline.
    Both halves per CLAUDE.md: the GUI click AND an MCP equivalent for setting/reading the
    source-view position and its marks. Not scoped further here, per this note's rule.

12. **Duplicating a clip** (B-394) — owner, 2026-11-04, hit live: "control D does not
    dublicate". There is no `duplicate_clip` `EditOp`, no context-menu item and no key
    binding, so Cmd/Ctrl+D lands on nothing. The verb already exists three times in the
    app for other objects — `editor_duplicate_timeline` (and the Duplicate item in
    `TimelineSwitcher.tsx`), `motion_duplicate_scene`, `motion_duplicate_layer` — which is
    what makes its absence on clips surprising rather than merely missing. Scope: duplicate
    the selection carrying transform, keyframes, fades, volume and link group (the same set
    `swap_media` preserves), placed either immediately after the source clip or on the next
    free track; plus the matching `editor_duplicate_clip` tool, per this repo's both-interfaces
    rule. Today's workaround is to read the clip's fields and re-place it by hand.

13. **Conform a music track to the timeline's length (a "Remix")** — owner, 2026-11-04,
    after an hour of hand-splicing a bed for the launch film: "thats the skill we want to
    build :( you should be able to do it". The job is ordinary and comes up on every edit:
    a stock track is 82 s, the film is 51 s, and the cut has to lose ~31 s from the middle
    while keeping the track's own intro AND its ending, with no audible join. Apelles has
    the parts — `editor_detect_beats` (tempo, bars, strong beats), `editor_music_edit` /
    `editor_propose_music_edits` (dropouts, breaths, dry opens, D-408), fades and
    crossfades — but nothing that solves for LENGTH. So the agent ends up hand-cutting in
    ffmpeg, which is exactly what this repo's tools exist to prevent, and every attempt was
    audible.
    **What it has to do, learned the hard way tonight:** remove a whole number of PHRASES
    (4/8/16 bars), not bars — 17 bars broke the phrase structure and sounded wrong even
    though the beat grid lined up; cut in the quiet valley just before a downbeat rather
    than through a peak; match the ARRANGEMENT either side (a spectral match, not a
    loudness match — two points can be identical in RMS and obviously different in
    instrumentation); use a short butt-cut on the transient rather than a long crossfade,
    which smears; and refuse honestly when the track's structure cannot support the target
    length (a dense section with no quiet point has nowhere to hide a join — the right
    answer is then "pick a track nearer the target length", which is what a human editor
    does). Prior art to copy rather than invent: Adobe Audition's Remix, Audjust's beat
    cutter. Both interfaces per CLAUDE.md: a GUI "fit to timeline" on a music clip and an
    `editor_conform_music` tool that reports WHERE it cut and why, so the choice is
    reviewable like `editor_propose_music_edits` already is.

    **Prototyped 2026-11-07, and it is not enough.** `scratch`'s `music_conform.py`
    (~140 lines, librosa + numpy, both already in `ai-env`) implements what Adobe
    documents for Remix: beat-track the file, take beat-synchronous chroma + MFCC +
    RMS, cost every beat against every other beat (scoring the lead-in as well as the
    landing), then a DP over (beat, beats emitted) for the cheapest path of exactly the
    target length, keeping the first and last beat. It runs in ~20 s, hits the target
    to the frame, and on the launch film's 82.5 s track chose one jump, 43.40 s →
    66.06 s. **The owner could still hear it**, on that and on every variant. Two real
    limits found: librosa locks to the half-time grid (89.1 BPM on a ~126 BPM track)
    and `start_bpm` is only a prior, so subdividing is the reliable way to get more
    candidate points; and the minimum-jump constraint as written does not bind, so
    "spread the removal over several cheap joins" was never actually tested. The
    deeper problem is that rearranging a finished recording leaves a seam wherever the
    arrangement differs, and a dense trailer bed differs almost everywhere.

    **Generate at length rather than cut to length** (owner, 2026-11-07: "we need ai
    solution for these"). Stable Audio 3.0 (Stability AI, May 2026) ships open weights
    for its small and medium models, runs locally, is trained on licensed data, and its
    generation length is adjustable **down to the second** — so a 51.64 s bed is
    produced as 51.64 s with no edit anywhere, and the Content ID question goes with
    it. That suits this repo's local-first rule and the existing `ai-media` sidecar
    shape. Keep the conform path for a track the person brings themselves; generation
    becomes the default once it exists.

## Multiple timelines — VERIFIED WORKING, not a gap (D-195, 2026-09-07)

Confirmed live, not just from reading code: extended the D-142 browser harness
(`app/harness.html`/`app/src/harness-main.tsx`) to mount `TimelineSwitcher` alongside
`TimelinePane` against a real in-memory multi-timeline fake backend (mirroring
`chroma::edit`'s `chroma_timeline_list`/`_create`/`_set_active`/`_get`/`_set` exactly),
then drove it with real Chromium `PointerEvent`s via chrome-devtools MCP: clicked the
"+" tab, typed a name, pressed Enter — a real second timeline ("Alt Cut") was created
and became active, `TimelinePane` correctly showed it as empty. Added distinct content
to each of two timelines, switched back and forth by clicking their tabs, and confirmed
by reading both the store's live state and the fake backend's own map that each
timeline's content is fully independent — no bleed either direction, both persist
correctly. Rust's own `multi_timeline_create_list_and_set_active_round_trip` test
(`app/src-tauri/src/chroma/project.rs`) already covered the backend half of this; this
pass is the first time the FRONTEND click-through path was actually exercised.

**One real bug found during this verification, filed as B-080 in `docs/BUGS.md`, not
fixed here:** switching or creating a timeline while an edit's debounced save (400ms,
`SAVE_DEBOUNCE_MS`) is still pending silently drops that edit — it never reaches disk
and is no longer recoverable from memory either, with no error or warning of any kind.
The basic feature (create/switch/persist/isolate, given >400ms between an edit and a
switch) is unaffected and works correctly; the bug is specifically about that race.

Also fixed, in the same pass, a real usability defect in the D-142 harness itself (not
a product bug): its `#harness-status` debug overlay was pinned top-LEFT, directly over
`TimelineSwitcher`'s own top-left tab strip, silently eating real pointer clicks on the
tabs even though the accessibility tree still reported them as clickable — moved to
top-right. See B-080's own "harness note" for the full detail; worth remembering for
the next feature that mounts UI at the very top of this harness.

## Not scoped further here (out of this note's own scope)

Whichever of the above the owner wants built next is a real, separate dispatch each —
this note is the comparison or the "what's missing," not a build plan. Items 1–2 (slip,
media swap) were the smallest, most self-contained, most clearly missing primitives —
now done, D-195. Items 5–7 (markers, agent review, nested timelines) are each
substantial enough to warrant their own scoping pass before a build, not a same-pass
bundle with anything else.
