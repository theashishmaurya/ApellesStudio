# Timeline feature audit — what a real NLE has vs. what Apelles' Edit tab has (2026-09-04)

Owner, after a night of one-off live-tested bug reports on the NLE timeline: "can you not
do a Research and get all the cases for timeline instead of me telling you." Fair — this
is that pass. Real references checked (not memory), the actual current code audited
feature by feature (not assumed from decision docs — several of tonight's own docs turned
out to describe intent that didn't match what shipped, e.g. `fade_in`/`fade_out` fields
that were documented but never implemented, caught live by another fork), and a real
prioritized recommendation at the end.

**Companion, not a replacement, for `docs/notes/multi-track-nle.md`** — that note has the
full phased build history (A–F) for how multi-track editing came to exist here at all;
this note is a flat feature-by-feature checklist against real external references, useful
as a "is X built" lookup rather than a build log.

## References actually checked

- **Adobe Premiere Pro** — official Adobe help pages: trim mode
  ([helpx.adobe.com/premiere-pro/using/trim-mode-editing.html](https://helpx.adobe.com/premiere-pro/using/trim-mode-editing.html)),
  ripple edits
  ([helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-ripple-edits.html](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-ripple-edits.html)),
  selecting clips / marquee select
  ([helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/select-clips.html](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/select-clips.html)),
  markers overview
  ([helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/overview-of-markers.html](https://helpx.adobe.com/premiere/desktop/organize-media/apply-labeling/overview-of-markers.html)),
  lift/extract/ripple-delete
  ([adobe.com/learn/premiere-pro/web/lift-extract-ripple-delete-premiere](https://www.adobe.com/learn/premiere-pro/web/lift-extract-ripple-delete-premiere) —
  fetch timed out live; terminology cross-checked via the search index's own excerpt of
  that same page instead, flagged here rather than silently treated as a full read).
- **DaVinci Resolve** — the official Resolve manual (mirrored copy, Blackmagic's own PDF
  manual isn't a stable per-page URL): Timeline chapter
  ([steakunderwater.com/VFXPedia/.../part817.htm](https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part817.htm)),
  Speed Effects and Retiming
  ([steakunderwater.com/VFXPedia/.../part1263.htm](https://www.steakunderwater.com/VFXPedia/__man/Resolve18-6/DaVinciResolve18_Manual_files/part1263.htm)),
  plus Blackmagic's own product page and forum for sync-lock/track-lock behavior.
- **Palmier Pro** — this repo's own stated internal feature bar (`CLAUDE.md`: "use Palmier
  Pro... not manual ffmpeg/whisper scripting"). Its MCP tool *descriptions* are a real,
  concrete, available reference for a professional timeline's actual command surface —
  loaded and read directly (`manage_tracks`, `move_clips`, `remove_clips`, `split_clips`,
  `ripple_delete_ranges`, `manage_clip_links`, `manage_markers`, `set_keyframes`,
  `manage_multicam`, `apply_effect`), not paraphrased from anywhere else.
- **`docs/notes/multi-track-nle.md`** (this repo, 2026-09-03) — the real phased scoping
  already done for the multi-track build; read in full before writing this doc, not
  re-derived.

## The actual code audited (not assumed)

`crates/apelles-timeline/src/lib.rs`, `packages/editor/src/timeline.ts`,
`packages/editor/src/TimelinePane.tsx` — every claim below is checked against what's
actually there as of `D-105` (this pass's own gap-delete work), via direct reads and a
few targeted `grep`s (e.g. confirming there is exactly one `onKeyDown` handler in the
whole file, `Selection` is never an array, no `speed`/`linked_clip`/`playback_rate` field
exists anywhere in the model) rather than trusted from memory of earlier passes.

## Have — with the `D-NNN` that shipped it

| Feature | Where | Notes |
|---|---|---|
| N video tracks + N audio tracks | D-054/D-080 | `Timeline.tracks: Vec<Track>`, no hardcoded count |
| Real N-track video compositing (alpha-over, CPU) | D-088 | position/scale/rotation/opacity per clip |
| Audio mixing (N audio tracks + embedded video audio) | D-057 | sum + soft (`tanh`) limiter, `Track.gain` |
| Track lock | D-086/D-089 | blocks per-clip ops on that track, mirrors Rust `TrackLocked` |
| Track hide (video) | D-086/D-089 | compositor skips it; no audio-mixing effect (by design) |
| Track mute (audio) | D-057/D-080 | `Track.gain = 0` — no separate boolean, matches the real mixer field |
| Track reorder (compositing z-order) | D-089/D-096/D-098 | real `@dnd-kit/sortable` drag handle |
| Add/remove track | D-080 | + auto-create-on-drop-past-last-row (D-096) |
| Trim (both edges, neighbor-clamped, no-overlap) | D-054 | `trim_start`/`trim_end`, native library drag (D-051) |
| Split | D-041/D-054 | one boundary per call; multiple splits on one clip = multiple calls |
| Remove a clip (Lift — no ripple, leaves a gap) | D-054 | matches Premiere's Lift / Palmier's plain `remove_clips` exactly |
| **Select a gap, delete it (ripple close)** | **D-105 (this pass)** | matches Premiere's "Close Gap"/Ripple Delete, Palmier's `ripple_delete_ranges` — **single-track only**, see Partial |
| Reposition a clip (same-track) | D-058/D-100 | unified onto one `ClipBody`/`useDraggable` |
| Move a clip cross-track | D-080/D-094–100 | same unified mechanism as above |
| Ripple-insert a dropped clip between two touching clips | D-095/D-100 | snaps to nearest edge or a clip's own midpoint |
| Overlap rejection on every move (same- or cross-track) | D-104 | reverses D-096; the owner's explicit "never on top" direction |
| Edge-snapping during insert/move drags | D-095/D-100 | not a global toggle — see Partial |
| Native snap-to-edge/playhead for trim | D-051 (library's own `flexible`/`dragLine`) | |
| Clip transform (position/scale/rotation/opacity) | D-086/D-088 | |
| Clip keyframes (opacity/position/scale/rotation) | D-086/D-089/D-090 | reuses `RelightPanel.tsx`'s Diamond-icon pattern |
| Undo/redo | D-051/D-052 | whole-`Timeline` snapshot based, shell-level (spans all 3 tabs) |
| Waveform on clip | D-051 | Rust-computed (`chroma_audio_waveform`), plain `<canvas>` |
| Zoom (scroll-wheel + toolbar), real-timecode adaptive ruler | D-051/D-058 | |
| Global Inspector (typed property panel, both Motion + NLE halves) | D-081/D-099/D-102/D-103 | shared shell (`@apelles/inspector`) as of D-103 |
| Click a clip to select; click empty space to deselect | D-080/D-100 | |
| Click a real gap to select it; visual highlight | D-105 (this pass) | |

## Partial — real, but missing something a professional tool has

- **Ripple is single-track only.** Both `add_clip`'s insertion ripple and this pass's new
  `remove_gap` shift clips on the *one* track being edited — never propagate to other
  tracks. Every real reference has cross-track ripple: Premiere's "Ripple Edit, Trim, and
  Roll trailing clips in all unlocked tracks," Resolve's/Palmier's **Sync Lock**
  (`manage_tracks`'s `syncLocked` field: "whether ripple edits shift this track along" —
  confirmed real, on by default in Palmier). Apelles has no equivalent flag or mechanism at
  all — a ripple-close gap on Video 1 does not shift anything on Video 2, Audio 1, etc.,
  even if they were meant to stay in sync with it. Real, load-bearing gap for any
  filler-word-style multi-track edit (Palmier's own `ripple_delete_ranges` is explicitly
  built around this exact multi-track case — "the fast path for filler-word/dead-air
  removal").
- **Snapping exists but isn't a user toggle.** Edge-snap is hardcoded into the
  insert/move-drag math (`nearestEdge`/`computeInsertion`'s `snapFrames`) and the library's
  own trim drag (`dragLine`, always on). Premiere has a real Snap toggle (`S` key / a
  Timeline-panel button) the user can turn off entirely. Apelles has no way to disable
  snapping — not wrong for v1, but a real, checkable difference from every reference.
- **A/V linking is all-or-nothing, not a real relationship.** Apelles' model has exactly
  two states: audio embedded *inside* a video clip (D-050 — inseparable, always plays
  together, can't be independently trimmed) or a fully independent audio-track clip
  (D-057 — zero relationship to any video clip, moving one never moves the other).
  Premiere's Linked Selection and Palmier's `manage_clip_links` both have a real
  in-between: two *separate* clips that move/select together by default but can be
  deliberately unlinked for an L-cut/J-cut, then relinked. Apelles can't represent an L-cut
  or J-cut at all today.
- **Keyframeable properties cover transform, not everything a real tool keyframes.**
  Apelles: opacity/position/scale/rotation (D-086). Palmier's `set_keyframes` additionally
  covers `volumeDb`, `crop`, and `blur` — Apelles has no volume/gain keyframing (`Track.gain`
  is a static per-track multiplier, D-057, never animated) and no crop/blur at all (no
  effects stack — see Don't Have). **Update (2026-09-04, D-127):** the missing *crop*
  half now has a real home — Phase 3 of `docs/notes/on-canvas-transform.md`, which also
  confirms the absence directly (no `crop` field on `Clip`, nothing in
  `composite_layer_onto`) and finds a prerequisite nobody had noticed: the compositor's
  coordinate space is preview-resolution-dependent (**B-043**).

## Don't have at all

- **Multi-select.** `Selection` (`TimelinePane.tsx`) is `{track, id} | null` — never an
  array. No shift-click, no cmd/ctrl-click, no marquee/rubber-band drag-select (Premiere's
  own documented behavior: "start anywhere beyond the edges of a clip... overlap a clip,
  that clip segment is selected"). Every batch operation (move 3 clips together, delete 2
  gaps at once) is impossible today — confirmed by grep, there is exactly one `onKeyDown`
  handler in the whole file and it only ever reads a single `selected`/`selectedGap`.
- **Copy / paste / duplicate a clip.** No clipboard concept, no duplicate op, in either
  `EditOp` (TS) or `apelles-timeline`'s own op set (Rust).
- **Speed / time-remapping.** No `speed`/`rate`/`playback_rate` field anywhere on `Clip` —
  confirmed by grep across both the Rust crate and its TS mirror. Resolve has this as a
  first-class Retime Controls feature (`Cmd/Ctrl+R`); every reference checked has some
  form of it. A `Clip` here can only ever play at 1x.
- **Transitions.** Confirmed zero — matches `multi-track-nle.md`'s own "Phase E —
  Transitions: not started" status, unchanged since that note was written. A cross-dissolve
  needs Phase B3's blend-mode compositor (which exists, D-088) but nothing consumes it for
  a transition yet.
- **Timeline markers, native to Apelles.** Palmier has real persistent markers with a
  review-workflow status (`open`/`review`/`resolved`) via `manage_markers` — that's a
  *different tool's* markers on footage before it ever reaches Apelles, not something
  Apelles' own `apelles-timeline`/`TimelinePane.tsx` has any concept of. Premiere's markers
  are native to its own timeline the same way. Apelles' Edit tab has nothing analogous.
- **Nested sequences / compound clips.** `Timeline` is single-level — no clip type that
  references another `Timeline`. (Motion's manifest *can* nest via `<Series>`/scenes, but
  that's a completely separate model in `packages/motion-engine`, not the NLE timeline.)
- **Multicam.** Zero — Palmier's `manage_multicam` (sync camera angles from session audio,
  switch angles) has no Apelles equivalent at all. Likely genuinely out of scope for this
  product's real use case (talking-head/explainer content, not multi-camera shoots) rather
  than an oversight worth prioritizing — flagged for completeness, not urgency.
- **Non-color effects stack on Edit-tab clips.** Palmier's `apply_effect` (blur, sharpen,
  vignette, chroma key, film grain, etc. as a live merge-by-type stack) has no equivalent
  on a `apelles-timeline::Clip` — the Edit tab's compositor (D-088) does transform only
  (position/scale/rotation/opacity). Worth noting this may be a deliberate architectural
  split rather than a gap: this app's Colorist tab already owns a real, separate grading
  pipeline (curves/wheels/LUT/masks) — whether non-color *filter* effects belong on Edit-
  tab clips or should stay Colorist-only is a real product question, not just "missing,"
  and worth a real decision before building rather than assuming it belongs here.
- **Cross-track ripple / sync-lock as a real toggle.** Listed under Partial above for the
  ripple-op gap itself; listed again here because the *toggle mechanism* (Palmier's
  `Track.syncLocked`, Resolve's Sync Lock) doesn't exist as a field or concept anywhere in
  `apelles-timeline::Track` at all, not even a stub.
- **Keyboard shortcuts beyond Delete/Backspace.** Confirmed by grep — one `onKeyDown`
  handler, two keys. No Snap toggle key, no ripple/rolling-edit-tool keys, no split-at-
  playhead key (only a toolbar button), no nudge-clip-by-frame keys. Every reference
  checked has a real, non-trivial keyboard-shortcut surface for exactly these actions.

## Recommendation — real priority order, not everything at once

1. **Multi-select first.** It's the one gap that makes almost every other feature on this
   list meaningfully more useful once it exists (batch-move for a multi-track sync-locked
   ripple, multi-delete gaps, multi-clip transform edits) and blocks nothing else. Real,
   contained scope: extend `Selection` to a set, marquee-select via a pointer-drag
   rectangle over the edit area (a new, isolated interaction — doesn't touch the
   already-fragile single-drag mechanics D-094–100 spent all night stabilizing), shift/
   cmd-click to extend. Do this before cross-track ripple, since a good multi-select
   design changes what "select these N things, then ripple/delete them together" even
   needs to mean.
2. **Cross-track ripple / sync-lock second.** This is the single most-cited real gap
   against every reference checked, and Palmier's own `ripple_delete_ranges` treats it as
   the *default*, not an edge case ("sync-locked tracks shift along to preserve
   alignment"). Real scope: a `Track.locked`-shaped boolean (`sync_locked`, default `true`
   to match Palmier's own default), then extend `remove_gap`'s (D-105) and `add_clip`'s
   ripple logic to also shift every OTHER sync-locked track by the same delta, not just the
   track being directly edited. Contained — it's the same shift-by-delta math already
   proven working tonight, just applied to more tracks under a real guard.
3. **A real A/V linking model third** — genuinely needed once anyone tries to build an
   L-cut/J-cut, which the current all-or-nothing embedded-vs-independent audio model can't
   represent. Bigger than 1/2: needs a real `link_group` concept on `Clip` (or a separate
   linking table), touching selection (does selecting one select its linked partner?),
   move (do linked partners move together by default?), and the UI affordance to
   deliberately unlink. Scope this properly as its own note before starting, the way
   `multi-track-nle.md` did for the original build — don't improvise it inline.
4. **Everything else — speed/remap, transitions, native markers, a real snap toggle,
   volume/crop/blur keyframing, copy/paste, an effects stack — is real but lower-urgency**
   and mostly independent of 1–3. No single one of them blocks another; pick them up
   opportunistically or when a specific live-testing session surfaces a real need for one,
   rather than scheduling all of them now. Multicam is the one item on this whole list
   worth treating as out of scope entirely unless the product direction changes toward
   multi-camera shoots.
