/**
 * @apelles/editor — the clip body (D-100; moved to `lanes/` by D-437 S2).
 *
 * What it is: the ONE `useDraggable` node of a timeline clip, carrying the
 * `data-chroma-*` / `data-testid` contract the edit gestures, the marquee guard
 * and the UI harness read. What it does NOT do: position the clip (the lane
 * slot does), draw its content (`ClipBlock`) or decide its behaviour (the pane's
 * handlers arrive as props). Moved verbatim out of `TimelinePane.tsx`, no
 * behaviour change. The comment below is the original D-100 text.
 */
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { TIMELINE_TEST_IDS } from '../timelineTestIds';
import { TRIM_ARM_HINT } from '../trimMode';

/** D-100 — the clip body itself, now the ONE real drag source for both
 *  same-track reposition and cross-track move (replacing D-098's separate
 *  top-strip `ClipMoveHandle` AND the timeline library's own native
 *  `interact.js` move-drag — see `buildRows`'s `movable: false` doc for the
 *  real story: two independently-built move systems on one element were
 *  racing for the same gesture, the actual root cause of a whole session's
 *  stuck-overlay/broken-drag reports, not separate bugs). Module-scope for
 *  the same remount-safety reason as `SortableTrackHeader`/`TrackDropZone`.
 *
 *  Safe to cover the FULL clip now, unlike D-098's inset strip: with
 *  `movable: false`, the library's own `interact.js` move listener is never
 *  even initialized for this action (confirmed in its bundled source,
 *  `enableDragging: !disabled && movable`) — there's no second system left
 *  to race for the same `pointerdown`, so no `stopPropagation` gymnastics
 *  are needed either (D-098's own capture-vs-bubble same-element ordering
 *  bug simply doesn't apply once there's only one listener on this element
 *  to begin with). The edge-trim zones
 *  (`timeline-clip-trim-start/-end`) are unaffected — they're siblings
 *  rendered by `LaneClip`, outside this component entirely.
 *
 *  `onDndDragEnd` (in `TimelinePane`) already resolves same-track vs.
 *  cross-track purely from WHERE this lands (`event.over`'s track vs. this
 *  clip's own starting track) — that logic was built for D-098's own
 *  same-track regression fix and needed no changes for this unification,
 *  it was already exactly the right shape. */
export function ClipBody({
  track,
  clipId,
  className,
  style,
  children,
  onPointerDownCapture,
  linkPartner,
}: {
  track: number;
  clipId: string;
  /** This clip is the linked A/V partner of the selected one (its outline is drawn
   *  in `className`); exposed as `data-chroma-link-partner` for the UI harness. */
  linkPartner?: boolean;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
  /** D-432 P2 — `useEditGesture`'s press handler. It runs before dnd-kit's own
   *  `onPointerDown` (capture phase) and stops the press when it claims it for
   *  an edit, so a trim and a move can never both start from one press. */
  onPointerDownCapture?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `clip:${track}:${clipId}`,
    data: { type: 'clip' as const, track, clipId },
  });
  return (
    <div
      ref={setNodeRef}
      // D-137 — the marker marquee-select's own gesture guard tests for. This
      // element is THE `@dnd-kit/core` `useDraggable` node inside the edit
      // area, so `listeners` below is where dnd-kit's `PointerSensor`
      // activator actually lives; a `pointerdown` anywhere in this subtree is
      // a press dnd-kit's sensor claims. `canStartMarquee` (`marquee.ts`)
      // refuses to begin a marquee for any event with this attribute on its
      // propagation path, which makes "marquee" and "clip drag" mutually
      // exclusive by DOM position rather than by ordering or precedence —
      // see that module's doc, and D-094–D-100 for why this file does not
      // settle two drag systems on one element any other way.
      data-chroma-clip-drag=""
      data-testid={TIMELINE_TEST_IDS.clip}
      // D-235 — which clip this body belongs to, readable from the DOM. The
      // smart trim tool's hover affordance has to answer "which mode would a
      // press right here commit?" from a raw `pointermove` whose target may be
      // the library's own stretch handle (a sibling of this element, rendered
      // outside this component), so it resolves the action wrapper first and
      // looks this pair up inside it. dnd-kit's own `id` already encodes the
      // same pair, but it is not exposed on the DOM node in any documented way.
      data-chroma-track={track}
      data-chroma-clip-id={clipId}
      data-chroma-link-partner={linkPartner ? '' : undefined}
      // D-250 — where the smart trim tool is announced when it is NOT armed.
      // D-235's four edits are reachable only by already knowing to hold
      // Alt/Option, and its readout appears only once that key is down, so
      // nothing on this surface ever said the key does anything — the owner
      // asked "how to toggle between roll/slip/ripple etc?" with the feature
      // shipped. A `title` is the right cost for a hint you need exactly once:
      // it is on the thing the gesture acts on, it costs no pixels, and it is
      // read out by a screen reader. The badge (armed) and this (unarmed) are
      // the two halves of one affordance.
      title={TRIM_ARM_HINT}
      // D-432 §5 — the default arrow over a clip body (Final Cut, Premiere);
      // `grab` is for track headers only.
      className={className + (isDragging ? ' opacity-30' : '')}
      style={style}
      onPointerDownCapture={onPointerDownCapture}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}
