# Multi-select — scoping (2026-09-04)

Roadmap item 12, priority #1 per `docs/notes/timeline-feature-audit.md` (D-105): the one
gap that makes almost everything else on that audit's list more useful once it exists
(batch move under a future sync-locked ripple, multi-gap delete, multi-clip transform
edits), and blocks nothing else. Real, well-precedented UI pattern — shift-click
range-select and cmd/ctrl-click toggle-select are close to mechanical in the abstract.

**This doc exists instead of code** because tracing the real call sites turned out to be
bigger than the "just extend a click handler" first impression — see below. Per the
owner's own explicit direction (route the two architecturally-heavy items through a
design review before code exists), and given this session's own demonstrated fragility in
exactly this class of interaction (D-094 through D-100 spent six rounds stabilizing
*single*-clip drag against gesture-coexistence bugs — a stuck ghost overlay silently
blocking clicks, a capture-phase `stopPropagation` silently blocking a bubble-phase
listener on the same element, dnd-kit's own internal sensor state getting stuck after an
interrupted drag), multi-select is scoped here too rather than built blind.

## Current state, verified against the actual code (not assumed)

- **`Selection` (`TimelinePane.tsx`) is `{track: number, id: string} | null`** — a plain
  `useState`, singular, D-080. A separate `selectedGap: {track, frame} | null` exists
  alongside it (D-105), with an explicit mutual-exclusivity rule (`onClickAction` clears
  `selectedGap`, the gap-click handler clears `selected`) — any multi-select design needs
  to decide whether *multiple gaps*, or a *mix* of clips and gaps, can ever be selected
  together (real NLEs generally don't mix clip-selection and gap-selection semantics —
  recommend keeping the existing mutual exclusivity rather than generalizing it away
  without a real reason to).
- **`onClickAction`'s event is a real `React.MouseEvent`** (checked against
  `@xzdarcy/react-timeline-editor`'s own `.d.ts` — `onClickAction?: (e:
  React.MouseEvent<HTMLElement, MouseEvent>, ...)`), not the loosely-typed `_e: unknown`
  the current code casts it to. `shiftKey`/`metaKey`/`ctrlKey` are real, available fields —
  reading them for shift-click-extend / cmd-click-toggle is mechanical once `Selection`
  itself changes shape. This part genuinely is low-risk, as first assumed.
- **The real complexity is everywhere `selected` gets *consumed*, not where it gets
  set** — traced every real call site:
  - `getActionRender`'s `isSel` check (`selected?.track === ti && selected.id ===
    action.id`) — becomes a set-membership check, mechanical.
  - **`ClipInspectorPanel` (D-102/D-103) takes a single `clip={selectedClip}` prop**,
    resolved upstream from `selected`. With N clips selected, what does the panel show?
    Real options: (a) fall back to its existing "nothing selected" empty state for
    N≠1 (simplest, but throws away the batch-edit value multi-select is supposed to
    unlock for *transform* properties specifically), (b) a real "N clips selected" state
    showing only fields common across the selection with an explicit "editing N clips"
    affordance (Premiere/Resolve both do something like this for shared numeric
    properties), (c) show the *last*-selected clip's properties, editing only it, while
    the rest of the selection stays visually marked but inspector-inert. **(a) is the
    right first increment** — building (b) means rethinking `ClipInspectorPanel`'s whole
    read/write contract (fields become "apply to N clips" instead of "read/write one
    clip"), real scope on top of real scope, and should wait until single-clip-selection
    multi-select is proven out, not ship in the same pass as the model change itself.
  - **The toolbar (`Split`/`Remove`/`Move to`)** each need a real per-op decision, not a
    uniform "just loop over the selection": **Remove** generalizes cleanly (lift every
    selected clip, independently — no interaction between them). **Split at playhead**
    also generalizes cleanly *and is a real, commonly-used batch operation* in every
    reference checked (split every selected clip at the playhead in one action) — worth
    including in a first increment. **"Move to ▾" (cross-track move) is the one that
    doesn't generalize simply** — D-104 already made single-clip cross-track move
    overlap-free via `resolveClipLanding`/`computeInsertion`; moving N clips to the same
    target track at once means resolving N landing positions that must be mutually
    non-overlapping *with each other*, not just with what's already on the track — a
    real, non-trivial sequencing problem (do they preserve relative order/spacing? do
    they all land back-to-back regardless of original gaps between them?). **Recommend
    deferring multi-clip cross-track move entirely for the first increment** — scope it
    as a second, later multi-select phase once the single-clip landing logic has had
    more real mileage.
  - **`trackIndexAfterMove`'s drag-follow-selection logic** (keeps `selected` pointing at
    the same clip after a track reorder shifts indices) generalizes to a set with the
    same math, mechanical.
  - **Keyboard Delete/Backspace** (`onKeyDown`) already branches on `selected` vs.
    `selectedGap` — extending to "delete every selected clip" is the same shape as the
    toolbar Remove case above.

## Recommended phased build (do not build all at once)

**Phase 1 — the model + the two safe, high-value operations.** `Selection` becomes a
real set (exact shape below), shift-click range-extend + cmd/ctrl-click toggle wired into
the existing `onClickAction` (no new gesture/drag primitive — reads modifier keys off the
real `MouseEvent` already flowing through it), `getActionRender`'s highlight generalized,
**Remove** and **Split-at-playhead** generalized to operate over the whole selection,
`ClipInspectorPanel` falls back to its existing empty state whenever selection size ≠ 1
(no rewrite of the panel's contract). This is the actual low-risk increment — no new
pointer/drag interaction, no coexistence risk with the dnd-kit-based drag stack, a
bounded and enumerable set of call sites already traced above.

**Exact `Selection` shape, a real decision, not deferred**: recommend `{track: number, id:
string}[]` (an array of the *existing* singular shape, not a bare `Set<string>` of ids
alone) — `id` alone risks ambiguity if clip ids are ever not globally unique across
tracks (not confirmed false, just not confirmed true either — `Clip.id`'s own doc comment
only promises "stable id, survives reorder/trim," not "globally unique"; verify this for
real, e.g. by checking whatever generates a new clip's id, before committing to a
bare-id-`Set`). An array of `{track, id}` pairs costs nothing extra and removes the
ambiguity entirely — a `Set<string>` built from `` `${track}:${id}` `` keys internally for
O(1) membership checks is a legitimate implementation detail underneath that array-shaped
public type, not a reason to weaken the type itself.

**Phase 2 — marquee/rubber-band drag-select.** A genuinely new gesture: pointer-down on
empty edit-area space, drag out a selection rectangle, select every clip whose bounds
intersect it (Premiere's own documented behavior: "start anywhere beyond the edges of a
clip... overlap a clip, that segment is selected"). Real coexistence risk with: the
existing empty-space click-to-deselect handler (needs a real click-vs-drag-start
threshold, not just "mousedown always begins a marquee"), `selectedGap`'s own click
handler on empty space (same area, different meaning depending on distance dragged), and
dnd-kit's `DndContext` (a marquee's own pointer-down/move/up sequence needs to not be
captured by or interfere with dnd-kit's sensors, even though it's scoped to empty space
rather than a draggable clip — verify this doesn't need special handling before assuming
it's naturally isolated). **Sequence this after Phase 1 has had real usage**, not in the
same pass — Phase 1 alone already unlocks shift/cmd-click multi-select, which covers a
real majority of practical multi-select use (extend a contiguous range, or toggle a few
specific clips) without touching the riskiest interaction surface in the file.

**Phase 3 — multi-clip cross-track move, and richer Inspector batch-editing.** Both
flagged above as real, deliberately deferred scope — pick up once Phase 1's simpler
operations are proven solid.

## Sequencing against the other two audit items

Per the audit's own reasoning: **Phase 1 of this doc should land before cross-track
ripple/sync-lock** (`docs/notes/cross-track-ripple-sync-lock.md`) — a good multi-select
design changes what "select these N things across M tracks, then ripple/delete them
together" needs to mean, and scoping sync-lock against a real (not hypothetical) array
`Selection` is more grounded. It's independent of A/V linking (`docs/notes/av-linking.md`)
at the model level, though a real link-group selection rule ("selecting one half of a
linked pair also selects its partner, by default") is exactly the kind of thing Phase 1's
array-shaped `Selection` needs to already exist for A/V linking to build against —
another reason to land Phase 1 first.

## Status

**Phase 1 built, D-107 (2026-09-04).** `Selection` is now `{track, id}[]`, shift/cmd-click
wired into `onClickAction`, `Remove`/`Split at playhead` generalized (processed in
descending per-track Vec-index order — a real correctness requirement this doc didn't
spell out in that much detail, since removing/splitting is what actually surfaces the
index-shift hazard). `ClipInspectorPanel`/transform/keyframes/"Move to ▾" all correctly
fall back to their single-clip-only path via a derived `primary`, exactly as recommended.
73/73 Rust + 115/115 TS tests pass (this phase's own logic lives entirely in
`TimelinePane.tsx`, not the pure `timeline.ts` ops, so most new coverage is on the
sync-lock half built alongside it — see D-107). **Not verified via real interactive
clicking this pass** (a Chrome-DevTools scratch-harness attempt against the live dev
server hit a wall booting the full app shell without Tauri IPC — see D-107's own
verification note) — relied on careful code review + the type-checked, exhaustively
reasoned-through descending-index logic instead; flagged honestly rather than claimed
closed. **Phases 2 (marquee-select) and 3 (multi-clip cross-track move, richer batch
Inspector editing) remain real, deliberately deferred** — pick up once Phase 1 has real
usage, per the original reasoning above, unchanged.
