# Should the NLE timeline move onto `@dnd-kit`? — scoping (2026-09-04)

Owner, live, after a long run of hand-rolled HTML5-drag fixes (D-094/D-095/D-096) still
feeling like friction: "also drag above below, in the track also its not very quick and
free :/ may be use the DND kit to full of its extension" — naming **`@dnd-kit/core`**
(+ `@dnd-kit/sortable` for the track-reorder case) as a specific, considered direction, not
just "this feels bad." This note is the scoping pass that request asked for — **a real plan,
not a migration** (per `CLAUDE.md`'s own dependency rule: license + maintenance status
checked, not assumed, before any `D-NNN` proposing a new dependency). Nothing in this note
has been implemented.

## Why this is a real question, not just "the owner is unhappy"

Everything tonight's drag-and-drop work (D-094 track reorder + cross-track clip move,
D-095 Sources-panel ripple-insert + drop-preview, D-096 mid-boundary track insert) is built
on the **native HTML5 `dataTransfer` drag/drop API** directly — `draggable`, `onDragStart`/
`onDragOver`/`onDrop`, `DataTransfer.setData`/`getData`. Real, inherent limits of that API
that every one of tonight's fixes had to work *around*, not *with*:

- **No first-class drag-preview control.** The browser's default drag image is a live DOM
  snapshot at `dragstart` time, frozen for the whole gesture — no smooth cursor-follow, no
  resize-with-zoom (this is exactly **B-027**'s drag-ghost-size complaint: fixed with a
  small custom pill via `setDragImage`, a real but narrow workaround, not a real solution).
- **Coarse, poll-like `dragover` granularity**, and per the spec `dataTransfer.getData` is
  **unreadable until drop** (only `.types` is available during `dragover`) — this is the
  exact reason D-095's live insertion-preview can only show *where* a drop will snap, not
  *whether* it'll ripple, until the actual drop (`computeInsertion` only runs then). A
  pointer-sensor-based library doesn't have this restriction — the dragged item's full data
  is known throughout the gesture.
- **No native multi-container/sortable primitives.** Track reorder (D-094) and cross-track
  clip move (D-094/D-096/B-027) are exactly the "drag between/within multiple containers"
  shape `@dnd-kit/sortable` is purpose-built for; this codebase reimplemented that from
  scratch — `dropTargetTrack`'s manual `clientY`→row math, `trackIndexAfterMove`'s manual
  selection-follow algebra, a hand-rolled `insertPreview` overlay system.
- **Coexistence risk with the timeline library's OWN drag.** `@xzdarcy/react-timeline-editor`
  drives same-track clip repositioning and edge-trim via **its own pointer-based (interact.js)
  drag**, not native HTML5 `draggable`. Every cross-track-move design in this file has had to
  very deliberately avoid the two drag systems fighting over the same `mousedown` — B-027's
  own regression (full-width strip → same-track drag silently stopped working) is a direct,
  live example of this exact class of risk actually firing, not a hypothetical.

None of this is fixable by writing *more* native-HTML5-drag code, carefully. It's the shape
of the API. A pointer/keyboard-sensor library with a real drag-overlay primitive (dnd-kit's
actual model) removes the whole class, not just this session's specific instances of it.

## What `@dnd-kit/core` / `@dnd-kit/sortable` actually are — checked, not assumed

Checked live against the npm registry + the real GitHub repo (`clauderic/dnd-kit`), not
recalled from training data — this project's own last real dependency check (D-091's React
Compiler research) already established that recalled version/API details for fast-moving
JS tooling are often stale enough to be actively wrong:

| | `@dnd-kit/core` | `@dnd-kit/sortable` |
|---|---|---|
| License | **MIT** | **MIT** |
| Latest npm version | `6.3.1` | `10.0.0` |
| Latest npm publish | **2024-12-05** | 2024-12-04 |
| Peer deps | `react >=16.8.0`, `react-dom >=16.8.0` | `react >=16.8.0`, `@dnd-kit/core ^6.3.0` |
| Own deps | `@dnd-kit/utilities`, `@dnd-kit/accessibility`, `tslib` | `@dnd-kit/utilities`, `tslib` |
| Unpacked size (core) | ~1.04 MB (source, pre-minify/tree-shake — the real bundle-size cost is smaller but not yet measured) | — |
| Repo state | **Not archived.** 17.6k stars, 129 open issues, **last push 2026-07-13** (recent — active development) | same repo |

**The real, honest catch**: no NEW npm release since December 2024 (~19 months of real
ongoing repo activity that hasn't shipped to npm), and the active development on `main`
right now is a **not-yet-released rewrite** around a new `DragDropProvider`/manager API —
confirmed via a real currently-open issue, **#2116, "React 19: DragDropProvider manager is
destroyed during Strict Mode replay"** (updated 2026-08-09), which names an API surface that
doesn't exist in the published `6.3.1`. So:
- What we'd actually install today (`6.3.1` / `10.0.0`) is the **older, pre-rewrite**
  `DndContext`/`useDraggable`/`useDroppable`/`useSortable` hook API — stable, widely used
  for years, peer-deps-compatible with React 19 on paper — but the specific React-19-
  StrictMode edge case above is being fixed against the *unreleased* rewrite, not backported
  to `6.x`. Real risk: if this app hits that specific StrictMode/double-invoke interaction
  (plausible — `main.tsx` doesn't currently wrap the tree in `<StrictMode>`, checked; if that
  ever changes, this becomes live risk, not currently), there's no shipped fix to pull.
- **This is a live risk for this app specifically, not a hypothetical** — checked
  `app/src/main.tsx`: the app root IS already wrapped in `<React.StrictMode>` (line 139),
  which is exactly the condition issue #2116 is about. That issue is against the unreleased
  rewrite's `DragDropProvider`, not confirmed to reproduce on the published `6.3.1`'s
  `DndContext` — the two architectures aren't the same code — but it's a real, documented
  StrictMode-interaction class of bug in this library's own current development, on the
  exact React setup this app runs, and not something to wave off as "won't apply to us."
  A real spike (phase 1 below) needs to explicitly StrictMode-test the coexistence, not
  just the happy path.

## What would actually move, versus what shouldn't

Scoped against the real current file, `packages/editor/src/TimelinePane.tsx` — not "convert
everything," a deliberate split:

**Real dnd-kit fits (the two things the owner is actually naming as slow/janky):**
- **Cross-track clip move** (D-094/D-096/B-027's `CHROMA_CLIP_MOVE_MIME` strip mechanism) —
  a `useDraggable` source per clip + `useDroppable` per track row, with `DragOverlay` giving
  a real, smooth, pixel-accurate cursor-follow ghost (not a frozen DOM snapshot) and a proper
  `onDragEnd` carrying full item data immediately (no `dataTransfer.getData`-is-drop-only
  workaround needed for a live insert/ripple preview — D-095's preview logic gets
  *strictly better*, not just ported, since the real dragged-clip duration is known
  throughout the drag, not just at drop).
- **Track reorder** (D-094's header-row `GripVertical` handle) — `@dnd-kit/sortable`'s
  `SortableContext` + `useSortable` is *exactly* this shape (a vertical list of reorderable
  items) — `trackIndexAfterMove`'s hand-written selection-follow algebra becomes
  `arrayMove` (a real, tested primitive `@dnd-kit/sortable` already ships), not custom code.
- **The `insertPreview` ghost-row/insertion-line overlay** (D-095/D-096) — becomes a real
  `DragOverlay` render, not a manually-positioned `pointer-events-none absolute` div computed
  from raw `clientY`/`ROW_HEIGHT` math.

**Should stay on the timeline library's own native drag — not a dnd-kit candidate:**
- **Same-track clip reposition and edge-trim** (`flexible`/`dragLine`, native to
  `@xzdarcy/react-timeline-editor` since D-051) — this is NOT what the owner is complaining
  about tonight (their exact words were about cross-track and track-reorder feeling slow;
  same-track drag/trim has worked well since D-051 and B-027's regression was Apelles' own
  code accidentally breaking it, not the library's mechanism being at fault). Replacing a
  working, purpose-built mechanism with a hand-rolled dnd-kit equivalent would be a straight
  regression risk for zero real gain — `@xzdarcy/react-timeline-editor` was never going to be
  dnd-kit's to own; sub-clip time-axis dragging with frame-accurate resize handles is a
  timeline-library concern, not a general-purpose drag-and-drop one.
- **Sources-panel → timeline drop** (`CHROMA_MEDIA_DRAG_MIME`, D-046/D-095/D-096) — a
  real candidate *in principle* (dnd-kit supports cross-boundary drags from outside a
  `DndContext` via manual sensors), but genuinely secondary: it's a single drag SOURCE type
  into the SAME drop surface the clip-move migration would already touch, so it's a natural
  follow-on once the core timeline surface is on dnd-kit, not day-one scope.

## Coexistence with the timeline library's own drag — the real risk, scoped honestly

This is the crux of "why not just do it now": `@xzdarcy/react-timeline-editor`'s own
same-track drag is pointer-based (interact.js), bound directly to each action's DOM element.
dnd-kit is *also* pointer/keyboard-sensor-based (not native HTML5 `draggable` — this is
actually dnd-kit's own advantage over what tonight's native-HTML5 code had to fight around).
Two pointer-based systems on the SAME element is the same class of "who wins the
`pointerdown`" question B-027 just lived through, not a new one dnd-kit magically avoids —
dnd-kit's sensors (`PointerSensor`, `KeyboardSensor`) support an `activationConstraint`
(distance/delay threshold before a drag "activates") specifically for this kind of
coexistence, and the cross-track-move handle is ALREADY a physically distinct DOM element
(the D-096 top strip) with its own `onMouseDown`/`onPointerDown` `stopPropagation` — so the
real risk is materially lower here than a same-element migration would be, but "lower risk"
is not "zero risk," and this needs the same deliberate before/after testing D-096's own
harness-based verification technique already established this session, not assumed to just
work because the library promises it.

## Phased plan (not started)

1. **Spike, isolated**: add `@dnd-kit/core`+`@dnd-kit/sortable` to `packages/editor`, build
   the cross-track clip-move + track-reorder mechanisms as a SEPARATE, flag-gated path
   alongside the existing HTML5 one (not a rip-and-replace commit) — verify real coexistence
   with the timeline library's own same-track drag via the harness technique this session
   built (`app/harness.html` pattern, scratch/never-committed) before touching the shipping
   path at all.
2. **Cut over cross-track clip move** — the smaller, more contained of the two (one drag
   source type, one drop-target shape) — once the spike proves clean coexistence.
3. **Cut over track reorder** onto `@dnd-kit/sortable`'s `SortableContext`/`arrayMove`,
   retiring `trackIndexAfterMove`'s hand-written algebra.
4. **Re-evaluate** the Sources-panel drop and the `insertPreview` overlay system once 2-3
   are stable and real usage (the owner's own live testing) confirms the feel actually
   improved — don't extend scope further "while already in there" without that checkpoint.
5. Same-track drag/trim (`@xzdarcy/react-timeline-editor`'s own mechanism) stays untouched
   throughout — not scoped for migration at all, per the "should stay" list above.

## Recommendation

**Scope it as above; do not start implementation in the same pass that produced this note.**
The owner named a specific, real, well-reasoned library — the license is clean (MIT), the
repo is genuinely active (not abandoned), and the two features they're naming as slow
(cross-track move, track reorder) are close to textbook dnd-kit use cases, a real
architectural improvement over the native-HTML5 hand-rolling this session did under time
pressure. But it's real, multi-step surgery on the single most load-bearing, most-recently-
stabilized file in the Edit tab (`TimelinePane.tsx`, four decisions deep in one evening,
including one live regression already), with one honestly-flagged caveat (mid-rewrite
upstream, the specific published version's React-19/StrictMode edge cases aren't yet fixed
upstream) worth the owner's own eyes before committing to it — not a same-night improvisation
on top of an already-large dispatch. Greenlighting this should be its own dedicated pass,
starting from the coexistence spike in step 1, not a continuation of tonight's fixes.
