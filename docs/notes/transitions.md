# Transitions — the worked design (D-224 / D-225, roadmap item 27)

**Status:** v1 shipped 2026-09-08. Two transition types (cross dissolve, dip to
colour), real live-preview compositing, real ffmpeg export, a drag-onto-a-cut
palette, and four `editor_*_transition` MCP tools. Verified by real pixel
measurement on **both** engines.

Reference material this was built from (CLAUDE.md's "research the real pattern
first"): DaVinci Resolve's own Edit-page copy for the *Transitions and Effects
Library* section (`scratch/resolve-reference/`, `edit-transitions`) — *"select
the effect you want and drag it onto a clip in the timeline or onto the cut
point between clips … Transition duration can be changed by dragging the edges
of the transition in the timeline or by changing it in the inspector"* — and
Adobe's own *Align and reposition transitions* / *Clip handles settings* help
pages for the alignment names and the insufficient-media behaviour. (The
reference set's `addeffects.jpg` is **Picture in Picture**, not the effects
library — its own README records that correction; `transitions.jpg` is the
effects-library entry and is only the toolbar icon, so the interaction came from
the section's text, which is the part that describes the gesture anyway.)

---

## 1. The problem

A transition needs **two clips visible at once** for its own duration. This
codebase's timeline has the standard NLE invariant that **clips on one track
never overlap**, and that invariant is load-bearing in more places than it first
looks:

| Where | What assumes it |
| --- | --- |
| `chroma_timeline::Track::clip_at` | `.find(…)` — returns **one** clip per track per frame |
| `Timeline::resolve_visible_video_layers_at` | one layer per track |
| `chroma_media::decode_pipe::PipeSlot::Track(usize)` | **one live `ffmpeg` process per track** |
| `Track::gap_at` / `clip_spans_from` | gaps and duck-trigger spans derived from non-overlap |
| `applyOp`'s `move` / `add_clip` (D-104) | overlap is *rejected*, never a reachable drag outcome |
| `TimelinePane` hit-testing / `resolveClipLanding` | one clip under a point |

## 2. The two real options

**Option 1 — real clip overlap.** Dropping a transition shortens each clip's
on-timeline duration and lets the two overlap by the transition's length; a
`Transition` object at the overlap names its type.

**Option 2 — a `Transition` bridging two still-abutting clips.** The clips do
not move. The transition owns a duration and an alignment, and during its own
window the compositor reads the outgoing clip's tail and/or the incoming clip's
head — frames *outside* each clip's own trim, i.e. **handle media**.

### Why option 2 (D-224)

Option 1 breaks every row of the table above, and one of them is not a
refactor but a real cost: two clips decoding on one track through
`PipeSlot::Track(i)` is exactly B-040's measured ~0.85 fps failure mode, so
option 1 would have needed the same second decode slot option 2 needs *plus*
a rewrite of clip resolution, gap math, the drag/landing rules and D-104's
overlap rejection.

Option 2 needs exactly three additions, each additive:

1. `Track::transitions: Vec<Transition>` (`#[serde(default)]`, no migration).
2. `Timeline::resolve_visible_video_layers_at` returns `VisibleLayer`s instead
   of a bare tuple, so a track can contribute two of them (or a generated
   colour plate).
3. `PipeSlot::TrackTransition(usize)`, the second decode slot.

Nothing about non-overlap, gaps, ripple, landing or hit-testing changes.

**What option 2 costs instead: handle media.** That is not a hidden cost — it is
the same trade Premiere and Resolve make, and it is why Premiere warns
*"Insufficient Media. This transition will contain repeated frames."*

## 3. The model

```rust
Track { transitions: Vec<Transition> }

Transition {
    id: String,
    kind: CrossDissolve | DipToColor,
    at_frame: i64,                 // THE CUT — outgoing.end == incoming.start_frame
    duration: i64,                 // timeline frames
    alignment: CenterAtCut | StartAtCut | EndAtCut,
    color: Option<String>,         // dip only; None = black
}
```

The **window is derived**, never stored, so changing the duration or the
alignment can never detach a transition from the cut it was dropped on:

| alignment | window | head handle (incoming) | tail handle (outgoing) |
| --- | --- | --- | --- |
| `center_at_cut` | `[at − d/2, at − d/2 + d)` | `d/2` | `d − d/2` |
| `start_at_cut` | `[at, at + d)` | 0 | `d` |
| `end_at_cut` | `[at − d, at)` | `d` | 0 |

Integer halving floors, so an odd duration puts the extra frame **after** the
cut — stated, and mirrored byte-for-byte by `timeline.ts`'s `transitionWindow`,
so the two engines cannot disagree by a frame.

`progress_at(pos) = (pos − start) / duration`, exactly — chosen so ffmpeg's own
frame-index-linear `fade` filter computes the identical number for the identical
frame rather than approximating it.

## 4. The two types, and why this pair

- **Cross dissolve.** The incoming clip fades up over the still-**opaque**
  outgoing clip, so ordinary source-over compositing yields
  `p·incoming + (1−p)·outgoing`. Exercises the two-clips-at-once resolution and
  the handle media. (Fading *both* toward the black base would give
  `p·In + (1−p)²·Out` — wrong, and the reason the outgoing half stays opaque.)
- **Dip to colour.** A full-frame plate of the chosen colour, alpha
  `1 − |2p − 1|` — nothing at the window's edges, fully opaque at its middle.
  The clip underneath is simply whatever `clip_at` already resolves (outgoing
  before the cut, incoming after), each showing only its own real frames, with
  the plate fully covering the instant they swap. **Needs no handle media at
  all**, which is why it is the second type: it is the one that always works.

Between them they prove both mechanisms. Wipes, slides and pushes are another
generated matte over the same two, which is why more types are additive later
rather than a redesign (D-225).

## 5. Live preview (`app/src-tauri/src/chroma/edit.rs`)

`Track::push_layers_at` owns the whole per-track decision and emits
**topmost-first**, the same ordering the flat cross-track list already uses, so
the compositor's existing "paint the list in reverse" needs no new rule:

- no transition → one layer, exactly `clip_at`'s answer, alpha 1.0
  (byte-identical to pre-D-224 for every project without transitions);
- dip → `[plate(alpha), clip_at]`;
- cross dissolve → `[incoming(alpha = p), outgoing(alpha = 1)]`, each read at
  its own handle frame via `Clip::clamped_source_frame_at`.

`VisibleLayer::alpha` is multiplied into the resolved opacity **last**, after
the clip's own static/keyframed opacity and its D-147 fade — the same
multiplicative composition, so a clip that is 50% opaque, fading out and
dissolving in is all three at once.

**Decode slots.** The **outgoing** clip keeps `PipeSlot::Track(i)` and the
**incoming** clip takes `PipeSlot::TrackTransition(i)`: at the moment a
transition starts, the outgoing clip's pipe is already warm and mid-stream, so
the transition does not stall the stream that is already playing. The incoming
clip migrates to the primary slot once, at the window's end.
`retain_pipe_slots` (was `retain_track_slots`) now takes real slots, because a
track-index keep-list could not express "release the partner but keep the
track", and would have leaked one `ffmpeg` process per transition.

## 6. Export (`packages/editor/src/timelineExport.ts`)

### Why not `xfade`

ffmpeg's `xfade` **concatenates**: two continuous streams in, `in1 + in2 −
duration` out, the blend at `offset`. This compiler's whole shape is the
opposite — every clip is an independent `-i` with its own `-ss`/`-t`, its own
filter chain, and its own `overlay … enable='between(t,…)'` onto a shared
`[base]`, which is what makes N tracks, gaps and stacking work at all. Routing
one cut through `xfade` would mean a second, concat-shaped pipeline beside the
overlay one, and reconciling their timing, for a blend the overlay model already
expresses exactly.

### What it emits instead

- **Cross dissolve.** The outgoing clip's input `-t` widens by its tail handle
  and its `enable` window extends to the transition's end (it stays opaque).
  The incoming clip's `-ss` moves back by its head handle, its `-t` widens to
  match, its `enable` window starts at the transition's start, and one
  `fade=t=in:st=<windowStart>:d=<len>:alpha=1` step is appended to its chain.
  `fade` **multiplies** the existing alpha plane (ffmpeg's `vf_fade` scales it),
  so it composes correctly with the crop mask and the `geq` opacity/fade step,
  and it is frame-index linear — literally `frame_index / nb_frames`, i.e.
  `progress_at`. That is what makes preview/export parity provable rather than
  hopeful.
- **Dip to colour.** A `color=…:d=<windowEnd>` filter **source** (no `-i`, no
  decode — the same shape `[base]` already uses), `format=rgba`, then two
  `fade … alpha=1` steps making the triangle, overlaid at the origin and gated
  to the window. `fade` rather than a `geq` alpha expression for cost: `geq` is
  a per-pixel expression over the whole canvas for every frame it sees.
- **Paint order.** A track's clips are now walked in **time order** (a stable
  sort on `start_frame`) rather than `Vec` order. A strict no-op without
  transitions — clips on one track never overlap, so their relative paint order
  is unobservable — and load-bearing with one, since the incoming clip must land
  on top. A dip plate is emitted after its own track's clips and before the next
  track's, so it never covers a track above it.
- **Audio is untouched.** A video transition is a video transition: Premiere and
  Resolve both keep audio transitions as separate effects. The widened input
  widens the clip's audio stream too, so an `atrim` puts it back to exactly the
  clip's own window and it is placed at its **natural** start. An audio
  crossfade is a separate, tracked feature.

### The bug this uncovered — B-102

Building the first dissolve test showed the incoming clip fully opaque from the
window's first frame. The cause was not the transition: **the video compiler had
never placed a clip in time at all.** Every `-i` decodes to a stream starting at
~0, `overlay` pairs its inputs *by timestamp*, and nothing shifted them — so a
clip at `start_frame > 0` had its real frames consumed against the base stream's
opening seconds (where its own `enable` gate was shut) and then showed its last
frame, frozen, for its entire window. The audio half always did place its
sources (`adelay`); the video half never grew the equivalent. Fixed with
`setpts=PTS+<start>/TB` at the head of every clip chain, which also gave the
graph a single time base and fixed the second half of the same bug (position
keyframes emitted in clip-relative seconds against `overlay`'s timeline clock).
See `docs/BUGS.md` B-102 — with a real regression test that uses a
two-colour source, the only fixture shape that can see it.

## 7. Placement rules (`checkTransition`)

One function, three callers — the palette's drop, the badge popover's edits, and
`editor_add_transition`/`editor_set_transition` — so a disabled state, a refusal
message and what `applyOp` actually enforces can never drift apart (the shape
`checkLink` established in D-138). It refuses, with a real reason:

- a non-video or locked track;
- `duration < 1`;
- a frame that is not a real cut (naming the cuts that *are* there);
- a window that would swallow a neighbouring clip whole;
- a window overlapping another transition on the same track — which is what
  lets `Track::transition_at` take the first match and be right;
- for a cross dissolve, **handle media that does not exist**, naming how many
  frames are missing and the alignment that would fit (`start_at_cut` needs no
  head handle, `end_at_cut` no tail) or the dip that needs none.

`Clip::clamped_source_frame_at`'s freeze-on-the-nearest-real-frame is therefore
the *last* line of defence, not the feature: `chroma_timeline_set` stores
whatever it is handed (D-058), so a hand-edited or dangling document can still
ask for a frame that is not in the file, and holding the nearest real one is the
only degrade that keeps rendering (and is what Premiere does).

A **dangling** transition — one side trimmed or deleted, so the cut no longer
exists — renders the plain cut in both engines rather than erroring.

## 8. Deliberately deferred

- **Dragging the transition's own edges** to re-time it on the timeline. The
  duration field in its popover is the other half of Resolve's own sentence and
  does the same job; the drag is a second, independent gesture layered on the
  same op. (D-225.)
- **More transition types** — wipes, slides, pushes, smooth cut. Additive once
  the mechanism is proven; each is a generated matte over §5's two paths.
- **Audio transitions** (constant-power crossfade at a cut) — a separate
  effect in both reference NLEs, and `set_clip_fade` (D-147) already gives a
  manual one.
- **Speed override + transition on the same clip** — refused at export compile
  time with a named reason. A speed override changes a clip's on-timeline
  footprint, so the cut the transition names is no longer where that clip's
  edge lands.

## 9. What is verified, and how

| Claim | Evidence |
| --- | --- |
| The preview really blends both clips | `chroma::edit`'s `preview_transition_tests` — real solid-colour media, real `timeline_frame` JPEG, decoded. Measured centre pixel mid-dissolve: **`[125, 0, 126]`** (red↔blue), against `[255,0,0]`/`[0,0,255]` for a hard cut. Includes its own hard-cut control. |
| The export renders the same blend | `timelineExportTransitions.ffmpeg.test.ts` — real ffmpeg, real decoded pixels at 0 / 25 / 50 / 75 / 100% through the window, monotonic, plus a hard-cut control, `end_at_cut`, dip-to-black, dip-to-green, and a dangling transition. |
| The window/handle arithmetic agrees across engines | `chroma-timeline`'s `d224_transitions` module and `timeline.test.ts`'s `D-224 transitions — model` assert the same numbers for the same inputs on both sides. |
| A project without transitions is unchanged | The whole pre-existing suite (856 TS tests, 186 Rust) passes with byte-identical export argv. |
