/**
 * @chroma/editor — the fade "rubber band" and its two draggable handles, drawn
 * directly on a timeline clip's own body (D-205).
 *
 * **What it is.** The standard NLE fade affordance the owner asked for by
 * screenshot: a ramp from silence at the clip's edge up to unity, drawn across
 * the clip's waveform/filmstrip, with a small handle where the ramp meets the
 * flat unity line that you drag horizontally to set the fade's length.
 * Premiere, Resolve and Final Cut all have one; Chroma had the whole model,
 * render path and MCP surface for it since D-147 but no way to author a fade
 * except the Inspector's numeric frame field.
 *
 * **It is a VIEW of `Clip.fade_in_frames`/`fade_out_frames`, never a second
 * store.** The ramp is drawn from those persisted fields, and a completed drag
 * commits through the very same `applyOp({kind:'set_clip_fade', …})` call
 * `EditorInspectorPanel.tsx`'s `applyFade` makes — same op, same undo stack,
 * same debounced persist. The numeric Fade field and this overlay are two
 * views of one field and cannot disagree.
 *
 * **Rendered for EVERY clip, on video tracks and audio tracks alike**, because
 * that is what the model means: one fade pair drives picture and sound
 * together (`chroma_timeline::Clip::fade_in_frames`' own doc, and
 * `set_clip_fade`'s — opacity on a video clip, gain on an audio one, both on a
 * video clip carrying its own embedded audio). Drawing the handle only on
 * audio-track clips would have made a feature the model deliberately unified
 * look like two different features.
 *
 * **Live overlay-only feedback during the drag; ONE op on pointer-up** —
 * the convention `TransformOverlay.tsx` states in full and
 * `RelightPuckLayer.tsx`/D-046 established: `applyOp` pushes a whole-timeline
 * undo snapshot on every call, so a naive `onPointerMove -> applyOp` would put
 * one undo entry on the stack per pixel of drag. Only this component's own
 * local `draft` moves while dragging; the picture/mix catch up once the commit
 * is persisted (B-088/D-202). A drag that lands back on the value it started
 * from commits nothing at all, so it can't push an identity-op onto the stack
 * either.
 *
 * **Why this is a module-scope component and not JSX inlined into
 * `getActionRender`.** Local `draft` state means a pointermove during a fade
 * drag re-renders exactly one clip's overlay — not `TimelinePane`, whose
 * re-render rebuilds every visible clip's DOM across every track (B-024's own
 * failure mode, documented at `getActionRender`).
 *
 * **Coexisting with the two other gestures already on a clip body.** Neither
 * is settled by precedence or ordering — same principle D-094–D-100/D-137
 * state for the others:
 *   - **dnd-kit's clip-move drag** owns `pointerdown` anywhere on `ClipBody`.
 *     Each handle is a distinct hit target inside it that calls
 *     `stopPropagation()`, so the sensor's activator never sees the press —
 *     the same "distinct hit-target" resolution D-094's grip handle used.
 *     (Marquee-select needs nothing: `canStartMarquee` already refuses any
 *     press with `data-chroma-clip-drag` on its path, which every press in
 *     this subtree has.)
 *   - **The library's own edge-trim resize handles**
 *     (`.timeline-editor-action-{left,right}-stretch`) are 10px-wide,
 *     FULL-height siblings of this overlay, and a fade handle at rest sits
 *     exactly on top of one (a zero fade is at the clip's own corner). They
 *     are separated by WHERE IN THE ROW the press lands: a fade handle's grab
 *     target is `FADE_HANDLE_HIT_PX` (15px) tall, anchored to the clip's top
 *     edge, leaving the lower ~37px of both trim zones untouched — which is
 *     exactly how Resolve stacks the same two affordances. The `z-20` on the
 *     handle layer is what makes it win *within* those top 15px (the library's
 *     handles are `z-index: auto` and rendered after this content block —
 *     B-013's lesson, in reverse: here the paint-order win is the intent, and
 *     it is bounded to a deliberately small rectangle instead of the whole
 *     clip width the B-013 label was accidentally spanning).
 *
 * Everything with a correct answer — frames↔px at the current zoom, the curve
 * path geometry, the drag clamp — is in `clipFade.ts` and unit-tested in
 * `clipFade.test.ts`; this file is DOM and pointer wiring around it.
 * `TimelinePane.fade.dom.test.tsx` drives it end-to-end with real
 * `PointerEvent`s.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import {
  FADE_HANDLE_HIT_PX,
  FADE_HANDLE_SIZE_PX,
  FADE_MIN_HANDLE_CLIP_PX,
  clampFadeDragPx,
  fadeFramesToPx,
  fadeHandleX,
  fadeRampPaths,
  fadeUnityLinePath,
  pxToFadeFrames,
  type FadeSide,
} from './clipFade';
import { DEFAULT_FADE_CURVE, type Clip } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** How opaque the wash over the attenuated part of the clip is. Painted in the
 *  `--color-bg-primary` token (via `currentColor`, the same trick
 *  `Waveform.tsx` uses to stay on the token system from a context that can't
 *  take a class): fading *toward the app background* is the honest reading of
 *  "this part of the clip contributes less," and needs no colour literal. */
const FADE_WASH_OPACITY = 0.5;

/** Stroke width of the rubber-band line, px. */
const FADE_LINE_WIDTH = 1.25;

/** Roughly how wide the live "12f" readout gets, px — how far from the clip's
 *  right edge it stops being pushed, so a fade dragged near the far end still
 *  shows its number instead of sliding out of the clip's `overflow-hidden`
 *  box. Approximate by nature (it depends on the digit count), which is why it
 *  is only a clamp and not a layout. */
const FADE_READOUT_WIDTH_PX = 34;

/** The in-flight gesture — local and uncommitted. Held in a ref (not state) so
 *  the window listeners below never need re-binding to see it, matching
 *  `TimelinePane`'s own marquee gesture. */
interface FadeDragState {
  side: FadeSide;
  pointerId: number;
  /** `clientX` at pointer-down — the drag is a pure delta from here. */
  originX: number;
  /** The committed fade length (clip source frames) the drag started from,
   *  clamped to what was actually ON SCREEN: a fade longer than the clip parks
   *  its handle at the far edge (`fadeHandleX`), and a drag has to start from
   *  where the handle visibly is, or the first pixel of movement would jump. */
  startFrames: number;
}

export interface ClipFadeOverlayProps {
  track: number;
  /** The clip's index within its track — what `set_clip_fade` addresses. */
  clipIndex: number;
  clip: Clip;
  /** The clip's on-screen width and height, px. */
  widthPx: number;
  heightPx: number;
  /** The project's timeline fps and the pane's current zoom — the same two
   *  values `getActionRender` already uses for the waveform/filmstrip, passed
   *  in rather than re-derived so there is one pixel conversion in this pane,
   *  not two. */
  fps: number;
  pxPerSec: number;
  /** A locked track draws its fades but offers no handles — the same posture
   *  `TransformOverlay.tsx` takes for `trackLocked`. */
  disabled?: boolean;
}

export function ClipFadeOverlay({
  track,
  clipIndex,
  clip,
  widthPx,
  heightPx,
  fps,
  pxPerSec,
  disabled = false,
}: ClipFadeOverlayProps) {
  const applyOp = useEditorTimelineStore((s) => s.applyOp);

  const dragRef = useRef<FadeDragState | null>(null);
  /** What the overlay renders while a drag is live — already quantised to whole
   *  frames, so the ramp on screen during the drag is exactly what pointer-up
   *  will commit. `null` = render straight from the committed fields. */
  const [draft, setDraft] = useState<{ side: FadeSide; frames: number } | null>(null);

  const committedIn = Math.max(0, clip.fade_in_frames ?? 0);
  const committedOut = Math.max(0, clip.fade_out_frames ?? 0);
  const framesIn = draft?.side === 'in' ? draft.frames : committedIn;
  const framesOut = draft?.side === 'out' ? draft.frames : committedOut;

  const rampInPx = fadeFramesToPx(clip, framesIn, fps, pxPerSec);
  const rampOutPx = fadeFramesToPx(clip, framesOut, fps, pxPerSec);

  const dragSide = draft?.side ?? null;

  // The gesture's move/up listeners live on `window` and NOT on
  // `setPointerCapture`, for the reason `TimelinePane`'s marquee states at its
  // own listeners: capture retargets every subsequent pointer event to the
  // captured element, which is a real way to interfere with something else's
  // hit-testing on a surface that already has three gestures on it. Bound only
  // while a drag is actually live (this component exists once per visible
  // clip — permanent window listeners would scale with the timeline).
  useEffect(() => {
    if (!dragSide) return;

    const finish = () => {
      dragRef.current = null;
      setDraft(null);
    };

    /** The fade length, in clip source frames, that pointer position `clientX`
     *  represents. The base is re-derived from `startFrames` at the CURRENT
     *  zoom on every move rather than cached as pixels at pointer-down, so a
     *  zoom mid-drag stays coherent instead of silently offsetting the
     *  gesture. A fade-out grows leftward, hence the sign flip — the one
     *  difference between the two sides. */
    const framesAt = (clientX: number, g: FadeDragState): number => {
      const delta = clientX - g.originX;
      // A press with no movement is exactly the value it started from, stated
      // rather than left to a px round-trip: on a clip whose native rate isn't
      // the timeline's, frames→px→frames can land a frame off, and a plain
      // click on a handle must never be an edit.
      if (delta === 0) return g.startFrames;
      const basePx = fadeHandleX(
        g.side,
        widthPx,
        fadeFramesToPx(clip, g.startFrames, fps, pxPerSec),
      );
      const ramp = g.side === 'in' ? basePx + delta : widthPx - basePx - delta;
      return pxToFadeFrames(clip, clampFadeDragPx(ramp, widthPx), fps, pxPerSec);
    };

    const onMove = (e: PointerEvent) => {
      const g = dragRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      setDraft({ side: g.side, frames: framesAt(e.clientX, g) });
    };

    const onUp = (e: PointerEvent) => {
      const g = dragRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const frames = framesAt(e.clientX, g);
      finish();
      const current = g.side === 'in' ? committedIn : committedOut;
      // A drag that ends where it began commits nothing: `applyOp` would push
      // a real undo entry for an op that changes no value, because
      // `set_clip_fade` always rebuilds the clip object and so never compares
      // reference-equal to its input.
      if (frames === current) return;
      applyOp({
        kind: 'set_clip_fade',
        track,
        clip: clipIndex,
        // Both durations and both curves are restated on every write, exactly
        // as `EditorInspectorPanel.tsx`'s `applyFade` does — `set_clip_fade`
        // is a whole-fade op, not a patch (see its own doc in `timeline.ts`).
        fade_in_frames: g.side === 'in' ? frames : committedIn,
        fade_out_frames: g.side === 'out' ? frames : committedOut,
        fade_in_curve: clip.fade_in_curve ?? DEFAULT_FADE_CURVE,
        fade_out_curve: clip.fade_out_curve ?? DEFAULT_FADE_CURVE,
      });
    };

    const onCancel = (e: PointerEvent) => {
      const g = dragRef.current;
      if (g && e.pointerId !== g.pointerId) return;
      finish();
    };

    // Escape abandons the gesture with nothing committed — the same cancel
    // affordance `TransformOverlay`'s drag (D-136) and the marquee (D-137)
    // both have.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', finish);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', finish);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [dragSide, clip, clipIndex, track, widthPx, fps, pxPerSec, applyOp, committedIn, committedOut]);

  if (!(widthPx > 0) || !(heightPx > 0)) return null;

  const pathsIn = fadeRampPaths('in', widthPx, heightPx, rampInPx, clip.fade_in_curve ?? DEFAULT_FADE_CURVE);
  const pathsOut = fadeRampPaths('out', widthPx, heightPx, rampOutPx, clip.fade_out_curve ?? DEFAULT_FADE_CURVE);
  const unity = pathsIn || pathsOut ? fadeUnityLinePath(widthPx, heightPx, rampInPx, rampOutPx) : null;
  const showHandles = !disabled && widthPx >= FADE_MIN_HANDLE_CLIP_PX;

  const onHandlePointerDown = (side: FadeSide) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || disabled) return;
    // Keeps the press away from dnd-kit's `PointerSensor` activator, which
    // `ClipBody` puts on this element's own ancestor — see this module's doc.
    e.stopPropagation();
    const committed = side === 'in' ? committedIn : committedOut;
    // Start from what is ON SCREEN: a longer-than-the-clip fade parks its
    // handle at the far edge, so the drag begins from there instead of jumping
    // on its first pixel. A fade that DOES fit keeps its exact committed value
    // — deliberately not round-tripped through px, which on a clip whose
    // native rate differs from the timeline's can land a frame off and turn a
    // click-without-movement into a real (if tiny) edit.
    const startFrames =
      fadeFramesToPx(clip, committed, fps, pxPerSec) <= widthPx
        ? committed
        : pxToFadeFrames(clip, widthPx, fps, pxPerSec);
    dragRef.current = { side, pointerId: e.pointerId, originX: e.clientX, startFrames };
    setDraft({ side, frames: committed });
  };

  return (
    <>
      {/* The ramps. `z-10` puts them over the filmstrip/waveform (which are
          plain `absolute inset-0` content, `z-index: auto`) and under the
          clip's own name label, which is also `z-10` but rendered after —
          keeping the label legible was D-100's whole point. Inert to the
          pointer: only the handles below are grabbable, and a full-clip
          pointer target painted over a clip body is exactly B-013. */}
      <svg
        className="pointer-events-none absolute inset-0 z-10"
        width={widthPx}
        height={heightPx}
        aria-hidden="true"
        data-chroma-fade-ramp=""
      >
        <g className="text-bg-primary">
          {pathsIn && <path d={pathsIn.area} fill="currentColor" fillOpacity={FADE_WASH_OPACITY} />}
          {pathsOut && <path d={pathsOut.area} fill="currentColor" fillOpacity={FADE_WASH_OPACITY} />}
        </g>
        <g className="text-button-text" fill="none" stroke="currentColor" strokeWidth={FADE_LINE_WIDTH}>
          {pathsIn && <path d={pathsIn.line} />}
          {pathsOut && <path d={pathsOut.line} />}
          {unity && <path d={unity} />}
        </g>
      </svg>

      {showHandles &&
        (['in', 'out'] as const).map((side) => {
          const ramp = side === 'in' ? rampInPx : rampOutPx;
          const frames = side === 'in' ? framesIn : framesOut;
          const isDragging = dragSide === side;
          const x = fadeHandleX(side, widthPx, ramp);
          return (
            <div
              key={side}
              // The house `closest()`-on-a-marker convention (`data-transform-
              // handle`, `data-chroma-clip-drag`) — a stable hook for the DOM
              // test, and for any future gesture that needs to stand aside for
              // a fade grab the way `useCanvasClipPick` does for a transform
              // corner.
              data-chroma-fade-handle={side}
              // Visible at rest only once a fade actually exists; otherwise it
              // appears on hover, so an un-faded timeline has no permanent
              // grab targets sitting on its clips' trim corners. (Resolve and
              // Final Cut both reveal theirs on hover for the same reason.)
              className={
                'absolute top-0 z-20 flex items-start justify-center transition-opacity ' +
                (isDragging || frames > 0 ? 'opacity-100' : 'opacity-0 group-hover/clip:opacity-100')
              }
              style={{
                width: FADE_HANDLE_HIT_PX,
                height: FADE_HANDLE_HIT_PX,
                left: x - FADE_HANDLE_HIT_PX / 2,
                cursor: 'ew-resize',
              }}
              title={`Fade ${side} — ${frames} frames. Drag to adjust; fades this clip's picture and its sound together.`}
              onPointerDown={onHandlePointerDown(side)}
            >
              <div
                // Same token pair and border treatment as
                // `TransformOverlay.tsx`'s corner handles (`border-accent` on
                // `bg-bg-primary`), round rather than square so the two
                // affordances stay tellable apart at a glance — this one
                // adjusts a duration, those resize a picture.
                className="mt-px rounded-full border border-accent bg-bg-primary"
                style={{ width: FADE_HANDLE_SIZE_PX, height: FADE_HANDLE_SIZE_PX }}
              />
            </div>
          );
        })}

      {/* Live numeric readout — the frame count the release will actually
          commit, so a drag isn't a guess and reads the same unit the
          Inspector's own Fade field does. */}
      {dragSide && (
        <div
          className="pointer-events-none absolute top-0 z-20 rounded bg-bg-primary px-1 text-[10px] leading-4 text-text-primary"
          style={{
            left: Math.min(
              Math.max(fadeHandleX(dragSide, widthPx, dragSide === 'in' ? rampInPx : rampOutPx) + FADE_HANDLE_HIT_PX, 0),
              Math.max(widthPx - FADE_READOUT_WIDTH_PX, 0),
            ),
          }}
          data-chroma-fade-readout=""
        >
          {dragSide === 'in' ? framesIn : framesOut}f
        </div>
      )}
    </>
  );
}
