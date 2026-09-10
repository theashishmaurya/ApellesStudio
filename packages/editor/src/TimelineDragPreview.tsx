/**
 * @apelles/editor — the timeline's live drag-preview overlay layer
 * (B-160 / D-304).
 *
 * **What it is.** The four purely-visual overlays a drag paints while it is in
 * flight: the insertion line snapped to a clip edge, the ghost row at a
 * track-insertion boundary, the sync-lock ripple ghosts (D-113) and the
 * A/V-link ghosts (B-134). It owns the two pieces of state that drive them and
 * exposes an imperative handle so the drag handlers in `TimelinePane` can write
 * to it without re-rendering themselves.
 *
 * **Why it is its own component — the whole point.** These overlays update on
 * every single pointer-move tick of a drag: at ordinary zoom a few pixels of
 * movement is already a different landing frame, so the change-gating in the
 * setters below stops almost nothing. While this state lived on `TimelinePane`
 * itself, that meant a full re-render of the app's largest and highest-update-
 * frequency component — ruler, every track, every clip, filmstrips, waveforms,
 * markers, transition badges — once per pointer move, purely to move four small
 * absolutely-positioned boxes. Measured on the real component in a real browser
 * (`app/harness.html`, 4 tracks × 6 clips, a stubbed backend, i.e. far smaller
 * than a real edit): during a drag, frame intervals went from a flat 16.7ms to
 * a p90 of 24-28ms with individual frames past 45ms, and ~2 `TimelinePane`
 * renders per pointer-move. The same drag with the preview suppressed (the
 * Alt/slip path, which D-235 already skips this state for) held p90 at 18ms
 * with 4 renders for the whole gesture. That gap is the owner's report:
 * *"drag and drop in the timeline is still not smooth and animations are
 * shakky"*. Owning the state here confines each of those renders to this small
 * subtree.
 *
 * This is the same defect class as **B-024** — "re-rendering N tracks' worth of
 * actions on every tick is what actually froze the UI" — reached from the other
 * direction: B-024 was a prop identity changing every tick, this is the parent
 * re-rendering every tick. `TimelinePane`'s own `getActionRender` doc has the
 * full story of the first one.
 *
 * **What it does NOT do.** No pointer handling, no hit testing, no placement
 * math — it is handed a resolved landing (`resolveClipLanding`'s answer) and
 * draws it. It does not decide whether a preview should be shown; that is
 * `onDndDragMove`/`onDragOver` in `TimelinePane`. It owns no geometry constants
 * either: `startLeftPx`/`rowHeight`/`rulerAndMarginPx` come in as props, the
 * same way `TransitionBadges` already takes them, so this file cannot drift out
 * of the pane's coordinate space and there is no import cycle.
 */

import { forwardRef, useImperativeHandle, useMemo, useState } from 'react';

import { linkedDragGhosts, sourceFramesToTimeline, syncLinkedClipIdsAtPosition } from './timeline';
import type { Timeline, Track } from './timeline';

/** The resolved landing of an in-flight clip drag — what `resolveClipLanding`
 *  said, plus enough identity to know which clip is going where. `duration` is
 *  in TIMELINE frames already (B-077), not the clip's own source frames. */
export interface ClipDragPreview {
  fromTrack: number;
  toTrack: number;
  clipId: string;
  startFrame: number;
  /** Timeline frames (B-077). */
  duration: number;
  ripple: boolean;
}

/** Where a drop would land something NEW: on an existing track at a snapped
 *  clip edge, or as a brand-new track at an insertion boundary. */
export type InsertPreview = { kind: 'edge'; track: number; frame: number } | { kind: 'new_track'; index: number };

type Updater<T> = T | ((prev: T) => T);

export interface TimelineDragPreviewHandle {
  /** The in-flight clip drag's resolved landing, or `null` for none. Takes an
   *  updater so a caller can keep the "no real change, don't dispatch"
   *  gating it always had. */
  setLanding(next: Updater<ClipDragPreview | null>): void;
  /** The drop-target preview for a Sources/generator drag or a
   *  create-a-track clip drag, or `null` for none. */
  setInsert(next: Updater<InsertPreview | null>): void;
  /** Both at once — what every "this gesture is over" path wants. */
  clear(): void;
}

export interface TimelineDragPreviewProps {
  timeline: Timeline | null;
  tracks: Track[];
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  scrollTop: number;
  startLeftPx: number;
  rowHeight: number;
  rulerAndMarginPx: number;
}

/** One ghost box, in the pane's own `editAreaRef`-relative coordinate space. */
interface Ghost {
  id: string;
  track: number;
  shiftedStart: number;
  /** Timeline frames. */
  duration: number;
}

export const TimelineDragPreview = forwardRef<TimelineDragPreviewHandle, TimelineDragPreviewProps>(
  function TimelineDragPreview(
    { timeline, tracks, fps, pxPerSec, scrollLeft, scrollTop, startLeftPx, rowHeight, rulerAndMarginPx },
    ref,
  ) {
    const [landing, setLandingState] = useState<ClipDragPreview | null>(null);
    const [insert, setInsertState] = useState<InsertPreview | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        setLanding: (next) => setLandingState(next),
        setInsert: (next) => setInsertState(next),
        clear: () => {
          setLandingState((prev) => (prev === null ? prev : null));
          setInsertState((prev) => (prev === null ? prev : null));
        },
      }),
      [],
    );

    // D-113 — owner, live: "if both are synced, then both should move together
    // and hover together." A live drag only ripples OTHER sync-locked tracks
    // when the resolved landing actually needs one (`ripple: true` — the same
    // condition `applyOp`'s `move` case gates the real `propagateSyncLockRipple`
    // call on); every affected clip is rendered as its own ghost, shifted by the
    // dragged clip's own duration — the exact delta `shiftClipsAtOrAfter` would
    // apply for real on drop — so what's previewed during the drag matches what
    // actually happens when it's released, not an approximation of it.
    //
    // B-077 — both the landing's `duration` and each ghost's own below are
    // TIMELINE-frame footprints (`sourceFramesToTimeline`), not the clips' raw
    // (source-frame) `.duration` fields: `shiftedStart` is a `start_frame`-space
    // position (needs a timeline-frame shift, matching the real
    // `shiftClipsAtOrAfter` ripple this previews) and the render below divides
    // `duration` by the project's own `fps` for its pixel width — both wrong for
    // a `.duration` still in the dragged/ghost clip's own native rate.
    const syncGhosts = useMemo<Ghost[]>(() => {
      if (!timeline || !landing || !landing.ripple) return [];
      const linkedIds = syncLinkedClipIdsAtPosition(timeline, landing.toTrack, landing.startFrame);
      if (linkedIds.size === 0) return [];
      const ghosts: Ghost[] = [];
      tracks.forEach((t, ti) => {
        if (ti === landing.toTrack) return; // same-track shift already IS the placeholder's own landing
        for (const c of t.clips) {
          if (linkedIds.has(c.id)) {
            ghosts.push({
              id: c.id,
              track: ti,
              shiftedStart: c.start_frame + landing.duration,
              duration: sourceFramesToTimeline(c, c.duration, fps),
            });
          }
        }
      });
      return ghosts;
    }, [timeline, landing, tracks, fps]);

    /** B-134 — the live drag ghost for a dragged clip's A/V-linked partner(s).
     *  Owner, live: dragging a clip on Video 1 left its linked audio clip on
     *  Audio 1 visually inert for the whole gesture, only snapping to its real
     *  new position on drop. Root cause: `ClipBody`'s live drag transform comes
     *  from dnd-kit's own `useDraggable`, which only ever animates the exact
     *  node whose `id` matches `event.active.id` — the linked partner is a
     *  wholly separate `ClipBody` instance, with a different `clipId`, on a
     *  different track's row, so nothing hands it a matching live transform.
     *
     *  Same SHAPE of fix as `syncGhosts` just above (a synthesized overlay
     *  standing in for a live transform dnd-kit will never give this element),
     *  but keyed off the dragged clip's own `link_group` (`linkGroupMembers`,
     *  D-129) rather than `syncLinkedClipIdsAtPosition`, and — unlike
     *  `syncGhosts` — NOT gated on `landing.ripple`: an A/V link moves with its
     *  primary on EVERY move, ripple or not (`timeline.ts`'s `move` op
     *  unconditionally computes and applies `delta` to every other link-group
     *  member before it even asks whether a ripple fired).
     *
     *  A cross-track drag deliberately does NOT move the ghost to the new
     *  track: `timeline.ts`'s `move` op (D-129) moves every other link-group
     *  member by the same frame DELTA while leaving it on its OWN track — "a
     *  linked pair keeps sync, it does not follow the video half onto the video
     *  half's new track" (that op's own comment, mirroring Resolve's documented
     *  behaviour). So `g.track` below is always the partner's own unchanged
     *  track, never `landing.toTrack`.
     *
     *  Reusing `landing.startFrame` — itself already `resolveClipLanding`'s
     *  output, the same value `onDndDragEnd` passes to `applyOp` — means this
     *  preview can never disagree with what actually commits. The position math
     *  itself is `timeline.ts`'s own `linkedDragGhosts`, a pure function
     *  specifically so it has a real unit test. */
    const linkGhosts = useMemo<Ghost[]>(() => {
      if (!timeline || !landing) return [];
      return linkedDragGhosts(timeline, landing.fromTrack, landing.clipId, landing.startFrame, fps);
    }, [timeline, landing, fps]);

    return (
      <>
        {/* D-095/D-096/D-097 — the live drop-preview overlay: an insertion
            line snapped to a clip edge, or a ghost row at a track-insertion
            boundary. `pointer-events-none` so it never steals the drag's own
            dragover/drop targeting from the library/edit-area underneath —
            purely visual, positioned in the same `editAreaRef`-relative
            coordinate space `xToFrame`/`dropTargetTrack` already compute
            against. */}
        {insert?.kind === 'edge' && (
          <div
            className="pointer-events-none absolute z-30 bg-accent"
            style={{
              left: startLeftPx + (insert.frame / fps) * pxPerSec - scrollLeft,
              top: rulerAndMarginPx + insert.track * rowHeight - scrollTop,
              width: 2,
              height: rowHeight,
            }}
          />
        )}
        {insert?.kind === 'new_track' && (
          <div
            // B-115 — a stable hook for "the drag is offering a new track
            // HERE", the same `data-chroma-*` convention D-219 established for
            // naming a surface without matching on a Tailwind class string that
            // changes whenever the styling does.
            data-chroma-new-track-preview={insert.index}
            className="pointer-events-none absolute left-0 right-0 z-30 border-2 border-dashed border-accent/70 bg-accent/10"
            style={{
              // D-097 — past the last row (`index === tracks.length`) there's
              // no row below to overlap into, so the ghost sits flush under the
              // last real row, unchanged from D-096. Every other boundary
              // (above the first track, or between two existing ones) centers
              // the ghost ON the boundary line, half-overlapping each
              // neighboring row — the standard "squeeze a new row in here" NLE
              // affordance.
              top:
                rulerAndMarginPx +
                insert.index * rowHeight -
                (insert.index === tracks.length ? 0 : rowHeight / 2) -
                scrollTop,
              height: rowHeight,
            }}
          />
        )}
        {/* D-113 — owner, live: "if both are synced, then both should move
            together and hover together." A slightly different visual weight
            from the A/V-link ghosts below (`text-secondary`-toned, matching
            D-111's own selection-time sync-linked ring, not the primary
            accent) — related to the drop, not the drop's own destination. */}
        {syncGhosts.map((g) => (
          <div
            key={`sync-ghost-${g.id}`}
            className="pointer-events-none absolute z-30 rounded border-2 border-dashed border-text-secondary/70 bg-text-secondary/10"
            style={{
              left: startLeftPx + (g.shiftedStart / fps) * pxPerSec - scrollLeft,
              width: (g.duration / fps) * pxPerSec,
              top: rulerAndMarginPx + g.track * rowHeight - scrollTop,
              height: rowHeight,
            }}
          />
        ))}
        {/* B-134 — `border-accent`-toned (not `syncGhosts`' `text-secondary`)
            to match `avLinkedIds`' own accent-ring convention: an A/V link is a
            stronger, more specific relationship than a sync-lock ripple, and
            must not read as the same thing on screen (D-128). */}
        {linkGhosts.map((g) => (
          <div
            key={`link-drag-ghost-${g.id}`}
            // B-134 — a stable hook for a test to find this ghost, the same
            // convention `ClipBody`'s own `data-chroma-*` attributes already
            // use, since a `key` prop is not queryable from the DOM.
            data-chroma-link-drag-ghost={g.id}
            className="pointer-events-none absolute z-30 rounded border-2 border-dashed border-accent/70 bg-accent/10"
            style={{
              left: startLeftPx + (g.shiftedStart / fps) * pxPerSec - scrollLeft,
              width: (g.duration / fps) * pxPerSec,
              top: rulerAndMarginPx + g.track * rowHeight - scrollTop,
              height: rowHeight,
            }}
          />
        ))}
      </>
    );
  },
);
