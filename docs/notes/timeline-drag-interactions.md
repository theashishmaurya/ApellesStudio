# Timeline drag interactions — the full map (2026-09-10, D-303 / D-304)

`packages/editor/src/TimelinePane.tsx` is ~4600 lines and hosts **seven structurally
different drag gestures**, spread across **three independent drag systems** that share
one surface. Every drag bug this project has had (D-094 → D-100's six-round stabilization,
B-115, B-122, B-134, B-137, B-144, B-145, B-160) came from not being able to tell those
apart at a glance. This doc is the map, so the next person does not have to re-derive it.

Written while root-causing **B-145** ("when i move this instead of moving it moves to very
starting") and **B-160** ("drag and drop in the timeline is still not smooth and animations
are shakky"). Both were real and both were in here; the causes were unrelated to each other.

---

## The three drag systems on one surface

| # | System | Who owns the gesture | Which gestures |
|---|--------|----------------------|----------------|
| 1 | **`@dnd-kit/core`** — one `<DndContext>` in `TimelinePane` | `PointerSensor`, `activationConstraint: {distance: 4}` | clip move (same-track, cross-track, create-a-track), slip/slide body drag, track-header reorder, transitions-palette drop |
| 2 | **Native HTML5 drag & drop** — `onDragOver`/`onDrop` on the edit area | the browser's own `DataTransfer` | Sources-panel media drop, library-rail generator (title / adjustment-clip) drop |
| 3 | **The timeline library's own `interact.js`** (`@xzdarcy/react-timeline-editor`) | the library | clip EDGE trim/resize only (`movable: false` — D-100 took the library's move-drag away entirely) |

Two more gestures are neither of the above and are structurally separate:

- **Marquee select** — the pane's own `window`-level `pointermove`/`pointerup` listeners
  (`marquee.ts`, D-137). Mutually exclusive with a clip drag *by DOM position*:
  `canStartMarquee` refuses any press whose propagation path carries
  `data-chroma-clip-drag`, which is exactly the dnd-kit draggable node. It never reads
  `event.delta`, never touches `resolveClipLanding`, and shares no state with the drag
  paths — **it is not implicated in B-145 or B-160** (checked, not assumed).
- **Playhead scrub** — the library's own cursor drag (`onCursorDragStart/-ing/-End`,
  D-232).

---

## The one thing to know before touching any dnd-kit path (B-145)

> **`event.delta` is not usable in this pane. Use `dragPx(event)`.**

dnd-kit defines `delta` as `translate + scrollAdjustment`, and computes `scrollAdjustment`
against the scrollable ancestors of **`over?.node ?? active.node`** — a set that *changes
mid-drag* the moment a droppable resolves. In this pane those two chains are different by
construction:

```
dragged ClipBody   →  .ReactVirtualized__Grid  (the library's h-scrolling grid) → … → <html>
TrackDropZone      →                                                              … → <html>
```

The clip lives *inside* the library's scrolling grid; the `TrackDropZone` droppables are
overlay siblings *outside* it (they must be — they are positioned over the rows in the
pane's own overlay layer, which does not scroll with the grid). So dnd-kit captures the
grid's `scrollLeft` as the drag's "initial" scroll, then measures the live offset against a
chain the grid is not in, and `delta` is short by the full scroll offset for the rest of the
gesture. Measured live: scrolled 2000px, dragging a clip +150px, `event.delta.x` reads
`-1850`.

Because that error is proportional to how far you have scrolled, and you scroll to *where
the clip is*, the wrong landing is always ≈ the clip's own position minus its own position
— i.e. **frame 0**. That is B-145 exactly.

**The replacement** is `dragDelta.ts` (`dragPx` in the pane):

- **screen displacement** = `active.rect.current.translated.left − active.rect.current.initial.left`.
  Those are dnd-kit's own public rects, both derived from the same `draggingNodeRect` in the
  same layout effect, and `translated` applies `modifiedTranslate` — the translate *before*
  any scroll adjustment. Their difference is the pure pointer movement.
- **content displacement** = screen displacement + (the pane's own `scrollLeft`/`scrollTop`
  now − at drag start). The pane already tracks both through the library's `onScroll`; a
  `scrollRef` mirrors them for the memoized `onDndDragStart`, which snapshots the origin.

Which one each consumer wants is not interchangeable:

| Consumer | Uses | Why |
|---|---|---|
| `onDndDragMove` landing preview | `contentX` | a frame position in the timeline's content |
| `onDndDragEnd` clip move | `contentX` | same |
| `onDndDragEnd` new-track branch | `contentX` | same |
| `bodyDragOp` (slip / slide) | `contentX` | a frame delta |
| `dndBoundary` (is the pointer over the pane; which row) | `screenX`/`screenY` | added to `activatorEvent.clientX/Y`, compared against `getBoundingClientRect()` — viewport space |
| transitions drop (`contentX` local var) | `screenX` | added to a `clientX` and converted to content space *right there* by `− rect.left + scrollLeft`; using the content delta would count the scroll twice |

`dragDelta` returns `null` when dnd-kit has no measurement, and the move branch **refuses**
rather than committing a landing — a silently-zero delta would commit a no-op `move` op,
which is still an undo entry and a debounced save.

---

## Gesture-by-gesture, pointer-down to `applyOp`

### 1. Clip move, same track (dnd-kit)

```
pointerdown on ClipBody (data-chroma-clip-drag)
  → onPointerDownCapture: trimPressRef = {altKey, shiftKey, bodyYRatio, tool}   (D-235/D-261)
  → clipGrabRef = where in the clip the press landed + its measured width       (B-137)
  → PointerSensor activates past 4px
  → onDndDragStart:  dragScrollOriginRef = current scroll; setActiveDrag; setClipGrab
  → onDndDragMove (every tick):
        overTrack = laneDropTrack(event.over)            → the row under the ghost
        moved     = dragPx(event)
        intended  = clip.start_frame + round(moved.contentX / pxPerSec * fps)
        landing   = resolveClipLanding(tracks[overTrack], …, intended, snapFrames, fps)
        → dragPreviewRef.setLanding(landing)             (change-gated)
  → onDndDragEnd: the SAME computation, once, then
        applyOp({kind:'move', fromTrack, toTrack, clip: i, startFrame, ripple})
        setSelection([{track: toTrack, id: clipId}])     (a drag is also a pick)
```

`resolveClipLanding` (`timeline.ts`) removes the moving clip from the destination by id and
defers to `computeInsertion` — snap to a clip edge (or 0) within `INSERT_SNAP_PX` (28px, so
the frame radius grows as you zoom out), else the plain fit, else the nearer half of
whatever clip is under the frame, else append at the end. **Landing on top of another clip
is never a reachable outcome** (D-104, owner's explicit direction).

### 2. Clip move, cross track (dnd-kit)

Identical code path. `event.over`'s track differs from the clip's own, and that is the only
difference — there is no second branch. Two consequences worth knowing:

- The source track, if this emptied it, is **pruned** (`pruneIfEmptyTrack`), which renumbers
  every track below it. Anything holding a track index across the op must remap.
- An A/V-linked partner moves by the same frame delta but **stays on its own track**
  (D-129, matching Resolve).

### 3. Clip drag that creates a new track (dnd-kit)

Reached when `laneDropTrack(event.over)` is `null` — i.e. the ghost is above the first row,
below the last, or in the band between two (`trackInsertBoundary`, ±`TRACK_INSERT_BAND_PX`).
Guarded by `dndBoundary`, which first refuses any drop whose real pointer is outside the edit
area at all (B-115), then resolves *which* boundary from the dragged rect's own top edge.

Three `applyOp`s in sequence for one gesture:

```
applyOp add_track                                   → always appended at tracks.length
applyOp move_track (only if boundary ≠ that index)  → into place
applyOp move (fromTrack resolved through trackIndexAfterMove, toTrack = boundary)
```

`trackIndexAfterMove` is required because inserting above the source track shifts it. This
sequence was audited during B-145 and is correct — verified live at three boundaries (above
the first track, between two, past the last) at 43% zoom with the timeline scrolled 8901px:
all three landed on the same frame as the equivalent same-track drag. The three ops are three
undo entries, which is a real (small, logged-nowhere-else) wart, not a correctness bug.

### 4. Slip / slide body drag (dnd-kit, same press as #1)

Claimed *before* any landing math, by either entrance: Alt/Option held (D-235) or a palette
tool that owns body drags (Slip/Slide, D-261). `bodyDragOp` gets `round(contentX / pxPerSec *
fps)` and returns its own op; `event.over` is deliberately never consulted, because neither
edit may change track. A **claimed** gesture never falls through to the move path even when
it produces no op (a clamped slip must not silently become a move).

> **Known open cosmetic bug here: B-144.** A slip/slide still paints the `DragOverlay` move
> ghost it is not going to perform. Deliberately left — see its entry.

### 5. Track-header reorder (dnd-kit + `@dnd-kit/sortable`)

`SortableTrackHeader` → `headerDropIndex(event.over)` → `doMoveTrack(from, to)`. Resolves
against another **header**, never a lane — `dndTargets.ts` gives the two questions separate
functions precisely because they used to be indistinguishable (B-122). No delta math at all,
so B-145 never touched it.

### 6. Transitions-palette drop (dnd-kit)

`PaletteEntry` (`TimelineTransitions.tsx`) is a plain `useDraggable` with
`data: {type:'transition', kind}`. It has no `DragOverlay` ghost of its own. On drop:
reconstruct the pointer x (`activatorEvent.clientX + dragPx().screenX`), convert to content
x, find the nearest **cut** within `TRANSITION_SNAP_PX` (24px), and refuse with a real
sentence if there isn't one, if the track is not video, or if the model says there is not
enough handle media. Verified post-fix at 43% zoom scrolled 9668px: the drop landed exactly
on the cut (`at_frame: 6240`).

### 7. Sources / generator drop (native HTML5)

A completely separate system: `onDragOver` (only `.types` is readable during dragover, per
spec) → `insertPreview`; `onDrop` reads the payload and calls `placeDroppedClip`, which uses
`e.clientX/clientY` with the edit area's rect and the pane's own `scrollLeft`/`scrollTop`
directly. **No dnd-kit, no `delta`, so B-145 never affected it** — it was already computing
absolute positions the honest way, which is part of why the two paths disagreed.

---

## Why the drag felt shaky, and what changed (B-160 / D-304)

Separate bug, separate cause, found by measuring rather than assuming.

Measured on the real component in a real browser (`app/harness.html` + CDP, 4 tracks × 6
clips, stubbed backend — far smaller than a real edit), during a plain clip drag:

| | renders of `TimelinePane` per 41 pointer-moves | frame interval p50 | p90 | max |
|---|---|---|---|---|
| idle (no drag) | — | 16.7ms | 17.3ms | 18.6ms |
| **before** | **88** | 16.7ms | **24.3ms** | **47.8ms** |
| after | 4 | 16.7ms | **17.0ms** | — |

What it was **not**: layout thrashing (2 `getBoundingClientRect` calls per move), DOM churn
(1-2 mutations per move), long tasks (none), or `framer-motion` (not a dependency of this
repo at all — checked). The pane's only real animation is a Tailwind `animate-pulse` ring on
rippled clips.

What it **was**: the live landing preview's state (`clipDragPreview` + `insertPreview`) lived
on `TimelinePane` itself. D-201's own audit had asked exactly this question and answered
"no, it's change-gated" — but at any ordinary zoom a few pixels of movement *is* a different
landing frame, so the gate almost never fires. Every tick therefore re-rendered the app's
largest component — ruler, every track, every clip, every filmstrip and waveform — to move
four small absolutely-positioned boxes. Confirmed by contrast: the Alt/slip path, which
D-235 already skips this state for, held p90 at 18ms with 4 renders for the whole gesture.

**D-304** moved that state and those four overlays into `TimelineDragPreview.tsx`, written to
via a `useImperativeHandle` (nothing in the pane ever *reads* the preview, only sets it), so a
tick re-renders that subtree instead of the pane.

This is the same defect class as **B-024** ("re-rendering N tracks' worth of actions on every
tick is what actually froze the UI") reached from the other side: B-024 was a prop identity
changing every tick; this was the parent re-rendering every tick.

---

## Testing tiers for this surface, and what each can actually reach

1. **Pure** (`timeline.test.ts`, `dragDelta.test.ts`, `dragGhost.test.ts`, `marquee.test.ts`)
   — placement math and drag arithmetic. Fast, exact, and where the "correct answer" rules
   in `CLAUDE.md` apply.
2. **jsdom DOM** (`TimelinePane.*.dom.test.tsx`, on `testUtils/pointerHarness.ts`) — real
   `PointerEvent`s, real component tree, no layout engine. Two facts must be stubbed for a
   drop to resolve at all: each `TrackDropZone`'s box (tie it to its own row's), and the
   grid's `scrollLeft`. **Note the grid there are two of** — the ruler's and the edit area's;
   stub the one that `contains()` the dragged clip, or the stub silently does nothing.
   The library's interact.js **edge resize cannot be driven in this tier at all** (D-235,
   re-verified by B-137).
3. **Real browser** (`app/harness.html` + `mcp__chrome-devtools__*`) — real layout, real
   dnd-kit rect measurement, real scroll, real frame timing. The only tier that can reach a
   scrolled same-track drag (see `TimelinePane.clipDrag.dom.test.tsx`'s header for why jsdom
   reproduces B-145 on the cross-track gesture but not the same-track one) and the only one
   that can measure smoothness. **Remember `isPrimary: true`** on every synthetic
   `PointerEvent` — dnd-kit's `PointerSensor` silently ignores a press without it, and the
   drag simply never starts.
4. **The real app** (WKWebView) — still different from Chromium, and this repo's history is
   "looked fine in code, broke on real pointer input." Nothing above substitutes for it.

---

## Open / known-left on this surface

- **B-144** — a slip/slide drag still shows the move-preview ghost. Root-caused, deliberately
  unfixed: removing the only large moving element from those gestures is a design call for
  the owner, not a change to smuggle into a bug fix.
- **Zoom changing mid-drag** reinterprets an already-accumulated pixel displacement through a
  new `pxPerSec`. Not currently reachable by accident (the ctrl/pinch-wheel zoom during a
  held pointer drag is awkward at best) and not fixed; noted so it is not re-derived from
  scratch if it ever shows up.
- **The create-a-track drag produces three undo entries** for one gesture (`add_track`,
  `move_track`, `move`). Correct, but a single user action ought to be a single undo.
